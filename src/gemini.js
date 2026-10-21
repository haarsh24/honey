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

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** POSTs a generateContent body; tries the configured model, then a lighter one if busy, over quota or gone. */
async function generate(env, body) {
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
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        lastError = new Error(`gemini ${response.status}: ${data?.error?.message ?? 'request failed'}`);
        if (RETRYABLE.has(response.status) || response.status === 404) continue;
        throw lastError;
      }
      const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
      if (!text) {
        lastError = new Error(`gemini returned no text (${data?.candidates?.[0]?.finishReason ?? data?.promptFeedback?.blockReason ?? 'unknown'})`);
        continue;
      }
      return text;
    } catch (error) {
      if (error.name === 'AbortError') {
        lastError = new Error('gemini timed out');
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error('gemini failed');
}

/**
 * prompt: instruction text. media: { bytes: Uint8Array, mime: string }. json: ask for a JSON answer.
 * Returns the model's text.
 */
export async function gemini(env, { prompt, media, json = false }) {
  if (typeof env.__gemini === 'function') return env.__gemini({ prompt, media, json }); // test hook
  const parts = [{ text: prompt }];
  if (media) parts.push({ inline_data: { mime_type: media.mime, data: toBase64(media.bytes) } });
  return generate(env, {
    contents: [{ parts }],
    generationConfig: { temperature: 0.1, ...(json ? { responseMimeType: 'application/json' } : {}) },
  });
}

/** Results page Gemini reads for web searches (Google Search grounding has no free quota, URL reading does). */
export const searchUrl = (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

/** Gemini with the URL-reading tool: the prompt names the page(s) to open. Returns { text }. */
export async function geminiWeb(env, { prompt }) {
  if (typeof env.__gemini === 'function') {
    return { text: await env.__gemini({ prompt, kind: 'url' }) }; // test hook
  }
  const text = await generate(env, {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ url_context: {} }],
    generationConfig: { temperature: 0.2 },
  });
  return { text: text.slice(0, 3000) };
}
