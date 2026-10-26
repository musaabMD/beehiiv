# OpenHive architecture

OpenHive is an open-source newsletter platform that runs entirely on Cloudflare:
Workers (Hono + server-rendered JSX), D1 (SQLite), R2 (media), Durable Objects (real-time editing and live events),
Email Sending (the `send_email` binding), Cron Triggers (jobs), and optional Workers AI. Payments use Stripe directly; without a Stripe key a built-in simulated checkout lets every flow run locally.

## Layout

```
src/index.tsx          entry: mounts modules, resolves publication sites, cron, email() (Email Routing) and queue() (Email Sending events)
src/types.ts           Env, Vars, Module contract
src/lib/*              shared core (see below). Do not change signatures; add new files instead.
src/ui/components.tsx  dashboard UI kit (Card, Table, Field, Btn, Modal, charts, flash/back helpers)
src/ui/layout.tsx      DashLayout (sidebar, ⌘K palette, ⌘J AI drawer), PlainLayout, NAV
src/ui/site.tsx        SiteLayout for publication websites (theme tokens, navbar, footer, modals, pop-ups), SubscribeForm
src/routes/<module>.tsx  one file per module (plus optional src/routes/<module>/*.tsx helpers)
public/static/*        app.css, app.js (window.OH), rules.js (rule builder), site.css, site.js, editor.js/.css …
migrations/*.sql       D1 schema (0001 = core). Modules add numbered migrations.
```

## Module contract

Each `src/routes/<module>.tsx` default-exports `{ dash?, site?, root? }` (Hono apps typed `Hono<AppEnv>`):

| app  | mounted at | context available |
|------|------------|-------------------|
| dash | `/app/<module>` (dashboard at `/app`, auth at `/app/onboarding`) | `c.get('user')`, `c.get('pub')`, `c.get('role')`, `c.get('pubs')` |
| site | `/s/:slug` and on custom domains | `c.get('pub')`, `c.get('reader')` (`{email, subscriber, premium}` or null) |
| root | `/` | none (public) |

Rules:
- Dashboard pages render with `DashLayout` (`section` = NAV key, `sub` = sub-nav key). Use `requirePerm('admin'|'manage'|'publish'|'draft')` from `lib/auth`.
- Mutations are HTML form POSTs that redirect back with `back(c, url, 'message')` (Post/Redirect/Get). JSON endpoints are fine for editors.
- Every query is scoped by `pub_id = c.get('pub').id` (tenant isolation).
- Site pages render with `SiteLayout` and call `trackView(c, refId)` for analytics.
- Links to a publication site: `siteUrl(env, pub) + '/path'`. App links: `appUrl(env, '/path')`.

### Roles
owner > admin > member > contributor (workspace-level rows have `pub_id = ''`, publication-level rows override).
- admin: billing, exports, integrations, payments, domains, team, API keys, webhooks
- member (`manage`/`publish`): everything else
- contributor (`draft`): draft posts and automations only (cannot send, publish, or activate)

## Route ownership

Public site (`/s/:slug/...`):
- **auth**: `/login` (GET/POST magic link), `/login/:token`, `/logout`
- **audience**: `/subscribe` (GET page, POST), `/confirm/:token`, `/welcome` (post-signup flow), `/poll/:id`, `/poll/:id/vote`, `/survey/:id`
- **monetize**: `/upgrade`, `/upgrade/checkout`, `/gift`, `/gift/:token`, `/group/:token`, `/subscription` (manage/pause/resume/cancel), `/shop`, `/shop/:slug`, `/shop/:slug/*`, `/order/:id`, `/download/:token`, `/sponsor`
- **grow**: `/r/:code` (magic subscribe links), `/bio`, `/recommendations`, `/referrals`
- **podcasts**: `/podcasts`, `/podcasts/:show`, `/podcasts/:show/feed.xml`, `/podcasts/:show/private/:token/feed.xml`, `/podcasts/:show/:episode`
- **events**: `/events`, `/events/:slug`, `/events/:slug/*`
- **community**: `/community`, `/community/*`
- **website** (mounted last): `/`, `/archive`, `/p/:slug` (+ `/p/:slug/comments`, `/p/:slug/react`), `/feed.xml`, `/sitemap.xml`, `/news-sitemap.xml`, `/robots.txt`, `/authors/:id`, `/tag/:slug`, `/search`, `/account`, `/privacy`, `/terms`, `/:page` (custom pages catch-all)

