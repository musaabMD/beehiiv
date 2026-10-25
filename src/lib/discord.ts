// Discord integration: sync a member's Discord roles with their subscription tier.
// Config lives in publication settings.discord = { bot_token, guild_id, tier_roles: { <tier_id>|'premium'|'free': <role_id> } }.
import type { Env, Publication } from '../types';
import { one, all } from './db';
import { onEvent } from './events';
import { settings, getPub } from './pub';
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
