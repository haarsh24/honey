// Spoken replies: when the owner sends a voice note, also answer with an audio message (English only).
import { getState } from './db.js';
import { sendAudio } from './whatsapp.js';

const MAX_CHARS = 600;
const TTS_MODEL = '@cf/myshell-ai/melotts';

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

function fromBase64(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function synthesize(env, text) {
  if (typeof env.__tts === 'function') return env.__tts(text); // test hook
  if (!env.AI) throw new Error('Workers AI binding missing');
  const out = await env.AI.run(TTS_MODEL, { prompt: text, lang: 'en' });
  const b64 = typeof out === 'string' ? out : out?.audio;
  if (!b64) throw new Error('TTS returned no audio');
  return fromBase64(b64);
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
