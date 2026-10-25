# OpenHive

**The open-source newsletter platform you own.** Write, send, grow and monetize a newsletter — with a website, paid subscriptions, digital products, webinars, podcasts and a community — running entirely on your own Cloudflare account.

No SendGrid, no Vercel, no Supabase, no Clerk, no Inngest, no ZeroBounce, no Litmus, no S3, no PostHog. One Worker, one database, $0 platform fees.

## Features

- **Editor** — true WYSIWYG block editor with slash commands, Markdown shortcuts, real-time collaboration, comment threads, version history, autosave, templates, dynamic content per segment/tier, paywall breaks, polls, embeds (YouTube, X, TikTok, Instagram, Bluesky, Stocktwits, podcasts), footnotes, code blocks, a live Gmail-clipping gauge and an AI writer (⌘J).
- **Email rendering** — one draft becomes a web page *and* a table-based, inline-styled email that holds up in Outlook. Merge tags with a simulated-subscriber preview.
- **Sending** — batched sending, subject line A/B tests, random cohort tests, segment targeting and exclusion, scheduled sends, audio versions.
- **Deliverability stack** — email validation (syntax, MX, disposable, typos), bot detection, honeypots, rate limiting, three-layer suppression (global, publication, transactional) with temporary and permanent entries, bounce classification, 26-hour deferred retries, RFC 8058 one-click unsubscribe, Gmail Feedback-ID tagging, feedback-loop ingestion, domain warmup caps, blocklist monitoring, bot-click filtering.
- **Audience** — subscribers with acquisition source and full engagement history, tags, custom fields, multiple newsletter lists, dynamic/static segments, reusable condition sets, imports/exports, embeddable forms with draft/publish workflow, surveys and one-click polls.
- **Automations** — visual builder with triggers, delays, waits, branches, random splits, webhooks with retries, draft-vs-live editing and per-subscriber journeys.
- **Website** — no-code builder with theme tokens, pages, navigation, pop-ups, gated content, redirects, robots.txt, sitemaps, Google News schema, AI crawler controls, custom domains.
- **Monetize** — multiple paid tiers, monthly/annual, free and paid trials, metered paywalls, gift and group subscriptions, pause/resume, offers and promo codes, digital products (files, links, guides, memberships, coaching), ad network and direct sponsorships, Stripe Connect payouts.
- **Grow** — referral program with milestone rewards, recommendations network, boosts (paid recommendations with fraud detection and clawbacks), magic subscribe links, link-in-bio page.
- **Events, podcasts, community** — webinars with native streaming and chat, tickets, reminders and calendar invites; podcast hosting with private feeds and IAB-style analytics; community channels, DMs and moderation.
- **API & AI** — REST API v2 with cursor pagination and rate limits, webhooks with signing and retries, and an **MCP server** so Claude, ChatGPT and other AI tools can work inside your publication.

## Quick start (local)

Requirements: Node.js 20+.

```bash
npm install
npx wrangler d1 migrations apply openhive --local
npx wrangler dev
```

Open http://localhost:8787, click **Start free**, create an account and a publication. Emails are simulated locally — they're stored in the outbox (Settings → Email → Outbox) instead of being sent.

Optional demo data:

```bash
node scripts/seed.mjs > seed.sql && npx wrangler d1 execute openhive --local --file seed.sql
# log in as demo@openhive.dev / demo12345
```

## Deploy to Cloudflare

You need a Cloudflare account (the free plan works to start; Workers Paid is recommended for higher volume).

1. **Log in**
   ```bash
   npx wrangler login
   ```
2. **Create the database and bucket**
   ```bash
   npx wrangler d1 create openhive        # copy the database_id into wrangler.jsonc
   npx wrangler r2 bucket create openhive-media
   ```
3. **Enable email sending** for the domain you'll send from (it must be on Cloudflare DNS):
   ```bash
   npx wrangler email sending enable yourdomain.com
   ```
   Then set `MAIL_FROM` in `wrangler.jsonc` (for example `newsletter@yourdomain.com`).
4. **Set your app URL** — edit `APP_URL` in `wrangler.jsonc` (for example `https://news.yourdomain.com`).
5. **Apply migrations and deploy**
   ```bash
   npx wrangler d1 migrations apply openhive --remote
   npx wrangler deploy
   ```
6. **Optional secrets**
   ```bash
   npx wrangler secret put STRIPE_SECRET_KEY        # real payments (otherwise test-mode checkout)
   npx wrangler secret put STRIPE_WEBHOOK_SECRET    # webhook endpoint: https://YOUR_APP/hooks/stripe
   npx wrangler secret put TURNSTILE_SECRET         # optional Turnstile bot check on forms
   ```
7. **Optional: AI** — uncomment `"ai": { "binding": "AI" }` in `wrangler.jsonc` and redeploy to enable the AI writer, AI images, audio versions and podcast transcripts.
8. **Custom domains** — add your app domain under *Workers → your worker → Settings → Domains & Routes*. Publications can use their own domains too (Settings → Domains in the dashboard); point the domain at the worker with a Custom Domain or route.

Cron runs every minute automatically (`triggers.crons` in `wrangler.jsonc`) to process sends, automations, retries and scheduled posts.

Full details: [docs/DEPLOY.md](docs/DEPLOY.md). Deliverability setup (SPF, DKIM, DMARC, feedback loops): [docs/DELIVERABILITY.md](docs/DELIVERABILITY.md).

## API and MCP

- REST API: `https://YOUR_APP/api/v2/publication/...` with `Authorization: Bearer <key>` — see [docs/API.md](docs/API.md) and `/docs/api`.
- MCP server: `https://YOUR_APP/mcp` — see [docs/MCP.md](docs/MCP.md) to connect Claude or ChatGPT.

## Project structure

```
src/index.tsx        entry: routing, publication sites, cron
src/lib/             core engines (sending, rendering, segments, automations, payments, auth…)
src/routes/          one module per product area
src/ui/              dashboard + website layouts and components
public/static/       CSS and browser scripts (editor, builder, rule builder…)
migrations/          D1 schema
docs/                architecture, deploy, API, MCP, deliverability, support
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module contract.

## License

You receive the full source code with your purchase. Use it for your own newsletters and your clients' newsletters, modify it freely, and deploy as many instances as you like. Please don't resell the source code itself.
