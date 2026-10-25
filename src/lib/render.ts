// Document renderer: one editor doc → web HTML and table-based, inline-styled email HTML.
// Block schema is documented in docs/ARCHITECTURE.md ("Editor document").
import type { Env, Publication, Post, Subscriber } from '../types';
import { all, one } from './db';
import { inline, sanitizeHtml } from './sanitize';
import { esc, parseJSON, slugify, stripTags, fmtDate } from './util';
import { fillSlot, autoInsert } from './programmatic';

export interface Block { id?: string; type: string; data: any }
export interface Doc { blocks: Block[] }

export interface StyleTokens {
  font: string; heading_font: string; text: string; muted: string; bg: string; content_bg: string; accent: string; link: string;
  button_bg: string; button_text: string; radius: number; width: number; font_size: number; line_height: number; spacing: number; border: string;
}

export const DEFAULT_STYLE: StyleTokens = {
  font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
  heading_font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
  text: '#1f2328', muted: '#6b7280', bg: '#f4f4f5', content_bg: '#ffffff', accent: '#f59e0b', link: '#b45309',
  button_bg: '#111827', button_text: '#ffffff', radius: 8, width: 640, font_size: 17, line_height: 1.6, spacing: 16, border: '#e5e7eb',
};

export function styleFor(pub: Publication, ...overrides: Array<string | Record<string, any> | null | undefined>): StyleTokens {
  let s: StyleTokens = { ...DEFAULT_STYLE, ...parseJSON(pub.email_style, {}) };
  for (const o of overrides) {
    const obj: any = typeof o === 'string' ? parseJSON(o, {}) : o || {};
    s = { ...s, ...(obj.email && typeof obj.email === 'object' ? obj.email : obj) };
  }
  return s;
}

export interface RenderCtx {
  env: Env;
  mode: 'email' | 'web';
  pub: Publication;
  siteUrl: string;            // publication website base, no trailing slash
  post?: Post | null;
  subscriber?: Subscriber | null;
  tags?: string[];
  segmentIds?: Set<string>;
  /** viewer can see premium content */
  access: boolean;
  style?: StyleTokens;
  /** delivery id for one-click poll links */
  deliveryId?: string | null;
  /** editor preview: show everything incl. hidden dynamic sections with labels */
  preview?: boolean;
  /** leave {{merge}} tags in place (sender renders once, merges per recipient) */
  skipMerge?: boolean;
  /** random cohort name for cohort tests */
  cohort?: string | null;
}

export interface Rendered { html: string; text: string; bytes: number; paywalled: boolean; headings: Array<{ id: string; text: string; level: number }>; }

// ───────── merge tags ─────────
export function mergeVars(pub: Publication, sub: Subscriber | null | undefined, siteUrl: string, extra: Record<string, string> = {}): Record<string, string> {
  const custom = parseJSON<Record<string, any>>(sub?.custom, {});
  const name = sub?.name || '';
  const v: Record<string, string> = {
    'subscriber.email': sub?.email || 'reader@example.com',
    'subscriber.name': name,
    'subscriber.first_name': name.split(' ')[0] || '',
    'subscriber.last_name': name.split(' ').slice(1).join(' '),
    'subscriber.tier': sub?.tier || 'free',
    'subscriber.referral_count': String(sub?.referral_count ?? 0),
    'subscriber.created_at': sub ? fmtDate(sub.created_at) : '',
    'referral_url': sub ? `${siteUrl}/subscribe?ref=${sub.referral_code}` : `${siteUrl}/subscribe`,
    'referral_count': String(sub?.referral_count ?? 0),
    'publication.name': pub.name,
    'publication.url': siteUrl,
    'date': fmtDate(Date.now(), { dateStyle: 'long' }, pub.timezone),
    'year': String(new Date().getFullYear()),
    ...extra,
  };
  for (const [k, val] of Object.entries(custom)) v['custom.' + k] = String(val ?? '');
  return v;
}

/** Replace {{tag}} and {{tag|fallback}}. Values are HTML-escaped. */
export function applyMerge(s: string, vars: Record<string, string>, escape = true): string {
  return s.replace(/\{\{\s*([a-z0-9_.]+)\s*(?:\|\s*([^}]*?))?\s*\}\}/gi, (_, key: string, fb: string | undefined) => {
    const val = vars[key.toLowerCase()] ?? vars[key];
    const out = val && val.length ? val : fb ?? '';
    return escape ? esc(out) : out;
  });
}

// ───────── embeds ─────────
export function parseEmbed(url: string): { provider: string; id: string; url: string } | null {
  const u = url.trim();
  let m;
  if ((m = u.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/))) return { provider: 'youtube', id: m[1], url: u };
  if ((m = u.match(/(?:twitter|x)\.com\/[^/]+\/status\/(\d+)/))) return { provider: 'x', id: m[1], url: u };
  if ((m = u.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/))) return { provider: 'tiktok', id: m[1], url: u };
  if ((m = u.match(/instagram\.com\/(?:p|reel|tv)\/([\w-]+)/))) return { provider: 'instagram', id: m[1], url: u };
  if ((m = u.match(/bsky\.app\/profile\/([^/]+)\/post\/([\w]+)/))) return { provider: 'bluesky', id: `${m[1]}/${m[2]}`, url: u };
  if ((m = u.match(/stocktwits\.com\/[^/]+\/message\/(\d+)/))) return { provider: 'stocktwits', id: m[1], url: u };
  if ((m = u.match(/open\.spotify\.com\/(episode|show|track|playlist)\/(\w+)/))) return { provider: 'spotify', id: `${m[1]}/${m[2]}`, url: u };
  if ((m = u.match(/vimeo\.com\/(\d+)/))) return { provider: 'vimeo', id: m[1], url: u };
  if ((m = u.match(/podcasts\.apple\.com\/(.+)/))) return { provider: 'apple_podcasts', id: m[1], url: u };
  if ((m = u.match(/loom\.com\/share\/(\w+)/))) return { provider: 'loom', id: m[1], url: u };
  return null;
}

const PROVIDER_LABEL: Record<string, string> = { youtube: 'YouTube', x: 'X', tiktok: 'TikTok', instagram: 'Instagram', bluesky: 'Bluesky', stocktwits: 'Stocktwits', spotify: 'Spotify', vimeo: 'Vimeo', apple_podcasts: 'Apple Podcasts', loom: 'Loom' };

