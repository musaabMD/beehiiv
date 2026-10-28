// Revenue attribution: every paid order — our own checkout (subscriptions, products, tickets, gifts…) and store orders
// synced from Shopify / WooCommerce / Stripe (lib/commerce) — is credited to the emails the buyer clicked before buying.
//
// A "touch" is one email the buyer clicked (bot-filtered) within the attribution window before the order
// (default 7 days, per publication): a newsletter post, an automation email (per step) or a tracked transactional message.
// Three models are stored side by side so reports can switch without recomputing:
//   last_click   100% to the email clicked most recently before the order
//   first_touch  100% to the earliest email clicked inside the window
//   linear       split evenly across every email clicked inside the window
// Orders with no click in the window are recorded with touches = 0 (they count toward total revenue, not email revenue).
//
// Orders are attributed as they're paid (order.paid / commerce.order_paid events) and by a periodic sweep that picks up
// anything missed; refunded / cancelled orders lose their attribution.
import type { Env } from '../types';
import { one, all, run, val, stmt, batch, insertStmt } from './db';
import { onEvent } from './events';
import { registerPeriodic, registerJob, enqueue, logError } from './jobs';
import { id, now, DAY, MIN, clamp } from './util';

export const MODELS = ['last_click', 'first_touch', 'linear'] as const;
export type Model = (typeof MODELS)[number];
export const MODEL_LABEL: Record<Model, string> = { last_click: 'Last click', first_touch: 'First touch', linear: 'Linear (multi-touch)' };
export const DEFAULT_WINDOW_DAYS = 7;

export const isModel = (m: unknown): m is Model => typeof m === 'string' && (MODELS as readonly string[]).includes(m);
export const modelOf = (m: unknown): Model => (isModel(m) ? m : 'last_click');

export async function windowDays(env: Env, pubId: string): Promise<number> {
  const r = await one<{ window_days: number }>(env, 'SELECT window_days FROM revenue_settings WHERE pub_id = ?', pubId);
  return r?.window_days || DEFAULT_WINDOW_DAYS;
}

/** Change the click window (1–90 days) and re-attribute the last 90 days in the background. */
export async function setWindowDays(env: Env, pubId: string, days: number): Promise<number> {
  const d = clamp(Math.round(Number(days) || DEFAULT_WINDOW_DAYS), 1, 90);
  await run(env, `INSERT INTO revenue_settings (pub_id, window_days, updated_at) VALUES (?, ?, ?) ON CONFLICT(pub_id) DO UPDATE SET window_days = excluded.window_days, updated_at = excluded.updated_at`, pubId, d, now());
  await reattribute(env, pubId, 90);
  return d;
}

interface OrderInfo { key: string; source: 'checkout' | 'store'; orderId: string; pubId: string; kind: string; subscriberId: string | null; email: string; amount: number; currency: string; at: number }
interface Touch { channel: string; send_id: string | null; delivery_id: string | null; post_id: string | null; automation_id: string | null; step_id: string | null; tx_message_id: string | null; subject: string; first_at: number; last_at: number }

async function loadOrder(env: Env, key: string): Promise<OrderInfo | null> {
  const [p, oid] = [key.slice(0, 1), key.slice(2)];
  if (p === 'o') {
    const o = await one<any>(env, `SELECT * FROM orders WHERE id = ? AND status = 'paid'`, oid);
    if (!o) return null;
    return { key, source: 'checkout', orderId: o.id, pubId: o.pub_id, kind: o.kind, subscriberId: o.subscriber_id, email: String(o.email || '').toLowerCase(), amount: o.amount_cents || 0, currency: o.currency || 'usd', at: o.paid_at || o.created_at };
  }
  const o = await one<any>(env, `SELECT * FROM external_orders WHERE id = ? AND status = 'paid'`, oid);
  if (!o) return null;
  return { key, source: 'store', orderId: o.id, pubId: o.pub_id, kind: o.platform, subscriberId: o.subscriber_id, email: String(o.email || '').toLowerCase(), amount: o.total_cents || 0, currency: o.currency || 'usd', at: o.paid_at || o.created_at };
}

const CHANNEL: Record<string, string> = { post: 'newsletter', automation: 'automation' };

