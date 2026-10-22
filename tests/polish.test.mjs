import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, mockWorld, OWNER } from './helpers.mjs';
import { TOOLS, runTool } from '../src/tools.js';
import { handleIncoming } from '../src/handler.js';
import { buildSystemPrompt, activeTopics } from '../src/assistant.js';
import { fastReply } from '../src/fastpath.js';
import { runDueReminders } from '../src/reminders.js';
import { buildBriefing } from '../src/briefing.js';
import { morningOpener, weatherLine } from '../src/extras.js';
import { setState } from '../src/db.js';
import { parseIST } from '../src/time.js';

const NOW = parseIST('2026-10-21 08:00');
const bodies = (sent) => sent.map((b) => b.text?.body).filter(Boolean);

test('prompt only carries the topics the message is about', () => {
  const lean = buildSystemPrompt(NOW, '', 'buy milk');
  const full = buildSystemPrompt(NOW);
  assert.ok(lean.length < full.length * 0.75);
  assert.doesNotMatch(lean, /watch_price/);
  assert.match(lean, /add_reminder/); // core tools always there
  assert.match(lean, /undo_last/);
  assert.match(buildSystemPrompt(NOW, '', 'tell me when TCS crosses 4000'), /watch_price/);
  assert.match(buildSystemPrompt(NOW, '', 'did gym today'), /log_habit/);
  assert.match(buildSystemPrompt(NOW, 'A quiz question is waiting', 'x'), /quiz_done/);
  assert.ok(activeTopics('write a linkedin post').has('work'));
  assert.ok(activeTopics(null).has('markets'));
  assert.match(lean, /Honey/);
  assert.match(lean, /ONE joke/);
});

test('fast path answers plain list requests and ignores everything else', async () => {
  const env = makeEnv();
  assert.match(await fastReply(env, 'tasks', NOW), /Zero open tasks|No open tasks/);
  await TOOLS.add_task(env, { text: 'renew insurance' }, { now: NOW });
  assert.match(await fastReply(env, 'My tasks?', NOW), /1\. renew insurance/);
  assert.match(await fastReply(env, '/tasks', NOW), /renew insurance/);
  assert.equal(await fastReply(env, 'add task: pay rent', NOW), null);
  assert.equal(await fastReply(env, 'what tasks did I finish last week and why', NOW), null);
  await TOOLS.add_reminder(env, { text: 'call Mummy', when: '2026-10-21 18:00', repeat: 'none' }, { now: NOW });
  assert.match(await fastReply(env, 'show my reminders', NOW), /call Mummy/);
  await TOOLS.save_note(env, { text: 'book idea' }, { now: NOW });
  assert.match(await fastReply(env, 'notes', NOW), /book idea/);
  await TOOLS.log_habit(env, { name: 'gym' }, { now: NOW });
  assert.match(await fastReply(env, 'habits', NOW), /✅ gym: 1-day streak/);
});

test('"my tasks" never calls the AI', async () => {
  const sent = mockWorld();
  const env = makeEnv({ __llm: async () => { throw new Error('AI should not be called'); } });
  await TOOLS.add_task(env, { text: 'ship it' }, { now: NOW });
  const r = await handleIncoming(env, { id: 'f1', from: OWNER, type: 'text', text: 'my tasks' }, NOW);
  assert.equal(r.fast, true);
  assert.match(bodies(sent)[0], /ship it/);
});

test('undo removes the last added thing', async () => {
  const env = makeEnv();
  await runTool(env, 'log_expense', { amount: 450, category: 'food' }, { now: NOW });
  const added = await runTool(env, 'add_task', { text: 'oops task' }, { now: NOW });
  assert.equal((await runTool(env, 'undo_last', {}, { now: NOW })).removed, 'task');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM tasks').first()).n, 0);
  assert.ok((await runTool(env, 'undo_last', {}, { now: NOW })).error); // only one level
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM expenses').first()).n, 1);
  await runTool(env, 'log_habit', { name: 'gym' }, { now: NOW });
  assert.equal((await runTool(env, 'undo_last', {}, { now: NOW })).undone, true);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM habit_logs').first()).n, 0);
  assert.ok(added.id);
});

