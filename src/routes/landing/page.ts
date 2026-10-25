// Sales landing page markup (self-contained: inline CSS + tiny inline JS). Used by `/` and to generate landing/index.html.
import { esc } from '../../lib/util';
import { featureCounts } from './features-data';

export interface LandingOpts { purchaseUrl: string; priceLabel: string; loggedIn?: boolean; demo?: boolean; appName?: string; contact?: string; appUrl?: string }

const ICONS: Record<string, string> = {
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m14 6 4 4"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>',
  dollar: '<path d="M12 2v20M17 6.5c-1-1.3-2.8-2-5-2-2.8 0-4.5 1.3-4.5 3.3 0 4.7 9.5 2.3 9.5 7.2 0 2-1.9 3.5-5 3.5-2.4 0-4.2-.8-5.2-2.2"/>',
  shop: '<path d="M4 7h16l-1 13H5z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  chat: '<path d="M4 5h16v11H8l-4 4z"/>',
  trend: '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  code: '<path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 4l-4 16"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.6c1.8.8 3 2.6 3.5 5.4"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
};
export const ic = (n: string, s = 22) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ICONS.check}</svg>`;

const FEATURES: Array<[string, string, string]> = [
  ['pen', 'A real WYSIWYG editor', 'Blocks, slash commands, Markdown shortcuts, live collaboration, comments, templates, AI writer. One draft → web page + Outlook-proof email.'],
  ['shield', 'Deliverability built in', 'Email validation, bot detection, three-layer suppression, bounce classification, one-click unsubscribe, warmup, feedback loops.'],
  ['bolt', 'Visual automations', 'Welcome sequences, delays, branches, A/B splits, webhooks with retries, per-subscriber journeys — edit drafts while live flows run.'],
  ['users', 'Audience & segments', 'Acquisition source on every reader, tags, custom fields, lists, dynamic and static segments, forms, surveys and one-click polls.'],
  ['globe', 'No-code website', 'Theme tokens, page builder, pop-ups, gated posts, redirects, sitemaps, Google News schema, AI crawler controls, custom domains.'],
  ['dollar', 'Paid subscriptions', 'Multiple tiers, monthly/annual, free & paid trials, metered paywall, gifts, group seats, pause/resume. 0% platform fees.'],
  ['shop', 'Digital products', 'Sell files, guides, templates, memberships and 1:1 coaching with variants, discount codes, reviews and instant delivery.'],
  ['calendar', 'Webinars & events', 'Native streaming with chat, tickets in 10 currencies, automatic reminders and calendar invites, recordings and replays.'],
  ['mic', 'Podcast hosting', 'RSS for Apple/Spotify/YouTube, private feeds for paying members, episode pages, transcripts and IAB-style analytics.'],
  ['chat', 'Community', 'Channels (free or paid), threaded comments, DMs, moderation queue, roles, and newsletter posts synced in.'],
  ['trend', 'Growth engine', 'Referral rewards, recommendations network, boosts with fraud detection, magic subscribe links and a link-in-bio page.'],
  ['code', 'API + MCP server', 'REST API with cursor pagination and webhooks, plus an MCP server so Claude & ChatGPT can work inside your newsletter.'],
];

const FEATURE_SLUGS = ["editor", "deliverability", "automations", "segments", "website", "subscriptions", "products", "events", "podcasts", "community", "recommendations", "api"];

const STACK: Array<[string, string, string]> = [
  ['Email sending', 'SendGrid · Amazon SES · Postmark', 'Cloudflare Email Sending'],
  ['Web hosting', 'Vercel · AWS · Render', 'Cloudflare Workers'],
  ['Database + queue', 'Supabase · Neon · RDS', 'D1 + built-in job queue'],
  ['Auth', 'Clerk · Auth0 · Supabase Auth', 'Built in (passwords, magic links)'],
  ['Workflow engine', 'Inngest · Temporal · QStash', 'Built-in automations engine'],
  ['Bot protection', 'Third-party captcha', 'Built-in guard + optional Turnstile'],
  ['Email validation', 'ZeroBounce · Kickbox', 'Built-in syntax, MX, disposable, typo checks'],
  ['Email rendering QA', 'Litmus · Email on Acid', 'Table-based renderer + preview'],
  ['Click verification', 'Paid click-fraud tools', 'Built-in bot-click filter'],
  ['Media storage + CDN', 'S3 · Vercel Blob', 'Cloudflare R2'],
  ['Product analytics', 'PostHog · Mixpanel', 'Built-in analytics'],
  ['Monitoring', 'Sentry · Datadog', 'Workers observability + error log'],
  ['Payments', 'Memberful + Stripe fees', 'Stripe direct, 0% platform fee'],
];

const FAQ: Array<[string, string]> = [
  ['What exactly do I get?', 'The complete source code of OpenHive (TypeScript, Hono, D1), database migrations, docs for deploying to Cloudflare, the REST API and MCP server, and future updates for the version you bought.'],
  ['Is this a subscription?', 'No. You pay once and own your copy. Your only running cost is your Cloudflare bill: sending email needs Workers Paid ($5/month, 3,000 emails included), then $0.35 per 1,000 emails. One weekly issue to 10,000 readers is about $19/month. See the compare page for the math.'],
  ['Do I need to know how to code?', 'You need to be comfortable running a few terminal commands. The deploy guide walks through every step: create the database, enable email sending for your domain, deploy.'],
  ['How does email sending work?', 'OpenHive sends through Cloudflare Email Sending on your own domain. Cloudflare publishes SPF and DKIM for you; the deliverability guide covers DMARC, warmup and feedback loops.'],
  ['Do I need Stripe?', 'Only to take real payments. Without Stripe keys everything runs in test mode so you can try paid tiers, products and tickets end to end. With Stripe Connect, creators get paid directly.'],
  ['Can I run newsletters for clients?', 'Yes. One instance hosts unlimited workspaces and publications, each with its own domain, team and roles. You can even set your own platform fee.'],
  ['Can I move my existing list?', 'Yes — import subscribers from CSV (with custom fields and tags), and podcasts from any RSS feed with episode GUIDs preserved.'],
  ['Is my data mine?', 'Completely. It lives in your Cloudflare account. Export subscribers, segments and posts at any time.'],
];

export function landingHtml(o: LandingOpts): string {
  const buy = esc(o.purchaseUrl);
  const price = esc(o.priceLabel);
  const amount = esc((o.priceLabel.match(/\$\s?\d+/) || ['$30'])[0]);
  const demo = o.demo !== false;
  // The static copy (landing/index.html) is hosted elsewhere, so its links point back at the app.
  const B = demo ? '' : esc((o.appUrl || '').replace(/\/$/, ''));
  const nav = o.loggedIn
    ? `<a class="btn btn-ghost" href="/app">Go to dashboard</a>`
    : demo ? `<a class="btn btn-ghost hide-sm" href="/login">Log in</a>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenHive — the open-source newsletter platform you own</title>
