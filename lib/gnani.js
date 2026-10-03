// Gnani bridge: real STT (Prisma) and TTS (Timbre) calls. Formats taken from Gnani's official SDK.
import { logEvent, applyFault, sleep } from './util.js';
import { fetchAudio, saveMedia } from './media.js';

const BASE = () => process.env.GNANI_BASE_URL || 'https://api.vachana.ai';
const KEY = () => process.env.GNANI_API_KEY;
const STT_LANGS = ['en-IN', 'hi-IN', 'gu-IN', 'ta-IN', 'kn-IN', 'te-IN', 'mr-IN', 'bn-IN', 'ml-IN', 'pa-IN'];
const VOICES = { 'hi-IN': 'Nalini', 'en-IN': 'Kaveri', 'kn-IN': 'Saanvi', 'ta-IN': 'Asmita', 'te-IN': 'Suhana', 'ml-IN': 'Reshma', 'mr-IN': 'Zahira', 'bn-IN': 'Kirra', 'gu-IN': 'Falak', 'pa-IN': 'Mehuli' };

async function faulted() {
  const f = await applyFault('gnani');
  if (f === 'timeout') { await sleep(12000); return { __isError: true, error: 'Gnani request timed out' }; }
  if (f === 'server_error') return { __isError: true, error: 'Gnani returned 502 Bad Gateway' };
  if (f === 'malformed') return { __raw: '{"transcript": "rider at gate tw', __isError: false };
  return null;
}

export async function speechToText({ audio_url, language_code = 'hi-IN' }) {
  const f = await faulted(); if (f) { await logEvent('gnani', 'speech_to_text', { audio_url, language_code }, f); return f; }
  if (!STT_LANGS.includes(language_code)) language_code = 'hi-IN';
  const audio = await fetchAudio(audio_url);
  const form = new FormData();
  form.append('audio_file', new Blob([audio.buffer], { type: audio.mime }), `audio.${audio.ext}`);
  form.append('language_code', language_code);
  form.append('format', 'transcribe');
  const r = await fetch(`${BASE()}/stt/v3`, { method: 'POST', headers: { 'X-API-Key-ID': KEY() }, body: form });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  const out = r.ok ? { transcript: j.transcript ?? j.text ?? '', language_code, gnani_response: j } : { __isError: true, error: `Gnani STT ${r.status}`, detail: j };
  await logEvent('gnani', 'speech_to_text', { audio_url, language_code }, out);
  return out;
}

export async function textToSpeech({ text, language_code = 'hi-IN', voice }, ctx) {
  const f = await faulted(); if (f) { await logEvent('gnani', 'text_to_speech', { text, language_code }, f); return f; }
  const body = {
    text,
    model: 'timbre-v2.5',
    voice: voice || VOICES[language_code] || 'Kaveri',
    language: language_code,
    speed: 1.0,
    audio_config: { sample_rate: 24000, encoding: 'linear_pcm', num_channels: 1, sample_width: 2, container: 'mp3', bitrate: '64k' },
  };
  const r = await fetch(`${BASE()}/api/v1/tts/inference`, { method: 'POST', headers: { 'X-API-Key-ID': KEY(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) {
    const out = { __isError: true, error: `Gnani TTS ${r.status}`, detail: (await r.text()).slice(0, 500) };
    await logEvent('gnani', 'text_to_speech', { text, language_code }, out);
    return out;
  }
  const buf = Buffer.from(await r.arrayBuffer());
  const m = await saveMedia(buf, 'audio/mpeg', ctx.baseUrl);
  const out = { audio_url: m.url, voice: body.voice, language_code, bytes: buf.length };
  await logEvent('gnani', 'text_to_speech', { text, language_code }, out);
  return out;
}

export const tools = [
  {
    name: 'speech_to_text',
    description: 'Transcribe a voice note with Gnani. Pass the audio_url from a WhatsApp message or rider_bridge. language_code: hi-IN, kn-IN, en-IN, ta-IN, te-IN, mr-IN, bn-IN, ml-IN, gu-IN or pa-IN. For Hinglish use hi-IN.',
    inputSchema: { type: 'object', properties: { audio_url: { type: 'string' }, language_code: { type: 'string' } }, required: ['audio_url'] },
    handler: (a) => speechToText(a),
  },
  {
    name: 'text_to_speech',
    description: 'Turn a short reply into speech with Gnani, in the listener\'s language. Returns an audio_url to send with whatsapp send_voice. Read numbers digit by digit in the text (for example "one two zero four").',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, language_code: { type: 'string' }, voice: { type: 'string' } }, required: ['text'] },
    handler: (a, ctx) => textToSpeech(a, ctx),
  },
];
