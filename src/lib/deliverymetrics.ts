// Delivery metrics per publication, per send, per mailbox provider and over time (Analytics → Deliverability → Guardian,
// the Guardian job, the platform view). Computed from `deliveries` (newsletters + automation emails; test sends left out).
//
// Definitions (all over deliveries that were attempted: status not queued / scheduled / suppressed):
//   attempted        handed to Cloudflare Email Sending at least once (or failed trying)
//   accepted         the provider accepted it: status sent or complained (a complaint means it was delivered)
//   accepted rate    accepted / attempted
//   hard bounce rate hard bounces / attempted
//   complaint rate   complaints / accepted
//   deferral rate    deliveries that hit 'deferred' at least once (still deferred, or needed more than one attempt) / attempted
//   time to delivery created → accepted (sent_at). Timed / send-time-optimized deliveries count from their planned time.
//   auth pass rate   DMARC-aligned pass (DKIM or SPF aligned) from aggregate reports for the publication's domains (lib/dmarc)
//   cost             Cloudflare Email Sending: $0.35 per 1,000 messages after the account's first 3,000 each month.
//                    billable = send attempts (retries count). The free 3,000 are shared by the whole install, so each
//                    month's cost is apportioned: cost = billable × $0.00035 × max(0, install_month − 3000) / install_month.
//                    The Workers base subscription ($5/month) is shared infrastructure and not allocated per email.
//   revenue / 1,000  SIMPLE attribution, labelled as such: paid orders from a reader within 7 days after an email from
//                    this scope was accepted for them (each order counted once per scope), × 1000 / accepted.
import type { Env } from '../types';
import { all, one } from './db';
import { authSummary, pubSendingDomains } from './dmarc';
import { now, DAY } from './util';

export const PRICE = { perMessageUsd: 0.35 / 1000, freePerMonth: 3000, workersBaseUsd: 5 };
export const ATTRIBUTION_DAYS = 7;

export interface Scope { pubId?: string; workspaceId?: string; sendId?: string; provider?: string }

export interface Metrics {
  attempted: number; accepted: number; hard: number; bounced: number; complaints: number; deferred: number; billable: number;
  acceptedRate: number | null; hardRate: number | null; complaintRate: number | null; deferralRate: number | null;
  ttdMedianMs: number | null; ttdP95Ms: number | null;
  authPassRate: number | null; authMessages: number;
  costUsd: number; costPerAcceptedUsd: number | null;
  revenueCents: number; revenuePer1kCents: number | null;
}

const ATTEMPTED = `d.status NOT IN ('queued','scheduled','suppressed')`;
const NOT_TEST = `d.send_id NOT IN (SELECT id FROM sends WHERE kind = 'test')`;
const DEFERRED_EVER = `(d.status = 'deferred' OR d.attempts > 1)`;
const ACCEPTED = `d.status IN ('sent','complained')`;

function where(s: Scope, from: number, to: number): { sql: string; params: unknown[] } {
  const w = [ATTEMPTED, NOT_TEST, 'd.created_at >= ?', 'd.created_at < ?'];
  const p: unknown[] = [from, to];
  if (s.sendId) { w.push('d.send_id = ?'); p.push(s.sendId); }
  if (s.pubId) { w.push('d.pub_id = ?'); p.push(s.pubId); }
  if (s.workspaceId) { w.push('d.pub_id IN (SELECT id FROM publications WHERE workspace_id = ?)'); p.push(s.workspaceId); }
  if (s.provider) { w.push(s.provider === 'other' ? `COALESCE(d.provider, 'other') NOT IN ('gmail','outlook','yahoo','apple')` : 'd.provider = ?'); if (s.provider !== 'other') p.push(s.provider); }
  return { sql: w.join(' AND '), params: p };
}

const COUNTS = `COUNT(*) AS attempted,
  SUM(CASE WHEN ${ACCEPTED} THEN 1 ELSE 0 END) AS accepted,
  SUM(CASE WHEN d.status = 'bounced' AND d.bounce_type = 'hard' THEN 1 ELSE 0 END) AS hard,
  SUM(CASE WHEN d.status = 'bounced' THEN 1 ELSE 0 END) AS bounced,
  SUM(CASE WHEN d.status = 'complained' THEN 1 ELSE 0 END) AS complaints,
  SUM(CASE WHEN ${DEFERRED_EVER} THEN 1 ELSE 0 END) AS deferred,
  SUM(MAX(d.attempts, 1)) AS billable`;

// planned send time: timed sends park rows as 'scheduled' with next_attempt_at = planned time; one attempt, no deferral
const TTD = `(d.sent_at - CASE WHEN d.attempts <= 1 AND d.next_attempt_at IS NOT NULL AND d.next_attempt_at > d.created_at AND d.next_attempt_at <= d.sent_at THEN d.next_attempt_at ELSE d.created_at END)`;

