# Deliverability

OpenHive ships the deliverability machinery that hosted platforms charge for. This page explains what it does and the few things you must set up as the operator.

## Authentication: SPF, DKIM, DMARC

Mailbox providers (Gmail, Yahoo, Microsoft) require bulk senders to authenticate.

1. **SPF and DKIM** — `wrangler email sending enable yourdomain.com` publishes both for Cloudflare Email Sending. For each publication sending domain, Settings → Domains lists the exact records and checks them live.
2. **DMARC** — add a TXT record at `_dmarc.yourdomain.com`:
   `v=DMARC1; p=none; rua=mailto:dmarc-reports@yourdomain.com; adkim=r; aspf=r`
   Start with `p=none`, watch reports for two weeks, then move to `p=quarantine`.
3. **Alignment** — send from an address on the same domain you authenticated (`newsletter@yourdomain.com`), so SPF/DKIM align with the visible From.

## One-click unsubscribe

Every marketing email carries `List-Unsubscribe` (HTTPS + mailto) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), as Gmail and Yahoo require. The POST endpoint `/u/<token>` unsubscribes instantly; the footer link opens a confirmation page with a preference center.

## Complaint tracking per newsletter

Cloudflare Email Sending sets the `Feedback-ID` header itself (Gmail Postmaster Tools reputation feedback) and rejects sends that try to set it. OpenHive tags every message with `X-OpenHive-Feedback-ID: campaign:publication:kind:openhive` and `X-OpenHive-Campaign: <send id>` instead. Bounce and complaint reports quote these headers, which is how a report is traced back to the publication, the campaign and the kind of mail (newsletter or transactional).

## Validation before the list

Every signup — forms, embeds, magic links, imports, API — goes through:

- syntax checks and length limits
- MX lookup over DNS-over-HTTPS (falls back to A records)
- disposable-domain blocking (plus your own blocked domains per publication)
- typo detection (`gmial.com` → suggests `gmail.com`)
- bot scoring: honeypot field, time-to-submit, user agent, optional Turnstile; suspicious magic-link clicks get a confirmation step
- rate limits on every signup and login endpoint

## Suppression model

| Layer | What goes there | Blocks |
|---|---|---|
| Global | hard bounces, policy blocks, complaints that can't be tied to a publication, mailbox-full / DNS / repeated-soft (temporary) | all newsletters from every publication; **transactional mail only for "mailbox does not exist"** (`hard_bounce`), manual and Cloudflare-suppressed entries |
| Publication | unsubscribes, complaints | that publication's newsletters |
| Transactional | bounces and complaints **of transactional mail** (login links, receipts, confirmations), plus manual entries | transactional mail only |

So a reader who marks a newsletter as spam stops getting newsletters but still receives their login link and receipts, while an address whose login link hard-bounced is not mailed again. Entries can be **temporary** (mailbox full: 3 days, DNS failure: 7 days, repeated soft bounces: 14 days) or **permanent**. Expired temporary entries are ignored automatically. Settings → Email shows every layer and lets admins add or lift entries.

## Bounce handling

Errors are classified as hard, soft, mailbox full, DNS failure, policy or complaint (enhanced status codes `5.x.x` are always permanent).

| Bounce of… | Hard | Policy | Complaint | Mailbox full / DNS |
|---|---|---|---|---|
| a newsletter / automation email | global, subscriber → bounced | global (newsletters only) | publication layer, subscriber → complained | global, temporary |
| a transactional email | transactional + global, subscriber → bounced | transactional | transactional | transactional, temporary |

Soft bounces and deferrals are retried with backoff (15 min doubling, max 6 h) for **26 hours** before being recorded as a bounce. Synchronous failures from the send call are recorded immediately; asynchronous bounces and complaints arrive through the channels below. Every report received is listed under Settings → Email → Inbound reports.

## Receiving bounces and complaints

