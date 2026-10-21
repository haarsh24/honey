// Stock and mutual fund prices (Yahoo Finance chart endpoint, mfapi.in) and price alerts.
const TIMEOUT_MS = 8000;
const UA = 'Mozilla/5.0 (compatible; wa-assistant)';
const ALIASES = { NIFTY: '^NSEI', NIFTY50: '^NSEI', SENSEX: '^BSESN', BANKNIFTY: '^NSEBANK' };
const inr = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Candidate Yahoo symbols for what the user typed (Indian stocks first). */
export function symbolCandidates(input) {
  const raw = String(input ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!raw) return [];
  if (ALIASES[raw]) return [ALIASES[raw]];
  if (raw.startsWith('^') || raw.includes('.') || raw.includes('=')) return [raw];
  return [`${raw}.NS`, `${raw}.BO`, raw];
}

async function yahooQuote(symbol) {
  for (const host of ['query1', 'query2']) {
    const data = await getJson(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`);
    const meta = data?.chart?.result?.[0]?.meta;
    if (meta && typeof meta.regularMarketPrice === 'number') {
      const prev = meta.chartPreviousClose ?? meta.previousClose;
      return {
        symbol,
        name: meta.shortName || meta.longName || symbol,
        price: meta.regularMarketPrice,
        currency: meta.currency || 'INR',
        previous_close: prev,
        change_pct: typeof prev === 'number' && prev ? Math.round(((meta.regularMarketPrice - prev) / prev) * 10000) / 100 : undefined,
      };
    }
  }
  return null;
}

async function mfQuote(code) {
  const data = await getJson(`https://api.mfapi.in/mf/${encodeURIComponent(code)}/latest`);
  const nav = Number(data?.data?.[0]?.nav);
  if (!data?.meta || !Number.isFinite(nav)) return null;
  return { symbol: `mf:${code}`, name: data.meta.scheme_name, price: nav, currency: 'INR', as_of: data.data[0].date };
}

/** Quote for a resolved symbol: "mf:<code>" or a Yahoo ticker. */
export async function getQuote(symbol) {
  return symbol.startsWith('mf:') ? mfQuote(symbol.slice(3)) : yahooQuote(symbol);
}

async function resolveStock(input) {
  for (const candidate of symbolCandidates(input)) {
    const q = await yahooQuote(candidate);
    if (q) return q;
  }
  return null;
}

export const MARKET_TOOLS = {
  async price_check(env, args) {
    const q = await resolveStock(args.symbol);
    if (!q) return { error: `Could not find a price for "${args.symbol}". Try the NSE ticker, like RELIANCE or TCS.` };
    return q;
  },

  async mf_nav(env, args) {
    const query = String(args.name ?? '').trim();
    if (!query) return { error: 'name is required' };
    const found = await getJson(`https://api.mfapi.in/mf/search?q=${encodeURIComponent(query)}`);
    if (!Array.isArray(found) || !found.length) return { error: `No mutual fund found for "${query}"` };
    const top = found.slice(0, 4);
    const quote = await mfQuote(top[0].schemeCode);
    return {
      best_match: quote ? { name: quote.name, scheme_code: top[0].schemeCode, nav: quote.price, as_of: quote.as_of } : { name: top[0].schemeName, scheme_code: top[0].schemeCode },
      other_matches: top.slice(1).map((f) => ({ name: f.schemeName, scheme_code: f.schemeCode })),
    };
  },

  /** target: a stock name/ticker, or "mf:<schemeCode>". Needs above and/or below. */
  async watch_price(env, args, { now }) {
    const above = args.above === undefined ? null : Number(args.above);
    const below = args.below === undefined ? null : Number(args.below);
    if ((above === null || !(above > 0)) && (below === null || !(below > 0))) return { error: 'give a positive "above" and/or "below" price' };
    const target = String(args.target ?? args.symbol ?? '').trim();
    const quote = /^mf:\d+$/i.test(target) ? await getQuote(target.toLowerCase()) : await resolveStock(target);
    if (!quote) return { error: `Could not find a price for "${target}"` };
    const created = [];
    for (const [direction, level] of [['above', above], ['below', below]]) {
      if (!(level > 0)) continue;
      if ((direction === 'above' && quote.price >= level) || (direction === 'below' && quote.price <= level)) {
        return { error: `${quote.name} is already ${direction === 'above' ? 'at or above' : 'at or below'} ${level} (now ${quote.price}). Pick a level it has not reached.` };
      }
      const r = await env.DB.prepare('INSERT INTO watches (symbol, label, direction, level, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(quote.symbol, quote.name.slice(0, 60), direction, level, now)
        .run();
      created.push({ id: r.meta.last_row_id, direction, level });
    }
    return { watching: quote.name, current_price: quote.price, alerts: created };
  },

  async list_watches(env) {
    const rows = (await env.DB.prepare('SELECT id, label, symbol, direction, level FROM watches WHERE active = 1 ORDER BY id').all()).results;
    return { watches: rows };
  },

  async remove_watch(env, args) {
    const id = Number(args.id);
    if (!Number.isInteger(id) || id <= 0) return { error: 'id must be a positive whole number' };
    const r = await env.DB.prepare('UPDATE watches SET active = 0 WHERE id = ? AND active = 1').bind(id).run();
    return r.meta.changes ? { removed: true } : { error: 'No active alert with that id' };
  },
};

/** Check active alerts of one kind ('stock' or 'mf'); returns the messages for alerts that fired. */
export async function checkWatches(env, now, kind) {
  const rows = (await env.DB.prepare('SELECT id, symbol, label, direction, level FROM watches WHERE active = 1').all()).results.filter(
    (w) => w.symbol.startsWith('mf:') === (kind === 'mf'),
  );
  const symbols = [...new Set(rows.map((w) => w.symbol))].slice(0, 15);
  const prices = new Map();
  await Promise.all(symbols.map(async (s) => {
    const q = await getQuote(s);
    if (q) prices.set(s, q.price);
  }));
  const messages = [];
  for (const w of rows) {
    const price = prices.get(w.symbol);
    if (price === undefined) continue;
    const hit = w.direction === 'above' ? price >= w.level : price <= w.level;
    if (!hit) continue;
    await env.DB.prepare('UPDATE watches SET active = 0, triggered_at = ? WHERE id = ?').bind(now, w.id).run();
    messages.push(`${w.direction === 'above' ? '📈' : '📉'} ${w.label} is ${w.direction === 'above' ? 'above' : 'below'} ${inr(w.level)} (now ${inr(price)}).`);
  }
  return messages;
}
