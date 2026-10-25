// Group chat data helpers: room access, room lists with unread counts, ensuring a default room.
import type { Env, Subscriber } from '../../types';
import { one, all, val, insert } from '../../lib/db';
import { id, now, parseJSON } from '../../lib/util';

export interface ChatRoomRow {
  id: string; pub_id: string; name: string; slug: string; description: string; kind: 'public' | 'group' | 'dm'; access: string; tier_ids: string;
  is_default: number; slow_mode_sec: number; position: number; archived: number; created_by_subscriber_id: string | null; created_by_user_id: string | null;
  last_message_at: number | null; created_at: number;
}

export const MAX_GROUP_MEMBERS = 50;

/** Public room access mirrors channel access (free / any paid / specific tiers); group chats require membership. */
export async function roomAccess(env: Env, room: ChatRoomRow, key: string, sub: Subscriber | null, premium: boolean, team: boolean): Promise<{ ok: boolean; reason?: 'subscribe' | 'upgrade' | 'invite' }> {
  if (room.kind === 'dm') {
    // 1:1 member DMs are private to the two participants (team members included — moderation works through reports).
    if (!sub || sub.status !== 'active') return { ok: false, reason: 'subscribe' };
    const m = await one(env, 'SELECT 1 FROM chat_room_members WHERE room_id = ? AND member_key = ? AND joined = 1', room.id, key);
    return m ? { ok: true } : { ok: false, reason: 'invite' };
  }
  if (team) return { ok: true };
  if (!sub || sub.status !== 'active') return { ok: false, reason: 'subscribe' };
  if (room.kind === 'group') {
    const m = await one(env, 'SELECT 1 FROM chat_room_members WHERE room_id = ? AND member_key = ? AND joined = 1', room.id, key);
    return m ? { ok: true } : { ok: false, reason: 'invite' };
  }
  if (room.access === 'free') return { ok: true };
  if (!premium) return { ok: false, reason: 'upgrade' };
  if (room.access === 'tiers') {
    const tiers = parseJSON<string[]>(room.tier_ids, []);
    if (tiers.length && !tiers.includes(sub.tier_id || '')) return { ok: false, reason: 'upgrade' };
  }
  return { ok: true };
}

export async function ensureDefaultRoom(env: Env, pubId: string) {
  const n = await val<number>(env, `SELECT COUNT(*) FROM chat_rooms WHERE pub_id = ? AND kind = 'public'`, pubId);
  if (!n) await insert(env, 'chat_rooms', { id: id(), pub_id: pubId, name: 'Lounge', slug: 'lounge', description: 'Hang out and chat with the community in real time.', kind: 'public', access: 'free', tier_ids: '[]', is_default: 1, slow_mode_sec: 0, position: 0, archived: 0, created_at: now() });
}

/** Rooms visible to a member key (public rooms + group chats they belong to) with unread counts. */
export async function roomsFor(env: Env, pubId: string, key: string) {
  return all<ChatRoomRow & { unread: number; joined: number | null; last_read_at: number | null }>(
    env,
    `SELECT r.*, crm.joined, crm.last_read_at,
       (SELECT COUNT(*) FROM chat_messages m WHERE m.room_id = r.id AND m.status = 'visible' AND m.created_at > COALESCE(crm.last_read_at, 0)
          AND COALESCE('u:' || m.author_user_id, 's:' || m.author_subscriber_id) != ?) AS unread
     FROM chat_rooms r LEFT JOIN chat_room_members crm ON crm.room_id = r.id AND crm.member_key = ?
     WHERE r.pub_id = ? AND r.archived = 0 AND r.kind != 'dm' AND (r.kind = 'public' OR crm.joined = 1)
     ORDER BY r.kind = 'group', r.position, COALESCE(r.last_message_at, r.created_at) DESC`,
    key, key, pubId,
  );
}

export async function chatUnreadTotal(env: Env, pubId: string, subscriberId: string): Promise<number> {
  const key = 's:' + subscriberId;
  // Only count rooms the member has opened before (read row exists) to avoid "everything is unread" on first visit.
  const r = await one<{ n: number }>(
    env,
    `SELECT COUNT(*) AS n FROM chat_messages m JOIN chat_room_members crm ON crm.room_id = m.room_id AND crm.member_key = ?
     JOIN chat_rooms r ON r.id = m.room_id AND r.archived = 0 AND r.kind != 'dm'
     WHERE m.pub_id = ? AND m.status = 'visible' AND m.created_at > crm.last_read_at AND COALESCE('u:' || m.author_user_id, 's:' || m.author_subscriber_id) != ?`,
    key, pubId, key,
  );
  return r?.n || 0;
}

