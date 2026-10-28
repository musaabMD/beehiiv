# REST API v2

Manage subscribers, posts, segments, automations, tiers and more from your own code. The complete, always-current endpoint reference lives at `/docs/api` on your instance, and the machine-readable spec at `/api/v2/openapi.json`.

## Authentication

Create a key in **Settings → API keys & MCP** (admins only). Keys are shown once; revoke them any time.

```bash
curl https://YOUR_APP/api/v2/publication \
  -H "Authorization: Bearer oh_live_XXXXXXXX"
```

Each key belongs to one publication. Use either form of base URL:

- `https://YOUR_APP/api/v2/publication/...` — the key's publication
- `https://YOUR_APP/api/v2/publications/{pubId}/...` — explicit id or slug (must match the key)

## Responses and errors

Success: `{"data": ...}`. Lists add `next_cursor` and `has_more`.

Errors: HTTP status plus

```json
{"error": {"code": "not_found", "message": "Subscriber not found."}}
```

Codes: `bad_request` (400), `unauthorized` (401), `forbidden` (403), `not_found` (404), `conflict`/`already_published`/`not_enrolled` (409), `invalid_email` (422, includes `suggestion` for typos), `rate_limited` (429), `internal_error` (500).

## Pagination

Lists use keyset cursors so they stay fast at millions of rows:

```bash
curl "https://YOUR_APP/api/v2/publication/subscriptions?limit=100"
# → {"data":[...], "next_cursor":"MTcz...", "has_more":true}
curl "https://YOUR_APP/api/v2/publication/subscriptions?limit=100&cursor=MTcz..."
```

`limit` is 1–100 (segment member lists allow up to 500). Never build cursors yourself.

## Rate limits

180 requests per minute per key. Every response includes `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (unix seconds). Over the limit you get `429` with `Retry-After`.

## Subscribers

```bash
# create (validated; double opt-in follows publication settings)
curl -X POST https://YOUR_APP/api/v2/publication/subscriptions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"email":"reader@example.com","name":"Ada","utm_source":"partner","tags":["vip"],"custom_fields":{"plan":"pro"}}'

# get by id or email (includes tags and recent activity)
curl https://YOUR_APP/api/v2/publication/subscriptions/reader@example.com -H "Authorization: Bearer $KEY"

# update
curl -X PATCH .../subscriptions/SUB_ID -d '{"tier":"premium","custom_fields":{"plan":"team"},"add_tags":["customer"]}'

# unsubscribe or delete
curl -X PATCH .../subscriptions/SUB_ID -d '{"status":"unsubscribed"}'
curl -X DELETE .../subscriptions/SUB_ID
```

Options on create: `send_welcome_email` (default true), `reactivate_existing`, `double_opt_override: "off"` (skip confirmation for already-verified emails), `referral_code`, `list_ids`, `tier`.

Custom field values: `GET/PUT /subscriptions/{id}/custom_fields`. Definitions: `GET/POST/PATCH/DELETE /custom_fields`.
Tags: `GET/POST /subscriptions/{id}/tags`, `DELETE /subscriptions/{id}/tags/{tag}`, `GET /tags`.

## Posts and the send API

```bash
# create a draft from Markdown (or "blocks", or "html"), optionally from a template
curl -X POST .../posts -d '{"title":"Weekly #42","markdown":"## Hello\n\nThis week…","template_id":"TPL_ID"}'

# append / prepend content
curl -X POST .../posts/POST_ID/content -d '{"position":"append","markdown":"### P.S.\nSee you next week"}'

# rendered HTML: email vs web, free vs premium
curl ".../posts/POST_ID/html?format=email&audience=free"

