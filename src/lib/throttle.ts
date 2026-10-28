// Sending throttles, per-mailbox-provider rate limits and the emergency kill switch.
//
// - send_throttles (written by the Deliverability Guardian, read here): scope 'global' | 'provider:<p>' | 'workspace:<id>',
//   factor 0 = paused, 0.5 = half speed, 1 = normal; rows whose `until` has passed are ignored.
// - sending_stops: the kill switch. 'global' (superadmin, platform-wide) or 'workspace:<id>' (owner or superadmin).
//   A stop makes every factor 0: newsletters, automations and API transactional mail wait (nothing is dropped) and
//   continue when the stop is lifted. Account emails (login links, password resets) are not stopped.
// - PROVIDER_RATES: platform-wide emails per minute per mailbox provider, scaled by the throttle factors and shared by
//   every send through fixed one-minute windows in rate_limits.
import type { Env } from '../types';
import { all, one, run } from './db';
import { now, mailboxProvider } from './util';

export type Provider = 'gmail' | 'outlook' | 'yahoo' | 'apple' | 'other';
export const PROVIDERS: Provider[] = ['gmail', 'outlook', 'yahoo', 'apple', 'other'];

/** Platform-wide emails per minute per mailbox provider (before throttle factors). */
export const PROVIDER_RATES: Record<Provider, number> = { gmail: 3000, outlook: 1200, yahoo: 1200, apple: 1000, other: 3000 };

export function providerOf(email: string): Provider {
  const p = mailboxProvider(email);
  return (PROVIDERS as string[]).includes(p) ? (p as Provider) : 'other';
}

export interface ThrottleRow { scope: string; factor: number; reason: string | null; until: number | null; created_at: number | null }
export interface StopRow { scope: string; reason: string | null; stopped_by: string | null; created_at: number }

/** Everything that limits sending right now (one small query each; call once per batch). */
export interface Throttles { rows: Map<string, ThrottleRow>; stops: Map<string, StopRow> }

export async function loadThrottles(env: Env): Promise<Throttles> {
  const t = now();
  const [rows, stops] = await Promise.all([
    all<ThrottleRow>(env, 'SELECT * FROM send_throttles WHERE until IS NULL OR until >= ?', t).catch(() => [] as ThrottleRow[]),
    all<StopRow>(env, 'SELECT * FROM sending_stops').catch(() => [] as StopRow[]),
  ]);
  return { rows: new Map(rows.map((r) => [r.scope, r])), stops: new Map(stops.map((s) => [s.scope, s])) };
}

const clamp01 = (n: number) => (isFinite(n) ? Math.min(1, Math.max(0, n)) : 1);

/** Effective factor from preloaded throttles: the most restrictive of global, provider and workspace (0 when stopped). */
export function factorFrom(t: Throttles, workspaceId: string | null | undefined, provider?: string | null): number {
  if (t.stops.has('global') || (workspaceId && t.stops.has('workspace:' + workspaceId))) return 0;
  let f = 1;
  const g = t.rows.get('global'); if (g) f = Math.min(f, clamp01(g.factor));
  if (workspaceId) { const w = t.rows.get('workspace:' + workspaceId); if (w) f = Math.min(f, clamp01(w.factor)); }
  if (provider) { const p = t.rows.get('provider:' + provider); if (p) f = Math.min(f, clamp01(p.factor)); }
  return f;
}

/**
 * Throttle factor for a workspace sending to a mailbox provider: min(global, provider:<p>, workspace:<id>), 0 while a
 * kill switch applies. Pass provider = null to ignore provider rows (whole-send pace).
 */
export async function throttleFor(env: Env, workspaceId: string | null | undefined, provider: string | null): Promise<number> {
  return factorFrom(await loadThrottles(env), workspaceId, provider);
}

