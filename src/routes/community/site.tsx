/** @jsxImportSource hono/jsx */
// Public community: channels, threads with nested comments, likes, reports, member DMs, Discord linking.
import { raw } from 'hono/html';
import type { App, Ctx } from '../../types';
import { all, one, run, insert } from '../../lib/db';
import { rateLimit } from '../../lib/guard';
import { siteUrl } from '../../lib/pub';
import { trackView } from '../../lib/tracking';
import { SiteLayout, SiteMessage } from '../../ui/site';
import { back } from '../../ui/components';
import { id, now, form, str, ago, truncate, esc } from '../../lib/util';
import { channelAccess, getMember, ensureDefaultChannel, renderBody, authorNames, createCommunityPost, notify, canModerate, canManage, type Channel } from './shared';
import { discordCfg, syncDiscordRoles } from '../../lib/discord';
import { pubAdminEmails } from '../grow/shared';

const CSS = `.c-layout{display:grid;grid-template-columns:220px 1fr;gap:28px;padding:32px 20px}.c-side a{display:flex;justify-content:space-between;padding:7px 10px;border-radius:8px;text-decoration:none;color:var(--muted)}.c-side a.on,.c-side a:hover{background:var(--surface);color:var(--text)}.c-side h4{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:16px 10px 6px}
.c-post{border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;margin-bottom:12px;background:var(--bg);display:block;text-decoration:none;color:inherit}.c-post:hover{border-color:var(--accent)}.c-post h3{margin:0 0 4px;font-size:18px}.c-post p{margin:0;color:var(--muted);font-size:15px}
.c-meta{font-size:13px;color:var(--muted);display:flex;gap:10px;flex-wrap:wrap;align-items:center}.c-role{font-size:11px;font-weight:700;padding:1px 7px;border-radius:999px;background:var(--accent);color:var(--accent-text);text-transform:uppercase}
.c-body{font-size:17px;line-height:1.65}.c-comment{padding:12px 0 4px}.c-children{margin-left:22px;border-left:2px solid var(--border);padding-left:14px}.c-actions{display:flex;gap:10px;font-size:13px;margin-top:4px}.c-actions button,.c-actions summary{background:none;border:0;padding:0;color:var(--muted);cursor:pointer;font:inherit;list-style:none}.c-actions summary::-webkit-details-marker{display:none}
.c-msg{max-width:78%;padding:10px 14px;border-radius:14px;margin:0 0 10px;background:var(--surface)}.c-msg.me{margin-left:auto;background:color-mix(in srgb,var(--accent) 18%,var(--bg))}
@media(max-width:760px){.c-layout{grid-template-columns:1fr}.c-side{display:flex;gap:6px;overflow-x:auto}.c-side h4{display:none}}`;

async function ctxInfo(c: Ctx) {
  const pub = c.get('pub');
  const reader = c.get('reader');
  const sub = reader?.subscriber || null;
  const member = sub ? await getMember(c.env, pub.id, sub.id) : null;
  return { pub, reader, sub, member, premium: !!reader?.premium, base: siteUrl(c.env, pub) };
}

async function findChannel(c: Ctx, key: string) {
  return one<Channel>(c.env, 'SELECT * FROM channels WHERE pub_id = ? AND (slug = ? OR id = ?)', c.get('pub').id, key, key);
}

function Gate({ reason, base, pubName }: { reason?: string; base: string; pubName: string }) {
  if (reason === 'upgrade') return <div class="s-box"><strong>This channel is for paid subscribers.</strong><p class="s-muted">Upgrade to join the conversation.</p><a class="s-btn" href={base + '/upgrade'}>Upgrade</a></div>;
  return <div class="s-box"><strong>Join the {pubName} community</strong><p class="s-muted">Subscribe or log in to read and post.</p><button class="s-btn" data-modal="subscribe">Subscribe</button> <button class="s-btn s-btn-ghost" data-modal="login">Log in</button></div>;
}

