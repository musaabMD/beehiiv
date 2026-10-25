// Marketing pages: features, deliverability (/open) and changelog. Compare pages live in compare.ts.
import { esc } from '../../lib/util';
import type { OpenStats, Week } from '../../lib/openstats';
import { MIN_EMAILS } from '../../lib/openstats';
import { FEATURE_AREAS, featureCounts, norm, type FeatureArea } from './features-data';
import { CHANGELOG } from './changelog-data';
import { ic, tick } from './marketing';

export interface PageCtx { purchaseUrl: string; priceLabel: string; contact?: string; loggedIn?: boolean }

const buyCta = (c: PageCtx, title = 'Own your newsletter platform', sub = 'Full source code, every feature, your Cloudflare account.') => {
  const amount = esc((c.priceLabel.match(/\$\s?\d+/) || ['$30'])[0]);
  return `<section class="cta"><div class="wrap"><h2>${title}</h2><p class="muted" style="margin:0 auto 24px;max-width:560px">${sub}</p>
<div class="ctas" style="justify-content:center"><a class="btn btn-primary" href="${esc(c.purchaseUrl)}">Get OpenHive — ${amount} once</a><a class="btn btn-ghost" href="/signup">Try the live demo</a></div></div></section>`;
};

// ── Features ──────────────────────────────────────────────────────────────

const BADGE: Record<string, string> = {
  y: '<span class="st st-y" title="Built">✓</span>',
  p: '<span class="st st-p" title="Partly built">◐</span>',
  n: '<span class="st st-n" title="Not something software can include">–</span>',
};
const FEAT_CSS = `<style>
.st{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:999px;font-size:12px;font-weight:800;flex:none;margin-top:2px}
.st-y{background:#d1fae5;color:#047857}.st-p{background:#fef3c7;color:#b45309}.st-n{background:#f5f5f4;color:#78716c;border:1px solid #e7e5e4}
.items{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:1fr 1fr;gap:2px 28px}
.items li{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)}.items li small{display:block;color:var(--muted);font-size:13.5px;margin-top:2px}
.shot{margin:28px 0 0;border:1px solid var(--line);border-radius:16px;overflow:hidden;background:#fff;box-shadow:0 30px 80px rgba(28,25,23,.10)}
.shot img{display:block;width:100%;height:auto}.shot figcaption{padding:10px 14px;font-size:13px;color:var(--muted);border-top:1px solid var(--line)}
.legend{display:flex;gap:18px;flex-wrap:wrap;font-size:14px;color:var(--muted)}.legend span{display:inline-flex;gap:6px;align-items:center}
.count{font-size:13px;color:var(--muted);margin-top:10px}
@media(max-width:760px){.items{grid-template-columns:1fr}}
</style>`;
const legend = `<div class="legend">${BADGE.y} <span>Built</span> ${BADGE.p} <span>Partly built (it says what's missing)</span> ${BADGE.n} <span>Not something software can include</span></div>`;

const STACK: Array<[string, string, 'y' | 'p' | 'n', string]> = [
  ['Email sending', 'SendGrid, Amazon SES, Postmark', 'p', 'Cloudflare Email Sending (on your Cloudflare bill)'],
  ['Web hosting', 'Vercel, AWS, Render', 'p', 'Cloudflare Workers (on your Cloudflare bill)'],
  ['Database and queue', 'Supabase, Neon, RDS', 'p', 'Cloudflare D1 with a built-in job queue'],
  ['Media storage and CDN', 'S3, R2, Vercel Blob', 'p', 'Cloudflare R2'],
  ['Payments', 'Stripe, Memberful', 'p', 'Your own Stripe account (Stripe fees only, 0% platform fee)'],
  ['Auth', 'Clerk, Auth0, Supabase Auth', 'y', 'Built in: passwords, magic links, device login'],
  ['Monitoring and alerting', 'Sentry, Datadog, PagerDuty', 'y', 'Built in: error log, monitoring page, alert emails'],
  ['Workflow engine', 'Inngest, Temporal, QStash', 'y', 'Built in: automations engine and job queue'],
  ['Bot protection', 'Cloudflare', 'y', 'Built in, with optional Cloudflare Turnstile'],
  ['Email validation', 'ZeroBounce, Kickbox', 'y', 'Built in: syntax, MX, disposable and typo checks'],
  ['Click verification', 'Omnivery', 'y', 'Built in: bot clicks filtered from every report'],
  ['Product analytics', 'PostHog, Mixpanel', 'y', 'Built in'],
  ['Email rendering tests', 'Litmus, Email on Acid', 'n', 'Not replaced: OpenHive renders Outlook-safe HTML and previews it, but doesn\'t test across real email apps'],
];

