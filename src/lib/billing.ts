// Monetize core: order fulfillment, subscription lifecycle, Stripe tier sync, coaching slots, ad settlement, wallet.
import type { Env, Publication, Subscriber } from '../types';
import { one, all, run, insert, val } from './db';
import { emit } from './events';
import { onOrderPaid, stripeEnabled, stripePost } from './payments';
import { registerPeriodic } from './jobs';
import { subscribe } from './subscribers';
import { sendTransactional, button } from './email';
import { enroll } from './automations';
import { settings, siteUrl } from './pub';
import { id, now, DAY, HOUR, MIN, esc, money, parseJSON, fmtDate } from './util';

export const CURRENCIES = ['usd', 'eur', 'gbp', 'cad', 'aud', 'jpy', 'inr', 'brl', 'mxn', 'chf', 'sek', 'nzd', 'sgd'];

export function tierPrice(t: any, interval: 'month' | 'year'): number {
  return interval === 'year' ? t.annual_cents || t.monthly_cents * 12 : t.monthly_cents || Math.round((t.annual_cents || 0) / 12);
}

export function addInterval(from: number, interval: string, count = 1): number {
  const d = new Date(from);
  if (interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + count);
  else d.setUTCMonth(d.getUTCMonth() + count);
  return d.getTime();
}

/** Find or create the subscriber for an order email. */
export async function ensureSubscriber(env: Env, pub: Publication, email: string, name = '', source = 'website'): Promise<Subscriber | null> {
  const existing = await one<Subscriber>(env, 'SELECT * FROM subscribers WHERE pub_id = ? AND email = ?', pub.id, email.toLowerCase());
  if (existing) {
    if (existing.status !== 'active') await run(env, `UPDATE subscribers SET status = 'active', unsubscribed_at = NULL, updated_at = ? WHERE id = ? AND status IN ('pending','unsubscribed')`, now(), existing.id);
    return (await one<Subscriber>(env, 'SELECT * FROM subscribers WHERE id = ?', existing.id))!;
  }
  const r = await subscribe(env, pub, { email, name, source, skipConfirm: true, reactivate: true });
  return r.subscriber || null;
}

async function setPremium(env: Env, subscriberId: string, tierId: string | null, trialEndsAt: number | null = null) {
  await run(env, `UPDATE subscribers SET tier = 'premium', tier_id = ?, trial_ends_at = ?, updated_at = ? WHERE id = ?`, tierId, trialEndsAt, now(), subscriberId);
}

/** Recompute a subscriber's tier from their live subscriptions. */
export async function refreshAccess(env: Env, subscriberId: string) {
  const live = await one<any>(env, `SELECT * FROM subscriptions WHERE subscriber_id = ? AND status IN ('active','trialing','past_due') ORDER BY amount_cents DESC LIMIT 1`, subscriberId);
  if (live) await setPremium(env, subscriberId, live.tier_id, live.status === 'trialing' ? live.trial_ends_at : null);
  else await run(env, `UPDATE subscribers SET tier = 'free', tier_id = NULL, updated_at = ? WHERE id = ? AND (trial_ends_at IS NULL OR trial_ends_at < ?)`, now(), subscriberId, now());
}

// ───────── Stripe tier sync ─────────
export async function syncTierToStripe(env: Env, pub: Publication, tierId: string) {
  if (!stripeEnabled(env)) return;
  const t = await one<any>(env, 'SELECT * FROM tiers WHERE id = ?', tierId);
  if (!t) return;
  const acct = settings(pub).stripe_account_id || undefined;
  let productId = t.stripe_product_id;
  if (!productId) {
    const p = await stripePost(env, 'products', { name: `${pub.name} — ${t.name}`, description: (t.description || t.name).slice(0, 300), 'metadata[tier_id]': t.id }, acct);
    productId = p.id;
  } else {
    await stripePost(env, `products/${productId}`, { name: `${pub.name} — ${t.name}`, active: t.status === 'archived' ? 'false' : 'true' }, acct);
  }
  const patch: Record<string, string | null> = { stripe_product_id: productId };
  if (t.monthly_cents > 0) {
    const pr = await stripePost(env, 'prices', { product: productId, currency: t.currency, unit_amount: String(t.monthly_cents), 'recurring[interval]': 'month' }, acct);
    patch.stripe_price_monthly = pr.id;
  }
  if (t.annual_cents > 0) {
    const pr = await stripePost(env, 'prices', { product: productId, currency: t.currency, unit_amount: String(t.annual_cents), 'recurring[interval]': 'year' }, acct);
    patch.stripe_price_annual = pr.id;
  }
  await run(env, 'UPDATE tiers SET stripe_product_id = ?, stripe_price_monthly = COALESCE(?, stripe_price_monthly), stripe_price_annual = COALESCE(?, stripe_price_annual) WHERE id = ?', patch.stripe_product_id, patch.stripe_price_monthly ?? null, patch.stripe_price_annual ?? null, t.id);
}

