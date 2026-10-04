// Pine Labs mock. Paths and field names follow Pine Labs' Payment Links API (v1).
// Used because the platform's native Pine Labs connector had no UAT credentials.
// The payment_link URL opens a test checkout page on this server, so the user can "pay" from WhatsApp.
import * as store from './store.js';
import { istIso, logEvent, applyFault, sleep } from './util.js';

const key = (id) => `pl:${id}`;
const getLink = (id) => store.get(key(String(id)));
const saveLink = (l) => store.set(key(l.payment_link_id), l);
const newId = () => 'pl-v1-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const newOrderId = () => 'v1-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + Math.random().toString(36).slice(2, 12);
const inr = (paise) => (Number(paise) / 100).toLocaleString('en-IN');

export async function listLinks() {
  const ids = (await store.get('pl:index')) || [];
  return (await Promise.all(ids.map(getLink))).filter(Boolean);
}

// Expiry is checked on read, like a real gateway would report it.
function view(l) {
  if (l.status === 'CREATED' && l.expire_by && Date.parse(l.expire_by) < Date.now()) l.status = 'EXPIRED';
  const { history, ...pub } = l;
  return pub;
}

async function api(action, input, fn) {
  const fault = await applyFault('pinelabs');
  let res;
  if (fault === 'timeout') { await sleep(12000); res = { status: 504, body: '{"code":"GATEWAY_TIMEOUT","message":"Upstream timed out"}' }; }
  else if (fault === 'malformed') res = { status: 200, body: '{"payment_link_id":"' + (input.payment_link_id || 'pl-v1-') + '","status":"PROC' };
  else if (fault === 'server_error') res = { status: 500, body: '{"code":"INTERNAL_SERVER_ERROR","message":"Something went wrong"}' };
  else if (fault === 'auth') res = { status: 401, body: '{"code":"UNAUTHORIZED","message":"Invalid or expired access token"}' };
  else {
    const out = await fn(fault === 'expired');
    res = { status: out.__status || 200, body: JSON.stringify(out.body) };
  }
  await logEvent('pinelabs', action, input, `${res.status} ${res.body}`);
  return res;
}

const bad = (message, code = 'INVALID_REQUEST') => ({ __status: 400, body: { code, message } });
const notFound = { __status: 404, body: { code: 'NOT_FOUND', message: 'Payment link not found' } };

// POST /api/pay/v1/paymentlink
export const create = (p, ctx) => api('POST /api/pay/v1/paymentlink', p, async (expired) => {
  const value = Number(p?.amount?.value);
  if (!Number.isInteger(value) || value < 100) return bad('amount.value must be an integer in paise, at least 100');
  if ((p.amount.currency || 'INR') !== 'INR') return bad('Only INR is supported');
  const now = new Date();
  const l = {
    payment_link_id: newId(),
    payment_link: '',
    status: 'CREATED',
    amount: { value, currency: 'INR' },
    description: String(p.description || '').slice(0, 200),
    merchant_payment_link_reference: String(p.merchant_payment_link_reference || ''),
    order_id: newOrderId(),
    customer: p.customer || null,
    expire_by: expired ? new Date(now.getTime() - 60000).toISOString() : (p.expire_by || new Date(now.getTime() + 24 * 3600 * 1000).toISOString()),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    payment: null,
    history: [],
  };
  l.payment_link = `${ctx.baseUrl}/pay/${l.payment_link_id}`;
  await saveLink(l);
  const ids = new Set((await store.get('pl:index')) || []); ids.add(l.payment_link_id);
  await store.set('pl:index', [...ids]);
  return { body: view(l) };
});

// GET /api/pay/v1/paymentlink/{id}
export const get = ({ payment_link_id }) => api(`GET /api/pay/v1/paymentlink/${payment_link_id}`, { payment_link_id }, async (expired) => {
  const l = await getLink(payment_link_id);
  if (!l) return notFound;
  if (expired && l.status === 'CREATED') { l.status = 'EXPIRED'; l.updated_at = new Date().toISOString(); await saveLink(l); }
  return { body: view(l) };
});

// PUT /api/pay/v1/paymentlink/{id}/cancel
export const cancel = ({ payment_link_id }) => api(`PUT /api/pay/v1/paymentlink/${payment_link_id}/cancel`, { payment_link_id }, async () => {
  const l = await getLink(payment_link_id);
  if (!l) return notFound;
  view(l);
  if (l.status !== 'CREATED') return bad(`Cannot cancel a link in status ${l.status}`, 'INVALID_STATE');
  l.status = 'CANCELLED'; l.updated_at = new Date().toISOString();
  await saveLink(l);
  return { body: view(l) };
});

