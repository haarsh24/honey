import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, mockWorld, OWNER } from './helpers.mjs';
import { handleIncoming } from '../src/handler.js';
import { setState } from '../src/db.js';
import { parseIST } from '../src/time.js';
import {
  buildCalorieWeek,
  calorieCommand,
  calorieImage,
  calorieImplicit,
  detectSlot,
  pendingSlot,
  runCalorieReminder,
  runCalorieSchedule,
  runCalorieWeekly,
  slotForTime,
} from '../src/calories.js';

const bodies = (sent) => sent.map((b) => b.text?.body ?? JSON.stringify(b));
const MON_NOON = parseIST('2026-10-26 12:05'); // Monday

const PARATHA = {
  is_food: true,
  items: [
    { name: 'paratha', quantity: '2', kcal: 520 },
    { name: 'chai', quantity: '1 cup', kcal: 100 },
  ],
  total_kcal: 620,
  protein_g: 14,
  carbs_g: 80,
  fat_g: 24,
  confidence: 'medium',
  note: 'Assumed medium parathas with ghee.',
};
const NOT_FOOD = { is_food: false, items: [], total_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, confidence: 'high', note: '' };

/** Text-chain stand-in: meal estimates for text, a one-liner for the weekly suggestion. */
function fakeLLM(messages) {
  if (messages[0].content.includes('ONE short sentence')) return 'Keep logging right after meals.';
  return JSON.stringify(/stone/i.test(messages.at(-1).content) ? NOT_FOOD : PARATHA);
}

const meals = async (env) => (await env.DB.prepare('SELECT * FROM meals ORDER BY id').all()).results;

test('slot helpers: time of day and the words you use', () => {
  assert.equal(slotForTime(parseIST('2026-10-26 12:05')), 'breakfast');
  assert.equal(slotForTime(parseIST('2026-10-26 14:10')), 'lunch');
  assert.equal(slotForTime(parseIST('2026-10-26 16:40')), 'snack');
  assert.equal(slotForTime(parseIST('2026-10-26 21:30')), 'dinner');
  assert.equal(detectSlot('lunch dal rice'), 'lunch');
  assert.equal(detectSlot('had samosa for a snack'), 'snack');
  assert.equal(detectSlot('2 roti and dal'), null);
});

test('/calorie text: estimates, saves and compares with the day', async () => {
  const sent = mockWorld();
  const env = makeEnv({ __llm: fakeLLM });
  await handleIncoming(env, { id: 'c1', from: OWNER, type: 'text', text: '/calorie 2 parathas and chai' }, MON_NOON);
  const [meal] = await meals(env);
  assert.equal(meal.slot, 'breakfast');
  assert.equal(meal.kcal, 620);
  assert.equal(meal.day, '2026-10-26');
  const reply = bodies(sent).at(-1);
  assert.match(reply, /Logged breakfast: 2 paratha, 1 cup chai ≈ 620 kcal \(P 14g · C 80g · F 24g\)/);
  assert.match(reply, /Today: 620 kcal/);
  assert.match(reply, /\/calorie goal 1800/);

  // A slot word in your message beats the clock.
  await handleIncoming(env, { id: 'c2', from: OWNER, type: 'text', text: '/calorie lunch dal rice' }, MON_NOON + 60000);
  assert.equal((await meals(env))[1].slot, 'lunch');
  assert.match(bodies(sent).at(-1), /Today: 1,240 kcal/);
});

test('food photo with a /calorie caption goes to Gemini and is logged', async () => {
  const sent = mockWorld({ media: { M1: { mime: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) } } });
  let seen;
  const env = makeEnv({
    __gemini: async ({ media, prompt, json }) => {
      seen = { mime: media.mime, json, prompt };
      return JSON.stringify(PARATHA);
    },
  });
  const at = parseIST('2026-10-26 14:10');
  await handleIncoming(env, { id: 'p1', from: OWNER, type: 'image', media: { id: 'M1', mime: 'image/jpeg', caption: '/calorie dal chawal' } }, at);
  assert.equal(seen.mime, 'image/jpeg');
  assert.equal(seen.json, true);
  assert.match(seen.prompt, /dal chawal/);
  assert.equal((await meals(env))[0].slot, 'lunch');
  assert.match(bodies(sent).at(-1), /Logged lunch/);
});

test('a photo with no caption is left alone unless a meal prompt is waiting', async () => {
  mockWorld({ media: { M1: { mime: 'image/jpeg', bytes: new Uint8Array([1]) } } });
  const env = makeEnv({ __gemini: async () => JSON.stringify(PARATHA) });
  const msg = { id: 'p2', from: OWNER, type: 'image', media: { id: 'M1', mime: 'image/jpeg' } };
  assert.equal(await calorieImage(env, msg, MON_NOON), null);
  assert.equal((await meals(env)).length, 0);
});

