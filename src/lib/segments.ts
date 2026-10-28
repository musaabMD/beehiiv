// Segment rule engine. Rules compile to a SQL WHERE fragment over `subscribers s`.
// Used by: segments (dynamic/static), send targeting (include/exclude), dynamic content, automation conditions.
import type { Env } from '../types';
import { one, all, run, val } from './db';
import { now, DAY, parseJSON } from './util';
import { COMMERCE_FIELDS, commerceRule } from './commerce-rules';
import { CUSTOM_EVENT_FIELDS, customEventRule } from './customevent-rules';

export interface Rule { field: string; cmp: string; value?: any }
export interface RuleGroup { op: 'and' | 'or'; rules: Array<Rule | RuleGroup> }

export const EMPTY_GROUP: RuleGroup = { op: 'and', rules: [] };

/** Field catalog for UIs: field → {label, kind, cmps}. */
export const FIELDS: Record<string, { label: string; kind: string; cmps: string[]; options?: string[] }> = {
  email: { label: 'Email', kind: 'text', cmps: ['contains', 'not_contains', 'equals', 'ends_with'] },
  name: { label: 'Name', kind: 'text', cmps: ['contains', 'equals', 'is_empty', 'not_empty'] },
  status: { label: 'Status', kind: 'enum', cmps: ['eq', 'neq'], options: ['active', 'pending', 'unsubscribed', 'bounced', 'complained'] },
  tier: { label: 'Tier (free/premium)', kind: 'enum', cmps: ['eq', 'neq'], options: ['free', 'premium'] },
  tier_id: { label: 'Paid tier', kind: 'tier', cmps: ['eq', 'neq'] },
  subscription_status: { label: 'Subscription status', kind: 'enum', cmps: ['eq', 'neq'], options: ['trialing', 'active', 'paused', 'past_due', 'canceled'] },
  trial: { label: 'Paid trial', kind: 'bool', cmps: ['is_true', 'is_false'] },
  source: { label: 'Acquisition source', kind: 'enum', cmps: ['eq', 'neq'], options: ['website', 'form', 'magic_link', 'import', 'api', 'referral', 'recommendation', 'boost', 'manual', 'event', 'product', 'linkinbio'] },
  source_detail: { label: 'Source detail (form / link / partner id)', kind: 'text', cmps: ['equals', 'contains'] },
  utm_source: { label: 'UTM source', kind: 'text', cmps: ['equals', 'contains', 'is_empty', 'not_empty'] },
  utm_medium: { label: 'UTM medium', kind: 'text', cmps: ['equals', 'contains', 'is_empty', 'not_empty'] },
  utm_campaign: { label: 'UTM campaign', kind: 'text', cmps: ['equals', 'contains', 'is_empty', 'not_empty'] },
  country: { label: 'Country', kind: 'text', cmps: ['equals', 'neq'] },
  created_at: { label: 'Subscribed', kind: 'date', cmps: ['within_days', 'older_than_days', 'before', 'after'] },
  engagement: { label: 'Engagement score', kind: 'number', cmps: ['gt', 'lt', 'eq'] },
  open_count: { label: 'Total opens', kind: 'number', cmps: ['gt', 'lt', 'eq'] },
  click_count: { label: 'Total clicks', kind: 'number', cmps: ['gt', 'lt', 'eq'] },
  referral_count: { label: 'Referrals', kind: 'number', cmps: ['gt', 'lt', 'eq'] },
  last_open_at: { label: 'Last opened', kind: 'date', cmps: ['within_days', 'not_within_days', 'never'] },
  last_click_at: { label: 'Last clicked', kind: 'date', cmps: ['within_days', 'not_within_days', 'never'] },
  tag: { label: 'Tag', kind: 'tag', cmps: ['has', 'not_has'] },
  custom: { label: 'Custom field', kind: 'custom', cmps: ['equals', 'neq', 'contains', 'gt', 'lt', 'exists', 'not_exists'] },
  opened_post: { label: 'Opened post', kind: 'post', cmps: ['yes', 'no'] },
  clicked_post: { label: 'Clicked in post', kind: 'post', cmps: ['yes', 'no'] },
  clicked_url: { label: 'Clicked a link containing', kind: 'text', cmps: ['contains'] },
  automation: { label: 'Automation', kind: 'automation', cmps: ['started', 'not_started', 'completed', 'active'] },
  segment: { label: 'In segment', kind: 'segment', cmps: ['in', 'not_in'] },
  list: { label: 'Newsletter list', kind: 'list', cmps: ['in', 'not_in'] },
  poll: { label: 'Poll answer', kind: 'poll', cmps: ['answered', 'chose', 'not_answered'] },
  survey: { label: 'Survey', kind: 'survey', cmps: ['responded', 'not_responded', 'answer_equals'] },
  purchased: { label: 'Purchased product', kind: 'product', cmps: ['yes', 'no', 'any'] },
  event_registered: { label: 'Registered for event', kind: 'event', cmps: ['yes', 'no'] },
  community_member: { label: 'Community member', kind: 'bool', cmps: ['is_true', 'is_false'] },
  condition_set: { label: 'Matches condition set', kind: 'condition_set', cmps: ['matches', 'not_matches'] },
  ...COMMERCE_FIELDS, // external store purchases + abandoned carts (lib/commerce-rules)
  ...CUSTOM_EVENT_FIELDS, // performed custom event X (within N days, at least k times) — lib/customevent-rules
  // Subscriber Signals (public profile + email domain) and predictions (lib/signals.ts, lib/predict.ts)
  job_title: { label: 'Job title (Signals)', kind: 'text', cmps: ['contains', 'equals', 'is_empty', 'not_empty'] },
  company: { label: 'Company (Signals)', kind: 'text', cmps: ['contains', 'equals', 'is_empty', 'not_empty'] },
  has_social: { label: 'Has a verified social account (Signals)', kind: 'bool', cmps: ['is_true', 'is_false'] },
  business_email: { label: 'Business email address (Signals)', kind: 'bool', cmps: ['is_true', 'is_false'] },
  value_score: { label: 'Value score (0–100)', kind: 'number', cmps: ['gt', 'lt', 'eq'] },
  value_percentile: { label: 'Value percentile (100 = most valuable)', kind: 'number', cmps: ['gt', 'lt'] },
  clv: { label: 'Customer lifetime value ($)', kind: 'number', cmps: ['gt', 'lt'] },
  purchase_likelihood: { label: 'Purchase likelihood', kind: 'enum', cmps: ['eq', 'neq'], options: ['high', 'medium', 'low'] },
  churn_risk: { label: 'Churn risk (paid subscribers)', kind: 'enum', cmps: ['eq', 'neq'], options: ['high', 'medium', 'low'] },
};

