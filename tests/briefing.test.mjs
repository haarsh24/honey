import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, mockWorld, OWNER, scriptedLLM } from './helpers.mjs';
import { runBriefing, runWeekly, buildBriefing } from '../src/briefing.js';
import { handleIncoming } from '../src/handler.js';
import { TOOLS } from '../src/tools.js';
import { parseIST } from '../src/time.js';
import worker from '../src/index.js';

const MORNING = parseIST('2026-10-15 08:00');
const bodies = (sent) => sent.map((b) => b.text?.body ?? b.template?.components[0].parameters[0].text);

async function seed(env) {
  const now = parseIST('2026-10-14 20:00');
  await TOOLS.log_expense(env, { amount: 300, category: 'food' }, { now });
  await TOOLS.log_expense(env, { amount: 120, category: 'travel' }, { now });
  await TOOLS.add_task(env, { text: 'renew insurance' }, { now });
  await env.DB.prepare("INSERT INTO reminders (text, due_at, repeat, status, created_at) VALUES ('call mom', ?, 'none', 'pending', 0)").bind(parseIST('2026-10-15 09:30')).run();
}

test('briefing content', async () => {
  const env = makeEnv();
  await seed(env);
  const { text } = await buildBriefing(env, MORNING);
  assert.match(text, /09:30 call mom/);
  assert.match(text, /renew insurance/);
  assert.match(text, /Yesterday you spent ₹420/);
});

test('briefing: text inside the window, template outside, once per day, can be turned off', async () => {
  let sent = mockWorld();
  const env = makeEnv();
  await seed(env);
  await runBriefing(env, MORNING); // no inbound ever -> template
  assert.equal(sent[0].type, 'template');
  assert.match(sent[0].template.components[0].parameters[0].text, /Good morning/);
  assert.deepEqual(await runBriefing(env, MORNING + 60000), { skipped: 'already-sent' });

  sent = mockWorld();
  const env2 = makeEnv();
  await env2.DB.prepare("INSERT INTO state (key, value) VALUES ('last_inbound_at', ?)").bind(String(MORNING - 3600e3)).run();
  await runBriefing(env2, MORNING);
  assert.equal(sent[0].type, 'text');

  sent = mockWorld({});
  const env3 = makeEnv({ __llm: scriptedLLM([{ reply: 'x' }]) });
  await handleIncoming(env3, { id: 'b1', from: OWNER, type: 'text', text: '/briefing off' }, MORNING);
  sent.length = 0;
  assert.deepEqual(await runBriefing(env3, MORNING), { skipped: 'off' });
  assert.equal(sent.length, 0);
});

test('weekly summary only when something was spent', async () => {
  const sent = mockWorld();
  const env = makeEnv();
  const sunday = parseIST('2026-10-18 20:00');
  assert.deepEqual(await runWeekly(env, sunday), { skipped: 'no-expenses' });
  await TOOLS.log_expense(env, { amount: 500, category: 'food' }, { now: parseIST('2026-10-16 12:00') });
  await runWeekly(env, sunday);
  assert.match(bodies(sent)[0], /Weekly spending: ₹500 across 1 entries. Top: food ₹500/);
});

test('cron schedule triggers briefing at 02:30 UTC and tolerates seconds', async () => {
  const sent = mockWorld();
  const env = makeEnv();
  const tasks = [];
  const ctx = { waitUntil: (p) => tasks.push(p) };
  const utc = Date.UTC(2026, 9, 15, 2, 30);
  await worker.scheduled({ scheduledTime: Math.floor(utc / 1000) }, env, ctx); // seconds
  await Promise.all(tasks);
  assert.ok(sent.some((b) => /Good morning/.test(JSON.stringify(b))));
});

test('search_notes falls back to recent notes when no keyword matches', async () => {
  const env = makeEnv();
  await TOOLS.save_note(env, { text: 'Rahul suggested Barbeque Nation in Pune' }, { now: 1 });
  const r = await TOOLS.search_notes(env, { query: 'restaurant recommendation' });
  assert.equal(r.count, 0);
  assert.equal(r.recent_notes.length, 1);
  const hit = await TOOLS.search_notes(env, { query: 'barbeque' });
  assert.equal(hit.count, 1);
});
