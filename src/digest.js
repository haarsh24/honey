// Daily news digest: Gemini searches the web for the owner's topics.
import { getState, setState } from './db.js';
import { geminiWeb, searchUrl } from './gemini.js';

const TOPICS_KEY = 'news_topics';

export async function getTopics(env) {
  try {
    const list = JSON.parse((await getState(env, TOPICS_KEY)) || '[]');
    return Array.isArray(list) ? list.filter((t) => typeof t === 'string').slice(0, 4) : [];
  } catch {
    return [];
  }
}

const decode = (t) =>
  t
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

function ago(ms, now) {
  const mins = Math.max(0, Math.round((now - ms) / 60000));
  if (mins < 60) return `${Math.max(mins, 1)}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

/** Parses a Google News RSS feed into [{ title, source, at }], newest first. */
export function parseNewsRss(xml, now = Date.now()) {
  const items = [];
  const seen = new Set();
  for (const m of String(xml).slice(0, 150000).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const body = m[1];
    let title = decode(/<title>([\s\S]*?)<\/title>/.exec(body)?.[1] ?? '');
    const source = decode(/<(?:News:)?source[^>]*>([\s\S]*?)<\/(?:News:)?source>/i.exec(body)?.[1] ?? '');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    const at = Date.parse(/<pubDate>([\s\S]*?)<\/pubDate>/.exec(body)?.[1] ?? '');
    const key = title.toLowerCase().slice(0, 60);
    if (!title || seen.has(key)) continue;
    seen.add(key);
    items.push({ title, source, at: Number.isFinite(at) ? at : null });
    if (items.length >= 30) break;
  }
  return items.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).map((i) => ({ ...i, when: i.at ? ago(i.at, now) : '' }));
}

const FINANCE = /\b(markets?|stocks?|shares?|sensex|nifty|economy|economic|finance|financial|business|investing|investment|mutual funds?|ipo|rbi|budget|inflation|rupee)\b/i;
const SEO_PAGE = /\b(price|prices|rate|rates)\b.*\b(today|in [A-Z][a-z]+)\b|\b(today|in [A-Z][a-z]+)\b.*\b(price|rates?)\s*$|\bhoroscope\b|\bpanchang\b|\b(petrol|diesel|lpg|cng|gold|silver|vegetable|sabzi) (price|rate)/i;
const SEO_SOURCE = /goodreturns|mypetrolprice|oneindia.*price|bankbazaar|policybazaar|astrosage/i;
const STOP = new Set(['about', 'after', 'amid', 'their', 'there', 'these', 'those', 'which', 'while', 'where', 'what', 'with', 'from', 'over', 'into', 'this', 'that', 'will', 'says', 'said', 'news', 'today']);
const words = (t) => new Set(String(t).toLowerCase().replace(/['’]s\b/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w)));

/** Query text: money topics are Indian-market news for this user unless they already name a place. */
export function queryFor(topic) {
  return FINANCE.test(topic) && !/\b(india|indian|us|usa|global|world|china|europe|uk)\b/i.test(topic) ? `${topic} India` : topic;
}

/** Drops price-listing/SEO pages and repeats of the same story, keeps order, returns at most n. */
export function pickHeadlines(items, n = 5) {
  const out = [];
  const seen = [];
  for (const item of items) {
    if (SEO_PAGE.test(item.title) || SEO_SOURCE.test(item.source || '')) continue;
    const w = words(item.title);
    if (seen.some((o) => [...w].filter((x) => o.has(x)).length >= 3)) continue; // same story as one already picked
    seen.push(w);
    out.push(item);
    if (out.length >= n) break;
  }
  return out;
}

// Google News blocks requests that come from Cloudflare's network (503), Bing News answers them, so Bing goes first.
const FEEDS = (topic) => [
  `https://www.bing.com/news/search?q=${encodeURIComponent(queryFor(topic))}&format=rss&setmkt=en-IN&qft=sortbydate%3d%221%22`,
  `https://news.google.com/rss/search?q=${encodeURIComponent(`${queryFor(topic)} when:2d`)}&hl=en-IN&gl=IN&ceid=IN:en`,
];

async function rssHeadlines(topic, now) {
  for (const url of FEEDS(topic)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; wa-assistant)' }, signal: controller.signal });
      if (!response.ok) continue;
      const lines = pickHeadlines(parseNewsRss(await response.text(), now), 5)
        .map((i) => `- ${i.title} (${[i.source, i.when].filter(Boolean).join(', ')})`);
      if (lines.length >= 2) return lines;
    } catch {
      // try the next feed
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

async function searchHeadlines(env, topic) {
  const { text } = await geminiWeb(env, {
    prompt: `Read this web search results page: ${searchUrl(`${topic} latest news today`)}\n\nList up to 5 real news headlines about "${topic}" from it (full sentences that say what happened, not site names or section titles). One line each, plain text, start each with "- ", end with the source site name in brackets. No links, no intro. If the page only has site names and no actual headlines, output nothing.`,
  });
  return text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('-')).slice(0, 5);
}

async function headlines(env, topic, now = Date.now()) {
  const rss = await rssHeadlines(topic, now); // real headlines straight from a news feed
  if (rss.length >= 2) return rss;
  try {
    return await searchHeadlines(env, topic); // backup route
  } catch {
    return [];
  }
}

/** Message text for the given topics (or the saved ones). Returns null when there are none. */
export async function buildDigest(env, topics) {
  const list = (topics?.length ? topics : await getTopics(env)).slice(0, 4);
  if (!list.length) return null;
  const sections = await Promise.all(
    list.map(async (topic) => {
      try {
        const lines = await headlines(env, topic);
        return lines.length ? `*${topic}*\n${lines.join('\n')}` : `*${topic}*\n- Nothing fresh found right now, ask me again in a bit`;
      } catch {
        return `*${topic}*\n- Could not fetch this one right now`;
      }
    }),
  );
  return `📰 Your news digest\n\n${sections.join('\n\n')}`;
}

export const DIGEST_TOOLS = {
  async set_news_topics(env, args) {
    const topics = (Array.isArray(args.topics) ? args.topics : [])
      .map((t) => String(t).trim().slice(0, 60))
      .filter(Boolean)
      .slice(0, 4);
    if (!topics.length) return { error: 'give 1 to 4 topics, like ["AI", "stock market", "Ranchi"]' };
    await setState(env, TOPICS_KEY, JSON.stringify(topics));
    return { saved: true, topics, note: 'Digest arrives around 8:30 AM IST when we have chatted in the last 24 hours.' };
  },

  async stop_news(env) {
    await setState(env, TOPICS_KEY, '[]');
    return { stopped: true };
  },

  /** Headlines right now for saved topics, or for the given topic. */
  async news_now(env, args) {
    const topics = typeof args.topic === 'string' && args.topic.trim() ? [args.topic.trim().slice(0, 60)] : [];
    const text = await buildDigest(env, topics);
    return text ? { digest: text, verbatim: text } : { error: 'No topics saved yet. Say which topics you want, like "news on AI and markets".' };
  },
};