export async function roomMembers(env: Env, roomId: string) {
  return all<{ member_key: string; role: string; name: string; email: string | null }>(
    env,
    `SELECT crm.member_key, crm.role,
       COALESCE(cm.display_name, s.name, u.name, s.email, u.email, 'Member') AS name, COALESCE(s.email, u.email) AS email
     FROM chat_room_members crm
     LEFT JOIN subscribers s ON crm.member_key = 's:' || s.id
     LEFT JOIN community_members cm ON cm.subscriber_id = s.id AND cm.pub_id = crm.pub_id
     LEFT JOIN users u ON crm.member_key = 'u:' || u.id
     WHERE crm.room_id = ? AND crm.joined = 1 ORDER BY crm.role = 'owner' DESC, name`,
    roomId,
  );
}

// ───────── 1:1 member DMs (chat_rooms.kind = 'dm', exactly two joined members) ─────────
export const dmSlug = (a: string, b: string) => 'dm-' + [a, b].sort().join('-');

export async function isBlocked(env: Env, pubId: string, a: string, b: string): Promise<'by_me' | 'by_them' | null> {
  const rows = await all<{ blocker_id: string }>(env, 'SELECT blocker_id FROM community_blocks WHERE pub_id = ? AND ((blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?))', pubId, a, b, b, a);
  if (rows.some((r) => r.blocker_id === a)) return 'by_me';
  return rows.length ? 'by_them' : null;
}

/** Can `from` send a DM to `to`? Returns a reason when not. Checked on start, on every send (in the DO) and on page load. */
export async function dmBlockedReason(env: Env, pubId: string, from: string, to: string): Promise<string | null> {
  if (from === to) return "You can't message yourself.";
  const [a, b] = await Promise.all([
    one<any>(env, `SELECT cm.status, cm.chat_banned, cm.dms_enabled, s.status AS sub_status FROM community_members cm JOIN subscribers s ON s.id = cm.subscriber_id WHERE cm.pub_id = ? AND cm.subscriber_id = ?`, pubId, from),
    one<any>(env, `SELECT cm.status, cm.chat_banned, cm.dms_enabled, s.status AS sub_status FROM community_members cm JOIN subscribers s ON s.id = cm.subscriber_id WHERE cm.pub_id = ? AND cm.subscriber_id = ?`, pubId, to),
  ]);
  if (!a || a.status !== 'active' || a.sub_status !== 'active' || a.chat_banned) return 'You can no longer send messages in this community.';
  if (!a.dms_enabled) return 'You turned off direct messages. Turn them back on in your inbox settings to send messages.';
  if (!b || b.status !== 'active' || b.sub_status !== 'active' || b.chat_banned) return "This member can't receive messages.";
  const blocked = await isBlocked(env, pubId, from, to);
  if (blocked === 'by_me') return 'You blocked this member. Unblock them to send a message.';
  if (blocked === 'by_them' || !b.dms_enabled) return "This member isn't accepting direct messages.";
  return null;
}

export async function dmUnreadTotal(env: Env, pubId: string, subscriberId: string): Promise<number> {
  const key = 's:' + subscriberId;
  const r = await one<{ n: number }>(
    env,
    `SELECT COUNT(*) AS n FROM chat_messages m JOIN chat_room_members crm ON crm.room_id = m.room_id AND crm.member_key = ? AND crm.joined = 1
     JOIN chat_rooms r ON r.id = m.room_id AND r.kind = 'dm'
     WHERE m.pub_id = ? AND m.status = 'visible' AND m.created_at > crm.last_read_at AND COALESCE(m.author_subscriber_id, '') != ?
       AND NOT EXISTS (SELECT 1 FROM community_blocks b WHERE b.pub_id = m.pub_id AND b.blocker_id = ? AND b.blocked_id = m.author_subscriber_id)`,
    key, pubId, subscriberId, subscriberId,
  );
  return r?.n || 0;
}

/** Upcoming, published events synced with Luma (imported from or pushed to the publication's Luma calendar). */
export async function upcomingLumaEvents(env: Env, pubId: string, limit = 3) {
  return all<{ id: string; slug: string; title: string; starts_at: number; ends_at: number; timezone: string; location: string | null; kind: string; luma_event_id: string }>(
    env,
    `SELECT id, slug, title, starts_at, ends_at, timezone, location, kind, luma_event_id FROM live_events
     WHERE pub_id = ? AND luma_event_id IS NOT NULL AND status = 'published' AND ends_at >= ? ORDER BY starts_at LIMIT ?`,
    pubId, now(), limit,
  );
}
