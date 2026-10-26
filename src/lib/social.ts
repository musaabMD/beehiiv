// Social posting: Bluesky (AT Protocol) and Mastodon via their APIs; LinkedIn, X, Threads and Facebook as
// share-intent links only (their posting APIs need app review or paid access). Posts are scheduled through the
// job queue; credentials are sealed with AES-GCM (lib/auth sealSecret). Newsletter posts can be auto-shared on publish.
import type { Env, Publication } from '../types';
import { one, all, run, insert } from './db';
import { id, now, MIN, stripTags, truncate, parseJSON } from './util';
import { sealSecret, openSecret } from './auth';
import { enqueue, registerJob, logError } from './jobs';
import { onEvent } from './events';
import { getPub, siteUrl } from './pub';
import { aiText } from './ai';

export type ApiNetwork = 'bluesky' | 'mastodon';
export type IntentNetwork = 'linkedin' | 'x' | 'threads' | 'facebook';

export const API_NETWORKS: Record<ApiNetwork, { label: string; limit: number; color: string }> = {
  bluesky: { label: 'Bluesky', limit: 300, color: '#1185fe' },
  mastodon: { label: 'Mastodon', limit: 500, color: '#6364ff' },
};

export const INTENT_NETWORKS: Record<IntentNetwork, { label: string; why: string; url: (text: string, link: string) => string }> = {
  linkedin: { label: 'LinkedIn', why: 'LinkedIn only allows posting through its API for apps that pass Marketing Developer Platform review.', url: (_t, l) => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(l)}` },
  x: { label: 'X (Twitter)', why: 'Posting through the X API requires a paid API plan.', url: (t, l) => `https://x.com/intent/post?text=${encodeURIComponent(t)}${l ? `&url=${encodeURIComponent(l)}` : ''}` },
  threads: { label: 'Threads', why: 'The Threads API requires Meta app review.', url: (t, l) => `https://www.threads.net/intent/post?text=${encodeURIComponent(l ? `${t} ${l}` : t)}` },
  facebook: { label: 'Facebook', why: 'Posting to Pages requires Meta app review.', url: (_t, l) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(l)}` },
};

export interface SocialAccount { id: string; pub_id: string; network: ApiNetwork; handle: string; display_name: string; service_url: string; remote_id: string | null; profile_url: string | null; credentials: string; auto_share: number; status: string; last_error: string | null }
export interface SocialPost { id: string; pub_id: string; account_id: string; network: ApiNetwork; text: string; link_url: string | null; image_key: string | null; image_alt: string; status: string; scheduled_at: number | null; posted_at: number | null; remote_id: string | null; remote_url: string | null; error: string | null; attempts: number; post_id: string | null; campaign_id: string | null }

/** Permanent errors (bad credentials, rejected content) are not retried. */
export class SocialError extends Error {
  constructor(msg: string, public permanent = true) { super(msg); }
}

export function graphemes(s: string): number {
  try {
    const Seg = (Intl as any).Segmenter;
    if (Seg) { let n = 0; for (const _ of new Seg('en', { granularity: 'grapheme' }).segment(s)) n++; return n; }
  } catch {}
  return [...s].length;
}

/** Mastodon counts every URL as 23 characters. */
export function mastodonLength(s: string): number {
  return [...s.replace(/https?:\/\/\S+/g, 'x'.repeat(23))].length;
}

export function normalizeUrl(u: string): string {
  const s = u.trim().replace(/\/+$/, '');
  if (!s) return s;
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

async function call(url: string, init: RequestInit & { json?: unknown } = {}): Promise<any> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) { headers.set('content-type', 'application/json'); body = JSON.stringify(init.json); }
  headers.set('accept', 'application/json');
  headers.set('user-agent', 'LnkbaseNewsletter/1.0 (+https://hive.lnkbase.com)');
  let r: Response;
  try {
    r = await fetch(url, { ...init, headers, body });
  } catch (e: any) {
    throw new SocialError(`Could not reach ${new URL(url).host}: ${e?.message || e}`, false);
  }
  const text = await r.text();
  const j = parseJSON<any>(text, null);
  if (!r.ok) {
    const msg = j?.message || j?.error_description || j?.error || text.slice(0, 200) || r.statusText;
    throw new SocialError(`${new URL(url).host} returned ${r.status}: ${msg}`, r.status < 500 && r.status !== 429);
  }
  return j ?? {};
}

// ───────── Bluesky (AT Protocol) ─────────
async function bskySession(service: string, identifier: string, password: string) {
  const s = await call(`${service}/xrpc/com.atproto.server.createSession`, { method: 'POST', json: { identifier, password } });
  if (!s.accessJwt || !s.did) throw new SocialError('Bluesky did not return a session');
  return s as { accessJwt: string; did: string; handle: string };
}

export async function connectBluesky(env: Env, o: { service?: string; identifier: string; appPassword: string }) {
  const service = normalizeUrl(o.service || 'https://bsky.social');
  const identifier = o.identifier.trim().replace(/^@/, '');
  if (!identifier || !o.appPassword) throw new SocialError('Enter your handle and an app password.');
  const s = await bskySession(service, identifier, o.appPassword.trim());
  return {
    network: 'bluesky' as const, handle: '@' + s.handle, display_name: s.handle, service_url: service, remote_id: s.did,
    profile_url: `https://bsky.app/profile/${s.handle}`, credentials: await sealSecret(env, { identifier, password: o.appPassword.trim() }),
  };
}

