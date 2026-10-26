# Store sync, cart recovery, transactional email and the reply Inbox

Four features that bring Kit / Mailchimp commerce parity. Code: `src/lib/commerce.ts`, `src/lib/commerce-rules.ts`,
`src/lib/transactional.ts`, `src/lib/inbox.ts`, routes in `src/routes/integrations-commerce.tsx`,
`src/routes/settings/transactional.tsx`, `src/routes/audience/inbox.tsx`. Tables: `migrations/0026_commerce_transactional_inbox.sql`.

## 1. Store sync (Shopify, WooCommerce, your own Stripe)

Settings → **Store integrations** (`/app/settings/commerce`, admins). Paste the store's webhook signing secret; the page
then shows a per-publication webhook URL `https://APP/hooks/commerce/<token>` to add in the store.

| Platform | Events to subscribe | Signature checked |
|---|---|---|
| Shopify | `orders/create`, `orders/paid`, `checkouts/create`, `checkouts/update`, `customers/create` | `X-Shopify-Hmac-Sha256` = base64 HMAC-SHA256 of the raw body |
| WooCommerce | `order.created`, `order.updated`, `customer.created` (API v3) | `X-WC-Webhook-Signature`, same scheme (the unsigned `webhook_id=` ping is accepted) |
| Stripe (the creator's own account, separate from paid-subscription checkout) | `checkout.session.completed`, `charge.succeeded`, `customer.created` | `Stripe-Signature` (`t=…,v1=…`, 5-minute tolerance) |

Deliveries are de-duplicated by the platform's delivery id (`X-Shopify-Webhook-Id`, `X-WC-Webhook-Delivery-ID`, Stripe event id).
Every delivery is logged on the page (processed / ignored / duplicate / invalid signature / error).

**Marketing consent.** A buyer becomes a subscriber (status active, source `commerce`, tag `customer-<platform>`) only when the
platform says they accepted marketing:
- Shopify: `customer.email_marketing_consent.state = "subscribed"` (or the legacy `accepts_marketing` / `buyer_accepts_marketing`).
- WooCommerce: core has no consent field, so an opt-in plugin's order/customer meta key containing marketing / newsletter / subscribe / opt-in / consent with a truthy value (`yes`, `1`, `true`, `on`).
- Stripe: Checkout `consent.promotions = "opt_in"` (enable consent collection on the Checkout Session / Payment Link), or metadata `accepts_marketing=true`.

Everyone else is stored as a **store customer** (`commerce_customers`) — orders, totals and segments work, but they are never emailed.
Existing subscribers are linked by email whatever their consent flag (they already subscribed).

**What's stored.** `external_orders` + `external_order_items` (Stripe line items come from metadata `product_id` / `product_name`,
since the webhook has no line items). A `charge.succeeded` for a Checkout payment updates the same order (keyed by payment intent).

**Buyers are tagged** by product (`bought-<product-slug>`, toggle per store) and get a `commerce.order_paid` activity entry.

**Segments** (rule builder, API, MCP): `ext_purchased` (product name / SKU / product id contains), `ext_platform`,
`ext_total_spent` (in currency units), `ext_orders_count`, `ext_last_order` (within days / never), `cart_abandoned`.
Orders match subscribers by email, so purchases made before subscribing count.

**Automations.** New trigger **Buys in your store** (`external_purchase`, config `platform`, `product_contains`, `min_total`).
The existing **Purchases a product** trigger set to "Any product" also fires for store purchases.

**Where it shows.** Subscriber page → Store purchases; Analytics → Revenue → Store revenue; Settings → Store integrations (orders, carts, log).

## 2. Cart abandonment

Shopify checkouts and WooCommerce *pending payment* orders are tracked as carts. A cart that isn't completed within the
store's threshold (default 1 hour) is marked **abandoned** (`cart.abandoned` activity event). Automations with the trigger
**Abandons a cart** (`cart_abandoned`, config `delay_hours` default 1, `min_value` default 0) enroll the subscriber once per cart.
When the order completes (`orders/create|paid` with the checkout token, a completed checkout, or a Woo order moving to
processing/completed) the cart becomes **recovered** and its journeys exit immediately.

