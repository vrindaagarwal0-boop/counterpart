// Delhivery mock. Endpoint paths and field names follow Delhivery's documented API.
// Three capabilities Delhivery does not offer today live under /api/x/ and are marked BUILD.
import * as store from './store.js';
import { istIso, rid, logEvent, applyFault, sleep, normPhone } from './util.js';
import { getContacts, mask } from './contacts.js';
import { sendMessage } from './whatsapp.js';

const EDITABLE = ['Manifested', 'In Transit', 'Pending'];
const STATUS_TEXT = {
  'Manifested': 'Shipment details manifested',
  'In Transit': 'Shipment in transit to destination city',
  'Pending': 'Shipment reached destination hub',
  'Dispatched': 'Out for delivery',
  'Delivered': 'Delivered to consignee',
};

const key = (wb) => `ship:${wb}`;
export const getShipment = (wb) => store.get(key(String(wb)));
const saveShipment = (s) => store.set(key(s.waybill), s);

export async function listShipments() {
  const ids = (await store.get('ship:index')) || [];
  return (await Promise.all(ids.map(getShipment))).filter(Boolean);
}

// ---------- panel-side operations (simulate Delhivery's own network) ----------
export async function createShipment(input) {
  const contacts = await getContacts();
  const user = contacts.find((c) => c.key === 'user') || {};
  const now = new Date();
  const eta = new Date(now.getTime() + 330 * 60000); eta.setUTCHours(9, 30, 0, 0); // ~3pm IST same day
  const s = {
    waybill: String(input.waybill || '14908' + Math.floor(10000000 + Math.random() * 89999999)),
    order_ref: input.order_ref || 'MYN' + Math.floor(100000 + Math.random() * 899999),
    seller: input.seller || 'Myntra',
    item: input.item || 'Cotton kurta',
    value: Number(input.value ?? 1299),
    cod_amount: Number(input.cod_amount ?? 1299),
    payment_mode: Number(input.cod_amount ?? 1299) > 0 ? 'COD' : 'Pre-paid',
    open_box: Boolean(input.open_box),
    consignee: { name: input.consignee_name || user.name || 'Rudraksh', phone: normPhone(input.consignee_phone || user.phone || ''), address: input.address || 'Flat 1204, Tower B, Gate 2', city: input.city || 'Bengaluru', pin: input.pin || '560102' },
    status: 'Manifested',
    instructions: STATUS_TEXT['Manifested'],
    expected_delivery: input.expected_delivery || eta.toISOString().replace('Z', '+05:30').replace('.000', ''),
    rider: null,
    slot: null,
    ndr: { open: false, attempts_failed: 0, reattempts: 0, reason: '' },
    otp: null,
    scans: [],
    edits: [],
    created_at: istIso(),
  };
  s.original_consignee = { ...s.consignee };
  addScan(s, 'Manifested', STATUS_TEXT['Manifested']);
  await saveShipment(s);
  const ids = new Set((await store.get('ship:index')) || []); ids.add(s.waybill);
  await store.set('ship:index', [...ids]);
  await logEvent('panel', 'create_shipment', input, { waybill: s.waybill });
  return s;
}

function addScan(s, status, instructions, type = status === 'Delivered' ? 'DL' : 'UD') {
  s.scans.push({ ScanDetail: { Scan: status, ScanType: type, ScanDateTime: istIso(), ScannedLocation: status === 'Manifested' ? 'Gurgaon_Bilaspur_HB (Haryana)' : `${s.consignee.city}_Hub (Karnataka)`, Instructions: instructions, StatusCode: type === 'DL' ? 'EOD-38' : 'X-UCI' } });
}

