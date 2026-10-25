// Subscriber lifecycle: create (validated), confirm, unsubscribe, tags, custom fields, lists, referrals, engagement.
import type { Env, Publication, Subscriber } from '../types';
import { one, all, run, insert, stmt, batch } from './db';
import { emit } from './events';
import { validateEmail } from './guard';
import { settings, siteUrl } from './pub';
import { sendTransactional, button, unsuppress } from './email';
import { id, now, token, sha256, parseJSON, DAY, esc } from './util';

export interface SubscribeInput {
  email: string;
  name?: string;
  source?: string;
  sourceDetail?: string | null;
  utm?: { source?: string; medium?: string; campaign?: string; term?: string; content?: string };
  referrer?: string | null;
  landingPath?: string | null;
  referralCode?: string | null;   // code of the subscriber who referred
  tags?: string[];
  custom?: Record<string, unknown>;
  listIds?: string[];
  country?: string | null;
  ip?: string | null;
  /** skip double opt-in (imports, API with send_welcome=false, already-verified readers) */
  skipConfirm?: boolean;
  /** validation strictness: 1st-party forms use strict (MX) */
  strict?: boolean;
  tier?: 'free' | 'premium';
  /** reactivate an unsubscribed subscriber (explicit resubscribe) */
  reactivate?: boolean;
  sendWelcome?: boolean;
}

export interface SubscribeResult { ok: boolean; subscriber?: Subscriber; created?: boolean; pending?: boolean; error?: string; suggestion?: string | null }

export async function getSubscriber(env: Env, pubId: string, idOrEmail: string): Promise<Subscriber | null> {
  return one<Subscriber>(env, 'SELECT * FROM subscribers WHERE pub_id = ? AND (id = ? OR email = ?)', pubId, idOrEmail, idOrEmail.toLowerCase());
}

export async function subscribe(env: Env, pub: Publication, input: SubscribeInput): Promise<SubscribeResult> {
  const cfg = settings(pub);
  const v = await validateEmail(input.email, { strict: input.strict, extraBlocked: cfg.blocked_domains });
  if (!v.ok) return { ok: false, error: v.reason, suggestion: v.suggestion };
  const email = v.email;
  const t = now();
  const existing = await one<Subscriber>(env, 'SELECT * FROM subscribers WHERE pub_id = ? AND email = ?', pub.id, email);
  if (existing) {
    const patch: string[] = [];
    const params: unknown[] = [];
    if (input.name && !existing.name) { patch.push('name = ?'); params.push(input.name.slice(0, 120)); }
    if (input.custom) { patch.push('custom = ?'); params.push(JSON.stringify({ ...parseJSON(existing.custom, {}), ...input.custom })); }
    let reactivated = false;
    if ((existing.status === 'unsubscribed' && input.reactivate) || (existing.status === 'pending' && input.skipConfirm)) {
      patch.push(`status = 'active'`, 'unsubscribed_at = NULL', 'confirmed_at = COALESCE(confirmed_at, ?)');
      params.push(t);
      reactivated = true;
      await unsuppress(env, email, 'pub', pub.id);
    }
    if (patch.length) await run(env, `UPDATE subscribers SET ${patch.join(', ')}, updated_at = ? WHERE id = ?`, ...params, t, existing.id);
    if (input.tags?.length) await addTags(env, pub.id, existing.id, input.tags);
    if (input.listIds?.length) await joinLists(env, pub.id, existing.id, input.listIds);
    const s = (await getSubscriber(env, pub.id, existing.id))!;
    if (reactivated) await emit(env, { pubId: pub.id, type: 'subscription.created', subscriberId: s.id, data: { reactivated: true, source: input.source } });
    return { ok: true, subscriber: s, created: false, pending: s.status === 'pending' };
  }

  // referral attribution
  let referredBy: string | null = null;
  if (input.referralCode) {
    const ref = await one<{ id: string; pub_id: string }>(env, 'SELECT id, pub_id FROM subscribers WHERE referral_code = ?', input.referralCode);
    if (ref && ref.pub_id === pub.id) referredBy = ref.id;
  }
  const needsConfirm = !!cfg.double_opt_in && !input.skipConfirm;
  const sid = id();
  const row = {
    id: sid, pub_id: pub.id, email, name: (input.name || '').slice(0, 120), status: needsConfirm ? 'pending' : 'active',
    tier: input.tier || 'free', source: input.source || 'website', source_detail: input.sourceDetail ?? null,
    utm_source: input.utm?.source ?? null, utm_medium: input.utm?.medium ?? null, utm_campaign: input.utm?.campaign ?? null,
    utm_term: input.utm?.term ?? null, utm_content: input.utm?.content ?? null,
    referrer_url: input.referrer?.slice(0, 500) ?? null, landing_path: input.landingPath?.slice(0, 300) ?? null,
    referral_code: id(10), referred_by: referredBy, custom: JSON.stringify(input.custom || {}),
    country: input.country ?? null, ip: input.ip ?? null, confirmed_at: needsConfirm ? null : t, created_at: t, updated_at: t,
  };
  try {
    await insert(env, 'subscribers', row);
  } catch (e: any) {
    if (/UNIQUE/i.test(String(e?.message))) return subscribe(env, pub, input); // race: retry as existing
    throw e;
  }
  if (input.tags?.length) await addTags(env, pub.id, sid, input.tags);
  // default list + chosen lists
  const lists = input.listIds?.length ? input.listIds : (await all<{ id: string }>(env, 'SELECT id FROM lists WHERE pub_id = ? AND is_default = 1', pub.id)).map((l) => l.id);
  if (lists.length) await joinLists(env, pub.id, sid, lists);
  const sub = (await getSubscriber(env, pub.id, sid))!;

  if (needsConfirm) {
    await sendConfirmation(env, pub, sub);
  } else {
    await afterConfirmed(env, pub, sub, input);
  }
  return { ok: true, subscriber: sub, created: true, pending: needsConfirm };
}

