// Payments: orders table + Stripe Checkout (direct API, Stripe Connect optional).
// Without STRIPE_SECRET_KEY, checkout runs in "test mode": a built-in simulated checkout page marks orders paid,
// so every purchase flow works end-to-end locally. 0% platform fee by default (PLATFORM_FEE_PERCENT).
import type { Env, Publication } from '../types';
import { one, run, insert } from './db';
import { emit } from './events';
import { id, now, token, hmac, safeEqual } from './util';
import { settings, siteUrl } from './pub';

export type OrderKind = 'subscription' | 'product' | 'ticket' | 'gift' | 'group' | 'sponsorship' | 'replay';

/** Fulfillment handlers, registered by modules (monetize: subscription/product/gift/group; events: ticket/replay). */
type Fulfill = (env: Env, order: any, pub: Publication) => Promise<void>;
const fulfillers = new Map<string, Fulfill>();
export function onOrderPaid(kind: OrderKind, fn: Fulfill) {
  fulfillers.set(kind, fn);
}

export interface CheckoutInput {
  pub: Publication;
  kind: OrderKind;
  refId: string | null;
  variantId?: string | null;
  email: string;
  name?: string;
  subscriberId?: string | null;
  amountCents: number;
  currency?: string;
  description: string;
  offerId?: string | null;
  data?: Record<string, unknown>;
  /** recurring subscription: interval + optional trial */
  recurring?: { interval: 'month' | 'year'; trialDays?: number; trialAmountCents?: number } | null;
  successUrl?: string;
  cancelUrl?: string;
}

export function stripeEnabled(env: Env) {
  return !!env.STRIPE_SECRET_KEY;
}

async function stripe(env: Env, path: string, params: Record<string, string>, account?: string): Promise<any> {
  const headers: Record<string, string> = { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' };
  if (account) headers['stripe-account'] = account;
  const r = await fetch(`https://api.stripe.com/v1/${path}`, { method: 'POST', headers, body: new URLSearchParams(params) });
  const j: any = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || 'Stripe error');
  return j;
}

