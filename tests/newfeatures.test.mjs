import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, OWNER } from './helpers.mjs';
import { TOOLS } from '../src/tools.js';
import { handleIncoming } from '../src/handler.js';
import { habitNudge, streakOf } from '../src/habits.js';
import { symbolCandidates, checkWatches } from '../src/markets.js';
import { speakable } from '../src/voice.js';
import { runHabitNudge, runDigest, runWatchCheck } from '../src/jobs.js';
import { setState } from '../src/db.js';
import { parseIST } from '../src/time.js';

const NOW = parseIST('2026-10-15 20:00'); // Thursday evening IST

test('habits: streaks, gaps, future dates', async () => {
  const env = makeEnv();
  await TOOLS.log_habit(env, { name: 'Gym', date: '2026-10-13' }, { now: NOW });
  await TOOLS.log_habit(env, { name: 'gym', date: '2026-10-14' }, { now: NOW });
  const r = await TOOLS.log_habit(env, { name: 'gym' }, { now: NOW });
  assert.equal(r.current_streak, 3);
  assert.equal(r.done_today, true);
  assert.equal((await TOOLS.log_habit(env, { name: 'gym', date: '2026-10-16' }, { now: NOW })).error, 'cannot log a habit for a future day');
  await TOOLS.log_habit(env, { name: 'reading', date: '2026-10-10' }, { now: NOW });
  const s = await TOOLS.habit_status(env, {}, { now: NOW });
  assert.equal(s.habits.find((h) => h.habit === 'reading').current_streak, 0);
  assert.equal(streakOf(new Set(['2026-10-14']), '2026-10-15'), 1); // alive until the day ends
  assert.equal((await TOOLS.delete_habit(env, { name: 'reading' })).deleted, true);
});

test('habit nudge only mentions habits not done today', async () => {
  const env = makeEnv();
  await TOOLS.log_habit(env, { name: 'gym', date: '2026-10-14' }, { now: NOW });
  await TOOLS.log_habit(env, { name: 'water', date: '2026-10-15' }, { now: NOW });
  const text = await habitNudge(env, NOW);
  assert.match(text, /gym: 1-day streak/);
  assert.doesNotMatch(text, /water/);
  await TOOLS.log_habit(env, { name: 'gym' }, { now: NOW });
  assert.equal(await habitNudge(env, NOW), null);
});

function marketFetch(prices) {
  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('finance.yahoo.com')) {
      const sym = decodeURIComponent(u.split('/chart/')[1].split('?')[0]);
      return prices[sym] === undefined
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: prices[sym], chartPreviousClose: 100, shortName: sym, currency: 'INR' } }] } }));
    }
    if (u.includes('api.mfapi.in/mf/search')) return new Response(JSON.stringify([{ schemeCode: 1234, schemeName: 'Test Flexi Cap' }, { schemeCode: 5, schemeName: 'Other' }]));
    if (u.includes('api.mfapi.in/mf/1234/latest')) return new Response(JSON.stringify({ meta: { scheme_name: 'Test Flexi Cap' }, data: [{ date: '15-10-2026', nav: '75.5' }] }));
    if (u.includes('graph.facebook.com')) {
      sent.push(init.body instanceof FormData ? { upload: true } : JSON.parse(init.body));
      return new Response(JSON.stringify({ id: 'MEDIA1' }));
    }
    return new Response('{}', { status: 500 });
  };
  return sent;
}

test('symbol candidates', () => {
  assert.deepEqual(symbolCandidates('reliance'), ['RELIANCE.NS', 'RELIANCE.BO', 'RELIANCE']);
  assert.deepEqual(symbolCandidates('nifty'), ['^NSEI']);
  assert.deepEqual(symbolCandidates('TCS.NS'), ['TCS.NS']);
});

test('price_check falls back to BSE; mf_nav returns NAV', async () => {
  marketFetch({ 'ABC.BO': 50 });
  const env = makeEnv();
  const p = await TOOLS.price_check(env, { symbol: 'abc' });
  assert.equal(p.symbol, 'ABC.BO');
  assert.equal(p.change_pct, -50);
  assert.ok((await TOOLS.price_check(env, { symbol: 'nope' })).error);
  const mf = await TOOLS.mf_nav(env, { name: 'test flexi' });
  assert.equal(mf.best_match.nav, 75.5);
  assert.equal(mf.other_matches.length, 1);
});

