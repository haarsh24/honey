// Smart memory: notes, journal entries, ideas and contacts searchable by meaning.
// Embeddings come from Workers AI (free). Vectors are stored as int8 unit vectors, so a search is a cheap dot product.
import { formatIST } from './time.js';

const PRIMARY_MODEL = '@cf/baai/bge-m3'; // multilingual, handles Hinglish names and words
const FALLBACK_MODEL = '@cf/baai/bge-base-en-v1.5';
const MAX_SCAN = 800; // newest rows compared per search
const BACKFILL_BATCH = 40; // older items embedded lazily on a search
const MIN_SCORE = 0.3;
const DAY = 24 * 60 * 60 * 1000;

/** Normalises to unit length and quantises to int8, returned as base64. */
export function packVector(values) {
  let norm = 0;
  for (const v of values) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  const bytes = new Int8Array(values.length);
  for (let i = 0; i < values.length; i++) bytes[i] = Math.max(-127, Math.min(127, Math.round((values[i] / norm) * 127)));
  return Buffer.from(bytes.buffer).toString('base64');
}

function unpack(b64) {
  const buf = Buffer.from(b64, 'base64');
  return new Int8Array(buf.buffer, buf.byteOffset, buf.length);
}

export function similarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (127 * 127);
}

async function runEmbedding(env, model, texts) {
  const out = await env.AI.run(model, { text: texts });
  const rows = out?.data ?? out?.response;
  if (!Array.isArray(rows) || rows.length !== texts.length || !Array.isArray(rows[0])) {
    throw new Error(`${model} returned no embeddings`);
  }
  return rows;
}