export function featuresIndex(c: PageCtx) {
  const t = featureCounts();
  return `${FEAT_CSS}<section class="hero"><div class="wrap">
  <div class="eyebrow">Features</div>
  <h1>Everything a newsletter needs, in one codebase you own</h1>
  <p class="lead">${t.total} capabilities across ${FEATURE_AREAS.length} areas. ${t.y} are built and working, ${t.p} are partly built, and ${t.n} aren't things software can include. Each page lists them one by one, with a screenshot of the real app.</p>
  ${legend}
</div></section>
<section style="padding-top:8px"><div class="wrap"><div class="grid">
  ${FEATURE_AREAS.map((f) => { const its = f.items.map(norm); const y = its.filter((x) => x.s === 'y').length; return `<a class="card" href="/features/${f.slug}"><div class="ic">${ic(f.icon)}</div><h3>${esc(f.title)}</h3><p>${esc(f.tagline)}</p><div class="count">${y} of ${its.length} built</div></a>`; }).join('')}
</div></div></section>
<section><div class="wrap"><h2>The software you don't have to stitch together</h2><p class="muted" style="margin-top:0">What a home-made newsletter stack usually pays for, and what OpenHive uses instead.</p>
<div class="tw" style="margin-top:18px"><table><tr><th>You need</th><th>Usually</th><th>With OpenHive</th></tr>
${STACK.map(([a, b, st, d]) => `<tr><td><b>${a}</b></td><td class="muted">${b}</td><td><span style="display:flex;gap:8px">${BADGE[st === 'p' ? 'y' : st]}<span>${esc(d)}</span></span></td></tr>`).join('')}
</table></div><p class="small muted" style="margin-top:10px">Still on your bills: Cloudflare (hosting, database, storage, email) and Stripe's card fees.</p></div></section>${buyCta(c)}`;
}

export function featurePage(c: PageCtx, f: FeatureArea) {
  const i = FEATURE_AREAS.indexOf(f);
  const next = FEATURE_AREAS[(i + 1) % FEATURE_AREAS.length];
  const its = f.items.map(norm);
  const y = its.filter((x) => x.s === 'y').length;
  return `${FEAT_CSS}<section class="hero"><div class="wrap">
  <a class="eyebrow" href="/features">Features</a>
  <h1>${esc(f.title)}</h1>
  <p class="lead" style="font-size:22px;color:var(--text);margin-bottom:10px">${esc(f.tagline)}</p>
  <p class="lead">${esc(f.intro)}</p>
  <div class="ctas"><a class="btn btn-primary" href="/signup">Try it in the demo</a>${f.docs ? `<a class="btn btn-ghost" href="${f.docs.href}">${esc(f.docs.label)}</a>` : ''}</div>
  ${f.shot ? `<figure class="shot"><img src="${f.shot.src}" alt="${esc(f.shot.alt)}" loading="eager" width="1360" height="850"><figcaption>${esc(f.shot.caption)} Live demo with sample data.</figcaption></figure>` : ''}
</div></section>
<section style="padding-top:8px"><div class="wrap">
  <div style="display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap;margin-bottom:12px"><h2 style="margin:0">${y} of ${its.length} built</h2>${legend}</div>
  <ul class="items">${its.map((x) => `<li>${BADGE[x.s]}<span>${esc(x.t)}${x.note ? `<small>${esc(x.note)}</small>` : ''}</span></li>`).join('')}</ul>
  <p style="margin-top:32px"><a class="btn btn-ghost" href="/features/${next.slug}">Next: ${esc(next.title)} →</a></p>
</div></section>${buyCta(c)}`;
}

