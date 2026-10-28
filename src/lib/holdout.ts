// Holdout groups and incremental lift.
//
// A newsletter post or an automation can hold back a share of eligible readers (0–50%): they are deliberately NOT sent
// the post / NOT enrolled in the automation. Who is held back is decided by a stable hash of (post or automation id,
// subscriber id), so the same reader is always in the same group. Held-back readers are recorded in holdout_members —
// they have no delivery, so they are never counted as "didn't open".
//
// The lift report compares readers who got the email ("treated") with the holdout over a conversion window
// (default 7 days after the send / enrollment): orders, revenue, site visits and paid upgrades. Each difference comes
// with a 95% confidence interval and a two-proportion z-test (Welch's t for revenue per reader).
import type { Env } from '../types';
import { one, all, run, stmt, batch, insertStmt } from './db';
import { now, sha256, parseJSON, chunk, DAY, clamp } from './util';

export type HoldoutKind = 'post' | 'automation';
export const MAX_HOLDOUT_PCT = 50;
export interface HoldoutConfig { kind: HoldoutKind; ref_id: string; pub_id: string; pct: number; window_days: number; started_at: number | null; created_at: number; updated_at: number }

const cache = new Map<string, { cfg: HoldoutConfig | null; at: number }>();

export async function getHoldout(env: Env, kind: HoldoutKind, refId: string, fresh = false): Promise<HoldoutConfig | null> {
  const k = kind + ':' + refId;
  const hit = cache.get(k);
  if (!fresh && hit && now() - hit.at < 15_000) return hit.cfg;
  const cfg = await one<HoldoutConfig>(env, 'SELECT * FROM holdout_configs WHERE kind = ? AND ref_id = ?', kind, refId);
  cache.set(k, { cfg, at: now() });
  return cfg;
}

export async function setHoldout(env: Env, pubId: string, kind: HoldoutKind, refId: string, pct: number, windowDays?: number): Promise<HoldoutConfig> {
  const p = clamp(Math.round((Number(pct) || 0) * 10) / 10, 0, MAX_HOLDOUT_PCT);
  const prev = await getHoldout(env, kind, refId, true);
  const w = clamp(Math.round(Number(windowDays ?? prev?.window_days ?? 7) || 7), 1, 60);
  const t = now();
  const started = p > 0 ? (prev?.pct ? prev.started_at ?? t : t) : prev?.started_at ?? null;
  await run(env, `INSERT INTO holdout_configs (kind, ref_id, pub_id, pct, window_days, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, ref_id) DO UPDATE SET pct = excluded.pct, window_days = excluded.window_days, started_at = excluded.started_at, updated_at = excluded.updated_at`, kind, refId, pubId, p, w, started, t, t);
  cache.delete(kind + ':' + refId);
  return (await getHoldout(env, kind, refId, true))!;
}

/** Stable assignment: the same (post/automation, reader) pair always lands in the same group. */
export async function inHoldout(refId: string, subscriberId: string, pct: number): Promise<boolean> {
  if (!(pct > 0)) return false;
  const h = parseInt((await sha256(`holdout:${refId}:${subscriberId}`)).slice(0, 8), 16) % 10000;
  return h < pct * 100;
}

/**
 * Sender hook (lib/sender): which of this batch's recipients are held back from the post. Records them (once).
 * Resends to a fixed list (only_subscriber_ids) and test sends are never held back.
 */
export async function holdoutSet(env: Env, send: { id: string; pub_id: string; post_id?: string | null; kind?: string; options?: string }, recipients: Array<{ id: string }>): Promise<Set<string>> {
  const out = new Set<string>();
  if (!send.post_id || !recipients.length || (send.kind && send.kind !== 'post')) return out;
  if (parseJSON<any>(send.options, {}).only_subscriber_ids) return out;
  const cfg = await getHoldout(env, 'post', send.post_id);
  if (!cfg?.pct) return out;
  for (const r of recipients) if (await inHoldout(send.post_id, r.id, cfg.pct)) out.add(r.id);
  if (out.size) {
    const t = now();
    await batch(env, [...out].map((sid) => insertStmt(env, 'holdout_members', { kind: 'post', ref_id: send.post_id, pub_id: send.pub_id, subscriber_id: sid, send_id: send.id, created_at: t }, true)));
  }
  return out;
}

