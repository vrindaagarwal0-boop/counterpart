// Google bridge: real Gmail (read, plus send-to-self for run memory) and Calendar (free/busy) using the team's OAuth refresh token.
import * as store from './store.js';
import { logEvent, applyFault, sleep } from './util.js';

async function accessToken() {
  const cached = await store.get('google:token');
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: process.env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token' }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Google token error: ${j.error_description || j.error}`);
  await store.set('google:token', { token: j.access_token, exp: Date.now() + j.expires_in * 1000 }, j.expires_in);
  return j.access_token;
}

async function g(path, opts = {}) {
  const r = await fetch(`https://www.googleapis.com${path}`, { ...opts, headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json();
  if (!r.ok) throw new Error(`Google API ${r.status}: ${j.error?.message || 'error'}`);
  return j;
}

const header = (msg, name) => (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
function bodyText(payload) {
  const parts = [payload];
  let html = '';
  while (parts.length) {
    const p = parts.shift();
    if (p.parts) parts.push(...p.parts);
    const data = p.body?.data ? Buffer.from(p.body.data, 'base64url').toString('utf8') : '';
    if (p.mimeType === 'text/plain' && data) return data;
    if (p.mimeType === 'text/html' && data) html = data;
  }
  return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

async function guard(action, input, fn) {
  const f = await applyFault('google');
  let out;
  if (f === 'timeout') { await sleep(12000); out = { __isError: true, error: 'Google request timed out' }; }
  else if (f === 'server_error') out = { __isError: true, error: 'Google returned 503 Backend Error' };
  else { try { out = await fn(); } catch (e) { out = { __isError: true, error: e.message }; } }
  await logEvent('google', action, input, out);
  return out;
}

export const searchEmails = ({ query = 'newer_than:2d', max_results = 5 }) => guard('search_emails', { query }, async () => {
  // The LLM sometimes sends max_results as null, 0 or a string. Clamp to 1..10, default 5.
  let n = parseInt(max_results, 10); if (!(n >= 1)) n = 5; n = Math.min(n, 10);
  const list = await g(`/gmail/v1/users/me/messages?q=${encodeURIComponent(query || 'newer_than:2d')}&maxResults=${n}`);
  const msgs = await Promise.all((list.messages || []).map((m) => g(`/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`)));
  return { emails: msgs.map((m) => ({ message_id: m.id, from: header(m, 'From'), subject: header(m, 'Subject'), date: header(m, 'Date'), snippet: m.snippet })) };
});

export const getEmail = ({ message_id }) => guard('get_email', { message_id }, async () => {
  const m = await g(`/gmail/v1/users/me/messages/${message_id}?format=full`);
  return { message_id, from: header(m, 'From'), subject: header(m, 'Subject'), date: header(m, 'Date'), body: bodyText(m.payload).slice(0, 4000) };
});

function dayWindow(time_min, time_max) {
  if (time_min && time_max) return { time_min, time_max };
  const ist = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  return { time_min: `${ist}T00:00:00+05:30`, time_max: `${ist}T23:59:59+05:30` };
}

export const checkAvailability = ({ time_min, time_max }) => guard('check_availability', { time_min, time_max }, async () => {
  const w = dayWindow(time_min, time_max);
  const j = await g('/calendar/v3/freeBusy', { method: 'POST', body: JSON.stringify({ timeMin: w.time_min, timeMax: w.time_max, timeZone: 'Asia/Kolkata', items: [{ id: 'primary' }] }) });
  const busy = j.calendars?.primary?.busy || [];
  return { window: w, busy, is_free: busy.length === 0 };
});

export const listEvents = ({ time_min, time_max }) => guard('list_events', { time_min, time_max }, async () => {
  const w = dayWindow(time_min, time_max);
  const j = await g(`/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(w.time_min)}&timeMax=${encodeURIComponent(w.time_max)}`);
  return { window: w, events: (j.items || []).map((e) => ({ title: e.summary, start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, location: e.location || '' })) };
});

// Agent memory across separate runs: sends a note ONLY to the account's own address. It can never email anyone else.
async function ownAddress() {
  const cached = await store.get('google:me');
  if (cached) return cached;
  const p = await g('/gmail/v1/users/me/profile');
  await store.set('google:me', p.emailAddress, 86400);
  return p.emailAddress;
}
const clean = (s) => String(s || '').replace(/[\r\n]+/g, ' ').slice(0, 200);
export const sendEmail = ({ subject, body }) => guard('send_email', { subject }, async () => {
  const me = await ownAddress();
  const subj = clean(subject);
  const mime = [`From: ${me}`, `To: ${me}`, `Subject: =?UTF-8?B?${Buffer.from(subj).toString('base64')}?=`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', String(body || '').slice(0, 8000)].join('\r\n');
  const r = await g('/gmail/v1/users/me/messages/send', { method: 'POST', body: JSON.stringify({ raw: Buffer.from(mime).toString('base64url') }) });
  return { sent: true, message_id: r.id, to: 'self', subject: subj };
});

const timeProps = { time_min: { type: 'string', description: 'ISO time, e.g. 2026-10-04T13:00:00+05:30. Defaults to today.' }, time_max: { type: 'string' } };
export const tools = [
  { name: 'search_emails', description: 'Search the user\'s Gmail. Use Gmail syntax, e.g. "Delhivery newer_than:2d" or "order shipped". Returns message ids, subjects and snippets.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'number', description: 'Optional, 1 to 10. Default 5.' } }, required: ['query'] }, handler: searchEmails },
  { name: 'get_email', description: 'Read one email in full to find the waybill, item, value, COD amount and open-box flag.', inputSchema: { type: 'object', properties: { message_id: { type: 'string' } }, required: ['message_id'] }, handler: getEmail },
  { name: 'check_availability', description: 'Check if the user is busy in a time window (Google Calendar free/busy). Returns busy blocks.', inputSchema: { type: 'object', properties: timeProps }, handler: checkAvailability },
  { name: 'send_email', description: 'Write a memory note to the agent\'s own mailbox (it can only send to itself, never to anyone else). Use subject "[cOunTerPart LOG] AWB <waybill> <state>" and put the waybill, receiver, open questions and handover counts in the body. Read notes back with search_emails "subject:cOunTerPart LOG".', inputSchema: { type: 'object', properties: { subject: { type: 'string' }, body: { type: 'string' } }, required: ['subject', 'body'] }, handler: sendEmail },
  { name: 'list_events', description: 'List the user\'s calendar events in a window, with titles and times.', inputSchema: { type: 'object', properties: timeProps }, handler: listEvents },
];
