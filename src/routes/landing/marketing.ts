// Shared frame for every marketing page (/, /pricing, /features, /compare, /migrate, /open, /changelog, /try):
// header with the product nav, footer with links and contact. Brand lives in ./brand.ts.
import { esc } from '../../lib/util';
import { ic } from './page';
import { BRAND, PARENT, FAVICON as BRAND_ICON, wordmark } from './brand';

export { ic };

export interface ShellOpts {
  title: string;
  description: string;
  active?: 'features' | 'pricing' | 'compare' | 'open' | 'changelog';
  purchaseUrl?: string;
  priceLabel?: string;
  contact?: string;
  loggedIn?: boolean;
  body: string;
  head?: string;
}

const FAVICON = BRAND_ICON;

export const CSS = `
:root{--bg:#fafaf9;--bg2:#f5f5f4;--card:#ffffff;--line:#e7e5e4;--text:#1c1917;--muted:#57534e;--accent:#d97706;--accent2:#f59e0b;--green:#059669;--red:#dc2626;--radius:16px}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}img{max-width:100%}
.wrap{max-width:1160px;margin:0 auto;padding:0 20px}.narrow{max-width:820px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:46px;padding:0 22px;border-radius:12px;font-weight:700;font-size:15px;border:1px solid transparent;cursor:pointer;transition:transform .12s,background .12s,border-color .12s;white-space:nowrap}
.btn:hover{transform:translateY(-1px)}.btn-primary{background:#1c1917;color:#fff}.btn-primary:hover{background:#000}
.btn-ghost{border-color:var(--line);color:var(--text);background:#fff}.btn-ghost:hover{border-color:#a8a29e}
header.top{position:sticky;top:0;z-index:10;background:rgba(250,250,249,.86);backdrop-filter:blur(12px);border-bottom:1px solid rgba(0,0,0,.07)}
.top .wrap{display:flex;align-items:center;gap:24px;height:64px}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:18px;letter-spacing:-.01em}
.top nav{display:flex;gap:20px;flex:1;font-size:14.5px;color:var(--muted)}.top nav a:hover,.top nav a.on{color:var(--text)}.top nav a.on{font-weight:600}
.top .btn{height:38px;padding:0 16px;font-size:14px;border-radius:10px}
.hero{padding:72px 0 32px;position:relative;overflow:hidden}
.hero::before{content:"";position:absolute;inset:-220px -200px auto;height:620px;background:radial-gradient(560px 260px at 30% 20%,rgba(245,158,11,.18),transparent 70%);pointer-events:none}
.hero .wrap{position:relative}
.eyebrow{color:var(--accent);font-weight:700;font-size:13px;letter-spacing:.12em;text-transform:uppercase}
h1{font-family:Newsreader,ui-serif,Georgia,"Times New Roman",serif;font-size:clamp(38px,5.8vw,66px);line-height:1.04;letter-spacing:-.02em;margin:14px 0 16px;font-weight:600;max-width:860px}
h2{font-family:Newsreader,ui-serif,Georgia,"Times New Roman",serif;font-size:clamp(28px,3.6vw,42px);line-height:1.1;letter-spacing:-.015em;margin:8px 0 12px;font-weight:600}
h3{font-size:18px;margin:0 0 8px;letter-spacing:-.01em}
.lead{font-size:clamp(17px,2vw,20px);color:var(--muted);max-width:720px;margin:0 0 26px}
.muted{color:var(--muted)}.small{font-size:13.5px}
section{padding:56px 0}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.card{border:1px solid var(--line);background:var(--card);border-radius:var(--radius);padding:22px;display:block}
a.card:hover{border-color:#a8a29e}
.card .ic{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;background:rgba(245,158,11,.12);color:var(--accent);margin-bottom:12px}
.card p{margin:0;color:var(--muted);font-size:15px}
.ticks{list-style:none;padding:0;margin:0;display:grid;gap:10px}
.ticks li{display:flex;gap:10px;align-items:flex-start;color:#44403c}.ticks svg{flex:none;color:var(--green);margin-top:3px}
.note{border:1px solid rgba(245,158,11,.35);background:rgba(245,158,11,.06);border-radius:14px;padding:16px 18px;color:#e5e7eb;font-size:15px}
.note b{color:var(--accent2)}
.tw{overflow-x:auto;border:1px solid var(--line);border-radius:var(--radius);background:var(--card)}
table{width:100%;border-collapse:collapse;font-size:15px}
th,td{text-align:left;padding:13px 16px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600;background:#f5f5f4}
tr:last-child td{border-bottom:0}td.yes{color:var(--green);font-weight:600}td.no{color:var(--red)}td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.cta{text-align:center;padding:72px 0;background:radial-gradient(600px 260px at 50% 100%,rgba(245,158,11,.14),transparent 70%)}
.ctas{display:flex;gap:12px;flex-wrap:wrap}
footer.foot{border-top:1px solid var(--line);padding:48px 0 32px;color:var(--muted);font-size:14.5px}
.foot .cols{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:24px}
.foot h4{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:0 0 12px;font-weight:600}
.foot .cols a{display:block;color:#44403c;margin-bottom:8px}.foot .cols a:hover{color:var(--text)}
.foot .base{margin-top:32px;padding-top:20px;border-top:1px solid var(--line);font-size:13px}
@media(max-width:960px){.grid{grid-template-columns:repeat(2,1fr)}.top nav{display:none}.foot .cols{grid-template-columns:1fr 1fr}}
@media(max-width:620px){.btn{white-space:normal;height:auto;min-height:46px;padding:10px 18px;text-align:center}.grid,.grid2{grid-template-columns:1fr}section{padding:40px 0}.hero{padding-top:44px}th,td{padding:10px 12px}.hide-sm{display:none}}
`;

