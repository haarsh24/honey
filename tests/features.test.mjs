import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, mockWorld, scriptedLLM, OWNER } from './helpers.mjs';
import { TOOLS, evaluate } from '../src/tools.js';
import { handleIncoming } from '../src/handler.js';
import { runJournalPrompt, runWeekly, buildBriefing } from '../src/briefing.js';
import { runDrill, quizNow } from '../src/learning.js';
import { getState, setState } from '../src/db.js';
import { parseIST } from '../src/time.js';

const NOW = parseIST('2026-10-15 10:00'); // Thursday
const bodies = (sent) => sent.map((b) => b.text?.body ?? b.template?.components[0].parameters[0].text);
const say = (env, text, id, at = NOW) => handleIncoming(env, { id, from: OWNER, type: 'text', text }, at);

test('calculator', () => {
  assert.equal(evaluate('2*(3+4)^2 - 10/4'), 95.5);
  assert.equal(evaluate('1,200 x 3'), 3600);
  assert.equal(evaluate('-(2+3)'), -5);
  assert.throws(() => evaluate('1/0'));
  assert.throws(() => evaluate('process.exit()'));
  assert.throws(() => evaluate('2 +'));
});

test('calc_date: weekday, difference and adding days', async () => {
  const env = makeEnv();
  const r = await TOOLS.calc_date(env, { date: '2027-08-15', date2: '2027-12-25' }, { now: NOW });
  assert.match(r.date, /^2027-08-15 \(Sunday\)/);
  assert.equal(r.days_between, 132);
  const t = await TOOLS.calc_date(env, { add_days: 10 }, { now: NOW });
  assert.match(t.after_adding, /^2026-10-25 \(Sunday\)/);
  assert.ok((await TOOLS.calc_date(env, { date: 'nope' }, { now: NOW })).error);
});

test('convert_currency uses live rates and handles failure', async () => {
  globalThis.fetch = async (url) => {
    assert.match(String(url), /base=USD&symbols=INR/);
    return new Response(JSON.stringify({ date: '2026-10-14', rates: { INR: 88.5 } }));
  };
  const env = makeEnv();
  const r = await TOOLS.convert_currency(env, { amount: 20, from: 'usd', to: 'inr' });
  assert.equal(r.result, 1770);
  globalThis.fetch = async () => { throw new Error('down'); };
  assert.ok((await TOOLS.convert_currency(env, { amount: 1, from: 'USD', to: 'INR' })).error);
  assert.ok((await TOOLS.convert_currency(env, { amount: 1, from: 'US', to: 'INR' })).error);
});

test('meeting notes: one call saves a note and tasks', async () => {
  const env = makeEnv();
  const r = await TOOLS.save_meeting(env, { title: 'Roadmap sync', summary: 'Agreed Q4 scope.', action_items: ['Send deck', 'Book room', ''] }, { now: NOW });
  assert.equal(r.tasks_added, 2);
  assert.match((await env.DB.prepare('SELECT text FROM notes').first()).text, /Meeting \(2026-10-15\) Roadmap sync/);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM tasks').first()).n, 2);
});

