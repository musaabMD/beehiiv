// Newsletter sending engine.
// - startSend(): snapshot targeting, create `sends` row, queue batches
// - batches personalize per recipient (merge tags, dynamic content, premium access, cohorts)
// - A/B subject tests: sample phase → winner by opens/clicks → remainder
// - warmup caps per sending domain, blocklist pause, deferred retries for 26h, tracking pixel + click wrapping
import type { Env, Publication, Post, Subscriber } from '../types';
import { one, all, run, insert, val, stmt, batch } from './db';
import { emit } from './events';
import { registerJob, registerPeriodic, enqueue, logError } from './jobs';
import { renderDoc, emailLayout, parseDoc, styleFor, applyMerge, mergeVars, type Doc, type StyleTokens } from './render';
import { sendMail, recordBounce, classifyBounce } from './email';
import { compile, recalcSegment, segmentIdsFor, type RuleGroup } from './segments';
import { settings, siteUrl, senderFor, getPub } from './pub';
import { subToken, unsubscribeUrl, preferencesUrl, getTags } from './subscribers';
import { id, now, sha256, parseJSON, mailboxProvider, domainOf, HOUR, DAY, MIN, fmtDate, esc } from './util';
import { assertCanSend, SendBlockedError, showsBranding, emailBrandingHtml, getWorkspace, ownerOf } from './plans';
import { needsApproval, requestApproval, checkCampaign, rampRemaining, workspaceSuspended } from './safety';
import { replyToFor } from './sharedsender';
import { normalizeTiming, planTimes, type SendTiming } from './sendtime';

export interface SendOptions {
  segment_ids?: string[];
  exclude_segment_ids?: string[];
  list_id?: string | null;
  audience?: 'all' | 'free' | 'premium';
  tier_ids?: string[];
  ab?: AbTest | null;
  /** send-time optimization / delivery by time zone (lib/sendtime) */
  timing?: SendTiming | null;
  cohorts?: Array<{ name: string; pct: number }> | null;
  phase?: 'test' | 'main';
  winner?: string | null;
  only_subscriber_ids?: string[];
  /** when the A/B winner was picked (deliveries before it are the test sample) */
  ab_decided_at?: number;
  /** override subject line for this send (e.g. resend to non-openers) */
  subject?: string | null;
}

/**
 * A/B + multivariate test (posts.ab_test). `subjects[i]` is variant i's subject (letters A–E); `variants[i]` optionally
 * changes the preview text, the sender name and/or the content body ('b' = posts.alt_content, "Variant B content").
 * Up to 4 variants when any dimension other than the subject is tested (5 subject-only variants for API compatibility).
 */
export interface AbVariant { subject?: string; preview_text?: string; from_name?: string; content?: 'a' | 'b' }
export interface AbTest { subjects: string[]; variants?: AbVariant[]; sample_pct: number; wait_minutes: number; metric: 'opens' | 'clicks'; winner?: string | null }

const clampN = (v: unknown, lo: number, hi: number, d: number) => { const n = Math.round(Number(v)); return isFinite(n) && v !== '' && v !== null && v !== undefined ? Math.min(hi, Math.max(lo, n)) : d; };

/** Validate an A/B / multivariate config from the editor, REST or MCP. null = no (valid) test. */
export function normalizeAb(input: any): AbTest | null {
  if (!input || typeof input !== 'object') return null;
  const rawVariants: any[] | null = Array.isArray(input.variants) ? input.variants.slice(0, 4) : null;
  let variants: AbVariant[] | undefined;
  let subjects: string[];
  if (rawVariants && rawVariants.length) {
    variants = rawVariants.map((v, i) => ({
      subject: String(v?.subject ?? input.subjects?.[i] ?? '').trim().slice(0, 200),
      preview_text: String(v?.preview_text ?? '').trim().slice(0, 200) || undefined,
      from_name: String(v?.from_name ?? '').trim().slice(0, 80) || undefined,
      content: v?.content === 'b' ? 'b' : 'a',
    }));
    subjects = variants.map((v) => v.subject || '');
    // only subjects differ → plain subject test (compact storage)
    if (variants.every((v) => !v.preview_text && !v.from_name && v.content === 'a')) { subjects = subjects.filter(Boolean); variants = undefined; }
  } else {
    subjects = (Array.isArray(input.subjects) ? input.subjects : []).map((s: any) => String(s ?? '').trim().slice(0, 200)).filter(Boolean).slice(0, 5);
  }
  if (subjects.length < 2) return null;
  const sig = (i: number) => JSON.stringify([subjects[i] || '', variants?.[i]?.preview_text || '', variants?.[i]?.from_name || '', variants?.[i]?.content || 'a']);
  if (new Set(subjects.map((_, i) => sig(i))).size < 2) return null; // every variant identical
  return {
    subjects, ...(variants ? { variants } : {}),
    sample_pct: clampN(input.sample_pct, 2, 50, 20), wait_minutes: clampN(input.wait_minutes, 5, 1440, 60),
    metric: input.metric === 'clicks' ? 'clicks' : 'opens', ...(input.winner ? { winner: String(input.winner).slice(0, 1) } : {}),
  };
}

/** Content + sender for one variant letter (A/B/C/D). Without a variant (or no test) → the main content. */
export function variantParts(o: SendOptions, letter: string | null, base: { content: Content; alt: Content | null; from: { email: string; name: string } }) {
  const idx = letter ? letter.charCodeAt(0) - 65 : -1;
  const v = idx >= 0 ? o.ab?.variants?.[idx] : undefined;
  let content = v?.content === 'b' && base.alt ? base.alt : base.content;
  if (v?.preview_text) content = { ...content, preview_text: v.preview_text };
  const from = v?.from_name ? { ...base.from, name: v.from_name } : base.from;
  const subject = idx >= 0 ? o.ab?.subjects?.[idx] : undefined;
  return { content, from, subject };
}

