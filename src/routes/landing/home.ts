// Home (/) and pricing (/pricing) for the hosted service.
import { esc } from '../../lib/util';
import { ic, tick } from './marketing';
import { BRAND, PLANS, planFor, type Plan } from './brand';
import { FEATURE_AREAS, featureCounts } from './features-data';
import { PLATFORMS } from './compare-data';
import type { PageCtx } from './pages';

const money = (n: number) => (n === 0 ? '$0' : `$${n.toLocaleString('en-US')}`);
const num = (n: number) => n.toLocaleString('en-US');

const HOME_CSS = `<style>
.hero-c{text-align:center}.hero-c h1{margin-left:auto;margin-right:auto;font-size:clamp(42px,6.4vw,78px)}
.hero-c .lead{margin-left:auto;margin-right:auto}
.chips{display:flex;gap:18px;justify-content:center;flex-wrap:wrap;font-size:14px;color:var(--muted);margin-top:16px}.chips span{display:inline-flex;gap:6px;align-items:center}.chips svg{color:var(--green)}
.shot{margin:44px auto 0;max-width:1100px;border:1px solid var(--line);border-radius:18px;overflow:hidden;background:#fff;box-shadow:0 40px 100px rgba(28,25,23,.12)}
.shot img{display:block;width:100%;height:auto}
.plans{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.plan{border:1px solid var(--line);border-radius:18px;background:#fff;padding:24px;display:flex;flex-direction:column}
.plan.hl{border-color:#1c1917;box-shadow:0 0 0 1px #1c1917}
.plan .price{font-size:40px;font-weight:800;letter-spacing:-.03em;margin:6px 0 2px}.plan .price small{font-size:15px;color:var(--muted);font-weight:500}
.plan ul{list-style:none;padding:0;margin:14px 0 18px;display:grid;gap:8px;font-size:14.5px}.plan li{display:flex;gap:8px}.plan li svg{color:var(--green);flex:none;margin-top:3px}
.plan .btn{margin-top:auto;width:100%}
.vs td,.vs th{padding:11px 14px}
details{border:1px solid var(--line);border-radius:14px;background:#fff;padding:16px 20px;margin-bottom:10px}
summary{cursor:pointer;font-weight:650;list-style:none;display:flex;justify-content:space-between;gap:12px}summary::-webkit-details-marker{display:none}
summary::after{content:"+";color:var(--accent);font-size:20px;line-height:1}details[open] summary::after{content:"–"}details p{color:var(--muted);margin:10px 0 0}
@media(max-width:960px){.plans{grid-template-columns:1fr 1fr}}@media(max-width:620px){.plans{grid-template-columns:1fr}}
</style>`;

function planCards(c: PageCtx, plans: Plan[] = PLANS) {
  return `<div class="plans">${plans.map((p) => `<div class="plan${p.highlight ? ' hl' : ''}">
    <div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:18px">${esc(p.name)}</b>${p.highlight ? '<span class="small" style="background:#1c1917;color:#fff;border-radius:999px;padding:2px 10px">Popular</span>' : ''}</div>
    <div class="price">${money(p.monthly)}<small>/month</small></div>
    <p class="small muted" style="margin:0">${p.monthly ? `or ${money(p.monthly * 10)} a year (2 months free)` : 'Free forever'}</p>
    <ul>${[`Up to ${num(p.subscribers)} subscribers`, `${num(p.emails)} emails a month`, 'Every feature included', '0% of your revenue'].map((x) => `<li>${ic('check', 16)}<span>${x}</span></li>`).join('')}</ul>
    <p class="small muted" style="margin:0 0 16px">${esc(p.blurb)}</p>
    <a class="btn ${p.highlight ? 'btn-primary' : 'btn-ghost'}" href="/signup?plan=${p.id}">${p.monthly ? `Start with ${esc(p.name)}` : 'Start free'}</a>
  </div>`).join('')}</div>
  <p class="small muted" style="margin-top:14px">More than ${num(plans[plans.length - 1].subscribers)} subscribers? ${c.contact ? `<a href="mailto:${esc(c.contact)}" style="text-decoration:underline">Email us</a> for a custom plan.` : 'Contact us for a custom plan.'} Prices in US dollars. Stripe's card fees apply to what you sell; we take nothing.</p>`;
}