export async function setStatus(waybill, status, opts = {}) {
  const s = await getShipment(waybill);
  if (!s) throw new Error('No such waybill');
  if (status === 'Dispatched') {
    const rider = (await getContacts()).find((c) => c.key === 'rider');
    s.rider = { name: opts.rider_name || 'Suresh K', phone: rider?.phone || '', assigned_at: istIso() };
  }
  if (status === 'NDR') {
    s.status = 'Pending';
    s.ndr = { ...s.ndr, open: true, attempts_failed: s.ndr.attempts_failed + 1, reason: opts.reason || 'Consignee Unavailable' };
    s.instructions = s.ndr.reason;
    s.rider = null;
    addScan(s, 'Pending', s.instructions);
  } else if (status === 'Delivered') {
    if (s.otp && opts.otp !== undefined && String(opts.otp) !== String(s.otp.code)) {
      await logEvent('panel', 'deliver_failed', { waybill, otp_entered: opts.otp }, 'OTP mismatch');
      return { ok: false, error: 'OTP does not match. Delivery not marked.' };
    }
    s.status = 'Delivered'; s.instructions = STATUS_TEXT.Delivered; s.received_by = s.consignee.name; s.delivered_at = istIso();
    addScan(s, 'Delivered', `Delivered to ${s.consignee.name}`);
  } else {
    s.status = status; s.instructions = STATUS_TEXT[status] || status;
    addScan(s, status, s.instructions);
  }
  await saveShipment(s);
  await logEvent('panel', 'set_status', { waybill, status, ...opts }, { status: s.status, instructions: s.instructions });
  return { ok: true, shipment: s };
}

// ---------- the documented API surface ----------
function trackingJson(s, noRider) {
  let status = s.status, instr = s.instructions;
  if (noRider && status === 'Dispatched') { status = 'Pending'; instr = 'Delivery agent not assigned yet'; }
  return {
    ShipmentData: [{
      Shipment: {
        AWB: s.waybill, ReferenceNo: s.order_ref, SenderName: s.seller, OrderType: s.payment_mode, CODAmount: s.cod_amount, InvoiceAmount: s.value,
        Consignee: { Name: s.consignee.name, Address1: [s.consignee.address], City: s.consignee.city, PinCode: Number(s.consignee.pin), Telephone1: mask(s.consignee.phone), State: 'Karnataka', Country: 'India' },
        Origin: 'Gurgaon', Destination: s.consignee.city,
        ExpectedDeliveryDate: s.slot?.date ? `${s.slot.date}T${(s.slot.window || '15:00').slice(0, 5)}:00+05:30` : s.expected_delivery,
        PromisedDeliveryDate: s.expected_delivery,
        DispatchCount: s.scans.filter((x) => x.ScanDetail.Scan === 'Dispatched').length,
        Status: { Status: status, StatusType: status === 'Delivered' ? 'DL' : 'UD', StatusDateTime: s.scans.at(-1)?.ScanDetail.ScanDateTime, StatusLocation: s.scans.at(-1)?.ScanDetail.ScannedLocation, Instructions: instr, RecievedBy: s.received_by || '' },
        Scans: s.scans,
        ...(s.open_box ? { Extras: 'OPEN_BOX_DELIVERY' } : {}),
      },
    }],
  };
}

async function api(action, input, fn) {
  const fault = await applyFault('delhivery');
  let res;
  if (fault === 'timeout') { await sleep(12000); res = { status: 504, body: '{"error":"Gateway Timeout"}' }; }
  else if (fault === 'malformed') res = { status: 200, body: '{"ShipmentData":[{"Shipment":{"AWB":"' + (input.waybill || '') + '","Status":{"Status":"Dispa' };
  else if (fault === 'server_error') res = { status: 500, body: '{"error":"Internal Server Error"}' };
  else if (fault === 'auth') res = { status: 401, body: '{"detail":"Invalid token."}' };
  else {
    const out = await fn(fault === 'no_rider');
    res = { status: out.__status || 200, body: JSON.stringify(out.body) };
  }
  await logEvent('delhivery', action, input, `${res.status} ${res.body}`);
  return res;
}

