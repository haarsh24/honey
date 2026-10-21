import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, mockWorld } from './helpers.mjs';
import { TOOLS, runTool } from '../src/tools.js';
import { packVector, similarity } from '../src/memory.js';
import { nextSlots } from '../src/posts.js';
import { runDueReminders } from '../src/reminders.js';
import { buildSystemPrompt } from '../src/assistant.js';
import { setState } from '../src/db.js';
import { parseIST, formatIST } from '../src/time.js';

const NOW = parseIST('2026-10-21 10:00'); // Wednesday

/** Toy embedding: a 6-dim "meaning" vector from keyword groups, so related words land close together. */
const GROUPS = [
  ['book', 'read', 'reading', 'atomic', 'novel', 'recommended', 'recommend'],
  ['rahul', 'friend', 'wife', 'neha'],
  ['cricket', 'match', 'ipl'],
  ['insurance', 'policy', 'premium'],
  ['gym', 'workout', 'fitness'],
  ['whatsapp', 'bot', 'free', 'cloudflare'],
];
const toyEmbed = async (texts) =>
  texts.map((t) => {
    const lower = t.toLowerCase();
    const v = GROUPS.map((g) => g.filter((w) => lower.includes(w)).length);
    return v.some(Boolean) ? v : [-1, -1, -1, -1, -1, -1];
  });

test('vectors: pack and compare', () => {
  const a = packVector([1, 0, 0]);
  const b = packVector([1, 0.1, 0]);
  const c = packVector([0, 1, 0]);
  const dec = (x) => new Int8Array(Buffer.from(x, 'base64'));
  assert.ok(similarity(dec(a), dec(b)) > 0.95);
  assert.ok(similarity(dec(a), dec(c)) < 0.05);
});

test('ask_memory finds notes by meaning, not exact words, and forgets deleted ones', async () => {
  const env = makeEnv({ __embed: toyEmbed });
  await runTool(env, 'save_note', { text: 'Atomic Habits - from Rahul' }, { now: NOW });
  await runTool(env, 'save_note', { text: 'Renew car insurance premium before March' }, { now: NOW });
  await runTool(env, 'save_journal', { text: 'Great gym workout today' }, { now: NOW });
  const r = await TOOLS.ask_memory(env, { query: 'what was that book Rahul recommended?' }, { now: NOW });
  assert.equal(r.matches[0].text, 'Atomic Habits - from Rahul');
  assert.equal(r.matches[0].kind, 'note');
  assert.ok(!r.matches.some((m) => /insurance/.test(m.text)));
  const j = await TOOLS.ask_memory(env, { query: 'fitness' }, { now: NOW });
  assert.equal(j.matches[0].kind, 'journal');
  await TOOLS.delete_note(env, { id: 1 }, { now: NOW });
  const again = await TOOLS.ask_memory(env, { query: 'book Rahul' }, { now: NOW });
  assert.ok(!again.matches.some((m) => /Atomic/.test(m.text)));
  assert.equal((await TOOLS.ask_memory(env, { query: 'zzz unrelated' }, { now: NOW })).matches.length, 0);
});

test('older notes get indexed lazily on first search', async () => {
  const env = makeEnv({ __embed: toyEmbed });
  await env.DB.prepare('INSERT INTO notes (text, created_at) VALUES (?, ?)').bind('Cricket match tickets booked', NOW).run(); // saved without indexing
  const r = await TOOLS.ask_memory(env, { query: 'ipl' }, { now: NOW });
  assert.equal(r.matches[0].text, 'Cricket match tickets booked');
});

test('ask_memory falls back to keywords when embeddings are down', async () => {
  const env = makeEnv({ __embed: async () => { throw new Error('AI down'); } });
  await env.DB.prepare('INSERT INTO notes (text, created_at) VALUES (?, ?)').bind('Pay electricity bill', NOW).run();
  const r = await TOOLS.ask_memory(env, { query: 'electricity' }, { now: NOW });
  assert.equal(r.matches[0].text, 'Pay electricity bill');
  assert.match(r.note, /keyword/);
});

test('contacts: remember, merge facts, about_person, forget', async () => {
  const env = makeEnv({ __embed: toyEmbed });
  const a = await runTool(env, 'remember_contact', { name: 'Rahul', fact: 'wife is Neha, loves cricket' }, { now: NOW });
  assert.deepEqual(a.facts, ['wife is Neha, loves cricket']);
  await runTool(env, 'remember_contact', { name: 'rahul', fact: 'works at Infosys' }, { now: NOW });
  await runTool(env, 'remember_contact', { name: 'RAHUL', fact: 'Works at Infosys' }, { now: NOW }); // duplicate ignored
  await runTool(env, 'save_note', { text: 'Rahul recommended Atomic Habits' }, { now: NOW });
  const p = await TOOLS.about_person(env, { name: 'Rahul' }, { now: NOW });
  assert.equal(p.facts.length, 2);
  assert.match(p.mentioned_in[0].text, /Atomic Habits/);
  const viaMemory = await TOOLS.ask_memory(env, { query: 'who loves cricket' }, { now: NOW });
  assert.equal(viaMemory.matches[0].kind, 'contact');
  assert.ok((await TOOLS.about_person(env, { name: 'Nobody' }, { now: NOW })).error);
  assert.equal((await TOOLS.list_contacts(env)).count, 1);
  assert.equal((await TOOLS.forget_contact(env, { name: 'rahul' })).forgotten, true);
  assert.equal((await TOOLS.list_contacts(env)).count, 0);
});

