import { gemini } from './gemini.js';
import { runTool } from './tools.js';
import { parseIST } from './time.js';
import { parseModelJson } from './util.js';
import { importStatement, reviewRange, setStatementDone } from './money.js';
import { istParts } from './time.js';

const MAX_BYTES = { audio: 8_000_000, image: 6_000_000, document: 10_000_000 };

/** Download a WhatsApp media file (two steps: look up the URL, then fetch the bytes). */
export async function downloadMedia(env, id, maxBytes) {
  const version = env.GRAPH_VERSION || 'v25.0';
  const headers = { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` };
  const infoResponse = await fetch(`https://graph.facebook.com/${version}/${id}`, { headers });
  const info = await infoResponse.json().catch(() => ({}));
  if (!infoResponse.ok || !info.url) throw new Error(`Could not look up media (${infoResponse.status})`);
  if (info.file_size && info.file_size > maxBytes) {
    const error = new Error('file too large');
    error.code = 'TOO_LARGE';
    throw error;
  }
  const fileResponse = await fetch(info.url, { headers });
  if (!fileResponse.ok) throw new Error(`Could not download media (${fileResponse.status})`);
  const bytes = new Uint8Array(await fileResponse.arrayBuffer());
  if (bytes.length > maxBytes) {
    const error = new Error('file too large');
    error.code = 'TOO_LARGE';
    throw error;
  }
  return { bytes, mime: String(info.mime_type || '').split(';')[0].trim() };
}

const money = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

async function handleVoice(env, media) {
  const transcript = await gemini(env, {
    media,
    prompt:
      'Transcribe this voice note exactly as spoken. The speaker may use English, Hindi or a mix (Hinglish); keep their words and language, writing Hindi in Roman letters. Output only the transcript, nothing else. If there is no speech, output exactly: NO_SPEECH',
  });
  const text = clip(transcript, 1500);
  if (!text || text === 'NO_SPEECH') return { reply: "All I heard was silence 🦗 Try that voice note again?" };
  if (text.length > 350) {
    return {
      text: `[Long voice note, probably meeting notes or a brain dump. Follow the meeting-notes rule.] ${text}`,
      prefix: `🎤 "${text.slice(0, 160)}…"`,
    };
  }
  return { text, prefix: `🎤 "${text}"` };
}

const STATEMENT_HINT = /statement|passbook|transactions?|upi history|spends/i;

/** Reads a bank/UPI/card statement (PDF or screenshot), saves the spends and shows where the money went. */
async function handleStatement(env, media, nowMs) {
  const year = istParts(nowMs).y;
  const raw = await gemini(env, {
    media,
    json: true,
    prompt: `This is a bank, UPI or credit card statement or a transaction history. Answer ONLY with JSON: {"transactions":[{"date":"YYYY-MM-DD","desc":"merchant or payee, max 40 characters","amount":number,"category":"food|groceries|travel|bills|shopping|health|entertainment|learning|personal|other"}]}. Include ONLY money going OUT (purchases, UPI payments, card spends, cash withdrawals, EMIs). Leave out credits, salary, refunds, interest, transfers between the owner's own accounts and credit card bill payments. Amounts are positive rupees. At most 150 transactions. Dates in the document may be DD/MM/YYYY or DD-MMM; the current year is ${year}.`,
  });
  const parsed = parseModelJson(raw);
  const transactions = Array.isArray(parsed?.transactions) ? parsed.transactions : [];
  if (!transactions.length) {
    return { reply: "I opened it but could not find any spends in it 🤔 Is it the transactions page? Try a clearer PDF or screenshot, or use /track 450 lunch, 120 auto." };
  }
  const result = await importStatement(env, transactions, nowMs);
  if (!result.from) return { reply: 'I read the file but the dates or amounts were not clear enough to save. Try another screenshot or /track your spends.' };
  await setStatementDone(env);
  const review = await reviewRange(env, result.from, result.to + 24 * 3600 * 1000, `${result.inserted + result.duplicates} spends from your statement`, nowMs);
  const head = `📄 Statement read: ${result.inserted + result.duplicates} spends found. ${result.inserted} new (${money(result.total)}) saved${result.duplicates ? `, ${result.duplicates} were already logged so I skipped them` : ''}.`;
  return { reply: `${head}\n\n${review.text}`.slice(0, 3900) };
}

async function handleImage(env, msg, media, nowMs) {
  const caption = clip(msg.media.caption, 300);
  if (STATEMENT_HINT.test(caption)) return handleStatement(env, media, nowMs);
  const raw = await gemini(env, {
    media,
    json: true,
    prompt: `Look at this image and answer ONLY with JSON: {"type":"receipt"|"statement"|"other","merchant":string,"amount":number,"currency":"INR"|"USD"|"EUR"|...,"date":"YYYY-MM-DD" or "","category":"food|groceries|travel|shopping|bills|health|entertainment|other","summary":"one or two sentences describing the image","text":"any readable text in the image, max 800 characters"}. Use type "receipt" only for ONE bill, invoice or payment screenshot, and then amount is the final total paid. Use type "statement" for a bank, UPI or card transaction history that lists many transactions. For non-receipts set amount to 0.${caption ? ` The user's caption: "${caption}"` : ''}`,
  });
  const a = parseModelJson(raw) ?? { type: 'other', summary: clip(raw, 400), text: '' };
  if (a.type === 'statement') return handleStatement(env, media, nowMs);

  const amount = Number(a.amount);
  if (a.type === 'receipt' && Number.isFinite(amount) && amount > 0) {
    const currency = String(a.currency || 'INR').toUpperCase();
    const merchant = clip(a.merchant, 60);
    if (!['INR', '₹', 'RS', 'RS.'].includes(currency)) {
      return {
        reply: `That receipt looks like ${currency} ${amount}${merchant ? ` at ${merchant}` : ''}. I only log rupees, so I didn't save it. Tell me the amount in rupees, e.g. "spent 1050 on ${a.category || 'food'}".`,
      };
    }
    let date;
    const parsed = parseIST(String(a.date || ''), '12:00');
    if (parsed !== null && parsed < nowMs + 24 * 3600 * 1000) date = String(a.date).slice(0, 10);
    const result = await runTool(
      env,
      'log_expense',
      {
        amount,
        category: a.category || 'other',
        note: [merchant, caption].filter(Boolean).join(' - ') || undefined,
        date,
      },
      { now: nowMs },
    );
    if (result.error) return { reply: `I read the receipt but could not save it: ${result.error}` };
    return {
      reply: `Logged ${money(result.amount)} under ${result.category}${merchant ? ` (${merchant})` : ''} on ${result.date.slice(0, 10)}. Wrong? Say "delete expense ${result.id}".`,
    };
  }

  return {
    text: `[Image${caption ? ` with caption: "${caption}"` : ''}] ${clip(a.summary, 500)}${a.text ? ` Text in the image: ${clip(a.text, 800)}` : ''}`,
  };
}

async function handleDocument(env, msg, media, nowMs) {
  const caption = clip(msg.media.caption, 300);
  const name = clip(msg.media.filename, 80) || 'document';
  if (STATEMENT_HINT.test(caption) || /statement/i.test(name)) return handleStatement(env, media, nowMs);
  const raw = await gemini(env, {
    media,
    json: true,
    prompt: `Read this document and answer ONLY with JSON: {"kind":"statement"|"other","summary":"3-5 sentence summary","deadlines":[{"date":"YYYY-MM-DD","what":"short description, e.g. Electricity bill due Rs 1,240"}],"amounts":"key amounts in one line or empty"}. Use kind "statement" only for a bank, UPI or credit card statement that lists many transactions. Only include deadlines that are explicit due dates or deadlines in the document, up to 3.${caption ? ` The user's note: "${caption}"` : ''}`,
  });
  const d = parseModelJson(raw) ?? { summary: clip(raw, 600), deadlines: [] };
  if (d.kind === 'statement') return handleStatement(env, media, nowMs);

  const created = [];
  for (const item of Array.isArray(d.deadlines) ? d.deadlines.slice(0, 3) : []) {
    const when = `${String(item?.date ?? '').slice(0, 10)} 09:00`;
    const due = parseIST(when);
    if (due === null || due <= nowMs || !item?.what) continue;
    const result = await runTool(
      env,
      'add_reminder',
      { text: clip(item.what, 150), when, repeat: 'none' },
      { now: nowMs },
    );
    if (result.saved) created.push(`${clip(item.what, 100)} (reminder ${result.due_ist})`);
  }

  return {
    text:
      `[Document "${name}"${caption ? ` with note: "${caption}"` : ''}] ${clip(d.summary, 900)}` +
      `${d.amounts ? ` Amounts: ${clip(d.amounts, 200)}.` : ''}` +
      `${created.length ? ` Reminders already created automatically: ${created.join('; ')}.` : ''}`,
  };
}

/**
 * Turns a voice note, photo or PDF into either { reply } (fully handled)
 * or { text, prefix } (text for the assistant, plus a line to show the user first).
 */
export async function handleMedia(env, msg, nowMs) {
  const { type } = msg;
  const info = msg.media;
  if (!info?.id) return { reply: "I couldn't open that file." };

  if (type === 'document' && info.mime !== 'application/pdf' && !String(info.mime).startsWith('image/')) {
    return { reply: 'I can read PDFs and images. Other file types are not supported yet.' };
  }
  const isImage = type === 'image' || (type === 'document' && String(info.mime).startsWith('image/'));
  const limit = type === 'audio' ? MAX_BYTES.audio : isImage ? MAX_BYTES.image : MAX_BYTES.document;
  const media = await downloadMedia(env, info.id, limit);

  if (type === 'audio') return handleVoice(env, media);
  if (isImage) return handleImage(env, msg, media, nowMs);
  return handleDocument(env, msg, media, nowMs);
}
