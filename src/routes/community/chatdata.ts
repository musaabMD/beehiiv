// Group chat data helpers: room access, room lists with unread counts, ensuring a default room.
import type { Env, Subscriber } from '../../types';
import { one, all, val, insert } from '../../lib/db';
import { id, now, parseJSON } from '../../lib/util';

export interface ChatRoomRow {
  id: string; pub_id: string; name: string; slug: string; description: string; kind: 'public' | 'group'; access: string; tier_ids: string;
  is_default: number; slow_mode_sec: number; position: number; archived: number; created_by_subscriber_id: string | null; created_by_user_id: string | null;
  last_message_at: number | null; created_at: number;
}

export const MAX_GROUP_MEMBERS = 50;

/** Public room access mirrors channel access (free / any paid / specific tiers); group chats require membership. */
export async function roomAccess(env: Env, room: ChatRoomRow, key: string, sub: Subscriber | null, premium: boolean, team: boolean): Promise<{ ok: boolean; reason?: 'subscribe' | 'upgrade' | 'invite' }> {
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
     WHERE r.pub_id = ? AND r.archived = 0 AND (r.kind = 'public' OR crm.joined = 1)
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
     JOIN chat_rooms r ON r.id = m.room_id AND r.archived = 0
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