// Bluesky: embed.bsky.app needs the author's DID, not the handle. Resolve once per isolate (cached) and
// persist it on the block at save time (`data.did`) so renders normally need no network round trip.
const didCache = new Map<string, { did: string | null; at: number }>();
export async function resolveBlueskyDid(handle: string): Promise<string | null> {
  const h = decodeURIComponent(handle).trim().toLowerCase().replace(/^@/, '');
  if (!h) return null;
  if (/^did:[a-z]+:[\w.:%-]+$/.test(h)) return h;
  const hit = didCache.get(h);
  if (hit && Date.now() - hit.at < (hit.did ? 86_400_000 : 300_000)) return hit.did;
  let did: string | null = null;
  try {
    const r = await fetch(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(h)}`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) { const j: any = await r.json(); if (typeof j.did === 'string' && /^did:[a-z]+:[\w.:%-]+$/i.test(j.did)) did = j.did; }
  } catch { /* network error / timeout → link card fallback */ }
  didCache.set(h, { did, at: Date.now() });
  return did;
}

/** Bluesky/Stocktwits author handle (from the URL) for link cards. */
function embedAuthor(e: { provider: string; url: string }): string {
  const m = e.provider === 'bluesky' ? e.url.match(/bsky\.app\/profile\/([^/?#]+)/) : e.provider === 'stocktwits' ? e.url.match(/stocktwits\.com\/([^/?#]+)\/message/) : null;
  if (!m) return '';
  let h = m[1];
  try { h = decodeURIComponent(h); } catch {}
  return h.startsWith('did:') ? '' : '@' + h.replace(/^@/, '');
}

function webLinkCard(e: { provider: string; url: string }, caption: string): string {
  const label = PROVIDER_LABEL[e.provider] || 'Link';
  const who = embedAuthor(e);
  const what = e.provider === 'stocktwits' ? 'message' : 'post';
  return `<figure class="oh-figure"><a class="oh-linkcard oh-linkcard-${esc(e.provider)}" href="${esc(e.url)}" target="_blank" rel="noopener" style="display:block;max-width:550px;margin:0 auto;padding:14px 16px;border:1px solid var(--border,#e5e7eb);border-radius:12px;text-decoration:none;color:inherit;text-align:left"><strong>${who ? `${esc(who)}’s ${what} on ${label}` : `View on ${label}`} →</strong><br><small style="opacity:.7;word-break:break-all">${esc(e.url)}</small></a>${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`;
}

function webEmbed(e: { provider: string; id: string; url: string; did?: string | null }, caption: string): string {
  const frame = (src: string, ratio = '56.25%', extra = '') =>
    `<div class="oh-embed" style="position:relative;padding-bottom:${ratio};height:0;overflow:hidden;border-radius:8px"><iframe src="${esc(src)}" loading="lazy" style="position:absolute;inset:0;width:100%;height:100%;border:0" allow="autoplay; encrypted-media; picture-in-picture; clipboard-write" allowfullscreen ${extra}></iframe></div>`;
  let inner = '';
  switch (e.provider) {
    case 'youtube': inner = frame(`https://www.youtube-nocookie.com/embed/${e.id}`); break;
    case 'vimeo': inner = frame(`https://player.vimeo.com/video/${e.id}`); break;
    case 'loom': inner = frame(`https://www.loom.com/embed/${e.id}`); break;
    case 'spotify': inner = `<iframe src="https://open.spotify.com/embed/${esc(e.id)}" width="100%" height="232" style="border:0;border-radius:12px" loading="lazy" allow="encrypted-media"></iframe>`; break;
    case 'apple_podcasts': inner = `<iframe src="https://embed.podcasts.apple.com/${esc(e.id)}" width="100%" height="175" style="border:0;border-radius:12px" loading="lazy"></iframe>`; break;
    case 'tiktok': inner = `<iframe src="https://www.tiktok.com/embed/v2/${e.id}" width="100%" height="740" style="border:0;max-width:340px" loading="lazy" allowfullscreen></iframe>`; break;
    case 'instagram': inner = `<iframe src="https://www.instagram.com/p/${e.id}/embed" width="100%" height="560" style="border:0;max-width:480px" loading="lazy"></iframe>`; break;
    case 'bluesky': {
      // embed.bsky.app wants did:…/app.bsky.feed.post/<rkey>; without a resolved DID show a link card, not a broken iframe.
      const rkey = e.id.split('/').pop() || '';
      if (!e.did || !/^[\w-]+$/.test(rkey)) return webLinkCard(e, caption);
      inner = `<iframe src="https://embed.bsky.app/embed/${esc(e.did)}/app.bsky.feed.post/${esc(rkey)}" width="100%" height="380" style="border:0;max-width:520px" loading="lazy"></iframe>`;
      break;
    }
    case 'x': inner = `<iframe src="https://platform.twitter.com/embed/Tweet.html?id=${e.id}" width="100%" height="420" style="border:0;max-width:550px" loading="lazy"></iframe>`; break;
    // Stocktwits has no working public embed (the old widgets endpoint answers with a bot challenge): link card.
    case 'stocktwits': return webLinkCard(e, caption);
  }
  return `<figure class="oh-figure">${inner}${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`;
}

function emailEmbed(e: { provider: string; id: string; url: string }, caption: string, s: StyleTokens): string {
  // Inboxes can't run iframes: show a clickable card (link INSIDE the cell so Outlook keeps it clickable).
  const label = PROVIDER_LABEL[e.provider] || 'Link';
  if (e.provider === 'youtube') {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:0 0 ${s.spacing}px 0"><a href="${esc(e.url)}" target="_blank" style="display:block;text-decoration:none"><img src="https://img.youtube.com/vi/${e.id}/hqdefault.jpg" width="${s.width - 48}" alt="Watch on YouTube" style="display:block;width:100%;height:auto;border:0;border-radius:${s.radius}px"></a>${caption ? `<p style="margin:8px 0 0;font-size:14px;color:${s.muted};text-align:center">${caption}</p>` : ''}<p style="margin:6px 0 0;font-size:13px;text-align:center"><a href="${esc(e.url)}" style="color:${s.link}">▶ Watch on YouTube</a></p></td></tr></table>`;
  }
  const who = embedAuthor(e);
  const head = who ? `${esc(who)}’s ${e.provider === 'stocktwits' ? 'message' : 'post'} on ${label} →` : `View on ${label} →`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${s.border};border-radius:${s.radius}px"><tr><td style="padding:14px 16px;font-family:${s.font};font-size:15px;color:${s.text}"><a href="${esc(e.url)}" target="_blank" style="color:${s.text};text-decoration:none;display:block"><strong>${head}</strong><br><span style="color:${s.muted};font-size:13px;word-break:break-all">${esc(e.url)}</span></a>${caption ? `<div style="margin-top:6px;font-size:14px;color:${s.muted}">${caption}</div>` : ''}</td></tr></table><div style="height:${s.spacing}px;line-height:${s.spacing}px">&nbsp;</div>`;
}

// ───────── main renderer ─────────
interface State { ctx: RenderCtx; s: StyleTokens; footnotes: string[]; headings: Rendered['headings']; paywalled: boolean; usedIds: Set<string>; adsShown: string[] }

function headingId(st: State, text: string) {
  let base = slugify(stripTags(text), 60), i = 2, idv = base;
  while (st.usedIds.has(idv)) idv = `${base}-${i++}`;
  st.usedIds.add(idv);
  return idv;
}

/** Inline content: sanitize, convert footnote spans to numbered references. */
function rich(st: State, html: string): string {
  let out = inline(html || '');
  out = out.replace(/<span[^>]*data-footnote="([^"]*)"[^>]*>[\s\S]*?<\/span>/g, (_, note) => {
    st.footnotes.push(note);
    const n = st.footnotes.length;
    return st.ctx.mode === 'email'
      ? `<sup><a href="#fn-${n}" style="color:${st.s.link};text-decoration:none">[${n}]</a></sup>`
      : `<sup class="oh-fnref" id="fnref-${n}"><a href="#fn-${n}">${n}</a></sup>`;
  });
  if (st.ctx.mode === 'email') {
    out = out.replace(/<a /g, `<a style="color:${st.s.link};text-decoration:underline" `);
    out = out.replace(/<code>/g, `<code style="font-family:Menlo,Consolas,monospace;font-size:0.9em;background:#f3f4f6;padding:1px 4px;border-radius:4px">`);
  }
  return out;
}

