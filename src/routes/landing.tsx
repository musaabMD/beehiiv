/** @jsxImportSource hono/jsx */
// Module: landing — sales page at "/", documentation at "/docs", API reference at "/docs/api".
import { Hono } from 'hono';
import type { AppEnv, Module } from '../types';
import { currentUser } from '../lib/auth';
import { DOCS } from '../lib/docs-content';
import { markdownToHtml } from '../lib/markdown';
import { searchDocs, TOOLS } from '../lib/mcp';
import { esc } from '../lib/util';
import { landingHtml } from './landing/page';
import { groupedRoutes, API_BASE } from './api/openapi';
import { shell } from './landing/marketing';
import { featuresIndex, featurePage, openPage, changelogPage, type PageCtx } from './landing/pages';
import { featureBySlug } from './landing/features-data';
import { openStats } from '../lib/openstats';
import { mountTryIt } from './landing/tryit';
import { compareIndex, comparePlatform, migratePage } from './landing/compare';
import { platformBySlug } from './landing/compare-data';

const root = new Hono<AppEnv>();

root.get('/', async (c) => {
  const user = await currentUser(c).catch(() => null);
  c.header('cache-control', user ? 'private, no-store' : 'public, max-age=300');
  return c.html(landingHtml({ purchaseUrl: c.env.PURCHASE_URL, priceLabel: c.env.PRICE_LABEL, loggedIn: !!user, demo: c.req.query('static') !== '1', contact: c.env.CONTACT_EMAIL, appUrl: c.env.APP_URL }));
});

// ── Marketing pages ──
async function ctxFor(c: any): Promise<PageCtx> {
  const user = await currentUser(c).catch(() => null);
  c.header('cache-control', user ? 'private, no-store' : 'public, max-age=300');
  return { purchaseUrl: c.env.PURCHASE_URL, priceLabel: c.env.PRICE_LABEL, contact: c.env.CONTACT_EMAIL, loggedIn: !!user };
}
const page = (p: PageCtx, active: any, title: string, description: string, body: string) => shell({ ...p, active, title, description, body });

