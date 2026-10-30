import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, mockWorld, OWNER } from './helpers.mjs';
import { handleIncoming } from '../src/handler.js';
import { parseTrack, guessCategory, importStatement, spendingReview, runMoneyCheckin, trackCommand } from '../src/money.js';
import { TOOLS } from '../src/tools.js';
import { parseIST, startOfISTDay } from '../src/time.js';

const NOW = parseIST('2026-10-31 20:00'); // Saturday evening IST
const DAY = 24 * 3600 * 1000;
const bodies = (sent) => sent.map((b) => b.text?.body ?? JSON.stringify(b));
const add = (env, amount, category, note, daysAgo) =>
  env.DB.prepare('INSERT INTO expenses (amount, category, note, spent_at) VALUES (?, ?, ?, ?)').bind(amount, category, note, NOW - daysAgo * DAY).run();

test('parseTrack handles amounts in any position, k suffix, thousands commas, and/&, yesterday', () => {
  const { items, skipped } = parseTrack('450 lunch, auto 120; ₹2k groceries and 1,250 petrol & rs 60 chai', NOW);
  assert.deepEqual(items.map((i) => [i.amount, i.category]), [[450, 'food'], [120, 'travel'], [2000, 'groceries'], [1250, 'travel'], [60, 'food']]);
  assert.equal(skipped.length, 0);
  const y = parseTrack('yesterday 300 chai', NOW);
  assert.equal(y.items[0].spentAt, NOW - DAY);
  assert.equal(y.items[0].note, 'chai');
  const merged = parseTrack('chicken, rice 250', NOW);
  assert.equal(merged.items[0].note, 'chicken rice');
  assert.equal(parseTrack('hello there', NOW).items.length, 0);
  assert.equal(guessCategory('Swiggy order'), 'food');
  assert.equal(guessCategory('some random thing'), 'other');
});

test('/track logs several spends with no AI, shows today total, and /track alone shows help', async () => {
  const sent = mockWorld();
  const env = makeEnv({ __llm: async () => { throw new Error('AI must not be used for /track'); } });
  await handleIncoming(env, { id: 't1', from: OWNER, type: 'text', text: '/track 450 lunch, 120 auto, 2k groceries' }, NOW);
  const rows = (await env.DB.prepare('SELECT amount, category FROM expenses ORDER BY id').all()).results;
  assert.deepEqual(rows.map((r) => [r.amount, r.category]), [[450, 'food'], [120, 'travel'], [2000, 'groceries']]);
  const reply = bodies(sent).at(-1);
  assert.match(reply, /Logged 3 spends, ₹2,570/);
  assert.match(reply, /Today so far: ₹2,570/);
  await handleIncoming(env, { id: 't2', from: OWNER, type: 'text', text: '/track' }, NOW);
  assert.match(bodies(sent).at(-1), /Money tracker/);
  await handleIncoming(env, { id: 't3', from: OWNER, type: 'text', text: '/track nothing here' }, NOW);
  assert.match(bodies(sent).at(-1), /could not find an amount/);
});

test('review flags rising categories, small leaks, repeat merchants and budget overruns', async () => {
  const env = makeEnv();
  // previous 7 days: modest. last 7 days: food way up, many small chai spends, Swiggy x3.
  await add(env, 800, 'food', 'lunch', 9);
  await add(env, 500, 'travel', 'cab', 10);
  for (let i = 0; i < 5; i++) await add(env, 120, 'food', 'chai', i);
  for (let i = 0; i < 3; i++) await add(env, 500, 'food', 'swiggy', i);
  await add(env, 3000, 'shopping', 'shoes', 2);
  await env.DB.prepare("INSERT INTO state (key, value) VALUES ('budgets', ?)").bind(JSON.stringify({ food: 2000, total: 9000 })).run();
  const review = await spendingReview(env, { period: 'week' }, NOW);
  assert.equal(review.empty, false);
  assert.match(review.text, /Spending review: last 7 days/);
  assert.match(review.text, /Where you are overspending/);
  assert.match(review.text, /food jumped/);
  assert.match(review.text, /New: shopping ₹3,000/);
  assert.match(review.text, /Small food spends add up/);
  assert.match(review.text, /swiggy ×3 = ₹1,500/);
  assert.match(review.text, /food is ₹900 over its ₹2,000 budget/);
  assert.match(review.text, /Budgets this month/);
  const empty = await spendingReview(makeEnv(), { period: 'week' }, NOW);
  assert.equal(empty.empty, true);
  assert.match(empty.text, /\/track/);
});

test('/budget sets, lists and removes monthly limits', async () => {
  const sent = mockWorld();
  const env = makeEnv();
  await handleIncoming(env, { id: 'b1', from: OWNER, type: 'text', text: '/budget food 6000' }, NOW);
  assert.match(bodies(sent).at(-1), /Budget set: food ₹6,000/);
  await handleIncoming(env, { id: 'b2', from: OWNER, type: 'text', text: '/budget total 30k' }, NOW);
  assert.match(bodies(sent).at(-1), /overall ₹30,000/);
  await handleIncoming(env, { id: 'b3', from: OWNER, type: 'text', text: '/budget' }, NOW);
  assert.match(bodies(sent).at(-1), /food: ₹6,000[\s\S]*Overall: ₹30,000/);
  await handleIncoming(env, { id: 'b4', from: OWNER, type: 'text', text: '/budget off food' }, NOW);
  assert.match(bodies(sent).at(-1), /Removed the food budget/);
  assert.deepEqual(await TOOLS.list_budgets(env, {}, { now: NOW }), { budgets: { total: 30000 } });
});

