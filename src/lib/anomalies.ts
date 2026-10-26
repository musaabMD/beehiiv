// Anomaly detection: compares the last 24 hours with the trailing 14-day baseline (14 previous 24-hour windows) for
// unsubscribes, bounces, complaints, signups, revenue and site traffic, and each recent newsletter's open rate with the
// open rates of the sends before it. Big deviations are stored (one per publication / metric / day), shown as a
// dismissible alert on the dashboard home and Analytics overview, and emailed to the owner once.
import type { Env, Publication } from '../types';
import { all, one, run, insert } from './db';
import { registerPeriodic } from './jobs';
import { sendTransactional, button } from './email';
import { appUrl } from './pub';
import { id, now, DAY, HOUR, esc } from './util';

/** How many standard deviations above/below the baseline counts as an anomaly. */
export const Z_THRESHOLD = 3;
/** z-score at which an anomaly in the bad direction becomes critical. */
export const Z_CRITICAL = 5;
/** Spikes must also be at least this many times the baseline average… */
export const SPIKE_RATIO = 2;
/** …and drops at most this share of it. */
export const DROP_RATIO = 0.5;
export const BASELINE_DAYS = 14;
/** Open rate of one send vs the sends before it: drop of at least this many percentage points and this z-score. */
export const OPEN_RATE_DROP_POINTS = 8;
export const OPEN_RATE_Z = 2;
export const OPEN_RATE_MIN_DELIVERED = 50;
export const OPEN_RATE_MIN_BASELINE_SENDS = 3;
export const CHECK_INTERVAL = 6 * HOUR;

type Dir = 'up' | 'down';
interface MetricDef {
  label: string; unit?: 'money';
  /** SQL returning (b = window index 0..14, v) rows; bound params: pubId, at, from */
  sql: string;
  /** which directions to flag and whether they are bad */
  watch: Partial<Record<Dir, 'bad' | 'good'>>;
  /** ignore unless the larger of today / baseline average is at least this (avoids noise on tiny numbers) */
  min: number;
  href: string;
}

const W = (col: string) => `CAST((?2 - ${col}) / ${DAY} AS INTEGER)`;
export const METRICS: Record<string, MetricDef> = {
  unsubscribes: { label: 'Unsubscribes', sql: `SELECT ${W('unsubscribed_at')} AS b, COUNT(*) AS v FROM subscribers WHERE pub_id = ?1 AND unsubscribed_at > ?3 AND unsubscribed_at <= ?2 GROUP BY b`, watch: { up: 'bad' }, min: 5, href: '/app/analytics/subscribers' },
  bounces: { label: 'Bounces', sql: `SELECT ${W('created_at')} AS b, COUNT(*) AS v FROM deliveries WHERE pub_id = ?1 AND status = 'bounced' AND created_at > ?3 AND created_at <= ?2 GROUP BY b`, watch: { up: 'bad' }, min: 10, href: '/app/analytics/deliverability' },
  complaints: { label: 'Spam complaints', sql: `SELECT ${W('created_at')} AS b, COUNT(*) AS v FROM deliveries WHERE pub_id = ?1 AND status = 'complained' AND created_at > ?3 AND created_at <= ?2 GROUP BY b`, watch: { up: 'bad' }, min: 3, href: '/app/analytics/deliverability' },
  signups: { label: 'New subscribers', sql: `SELECT ${W('created_at')} AS b, COUNT(*) AS v FROM subscribers WHERE pub_id = ?1 AND source != 'try_it' AND created_at > ?3 AND created_at <= ?2 GROUP BY b`, watch: { up: 'good', down: 'bad' }, min: 10, href: '/app/analytics/subscribers' },
  revenue: { label: 'Revenue', unit: 'money', sql: `SELECT ${W('paid_at')} AS b, SUM(amount_cents) AS v FROM orders WHERE pub_id = ?1 AND status = 'paid' AND paid_at > ?3 AND paid_at <= ?2 GROUP BY b`, watch: { up: 'good', down: 'bad' }, min: 5000, href: '/app/analytics/revenue' },
  traffic: { label: 'Website page views', sql: `SELECT ${W('created_at')} AS b, COUNT(*) AS v FROM page_views WHERE pub_id = ?1 AND created_at > ?3 AND created_at <= ?2 GROUP BY b`, watch: { up: 'good', down: 'bad' }, min: 100, href: '/app/analytics/web' },
};

