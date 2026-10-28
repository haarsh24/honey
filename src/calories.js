// Calorie tracker: log meals from a photo and/or text, four daily prompts, and a Sunday weekly summary.
// Meals live in the D1 `meals` table (one row per meal). Nothing is stored about the photo itself.
import { getState, setState } from './db.js';
import { gemini } from './gemini.js';
import { chat } from './llm.js';
import { downloadMedia } from './media.js';
import { inReplyWindow, sendProactive } from './outbound.js';
import { formatIST, istParts, startOfPeriod } from './time.js';
import { normalizePhone, parseModelJson } from './util.js';
import { sendText } from './whatsapp.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PENDING_MS = 2 * 60 * 60 * 1000; // a prompt "waits" for a meal reply for two hours
const IMAGE_LIMIT = 6_000_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const kc = (n) => Math.round(Number(n) || 0).toLocaleString('en-IN');
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const todayIST = (now) => formatIST(now).slice(0, 10);
const owner = (env) => normalizePhone(env.OWNER_NUMBER, env.DEFAULT_COUNTRY_CODE ?? '91');

/** The four daily prompts. `utc` is the default cron time (IST 12:00, 14:00, 16:40, 21:30); override with CAL_<SLOT>_TIME_UTC. */
export const SLOTS = {
  breakfast: { utc: '06:30', icon: '🍳', ask: 'What did you have for breakfast?' },
  lunch: { utc: '08:30', icon: '🍛', ask: 'What did you have for lunch?' },
  snack: { utc: '11:10', icon: '☕', ask: 'Any chai, biscuits or snacks so far?' },
  dinner: { utc: '16:00', icon: '🌙', ask: 'What did you have for dinner?' },
};

const USAGE = `🍽️ Calorie tracker
- /calorie <what you ate>, e.g. /calorie 2 parathas, curd, chai
- Send a photo with /calorie as the caption (add words if you like)
- /calorie today · /calorie week
- /calorie goal 1800 (daily target)
- /calorie undo · /calorie fix 450 (correct the last meal)
- /calorie off · /calorie on (the 12:00, 2:00, 4:40 and 9:30 prompts; the Sunday summary stays)
When I ask about a meal, just reply with a photo and/or text. Estimates are rough, usually within 20-30%.`;

/** Which meal a time of day most likely is (IST). */
export function slotForTime(now) {
  const p = istParts(now);
  const m = p.h * 60 + p.mi;
  if (m < 13 * 60 + 30) return 'breakfast';
  if (m < 16 * 60) return 'lunch';
  if (m < 19 * 60) return 'snack';
  return 'dinner';
}

/** "breakfast: ..." or "... for lunch" in the user's words wins over the time of day. */
export function detectSlot(text) {
  const t = String(text ?? '').toLowerCase();
  const lead = t.match(/^\s*(breakfast|lunch|dinner|snacks?)\b/);
  const tail = t.match(/\bfor\s+(?:a\s+|my\s+)?(breakfast|lunch|dinner|snacks?)\b/);
  const word = (lead || tail)?.[1];
  if (!word) return null;
  return word.startsWith('snack') ? 'snack' : word;
}

const INSTRUCTIONS = `You estimate the calories of a meal. The food is usually Indian home cooking, street food or restaurant food. Answer ONLY with JSON:
{"is_food":true|false,"items":[{"name":string,"quantity":string,"kcal":number}],"total_kcal":number,"protein_g":number,"carbs_g":number,"fat_g":number,"confidence":"low"|"medium"|"high","note":string}
Rules: list each food or drink as an item with a realistic portion. If the user states quantities, trust them over what you see. Typical anchors: one medium roti about 100 kcal, one katori cooked dal about 130-150, one cup cooked rice about 200, one plain paratha about 250-300, one cup chai with sugar and milk about 80-120. total_kcal must equal the sum of the items. note is one short sentence about your main assumption (for example the portion size). If the message or photo is not food or drink, set is_food to false and use zeros and empty strings.`;

