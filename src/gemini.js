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

/**
 * Gemini with a built-in web tool: Google Search or URL reading.
 * kind: 'search' | 'url'. Returns { text, sources: [{title, url}] }.
 */
export async function geminiWeb(env, { prompt, kind }) {
  if (typeof env.__gemini === 'function') {
    return { text: await env.__gemini({ prompt, kind }), sources: [] }; // test hook
  }
  if (!env.GEMINI_KEY) {
    const error = new Error('GEMINI_KEY is not set');
    error.code = 'NO_KEY';
    throw error;
  }
  const model = env.GEMINI_MODEL || 'gemini-flash-latest';
  const tool = kind === 'url' ? { url_context: {} } : { google_search: {} };
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
          tools: [tool],
          generationConfig: { temperature: 0.2 },
        }),
        signal: controller.signal,
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`gemini ${response.status}: ${data?.error?.message ?? 'request failed'}`);
    const candidate = data?.candidates?.[0] ?? {};
    const text = (candidate.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
    if (!text) throw new Error('gemini returned no text');
    const seen = new Set();
    const sources = [];
    for (const chunk of candidate.groundingMetadata?.groundingChunks ?? []) {
      const web = chunk.web;
      if (web?.uri && !seen.has(web.uri) && sources.length < 3) {
        seen.add(web.uri);
        sources.push({ title: web.title ?? '', url: web.uri });
      }
    }
    return { text: text.slice(0, 3000), sources };
  } finally {
    clearTimeout(timer);
  }
}