/** Automation hook (lib/automations enroll): true = this trigger-driven enrollment is held back (and recorded). */
export async function holdoutEnroll(env: Env, a: { id: string; pub_id: string }, subscriberId: string, data: Record<string, unknown> | undefined): Promise<boolean> {
  const trig = data && (data as any).trigger;
  if (!trig || trig === 'manual') return false; // manual / API / bulk enrollments are explicit: never held back
  const cfg = await getHoldout(env, 'automation', a.id);
  if (!cfg?.pct) return false;
  if (await one(env, `SELECT 1 FROM holdout_members WHERE kind = 'automation' AND ref_id = ? AND subscriber_id = ?`, a.id, subscriberId)) return true;
  if (!(await inHoldout(a.id, subscriberId, cfg.pct))) return false;
  await run(env, `INSERT OR IGNORE INTO holdout_members (kind, ref_id, pub_id, subscriber_id, send_id, created_at) VALUES ('automation', ?, ?, ?, NULL, ?)`, a.id, a.pub_id, subscriberId, now());
  return true;
}

export async function holdoutCount(env: Env, kind: HoldoutKind, refId: string): Promise<number> {
  return (await one<{ n: number }>(env, 'SELECT COUNT(*) AS n FROM holdout_members WHERE kind = ? AND ref_id = ?', kind, refId))?.n || 0;
}

// ───────────────────────── statistics ─────────────────────────
/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

export interface PropTest { treated: { n: number; x: number; rate: number }; holdout: { n: number; x: number; rate: number }; diff: number; lift: number | null; ci: [number, number]; z: number; p: number; significant: boolean }

/** Two-proportion z-test (pooled SE for the test, unpooled SE for the 95% interval of the difference). */
export function twoProportion(x1: number, n1: number, x2: number, n2: number): PropTest {
  const p1 = n1 ? x1 / n1 : 0, p2 = n2 ? x2 / n2 : 0;
  const diff = p1 - p2;
  const pool = n1 + n2 ? (x1 + x2) / (n1 + n2) : 0;
  const sePool = n1 && n2 ? Math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2)) : 0;
  const z = sePool ? diff / sePool : 0;
  const p = sePool ? 2 * (1 - normCdf(Math.abs(z))) : 1;
  const se = n1 && n2 ? Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2) : 0;
  return { treated: { n: n1, x: x1, rate: p1 }, holdout: { n: n2, x: x2, rate: p2 }, diff, lift: p2 > 0 ? diff / p2 : null, ci: [diff - 1.96 * se, diff + 1.96 * se], z, p, significant: !!sePool && p < 0.05 };
}

export interface MeanTest { treated: { n: number; mean: number }; holdout: { n: number; mean: number }; diff: number; lift: number | null; ci: [number, number]; z: number; p: number; significant: boolean; incremental: number }

/** Difference in means from sums and sums of squares (Welch / large-sample normal). */
export function twoMeans(s1: number, ss1: number, n1: number, s2: number, ss2: number, n2: number): MeanTest {
  const m1 = n1 ? s1 / n1 : 0, m2 = n2 ? s2 / n2 : 0;
  const v = (ss: number, m: number, n: number) => (n > 1 ? Math.max(0, (ss - n * m * m) / (n - 1)) : 0);
  const se = n1 && n2 ? Math.sqrt(v(ss1, m1, n1) / n1 + v(ss2, m2, n2) / n2) : 0;
  const diff = m1 - m2;
  const z = se ? diff / se : 0;
  const p = se ? 2 * (1 - normCdf(Math.abs(z))) : 1;
  return { treated: { n: n1, mean: m1 }, holdout: { n: n2, mean: m2 }, diff, lift: m2 > 0 ? diff / m2 : null, ci: [diff - 1.96 * se, diff + 1.96 * se], z, p, significant: !!se && p < 0.05, incremental: diff * n1 };
}

// ───────────────────────── lift report ─────────────────────────
interface Member { t0: number; group: 'treated' | 'holdout' }

async function membership(env: Env, kind: HoldoutKind, refId: string, since: number, ids: string[]): Promise<Map<string, Member>> {
  const m = new Map<string, Member>();
  for (const ch of chunk([...new Set(ids)], 80)) {
    const ph = ch.map(() => '?').join(',');
    const treated = kind === 'post'
      ? await all<{ sid: string; t0: number }>(env, `SELECT d.subscriber_id AS sid, MIN(COALESCE(d.sent_at, d.created_at)) AS t0 FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = ? AND s.kind = 'post' AND d.status IN ('sent','complained') AND d.subscriber_id IN (${ph}) GROUP BY d.subscriber_id`, refId, ...ch)
      : await all<{ sid: string; t0: number }>(env, `SELECT subscriber_id AS sid, MIN(created_at) AS t0 FROM automation_runs WHERE automation_id = ? AND created_at >= ? AND subscriber_id IN (${ph}) GROUP BY subscriber_id`, refId, since, ...ch);
    for (const r of treated) m.set(r.sid, { t0: r.t0, group: 'treated' });
    const held = await all<{ sid: string; t0: number }>(env, `SELECT subscriber_id AS sid, created_at AS t0 FROM holdout_members WHERE kind = ? AND ref_id = ? AND subscriber_id IN (${ph})`, kind, refId, ...ch);
    for (const r of held) if (!m.has(r.sid)) m.set(r.sid, { t0: r.t0, group: 'holdout' });
  }
  return m;
}