async function afterConfirmed(env: Env, pub: Publication, sub: Subscriber, input?: SubscribeInput) {
  if (sub.referred_by) await creditReferral(env, pub, sub.referred_by);
  await emit(env, { pubId: pub.id, type: 'subscription.created', subscriberId: sub.id, data: { source: sub.source, source_detail: sub.source_detail, utm_source: sub.utm_source } });
  if (input?.sendWelcome !== false) await emit(env, { pubId: pub.id, type: 'subscriber.welcome', subscriberId: sub.id, activity: false });
}

export async function sendConfirmation(env: Env, pub: Publication, sub: Subscriber) {
  const tok = token(24);
  await insert(env, 'auth_tokens', { id: await sha256(tok), kind: 'confirm', pub_id: pub.id, subscriber_id: sub.id, data: '{}', expires_at: now() + 7 * DAY, created_at: now() });
  const url = `${siteUrl(env, pub)}/confirm/${tok}`;
  await sendTransactional(env, sub.email, `Confirm your subscription to ${pub.name}`, `<p>Thanks for subscribing to <strong>${esc(pub.name)}</strong>! Please confirm your email address to start receiving it.</p>${button('Confirm subscription', url)}<p style="color:#6b7280;font-size:13px">If you didn't sign up, you can ignore this email.</p>`, pub);
}

/** Confirm a double opt-in token. Returns the subscriber on success. */
export async function confirmToken(env: Env, tok: string): Promise<{ sub: Subscriber; pub: Publication } | null> {
  const row = await one<any>(env, `SELECT * FROM auth_tokens WHERE id = ? AND kind = 'confirm'`, await sha256(tok));
  if (!row || row.expires_at < now()) return null;
  const pub = await one<Publication>(env, 'SELECT * FROM publications WHERE id = ?', row.pub_id);
  const sub = await one<Subscriber>(env, 'SELECT * FROM subscribers WHERE id = ?', row.subscriber_id);
  if (!pub || !sub) return null;
  if (sub.status === 'pending') {
    await run(env, `UPDATE subscribers SET status = 'active', confirmed_at = ?, updated_at = ? WHERE id = ?`, now(), now(), sub.id);
    await run(env, `UPDATE auth_tokens SET used_at = ? WHERE id = ?`, now(), row.id);
    const fresh = (await getSubscriber(env, pub.id, sub.id))!;
    await emit(env, { pubId: pub.id, type: 'subscription.confirmed', subscriberId: sub.id });
    await afterConfirmed(env, pub, fresh);
    return { sub: fresh, pub };
  }
  return { sub, pub };
}

