// Predictive subscriber scores: value score ("most valuable subscribers"), customer lifetime value, purchase likelihood
// and churn risk for paid subscribers. Deliberately simple, transparent models — every weight is a named constant below,
// and the dashboard explains them. Recomputed every few hours per publication (`intel.scores` job) and on demand for one
// subscriber when their profile is opened.
//
// VALUE SCORE (0–100)
//   = VALUE_W.engagement × engagement/100
//   + VALUE_W.revenue    × min(1, ln(1 + revenue) / ln(1 + p95 revenue of the publication's paying readers))
//   + VALUE_W.referrals  × min(1, referrals / REFERRALS_FOR_FULL_SCORE)
//   + VALUE_W.recency    × recency, where recency = 1 if last activity ≤ 7 days ago, falling linearly to 0 at 90 days
//   "Last activity" = latest of: email open, email click, website visit, paid order.
//
// CUSTOMER LIFETIME VALUE = historical revenue (paid orders) + predicted future revenue
//   predicted = subscription monthly value × expected remaining months × churn-risk retention factor
//             + average monthly one-off spend × ONE_OFF_HORIZON_MONTHS × purchase-likelihood factor
//   expected remaining months = min(MAX_TENURE_MONTHS, 1 / monthly churn rate of the publication's paid subscriptions)
//   monthly churn rate = cancellations in the last 180 days ÷ paid-subscription months in that window (clamped 2%–50%,
//   DEFAULT_MONTHLY_CHURN when there is no history).
//
// PURCHASE LIKELIHOOD (points, 0–100): engagement, website visits (90 days), past purchases, recency, recent clicks.
//   high ≥ PURCHASE_HIGH, medium ≥ PURCHASE_MEDIUM, otherwise low.
//
// CHURN RISK (paid subscribers only, points 0–100): payment past due, paused, trial ending, no opens lately, low
//   engagement, no website visits, very new subscription. high ≥ CHURN_HIGH, medium ≥ CHURN_MEDIUM, otherwise low.
import type { Env } from '../types';
import { all, one, run, val, stmt, batch } from './db';
import { registerJob, registerPeriodic, enqueue } from './jobs';
import { now, DAY, HOUR, chunk } from './util';
import { getSignals, domainSignals } from './signals';

export const VALUE_W = { engagement: 35, revenue: 30, referrals: 15, recency: 20 };
export const REFERRALS_FOR_FULL_SCORE = 5;
export const RECENCY_FULL_DAYS = 7;
export const RECENCY_ZERO_DAYS = 90;
export const MAX_TENURE_MONTHS = 36;
export const DEFAULT_MONTHLY_CHURN = 0.05;
export const ONE_OFF_HORIZON_MONTHS = 12;
/** One-off spend is averaged over at least this many months, so a single recent purchase is not extrapolated as monthly. */
export const ONE_OFF_MIN_MONTHS = 6;
export const CHURN_RETENTION = { low: 1, medium: 0.6, high: 0.3 } as const;
export const PURCHASE_FACTOR = { high: 0.5, medium: 0.25, low: 0.05 } as const;
export const PURCHASE_POINTS = { engaged: 25, warm: 12, visits10: 20, visits3: 10, buyer2: 30, buyer1: 20, active14: 15, active30: 8, clicked30: 10 };
export const PURCHASE_HIGH = 60;
export const PURCHASE_MEDIUM = 30;
export const CHURN_POINTS = { pastDue: 40, paused: 25, trialEnding: 15, noOpen60: 30, noOpen30: 15, lowEngagement: 15, noVisit30: 10, newSub: 10 };
export const CHURN_HIGH = 50;
export const CHURN_MEDIUM = 25;
export const SCORE_INTERVAL = 6 * HOUR;

export type Level = 'high' | 'medium' | 'low';

export interface ScoreInput {
  engagement: number; referral_count: number; last_open_at: number | null; last_click_at: number | null; created_at: number;
  revenue: number; orders: number; oneoff: number; first_order_at: number | null; last_order_at: number | null;
  pv90: number; pv30: number; last_view_at: number | null;
  sub?: { status: string; amount_cents: number; interval: string; trial_ends_at: number | null; created_at: number } | null;
}
export interface PubContext { p95Revenue: number; monthlyChurn: number }
export interface Scores {
  value_score: number; revenue_cents: number; monthly_value_cents: number; predicted_cents: number; clv_cents: number;
  purchase_score: number; purchase_likelihood: Level; churn_score: number | null; churn_risk: Level | null;
  page_views_90d: number; orders: number; last_active_at: number | null;
  explain: { value: Record<string, number>; purchase: string[]; churn: string[]; tenureMonths: number | null };
}

