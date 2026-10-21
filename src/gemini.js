// Calls Gemini's native API for audio, images and PDFs (the text model chain in llm.js can't read these).
const TIMEOUT_MS = 40000;

export function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64'); // fast native path (nodejs_compat)
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * prompt: instruction text. media: { bytes: Uint8Array, mime: string }. json: ask for a JSON answer.
 * Returns the model's text.
 */
export async function gemini(env, { prompt, media, json = false }) {
  if (typeof env.__gemini === 'function') return env.__gemini({ prompt, media, json }); // test hook
  if (!env.GEMINI_KEY) {
    const error = new Error('GEMINI_KEY is not set');
    error.code = 'NO_KEY';
    throw error;
  }
  const model = env.GEMINI_MODEL || 'gemini-flash-latest';
  const parts = [{ text: prompt }];
  if (media) parts.push({ inline_data: { mime_type: media.mime, data: toBase64(media.bytes) } });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': env.GEMINI_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { temperature: 0.1, ...(json ? { responseMimeType: 'application/json' } : {}) },
        }),
        signal: controller.signal,
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`gemini ${response.status}: ${data?.error?.message ?? 'request failed'}`);
    const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
    if (!text) throw new Error('gemini returned no text');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Results page Gemini reads for web searches (Google Search grounding has no free quota, URL reading does). */
export const searchUrl = (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * Gemini with the URL-reading tool: the prompt names the page(s) to open.
 * Tries the configured model, then a lighter one if the first is busy or over quota.
 * Returns { text }.
 */
export async function geminiWeb(env, { prompt }) {
  if (typeof env.__gemini === 'function') {
    return { text: await env.__gemini({ prompt, kind: 'url' }) }; // test hook
  }
  if (!env.GEMINI_KEY) {
    const error = new Error('GEMINI_KEY is not set');
    error.code = 'NO_KEY';
    throw error;
  }
  const models = [...new Set([env.GEMINI_MODEL || 'gemini-flash-latest', 'gemini-flash-lite-latest'])];
  let lastError;
  for (const model of models) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'x-goog-api-key': env.GEMINI_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            tools: [{ url_context: {} }],
            generationConfig: { temperature: 0.2 },
          }),
          signal: controller.signal,
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        lastError = new Error(`gemini ${response.status}: ${data?.error?.message ?? 'request failed'}`);
        if (RETRYABLE.has(response.status)) continue;
        throw lastError;
      }
      const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
      if (!text) {
        lastError = new Error('gemini returned no text');
        continue;
      }
      return { text: text.slice(0, 3000) };
    } catch (error) {
      lastError = error;
      if (error.name !== 'AbortError' && !String(error.message).startsWith('gemini ')) throw error;
      if (String(error.message).startsWith('gemini ') && !RETRYABLE.has(Number(/gemini (\d+)/.exec(error.message)?.[1]))) throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error('gemini failed');
}
