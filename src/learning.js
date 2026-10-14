import { chat } from './llm.js';
import { getState, setState } from './db.js';
import { ownerNumber } from './handler.js';
import { inReplyWindow } from './outbound.js';
import { sendText } from './whatsapp.js';
import { formatIST } from './time.js';
import { parseModelJson } from './util.js';

export const QUIZ_EXPIRY_MS = 12 * 60 * 60 * 1000;

async function recentQuestions(env) {
  try {
    const parsed = JSON.parse((await getState(env, 'quiz_recent')) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Ask the AI for one question + answer on the topic, avoiding recent repeats. */
export async function generateQuestion(env, topic) {
  const avoid = await recentQuestions(env);
  const raw = await chat(env, [
    {
      role: 'system',
      content:
        'You write one short quiz question at a time for a learner. Answer ONLY with JSON: {"question":"...","answer":"..."}. The question must be answerable in a sentence or two, test understanding rather than trivia, and vary in difficulty. The answer is 1-3 sentences.',
    },
    {
      role: 'user',
      content: `Topic: ${topic}.${avoid.length ? ` Do not repeat these questions: ${avoid.slice(-10).join(' | ')}` : ''}`,
    },
  ]);
  const parsed = parseModelJson(raw);
  if (!parsed?.question || !parsed?.answer) throw new Error('Could not generate a quiz question');
  const question = String(parsed.question).slice(0, 400);
  const answer = String(parsed.answer).slice(0, 500);
  await setState(env, 'quiz_recent', JSON.stringify([...avoid, question].slice(-15)));
  return { question, answer };
}

async function ask(env, nowMs) {
  const topic = await getState(env, 'learn_topic');
  if (!topic) return null;
  const { question, answer } = await generateQuestion(env, topic);
  await setState(env, 'quiz_pending', JSON.stringify({ q: question, a: answer, topic, at: nowMs }));
  return `🧠 Brain-gym time (${topic})\n\n${question}\n\nSend your answer, or say "skip" and I'll show it.`;
}

/** /quiz command: returns the message text to send, or an explanation. */
export async function quizNow(env, nowMs) {
  const text = await ask(env, nowMs);
  return text ?? 'Tell me what you want to learn first, like "quiz me on SQL joins" 📚';
}

/** Cron: one question a day, only when the free reply window is open. */
export async function runDrill(env, nowMs) {
  if (!(await getState(env, 'learn_topic'))) return { skipped: 'no-topic' };
  const today = formatIST(nowMs).slice(0, 10);
  if ((await getState(env, 'last_drill_date')) === today) return { skipped: 'already-sent' };
  if (!(await inReplyWindow(env, nowMs))) return { skipped: 'window-closed' };
  await setState(env, 'last_drill_date', today);
  const text = await ask(env, nowMs);
  if (text) await sendText(env, ownerNumber(env), text);
  return { sent: Boolean(text) };
}

/** Text added to the assistant's instructions while a quiz question is waiting for an answer. */
export async function quizContext(env, nowMs) {
  try {
    const pending = JSON.parse((await getState(env, 'quiz_pending')) || 'null');
    if (!pending || nowMs - pending.at > QUIZ_EXPIRY_MS) return '';
    return `A quiz question is waiting for the user's answer.\nQuestion: ${pending.q}\nCorrect answer (do not reveal before they answer): ${pending.a}\nIf the user's message is an attempt to answer, grade it kindly (right, partly right or wrong), explain in one or two lines, then call quiz_done with correct true or false. If they say skip or I don't know, show the answer and call quiz_done with correct false. If the message is about something else, ignore the quiz and handle it normally.`;
  } catch {
    return '';
  }
}
