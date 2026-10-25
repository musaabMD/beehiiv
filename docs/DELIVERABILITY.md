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

Each message has a `Feedback-ID` header (`campaign:publication:type:openhive`) so Gmail Postmaster Tools reports complaint rates per newsletter and per campaign.

## Validation before the list

Every signup — forms, embeds, magic links, imports, API — goes through:

- syntax checks and length limits
- MX lookup over DNS-over-HTTPS (falls back to A records)
- disposable-domain blocking (plus your own blocked domains per publication)
- typo detection (`gmial.com` → suggests `gmail.com`)
- bot scoring: honeypot field, time-to-submit, user agent, optional Turnstile; suspicious magic-link clicks get a confirmation step
- rate limits on every signup and login endpoint

## Suppression model

| Layer | What goes there | Effect |
|---|---|---|
| Global | hard bounces, policy blocks, spam-trap style failures | never emailed again by any publication |
| Publication | unsubscribes, complaints | that publication stops emailing them |
| Transactional | addresses that asked for no transactional mail | blocks login links/receipts only |

Entries can be **temporary** (mailbox full: 3 days, DNS failure: 7 days, repeated soft bounces: 14 days) or **permanent**. Expired temporary entries are ignored automatically.

## Bounce handling

Errors are classified as hard, soft, mailbox full, DNS failure, policy or complaint.

- Hard and policy bounces → global permanent suppression, subscriber marked bounced.
- Soft bounces and deferrals → retried with backoff (15 min doubling, max 6 h) for **26 hours** before being recorded as a bounce.
- Mailbox full / DNS → temporary suppression.

### Bounce webhook

Point any bounce source at:

```
POST https://YOUR_APP/hooks/bounce?key=<hooks key>
Content-Type: application/json
{"email": "x@example.com", "type": "bounce", "diagnostic": "550 5.1.1 user unknown"}
```

DSN messages (text/plain) are also accepted. The hooks key is shown in Settings → Email.

## Feedback loops (FBL)

Register your sending domain with each provider's complaint program and forward ARF reports to `https://YOUR_APP/hooks/fbl?key=<hooks key>`:

1. **Gmail** — add the domain to [Google Postmaster Tools](https://postmaster.google.com) (verify with a TXT record). Gmail reports complaint *rates* there (via Feedback-ID) rather than per-message reports.
2. **Yahoo / AOL** — sign up at the Yahoo Sender Hub Complaint Feedback Loop with your DKIM domain. Route the report mailbox to the FBL endpoint (Cloudflare Email Routing → Worker, or any forwarder that POSTs the raw message).
3. **Microsoft (Outlook/Hotmail)** — enroll in JMRP and SNDS at sendersupport.olc.protection.outlook.com.
4. Others (Comcast, Fastmail, Zoho…) — most use the Validity Universal FBL.

Every complaint becomes a publication suppression and is linked to the send through the `X-OpenHive-Campaign` header.

## Warmup

New sending domains get a daily cap that doubles each day: 200 → 400 → 800 … and is lifted after day 12. Start warmup in Settings → Domains. Sends that hit the cap pause and resume automatically the next hour.

Tips: send to your most engaged subscribers first (create a segment "opened in the last 30 days") and keep complaint rates under 0.1%.

## Blocklist monitoring

Sending domains are checked against major DNS blocklists on a schedule. If a domain is listed, sending from it pauses immediately and the owner is alerted; clear the listing, then re-check in Settings → Domains.

## Clean reporting

Opens and clicks from security scanners, link prefetchers and bots are recorded but excluded from reports. Clicks within seconds of delivery or from known scanner user agents are flagged as bot clicks.

## Checklist before a big send

- [ ] SPF, DKIM and DMARC pass (Settings → Domains shows green)
- [ ] Postmaster Tools verified, FBLs registered
- [ ] Domain warmup started at least a week ago for new domains
- [ ] Imported lists were opted in, and cold addresses removed
- [ ] Physical address set in Settings → Publication (CAN-SPAM)
- [ ] Test email checked on desktop and mobile; size gauge under 102 KB
