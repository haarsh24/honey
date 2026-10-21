// Scheduled jobs for habits, news and price alerts.
import { getState, setState } from './db.js';
import { ownerNumber } from './handler.js';
import { buildDigest, getTopics } from './digest.js';
import { habitNudge } from './habits.js';
import { checkWatches } from './markets.js';
import { inReplyWindow, sendProactive } from './outbound.js';
import { formatIST } from './time.js';
import { sendText } from './whatsapp.js';

/** Evening nudge for habits at risk of slipping. Free window only. */
export async function runHabitNudge(env, now) {
  const today = formatIST(now).slice(0, 10);
  if ((await getState(env, 'last_habit_nudge')) === today) return { skipped: 'already-sent' };
  if (!(await inReplyWindow(env, now))) return { skipped: 'window-closed' };
  const text = await habitNudge(env, now);
  if (!text) return { skipped: 'nothing-to-nudge' };
  await setState(env, 'last_habit_nudge', today);
  await sendText(env, ownerNumber(env), text);
  return { sent: true };
}

/** Morning news digest for the saved topics. Free window only. */
export async function runDigest(env, now) {
  const today = formatIST(now).slice(0, 10);
  if ((await getState(env, 'last_digest_date')) === today) return { skipped: 'already-sent' };
  if (!(await getTopics(env)).length) return { skipped: 'no-topics' };
  if (!(await inReplyWindow(env, now))) return { skipped: 'window-closed' };
  await setState(env, 'last_digest_date', today);
  const text = await buildDigest(env);
  if (text) await sendText(env, ownerNumber(env), text);
  return { sent: Boolean(text) };
}

/** Price alerts. Alerts always go out (template when the window is closed). */
export async function runWatchCheck(env, now, kind) {
  const messages = await checkWatches(env, now, kind);
  for (const message of messages) {
    await sendProactive(env, ownerNumber(env), message, message, now);
  }
  return { fired: messages.length };
}
