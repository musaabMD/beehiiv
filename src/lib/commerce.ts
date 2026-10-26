// Commerce data sync: Shopify, WooCommerce and the creator's own Stripe account push orders, checkouts and customers
// to a per-publication webhook URL (POST /hooks/commerce/<hook_token>). We verify each platform's signature, store
// customers + orders + line items, subscribe buyers ONLY when the platform says they accepted marketing, tag buyers by
// product, track open checkouts for cart abandonment, and enroll subscribers in "external purchase" / "cart abandoned"
// automations. See docs/COMMERCE.md.
import { triggerList } from './automations';
import type { Env, Publication, Subscriber } from '../types';
import { one, all, run, insert } from './db';
import { emit } from './events';
import { registerPeriodic, logError } from './jobs';
import { subscribe, addTags } from './subscribers';
import { enroll } from './automations';
import { subscriberMatches, type RuleGroup } from './segments';
import { getPub } from './pub';
import { id, now, token, slugify, parseJSON, safeEqual, hex, esc, money, MIN, HOUR, DAY } from './util';

export type Platform = 'shopify' | 'woocommerce' | 'stripe';

export const PLATFORMS: Record<Platform, { name: string; secretLabel: string; secretHint: string; events: string[]; setup: string[] }> = {
  shopify: {
    name: 'Shopify',
    secretLabel: 'Webhook signing secret',
    secretHint: 'Shopify admin → Settings → Notifications → Webhooks: the key shown under "Your webhooks will be signed with…". For an app, use the app\'s client secret.',
    events: ['orders/create', 'orders/paid', 'checkouts/create', 'checkouts/update', 'customers/create'],
    setup: ['Shopify admin → Settings → Notifications → Webhooks → Create webhook.', 'Create one webhook per event below, format JSON, pointing at the URL shown here.', 'Copy the signing key Shopify shows on that page and paste it here.'],
  },
  woocommerce: {
    name: 'WooCommerce',
    secretLabel: 'Webhook secret',
    secretHint: 'The "Secret" you typed when creating the webhook in WooCommerce → Settings → Advanced → Webhooks.',
    events: ['order.created', 'order.updated', 'customer.created'],
    setup: ['WooCommerce → Settings → Advanced → Webhooks → Add webhook.', 'Status Active, one webhook per topic below, Delivery URL = the URL shown here, API version WP REST API v3.', 'Use the same secret for all of them and paste it here.'],
  },
  stripe: {
    name: 'Stripe (your own account)',
    secretLabel: 'Endpoint signing secret (whsec_…)',
    secretHint: 'Stripe Dashboard → Developers → Webhooks → your endpoint → Signing secret. This is your own Stripe account, separate from paid-subscription checkout.',
    events: ['checkout.session.completed', 'charge.succeeded', 'customer.created'],
    setup: ['Stripe Dashboard → Developers → Webhooks → Add endpoint with the URL shown here.', 'Select the events below.', 'Reveal the endpoint\'s signing secret and paste it here.', 'Optional: set metadata product_id / product_name on Payment Links or Checkout Sessions so purchases are tagged by product, and enable "consent collection → promotions" so buyers can opt in to your newsletter.'],
  },
};

export interface StoreConfig { abandon_hours?: number; tag_buyers?: boolean; tag_prefix?: string }
export interface Store { id: string; pub_id: string; platform: Platform; name: string; store_url: string | null; secret: string; hook_token: string; config: string; active: number; events_count: number; last_event_at: number | null; created_at: number }

export const storeConfig = (s: Pick<Store, 'config'>): Required<StoreConfig> => {
  const c = parseJSON<StoreConfig>(s.config, {});
  return { abandon_hours: Number(c.abandon_hours) > 0 ? Number(c.abandon_hours) : 1, tag_buyers: c.tag_buyers !== false, tag_prefix: c.tag_prefix ?? 'bought-' };
};

export function hookUrl(env: Env, store: Pick<Store, 'hook_token'>): string {
  return `${env.APP_URL.replace(/\/$/, '')}/hooks/commerce/${store.hook_token}`;
}

export async function connectStore(env: Env, pubId: string, platform: Platform, f: { secret: string; name?: string; store_url?: string; config?: StoreConfig }): Promise<Store> {
  const existing = await one<Store>(env, 'SELECT * FROM commerce_stores WHERE pub_id = ? AND platform = ?', pubId, platform);
  const config = JSON.stringify({ ...parseJSON(existing?.config, {}), ...(f.config || {}) });
  if (existing) {
    await run(env, 'UPDATE commerce_stores SET secret = ?, name = ?, store_url = ?, config = ?, active = 1 WHERE id = ?', f.secret || existing.secret, f.name ?? existing.name, f.store_url ?? existing.store_url, config, existing.id);
  } else {
    await insert(env, 'commerce_stores', { id: id(), pub_id: pubId, platform, name: f.name || PLATFORMS[platform].name, store_url: f.store_url || null, secret: f.secret, hook_token: `${platform.slice(0, 2)}_${token(18)}`, config, active: 1, events_count: 0, created_at: now() });
  }
  return (await one<Store>(env, 'SELECT * FROM commerce_stores WHERE pub_id = ? AND platform = ?', pubId, platform))!;
}

