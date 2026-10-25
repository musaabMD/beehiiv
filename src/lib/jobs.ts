// Background jobs: a D1-backed queue processed by the minute cron and opportunistically via waitUntil.
// Modules register handlers with registerJob(kind, fn) at import time.
import type { Env } from '../types';
import { all, run, insert } from './db';
import { id, now, MIN } from './util';

export type JobHandler = (env: Env, payload: any, job: { id: string; attempts: number }) => Promise<void | { retryInMs?: number }>;
const handlers = new Map<string, JobHandler>();

/** Periodic tasks run on every cron tick (each guarded by its own interval). */
const periodic: Array<{ name: string; everyMs: number; fn: (env: Env) => Promise<void> }> = [];

export function registerJob(kind: string, fn: JobHandler) {
  handlers.set(kind, fn);
}

export function registerPeriodic(name: string, everyMs: number, fn: (env: Env) => Promise<void>) {
  if (!periodic.find((p) => p.name === name)) periodic.push({ name, everyMs, fn });
}

export async function enqueue(env: Env, kind: string, payload: unknown = {}, runAt = now()): Promise<string> {
  const jid = id();
  await insert(env, 'jobs', { id: jid, kind, payload: JSON.stringify(payload ?? {}), run_at: runAt, status: 'pending', attempts: 0, created_at: now() });
  return jid;
}

/** Process due jobs until the time budget is used. Safe to call concurrently (row locking via locked_until). */
export async function runJobs(env: Env, budgetMs = 20_000): Promise<number> {
  const start = Date.now();
  let processed = 0;
  while (Date.now() - start < budgetMs) {
    const t = now();
    const due = await all<{ id: string; kind: string; payload: string; attempts: number }>(
      env,
      `SELECT id, kind, payload, attempts FROM jobs WHERE status = 'pending' AND run_at <= ? AND (locked_until IS NULL OR locked_until < ?) ORDER BY run_at LIMIT 10`,
      t, t,
    );
    if (!due.length) break;
    for (const j of due) {
      // claim
      const claim = await run(env, `UPDATE jobs SET locked_until = ?, status = 'running', attempts = attempts + 1 WHERE id = ? AND status = 'pending'`, t + 5 * MIN, j.id);
      if (!claim.meta.changes) continue;
      const h = handlers.get(j.kind);
      if (!h) {
        await run(env, `UPDATE jobs SET status = 'failed', error = ? WHERE id = ?`, 'no handler for ' + j.kind, j.id);
        continue;
      }
      try {
        const res = await h(env, JSON.parse(j.payload || '{}'), { id: j.id, attempts: j.attempts + 1 });
        if (res && res.retryInMs !== undefined) {
          await run(env, `UPDATE jobs SET status = 'pending', locked_until = NULL, run_at = ? WHERE id = ?`, now() + res.retryInMs, j.id);
        } else {
          await run(env, `UPDATE jobs SET status = 'done', locked_until = NULL WHERE id = ?`, j.id);
        }
      } catch (e: any) {
        const attempts = j.attempts + 1;
        const giveUp = attempts >= 8;
        await run(
          env,
          `UPDATE jobs SET status = ?, locked_until = NULL, run_at = ?, error = ? WHERE id = ?`,
          giveUp ? 'failed' : 'pending', now() + Math.min(2 ** attempts * 30_000, 6 * 3600_000), String(e?.stack || e).slice(0, 2000), j.id,
        );
        await logError(env, 'job:' + j.kind, e);
      }
      processed++;
      if (Date.now() - start > budgetMs) break;
    }
  }
  return processed;
}

export async function runPeriodic(env: Env) {
  const t = now();
  for (const p of periodic) {
    const key = 'periodic:' + p.name;
    const row = await env.DB.prepare('SELECT reset_at FROM rate_limits WHERE key = ?').bind(key).first<{ reset_at: number }>();
    if (row && row.reset_at > t) continue;
    await run(env, 'INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES (?, 0, ?)', key, t + p.everyMs - 5000);
    try {
      await p.fn(env);
    } catch (e) {
      await logError(env, 'periodic:' + p.name, e);
    }
  }
  // housekeeping
  await run(env, `DELETE FROM jobs WHERE status = 'done' AND created_at < ?`, t - 7 * 86_400_000);
  await run(env, `DELETE FROM rate_limits WHERE reset_at < ? AND key NOT LIKE 'periodic:%'`, t);
}

export async function logError(env: Env, source: string, e: unknown, pubId?: string) {
  const err = e as any;
  console.error(source, err);
  try {
    await insert(env, 'error_log', { id: id(), pub_id: pubId ?? null, source, message: String(err?.message || err).slice(0, 1000), stack: String(err?.stack || '').slice(0, 4000), created_at: now() });
  } catch {}
}

/** Kick the job runner in the background after a request enqueues work (so local dev doesn't wait for cron). */
export function kick(env: Env, ctx: { waitUntil(p: Promise<unknown>): void } | undefined) {
  if (ctx) ctx.waitUntil(runJobs(env, 25_000).catch(() => 0));
}
