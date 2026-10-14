import { handleIncoming } from './handler.js';
import { cleanup, runDueReminders } from './reminders.js';
import { verifySignature } from './util.js';

/** Pull plain messages out of Meta's webhook payload. Status updates are ignored. */
export function extractMessages(payload) {
  const messages = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const m of change?.value?.messages ?? []) {
        messages.push({ id: m.id, from: m.from, type: m.type, text: m.text?.body });
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
        if (!valid) return new Response('Invalid signature', { status: 401 });

        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          return new Response('Bad request', { status: 400 });
        }
        // Reply 200 immediately; do the work in the background.
        for (const message of extractMessages(payload)) ctx.waitUntil(processMessage(env, message));
        return new Response('OK', { status: 200 });
      }
      return new Response('Method not allowed', { status: 405 });
    }

    if (url.pathname === '/') return new Response('wa-assistant is running');
    return new Response('Not found', { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    const now = controller.scheduledTime ?? Date.now();
    ctx.waitUntil(
      (async () => {
        try {
          await runDueReminders(env, now);
          const d = new Date(now);
          if (d.getUTCHours() === 21 && d.getUTCMinutes() === 5) await cleanup(env, now); // 02:35 IST
        } catch (error) {
          console.error('Cron failed:', error.message);
        }
      })(),
    );
  },
};
