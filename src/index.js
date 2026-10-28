import { buildDigest } from './digest.js';
import { runBriefing, runJournalPrompt, runWeekly } from './briefing.js';
import { runDrill } from './learning.js';
import { runCalorieSchedule } from './calories.js';
import { runDigest, runHabitNudge, runWatchCheck } from './jobs.js';
import { handleIncoming } from './handler.js';
import { cleanup, runDueReminders } from './reminders.js';
import { verifySignature } from './util.js';
import { embed } from './memory.js';
import { looksLikeMp3, synthesize } from './voice.js';

/** Pull plain messages out of Meta's webhook payload. Status updates are ignored. */
export function extractMessages(payload) {
  const messages = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const m of change?.value?.messages ?? []) {
        const file = m.audio ?? m.image ?? m.document;
        messages.push({
          id: m.id,
          from: m.from,
          type: m.type,
          text: m.text?.body,
          media: file
            ? { id: file.id, mime: file.mime_type, caption: file.caption, filename: file.filename }
            : undefined,
        });
      }
    }
  }
  return messages;
}

async function processMessage(env, message) {
  try {
    await handleIncoming(env, message);
  } catch (error) {
    console.error('Message handling failed:', error.message);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/webhook') {
      // Meta calls this once when you save the webhook URL in the dashboard.
      if (request.method === 'GET') {
        const ok =
          env.VERIFY_TOKEN &&
          url.searchParams.get('hub.mode') === 'subscribe' &&
          url.searchParams.get('hub.verify_token') === env.VERIFY_TOKEN;
        return ok
          ? new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 })
          : new Response('Forbidden', { status: 403 });
      }

      if (request.method === 'POST') {
        const raw = await request.text();
        const valid = await verifySignature(raw, request.headers.get('x-hub-signature-256'), env.APP_SECRET);
        if (!valid) {
          console.error('Webhook rejected: signature mismatch. Check that APP_SECRET is the Meta App Secret.');
          return new Response('Invalid signature', { status: 401 });
        }

        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          return new Response('Bad request', { status: 400 });
        }
        const incoming = extractMessages(payload);
        console.log(`Webhook received: ${incoming.length} message(s)`);
        // Reply 200 immediately; do the work in the background.
        for (const message of incoming) ctx.waitUntil(processMessage(env, message));
        return new Response('OK', { status: 200 });
      }
      return new Response('Method not allowed', { status: 405 });
    }

    // Owner-only health probe used by the deploy workflow: checks the embedding and speech models for real.
    if (url.pathname === '/selftest') {
      if (!env.VERIFY_TOKEN || url.searchParams.get('token') !== env.VERIFY_TOKEN) return new Response('Forbidden', { status: 403 });
      const out = {};
      try {
        const { model, vectors } = await embed(env, ['hello from the self test']);
        out.embeddings = { ok: true, model, bytes: vectors[0].length };
      } catch (error) {
        out.embeddings = { ok: false, error: error.message.slice(0, 200) };
      }
      try {
        const audio = await synthesize(env, 'Hello, this is a voice test.');
        out.tts = { ok: true, bytes: audio.length, mp3: looksLikeMp3(audio) };
      } catch (error) {
        out.tts = { ok: false, error: error.message.slice(0, 200) };
      }
      // Which news sources answer from Cloudflare's network?
      out.news = {};
      const srcs = {
        google: 'https://news.google.com/rss/search?q=AI%20when%3A2d&hl=en-IN&gl=IN&ceid=IN:en',
        bing: 'https://www.bing.com/news/search?q=AI&format=rss&setmkt=en-IN',
        yahoo: 'https://news.search.yahoo.com/rss?p=AI',
      };
      for (const [name, u] of Object.entries(srcs)) {
        try {
          const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; wa-assistant)' } });
          const t = await r.text();
          out.news[name] = { status: r.status, items: (t.match(/<item>/g) || []).length, head: r.ok ? '' : t.replace(/\s+/g, ' ').slice(0, 80) };
        } catch (error) {
          out.news[name] = { error: error.message.slice(0, 80) };
        }
      }
      try {
        out.news.sample = ((await buildDigest(env, ['AI'])) || '').split('\n').slice(2, 4).join(' | ').slice(0, 260);
      } catch (error) {
        out.news.sample = `error ${error.message.slice(0, 80)}`;
      }
      return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
    }

    // Lets the live end-to-end check use the real production model. Same secret as /selftest; chat and embedding models only.
    if (url.pathname === '/selftest/ai' && request.method === 'POST') {
      if (!env.VERIFY_TOKEN || url.searchParams.get('token') !== env.VERIFY_TOKEN) return new Response('Forbidden', { status: 403 });
      try {
        const { model, input } = await request.json();
        if (!/^@cf\/(meta\/llama|baai\/bge)/.test(String(model))) return new Response('Model not allowed', { status: 400 });
        const result = await env.AI.run(model, input);
        return new Response(JSON.stringify({ result }), { headers: { 'content-type': 'application/json' } });
      } catch (error) {
        return new Response(JSON.stringify({ error: String(error.message).slice(0, 200) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }

    if (url.pathname === '/') return new Response('wa-assistant is running');
    return new Response('Not found', { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    let now = controller.scheduledTime ?? Date.now();
    if (now < 1e11) now *= 1000; // tolerate seconds
    ctx.waitUntil(
      (async () => {
        try {
          await runDueReminders(env, now);
          const d = new Date(now);
          const hour = d.getUTCHours();
          const minute = d.getUTCMinutes();
          const [bh, bm] = (env.BRIEFING_TIME_UTC || '02:30').split(':').map(Number); // 08:00 IST
          if (hour === bh && minute === bm) await runBriefing(env, now);
          const at = (value, fallback) => (value || fallback).split(':').map(Number);
          const [jh, jm] = at(env.JOURNAL_TIME_UTC, '16:00'); // 21:30 IST
          const [qh, qm] = at(env.QUIZ_TIME_UTC, '07:30'); // 13:00 IST
          if (hour === jh && minute === jm) await runJournalPrompt(env, now);
          if (hour === qh && minute === qm) await runDrill(env, now);
          if (d.getUTCDay() === 0 && hour === 14 && minute === 30) await runWeekly(env, now); // Sunday 20:00 IST
          const [hh, hm] = at(env.HABIT_TIME_UTC, '15:00'); // 20:30 IST
          const [nh, nm] = at(env.NEWS_TIME_UTC, '03:00'); // 08:30 IST
          if (hour === hh && minute === hm) await runHabitNudge(env, now);
          if (hour === nh && minute === nm) await runDigest(env, now);
          // Indian market hours 09:15-15:30 IST = 03:45-10:00 UTC, Monday to Friday, every 15 minutes.
          const weekday = d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
          const minutesOfDay = hour * 60 + minute;
          if (weekday && minute % 15 === 0 && minutesOfDay >= 3 * 60 + 45 && minutesOfDay <= 10 * 60) await runWatchCheck(env, now, 'stock');
          if (hour === 16 && minute === 30) await runWatchCheck(env, now, 'mf'); // 22:00 IST, after NAVs are published
          if (hour === 21 && minute === 5) await cleanup(env, now); // 02:35 IST
          // Meal prompts (12:00, 14:00, 16:40, 21:30 IST) and the Sunday calorie summary. Its own try so a failure never blocks other jobs.
          try {
            await runCalorieSchedule(env, now);
          } catch (error) {
            console.error('Calorie schedule failed:', error.message);
          }
        } catch (error) {
          console.error('Cron failed:', error.message);
        }
      })(),
    );
  },
};