/** Variant B content (posts.alt_content) as a Content, or null. */
export function altContent(post: Post, main: Content): Content | null {
  const raw = (post as any).alt_content as string | null | undefined;
  if (!raw) return null;
  const doc = parseDoc(raw);
  return doc.blocks?.length ? { ...main, doc } : null;
}

const BATCH = 50;
/** Default emails/minute per send when the publication hasn't set one (override with the SEND_RATE_PER_MINUTE var). */
const DEFAULT_RATE = 1200;
/** Emails handed to the sending binding at the same time within a batch. */
const PARALLEL = 10;

// ───────── targeting ─────────
export async function audienceGroup(env: Env, pubId: string, o: SendOptions): Promise<RuleGroup> {
  const rules: any[] = [];
  if (o.audience === 'free') rules.push({ field: 'tier', cmp: 'eq', value: 'free' });
  if (o.audience === 'premium') rules.push({ field: 'tier', cmp: 'eq', value: 'premium' });
  if (o.tier_ids?.length) rules.push({ op: 'or', rules: o.tier_ids.map((t) => ({ field: 'tier_id', cmp: 'eq', value: t })) });
  if (o.list_id) rules.push({ field: 'list', cmp: 'in', value: o.list_id });
  if (o.segment_ids?.length) rules.push({ op: 'or', rules: o.segment_ids.map((s) => ({ field: 'segment', cmp: 'in', value: s })) });
  for (const s of o.exclude_segment_ids || []) rules.push({ field: 'segment', cmp: 'not_in', value: s });
  return { op: 'and', rules };
}

/** Recipients a post would go to with its saved targeting. */
export async function countPostRecipients(env: Env, pub: Publication, post: Post): Promise<number> {
  return countRecipients(env, pub.id, { segment_ids: parseJSON(post.segment_ids, []), exclude_segment_ids: parseJSON(post.exclude_segment_ids, []), list_id: post.list_id, audience: (post.audience as any) || 'all', tier_ids: parseJSON(post.tier_ids, []) });
}

export async function countRecipients(env: Env, pubId: string, o: SendOptions): Promise<number> {
  const c = await compile(env, pubId, await audienceGroup(env, pubId, o));
  return val<number>(env, `SELECT COUNT(*) FROM subscribers s WHERE s.pub_id = ? AND s.status = 'active' AND (${c.sql})`, pubId, ...c.params);
}

function bucket(seed: string): Promise<number> {
  return sha256(seed).then((h) => parseInt(h.slice(0, 8), 16) % 10000 / 100); // 0..99.99
}

// ───────── link tracking ─────────
export function trackLinks(html: string, env: Env, deliveryToken: string, pub: Publication, campaign?: string): string {
  const cfg = settings(pub);
  const base = env.APP_URL.replace(/\/$/, '');
  return html.replace(/href="(https?:\/\/[^"]+)"/g, (m, url: string) => {
    if (url.startsWith(base + '/u/') || url.startsWith(base + '/pref/') || url.startsWith(base + '/t/')) return m;
    let target = url.replace(/&amp;/g, '&');
    if (cfg.utm_tracking !== false && !/[?&]utm_source=/.test(target)) {
      target += (target.includes('?') ? '&' : '?') + `utm_source=${encodeURIComponent(pub.slug)}&utm_medium=newsletter${campaign ? `&utm_campaign=${encodeURIComponent(campaign)}` : ''}`;
    }
    if (cfg.link_params) target += (target.includes('?') ? '&' : '?') + cfg.link_params.replace(/\{pub\}/g, pub.slug).replace(/\{post\}/g, campaign || '');
    return `href="${base}/t/c/${deliveryToken}?u=${encodeURIComponent(target)}"`;
  });
}

export function openPixel(env: Env, deliveryToken: string) {
  return `<img src="${env.APP_URL.replace(/\/$/, '')}/t/o/${deliveryToken}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />`;
}

// ───────── building one email ─────────
export interface Content { title: string; subtitle?: string; doc: Doc; preview_text?: string; slug?: string | null; thumbnail?: string | null; style?: string | null; byline?: string; hideHeader?: boolean }

export async function postContent(env: Env, post: Post): Promise<Content> {
  const authors = await all<{ name: string }>(env, 'SELECT u.name FROM post_authors pa JOIN users u ON u.id = pa.user_id WHERE pa.post_id = ? ORDER BY pa.position', post.id);
  // Effective email style = publication default (styleFor) ⊕ linked template's current style ⊕ the post's own overrides.
  const tpl = post.template_id ? await one<{ style: string }>(env, 'SELECT style FROM templates WHERE id = ? AND (pub_id IS NULL OR pub_id = ?)', post.template_id, post.pub_id) : null;
  return {
    title: post.title, subtitle: post.subtitle, doc: parseDoc(post.email_content || post.content), preview_text: post.preview_text, slug: post.slug,
    thumbnail: post.thumbnail_url, style: JSON.stringify({ ...parseJSON(tpl?.style, {} as any).email, ...parseJSON(post.style, {} as any).email }),
    byline: authors.length ? `By ${authors.map((a) => a.name).join(', ')}` : undefined,
  };
}

