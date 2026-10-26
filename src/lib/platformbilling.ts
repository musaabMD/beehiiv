// Platform billing: workspaces pay the hosted service for their plan through Stripe Checkout subscriptions on the
// PLATFORM's own Stripe account (STRIPE_SECRET_KEY, no Connect). Without a key, a built-in simulated checkout
// (/checkout/plan/:id) runs the same flow so everything works locally and in tests.
//
// - Upgrades apply immediately (Stripe: subscription price swap with proration; otherwise a new checkout).
// - Downgrades (including to Free) take effect at the end of the paid period.
// - Failed payment → past_due with a GRACE_DAYS grace period → Free limits after that (see plans.effectivePlanId).
// Stripe webhook events (same signed /hooks/stripe endpoint): checkout.session.completed, customer.subscription.updated,
// customer.subscription.deleted, invoice.payment_failed, invoice.paid.
import type { Env } from '../types';
import { one, all, run, insert } from './db';
import { registerPeriodic } from './jobs';
import { stripeEnabled, stripePost, stripeGet } from './payments';
import { sendTransactional, button } from './email';
import { appUrl } from './pub';
import { clearBrandingCache, getPlan, getWorkspace, ownerOf, monthlyEquivalent, planPrice, logPlatformEvent, clearPlanCache, LIMITS, FREE_PLAN_ID, type PlatformPlan, type WorkspaceRow } from './plans';
import { id, now, DAY, MIN, esc, money, fmtDate } from './util';

export type Interval = 'month' | 'year';