async function touchesFor(env: Env, o: OrderInfo, subscriberId: string | null, win: number): Promise<Touch[]> {
  const from = o.at - win * DAY;
  const out: Touch[] = [];
  if (subscriberId) {
    const rows = await all<any>(env,
      `SELECT d.id AS delivery_id, d.send_id, s.post_id, s.automation_id, s.step_id, s.kind, s.subject, MIN(k.created_at) AS first_at, MAX(k.created_at) AS last_at
       FROM deliveries d JOIN sends s ON s.id = d.send_id JOIN clicks k ON k.delivery_id = d.id
       WHERE d.subscriber_id = ? AND d.pub_id = ? AND d.clicked_at IS NOT NULL AND d.clicked_at <= ? AND s.kind NOT IN ('test','try') AND k.is_bot = 0 AND k.created_at >= ? AND k.created_at <= ?
       GROUP BY d.id`, subscriberId, o.pubId, o.at, from, o.at);
    for (const r of rows) out.push({ channel: CHANNEL[r.kind] || r.kind, send_id: r.send_id, delivery_id: r.delivery_id, post_id: r.post_id, automation_id: r.automation_id, step_id: r.step_id, tx_message_id: null, subject: r.subject || '', first_at: r.first_at, last_at: r.last_at });
  }
  if (o.email) {
    const tx = await all<any>(env, `SELECT id, subject, clicked_at FROM tx_messages WHERE pub_id = ? AND to_email = ? AND created_at >= ? AND created_at <= ? AND clicked_at IS NOT NULL AND clicked_at >= ? AND clicked_at <= ?`, o.pubId, o.email, from - 30 * DAY, o.at, from, o.at);
    for (const t of tx) out.push({ channel: 'transactional', send_id: null, delivery_id: null, post_id: null, automation_id: null, step_id: null, tx_message_id: t.id, subject: t.subject || '', first_at: t.clicked_at, last_at: t.clicked_at });
  }
  return out;
}

/** Split an order across touches for one model → [touch, weight]. Pure, exported for tests and reports. */
export function credit(model: Model, touches: Touch[]): Array<[Touch, number]> {
  if (!touches.length) return [];
  if (model === 'linear') return touches.map((t) => [t, 1 / touches.length]);
  const pick = model === 'last_click'
    ? touches.reduce((a, b) => (b.last_at > a.last_at ? b : a))
    : touches.reduce((a, b) => (b.first_at < a.first_at ? b : a));
  return [[pick, 1]];
}