/** Render a full email for one recipient (or a simulated/preview subscriber). */
export async function buildEmail(env: Env, pub: Publication, c: Content, sub: Subscriber | null, o: { deliveryId?: string; post?: Post | null; cohort?: string | null; access?: boolean; preview?: boolean } = {}) {
  const style: StyleTokens = styleFor(pub, c.style);
  const access = o.access ?? (sub ? sub.tier === 'premium' : false);
  const tags = sub ? await getTags(env, sub.id) : [];
  const segIds = sub ? await segmentIdsFor(env, sub.id) : new Set<string>();
  const surl = siteUrl(env, pub);
  const r = await renderDoc(c.doc, { env, mode: 'email', pub, siteUrl: surl, post: o.post, subscriber: sub, tags, segmentIds: segIds, access, style, deliveryId: o.deliveryId, cohort: o.cohort, preview: o.preview });
  const tok = sub ? await subToken(env, sub.id) : 'preview';
  const unsub = unsubscribeUrl(env, tok);
  const webUrl = c.slug ? `${surl}/p/${c.slug}` : null;
  // Free plan: small "Sent with Lnkbase Newsletter" line in the footer (removed on paid plans)
  const branding = pub.workspace_id && (await showsBranding(env, pub.workspace_id)) ? emailBrandingHtml(pub.slug, style.muted) : undefined;
  let html = emailLayout(r.html, {
    extraFooter: branding,
    pub, style, title: c.hideHeader ? undefined : c.title, subtitle: c.subtitle, byline: c.byline ? `${c.byline} · ${fmtDate(Date.now(), { dateStyle: 'long' }, pub.timezone)}` : undefined,
    preheader: c.preview_text ? applyMerge(c.preview_text, mergeVars(pub, sub, surl)) : undefined, webUrl, unsubscribeUrl: unsub, preferencesUrl: preferencesUrl(env, tok), thumbnail: c.thumbnail, hideHeader: c.hideHeader,
  });
  if (o.deliveryId) {
    html = trackLinks(html, env, o.deliveryId, pub, c.slug || undefined);
    html = html.replace('</body>', openPixel(env, o.deliveryId) + '</body>');
  }
  return { html, text: r.text, bytes: new TextEncoder().encode(html).length, unsubscribeUrl: unsub, paywalled: r.paywalled };
}

// ───────── warmup & blocklist ─────────
/**
 * Daily cap for a sending domain under warmup: 200 → doubles daily → unlimited after day 12.
 * Applies to publications' custom email domains and to the default MAIL_FROM domain (lib/domains platform_domains).
 */
export async function warmupAllowance(env: Env, fromEmail: string): Promise<{ ok: boolean; reason?: string; remaining: number }> {
  const host = domainOf(fromEmail);
  const dom = (await one<any>(env, `SELECT * FROM domains WHERE hostname = ? AND kind = 'email'`, host))
    || (await (await import('./domains')).platformWarmupDomain(env, host));
  if (!dom) return { ok: true, remaining: Infinity };
  if (dom.blocklisted) return { ok: false, reason: `Sending domain ${dom.hostname} is on a blocklist — sending paused`, remaining: 0 };
  if (!dom.warmup_started_at) return { ok: true, remaining: Infinity };
  const day = Math.floor((now() - dom.warmup_started_at) / DAY);
  if (day >= 12) return { ok: true, remaining: Infinity };
  const cap = 200 * 2 ** day;
  const since = now() - DAY;
  const sent = await val<number>(env, `SELECT COUNT(*) FROM outbox WHERE from_email LIKE ? AND created_at > ? AND status IN ('sent','simulated')`, `%@${dom.hostname}>`, since);
  return { ok: sent < cap, remaining: Math.max(0, cap - sent), reason: sent >= cap ? `Warmup cap reached (${cap}/day on day ${day + 1})` : undefined };
}

// ───────── start / process ─────────
export async function startSend(env: Env, pub: Publication, post: Post, overrides: Partial<SendOptions> = {}): Promise<string> {
  const o: SendOptions = {
    segment_ids: parseJSON(post.segment_ids, []), exclude_segment_ids: parseJSON(post.exclude_segment_ids, []), list_id: post.list_id,
    audience: (post.audience as any) || 'all', tier_ids: parseJSON(post.tier_ids, []),
    ab: normalizeAb(parseJSON(post.ab_test, null)), cohorts: parseJSON<any>(post.cohort_test, null)?.cohorts || null,
    timing: normalizeTiming(parseJSON((post as any).send_timing, null)), ...overrides,
  };
  if (o.ab) {
    // variants that only change preview/sender/content keep the post's subject
    const base = o.subject || post.email_subject || post.title;
    o.ab = { ...o.ab, subjects: o.ab.subjects.map((s) => s || base), winner: null };
    if (o.ab.variants?.some((v) => v.content === 'b') && !altContent(post, { title: '', doc: { blocks: [] } })) o.ab.variants = o.ab.variants.map((v) => ({ ...v, content: 'a' }));
    if (o.ab.subjects.length < 2) o.ab = null;
  }
  if (o.timing) o.timing = { ...o.timing, planned: false };
  // refresh dynamic segment caches used for targeting/dynamic content
  const segIds = new Set<string>([...(o.segment_ids || []), ...(o.exclude_segment_ids || [])]);
  JSON.stringify(parseDoc(post.content)).replace(/"segment_ids":\[([^\]]*)\]/g, (_m, ids: string) => { ids.replace(/"([^"]+)"/g, (_x, sid: string) => (segIds.add(sid), '')); return ''; });
  for (const sid of segIds) await recalcSegment(env, pub.id, sid);
  const total = o.only_subscriber_ids ? o.only_subscriber_ids.length : await countRecipients(env, pub.id, o);
  // Plan limits (subscriber cap, monthly email allowance, suspension): blocked before anything is queued.
  await assertCanSend(env, pub, total);
  o.phase = o.ab ? 'test' : 'main';
  const sendId = id();
  const subject = o.subject || post.email_subject || post.title;
  // A not-yet-trusted workspace's first campaign above the approval threshold waits for a superadmin.
  const hold = await needsApproval(env, pub, total);
  await insert(env, 'sends', {
    id: sendId, pub_id: pub.id, post_id: post.id, kind: 'post', subject, status: hold ? 'pending_approval' : o.ab ? 'testing' : 'sending', total, options: JSON.stringify(o), created_at: now(), started_at: now(),
    status_reason: hold ? 'Waiting for a one-time review of your first large campaign' : null,
  });
  if (hold) await requestApproval(env, pub, { id: sendId, subject, total, post_id: post.id });
  else await enqueue(env, 'send.batch', { send_id: sendId });
  return sendId;
}

