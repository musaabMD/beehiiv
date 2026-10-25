/** @jsxImportSource hono/jsx */
import type { Child } from 'hono/jsx';
import type { Ctx } from '../../types';
import { DashLayout } from '../../ui/layout';
import { compile, type RuleGroup } from '../../lib/segments';
import { all } from '../../lib/db';
import { toCSV, parseJSON, fmtDate } from '../../lib/util';

export function page(c: Ctx, o: { title: string; sub: string; actions?: Child; crumbs?: Array<[string, string]>; scripts?: string[]; wide?: boolean }, children: Child) {
  return c.html(
    <DashLayout c={c} title={o.title} section="audience" sub={o.sub} actions={o.actions} crumbs={o.crumbs} scripts={o.scripts} wide={o.wide} styles={['/static/audience-ui.css']}>
      {children}
    </DashLayout>,
  );
}

export const SOURCES = ['website', 'form', 'magic_link', 'import', 'api', 'referral', 'recommendation', 'boost', 'manual', 'event', 'product', 'linkinbio'];

export interface SubFilters { q?: string; status?: string; tier?: string; source?: string; tag?: string; list?: string; segment?: string }

export function filtersFrom(q: (k: string) => string | undefined): SubFilters {
  const f: SubFilters = {};
  for (const k of ['q', 'status', 'tier', 'source', 'tag', 'list', 'segment'] as const) {
    const v = (q(k) || '').trim();
    if (v) f[k] = v.slice(0, 200);
  }
  return f;
}

export function filterGroup(f: SubFilters): RuleGroup {
  const rules: any[] = [];
  if (f.q) rules.push({ op: 'or', rules: [{ field: 'email', cmp: 'contains', value: f.q.toLowerCase() }, { field: 'name', cmp: 'contains', value: f.q }] });
  if (f.status) rules.push({ field: 'status', cmp: 'eq', value: f.status });
  if (f.tier) rules.push({ field: 'tier', cmp: 'eq', value: f.tier });
  if (f.source) rules.push({ field: 'source', cmp: 'eq', value: f.source });
  if (f.tag) rules.push({ field: 'tag', cmp: 'has', value: f.tag });
  if (f.list) rules.push({ field: 'list', cmp: 'in', value: f.list });
  if (f.segment) rules.push({ field: 'segment', cmp: 'in', value: f.segment });
  return { op: 'and', rules };
}

export function filterQS(f: SubFilters, extra: Record<string, string> = {}) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...extra })) if (v) u.set(k, v);
  const s = u.toString();
  return s ? '?' + s : '';
}

/** Stream-free CSV export of subscribers matching a rule group (keyset pages of 1000). */
export async function exportCSV(c: Ctx, g: RuleGroup, filename: string, activeOnly = false) {
  const pub = c.get('pub');
  const fields = await all<{ key: string }>(c.env, 'SELECT key FROM custom_fields WHERE pub_id = ? ORDER BY key', pub.id);
  const cc = await compile(c.env, pub.id, g);
  const head = ['email', 'name', 'status', 'tier', 'source', 'source_detail', 'utm_source', 'utm_medium', 'utm_campaign', 'country', 'referral_code', 'referral_count', 'engagement', 'open_count', 'click_count', 'tags', 'subscribed_at', 'unsubscribed_at', ...fields.map((f) => 'custom.' + f.key)];
  const rows: unknown[][] = [head];
  let after = '';
  for (let i = 0; i < 200; i++) {
    const batch = await all<any>(
      c.env,
      `SELECT s.*, (SELECT group_concat(tag, ';') FROM subscriber_tags t WHERE t.subscriber_id = s.id) AS tags FROM subscribers s WHERE s.pub_id = ? ${activeOnly ? "AND s.status = 'active'" : ''} AND (${cc.sql}) AND s.id > ? ORDER BY s.id LIMIT 1000`,
      pub.id, ...cc.params, after,
    );
    for (const s of batch) {
      const custom = parseJSON<Record<string, unknown>>(s.custom, {});
      rows.push([s.email, s.name, s.status, s.tier, s.source, s.source_detail, s.utm_source, s.utm_medium, s.utm_campaign, s.country, s.referral_code, s.referral_count, s.engagement, s.open_count, s.click_count, s.tags || '', new Date(s.created_at).toISOString(), s.unsubscribed_at ? new Date(s.unsubscribed_at).toISOString() : '', ...fields.map((f) => custom[f.key] ?? '')]);
    }
    if (batch.length < 1000) break;
    after = batch[batch.length - 1].id;
  }
  return new Response(toCSV(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename.replace(/[^a-z0-9_.-]/gi, '_')}-${fmtDate(Date.now(), { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-')}.csv"` } });
}
