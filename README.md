# WhatsApp personal assistant

A private WhatsApp bot that runs free on Cloudflare Workers. It only answers **your** number.
It can keep notes, set reminders (one-time or repeating), track expenses and tasks, and draft emails or messages.

```
WhatsApp -> Meta Cloud API -> Cloudflare Worker -> AI model (Workers AI, Groq or Gemini)
                                   |-> D1 database (notes, reminders, expenses, tasks)
                       cron every minute -> sends due reminders
```

## 1. GitHub Secrets and Variables

Settings -> Secrets and variables -> Actions. Names must match exactly.

| Name | Where to find it | Store as |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare -> My Profile -> API Tokens (template "Edit Cloudflare Workers" + D1 Edit) | Secret |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare -> Workers & Pages (right side) | Secret or Variable |
| `D1_DATABASE_ID` | Cloudflare -> Storage & Databases -> D1 -> your database | Secret or Variable |
| `WHATSAPP_TOKEN` | Meta -> Business Settings -> System Users -> Generate token (permanent) | Secret |
| `PHONE_NUMBER_ID` | Meta -> WhatsApp -> API Setup | Secret or Variable |
| `APP_SECRET` | Meta -> App settings -> Basic -> App secret | Secret |
| `VERIFY_TOKEN` | Any random string you choose (use it again in step 3) | Secret |
| `OWNER_NUMBER` | Your own WhatsApp number with country code, e.g. `919876543210` | Secret or Variable |
| `GROQ_KEY` (optional) | console.groq.com -> API Keys (free) | Secret |
| `GEMINI_KEY` (optional) | aistudio.google.com -> Get API key | Secret |

## 2. Deploy

Push this project to the `main` branch. The **Deploy to Cloudflare** workflow (Actions tab) will:
run the tests, create the database tables, deploy the Worker and push your secrets into it.
You can also run it by hand: Actions -> Deploy to Cloudflare -> Run workflow.

Your Worker URL appears in Cloudflare -> Workers & Pages -> `wa-assistant`
(it looks like `https://wa-assistant.<your-subdomain>.workers.dev`).
If the first deploy complains about a missing workers.dev subdomain, open Workers & Pages in the Cloudflare dashboard once and register one.

## 3. Connect the webhook in Meta

1. Meta App Dashboard -> your app -> WhatsApp -> **Configuration** (webhooks).
2. Callback URL: `https://<your-worker-url>/webhook`
3. Verify token: the same `VERIFY_TOKEN` string you saved in GitHub.
4. Click **Verify and save**, then subscribe to the **messages** field.
5. Send "hi" or "/help" from your phone to the test number.

## 4. Reminder template (needed only after 24 hours of silence)

WhatsApp lets the bot send free text only within 24 hours of your last message.
After that, reminders need a pre-approved template. In WhatsApp Manager -> Message templates -> Create:

- Category: **Utility**, Name: `reminder`, Language: English
- Body: `Reminder: {{1}}` (add any sample text for {{1}})

If you skip this, nothing breaks: reminders that can't be sent are delivered as text the next time you message the bot.
Tip: send the bot any message once a day and everything stays free.

## 5. Try these

- `remind me to pay rent tomorrow 9am`
- `remind me every Monday 8am to plan the week`
- `spent 450 on lunch` then `how much did I spend this week?`
- `save: book idea - Atomic Habits` then `what books did I save?`
- `add task: renew insurance` then `my tasks`
- `draft an email asking my manager for leave on Friday`

Commands: `/help`, `/reset`.

## Troubleshooting

- **Deploy fails with "Missing GitHub secret or variable"**: the log names the missing one.
- **Meta says verification failed**: `VERIFY_TOKEN` in GitHub must match what you typed in Meta, and the Worker must be deployed first.
- **No reply**: Cloudflare -> Workers & Pages -> wa-assistant -> Logs. Check that `OWNER_NUMBER` includes the country code and that `APP_SECRET` is the app secret (not the access token).
- **Reply says the AI is unreachable**: add `GROQ_KEY` as a backup, or change `LLM_MODEL` in `wrangler.toml` (model names change over time).
- **Wrong reminder time**: the bot uses IST. Cron runs in UTC, but all times are converted for you.

## Privacy notes

- Free AI tiers can differ in how they use your data. Google says its Gemini free tier may use inputs to improve its products; `gemini` is off by default (`LLM_PROVIDERS` in `wrangler.toml`).
- Don't send passwords, card numbers or ID numbers to the bot.
- Rotate `WHATSAPP_TOKEN` and `APP_SECRET` in Meta if they ever appear in a commit or screenshot.

## Local checks

```
npm install
npm test
```
