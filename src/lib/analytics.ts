// Reusable analytics queries for the dashboard, API and MCP server.
// All functions are scoped by pub_id, use parameterized SQL, and filter bot traffic out of engagement numbers.
import type { Env } from '../types';
import { all, one, val } from './db';
import { DAY, HOUR, MIN } from './util';

// ───────── ranges ─────────
export interface Range { from: number; to: number; key: string; label: string }

export const PRESETS: Array<[string, string]> = [['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['365d', 'Last 12 months'], ['mtd', 'Month to date'], ['ytd', 'Year to date'], ['all', 'All time']];

export function parseRange(q: { range?: string; from?: string; to?: string }, def = '30d'): Range {
  const now = Date.now();
  if (q.from && q.to) {
    const from = Date.parse(q.from + 'T00:00:00Z'), to = Date.parse(q.to + 'T23:59:59Z');
    if (!isNaN(from) && !isNaN(to) && to > from) return { from, to, key: 'custom', label: `${q.from} → ${q.to}` };
  }
  const key = PRESETS.some(([k]) => k === q.range) ? q.range! : def;
  const d = new Date(now);
  let from: number;
  switch (key) {
    case '7d': from = now - 7 * DAY; break;
    case '90d': from = now - 90 * DAY; break;
    case '365d': from = now - 365 * DAY; break;
    case 'mtd': from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); break;
    case 'ytd': from = Date.UTC(d.getUTCFullYear(), 0, 1); break;
    case 'all': from = Date.UTC(2020, 0, 1); break;
    default: from = now - 30 * DAY;
  }
  return { from, to: now, key, label: PRESETS.find(([k]) => k === key)![1] };
}

export function previous(r: Range): Range {
  const len = r.to - r.from;
  return { from: r.from - len, to: r.from, key: 'prev', label: 'Previous period' };
}

export function delta(cur: number, prev: number): number | null {
  if (!prev) return cur ? null : 0;
  return ((cur - prev) / prev) * 100;
}

export type Bucket = 'hour' | 'day' | 'week' | 'month';
export function autoBucket(r: Range): Bucket {
  const days = (r.to - r.from) / DAY;
  return days <= 2 ? 'hour' : days <= 95 ? 'day' : days <= 400 ? 'week' : 'month';
}
const FMT: Record<Bucket, string> = { hour: '%Y-%m-%d %H:00', day: '%Y-%m-%d', week: '%Y-W%W', month: '%Y-%m' };
const bucketSql = (col: string, b: Bucket) => `strftime('${FMT[b]}', ${col} / 1000, 'unixepoch')`;

/** All bucket labels in a range (so charts show zero days). */
export function bucketLabels(r: Range, b: Bucket): string[] {
  const out: string[] = [];
  const step = b === 'hour' ? HOUR : DAY;
  const seen = new Set<string>();
  const start = b === 'hour' ? r.from - (r.from % HOUR) : r.from - (r.from % DAY);
  for (let t = start; t <= r.to; t += step) {
    const d = new Date(t);
    const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0'), day = String(d.getUTCDate()).padStart(2, '0');
    let label: string;
    if (b === 'hour') label = `${y}-${m}-${day} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
    else if (b === 'day') label = `${y}-${m}-${day}`;
    else if (b === 'month') label = `${y}-${m}`;
    else label = `${y}-W${String(weekNum(d)).padStart(2, '0')}`;
    if (!seen.has(label)) { seen.add(label); out.push(label); }
    if (out.length > 1000) break;
  }
  return out;
}
// SQLite %W: week of year, Monday as first day, days before first Monday are week 00.
function weekNum(d: Date): number {
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((d.getTime() - jan1) / DAY);
  const jan1Dow = (new Date(jan1).getUTCDay() + 6) % 7; // Monday=0
  return Math.floor((dayOfYear + jan1Dow) / 7);
}

export function shortLabel(l: string, b: Bucket): string {
  if (b === 'day') { const [, m, d] = l.split('-'); return `${Number(m)}/${Number(d)}`; }
  if (b === 'hour') return l.slice(11, 16);
  if (b === 'month') { const [y, m] = l.split('-'); return new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) + ' ' + y.slice(2); }
  return l.slice(5);
}

// ───────── generic report engine (custom reports + most charts) ─────────
export interface Filter { field: string; op: 'eq' | 'neq' | 'contains' | 'not_contains' | 'gt' | 'lt'; value: string }

interface MetricDef {
  label: string;
  from: string;               // FROM ... (alias t)
  time: string;               // time column expression
  value: string;              // aggregate expression
  where?: string;             // extra base condition
  money?: boolean;
  dims: Record<string, [string, string]>; // key → [label, sql expr]
}

const PV_DIMS: Record<string, [string, string]> = {
  channel: ['Channel', 't.channel'], country: ['Country', 't.country'], device: ['Device', 't.device'], os: ['OS', 't.os'], browser: ['Browser', 't.browser'],
  path: ['Page', 't.path'], referrer: ['Referrer', `COALESCE(NULLIF(substr(t.referrer, instr(t.referrer, '://') + 3, CASE WHEN instr(substr(t.referrer, instr(t.referrer, '://') + 3), '/') > 0 THEN instr(substr(t.referrer, instr(t.referrer, '://') + 3), '/') - 1 ELSE 200 END), ''), '(direct)')`],
  utm_source: ['UTM source', 't.utm_source'], utm_medium: ['UTM medium', 't.utm_medium'], utm_campaign: ['UTM campaign', 't.utm_campaign'],
};
const SUB_DIMS: Record<string, [string, string]> = {
  source: ['Acquisition source', 't.source'], country: ['Country', 't.country'], tier: ['Tier', 't.tier'], status: ['Status', 't.status'],
  utm_source: ['UTM source', 't.utm_source'], utm_medium: ['UTM medium', 't.utm_medium'], utm_campaign: ['UTM campaign', 't.utm_campaign'], landing_path: ['Landing page', 't.landing_path'],
};
const POST_TITLE = `(SELECT p.title FROM sends se JOIN posts p ON p.id = se.post_id WHERE se.id = t.send_id)`;

export const METRICS: Record<string, MetricDef> = {
  subscribers: { label: 'New subscribers', from: 'subscribers t', time: 't.created_at', value: 'COUNT(*)', dims: SUB_DIMS },
  unsubscribes: { label: 'Unsubscribes', from: 'subscribers t', time: 't.unsubscribed_at', value: 'COUNT(*)', where: 't.unsubscribed_at IS NOT NULL', dims: SUB_DIMS },
  page_views: { label: 'Page views', from: 'page_views t', time: 't.created_at', value: 'COUNT(*)', dims: PV_DIMS },
  visitors: { label: 'Unique visitors', from: 'page_views t', time: 't.created_at', value: 'COUNT(DISTINCT t.visitor_id)', dims: PV_DIMS },
  emails: { label: 'Emails delivered', from: 'deliveries t', time: 't.created_at', value: 'COUNT(*)', where: "t.status = 'sent'", dims: { provider: ['Mailbox provider', 't.provider'], post: ['Post', POST_TITLE], variant: ['Variant', 't.variant'] } },
  opens: { label: 'Unique opens', from: 'deliveries t', time: 't.opened_at', value: 'COUNT(*)', where: 't.opened_at IS NOT NULL', dims: { provider: ['Mailbox provider', 't.provider'], post: ['Post', POST_TITLE], variant: ['Variant', 't.variant'] } },
  clicks: { label: 'Clicks (bot-filtered)', from: 'clicks t', time: 't.created_at', value: 'COUNT(*)', where: 't.is_bot = 0', dims: { url: ['Link', 't.url'], post: ['Post', POST_TITLE], country: ['Country', 't.country'] } },
  revenue: { label: 'Revenue', from: 'orders t', time: 't.paid_at', value: 'COALESCE(SUM(t.amount_cents), 0)', where: "t.status = 'paid'", money: true, dims: { kind: ['Revenue source', 't.kind'], currency: ['Currency', 't.currency'] } },
  downloads: { label: 'Podcast downloads', from: 'episode_downloads t', time: 't.created_at', value: 'COUNT(*)', where: 't.is_bot = 0', dims: { app: ['App', 't.app'], device: ['Device', 't.device'], country: ['Country', 't.country'], episode: ['Episode', '(SELECT title FROM episodes e WHERE e.id = t.episode_id)'] } },
  listeners: { label: 'Unique listeners', from: 'episode_downloads t', time: 't.created_at', value: 'COUNT(DISTINCT t.listener_hash)', where: 't.is_bot = 0', dims: { app: ['App', 't.app'], device: ['Device', 't.device'], country: ['Country', 't.country'], episode: ['Episode', '(SELECT title FROM episodes e WHERE e.id = t.episode_id)'] } },
  bot_hits: { label: 'Bot requests', from: 'bot_hits t', time: 't.created_at', value: 'COUNT(*)', dims: { bot: ['Bot', 't.bot'], category: ['Category', 't.category'], action: ['Served / blocked', 't.action'], path: ['Path', 't.path'] } },
};

function filterSql(def: MetricDef, filters: Filter[] = []): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const f of filters) {
    const d = def.dims[f.field];
    if (!d || f.value === undefined || f.value === null) continue;
    const expr = d[1];
    switch (f.op) {
      case 'neq': parts.push(`(${expr} IS NULL OR ${expr} != ?)`); params.push(f.value); break;
      case 'contains': parts.push(`${expr} LIKE ?`); params.push(`%${f.value}%`); break;
      case 'not_contains': parts.push(`(${expr} IS NULL OR ${expr} NOT LIKE ?)`); params.push(`%${f.value}%`); break;
      case 'gt': parts.push(`${expr} > ?`); params.push(f.value); break;
      case 'lt': parts.push(`${expr} < ?`); params.push(f.value); break;
      default: if (f.value === '(none)') parts.push(`${expr} IS NULL`); else { parts.push(`${expr} = ?`); params.push(f.value); }
    }
  }
  return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', params };
}

export interface ReportSpec { metric: string; group: string; range: Range; filters?: Filter[]; limit?: number }
export interface ReportRow { key: string; label: string; value: number }

/** group: 'time' (auto bucket) | 'hour'|'day'|'week'|'month' | a dimension key */
export async function runReport(env: Env, pubId: string, spec: ReportSpec): Promise<{ rows: ReportRow[]; bucket?: Bucket; total: number; money: boolean; label: string }> {
  const def = METRICS[spec.metric] || METRICS.page_views;
  const f = filterSql(def, spec.filters);
  const base = `FROM ${def.from} WHERE t.pub_id = ? AND ${def.time} >= ? AND ${def.time} <= ?${def.where ? ' AND ' + def.where : ''}${f.sql}`;
  const params = [pubId, spec.range.from, spec.range.to, ...f.params];
  const total = Number(await val(env, `SELECT ${def.value} ${base}`, ...params)) || 0;
  const timeGroups = ['time', 'hour', 'day', 'week', 'month'];
  if (timeGroups.includes(spec.group)) {
    const b: Bucket = spec.group === 'time' ? autoBucket(spec.range) : (spec.group as Bucket);
    const res = await all<{ k: string; v: number }>(env, `SELECT ${bucketSql(def.time, b)} AS k, ${def.value} AS v ${base} GROUP BY k`, ...params);
    const map = new Map(res.map((r) => [r.k, Number(r.v) || 0]));
    const rows = bucketLabels(spec.range, b).map((k) => ({ key: k, label: shortLabel(k, b), value: map.get(k) || 0 }));
    return { rows, bucket: b, total, money: !!def.money, label: def.label };
  }
  const dim = def.dims[spec.group] || Object.values(def.dims)[0];
  const res = await all<{ k: string | null; v: number }>(env, `SELECT ${dim[1]} AS k, ${def.value} AS v ${base} GROUP BY k ORDER BY v DESC LIMIT ?`, ...params, spec.limit ?? 25);
  return { rows: res.map((r) => ({ key: r.k ?? '(none)', label: r.k ?? '(none)', value: Number(r.v) || 0 })), total, money: !!def.money, label: def.label };
}

export function dimsFor(metric: string): Array<[string, string]> {
  const def = METRICS[metric];
  return def ? Object.entries(def.dims).map(([k, [l]]) => [k, l]) : [];
}

// ───────── KPI bundles ─────────
export async function subscriberKpis(env: Env, pubId: string, r: Range) {
  const [active, premium, newSubs, unsubs] = await Promise.all([
    val<number>(env, `SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND status = 'active'`, pubId),
    val<number>(env, `SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND status = 'active' AND tier = 'premium'`, pubId),
    val<number>(env, `SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND created_at BETWEEN ? AND ?`, pubId, r.from, r.to),
    val<number>(env, `SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND unsubscribed_at BETWEEN ? AND ?`, pubId, r.from, r.to),
  ]);
  // active at the start of the range ≈ joined before and not left before
  const activeAtStart = await val<number>(env, `SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND created_at < ? AND status IN ('active','unsubscribed','bounced','complained') AND (unsubscribed_at IS NULL OR unsubscribed_at >= ?) AND status != 'pending'`, pubId, r.from, r.from);
  return { active, premium, newSubs, unsubs, net: newSubs - unsubs, activeAtStart };
}

/** Newsletter engagement for sends that started in the range (bot clicks excluded). */
export async function emailKpis(env: Env, pubId: string, r: Range) {
  const row = await one<any>(env, `SELECT COUNT(DISTINCT se.id) AS sends,
      SUM(CASE WHEN d.status IN ('sent','complained') THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN d.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
      SUM(CASE WHEN d.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked,
      SUM(CASE WHEN d.status = 'bounced' THEN 1 ELSE 0 END) AS bounced,
      SUM(CASE WHEN d.status = 'complained' THEN 1 ELSE 0 END) AS complained,
      COUNT(d.id) AS attempted
    FROM sends se JOIN deliveries d ON d.send_id = se.id
    WHERE se.pub_id = ? AND se.kind = 'post' AND se.created_at BETWEEN ? AND ?`, pubId, r.from, r.to);
  const delivered = Number(row?.delivered) || 0;
  return {
    sends: Number(row?.sends) || 0, delivered, attempted: Number(row?.attempted) || 0, opened: Number(row?.opened) || 0, clicked: Number(row?.clicked) || 0,
    bounced: Number(row?.bounced) || 0, complained: Number(row?.complained) || 0,
    openRate: delivered ? (Number(row.opened) / delivered) * 100 : 0,
    ctr: delivered ? (Number(row.clicked) / delivered) * 100 : 0,
    clickToOpen: Number(row?.opened) ? (Number(row.clicked) / Number(row.opened)) * 100 : 0,
  };
}

export async function revenueKpis(env: Env, pubId: string, r: Range) {
  const [rev, mrrRow, newPaid, churned, activePaidStart, byKind] = await Promise.all([
    val<number>(env, `SELECT COALESCE(SUM(amount_cents), 0) FROM orders WHERE pub_id = ? AND status = 'paid' AND paid_at BETWEEN ? AND ?`, pubId, r.from, r.to),
    one<{ mrr: number; n: number }>(env, `SELECT COALESCE(SUM(CASE WHEN interval = 'year' THEN amount_cents / 12.0 ELSE amount_cents END), 0) AS mrr, COUNT(*) AS n FROM subscriptions WHERE pub_id = ? AND status IN ('active','past_due')`, pubId),
    val<number>(env, `SELECT COUNT(*) FROM subscriptions WHERE pub_id = ? AND created_at BETWEEN ? AND ?`, pubId, r.from, r.to),
    val<number>(env, `SELECT COUNT(*) FROM subscriptions WHERE pub_id = ? AND canceled_at BETWEEN ? AND ?`, pubId, r.from, r.to),
    val<number>(env, `SELECT COUNT(*) FROM subscriptions WHERE pub_id = ? AND created_at < ? AND (canceled_at IS NULL OR canceled_at >= ?)`, pubId, r.from, r.from),
    all<{ kind: string; v: number }>(env, `SELECT kind, COALESCE(SUM(amount_cents), 0) AS v FROM orders WHERE pub_id = ? AND status = 'paid' AND paid_at BETWEEN ? AND ? GROUP BY kind ORDER BY v DESC`, pubId, r.from, r.to),
  ]);
  const earnings = await val<number>(env, `SELECT COALESCE(SUM(amount_cents), 0) FROM wallet_entries WHERE pub_id = ? AND kind IN ('ad','boost','sponsorship') AND created_at BETWEEN ? AND ?`, pubId, r.from, r.to);
  const mrr = Math.round(Number(mrrRow?.mrr) || 0);
  return { revenue: Number(rev) || 0, mrr, arr: mrr * 12, paidSubscribers: Number(mrrRow?.n) || 0, newPaid, churned, churnRate: activePaidStart + newPaid ? (churned / (activePaidStart + newPaid)) * 100 : 0, byKind, earnings: Number(earnings) || 0 };
}

export async function webKpis(env: Env, pubId: string, r: Range, filters: Filter[] = []) {
  const f = filterSql(METRICS.page_views, filters);
  const row = await one<any>(env, `SELECT COUNT(*) AS views, COUNT(DISTINCT t.visitor_id) AS visitors FROM page_views t WHERE t.pub_id = ? AND t.created_at BETWEEN ? AND ?${f.sql}`, pubId, r.from, r.to, ...f.params);
  const signups = await val<number>(env, `SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND created_at BETWEEN ? AND ? AND source IN ('website','form','linkinbio','magic_link','referral','recommendation','boost')`, pubId, r.from, r.to);
  const visitors = Number(row?.visitors) || 0;
  return { views: Number(row?.views) || 0, visitors, signups, conversion: visitors ? (signups / visitors) * 100 : 0 };
}

export async function podcastKpis(env: Env, pubId: string, r: Range) {
  const row = await one<any>(env, `SELECT COUNT(*) AS downloads, COUNT(DISTINCT listener_hash) AS listeners, SUM(is_bot) AS bots FROM episode_downloads WHERE pub_id = ? AND created_at BETWEEN ? AND ?`, pubId, r.from, r.to);
  const bots = Number(row?.bots) || 0;
  return { downloads: (Number(row?.downloads) || 0) - bots, listeners: Number(await val(env, `SELECT COUNT(DISTINCT listener_hash) FROM episode_downloads WHERE pub_id = ? AND is_bot = 0 AND created_at BETWEEN ? AND ?`, pubId, r.from, r.to)) || 0, botDownloads: bots };
}

// ───────── posts ─────────
export interface PostPerf {
  id: string; title: string; slug: string; published_at: number | null; platform: string;
  recipients: number; delivered: number; opened: number; clicked: number; bounced: number; unsubscribes: number;
  open_rate: number; ctr: number; web_views: number; revenue: number;
}

export async function postPerformance(env: Env, pubId: string, opts: { range?: Range; ids?: string[]; limit?: number; sort?: string } = {}): Promise<PostPerf[]> {
  const where: string[] = [`p.pub_id = ?`, `p.status = 'published'`];
  const params: unknown[] = [pubId];
  if (opts.range) { where.push('p.published_at BETWEEN ? AND ?'); params.push(opts.range.from, opts.range.to); }
  if (opts.ids?.length) { where.push(`p.id IN (${opts.ids.map(() => '?').join(',')})`); params.push(...opts.ids); }
  const rows = await all<any>(env, `
    SELECT p.id, p.title, p.slug, p.published_at, p.platform,
      (SELECT COUNT(*) FROM deliveries d JOIN sends se ON se.id = d.send_id WHERE se.post_id = p.id) AS recipients,
      (SELECT COUNT(*) FROM deliveries d JOIN sends se ON se.id = d.send_id WHERE se.post_id = p.id AND d.status IN ('sent','complained')) AS delivered,
      (SELECT COUNT(*) FROM deliveries d JOIN sends se ON se.id = d.send_id WHERE se.post_id = p.id AND d.opened_at IS NOT NULL) AS opened,
      (SELECT COUNT(*) FROM deliveries d JOIN sends se ON se.id = d.send_id WHERE se.post_id = p.id AND d.clicked_at IS NOT NULL) AS clicked,
      (SELECT COUNT(*) FROM deliveries d JOIN sends se ON se.id = d.send_id WHERE se.post_id = p.id AND d.status = 'bounced') AS bounced,
      (SELECT COUNT(*) FROM deliveries d JOIN sends se ON se.id = d.send_id JOIN subscribers s ON s.id = d.subscriber_id
         WHERE se.post_id = p.id AND s.unsubscribed_at BETWEEN se.created_at AND se.created_at + 259200000) AS unsubscribes,
      (SELECT COUNT(*) FROM page_views v WHERE v.pub_id = p.pub_id AND v.ref_id = p.id) AS web_views,
      (SELECT COALESCE(SUM(o.amount_cents), 0) FROM orders o WHERE o.pub_id = p.pub_id AND o.status = 'paid' AND json_extract(o.data, '$.post_id') = p.id) AS revenue
    FROM posts p WHERE ${where.join(' AND ')}
    ORDER BY p.published_at DESC LIMIT ?`, ...params, opts.limit ?? 200);
  const out: PostPerf[] = rows.map((r) => ({
    ...r,
    open_rate: r.delivered ? (r.opened / r.delivered) * 100 : 0,
    ctr: r.delivered ? (r.clicked / r.delivered) * 100 : 0,
  }));
  const s = opts.sort || '';
  const key = s.replace(/^-/, '') as keyof PostPerf;
  if (key && out[0] && key in out[0]) out.sort((a, b) => (s.startsWith('-') ? -1 : 1) * ((a[key] as number) > (b[key] as number) ? 1 : (a[key] as number) < (b[key] as number) ? -1 : 0));
  return out;
}

// ───────── website ─────────
export async function realtime(env: Env, pubId: string) {
  const since = Date.now() - 30 * MIN;
  const [visitors, views, pages, perMin, channels] = await Promise.all([
    val<number>(env, `SELECT COUNT(DISTINCT visitor_id) FROM page_views WHERE pub_id = ? AND created_at >= ?`, pubId, since),
    val<number>(env, `SELECT COUNT(*) FROM page_views WHERE pub_id = ? AND created_at >= ?`, pubId, since),
    all<{ path: string; n: number }>(env, `SELECT path, COUNT(*) AS n FROM page_views WHERE pub_id = ? AND created_at >= ? GROUP BY path ORDER BY n DESC LIMIT 8`, pubId, since),
    all<{ m: number; n: number }>(env, `SELECT CAST((? - created_at) / 60000 AS INTEGER) AS m, COUNT(*) AS n FROM page_views WHERE pub_id = ? AND created_at >= ? GROUP BY m`, Date.now(), pubId, since),
    all<{ channel: string; n: number }>(env, `SELECT channel, COUNT(*) AS n FROM page_views WHERE pub_id = ? AND created_at >= ? GROUP BY channel ORDER BY n DESC`, pubId, since),
  ]);
  const minutes = Array.from({ length: 30 }, (_, i) => perMin.find((p) => p.m === 29 - i)?.n || 0);
  return { visitors, views, pages, minutes, channels };
}

/** Which pages / referrers / UTM sources produced subscribers (traffic → signups). */
export async function trafficToSubscribers(env: Env, pubId: string, r: Range) {
  const byLanding = await all<{ path: string; signups: number; views: number }>(env, `
    SELECT s.landing_path AS path, COUNT(*) AS signups,
      (SELECT COUNT(DISTINCT v.visitor_id) FROM page_views v WHERE v.pub_id = ? AND v.path = s.landing_path AND v.created_at BETWEEN ? AND ?) AS views
    FROM subscribers s WHERE s.pub_id = ? AND s.created_at BETWEEN ? AND ? AND s.landing_path IS NOT NULL
    GROUP BY s.landing_path ORDER BY signups DESC LIMIT 15`, pubId, r.from, r.to, pubId, r.from, r.to);
  const byUtm = await all<{ k: string; signups: number; views: number }>(env, `
    SELECT COALESCE(s.utm_source, '(none)') AS k, COUNT(*) AS signups,
      (SELECT COUNT(DISTINCT v.visitor_id) FROM page_views v WHERE v.pub_id = ? AND COALESCE(v.utm_source, '(none)') = COALESCE(s.utm_source, '(none)') AND v.created_at BETWEEN ? AND ?) AS views
    FROM subscribers s WHERE s.pub_id = ? AND s.created_at BETWEEN ? AND ? GROUP BY k ORDER BY signups DESC LIMIT 15`, pubId, r.from, r.to, pubId, r.from, r.to);
  const byRef = await all<{ k: string; signups: number }>(env, `
    SELECT COALESCE(NULLIF(substr(s.referrer_url, instr(s.referrer_url, '://') + 3, CASE WHEN instr(substr(s.referrer_url, instr(s.referrer_url, '://') + 3), '/') > 0 THEN instr(substr(s.referrer_url, instr(s.referrer_url, '://') + 3), '/') - 1 ELSE 200 END), ''), '(direct)') AS k, COUNT(*) AS signups
    FROM subscribers s WHERE s.pub_id = ? AND s.created_at BETWEEN ? AND ? GROUP BY k ORDER BY signups DESC LIMIT 15`, pubId, r.from, r.to);
  return { byLanding, byUtm, byRef };
}

// ───────── subscribers ─────────
export async function engagementDistribution(env: Env, pubId: string) {
  const rows = await all<{ b: number; n: number }>(env, `SELECT MIN(engagement / 20, 4) AS b, COUNT(*) AS n FROM subscribers WHERE pub_id = ? AND status = 'active' GROUP BY b`, pubId);
  const labels = ['Cold (0–19)', 'Cooling (20–39)', 'Warm (40–59)', 'Engaged (60–79)', 'Superfans (80–100)'];
  return labels.map((label, i) => ({ label, value: Number(rows.find((r) => Number(r.b) === i)?.n) || 0 }));
}

export async function cohorts(env: Env, pubId: string, months = 6) {
  const since = Date.now() - months * 31 * DAY;
  const rows = await all<any>(env, `
    SELECT strftime('%Y-%m', created_at / 1000, 'unixepoch') AS cohort, COUNT(*) AS joined,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'active' AND last_open_at >= ? THEN 1 ELSE 0 END) AS opened30
    FROM subscribers WHERE pub_id = ? AND created_at >= ? GROUP BY cohort ORDER BY cohort DESC`, Date.now() - 30 * DAY, pubId, since);
  // last_open_at may be unset in imported data; fall back to deliveries
  for (const r of rows) {
    if (!r.opened30) {
      r.opened30 = Number(await val(env, `SELECT COUNT(DISTINCT d.subscriber_id) FROM deliveries d JOIN subscribers s ON s.id = d.subscriber_id WHERE s.pub_id = ? AND s.status = 'active' AND strftime('%Y-%m', s.created_at / 1000, 'unixepoch') = ? AND d.opened_at >= ?`, pubId, r.cohort, Date.now() - 30 * DAY)) || 0;
    }
  }
  return rows.map((r) => ({ cohort: r.cohort as string, joined: Number(r.joined), active: Number(r.active), opened30: Number(r.opened30), retention: r.joined ? (r.active / r.joined) * 100 : 0, engaged: r.joined ? (r.opened30 / r.joined) * 100 : 0 }));
}

// ───────── deliverability ─────────
export async function deliverability(env: Env, pubId: string, r: Range) {
  const statuses = await all<{ status: string; bounce_type: string | null; n: number }>(env, `SELECT status, bounce_type, COUNT(*) AS n FROM deliveries WHERE pub_id = ? AND created_at BETWEEN ? AND ? GROUP BY status, bounce_type`, pubId, r.from, r.to);
  const total = statuses.reduce((n, s) => n + Number(s.n), 0);
  const sum = (pred: (s: any) => boolean) => statuses.filter(pred).reduce((n, s) => n + Number(s.n), 0);
  const delivered = sum((s) => s.status === 'sent' || s.status === 'complained');
  const bounced = sum((s) => s.status === 'bounced');
  const bounces: Record<string, number> = {};
  for (const s of statuses.filter((x) => x.status === 'bounced')) bounces[s.bounce_type || 'unknown'] = (bounces[s.bounce_type || 'unknown'] || 0) + Number(s.n);
  const providers = await all<any>(env, `SELECT COALESCE(provider, 'other') AS provider, COUNT(*) AS total,
      SUM(CASE WHEN status IN ('sent','complained') THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END) AS bounced,
      SUM(CASE WHEN status = 'complained' THEN 1 ELSE 0 END) AS complained,
      SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened
    FROM deliveries WHERE pub_id = ? AND created_at BETWEEN ? AND ? GROUP BY provider ORDER BY total DESC`, pubId, r.from, r.to);
  return {
    total, delivered, bounced, complained: sum((s) => s.status === 'complained'), suppressed: sum((s) => s.status === 'suppressed'),
    deferred: sum((s) => s.status === 'deferred'), failed: sum((s) => s.status === 'failed'), bounces,
    deliveryRate: total ? (delivered / total) * 100 : 0, bounceRate: total ? (bounced / total) * 100 : 0,
    complaintRate: delivered ? (sum((s) => s.status === 'complained') / delivered) * 100 : 0,
    providers: providers.map((p) => ({ ...p, deliveryRate: p.total ? (p.delivered / p.total) * 100 : 0, openRate: p.delivered ? (p.opened / p.delivered) * 100 : 0, complaintRate: p.delivered ? (p.complained / p.delivered) * 100 : 0 })),
  };
}

/** Deliverability by mailbox provider for a single post (used by dashboard + MCP). */
export async function postDeliverability(env: Env, pubId: string, postId: string) {
  return all<any>(env, `SELECT COALESCE(d.provider, 'other') AS provider, COUNT(*) AS total,
      SUM(CASE WHEN d.status IN ('sent','complained') THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN d.status = 'bounced' THEN 1 ELSE 0 END) AS bounced,
      SUM(CASE WHEN d.status = 'complained' THEN 1 ELSE 0 END) AS complained,
      SUM(CASE WHEN d.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
      SUM(CASE WHEN d.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked
    FROM deliveries d JOIN sends se ON se.id = d.send_id WHERE se.pub_id = ? AND se.post_id = ? GROUP BY provider ORDER BY total DESC`, pubId, postId);
}

export async function suppressionSummary(env: Env, pubId: string) {
  return all<{ scope: string; reason: string; n: number; temporary: number }>(env, `
    SELECT scope, CASE WHEN instr(reason, ':') > 0 THEN substr(reason, 1, instr(reason, ':') - 1) ELSE reason END AS reason, COUNT(*) AS n, SUM(CASE WHEN expires_at IS NOT NULL THEN 1 ELSE 0 END) AS temporary
    FROM suppressions s
    WHERE (s.expires_at IS NULL OR s.expires_at > ?) AND (s.pub_id = ? OR (s.scope != 'pub' AND EXISTS (SELECT 1 FROM subscribers x WHERE x.pub_id = ? AND x.email = s.email)))
    GROUP BY scope, 2 ORDER BY n DESC`, Date.now(), pubId, pubId);
}

// ───────── activity feed ─────────
export async function recentActivity(env: Env, pubId: string, limit = 12) {
  return all<{ kind: string; title: string; detail: string; at: number; href: string }>(env, `
    SELECT * FROM (
      SELECT 'subscriber' AS kind, COALESCE(NULLIF(name, ''), email) AS title, 'subscribed via ' || source AS detail, created_at AS at, '/app/audience/subscribers/' || id AS href FROM subscribers WHERE pub_id = ?1 AND created_at > ?2
      UNION ALL
      SELECT 'order', email, kind || ' · $' || printf('%.2f', amount_cents / 100.0), paid_at, '/app/monetize/orders' FROM orders WHERE pub_id = ?1 AND status = 'paid' AND paid_at > ?2
      UNION ALL
      SELECT 'comment', COALESCE((SELECT COALESCE(NULLIF(s.name, ''), s.email) FROM subscribers s WHERE s.id = c.subscriber_id), 'Reader'), substr(c.body, 1, 80), c.created_at, '/app/posts/' || c.post_id FROM comments c WHERE c.pub_id = ?1 AND c.created_at > ?2
      UNION ALL
      SELECT 'unsubscribe', COALESCE(NULLIF(name, ''), email), COALESCE('unsubscribed: ' || unsubscribe_reason, 'unsubscribed'), unsubscribed_at, '/app/audience/subscribers/' || id FROM subscribers WHERE pub_id = ?1 AND unsubscribed_at > ?2
    ) ORDER BY at DESC LIMIT ?3`, pubId, Date.now() - 60 * DAY, limit);
}

/** Plain-English stats summary (used by the AI assistant when no model is available, and as grounding when one is). */
export async function statsSummary(env: Env, pubId: string, r: Range): Promise<{ text: string; data: Record<string, unknown> }> {
  const p = previous(r);
  const [subs, subsPrev, email, emailPrev, rev, web, top] = await Promise.all([
    subscriberKpis(env, pubId, r), subscriberKpis(env, pubId, p), emailKpis(env, pubId, r), emailKpis(env, pubId, p), revenueKpis(env, pubId, r), webKpis(env, pubId, r),
    postPerformance(env, pubId, { range: r, sort: '-open_rate', limit: 50 }),
  ]);
  const f1 = (n: number) => n.toFixed(1);
  const usd = (c: number) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const chg = (a: number, b: number) => { const d = delta(a, b); return d === null ? '' : ` (${d >= 0 ? '+' : ''}${f1(d)}% vs previous period)`; };
  const best = top.filter((t) => t.delivered > 0).sort((a, b) => b.open_rate - a.open_rate)[0];
  const lines = [
    `${r.label}: you have ${subs.active.toLocaleString()} active subscribers (${subs.premium.toLocaleString()} paid). You gained ${subs.newSubs.toLocaleString()} new subscribers${chg(subs.newSubs, subsPrev.newSubs)} and lost ${subs.unsubs.toLocaleString()}, for net growth of ${subs.net.toLocaleString()}.`,
    email.sends ? `You sent ${email.sends} newsletter${email.sends === 1 ? '' : 's'} to ${email.delivered.toLocaleString()} inboxes. Average open rate was ${f1(email.openRate)}%${emailPrev.sends ? ` (previously ${f1(emailPrev.openRate)}%)` : ''} and click-through rate was ${f1(email.ctr)}% (bot clicks excluded).` : `No newsletters were sent in this period.`,
    best ? `Best performer: "${best.title}" with a ${f1(best.open_rate)}% open rate and ${f1(best.ctr)}% CTR.` : '',
    `Revenue was ${usd(rev.revenue)}. Current MRR is ${usd(rev.mrr)} (ARR ${usd(rev.arr)}) from ${rev.paidSubscribers} paid subscriptions; ${rev.newPaid} new and ${rev.churned} cancelled (${f1(rev.churnRate)}% churn).`,
    `Your website had ${web.visitors.toLocaleString()} unique visitors and ${web.views.toLocaleString()} page views, converting ${f1(web.conversion)}% of visitors into subscribers.`,
  ].filter(Boolean);
  return { text: lines.join('\n\n'), data: { range: r.label, subscribers: subs, email, revenue: rev, web, top_posts: top.slice(0, 5).map((t) => ({ title: t.title, open_rate: +f1(t.open_rate), ctr: +f1(t.ctr), delivered: t.delivered })) } };
}
