// Outbound webhooks: per-endpoint event selection, HMAC signing, versioned payloads, retries, delivery log.
//
// Payload versions: each endpoint is pinned to a version. Event data is emitted once in the base (oldest) shape and
// rendered for an endpoint by applying every version's upgrade step up to the pinned version, so an endpoint pinned to
// an older version keeps receiving exactly the shape it was built against. Adding a version = appending one entry to
// WEBHOOK_VERSIONS with its `upgrade` function and changelog. Every delivery attempt is kept in webhook_delivery_attempts.
import type { Env } from '../types';
import { all, one, run, insert } from './db';
import { onEvent, WEBHOOK_EVENTS } from './events';
import { registerJob, enqueue } from './jobs';
import { hmac, id, now, parseJSON } from './util';

const PUBLIC = new Set<string>(WEBHOOK_EVENTS);
const BACKOFF = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000, 12 * 3600_000, 24 * 3600_000];

// ───────────────────────── payload versions ─────────────────────────
export interface WebhookEnvelope { [k: string]: any }

export interface WebhookVersion {
  version: string;
  released: string;
  summary: string;
  changes: string[];
  /** Upgrade a payload rendered in the previous version's shape to this version's shape. */
  upgrade: (p: WebhookEnvelope) => WebhookEnvelope;
}

const isoMs = (v: unknown) => (typeof v === 'number' && v > 1e11 ? new Date(v).toISOString() : v);

/** Recursively turn `*_at` millisecond timestamps into ISO 8601 strings. */
function isoTimestamps(v: any): any {
  if (Array.isArray(v)) return v.map(isoTimestamps);
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, any> = {};
  for (const [k, x] of Object.entries(v)) out[k] = /_at$/.test(k) ? isoMs(x) : isoTimestamps(x);
  return out;
}

/** 2026-11-01 subscriber object: same shape as the REST API's subscriber. */
function subscriberV2(s: any) {
  if (!s || typeof s !== 'object') return s;
  const { custom, utm_source, utm_medium, utm_campaign, ...rest } = s;
  return { ...rest, custom_fields: parseJSON(custom, custom && typeof custom === 'object' ? custom : {}), utm: { source: utm_source ?? null, medium: utm_medium ?? null, campaign: utm_campaign ?? null } };
}

/** Per-event-type data transforms for 2026-11-01 (applied after the generic ones). */
const V2_EVENT_TRANSFORMS: Array<[RegExp, (d: any) => any]> = [
  [/^podcast\.episode\./, (d) => (d.episode ? { ...d, episode: (({ duration, ...e }) => ({ ...e, duration_seconds: duration ?? null }))(d.episode) } : d)],
  [/^order\.paid$/, ({ order_id, kind, ref_id, amount_cents, currency, ...rest }) => ({ ...rest, order: { id: order_id, kind, ref_id, amount: { value_cents: amount_cents, currency } } })],
  [/^post\.sent$/, ({ recipients, ...rest }) => ({ ...rest, recipient_count: recipients })],
];

export const WEBHOOK_VERSIONS: WebhookVersion[] = [
  {
    version: '2026-10-01', released: '2026-10-01', summary: 'Initial payload format.',
    changes: [
      'Envelope: id, type, version, created (Unix seconds), publication_id, data.',
      'Subscriber objects use flat utm_source / utm_medium / utm_campaign and a JSON `custom` field; timestamps are milliseconds.',
    ],
    upgrade: (p) => p,
  },
  {
    version: '2026-11-01', released: '2026-11-01', summary: 'ISO timestamps, REST-shaped subscribers, nested order amounts.',
    changes: [
      'Envelope: `created` (Unix seconds) is replaced by `created_at` (ISO 8601) and an `object: "event"` field is added.',
      'Every `*_at` timestamp inside `data` is an ISO 8601 string instead of milliseconds.',
      'data.subscriber matches the REST API subscriber: `custom` → `custom_fields` (object), utm_* → `utm: {source, medium, campaign}`.',
      'order.paid: order fields move under data.order, and the amount becomes `order.amount: {value_cents, currency}`.',
      'podcast.episode.*: `episode.duration` is renamed `episode.duration_seconds`.',
      'post.sent: `recipients` is renamed `recipient_count`.',
    ],
    upgrade: (p) => {
      const { created, data, ...env } = p;
      let d = isoTimestamps(data || {});
      if (d.subscriber) d = { ...d, subscriber: subscriberV2(d.subscriber) };
      for (const [re, fn] of V2_EVENT_TRANSFORMS) if (re.test(p.type)) d = fn(d);
      return { id: env.id, object: 'event', type: env.type, version: env.version, created_at: new Date((created || 0) * 1000).toISOString(), publication_id: env.publication_id, data: d };
    },
  },
];

