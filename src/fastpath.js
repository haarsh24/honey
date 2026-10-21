// Instant answers for plain "show me my X" messages: one database read, no AI call, so they come back immediately.
import { habitStats } from './habits.js';
import { formatIST } from './time.js';

const pick = (list, nowMs) => list[Math.floor(nowMs / 60000) % list.length];
const ASK = '(?:show |list |see |what are |what is |whats |what\'s )?(?:me )?(?:my |all |the )?(?:open |pending |upcoming )?';
const re = (word) => new RegExp(`^/?${ASK}${word}\\s*[?.!]*$`, 'i');

const FAST = [
  {
    match: re('(?:tasks?|to-?dos?|todo list)'),
    async run(env, nowMs) {
      const rows = (await env.DB.prepare("SELECT id, text FROM tasks WHERE status = 'open' ORDER BY id LIMIT 30").all()).results;
      if (!rows.length) return pick(['Zero open tasks. Either you are a legend or you are not telling me things 😏', 'No open tasks. Enjoy it, it will not last 🕊️'], nowMs);
      return `Your open tasks (${rows.length}):\n${rows.map((t) => `${t.id}. ${t.text}`).join('\n')}\n\n${pick(['Pick one and crush it 💪', 'No pressure. Okay, a little pressure 😅', 'Tell me "done 3" and I will cheer quietly.'], nowMs)}`;
    },
  },
  {
    match: re('reminders?'),
    async run(env, nowMs) {
      const rows = (await env.DB.prepare("SELECT id, text, due_at, repeat FROM reminders WHERE status = 'pending' ORDER BY due_at LIMIT 20").all()).results;
      if (!rows.length) return pick(['No reminders. Your future self is on their own 🫡', 'Nothing scheduled. Suspiciously peaceful.'], nowMs);
      return `Upcoming reminders:\n${rows.map((r) => `${r.id}. ${formatIST(r.due_at)} - ${r.text}${r.repeat !== 'none' ? ` (${r.repeat})` : ''}`).join('\n')}`;
    },
  },
  {
    match: re('notes?'),
    async run(env, nowMs) {
      const rows = (await env.DB.prepare('SELECT id, text FROM notes ORDER BY id DESC LIMIT 10').all()).results;
      if (!rows.length) return 'No notes yet. Say "save: ..." and I will guard it with my life 📝';
      return `Your latest notes:\n${rows.map((n) => `${n.id}. ${n.text}`).join('\n')}`;
    },
  },
  {
    match: re('habits?'),
    async run(env, nowMs) {
      const habits = (await env.DB.prepare('SELECT id, name FROM habits ORDER BY name LIMIT 20').all()).results;
      if (!habits.length) return 'No habits yet. Tell me "did gym today" and we will start a streak 🏋️';
      const today = formatIST(nowMs).slice(0, 10);
      const lines = [];
      for (const h of habits) {
        const s = await habitStats(env, h, today);
        lines.push(`${s.done_today ? '✅' : '⬜'} ${s.habit}: ${s.current_streak}-day streak (best ${s.best_streak}), ${s.last_7_days}/7 this week`);
      }
      return `Habit check:\n${lines.join('\n')}`;
    },
  },
];

/** Returns the reply text for a message that is just a plain list request, or null for everything else. */
export async function fastReply(env, text, nowMs) {
  const clean = String(text ?? '').trim();
  if (!clean || clean.length > 40) return null;
  const hit = FAST.find((f) => f.match.test(clean));
  return hit ? hit.run(env, nowMs) : null;
}