export interface LiftReport {
  kind: HoldoutKind; ref_id: string; pct: number; window_days: number;
  treated: number; holdout: number; complete: boolean; window_ends_at: number | null;
  purchase: PropTest; visit: PropTest; upgrade: PropTest; revenue: MeanTest;
  summary: string[];
}

/** Compare treated readers with the holdout over the conversion window. */
export async function liftReport(env: Env, pubId: string, kind: HoldoutKind, refId: string, windowDaysOverride?: number): Promise<LiftReport | null> {
  const cfg = await getHoldout(env, kind, refId, true);
  const holdoutStats = await one<{ n: number; t0: number; t1: number }>(env, 'SELECT COUNT(*) AS n, MIN(created_at) AS t0, MAX(created_at) AS t1 FROM holdout_members WHERE kind = ? AND ref_id = ?', kind, refId);
  if (!cfg && !holdoutStats?.n) return null;
  const win = clamp(Math.round(Number(windowDaysOverride || cfg?.window_days || 7)), 1, 60);
  const since = kind === 'automation' ? cfg?.started_at || holdoutStats?.t0 || 0 : 0;
  const tr = kind === 'post'
    ? await one<{ n: number; t0: number; t1: number }>(env, `SELECT COUNT(DISTINCT d.subscriber_id) AS n, MIN(COALESCE(d.sent_at, d.created_at)) AS t0, MAX(COALESCE(d.sent_at, d.created_at)) AS t1 FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = ? AND s.kind = 'post' AND d.status IN ('sent','complained') AND d.subscriber_id IS NOT NULL`, refId)
    : await one<{ n: number; t0: number; t1: number }>(env, `SELECT COUNT(DISTINCT subscriber_id) AS n, MIN(created_at) AS t0, MAX(created_at) AS t1 FROM automation_runs WHERE automation_id = ? AND created_at >= ?`, refId, since);
  const nT = tr?.n || 0, nH = holdoutStats?.n || 0;
  const starts = [tr?.t0, holdoutStats?.t0].filter((x): x is number => !!x);
  const ends = [tr?.t1, holdoutStats?.t1].filter((x): x is number => !!x);
  const from = starts.length ? Math.min(...starts) : now();
  const to = (ends.length ? Math.max(...ends) : now()) + win * DAY;

  // Conversions in [from, to]: our checkout orders, store orders, site visits by known readers, new paid subscriptions.
  const [orders, ext, visits, ups] = nT + nH ? await Promise.all([
    all<{ sid: string | null; email: string; amount: number; at: number }>(env, `SELECT subscriber_id AS sid, email, amount_cents AS amount, COALESCE(paid_at, created_at) AS at FROM orders WHERE pub_id = ? AND status = 'paid' AND created_at >= ? AND created_at <= ? LIMIT 20000`, pubId, from - DAY, to),
    all<{ sid: string | null; email: string; amount: number; at: number }>(env, `SELECT subscriber_id AS sid, email, total_cents AS amount, paid_at AS at FROM external_orders WHERE pub_id = ? AND status = 'paid' AND paid_at >= ? AND paid_at <= ? LIMIT 20000`, pubId, from, to),
    all<{ sid: string; at: number }>(env, `SELECT subscriber_id AS sid, created_at AS at FROM page_views WHERE pub_id = ? AND subscriber_id IS NOT NULL AND created_at >= ? AND created_at <= ? LIMIT 50000`, pubId, from, to),
    all<{ sid: string; at: number }>(env, `SELECT subscriber_id AS sid, created_at AS at FROM subscriptions WHERE pub_id = ? AND created_at >= ? AND created_at <= ? AND group_owner_id IS NULL LIMIT 20000`, pubId, from, to),
  ]) : [[], [], [], []];
  // store orders without a linked subscriber: match by email
  const needEmail = [...orders, ...ext].filter((o) => !o.sid && o.email).map((o) => o.email.toLowerCase());
  const byEmail = new Map<string, string>();
  for (const ch of chunk([...new Set(needEmail)], 80)) {
    for (const s of await all<{ id: string; email: string }>(env, `SELECT id, email FROM subscribers WHERE pub_id = ? AND email IN (${ch.map(() => '?').join(',')})`, pubId, ...ch)) byEmail.set(s.email, s.id);
  }
  const buys = [...orders, ...ext].map((o) => ({ sid: o.sid || byEmail.get(String(o.email || '').toLowerCase()) || null, amount: o.amount || 0, at: o.at })).filter((o): o is { sid: string; amount: number; at: number } => !!o.sid);
  const mem = await membership(env, kind, refId, since, [...buys.map((b) => b.sid), ...visits.map((v) => v.sid), ...ups.map((u) => u.sid)]);
  const inWin = (sid: string, at: number) => { const m = mem.get(sid); return m && at >= m.t0 && at <= m.t0 + win * DAY ? m : null; };

  const conv = { treated: { buy: new Set<string>(), visit: new Set<string>(), up: new Set<string>() }, holdout: { buy: new Set<string>(), visit: new Set<string>(), up: new Set<string>() } };
  const rev = { treated: new Map<string, number>(), holdout: new Map<string, number>() };
  for (const b of buys) { const m = inWin(b.sid, b.at); if (!m) continue; conv[m.group].buy.add(b.sid); rev[m.group].set(b.sid, (rev[m.group].get(b.sid) || 0) + b.amount); }
  for (const v of visits) { const m = inWin(v.sid, v.at); if (m) conv[m.group].visit.add(v.sid); }
  for (const u of ups) { const m = inWin(u.sid, u.at); if (m) conv[m.group].up.add(u.sid); }
  const sums = (g: Map<string, number>) => { let s = 0, ss = 0; for (const v of g.values()) { s += v; ss += v * v; } return [s, ss] as const; };
  const [sT, ssT] = sums(rev.treated), [sH, ssH] = sums(rev.holdout);

  const purchase = twoProportion(conv.treated.buy.size, nT, conv.holdout.buy.size, nH);
  const visit = twoProportion(conv.treated.visit.size, nT, conv.holdout.visit.size, nH);
  const upgrade = twoProportion(conv.treated.up.size, nT, conv.holdout.up.size, nH);
  const revenue = twoMeans(sT, ssT, nT, sH, ssH, nH);
  const windowEnds = ends.length ? Math.max(...ends) + win * DAY : null;
  const report: LiftReport = { kind, ref_id: refId, pct: cfg?.pct || 0, window_days: win, treated: nT, holdout: nH, complete: !!windowEnds && windowEnds <= now(), window_ends_at: windowEnds, purchase, visit, upgrade, revenue, summary: [] };
  report.summary = explain(report);
  return report;
}

