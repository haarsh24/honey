# 🍯 Honey: a free WhatsApp assistant that actually does things

Honey is a private, funny, always-on assistant that lives in your WhatsApp. It remembers, reminds, tracks, searches, drafts, listens and talks back. It runs on **Cloudflare Workers + D1 + free AI models**, deploys itself from GitHub, and costs **₹0** to run.

It only ever answers **your** number.

```
You (WhatsApp) ──► Meta Cloud API ──► Cloudflare Worker ──► AI: Workers AI → Groq → Gemini
                                            │                   (voice, photos, PDFs, web: Gemini)
                                            ├──► D1 database (everything you save)
                                            └──► cron, every minute (reminders, briefings, alerts)
```

---

## ✨ What Honey can do

### 🗒️ Everyday essentials
| Feature | Try saying |
|---|---|
| **Notes** | `save: book idea - Atomic Habits` · `what did I save about books?` |
| **Reminders** (one-time or repeating) | `remind me to pay rent on the 1st at 9am` · `remind me every Monday 8am to plan the week` |
| **Snooze** | `snooze 10` right after a reminder rings |
| **Expenses** | `spent 450 on lunch` · `how much did I spend this week?` |
| **Tasks** | `add task: renew insurance` · `my tasks` · `done 3` |
| **Undo** | `undo` removes the last note, reminder, expense, task or habit entry |
| **Instant lists** | `tasks` · `reminders` · `notes` · `habits` (answered in a blink, no AI wait) |

### 🧠 Smart memory
| Feature | Try saying |
|---|---|
| **Ask by meaning** | `what was that book Rahul recommended?` (finds "Atomic Habits - from Rahul") |
| **People memory** | `Rahul's wife is Neha, loves cricket` · later: `what do I know about Rahul?` |
| **Journal** | `journal: great day today` · `what happened last Tuesday?` |
| **Meeting notes** | Send a long voice note or type `meeting notes: ...`. You get a summary, and action items become tasks. |

Notes, journal entries, ideas and contact facts are all searchable **by meaning** (multilingual embeddings, including Hinglish), not just exact words.

### 🎙️ Voice, photos and documents
| Feature | What happens |
|---|---|
| **Voice notes** | Talk in English, Hindi or Hinglish. Honey understands the task and does it. |
| **Voice replies** | Send a voice note and Honey answers with text **and** an audio message (English). `/voicereply off` to disable. |
| **Receipt photos** | Snap a bill and the expense is logged (rupee receipts). Other photos are described and summarised. |
| **PDFs** | Bills and documents are summarised, and due dates become reminders automatically. |

### 🌐 The outside world
| Feature | Try saying |
|---|---|
| **Web search** | `search latest petrol price in Ranchi` |
| **Read a link** | Paste a URL and ask `summarise this` |
| **News digest** | `news on AI, markets and Ranchi every morning` · `news` · `stop news` |
| **Stock prices** | `price of Reliance` · `Nifty` · `Sensex` |
| **Mutual fund NAV** | `NAV of Parag Parikh Flexi Cap` |
| **Price alerts** | `tell me when TCS goes below 3000` (checked every 15 minutes in market hours; each alert fires once) |
| **Weather** | `weather` · `will it rain in Ranchi?` |
| **Quick answers** | Date maths (`what day is 15 Aug 2027?`), calculator, currency conversion, countdowns (`days till Goa trip`), translate or rewrite any message |

### 💪 Habits and growth
| Feature | Try saying |
|---|---|
| **Habit tracker** | `did gym today` · `how are my habits?` · streaks, best streaks, and an evening nudge if one is about to slip |
| **Learning quiz** | `quiz me on SQL joins` · a daily question at 1 PM, graded by Honey. `/quiz` for one right now. |
| **Nightly journal prompt** | 9:30 PM check-in; reply by text or voice |

### 💼 Work helpers
| Feature | Try saying |
|---|---|
| **LinkedIn post factory** | `idea: why my WhatsApp bot costs ₹0`, then `turn my saved ideas into this week's posts`. Honey drafts up to 5 posts in **your** style, schedules each (9:00 AM IST on Tue/Wed/Thu by default), and pings you with the full text, ready to copy. |
| **Post management** | `edit post 3: ...` · `show post 3` · `posted 3` · `cancel post 3` · `my scheduled posts` |
| **Teach your style** | Send a post of yours with `this is my style`. The last 5 samples are kept. |
| **Standup** | `write my standup` (finished and open tasks plus your standup notes → Yesterday / Today / Blockers) |
| **Drafting** | `draft an email asking my manager for leave on Friday` |

