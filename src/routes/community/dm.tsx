/** @jsxImportSource hono/jsx */
// Community: 1:1 member-to-member DMs (real-time through the ChatRoom Durable Object, rooms of kind 'dm'),
// member profiles, blocking, DM opt-out, and the upcoming-events (Luma) panel.
import type { App, Ctx } from '../../types';
import { one, all, run } from '../../lib/db';
import { rateLimit } from '../../lib/guard';
import { trackView } from '../../lib/tracking';
import { SiteMessage } from '../../ui/site';
import { back } from '../../ui/components';
import { id, now, form, str, ago, truncate, fmtDate } from '../../lib/util';
import { authorNames } from './shared';
import { ctxInfo, Shell, Gate, requireWriter } from './site';
import { dmSlug, dmBlockedReason, isBlocked, upcomingLumaEvents, type ChatRoomRow } from './chatdata';
import { ChatUI } from './chat';
import { chatKick } from '../../lib/chatroom';

/** Find (or create) the DM room between two members. */
async function ensureDm(c: Ctx, pubId: string, a: string, b: string): Promise<ChatRoomRow> {
  const slug = dmSlug(a, b);
  let room = await one<ChatRoomRow>(c.env, 'SELECT * FROM chat_rooms WHERE pub_id = ? AND slug = ?', pubId, slug);
  if (!room) {
    const rid = id();
    await run(c.env, `INSERT OR IGNORE INTO chat_rooms (id, pub_id, name, slug, description, kind, access, tier_ids, is_default, slow_mode_sec, position, archived, created_by_subscriber_id, created_at)
      VALUES (?, ?, 'Direct message', ?, '', 'dm', 'free', '[]', 0, 0, 0, 0, ?, ?)`, rid, pubId, slug, a, now());
    room = (await one<ChatRoomRow>(c.env, 'SELECT * FROM chat_rooms WHERE pub_id = ? AND slug = ?', pubId, slug))!;
  }
  const t = now();
  for (const [sid, read] of [[a, t], [b, 0]] as Array<[string, number]>)
    await run(c.env, `INSERT INTO chat_room_members (room_id, member_key, pub_id, role, joined, last_read_at, created_at) VALUES (?, ?, ?, 'member', 1, ?, ?) ON CONFLICT(room_id, member_key) DO UPDATE SET joined = 1`, room.id, 's:' + sid, pubId, read, t);
  return room;
}

async function memberCard(c: Ctx, pubId: string, sid: string) {
  return one<any>(c.env, `SELECT cm.subscriber_id, cm.role, cm.status, cm.joined_at, cm.dms_enabled, cm.chat_banned, COALESCE(cm.display_name, s.name, substr(s.email, 1, instr(s.email, '@') - 1)) AS name
    FROM community_members cm JOIN subscribers s ON s.id = cm.subscriber_id WHERE cm.pub_id = ? AND cm.subscriber_id = ?`, pubId, sid);
}