const pts = (x: number) => `${(x * 100).toFixed(1)}%`;
const signed = (x: number, f: (n: number) => string) => (x >= 0 ? '+' : '−') + f(Math.abs(x));
const usd = (c: number) => (c < 0 ? '−$' : '$') + (Math.abs(c) / 100).toFixed(2);

/** Plain-English reading of the lift report. */
export function explain(r: LiftReport): string[] {
  const out: string[] = [];
  const what = r.kind === 'post' ? 'got this email' : 'entered this automation';
  if (!r.holdout) return [`No readers have been held back yet. Once ${r.pct || 0}% of eligible readers are held back, this compares them with readers who ${what}.`];
  if (r.holdout < 30 || r.treated < 30) out.push(`Only ${r.holdout} held-back and ${r.treated} treated readers so far — too few to tell a real effect from chance. Treat these numbers as early signals.`);
  const p = r.purchase;
  out.push(`Readers who ${what} placed an order ${pts(p.treated.rate)} of the time vs ${pts(p.holdout.rate)} for the holdout: ${signed(p.diff * 100, (n) => n.toFixed(1))} points (95% range ${(p.ci[0] * 100).toFixed(1)} to ${(p.ci[1] * 100).toFixed(1)} points)${p.lift !== null ? `, a ${Math.round(p.lift * 100)}% lift` : ''}.`);
  out.push(p.significant
    ? `With p = ${p.p.toFixed(3)}, a difference this large would be unlikely (under 5%) if the email had no effect — it's a real lift.`
    : `With p = ${p.p.toFixed(2)}, this could still be chance: the 95% range includes zero. Keep the test running for a clearer answer.`);
  out.push(`Revenue per reader: ${usd(r.revenue.treated.mean)} vs ${usd(r.revenue.holdout.mean)} — about ${signed(r.revenue.incremental, usd)} of incremental revenue across ${r.treated} treated readers (95% range per reader ${usd(r.revenue.ci[0])} to ${usd(r.revenue.ci[1])}).`);
  if (!r.complete) out.push(`The ${r.window_days}-day conversion window is still open, so these numbers will keep moving.`);
  return out;
}
