// Custom events API (Kit / Segment-style "track"): POST /api/v2/publication/events (+ /events/batch, MCP track_event).
//
//   { email | subscriber_id, name, properties?, occurred_at?, dedupe_key? }
//
// - Exactly once per publication + dedupe_key: a repeat returns the original event with duplicate: true (a unique index
//   makes this hold under concurrent retries too).
// - Events for an email that isn't a subscriber yet are kept (by email) and show up once they subscribe.
// - Each new event for a subscriber goes through the event bus as `custom_event` (activity, webhooks) and enrolls
//   automations whose trigger is "Performs a custom event" (name + optional property filters).
// - Segment field `custom_event`: performed event X (within N days, at least k times) / did not.
import type { Env, Publication } from '../types';
import { one, all, run } from './db';
import { emit, onEvent } from './events';
import { enroll, triggerList } from './automations';
import { subscriberMatches, type RuleGroup } from './segments';
import { id, now, parseJSON, DAY } from './util';

export const MAX_BATCH = 100;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.:\/-]{0,99}$/;

export class EventError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export interface EventInput { email?: string; subscriber_id?: string; name?: string; event?: string; properties?: Record<string, unknown>; occurred_at?: string | number; dedupe_key?: string; idempotency_key?: string }

export function serializeEvent(e: any, extra: Record<string, unknown> = {}) {
  return { id: e.id, name: e.name, subscriber_id: e.subscriber_id, email: e.email, properties: parseJSON(e.properties, {}), occurred_at: new Date(e.occurred_at).toISOString(), dedupe_key: e.dedupe_key, created_at: new Date(e.created_at).toISOString(), ...extra };
}

function parseTime(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return now();
  const n = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : /^\d+$/.test(String(v)) ? Number(v) * (String(v).length <= 10 ? 1000 : 1) : Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
}

