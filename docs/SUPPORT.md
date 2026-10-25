# Support

OpenHive is self-hosted software: you own your instance, your data and your sending reputation. Support is self-serve first, with help available when you get stuck.

## Search the docs

- On your instance: `/docs` has search across every guide.
- From an AI assistant connected over MCP: ask it to "search the OpenHive docs for …" (the `search_docs` tool).
- In the dashboard: press ⌘J and ask the assistant.

## Diagnose it yourself

| Symptom | Where to look |
|---|---|
| Emails not sending | Settings → Email → Outbox shows every message and its error |
| A send seems stuck | Post → Send report; sends resume automatically after warmup caps or retries |
| Webhook not received | Settings → Webhooks → endpoint → delivery log (retry any attempt manually) |
| Automation didn't fire | Automation → Journeys shows each subscriber's path and step results |
| Something errored | Settings → Audit log, and `npx wrangler tail` for live logs |
| Subscriber can't sign up | Their email may be disposable/invalid or suppressed; check the subscriber page |

## Report an issue

When something looks like a bug, send:

1. What you did, what you expected, what happened.
2. The URL and approximate time.
3. Any error text, plus output from `npx wrangler tail` if you can reproduce it.

Use the contact on the page where you bought OpenHive. Security issues: please report privately and include reproduction steps.

## Updates

New versions are delivered to buyers. Update with `npm install`, `npx wrangler d1 migrations apply openhive --remote`, `npx wrangler deploy`.

## Community

Share templates, automations and tips with other OpenHive operators through the buyer community linked from your purchase page.

## Your responsibilities as operator

- Keep your sending domain authenticated and complaint rates low ([DELIVERABILITY.md](DELIVERABILITY.md)).
- Follow anti-spam laws (CAN-SPAM, GDPR, CASL): only email people who opted in, and keep your postal address in the footer.
- Back up your D1 database (`npx wrangler d1 export openhive --remote --output backup.sql`).
