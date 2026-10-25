// Shared helpers for the posts module.
import type { Ctx, Env, Post, Publication, Subscriber } from '../../types';
import { one, all, run, insert } from '../../lib/db';
import { parseDoc, renderDoc, styleFor, type Doc, type Block } from '../../lib/render';
import { buildEmail, postContent } from '../../lib/sender';
import { siteUrl } from '../../lib/pub';
import { themeOf } from '../../ui/site';
import { id, now, slugify, stripTags, parseJSON, esc, fmtDate } from '../../lib/util';

export async function loadPost(c: Ctx, postId: string): Promise<Post | null> {
  return one<Post>(c.env, 'SELECT * FROM posts WHERE id = ? AND pub_id = ?', postId, c.get('pub').id);
}

/** Walk every block (including nested children) */
export function walkBlocks(blocks: Block[], fn: (b: Block) => void) {
  for (const b of blocks || []) {
    fn(b);
    const d = b.data || {};
    if (Array.isArray(d.blocks)) walkBlocks(d.blocks, fn);
    if (Array.isArray(d.columns)) for (const col of d.columns) walkBlocks(col.blocks || [], fn);
  }
}

function itemText(it: any): string {
  if (typeof it === 'string') return stripTags(it);
  if (it && typeof it === 'object') return [stripTags(it.html || ''), ...(it.items || []).map(itemText)].join(' ');
  return '';
}

export function docText(doc: Doc): string {
  const out: string[] = [];
  walkBlocks(doc.blocks, (b) => {
    const d = b.data || {};
    if (d.html) out.push(stripTags(d.html));
    if (Array.isArray(d.items)) out.push(...d.items.map(itemText));
    if (d.code) out.push(d.code);
    if (d.caption) out.push(stripTags(d.caption));
    if (Array.isArray(d.rows)) for (const r of d.rows) out.push(...r.map((x: string) => stripTags(x)));
  });
  return out.filter(Boolean).join('\n');
}

export function wordCount(doc: Doc): number {
  const t = docText(doc).trim();
  return t ? t.split(/\s+/).length : 0;
}

export async function uniqueSlug(env: Env, pubId: string, base: string, exceptId?: string): Promise<string> {
  const root = slugify(base || 'untitled');
  let s = root, i = 2;
  while (await one(env, 'SELECT id FROM posts WHERE pub_id = ? AND slug = ? AND id != ?', pubId, s, exceptId || '')) s = `${root}-${i++}`;
  return s;
}

export async function newPost(env: Env, pub: Publication, userId: string, opts: { title?: string; content?: string; style?: string; template_id?: string | null; subtitle?: string } = {}): Promise<string> {
  const pid = id();
  const t = now();
  const title = opts.title || '';
  await insert(env, 'posts', {
    id: pid, pub_id: pub.id, title, subtitle: opts.subtitle || '', slug: await uniqueSlug(env, pub.id, title || 'untitled-' + pid.slice(0, 6)),
    content: opts.content || '{"blocks":[]}', status: 'draft', platform: 'both', audience: 'all', style: opts.style || '{}', template_id: opts.template_id ?? null,
    created_by: userId, created_at: t, updated_at: t,
  });
  await insert(env, 'post_authors', { post_id: pid, user_id: userId, position: 0 });
  return pid;
}

export async function snapshot(env: Env, post: Pick<Post, 'id' | 'title' | 'content'>, userId: string | null) {
  await insert(env, 'post_versions', { id: id(), post_id: post.id, title: post.title, content: post.content, created_by: userId, created_at: now() });
  // keep the 100 most recent versions
  await run(env, `DELETE FROM post_versions WHERE post_id = ? AND id NOT IN (SELECT id FROM post_versions WHERE post_id = ? ORDER BY created_at DESC LIMIT 100)`, post.id, post.id);
}

export interface Simulate { subscriber_id?: string; tier?: 'free' | 'premium'; name?: string; email?: string }