async function Shell(c: Ctx, title: string, active: string, content: any) {
  const { pub, sub, member, premium, base } = await ctxInfo(c);
  const chans = await all<Channel>(c.env, 'SELECT * FROM channels WHERE pub_id = ? ORDER BY position, created_at', pub.id);
  const unread = sub ? (await one<{ n: number }>(c.env, `SELECT COUNT(*) AS n FROM direct_messages WHERE pub_id = ? AND subscriber_id = ? AND from_side = 'publication' AND read_at IS NULL`, pub.id, sub.id))?.n || 0 : 0;
  return c.html(await SiteLayout({
    c, title, head: <style>{raw(CSS)}</style>,
    children: (
      <div class="s-wrap c-layout">
        <aside class="c-side">
          <h4>Channels</h4>
          {chans.map((ch) => {
            const acc = channelAccess(ch, sub, premium);
            return <a href={`${base}/community/${ch.slug}`} class={active === ch.slug ? 'on' : ''}><span>#{ch.name}</span>{ch.access !== 'free' && !acc.ok ? <span>🔒</span> : null}</a>;
          })}
          {member?.status === 'active' && <><h4>You</h4><a href={`${base}/community/messages`} class={active === 'messages' ? 'on' : ''}><span>Messages</span>{unread ? <span class="s-badge">{unread}</span> : null}</a>{discordCfg(pub) && <a href={`${base}/community/discord`} class={active === 'discord' ? 'on' : ''}>Discord</a>}</>}
        </aside>
        <section style="min-width:0">{content}</section>
      </div>
    ),
  }));
}

function requireWriter(info: Awaited<ReturnType<typeof ctxInfo>>): string | null {
  if (!info.sub || info.sub.status !== 'active') return 'Subscribe or log in to participate.';
  if (!info.member) return 'Join the community first.';
  if (info.member.status === 'banned') return 'You have been removed from this community.';
  if (info.member.status !== 'active') return 'Accept your invite to join the community first.';
  return null;
}

