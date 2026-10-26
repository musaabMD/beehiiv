// REST API v2 route table. Each entry is registered under /api/v2/publications/:pubId<path> and /api/v2/publication<path>,
// and the same table generates the OpenAPI document and the /docs/api reference page.
import type { Ctx, Publication, Post, Subscriber } from '../../types';
import { one, all, run, val, insert, update, encodeCursor, decodeCursor } from '../../lib/db';
import { apiError } from '../../lib/apiauth';
import { validateEmail } from '../../lib/guard';
import { subscribe, getSubscriber, unsubscribe, deleteSubscriber, addTags, removeTags, getTags, setFields, joinLists, leaveLists } from '../../lib/subscribers';
import { recalcSegment, listMatching, countMatching, EMPTY_GROUP, type RuleGroup } from '../../lib/segments';
import { enroll, publishDraft, TRIGGERS, STEP_TYPES } from '../../lib/automations';
import { publishPost, sendTest, buildEmail, postContent } from '../../lib/sender';
import { renderDoc, parseDoc, styleFor, GMAIL_CLIP_BYTES, sanitizeEmailDocument, ensureUnsubscribe, hasUnsubscribeLink, type Block } from '../../lib/render';
import { recommendProducts } from '../../lib/recommend';
import { scoreSubject } from '../posts/shared';
import { emit } from '../../lib/events';
import { WEBHOOK_VERSIONS, LATEST_WEBHOOK_VERSION, isWebhookVersion, deliveryAttempts } from '../../lib/webhooks';
import { siteUrl } from '../../lib/pub';
import { markdownToBlocks } from '../../lib/markdown';
import { postStats, providerStats, summary, growthSeries, earnings } from '../../lib/stats';
import { id, now, slugify, parseJSON, clamp, int, token, DAY } from '../../lib/util';

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export interface RouteDef {
  method: Method;
  path: string;
  tag: string;
  summary: string;
  query?: Record<string, string>;
  body?: Record<string, string>;
  handler: (c: Ctx, pub: Publication) => Promise<Response>;
}
export const ROUTES: RouteDef[] = [];
const route = (method: Method, path: string, tag: string, summary: string, handler: RouteDef['handler'], extra: Partial<Pick<RouteDef, 'query' | 'body'>> = {}) =>
  ROUTES.push({ method, path, tag, summary, handler, ...extra });

// ───────── helpers ─────────
export const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

async function body(c: Ctx): Promise<Record<string, any>> {
  const ct = c.req.header('content-type') || '';
  if (ct.includes('application/json')) {
    try { const j = await c.req.json(); return j && typeof j === 'object' ? j : {}; } catch { throw new BadRequest('Request body must be valid JSON.'); }
  }
  if (ct.includes('form')) return (await c.req.parseBody()) as any;
  return {};
}

export class BadRequest extends Error {}
export class NotFound extends Error {}

const PAGE_Q = { limit: 'Page size 1-100 (default 50)', cursor: 'Opaque cursor from next_cursor' };

