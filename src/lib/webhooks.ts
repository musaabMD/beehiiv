// Outbound webhooks: per-endpoint event selection, HMAC signing, versioned payloads, retries, delivery log.
import type { Env } from '../types';
import { all, one, run, insert } from './db';
import { onEvent, WEBHOOK_EVENTS } from './events';
import { registerJob, enqueue } from './jobs';
import { hmac, id, now, parseJSON } from './util';

const PUBLIC = new Set<string>(WEBHOOK_EVENTS);
const BACKOFF = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000, 12 * 3600_000, 24 * 3600_000];

export async function sign(secret: string, body: string, ts: number) {
  return `t=${ts},v1=${await hmac(secret, `${ts}.${body}`)}`;
}

/** Queue deliveries of `event` to every active endpoint subscribed to it. */
export async function dispatchWebhook(env: Env, pubId: string, event: string, data: unknown) {
  const hooks = await all<{ id: string; events: string; version: string }>(env, 'SELECT id, events, version FROM webhooks WHERE pub_id = ? AND active = 1', pubId);
  for (const h of hooks) {
    const evs = parseJSON<string[]>(h.events, ['*']);
    if (!evs.includes('*') && !evs.includes(event)) continue;
    const did = id();
    const payload = JSON.stringify({ id: did, type: event, version: h.version, created: Math.floor(now() / 1000), publication_id: pubId, data });
    await insert(env, 'webhook_deliveries', { id: did, webhook_id: h.id, pub_id: pubId, event, payload, status: 'pending', attempts: 0, next_attempt_at: now(), created_at: now(), updated_at: now() });
    await enqueue(env, 'webhook.deliver', { id: did });
  }
}

export async function attemptDelivery(env: Env, deliveryId: string, manual = false): Promise<boolean> {
  const d = await one<any>(env, `SELECT d.*, w.url, w.secret, w.active FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.id = ?`, deliveryId);
  if (!d) return false;
  if (!d.active && !manual) {
    await run(env, `UPDATE webhook_deliveries SET status = 'failed', response_body = 'endpoint disabled', updated_at = ? WHERE id = ?`, now(), deliveryId);
    return false;
  }
  const ts = Math.floor(now() / 1000);
  let code = 0, body = '';
  try {
    const r = await fetch(d.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'OpenHive-Webhooks/1.0', 'openhive-signature': await sign(d.secret, d.payload, ts), 'openhive-event': d.event, 'openhive-delivery': d.id },
      body: d.payload,
      signal: AbortSignal.timeout(15_000),
    });
    code = r.status;
    body = (await r.text()).slice(0, 2000);
  } catch (e: any) {
    body = String(e?.message || e).slice(0, 2000);
  }
  const ok = code >= 200 && code < 300;
  const attempts = d.attempts + 1;
  const retry = !ok && !manual && attempts <= BACKOFF.length;
  await run(
    env,
    `UPDATE webhook_deliveries SET status = ?, attempts = ?, response_code = ?, response_body = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`,
    ok ? 'success' : retry ? 'retrying' : 'failed', attempts, code || null, body, retry ? now() + BACKOFF[attempts - 1] : null, now(), deliveryId,
  );
  if (retry) await enqueue(env, 'webhook.deliver', { id: deliveryId }, now() + BACKOFF[attempts - 1]);
  return ok;
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
