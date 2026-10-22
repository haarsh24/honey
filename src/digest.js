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
    const source = decode(/<source[^>]*>([\s\S]*?)<\/source>/.exec(body)?.[1] ?? '');
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

async function rssHeadlines(topic, now) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${topic} when:2d`)}&hl=en-IN&gl=IN&ceid=IN:en`;
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; wa-assistant)' }, signal: controller.signal });
    if (!response.ok) return [];
    return parseNewsRss(await response.text(), now)
      .slice(0, 5)
      .map((i) => `- ${i.title} (${[i.source, i.when].filter(Boolean).join(', ')})`);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function searchHeadlines(env, topic) {
  const { text } = await geminiWeb(env, {
    prompt: `Read this web search results page: ${searchUrl(`${topic} latest news today`)}\n\nList up to 5 real news headlines about "${topic}" from it (full sentences that say what happened, not site names or section titles). One line each, plain text, start each with "- ", end with the source site name in brackets. No links, no intro. If the page only has site names and no actual headlines, output nothing.`,
  });
  return text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('-')).slice(0, 5);
}

async function headlines(env, topic, now = Date.now()) {
  const rss = await rssHeadlines(topic, now); // real headlines straight from Google News
  if (rss.length >= 2) return rss;
  return searchHeadlines(env, topic); // backup route
}

/** Message text for the given topics (or the saved ones). Returns null when there are none. */
export async function buildDigest(env, topics) {
  const list = (topics?.length ? topics : await getTopics(env)).slice(0, 4);
  if (!list.length) return null;
  const sections = await Promise.all(
    list.map(async (topic) => {
      try {
        const lines = await headlines(env, topic);
        return lines.length ? `*${topic}*\n${lines.join('\n')}` : `*${topic}*\n- Nothing fresh found`;
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
    return text ? { digest: text } : { error: 'No topics saved yet. Say which topics you want, like "news on AI and markets".' };
  },
};