export const track = ({ waybill }) => api('GET /api/v1/packages/json/', { waybill }, async (noRider) => {
  const s = await getShipment(waybill);
  if (!s) return { body: { ShipmentData: [], Error: 'No such waybill or Order Id found' } };
  return { body: trackingJson(s, noRider) };
});

export const edit = (p) => api('POST /api/p/edit', p, async () => {
  const s = await getShipment(p.waybill);
  if (!s) return { __status: 404, body: { status: false, error: 'Waybill not found' } };
  if (!EDITABLE.includes(s.status)) return { __status: 400, body: { status: false, waybill: s.waybill, error: `Edit not allowed in current status: ${s.status}` } };
  const changes = {};
  if (p.name) { s.consignee.name = p.name; changes.name = p.name; }
  if (p.phone) { s.consignee.phone = normPhone(p.phone); changes.phone = mask(s.consignee.phone); }
  if (p.add) { s.consignee.address = p.add; changes.add = p.add; }
  if (p.pt) {
    if (!['COD', 'Pre-paid'].includes(p.pt)) return { __status: 400, body: { status: false, error: 'pt must be COD or Pre-paid' } };
    s.payment_mode = p.pt; changes.pt = p.pt;
    if (p.pt === 'Pre-paid') s.cod_amount = 0;
  }
  if (p.cod !== undefined && s.payment_mode === 'COD') { s.cod_amount = Number(p.cod); changes.cod = s.cod_amount; }
  s.edits.push({ at: istIso(), ...changes });
  await saveShipment(s);
  return { body: { status: true, waybill: s.waybill, remark: 'Shipment details updated successfully', updated: changes } };
});

export const ndrUpdate = (p) => api('POST /api/p/update', p, async () => {
  const items = Array.isArray(p.data) ? p.data : [{ waybill: p.waybill, act: p.act, action_data: p.action_data }];
  const upl = 'UPL' + rid().toUpperCase();
  const results = [];
  for (const it of items) {
    const s = await getShipment(it.waybill);
    if (!s) { results.push({ waybill: it.waybill, act: it.act, status: 'Failure', remark: 'Waybill not found' }); continue; }
    if (!['RE-ATTEMPT', 'PICKUP_RESCHEDULE'].includes(it.act)) { results.push({ waybill: s.waybill, act: it.act, status: 'Failure', remark: 'Unsupported act. Use RE-ATTEMPT or PICKUP_RESCHEDULE' }); continue; }
    if (it.act === 'RE-ATTEMPT' && !s.ndr.open) { results.push({ waybill: s.waybill, act: it.act, status: 'Failure', remark: 'RE-ATTEMPT allowed only after a failed delivery attempt (NDR)' }); continue; }
    if (it.act === 'RE-ATTEMPT' && s.ndr.reattempts >= 2) { results.push({ waybill: s.waybill, act: it.act, status: 'Failure', remark: 'Maximum re-attempts reached' }); continue; }
    s.ndr = { ...s.ndr, open: false, reattempts: s.ndr.reattempts + 1 };
    s.instructions = 'Re-attempt requested by consignee';
    addScan(s, 'Pending', s.instructions);
    await saveShipment(s);
    results.push({ waybill: s.waybill, act: it.act, status: 'Success', remark: 'Re-attempt scheduled for next working day' });
  }
  await store.set(`upl:${upl}`, { request_id: upl, status: 'COMPLETED', results }, 7 * 24 * 3600);
  return { body: { request_id: upl } };
});

export const uplStatus = ({ upl }) => api(`GET /api/cmu/get_bulk_upl/${upl}`, { upl }, async () => {
  const r = await store.get(`upl:${upl}`);
  if (!r) return { __status: 404, body: { error: 'UPL id not found' } };
  return { body: r };
});