/** Returns { model, vectors: base64[] } for the given texts. */
export async function embed(env, texts) {
  if (typeof env.__embed === 'function') {
    const vectors = await env.__embed(texts); // test hook: arrays of numbers
    return { model: 'test', vectors: vectors.map(packVector) };
  }
  if (!env.AI) throw new Error('Workers AI binding missing');
  let lastError;
  for (const model of [PRIMARY_MODEL, FALLBACK_MODEL]) {
    try {
      const rows = await runEmbedding(env, model, texts);
      return { model, vectors: rows.map(packVector) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export async function indexItem(env, kind, refId, text, now = Date.now()) {
  const body = clip(text, 700);
  if (!body) return;
  const { model, vectors } = await embed(env, [body]);
  await env.DB.prepare(
    'INSERT INTO embeddings (kind, ref_id, model, vec, text, created_at) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(kind, ref_id) DO UPDATE SET model = excluded.model, vec = excluded.vec, text = excluded.text, created_at = excluded.created_at',
  )
    .bind(kind, refId, model, vectors[0], body, now)
    .run();
}

/** Which tool results should be indexed, and what text represents them. Best effort. */
export async function indexAfterTool(env, name, args, result, now) {
  try {
    if (!result || result.error) return;
    if (name === 'save_note' && result.id) await indexItem(env, 'note', result.id, args.text, now);
    else if (name === 'save_journal' && result.id) await indexItem(env, 'journal', result.id, `${result.day}: ${args.text}`, now);
    else if (name === 'save_idea' && result.id) await indexItem(env, 'idea', result.id, args.text, now);
    else if (name === 'save_meeting' && result.note_id) await indexItem(env, 'note', result.note_id, `${args.title}: ${args.summary}`, now);
    else if (name === 'remember_contact' && result.id) await indexItem(env, 'contact', result.id, `${result.name}: ${result.facts.join('. ')}`, now);
  } catch (error) {
    console.error('Indexing failed:', error.message);
  }
}

const SOURCES = {
  note: { sql: 'SELECT id, text, created_at AS at FROM notes ORDER BY id DESC LIMIT ?', label: 'note' },
  journal: { sql: "SELECT id, day || ': ' || text AS text, created_at AS at FROM journal ORDER BY id DESC LIMIT ?", label: 'journal' },
  idea: { sql: 'SELECT id, text, created_at AS at FROM ideas ORDER BY id DESC LIMIT ?', label: 'idea' },
  contact: { sql: "SELECT id, name || ': ' || REPLACE(facts, char(10), '. ') AS text, updated_at AS at FROM contacts ORDER BY id DESC LIMIT ?", label: 'contact' },
};

/** Embeds a limited number of not-yet-indexed (or old-model) items so older notes become searchable. */
async function backfill(env, model, now) {
  const pending = [];
  for (const [kind, src] of Object.entries(SOURCES)) {
    const rows = (await env.DB.prepare(src.sql).bind(200).all()).results;
    if (!rows.length) continue;
    const have = new Map(
      (await env.DB.prepare('SELECT ref_id, model FROM embeddings WHERE kind = ?').bind(kind).all()).results.map((r) => [r.ref_id, r.model]),
    );
    for (const r of rows) if (have.get(r.id) !== model) pending.push({ kind, id: r.id, text: clip(r.text, 700) });
  }
  const batch = pending.slice(0, BACKFILL_BATCH);
  if (!batch.length) return 0;
  const { model: used, vectors } = await embed(env, batch.map((b) => b.text));
  for (let i = 0; i < batch.length; i++) {
    await env.DB.prepare(
      'INSERT INTO embeddings (kind, ref_id, model, vec, text, created_at) VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(kind, ref_id) DO UPDATE SET model = excluded.model, vec = excluded.vec, text = excluded.text',
    )
      .bind(batch[i].kind, batch[i].id, used, vectors[i], batch[i].text, now)
      .run();
  }
  return batch.length;
}

/** Top matches by meaning. Returns [{ kind, id, text, score, date }]. */
export async function semanticSearch(env, query, { limit = 6, now = Date.now() } = {}) {
  const q = clip(query, 300);
  if (!q) return [];
  const { model, vectors } = await embed(env, [q]);
  const queryVec = unpack(vectors[0]);
  await backfill(env, model, now);

  const rows = (
    await env.DB.prepare('SELECT kind, ref_id, vec, text, created_at FROM embeddings WHERE model = ? ORDER BY created_at DESC LIMIT ?')
      .bind(model, MAX_SCAN)
      .all()
  ).results;
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const scored = rows
    .map((r) => {
      let score = similarity(queryVec, unpack(r.vec));
      const lower = r.text.toLowerCase();
      if (words.some((w) => lower.includes(w))) score += 0.1; // exact words still help
      return { kind: r.kind, id: r.ref_id, text: r.text, score: Math.round(score * 1000) / 1000, at: r.created_at };
    })
    .filter((r) => r.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit * 2);

  // Drop anything whose source row has been deleted.
  const alive = [];
  for (const r of scored) {
    const table = { note: 'notes', journal: 'journal', idea: 'ideas', contact: 'contacts' }[r.kind];
    const row = await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(r.id).first();
    if (row) alive.push({ kind: SOURCES[r.kind].label, id: r.id, text: r.text, score: r.score, date: formatIST(r.at).slice(0, 10) });
    else await env.DB.prepare('DELETE FROM embeddings WHERE kind = ? AND ref_id = ?').bind(r.kind, r.id).run();
    if (alive.length >= limit) break;
  }
  return alive;
}

const cleanName = (v) => {
  const name = String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!name) throw new Error('name is required');
  return name;
};

const factLines = (facts) => String(facts ?? '').split('\n').map((l) => l.trim()).filter(Boolean);

export const MEMORY_TOOLS = {
  /** Find saved notes, journal entries, ideas and contact facts by meaning. */
  async ask_memory(env, args, { now }) {
    const limit = Math.min(Math.max(Number(args.limit) || 6, 1), 10);
    try {
      const matches = await semanticSearch(env, args.query, { limit, now });
      return { matches, note: matches.length ? undefined : 'Nothing close enough was found in notes, journal, ideas or contacts.' };
    } catch (error) {
      // Embeddings unavailable: fall back to plain keyword search over notes.
      const words = String(args.query ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 2).slice(0, 4);
      if (!words.length) throw error;
      const where = words.map(() => "LOWER(text) LIKE ? ESCAPE '\\'").join(' OR ');
      const rows = (await env.DB.prepare(`SELECT id, text FROM notes WHERE ${where} ORDER BY id DESC LIMIT ?`).bind(...words.map((w) => `%${w.replace(/[\\%_]/g, '\\$&')}%`), limit).all()).results;
      return { matches: rows.map((r) => ({ kind: 'note', id: r.id, text: r.text })), note: 'Meaning search was unavailable, so this is a keyword match on notes only.' };
    }
  },

  /** Save a fact about a person. Repeats are ignored; new facts are appended. */
  async remember_contact(env, args, { now }) {
    const name = cleanName(args.name);
    const incoming = factLines(args.fact ?? args.facts);
    if (!incoming.length) return { error: 'fact is required, like "wife is Neha, loves cricket"' };
    const existing = await env.DB.prepare('SELECT id, facts FROM contacts WHERE name = ?').bind(name).first();
    const lines = existing ? factLines(existing.facts) : [];
    for (const f of incoming) if (!lines.some((l) => l.toLowerCase() === f.toLowerCase())) lines.push(f.slice(0, 300));
    const facts = lines.join('\n').slice(0, 1800);
    let id;
    if (existing) {
      await env.DB.prepare('UPDATE contacts SET facts = ?, updated_at = ? WHERE id = ?').bind(facts, now, existing.id).run();
      id = existing.id;
    } else {
      id = (await env.DB.prepare('INSERT INTO contacts (name, facts, updated_at) VALUES (?, ?, ?)').bind(name, facts, now).run()).meta.last_row_id;
    }
    return { saved: true, id, name, facts: factLines(facts) };
  },

  /** Everything known about a person: saved facts plus notes and journal entries that mention them. */
  async about_person(env, args, { now }) {
    const name = cleanName(args.name);
    const contact = await env.DB.prepare('SELECT name, facts FROM contacts WHERE name = ?').bind(name).first();
    const like = `%${name.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
    const mentions = [];
    for (const [table, col] of [['notes', 'text'], ['journal', "day || ': ' || text"], ['ideas', 'text']]) {
      const rows = (await env.DB.prepare(`SELECT ${col} AS text FROM ${table} WHERE LOWER(text) LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 4`).bind(like).all()).results;
      for (const r of rows) mentions.push({ from: table.replace(/s$/, ''), text: clip(r.text, 300) });
    }
    if (!contact && !mentions.length) return { error: `I have nothing saved about ${name}. Tell me something like "${name}'s wife is ..." and I will remember.` };
    return { name: contact?.name ?? name, facts: contact ? factLines(contact.facts) : [], mentioned_in: mentions.slice(0, 8) };
  },

  async list_contacts(env) {
    const rows = (await env.DB.prepare('SELECT name, facts FROM contacts ORDER BY name LIMIT 50').all()).results;
    return { count: rows.length, contacts: rows.map((r) => ({ name: r.name, facts: factLines(r.facts).length })) };
  },

  async forget_contact(env, args) {
    const name = cleanName(args.name);
    const row = await env.DB.prepare('SELECT id FROM contacts WHERE name = ?').bind(name).first();
    if (!row) return { error: `No contact named ${name}` };
    await env.DB.prepare('DELETE FROM contacts WHERE id = ?').bind(row.id).run();
    await env.DB.prepare("DELETE FROM embeddings WHERE kind = 'contact' AND ref_id = ?").bind(row.id).run();
    return { forgotten: true };
  },
};