const COLS: Record<string, string> = {
  email: 's.email', name: 's.name', status: 's.status', tier: 's.tier', tier_id: 's.tier_id', source: 's.source', source_detail: 's.source_detail',
  utm_source: 's.utm_source', utm_medium: 's.utm_medium', utm_campaign: 's.utm_campaign', country: 's.country', created_at: 's.created_at',
  engagement: 's.engagement', open_count: 's.open_count', click_count: 's.click_count', referral_count: 's.referral_count',
  last_open_at: 's.last_open_at', last_click_at: 's.last_click_at',
};

interface Compiled { sql: string; params: unknown[] }

function isGroup(r: Rule | RuleGroup): r is RuleGroup {
  return (r as RuleGroup).rules !== undefined;
}

export async function compile(env: Env, pubId: string, g: RuleGroup, depth = 0): Promise<Compiled> {
  if (depth > 5) return { sql: '1=1', params: [] };
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const r of g.rules || []) {
    const c = isGroup(r) ? await compile(env, pubId, r, depth + 1) : await compileRule(env, pubId, r, depth);
    if (!c.sql) continue;
    parts.push(`(${c.sql})`);
    params.push(...c.params);
  }
  if (!parts.length) return { sql: '1=1', params: [] };
  return { sql: parts.join(g.op === 'or' ? ' OR ' : ' AND '), params };
}