// ---------- BUILD capabilities (not offered by Delhivery today) ----------
export const delegateOtp = (p) => api('POST /api/x/delegate-otp', p, async () => {
  const s = await getShipment(p.waybill);
  if (!s) return { __status: 404, body: { status: false, error: 'Waybill not found' } };
  if (s.status !== 'Dispatched') return { __status: 400, body: { status: false, error: `OTP can be issued only when out for delivery. Current status: ${s.status}` } };
  if (p.phone && normPhone(p.phone) !== s.consignee.phone) return { __status: 403, body: { status: false, error: 'Phone does not match the consignee on this waybill. Update the consignee with /api/p/edit first.' } };
  const code = String(Math.floor(1000 + Math.random() * 9000));
  s.otp = { code, phone: s.consignee.phone, issued_at: istIso(), expires_in_sec: 900 };
  await saveShipment(s);
  const sent = await sendMessage({ to: s.consignee.phone, text: `Delhivery: your delivery OTP for AWB ${s.waybill} is ${code}. Share it only with the delivery agent at your door.` }, { via: 'delhivery_otp' });
  if (sent.__isError) return { __status: 502, body: { status: false, error: 'OTP could not be delivered', detail: sent.error } };
  return { body: { status: true, waybill: s.waybill, sent_to: mask(s.consignee.phone), consignee: s.consignee.name, expires_in_sec: 900, note: 'Single-use OTP sent only to the receiver. It is never returned to the caller.' } };
});

export const riderBridge = ({ waybill }) => api('GET /api/x/rider-bridge', { waybill }, async (noRider) => {
  const s = await getShipment(waybill);
  if (!s) return { __status: 404, body: { error: 'Waybill not found' } };
  if (!s.rider || noRider) return { body: { waybill: s.waybill, rider: null, messages: [], note: 'No delivery agent assigned yet' } };
  const inbox = (await store.get('wa:inbox')) || [];
  const riderPhone = s.rider.phone;
  const mine = inbox.filter((m) => m.phone === riderPhone && !m.read_by_bridge);
  const others = inbox.filter((m) => m.from === 'unknown' && !m.read_by_bridge);
  const ids = new Set([...mine, ...others].map((m) => m.id));
  await store.set('wa:inbox', inbox.map((m) => (ids.has(m.id) ? { ...m, read_by_bridge: true, read: true } : m)));
  return { body: {
    waybill: s.waybill,
    rider: { name: s.rider.name, phone: mask(riderPhone), verified_for_waybill: true },
    messages: mine.map(({ id, at, type, text, audio_url }) => ({ id, at, type, text, audio_url })),
    unverified_contacts: others.map(({ at, phone_masked, type, text, audio_url }) => ({ at, from: phone_masked, type, text, audio_url, warning: 'Sender is not linked to this waybill' })),
  } };
});

export const bookSlot = (p) => api('POST /api/x/slot', p, async () => {
  const s = await getShipment(p.waybill);
  if (!s) return { __status: 404, body: { status: false, error: 'Waybill not found' } };
  if (['Dispatched', 'Delivered'].includes(s.status)) return { __status: 400, body: { status: false, error: `Slot cannot be changed in status ${s.status}` } };
  s.slot = { date: p.date, window: p.window || '15:00-18:00', kind: p.kind || 'delivery', booked_at: istIso() };
  s.instructions = `Delivery slot booked: ${s.slot.date} ${s.slot.window}`;
  addScan(s, s.status, s.instructions);
  await saveShipment(s);
  return { body: { status: true, waybill: s.waybill, slot: s.slot } };
});

// ---------- REST routing ----------
export async function rest(path, method, query, body) {
  if (method === 'GET' && path === '/api/v1/packages/json/') return track({ waybill: query.get('waybill') });
  if (method === 'POST' && path === '/api/p/edit') return edit(body);
  if (method === 'POST' && path === '/api/p/update') return ndrUpdate(body);
  let m = path.match(/^\/api\/cmu\/get_bulk_upl\/([A-Za-z0-9]+)\/?$/);
  if (method === 'GET' && m) return uplStatus({ upl: m[1] });
  if (method === 'POST' && path === '/api/x/delegate-otp') return delegateOtp(body);
  if (method === 'GET' && path === '/api/x/rider-bridge') return riderBridge({ waybill: query.get('waybill') });
  if (method === 'POST' && path === '/api/x/slot') return bookSlot(body);
  return null;
}