// ───────────────────────── signatures ─────────────────────────
async function hmacBytes(secret: string, msg: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

/** Shopify: X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(secret, raw body)). WooCommerce: X-WC-Webhook-Signature, same scheme. */
export async function verifyBase64Hmac(secret: string, raw: string, sig: string | null | undefined): Promise<boolean> {
  if (!sig || !secret) return false;
  return safeEqual(b64(await hmacBytes(secret, raw)), sig.trim());
}

/** Stripe: Stripe-Signature "t=<unix>,v1=<hex hmac of `${t}.${body}`>" (any v1 may match), 5-minute tolerance. */
export async function verifyStripe(secret: string, raw: string, header: string | null | undefined, toleranceSec = 300, at = now()): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const v1 = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !v1.length) return false;
  if (Math.abs(at / 1000 - Number(t)) > toleranceSec) return false;
  const expected = hex((await hmacBytes(secret, `${t}.${raw}`)).buffer as ArrayBuffer);
  return v1.some((v) => safeEqual(v, expected));
}

// ───────────────────────── normalized shapes ─────────────────────────
export interface Item { product_id: string | null; sku: string | null; name: string; quantity: number; price_cents: number; image?: string | null }
export interface NormCustomer { email: string; name: string; externalId: string | null; acceptsMarketing: boolean | null }
export interface NormOrder { externalId: string; number: string | null; email: string; name: string; status: 'pending' | 'paid' | 'refunded' | 'cancelled'; totalCents: number; currency: string; items: Item[] | null; checkoutRef: string | null; recoveryUrl: string | null; paidAt: number | null; customer: NormCustomer }
export interface NormCart { externalId: string; email: string; name: string; totalCents: number; currency: string; items: Item[]; recoveryUrl: string | null; completed: boolean; updatedAt: number; customer: NormCustomer }
export interface Parsed { order?: NormOrder; cart?: NormCart; customer?: NormCustomer; ignored?: string }

const cents = (v: unknown) => Math.round((parseFloat(String(v ?? '0')) || 0) * 100);
const lc = (v: unknown) => String(v || '').trim().toLowerCase();
const ts = (v: unknown) => { const t = Date.parse(String(v || '')); return isNaN(t) ? null : t; };
const fullName = (a?: any) => [a?.first_name, a?.last_name].filter(Boolean).join(' ').trim();
const truthy = (v: unknown) => v === true || /^(1|true|yes|on|subscribed|opt_in|opted_in)$/i.test(String(v ?? ''));

function shopifyConsent(j: any): boolean | null {
  const c = j?.customer || {};
  const state = c.email_marketing_consent?.state ?? j?.email_marketing_consent?.state;
  if (state) return state === 'subscribed';
  if (typeof j?.buyer_accepts_marketing === 'boolean' && j.buyer_accepts_marketing) return true;
  if (typeof c.accepts_marketing === 'boolean') return c.accepts_marketing;
  if (typeof j?.accepts_marketing === 'boolean') return j.accepts_marketing;
  if (typeof j?.buyer_accepts_marketing === 'boolean') return j.buyer_accepts_marketing;
  return null;
}

const shopifyItems = (j: any): Item[] => (j?.line_items || []).map((l: any) => ({ product_id: l.product_id != null ? String(l.product_id) : null, sku: l.sku || null, name: String(l.title || l.name || 'Item'), quantity: Number(l.quantity) || 1, price_cents: cents(l.price), image: l.image_url || l.image?.src || null }));

export function parseShopify(topic: string, j: any): Parsed {
  if (topic.startsWith('orders/')) {
    const fin = String(j.financial_status || '');
    const status: NormOrder['status'] = j.cancelled_at ? 'cancelled' : /^(paid|partially_paid|partially_refunded)$/.test(fin) || topic === 'orders/paid' ? 'paid' : fin === 'refunded' ? 'refunded' : fin === 'voided' ? 'cancelled' : 'pending';
    const email = lc(j.email || j.contact_email || j.customer?.email);
    const name = fullName(j.customer) || fullName(j.billing_address);
    return { order: { externalId: String(j.id), number: j.name || (j.order_number != null ? String(j.order_number) : null), email, name, status, totalCents: cents(j.current_total_price ?? j.total_price), currency: lc(j.currency || 'usd'), items: shopifyItems(j), checkoutRef: j.checkout_token || j.cart_token || null, recoveryUrl: null, paidAt: status === 'paid' ? ts(j.processed_at) || now() : null, customer: { email, name, externalId: j.customer?.id != null ? String(j.customer.id) : null, acceptsMarketing: shopifyConsent(j) } } };
  }
  if (topic.startsWith('checkouts/')) {
    const email = lc(j.email || j.customer?.email);
    const name = fullName(j.customer) || fullName(j.billing_address);
    return { cart: { externalId: String(j.token || j.id), email, name, totalCents: cents(j.total_price), currency: lc(j.presentment_currency || j.currency || 'usd'), items: shopifyItems(j), recoveryUrl: j.abandoned_checkout_url || null, completed: !!j.completed_at, updatedAt: ts(j.updated_at) || now(), customer: { email, name, externalId: j.customer?.id != null ? String(j.customer.id) : null, acceptsMarketing: shopifyConsent(j) } } };
  }
  if (topic.startsWith('customers/')) {
    return { customer: { email: lc(j.email), name: fullName(j), externalId: j.id != null ? String(j.id) : null, acceptsMarketing: shopifyConsent({ customer: j }) } };
  }
  return { ignored: `topic ${topic}` };
}