test('snooze re-creates the reminder that just rang', async () => {
  mockWorld();
  const env = makeEnv();
  await setState(env, 'last_inbound_at', NOW - 1000);
  await TOOLS.add_reminder(env, { text: 'drink water', when: '2026-10-21 08:00', repeat: 'daily' }, { now: NOW - 60000 });
  await runDueReminders(env, NOW);
  const s = await TOOLS.snooze_reminder(env, { minutes: 15 }, { now: NOW });
  assert.equal(s.text, 'drink water');
  const row = await env.DB.prepare("SELECT * FROM reminders WHERE id = ?").bind(s.id).first();
  assert.equal(row.due_at, NOW + 15 * 60000);
  assert.equal(row.repeat, 'none');
  const none = await TOOLS.snooze_reminder(makeEnv(), {}, { now: NOW });
  assert.ok(none.error);
});

test('weather tool and briefing line', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('geocoding')) return new Response(JSON.stringify({ results: [{ name: 'Ranchi', latitude: 23.3, longitude: 85.3 }] }));
    if (u.includes('api.open-meteo.com')) {
      return new Response(JSON.stringify({ daily: { temperature_2m_max: [31.4], temperature_2m_min: [22.2], precipitation_probability_max: [70], weather_code: [63] } }));
    }
    return new Response('{}', { status: 500 });
  };
  const env = makeEnv();
  const w = await TOOLS.weather(env, {});
  assert.equal(w.city, 'Ranchi');
  assert.equal(w.high_c, 31);
  assert.match(weatherLine(w), /rainy.*22° to 31°C.*umbrella/);
  await TOOLS.log_habit(env, { name: 'gym', date: '2026-10-20' }, { now: NOW });
  await TOOLS.log_habit(env, { name: 'gym' }, { now: NOW });
  const { text } = await buildBriefing(env, NOW);
  assert.match(text, /Good morning/);
  assert.match(text, /🌤️ Ranchi: rainy/);
  assert.match(text, /Streaks alive: gym 2🔥/);
  assert.ok(text.includes(morningOpener(NOW)));
});

test('briefing still works when weather is down', async () => {
  globalThis.fetch = async () => { throw new Error('offline'); };
  const { text } = await buildBriefing(makeEnv(), NOW);
  assert.match(text, /Good morning/);
  assert.doesNotMatch(text, /🌤️/);
});

test('typing indicator is sent when enabled and never blocks the reply', async () => {
  const sent = mockWorld();
  const env = makeEnv({ TYPING_INDICATOR: 'on', __llm: async () => JSON.stringify({ reply: 'hey' }) });
  await handleIncoming(env, { id: 't1', from: OWNER, type: 'text', text: 'hello there' }, NOW);
  const typing = sent.find((b) => b.status === 'read');
  assert.equal(typing.message_id, 't1');
  assert.equal(typing.typing_indicator.type, 'text');
  assert.ok(sent.some((b) => b.text?.body === 'hey'));
});

test('openers rotate daily', () => {
  assert.notEqual(morningOpener(NOW), morningOpener(NOW + 24 * 3600 * 1000));
});

import { needsTool } from '../src/assistant.js';
test('needsTool catches claimed actions and live numbers without a tool', () => {
  assert.equal(needsTool('add task: renew insurance', "'Renew insurance' added to your task list."), true);
  assert.equal(needsTool('what is the Nifty at?', '24,249.00 (down 0.8%)'), true);
  assert.equal(needsTool('hi', 'Hey! Got it, what is up?'), false);
  assert.equal(needsTool('[Image] receipt', 'Logged 450 already'), false);
  assert.equal(needsTool('tell me a joke', 'Why did the chicken cross the road?'), false);
});