const FAQ: Array<[string, string]> = [
  ['Is there really a free plan?', 'Yes. Up to 500 subscribers and 2,500 emails a month, with every feature. Emails carry a small "Sent with Lnkbase Newsletter" line until you upgrade.'],
  ['What happens when I reach a limit?', 'Nobody who signs up is ever turned away. You get a heads-up at 80%, and when you go over, sending pauses until you upgrade. Your readers, posts and site keep working.'],
  ['Do you take a cut of my paid subscriptions or sales?', 'No. 0% on every plan. Paid subscriptions, products, tickets and sponsorships go straight to your own Stripe account; only Stripe\'s card fees apply.'],
  ['Can I send from my own domain?', 'Yes. Add your domain and we give you the SPF, DKIM and DMARC records to publish. Until then, emails go out from our sending domain with replies coming to you.'],
  ['Can I bring my list from beehiiv, Substack, Mailchimp or Kit?', 'Yes. Export a CSV and import it; we read each platform\'s columns and keep unsubscribed and bounced readers out. There\'s a step-by-step guide for each platform.'],
  ['Will my emails land in the inbox?', 'Our test issue scores 10/10 on mail-tester.com, with SPF, DKIM and DMARC all passing. We check every address before it joins your list, filter bot clicks, and publish our live delivery numbers.'],
  ['Can I leave whenever I want?', 'Yes. Export your subscribers, posts and segments any time. Plans are month to month.'],
];