Only subscribers receive abandonment emails (consent rule above). Merge tags in automation emails:
`{{cart.items}}` (email-safe table with images, quantities and total), `{{cart.total}}`, `{{cart.item_count}}`,
`{{cart.first_item}}`, `{{cart.platform}}`, `{{cart.recovery_url}}` (Shopify `abandoned_checkout_url`, Woo `payment_url`) —
use it as a button URL. Store integrations → "Create a cart recovery automation" adds a ready-made two-email draft.
Cart tags render in the email body (not the subject line).

## 3. Transactional email API

`POST /api/v2/publication/transactional/send` (Bearer API key) — one recipient per call:

```json
{"to": "reader@example.com", "template_id": "order-receipt", "merge_vars": {"order": {"id": "1001"}},
 "reply_to": "support@example.com", "tags": ["receipt"], "idempotency_key": "order-1001", "track": true,
 "attachments": [{"filename": "receipt.pdf", "content": "<base64>", "type": "application/pdf"}]}
```
or `subject` + `html` / `markdown` / `text` instead of `template_id`. Returns `201 {"data": {"id": "tx_…", "status": "sent", …}}`
(`200` with `"duplicate": true` for a repeated `idempotency_key`). Also: `GET /transactional/messages` (search: `q`, `status`, `tag`),
`GET /transactional/messages/{id}`, `GET|POST /transactional/templates`, and the MCP tool `send_transactional`.

Decisions:
- **Plan usage:** transactional API mail does **not** count toward the plan's monthly newsletter emails (those count deliveries only).
  It has its own limits: 60 sends per minute per API key, and per publication 200 per rolling 24 hours on Free / 5,000 on paid plans
  (`TX_DAILY` in `lib/transactional.ts`). Nothing sends while the workspace's sending is suspended.
- **Suppression:** sent as `kind: transactional`, so the transactional layer applies (transactional hard bounces, complaints about
  transactional mail, manual entries, plus global "mailbox does not exist"). Newsletter unsubscribes and complaints don't block it.
  Asynchronous bounces/complaints update the message status in the log.
- **Tracking** only with `"track": true` (open pixel `/t/x/o/<id>.gif`, click redirects `/t/x/c/<id>/<n>`; clicks within 10 s of sending are treated as scanners).

UI: Settings → **Transactional email** (messages with search and status, templates with a test send, API reference).

## 4. Reply Inbox

Audience → **Inbox**. Off by default. With **Collect replies in Inbox** on, newsletter and automation emails get
`Reply-To: reply+<pub-slug>.<first 12 chars of the delivery id>@<SHARED_FROM_DOMAIN>`. Replies arrive through Email Routing at
the Worker's `email()` handler, which stores them as threads linked to the subscriber, the delivery and the post. Auto-replies are
dropped; replies to unknown addresses are rejected. A reply is marked unverified when the sender isn't the address the email went to.

From a thread you can reply (sent from the publication's newsletter sender with `In-Reply-To` / `References`, and the same
Reply-To so the conversation continues in the Inbox), mark unread, archive, and open the subscriber. Optionally each reply is
emailed to the owner (or another address) as a copy.

### Owner setup (platform operator, once)

Email Routing must deliver `reply+…@SHARED_FROM_DOMAIN` to the Worker (not done automatically):

1. Cloudflare dashboard → the shared sending domain (`news.lnkbase.com`) → **Email → Email Routing** → enable it if needed
   (adds MX + SPF records for receiving).
2. **Routing rules**: either enable the **Catch-all address** → *Send to a Worker* → `openhive`, or (subaddressing must be enabled
   in Email Routing settings) a custom address `reply@news.lnkbase.com` → *Send to a Worker*, which also receives `reply+anything@`.
3. Test: reply to a newsletter from a publication with the Inbox on; the reply appears in Audience → Inbox and in
   Settings → Email → Inbound reports (kind `reply`).

Locally: `curl -X POST 'http://localhost:8787/cdn-cgi/handler/email?from=reader@gmail.com&to=reply%2Bslug.abcdef123456@news.lnkbase.com' --data-binary @reply.eml`.
