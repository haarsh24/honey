import { getState, setState } from './db.js';
import { ownerNumber } from './handler.js';
import { sendProactive } from './outbound.js';
import { describeIST, formatIST, startOfISTDay } from './time.js';
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

/** Sunday evening spending recap. Skipped when nothing was spent. */
export async function runWeekly(env, nowMs) {
  if (!(await briefingEnabled(env))) return { skipped: 'off' };
  const today = formatIST(nowMs).slice(0, 10);
  if ((await getState(env, 'last_weekly_date')) === today) return { skipped: 'already-sent' };
  const summary = await TOOLS.expense_summary(env, { period: 'week' }, { now: nowMs });
  if (!summary.count) return { skipped: 'no-expenses' };
  await setState(env, 'last_weekly_date', today);
  const top = summary.by_category.slice(0, 4).map((c) => `${c.category} ${money(c.total)}`).join(', ');
  const text = `Weekly spending: ${money(summary.total)} across ${summary.count} entries. Top: ${top}.`;
  await sendProactive(env, ownerNumber(env), text, text, nowMs);
  return { sent: true };
}
