// Shows the raw Gemini chat response shape so empty replies can be diagnosed. Prints no secrets.
const key = process.env.GEMINI_KEY;
for (const extra of [{}, { reasoning_effort: 'low' }, { reasoning_effort: 'none' }]) {
  for (const model of ['gemini-flash-latest', 'gemini-flash-lite-latest']) {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1500, temperature: 0.35, messages: [{ role: 'system', content: 'Reply with JSON only like {"reply":"..."}' }, { role: 'user', content: 'say hi' }], ...extra }),
    });
    const t = await r.text();
    console.log(`::notice title=gemini probe ${model} ${JSON.stringify(extra)}::HTTP ${r.status} ${t.replace(/\s+/g, ' ').slice(0, 380)}`);
  }
}
