/** @jsxImportSource hono/jsx */
// Link in bio: editor with live mobile preview + public /bio page on the publication's site/domain.
import type { App, Ctx } from '../../types';
import { all, one, run } from '../../lib/db';
import { requirePerm } from '../../lib/auth';
import { subscribe } from '../../lib/subscribers';
import { rateLimit, clientIP, botScore } from '../../lib/guard';
import { siteUrl } from '../../lib/pub';
import { trackView } from '../../lib/tracking';
import { DashLayout } from '../../ui/layout';
import { SiteMessage } from '../../ui/site';
import { Card, Btn, Field, Input, Textarea, Select, Toggle, back, Help, Copy, Grid, Stats, Stat, Code } from '../../ui/components';
import { now, form, str, num, parseJSON, esc, money } from '../../lib/util';

export const SOCIALS: Array<[string, string]> = [
  ['x', 'X (Twitter)'], ['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['youtube', 'YouTube'], ['linkedin', 'LinkedIn'], ['facebook', 'Facebook'], ['threads', 'Threads'],
  ['bluesky', 'Bluesky'], ['mastodon', 'Mastodon'], ['github', 'GitHub'], ['twitch', 'Twitch'], ['discord', 'Discord'], ['spotify', 'Spotify'], ['pinterest', 'Pinterest'],
  ['snapchat', 'Snapchat'], ['whatsapp', 'WhatsApp'], ['telegram', 'Telegram'], ['substack', 'Substack'], ['website', 'Website'], ['email', 'Email'],
];

const FONTS = ['Inter', 'DM Sans', 'Poppins', 'Manrope', 'Space Grotesk', 'Lora', 'Playfair Display', 'Fraunces', 'Merriweather', 'IBM Plex Sans'];

interface BioCfg {
  headline?: string; bio?: string; avatar?: string;
  theme?: { bg?: string; text?: string; button_bg?: string; button_text?: string; font?: string; button_style?: 'rounded' | 'pill' | 'square' | 'outline'; bg_gradient?: string };
  links?: Array<{ label: string; url: string; icon?: string }>;
  socials?: Record<string, string>;
  show_posts?: boolean; show_products?: boolean; show_tiers?: boolean; show_form?: boolean; form_label?: string;
}

const DEFAULT_CFG: BioCfg = { show_form: true, show_posts: true, show_products: true, show_tiers: true, theme: { bg: '#fff7ed', text: '#111827', button_bg: '#111827', button_text: '#ffffff', font: 'Inter', button_style: 'pill' }, links: [], socials: {} };

async function loadCfg(c: Ctx): Promise<{ cfg: BioCfg; views: number }> {
  const row = await one<{ config: string; views: number }>(c.env, 'SELECT config, views FROM link_in_bio WHERE pub_id = ?', c.get('pub').id);
  const cfg = { ...DEFAULT_CFG, ...parseJSON<BioCfg>(row?.config, {}) };
  cfg.theme = { ...DEFAULT_CFG.theme, ...(cfg.theme || {}) };
  return { cfg, views: row?.views || 0 };
}

const ICON_SVG: Record<string, string> = {
  x: '<path d="M4 4l16 16M20 4L4 20"/>', instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1"/>',
  tiktok: '<path d="M14 3v11a4 4 0 1 1-4-4M14 3c.5 3 2.5 5 6 5"/>', youtube: '<rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9l5 3-5 3z"/>',
  linkedin: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 10v7M8 7v.01M12 17v-4a2 2 0 0 1 4 0v4M12 10v7"/>', facebook: '<path d="M15 3h-3a4 4 0 0 0-4 4v3H6v4h2v7h4v-7h3l1-4h-4V7a1 1 0 0 1 1-1h2z"/>',
  github: '<path d="M9 19c-4 1.5-4-2-6-2.5M15 21v-3.5a3 3 0 0 0-1-2.5c3 0 6-2 6-5.5a4.5 4.5 0 0 0-1.3-3.2 4 4 0 0 0-.1-3.3s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6.2 0C6.6 2.7 5.6 3 5.6 3a4 4 0 0 0-.1 3.3A4.5 4.5 0 0 0 4.2 9.5c0 3.5 3 5.5 6 5.5a3 3 0 0 0-1 2.5V21"/>',
  email: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>', website: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
};
const icon = (k: string) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_SVG[k] || ICON_SVG.website}</svg>`;

function socialHref(k: string, v: string): string {
  if (/^https?:\/\//.test(v)) return v;
  const h = v.replace(/^@/, '');
  const map: Record<string, string> = { x: `https://x.com/${h}`, instagram: `https://instagram.com/${h}`, tiktok: `https://tiktok.com/@${h}`, youtube: `https://youtube.com/@${h}`, linkedin: `https://linkedin.com/in/${h}`, facebook: `https://facebook.com/${h}`, threads: `https://threads.net/@${h}`, bluesky: `https://bsky.app/profile/${h}`, github: `https://github.com/${h}`, twitch: `https://twitch.tv/${h}`, pinterest: `https://pinterest.com/${h}`, snapchat: `https://snapchat.com/add/${h}`, telegram: `https://t.me/${h}`, whatsapp: `https://wa.me/${h.replace(/\D/g, '')}`, spotify: v, discord: v, mastodon: v, substack: `https://${h}.substack.com`, email: `mailto:${v}`, website: `https://${h}` };
  return map[k] || v;
}