function wooConsent(j: any): boolean | null {
  // WooCommerce core has no consent field; newsletter/opt-in plugins store it in order/customer meta.
  for (const m of j?.meta_data || []) {
    if (/marketing|newsletter|subscribe|opt.?in|consent/i.test(String(m?.key || ''))) return truthy(m.value);
  }
  return null;
}

export function parseWoo(topic: string, j: any): Parsed {
  if (topic.startsWith('order.')) {
    const st = String(j.status || '');
    const status: NormOrder['status'] = st === 'processing' || st === 'completed' ? 'paid' : st === 'refunded' ? 'refunded' : st === 'cancelled' || st === 'failed' || st === 'trash' ? 'cancelled' : 'pending';
    const email = lc(j.billing?.email);
    const name = fullName(j.billing);
    const items: Item[] = (j.line_items || []).map((l: any) => ({ product_id: l.product_id != null ? String(l.product_id) : null, sku: l.sku || null, name: String(l.name || 'Item'), quantity: Number(l.quantity) || 1, price_cents: l.price != null ? cents(l.price) : Math.round(cents(l.total) / (Number(l.quantity) || 1)), image: l.image?.src || null }));
    const order: NormOrder = { externalId: String(j.id), number: j.number != null ? String(j.number) : null, email, name, status, totalCents: cents(j.total), currency: lc(j.currency || 'usd'), items, checkoutRef: j.order_key || String(j.id), recoveryUrl: j.payment_url || null, paidAt: status === 'paid' ? ts(j.date_paid_gmt ? j.date_paid_gmt + 'Z' : j.date_paid) || now() : null, customer: { email, name, externalId: j.customer_id ? String(j.customer_id) : null, acceptsMarketing: wooConsent(j) } };
    // An unpaid ("pending payment") order is WooCommerce's equivalent of an open checkout.
    const cart: NormCart | undefined = status === 'pending' || status === 'paid' ? { externalId: String(j.id), email, name, totalCents: order.totalCents, currency: order.currency, items, recoveryUrl: order.recoveryUrl, completed: status === 'paid', updatedAt: ts(j.date_modified_gmt ? j.date_modified_gmt + 'Z' : j.date_modified) || now(), customer: order.customer } : undefined;
    return { order, cart };
  }
  if (topic.startsWith('customer.')) return { customer: { email: lc(j.email || j.billing?.email), name: fullName(j) || fullName(j.billing), externalId: j.id != null ? String(j.id) : null, acceptsMarketing: wooConsent(j) } };
  return { ignored: `topic ${topic}` };
}

export function parseStripe(type: string, o: any): Parsed {
  const meta = o?.metadata || {};
  const metaConsent = meta.accepts_marketing ?? meta.newsletter ?? meta.marketing_consent;
  const item = (amount: number, fallback: string): Item[] => [{ product_id: meta.product_id || null, sku: meta.sku || null, name: String(meta.product_name || meta.product || fallback), quantity: Number(meta.quantity) || 1, price_cents: amount }];
  if (type === 'checkout.session.completed') {
    const email = lc(o.customer_details?.email || o.customer_email);
    const name = String(o.customer_details?.name || '');
    const paid = o.payment_status === 'paid' || o.payment_status === 'no_payment_required';
    const consent = o.consent?.promotions ? o.consent.promotions === 'opt_in' : metaConsent != null ? truthy(metaConsent) : null;
    const amount = Number(o.amount_total) || 0;
    return { order: { externalId: String(o.payment_intent || o.invoice || o.id), number: o.id, email, name, status: paid ? 'paid' : 'pending', totalCents: amount, currency: lc(o.currency || 'usd'), items: item(amount, 'Stripe checkout'), checkoutRef: o.id, recoveryUrl: null, paidAt: paid ? (Number(o.created) * 1000 || now()) : null, customer: { email, name, externalId: o.customer || null, acceptsMarketing: consent } } };
  }
  if (type === 'charge.succeeded') {
    const email = lc(o.billing_details?.email || o.receipt_email);
    const name = String(o.billing_details?.name || '');
    const amount = Number(o.amount_captured ?? o.amount) || 0;
    return { order: { externalId: String(o.payment_intent || o.invoice || o.id), number: o.id, email, name, status: o.paid === false ? 'pending' : o.refunded ? 'refunded' : 'paid', totalCents: amount, currency: lc(o.currency || 'usd'), items: meta.product_id || meta.product_name || meta.product ? item(amount, 'Stripe payment') : null, checkoutRef: null, recoveryUrl: null, paidAt: Number(o.created) * 1000 || now(), customer: { email, name, externalId: o.customer || null, acceptsMarketing: metaConsent != null ? truthy(metaConsent) : null } } };
  }
  if (type === 'customer.created') return { customer: { email: lc(o.email), name: String(o.name || ''), externalId: o.id || null, acceptsMarketing: metaConsent != null ? truthy(metaConsent) : null } };
  return { ignored: `event ${type}` };
}