/** Deliveries left in 'queued' by an error mid-send go to the deferred-retry path (re-render + resend, 26h window). */
async function requeueStuck(env: Env, sendId: string) {
  await run(env, `UPDATE deliveries SET status = 'deferred', next_attempt_at = ?, error = COALESCE(error, 'retry after a temporary error') WHERE send_id = ? AND status = 'queued' AND COALESCE(next_attempt_at, created_at) < ?`, now() + 5 * MIN, sendId, now() - 30_000).catch(() => {});
}

registerJob('send.batch', async (env, p) => {
  const send = await one<any>(env, 'SELECT * FROM sends WHERE id = ?', p.send_id);
  if (!send || !['sending', 'testing'].includes(send.status)) return;
  const pub = (await getPub(env, send.pub_id))!;
  const post = send.post_id ? await one<Post>(env, 'SELECT * FROM posts WHERE id = ?', send.post_id) : null;
  if (!post) { await run(env, `UPDATE sends SET status = 'failed' WHERE id = ?`, send.id); return; }
  const o: SendOptions = parseJSON(send.options, {});
  // account suspended (pending review) → pause what's in flight
  const suspended = await workspaceSuspended(env, pub.workspace_id);
  if (suspended) { await run(env, `UPDATE sends SET status = 'paused', status_reason = ? WHERE id = ? AND status IN ('sending','testing')`, suspended, send.id); return; }
  // Timed sends (send-time optimization / time zones): first park every recipient as a 'scheduled' delivery — nothing
  // leaves yet, so no warm-up/ramp allowance is used. The A/B test phase always goes out immediately.
  const timed = !!o.timing && o.phase !== 'test';
  if (timed && !o.timing!.planned) { await planTimed(env, pub, send, o); return; }
  const from = await senderFor(env, pub, 'newsletter', post.sender_id);
  const warm = await warmupAllowance(env, from.email);
  if (!warm.ok) {
    await logError(env, 'send.warmup', new Error(warm.reason), pub.id);
    return { retryInMs: HOUR };
  }
  // new accounts: small daily cap for their first days — throttle (resumes as the rolling 24h window frees up)
  const ramp = await rampRemaining(env, pub.workspace_id);
  if (ramp.remaining <= 0) {
    await run(env, 'UPDATE sends SET status_reason = ? WHERE id = ?', ramp.reason ?? null, send.id);
    return { retryInMs: HOUR };
  }
  if (send.status_reason) await run(env, 'UPDATE sends SET status_reason = NULL WHERE id = ?', send.id);
  const cfg = settings(pub);
  const rate = Math.max(BATCH, Number(cfg.send_rate_per_minute) || Number((env as any).SEND_RATE_PER_MINUTE) || DEFAULT_RATE);
  const limit = Math.min(BATCH, warm.remaining === Infinity ? BATCH : warm.remaining, ramp.remaining);
  const main = await postContent(env, post);
  const base = { content: main, alt: altContent(post, main), from };
  if (timed) { await deliverDue(env, pub, post, send, o, base, limit, rate); return; }

  let recipients: Subscriber[];
  if (o.only_subscriber_ids) {
    recipients = await all<Subscriber>(env, `SELECT * FROM subscribers WHERE pub_id = ? AND id IN (${o.only_subscriber_ids.map(() => '?').join(',')}) AND status = 'active' ${send.cursor ? 'AND id > ?' : ''} ORDER BY id LIMIT ?`, pub.id, ...o.only_subscriber_ids, ...(send.cursor ? [send.cursor] : []), limit);
  } else {
    const c = await compile(env, pub.id, await audienceGroup(env, pub.id, o));
    recipients = await all<Subscriber>(env, `SELECT s.* FROM subscribers s WHERE s.pub_id = ? AND s.status = 'active' AND (${c.sql}) ${send.cursor ? 'AND s.id > ?' : ''} AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.send_id = ? AND d.subscriber_id = s.id) ORDER BY s.id LIMIT ?`, pub.id, ...c.params, ...(send.cursor ? [send.cursor] : []), send.id, limit * 3);
  }

  let processed = 0;
  let last = send.cursor as string | null;
  const queue: Array<{ sub: Subscriber; subject: string; variant: string | null; cohort: string | null; letter: string | null }> = [];
  const held = await (await import('./holdout')).holdoutSet(env, send, recipients); // holdout group: deliberately not sent (lib/holdout)
  for (const sub of recipients) {
    last = sub.id;
    if (held.has(sub.id)) continue;
    // A/B: test phase only takes the sample; main phase takes the rest
    const pick = await assignVariant(send.id, sub.id, o, o.subject || post.email_subject || post.title);
    if (!pick) continue;
    queue.push({ sub, ...pick });
    processed++;
    if (processed >= limit) break;
  }
  for (let i = 0; i < queue.length; i += PARALLEL) {
    const res = await Promise.allSettled(queue.slice(i, i + PARALLEL).map((q) => {
      const v = variantParts(o, q.letter, base);
      return deliver(env, pub, send.id, q.sub, q.subject, v.content, v.from, { variant: q.variant, cohort: q.cohort, post });
    }));
    for (let k = 0; k < res.length; k++) {
      const r = res[k];
      if (r.status !== 'rejected') continue;
      await logError(env, 'send.deliver', r.reason, pub.id);
      // A transient database error must not silently skip this reader: the cursor has already moved past them.
      // If no delivery row was written, try once more now; a row left half-done is picked up by the retry job below.
      const q = queue[i + k];
      const has = await one<{ id: string }>(env, 'SELECT id FROM deliveries WHERE send_id = ? AND subscriber_id = ?', send.id, q.sub.id).catch(() => null);
      if (!has) {
        await new Promise((ok) => setTimeout(ok, 250));
        const v = variantParts(o, q.letter, base);
        await deliver(env, pub, send.id, q.sub, q.subject, v.content, v.from, { variant: q.variant, cohort: q.cohort, post }).catch((e) => logError(env, 'send.deliver.retry', e, pub.id));
      }
    }
  }
  await requeueStuck(env, send.id);
  const exhausted = processed < limit && (recipients.length < limit * 3 || o.only_subscriber_ids);
  await run(env, 'UPDATE sends SET cursor = ?, sent = (SELECT COUNT(*) FROM deliveries WHERE send_id = ? AND status IN (\'sent\',\'deferred\')), failed = (SELECT COUNT(*) FROM deliveries WHERE send_id = ? AND status IN (\'failed\',\'bounced\',\'suppressed\')) WHERE id = ?', last, send.id, send.id, send.id);
  // campaign safety: hard bounces / complaints above the limits pause the send and alert the owner
  if (await checkCampaign(env, send)) return;
  if (!exhausted && recipients.length) {
    await enqueue(env, 'send.batch', { send_id: send.id }, now() + Math.floor((60_000 * BATCH) / rate));
    return;
  }
  if (o.phase === 'test' && o.ab) {
    await run(env, 'UPDATE sends SET cursor = NULL WHERE id = ?', send.id);
    await enqueue(env, 'send.ab_winner', { send_id: send.id }, now() + (o.ab.wait_minutes || 60) * MIN);
    return;
  }
  await finishSend(env, pub, post, send.id);
});

