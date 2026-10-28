// Segment rule over custom events (lib/customevents). Pure SQL builder (no lib imports besides util) so lib/segments
// can use it without an import cycle. Events are matched by publication + email, so events tracked before someone
// subscribed count too.
import { now, DAY } from './util';

export const CUSTOM_EVENT_FIELDS: Record<string, { label: string; kind: string; cmps: string[] }> = {
  custom_event: { label: 'Performed custom event', kind: 'custom_event', cmps: ['performed', 'not_performed'] },
};

/** value: "name" or {name, days?, count?} → performed event `name` (within the last `days` days, at least `count` times). */
export function customEventRule(r: { field: string; cmp: string; value?: any }, t = now()): { sql: string; params: unknown[] } | null {
  if (r.field !== 'custom_event') return null;
  const v = r.value && typeof r.value === 'object' ? r.value : { name: r.value };
  const name = String(v.name ?? '').trim();
  const days = Number(v.days) > 0 ? Number(v.days) : 0;
  const count = Math.max(1, Math.floor(Number(v.count) || 1));
  const params: unknown[] = [name];
  let cond = `e.pub_id = s.pub_id AND e.email = s.email AND e.name = ?`;
  if (days) { cond += ' AND e.occurred_at >= ?'; params.push(t - days * DAY); }
  const sql = count > 1 ? `(SELECT COUNT(*) FROM custom_events e WHERE ${cond}) >= ${count}` : `EXISTS (SELECT 1 FROM custom_events e WHERE ${cond})`;
  return { sql: r.cmp === 'not_performed' ? `NOT (${sql})` : sql, params };
}