# test, then send now or schedule — with targeting and a subject A/B test
curl -X POST .../posts/POST_ID/test -d '{"emails":["me@example.com"]}'
curl -X POST .../posts/POST_ID/send -d '{"segment_ids":["SEG"],"ab_test":{"subjects":["A","B"],"sample_pct":20,"wait_minutes":60}}'
curl -X POST .../posts/POST_ID/send -d '{"scheduled_at":"2026-11-01T14:00:00Z"}'
```

Stats per post (`GET /posts/{id}/stats`): delivered, unique opens and clicks (bot clicks excluded and counted separately), rates, unsubscribes, web views, A/B variants, top links and a mailbox-provider breakdown.

When a post is created from a template, the template's current content is copied in and its style is linked — later template style changes apply to new sends.

## Everything else

| Area | Endpoints |
|---|---|
| Segments | list, create (rules JSON), get, `GET /segments/{id}/subscribers`, recalculate, delete |
| Lists | list, add/remove subscriber |
| Automations | list, get (with per-email stats), create, edit (draft), publish, pause/resume — see below; `POST /automations/{id}/journeys` (enroll by id or email), list journeys |
| Tiers | list, create, update (pause/resume), archive; `GET /premium_subscriptions`; grant/cancel premium on a subscriber |
| Referral program | milestones and totals, leaderboard, per-subscriber referrals |
| Polls & surveys | list, live results/aggregates, individual responses; `POST /polls` (incl. trivia), `PATCH /polls/{id}` (close/reopen), `POST /surveys`, `PATCH /surveys/{id}` |
| Webhooks | list, create (returns signing secret), update/upgrade version (`PATCH`), delete, `GET /webhooks/versions`, delivery log with every attempt (`?expand=attempts`, `GET /webhooks/{id}/deliveries/{did}`) |
| Commerce | orders, products |
| Transactional | `POST /transactional/send`, `POST /transactional/batch` (up to 100), `POST /transactional/messages/{id}/cancel`, message log (`GET /transactional/messages`, `/transactional/messages/{id}`), templates (`GET`/`POST /transactional/templates`) — see below |
| Deliveries | `GET /deliveries/{id}/attempts` — every attempt to hand one email (newsletter/automation delivery or transactional message) to the provider, retries included |
| Podcasts | shows, episodes with downloads |
| Stats | summary (with plain-English sentence), growth series, earnings |
| Templates | list, get |

## Idempotency

`POST /posts/{id}/send` accepts an `Idempotency-Key` header (up to 200 characters). The first response (status and body) is stored for 24 hours; repeating the request with the same key returns it again with `Idempotency-Replayed: true` instead of sending twice. The same key with a different body returns `422 idempotency_key_reused`; a repeat while the first is still running returns `409 idempotency_in_progress`. Server errors (5xx) are not stored, so you can retry them with the same key.

On `POST /transactional/send` the header is the same as the body's `idempotency_key` (a repeat returns the original message with `"duplicate": true`); in a batch, give each message its own `idempotency_key`.

## Custom headers

`POST /posts/{id}/send` (immediate sends) and transactional sends accept `"headers": {"X-Order-Id": "42"}`. Allowed: any `X-*` header (except `X-OpenHive-*`) plus `List-Id`, `References`, `In-Reply-To`, `Thread-Index`, `Thread-Topic`. Platform-controlled headers (`Feedback-ID`, `Return-Path`, `Date`, `Message-ID`, `List-Unsubscribe`, …) and headers that have their own field (`From`, `To`, `Subject`, `Reply-To`) return `400 bad_request`, because Cloudflare Email Sending would reject the whole message. Limits: values up to 2,048 bytes, 16 KB in total, at most 20 non-`X-` headers.

## Sending pipeline

- **Priority queues.** Background jobs run by priority: transactional (scheduled sends and retries) first, then automations, webhooks, other work, newsletter batches, and bulk work (imports). Transactional mail never waits behind a large newsletter.
- **Mailbox provider limits.** Each newsletter batch is split by provider (Gmail 3,000/min, Microsoft 1,200, Yahoo 1,200, Apple 1,000, other 3,000, shared platform-wide); recipients that don't fit this minute go out in the next window.
- **Adaptive pace.** When more than 10% of a batch is deferred or fails temporarily, the send halves its pace and parallelism (down to 10%) and recovers by 10% per clean batch.
- **Throttles.** The deliverability guardian can slow or pause sending globally, per provider or per workspace (`send_throttles`); paused mail waits, it is never dropped.
- **Emergency stop.** The account owner (Settings → `/app/sending`) or the operators can stop all sending for an account, and operators can stop the whole platform. It takes effect within one batch; queued newsletters, automation emails and transactional messages wait and continue on resume. Account emails such as login links are not stopped.
- **Attempt history.** Every attempt is recorded with its result, the provider's response or error, and duration: `GET /deliveries/{id}/attempts`, the post report (Recipients) and the transactional message log.

## Automations

Automations have a live version (what runs) and a draft version (what you edit), exactly like the visual builder. Creating or editing never touches running journeys until you publish.

```bash
API=https://YOUR_APP/api/v2/publication; AUTH="Authorization: Bearer $KEY"