const days = (t: number | null, at: number) => (t ? (at - t) / DAY : Infinity);

/** Pure scoring function (all inputs explicit, so it is easy to test and to explain). */
export function computeScores(x: ScoreInput, ctx: PubContext, at = now()): Scores {
  const lastActive = Math.max(x.last_open_at || 0, x.last_click_at || 0, x.last_view_at || 0, x.last_order_at || 0) || null;
  const dAct = days(lastActive, at);
  const recency = dAct <= RECENCY_FULL_DAYS ? 1 : dAct >= RECENCY_ZERO_DAYS ? 0 : 1 - (dAct - RECENCY_FULL_DAYS) / (RECENCY_ZERO_DAYS - RECENCY_FULL_DAYS);
  const revF = x.revenue > 0 && ctx.p95Revenue > 0 ? Math.min(1, Math.log1p(x.revenue) / Math.log1p(ctx.p95Revenue)) : 0;
  const parts = {
    engagement: VALUE_W.engagement * Math.max(0, Math.min(100, x.engagement || 0)) / 100,
    revenue: VALUE_W.revenue * revF,
    referrals: VALUE_W.referrals * Math.min(1, (x.referral_count || 0) / REFERRALS_FOR_FULL_SCORE),
    recency: VALUE_W.recency * recency,
  };
  const value_score = Math.round(parts.engagement + parts.revenue + parts.referrals + parts.recency);

  // purchase likelihood
  const P = PURCHASE_POINTS;
  const why: string[] = [];
  let ps = 0;
  const add = (n: number, w: string) => { ps += n; why.push(`+${n} ${w}`); };
  if (x.engagement >= 60) add(P.engaged, 'highly engaged'); else if (x.engagement >= 30) add(P.warm, 'moderately engaged');
  if (x.pv90 >= 10) add(P.visits10, '10+ site visits in 90 days'); else if (x.pv90 >= 3) add(P.visits3, '3+ site visits in 90 days');
  if (x.orders >= 2) add(P.buyer2, 'repeat buyer'); else if (x.orders === 1) add(P.buyer1, 'has purchased before');
  if (dAct <= 14) add(P.active14, 'active in the last 14 days'); else if (dAct <= 30) add(P.active30, 'active in the last 30 days');
  if (days(x.last_click_at, at) <= 30) add(P.clicked30, 'clicked an email in the last 30 days');
  const purchase_score = Math.min(100, ps);
  const purchase_likelihood: Level = purchase_score >= PURCHASE_HIGH ? 'high' : purchase_score >= PURCHASE_MEDIUM ? 'medium' : 'low';

  // churn risk (paid only)
  let churn_score: number | null = null;
  let churn_risk: Level | null = null;
  const cwhy: string[] = [];
  const paying = x.sub && ['active', 'trialing', 'past_due', 'paused'].includes(x.sub.status);
  if (paying) {
    const C = CHURN_POINTS;
    let cs = 0;
    const cadd = (n: number, w: string) => { cs += n; cwhy.push(`+${n} ${w}`); };
    if (x.sub!.status === 'past_due') cadd(C.pastDue, 'payment past due');
    if (x.sub!.status === 'paused') cadd(C.paused, 'subscription paused');
    if (x.sub!.status === 'trialing' && x.sub!.trial_ends_at && x.sub!.trial_ends_at - at < 7 * DAY) cadd(C.trialEnding, 'trial ends within 7 days');
    const dOpen = days(x.last_open_at, at);
    if (dOpen > 60) cadd(C.noOpen60, 'no opens in 60 days'); else if (dOpen > 30) cadd(C.noOpen30, 'no opens in 30 days');
    if ((x.engagement || 0) < 25) cadd(C.lowEngagement, 'low engagement score');
    if (x.pv30 === 0) cadd(C.noVisit30, 'no website visits in 30 days');
    if (at - x.sub!.created_at < 60 * DAY) cadd(C.newSub, 'subscribed less than 60 days ago');
    churn_score = Math.min(100, cs);
    churn_risk = churn_score >= CHURN_HIGH ? 'high' : churn_score >= CHURN_MEDIUM ? 'medium' : 'low';
  }

  // lifetime value
  const subMonthly = paying && x.sub!.status !== 'paused' ? Math.round(x.sub!.interval === 'year' ? x.sub!.amount_cents / 12 : x.sub!.amount_cents) : 0;
  const tenureMonths = paying ? Math.min(MAX_TENURE_MONTHS, 1 / ctx.monthlyChurn) : null;
  const monthsSinceFirst = x.first_order_at ? Math.max(ONE_OFF_MIN_MONTHS, (at - x.first_order_at) / (30 * DAY)) : 1;
  const oneOffMonthly = x.oneoff > 0 ? x.oneoff / monthsSinceFirst : 0;
  const predicted = Math.round(
    (subMonthly && tenureMonths ? subMonthly * tenureMonths * CHURN_RETENTION[churn_risk || 'low'] : 0) +
    oneOffMonthly * ONE_OFF_HORIZON_MONTHS * PURCHASE_FACTOR[purchase_likelihood],
  );
  return {
    value_score, revenue_cents: x.revenue, monthly_value_cents: Math.round(subMonthly + oneOffMonthly), predicted_cents: predicted, clv_cents: x.revenue + predicted,
    purchase_score, purchase_likelihood, churn_score, churn_risk, page_views_90d: x.pv90, orders: x.orders, last_active_at: lastActive,
    explain: { value: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 10) / 10])), purchase: why, churn: cwhy, tenureMonths: tenureMonths ? Math.round(tenureMonths * 10) / 10 : null },
  };
}

