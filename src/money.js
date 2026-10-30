// Money tracker: quick /track logging, spending review ("where am I overspending"), budgets,
// bank/UPI statement import and the weekly check-in. Everything here is plain code (no AI quota),
// except reading the statement file itself, which media.js does with Gemini.
import { getState, setState } from './db.js';
import { inReplyWindow, sendProactive } from './outbound.js';
import { formatIST, istParts, parseIST, startOfISTDay } from './time.js';
import { normalizePhone } from './util.js';

const ownerNumber = (env) => normalizePhone(env.OWNER_NUMBER, env.DEFAULT_COUNTRY_CODE ?? '91');

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const CATEGORIES = ['food', 'groceries', 'travel', 'bills', 'shopping', 'health', 'entertainment', 'learning', 'personal', 'other'];
// "Wants": the categories where cutting back is easiest.
const WANTS = new Set(['food', 'entertainment', 'shopping', 'personal']);

const WORDS = {
  food: 'lunch dinner breakfast chai tea coffee snack snacks swiggy zomato restaurant cafe biryani pizza burger momo momos thali food eat eating sweets icecream juice dominos mcd kfc haldiram haldirams paratha dosa idli samosa chaat tiffin maggi cake',
  groceries: 'grocery groceries sabzi vegetable vegetables fruit fruits milk blinkit zepto instamart bigbasket dmart kirana atta rice eggs egg paneer curd dahi bread oil dal',
  travel: 'petrol diesel fuel auto cab uber ola rapido metro bus train flight toll parking irctc ticket taxi bike rickshaw',
  bills: 'bill bills electricity wifi broadband internet recharge rent emi insurance water gas lpg maintenance jio airtel vodafone postpaid prepaid loan tax',
  shopping: 'amazon flipkart myntra shirt shoes clothes shopping meesho ajio gadget headphones watch bag jeans tshirt',
  health: 'medicine medicines pharmacy doctor hospital gym medical apollo 1mg lab protein supplement whey dentist checkup',
  entertainment: 'movie movies netflix spotify prime hotstar game gaming concert youtube party pvr bookmyshow subscription outing',
  learning: 'course udemy book books coursera class tuition exam',
  personal: 'haircut salon grooming perfume spa skincare barber',
};
const WORD_TO_CATEGORY = new Map(Object.entries(WORDS).flatMap(([cat, list]) => list.split(' ').map((w) => [w, cat])));

export function guessCategory(text) {
  for (const word of String(text).toLowerCase().split(/[^a-z0-9]+/)) {
    const hit = WORD_TO_CATEGORY.get(word);
    if (hit) return hit;
  }
  return 'other';
}

export const money = (n) => `₹${Math.round(Number(n)).toLocaleString('en-IN')}`;
const pct = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
const dayLabel = (ms) => {
  const p = istParts(ms);
  return `${p.d} ${MONTHS[p.mo - 1]}`;
};

// ---------- parsing "450 lunch, 120 auto, 2k groceries" ----------

const FILLER = /\b(spent|paid|pay|gave|bought|buy|for|on|of|at|to|rs|inr|rupees|rupee|today|the|a|an|my|in)\b/gi;