test('prompt at 12:00, then a photo reply logs breakfast and clears the wait', async () => {
  const sent = mockWorld({ media: { M1: { mime: 'image/jpeg', bytes: new Uint8Array([1]) } } });
  const env = makeEnv({ __gemini: async () => JSON.stringify(PARATHA) });
  const noon = parseIST('2026-10-26 12:00');
  await setState(env, 'last_inbound_at', noon - 1000);
  assert.deepEqual(await runCalorieReminder(env, noon, 'breakfast'), { sent: true });
  assert.match(bodies(sent).at(-1), /Breakfast check!.*photo and\/or a line of text/);
  assert.equal(await pendingSlot(env, noon + 60000), 'breakfast');

  await handleIncoming(env, { id: 'p3', from: OWNER, type: 'image', media: { id: 'M1', mime: 'image/jpeg' } }, noon + 5 * 60000);
  assert.match(bodies(sent).at(-1), /Logged breakfast/);
  assert.equal(await pendingSlot(env, noon + 6 * 60000), null);
});

test('text reply to a prompt is a meal; non-food and ordinary requests fall through', async () => {
  mockWorld();
  const env = makeEnv({ __llm: fakeLLM });
  const noon = parseIST('2026-10-26 12:00');
  await setState(env, 'last_inbound_at', noon - 1000);
  await runCalorieReminder(env, noon, 'breakfast');

  const text = (t) => ({ type: 'text', text: t });
  assert.equal(await calorieImplicit(env, text('stone'), 'stone', noon + 1000), null); // not food
  assert.equal((await meals(env)).length, 0);

  const boom = makeEnv({ __llm: () => { throw new Error('should not be called'); } });
  await setState(boom, 'cal_pending', JSON.stringify({ slot: 'breakfast', at: noon }));
  assert.equal(await calorieImplicit(boom, text("what's the weather"), "what's the weather", noon + 1000), null); // skipped without an AI call
  assert.equal(await calorieImplicit(boom, text('/calorie today'), '/calorie today', noon + 1000), null);

  const reply = await calorieImplicit(env, text('2 parathas and chai'), '2 parathas and chai', noon + 2000);
  assert.match(reply, /Logged breakfast/);
  assert.equal((await meals(env)).length, 1);
  assert.equal(await calorieImplicit(env, text('1 more'), '1 more', noon + 3000), null); // wait cleared after one meal
});

test('a prompt that nobody answered stops waiting after two hours', async () => {
  const env = makeEnv({ __llm: fakeLLM });
  const noon = parseIST('2026-10-26 12:00');
  await setState(env, 'cal_pending', JSON.stringify({ slot: 'breakfast', at: noon }));
  assert.equal(await pendingSlot(env, noon + 119 * 60000), 'breakfast');
  assert.equal(await pendingSlot(env, noon + 121 * 60000), null);
});