const ratio = (a: number, b: number) => (b ? a / b : null);

/** Install-wide billable messages per month (for apportioning the free tier). */
async function monthlyInstallBillable(env: Env, from: number, to: number): Promise<Map<string, number>> {
  const rows = await all<any>(env, `SELECT strftime('%Y-%m', d.created_at / 1000, 'unixepoch') AS m, SUM(MAX(d.attempts, 1)) AS n FROM deliveries d WHERE ${ATTEMPTED} AND d.created_at >= ? AND d.created_at < ? GROUP BY m`, monthStartOf(from), to);
  const tx = await all<any>(env, `SELECT strftime('%Y-%m', created_at / 1000, 'unixepoch') AS m, COUNT(*) AS n FROM outbox WHERE status = 'sent' AND kind = 'transactional' AND created_at >= ? AND created_at < ? GROUP BY m`, monthStartOf(from), to).catch(() => []);
  const out = new Map<string, number>();
  for (const r of [...rows, ...tx]) out.set(r.m, (out.get(r.m) || 0) + Number(r.n || 0));
  return out;
}
function monthStartOf(t: number) { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }

/** Cost in USD of `billable` messages sent in `month` given the install's total that month. */
export function costFor(billable: number, installMonth: number): number {
  if (!billable || !installMonth) return 0;
  const paidShare = Math.max(0, installMonth - PRICE.freePerMonth) / installMonth;
  return billable * PRICE.perMessageUsd * paidShare;
}

async function percentile(env: Env, w: { sql: string; params: unknown[] }, n: number, q: number): Promise<number | null> {
  if (!n) return null;
  const off = Math.min(n - 1, Math.floor((n - 1) * q));
  const r = await one<any>(env, `SELECT ${TTD} AS t FROM deliveries d WHERE ${w.sql} AND ${ACCEPTED} AND d.sent_at IS NOT NULL ORDER BY t LIMIT 1 OFFSET ?`, ...w.params, off);
  return r ? Math.max(0, Number(r.t)) : null;
}

export async function deliveryMetrics(env: Env, s: Scope, from: number, to = now(), o: { auth?: boolean; money?: boolean } = {}): Promise<Metrics> {
  const w = where(s, from, to);
  const t = await one<any>(env, `SELECT ${COUNTS} FROM deliveries d WHERE ${w.sql}`, ...w.params);
  const attempted = Number(t?.attempted || 0), accepted = Number(t?.accepted || 0), hard = Number(t?.hard || 0), bounced = Number(t?.bounced || 0);
  const complaints = Number(t?.complaints || 0), deferred = Number(t?.deferred || 0), billable = Number(t?.billable || 0);
  const nT = Number((await one<any>(env, `SELECT COUNT(*) AS n FROM deliveries d WHERE ${w.sql} AND ${ACCEPTED} AND d.sent_at IS NOT NULL`, ...w.params))?.n || 0);
  const [med, p95] = await Promise.all([percentile(env, w, nT, 0.5), percentile(env, w, nT, 0.95)]);

  let costUsd = 0;
  if (o.money !== false && billable) {
    const perMonth = await all<any>(env, `SELECT strftime('%Y-%m', d.created_at / 1000, 'unixepoch') AS m, SUM(MAX(d.attempts, 1)) AS n FROM deliveries d WHERE ${w.sql} GROUP BY m`, ...w.params);
    const install = await monthlyInstallBillable(env, from, to);
    for (const r of perMonth) costUsd += costFor(Number(r.n || 0), install.get(r.m) || Number(r.n || 0));
  }

  let revenueCents = 0;
  if (o.money !== false && accepted) {
    const rv = await one<any>(env, `SELECT SUM(o.amount_cents) AS c FROM orders o WHERE o.status = 'paid' AND o.subscriber_id IS NOT NULL
        AND o.created_at >= ? AND o.created_at < ?
        AND EXISTS (SELECT 1 FROM deliveries d WHERE ${w.sql} AND ${ACCEPTED} AND d.subscriber_id = o.subscriber_id AND d.sent_at <= o.created_at AND d.sent_at > o.created_at - ?)`,
      from, to + ATTRIBUTION_DAYS * DAY, ...w.params, ATTRIBUTION_DAYS * DAY).catch(() => null);
    revenueCents = Number(rv?.c || 0);
  }

  let authPassRate: number | null = null, authMessages = 0;
  if (o.auth !== false && s.pubId && !s.sendId) {
    const a = await authSummary(env, await pubSendingDomains(env, s.pubId), from, to);
    authPassRate = a.passRate; authMessages = a.messages;
  }

  return {
    attempted, accepted, hard, bounced, complaints, deferred, billable,
    acceptedRate: ratio(accepted, attempted), hardRate: ratio(hard, attempted), complaintRate: ratio(complaints, accepted), deferralRate: ratio(deferred, attempted),
    ttdMedianMs: med, ttdP95Ms: p95, authPassRate, authMessages,
    costUsd, costPerAcceptedUsd: accepted ? costUsd / accepted : null,
    revenueCents, revenuePer1kCents: accepted ? (revenueCents * 1000) / accepted : null,
  };
}

