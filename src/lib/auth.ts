// Auth: PBKDF2 passwords, DB sessions, roles (owner/admin/member/contributor) at workspace or publication level.
import type { MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv, Ctx, Env, Publication, Role, User } from '../types';
import { one, all, run, insert } from './db';
import { id, now, token, sha256, b64url, safeEqual, DAY } from './util';

const ITER = 100_000;

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, key, 256);
  return `pbkdf2$${ITER}$${b64url(salt)}$${b64url(bits)}`;
}

function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/** Constant-time verify. Always does the full PBKDF2 work even for unknown users (pass null hash). */
export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  const parts = (stored || 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAA').split('$');
  const iter = Number(parts[1]) || ITER;
  const salt = fromB64url(parts[2]);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return !!stored && safeEqual(b64url(bits), parts[3]);
}

export const SESSION_COOKIE = 'oh_sid';
export const READER_COOKIE = 'oh_reader';

function secure(c: Ctx) {
  return new URL(c.req.url).protocol === 'https:';
}

export async function createSession(c: Ctx, userId: string) {
  const tok = token(32);
  await insert(c.env, 'sessions', { id: await sha256(tok), user_id: userId, expires_at: now() + 30 * DAY, user_agent: c.req.header('user-agent')?.slice(0, 200) ?? null, created_at: now() });
  setCookie(c, SESSION_COOKIE, tok, { httpOnly: true, sameSite: 'Lax', secure: secure(c), path: '/', maxAge: 30 * 86400 });
}

export async function destroySession(c: Ctx) {
  const tok = getCookie(c, SESSION_COOKIE);
  if (tok) await run(c.env, 'DELETE FROM sessions WHERE id = ?', await sha256(tok));
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export async function currentUser(c: Ctx): Promise<User | null> {
  const tok = getCookie(c, SESSION_COOKIE);
  if (!tok) return null;
  const row = await one<User & { expires_at: number }>(c.env, 'SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?', await sha256(tok));
  if (!row || row.expires_at < now()) return null;
  return row;
}

/** Publications a user can access with their effective role. */
export async function userPubs(env: Env, userId: string): Promise<Array<Publication & { role: Role }>> {
  return all<Publication & { role: Role }>(
    env,
    `SELECT p.*, COALESCE(
        (SELECT m.role FROM memberships m WHERE m.user_id = ? AND m.pub_id = p.id),
        (SELECT m.role FROM memberships m WHERE m.user_id = ? AND m.pub_id = '' AND m.workspace_id = p.workspace_id)
      ) AS role
     FROM publications p
     WHERE p.status != 'deleted' AND (
       EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = ? AND m.pub_id = p.id) OR
       EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = ? AND m.pub_id = '' AND m.workspace_id = p.workspace_id))
     ORDER BY p.created_at`,
    userId, userId, userId, userId,
  );
}

// ───────── permissions ─────────
export type Perm = 'admin' | 'manage' | 'publish' | 'draft' | 'view';
const RANK: Record<Role, number> = { owner: 4, admin: 3, member: 2, contributor: 1 };

/**
 * admin   – billing, exports, integrations, payments, domains, team, API keys, webhooks
 * manage  – members: everything except admin areas
 * publish – send/publish posts, activate automations (members+)
 * draft   – contributors: create/edit drafts of posts & automations
 */
export function can(role: Role | undefined, perm: Perm): boolean {
  const r = role ? RANK[role] : 0;
  switch (perm) {
    case 'admin': return r >= 3;
    case 'manage': case 'publish': return r >= 2;
    case 'draft': case 'view': return r >= 1;
  }
}

/** Dashboard guard: requires a session and resolves the current publication. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await currentUser(c);
  if (!user) {
    if (c.req.method === 'GET') return c.redirect('/login?next=' + encodeURIComponent(new URL(c.req.url).pathname));
    return c.text('Not signed in', 401);
  }
  c.set('user', user);
  const pubs = await userPubs(c.env, user.id);
  c.set('pubs', pubs);
  const want = c.req.query('pub') || getCookie(c, 'oh_pub');
  const pub = pubs.find((p) => p.id === want) || pubs[0];
  if (!pub) {
    const path = new URL(c.req.url).pathname;
    // platform operators can use /app/admin without a publication of their own
    if (!path.startsWith('/app/onboarding') && !path.startsWith('/app/settings/workspace') && !path.startsWith('/app/admin')) return c.redirect('/app/onboarding');
  } else {
    c.set('pub', pub);
    c.set('role', pub.role);
    if (c.req.query('pub') && c.req.query('pub') !== getCookie(c, 'oh_pub')) setCookie(c, 'oh_pub', pub.id, { path: '/', sameSite: 'Lax', maxAge: 365 * 86400 });
  }
  // CSRF: reject cross-origin form posts.
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('origin');
    if (origin && new URL(origin).host !== new URL(c.req.url).host) return c.text('Cross-site request blocked', 403);
  }
  await next();
};

/** Route-level permission guard. */
export function requirePerm(perm: Perm): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!can(c.get('role'), perm)) return c.html(`<p style="font-family:sans-serif;padding:40px">You don't have permission to do that. Ask a publication admin.</p>`, 403);
    await next();
  };
}

