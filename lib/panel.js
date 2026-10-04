// Control panel API. The page itself is public HTML; every action needs the MCP_API_KEY.
import * as store from './store.js';
import { logEvent, normPhone } from './util.js';
import { getContacts, setContacts } from './contacts.js';
import * as wa from './whatsapp.js';
import * as dl from './delhivery.js';
import * as gnani from './gnani.js';
import * as google from './google.js';
import * as pl from './pinelabs.js';

const RAILS = ['delhivery', 'pinelabs', 'gnani', 'google', 'whatsapp'];

export async function state() {
  try { await wa.syncTwilio(); } catch (_) { /* panel still loads */ }
  const faults = {};
  for (const r of RAILS) faults[r] = (await store.get(`fault:${r}`)) || { type: 'none' };
  return {
    redis: store.usingRedis,
    contacts: await getContacts(),
    whatsapp: await wa.getSettings(),
    shipments: await dl.listShipments(),
    paylinks: (await pl.listLinks()).map(({ history, ...l }) => l),
    faults,
    inbox: ((await store.get('wa:inbox')) || []).slice(-40).map(({ phone, ...m }) => m),
    outbox: ((await store.get('wa:outbox')) || []).slice(-60),
    log: ((await store.get('log')) || []).slice(-200),
    env: {
      gnani: Boolean(process.env.GNANI_API_KEY), google: Boolean(process.env.GOOGLE_REFRESH_TOKEN),
      twilio: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN), mcp_key: Boolean(process.env.MCP_API_KEY),
    },
  };
}

export async function action(name, b, ctx) {
  switch (name) {
    case 'contacts': return { contacts: await setContacts(b.contacts || []) };
    case 'wa': {
      const patch = {};
      if (b.mode) patch.mode = b.mode === 'live' ? 'live' : 'dry';
      if (b.budget !== undefined) patch.budget = Number(b.budget);
      if (b.reset_counts) { patch.live_sent = 0; patch.live_received = 0; }
      const s = await wa.setSettings(patch);
      await logEvent('panel', 'whatsapp_settings', patch, s);
      return s;
    }
    case 'shipment': return dl.createShipment(b);
    case 'paylink': return pl.markPaid(b.id, 'panel');
    case 'status': return dl.setStatus(b.waybill, b.status, { reason: b.reason, otp: b.otp, rider_name: b.rider_name });
    case 'fault': {
      if (!RAILS.includes(b.rail)) throw new Error('unknown rail');
      await store.set(`fault:${b.rail}`, { type: b.type || 'none', once: Boolean(b.once) });
      await logEvent('panel', 'set_fault', b, 'ok');
      return { ok: true };
    }
    case 'inbound': {
      const contacts = await getContacts();
      const c = contacts.find((x) => x.key === b.from);
      const phone = c?.phone || normPhone(b.phone) || '910000000000';
      const audioBuffer = b.audio_b64 ? Buffer.from(b.audio_b64, 'base64') : undefined;
      return wa.addInbound({ fromPhone: phone, text: b.text || '', audioBuffer, audioMime: b.audio_mime, baseUrl: ctx.baseUrl, source: 'panel' });
    }
    case 'reset': {
      for (const s of await dl.listShipments()) await store.del(`ship:${s.waybill}`);
      for (const l of await pl.listLinks()) await store.del(`pl:${l.payment_link_id}`);
      for (const k of ['pl:index', 'ship:index', 'wa:inbox', 'wa:seen_sids', 'wa:outbox', 'log']) await store.del(k);
      for (const r of RAILS) await store.del(`fault:${r}`);
      return { ok: true };
    }
    case 'selftest': {
      if (b.target === 'google') return { search: await google.searchEmails({ query: 'newer_than:7d', max_results: 3 }), calendar: await google.checkAvailability({}) };
      if (b.target === 'gnani') {
        const tts = await gnani.textToSpeech({ text: 'Namaste, main cOunTerPart hoon.', language_code: 'hi-IN' }, ctx);
        if (tts.__isError) return { tts };
        return { tts, stt: await gnani.speechToText({ audio_url: tts.audio_url, language_code: 'hi-IN' }) };
      }
      if (b.target === 'whatsapp') {
        if (!b.confirm) throw new Error('confirm required');
        return wa.sendMessage({ to: b.to || 'user', text: 'cOunTerPart test: WhatsApp bridge is connected.' }, { via: 'selftest' });
      }
      throw new Error('unknown target');
    }
    default: throw new Error('unknown action');
  }
}
