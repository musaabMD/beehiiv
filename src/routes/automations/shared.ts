// Helpers shared by the automations dashboard views.
import { STEP_TYPES, TRIGGERS, triggerList, packTriggers, type Step } from '../../lib/automations';
import { id, stripTags, truncate } from '../../lib/util';

export const BRANCH_TYPES = new Set(['condition', 'ab_split']);

export function countRules(g: any): number {
  if (!g || !Array.isArray(g.rules)) return 0;
  return g.rules.reduce((n: number, r: any) => n + (r.rules ? countRules(r) : 1), 0);
}

export function stepSummary(s: Step, names: Record<string, string> = {}): string {
  const c = s.config || {};
  switch (s.type) {
    case 'send_email': return c.subject ? `“${truncate(c.subject, 60)}”` : 'No subject yet';
    case 'delay': return `${c.amount || 0} ${c.unit || 'days'}`;
    case 'wait_until':
      if (c.mode === 'condition') return `until ${countRules(c.rules)} condition(s) match (max ${c.timeout_days || 7}d)`;
      if (c.mode === 'weekday_time') return `next ${(c.weekdays || []).map((d: number) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join('/') || 'day'} at ${c.time || '09:00'} UTC`;
      return c.at ? `until ${c.at.replace('T', ' ')}` : 'until a date';
    case 'condition': return `${countRules(c.rules)} condition(s)`;
    case 'ab_split': return `${c.pct ?? 50}% path A / ${100 - (c.pct ?? 50)}% path B`;
    case 'add_tag': case 'remove_tag': return [].concat(c.tags || c.tag || []).join(', ') || 'no tag';
    case 'update_field': return c.key ? `${c.key} = ${c.value ?? ''}` : 'no field';
    case 'add_to_list': case 'remove_from_list': return names[c.list_id] || 'no list';
    case 'webhook': return c.url ? `${c.method || 'POST'} ${truncate(c.url, 50)}` : 'no URL';
    case 'enroll': return names[c.automation_id] || 'no automation';
    case 'grant_premium': return `${c.days || 7} days`;
    case 'notify': return c.email || 'no recipient';
    default: return '';
  }
}

export function triggerSummary(t: any, names: Record<string, string> = {}): string {
  const list = triggerList(t);
  if (list.length > 1) return list.map((x) => oneTriggerSummary(x, names)).join('  OR  ');
  return oneTriggerSummary(list[0] || t, names);
}

function oneTriggerSummary(t: any, names: Record<string, string> = {}): string {
  const def = TRIGGERS[t?.type];
  if (!def) return 'No trigger';
  const c = t.config || {};
  const bits: string[] = [];
  if (c.sources?.length) bits.push(c.sources.join(', '));
  for (const k of ['tag', 'key', 'url_contains']) if (c[k]) bits.push(String(c[k]));
  for (const k of ['list_id', 'tier_id', 'product_id', 'event_id', 'survey_id', 'poll_id', 'post_id', 'segment_id']) if (c[k]) bits.push(names[c[k]] || c[k]);
  if (t.type === 'inactive') bits.push(`${c.days || 30} days`);
  if (t.type === 'date_field' && c.offset_days) bits.push(`${c.offset_days > 0 ? '+' : ''}${c.offset_days}d`);
  if (countRules(t.filter)) bits.push(`${countRules(t.filter)} filter(s)`);
  return def.label + (bits.length ? ` · ${bits.join(' · ')}` : '');
}

export interface Flat { step: Step; depth: number; label: string }

/** Depth-first list with branch labels, for compare/funnel views. */
export function flatten(steps: Step[], depth = 0, label = ''): Flat[] {
  const out: Flat[] = [];
  for (const s of steps) {
    out.push({ step: s, depth, label });
    if (BRANCH_TYPES.has(s.type)) {
      const [a, b] = s.type === 'ab_split' ? ['Path A', 'Path B'] : ['Yes', 'No'];
      out.push(...flatten(s.yes || [], depth + 1, a));
      out.push(...flatten(s.no || [], depth + 1, b));
    }
  }
  return out;
}

export function stepLabel(s: Step) {
  return STEP_TYPES[s.type] || s.type;
}

/** Normalize untrusted steps from the builder: valid types, unique ids, branches only on branch steps. */
export function normalizeSteps(input: unknown, seen = new Set<string>(), depth = 0): Step[] {
  if (!Array.isArray(input) || depth > 8) return [];
  const out: Step[] = [];
  for (const raw of input.slice(0, 200)) {
    if (!raw || typeof raw !== 'object' || !STEP_TYPES[(raw as any).type]) continue;
    const r = raw as any;
    let sid = typeof r.id === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(r.id) ? r.id : id(10);
    if (seen.has(sid)) sid = id(10);
    seen.add(sid);
    const step: Step = { id: sid, type: r.type, config: r.config && typeof r.config === 'object' ? r.config : {} };
    if (BRANCH_TYPES.has(r.type)) {
      step.yes = normalizeSteps(r.yes, seen, depth + 1);
      step.no = normalizeSteps(r.no, seen, depth + 1);
    }
    out.push(step);
  }
  return out;
}

function normalizeOne(t: any): any | null {
  if (!t || typeof t !== 'object' || !TRIGGERS[t.type]) return null;
  const out: any = { type: t.type, config: t.config && typeof t.config === 'object' ? t.config : {} };
  if (t.filter && Array.isArray(t.filter.rules) && t.filter.rules.length) out.filter = t.filter;
  return out;
}

/** One trigger, or several entry points (`{triggers: [...]}` / an array) → stored trigger JSON (see lib packTriggers). */
export function normalizeTrigger(t: any): any {
  const raw = Array.isArray(t) ? t : t && Array.isArray(t.triggers) ? t.triggers : [t];
  const list = raw.slice(0, 10).map(normalizeOne).filter(Boolean);
  if (!list.length) return { type: 'welcome', config: {} };
  return packTriggers(list);
}

export function emailText(doc: any): string {
  return stripTags((doc?.blocks || []).map((b: any) => b.data?.html || '').join(' '));
}
