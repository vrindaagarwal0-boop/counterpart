// People the agent may message. Set from the control panel so phone numbers never live in the prompt.
import * as store from './store.js';
import { normPhone } from './util.js';

const DEFAULTS = [
  { key: 'user', name: 'Rudraksh', role: 'user', language: 'en-IN', phone: '' },
  { key: 'maa', name: 'Maa', role: 'trusted', language: 'hi-IN', phone: '' },
  { key: 'rahul', name: 'Rahul', role: 'trusted', language: 'en-IN', phone: '' },
  { key: 'ramesh', name: 'Ramesh', role: 'trusted', language: 'kn-IN', phone: '' },
  { key: 'rider', name: 'Rider (Delhivery)', role: 'rider', language: 'kn-IN', phone: '' },
];

export async function getContacts() {
  return (await store.get('contacts')) || DEFAULTS;
}

export async function setContacts(list) {
  const clean = list.map((c) => ({ ...c, key: String(c.key).toLowerCase().trim(), phone: normPhone(c.phone) }));
  await store.set('contacts', clean);
  return clean;
}

// Resolve "maa", "Maa", "+91 98...", "9198..." to a contact (or a bare phone).
export async function resolve(to) {
  const list = await getContacts();
  const t = String(to || '').trim().toLowerCase();
  const byKey = list.find((c) => c.key === t || c.name.toLowerCase() === t);
  if (byKey) return byKey;
  const p = normPhone(to);
  const byPhone = list.find((c) => c.phone && c.phone === p);
  if (byPhone) return byPhone;
  return p ? { key: null, name: null, role: 'unknown', phone: p } : null;
}

export async function nameForPhone(phone) {
  const p = normPhone(phone);
  const c = (await getContacts()).find((x) => x.phone === p);
  return c ? c.key : null;
}

export const mask = (p) => (p ? `+${String(p).slice(0, 2)} ******${String(p).slice(-4)}` : '');
