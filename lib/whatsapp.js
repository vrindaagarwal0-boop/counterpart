// WhatsApp bridge over Twilio. Dry-run by default so testing never spends Twilio messages.
import * as store from './store.js';
import { istIso, rid, logEvent, applyFault, sleep, normPhone } from './util.js';
import { resolve, nameForPhone, mask } from './contacts.js';
import { saveMedia } from './media.js';

const SID = () => process.env.TWILIO_ACCOUNT_SID;
const TOKEN = () => process.env.TWILIO_AUTH_TOKEN;
const FROM = () => normPhone((process.env.TWILIO_WHATSAPP_FROM || '+14155238886').replace('whatsapp:', ''));

export async function getSettings() {
  return (await store.get('wa:settings')) || { mode: 'dry', budget: Number(process.env.TWILIO_BUDGET || 90), live_sent: 0, live_received: 0 };
}
export async function setSettings(patch) {
  const s = { ...(await getSettings()), ...patch };
  await store.set('wa:settings', s);
  return s;
}

async function twilioSend({ to, body, mediaUrl }) {
  const form = new URLSearchParams({ From: `whatsapp:+${FROM()}`, To: `whatsapp:+${to}` });
  if (body) form.set('Body', body);
  if (mediaUrl) form.set('MediaUrl', mediaUrl);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID()}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${SID()}:${TOKEN()}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Twilio error ${j.code || r.status}: ${j.message || 'send failed'}`);
  return j;
}

// Core send used by the MCP tools and by the Delhivery OTP capability.
export async function sendMessage({ to, text, audio_url }, { via = 'agent' } = {}) {
  const contact = await resolve(to);
  if (!contact || !contact.phone) {
    const out = { __isError: true, error: `No phone number known for "${to}". Set it in the control panel contacts.` };
    await logEvent('whatsapp', audio_url ? 'send_voice' : 'send_text', { to, text, audio_url, via }, out);
    return out;
  }
  const fault = await applyFault('whatsapp');
  if (fault === 'timeout') { await sleep(12000); return { __isError: true, error: 'WhatsApp send timed out' }; }
  if (fault === 'server_error') return { __isError: true, error: 'Twilio returned 503 Service Unavailable' };

  const s = await getSettings();
  const entry = { id: rid('o'), at: istIso(), to: contact.key || contact.phone, phone_masked: mask(contact.phone), type: audio_url ? 'voice' : 'text', text: text || '', audio_url: audio_url || '', via, mode: s.mode };
  let result;
  if (s.mode === 'live') {
    if (s.live_sent >= s.budget) return { __isError: true, error: `Live WhatsApp budget reached (${s.live_sent}/${s.budget}). Switch to dry-run or raise the budget in the panel.` };
    const tw = await twilioSend({ to: contact.phone, body: audio_url ? undefined : text, mediaUrl: audio_url });
    await setSettings({ live_sent: s.live_sent + 1 });
    result = { status: tw.status, message_sid: tw.sid, to: entry.to, mode: 'live' };
  } else {
    result = { status: 'queued', message_sid: 'DRY' + entry.id, to: entry.to, mode: 'dry_run' };
  }
  await store.push('wa:outbox', { ...entry, sid: result.message_sid }, 300);
  await logEvent('whatsapp', audio_url ? 'send_voice' : 'send_text', { to: entry.to, text, audio_url, via }, result);
  return result;
}

// Inbound: from the Twilio webhook (real phones) or the panel's virtual phone (dry-run testing).
export async function addInbound({ fromPhone, text, audioBuffer, audioMime, baseUrl, source }) {
  const phone = normPhone(fromPhone);
  let audio_url = '';
  if (audioBuffer) audio_url = (await saveMedia(audioBuffer, audioMime, baseUrl)).url;
  const msg = { id: rid('i'), at: istIso(), from: (await nameForPhone(phone)) || 'unknown', phone_masked: mask(phone), phone, type: audio_url ? 'voice' : 'text', text: text || '', audio_url, source, read: false, read_by_bridge: false };
  await store.push('wa:inbox', msg, 300);
  await logEvent('whatsapp', 'inbound', { from: msg.from, source, type: msg.type }, { text: msg.text, audio_url });
  return msg;
}

export async function twilioWebhook(params, baseUrl) {
  const from = (params.From || '').replace('whatsapp:', '');
  let audioBuffer, audioMime;
  if (Number(params.NumMedia || 0) > 0 && params.MediaUrl0) {
    const r = await fetch(params.MediaUrl0, { headers: { Authorization: 'Basic ' + Buffer.from(`${SID()}:${TOKEN()}`).toString('base64') } });
    if (r.ok) { audioBuffer = Buffer.from(await r.arrayBuffer()); audioMime = params.MediaContentType0 || r.headers.get('content-type'); }
  }
  const s = await getSettings();
  await setSettings({ live_received: (s.live_received || 0) + 1 });
  await addInbound({ fromPhone: from, text: params.Body || '', audioBuffer, audioMime, baseUrl, source: 'twilio' });
  return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}

export async function readMessages({ from, unread_only = true, mark_read = true, limit = 20 }) {
  const inbox = (await store.get('wa:inbox')) || [];
  let who = null;
  if (from) { const c = await resolve(from); who = c?.key || null; }
  let msgs = inbox.filter((m) => (!unread_only || !m.read) && (!who || m.from === who));
  msgs = msgs.slice(-limit);
  if (mark_read && msgs.length) {
    const ids = new Set(msgs.map((m) => m.id));
    await store.set('wa:inbox', inbox.map((m) => (ids.has(m.id) ? { ...m, read: true } : m)));
  }
  const clean = msgs.map(({ phone, read_by_bridge, ...m }) => m);
  await logEvent('whatsapp', 'read_messages', { from, unread_only }, { count: clean.length });
  return { messages: clean, count: clean.length };
}

export const tools = [
  {
    name: 'send_text',
    description: 'Send a WhatsApp text message. "to" can be a contact key (user, maa, rahul, ramesh, rider) or a phone number. Keep it under 30 words.',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } }, required: ['to', 'text'] },
    handler: (a) => sendMessage({ to: a.to, text: a.text }),
  },
  {
    name: 'send_voice',
    description: 'Send a WhatsApp voice note. First create the audio with gnani text_to_speech, then pass its audio_url here.',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, audio_url: { type: 'string' } }, required: ['to', 'audio_url'] },
    handler: (a) => sendMessage({ to: a.to, audio_url: a.audio_url }),
  },
  {
    name: 'read_messages',
    description: 'Read new WhatsApp messages from the user and trusted people. Voice notes come with an audio_url: transcribe them with gnani speech_to_text. Optional "from" filters by contact. Rider messages are read through the Delhivery rider_bridge instead.',
    inputSchema: { type: 'object', properties: { from: { type: 'string' }, unread_only: { type: 'boolean' } } },
    handler: (a) => readMessages({ from: a.from, unread_only: a.unread_only !== false }),
  },
];