/** One piece such as "lunch 450" or "₹1.2k petrol". Uses the largest number as the amount. */
function parsePiece(piece) {
  const numbers = [...piece.matchAll(/(\d+(?:\.\d+)?)\s*(k|l|lakh|lac)?\b/gi)].map((m) => {
    const unit = (m[2] || '').toLowerCase();
    const value = Number(m[1]) * (unit === 'k' ? 1000 : unit ? 100000 : 1);
    return { value, text: m[0], index: m.index };
  });
  if (!numbers.length) return null;
  const best = numbers.reduce((a, b) => (b.value > a.value ? b : a));
  if (!(best.value > 0) || best.value > 1e8) return null;
  const rest = (piece.slice(0, best.index) + ' ' + piece.slice(best.index + best.text.length))
    .replace(/[₹$]/g, ' ')
    .replace(FILLER, ' ')
    .replace(/[^\p{L}\p{N}\s&'.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { amount: Math.round(best.value * 100) / 100, note: rest.slice(0, 80) };
}

/** Splits free text into expenses. Returns { items: [{amount, category, note, spentAt}], skipped: [text] }. */
export function parseTrack(input, now) {
  let text = String(input ?? '').replace(/(\d),(\d{3})/g, '$1$2');
  let spentAt = now;
  if (/\bday before yesterday\b/i.test(text)) {
    spentAt = now - 2 * DAY_MS;
    text = text.replace(/\bday before yesterday\b/gi, ' ');
  } else if (/\b(yesterday|kal)\b/i.test(text)) {
    spentAt = now - DAY_MS;
    text = text.replace(/\b(yesterday|kal)\b/gi, ' ');
  }
  const pieces = text.split(/[\n;,]|\s+&\s+|\s+(?:and|aur)\s+|\s+\+\s+/i).map((p) => p.trim()).filter(Boolean);
  const merged = [];
  let carry = '';
  for (const piece of pieces) {
    if (/\d/.test(piece)) {
      merged.push(`${carry} ${piece}`.trim());
      carry = '';
    } else {
      carry = `${carry} ${piece}`.trim(); // "chicken" + "rice 250" -> "chicken rice 250"
    }
  }
  const items = [];
  const skipped = [];
  for (const piece of merged) {
    const parsed = parsePiece(piece);
    if (!parsed) {
      skipped.push(piece);
      continue;
    }
    items.push({ amount: parsed.amount, note: parsed.note || null, category: guessCategory(parsed.note || piece), spentAt });
  }
  if (carry) skipped.push(carry);
  return { items: items.slice(0, 25), skipped };
}

async function insertExpense(env, item, source = 'manual') {
  const result = await env.DB.prepare('INSERT INTO expenses (amount, category, note, spent_at, source) VALUES (?, ?, ?, ?, ?)')
    .bind(item.amount, item.category, item.note, item.spentAt, source)
    .run();
  return result.meta.last_row_id;
}

// ---------- budgets ----------

export async function getBudgets(env) {
  try {
    const obj = JSON.parse((await getState(env, 'budgets')) || '{}');
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

async function setBudget(env, category, amount) {
  const budgets = await getBudgets(env);
  const key = String(category || 'total').trim().toLowerCase().slice(0, 30);
  budgets[key === 'overall' || key === 'all' ? 'total' : key] = Math.round(amount);
  await setState(env, 'budgets', JSON.stringify(budgets));
  return budgets;
}

async function monthSpend(env, now) {
  const p = istParts(now);
  const from = Date.UTC(p.y, p.mo - 1, 1) - 330 * 60 * 1000;
  const { results } = await env.DB.prepare('SELECT category, SUM(amount) AS total FROM expenses WHERE spent_at >= ? AND spent_at < ? GROUP BY category')
    .bind(from, now + 1)
    .all();
  const by = Object.fromEntries(results.map((r) => [r.category, r.total]));
  return { by, total: results.reduce((s, r) => s + r.total, 0), day: p.d, daysInMonth: new Date(Date.UTC(p.y, p.mo, 0)).getUTCDate() };
}

async function budgetLines(env, now) {
  const budgets = await getBudgets(env);
  const keys = Object.keys(budgets);
  if (!keys.length) return { lines: [], over: [] };
  const m = await monthSpend(env, now);
  const lines = [];
  const over = [];
  for (const key of keys) {
    const spent = key === 'total' ? m.total : m.by[key] ?? 0;
    const limit = budgets[key];
    const projected = (spent / Math.max(m.day, 1)) * m.daysInMonth;
    const used = Math.round((spent / limit) * 100);
    const icon = spent > limit ? '🔴' : projected > limit ? '🟠' : '🟢';
    lines.push(`${icon} ${key === 'total' ? 'Overall' : key}: ${money(spent)} of ${money(limit)} (${used}%)${spent <= limit && projected > limit ? `, on pace for ${money(projected)}` : ''}`);
    if (spent > limit) over.push(`${key === 'total' ? 'Overall' : key} is ${money(spent - limit)} over its ${money(limit)} budget`);
    else if (projected > limit) over.push(`${key === 'total' ? 'Overall' : key} is on pace to hit ${money(projected)} against ${money(limit)}`);
  }
  return { lines, over };
}

// ---------- review ----------

async function rangeTotals(env, from, to) {
  const { results } = await env.DB.prepare(
    'SELECT category, SUM(amount) AS total, COUNT(*) AS n FROM expenses WHERE spent_at >= ? AND spent_at < ? GROUP BY category ORDER BY total DESC',
  )
    .bind(from, to)
    .all();
  return { rows: results, total: results.reduce((s, r) => s + r.total, 0), count: results.reduce((s, r) => s + r.n, 0) };
}

/** Review of [from, to) against the equally long span before it. Returns { text, short, empty }. */
export async function reviewRange(env, from, to, label, now) {
  const span = Math.max(to - from, DAY_MS);
  const cur = await rangeTotals(env, from, to);
  if (!cur.count) {
    return { empty: true, short: `No spends logged for ${label}.`, text: `No spends logged for ${label} yet. Add some with /track 450 lunch, 120 auto, or send me a statement.` };
  }
  const prev = await rangeTotals(env, from - span, from);
  const prevBy = Object.fromEntries(prev.rows.map((r) => [r.category, r.total]));
  const days = Math.max(1, Math.round(span / DAY_MS));
  const change = pct(cur.total, prev.total);

  const out = [];
  out.push(`💰 Spending review: ${label}`);
  out.push(`Total ${money(cur.total)} (${money(cur.total / days)}/day)${prev.total ? ` vs ${money(prev.total)} before (${change >= 0 ? '+' : ''}${change}%)` : ''}`);
  out.push('');
  out.push('By category');
  for (const r of cur.rows.slice(0, 6)) {
    const before = prevBy[r.category] ?? 0;
    const arrow = before && r.total - before >= 100 ? ` ▲ ${money(r.total - before)}` : before && before - r.total >= 100 ? ` ▼ ${money(before - r.total)}` : '';
    out.push(`• ${r.category} ${money(r.total)} (${Math.round((r.total / cur.total) * 100)}%)${arrow}`);
  }

  // Where the extra spending is.
  const flags = [];
  const savings = [];
  for (const r of cur.rows) {
    const before = prevBy[r.category] ?? 0;
    const rise = r.total - before;
    if (before > 0 && rise >= Math.max(500, before * 0.3)) {
      flags.push(`${r.category} jumped ${money(rise)} (+${pct(r.total, before)}%) to ${money(r.total)}`);
      savings.push({ category: r.category, amount: rise });
    } else if (before === 0 && prev.total > 0 && r.total >= 1000) {
      flags.push(`New: ${r.category} ${money(r.total)} (nothing last period)`);
      savings.push({ category: r.category, amount: r.total });
    }
  }
  const wants = cur.rows.filter((r) => WANTS.has(r.category)).reduce((s, r) => s + r.total, 0);
  if (cur.total >= 1000 && wants / cur.total > 0.4) {
    flags.push(`${Math.round((wants / cur.total) * 100)}% went on wants (food out, shopping, entertainment, personal): ${money(wants)}`);
  }
  const small = await env.DB.prepare(
    'SELECT category, COUNT(*) AS n, SUM(amount) AS t FROM expenses WHERE spent_at >= ? AND spent_at < ? AND amount <= 300 GROUP BY category HAVING n >= 4 AND t >= 600 ORDER BY t DESC LIMIT 2',
  )
    .bind(from, to)
    .all();
  for (const r of small.results) flags.push(`Small ${r.category} spends add up: ${r.n} of them under ${money(300)} = ${money(r.t)}`);
  const repeats = await env.DB.prepare(
    "SELECT LOWER(note) AS who, COUNT(*) AS n, SUM(amount) AS t FROM expenses WHERE spent_at >= ? AND spent_at < ? AND note IS NOT NULL AND note != '' GROUP BY LOWER(note) HAVING n >= 3 ORDER BY t DESC LIMIT 2",
  )
    .bind(from, to)
    .all();
  for (const r of repeats.results) flags.push(`${r.who} ×${r.n} = ${money(r.t)}`);

  const budget = await budgetLines(env, now);
  flags.unshift(...budget.over); // hard limits first

  out.push('');
  if (flags.length) {
    out.push('⚠️ Where you are overspending');
    flags.slice(0, 6).forEach((f, i) => out.push(`${i + 1}. ${f}`));
  } else {
    out.push('✅ Nothing stands out as extra this period. Steady.');
  }

  const top = await env.DB.prepare('SELECT amount, category, note, spent_at FROM expenses WHERE spent_at >= ? AND spent_at < ? ORDER BY amount DESC LIMIT 3')
    .bind(from, to)
    .all();
  if (top.results.length) {
    out.push('');
    out.push(`Biggest: ${top.results.map((r) => `${money(r.amount)} ${r.note || r.category} (${dayLabel(r.spent_at)})`).join(', ')}`);
  }
  if (budget.lines.length) {
    out.push('');
    out.push('Budgets this month');
    out.push(...budget.lines);
  }
  if (savings.length) {
    const biggest = savings.sort((a, b) => b.amount - a.amount)[0];
    const trim = Math.round((biggest.amount * 0.5) / 50) * 50;
    if (trim >= 100) out.push('', `💡 Easiest win: bring ${biggest.category} back to normal and you keep about ${money(trim)}+ every ${days <= 8 ? 'week' : 'period'}.`);
  }

  const topCat = cur.rows[0];
  const short = `Spent ${money(cur.total)} in ${label}${prev.total ? ` (${change >= 0 ? '+' : ''}${change}% vs before)` : ''}. Most on ${topCat.category} (${money(topCat.total)}).${flags[0] ? ` Watch out: ${flags[0]}.` : ''}`;
  return { text: out.join('\n').slice(0, 3800), short, empty: false };
}

export async function spendingReview(env, args, now) {
  const today = startOfISTDay(now);
  if (args.from && args.to) {
    const from = parseIST(String(args.from), '00:00');
    const toDay = parseIST(String(args.to), '00:00');
    if (from !== null && toDay !== null && toDay >= from) {
      return reviewRange(env, from, toDay + DAY_MS, `${dayLabel(from)} to ${dayLabel(toDay)}`, now);
    }
  }
  const period = String(args.period || '').toLowerCase();
  if (period === 'month') {
    const p = istParts(now);
    const from = Date.UTC(p.y, p.mo - 1, 1) - 330 * 60 * 1000;
    // Compare with the same number of days at the start of last month.
    const elapsed = today + DAY_MS - from;
    const result = await reviewRange(env, from, from + elapsed, `this month so far (${dayLabel(from)} to ${dayLabel(today)})`, now);
    return result;
  }
  const n = Math.min(Math.max(Math.round(Number(args.days)) || 7, 1), 90);
  const from = today - (n - 1) * DAY_MS;
  return reviewRange(env, from, today + DAY_MS, n === 7 ? `last 7 days (${dayLabel(from)} to ${dayLabel(today)})` : `last ${n} days`, now);
}

// ---------- statements ----------

/** Adds statement lines to the expenses table, skipping ones already logged (same day and amount). */
export async function importStatement(env, transactions, now) {
  const rows = [];
  for (const t of Array.isArray(transactions) ? transactions.slice(0, 300) : []) {
    const amount = Math.round(Number(t?.amount) * 100) / 100;
    const spentAt = parseIST(String(t?.date ?? ''), '12:00');
    if (!(amount > 0) || amount > 1e8 || spentAt === null || spentAt > now + DAY_MS) continue;
    const note = String(t?.desc ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || null;
    const wanted = CATEGORIES.includes(String(t?.category).toLowerCase()) ? String(t.category).toLowerCase() : null;
    rows.push({ amount, note, spentAt, category: wanted && wanted !== 'other' ? wanted : guessCategory(note || '') });
  }
  if (!rows.length) return { inserted: 0, duplicates: 0, total: 0, from: null, to: null };
  const lo = Math.min(...rows.map((r) => r.spentAt));
  const hi = Math.max(...rows.map((r) => r.spentAt));
  const existing = (
    await env.DB.prepare('SELECT id, amount, spent_at FROM expenses WHERE spent_at >= ? AND spent_at < ?').bind(startOfISTDay(lo), startOfISTDay(hi) + DAY_MS).all()
  ).results.map((r) => ({ ...r, used: false }));
  let inserted = 0;
  let duplicates = 0;
  let total = 0;
  for (const row of rows) {
    const day = startOfISTDay(row.spentAt);
    const match = existing.find((e) => !e.used && Math.abs(e.amount - row.amount) < 0.5 && startOfISTDay(e.spent_at) === day);
    if (match) {
      match.used = true;
      duplicates += 1;
      continue;
    }
    await insertExpense(env, row, 'statement');
    inserted += 1;
    total += row.amount;
  }
  return { inserted, duplicates, total: Math.round(total), from: startOfISTDay(lo), to: startOfISTDay(hi) };
}

export async function setStatementDone(env) {
  await setState(env, 'await_statement_until', '0');
}

export async function awaitingStatement(env, now) {
  return Number((await getState(env, 'await_statement_until')) || 0) > now;
}

// ---------- /track, /budget, /statement ----------

export async function trackCommand(env, raw, now) {
  const rest = String(raw).replace(/^\/track\b/i, '').trim();
  if (/^(week|7)$/i.test(rest)) return (await spendingReview(env, { period: 'week' }, now)).text;
  if (/^(month|30)$/i.test(rest)) return (await spendingReview(env, { period: 'month' }, now)).text;
  if (!rest) {
    const today = await rangeTotals(env, startOfISTDay(now), now + 1);
    const m = await monthSpend(env, now);
    return [
      'Money tracker 💸',
      `Today: ${money(today.total)} · This month: ${money(m.total)}`,
      '',
      'Log spends in one go:',
      '/track 450 lunch, 120 auto, 2k groceries',
      '/track yesterday 300 chai and 800 petrol',
      '',
      'See where it goes: /track week or /track month',
      'Set limits: /budget food 6000 (or /budget total 30000)',
      'Weekly review: send your bank/UPI statement (PDF or screenshot) when I ask, or use /statement',
    ].join('\n');
  }
  const { items, skipped } = parseTrack(rest, now);
  if (!items.length) return 'I could not find an amount in that 🤔 Try: /track 450 lunch, 120 auto';
  const lines = [];
  let total = 0;
  for (const item of items) {
    const id = await insertExpense(env, item);
    total += item.amount;
    lines.push(`• ${money(item.amount)} ${item.note || item.category} → ${item.category} (#${id})`);
  }
  const today = await rangeTotals(env, startOfISTDay(now), now + 1);
  const budget = await budgetLines(env, now);
  const out = [`Logged ${items.length} spend${items.length > 1 ? 's' : ''}, ${money(total)} 👍`, ...lines];
  if (skipped.length) out.push(`Skipped (no amount): ${skipped.join('; ').slice(0, 120)}`);
  out.push(`Today so far: ${money(today.total)}.`);
  if (budget.over.length) out.push(`⚠️ ${budget.over[0]}.`);
  out.push('Wrong one? "delete expense <number>".');
  return out.join('\n');
}

export async function budgetCommand(env, raw) {
  const rest = String(raw).replace(/^\/budget\b/i, '').trim();
  const budgets = await getBudgets(env);
  if (!rest) {
    const keys = Object.keys(budgets);
    if (!keys.length) return 'No budgets yet. Try /budget food 6000 or /budget total 30000 (monthly limits).';
    return ['Monthly budgets 🎯', ...keys.map((k) => `• ${k === 'total' ? 'Overall' : k}: ${money(budgets[k])}`), '', 'Remove one: /budget off food'].join('\n');
  }
  const off = /^(off|remove|delete)\s+(\w+)/i.exec(rest);
  if (off) {
    const key = off[2].toLowerCase() === 'overall' ? 'total' : off[2].toLowerCase();
    if (!(key in budgets)) return `No budget for ${off[2]}.`;
    delete budgets[key];
    await setState(env, 'budgets', JSON.stringify(budgets));
    return `Removed the ${off[2]} budget.`;
  }
  const parsed = parsePiece(rest);
  if (!parsed) return 'Try /budget food 6000 (a monthly limit for a category) or /budget total 30000.';
  const category = parsed.note ? (CATEGORIES.includes(parsed.note.toLowerCase()) ? parsed.note.toLowerCase() : guessCategory(parsed.note) !== 'other' ? guessCategory(parsed.note) : parsed.note.toLowerCase().split(' ')[0]) : 'total';
  await setBudget(env, category, parsed.amount);
  return `Budget set: ${category === 'total' ? 'overall' : category} ${money(parsed.amount)} a month 🎯 I will warn you when you're on pace to cross it.`;
}

export async function statementCommand(env, now) {
  await setState(env, 'await_statement_until', now + 3 * DAY_MS);
  return 'Send me your bank, UPI or credit card statement now (PDF or a screenshot of the transactions) 📄 I will pull out the spends, skip ones you already logged, and show where you are overspending.\n\nTip: add "statement" as the caption so I know what it is.';
}

// ---------- weekly check-in ----------

export async function runMoneyCheckin(env, now) {
  if ((await getState(env, 'money_checkin')) === 'off') return { skipped: 'off' };
  const today = formatIST(now).slice(0, 10);
  if ((await getState(env, 'last_money_checkin')) === today) return { skipped: 'already-sent' };
  const review = await spendingReview(env, { period: 'week' }, now);
  await setState(env, 'last_money_checkin', today);
  await setState(env, 'await_statement_until', now + 3 * DAY_MS);
  const ask = "Weekly money check-in 🧾 Send me this week's bank/UPI/card statement (PDF or screenshot) and I will find the extra spends. Missing a few? /track 450 lunch, 120 auto.";
  const text = review.empty ? `${review.short}\n\n${ask}` : `${review.text}\n\n${ask}`;
  const compact = `Weekly money check-in: ${review.short} Reply here and send your statement (PDF or screenshot) or use /track.`.slice(0, 600);
  await sendProactive(env, ownerNumber(env), text.slice(0, 3900), compact, now);
  return { sent: true };
}

// ---------- tools for the assistant ----------

export const MONEY_TOOLS = {
  async track_expenses(env, args, { now }) {
    const { items, skipped } = parseTrack(String(args.text ?? ''), now);
    if (!items.length) return { error: 'no amounts found; use log_expense for a single spend' };
    const saved = [];
    for (const item of items) saved.push({ id: await insertExpense(env, item), amount: item.amount, category: item.category, note: item.note });
    return { saved: saved.length, total: saved.reduce((s, i) => s + i.amount, 0), items: saved, skipped };
  },

  async spending_review(env, args, { now }) {
    const result = await spendingReview(env, args ?? {}, now);
    return { report: result.text, verbatim: result.text };
  },

  async set_budget(env, args) {
    const amount = Number(args.amount);
    if (!(amount > 0) || amount > 1e8) return { error: 'amount must be a positive number (monthly limit in rupees)' };
    const budgets = await setBudget(env, args.category || 'total', amount);
    return { saved: true, budgets };
  },

  async list_budgets(env) {
    return { budgets: await getBudgets(env) };
  },

  async remove_budget(env, args) {
    const budgets = await getBudgets(env);
    const key = String(args.category || '').trim().toLowerCase().replace(/^overall$/, 'total');
    if (!(key in budgets)) return { removed: false };
    delete budgets[key];
    await setState(env, 'budgets', JSON.stringify(budgets));
    return { removed: true };
  },
};
