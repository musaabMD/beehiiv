// Real-time collaborative editing Durable Object (one room per post).
// Protocol (JSON over WebSocket):
//   server → client: {t:'init', doc, title, subtitle, me, peers} · {t:'op', op, from} · {t:'meta', title?, subtitle?, from} · {t:'peers', peers}
//   client → server: {t:'op', op} · {t:'meta', title?, subtitle?} · {t:'presence', block}
//   op: {k:'upsert', block, index} | {k:'delete', id} | {k:'order', ids}
// Conflict model: block-level last-writer-wins with a per-block version counter. The room keeps the
// latest snapshot in storage and writes it back to D1 (posts.content) a few seconds after changes.
import type { Env } from '../types';

interface Block { id: string; type: string; data: any }
interface Peer { cid: string; uid: string; name: string; color: string; block: string | null }

const COLORS = ['#ef4444', '#3b82f6', '#10b981', '#8b5cf6', '#f97316', '#ec4899', '#14b8a6', '#eab308'];

export class CollabRoom implements DurableObject {
  private blocks: Block[] | null = null;
  private versions: Record<string, number> = {};
  private title = '';
  private subtitle = '';
  private postId = '';
  private dirty = false;

  constructor(private state: DurableObjectState, private env: Env) {}

  private async load() {
    if (this.blocks) return;
    const snap = await this.state.storage.get<any>('snap');
    if (snap) {
      Object.assign(this, { blocks: snap.blocks, versions: snap.versions || {}, title: snap.title, subtitle: snap.subtitle, postId: snap.postId });
      return;
    }
    await this.loadFromD1();
  }

  private async loadFromD1() {
    const pid = this.postId || (await this.state.storage.get<string>('postId')) || '';
    const row = pid ? await this.env.DB.prepare('SELECT content, title, subtitle FROM posts WHERE id = ?').bind(pid).first<any>() : null;
    let doc: any = { blocks: [] };
    try { doc = JSON.parse(row?.content || '{"blocks":[]}'); } catch {}
    this.blocks = Array.isArray(doc.blocks) ? doc.blocks : [];
    this.versions = {};
    this.title = row?.title || '';
    this.subtitle = row?.subtitle || '';
  }

  private peers(): Peer[] {
    return this.state.getWebSockets().map((ws) => ws.deserializeAttachment() as Peer).filter(Boolean);
  }

  private broadcast(msg: unknown, except?: WebSocket) {
    const s = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(s); } catch {}
    }
  }

  private async persist() {
    this.dirty = true;
    await this.state.storage.put('snap', { blocks: this.blocks, versions: this.versions, title: this.title, subtitle: this.subtitle, postId: this.postId });
    const alarm = await this.state.storage.getAlarm();
    if (!alarm) await this.state.storage.setAlarm(Date.now() + 3000);
  }

  private async flush() {
    if (!this.blocks || !this.postId) return;
    await this.env.DB.prepare('UPDATE posts SET content = ?, title = ?, subtitle = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify({ blocks: this.blocks }), this.title, this.subtitle, Date.now(), this.postId)
      .run();
    this.dirty = false;
  }

  async alarm() {
    await this.load();
    await this.flush();
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/reset' && req.method === 'POST') {
      // e.g. version restore: drop the cached snapshot and push the D1 copy to everyone
      await this.state.storage.delete('snap');
      this.blocks = null;
      await this.loadFromD1();
      this.broadcast({ t: 'init', doc: { blocks: this.blocks }, title: this.title, subtitle: this.subtitle, reset: true, peers: this.peers() });
      return new Response('ok');
    }
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const pid = url.searchParams.get('post') || '';
    if (pid && !this.postId) { this.postId = pid; await this.state.storage.put('postId', pid); }
    await this.load();
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const taken = new Set(this.peers().map((p) => p.color));
    const peer: Peer = {
      cid: crypto.randomUUID().slice(0, 8),
      uid: url.searchParams.get('uid') || 'anon',
      name: (url.searchParams.get('name') || 'Someone').slice(0, 60),
      color: COLORS.find((c) => !taken.has(c)) || COLORS[Math.floor(Math.random() * COLORS.length)],
      block: null,
    };
    this.state.acceptWebSocket(server);
    server.serializeAttachment(peer);
    server.send(JSON.stringify({ t: 'init', doc: { blocks: this.blocks }, title: this.title, subtitle: this.subtitle, me: peer, peers: this.peers() }));
    this.broadcast({ t: 'peers', peers: this.peers() }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    await this.load();
    let msg: any;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }
    const peer = ws.deserializeAttachment() as Peer;
    const blocks = this.blocks!;
    if (msg.t === 'presence') {
      peer.block = typeof msg.block === 'string' ? msg.block.slice(0, 64) : null;
      ws.serializeAttachment(peer);
      this.broadcast({ t: 'peers', peers: this.peers() });
      return;
    }
    if (msg.t === 'meta') {
      if (typeof msg.title === 'string') this.title = msg.title.slice(0, 300);
      if (typeof msg.subtitle === 'string') this.subtitle = msg.subtitle.slice(0, 500);
      this.broadcast({ t: 'meta', title: msg.title, subtitle: msg.subtitle, from: peer.cid }, ws);
      await this.persist();
      return;
    }
    if (msg.t !== 'op' || !msg.op) return;
    const op = msg.op;
    if (op.k === 'upsert' && op.block?.id && typeof op.block.type === 'string') {
      const json = JSON.stringify(op.block);
      if (json.length > 500_000) return;
      const i = blocks.findIndex((b) => b.id === op.block.id);
      if (i >= 0) blocks[i] = op.block;
      else blocks.splice(Math.max(0, Math.min(Number(op.index ?? blocks.length), blocks.length)), 0, op.block);
      this.versions[op.block.id] = (this.versions[op.block.id] || 0) + 1;
      op.v = this.versions[op.block.id];
    } else if (op.k === 'delete' && op.id) {
      const i = blocks.findIndex((b) => b.id === op.id);
      if (i >= 0) blocks.splice(i, 1);
      delete this.versions[op.id];
    } else if (op.k === 'order' && Array.isArray(op.ids)) {
      const byId = new Map(blocks.map((b) => [b.id, b]));
      const ordered = op.ids.map((x: string) => byId.get(x)).filter(Boolean) as Block[];
      for (const b of blocks) if (!op.ids.includes(b.id)) ordered.push(b);
      this.blocks = ordered;
    } else return;
    this.broadcast({ t: 'op', op, from: peer.cid }, ws);
    await this.persist();
  }

  async webSocketClose(ws: WebSocket) {
    try { ws.close(); } catch {}
    const left = this.state.getWebSockets().filter((w) => w !== ws);
    if (!left.length) {
      // last editor left: write back and drop the cache so the next session starts from D1
      if (this.dirty || (await this.state.storage.get('snap'))) { await this.load(); await this.flush(); }
      await this.state.storage.delete('snap');
      this.blocks = null;
    } else this.broadcast({ t: 'peers', peers: left.map((w) => w.deserializeAttachment() as Peer) });
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }
}