// ---------- MCP tools (each wraps one endpoint and returns its raw HTTP body) ----------
const asTool = (res) => ({ __raw: res.body, __isError: res.status >= 400 });
const wb = { waybill: { type: 'string', description: 'Delhivery waybill (AWB) number' } };
export const tools = [
  { name: 'track_shipment', description: 'Delhivery tracking. GET /api/v1/packages/json/?waybill=. Returns Status, StatusType, Instructions, ExpectedDeliveryDate, OrderType, CODAmount and scans.', inputSchema: { type: 'object', properties: wb, required: ['waybill'] }, handler: async (a) => asTool(await track(a)) },
  { name: 'edit_shipment', description: 'Delhivery edit API. POST /api/p/edit. Change consignee name/phone (to re-route to a trusted person), address (add), payment type pt ("COD" or "Pre-paid") or cod amount. Allowed only before the parcel is Dispatched.', inputSchema: { type: 'object', properties: { ...wb, name: { type: 'string' }, phone: { type: 'string' }, add: { type: 'string' }, pt: { type: 'string', enum: ['COD', 'Pre-paid'] }, cod: { type: 'number' } }, required: ['waybill'] }, handler: async (a) => asTool(await edit(a)) },
  { name: 'ndr_action', description: 'Delhivery NDR API. POST /api/p/update with act "RE-ATTEMPT" after a failed delivery attempt (max 2). Returns a request_id (UPL) to check with get_ndr_status.', inputSchema: { type: 'object', properties: { ...wb, act: { type: 'string', enum: ['RE-ATTEMPT', 'PICKUP_RESCHEDULE'] } }, required: ['waybill', 'act'] }, handler: async (a) => asTool(await ndrUpdate({ data: [{ waybill: a.waybill, act: a.act }] })) },
  { name: 'get_ndr_status', description: 'Delhivery NDR status. GET /api/cmu/get_bulk_upl/{UPL}. Confirms whether a RE-ATTEMPT request succeeded.', inputSchema: { type: 'object', properties: { upl: { type: 'string', description: 'request_id returned by ndr_action' } }, required: ['upl'] }, handler: async (a) => asTool(await uplStatus(a)) },
  { name: 'issue_delegate_otp', description: 'BUILD capability (not offered by Delhivery today). POST /api/x/delegate-otp. When the rider is at the door, sends a single-use delivery OTP straight to the receiver on the waybill. The OTP is never returned to you.', inputSchema: { type: 'object', properties: { ...wb, phone: { type: 'string', description: 'Optional. Must match the consignee phone.' } }, required: ['waybill'] }, handler: async (a) => asTool(await delegateOtp(a)) },
  { name: 'rider_bridge', description: 'BUILD capability (not offered by Delhivery today). GET /api/x/rider-bridge. Returns new messages and voice notes from the rider assigned to this waybill, verified against Delhivery\'s rider record. Messages from unknown senders are flagged as unverified.', inputSchema: { type: 'object', properties: wb, required: ['waybill'] }, handler: async (a) => asTool(await riderBridge(a)) },
  { name: 'book_slot', description: 'BUILD capability (not offered by Delhivery today). POST /api/x/slot. Books a delivery slot before the attempt, e.g. date "2026-10-05", window "15:00-18:00". Not allowed once Dispatched.', inputSchema: { type: 'object', properties: { ...wb, date: { type: 'string' }, window: { type: 'string' }, kind: { type: 'string', enum: ['delivery', 'pickup'] } }, required: ['waybill', 'date'] }, handler: async (a) => asTool(await bookSlot(a)) },
];
