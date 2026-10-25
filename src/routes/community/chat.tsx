/** @jsxImportSource hono/jsx */
// Community group chats: publication rooms + member-created group chats (site), room management (dashboard),
// WebSocket upgrade with server-side identity, and member image uploads. Real-time logic lives in src/lib/chatroom.ts.
import { raw } from 'hono/html';
import type { App, Ctx, Publication } from '../../types';
import { one, all, run, insert } from '../../lib/db';
import { currentUser, userPubs, can, requirePerm, audit } from '../../lib/auth';
import { rateLimit } from '../../lib/guard';
import { storeFile } from '../../lib/media';
import { siteUrl } from '../../lib/pub';
import { trackView } from '../../lib/tracking';
import { SiteMessage } from '../../ui/site';
import { DashLayout } from '../../ui/layout';
import { Card, Table, Btn, Field, Input, Textarea, Select, Modal, OpenBtn, ActionForm, Empty, back, Help, Tabs, Toggle, Badge, Status } from '../../ui/components';
import { id, now, form, str, int, bool, slugify, ago, num, esc } from '../../lib/util';
import { canModerate, notify, teamCommunityRole } from './shared';
import { ctxInfo, Shell, Gate, requireWriter } from './site';
import { roomAccess, roomsFor, roomMembers, ensureDefaultRoom, MAX_GROUP_MEMBERS, type ChatRoomRow } from './chatdata';
import { chatStub, chatRoomChanged, chatKick } from '../../lib/chatroom';
import { registerDmSite } from './dm';

const EMOJIS = ['👍', '❤️', '😂', '🎉', '🔥', '👀'];

export function ChatUI(p: { cfg: Record<string, unknown>; room: ChatRoomRow; members?: Array<{ member_key: string; name: string; role: string }>; canAddMembers?: boolean; addAction?: string; leaveAction?: string; dash?: boolean }) {
  return (
    <div class={`cc ${p.dash ? 'cc-dash' : ''}`} id="cc">
      <div class="cc-main">
        <header class="cc-head">
          <div>
            <strong class="cc-title">{p.room.kind === 'public' ? '#' : ''}{p.room.name}</strong>
            <span class="cc-desc">{p.room.description}</span>
          </div>
          <div class="cc-head-r">
            {p.room.slow_mode_sec > 0 && <span class="cc-chip" title="Slow mode">🐢 {p.room.slow_mode_sec}s</span>}
            <span class="cc-chip"><i class="cc-dot" /> <span data-online-count>0</span> online</span>
          </div>
        </header>
        <div class="cc-log" id="cc-log" aria-live="polite"><div class="cc-empty">Loading…</div></div>
        <div class="cc-typing" id="cc-typing" />
        <form class="cc-compose" id="cc-compose" autocomplete="off">
          <div class="cc-replying hide" id="cc-replying" />
          <div class="cc-row">
            <label class="cc-attach" title="Attach image"><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden id="cc-file" />📎</label>
            <textarea id="cc-input" rows={1} maxlength={2000} placeholder="Message… (Enter to send, Shift+Enter for a new line, @ to mention)" />
            <button class="cc-send" type="submit">Send</button>
          </div>
          <div class="cc-status" id="cc-status" />
        </form>
      </div>
      <aside class="cc-side">
        <h4>Online</h4>
        <ul class="cc-online" id="cc-online" />
        {p.members && (
          <>
            <h4>Members ({p.members.length})</h4>
            <ul class="cc-members">{p.members.map((m) => <li>{m.name}{m.role === 'owner' ? <small> · owner</small> : null}</li>)}</ul>
            {p.canAddMembers && p.addAction && (
              <form method="post" action={p.addAction} class="cc-add">
                <input name="people" placeholder="Add by email or display name" required />
                <button>Add</button>
              </form>
            )}
            {p.leaveAction && <form method="post" action={p.leaveAction}><button class="cc-leave" data-confirm="Leave this group chat?">Leave group</button></form>}
          </>
        )}
      </aside>
      <script type="application/json" id="cc-config">{raw(JSON.stringify({ ...p.cfg, emojis: EMOJIS }).replace(/</g, '\\u003c'))}</script>
    </div>
  );
}