// ───────────────────────── persistence ─────────────────────────
/** Upsert the customer record and, only when they accepted marketing, subscribe them. Returns the linked subscriber. */
async function syncCustomer(env: Env, pub: Publication, store: Store, c: NormCustomer): Promise<{ customerId: string; subscriber: Subscriber | null } | null> {
  if (!c.email || !c.email.includes('@')) return null;
  const t = now();
  await run(env,
    `INSERT INTO commerce_customers (id, pub_id, platform, external_id, email, name, accepts_marketing, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(pub_id, platform, email) DO UPDATE SET external_id = COALESCE(excluded.external_id, external_id), name = CASE WHEN excluded.name != '' THEN excluded.name ELSE name END,
       accepts_marketing = CASE WHEN ? IS NULL THEN accepts_marketing ELSE excluded.accepts_marketing END, updated_at = excluded.updated_at`,
    id(), pub.id, store.platform, c.externalId, c.email, c.name.slice(0, 120), c.acceptsMarketing ? 1 : 0, t, t, c.acceptsMarketing === null ? null : 1);
  const cust = (await one<{ id: string; accepts_marketing: number }>(env, 'SELECT id, accepts_marketing FROM commerce_customers WHERE pub_id = ? AND platform = ? AND email = ?', pub.id, store.platform, c.email))!;
  let sub = await one<Subscriber>(env, 'SELECT * FROM subscribers WHERE pub_id = ? AND email = ?', pub.id, c.email);
  // Consent: only an explicit "accepted marketing" from the platform creates (or confirms a pending) subscriber.
  // Everyone else stays a customer contact: purchase history is kept, but they are never emailed.
  if (cust.accepts_marketing && (!sub || sub.status === 'pending')) {
    const r = await subscribe(env, pub, { email: c.email, name: c.name, source: 'commerce', sourceDetail: store.platform, skipConfirm: true, tags: [`customer-${store.platform}`] });
    if (r.ok && r.subscriber) sub = r.subscriber;
  }
  if (sub) await run(env, 'UPDATE commerce_customers SET subscriber_id = ? WHERE id = ?', sub.id, cust.id);
  return { customerId: cust.id, subscriber: sub };
}

async function refreshCustomerTotals(env: Env, pubId: string, platform: string, email: string) {
  await run(env,
    `UPDATE commerce_customers SET orders_count = (SELECT COUNT(*) FROM external_orders o WHERE o.pub_id = ?1 AND o.platform = ?2 AND o.email = ?3 AND o.status = 'paid'),
      total_spent_cents = (SELECT COALESCE(SUM(total_cents), 0) FROM external_orders o WHERE o.pub_id = ?1 AND o.platform = ?2 AND o.email = ?3 AND o.status = 'paid'),
      currency = COALESCE((SELECT currency FROM external_orders o WHERE o.pub_id = ?1 AND o.platform = ?2 AND o.email = ?3 ORDER BY created_at DESC LIMIT 1), currency),
      first_order_at = (SELECT MIN(paid_at) FROM external_orders o WHERE o.pub_id = ?1 AND o.platform = ?2 AND o.email = ?3 AND o.status = 'paid'),
      last_order_at = (SELECT MAX(paid_at) FROM external_orders o WHERE o.pub_id = ?1 AND o.platform = ?2 AND o.email = ?3 AND o.status = 'paid')
     WHERE pub_id = ?1 AND platform = ?2 AND email = ?3`, pubId, platform, email);
}

