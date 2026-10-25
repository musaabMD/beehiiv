/** @jsxImportSource hono/jsx */
// Public publication website shell: theme tokens, global navbar/footer, signup + login modals, pop-ups, analytics.
import type { Child } from 'hono/jsx';
import { raw } from 'hono/html';
import type { Ctx, Publication } from '../types';
import { all } from '../lib/db';
import { settings, siteUrl } from '../lib/pub';
import { esc, parseJSON } from '../lib/util';
import { readFlash } from './components';

export interface Theme {
  font: string; heading_font: string; bg: string; surface: string; text: string; muted: string; accent: string; accent_text: string;
  border: string; radius: number; shadow: string; max_width: number; layout: 'classic' | 'magazine' | 'minimal'; header: 'left' | 'center';
  dark_mode: boolean; custom_css: string; hero_title: string; hero_subtitle: string; hero_image: string; show_hero: boolean;
}

export const DEFAULT_THEME: Theme = {
  font: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif', heading_font: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
  bg: '#ffffff', surface: '#f8fafc', text: '#111827', muted: '#6b7280', accent: '#f59e0b', accent_text: '#111827', border: '#e5e7eb', radius: 10,
  shadow: '0 1px 2px rgba(0,0,0,.05), 0 4px 12px rgba(0,0,0,.04)', max_width: 1080, layout: 'classic', header: 'left', dark_mode: false, custom_css: '',
  hero_title: '', hero_subtitle: '', hero_image: '', show_hero: true,
};

export function themeOf(pub: Publication): Theme {
  return { ...DEFAULT_THEME, ...parseJSON(pub.theme, {}) };
}

const GOOGLE_FONTS = ['Inter', 'Lora', 'Merriweather', 'Playfair Display', 'Source Serif 4', 'DM Sans', 'Space Grotesk', 'IBM Plex Sans', 'Libre Baskerville', 'Work Sans', 'Manrope', 'Fraunces', 'Roboto', 'Open Sans', 'Poppins'];

