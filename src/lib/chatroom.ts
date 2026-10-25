// ChatRoom Durable Object: one instance per community chat room. Real-time fan-out (WebSocket Hibernation API),
// presence, typing, reactions, edits/deletes, replies, slow mode, mutes/bans, reports and @mention emails.
// D1 (chat_messages) is the source of truth for history and moderation; the DO keeps a recent-message cache.
// Identity arrives in headers from the authenticated route in src/routes/community/chat.tsx — never from the client.
import type { Env, Publication } from '../types';
import { one, all, run, insert } from './db';
import { rateLimit } from './guard';
import { siteUrl } from './pub';
import { id, now, esc, truncate } from './util';
import { notify } from '../routes/community/shared';

interface Att { key: string; name: string; mod: boolean; sub: string | null; user: string | null; room: string; pub: string; conn: string }
export interface ChatMsg {
  id: string; room_id: string; author_key: string; author_name: string; body: string; image_url: string | null; reply_to: string | null;
  reply?: { id: string; author_name: string; body: string } | null; reactions: Record<string, string[]>; status: string; edited_at: number | null; created_at: number; team?: boolean;
}

const CACHE = 150;
const MAX_LEN = 2000;
const EMOJI = /^[\p{Extended_Pictographic}‍️\u{1F3FB}-\u{1F3FF}]{1,8}$/u;

function rowToMsg(r: any): ChatMsg {
  let reactions: Record<string, string[]> = {};
  try { reactions = JSON.parse(r.reactions || '{}'); } catch {}
  return {
    id: r.id, room_id: r.room_id, author_key: r.author_user_id ? 'u:' + r.author_user_id : 's:' + r.author_subscriber_id, author_name: r.author_name,
    body: r.status === 'visible' ? r.body : '', image_url: r.status === 'visible' ? r.image_url : null, reply_to: r.reply_to, reactions,
    status: r.status, edited_at: r.edited_at, created_at: r.created_at, team: !!r.author_user_id,
  };
}