Root:
- **platform** (`routes/platform.tsx`): `/checkout/plan/:id` (simulated plan checkout); dash `/app/admin/*` (superadmin Platform admin)
- **core** (`routes/core.tsx`): `/health`, `/media/*`, `/t/o/:token` (open pixel), `/t/c/:token` (click), `/u/:tok` (unsubscribe incl. RFC 8058 one-click POST), `/pref/:tok`, `/checkout/simulate/:id`, `/hooks/stripe`, `/hooks/bounce`, `/hooks/fbl`
- **landing**: `/` (sales page), `/docs`, `/docs/*`
- **auth**: `/login`, `/signup`, `/logout`, `/forgot`, `/reset/:token`, `/magic/:token`, `/device`, `/device/:code`, `/invite/:token`, `/transfer/:token`, `/verify/:token`
- **api**: `/api/v2/*`, `/mcp`
- **audience**: `/embed/*` (form embeds + attribution script), `/f/:formId` (embedded form submit)
- **posts**: `/collab/:postId` (WebSocket → CollabRoom DO)
- **podcasts**: `/listen/:episodeId.mp3` (tracked downloads)
- **events**: `/live/:eventId` (WebSocket → LiveRoom DO)
- **monetize**: `/t/ad/:opportunityId` (ad click tracking)

Dashboard shared endpoints:
- `POST /app/ai` (dashboard) — `{q, path, context}` → `{text, actions?: [{label, href}], insert?}`
- `POST /app/posts/media/upload` (posts) — multipart `file` → `{id, url, name, mime, size}` (used by every module via `OH.upload`)
- `GET /app/posts/media.json` (posts) — media library listing for pickers

## Core library (src/lib)

| file | purpose |
|------|---------|
| db.ts | `one/all/run/val/insert/update/batch`, cursor helpers |
| util.ts | ids, hashing, `esc`, formatting, CSV, `form(c.req)` body parser |
| auth.ts | passwords, sessions, `requireUser`, `requirePerm`, `can`, reader sessions, single-use tokens (`issueToken/consumeToken`), `audit` |
| guard.ts | email validation (syntax, disposable, typo, MX), `botScore`, `rateLimit`, Turnstile, crawler classification, bot-click filter |
| email.ts | `sendMail` (binding or simulated outbox), suppression (global/pub/transactional, temporary/permanent), bounce classification, X-OpenHive-Feedback-ID, one-click unsubscribe headers, `sendTransactional` |
| inbound.ts | DSN / ARF / mailto-unsubscribe parsing and the shared bounce + complaint application used by the Worker `email()` handler (Email Routing), `queue()` handler (Email Sending events) and `/hooks/bounce`, `/hooks/fbl` |
| render.ts | editor doc → web HTML / table-based email HTML; merge tags; dynamic content; paywall; TOC; footnotes; `emailLayout` |
| sanitize.ts | allowlist sanitizer that balances tags |
| sender.ts | `startSend`, batches, A/B subject tests, cohort tests, warmup caps, deferred retries (26h), `publishPost`, `sendTest`, `buildEmail` |
| subscribers.ts | `subscribe` (validation, double opt-in, referrals, lists, tags), `unsubscribe`, tags, fields, lists, referral rewards, engagement, signed unsubscribe tokens |
| segments.ts | rule engine → SQL (`compile`, `countMatching`, `listMatching`, `subscriberMatches`, `recalcSegment`), `FIELDS` |
| catalog.ts | `ruleCatalog(env, pubId)` for the rule builder |
| automations.ts | engine: triggers, `enroll`, `processRun`, steps, polling triggers, `publishDraft` |
| events.ts | `emit()` bus (activity log + listeners), `WEBHOOK_EVENTS` |
| webhooks.ts | signed webhook delivery with retries; payload versions (`WEBHOOK_VERSIONS`, per-version upgrade transforms, `buildPayload`); every attempt stored in `webhook_delivery_attempts`; `attemptDelivery` for manual retry |
| jobs.ts | `enqueue`, `registerJob`, `registerPeriodic`, `runJobs`, `kick`, `logError` |
| payments.ts | `createCheckout`, `markPaid`, `onOrderPaid(kind, fn)`, `applyOffer`, Stripe helpers |
| media.ts | `storeFile`, `importFromUrl`, `serveObject` (range requests) |
| tracking.ts | `recordOpen`, `recordClick`, `trackView`, `channelOf`, `logBot` |
| ai.ts | Workers AI text / JSON / image / speech / transcription (graceful when not configured) |
| pub.ts | `settings(pub)`, `siteUrl`, `appUrl`, `senderFor` (applies the shared sender) |
| plans.ts | hosted-service plans: `listPlans(env)`, `DEFAULT_PLANS`, `LIMITS`, workspace usage, `planStatus`, `checkSend`/`assertCanSend` (`SendBlockedError`), branding, 80% usage warning |
| platformbilling.ts | platform plan billing: `changePlan` (upgrade now / downgrade at period end), Stripe Checkout subscriptions or simulated checkout, `handlePlatformStripeEvent`, failed-payment grace, lifecycle job |
| safety.ts | multi-tenant sending safety: campaign auto-pause (bounces/complaints), account suspension, first-large-campaign approval, new-account ramp |
| sharedsender.ts | `<slug>@SHARED_FROM_DOMAIN` From address for publications without a verified domain; Reply-To fallback to the owner |