export interface ProviderRow { provider: string; attempted: number; accepted: number; hard: number; complaints: number; deferred: number; acceptedRate: number | null; hardRate: number | null; complaintRate: number | null; deferralRate: number | null; ttdMedianMs: number | null }

/** Throttle / Guardian provider buckets: gmail, outlook, yahoo, apple, other. */
export const PROVIDERS = ['gmail', 'outlook', 'yahoo', 'apple', 'other'] as const;
export const PROVIDER_NAME: Record<string, string> = { gmail: 'Gmail', outlook: 'Microsoft (Outlook/Hotmail)', yahoo: 'Yahoo/AOL', apple: 'Apple iCloud', other: 'Other providers' };
export const bucket = (p: string | null | undefined) => (PROVIDERS as readonly string[]).includes(p || '') ? (p as string) : 'other';

export async function metricsByProvider(env: Env, s: Scope, from: number, to = now()): Promise<ProviderRow[]> {
  const w = where(s, from, to);
  const rows = await all<any>(env, `SELECT CASE WHEN d.provider IN ('gmail','outlook','yahoo','apple') THEN d.provider ELSE 'other' END AS provider, ${COUNTS} FROM deliveries d WHERE ${w.sql} GROUP BY 1 ORDER BY attempted DESC`, ...w.params);
  const out: ProviderRow[] = [];
  for (const r of rows) {
    const attempted = Number(r.attempted || 0), accepted = Number(r.accepted || 0);
    const wp = where({ ...s, provider: r.provider }, from, to);
    const nT = Number((await one<any>(env, `SELECT COUNT(*) AS n FROM deliveries d WHERE ${wp.sql} AND ${ACCEPTED} AND d.sent_at IS NOT NULL`, ...wp.params))?.n || 0);
    out.push({
      provider: r.provider, attempted, accepted, hard: Number(r.hard || 0), complaints: Number(r.complaints || 0), deferred: Number(r.deferred || 0),
      acceptedRate: ratio(accepted, attempted), hardRate: ratio(Number(r.hard || 0), attempted), complaintRate: ratio(Number(r.complaints || 0), accepted), deferralRate: ratio(Number(r.deferred || 0), attempted),
      ttdMedianMs: await percentile(env, wp, nT, 0.5),
    });
  }
  return out;
}

export interface SeriesPoint { day: string; attempted: number; accepted: number; hard: number; complaints: number; deferred: number }

/** Daily series (UTC days) between from and to. */
export async function metricsSeries(env: Env, s: Scope, from: number, to = now()): Promise<SeriesPoint[]> {
  const w = where(s, from, to);
  const rows = await all<any>(env, `SELECT strftime('%Y-%m-%d', d.created_at / 1000, 'unixepoch') AS day, ${COUNTS} FROM deliveries d WHERE ${w.sql} GROUP BY day ORDER BY day`, ...w.params);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: SeriesPoint[] = [];
  for (let t = Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), new Date(from).getUTCDate()); t < to; t += DAY) {
    const day = new Date(t).toISOString().slice(0, 10);
    const r = byDay.get(day);
    out.push({ day, attempted: Number(r?.attempted || 0), accepted: Number(r?.accepted || 0), hard: Number(r?.hard || 0), complaints: Number(r?.complaints || 0), deferred: Number(r?.deferred || 0) });
  }
  return out;
}

export interface SendRow { id: string; subject: string; kind: string; created_at: number; m: Metrics }

/** Per-send metrics for a publication's most recent sends (newsletters + automation steps). */
export async function sendMetrics(env: Env, pubId: string, limit = 15): Promise<SendRow[]> {
  const sends = await all<any>(env, `SELECT id, subject, kind, created_at FROM sends WHERE pub_id = ? AND kind != 'test' AND status != 'cancelled' AND EXISTS (SELECT 1 FROM deliveries d WHERE d.send_id = sends.id AND ${ATTEMPTED}) ORDER BY created_at DESC LIMIT ?`, pubId, limit);
  const out: SendRow[] = [];
  for (const s of sends) out.push({ ...s, m: await deliveryMetrics(env, { pubId, sendId: s.id }, 0, now() + DAY, { auth: false }) });
  return out;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}