/** Publication-level inputs: p95 lifetime revenue of paying readers and the monthly churn rate of paid subscriptions. */
export async function pubContext(env: Env, pubId: string, at = now()): Promise<PubContext> {
  const payers = await val<number>(env, `SELECT COUNT(DISTINCT subscriber_id) FROM orders WHERE pub_id = ? AND status = 'paid' AND subscriber_id IS NOT NULL`, pubId);
  let p95Revenue = 0;
  if (payers) {
    const off = Math.floor(payers * 0.05);
    p95Revenue = Number(await val(env, `SELECT v FROM (SELECT SUM(amount_cents) AS v FROM orders WHERE pub_id = ? AND status = 'paid' AND subscriber_id IS NOT NULL GROUP BY subscriber_id) ORDER BY v DESC LIMIT 1 OFFSET ?`, pubId, off)) || 0;
  }
  const since = at - 180 * DAY;
  const [canceled, activeNow] = await Promise.all([
    val<number>(env, `SELECT COUNT(*) FROM subscriptions WHERE pub_id = ? AND canceled_at >= ?`, pubId, since),
    val<number>(env, `SELECT COUNT(*) FROM subscriptions WHERE pub_id = ? AND status IN ('active','trialing','past_due','paused')`, pubId),
  ]);
  const months = (activeNow + canceled / 2) * 6;
  const monthlyChurn = months > 0 && (canceled > 0 || activeNow > 0) ? Math.min(0.5, Math.max(0.02, canceled / months)) : DEFAULT_MONTHLY_CHURN;
  return { p95Revenue, monthlyChurn };
}

const SUB_COLS = 'id, engagement, referral_count, last_open_at, last_click_at, created_at';

async function upsertStmts(env: Env, pubId: string, rows: Array<{ id: string; s: Scores }>, at: number) {
  return rows.map(({ id, s }) => stmt(env, `INSERT INTO subscriber_scores (subscriber_id, pub_id, value_score, revenue_cents, monthly_value_cents, predicted_cents, clv_cents, purchase_score, purchase_likelihood, churn_score, churn_risk, page_views_90d, orders, last_active_at, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(subscriber_id) DO UPDATE SET value_score = excluded.value_score, revenue_cents = excluded.revenue_cents, monthly_value_cents = excluded.monthly_value_cents, predicted_cents = excluded.predicted_cents,
      clv_cents = excluded.clv_cents, purchase_score = excluded.purchase_score, purchase_likelihood = excluded.purchase_likelihood, churn_score = excluded.churn_score, churn_risk = excluded.churn_risk,
      page_views_90d = excluded.page_views_90d, orders = excluded.orders, last_active_at = excluded.last_active_at, computed_at = excluded.computed_at`,
    id, pubId, s.value_score, s.revenue_cents, s.monthly_value_cents, s.predicted_cents, s.clv_cents, s.purchase_score, s.purchase_likelihood, s.churn_score, s.churn_risk, s.page_views_90d, s.orders, s.last_active_at, at));
}