/**
 * Which variant (A/B letter) and cohort a recipient gets in this phase, or null when they belong to the other phase
 * (test phase = the sample, split across the variants; main phase = everyone else, who get the winner).
 */
async function assignVariant(sendId: string, subId: string, o: SendOptions, defaultSubject: string): Promise<{ subject: string; variant: string | null; cohort: string | null; letter: string | null } | null> {
  let variant: string | null = null;
  let letter: string | null = null;
  let subject = defaultSubject;
  if (o.ab) {
    const b = await bucket(sendId + subId);
    const inSample = b < o.ab.sample_pct;
    if (o.phase === 'test' && !inSample) return null;
    if (o.phase === 'main' && inSample) return null;
    if (o.phase === 'test') letter = String.fromCharCode(65 + (Math.floor((b / o.ab.sample_pct) * o.ab.subjects.length) % o.ab.subjects.length));
    else letter = o.winner || 'A';
    variant = letter;
    subject = o.ab.subjects[letter.charCodeAt(0) - 65] || subject;
  }
  let cohort: string | null = null;
  if (o.cohorts?.length) {
    const b = await bucket('cohort:' + sendId + subId);
    let acc = 0;
    for (const ch of o.cohorts) { acc += ch.pct; if (b < acc) { cohort = ch.name; break; } }
    cohort = cohort || o.cohorts[o.cohorts.length - 1].name;
    variant = variant ? `${variant}/${cohort}` : cohort;
  }
  return { subject, variant, cohort, letter };
}

/** Timed send, phase 1: give every remaining recipient a planned time (a delivery row with status 'scheduled'). */
async function planTimed(env: Env, pub: Publication, send: any, o: SendOptions) {
  const PLAN = 300;
  let recipients: Subscriber[];
  if (o.only_subscriber_ids) {
    recipients = await all<Subscriber>(env, `SELECT s.* FROM subscribers s WHERE s.pub_id = ? AND s.id IN (${o.only_subscriber_ids.map(() => '?').join(',')}) AND s.status = 'active' ${send.cursor ? 'AND s.id > ?' : ''} AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.send_id = ? AND d.subscriber_id = s.id) ORDER BY s.id LIMIT ?`, pub.id, ...o.only_subscriber_ids, ...(send.cursor ? [send.cursor] : []), send.id, PLAN);
  } else {
    const c = await compile(env, pub.id, await audienceGroup(env, pub.id, o));
    recipients = await all<Subscriber>(env, `SELECT s.* FROM subscribers s WHERE s.pub_id = ? AND s.status = 'active' AND (${c.sql}) ${send.cursor ? 'AND s.id > ?' : ''} AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.send_id = ? AND d.subscriber_id = s.id) ORDER BY s.id LIMIT ?`, pub.id, ...c.params, ...(send.cursor ? [send.cursor] : []), send.id, PLAN);
  }
  // every recipient of one send is planned inside the same 24h window, starting when the timed phase began
  const from = Number(o.timing?.from) || now();
  const picks: Array<{ sub: Subscriber; variant: string | null }> = [];
  const held = await (await import('./holdout')).holdoutSet(env, send, recipients);
  for (const sub of recipients) {
    if (held.has(sub.id)) continue;
    const pick = await assignVariant(send.id, sub.id, o, '');
    if (pick) picks.push({ sub, variant: pick.variant });
  }
  const times = await planTimes(env, pub, picks.map((x) => x.sub), o.timing!, from);
  const t = now();
  const stmts = picks.map(({ sub, variant }) => stmt(env, `INSERT INTO deliveries (id, send_id, pub_id, subscriber_id, email, variant, status, attempts, next_attempt_at, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', 0, ?, ?, ?)`,
    id(20), send.id, pub.id, sub.id, sub.email, variant, Math.min(Math.max(times.get(sub.id) ?? from, from), from + DAY), mailboxProvider(sub.email), t));
  for (let i = 0; i < stmts.length; i += 50) await batch(env, stmts.slice(i, i + 50));
  if (recipients.length === PLAN) {
    await run(env, 'UPDATE sends SET cursor = ?, options = ? WHERE id = ?', recipients[recipients.length - 1].id, JSON.stringify({ ...o, timing: { ...o.timing, from } }), send.id);
    await enqueue(env, 'send.batch', { send_id: send.id });
    return;
  }
  o.timing = { ...o.timing!, from, planned: true };
  const first = await one<{ t: number | null }>(env, `SELECT MIN(next_attempt_at) AS t FROM deliveries WHERE send_id = ? AND status = 'scheduled'`, send.id);
  await run(env, 'UPDATE sends SET options = ?, cursor = NULL WHERE id = ?', JSON.stringify(o), send.id);
  await enqueue(env, 'send.batch', { send_id: send.id }, Math.max(now(), first?.t || now()));
}