export async function processOrder(env: Env, pub: Publication, store: Store, o: NormOrder): Promise<string> {
  const link = await syncCustomer(env, pub, store, o.customer);
  const sub = link?.subscriber || null;
  const t = now();
  const prev = await one<{ id: string; status: string }>(env, 'SELECT id, status FROM external_orders WHERE pub_id = ? AND platform = ? AND external_id = ?', pub.id, store.platform, o.externalId);
  const oid = prev?.id || id();
  // Never downgrade a paid order back to pending (webhooks arrive out of order: orders/paid can beat orders/create).
  const status = prev?.status === 'paid' && o.status === 'pending' ? 'paid' : o.status;
  if (prev) {
    await run(env, `UPDATE external_orders SET status = ?, email = CASE WHEN ? != '' THEN ? ELSE email END, name = CASE WHEN ? != '' THEN ? ELSE name END, subscriber_id = COALESCE(?, subscriber_id), customer_id = COALESCE(?, customer_id),
      total_cents = CASE WHEN ? > 0 THEN ? ELSE total_cents END, currency = ?, order_number = COALESCE(?, order_number), checkout_ref = COALESCE(?, checkout_ref), paid_at = COALESCE(paid_at, ?), updated_at = ? WHERE id = ?`,
      status, o.email, o.email, o.name, o.name, sub?.id ?? null, link?.customerId ?? null, o.totalCents, o.totalCents, o.currency, o.number, o.checkoutRef, status === 'paid' ? o.paidAt || t : null, t, oid);
  } else {
    await insert(env, 'external_orders', { id: oid, pub_id: pub.id, store_id: store.id, platform: store.platform, external_id: o.externalId, order_number: o.number, email: o.email, name: o.name.slice(0, 120), subscriber_id: sub?.id ?? null, customer_id: link?.customerId ?? null, status, total_cents: o.totalCents, currency: o.currency, checkout_ref: o.checkoutRef, paid_at: status === 'paid' ? o.paidAt || t : null, created_at: t, updated_at: t });
  }
  if (o.items && o.items.length) {
    await run(env, 'DELETE FROM external_order_items WHERE order_id = ?', oid);
    for (const it of o.items.slice(0, 100)) await insert(env, 'external_order_items', { id: id(), order_id: oid, pub_id: pub.id, platform: store.platform, product_id: it.product_id, sku: it.sku, name: it.name.slice(0, 200), quantity: it.quantity, price_cents: it.price_cents });
  }
  if (o.email) await refreshCustomerTotals(env, pub.id, store.platform, o.email);
  const becamePaid = status === 'paid' && prev?.status !== 'paid';
  if (becamePaid) await onExternalPaid(env, pub, store, oid, o, sub);
  return becamePaid ? `order ${status} (new)` : `order ${status}`;
}

async function onExternalPaid(env: Env, pub: Publication, store: Store, orderId: string, o: NormOrder, sub: Subscriber | null) {
  await recoverCarts(env, pub.id, store.platform, o.checkoutRef, o.email, orderId);
  const items = await all<Item>(env, 'SELECT product_id, sku, name, quantity, price_cents FROM external_order_items WHERE order_id = ?', orderId);
  const data = { platform: store.platform, order_id: orderId, external_id: o.externalId, order_number: o.number, total_cents: o.totalCents, currency: o.currency, product_ids: items.map((i) => i.product_id).filter(Boolean), product_names: items.map((i) => i.name) };
  if (!sub) return;
  const cfg = storeConfig(store);
  if (cfg.tag_buyers) await addTags(env, pub.id, sub.id, [`customer-${store.platform}`, ...items.map((i) => cfg.tag_prefix + slugify(i.name, 40)).filter((t) => t !== cfg.tag_prefix)]);
  await emit(env, { pubId: pub.id, type: 'commerce.order_paid', subscriberId: sub.id, refId: orderId, data });
  if (['active'].includes(sub.status)) await enrollPurchase(env, pub.id, sub.id, data);
}

/** Enroll in automations whose trigger is "external_purchase" (honoring platform / product / minimum filters) or the
 *  catch-all "purchase" trigger without a specific product. Trigger matching lives here, not in the engine. */
async function enrollPurchase(env: Env, pubId: string, subId: string, d: { platform: string; total_cents: number; product_names: string[]; product_ids: any[]; [k: string]: unknown }) {
  const autos = await all<{ id: string; trigger: string }>(env, `SELECT id, trigger FROM automations WHERE pub_id = ? AND status = 'active'`, pubId);
  for (const a of autos) for (const trig of triggerList(parseJSON<any>(a.trigger, {}))) {
    const c = trig.config || {};
    if (trig.type === 'external_purchase') {
      if (c.platform && c.platform !== d.platform) continue;
      if (c.product_contains) {
        const q = String(c.product_contains).toLowerCase();
        if (!d.product_names.some((n) => n.toLowerCase().includes(q)) && !d.product_ids.some((p) => String(p) === String(c.product_contains))) continue;
      }
      if (Number(c.min_total) > 0 && d.total_cents < Number(c.min_total) * 100) continue;
    } else if (!(trig.type === 'purchase' && !c.product_id)) continue;
    if (trig.filter?.rules?.length && !(await subscriberMatches(env, pubId, trig.filter as RuleGroup, subId))) continue;
    await enroll(env, a.id, subId, { trigger: 'external_purchase', ...d });
  }
}

