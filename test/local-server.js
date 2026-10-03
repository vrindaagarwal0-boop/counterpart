// Runs the Vercel handler locally with Vercel-like body parsing. Usage: node test/local-server.js
import http from 'node:http';
import handler from '../api/index.js';
const port = Number(process.env.PORT || 3999);
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  const ct = req.headers['content-type'] || '';
  if (raw) req.body = ct.includes('json') ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : ct.includes('urlencoded') ? Object.fromEntries(new URLSearchParams(raw)) : raw;
  handler(req, res);
}).listen(port, () => console.log('local on ' + port));