// The payer completes payment (checkout page or panel). Not an agent action.
export async function markPaid(id, via = 'checkout') {
  const l = await getLink(id);
  if (!l) return { ok: false, error: 'Payment link not found' };
  view(l);
  if (l.status !== 'CREATED') return { ok: false, error: `Link is ${l.status}`, status: l.status };
  l.status = 'PROCESSED';
  l.updated_at = new Date().toISOString();
  l.payment = { payment_id: 'pay-' + Math.random().toString(36).slice(2, 12), method: 'UPI', paid_at: istIso() };
  await saveLink(l);
  await logEvent('pinelabs', 'payer_paid', { payment_link_id: id, via }, { status: 'PROCESSED', amount_inr: l.amount.value / 100 });
  return { ok: true, status: 'PROCESSED', payment_link_id: id };
}

// ---------- REST routing (returns null if the path is not Pine Labs) ----------
export async function rest(path, method, body, ctx) {
  if (method === 'POST' && /^\/api\/pay\/v1\/paymentlink\/?$/.test(path)) return create(body, ctx);
  let m = path.match(/^\/api\/pay\/v1\/paymentlink\/([A-Za-z0-9-]+)\/cancel\/?$/);
  if (m && (method === 'PUT' || method === 'POST')) return cancel({ payment_link_id: m[1] });
  m = path.match(/^\/api\/pay\/v1\/paymentlink\/([A-Za-z0-9-]+)\/?$/);
  if (m && method === 'GET') return get({ payment_link_id: m[1] });
  return null;
}

// ---------- Public checkout page: GET/POST /pay/{id} ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function page(title, inner) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:Calibri,Arial,sans-serif;background:#f6f7f9;color:#1b2440;margin:0;padding:24px 16px}
.card{max-width:380px;margin:0 auto;background:#fff;border:1px solid #dde2ea;border-radius:10px;padding:22px}
h1{font-size:18px;margin:0 0 4px;color:#13294b}.amt{font-size:32px;font-weight:bold;margin:14px 0}
.muted{font-size:12px;color:#667}button{width:100%;font:inherit;font-size:16px;padding:12px;border:0;border-radius:6px;background:#13294b;color:#fff;cursor:pointer}
.ok{color:#0f6e56;font-weight:bold;font-size:18px}.no{color:#a32d2d;font-weight:bold}.tag{display:inline-block;font-size:11px;background:#fff4d6;color:#7a5a00;border-radius:8px;padding:2px 8px}</style></head>
<body><div class="card">${inner}<p class="muted" style="margin-top:18px">Test checkout on the cOunTerPart mock of the Pine Labs Payment Links API. No real money moves.</p></div></body></html>`;
}

export async function checkout(path, method) {
  const id = (path.match(/^\/pay\/([A-Za-z0-9-]+)\/?$/) || [])[1];
  const l = id && (await getLink(id));
  if (!l) return page('Link not found', '<h1>Payment link not found</h1>');
  view(l);
  if (method === 'POST' && l.status === 'CREATED') { await markPaid(id, 'checkout'); l.status = 'PROCESSED'; }
  const head = `<span class="tag">TEST MODE</span><h1>cOunTerPart payment</h1><div class="muted">${esc(l.description)}<br>Ref ${esc(l.merchant_payment_link_reference)}</div><div class="amt">Rs ${inr(l.amount.value)}</div>`;
  if (l.status === 'PROCESSED') return page('Paid', head + '<p class="ok">Payment successful</p><p class="muted">Status PROCESSED. You can close this page.</p>');
  if (l.status !== 'CREATED') return page('Link closed', head + `<p class="no">This link is ${esc(l.status)}.</p>`);
  return page('Pay', head + `<form method="post"><button type="submit">Pay Rs ${inr(l.amount.value)} (UPI)</button></form>`);
}

// ---------- MCP tools ----------
const asTool = (res) => ({ __raw: res.body, __isError: res.status >= 400 });
export const tools = [
  {
    name: 'create_payment_link',
    description: 'Pine Labs Payment Links API. POST /api/pay/v1/paymentlink. Creates a payment link for the exact COD amount, so the user can pre-pay. Send the returned payment_link to the user only, never to a delegate. Returns payment_link_id and status CREATED.',
    inputSchema: { type: 'object', properties: { amount_inr: { type: 'number', description: 'Amount in rupees, e.g. 1299' }, description: { type: 'string', description: 'e.g. "Myntra Cotton kurta COD"' }, reference: { type: 'string', description: 'Merchant reference. Use the Delhivery waybill.' } }, required: ['amount_inr', 'reference'] },
    handler: async (a, ctx) => asTool(await create({ amount: { value: Math.round(Number(a.amount_inr) * 100), currency: 'INR' }, description: a.description || '', merchant_payment_link_reference: a.reference }, ctx)),
  },
  {
    name: 'get_payment_link',
    description: 'Pine Labs Payment Links API. GET /api/pay/v1/paymentlink/{payment_link_id}. status PROCESSED means paid. CREATED means not paid yet. EXPIRED or CANCELLED means the link can no longer be paid.',
    inputSchema: { type: 'object', properties: { payment_link_id: { type: 'string' } }, required: ['payment_link_id'] },
    handler: async (a) => asTool(await get(a)),
  },
];