// ── Deliverability (/open) ────────────────────────────────────────────────

const pct = (x: number | null, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const n = (x: number) => x.toLocaleString('en-US');
const day = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Small server-rendered chart: bars or a line over the weeks, with optional guide lines. */
function chart(weeks: Week[], value: (w: Week) => number | null, o: { kind: 'bar' | 'line'; max?: number; min?: number; guides?: Array<[number, string]>; fmt: (v: number) => string }) {
  const W = 560, H = 150, P = 34;
  const vals = weeks.map(value);
  const real = vals.filter((v): v is number => v != null);
  const max = o.max ?? Math.max(1, ...real) * 1.15;
  const min = o.min ?? 0;
  const y = (v: number) => H - 18 - ((Math.min(Math.max(v, min), max) - min) / (max - min || 1)) * (H - 30);
  const step = (W - P) / weeks.length;
  const x = (i: number) => P + i * step + step / 2;
  const guides = (o.guides || []).map(([v, label]) => `<line x1="${P}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="#dc2626" stroke-dasharray="4 4" opacity=".7"/><text x="${W - 4}" y="${y(v) - 4}" text-anchor="end" fill="#dc2626" font-size="11">${esc(label)}</text>`).join('');
  const axis = [min, (min + max) / 2, max].map((v) => `<text x="${P - 6}" y="${y(v) + 4}" text-anchor="end" fill="#78716c" font-size="10.5">${esc(o.fmt(v))}</text><line x1="${P}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="#e7e5e4"/>`).join('');
  const labels = weeks.map((w, i) => (i % 3 === 2 ? `<text x="${x(i)}" y="${H - 2}" text-anchor="middle" fill="#78716c" font-size="10.5">${day(w.start)}</text>` : '')).join('');
  let marks = '';
  if (o.kind === 'bar') marks = vals.map((v, i) => (v ? `<rect x="${x(i) - step * 0.32}" y="${y(v)}" width="${step * 0.64}" height="${Math.max(0, H - 18 - y(v))}" rx="3" fill="#f59e0b"><title>${day(weeks[i].start)}: ${esc(o.fmt(v))}</title></rect>` : '')).join('');
  else {
    const pts = vals.map((v, i) => (v == null ? null : [x(i), y(v), v] as const)).filter(Boolean) as Array<readonly [number, number, number]>;
    marks = pts.length ? `<polyline points="${pts.map((p) => `${p[0]},${p[1]}`).join(' ')}" fill="none" stroke="#f59e0b" stroke-width="2.2"/>${pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="3.2" fill="#f59e0b"><title>${esc(o.fmt(p[2]))}</title></circle>`).join('')}` : '';
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Weekly chart">${axis}${guides}${marks}${labels}</svg>`;
}