function normalizeAnalysis(a, fallbackText) {
  if (!a || typeof a !== 'object') throw new Error('could not read the estimate');
  if (a.is_food === false) return { notFood: true };
  const items = (Array.isArray(a.items) ? a.items : [])
    .slice(0, 12)
    .map((i) => ({ name: clip(i?.name, 40), quantity: clip(i?.quantity, 30), kcal: Math.max(0, Math.round(Number(i?.kcal) || 0)) }))
    .filter((i) => i.name);
  const summed = items.reduce((s, i) => s + i.kcal, 0);
  const kcal = summed > 0 ? summed : Math.round(Number(a.total_kcal) || 0);
  if (!(kcal > 0) || kcal > 5000) throw new Error('implausible estimate');
  const grams = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n < 1000 ? Math.round(n) : null;
  };
  const confidence = ['low', 'medium', 'high'].includes(String(a.confidence).toLowerCase()) ? String(a.confidence).toLowerCase() : 'medium';
  const description = items.length ? items.map((i) => (i.quantity ? `${i.quantity} ${i.name}` : i.name)).join(', ') : clip(fallbackText, 200) || 'meal';
  return {
    notFood: false,
    kcal,
    protein_g: grams(a.protein_g),
    carbs_g: grams(a.carbs_g),
    fat_g: grams(a.fat_g),
    confidence,
    note: clip(a.note, 140),
    description: clip(description, 200),
  };
}

/** text and/or media ({ bytes, mime }) in, a normalized estimate out. Photos need GEMINI_KEY; text uses the normal AI chain. */
export async function analyzeMeal(env, { text, media }) {
  const said = clip(text, 500);
  let raw;
  if (media) {
    raw = await gemini(env, {
      media,
      json: true,
      prompt: `${INSTRUCTIONS}\nThe meal is in the attached photo.${said ? ` What the user said about it: "${said}"` : ''}`,
    });
  } else {
    raw = await chat(
      env,
      [
        { role: 'system', content: INSTRUCTIONS },
        { role: 'user', content: `Meal: ${said}` },
      ],
      { temperature: 0.1, maxTokens: 700 },
    );
  }
  return normalizeAnalysis(parseModelJson(raw), said);
}