// ───────── subscription actions ─────────
export async function pauseSubscription(env: Env, pub: Publication, subId: string) {
  const s = await one<any>(env, 'SELECT * FROM subscriptions WHERE id = ? AND pub_id = ?', subId, pub.id);
  if (!s || !['active', 'trialing', 'past_due'].includes(s.status)) return false;
  if (s.stripe_subscription_id && stripeEnabled(env)) await stripePost(env, `subscriptions/${s.stripe_subscription_id}`, { 'pause_collection[behavior]': 'void' }, settings(pub).stripe_account_id || undefined);
  await run(env, `UPDATE subscriptions SET status = 'paused', paused_at = ?, updated_at = ? WHERE id = ?`, now(), now(), s.id);
  await refreshAccess(env, s.subscriber_id);
  await emit(env, { pubId: pub.id, type: 'subscription.paused', subscriberId: s.subscriber_id, data: { subscription_id: s.id, tier_id: s.tier_id } });
  return true;
}

export async function resumeSubscription(env: Env, pub: Publication, subId: string) {
  const s = await one<any>(env, 'SELECT * FROM subscriptions WHERE id = ? AND pub_id = ?', subId, pub.id);
  if (!s || s.status !== 'paused') return false;
  if (s.stripe_subscription_id && stripeEnabled(env)) await stripePost(env, `subscriptions/${s.stripe_subscription_id}`, { pause_collection: '' }, settings(pub).stripe_account_id || undefined);
  // extend the period by the paused duration (paused time isn't billed)
  const pausedFor = s.paused_at ? now() - s.paused_at : 0;
  await run(env, `UPDATE subscriptions SET status = 'active', paused_at = NULL, current_period_end = COALESCE(current_period_end, ?) + ?, updated_at = ? WHERE id = ?`, now(), pausedFor, now(), s.id);
  await refreshAccess(env, s.subscriber_id);
  await emit(env, { pubId: pub.id, type: 'subscription.resumed', subscriberId: s.subscriber_id, data: { subscription_id: s.id, tier_id: s.tier_id } });
  return true;
}

/** Cancel: at period end by default (access continues), or immediately. */
export async function cancelSubscription(env: Env, pub: Publication, subId: string, immediately = false) {
  const s = await one<any>(env, 'SELECT * FROM subscriptions WHERE id = ? AND pub_id = ?', subId, pub.id);
  if (!s || s.status === 'canceled') return false;
  const acct = settings(pub).stripe_account_id || undefined;
  if (s.stripe_subscription_id && stripeEnabled(env)) {
    if (immediately) await fetch(`https://api.stripe.com/v1/subscriptions/${s.stripe_subscription_id}`, { method: 'DELETE', headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, ...(acct ? { 'stripe-account': acct } : {}) } });
    else await stripePost(env, `subscriptions/${s.stripe_subscription_id}`, { cancel_at_period_end: 'true' }, acct);
  }
  if (immediately || !s.current_period_end || s.current_period_end < now() || s.status === 'paused') {
    await run(env, `UPDATE subscriptions SET status = 'canceled', canceled_at = ?, updated_at = ? WHERE id = ?`, now(), now(), s.id);
    await refreshAccess(env, s.subscriber_id);
    await emit(env, { pubId: pub.id, type: 'subscription.downgraded', subscriberId: s.subscriber_id, data: { subscription_id: s.id, tier_id: s.tier_id, reason: 'canceled' } });
  } else {
    await run(env, `UPDATE subscriptions SET cancel_at_period_end = 1, canceled_at = ?, updated_at = ? WHERE id = ?`, now(), now(), s.id);
  }
  return true;
}

export async function reactivateSubscription(env: Env, pub: Publication, subId: string) {
  const s = await one<any>(env, 'SELECT * FROM subscriptions WHERE id = ? AND pub_id = ?', subId, pub.id);
  if (!s || !s.cancel_at_period_end || s.status === 'canceled') return false;
  if (s.stripe_subscription_id && stripeEnabled(env)) await stripePost(env, `subscriptions/${s.stripe_subscription_id}`, { cancel_at_period_end: 'false' }, settings(pub).stripe_account_id || undefined);
  await run(env, 'UPDATE subscriptions SET cancel_at_period_end = 0, canceled_at = NULL, updated_at = ? WHERE id = ?', now(), s.id);
  return true;
}