export function openPage(c: PageCtx, s: OpenStats) {
  const rate = (a: number, b: number) => (b ? a / b : null);
  const until = new Date(s.to).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const stat = (label: string, value: string, hint: string) => `<div class="card"><div class="muted small">${label}</div><div style="font-size:44px;font-weight:850;letter-spacing:-.03em;line-height:1.1;margin:6px 0">${value}</div><div class="muted small">${hint}</div></div>`;
  const panel = (title: string, hint: string, big: string, svg: string) => `<div class="card"><div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline;flex-wrap:wrap"><h3 style="margin:0">${title}</h3><span style="font-size:22px;font-weight:800">${big}</span></div><p class="small" style="margin:4px 0 10px">${hint}</p>${svg}</div>`;
  const rej = s.rejections;
  const rejTotal = Object.values(rej).reduce((a, b) => a + b, 0);

  const banner = s.simulated
    ? `<div class="note" style="margin-bottom:24px"><b>This is the demo.</b> Its newsletter sends are simulated, so they're left out. The numbers below count only real emails${s.tryIt ? `, like the samples visitors ask for. <a href="/try" style="text-decoration:underline">Get one in your inbox</a> and it's counted here.` : '.'}</div>` : '';
  const notEnough = !s.enough
    ? `<div class="note" style="margin-bottom:24px"><b>Not enough email yet.</b> Numbers show once ${n(MIN_EMAILS)} emails have gone out in the last 30 days (${n(s.sent)} so far).</div>` : '';
  const show = s.enough;

  return `<section class="hero"><div class="wrap">
  <div class="eyebrow">Deliverability</div>
  <h1>Built to land in the inbox. Here are the numbers.</h1>
  <p class="lead">Live delivery, bounce, spam and open rates for the email this OpenHive install sends, from its own records. Every OpenHive install has this page with its own numbers.</p>
  ${banner}${notEnough}
  <div class="grid">
    ${stat('Delivery rate', show ? pct(s.deliveryRate) : '—', 'Delivered, out of delivered and hard bounced')}
    ${stat('Emails delivered', show ? n(s.delivered) : '—', 'Accepted by readers\' mailbox providers')}
    ${stat('Spam complaint rate', show ? pct(s.complaintRate, 3) : '—', 'Marked as spam, out of emails sent')}
  </div>
  <p class="muted small" style="margin-top:12px">The last 30 days, to ${until}. <a href="#how-we-count" style="text-decoration:underline">How we count</a></p>
</div></section>

${show ? `<section style="padding-top:8px"><div class="wrap">
  <h2>Track record</h2><p class="muted" style="margin-top:0">The last 12 weeks: how much got delivered, how little bounced or was marked as spam, and how much got opened.</p>
  <div class="grid2" style="margin-top:20px">
    ${panel('Emails delivered', 'Each week\'s emails that mailbox providers accepted.', n(s.delivered), chart(s.weeks, (w) => w.delivered, { kind: 'bar', fmt: (v) => n(Math.round(v)) }))}
    ${panel('Delivery rate', 'Good senders stay above 98%.', pct(s.deliveryRate), chart(s.weeks, (w) => rate(w.delivered, w.delivered + w.hard), { kind: 'line', min: 0.9, max: 1, guides: [[0.98, '98%']], fmt: (v) => pct(v, 0) }))}
    ${panel('Hard bounces', 'Out of emails sent. Addresses that can never receive mail are suppressed for good.', pct(s.hardRate), chart(s.weeks, (w) => rate(w.hard, w.sent), { kind: 'line', min: 0, max: 0.05, guides: [[0.02, '2%']], fmt: (v) => pct(v, 0) }))}
    ${panel('Spam complaints', 'Out of emails sent. Gmail asks senders to stay under 0.1%, and never reach 0.3%.', pct(s.complaintRate, 3), chart(s.weeks, (w) => rate(w.complaints, w.sent), { kind: 'line', min: 0, max: 0.004, guides: [[0.001, '0.1%'], [0.003, '0.3%']], fmt: (v) => pct(v, 1) }))}
  </div>
  <div class="card" style="margin-top:16px"><div style="display:flex;gap:40px;flex-wrap:wrap;align-items:baseline"><div><div class="muted small">Median open rate</div><div style="font-size:34px;font-weight:850">${pct(s.medianOpen)}</div></div><div><div class="muted small">Median click rate</div><div style="font-size:34px;font-weight:850">${pct(s.medianClick)}</div></div><p class="small muted" style="flex:1;min-width:240px;margin:0">The median across ${s.pubsCounted || 'no'} newsletter${s.pubsCounted === 1 ? '' : 's'} with 200 or more emails delivered, so one sender can't move it. Bot opens and clicks are left out, but Apple Mail opens emails for its readers, so read opens as a trend.</p></div>
  ${chart(s.weeks, (w) => rate(w.opened, w.delivered), { kind: 'line', min: 0, max: 1, fmt: (v) => pct(v, 0) })}</div>
</div></section>` : ''}

<section><div class="wrap">
  <h2>How OpenHive keeps email out of spam</h2><p class="muted" style="margin-top:0">On by default, for every newsletter on the install.</p>
  <div class="grid2" style="margin-top:20px">
    <div class="card"><div class="muted small">Bad addresses stopped at signup and import, last 30 days</div><div style="font-size:44px;font-weight:850;letter-spacing:-.03em">${n(rejTotal)}</div>
      <table style="margin-top:8px"><tr><td>Typos (gmial.com)</td><td class="num">${n(rej.typo || 0)}</td></tr><tr><td>Domains that can't receive email</td><td class="num">${n(rej.dead_domain || 0)}</td></tr><tr><td>Throwaway inboxes</td><td class="num">${n(rej.disposable || 0)}</td></tr><tr><td>Invalid addresses</td><td class="num">${n(rej.invalid || 0)}</td></tr><tr><td>Newly suppressed (bounces, complaints, unsubscribes)</td><td class="num">${n(s.suppressed)}</td></tr></table></div>
    <div class="card"><ul class="ticks">
      ${tick('<b>Your emails prove they come from you.</b> The Domains page gives you SPF, DKIM and DMARC records and checks them live.')}
      ${tick('<b>New domains warm up.</b> 200 emails on the first day, doubling each day, with no cap from day 13.')}
      ${tick('<b>Your list stays clean.</b> Typos, throwaway inboxes and domains without a mail server are refused at signup; imports skip them and say why.')}
      ${tick('<b>Bounces are sorted.</b> Hard bounces and complaints suppress the address for good; a full mailbox or DNS failure only for a few days. Deferred mail is retried for 26 hours.')}
      ${tick('<b>Complaints are traced to the newsletter.</b> Every email carries its own tracking ID and one-click unsubscribe, and bounce and complaint reports come straight back into the app.')}
      ${tick('<b>Blocklists are watched.</b> Sending domains are checked every 6 hours; a listed domain pauses sending and alerts admins.')}
    </ul></div>
  </div>
</div></section>

<section id="how-we-count" style="padding-top:8px"><div class="wrap narrow">
  <h2>How we count</h2>
  <p class="muted"><b style="color:var(--text)">Counted:</b> every email this install sent in the last 30 days: newsletter issues, automation emails, welcome and confirmation emails and other account email. <b style="color:var(--text)">Left out:</b> test emails, and emails that were never sent because the address was suppressed.</p>
  <p class="muted">The delivery rate is delivered out of delivered and hard bounced. Bounce and complaint rates are out of emails sent. Complaints come from mailbox providers' feedback loops; Gmail doesn't report complaints one by one, so Gmail complaints only show here when they reach the install through a feedback report. Open and click rates are medians across newsletters with 200 or more emails delivered in the period, with bot opens and clicks left out. Numbers show once ${n(MIN_EMAILS)} emails are behind them. Weeks start on Monday, in UTC.</p>
</div></section>
${buyCta(c, 'Run your own newsletter platform', 'With this page included, showing your own numbers.')}`;
}

