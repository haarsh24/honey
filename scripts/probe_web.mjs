// Compares search sources for a live-price question. Prints short answers only.
import { geminiWeb } from '../src/gemini.js';
const env = { GEMINI_KEY: process.env.GEMINI_KEY, GEMINI_MODEL: 'gemini-flash-lite-latest' };
const q = 'petrol price in Ranchi today';
const enc = encodeURIComponent(q);
const sources = {
  ddg: `https://html.duckduckgo.com/html/?q=${enc}`,
  bing: `https://www.bing.com/search?q=${enc}`,
  googlenews: `https://news.google.com/rss/search?q=${enc}&hl=en-IN&gl=IN&ceid=IN:en`,
  goodreturns: 'https://www.goodreturns.in/petrol-price-in-ranchi.html',
  mypetrolprice: 'https://www.mypetrolprice.com/ranchi/petrol-price-in-ranchi',
};
for (const [name, url] of Object.entries(sources)) {
  try {
    const { text } = await geminiWeb(env, { prompt: `Read this page: ${url}\n\nWhat is today's petrol price per litre in Ranchi? Answer in one line with the number and the source, or say NOT FOUND.` });
    console.log(`::notice title=web probe ${name}::${text.replace(/\s+/g, ' ').slice(0, 260)}`);
  } catch (e) {
    console.log(`::notice title=web probe ${name}::ERROR ${e.message.slice(0, 160)}`);
  }
  await new Promise((r) => setTimeout(r, 6000));
}
