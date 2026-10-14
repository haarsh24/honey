import { getState, setState } from './db.js';
import { ownerNumber } from './handler.js';
import { chat } from './llm.js';
import { inReplyWindow, sendProactive } from './outbound.js';
import { sendText } from './whatsapp.js';
import { describeIST, formatIST, startOfISTDay, startOfPeriod } from './time.js';
import { TOOLS } from './tools.js';

const DAY = 24 * 60 * 60 * 1000;
const money = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export async function briefingEnabled(env) {
  return (await getState(env, 'briefing_enabled')) !== 'off';
}

export async function buildBriefing(env, nowMs) {
  const dayStart = startOfISTDay(nowMs);
  const reminders = (
    await env.DB.prepare(
      "SELECT text, due_at FROM reminders WHERE status = 'pending' AND due_at >= ? AND due_at < ? ORDER BY due_at LIMIT 10",
    )
      .bind(dayStart, dayStart + DAY)
      .all()
  ).results;
  const tasks = (
    await env.DB.prepare("SELECT text FROM tasks WHERE status = 'open' ORDER BY id LIMIT 30").all()
  ).results;
  const spent = (
    await env.DB.prepare(
      'SELECT category, SUM(amount) AS total FROM expenses WHERE spent_at >= ? AND spent_at < ? GROUP BY category ORDER BY total DESC',
    )
      .bind(dayStart - DAY, dayStart)
      .all()
  ).results;

  const countdowns = (
    await env.DB.prepare('SELECT label, target_at FROM countdowns WHERE target_at >= ? ORDER BY target_at LIMIT 3')
      .bind(dayStart)
      .all()
  ).results;

  const lines = [`Good morning! ☀️ ${describeIST(nowMs).slice(0, 10)}`];
  if (reminders.length) {
    lines.push('Today:', ...reminders.map((r) => `- ${formatIST(r.due_at).slice(11)} ${r.text}`));
  } else {
    lines.push('Nothing on the reminder list today. Free as a bird 🐦');
  }
  if (tasks.length) {
    lines.push(`Open tasks (${tasks.length}):`, ...tasks.slice(0, 5).map((t) => `- ${t.text}`));
    if (tasks.length > 5) lines.push(`...and ${tasks.length - 5} more`);
  }
  if (spent.length) {
    const total = spent.reduce((s, r) => s + r.total, 0);
    lines.push(`Yesterday you spent ${money(total)} (${spent.map((r) => `${r.category} ${money(r.total)}`).join(', ')}).`);
  }
  for (const c of countdowns) {
    const days = Math.round((c.target_at - dayStart) / DAY);
    lines.push(`⏳ ${c.label}: ${days === 0 ? 'today!' : `${days} day${days === 1 ? '' : 's'} to go`}`);
  }
  lines.push('Say /briefing off if I get too chatty.');

  const compact =
    `Good morning! ${reminders.length ? `Today: ${reminders.map((r) => `${formatIST(r.due_at).slice(11)} ${r.text}`).join('; ')}.` : 'No reminders today.'}` +
    `${tasks.length ? ` ${tasks.length} open tasks.` : ''}`;
  return { text: lines.join('\n'), compact };
}

/** Called by the cron at the briefing time. Sends at most once per IST day. */
export async function runBriefing(env, nowMs) {
  if (!(await briefingEnabled(env))) return { skipped: 'off' };
  const today = formatIST(nowMs).slice(0, 10);
  if ((await getState(env, 'last_briefing_date')) === today) return { skipped: 'already-sent' };
  await setState(env, 'last_briefing_date', today);
  const { text, compact } = await buildBriefing(env, nowMs);
  await sendProactive(env, ownerNumber(env), text, compact, nowMs);
  return { sent: true };
}

/** Sunday evening review: spending, finished tasks, missed reminders, journal, quiz score, one suggestion. */
export async function runWeekly(env, nowMs) {
  if (!(await briefingEnabled(env))) return { skipped: 'off' };
  const today = formatIST(nowMs).slice(0, 10);
  if ((await getState(env, 'last_weekly_date')) === today) return { skipped: 'already-sent' };

  const weekStart = startOfPeriod('week', nowMs);
  const spend = await TOOLS.expense_summary(env, { period: 'week' }, { now: nowMs });
  const done = (
    await env.DB.prepare("SELECT text FROM tasks WHERE status = 'done' AND done_at >= ? ORDER BY done_at DESC LIMIT 20")
      .bind(weekStart)
      .all()
  ).results;
  const open = (await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'").first())?.n ?? 0;
  const missed = (
    await env.DB.prepare("SELECT COUNT(*) AS n FROM reminders WHERE attempts >= 3 AND due_at >= ?").bind(weekStart).first()
  )?.n ?? 0;
  const journal = (
    await env.DB.prepare('SELECT COUNT(*) AS n FROM journal WHERE created_at >= ?').bind(weekStart).first()
  )?.n ?? 0;
  let quiz = null;
  try {
    const q = JSON.parse((await getState(env, 'quiz_stats')) || 'null');
    if (q?.total) quiz = `${q.correct}/${q.total}`;
  } catch {
    /* ignore */
  }

  if (!spend.count && !done.length && !journal && !missed && !quiz) return { skipped: 'no-activity' };
  await setState(env, 'last_weekly_date', today);

  const lines = ['Your week in review 📊'];
  if (spend.count) {
    const top = spend.by_category.slice(0, 4).map((c) => `${c.category} ${money(c.total)}`).join(', ');
    lines.push(`Spending: ${money(spend.total)} across ${spend.count} entries. Top: ${top}.`);
  }
  lines.push(`Tasks: ${done.length} finished, ${open} still open.`);
  if (done.length) lines.push(...done.slice(0, 3).map((t) => `✅ ${t.text}`));
  if (missed) lines.push(`Reminders that failed to reach you: ${missed}.`);
  if (journal) lines.push(`Journal entries: ${journal}.`);
  if (quiz) lines.push(`Quiz score so far: ${quiz}.`);

  let suggestion = 'Pick one open task and finish it first thing tomorrow.';
  try {
    const raw = await chat(env, [
      {
        role: 'system',
        content: 'You are a casual, friendly, slightly funny assistant. Reply with ONE short sentence (max 25 words) of practical advice for next week based on the stats. No quotes.',
      },
      { role: 'user', content: lines.join('\n') },
    ]);
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line && line.length < 220) suggestion = line;
  } catch {
    /* keep default */
  }
  lines.push(`💡 ${suggestion}`);

  const text = lines.join('\n');
  const compact = `Week in review: ${spend.count ? `spent ${money(spend.total)}, ` : ''}${done.length} tasks finished, ${open} open. ${suggestion}`;
  await sendProactive(env, ownerNumber(env), text, compact, nowMs);
  return { sent: true };
}

/** Nightly journal nudge. Only sent while the free reply window is open. */
export async function runJournalPrompt(env, nowMs) {
  if ((await getState(env, 'journal_enabled')) === 'off') return { skipped: 'off' };
  const today = formatIST(nowMs).slice(0, 10);
  if ((await getState(env, 'last_journal_prompt_date')) === today) return { skipped: 'already-sent' };
  if (!(await inReplyWindow(env, nowMs))) return { skipped: 'window-closed' };
  await setState(env, 'last_journal_prompt_date', today);
  await setState(env, 'journal_pending', String(nowMs));
  await sendText(
    env,
    ownerNumber(env),
    'Day wrap-up time 🌙 How did today go? Send a voice note or text and I will tuck it into your journal. (/journal off to stop these)',
  );
  return { sent: true };
}
