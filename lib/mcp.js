// Minimal, stateless MCP server over Streamable HTTP (JSON responses, no SSE).
// Each connector is { name, version, tools: [{ name, description, inputSchema, handler(args, ctx) }] }.
import { send } from './http.js';

const PROTOCOL_DEFAULT = '2025-03-26';

export async function handleMcp(req, res, body, connector, ctx) {
  if (req.method === 'GET') { res.setHeader('Allow', 'POST'); return send(res, 405, { error: 'Use POST for MCP JSON-RPC' }); }
  if (req.method === 'DELETE') return send(res, 200, {});
  const batch = Array.isArray(body) ? body : [body];
  const out = [];
  for (const msg of batch) {
    const r = await handleOne(msg, connector, ctx);
    if (r) out.push(r);
  }
  if (!out.length) return send(res, 202, null);
  return send(res, 200, Array.isArray(body) ? out : out[0]);
}

async function handleOne(msg, connector, ctx) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const { id, method, params = {} } = msg;
  const isNotification = id === undefined || id === null;
  const ok = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
  const err = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: params.protocolVersion || PROTOCOL_DEFAULT,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: connector.name, version: connector.version || '1.0.0' },
        instructions: connector.instructions || '',
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: connector.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = connector.tools.find((t) => t.name === params.name);
      if (!tool) return err(-32602, `Unknown tool: ${params.name}`);
      const args = params.arguments || {};
      const missing = (tool.inputSchema.required || []).filter((k) => args[k] === undefined || args[k] === '');
      if (missing.length) return ok(toolResult({ error: `Missing required argument(s): ${missing.join(', ')}` }, true));
      try {
        const r = await tool.handler(args, ctx);
        // Handlers may return { __raw, __isError } to pass through an HTTP body untouched (e.g. malformed JSON).
        if (r && r.__raw !== undefined) return ok({ content: [{ type: 'text', text: r.__raw }], isError: Boolean(r.__isError) });
        return ok(toolResult(r, Boolean(r && r.__isError)));
      } catch (e) {
        return ok(toolResult({ error: e.message || String(e) }, true));
      }
    }
    default:
      if (method && method.startsWith('notifications/')) return null;
      return err(-32601, `Method not found: ${method}`);
  }
}

function toolResult(obj, isError) {
  if (obj && obj.__isError !== undefined) { obj = { ...obj }; delete obj.__isError; }
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  const res = { content: [{ type: 'text', text }], isError };
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) res.structuredContent = obj;
  return res;
}
