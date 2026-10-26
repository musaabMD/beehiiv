# Deploying OpenHive

OpenHive is a single Cloudflare Worker with a D1 database, an R2 bucket, two Durable Objects, the Email Sending binding and a minute cron. This guide takes you from zero to a live instance.

## 1. Prerequisites

- A Cloudflare account and a domain on Cloudflare DNS (for sending email and hosting the app).
- Node.js 20 or newer.
- The OpenHive source code (`npm install` inside the folder).

## 2. Log in

```bash
npx wrangler login
```

On a server or CI, use an API token instead: create one at *My Profile → API Tokens* with the "Edit Cloudflare Workers" template plus D1 and R2 edit permissions, then `export CLOUDFLARE_API_TOKEN=...` and `export CLOUDFLARE_ACCOUNT_ID=...`.

## 3. Create resources

```bash
npx wrangler d1 create openhive
npx wrangler r2 bucket create openhive-media
```

Copy the printed `database_id` into `wrangler.jsonc` under `d1_databases`.

## 4. Configure

Edit the `vars` block in `wrangler.jsonc`:

| Variable | Meaning |
|---|---|
| `APP_URL` | Public URL of your instance, e.g. `https://news.example.com` (no trailing slash) |
| `MAIL_FROM` | Default sender, e.g. `newsletter@example.com` (domain must be enabled for Email Sending) |
| `APP_NAME` | Shown in transactional emails |
| `PLATFORM_FEE_PERCENT` | Fee you take on sales when hosting other creators (default `0`) |
| `PURCHASE_URL`, `PRICE_LABEL` | Used by the sales landing page at `/` |

## 5. Email sending

```bash
npx wrangler email sending enable example.com
npx wrangler email sending list
```

Cloudflare adds the SPF and DKIM records for you. Add a DMARC record (`_dmarc.example.com TXT "v=DMARC1; p=none; rua=mailto:dmarc@example.com"`) and read [DELIVERABILITY.md](DELIVERABILITY.md) before your first big send.

Each publication can add extra sender addresses (Settings → Email & senders) and its own sending domain (Settings → Domains), which shows the exact DNS records to add and checks them live.

## 6. Database

```bash
npx wrangler d1 migrations apply openhive --remote
```

Run this again after every update.

## 7. Deploy

```bash
npx wrangler deploy
```

Open `APP_URL`, sign up — the first account becomes the owner of its workspace. To mark yourself as the instance operator (ad-network review, platform settings), add your email to the `SUPERADMIN_EMAILS` variable.

## 8. Domains

- **App domain**: Workers → openhive → Settings → Domains & Routes → Add Custom Domain (e.g. `news.example.com`).
- **Publication domains**: in the dashboard, Settings → Domains → add `blog.creator.com`. Then add that hostname as another Custom Domain on the worker (or a route `blog.creator.com/*`). OpenHive serves the right publication based on the hostname.

## 9. Payments (optional)

Without Stripe keys, checkout runs in test mode (a simulated card page) so you can try every flow.

```bash
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

In the Stripe dashboard add a webhook endpoint `https://YOUR_APP/hooks/stripe` for `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed` and `invoice.paid`. Creators connect their own Stripe account under Settings → Payments (Stripe Connect) so payouts go straight to them.

### Hosted service plans (Lnkbase Newsletter)

The same key also bills workspaces for their **platform plan** (Free / Starter / Pro / Scale — Settings → Plan & usage) as Stripe subscriptions on your own account (no Connect). Products and prices are created automatically on the first checkout (or paste existing price ids in Platform admin → Plans). Enable the **customer portal** in Stripe (Settings → Billing → Customer portal) so "Manage billing" works. Without a key, plan upgrades use a simulated checkout.

- Plans and limits: `DEFAULT_PLANS` / `LIMITS` in `src/lib/plans.ts`, seeded into `platform_plans` (migration 0022) and editable in **Platform admin** (`/app/admin`, `SUPERADMIN_EMAILS` only).
- `SHARED_FROM_DOMAIN` (var, e.g. `news.example.com`): publications without a verified domain send from `<slug>@SHARED_FROM_DOMAIN`. Enable it for Email Sending (`npx wrangler email sending enable news.example.com`), add DMARC, and route `*@` replies/bounces as in DELIVERABILITY.md. Defaults to the `MAIL_FROM` domain.
- The pricing page reads the catalog with `listPlans(env)`.

## 10. AI features (optional)

Uncomment in `wrangler.jsonc`:

```jsonc
"ai": { "binding": "AI" },
```

and deploy. This enables the AI writer, AI images, the website builder's AI mode, audio versions of posts and podcast transcripts.

