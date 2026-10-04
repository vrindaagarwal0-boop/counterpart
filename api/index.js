// Single entry point. Every URL is routed here by vercel.json.
import { readBody, send, authorized, baseUrl } from '../lib/http.js';
import { handleMcp } from '../lib/mcp.js';
import { serveMedia } from '../lib/media.js';
import * as dl from '../lib/delhivery.js';
import * as gnani from '../lib/gnani.js';
import * as google from '../lib/google.js';
import * as wa from '../lib/whatsapp.js';
import * as pl from '../lib/pinelabs.js';
import * as panel from '../lib/panel.js';
import { PANEL_HTML } from '../lib/panel-html.js';

const CONNECTORS = {
  delhivery: { name: 'delhivery-counterpart', instructions: 'Delhivery rails (mock of documented API) plus 3 BUILD capabilities.', tools: dl.tools },
  gnani: { name: 'gnani-counterpart', instructions: 'Gnani speech-to-text and text-to-speech for Indian languages.', tools: gnani.tools },
  google: { name: 'google-counterpart', instructions: 'User\'s Gmail (read) and Google Calendar (free/busy).', tools: google.tools },
  whatsapp: { name: 'whatsapp-counterpart', instructions: 'WhatsApp messaging with the user and trusted people, via Twilio.', tools: wa.tools },
  pinelabs: { name: 'pinelabs-counterpart', instructions: 'Pine Labs Payment Links (mock of documented API).', tools: pl.tools },
};

// One combined connector with every tool, prefixed by rail. AgenticOrg currently
// accepts tools from only one MCP connector per agent, so the agent uses this one.
const prefixed = (rail, tools) => tools.map((t) => ({ ...t, name: `${rail}_${t.name}` }));
CONNECTORS.rails = {
  name: 'counterpart-rails',
  instructions: 'All cOunTerPart rails in one connector: Delhivery (mock + 3 BUILD), Pine Labs (mock), Gnani, Google, WhatsApp.',
  tools: [...prefixed('delhivery', dl.tools), ...prefixed('gnani', gnani.tools), ...prefixed('google', google.tools), ...prefixed('whatsapp', wa.tools), ...prefixed('pinelabs', pl.tools)],
};



// One combined connector with every tool, prefixed by rail. AgenticOrg currently
// accepts tools from only one MCP connector per agent, so the agent uses this one.
const prefixed = (rail, tools) => tools.map((t) => ({ ...t, name: `${rail}_${t.name}` }));
CONNECTORS.rails = {
  name: 'counterpart-rails',
  instructions: 'All cOunTerPart rails in one connector: Delhivery (mock + 3 BUILD), Gnani, Google, WhatsApp.',
  tools: [...prefixed('delhivery', dl.tools), ...prefixed('gnani', gnani.tools), ...prefixed('google', google.tools), ...prefixed('whatsapp', wa.tools)],
};



export default async function handler(req, res) {
  const url = new URL(req.url, 'http://local');
  const path = url.pathname;
  const ctx = { baseUrl: baseUrl(req) };
  try {
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, Mcp-Session-Id, Mcp-Protocol-Version');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      return send(res, 204, null);
    }
    if (path === '/' || path === '/health') {
      return send(res, 200, { ok: true, service: 'counterpart-rails', mcp: Object.keys(CONNECTORS).map((k) => `/mcp/${k}`) });
    }
    if (path.startsWith('/media/')) return serveMedia(res, path);

    // Public Pine Labs mock checkout page (the payment_link URL points here).
    if (path.startsWith('/pay/')) {
      if (req.method === 'POST') await readBody(req);
      return send(res, 200, await pl.checkout(path, req.method), 'text/html; charset=utf-8');
    }

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
      const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : {};
      const r = path.startsWith('/api/pay/') ? await pl.rest(path, req.method, body, ctx) : await dl.rest(path, req.method, url.searchParams, body);
      if (!r) return send(res, 404, { error: 'Not found' });
      return send(res, r.status, r.body);
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message || 'Server error' });
  }
}
