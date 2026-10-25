// API key auth + per-key rate limiting for the REST API and MCP server.
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv, Env, Publication } from '../types';
import { one, run } from './db';
import { sha256, now } from './util';

export const RATE_LIMIT = 180; // requests per window per key
export const RATE_WINDOW = 60; // seconds

export function apiError(c: Context<AppEnv>, status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return c.json({ error: { code, message, ...extra } }, status as any);
}

export async function keyFromRequest(env: Env, req: Request): Promise<{ keyId: string; pub: Publication } | null> {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(\S+)$/i);
  const raw = m?.[1] || new URL(req.url).searchParams.get('api_key') || '';
  if (!raw) return null;
  const row = await one<any>(env, `SELECT k.id AS key_id, p.* FROM api_keys k JOIN publications p ON p.id = k.pub_id WHERE k.key_hash = ? AND k.revoked_at IS NULL AND p.status != 'deleted'`, await sha256(raw));
  if (!row) return null;
  const { key_id, ...pub } = row;
  return { keyId: key_id, pub: pub as Publication };
}

/** Fixed-window limiter returning remaining budget for headers. */
export async function limit(env: Env, key: string, max = RATE_LIMIT, windowSec = RATE_WINDOW) {
  const t = now();
  const row = await one<{ count: number; reset_at: number }>(env, 'SELECT count, reset_at FROM rate_limits WHERE key = ?', key);
  if (!row || row.reset_at < t) {
    const reset = t + windowSec * 1000;
    await run(env, 'INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)', key, reset);
    return { ok: true, remaining: max - 1, reset };
  }
  if (row.count >= max) return { ok: false, remaining: 0, reset: row.reset_at };
  await run(env, 'UPDATE rate_limits SET count = count + 1 WHERE key = ?', key);
  return { ok: true, remaining: max - row.count - 1, reset: row.reset_at };
}

export const apiAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const k = await keyFromRequest(c.env, c.req.raw);
  if (!k) return apiError(c, 401, 'unauthorized', 'Missing or invalid API key. Send "Authorization: Bearer <key>". Create keys in Settings → API keys.');
  const rl = await limit(c.env, 'api:' + k.keyId);
  c.header('X-RateLimit-Limit', String(RATE_LIMIT));
  c.header('X-RateLimit-Remaining', String(Math.max(0, rl.remaining)));
  c.header('X-RateLimit-Reset', String(Math.ceil(rl.reset / 1000)));
  if (!rl.ok) {
    c.header('Retry-After', String(Math.max(1, Math.ceil((rl.reset - now()) / 1000))));
    return apiError(c, 429, 'rate_limited', `Rate limit of ${RATE_LIMIT} requests per ${RATE_WINDOW}s exceeded.`);
  }
  const pubParam = c.req.param('pubId');
  if (pubParam && pubParam !== k.pub.id && pubParam !== k.pub.slug) return apiError(c, 403, 'forbidden', 'This API key does not belong to that publication.');
  c.set('apiPub', k.pub);
  const task = run(c.env, 'UPDATE api_keys SET last_used_at = ? WHERE id = ?', now(), k.keyId);
  try { c.executionCtx.waitUntil(task); } catch { await task; }
  await next();
};