root.get('/features', async (c) => {
  const p = await ctxFor(c);
  return c.html(page(p, 'features', 'Features · OpenHive', 'Every OpenHive feature: editor, sending and deliverability, automations, audience, website, paid subscriptions, products, webinars, podcasts, community, growth, ads, analytics, API and MCP.', featuresIndex(p)));
});
root.get('/features/:slug', async (c) => {
  const ALIAS: Record<string, string> = { sending: 'deliverability', audience: 'segments', growth: 'recommendations', developers: 'api' };
  const slug = c.req.param('slug');
  if (ALIAS[slug]) return c.redirect(`/features/${ALIAS[slug]}`, 301);
  const f = featureBySlug(slug);
  if (!f) return c.redirect('/features', 302);
  const p = await ctxFor(c);
  return c.html(page(p, 'features', `${f.title} · OpenHive`, `${f.tagline} ${f.intro}`, featurePage(p, f)));
});
root.get('/open', async (c) => {
  const p = await ctxFor(c);
  // Stats are cached for 10 minutes so the page stays cheap however busy it gets.
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  const key = new Request(new URL('/__openstats', c.req.url).toString());
  let stats: any = null;
  try { const hit = await cache?.match(key); if (hit) stats = await hit.json(); } catch {}
  if (!stats) {
    stats = await openStats(c.env);
    try { c.executionCtx.waitUntil(cache?.put(key, new Response(JSON.stringify(stats), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=600' } })) || Promise.resolve()); } catch {}
  }
  return c.html(page(p, 'open', 'Deliverability: live delivery, bounce and spam rates · OpenHive', 'Live delivery, bounce, spam complaint and open rates for the email this OpenHive install sends, and how each number is counted.', openPage(p, stats)));
});
root.get('/compare', async (c) => {
  const p = await ctxFor(c);
  return c.html(page(p, 'compare', 'OpenHive vs beehiiv, Substack, Mailchimp, Kit and more · Compare', 'What a newsletter costs each month on beehiiv, Substack, Mailchimp, Kit, MailerLite, Buttondown, Ghost, EmailOctopus and MailCheap, next to OpenHive, with migration guides.', compareIndex(p)));
});
root.get('/compare/:slug', async (c) => {
  const pl = platformBySlug(c.req.param('slug'));
  if (!pl) return c.redirect('/compare', 302);
  const p = await ctxFor(c);
  return c.html(page(p, 'compare', `OpenHive vs ${pl.name} · Compare`, `OpenHive vs ${pl.name}: price at five list sizes, feature by feature, and what ${pl.name} has that OpenHive doesn't.`, comparePlatform(p, pl)));
});
root.get('/migrate/:slug', async (c) => {
  const pl = platformBySlug(c.req.param('slug'));
  if (!pl) return c.redirect('/compare#guides', 302);
  const p = await ctxFor(c);
  return c.html(page(p, 'compare', `Migrate from ${pl.name} to OpenHive`, `Export your list from ${pl.name} and import it into OpenHive, with unsubscribed and bounced readers kept out.`, migratePage(p, pl)));
});
mountTryIt(root, ctxFor);

root.get('/changelog', async (c) => {
  const p = await ctxFor(c);
  return c.html(page(p, 'changelog', 'Changelog · OpenHive', 'What\'s new in OpenHive, newest first.', changelogPage(p)));
});

const NAV_ORDER = ['readme', 'deploy', 'deliverability', 'api', 'mcp', 'support', 'architecture'];

function docsShell(title: string, active: string, body: string, toc: Array<{ id: string; text: string; level: number }> = [], q = '') {
  const pages = NAV_ORDER.map((s) => DOCS.find((d) => d.slug === s)).filter(Boolean) as typeof DOCS;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · OpenHive Docs</title><link rel="icon" href="/static/favicon.svg">
<style>
:root{--text:#111827;--muted:#6b7280;--line:#e5e7eb;--accent:#d97706;--bg:#fff;--side:#f9fafb}
*{box-sizing:border-box}body{margin:0;font:16px/1.7 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:var(--text);background:var(--bg)}
a{color:var(--accent)}header{position:sticky;top:0;z-index:5;background:rgba(255,255,255,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.hd{display:flex;align-items:center;gap:16px;height:60px;padding:0 20px;max-width:1280px;margin:0 auto}
.brand{display:flex;gap:8px;align-items:center;font-weight:800;color:var(--text);text-decoration:none}
form.s{flex:1;max-width:420px}form.s input{width:100%;height:38px;border:1px solid var(--line);border-radius:9px;padding:0 12px;font:inherit;font-size:14px}
.hd .r{margin-left:auto;display:flex;gap:14px;font-size:14px}.hd .r a{color:var(--muted);text-decoration:none}
.layout{display:grid;grid-template-columns:240px minmax(0,1fr) 220px;gap:40px;max-width:1280px;margin:0 auto;padding:0 20px}
nav.side{position:sticky;top:60px;align-self:start;padding:28px 0;max-height:calc(100vh - 60px);overflow:auto}
nav.side a{display:block;padding:7px 12px;border-radius:8px;color:#374151;text-decoration:none;font-size:14.5px}nav.side a.on{background:#fef3c7;color:#78350f;font-weight:600}nav.side a:hover{background:#f3f4f6}
nav.side h4{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:18px 12px 6px}
article{padding:36px 0 80px;min-width:0}article h1{font-size:36px;line-height:1.15;letter-spacing:-.02em;margin:0 0 16px}
article h2{font-size:24px;margin:40px 0 10px;padding-top:10px;border-top:1px solid var(--line)}article h3{font-size:18px;margin:28px 0 8px}
article h1 .anchor,article h2 .anchor,article h3 .anchor{display:none}
article code{background:#f3f4f6;border-radius:5px;padding:1px 5px;font-size:.88em}article pre{background:#0f172a;color:#e2e8f0;border-radius:10px;padding:16px;overflow-x:auto;font-size:13.5px;line-height:1.55}article pre code{background:none;padding:0;color:inherit}
.tw{overflow-x:auto;margin:16px 0}table{border-collapse:collapse;width:100%;font-size:14.5px}th,td{border:1px solid var(--line);padding:8px 12px;text-align:left;vertical-align:top}th{background:#f9fafb}
blockquote{margin:16px 0;padding:4px 16px;border-left:4px solid #fbbf24;color:#4b5563}
aside.toc{position:sticky;top:60px;align-self:start;padding:36px 0;font-size:13.5px;max-height:calc(100vh - 60px);overflow:auto}aside.toc a{display:block;color:var(--muted);text-decoration:none;padding:3px 0}aside.toc a:hover{color:var(--text)}aside.toc .l3{padding-left:12px}
.hit{border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:10px}.hit a{font-weight:600;text-decoration:none}.hit p{margin:6px 0 0;color:var(--muted);font-size:14px}
.ep{display:flex;gap:10px;align-items:baseline;padding:10px 0;border-bottom:1px solid var(--line);flex-wrap:wrap}.ep code{font-size:13px}.m{font:700 11px/1 ui-monospace,monospace;padding:4px 7px;border-radius:5px;color:#fff;min-width:54px;text-align:center}
.m-GET{background:#2563eb}.m-POST{background:#059669}.m-PATCH{background:#d97706}.m-PUT{background:#7c3aed}.m-DELETE{background:#dc2626}.ep small{color:var(--muted);flex-basis:100%;padding-left:64px}
.params{padding-left:64px;font-size:13px;color:#4b5563;flex-basis:100%}.params b{font-family:ui-monospace,monospace;font-weight:600;color:#111}
@media(max-width:1100px){.layout{grid-template-columns:220px minmax(0,1fr)}aside.toc{display:none}}
@media(max-width:760px){.layout{grid-template-columns:1fr}nav.side{position:static;max-height:none;padding:12px 0;display:flex;gap:4px;overflow-x:auto}nav.side h4{display:none}nav.side a{white-space:nowrap}.hd .r{display:none}.ep small,.params{padding-left:0}}
</style></head><body>
<header><div class="hd"><a class="brand" href="/"><img src="/static/favicon.svg" width="24" height="24" alt="">OpenHive <span style="color:var(--muted);font-weight:500">Docs</span></a>
<form class="s" action="/docs" method="get"><input name="q" value="${esc(q)}" placeholder="Search the docs…" aria-label="Search docs"></form>
<div class="r"><a href="/docs/api">API reference</a><a href="/api/v2/openapi.json">OpenAPI</a><a href="/app">Dashboard</a></div></div></header>
<div class="layout"><nav class="side"><h4>Guides</h4>${pages.map((p) => `<a href="/docs/${p.slug === 'api' ? 'api-guide' : p.slug}" class="${p.slug === active ? 'on' : ''}">${esc(p.title)}</a>`).join('')}<h4>Reference</h4><a href="/docs/api" class="${active === 'api-ref' ? 'on' : ''}">REST API endpoints</a><a href="/docs/mcp-tools" class="${active === 'mcp-tools' ? 'on' : ''}">MCP tools</a></nav>
<article>${body}</article>
<aside class="toc">${toc.filter((h) => h.level > 1 && h.level < 4).map((h) => `<a class="l${h.level}" href="#${h.id}">${esc(h.text)}</a>`).join('')}</aside></div></body></html>`;
}

root.get('/docs', (c) => {
  const q = (c.req.query('q') || '').trim();
  if (!q) return c.redirect('/docs/readme');
  const hits = searchDocs(q);
  const body = `<h1>Search: ${esc(q)}</h1>${hits.length ? hits.map((h) => `<div class="hit"><a href="${esc(h.url)}">${esc(h.title)} › ${esc(h.heading)}</a><p>${esc(h.excerpt)}…</p></div>`).join('') : '<p>No results. Try different words, or browse the guides on the left.</p>'}`;
  return c.html(docsShell(`Search: ${q}`, '', body, [], q));
});

root.get('/docs/api', (c) => {
  const groups = groupedRoutes();
  const body = `<h1>REST API reference</h1>
<p>Base URL: <code>${esc(c.env.APP_URL.replace(/\/$/, ''))}${API_BASE.replace('{pubId}', '{pubId}')}</code> or the shortcut <code>/api/v2/publication</code>. Authenticate with <code>Authorization: Bearer &lt;API key&gt;</code>. Lists return <code>{data, next_cursor, has_more}</code>. Rate limit 180 requests/minute per key. Machine-readable spec: <a href="/api/v2/openapi.json">openapi.json</a>. Guide: <a href="/docs/api-guide">API guide</a>.</p>
${groups.map(([tag, routes]) => `<h2 id="${tag.toLowerCase().replace(/[^a-z0-9]+/g, '-')}">${esc(tag)}</h2>${routes.map((r) => `<div class="ep"><span class="m m-${r.method}">${r.method}</span><code>${esc(r.path || '/')}</code><small>${esc(r.summary)}</small>${r.query ? `<div class="params">Query: ${Object.entries(r.query).map(([k, d]) => `<b>${esc(k)}</b> ${esc(d)}`).join(' · ')}</div>` : ''}${r.body ? `<div class="params">Body: ${Object.entries(r.body).map(([k, d]) => `<b>${esc(k)}</b> ${esc(d)}`).join(' · ')}</div>` : ''}</div>`).join('')}`).join('')}`;
  const toc = groups.map(([tag]) => ({ id: tag.toLowerCase().replace(/[^a-z0-9]+/g, '-'), text: tag, level: 2 }));
  return c.html(docsShell('REST API reference', 'api-ref', body, toc));
});

root.get('/docs/mcp-tools', (c) => {
  const body = `<h1>MCP tools</h1><p>Endpoint <code>${esc(c.env.APP_URL.replace(/\/$/, ''))}/mcp</code> · see the <a href="/docs/mcp">MCP guide</a> to connect Claude or ChatGPT.</p>${TOOLS.map((t) => `<h3 id="${t.name}"><code>${t.name}</code> — ${esc(t.title)}</h3><p>${esc(t.description)}</p><pre><code>${esc(JSON.stringify(t.inputSchema, null, 2))}</code></pre>`).join('')}`;
  return c.html(docsShell('MCP tools', 'mcp-tools', body, TOOLS.map((t) => ({ id: t.name, text: t.name, level: 3 }))));
});

root.get('/docs/:page', (c) => {
  let slug = c.req.param('page').toLowerCase().replace(/\.md$/, '');
  if (slug === 'api-guide') slug = 'api';
  const d = DOCS.find((x) => x.slug === slug);
  if (!d) return c.html(docsShell('Not found', '', '<h1>Page not found</h1><p><a href="/docs/readme">Back to the docs</a></p>'), 404);
  // Rewrite relative markdown links (docs/DEPLOY.md, DELIVERABILITY.md) to doc routes.
  const md = d.body.replace(/\]\((?:docs\/)?([A-Z]+)\.md\)/g, (_, f: string) => `](/docs/${f.toLowerCase() === 'api' ? 'api-guide' : f.toLowerCase()})`);
  const { html, headings } = markdownToHtml(md);
  return c.html(docsShell(d.title, slug, html, headings));
});

export default { root } satisfies Module;
