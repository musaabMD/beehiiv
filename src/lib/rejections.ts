// Counts addresses refused by validateEmail, by kind, per UTC day. No addresses are stored.
import type { Env } from '../types';
import { run } from './db';

export type RejectionKind = 'typo' | 'dead_domain' | 'disposable' | 'invalid';

export function rejectionKind(v: { reason?: string; suggestion?: string | null }): RejectionKind {
  if (v.suggestion) return 'typo';
  const r = v.reason || '';
  if (/cannot receive/i.test(r)) return 'dead_domain';
  if (/disposable/i.test(r)) return 'disposable';
  return 'invalid';
}

export async function countRejection(env: Env, v: { reason?: string; suggestion?: string | null }) {
  const day = new Date().toISOString().slice(0, 10);
  await run(env, `INSERT INTO email_rejections (day, reason, count) VALUES (?, ?, 1) ON CONFLICT(day, reason) DO UPDATE SET count = count + 1`, day, rejectionKind(v)).catch(() => {});
}
