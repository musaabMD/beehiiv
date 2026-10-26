// RSS-to-send: fetch RSS 2.0 / Atom feeds, track seen items, and turn new items into posts
// (one post per item, or a scheduled digest), then save as draft or send via publishPost.
import type { Env, Post, Publication } from '../types';
import { one, all, run, insert } from './db';
import { registerPeriodic, logError } from './jobs';
import { publishPost } from './sender';
import { htmlToText, type Block } from './render';
import { newPost } from '../routes/posts/shared';
import { id, now, truncate, parseJSON, fmtDate, MIN, DAY } from './util';

export interface FeedItem { guid: string; title: string; link: string | null; summary: string; image: string | null; published: number | null }
export interface ParsedFeed { title: string; link: string | null; items: FeedItem[] }

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

/** Text content of an XML element body: unwraps CDATA, otherwise decodes entities. */
function text(raw: string | undefined | null): string {
  if (!raw) return '';
  const cdata = [...raw.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)];
  if (cdata.length) return cdata.map((m) => m[1]).join('').trim();
  return decodeEntities(raw).trim();
}

function tag(xml: string, names: string[]): string | null {
  for (const n of names) {
    const re = new RegExp(`<${n.replace(':', '\\:')}(?:\\s[^>]*)?>([\\s\\S]*?)</${n.replace(':', '\\:')}>`, 'i');
    const m = xml.match(re);
    if (m) return m[1];
  }
  return null;
}

function attr(xml: string, tagName: string, attrName: string, filter?: (el: string) => boolean): string | null {
  const re = new RegExp(`<${tagName.replace(':', '\\:')}\\b[^>]*>`, 'gi');
  for (const m of xml.matchAll(re)) {
    const el = m[0];
    if (filter && !filter(el)) continue;
    const a = el.match(new RegExp(`\\b${attrName}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
    if (a) return decodeEntities(a[2] ?? a[3] ?? '');
  }
  return null;
}

function firstImg(html: string): string | null {
  const m = html.match(/<img\b[^>]*\bsrc\s*=\s*("([^"]+)"|'([^']+)')/i);
  return m ? decodeEntities(m[2] ?? m[3]) : null;
}

const okUrl = (u: string | null) => (u && /^https?:\/\//i.test(u) ? u : null);

export function parseFeed(xml: string): ParsedFeed {
  const isAtom = /<feed\b[^>]*>/i.test(xml) && !/<rss\b/i.test(xml);
  const head = xml.split(/<(item|entry)\b/i)[0];
  const title = text(tag(head, ['title'])) || 'Untitled feed';
  const link = isAtom ? attr(head, 'link', 'href', (el) => !/rel\s*=\s*["']self["']/i.test(el)) : text(tag(head, ['link'])) || null;
  const blocks = [...xml.matchAll(isAtom ? /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi : /<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  const items: FeedItem[] = blocks.map((b) => {
    const t = text(tag(b, ['title'])).replace(/<[^>]+>/g, '');
    const l = isAtom
      ? attr(b, 'link', 'href', (el) => !/rel\s*=\s*["'](?!alternate)[^"']+["']/i.test(el)) || attr(b, 'link', 'href')
      : text(tag(b, ['link'])) || attr(b, 'link', 'href');
    const guid = text(tag(b, isAtom ? ['id'] : ['guid', 'id'])) || l || t;
    const body = text(tag(b, ['content:encoded', 'content', 'description', 'summary', 'media:description']));
    const imgFromEnclosure = attr(b, 'enclosure', 'url', (el) => /type\s*=\s*["']image\//i.test(el));
    const image = okUrl(imgFromEnclosure || attr(b, 'media:content', 'url', (el) => !/medium\s*=\s*["'](?!image)/i.test(el) && !/type\s*=\s*["'](?!image)/i.test(el)) || attr(b, 'media:thumbnail', 'url') || attr(b, 'itunes:image', 'href') || firstImg(body));
    const date = text(tag(b, ['pubDate', 'published', 'updated', 'dc:date']));
    const ts = date ? Date.parse(date) : NaN;
    return { guid: guid.slice(0, 500), title: t.slice(0, 300) || '(untitled)', link: okUrl(l), summary: body, image, published: isNaN(ts) ? null : ts };
  });
  return { title: title.replace(/<[^>]+>/g, ''), link: okUrl(link), items: items.filter((i) => i.guid) };
}

export async function fetchFeed(url: string): Promise<ParsedFeed> {
  const r = await fetch(url, { headers: { 'user-agent': 'OpenHive-RSS/1.0 (+https://lnkbase.com/beehiiv)', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Feed returned HTTP ${r.status}`);
  const xml = await r.text();
  if (!/<(rss|feed|rdf:RDF)\b/i.test(xml)) throw new Error('That URL is not an RSS or Atom feed');
  return parseFeed(xml);
}

function fill(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([a-z_.]+)\s*\}\}/gi, (_, k: string) => vars[k.toLowerCase()] ?? '');
}