function passesDynamic(st: State, d: any): boolean {
  const rule = d.rule || {};
  const sub = st.ctx.subscriber;
  const tier = sub ? (sub.tier === 'premium' ? 'premium' : 'free') : st.ctx.access ? 'premium' : 'free';
  const checks: boolean[] = [];
  if (Array.isArray(rule.tiers) && rule.tiers.length) checks.push(rule.tiers.includes(tier) || (!sub && rule.tiers.includes('visitor')));
  if (Array.isArray(rule.segment_ids) && rule.segment_ids.length) checks.push(rule.segment_ids.some((x: string) => st.ctx.segmentIds?.has(x)));
  if (Array.isArray(rule.tags) && rule.tags.length) checks.push(rule.tags.some((t: string) => st.ctx.tags?.includes(t)));
  if (Array.isArray(rule.cohorts) && rule.cohorts.length) checks.push(rule.cohorts.includes(st.ctx.cohort));
  const match = checks.length ? (rule.match === 'all' ? checks.every(Boolean) : checks.some(Boolean)) : true;
  return d.mode === 'hide' ? !match : match;
}

/** Is this block rendered in the given channel? (`data.show_in`: 'email' | 'web' | absent = both) */
export function showsIn(b: Block, mode: 'email' | 'web'): boolean {
  const v = b && b.data && b.data.show_in;
  return v !== 'email' && v !== 'web' ? true : v === mode;
}

async function renderBlocks(st: State, blocks: Block[]): Promise<string> {
  const parts: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    // Per-block channel: data.show_in = 'email' (email only) | 'web' (web only); absent = both.
    if (!showsIn(b, st.ctx.mode)) continue;
    if (b.type === 'paywall') {
      if (st.ctx.access) {
        parts.push(st.ctx.preview ? `<div class="oh-paywall-marker">— Paywall break: content below is premium —</div>` : '');
        continue;
      }
      st.paywalled = true;
      parts.push(paywallCta(st));
      break;
    }
    parts.push(await renderBlock(st, b));
  }
  return parts.join('\n');
}

function paywallCta(st: State): string {
  const { s, ctx } = st;
  const url = `${ctx.siteUrl}/upgrade${ctx.post ? `?post=${ctx.post.slug}` : ''}`;
  if (ctx.mode === 'email') {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:${s.spacing}px 0;border:1px solid ${s.border};border-radius:${s.radius}px;background:#fafafa"><tr><td align="center" style="padding:28px 20px;font-family:${s.font};color:${s.text}"><p style="margin:0 0 6px;font-size:19px;font-weight:700">The rest of this issue is for premium subscribers</p><p style="margin:0 0 16px;color:${s.muted};font-size:15px">Upgrade to keep reading and get every premium post.</p>${emailButton(s, 'Upgrade to read', url, 'center')}</td></tr></table>`;
  }
  return `<div class="oh-paywall"><h3>Keep reading with a premium subscription</h3><p>The rest of this post is for paid subscribers.</p><div class="oh-paywall-actions"><a class="oh-btn" href="${esc(url)}">Upgrade</a> <a class="oh-btn oh-btn-ghost" href="${esc(ctx.siteUrl)}/login">Already a subscriber? Log in</a></div></div>`;
}

function emailButton(s: StyleTokens, label: string, url: string, align = 'left', bg = s.button_bg, color = s.button_text): string {
  // Bulletproof button: link inside a bgcolor cell (clickable in Outlook).
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align}" style="margin:0 ${align === 'center' ? 'auto' : '0'}"><tr><td bgcolor="${bg}" style="border-radius:${s.radius}px;background:${bg}"><a href="${esc(url)}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:${s.font};font-size:16px;font-weight:600;color:${color};text-decoration:none;border-radius:${s.radius}px;border:1px solid ${bg}">${esc(label)}</a></td></tr></table>`;
}

const EMAIL_P = (s: StyleTokens) => `margin:0 0 ${s.spacing}px;font-family:${s.font};font-size:${s.font_size}px;line-height:${s.line_height};color:${s.text}`;

