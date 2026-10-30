// End-to-end check of every feature with the REAL prompt, tools, network and Gemini as the model.
// WhatsApp sends are captured, never delivered. Run by .github/workflows/e2e.yml.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDB, OWNER } from '../tests/helpers.mjs';
import { TOOLS } from '../src/tools.js';
import { handleIncoming } from '../src/handler.js';
import { buildBriefing } from '../src/briefing.js';
import { runDueReminders } from '../src/reminders.js';
import { setState } from '../src/db.js';

const realFetch = globalThis.fetch;
const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

// ---- media fixtures -------------------------------------------------------------------------
const media = {};
function tryMake(name, mime, make) {
  try {
    media[name] = { mime, bytes: make() };
  } catch (error) {
    console.log(`fixture ${name} unavailable: ${error.message.slice(0, 80)}`);
  }
}
tryMake('VOICE1', 'audio/wav', () => {
  const wav = join(dir, 'v.wav');
  execFileSync('espeak-ng', ['-s', '150', '-w', wav, 'Remind me to drink water at nine pm tonight']);
  return readFileSync(wav);
});
tryMake('IMG1', 'image/png', () => {
  const png = join(dir, 'r.png');
  const bin = (() => { try { execFileSync('which', ['magick']); return 'magick'; } catch { return 'convert'; } })();
  execFileSync(bin, ['-size', '700x420', 'xc:white', '-pointsize', '30', '-fill', 'black', '-annotate', '+30+60', 'HALDIRAMS RESTAURANT\nBill No 4412   Date 21-10-2026\nPaneer Thali       380\nSweet Lassi         70\nTOTAL Rs 450', png]);
  return readFileSync(png);
});
tryMake('PDF1', 'application/pdf', () => {
  const lines = ['Electricity Bill - Jharkhand Power', 'Consumer 55120', 'Amount due: Rs 1,240', 'Due date: 2026-11-05'];
  const stream = `BT /F1 18 Tf 50 740 Td 22 TL ${lines.map((l) => `(${l}) Tj T*`).join(' ')} ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
});

// ---- environment ----------------------------------------------------------------------------
const outbox = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('https://media.local/')) return new Response(media[u.split('/').pop()].bytes);
  if (u.includes('graph.facebook.com')) {
    if (init.method === 'POST' && u.endsWith('/messages')) {
      const b = JSON.parse(init.body);
      outbox.push(b.type === 'text' ? b.text.body : b.type === 'audio' ? '[audio message]' : `[${b.type}]`);
      return new Response('{"ok":true}');
    }
    if (init.method === 'POST') return new Response('{"id":"MEDIA1"}');
    const id = u.split('/').pop();
    const m = media[id];
    return m ? new Response(JSON.stringify({ url: `https://media.local/${id}`, mime_type: m.mime, file_size: m.bytes.length })) : new Response('{}', { status: 404 });
  }
  return realFetch(url, init);
};

