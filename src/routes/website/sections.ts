// Page-builder sections: schema + server-side rendering (public pages, home override, live preview).
// page.content = { sections: Section[] }. Each section = { id, type, data, style }.
import type { Ctx, Env, Publication } from '../../types';
import { all, one, run } from '../../lib/db';
import { renderDoc, parseEmbed, type Doc } from '../../lib/render';
import { sanitizeHtml } from '../../lib/sanitize';
import { siteUrl } from '../../lib/pub';
import { esc, fmtDate, money, now, parseJSON, stripTags, truncate, HOUR } from '../../lib/util';

export interface Section { id: string; type: string; data: any; style?: SectionStyle }
export interface SectionStyle { bg?: string; color?: string; padding?: 'none' | 'sm' | 'md' | 'lg' | 'xl'; align?: 'left' | 'center' | 'right'; width?: 'narrow' | 'normal' | 'wide' | 'full'; bg_image?: string }

export const SECTION_TYPES: Record<string, string> = {
  hero: 'Hero', text: 'Rich text', image: 'Image', grid: 'Image grid', carousel: 'Image carousel', posts: 'Posts feed', subscribe: 'Subscribe form',
  testimonials: 'Testimonials', faq: 'FAQ', pricing: 'Pricing tiers', cta: 'Call to action', columns: 'Columns', video: 'Video', youtube: 'YouTube channel (auto-updates)',
  podcast: 'Podcast episodes', products: 'Products grid', events: 'Events list', html: 'Custom HTML / widget', spacer: 'Spacer',
};

const PAD: Record<string, string> = { none: '0', sm: '20px', md: '40px', lg: '64px', xl: '96px' };
const WIDTH: Record<string, string> = { narrow: '720px', normal: 'var(--maxw)', wide: '1280px', full: 'none' };

export function parseSections(json: string | null | undefined): Section[] {
  const d = parseJSON<any>(json, { sections: [] });
  return Array.isArray(d?.sections) ? d.sections : [];
}

function wrap(s: Section, inner: string, first: boolean): string {
  const st = s.style || {};
  const css = [
    st.bg ? `background:${cssv(st.bg)}` : '',
    st.bg_image ? `background-image:url('${cssv(st.bg_image)}');background-size:cover;background-position:center` : '',
    st.color ? `color:${cssv(st.color)}` : '',
    `padding:${PAD[st.padding || 'md'] || '40px'} 0`,
    st.align ? `text-align:${st.align}` : '',
  ].filter(Boolean).join(';');
  const maxw = WIDTH[st.width || 'normal'];
  return `<section class="pb pb-${esc(s.type)}${first ? ' pb-first' : ''}" id="s-${esc(s.id)}" style="${css}"><div class="pb-in" style="max-width:${maxw};${st.width === 'full' ? 'padding:0' : ''}">${inner}</div></section>`;
}

function cssv(v: string) {
  return String(v).replace(/[;"'<>{}\\]/g, '');
}

function img(src: string, alt: string, first: boolean, extra = '') {
  return `<img src="${esc(src)}" alt="${esc(alt || '')}" ${first ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" ${extra}>`;
}

function subscribeForm(base: string, label = 'Subscribe', source = 'page') {
  return `<form method="post" action="${esc(base)}/subscribe" class="s-form s-subscribe pb-form" data-subscribe><input type="email" name="email" placeholder="you@example.com" required autocomplete="email"><input type="text" name="website" class="s-hp" tabindex="-1" autocomplete="off" aria-hidden="true"><input type="hidden" name="_t" value="${Date.now()}"><input type="hidden" name="source" value="${esc(source)}"><input type="hidden" name="utm" value="" data-utm><button class="s-btn">${esc(label)}</button></form>`;
}

// ───────── YouTube (auto-updating) ─────────
export async function resolveChannelId(input: string): Promise<string | null> {
  const s = (input || '').trim();
  if (/^UC[\w-]{20,}$/.test(s)) return s;
  const m = s.match(/channel\/(UC[\w-]{20,})/);
  if (m) return m[1];
  const handle = s.match(/@([\w.-]+)/)?.[1] || (/^[\w.-]+$/.test(s) ? s : null);
  if (!handle) return null;
  try {
    const r = await fetch(`https://www.youtube.com/@${handle}`, { headers: { 'user-agent': 'Mozilla/5.0 (OpenHive)' } });
    const html = await r.text();
    return html.match(/"(?:channelId|externalId)":"(UC[\w-]{20,})"/)?.[1] || null;
  } catch {
    return null;
  }
}

export async function youtubeVideos(env: Env, channelId: string): Promise<Array<{ id: string; title: string; published: string }>> {
  const cached = await one<{ videos: string; fetched_at: number }>(env, 'SELECT videos, fetched_at FROM youtube_cache WHERE channel_id = ?', channelId);
  if (cached && now() - cached.fetched_at < HOUR) return parseJSON(cached.videos, []);
  try {
    const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, { headers: { 'user-agent': 'OpenHive/1.0' } });
    if (!r.ok) throw new Error('feed ' + r.status);
    const xml = await r.text();
    const title = xml.match(/<title>([^<]*)<\/title>/)?.[1] || '';
    const videos = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => ({
      id: m[1].match(/<yt:videoId>([^<]+)</)?.[1] || '',
      title: decodeXml(m[1].match(/<title>([^<]*)</)?.[1] || ''),
      published: m[1].match(/<published>([^<]+)</)?.[1] || '',
    })).filter((v) => v.id);
    await run(env, 'INSERT OR REPLACE INTO youtube_cache (channel_id, title, videos, fetched_at) VALUES (?, ?, ?, ?)', channelId, title, JSON.stringify(videos), now());
    return videos;
  } catch {
    return cached ? parseJSON(cached.videos, []) : [];
  }
}