### ⏰ Things Honey does on its own
| When (IST) | What |
|---|---|
| **8:00 AM** | Morning briefing: joke of the day, weather, today's reminders, open tasks, yesterday's spend, live habit streaks, countdowns |
| **8:30 AM** | News digest (if you set topics) |
| **1:00 PM** | Daily quiz question (if you started a topic) |
| **Market hours, every 15 min** | Stock price alerts |
| **8:30 PM** | Habit nudge (only habits you did recently but not yet today) |
| **9:30 PM** | Journal prompt |
| **10:00 PM** | Mutual fund alerts |
| **Sunday 8:00 PM** | Weekly review: spending, finished tasks, journal count, quiz score, one suggestion |

Proactive messages go out for free only inside WhatsApp's 24-hour reply window (see [Reminder template](#-reminder-template-only-needed-after-24-hours-of-silence)).

### 😎 Personality
Honey is the funny friend who happens to be great at admin: dry wit, light roasting ("your gym membership card is basically a bookmark"), Indian everyday humour, Hinglish in → Hinglish out. It switches the jokes off when you mention stress, health, money trouble or bad news, and keeps drafts for other people professional.

### ⚡ Built to be fast
- Typing indicator while it thinks
- Prompts trimmed to the topic of your message
- Instant database answers for plain list requests
- AI fallbacks: Workers AI → Groq → Gemini (with a lighter Gemini model as backup), so one slow or busy provider never blocks you

### 🍽️ Calorie tracker
- `/calorie 2 parathas and chai`, or send a food photo (caption `/calorie`, optional text). AI estimates calories and macros.
- Meal prompts at 12:00, 14:00, 16:40 and 21:30 IST. Reply with a photo and/or text and it is logged to that meal.
- Sunday 20:45 IST weekly summary: daily bars, average, goal comparison, macros, one suggestion.
- `/calorie today` · `week` · `goal 1800` · `fix 450` · `undo` · `on|off`. Times are set in `wrangler.toml` (`CAL_*_TIME_UTC`).
- Estimates are rough. Prompts only send while the 24h WhatsApp window is open, so message Honey once a day.

---

## 🕹️ Commands