/** Rich-text link facets (byte offsets in UTF-8). */
function linkFacets(text: string) {
  const enc = new TextEncoder();
  const out: any[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g)) {
    const start = enc.encode(text.slice(0, m.index!)).length;
    out.push({ index: { byteStart: start, byteEnd: start + enc.encode(m[0]).length }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }] });
  }
  return out;
}

async function linkPreview(url: string): Promise<{ title: string; description: string; image?: string }> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'LnkbaseNewsletter/1.0 (link preview)', accept: 'text/html' }, signal: AbortSignal.timeout(5000) });
    const html = (await r.text()).slice(0, 200_000);
    const meta = (p: string) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*content=["']([^"']*)["']`, 'i'))?.[1] || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${p}["']`, 'i'))?.[1];
    const dec = (s?: string) => (s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return { title: dec(meta('og:title') || html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]).trim() || new URL(url).hostname, description: dec(meta('og:description') || meta('description')).trim(), image: meta('og:image') ? new URL(dec(meta('og:image')), url).toString() : undefined };
  } catch {
    return { title: new URL(url).hostname, description: '' };
  }
}

async function imageBytes(env: Env, key: string): Promise<{ bytes: ArrayBuffer; mime: string } | null> {
  const obj = await env.MEDIA.get(key);
  if (!obj) return null;
  return { bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType || 'image/jpeg' };
}

async function postBluesky(env: Env, acct: SocialAccount, p: SocialPost): Promise<{ remoteId: string; url: string }> {
  const cred = JSON.parse(await openSecret(env, acct.credentials));
  const s = await bskySession(acct.service_url, cred.identifier, cred.password);
  const auth = { authorization: `Bearer ${s.accessJwt}` };
  const upload = async (bytes: ArrayBuffer, mime: string) => {
    if (bytes.byteLength > 976_560) return null; // Bluesky blob limit for images (~1 MB)
    const r = await call(`${acct.service_url}/xrpc/com.atproto.repo.uploadBlob`, { method: 'POST', headers: { ...auth, 'content-type': mime }, body: bytes });
    return r.blob || null;
  };
  let embed: any;
  const img = p.image_key ? await imageBytes(env, p.image_key) : null;
  if (p.link_url) {
    const prev = await linkPreview(p.link_url);
    let thumb = img ? await upload(img.bytes, img.mime) : null;
    if (!thumb && prev.image) {
      try { const ir = await fetch(prev.image, { signal: AbortSignal.timeout(5000) }); if (ir.ok) thumb = await upload(await ir.arrayBuffer(), ir.headers.get('content-type') || 'image/jpeg'); } catch {}
    }
    embed = { $type: 'app.bsky.embed.external', external: { uri: p.link_url, title: truncate(prev.title, 300), description: truncate(prev.description, 1000), ...(thumb ? { thumb } : {}) } };
  } else if (img) {
    const blob = await upload(img.bytes, img.mime);
    if (!blob) throw new SocialError('Image is larger than Bluesky allows (1 MB). Pick a smaller image.');
    embed = { $type: 'app.bsky.embed.images', images: [{ alt: p.image_alt || '', image: blob }] };
  }
  const facets = linkFacets(p.text);
  const record: any = { $type: 'app.bsky.feed.post', text: p.text, createdAt: new Date().toISOString(), langs: ['en'] };
  if (facets.length) record.facets = facets;
  if (embed) record.embed = embed;
  const r = await call(`${acct.service_url}/xrpc/com.atproto.repo.createRecord`, { method: 'POST', headers: auth, json: { repo: s.did, collection: 'app.bsky.feed.post', record } });
  const rkey = String(r.uri || '').split('/').pop();
  return { remoteId: r.uri, url: `https://bsky.app/profile/${s.handle || acct.handle.replace(/^@/, '')}/post/${rkey}` };
}

