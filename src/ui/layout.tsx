/** @jsxImportSource hono/jsx */
import type { Child } from 'hono/jsx';
import { raw } from 'hono/html';
import type { Ctx } from '../types';
import { siteUrl } from '../lib/pub';
import { can } from '../lib/auth';
import { isSuperadmin } from '../lib/plans';
import { readFlash } from './components';
import { icon } from './icons';

export interface NavItem { key: string; label: string; href: string; icon: string; perm?: 'admin' | 'manage' | 'draft'; sub?: Array<[string, string, string?]> }

/** Primary navigation. Sub entries: [key, label, href]. */
export const NAV: NavItem[] = [
  { key: 'home', label: 'Home', href: '/app', icon: 'home' },
  { key: 'posts', label: 'Posts', href: '/app/posts', icon: 'pen', perm: 'draft', sub: [['posts', 'All posts', '/app/posts'], ['templates', 'Templates', '/app/posts/templates'], ['rss', 'RSS to send', '/app/posts/rss'], ['media', 'Media library', '/app/posts/media'], ['tags', 'Content tags', '/app/posts/tags']] },
  { key: 'audience', label: 'Audience', href: '/app/audience', icon: 'users', perm: 'manage', sub: [['subscribers', 'Subscribers', '/app/audience'], ['segments', 'Segments', '/app/audience/segments'], ['conditions', 'Condition sets', '/app/audience/conditions'], ['lists', 'Newsletter lists', '/app/audience/lists'], ['fields', 'Custom fields', '/app/audience/fields'], ['forms', 'Subscribe forms', '/app/audience/forms'], ['surveys', 'Surveys', '/app/audience/surveys'], ['polls', 'Polls', '/app/audience/polls'], ['inbox', 'Inbox', '/app/audience/inbox'], ['imports', 'Import & export', '/app/audience/imports']] },
  { key: 'automations', label: 'Automations', href: '/app/automations', icon: 'bolt', perm: 'draft' },
  { key: 'website', label: 'Website', href: '/app/website', icon: 'globe', perm: 'manage', sub: [['pages', 'Pages', '/app/website'], ['theme', 'Theme & layout', '/app/website/theme'], ['nav', 'Navigation', '/app/website/nav'], ['popups', 'Pop-ups & gating', '/app/website/popups'], ['redirects', 'Redirects', '/app/website/redirects'], ['seo', 'SEO & crawlers', '/app/website/seo'], ['templates', 'Saved blocks & pages', '/app/website/templates']] },
  { key: 'grow', label: 'Grow', href: '/app/grow', icon: 'trend', perm: 'manage', sub: [['referrals', 'Referral program', '/app/grow'], ['recommendations', 'Recommendations', '/app/grow/recommendations'], ['boosts', 'Boosts', '/app/grow/boosts'], ['links', 'Magic links', '/app/grow/links'], ['bio', 'Link in bio', '/app/grow/bio']] },
  { key: 'monetize', label: 'Monetize', href: '/app/monetize', icon: 'dollar', perm: 'manage', sub: [['tiers', 'Paid subscriptions', '/app/monetize'], ['offers', 'Offers & codes', '/app/monetize/offers'], ['products', 'Digital products', '/app/monetize/products'], ['orders', 'Orders', '/app/monetize/orders'], ['ads', 'Ad network', '/app/monetize/ads'], ['sponsors', 'Sponsorships', '/app/monetize/sponsorships'], ['wallet', 'Wallet & payouts', '/app/monetize/wallet']] },
  { key: 'marketing', label: 'Marketing', href: '/app/calendar', icon: 'link', perm: 'manage', sub: [['calendar', 'Calendar', '/app/calendar'], ['campaigns', 'Campaigns', '/app/campaigns'], ['social', 'Social posts', '/app/social'], ['adaudiences', 'Ad audiences', '/app/ad-audiences']] },
  { key: 'podcasts', label: 'Podcasts', href: '/app/podcasts', icon: 'mic', perm: 'manage' },
  { key: 'events', label: 'Events', href: '/app/events', icon: 'calendar', perm: 'manage' },
  { key: 'community', label: 'Community', href: '/app/community', icon: 'chat', perm: 'manage' },
  { key: 'analytics', label: 'Analytics', href: '/app/analytics', icon: 'chart', perm: 'manage', sub: [['overview', 'Overview', '/app/analytics'], ['posts', 'Post performance', '/app/analytics/posts'], ['web', 'Website traffic', '/app/analytics/web'], ['bots', 'Bots & AI crawlers', '/app/analytics/bots'], ['subscribers', 'Subscriber growth', '/app/analytics/subscribers'], ['deliverability', 'Deliverability', '/app/analytics/deliverability'], ['revenue', 'Revenue', '/app/analytics/revenue'], ['podcasts', 'Podcasts', '/app/analytics/podcasts'], ['reports', 'Custom reports', '/app/analytics/reports'], ['explore', '3D explorer', '/app/analytics/explore']] },
  { key: 'settings', label: 'Settings', href: '/app/settings', icon: 'gear', sub: [['publication', 'Publication', '/app/settings'], ['team', 'Team', '/app/settings/team'], ['authors', 'Authors', '/app/settings/authors'], ['email', 'Email & senders', '/app/settings/email'], ['domains', 'Domains', '/app/settings/domains'], ['integrations', 'Integrations', '/app/settings/integrations'], ['api', 'API keys & MCP', '/app/settings/api'], ['transactional', 'Transactional email', '/app/settings/transactional'], ['commerce', 'Store integrations', '/app/settings/commerce'], ['webhooks', 'Webhooks', '/app/settings/webhooks'], ['plan', 'Plan & usage', '/app/settings/plan'], ['billing', 'Payments & billing', '/app/settings/billing'], ['workspace', 'Workspace', '/app/settings/workspace'], ['audit', 'Audit log', '/app/settings/audit'], ['monitoring', 'Monitoring', '/app/settings/monitoring'], ['profile', 'My profile', '/app/settings/profile']] },
];

