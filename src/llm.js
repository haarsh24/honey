// One function the rest of the app calls: chat(env, messages) -> string.
// Providers are tried in order (env.LLM_PROVIDERS). A provider without a key is skipped.
// To add another OpenAI-compatible provider, copy the `groq` block below.

const TIMEOUT_MS = 25000;
const MAX_TOKENS = 600;

async function openAICompatible({ url, key, model, messages, name }) {
  if (!key) throw new Error(`${name} is not configured`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: MAX_TOKENS }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`${name} ${response.status}: ${data?.error?.message ?? 'request failed'}`);
    }
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error(`${name} returned no text`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function workersAI(env, messages) {
  if (!env.AI) throw new Error('workers-ai binding missing');
  const model = env.LLM_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const out = await env.AI.run(model, { messages, max_tokens: MAX_TOKENS, temperature: 0.2 });
  let text =
    typeof out === 'string'
      ? out
      : (out?.response ?? out?.choices?.[0]?.message?.content ?? out?.result?.response);
  if (text && typeof text === 'object') text = JSON.stringify(text);
  if (typeof text !== 'string' || !text.trim()) throw new Error('workers-ai returned no text');
  return text;
}

const PROVIDERS = {
  'workers-ai': (env, messages) => workersAI(env, messages),
  groq: (env, messages) =>
    openAICompatible({
      name: 'groq',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      key: env.GROQ_KEY,
      model: env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      messages,
    }),
  gemini: (env, messages) =>
    openAICompatible({
      name: 'gemini',
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      key: env.GEMINI_KEY,
      model: env.GEMINI_MODEL || 'gemini-flash-latest',
      messages,
    }),
};

export async function chat(env, messages) {
  if (typeof env.__llm === 'function') return env.__llm(messages); // test hook
  const order = (env.LLM_PROVIDERS || 'workers-ai,groq')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const errors = [];
  for (const name of order) {
    const provider = PROVIDERS[name];
    if (!provider) {
      errors.push(`${name}: unknown provider`);
      continue;
    }
    try {
      return await provider(env, messages);
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
    }
  }
  throw new Error(`All AI providers failed. ${errors.join(' | ')}`);
}