export async function simulatedSubscriber(env: Env, pub: Publication, sim?: Simulate | null): Promise<Subscriber | null> {
  if (!sim) return null;
  if (sim.subscriber_id) {
    const s = await one<Subscriber>(env, 'SELECT * FROM subscribers WHERE id = ? AND pub_id = ?', sim.subscriber_id, pub.id);
    if (s) return s;
  }
  if (!sim.tier && !sim.name && !sim.email) return null;
  return {
    id: 'preview', pub_id: pub.id, email: sim.email || 'reader@example.com', name: sim.name || '', status: 'active', tier: sim.tier || 'free', tier_id: null, trial_ends_at: null,
    source: 'website', source_detail: null, utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null, referrer_url: null, landing_path: null,
    referral_code: 'preview', referred_by: null, referral_count: 0, custom: '{}', country: null, ip: null, stripe_customer_id: null, confirmed_at: now(), unsubscribed_at: null,
    unsubscribe_reason: null, last_open_at: null, last_click_at: null, open_count: 0, click_count: 0, received_count: 0, engagement: 0, created_at: now(), updated_at: now(),
  };
}

/** The linked template's style tokens ({email, web}), or {} when the post has no (visible) template. */
export async function templateStyle(env: Env, pubId: string, templateId: string | null | undefined): Promise<{ email?: Record<string, any>; web?: Record<string, any> }> {
  if (!templateId) return {};
  const t = await one<{ style: string }>(env, 'SELECT style FROM templates WHERE id = ? AND (pub_id IS NULL OR pub_id = ?)', templateId, pubId);
  return parseJSON<any>(t?.style, {}) || {};
}

/**
 * Effective style of a post = template style ⊕ the post's own overrides (publication defaults are applied
 * underneath by styleFor()/themeOf()). Posts store only their overrides, so template edits reach existing posts.
 */
export async function effectiveStyle(env: Env, pubId: string, post: Pick<Post, 'style' | 'template_id'>): Promise<{ email: Record<string, any>; web: Record<string, any> }> {
  const tpl = await templateStyle(env, pubId, post.template_id);
  const own = parseJSON<any>(post.style, {}) || {};
  return { email: { ...(tpl.email || {}), ...(own.email || {}) }, web: { ...(tpl.web || {}), ...(own.web || {}) } };
}

/** Effective web theme for a post page: publication theme ⊕ template web style ⊕ post web overrides. */
export async function postTheme(env: Env, pub: Publication, post: Pick<Post, 'style' | 'template_id'>) {
  return { ...themeOf(pub), ...(await effectiveStyle(env, pub.id, post)).web };
}

/** Render a preview (email = full email document; web = standalone article page with the publication theme). */
export async function renderPreview(env: Env, pub: Publication, post: Post, mode: 'email' | 'web', sim?: Simulate | null): Promise<{ html: string; bytes: number }> {
  const sub = await simulatedSubscriber(env, pub, sim);
  if (mode === 'email') {
    const content = await postContent(env, post);
    const access = sub ? sub.tier === 'premium' : sim?.tier ? sim.tier === 'premium' : true;
    const b = await buildEmail(env, pub, content, sub, { post, access, preview: !sub });
    return { html: b.html, bytes: b.bytes };
  }
  const access = sub ? sub.tier === 'premium' : sim?.tier ? sim.tier === 'premium' : true;
  const r = await renderDoc(parseDoc(post.content), { env, mode: 'web', pub, siteUrl: siteUrl(env, pub), post, subscriber: sub, access, preview: !sub });
  const html = webPage(env, pub, { ...post, style: JSON.stringify(await effectiveStyle(env, pub.id, post)) }, r.html);
  return { html, bytes: new TextEncoder().encode(html).length };
}

