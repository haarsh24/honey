import { getState } from './db.js';
import { sendTemplate, sendText } from './whatsapp.js';
import { nextOccurrence } from './time.js';
import { ownerNumber } from './handler.js';

const WINDOW_MS = 23.5 * 60 * 60 * 1000; // stay safely inside WhatsApp's 24-hour window
const MAX_ATTEMPTS = 3;
const REENGAGEMENT_ERROR = 131047; // "re-engagement message": the 24-hour window is closed

async function deliver(env, to, text, inWindow) {
  const useTemplate = async () =>
    sendTemplate(env, to, env.TEMPLATE_NAME || 'reminder', env.TEMPLATE_LANG || 'en', text);

  if (!inWindow) return useTemplate();
  try {
    return await sendText(env, to, `⏰ Reminder: ${text}`);
  } catch (error) {
    if (error.code === REENGAGEMENT_ERROR) return useTemplate();
    throw error;
  }
}

/** Called by the cron trigger every minute. */
export async function runDueReminders(env, nowMs = Date.now()) {
  const { results } = await env.DB.prepare(
    "SELECT id, text, due_at, repeat, attempts FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT 20",
  )
    .bind(nowMs)
    .all();
  if (!results.length) return { due: 0, sent: 0 };

  const to = ownerNumber(env);
  const lastInbound = Number((await getState(env, 'last_inbound_at')) ?? 0);
  const inWindow = nowMs - lastInbound < WINDOW_MS;
  let sent = 0;

  for (const r of results) {
    try {
      await deliver(env, to, r.text, inWindow);
      sent++;
      if (r.repeat !== 'none') {
        const next = nextOccurrence(r.due_at, r.repeat, nowMs);
        await env.DB.prepare('UPDATE reminders SET due_at = ?, attempts = 0, sent_at = ? WHERE id = ?')
          .bind(next, nowMs, r.id)
          .run();
      } else {
        await env.DB.prepare("UPDATE reminders SET status = 'sent', sent_at = ? WHERE id = ?")
          .bind(nowMs, r.id)
          .run();
      }
    } catch (error) {
      const attempts = r.attempts + 1;
      console.error(`Reminder ${r.id} failed (attempt ${attempts}): ${error.message}`);
      if (attempts < MAX_ATTEMPTS) {
        await env.DB.prepare('UPDATE reminders SET attempts = ? WHERE id = ?').bind(attempts, r.id).run();
      } else if (r.repeat !== 'none') {
        // Skip this occurrence, keep the series going.
        const next = nextOccurrence(r.due_at, r.repeat, nowMs);
        await env.DB.prepare('UPDATE reminders SET due_at = ?, attempts = 0 WHERE id = ?')
          .bind(next, r.id)
          .run();
      } else {
        // Delivered as text the next time the owner messages the bot.
        await env.DB.prepare("UPDATE reminders SET status = 'missed', attempts = ? WHERE id = ?")
          .bind(attempts, r.id)
          .run();
      }
    }
  }
  return { due: results.length, sent };
}

/** Housekeeping, run once a day (02:35 IST) from the same cron trigger. */
export async function cleanup(env, nowMs = Date.now()) {
  const DAY = 24 * 60 * 60 * 1000;
  await env.DB.prepare('DELETE FROM seen_messages WHERE ts < ?').bind(nowMs - 3 * DAY).run();
  await env.DB.prepare(
    "DELETE FROM reminders WHERE status IN ('sent', 'cancelled') AND created_at < ?",
  )
    .bind(nowMs - 60 * DAY)
    .run();
}