/** Resolve the people a member typed (emails or display names) to active community members. */
async function resolvePeople(c: Ctx, pubId: string, text: string) {
  const tokens = text.split(/[,\n]+/).map((t) => t.trim()).filter(Boolean).slice(0, MAX_GROUP_MEMBERS);
  const found: Array<{ id: string; email: string; name: string }> = [];
  const missing: string[] = [];
  for (const t of tokens) {
    const handle = t.replace(/^@/, '').toLowerCase();
    const r = await one<any>(c.env,
      `SELECT s.id, s.email, COALESCE(cm.display_name, s.name, s.email) AS name FROM community_members cm JOIN subscribers s ON s.id = cm.subscriber_id
       WHERE cm.pub_id = ? AND cm.status = 'active' AND (lower(s.email) = ? OR lower(COALESCE(cm.display_name, '')) = ? OR lower(replace(COALESCE(cm.display_name, s.name, ''), ' ', '')) = ?) LIMIT 1`,
      pubId, handle, handle, handle.replace(/\s+/g, ''));
    if (r && !found.some((f) => f.id === r.id)) found.push(r); else if (!r) missing.push(t);
  }
  return { found, missing };
}

async function teamIdentity(c: Ctx, pub: Publication) {
  const u = await currentUser(c);
  if (!u) return null;
  const p = (await userPubs(c.env, u.id)).find((x) => x.id === pub.id);
  return p && can(p.role, 'draft') ? { user: u, role: p.role } : null;
}

async function findRoom(c: Ctx, pubId: string, key: string) {
  return one<ChatRoomRow>(c.env, 'SELECT * FROM chat_rooms WHERE pub_id = ? AND (slug = ? OR id = ?)', pubId, key, key);
}

const chatCss = <link rel="stylesheet" href="/static/community-chat.css" />;

