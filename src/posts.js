// LinkedIn post factory: turn saved ideas into drafts in the owner's style and schedule them as reminders.
import { getState } from './db.js';
import { chat } from './llm.js';
import { STYLE_KEY, DEFAULT_STYLE } from './work.js';
import { formatIST, parseIST, startOfISTDay } from './time.js';

const DAY = 24 * 60 * 60 * 1000;
const SLOT_WEEKDAYS = [2, 3, 4]; // Tue, Wed, Thu: when work-feed posts usually get the most eyes
const SLOT_FALLBACK_WEEKDAYS = [1, 5]; // Mon, Fri, if more than three posts are asked for
const DEFAULT_TIME = '09:00';
const MAX_POSTS = 5;

const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const weekdayOf = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();

/** Next free posting slots (IST), after now + 10 minutes, avoiding days that already have a scheduled post. */
export async function nextSlots(env, now, count, time = DEFAULT_TIME) {
  const taken = new Set(
    (await env.DB.prepare("SELECT scheduled_at FROM posts WHERE status = 'scheduled' AND scheduled_at IS NOT NULL").all()).results.map((r) =>
      formatIST(r.scheduled_at).slice(0, 10),
    ),
  );
  const pick = async (weekdays, slots) => {
    for (let i = 0; i < 28 && slots.length < count; i++) {
      const day = formatIST(startOfISTDay(now) + i * DAY).slice(0, 10);
      if (!weekdays.includes(weekdayOf(day)) || taken.has(day)) continue;
      const at = parseIST(`${day} ${time}`);
      if (at !== null && at > now + 10 * 60 * 1000) {
        slots.push(at);
        taken.add(day);
      }
    }
    return slots;
  };
  const slots = await pick(SLOT_WEEKDAYS, []);
  if (slots.length < count) await pick(SLOT_FALLBACK_WEEKDAYS, slots);
  return slots.sort((a, b) => a - b);
}

async function styleBrief(env) {
  let samples = [];
  try {
    samples = JSON.parse((await getState(env, STYLE_KEY)) || '[]');
  } catch {
    samples = [];
  }
  const own = samples.length
    ? `\nSamples of the author's real posts (match their voice, rhythm and humour, never copy lines):\n${samples.map((s, i) => `--- sample ${i + 1}\n${clip(s, 900)}`).join('\n')}`
    : '';
  return `Style: ${DEFAULT_STYLE}${own}`;
}

