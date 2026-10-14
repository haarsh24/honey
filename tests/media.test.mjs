import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, mockWorld, scriptedLLM, OWNER } from './helpers.mjs';
import { handleIncoming } from '../src/handler.js';
import { extractMessages } from '../src/index.js';
import { gemini, toBase64 } from '../src/gemini.js';
import { parseIST } from '../src/time.js';

const NOW = parseIST('2026-10-15 10:00');
const bodies = (sent) => sent.map((b) => b.text?.body ?? JSON.stringify(b));

test('extractMessages keeps media details', () => {
  const payload = {
    entry: [{ changes: [{ value: { messages: [
      { id: 'a', from: '1', type: 'audio', audio: { id: 'M1', mime_type: 'audio/ogg; codecs=opus' } },
      { id: 'b', from: '1', type: 'image', image: { id: 'M2', mime_type: 'image/jpeg', caption: 'lunch' } },
      { id: 'c', from: '1', type: 'document', document: { id: 'M3', mime_type: 'application/pdf', filename: 'bill.pdf' } },
    ] } }] }],
  };
  const [a, b, c] = extractMessages(payload);
  assert.equal(a.media.id, 'M1');
  assert.equal(b.media.caption, 'lunch');
  assert.equal(c.media.filename, 'bill.pdf');
});

test('voice note: transcript runs through the assistant and creates a reminder', async () => {
  const sent = mockWorld({ media: { M1: { mime: 'audio/ogg; codecs=opus', bytes: new Uint8Array([9, 9]) } } });
  const env = makeEnv({
    __gemini: async ({ media }) => {
      assert.equal(media.mime, 'audio/ogg');
      return 'remind me to call dad tomorrow at 6 pm';
    },
    __llm: scriptedLLM([
      { tool: 'add_reminder', args: { text: 'call dad', when: '2026-10-16 18:00', repeat: 'none' } },
      { reply: 'Done, reminder set for tomorrow 6 pm.' },
    ]),
  });
  await handleIncoming(env, { id: 'v1', from: OWNER, type: 'audio', media: { id: 'M1', mime: 'audio/ogg; codecs=opus' } }, NOW);
  const row = await env.DB.prepare('SELECT * FROM reminders').first();
  assert.equal(row.text, 'call dad');
  const reply = bodies(sent).at(-1);
  assert.match(reply, /remind me to call dad/);
  assert.match(reply, /reminder set/i);
});

test('voice note with no speech', async () => {
  const sent = mockWorld({ media: { M1: { mime: 'audio/ogg', bytes: new Uint8Array([1]) } } });
  const env = makeEnv({ __gemini: async () => 'NO_SPEECH' });
  await handleIncoming(env, { id: 'v2', from: OWNER, type: 'audio', media: { id: 'M1', mime: 'audio/ogg' } }, NOW);
  assert.match(bodies(sent)[0], /silence/);
});

test('receipt photo logs an expense directly', async () => {
  const sent = mockWorld({ media: { M2: { mime: 'image/jpeg', bytes: new Uint8Array([1, 2]) } } });
  const env = makeEnv({
    __gemini: async () => JSON.stringify({ type: 'receipt', merchant: 'Haldirams', amount: 450.5, currency: 'INR', date: '2026-10-14', category: 'food', summary: 'x', text: '' }),
  });
  await handleIncoming(env, { id: 'i1', from: OWNER, type: 'image', media: { id: 'M2', mime: 'image/jpeg', caption: 'dinner' } }, NOW);
  const row = await env.DB.prepare('SELECT * FROM expenses').first();
  assert.equal(row.amount, 450.5);
  assert.equal(row.category, 'food');
  assert.equal(row.note, 'Haldirams - dinner');
  assert.match(bodies(sent)[0], /Logged ₹450.5 under food \(Haldirams\) on 2026-10-14/);
});

test('foreign-currency receipt is not logged', async () => {
  const sent = mockWorld({ media: { M2: { mime: 'image/jpeg', bytes: new Uint8Array([1]) } } });
  const env = makeEnv({ __gemini: async () => JSON.stringify({ type: 'receipt', amount: 12, currency: 'USD', category: 'food' }) });
  await handleIncoming(env, { id: 'i2', from: OWNER, type: 'image', media: { id: 'M2', mime: 'image/jpeg' } }, NOW);
  assert.equal(await env.DB.prepare('SELECT * FROM expenses').first(), null);
  assert.match(bodies(sent)[0], /USD 12/);
});

