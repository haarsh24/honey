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

async function headlines(env, topic) {
  const { text } = await geminiWeb(env, {
    prompt: `Read this web search results page: ${searchUrl(`${topic} latest news today`)}\n\nList the 5 most important latest news headlines about "${topic}" from it (India focus when relevant). One line each, plain text, start each with "- ", end with the source site name in brackets. No links, no intro.`,
  });
  return text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('-')).slice(0, 5);
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