/** Why sending is held for this workspace, or null. */
export function holdReason(t: Throttles, workspaceId: string | null | undefined): string | null {
  const g = t.stops.get('global');
  if (g) return 'Sending is stopped platform-wide by the operators' + (g.reason ? `: ${g.reason}` : '') + '. Queued email will go out when it resumes.';
  const w = workspaceId ? t.stops.get('workspace:' + workspaceId) : null;
  if (w) return 'Sending is stopped for this account' + (w.reason ? `: ${w.reason}` : '') + '. Queued email will go out when it resumes.';
  const f = factorFrom(t, workspaceId, null);
  if (f <= 0) {
    const r = t.rows.get('global')?.factor === 0 ? t.rows.get('global') : t.rows.get('workspace:' + workspaceId);
    return 'Sending is paused by the deliverability guardian' + (r?.reason ? `: ${r.reason}` : '') + '.';
  }
  return null;
}

// ───────── kill switch ─────────
export async function stopSending(env: Env, scope: 'global' | `workspace:${string}`, reason: string, by: string) {
  await run(env, `INSERT INTO sending_stops (scope, reason, stopped_by, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope) DO UPDATE SET reason = excluded.reason, stopped_by = excluded.stopped_by, created_at = excluded.created_at`, scope, reason.slice(0, 300) || null, by, now());
}
export async function resumeSending(env: Env, scope: string) {
  await run(env, 'DELETE FROM sending_stops WHERE scope = ?', scope);
}
export async function getStop(env: Env, scope: string): Promise<StopRow | null> {
  return one<StopRow>(env, 'SELECT * FROM sending_stops WHERE scope = ?', scope).catch(() => null);
}

// ───────── per-provider rate windows ─────────
/**
 * Reserve up to `want` sends to a provider in the current one-minute window (shared platform-wide).
 * Returns how many may go now (0..want). `factor` scales the provider's per-minute rate.
 */
export async function reserveProvider(env: Env, provider: Provider, want: number, factor: number): Promise<number> {
  if (want <= 0) return 0;
  const cap = Math.floor(PROVIDER_RATES[provider] * clamp01(factor));
  if (cap <= 0) return 0;
  const t = now();
  const key = 'prov:' + provider;
  const row = await one<{ count: number; reset_at: number }>(env,
    `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 0, ?)
     ON CONFLICT(key) DO UPDATE SET count = CASE WHEN reset_at < ? THEN 0 ELSE count END, reset_at = CASE WHEN reset_at < ? THEN excluded.reset_at ELSE reset_at END
     RETURNING count, reset_at`, key, t + 60_000, t, t);
  const left = cap - (row?.count || 0);
  const grant = Math.max(0, Math.min(want, left));
  if (grant > 0) await run(env, 'UPDATE rate_limits SET count = count + ? WHERE key = ?', grant, key);
  return grant;
}

/** Milliseconds until the provider's current window resets (for rescheduling throttled recipients). */
export async function providerWindowMs(env: Env, provider: Provider): Promise<number> {
  const r = await one<{ reset_at: number }>(env, 'SELECT reset_at FROM rate_limits WHERE key = ?', 'prov:' + provider);
  return Math.max(5_000, Math.min(60_000, (r?.reset_at || now() + 60_000) - now()));
}

// ───────── adaptive concurrency ─────────
/** Above this share of deferrals/transient errors in a batch, the send slows down. */
export const ADAPTIVE_ERROR_THRESHOLD = 0.1;
export const MIN_PACE = 0.1;
/** New pace after a batch: halve on trouble, recover by 0.1 per clean batch. */
export function nextPace(pace: number, attempted: number, troubled: number): number {
  const p = isFinite(pace) && pace > 0 ? pace : 1;
  if (attempted >= 5 && troubled / attempted > ADAPTIVE_ERROR_THRESHOLD) return Math.max(MIN_PACE, Math.round(p * 50) / 100);
  return Math.min(1, Math.round((p + 0.1) * 100) / 100);
}

// Per-isolate cache for hot paths (one recipient at a time: automations, retries). Batches call loadThrottles directly.
let cache: { at: number; t: Throttles } | null = null;
export async function cachedThrottles(env: Env, ttlMs = 3_000): Promise<Throttles> {
  if (cache && Date.now() - cache.at < ttlMs) return cache.t;
  const t = await loadThrottles(env);
  cache = { at: Date.now(), t };
  return t;
}
export function clearThrottleCache() { cache = null; }
