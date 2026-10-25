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

In the Stripe dashboard add a webhook endpoint `https://YOUR_APP/hooks/stripe` for `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` and `invoice.payment_failed`. Creators connect their own Stripe account under Settings → Payments (Stripe Connect) so payouts go straight to them.

## 10. AI features (optional)

Uncomment in `wrangler.jsonc`:

```jsonc
"ai": { "binding": "AI" },
```

and deploy. This enables the AI writer, AI images, the website builder's AI mode, audio versions of posts and podcast transcripts.

## 11. Bot protection (optional)

Forms already use honeypots, timing checks, rate limits and email validation. To add Cloudflare Turnstile, create a widget and set `TURNSTILE_SITE_KEY` (var) and `TURNSTILE_SECRET` (secret).

## 11b. Large live events (optional)

Webinars stream peer-to-peer from the host's browser by default, which suits small and medium rooms. For audiences in the thousands, create a Cloudflare Realtime **SFU app** (Cloudflare dashboard → Realtime → SFU) and either:

- per publication: Settings → Integrations → **Cloudflare Realtime**, paste the App ID and App Secret, or
- instance-wide: `npx wrangler secret put REALTIME_APP_ID` and `npx wrangler secret put REALTIME_APP_TOKEN`.

The host then publishes once to Cloudflare's edge and every attendee pulls from the nearest location. The App Secret never reaches browsers — signaling goes through `/live/:eventId/sfu`.

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