export const LATEST_WEBHOOK_VERSION = WEBHOOK_VERSIONS[WEBHOOK_VERSIONS.length - 1].version;
export const OLDEST_WEBHOOK_VERSION = WEBHOOK_VERSIONS[0].version;
export const isWebhookVersion = (v: unknown): v is string => WEBHOOK_VERSIONS.some((x) => x.version === v);

/** Render an event for an endpoint pinned to `version` (unknown versions fall back to the oldest, never break). */
export function buildPayload(version: string, e: { id: string; type: string; pubId: string; data: unknown; createdMs?: number }): WebhookEnvelope {
  const target = isWebhookVersion(version) ? version : OLDEST_WEBHOOK_VERSION;
  let p: WebhookEnvelope = { id: e.id, type: e.type, version: OLDEST_WEBHOOK_VERSION, created: Math.floor((e.createdMs ?? now()) / 1000), publication_id: e.pubId, data: e.data ?? {} };
  for (const v of WEBHOOK_VERSIONS) {
    if (v.version !== OLDEST_WEBHOOK_VERSION) p = v.upgrade({ ...p, version: v.version });
    if (v.version === target) break;
  }
  return p;
}

export async function sign(secret: string, body: string, ts: number) {
  return `t=${ts},v1=${await hmac(secret, `${ts}.${body}`)}`;
}

/** Queue deliveries of `event` to every active endpoint subscribed to it. */
export async function dispatchWebhook(env: Env, pubId: string, event: string, data: unknown) {
  const hooks = await all<{ id: string; events: string; version: string }>(env, 'SELECT id, events, version FROM webhooks WHERE pub_id = ? AND active = 1', pubId);
  const created = now();
  for (const h of hooks) {
    const evs = parseJSON<string[]>(h.events, ['*']);
    if (!evs.includes('*') && !evs.includes(event)) continue;
    const did = id();
    const payload = JSON.stringify(buildPayload(h.version, { id: did, type: event, pubId, data, createdMs: created }));
    await insert(env, 'webhook_deliveries', { id: did, webhook_id: h.id, pub_id: pubId, event, payload, status: 'pending', attempts: 0, next_attempt_at: now(), created_at: now(), updated_at: now() });
    await enqueue(env, 'webhook.deliver', { id: did });
  }
}

/** Create a delivery row for a test event rendered in the endpoint's version (Settings → Webhooks "Send test event"). */
export async function createTestDelivery(env: Env, hook: { id: string; pub_id: string; version: string }): Promise<string> {
  const did = id();
  const data = { message: 'This is a test event from OpenHive', subscriber: { id: 'sub_test', email: 'reader@example.com', name: 'Test Reader', status: 'active', tier: 'free', source: 'website', utm_source: null, utm_medium: null, utm_campaign: null, referral_code: 'TEST', custom: {}, created_at: now() } };
  const payload = JSON.stringify(buildPayload(hook.version, { id: did, type: 'webhook.test', pubId: hook.pub_id, data }));
  await insert(env, 'webhook_deliveries', { id: did, webhook_id: hook.id, pub_id: hook.pub_id, event: 'webhook.test', payload, status: 'pending', attempts: 0, created_at: now(), updated_at: now() });
  return did;
}

