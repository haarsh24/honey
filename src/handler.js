import { runAssistant } from './assistant.js';
import { getState, markSeen, setState } from './db.js';
import { sendText } from './whatsapp.js';
import { normalizePhone } from './util.js';
import { formatIST } from './time.js';

const HISTORY_LIMIT = 6; // messages kept for context (3 turns)

const HELP_TEXT = `I can help with:
- Notes: "save: book idea - Atomic Habits", "what did I save about books?"
- Reminders: "remind me to pay rent on the 1st at 9am", "remind me every Monday 8am to plan the week"
- Expenses: "spent 450 on lunch", "how much did I spend this week?"
- Tasks: "add task: renew insurance", "my tasks"
- Writing: "draft an email asking my manager for leave on Friday"

Commands: /help, /reset (forget this chat's context).
Please don't send passwords, card numbers or ID numbers.`;

export function ownerNumber(env) {
  return normalizePhone(env.OWNER_NUMBER, env.DEFAULT_COUNTRY_CODE ?? '91');
}

async function loadHistory(env) {
  try {
    const raw = await getState(env, 'history');
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(-HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

async function saveHistory(env, history, userText, reply) {
  const next = [
    ...history,
    { role: 'user', content: userText.slice(0, 500) },
    { role: 'assistant', content: reply.slice(0, 500) },
  ].slice(-HISTORY_LIMIT);
  await setState(env, 'history', JSON.stringify(next));
}

/** Reminders that could not be sent (window closed, no template) are delivered on the next message. */
async function deliverMissedReminders(env, to) {
  const { results } = await env.DB.prepare(
    "SELECT id, text, due_at FROM reminders WHERE status = 'missed' ORDER BY due_at LIMIT 10",
  ).all();
  if (!results.length) return;
  const lines = results.map((r) => `- ${r.text} (was due ${formatIST(r.due_at)})`);
  await sendText(env, to, `Reminders you missed while we weren't chatting:\n${lines.join('\n')}`);
  const ids = results.map((r) => r.id);
  await env.DB.prepare(
    `UPDATE reminders SET status = 'sent' WHERE id IN (${ids.map(() => '?').join(',')})`,
  )
    .bind(...ids)
    .run();
}

/**
 * Handle one incoming WhatsApp message.
 * msg = { id, from, type, text }
 */
export async function handleIncoming(env, msg, nowMs = Date.now()) {
  const owner = ownerNumber(env);
  if (!owner || normalizePhone(msg.from, '') !== owner) {
    console.log('Ignored message from a non-owner number');
    return { ignored: 'not-owner' };
  }
  if (!(await markSeen(env, msg.id, nowMs))) return { ignored: 'duplicate' };

  // Opens the 24-hour free-reply window, so remember when it started.
  await setState(env, 'last_inbound_at', nowMs);

  if (msg.type !== 'text' || !msg.text) {
    await sendText(env, owner, 'I can only read text messages for now.');
    return { replied: true };
  }

  const text = msg.text.trim().slice(0, 2000);
  const command = text.toLowerCase();

  try {
    await deliverMissedReminders(env, owner);
  } catch (error) {
    console.error('Could not deliver missed reminders:', error.message);
  }

  if (command === '/help' || command === 'help') {
    await sendText(env, owner, HELP_TEXT);
    return { replied: true };
  }
  if (command === '/reset') {
    await setState(env, 'history', '[]');
    await sendText(env, owner, 'Done. I cleared this chat\'s context. Your notes, reminders, tasks and expenses are untouched.');
    return { replied: true };
  }

  const history = await loadHistory(env);
  let reply;
  try {
    reply = await runAssistant(env, text, history, nowMs);
  } catch (error) {
    console.error('Assistant failed:', error.message);
    await sendText(env, owner, 'I could not reach my AI brain just now. Please try again in a minute.');
    return { replied: true, error: true };
  }

  await sendText(env, owner, reply);
  try {
    await saveHistory(env, history, text, reply);
  } catch (error) {
    console.error('Could not save history:', error.message);
  }
  return { replied: true };
}