test('statement import skips spends you already logged and is safe to run twice', async () => {
  const env = makeEnv();
  await add(env, 450, 'food', 'lunch', 1); // already tracked by hand
  const tx = [
    { date: '2026-10-30', desc: 'ZOMATO', amount: 450, category: 'food' }, // same day + amount as the manual one
    { date: '2026-10-29', desc: 'Swiggy', amount: 320, category: 'food' },
    { date: '2026-10-28', desc: 'Jio recharge', amount: 299, category: 'bills' },
    { date: '2026-10-28', desc: 'Salary', amount: -50000 }, // ignored
    { date: 'bad', desc: 'x', amount: 10 },
  ];
  const first = await importStatement(env, tx, NOW);
  assert.equal(first.inserted, 2);
  assert.equal(first.duplicates, 1);
  const second = await importStatement(env, tx, NOW);
  assert.equal(second.inserted, 0);
  assert.equal(second.duplicates, 3);
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM expenses WHERE source = 'statement'").first()).n;
  assert.equal(n, 2);
});

test('PDF statement: read, imported, and the overspending review comes back', async () => {
  const sent = mockWorld({ media: { S1: { mime: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) } } });
  const calls = [];
  const env = makeEnv({
    __gemini: async ({ prompt }) => {
      calls.push(prompt.slice(0, 40));
      if (/Read this document/.test(prompt)) return JSON.stringify({ kind: 'statement', summary: 'bank statement', deadlines: [] });
      return JSON.stringify({ transactions: [
        { date: '2026-10-27', desc: 'Swiggy', amount: 400, category: 'food' },
        { date: '2026-10-28', desc: 'Swiggy', amount: 550, category: 'food' },
        { date: '2026-10-29', desc: 'Swiggy', amount: 600, category: 'food' },
        { date: '2026-10-30', desc: 'Amazon', amount: 2500, category: 'shopping' },
      ] });
    },
  });
  await handleIncoming(env, { id: 's1', from: OWNER, type: 'document', media: { id: 'S1', mime: 'application/pdf', filename: 'hdfc.pdf', caption: '' } }, NOW);
  const reply = bodies(sent).at(-1);
  assert.match(reply, /Statement read: 4 spends found. 4 new \(₹4,050\)/);
  assert.match(reply, /Spending review/);
  assert.match(reply, /swiggy ×3 = ₹1,550/);
  assert.equal(calls.length, 2); // classify, then extract
  // caption "statement" skips the classification call
  calls.length = 0;
  await handleIncoming(env, { id: 's2', from: OWNER, type: 'document', media: { id: 'S1', mime: 'application/pdf', filename: 'x.pdf', caption: 'statement' } }, NOW);
  assert.equal(calls.length, 1);
  assert.match(bodies(sent).at(-1), /4 were already logged|already logged/);
});

test('screenshot of many transactions is treated as a statement; a single receipt is not', async () => {
  const sent = mockWorld({ media: { I1: { mime: 'image/png', bytes: new Uint8Array([1]) } } });
  const env = makeEnv({
    __gemini: async ({ prompt }) => /Look at this image/.test(prompt)
      ? JSON.stringify({ type: 'statement', summary: 'upi history', text: '' })
      : JSON.stringify({ transactions: [{ date: '2026-10-30', desc: 'Blinkit', amount: 700, category: 'groceries' }] }),
  });
  await handleIncoming(env, { id: 'i1', from: OWNER, type: 'image', media: { id: 'I1', mime: 'image/png', caption: '' } }, NOW);
  assert.match(bodies(sent).at(-1), /Statement read: 1 spends found/);
  const row = await env.DB.prepare('SELECT * FROM expenses').first();
  assert.equal(row.note, 'Blinkit');
});

test('weekly check-in: review + ask for the statement, once a day, can be switched off', async () => {
  const sent = mockWorld();
  const env = makeEnv();
  await env.DB.prepare("INSERT INTO state (key, value) VALUES ('last_inbound_at', ?)").bind(String(NOW - 1000)).run();
  await add(env, 900, 'food', 'swiggy', 2);
  const first = await runMoneyCheckin(env, NOW);
  assert.equal(first.sent, true);
  const text = bodies(sent).at(-1);
  assert.match(text, /Weekly money check-in/);
  assert.match(text, /statement/);
  assert.match(text, /\/track/);
  assert.equal((await runMoneyCheckin(env, NOW)).skipped, 'already-sent');
  const { getState } = await import('../src/db.js');
  assert.ok(Number(await getState(env, 'await_statement_until')) > NOW);
  await handleIncoming(env, { id: 'm1', from: OWNER, type: 'text', text: '/money off' }, NOW + DAY * 7);
  assert.equal((await runMoneyCheckin(env, NOW + DAY * 7)).skipped, 'off');
});

test('check-in outside the 24h window goes out as the template', async () => {
  const sent = mockWorld();
  const env = makeEnv();
  await runMoneyCheckin(env, NOW);
  assert.equal(sent.at(-1).type, 'template');
  assert.match(sent.at(-1).template.components[0].parameters[0].text, /Weekly money check-in/);
});

test('assistant tools: track_expenses and spending_review (report sent as is)', async () => {
  const env = makeEnv();
  const saved = await TOOLS.track_expenses(env, { text: '200 chai and 500 petrol' }, { now: NOW });
  assert.equal(saved.saved, 2);
  assert.equal(saved.total, 700);
  const review = await TOOLS.spending_review(env, { period: 'week' }, { now: NOW });
  assert.equal(review.verbatim, review.report);
  assert.match(review.report, /Spending review/);
  assert.equal((await TOOLS.set_budget(env, { category: 'food', amount: 5000 }, { now: NOW })).saved, true);
  assert.equal((await TOOLS.remove_budget(env, { category: 'food' }, { now: NOW })).removed, true);
  assert.match(await trackCommand(env, '/track month', NOW), /this month so far/);
});