function decodeXml(s: string) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// ───────── post cards (shared with home/archive) ─────────
export interface CardPost { id: string; slug: string; title: string; subtitle: string; thumbnail_url: string | null; published_at: number | null; audience: string; authors?: string; content?: string }

export function postCard(base: string, p: CardPost, first = false, tz = 'UTC'): string {
  const premium = p.audience === 'premium' || /"type":\s*"paywall"/.test(p.content || '');
  return `<a class="s-card" href="${esc(base)}/p/${esc(p.slug)}">${p.thumbnail_url ? img(p.thumbnail_url, '', first, 'class="s-card-img" width="640" height="360"') : `<div class="s-card-img s-card-ph" aria-hidden="true"></div>`}<div class="s-card-b"><h3>${esc(p.title || 'Untitled')}</h3>${p.subtitle ? `<p>${esc(truncate(p.subtitle, 160))}</p>` : ''}<div class="s-meta">${p.authors ? `<span>${esc(p.authors)}</span><span>·</span>` : ''}<time datetime="${new Date(p.published_at || 0).toISOString()}">${fmtDate(p.published_at, { dateStyle: 'medium' }, tz)}</time>${premium ? '<span class="s-lock">🔒 Premium</span>' : ''}</div></div></a>`;
}

export async function withAuthors(env: Env, posts: CardPost[]): Promise<CardPost[]> {
  if (!posts.length) return posts;
  const rows = await all<{ post_id: string; name: string }>(env, `SELECT pa.post_id, u.name FROM post_authors pa JOIN users u ON u.id = pa.user_id WHERE pa.post_id IN (${posts.map(() => '?').join(',')}) ORDER BY pa.position`, ...posts.map((p) => p.id));
  const m = new Map<string, string[]>();
  for (const r of rows) m.set(r.post_id, [...(m.get(r.post_id) || []), r.name]);
  return posts.map((p) => ({ ...p, authors: (m.get(p.id) || []).join(', ') }));
}

export const PUBLIC_POSTS = `status = 'published' AND platform != 'email' AND hide_from_feed = 0`;

// ───────── render ─────────
export async function renderSections(c: Ctx, pub: Publication, sections: Section[]): Promise<string> {
  const env = c.env;
  const base = siteUrl(env, pub);
  const out: string[] = [];
  let i = 0;
  for (const s of sections) {
    const first = i++ === 0;
    try {
      out.push(wrap(s, await renderOne(c, env, pub, base, s, first), first));
    } catch (e: any) {
      out.push(`<!-- section ${esc(s.type)} failed: ${esc(e?.message || e)} -->`);
    }
  }
  return out.join('\n');
}