// ───────── Mastodon ─────────
export async function connectMastodon(env: Env, o: { instance: string; token: string }) {
  const service = normalizeUrl(o.instance);
  if (!service || !o.token.trim()) throw new SocialError('Enter your instance URL and an access token.');
  const me = await call(`${service}/api/v1/accounts/verify_credentials`, { headers: { authorization: `Bearer ${o.token.trim()}` } });
  if (!me.id) throw new SocialError('Mastodon did not return your account');
  return {
    network: 'mastodon' as const, handle: `@${me.username || me.acct}@${new URL(service).host}`, display_name: me.display_name || me.username || '', service_url: service, remote_id: String(me.id),
    profile_url: me.url || null, credentials: await sealSecret(env, { token: o.token.trim() }),
  };
}

async function postMastodon(env: Env, acct: SocialAccount, p: SocialPost): Promise<{ remoteId: string; url: string }> {
  const { token } = JSON.parse(await openSecret(env, acct.credentials));
  const auth = { authorization: `Bearer ${token}` };
  const mediaIds: string[] = [];
  const img = p.image_key ? await imageBytes(env, p.image_key) : null;
  if (img) {
    const fd = new FormData();
    fd.append('file', new File([img.bytes], 'image', { type: img.mime }));
    if (p.image_alt) fd.append('description', p.image_alt);
    const m = await call(`${acct.service_url}/api/v2/media`, { method: 'POST', headers: auth, body: fd });
    // 202 = still processing; wait briefly until it has a URL
    for (let i = 0; i < 5 && m.id && !m.url; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = await call(`${acct.service_url}/api/v1/media/${m.id}`, { headers: auth }).catch(() => ({}));
      if (s.url) m.url = s.url;
    }
    if (m.id) mediaIds.push(String(m.id));
  }
  const status = p.link_url && !p.text.includes(p.link_url) ? `${p.text}\n\n${p.link_url}` : p.text;
  const r = await call(`${acct.service_url}/api/v1/statuses`, { method: 'POST', headers: { ...auth, 'idempotency-key': p.id }, json: { status, media_ids: mediaIds, visibility: 'public' } });
  return { remoteId: String(r.id), url: r.url || `${acct.service_url}/@${acct.handle.split('@')[1]}/${r.id}` };
}

// ───────── posting + scheduling ─────────
export function validateText(network: ApiNetwork, text: string, link?: string | null): string | null {
  if (!text.trim() && !link) return 'Write something to post.';
  if (network === 'bluesky' && graphemes(text) > 300) return `Bluesky posts are limited to 300 characters (this one is ${graphemes(text)}).`;
  const full = link && !text.includes(link) ? `${text}\n\n${link}` : text;
  if (network === 'mastodon' && mastodonLength(full) > 500) return `Mastodon posts are limited to 500 characters (this one is ${mastodonLength(full)}).`;
  return null;
}

