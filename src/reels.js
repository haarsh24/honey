// /makereel: queue reel ideas for Claude to turn into finished reels. Ideas live in the D1 `ideas` table
// with kind 'reel' (waiting) and 'reel_done' (made). A GitHub Action exports the waiting ones to reel-queue/.
const pick = (list, nowMs) => list[Math.floor(nowMs / 60000) % list.length];

const USAGE = `Tell me the idea after the command, like:
/makereel how Netflix knows what you want to watch
/makereel why UPI never goes down
Other commands: /reels (see the queue), /reels cancel 3`;

/** Handles /makereel and /reels. Returns the reply text, or null when the message is not one of these commands. */
export async function reelCommand(env, text, nowMs) {
  const raw = String(text ?? '').trim();
  const make = raw.match(/^\/makereel\b\s*([\s\S]*)$/i);
  if (make) {
    const idea = make[1].trim().slice(0, 600);
    if (!idea) return `🎬 ${USAGE}`;
    const r = await env.DB.prepare("INSERT INTO ideas (kind, text, created_at) VALUES ('reel', ?, ?)").bind(idea, nowMs).run();
    const waiting = (await env.DB.prepare("SELECT COUNT(*) AS n FROM ideas WHERE kind = 'reel'").first()).n;
    return `${pick(['Idea #', 'Locked in, idea #', 'Queued as #'], nowMs)}${r.meta.last_row_id} 🎬 "${idea.slice(0, 80)}${idea.length > 80 ? '…' : ''}"\n\n${waiting} idea${waiting === 1 ? '' : 's'} waiting. Open Claude and say "make my queued reels" and Mimi gets to work ✨`;
  }
  const list = raw.match(/^\/reels\b\s*(.*)$/i);
  if (!list) return null;
  const cancel = list[1].trim().match(/^(?:cancel|delete|remove)\s+#?(\d+)$/i);
  if (cancel) {
    const r = await env.DB.prepare("DELETE FROM ideas WHERE id = ? AND kind = 'reel'").bind(Number(cancel[1])).run();
    return r.meta.changes ? `Idea #${cancel[1]} removed from the queue 🗑️` : `No waiting reel idea with id ${cancel[1]} 🤔`;
  }
  const rows = (await env.DB.prepare("SELECT id, text FROM ideas WHERE kind = 'reel' ORDER BY id LIMIT 30").all()).results;
  if (!rows.length) return 'Reel queue is empty 🎬 Add one with /makereel <idea>';
  return `Reel ideas waiting (${rows.length}):\n${rows.map((i) => `${i.id}. ${i.text}`).join('\n')}`;
}