# create (saved as a draft); "activate": true publishes it and turns it on
curl -X POST $API/automations -H "$AUTH" -H 'content-type: application/json' -d '{
  "name": "VIP welcome",
  "trigger": {"type": "tag_added", "config": {"tag": "vip"}},
  "steps": [
    {"type": "send_email", "config": {"subject": "Welcome, VIP", "markdown": "Thanks for **everything**."}},
    {"type": "delay", "config": {"amount": 2, "unit": "days"}},
    {"type": "add_tag", "config": {"tags": ["welcomed"]}}
  ]
}'

# edit — name/description/allow_reentry apply now; trigger/steps go to the draft
curl -X PATCH $API/automations/AUTOMATION_ID -H "$AUTH" -H 'content-type: application/json' -d '{"steps": [...]}'

# publish the draft (journeys in progress continue on the new version, matched by step id);
# {"activate": true} also turns a draft/paused automation on
curl -X POST $API/automations/AUTOMATION_ID/publish -H "$AUTH" -H 'content-type: application/json' -d '{"activate": true}'

curl -X POST $API/automations/AUTOMATION_ID/pause  -H "$AUTH"   # subscribers wait where they are
curl -X POST $API/automations/AUTOMATION_ID/resume -H "$AUTH"
```

`GET /automations/{id}` returns the live `trigger`/`steps`, `has_draft`, and the `draft` version when one exists. Trigger types and step types are listed in the OpenAPI document; unknown types return `400 bad_request`.

## Transactional email

Send receipts, password resets and notifications through the publication's transactional sender (Mailchimp Transactional / Mandrill style). One recipient per call.

```bash
curl -X POST $API/transactional/send -H "$AUTH" -H 'content-type: application/json' -d '{
  "to": "reader@example.com",
  "template_id": "order-receipt",                 # or "subject" + "html" | "markdown" | "text"
  "merge_vars": {"order": {"id": "1001", "total": "$29.00"}},   # {{order.id}} in subject and body
  "reply_to": "support@example.com", "tags": ["receipt"],
  "idempotency_key": "order-1001",                # a repeat returns the original message (200, "duplicate": true)
  "track": true,                                  # open + click tracking (off by default)
  "attachments": [{"filename": "receipt.pdf", "content": "<base64>", "type": "application/pdf"},
                  {"filename": "logo.png", "content": "<base64>", "type": "image/png", "content_id": "logo"}],  # inline: <img src="cid:logo">
  "headers": {"X-Order-Id": "1001"},
  "scheduled_at": "2026-11-01T09:00:00Z",         # optional: send later (≤ 30 days); cancel with POST /transactional/messages/{id}/cancel
  "expires_at": "2026-11-01T10:00:00Z"            # optional: not handed to the provider by then → "expired", never sent
}'
# → 201 {"data": {"id": "tx_…", "status": "sent", "message_id": "…", "attempts": 1, …}}