export function registerBio(dash: App, site: App) {
  dash.get('/bio', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const { cfg, views } = await loadCfg(c);
    const base = siteUrl(c.env, pub);
    const url = `${base}/bio`;
    const signups = await one<{ n: number }>(c.env, `SELECT COUNT(*) AS n FROM subscribers WHERE pub_id = ? AND source = 'linkinbio'`, pub.id);
    const t = cfg.theme || {};
    const links = cfg.links?.length ? cfg.links : [{ label: '', url: '', icon: '' }];
    return c.html(
      <DashLayout c={c} title="Link in bio" section="grow" sub="bio" scripts={['/static/grow-bio.js']} actions={<a class="btn btn-secondary" href={url} target="_blank">Open page ↗</a>}>
        <Stats>
          <Stat label="Page views" value={num(views)} />
          <Stat label="Signups from bio" value={num(signups?.n || 0)} />
          <Stat label="Conversion" value={views ? ((100 * (signups?.n || 0)) / views).toFixed(1) + '%' : '0%'} />
        </Stats>
        <style>{`@media(min-width:900px){.bio-split{grid-template-columns:minmax(0,1fr) 400px}}`}</style>
        <div class="split bio-split">
          <form method="post" action="/app/grow/bio" id="bio-form">
            <Card title="Profile">
              <Field label="Avatar">
                <div class="row"><img id="bio-avatar-preview" src={cfg.avatar || pub.logo_url || '/static/favicon.svg'} class="thumb" alt="" style="border-radius:50%" /><input type="hidden" name="avatar" id="bio-avatar" value={cfg.avatar || ''} /><input type="file" accept="image/*" class="input" data-bio-upload style="max-width:280px" /></div>
              </Field>
              <Field label="Headline"><Input name="headline" value={cfg.headline || pub.name} /></Field>
              <Field label="Bio"><Textarea name="bio" value={cfg.bio ?? pub.description} rows={2} /></Field>
            </Card>
            <Card title="Links" actions={<button type="button" class="btn btn-secondary btn-sm" data-add-link>+ Add link</button>}>
              <div id="bio-links" class="stack-sm">
                {links.map((l) => (
                  <div class="row bio-link" draggable="true">
                    <span class="muted" style="cursor:grab" title="Drag to reorder">⋮⋮</span>
                    <input class="input" name="link_label[]" value={l.label} placeholder="Label" style="flex:1" />
                    <input class="input" name="link_url[]" value={l.url} placeholder="https://…" style="flex:2" />
                    <button type="button" class="btn btn-ghost btn-sm" data-up>↑</button><button type="button" class="btn btn-ghost btn-sm" data-down>↓</button>
                    <button type="button" class="btn btn-ghost btn-sm" data-remove>✕</button>
                  </div>
                ))}
              </div>
            </Card>
            <Card title="Social links">
              <Grid cols={2}>
                {SOCIALS.map(([k, label]) => <Field label={label}><Input name={`social_${k}`} value={cfg.socials?.[k] || ''} placeholder={k === 'email' ? 'you@example.com' : '@handle or URL'} /></Field>)}
              </Grid>
            </Card>
            <Card title="Sections">
              <Toggle name="show_form" checked={cfg.show_form} label="Subscribe form" hint="Every visitor is a potential subscriber — signups are tagged with source “linkinbio”." />
              <Field label="Subscribe button label"><Input name="form_label" value={cfg.form_label || 'Subscribe'} /></Field>
              <Toggle name="show_posts" checked={cfg.show_posts} label="Latest posts" />
              <Toggle name="show_products" checked={cfg.show_products} label="Digital products" />
              <Toggle name="show_tiers" checked={cfg.show_tiers} label="Paid subscription tiers" />
            </Card>
            <Card title="Design">
              <Grid cols={2}>
                <Field label="Background"><Input name="bg" type="color" value={t.bg} /></Field>
                <Field label="Text"><Input name="text" type="color" value={t.text} /></Field>
                <Field label="Button background"><Input name="button_bg" type="color" value={t.button_bg} /></Field>
                <Field label="Button text"><Input name="button_text" type="color" value={t.button_text} /></Field>
                <Field label="Font"><Select name="font" value={t.font} options={FONTS} /></Field>
                <Field label="Button style"><Select name="button_style" value={t.button_style} options={[['pill', 'Pill'], ['rounded', 'Rounded'], ['square', 'Square'], ['outline', 'Outline']]} /></Field>
              </Grid>
              <Field label="Background gradient (optional CSS)" hint="e.g. linear-gradient(160deg,#fde68a,#fca5a5)"><Input name="bg_gradient" value={t.bg_gradient} /></Field>
            </Card>
            <div class="form-actions"><Btn>Save & publish</Btn></div>
          </form>
          <div style="position:sticky;top:80px">
            <Card title="Live preview" actions={<button type="button" class="btn btn-ghost btn-sm" data-refresh-preview>Refresh</button>}>
              <div style="width:360px;max-width:100%;height:700px;margin:0 auto;border:10px solid #111;border-radius:36px;overflow:hidden;background:#fff;box-sizing:border-box">
                <iframe id="bio-preview" src={`${url}?preview=1`} style="width:100%;height:100%;border:0" title="Preview" />
              </div>
            </Card>
            <Card title="Use it everywhere">
              <Field label="Your link in bio"><Copy value={url} /></Field>
              <Field label="Linktree" hint="In Linktree, add a link with this URL; signups are attributed to Linktree."><Copy value={`${url}?utm_source=linktree&utm_medium=social`} /></Field>
              <Field label="Embed snippet" hint="Paste into any site (WordPress, Webflow…)"><Code>{`<iframe src="${url}?embed=1" style="width:100%;max-width:420px;height:720px;border:0" loading="lazy"></iframe>`}</Code></Field>
              <Help>Hosted on your publication's site{pub.custom_domain ? ` (${pub.custom_domain})` : ''}. Visits appear in Analytics → Website traffic.</Help>
            </Card>
          </div>
        </div>
      </DashLayout>,
    );
  });

  dash.post('/bio', requirePerm('manage'), async (c) => {
    const f = await form(c.req);
    const labels: string[] = f.link_label || [], urls: string[] = f.link_url || [];
    const links = labels.map((label, i) => ({ label: str(label, 80), url: str(urls[i], 500) })).filter((l) => l.label && /^(https?:\/\/|mailto:|\/)/.test(l.url)).slice(0, 30);
    const socials: Record<string, string> = {};
    for (const [k] of SOCIALS) { const v = str(f[`social_${k}`], 300); if (v) socials[k] = v; }
    const cfg: BioCfg = {
      headline: str(f.headline, 120), bio: str(f.bio, 400), avatar: str(f.avatar, 500) || undefined, links, socials,
      show_form: !!f.show_form, show_posts: !!f.show_posts, show_products: !!f.show_products, show_tiers: !!f.show_tiers, form_label: str(f.form_label, 40) || 'Subscribe',
      theme: { bg: str(f.bg, 20), text: str(f.text, 20), button_bg: str(f.button_bg, 20), button_text: str(f.button_text, 20), font: FONTS.includes(f.font) ? f.font : 'Inter', button_style: ['pill', 'rounded', 'square', 'outline'].includes(f.button_style) ? f.button_style : 'pill', bg_gradient: str(f.bg_gradient, 200).replace(/[;{}<>]/g, '') || undefined },
    };
    await run(c.env, `INSERT INTO link_in_bio (pub_id, config, views, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(pub_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`, c.get('pub').id, JSON.stringify(cfg), now());
    return back(c, '/app/grow/bio', 'Link in bio published');
  });

  site.get('/bio', async (c) => {
    const pub = c.get('pub');
    const base = siteUrl(c.env, pub);
    const { cfg } = await loadCfg(c);
    const preview = !!c.req.query('preview');
    if (!preview) {
      await trackView(c, 'bio');
      c.executionCtx.waitUntil(run(c.env, `INSERT INTO link_in_bio (pub_id, config, views, updated_at) VALUES (?, '{}', 1, ?) ON CONFLICT(pub_id) DO UPDATE SET views = views + 1`, pub.id, now()));
    }
    const [posts, products, tiers] = await Promise.all([
      cfg.show_posts ? all<any>(c.env, `SELECT slug, title, thumbnail_url, audience FROM posts WHERE pub_id = ? AND status = 'published' AND platform != 'email' AND hide_from_feed = 0 ORDER BY published_at DESC LIMIT 4`, pub.id) : [],
      cfg.show_products ? all<any>(c.env, `SELECT slug, name, price_cents, currency, cover_url FROM products WHERE pub_id = ? AND status = 'active' ORDER BY sales_count DESC, created_at DESC LIMIT 4`, pub.id) : [],
      cfg.show_tiers ? all<any>(c.env, `SELECT name, monthly_cents, currency FROM tiers WHERE pub_id = ? AND status = 'active' ORDER BY position LIMIT 3`, pub.id) : [],
    ]);
    const t = cfg.theme || {};
    const radius = t.button_style === 'pill' ? '999px' : t.button_style === 'square' ? '4px' : '14px';
    const outline = t.button_style === 'outline';
    const reader = c.get('reader');
    const subscribed = c.req.query('subscribed') || reader?.subscriber?.status === 'active';
    const fontQ = encodeURIComponent(t.font || 'Inter');
    const css = `:root{--bg:${t.bg};--text:${t.text};--bb:${t.button_bg};--bt:${t.button_text};--r:${radius}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:${t.bg_gradient || 'var(--bg)'};color:var(--text);font-family:'${(t.font || 'Inter').replace(/'/g, '')}',-apple-system,BlinkMacSystemFont,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:520px;margin:0 auto;padding:40px 18px 32px;text-align:center}
.av{width:96px;height:96px;border-radius:50%;object-fit:cover;box-shadow:0 4px 18px rgba(0,0,0,.12)}
h1{font-size:24px;margin:14px 0 6px}p.bio{opacity:.8;margin:0 0 18px;line-height:1.5}
.socials{display:flex;justify-content:center;gap:12px;flex-wrap:wrap;margin:0 0 22px}.socials a{color:var(--text);opacity:.85;display:grid;place-items:center;width:36px;height:36px}
.btn{display:block;width:100%;padding:15px 18px;margin:0 0 12px;border-radius:var(--r);background:${outline ? 'transparent' : 'var(--bb)'};color:${outline ? 'var(--text)' : 'var(--bt)'};border:2px solid var(--bb);text-decoration:none;font-weight:650;font-size:16px;transition:transform .1s}.btn:hover{transform:scale(1.02)}
form{display:flex;flex-direction:column;gap:8px;margin:0 0 22px;padding:16px;border-radius:18px;background:rgba(255,255,255,.55)}form input[type=email]{height:48px;border-radius:var(--r);border:1px solid rgba(0,0,0,.15);padding:0 16px;font:inherit;font-size:16px}form button{height:48px;border:0;border-radius:var(--r);background:var(--bb);color:var(--bt);font:inherit;font-weight:700;font-size:16px;cursor:pointer}
.hp{position:absolute;left:-9999px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;opacity:.65;margin:26px 0 12px}
.card{display:flex;gap:12px;align-items:center;text-align:left;padding:10px;border-radius:14px;background:rgba(255,255,255,.6);margin:0 0 10px;text-decoration:none;color:var(--text)}.card img{width:56px;height:56px;border-radius:10px;object-fit:cover;flex:none}.card small{display:block;opacity:.7}
.ok{padding:14px;border-radius:14px;background:rgba(16,185,129,.15);margin:0 0 20px;font-weight:600}footer{font-size:12px;opacity:.55;margin-top:28px}footer a{color:inherit}`;
    const html = `<!DOCTYPE html><html lang="${esc(pub.language || 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(cfg.headline || pub.name)}</title>
<meta name="description" content="${esc(cfg.bio || pub.description)}"><meta property="og:title" content="${esc(cfg.headline || pub.name)}"><meta property="og:image" content="${esc(cfg.avatar || pub.logo_url || '')}">
<link rel="icon" href="${esc(pub.favicon_url || pub.logo_url || '/static/favicon.svg')}"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${fontQ}:wght@400;650;700&display=swap"><style>${css}</style></head><body><main>
<img class="av" src="${esc(cfg.avatar || pub.logo_url || '/static/favicon.svg')}" alt="">
<h1>${esc(cfg.headline || pub.name)}</h1><p class="bio">${esc(cfg.bio ?? pub.description)}</p>
${Object.keys(cfg.socials || {}).length ? `<nav class="socials">${Object.entries(cfg.socials || {}).map(([k, v]) => `<a href="${esc(socialHref(k, v))}" target="_blank" rel="noopener me" aria-label="${esc(k)}" title="${esc(k)}">${icon(k)}</a>`).join('')}</nav>` : ''}
${cfg.show_form ? (subscribed ? `<div class="ok">✓ You're subscribed to ${esc(pub.name)}</div>` : `<form method="post" action="${esc(base)}/bio/subscribe"><input type="email" name="email" placeholder="you@example.com" required autocomplete="email"><input type="text" name="website" class="hp" tabindex="-1" autocomplete="off"><input type="hidden" name="_t" value="${Date.now()}"><button>${esc(cfg.form_label || 'Subscribe')}</button></form>`) : ''}
${(cfg.links || []).map((l) => `<a class="btn" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join('')}
${tiers.length ? `<h2>Membership</h2>${tiers.map((t) => `<a class="btn" href="${esc(base)}/upgrade?utm_source=linkinbio">${esc(t.name)}${t.monthly_cents ? ` — ${esc(money(t.monthly_cents, t.currency))}/mo` : ''}</a>`).join('')}` : ''}
${products.length ? `<h2>Shop</h2>${products.map((p) => `<a class="card" href="${esc(base)}/shop/${esc(p.slug)}?utm_source=linkinbio">${p.cover_url ? `<img src="${esc(p.cover_url)}" alt="">` : ''}<span><strong>${esc(p.name)}</strong><small>${p.price_cents ? esc(money(p.price_cents, p.currency)) : 'Free'}</small></span></a>`).join('')}` : ''}
${posts.length ? `<h2>Latest posts</h2>${posts.map((p) => `<a class="card" href="${esc(base)}/p/${esc(p.slug)}?utm_source=linkinbio">${p.thumbnail_url ? `<img src="${esc(p.thumbnail_url)}" alt="">` : ''}<span><strong>${esc(p.title)}</strong>${p.audience === 'premium' ? '<small>🔒 Premium</small>' : ''}</span></a>`).join('')}` : ''}
<footer><a href="${esc(base)}/">${esc(pub.name)}</a> · Powered by OpenHive</footer></main></body></html>`;
    return c.html(html);
  });

  site.post('/bio/subscribe', async (c) => {
    const pub = c.get('pub');
    const base = siteUrl(c.env, pub);
    const f = await form(c.req);
    const ip = clientIP(c.req.raw);
    if (!(await rateLimit(c.env, `bio:${ip}`, 10, 600))) return SiteMessage(c, 'Too many requests', <p>Please try again in a few minutes.</p>, 429);
    if (botScore({ honeypot: f.website, renderedAt: f._t, ua: c.req.header('user-agent') }) >= 60) return SiteMessage(c, 'Something went wrong', <p>We couldn't verify this signup.</p>, 400);
    const utm = parseJSON<Record<string, string>>(str(f.utm, 1000), {});
    const r = await subscribe(c.env, pub, { email: str(f.email, 254), source: 'linkinbio', utm: { source: utm.utm_source || 'linkinbio', medium: utm.utm_medium || 'social', campaign: utm.utm_campaign }, ip, country: (c.req.raw as any).cf?.country ?? null, referrer: c.req.header('referer') || null, landingPath: '/bio', strict: true });
    if (!r.ok) return SiteMessage(c, "We couldn't subscribe you", <><p>{r.error}</p><p><a href={base + '/bio'}>← Back</a></p></>, 400);
    if (r.pending) return SiteMessage(c, 'Check your inbox', <p>Confirm your email to finish subscribing to {pub.name}.</p>);
    return c.redirect(`${base}/bio?subscribed=1`, 303);
  });
}