export async function attemptDelivery(env: Env, deliveryId: string, manual = false): Promise<boolean> {
  const d = await one<any>(env, `SELECT d.*, w.url, w.secret, w.active FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.id = ?`, deliveryId);
  if (!d) return false;
  if (!d.active && !manual) {
    await run(env, `UPDATE webhook_deliveries SET status = 'failed', response_body = 'endpoint disabled', updated_at = ? WHERE id = ?`, now(), deliveryId);
    return false;
  }
  const ts = Math.floor(now() / 1000);
  const started = Date.now();
  let code = 0, body = '', error: string | null = null;
  try {
    const r = await fetch(d.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'OpenHive-Webhooks/1.0', 'openhive-signature': await sign(d.secret, d.payload, ts), 'openhive-event': d.event, 'openhive-delivery': d.id, 'openhive-version': parseJSON<any>(d.payload, {}).version || '' },
      body: d.payload,
      signal: AbortSignal.timeout(15_000),
    });
    code = r.status;
    body = (await r.text()).slice(0, 2000);
  } catch (e: any) {
    error = String(e?.message || e).slice(0, 2000);
    body = error;
  }
  const ok = code >= 200 && code < 300;
  const attempts = d.attempts + 1;
  const retry = !ok && !manual && attempts <= BACKOFF.length;
  await insert(env, 'webhook_delivery_attempts', { id: id(), delivery_id: d.id, webhook_id: d.webhook_id, attempt: attempts, manual: manual ? 1 : 0, url: d.url, response_code: code || null, response_body: error ? null : body, error, duration_ms: Date.now() - started, created_at: now() });
  await run(
    env,
    `UPDATE webhook_deliveries SET status = ?, attempts = ?, response_code = ?, response_body = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`,
    ok ? 'success' : retry ? 'retrying' : 'failed', attempts, code || null, body, retry ? now() + BACKOFF[attempts - 1] : null, now(), deliveryId,
  );
  if (retry) await enqueue(env, 'webhook.deliver', { id: deliveryId }, now() + BACKOFF[attempts - 1]);
  return ok;
}

/** Every attempt for a delivery, oldest first. */
export async function deliveryAttempts(env: Env, deliveryId: string) {
  return all<any>(env, 'SELECT attempt, manual, url, response_code, response_body, error, duration_ms, created_at FROM webhook_delivery_attempts WHERE delivery_id = ? ORDER BY attempt, created_at', deliveryId);
}

/** Deliver an arbitrary request (automation webhook steps) with retries handled by the job system. */
export async function callWebhook(url: string, method: string, payload: unknown, secret?: string): Promise<{ ok: boolean; status: number; body: string }> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'OpenHive-Automations/1.0' };
  if (secret) headers['openhive-signature'] = await sign(secret, body, Math.floor(now() / 1000));
  try {
    const r = await fetch(url, { method, headers, body: method === 'GET' ? undefined : body, signal: AbortSignal.timeout(15_000) });
    return { ok: r.ok, status: r.status, body: (await r.text()).slice(0, 2000) };
  } catch (e: any) {
    return { ok: false, status: 0, body: String(e?.message || e) };
  }
}

registerJob('webhook.deliver', async (env, p) => {
  await attemptDelivery(env, p.id);
});

// Fan out public events from the bus.
onEvent(async (env, e) => {
  if (!PUBLIC.has(e.type)) return;
  let data: any = { ...(e.data || {}) };
  if (e.subscriberId && !data.subscriber) {
    const s = await one<any>(env, 'SELECT id, email, name, status, tier, source, utm_source, utm_medium, utm_campaign, referral_code, custom, created_at FROM subscribers WHERE id = ?', e.subscriberId);
    if (s) data.subscriber = { ...s, custom: parseJSON(s.custom, {}) };
  }
  await dispatchWebhook(env, e.pubId, e.type, data);
});
