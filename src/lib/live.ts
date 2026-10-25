// LiveRoom Durable Object: one room per live event. Handles chat (persisted), presence/attendee count,
// host moderation (pin, mute, remove, delete), stream status, and WebRTC signaling relay (offer/answer/ICE)
// between the host and attendees. Uses the WebSocket Hibernation API so idle rooms cost nothing.
import type { Env } from '../types';

interface Att { peer: string; uid: string; name: string; role: 'host' | 'attendee'; eventId: string; joinedAt: number }
interface ChatMsg { id: string; peer: string; uid: string; name: string; role: string; text: string; at: number }

const MAX_HISTORY = 300;

export class LiveRoom implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}

  private sockets(): WebSocket[] {
    return this.state.getWebSockets();
  }
  private att(ws: WebSocket): Att | null {
    try { return ws.deserializeAttachment() as Att; } catch { return null; }
  }
  private send(ws: WebSocket, msg: unknown) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }
  private broadcast(msg: unknown, filter?: (a: Att) => boolean) {
    const data = JSON.stringify(msg);
    for (const ws of this.sockets()) {
      const a = this.att(ws);
      if (!a || (filter && !filter(a))) continue;
      try { ws.send(data); } catch {}
    }
  }
  private attendees(): Att[] {
    return this.sockets().map((w) => this.att(w)).filter((a): a is Att => !!a && a.role === 'attendee');
  }
  private count() {
    return this.attendees().length;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/info')) {
      return Response.json({ count: this.count(), status: (await this.state.storage.get<string>('status')) || 'scheduled' });
    }
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const role = req.headers.get('x-role') === 'host' ? 'host' : 'attendee';
    const uid = req.headers.get('x-uid') || crypto.randomUUID();
    const name = (req.headers.get('x-name') || 'Guest').slice(0, 60);
    const eventId = req.headers.get('x-event') || '';
    const banned = (await this.state.storage.get<string[]>('banned')) || [];
    if (role === 'attendee' && banned.includes(uid)) return new Response('Removed from this event', { status: 403 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const a: Att = { peer: crypto.randomUUID().slice(0, 12), uid, name, role, eventId, joinedAt: Date.now() };
    this.state.acceptWebSocket(server, [role]);
    server.serializeAttachment(a);
    const [chat, pin, status, muted] = await Promise.all([
      this.state.storage.get<ChatMsg[]>('chat'), this.state.storage.get<string>('pin'), this.state.storage.get<string>('status'), this.state.storage.get<string[]>('muted'),
    ]);
    this.send(server, {
      type: 'welcome', you: { peer: a.peer, role, name, uid }, chat: chat || [], pin: pin ? (chat || []).find((m) => m.id === pin) || null : null,
      status: status || 'scheduled', count: this.count(), muted: (muted || []).includes(uid),
      peers: role === 'host' ? this.attendees().map((x) => ({ peer: x.peer, name: x.name, uid: x.uid, muted: (muted || []).includes(x.uid) })) : undefined,
      hosts: this.sockets().map((w) => this.att(w)).filter((x) => x?.role === 'host').map((x) => x!.peer),
    });
    if (role === 'attendee') this.broadcast({ type: 'peer-joined', peer: a.peer, name, uid }, (x) => x.role === 'host');
    else this.broadcast({ type: 'host-joined', peer: a.peer }, (x) => x.role === 'attendee');
    this.broadcast({ type: 'count', count: this.count() });
    if (role === 'attendee' && status === 'live')
      this.env.DB.prepare('UPDATE event_registrations SET attended_at = COALESCE(attended_at, ?) WHERE id = ? AND event_id = ?').bind(Date.now(), uid, eventId).run().catch(() => {});
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const me = this.att(ws);
    if (!me) return;
    let msg: any;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }
    const isHost = me.role === 'host';
    switch (msg.type) {
      case 'ping':
        this.send(ws, { type: 'pong', t: msg.t });
        return;
      case 'chat': {
        const text = String(msg.text || '').trim().slice(0, 1000);
        if (!text) return;
        const muted = (await this.state.storage.get<string[]>('muted')) || [];
        if (!isHost && muted.includes(me.uid)) { this.send(ws, { type: 'error', message: 'You have been muted by the host.' }); return; }
        const last = (await this.state.storage.get<number>('rl:' + me.uid)) || 0;
        if (!isHost && Date.now() - last < 800) { this.send(ws, { type: 'error', message: 'Slow down a little.' }); return; }
        await this.state.storage.put('rl:' + me.uid, Date.now());
        const m: ChatMsg = { id: crypto.randomUUID().slice(0, 10), peer: me.peer, uid: me.uid, name: me.name, role: me.role, text, at: Date.now() };
        const chat = (await this.state.storage.get<ChatMsg[]>('chat')) || [];
        chat.push(m);
        await this.state.storage.put('chat', chat.slice(-MAX_HISTORY));
        this.broadcast({ type: 'chat', message: m });
        return;
      }
      case 'signal': {
        // Attendees may only signal hosts; hosts may signal anyone.
        const target = this.sockets().find((w) => this.att(w)?.peer === msg.to);
        const ta = target && this.att(target);
        if (!target || !ta) return;
        if (!isHost && ta.role !== 'host') return;
        this.send(target, { type: 'signal', from: me.peer, data: msg.data });
        return;
      }
      case 'peers':
        if (isHost) this.send(ws, { type: 'peers', peers: this.attendees().map((x) => ({ peer: x.peer, name: x.name, uid: x.uid })) });
        return;
      case 'reaction':
        this.broadcast({ type: 'reaction', emoji: String(msg.emoji || '👏').slice(0, 4), name: me.name });
        return;
    }
    if (!isHost) return;
    // ── host-only controls
    switch (msg.type) {
      case 'pin': {
        if (msg.id) await this.state.storage.put('pin', String(msg.id)); else await this.state.storage.delete('pin');
        const chat = (await this.state.storage.get<ChatMsg[]>('chat')) || [];
        this.broadcast({ type: 'pin', message: msg.id ? chat.find((m) => m.id === msg.id) || null : null });
        return;
      }
      case 'delete': {
        const chat = ((await this.state.storage.get<ChatMsg[]>('chat')) || []).filter((m) => m.id !== msg.id);
        await this.state.storage.put('chat', chat);
        this.broadcast({ type: 'deleted', id: msg.id });
        return;
      }
      case 'mute': {
        const muted = new Set((await this.state.storage.get<string[]>('muted')) || []);
        if (muted.has(msg.uid)) muted.delete(msg.uid); else muted.add(msg.uid);
        await this.state.storage.put('muted', [...muted]);
        const on = muted.has(msg.uid);
        for (const w of this.sockets()) if (this.att(w)?.uid === msg.uid) this.send(w, { type: 'muted', muted: on });
        this.broadcast({ type: 'mute-state', uid: msg.uid, muted: on }, (x) => x.role === 'host');
        return;
      }
      case 'remove': {
        const banned = new Set((await this.state.storage.get<string[]>('banned')) || []);
        banned.add(msg.uid);
        await this.state.storage.put('banned', [...banned]);
        for (const w of this.sockets()) {
          const a = this.att(w);
          if (a && a.uid === msg.uid && a.role === 'attendee') { this.send(w, { type: 'removed' }); try { w.close(4003, 'removed'); } catch {} }
        }
        return;
      }
      case 'stream': {
        const status = ['live', 'ended', 'scheduled'].includes(msg.status) ? msg.status : 'scheduled';
        await this.state.storage.put('status', status);
        try {
          await this.env.DB.prepare(`UPDATE live_events SET stream_status = ?, stream_started_at = CASE WHEN ? = 'live' THEN COALESCE(stream_started_at, ?) ELSE stream_started_at END WHERE id = ?`)
            .bind(status, status, Date.now(), me.eventId).run();
          if (status === 'live') await this.env.DB.prepare(`UPDATE event_registrations SET attended_at = COALESCE(attended_at, ?) WHERE event_id = ? AND id IN (${this.attendees().map(() => '?').join(',') || "''"})`).bind(Date.now(), me.eventId, ...this.attendees().map((a) => a.uid)).run();
        } catch (e) { console.error('live status update failed', e); }
        this.broadcast({ type: 'stream', status });
        return;
      }
      case 'clear-chat':
        await this.state.storage.put('chat', []);
        await this.state.storage.delete('pin');
        this.broadcast({ type: 'cleared' });
        return;
    }
  }

  async webSocketClose(ws: WebSocket) {
    this.left(ws);
  }
  async webSocketError(ws: WebSocket) {
    this.left(ws);
  }
  private left(ws: WebSocket) {
    const a = this.att(ws);
    try { ws.close(); } catch {}
    if (!a) return;
    // getWebSockets() may still include the closing socket briefly; compute count without it
    const remaining = this.sockets().filter((w) => w !== ws).map((w) => this.att(w)).filter((x) => x?.role === 'attendee').length;
    if (a.role === 'attendee') this.broadcast({ type: 'peer-left', peer: a.peer }, (x) => x.role === 'host' && x.peer !== a.peer);
    else this.broadcast({ type: 'host-left', peer: a.peer }, (x) => x.role === 'attendee');
    this.broadcast({ type: 'count', count: remaining }, (x) => x.peer !== a.peer);
    // mark attendance for attendees who were present while live
    if (a.role === 'attendee') {
      this.state.storage.get<string>('status').then((s) => {
        if (s === 'live') this.env.DB.prepare('UPDATE event_registrations SET attended_at = COALESCE(attended_at, ?) WHERE id = ? AND event_id = ?').bind(Date.now(), a.uid, a.eventId).run().catch(() => {});
      });
    }
  }
}
