export async function getState(env, key) {
  const row = await env.DB.prepare('SELECT value FROM state WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

export async function setState(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  )
    .bind(key, String(value))
    .run();
}

/** Returns true the first time a message id is seen, false for WhatsApp retries. */
export async function markSeen(env, id, nowMs) {
  const result = await env.DB.prepare('INSERT OR IGNORE INTO seen_messages (id, ts) VALUES (?, ?)')
    .bind(id, nowMs)
    .run();
  return (result?.meta?.changes ?? 0) === 1;
}