async function compileRule(env: Env, pubId: string, r: Rule, depth: number): Promise<Compiled> {
  const v = r.value;
  const col = COLS[r.field];
  const t = now();
  if (col) {
    switch (r.cmp) {
      case 'eq': case 'equals': return { sql: `${col} = ?`, params: [String(v ?? '').toLowerCase() === v ? v : r.field === 'email' ? String(v).toLowerCase() : v] };
      case 'neq': return { sql: `(${col} IS NULL OR ${col} != ?)`, params: [v] };
      case 'contains': return { sql: `${col} LIKE ?`, params: [`%${v}%`] };
      case 'not_contains': return { sql: `${col} NOT LIKE ?`, params: [`%${v}%`] };
      case 'ends_with': return { sql: `${col} LIKE ?`, params: [`%${v}`] };
      case 'is_empty': return { sql: `(${col} IS NULL OR ${col} = '')`, params: [] };
      case 'not_empty': return { sql: `(${col} IS NOT NULL AND ${col} != '')`, params: [] };
      case 'gt': return { sql: `${col} > ?`, params: [Number(v)] };
      case 'lt': return { sql: `${col} < ?`, params: [Number(v)] };
      case 'within_days': return { sql: `${col} >= ?`, params: [t - Number(v) * DAY] };
      case 'older_than_days': return { sql: `${col} < ?`, params: [t - Number(v) * DAY] };
      case 'not_within_days': return { sql: `(${col} IS NULL OR ${col} < ?)`, params: [t - Number(v) * DAY] };
      case 'never': return { sql: `${col} IS NULL`, params: [] };
      case 'before': return { sql: `${col} < ?`, params: [Date.parse(v)] };
      case 'after': return { sql: `${col} > ?`, params: [Date.parse(v)] };
    }
  }
  const ext = commerceRule(r, t) || customEventRule(r, t);
  if (ext) return ext;
  switch (r.field) {
    case 'tag':
      return { sql: `${r.cmp === 'not_has' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM subscriber_tags t WHERE t.subscriber_id = s.id AND t.tag = ?)`, params: [String(v).toLowerCase()] };
    case 'custom': {
      const key = String(v?.key || '').replace(/[^a-zA-Z0-9_]/g, '');
      const path = `json_extract(s.custom, '$.${key}')`;
      switch (r.cmp) {
        case 'exists': return { sql: `${path} IS NOT NULL`, params: [] };
        case 'not_exists': return { sql: `${path} IS NULL`, params: [] };
        case 'contains': return { sql: `${path} LIKE ?`, params: [`%${v?.value}%`] };
        case 'gt': return { sql: `CAST(${path} AS REAL) > ?`, params: [Number(v?.value)] };
        case 'lt': return { sql: `CAST(${path} AS REAL) < ?`, params: [Number(v?.value)] };
        case 'neq': return { sql: `(${path} IS NULL OR ${path} != ?)`, params: [String(v?.value)] };
        default: return { sql: `${path} = ?`, params: [String(v?.value)] };
      }
    }
    case 'subscription_status':
      return { sql: `${r.cmp === 'neq' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM subscriptions x WHERE x.subscriber_id = s.id AND x.status = ?)`, params: [v] };
    case 'trial':
      return { sql: `${r.cmp === 'is_false' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM subscriptions x WHERE x.subscriber_id = s.id AND x.status = 'trialing')`, params: [] };
    case 'opened_post':
      return { sql: `${r.cmp === 'no' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM deliveries d JOIN sends se ON se.id = d.send_id WHERE d.subscriber_id = s.id AND se.post_id = ? AND d.opened_at IS NOT NULL)`, params: [v] };
    case 'clicked_post':
      return { sql: `${r.cmp === 'no' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM deliveries d JOIN sends se ON se.id = d.send_id WHERE d.subscriber_id = s.id AND se.post_id = ? AND d.clicked_at IS NOT NULL)`, params: [v] };
    case 'clicked_url':
      return { sql: `EXISTS (SELECT 1 FROM clicks c JOIN deliveries d ON d.id = c.delivery_id WHERE d.subscriber_id = s.id AND c.is_bot = 0 AND c.url LIKE ?)`, params: [`%${v}%`] };
    case 'automation': {
      if (r.cmp === 'not_started') return { sql: `NOT EXISTS (SELECT 1 FROM automation_runs ar WHERE ar.subscriber_id = s.id AND ar.automation_id = ?)`, params: [v] };
      if (r.cmp === 'completed') return { sql: `EXISTS (SELECT 1 FROM automation_runs ar WHERE ar.subscriber_id = s.id AND ar.automation_id = ? AND ar.status = 'completed')`, params: [v] };
      if (r.cmp === 'active') return { sql: `EXISTS (SELECT 1 FROM automation_runs ar WHERE ar.subscriber_id = s.id AND ar.automation_id = ? AND ar.status IN ('active','waiting'))`, params: [v] };
      return { sql: `EXISTS (SELECT 1 FROM automation_runs ar WHERE ar.subscriber_id = s.id AND ar.automation_id = ?)`, params: [v] };
    }
    case 'segment': {
      const seg = await one<{ kind: string; rules: string }>(env, 'SELECT kind, rules FROM segments WHERE id = ? AND pub_id = ?', v, pubId);
      if (!seg) return { sql: r.cmp === 'not_in' ? '1=1' : '1=0', params: [] };
      if (seg.kind === 'static') return { sql: `${r.cmp === 'not_in' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM segment_members sm WHERE sm.subscriber_id = s.id AND sm.segment_id = ?)`, params: [v] };
      const c = await compile(env, pubId, parseJSON(seg.rules, EMPTY_GROUP), depth + 1);
      return r.cmp === 'not_in' ? { sql: `NOT (${c.sql})`, params: c.params } : c;
    }
    case 'list':
      return { sql: `${r.cmp === 'not_in' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM list_members lm WHERE lm.subscriber_id = s.id AND lm.list_id = ? AND lm.status = 'subscribed')`, params: [v] };
    case 'poll': {
      if (r.cmp === 'chose') return { sql: `EXISTS (SELECT 1 FROM poll_votes pv WHERE pv.subscriber_id = s.id AND pv.poll_id = ? AND pv.option_id = ?)`, params: [v?.poll_id, v?.option_id] };
      return { sql: `${r.cmp === 'not_answered' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM poll_votes pv WHERE pv.subscriber_id = s.id AND pv.poll_id = ?)`, params: [v?.poll_id ?? v] };
    }
    case 'survey': {
      if (r.cmp === 'answer_equals') {
        const q = String(v?.question_id || '').replace(/[^a-zA-Z0-9_-]/g, '');
        return { sql: `EXISTS (SELECT 1 FROM survey_responses sr WHERE sr.subscriber_id = s.id AND sr.survey_id = ? AND (json_extract(sr.answers, '$."${q}"') = ? OR json_extract(sr.answers, '$."${q}"') LIKE ?))`, params: [v?.survey_id, String(v?.value), `%"${v?.value}"%`] };
      }
      return { sql: `${r.cmp === 'not_responded' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM survey_responses sr WHERE sr.subscriber_id = s.id AND sr.survey_id = ?)`, params: [v?.survey_id ?? v] };
    }
    case 'purchased':
      if (r.cmp === 'any') return { sql: `EXISTS (SELECT 1 FROM orders o WHERE o.subscriber_id = s.id AND o.status = 'paid')`, params: [] };
      return { sql: `${r.cmp === 'no' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM orders o WHERE o.subscriber_id = s.id AND o.status = 'paid' AND o.ref_id = ?)`, params: [v] };
    case 'event_registered':
      return { sql: `${r.cmp === 'no' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM event_registrations er WHERE er.subscriber_id = s.id AND er.event_id = ?)`, params: [v] };
    case 'community_member':
      return { sql: `${r.cmp === 'is_false' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM community_members cm WHERE cm.subscriber_id = s.id AND cm.status = 'active')`, params: [] };
    case 'job_title':
    case 'company': {
      const expr = r.field === 'company' ? 'COALESCE(NULLIF(g.company, \'\'), g.organization)' : 'g.job_title';
      const sub = (cond: string) => `EXISTS (SELECT 1 FROM subscriber_signals g WHERE g.subscriber_id = s.id AND ${cond})`;
      if (r.cmp === 'is_empty') return { sql: `NOT ${sub(`${expr} IS NOT NULL AND ${expr} != ''`)}`, params: [] };
      if (r.cmp === 'not_empty') return { sql: sub(`${expr} IS NOT NULL AND ${expr} != ''`), params: [] };
      if (r.cmp === 'equals') return { sql: sub(`${expr} = ? COLLATE NOCASE`), params: [String(v ?? '')] };
      return { sql: sub(`${expr} LIKE ?`), params: [`%${v ?? ''}%`] };
    }
    case 'has_social':
    case 'business_email': {
      const cond = r.field === 'has_social' ? 'g.social_count > 0' : 'g.business_email = 1';
      return { sql: `${r.cmp === 'is_false' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM subscriber_signals g WHERE g.subscriber_id = s.id AND ${cond})`, params: [] };
    }
    case 'value_score':
    case 'value_percentile':
    case 'clv': {
      const colx = r.field === 'clv' ? 'x.clv_cents' : `x.${r.field}`;
      const num = r.field === 'clv' ? Math.round(Number(v) * 100) : Number(v);
      const op = r.cmp === 'gt' ? '>' : r.cmp === 'lt' ? '<' : '=';
      return { sql: `EXISTS (SELECT 1 FROM subscriber_scores x WHERE x.subscriber_id = s.id AND ${colx} ${op} ?)`, params: [num] };
    }
    case 'purchase_likelihood':
    case 'churn_risk':
      return { sql: `${r.cmp === 'neq' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM subscriber_scores x WHERE x.subscriber_id = s.id AND x.${r.field} = ?)`, params: [String(v)] };
    case 'condition_set': {
      const cs = await one<{ rules: string }>(env, 'SELECT rules FROM condition_sets WHERE id = ? AND pub_id = ?', v, pubId);
      if (!cs) return { sql: '1=1', params: [] };
      const c = await compile(env, pubId, parseJSON(cs.rules, EMPTY_GROUP), depth + 1);
      return r.cmp === 'not_matches' ? { sql: `NOT (${c.sql})`, params: c.params } : c;
    }
  }
  return { sql: '', params: [] };
}