export async function processCart(env: Env, pub: Publication, store: Store, c: NormCart): Promise<string> {
  const t = now();
  const prev = await one<{ id: string; status: string }>(env, 'SELECT id, status FROM abandoned_carts WHERE pub_id = ? AND platform = ? AND external_id = ?', pub.id, store.platform, c.externalId);
  if (c.completed) {
    if (prev) await recoverCarts(env, pub.id, store.platform, c.externalId, '', null);
    return 'checkout completed';
  }
  if (prev && prev.status !== 'open' && prev.status !== 'abandoned') return `checkout ${prev.status}`;
  // Linking a subscriber here never creates one: abandonment emails only go to people who are already subscribers
  // (or who accepted marketing in this checkout).
  const link = c.email ? await syncCustomer(env, pub, store, c.customer) : null;
  const row = { email: c.email, name: c.name.slice(0, 120), subscriber_id: link?.subscriber?.id ?? null, total_cents: c.totalCents, currency: c.currency, items: JSON.stringify(c.items.slice(0, 50)), recovery_url: c.recoveryUrl, checkout_updated_at: c.updatedAt, updated_at: t };
  if (prev) {
    // a cart that changed after being marked abandoned is open again (fresh timer)
    await run(env, `UPDATE abandoned_carts SET email = CASE WHEN ? != '' THEN ? ELSE email END, name = ?, subscriber_id = COALESCE(?, subscriber_id), total_cents = ?, currency = ?, items = ?, recovery_url = COALESCE(?, recovery_url), checkout_updated_at = ?, status = 'open', updated_at = ? WHERE id = ?`,
      row.email, row.email, row.name, row.subscriber_id, row.total_cents, row.currency, row.items, row.recovery_url, row.checkout_updated_at, t, prev.id);
  } else {
    await insert(env, 'abandoned_carts', { id: id(), pub_id: pub.id, store_id: store.id, platform: store.platform, external_id: c.externalId, ...row, status: 'open', created_at: t });
  }
  return prev ? 'checkout updated' : 'checkout tracked';
}

/** An order completed: its cart (by checkout ref, else this buyer's open carts) is recovered and pending
 *  cart-abandonment journeys for it stop. */
export async function recoverCarts(env: Env, pubId: string, platform: string, ref: string | null, email: string, orderId: string | null) {
  const carts = await all<{ id: string }>(env, `SELECT id FROM abandoned_carts WHERE pub_id = ? AND platform = ? AND status IN ('open','abandoned') AND (external_id = ? OR (? != '' AND email = ?))`, pubId, platform, ref || '', email, email);
  for (const c of carts) {
    await run(env, `UPDATE abandoned_carts SET status = 'recovered', recovered_at = ?, order_id = ?, updated_at = ? WHERE id = ?`, now(), orderId, now(), c.id);
    const runs = await all<{ id: string; automation_id: string }>(env, `SELECT id, automation_id FROM automation_runs WHERE pub_id = ? AND status IN ('active','waiting') AND json_extract(data, '$.cart_id') = ?`, pubId, c.id);
    for (const r of runs) {
      await run(env, `UPDATE automation_runs SET status = 'exited', next_run_at = NULL, updated_at = ? WHERE id = ?`, now(), r.id);
      await insert(env, 'automation_logs', { id: id(), run_id: r.id, automation_id: r.automation_id, step_id: null, action: 'exited', result: 'cart recovered: order completed', created_at: now() });
    }
  }
  return carts.length;
}

export async function processCustomerOnly(env: Env, pub: Publication, store: Store, c: NormCustomer): Promise<string> {
  const r = await syncCustomer(env, pub, store, c);
  return r ? (r.subscriber ? 'customer linked to subscriber' : 'customer stored (no marketing consent)') : 'customer without email';
}

// ───────────────────────── webhook entry ─────────────────────────
async function logEvent(env: Env, store: Store, topic: string, dedupe: string | null, status: string, detail: string): Promise<string | null> {
  const eid = id();
  try {
    await insert(env, 'commerce_events', { id: eid, pub_id: store.pub_id, store_id: store.id, platform: store.platform, topic: topic.slice(0, 80), dedupe_key: dedupe, status, detail: detail.slice(0, 500), created_at: now() });
    return eid;
  } catch (e: any) {
    if (/UNIQUE/i.test(String(e?.message))) return null; // already received this delivery
    throw e;
  }
}