export interface Finding { metric: string; ref_id: string; direction: Dir; severity: 'critical' | 'warning' | 'good'; value: number; baseline: number; z: number | null; message: string; href: string }

const fmt = (m: MetricDef, n: number) => (m.unit === 'money' ? '$' + (n / 100).toLocaleString('en-US', { maximumFractionDigits: 0 }) : Math.round(n).toLocaleString('en-US'));
const fmt1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-US');

/** Mean and (population) standard deviation. */
export function stats(xs: number[]) {
  const mean = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length || 1));
  return { mean, sd };
}

/** Decide whether `today` is anomalous against `baseline` values. Counts use a Poisson floor on the deviation. */
export function judge(m: MetricDef, today: number, baseline: number[]): { direction: Dir; z: number; severity: Finding['severity'] } | null {
  const { mean, sd } = stats(baseline);
  if (Math.max(today, mean) < m.min) return null;
  const floor = m.unit === 'money' ? Math.max(sd, mean * 0.25, 100) : Math.max(sd, Math.sqrt(Math.max(mean, 1)));
  const z = (today - mean) / floor;
  const dir: Dir | null = z >= Z_THRESHOLD && today >= mean * SPIKE_RATIO ? 'up' : z <= -Z_THRESHOLD && today <= mean * DROP_RATIO ? 'down' : null;
  if (!dir || !m.watch[dir]) return null;
  const bad = m.watch[dir] === 'bad';
  return { direction: dir, z, severity: !bad ? 'good' : Math.abs(z) >= Z_CRITICAL ? 'critical' : 'warning' };
}

/** Run every check for one publication; returns what's anomalous right now (not yet stored). */
export async function detect(env: Env, pubId: string, at = now()): Promise<Finding[]> {
  const from = at - (BASELINE_DAYS + 1) * DAY;
  const out: Finding[] = [];
  for (const [key, m] of Object.entries(METRICS)) {
    const rows = await all<{ b: number; v: number }>(env, m.sql, pubId, at, from);
    const series = Array.from({ length: BASELINE_DAYS + 1 }, (_, i) => Number(rows.find((r) => Number(r.b) === i)?.v) || 0);
    const today = series[0];
    const base = series.slice(1);
    const j = judge(m, today, base);
    if (!j) continue;
    const { mean } = stats(base);
    const ratio = mean ? today / mean : null;
    const change = j.direction === 'up' ? (ratio ? `${fmt1(ratio)}× the usual` : 'up from almost none') : `down ${Math.round((1 - today / (mean || 1)) * 100)}% from the usual`;
    out.push({
      metric: key, ref_id: '', direction: j.direction, severity: j.severity, value: today, baseline: mean, z: Math.round(j.z * 10) / 10,
      message: `${m.label} in the last 24 hours: ${fmt(m, today)} — ${change} ${fmt(m, mean)} a day over the previous ${BASELINE_DAYS} days.`, href: m.href,
    });
  }
  // open rate per send: sends that started 1–3 days ago vs post sends in the 14 days before them
  const recent = await all<any>(env, `SELECT se.id, se.post_id, se.subject, se.created_at,
      SUM(CASE WHEN d.status IN ('sent','complained') THEN 1 ELSE 0 END) AS delivered, SUM(CASE WHEN d.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened
    FROM sends se JOIN deliveries d ON d.send_id = se.id
    WHERE se.pub_id = ? AND se.kind = 'post' AND se.created_at BETWEEN ? AND ? GROUP BY se.id`, pubId, at - 3 * DAY, at - DAY);
  for (const s of recent) {
    if (Number(s.delivered) < OPEN_RATE_MIN_DELIVERED) continue;
    const prior = await all<any>(env, `SELECT SUM(CASE WHEN d.status IN ('sent','complained') THEN 1 ELSE 0 END) AS delivered, SUM(CASE WHEN d.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened
      FROM sends se JOIN deliveries d ON d.send_id = se.id WHERE se.pub_id = ? AND se.kind = 'post' AND se.id != ? AND se.created_at BETWEEN ? AND ? GROUP BY se.id`, pubId, s.id, s.created_at - BASELINE_DAYS * DAY, s.created_at - 1);
    const rates = prior.filter((p) => Number(p.delivered) >= OPEN_RATE_MIN_DELIVERED).map((p) => (Number(p.opened) / Number(p.delivered)) * 100);
    if (rates.length < OPEN_RATE_MIN_BASELINE_SENDS) continue;
    const rate = (Number(s.opened) / Number(s.delivered)) * 100;
    const { mean, sd } = stats(rates);
    const z = (rate - mean) / Math.max(sd, 2);
    if (mean - rate < OPEN_RATE_DROP_POINTS || z > -OPEN_RATE_Z) continue;
    out.push({
      metric: 'open_rate', ref_id: s.id, direction: 'down', severity: z <= -Z_CRITICAL ? 'critical' : 'warning', value: rate, baseline: mean, z: Math.round(z * 10) / 10,
      message: `“${s.subject}” has a ${fmt1(rate)}% open rate — ${fmt1(mean - rate)} points below your recent average of ${fmt1(mean)}%. Check inbox placement for that send.`,
      href: s.post_id ? `/app/analytics/deliverability?post=${s.post_id}` : '/app/analytics/deliverability',
    });
  }
  return out;
}

