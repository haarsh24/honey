// Tiny live check of the production chat model and the Gemini fallback. Prints only status/error text.
const url = `${process.env.WORKER_URL}/selftest/ai?token=${encodeURIComponent(process.env.VERIFY_TOKEN)}`;
const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', input: { messages: [{ role: 'user', content: 'say hi' }], max_tokens: 10 } }) });
console.log(`::notice title=workers-ai now::HTTP ${r.status} ${(await r.text()).replace(/\s+/g, ' ').slice(0, 300)}`);
const g = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.GEMINI_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gemini-flash-lite-latest', max_tokens: 50, messages: [{ role: 'user', content: 'say hi' }] }) });
console.log(`::notice title=gemini chat now::HTTP ${g.status} ${(await g.text()).replace(/\s+/g, ' ').slice(0, 200)}`);