/** Add utm_source=<network>&utm_medium=social&utm_campaign=<campaign> to a link (keeps existing UTM tags). */
export function tagLink(link: string, network: string, campaign?: string | null): string {
  try {
    const u = new URL(link);
    if (!u.searchParams.has('utm_source')) u.searchParams.set('utm_source', network);
    if (!u.searchParams.has('utm_medium')) u.searchParams.set('utm_medium', 'social');
    if (campaign && !u.searchParams.has('utm_campaign')) u.searchParams.set('utm_campaign', campaign);
    return u.toString();
  } catch {
    return link;
  }
}

export async function createSocialPost(env: Env, o: { pubId: string; account: SocialAccount; text: string; link?: string | null; imageKey?: string | null; imageAlt?: string; at?: number | null; postId?: string | null; campaignId?: string | null; userId?: string | null }): Promise<string> {
  const sid = id();
  const t = now();
  const at = o.at && o.at > t ? o.at : t;
  let link = o.link || null;
  if (link) {
    const camp = o.campaignId ? await one<{ slug: string }>(env, 'SELECT slug FROM campaigns WHERE id = ? AND pub_id = ?', o.campaignId, o.pubId) : null;
    link = tagLink(link, o.account.network, camp?.slug);
  }
  await insert(env, 'social_posts', { id: sid, pub_id: o.pubId, account_id: o.account.id, network: o.account.network, text: o.text, link_url: link, image_key: o.imageKey || null, image_alt: o.imageAlt || '', status: 'scheduled', scheduled_at: at, post_id: o.postId || null, campaign_id: o.campaignId || null, created_by: o.userId || null, created_at: t, updated_at: t });
  if (o.campaignId) await run(env, 'INSERT OR IGNORE INTO campaign_items (campaign_id, pub_id, kind, ref_id, created_at) VALUES (?, ?, ?, ?, ?)', o.campaignId, o.pubId, 'social', sid, t);
  await enqueue(env, 'social.post', { id: sid }, at);
  return sid;
}

/** Move a scheduled social post; the job queued for the old time sees the new time and does nothing. */
export async function rescheduleSocialPost(env: Env, pubId: string, sid: string, at: number): Promise<boolean> {
  const r = await run(env, `UPDATE social_posts SET scheduled_at = ?, updated_at = ? WHERE id = ? AND pub_id = ? AND status = 'scheduled'`, at, now(), sid, pubId);
  if (!r.meta.changes) return false;
  await enqueue(env, 'social.post', { id: sid }, at);
  return true;
}

export async function publishSocialPost(env: Env, sid: string): Promise<void | { retryInMs?: number }> {
  const p = await one<SocialPost>(env, 'SELECT * FROM social_posts WHERE id = ?', sid);
  if (!p || p.status !== 'scheduled') return;
  if ((p.scheduled_at || 0) > now() + 5000) return; // rescheduled later; a newer job will run it
  const claim = await run(env, `UPDATE social_posts SET status = 'posting', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'scheduled'`, now(), sid);
  if (!claim.meta.changes) return;
  const acct = await one<SocialAccount>(env, 'SELECT * FROM social_accounts WHERE id = ? AND pub_id = ?', p.account_id, p.pub_id);
  try {
    if (!acct) throw new SocialError('The connected account was removed.');
    const res = p.network === 'bluesky' ? await postBluesky(env, acct, p) : await postMastodon(env, acct, p);
    await run(env, `UPDATE social_posts SET status = 'posted', posted_at = ?, remote_id = ?, remote_url = ?, error = NULL, updated_at = ? WHERE id = ?`, now(), res.remoteId, res.url, now(), sid);
    await run(env, `UPDATE social_accounts SET status = 'active', last_error = NULL WHERE id = ?`, acct.id);
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 500);
    const retry = !(e instanceof SocialError && e.permanent) && p.attempts + 1 < 4;
    await run(env, `UPDATE social_posts SET status = ?, error = ?, updated_at = ? WHERE id = ?`, retry ? 'scheduled' : 'failed', msg, now(), sid);
    if (acct && !retry) await run(env, `UPDATE social_accounts SET status = 'error', last_error = ? WHERE id = ?`, msg, acct.id);
    if (!(e instanceof SocialError)) await logError(env, 'social.post', e, p.pub_id);
    if (retry) {
      const wait = 2 ** (p.attempts + 1) * MIN;
      await run(env, `UPDATE social_posts SET scheduled_at = ? WHERE id = ?`, now() + wait, sid);
      await enqueue(env, 'social.post', { id: sid }, now() + wait);
    }
  }
}

