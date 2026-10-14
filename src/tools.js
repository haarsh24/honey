import { formatIST, parseIST, startOfPeriod } from './time.js';

const MAX_TEXT = 2000;
const REPEATS = ['none', 'daily', 'weekly', 'monthly'];
const PERIODS = ['today', 'week', 'month', 'all'];

function cleanText(value, field = 'text') {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim().slice(0, MAX_TEXT);
}

function toId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error('id must be a positive whole number');
  return n;
}

function toLimit(value, fallback = 10) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, 20);
}

const round2 = (n) => Math.round(n * 100) / 100;
const likeEscape = (s) => s.replace(/[\\%_]/g, '\\$&');

export const TOOL_HELP = `- save_note {"text": string}
- search_notes {"query": string}
- list_notes {"limit"?: number}
- delete_note {"id": number}
- add_reminder {"text": string, "when": "YYYY-MM-DD HH:MM" (IST, 24-hour), "repeat": "none"|"daily"|"weekly"|"monthly"}
- list_reminders {}
- cancel_reminder {"id": number}
- log_expense {"amount": number (INR), "category": string, "note"?: string, "date"?: "YYYY-MM-DD"}
- list_expenses {"limit"?: number}
- delete_expense {"id": number}
- expense_summary {"period": "today"|"week"|"month"|"all", "category"?: string}
- add_task {"text": string}
- list_tasks {}
- complete_task {"id": number}`;