async function renderOne(c: Ctx, env: Env, pub: Publication, base: string, s: Section, first: boolean): Promise<string> {
  const d = s.data || {};
  switch (s.type) {
    case 'hero': {
      const imgHtml = d.image ? `<div class="pb-hero-img">${img(d.image, '', first, 'width="1200" height="675"')}</div>` : '';
      return `<div class="pb-hero ${d.image && d.layout === 'split' ? 'pb-hero-split' : ''}"><div class="pb-hero-text">${d.eyebrow ? `<p class="pb-eyebrow">${esc(d.eyebrow)}</p>` : ''}<h1>${esc(d.title || pub.name)}</h1>${d.subtitle ? `<p class="pb-lead">${esc(d.subtitle)}</p>` : ''}${d.show_form !== false ? subscribeForm(base, d.button || 'Subscribe', 'page-hero') : ''}${d.cta_label && d.cta_url ? `<p><a class="s-btn s-btn-ghost" href="${esc(d.cta_url)}">${esc(d.cta_label)}</a></p>` : ''}</div>${imgHtml}</div>`;
    }
    case 'text': {
      if (d.doc && Array.isArray(d.doc.blocks)) {
        const reader = c.get('reader');
        const r = await renderDoc(d.doc as Doc, { env, mode: 'web', pub, siteUrl: base, subscriber: reader?.subscriber ?? null, access: !!reader?.premium });
        return `<div class="s-body pb-text">${r.html}</div>`;
      }
      return `<div class="s-body pb-text">${sanitizeHtml(d.html || '', { blocks: true, styles: true })}</div>`;
    }
    case 'image': {
      if (!d.src) return '';
      const im = img(d.src, d.alt, first, `style="border-radius:var(--radius)"`);
      return `<figure class="pb-figure">${d.link ? `<a href="${esc(d.link)}">${im}</a>` : im}${d.caption ? `<figcaption>${esc(d.caption)}</figcaption>` : ''}</figure>`;
    }
    case 'grid': {
      const imgs = (d.images || []) as any[];
      return `${d.title ? `<h2>${esc(d.title)}</h2>` : ''}<div class="oh-grid" style="--cols:${Math.min(6, Number(d.columns) || 3)}">${imgs.map((x, k) => `<figure>${x.link ? `<a href="${esc(x.link)}">` : ''}${img(x.src, x.alt, first && k === 0)}${x.link ? '</a>' : ''}${x.caption ? `<figcaption>${esc(x.caption)}</figcaption>` : ''}</figure>`).join('')}</div>`;
    }
    case 'carousel': {
      const imgs = (d.images || []) as any[];
      return `${d.title ? `<h2>${esc(d.title)}</h2>` : ''}<div class="oh-carousel pb-carousel" data-carousel>${imgs.map((x, k) => `<figure>${img(x.src, x.alt, first && k === 0)}${x.caption ? `<figcaption>${esc(x.caption)}</figcaption>` : ''}</figure>`).join('')}</div>${imgs.length > 1 ? '<div class="pb-carousel-nav"><button type="button" data-carousel-prev aria-label="Previous">‹</button><button type="button" data-carousel-next aria-label="Next">›</button></div>' : ''}`;
    }
    case 'posts': {
      const n = Math.min(24, Number(d.count) || 6);
      let rows: CardPost[];
      if (d.tag) {
        rows = await all<CardPost>(env, `SELECT p.id, p.slug, p.title, p.subtitle, p.thumbnail_url, p.published_at, p.audience, p.content FROM posts p JOIN post_tags pt ON pt.post_id = p.id JOIN content_tags t ON t.id = pt.tag_id WHERE p.pub_id = ? AND t.slug = ? AND p.${PUBLIC_POSTS.replace(/AND /g, 'AND p.')} ORDER BY p.published_at DESC LIMIT ?`, pub.id, d.tag, n);
      } else rows = await all<CardPost>(env, `SELECT id, slug, title, subtitle, thumbnail_url, published_at, audience, content FROM posts WHERE pub_id = ? AND ${PUBLIC_POSTS} ORDER BY published_at DESC LIMIT ?`, pub.id, n);
      rows = await withAuthors(env, rows);
      if (!rows.length) return `${d.title ? `<h2>${esc(d.title)}</h2>` : ''}<p class="s-muted">No posts yet.</p>`;
      return `${d.title ? `<h2>${esc(d.title)}</h2>` : ''}<div class="s-posts ${d.layout === 'list' ? 's-posts-list' : ''}">${rows.map((p, k) => postCard(base, p, first && k === 0, pub.timezone)).join('')}</div><p class="pb-more"><a href="${esc(base)}/archive">View all posts →</a></p>`;
    }
    case 'subscribe':
      return `<div class="s-subscribe-box pb-subscribe"><h2>${esc(d.title || `Subscribe to ${pub.name}`)}</h2>${d.body ? `<p class="s-muted">${esc(d.body)}</p>` : ''}${subscribeForm(base, d.button || 'Subscribe', 'page-form')}</div>`;
    case 'testimonials': {
      const items = (d.items || []) as any[];
      return `${d.title ? `<h2>${esc(d.title)}</h2>` : ''}<div class="pb-testimonials">${items.map((t) => `<blockquote class="pb-quote"><p>“${esc(t.quote)}”</p><footer>${t.avatar ? img(t.avatar, '', false, 'width="40" height="40"') : ''}<span><strong>${esc(t.name)}</strong>${t.role ? `<small>${esc(t.role)}</small>` : ''}</span></footer></blockquote>`).join('')}</div>`;
    }
    case 'faq': {
      const items = (d.items || []) as any[];
      return `${d.title ? `<h2>${esc(d.title)}</h2>` : ''}<div class="pb-faq">${items.map((f) => `<details><summary>${esc(f.q)}</summary><div>${esc(f.a).replace(/\n/g, '<br>')}</div></details>`).join('')}</div>`;
    }
    case 'pricing': {
      const tiers = await all<any>(env, `SELECT * FROM tiers WHERE pub_id = ? AND status = 'active' ORDER BY position, monthly_cents`, pub.id);
      const free = `<div class="s-tier"><h3>Free</h3><div class="s-price">${money(0)}<small> / month</small></div><ul><li>The newsletter in your inbox</li><li>Free posts on the web</li></ul><button type="button" class="s-btn s-btn-ghost" data-modal="subscribe">Subscribe free</button></div>`;
      return `${d.title ? `<h2>${esc(d.title)}</h2>` : ''}${d.body ? `<p class="s-muted">${esc(d.body)}</p>` : ''}<div class="s-grid pb-pricing">${d.show_free !== false ? free : ''}${tiers.map((t, k) => `<div class="s-tier ${k === 0 ? 'featured' : ''}"><h3>${esc(t.name)}</h3><div class="s-price">${money(t.monthly_cents, t.currency)}<small> / month</small></div>${t.annual_cents ? `<p class="s-muted s-small">or ${money(t.annual_cents, t.currency)} / year</p>` : ''}${t.description ? `<p class="s-muted">${esc(t.description)}</p>` : ''}<ul>${parseJSON<string[]>(t.benefits, []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>${t.trial_days ? `<p class="s-small">${t.trial_days}-day ${t.paid_trial_cents ? `trial for ${money(t.paid_trial_cents, t.currency)}` : 'free trial'}</p>` : ''}<a class="s-btn" href="${esc(base)}/upgrade?tier=${esc(t.id)}">Choose ${esc(t.name)}</a></div>`).join('')}</div>`;
    }
    case 'cta':
      return `<div class="pb-cta"><h2>${esc(d.title || '')}</h2>${d.body ? `<p class="pb-lead">${esc(d.body)}</p>` : ''}${d.label ? `<a class="s-btn" href="${esc(d.url || '#')}">${esc(d.label)}</a>` : ''}</div>`;
    case 'columns': {
      const cols = (d.columns || []) as any[];
      return `<div class="pb-columns" style="--n:${Math.max(1, Math.min(4, cols.length))}">${cols.map((col) => `<div class="pb-col">${col.image ? img(col.image, '', false) : ''}${col.title ? `<h3>${esc(col.title)}</h3>` : ''}${col.body ? `<div class="s-muted">${sanitizeHtml(String(col.body).replace(/\n/g, '<br>'), { blocks: true })}</div>` : ''}${col.link && col.label ? `<a href="${esc(col.link)}">${esc(col.label)} →</a>` : ''}</div>`).join('')}</div>`;
    }
    case 'video': {
      const e = parseEmbed(d.url || '');
      if (e?.provider === 'youtube') return `${d.title ? `<h2>${esc(d.title)}</h2>` : ''}<div class="pb-video"><iframe src="https://www.youtube-nocookie.com/embed/${esc(e.id)}" title="${esc(d.title || 'Video')}" loading="lazy" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>`;
      if (e?.provider === 'vimeo') return `<div class="pb-video"><iframe src="https://player.vimeo.com/video/${esc(e.id)}" loading="lazy" allowfullscreen></iframe></div>`;
      if (d.url) return `<video class="pb-video-el" src="${esc(d.url)}" controls playsinline preload="metadata"></video>`;
      return '';
    }
    case 'youtube': {
      const ch = d.channel_id ? (/^UC/.test(d.channel_id) ? d.channel_id : await resolveChannelId(d.channel_id)) : null;
      if (!ch) return `<p class="s-muted">Add a YouTube channel to show its latest videos.</p>`;
      const vids = (await youtubeVideos(env, ch)).slice(0, Math.min(15, Number(d.count) || 6));
      if (!vids.length) return `<p class="s-muted">No videos found for this channel yet.</p>`;
      const [lead, ...rest] = vids;
      return `${d.title ? `<h2>${esc(d.title)}</h2>` : ''}${d.feature_latest !== false ? `<div class="pb-video"><iframe src="https://www.youtube-nocookie.com/embed/${esc(lead.id)}" title="${esc(lead.title)}" loading="lazy" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div><p class="pb-video-title">${esc(lead.title)}</p>` : ''}<div class="pb-yt-grid">${(d.feature_latest !== false ? rest : vids).map((v) => `<a class="pb-yt" href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener">${img(`https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`, '', false, 'width="320" height="180"')}<span>${esc(v.title)}</span><small>${fmtDate(Date.parse(v.published))}</small></a>`).join('')}</div><p class="pb-more"><a href="https://www.youtube.com/channel/${esc(ch)}" target="_blank" rel="noopener">More on YouTube →</a></p>`;
    }
    case 'podcast': {
      const n = Math.min(20, Number(d.count) || 5);
      const eps = await all<any>(env, `SELECT e.*, p.slug AS pslug, p.title AS ptitle, p.cover_url FROM episodes e JOIN podcasts p ON p.id = e.podcast_id WHERE e.pub_id = ? AND e.status = 'published' ${d.podcast_id ? 'AND e.podcast_id = ?' : ''} ORDER BY e.published_at DESC LIMIT ?`, pub.id, ...(d.podcast_id ? [d.podcast_id] : []), n);
      if (!eps.length) return `${d.title ? `<h2>${esc(d.title)}</h2>` : ''}<p class="s-muted">No episodes yet.</p>`;
      return `${d.title ? `<h2>${esc(d.title)}</h2>` : ''}<div class="pb-episodes">${eps.map((e) => `<a class="pb-episode" href="${esc(base)}/podcasts/${esc(e.pslug)}/${esc(e.slug)}">${e.image_url || e.cover_url ? img(e.image_url || e.cover_url, '', false, 'width="72" height="72"') : ''}<span><small>${esc(e.ptitle)} · ${fmtDate(e.published_at)}</small><strong>${esc(e.title)}</strong><em>${esc(truncate(stripTags(e.description || ''), 140))}</em></span></a>`).join('')}</div><p class="pb-more"><a href="${esc(base)}/podcasts">All episodes →</a></p>`;
    }
    case 'products': {
      const n = Math.min(24, Number(d.count) || 6);
      const rows = await all<any>(env, `SELECT * FROM products WHERE pub_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT ?`, pub.id, n);
      if (!rows.length) return `${d.title ? `<h2>${esc(d.title)}</h2>` : ''}<p class="s-muted">No products yet.</p>`;
      return `${d.title ? `<h2>${esc(d.title)}</h2>` : ''}<div class="s-posts">${rows.map((p) => `<a class="s-card" href="${esc(base)}/shop/${esc(p.slug)}">${p.cover_url ? img(p.cover_url, '', false, 'class="s-card-img" width="640" height="360"') : '<div class="s-card-img s-card-ph"></div>'}<div class="s-card-b"><h3>${esc(p.name)}</h3><p>${esc(truncate(stripTags(p.description || ''), 120))}</p><div class="s-meta"><strong>${p.price_cents ? money(p.price_cents, p.currency) : 'Free'}</strong></div></div></a>`).join('')}</div><p class="pb-more"><a href="${esc(base)}/shop">Visit the shop →</a></p>`;
    }
    case 'events': {
      const n = Math.min(20, Number(d.count) || 4);
      const rows = await all<any>(env, `SELECT * FROM live_events WHERE pub_id = ? AND status = 'published' AND ends_at > ? ORDER BY starts_at LIMIT ?`, pub.id, now(), n);
      if (!rows.length) return `${d.title ? `<h2>${esc(d.title)}</h2>` : ''}<p class="s-muted">No upcoming events.</p>`;
      return `${d.title ? `<h2>${esc(d.title)}</h2>` : ''}<div class="pb-events">${rows.map((e) => `<a class="pb-event" href="${esc(base)}/events/${esc(e.slug)}"><span class="pb-date"><b>${fmtDate(e.starts_at, { day: 'numeric' }, e.timezone)}</b>${fmtDate(e.starts_at, { month: 'short' }, e.timezone)}</span><span><strong>${esc(e.title)}</strong><small>${fmtDate(e.starts_at, { weekday: 'short', hour: 'numeric', minute: '2-digit' }, e.timezone)} · ${e.price_cents ? money(e.price_cents, e.currency) : 'Free'}</small></span></a>`).join('')}</div>`;
    }
    case 'html': {
      if (d.sandbox) {
        const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:system-ui,sans-serif}</style></head><body>${String(d.html || '')}</body></html>`;
        return `<iframe class="pb-widget" sandbox="allow-scripts" srcdoc="${esc(doc)}" style="height:${Math.max(80, Math.min(2000, Number(d.height) || 360))}px" title="${esc(d.title || 'Widget')}" loading="lazy"></iframe>`;
      }
      return `<div class="oh-html">${sanitizeHtml(d.html || '', { blocks: true, media: true, styles: true })}</div>`;
    }
    case 'spacer':
      return `<div style="height:${Math.max(0, Math.min(400, Number(d.height) || 48))}px"></div>`;
    default:
      return '';
  }
}

/** Built-in page template library (used in "New page", the page gallery and the AI fallback). Section bg colors use theme variables so they fit every theme. */
export interface StarterPage { title: string; slug: string; description: string; category: string; sections: Omit<Section, 'id'>[] }

let _k = 0;
const tb = (type: string, data: any) => ({ id: `t${++_k}`, type, data });
const doc = (...blocks: any[]) => ({ doc: { blocks } });
const P = (html: string, align?: string) => tb('paragraph', align ? { html, align } : { html });
const H = (level: number, html: string, align?: string) => tb('heading', align ? { level, html, align } : { level, html });
const LINK = (label: string, url: string) => tb('button', { label, url, align: 'center' });
const SURFACE = 'var(--surface)';

export const STARTER_PAGES: Record<string, StarterPage> = {
  landing: {
    title: 'Home', slug: '', category: 'Landing', description: 'Conversion-focused home page: bold hero with signup, benefits, latest posts, social proof and a final call to subscribe.', sections: [
      { type: 'hero', data: { eyebrow: 'A weekly newsletter', title: 'Smart, short, and worth your inbox', subtitle: 'Join thousands of readers who get the best ideas in our field every week — in five minutes or less.', show_form: true, button: 'Subscribe free' }, style: { padding: 'xl', align: 'center' } },
      { type: 'columns', data: { columns: [{ title: '📬 One email a week', body: 'A single, carefully edited issue every Tuesday. No spam, ever.' }, { title: '⏱ Five-minute reads', body: 'Everything that matters, nothing that doesn’t. Read it with your coffee.' }, { title: '💬 A real community', body: 'Reply to any issue — we read every message and feature the best ones.' }] }, style: { padding: 'lg', align: 'center', bg: SURFACE } },
      { type: 'posts', data: { title: 'Latest posts', count: 6 }, style: { padding: 'lg' } },
      { type: 'testimonials', data: { title: 'What readers say', items: [{ quote: 'The one newsletter I read every single week.', name: 'Alex Rivera', role: 'Product designer' }, { quote: 'Smarter than anything in my feed — and shorter.', name: 'Priya Shah', role: 'Founder' }, { quote: 'I forward it to my team every Tuesday.', name: 'Sam Lee', role: 'Engineering manager' }] }, style: { padding: 'lg', bg: SURFACE } },
      { type: 'subscribe', data: { title: 'Get the next issue', body: 'Free, every week. Unsubscribe anytime.' }, style: { padding: 'lg', width: 'narrow' } },
    ],
  },
  archive_landing: {
    title: 'Read', slug: 'read', category: 'Landing', description: 'Content-first archive landing: compact hero, the full feed in list layout, topic columns and a subscribe box.', sections: [
      { type: 'hero', data: { eyebrow: 'The archive', title: 'Every issue, in one place', subtitle: 'Browse everything we’ve published — or get new issues straight to your inbox.', show_form: true, button: 'Subscribe' }, style: { padding: 'lg', align: 'center' } },
      { type: 'posts', data: { title: 'Most recent', count: 12, layout: 'list' }, style: { padding: 'md', width: 'narrow' } },
      { type: 'columns', data: { columns: [{ title: 'Deep dives', body: 'Long-form analysis of the ideas shaping our field.', label: 'Browse', link: 'archive' }, { title: 'Interviews', body: 'Conversations with the people doing the work.', label: 'Browse', link: 'archive' }, { title: 'Guides', body: 'Practical, step-by-step how-tos you can use today.', label: 'Browse', link: 'archive' }] }, style: { padding: 'lg', bg: SURFACE } },
      { type: 'subscribe', data: { title: 'Never miss an issue', body: 'Join free. One email a week.' }, style: { padding: 'lg', width: 'narrow' } },
    ],
  },
  about: {
    title: 'About', slug: 'about', category: 'Company', description: 'Tell your story: mission hero, the why behind the newsletter, what readers get, who writes it, FAQ and signup.', sections: [
      { type: 'hero', data: { eyebrow: 'About us', title: 'Why this newsletter exists', subtitle: 'We started writing because the conversation we wanted to read didn’t exist yet.', show_form: false }, style: { padding: 'xl', align: 'center' } },
      { type: 'text', data: doc(H(2, 'Our story'), P('Tell readers who you are, what you noticed that nobody else was saying, and the moment you decided to start writing. Two or three short paragraphs is plenty.'), P('Then make a promise: what will a reader know, feel or be able to do after a few months of reading?')), style: { width: 'narrow', padding: 'md' } },
      { type: 'columns', data: { columns: [{ title: 'Independent', body: 'Reader-supported and free of corporate agendas.' }, { title: 'Researched', body: 'Every claim is sourced. Every source is linked.' }, { title: 'Useful', body: 'Each issue ends with something you can act on.' }] }, style: { padding: 'lg', align: 'center', bg: SURFACE } },
      { type: 'text', data: doc(H(2, 'Who writes it'), P('<b>Your Name</b> — one line on your background and why readers should trust you on this topic. Add co-writers and contributors here too.')), style: { width: 'narrow', padding: 'md' } },
      { type: 'faq', data: { title: 'Frequently asked questions', items: [{ q: 'How often do you publish?', a: 'Every week, on Tuesday morning.' }, { q: 'Is it free?', a: 'Yes. An optional premium membership unlocks deep dives and the full archive.' }, { q: 'Can I write for you?', a: 'We feature guest writers every month — reply to any issue with your pitch.' }] }, style: { width: 'narrow' } },
      { type: 'subscribe', data: { title: 'Join the readers', body: 'Free, every week.' }, style: { width: 'narrow', padding: 'lg' } },
    ],
  },
  start_here: {
    title: 'Start here', slug: 'start-here', category: 'Company', description: 'Onboard new visitors: what this is, the three best posts to read first, reading paths by interest and how to get involved.', sections: [
      { type: 'hero', data: { eyebrow: 'New here?', title: 'Start here', subtitle: 'The fastest way to get the most out of this newsletter — in about ten minutes.', show_form: false }, style: { padding: 'lg', align: 'center' } },
      { type: 'text', data: doc(H(2, '1. What this is'), P('One paragraph: the topic, the reader it’s for, and how often it arrives. Link to the About page for the longer story.'), H(2, '2. Read these three first'), P('Hand-pick the posts that best represent your work. Most readers who read these become regulars.')), style: { width: 'narrow', padding: 'md' } },
      { type: 'columns', data: { columns: [{ title: 'The classic', body: 'The post that explains our core idea.', label: 'Read it', link: 'archive' }, { title: 'The reader favorite', body: 'Our most-shared issue of all time.', label: 'Read it', link: 'archive' }, { title: 'The practical one', body: 'A guide you can use today.', label: 'Read it', link: 'archive' }] }, style: { padding: 'lg', bg: SURFACE } },
      { type: 'text', data: doc(H(2, '3. Pick your path'), P('<b>If you’re new to the topic:</b> start with the beginner’s guide and the glossary.'), P('<b>If you’re a practitioner:</b> the interview series and teardown issues are for you.'), P('<b>If you’re a leader:</b> read the monthly strategy deep dives.')), style: { width: 'narrow', padding: 'md' } },
      { type: 'cta', data: { title: '4. Get the next issue', body: 'Subscribe free and reply to the welcome email — we read every response.', label: 'Subscribe free', url: 'subscribe' }, style: { padding: 'lg', bg: SURFACE } },
    ],
  },
  sponsor: {
    title: 'Advertise with us', slug: 'advertise', category: 'Business', description: 'Media-kit page for sponsors: audience stats, who reads, placements & pricing table, sponsor testimonials, FAQ and a booking CTA.', sections: [
      { type: 'hero', data: { eyebrow: 'Partner with us', title: 'Reach readers who actually read', subtitle: 'Put your brand in front of an engaged, high-intent audience — in the inbox and on the web.', show_form: false, cta_label: 'Book a placement', cta_url: 'sponsor' }, style: { padding: 'xl', align: 'center' } },
      { type: 'columns', data: { columns: [{ title: '25,000+', body: 'Subscribers, growing 8% month over month' }, { title: '54%', body: 'Average open rate (bot-filtered)' }, { title: '6.1%', body: 'Average click rate on sponsor slots' }, { title: '72%', body: 'Readers in decision-making roles' }] }, style: { padding: 'lg', align: 'center', bg: SURFACE } },
      { type: 'text', data: doc(H(2, 'Who reads'), P('Describe your audience in concrete terms: job titles, industries, company sizes, geography and what they buy. Sponsors care about fit more than size.'), H(2, 'Placements'), tb('table', { header: true, rows: [['Placement', 'What you get', 'Price'], ['Primary sponsor', 'Top-of-issue placement with image, 100 words and CTA', '$1,200 / issue'], ['Secondary sponsor', 'Mid-issue text placement, 50 words', '$600 / issue'], ['Classified', 'One line with link near the end', '$200 / issue'], ['Dedicated send', 'A full email written with you', '$3,500']] }), P('Multi-issue packages get 10–20% off. Prices include a performance report after each send.')), style: { width: 'narrow', padding: 'md' } },
      { type: 'testimonials', data: { title: 'What sponsors say', items: [{ quote: 'Our best-performing newsletter placement this year, by a wide margin.', name: 'Jordan Kim', role: 'Head of Growth, Acme' }, { quote: 'Clicks turned into customers. We booked the next quarter on the spot.', name: 'Maria Lopez', role: 'Marketing Lead, Brightside' }] }, style: { padding: 'lg', bg: SURFACE } },
      { type: 'faq', data: { title: 'Sponsor FAQ', items: [{ q: 'How far in advance should I book?', a: 'Slots usually fill 3–4 weeks out. Book early for launches.' }, { q: 'Do you write the copy?', a: 'You can send copy, or we can write it in our voice — readers respond better to that.' }, { q: 'What reporting do I get?', a: 'Opens, unique clicks (bot-filtered) and click-through rate within 72 hours.' }] }, style: { width: 'narrow' } },
      { type: 'cta', data: { title: 'Ready to reach our readers?', body: 'Tell us about your product and goals — we reply within one business day.', label: 'Book a placement', url: 'sponsor' }, style: { padding: 'lg' } },
    ],
  },
  podcast: {
    title: 'Podcast', slug: 'listen', category: 'Media', description: 'Show home page: split hero, latest episodes (auto-updating), where to listen, listener reviews and newsletter signup.', sections: [
      { type: 'hero', data: { eyebrow: 'The podcast', title: 'Conversations worth your commute', subtitle: 'Weekly interviews with the people building what’s next. New episodes every Thursday.', show_form: false, cta_label: 'Listen to the latest', cta_url: 'podcasts' }, style: { padding: 'xl', align: 'center' } },
      { type: 'podcast', data: { title: 'Latest episodes', count: 6 }, style: { padding: 'lg', width: 'narrow' } },
      { type: 'columns', data: { columns: [{ title: '🎧 Apple Podcasts', body: 'Subscribe and leave a review.', label: 'Open', link: 'https://podcasts.apple.com' }, { title: '🟢 Spotify', body: 'Follow the show to get every episode.', label: 'Open', link: 'https://open.spotify.com' }, { title: '📡 RSS', body: 'Use any podcast app you like.', label: 'Get the feed', link: 'podcasts' }] }, style: { padding: 'lg', align: 'center', bg: SURFACE } },
      { type: 'testimonials', data: { title: 'Listener reviews', items: [{ quote: 'The only show I never skip.', name: '★★★★★ on Apple Podcasts' }, { quote: 'Great guests, sharper questions.', name: '★★★★★ on Spotify' }] }, style: { padding: 'lg' } },
      { type: 'subscribe', data: { title: 'Get show notes by email', body: 'Every episode’s notes, links and timestamps in your inbox.' }, style: { padding: 'lg', width: 'narrow', bg: SURFACE } },
    ],
  },
  events: {
    title: 'Events', slug: 'meetups', category: 'Media', description: 'Events hub: hero, auto-updating list of upcoming events, what to expect, past-event photos/testimonials, FAQ and signup for invites.', sections: [
      { type: 'hero', data: { eyebrow: 'Live & online', title: 'Meet the community in person', subtitle: 'Talks, workshops and meetups for readers — online and in cities around the world.', show_form: false, cta_label: 'See upcoming events', cta_url: 'events' }, style: { padding: 'xl', align: 'center' } },
      { type: 'events', data: { title: 'Upcoming events', count: 6 }, style: { padding: 'lg', width: 'narrow' } },
      { type: 'columns', data: { columns: [{ title: 'Small rooms', body: 'Capped at 60 people so everyone actually meets.' }, { title: 'Real talks', body: 'Practitioners, not pitches. Every session has Q&A.' }, { title: 'Replays', body: 'Missed it? Registered readers get the recording.' }] }, style: { padding: 'lg', align: 'center', bg: SURFACE } },
      { type: 'testimonials', data: { title: 'From past attendees', items: [{ quote: 'I met two future colleagues at the last meetup.', name: 'Chris Park', role: 'Attendee, Berlin' }, { quote: 'The best two hours of my month.', name: 'Dana Wu', role: 'Attendee, online' }] }, style: { padding: 'lg' } },
      { type: 'faq', data: { title: 'Event FAQ', items: [{ q: 'Are events free?', a: 'Most are free for subscribers; workshops may have a small ticket price.' }, { q: 'Can I host one in my city?', a: 'Yes! Reply to any issue and tell us where.' }] }, style: { width: 'narrow' } },
      { type: 'subscribe', data: { title: 'Get event invites first', body: 'Subscribers hear about new events before anyone else.' }, style: { padding: 'lg', width: 'narrow', bg: SURFACE } },
    ],
  },
  link_in_bio: {
    title: 'Links', slug: 'links', category: 'Landing', description: 'Link-in-bio landing for social profiles: compact centered profile, stacked link buttons, inline signup and latest posts.', sections: [
      { type: 'hero', data: { title: 'Your Name', subtitle: 'Writer of a weekly newsletter about your topic. Everything I make, in one place 👇', show_form: false }, style: { padding: 'lg', align: 'center', width: 'narrow' } },
      { type: 'text', data: doc(LINK('📬 Subscribe to the newsletter', 'subscribe'), LINK('✨ Start here: my best posts', 'archive'), LINK('🎧 Listen to the podcast', 'podcasts'), LINK('📅 Upcoming events', 'events'), LINK('🛍 Shop guides & templates', 'shop')), style: { width: 'narrow', padding: 'sm', align: 'center' } },
      { type: 'subscribe', data: { title: 'Get the weekly email', body: 'Join free — one email a week.', button: 'Join' }, style: { width: 'narrow', padding: 'md', bg: SURFACE } },
      { type: 'posts', data: { title: 'Latest', count: 3, layout: 'list' }, style: { width: 'narrow', padding: 'md' } },
    ],
  },
  premium: {
    title: 'Go premium', slug: 'premium', category: 'Business', description: 'Upgrade page: value-focused hero, what members get, pricing tiers, member testimonials and a cancellation-friendly FAQ.', sections: [
      { type: 'hero', data: { eyebrow: 'Membership', title: 'Support independent writing', subtitle: 'Unlock every premium post, the full archive, and member-only perks.', show_form: false }, style: { padding: 'xl', align: 'center' } },
      { type: 'columns', data: { columns: [{ title: '🔓 Every deep dive', body: 'Weekly members-only analysis and the full archive.' }, { title: '🧰 Templates & tools', body: 'Downloadable resources you can use right away.' }, { title: '💬 Community', body: 'Comment, join live Q&As and meet other members.' }] }, style: { padding: 'lg', align: 'center', bg: SURFACE } },
      { type: 'pricing', data: { title: 'Choose your plan' }, style: { padding: 'lg' } },
      { type: 'testimonials', data: { title: 'Members say', items: [{ quote: 'Paid for itself in the first month.', name: 'Taylor Brooks', role: 'Member since 2024' }] }, style: { padding: 'lg', bg: SURFACE } },
      { type: 'faq', data: { title: 'Questions', items: [{ q: 'Can I cancel anytime?', a: 'Yes — cancel or pause from your account page in two clicks.' }, { q: 'Do you offer team or student discounts?', a: 'Yes, reply to any email and we’ll sort you out.' }] }, style: { width: 'narrow' } },
    ],
  },
  links: {
    title: 'Watch', slug: 'watch', category: 'Media', description: 'Video & audio hub: auto-updating YouTube channel and latest podcast episodes.', sections: [
      { type: 'hero', data: { title: 'Watch & listen', subtitle: 'Our latest videos and episodes, updated automatically.', show_form: false }, style: { align: 'center' } },
      { type: 'youtube', data: { title: 'Latest videos', channel_id: '', count: 6 } },
      { type: 'podcast', data: { title: 'Latest episodes', count: 5 } },
    ],
  },
};