/** Timed send, phase 2: deliver the scheduled deliveries that are due — through the same warm-up / ramp / safety gates as any batch. */
async function deliverDue(env: Env, pub: Publication, post: Post, send: any, o: SendOptions, base: { content: Content; alt: Content | null; from: { email: string; name: string } }, limit: number, rate: number) {
  const due = await all<any>(env, `SELECT id, subscriber_id, variant FROM deliveries WHERE send_id = ? AND status = 'scheduled' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?`, send.id, now(), limit);
  const subs = due.length ? await all<Subscriber>(env, `SELECT * FROM subscribers WHERE id IN (${due.map(() => '?').join(',')})`, ...due.map((d) => d.subscriber_id)) : [];
  const byId = new Map(subs.map((s) => [s.id, s]));
  const defaultSubject = o.subject || post.email_subject || post.title;
  const work: Array<() => Promise<unknown>> = [];
  for (const d of due) {
    // claim it, so overlapping batch jobs never send the same email twice
    const claimed = await run(env, `UPDATE deliveries SET status = 'queued', next_attempt_at = ? WHERE id = ? AND status = 'scheduled'`, now(), d.id); // claim time, so stuck-row recovery never grabs an in-flight send
    if (!claimed.meta.changes) continue;
    const sub = byId.get(d.subscriber_id);
    if (!sub || sub.status !== 'active') { await run(env, `UPDATE deliveries SET status = 'skipped', error = 'subscriber no longer active' WHERE id = ?`, d.id); continue; }
    const letter = o.ab && d.variant && /^[A-E](\/|$)/.test(d.variant) ? d.variant[0] : null;
    const cohort = d.variant ? (d.variant.includes('/') ? d.variant.split('/')[1] : letter ? null : d.variant) : null;
    const v = variantParts(o, letter, base);
    work.push(() => sendExisting(env, pub, send.id, d.id, sub, v.subject || defaultSubject, v.content, v.from, { cohort, post }));
  }
  for (let i = 0; i < work.length; i += PARALLEL) {
    const res = await Promise.allSettled(work.slice(i, i + PARALLEL).map((f) => f()));
    for (const r of res) if (r.status === 'rejected') await logError(env, 'send.deliver', r.reason, pub.id);
  }
  await requeueStuck(env, send.id);
  await run(env, 'UPDATE sends SET sent = (SELECT COUNT(*) FROM deliveries WHERE send_id = ? AND status IN (\'sent\',\'deferred\')), failed = (SELECT COUNT(*) FROM deliveries WHERE send_id = ? AND status IN (\'failed\',\'bounced\',\'suppressed\')) WHERE id = ?', send.id, send.id, send.id);
  if (await checkCampaign(env, send)) return;
  const rest = await one<{ n: number; t: number | null }>(env, `SELECT COUNT(*) AS n, MIN(next_attempt_at) AS t FROM deliveries WHERE send_id = ? AND status = 'scheduled'`, send.id);
  if (!rest?.n) { await finishSend(env, pub, post, send.id); return; }
  const pace = now() + Math.floor((60_000 * BATCH) / rate);
  await enqueue(env, 'send.batch', { send_id: send.id }, due.length >= limit ? pace : Math.max(pace, rest.t || pace));
}

registerJob('send.ab_winner', async (env, p) => {
  const send = await one<any>(env, 'SELECT * FROM sends WHERE id = ?', p.send_id);
  if (!send || send.status !== 'testing') return;
  const o: SendOptions = parseJSON(send.options, {});
  const rows = await all<any>(env, `SELECT substr(variant,1,1) AS v, COUNT(*) AS n, SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) AS op, SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS cl FROM deliveries WHERE send_id = ? GROUP BY substr(variant,1,1)`, send.id);
  let best = 'A', bestRate = -1;
  for (const r of rows) {
    const rate = (o.ab?.metric === 'clicks' ? r.cl : r.op) / Math.max(1, r.n);
    if (rate > bestRate) { bestRate = rate; best = r.v; }
  }
  o.winner = best;
  o.ab_decided_at = now(); // analytics: deliveries up to here are the test sample
  o.phase = 'main';
  await run(env, `UPDATE sends SET status = 'sending', options = ?, cursor = NULL WHERE id = ?`, JSON.stringify(o), send.id);
  if (send.post_id) {
    const post = await one<any>(env, 'SELECT ab_test FROM posts WHERE id = ?', send.post_id);
    const ab = parseJSON<any>(post?.ab_test, {});
    ab.winner = best;
    await run(env, 'UPDATE posts SET ab_test = ? WHERE id = ?', JSON.stringify(ab), send.post_id);
  }
  await enqueue(env, 'send.batch', { send_id: send.id });
});

async function finishSend(env: Env, pub: Publication, post: Post, sendId: string) {
  await run(env, `UPDATE sends SET status = 'sent', completed_at = ?, sent = (SELECT COUNT(*) FROM deliveries WHERE send_id = ? AND status IN ('sent','deferred')), failed = (SELECT COUNT(*) FROM deliveries WHERE send_id = ? AND status IN ('failed','bounced','suppressed')) WHERE id = ?`, now(), sendId, sendId, sendId);
  const s = await one<any>(env, 'SELECT total, sent, failed FROM sends WHERE id = ?', sendId);
  await emit(env, { pubId: pub.id, type: 'post.sent', refId: post.id, data: { post_id: post.id, send_id: sendId, title: post.title, recipients: s?.sent ?? 0 }, activity: false });
}