/** Validate + store one event. Throws EventError for caller mistakes. */
export async function trackEvent(env: Env, pub: Publication, input: EventInput, source = 'api'): Promise<{ event: any; duplicate: boolean }> {
  if (!input || typeof input !== 'object') throw new EventError(400, 'bad_request', 'JSON object required.');
  const name = String(input.name ?? input.event ?? '').trim();
  if (!NAME_RE.test(name)) throw new EventError(400, 'invalid_name', '"name" is required: 1–100 characters (letters, digits, space, _ . : / -), starting with a letter or digit.');
  const props = input.properties ?? {};
  if (typeof props !== 'object' || Array.isArray(props)) throw new EventError(400, 'invalid_properties', '"properties" must be a JSON object.');
  const propsJson = JSON.stringify(props);
  if (propsJson.length > 8192) throw new EventError(400, 'invalid_properties', '"properties" must be at most 8 KB of JSON.');
  const at = parseTime(input.occurred_at);
  if (at === null) throw new EventError(400, 'invalid_occurred_at', '"occurred_at" must be an ISO 8601 date or a Unix timestamp.');
  if (at > now() + DAY) throw new EventError(400, 'invalid_occurred_at', '"occurred_at" cannot be more than a day in the future.');
  const dedupe = input.dedupe_key ?? input.idempotency_key;
  const key = dedupe === undefined || dedupe === null || dedupe === '' ? null : String(dedupe).slice(0, 200);
  if (key) {
    const prev = await one<any>(env, 'SELECT * FROM custom_events WHERE pub_id = ? AND dedupe_key = ?', pub.id, key);
    if (prev) return { event: prev, duplicate: true };
  }
  let sub: { id: string; email: string; status: string } | null = null;
  if (input.subscriber_id) {
    sub = await one<any>(env, 'SELECT id, email, status FROM subscribers WHERE pub_id = ? AND id = ?', pub.id, String(input.subscriber_id));
    if (!sub) throw new EventError(404, 'not_found', 'Subscriber not found.');
  }
  let email = String(input.email || sub?.email || '').trim().toLowerCase();
  if (!email) throw new EventError(400, 'bad_request', 'Pass "email" or "subscriber_id".');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new EventError(400, 'invalid_email', '"email" is not a valid email address.');
  if (!sub) sub = await one<any>(env, 'SELECT id, email, status FROM subscribers WHERE pub_id = ? AND email = ?', pub.id, email);
  if (sub) email = sub.email;
  const row = { id: id(), pub_id: pub.id, subscriber_id: sub?.id ?? null, email, name, properties: propsJson, occurred_at: at, dedupe_key: key, source, created_at: now() };
  const res = await run(env, `INSERT OR IGNORE INTO custom_events (id, pub_id, subscriber_id, email, name, properties, occurred_at, dedupe_key, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id, row.pub_id, row.subscriber_id, row.email, row.name, row.properties, row.occurred_at, row.dedupe_key, row.source, row.created_at);
  if (!res.meta.changes) {
    // lost a race with a concurrent request carrying the same dedupe_key
    const prev = await one<any>(env, 'SELECT * FROM custom_events WHERE pub_id = ? AND dedupe_key = ?', pub.id, key);
    return { event: prev || row, duplicate: true };
  }
  if (sub) await emit(env, { pubId: pub.id, type: 'custom_event', subscriberId: sub.id, refId: row.id, data: { event_id: row.id, name, properties: props, occurred_at: new Date(at).toISOString() } });
  return { event: row, duplicate: false };
}

/** Batch: up to 100 events, each validated independently (one bad event doesn't fail the rest). */
export async function trackBatch(env: Env, pub: Publication, events: unknown, source = 'api') {
  if (!Array.isArray(events)) throw new EventError(400, 'bad_request', '"events" must be an array.');
  if (events.length > MAX_BATCH) throw new EventError(400, 'too_many', `At most ${MAX_BATCH} events per batch.`);
  const results = [];
  for (const [i, e] of events.entries()) {
    try { const r = await trackEvent(env, pub, e as EventInput, source); results.push({ index: i, ok: true, duplicate: r.duplicate, event: serializeEvent(r.event) }); }
    catch (err) {
      if (err instanceof EventError) results.push({ index: i, ok: false, error: { code: err.code, message: err.message } });
      else throw err;
    }
  }
  return { accepted: results.filter((r) => r.ok && !r.duplicate).length, duplicates: results.filter((r) => r.ok && r.duplicate).length, rejected: results.filter((r) => !r.ok).length, results };
}

/** Recent events (newest first), optionally for one subscriber/email or one event name. */
export async function listEvents(env: Env, pubId: string, o: { email?: string; subscriberId?: string; name?: string; before?: number; limit?: number }) {
  const where = ['pub_id = ?'];
  const params: unknown[] = [pubId];
  if (o.subscriberId) { where.push('(subscriber_id = ? OR email = (SELECT email FROM subscribers WHERE id = ?))'); params.push(o.subscriberId, o.subscriberId); }
  else if (o.email) { where.push('email = ?'); params.push(o.email.toLowerCase()); }
  if (o.name) { where.push('name = ?'); params.push(o.name); }
  if (o.before) { where.push('occurred_at < ?'); params.push(o.before); }
  return all<any>(env, `SELECT * FROM custom_events WHERE ${where.join(' AND ')} ORDER BY occurred_at DESC LIMIT ?`, ...params, Math.min(200, Math.max(1, o.limit || 50)));
}

/** Distinct event names with counts (catalog for the UI / API). */
export async function eventNames(env: Env, pubId: string) {
  return all<{ name: string; n: number; last_at: number }>(env, 'SELECT name, COUNT(*) AS n, MAX(occurred_at) AS last_at FROM custom_events WHERE pub_id = ? GROUP BY name ORDER BY n DESC LIMIT 200', pubId);
}

// Segment field: see lib/customevent-rules (pure SQL, imported by lib/segments without a cycle).
export { CUSTOM_EVENT_FIELDS, customEventRule } from './customevent-rules';

// ───────── automation trigger: custom_event {name, properties: "key = value" lines} ─────────
export interface PropFilter { key: string; op: string; value: string }

/** "plan = pro\namount >= 100\nsku contains HOOD" → filters. Ops: = != > >= < <= contains exists */
export function parsePropFilters(c: any): PropFilter[] {
  if (Array.isArray(c?.property_filters)) return c.property_filters.filter((f: any) => f && f.key).map((f: any) => ({ key: String(f.key), op: String(f.op || '='), value: String(f.value ?? '') }));
  const out: PropFilter[] = [];
  for (const line of String(c?.properties || '').split('\n')) {
    const m = line.trim().match(/^([A-Za-z0-9_.\-]+)\s*(!=|>=|<=|=|>|<|\bcontains\b|\bexists\b)\s*(.*)$/i);
    if (m) out.push({ key: m[1], op: m[2].toLowerCase(), value: m[3].trim().replace(/^["']|["']$/g, '') });
  }
  return out;
}

const getPath = (o: any, path: string) => path.split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);

export function propsMatch(filters: PropFilter[], props: Record<string, unknown>): boolean {
  return filters.every((f) => {
    const v = getPath(props, f.key);
    if (f.op === 'exists') return v !== undefined && v !== null;
    if (v === undefined || v === null) return f.op === '!=';
    const s = String(v), n = Number(v), fv = Number(f.value);
    switch (f.op) {
      case '=': return s.toLowerCase() === f.value.toLowerCase();
      case '!=': return s.toLowerCase() !== f.value.toLowerCase();
      case 'contains': return s.toLowerCase().includes(f.value.toLowerCase());
      case '>': return n > fv;
      case '>=': return n >= fv;
      case '<': return n < fv;
      case '<=': return n <= fv;
    }
    return false;
  });
}

export function eventTriggerMatches(config: any, name: string, props: Record<string, unknown>): boolean {
  const want = String(config?.name || '').trim();
  if (want && want.toLowerCase() !== name.toLowerCase()) return false;
  return propsMatch(parsePropFilters(config), props);
}

onEvent(async (env, e) => {
  if (e.type !== 'custom_event' || !e.subscriberId) return;
  const d: any = e.data || {};
  const autos = await all<{ id: string; trigger: string }>(env, `SELECT id, trigger FROM automations WHERE pub_id = ? AND status = 'active' AND trigger LIKE '%custom_event%'`, e.pubId);
  for (const a of autos) for (const trig of triggerList(parseJSON<any>(a.trigger, {}))) {
    if (trig.type !== 'custom_event' || !eventTriggerMatches(trig.config, String(d.name || ''), d.properties || {})) continue;
    if (trig.filter?.rules?.length && !(await subscriberMatches(env, e.pubId, trig.filter as RuleGroup, e.subscriberId))) continue;
    await enroll(env, a.id, e.subscriberId, { trigger: 'custom_event', event: d.name, event_id: d.event_id, properties: d.properties || {} });
    break;
  }
});