test('long voice note carries the meeting-notes hint', async () => {
  mockWorld({ media: { M1: { mime: 'audio/ogg', bytes: new Uint8Array([1]) } } });
  let seen;
  const env = makeEnv({
    __gemini: async () => 'we met about the roadmap '.repeat(20),
    __llm: async (m) => { seen = m.at(-1).content; return JSON.stringify({ reply: 'ok' }); },
  });
  await handleIncoming(env, { id: 'v', from: OWNER, type: 'audio', media: { id: 'M1', mime: 'audio/ogg' } }, NOW);
  assert.match(seen, /^\[Long voice note/);
});

test('journal: save, search by date, keyword, and meaning fallback', async () => {
  const env = makeEnv();
  await TOOLS.save_journal(env, { text: 'Went to the gym and felt great' }, { now: parseIST('2026-10-13 21:00') });
  await TOOLS.save_journal(env, { text: 'Argued with landlord about rent' }, { now: parseIST('2026-10-14 21:00') });
  assert.equal((await TOOLS.search_journal(env, { date: '2026-10-13' })).entries[0].text, 'Went to the gym and felt great');
  assert.equal((await TOOLS.search_journal(env, { query: 'landlord' })).count, 1);
  const fallback = await TOOLS.search_journal(env, { query: 'workout exercise' });
  assert.equal(fallback.count, 0);
  assert.equal(fallback.recent_entries.length, 2);
});

test('nightly journal prompt: window rules, once a day, reply is routed to the assistant', async () => {
  let sent = mockWorld();
  const env = makeEnv();
  assert.deepEqual(await runJournalPrompt(env, NOW), { skipped: 'window-closed' });
  await setState(env, 'last_inbound_at', NOW - 3600e3);
  assert.deepEqual(await runJournalPrompt(env, NOW), { sent: true });
  assert.match(bodies(sent)[0], /Day wrap-up/);
  assert.deepEqual(await runJournalPrompt(env, NOW + 60000), { skipped: 'already-sent' });

  let system;
  env.__llm = async (m) => {
    system = m[0].content;
    return JSON.stringify({ tool: 'save_journal', args: { text: 'Great day, shipped the bot' } });
  };
  // second step: reply
  let calls = 0;
  env.__llm = async (m) => {
    calls++;
    system ??= m[0].content;
    return calls === 1 ? JSON.stringify({ tool: 'save_journal', args: { text: 'Great day, shipped the bot' } }) : JSON.stringify({ reply: 'Saved! Proud of you 🎉' });
  };
  await say(env, 'shipped the bot today, great day', 'j1', NOW + 120000);
  assert.match(system, /nightly journal prompt/);
  assert.equal((await env.DB.prepare('SELECT text FROM journal').first()).text, 'Great day, shipped the bot');
  assert.equal(await getState(env, 'journal_pending'), '');
  assert.match(bodies(sent).at(-1), /Proud of you/);
});

test('/journal off stops the nudge', async () => {
  mockWorld();
  const env = makeEnv();
  await setState(env, 'last_inbound_at', NOW - 1000);
  await say(env, '/journal off', 'j2');
  assert.deepEqual(await runJournalPrompt(env, NOW), { skipped: 'off' });
});

test('countdowns show in the briefing', async () => {
  const env = makeEnv();
  const r = await TOOLS.add_countdown(env, { label: 'Goa trip', date: '2026-10-27' }, { now: NOW });
  assert.equal(r.days_to_go, 12);
  const { text } = await buildBriefing(env, parseIST('2026-10-15 08:00'));
  assert.match(text, /⏳ Goa trip: 12 days to go/);
  assert.ok((await TOOLS.add_countdown(env, { label: 'x', date: '2026-01-01' }, { now: NOW })).error);
});

test('quiz: topic, generation, grading context, scoring and daily drill rules', async () => {
  const sent = mockWorld();
  const env = makeEnv({ __llm: async () => JSON.stringify({ question: 'What does INNER JOIN return?', answer: 'Only rows with matches in both tables.' }) });
  assert.match(await quizNow(env, NOW), /Tell me what you want to learn/);
  await TOOLS.learn_topic(env, { topic: 'SQL joins' }, { now: NOW });
  await setState(env, 'last_inbound_at', NOW - 1000);
  assert.deepEqual(await runDrill(env, NOW), { sent: true });
  assert.match(bodies(sent)[0], /Brain-gym time \(SQL joins\)[\s\S]*INNER JOIN/);
  assert.deepEqual(await runDrill(env, NOW + 60000), { skipped: 'already-sent' });

  let system;
  let calls = 0;
  env.__llm = async (m) => {
    calls++;
    system ??= m[0].content;
    return calls === 1 ? JSON.stringify({ tool: 'quiz_done', args: { correct: true } }) : JSON.stringify({ reply: 'Nailed it 🎯' });
  };
  await say(env, 'rows that match in both tables', 'q1', NOW + 3600e3);
  assert.match(system, /Question: What does INNER JOIN return\?/);
  assert.equal(await getState(env, 'quiz_pending'), '');
  assert.deepEqual(JSON.parse(await getState(env, 'quiz_stats')), { correct: 1, total: 1 });
});

test('quiz: no drill when the window is closed or no topic', async () => {
  mockWorld();
  const env = makeEnv({ __llm: async () => JSON.stringify({ question: 'q', answer: 'a' }) });
  assert.deepEqual(await runDrill(env, NOW), { skipped: 'no-topic' });
  await TOOLS.learn_topic(env, { topic: 'Spanish' }, { now: NOW });
  assert.deepEqual(await runDrill(env, NOW), { skipped: 'window-closed' });
});

test('weekly review includes tasks, journal, quiz score and an AI suggestion', async () => {
  const sent = mockWorld();
  const env = makeEnv({ __llm: async () => 'Keep the streak going and drink more water.' });
  const t = parseIST('2026-10-16 12:00');
  await setState(env, 'last_inbound_at', parseIST('2026-10-18 19:00'));
  await TOOLS.add_task(env, { text: 'renew insurance' }, { now: t });
  await TOOLS.complete_task(env, { id: 1 }, { now: t });
  await TOOLS.save_journal(env, { text: 'good week' }, { now: t });
  await TOOLS.log_expense(env, { amount: 250, category: 'food' }, { now: t });
  await runWeekly(env, parseIST('2026-10-18 20:00'));
  const text = bodies(sent)[0];
  assert.match(text, /Spending: ₹250/);
  assert.match(text, /Tasks: 1 finished, 0 still open/);
  assert.match(text, /✅ renew insurance/);
  assert.match(text, /Journal entries: 1/);
  assert.match(text, /💡 Keep the streak going/);
});
