// Key-value store: Upstash Redis (via REST) when configured, in-memory otherwise.
const envFind = (test) => Object.keys(process.env).filter(test).map((k) => process.env[k]).find(Boolean);
const URL_ = envFind((k) => /(REST_API_URL|REDIS_REST_URL)$/.test(k));
const TOKEN = envFind((k) => /(REST_API_TOKEN|REDIS_REST_TOKEN)$/.test(k) && !k.includes('READ_ONLY'));
const mem = globalThis.__mem || (globalThis.__mem = new Map());

async function cmd(args) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const j = await r.json();
  if (j.error) throw new Error('store: ' + j.error);
  return j.result;
}

export const usingRedis = Boolean(URL_ && TOKEN);

export async function get(key) {
  if (!usingRedis) return mem.has(key) ? JSON.parse(mem.get(key)) : null;
  const v = await cmd(['GET', key]);
  return v == null ? null : JSON.parse(v);
}

export async function set(key, value, ttlSec) {
  const s = JSON.stringify(value);
  if (!usingRedis) { mem.set(key, s); return; }
  await cmd(ttlSec ? ['SET', key, s, 'EX', String(ttlSec)] : ['SET', key, s]);
}

export async function del(key) {
  if (!usingRedis) { mem.delete(key); return; }
  await cmd(['DEL', key]);
}

// Append to a capped list (newest last).
export async function push(key, value, cap = 500) {
  const list = (await get(key)) || [];
  list.push(value);
  while (list.length > cap) list.shift();
  await set(key, list);
  return list;
}
