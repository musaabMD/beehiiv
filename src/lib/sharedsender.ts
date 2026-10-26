// Shared sender for a multi-tenant service. A publication without a verified custom sending domain sends from
// <pub-slug>@<SHARED_FROM_DOMAIN> (default: MAIL_FROM's domain), with Reply-To pointing at the publication's reply-to
// address or, when none is set, the workspace owner's email. Publications with a verified custom email domain
// (Settings → Domains) keep their own From address exactly as configured.
import type { Env, Publication } from '../types';
import { one } from './db';
import { now, MIN } from './util';

export function sharedDomain(env: Env): string {
  return (env.SHARED_FROM_DOMAIN || env.MAIL_FROM.split('@')[1] || '').trim().toLowerCase();
}

export function sharedAddress(env: Env, pub: Pick<Publication, 'slug'>): string {
  const local = (pub.slug || 'news').toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+|[._-]+$/g, '').slice(0, 64) || 'news';
  return `${local}@${sharedDomain(env)}`;
}

const verifiedCache = new Map<string, { at: number; v: boolean }>();
async function hasVerifiedDomain(env: Env, pubId: string, host: string): Promise<boolean> {
  const k = pubId + '|' + host;
  const hit = verifiedCache.get(k);
  if (hit && now() - hit.at < MIN) return hit.v;
  const v = !!(await one(env, `SELECT 1 FROM domains WHERE pub_id = ? AND hostname = ? AND kind = 'email' AND status = 'verified'`, pubId, host));
  verifiedCache.set(k, { at: now(), v });
  return v;
}

/** Rewrite a From identity to the shared sender unless its domain is verified for this publication. */
export async function applySharedSender(env: Env, pub: Pick<Publication, 'id' | 'slug'>, from: { email: string; name: string }): Promise<{ email: string; name: string; shared: boolean }> {
  const host = (from.email.split('@')[1] || '').toLowerCase();
  if (host && (await hasVerifiedDomain(env, pub.id, host))) return { ...from, shared: false };
  return { email: sharedAddress(env, pub), name: from.name, shared: true };
}

const ownerCache = new Map<string, { at: number; email: string | null }>();
/** Reply-To for newsletters: the publication's reply-to, else the workspace owner's email. */
export async function replyToFor(env: Env, pub: Pick<Publication, 'reply_to' | 'workspace_id'>): Promise<string | null> {
  if (pub.reply_to) return pub.reply_to;
  const hit = ownerCache.get(pub.workspace_id);
  if (hit && now() - hit.at < 5 * MIN) return hit.email;
  const row = await one<{ email: string }>(env, 'SELECT u.email FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE w.id = ?', pub.workspace_id).catch(() => null);
  ownerCache.set(pub.workspace_id, { at: now(), email: row?.email || null });
  return row?.email || null;
}