export async function unsubscribe(env: Env, pubId: string, subscriberId: string, reason = 'user') {
  const sub = await one<Subscriber>(env, 'SELECT * FROM subscribers WHERE id = ? AND pub_id = ?', subscriberId, pubId);
  if (!sub || sub.status === 'unsubscribed') return;
  await run(env, `UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ?, unsubscribe_reason = ?, updated_at = ? WHERE id = ?`, now(), reason.slice(0, 200), now(), sub.id);
  await run(env, `UPDATE list_members SET status = 'unsubscribed' WHERE subscriber_id = ?`, sub.id);
  await run(env, `UPDATE automation_runs SET status = 'exited', updated_at = ? WHERE subscriber_id = ? AND status IN ('active','waiting')`, now(), sub.id);
  await emit(env, { pubId, type: 'subscription.deleted', subscriberId: sub.id, data: { reason } });
}

export async function deleteSubscriber(env: Env, pubId: string, subscriberId: string) {
  await emit(env, { pubId, type: 'subscription.deleted', subscriberId, data: { deleted: true }, activity: false });
  await run(env, 'DELETE FROM subscribers WHERE id = ? AND pub_id = ?', subscriberId, pubId);
}

export async function addTags(env: Env, pubId: string, subscriberId: string, tags: string[]) {
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase().slice(0, 60);
    if (!tag) continue;
    const r = await run(env, 'INSERT OR IGNORE INTO subscriber_tags (pub_id, subscriber_id, tag, created_at) VALUES (?, ?, ?, ?)', pubId, subscriberId, tag, now());
    if (r.meta.changes) await emit(env, { pubId, type: 'tag.added', subscriberId, data: { tag } });
  }
}

export async function removeTags(env: Env, pubId: string, subscriberId: string, tags: string[]) {
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    const r = await run(env, 'DELETE FROM subscriber_tags WHERE subscriber_id = ? AND tag = ?', subscriberId, tag);
    if (r.meta.changes) await emit(env, { pubId, type: 'tag.removed', subscriberId, data: { tag } });
  }
}

export async function getTags(env: Env, subscriberId: string): Promise<string[]> {
  return (await all<{ tag: string }>(env, 'SELECT tag FROM subscriber_tags WHERE subscriber_id = ? ORDER BY tag', subscriberId)).map((r) => r.tag);
}

export async function setFields(env: Env, pubId: string, subscriberId: string, fields: Record<string, unknown>) {
  const sub = await one<Subscriber>(env, 'SELECT custom FROM subscribers WHERE id = ? AND pub_id = ?', subscriberId, pubId);
  if (!sub) return;
  const merged = { ...parseJSON(sub.custom, {}), ...fields };
  for (const [k, v] of Object.entries(merged)) if (v === null || v === '') delete (merged as any)[k];
  await run(env, 'UPDATE subscribers SET custom = ?, updated_at = ? WHERE id = ?', JSON.stringify(merged), now(), subscriberId);
  await emit(env, { pubId, type: 'field.updated', subscriberId, data: { fields } });
}

export async function joinLists(env: Env, pubId: string, subscriberId: string, listIds: string[]) {
  for (const lid of listIds) {
    const ok = await one(env, 'SELECT id FROM lists WHERE id = ? AND pub_id = ?', lid, pubId);
    if (!ok) continue;
    const r = await run(env, `INSERT INTO list_members (list_id, subscriber_id, status, created_at) VALUES (?, ?, 'subscribed', ?) ON CONFLICT(list_id, subscriber_id) DO UPDATE SET status = 'subscribed'`, lid, subscriberId, now());
    if (r.meta.changes) await emit(env, { pubId, type: 'list.subscribed', subscriberId, refId: lid, data: { list_id: lid } });
  }
}