export class ChatRoom implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}

  private sockets() { return this.state.getWebSockets(); }
  private att(ws: WebSocket): Att | null { try { return ws.deserializeAttachment() as Att; } catch { return null; } }
  private send(ws: WebSocket, msg: unknown) { try { ws.send(JSON.stringify(msg)); } catch {} }
  private broadcast(msg: unknown, except?: WebSocket) {
    const data = JSON.stringify(msg);
    for (const ws of this.sockets()) if (ws !== except) try { ws.send(data); } catch {}
  }
  private online(exclude?: WebSocket) {
    const seen = new Map<string, { key: string; name: string; mod: boolean }>();
    for (const ws of this.sockets()) {
      if (ws === exclude) continue;
      const a = this.att(ws);
      if (a && !seen.has(a.key)) seen.set(a.key, { key: a.key, name: a.name, mod: a.mod });
    }
    return [...seen.values()];
  }

  private async recent(roomId: string): Promise<ChatMsg[]> {
    let cache = await this.state.storage.get<ChatMsg[]>('recent');
    if (!cache) {
      const rows = await all<any>(this.env, `SELECT * FROM (SELECT * FROM chat_messages WHERE room_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at`, roomId, CACHE);
      cache = rows.map(rowToMsg);
      const byId = new Map(cache.map((m) => [m.id, m]));
      for (const m of cache) if (m.reply_to) { const p = byId.get(m.reply_to); m.reply = p ? { id: p.id, author_name: p.author_name, body: truncate(p.body, 120) } : null; }
      await this.state.storage.put('recent', cache);
    }
    return cache;
  }
  private async patchCache(msgId: string, fn: (m: ChatMsg) => void) {
    const cache = await this.state.storage.get<ChatMsg[]>('recent');
    if (!cache) return;
    const m = cache.find((x) => x.id === msgId);
    if (m) { fn(m); await this.state.storage.put('recent', cache); }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Internal calls from authenticated routes (moderation queue, room settings).
    if (url.pathname === '/internal/removed') {
      const { messageId, status } = await req.json<{ messageId: string; status: string }>();
      await this.patchCache(messageId, (m) => { m.status = status; m.body = ''; m.image_url = null; });
      this.broadcast({ type: 'deleted', id: messageId, status });
      return Response.json({ ok: true });
    }
    if (url.pathname === '/internal/kick') {
      const { key, reason } = await req.json<{ key: string; reason: string }>();
      for (const ws of this.sockets()) if (this.att(ws)?.key === key) { this.send(ws, { type: 'banned', reason }); try { ws.close(4003, 'banned'); } catch {} }
      return Response.json({ ok: true });
    }
    if (url.pathname === '/internal/room') {
      const room = await req.json<any>();
      this.broadcast({ type: 'room', room });
      return Response.json({ ok: true });
    }
    if (url.pathname === '/internal/presence') return Response.json({ online: this.online() });
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 426 });

    const a: Att = {
      key: req.headers.get('x-key') || '', name: (req.headers.get('x-name') || 'Member').slice(0, 60), mod: req.headers.get('x-mod') === '1',
      sub: req.headers.get('x-sub') || null, user: req.headers.get('x-user') || null, room: req.headers.get('x-room') || '', pub: req.headers.get('x-pub') || '', conn: id(8),
    };
    if (!a.key || !a.room) return new Response('Bad request', { status: 400 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const wasOnline = this.online().some((o) => o.key === a.key);
    this.state.acceptWebSocket(server, [a.key]);
    server.serializeAttachment(a);
    const [history, member, room] = await Promise.all([
      this.recent(a.room),
      a.sub ? one<any>(this.env, 'SELECT chat_muted_until FROM community_members WHERE pub_id = ? AND subscriber_id = ?', a.pub, a.sub) : null,
      one<any>(this.env, 'SELECT id, name, description, slow_mode_sec, kind FROM chat_rooms WHERE id = ?', a.room),
    ]);
    this.send(server, { type: 'welcome', you: { key: a.key, name: a.name, mod: a.mod }, history: history.slice(-100), online: this.online(), room, muted_until: member?.chat_muted_until && member.chat_muted_until > now() ? member.chat_muted_until : null });
    if (!wasOnline) this.broadcast({ type: 'presence', online: this.online() }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const me = this.att(ws);
    if (!me) return;
    let msg: any;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }
    switch (msg.type) {
      case 'ping': return this.send(ws, { type: 'pong' });
      case 'typing': return this.broadcast({ type: 'typing', key: me.key, name: me.name }, ws);
      case 'read': {
        await run(this.env, `INSERT INTO chat_room_members (room_id, member_key, pub_id, role, joined, last_read_at, created_at) VALUES (?, ?, ?, 'member', 0, ?, ?) ON CONFLICT(room_id, member_key) DO UPDATE SET last_read_at = MAX(last_read_at, excluded.last_read_at)`, me.room, me.key, me.pub, now(), now());
        return;
      }
      case 'send': return this.onSend(ws, me, msg);
      case 'edit': return this.onEdit(ws, me, msg);
      case 'delete': return this.onDelete(ws, me, msg);
      case 'react': return this.onReact(ws, me, msg);
      case 'report': return this.onReport(ws, me, msg);
      case 'mute': case 'unmute': case 'ban': return this.onModerate(ws, me, msg);
    }
  }

  /** Re-check membership standing on every write (bans/mutes take effect immediately). */
  private async standing(me: Att): Promise<string | null> {
    if (!me.sub) return null; // team member
    const m = await one<any>(this.env, 'SELECT status, chat_banned, chat_muted_until FROM community_members WHERE pub_id = ? AND subscriber_id = ?', me.pub, me.sub);
    if (!m || m.status !== 'active' || m.chat_banned) return 'banned';
    if (m.chat_muted_until && m.chat_muted_until > now()) return 'muted';
    return null;
  }

  private async onSend(ws: WebSocket, me: Att, msg: any) {
    const body = String(msg.text || '').replace(/\r/g, '').trim().slice(0, MAX_LEN);
    const image = typeof msg.image_url === 'string' && /^(https?:\/\/[^\s"'<>]+\/media\/[^\s"'<>]+|\/media\/[^\s"'<>]+)$/.test(msg.image_url) ? msg.image_url : null;
    if (!body && !image) return;
    const standing = await this.standing(me);
    if (standing === 'banned') { this.send(ws, { type: 'banned', reason: 'You can no longer post in this community.' }); try { ws.close(4003, 'banned'); } catch {} return; }
    if (standing === 'muted') return this.send(ws, { type: 'error', code: 'muted', message: 'A moderator has muted you for now.', client_id: msg.client_id });
    const room = await one<any>(this.env, 'SELECT * FROM chat_rooms WHERE id = ?', me.room);
    if (!room || room.archived) return this.send(ws, { type: 'error', message: 'This chat is archived.', client_id: msg.client_id });
    if (!me.mod && room.slow_mode_sec > 0) {
      const last = (await this.state.storage.get<number>('rl:' + me.key)) || 0;
      const wait = Math.ceil((last + room.slow_mode_sec * 1000 - now()) / 1000);
      if (wait > 0) return this.send(ws, { type: 'error', code: 'slow', message: `Slow mode is on — wait ${wait}s.`, wait, client_id: msg.client_id });
    }
    // basic flood protection for everyone
    const burst = (await this.state.storage.get<number[]>('burst:' + me.key)) || [];
    const recentSends = burst.filter((t) => now() - t < 10_000);
    if (!me.mod && recentSends.length >= 8) return this.send(ws, { type: 'error', code: 'flood', message: 'You are sending messages too quickly.', client_id: msg.client_id });
    await this.state.storage.put('burst:' + me.key, [...recentSends, now()]);
    await this.state.storage.put('rl:' + me.key, now());

    const cache = await this.recent(me.room);
    let reply: ChatMsg['reply'] = null;
    let replyTo: string | null = null;
    if (msg.reply_to) {
      const p = cache.find((m) => m.id === msg.reply_to) || (await one<any>(this.env, 'SELECT * FROM chat_messages WHERE id = ? AND room_id = ?', String(msg.reply_to), me.room).then((r) => (r ? rowToMsg(r) : null)));
      if (p) { replyTo = p.id; reply = { id: p.id, author_name: p.author_name, body: truncate(p.body, 120) }; }
    }
    const m: ChatMsg = { id: id(14), room_id: me.room, author_key: me.key, author_name: me.name, body, image_url: image, reply_to: replyTo, reply, reactions: {}, status: 'visible', edited_at: null, created_at: now(), team: !!me.user };
    await insert(this.env, 'chat_messages', { id: m.id, room_id: m.room_id, pub_id: me.pub, author_subscriber_id: me.sub, author_user_id: me.user, author_name: m.author_name, body: m.body, image_url: m.image_url, reply_to: m.reply_to, reactions: '{}', status: 'visible', created_at: m.created_at });
    await run(this.env, 'UPDATE chat_rooms SET last_message_at = ? WHERE id = ?', m.created_at, me.room);
    await run(this.env, `INSERT INTO chat_room_members (room_id, member_key, pub_id, role, joined, last_read_at, created_at) VALUES (?, ?, ?, 'member', 0, ?, ?) ON CONFLICT(room_id, member_key) DO UPDATE SET last_read_at = excluded.last_read_at`, me.room, me.key, me.pub, m.created_at, now());
    cache.push(m);
    await this.state.storage.put('recent', cache.slice(-CACHE));
    this.broadcast({ type: 'message', message: m, client_id: msg.client_id });
    if (body.includes('@')) this.state.waitUntil(this.mentions(me, room, m).catch((e) => console.error('chat mentions', e)));
  }

  /** @mention emails (only to people not currently in the room; at most one per recipient per room per 10 min). */
  private async mentions(me: Att, room: any, m: ChatMsg) {
    const handles = [...new Set([...m.body.matchAll(/(^|\s)@([\p{L}\p{N}_.-]{2,40})/gu)].map((x) => x[2].toLowerCase()))].slice(0, 5);
    if (!handles.length) return;
    const pub = await one<Publication>(this.env, 'SELECT * FROM publications WHERE id = ?', me.pub);
    if (!pub) return;
    const onlineKeys = new Set(this.online().map((o) => o.key));
    for (const h of handles) {
      const target = await one<any>(this.env,
        `SELECT s.id, s.email, COALESCE(cm.display_name, s.name, '') AS name FROM community_members cm JOIN subscribers s ON s.id = cm.subscriber_id
         WHERE cm.pub_id = ? AND cm.status = 'active' AND (lower(replace(COALESCE(cm.display_name, s.name, ''), ' ', '')) = ? OR lower(substr(s.email, 1, instr(s.email, '@') - 1)) = ?) LIMIT 1`,
        me.pub, h, h);
      if (!target || 's:' + target.id === me.key || onlineKeys.has('s:' + target.id)) continue;
      if (room.kind === 'group' && !(await one(this.env, `SELECT 1 FROM chat_room_members WHERE room_id = ? AND member_key = ? AND joined = 1`, room.id, 's:' + target.id))) continue;
      if (!(await rateLimit(this.env, `chatmention:${room.id}:${target.id}`, 1, 600))) continue;
      const link = `${siteUrl(this.env, pub)}/community/chat/${room.slug}`;
      await notify(this.env, pub, target.email, `${me.name} mentioned you in #${room.name}`, `<p><strong>${esc(me.name)}</strong> mentioned you in <strong>#${esc(room.name)}</strong>:</p><blockquote style="border-left:3px solid #e5e7eb;margin:8px 0;padding:4px 12px;color:#374151">${esc(truncate(m.body, 400))}</blockquote>`, link);
    }
  }

  private async own(me: Att, messageId: string): Promise<any | null> {
    const r = await one<any>(this.env, 'SELECT * FROM chat_messages WHERE id = ? AND room_id = ?', String(messageId || ''), me.room);
    return r;
  }

  private async onEdit(ws: WebSocket, me: Att, msg: any) {
    const r = await this.own(me, msg.id);
    const body = String(msg.text || '').trim().slice(0, MAX_LEN);
    if (!r || r.status !== 'visible' || !body) return;
    const mine = (r.author_user_id && 'u:' + r.author_user_id === me.key) || (r.author_subscriber_id && 's:' + r.author_subscriber_id === me.key);
    if (!mine) return this.send(ws, { type: 'error', message: 'You can only edit your own messages.' });
    if ((await this.standing(me)) === 'banned') return;
    const t = now();
    await run(this.env, 'UPDATE chat_messages SET body = ?, edited_at = ? WHERE id = ?', body, t, r.id);
    await this.patchCache(r.id, (m) => { m.body = body; m.edited_at = t; });
    this.broadcast({ type: 'edited', id: r.id, body, edited_at: t });
  }

  private async onDelete(ws: WebSocket, me: Att, msg: any) {
    const r = await this.own(me, msg.id);
    if (!r || r.status !== 'visible') return;
    const mine = (r.author_user_id && 'u:' + r.author_user_id === me.key) || (r.author_subscriber_id && 's:' + r.author_subscriber_id === me.key);
    if (!mine && !me.mod) return this.send(ws, { type: 'error', message: 'Only moderators can delete other people’s messages.' });
    const status = mine ? 'deleted' : 'removed';
    await run(this.env, 'UPDATE chat_messages SET status = ? WHERE id = ?', status, r.id);
    if (!mine) await run(this.env, `UPDATE community_reports SET status = 'actioned' WHERE pub_id = ? AND target_kind = 'chat' AND target_id = ? AND status = 'open'`, me.pub, r.id);
    await this.patchCache(r.id, (m) => { m.status = status; m.body = ''; m.image_url = null; });
    this.broadcast({ type: 'deleted', id: r.id, status });
  }

  private async onReact(ws: WebSocket, me: Att, msg: any) {
    const emoji = String(msg.emoji || '');
    if (!EMOJI.test(emoji)) return;
    if ((await this.standing(me)) === 'banned') return;
    const r = await this.own(me, msg.id);
    if (!r || r.status !== 'visible') return;
    let reactions: Record<string, string[]> = {};
    try { reactions = JSON.parse(r.reactions || '{}'); } catch {}
    const list = new Set(reactions[emoji] || []);
    if (list.has(me.key)) list.delete(me.key); else list.add(me.key);
    if (list.size) reactions[emoji] = [...list]; else delete reactions[emoji];
    if (Object.keys(reactions).length > 20) return;
    await run(this.env, 'UPDATE chat_messages SET reactions = ? WHERE id = ?', JSON.stringify(reactions), r.id);
    await this.patchCache(r.id, (m) => { m.reactions = reactions; });
    this.broadcast({ type: 'reactions', id: r.id, reactions });
  }

  private async onReport(ws: WebSocket, me: Att, msg: any) {
    const r = await this.own(me, msg.id);
    if (!r || !me.sub) return;
    if (!(await rateLimit(this.env, `chatreport:${me.key}`, 20, 3600))) return this.send(ws, { type: 'error', message: 'Too many reports. Try again later.' });
    const dup = await one(this.env, `SELECT 1 FROM community_reports WHERE pub_id = ? AND target_kind = 'chat' AND target_id = ? AND reporter_subscriber_id = ?`, me.pub, r.id, me.sub);
    if (!dup) await insert(this.env, 'community_reports', { id: id(), pub_id: me.pub, target_kind: 'chat', target_id: r.id, reporter_subscriber_id: me.sub, reason: String(msg.reason || '').slice(0, 300), status: 'open', created_at: now() });
    this.send(ws, { type: 'notice', message: 'Thanks — the moderators will take a look.' });
  }

  private async onModerate(ws: WebSocket, me: Att, msg: any) {
    if (!me.mod) return this.send(ws, { type: 'error', message: 'Moderators only.' });
    const key = String(msg.key || '');
    if (!key.startsWith('s:')) return this.send(ws, { type: 'error', message: 'Team members can’t be muted or banned.' });
    const subId = key.slice(2);
    if (msg.type === 'ban') {
      await run(this.env, 'UPDATE community_members SET chat_banned = 1 WHERE pub_id = ? AND subscriber_id = ?', me.pub, subId);
      for (const w of this.sockets()) if (this.att(w)?.key === key) { this.send(w, { type: 'banned', reason: 'A moderator removed you from community chat.' }); try { w.close(4003, 'banned'); } catch {} }
      this.broadcast({ type: 'presence', online: this.online() });
      return this.send(ws, { type: 'notice', message: 'Member banned from chat.' });
    }
    const until = msg.type === 'unmute' ? null : now() + Math.min(Math.max(Number(msg.minutes) || 10, 1), 7 * 24 * 60) * 60_000;
    await run(this.env, 'UPDATE community_members SET chat_muted_until = ? WHERE pub_id = ? AND subscriber_id = ?', until, me.pub, subId);
    for (const w of this.sockets()) if (this.att(w)?.key === key) this.send(w, { type: 'muted', until });
    this.send(ws, { type: 'notice', message: until ? 'Member muted.' : 'Member unmuted.' });
  }

  async webSocketClose(ws: WebSocket) { this.left(ws); }
  async webSocketError(ws: WebSocket) { this.left(ws); }
  private left(ws: WebSocket) {
    const a = this.att(ws);
    try { ws.close(); } catch {}
    if (!a) return;
    if (!this.online(ws).some((o) => o.key === a.key)) this.broadcast({ type: 'presence', online: this.online(ws) }, ws);
  }
}

/** Helpers for routes (moderation queue etc.). */
export function chatStub(env: Env, roomId: string) {
  return env.CHAT.get(env.CHAT.idFromName(roomId));
}
export async function chatRemoved(env: Env, roomId: string, messageId: string, status: string) {
  await chatStub(env, roomId).fetch('https://chat/internal/removed', { method: 'POST', body: JSON.stringify({ messageId, status }) });
}
export async function chatKick(env: Env, roomId: string, key: string, reason: string) {
  await chatStub(env, roomId).fetch('https://chat/internal/kick', { method: 'POST', body: JSON.stringify({ key, reason }) });
}
export async function chatRoomChanged(env: Env, room: any) {
  await chatStub(env, room.id).fetch('https://chat/internal/room', { method: 'POST', body: JSON.stringify({ id: room.id, name: room.name, description: room.description, slow_mode_sec: room.slow_mode_sec, kind: room.kind }) });
}
