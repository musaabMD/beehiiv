import type { Env } from '../types';

type P = unknown[];

/** D1 rejects LIKE/GLOB patterns over 50 bytes ("pattern too complex"). Trim long wildcard patterns so a
 *  search on a long slug, URL or query matches slightly more broadly instead of failing. */
const LIKE_MAX = 50;
function clampLike(s: string): string {
  if (new TextEncoder().encode(s).length <= LIKE_MAX) return s;
  const lead = s.startsWith('%'), trail = s.endsWith('%');
  let core = s.slice(lead ? 1 : 0, trail ? -1 : undefined);
  const room = LIKE_MAX - (lead ? 1 : 0) - (trail || !lead ? 1 : 0);
  while (new TextEncoder().encode(core).length > room) core = lead && !trail ? core.slice(1) : core.slice(0, -1);
  return (lead ? '%' : '') + core + (trail || !lead ? '%' : '');
}
function bindable(sql: string, params: P): P {
  if (!/\b(LIKE|GLOB)\b/i.test(sql)) return params;
  return params.map((v) => (typeof v === 'string' && v.includes('%') ? clampLike(v) : v));
}

export async function one<T = any>(env: Env, sql: string, ...params: P): Promise<T | null> {
  return (await env.DB.prepare(sql).bind(...bindable(sql, params)).first<T>()) ?? null;
}

export async function all<T = any>(env: Env, sql: string, ...params: P): Promise<T[]> {
  const r = await env.DB.prepare(sql).bind(...bindable(sql, params)).all<T>();
  return r.results ?? [];
}

export async function run(env: Env, sql: string, ...params: P): Promise<D1Result> {
  return env.DB.prepare(sql).bind(...bindable(sql, params)).run();
}

export async function val<T = number>(env: Env, sql: string, ...params: P): Promise<T> {
  const r = await env.DB.prepare(sql).bind(...bindable(sql, params)).first<Record<string, T>>();
  return (r ? Object.values(r)[0] : 0) as T;
}

export function stmt(env: Env, sql: string, ...params: P): D1PreparedStatement {
  return env.DB.prepare(sql).bind(...bindable(sql, params));
}

export async function batch(env: Env, stmts: D1PreparedStatement[]): Promise<void> {
  // D1 batches are transactional; keep each batch reasonably small.
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

/** INSERT helper: insert(env, 'table', {col: val, ...}) */
export async function insert(env: Env, table: string, row: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(row);
  await env.DB.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .bind(...cols.map((k) => norm(row[k])))
    .run();
}

export function insertStmt(env: Env, table: string, row: Record<string, unknown>, orIgnore = false): D1PreparedStatement {
  const cols = Object.keys(row);
  return env.DB.prepare(`INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...cols.map((k) => norm(row[k])));
}

/** UPDATE helper scoped by id (and optional pub_id for tenant safety). */
export async function update(env: Env, table: string, id: string, patch: Record<string, unknown>, pubId?: string): Promise<void> {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  const where = pubId ? 'id = ? AND pub_id = ?' : 'id = ?';
  await env.DB.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE ${where}`)
    .bind(...cols.map((k) => norm(patch[k])), id, ...(pubId ? [pubId] : []))
    .run();
}

function norm(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

/** Cursor pagination (by created_at desc, id). Returns rows + next cursor. */
export function encodeCursor(row: { created_at: number; id: string }): string {
  return btoa(`${row.created_at}:${row.id}`);
}
export function decodeCursor(c: string | undefined | null): { t: number; id: string } | null {
  if (!c) return null;
  try {
    const [t, id] = atob(c).split(':');
    return { t: Number(t), id };
  } catch {
    return null;
  }
}