test('post slots: Tue/Wed/Thu at the chosen time, no double booking', async () => {
  const env = makeEnv();
  const slots = await nextSlots(env, NOW, 3, '09:00');
  assert.deepEqual(slots.map((s) => formatIST(s)), ['2026-10-22 09:00', '2026-10-27 09:00', '2026-10-28 09:00']);
  const more = await nextSlots(env, NOW, 5, '09:00');
  assert.equal(more.length, 5); // falls back to Mon/Fri
});

function postEnv(extra = {}) {
  return makeEnv({
    __llm: async (messages) => {
      const idea = messages.at(-1).content.replace('Idea: ', '');
      return `"Hook about ${idea.slice(0, 20)}.\n\nShort line two.\n\nWhat do you think?"`;
    },
    ...extra,
  });
}

test('plan_posts drafts from unused ideas, schedules reminders, and does not reuse ideas', async () => {
  mockWorld();
  const env = postEnv();
  await runTool(env, 'save_idea', { kind: 'linkedin', text: 'why my WhatsApp bot costs Rs 0' }, { now: NOW });
  await runTool(env, 'save_idea', { kind: 'linkedin', text: 'habit tracking with a chat bot' }, { now: NOW });
  await runTool(env, 'save_idea', { kind: 'standup', text: 'not a post idea' }, { now: NOW });
  await TOOLS.save_style(env, { text: 'my own sample post' });
  const r = await TOOLS.plan_posts(env, { count: 3 }, { now: NOW });
  assert.equal(r.drafted, 2);
  assert.equal(r.posts[0].status, 'scheduled');
  assert.match(r.posts[0].text, /^Hook about why my WhatsApp/);
  assert.doesNotMatch(r.posts[0].text, /^"/); // quotes stripped
  assert.equal(r.posts[0].when, '2026-10-22 09:00');
  const reminders = (await env.DB.prepare("SELECT * FROM reminders WHERE status = 'pending'").all()).results;
  assert.equal(reminders.length, 2);
  assert.ok((await TOOLS.plan_posts(env, {}, { now: NOW })).error); // nothing left
  // cancelling frees the idea again
  await TOOLS.cancel_post(env, { id: 1 });
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM reminders WHERE status = 'pending'").first()).n, 1);
  assert.equal((await TOOLS.plan_posts(env, {}, { now: NOW })).drafted, 1);
});

test('the draft prompt carries the saved writing samples', async () => {
  let system = '';
  const env = makeEnv({ __llm: async (m) => { system = m[0].content; return 'A decent post with enough words in it to pass.'; } });
  await TOOLS.save_style(env, { text: 'Shipped a thing. It broke. Shipped it again.' });
  await runTool(env, 'save_idea', { kind: 'linkedin', text: 'idea one' }, { now: NOW });
  await TOOLS.plan_posts(env, { count: 1 }, { now: NOW });
  assert.match(system, /Shipped a thing\. It broke/);
  assert.match(system, /dry humor|Dry humor/i);
});

test('post reminder delivers the full text and marks it sent; template path stays short', async () => {
  const sent = mockWorld();
  const env = postEnv();
  await runTool(env, 'save_idea', { kind: 'linkedin', text: 'launch story' }, { now: NOW });
  await TOOLS.plan_posts(env, { count: 1 }, { now: NOW });
  const due = parseIST('2026-10-22 09:00');
  await setState(env, 'last_inbound_at', due - 1000);
  await runDueReminders(env, due + 1000);
  const body = sent.at(-1).text.body;
  assert.match(body, /LinkedIn post time/);
  assert.match(body, /Hook about launch story/);
  assert.match(body, /posted 1/);
  assert.equal((await TOOLS.get_post(env, { id: 1 })).status, 'sent');
  assert.equal((await TOOLS.mark_posted(env, { id: 1 })).posted, true);

  // window closed -> template with a short pointer
  const sent2 = mockWorld();
  const env2 = postEnv();
  await runTool(env2, 'save_idea', { kind: 'linkedin', text: 'second story' }, { now: NOW });
  await TOOLS.plan_posts(env2, { count: 1 }, { now: NOW });
  await runDueReminders(env2, due + 1000);
  const tpl = sent2.at(-1).template.components[0].parameters[0].text;
  assert.match(tpl, /show post 1/);
  assert.doesNotMatch(tpl, /Hook about/);
});

test('prompt always carries memory tools; post tools only for post topics', () => {
  const lean = buildSystemPrompt(NOW, '', 'buy milk');
  assert.match(lean, /ask_memory/);
  assert.match(lean, /remember_contact/);
  assert.doesNotMatch(lean, /plan_posts/);
  assert.match(buildSystemPrompt(NOW, '', 'turn my saved ideas into this weeks posts'), /plan_posts/);
  assert.match(buildSystemPrompt(NOW, '', 'posted 12'), /mark_posted/);
});