// ───────── coaching slots (timezone-aware) ─────────
function tzOffsetMs(tz: string, at: number): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at));
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUTC = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
    return asUTC - at;
  } catch { return 0; }
}
/** Wall-clock time in tz → UTC ms */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(y, m, d, hh, mm);
  const off = tzOffsetMs(tz, guess);
  const t = guess - off;
  return t - (tzOffsetMs(tz, t) - off); // DST correction
}

export interface Slot { start: number; end: number }
/** Open coaching slots for the next `days` days given weekly availability [{dow:0-6, start:'09:00', end:'17:00'}]. */
export async function coachingSlots(env: Env, product: any, days = 21): Promise<Slot[]> {
  const cfg = parseJSON<any>(product.coaching, {});
  const dur = Math.max(15, Number(cfg.duration_min) || 30);
  const tz = cfg.tz || 'UTC';
  const avail: Array<{ dow: number; start: string; end: string }> = cfg.availability || [];
  const booked = await all<{ starts_at: number; ends_at: number }>(env, `SELECT starts_at, ends_at FROM bookings WHERE product_id = ? AND status != 'canceled' AND ends_at > ?`, product.id, now());
  const out: Slot[] = [];
  const minLead = now() + 12 * HOUR;
  for (let i = 0; i < days; i++) {
    const day = new Date(now() + i * DAY + tzOffsetMs(tz, now()));
    const y = day.getUTCFullYear(), m = day.getUTCMonth(), d = day.getUTCDate(), dow = day.getUTCDay();
    for (const a of avail.filter((x) => Number(x.dow) === dow)) {
      const [sh, sm] = a.start.split(':').map(Number), [eh, em] = a.end.split(':').map(Number);
      let t = zonedToUtc(y, m, d, sh, sm || 0, tz);
      const end = zonedToUtc(y, m, d, eh, em || 0, tz);
      while (t + dur * MIN <= end) {
        const s = { start: t, end: t + dur * MIN };
        if (s.start > minLead && !booked.some((b) => b.starts_at < s.end && b.ends_at > s.start)) out.push(s);
        t += dur * MIN;
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export function b64utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function ics(o: { uid: string; start: number; end: number; title: string; description?: string; location?: string; organizer?: string }): string {
  const f = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const e = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OpenHive//EN', 'CALSCALE:GREGORIAN', 'METHOD:REQUEST', 'BEGIN:VEVENT', `UID:${o.uid}@openhive`, `DTSTAMP:${f(now())}`, `DTSTART:${f(o.start)}`, `DTEND:${f(o.end)}`, `SUMMARY:${e(o.title)}`, o.description ? `DESCRIPTION:${e(o.description)}` : '', o.location ? `LOCATION:${e(o.location)}` : '', o.organizer ? `ORGANIZER:mailto:${o.organizer}` : '', 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
}

// ───────── fulfillment ─────────
async function linkOrder(env: Env, orderId: string, subscriberId: string) {
  await run(env, 'UPDATE orders SET subscriber_id = ? WHERE id = ?', subscriberId, orderId);
}

onOrderPaid('subscription', async (env, order, pub) => {
  const d = parseJSON<any>(order.data, {});
  const tier = await one<any>(env, 'SELECT * FROM tiers WHERE id = ?', order.ref_id);
  if (!tier) return;
  const sub = await ensureSubscriber(env, pub, order.email, order.name);
  if (!sub) return;
  await linkOrder(env, order.id, sub.id);
  const interval = d.recurring?.interval || d.interval || 'month';
  const trialDays = Number(d.recurring?.trialDays || 0);
  const trialEnds = trialDays ? now() + trialDays * DAY : null;
  const amount = Number(d.full_amount_cents ?? order.amount_cents);
  const periodEnd = addInterval(trialEnds || now(), interval);
  const existing = await one<any>(env, `SELECT * FROM subscriptions WHERE subscriber_id = ? AND pub_id = ? AND group_owner_id IS NULL AND status IN ('active','trialing','paused','past_due') ORDER BY created_at DESC LIMIT 1`, sub.id, pub.id);
  let type = 'subscription.upgraded';
  if (existing) {
    if (amount < existing.amount_cents) type = 'subscription.downgraded';
    // replace an older Stripe subscription when switching plans
    if (existing.stripe_subscription_id && existing.stripe_subscription_id !== order.stripe_subscription_id && stripeEnabled(env)) {
      const acct = settings(pub).stripe_account_id;
      await fetch(`https://api.stripe.com/v1/subscriptions/${existing.stripe_subscription_id}`, { method: 'DELETE', headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, ...(acct ? { 'stripe-account': acct } : {}) } }).catch(() => {});
    }
    await run(env, `UPDATE subscriptions SET tier_id = ?, interval = ?, status = ?, amount_cents = ?, currency = ?, offer_id = ?, stripe_subscription_id = COALESCE(?, stripe_subscription_id), trial_ends_at = ?, current_period_end = ?, paused_at = NULL, cancel_at_period_end = 0, canceled_at = NULL, order_id = ?, updated_at = ? WHERE id = ?`,
      tier.id, interval, trialEnds ? 'trialing' : 'active', amount, order.currency, order.offer_id, order.stripe_subscription_id ?? null, trialEnds, periodEnd, order.id, now(), existing.id);
  } else {
    await insert(env, 'subscriptions', {
      id: id(), pub_id: pub.id, subscriber_id: sub.id, tier_id: tier.id, interval, status: trialEnds ? 'trialing' : 'active', amount_cents: amount, currency: order.currency,
      seats: 1, offer_id: order.offer_id, stripe_subscription_id: order.stripe_subscription_id ?? null, trial_ends_at: trialEnds, current_period_end: periodEnd, order_id: order.id, created_at: now(), updated_at: now(),
    });
  }
  await setPremium(env, sub.id, tier.id, trialEnds);
  await emit(env, { pubId: pub.id, type, subscriberId: sub.id, refId: tier.id, data: { tier_id: tier.id, tier: tier.name, interval, amount_cents: amount, trial_days: trialDays } });
  const base = siteUrl(env, pub);
  await sendTransactional(env, order.email, `Welcome to ${tier.name} — ${pub.name}`,
    `<p>Thanks for subscribing to <strong>${esc(pub.name)}</strong>! You now have full access to every premium post.</p>
     <p><strong>${esc(tier.name)}</strong> · ${money(amount, order.currency)} / ${interval}${trialDays ? ` · ${trialDays}-day trial${d.recurring?.trialAmountCents ? ` (${money(d.recurring.trialAmountCents, order.currency)})` : ''}, first charge ${fmtDate(trialEnds)}` : ''}</p>
     <p>Receipt: order ${esc(order.id)} · paid ${money(order.amount_cents, order.currency)}</p>${button('Start reading', base)}<p style="font-size:13px;color:#6b7280">Manage your subscription any time at ${esc(base)}/subscription</p>`, pub);
});

onOrderPaid('gift', async (env, order, pub) => {
  const d = parseJSON<any>(order.data, {});
  const tier = await one<any>(env, 'SELECT name FROM tiers WHERE id = ?', order.ref_id);
  const to = d.recipient_email || order.email;
  const url = `${siteUrl(env, pub)}/gift/${order.delivery_token}`;
  await sendTransactional(env, to, `${d.from_name || order.email} sent you a gift subscription to ${pub.name} 🎁`,
    `<p>You've been gifted <strong>${d.months} month${d.months > 1 ? 's' : ''} of ${esc(tier?.name || 'premium')}</strong> to ${esc(pub.name)}.</p>${d.message ? `<blockquote style="border-left:3px solid #f59e0b;margin:12px 0;padding:4px 12px;color:#374151">${esc(d.message)}</blockquote>` : ''}${button('Redeem your gift', url)}`, pub);
  if (to !== order.email) await sendTransactional(env, order.email, `Your gift to ${to} is on its way`, `<p>We emailed ${esc(to)} a link to redeem ${d.months} month(s) of ${esc(pub.name)}. Thank you!</p><p>Gift link (if you'd rather share it yourself): <a href="${url}">${url}</a></p>`, pub);
});

/** Redeem a gift: premium for N months, no renewal. */
export async function redeemGift(env: Env, pub: Publication, token: string, email: string): Promise<{ ok: boolean; error?: string }> {
  const order = await one<any>(env, `SELECT * FROM orders WHERE delivery_token = ? AND pub_id = ? AND kind = 'gift'`, token, pub.id);
  if (!order || order.status !== 'paid') return { ok: false, error: 'This gift link is not valid.' };
  const d = parseJSON<any>(order.data, {});
  if (d.redeemed_at) return { ok: false, error: 'This gift has already been redeemed.' };
  const sub = await ensureSubscriber(env, pub, email, '', 'website');
  if (!sub) return { ok: false, error: 'Please use a valid email address.' };
  const months = Number(d.months) || 1;
  const existing = await one<any>(env, `SELECT * FROM subscriptions WHERE subscriber_id = ? AND status IN ('active','trialing') ORDER BY current_period_end DESC LIMIT 1`, sub.id);
  const from = existing?.current_period_end && existing.current_period_end > now() ? existing.current_period_end : now();
  await insert(env, 'subscriptions', { id: id(), pub_id: pub.id, subscriber_id: sub.id, tier_id: order.ref_id, interval: 'month', status: 'active', amount_cents: 0, currency: order.currency, seats: 1, gift_from_email: order.email, gift_message: d.message || null, cancel_at_period_end: 1, current_period_end: addInterval(from, 'month', months), order_id: order.id, created_at: now(), updated_at: now() });
  d.redeemed_at = now(); d.redeemed_by = email;
  await run(env, 'UPDATE orders SET data = ? WHERE id = ?', JSON.stringify(d), order.id);
  await setPremium(env, sub.id, order.ref_id);
  await emit(env, { pubId: pub.id, type: 'subscription.upgraded', subscriberId: sub.id, refId: order.ref_id, data: { tier_id: order.ref_id, gift: true, months } });
  return { ok: true };
}

onOrderPaid('group', async (env, order, pub) => {
  const d = parseJSON<any>(order.data, {});
  const owner = await ensureSubscriber(env, pub, order.email, order.name);
  if (!owner) return;
  await linkOrder(env, order.id, owner.id);
  const interval = d.recurring?.interval || 'year';
  const seats = Math.max(1, Number(d.seats) || 1);
  const sid = id();
  await insert(env, 'subscriptions', { id: sid, pub_id: pub.id, subscriber_id: owner.id, tier_id: order.ref_id, interval, status: 'active', amount_cents: order.amount_cents, currency: order.currency, seats, offer_id: order.offer_id, stripe_subscription_id: order.stripe_subscription_id ?? null, current_period_end: addInterval(now(), interval), order_id: order.id, created_at: now(), updated_at: now() });
  await setPremium(env, owner.id, order.ref_id);
  if (d.deal_id) await run(env, `UPDATE group_deals SET status = 'paid' WHERE id = ?`, d.deal_id);
  await emit(env, { pubId: pub.id, type: 'subscription.upgraded', subscriberId: owner.id, refId: order.ref_id, data: { tier_id: order.ref_id, group: true, seats } });
  const url = `${siteUrl(env, pub)}/group/${order.delivery_token}`;
  await sendTransactional(env, order.email, `Your ${seats}-seat group subscription to ${pub.name}`, `<p>Your group subscription is active with <strong>${seats} seats</strong> (including yours).</p><p>Share this link with your team so each person can claim a seat with their own email:</p>${button('Team join link', url)}<p style="font-size:13px;word-break:break-all">${url}</p>`, pub);
});

export async function joinGroup(env: Env, pub: Publication, token: string, email: string): Promise<{ ok: boolean; error?: string }> {
  const order = await one<any>(env, `SELECT * FROM orders WHERE delivery_token = ? AND pub_id = ? AND kind = 'group' AND status = 'paid'`, token, pub.id);
  if (!order) return { ok: false, error: 'This team link is not valid.' };
  const ownerSub = await one<any>(env, `SELECT * FROM subscriptions WHERE order_id = ? AND group_owner_id IS NULL`, order.id);
  if (!ownerSub || ['canceled', 'paused'].includes(ownerSub.status)) return { ok: false, error: 'This team subscription is no longer active.' };
  const used = 1 + (await val<number>(env, `SELECT COUNT(*) FROM subscriptions WHERE group_owner_id = ? AND status = 'active'`, ownerSub.id));
  const sub = await ensureSubscriber(env, pub, email);
  if (!sub) return { ok: false, error: 'Please use a valid email address.' };
  if (sub.id === ownerSub.subscriber_id) return { ok: true };
  const already = await one(env, `SELECT 1 FROM subscriptions WHERE group_owner_id = ? AND subscriber_id = ? AND status = 'active'`, ownerSub.id, sub.id);
  if (already) return { ok: true };
  if (used >= ownerSub.seats) return { ok: false, error: 'All seats on this team plan are taken. Ask your admin to add seats.' };
  await insert(env, 'subscriptions', { id: id(), pub_id: pub.id, subscriber_id: sub.id, tier_id: ownerSub.tier_id, interval: ownerSub.interval, status: 'active', amount_cents: 0, currency: ownerSub.currency, seats: 1, group_owner_id: ownerSub.id, current_period_end: ownerSub.current_period_end, order_id: order.id, created_at: now(), updated_at: now() });
  await setPremium(env, sub.id, ownerSub.tier_id);
  await emit(env, { pubId: pub.id, type: 'subscription.upgraded', subscriberId: sub.id, refId: ownerSub.tier_id, data: { tier_id: ownerSub.tier_id, group_seat: true } });
  return { ok: true };
}

async function fulfillProduct(env: Env, order: any, pub: Publication) {
  const p = await one<any>(env, 'SELECT * FROM products WHERE id = ?', order.ref_id);
  if (!p) return;
  const d = parseJSON<any>(order.data, {});
  const sub = await ensureSubscriber(env, pub, order.email, order.name, 'product');
  if (sub) await linkOrder(env, order.id, sub.id);
  await run(env, 'UPDATE products SET sales_count = sales_count + 1, revenue_cents = revenue_cents + ? WHERE id = ?', order.amount_cents, p.id);
  const base = siteUrl(env, pub);
  let body = `<p>Thanks for your order of <strong>${esc(p.name)}</strong>${d.variant_name ? ` (${esc(d.variant_name)})` : ''}.</p>`;
  if (p.kind === 'coaching' && d.slot_start) {
    const dur = Math.max(15, Number(parseJSON<any>(p.coaching, {}).duration_min) || 30);
    const bid = id();
    await insert(env, 'bookings', { id: bid, pub_id: pub.id, product_id: p.id, order_id: order.id, subscriber_id: sub?.id ?? null, email: order.email, name: order.name, starts_at: Number(d.slot_start), ends_at: Number(d.slot_start) + dur * MIN, status: 'confirmed', notes: d.notes || '', created_at: now() });
    const cfg = parseJSON<any>(p.coaching, {});
    body += `<p>Your session is booked for <strong>${fmtDate(Number(d.slot_start), { dateStyle: 'full', timeStyle: 'short' }, cfg.tz || 'UTC')}</strong> (${esc(cfg.tz || 'UTC')}), ${dur} minutes.${cfg.location ? ` Location: ${esc(cfg.location)}` : ''}</p>`;
    const cal = ics({ uid: bid, start: Number(d.slot_start), end: Number(d.slot_start) + dur * MIN, title: `${p.name} — ${pub.name}`, description: cfg.location || '', location: cfg.location || '', organizer: env.MAIL_FROM });
    await sendTransactional(env, order.email, `Booking confirmed: ${p.name}`, body + button('View booking', `${base}/order/${order.id}`), pub);
    // calendar invite as attachment
    try {
      const { sendMail } = await import('./email');
      await sendMail(env, { to: order.email, subject: `Invitation: ${p.name}`, html: `<p>Calendar invite for your session with ${esc(pub.name)}.</p>`, kind: 'transactional', pub, attachments: [{ content: b64utf8(cal), filename: 'invite.ics', type: 'text/calendar', disposition: 'attachment' }] });
    } catch (e) { console.error('invite failed', e); }
  } else {
    if (p.kind === 'membership' && p.access_days) body += `<p>Your access is valid for ${p.access_days} days (until ${fmtDate(now() + p.access_days * DAY)}).</p>`;
    body += button(p.kind === 'link' ? 'Open your purchase' : p.kind === 'guide' || p.kind === 'membership' ? 'Read now' : 'Download', `${base}/order/${order.id}`);
    await sendTransactional(env, order.email, `Your purchase: ${p.name}`, body, pub);
  }
  if (p.automation_id && sub) await enroll(env, p.automation_id, sub.id, { product_id: p.id, order_id: order.id }).catch(() => null);
  // review request a few days later is handled by the periodic task below (order.data.review_requested)
}
onOrderPaid('product', fulfillProduct);
onOrderPaid('replay', fulfillProduct);

onOrderPaid('sponsorship', async (env, order, pub) => {
  const d = parseJSON<any>(order.data, {});
  if (d.campaign_id) await run(env, `UPDATE ad_campaigns SET status = 'active', spent_cents = ? WHERE id = ?`, order.amount_cents, d.campaign_id);
  if (d.opportunity_id) await run(env, `UPDATE ad_opportunities SET status = 'accepted', decided_at = ? WHERE id = ?`, now(), d.opportunity_id);
  await insert(env, 'wallet_entries', { id: id(), pub_id: pub.id, kind: 'sponsorship', ref_id: d.campaign_id ?? null, amount_cents: order.amount_cents, status: 'paid', note: 'Direct sponsorship — paid to you at checkout', created_at: now() });
  await sendTransactional(env, order.email, `Sponsorship booked with ${pub.name}`, `<p>Thanks! Your ${esc(d.product_name || 'sponsorship')} placement for <strong>${d.date ? fmtDate(Date.parse(d.date)) : 'an upcoming issue'}</strong> is booked. The team will review your creative and confirm.</p>`, pub);
  const owners = await all<{ email: string }>(env, `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.role IN ('owner','admin')`, pub.workspace_id);
  for (const o of owners) await sendTransactional(env, o.email, `New sponsorship booked: ${d.company || order.email}`, `<p>${esc(d.company || order.email)} booked <strong>${esc(d.product_name || 'a placement')}</strong> for ${esc(d.date || 'an upcoming issue')} — ${money(order.amount_cents, order.currency)}.</p>${button('Review creative', `${env.APP_URL}/app/monetize/sponsorships`)}`, pub);
});

// ───────── ads & wallet ─────────
/** Credit ad earnings respecting the campaign budget. */
export async function creditAd(env: Env, oppId: string, amount: number, note: string, status: 'pending' | 'available' = 'pending') {
  const o = await one<any>(env, `SELECT o.*, c.budget_cents, c.spent_cents FROM ad_opportunities o JOIN ad_campaigns c ON c.id = o.campaign_id WHERE o.id = ?`, oppId);
  if (!o || amount <= 0) return 0;
  const room = o.budget_cents > 0 ? Math.max(0, o.budget_cents - o.spent_cents) : amount;
  const amt = Math.min(amount, room);
  if (amt <= 0) return 0;
  await run(env, 'UPDATE ad_opportunities SET earned_cents = earned_cents + ? WHERE id = ?', amt, oppId);
  await run(env, 'UPDATE ad_campaigns SET spent_cents = spent_cents + ? WHERE id = ?', amt, o.campaign_id);
  await insert(env, 'wallet_entries', { id: id(), pub_id: o.pub_id, kind: 'ad', ref_id: oppId, amount_cents: amt, status, note, created_at: now() });
  return amt;
}

export async function walletSummary(env: Env, pubId: string) {
  const available = await val<number>(env, `SELECT COALESCE(SUM(amount_cents),0) FROM wallet_entries WHERE pub_id = ? AND (status = 'available' OR kind = 'payout')`, pubId);
  const pending = await val<number>(env, `SELECT COALESCE(SUM(amount_cents),0) FROM wallet_entries WHERE pub_id = ? AND status = 'pending'`, pubId);
  const paidOut = await val<number>(env, `SELECT COALESCE(-SUM(amount_cents),0) FROM wallet_entries WHERE pub_id = ? AND kind = 'payout'`, pubId);
  const lifetime = await val<number>(env, `SELECT COALESCE(SUM(amount_cents),0) FROM wallet_entries WHERE pub_id = ? AND kind IN ('ad','boost','clawback')`, pubId);
  return { available, pending, paidOut, lifetime };
}

registerPeriodic('billing.lifecycle', 15 * MIN, async (env) => {
  const t = now();
  // trials ending → active
  await run(env, `UPDATE subscriptions SET status = 'active', updated_at = ? WHERE status = 'trialing' AND trial_ends_at IS NOT NULL AND trial_ends_at <= ?`, t, t);
  await run(env, `UPDATE subscribers SET trial_ends_at = NULL WHERE trial_ends_at IS NOT NULL AND trial_ends_at <= ? AND tier = 'premium' AND tier_id IS NOT NULL`, t);
  // period ended for non-renewing (gifts, canceled-at-period-end) → canceled + downgrade
  const ended = await all<any>(env, `SELECT * FROM subscriptions WHERE status IN ('active','trialing','past_due') AND current_period_end IS NOT NULL AND current_period_end <= ? AND (cancel_at_period_end = 1 OR (stripe_subscription_id IS NULL AND ? = 1)) LIMIT 200`, t, env.STRIPE_SECRET_KEY ? 1 : 0);
  for (const s of ended) {
    await run(env, `UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE id = ?`, t, s.id);
    await run(env, `UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE group_owner_id = ?`, t, s.id);
    await refreshAccess(env, s.subscriber_id);
    for (const m of await all<any>(env, 'SELECT subscriber_id FROM subscriptions WHERE group_owner_id = ?', s.id)) await refreshAccess(env, m.subscriber_id);
    await emit(env, { pubId: s.pub_id, type: 'subscription.downgraded', subscriberId: s.subscriber_id, data: { subscription_id: s.id, tier_id: s.tier_id, reason: 'period_ended' } });
  }
  // test mode (no Stripe): simulate renewals so local subscriptions behave like real ones
  if (!env.STRIPE_SECRET_KEY) {
    const due = await all<any>(env, `SELECT * FROM subscriptions WHERE status = 'active' AND cancel_at_period_end = 0 AND stripe_subscription_id IS NULL AND group_owner_id IS NULL AND amount_cents > 0 AND current_period_end <= ? LIMIT 200`, t);
    for (const s of due) {
      const sub = await one<any>(env, 'SELECT email, name FROM subscribers WHERE id = ?', s.subscriber_id);
      await insert(env, 'orders', { id: id(), pub_id: s.pub_id, kind: 'subscription', ref_id: s.tier_id, subscriber_id: s.subscriber_id, email: sub?.email || '', name: sub?.name || '', amount_cents: s.amount_cents, currency: s.currency, status: 'paid', data: JSON.stringify({ description: 'Renewal (test mode)', renewal: true }), created_at: t, paid_at: t });
      const next = addInterval(s.current_period_end < t - 2 * DAY ? t : s.current_period_end, s.interval);
      await run(env, 'UPDATE subscriptions SET current_period_end = ?, updated_at = ? WHERE id = ?', next, t, s.id);
      await run(env, 'UPDATE subscriptions SET current_period_end = ? WHERE group_owner_id = ?', next, s.id);
    }
  }
  // memberships expire
  await run(env, `UPDATE bookings SET status = 'completed' WHERE status = 'confirmed' AND ends_at < ?`, t);
  // wallet: earnings older than 7 days (clawback window) become available
  await run(env, `UPDATE wallet_entries SET status = 'available' WHERE status = 'pending' AND kind IN ('ad','boost') AND created_at < ?`, t - 7 * DAY);
  // review requests 3 days after product purchase
  const toReview = await all<any>(env, `SELECT o.*, p.name AS pname, p.slug AS pslug FROM orders o JOIN products p ON p.id = o.ref_id WHERE o.kind = 'product' AND o.status = 'paid' AND o.paid_at < ? AND o.paid_at > ? AND o.data NOT LIKE '%"review_requested"%' LIMIT 50`, t - 3 * DAY, t - 30 * DAY);
  for (const o of toReview) {
    const pub = await one<Publication>(env, 'SELECT * FROM publications WHERE id = ?', o.pub_id);
    if (!pub) continue;
    const d = parseJSON<any>(o.data, {});
    d.review_requested = t;
    await run(env, 'UPDATE orders SET data = ? WHERE id = ?', JSON.stringify(d), o.id);
    await sendTransactional(env, o.email, `How was ${o.pname}?`, `<p>We'd love to hear what you think of <strong>${esc(o.pname)}</strong>. It takes 30 seconds.</p>${button('Leave a review', `${siteUrl(env, pub)}/shop/${o.pslug}?review=${o.delivery_token}`)}`, pub);
  }
});

/** Settle ad placements once their post has been sent: impressions, CPM / flat earnings. */
registerPeriodic('ads.settle', 15 * MIN, async (env) => {
  const opps = await all<any>(env, `SELECT o.*, c.pricing, c.rate_cents, c.name AS cname FROM ad_opportunities o JOIN ad_campaigns c ON c.id = o.campaign_id WHERE o.status IN ('accepted','placed') AND o.post_id IS NOT NULL AND o.settled_at IS NULL AND o.programmatic = 0 LIMIT 100`);
  for (const o of opps) {
    const send = await one<any>(env, `SELECT id FROM sends WHERE post_id = ? AND kind = 'post' AND status = 'sent' ORDER BY created_at DESC LIMIT 1`, o.post_id);
    const published = await one<any>(env, `SELECT 1 FROM posts WHERE id = ? AND status = 'published' AND platform = 'web'`, o.post_id);
    if (!send && !published) continue;
    const impressions = send ? await val<number>(env, `SELECT COUNT(*) FROM deliveries WHERE send_id = ? AND status IN ('sent','deferred')`, send.id) : 0;
    await run(env, `UPDATE ad_opportunities SET impressions = ?, status = 'completed', settled_at = ? WHERE id = ?`, impressions, now(), o.id);
    if (o.pricing === 'cpm') await creditAd(env, o.id, Math.round((impressions * o.rate_cents) / 1000), `${o.cname}: ${impressions} impressions (CPM)`);
    else if (o.pricing === 'flat') await creditAd(env, o.id, o.rate_cents, `${o.cname}: flat placement`);
  }
});

export { stripeEnabled };