export async function countMatching(env: Env, pubId: string, g: RuleGroup, activeOnly = true): Promise<number> {
  const c = await compile(env, pubId, g);
  return val<number>(env, `SELECT COUNT(*) FROM subscribers s WHERE s.pub_id = ? ${activeOnly ? "AND s.status = 'active'" : ''} AND (${c.sql})`, pubId, ...c.params);
}

export async function listMatching(env: Env, pubId: string, g: RuleGroup, opts: { after?: string; limit?: number; activeOnly?: boolean } = {}) {
  const c = await compile(env, pubId, g);
  return all<any>(
    env,
    `SELECT s.* FROM subscribers s WHERE s.pub_id = ? ${opts.activeOnly !== false ? "AND s.status = 'active'" : ''} AND (${c.sql}) ${opts.after ? 'AND s.id > ?' : ''} ORDER BY s.id LIMIT ?`,
    pubId, ...c.params, ...(opts.after ? [opts.after] : []), opts.limit ?? 100,
  );
}

export async function subscriberMatches(env: Env, pubId: string, g: RuleGroup, subscriberId: string): Promise<boolean> {
  const c = await compile(env, pubId, g);
  const r = await one(env, `SELECT 1 AS ok FROM subscribers s WHERE s.pub_id = ? AND s.id = ? AND (${c.sql})`, pubId, subscriberId, ...c.params);
  return !!r;
}