async function renderBlock(st: State, b: Block): Promise<string> {
  const { ctx, s } = st;
  const d = b.data || {};
  const E = ctx.mode === 'email';
  const align = d.align ? ` text-align:${d.align};` : '';
  switch (b.type) {
    case 'paragraph': {
      const h = rich(st, d.html || '');
      if (!stripTags(h) && !/<img|<br/.test(h)) return E ? `<div style="height:${s.spacing}px;line-height:${s.spacing}px">&nbsp;</div>` : '<p class="oh-empty">&nbsp;</p>';
      return E ? `<p style="${EMAIL_P(s)};${align}">${h}</p>` : `<p style="${align}">${h}</p>`;
    }
    case 'heading': {
      const lvl = Math.min(4, Math.max(1, Number(d.level) || 2));
      const h = rich(st, d.html || '');
      const hid = headingId(st, h);
      st.headings.push({ id: hid, text: stripTags(h), level: lvl });
      const size = [0, 32, 26, 21, 18][lvl];
      return E
        ? `<h${lvl} id="${hid}" style="margin:${s.spacing * 1.5}px 0 ${s.spacing * 0.6}px;font-family:${s.heading_font};font-size:${size}px;line-height:1.25;font-weight:700;color:${s.text};${align}"><a name="${hid}"></a>${h}</h${lvl}>`
        : `<h${lvl} id="${hid}" style="${align}">${h}</h${lvl}>`;
    }
    case 'list': {
      const tag = d.ordered ? 'ol' : 'ul';
      // items: html strings, or {html, items} for nested (indented) lists
      const renderItems = (list: any[], depth: number): string =>
        list.map((x: any) => {
          const html = typeof x === 'string' ? x : x?.html || '';
          const kids = typeof x === 'object' && Array.isArray(x?.items) && x.items.length && depth < 4
            ? (E ? `<${tag} style="margin:6px 0 0;padding-left:22px">${renderItems(x.items, depth + 1)}</${tag}>` : `<${tag}>${renderItems(x.items, depth + 1)}</${tag}>`)
            : '';
          return E ? `<li style="margin:0 0 6px">${rich(st, html)}${kids}</li>` : `<li>${rich(st, html)}${kids}</li>`;
        }).join('');
      const items = renderItems(d.items || [], 0);
      return E ? `<${tag} style="${EMAIL_P(s)};padding-left:26px">${items}</${tag}>` : `<${tag}>${items}</${tag}>`;
    }
    case 'checklist': {
      const items = (d.items || []) as Array<{ html: string; checked: boolean }>;
      return E
        ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${s.spacing}px">${items.map((x) => `<tr><td valign="top" style="padding:2px 8px 2px 0;font-size:${s.font_size}px">${x.checked ? '☑' : '☐'}</td><td style="font-family:${s.font};font-size:${s.font_size}px;color:${s.text};line-height:${s.line_height}">${rich(st, x.html)}</td></tr>`).join('')}</table>`
        : `<ul class="oh-checklist">${items.map((x) => `<li class="${x.checked ? 'done' : ''}">${rich(st, x.html)}</li>`).join('')}</ul>`;
    }
    case 'quote': {
      const qs = d.style || {};
      const border = qs.border_color || s.accent, bw = qs.border_width ?? 4, bg = qs.bg || 'transparent', color = qs.color || s.text;
      const variant = qs.variant || 'line'; // line | box | pull
      const cite = d.cite ? `<div style="margin-top:8px;font-size:14px;color:${s.muted}">— ${rich(st, d.cite)}</div>` : '';
      if (E) {
        const borderCss = variant === 'box' ? `border:${bw}px solid ${border};border-radius:${s.radius}px` : variant === 'pull' ? `border-top:${bw}px solid ${border};border-bottom:${bw}px solid ${border};text-align:center` : `border-left:${bw}px solid ${border}`;
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${s.spacing}px"><tr><td style="${borderCss};background:${bg};padding:12px 18px;font-family:${s.font};font-size:${variant === 'pull' ? s.font_size + 4 : s.font_size}px;line-height:${s.line_height};color:${color};font-style:${qs.italic === false ? 'normal' : 'italic'}">${rich(st, d.html || '')}${cite}</td></tr></table>`;
      }
      return `<blockquote class="oh-quote oh-quote-${esc(variant)}" style="--q-border:${esc(border)};--q-bw:${Number(bw)}px;--q-bg:${esc(bg)};--q-color:${esc(color)};${qs.italic === false ? 'font-style:normal' : ''}">${rich(st, d.html || '')}${cite}</blockquote>`;
    }
    case 'image': {
      if (!d.src) return '';
      const alt = esc(d.alt || ''), title = d.title ? ` title="${esc(d.title)}"` : '';
      const w = Math.min(Number(d.width) || 100, 100);
      const cap = d.caption ? rich(st, d.caption) : '';
      const img = E
        ? `<img src="${esc(d.src)}" alt="${alt}"${title} width="${Math.round(((s.width - 48) * w) / 100)}" style="display:block;width:${w}%;max-width:100%;height:auto;border:0;border-radius:${d.radius ?? s.radius}px;margin:0 auto">`
        : `<img src="${esc(d.src)}" alt="${alt}"${title} loading="lazy" decoding="async" style="width:${w}%">`;
      const linked = d.link ? `<a href="${esc(d.link)}" target="_blank">${img}</a>` : img;
      return E
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${s.spacing}px"><tr><td align="${d.align || 'center'}">${linked}${cap ? `<p style="margin:8px 0 0;font-family:${s.font};font-size:14px;color:${s.muted};text-align:center">${cap}</p>` : ''}</td></tr></table>`
        : `<figure class="oh-figure oh-align-${esc(d.align || 'center')}">${linked}${cap ? `<figcaption>${cap}</figcaption>` : ''}</figure>`;
    }
    case 'gallery': {
      const imgs = (d.images || []) as Array<{ src: string; alt?: string; caption?: string }>;
      if (!imgs.length) return '';
      if (E) {
        const cols = Math.min(Number(d.columns) || 2, 3);
        const rows: string[] = [];
        for (let i = 0; i < imgs.length; i += cols) {
          rows.push(`<tr>${imgs.slice(i, i + cols).map((im) => { const cap = im.caption ? rich(st, im.caption) : ''; return `<td width="${Math.floor(100 / cols)}%" valign="top" style="padding:4px"><img src="${esc(im.src)}" alt="${esc(im.alt || '')}" width="${Math.floor((s.width - 60) / cols)}" style="display:block;width:100%;height:auto;border-radius:${s.radius}px">${cap ? `<p style="margin:6px 0 0;font-family:${s.font};font-size:13px;line-height:1.4;color:${s.muted};text-align:center">${cap}</p>` : ''}</td>`; }).join('')}</tr>`);
        }
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${s.spacing}px">${rows.join('')}</table>`;
      }
      const kind = d.layout === 'carousel' ? 'oh-carousel' : 'oh-grid';
      // captions are inline rich text (bold/italic/links), same as image captions
      return `<div class="${kind}" style="--cols:${Number(d.columns) || 2}">${imgs.map((im) => { const cap = im.caption ? rich(st, im.caption) : ''; return `<figure><img src="${esc(im.src)}" alt="${esc(im.alt || '')}" loading="lazy">${cap ? `<figcaption>${cap}</figcaption>` : ''}</figure>`; }).join('')}</div>`;
    }
    case 'button': {
      const url = d.url || '#';
      const bg = d.bg || s.button_bg, color = d.color || s.button_text;
      return E
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${s.spacing}px"><tr><td align="${d.align || 'center'}">${emailButton(s, d.label || 'Click here', url, d.align || 'center', bg, color)}</td></tr></table>`
        : `<p style="text-align:${esc(d.align || 'center')}"><a class="oh-btn" href="${esc(url)}" style="background:${esc(bg)};color:${esc(color)}"><span style="color:${esc(color)}">${esc(d.label || 'Click here')}</span></a></p>`;
    }
    case 'divider': {
      const style = d.style || 'line'; // line | dots | space | stars
      if (E) {
        if (style === 'space') return `<div style="height:${s.spacing * 2}px;line-height:${s.spacing * 2}px">&nbsp;</div>`;
        if (style === 'dots' || style === 'stars') return `<p style="margin:${s.spacing}px 0;text-align:center;color:${s.muted};font-size:18px;letter-spacing:12px">${style === 'dots' ? '•••' : '✦✦✦'}</p>`;
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:${s.spacing}px 0"><tr><td style="border-top:1px solid ${d.color || s.border};font-size:1px;line-height:1px">&nbsp;</td></tr></table>`;
      }
      return `<hr class="oh-hr oh-hr-${esc(style)}" ${d.color ? `style="border-color:${esc(d.color)}"` : ''}>`;
    }
    case 'spacer': {
      const h = Number(d.height) || 24;
      return `<div style="height:${h}px;line-height:${h}px">&nbsp;</div>`;
    }
    case 'code': {
      const code = esc(d.code || '');
      return E
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${s.spacing}px"><tr><td style="background:#0f172a;border-radius:${s.radius}px;padding:14px 16px"><pre style="margin:0;font-family:Menlo,Consolas,'Courier New',monospace;font-size:13px;line-height:1.5;color:#e2e8f0;white-space:pre-wrap;word-break:break-word">${code}</pre></td></tr></table>`
        : `<pre class="oh-code"${d.lang ? ` data-lang="${esc(d.lang)}"` : ''}><code>${code}</code></pre>`;
    }
    case 'html': {
      // Custom HTML: sanitized + balanced. Media allowed on web only.
      const clean = sanitizeHtml(d.html || '', { blocks: true, media: !E, styles: true });
      return E ? `<div style="font-family:${s.font};color:${s.text}">${clean}</div>` : `<div class="oh-html">${clean}</div>`;
    }
    case 'embed': {
      const e = parseEmbed(d.url || '');
      const cap = d.caption ? rich(st, d.caption) : '';
      if (!e) return d.url ? (E ? `<p style="${EMAIL_P(s)}"><a href="${esc(d.url)}" style="color:${s.link}">${esc(d.url)}</a></p>` : `<p><a href="${esc(d.url)}">${esc(d.url)}</a></p>`) : '';
      if (E) return emailEmbed(e, cap, s);
      // DID stored at save time (data.did for data.did_for = handle), else resolved now (cached per isolate).
      const handle = e.id.split('/')[0];
      const did = e.provider === 'bluesky' ? (typeof d.did === 'string' && /^did:[a-z]+:/.test(d.did) && (!d.did_for || d.did_for === handle) ? d.did : await resolveBlueskyDid(handle)) : null;
      return webEmbed({ ...e, did }, cap);
    }
    case 'video': {
      if (E) {
        // Inboxes can't play video: show poster linking to the web version.
        const url = ctx.post ? `${ctx.siteUrl}/p/${ctx.post.slug}` : d.src;
        return d.poster
          ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${s.spacing}px"><tr><td><a href="${esc(url)}"><img src="${esc(d.poster)}" alt="Play video" width="${s.width - 48}" style="display:block;width:100%;height:auto;border-radius:${s.radius}px"></a><p style="margin:6px 0 0;text-align:center;font-size:13px"><a href="${esc(url)}" style="color:${s.link}">▶ Watch the video</a></p></td></tr></table>`
          : `<p style="${EMAIL_P(s)}"><a href="${esc(url)}" style="color:${s.link}">▶ Watch the video on the web</a></p>`;
      }
      return `<figure class="oh-figure"><video src="${esc(d.src)}" ${d.poster ? `poster="${esc(d.poster)}"` : ''} controls playsinline preload="metadata" style="width:100%;border-radius:8px"></video>${d.caption ? `<figcaption>${rich(st, d.caption)}</figcaption>` : ''}</figure>`;
    }
    case 'audio': {
      if (E) {
        const url = ctx.post ? `${ctx.siteUrl}/p/${ctx.post.slug}` : d.src;
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${s.spacing}px;border:1px solid ${s.border};border-radius:${s.radius}px"><tr><td style="padding:12px 16px;font-family:${s.font};font-size:15px"><a href="${esc(url)}" style="color:${s.text};text-decoration:none">🎧 <strong>${esc(d.title || 'Listen')}</strong> — play on the web</a></td></tr></table>`;
      }
      return `<figure class="oh-audio"><figcaption>${esc(d.title || '')}</figcaption><audio src="${esc(d.src)}" controls preload="none" style="width:100%"></audio></figure>`;
    }
    case 'attachment': {
      const size = d.size ? ` · ${(Number(d.size) / 1024 / 1024).toFixed(1)} MB` : '';
      return E
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${s.spacing}px;border:1px solid ${s.border};border-radius:${s.radius}px"><tr><td style="padding:12px 16px;font-family:${s.font};font-size:15px"><a href="${esc(d.url)}" style="color:${s.text};text-decoration:none">📎 <strong>${esc(d.name || 'Download file')}</strong><span style="color:${s.muted}">${size}</span></a></td></tr></table>`
        : `<a class="oh-attachment" href="${esc(d.url)}" download>📎 <strong>${esc(d.name || 'Download file')}</strong><span>${size}</span></a>`;
    }
    case 'table': {
      const rows = (d.rows || []) as string[][];
      const header = !!d.header;
      if (E) {
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${s.spacing}px;border-collapse:collapse">${rows.map((r, ri) => `<tr>${r.map((c) => `<td style="border:1px solid ${s.border};padding:8px 10px;font-family:${s.font};font-size:15px;color:${s.text};${header && ri === 0 ? 'font-weight:700;background:#f9fafb' : ''}">${rich(st, c)}</td>`).join('')}</tr>`).join('')}</table>`;
      }
      return `<div class="oh-table-wrap"><table class="oh-table">${rows.map((r, ri) => `<tr>${r.map((c) => (header && ri === 0 ? `<th>${rich(st, c)}</th>` : `<td>${rich(st, c)}</td>`)).join('')}</tr>`).join('')}</table></div>`;
    }
    case 'columns': {
      const cols = (d.columns || []) as Array<{ blocks: Block[]; width?: number }>;
      const valign = d.valign || 'top';
      const inner = await Promise.all(cols.map((c) => renderBlocks(st, c.blocks || [])));
      if (E) {
        const gap = 16;
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${s.spacing}px"><tr>${cols.map((c, i) => `<td class="oh-col" width="${c.width || Math.floor(100 / cols.length)}%" valign="${valign}" style="vertical-align:${valign};padding:0 ${i < cols.length - 1 ? gap / 2 : 0}px 0 ${i > 0 ? gap / 2 : 0}px">${inner[i]}</td>`).join('')}</tr></table>`;
      }
      return `<div class="oh-columns" style="align-items:${valign === 'middle' ? 'center' : valign === 'bottom' ? 'flex-end' : 'flex-start'}">${cols.map((c, i) => `<div class="oh-col" style="flex:${c.width || 1} 1 0">${inner[i]}</div>`).join('')}</div>`;
    }
    case 'section': {
      const ss = d.style || {};
      const inner = await renderBlocks(st, d.blocks || []);
      const pad = ss.padding ?? 20, bg = ss.bg || 'transparent', border = ss.border_width ? `${ss.border_width}px ${ss.border_style || 'solid'} ${ss.border_color || s.border}` : 'none';
      const radius = ss.radius ?? s.radius;
      if (E) {
        const img = ss.bg_image && /^https?:\/\//i.test(String(ss.bg_image)) ? String(ss.bg_image) : '';
        if (img) {
          // Outlook desktop (Word engine) ignores CSS background images: draw a VML rect filled with the image
          // behind the content inside MSO conditionals. Other clients use the background attribute/CSS.
          const fillColor = /^#[0-9a-f]{3,8}$/i.test(bg) ? bg : s.content_bg;
          return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${ss.margin ?? s.spacing}px"><tr><td background="${esc(img)}" bgcolor="${esc(fillColor)}" valign="top" style="background:${esc(bg)};background-image:url('${esc(img)}');background-size:cover;background-position:center;border:${border};border-radius:${radius}px;color:${esc(ss.color || s.text)}">`
            + `<!--[if gte mso 9]><v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="mso-width-percent:1000;"><v:fill type="frame" src="${esc(img)}" color="${esc(fillColor)}" /><v:textbox style="mso-fit-shape-to-text:true" inset="0,0,0,0"><![endif]-->`
            + `<div style="padding:${pad}px">${inner}</div>`
            + `<!--[if gte mso 9]></v:textbox></v:rect><![endif]--></td></tr></table>`;
        }
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${ss.margin ?? s.spacing}px"><tr><td ${bg !== 'transparent' ? `bgcolor="${esc(bg)}"` : ''} style="background:${esc(bg)};border:${border};border-radius:${radius}px;padding:${pad}px;color:${esc(ss.color || s.text)}">${inner}</td></tr></table>`;
      }
      return `<section class="oh-section" style="background:${esc(bg)};${ss.bg_image ? `background-image:url(${esc(ss.bg_image)});background-size:cover;` : ''}border:${border};border-radius:${radius}px;padding:${pad}px;margin-bottom:${ss.margin ?? 16}px;${ss.color ? `color:${esc(ss.color)}` : ''}">${inner}</section>`;
    }
    case 'dynamic': {
      const show = passesDynamic(st, d);
      if (ctx.preview) {
        const inner = await renderBlocks(st, d.blocks || []);
        return `<div class="oh-dynamic ${show ? '' : 'oh-dynamic-hidden'}" data-label="${esc(dynamicLabel(d))}">${inner}</div>`;
      }
      return show ? renderBlocks(st, d.blocks || []) : '';
    }
    case 'toc': {
      return '<!--OH_TOC-->';
    }
    case 'poll': {
      const poll = await one<any>(ctx.env, 'SELECT * FROM polls WHERE id = ? AND pub_id = ?', d.poll_id, ctx.pub.id);
      if (!poll) return '';
      const opts = parseJSON<Array<{ id: string; label: string }>>(poll.options, []);
      if (E) {
        const base = `${ctx.siteUrl}/poll/${poll.id}`;
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${s.spacing}px;border:1px solid ${s.border};border-radius:${s.radius}px"><tr><td style="padding:16px;font-family:${s.font}">${poll.kind === 'trivia' ? `<p style="margin:0 0 6px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:${s.muted}">Trivia</p>` : ''}<p style="margin:0 0 12px;font-size:17px;font-weight:700;color:${s.text}">${esc(poll.question)}</p>${opts.map((o) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px"><tr><td style="border:1px solid ${s.border};border-radius:${s.radius}px"><a href="${esc(`${base}/vote?o=${o.id}${ctx.deliveryId ? `&d=${ctx.deliveryId}` : ''}${ctx.post ? `&post=${ctx.post.id}` : ''}`)}" style="display:block;padding:10px 14px;color:${s.text};text-decoration:none;font-size:15px">${esc(o.label)}</a></td></tr></table>`).join('')}</td></tr></table>`;
      }
      return `<div class="oh-poll${poll.kind === 'trivia' ? ' oh-trivia' : ''}" data-poll="${esc(poll.id)}">${poll.kind === 'trivia' ? '<small class="oh-poll-kind">Trivia</small>' : ''}<p class="oh-poll-q">${esc(poll.question)}</p><form method="post" action="${esc(ctx.siteUrl)}/poll/${esc(poll.id)}/vote">${ctx.post ? `<input type="hidden" name="post" value="${esc(ctx.post.id)}">` : ''}${opts.map((o) => `<button class="oh-poll-opt" name="o" value="${esc(o.id)}">${esc(o.label)}</button>`).join('')}</form></div>`;
    }
    case 'referral': {
      const sub = ctx.subscriber;
      const link = sub ? `${ctx.siteUrl}/subscribe?ref=${sub.referral_code}` : `${ctx.siteUrl}/subscribe`;
      const rewards = await all<any>(ctx.env, 'SELECT milestone, name FROM referral_rewards WHERE pub_id = ? ORDER BY milestone LIMIT 5', ctx.pub.id);
      const next = rewards.find((r) => r.milestone > (sub?.referral_count ?? 0));
      const title = d.title || 'Share this newsletter, earn rewards';
      const body = sub
        ? `You've referred <strong>${sub.referral_count}</strong> ${sub.referral_count === 1 ? 'reader' : 'readers'}.${next ? ` Refer ${next.milestone - sub.referral_count} more to get <strong>${esc(next.name)}</strong>.` : ''}`
        : rewards.length ? `Refer friends to unlock: ${rewards.map((r) => `${esc(r.name)} (${r.milestone})`).join(', ')}.` : 'Know someone who would enjoy this? Send them your link.';
      if (E)
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${s.spacing}px;background:#fffbeb;border:1px solid #fde68a;border-radius:${s.radius}px"><tr><td style="padding:18px;font-family:${s.font};color:${s.text}"><p style="margin:0 0 6px;font-weight:700;font-size:17px">${esc(title)}</p><p style="margin:0 0 12px;font-size:15px">${body}</p><p style="margin:0;font-size:14px;word-break:break-all"><a href="${esc(link)}" style="color:${s.link}">${esc(link)}</a></p></td></tr></table>`;
      return `<div class="oh-referral"><h4>${esc(title)}</h4><p>${body}</p><div class="oh-copy"><input readonly value="${esc(link)}"><button type="button" data-copy="${esc(link)}">Copy</button></div></div>`;
    }
    case 'recommendations': {
      const recs = await all<any>(ctx.env, `SELECT r.*, p.name AS t_name, p.description AS t_desc, p.slug AS t_slug, p.logo_url AS t_logo FROM recommendations r LEFT JOIN publications p ON p.id = r.target_pub_id WHERE r.pub_id = ? AND r.status = 'active' ORDER BY r.position LIMIT ?`, ctx.pub.id, Number(d.limit) || 3);
      if (!recs.length) return '';
      const items = recs.map((r) => ({ name: r.t_name || r.ext_name, desc: r.t_desc || r.ext_description || '', url: r.target_pub_id ? `${ctx.env.APP_URL}/s/${r.t_slug}?ref_pub=${ctx.pub.id}` : r.ext_url, logo: r.t_logo || r.ext_logo }));
      const title = d.title || 'Newsletters we recommend';
      if (E)
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${s.spacing}px;border:1px solid ${s.border};border-radius:${s.radius}px"><tr><td style="padding:16px;font-family:${s.font}"><p style="margin:0 0 10px;font-weight:700;font-size:16px;color:${s.text}">${esc(title)}</p>${items.map((x) => `<p style="margin:0 0 10px;font-size:15px;color:${s.text}"><a href="${esc(x.url)}" style="color:${s.link};font-weight:600">${esc(x.name)}</a><br><span style="color:${s.muted};font-size:14px">${esc(x.desc)}</span></p>`).join('')}</td></tr></table>`;
      return `<div class="oh-recs"><h4>${esc(title)}</h4>${items.map((x) => `<a class="oh-rec" href="${esc(x.url)}">${x.logo ? `<img src="${esc(x.logo)}" alt="">` : ''}<span><strong>${esc(x.name)}</strong><small>${esc(x.desc)}</small></span></a>`).join('')}</div>`;
    }
    case 'ad_auto': {
      // Programmatic slot: filled with the best eligible network campaign at render/send time (lib/programmatic.ts).
      const fill = await fillSlot({ env: ctx.env, pub: ctx.pub, post: ctx.post, subscriber: ctx.subscriber, deliveryId: ctx.deliveryId, mode: ctx.mode, preview: ctx.preview, access: ctx.access }, st.adsShown);
      if (!fill) return ctx.preview ? (E ? '' : `<div class="oh-paywall-marker">Programmatic ad slot — filled automatically when sent</div>`) : '';
      st.adsShown.push(fill.campaignId);
      return renderBlock(st, { type: 'ad', data: { opportunity_id: fill.opportunityId, campaign_id: fill.opportunityId ? undefined : fill.campaignId, label: d.label || 'Sponsored' } });
    }
    case 'ad': {
      const ad = d.opportunity_id
        ? await one<any>(ctx.env, `SELECT o.id AS opp_id, c.* FROM ad_opportunities o JOIN ad_campaigns c ON c.id = o.campaign_id WHERE o.id = ? AND o.pub_id = ?`, d.opportunity_id, ctx.pub.id)
        : d.campaign_id ? await one<any>(ctx.env, 'SELECT c.*, NULL AS opp_id FROM ad_campaigns c WHERE id = ?', d.campaign_id) : null;
      if (!ad && !d.headline) return '';
      const a = ad || { headline: d.headline, body: d.body || '', url: d.url || '#', image_url: d.image, cta_label: d.cta || 'Learn more', opp_id: null, link_params: '' };
      let url = a.url as string;
      if (a.link_params) {
        const params = String(a.link_params).replace(/\{pub\}/g, ctx.pub.slug).replace(/\{post\}/g, ctx.post?.slug || '');
        try {
          const u = new URL(url);
          for (const [k, v] of new URLSearchParams(params)) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
          url = u.toString(); // keeps any #fragment at the end
        } catch { url += (url.includes('?') ? '&' : '?') + params; }
      }
      const href = a.opp_id ? `${ctx.env.APP_URL}/t/ad/${a.opp_id}?u=${encodeURIComponent(url)}${ctx.deliveryId ? `&d=${ctx.deliveryId}` : ''}` : url;
      const label = d.label || 'Together with';
      if (E)
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${s.spacing}px;border:1px solid ${s.border};border-radius:${s.radius}px"><tr><td style="padding:16px;font-family:${s.font};color:${s.text}"><p style="margin:0 0 8px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:${s.muted}">${esc(label)}</p>${a.image_url ? `<a href="${esc(href)}"><img src="${esc(a.image_url)}" alt="" width="${s.width - 82}" style="display:block;width:100%;height:auto;border-radius:${s.radius}px;margin:0 0 10px"></a>` : ''}<p style="margin:0 0 6px;font-size:18px;font-weight:700"><a href="${esc(href)}" style="color:${s.text};text-decoration:none">${esc(a.headline)}</a></p><p style="margin:0 0 12px;font-size:15px;line-height:1.5">${esc(a.body)}</p>${emailButton(s, a.cta_label || 'Learn more', href)}</td></tr></table>`;
      return `<aside class="oh-ad"><small>${esc(label)}</small>${a.image_url ? `<a href="${esc(href)}" rel="sponsored noopener"><img src="${esc(a.image_url)}" alt=""></a>` : ''}<h4><a href="${esc(href)}" rel="sponsored noopener">${esc(a.headline)}</a></h4><p>${esc(a.body)}</p><a class="oh-btn" href="${esc(href)}" rel="sponsored noopener">${esc(a.cta_label || 'Learn more')}</a></aside>`;
    }
    case 'podcast': {
      const ep = await one<any>(ctx.env, `SELECT e.*, p.slug AS pslug, p.title AS ptitle, p.cover_url FROM episodes e JOIN podcasts p ON p.id = e.podcast_id WHERE e.id = ? AND e.pub_id = ?`, d.episode_id, ctx.pub.id);
      if (!ep) return '';
      const page = `${ctx.siteUrl}/podcasts/${ep.pslug}/${ep.slug}`;
      const img = ep.image_url || ep.cover_url;
      if (E)
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${s.spacing}px;border:1px solid ${s.border};border-radius:${s.radius}px"><tr>${img ? `<td width="96" valign="middle" style="padding:12px"><a href="${esc(page)}"><img src="${esc(img)}" width="80" height="80" alt="" style="display:block;border-radius:6px"></a></td>` : ''}<td valign="middle" style="padding:12px;font-family:${s.font}"><p style="margin:0;font-size:12px;color:${s.muted}">${esc(ep.ptitle)}</p><p style="margin:2px 0 6px;font-size:16px;font-weight:700"><a href="${esc(page)}" style="color:${s.text};text-decoration:none">${esc(ep.title)}</a></p><a href="${esc(page)}" style="color:${s.link};font-size:14px">▶ Listen now</a></td></tr></table>`;
      return `<div class="oh-episode">${img ? `<img src="${esc(img)}" alt="">` : ''}<div><small>${esc(ep.ptitle)}</small><a href="${esc(page)}"><strong>${esc(ep.title)}</strong></a><audio controls preload="none" src="${esc(ctx.env.APP_URL)}/listen/${esc(ep.id)}.mp3"></audio></div></div>`;
    }
    case 'product': {
      const p = await one<any>(ctx.env, 'SELECT * FROM products WHERE id = ? AND pub_id = ?', d.product_id, ctx.pub.id);
      if (!p) return '';
      const url = `${ctx.siteUrl}/shop/${p.slug}`;
      const price = p.price_cents ? new Intl.NumberFormat('en-US', { style: 'currency', currency: p.currency.toUpperCase() }).format(p.price_cents / 100) : 'Free';
      if (E)
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${s.spacing}px;border:1px solid ${s.border};border-radius:${s.radius}px"><tr><td style="padding:16px;font-family:${s.font};color:${s.text}">${p.cover_url ? `<img src="${esc(p.cover_url)}" alt="" width="${s.width - 82}" style="display:block;width:100%;height:auto;border-radius:${s.radius}px;margin:0 0 10px">` : ''}<p style="margin:0 0 4px;font-size:18px;font-weight:700">${esc(p.name)}</p><p style="margin:0 0 12px;font-size:15px;color:${s.muted}">${esc(stripTags(p.description).slice(0, 180))}</p>${emailButton(s, `${p.price_cents ? 'Buy' : 'Get it'} — ${price}`, url)}</td></tr></table>`;
      return `<div class="oh-product">${p.cover_url ? `<img src="${esc(p.cover_url)}" alt="">` : ''}<div><h4>${esc(p.name)}</h4><p>${esc(stripTags(p.description).slice(0, 180))}</p><a class="oh-btn" href="${esc(url)}">${p.price_cents ? 'Buy' : 'Get it'} — ${price}</a></div></div>`;
    }
    case 'event': {
      const ev = await one<any>(ctx.env, 'SELECT * FROM live_events WHERE id = ? AND pub_id = ?', d.event_id, ctx.pub.id);
      if (!ev) return '';
      const url = `${ctx.siteUrl}/events/${ev.slug}`;
      const when = fmtDate(ev.starts_at, { dateStyle: 'full', timeStyle: 'short' }, ev.timezone);
      if (E)
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${s.spacing}px;border:1px solid ${s.border};border-radius:${s.radius}px"><tr><td style="padding:16px;font-family:${s.font};color:${s.text}"><p style="margin:0 0 4px;font-size:12px;color:${s.muted}">📅 ${esc(when)}</p><p style="margin:0 0 12px;font-size:18px;font-weight:700">${esc(ev.title)}</p>${emailButton(s, ev.price_cents ? 'Get tickets' : 'Register free', url)}</td></tr></table>`;
      return `<div class="oh-event"><small>📅 ${esc(when)}</small><h4>${esc(ev.title)}</h4><a class="oh-btn" href="${esc(url)}">${ev.price_cents ? 'Get tickets' : 'Register free'}</a></div>`;
    }
    case 'subscribe': {
      if (E) return '';
      return `<form class="oh-subscribe-inline" method="post" action="${esc(ctx.siteUrl)}/subscribe"><input type="email" name="email" placeholder="you@example.com" required><input type="text" name="website" class="oh-hp" tabindex="-1" autocomplete="off"><input type="hidden" name="_t" value="${Date.now()}"><button class="oh-btn">${esc(d.label || 'Subscribe')}</button></form>`;
    }
    default:
      return '';
  }
}

