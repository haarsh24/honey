// Spoken replies: when the owner sends a voice note, also answer with an audio message (English only).
import { getState } from './db.js';
import { sendAudio } from './whatsapp.js';

const MAX_CHARS = 600;

/** Plain, speakable English text, or null when the reply is not worth (or able to be) spoken. */
export function speakable(reply) {
  const text = String(reply ?? '')
    .replace(/[*_`~#>]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\p{Extended_Pictographic}|️|‍/gu, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 3 || text.length > MAX_CHARS) return null;
  const letters = text.match(/\p{L}/gu) ?? [];
  const latin = letters.filter((c) => /[A-Za-z]/.test(c)).length;
  if (!letters.length || latin / letters.length < 0.9) return null; // Hindi script etc. stays as text
  return text;
}

const TTS_MODEL = '@cf/deepgram/aura-1'; // outputs real MP3, which WhatsApp can play (the MeloTTS model returns WAV, which it cannot)
const SPEAKER = 'luna';

function fromBase64(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** True for MP3 data: an ID3 tag or an MPEG frame sync. */
export function looksLikeMp3(bytes) {
  if (!bytes || bytes.length < 4) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
  return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

async function toBytes(out) {
  if (out instanceof Uint8Array) return out;
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  if (typeof Response !== 'undefined' && out instanceof Response) return new Uint8Array(await out.arrayBuffer());
  if (out && typeof out.getReader === 'function') return new Uint8Array(await new Response(out).arrayBuffer());
  const b64 = typeof out === 'string' ? out : out?.audio;
  if (b64) return fromBase64(b64);
  throw new Error('TTS returned no audio');
}

export async function synthesize(env, text) {
  if (typeof env.__tts === 'function') return env.__tts(text); // test hook
  if (!env.AI) throw new Error('Workers AI binding missing');
  const out = await env.AI.run(TTS_MODEL, { text, speaker: SPEAKER, encoding: 'mp3' }, { returnRawResponse: true });
  const bytes = await toBytes(out);
  if (!looksLikeMp3(bytes)) throw new Error('TTS did not return MP3 audio');
  return bytes;
}

export async function voiceRepliesOn(env) {
  return (await getState(env, 'voice_reply')) !== 'off';
}

/** Best effort: never throws, so the text reply is never affected. */
export async function sendVoiceReply(env, to, reply) {
  try {
    if (!(await voiceRepliesOn(env))) return false;
    const text = speakable(reply);
    if (!text) return false;
    const bytes = await synthesize(env, text);
    await sendAudio(env, to, bytes, 'audio/mpeg');
    return true;
  } catch (error) {
    console.error('Voice reply failed:', error.message);
    return false;
  }
}