<meta name="description" content="Write, send, grow and monetize your newsletter on your own Cloudflare account. Full source code, ${price}. Editor, automations, website, paid subscriptions, products, webinars, podcasts, community, API + MCP.">
<meta property="og:title" content="OpenHive — the open-source newsletter platform you own">
<meta property="og:description" content="Every feature of a modern newsletter platform. Your code, your Cloudflare account, 0% platform fees. ${price}.">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#111827"/><path d="M32 12l17 10v20L32 52 15 42V22z" fill="#f59e0b"/><path d="M32 22l8.5 5v10L32 42l-8.5-5V27z" fill="#111827"/></svg>')}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Newsreader:opsz,wght@6..72,500;6..72,600&display=swap" rel="stylesheet">
<style>
:root{--bg:#fafaf9;--bg2:#f5f5f4;--card:#ffffff;--line:#e7e5e4;--text:#1c1917;--muted:#57534e;--accent:#d97706;--accent2:#f59e0b;--green:#059669;--radius:16px}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}img{max-width:100%}
.wrap{max-width:1160px;margin:0 auto;padding:0 20px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:46px;padding:0 22px;border-radius:12px;font-weight:700;font-size:15px;border:1px solid transparent;cursor:pointer;transition:transform .12s,background .12s,border-color .12s;white-space:nowrap}
.btn:hover{transform:translateY(-1px)}
.btn-primary{background:#1c1917;color:#fff}.btn-primary:hover{background:#000}
.btn-ghost{border-color:var(--line);color:var(--text);background:#fff}.btn-ghost:hover{border-color:#a8a29e}
.btn-lg{height:54px;padding:0 28px;font-size:16px;border-radius:14px}
header.top{position:sticky;top:0;z-index:10;background:rgba(250,250,249,.86);backdrop-filter:blur(12px);border-bottom:1px solid rgba(0,0,0,.07)}
.top .wrap{display:flex;align-items:center;gap:24px;height:66px}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:18px;letter-spacing:-.01em}
.brand svg{flex:none}
.top nav{display:flex;gap:22px;flex:1;font-size:14.5px;color:var(--muted)}.top nav a:hover{color:var(--text)}
.top .btn:last-child{margin-left:auto}.top nav+.btn,.top nav+a{margin-left:auto}.top .btn{height:38px;padding:0 16px;font-size:14px;border-radius:10px}
.hero{position:relative;padding:84px 0 40px;overflow:hidden}
.hero::before{content:"";position:absolute;inset:-200px -200px auto;height:700px;background:radial-gradient(600px 300px at 50% 20%,rgba(245,158,11,.22),transparent 70%),radial-gradient(500px 260px at 85% 0%,rgba(99,102,241,.16),transparent 70%);pointer-events:none}
.hero .wrap{position:relative;text-align:center}
.pill{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border:1px solid var(--line);border-radius:999px;font-size:13px;color:var(--muted);background:rgba(0,0,0,.02)}
.pill b{color:var(--accent)}
h1{font-family:Newsreader,ui-serif,Georgia,"Times New Roman",serif;font-size:clamp(42px,6.6vw,80px);line-height:1.02;letter-spacing:-.02em;margin:22px auto 18px;max-width:900px;font-weight:600}
h1 em{font-style:normal;background:linear-gradient(90deg,#f59e0b,#d97706 45%,#c2410c);-webkit-background-clip:text;background-clip:text;color:transparent}
.lead{font-size:clamp(17px,2.2vw,21px);color:var(--muted);max-width:720px;margin:0 auto 30px}
.ctas{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.fine{margin-top:16px;font-size:13.5px;color:var(--muted);display:flex;gap:18px;justify-content:center;flex-wrap:wrap}
.fine span{display:inline-flex;align-items:center;gap:6px}.fine svg{color:var(--green)}
.shot{margin:56px auto 0;max-width:1000px;border:1px solid var(--line);border-radius:20px;background:linear-gradient(180deg,#ffffff,#f5f5f4);box-shadow:0 40px 120px rgba(28,25,23,.10),0 0 0 1px rgba(0,0,0,.02) inset;overflow:hidden;text-align:left}
.shot-bar{display:flex;gap:6px;padding:12px 14px;border-bottom:1px solid var(--line)}.shot-bar i{width:11px;height:11px;border-radius:50%;background:#d6d3d1}.shot-bar i:first-child{background:#ef4444aa}.shot-bar i:nth-child(2){background:#f59e0baa}.shot-bar i:nth-child(3){background:#22c55eaa}
.shot-body{display:grid;grid-template-columns:200px 1fr 260px;min-height:360px}
.shot-side{border-right:1px solid var(--line);padding:16px 12px;font-size:13px;color:var(--muted)}
.shot-side div{padding:7px 10px;border-radius:8px;margin-bottom:2px}.shot-side .on{background:rgba(245,158,11,.14);color:#92400e}
.shot-main{padding:26px 30px}
.shot-main .t{font-size:26px;font-weight:800;letter-spacing:-.02em;margin-bottom:6px}
.shot-main .s{color:var(--muted);margin-bottom:18px}
.ln{height:10px;border-radius:6px;background:#e7e5e4;margin:10px 0}.ln.w8{width:80%}.ln.w6{width:60%}.ln.w9{width:92%}
.slash{margin-top:18px;border:1px solid var(--line);border-radius:12px;background:#ffffff;padding:8px;width:260px;font-size:13px}
.slash div{padding:7px 10px;border-radius:8px;color:var(--muted)}.slash .on{background:#f5f5f4;color:var(--text)}
.shot-stats{border-left:1px solid var(--line);padding:20px}
.kpi{border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:10px}
.kpi small{color:var(--muted);font-size:12px}.kpi b{display:block;font-size:22px;letter-spacing:-.02em}.kpi .up{color:var(--green);font-size:12px}
.bars{display:flex;align-items:flex-end;gap:5px;height:60px;margin-top:6px}.bars i{flex:1;background:linear-gradient(180deg,#f59e0b,#b45309);border-radius:3px 3px 0 0;opacity:.85}
section{padding:90px 0}
.eyebrow{color:var(--accent);font-weight:700;font-size:13px;letter-spacing:.12em;text-transform:uppercase}
h2{font-family:Newsreader,ui-serif,Georgia,"Times New Roman",serif;font-size:clamp(32px,4.4vw,52px);line-height:1.08;letter-spacing:-.015em;margin:10px 0 14px;font-weight:600}
.sub{color:var(--muted);font-size:18px;max-width:680px}
.center{text-align:center}.center .sub{margin:0 auto}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:44px}
.card{border:1px solid var(--line);background:var(--card);border-radius:var(--radius);padding:24px}
.card .ic{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:rgba(245,158,11,.12);color:var(--accent);margin-bottom:14px}
.card h3{margin:0 0 6px;font-size:18px;letter-spacing:-.01em}.card p{margin:0;color:var(--muted);font-size:15px}
.split{display:grid;grid-template-columns:1fr 1fr;gap:48px;align-items:center}
.ticks{list-style:none;padding:0;margin:22px 0 0;display:grid;gap:10px}
.ticks li{display:flex;gap:10px;align-items:flex-start;color:#44403c}.ticks svg{flex:none;color:var(--green);margin-top:3px}
.panel{border:1px solid var(--line);border-radius:20px;background:linear-gradient(180deg,#ffffff,#fafaf9);padding:24px}
.mail{background:#fff;color:#111;border-radius:12px;padding:20px 22px;font-size:14px}
.mail h4{margin:0 0 4px;font-size:20px}.mail p{margin:8px 0;color:#374151}.mail .btnm{display:inline-block;background:#111827;color:#fff;padding:9px 16px;border-radius:8px;font-weight:600;margin-top:6px}
.mail .pay{margin-top:14px;border:1px dashed #f59e0b;border-radius:10px;padding:12px;text-align:center;color:#92400e;background:#fffbeb;font-weight:600}
.badges{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}.badges span{font-size:12.5px;border:1px solid var(--line);border-radius:999px;padding:4px 10px;color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:15px}
.tw{overflow-x:auto;border:1px solid var(--line);border-radius:var(--radius);margin-top:40px;background:var(--card)}
th,td{text-align:left;padding:14px 18px;border-bottom:1px solid var(--line)}th{font-size:12.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600;background:#f5f5f4}
tr:last-child td{border-bottom:0}td.no{color:#dc2626}td.yes{color:var(--green);font-weight:600}
.cost{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:40px}
.cost .card{padding:30px}.cost .big{font-size:46px;font-weight:850;letter-spacing:-.03em}.cost .big small{font-size:16px;color:var(--muted);font-weight:500}
.cost .hl{border-color:rgba(245,158,11,.5);box-shadow:0 0 0 1px rgba(245,158,11,.25),0 20px 60px rgba(245,158,11,.08)}
.price{max-width:560px;margin:44px auto 0;border:1px solid rgba(245,158,11,.5);border-radius:24px;padding:36px;background:radial-gradient(400px 200px at 50% 0%,rgba(245,158,11,.14),transparent),var(--card);text-align:center}
.price .amt{font-size:72px;font-weight:880;letter-spacing:-.04em;line-height:1}.price .amt small{font-size:18px;color:var(--muted);font-weight:600;letter-spacing:0}
.price ul{text-align:left;max-width:380px;margin:24px auto}
details{border:1px solid var(--line);border-radius:14px;background:var(--card);padding:18px 22px;margin-bottom:10px}
summary{cursor:pointer;font-weight:650;font-size:17px;list-style:none;display:flex;justify-content:space-between;gap:12px}summary::-webkit-details-marker{display:none}
summary::after{content:"+";color:var(--accent);font-size:22px;line-height:1}details[open] summary::after{content:"–"}
details p{color:var(--muted);margin:10px 0 0}
.final{text-align:center;padding:100px 0;background:radial-gradient(700px 300px at 50% 100%,rgba(245,158,11,.18),transparent 70%)}
footer{border-top:1px solid var(--line);padding:30px 0;color:var(--muted);font-size:14px}
footer .wrap{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
footer nav{display:flex;gap:18px;flex-wrap:wrap}
.sticky-buy{display:none}
@media(max-width:960px){.grid{grid-template-columns:repeat(2,1fr)}.shot-body{grid-template-columns:1fr}.shot-side,.shot-stats{display:none}.split{grid-template-columns:1fr;gap:28px}.top nav{display:none}}
@media(max-width:620px){.grid,.cost{grid-template-columns:1fr}section{padding:64px 0}.hero{padding-top:56px}.hide-sm{display:none}.btn-lg{width:100%}.sticky-buy{display:flex;position:fixed;left:12px;right:12px;bottom:12px;width:auto!important;z-index:20;box-shadow:0 10px 30px rgba(28,25,23,.18)}footer{padding-bottom:90px}th,td{padding:12px}}
</style>
</head>
<body>
<header class="top"><div class="wrap">
  <a class="brand" href="#"><svg width="28" height="28" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1b2130"/><path d="M32 12l17 10v20L32 52 15 42V22z" fill="#f59e0b"/><path d="M32 22l8.5 5v10L32 42l-8.5-5V27z" fill="#1b2130"/></svg>OpenHive</a>
  <nav><a href="${B}/features">Features</a><a href="${B}/compare">Compare</a><a href="${B}/open">Deliverability</a><a href="#pricing">Pricing</a><a href="${B}/changelog">Changelog</a>${demo ? '<a href="/docs">Docs</a>' : ''}</nav>
  ${nav}
  <a class="btn btn-primary" href="${buy}">Buy — ${amount}</a>
</div></header>

<main>
<section class="hero"><div class="wrap">
  <span class="pill"><b>●</b> Open source · Runs on your Cloudflare account</span>
  <h1>The open-source newsletter platform <em>you own</em>.</h1>
  <p class="lead">Everything you need to write, send, grow and monetize a newsletter — editor, automations, website, paid subscriptions, products, webinars, podcasts and community. One codebase. Zero monthly platform bills.</p>
  <div class="ctas">
    <a class="btn btn-primary btn-lg" href="${buy}">Get the full source — ${price}</a>
    ${o.loggedIn ? '<a class="btn btn-ghost btn-lg" href="/app">Go to dashboard →</a>' : demo ? '<a class="btn btn-ghost btn-lg" href="/signup">Try the live demo →</a>' : '<a class="btn btn-ghost btn-lg" href="#features">See every feature →</a>'}
  </div>
  <div class="fine"><span>${ic('check', 16)} One-time payment</span><span>${ic('check', 16)} Unlimited newsletters &amp; subscribers</span><span>${ic('check', 16)} 0% platform fees</span><span>${ic('check', 16)} Deploy in ~15 minutes</span></div>

  <figure class="shot"><img src="${B}/static/shots/home.jpg" alt="The OpenHive dashboard" width="1360" height="850" style="display:block;width:100%;height:auto"><figcaption style="padding:10px 14px;font-size:13px;color:var(--muted);border-top:1px solid var(--line);text-align:left">The real dashboard, from the live demo with sample data.</figcaption></figure>
</div></section>

<section id="features"><div class="wrap center">
  <div class="eyebrow">Everything included</div>
  <h2>A whole newsletter business in one codebase</h2>
  <p class="sub">Not a starter kit. Every feature you'd expect from the big hosted platforms — built, wired together and documented.</p>
  <div class="grid" style="text-align:left">
    ${FEATURES.map(([i, t, d], k) => `<a class="card" href="${B}/features/${FEATURE_SLUGS[k]}"><div class="ic">${ic(i)}</div><h3>${t}</h3><p>${d}</p></a>`).join('')}
    </div><p style="margin-top:24px"><a class="btn btn-ghost" href="${B}/features">See all ${featureCounts().total} features, one by one →</a></p><div>
  </div>
</div></section>

<section style="padding-top:20px"><div class="wrap split">
  <div>
    <div class="eyebrow">Write once, land everywhere</div>
    <h2>What you write is what lands in the inbox</h2>
    <p class="sub">A true WYSIWYG editor that turns your draft into table-based, inline-styled email HTML — and a fast web page from the same draft.</p>
    <ul class="ticks">
      ${['Free and premium versions split by a paywall break', 'Dynamic sections per segment or tier — in a single send', 'Merge tags with a simulated-subscriber preview', 'Subject line A/B tests and random cohort sends', 'Live Gmail-clipping gauge, autosave, version history', 'Video, audio and iframes auto-hidden in email, kept on the web']
        .map((x) => `<li>${ic('check', 18)}<span>${x}</span></li>`).join('')}
    </ul>
  </div>
  <div class="panel"><div class="mail">
    <h4>Hey {{first_name}} 👋</h4>
    <p>This week: the three growth loops that took us from 2k to 48k readers…</p>
    <span class="btnm">Read the playbook</span>
    <div class="pay">🔒 The rest of this issue is for premium subscribers</div>
  </div>
  <div class="badges"><span>Outlook-safe tables</span><span>Polls in the inbox</span><span>Footnotes</span><span>Code blocks</span><span>Embeds</span><span>AI writer ⌘J</span></div></div>
</div></section>

<section><div class="wrap split">
  <div class="panel">
    <table>
      <tr><th>Protection</th><th>Status</th></tr>
      <tr><td>Disposable / typo'd emails blocked</td><td class="yes">On</td></tr>
      <tr><td>Bot signups (honeypot, timing, rate limits)</td><td class="yes">On</td></tr>
      <tr><td>Global · publication · transactional suppression</td><td class="yes">On</td></tr>
      <tr><td>Bounce classification + 26h retries</td><td class="yes">On</td></tr>
      <tr><td>RFC 8058 one-click unsubscribe</td><td class="yes">On</td></tr>
      <tr><td>Bot clicks filtered from reports</td><td class="yes">On</td></tr>
    </table>
  </div>
  <div>
    <div class="eyebrow">Deliverability</div>
    <h2>The boring infrastructure, already done</h2>
    <p class="sub">The pieces that usually take a team: validation, suppression lists, feedback loops, warmup schedules and blocklist monitoring — shipped and documented.</p>
    <ul class="ticks">
      ${['Every email tagged so complaints are matched to the right newsletter', 'Feedback-loop and bounce webhooks feed suppression lists', 'Domain warmup caps and automatic blocklist pause', 'SPF / DKIM / DMARC record generator with live DNS checks']
        .map((x) => `<li>${ic('check', 18)}<span>${x}</span></li>`).join('')}
    </ul>
  </div>
</div></section>

<section id="stack"><div class="wrap center">
  <div class="eyebrow">One platform, one bill</div>
  <h2>Everything runs on Cloudflare</h2>
  <p class="sub">The usual "roll your own" newsletter stack means stitching together a dozen paid services. OpenHive replaces them with built-in code on one Cloudflare account.</p>
  <div class="tw"><table>
    <tr><th>You need</th><th>Usually you'd pay for</th><th>With OpenHive</th></tr>
    ${STACK.map(([a, b, c]) => `<tr><td><b>${a}</b></td><td class="no">${b}</td><td class="yes">${c}</td></tr>`).join('')}
  </table></div>
</div></section>

<section style="padding-top:0"><div class="wrap center">
  <h2>Stop renting your newsletter</h2>
  <p class="sub">Hosted platforms charge more as you grow — and take a cut of what you earn.</p>
  <div class="cost" style="text-align:left">
    <div class="card"><div class="muted" style="color:var(--muted)">Typical hosted platform at 10,000 subscribers</div><div class="big">$100–$200<small>/month</small></div><p>…plus a percentage of paid subscriptions on many plans, plus add-ons for webinars, courses or podcasts. That's $1,200–$2,400+ every year.</p></div>
    <div class="card hl"><div style="color:var(--accent);font-weight:700">OpenHive</div><div class="big">${amount}<small> once</small></div><p>Plus your Cloudflare bill: $5/month for Workers Paid, then $0.35 per 1,000 emails — about $19/month for a weekly issue to 10,000 readers. 0% platform fees on subscriptions, products and tickets.</p></div>
  </div>
</div></section>

<section id="pricing"><div class="wrap center">
  <div class="eyebrow">Pricing</div>
  <h2>One price. The whole thing.</h2>
  <div class="price">
    <div class="amt">${amount}<small> one-time</small></div>
    <p style="color:var(--muted);margin:10px 0 0">${price} · no subscription</p>
    <ul class="ticks">
      ${['Complete TypeScript source code', 'Every feature on this page', 'REST API + MCP server for AI tools', 'Deploy, API, MCP & deliverability guides', 'Unlimited publications, subscribers and team members', 'Updates for your version']
        .map((x) => `<li>${ic('check', 18)}<span>${x}</span></li>`).join('')}
    </ul>
    <a class="btn btn-primary btn-lg" style="width:100%" href="${buy}">Get OpenHive — ${amount}</a>
    <p style="color:var(--muted);font-size:13px;margin:12px 0 0">Instant download after purchase.</p>
  </div>
</div></section>

<section id="faq" style="padding-top:20px"><div class="wrap" style="max-width:820px">
  <div class="center"><div class="eyebrow">FAQ</div><h2>Questions, answered</h2></div>
  <div style="margin-top:32px">
    ${FAQ.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join('')}
  </div>
</div></section>

<section class="final"><div class="wrap">
  <h2>Own your newsletter. For good.</h2>
  <p class="sub" style="margin:0 auto 28px">Your code, your domain, your subscribers, your revenue.</p>
  <div class="ctas"><a class="btn btn-primary btn-lg" href="${buy}">Get the full source — ${price}</a></div>
</div></section>
</main>

<a class="btn btn-primary btn-lg sticky-buy" href="${buy}">Get OpenHive — ${amount} one-time</a>
<footer><div class="wrap">
  <span>© ${new Date().getFullYear()} OpenHive · The open-source newsletter platform</span>
  <nav><a href="${B}/features">Features</a><a href="${B}/compare">Compare</a><a href="${B}/open">Deliverability</a><a href="${B}/changelog">Changelog</a>${demo ? '<a href="/docs">Docs</a><a href="/login">Log in</a>' : ''}${o.contact ? `<a href="mailto:${esc(o.contact)}">${esc(o.contact)}</a>` : ''}<a href="${buy}">Buy</a></nav>
</div></footer>
</body>
</html>`;
}
