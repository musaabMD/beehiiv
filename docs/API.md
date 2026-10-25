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
| Automations | list, get (with per-email stats), `POST /automations/{id}/journeys` (enroll by id or email), list journeys |
| Tiers | list, create, update (pause/resume), archive; `GET /premium_subscriptions`; grant/cancel premium on a subscriber |
| Referral program | milestones and totals, leaderboard, per-subscriber referrals |
| Polls & surveys | list, live results/aggregates, individual responses |
| Webhooks | list, create (returns signing secret), delete, delivery log |
| Commerce | orders, products |
| Podcasts | shows, episodes with downloads |
| Stats | summary (with plain-English sentence), growth series, earnings |
| Templates | list, get |

## Segment rules

`{"op":"and","rules":[{"field":"tag","cmp":"has","value":"vip"},{"field":"last_open_at","cmp":"within_days","value":30}]}` — groups can nest. Fields include email, status, tier, source (incl. `magic_link`), utm_*, created_at, engagement, opens/clicks, tag, custom (`{"key","value"}`), opened_post, clicked_url, automation (started/not_started/completed), segment, list, poll, survey, purchased, event_registered, trial, subscription_status and condition_set.

## Webhooks

Configure endpoints in Settings → Webhooks or via the API. Each delivery is a POST with JSON:

```json
{"id":"…","type":"subscription.created","version":"2026-10-01","created":1761300000,"publication_id":"…","data":{…}}
```

Verify the `OpenHive-Signature: t=<unix>,v1=<hex>` header: compute `HMAC_SHA256(secret, "<t>.<raw body>")` and compare to `v1`. Failed deliveries retry with backoff for up to ~2 days; every attempt is logged and can be retried manually.

Events: `subscription.created|confirmed|deleted|upgraded|downgraded|paused|resumed`, `tier.created|deleted|paused|resumed`, `list.subscribed|unsubscribed`, `post.sent|scheduled|updated`, `survey.response_submitted`, `poll.vote`, `podcast.episode.published|updated|archived|deleted`, `podcast.private_feed.accessed`, `order.paid`, `event.registered`, `referral.milestone`, `community.post.created`.