export function homePage(c: PageCtx, plans: Plan[] = PLANS) {
  const counts = featureCounts();
  const at4k = planFor(4000, plans);
  const rows = PLATFORMS.filter((p) => ['beehiiv', 'mailchimp', 'ghost', 'mailerlite', 'substack', 'kit'].includes(p.slug)).map((p) => ({ name: p.name, plan: p.prices[1]?.plan || '', usd: p.prices[1]?.usd ?? null, slug: p.slug }));
  return `${HOME_CSS}
<section class="hero"><div class="wrap hero-c">
  <div class="eyebrow">${esc(BRAND)}</div>
  <h1>Your newsletter, without the big-platform bill</h1>
  <p class="lead">Write, send, grow and earn with the editor, automations, website, paid subscriptions, podcasts, events and community you'd expect from beehiiv. Free to start, ${at4k ? `${money(at4k.monthly)} a month at 4,000 subscribers,` : ''} and 0% of what you earn.</p>
  <div class="ctas" style="justify-content:center"><a class="btn btn-primary" href="/signup">Start free</a><a class="btn btn-ghost" href="/try">Get a sample issue in your inbox</a></div>
  <div class="chips"><span>${ic('check', 16)} Free up to 500 subscribers</span><span>${ic('check', 16)} 0% of your revenue</span><span>${ic('check', 16)} 10/10 on mail-tester.com</span><span>${ic('check', 16)} ${counts.y} features, every plan</span></div>
  <figure class="shot"><img src="/static/shots/home.jpg" alt="The ${esc(BRAND)} dashboard" width="1360" height="850"></figure>
  <p class="small muted" style="margin-top:10px">The real dashboard, from the live demo with sample data.</p>
</div></section>

<section><div class="wrap" style="display:grid;grid-template-columns:1fr 1.1fr;gap:40px;align-items:center">
  <div><div class="eyebrow">Price</div><h2>A list of 4,000 costs ${at4k ? money(at4k.monthly) : 'less'} a month here</h2><p class="muted">The same list on the platforms you know, one issue a week, from each one's pricing page. And we take nothing from what you sell.</p><a class="btn btn-ghost" href="/compare">See every comparison</a></div>
  <div class="tw"><table class="vs"><tr><th>4,000 subscribers</th><th>Plan</th><th style="text-align:right">Per month</th></tr>
    ${at4k ? `<tr><td><b>${esc(BRAND)}</b></td><td>${esc(at4k.name)}</td><td class="num"><b>${money(at4k.monthly)}</b></td></tr>` : ''}
    ${rows.map((r) => `<tr><td><a href="/compare/${r.slug}">${esc(r.name)}</a></td><td class="muted">${esc(r.plan)}</td><td class="num">${r.usd == null ? '—' : r.usd === 0 ? 'Free' : '$' + (r.usd % 1 ? r.usd.toFixed(2) : r.usd)}</td></tr>`).join('')}
  </table></div>
</div></section>
<style>@media(max-width:860px){section .wrap[style*="grid-template-columns:1fr 1.1fr"]{grid-template-columns:1fr!important}}</style>

<section><div class="wrap"><div style="text-align:center"><div class="eyebrow">Everything included</div><h2>The whole newsletter business, on every plan</h2><p class="muted" style="max-width:640px;margin:0 auto 28px">${counts.y} features across ${FEATURE_AREAS.length} areas, each listed one by one with a screenshot of the real app.</p></div>
  <div class="grid">${FEATURE_AREAS.slice(0, 12).map((f) => `<a class="card" href="/features/${f.slug}"><div class="ic">${ic(f.icon)}</div><h3>${esc(f.title)}</h3><p>${esc(f.tagline)}</p></a>`).join('')}</div>
  <p style="text-align:center;margin-top:22px"><a class="btn btn-ghost" href="/features">See all ${counts.total} features →</a></p>
</div></section>

<section><div class="wrap" style="display:grid;grid-template-columns:1fr 1fr;gap:40px;align-items:center">
  <div class="card" style="padding:28px"><div class="muted small">mail-tester.com score of our sample issue</div><div style="font-size:64px;font-weight:850;letter-spacing:-.03em">10/10</div><ul class="ticks">${['SPF, DKIM and DMARC all pass', 'Not on any blocklist', 'One-click unsubscribe headers', 'No broken links'].map(tick).join('')}</ul></div>
  <div><div class="eyebrow">Deliverability</div><h2>Built to land in the inbox, and we show our numbers</h2><p class="muted">Every address is checked before it joins your list, bounces and complaints are suppressed automatically, bot clicks are filtered out of your reports, and campaigns pause on their own if something looks wrong.</p>
  <div class="ctas"><a class="btn btn-ghost" href="/open">Live delivery numbers</a><a class="btn btn-ghost" href="/try">Send yourself a sample</a></div></div>
</div></section>
<style>@media(max-width:860px){section .wrap[style*="grid-template-columns:1fr 1fr"]{grid-template-columns:1fr!important}}</style>

<section id="pricing"><div class="wrap"><div style="text-align:center;margin-bottom:28px"><div class="eyebrow">Pricing</div><h2>Pay for your list size. Every feature on every plan.</h2></div>${planCards(c, plans)}</div></section>

<section><div class="wrap narrow"><h2 style="text-align:center">Questions</h2><div style="margin-top:22px">${FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div></div></section>

<section class="cta"><div class="wrap"><h2>Start your newsletter today</h2><p class="muted" style="margin:0 auto 24px;max-width:520px">Free up to 500 subscribers. No card needed.</p><div class="ctas" style="justify-content:center"><a class="btn btn-primary" href="/signup">Start free</a><a class="btn btn-ghost" href="/compare#guides">Move from another platform</a></div></div></section>`;
}

export function pricingPage(c: PageCtx, plans: Plan[] = PLANS) {
  return `${HOME_CSS}
<section class="hero"><div class="wrap hero-c"><div class="eyebrow">Pricing</div><h1>Simple pricing by list size</h1><p class="lead">Every feature on every plan, 0% of your revenue, month to month. Start free and upgrade when your list grows.</p></div></section>
<section style="padding-top:0"><div class="wrap">${planCards(c, plans)}</div></section>
<section><div class="wrap narrow"><h2>What every plan includes</h2><ul class="ticks" style="margin-top:14px">${['The editor, automations, segments, website and custom domain', 'Paid subscriptions, digital products, events and sponsorships, with 0% platform fees', 'Podcasts, community, polls and surveys', 'Deliverability protection, bot-filtered analytics and the live delivery page', 'REST API, webhooks and an MCP server for AI agents', 'Import from any platform, export any time'].map(tick).join('')}</ul>
<h2 style="margin-top:40px">Questions</h2><div style="margin-top:16px">${FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div></div></section>
<section class="cta"><div class="wrap"><h2>Start free</h2><div class="ctas" style="justify-content:center"><a class="btn btn-primary" href="/signup">Create your newsletter</a><a class="btn btn-ghost" href="/compare">Compare platforms</a></div></div></section>`;
}