export function registerChatSite(site: App) {
  // Member DMs, profiles and the events panel first: their paths must win over /community/:channel catch-alls.
  registerDmSite(site);
  // ── Room list + create group chat
  site.get('/community/chat', async (c) => {
    const info = await ctxInfo(c);
    const err = requireWriter(info);
    if (err) return Shell(c, 'Chats', 'chat', <><h1>Chats</h1><p class="s-muted">{err}</p><Gate base={info.base} pubName={info.pub.name} /></>);
    await ensureDefaultRoom(c.env, info.pub.id);
    await trackView(c, 'community-chat');
    const key = 's:' + info.sub!.id;
    const rooms = await roomsFor(c.env, info.pub.id, key);
    const shown: any[] = [];
    for (const r of rooms) {
      const acc = await roomAccess(c.env, r, key, info.sub, info.premium, false);
      shown.push({ ...r, locked: !acc.ok, unreadShown: r.last_read_at == null ? 0 : r.unread });
    }
    const pub = shown.filter((r) => r.kind === 'public');
    const groups = shown.filter((r) => r.kind === 'group');
    const RoomLink = ({ r }: { r: any }) => (
      <a class="c-post cc-roomlink" href={`${info.base}/community/chat/${r.slug}`}>
        <h3>{r.kind === 'group' ? '👥 ' : '#'}{r.name} {r.locked && <span class="s-badge">🔒 Paid</span>} {r.unreadShown > 0 && <span class="s-badge cc-unread" data-room-unread={r.id}>{r.unreadShown > 99 ? '99+' : r.unreadShown} new</span>}</h3>
        <p>{r.description || (r.kind === 'group' ? 'Group chat' : '')}</p>
        <div class="c-meta">{r.last_message_at ? `Last message ${ago(r.last_message_at)}` : 'No messages yet'}</div>
      </a>
    );
    return Shell(c, 'Chats', 'chat', (
      <>
        <h1>Chats</h1>
        <p class="s-muted">Real-time conversations with the community and the team.</p>
        <h2 style="margin-top:20px">Rooms</h2>
        {pub.map((r) => <RoomLink r={r} />)}
        <h2 style="margin-top:28px">Your group chats</h2>
        {groups.length ? groups.map((r) => <RoomLink r={r} />) : <p class="s-muted">No group chats yet.</p>}
        <form method="post" action={`${info.base}/community/chat/new`} class="s-box s-stack" style="margin-top:16px">
          <strong>Start a group chat</strong>
          <input class="s-input" name="name" placeholder="Group name" required maxlength={60} style="width:100%" />
          <textarea class="s-input" name="people" placeholder={`Invite members — emails or display names, separated by commas (up to ${MAX_GROUP_MEMBERS - 1})`} style="width:100%;min-height:70px;padding:10px 14px" />
          <button class="s-btn">Create group</button>
        </form>
      </>
    ));
  });

  site.post('/community/chat/new', async (c) => {
    const info = await ctxInfo(c);
    const err = requireWriter(info);
    if (err) return SiteMessage(c, 'Not allowed', <p>{err}</p>, 403);
    if (info.member?.chat_banned) return SiteMessage(c, 'Not allowed', <p>You can't use community chat.</p>, 403);
    if (!(await rateLimit(c.env, `chatgroup:${info.sub!.id}`, 10, 86400))) return SiteMessage(c, 'Slow down', <p>You've created a lot of group chats today. Try again tomorrow.</p>, 429);
    const f = await form(c.req);
    const name = str(f.name, 60);
    if (!name) return back(c, `${info.base}/community/chat`, 'Give your group a name.', 'err');
    const { found, missing } = await resolvePeople(c, info.pub.id, str(f.people, 4000));
    const rid = id();
    const slug = `g-${slugify(name, 40)}-${id(5)}`;
    await insert(c.env, 'chat_rooms', { id: rid, pub_id: info.pub.id, name, slug, description: '', kind: 'group', access: 'free', tier_ids: '[]', is_default: 0, slow_mode_sec: 0, position: 0, archived: 0, created_by_subscriber_id: info.sub!.id, created_at: now() });
    const t = now();
    await insert(c.env, 'chat_room_members', { room_id: rid, member_key: 's:' + info.sub!.id, pub_id: info.pub.id, role: 'owner', joined: 1, last_read_at: t, created_at: t });
    const others = found.filter((p) => p.id !== info.sub!.id).slice(0, MAX_GROUP_MEMBERS - 1);
    for (const p of others) {
      await insert(c.env, 'chat_room_members', { room_id: rid, member_key: 's:' + p.id, pub_id: info.pub.id, role: 'member', joined: 1, last_read_at: 0, created_at: t });
      if (await rateLimit(c.env, `chatinvite:${p.id}`, 10, 3600))
        await notify(c.env, info.pub, p.email, `${info.member?.display_name || info.sub!.name || 'A member'} added you to "${name}"`, `<p>You were added to the group chat <strong>${esc(name)}</strong> in the ${esc(info.pub.name)} community.</p>`, `${info.base}/community/chat/${slug}`);
    }
    return back(c, `${info.base}/community/chat/${slug}`, missing.length ? `Group created. Couldn't find: ${missing.slice(0, 5).join(', ')}` : 'Group created', missing.length ? 'err' : 'ok');
  });

  // ── Member image upload (images only, 5 MB, rate limited); team members may use it too.
  site.post('/community/chat/upload', async (c) => {
    const pub = c.get('pub');
    const info = await ctxInfo(c);
    const team = info.member?.status === 'active' ? null : await teamIdentity(c, pub);
    const writer = !requireWriter(info) && !info.member?.chat_banned;
    if (!writer && !team) return c.json({ error: 'forbidden' }, 403);
    const who = team ? 'u:' + team.user.id : 's:' + info.sub!.id;
    if (!(await rateLimit(c.env, `chatupload:${who}`, 30, 3600))) return c.json({ error: 'Too many uploads — try again later.' }, 429);
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) return c.json({ error: 'No file' }, 400);
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return c.json({ error: 'Only PNG, JPEG, GIF or WebP images.' }, 400);
    if (file.size > 5 * 1024 * 1024) return c.json({ error: 'Images must be 5 MB or smaller.' }, 400);
    const stored = await storeFile(c.env, pub.id, file, { folder: 'chat', userId: team?.user.id, source: 'upload' });
    return c.json({ url: stored.url });
  });

  // ── WebSocket: identity is decided here (reader session or dashboard session), never by the client.
  site.get('/community/chat/:room/ws', async (c) => {
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return c.text('Expected WebSocket', 426);
    const pub = c.get('pub');
    const room = await findRoom(c, pub.id, c.req.param('room'));
    if (!room || room.archived) return c.text('Not found', 404);
    const headers = new Headers(c.req.raw.headers);
    headers.set('x-room', room.id);
    headers.set('x-pub', pub.id);
    if (c.req.query('as') === 'team') {
      if (room.kind === 'dm') return c.text('Forbidden', 403); // member DMs are private; moderation works through reports
      const team = await teamIdentity(c, pub);
      if (!team) return c.text('Forbidden', 403);
      headers.set('x-key', 'u:' + team.user.id);
      headers.set('x-user', team.user.id);
      headers.set('x-name', team.user.name || team.user.email.split('@')[0]);
      headers.set('x-mod', canModerate(teamCommunityRole(team.role)) ? '1' : '0');
    } else {
      const info = await ctxInfo(c);
      if (requireWriter(info) || info.member?.chat_banned) return c.text('Forbidden', 403);
      const key = 's:' + info.sub!.id;
      const acc = await roomAccess(c.env, room, key, info.sub, info.premium, false);
      if (!acc.ok) return c.text('Forbidden', 403);
      headers.set('x-key', key);
      headers.set('x-sub', info.sub!.id);
      headers.set('x-name', info.member?.display_name || info.sub!.name || info.sub!.email.split('@')[0]);
      headers.set('x-mod', canModerate(info.member?.role) ? '1' : '0');
    }
    return chatStub(c.env, room.id).fetch(new Request(c.req.url, { headers }));
  });

  site.get('/community/chat/:room', async (c) => {
    const info = await ctxInfo(c);
    const err = requireWriter(info);
    if (err) return Shell(c, 'Chat', 'chat', <><h1>Chat</h1><p class="s-muted">{err}</p><Gate base={info.base} pubName={info.pub.name} /></>);
    const room = await findRoom(c, info.pub.id, c.req.param('room'));
    if (!room || room.archived) return SiteMessage(c, 'Chat not found', <p>This chat doesn't exist or was archived. <a href={`${info.base}/community/chat`}>Back to chats</a></p>, 404);
    if (room.kind === 'dm') return c.redirect(`${info.base}/community/dm/${room.slug}`);
    if (info.member?.chat_banned) return Shell(c, room.name, 'chat', <div class="s-box">You no longer have access to community chat.</div>);
    const key = 's:' + info.sub!.id;
    const acc = await roomAccess(c.env, room, key, info.sub, info.premium, false);
    if (!acc.ok) return Shell(c, room.name, 'chat', acc.reason === 'invite' ? <div class="s-box">This is a private group chat. Ask a member to add you.</div> : <Gate reason={acc.reason} base={info.base} pubName={info.pub.name} />);
    const members = room.kind === 'group' ? await roomMembers(c.env, room.id) : undefined;
    const isOwner = room.kind === 'group' && room.created_by_subscriber_id === info.sub!.id;
    const cfg = {
      ws: `${new URL(c.req.url).pathname}/ws`, upload: `${new URL(c.req.url).pathname.replace(/\/[^/]+$/, '')}/upload`,
      me: { key, name: info.member?.display_name || info.sub!.name || info.sub!.email.split('@')[0], mod: canModerate(info.member?.role) }, roomId: room.id,
      mentionables: (members || []).map((m) => m.name).slice(0, 60),
    };
    return Shell(c, room.name, 'chat', (
      <>
        {chatCss}
        <p class="s-small"><a href={`${info.base}/community/chat`}>← All chats</a></p>
        <ChatUI cfg={cfg} room={room} members={members} canAddMembers={isOwner} addAction={`${info.base}/community/chat/${room.slug}/members`} leaveAction={room.kind === 'group' ? `${info.base}/community/chat/${room.slug}/leave` : undefined} />
        <script src="/static/community-chat.js" defer></script>
      </>
    ));
  });

  site.post('/community/chat/:room/members', async (c) => {
    const info = await ctxInfo(c);
    if (requireWriter(info)) return SiteMessage(c, 'Not allowed', <p>Log in first.</p>, 403);
    const room = await findRoom(c, info.pub.id, c.req.param('room'));
    if (!room || room.kind !== 'group' || room.created_by_subscriber_id !== info.sub!.id) return SiteMessage(c, 'Not allowed', <p>Only the group owner can add people.</p>, 403);
    const existing = (await roomMembers(c.env, room.id)).length;
    const { found, missing } = await resolvePeople(c, info.pub.id, str((await form(c.req)).people, 4000));
    let added = 0;
    for (const p of found) {
      if (existing + added >= MAX_GROUP_MEMBERS) break;
      const r = await run(c.env, `INSERT INTO chat_room_members (room_id, member_key, pub_id, role, joined, last_read_at, created_at) VALUES (?, ?, ?, 'member', 1, 0, ?) ON CONFLICT(room_id, member_key) DO UPDATE SET joined = 1`, room.id, 's:' + p.id, info.pub.id, now());
      if (r.meta.changes) {
        added++;
        if (await rateLimit(c.env, `chatinvite:${p.id}`, 10, 3600)) await notify(c.env, info.pub, p.email, `You were added to "${room.name}"`, `<p>You were added to the group chat <strong>${esc(room.name)}</strong>.</p>`, `${info.base}/community/chat/${room.slug}`);
      }
    }
    return back(c, `${info.base}/community/chat/${room.slug}`, missing.length ? `Added ${added}. Couldn't find: ${missing.slice(0, 5).join(', ')}` : `Added ${added} ${added === 1 ? 'person' : 'people'}`, missing.length ? 'err' : 'ok');
  });

  site.post('/community/chat/:room/leave', async (c) => {
    const info = await ctxInfo(c);
    if (requireWriter(info)) return SiteMessage(c, 'Not allowed', <p>Log in first.</p>, 403);
    const room = await findRoom(c, info.pub.id, c.req.param('room'));
    if (!room || room.kind !== 'group') return c.notFound();
    const key = 's:' + info.sub!.id;
    await run(c.env, 'UPDATE chat_room_members SET joined = 0 WHERE room_id = ? AND member_key = ?', room.id, key);
    await chatKick(c.env, room.id, key, 'You left this group.');
    return back(c, `${info.base}/community/chat`, 'You left the group');
  });
}

// ───────── Dashboard: Chats tab ─────────
const TABS: Array<[string, string]> = [['/app/community', 'Overview'], ['/app/community/channels', 'Channels'], ['/app/community/chats', 'Chats'], ['/app/community/members', 'Members'], ['/app/community/moderation', 'Moderation'], ['/app/community/messages', 'Messages'], ['/app/community/settings', 'Settings']];

function RoomForm({ r, tiers }: { r?: ChatRoomRow; tiers: Array<{ id: string; name: string }> }) {
  return (
    <>
      <Field label="Name"><Input name="name" value={r?.name} required maxlength={60} /></Field>
      <Field label="Description"><Input name="description" value={r?.description} maxlength={200} /></Field>
      <Field label="Who can join">
        <Select name="access" value={r?.access || 'free'} options={[['free', 'All community members'], ['premium', 'Paid subscribers (any tier)'], ['tiers', 'Specific paid tiers']]} />
      </Field>
      {tiers.length > 0 && <Field label="Tiers (when “Specific paid tiers”)"><Select name="tier_ids[]" multiple values={JSON.parse(r?.tier_ids || '[]')} options={tiers.map((t) => [t.id, t.name] as [string, string])} /></Field>}
      <Field label="Slow mode (seconds between messages per member, 0 = off)"><Input name="slow_mode_sec" type="number" min={0} max={3600} value={r?.slow_mode_sec ?? 0} /></Field>
      <Toggle name="is_default" checked={!!r?.is_default} label="Default room" hint="Shown first in the member's chat list." />
    </>
  );
}

export function registerChatDash(dash: App) {
  dash.get('/chats', async (c) => {
    const pub = c.get('pub');
    await ensureDefaultRoom(c.env, pub.id);
    const rooms = await all<any>(c.env,
      `SELECT r.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.room_id = r.id AND m.status = 'visible') AS messages,
         (SELECT COUNT(*) FROM chat_messages m WHERE m.room_id = r.id AND m.created_at > ?) AS week,
         (SELECT COUNT(*) FROM chat_room_members x WHERE x.room_id = r.id AND x.joined = 1) AS members
       FROM chat_rooms r WHERE r.pub_id = ? ORDER BY r.archived, r.kind, r.position, r.created_at`, now() - 7 * 86400_000, pub.id);
    const tiers = await all<any>(c.env, 'SELECT id, name FROM tiers WHERE pub_id = ? ORDER BY position', pub.id);
    const publicRooms = rooms.filter((r) => r.kind === 'public');
    const groups = rooms.filter((r) => r.kind === 'group');
    return c.html(
      <DashLayout c={c} title="Community chats" section="community" actions={<OpenBtn target="#new-room">New room</OpenBtn>}>
        <Tabs items={TABS} active="/app/community/chats" />
        <Card title="Rooms" pad={false}>
          <Table rows={publicRooms} empty="No rooms yet."
            cols={[
              { h: 'Room', r: (r) => <><a href={`/app/community/chats/${r.id}`}>#{r.name}</a> {r.is_default ? <Badge tone="blue">default</Badge> : null} {r.archived ? <Badge>archived</Badge> : null}<div class="muted small">{r.description}</div></> },
              { h: 'Access', r: (r) => r.access === 'free' ? 'All members' : r.access === 'premium' ? 'Paid' : 'Specific tiers' },
              { h: 'Slow mode', r: (r) => (r.slow_mode_sec ? `${r.slow_mode_sec}s` : 'Off') },
              { h: 'Messages', r: (r) => <>{num(r.messages)} <span class="muted small">({num(r.week)} this week)</span></> },
              { h: '', r: (r) => <div class="row end"><a class="btn btn-secondary btn-sm" href={`/app/community/chats/${r.id}`}>Open</a><a class="btn btn-ghost btn-sm" href={`/app/community/chats/${r.id}/edit`}>Edit</a></div> },
            ]} />
        </Card>
        <Card title="Member group chats" pad={false}>
          <Table rows={groups} empty="Members haven't created group chats yet."
            cols={[
              { h: 'Group', r: (r) => <a href={`/app/community/chats/${r.id}`}>👥 {r.name}</a> },
              { h: 'Members', r: (r) => r.members },
              { h: 'Messages', r: (r) => num(r.messages) },
              { h: 'Last activity', r: (r) => ago(r.last_message_at || r.created_at) },
              { h: '', r: (r) => r.archived ? <Badge>archived</Badge> : <ActionForm action={`/app/community/chats/${r.id}/archive`} label="Archive" confirm="Archive this group chat? Members will no longer be able to post." /> },
            ]} />
        </Card>
        <Help>Team members join any room from here. Moderators (and team members acting as moderators) can delete messages, mute or ban members right inside the chat. Reported chat messages appear in the Moderation tab.</Help>
        <Modal id="new-room" title="New chat room">
          <form method="post" action="/app/community/chats"><RoomForm tiers={tiers} /><div class="form-actions"><Btn>Create room</Btn></div></form>
        </Modal>
      </DashLayout>,
    );
  });

  async function saveRoom(c: Ctx, existing?: ChatRoomRow) {
    const pub = c.get('pub');
    const f = await form(c.req);
    const name = str(f.name, 60);
    if (!name) return null;
    const access = ['free', 'premium', 'tiers'].includes(f.access) ? f.access : 'free';
    const fields = { name, description: str(f.description, 200), access, tier_ids: JSON.stringify(access === 'tiers' ? (f.tier_ids || []).slice(0, 20) : []), slow_mode_sec: Math.min(Math.max(int(f.slow_mode_sec, 0), 0), 3600), is_default: bool(f.is_default) ? 1 : 0 };
    if (fields.is_default) await run(c.env, `UPDATE chat_rooms SET is_default = 0 WHERE pub_id = ? AND kind = 'public'`, pub.id);
    if (existing) {
      await run(c.env, 'UPDATE chat_rooms SET name = ?, description = ?, access = ?, tier_ids = ?, slow_mode_sec = ?, is_default = ? WHERE id = ? AND pub_id = ?', fields.name, fields.description, fields.access, fields.tier_ids, fields.slow_mode_sec, fields.is_default, existing.id, pub.id);
      const r = (await one<ChatRoomRow>(c.env, 'SELECT * FROM chat_rooms WHERE id = ?', existing.id))!;
      await chatRoomChanged(c.env, r).catch(() => {});
      return r;
    }
    let slug = slugify(name, 40);
    if (await one(c.env, 'SELECT 1 FROM chat_rooms WHERE pub_id = ? AND slug = ?', pub.id, slug)) slug += '-' + id(4);
    const rid = id();
    const pos = (await one<{ n: number }>(c.env, `SELECT COALESCE(MAX(position), 0) + 1 AS n FROM chat_rooms WHERE pub_id = ?`, pub.id))?.n || 0;
    await insert(c.env, 'chat_rooms', { id: rid, pub_id: pub.id, slug, kind: 'public', position: pos, archived: 0, created_by_user_id: c.get('user').id, created_at: now(), ...fields });
    return one<ChatRoomRow>(c.env, 'SELECT * FROM chat_rooms WHERE id = ?', rid);
  }

  dash.post('/chats', requirePerm('manage'), async (c) => {
    const r = await saveRoom(c);
    if (!r) return back(c, '/app/community/chats', 'Give the room a name.', 'err');
    await audit(c, 'community.chat_room.created', r.id, { name: r.name });
    return back(c, '/app/community/chats', `Room #${r.name} created`);
  });

  dash.get('/chats/:id/edit', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const r = await one<ChatRoomRow>(c.env, 'SELECT * FROM chat_rooms WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!r) return c.notFound();
    const tiers = await all<any>(c.env, 'SELECT id, name FROM tiers WHERE pub_id = ? ORDER BY position', pub.id);
    return c.html(
      <DashLayout c={c} title={`Edit #${r.name}`} section="community" crumbs={[['/app/community/chats', 'Chats']]}>
        <Card>
          <form method="post" action={`/app/community/chats/${r.id}/edit`}><RoomForm r={r} tiers={tiers} /><div class="form-actions"><Btn>Save</Btn></div></form>
        </Card>
        <Card title="Danger zone">
          <div class="row">
            <ActionForm action={`/app/community/chats/${r.id}/archive`} label={r.archived ? 'Unarchive' : 'Archive'} />
            <ActionForm action={`/app/community/chats/${r.id}/delete`} label="Delete room and messages" kind="danger" confirm="Delete this room and all its messages permanently?" />
          </div>
        </Card>
      </DashLayout>,
    );
  });

  dash.post('/chats/:id/edit', requirePerm('manage'), async (c) => {
    const r = await one<ChatRoomRow>(c.env, 'SELECT * FROM chat_rooms WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
    if (!r) return c.notFound();
    await saveRoom(c, r);
    return back(c, '/app/community/chats', 'Room saved');
  });

  dash.post('/chats/:id/archive', requirePerm('manage'), async (c) => {
    const r = await one<ChatRoomRow>(c.env, 'SELECT * FROM chat_rooms WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
    if (!r) return c.notFound();
    await run(c.env, 'UPDATE chat_rooms SET archived = ? WHERE id = ?', r.archived ? 0 : 1, r.id);
    return back(c, '/app/community/chats', r.archived ? 'Room unarchived' : 'Room archived');
  });

  dash.post('/chats/:id/delete', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    await run(c.env, 'DELETE FROM chat_messages WHERE room_id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    await run(c.env, 'DELETE FROM chat_room_members WHERE room_id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    await run(c.env, 'DELETE FROM chat_rooms WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    await audit(c, 'community.chat_room.deleted', c.req.param('id'));
    return back(c, '/app/community/chats', 'Room deleted');
  });

  // Team joins a room in the dashboard (same real-time UI, identity = dashboard user).
  dash.get('/chats/:id', async (c) => {
    const pub = c.get('pub');
    const room = await one<ChatRoomRow>(c.env, 'SELECT * FROM chat_rooms WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!room || room.kind === 'dm') return c.notFound();
    const user = c.get('user');
    const members = room.kind === 'group' ? await roomMembers(c.env, room.id) : undefined;
    const base = `/s/${pub.slug}/community/chat`;
    const cfg = { ws: `${base}/${room.slug}/ws?as=team`, upload: `${base}/upload`, me: { key: 'u:' + user.id, name: user.name || user.email.split('@')[0], mod: canModerate(teamCommunityRole(c.get('role'))) }, roomId: room.id, mentionables: (members || []).map((m) => m.name) };
    return c.html(
      <DashLayout c={c} title={`${room.kind === 'group' ? '👥 ' : '#'}${room.name}`} section="community" crumbs={[['/app/community/chats', 'Chats']]} styles={['/static/community-chat.css']} scripts={['/static/community-chat.js']} wide
        actions={<><a class="btn btn-secondary" href={`${siteUrl(c.env, pub)}/community/chat/${room.slug}`} target="_blank">Member view</a>{room.kind === 'public' && <a class="btn btn-ghost" href={`/app/community/chats/${room.id}/edit`}>Settings</a>}</>}>
        {room.archived ? <div class="callout warn">This room is archived — members can read but not post.</div> : null}
        <ChatUI cfg={cfg} room={room} members={members} dash />
      </DashLayout>,
    );
  });
}