function dynamicLabel(d: any): string {
  const r = d.rule || {};
  const bits: string[] = [];
  if (r.tiers?.length) bits.push('tiers: ' + r.tiers.join(', '));
  if (r.segment_ids?.length) bits.push(r.segment_ids.length + ' segment(s)');
  if (r.tags?.length) bits.push('tags: ' + r.tags.join(', '));
  if (r.cohorts?.length) bits.push('cohort: ' + r.cohorts.join(', '));
  return `${d.mode === 'hide' ? 'Hidden for' : 'Only for'} ${bits.join(' · ') || 'everyone'}`;
}

function tocHtml(st: State): string {
  const hs = st.headings.filter((h) => h.level <= 3);
  if (!hs.length) return '';
  if (st.ctx.mode === 'email') {
    const s = st.s;
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${s.spacing}px;background:#f9fafb;border-radius:${s.radius}px"><tr><td style="padding:14px 18px;font-family:${s.font}"><p style="margin:0 0 8px;font-weight:700;font-size:14px;text-transform:uppercase;letter-spacing:1px;color:${s.muted}">In this issue</p>${hs.map((h) => `<p style="margin:0 0 4px;padding-left:${(h.level - 1) * 12}px;font-size:15px"><a href="#${h.id}" style="color:${s.link};text-decoration:none">${esc(h.text)}</a></p>`).join('')}</td></tr></table>`;
  }
  return `<nav class="oh-toc"><strong>Contents</strong><ol>${hs.map((h) => `<li class="l${h.level}"><a href="#${h.id}">${esc(h.text)}</a></li>`).join('')}</ol></nav>`;
}