export function registerDmSite(site: App) {
  // ── Inbox
  site.get('/community/dm', async (c) => {
    const info = await ctxInfo(c);
    const err = requireWriter(info);
    if (err) return Shell(c, 'Direct messages', 'dm', <><h1>Direct messages</h1><p class="s-muted">{err}</p><Gate base={info.base} pubName={info.pub.name} /></>);
    await trackView(c, 'community-dm');
    const me = info.sub!.id, key = 's:' + me;
    const convos = await all<any>(c.env,
      `SELECT r.id, r.slug, r.created_at, r.last_message_at, r.created_by_subscriber_id, o.member_key AS other_key,
         (SELECT COUNT(*) FROM chat_messages m WHERE m.room_id = r.id AND m.status = 'visible' AND m.created_at > mine.last_read_at AND COALESCE(m.author_subscriber_id, '') != ?) AS unread,
         (SELECT CASE WHEN m.status = 'visible' THEN COALESCE(NULLIF(m.body, ''), '📷 Image') ELSE 'Message removed' END FROM chat_messages m WHERE m.room_id = r.id ORDER BY m.created_at DESC LIMIT 1) AS last_body
       FROM chat_rooms r
       JOIN chat_room_members mine ON mine.room_id = r.id AND mine.member_key = ? AND mine.joined = 1
       JOIN chat_room_members o ON o.room_id = r.id AND o.member_key != ?
       WHERE r.pub_id = ? AND r.kind = 'dm' AND (r.last_message_at IS NOT NULL OR r.created_by_subscriber_id = ?)
       ORDER BY COALESCE(r.last_message_at, r.created_at) DESC LIMIT 200`,
      me, key, key, info.pub.id, me);
    const nameOf = await authorNames(c.env, convos.map((r) => ({ author_subscriber_id: String(r.other_key).slice(2) })), info.pub.id);
    const blocked = await all<any>(c.env, `SELECT b.blocked_id, COALESCE(cm.display_name, s.name, s.email) AS name FROM community_blocks b JOIN subscribers s ON s.id = b.blocked_id LEFT JOIN community_members cm ON cm.subscriber_id = b.blocked_id AND cm.pub_id = b.pub_id WHERE b.pub_id = ? AND b.blocker_id = ? ORDER BY b.created_at DESC`, info.pub.id, me);
    const blockedIds = new Set(blocked.map((b) => b.blocked_id));
    return Shell(c, 'Direct messages', 'dm', (
      <>
        <h1>Direct messages</h1>
        <p class="s-muted">Private 1:1 conversations with other members. Start one from a member's profile — click any name in a discussion.</p>
        <div style="margin:18px 0" data-dm-inbox>
          {convos.length ? convos.map((r) => {
            const sid = String(r.other_key).slice(2);
            const isBlockedConvo = blockedIds.has(sid);
            return (
              <a class="c-post" href={`${info.base}/community/dm/${r.slug}`} data-dm-convo={r.slug}>
                <h3>{nameOf({ author_subscriber_id: sid }).name} {r.unread > 0 && !isBlockedConvo && <span class="s-badge" data-dm-unread>{r.unread > 99 ? '99+' : r.unread} new</span>} {isBlockedConvo && <span class="s-badge">blocked</span>}</h3>
                <p>{truncate(r.last_body || 'No messages yet', 140)}</p>
                <div class="c-meta">{ago(r.last_message_at || r.created_at)}</div>
              </a>
            );
          }) : <p class="s-muted">No conversations yet.</p>}
        </div>
        <form method="post" action={`${info.base}/community/dm/settings`} class="s-box s-stack" style="margin-top:24px">
          <strong>Privacy</strong>
          <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="dms_enabled" value="1" checked={!!info.member!.dms_enabled} /> Allow other members to send me direct messages</label>
          <button class="s-btn s-btn-ghost">Save</button>
        </form>
        {blocked.length > 0 && (
          <div class="s-box" style="margin-top:16px">
            <strong>Blocked members</strong>
            {blocked.map((b) => (
              <form method="post" action={`${info.base}/community/block`} style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
                <span>{b.name}</span><input type="hidden" name="sid" value={b.blocked_id} /><button class="s-btn s-btn-ghost" name="action" value="unblock">Unblock</button>
              </form>
            ))}
          </div>
        )}
      </>
    ));
  });

  site.post('/community/dm/settings', async (c) => {
    const info = await ctxInfo(c);
    const err = requireWriter(info);
    if (err) return SiteMessage(c, 'Not allowed', <p>{err}</p>, 403);
    const on = (await form(c.req)).dms_enabled ? 1 : 0;
    await run(c.env, 'UPDATE community_members SET dms_enabled = ? WHERE pub_id = ? AND subscriber_id = ?', on, info.pub.id, info.sub!.id);
    return back(c, `${info.base}/community/dm`, on ? 'Members can message you' : 'Direct messages turned off');
  });

  // ── Start (or reopen) a conversation with a member
  site.post('/community/dm/start', async (c) => {
    const info = await ctxInfo(c);
    const err = requireWriter(info);
    if (err) return SiteMessage(c, 'Not allowed', <p>{err}</p>, 403);
    const to = str((await form(c.req)).to, 40);
    const target = to ? await memberCard(c, info.pub.id, to) : null;
    if (!target) return SiteMessage(c, 'Member not found', <p>That member doesn't exist.</p>, 404);
    const existing = await one<ChatRoomRow>(c.env, 'SELECT * FROM chat_rooms WHERE pub_id = ? AND slug = ?', info.pub.id, dmSlug(info.sub!.id, to));
    if (!existing) {
      const why = await dmBlockedReason(c.env, info.pub.id, info.sub!.id, to);
      if (why) return back(c, `${info.base}/community/u/${to}`, why, 'err');
      if (!(await rateLimit(c.env, `dmstart:${info.sub!.id}`, 30, 86400))) return SiteMessage(c, 'Slow down', <p>You've started a lot of conversations today. Try again tomorrow.</p>, 429);
    }
    const room = existing && (await one(c.env, `SELECT 1 FROM chat_room_members WHERE room_id = ? AND member_key = ? AND joined = 1`, existing.id, 's:' + info.sub!.id)) ? existing : await ensureDm(c, info.pub.id, info.sub!.id, to);
    return c.redirect(`${info.base}/community/dm/${room.slug}`, 303);
  });

  // ── Conversation (same real-time UI as group chats)
  site.get('/community/dm/:room', async (c) => {
    const info = await ctxInfo(c);
    const err = requireWriter(info);
    if (err) return Shell(c, 'Direct messages', 'dm', <><h1>Direct messages</h1><p class="s-muted">{err}</p><Gate base={info.base} pubName={info.pub.name} /></>);
    const room = await one<ChatRoomRow>(c.env, `SELECT * FROM chat_rooms WHERE pub_id = ? AND slug = ? AND kind = 'dm'`, info.pub.id, c.req.param('room'));
    const key = 's:' + info.sub!.id;
    const mine = room && (await one(c.env, 'SELECT 1 FROM chat_room_members WHERE room_id = ? AND member_key = ? AND joined = 1', room.id, key));
    if (!room || !mine) return SiteMessage(c, 'Conversation not found', <p><a href={`${info.base}/community/dm`}>Back to your messages</a></p>, 404);
    const other = await one<{ member_key: string }>(c.env, 'SELECT member_key FROM chat_room_members WHERE room_id = ? AND member_key != ?', room.id, key);
    const otherId = other?.member_key.slice(2) || '';
    const them = otherId ? await memberCard(c, info.pub.id, otherId) : null;
    const why = otherId ? await dmBlockedReason(c.env, info.pub.id, info.sub!.id, otherId) : 'This conversation is closed.';
    const blockedByMe = (await isBlocked(c.env, info.pub.id, info.sub!.id, otherId)) === 'by_me';
    const myName = info.member?.display_name || info.sub!.name || info.sub!.email.split('@')[0];
    const prefix = new URL(c.req.url).pathname.replace(/\/community\/dm\/[^/]+\/?$/, '');
    const cfg = {
      ws: `${prefix}/community/chat/${room.slug}/ws`, upload: `${prefix}/community/chat/upload`,
      me: { key, name: myName, mod: false }, roomId: room.id, mentionables: [],
    };
    const shown = { ...room, name: them?.name || 'Former member', description: 'Direct message' } as ChatRoomRow;
    return Shell(c, `Messages with ${shown.name}`, 'dm', (
      <>
        <link rel="stylesheet" href="/static/community-chat.css" />
        <p class="s-small" style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <a href={`${info.base}/community/dm`}>← All messages</a>
          <span style="display:flex;gap:12px">
            {them && <a href={`${info.base}/community/u/${otherId}`}>View profile</a>}
            {them && <form method="post" action={`${info.base}/community/block`} style="display:inline"><input type="hidden" name="sid" value={otherId} /><input type="hidden" name="back" value={`/community/dm/${room.slug}`} /><button class="s-link" style="background:none;border:0;color:var(--muted);cursor:pointer;padding:0;font:inherit" name="action" value={blockedByMe ? 'unblock' : 'block'} data-confirm={blockedByMe ? undefined : 'Block this member? They will not be able to message you.'}>{blockedByMe ? 'Unblock' : 'Block'}</button></form>}
          </span>
        </p>
        {why && <div class="s-box" data-dm-blocked style="margin-bottom:12px">{why}</div>}
        <ChatUI cfg={cfg} room={shown} />
        <p class="s-muted s-small" style="margin-top:8px">Use “Report” on a message to send it to the moderators.</p>
        <script src="/static/community-chat.js" defer></script>
      </>
    ));
  });

  // ── Block / unblock
  site.post('/community/block', async (c) => {
    const info = await ctxInfo(c);
    if (!info.sub || !info.member) return SiteMessage(c, 'Log in', <p>Log in first.</p>, 403);
    const f = await form(c.req);
    const sid = str(f.sid, 40);
    if (!sid || sid === info.sub.id || !(await one(c.env, 'SELECT 1 FROM subscribers WHERE id = ? AND pub_id = ?', sid, info.pub.id))) return SiteMessage(c, 'Member not found', <p>That member doesn't exist.</p>, 404);
    const backTo = typeof f.back === 'string' && f.back.startsWith('/community/') ? info.base + f.back : `${info.base}/community/u/${sid}`;
    if (f.action === 'unblock') {
      await run(c.env, 'DELETE FROM community_blocks WHERE pub_id = ? AND blocker_id = ? AND blocked_id = ?', info.pub.id, info.sub.id, sid);
      return back(c, backTo, 'Member unblocked');
    }
    await run(c.env, 'INSERT OR IGNORE INTO community_blocks (pub_id, blocker_id, blocked_id, created_at) VALUES (?, ?, ?, ?)', info.pub.id, info.sub.id, sid, now());
    // Close their live connection to the shared DM so the block takes effect immediately.
    const room = await one<any>(c.env, 'SELECT id FROM chat_rooms WHERE pub_id = ? AND slug = ?', info.pub.id, dmSlug(info.sub.id, sid));
    if (room) await chatKick(c.env, room.id, 's:' + sid, 'This member is no longer accepting messages from you.').catch(() => {});
    return back(c, backTo, "Member blocked — they can't message you anymore");
  });

  // ── Member profile
  site.get('/community/u/:sid', async (c) => {
    const info = await ctxInfo(c);
    if (!info.sub || info.sub.status !== 'active') return Shell(c, 'Member', '', <Gate base={info.base} pubName={info.pub.name} />);
    const sid = c.req.param('sid');
    const m = await memberCard(c, info.pub.id, sid);
    if (!m || m.status !== 'active') return SiteMessage(c, 'Member not found', <p><a href={`${info.base}/community`}>Back to community</a></p>, 404);
    const posts = await all<any>(c.env, `SELECT p.id, p.title, p.body, p.created_at, ch.slug AS ch_slug, ch.name AS ch_name FROM community_posts p JOIN channels ch ON ch.id = p.channel_id WHERE p.pub_id = ? AND p.author_subscriber_id = ? AND p.status = 'visible' AND ch.access = 'free' ORDER BY p.created_at DESC LIMIT 10`, info.pub.id, sid);
    const self = sid === info.sub.id;
    const blocked = self ? null : await isBlocked(c.env, info.pub.id, info.sub.id, sid);
    const why = self ? null : await dmBlockedReason(c.env, info.pub.id, info.sub.id, sid);
    const writer = !requireWriter(info);
    return Shell(c, m.name, '', (
      <>
        <h1>{m.name}</h1>
        <p class="c-meta">{m.role !== 'member' && <span class="c-role">{m.role}</span>}<span>Member since {fmtDate(m.joined_at || now(), { dateStyle: 'medium' })}</span></p>
        {self ? <p class="s-muted">This is how other members see you. <a href={`${info.base}/community/dm`}>Message settings</a></p> : writer && (
          <div style="display:flex;gap:10px;margin:16px 0;flex-wrap:wrap">
            {!why ? (
              <form method="post" action={`${info.base}/community/dm/start`}><input type="hidden" name="to" value={sid} /><button class="s-btn" data-dm-start>Message</button></form>
            ) : <span class="s-muted" data-dm-why>{why}</span>}
            <form method="post" action={`${info.base}/community/block`}><input type="hidden" name="sid" value={sid} /><button class="s-btn s-btn-ghost" name="action" value={blocked === 'by_me' ? 'unblock' : 'block'} data-confirm={blocked === 'by_me' ? undefined : 'Block this member? They will not be able to message you.'}>{blocked === 'by_me' ? 'Unblock' : 'Block'}</button></form>
          </div>
        )}
        <h2 style="margin-top:24px">Recent discussions</h2>
        {posts.length ? posts.map((p) => (
          <a class="c-post" href={`${info.base}/community/${p.ch_slug}/${p.id}`}><h3>{p.title || truncate(p.body, 70)}</h3><p>{truncate(p.body, 160)}</p><div class="c-meta">#{p.ch_name} · {ago(p.created_at)}</div></a>
        )) : <p class="s-muted">No public discussions yet.</p>}
      </>
    ));
  });

  // ── Upcoming events synced with Luma
  site.get('/community/events', async (c) => {
    const info = await ctxInfo(c);
    await trackView(c, 'community-events');
    const evs = await upcomingLumaEvents(c.env, info.pub.id, 50);
    return Shell(c, 'Events', 'events', (
      <>
        <h1>Upcoming events</h1>
        <p class="s-muted">Events from the {info.pub.name} Luma calendar. Register on the event page.</p>
        {evs.length ? evs.map((e) => (
          <a class="c-post" href={`${info.base}/events/${e.slug}`} data-luma-event={e.luma_event_id}>
            <h3>{e.title}</h3>
            <p>{fmtDate(e.starts_at, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }, e.timezone)}{e.location ? ` · ${e.location}` : e.kind === 'webinar' ? ' · Online' : ''}</p>
          </a>
        )) : <p class="s-muted">No upcoming events right now.</p>}
      </>
    ));
  });
}