test('watch_price rejects already-crossed levels, then fires once', async () => {
  marketFetch({ 'TCS.NS': 3000 });
  const env = makeEnv();
  assert.match((await TOOLS.watch_price(env, { target: 'tcs', above: 2900 }, { now: NOW })).error, /already/);
  const w = await TOOLS.watch_price(env, { target: 'tcs', above: 3100, below: 2800 }, { now: NOW });
  assert.equal(w.alerts.length, 2);
  assert.deepEqual(await checkWatches(env, NOW, 'stock'), []);
  marketFetch({ 'TCS.NS': 3120 });
  const fired = await checkWatches(env, NOW, 'stock');
  assert.equal(fired.length, 1);
  assert.match(fired[0], /above ₹3,100.*₹3,120/);
  assert.deepEqual(await checkWatches(env, NOW, 'stock'), []); // fires only once
  assert.equal((await TOOLS.list_watches(env)).watches.length, 1);
  assert.equal((await TOOLS.remove_watch(env, { id: 2 })).removed, true);
});

test('mf watch uses the mf kind and runWatchCheck sends the alert', async () => {
  const sent = marketFetch({});
  const env = makeEnv();
  await setState(env, 'last_inbound_at', NOW - 1000);
  await TOOLS.watch_price(env, { target: 'mf:1234', above: 70 }, { now: NOW }).then((r) => assert.ok(r.error)); // 75.5 already above
  const ok = await TOOLS.watch_price(env, { target: 'mf:1234', above: 80 }, { now: NOW });
  assert.equal(ok.alerts.length, 1);
  assert.deepEqual(await checkWatches(env, NOW, 'stock'), []); // wrong kind
  await env.DB.prepare('UPDATE watches SET level = 75 WHERE id = 1').run();
  const r = await runWatchCheck(env, NOW, 'mf');
  assert.equal(r.fired, 1);
  assert.match(sent.at(-1).text.body, /Test Flexi Cap is above ₹75/);
});

test('news digest: topics, news_now, daily job', async () => {
  const sent = marketFetch({});
  const env = makeEnv({ __gemini: async ({ prompt }) => `- Headline one about ${/"(.+?)"/.exec(prompt)[1]} [Site]\n- Headline two [Site]` });
  assert.ok((await TOOLS.set_news_topics(env, { topics: [] })).error);
  const saved = await TOOLS.set_news_topics(env, { topics: ['AI', 'Ranchi'] });
  assert.deepEqual(saved.topics, ['AI', 'Ranchi']);
  const now = await TOOLS.news_now(env, {});
  assert.match(now.digest, /\*AI\*\n- Headline one about AI/);
  assert.match(now.digest, /\*Ranchi\*/);
  assert.deepEqual(await runDigest(env, NOW), { skipped: 'window-closed' });
  await setState(env, 'last_inbound_at', NOW - 1000);
  assert.deepEqual(await runDigest(env, NOW), { sent: true });
  assert.match(sent.at(-1).text.body, /news digest/);
  assert.deepEqual(await runDigest(env, NOW), { skipped: 'already-sent' });
  await TOOLS.stop_news(env);
  assert.deepEqual((await TOOLS.news_now(env, {})).error.length > 0, true);
});

test('habit nudge job respects the free window', async () => {
  const sent = marketFetch({});
  const env = makeEnv();
  await TOOLS.log_habit(env, { name: 'gym', date: '2026-10-14' }, { now: NOW });
  assert.deepEqual(await runHabitNudge(env, NOW), { skipped: 'window-closed' });
  await setState(env, 'last_inbound_at', NOW - 1000);
  assert.deepEqual(await runHabitNudge(env, NOW), { sent: true });
  assert.match(sent.at(-1).text.body, /gym/);
});

test('work helpers: ideas, style, standup data', async () => {
  const env = makeEnv();
  const a = await TOOLS.save_idea(env, { kind: 'linkedin', text: 'Why my bot costs Rs 0' }, { now: NOW });
  await TOOLS.save_idea(env, { kind: 'standup', text: 'Fixed webhook' }, { now: NOW });
  assert.equal((await TOOLS.list_ideas(env, { kind: 'linkedin' })).ideas.length, 1);
  assert.equal((await TOOLS.list_ideas(env, { query: 'webhook' })).ideas[0].kind, 'standup');
  for (let i = 0; i < 7; i++) await TOOLS.save_style(env, { text: `sample ${i}` });
  const style = await TOOLS.get_style(env);
  assert.equal(style.own_samples.length, 5);
  assert.equal(style.own_samples.at(-1), 'sample 6');
  assert.match(style.default_style, /punchy/);
  await TOOLS.add_task(env, { text: 'ship it' }, { now: NOW });
  const standup = await TOOLS.standup_data(env, {}, { now: NOW });
  assert.deepEqual(standup.standup_notes, ['Fixed webhook']);
  assert.deepEqual(standup.open_tasks, ['ship it']);
  assert.equal((await TOOLS.delete_idea(env, { id: a.id })).deleted, true);
});

