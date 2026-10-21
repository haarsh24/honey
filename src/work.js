// Work helpers: save standup notes and post ideas, remember the owner's writing style, gather standup data.
import { getState, setState } from './db.js';
import { formatIST, startOfISTDay } from './time.js';

const KINDS = ['standup', 'linkedin', 'idea'];
export const STYLE_KEY = 'writing_samples';
export const DEFAULT_STYLE =
  'Short and punchy. Strong hook in the first line. Dry humor. Casual, human, never corporate. Hinglish-friendly. Absurdist tech jokes and light meta-irony about AI and LinkedIn are welcome. No hashtag spam.';

const clean = (v, max = 1500) => {
  if (typeof v !== 'string' || !v.trim()) throw new Error('text is required');
  return v.trim().slice(0, max);
};

export const WORK_TOOLS = {
  async save_idea(env, args, { now }) {
    const kind = KINDS.includes(args.kind) ? args.kind : 'idea';
    const result = await env.DB.prepare('INSERT INTO ideas (kind, text, created_at) VALUES (?, ?, ?)')
      .bind(kind, clean(args.text), now)
      .run();
    return { saved: true, id: result.meta.last_row_id, kind };
  },

  async list_ideas(env, args) {
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
    const where = [];
    const params = [];
    if (KINDS.includes(args.kind)) {
      where.push('kind = ?');
      params.push(args.kind);
    }
    if (typeof args.query === 'string' && args.query.trim()) {
      where.push("text LIKE ? ESCAPE '\\'");
      params.push(`%${args.query.trim().replace(/[\\%_]/g, '\\$&')}%`);
    }
    const sql = `SELECT id, kind, text, created_at FROM ideas ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    const rows = (await env.DB.prepare(sql).bind(...params, limit).all()).results;
    return { ideas: rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, saved: formatIST(r.created_at).slice(0, 10) })) };
  },

  async delete_idea(env, args) {
    const id = Number(args.id);
    if (!Number.isInteger(id) || id <= 0) return { error: 'id must be a positive whole number' };
    const r = await env.DB.prepare('DELETE FROM ideas WHERE id = ?').bind(id).run();
    return r.meta.changes ? { deleted: true } : { error: 'No idea with that id' };
  },

  /** Remember a sample of the owner's own writing; the last 5 are kept. */
  async save_style(env, args) {
    let samples = [];
    try {
      samples = JSON.parse((await getState(env, STYLE_KEY)) || '[]');
    } catch {
      samples = [];
    }
    samples.push(clean(args.text, 1200));
    samples = samples.slice(-5);
    await setState(env, STYLE_KEY, JSON.stringify(samples));
    return { saved: true, samples_kept: samples.length };
  },

  async get_style(env) {
    let samples = [];
    try {
      samples = JSON.parse((await getState(env, STYLE_KEY)) || '[]');
    } catch {
      samples = [];
    }
    return { default_style: DEFAULT_STYLE, own_samples: samples };
  },

  /** Everything needed to write a standup update. */
  async standup_data(env, args, { now }) {
    const todayStart = startOfISTDay(now);
    const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
    const done = (
      await env.DB.prepare("SELECT text FROM tasks WHERE status = 'done' AND done_at >= ? ORDER BY done_at DESC LIMIT 15")
        .bind(yesterdayStart)
        .all()
    ).results.map((r) => r.text);
    const open = (await env.DB.prepare("SELECT text FROM tasks WHERE status = 'open' ORDER BY id LIMIT 10").all()).results.map((r) => r.text);
    const notes = (
      await env.DB.prepare("SELECT text FROM ideas WHERE kind = 'standup' AND created_at >= ? ORDER BY id LIMIT 15")
        .bind(yesterdayStart)
        .all()
    ).results.map((r) => r.text);
    return { finished_since_yesterday: done, open_tasks: open, standup_notes: notes };
  },
};
