import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

/** Minimal D1 look-alike on top of node:sqlite. */
export function makeDB() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    async run() {
      const r = db.prepare(sql).run(...params);
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    async first() {
      return db.prepare(sql).get(...params) ?? null;
    },
    async all() {
      return { results: db.prepare(sql).all(...params) };
    },
  });
  return { prepare: (sql) => stmt(sql), raw: db };
}

export const OWNER = '919876543210';

export function makeEnv(extra = {}) {
  return {
    DB: makeDB(),
    OWNER_NUMBER: OWNER,
    PHONE_NUMBER_ID: '123',
    WHATSAPP_TOKEN: 'tok',
    GRAPH_VERSION: 'v25.0',
    TEMPLATE_NAME: 'reminder',
    TEMPLATE_LANG: 'en',
    ...extra,
  };
}

/** Replaces global fetch; records calls; `respond(body)` may return {status, json}. */
export function mockFetch(respond = () => ({ status: 200, json: { ok: true } })) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const r = respond(body, calls.length);
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  };
  return calls;
}

/** Scripted LLM: returns each item in order (objects are JSON-stringified). */
export function scriptedLLM(items) {
  let i = 0;
  return async () => {
    const it = items[Math.min(i++, items.length - 1)];
    return typeof it === 'string' ? it : JSON.stringify(it);
  };
}