function addInterval(from: number, interval: string): number {
  const d = new Date(from);
  if (interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}

async function notifyOwner(env: Env, ws: WorkspaceRow, subject: string, html: string) {
  const owner = await ownerOf(env, ws);
  if (owner) await sendTransactional(env, owner.email, subject, html).catch(() => {});
}

/** Set a workspace's plan now. Clears any pending change and past-due state. */
export async function setPlan(env: Env, wsId: string, planId: string, interval: Interval | null, o: { periodEnd?: number | null; actor?: string | null; note?: string; stripe?: { customer?: string | null; subscription?: string | null } } = {}) {
  const before = await getWorkspace(env, wsId);
  await run(env, `UPDATE workspaces SET plan_id = ?, plan_interval = ?, plan_period_end = ?, plan_status = 'active', plan_grace_until = NULL, plan_pending_id = NULL, plan_pending_interval = NULL,
      stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = CASE WHEN ? = 1 THEN ? ELSE stripe_subscription_id END WHERE id = ?`,
    planId, planId === FREE_PLAN_ID ? null : interval, planId === FREE_PLAN_ID ? null : o.periodEnd ?? null,
    o.stripe?.customer ?? null, o.stripe && 'subscription' in o.stripe ? 1 : 0, o.stripe?.subscription ?? null, wsId);
  clearBrandingCache(wsId);
  await logPlatformEvent(env, { workspaceId: wsId, kind: 'plan_changed', detail: `${before?.plan_id || '?'} → ${planId}${interval ? ` (${interval})` : ''}${o.note ? ' · ' + o.note : ''}`, actor: o.actor ?? null });
}

// ───────── Stripe prices ─────────
async function ensurePrice(env: Env, plan: PlatformPlan, interval: Interval): Promise<string> {
  const existing = interval === 'year' ? plan.stripe_price_annual : plan.stripe_price_monthly;
  if (existing) return existing;
  let product = plan.stripe_product_id;
  if (!product) {
    product = (await stripePost(env, 'products', { name: `Lnkbase Newsletter — ${plan.name}`, 'metadata[platform_plan_id]': plan.id })).id as string;
    await run(env, 'UPDATE platform_plans SET stripe_product_id = ? WHERE id = ?', product, plan.id);
  }
  const price = await stripePost(env, 'prices', { product: product!, currency: 'usd', unit_amount: String(planPrice(plan, interval)), 'recurring[interval]': interval, 'metadata[platform_plan_id]': plan.id });
  await run(env, `UPDATE platform_plans SET ${interval === 'year' ? 'stripe_price_annual' : 'stripe_price_monthly'} = ? WHERE id = ?`, price.id, plan.id);
  clearPlanCache();
  return price.id;
}

function periodEndOf(sub: any): number | null {
  const t = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end;
  return t ? Number(t) * 1000 : null;
}

// ───────── checkout ─────────
async function createCheckout(env: Env, ws: WorkspaceRow, plan: PlatformPlan, interval: Interval, userId: string | null): Promise<string> {
  const cid = id();
  await insert(env, 'platform_checkouts', { id: cid, workspace_id: ws.id, plan_id: plan.id, interval, amount_cents: planPrice(plan, interval), status: 'pending', created_by: userId, created_at: now() });
  if (!stripeEnabled(env)) return appUrl(env, `/checkout/plan/${cid}`);
  const owner = await ownerOf(env, ws);
  const p: Record<string, string> = {
    mode: 'subscription',
    success_url: appUrl(env, `/app/settings/plan?checkout=${cid}&session_id={CHECKOUT_SESSION_ID}`),
    cancel_url: appUrl(env, '/app/settings/plan'),
    client_reference_id: 'plan_' + cid,
    'metadata[platform_checkout_id]': cid,
    'metadata[platform_workspace_id]': ws.id,
    'subscription_data[metadata][platform_workspace_id]': ws.id,
    'subscription_data[metadata][platform_plan_id]': plan.id,
    'line_items[0][price]': await ensurePrice(env, plan, interval),
    'line_items[0][quantity]': '1',
    allow_promotion_codes: 'true',
  };
  if (ws.stripe_customer_id) p.customer = ws.stripe_customer_id;
  else if (owner) p.customer_email = owner.email;
  const session = await stripePost(env, 'checkout/sessions', p);
  await run(env, 'UPDATE platform_checkouts SET stripe_session_id = ? WHERE id = ?', session.id, cid);
  return session.url;
}

/** A checkout was paid (simulated page, Stripe webhook or the success-URL confirmation). Idempotent. */
export async function completeCheckout(env: Env, checkoutId: string, stripe: { customer?: string | null; subscription?: string | null } = {}): Promise<boolean> {
  const res = await run(env, `UPDATE platform_checkouts SET status = 'paid', paid_at = ? WHERE id = ? AND status = 'pending'`, now(), checkoutId);
  if (!res.meta.changes) return false;
  const co = await one<any>(env, 'SELECT * FROM platform_checkouts WHERE id = ?', checkoutId);
  const ws = co ? await getWorkspace(env, co.workspace_id) : null;
  if (!co || !ws) return false;
  let periodEnd = addInterval(now(), co.interval);
  if (stripe.subscription && stripeEnabled(env)) {
    const sub = await stripeGet(env, `subscriptions/${stripe.subscription}`).catch(() => null);
    periodEnd = periodEndOf(sub) || periodEnd;
    // replacing an older subscription (e.g. after a failed payment): cancel it so the customer isn't billed twice
    if (ws.stripe_subscription_id && ws.stripe_subscription_id !== stripe.subscription) {
      await fetch(`https://api.stripe.com/v1/subscriptions/${ws.stripe_subscription_id}`, { method: 'DELETE', headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }).catch(() => {});
    }
  }
  await setPlan(env, ws.id, co.plan_id, co.interval, { periodEnd, actor: co.created_by, note: 'checkout ' + checkoutId, stripe: stripe.subscription ? { customer: stripe.customer ?? null, subscription: stripe.subscription } : undefined });
  const plan = await getPlan(env, co.plan_id);
  await notifyOwner(env, ws, `You're on ${plan.name}`, `<p>Thanks! <strong>${esc(ws.name)}</strong> is now on the <strong>${esc(plan.name)}</strong> plan (${money(co.amount_cents)} / ${co.interval}). Your new limits apply right away.</p>${button('See plan & usage', appUrl(env, '/app/settings/plan'))}`);
  return true;
}

/** On return from Stripe Checkout, confirm the session directly (doesn't depend on the webhook arriving first). */
export async function confirmStripeSession(env: Env, checkoutId: string, sessionId: string): Promise<boolean> {
  if (!stripeEnabled(env) || !sessionId) return false;
  const co = await one<any>(env, 'SELECT * FROM platform_checkouts WHERE id = ? AND stripe_session_id = ?', checkoutId, sessionId);
  if (!co || co.status !== 'pending') return false;
  const s = await stripeGet(env, `checkout/sessions/${sessionId}`).catch(() => null);
  if (!s || (s.status !== 'complete' && s.payment_status !== 'paid')) return false;
  return completeCheckout(env, checkoutId, { customer: s.customer, subscription: s.subscription });
}

// ───────── plan changes ─────────
export interface ChangeResult { redirect?: string; message: string; kind?: 'ok' | 'err' }

/**
 * Change a workspace's plan from the Plan & usage page.
 * Upgrade = higher price per month (or Free → paid): immediate. Downgrade: at the end of the paid period.
 */
export async function changePlan(env: Env, wsId: string, planId: string, interval: Interval, userId: string | null): Promise<ChangeResult> {
  const ws = await getWorkspace(env, wsId);
  if (!ws) return { message: 'Workspace not found', kind: 'err' };
  const target = await getPlan(env, planId);
  if (target.id !== planId || !target.active) return { message: 'That plan is not available', kind: 'err' };
  const cur = await getPlan(env, ws.plan_id);
  const curInterval = (ws.plan_interval as Interval) || 'month';
  const pendingDate = ws.plan_period_end ? fmtDate(ws.plan_period_end) : 'the end of your billing period';

  // choosing the current plan again cancels a scheduled downgrade
  if (target.id === ws.plan_id && (target.id === FREE_PLAN_ID || interval === curInterval)) {
    if (!ws.plan_pending_id) return { message: `You're already on ${target.name}.` };
    if (stripeEnabled(env) && ws.stripe_subscription_id) {
      const price = await ensurePrice(env, cur, curInterval);
      const sub = await stripeGet(env, `subscriptions/${ws.stripe_subscription_id}`);
      const itemId = sub?.items?.data?.[0]?.id;
      await stripePost(env, `subscriptions/${ws.stripe_subscription_id}`, { cancel_at_period_end: 'false', ...(itemId ? { 'items[0][id]': itemId, 'items[0][price]': price, proration_behavior: 'none' } : {}) });
    }
    await run(env, 'UPDATE workspaces SET plan_pending_id = NULL, plan_pending_interval = NULL WHERE id = ?', ws.id);
    await logPlatformEvent(env, { workspaceId: ws.id, kind: 'plan_changed', detail: `scheduled downgrade to ${ws.plan_pending_id} cancelled`, actor: userId });
    return { message: `Scheduled change cancelled — you stay on ${cur.name}.` };
  }

  // → Free: at period end (immediately when there's nothing paid to run out)
  if (target.id === FREE_PLAN_ID) {
    if (!ws.plan_period_end || ws.plan_period_end <= now()) {
      await setPlan(env, ws.id, FREE_PLAN_ID, null, { actor: userId, note: 'downgrade' });
      return { message: 'You are now on the Free plan.' };
    }
    if (stripeEnabled(env) && ws.stripe_subscription_id) await stripePost(env, `subscriptions/${ws.stripe_subscription_id}`, { cancel_at_period_end: 'true' });
    await run(env, 'UPDATE workspaces SET plan_pending_id = ?, plan_pending_interval = NULL WHERE id = ?', FREE_PLAN_ID, ws.id);
    await logPlatformEvent(env, { workspaceId: ws.id, kind: 'plan_changed', detail: `downgrade to free scheduled for ${pendingDate}`, actor: userId });
    return { message: `You'll move to Free on ${pendingDate}. ${cur.name} limits stay until then.` };
  }

  const upgrade = cur.id === FREE_PLAN_ID || monthlyEquivalent(target, interval) > monthlyEquivalent(cur, curInterval) || (target.id === cur.id && interval === 'year' && curInterval === 'month');
  const liveStripeSub = stripeEnabled(env) && ws.stripe_subscription_id && ws.plan_status === 'active';

  if (upgrade) {
    if (liveStripeSub) {
      const price = await ensurePrice(env, target, interval);
      const sub = await stripeGet(env, `subscriptions/${ws.stripe_subscription_id}`);
      const itemId = sub?.items?.data?.[0]?.id;
      if (itemId) {
        const upd = await stripePost(env, `subscriptions/${ws.stripe_subscription_id}`, { 'items[0][id]': itemId, 'items[0][price]': price, proration_behavior: 'always_invoice', cancel_at_period_end: 'false', 'metadata[platform_plan_id]': target.id });
        await setPlan(env, ws.id, target.id, interval, { periodEnd: periodEndOf(upd) || ws.plan_period_end, actor: userId, note: 'upgrade (proration)' });
        return { message: `Upgraded to ${target.name}. The prorated difference was charged to your card on file.` };
      }
    }
    return { redirect: await createCheckout(env, ws, target, interval, userId), message: 'Redirecting to checkout…' };
  }

  // downgrade between paid plans: the new price applies from the next period
  if (liveStripeSub) {
    const price = await ensurePrice(env, target, interval);
    const sub = await stripeGet(env, `subscriptions/${ws.stripe_subscription_id}`);
    const itemId = sub?.items?.data?.[0]?.id;
    if (itemId) await stripePost(env, `subscriptions/${ws.stripe_subscription_id}`, { 'items[0][id]': itemId, 'items[0][price]': price, proration_behavior: 'none', cancel_at_period_end: 'false' });
  }
  if (!ws.plan_period_end || ws.plan_period_end <= now()) {
    await setPlan(env, ws.id, target.id, interval, { periodEnd: addInterval(now(), interval), actor: userId, note: 'downgrade' });
    return { message: `You are now on ${target.name}.` };
  }
  await run(env, 'UPDATE workspaces SET plan_pending_id = ?, plan_pending_interval = ? WHERE id = ?', target.id, interval, ws.id);
  await logPlatformEvent(env, { workspaceId: ws.id, kind: 'plan_changed', detail: `downgrade to ${target.id} scheduled for ${pendingDate}`, actor: userId });
  return { message: `You'll switch to ${target.name} on ${pendingDate}. ${cur.name} limits stay until then.` };
}

/** Stripe billing portal (update card, invoices). */
export async function billingPortalUrl(env: Env, ws: WorkspaceRow): Promise<string | null> {
  if (!stripeEnabled(env) || !ws.stripe_customer_id) return null;
  const s = await stripePost(env, 'billing_portal/sessions', { customer: ws.stripe_customer_id, return_url: appUrl(env, '/app/settings/plan') });
  return s.url;
}

// ───────── Stripe webhooks ─────────
async function wsForSubscription(env: Env, obj: any, subId: string | null | undefined): Promise<WorkspaceRow | null> {
  if (subId) {
    const ws = await one<WorkspaceRow>(env, 'SELECT * FROM workspaces WHERE stripe_subscription_id = ?', subId);
    if (ws) return ws;
  }
  const wid = obj?.metadata?.platform_workspace_id || obj?.subscription_details?.metadata?.platform_workspace_id || obj?.parent?.subscription_details?.metadata?.platform_workspace_id;
  return wid ? getWorkspace(env, wid) : null;
}

export async function markPastDue(env: Env, ws: WorkspaceRow) {
  const grace = ws.plan_grace_until || now() + LIMITS.GRACE_DAYS * DAY;
  await run(env, `UPDATE workspaces SET plan_status = 'past_due', plan_grace_until = ? WHERE id = ?`, grace, ws.id);
  if (ws.plan_status !== 'past_due') {
    await logPlatformEvent(env, { workspaceId: ws.id, kind: 'payment_failed', detail: `grace until ${new Date(grace).toISOString()}` });
    await notifyOwner(env, ws, 'Your payment failed', `<p>We couldn't charge your card for <strong>${esc(ws.name)}</strong>. Your plan limits stay as they are until <strong>${fmtDate(grace)}</strong>; after that the workspace falls back to Free plan limits until the payment goes through.</p>${button('Update payment method', appUrl(env, '/app/settings/plan'))}`);
  }
}

/** Handle the platform's own Stripe events. Returns true when the event belonged to platform billing. */
export async function handlePlatformStripeEvent(env: Env, evt: any): Promise<boolean> {
  const obj = evt?.data?.object || {};
  switch (evt?.type) {
    case 'checkout.session.completed': {
      const cid = obj.metadata?.platform_checkout_id || (String(obj.client_reference_id || '').startsWith('plan_') ? String(obj.client_reference_id).slice(5) : null);
      if (!cid) return false;
      await completeCheckout(env, cid, { customer: obj.customer, subscription: obj.subscription });
      return true;
    }
    case 'customer.subscription.updated': {
      const ws = await wsForSubscription(env, obj, obj.id);
      if (!ws || (ws.stripe_subscription_id && ws.stripe_subscription_id !== obj.id)) return !!ws;
      const end = periodEndOf(obj);
      if (obj.status === 'past_due' || obj.status === 'unpaid') await markPastDue(env, ws);
      else if (obj.status === 'active' || obj.status === 'trialing') await run(env, `UPDATE workspaces SET plan_status = 'active', plan_grace_until = NULL WHERE id = ?`, ws.id);
      // renewed into a new period: a scheduled downgrade takes effect now
      if (ws.plan_pending_id && ws.plan_pending_id !== FREE_PLAN_ID && end && ws.plan_period_end && end > ws.plan_period_end) {
        await setPlan(env, ws.id, ws.plan_pending_id, (ws.plan_pending_interval as Interval) || 'month', { periodEnd: end, note: 'scheduled downgrade' });
      } else if (end) await run(env, 'UPDATE workspaces SET plan_period_end = ? WHERE id = ?', end, ws.id);
      return true;
    }
    case 'customer.subscription.deleted': {
      const ws = await wsForSubscription(env, obj, obj.id);
      if (!ws) return false;
      if (ws.stripe_subscription_id && ws.stripe_subscription_id !== obj.id) return true; // an old, replaced subscription
      await setPlan(env, ws.id, FREE_PLAN_ID, null, { note: 'subscription ended', stripe: { subscription: null } });
      await notifyOwner(env, ws, 'You are now on the Free plan', `<p>The paid subscription for <strong>${esc(ws.name)}</strong> has ended, so Free plan limits apply. Your publications and subscribers are untouched.</p>${button('See plans', appUrl(env, '/app/settings/plan'))}`);
      return true;
    }
    case 'invoice.payment_failed': {
      const subId = obj.subscription || obj.parent?.subscription_details?.subscription;
      const ws = await wsForSubscription(env, obj, subId);
      if (!ws) return false;
      await markPastDue(env, ws);
      return true;
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      const subId = obj.subscription || obj.parent?.subscription_details?.subscription;
      const ws = await wsForSubscription(env, obj, subId);
      if (!ws) return false;
      await run(env, `UPDATE workspaces SET plan_status = 'active', plan_grace_until = NULL WHERE id = ?`, ws.id);
      return true;
    }
  }
  return false;
}

// ───────── lifecycle (simulated renewals, scheduled downgrades) ─────────
export async function runPlanLifecycle(env: Env) {
  const t = now();
  const due = await all<WorkspaceRow>(env, `SELECT * FROM workspaces WHERE plan_id != 'free' AND plan_period_end IS NOT NULL AND plan_period_end <= ? LIMIT 200`, t);
  for (const ws of due) {
    if (ws.plan_pending_id) {
      const iv = (ws.plan_pending_interval as Interval) || 'month';
      // Stripe already bills the new price (or cancels) — mirror it locally; simulated billing renews at the new price.
      if (ws.plan_pending_id === FREE_PLAN_ID) await setPlan(env, ws.id, FREE_PLAN_ID, null, { note: 'scheduled downgrade', stripe: { subscription: null } });
      else await setPlan(env, ws.id, ws.plan_pending_id, iv, { periodEnd: addInterval(ws.plan_period_end!, iv), note: 'scheduled downgrade' });
    } else if (!ws.stripe_subscription_id) {
      // simulated billing (no Stripe key) or comped period: renew
      await run(env, 'UPDATE workspaces SET plan_period_end = ? WHERE id = ?', addInterval(ws.plan_period_end!, ws.plan_interval || 'month'), ws.id);
    }
  }
}

registerPeriodic('platform.plans', 15 * MIN, runPlanLifecycle);