## Editor document

Posts, templates, automation emails and website page sections share one JSON format: `{ "blocks": Block[] }`, `Block = { id, type, data }`.

| type | data |
|------|------|
| paragraph | `{html, align?}` inline HTML (b, i, u, s, a, code, mark, sub, sup, `<span data-footnote="…">`) |
| heading | `{level: 1-4, html, align?}` |
| list | `{ordered, items: html[]}` · checklist `{items: [{html, checked}]}` |
| quote | `{html, cite?, style: {variant: line|box|pull, border_color, border_width, bg, color, italic}}` |
| image | `{src, alt, title, caption(html), width(%), align, link, radius}` · gallery `{images: [{src, alt, caption}], columns, layout: grid|carousel}` |
| button | `{label, url, align, bg, color}` · divider `{style: line|dots|stars|space, color}` · spacer `{height}` |
| code | `{lang, code}` · html `{html}` (sanitized; media allowed on web only) |
| embed | `{url, caption}` — YouTube, X, TikTok, Instagram, Bluesky, Stocktwits, Spotify, Vimeo, Apple Podcasts, Loom |
| video / audio / attachment | `{src, poster?, caption?}` / `{src, title}` / `{url, name, size}` |
| table | `{rows: html[][], header}` |
| columns | `{columns: [{blocks, width?}], valign: top|middle|bottom}` |
| section | `{blocks, style: {bg, bg_image, color, padding, radius, border_width, border_style, border_color, margin}}` |
| dynamic | `{mode: show|hide, rule: {tiers?, segment_ids?, tags?, cohorts?, match: any|all}, blocks}` |
| paywall | `{}` — everything after is premium |
| toc | `{}` · subscribe `{label}` (web only) |
| poll / referral / recommendations / ad / podcast / product / event | `{poll_id}` / `{title}` / `{title, limit}` / `{opportunity_id or campaign_id or headline/body/url/image/cta}` / `{episode_id}` / `{product_id}` / `{event_id}` |

Merge tags: `{{subscriber.first_name|there}}`, `{{subscriber.email}}`, `{{custom.<key>}}`, `{{referral_url}}`, `{{referral_count}}`, `{{publication.name}}`, `{{date}}`.

### Editor client API (public/static/editor.js, owned by posts)

```js
const ed = OHEditor.mount(containerEl, {
  doc,                    // initial {blocks}
  input: hiddenInputEl,   // optional: kept in sync with JSON
  onChange(doc) {},       // optional
  compact: false,         // true = smaller toolbar (automation emails, page sections)
  features: { paywall: true, dynamic: true, polls: true, ai: true, collab: false },
  catalog: {...},         // ruleCatalog for dynamic-content rules (optional)
});
ed.getDoc(); ed.setDoc(doc); ed.plainText(); ed.insertText(str); ed.destroy();
```
Include with `<link rel="stylesheet" href="/static/editor.css">` and `<script src="/static/editor.js" defer>`.

## Events (webhooks + automations)

`emit(env, {pubId, type, subscriberId?, refId?, data?})`. Public webhook events are listed in `WEBHOOK_EVENTS`.
Internal events used by automations: `subscriber.welcome`, `tag.added`, `tag.removed`, `field.updated`, `email.opened`, `email.clicked`, `automation.enrolled`, `post.published`.

## Background work

`enqueue(env, kind, payload, runAt)` + `registerJob(kind, handler)`; periodic tasks via `registerPeriodic(name, everyMs, fn)`.
The minute cron runs periodic tasks then drains jobs. After enqueueing from a request call `kick(c.env, c.executionCtx)`.
Module job handlers must be registered at module import time (top level of the route file or a lib file it imports).

## Local development

```
npm install
npx wrangler d1 migrations apply openhive --local
npx wrangler dev            # http://localhost:8787
```
Emails are simulated locally (stored in the `outbox` table, visible in Settings → Email → Outbox). Cron: `curl "http://localhost:8787/__scheduled"` with `wrangler dev --test-scheduled`.