export async function leaveLists(env: Env, pubId: string, subscriberId: string, listIds: string[]) {
  for (const lid of listIds) {
    const r = await run(env, `UPDATE list_members SET status = 'unsubscribed' WHERE list_id = ? AND subscriber_id = ? AND status = 'subscribed'`, lid, subscriberId);
    if (r.meta.changes) await emit(env, { pubId, type: 'list.unsubscribed', subscriberId, refId: lid, data: { list_id: lid } });
  }
}

/** Increment the referrer's count and award any milestone rewards reached. */
export async function creditReferral(env: Env, pub: Publication, referrerId: string) {
  await run(env, 'UPDATE subscribers SET referral_count = referral_count + 1, updated_at = ? WHERE id = ?', now(), referrerId);
  const ref = await one<Subscriber>(env, 'SELECT * FROM subscribers WHERE id = ?', referrerId);
  if (!ref) return;
  const rewards = await all<any>(env, 'SELECT * FROM referral_rewards WHERE pub_id = ? AND milestone <= ? ORDER BY milestone', pub.id, ref.referral_count);
  for (const r of rewards) {
    const res = await run(env, 'INSERT OR IGNORE INTO referral_awards (id, reward_id, pub_id, subscriber_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)', id(), r.id, pub.id, ref.id, 'awarded', now());
    if (!res.meta.changes) continue;
    await emit(env, { pubId: pub.id, type: 'referral.milestone', subscriberId: ref.id, refId: r.id, data: { milestone: r.milestone, reward: r.name } });
    let detail = '';
    if (r.kind === 'promo') detail = `<p>Your code: <strong style="font-size:18px">${esc(r.payload)}</strong></p>`;
    else if (r.kind === 'digital' && r.payload) detail = button('Get your reward', r.payload);
    else if (r.kind === 'premium') {
      const days = parseInt(r.payload) || 30;
      await run(env, `UPDATE subscribers SET tier = 'premium', trial_ends_at = ? WHERE id = ?`, now() + days * DAY, ref.id);
      detail = `<p>We've upgraded you to premium for ${days} days.</p>`;
    } else if (r.kind === 'physical') detail = `<p>Reply to this email with your shipping address and we'll send it over.</p>`;
    await sendTransactional(env, ref.email, `You unlocked: ${r.name} 🎉`, `<p>You've referred <strong>${ref.referral_count}</strong> readers to ${esc(pub.name)} — thank you!</p><p>You earned <strong>${esc(r.name)}</strong>. ${esc(r.description || '')}</p>${detail}`, pub);
  }
}

/** Engagement score 0-100 from recent opens/clicks relative to received. */
export async function recomputeEngagement(env: Env, subscriberId: string) {
  const r = await one<any>(env, `SELECT COUNT(*) AS rec, SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) AS op, SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS cl FROM (SELECT opened_at, clicked_at FROM deliveries WHERE subscriber_id = ? AND status = 'sent' ORDER BY created_at DESC LIMIT 20)`, subscriberId);
  if (!r || !r.rec) return;
  const score = Math.round(Math.min(100, ((r.op || 0) / r.rec) * 60 + ((r.cl || 0) / r.rec) * 40 * 2));
  await run(env, 'UPDATE subscribers SET engagement = ? WHERE id = ?', score, subscriberId);
}

/** Signed per-subscriber token for unsubscribe/preferences links (no DB lookup needed). */
export async function subToken(env: Env, subscriberId: string): Promise<string> {
  const sig = (await sha256(`${subscriberId}:${env.APP_URL}:openhive-unsub`)).slice(0, 16);
  return `${subscriberId}.${sig}`;
}
export async function verifySubToken(env: Env, tok: string): Promise<string | null> {
  const [sid, sig] = (tok || '').split('.');
  if (!sid || !sig) return null;
  const expect = (await sha256(`${sid}:${env.APP_URL}:openhive-unsub`)).slice(0, 16);
  return expect === sig ? sid : null;
}

export function unsubscribeUrl(env: Env, tok: string) {
  return `${env.APP_URL.replace(/\/$/, '')}/u/${tok}`;
}
export function preferencesUrl(env: Env, tok: string) {
  return `${env.APP_URL.replace(/\/$/, '')}/pref/${tok}`;
}

export { stmt, batch };
