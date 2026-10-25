// Newsletter sending engine.
// - startSend(): snapshot targeting, create `sends` row, queue batches
// - batches personalize per recipient (merge tags, dynamic content, premium access, cohorts)
// - A/B subject tests: sample phase → winner by opens/clicks → remainder
// - warmup caps per sending domain, blocklist pause, deferred retries for 26h, tracking pixel + click wrapping
import type { Env, Publication, Post, Subscriber } from '../types';
import { one, all, run, insert, val } from './db';
import { emit } from './events';
import { registerJob, registerPeriodic, enqueue, logError } from './jobs';
import { renderDoc, emailLayout, parseDoc, styleFor, applyMerge, mergeVars, type Doc, type StyleTokens } from './render';
import { sendMail, recordBounce, classifyBounce } from './email';
import { compile, recalcSegment, segmentIdsFor, type RuleGroup } from './segments';
import { settings, siteUrl, senderFor, getPub } from './pub';
import { subToken, unsubscribeUrl, preferencesUrl, getTags } from './subscribers';
import { id, now, sha256, parseJSON, mailboxProvider, domainOf, HOUR, DAY, MIN, fmtDate } from './util';

export interface SendOptions {
  segment_ids?: string[];
  exclude_segment_ids?: string[];
  list_id?: string | null;
  audience?: 'all' | 'free' | 'premium';
  tier_ids?: string[];
  ab?: { subjects: string[]; sample_pct: number; wait_minutes: number; metric: 'opens' | 'clicks' } | null;
  cohorts?: Array<{ name: string; pct: number }> | null;
  phase?: 'test' | 'main';
  winner?: string | null;
  only_subscriber_ids?: string[];
  /** override subject line for this send (e.g. resend to non-openers) */
  subject?: string | null;
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
  const tpl = post.template_id ? await one<{ style: string }>(env, 'SELECT style FROM templates WHERE id = ?', post.template_id) : null;
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
  let html = emailLayout(r.html, {
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
/** Daily cap for a sending domain under warmup: 200 → doubles daily → unlimited after day 12. */
export async function warmupAllowance(env: Env, fromEmail: string): Promise<{ ok: boolean; reason?: string; remaining: number }> {
  const dom = await one<any>(env, `SELECT * FROM domains WHERE hostname = ? AND kind = 'email'`, domainOf(fromEmail));
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
    ab: parseJSON(post.ab_test, null), cohorts: parseJSON<any>(post.cohort_test, null)?.cohorts || null, ...overrides,
  };
  if (o.ab && (!o.ab.subjects || o.ab.subjects.filter(Boolean).length < 2)) o.ab = null;
  // refresh dynamic segment caches used for targeting/dynamic content
  const segIds = new Set<string>([...(o.segment_ids || []), ...(o.exclude_segment_ids || [])]);
  JSON.stringify(parseDoc(post.content)).replace(/"segment_ids":\[([^\]]*)\]/g, (_m, ids: string) => { ids.replace(/"([^"]+)"/g, (_x, sid: string) => (segIds.add(sid), '')); return ''; });
  for (const sid of segIds) await recalcSegment(env, pub.id, sid);
  const total = o.only_subscriber_ids ? o.only_subscriber_ids.length : await countRecipients(env, pub.id, o);
  o.phase = o.ab ? 'test' : 'main';
  const sendId = id();
  await insert(env, 'sends', { id: sendId, pub_id: pub.id, post_id: post.id, kind: 'post', subject: o.subject || post.email_subject || post.title, status: o.ab ? 'testing' : 'sending', total, options: JSON.stringify(o), created_at: now(), started_at: now() });
  await enqueue(env, 'send.batch', { send_id: sendId });
  return sendId;
}

registerJob('send.batch', async (env, p) => {
  const send = await one<any>(env, 'SELECT * FROM sends WHERE id = ?', p.send_id);
  if (!send || !['sending', 'testing'].includes(send.status)) return;
  const pub = (await getPub(env, send.pub_id))!;
  const post = send.post_id ? await one<Post>(env, 'SELECT * FROM posts WHERE id = ?', send.post_id) : null;
  if (!post) { await run(env, `UPDATE sends SET status = 'failed' WHERE id = ?`, send.id); return; }
  const o: SendOptions = parseJSON(send.options, {});
  const from = await senderFor(env, pub, 'newsletter', post.sender_id);
  const warm = await warmupAllowance(env, from.email);
  if (!warm.ok) {
    await logError(env, 'send.warmup', new Error(warm.reason), pub.id);
    return { retryInMs: HOUR };
  }
  const cfg = settings(pub);
  const rate = Math.max(BATCH, Number(cfg.send_rate_per_minute) || Number((env as any).SEND_RATE_PER_MINUTE) || DEFAULT_RATE);
  const limit = Math.min(BATCH, warm.remaining === Infinity ? BATCH : warm.remaining);

  let recipients: Subscriber[];
  if (o.only_subscriber_ids) {
    recipients = await all<Subscriber>(env, `SELECT * FROM subscribers WHERE pub_id = ? AND id IN (${o.only_subscriber_ids.map(() => '?').join(',')}) AND status = 'active' ${send.cursor ? 'AND id > ?' : ''} ORDER BY id LIMIT ?`, pub.id, ...o.only_subscriber_ids, ...(send.cursor ? [send.cursor] : []), limit);
  } else {
    const c = await compile(env, pub.id, await audienceGroup(env, pub.id, o));
    recipients = await all<Subscriber>(env, `SELECT s.* FROM subscribers s WHERE s.pub_id = ? AND s.status = 'active' AND (${c.sql}) ${send.cursor ? 'AND s.id > ?' : ''} AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.send_id = ? AND d.subscriber_id = s.id) ORDER BY s.id LIMIT ?`, pub.id, ...c.params, ...(send.cursor ? [send.cursor] : []), send.id, limit * 3);
  }

  const content = await postContent(env, post);
  let processed = 0;
  let last = send.cursor as string | null;
  const queue: Array<{ sub: Subscriber; subject: string; variant: string | null; cohort: string | null }> = [];
  for (const sub of recipients) {
    last = sub.id;
    // A/B: test phase only takes the sample; main phase takes the rest
    let variant: string | null = null;
    let subject = o.subject || post.email_subject || post.title;
    if (o.ab) {
      const b = await bucket(send.id + sub.id);
      const inSample = b < o.ab.sample_pct;
      if (o.phase === 'test' && !inSample) continue;
      if (o.phase === 'main' && inSample) continue;
      if (o.phase === 'test') {
        const idx = Math.floor((b / o.ab.sample_pct) * o.ab.subjects.length) % o.ab.subjects.length;
        variant = String.fromCharCode(65 + idx);
        subject = o.ab.subjects[idx];
      } else {
        variant = o.winner || 'A';
        subject = o.ab.subjects[variant.charCodeAt(0) - 65] || subject;
      }
    }
    let cohort: string | null = null;
    if (o.cohorts?.length) {
      const b = await bucket('cohort:' + send.id + sub.id);
      let acc = 0;
      for (const ch of o.cohorts) { acc += ch.pct; if (b < acc) { cohort = ch.name; break; } }
      cohort = cohort || o.cohorts[o.cohorts.length - 1].name;
      variant = variant ? `${variant}/${cohort}` : cohort;
    }
    queue.push({ sub, subject, variant, cohort });
    processed++;
    if (processed >= limit) break;
  }
  for (let i = 0; i < queue.length; i += PARALLEL) {
    const res = await Promise.allSettled(queue.slice(i, i + PARALLEL).map((q) => deliver(env, pub, send.id, q.sub, q.subject, content, from, { variant: q.variant, cohort: q.cohort, post })));
    for (const r of res) if (r.status === 'rejected') await logError(env, 'send.deliver', r.reason, pub.id);
  }
  const exhausted = processed < limit && (recipients.length < limit * 3 || o.only_subscriber_ids);
  await run(env, 'UPDATE sends SET cursor = ?, sent = (SELECT COUNT(*) FROM deliveries WHERE send_id = ? AND status IN (\'sent\',\'deferred\')), failed = (SELECT COUNT(*) FROM deliveries WHERE send_id = ? AND status IN (\'failed\',\'bounced\',\'suppressed\')) WHERE id = ?', last, send.id, send.id, send.id);
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
export async function deliver(env: Env, pub: Publication, sendId: string, sub: Subscriber, subject: string, content: Content, from: { email: string; name: string }, o: { variant?: string | null; cohort?: string | null; post?: Post | null; kind?: 'marketing' | 'transactional' } = {}) {
  const did = id(20);
  await insert(env, 'deliveries', { id: did, send_id: sendId, pub_id: pub.id, subscriber_id: sub.id, email: sub.email, variant: o.variant ?? null, status: 'queued', attempts: 0, provider: mailboxProvider(sub.email), created_at: now() });
  const built = await buildEmail(env, pub, content, sub, { deliveryId: did, post: o.post, cohort: o.cohort });
  const subj = applyMerge(subject, mergeVars(pub, sub, siteUrl(env, pub)), false);
  const res = await sendMail(env, { to: sub.email, subject: subj, html: built.html, text: built.text, from, replyTo: pub.reply_to, pub, kind: o.kind || 'marketing', unsubscribeUrl: built.unsubscribeUrl, campaignId: sendId });
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
      const res = await sendMail(env, { to: sub.email, subject: d.send_subject, html: built.html, text: built.text, from, replyTo: pub.reply_to, pub, unsubscribeUrl: built.unsubscribeUrl, campaignId: d.send_id });
      await applyResult(env, pub, d.id, sub, res);
      continue;
    }
    if (!post) { await run(env, `UPDATE deliveries SET status = 'failed', error = 'content missing' WHERE id = ?`, d.id); continue; }
    const content = await postContent(env, post);
    const built = await buildEmail(env, pub, content, sub, { deliveryId: d.id, post });
    const from = await senderFor(env, pub, 'newsletter', post.sender_id);
    const res = await sendMail(env, { to: sub.email, subject: d.send_subject, html: built.html, text: built.text, from, replyTo: pub.reply_to, pub, unsubscribeUrl: built.unsubscribeUrl, campaignId: d.send_id });
    await applyResult(env, pub, d.id, sub, res);
  }
});

/** Publish scheduled posts whose time has come. */
registerPeriodic('posts.scheduled', MIN - 5000, async (env) => {
  const due = await all<Post>(env, `SELECT * FROM posts WHERE status = 'scheduled' AND scheduled_at <= ? LIMIT 20`, now());
  for (const post of due) {
    const pub = await getPub(env, post.pub_id);
    if (!pub) continue;
    await publishPost(env, pub, post);
  }
});

/** Publish now: marks published (web) and starts the email send when platform includes email. */
export async function publishPost(env: Env, pub: Publication, post: Post): Promise<string | null> {
  const t = now();
  const claimed = await run(env, `UPDATE posts SET status = 'published', published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ? AND status IN ('draft','scheduled')`, t, t, post.id);
  if (!claimed.meta.changes) return null;
  let sendId: string | null = null;
  if (post.platform !== 'web') sendId = await startSend(env, pub, { ...post, status: 'published' });
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
