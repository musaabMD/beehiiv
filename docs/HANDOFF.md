# Hand-off: finish OpenHive launch (run on the owner's Mac)

State: all features are built and tested (docs/BACKLOG.md fully ticked, `scripts/e2e.mjs` passes 39/39, 400-page crawl clean).
What remains needs the owner's own machine, Cloudflare login and Chrome:

## 1. Deploy to the owner's Cloudflare account
```
npm install
npx wrangler login                       # owner's Cloudflare account
npx wrangler d1 create openhive          # copy database_id into wrangler.jsonc (replace the 0000… placeholder)
npx wrangler r2 bucket create openhive-media
npx wrangler email sending list          # trstbase.com and drnote.co should be listed (already enabled)
npm run db:migrate:remote
npx wrangler deploy
```
Then set `APP_URL` in wrangler.jsonc `vars` to the printed `https://openhive.<subdomain>.workers.dev` (or a custom domain) and deploy again.
Optional: seed the demo publication — `node scripts/seed.mjs > seed.sql` (remove the `sessions` line and set a strong password) then
`npx wrangler d1 execute openhive --remote --file seed.sql`, and `node scripts/demo-data.mjs > demo.sql && npx wrangler d1 execute openhive --remote --file demo.sql`.
Workers Paid ($5/mo) is needed for cron triggers; without it the app runs jobs from traffic (see src/index.tsx fallback scheduler).

## 2. Test the real site in Chrome (Claude in Chrome)
Walk every NAV section and sub page listed in src/ui/layout.tsx plus the public site routes in docs/ARCHITECTURE.md:
signup → onboarding → write a post in the editor (slash menu, image upload, poll, paywall) → send test → publish → open the email in Settings → Email → Outbox (or a real inbox once MAIL_FROM sends) → click a link → check post analytics →
subscribe on /s/<slug>/ → upgrade checkout (test mode) → automations builder → website builder → community chat → events studio.
Fix anything broken, re-run `npm run typecheck` and `BASE=<url> node scripts/e2e.mjs` against a local `wrangler dev`.

## 3. Launch
- Set `PURCHASE_URL` (Gumroad / Lemon Squeezy / Stripe Payment Link) in wrangler.jsonc, redeploy, run `node scripts/build-landing.mjs`.
- Upload `landing/index.html` to Lnkbase.com/beehiiv.
- Optional secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `TURNSTILE_SECRET`, `REALTIME_APP_ID`/`REALTIME_APP_TOKEN`, `GIPHY_API_KEY`; enable `"ai": {"binding": "AI"}` for AI features.

A temporary preview deploy also exists at https://openhive-demo.scythe-alpaca.workers.dev (config: wrangler.demo.jsonc) — it is deleted unless claimed within 60 minutes of creation.
