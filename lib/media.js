// Audio storage. Twilio and Gnani both need audio at a public URL, so we keep it in Redis and serve it at /media/<id>.<ext>.
import * as store from './store.js';
import { rid } from './util.js';
import { send } from './http.js';

const EXT = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/amr': 'amr', 'audio/aac': 'aac', 'audio/mp4': 'm4a' };

export async function saveMedia(buffer, mime, baseUrl) {
  const clean = (mime || 'audio/mpeg').split(';')[0].trim();
  const ext = EXT[clean] || 'bin';
  const id = rid('m');
  await store.set(`media:${id}`, { mime: clean, ext, b64: Buffer.from(buffer).toString('base64') }, 3 * 24 * 3600);
  return { id, mime: clean, ext, url: `${baseUrl}/media/${id}.${ext}` };
}

export async function loadMedia(idOrUrl) {
  const m = String(idOrUrl).match(/(?:\/media\/)?(m[a-z0-9]+)(?:\.[a-z0-9]+)?$/i);
  if (!m) return null;
  const rec = await store.get(`media:${m[1]}`);
  return rec ? { ...rec, buffer: Buffer.from(rec.b64, 'base64') } : null;
}

export async function serveMedia(res, path) {
  const rec = await loadMedia(path);
  if (!rec) return send(res, 404, { error: 'media not found' });
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return send(res, 200, rec.buffer, rec.mime);
}

// Fetch audio from one of our /media URLs (no network hop) or from any public URL.
export async function fetchAudio(url) {
  const local = await loadMedia(url);
  if (local) return { buffer: local.buffer, mime: local.mime, ext: local.ext };
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not download audio (${r.status})`);
  const mime = (r.headers.get('content-type') || 'audio/ogg').split(';')[0];
  return { buffer: Buffer.from(await r.arrayBuffer()), mime, ext: EXT[mime] || 'ogg' };
}
