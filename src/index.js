import { runBriefing, runJournalPrompt, runWeekly } from './briefing.js';
import { runDrill } from './learning.js';
import { runDigest, runHabitNudge, runWatchCheck } from './jobs.js';
import { handleIncoming } from './handler.js';
import { cleanup, runDueReminders } from './reminders.js';
import { verifySignature } from './util.js';

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
        } catch (error) {
          console.error('Cron failed:', error.message);
        }
      })(),
    );
  },
};