export async function audit(c: Ctx, action: string, target?: string, data: Record<string, unknown> = {}) {
  await insert(c.env, 'audit_log', { id: id(), pub_id: c.get('pub')?.id ?? null, user_id: c.get('user')?.id ?? null, action, target: target ?? null, data: JSON.stringify(data), created_at: now() });
}

// ───────── readers (subscribers logging into publication sites) ─────────
/** Reader sessions are keyed by email so one login works across every publication on this instance. */
export async function createReaderSession(c: Ctx, email: string) {
  const tok = token(32);
  await insert(c.env, 'reader_sessions', { id: await sha256(tok), email: email.toLowerCase(), expires_at: now() + 60 * DAY, created_at: now() });
  setCookie(c, READER_COOKIE, tok, { httpOnly: true, sameSite: 'Lax', secure: secure(c), path: '/', maxAge: 60 * 86400 });
}

export async function readerEmail(c: Ctx): Promise<string | null> {
  const tok = getCookie(c, READER_COOKIE);
  if (!tok) return null;
  const row = await one<{ email: string; expires_at: number }>(c.env, 'SELECT email, expires_at FROM reader_sessions WHERE id = ?', await sha256(tok));
  return row && row.expires_at > now() ? row.email : null;
}

export async function destroyReaderSession(c: Ctx) {
  const tok = getCookie(c, READER_COOKIE);
  if (tok) await run(c.env, 'DELETE FROM reader_sessions WHERE id = ?', await sha256(tok));
  deleteCookie(c, READER_COOKIE, { path: '/' });
}

/** Issue a single-use token (login/reset/device/reader_login). Returns the raw token. */
export async function issueToken(env: Env, kind: string, ttlMs: number, fields: { user_id?: string; pub_id?: string; subscriber_id?: string; data?: unknown } = {}): Promise<string> {
  const tok = token(32);
  await insert(env, 'auth_tokens', { id: await sha256(tok), kind, user_id: fields.user_id ?? null, pub_id: fields.pub_id ?? null, subscriber_id: fields.subscriber_id ?? null, data: JSON.stringify(fields.data ?? {}), expires_at: now() + ttlMs, created_at: now() });
  return tok;
}

/** Consume a single-use token atomically. */
export async function consumeToken(env: Env, kind: string, tok: string): Promise<any | null> {
  const h = await sha256(tok || '');
  const res = await run(env, `UPDATE auth_tokens SET used_at = ? WHERE id = ? AND kind = ? AND used_at IS NULL AND expires_at > ?`, now(), h, kind, now());
  if (!res.meta.changes) return null;
  return one(env, 'SELECT * FROM auth_tokens WHERE id = ?', h);
}