// Real production model: calls go to the deployed Worker, which runs them on its Workers AI binding.
const WORKER = process.env.WORKER_URL;
const AI = WORKER && process.env.VERIFY_TOKEN ? {
  async run(model, input) {
    const response = await realFetch(`${WORKER}/selftest/ai?token=${encodeURIComponent(process.env.VERIFY_TOKEN)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, input }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(`workers-ai ${response.status}: ${String(data.error ?? 'failed').slice(0, 100)}`);
    return data.result;
  },
} : undefined;
console.log(`::notice title=e2e model::${AI ? 'Workers AI (production model)' : 'Gemini stand-in (worker URL missing)'}`);

const env = {
  AI,
  DB: makeDB(),
  OWNER_NUMBER: OWNER,
  PHONE_NUMBER_ID: '123',
  WHATSAPP_TOKEN: 'x',
  GRAPH_VERSION: 'v25.0',
  TYPING_INDICATOR: 'off',
  GEMINI_KEY: process.env.GEMINI_KEY,
  GEMINI_MODEL: 'gemini-flash-latest',
  LLM_PROVIDERS: AI ? 'workers-ai,gemini' : 'gemini',
  DEFAULT_COUNTRY_CODE: '91',
};

const trace = [];
const errs = [];
const origErr = console.error;
console.error = (...a) => { errs.push(a.join(' ').slice(0, 160)); };
for (const [name, fn] of Object.entries(TOOLS)) {
  TOOLS[name] = async (e, args, ctx) => {
    const result = await fn(e, args, ctx);
    trace.push(`${name}${result?.error ? '(error: ' + String(result.error).slice(0, 60) + ')' : ''}`);
    return result;
  };
}

// ---- scenarios ------------------------------------------------------------------------------
let n = 0;
const S = (group, user, { tools = [], reply, extra } = {}) => ({ group, user, tools, reply, extra });
const scenarios = [
  S('Essentials', 'hi', { reply: /./ }),
  S('Essentials', '/help', { reply: /Honey/ }),
  S('Essentials', 'save: book idea - Atomic Habits, recommended by Rahul', { tools: ['save_note'] }),
  S('Essentials', 'what book did I save?', { reply: /Atomic/i }),
  S('Essentials', 'remind me to call Mummy tomorrow at 6pm', { tools: ['add_reminder'], reply: /6/ }),
  S('Essentials', 'reminders', { reply: /Mummy/i }),
  S('Essentials', 'spent 450 on lunch', { tools: ['log_expense'], reply: /450/ }),
  S('Essentials', 'how much did I spend today?', { reply: /450/ }),
  S('Essentials', 'add task: renew insurance', { tools: ['add_task'] }),
  S('Essentials', 'tasks', { reply: /renew insurance/i }),
  S('Essentials', 'mark task 1 as done', { tools: ['complete_task'] }),
  S('Essentials', 'add task: temporary thing', { tools: ['add_task'] }),
  S('Essentials', 'undo', { tools: ['undo_last'] }),
  S('Money', '/track 450 lunch, 120 auto', { reply: /Logged 2 spends/ }),
  S('Money', 'spent 200 on chai and 500 on petrol', { reply: /700|200/ }),
  S('Money', 'set a budget of 6000 for food', { tools: ['set_budget'] }),
  S('Money', 'where am I overspending this week?', { tools: ['spending_review'], reply: /Spending review/ }),
  S('Habits', 'did gym today', { tools: ['log_habit'], reply: /streak|day|gym/i }),
  S('Habits', 'how are my habits?', { reply: /gym/i }),
  S('Memory', "Rahul's wife is Neha, she loves cricket", { tools: ['remember_contact'] }),
  S('Memory', 'what do I know about Rahul?', { tools: ['about_person'], reply: /Neha/ }),
  S('Memory', 'journal: shipped the WhatsApp bot today, felt great', { tools: ['save_journal'] }),
  S('Memory', 'what did I journal today?', { reply: /ship|bot/i }),
  S('Quick answers', 'what day of the week is 15 August 2027?', { tools: ['calc_date'], reply: /Sunday/i }),
  S('Quick answers', 'what is 18% of 2450?', { reply: /441/ }),
  S('Quick answers', 'convert 50 USD to INR', { tools: ['convert_currency'], reply: /\d,?\d{3}/ }),
  S('Quick answers', 'how many days till 25 December?', { tools: ['calc_date'], reply: /\b64\b/ }),
  S('Quick answers', "translate 'where is the railway station' to Hindi", { reply: /[ऀ-ॿ]|stesh|station/i }),
  S('Quick answers', 'weather in Ranchi', { tools: ['weather'], reply: /26|17/ }),
  S('Web & markets', 'search latest petrol price in Ranchi', { tools: ['web_search'], reply: /10\d/ }),
  S('Web & markets', 'summarise https://en.wikipedia.org/wiki/Ranchi', { tools: ['read_url'], reply: /Jharkhand/i }),
  S('Web & markets', 'price of Reliance', { tools: ['price_check'], reply: /\d{3,}/ }),
  S('Web & markets', 'what is the Nifty at?', { tools: ['price_check'], reply: /\d/ }),
  S('Web & markets', 'NAV of Parag Parikh Flexi Cap', { tools: ['mf_nav'], reply: /\d{2,}/ }),
  S('Web & markets', 'tell me when Reliance crosses 9000', { tools: ['watch_price'] }),
  S('Web & markets', 'news on AI and Indian stock market', { reply: /\(.+(ago|\d)/s, extra: 'digest' }),
  S('Work', 'idea: why my WhatsApp bot costs zero rupees', { tools: ['save_idea'] }),
  S('Work', 'idea: habit tracking inside WhatsApp', { tools: ['save_idea'] }),
  S('Work', 'this is my style: "Shipped a bot. It broke twice. Shipped it again. Growth mindset or stubbornness? Yes."', { tools: ['save_style'] }),
  S('Work', "turn my saved ideas into this week's posts", { tools: ['plan_posts'], reply: /Post|#\d/i }),
  S('Work', 'my scheduled posts', { tools: ['list_posts'] }),
  S('Work', 'write my standup', { tools: ['standup_data'] }),
  S('Work', 'draft an email asking my manager for leave on Friday', { reply: /Subject/i }),
  S('Learning', 'meeting notes: we discussed the Q4 roadmap. Rahul will send the design doc by Friday and I will review the API contract on Monday.', { tools: ['save_meeting'] }),
  S('Learning', 'quiz me on SQL joins', { tools: ['learn_topic'] }),
  S('Learning', '/quiz', { reply: /\?/ }),
  S('Tone', "I'm really stressed, my boss keeps piling work on me", { reply: /./ }),
];
tryMake('PDF2', 'application/pdf', () => {
  const lines = ['HDFC Bank Statement 20 Oct to 27 Oct 2026', '21/10/2026 SWIGGY 480.00 Dr', '22/10/2026 SWIGGY 520.00 Dr', '23/10/2026 AMAZON 2499.00 Dr', '24/10/2026 SALARY 50000.00 Cr', '25/10/2026 UBER 310.00 Dr'];
  const stream = `BT /F1 14 Tf 40 740 Td 20 TL ${lines.map((l) => `(${l}) Tj T*`).join(' ')} ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
});
const mediaScenarios = [
  { group: 'Money', name: 'bank statement PDF', msg: { type: 'document', media: { id: 'PDF2', mime: 'application/pdf', filename: 'statement.pdf', caption: 'statement' } }, tools: [], reply: /Statement read: [3-5] spends found[\s\S]*Spending review/ },
  { group: 'Voice, photo, PDF', name: 'voice note (text-to-speech sample)', msg: { type: 'audio', media: { id: 'VOICE1', mime: 'audio/wav' } }, tools: ['add_reminder'], reply: /water|9/i },
  { group: 'Voice, photo, PDF', name: 'receipt photo', msg: { type: 'image', media: { id: 'IMG1', mime: 'image/png', caption: '' } }, tools: ['log_expense'], reply: /450|Logged/i },
  { group: 'Voice, photo, PDF', name: 'electricity bill PDF', msg: { type: 'document', media: { id: 'PDF1', mime: 'application/pdf', filename: 'bill.pdf', caption: '' } }, tools: ['add_reminder'], reply: /1,?240|bill|electric/i },
];

const results = [];
async function run(label, group, send, expectTools = [], expectReply, extraCheck) {
  n += 1;
  trace.length = 0;
  outbox.length = 0;
  errs.length = 0;
  let error = '';
  try {
    await send();
  } catch (e) {
    error = e.message.slice(0, 120);
  }
  const reply = outbox.filter((m) => !m.startsWith('[audio')).join('\n---\n');
  const failures = [];
  if (error) failures.push(`threw: ${error}`);
  for (const t of expectTools) if (!trace.some((x) => x.startsWith(t))) failures.push(`tool ${t} not called`);
  if (trace.some((x) => x.includes('(error'))) failures.push(`tool error: ${trace.filter((x) => x.includes('(error')).join(', ')}`);
  if (expectReply && !expectReply.test(reply)) failures.push('reply does not match');
  if (/couldn't make sense|buffered|got stuck|AI providers failed/i.test(reply)) failures.push(`error reply (${errs.join(' | ') || 'no log'})`);
  if (extraCheck) failures.push(...extraCheck(reply));
  results.push({ n, group, label, tools: [...trace], reply, failures });
  await sleep(Number(process.env.E2E_DELAY_MS || 3000));
}

let id = 1000;
for (const s of scenarios) {
  await run(s.user, s.group, () => handleIncoming(env, { id: `m${id++}`, from: OWNER, type: 'text', text: s.user }), s.tools, s.reply,
    s.extra === 'digest' ? (reply) => {
      const lines = reply.split('\n').filter((l) => l.startsWith('- '));
      const bad = lines.filter((l) => !/\(.+\)\s*$/.test(l) || l.length < 35);
      return lines.length < 4 ? ['digest has fewer than 4 headline lines'] : bad.length ? [`${bad.length} digest lines look like page titles: ${bad[0].slice(0, 60)}`] : [];
    } : null);
}
for (const m of mediaScenarios) {
  if (!media[m.msg.media.id]) { results.push({ n: ++n, group: m.group, label: m.name, tools: [], reply: '', failures: ['fixture could not be made'] }); continue; }
  await run(m.name, m.group, () => handleIncoming(env, { id: `m${id++}`, from: OWNER, ...m.msg }), m.tools, m.reply);
}

// background jobs
await run('morning briefing text', 'Scheduled jobs', async () => {
  const { text } = await buildBriefing(env, Date.now());
  outbox.push(text);
}, [], /Good morning[\s\S]*°C|Good morning/, (reply) => (/🌤️/.test(reply) ? [] : ['no weather line in the briefing']));
await run('reminder rings with snooze hint', 'Scheduled jobs', async () => {
  await env.DB.prepare("INSERT INTO reminders (text, due_at, repeat, status, created_at) VALUES ('stand up and stretch', ?, 'none', 'pending', ?)").bind(Date.now() - 1000, Date.now() - 60000).run();
  await setState(env, 'last_inbound_at', Date.now());
  await runDueReminders(env, Date.now());
}, [], /stand up and stretch[\s\S]*snooze 10/);
await run('snooze after it rang', 'Scheduled jobs', () => handleIncoming(env, { id: `m${id++}`, from: OWNER, type: 'text', text: 'snooze 15' }), ['snooze_reminder'], /15|snooz/i);

// ---- report ---------------------------------------------------------------------------------
const groups = [...new Set(results.map((r) => r.group))];
let pass = 0;
for (const g of groups) {
  const rows = results.filter((r) => r.group === g);
  const text = rows.map((r) => {
    if (!r.failures.length) pass += 1;
    return `${r.failures.length ? 'FAIL' : 'PASS'} #${r.n} "${r.label.slice(0, 70)}"\n  tools: ${r.tools.join(', ') || '-'}\n  reply: ${r.reply.replace(/\n+/g, ' / ').slice(0, 420)}${r.failures.length ? `\n  WHY: ${r.failures.join('; ')}` : ''}`;
  }).join('\n');
  console.log(`::notice title=e2e ${g}::${esc(text)}`);
}
console.log(`::notice title=e2e summary::${pass}/${results.length} passed. Failed: ${results.filter((r) => r.failures.length).map((r) => '#' + r.n + ' ' + r.label.slice(0, 40)).join(' | ') || 'none'}`);
writeFileSync(join(dir, 'results.json'), JSON.stringify(results, null, 1));