test('non-food is refused for /calorie and a failing AI gets a friendly answer', async () => {
  const env = makeEnv({ __llm: fakeLLM });
  assert.match(await calorieCommand(env, '/calorie stone', MON_NOON), /doesn't look like food/);
  assert.equal((await meals(env)).length, 0);
  const broken = makeEnv({ __llm: () => { throw new Error('all providers down'); } });
  assert.match(await calorieCommand(broken, '/calorie 2 roti', MON_NOON), /Couldn't work out that meal/);
});

test('reminders: once a day, free window only, skipped when logged or muted', async () => {
  const sent = mockWorld();
  const env = makeEnv({ __llm: fakeLLM });
  const noon = parseIST('2026-10-26 12:00');
  assert.deepEqual(await runCalorieReminder(env, noon, 'breakfast'), { skipped: 'window-closed' });
  await setState(env, 'last_inbound_at', noon - 1000);
  assert.deepEqual(await runCalorieReminder(env, noon, 'breakfast'), { sent: true });
  assert.deepEqual(await runCalorieReminder(env, noon, 'breakfast'), { skipped: 'already-sent' });
  assert.equal(sent.length, 1);

  // Dinner already logged: no dinner prompt.
  await calorieCommand(env, '/calorie dinner paratha', noon);
  const dinner = parseIST('2026-10-26 21:30');
  await setState(env, 'last_inbound_at', dinner - 1000);
  assert.deepEqual(await runCalorieReminder(env, dinner, 'dinner'), { skipped: 'already-logged' });

  await calorieCommand(env, '/calorie off', noon);
  assert.deepEqual(await runCalorieReminder(env, parseIST('2026-10-26 14:00'), 'lunch'), { skipped: 'off' });
  await calorieCommand(env, '/calorie on', noon);
  await setState(env, 'last_inbound_at', parseIST('2026-10-26 14:00') - 1000);
  assert.deepEqual(await runCalorieReminder(env, parseIST('2026-10-26 14:00'), 'lunch'), { sent: true });
});

test('the cron fires the four prompts at 12:00, 2:00, 4:40 and 9:30 IST only', async () => {
  const sent = mockWorld();
  const env = makeEnv();
  const day = '2026-10-27';
  const expect = [
    ['12:00', /Breakfast check/],
    ['14:00', /Lunch check/],
    ['16:40', /Snack check/],
    ['21:30', /Dinner check/],
  ];
  for (const [time, pattern] of expect) {
    const at = parseIST(`${day} ${time}`);
    await setState(env, 'last_inbound_at', at - 1000);
    const before = sent.length;
    await runCalorieSchedule(env, at);
    assert.equal(sent.length, before + 1, time);
    assert.match(bodies(sent).at(-1), pattern);
  }
  const before = sent.length;
  assert.deepEqual(await runCalorieSchedule(env, parseIST(`${day} 12:01`)), []);
  assert.deepEqual(await runCalorieSchedule(env, parseIST(`${day} 17:00`)), []);
  assert.equal(sent.length, before);
});

test('commands: goal, today, undo, fix, usage', async () => {
  const env = makeEnv({ __llm: fakeLLM });
  assert.match(await calorieCommand(env, '/calorie', MON_NOON), /Calorie tracker/);
  assert.equal(await calorieCommand(env, 'hello', MON_NOON), null);
  assert.match(await calorieCommand(env, '/calorie goal 900', MON_NOON), /dietitian/);
  assert.match(await calorieCommand(env, '/calorie goal 1800', MON_NOON), /Daily target set to 1,800/);
  assert.match(await calorieCommand(env, '/calorie 2 parathas and chai', MON_NOON), /Today: 620 \/ 1,800 kcal \(1,180 left\)/);
  assert.match(await calorieCommand(env, '/calorie today', MON_NOON), /1\. breakfast: 2 paratha, 1 cup chai - 620 kcal/);
  assert.match(await calorieCommand(env, '/calorie fix 450', MON_NOON), /now 450 kcal/);
  assert.equal((await meals(env))[0].kcal, 450);
  assert.match(await calorieCommand(env, '/calorie undo', MON_NOON), /Removed breakfast/);
  assert.equal((await meals(env)).length, 0);
  assert.match(await calorieCommand(env, '/calorie undo', MON_NOON), /Nothing to undo/);
});

async function seedWeek(env) {
  // Monday to Sunday: [day, meals, kcal per meal]
  const plan = [
    ['2026-10-26', 2, 900], // 1800
    ['2026-10-27', 3, 733.34], // 2200
    ['2026-10-28', 1, 1000], // one meal only
    ['2026-10-30', 2, 875], // 1750
    ['2026-10-31', 2, 750], // 1500
    ['2026-11-01', 2, 950], // 1900
  ];
  for (const [day, n, kcal] of plan) {
    for (let i = 0; i < n; i++) {
      await env.DB.prepare('INSERT INTO meals (day, slot, description, kcal, protein_g, carbs_g, fat_g, confidence, logged_at) VALUES (?, ?, ?, ?, 20, 60, 15, ?, ?)')
        .bind(day, ['breakfast', 'lunch', 'dinner'][i], 'seed', Math.round(kcal), 'medium', parseIST(`${day} 12:00`) + i)
        .run();
    }
  }
}

test('weekly summary: per-day bars, goal comparison, sent once on Sunday evening', async () => {
  const sent = mockWorld();
  const env = makeEnv({ __llm: fakeLLM });
  const sunday = parseIST('2026-11-01 20:45');
  assert.equal(await buildCalorieWeek(env, sunday), null);
  assert.deepEqual(await runCalorieWeekly(env, sunday), { skipped: 'no-meals' });

  await seedWeek(env);
  await calorieCommand(env, '/calorie goal 1800', sunday);
  const week = await buildCalorieWeek(env, sunday);
  assert.match(week.text, /Your week in calories/);
  assert.match(week.text, /Mon {2}1,800 ▇+/);
  assert.match(week.text, /Wed {2}1,000 ▇+ \(1 meal only\)/);
  assert.match(week.text, /Thu {2}not logged/);
  assert.match(week.text, /Logged 6 of 7 days, average 1,692 kcal/);
  assert.match(week.text, /Goal 1,800 kcal: 3 days on target \(±10%\), 1 over, 2 lighter\./);
  assert.match(week.text, /Highest Tue 2,199, lowest Wed 1,000\./);
  assert.match(week.text, /Average per day: protein 40g, carbs 120g, fat 30g\./);
  assert.match(week.text, /Meals logged: 12/);
  assert.match(week.text, /💡 Keep logging right after meals\./);

  await setState(env, 'last_inbound_at', sunday - 1000);
  assert.deepEqual(await runCalorieSchedule(env, sunday), [{ sent: true }]);
  assert.match(bodies(sent).at(-1), /Your week in calories/);
  assert.deepEqual(await runCalorieWeekly(env, sunday), { skipped: 'already-sent' });
  assert.equal(sent.length, 1);

  // Not Sunday evening: nothing fires.
  assert.deepEqual(await runCalorieSchedule(env, parseIST('2026-10-31 20:45')), []);
});

test('weekly summary falls back to the template when the free window is closed', async () => {
  const sent = mockWorld();
  const env = makeEnv({ __llm: fakeLLM });
  await seedWeek(env);
  await runCalorieWeekly(env, parseIST('2026-11-01 20:45'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'template');
  assert.match(sent[0].template.components[0].parameters[0].text, /Calorie week: logged 6\/7 days, average 1,692 kcal\/day/);
});