# up to 100 messages per call; one result per message, same order (200 all accepted, 207 some failed, 400 none)
curl -X POST $API/transactional/batch -H "$AUTH" -H 'content-type: application/json' -d '{
  "messages": [{"to": "a@example.com", "subject": "Hi", "text": "…", "idempotency_key": "m-1"}, {"to": "b@example.com", "template_id": "order-receipt"}]
}'
# → {"data": [{"index": 0, "ok": true, "status": 201, "data": {…}}, {"index": 1, "ok": false, "status": 400, "error": {"code": "invalid_recipient", …}}], "summary": {…}}
```

Statuses: `sent` / `simulated`, `scheduled`, `queued` (sending is stopped; goes out on resume), `deferred` (temporary provider error, retried with backoff up to 5 attempts, never past `expires_at`), `expired`, `cancelled`, `failed`, `suppressed`, `bounced`, `complained`.

Recipients may use internationalized domains (`müller@bücher.de` is stored and sent as `müller@xn--bcher-kva.de`) and UTF-8 local parts; lookalikes of big providers (`gmаil.com` with a Cyrillic "а") are rejected like typos. UTF-8 subjects and sender names are sent as-is.

Errors: `400 invalid_recipient | bad_request`, `404 not_found` (template), `402 suspended`, `429 rate_limited` (60/min per key; batch calls 10/min per key) or `429 daily_cap` (200 per 24 h on Free, 5,000 on paid plans). Transactional mail does not count toward the plan's monthly newsletter emails; newsletter unsubscribes don't block it, transactional bounces/complaints do. Details: [Store sync, transactional email & Inbox](/docs/commerce).

## Segment rules

`{"op":"and","rules":[{"field":"tag","cmp":"has","value":"vip"},{"field":"last_open_at","cmp":"within_days","value":30}]}` — groups can nest. Fields include email, status, tier, source (incl. `magic_link`), utm_*, created_at, engagement, opens/clicks, tag, custom (`{"key","value"}`), opened_post, clicked_url, automation (started/not_started/completed), segment, list, poll, survey, purchased, event_registered, trial, subscription_status and condition_set, plus store purchases from Shopify / WooCommerce / Stripe: `ext_purchased` (product name, SKU or id; contains / not_contains), `ext_platform`, `ext_total_spent`, `ext_orders_count`, `ext_last_order`, `cart_abandoned`.

## Webhooks

Configure endpoints in Settings → Webhooks or via the API. Each delivery is a POST with JSON in the endpoint's **payload version**:

```json
// 2026-11-01 (latest — new endpoints get this)
{"id":"…","object":"event","type":"subscription.created","version":"2026-11-01","created_at":"2026-11-01T12:00:00.000Z","publication_id":"…",
 "data":{"subscriber":{"id":"…","email":"…","custom_fields":{"role":"founder"},"utm":{"source":"x","medium":"social","campaign":null},"created_at":"2026-11-01T12:00:00.000Z"}}}

// 2026-10-01 (original)
{"id":"…","type":"subscription.created","version":"2026-10-01","created":1793534400,"publication_id":"…",
 "data":{"subscriber":{"id":"…","email":"…","custom":{"role":"founder"},"utm_source":"x","utm_medium":"social","utm_campaign":null,"created_at":1793534400000}}}
```

### Payload versions

Every endpoint is pinned to a version, so a receiver built against one shape keeps getting that shape. Events are rendered from the oldest shape through each version's upgrade step up to the endpoint's version. The changelog and a sample payload per version are in Settings → Webhooks and at `GET /webhooks/versions`.

| Version | Changes |
|---|---|
| `2026-11-01` | `created` (Unix seconds) → `created_at` (ISO 8601) plus `object: "event"`; every `*_at` inside `data` is ISO 8601; `data.subscriber` matches the REST subscriber (`custom_fields`, `utm: {source, medium, campaign}`); `order.paid` nests `data.order` with `amount: {value_cents, currency}`; `podcast.episode.*` renames `episode.duration` → `duration_seconds`; `post.sent` renames `recipients` → `recipient_count` |
| `2026-10-01` | Original format |

Upgrade an endpoint from its page in Settings → Webhooks (or `PATCH /webhooks/{id}` with `{"version":"2026-11-01"}`); you can switch back at any time. Each request also carries an `OpenHive-Version` header.

Verify the `OpenHive-Signature: t=<unix>,v1=<hex>` header: compute `HMAC_SHA256(secret, "<t>.<raw body>")` and compare to `v1`. Failed deliveries retry with backoff for up to ~2 days. Every attempt (status code, response body or network error, latency, manual or automatic) is stored and shown in the delivery log; failed deliveries can be retried manually.

Events: `subscription.created|confirmed|deleted|upgraded|downgraded|paused|resumed`, `tier.created|deleted|paused|resumed`, `list.subscribed|unsubscribed`, `post.sent|scheduled|updated`, `survey.response_submitted`, `poll.vote`, `podcast.episode.published|updated|archived|deleted`, `podcast.private_feed.accessed`, `order.paid`, `event.registered`, `referral.milestone`, `community.post.created`.