export const TOOLS = {
  async save_note(env, args, { now }) {
    const text = cleanText(args.text);
    const result = await env.DB.prepare('INSERT INTO notes (text, created_at) VALUES (?, ?)')
      .bind(text, now)
      .run();
    return { saved: true, id: result.meta.last_row_id };
  },

  async search_notes(env, args) {
    const words = String(args.query ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .slice(0, 5);
    let statement;
    if (words.length === 0) {
      statement = env.DB.prepare('SELECT id, text, created_at FROM notes ORDER BY id DESC LIMIT 10');
    } else {
      const where = words.map(() => "LOWER(text) LIKE ? ESCAPE '\\'").join(' OR ');
      statement = env.DB.prepare(
        `SELECT id, text, created_at FROM notes WHERE ${where} ORDER BY id DESC LIMIT 10`,
      ).bind(...words.map((w) => `%${likeEscape(w)}%`));
    }
    const { results } = await statement.all();
    return {
      count: results.length,
      notes: results.map((r) => ({ id: r.id, text: r.text, saved: formatIST(r.created_at) })),
    };
  },

  async list_notes(env, args) {
    const { results } = await env.DB.prepare(
      'SELECT id, text, created_at FROM notes ORDER BY id DESC LIMIT ?',
    )
      .bind(toLimit(args.limit))
      .all();
    return {
      count: results.length,
      notes: results.map((r) => ({ id: r.id, text: r.text, saved: formatIST(r.created_at) })),
    };
  },

  async delete_note(env, args) {
    const result = await env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(toId(args.id)).run();
    return { deleted: result.meta.changes > 0 };
  },

  async add_reminder(env, args, { now }) {
    const text = cleanText(args.text);
    const due = parseIST(args.when);
    if (due === null) {
      return { error: 'Invalid time. "when" must look like 2026-10-15 18:00 (IST, 24-hour clock).' };
    }
    if (due < now - 30000) return { error: 'That time is already in the past. Ask the user for a future time.' };
    const repeat = REPEATS.includes(args.repeat) ? args.repeat : 'none';
    const result = await env.DB.prepare(
      "INSERT INTO reminders (text, due_at, repeat, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
    )
      .bind(text, due, repeat, now)
      .run();
    return { saved: true, id: result.meta.last_row_id, due_ist: formatIST(due), repeat };
  },

  async list_reminders(env) {
    const { results } = await env.DB.prepare(
      "SELECT id, text, due_at, repeat FROM reminders WHERE status = 'pending' ORDER BY due_at LIMIT 20",
    ).all();
    return {
      count: results.length,
      reminders: results.map((r) => ({
        id: r.id,
        text: r.text,
        due_ist: formatIST(r.due_at),
        repeat: r.repeat,
      })),
    };
  },

  async cancel_reminder(env, args) {
    const result = await env.DB.prepare(
      "UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'missed')",
    )
      .bind(toId(args.id))
      .run();
    return { cancelled: result.meta.changes > 0 };
  },

  async log_expense(env, args, { now }) {
    const amount = Number(args.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) {
      return { error: 'amount must be a positive number' };
    }
    const category =
      typeof args.category === 'string' && args.category.trim()
        ? args.category.trim().toLowerCase().slice(0, 30)
        : 'other';
    const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim().slice(0, 200) : null;
    let spentAt = now;
    if (typeof args.date === 'string' && args.date.trim()) {
      spentAt = parseIST(args.date, '12:00');
      if (spentAt === null) return { error: 'date must look like 2026-10-15' };
    }
    const result = await env.DB.prepare(
      'INSERT INTO expenses (amount, category, note, spent_at) VALUES (?, ?, ?, ?)',
    )
      .bind(round2(amount), category, note, spentAt)
      .run();
    return { saved: true, id: result.meta.last_row_id, amount: round2(amount), category, date: formatIST(spentAt) };
  },

  async list_expenses(env, args) {
    const { results } = await env.DB.prepare(
      'SELECT id, amount, category, note, spent_at FROM expenses ORDER BY spent_at DESC, id DESC LIMIT ?',
    )
      .bind(toLimit(args.limit))
      .all();
    return {
      count: results.length,
      expenses: results.map((r) => ({
        id: r.id,
        amount: r.amount,
        category: r.category,
        note: r.note,
        date: formatIST(r.spent_at),
      })),
    };
  },

  async delete_expense(env, args) {
    const result = await env.DB.prepare('DELETE FROM expenses WHERE id = ?').bind(toId(args.id)).run();
    return { deleted: result.meta.changes > 0 };
  },

  async expense_summary(env, args, { now }) {
    const period = PERIODS.includes(args.period) ? args.period : 'month';
    const since = startOfPeriod(period, now);
    const category =
      typeof args.category === 'string' && args.category.trim()
        ? args.category.trim().toLowerCase().slice(0, 30)
        : null;
    let sql =
      'SELECT category, SUM(amount) AS total, COUNT(*) AS n FROM expenses WHERE spent_at >= ?';
    const binds = [since];
    if (category) {
      sql += ' AND category = ?';
      binds.push(category);
    }
    sql += ' GROUP BY category ORDER BY total DESC';
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    const total = results.reduce((sum, r) => sum + r.total, 0);
    const count = results.reduce((sum, r) => sum + r.n, 0);
    return {
      period,
      from_ist: period === 'all' ? 'beginning' : formatIST(since),
      total: round2(total),
      count,
      by_category: results.map((r) => ({ category: r.category, total: round2(r.total), count: r.n })),
    };
  },

  async add_task(env, args, { now }) {
    const text = cleanText(args.text);
    const result = await env.DB.prepare("INSERT INTO tasks (text, status, created_at) VALUES (?, 'open', ?)")
      .bind(text, now)
      .run();
    return { saved: true, id: result.meta.last_row_id };
  },

  async list_tasks(env) {
    const { results } = await env.DB.prepare(
      "SELECT id, text, created_at FROM tasks WHERE status = 'open' ORDER BY id LIMIT 30",
    ).all();
    return {
      count: results.length,
      tasks: results.map((r) => ({ id: r.id, text: r.text, added: formatIST(r.created_at) })),
    };
  },

  async complete_task(env, args, { now }) {
    const result = await env.DB.prepare(
      "UPDATE tasks SET status = 'done', done_at = ? WHERE id = ? AND status = 'open'",
    )
      .bind(now, toId(args.id))
      .run();
    return { completed: result.meta.changes > 0 };
  },
};

export async function runTool(env, name, args, ctx) {
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
  if (!tool) return { error: `Unknown tool "${name}"` };
  try {
    return await tool(env, args && typeof args === 'object' ? args : {}, ctx);
  } catch (error) {
    return { error: error.message };
  }
}