/** Installable app (PWA): manifest, icons, theme colour. The service worker (public/sw.js) caches static assets
 *  and an offline page only — dashboard HTML (private data) is never cached. */
export const PwaHead = () => (
  <>
    <link rel="manifest" href="/manifest.webmanifest" />
    <meta name="theme-color" content="#1c1917" />
    <link rel="apple-touch-icon" href="/static/icons/apple-touch-icon.png" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="Lnkbase" />
  </>
);
export const PwaRegister = () => (
  <script dangerouslySetInnerHTML={{ __html: `if('serviceWorker' in navigator&&location.protocol!=='file:'){addEventListener('load',function(){navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(function(){})})}` }} />
);

export interface LayoutProps {
  c: Ctx;
  title: string;
  section: string;
  sub?: string;
  actions?: Child;
  children?: Child;
  wide?: boolean;
  head?: Child;
  scripts?: string[];
  styles?: string[];
  crumbs?: Array<[string, string]>;
  bare?: boolean; // full-bleed (editor)
}

export function DashLayout(p: LayoutProps) {
  const { c } = p;
  const user = c.get('user');
  const pub = c.get('pub');
  const pubs = c.get('pubs') || [];
  const role = c.get('role');
  const flash = readFlash(c);
  const nav = NAV.filter((n) => !n.perm || can(role, n.perm));
  const cur = NAV.find((n) => n.key === p.section);
  const palette = [
    ...NAV.flatMap((n) => [[n.label, n.href], ...(n.sub || []).map(([, l, h]) => [`${n.label} › ${l}`, h || n.href])]),
    ['New post', '/app/posts/new'], ['Add subscriber', '/app/audience?add=1'], ['New automation', '/app/automations/new'], ['New segment', '/app/audience/segments/new'],
    ['New product', '/app/monetize/products/new'], ['New event', '/app/events/new'], ['New podcast episode', '/app/podcasts'], ['View website', pub ? siteUrl(c.env, pub) : '/'],
    ...pubs.map((x) => [`Switch to ${x.name}`, `/app?pub=${x.id}`]),
  ];
  return (
    <>
      {raw('<!DOCTYPE html>')}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <title>{`${p.title} · ${pub?.name || c.env.APP_NAME}`}</title>
          <link rel="icon" href="/static/favicon.svg" />
          <PwaHead />
          <link rel="stylesheet" href="/static/app.css" />
          {(p.styles || []).map((s) => <link rel="stylesheet" href={s} />)}
          {p.head}
        </head>
        <body class={`dash ${p.bare ? 'dash-bare' : ''}`}>
          <aside class="side" id="side">
            <div class="side-top">
              <details class="pubswitch">
                <summary>
                  <span class="pub-logo">{pub?.logo_url ? <img src={pub.logo_url} alt="" /> : (pub?.name || '?').slice(0, 1)}</span>
                  <span class="pub-name">{pub?.name || 'No publication'}</span>
                  {raw(icon('chev'))}
                </summary>
                <div class="pubswitch-menu">
                  {pubs.map((x) => (
                    <a href={`/app?pub=${x.id}`} class={x.id === pub?.id ? 'on' : ''}>
                      <span class="pub-logo sm">{x.name.slice(0, 1)}</span>{x.name}<small>{x.role}</small>
                    </a>
                  ))}
                  <a href="/app/onboarding?new=1" class="add">+ New publication</a>
                </div>
              </details>
            </div>
            <button type="button" class="side-search" data-palette>
              {raw(icon('search'))}<span>Search</span><kbd>⌘K</kbd>
            </button>
            <nav class="side-nav">
              {nav.map((n) => (
                <a href={n.href} class={n.key === p.section ? 'on' : ''}>
                  {raw(icon(n.icon))}<span>{n.label}</span>
                </a>
              ))}
            </nav>
            <div class="side-bottom">
              <button type="button" class="side-ai" data-ai>{raw(icon('spark'))}<span>Ask AI</span><kbd>⌘J</kbd></button>
              {pub && <a href={siteUrl(c.env, pub)} target="_blank" class="side-link">{raw(icon('external'))}<span>View site</span></a>}
              <details class="usermenu">
                <summary><span class="avatar">{(user?.name || user?.email || '?').slice(0, 1).toUpperCase()}</span><span class="u-name">{user?.name || user?.email}</span></summary>
                <div class="usermenu-menu">
                  <a href="/app/settings/profile">My profile</a>
                  <a href="/app/settings/workspace">Workspace</a>
                  <a href="/app/settings/plan">Plan &amp; usage</a>
                  {isSuperadmin(c.env, user) && <a href="/app/admin">Platform admin</a>}
                  <a href="/docs" target="_blank">Docs</a>
                  <form method="post" action="/logout"><button type="submit">Sign out</button></form>
                </div>
              </details>
            </div>
          </aside>
          <div class="main">
            <header class="top">
              <button type="button" class="menu-btn" data-toggle-side aria-label="Menu">{raw(icon('menu'))}</button>
              <div class="top-title">
                {p.crumbs && (
                  <div class="crumbs">{p.crumbs.map(([h, l]) => <><a href={h}>{l}</a><span>/</span></>)}</div>
                )}
                <h1>{p.title}</h1>
              </div>
              <div class="top-actions">{p.actions}</div>
            </header>
            {cur?.sub && !p.bare && (
              <nav class="subnav">
                {cur.sub.map(([k, l, h]) => <a href={h || cur.href} class={k === p.sub ? 'on' : ''}>{l}</a>)}
              </nav>
            )}
            {flash && <div class={`flash flash-${flash.kind}`} role="status">{flash.msg}</div>}
            <main class={`content ${p.wide ? 'wide' : ''}`}>{p.children}</main>
          </div>

          <dialog id="palette" class="palette">
            <input type="text" placeholder="Jump to… (type to search)" autocomplete="off" />
            <ul />
          </dialog>
          <aside id="ai-drawer" class="ai-drawer" hidden>
            <header><strong>{raw(icon('spark'))} AI assistant</strong><button type="button" class="btn btn-ghost btn-sm" data-ai-close>✕</button></header>
            <div class="ai-log" />
            <form class="ai-form">
              <textarea name="q" rows={3} placeholder="Ask anything: draft a post, suggest subject lines, summarize stats, build a segment…" />
              <div class="row"><button class="btn btn-primary btn-sm">Ask</button><small class="muted">⌘J to toggle · ⌘↵ to send</small></div>
            </form>
          </aside>
          <script type="application/json" id="palette-data">{raw(JSON.stringify(palette).replace(/</g, '\\u003c'))}</script>
          <script src="/static/app.js" defer></script>
          {(p.scripts || []).map((s) => <script src={s} defer></script>)}
          <PwaRegister />
        </body>
      </html>
    </>
  );
}

/** Minimal centered layout for auth / onboarding / simple public pages. */
export function PlainLayout(p: { title: string; children?: Child; wide?: boolean; c?: Ctx; head?: Child }) {
  const flash = p.c ? readFlash(p.c) : null;
  return (
    <>
      {raw('<!DOCTYPE html>')}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <title>{p.title}</title>
          <link rel="icon" href="/static/favicon.svg" />
          <PwaHead />
          <link rel="stylesheet" href="/static/app.css" />
          {p.head}
        </head>
        <body class="plain">
          <main class={`plain-box ${p.wide ? 'wide' : ''}`}>
            <a href="/" class="plain-logo"><img src="/static/favicon.svg" alt="" width="28" height="28" /> Lnkbase Newsletter</a>
            {flash && <div class={`flash flash-${flash.kind}`}>{flash.msg}</div>}
            {p.children}
          </main>
          <script src="/static/app.js" defer></script>
          <PwaRegister />
        </body>
      </html>
    </>
  );
}
