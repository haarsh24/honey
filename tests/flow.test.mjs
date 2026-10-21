import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, mockFetch, scriptedLLM, OWNER } from './helpers.mjs';
import { handleIncoming } from '../src/handler.js';
import { runDueReminders } from '../src/reminders.js';
import { TOOLS } from '../src/tools.js';
import { parseIST } from '../src/time.js';
import { getState } from '../src/db.js';

const NOW = parseIST('2026-10-15 10:00');
const msg = (text, id = 'm1', from = OWNER) => ({ id, from, type: 'text', text });
const sent = (calls) => calls.map((c) => c.body);

test('tool call then reply creates a reminder', async () => {
  const calls = mockFetch();
  const env = makeEnv({
    __llm: scriptedLLM([
      { tool: 'add_reminder', args: { text: 'pay rent', when: '2026-10-16 09:00', repeat: 'none' } },
      { reply: 'Reminder set for tomorrow 9am.' },
    ]),
  });
  await handleIncoming(env, msg('remind me to pay rent tomorrow 9am'), NOW);
  const row = await env.DB.prepare('SELECT * FROM reminders').first();
  assert.equal(row.text, 'pay rent');
  assert.equal(row.due_at, parseIST('2026-10-16 09:00'));
  assert.equal(sent(calls).at(-1).text.body, 'Reminder set for tomorrow 9am.');
  assert.equal(sent(calls).at(-1).to, OWNER);
});

test('non-owner ignored, duplicate ignored', async () => {
  const calls = mockFetch();
  const env = makeEnv({ __llm: scriptedLLM([{ reply: 'hello' }]) });
  await handleIncoming(env, msg('hi', 'a', '911111111111'), NOW);
  assert.equal(calls.length, 0);
  await handleIncoming(env, msg('hi', 'b'), NOW);
  await handleIncoming(env, msg('hi', 'b'), NOW);
  assert.equal(calls.length, 1);
});

test('/help works without the LLM', async () => {
  const calls = mockFetch();
  const env = makeEnv();
  await handleIncoming(env, msg('/help'), NOW);
  assert.match(sent(calls)[0].text.body, /Reminders/);
});

test('LLM failure gives a friendly message', async () => {
  const calls = mockFetch();
  const env = makeEnv({ __llm: async () => { throw new Error('boom'); } });
  await handleIncoming(env, msg('hi'), NOW);
  assert.match(sent(calls)[0].text.body, /try again/i);
});

test('expense summary totals by category', async () => {
  const env = makeEnv();
  const ctx = { now: NOW };
  await TOOLS.log_expense(env, { amount: 100, category: 'Food' }, ctx);
  await TOOLS.log_expense(env, { amount: 50.5, category: 'food' }, ctx);
  await TOOLS.log_expense(env, { amount: 300, category: 'travel' }, ctx);
  const s = await TOOLS.expense_summary(env, { period: 'today' }, ctx);
  assert.equal(s.total, 450.5);
  assert.equal(s.by_category[0].category, 'travel');
  assert.deepEqual(await TOOLS.log_expense(env, { amount: -5 }, ctx), { error: 'amount must be a positive number' });
});

test('add_reminder rejects past time', async () => {
  const env = makeEnv();
  const r = await TOOLS.add_reminder(env, { text: 'x', when: '2026-10-14 09:00' }, { now: NOW });
  assert.ok(r.error);
});

async function addDue(env, repeat = 'none', text = 'call mom') {
  await env.DB.prepare("INSERT INTO reminders (text, due_at, repeat, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
    .bind(text, NOW - 1000, repeat, NOW - 100000).run();
}

test('cron: in-window sends text and marks sent', async () => {
  const calls = mockFetch();
  const env = makeEnv();
  await env.DB.prepare("INSERT INTO state (key, value) VALUES ('last_inbound_at', ?)").bind(String(NOW - 3600e3)).run();
  await addDue(env);
  await runDueReminders(env, NOW);
  assert.equal(sent(calls)[0].type, 'text');
  assert.match(sent(calls)[0].text.body, /^⏰ Reminder: call mom\n\(Reply "snooze 10"/);
  assert.equal((await env.DB.prepare('SELECT status FROM reminders').first()).status, 'sent');
});

test('cron: out-of-window uses sanitized template', async () => {
  const calls = mockFetch();
  const env = makeEnv();
  await addDue(env, 'none', 'line1\nline2');
  await runDueReminders(env, NOW);
  const b = sent(calls)[0];
  assert.equal(b.type, 'template');
  assert.equal(b.template.name, 'reminder');
  assert.ok(!b.template.components[0].parameters[0].text.includes('\n'));
});

test('cron: 131047 falls back to template', async () => {
  const calls = mockFetch((body) =>
    body.type === 'text' ? { status: 400, json: { error: { code: 131047, message: 're-engage' } } } : {},
  );
  const env = makeEnv();
  await env.DB.prepare("INSERT INTO state (key, value) VALUES ('last_inbound_at', ?)").bind(String(NOW - 3600e3)).run();
  await addDue(env);
  await runDueReminders(env, NOW);
  assert.deepEqual(sent(calls).map((b) => b.type), ['text', 'template']);
  assert.equal((await env.DB.prepare('SELECT status FROM reminders').first()).status, 'sent');
});

test('cron: repeating reminder advances', async () => {
  mockFetch();
  const env = makeEnv();
  await addDue(env, 'daily');
  await runDueReminders(env, NOW);
  const r = await env.DB.prepare('SELECT * FROM reminders').first();
  assert.equal(r.status, 'pending');
  assert.ok(r.due_at > NOW);
});

test('cron: 3 failures -> missed, delivered on next message', async () => {
  let fail = true;
  const calls = mockFetch(() => (fail ? { status: 500, json: { error: { message: 'x' } } } : {}));
  const env = makeEnv({ __llm: scriptedLLM([{ reply: 'ok' }]) });
  await addDue(env);
  for (let i = 0; i < 3; i++) await runDueReminders(env, NOW + i * 60000);
  assert.equal((await env.DB.prepare('SELECT status FROM reminders').first()).status, 'missed');
  fail = false;
  calls.length = 0;
  await handleIncoming(env, msg('hi', 'z'), NOW + 3600e3);
  assert.match(sent(calls)[0].text.body, /call mom/);
  assert.equal((await env.DB.prepare('SELECT status FROM reminders').first()).status, 'sent');
  assert.ok(await getState(env, 'last_inbound_at'));
});
