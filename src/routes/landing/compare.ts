// /compare, /compare/:slug and /migrate/:slug. Data lives in compare-data.ts.
import { esc } from '../../lib/util';
import { tick } from './marketing';
import { PLATFORMS, SIZES, OPENHIVE_COST, OUR_PLANS, CHECKED_ON, FEATURE_ROWS, type Platform, type Cell } from './compare-data';
import { BRAND } from './brand';
import type { PageCtx } from './pages';

const money = (v: number | null | undefined) => (v == null ? '—' : v === 0 ? 'Free' : `$${v % 1 ? v.toFixed(2) : v.toLocaleString('en-US')}`);
const sizeLabel = (s: number) => (s >= 1000 ? `${s / 1000}k` : String(s));
const checked = new Date(CHECKED_ON + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const badge = (p: { name: string; color: string }) => `<span style="display:inline-grid;place-items:center;width:22px;height:22px;border-radius:6px;background:${p.color};color:#fff;font-weight:800;font-size:12px;flex:none">${esc(p.name[0])}</span>`;
const OH = { name: BRAND, color: '#1c1917' };


/** Cost table with a list-size switcher. Our row shows the cheapest hosted plan that fits. */
function costCard(c: PageCtx, only?: Platform) {
  const list = only ? [only] : PLATFORMS;
  const rows = (i: number) => {
    const r = [{ p: OH, plan: OUR_PLANS[i]?.name || 'Custom plan', v: OPENHIVE_COST[i], href: '/' }, ...list.map((p) => ({ p, plan: p.prices[i]?.plan || '', v: p.prices[i]?.usd ?? null, href: `/compare/${p.slug}` }))];
    const max = Math.max(1, ...r.map((x) => x.v || 0));
    return r.sort((a, b) => (a.v ?? 1e9) - (b.v ?? 1e9)).map((x) => `<a href="${x.href}" style="display:grid;grid-template-columns:150px 1fr 150px 70px;gap:10px;align-items:center;padding:7px 0;${x.p === OH ? 'font-weight:700' : ''}">
      <span style="display:flex;gap:8px;align-items:center">${badge(x.p)}${esc(x.p.name)}</span>
      <span style="height:6px;border-radius:4px;background:#e7e5e4;position:relative;overflow:hidden"><i style="position:absolute;inset:0 auto 0 0;width:${x.v ? Math.max(2, (x.v / max) * 100) : 0}%;background:${x.p === OH ? 'var(--accent)' : '#78716c'}"></i></span>
      <span class="muted small">${esc(x.plan)}</span><span class="num" style="text-align:right">${x.v == null ? '<span class="muted">n/a</span>' : money(x.v)}</span></a>`).join('');
  };
  return `<div class="card" id="cost">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px"><h3 style="margin:0">What a list costs a month</h3>
    <div role="tablist" style="display:flex;gap:4px;background:#f5f5f4;border:1px solid var(--line);border-radius:10px;padding:3px">${SIZES.map((s, i) => `<button role="tab" data-i="${i}" style="all:unset;cursor:pointer;padding:5px 11px;border-radius:7px;font-size:13.5px;${i === 1 ? 'background:#fff;color:#1c1917;box-shadow:0 1px 2px rgba(0,0,0,.08)' : 'color:#57534e'}">${sizeLabel(s)}</button>`).join('')}</div></div>
    ${SIZES.map((_, i) => `<div data-panel="${i}" ${i === 1 ? '' : 'hidden'}>${rows(i)}</div>`).join('')}
    <p class="small muted" style="margin:12px 0 0">The cheapest plan that fits one issue a week (about 4.3 emails per subscriber a month), billed monthly in US dollars, from each pricing page on ${checked}. Ours is the cheapest Lnkbase Newsletter plan that fits. <a href="#how" style="text-decoration:underline">How our plans work</a></p>
  </div>
  <script>document.querySelectorAll('#cost [role=tab]').forEach(function(b){b.onclick=function(){var i=b.dataset.i;document.querySelectorAll('#cost [role=tab]').forEach(function(x){var on=x===b;x.style.background=on?'#fff':'transparent';x.style.color=on?'#1c1917':'#57534e'});document.querySelectorAll('#cost [data-panel]').forEach(function(p){p.hidden=p.dataset.panel!==i})}})</script>`;
}

const howPriced = () => `<section id="how" style="padding-top:8px"><div class="wrap narrow"><h2>How we priced Lnkbase Newsletter</h2>
  ${OPENHIVE_COST_NOTES.map((p) => `<p class="muted">${p}</p>`).join('')}</div></section>`;

import { OPENHIVE_COST_NOTES } from './compare-data';

const disclaimer = () => `<section style="padding:24px 0"><div class="wrap"><p class="small muted">Every product name here belongs to its owner and is used only to name the product compared. Lnkbase isn't affiliated with any of them. Prices and features come from their own sites on ${checked} and may have changed since.</p></div></section>`;

export function compareIndex(c: PageCtx) {
  return `<section class="hero"><div class="wrap" style="display:grid;grid-template-columns:1fr 1.15fr;gap:40px;align-items:start">
  <div><div class="eyebrow">Compare</div><h1>Lnkbase Newsletter next to the platforms you know</h1>
  <p class="lead">Their monthly prices at five list sizes, what each one does that we don't, and a guide to move your list. Lnkbase Newsletter is free up to 500 subscribers, with every feature on every plan.</p>
  <div class="ctas"><a class="btn btn-primary" href="/signup">Start free</a><a class="btn btn-ghost" href="#guides">Migration guides</a></div></div>
  ${costCard(c)}
</div></section>
<style>@media(max-width:960px){.hero .wrap{grid-template-columns:1fr!important}}@media(max-width:620px){#cost a{grid-template-columns:120px 1fr 60px!important}#cost a>span:nth-child(3){display:none}}</style>

<section><div class="wrap"><h2>One page per platform</h2><p class="muted" style="margin-top:0">A feature table that says where each one does more, the price at five list sizes, and how to move.</p>
<div class="grid" style="margin-top:20px">${PLATFORMS.map((p) => `<div class="card"><div style="display:flex;gap:10px;align-items:center;font-weight:800;font-size:18px">${badge(p)}${esc(p.name)}</div>
  <h3 style="margin:14px 0 8px">Lnkbase vs ${esc(p.name)}</h3><p>${esc(p.summary)}</p>
  <p class="small" style="margin:14px 0;padding:10px 12px;border-radius:10px;background:#f5f5f4">4,000 subscribers: <b>${money(OPENHIVE_COST[1])}/mo</b> vs <b>${money(p.prices[1]?.usd)}${p.prices[1]?.usd ? '/mo' : ''}</b></p>
  <p style="display:flex;gap:18px;margin:0"><a href="/compare/${p.slug}" style="color:var(--text);font-weight:700">Compare →</a><a href="/migrate/${p.slug}" class="muted">Migration guide</a></p></div>`).join('')}</div></div></section>

<section id="guides"><div class="wrap" style="display:grid;grid-template-columns:1fr 1.2fr;gap:40px;align-items:start">
  <div><div class="eyebrow">Migration guides</div><h2>Bring your list as it is</h2><p class="muted">Export from your platform and import the file. we read its columns, including the status, so people who unsubscribed or bounced stay out.</p></div>
  <div class="grid2">${PLATFORMS.map((p) => `<a class="card" href="/migrate/${p.slug}" style="display:flex;justify-content:space-between;padding:16px 18px"><span>Migrate from ${esc(p.name)}</span><span>→</span></a>`).join('')}</div>
</div></section>
<style>@media(max-width:960px){#guides .wrap{grid-template-columns:1fr!important}}</style>
${howPriced()}${disclaimer()}`;
}

const cell = (v: Cell) => (v === true ? '<td class="yes">Yes</td>' : v === false ? '<td class="no">No</td>' : `<td>${esc(String(v))}</td>`);

export function comparePlatform(c: PageCtx, p: Platform) {
  return `<section class="hero"><div class="wrap">
  <a class="eyebrow" href="/compare">Compare</a><h1>Lnkbase Newsletter vs ${esc(p.name)}</h1><p class="lead">${esc(p.summary)}</p>
  <div class="ctas"><a class="btn btn-primary" href="/signup">Start free</a><a class="btn btn-ghost" href="/migrate/${p.slug}">Migrate from ${esc(p.name)}</a></div>
</div></section>
<section style="padding-top:8px"><div class="wrap"><h2>Price at five list sizes</h2>
  <div class="tw" style="margin-top:16px"><table><tr><th>Subscribers</th>${SIZES.map((s) => `<th class="num">${s.toLocaleString('en-US')}</th>`).join('')}</tr>
  <tr><td><b>${BRAND}</b></td>${OPENHIVE_COST.map((v, i) => `<td class="num">${v == null ? 'Custom' : `<b>${money(v)}</b>${v ? '/mo' : ''}`}<div class="small muted">${esc(OUR_PLANS[i]?.name || 'Talk to us')}</div></td>`).join('')}</tr>
  <tr><td><b>${esc(p.name)}</b></td>${p.prices.map((x) => `<td class="num">${x.usd == null ? '<span class="muted">n/a</span>' : `${money(x.usd)}${x.usd ? '/mo' : ''}`}<div class="small muted">${esc(x.plan)}</div></td>`).join('')}</tr></table></div>
  ${p.priceNote ? `<p class="small muted" style="margin-top:10px">${esc(p.priceNote)}</p>` : ''}
</div></section>
<section style="padding-top:8px"><div class="wrap"><h2>Feature by feature</h2>
  <div class="tw" style="margin-top:16px"><table><tr><th></th><th>Lnkbase</th><th>${esc(p.name)}</th></tr>
  ${FEATURE_ROWS.map(([label, oh]) => `<tr><td>${esc(label)}</td>${cell(oh)}${cell(p.features[label] ?? '—')}</tr>`).join('')}</table></div>
</div></section>
<section style="padding-top:8px"><div class="wrap grid2">
  <div class="card"><h3>What ${esc(p.name)} has that we don't</h3><ul class="ticks" style="margin-top:12px">${p.theyHave.map((x) => tick(esc(x))).join('')}</ul></div>
  <div class="card"><h3>What Lnkbase Newsletter gives you</h3><ul class="ticks" style="margin-top:12px">${p.weHave.map((x) => tick(esc(x))).join('')}</ul></div>
</div></section>
<section style="padding-top:8px"><div class="wrap">${costCard(c, p)}</div></section>
${howPriced()}${disclaimer()}`;
}

export function migratePage(c: PageCtx, p: Platform) {
  return `<section class="hero"><div class="wrap narrow">
  <a class="eyebrow" href="/compare#guides">Migration guides</a><h1>Migrate from ${esc(p.name)} to Lnkbase Newsletter</h1>
  <p class="lead">Export your list from ${esc(p.name)}, import the file, and your readers keep getting your newsletter. People who unsubscribed or bounced stay out.</p>
</div></section>
<section style="padding-top:0"><div class="wrap narrow">
  <ol style="padding-left:22px;display:grid;gap:22px;margin:0">
    <li><h3>Export your subscribers from ${esc(p.name)}</h3>${p.exportSteps.map((s) => `<p class="muted" style="margin:6px 0">${s}</p>`).join('')}</li>
    <li><h3>Import the file</h3><p class="muted" style="margin:6px 0">In your dashboard, open <b>Audience → Import &amp; export</b> and upload the CSV. We match the columns for you: email, names, tags, signup date, source and status. Check the mapping, add tags or lists if you like, and start the import.</p>
      <p class="muted" style="margin:6px 0">Rows marked unsubscribed, bounced, cleaned, spam or unconfirmed are left out and suppressed, so they never get an email. Every address is checked for typos, throwaway inboxes and invalid syntax, and the import report lists each skipped row with the reason.</p></li>
    <li><h3>Send from your own domain</h3><p class="muted" style="margin:6px 0">Add your domain under <b>Settings → Domains</b>, publish the SPF, DKIM and DMARC records it shows, and we warms it up for you: 200 emails the first day, doubling each day.</p></li>
    ${p.extraSteps.map((s) => `<li><h3>${esc(s.h)}</h3><p class="muted" style="margin:6px 0">${s.p}</p></li>`).join('')}
    <li><h3>Keep your old links working</h3><p class="muted" style="margin:6px 0">Point your domain at your new site and add redirects under <b>Website → Redirects</b> (a CSV import works) so old post links land on the new pages.</p></li>
  </ol>
  ${p.exportSource ? `<p class="small muted" style="margin-top:28px">${esc(p.name)}'s export help: <a href="${esc(p.exportSource)}" rel="nofollow noopener" style="text-decoration:underline">${esc(p.exportSource)}</a></p>` : ''}
  <p style="margin-top:28px"><a class="btn btn-ghost" href="/compare/${p.slug}">Lnkbase vs ${esc(p.name)} →</a></p>
</div></section>${disclaimer()}`;
}