const para = (html: string): Block => ({ id: id(8), type: 'paragraph', data: { html } });
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function summaryText(html: string, max = 700): string {
  return truncate(htmlToText(html).replace(/\s*\(https?:\/\/[^)]+\)/g, '').replace(/\s+/g, ' ').trim(), max);
}

function itemBlocks(it: FeedItem, digest: boolean): Block[] {
  const out: Block[] = [];
  if (digest) out.push({ id: id(8), type: 'heading', data: { level: 3, html: it.link ? `<a href="${escHtml(it.link)}">${escHtml(it.title)}</a>` : escHtml(it.title) } });
  if (it.image) out.push({ id: id(8), type: 'image', data: { src: it.image, alt: it.title, width: 100, align: 'center' } });
  const s = summaryText(it.summary, digest ? 320 : 900);
  if (s) out.push(para(escHtml(s)));
  if (it.link) {
    if (digest) out.push(para(`<a href="${escHtml(it.link)}">Read more →</a>`));
    else out.push({ id: id(8), type: 'button', data: { label: 'Read more', url: it.link, align: 'center' } });
  }
  return out;
}

async function ownerId(env: Env, pub: Publication): Promise<string> {
  const r = await one<{ user_id: string }>(env, `SELECT user_id FROM memberships WHERE (pub_id = ? OR (pub_id = '' AND workspace_id = ?)) ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END LIMIT 1`, pub.id, pub.workspace_id);
  return r?.user_id || 'system';
}

/** Create the post for one item (each mode) or a batch (digest), then draft or send it. */
async function makePost(env: Env, pub: Publication, feed: any, items: FeedItem[], digest: boolean): Promise<Post> {
  const tpl = feed.template_id ? await one<any>(env, 'SELECT style FROM templates WHERE id = ? AND (pub_id IS NULL OR pub_id = ?)', feed.template_id, pub.id) : null;
  const first = items[0];
  const vars = { 'item.title': first.title, 'feed.title': feed.feed_title || feed.name, 'feed.name': feed.name, date: fmtDate(now(), { dateStyle: 'long' }, pub.timezone), count: String(items.length) };
  const subject = fill(feed.subject_template || (digest ? '{{feed.title}} — {{date}}' : '{{item.title}}'), vars).slice(0, 200) || first.title;
  const blocks: Block[] = [];
  if (feed.intro) blocks.push(para(escHtml(fill(feed.intro, vars)).replace(/\n/g, '<br>')));
  if (digest) {
    items.forEach((it, i) => {
      if (i) blocks.push({ id: id(8), type: 'divider', data: { style: 'line' } });
      blocks.push(...itemBlocks(it, true));
    });
  } else blocks.push(...itemBlocks(first, false));
  const title = digest ? subject : first.title;
  const user = feed.created_by || (await ownerId(env, pub));
  const pid = await newPost(env, pub, user, { title, content: JSON.stringify({ blocks }), style: '{}', template_id: feed.template_id || null });
  const preview = digest ? items.map((i) => i.title).join(' · ') : summaryText(first.summary, 150);
  await run(env, `UPDATE posts SET email_subject = ?, preview_text = ?, audience = ?, segment_ids = ?, exclude_segment_ids = ?, thumbnail_url = ?, updated_at = ? WHERE id = ?`,
    subject, truncate(preview, 150), feed.audience || 'all', feed.segment_ids || '[]', feed.exclude_segment_ids || '[]', first.image, now(), pid);
  const post = (await one<Post>(env, 'SELECT * FROM posts WHERE id = ?', pid))!;
  if (feed.action === 'send') {
    try { await publishPost(env, pub, post); }
    catch (e) {
      const { SendBlockedError } = await import('./plans');
      if (!(e instanceof SendBlockedError)) throw e;
      const { notifyBlocked } = await import('./sender');
      await notifyBlocked(env, pub, post, e);
    }
  }
  for (const it of items) await run(env, `UPDATE rss_items SET status = 'used', post_id = ? WHERE feed_id = ? AND guid = ?`, pid, feed.id, it.guid);
  return post;
}

/** Next time a digest is due after `from` (UTC). */
export function nextDigestAt(feed: { digest_weekday: number | null; digest_every_days: number; digest_time: string }, from: number): number {
  const [hh, mm] = (feed.digest_time || '09:00').split(':').map((x) => parseInt(x, 10) || 0);
  const d = new Date(from);
  if (feed.digest_weekday !== null && feed.digest_weekday !== undefined && feed.digest_weekday >= 0) {
    for (let i = 0; i < 8; i++) {
      const cand = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + i, hh, mm);
      if (cand > from && new Date(cand).getUTCDay() === Number(feed.digest_weekday)) return cand;
    }
  }
  const days = Math.max(1, Number(feed.digest_every_days) || 7);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days, hh, mm);
}

