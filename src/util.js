const encoder = new TextEncoder();

/** Digits only. A bare 10-digit number gets the default country code (India: 91). */
export function normalizePhone(value, defaultCountryCode = '91') {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 10 && defaultCountryCode) return defaultCountryCode + digits;
  return digits;
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualStrings(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verify Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body with the App Secret). */
export async function verifySignature(rawBody, header, secret) {
  if (!header || !secret || !header.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  return timingSafeEqualStrings(toHex(signature), header.slice(7).toLowerCase());
}

/**
 * Pull the first JSON object out of model output. Tolerates code fences, text around the JSON,
 * and raw newlines inside strings. Returns null when nothing parseable is found.
 */
export function parseModelJson(text) {
  if (typeof text !== 'string') return null;
  const s = text.replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let out = '';
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        out += c;
      } else if (c === '\\') {
        escaped = true;
        out += c;
      } else if (c === '"') {
        inString = false;
        out += c;
      } else if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else out += c;
      continue;
    }
    out += c;
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          const value = JSON.parse(out);
          return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** WhatsApp template parameters cannot contain newlines/tabs or long runs of spaces. */
export function sanitizeTemplateParam(text, max = 500) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || '-';
}

/** Split long text into WhatsApp-sized chunks (limit is 4096 characters). */
export function chunkText(text, size = 3800) {
  const chunks = [];
  let rest = String(text ?? '');
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = size;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length) chunks.push(rest);
  return chunks.length ? chunks : [''];
}
