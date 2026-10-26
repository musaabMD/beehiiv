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

// ───────── secrets at rest (SSO client secrets, social tokens) ─────────
/** AES-GCM key derived (HKDF-SHA-256) from APP_SECRET. On localhost a dev-only key is used when APP_SECRET is unset. */
export function secretsConfigured(env: Env): boolean {
  return !!env.APP_SECRET || isLocalApp(env);
}
function isLocalApp(env: Env): boolean {
  try { return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(env.APP_URL).hostname); } catch { return false; }
}
const keyCache = new Map<string, CryptoKey>();
async function sealKey(env: Env): Promise<CryptoKey> {
  const material = env.APP_SECRET || (isLocalApp(env) ? 'insecure-local-dev:' + env.APP_URL : '');
  if (!material) throw new Error('APP_SECRET is not set. Run `npx wrangler secret put APP_SECRET` (any long random string) before storing credentials.');
  const hit = keyCache.get(material);
  if (hit) return hit;
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(material), 'HKDF', false, ['deriveKey']);
  const k = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('openhive-secrets-v1'), info: new TextEncoder().encode('aes-gcm') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  keyCache.set(material, k);
  return k;
}
/** Encrypt a string (or JSON-able value) → "v1.<iv>.<ciphertext>" (base64url). */
export async function sealSecret(env: Env, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sealKey(env), new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)));
  return `v1.${b64url(iv)}.${b64url(ct)}`;
}
export async function openSecret(env: Env, sealed: string): Promise<string> {
  const [v, iv, ct] = (sealed || '').split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('Stored credential is unreadable');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(iv) }, await sealKey(env), fromB64url(ct));
  return new TextDecoder().decode(pt);
}

// ───────── single sign-on (OpenID Connect) ─────────
export interface OidcConfig { issuer: string; clientId: string; clientSecret: string }
export interface OidcDiscovery { issuer: string; authorization_endpoint: string; token_endpoint: string; userinfo_endpoint?: string; jwks_uri?: string }