async function draftPost(env, idea, brief) {
  const text = await chat(
    env,
    [
      {
        role: 'system',
        content: `You ghostwrite LinkedIn posts for a software engineer and AI builder from India. ${brief}\nRules: first line is a strong hook (max 12 words). Short lines with blank lines between. 60 to 150 words. One concrete detail or number from the idea if it has one. End with a light question or a punchline, not a sales pitch. At most 3 hashtags at the very end, or none. No "I'm thrilled to announce", no corporate buzzwords, no emoji spam (max 2). Plain text only, no markdown, no title. Output only the post.`,
      },
      { role: 'user', content: `Idea: ${clip(idea.text, 600)}` },
    ],
    { temperature: 0.7, maxTokens: 450 },
  );
  return clip(text.replace(/^["'\s]+|["'\s]+$/g, '').replace(/\*\*/g, ''), 1300);
}

const shape = (p) => ({ id: p.id, status: p.status, when: p.scheduled_at ? formatIST(p.scheduled_at) : null, text: p.text });

export const POST_TOOLS = {
  /** Draft posts from unused saved ideas and schedule each as a reminder at a good posting time. */
  async plan_posts(env, args, { now }) {
    const count = Math.min(Math.max(Math.round(Number(args.count) || 3), 1), MAX_POSTS);
    const time = /^\d{2}:\d{2}$/.test(String(args.time ?? '')) ? args.time : DEFAULT_TIME;
    const ideas = (
      await env.DB.prepare(
        "SELECT i.id, i.text FROM ideas i WHERE i.kind IN ('linkedin', 'idea') AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.idea_id = i.id AND p.status != 'cancelled') ORDER BY i.id LIMIT ?",
      )
        .bind(count)
        .all()
    ).results;
    if (!ideas.length) {
      return { error: 'No unused post ideas saved yet. Tell me ideas like "idea: why my WhatsApp bot costs ₹0" first.' };
    }
    const brief = await styleBrief(env);
    const drafts = await Promise.all(ideas.map((idea) => draftPost(env, idea, brief).then((text) => ({ idea, text }), () => null)));
    const good = drafts.filter((d) => d && d.text.length > 20);
    if (!good.length) return { error: 'Could not write the drafts just now. Try again in a minute.' };

    const slots = await nextSlots(env, now, good.length, time);
    const posts = [];
    for (let i = 0; i < good.length; i++) {
      const { idea, text } = good[i];
      const at = slots[i] ?? null;
      const post = await env.DB.prepare("INSERT INTO posts (idea_id, text, scheduled_at, status, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(idea.id, text, at, at ? 'scheduled' : 'draft', now)
        .run();
      const id = post.meta.last_row_id;
      if (at) {
        const reminder = await env.DB.prepare(
          "INSERT INTO reminders (text, due_at, repeat, status, created_at) VALUES (?, ?, 'none', 'pending', ?)",
        )
          .bind(`LinkedIn post time 📣 (post #${id})`, at, now)
          .run();
        await env.DB.prepare('UPDATE posts SET reminder_id = ? WHERE id = ?').bind(reminder.meta.last_row_id, id).run();
      }
      posts.push(shape({ id, status: at ? 'scheduled' : 'draft', scheduled_at: at, text }));
    }
    return {
      drafted: posts.length,
      skipped: ideas.length - good.length,
      posts,
      note: 'Each scheduled post pings the user at its time with the full text ready to copy.',
    };
  },

  async list_posts(env, args) {
    const status = ['scheduled', 'sent', 'posted', 'cancelled', 'draft'].includes(args.status) ? args.status : null;
    const rows = (
      await env.DB.prepare(`SELECT id, text, scheduled_at, status FROM posts ${status ? 'WHERE status = ?' : "WHERE status != 'cancelled'"} ORDER BY id DESC LIMIT 15`)
        .bind(...(status ? [status] : []))
        .all()
    ).results;
    return { count: rows.length, posts: rows.map((p) => ({ id: p.id, status: p.status, when: p.scheduled_at ? formatIST(p.scheduled_at) : null, preview: clip(p.text, 80) })) };
  },

  async get_post(env, args) {
    const post = await env.DB.prepare('SELECT id, text, scheduled_at, status FROM posts WHERE id = ?').bind(Number(args.id)).first();
    return post ? shape(post) : { error: 'No post with that id' };
  },

  async edit_post(env, args) {
    const text = clip(args.text, 1300);
    if (text.length < 10) return { error: 'text is required' };
    const r = await env.DB.prepare("UPDATE posts SET text = ? WHERE id = ? AND status != 'cancelled'").bind(text, Number(args.id)).run();
    return r.meta.changes ? { updated: true, id: Number(args.id) } : { error: 'No such post' };
  },

  async mark_posted(env, args) {
    const r = await env.DB.prepare("UPDATE posts SET status = 'posted' WHERE id = ? AND status IN ('scheduled', 'sent', 'draft')").bind(Number(args.id)).run();
    return r.meta.changes ? { posted: true, id: Number(args.id) } : { error: 'No such post' };
  },

  async cancel_post(env, args) {
    const post = await env.DB.prepare("SELECT id, reminder_id FROM posts WHERE id = ? AND status != 'cancelled'").bind(Number(args.id)).first();
    if (!post) return { error: 'No such post' };
    await env.DB.prepare("UPDATE posts SET status = 'cancelled' WHERE id = ?").bind(post.id).run();
    if (post.reminder_id) await env.DB.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending'").bind(post.reminder_id).run();
    return { cancelled: true, id: post.id, note: 'The idea is free to use again.' };
  },
};

/** For the reminder cron: the post attached to a reminder, if any. */
export async function postForReminder(env, reminderId) {
  return env.DB.prepare('SELECT id, text FROM posts WHERE reminder_id = ?').bind(reminderId).first();
}

export async function markPostSent(env, postId) {
  await env.DB.prepare("UPDATE posts SET status = 'sent' WHERE id = ? AND status = 'scheduled'").bind(postId).run();
}
