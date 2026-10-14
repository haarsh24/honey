import { getState } from './db.js';
import { sendTemplate, sendText } from './whatsapp.js';

const WINDOW_MS = 23.5 * 60 * 60 * 1000;
const REENGAGEMENT_ERROR = 131047;

export async function inReplyWindow(env, nowMs) {
  const lastInbound = Number((await getState(env, 'last_inbound_at')) ?? 0);
  return nowMs - lastInbound < WINDOW_MS;
}

/**
 * Message the owner outside a conversation. Inside the 24-hour window we send normal text;
 * otherwise (or if WhatsApp says the window is closed) we use the approved template with `compact` text.
 */
export async function sendProactive(env, to, text, compact, nowMs) {
  if (await inReplyWindow(env, nowMs)) {
    try {
      await sendText(env, to, text);
      return 'text';
    } catch (error) {
      if (error.code !== REENGAGEMENT_ERROR) throw error;
    }
  }
  await sendTemplate(env, to, env.TEMPLATE_NAME || 'reminder', env.TEMPLATE_LANG || 'en', compact);
  return 'template';
}