/** Standalone article page. `post.style` must already be the effective style (see effectiveStyle) when a template is linked. */
const WEB_FONTS = ['Inter', 'Lora', 'Merriweather', 'Playfair Display', 'Source Serif 4', 'DM Sans', 'Space Grotesk', 'IBM Plex Sans', 'Libre Baskerville', 'Work Sans', 'Manrope', 'Fraunces', 'Roboto', 'Open Sans', 'Poppins'];
/** Google Fonts <link> for the web fonts a (post/template) theme uses, '' when none. */
export function webFontLink(t: { font?: string; heading_font?: string }): string {
  const fams = new Set<string>();
  for (const f of [t.font, t.heading_font]) {
    const first = String(f || '').split(',')[0].replace(/["']/g, '').trim();
    if (WEB_FONTS.includes(first)) fams.add(first);
  }
  if (!fams.size) return '';
  return `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${[...fams].map((f) => `family=${encodeURIComponent(f)}:ital,wght@0,400;0,600;0,700;1,400`).join('&')}&display=swap">`;
}

export function webPage(env: Env, pub: Publication, post: Pick<Post, 'title' | 'subtitle' | 'thumbnail_url' | 'style'>, body: string, authors = ''): string {
  const t = { ...themeOf(pub), ...(parseJSON<any>(post.style, {}).web || {}) };
  const vars = `--font:${t.font};--hfont:${t.heading_font};--bg:${t.bg};--surface:${t.surface};--text:${t.text};--muted:${t.muted};--accent:${t.accent};--accent-text:${t.accent_text};--border:${t.border};--radius:${t.radius}px;--shadow:${t.shadow};--maxw:${t.max_width}px`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base target="_blank"><link rel="stylesheet" href="${env.APP_URL.replace(/\/$/, '')}/static/site.css">${webFontLink(t)}<style>:root{${vars}}body{margin:0}</style></head><body class="site"><article class="s-article"><header class="s-article-h"><h1>${esc(post.title || 'Untitled')}</h1>${post.subtitle ? `<p class="s-sub">${esc(post.subtitle)}</p>` : ''}<div class="s-byline">${esc(authors || pub.name)} · ${fmtDate(Date.now(), { dateStyle: 'medium' }, pub.timezone)}</div></header>${post.thumbnail_url ? `<img class="s-thumb" src="${esc(post.thumbnail_url)}" alt="">` : ''}<div class="s-body">${body}</div></article></body></html>`;
}

export function autoSeo(post: Pick<Post, 'title' | 'subtitle' | 'content' | 'seo'>): { title: string; description: string } {
  const seo = parseJSON<any>(post.seo, {});
  const text = docText(parseDoc(post.content)).replace(/\{\{[^}]+\}\}/g, '').replace(/\s+/g, ' ').trim();
  const desc = seo.description || post.subtitle || text.slice(0, 157) + (text.length > 157 ? '…' : '');
  return { title: seo.title || post.title, description: desc };
}

export async function postAuthors(env: Env, postId: string) {
  return all<{ id: string; name: string; avatar_url: string | null; is_guest: number }>(env, 'SELECT u.id, u.name, u.avatar_url, u.is_guest FROM post_authors pa JOIN users u ON u.id = pa.user_id WHERE pa.post_id = ? ORDER BY pa.position', postId);
}

/** Users who can be listed as authors: team members of the workspace + guest authors used in this publication. */
export async function authorChoices(env: Env, pub: Publication) {
  return all<{ id: string; name: string; email: string; is_guest: number }>(
    env,
    `SELECT DISTINCT u.id, u.name, u.email, u.is_guest FROM users u WHERE u.id IN (SELECT user_id FROM memberships WHERE workspace_id = ?)
       OR u.id IN (SELECT pa.user_id FROM post_authors pa JOIN posts p ON p.id = pa.post_id WHERE p.pub_id = ?)
       OR (u.is_guest = 1 AND json_extract(u.socials, '$.pub_id') = ?)
     ORDER BY u.is_guest, u.name`,
    pub.workspace_id, pub.id, pub.id,
  );
}

export { styleFor };