export function registerCommunitySite(site: App) {
  site.get('/community', async (c) => {
    const info = await ctxInfo(c);
    await ensureDefaultChannel(c.env, info.pub.id);
    await trackView(c, 'community');
    const def = await one<Channel>(c.env, 'SELECT * FROM channels WHERE pub_id = ? ORDER BY is_default DESC, position LIMIT 1', info.pub.id);
    if (info.member?.status === 'active' && def && !c.req.query('home')) return c.redirect(`${info.base}/community/${def.slug}`);
    const chans = await all<any>(c.env, `SELECT ch.*, (SELECT COUNT(*) FROM community_posts p WHERE p.channel_id = ch.id AND p.status = 'visible') AS posts FROM channels ch WHERE ch.pub_id = ? ORDER BY position`, info.pub.id);
    const members = (await one<{ n: number }>(c.env, `SELECT COUNT(*) AS n FROM community_members WHERE pub_id = ? AND status = 'active'`, info.pub.id))?.n || 0;
    return Shell(c, 'Community', '', (
      <>
        <h1>{info.pub.name} Community</h1>
        <p class="s-muted">{members} members · discussions, Q&amp;A and direct access to the team.</p>
        {info.member?.status === 'banned' ? <div class="s-box">You no longer have access to this community.</div>
          : info.sub?.status === 'active' ? (
            <form method="post" action={`${info.base}/community/join`} class="s-box s-stack">
              <strong>{info.member?.status === 'invited' ? "You've been invited! 🎉" : 'Join the community'}</strong>
              <input class="s-input" name="display_name" placeholder="Display name" value={info.sub.name} style="width:100%" />
              <button class="s-btn">Join community</button>
            </form>
          ) : <Gate base={info.base} pubName={info.pub.name} />}
        <h2 style="margin-top:28px">Channels</h2>
        {chans.map((ch) => <a class="c-post" href={`${info.base}/community/${ch.slug}`}><h3>#{ch.name} {ch.access !== 'free' && <span class="s-badge">🔒 Paid</span>}</h3><p>{ch.description}</p><div class="c-meta">{ch.posts} posts</div></a>)}
      </>
    ));
  });

  site.post('/community/join', async (c) => {
    const info = await ctxInfo(c);
    if (!info.sub || info.sub.status !== 'active') return SiteMessage(c, 'Subscribe first', <p>Subscribe or log in to join the community.</p>, 403);
    if (info.member?.status === 'banned') return SiteMessage(c, 'Access removed', <p>You have been removed from this community.</p>, 403);
    const name = str((await form(c.req)).display_name, 60) || null;
    await run(c.env, `INSERT INTO community_members (pub_id, subscriber_id, role, status, display_name, joined_at) VALUES (?, ?, 'member', 'active', ?, ?) ON CONFLICT(pub_id, subscriber_id) DO UPDATE SET status = 'active', display_name = COALESCE(excluded.display_name, display_name), joined_at = excluded.joined_at`, info.pub.id, info.sub.id, name, now());
    await run(c.env, 'UPDATE community_invites SET accepted_at = ? WHERE pub_id = ? AND email = ? AND accepted_at IS NULL', now(), info.pub.id, info.sub.email);
    return back(c, `${info.base}/community`, 'Welcome to the community! 👋');
  });

  // ── Member DMs with the publication
  site.get('/community/messages', async (c) => {
    const info = await ctxInfo(c);
    const err = requireWriter(info);
    if (err) return Shell(c, 'Messages', 'messages', <Gate base={info.base} pubName={info.pub.name} />);
    await run(c.env, `UPDATE direct_messages SET read_at = ? WHERE pub_id = ? AND subscriber_id = ? AND from_side = 'publication' AND read_at IS NULL`, now(), info.pub.id, info.sub!.id);
    const msgs = await all<any>(c.env, 'SELECT * FROM direct_messages WHERE pub_id = ? AND subscriber_id = ? ORDER BY created_at LIMIT 500', info.pub.id, info.sub!.id);
    return Shell(c, 'Messages', 'messages', (
      <>
        <h1>Messages with {info.pub.name}</h1>
        <div style="margin:20px 0">{msgs.length ? msgs.map((m) => (
          <div class={`c-msg ${m.from_side === 'member' ? 'me' : ''}`}><div class="c-meta">{m.from_side === 'member' ? 'You' : info.pub.name} · {ago(m.created_at)}{m.from_side === 'publication' && <form method="post" action={`${info.base}/community/report`} style="display:inline"><input type="hidden" name="kind" value="dm" /><input type="hidden" name="target" value={m.id} /><button style="background:none;border:0;color:var(--muted);cursor:pointer;font-size:12px">Report</button></form>}</div>{raw(renderBody(m.body))}</div>
        )) : <p class="s-muted">Say hello — the team reads every message.</p>}</div>
        <form method="post" action={`${info.base}/community/messages`} class="s-form"><textarea name="body" required placeholder="Write a message…" /><button class="s-btn">Send</button></form>
      </>
    ));
  });

  site.post('/community/messages', async (c) => {
    const info = await ctxInfo(c);
    const err = requireWriter(info);
    if (err) return SiteMessage(c, 'Not allowed', <p>{err}</p>, 403);
    if (!(await rateLimit(c.env, `dm:${info.sub!.id}`, 20, 3600))) return SiteMessage(c, 'Slow down', <p>You're sending messages too quickly.</p>, 429);
    const body = str((await form(c.req)).body, 5000);
    if (!body) return back(c, `${info.base}/community/messages`);
    await insert(c.env, 'direct_messages', { id: id(), pub_id: info.pub.id, subscriber_id: info.sub!.id, from_side: 'member', body, created_at: now() });
    for (const e of await pubAdminEmails(c.env, info.pub)) await notify(c.env, info.pub, e, `New community message from ${info.sub!.name || info.sub!.email}`, `<p>${esc(truncate(body, 600)).replace(/\n/g, '<br>')}</p>`, `${c.env.APP_URL.replace(/\/$/, '')}/app/community/messages/${info.sub!.id}?pub=${info.pub.id}`);
    return back(c, `${info.base}/community/messages`, 'Message sent');
  });

  // ── Discord account linking
  site.get('/community/discord', async (c) => {
    const info = await ctxInfo(c);
    const err = requireWriter(info);
    if (err || !discordCfg(info.pub)) return Shell(c, 'Discord', 'discord', err ? <Gate base={info.base} pubName={info.pub.name} /> : <p>Discord isn't enabled for this community.</p>);
    return Shell(c, 'Discord', 'discord', (
      <>
        <h1>Link your Discord</h1>
        <p class="s-muted">Your Discord roles will follow your subscription tier automatically. In Discord: Settings → Advanced → enable Developer Mode, then right-click your name → Copy User ID.</p>
        <form method="post" action={`${info.base}/community/discord`} class="s-form" style="margin-top:16px">
          <input name="discord_user_id" value={info.member?.discord_user_id || ''} placeholder="Your Discord user ID (e.g. 80351110224678912)" pattern="\d{15,21}" required />
          <button class="s-btn">{info.member?.discord_user_id ? 'Update & re-sync' : 'Link & sync roles'}</button>
        </form>
      </>
    ));
  });

  site.post('/community/discord', async (c) => {
    const info = await ctxInfo(c);
    const err = requireWriter(info);
    if (err) return SiteMessage(c, 'Not allowed', <p>{err}</p>, 403);
    const did = str((await form(c.req)).discord_user_id, 25);
    if (!/^\d{15,21}$/.test(did)) return back(c, `${info.base}/community/discord`, 'That does not look like a Discord user ID', 'err');
    await run(c.env, 'UPDATE community_members SET discord_user_id = ? WHERE pub_id = ? AND subscriber_id = ?', did, info.pub.id, info.sub!.id);
    const r = await syncDiscordRoles(c.env, info.pub, info.sub!.id);
    return back(c, `${info.base}/community/discord`, `Discord linked. ${r}`, r.startsWith('Synced') ? 'ok' : 'err');
  });

  // ── Reports & likes
  site.post('/community/report', async (c) => {
    const info = await ctxInfo(c);
    if (!info.sub) return SiteMessage(c, 'Log in', <p>Log in to report content.</p>, 403);
    const f = await form(c.req);
    const kind = ['post', 'comment', 'dm'].includes(f.kind) ? f.kind : 'post';
    if (!(await rateLimit(c.env, `report:${info.sub.id}`, 20, 3600))) return SiteMessage(c, 'Slow down', <p>Too many reports.</p>, 429);
    await insert(c.env, 'community_reports', { id: id(), pub_id: info.pub.id, target_kind: kind, target_id: str(f.target, 40), reporter_subscriber_id: info.sub.id, reason: str(f.reason, 300), status: 'open', created_at: now() });
    return back(c, c.req.header('referer') || `${info.base}/community`, 'Thanks — our moderators will review it.');
  });

  site.post('/community/like/:postId', async (c) => {
    const info = await ctxInfo(c);
    if (requireWriter(info)) return c.json({ error: 'join_required' }, 401);
    const p = await one<any>(c.env, 'SELECT id FROM community_posts WHERE id = ? AND pub_id = ?', c.req.param('postId'), info.pub.id);
    if (!p) return c.notFound();
    const res = await run(c.env, 'INSERT OR IGNORE INTO community_likes (post_id, subscriber_id, created_at) VALUES (?, ?, ?)', p.id, info.sub!.id, now());
    if (res.meta.changes) await run(c.env, 'UPDATE community_posts SET like_count = like_count + 1 WHERE id = ?', p.id);
    else { await run(c.env, 'DELETE FROM community_likes WHERE post_id = ? AND subscriber_id = ?', p.id, info.sub!.id); await run(c.env, 'UPDATE community_posts SET like_count = MAX(0, like_count - 1) WHERE id = ?', p.id); }
    const n = (await one<{ like_count: number }>(c.env, 'SELECT like_count FROM community_posts WHERE id = ?', p.id))?.like_count || 0;
    if (c.req.header('accept')?.includes('json')) return c.json({ likes: n, liked: !!res.meta.changes });
    return back(c, c.req.header('referer') || `${info.base}/community`);
  });

  // ── Channel
  site.get('/community/:channel', async (c) => {
    const info = await ctxInfo(c);
    const ch = await findChannel(c, c.req.param('channel'));
    if (!ch) return SiteMessage(c, 'Channel not found', <p><a href={`${info.base}/community`}>Back to community</a></p>, 404);
    await trackView(c, 'channel:' + ch.id);
    const acc = channelAccess(ch, info.sub, info.premium);
    if (!acc.ok) return Shell(c, `#${ch.name}`, ch.slug, <><h1>#{ch.name}</h1><p class="s-muted">{ch.description}</p><Gate reason={acc.reason} base={info.base} pubName={info.pub.name} /></>);
    const posts = await all<any>(c.env, `SELECT * FROM community_posts WHERE channel_id = ? AND status = 'visible' ORDER BY pinned DESC, last_activity_at DESC LIMIT 100`, ch.id);
    const nameOf = await authorNames(c.env, posts, info.pub.id);
    const writerErr = requireWriter(info);
    return Shell(c, `#${ch.name}`, ch.slug, (
      <>
        <h1>#{ch.name}</h1>
        <p class="s-muted">{ch.description}</p>
        {writerErr ? (info.member ? <div class="s-box">{writerErr}</div> : <form method="post" action={`${info.base}/community/join`} class="s-box"><strong>Join the community to post.</strong> <button class="s-btn">Join</button></form>) : (
          <details class="s-box" style="margin:16px 0" open={!posts.length}>
            <summary style="cursor:pointer;font-weight:650">Start a discussion</summary>
            <form method="post" action={`${info.base}/community/${ch.slug}`} class="s-form" style="margin-top:12px">
              <input name="title" placeholder="Title" required style="width:100%" />
              <textarea name="body" placeholder="What's on your mind?" required />
              <button class="s-btn">Post</button>
            </form>
          </details>
        )}
        {posts.length ? posts.map((p) => (
          <a class="c-post" href={`${info.base}/community/${ch.slug}/${p.id}`}>
            <h3>{p.pinned ? '📌 ' : ''}{p.title || truncate(p.body, 70)}</h3>
            <p>{truncate(p.body, 180)}</p>
            <div class="c-meta" style="margin-top:8px"><span>{nameOf(p).name}</span>{nameOf(p).team && <span class="c-role">team</span>}<span>{ago(p.created_at)}</span><span>💬 {p.reply_count}</span><span>♥ {p.like_count}</span></div>
          </a>
        )) : <p class="s-muted">No discussions yet — be the first!</p>}
      </>
    ));
  });

  site.post('/community/:channel', async (c) => {
    const info = await ctxInfo(c);
    const ch = await findChannel(c, c.req.param('channel'));
    if (!ch) return c.notFound();
    const err = requireWriter(info) || (channelAccess(ch, info.sub, info.premium).ok ? null : 'You need access to this channel.');
    if (err) return SiteMessage(c, 'Not allowed', <p>{err}</p>, 403);
    if (!(await rateLimit(c.env, `cpost:${info.sub!.id}`, 10, 3600))) return SiteMessage(c, 'Slow down', <p>You're posting too quickly.</p>, 429);
    const f = await form(c.req);
    const body = str(f.body, 20000);
    if (!body) return back(c, `${info.base}/community/${ch.slug}`, 'Write something first', 'err');
    const pid = await createCommunityPost(c.env, info.pub, { channel_id: ch.id, title: str(f.title, 200), body, author_subscriber_id: info.sub!.id });
    return back(c, `${info.base}/community/${ch.slug}/${pid}`, 'Posted!');
  });

  // ── Thread
  site.get('/community/:channel/:postId', async (c) => {
    const info = await ctxInfo(c);
    const ch = await findChannel(c, c.req.param('channel'));
    const p = ch && (await one<any>(c.env, `SELECT * FROM community_posts WHERE id = ? AND channel_id = ? AND status != 'removed'`, c.req.param('postId'), ch.id));
    if (!ch || !p) return SiteMessage(c, 'Post not found', <p><a href={`${info.base}/community`}>Back to community</a></p>, 404);
    const acc = channelAccess(ch, info.sub, info.premium);
    if (!acc.ok) return Shell(c, `#${ch.name}`, ch.slug, <Gate reason={acc.reason} base={info.base} pubName={info.pub.name} />);
    const mod = canModerate(info.member?.status === 'active' ? info.member.role : null);
    if (p.status === 'hidden' && !mod) return SiteMessage(c, 'Post hidden', <p>This post was hidden by a moderator.</p>, 404);
    await trackView(c, 'cpost:' + p.id);
    const comments = await all<any>(c.env, `SELECT * FROM community_comments WHERE post_id = ? AND status ${mod ? "!= 'removed'" : "= 'visible'"} ORDER BY created_at`, p.id);
    const nameOf = await authorNames(c.env, [p, ...comments], info.pub.id);
    const liked = info.sub ? !!(await one(c.env, 'SELECT 1 FROM community_likes WHERE post_id = ? AND subscriber_id = ?', p.id, info.sub.id)) : false;
    const writer = !requireWriter(info);
    const url = `${info.base}/community/${ch.slug}/${p.id}`;
    const Author = ({ r }: { r: any }) => { const a = nameOf(r); return <><strong>{a.name}</strong>{a.team ? <span class="c-role">team</span> : a.role !== 'member' ? <span class="c-role">{a.role}</span> : null}</>; };
    const Thread = ({ parent, depth }: { parent: string | null; depth: number }): any => {
      const kids = comments.filter((x) => (x.parent_id || null) === parent);
      if (!kids.length) return null;
      return (
        <div class={depth ? 'c-children' : ''}>
          {kids.map((cm) => (
            <div class="c-comment" id={`c-${cm.id}`}>
              <div class="c-meta"><Author r={cm} /><span>{ago(cm.created_at)}</span>{cm.status === 'hidden' && <span class="s-badge">hidden</span>}</div>
              <div style={cm.status === 'hidden' ? 'opacity:.5' : ''}>{raw(renderBody(cm.body))}</div>
              <div class="c-actions">
                {writer && depth < 5 && <details><summary>Reply</summary><form method="post" action={url} class="s-form" style="margin-top:8px"><input type="hidden" name="parent_id" value={cm.id} /><input name="body" required placeholder="Write a reply" /><button class="s-btn">Reply</button></form></details>}
                {info.sub && <form method="post" action={`${info.base}/community/report`}><input type="hidden" name="kind" value="comment" /><input type="hidden" name="target" value={cm.id} /><button>Report</button></form>}
                {mod && <form method="post" action={`${url}/mod`}><input type="hidden" name="comment" value={cm.id} /><button name="action" value={cm.status === 'hidden' ? 'show_comment' : 'hide_comment'}>{cm.status === 'hidden' ? 'Restore' : 'Hide'}</button></form>}
              </div>
              <Thread parent={cm.id} depth={depth + 1} />
            </div>
          ))}
        </div>
      );
    };
    return Shell(c, p.title || `#${ch.name}`, ch.slug, (
      <article>
        <p class="c-meta"><a href={`${info.base}/community/${ch.slug}`}>← #{ch.name}</a></p>
        <h1>{p.pinned ? '📌 ' : ''}{p.title}</h1>
        <div class="c-meta"><Author r={p} /><span>{ago(p.created_at)}</span>{p.status === 'hidden' && <span class="s-badge">hidden</span>}</div>
        <div class="c-body" style="margin:16px 0">{raw(renderBody(p.body))}</div>
        <div class="c-actions" style="font-size:15px;gap:16px">
          <form method="post" action={`${info.base}/community/like/${p.id}`}><button style={liked ? 'color:var(--accent);font-weight:700' : ''}>♥ {p.like_count}</button></form>
          {info.sub && <form method="post" action={`${info.base}/community/report`}><input type="hidden" name="kind" value="post" /><input type="hidden" name="target" value={p.id} /><button>Report</button></form>}
          {mod && <form method="post" action={`${url}/mod`} style="display:flex;gap:12px">{canManage(info.member?.role) && <button name="action" value={p.pinned ? 'unpin' : 'pin'}>{p.pinned ? 'Unpin' : 'Pin'}</button>}<button name="action" value={p.status === 'hidden' ? 'show' : 'hide'}>{p.status === 'hidden' ? 'Restore' : 'Hide'}</button></form>}
        </div>
        <h3 style="margin-top:28px">{comments.length} comment{comments.length === 1 ? '' : 's'}</h3>
        {writer ? <form method="post" action={url} class="s-form" style="margin:12px 0"><textarea name="body" required placeholder="Add a comment" /><button class="s-btn">Comment</button></form> : <Gate base={info.base} pubName={info.pub.name} />}
        <Thread parent={null} depth={0} />
      </article>
    ));
  });

  site.post('/community/:channel/:postId/mod', async (c) => {
    const info = await ctxInfo(c);
    const role = info.member?.status === 'active' ? info.member.role : null;
    if (!canModerate(role)) return SiteMessage(c, 'Not allowed', <p>Moderators only.</p>, 403);
    const f = await form(c.req);
    const pid = c.req.param('postId');
    const a = f.action;
    if ((a === 'pin' || a === 'unpin') && canManage(role)) await run(c.env, 'UPDATE community_posts SET pinned = ? WHERE id = ? AND pub_id = ?', a === 'pin' ? 1 : 0, pid, info.pub.id);
    if (a === 'hide' || a === 'show') await run(c.env, 'UPDATE community_posts SET status = ? WHERE id = ? AND pub_id = ?', a === 'hide' ? 'hidden' : 'visible', pid, info.pub.id);
    if (a === 'hide_comment' || a === 'show_comment') await run(c.env, 'UPDATE community_comments SET status = ? WHERE id = ? AND pub_id = ?', a === 'hide_comment' ? 'hidden' : 'visible', str(f.comment, 40), info.pub.id);
    return back(c, c.req.header('referer') || `${info.base}/community`, 'Done');
  });

  site.post('/community/:channel/:postId', async (c) => {
    const info = await ctxInfo(c);
    const ch = await findChannel(c, c.req.param('channel'));
    const p = ch && (await one<any>(c.env, `SELECT * FROM community_posts WHERE id = ? AND channel_id = ? AND status = 'visible'`, c.req.param('postId'), ch.id));
    if (!ch || !p) return c.notFound();
    const err = requireWriter(info) || (channelAccess(ch, info.sub, info.premium).ok ? null : 'You need access to this channel.');
    if (err) return SiteMessage(c, 'Not allowed', <p>{err}</p>, 403);
    if (!(await rateLimit(c.env, `ccom:${info.sub!.id}`, 60, 3600))) return SiteMessage(c, 'Slow down', <p>You're commenting too quickly.</p>, 429);
    const f = await form(c.req);
    const body = str(f.body, 10000);
    const url = `${info.base}/community/${ch.slug}/${p.id}`;
    if (!body) return back(c, url, 'Write something first', 'err');
    const parent = f.parent_id ? await one<any>(c.env, `SELECT * FROM community_comments WHERE id = ? AND post_id = ? AND status = 'visible'`, f.parent_id, p.id) : null;
    const cid = id();
    await insert(c.env, 'community_comments', { id: cid, pub_id: info.pub.id, post_id: p.id, parent_id: parent?.id ?? null, author_subscriber_id: info.sub!.id, body, status: 'visible', created_at: now() });
    await run(c.env, 'UPDATE community_posts SET reply_count = reply_count + 1, last_activity_at = ? WHERE id = ?', now(), p.id);
    // notify the post author and the parent comment author (not yourself)
    const targets = new Set<string>([p.author_subscriber_id, parent?.author_subscriber_id].filter((x): x is string => !!x && x !== info.sub!.id));
    const who = info.member?.display_name || info.sub!.name || 'Someone';
    for (const sid of targets) {
      const s = await one<any>(c.env, `SELECT s.email FROM subscribers s JOIN community_members cm ON cm.subscriber_id = s.id AND cm.pub_id = s.pub_id WHERE s.id = ? AND s.status = 'active' AND cm.status = 'active'`, sid);
      if (s) await notify(c.env, info.pub, s.email, `${who} replied to ${sid === parent?.author_subscriber_id ? 'your comment' : 'your post'}`, `<p><strong>${esc(who)}</strong> replied${p.title ? ` in “${esc(p.title)}”` : ''}:</p><blockquote style="border-left:3px solid #f59e0b;margin:0;padding:4px 12px;color:#374151">${esc(truncate(body, 400))}</blockquote>`, `${url}#c-${cid}`);
    }
    return back(c, `${url}#c-${cid}`, 'Comment posted');
  });
}