test('speakable keeps English, drops emoji/links, skips Hindi and long text', () => {
  assert.equal(speakable('Done ✅ **Reminder** set for 6 pm 😎 https://x.com/a'), 'Done Reminder set for 6 pm');
  assert.equal(speakable('ठीक है, रिमाइंडर सेट हो गया'), null);
  assert.equal(speakable('a'.repeat(700)), null);
  assert.equal(speakable('ok'), null);
});

test('voice note gets a text reply and a spoken reply; /voicereply off disables it', async () => {
  const sent = marketFetch({});
  // A media GET is needed by handleMedia; patch the fetch to serve it as well.
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://media.example/')) return new Response(new Uint8Array([1, 2]));
    if (u.includes('graph.facebook.com') && !init.method) return new Response(JSON.stringify({ url: 'https://media.example/M1', mime_type: 'audio/ogg', file_size: 2 }));
    return base(url, init);
  };
  const env = makeEnv({
    __gemini: async () => 'what is two plus two',
    __tts: async () => new Uint8Array([7, 7, 7]),
    __llm: async () => JSON.stringify({ reply: 'Four, obviously.' }),
  });
  await handleIncoming(env, { id: 'a1', from: OWNER, type: 'audio', media: { id: 'M1', mime: 'audio/ogg' } }, NOW);
  assert.ok(sent.some((b) => b.upload), 'audio uploaded');
  assert.ok(sent.some((b) => b.type === 'audio' && b.audio.id === 'MEDIA1'), 'audio message sent');
  assert.ok(sent.some((b) => b.text?.body?.includes('Four, obviously')), 'text reply sent');

  await handleIncoming(env, { id: 'c1', from: OWNER, type: 'text', text: '/voicereply off' }, NOW);
  const before = sent.length;
  await handleIncoming(env, { id: 'a2', from: OWNER, type: 'audio', media: { id: 'M1', mime: 'audio/ogg' } }, NOW);
  const after = sent.slice(before);
  assert.ok(!after.some((b) => b.upload || b.type === 'audio'), 'no voice reply when off');
  assert.ok(after.some((b) => b.text));
});

test('geminiWeb falls back to the lighter model when the first is over quota', async () => {
  const { geminiWeb } = await import('../src/gemini.js');
  const models = [];
  globalThis.fetch = async (url) => {
    const model = /models\/(.+?):/.exec(String(url))[1];
    models.push(model);
    return model === 'gemini-flash-latest'
      ? new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 })
      : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Rs 106' }] } }] }));
  };
  const r = await geminiWeb({ GEMINI_KEY: 'k' }, { prompt: 'x' });
  assert.equal(r.text, 'Rs 106');
  assert.deepEqual(models, ['gemini-flash-latest', 'gemini-flash-lite-latest']);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 400 });
  await assert.rejects(geminiWeb({ GEMINI_KEY: 'k' }, { prompt: 'x' }), /400/);
});

test('synthesize accepts MP3 from a raw response and rejects WAV', async () => {
  const { synthesize, looksLikeMp3 } = await import('../src/voice.js');
  const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0]);
  const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0]);
  assert.ok(looksLikeMp3(mp3));
  assert.ok(looksLikeMp3(new Uint8Array([0xff, 0xfb, 0x90, 0])));
  assert.ok(!looksLikeMp3(wav));
  const calls = [];
  const envMp3 = { AI: { run: async (model, input, opts) => { calls.push({ model, input, opts }); return new Response(mp3); } } };
  assert.deepEqual([...(await synthesize(envMp3, 'hello'))], [...mp3]);
  assert.equal(calls[0].model, '@cf/deepgram/aura-1');
  assert.equal(calls[0].input.encoding, 'mp3');
  assert.equal(calls[0].opts.returnRawResponse, true);
  await assert.rejects(synthesize({ AI: { run: async () => new Response(wav) } }, 'hello'), /MP3/);
});