async function getGoal(env) {
  const n = Number(await getState(env, 'cal_goal'));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function dayTotals(env, day) {
  const rows = (
    await env.DB.prepare('SELECT id, slot, description, kcal, protein_g, carbs_g, fat_g FROM meals WHERE day = ? ORDER BY logged_at, id')
      .bind(day)
      .all()
  ).results;
  return { rows, kcal: rows.reduce((s, r) => s + (r.kcal || 0), 0) };
}

function goalLine(kcal, goal, label) {
  if (!goal) return `${label} ${kc(kcal)} kcal.`;
  return kcal <= goal ? `${label} ${kc(kcal)} / ${kc(goal)} kcal (${kc(goal - kcal)} left)` : `${label} ${kc(kcal)} / ${kc(goal)} kcal (${kc(kcal - goal)} over)`;
}

/** The slot a pending prompt is waiting for, or null once the two-hour window has passed. */
export async function pendingSlot(env, now) {
  try {
    const p = JSON.parse((await getState(env, 'cal_pending')) || 'null');
    if (p?.slot && SLOTS[p.slot] && now - p.at >= 0 && now - p.at < PENDING_MS) return p.slot;
  } catch {
    /* no pending prompt */
  }
  return null;
}

/** Analyze, save and answer. Returns null for a non-food or failed *implicit* attempt so the normal assistant can take over. */
async function logFromInput(env, { text, media, now, explicit }) {
  let a;
  try {
    a = await analyzeMeal(env, { text, media });
  } catch (error) {
    console.error('Calorie analysis failed:', error.message);
    if (!explicit) return null;
    if (error.code === 'NO_KEY') return 'Photos need the GEMINI_KEY secret to be set up. Describe the meal in text instead, e.g. /calorie 2 roti, dal, sabzi.';
    return "Couldn't work out that meal just now 😵 Try again, or add a line of text like /calorie 2 roti, dal, sabzi.";
  }
  if (a.notFood) return explicit ? "That doesn't look like food or drink 🤔 Try again with the meal, or describe it in text." : null;

  const pending = await pendingSlot(env, now);
  const slot = detectSlot(text) ?? pending ?? slotForTime(now);
  const day = todayIST(now);
  const result = await env.DB.prepare(
    'INSERT INTO meals (day, slot, description, kcal, protein_g, carbs_g, fat_g, confidence, logged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(day, slot, a.description, a.kcal, a.protein_g, a.carbs_g, a.fat_g, a.confidence, now)
    .run();
  await setState(env, 'cal_pending', 'null');

  const totals = await dayTotals(env, day);
  const goal = await getGoal(env);
  const macros = [a.protein_g !== null && `P ${a.protein_g}g`, a.carbs_g !== null && `C ${a.carbs_g}g`, a.fat_g !== null && `F ${a.fat_g}g`].filter(Boolean).join(' · ');
  const lines = [`🍽️ Logged ${slot}: ${a.description} ≈ ${kc(a.kcal)} kcal${macros ? ` (${macros})` : ''}`, goalLine(totals.kcal, goal, 'Today:')];
  if (a.note) lines.push(`ℹ️ ${a.note}${a.confidence === 'low' ? ' (low confidence, treat it as ±30%)' : ''}`);
  if (!goal && totals.rows.length === 1) lines.push('Tip: set a daily target with /calorie goal 1800 and I will track against it.');
  lines.push(`Wrong? /calorie fix <kcal> or /calorie undo (meal #${result.meta.last_row_id})`);
  return lines.join('\n');
}

async function todayReply(env, now) {
  const t = await dayTotals(env, todayIST(now));
  if (!t.rows.length) return 'Nothing logged today yet 🍽️ Send a photo, or /calorie 2 roti, dal, sabzi';
  const goal = await getGoal(env);
  return [
    `Today so far (${t.rows.length} meal${t.rows.length === 1 ? '' : 's'}):`,
    ...t.rows.map((r) => `${r.id}. ${r.slot}: ${clip(r.description, 60)} - ${kc(r.kcal)} kcal`),
    goalLine(t.kcal, goal, 'Total:'),
  ].join('\n');
}

async function explicitCommand(env, rest, media, now) {
  const r = clip(rest, 600);
  if (!media) {
    if (!r) return `${USAGE}\n\n${await todayReply(env, now)}`;
    let m;
    if (/^today$/i.test(r)) return todayReply(env, now);
    if (/^(week|weekly|summary)$/i.test(r)) {
      const week = await buildCalorieWeek(env, now);
      return week ? week.text : 'Nothing logged this week yet 🍽️ Send a photo or /calorie <what you ate> and I will start counting.';
    }
    if (/^help$/i.test(r)) return USAGE;
    if ((m = r.match(/^goal\s+(\d{3,5})(?:\s*kcal)?$/i))) {
      const goal = Number(m[1]);
      if (goal < 1000) return "That's lower than I'm comfortable tracking against. A doctor or dietitian can set a safe daily target for you.";
      if (goal > 6000) return 'That looks too high to be a daily target. Try something like /calorie goal 2000.';
      await setState(env, 'cal_goal', goal);
      return `Daily target set to ${kc(goal)} kcal 🎯${goal < 1200 ? ' That is on the low side, so please check it with a doctor or dietitian.' : ''} I will compare each day and your Sunday summary against it.`;
    }
    if (/^undo$/i.test(r)) {
      const last = await env.DB.prepare('SELECT id, slot, description, kcal, day FROM meals ORDER BY id DESC LIMIT 1').first();
      if (!last) return 'Nothing to undo 🤷';
      await env.DB.prepare('DELETE FROM meals WHERE id = ?').bind(last.id).run();
      const t = await dayTotals(env, todayIST(now));
      return `Removed ${last.slot}: ${clip(last.description, 60)} (${kc(last.kcal)} kcal). ${goalLine(t.kcal, await getGoal(env), 'Today:')}`;
    }
    if ((m = r.match(/^fix\s+(\d{1,4})(?:\s*kcal)?$/i))) {
      const kcal = Number(m[1]);
      if (kcal < 1 || kcal > 5000) return 'Give me a number between 1 and 5000, e.g. /calorie fix 450';
      const last = await env.DB.prepare('SELECT id, slot, description FROM meals ORDER BY id DESC LIMIT 1').first();
      if (!last) return 'No meal to fix yet.';
      await env.DB.prepare('UPDATE meals SET kcal = ?, confidence = ? WHERE id = ?').bind(kcal, 'high', last.id).run();
      const t = await dayTotals(env, todayIST(now));
      return `Updated ${last.slot}: ${clip(last.description, 60)} is now ${kc(kcal)} kcal. ${goalLine(t.kcal, await getGoal(env), 'Today:')}`;
    }
    if (/^(on|off)$/i.test(r)) {
      const on = r.toLowerCase() === 'on';
      await setState(env, 'cal_reminders', on ? 'on' : 'off');
      return on ? 'Meal prompts are on: 12:00, 2:00, 4:40 and 9:30 IST 🍽️' : 'Meal prompts are off. You can still log with /calorie, and the Sunday summary keeps coming.';
    }
  }
  return logFromInput(env, { text: r, media, now, explicit: true });
}

/** Text command: "/calorie ..." (or "/calories ..."). Returns the reply, or null when the message is not this command. */
export async function calorieCommand(env, text, now) {
  const m = String(text ?? '').trim().match(/^\/calories?\b\s*([\s\S]*)$/i);
  if (!m) return null;
  return explicitCommand(env, m[1], null, now);
}

/**
 * A photo. Handled when its caption starts with /calorie, or when a meal prompt is waiting for an answer.
 * Returns the reply, or null to let the normal photo handling (receipts and so on) run.
 */
export async function calorieImage(env, msg, now) {
  const caption = clip(msg.media?.caption, 300);
  const cmd = caption.match(/^\/calories?\b\s*([\s\S]*)$/i);
  if (!cmd && !(await pendingSlot(env, now))) return null;
  let media;
  try {
    media = await downloadMedia(env, msg.media.id, IMAGE_LIMIT);
  } catch (error) {
    console.error('Calorie photo download failed:', error.message);
    if (!cmd) return null;
    return error.code === 'TOO_LARGE' ? 'That photo is too large for me. Please send a smaller one.' : "Couldn't open that photo 😵 Try sending it again.";
  }
  return logFromInput(env, { text: cmd ? cmd[1] : caption, media, now, explicit: Boolean(cmd) });
}

// Messages that are clearly something else, so a waiting meal prompt does not spend an AI call on them.
const NOT_A_MEAL = /^(remind|save|note|add task|task|done|undo|snooze|search|news|weather|price|nav|journal|idea|write|draft|quiz|spent|did|what|how|when|why|who|tell me|show|list)\b/i;

/** A plain text or voice reply while a meal prompt is waiting. Returns null when it does not look like a meal. */
export async function calorieImplicit(env, msg, text, now) {
  if (msg.type !== 'text' && msg.type !== 'audio') return null;
  if (!(await pendingSlot(env, now))) return null;
  const t = clip(text, 400);
  if (!t || t.startsWith('/') || NOT_A_MEAL.test(t)) return null;
  return logFromInput(env, { text: t, now, explicit: false });
}

/** Week so far (Monday to today, IST): per-day bars, averages, goal comparison. Null when nothing was logged. */
export async function buildCalorieWeek(env, now) {
  const start = todayIST(startOfPeriod('week', now));
  const end = todayIST(now);
  const rows = (
    await env.DB.prepare(
      'SELECT day, SUM(kcal) AS kcal, SUM(protein_g) AS p, SUM(carbs_g) AS c, SUM(fat_g) AS f, COUNT(*) AS n FROM meals WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day',
    )
      .bind(start, end)
      .all()
  ).results;
  if (!rows.length) return null;
  const slotRows = (
    await env.DB.prepare('SELECT slot, COUNT(*) AS n FROM meals WHERE day >= ? AND day <= ? GROUP BY slot').bind(start, end).all()
  ).results;
  const goal = await getGoal(env);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const maxKcal = Math.max(...rows.map((r) => r.kcal));
  const scale = Math.max(goal, maxKcal);

  const lines = ['Your week in calories 🍽️'];
  const startMs = Date.parse(`${start}T00:00:00Z`);
  for (let ms = startMs; ms <= Date.parse(`${end}T00:00:00Z`); ms += DAY_MS) {
    const day = new Date(ms).toISOString().slice(0, 10);
    const label = WEEKDAYS[new Date(ms).getUTCDay()];
    const r = byDay.get(day);
    if (!r) {
      lines.push(`${label}  not logged`);
      continue;
    }
    const bar = '▇'.repeat(Math.max(1, Math.round((r.kcal / scale) * 8)));
    lines.push(`${label}  ${kc(r.kcal)} ${bar}${r.n < 2 ? ' (1 meal only)' : ''}`);
  }

  const total = rows.reduce((s, r) => s + r.kcal, 0);
  const avg = Math.round(total / rows.length);
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - startMs) / DAY_MS) + 1;
  lines.push(`Logged ${rows.length} of ${days} day${days === 1 ? '' : 's'}, average ${kc(avg)} kcal on the days you logged.`);
  if (goal) {
    const on = rows.filter((r) => Math.abs(r.kcal - goal) <= goal * 0.1).length;
    const over = rows.filter((r) => r.kcal > goal * 1.1).length;
    const light = rows.length - on - over;
    lines.push(`Goal ${kc(goal)} kcal: ${on} day${on === 1 ? '' : 's'} on target (±10%), ${over} over, ${light} lighter.`);
  }
  const hi = rows.reduce((a, b) => (b.kcal > a.kcal ? b : a));
  const lo = rows.reduce((a, b) => (b.kcal < a.kcal ? b : a));
  if (rows.length > 1) lines.push(`Highest ${WEEKDAYS[new Date(`${hi.day}T00:00:00Z`).getUTCDay()]} ${kc(hi.kcal)}, lowest ${WEEKDAYS[new Date(`${lo.day}T00:00:00Z`).getUTCDay()]} ${kc(lo.kcal)}.`);
  const macro = (key) => Math.round(rows.reduce((s, r) => s + (r[key] || 0), 0) / rows.length);
  if (rows.some((r) => r.p || r.c || r.f)) lines.push(`Average per day: protein ${macro('p')}g, carbs ${macro('c')}g, fat ${macro('f')}g.`);
  const meals = slotRows.reduce((s, r) => s + r.n, 0);
  lines.push(`Meals logged: ${meals} (${slotRows.map((r) => `${r.slot} ${r.n}`).join(', ')}).`);

  let suggestion = rows.length < 5 ? 'Log meals right after eating, even rough entries make next week\'s numbers more useful.' : 'Nice logging streak. Keep the same routine and tweak just one meal if you want to nudge the average.';
  try {
    const raw = await chat(
      env,
      [
        {
          role: 'system',
          content:
            'You are a casual, friendly assistant reviewing one week of calorie logs. Reply with ONE short sentence (max 25 words) of practical, encouraging advice for next week based on the stats. Never suggest skipping meals, fasting or eating very little. This is not medical advice. No quotes.',
        },
        { role: 'user', content: lines.join('\n') },
      ],
      { temperature: 0.4, maxTokens: 120 },
    );
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line && line.length < 220) suggestion = line;
  } catch {
    /* keep default */
  }
  lines.push(`💡 ${suggestion}`);
  lines.push('Estimates are rough. /calorie goal 1800 sets a daily target.');
  const compact = `Calorie week: logged ${rows.length}/${days} days, average ${kc(avg)} kcal/day. ${suggestion}`;
  return { text: lines.join('\n'), compact };
}

