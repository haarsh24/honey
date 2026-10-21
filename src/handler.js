import { runAssistant } from './assistant.js';
import { getState, markSeen, setState } from './db.js';
import { sendText, showTyping } from './whatsapp.js';
import { fastReply } from './fastpath.js';
import { normalizePhone } from './util.js';
import { formatIST } from './time.js';
import { handleMedia } from './media.js';
import { quizContext, quizNow } from './learning.js';
import { sendVoiceReply } from './voice.js';

const MEDIA_TYPES = ['audio', 'image', 'document'];

const HISTORY_LIMIT = 6; // messages kept for context (3 turns)

const HELP_TEXT = `Honey here, your personal sidekick with zero salary demands 😎 I can help with:
- Notes: "save: book idea - Atomic Habits", "what did I save about books?"
- Reminders: "remind me to pay rent on the 1st at 9am", "remind me every Monday 8am to plan the week"
- Expenses: "spent 450 on lunch", "how much did I spend this week?"
- Tasks: "add task: renew insurance", "my tasks"
- Writing: "draft an email asking my manager for leave on Friday"
- Meeting notes: send a long voice note and I'll make a summary and action items
- Journal: "journal: great day today", "what happened last Tuesday?"
- Learning: "quiz me on SQL joins", then /quiz any time
- Quick answers: dates, countdowns ("days till Diwali"), currency, maths, translate or rewrite a message
- Voice notes: just talk, I'll understand and do it (English, Hindi or Hinglish)
- Photos: send a receipt and I'll log the expense; other photos I'll read and summarise
- PDFs: send a bill or document, I'll summarise it and set reminders for due dates
- Web: "search latest petrol price in Ranchi", or paste a link and ask about it
- Habits: "did gym today", "how are my habits?" (streaks, plus an evening nudge)
- News: "news on AI and markets every morning", or just "news"
- Markets: "price of Reliance", "NAV of Parag Parikh Flexi Cap", "tell me when TCS goes below 3000"
- Work: "write a LinkedIn post about X", "save post idea: ...", "write my standup"
- Quick lists (instant): "tasks", "reminders", "notes", "habits"
- Oops buttons: "undo" removes what I just added, "snooze 10" pushes a reminder that just rang
- Weather: "weather" or "will it rain in Ranchi?"
- Voice replies: send me a voice note and I'll answer in a voice note too (English replies)

Commands: /help, /reset (forget this chat's context), /quiz, /briefing on|off (morning summary and Sunday review), /journal on|off (nightly prompt), /voicereply on|off.
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

const JOURNAL_WINDOW_MS = 4 * 60 * 60 * 1000;

/** Extra instructions for the assistant when a journal prompt or quiz question is waiting for a reply. */
async function extraContext(env, nowMs) {
  const parts = [];
  const pending = Number((await getState(env, 'journal_pending')) || 0);
  if (pending && nowMs - pending < JOURNAL_WINDOW_MS) {
    parts.push(
      "A nightly journal prompt was sent to the user. If their message is a reflection on their day (not a command or a question about something else), call save_journal with their own words, then reply with a warm one-line reaction.",
    );
  }
  const quiz = await quizContext(env, nowMs);
  if (quiz) parts.push(quiz);
  return parts.join('\n');
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

  // Opens the 24-hour free-reply window, so remember when it started. Show "typing..." while we think.
  const typing = showTyping(env, msg.id);
  await setState(env, 'last_inbound_at', nowMs);

  let text;
  let prefix = '';
  if (msg.type === 'text' && msg.text) {
    text = msg.text.trim().slice(0, 2000);
  } else if (MEDIA_TYPES.includes(msg.type)) {
    try {
      const result = await handleMedia(env, msg, nowMs);
      if (result.reply) {
        await sendText(env, owner, result.reply);
        return { replied: true };
      }
      text = result.text;
      prefix = result.prefix ?? '';
    } catch (error) {
      console.error('Media handling failed:', error.message);
      let message = `Couldn't make sense of that file just now 😵 Try again, or just type it out? (${String(error.message).slice(0, 160)})`;
      if (error.code === 'NO_KEY') message = 'Voice notes, photos and PDFs need the GEMINI_KEY secret to be set up first.';
      else if (error.code === 'TOO_LARGE') message = 'That file is too large for me. Please send a smaller one.';
      await sendText(env, owner, message);
      return { replied: true, error: true };
    }
  } else {
    await sendText(env, owner, 'I can handle text, voice notes, photos and PDFs. That one is beyond me, sorry 😅');
    return { replied: true };
  }

  try {
    await deliverMissedReminders(env, owner);
  } catch (error) {
    console.error('Could not deliver missed reminders:', error.message);
  }

  const command = msg.type === 'text' ? text.toLowerCase() : '';
  if (command === '/briefing on' || command === '/briefing off') {
    await setState(env, 'briefing_enabled', command.endsWith('on') ? 'on' : 'off');
    await sendText(env, owner, command.endsWith('on') ? 'Morning briefing is on. Expect me at 8:00 AM IST with coffee-level energy ☕' : 'Morning briefing is off. I will stay quiet until you call me 🤐');
    return { replied: true };
  }
  if (command === '/journal on' || command === '/journal off') {
    await setState(env, 'journal_enabled', command.endsWith('on') ? 'on' : 'off');
    await sendText(env, owner, command.endsWith('on') ? 'Nightly journal prompt is on (9:30 PM IST) 🌙' : 'Nightly journal prompt is off.');
    return { replied: true };
  }
  if (command === '/voicereply on' || command === '/voicereply off') {
    await setState(env, 'voice_reply', command.endsWith('on') ? 'on' : 'off');
    await sendText(env, owner, command.endsWith('on') ? 'Voice replies on. Send a voice note and I will talk back 🎙️' : 'Voice replies off. Text only from now on.');
    return { replied: true };
  }
  if (command === '/quiz') {
    try {
      await sendText(env, owner, await quizNow(env, nowMs));
    } catch (error) {
      console.error('Quiz failed:', error.message);
      await sendText(env, owner, 'My quiz brain tripped 🥴 Try /quiz again in a minute.');
    }
    return { replied: true };
  }
  if (command === '/help' || command === 'help') {
    await sendText(env, owner, HELP_TEXT);
    return { replied: true };
  }
  if (command === '/reset') {
    await setState(env, 'history', '[]');
    await sendText(env, owner, 'Fresh start! 🧼 I forgot this chat, but your notes, reminders, tasks and expenses are safe.');
    return { replied: true };
  }

  // Plain list requests ("tasks", "reminders") are answered instantly, without the AI.
  try {
    const quick = await fastReply(env, text, nowMs);
    if (quick) {
      await typing;
      await sendText(env, owner, prefix ? `${prefix}\n\n${quick}` : quick);
      if (msg.type === 'audio') await sendVoiceReply(env, owner, quick);
      return { replied: true, fast: true };
    }
  } catch (error) {
    console.error('Fast path failed, using the assistant:', error.message);
  }

  const [history, extra] = await Promise.all([loadHistory(env), extraContext(env, nowMs)]);
  let reply;
  try {
    reply = await runAssistant(env, text, history, nowMs, extra);
  } catch (error) {
    console.error('Assistant failed:', error.message);
    await typing;
    await sendText(env, owner, 'My brain just buffered 🙃 Try again in a minute?');
    return { replied: true, error: true };
  }

  await typing;
  await sendText(env, owner, prefix ? `${prefix}\n\n${reply}` : reply);
  if (msg.type === 'audio') await sendVoiceReply(env, owner, reply);
  try {
    await saveHistory(env, history, text, reply);
  } catch (error) {
    console.error('Could not save history:', error.message);
  }
  return { replied: true };
}
