// Small HTTP helpers shared by every route.
export async function readBody(req) {
  // Vercel pre-parses bodies into req.body; the local test server does the same.
  try {
    if (req.body !== undefined && req.body !== null) {
      if (Buffer.isBuffer(req.body)) return parseRaw(req.body.toString('utf8'), req.headers['content-type']);
      if (typeof req.body === 'string') return parseRaw(req.body, req.headers['content-type']);
      return req.body;
    }
  } catch (_) { /* fall through to raw read */ }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return parseRaw(Buffer.concat(chunks).toString('utf8'), req.headers['content-type']);
}

function parseRaw(s, ct = '') {
  if (!s) return {};
  if (ct.includes('application/json')) { try { return JSON.parse(s); } catch { return { __invalid_json: s }; } }
  if (ct.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(s));
  try { return JSON.parse(s); } catch { return { __raw: s }; }
}

export function send(res, status, body, type = 'application/json') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (body === undefined || body === null) return res.end();
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// Accepts the MCP_API_KEY as: x-api-key header, Authorization "Bearer <key>" or "Token <key>", or ?key= query.
export function authorized(req, url) {
  const key = process.env.MCP_API_KEY;
  if (!key) return true; // no key configured (local dev)
  const h = req.headers;
  const auth = (h['authorization'] || '').replace(/^(Bearer|Token)\s+/i, '').trim();
  return h['x-api-key'] === key || auth === key || url.searchParams.get('key') === key || url.searchParams.get('token') === key;
}

export function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}
