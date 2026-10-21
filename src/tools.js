import { getState, setState } from './db.js';
import { formatIST, istParts, parseIST, startOfISTDay, startOfPeriod } from './time.js';
import { geminiWeb, searchUrl } from './gemini.js';
import { HABIT_TOOLS } from './habits.js';
import { MARKET_TOOLS } from './markets.js';
import { DIGEST_TOOLS } from './digest.js';
import { WORK_TOOLS } from './work.js';
import { EXTRA_TOOLS, rememberAction } from './extras.js';

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

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Small safe calculator: numbers, + - * / ^ and parentheses. */
export function evaluate(source) {
  const src = String(source ?? '').replace(/,/g, '').replace(/[×x]/g, '*').replace(/÷/g, '/');
  if (src.length > 200) throw new Error('Expression too long');
  const tokens = [];
  const re = /\s*(\d+\.?\d*|\.\d+|[()+\-*\/^])/y;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) {
      if (src.slice(pos).trim() === '') break;
      throw new Error('Unsupported characters in expression');
    }
    tokens.push(m[1]);
    pos = re.lastIndex;
  }
  let i = 0;
  const peek = () => tokens[i];
  const atom = () => {
    const t = tokens[i++];
    if (t === '(') {
      const v = expr();
      if (tokens[i++] !== ')') throw new Error('Missing closing bracket');
      return v;
    }
    if (t === undefined || !/^[\d.]/.test(t)) throw new Error('Bad expression');
    return parseFloat(t);
  };
  const unary = () => {
    if (peek() === '-') { i++; return -unary(); }
    if (peek() === '+') { i++; return unary(); }
    return atom();
  };
  const power = () => {
    const base = unary();
    if (peek() === '^') { i++; return base ** power(); }
    return base;
  };
  const term = () => {
    let v = power();
    while (peek() === '*' || peek() === '/') {
      const op = tokens[i++];
      const r = power();
      if (op === '/' && r === 0) throw new Error('Division by zero');
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = tokens[i++];
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  const value = expr();
  if (i !== tokens.length) throw new Error('Bad expression');
  if (!Number.isFinite(value)) throw new Error('Result is not a finite number');
  return value;
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
- complete_task {"id": number}
- save_meeting {"title": string, "summary": string, "action_items": string[]}
- save_journal {"text": string, "date"?: "YYYY-MM-DD"}
- search_journal {"query"?: string, "date"?: "YYYY-MM-DD", "limit"?: number}
- calc_date {"date"?: "YYYY-MM-DD" (default today), "date2"?: "YYYY-MM-DD", "add_days"?: number}
- calculate {"expression": string} (numbers, + - * / ^ and brackets)
- convert_currency {"amount": number, "from": "USD", "to": "INR"}
- add_countdown {"label": string, "date": "YYYY-MM-DD"}
- list_countdowns {}
- delete_countdown {"id": number}
- learn_topic {"topic": string} (starts a daily quiz on that topic)
- learn_off {}
- quiz_done {"correct": boolean} (call after grading a quiz answer)
- web_search {"query": string} (live Google search: news, prices, facts, anything current)
- read_url {"url": string, "question"?: string} (opens a web page the user shared and answers from it)
- log_habit {"name": string, "date"?: "YYYY-MM-DD"} (marks a habit done, e.g. gym; creates it if new; returns streaks)
- habit_status {"name"?: string}
- delete_habit {"name": string}
- set_news_topics {"topics": string[]} (1-4 topics for the daily 8:30 AM digest)
- news_now {"topic"?: string} (headlines now for the saved topics, or one topic)
- stop_news {}
- price_check {"symbol": string} (Indian stock name or NSE ticker like RELIANCE; also US tickers, NIFTY, SENSEX)
- mf_nav {"name": string} (mutual fund NAV; returns scheme_code)
- watch_price {"target": string (stock, or "mf:<scheme_code>"), "above"?: number, "below"?: number} (ping when the price crosses)
- list_watches {}
- remove_watch {"id": number}
- save_idea {"kind": "standup"|"linkedin"|"idea", "text": string}
- list_ideas {"kind"?: string, "query"?: string, "limit"?: number}
- delete_idea {"id": number}
- save_style {"text": string} (a sample of the user's own writing, to imitate later)
- get_style {} (the user's writing style and saved samples)
- standup_data {} (finished and open tasks plus standup notes, to write a standup update)
- snooze_reminder {"minutes"?: number (default 10), "id"?: number} (push the reminder that just rang by some minutes)
- undo_last {} (removes the last note, reminder, expense, task or habit entry that was added)
- weather {"city"?: string} (today's forecast; default city is the user's home city)`;

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
    const shape = (rows) => rows.map((r) => ({ id: r.id, text: r.text, saved: formatIST(r.created_at) }));
    if (results.length === 0 && words.length > 0) {
      // No keyword hit: hand back recent notes so the model can pick by meaning.
      const recent = await env.DB.prepare(
        'SELECT id, text, created_at FROM notes ORDER BY id DESC LIMIT 40',
      ).all();
      return {
        count: 0,
        note: 'No keyword match. These are the most recent notes; pick any that match the question by meaning, or say nothing was found.',
        recent_notes: shape(recent.results),
      };
    }
    return { count: results.length, notes: shape(results) };
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
  async save_meeting(env, args, { now }) {
    const title = cleanText(args.title, 'title').slice(0, 100);
    const summary = cleanText(args.summary, 'summary');
    const items = (Array.isArray(args.action_items) ? args.action_items : [])
      .filter((x) => typeof x === 'string' && x.trim())
      .slice(0, 10);
    const day = formatIST(now).slice(0, 10);
    const note = await env.DB.prepare('INSERT INTO notes (text, created_at) VALUES (?, ?)')
      .bind(`Meeting (${day}) ${title}: ${summary}`.slice(0, MAX_TEXT), now)
      .run();
    const taskIds = [];
    for (const item of items) {
      const r = await env.DB.prepare("INSERT INTO tasks (text, status, created_at) VALUES (?, 'open', ?)")
        .bind(item.trim().slice(0, MAX_TEXT), now)
        .run();
      taskIds.push(r.meta.last_row_id);
    }
    return { saved: true, note_id: note.meta.last_row_id, tasks_added: taskIds.length, task_ids: taskIds };
  },

  async save_journal(env, args, { now }) {
    const text = cleanText(args.text);
    let day = formatIST(now).slice(0, 10);
    if (typeof args.date === 'string' && args.date.trim()) {
      if (parseIST(args.date, '12:00') === null) return { error: 'date must look like 2026-10-15' };
      day = args.date.trim().slice(0, 10);
    }
    const result = await env.DB.prepare('INSERT INTO journal (day, text, created_at) VALUES (?, ?, ?)')
      .bind(day, text, now)
      .run();
    await setState(env, 'journal_pending', '');
    return { saved: true, id: result.meta.last_row_id, day };
  },

  async search_journal(env, args) {
    const limit = toLimit(args.limit, 10);
    const shape = (rows) => rows.map((r) => ({ id: r.id, day: r.day, text: r.text }));
    if (typeof args.date === 'string' && args.date.trim()) {
      const { results } = await env.DB.prepare('SELECT id, day, text FROM journal WHERE day = ? ORDER BY id')
        .bind(args.date.trim().slice(0, 10))
        .all();
      return { count: results.length, entries: shape(results) };
    }
    const words = String(args.query ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 1).slice(0, 5);
    if (words.length) {
      const where = words.map(() => "LOWER(text) LIKE ? ESCAPE '\\'").join(' OR ');
      const { results } = await env.DB.prepare(
        `SELECT id, day, text FROM journal WHERE ${where} ORDER BY day DESC, id DESC LIMIT ?`,
      )
        .bind(...words.map((w) => `%${likeEscape(w)}%`), limit)
        .all();
      if (results.length) return { count: results.length, entries: shape(results) };
      const recent = await env.DB.prepare('SELECT id, day, text FROM journal ORDER BY day DESC, id DESC LIMIT 30').all();
      return {
        count: 0,
        note: 'No keyword match. These are the most recent entries; pick any that match by meaning, or say nothing was found.',
        recent_entries: shape(recent.results),
      };
    }
    const { results } = await env.DB.prepare('SELECT id, day, text FROM journal ORDER BY day DESC, id DESC LIMIT ?')
      .bind(limit)
      .all();
    return { count: results.length, entries: shape(results) };
  },

  async calc_date(env, args, { now }) {
    const today = startOfISTDay(now);
    const base = args.date ? parseIST(String(args.date), '00:00') : today;
    if (base === null) return { error: 'date must look like 2026-10-15' };
    const fmt = (ms) => `${formatIST(ms).slice(0, 10)} (${WEEKDAYS[istParts(ms).wd]})`;
    const out = { date: fmt(base), days_from_today: Math.round((base - today) / DAY_MS) };
    if (args.date2) {
      const other = parseIST(String(args.date2), '00:00');
      if (other === null) return { error: 'date2 must look like 2026-10-15' };
      const days = Math.round((other - base) / DAY_MS);
      out.date2 = fmt(other);
      out.days_between = days;
      out.weeks_between = Math.round((days / 7) * 10) / 10;
    }
    if (args.add_days !== undefined) {
      const n = Number(args.add_days);
      if (!Number.isInteger(n) || Math.abs(n) > 36500) return { error: 'add_days must be a whole number' };
      out.after_adding = fmt(base + n * DAY_MS);
    }
    return out;
  },

  async calculate(env, args) {
    const value = evaluate(args.expression);
    return { expression: String(args.expression), result: Math.round(value * 1e10) / 1e10 };
  },

  async convert_currency(env, args) {
    const amount = Number(args.amount);
    const from = String(args.from ?? '').toUpperCase();
    const to = String(args.to ?? '').toUpperCase();
    if (!Number.isFinite(amount)) return { error: 'amount must be a number' };
    if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) return { error: 'currency codes must be 3 letters, like USD' };
    if (from === to) return { amount, from, to, result: amount, rate: 1 };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`, {
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      const rate = data?.rates?.[to];
      if (!response.ok || typeof rate !== 'number') return { error: `Could not get a rate for ${from} to ${to}` };
      return { amount, from, to, rate, result: Math.round(amount * rate * 100) / 100, rate_date: data.date, source: 'ECB reference rates' };
    } catch {
      return { error: 'Currency service did not respond. Try again in a bit.' };
    } finally {
      clearTimeout(timer);
    }
  },

  async add_countdown(env, args, { now }) {
    const label = cleanText(args.label, 'label').slice(0, 80);
    const target = parseIST(String(args.date ?? ''), '00:00');
    if (target === null) return { error: 'date must look like 2026-10-15' };
    if (target < startOfISTDay(now)) return { error: 'That date is already in the past.' };
    const result = await env.DB.prepare('INSERT INTO countdowns (label, target_at, created_at) VALUES (?, ?, ?)')
      .bind(label, target, now)
      .run();
    return { saved: true, id: result.meta.last_row_id, days_to_go: Math.round((target - startOfISTDay(now)) / DAY_MS) };
  },

  async list_countdowns(env, args, { now }) {
    const today = startOfISTDay(now);
    const { results } = await env.DB.prepare(
      'SELECT id, label, target_at FROM countdowns WHERE target_at >= ? ORDER BY target_at LIMIT 20',
    )
      .bind(today)
      .all();
    return {
      count: results.length,
      countdowns: results.map((r) => ({ id: r.id, label: r.label, date: formatIST(r.target_at).slice(0, 10), days_to_go: Math.round((r.target_at - today) / DAY_MS) })),
    };
  },

  async delete_countdown(env, args) {
    const result = await env.DB.prepare('DELETE FROM countdowns WHERE id = ?').bind(toId(args.id)).run();
    return { deleted: result.meta.changes > 0 };
  },

  async learn_topic(env, args, { now }) {
    const topic = cleanText(args.topic, 'topic').slice(0, 80);
    await setState(env, 'learn_topic', topic);
    await setState(env, 'quiz_recent', '[]');
    return { saved: true, topic, note: 'A daily quiz question will arrive at 1:00 PM IST. The user can also send /quiz any time.' };
  },

  async learn_off(env) {
    await setState(env, 'learn_topic', '');
    await setState(env, 'quiz_pending', '');
    return { stopped: true };
  },

  async quiz_done(env, args) {
    let stats = { correct: 0, total: 0 };
    try {
      stats = { ...stats, ...JSON.parse((await getState(env, 'quiz_stats')) || '{}') };
    } catch {
      /* start fresh */
    }
    stats.total += 1;
    if (args.correct === true || args.correct === 'true') stats.correct += 1;
    await setState(env, 'quiz_stats', JSON.stringify(stats));
    await setState(env, 'quiz_pending', '');
    return { recorded: true, score: `${stats.correct}/${stats.total}` };
  },
};

Object.assign(TOOLS, HABIT_TOOLS, MARKET_TOOLS, DIGEST_TOOLS, WORK_TOOLS, EXTRA_TOOLS);

TOOLS.web_search = async (env, args) => {
  const query = cleanText(args.query);
  const { text } = await geminiWeb(env, {
    prompt: `Read this web search results page: ${searchUrl(query)}\n\nUsing the result titles and snippets, answer the question briefly (under 120 words) with specific numbers and dates where they appear. Name the sites you relied on. If the page does not contain the answer, say so plainly.\n\nQuestion: ${query}`,
  });
  return { answer: text };
};

TOOLS.read_url = async (env, args) => {
  const url = String(args.url ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return { error: 'url must start with http:// or https://' };
  const question = args.question ? cleanText(args.question) : 'Summarise the main points in 5 short bullets.';
  const { text } = await geminiWeb(env, {
    prompt: `Read this page: ${url}\n\nTask: ${question}\nBe brief (under 150 words) and only use what the page says.`,
  });
  return { url, answer: text };
};

export async function runTool(env, name, args, ctx) {
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
  if (!tool) return { error: `Unknown tool "${name}"` };
  try {
    const result = await tool(env, args && typeof args === 'object' ? args : {}, ctx);
    await rememberAction(env, name, result);
    return result;
  } catch (error) {
    return { error: error.message };
  }
}