`/help` · `/reset` (forget this chat's context; saved data stays) · `/quiz` · `/calorie` · `/briefing on|off` · `/journal on|off` · `/voicereply on|off`

---

## 🚀 Setup (about 30 minutes, no local tools needed)

Everything is managed from GitHub: push to `main` and the **Deploy to Cloudflare** workflow tests, migrates the database, deploys the Worker, pushes secrets and connects the Meta webhook.

### 1. Create the accounts (all free)
- **Meta developer app** with WhatsApp and a test number
- **Cloudflare** account with a D1 database
- Optional AI keys: **Gemini** (aistudio.google.com, powers voice, photos, PDFs, web and news) and **Groq** (console.groq.com, backup chat model)

### 2. GitHub secrets and variables
Settings → Environments → **`APP_SECRET`**. Names must match exactly (each accepts secret or variable where noted).

| Name | Where to find it | Store as |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens (template "Edit Cloudflare Workers" + D1 Edit) | Secret |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare → Workers & Pages | Secret or Variable |
| `D1_DATABASE_ID` | Cloudflare → Storage & Databases → D1 | Secret or Variable |
| `WHATSAPP_TOKEN` | Meta → Business Settings → System users → Generate token (**expiry: Never**, permissions `whatsapp_business_messaging` and `whatsapp_business_management`) | Secret |
| `PHONE_NUMBER_ID` | Meta → WhatsApp → API Setup | Secret or Variable |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Meta → WhatsApp → API Setup | Secret or Variable |
| `WHATSAPP_APP_ID` | Meta → App settings → Basic | Secret or Variable |
| `APP_SECRET` | Meta → App settings → Basic → App secret | Secret |
| `VERIFY_TOKEN` | Any random string you choose | Secret |
| `OWNER_NUMBER` | Your WhatsApp number with country code, e.g. `919876543210` | Secret or Variable |
| `GEMINI_KEY` *(recommended)* | aistudio.google.com → Get API key | Secret |
| `GROQ_KEY` *(optional)* | console.groq.com → API Keys | Secret |

> The temporary token on Meta's API Setup page expires after about 24 hours. Use a **System User token** for a bot that keeps working. The system user needs **Full control** of both your app and your WhatsApp account before the permissions list appears.

### 3. Deploy
Push to `main`, or run **Actions → Deploy to Cloudflare → Run workflow**. The workflow also:
- registers a workers.dev subdomain if you have none,
- subscribes your Meta app to the `messages` field and points it at your Worker,
- prints a health check (token validity, phone number, subscriptions) and a live self-test of the embedding and speech models as run annotations.

### 4. Meta app settings
- Publish the app (switch to **Live**), or production messages will not reach the webhook.
- Webhook callback URL: `https://wa-assistant.<your-subdomain>.workers.dev/webhook`, verify token = your `VERIFY_TOKEN`.
- Send `/help` to the test number from your phone.

### 📨 Reminder template (only needed after 24 hours of silence)
WhatsApp allows free-text replies only within 24 hours of your last message. Beyond that, reminders and briefings need a pre-approved template. In **WhatsApp Manager → Message templates → Create**: category **Utility**, name `reminder`, language English, body `Reminder: {{1}}`.

Without it nothing breaks: missed reminders are delivered the next time you message the bot. Tip: send Honey one message a day and everything stays free.

---

## 💸 What it costs

| Piece | Cost |
|---|---|
| Cloudflare Workers, D1, Workers AI (chat, embeddings, voice) | Free tier |
| WhatsApp Cloud API (replies inside the 24-hour window) | Free |
| Gemini (voice, photos, PDFs, web search, news) | Free tier |
| Groq backup | Free tier |

Everything works at ₹0. A paid Gemini project would unlock Google Search grounding and image generation, but nothing in Honey requires it.

## ⚙️ Settings (`wrangler.toml`)

| Variable | Default | Meaning |
|---|---|---|
| `LLM_PROVIDERS` | `workers-ai,groq,gemini` | Order in which AI providers are tried |
| `GEMINI_MODEL` | `gemini-flash-latest` | Model for voice, photos, PDFs, web, news |
| `BRIEFING_TIME_UTC` | `02:30` | Morning briefing (08:00 IST) |
| `NEWS_TIME_UTC` | `03:00` | News digest (08:30 IST) |
| `QUIZ_TIME_UTC` | `07:30` | Daily quiz (13:00 IST) |
| `HABIT_TIME_UTC` | `15:00` | Habit nudge (20:30 IST) |
| `JOURNAL_TIME_UTC` | `16:00` | Journal prompt (21:30 IST) |
| `WEATHER_CITY` | `Ranchi` (code default) | City for the briefing forecast |
| `TYPING_INDICATOR` | on | Set `"off"` to hide the typing indicator |

## 🧱 How it is built

```
src/
  index.js        webhook, signature check, cron schedule, /selftest probe
  handler.js      owner check, dedupe, commands, fast path, voice replies
  assistant.js    persona, topic-based prompt, JSON tool loop
  tools.js        every tool the assistant can call
  llm.js          provider chain with timeouts and fallbacks
  gemini.js       voice / image / PDF understanding, web page reading
  memory.js       embeddings, semantic search, contacts
  posts.js        LinkedIn post factory
  habits.js · markets.js · digest.js · work.js · extras.js · learning.js
  briefing.js · reminders.js · outbound.js · voice.js · fastpath.js
migrations/       D1 schema (applied automatically on deploy)
tests/            node --test suite (mock D1, mocked network)
.github/workflows/deploy.yml
```

Run the tests locally with `npm install && npm test`.

## 🛠️ Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| **No reply at all** | Open the latest **Deploy to Cloudflare** run → annotations. `token debug` must show `is_valid: true`. An expired token (error 190) means you need a permanent System User token. |
| **Deploy fails with "Missing GitHub secret or variable"** | The log names the missing value. |
| **Meta says webhook verification failed** | `VERIFY_TOKEN` in GitHub must match Meta, and the Worker must be deployed first. |
| **Messages reach Meta but not the Worker** | The app is still in development mode, or the app-level `messages` subscription is missing. Publish the app and re-run the deploy. |
| **Voice notes, photos, PDFs, web or news fail** | Check the `GEMINI_KEY` secret. An error like `403 ... suspended` means that Google project is blocked; create a key in a fresh project. |
| **"Quota exceeded" from Google Search** | Expected on the free tier. Search then runs through a web results page instead. |
| **Prices fail** | Yahoo Finance sometimes blocks server traffic; retry later. |
| **Wrong reminder time** | Honey uses IST. Cron runs in UTC, but everything is converted for you. |

## 🔒 Privacy

- Only `OWNER_NUMBER` is answered; every other number is ignored.
- Webhooks are verified with Meta's `X-Hub-Signature-256` signature.
- Secrets live in GitHub and Cloudflare only, never in the repo.
- Free AI tiers can differ in how they use your data. Google says its Gemini free tier may use inputs to improve its products, so keep sensitive photos and documents out.
- Don't send passwords, card numbers or ID numbers to the bot.
- Prices from Yahoo Finance and mutual fund NAVs are delayed and informational, not financial advice.
- Rotate `WHATSAPP_TOKEN` and `APP_SECRET` in Meta if they ever appear in a commit or screenshot.

---

<sub>Built with Claude, deployed with GitHub Actions, powered by caffeine and questionable optimism ☕</sub>
