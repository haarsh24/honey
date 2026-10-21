// Small quality-of-life tools: snooze, undo, weather, plus the morning jokes.
import { getState, setState } from './db.js';
import { formatIST } from './time.js';

const MINUTE = 60 * 1000;
const TABLES = { notes: 'notes', reminders: 'reminders', expenses: 'expenses', tasks: 'tasks' };

/** Which tool results count as "the last thing I added", for undo. */
const UNDOABLE = { save_note: 'notes', add_reminder: 'reminders', log_expense: 'expenses', add_task: 'tasks' };

export async function rememberAction(env, toolName, result) {
  try {
    if (!result || result.error) return;
    if (UNDOABLE[toolName] && result.id) {
      await setState(env, 'last_action', JSON.stringify({ table: UNDOABLE[toolName], id: result.id }));
    } else if (toolName === 'log_habit' && result.logged && result.habit && result.day) {
      await setState(env, 'last_action', JSON.stringify({ habit: result.habit, day: result.day }));
    }
  } catch {
    /* undo is a nice-to-have; never break a tool call */
  }
}

const WEATHER_CODES = [
  [[0], 'clear sky ☀️'],
  [[1, 2], 'mostly clear 🌤️'],
  [[3], 'cloudy ☁️'],
  [[45, 48], 'foggy 🌫️'],
  [[51, 53, 55, 56, 57], 'drizzly 🌦️'],
  [[61, 63, 65, 66, 67, 80, 81, 82], 'rainy 🌧️'],
  [[71, 73, 75, 77, 85, 86], 'snowy ❄️'],
  [[95, 96, 99], 'thunderstorms ⛈️'],
];
const describeCode = (code) => WEATHER_CODES.find(([codes]) => codes.includes(code))?.[1] ?? 'mixed weather';

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok ? await response.json().catch(() => null) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Today's forecast for a city (free Open-Meteo, no key). Returns null when unavailable. */
export async function todaysWeather(env, city) {
  const name = String(city || env.WEATHER_CITY || 'Ranchi').trim().slice(0, 60);
  const geo = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1`);
  const place = geo?.results?.[0];
  if (!place) return null;
  const data = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=Asia%2FKolkata&forecast_days=1',
  );
  const d = data?.daily;
  if (!d?.temperature_2m_max?.length) return null;
  return {
    city: place.name,
    summary: describeCode(d.weather_code?.[0]),
    high_c: Math.round(d.temperature_2m_max[0]),
    low_c: Math.round(d.temperature_2m_min[0]),
    rain_chance_pct: d.precipitation_probability_max?.[0] ?? null,
  };
}

export function weatherLine(w) {
  if (!w) return null;
  const rain = typeof w.rain_chance_pct === 'number' && w.rain_chance_pct >= 40 ? ` Rain chance ${w.rain_chance_pct}%, carry an umbrella ☂️` : '';
  return `${w.city}: ${w.summary}, ${w.low_c}° to ${w.high_c}°C.${rain}`;
}

export const EXTRA_TOOLS = {
  /** Push the reminder that just rang (or a given one) by some minutes, as a new one-time reminder. */
  async snooze_reminder(env, args, { now }) {
    const minutes = Math.min(Math.max(Math.round(Number(args.minutes) || 10), 1), 24 * 60);
    let text;
    if (args.id) {
      const row = await env.DB.prepare('SELECT text FROM reminders WHERE id = ?').bind(Number(args.id)).first();
      text = row?.text;
    } else {
      try {
        text = JSON.parse((await getState(env, 'last_reminder')) || 'null')?.text;
      } catch {
        text = undefined;
      }
    }
    if (!text) return { error: 'No recent reminder to snooze. Tell me what to remind you about and when.' };
    const due = now + minutes * MINUTE;
    const result = await env.DB.prepare(
      "INSERT INTO reminders (text, due_at, repeat, status, created_at) VALUES (?, ?, 'none', 'pending', ?)",
    )
      .bind(text, due, now)
      .run();
    return { snoozed: true, id: result.meta.last_row_id, text, minutes, due_ist: formatIST(due) };
  },

  /** Remove the last note, reminder, expense, task or habit entry the assistant added. */
  async undo_last(env) {
    let action;
    try {
      action = JSON.parse((await getState(env, 'last_action')) || 'null');
    } catch {
      action = null;
    }
    if (!action) return { error: 'Nothing to undo right now.' };
    await setState(env, 'last_action', '');
    if (action.table && TABLES[action.table]) {
      const row = await env.DB.prepare(`SELECT * FROM ${TABLES[action.table]} WHERE id = ?`).bind(action.id).first();
      if (!row) return { error: 'That entry is already gone.' };
      await env.DB.prepare(`DELETE FROM ${TABLES[action.table]} WHERE id = ?`).bind(action.id).run();
      return { undone: true, removed: action.table.replace(/s$/, ''), text: row.text ?? row.note ?? `${row.amount} ${row.category}` };
    }
    if (action.habit) {
      const habit = await env.DB.prepare('SELECT id FROM habits WHERE name = ?').bind(action.habit).first();
      if (!habit) return { error: 'That habit is already gone.' };
      await env.DB.prepare('DELETE FROM habit_logs WHERE habit_id = ? AND day = ?').bind(habit.id, action.day).run();
      return { undone: true, removed: `${action.habit} on ${action.day}` };
    }
    return { error: 'Nothing to undo right now.' };
  },

  async weather(env, args) {
    const w = await todaysWeather(env, args.city);
    return w ?? { error: `Could not get the weather for "${args.city || env.WEATHER_CITY || 'Ranchi'}" right now.` };
  },
};

// Morning openers: no AI call needed, so the briefing stays fast and free.
const OPENERS = [
  'Rise and shine. Or at least rise. Shining is optional ☕',
  'Your to-do list woke up before you did. Overachiever.',
  'Good news: it is not Monday. Bad news: I checked, it might be.',
  'Chai first, productivity second. That is the law.',
  'I ran the numbers: today is a great day to do exactly one important thing.',
  'The sun is up, the traffic is up, and so are your reminders.',
  'Another day, another chance to pretend we have it all together 😎',
  'Fun fact: tasks do not complete themselves. I checked. Twice.',
  'Plot twist: today you are the main character. Act accordingly.',
  'Mummy would say "uth jao". I am just a polite bot, so: good morning.',
  'Wifi is up, spirits are up, expectations are reasonable. Let us go.',
  'Today is brought to you by caffeine and questionable optimism.',
];

export function morningOpener(nowMs) {
  const day = Math.floor((nowMs + 330 * MINUTE) / (24 * 60 * MINUTE));
  return OPENERS[day % OPENERS.length];
}
