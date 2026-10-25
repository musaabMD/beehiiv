// Discord integration: sync a member's Discord roles with their subscription tier.
// Config lives in publication settings.discord = { bot_token, guild_id, tier_roles: { <tier_id>|'premium'|'free': <role_id> } }.
import type { Env, Publication } from '../types';
import { one, all } from './db';
import { onEvent } from './events';
import { settings, getPub, appUrl } from './pub';
import { integration } from './integrations';
import { logError } from './jobs';

const API = 'https://discord.com/api/v10';

export interface DiscordCfg { bot_token?: string; guild_id?: string; tier_roles?: Record<string, string> }

export function discordCfg(pub: Publication): DiscordCfg | null {
  const d = settings(pub).discord as DiscordCfg | undefined;
  return d && d.bot_token && d.guild_id ? d : null;
}

async function call(cfg: DiscordCfg, method: 'PUT' | 'DELETE' | 'GET', path: string): Promise<Response> {
  return fetch(API + path, { method, headers: { authorization: `Bot ${cfg.bot_token}`, 'x-audit-log-reason': 'OpenHive tier sync' } });
}

/** Roles a subscriber should have, given the mapping. */
export function desiredRoles(cfg: DiscordCfg, sub: { tier: string; tier_id: string | null; status: string }): Set<string> {
  const want = new Set<string>();
  const map = cfg.tier_roles || {};
  if (sub.status !== 'active') return want;
  if (map.free) want.add(map.free);
  if (sub.tier === 'premium') {
    if (map.premium) want.add(map.premium);
    if (sub.tier_id && map[sub.tier_id]) want.add(map[sub.tier_id]);
  }
  return want;
}

/** Add/remove mapped roles for one subscriber. Returns a short result string. */
export async function syncDiscordRoles(env: Env, pub: Publication, subscriberId: string): Promise<string> {
  const cfg = discordCfg(pub);
  if (!cfg) return 'Discord is not configured';
  const m = await one<{ discord_user_id: string | null }>(env, 'SELECT discord_user_id FROM community_members WHERE pub_id = ? AND subscriber_id = ?', pub.id, subscriberId);
  if (!m?.discord_user_id) return 'No Discord account linked';
  const sub = await one<any>(env, 'SELECT tier, tier_id, status FROM subscribers WHERE id = ?', subscriberId);
  if (!sub) return 'Subscriber not found';
  const want = desiredRoles(cfg, sub);
  const all = new Set(Object.values(cfg.tier_roles || {}).filter(Boolean));
  const results: string[] = [];
  for (const role of all) {
    const add = want.has(role);
    try {
      const r = await call(cfg, add ? 'PUT' : 'DELETE', `/guilds/${cfg.guild_id}/members/${m.discord_user_id}/roles/${role}`);
      if (!r.ok && r.status !== 404) results.push(`${add ? 'add' : 'remove'} ${role}: HTTP ${r.status}`);
    } catch (e) {
      await logError(env, 'discord.sync', e, pub.id);
      results.push(`${role}: network error`);
    }
  }
  return results.length ? results.join('; ') : `Synced (${want.size} role${want.size === 1 ? '' : 's'})`;
}

export async function testDiscord(cfg: DiscordCfg): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await call(cfg, 'GET', `/guilds/${cfg.guild_id}`);
    if (!r.ok) return { ok: false, message: `Discord returned HTTP ${r.status}. Check the bot token, guild id, and that the bot is in the server.` };
    const g: any = await r.json();
    return { ok: true, message: `Connected to “${g.name}”.` };
  } catch (e: any) {
    return { ok: false, message: 'Could not reach Discord: ' + (e?.message || e) };
  }
}

// Tier changes → role sync
onEvent(async (env, e) => {
  if (!e.subscriberId || !['subscription.upgraded', 'subscription.downgraded', 'subscription.paused', 'subscription.resumed', 'subscription.deleted'].includes(e.type)) return;
  const pub = await getPub(env, e.pubId);
  if (!pub || !discordCfg(pub)) return;
  await syncDiscordRoles(env, pub, e.subscriberId);
});

export async function linkedMembers(env: Env, pubId: string) {
  return all<any>(env, `SELECT cm.*, s.email, s.tier FROM community_members cm JOIN subscribers s ON s.id = cm.subscriber_id WHERE cm.pub_id = ? AND cm.discord_user_id IS NOT NULL`, pubId);
}

// ───────── Discord OAuth2 (identify scope): members prove which Discord account is theirs ─────────
// Credentials come from (in order) the publication's community settings (settings.discord_oauth), an active
// "discord" integration row with client_id/client_secret, or the instance env DISCORD_CLIENT_ID/DISCORD_CLIENT_SECRET.
// Every publication uses the same redirect URI: <APP_URL>/oauth/discord/callback (register it in the Discord app).
export interface DiscordOAuth { client_id: string; client_secret: string; source: 'publication' | 'integration' | 'instance' }

export async function discordOAuthCfg(env: Env, pub: Publication): Promise<DiscordOAuth | null> {
  const s = settings(pub).discord_oauth as { client_id?: string; client_secret?: string } | undefined;
  if (s?.client_id && s.client_secret) return { client_id: s.client_id, client_secret: s.client_secret, source: 'publication' };
  const i = await integration(env, pub.id, 'discord').catch(() => null);
  if (i?.client_id && i?.client_secret) return { client_id: String(i.client_id), client_secret: String(i.client_secret), source: 'integration' };
  if (env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) return { client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, source: 'instance' };
  return null;
}

export const discordRedirectUri = (env: Env) => appUrl(env, '/oauth/discord/callback');
const oauthBase = (env: Env) => (env.DISCORD_API_BASE || 'https://discord.com/api').replace(/\/$/, '');

export function discordAuthorizeUrl(env: Env, cfg: DiscordOAuth, state: string): string {
  const q = new URLSearchParams({ client_id: cfg.client_id, response_type: 'code', scope: 'identify', redirect_uri: discordRedirectUri(env), state, prompt: 'consent' });
  return `https://discord.com/oauth2/authorize?${q}`;
}

/** Exchange an authorization code for the member's Discord identity (id + username). */
export async function discordIdentify(env: Env, cfg: DiscordOAuth, code: string): Promise<{ id: string; username: string }> {
  const tr = await fetch(`${oauthBase(env)}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: cfg.client_id, client_secret: cfg.client_secret, grant_type: 'authorization_code', code, redirect_uri: discordRedirectUri(env) }),
  });
  const tok: any = await tr.json().catch(() => ({}));
  if (!tr.ok || !tok.access_token) throw new Error(`Discord token exchange failed (${tok.error_description || tok.error || 'HTTP ' + tr.status})`);
  const ur = await fetch(`${oauthBase(env)}/users/@me`, { headers: { authorization: `${tok.token_type || 'Bearer'} ${tok.access_token}` } });
  const u: any = await ur.json().catch(() => ({}));
  if (!ur.ok || !/^\d{15,21}$/.test(String(u.id || ''))) throw new Error(`Discord did not return your account (HTTP ${ur.status})`);
  // Best effort: we only needed one call; revoke the token so nothing long-lived is kept.
  await fetch(`${oauthBase(env)}/oauth2/token/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tok.access_token, token_type_hint: 'access_token', client_id: cfg.client_id, client_secret: cfg.client_secret }) }).catch(() => {});
  return { id: String(u.id), username: String(u.global_name || u.username || u.id).slice(0, 80) };
}