// ── Changelog ─────────────────────────────────────────────────────────────

export function changelogPage(c: PageCtx) {
  const fmt = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return `<section class="hero"><div class="wrap narrow">
  <div class="eyebrow">Changelog</div><h1>What's new in OpenHive</h1><p class="lead">Newest first.</p>
</div></section>
<section style="padding-top:0"><div class="wrap narrow"><ol style="list-style:none;padding:0;margin:0">
  ${CHANGELOG.map((e) => `<li id="${e.slug}" style="display:grid;grid-template-columns:120px 1fr;gap:20px;padding:26px 0;border-top:1px solid var(--line)">
    <div class="muted small" style="padding-top:4px">${fmt(e.date)}</div>
    <div><h3 style="font-size:21px"><a href="#${e.slug}">${esc(e.title)}</a></h3>${e.body.map((p) => `<p class="muted" style="margin:8px 0">${esc(p)}</p>`).join('')}
    ${e.links?.length ? `<p style="margin:10px 0 0">${e.links.map(([t, h]) => `<a href="${h}" style="color:var(--accent);margin-right:16px">${esc(t)} →</a>`).join('')}</p>` : ''}</div></li>`).join('')}
</ol></div></section>
<style>@media(max-width:620px){ol li{grid-template-columns:1fr!important;gap:4px!important}}</style>
${buyCta(c)}`;
}