Cloudflare Email Sending owns the envelope sender (`Return-Path` is its bounce processor and can't be changed), so bounce messages don't come back to you by themselves. OpenHive gives you three ways in; all of them feed the same classification and suppression code (`src/lib/inbound.ts`).

### 1. Email Sending events → Queue (recommended for bounces and complaints)

Cloudflare publishes `message.bounced`, `message.complained`, `message.rejected` and `message.deferred` events for every sending domain. The Worker's `queue()` handler consumes them and matches each event to the original message by Message-ID.

```bash
npx wrangler queues create email-events
npx wrangler queues create email-events-dlq
```

Add to `wrangler.jsonc` and deploy:

```jsonc
"queues": {
  "consumers": [{ "queue": "email-events", "max_batch_size": 10, "max_retries": 3, "dead_letter_queue": "email-events-dlq" }]
}
```

Then in the Cloudflare dashboard: **Queues → email-events → Subscriptions → Subscribe to events**, source **Email Sending**, pick your sending domain (repeat per domain) and the events `message.bounced`, `message.complained`, `message.rejected` (optionally `message.deferred` for the log).

### 2. Email Routing → the Worker's `email()` handler (FBL reports, stray bounces, mailto: unsubscribes)

Feedback-loop programs email ARF reports to an address you register, some mail servers send bounces to the From address, and every newsletter's `List-Unsubscribe` header includes `mailto:<sender>?subject=unsubscribe`. Route those addresses to the Worker:

1. Cloudflare dashboard → your sending domain → **Email → Email Routing** → enable it (adds MX + SPF records for receiving).
2. **Routing rules → Create address**: `fbl@yourdomain.com` → action **Send to a Worker** → `openhive`. Do the same for `bounces@yourdomain.com`.
3. Optional but recommended: route your sender address (e.g. `newsletter@yourdomain.com`) to the Worker too, so `mailto:` unsubscribes and bounces sent to the From address are processed. Human replies that reach it are forwarded to `INBOUND_FORWARD_TO` (a verified Email Routing destination, set as a var) or rejected with a polite message when it isn't set. Auto-replies (out-of-office) are dropped. Readers normally reply to the publication's Reply-To address, which is unaffected.

The handler recognizes:

- **DSNs** (`multipart/report; report-type=delivery-status`, RFC 3464) and common non-standard bounce formats → bounces. `Action: delayed` is logged only.
- **ARF reports** (`multipart/report; report-type=feedback-report`, RFC 5965) → complaints. When a provider redacts the recipient, the unsubscribe token in the quoted `List-Unsubscribe` header identifies the subscriber.
- **`unsubscribe`** subject lines sent to a publication's sender address → that publication unsubscribes the sender.

Inbound mail is unauthenticated, so the handler only suppresses addresses this instance actually emailed in the last 45 days; anything else is logged as ignored. The addresses shown in Settings → Email default to `bounces@` and `fbl@` on the `MAIL_FROM` domain; override them with the `BOUNCE_ADDRESS` / `FBL_ADDRESS` vars if you route different ones.

Test locally with `wrangler dev`:

```bash
curl -X POST 'http://localhost:8787/cdn-cgi/local/email?from=MAILER-DAEMON@mx.example.net&to=bounces@yourdomain.com' --data-binary @bounce.eml
```

### 3. HTTP hooks (other sources)

```
POST https://YOUR_APP/hooks/bounce?key=<hooks key>
Content-Type: application/json
{"email": "x@example.com", "type": "bounce", "diagnostic": "550 5.1.1 user unknown", "kind": "marketing"}
```

`type` is `bounce` or `complaint`; `kind` (`marketing` | `transactional`) picks the suppression layer and is inferred from the outbox when omitted. A raw DSN body is accepted too. `POST /hooks/fbl?key=…` takes a raw ARF report. The hooks key is shown in Settings → Email.

## Feedback loops (FBL)

Register your sending domain with each provider's complaint program and use `fbl@yourdomain.com` (routed to the Worker, above) as the report address:

1. **Gmail** — add the domain to [Google Postmaster Tools](https://postmaster.google.com) (verify with a TXT record). Gmail reports complaint *rates* there rather than per-message reports.
2. **Yahoo / AOL** — sign up at the Yahoo Sender Hub Complaint Feedback Loop with your DKIM domain.
3. **Microsoft (Outlook/Hotmail)** — enroll in JMRP and SNDS at sendersupport.olc.protection.outlook.com.
4. Others (Comcast, Fastmail, Zoho…) — most use the Validity Universal FBL.

Complaints Cloudflare receives itself arrive as `message.complained` events (option 1). Every complaint becomes a publication suppression and is linked to the send through the `X-OpenHive-Campaign` header.

## Multi-tenant safety (hosted service)

On a shared sender one bad list can hurt every newsletter, so OpenHive enforces (constants in `src/lib/plans.ts` `LIMITS`):

- **Shared sender** — publications without a verified custom domain send from `<slug>@SHARED_FROM_DOMAIN` with Reply-To set to the publication's reply-to or the owner's email. Verified domains send from their own address.
- **New-account ramp** — a workspace's first 3 days are capped at 200 marketing emails per rolling 24 hours; larger sends trickle out automatically.
- **First large campaign review** — a workspace's first campaign to more than 1,000 recipients waits in Platform admin → Campaign review until a superadmin approves it (owner notified both ways).
- **Campaign auto-pause** — after 200 attempted deliveries, a campaign pauses if hard bounces exceed 2% or complaints exceed 0.08%; owner and operators are emailed, and the post shows why.
- **Account suspension** — over the last 30 days, bounces above 5% or complaints above 0.3% suspend sending pending review (signups and the website keep working).
- **List-quality gate** — imports on Free/new accounts require a consent checkbox, and any import where more than 10% of rows are invalid or disposable is rejected.

## Warmup

New sending domains get a daily cap that doubles each day: 200 → 400 → 800 … and is lifted after day 12. Sends that hit the cap pause and resume automatically the next hour.

- **Custom domains** start warming up when they're verified in Settings → Domains.
- **The default `MAIL_FROM` domain** is warmed up too, without being added as a custom domain. Its clock starts at the first email the instance ever sent from it (taken from the outbox), so upgrading an instance that has been sending for weeks doesn't suddenly cap it. Settings → Email shows today's cap; instance operators (`SUPERADMIN_EMAILS`) can restart the schedule after moving `MAIL_FROM` to a new domain. Set the var `MAIL_FROM_WARMUP=off` to disable it. It is also checked against blocklists, and operators are alerted when it's listed.

Tips: send to your most engaged subscribers first (create a segment "opened in the last 30 days") and keep complaint rates under 0.1%.

## Blocklist monitoring

Sending domains are checked against major DNS blocklists on a schedule. If a domain is listed, sending from it pauses immediately and the owner is alerted; clear the listing, then re-check in Settings → Domains.

## Clean reporting

Opens and clicks from security scanners, link prefetchers and bots are recorded but excluded from reports. Clicks within seconds of delivery or from known scanner user agents are flagged as bot clicks.

## Checklist before a big send

- [ ] SPF, DKIM and DMARC pass (Settings → Domains shows green)
- [ ] Postmaster Tools verified, FBLs registered
- [ ] Email Sending events queue subscribed and `fbl@` / `bounces@` routed to the Worker (Settings → Email → Inbound reports shows them arriving)
- [ ] Domain warmup started at least a week ago for new domains
- [ ] Imported lists were opted in, and cold addresses removed
- [ ] Physical address set in Settings → Publication (CAN-SPAM)
- [ ] Test email checked on desktop and mobile; size gauge under 102 KB