function footnotesHtml(st: State): string {
  if (!st.footnotes.length) return '';
  const s = st.s;
  const linkify = (t: string) => esc(t).replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}"${st.ctx.mode === 'email' ? ` style="color:${s.link}"` : ''}>${u}</a>`);
  if (st.ctx.mode === 'email')
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:${s.spacing}px 0 0;border-top:1px solid ${s.border}"><tr><td style="padding-top:12px;font-family:${s.font};font-size:13px;color:${s.muted}">${st.footnotes.map((n, i) => `<p id="fn-${i + 1}" style="margin:0 0 6px"><a name="fn-${i + 1}"></a>${i + 1}. ${linkify(n)}</p>`).join('')}</td></tr></table>`;
  return `<section class="oh-footnotes"><hr><ol>${st.footnotes.map((n, i) => `<li id="fn-${i + 1}">${linkify(n)} <a href="#fnref-${i + 1}" aria-label="Back">↩</a></li>`).join('')}</ol></section>`;
}

export function parseDoc(json: string | null | undefined): Doc {
  const d = parseJSON<Doc>(json, { blocks: [] });
  return Array.isArray(d.blocks) ? d : { blocks: [] };
}

/** Render a document. Returns body HTML (not wrapped in an email layout). */
export async function renderDoc(doc: Doc, ctx: RenderCtx): Promise<Rendered> {
  const s = ctx.style || styleFor(ctx.pub);
  const st: State = { ctx, s, footnotes: [], headings: [], paywalled: false, usedIds: new Set(), adsShown: [] };
  doc = autoInsert(doc, ctx.pub, ctx.post, ctx.mode);
  let html = await renderBlocks(st, doc.blocks || []);
  html = html.replace('<!--OH_TOC-->', tocHtml(st)).replace(/<!--OH_TOC-->/g, '');
  html += footnotesHtml(st);
  const vars = mergeVars(ctx.pub, ctx.subscriber, ctx.siteUrl);
  if (!ctx.skipMerge && (!ctx.preview || ctx.subscriber)) html = applyMerge(html, vars);
  const text = htmlToText(html);
  return { html, text, bytes: new TextEncoder().encode(html).length, paywalled: st.paywalled, headings: st.headings };
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => `${stripTags(t)} (${href})`)
    .replace(/<\/(p|h\d|li|tr|div|blockquote|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export interface EmailShell {
  pub: Publication;
  style?: StyleTokens;
  title?: string;
  subtitle?: string;
  byline?: string;
  preheader?: string;
  webUrl?: string | null;
  unsubscribeUrl?: string;
  preferencesUrl?: string;
  thumbnail?: string | null;
  hideHeader?: boolean;
  extraFooter?: string;
}

/** Wrap rendered body in a full table-based email document (Outlook-safe). */
export function emailLayout(body: string, o: EmailShell): string {
  const s = o.style || styleFor(o.pub);
  const pre = o.preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${s.bg};opacity:0">${esc(o.preheader)}${'&#847;&zwnj;&nbsp;'.repeat(60)}</div>` : '';
  const header = o.hideHeader
    ? ''
    : `<tr><td style="padding:24px 24px 8px;font-family:${s.font}">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td align="left">${o.pub.logo_url ? `<img src="${esc(o.pub.logo_url)}" height="36" alt="${esc(o.pub.name)}" style="display:block;height:36px;width:auto;border:0">` : `<span style="font-size:18px;font-weight:800;color:${s.text}">${esc(o.pub.name)}</span>`}</td>
          ${o.webUrl ? `<td align="right" style="font-size:12px"><a href="${esc(o.webUrl)}" style="color:${s.muted}">Read online</a></td>` : ''}
        </tr></table></td></tr>
      ${o.title ? `<tr><td style="padding:12px 24px 0;font-family:${s.heading_font}"><h1 style="margin:0;font-size:30px;line-height:1.2;font-weight:800;color:${s.text}">${esc(o.title)}</h1>${o.subtitle ? `<p style="margin:8px 0 0;font-size:18px;line-height:1.4;color:${s.muted}">${esc(o.subtitle)}</p>` : ''}${o.byline ? `<p style="margin:12px 0 0;font-size:13px;color:${s.muted}">${esc(o.byline)}</p>` : ''}</td></tr>` : ''}
      ${o.thumbnail ? `<tr><td style="padding:16px 24px 0"><img src="${esc(o.thumbnail)}" width="${s.width - 48}" alt="" style="display:block;width:100%;height:auto;border-radius:${s.radius}px"></td></tr>` : ''}`;
  const footer = `<tr><td style="padding:24px;border-top:1px solid ${s.border};font-family:${s.font};font-size:12px;line-height:1.6;color:${s.muted};text-align:center">
      ${o.pub.footer_html ? `<div style="margin-bottom:10px">${sanitizeHtml(o.pub.footer_html, { blocks: true, styles: true })}</div>` : ''}
      ${o.extraFooter || ''}
      ${o.pub.address ? `<div>${esc(o.pub.address)}</div>` : ''}
      <div style="margin-top:8px">${o.preferencesUrl ? `<a href="${esc(o.preferencesUrl)}" style="color:${s.muted}">Manage preferences</a> · ` : ''}${o.unsubscribeUrl ? `<a href="${esc(o.unsubscribeUrl)}" style="color:${s.muted}">Unsubscribe</a>` : ''}</div>
    </td></tr>`;
  return `<!DOCTYPE html><html lang="${esc(o.pub.language || 'en')}" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light"><title>${esc(o.title || o.pub.name)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><style>td,th,div,p,a,h1,h2,h3,h4{font-family:Arial,sans-serif!important}</style><![endif]-->
<style>a{color:${s.link}}img{-ms-interpolation-mode:bicubic}@media only screen and (max-width:620px){.oh-wrap{width:100%!important}.oh-col{display:block!important;width:100%!important;padding:0!important}h1{font-size:26px!important}}</style></head>
<body style="margin:0;padding:0;background:${s.bg};-webkit-text-size-adjust:100%">${pre}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${s.bg}" style="background:${s.bg}"><tr><td align="center" style="padding:24px 8px">
<!--[if mso]><table role="presentation" width="${s.width}" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" class="oh-wrap" width="${s.width}" cellpadding="0" cellspacing="0" border="0" bgcolor="${s.content_bg}" style="width:${s.width}px;max-width:100%;background:${s.content_bg};border-radius:${s.radius}px">
${header}
<tr><td style="padding:20px 24px 8px;font-family:${s.font};font-size:${s.font_size}px;line-height:${s.line_height};color:${s.text}">${body}</td></tr>
${footer}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
}

export const GMAIL_CLIP_BYTES = 102 * 1024;