/** Sunday summary. Sent once per day; the free window is used when open, otherwise the template. */
export async function runCalorieWeekly(env, now) {
  const today = todayIST(now);
  if ((await getState(env, 'last_cal_weekly')) === today) return { skipped: 'already-sent' };
  const week = await buildCalorieWeek(env, now);
  if (!week) return { skipped: 'no-meals' };
  await setState(env, 'last_cal_weekly', today);
  await sendProactive(env, owner(env), week.text, week.compact, now);
  return { sent: true };
}

/** One of the four meal prompts. Free window only, once per slot per day, skipped when that meal is already logged. */
export async function runCalorieReminder(env, now, slot) {
  const cfg = SLOTS[slot];
  if (!cfg) return { skipped: 'unknown-slot' };
  if ((await getState(env, 'cal_reminders')) === 'off') return { skipped: 'off' };
  const today = todayIST(now);
  if ((await getState(env, `cal_prompt_${slot}`)) === today) return { skipped: 'already-sent' };
  if (!(await inReplyWindow(env, now))) return { skipped: 'window-closed' };
  const done = await env.DB.prepare('SELECT 1 AS x FROM meals WHERE day = ? AND slot = ? LIMIT 1').bind(today, slot).first();
  if (done) return { skipped: 'already-logged' };
  await setState(env, `cal_prompt_${slot}`, today);
  await setState(env, 'cal_pending', JSON.stringify({ slot, at: now }));
  const label = slot[0].toUpperCase() + slot.slice(1);
  await sendText(env, owner(env), `${cfg.icon} ${label} check! ${cfg.ask} Send a photo and/or a line of text and I'll estimate the calories. (/calorie off to mute these)`);
  return { sent: true };
}

/** Called every minute by the cron: fires the prompts at their times and the summary on Sunday evening. */
export async function runCalorieSchedule(env, now) {
  const d = new Date(now);
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  const at = (value, fallback) => String(value || fallback).split(':').map(Number);
  const out = [];
  for (const [slot, cfg] of Object.entries(SLOTS)) {
    const [h, m] = at(env[`CAL_${slot.toUpperCase()}_TIME_UTC`], cfg.utc);
    if (hour === h && minute === m) out.push(await runCalorieReminder(env, now, slot));
  }
  const [wh, wm] = at(env.CAL_WEEKLY_TIME_UTC, '15:15'); // 15:15 UTC = 20:45 IST
  if (d.getUTCDay() === 0 && hour === wh && minute === wm) out.push(await runCalorieWeekly(env, now));
  return out;
}