test('non-receipt photo goes to the assistant as [Image] text', async () => {
  const sent = mockWorld({ media: { M2: { mime: 'image/jpeg', bytes: new Uint8Array([1]) } } });
  let seen;
  const env = makeEnv({
    __gemini: async () => JSON.stringify({ type: 'other', amount: 0, summary: 'A whiteboard with a todo list', text: 'buy milk' }),
    __llm: async (messages) => { seen = messages.at(-1).content; return JSON.stringify({ reply: 'It is a todo list. Save it?' }); },
  });
  await handleIncoming(env, { id: 'i3', from: OWNER, type: 'image', media: { id: 'M2', mime: 'image/jpeg' } }, NOW);
  assert.match(seen, /^\[Image\] A whiteboard/);
  assert.match(bodies(sent)[0], /todo list/);
});

test('PDF: summary plus automatic reminder for a future deadline, none for past', async () => {
  const sent = mockWorld({ media: { M3: { mime: 'application/pdf', bytes: new Uint8Array([1]) } } });
  let seen;
  const env = makeEnv({
    __gemini: async () => JSON.stringify({
      summary: 'Electricity bill for September.',
      deadlines: [{ date: '2026-10-20', what: 'Electricity bill due Rs 1,240' }, { date: '2026-09-01', what: 'Old thing' }],
      amounts: 'Rs 1,240',
    }),
    __llm: async (messages) => { seen = messages.at(-1).content; return JSON.stringify({ reply: 'Bill is Rs 1,240, due 20 Oct. Reminder set.' }); },
  });
  await handleIncoming(env, { id: 'd1', from: OWNER, type: 'document', media: { id: 'M3', mime: 'application/pdf', filename: 'bill.pdf' } }, NOW);
  const rows = (await env.DB.prepare('SELECT * FROM reminders').all()).results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].due_at, parseIST('2026-10-20 09:00'));
  assert.match(seen, /Reminders already created automatically/);
  assert.match(bodies(sent)[0], /Reminder set/);
});

test('unsupported document, too-large file, missing key', async () => {
  let sent = mockWorld({});
  let env = makeEnv();
  await handleIncoming(env, { id: 'x1', from: OWNER, type: 'document', media: { id: 'Z', mime: 'application/zip' } }, NOW);
  assert.match(bodies(sent)[0], /PDFs and images/);

  sent = mockWorld({ media: { Big: { mime: 'audio/ogg', bytes: new Uint8Array(10) } } });
  const orig = globalThis.fetch;
  globalThis.fetch = async (u, i) => {
    const r = await orig(u, i);
    if (String(u).endsWith('/Big') && !i?.method) return new Response(JSON.stringify({ url: 'https://media.example/Big', mime_type: 'audio/ogg', file_size: 99_000_000 }));
    return r;
  };
  env = makeEnv({ __gemini: async () => 'x' });
  await handleIncoming(env, { id: 'x2', from: OWNER, type: 'audio', media: { id: 'Big', mime: 'audio/ogg' } }, NOW);
  assert.match(bodies(sent)[0], /too large/);

  sent = mockWorld({ media: { M1: { mime: 'audio/ogg', bytes: new Uint8Array([1]) } } });
  env = makeEnv(); // no GEMINI_KEY and no test hook
  await handleIncoming(env, { id: 'x3', from: OWNER, type: 'audio', media: { id: 'M1', mime: 'audio/ogg' } }, NOW);
  assert.match(bodies(sent)[0], /GEMINI_KEY/);
});

test('gemini() builds the native request', async () => {
  let call;
  globalThis.fetch = async (url, init) => {
    call = { url: String(url), init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hello' }] } }] }));
  };
  const out = await gemini({ GEMINI_KEY: 'k', GEMINI_MODEL: 'gemini-test' }, { prompt: 'p', media: { bytes: new Uint8Array([104, 105]), mime: 'audio/ogg' }, json: true });
  assert.equal(out, 'hello');
  assert.match(call.url, /models\/gemini-test:generateContent$/);
  assert.equal(call.init.headers['x-goog-api-key'], 'k');
  assert.equal(call.body.contents[0].parts[1].inline_data.data, 'aGk=');
  assert.equal(call.body.generationConfig.responseMimeType, 'application/json');
  assert.equal(toBase64(new Uint8Array([104, 105])), 'aGk=');
});
