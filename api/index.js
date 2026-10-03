// Single entry point. Every URL is routed here by vercel.json.
import { readBody, send, authorized, baseUrl } from '../lib/http.js';
import { handleMcp } from '../lib/mcp.js';
import { serveMedia } from '../lib/media.js';
import * as dl from '../lib/delhivery.js';
import * as gnani from '../lib/gnani.js';
import * as google from '../lib/google.js';
import * as wa from '../lib/whatsapp.js';
import * as panel from '../lib/panel.js';
import { PANEL_HTML } from '../lib/panel-html.js';

const CONNECTORS = {
  delhivery: { name: 'delhivery-counterpart', instructions: 'Delhivery rails (mock of documented API) plus 3 BUILD capabilities.', tools: dl.tools },
  gnani: { name: 'gnani-counterpart', instructions: 'Gnani speech-to-text and text-to-speech for Indian languages.', tools: gnani.tools },
  google: { name: 'google-counterpart', instructions: 'User\'s Gmail (read) and Google Calendar (free/busy).', tools: google.tools },
  whatsapp: { name: 'whatsapp-counterpart', instructions: 'WhatsApp messaging with the user and trusted people, via Twilio.', tools: wa.tools },
};

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://local');
  const path = url.pathname;
  const ctx = { baseUrl: baseUrl(req) };
  try {
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, Mcp-Session-Id, Mcp-Protocol-Version');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      return send(res, 204, null);
    }
    if (path === '/' || path === '/health') {
      return send(res, 200, { ok: true, service: 'counterpart-rails', mcp: Object.keys(CONNECTORS).map((k) => `/mcp/${k}`) });
    }
    if (path.startsWith('/media/')) return serveMedia(res, path);

    // Twilio inbound webhook (Twilio signs requests; we keep it open so the sandbox works without extra setup).
    if (path === '/twilio/webhook' && req.method === 'POST') {
      const body = await readBody(req);
      const twiml = await wa.twilioWebhook(body, ctx.baseUrl);
      return send(res, 200, twiml, 'text/xml');
    }

    if (path === '/panel' || path === '/panel/') return send(res, 200, PANEL_HTML, 'text/html; charset=utf-8');
    if (path.startsWith('/panel/api/')) {
      if (!authorized(req, url)) return send(res, 401, { error: 'Wrong or missing key' });
      const name = path.split('/')[3];
      if (name === 'state') return send(res, 200, await panel.state());
      const body = await readBody(req);
      return send(res, 200, await panel.action(name, body, ctx));
    }

    const mcp = path.match(/^\/mcp\/([a-z]+)\/?$/);
    if (mcp) {
      if (!CONNECTORS[mcp[1]]) return send(res, 404, { error: 'Unknown connector' });
      if (!authorized(req, url)) return send(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: missing or wrong API key' } });
      const body = req.method === 'POST' ? await readBody(req) : {};
      return handleMcp(req, res, body, CONNECTORS[mcp[1]], ctx);
    }

    if (path.startsWith('/api/')) {
      if (!authorized(req, url)) return send(res, 401, { detail: 'Invalid token.' });
      const body = req.method === 'POST' ? await readBody(req) : {};
      const r = await dl.rest(path, req.method, url.searchParams, body);
      if (!r) return send(res, 404, { error: 'Not found' });
      return send(res, r.status, r.body);
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message || 'Server error' });
  }
}