export function shell(o: ShellOpts): string {
  const nav: Array<[string, string, string]> = [
    ['features', '/features', 'Features'],
    ['pricing', '/pricing', 'Pricing'],
    ['compare', '/compare', 'Compare'],
    ['open', '/open', 'Deliverability'],
    ['changelog', '/changelog', 'Changelog'],
    ['', '/docs', 'Docs'],
  ];
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)}</title><meta name="description" content="${esc(o.description)}">
<meta property="og:title" content="${esc(o.title)}"><meta property="og:description" content="${esc(o.description)}"><meta property="og:type" content="website">
<link rel="icon" href="${FAVICON}"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Newsreader:opsz,wght@6..72,500;6..72,600&display=swap" rel="stylesheet"><style>${CSS}</style>${o.head || ''}</head><body>
<header class="top"><div class="wrap">
  <a class="brand" href="/">${wordmark()}</a>
  <nav>${nav.map(([k, h, t]) => `<a href="${h}"${k && k === o.active ? ' class="on"' : ''}>${t}</a>`).join('')}</nav>
  ${o.loggedIn ? '<a class="btn btn-primary" href="/app">Dashboard</a>' : '<a class="btn btn-ghost hide-sm" href="/login">Log in</a><a class="btn btn-primary" href="/signup">Start free</a>'}
</div></header>
<main>${o.body}</main>
<footer class="foot"><div class="wrap">
  <div class="cols">
    <div><a class="brand" href="/" style="margin-bottom:10px">${wordmark()}</a><p style="margin:8px 0 0;max-width:320px">Write, send, grow and earn from your newsletter, for a fraction of what the big platforms charge. A <a href="${PARENT.url}" style="text-decoration:underline">${PARENT.name}</a> product.</p><p class="small" style="margin-top:12px">Prices on the compare pages use one issue a week. <a href="/compare" style="text-decoration:underline">See the comparisons</a></p></div>
    <div><h4>Product</h4><a href="/features">Features</a><a href="/pricing">Pricing</a><a href="/compare">Compare</a><a href="/open">Deliverability</a><a href="/try">Get a sample issue</a><a href="/changelog">Changelog</a></div>
    <div><h4>Developers</h4><a href="/docs">Docs</a><a href="/docs/api">REST API</a><a href="/docs/mcp-tools">MCP tools</a><a href="/docs/api-guide">API guide</a></div>
    <div><h4>Contact</h4>${o.contact ? `<a href="mailto:${esc(o.contact)}">${esc(o.contact)}</a>` : ''}<a href="/docs/support">Support</a></div>
  </div>
  <div class="base">© ${new Date().getFullYear()} ${PARENT.name}. ${BRAND}. Every product name on these pages belongs to its owner and is used only to name the product compared.</div>
</div></footer>
</body></html>`;
}

export const tick = (s: string) => `<li>${ic('check', 18)}<span>${s}</span></li>`;