Podcast transcripts are automatic: every uploaded or imported episode is queued for transcription (Whisper `@cf/openai/whisper-large-v3-turbo`) as a background job. Long MP3s are split into ~2 MB frame-aligned byte ranges of the stored file and stitched back together (text + time-shifted WebVTT, published as `podcast:transcript` in the feed). Non-MP3 files over 20 MB are skipped with a note (upload an MP3 or a transcript file). Without the AI binding the job is marked **skipped** with an explanation on the episode page; nothing fails. "Regenerate transcript" on an episode re-runs it.

## 11. Bot protection (optional)

Forms already use honeypots, timing checks, rate limits and email validation. To add Cloudflare Turnstile, create a widget and set `TURNSTILE_SITE_KEY` (var) and `TURNSTILE_SECRET` (secret).

## 11b. Large live events (optional)

Webinars stream peer-to-peer from the host's browser by default, which suits small and medium rooms. For audiences in the thousands, create a Cloudflare Realtime **SFU app** (Cloudflare dashboard → Realtime → SFU) and either:

- per publication: Settings → Integrations → **Cloudflare Realtime**, paste the App ID and App Secret, or
- instance-wide: `npx wrangler secret put REALTIME_APP_ID` and `npx wrangler secret put REALTIME_APP_TOKEN`.

The host then publishes once to Cloudflare's edge and every attendee pulls from the nearest location. The App Secret never reaches browsers — signaling goes through `/live/:eventId/sfu`.

## 11c. Webinar recordings

Webinars record automatically when the host goes live (event setting **Record automatically**, on by default). The studio's browser uploads a chunk every few seconds to R2 (`<pub>/private/recordings/<id>/NNNNNN.part`); when the host ends the event — or 5 minutes after the browser disappears — a background job stitches the chunks into one WebM with an R2 multipart upload and sets it as the replay. Recording runs in the host's browser: Cloudflare Realtime's SFU API has no server-side recording (that exists only in RealtimeKit, which OpenHive doesn't use), so a host who never opens the studio produces no recording.

## 11d. Discord verified linking (optional)

Members link Discord for tier-based roles. With an OAuth2 app configured they click **Connect with Discord** (scope `identify`) and their account is verified; otherwise they type a user ID, which is shown as *unverified*.

1. In the [Discord developer portal](https://discord.com/developers/applications) → your application → OAuth2, add the redirect URL `https://<APP_URL host>/oauth/discord/callback` (one URL for every publication).
2. Either per publication — Community → Settings → Discord → *OAuth2 client ID / secret* — or instance-wide:

```sh
npx wrangler secret put DISCORD_CLIENT_ID
npx wrangler secret put DISCORD_CLIENT_SECRET
```

Role sync itself still needs the bot token and server ID in Community → Settings. `DISCORD_API_BASE` exists only to point the token exchange at a mock server in tests.

## 12. Cron and background work

`triggers.crons` runs every minute: scheduled posts, send batches, automation steps, deferred-mail retries, webhook retries, segment refreshes, warmup and blocklist checks. Nothing else to set up.

## Updating

Replace the source with the new version (keep your `wrangler.jsonc`), then:

```bash
npm install
npx wrangler d1 migrations apply openhive --remote
npx wrangler deploy
```

## Troubleshooting

- **Emails not arriving** — check Settings → Email → Outbox for errors. `E_SENDER_NOT_VERIFIED` means the sender domain isn't enabled for Email Sending.
- **Custom domain shows "Publication not found"** — the hostname must be saved on the publication *and* attached to the worker.
- **Logs** — `npx wrangler tail`, or Workers → openhive → Logs (observability is enabled).

## Instant demo (no Cloudflare login)

`npx wrangler deploy --temporary -c wrangler.demo.jsonc --var EMAIL_MODE:simulate --var APP_URL:<the workers.dev URL it prints>` deploys to a temporary Cloudflare preview account (claim it within 60 minutes from the URL Wrangler prints to keep it). Preview accounts have no R2 and no cron triggers: OpenHive then stores uploads in D1 (`src/lib/mediashim.ts`) and runs background jobs from incoming traffic, at most once a minute.

## Optional extras added in October 2026

- **Image resizing:** the `images` binding in `wrangler.jsonc` (Cloudflare Images) resizes imported and pasted images to 1,600px WebP. Remove the binding to keep originals.
- **Large webinars:** create a Realtime SFU app (Cloudflare dashboard → Realtime, or `POST /accounts/:id/calls/apps`), then `wrangler secret put REALTIME_APP_ID` and `wrangler secret put REALTIME_APP_TOKEN`.
- **"Send me a sample" page (`/try`):** demo only. Set `TRY_IT=1` (the `deploy:demo` script does) to let visitors get one real issue of the publication named by `TRY_PUB_SLUG` (default `demo`). Capped by `TRY_DAILY_CAP` (default 100 a day), one per address a day, three per visitor an hour.