/** Create a delivery and send it. Used by newsletters, automations and test sends. */
export async function deliver(env: Env, pub: Publication, sendId: string, sub: Subscriber, subject: string, content: Content, from: { email: string; name: string }, o: { variant?: string | null; cohort?: string | null; post?: Post | null; kind?: 'marketing' | 'transactional'; forceReal?: boolean } = {}) {
  const did = id(20);
  await insert(env, 'deliveries', { id: did, send_id: sendId, pub_id: pub.id, subscriber_id: sub.id, email: sub.email, variant: o.variant ?? null, status: 'queued', attempts: 0, provider: mailboxProvider(sub.email), created_at: now() });
  return sendExisting(env, pub, sendId, did, sub, subject, content, from, o);
}

/** Render + send for a delivery row that already exists (fresh deliveries, and timed sends' 'scheduled' rows). */
export async function sendExisting(env: Env, pub: Publication, sendId: string, did: string, sub: Subscriber, subject: string, content: Content, from: { email: string; name: string }, o: { cohort?: string | null; post?: Post | null; kind?: 'marketing' | 'transactional'; forceReal?: boolean } = {}) {
  const built = await buildEmail(env, pub, content, sub, { deliveryId: did, post: o.post, cohort: o.cohort });
  const subj = applyMerge(subject, mergeVars(pub, sub, siteUrl(env, pub)), false);
  const res = await sendMail(env, { to: sub.email, subject: subj, html: built.html, text: built.text, from, replyTo: await replyToFor(env, pub), pub, kind: o.kind || 'marketing', unsubscribeUrl: built.unsubscribeUrl, campaignId: sendId, forceReal: o.forceReal });
  await applyResult(env, pub, did, sub, res);
  return { deliveryId: did, result: res };
}

async function applyResult(env: Env, pub: Publication, did: string, sub: Subscriber, res: Awaited<ReturnType<typeof sendMail>>) {
  if (res.ok) {
    await run(env, `UPDATE deliveries SET status = 'sent', attempts = attempts + 1, message_id = ?, sent_at = ?, error = NULL WHERE id = ?`, res.messageId ?? null, now(), did);
    await run(env, 'UPDATE subscribers SET received_count = received_count + 1 WHERE id = ?', sub.id);
  } else if (res.status === 'suppressed') {
    await run(env, `UPDATE deliveries SET status = 'suppressed', error = ? WHERE id = ?`, res.error ?? null, did);
  } else if (res.retry) {
    // deferred: retry with backoff for up to 26 hours before calling it a bounce
    const d = await one<any>(env, 'SELECT attempts, created_at FROM deliveries WHERE id = ?', did);
    const attempts = (d?.attempts || 0) + 1;
    const giveUp = now() - (d?.created_at || now()) > 26 * HOUR;
    if (giveUp) {
      await run(env, `UPDATE deliveries SET status = 'bounced', bounce_type = ?, attempts = ?, error = ? WHERE id = ?`, res.bounce ?? 'soft', attempts, res.error ?? null, did);
      await recordBounce(env, sub.email, pub.id, res.bounce ?? 'soft', res.error || '');
    } else {
      const delay = Math.min(15 * MIN * 2 ** (attempts - 1), 6 * HOUR);
      await run(env, `UPDATE deliveries SET status = 'deferred', bounce_type = ?, attempts = ?, next_attempt_at = ?, error = ? WHERE id = ?`, res.bounce ?? 'soft', attempts, now() + delay, res.error ?? null, did);
    }
  } else {
    const type = res.bounce || 'hard';
    await run(env, `UPDATE deliveries SET status = ?, bounce_type = ?, attempts = attempts + 1, error = ? WHERE id = ?`, res.bounce ? 'bounced' : 'failed', res.bounce ?? null, res.error ?? null, did);
    if (res.bounce) await recordBounce(env, sub.email, pub.id, type, res.error || '');
  }
}