/** Attribute one paid order ('o:<id>' or 'x:<id>'). Idempotent: replaces any earlier attribution of the order. */
export async function attributeOrder(env: Env, key: string): Promise<{ touches: number } | null> {
  const o = await loadOrder(env, key);
  if (!o) { await forget(env, key); return null; }
  let subId = o.subscriberId;
  if (!subId && o.email) subId = (await one<{ id: string }>(env, 'SELECT id FROM subscribers WHERE pub_id = ? AND email = ?', o.pubId, o.email))?.id || null;
  const win = await windowDays(env, o.pubId);
  const touches = await touchesFor(env, o, subId, win);
  const t = now();
  const stmts = [
    stmt(env, 'DELETE FROM revenue_attributions WHERE order_key = ?', key),
    stmt(env, `INSERT OR REPLACE INTO attribution_orders (order_key, pub_id, source, order_id, kind, subscriber_id, email, amount_cents, currency, ordered_at, window_days, touches, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      key, o.pubId, o.source, o.orderId, o.kind, subId, o.email, o.amount, o.currency, o.at, win, touches.length, t),
  ];
  for (const model of MODELS) {
    for (const [tc, w] of credit(model, touches)) {
      stmts.push(insertStmt(env, 'revenue_attributions', {
        id: id(), pub_id: o.pubId, order_key: key, model, channel: tc.channel, send_id: tc.send_id, delivery_id: tc.delivery_id, post_id: tc.post_id, automation_id: tc.automation_id, step_id: tc.step_id, tx_message_id: tc.tx_message_id,
        subject: tc.subject.slice(0, 300), touch_at: model === 'first_touch' ? tc.first_at : tc.last_at, weight: w, revenue_cents: o.amount * w, currency: o.currency, ordered_at: o.at, created_at: t,
      }));
    }
  }
  await batch(env, stmts);
  return { touches: touches.length };
}

async function forget(env: Env, key: string) {
  await batch(env, [stmt(env, 'DELETE FROM revenue_attributions WHERE order_key = ?', key), stmt(env, 'DELETE FROM attribution_orders WHERE order_key = ?', key)]);
}

// Attribute as orders are paid.
onEvent(async (env, e) => {
  if (e.type !== 'order.paid' && e.type !== 'commerce.order_paid') return;
  const oid = (e.data as any)?.order_id;
  if (!oid) return;
  try { await attributeOrder(env, (e.type === 'order.paid' ? 'o:' : 'x:') + oid); }
  catch (err) { await logError(env, 'attribution', err, e.pubId); }
});

/** Attribute paid orders from the last `days` that haven't been looked at yet; drop refunded/cancelled ones. */
export async function sweep(env: Env, days = 3, limit = 200): Promise<number> {
  const since = now() - days * DAY;
  const missing = await all<{ k: string }>(env,
    `SELECT 'o:' || o.id AS k FROM orders o WHERE o.status = 'paid' AND o.created_at >= ? AND NOT EXISTS (SELECT 1 FROM attribution_orders a WHERE a.order_key = 'o:' || o.id) LIMIT ?`, since - DAY, limit);
  const missingX = await all<{ k: string }>(env,
    `SELECT 'x:' || o.id AS k FROM external_orders o WHERE o.status = 'paid' AND o.updated_at >= ? AND NOT EXISTS (SELECT 1 FROM attribution_orders a WHERE a.order_key = 'x:' || o.id) LIMIT ?`, since, limit);
  for (const r of [...missing, ...missingX]) await attributeOrder(env, r.k).catch((e) => logError(env, 'attribution.sweep', e));
  const gone = await all<{ order_key: string }>(env,
    `SELECT a.order_key FROM attribution_orders a WHERE a.processed_at >= ? AND (
       (a.source = 'checkout' AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = a.order_id AND o.status = 'paid'))
       OR (a.source = 'store' AND NOT EXISTS (SELECT 1 FROM external_orders x WHERE x.id = a.order_id AND x.status = 'paid'))) LIMIT 200`, now() - 120 * DAY);
  for (const g of gone) await forget(env, g.order_key);
  return missing.length + missingX.length;
}

registerPeriodic('attribution.sweep', 10 * MIN, async (env) => { await sweep(env); });

/** Re-attribute every paid order of a publication from the last `days` (after a window change, or on request). */
export async function reattribute(env: Env, pubId: string, days = 90) {
  await enqueue(env, 'attribution.backfill', { pub_id: pubId, since: now() - days * DAY, after: '' });
}

registerJob('attribution.backfill', async (env, p) => {
  const keys = await all<{ k: string }>(env,
    `SELECT k FROM (SELECT 'o:' || id AS k FROM orders WHERE pub_id = ?1 AND status = 'paid' AND COALESCE(paid_at, created_at) >= ?2
       UNION ALL SELECT 'x:' || id AS k FROM external_orders WHERE pub_id = ?1 AND status = 'paid' AND COALESCE(paid_at, created_at) >= ?2) WHERE k > ?3 ORDER BY k LIMIT 100`, p.pub_id, p.since, p.after || '');
  for (const r of keys) await attributeOrder(env, r.k);
  if (keys.length === 100) await enqueue(env, 'attribution.backfill', { ...p, after: keys[keys.length - 1].k });
});

// ───────────────────────── reports ─────────────────────────
export interface Range { from: number; to: number }

/** Totals for a period: all revenue, email-attributed revenue (per model, per channel), emails sent, revenue per 1,000 emails. */
export async function revenueSummary(env: Env, pubId: string, r: Range, model: Model = 'last_click') {
  const [tot, byModel, byChannel, sent, tx] = await Promise.all([
    one<{ revenue: number; orders: number; touched: number }>(env, `SELECT COALESCE(SUM(amount_cents), 0) AS revenue, COUNT(*) AS orders, SUM(CASE WHEN touches > 0 THEN 1 ELSE 0 END) AS touched FROM attribution_orders WHERE pub_id = ? AND ordered_at >= ? AND ordered_at < ?`, pubId, r.from, r.to),
    all<{ model: string; revenue: number }>(env, `SELECT model, COALESCE(SUM(revenue_cents), 0) AS revenue FROM revenue_attributions WHERE pub_id = ? AND ordered_at >= ? AND ordered_at < ? GROUP BY model`, pubId, r.from, r.to),
    all<{ channel: string; revenue: number; orders: number }>(env, `SELECT channel, COALESCE(SUM(revenue_cents), 0) AS revenue, COUNT(DISTINCT order_key) AS orders FROM revenue_attributions WHERE pub_id = ? AND model = ? AND ordered_at >= ? AND ordered_at < ? GROUP BY channel ORDER BY revenue DESC`, pubId, model, r.from, r.to),
    val<number>(env, `SELECT COUNT(*) FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE d.pub_id = ? AND d.sent_at >= ? AND d.sent_at < ? AND d.status IN ('sent','complained') AND s.kind IN ('post','automation')`, pubId, r.from, r.to),
    val<number>(env, `SELECT COUNT(*) FROM tx_messages WHERE pub_id = ? AND created_at >= ? AND created_at < ? AND status IN ('sent','simulated')`, pubId, r.from, r.to),
  ]);
  const models = Object.fromEntries(MODELS.map((m) => [m, Math.round(byModel.find((x) => x.model === m)?.revenue || 0)])) as Record<Model, number>;
  const emails = (sent || 0) + (tx || 0);
  const attributed = models[model];
  return {
    model, window_days: await windowDays(env, pubId),
    total_revenue: tot?.revenue || 0, orders: tot?.orders || 0, email_orders: tot?.touched || 0,
    attributed_revenue: attributed, by_model: models,
    share: tot?.revenue ? attributed / tot.revenue : 0,
    by_channel: byChannel.map((c) => ({ channel: c.channel, revenue: Math.round(c.revenue), orders: c.orders })),
    emails_sent: emails, revenue_per_1000: emails ? Math.round((attributed / emails) * 1000) : 0,
  };
}

/** Revenue by email (newsletter posts, automation steps, transactional subjects) for a period, best first. */
export async function revenueByEmail(env: Env, pubId: string, r: Range, model: Model = 'last_click', limit = 25) {
  const rows = await all<any>(env,
    `SELECT channel, post_id, automation_id, step_id, CASE WHEN channel = 'transactional' THEN subject ELSE NULL END AS tx_subject, MAX(subject) AS subject,
       COALESCE(SUM(revenue_cents), 0) AS revenue, COUNT(DISTINCT order_key) AS orders
     FROM revenue_attributions WHERE pub_id = ? AND model = ? AND ordered_at >= ? AND ordered_at < ?
     GROUP BY channel, post_id, automation_id, step_id, tx_subject ORDER BY revenue DESC LIMIT ?`, pubId, model, r.from, r.to, clamp(limit, 1, 200));
  const out = [];
  for (const x of rows) {
    let sent = 0, name = x.subject || '(no subject)', href: string | null = null;
    if (x.post_id) {
      const p = await one<any>(env, 'SELECT title FROM posts WHERE id = ?', x.post_id);
      name = p?.title || name; href = `/app/posts/${x.post_id}`;
      sent = await val<number>(env, `SELECT COUNT(*) FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = ? AND s.kind = 'post' AND d.status IN ('sent','complained')`, x.post_id);
    } else if (x.automation_id) {
      const a = await one<any>(env, 'SELECT name FROM automations WHERE id = ?', x.automation_id);
      name = `${x.subject || '(no subject)'}`; href = `/app/automations/${x.automation_id}/analytics`;
      x.automation_name = a?.name || 'Automation';
      sent = await val<number>(env, `SELECT COUNT(*) FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.automation_id = ? AND s.step_id = ? AND d.status IN ('sent','complained')`, x.automation_id, x.step_id);
    } else if (x.channel === 'transactional') {
      sent = await val<number>(env, `SELECT COUNT(*) FROM tx_messages WHERE pub_id = ? AND subject = ? AND status IN ('sent','simulated')`, pubId, x.tx_subject);
    }
    out.push({ channel: x.channel as string, post_id: x.post_id as string | null, automation_id: x.automation_id as string | null, automation_name: (x.automation_name || null) as string | null, step_id: x.step_id as string | null, name, href, revenue: Math.round(x.revenue), orders: x.orders as number, sent, revenue_per_1000: sent ? Math.round((x.revenue / sent) * 1000) : 0 });
  }
  return out;
}

/** Attributed revenue for one post under every model, plus per-1,000 and order count (last click). */
export async function postRevenue(env: Env, postId: string) {
  const [rows, orders, sent] = await Promise.all([
    all<{ model: string; revenue: number; orders: number }>(env, `SELECT model, COALESCE(SUM(revenue_cents), 0) AS revenue, COUNT(DISTINCT order_key) AS orders FROM revenue_attributions WHERE post_id = ? GROUP BY model`, postId),
    all<any>(env, `SELECT a.order_key, a.revenue_cents, a.touch_at, o.kind, o.email, o.amount_cents, o.ordered_at FROM revenue_attributions a JOIN attribution_orders o ON o.order_key = a.order_key WHERE a.post_id = ? AND a.model = 'last_click' ORDER BY o.ordered_at DESC LIMIT 10`, postId),
    val<number>(env, `SELECT COUNT(*) FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = ? AND s.kind = 'post' AND d.status IN ('sent','complained')`, postId),
  ]);
  const by = Object.fromEntries(MODELS.map((m) => [m, { revenue: Math.round(rows.find((r) => r.model === m)?.revenue || 0), orders: rows.find((r) => r.model === m)?.orders || 0 }])) as Record<Model, { revenue: number; orders: number }>;
  return { by_model: by, sent: sent || 0, revenue_per_1000: sent ? Math.round((by.last_click.revenue / sent) * 1000) : 0, recent_orders: orders };
}

/** Attributed revenue for an automation: totals per model and per email step (last click unless `model`). */
export async function automationRevenue(env: Env, automationId: string, model: Model = 'last_click') {
  const [tot, steps] = await Promise.all([
    all<{ model: string; revenue: number; orders: number }>(env, `SELECT model, COALESCE(SUM(revenue_cents), 0) AS revenue, COUNT(DISTINCT order_key) AS orders FROM revenue_attributions WHERE automation_id = ? GROUP BY model`, automationId),
    all<{ step_id: string; revenue: number; orders: number }>(env, `SELECT step_id, COALESCE(SUM(revenue_cents), 0) AS revenue, COUNT(DISTINCT order_key) AS orders FROM revenue_attributions WHERE automation_id = ? AND model = ? GROUP BY step_id`, automationId, model),
  ]);
  const by = Object.fromEntries(MODELS.map((m) => [m, { revenue: Math.round(tot.find((r) => r.model === m)?.revenue || 0), orders: tot.find((r) => r.model === m)?.orders || 0 }])) as Record<Model, { revenue: number; orders: number }>;
  return { model, by_model: by, steps: Object.fromEntries(steps.map((s) => [s.step_id, { revenue: Math.round(s.revenue), orders: s.orders }])) as Record<string, { revenue: number; orders: number }> };
}

/** Attributed revenue per automation (for the automations list). */
export async function revenueByAutomation(env: Env, pubId: string, model: Model = 'last_click'): Promise<Record<string, number>> {
  const rows = await all<{ automation_id: string; revenue: number }>(env, `SELECT automation_id, COALESCE(SUM(revenue_cents), 0) AS revenue FROM revenue_attributions WHERE pub_id = ? AND model = ? AND automation_id IS NOT NULL GROUP BY automation_id`, pubId, model);
  return Object.fromEntries(rows.map((r) => [r.automation_id, Math.round(r.revenue)]));
}

/** Attributed revenue per marketing campaign (Calendar → Campaigns): posts and automations grouped by campaign_items. */
export async function revenueByCampaign(env: Env, pubId: string, r: Range, model: Model = 'last_click') {
  const rows = await all<any>(env,
    `SELECT c.id, c.name, COALESCE(SUM(a.revenue_cents), 0) AS revenue, COUNT(DISTINCT a.order_key) AS orders
     FROM campaigns c JOIN campaign_items ci ON ci.campaign_id = c.id AND ci.kind IN ('post','automation')
     JOIN revenue_attributions a ON a.pub_id = c.pub_id AND a.model = ? AND a.ordered_at >= ? AND a.ordered_at < ? AND ((ci.kind = 'post' AND a.post_id = ci.ref_id) OR (ci.kind = 'automation' AND a.automation_id = ci.ref_id))
     WHERE c.pub_id = ? GROUP BY c.id ORDER BY revenue DESC LIMIT 20`, model, r.from, r.to, pubId);
  return rows.map((x) => ({ id: x.id as string, name: x.name as string, revenue: Math.round(x.revenue), orders: x.orders as number }));
}

/** Orders credited to emails (newest first) — for the API. */
export async function attributedOrders(env: Env, pubId: string, r: Range, model: Model = 'last_click', limit = 50) {
  const rows = await all<any>(env, `SELECT * FROM attribution_orders WHERE pub_id = ? AND ordered_at >= ? AND ordered_at < ? AND touches > 0 ORDER BY ordered_at DESC LIMIT ?`, pubId, r.from, r.to, clamp(limit, 1, 200));
  const out = [];
  for (const o of rows) {
    const credits = await all<any>(env, `SELECT channel, post_id, automation_id, step_id, tx_message_id, subject, weight, revenue_cents, touch_at FROM revenue_attributions WHERE order_key = ? AND model = ?`, o.order_key, model);
    out.push({ order_key: o.order_key, source: o.source, order_id: o.order_id, kind: o.kind, subscriber_id: o.subscriber_id, email: o.email, amount_cents: o.amount_cents, currency: o.currency, ordered_at: new Date(o.ordered_at).toISOString(), touches: o.touches, credits: credits.map((c) => ({ ...c, revenue_cents: Math.round(c.revenue_cents), touch_at: new Date(c.touch_at).toISOString() })) });
  }
  return out;
}