const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Detect + store new anomalies for one publication; emails the owner about the new ones (once each). */
export async function checkPublication(env: Env, pub: Publication, at = now()): Promise<number> {
  const found = await detect(env, pub.id, at);
  const fresh: Array<Finding & { id: string }> = [];
  for (const f of found) {
    // one row per metric/day/ref; a still-running spike detected again later the same day is not new
    const exists = await one(env, 'SELECT 1 AS x FROM anomalies WHERE pub_id = ? AND metric = ? AND ref_id = ? AND (day = ? OR created_at > ?)', pub.id, f.metric, f.ref_id, dayKey(at), at - DAY);
    if (exists) continue;
    const aid = id();
    await insert(env, 'anomalies', { id: aid, pub_id: pub.id, metric: f.metric, day: dayKey(at), ref_id: f.ref_id, direction: f.direction, severity: f.severity, value: f.value, baseline: f.baseline, z: f.z, message: f.message, href: f.href, created_at: at });
    fresh.push({ ...f, id: aid });
  }
  if (fresh.length) await emailOwner(env, pub, fresh);
  return fresh.length;
}

async function emailOwner(env: Env, pub: Publication, list: Array<Finding & { id: string }>) {
  const owner = await one<{ email: string; name: string }>(env, 'SELECT u.email, u.name FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE w.id = ?', pub.workspace_id);
  if (!owner) return;
  const bad = list.filter((x) => x.severity !== 'good');
  const subject = bad.length ? `Unusual activity on ${pub.name}: ${list[0].message.split(':')[0].toLowerCase()}${list.length > 1 ? ` and ${list.length - 1} more` : ''}` : `Good news on ${pub.name}: ${list[0].message.split(':')[0].toLowerCase()} is way up`;
  const body = `<p>We compare the last 24 hours with your previous ${BASELINE_DAYS} days every few hours. This stood out:</p>
<ul>${list.map((x) => `<li style="margin-bottom:8px"><strong>${x.severity === 'good' ? '▲' : x.severity === 'critical' ? '⚠️' : '•'}</strong> ${esc(x.message)}</li>`).join('')}</ul>
${button('Open your dashboard', appUrl(env, '/app'))}<p style="font-size:13px;color:#6b7280">You get one email per anomaly. Dismiss alerts from the dashboard once you've looked into them.</p>`;
  const r = await sendTransactional(env, owner.email, subject, body, pub);
  if (r.ok) for (const x of list) await run(env, 'UPDATE anomalies SET emailed_at = ? WHERE id = ?', now(), x.id);
}

/** Undismissed anomalies from the last week (dashboard home + Analytics overview). */
export async function activeAnomalies(env: Env, pubId: string, limit = 5) {
  return all<{ id: string; metric: string; severity: string; direction: string; message: string; href: string | null; created_at: number }>(env,
    `SELECT id, metric, severity, direction, message, href, created_at FROM anomalies WHERE pub_id = ? AND dismissed_at IS NULL AND created_at > ? ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC LIMIT ?`,
    pubId, now() - 7 * DAY, limit);
}

export async function dismissAnomaly(env: Env, pubId: string, anomalyId: string) {
  await run(env, 'UPDATE anomalies SET dismissed_at = ? WHERE id = ? AND pub_id = ?', now(), anomalyId, pubId);
}

registerPeriodic('intel.anomalies', CHECK_INTERVAL, async (env) => {
  const pubs = await all<Publication>(env, `SELECT p.* FROM publications p WHERE p.status = 'active' AND EXISTS (SELECT 1 FROM subscribers s WHERE s.pub_id = p.id AND s.status = 'active')`);
  for (const p of pubs) await checkPublication(env, p);
});
