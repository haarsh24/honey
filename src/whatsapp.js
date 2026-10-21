import { chunkText, sanitizeTemplateParam } from './util.js';

async function callGraph(env, payload) {
  const version = env.GRAPH_VERSION || 'v25.0';
  const url = `https://graph.facebook.com/${version}/${env.PHONE_NUMBER_ID}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const info = data?.error ?? {};
    const error = new Error(`WhatsApp API ${response.status}: ${info.message ?? 'unknown error'}`);
    error.status = response.status;
    error.code = info.code;
    throw error;
  }
  return data;
}

/** Free-form text. Only works inside the 24-hour window after the owner's last message. */
export async function sendText(env, to, body) {
  for (const chunk of chunkText(body)) {
    await callGraph(env, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: chunk || '(empty)', preview_url: false },
    });
  }
}

/** Pre-approved template with one body parameter ({{1}}). Works outside the 24-hour window. */
export async function sendTemplate(env, to, name, language, bodyText) {
  return callGraph(env, {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name,
      language: { code: language },
      components: [
        {
          type: 'body',
          parameters: [{ type: 'text', text: sanitizeTemplateParam(bodyText) }],
        },
      ],
    },
  });
}

/** Uploads audio to WhatsApp and sends it as an audio message (works inside the 24-hour window). */
export async function sendAudio(env, to, bytes, mime = 'audio/mpeg') {
  const version = env.GRAPH_VERSION || 'v25.0';
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([bytes], { type: mime }), 'reply.mp3');
  const upload = await fetch(`https://graph.facebook.com/${version}/${env.PHONE_NUMBER_ID}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` },
    body: form,
  });
  const uploaded = await upload.json().catch(() => ({}));
  if (!upload.ok || !uploaded.id) {
    throw new Error(`WhatsApp media upload ${upload.status}: ${uploaded?.error?.message ?? 'no media id'}`);
  }
  return callGraph(env, { messaging_product: 'whatsapp', to, type: 'audio', audio: { id: uploaded.id } });
}
