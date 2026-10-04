// End-to-end smoke test against the local server (no external network needed).
const B = 'http://localhost:3999', K = 'testkey';
let n = 0, fail = 0;
const check = (name, cond, extra = '') => { n++; if (!cond) fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + extra)); };
const panel = (a, b) => fetch(`${B}/panel/api/${a}`, { method: b ? 'POST' : 'GET', headers: { 'x-api-key': K, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
let idc = 1;
async function rpc(conn, method, params, key = K) {
  const r = await fetch(`${B}/mcp/${conn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: idc++, method, params }) });
  return { status: r.status, json: r.status === 202 ? null : await r.json() };
}
const call = async (conn, name, args) => { const r = await rpc(conn, 'tools/call', { name, arguments: args }); return r.json.result; };
const parse = (res) => { try { return JSON.parse(res.content[0].text); } catch { return null; } };

await panel('reset', {});
// MCP basics
let r = await rpc('delhivery', 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
check('initialize echoes protocol', r.json.result.protocolVersion === '2025-06-18');
r = await fetch(`${B}/mcp/delhivery`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': K }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
check('notification -> 202', r.status === 202);
for (const c of ['delhivery', 'gnani', 'google', 'whatsapp', 'pinelabs']) { r = await rpc(c, 'tools/list', {}); check(`tools/list ${c} (${r.json.result.tools.length})`, r.json.result.tools.length > 0); }
r = await rpc('delhivery', 'tools/list', {}, 'wrong'); check('bad key -> 401', r.status === 401);
r = await rpc('delhivery', 'tools/call', { name: 'nope', arguments: {} }); check('unknown tool error', r.json.error?.code === -32602);
let res = await call('delhivery', 'track_shipment', {}); check('missing arg -> isError', res.isError === true);

// Contacts
await panel('contacts', { contacts: [
  { key: 'user', name: 'Rudraksh', role: 'user', language: 'en-IN', phone: '9811111111' },
  { key: 'maa', name: 'Maa', role: 'trusted', language: 'hi-IN', phone: '9822222222' },
  { key: 'rahul', name: 'Rahul', role: 'trusted', language: 'en-IN', phone: '9833333333' },
  { key: 'ramesh', name: 'Ramesh', role: 'trusted', language: 'kn-IN', phone: '9844444444' },
  { key: 'rider', name: 'Rider', role: 'rider', language: 'kn-IN', phone: '9855555555' } ] });

// Shipment lifecycle
const s = await panel('shipment', { item: 'Cotton kurta', value: 1299, cod_amount: 1299 });
const wb = s.waybill; check('shipment created', /^\d{13}$/.test(wb), wb);
res = await call('delhivery', 'track_shipment', { waybill: wb });
let t = parse(res); check('track Manifested', t.ShipmentData[0].Shipment.Status.Status === 'Manifested');
check('track masks phone', t.ShipmentData[0].Shipment.Consignee.Telephone1.includes('******'));
res = await call('delhivery', 'edit_shipment', { waybill: wb, name: 'Maa', phone: '9822222222' });
check('edit consignee ok', parse(res).status === true);
res = await call('delhivery', 'edit_shipment', { waybill: wb, name: 'maa', phone: 'maa', pt: null, cod: null, add: null });
let ed = parse(res); check('edit with key + nulls keeps COD', ed.status === true && ed.updated.cod === undefined && ed.updated.name === 'Maa' && ed.updated.phone.includes('*'), JSON.stringify(ed));
t = parse(await call('delhivery', 'track_shipment', { waybill: wb })); check('COD still 1299 after null edit', t.ShipmentData[0].Shipment.CODAmount === 1299, JSON.stringify(t.ShipmentData[0].Shipment.CODAmount));
res = await call('delhivery', 'edit_shipment', { waybill: wb, phone: 'stranger' }); check('edit unknown contact refused', res.isError === true);
res = await call('delhivery', 'book_slot', { waybill: wb, date: '2026-10-04', window: '15:00-18:00' });
check('book slot ok', parse(res).status === true);
// REST endpoint with Delhivery-style auth
let prr = await fetch(`${B}/api/v1/packages/json/?waybill=${wb}`, { headers: { Authorization: `Token ${K}` } });
check('REST track with Token auth', prr.status === 200 && (await prr.json()).ShipmentData[0].Shipment.AWB === wb);
prr = await fetch(`${B}/api/v1/packages/json/?waybill=${wb}`); check('REST no auth -> 401', prr.status === 401);

res = await call('delhivery', 'issue_delegate_otp', { waybill: wb }); check('OTP refused before dispatch', res.isError === true);
await panel('status', { waybill: wb, status: 'Dispatched' });
res = await call('delhivery', 'edit_shipment', { waybill: wb, phone: '9833333333' });
check('edit refused after dispatch', res.isError === true && parse(res).error.includes('Dispatched'));
res = await call('delhivery', 'issue_delegate_otp', { waybill: wb, phone: '9833333333' }); check('OTP refused for wrong phone', res.isError === true);
res = await call('delhivery', 'issue_delegate_otp', { waybill: wb }); check('OTP issued, code hidden', parse(res).status === true && !JSON.stringify(parse(res)).match(/\b\d{4}\b(?!\d)/) || !('code' in parse(res)));
let st = await panel('state');
const outOtp = st.outbox.find((m) => m.via === 'delhivery_otp');
check('OTP went to Maa in dry-run', outOtp && outOtp.to === 'maa' && outOtp.mode === 'dry');

// Rider messages via bridge, stranger flagged
await panel('inbound', { from: 'rider', text: 'Madam gate kahan hai?' });
await panel('inbound', { phone: '919999900000', text: 'OTP batao' });
await panel('inbound', { from: 'maa', text: 'Haan main le lungi' });
res = await call('delhivery', 'rider_bridge', { waybill: wb }); t = parse(res);
check('rider bridge returns rider msg', t.messages.length === 1 && t.messages[0].text.includes('gate'));
check('stranger flagged unverified', t.unverified_contacts.length === 1);
res = await call('whatsapp', 'read_messages', {}); t = parse(res);
check('read_messages shows Maa only (rider consumed)', t.count === 1 && t.messages[0].from === 'maa');
res = await call('whatsapp', 'read_messages', {}); check('read_messages marks read', parse(res).count === 0);

// WhatsApp send dry-run + budget guard
res = await call('whatsapp', 'send_text', { to: 'user', text: 'Maa got your parcel.' }); check('send_text dry-run', parse(res).mode === 'dry_run');
res = await call('whatsapp', 'send_text', { to: 'nobody', text: 'x' }); check('unknown contact error', res.isError === true);
await panel('wa', { mode: 'live', budget: 0 });
res = await call('whatsapp', 'send_text', { to: 'user', text: 'x' }); check('live budget guard blocks', res.isError === true && parse(res).error.includes('budget'));
await panel('wa', { mode: 'dry', budget: 90 });

// Delivery with OTP check
st = await panel('state'); const code = st.shipments.find((x) => x.waybill === wb).otp.code;
let d = await panel('status', { waybill: wb, status: 'Delivered', otp: '0000' }); check('wrong OTP rejected', d.ok === false);
d = await panel('status', { waybill: wb, status: 'Delivered', otp: code }); check('delivered with OTP', d.ok === true);
t = parse(await call('delhivery', 'track_shipment', { waybill: wb })); check('track Delivered DL', t.ShipmentData[0].Shipment.Status.StatusType === 'DL');

// NDR + re-attempt flow on a second shipment
const s2 = await panel('shipment', { item: 'Phone', value: 18000, cod_amount: 0, open_box: true });
res = await call('delhivery', 'ndr_action', { waybill: s2.waybill, act: 'RE-ATTEMPT' }); let upl = parse(res).request_id;
t = parse(await call('delhivery', 'get_ndr_status', { upl })); check('RE-ATTEMPT refused without NDR', t.results[0].status === 'Failure');
await panel('status', { waybill: s2.waybill, status: 'Dispatched' });
await panel('status', { waybill: s2.waybill, status: 'NDR', reason: 'Consignee Unavailable' });
upl = parse(await call('delhivery', 'ndr_action', { waybill: s2.waybill, act: 'RE-ATTEMPT' })).request_id;
t = parse(await call('delhivery', 'get_ndr_status', { upl })); check('RE-ATTEMPT success after NDR', t.results[0].status === 'Success');
t = parse(await call('delhivery', 'track_shipment', { waybill: s2.waybill })); check('open-box flag in tracking', t.ShipmentData[0].Shipment.Extras === 'OPEN_BOX_DELIVERY');

// Faults
await panel('fault', { rail: 'delhivery', type: 'malformed', once: true });
res = await call('delhivery', 'track_shipment', { waybill: wb }); check('malformed body passed through', parse(res) === null);
res = await call('delhivery', 'track_shipment', { waybill: wb }); check('once-fault cleared', parse(res) !== null);
await panel('fault', { rail: 'delhivery', type: 'server_error', once: true });
res = await call('delhivery', 'track_shipment', { waybill: wb }); check('server_error -> isError', res.isError === true);
await panel('fault', { rail: 'delhivery', type: 'no_rider', once: false });
const s3 = await panel('shipment', {}); await panel('status', { waybill: s3.waybill, status: 'Dispatched' });
t = parse(await call('delhivery', 'track_shipment', { waybill: s3.waybill })); check('no_rider shows Pending', t.ShipmentData[0].Shipment.Status.Instructions.includes('not assigned'));
await panel('fault', { rail: 'delhivery', type: 'none' });
const t0 = Date.now(); await panel('fault', { rail: 'delhivery', type: 'timeout', once: true });
res = await call('delhivery', 'track_shipment', { waybill: wb }); check('timeout waits ~12s', Date.now() - t0 > 11000 && res.isError);

// Pine Labs mock
r = await rpc('rails', 'tools/list', {}); const railNames = r.json.result.tools.map((x) => x.name);
check(`rails has 20 tools (${railNames.length})`, railNames.length === 20);
let vn = parse(await call('rails', 'whatsapp_send_voice_note', { to: 'maa', text: 'Parcel aaj aayega', language_code: 'hi-IN' }));
check('voice_note falls back to text without Gnani', vn && vn.fallback === true && vn.mode === 'dry_run', JSON.stringify(vn));
check('rails has pinelabs + send_email', ['pinelabs_create_payment_link', 'pinelabs_get_payment_link', 'google_send_email'].every((x) => railNames.includes(x)));
let pr = parse(await call('rails', 'pinelabs_create_payment_link', { amount_inr: 1299, description: 'Myntra kurta COD', reference: wb }));
check('paylink created', pr.status === 'CREATED' && pr.amount.value === 129900 && /^pl-v1-/.test(pr.payment_link_id), JSON.stringify(pr));
check('paylink url points to /pay/', pr.payment_link.includes('/pay/' + pr.payment_link_id));
const plid = pr.payment_link_id;
res = await call('pinelabs', 'create_payment_link', { amount_inr: 0.5, reference: wb }); check('paylink tiny amount -> isError', res.isError === true);
let phr = await (await fetch(`${B}/pay/${plid}`)).text(); check('checkout page shows amount', phr.includes('Rs 1,299') && phr.includes('<form'));
prr = await fetch(`${B}/api/pay/v1/paymentlink/${plid}`, { headers: { Authorization: `Bearer ${K}` } }); let prj = await prr.json();
check('REST GET paylink CREATED', prr.status === 200 && prj.status === 'CREATED');
prr = await fetch(`${B}/api/pay/v1/paymentlink/${plid}`); check('REST paylink needs auth', prr.status === 401);
phr = await (await fetch(`${B}/pay/${plid}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' })).text();
check('checkout POST pays', phr.includes('Payment successful'));
pr = parse(await call('pinelabs', 'get_payment_link', { payment_link_id: plid })); check('paylink PROCESSED after pay', pr.status === 'PROCESSED' && pr.payment?.method === 'UPI');
prr = await fetch(`${B}/api/pay/v1/paymentlink/${plid}/cancel`, { method: 'PUT', headers: { Authorization: `Token ${K}` } }); check('cannot cancel paid link', prr.status === 400);
const pl2 = parse(await call('pinelabs', 'create_payment_link', { amount_inr: 500, reference: 'X1' })).payment_link_id;
prr = await fetch(`${B}/api/pay/v1/paymentlink/${pl2}/cancel`, { method: 'PUT', headers: { Authorization: `Token ${K}` } }); check('cancel CREATED link', (await prr.json()).status === 'CANCELLED');
const pl3 = parse(await call('pinelabs', 'create_payment_link', { amount_inr: 700, reference: 'X2' })).payment_link_id;
let pp = await panel('paylink', { id: pl3 }); check('panel mark paid', pp.ok === true);
pp = await panel('paylink', { id: pl3 }); check('panel mark paid twice refused', pp.ok === false);
res = await call('pinelabs', 'get_payment_link', { payment_link_id: 'pl-v1-nope' }); check('unknown paylink -> isError', res.isError === true);
await panel('fault', { rail: 'pinelabs', type: 'malformed', once: true });
res = await call('pinelabs', 'get_payment_link', { payment_link_id: plid }); check('pinelabs malformed passed through', parse(res) === null);
res = await call('pinelabs', 'get_payment_link', { payment_link_id: plid }); check('pinelabs once-fault cleared', parse(res)?.status === 'PROCESSED');
await panel('fault', { rail: 'pinelabs', type: 'expired', once: true });
pr = parse(await call('pinelabs', 'create_payment_link', { amount_inr: 1299, reference: 'X3' })); check('expired fault -> link EXPIRED', pr.status === 'EXPIRED');
await panel('fault', { rail: 'pinelabs', type: 'auth', once: true });
res = await call('pinelabs', 'get_payment_link', { payment_link_id: plid }); check('pinelabs auth fault -> isError', res.isError === true);
let stp = await panel('state'); check('panel lists paylinks', stp.paylinks.length >= 4 && 'pinelabs' in stp.faults);
res = await call('rails', 'google_send_email', { subject: '[cOunTerPart LOG] AWB 1 S1', body: 'x' }); check('send_email graceful without network', res.isError === true);

// External rails fail gracefully without network
res = await call('google', 'search_emails', { query: 'Delhivery' }); check('google error is graceful', res.isError === true);
res = await call('gnani', 'text_to_speech', { text: 'hello', language_code: 'en-IN' }); check('gnani error is graceful', res.isError === true || parse(res).audio_url);
st = await panel('state'); check('event log populated', st.log.length > 20);
check('panel HTML served', (await (await fetch(`${B}/panel`)).text()).includes('control panel'));
console.log(`\n${n - fail}/${n} passed`);
