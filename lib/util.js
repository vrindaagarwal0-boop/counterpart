import * as store from './store.js';

export const nowIso = () => new Date().toISOString();
export const istIso = (d = new Date()) =>
  new Date(d.getTime() + 330 * 60000).toISOString().replace('Z', '+05:30');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rid = (p = '') => p + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function normPhone(p) {
  if (!p) return '';
  let d = String(p).replace(/\D/g, '');
  if (d.length === 10) d = '91' + d;
  return d;
}

// Every rail call is logged. The control panel shows it; it doubles as evidence for the decision log.
export async function logEvent(rail, action, input, output) {
  const short = (o) => {
    const s = typeof o === 'string' ? o : JSON.stringify(o);
    return s && s.length > 1500 ? s.slice(0, 1500) + '...' : s;
  };
  await store.push('log', { ts: istIso(), rail, action, input: short(input), output: short(output) }, 400);
}

// Fault injection, set per rail from the control panel: { type, once }.
export async function applyFault(rail) {
  const f = await store.get(`fault:${rail}`);
  if (!f || f.type === 'none') return null;
  if (f.once) await store.del(`fault:${rail}`);
  return f.type; // 'timeout' | 'malformed' | 'server_error' | 'auth' | rail-specific
}