async function activityMaps(env: Env, pubId: string, at: number) {
  const [orders, views, subs] = await Promise.all([
    all<any>(env, `SELECT subscriber_id AS id, COUNT(*) AS n, SUM(amount_cents) AS revenue, SUM(CASE WHEN kind != 'subscription' THEN amount_cents ELSE 0 END) AS oneoff, MIN(paid_at) AS first, MAX(paid_at) AS last
      FROM orders WHERE pub_id = ? AND status = 'paid' AND subscriber_id IS NOT NULL GROUP BY subscriber_id`, pubId),
    all<any>(env, `SELECT subscriber_id AS id, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS pv90, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS pv30, MAX(created_at) AS last
      FROM page_views WHERE pub_id = ? AND subscriber_id IS NOT NULL GROUP BY subscriber_id`, at - 90 * DAY, at - 30 * DAY, pubId),
    all<any>(env, `SELECT subscriber_id AS id, status, amount_cents, interval, trial_ends_at, created_at FROM subscriptions WHERE pub_id = ? AND status IN ('active','trialing','past_due','paused') ORDER BY created_at`, pubId),
  ]);
  return { orders: new Map(orders.map((o) => [o.id, o])), views: new Map(views.map((v) => [v.id, v])), subs: new Map(subs.map((s) => [s.id, s])) };
}

function inputFor(s: any, m: Awaited<ReturnType<typeof activityMaps>>): ScoreInput {
  const o = m.orders.get(s.id), v = m.views.get(s.id), sub = m.subs.get(s.id);
  return {
    engagement: Number(s.engagement) || 0, referral_count: Number(s.referral_count) || 0, last_open_at: s.last_open_at, last_click_at: s.last_click_at, created_at: s.created_at,
    revenue: Number(o?.revenue) || 0, orders: Number(o?.n) || 0, oneoff: Number(o?.oneoff) || 0, first_order_at: o?.first ?? null, last_order_at: o?.last ?? null,
    pv90: Number(v?.pv90) || 0, pv30: Number(v?.pv30) || 0, last_view_at: v?.last ?? null, sub: sub || null,
  };
}

/** Score every active subscriber of a publication. Resumable: returns the cursor when the time budget runs out. */
export async function scorePublication(env: Env, pubId: string, opts: { after?: string; started?: number; budgetMs?: number } = {}): Promise<{ done: boolean; after?: string; scored: number }> {
  const t0 = Date.now();
  const at = opts.started || now();
  const ctx = await pubContext(env, pubId, at);
  const maps = await activityMaps(env, pubId, at);
  let after = opts.after || '';
  let scored = 0;
  for (;;) {
    const page = await all<any>(env, `SELECT ${SUB_COLS} FROM subscribers WHERE pub_id = ? AND status = 'active' AND source != 'try_it' AND id > ? ORDER BY id LIMIT 500`, pubId, after);
    if (!page.length) break;
    const rows = page.map((s) => ({ id: s.id, s: computeScores(inputFor(s, maps), ctx, at) }));
    for (const ch of chunk(rows, 50)) await batch(env, await upsertStmts(env, pubId, ch, at));
    scored += page.length;
    after = page[page.length - 1].id;
    if (page.length < 500) break;
    if (Date.now() - t0 > (opts.budgetMs ?? 15_000)) return { done: false, after, scored };
  }
  // drop scores of readers who left, then rank
  await run(env, 'DELETE FROM subscriber_scores WHERE pub_id = ? AND computed_at < ?', pubId, at);
  await run(env, `UPDATE subscriber_scores SET value_percentile = r.p FROM (
      SELECT subscriber_id, CAST(ROUND(PERCENT_RANK() OVER (ORDER BY value_score) * 100) AS INTEGER) AS p FROM subscriber_scores WHERE pub_id = ?
    ) AS r WHERE r.subscriber_id = subscriber_scores.subscriber_id`, pubId);
  return { done: true, scored };
}