/** Segment as a rule group (static segments become membership checks). */
export function segmentGroup(segmentId: string): RuleGroup {
  return { op: 'and', rules: [{ field: 'segment', cmp: 'in', value: segmentId }] };
}

/** Recalculate a segment's cached count (and membership table for dynamic segments, used for fast lookups). */
export async function recalcSegment(env: Env, pubId: string, segmentId: string): Promise<number> {
  const seg = await one<{ kind: string; rules: string }>(env, 'SELECT kind, rules FROM segments WHERE id = ? AND pub_id = ?', segmentId, pubId);
  if (!seg) return 0;
  let count: number;
  if (seg.kind === 'static') {
    count = await val<number>(env, `SELECT COUNT(*) FROM segment_members sm JOIN subscribers s ON s.id = sm.subscriber_id WHERE sm.segment_id = ? AND s.status = 'active'`, segmentId);
  } else {
    const c = await compile(env, pubId, parseJSON(seg.rules, EMPTY_GROUP));
    await run(env, 'DELETE FROM segment_members WHERE segment_id = ?', segmentId);
    await run(env, `INSERT INTO segment_members (segment_id, subscriber_id) SELECT ?, s.id FROM subscribers s WHERE s.pub_id = ? AND (${c.sql})`, segmentId, pubId, ...c.params);
    count = await val<number>(env, `SELECT COUNT(*) FROM subscribers s WHERE s.pub_id = ? AND s.status = 'active' AND (${c.sql})`, pubId, ...c.params);
  }
  await run(env, 'UPDATE segments SET cached_count = ?, calculated_at = ? WHERE id = ?', count, now(), segmentId);
  return count;
}

/** Freeze a dynamic rule set into a static segment snapshot. */
export async function snapshotToStatic(env: Env, pubId: string, segmentId: string, g: RuleGroup) {
  const c = await compile(env, pubId, g);
  await run(env, 'DELETE FROM segment_members WHERE segment_id = ?', segmentId);
  await run(env, `INSERT INTO segment_members (segment_id, subscriber_id) SELECT ?, s.id FROM subscribers s WHERE s.pub_id = ? AND (${c.sql})`, segmentId, pubId, ...c.params);
}

/** Segment ids a subscriber belongs to (for dynamic content). Uses cached membership + static members. */
export async function segmentIdsFor(env: Env, subscriberId: string): Promise<Set<string>> {
  const rows = await all<{ segment_id: string }>(env, 'SELECT segment_id FROM segment_members WHERE subscriber_id = ?', subscriberId);
  return new Set(rows.map((r) => r.segment_id));
}