export async function stripeGet(env: Env, path: string, account?: string): Promise<any> {
  const headers: Record<string, string> = { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
  if (account) headers['stripe-account'] = account;
  const r = await fetch(`https://api.stripe.com/v1/${path}`, { headers });
  return r.json();
}

export { stripe as stripePost };

/** Create an order and return the URL to send the buyer to. Free orders are fulfilled immediately. */
export async function createCheckout(env: Env, input: CheckoutInput): Promise<{ orderId: string; url: string }> {
  const orderId = id();
  const currency = (input.currency || 'usd').toLowerCase();
  const feePct = Number(env.PLATFORM_FEE_PERCENT || '0');
  await insert(env, 'orders', {
    id: orderId, pub_id: input.pub.id, kind: input.kind, ref_id: input.refId, variant_id: input.variantId ?? null, subscriber_id: input.subscriberId ?? null,
    email: input.email.toLowerCase(), name: input.name || '', amount_cents: input.amountCents, currency, platform_fee_cents: Math.round((input.amountCents * feePct) / 100),
    offer_id: input.offerId ?? null, status: 'pending', delivery_token: token(18), data: JSON.stringify({ ...(input.data || {}), description: input.description, recurring: input.recurring || null }), created_at: now(),
  });
  const base = siteUrl(env, input.pub);
  const success = input.successUrl || `${base}/order/${orderId}`;
  const cancel = input.cancelUrl || base;
  if (input.amountCents <= 0 && !input.recurring?.trialAmountCents) {
    await markPaid(env, orderId, {});
    return { orderId, url: success };
  }
  if (!stripeEnabled(env)) return { orderId, url: `${env.APP_URL.replace(/\/$/, '')}/checkout/simulate/${orderId}` };

  const acct = settings(input.pub).stripe_account_id || undefined;
  const p: Record<string, string> = {
    mode: input.recurring ? 'subscription' : 'payment',
    success_url: success + (success.includes('?') ? '&' : '?') + 'session_id={CHECKOUT_SESSION_ID}',
    cancel_url: cancel,
    customer_email: input.email,
    client_reference_id: orderId,
    'metadata[order_id]': orderId,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': currency,
    'line_items[0][price_data][unit_amount]': String(input.amountCents),
    'line_items[0][price_data][product_data][name]': input.description.slice(0, 200),
  };
  if (input.recurring) {
    p['line_items[0][price_data][recurring][interval]'] = input.recurring.interval;
    p['subscription_data[metadata][order_id]'] = orderId;
    if (input.recurring.trialDays) p['subscription_data[trial_period_days]'] = String(input.recurring.trialDays);
    if (input.recurring.trialAmountCents) {
      // paid trial: one-time fee item alongside the trialing subscription
      p['line_items[1][quantity]'] = '1';
      p['line_items[1][price_data][currency]'] = currency;
      p['line_items[1][price_data][unit_amount]'] = String(input.recurring.trialAmountCents);
      p['line_items[1][price_data][product_data][name]'] = `Trial: ${input.recurring.trialDays} days`;
    }
    if (feePct > 0 && acct) p['subscription_data[application_fee_percent]'] = String(feePct);
  } else {
    p['payment_intent_data[metadata][order_id]'] = orderId;
    if (feePct > 0 && acct) p['payment_intent_data[application_fee_amount]'] = String(Math.round((input.amountCents * feePct) / 100));
  }
  const session = await stripe(env, 'checkout/sessions', p, acct);
  await run(env, 'UPDATE orders SET stripe_session_id = ? WHERE id = ?', session.id, orderId);
  return { orderId, url: session.url };
}

/** Mark an order paid (idempotent) and run its fulfillment. */
export async function markPaid(env: Env, orderId: string, extra: { paymentIntent?: string; stripeSubscriptionId?: string }) {
  const res = await run(env, `UPDATE orders SET status = 'paid', paid_at = ?, stripe_payment_intent = COALESCE(?, stripe_payment_intent) WHERE id = ? AND status = 'pending'`, now(), extra.paymentIntent ?? null, orderId);
  if (!res.meta.changes) return;
  const order = await one<any>(env, 'SELECT * FROM orders WHERE id = ?', orderId);
  const pub = await one<Publication>(env, 'SELECT * FROM publications WHERE id = ?', order.pub_id);
  if (!order || !pub) return;
  if (extra.stripeSubscriptionId) order.stripe_subscription_id = extra.stripeSubscriptionId;
  if (order.offer_id) await run(env, 'UPDATE offers SET redemptions = redemptions + 1 WHERE id = ?', order.offer_id);
  const f = fulfillers.get(order.kind);
  if (f) await f(env, order, pub);
  const fresh = await one<any>(env, 'SELECT subscriber_id FROM orders WHERE id = ?', orderId);
  await emit(env, { pubId: pub.id, type: 'order.paid', subscriberId: fresh?.subscriber_id ?? order.subscriber_id, refId: order.ref_id, data: { order_id: order.id, kind: order.kind, ref_id: order.ref_id, amount_cents: order.amount_cents, currency: order.currency } });
}

/** Verify a Stripe webhook signature (Stripe-Signature: t=...,v1=...). */
export async function verifyStripeSignature(env: Env, payload: string, header: string | undefined): Promise<boolean> {
  if (!env.STRIPE_WEBHOOK_SECRET || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 600) return false;
  const expected = await hmac(env.STRIPE_WEBHOOK_SECRET, `${parts.t}.${payload}`);
  return safeEqual(expected, parts.v1);
}

/** Apply an offer/coupon code. Returns discounted amount and offer id. */
export async function applyOffer(env: Env, pubId: string, code: string | undefined, appliesTo: string, targetId: string | null, amount: number): Promise<{ amount: number; offerId: string | null; error?: string }> {
  if (!code) return { amount, offerId: null };
  const o = await one<any>(env, `SELECT * FROM offers WHERE pub_id = ? AND code = ? COLLATE NOCASE AND active = 1`, pubId, code.trim());
  if (!o) return { amount, offerId: null, error: 'That code is not valid.' };
  if (o.expires_at && o.expires_at < now()) return { amount, offerId: null, error: 'That code has expired.' };
  if (o.max_redemptions && o.redemptions >= o.max_redemptions) return { amount, offerId: null, error: 'That code has been fully redeemed.' };
  if (o.applies_to !== 'all' && o.applies_to !== appliesTo) return { amount, offerId: null, error: 'That code does not apply here.' };
  if (o.target_id && o.target_id !== targetId) return { amount, offerId: null, error: 'That code does not apply to this item.' };
  const off = o.percent_off ? Math.round((amount * o.percent_off) / 100) : o.amount_off_cents;
  return { amount: Math.max(0, amount - off), offerId: o.id };
}