/** Retry deferred deliveries (re-render + resend). */
registerPeriodic('deliveries.retry', 5 * MIN, async (env) => {
  // Anything still 'queued' two minutes after it was created was interrupted mid-send: hand it to the retry path.
  await run(env, `UPDATE deliveries SET status = 'deferred', next_attempt_at = ?, error = COALESCE(error, 'retry after a temporary error') WHERE status = 'queued' AND COALESCE(next_attempt_at, created_at) < ?`, now(), now() - 2 * MIN).catch(() => {});
  const due = await all<any>(env, `SELECT d.*, se.post_id, se.subject AS send_subject, se.automation_id, se.step_id FROM deliveries d JOIN sends se ON se.id = d.send_id WHERE d.status = 'deferred' AND d.next_attempt_at <= ? LIMIT 100`, now());
  for (const d of due) {
    const pub = await getPub(env, d.pub_id);
    const sub = await one<Subscriber>(env, 'SELECT * FROM subscribers WHERE id = ?', d.subscriber_id);
    if (!pub || !sub || sub.status !== 'active') { await run(env, `UPDATE deliveries SET status = 'failed', error = 'subscriber inactive' WHERE id = ?`, d.id); continue; }
    const post = d.post_id ? await one<Post>(env, 'SELECT * FROM posts WHERE id = ?', d.post_id) : null;
    if (!post && d.automation_id && d.step_id) {
      // automation email: re-render from the live step config
      const a = await one<{ steps: string }>(env, 'SELECT steps FROM automations WHERE id = ?', d.automation_id);
      let step: any = null;
      const find = (list: any[]): void => { for (const s of list || []) { if (s.id === d.step_id) step = s; find(s.yes); find(s.no); } };
      find(parseJSON<any[]>(a?.steps, []));
      if (!step) { await run(env, `UPDATE deliveries SET status = 'failed', error = 'content missing' WHERE id = ?`, d.id); continue; }
      const c = step.config || {};
      const content: Content = { title: c.title || '', subtitle: c.subtitle || '', doc: c.doc || { blocks: [] }, preview_text: c.preview_text || '', style: c.style ? JSON.stringify(c.style) : null, hideHeader: !c.title };
      const built = await buildEmail(env, pub, content, sub, { deliveryId: d.id });
      const from = await senderFor(env, pub, 'automations', c.sender_id);
      const res = await sendMail(env, { to: sub.email, subject: d.send_subject, html: built.html, text: built.text, from, replyTo: await replyToFor(env, pub), pub, unsubscribeUrl: built.unsubscribeUrl, campaignId: d.send_id });
      await applyResult(env, pub, d.id, sub, res);
      continue;
    }
    if (!post) { await run(env, `UPDATE deliveries SET status = 'failed', error = 'content missing' WHERE id = ?`, d.id); continue; }
    const main = await postContent(env, post);
    // A/B / multivariate: retry with the same variant (subject, preview text, sender name, content) the recipient was given
    const so: SendOptions = parseJSON((await one<{ options: string }>(env, 'SELECT options FROM sends WHERE id = ?', d.send_id))?.options, {});
    const letter = so.ab && d.variant && /^[A-E](\/|$)/.test(d.variant) ? d.variant[0] : null;
    const v = variantParts(so, letter, { content: main, alt: altContent(post, main), from: await senderFor(env, pub, 'newsletter', post.sender_id) });
    const built = await buildEmail(env, pub, v.content, sub, { deliveryId: d.id, post });
    const from = v.from;
    const subject = v.subject ? applyMerge(v.subject, mergeVars(pub, sub, siteUrl(env, pub)), false) : d.send_subject;
    const res = await sendMail(env, { to: sub.email, subject, html: built.html, text: built.text, from, replyTo: await replyToFor(env, pub), pub, unsubscribeUrl: built.unsubscribeUrl, campaignId: d.send_id });
    await applyResult(env, pub, d.id, sub, res);
  }
});

/** Publish scheduled posts whose time has come. */
registerPeriodic('posts.scheduled', MIN - 5000, async (env) => {
  const due = await all<Post>(env, `SELECT * FROM posts WHERE status = 'scheduled' AND scheduled_at <= ? LIMIT 20`, now());
  for (const post of due) {
    const pub = await getPub(env, post.pub_id);
    if (!pub) continue;
    try {
      await publishPost(env, pub, post);
    } catch (e) {
      if (!(e instanceof SendBlockedError)) throw e;
      // over a plan limit: back to draft (so it doesn't retry every minute) and tell the owner
      await run(env, `UPDATE posts SET status = 'draft', scheduled_at = NULL, updated_at = ? WHERE id = ? AND status = 'scheduled'`, now(), post.id);
      await notifyBlocked(env, pub, post, e);
    }
  }
});

/** Tell the workspace owner an automatic send (scheduled post, RSS-to-send) was blocked by a plan limit. */
export async function notifyBlocked(env: Env, pub: Publication, post: Pick<Post, 'id' | 'title'>, e: SendBlockedError) {
  const ws = await getWorkspace(env, pub.workspace_id);
  const owner = ws ? await ownerOf(env, ws) : null;
  if (!owner) return;
  const { sendTransactional, button } = await import('./email');
  await sendTransactional(env, owner.email, `"${post.title}" wasn't sent`, `<p>Your post <strong>${esc(post.title)}</strong> (${esc(pub.name)}) wasn't sent automatically:</p><p>${esc(e.message)}</p><p>It's saved as a draft — send it again once you've upgraded.</p>${button('Upgrade your plan', e.upgradeUrl)}`);
}

/** Publish now: marks published (web) and starts the email send when platform includes email. */
export async function publishPost(env: Env, pub: Publication, post: Post): Promise<string | null> {
  const t = now();
  // Plan limits are checked before the post is published, so a blocked send leaves the post as it was.
  // Throws SendBlockedError (callers show the reason + upgrade link).
  if (post.platform !== 'web') await assertCanSend(env, pub, await countPostRecipients(env, pub, post));
  const claimed = await run(env, `UPDATE posts SET status = 'published', published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ? AND status IN ('draft','scheduled')`, t, t, post.id);
  if (!claimed.meta.changes) return null;
  let sendId: string | null = null;
  if (post.platform !== 'web') {
    try {
      sendId = await startSend(env, pub, { ...post, status: 'published' });
    } catch (e) {
      // lost a race with another send for the last of the allowance: undo the publish
      await run(env, `UPDATE posts SET status = ?, published_at = ?, updated_at = ? WHERE id = ?`, post.status, post.published_at, now(), post.id);
      throw e;
    }
  }
  await emit(env, { pubId: pub.id, type: 'post.published', refId: post.id, data: { post_id: post.id, title: post.title, slug: post.slug }, activity: false });
  return sendId;
}

/** Send a test email of a post to an arbitrary address (merge tags with a simulated subscriber). */
export async function sendTest(env: Env, pub: Publication, post: Post, to: string, simulated?: Partial<Subscriber>) {
  const content = await postContent(env, post);
  const fake = simulated ? ({ id: 'preview', pub_id: pub.id, email: to, name: '', tier: 'free', referral_code: 'preview', referral_count: 0, custom: '{}', created_at: now(), ...simulated } as Subscriber) : null;
  const built = await buildEmail(env, pub, content, fake, { post, access: fake ? fake.tier === 'premium' : true });
  const from = await senderFor(env, pub, 'newsletter', post.sender_id);
  return sendMail(env, { to, subject: '[Test] ' + applyMerge(post.email_subject || post.title, mergeVars(pub, fake, siteUrl(env, pub)), false), html: built.html, text: built.text, from, pub, kind: 'transactional' });
}

export { classifyBounce };