/** Keyset pagination on (created_at DESC, id DESC). */
async function paginate(c: Ctx, table: string, where: string, params: unknown[], map: (r: any) => any = (r) => r, cols = '*') {
  const limit = clamp(int(c.req.query('limit'), 50), 1, 100);
  const cur = decodeCursor(c.req.query('cursor'));
  const rows = await all<any>(
    c.env,
    `SELECT ${cols} FROM ${table} WHERE ${where} ${cur ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : ''} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ...params, ...(cur ? [cur.t, cur.t, cur.id] : []), limit + 1,
  );
  const has_more = rows.length > limit;
  const data = rows.slice(0, limit);
  return c.json({ data: await Promise.all(data.map(map)), next_cursor: has_more ? encodeCursor(data[data.length - 1]) : null, has_more });
}

export function serializeSub(s: Subscriber, tags?: string[]) {
  return {
    id: s.id, email: s.email, name: s.name, status: s.status, tier: s.tier, tier_id: s.tier_id, trial_ends_at: iso(s.trial_ends_at),
    source: s.source, source_detail: s.source_detail,
    utm: { source: s.utm_source, medium: s.utm_medium, campaign: s.utm_campaign, term: s.utm_term, content: s.utm_content },
    referrer_url: s.referrer_url, landing_path: s.landing_path, referral_code: s.referral_code, referred_by: s.referred_by, referral_count: s.referral_count,
    custom_fields: parseJSON(s.custom, {}), country: s.country, engagement_score: s.engagement,
    stats: { emails_received: s.received_count, opens: s.open_count, clicks: s.click_count, last_open_at: iso(s.last_open_at), last_click_at: iso(s.last_click_at) },
    ...(tags ? { tags } : {}),
    created_at: iso(s.created_at), confirmed_at: iso(s.confirmed_at), unsubscribed_at: iso(s.unsubscribed_at), updated_at: iso(s.updated_at),
  };
}

export function serializePost(env: any, pub: Publication, p: Post, extra: Record<string, unknown> = {}) {
  return {
    id: p.id, title: p.title, subtitle: p.subtitle, slug: p.slug, status: p.status, platform: p.platform, audience: p.audience,
    email_subject: p.email_subject || p.title, preview_text: p.preview_text, thumbnail_url: p.thumbnail_url, template_id: p.template_id,
    web_url: `${siteUrl(env, pub)}/p/${p.slug}`, segment_ids: parseJSON(p.segment_ids, []), exclude_segment_ids: parseJSON(p.exclude_segment_ids, []),
    ab_test: parseJSON(p.ab_test, null), seo: parseJSON(p.seo, {}), word_count: p.word_count,
    scheduled_at: iso(p.scheduled_at), published_at: iso(p.published_at), created_at: iso(p.created_at), updated_at: iso(p.updated_at),
    ...extra,
  };
}

async function needSub(c: Ctx, pub: Publication, key = 'id'): Promise<Subscriber> {
  const s = await getSubscriber(c.env, pub.id, decodeURIComponent(c.req.param(key) || ''));
  if (!s) throw new NotFound('Subscriber not found.');
  return s;
}
async function needPost(c: Ctx, pub: Publication): Promise<Post> {
  const p = await one<Post>(c.env, 'SELECT * FROM posts WHERE pub_id = ? AND (id = ? OR slug = ?)', pub.id, c.req.param('id'), c.req.param('id'));
  if (!p) throw new NotFound('Post not found.');
  return p;
}
async function needRow<T = any>(c: Ctx, table: string, pub: Publication, what: string, key = 'id'): Promise<T> {
  const r = await one<T>(c.env, `SELECT * FROM ${table} WHERE id = ? AND pub_id = ?`, c.req.param(key), pub.id);
  if (!r) throw new NotFound(`${what} not found.`);
  return r;
}

/** blocks | html | markdown → editor blocks */
export function contentToBlocks(b: Record<string, any>): Block[] | null {
  if (Array.isArray(b.blocks)) return b.blocks.map((x: any) => ({ id: x.id || id(8), type: String(x.type), data: x.data || {} }));
  if (b.content && Array.isArray(b.content.blocks)) return contentToBlocks({ blocks: b.content.blocks });
  if (typeof b.html === 'string') return [{ id: id(8), type: 'html', data: { html: b.html } }];
  if (typeof b.markdown === 'string') return markdownToBlocks(b.markdown);
  return null;
}

export async function uniqueSlug(c: { env: any }, pubId: string, base: string, exceptId?: string) {
  let slug = slugify(base || 'untitled');
  let n = 2;
  while (await one(c.env, 'SELECT 1 FROM posts WHERE pub_id = ? AND slug = ? AND id != ?', pubId, slug, exceptId || '')) slug = `${slugify(base || 'untitled')}-${n++}`;
  return slug;
}

const wordCount = (blocks: Block[]) => JSON.stringify(blocks).replace(/<[^>]+>/g, ' ').replace(/"[a-z_]+":/g, ' ').split(/\s+/).filter((w) => /[a-z]/i.test(w)).length;

/** Create a post (used by REST + MCP). */
export async function createPost(env: any, pub: Publication, b: Record<string, any>): Promise<Post> {
  let blocks = contentToBlocks(b);
  let style = '{}';
  let templateId: string | null = null;
  if (b.template_id) {
    const tpl = await one<any>(env, 'SELECT * FROM templates WHERE id = ? AND (pub_id = ? OR pub_id IS NULL)', b.template_id, pub.id);
    if (!tpl) throw new BadRequest('template_id not found.');
    templateId = tpl.id;
    const tplBlocks = parseDoc(tpl.content).blocks.map((x) => ({ ...x, id: id(8) }));
    blocks = blocks ? [...tplBlocks, ...blocks] : tplBlocks;
    // style stays '{}' (no overrides): the template's style is linked via template_id, so later template edits apply
    style = '{}';
  }
  blocks = blocks || [];
  const t = now();
  const pid = id();
  const title = String(b.title || '').slice(0, 300);
  const row = {
    id: pid, pub_id: pub.id, title, subtitle: String(b.subtitle || '').slice(0, 500), slug: await uniqueSlug({ env }, pub.id, b.slug || title),
    content: JSON.stringify({ blocks }), status: 'draft', platform: ['email', 'web', 'both'].includes(b.platform) ? b.platform : 'both',
    audience: ['all', 'free', 'premium'].includes(b.audience) ? b.audience : 'all', email_subject: b.email_subject ?? null, preview_text: String(b.preview_text || ''),
    thumbnail_url: b.thumbnail_url ?? null, seo: JSON.stringify(b.seo || {}), template_id: templateId, style, word_count: wordCount(blocks),
    segment_ids: JSON.stringify(b.segment_ids || []), exclude_segment_ids: JSON.stringify(b.exclude_segment_ids || []), created_at: t, updated_at: t,
  };
  await insert(env, 'posts', row);
  if (Array.isArray(b.author_ids)) for (const [i, uid] of b.author_ids.entries()) await run(env, 'INSERT OR IGNORE INTO post_authors (post_id, user_id, position) VALUES (?, ?, ?)', pid, uid, i);
  return (await one<Post>(env, 'SELECT * FROM posts WHERE id = ?', pid))!;
}

export async function updatePost(env: any, pub: Publication, post: Post, b: Record<string, any>): Promise<Post> {
  const patch: Record<string, unknown> = {};
  for (const k of ['title', 'subtitle', 'email_subject', 'preview_text', 'thumbnail_url']) if (b[k] !== undefined) patch[k] = b[k];
  if (b.platform && ['email', 'web', 'both'].includes(b.platform)) patch.platform = b.platform;
  if (b.audience && ['all', 'free', 'premium'].includes(b.audience)) patch.audience = b.audience;
  if (b.seo) patch.seo = JSON.stringify({ ...parseJSON(post.seo, {}), ...b.seo });
  if (b.slug) patch.slug = await uniqueSlug({ env }, pub.id, b.slug, post.id);
  if (b.hide_from_feed !== undefined) patch.hide_from_feed = b.hide_from_feed ? 1 : 0;
  if (b.segment_ids) patch.segment_ids = JSON.stringify(b.segment_ids);
  if (b.exclude_segment_ids) patch.exclude_segment_ids = JSON.stringify(b.exclude_segment_ids);
  if (b.ab_test !== undefined) patch.ab_test = b.ab_test ? JSON.stringify(b.ab_test) : null;
  const blocks = contentToBlocks(b);
  if (blocks) {
    await insert(env, 'post_versions', { id: id(), post_id: post.id, title: post.title, content: post.content, created_by: null, created_at: now() });
    patch.content = JSON.stringify({ blocks });
    patch.word_count = wordCount(blocks);
  }
  if (!Object.keys(patch).length) return post;
  patch.updated_at = now();
  await update(env, 'posts', post.id, patch, pub.id);
  await emit(env, { pubId: pub.id, type: 'post.updated', refId: post.id, data: { post_id: post.id, title: patch.title ?? post.title, fields: Object.keys(patch) }, activity: false });
  return (await one<Post>(env, 'SELECT * FROM posts WHERE id = ?', post.id))!;
}

// ───────── publication + stats ─────────
route('GET', '', 'Publication', 'Get the publication this key belongs to', async (c, pub) => {
  const counts = await one<any>(c.env, `SELECT COUNT(*) AS total, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status='active' AND tier='premium' THEN 1 ELSE 0 END) AS premium FROM subscribers WHERE pub_id = ?`, pub.id);
  return c.json({ data: { id: pub.id, name: pub.name, slug: pub.slug, description: pub.description, url: siteUrl(c.env, pub), logo_url: pub.logo_url, language: pub.language, timezone: pub.timezone, custom_domain: pub.custom_domain, subscribers: { total: counts?.total || 0, active: counts?.active || 0, premium: counts?.premium || 0 }, created_at: iso(pub.created_at) } });
});
route('GET', '/stats', 'Stats', 'Summary: growth, engagement, revenue (plain-English summary included)', async (c, pub) => c.json({ data: await summary(c.env, pub.id, clamp(int(c.req.query('days'), 30), 1, 365)) }), { query: { days: 'Period in days (default 30)' } });
route('GET', '/stats/growth', 'Stats', 'Daily subscriber growth and acquisition sources', async (c, pub) => c.json({ data: await growthSeries(c.env, pub.id, clamp(int(c.req.query('days'), 30), 1, 365)) }), { query: { days: 'Period in days (default 30)' } });
route('GET', '/stats/earnings', 'Stats', 'Earnings report: orders, MRR, network earnings', async (c, pub) => c.json({ data: await earnings(c.env, pub.id, clamp(int(c.req.query('days'), 30), 1, 365)) }), { query: { days: 'Period in days (default 30)' } });

// ───────── subscriptions ─────────
route('GET', '/subscriptions', 'Subscriptions', 'List subscribers (filter by status, tier, email, source, created range)', async (c, pub) => {
  const w = ['pub_id = ?'];
  const p: unknown[] = [pub.id];
  const q = (k: string) => c.req.query(k);
  if (q('status')) { w.push('status = ?'); p.push(q('status')); }
  if (q('tier')) { w.push('tier = ?'); p.push(q('tier')); }
  if (q('source')) { w.push('source = ?'); p.push(q('source')); }
  if (q('email')) { w.push('email LIKE ?'); p.push(`%${q('email')!.toLowerCase()}%`); }
  if (q('created_after')) { w.push('created_at >= ?'); p.push(Date.parse(q('created_after')!) || 0); }
  if (q('created_before')) { w.push('created_at < ?'); p.push(Date.parse(q('created_before')!) || now()); }
  if (q('tag')) { w.push('EXISTS (SELECT 1 FROM subscriber_tags t WHERE t.subscriber_id = subscribers.id AND t.tag = ?)'); p.push(q('tag')!.toLowerCase()); }
  return paginate(c, 'subscribers', w.join(' AND '), p, (s) => serializeSub(s));
}, { query: { ...PAGE_Q, status: 'active|pending|unsubscribed|bounced|complained', tier: 'free|premium', source: 'Acquisition source', email: 'Email contains', tag: 'Has tag', created_after: 'ISO date', created_before: 'ISO date' } });

route('GET', '/subscriptions/:id', 'Subscriptions', 'Get a subscriber by id or email (includes tags and recent activity)', async (c, pub) => {
  const s = await needSub(c, pub);
  const activity = await all<any>(c.env, 'SELECT type, ref_id, data, created_at FROM activity WHERE subscriber_id = ? ORDER BY created_at DESC LIMIT 50', s.id);
  return c.json({ data: { ...serializeSub(s, await getTags(c.env, s.id)), activity: activity.map((a) => ({ type: a.type, ref_id: a.ref_id, data: parseJSON(a.data, {}), at: iso(a.created_at) })) } });
});

route('POST', '/subscriptions', 'Subscriptions', 'Create (or update) a subscriber — validated, double opt-in respected', async (c, pub) => {
  const b = await body(c);
  if (!b.email) throw new BadRequest('email is required.');
  const r = await subscribe(c.env, pub, {
    email: String(b.email), name: b.name, source: b.source || 'api', sourceDetail: b.source_detail ?? null,
    utm: { source: b.utm_source, medium: b.utm_medium, campaign: b.utm_campaign, term: b.utm_term, content: b.utm_content },
    referrer: b.referring_site ?? null, referralCode: b.referral_code ?? null, tags: Array.isArray(b.tags) ? b.tags : undefined,
    custom: b.custom_fields && typeof b.custom_fields === 'object' ? b.custom_fields : undefined, listIds: Array.isArray(b.list_ids) ? b.list_ids : undefined,
    skipConfirm: b.double_opt_override === 'off', strict: b.validate_mx !== false, reactivate: !!b.reactivate_existing, sendWelcome: b.send_welcome_email !== false,
    tier: b.tier === 'premium' ? 'premium' : undefined,
  });
  if (!r.ok) return apiError(c, 422, 'invalid_email', r.error || 'Invalid email', { suggestion: r.suggestion ?? null });
  return c.json({ data: { ...serializeSub(r.subscriber!, await getTags(c.env, r.subscriber!.id)), created: r.created, pending_confirmation: !!r.pending } }, r.created ? 201 : 200);
}, { body: { email: 'string (required)', name: 'string', utm_source: 'string', utm_medium: 'string', utm_campaign: 'string', referral_code: 'Referrer code', custom_fields: 'object', tags: 'string[]', list_ids: 'string[]', tier: 'free|premium', send_welcome_email: 'boolean (default true)', reactivate_existing: 'boolean', double_opt_override: '"on"|"off" (default: publication setting)' } });

route('PATCH', '/subscriptions/:id', 'Subscriptions', 'Update a subscriber (name, tier, status, custom fields, tags)', async (c, pub) => {
  const s = await needSub(c, pub);
  const b = await body(c);
  const patch: Record<string, unknown> = {};
  if (typeof b.name === 'string') patch.name = b.name.slice(0, 120);
  if (b.tier === 'free' || b.tier === 'premium') patch.tier = b.tier;
  if (b.email && b.email !== s.email) {
    const v = await validateEmail(b.email, { strict: true });
    if (!v.ok) return apiError(c, 422, 'invalid_email', v.reason || 'Invalid email');
    if (await one(c.env, 'SELECT 1 FROM subscribers WHERE pub_id = ? AND email = ?', pub.id, v.email)) return apiError(c, 409, 'conflict', 'Another subscriber already uses that email.');
    patch.email = v.email;
  }
  if (Object.keys(patch).length) { patch.updated_at = now(); await update(c.env, 'subscribers', s.id, patch, pub.id); }
  if (b.tier && b.tier !== s.tier) await emit(c.env, { pubId: pub.id, type: b.tier === 'premium' ? 'subscription.upgraded' : 'subscription.downgraded', subscriberId: s.id, data: { tier: b.tier, via: 'api' } });
  if (b.custom_fields && typeof b.custom_fields === 'object') await setFields(c.env, pub.id, s.id, b.custom_fields);
  if (Array.isArray(b.add_tags)) await addTags(c.env, pub.id, s.id, b.add_tags);
  if (Array.isArray(b.remove_tags)) await removeTags(c.env, pub.id, s.id, b.remove_tags);
  if (b.status === 'unsubscribed') await unsubscribe(c.env, pub.id, s.id, b.unsubscribe_reason || 'api');
  if (b.status === 'active' && s.status !== 'active') {
    await run(c.env, `UPDATE subscribers SET status = 'active', unsubscribed_at = NULL, confirmed_at = COALESCE(confirmed_at, ?), updated_at = ? WHERE id = ?`, now(), now(), s.id);
    await run(c.env, `DELETE FROM suppressions WHERE email = ? AND scope = 'pub' AND pub_id = ?`, s.email, pub.id);
    await emit(c.env, { pubId: pub.id, type: 'subscription.created', subscriberId: s.id, data: { reactivated: true, via: 'api' } });
  }
  const fresh = (await getSubscriber(c.env, pub.id, s.id))!;
  return c.json({ data: serializeSub(fresh, await getTags(c.env, s.id)) });
}, { body: { name: 'string', email: 'string', tier: 'free|premium', status: 'active|unsubscribed', custom_fields: 'object (null value deletes a field)', add_tags: 'string[]', remove_tags: 'string[]' } });

route('DELETE', '/subscriptions/:id', 'Subscriptions', 'Permanently delete a subscriber', async (c, pub) => {
  const s = await needSub(c, pub);
  await deleteSubscriber(c.env, pub.id, s.id);
  return c.json({ data: { id: s.id, deleted: true } });
});

route('GET', '/subscriptions/:id/custom_fields', 'Custom fields', "Read a subscriber's custom field values", async (c, pub) => {
  const s = await needSub(c, pub);
  const defs = await all<any>(c.env, 'SELECT key, label, kind FROM custom_fields WHERE pub_id = ? ORDER BY label', pub.id);
  const vals = parseJSON<Record<string, unknown>>(s.custom, {});
  return c.json({ data: defs.map((d) => ({ key: d.key, label: d.label, kind: d.kind, value: vals[d.key] ?? null })).concat(Object.keys(vals).filter((k) => !defs.some((d) => d.key === k)).map((k) => ({ key: k, label: k, kind: 'text', value: vals[k] as any }))) });
});
route('PUT', '/subscriptions/:id/custom_fields', 'Custom fields', "Write custom field values on a subscriber (merge; null deletes)", async (c, pub) => {
  const s = await needSub(c, pub);
  const b = await body(c);
  const fields = b.custom_fields || b;
  if (typeof fields !== 'object') throw new BadRequest('Send an object of {key: value}.');
  await setFields(c.env, pub.id, s.id, fields);
  const fresh = (await getSubscriber(c.env, pub.id, s.id))!;
  return c.json({ data: parseJSON(fresh.custom, {}) });
}, { body: { custom_fields: 'object {key: value}' } });

route('GET', '/subscriptions/:id/tags', 'Tags', "List a subscriber's tags", async (c, pub) => c.json({ data: await getTags(c.env, (await needSub(c, pub)).id) }));
route('POST', '/subscriptions/:id/tags', 'Tags', 'Add tags to a subscriber', async (c, pub) => {
  const s = await needSub(c, pub);
  const b = await body(c);
  const tags = Array.isArray(b.tags) ? b.tags : b.tag ? [b.tag] : [];
  if (!tags.length) throw new BadRequest('Send {"tags": ["..."]}.');
  await addTags(c.env, pub.id, s.id, tags.map(String));
  return c.json({ data: await getTags(c.env, s.id) });
}, { body: { tags: 'string[]' } });
route('DELETE', '/subscriptions/:id/tags/:tag', 'Tags', 'Remove a tag from a subscriber', async (c, pub) => {
  const s = await needSub(c, pub);
  await removeTags(c.env, pub.id, s.id, [decodeURIComponent(c.req.param('tag') || '')]);
  return c.json({ data: await getTags(c.env, s.id) });
});
route('GET', '/tags', 'Tags', 'All tags with subscriber counts', async (c, pub) => c.json({ data: await all(c.env, 'SELECT tag, COUNT(*) AS subscribers FROM subscriber_tags WHERE pub_id = ? GROUP BY tag ORDER BY subscribers DESC', pub.id) }));

route('GET', '/subscriptions/:id/referrals', 'Referral program', "A subscriber's referral stats, referred readers and rewards earned", async (c, pub) => {
  const s = await needSub(c, pub);
  const referred = await all<any>(c.env, 'SELECT id, email, status, created_at FROM subscribers WHERE referred_by = ? ORDER BY created_at DESC LIMIT 200', s.id);
  const awards = await all<any>(c.env, 'SELECT a.status, a.created_at, r.milestone, r.name, r.kind FROM referral_awards a JOIN referral_rewards r ON r.id = a.reward_id WHERE a.subscriber_id = ? ORDER BY r.milestone', s.id);
  const next = await one<any>(c.env, 'SELECT milestone, name FROM referral_rewards WHERE pub_id = ? AND milestone > ? ORDER BY milestone LIMIT 1', pub.id, s.referral_count);
  return c.json({ data: { referral_code: s.referral_code, referral_url: `${siteUrl(c.env, pub)}/subscribe?ref=${s.referral_code}`, referral_count: s.referral_count, next_milestone: next || null, rewards_earned: awards.map((a) => ({ ...a, created_at: iso(a.created_at) })), referred: referred.map((r) => ({ ...r, created_at: iso(r.created_at) })) } });
});

// ───────── custom field definitions ─────────
route('GET', '/custom_fields', 'Custom fields', 'List custom field definitions', async (c, pub) => c.json({ data: await all(c.env, 'SELECT id, key, label, kind, options, created_at FROM custom_fields WHERE pub_id = ? ORDER BY label', pub.id).then((r) => r.map((x: any) => ({ ...x, options: parseJSON(x.options, []), created_at: iso(x.created_at) }))) }));
route('POST', '/custom_fields', 'Custom fields', 'Create a custom field', async (c, pub) => {
  const b = await body(c);
  const key = String(b.key || b.label || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  if (!key) throw new BadRequest('key or label is required.');
  if (await one(c.env, 'SELECT 1 FROM custom_fields WHERE pub_id = ? AND key = ?', pub.id, key)) return apiError(c, 409, 'conflict', 'A field with that key exists.');
  const kind = ['text', 'number', 'date', 'boolean', 'list'].includes(b.kind) ? b.kind : 'text';
  const fid = id();
  await insert(c.env, 'custom_fields', { id: fid, pub_id: pub.id, key, label: String(b.label || key), kind, options: JSON.stringify(Array.isArray(b.options) ? b.options : []), created_at: now() });
  return c.json({ data: { id: fid, key, label: b.label || key, kind } }, 201);
}, { body: { key: 'string', label: 'string', kind: 'text|number|date|boolean|list', options: 'string[] (for list)' } });
route('PATCH', '/custom_fields/:id', 'Custom fields', 'Update a custom field label/options', async (c, pub) => {
  const f = await needRow(c, 'custom_fields', pub, 'Custom field');
  const b = await body(c);
  const patch: Record<string, unknown> = {};
  if (b.label) patch.label = String(b.label);
  if (Array.isArray(b.options)) patch.options = JSON.stringify(b.options);
  if (b.kind && ['text', 'number', 'date', 'boolean', 'list'].includes(b.kind)) patch.kind = b.kind;
  await update(c.env, 'custom_fields', (f as any).id, patch, pub.id);
  return c.json({ data: { ...(await one<any>(c.env, 'SELECT id, key, label, kind, options FROM custom_fields WHERE id = ?', (f as any).id)) } });
}, { body: { label: 'string', kind: 'string', options: 'string[]' } });
route('DELETE', '/custom_fields/:id', 'Custom fields', 'Delete a custom field definition', async (c, pub) => {
  const f: any = await needRow(c, 'custom_fields', pub, 'Custom field');
  await run(c.env, 'DELETE FROM custom_fields WHERE id = ?', f.id);
  return c.json({ data: { id: f.id, deleted: true } });
});

// ───────── segments & lists ─────────
route('GET', '/segments', 'Segments', 'List segments', async (c, pub) => c.json({ data: (await all<any>(c.env, 'SELECT * FROM segments WHERE pub_id = ? ORDER BY created_at DESC', pub.id)).map((s) => ({ id: s.id, name: s.name, description: s.description, kind: s.kind, rules: parseJSON(s.rules, EMPTY_GROUP), subscriber_count: s.cached_count, calculated_at: iso(s.calculated_at), created_at: iso(s.created_at) })) }));
route('POST', '/segments', 'Segments', 'Create a segment from rules (dynamic or static)', async (c, pub) => {
  const b = await body(c);
  if (!b.name) throw new BadRequest('name is required.');
  const rules: RuleGroup = b.rules && Array.isArray(b.rules.rules) ? b.rules : EMPTY_GROUP;
  const sid = id();
  await insert(c.env, 'segments', { id: sid, pub_id: pub.id, name: String(b.name), description: String(b.description || ''), kind: b.kind === 'static' ? 'static' : 'dynamic', rules: JSON.stringify(rules), created_at: now() });
  if (b.kind === 'static') {
    const { snapshotToStatic } = await import('../../lib/segments');
    await snapshotToStatic(c.env, pub.id, sid, rules);
  }
  const count = await recalcSegment(c.env, pub.id, sid);
  return c.json({ data: { id: sid, name: b.name, kind: b.kind === 'static' ? 'static' : 'dynamic', rules, subscriber_count: count } }, 201);
}, { body: { name: 'string', description: 'string', kind: 'dynamic|static', rules: 'RuleGroup {op, rules:[{field, cmp, value}]} — see /docs/api#segments' } });
route('GET', '/segments/:id', 'Segments', 'Get a segment', async (c, pub) => {
  const s: any = await needRow(c, 'segments', pub, 'Segment');
  return c.json({ data: { id: s.id, name: s.name, description: s.description, kind: s.kind, rules: parseJSON(s.rules, EMPTY_GROUP), subscriber_count: s.cached_count, calculated_at: iso(s.calculated_at) } });
});
route('GET', '/segments/:id/subscribers', 'Segments', 'List every subscriber in a segment (cursor paginated)', async (c, pub) => {
  const s: any = await needRow(c, 'segments', pub, 'Segment');
  const limit = clamp(int(c.req.query('limit'), 100), 1, 500);
  const after = c.req.query('cursor') || undefined;
  let rows: Subscriber[];
  if (s.kind === 'static') rows = await all<Subscriber>(c.env, `SELECT s.* FROM segment_members m JOIN subscribers s ON s.id = m.subscriber_id WHERE m.segment_id = ? ${after ? 'AND s.id > ?' : ''} ORDER BY s.id LIMIT ?`, s.id, ...(after ? [after] : []), limit + 1);
  else rows = await listMatching(c.env, pub.id, parseJSON(s.rules, EMPTY_GROUP), { after, limit: limit + 1, activeOnly: c.req.query('status') !== 'all' });
  const has_more = rows.length > limit;
  const data = rows.slice(0, limit);
  return c.json({ data: data.map((x) => serializeSub(x)), next_cursor: has_more ? data[data.length - 1].id : null, has_more });
}, { query: { limit: '1-500 (default 100)', cursor: 'next_cursor', status: '"all" to include inactive (dynamic segments)' } });
route('POST', '/segments/:id/recalculate', 'Segments', 'Recalculate a segment now', async (c, pub) => {
  const s: any = await needRow(c, 'segments', pub, 'Segment');
  return c.json({ data: { id: s.id, subscriber_count: await recalcSegment(c.env, pub.id, s.id), calculated_at: iso(now()) } });
});
route('DELETE', '/segments/:id', 'Segments', 'Delete a segment', async (c, pub) => {
  const s: any = await needRow(c, 'segments', pub, 'Segment');
  await run(c.env, 'DELETE FROM segments WHERE id = ?', s.id);
  return c.json({ data: { id: s.id, deleted: true } });
});
route('GET', '/lists', 'Lists', 'List newsletter lists with member counts', async (c, pub) => c.json({ data: (await all<any>(c.env, `SELECT l.*, (SELECT COUNT(*) FROM list_members m WHERE m.list_id = l.id AND m.status = 'subscribed') AS members FROM lists l WHERE l.pub_id = ? ORDER BY l.created_at`, pub.id)).map((l) => ({ id: l.id, name: l.name, description: l.description, is_default: !!l.is_default, public: !!l.public, subscribers: l.members })) }));
route('POST', '/lists/:id/subscribers', 'Lists', 'Add a subscriber (id or email) to a list', async (c, pub) => {
  const l: any = await needRow(c, 'lists', pub, 'List');
  const b = await body(c);
  const s = await getSubscriber(c.env, pub.id, String(b.subscriber_id || b.email || ''));
  if (!s) throw new NotFound('Subscriber not found.');
  await joinLists(c.env, pub.id, s.id, [l.id]);
  return c.json({ data: { list_id: l.id, subscriber_id: s.id, status: 'subscribed' } });
}, { body: { subscriber_id: 'string', email: 'string' } });
route('DELETE', '/lists/:id/subscribers/:sid', 'Lists', 'Remove a subscriber from a list', async (c, pub) => {
  const l: any = await needRow(c, 'lists', pub, 'List');
  const s = await needSub(c, pub, 'sid');
  await leaveLists(c.env, pub.id, s.id, [l.id]);
  return c.json({ data: { list_id: l.id, subscriber_id: s.id, status: 'unsubscribed' } });
});

// ───────── automations ─────────
// Shared by REST and MCP. Edits always go to the draft version (draft_trigger / draft_steps) so a live automation keeps
// running unchanged until the draft is published — the same model as the visual builder.
const serAuto = (a: any) => ({
  id: a.id, name: a.name, description: a.description, status: a.status, allow_reentry: !!a.allow_reentry,
  trigger: parseJSON(a.trigger, {}), steps: parseJSON(a.steps, []),
  has_draft: a.draft_steps != null || a.draft_trigger != null,
  draft: a.draft_steps != null || a.draft_trigger != null ? { trigger: parseJSON(a.draft_trigger ?? a.trigger, {}), steps: parseJSON(a.draft_steps ?? a.steps, []) } : null,
  published_at: iso(a.published_at), created_at: iso(a.created_at), updated_at: iso(a.updated_at),
});

/** Validate + normalize a step tree (ids, markdown → editor doc for send_email, yes/no branches). */
export function normalizeSteps(steps: any[], depth = 0): any[] {
  if (!Array.isArray(steps)) throw new BadRequest('steps must be an array.');
  if (depth > 20) throw new BadRequest('steps are nested too deeply.');
  return steps.map((s) => {
    if (!s || typeof s !== 'object') throw new BadRequest('Each step must be an object {type, config}.');
    if (!STEP_TYPES[s.type]) throw new BadRequest(`Unknown step type "${s.type}". Valid: ${Object.keys(STEP_TYPES).join(', ')}.`);
    const config = { ...(s.config || {}) };
    if (s.type === 'send_email' && config.markdown && !config.doc) { config.doc = { blocks: markdownToBlocks(String(config.markdown)) }; delete config.markdown; }
    if (s.type === 'send_email' && Array.isArray(config.blocks) && !config.doc) { config.doc = { blocks: config.blocks }; delete config.blocks; }
    return { id: String(s.id || id(8)).slice(0, 40), type: String(s.type), config, ...(s.yes ? { yes: normalizeSteps(s.yes, depth + 1) } : {}), ...(s.no ? { no: normalizeSteps(s.no, depth + 1) } : {}) };
  });
}

function normalizeTrigger(t: any): { type: string; config: Record<string, unknown> } {
  if (!t || typeof t !== 'object' || !TRIGGERS[t.type]) throw new BadRequest(`Unknown trigger type "${t?.type}". Valid: ${Object.keys(TRIGGERS).join(', ')}.`);
  return { type: String(t.type), config: t.config && typeof t.config === 'object' ? t.config : {} };
}

/** Make the draft version live and set status active (requires at least one step). */
export async function activateAutomation(env: any, pub: Publication, a: any): Promise<any> {
  if (a.status === 'archived') throw new BadRequest('Archived automations cannot be activated.');
  if (a.draft_steps != null || a.draft_trigger != null) await publishDraft(env, a.id, pub.id);
  const fresh = await one<any>(env, 'SELECT * FROM automations WHERE id = ?', a.id);
  if (!parseJSON<any[]>(fresh.steps, []).length) throw new BadRequest('Add at least one step before activating.');
  const emptyEmail = (steps: any[]): boolean => steps.some((st) => (st.type === 'send_email' && (!st.config?.subject || !(st.config?.doc?.blocks || []).length)) || emptyEmail(st.yes || []) || emptyEmail(st.no || []));
  if (emptyEmail(parseJSON<any[]>(fresh.steps, []))) throw new BadRequest('Every send_email step needs a subject and content (config.markdown, config.doc or config.blocks) before activating.');
  if (!TRIGGERS[parseJSON<any>(fresh.trigger, {}).type]) throw new BadRequest('Set a trigger before activating.');
  await run(env, `UPDATE automations SET status = 'active', updated_at = ? WHERE id = ?`, now(), a.id);
  return one<any>(env, 'SELECT * FROM automations WHERE id = ?', a.id);
}

/** Create an automation (as a draft version; `activate: true` publishes it and turns it on). */
export async function createAutomation(env: any, pub: Publication, b: Record<string, any>): Promise<any> {
  const name = String(b.name || '').trim().slice(0, 120);
  if (!name) throw new BadRequest('name is required.');
  const trigger = normalizeTrigger(b.trigger);
  const steps = normalizeSteps(b.steps || []);
  const aid = id();
  await insert(env, 'automations', {
    id: aid, pub_id: pub.id, name, description: String(b.description || '').slice(0, 500), status: 'draft', trigger: '{}', steps: '[]',
    draft_trigger: JSON.stringify(trigger), draft_steps: JSON.stringify(steps), allow_reentry: b.allow_reentry ? 1 : 0, created_at: now(), updated_at: now(),
  });
  const row = await one<any>(env, 'SELECT * FROM automations WHERE id = ?', aid);
  return b.activate ? activateAutomation(env, pub, row) : row;
}

/** Edit an automation. name/description/allow_reentry apply immediately; trigger/steps go to the draft version. */
export async function updateAutomation(env: any, pub: Publication, a: any, b: Record<string, any>): Promise<any> {
  if (a.status === 'archived') throw new BadRequest('Archived automations cannot be edited.');
  const patch: Record<string, unknown> = { updated_at: now() };
  if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 120); if (!n) throw new BadRequest('name cannot be empty.'); patch.name = n; }
  if (b.description !== undefined) patch.description = String(b.description || '').slice(0, 500);
  if (b.allow_reentry !== undefined) patch.allow_reentry = b.allow_reentry ? 1 : 0;
  if (b.trigger !== undefined) patch.draft_trigger = JSON.stringify(normalizeTrigger(b.trigger));
  if (b.steps !== undefined) patch.draft_steps = JSON.stringify(normalizeSteps(b.steps));
  await update(env, 'automations', a.id, patch, pub.id);
  return one<any>(env, 'SELECT * FROM automations WHERE id = ?', a.id);
}

/** Publish the draft version. Running journeys are re-anchored by step id. `activate` also turns a draft/paused automation on. */
export async function publishAutomation(env: any, pub: Publication, a: any, activate = false): Promise<any> {
  if (activate) return activateAutomation(env, pub, a);
  if (a.draft_steps == null && a.draft_trigger == null) throw new BadRequest('There are no draft changes to publish.');
  await publishDraft(env, a.id, pub.id);
  return one<any>(env, 'SELECT * FROM automations WHERE id = ?', a.id);
}

export async function setAutomationPaused(env: any, pub: Publication, a: any, paused: boolean): Promise<any> {
  if (paused && a.status !== 'active') throw new BadRequest(`Only active automations can be paused (status is ${a.status}).`);
  if (!paused && a.status !== 'paused') throw new BadRequest(`Only paused automations can be resumed (status is ${a.status}). Use publish with activate=true to turn on a draft.`);
  await run(env, 'UPDATE automations SET status = ?, updated_at = ? WHERE id = ? AND pub_id = ?', paused ? 'paused' : 'active', now(), a.id, pub.id);
  return one<any>(env, 'SELECT * FROM automations WHERE id = ?', a.id);
}

const AUTO_BODY = {
  name: 'string', description: 'string', allow_reentry: 'boolean',
  trigger: `{type, config} — types: ${Object.keys(TRIGGERS).join(', ')}`,
  steps: `[{id?, type, config, yes?, no?}] — types: ${Object.keys(STEP_TYPES).join(', ')}; send_email config: {subject, markdown | doc | blocks}`,
};
route('POST', '/automations', 'Automations', 'Create an automation (saved as a draft; activate=true publishes it and turns it on)', async (c, pub) => {
  const b = await body(c);
  const a = await createAutomation(c.env, pub, b);
  return c.json({ data: serAuto(a) }, 201);
}, { body: { ...AUTO_BODY, activate: 'boolean' } });
route('PATCH', '/automations/:id', 'Automations', 'Edit an automation — trigger/steps go to the draft version; the live version keeps running until published', async (c, pub) => {
  const a: any = await needRow(c, 'automations', pub, 'Automation');
  return c.json({ data: serAuto(await updateAutomation(c.env, pub, a, await body(c))) });
}, { body: AUTO_BODY });
route('POST', '/automations/:id/publish', 'Automations', 'Publish the draft version (running journeys continue on the new version); activate=true also turns it on', async (c, pub) => {
  const a: any = await needRow(c, 'automations', pub, 'Automation');
  const b = await body(c);
  return c.json({ data: serAuto(await publishAutomation(c.env, pub, a, b.activate === true || b.activate === 'true')) });
}, { body: { activate: 'boolean (default false)' } });
route('POST', '/automations/:id/pause', 'Automations', 'Pause an active automation (subscribers wait where they are)', async (c, pub) => {
  const a: any = await needRow(c, 'automations', pub, 'Automation');
  return c.json({ data: serAuto(await setAutomationPaused(c.env, pub, a, true)) });
});
route('POST', '/automations/:id/resume', 'Automations', 'Resume a paused automation', async (c, pub) => {
  const a: any = await needRow(c, 'automations', pub, 'Automation');
  return c.json({ data: serAuto(await setAutomationPaused(c.env, pub, a, false)) });
});
route('GET', '/automations', 'Automations', 'List automations with journey counts', async (c, pub) => {
  const rows = await all<any>(c.env, `SELECT a.*, (SELECT COUNT(*) FROM automation_runs r WHERE r.automation_id = a.id) AS enrolled, (SELECT COUNT(*) FROM automation_runs r WHERE r.automation_id = a.id AND r.status IN ('active','waiting')) AS in_progress FROM automations a WHERE a.pub_id = ? ORDER BY a.created_at DESC`, pub.id);
  return c.json({ data: rows.map((a) => ({ ...serAuto(a), stats: { enrolled: a.enrolled, in_progress: a.in_progress } })) });
});
route('GET', '/automations/:id', 'Automations', 'Get an automation with per-email stats', async (c, pub) => {
  const a: any = await needRow(c, 'automations', pub, 'Automation');
  const emails = await all<any>(c.env, `SELECT s.step_id, s.subject, COUNT(d.id) AS sent, SUM(CASE WHEN d.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opens, SUM(CASE WHEN d.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicks FROM sends s LEFT JOIN deliveries d ON d.send_id = s.id WHERE s.automation_id = ? GROUP BY s.id`, a.id);
  return c.json({ data: { ...serAuto(a), emails } });
});
route('POST', '/automations/:id/journeys', 'Automations', 'Enroll a subscriber (id or email) into an automation', async (c, pub) => {
  const a: any = await needRow(c, 'automations', pub, 'Automation');
  const b = await body(c);
  let s = await getSubscriber(c.env, pub.id, String(b.subscriber_id || b.email || ''));
  if (!s && b.email) {
    const r = await subscribe(c.env, pub, { email: b.email, source: 'api', skipConfirm: b.double_opt_override === 'off' });
    if (!r.ok) return apiError(c, 422, 'invalid_email', r.error || 'Invalid email');
    s = r.subscriber!;
  }
  if (!s) throw new NotFound('Subscriber not found.');
  const r = await enroll(c.env, a.id, s.id, { via: 'api', ...(b.data && typeof b.data === 'object' ? b.data : {}) });
  if (!r.ok) {
    if (r.reason === 'already enrolled') {
      const existing = await one<any>(c.env, 'SELECT id, status FROM automation_runs WHERE automation_id = ? AND subscriber_id = ? ORDER BY created_at DESC LIMIT 1', a.id, s.id);
      return c.json({ data: { journey_id: existing?.id ?? null, automation_id: a.id, subscriber_id: s.id, status: existing?.status ?? null, already_enrolled: true } });
    }
    return apiError(c, 409, 'not_enrolled', r.reason || 'Could not enroll');
  }
  return c.json({ data: { journey_id: r.runId, automation_id: a.id, subscriber_id: s.id, already_enrolled: false } }, 201);
}, { body: { subscriber_id: 'string', email: 'string (created if new)', data: 'object passed to the journey' } });
route('GET', '/automations/:id/journeys', 'Automations', 'List journeys (per-subscriber progress)', async (c, pub) => {
  const a: any = await needRow(c, 'automations', pub, 'Automation');
  return paginate(c, 'automation_runs', 'automation_id = ?', [a.id], (r) => ({ id: r.id, subscriber_id: r.subscriber_id, status: r.status, step_path: parseJSON(r.step_path, []), next_run_at: iso(r.next_run_at), created_at: iso(r.created_at), updated_at: iso(r.updated_at) }));
}, { query: PAGE_Q });

// ───────── posts ─────────
route('GET', '/posts', 'Posts', 'List posts (filter by status; expand=stats includes engagement)', async (c, pub) => {
  const w = ['pub_id = ?'];
  const p: unknown[] = [pub.id];
  if (c.req.query('status')) { w.push('status = ?'); p.push(c.req.query('status')); }
  if (c.req.query('audience')) { w.push('audience = ?'); p.push(c.req.query('audience')); }
  const expand = (c.req.query('expand') || '').split(',');
  return paginate(c, 'posts', w.join(' AND '), p, async (post) => serializePost(c.env, pub, post, {
    ...(expand.includes('stats') ? { stats: await postStats(c.env, pub.id, post.id) } : {}),
    ...(expand.includes('content') ? { content: parseDoc(post.content) } : {}),
  }));
}, { query: { ...PAGE_Q, status: 'draft|scheduled|published|archived', audience: 'all|free|premium', expand: 'stats,content' } });
route('GET', '/posts/:id', 'Posts', 'Get a post with content, stats (opens, clicks, engagement) and provider breakdown', async (c, pub) => {
  const post = await needPost(c, pub);
  const authors = await all<any>(c.env, 'SELECT u.id, u.name, u.avatar_url FROM post_authors pa JOIN users u ON u.id = pa.user_id WHERE pa.post_id = ? ORDER BY pa.position', post.id);
  const tags = await all<any>(c.env, 'SELECT t.name, t.slug FROM post_tags pt JOIN content_tags t ON t.id = pt.tag_id WHERE pt.post_id = ?', post.id);
  return c.json({ data: serializePost(c.env, pub, post, { authors, content_tags: tags, content: parseDoc(post.content), stats: await postStats(c.env, pub.id, post.id), by_provider: await providerStats(c.env, pub.id, post.id) }) });
});
route('GET', '/posts/:id/stats', 'Posts', 'Engagement stats for a post (unique, bot-filtered)', async (c, pub) => {
  const post = await needPost(c, pub);
  return c.json({ data: { ...(await postStats(c.env, pub.id, post.id)), by_provider: await providerStats(c.env, pub.id, post.id) } });
});
route('GET', '/posts/:id/html', 'Posts', 'Rendered HTML: email vs web, free vs premium', async (c, pub) => {
  const post = await needPost(c, pub);
  const format = c.req.query('format') === 'web' ? 'web' : 'email';
  const premium = c.req.query('audience') === 'premium';
  let html: string, text: string, paywalled: boolean;
  if (format === 'email') {
    const r = await buildEmail(c.env, pub, await postContent(c.env, post), null, { post, access: premium });
    html = r.html; text = r.text; paywalled = r.paywalled;
  } else {
    const r = await renderDoc(parseDoc(post.content), { env: c.env, mode: 'web', pub, siteUrl: siteUrl(c.env, pub), post, access: premium, style: styleFor(pub, post.style) });
    html = r.html; text = r.text; paywalled = r.paywalled;
  }
  if (c.req.query('raw') === '1') return c.html(html);
  const bytes = new TextEncoder().encode(html).length;
  return c.json({ data: { post_id: post.id, format, audience: premium ? 'premium' : 'free', html, text, bytes, paywalled, gmail_clipped: format === 'email' && bytes > GMAIL_CLIP_BYTES } });
}, { query: { format: 'email|web (default email)', audience: 'free|premium (default free)', raw: '1 = return text/html' } });
route('POST', '/posts', 'Posts', 'Create a draft post (blocks, HTML, or Markdown; optionally from a template)', async (c, pub) => {
  const b = await body(c);
  const post = await createPost(c.env, pub, b);
  return c.json({ data: serializePost(c.env, pub, post, { content: parseDoc(post.content) }) }, 201);
}, { body: { title: 'string', subtitle: 'string', blocks: 'Block[] (see Editor document)', html: 'string (wrapped in an HTML block)', markdown: 'string', template_id: 'Start from this template (content is copied; its style stays linked)', email_subject: 'string', preview_text: 'string', platform: 'email|web|both', audience: 'all|free|premium', thumbnail_url: 'string', seo: 'object', segment_ids: 'string[]', author_ids: 'string[]' } });
route('PATCH', '/posts/:id', 'Posts', 'Update a post (replacing content creates a version)', async (c, pub) => {
  const post = await needPost(c, pub);
  const updated = await updatePost(c.env, pub, post, await body(c));
  return c.json({ data: serializePost(c.env, pub, updated, { content: parseDoc(updated.content) }) });
}, { body: { title: 'string', subtitle: 'string', blocks: 'Block[]', html: 'string', markdown: 'string', email_subject: 'string', preview_text: 'string', slug: 'string', platform: 'string', audience: 'string', seo: 'object', segment_ids: 'string[]', exclude_segment_ids: 'string[]', ab_test: 'object|null' } });
route('POST', '/posts/:id/content', 'Posts', 'Append or prepend content blocks', async (c, pub) => {
  const post = await needPost(c, pub);
  const b = await body(c);
  const add = contentToBlocks(b);
  if (!add?.length) throw new BadRequest('Send blocks, html or markdown.');
  const cur = parseDoc(post.content).blocks;
  const blocks = b.position === 'prepend' ? [...add, ...cur] : [...cur, ...add];
  const updated = await updatePost(c.env, pub, post, { blocks });
  return c.json({ data: serializePost(c.env, pub, updated, { content: parseDoc(updated.content) }) });
}, { body: { position: 'append|prepend (default append)', blocks: 'Block[]', html: 'string', markdown: 'string' } });
route('DELETE', '/posts/:id', 'Posts', 'Delete a post', async (c, pub) => {
  const post = await needPost(c, pub);
  await run(c.env, 'DELETE FROM posts WHERE id = ? AND pub_id = ?', post.id, pub.id);
  return c.json({ data: { id: post.id, deleted: true } });
});
route('POST', '/posts/:id/send', 'Send API', 'Publish/send now or schedule (targeting + subject A/B test)', async (c, pub) => {
  const post = await needPost(c, pub);
  const b = await body(c);
  if (!['draft', 'scheduled'].includes(post.status)) return apiError(c, 409, 'already_published', 'This post has already been published.');
  const patch: Record<string, unknown> = {};
  if (b.segment_ids) patch.segment_ids = b.segment_ids;
  if (b.exclude_segment_ids) patch.exclude_segment_ids = b.exclude_segment_ids;
  if (b.audience) patch.audience = b.audience;
  if (b.platform) patch.platform = b.platform;
  if (b.email_subject) patch.email_subject = b.email_subject;
  if (b.ab_test) {
    const subjects = (b.ab_test.subjects || []).filter(Boolean).slice(0, 5);
    if (subjects.length < 2) throw new BadRequest('ab_test.subjects needs at least 2 subject lines.');
    patch.ab_test = { subjects, sample_pct: clamp(int(b.ab_test.sample_pct, 20), 2, 50), wait_minutes: clamp(int(b.ab_test.wait_minutes, 60), 5, 1440), metric: b.ab_test.metric === 'clicks' ? 'clicks' : 'opens' };
  }
  let p = Object.keys(patch).length ? await updatePost(c.env, pub, post, patch) : post;
  if (b.list_id) { await run(c.env, 'UPDATE posts SET list_id = ? WHERE id = ?', b.list_id, p.id); p = { ...p, list_id: b.list_id }; }
  const at = b.scheduled_at ? Date.parse(b.scheduled_at) : NaN;
  if (!isNaN(at) && at > now() + 30_000) {
    await run(c.env, `UPDATE posts SET status = 'scheduled', scheduled_at = ?, updated_at = ? WHERE id = ?`, at, now(), p.id);
    await emit(c.env, { pubId: pub.id, type: 'post.scheduled', refId: p.id, data: { post_id: p.id, title: p.title, scheduled_at: iso(at) }, activity: false });
    return c.json({ data: { post_id: p.id, status: 'scheduled', scheduled_at: iso(at) } }, 202);
  }
  let sendId: string | null;
  try { sendId = await publishPost(c.env, pub, p); }
  catch (e) {
    const { SendBlockedError } = await import('../../lib/plans');
    if (e instanceof SendBlockedError) return c.json({ error: { code: e.code, message: e.message, upgrade_url: e.upgradeUrl } }, 402);
    throw e;
  }
  try { const { kick } = await import('../../lib/jobs'); kick(c.env, c.executionCtx); } catch {}
  return c.json({ data: { post_id: p.id, status: 'published', send_id: sendId, email: p.platform !== 'web' } }, 202);
}, { body: { scheduled_at: 'ISO datetime (omit to send now)', segment_ids: 'string[] send to', exclude_segment_ids: 'string[]', list_id: 'string', audience: 'all|free|premium', platform: 'email|web|both', email_subject: 'string', ab_test: '{subjects: string[2-5], sample_pct, wait_minutes, metric: opens|clicks}' } });
route('POST', '/posts/:id/unschedule', 'Send API', 'Cancel a scheduled post (back to draft)', async (c, pub) => {
  const post = await needPost(c, pub);
  if (post.status !== 'scheduled') return apiError(c, 409, 'not_scheduled', 'Post is not scheduled.');
  await run(c.env, `UPDATE posts SET status = 'draft', scheduled_at = NULL, updated_at = ? WHERE id = ?`, now(), post.id);
  return c.json({ data: { post_id: post.id, status: 'draft' } });
});
route('POST', '/posts/:id/test', 'Send API', 'Send a test email (optionally as a simulated subscriber for merge tags)', async (c, pub) => {
  const post = await needPost(c, pub);
  const b = await body(c);
  const emails: string[] = (Array.isArray(b.emails) ? b.emails : [b.email]).filter(Boolean).slice(0, 10);
  if (!emails.length) throw new BadRequest('Send {"emails": ["you@example.com"]}.');
  const sim = b.subscriber_id ? await getSubscriber(c.env, pub.id, b.subscriber_id) : null;
  const results = [];
  for (const e of emails) {
    const v = await validateEmail(e);
    if (!v.ok) { results.push({ email: e, ok: false, error: v.reason }); continue; }
    const r = await sendTest(c.env, pub, post, v.email, sim ? { ...sim, email: v.email } : undefined);
    results.push({ email: v.email, ok: r.ok, status: r.status, error: r.error });
  }
  return c.json({ data: results });
}, { body: { emails: 'string[] (max 10)', subscriber_id: 'Preview merge tags / dynamic content as this subscriber' } });
route('GET', '/posts/:id/sends', 'Send API', 'Send history for a post', async (c, pub) => {
  const post = await needPost(c, pub);
  const rows = await all<any>(c.env, 'SELECT id, kind, subject, status, total, sent, failed, options, created_at, started_at, completed_at FROM sends WHERE pub_id = ? AND post_id = ? ORDER BY created_at DESC', pub.id, post.id);
  return c.json({ data: rows.map((s) => ({ ...s, options: parseJSON(s.options, {}), created_at: iso(s.created_at), started_at: iso(s.started_at), completed_at: iso(s.completed_at) })) });
});

// ───────── templates ─────────
route('GET', '/templates', 'Templates', 'List templates (publication + built-in library)', async (c, pub) => c.json({ data: (await all<any>(c.env, `SELECT id, pub_id, name, kind, description, is_default, updated_at FROM templates WHERE (pub_id = ? OR pub_id IS NULL) ${c.req.query('kind') ? 'AND kind = ?' : ''} ORDER BY pub_id IS NULL, name`, pub.id, ...(c.req.query('kind') ? [c.req.query('kind')] : []))).map((t) => ({ ...t, library: !t.pub_id, is_default: !!t.is_default, updated_at: iso(t.updated_at) })) }), { query: { kind: 'post|welcome|automation|website_page|website_section|website_block' } });
route('GET', '/templates/:id', 'Templates', 'Get a template with content and style tokens', async (c, pub) => {
  const t = await one<any>(c.env, 'SELECT * FROM templates WHERE id = ? AND (pub_id = ? OR pub_id IS NULL)', c.req.param('id'), pub.id);
  if (!t) throw new NotFound('Template not found.');
  return c.json({ data: { id: t.id, name: t.name, kind: t.kind, description: t.description, content: parseDoc(t.content), style: parseJSON(t.style, {}), library: !t.pub_id, updated_at: iso(t.updated_at) } });
});

route('POST', '/templates/coded', 'Templates', 'Create a custom-coded template from a full HTML email (sanitized; {{unsubscribe_url}} added when missing)', async (c, pub) => {
  const b = await body(c);
  const html = String(b.html || '');
  if (!html.trim()) throw new BadRequest('html is required.');
  const clean = sanitizeEmailDocument(html.slice(0, 400_000));
  const added = !hasUnsubscribeLink(clean);
  const tid = id();
  await insert(c.env, 'templates', { id: tid, pub_id: pub.id, name: String(b.name || 'Coded template').slice(0, 120), kind: 'post', description: String(b.description || '').slice(0, 500), content: JSON.stringify({ blocks: [{ id: id(8), type: 'html_document', data: { html: ensureUnsubscribe(clean) } }] }), style: '{}', category: 'Coded', created_at: now(), updated_at: now() });
  return c.json({ data: { id: tid, name: String(b.name || 'Coded template').slice(0, 120), kind: 'post', coded: true, unsubscribe_added: added } }, 201);
}, { body: { name: 'string', description: 'string', html: 'string (full HTML document or fragment; merge tags + {{unsubscribe_url}}, {{preferences_url}}, {{web_url}})' } });

// ───────── snippets (reusable content blocks) ─────────
const serSnippet = (s: any, withContent = false) => ({ id: s.id, name: s.name, description: s.description, ...(withContent ? { content: parseDoc(s.content) } : { blocks: parseDoc(s.content).blocks.length }), created_at: iso(s.created_at), updated_at: iso(s.updated_at), synced_block: { type: 'snippet', data: { snippet_id: s.id, name: s.name } } });
const snippetBlocks = (b: any): Block[] => (Array.isArray(b.blocks) ? b.blocks : Array.isArray(b.content?.blocks) ? b.content.blocks : []).filter((x: any) => x && typeof x.type === 'string' && !['paywall', 'html_document'].includes(x.type)).slice(0, 200).map((x: any) => ({ id: id(8), type: x.type, data: x.data && typeof x.data === 'object' ? x.data : {} }));
route('GET', '/snippets', 'Snippets', 'List reusable content snippets', async (c, pub) => c.json({ data: (await all<any>(c.env, 'SELECT * FROM snippets WHERE pub_id = ? ORDER BY updated_at DESC', pub.id)).map((s) => serSnippet(s)) }));
route('GET', '/snippets/:id', 'Snippets', 'Get a snippet with its blocks. Insert `synced_block` into a post to keep it linked, or copy `content.blocks`', async (c, pub) => c.json({ data: serSnippet(await needRow(c, 'snippets', pub, 'Snippet'), true) }));
route('POST', '/snippets', 'Snippets', 'Create a snippet from editor blocks', async (c, pub) => {
  const b = await body(c);
  if (!b.name) throw new BadRequest('name is required.');
  const blocks = snippetBlocks(b);
  if (!blocks.length) throw new BadRequest('blocks must contain at least one block.');
  const sid = id();
  await insert(c.env, 'snippets', { id: sid, pub_id: pub.id, name: String(b.name).slice(0, 120), description: String(b.description || '').slice(0, 500), content: JSON.stringify({ blocks }), created_at: now(), updated_at: now() });
  return c.json({ data: serSnippet(await one(c.env, 'SELECT * FROM snippets WHERE id = ?', sid), true) }, 201);
}, { body: { name: 'string', description: 'string', blocks: 'Block[] (editor document blocks)' } });
route('PATCH', '/snippets/:id', 'Snippets', 'Update a snippet (synced copies everywhere pick up the change)', async (c, pub) => {
  const s: any = await needRow(c, 'snippets', pub, 'Snippet');
  const b = await body(c);
  const patch: Record<string, unknown> = { updated_at: now() };
  if (b.name !== undefined) patch.name = String(b.name).slice(0, 120);
  if (b.description !== undefined) patch.description = String(b.description).slice(0, 500);
  if (b.blocks || b.content) patch.content = JSON.stringify({ blocks: snippetBlocks(b).filter((x) => !(x.type === 'snippet' && x.data?.snippet_id === s.id)) });
  await update(c.env, 'snippets', s.id, patch, pub.id);
  return c.json({ data: serSnippet(await one(c.env, 'SELECT * FROM snippets WHERE id = ?', s.id), true) });
}, { body: { name: 'string', description: 'string', blocks: 'Block[]' } });
route('DELETE', '/snippets/:id', 'Snippets', 'Delete a snippet (synced references render nothing afterwards)', async (c, pub) => {
  const s: any = await needRow(c, 'snippets', pub, 'Snippet');
  await run(c.env, 'DELETE FROM snippets WHERE id = ? AND pub_id = ?', s.id, pub.id);
  return c.json({ data: { id: s.id, deleted: true } });
});

// ───────── subject line check & product recommendations ─────────
route('POST', '/subject-line/check', 'Posts', 'Score an email subject line (length, preview text, spam words, caps, emoji, personalization) with per-check advice', async (c) => {
  const b = await body(c);
  return c.json({ data: scoreSubject(String(b.subject || ''), String(b.preview_text || '')) });
}, { body: { subject: 'string', preview_text: 'string' } });
route('GET', '/products/recommendations', 'Commerce', 'Personalized product recommendations for a subscriber (what the recommended_products block would show)', async (c, pub) => {
  const sid = c.req.query('subscriber_id');
  const sub = sid ? await one<any>(c.env, 'SELECT id, email FROM subscribers WHERE id = ? AND pub_id = ?', sid, pub.id) : null;
  if (sid && !sub) throw new NotFound('Subscriber not found.');
  const tags = sub ? await getTags(c.env, sub.id) : [];
  const recs = await recommendProducts(c.env, pub.id, sub, { limit: clamp(int(c.req.query('limit'), 3), 1, 6), tags });
  return c.json({ data: recs.map((r) => ({ id: r.id, name: r.name, slug: r.slug, price_cents: r.price_cents, currency: r.currency, url: `${siteUrl(c.env, pub)}/shop/${r.slug}`, reason: r.reason, because: r.because || null, score: Math.round(r.score * 100) / 100 })) });
}, { query: { subscriber_id: 'Subscriber id (omit for bestsellers)', limit: '1-6 (default 3)' } });

// ───────── tiers & premium ─────────
const serTier = (t: any) => ({ id: t.id, name: t.name, description: t.description, currency: t.currency, monthly_cents: t.monthly_cents, annual_cents: t.annual_cents, trial_days: t.trial_days, paid_trial_cents: t.paid_trial_cents, benefits: parseJSON(t.benefits, []), status: t.status, group_enabled: !!t.group_enabled, created_at: iso(t.created_at) });
route('GET', '/tiers', 'Tiers', 'List paid tiers', async (c, pub) => c.json({ data: (await all<any>(c.env, 'SELECT * FROM tiers WHERE pub_id = ? ORDER BY position, created_at', pub.id)).map(serTier) }));
route('POST', '/tiers', 'Tiers', 'Create a paid tier', async (c, pub) => {
  const b = await body(c);
  if (!b.name) throw new BadRequest('name is required.');
  const tid = id();
  await insert(c.env, 'tiers', { id: tid, pub_id: pub.id, name: String(b.name), description: String(b.description || ''), currency: String(b.currency || 'usd').toLowerCase(), monthly_cents: int(b.monthly_cents), annual_cents: int(b.annual_cents), trial_days: int(b.trial_days), paid_trial_cents: int(b.paid_trial_cents), benefits: JSON.stringify(Array.isArray(b.benefits) ? b.benefits : []), status: 'active', created_at: now() });
  await emit(c.env, { pubId: pub.id, type: 'tier.created', refId: tid, data: { tier_id: tid, name: b.name }, activity: false });
  return c.json({ data: serTier(await one(c.env, 'SELECT * FROM tiers WHERE id = ?', tid)) }, 201);
}, { body: { name: 'string', description: 'string', currency: 'usd|eur|…', monthly_cents: 'int', annual_cents: 'int', trial_days: 'int', paid_trial_cents: 'int', benefits: 'string[]' } });
route('PATCH', '/tiers/:id', 'Tiers', 'Update a tier (status active|paused pauses/resumes sales)', async (c, pub) => {
  const t: any = await needRow(c, 'tiers', pub, 'Tier');
  const b = await body(c);
  const patch: Record<string, unknown> = {};
  for (const k of ['name', 'description']) if (b[k] !== undefined) patch[k] = String(b[k]);
  for (const k of ['monthly_cents', 'annual_cents', 'trial_days', 'paid_trial_cents']) if (b[k] !== undefined) patch[k] = int(b[k]);
  if (Array.isArray(b.benefits)) patch.benefits = JSON.stringify(b.benefits);
  if (b.status && ['active', 'paused'].includes(b.status) && b.status !== t.status) {
    patch.status = b.status;
    await emit(c.env, { pubId: pub.id, type: b.status === 'paused' ? 'tier.paused' : 'tier.resumed', refId: t.id, data: { tier_id: t.id, name: t.name }, activity: false });
  }
  await update(c.env, 'tiers', t.id, patch, pub.id);
  return c.json({ data: serTier(await one(c.env, 'SELECT * FROM tiers WHERE id = ?', t.id)) });
}, { body: { name: 'string', monthly_cents: 'int', annual_cents: 'int', status: 'active|paused', benefits: 'string[]' } });
route('DELETE', '/tiers/:id', 'Tiers', 'Archive a tier', async (c, pub) => {
  const t: any = await needRow(c, 'tiers', pub, 'Tier');
  await update(c.env, 'tiers', t.id, { status: 'archived' }, pub.id);
  await emit(c.env, { pubId: pub.id, type: 'tier.deleted', refId: t.id, data: { tier_id: t.id, name: t.name }, activity: false });
  return c.json({ data: { id: t.id, deleted: true } });
});
route('GET', '/premium_subscriptions', 'Tiers', 'List premium subscriptions', async (c, pub) => {
  const w = ['pub_id = ?'];
  const p: unknown[] = [pub.id];
  if (c.req.query('status')) { w.push('status = ?'); p.push(c.req.query('status')); }
  return paginate(c, 'subscriptions', w.join(' AND '), p, (s) => ({ id: s.id, subscriber_id: s.subscriber_id, tier_id: s.tier_id, interval: s.interval, status: s.status, amount_cents: s.amount_cents, currency: s.currency, seats: s.seats, trial_ends_at: iso(s.trial_ends_at), current_period_end: iso(s.current_period_end), canceled_at: iso(s.canceled_at), created_at: iso(s.created_at) }));
}, { query: { ...PAGE_Q, status: 'trialing|active|paused|past_due|canceled' } });
route('POST', '/subscriptions/:id/premium', 'Tiers', 'Grant premium (comp) to a subscriber', async (c, pub) => {
  const s = await needSub(c, pub);
  const b = await body(c);
  const tier = b.tier_id ? await one<any>(c.env, 'SELECT * FROM tiers WHERE id = ? AND pub_id = ?', b.tier_id, pub.id) : await one<any>(c.env, `SELECT * FROM tiers WHERE pub_id = ? AND status = 'active' ORDER BY position LIMIT 1`, pub.id);
  const days = b.days ? int(b.days) : null;
  const end = days ? now() + days * DAY : null;
  await run(c.env, `UPDATE subscribers SET tier = 'premium', tier_id = ?, trial_ends_at = ?, updated_at = ? WHERE id = ?`, tier?.id ?? null, end, now(), s.id);
  const subId = id();
  if (tier) await insert(c.env, 'subscriptions', { id: subId, pub_id: pub.id, subscriber_id: s.id, tier_id: tier.id, interval: b.interval === 'year' ? 'year' : 'month', status: 'active', amount_cents: 0, currency: tier.currency, current_period_end: end, created_at: now(), updated_at: now() });
  await emit(c.env, { pubId: pub.id, type: 'subscription.upgraded', subscriberId: s.id, data: { tier_id: tier?.id ?? null, comp: true, days } });
  return c.json({ data: { subscriber_id: s.id, tier: 'premium', tier_id: tier?.id ?? null, subscription_id: tier ? subId : null, expires_at: iso(end) } }, 201);
}, { body: { tier_id: 'string (default: first active tier)', interval: 'month|year', days: 'int (omit for no expiry)' } });
route('DELETE', '/subscriptions/:id/premium', 'Tiers', 'Cancel premium for a subscriber', async (c, pub) => {
  const s = await needSub(c, pub);
  await run(c.env, `UPDATE subscriptions SET status = 'canceled', canceled_at = ?, updated_at = ? WHERE subscriber_id = ? AND pub_id = ? AND status IN ('active','trialing','paused','past_due')`, now(), now(), s.id, pub.id);
  await run(c.env, `UPDATE subscribers SET tier = 'free', tier_id = NULL, trial_ends_at = NULL, updated_at = ? WHERE id = ?`, now(), s.id);
  await emit(c.env, { pubId: pub.id, type: 'subscription.downgraded', subscriberId: s.id, data: { reason: 'api' } });
  return c.json({ data: { subscriber_id: s.id, tier: 'free' } });
});

// ───────── referral program ─────────
route('GET', '/referral_program', 'Referral program', 'Rewards/milestones and program totals', async (c, pub) => {
  const rewards = await all<any>(c.env, `SELECT r.*, (SELECT COUNT(*) FROM referral_awards a WHERE a.reward_id = r.id) AS awarded FROM referral_rewards r WHERE r.pub_id = ? ORDER BY r.milestone`, pub.id);
  const referred = await val<number>(c.env, 'SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND referred_by IS NOT NULL', pub.id);
  const referrers = await val<number>(c.env, 'SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND referral_count > 0', pub.id);
  return c.json({ data: { total_referred: referred, active_referrers: referrers, milestones: rewards.map((r) => ({ id: r.id, milestone: r.milestone, name: r.name, description: r.description, kind: r.kind, image_url: r.image_url, times_awarded: r.awarded })) } });
});
route('GET', '/referral_program/leaderboard', 'Referral program', 'Top referrers', async (c, pub) => c.json({ data: (await all<any>(c.env, 'SELECT id, email, name, referral_count, referral_code FROM subscribers WHERE pub_id = ? AND referral_count > 0 ORDER BY referral_count DESC LIMIT ?', pub.id, clamp(int(c.req.query('limit'), 25), 1, 100))) }), { query: { limit: '1-100' } });

// ───────── polls & surveys ─────────
route('GET', '/polls', 'Polls & surveys', 'List polls with vote totals', async (c, pub) => c.json({ data: (await all<any>(c.env, `SELECT p.*, (SELECT COUNT(*) FROM poll_votes v WHERE v.poll_id = p.id) AS votes FROM polls p WHERE p.pub_id = ? ORDER BY p.created_at DESC`, pub.id)).map((p) => ({ id: p.id, question: p.question, options: parseJSON(p.options, []), purpose: p.purpose, closed: !!p.closed, votes: p.votes, created_at: iso(p.created_at) })) }));
route('GET', '/polls/:id', 'Polls & surveys', 'Poll results (live aggregate)', async (c, pub) => {
  const p: any = await needRow(c, 'polls', pub, 'Poll');
  const counts = await all<any>(c.env, 'SELECT option_id, channel, COUNT(*) AS n FROM poll_votes WHERE poll_id = ? GROUP BY option_id, channel', p.id);
  const total = counts.reduce((n, r) => n + r.n, 0);
  const opts = parseJSON<Array<{ id: string; label: string }>>(p.options, []).map((o) => {
    const votes = counts.filter((r) => r.option_id === o.id).reduce((n, r) => n + r.n, 0);
    return { ...o, votes, pct: total ? Math.round((votes / total) * 1000) / 10 : 0, by_channel: Object.fromEntries(counts.filter((r) => r.option_id === o.id).map((r) => [r.channel, r.n])) };
  });
  return c.json({ data: { id: p.id, question: p.question, total_votes: total, options: opts, closed: !!p.closed } });
});
route('POST', '/polls', 'Polls & surveys', 'Create a poll (or a trivia question) to embed in posts', async (c, pub) => {
  const b = await body(c);
  const question = String(b.question || '').trim().slice(0, 300);
  if (!question) throw new BadRequest('question is required.');
  const labels: string[] = (Array.isArray(b.options) ? b.options : []).map((o: any) => String(typeof o === 'object' && o ? o.label : o).trim()).filter(Boolean).slice(0, 10);
  if (labels.length < 2) throw new BadRequest('options needs at least two labels.');
  const options = labels.map((label) => ({ id: id(6), label: label.slice(0, 200) }));
  const trivia = b.kind === 'trivia';
  const ci = int(b.correct_option, 0) - 1;
  if (trivia && (ci < 0 || ci >= options.length)) throw new BadRequest('correct_option (1-based index into options) is required for trivia.');
  const pid = id(12);
  await insert(c.env, 'polls', { id: pid, pub_id: pub.id, question, options: JSON.stringify(options), purpose: ['general', 'topic', 'product', 'pricing'].includes(b.purpose) ? b.purpose : 'general', kind: trivia ? 'trivia' : 'standard', correct_option_id: trivia ? options[ci].id : null, explanation: trivia ? String(b.explanation || '').slice(0, 1000) : '', closed: 0, created_at: now() });
  return c.json({ data: { id: pid, question, options, kind: trivia ? 'trivia' : 'standard', closed: false, url: `${siteUrl(c.env, pub)}/poll/${pid}` } }, 201);
}, { body: { question: 'string', options: 'string[] (2-10)', purpose: 'general|topic|product|pricing', kind: 'standard|trivia', correct_option: 'trivia: 1-based option index', explanation: 'trivia: shown after voting' } });
route('PATCH', '/polls/:id', 'Polls & surveys', 'Close or reopen a poll', async (c, pub) => {
  const p: any = await needRow(c, 'polls', pub, 'Poll');
  const b = await body(c);
  if (b.closed !== undefined) await run(c.env, 'UPDATE polls SET closed = ? WHERE id = ?', b.closed ? 1 : 0, p.id);
  return c.json({ data: { id: p.id, closed: b.closed !== undefined ? !!b.closed : !!p.closed } });
}, { body: { closed: 'boolean' } });
route('GET', '/polls/:id/responses', 'Polls & surveys', 'Individual poll votes tied to subscribers', async (c, pub) => {
  const p: any = await needRow(c, 'polls', pub, 'Poll');
  return paginate(c, 'poll_votes', 'poll_id = ?', [p.id], async (v) => ({ id: v.id, option_id: v.option_id, channel: v.channel, post_id: v.post_id, subscriber: v.subscriber_id ? await one(c.env, 'SELECT id, email, name FROM subscribers WHERE id = ?', v.subscriber_id) : null, created_at: iso(v.created_at) }));
}, { query: PAGE_Q });
route('GET', '/surveys', 'Polls & surveys', 'List surveys with response counts', async (c, pub) => c.json({ data: (await all<any>(c.env, `SELECT s.*, (SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id = s.id) AS responses FROM surveys s WHERE s.pub_id = ? ORDER BY s.created_at DESC`, pub.id)).map((s) => ({ id: s.id, title: s.title, status: s.status, questions: parseJSON(s.questions, []), responses: s.responses, created_at: iso(s.created_at) })) }));
route('GET', '/surveys/:id', 'Polls & surveys', 'Survey with per-question aggregate results', async (c, pub) => {
  const s: any = await needRow(c, 'surveys', pub, 'Survey');
  const qs = parseJSON<any[]>(s.questions, []);
  const resp = await all<any>(c.env, 'SELECT answers FROM survey_responses WHERE survey_id = ? ORDER BY created_at DESC LIMIT 5000', s.id);
  const answers = resp.map((r) => parseJSON<Record<string, any>>(r.answers, {}));
  const results = qs.map((q) => {
    const vals = answers.map((a) => a[q.id]).filter((v) => v !== undefined && v !== '' && v !== null);
    if (['single', 'multi', 'dropdown', 'rating', 'nps'].includes(q.kind)) {
      const counts: Record<string, number> = {};
      for (const v of vals) for (const x of Array.isArray(v) ? v : [v]) counts[String(x)] = (counts[String(x)] || 0) + 1;
      const nums = vals.map(Number).filter((n) => !isNaN(n));
      return { id: q.id, label: q.label, kind: q.kind, responses: vals.length, counts, ...(q.kind === 'rating' || q.kind === 'nps' ? { average: nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : null } : {}) };
    }
    return { id: q.id, label: q.label, kind: q.kind, responses: vals.length, samples: vals.slice(0, 20) };
  });
  return c.json({ data: { id: s.id, title: s.title, total_responses: resp.length, questions: results } });
});
const SURVEY_KINDS = ['short', 'long', 'single', 'multi', 'dropdown', 'rating', 'nps', 'date'];
function surveyQuestions(qs: any): any[] {
  if (!Array.isArray(qs) || !qs.length) throw new BadRequest('questions must be a non-empty array of {label, kind, options?, required?}.');
  return qs.slice(0, 50).map((q: any) => {
    if (!q || !String(q.label || '').trim()) throw new BadRequest('Every question needs a label.');
    const kind = q.kind || 'short';
    if (!SURVEY_KINDS.includes(kind)) throw new BadRequest(`Unknown question kind "${kind}". Valid: ${SURVEY_KINDS.join(', ')}.`);
    const options = Array.isArray(q.options) ? q.options.map((o: any) => String(o).slice(0, 200)).filter(Boolean).slice(0, 30) : undefined;
    if (['single', 'multi', 'dropdown'].includes(kind) && (!options || options.length < 2)) throw new BadRequest(`"${q.label}" needs at least two options.`);
    return { id: String(q.id || id(6)).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20) || id(6), kind, label: String(q.label).slice(0, 300), options, required: !!q.required };
  });
}
route('POST', '/surveys', 'Polls & surveys', 'Create a survey', async (c, pub) => {
  const b = await body(c);
  const title = String(b.title || '').trim().slice(0, 200);
  if (!title) throw new BadRequest('title is required.');
  const questions = surveyQuestions(b.questions);
  const sid = id(12);
  await insert(c.env, 'surveys', { id: sid, pub_id: pub.id, title, description: String(b.description || '').slice(0, 1000), questions: JSON.stringify(questions), status: b.status === 'closed' ? 'closed' : 'active', thank_you: String(b.thank_you || 'Thanks for your response!').slice(0, 300), created_at: now() });
  return c.json({ data: { id: sid, title, status: b.status === 'closed' ? 'closed' : 'active', questions, url: `${siteUrl(c.env, pub)}/survey/${sid}` } }, 201);
}, { body: { title: 'string', description: 'string', questions: `[{label, kind: ${SURVEY_KINDS.join('|')}, options?, required?}]`, thank_you: 'string', status: 'active|closed' } });
route('PATCH', '/surveys/:id', 'Polls & surveys', 'Update a survey (title, description, thank-you message, status, questions)', async (c, pub) => {
  const s: any = await needRow(c, 'surveys', pub, 'Survey');
  const b = await body(c);
  const patch: Record<string, unknown> = {};
  if (b.title !== undefined) { const t = String(b.title).trim().slice(0, 200); if (!t) throw new BadRequest('title cannot be empty.'); patch.title = t; }
  if (b.description !== undefined) patch.description = String(b.description || '').slice(0, 1000);
  if (b.thank_you !== undefined) patch.thank_you = String(b.thank_you || 'Thanks for your response!').slice(0, 300);
  if (b.status !== undefined) patch.status = b.status === 'closed' ? 'closed' : 'active';
  if (b.questions !== undefined) patch.questions = JSON.stringify(surveyQuestions(b.questions));
  await update(c.env, 'surveys', s.id, patch, pub.id);
  const f: any = await one(c.env, 'SELECT * FROM surveys WHERE id = ?', s.id);
  return c.json({ data: { id: f.id, title: f.title, status: f.status, questions: parseJSON(f.questions, []) } });
}, { body: { title: 'string', description: 'string', questions: 'array (replaces all)', thank_you: 'string', status: 'active|closed' } });
route('GET', '/surveys/:id/responses', 'Polls & surveys', 'Individual survey responses', async (c, pub) => {
  const s: any = await needRow(c, 'surveys', pub, 'Survey');
  return paginate(c, 'survey_responses', 'survey_id = ?', [s.id], async (r) => ({ id: r.id, answers: parseJSON(r.answers, {}), subscriber: r.subscriber_id ? await one(c.env, 'SELECT id, email, name FROM subscribers WHERE id = ?', r.subscriber_id) : null, created_at: iso(r.created_at) }));
}, { query: PAGE_Q });

// ───────── webhooks ─────────
route('GET', '/webhooks', 'Webhooks', 'List webhook endpoints', async (c, pub) => c.json({ data: (await all<any>(c.env, 'SELECT id, url, description, events, version, active, created_at FROM webhooks WHERE pub_id = ? ORDER BY created_at DESC', pub.id)).map((w) => ({ ...w, events: parseJSON(w.events, []), active: !!w.active, created_at: iso(w.created_at) })) }));
route('POST', '/webhooks', 'Webhooks', 'Create a webhook endpoint (returns the signing secret once)', async (c, pub) => {
  const b = await body(c);
  let u: URL;
  try { u = new URL(String(b.url)); } catch { throw new BadRequest('url must be a valid https URL.'); }
  if (!/^https?:$/.test(u.protocol)) throw new BadRequest('url must be http(s).');
  const { WEBHOOK_EVENTS } = await import('../../lib/events');
  const events: string[] = Array.isArray(b.events) && b.events.length ? b.events : ['*'];
  const bad = events.filter((e) => e !== '*' && !(WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (bad.length) throw new BadRequest(`Unknown events: ${bad.join(', ')}`);
  if (b.version !== undefined && !isWebhookVersion(b.version)) throw new BadRequest(`Unknown version. Available: ${WEBHOOK_VERSIONS.map((v) => v.version).join(', ')}`);
  const version = b.version || LATEST_WEBHOOK_VERSION;
  const wid = id();
  const secret = 'whsec_' + token(24);
  await insert(c.env, 'webhooks', { id: wid, pub_id: pub.id, url: u.toString(), description: String(b.description || ''), events: JSON.stringify(events), secret, version, active: 1, created_at: now() });
  return c.json({ data: { id: wid, url: u.toString(), events, version, secret, active: true } }, 201);
}, { body: { url: 'string', events: 'string[] (default ["*"])', description: 'string', version: 'payload version (default: latest — see GET /webhooks/versions)' } });
route('GET', '/webhooks/versions', 'Webhooks', 'Available payload versions with changelog', async (c) => c.json({ data: WEBHOOK_VERSIONS.map((v) => ({ version: v.version, released: v.released, latest: v.version === LATEST_WEBHOOK_VERSION, summary: v.summary, changes: v.changes })) }));
route('PATCH', '/webhooks/:id', 'Webhooks', 'Update an endpoint (url, events, description, active, or upgrade/downgrade its payload version)', async (c, pub) => {
  const w: any = await needRow(c, 'webhooks', pub, 'Webhook');
  const b = await body(c);
  const patch: Record<string, unknown> = {};
  if (b.url !== undefined) {
    let u: URL;
    try { u = new URL(String(b.url)); } catch { throw new BadRequest('url must be a valid https URL.'); }
    if (!/^https?:$/.test(u.protocol)) throw new BadRequest('url must be http(s).');
    patch.url = u.toString();
  }
  if (b.events !== undefined) {
    const { WEBHOOK_EVENTS } = await import('../../lib/events');
    const events: string[] = Array.isArray(b.events) && b.events.length ? b.events : ['*'];
    const bad = events.filter((e) => e !== '*' && !(WEBHOOK_EVENTS as readonly string[]).includes(e));
    if (bad.length) throw new BadRequest(`Unknown events: ${bad.join(', ')}`);
    patch.events = JSON.stringify(events);
  }
  if (b.description !== undefined) patch.description = String(b.description || '').slice(0, 200);
  if (b.active !== undefined) patch.active = b.active ? 1 : 0;
  if (b.version !== undefined) {
    if (!isWebhookVersion(b.version)) throw new BadRequest(`Unknown version. Available: ${WEBHOOK_VERSIONS.map((v) => v.version).join(', ')}`);
    patch.version = b.version;
  }
  if (Object.keys(patch).length) await update(c.env, 'webhooks', w.id, patch, pub.id);
  const f: any = await one(c.env, 'SELECT id, url, description, events, version, active, created_at FROM webhooks WHERE id = ?', w.id);
  return c.json({ data: { ...f, events: parseJSON(f.events, []), active: !!f.active, created_at: iso(f.created_at) } });
}, { body: { url: 'string', events: 'string[]', description: 'string', active: 'boolean', version: 'payload version' } });
route('DELETE', '/webhooks/:id', 'Webhooks', 'Delete a webhook endpoint', async (c, pub) => {
  const w: any = await needRow(c, 'webhooks', pub, 'Webhook');
  await run(c.env, 'DELETE FROM webhooks WHERE id = ?', w.id);
  return c.json({ data: { id: w.id, deleted: true } });
});
route('GET', '/webhooks/:id/deliveries', 'Webhooks', 'Delivery log for an endpoint (expand=attempts includes every attempt)', async (c, pub) => {
  const w: any = await needRow(c, 'webhooks', pub, 'Webhook');
  const withAttempts = (c.req.query('expand') || '').split(',').includes('attempts');
  return paginate(c, 'webhook_deliveries', 'webhook_id = ?', [w.id], async (d) => ({
    id: d.id, event: d.event, version: parseJSON<any>(d.payload, {}).version ?? null, status: d.status, attempts: d.attempts, response_code: d.response_code, created_at: iso(d.created_at), updated_at: iso(d.updated_at),
    ...(withAttempts ? { attempt_log: (await deliveryAttempts(c.env, d.id)).map((a) => ({ ...a, manual: !!a.manual, created_at: iso(a.created_at) })) } : {}),
  }));
}, { query: { ...PAGE_Q, expand: 'attempts' } });
route('GET', '/webhooks/:id/deliveries/:did', 'Webhooks', 'One delivery: payload and every attempt (status code, response, latency)', async (c, pub) => {
  const w: any = await needRow(c, 'webhooks', pub, 'Webhook');
  const d = await one<any>(c.env, 'SELECT * FROM webhook_deliveries WHERE id = ? AND webhook_id = ?', c.req.param('did'), w.id);
  if (!d) throw new NotFound('Delivery not found.');
  return c.json({ data: { id: d.id, event: d.event, status: d.status, attempts: d.attempts, payload: parseJSON(d.payload, {}), attempt_log: (await deliveryAttempts(c.env, d.id)).map((a) => ({ ...a, manual: !!a.manual, created_at: iso(a.created_at) })), created_at: iso(d.created_at), updated_at: iso(d.updated_at) } });
});

// ───────── commerce, podcasts ─────────
route('GET', '/orders', 'Commerce', 'List orders (subscriptions, products, tickets…)', async (c, pub) => {
  const w = ['pub_id = ?'];
  const p: unknown[] = [pub.id];
  if (c.req.query('kind')) { w.push('kind = ?'); p.push(c.req.query('kind')); }
  if (c.req.query('status')) { w.push('status = ?'); p.push(c.req.query('status')); }
  return paginate(c, 'orders', w.join(' AND '), p, (o) => ({ id: o.id, kind: o.kind, ref_id: o.ref_id, email: o.email, name: o.name, amount_cents: o.amount_cents, currency: o.currency, status: o.status, subscriber_id: o.subscriber_id, created_at: iso(o.created_at), paid_at: iso(o.paid_at) }));
}, { query: { ...PAGE_Q, kind: 'subscription|product|ticket|gift|group|sponsorship|replay', status: 'pending|paid|refunded|failed' } });
route('GET', '/products', 'Commerce', 'List digital products with sales totals', async (c, pub) => c.json({ data: (await all<any>(c.env, 'SELECT id, name, slug, kind, price_cents, currency, status, tags, sales_count, revenue_cents, created_at FROM products WHERE pub_id = ? ORDER BY created_at DESC', pub.id)).map((p) => ({ ...p, tags: parseJSON(p.tags, []), url: `${siteUrl(c.env, pub)}/shop/${p.slug}`, created_at: iso(p.created_at) })) }));
route('GET', '/podcasts', 'Podcasts', 'List podcast shows', async (c, pub) => c.json({ data: (await all<any>(c.env, `SELECT p.*, (SELECT COUNT(*) FROM episodes e WHERE e.podcast_id = p.id) AS episodes FROM podcasts p WHERE p.pub_id = ? ORDER BY p.created_at`, pub.id)).map((p) => ({ id: p.id, title: p.title, slug: p.slug, description: p.description, author: p.author, cover_url: p.cover_url, category: p.category, access: p.access, episodes: p.episodes, feed_url: `${siteUrl(c.env, pub)}/podcasts/${p.slug}/feed.xml`, created_at: iso(p.created_at) })) }));
route('GET', '/podcasts/:id/episodes', 'Podcasts', 'List episodes with download counts', async (c, pub) => {
  const pod: any = await needRow(c, 'podcasts', pub, 'Podcast');
  return paginate(c, 'episodes', 'podcast_id = ?', [pod.id], async (e) => ({ id: e.id, guid: e.guid, title: e.title, slug: e.slug, status: e.status, premium: !!e.premium, duration: e.duration, season: e.season, number: e.number, downloads: await val(c.env, 'SELECT COUNT(*) FROM episode_downloads WHERE episode_id = ? AND is_bot = 0', e.id), published_at: iso(e.published_at), created_at: iso(e.created_at) }));
}, { query: PAGE_Q });

/** helper re-exported for MCP */
export { countMatching };