registerJob('social.post', async (env, payload) => {
  await publishSocialPost(env, String(payload.id || ''));
});

// ───────── composing ─────────
/** Default share text for a newsletter post (no AI). */
export function defaultShareText(post: { title: string; subtitle?: string | null }): string {
  return truncate([post.title, post.subtitle].filter(Boolean).join(' — '), 240);
}

/** AI "write a post for this issue" with a plain fallback when AI isn't configured or fails. */
export async function suggestSocialText(env: Env, pub: Publication, post: { title: string; subtitle?: string | null; content?: string | null }, network: ApiNetwork | IntentNetwork): Promise<{ text: string; ai: boolean }> {
  const limit = network === 'mastodon' ? 440 : 240;
  const body = truncate(stripTags(extractText(post.content || '')), 2500);
  const r = await aiText(env, `Write one ${network} post (max ${limit} characters, no hashtags spam — at most two, no link; the link is attached separately) promoting this newsletter issue from "${pub.name}".\n\nTitle: ${post.title}\nSubtitle: ${post.subtitle || ''}\n\n${body}`, 'You write concise, engaging social media posts for newsletter writers. Reply with the post text only, no quotes or preamble.', 300);
  const text = r.ok ? r.text.replace(/^["“]|["”]$/g, '').trim() : '';
  if (text && text.length <= limit + 40) return { text: truncate(text, limit), ai: true };
  return { text: defaultShareText(post), ai: false };
}

function extractText(content: string): string {
  const doc = parseJSON<any>(content, null);
  if (!doc?.blocks) return content;
  const out: string[] = [];
  const walk = (blocks: any[]) => {
    for (const b of blocks || []) {
      const d = b.data || {};
      if (d.html) out.push(d.html);
      if (Array.isArray(d.items)) out.push(...d.items.map((i: any) => (typeof i === 'string' ? i : i?.html || '')));
      if (Array.isArray(d.blocks)) walk(d.blocks);
      if (Array.isArray(d.columns)) d.columns.forEach((c: any) => walk(c.blocks));
    }
  };
  walk(doc.blocks);
  return out.join(' ');
}

/** R2 key of a media-library URL (/media/<pubId>/...) belonging to this publication, else null. */
export function mediaKeyFromUrl(url: string | null | undefined, pubId: string): string | null {
  const m = String(url || '').match(/\/media\/([^?#]+)/);
  const key = m ? decodeURIComponent(m[1]) : '';
  return key.startsWith(pubId + '/') && !key.includes('..') ? key : null;
}

// ───────── auto-share on publish ─────────
onEvent(async (env, e) => {
  if (e.type !== 'post.published' || !e.refId) return;
  const accounts = await all<SocialAccount>(env, `SELECT * FROM social_accounts WHERE pub_id = ? AND auto_share = 1 AND status != 'disabled'`, e.pubId);
  if (!accounts.length) return;
  const post = await one<any>(env, `SELECT id, title, subtitle, slug, thumbnail_url, platform, hide_from_feed FROM posts WHERE id = ? AND pub_id = ?`, e.refId, e.pubId);
  const pub = await getPub(env, e.pubId);
  if (!post || !pub) return;
  const link = `${siteUrl(env, pub)}/p/${post.slug}`;
  const camp = await one<{ campaign_id: string }>(env, `SELECT campaign_id FROM campaign_items WHERE kind = 'post' AND ref_id = ? AND pub_id = ? LIMIT 1`, post.id, e.pubId);
  // thumbnail from the media library, when it is one of ours
  const key = mediaKeyFromUrl(post.thumbnail_url, e.pubId);
  for (const a of accounts) {
    const already = await one(env, 'SELECT 1 FROM social_posts WHERE post_id = ? AND account_id = ?', post.id, a.id);
    if (already) continue;
    await createSocialPost(env, { pubId: e.pubId, account: a, text: defaultShareText(post), link, imageKey: key || null, imageAlt: post.title, postId: post.id, campaignId: camp?.campaign_id || null });
  }
});