const discoCache = new Map<string, { at: number; d: OidcDiscovery }>();
export async function oidcDiscover(issuer: string): Promise<OidcDiscovery> {
  const iss = issuer.replace(/\/$/, '');
  const hit = discoCache.get(iss);
  if (hit && hit.at > Date.now() - 10 * 60_000) return hit.d;
  const r = await fetch(`${iss}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`OIDC discovery failed (${r.status}) at ${iss}/.well-known/openid-configuration`);
  const d = (await r.json()) as OidcDiscovery;
  if (!d.authorization_endpoint || !d.token_endpoint) throw new Error('OIDC discovery document is missing endpoints');
  if (d.issuer && d.issuer.replace(/\/$/, '') !== iss) throw new Error(`Issuer mismatch: configured ${iss}, provider says ${d.issuer}`);
  discoCache.set(iss, { at: Date.now(), d });
  return d;
}

/** Start an authorization-code + PKCE flow. Stores state/nonce/verifier in a single-use token; returns the redirect URL. */
export async function oidcStart(env: Env, cfg: OidcConfig, redirectUri: string, data: Record<string, unknown>, loginHint?: string): Promise<string> {
  const d = await oidcDiscover(cfg.issuer);
  const verifier = token(32);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const nonce = token(16);
  const state = await issueToken(env, 'oidc_state', 10 * 60_000, { data: { ...data, nonce, verifier } });
  const u = new URL(d.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (loginHint) u.searchParams.set('login_hint', loginHint);
  return u.toString();
}

function b64urlJSON(s: string): any {
  return JSON.parse(new TextDecoder().decode(fromB64url(s)));
}

async function verifyJwtSignature(jwt: string, jwksUri: string): Promise<boolean> {
  const [h, p, s] = jwt.split('.');
  const header = b64urlJSON(h);
  const r = await fetch(jwksUri, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('Could not load the provider signing keys');
  const { keys = [] } = (await r.json()) as { keys: any[] };
  const jwk = keys.find((k) => (!header.kid || k.kid === header.kid) && (!k.use || k.use === 'sig'));
  if (!jwk) throw new Error('No matching signing key for the ID token');
  const data = new TextEncoder().encode(`${h}.${p}`);
  const sig = fromB64url(s);
  if (header.alg === 'RS256') {
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
  }
  if (header.alg === 'ES256') {
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, data);
  }
  throw new Error(`Unsupported ID token algorithm ${header.alg}`);
}

export interface OidcIdentity { sub: string; email: string; emailVerified: boolean; name: string; data: Record<string, any> }

/**
 * Finish the flow: consume state, exchange the code (PKCE + client secret), verify the ID token
 * (signature via JWKS, iss, aud, exp, nonce) and return the identity. Throws with a readable message.
 */
export async function oidcFinish(env: Env, cfgFor: (data: Record<string, any>) => Promise<OidcConfig | null>, redirectUri: string, state: string, code: string): Promise<OidcIdentity> {
  const row = await consumeToken(env, 'oidc_state', state);
  if (!row) throw new Error('This sign-in link expired. Please try again.');
  const data = JSON.parse(row.data || '{}');
  const cfg = await cfgFor(data);
  if (!cfg) throw new Error('Single sign-on is not configured.');
  const d = await oidcDiscover(cfg.issuer);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: cfg.clientId, client_secret: cfg.clientSecret, code_verifier: data.verifier });
  const r = await fetch(d.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  const tok = (await r.json().catch(() => ({}))) as any;
  if (!r.ok || !tok.id_token) throw new Error(`The identity provider rejected the sign-in (${tok.error_description || tok.error || r.status}).`);
  const claims = b64urlJSON(String(tok.id_token).split('.')[1] || '');
  const iss = cfg.issuer.replace(/\/$/, '');
  const t = Math.floor(Date.now() / 1000);
  if (String(claims.iss || '').replace(/\/$/, '') !== iss) throw new Error('ID token issuer mismatch');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(cfg.clientId)) throw new Error('ID token audience mismatch');
  if (!claims.exp || claims.exp < t - 60) throw new Error('ID token expired');
  if (claims.nonce !== data.nonce) throw new Error('ID token nonce mismatch');
  // The token came straight from the token endpoint over TLS (OIDC Core 3.1.3.7 allows trusting that), but the
  // signature is still checked whenever the provider publishes keys.
  if (d.jwks_uri && !(await verifyJwtSignature(tok.id_token, d.jwks_uri))) throw new Error('ID token signature is invalid');
  let email = String(claims.email || '');
  let verified = claims.email_verified === true || claims.email_verified === 'true';
  let name = String(claims.name || '');
  if ((!email || !name) && d.userinfo_endpoint && tok.access_token) {
    const ui = (await (await fetch(d.userinfo_endpoint, { headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/json' } })).json().catch(() => ({}))) as any;
    if (ui.sub === claims.sub) {
      if (!email) { email = String(ui.email || ''); verified = ui.email_verified === true || ui.email_verified === 'true'; }
      name ||= String(ui.name || '');
    }
  }
  if (!claims.sub || !email) throw new Error('The identity provider did not share an email address.');
  return { sub: String(claims.sub), email: email.toLowerCase(), emailVerified: verified, name, data };
}

export interface WorkspaceSso { workspace_id: string; issuer: string; client_id: string; client_secret: string; domain: string; verify_token: string; domain_verified_at: number | null; enabled: number; enforce: number; default_role: string; tested_at: number | null }

/** Enterprise SSO that applies to an email address (enabled + domain verified), if any. */
export async function ssoForEmail(env: Env, email: string): Promise<(WorkspaceSso & { workspace_name: string }) | null> {
  const dom = (email.split('@')[1] || '').toLowerCase().trim();
  if (!dom) return null;
  return one(env, `SELECT s.*, w.name AS workspace_name FROM workspace_sso s JOIN workspaces w ON w.id = s.workspace_id WHERE s.domain = ? AND s.enabled = 1 AND s.domain_verified_at IS NOT NULL ORDER BY s.updated_at DESC LIMIT 1`, dom);
}

/** The SSO config when the email's domain requires SSO-only login (password, magic links and Google are refused). */
export async function ssoEnforcedFor(env: Env, email: string): Promise<(WorkspaceSso & { workspace_name: string }) | null> {
  const s = await ssoForEmail(env, email);
  return s && s.enforce ? s : null;
}

/** DNS proof of domain ownership: TXT `_lnkbase-sso.<domain>` = `lnkbase-sso=<token>` (via DNS over HTTPS). */
export async function ssoDomainVerified(domain: string, tok: string): Promise<boolean> {
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(`_lnkbase-sso.${domain}`)}&type=TXT`, { headers: { accept: 'application/dns-json' } });
    if (!r.ok) return false;
    const j: any = await r.json();
    return (j.Answer || []).some((a: any) => String(a.data || '').replace(/"\s*"/g, '').replace(/^"|"$/g, '').trim() === `lnkbase-sso=${tok}`);
  } catch {
    return false;
  }
}

/** Public mailbox providers can never be claimed for Enterprise SSO. */
export const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'mail.com', 'yandex.com', 'zoho.com', 'fastmail.com', 'hey.com', 'qq.com', '163.com']);