export interface CheckResult { fetched: number; newItems: number; posts: Array<{ id: string; title: string }>; error?: string }

/**
 * Fetch one feed and process it. On the very first fetch every existing item is recorded as a baseline
 * (not sent) unless `sendLatest` asks to include the newest item.
 */
export async function processFeed(env: Env, feedId: string, opts: { force?: boolean; sendLatest?: boolean } = {}): Promise<CheckResult> {
  const feed = await one<any>(env, 'SELECT * FROM rss_feeds WHERE id = ?', feedId);
  if (!feed) return { fetched: 0, newItems: 0, posts: [], error: 'feed not found' };
  const pub = await one<Publication>(env, 'SELECT * FROM publications WHERE id = ?', feed.pub_id);
  if (!pub) return { fetched: 0, newItems: 0, posts: [], error: 'publication not found' };
  const res: CheckResult = { fetched: 0, newItems: 0, posts: [] };
  try {
    const parsed = await fetchFeed(feed.url);
    res.fetched = parsed.items.length;
    const firstRun = !feed.last_checked_at;
    const known = new Set((await all<{ guid: string }>(env, 'SELECT guid FROM rss_items WHERE feed_id = ?', feed.id)).map((r) => r.guid));
    // Oldest first so posts go out in publication order.
    const fresh = parsed.items.filter((i) => !known.has(i.guid)).sort((a, b) => (a.published || 0) - (b.published || 0));
    const newest = parsed.items.slice().sort((a, b) => (b.published || 0) - (a.published || 0))[0];
    for (const it of fresh) {
      const baseline = firstRun && !(opts.sendLatest && newest && it.guid === newest.guid);
      await run(env, `INSERT OR IGNORE INTO rss_items (feed_id, guid, title, link, summary, image, published_at, status, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        feed.id, it.guid, it.title, it.link, it.summary.slice(0, 20_000), it.image, it.published, baseline ? 'baseline' : 'pending', now());
      if (!baseline) res.newItems++;
    }
    await run(env, 'UPDATE rss_feeds SET feed_title = ?, last_checked_at = ?, last_error = NULL WHERE id = ?', parsed.title, now(), feed.id);
    feed.feed_title = parsed.title;
    if (!feed.active && !opts.force) return res;
    const pending = await all<any>(env, `SELECT * FROM rss_items WHERE feed_id = ? AND status = 'pending' ORDER BY COALESCE(published_at, seen_at)`, feed.id);
    const toItem = (r: any): FeedItem => ({ guid: r.guid, title: r.title, link: r.link, summary: r.summary || '', image: r.image, published: r.published_at });
    if (feed.mode === 'digest') {
      const due = nextDigestAt(feed, feed.last_sent_at || feed.created_at) <= now();
      if (pending.length && (due || opts.force)) {
        const batch = pending.slice(-Math.max(1, feed.max_items || 10)).map(toItem);
        const p = await makePost(env, pub, feed, batch, true);
        // anything older than the batch is skipped so the next digest starts fresh
        await run(env, `UPDATE rss_items SET status = 'used' WHERE feed_id = ? AND status = 'pending'`, feed.id);
        await run(env, 'UPDATE rss_feeds SET last_sent_at = ? WHERE id = ?', now(), feed.id);
        res.posts.push({ id: p.id, title: p.title });
      }
    } else {
      // cap per run so a burst of items can't flood subscribers
      for (const r of pending.slice(0, 3)) {
        const p = await makePost(env, pub, feed, [toItem(r)], false);
        res.posts.push({ id: p.id, title: p.title });
      }
      if (res.posts.length) await run(env, 'UPDATE rss_feeds SET last_sent_at = ? WHERE id = ?', now(), feed.id);
    }
  } catch (e: any) {
    res.error = String(e?.message || e);
    await run(env, 'UPDATE rss_feeds SET last_checked_at = ?, last_error = ? WHERE id = ?', now(), res.error.slice(0, 500), feed.id);
    await logError(env, 'rss:' + feed.id, e, feed.pub_id);
  }
  return res;
}

registerPeriodic('rss.feeds', 15 * MIN, async (env) => {
  const feeds = await all<{ id: string }>(env, `SELECT id FROM rss_feeds WHERE active = 1 ORDER BY COALESCE(last_checked_at, 0) LIMIT 50`);
  for (const f of feeds) await processFeed(env, f.id);
});

export { DAY, parseJSON };
