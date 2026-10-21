// Habit tracker: log a habit for a day, see streaks, and find habits that are about to slip.
import { formatIST } from './time.js';

const DAY = 24 * 60 * 60 * 1000;
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);
const todayIST = (now) => formatIST(now).slice(0, 10);

function habitName(value) {
  const name = String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
  if (!name) throw new Error('habit name is required');
  return name;
}

export function streakOf(days, today) {
  let cur = dayMs(today);
  if (!days.has(today)) cur -= DAY; // today not done yet: the streak is still alive if yesterday was done
  let n = 0;
  while (days.has(dayStr(cur))) {
    n += 1;
    cur -= DAY;
  }
  return n;
}

function bestStreak(days) {
  const sorted = [...days].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of sorted) {
    run = prev !== null && dayMs(d) - prev === DAY ? run + 1 : 1;
    best = Math.max(best, run);
    prev = dayMs(d);
  }
  return best;
}

export async function habitStats(env, habit, today) {
  const rows = (await env.DB.prepare('SELECT day FROM habit_logs WHERE habit_id = ?').bind(habit.id).all()).results;
  const days = new Set(rows.map((r) => r.day));
  const weekAgo = dayStr(dayMs(today) - 6 * DAY);
  return {
    habit: habit.name,
    done_today: days.has(today),
    current_streak: streakOf(days, today),
    best_streak: bestStreak(days),
    total_days: days.size,
    last_7_days: [...days].filter((d) => d >= weekAgo && d <= today).length,
  };
}

export const HABIT_TOOLS = {
  async log_habit(env, args, { now }) {
    const name = habitName(args.name);
    const today = todayIST(now);
    const day = args.date ? String(args.date) : today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(dayMs(day))) return { error: 'date must be YYYY-MM-DD' };
    if (day > today) return { error: 'cannot log a habit for a future day' };
    await env.DB.prepare('INSERT OR IGNORE INTO habits (name, created_at) VALUES (?, ?)').bind(name, now).run();
    const habit = await env.DB.prepare('SELECT id, name FROM habits WHERE name = ?').bind(name).first();
    await env.DB.prepare('INSERT OR IGNORE INTO habit_logs (habit_id, day) VALUES (?, ?)').bind(habit.id, day).run();
    return { logged: true, day, ...(await habitStats(env, habit, today)) };
  },

  async habit_status(env, args, { now }) {
    const today = todayIST(now);
    let habits;
    if (args.name) {
      const one = await env.DB.prepare('SELECT id, name FROM habits WHERE name = ?').bind(habitName(args.name)).first();
      habits = one ? [one] : [];
    } else {
      habits = (await env.DB.prepare('SELECT id, name FROM habits ORDER BY name LIMIT 20').all()).results;
    }
    const out = [];
    for (const h of habits) out.push(await habitStats(env, h, today));
    return { habits: out };
  },

  async delete_habit(env, args) {
    const habit = await env.DB.prepare('SELECT id FROM habits WHERE name = ?').bind(habitName(args.name)).first();
    if (!habit) return { error: 'No habit with that name' };
    await env.DB.prepare('DELETE FROM habit_logs WHERE habit_id = ?').bind(habit.id).run();
    await env.DB.prepare('DELETE FROM habits WHERE id = ?').bind(habit.id).run();
    return { deleted: true };
  },
};

/** Evening nudge text for habits done recently but not yet today. Returns null when nothing to say. */
export async function habitNudge(env, now) {
  const today = todayIST(now);
  const habits = (await env.DB.prepare('SELECT id, name FROM habits').all()).results;
  const slipping = [];
  for (const h of habits) {
    const s = await habitStats(env, h, today);
    if (!s.done_today && s.last_7_days > 0) slipping.push(s);
  }
  if (!slipping.length) return null;
  const lines = slipping.map((s) =>
    s.current_streak > 0 ? `- ${s.habit}: ${s.current_streak}-day streak on the line 🔥` : `- ${s.habit}: not done today`,
  );
  return `Quick check before the day ends 👀\n${lines.join('\n')}\nReply "did ${slipping[0].habit} today" when done.`;
}