function fontLink(t: Theme): string {
  const fams = new Set<string>();
  for (const f of [t.font, t.heading_font]) {
    const first = f.split(',')[0].replace(/["']/g, '').trim();
    if (GOOGLE_FONTS.includes(first)) fams.add(first);
  }
  if (!fams.size) return '';
  return `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?${[...fams].map((f) => `family=${encodeURIComponent(f)}:wght@400;600;700;800`).join('&')}&display=swap">`;
}

export interface SiteProps {
  c: Ctx;
  title?: string;
  description?: string;
  image?: string | null;
  canonical?: string;
  noindex?: boolean;
  jsonld?: unknown;
  children?: Child;
  bodyClass?: string;
  head?: Child;
  hideChrome?: boolean;
  scripts?: string[];
}

export async function SiteLayout(p: SiteProps) {
  const { c } = p;
  const pub = c.get('pub');
  const t = themeOf(pub);
  const cfg = settings(pub);
  const base = siteUrl(c.env, pub);
  const reader = c.get('reader');
  const navLinks = await all<{ label: string; url: string; location: string }>(c.env, 'SELECT label, url, location FROM nav_links WHERE pub_id = ? ORDER BY position', pub.id);
  const header = navLinks.filter((n) => n.location === 'header');
  const footer = navLinks.filter((n) => n.location === 'footer');
  const navPages = await all<{ title: string; slug: string }>(c.env, `SELECT title, slug FROM pages WHERE pub_id = ? AND status = 'published' AND show_in_nav = 1 AND slug != '' ORDER BY created_at`, pub.id);
  const popup = parseJSON<any>(cfg.popup as any, null);
  const flash = readFlash(c);
  const title = p.title ? `${p.title} | ${pub.name}` : pub.name;
  const desc = p.description || (cfg.meta_description as string) || pub.description || `${pub.name} newsletter`;
  const href = (u: string) => (u.startsWith('/') ? base + u : u);
  const vars = `--font:${t.font};--hfont:${t.heading_font};--bg:${t.bg};--surface:${t.surface};--text:${t.text};--muted:${t.muted};--accent:${t.accent};--accent-text:${t.accent_text};--border:${t.border};--radius:${t.radius}px;--shadow:${t.shadow};--maxw:${t.max_width}px`;
  return (
    <>
      {raw('<!DOCTYPE html>')}
      <html lang={pub.language || 'en'}>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <title>{title}</title>
          <meta name="description" content={desc} />
          {p.canonical && <link rel="canonical" href={p.canonical} />}
          {p.noindex && <meta name="robots" content="noindex" />}
          {cfg.google_site_verification && <meta name="google-site-verification" content={String(cfg.google_site_verification)} />}
          {cfg.bing_site_verification && <meta name="msvalidate.01" content={String(cfg.bing_site_verification)} />}
          <meta name="theme-color" content={t.bg} />
          <meta property="og:title" content={p.title || pub.name} />
          <meta property="og:description" content={desc} />
          <meta property="og:site_name" content={pub.name} />
          <meta property="og:type" content={p.jsonld ? 'article' : 'website'} />
          {p.image && <meta property="og:image" content={p.image} />}
          <meta name="twitter:card" content={p.image ? 'summary_large_image' : 'summary'} />
          <link rel="alternate" type="application/rss+xml" title={pub.name} href={`${base}/feed.xml`} />
          <link rel="icon" href={pub.favicon_url || pub.logo_url || '/static/favicon.svg'} />
          {raw(fontLink(t))}
          <link rel="stylesheet" href="/static/site.css" />
          <style>{raw(`:root{${vars}}${t.dark_mode ? '@media(prefers-color-scheme:dark){:root{--bg:#0b0f17;--surface:#111827;--text:#e5e7eb;--muted:#9ca3af;--border:#1f2937}}' : ''}${(t.custom_css || '').replace(/<\/style/gi, '')}`)}</style>
          {p.jsonld && <script type="application/ld+json">{raw(JSON.stringify(p.jsonld).replace(/</g, '\\u003c'))}</script>}
          {cfg.ga_measurement_id && raw(`<script async src="https://www.googletagmanager.com/gtag/js?id=${esc(cfg.ga_measurement_id)}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${esc(cfg.ga_measurement_id)}');</script>`)}
          {p.head}
        </head>
        <body class={`site layout-${t.layout} header-${t.header} ${p.bodyClass || ''}`} data-base={base} data-pub={pub.id}>
          {!p.hideChrome && (
            <header class="s-header">
              <div class="s-wrap s-header-in">
                <a class="s-brand" href={base + '/'}>
                  {pub.logo_url && <img src={pub.logo_url} alt="" width="32" height="32" />}
                  <span>{pub.name}</span>
                </a>
                <nav class="s-nav">
                  <a href={base + '/archive'}>Archive</a>
                  {navPages.map((pg) => <a href={`${base}/${pg.slug}`}>{pg.title}</a>)}
                  {header.map((n) => <a href={href(n.url)}>{n.label}</a>)}
                </nav>
                <div class="s-actions">
                  {reader ? (
                    <a class="s-btn s-btn-ghost" href={base + '/account'}>Account</a>
                  ) : (
                    <button type="button" class="s-btn s-btn-ghost" data-modal="login">Log in</button>
                  )}
                  {!reader?.subscriber || reader.subscriber.status !== 'active' ? (
                    <button type="button" class="s-btn" data-modal="subscribe">Subscribe</button>
                  ) : !reader.premium ? (
                    <a class="s-btn" href={base + '/upgrade'}>Upgrade</a>
                  ) : null}
                </div>
              </div>
            </header>
          )}
          {flash && <div class={`s-flash s-flash-${flash.kind}`}>{flash.msg}</div>}
          <main class="s-main">{p.children}</main>
          {!p.hideChrome && (
            <footer class="s-footer">
              <div class="s-wrap s-footer-in">
                <div>
                  <strong>{pub.name}</strong>
                  <p class="s-muted">{pub.description}</p>
                </div>
                <nav>
                  {footer.map((n) => <a href={href(n.url)}>{n.label}</a>)}
                  <a href={base + '/archive'}>Archive</a>
                  <a href={base + '/feed.xml'}>RSS</a>
                  <a href={base + '/privacy'}>Privacy</a>
                  <a href={base + '/terms'}>Terms</a>
                </nav>
                <p class="s-muted s-small">© {new Date().getFullYear()} {pub.name}. Powered by <a href="https://lnkbase.com/beehiiv">OpenHive</a>.</p>
              </div>
            </footer>
          )}

          <dialog class="s-modal" id="m-subscribe">
            <button class="s-x" data-close aria-label="Close">✕</button>
            <h3>Subscribe to {pub.name}</h3>
            <p class="s-muted">{pub.description}</p>
            <SubscribeForm action={base + '/subscribe'} />
          </dialog>
          <dialog class="s-modal" id="m-login">
            <button class="s-x" data-close aria-label="Close">✕</button>
            <h3>Log in</h3>
            <p class="s-muted">We'll email you a secure, single-use login link.</p>
            <form method="post" action={base + '/login'} class="s-form">
              <input type="email" name="email" placeholder="you@example.com" required autocomplete="email" />
              <input type="hidden" name="next" value={new URL(c.req.url).pathname} />
              <button class="s-btn">Email me a login link</button>
            </form>
          </dialog>
          {popup?.enabled && !reader?.subscriber && (
            <dialog class="s-modal s-popup" id="m-popup" data-popup={JSON.stringify({ delay: popup.delay ?? 8, scroll: popup.scroll ?? 0, exit: !!popup.exit, frequency_days: popup.frequency_days ?? 7 })}>
              <button class="s-x" data-close aria-label="Close">✕</button>
              {popup.image && <img src={popup.image} alt="" class="s-popup-img" />}
              <h3>{popup.title || `Join ${pub.name}`}</h3>
              <p class="s-muted">{popup.body || pub.description}</p>
              <SubscribeForm action={base + '/subscribe'} source="popup" label={popup.button || 'Subscribe'} />
            </dialog>
          )}
          <script src="/static/site.js" defer></script>
          {(p.scripts || []).map((s) => <script src={s} defer></script>)}
        </body>
      </html>
    </>
  );
}

/** Standard subscribe form with honeypot + render timestamp (bot protection) and UTM passthrough. */
export const SubscribeForm = (p: { action: string; source?: string; label?: string; formId?: string; lists?: Array<{ id: string; name: string }>; compact?: boolean }) => (
  <form method="post" action={p.action} class={`s-form s-subscribe ${p.compact ? 's-compact' : ''}`} data-subscribe>
    <input type="email" name="email" placeholder="you@example.com" required autocomplete="email" />
    <input type="text" name="website" class="s-hp" tabindex={-1} autocomplete="off" aria-hidden="true" />
    <input type="hidden" name="_t" value={String(Date.now())} />
    <input type="hidden" name="source" value={p.source || 'website'} />
    {p.formId && <input type="hidden" name="form_id" value={p.formId} />}
    <input type="hidden" name="utm" value="" data-utm />
    {p.lists?.length ? (
      <fieldset class="s-lists">
        {p.lists.map((l) => <label><input type="checkbox" name="lists[]" value={l.id} checked /> {l.name}</label>)}
      </fieldset>
    ) : null}
    <button class="s-btn">{p.label || 'Subscribe'}</button>
  </form>
);

/** Simple centered message page on a publication site. */
export async function SiteMessage(c: Ctx, title: string, body: Child, status: 200 | 400 | 403 | 404 | 429 = 200) {
  return c.html(
    await SiteLayout({ c, title, noindex: true, children: <section class="s-wrap s-narrow s-message"><h1>{title}</h1><div>{body}</div></section> }),
    status,
  );
}