/** Score one subscriber now (used by the profile page and the API). */
export async function scoreSubscriber(env: Env, pubId: string, subscriberId: string): Promise<(Scores & { value_percentile: number | null }) | null> {
  const s = await one<any>(env, `SELECT ${SUB_COLS}, status FROM subscribers WHERE id = ? AND pub_id = ?`, subscriberId, pubId);
  if (!s) return null;
  const at = now();
  const [ctx, o, v, sub] = await Promise.all([
    pubContext(env, pubId, at),
    one<any>(env, `SELECT ? AS id, COUNT(*) AS n, SUM(amount_cents) AS revenue, SUM(CASE WHEN kind != 'subscription' THEN amount_cents ELSE 0 END) AS oneoff, MIN(paid_at) AS first, MAX(paid_at) AS last FROM orders WHERE pub_id = ? AND status = 'paid' AND subscriber_id = ?`, s.id, pubId, s.id),
    one<any>(env, `SELECT ? AS id, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS pv90, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS pv30, MAX(created_at) AS last FROM page_views WHERE pub_id = ? AND subscriber_id = ?`, s.id, at - 90 * DAY, at - 30 * DAY, pubId, s.id),
    one<any>(env, `SELECT subscriber_id AS id, status, amount_cents, interval, trial_ends_at, created_at FROM subscriptions WHERE pub_id = ? AND subscriber_id = ? AND status IN ('active','trialing','past_due','paused') ORDER BY created_at DESC LIMIT 1`, pubId, s.id),
  ]);
  const maps = { orders: new Map(o ? [[s.id, o]] : []), views: new Map(v ? [[s.id, v]] : []), subs: new Map(sub ? [[s.id, sub]] : []) };
  const sc = computeScores(inputFor(s, maps), ctx, at);
  if (s.status === 'active') await batch(env, await upsertStmts(env, pubId, [{ id: s.id, s: sc }], at));
  const pctRow = await one<{ n: number; below: number }>(env, `SELECT COUNT(*) AS n, SUM(CASE WHEN value_score < ? THEN 1 ELSE 0 END) AS below FROM subscriber_scores WHERE pub_id = ?`, sc.value_score, pubId);
  const n = Number(pctRow?.n) || 0;
  return { ...sc, value_percentile: n > 1 ? Math.round((Number(pctRow!.below) / (n - 1)) * 100) : null };
}

export async function queueScoring(env: Env, pubId: string) {
  const pending = await val<number>(env, `SELECT COUNT(*) FROM jobs WHERE kind = 'intel.scores' AND status IN ('pending','running') AND payload LIKE ?`, `%"${pubId}"%`);
  if (!pending) await enqueue(env, 'intel.scores', { pub_id: pubId, started: now() });
}

export async function lastScoredAt(env: Env, pubId: string): Promise<number | null> {
  return (await val<number | null>(env, 'SELECT MAX(computed_at) FROM subscriber_scores WHERE pub_id = ?', pubId)) || null;
}

/** Ranked subscribers for the "Top subscribers" view. */
export async function topSubscribers(env: Env, pubId: string, opts: { sort?: 'value' | 'clv' | 'purchase' | 'churn'; limit?: number; offset?: number } = {}) {
  const order = { value: 'x.value_score DESC, x.clv_cents DESC', clv: 'x.clv_cents DESC, x.value_score DESC', purchase: 'x.purchase_score DESC, x.value_score DESC', churn: 'x.churn_score DESC, x.monthly_value_cents DESC' }[opts.sort || 'value'];
  return all<any>(env, `SELECT s.id, s.email, s.name, s.tier, s.engagement, s.referral_count, s.created_at, x.*, g.avatar_url, g.job_title, COALESCE(g.company, g.organization) AS company
    FROM subscriber_scores x JOIN subscribers s ON s.id = x.subscriber_id LEFT JOIN subscriber_signals g ON g.subscriber_id = s.id
    WHERE x.pub_id = ? AND s.status = 'active' ${opts.sort === 'churn' ? 'AND x.churn_risk IS NOT NULL' : ''} ORDER BY ${order} LIMIT ? OFFSET ?`, pubId, opts.limit ?? 50, opts.offset ?? 0);
}