export async function handleCommerceWebhook(env: Env, hookToken: string, h: Headers, raw: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const store = await one<Store>(env, 'SELECT * FROM commerce_stores WHERE hook_token = ?', hookToken);
  if (!store || !store.active) return { status: 404, body: { error: 'unknown endpoint' } };
  const pub = await getPub(env, store.pub_id);
  if (!pub || pub.status === 'deleted') return { status: 404, body: { error: 'unknown endpoint' } };
  let topic = '', dedupe: string | null = null, valid = false, payload: any = null;
  if (store.platform === 'shopify') {
    topic = h.get('x-shopify-topic') || '';
    dedupe = h.get('x-shopify-webhook-id') || h.get('x-shopify-event-id');
    valid = await verifyBase64Hmac(store.secret, raw, h.get('x-shopify-hmac-sha256'));
  } else if (store.platform === 'woocommerce') {
    topic = h.get('x-wc-webhook-topic') || '';
    dedupe = h.get('x-wc-webhook-delivery-id');
    // WooCommerce pings a new webhook with "webhook_id=<n>" (form-encoded, unsigned) to check the URL.
    if (!topic && /^webhook_id=\d+$/.test(raw.trim())) return { status: 200, body: { ok: true, ping: true } };
    valid = await verifyBase64Hmac(store.secret, raw, h.get('x-wc-webhook-signature'));
  } else {
    valid = await verifyStripe(store.secret, raw, h.get('stripe-signature'));
  }
  if (!valid) {
    await logEvent(env, store, topic || 'unknown', null, 'invalid_signature', 'signature did not verify — check the signing secret');
    return { status: 401, body: { error: 'invalid signature' } };
  }
  try { payload = JSON.parse(raw); } catch { await logEvent(env, store, topic, null, 'error', 'body is not JSON'); return { status: 400, body: { error: 'invalid JSON' } }; }
  if (store.platform === 'stripe') { topic = String(payload?.type || ''); dedupe = payload?.id ? String(payload.id) : null; }
  const eid = await logEvent(env, store, topic, dedupe, 'processing', '');
  if (!eid) return { status: 200, body: { ok: true, duplicate: true } };
  await run(env, 'UPDATE commerce_stores SET events_count = events_count + 1, last_event_at = ? WHERE id = ?', now(), store.id);
  try {
    const p: Parsed = store.platform === 'shopify' ? parseShopify(topic, payload) : store.platform === 'woocommerce' ? parseWoo(topic, payload) : parseStripe(topic, payload?.data?.object || {});
    const out: string[] = [];
    if (p.ignored) out.push('ignored ' + p.ignored);
    if (p.order) out.push(await processOrder(env, pub, store, p.order));
    if (p.cart) out.push(await processCart(env, pub, store, p.cart));
    if (p.customer) out.push(await processCustomerOnly(env, pub, store, p.customer));
    await run(env, 'UPDATE commerce_events SET status = ?, detail = ? WHERE id = ?', p.ignored ? 'ignored' : 'processed', out.join('; ').slice(0, 500), eid);
    return { status: 200, body: { ok: true, result: out } };
  } catch (e: any) {
    // free the dedupe key so the platform's retry is processed
    await run(env, `UPDATE commerce_events SET status = 'error', dedupe_key = NULL, detail = ? WHERE id = ?`, String(e?.message || e).slice(0, 500), eid);
    await logError(env, 'commerce:' + store.platform, e, store.pub_id);
    return { status: 500, body: { error: 'processing failed' } };
  }
}

// ───────────────────────── cart abandonment ─────────────────────────
/** Mark stale open checkouts abandoned (store's abandon_hours, default 1h) and enroll subscribers in
 *  "cart abandoned" automations after each automation's own delay_hours / min_value. */
export async function cartTick(env: Env, at = now()) {
  const stores = await all<Store>(env, 'SELECT * FROM commerce_stores WHERE active = 1');
  for (const s of stores) {
    const cutoff = at - storeConfig(s).abandon_hours * HOUR;
    const due = await all<any>(env, `SELECT * FROM abandoned_carts WHERE store_id = ? AND status = 'open' AND checkout_updated_at <= ? AND email != '' LIMIT 200`, s.id, cutoff);
    for (const c of due) {
      await run(env, `UPDATE abandoned_carts SET status = 'abandoned', abandoned_at = ?, updated_at = ? WHERE id = ? AND status = 'open'`, at, at, c.id);
      await emit(env, { pubId: c.pub_id, type: 'cart.abandoned', subscriberId: c.subscriber_id, refId: c.id, data: cartEventData(c) });
    }
  }
  // Any entry point of an automation can be the cart trigger (automations can have several).
  const autos = await all<{ id: string; pub_id: string; trigger: string }>(env, `SELECT id, pub_id, trigger FROM automations WHERE status = 'active' AND instr(trigger, 'cart_abandoned') > 0`);
  for (const a of autos) for (const trig of triggerList(parseJSON<any>(a.trigger, {})).filter((t) => t.type === 'cart_abandoned')) {
    const c = trig.config || {};
    const delay = Number(c.delay_hours) > 0 ? Number(c.delay_hours) : 1;
    const min = Math.round((Number(c.min_value) || 0) * 100);
    const carts = await all<any>(env,
      `SELECT ac.* FROM abandoned_carts ac JOIN subscribers s ON s.id = ac.subscriber_id
       WHERE ac.pub_id = ? AND ac.status IN ('open','abandoned') AND ac.checkout_updated_at <= ? AND ac.checkout_updated_at > ? AND ac.total_cents >= ? AND s.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM automation_runs ar WHERE ar.automation_id = ? AND json_extract(ar.data, '$.cart_id') = ac.id) LIMIT 200`,
      a.pub_id, at - delay * HOUR, at - 14 * DAY, min, a.id);
    for (const cart of carts) {
      if (trig.filter?.rules?.length && !(await subscriberMatches(env, a.pub_id, trig.filter as RuleGroup, cart.subscriber_id))) continue;
      await enroll(env, a.id, cart.subscriber_id, { trigger: 'cart_abandoned', ...cartEventData(cart) }, { allowReentry: true });
    }
  }
  await run(env, `UPDATE abandoned_carts SET status = 'expired', updated_at = ? WHERE status IN ('open','abandoned') AND checkout_updated_at < ?`, at, at - 30 * DAY);
}