/** Publication-level prediction summary (Analytics → Revenue, Top subscribers). */
export async function predictionSummary(env: Env, pubId: string) {
  const row = await one<any>(env, `SELECT COUNT(*) AS n,
      SUM(CASE WHEN revenue_cents > 0 OR monthly_value_cents > 0 THEN 1 ELSE 0 END) AS customers,
      COALESCE(SUM(clv_cents), 0) AS clv, COALESCE(SUM(predicted_cents), 0) AS predicted, COALESCE(SUM(revenue_cents), 0) AS historical,
      SUM(CASE WHEN purchase_likelihood = 'high' THEN 1 ELSE 0 END) AS p_high, SUM(CASE WHEN purchase_likelihood = 'medium' THEN 1 ELSE 0 END) AS p_medium, SUM(CASE WHEN purchase_likelihood = 'low' THEN 1 ELSE 0 END) AS p_low,
      SUM(CASE WHEN purchase_likelihood = 'high' AND orders = 0 THEN 1 ELSE 0 END) AS p_high_nonbuyers,
      SUM(CASE WHEN churn_risk = 'high' THEN 1 ELSE 0 END) AS c_high, SUM(CASE WHEN churn_risk = 'medium' THEN 1 ELSE 0 END) AS c_medium, SUM(CASE WHEN churn_risk = 'low' THEN 1 ELSE 0 END) AS c_low,
      COALESCE(SUM(CASE WHEN churn_risk = 'high' THEN monthly_value_cents ELSE 0 END), 0) AS mrr_at_risk,
      MAX(computed_at) AS computed_at
    FROM subscriber_scores WHERE pub_id = ?`, pubId);
  const customers = Number(row?.customers) || 0;
  const ctx = await pubContext(env, pubId);
  return {
    scored: Number(row?.n) || 0, customers, totalClv: Number(row?.clv) || 0, predicted: Number(row?.predicted) || 0, historical: Number(row?.historical) || 0,
    avgClv: customers ? Math.round((Number(row.clv) || 0) / customers) : 0,
    purchase: { high: Number(row?.p_high) || 0, medium: Number(row?.p_medium) || 0, low: Number(row?.p_low) || 0, highNonBuyers: Number(row?.p_high_nonbuyers) || 0 },
    churn: { high: Number(row?.c_high) || 0, medium: Number(row?.c_medium) || 0, low: Number(row?.c_low) || 0, mrrAtRisk: Number(row?.mrr_at_risk) || 0 },
    monthlyChurn: ctx.monthlyChurn, expectedTenure: Math.min(MAX_TENURE_MONTHS, 1 / ctx.monthlyChurn), computedAt: row?.computed_at || null,
  };
}

registerJob('intel.scores', async (env, p: { pub_id: string; after?: string; started?: number }) => {
  if (!p?.pub_id) return;
  const r = await scorePublication(env, p.pub_id, { after: p.after, started: p.started });
  if (!r.done) await enqueue(env, 'intel.scores', { pub_id: p.pub_id, after: r.after, started: p.started });
});

registerPeriodic('intel.scores', SCORE_INTERVAL, async (env) => {
  const pubs = await all<{ id: string }>(env, `SELECT p.id FROM publications p WHERE p.status = 'active' AND EXISTS (SELECT 1 FROM subscribers s WHERE s.pub_id = p.id AND s.status = 'active')`);
  for (const p of pubs) await queueScoring(env, p.id);
});

/** Scores + public signals for one subscriber (REST API, MCP). */
export async function subscriberInsights(env: Env, pubId: string, subscriberId: string) {
  const s = await one<{ email: string }>(env, 'SELECT email FROM subscribers WHERE id = ? AND pub_id = ?', subscriberId, pubId);
  if (!s) return null;
  const [sc, sig] = await Promise.all([scoreSubscriber(env, pubId, subscriberId), getSignals(env, subscriberId)]);
  const d = domainSignals(s.email);
  return {
    value_score: sc?.value_score ?? null, value_percentile: sc?.value_percentile ?? null,
    lifetime_value: sc ? { total_cents: sc.clv_cents, historical_cents: sc.revenue_cents, predicted_cents: sc.predicted_cents, monthly_value_cents: sc.monthly_value_cents, expected_tenure_months: sc.explain.tenureMonths } : null,
    purchase_likelihood: sc ? { level: sc.purchase_likelihood, score: sc.purchase_score, reasons: sc.explain.purchase } : null,
    churn_risk: sc?.churn_risk ? { level: sc.churn_risk, score: sc.churn_score, reasons: sc.explain.churn } : null,
    signals: {
      business_email: d.business, email_domain: d.domain, organization: d.organization, country: sig?.country ?? null,
      gravatar: sig?.gravatar_status === 'found' ? { display_name: sig.display_name, avatar_url: sig.avatar_url, profile_url: sig.profile_url, location: sig.location, job_title: sig.job_title, company: sig.company, social_accounts: sig.socials } : null,
      checked_at: sig?.updated_at ? new Date(sig.updated_at).toISOString() : null,
    },
  };
}