function cartEventData(c: any) {
  const items = parseJSON<Item[]>(c.items, []);
  return { cart_id: c.id, platform: c.platform, total_cents: c.total_cents, currency: c.currency, recovery_url: c.recovery_url, items: items.map((i) => ({ name: i.name, quantity: i.quantity, price_cents: i.price_cents })) };
}

registerPeriodic('commerce.carts', 5 * MIN, (env) => cartTick(env));

// ───────────────────────── {{cart.*}} merge tags ─────────────────────────
const SAMPLE_CART = { platform: 'shopify', total_cents: 5800, currency: 'usd', recovery_url: 'https://example.com/cart', items: JSON.stringify([{ name: 'Sample product', quantity: 1, price_cents: 3900 }, { name: 'Another product', quantity: 1, price_cents: 1900 }]) };

/** Replace {{cart.items}} (an email-safe table), {{cart.recovery_url}}, {{cart.total}}, {{cart.item_count}},
 *  {{cart.first_item}} with the subscriber's latest abandoned cart. Called from lib/render before merge tags. */
export async function renderCartTags(env: Env, pub: Publication, sub: Subscriber | null | undefined, html: string): Promise<string> {
  if (!html.includes('{{cart.')) return html;
  const cart = sub?.id
    ? await one<any>(env, `SELECT * FROM abandoned_carts WHERE pub_id = ? AND (subscriber_id = ? OR email = ?) AND status IN ('open','abandoned') ORDER BY checkout_updated_at DESC LIMIT 1`, pub.id, sub.id, sub.email)
    : SAMPLE_CART;
  const items = parseJSON<Item[]>(cart?.items, []);
  const cur = cart?.currency || 'usd';
  const table = items.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-collapse:collapse">${items.map((i) => `<tr>${i.image ? `<td width="64" style="padding:8px 8px 8px 0;border-bottom:1px solid #e5e7eb"><img src="${esc(i.image)}" width="56" alt="" style="display:block;border-radius:6px"></td>` : ''}<td style="padding:8px 0;border-bottom:1px solid #e5e7eb">${esc(i.name)}${i.quantity > 1 ? ` × ${i.quantity}` : ''}</td><td align="right" style="padding:8px 0;border-bottom:1px solid #e5e7eb;white-space:nowrap">${esc(money(i.price_cents * (i.quantity || 1), cur))}</td></tr>`).join('')}<tr><td${items.some((i) => i.image) ? ' colspan="2"' : ''} style="padding:8px 0;font-weight:700">Total</td><td align="right" style="padding:8px 0;font-weight:700">${esc(money(cart?.total_cents || 0, cur))}</td></tr></table>`
    : '';
  const vars: Record<string, string> = {
    'cart.recovery_url': cart?.recovery_url || '',
    'cart.total': cart ? money(cart.total_cents || 0, cur) : '',
    'cart.item_count': String(items.reduce((n, i) => n + (i.quantity || 1), 0)),
    'cart.first_item': items[0]?.name || '',
    'cart.platform': cart?.platform || '',
  };
  return html
    .replace(/\{\{\s*cart\.items\s*\}\}/g, table)
    .replace(/\{\{\s*(cart\.[a-z_]+)\s*(?:\|\s*([^}]*?))?\s*\}\}/g, (_, k: string, fb?: string) => esc(vars[k] || fb || ''));
}

// ───────────────────────── reads for UI ─────────────────────────
export async function purchasesFor(env: Env, pubId: string, email: string) {
  return all<any>(env, `SELECT o.*, (SELECT GROUP_CONCAT(i.name || CASE WHEN i.quantity > 1 THEN ' ×' || i.quantity ELSE '' END, ', ') FROM external_order_items i WHERE i.order_id = o.id) AS items FROM external_orders o WHERE o.pub_id = ? AND o.email = ? ORDER BY o.created_at DESC LIMIT 50`, pubId, email.toLowerCase());
}

export async function externalRevenue(env: Env, pubId: string, from: number, to: number) {
  return all<{ platform: string; orders: number; revenue: number; currency: string }>(env, `SELECT platform, COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS revenue, MAX(currency) AS currency FROM external_orders WHERE pub_id = ? AND status = 'paid' AND paid_at >= ? AND paid_at < ? GROUP BY platform ORDER BY revenue DESC`, pubId, from, to);
}
