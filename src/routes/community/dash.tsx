/** @jsxImportSource hono/jsx */
// Community dashboard: overview metrics, channels, threads, members & invites, moderation queue, DMs, settings.
import { raw } from 'hono/html';
import type { App, Ctx } from '../../types';
import { all, one, run, val, insert } from '../../lib/db';
import { requirePerm, can, audit } from '../../lib/auth';
import { listMatching } from '../../lib/segments';
import { siteUrl } from '../../lib/pub';
import { DashLayout } from '../../ui/layout';
import { Card, Table, Btn, Field, Input, Textarea, Select, Modal, OpenBtn, ActionForm, Status, Empty, back, Help, Stats, Stat, Tabs, LineChart, Toggle, Check, Badge, Grid } from '../../ui/components';
import { id, now, form, str, num, ago, parseJSON, slugify, truncate, DAY, esc } from '../../lib/util';
import { ensureDefaultChannel, notify, renderBody, authorNames, createCommunityPost, teamCommunityRole, CROLES, type Channel } from './shared';
import { discordCfg, testDiscord, syncDiscordRoles, linkedMembers } from '../../lib/discord';
import { patchSettings } from '../grow/shared';

const TABS = (active: string): Array<[string, string]> => [['/app/community', 'Overview'], ['/app/community/channels', 'Channels'], ['/app/community/members', 'Members'], ['/app/community/moderation', 'Moderation'], ['/app/community/messages', 'Messages'], ['/app/community/settings', 'Settings']];

function Page(p: { c: Ctx; title: string; tab: string; children: any; actions?: any; crumbs?: Array<[string, string]> }) {
  return (
    <DashLayout c={p.c} title={p.title} section="community" actions={p.actions} crumbs={p.crumbs}>
      <Tabs items={TABS(p.tab)} active={p.tab} />
      {p.children}
    </DashLayout>
  );
}

async function inviteSubscribers(c: Ctx, subs: Array<{ id: string; email: string }>) {
  const pub = c.get('pub');
  const link = `${siteUrl(c.env, pub)}/community?invite=1`;
  let n = 0;
  for (const s of subs.slice(0, 1000)) {
    const existing = await one<any>(c.env, 'SELECT status FROM community_members WHERE pub_id = ? AND subscriber_id = ?', pub.id, s.id);
    if (existing && existing.status !== 'invited') continue;
    if (!existing) await insert(c.env, 'community_members', { pub_id: pub.id, subscriber_id: s.id, role: 'member', status: 'invited', invited_at: now(), joined_at: now() });
    await run(c.env, `INSERT INTO community_invites (id, pub_id, email, subscriber_id, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(pub_id, email) DO UPDATE SET created_at = excluded.created_at`, id(), pub.id, s.email, s.id, c.get('user').id, now());
    await notify(c.env, pub, s.email, `You're invited to the ${pub.name} community`, `<p>Join the conversation with fellow readers of <strong>${esc(pub.name)}</strong> — discussions, Q&amp;A and direct access to the team.</p>`, link);
    n++;
  }
  return n;
}

export function registerCommunityDash(dash: App) {
  dash.use('*', requirePerm('draft'));

  // ── Overview & metrics
  dash.get('/', async (c) => {
    const pub = c.get('pub');
    await ensureDefaultChannel(c.env, pub.id);
    const since = now() - 30 * DAY;
    const [members, newMembers, posts30, comments30, activeAuthors, openReports, unread] = await Promise.all([
      val<number>(c.env, `SELECT COUNT(*) FROM community_members WHERE pub_id = ? AND status = 'active'`, pub.id),
      val<number>(c.env, `SELECT COUNT(*) FROM community_members WHERE pub_id = ? AND status = 'active' AND joined_at > ?`, pub.id, since),
      val<number>(c.env, `SELECT COUNT(*) FROM community_posts WHERE pub_id = ? AND created_at > ?`, pub.id, since),
      val<number>(c.env, `SELECT COUNT(*) FROM community_comments WHERE pub_id = ? AND created_at > ?`, pub.id, since),
      val<number>(c.env, `SELECT COUNT(DISTINCT a) FROM (SELECT author_subscriber_id AS a FROM community_posts WHERE pub_id = ? AND created_at > ? UNION ALL SELECT author_subscriber_id FROM community_comments WHERE pub_id = ? AND created_at > ?) WHERE a IS NOT NULL`, pub.id, since, pub.id, since),
      val<number>(c.env, `SELECT COUNT(*) FROM community_reports WHERE pub_id = ? AND status = 'open'`, pub.id),
      val<number>(c.env, `SELECT COUNT(*) FROM direct_messages WHERE pub_id = ? AND from_side = 'member' AND read_at IS NULL`, pub.id),
    ]);
    const day = (t: number) => new Date(t).toISOString().slice(0, 10);
    const series = async (sql: string) => {
      const rows = await all<{ d: string; n: number }>(c.env, sql, pub.id, since);
      const m = new Map(rows.map((r) => [r.d, r.n]));
      return Array.from({ length: 30 }, (_, i) => m.get(day(since + (i + 1) * DAY)) || 0);
    };
    const labels = Array.from({ length: 30 }, (_, i) => day(since + (i + 1) * DAY).slice(5));
    const sm = await series(`SELECT date(joined_at/1000,'unixepoch') AS d, COUNT(*) AS n FROM community_members WHERE pub_id = ? AND status = 'active' AND joined_at > ? GROUP BY d`);
    const sp = await series(`SELECT date(created_at/1000,'unixepoch') AS d, COUNT(*) AS n FROM community_posts WHERE pub_id = ? AND created_at > ? GROUP BY d`);
    const sc = await series(`SELECT date(created_at/1000,'unixepoch') AS d, COUNT(*) AS n FROM community_comments WHERE pub_id = ? AND created_at > ? GROUP BY d`);
    const recent = await all<any>(c.env, `SELECT p.*, ch.name AS channel FROM community_posts p JOIN channels ch ON ch.id = p.channel_id WHERE p.pub_id = ? AND p.status != 'removed' ORDER BY p.last_activity_at DESC LIMIT 10`, pub.id);
    const nameOf = await authorNames(c.env, recent, pub.id);
    return c.html(
      <Page c={c} title="Community" tab="/app/community" actions={<a class="btn btn-secondary" target="_blank" href={`${siteUrl(c.env, pub)}/community`}>View community ↗</a>}>
        <Stats>
          <Stat label="Members" value={num(members)} sub={`+${num(newMembers)} in 30 days`} href="/app/community/members" />
          <Stat label="Posts (30d)" value={num(posts30)} />
          <Stat label="Comments (30d)" value={num(comments30)} />
          <Stat label="Active members (30d)" value={num(activeAuthors)} />
          <Stat label="Open reports" value={num(openReports)} href="/app/community/moderation" tone={openReports ? 'down' : ''} />
          <Stat label="Unread messages" value={num(unread)} href="/app/community/messages" />
        </Stats>
        <Card title="Activity — last 30 days"><LineChart labels={labels} series={[{ label: 'New members', values: sm }, { label: 'Posts', values: sp }, { label: 'Comments', values: sc }]} /></Card>
        <Card title="Recent discussions" pad={false}>
          <Table rows={recent} rowHref={(p) => `/app/community/posts/${p.id}`} empty={<Empty title="No posts yet" body="Start the first discussion as the publication, or invite your most engaged readers." action={<a class="btn btn-primary" href="/app/community/channels">Go to channels</a>} />} cols={[
            { h: 'Post', r: (p) => <><a href={`/app/community/posts/${p.id}`}>{p.pinned ? '📌 ' : ''}{p.title || truncate(p.body, 60)}</a><div class="muted small">{nameOf(p).name} · #{p.channel}</div></> },
            { h: 'Replies', class: 'right', r: (p) => num(p.reply_count) },
            { h: 'Likes', class: 'right', r: (p) => num(p.like_count) },
            { h: 'Status', r: (p) => <Status s={p.status} /> },
            { h: 'Activity', r: (p) => ago(p.last_activity_at) },
          ]} />
        </Card>
      </Page>,
    );
  });

  // ── Channels
  dash.get('/channels', async (c) => {
    const pub = c.get('pub');
    await ensureDefaultChannel(c.env, pub.id);
    const chans = await all<any>(c.env, `SELECT ch.*, (SELECT COUNT(*) FROM community_posts p WHERE p.channel_id = ch.id AND p.status != 'removed') AS posts FROM channels ch WHERE ch.pub_id = ? ORDER BY ch.position, ch.created_at`, pub.id);
    const tiers = await all<any>(c.env, `SELECT id, name FROM tiers WHERE pub_id = ? AND status != 'archived' ORDER BY position`, pub.id);
    return c.html(
      <Page c={c} title="Channels" tab="/app/community/channels" actions={can(c.get('role'), 'manage') && <OpenBtn target="#new-channel">+ New channel</OpenBtn>}>
        <Card pad={false}>
          <Table rows={chans} empty="No channels" cols={[
            { h: '', r: (ch) => <span class="nowrap"><ActionForm action={`/app/community/channels/${ch.id}/move`} fields={{ dir: 'up' }} label="↑" kind="ghost" /><ActionForm action={`/app/community/channels/${ch.id}/move`} fields={{ dir: 'down' }} label="↓" kind="ghost" /></span> },
            { h: 'Channel', r: (ch) => <><a href={`/app/community/channels/${ch.id}`}>#{ch.name}</a>{ch.is_default ? <> <Badge tone="blue">default</Badge></> : null}{ch.sync_posts ? <> <Badge tone="purple">newsletter sync</Badge></> : null}<div class="muted small">{ch.description}</div></> },
            { h: 'Access', r: (ch) => <Status s={ch.access === 'free' ? 'free' : 'premium'} /> },
            { h: 'Posts', class: 'right', r: (ch) => num(ch.posts) },
            { h: '', class: 'right nowrap', r: (ch) => <><OpenBtn target={`#edit-${ch.id}`} kind="ghost" small>Edit</OpenBtn>{!ch.is_default && <ActionForm action={`/app/community/channels/${ch.id}/delete`} label="Delete" kind="danger" confirm="Delete this channel and all its posts?" />}</> },
          ]} />
        </Card>
        <Help>The default channel is where new members land. Gated channels are a perk of paid tiers.</Help>
        <Modal id="new-channel" title="New channel"><form method="post" action="/app/community/channels"><ChannelFields tiers={tiers} /><div class="form-actions"><Btn>Create</Btn></div></form></Modal>
        {chans.map((ch) => <Modal id={`edit-${ch.id}`} title={`Edit #${ch.name}`}><form method="post" action={`/app/community/channels/${ch.id}`}><ChannelFields ch={ch} tiers={tiers} /><div class="form-actions"><Btn>Save</Btn></div></form></Modal>)}
      </Page>,
    );
  });

  const channelFromForm = (f: Record<string, any>) => ({
    name: str(f.name, 60), description: str(f.description, 300), access: ['free', 'premium', 'tiers'].includes(f.access) ? f.access : 'free',
    tier_ids: JSON.stringify(f.tier_ids || []), sync_posts: f.sync_posts ? 1 : 0,
  });

  dash.post('/channels', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const f = await form(c.req);
    const ch = channelFromForm(f);
    if (!ch.name) return back(c, '/app/community/channels', 'Name is required', 'err');
    let slug = slugify(ch.name, 40);
    if (await one(c.env, 'SELECT 1 FROM channels WHERE pub_id = ? AND slug = ?', pub.id, slug)) slug += '-' + id(4);
    const pos = (await val<number>(c.env, 'SELECT COALESCE(MAX(position),0) FROM channels WHERE pub_id = ?', pub.id)) + 1;
    const cid = id();
    if (f.is_default) await run(c.env, 'UPDATE channels SET is_default = 0 WHERE pub_id = ?', pub.id);
    await insert(c.env, 'channels', { id: cid, pub_id: pub.id, slug, ...ch, is_default: f.is_default ? 1 : 0, position: pos, created_at: now() });
    await audit(c, 'community.channel.create', cid);
    return back(c, '/app/community/channels', `#${ch.name} created`);
  });

  dash.post('/channels/:id', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const f = await form(c.req);
    const ch = channelFromForm(f);
    if (f.is_default) await run(c.env, 'UPDATE channels SET is_default = 0 WHERE pub_id = ?', pub.id);
    await run(c.env, `UPDATE channels SET name = ?, description = ?, access = ?, tier_ids = ?, sync_posts = ?, is_default = CASE WHEN ? THEN 1 ELSE is_default END WHERE id = ? AND pub_id = ?`, ch.name, ch.description, ch.access, ch.tier_ids, ch.sync_posts, f.is_default ? 1 : 0, c.req.param('id'), pub.id);
    return back(c, '/app/community/channels', 'Channel saved');
  });

  dash.post('/channels/:id/delete', requirePerm('manage'), async (c) => {
    await run(c.env, 'DELETE FROM channels WHERE id = ? AND pub_id = ? AND is_default = 0', c.req.param('id'), c.get('pub').id);
    return back(c, '/app/community/channels', 'Channel deleted');
  });

  dash.post('/channels/:id/move', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const dir = (await form(c.req)).dir === 'up' ? -1 : 1;
    const rows = await all<any>(c.env, 'SELECT id FROM channels WHERE pub_id = ? ORDER BY position, created_at', pub.id);
    const i = rows.findIndex((r) => r.id === c.req.param('id')), j = i + dir;
    if (i >= 0 && j >= 0 && j < rows.length) [rows[i], rows[j]] = [rows[j], rows[i]];
    for (let k = 0; k < rows.length; k++) await run(c.env, 'UPDATE channels SET position = ? WHERE id = ?', k, rows[k].id);
    return back(c, '/app/community/channels');
  });

  dash.get('/channels/:id', async (c) => {
    const pub = c.get('pub');
    const ch = await one<Channel>(c.env, 'SELECT * FROM channels WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!ch) return c.notFound();
    const posts = await all<any>(c.env, `SELECT * FROM community_posts WHERE channel_id = ? AND status != 'removed' ORDER BY pinned DESC, last_activity_at DESC LIMIT 100`, ch.id);
    const nameOf = await authorNames(c.env, posts, pub.id);
    return c.html(
      <Page c={c} title={`#${ch.name}`} tab="/app/community/channels" crumbs={[['/app/community/channels', 'Channels']]} actions={<OpenBtn target="#new-post">+ Post as {pub.name}</OpenBtn>}>
        <Card pad={false}>
          <Table rows={posts} rowHref={(p) => `/app/community/posts/${p.id}`} empty="No posts in this channel yet." cols={[
            { h: 'Post', r: (p) => <><a href={`/app/community/posts/${p.id}`}>{p.pinned ? '📌 ' : ''}{p.title || truncate(p.body, 70)}</a><div class="muted small">{nameOf(p).name}{nameOf(p).team ? ' (team)' : ''} · {ago(p.created_at)}</div></> },
            { h: 'Replies', class: 'right', r: (p) => num(p.reply_count) },
            { h: 'Likes', class: 'right', r: (p) => num(p.like_count) },
            { h: 'Status', r: (p) => <Status s={p.status} /> },
            { h: '', class: 'right nowrap', r: (p) => <PostActions p={p} /> },
          ]} />
        </Card>
        <Modal id="new-post" title={`New post in #${ch.name}`}>
          <form method="post" action={`/app/community/channels/${ch.id}/posts`}>
            <Field label="Title"><Input name="title" required /></Field>
            <Field label="Message"><Textarea name="body" rows={6} required /></Field>
            <Check name="pinned" label="Pin to top of channel" />
            <div class="form-actions"><Btn>Publish</Btn></div>
          </form>
        </Modal>
      </Page>,
    );
  });

  dash.post('/channels/:id/posts', async (c) => {
    const pub = c.get('pub');
    const ch = await one<Channel>(c.env, 'SELECT * FROM channels WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!ch) return c.notFound();
    const f = await form(c.req);
    const body = str(f.body, 20000);
    if (!body) return back(c, `/app/community/channels/${ch.id}`, 'Write a message', 'err');
    const pid = await createCommunityPost(c.env, pub, { channel_id: ch.id, title: str(f.title, 200), body, author_user_id: c.get('user').id, pinned: !!f.pinned });
    return back(c, `/app/community/posts/${pid}`, 'Posted');
  });

  // ── Post detail & moderation actions
  dash.get('/posts/:id', async (c) => {
    const pub = c.get('pub');
    const p = await one<any>(c.env, `SELECT p.*, ch.name AS channel FROM community_posts p JOIN channels ch ON ch.id = p.channel_id WHERE p.id = ? AND p.pub_id = ?`, c.req.param('id'), pub.id);
    if (!p) return c.notFound();
    const comments = await all<any>(c.env, 'SELECT * FROM community_comments WHERE post_id = ? ORDER BY created_at', p.id);
    const nameOf = await authorNames(c.env, [p, ...comments], pub.id);
    const children = (pid: string | null): any[] => comments.filter((x) => (x.parent_id || null) === pid);
    const Thread = ({ parent, depth }: { parent: string | null; depth: number }): any => (
      <>
        {children(parent).map((cm) => (
          <div style={`margin-left:${depth * 22}px;border-left:${depth ? '2px solid var(--border)' : '0'};padding:10px 0 10px ${depth ? 12 : 0}px`}>
            <div class="row between"><span><strong>{nameOf(cm).name}</strong>{nameOf(cm).team && <> <Badge tone="amber">team</Badge></>} <small class="muted">{ago(cm.created_at)}</small> {cm.status !== 'visible' && <Status s={cm.status} />}</span>
              <span class="nowrap">{cm.status === 'visible' ? <ActionForm action={`/app/community/comments/${cm.id}/status`} fields={{ status: 'hidden' }} label="Hide" kind="ghost" /> : <ActionForm action={`/app/community/comments/${cm.id}/status`} fields={{ status: 'visible' }} label="Restore" kind="ghost" />}<ActionForm action={`/app/community/comments/${cm.id}/status`} fields={{ status: 'removed' }} label="Remove" kind="ghost" confirm="Remove this comment?" /></span></div>
            <div style={cm.status !== 'visible' ? 'opacity:.5' : ''}>{raw(renderBody(cm.body))}</div>
            <details><summary class="muted small" style="cursor:pointer">Reply</summary><form method="post" action={`/app/community/posts/${p.id}/comments`} class="row" style="margin-top:6px"><input type="hidden" name="parent_id" value={cm.id} /><input class="input grow" name="body" required placeholder="Reply as the publication" /><Btn small>Reply</Btn></form></details>
            <Thread parent={cm.id} depth={Math.min(depth + 1, 5)} />
          </div>
        ))}
      </>
    );
    return c.html(
      <Page c={c} title={p.title || 'Post'} tab="/app/community/channels" crumbs={[['/app/community/channels', 'Channels'], [`/app/community/channels/${p.channel_id}`, `#${p.channel}`]]} actions={<PostActions p={p} />}>
        <Card>
          <div class="muted small">{nameOf(p).name}{nameOf(p).team ? ' (team)' : ''} · {ago(p.created_at)} · {p.like_count} likes · <Status s={p.status} /></div>
          <div style="margin-top:10px">{raw(renderBody(p.body))}</div>
        </Card>
        <Card title={`Comments (${comments.filter((x) => x.status === 'visible').length})`}>
          {comments.length ? <Thread parent={null} depth={0} /> : <p class="muted">No comments yet.</p>}
          <form method="post" action={`/app/community/posts/${p.id}/comments`} class="stack" style="margin-top:14px">
            <Textarea name="body" rows={3} placeholder={`Reply as ${pub.name}`} required />
            <div class="form-actions"><Btn>Comment</Btn></div>
          </form>
        </Card>
      </Page>,
    );
  });

  dash.post('/posts/:id/comments', async (c) => {
    const pub = c.get('pub');
    const p = await one<any>(c.env, 'SELECT * FROM community_posts WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!p) return c.notFound();
    const f = await form(c.req);
    const body = str(f.body, 10000);
    if (!body) return back(c, `/app/community/posts/${p.id}`, 'Write something', 'err');
    const parent = f.parent_id ? await one<any>(c.env, 'SELECT * FROM community_comments WHERE id = ? AND post_id = ?', f.parent_id, p.id) : null;
    await insert(c.env, 'community_comments', { id: id(), pub_id: pub.id, post_id: p.id, parent_id: parent?.id ?? null, author_user_id: c.get('user').id, body, status: 'visible', created_at: now() });
    await run(c.env, 'UPDATE community_posts SET reply_count = reply_count + 1, last_activity_at = ? WHERE id = ?', now(), p.id);
    // notify the member being replied to
    const targetSub = parent?.author_subscriber_id || p.author_subscriber_id;
    if (targetSub) {
      const s = await one<any>(c.env, 'SELECT email FROM subscribers WHERE id = ?', targetSub);
      if (s) await notify(c.env, pub, s.email, `${pub.name} replied to you`, `<p><strong>${esc(pub.name)}</strong> replied:</p><blockquote style="border-left:3px solid #f59e0b;margin:0;padding:4px 12px;color:#374151">${esc(truncate(body, 400))}</blockquote>`, `${siteUrl(c.env, pub)}/community/${p.channel_id}/${p.id}`);
    }
    return back(c, `/app/community/posts/${p.id}`, 'Reply posted');
  });

  dash.post('/posts/:id/:action{pin|unpin|hide|show|remove}', async (c) => {
    const pub = c.get('pub');
    const a = c.req.param('action');
    const sql = a === 'pin' ? 'pinned = 1' : a === 'unpin' ? 'pinned = 0' : a === 'hide' ? `status = 'hidden'` : a === 'show' ? `status = 'visible'` : `status = 'removed'`;
    await run(c.env, `UPDATE community_posts SET ${sql} WHERE id = ? AND pub_id = ?`, c.req.param('id'), pub.id);
    const ref = c.req.header('referer') || '/app/community';
    return back(c, ref, `Post ${a === 'pin' ? 'pinned' : a === 'unpin' ? 'unpinned' : a === 'show' ? 'restored' : a === 'hide' ? 'hidden' : 'removed'}`);
  });

  dash.post('/comments/:id/status', async (c) => {
    const status = (await form(c.req)).status;
    if (!['visible', 'hidden', 'removed'].includes(status)) return back(c, '/app/community', 'Invalid', 'err');
    await run(c.env, 'UPDATE community_comments SET status = ? WHERE id = ? AND pub_id = ?', status, c.req.param('id'), c.get('pub').id);
    return back(c, c.req.header('referer') || '/app/community', 'Comment updated');
  });

  // ── Members & invites
  dash.get('/members', async (c) => {
    const pub = c.get('pub');
    const q = str(c.req.query('q'), 100);
    const status = str(c.req.query('status'), 20) || 'active';
    const members = await all<any>(c.env, `SELECT cm.*, s.email, s.name, s.tier, s.engagement,
        (SELECT COUNT(*) FROM community_posts p WHERE p.author_subscriber_id = cm.subscriber_id AND p.pub_id = cm.pub_id) AS posts,
        (SELECT COUNT(*) FROM community_comments x WHERE x.author_subscriber_id = cm.subscriber_id AND x.pub_id = cm.pub_id) AS comments
      FROM community_members cm JOIN subscribers s ON s.id = cm.subscriber_id WHERE cm.pub_id = ? AND cm.status = ? ${q ? 'AND (s.email LIKE ? OR s.name LIKE ? OR cm.display_name LIKE ?)' : ''} ORDER BY cm.joined_at DESC LIMIT 200`,
      pub.id, status, ...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : []));
    const engaged = await all<any>(c.env, `SELECT s.id, s.email, s.name, s.engagement, s.open_count, s.click_count, s.tier FROM subscribers s WHERE s.pub_id = ? AND s.status = 'active' AND NOT EXISTS (SELECT 1 FROM community_members cm WHERE cm.pub_id = s.pub_id AND cm.subscriber_id = s.id) ORDER BY s.engagement DESC, s.open_count DESC, s.click_count DESC LIMIT 15`, pub.id);
    const segments = await all<any>(c.env, 'SELECT id, name FROM segments WHERE pub_id = ? ORDER BY name', pub.id);
    const team = await all<any>(c.env, `SELECT u.id, u.name, u.email, COALESCE((SELECT role FROM memberships m WHERE m.user_id = u.id AND m.pub_id = ?), (SELECT role FROM memberships m WHERE m.user_id = u.id AND m.pub_id = '' AND m.workspace_id = ?)) AS role FROM users u WHERE u.id IN (SELECT user_id FROM memberships WHERE workspace_id = ? AND (pub_id = '' OR pub_id = ?))`, pub.id, pub.workspace_id, pub.workspace_id, pub.id);
    const counts = await all<any>(c.env, 'SELECT status, COUNT(*) AS n FROM community_members WHERE pub_id = ? GROUP BY status', pub.id);
    const cnt = (s: string) => counts.find((x) => x.status === s)?.n || 0;
    return c.html(
      <Page c={c} title="Members" tab="/app/community/members" actions={<OpenBtn target="#invite">Invite members</OpenBtn>}>
        <div class="split">
          <div>
            <Card pad={false} title={
              <span class="row">{(['active', 'invited', 'banned'] as const).map((s) => <a href={`/app/community/members?status=${s}`} class={`btn btn-sm ${status === s ? 'btn-secondary' : 'btn-ghost'}`}>{s} ({cnt(s)})</a>)}</span>
            } actions={<form method="get" class="row"><input type="hidden" name="status" value={status} /><input class="input" name="q" value={q} placeholder="Search members" style="width:200px;height:30px" /></form>}>
              <Table rows={members} empty={status === 'active' ? 'No members yet — invite your most engaged readers.' : 'Nobody here.'} cols={[
                { h: 'Member', r: (m) => <><a href={`/app/audience/subscribers/${m.subscriber_id}`}>{m.display_name || m.name || m.email}</a><div class="muted small">{m.email}{m.discord_user_id ? ' · Discord linked' : ''}</div></> },
                { h: 'Tier', r: (m) => <Status s={m.tier} /> },
                { h: 'Role', r: (m) => can(c.get('role'), 'manage') && m.status === 'active' ? <form method="post" action={`/app/community/members/${m.subscriber_id}/role`}><Select name="role" value={m.role} options={CROLES} autosubmit class="" /></form> : m.role },
                { h: 'Activity', class: 'right', r: (m) => <span class="small">{m.posts} posts · {m.comments} comments</span> },
                { h: 'Joined', r: (m) => ago(m.joined_at) },
                { h: '', class: 'right nowrap', r: (m) => <>
                  <a class="btn btn-ghost btn-sm" href={`/app/community/messages/${m.subscriber_id}`}>Message</a>
                  {m.status === 'banned' ? <ActionForm action={`/app/community/members/${m.subscriber_id}/unban`} label="Unban" /> : <ActionForm action={`/app/community/members/${m.subscriber_id}/ban`} label="Ban" kind="danger" confirm="Ban this member? They won't be able to post, comment or message." />}
                </> },
              ]} />
            </Card>
            <Card title="Team (posting as the publication)" pad={false}>
              <Table rows={team} cols={[
                { h: 'Teammate', r: (u) => <>{u.name || u.email}<div class="muted small">{u.email}</div></> },
                { h: 'Workspace role', r: (u) => u.role },
                { h: 'Community role', r: (u) => <Badge tone="amber">{teamCommunityRole(u.role)}</Badge> },
              ]} />
              <div class="card-b"><Help>Workspace roles map to community roles: owners & admins → admin, members → manager, contributors → moderator.</Help></div>
            </Card>
          </div>
          <Card title="Invite your most engaged readers first">
            {engaged.length ? (
              <form method="post" action="/app/community/invite">
                <input type="hidden" name="mode" value="pick" />
                <label class="check"><input type="checkbox" data-check-all="pick[]" checked /> <span>Select all</span></label>
                <ul class="list-plain">{engaged.map((s) => <li><label class="check" style="margin:0"><input type="checkbox" name="pick[]" value={s.id} checked /><span>{s.name || s.email}<small class="field-h">Engagement {s.engagement} · {s.open_count} opens · {s.click_count} clicks{s.tier === 'premium' ? ' · premium' : ''}</small></span></label></li>)}</ul>
                <div class="form-actions"><Btn>Invite selected</Btn></div>
              </form>
            ) : <p class="muted">Everyone engaged is already a member. 🎉</p>}
          </Card>
        </div>
        <Modal id="invite" title="Invite members">
          <form method="post" action="/app/community/invite" class="stack">
            <Field label="Who to invite">
              <Select name="mode" value="emails" options={[['emails', 'Specific emails'], ['segment', 'A segment'], ['all', 'All active subscribers']]} />
            </Field>
            <Field label="Emails (one per line, must be subscribers)"><Textarea name="emails" rows={4} placeholder={'reader@example.com'} /></Field>
            <Field label="Segment"><Select name="segment_id" options={[['', '—'], ...segments.map((s) => [s.id, s.name] as [string, string])]} /></Field>
            <Help>Invites are emailed with your community from-name. Invited readers join with one click from the community page.</Help>
            <div class="form-actions"><Btn>Send invites</Btn></div>
          </form>
        </Modal>
      </Page>,
    );
  });

  dash.post('/invite', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const f = await form(c.req);
    let subs: Array<{ id: string; email: string }> = [];
    let missing = 0;
    if (f.mode === 'pick') {
      const ids: string[] = (f.pick || []).slice(0, 500);
      if (ids.length) subs = await all<any>(c.env, `SELECT id, email FROM subscribers WHERE pub_id = ? AND status = 'active' AND id IN (${ids.map(() => '?').join(',')})`, pub.id, ...ids);
    } else if (f.mode === 'segment' && f.segment_id) {
      subs = await listMatching(c.env, pub.id, { op: 'and', rules: [{ field: 'segment', cmp: 'in', value: f.segment_id }] }, { limit: 1000 });
    } else if (f.mode === 'all') {
      subs = await all<any>(c.env, `SELECT id, email FROM subscribers WHERE pub_id = ? AND status = 'active' LIMIT 1000`, pub.id);
    } else {
      const emails = String(f.emails || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')).slice(0, 500);
      for (const e of emails) {
        const s = await one<any>(c.env, `SELECT id, email FROM subscribers WHERE pub_id = ? AND email = ? AND status = 'active'`, pub.id, e);
        if (s) subs.push(s);
        else {
          missing++;
          await run(c.env, `INSERT INTO community_invites (id, pub_id, email, invited_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(pub_id, email) DO UPDATE SET created_at = excluded.created_at`, id(), pub.id, e, c.get('user').id, now());
          await notify(c.env, pub, e, `You're invited to the ${pub.name} community`, `<p>Subscribe to <strong>${esc(pub.name)}</strong> and join the community discussions.</p>`, `${siteUrl(c.env, pub)}/community?invite=1`);
        }
      }
    }
    const n = await inviteSubscribers(c, subs);
    return back(c, '/app/community/members?status=invited', `Sent ${n + missing} invite${n + missing === 1 ? '' : 's'}${missing ? ` (${missing} not yet subscribed — they'll subscribe first)` : ''}`);
  });

  dash.post('/members/:sid/role', requirePerm('manage'), async (c) => {
    const role = (await form(c.req)).role;
    if (!CROLES.includes(role)) return back(c, '/app/community/members', 'Invalid role', 'err');
    await run(c.env, 'UPDATE community_members SET role = ? WHERE pub_id = ? AND subscriber_id = ?', role, c.get('pub').id, c.req.param('sid'));
    return back(c, '/app/community/members', `Role set to ${role}`);
  });

  dash.post('/members/:sid/:action{ban|unban}', async (c) => {
    const banned = c.req.param('action') === 'ban';
    await run(c.env, `UPDATE community_members SET status = ? WHERE pub_id = ? AND subscriber_id = ?`, banned ? 'banned' : 'active', c.get('pub').id, c.req.param('sid'));
    await audit(c, `community.member.${c.req.param('action')}`, c.req.param('sid'));
    return back(c, c.req.header('referer') || '/app/community/members', banned ? 'Member banned' : 'Member unbanned');
  });

  // ── Moderation queue
  dash.get('/moderation', async (c) => {
    const pub = c.get('pub');
    const status = str(c.req.query('status'), 20) || 'open';
    const reports = await all<any>(c.env, `SELECT r.*, s.email AS reporter FROM community_reports r LEFT JOIN subscribers s ON s.id = r.reporter_subscriber_id WHERE r.pub_id = ? AND r.status = ? ORDER BY r.created_at DESC LIMIT 100`, pub.id, status);
    const items = await Promise.all(reports.map(async (r) => {
      const t = r.target_kind === 'post' ? await one<any>(c.env, 'SELECT id, title, body, status, author_subscriber_id, author_user_id, id AS post_id, channel_id FROM community_posts WHERE id = ?', r.target_id)
        : r.target_kind === 'comment' ? await one<any>(c.env, 'SELECT id, body, status, author_subscriber_id, author_user_id, post_id FROM community_comments WHERE id = ?', r.target_id)
        : await one<any>(c.env, `SELECT id, body, subscriber_id AS author_subscriber_id, NULL AS author_user_id, 'visible' AS status FROM direct_messages WHERE id = ?`, r.target_id);
      return { ...r, t };
    }));
    const nameOf = await authorNames(c.env, items.map((i) => i.t || {}), pub.id);
    return c.html(
      <Page c={c} title="Moderation" tab="/app/community/moderation">
        <div class="row" style="margin-bottom:12px">{(['open', 'actioned', 'dismissed'] as const).map((s) => <a href={`/app/community/moderation?status=${s}`} class={`btn btn-sm ${status === s ? 'btn-secondary' : 'btn-ghost'}`}>{s}</a>)}</div>
        {!items.length ? <Card><Empty title="Queue is clear" body="Reported posts, comments and messages show up here." icon="✓" /></Card> : items.map((r) => (
          <Card title={<>{r.target_kind} reported {ago(r.created_at)} <small class="muted">by {r.reporter || 'a member'}</small></>} actions={<Status s={r.status} />}>
            {r.reason && <p><strong>Reason:</strong> {r.reason}</p>}
            {r.t ? <>
              <div class="muted small">By {nameOf(r.t).name} · currently <Status s={r.t.status} /></div>
              <blockquote style="border-left:3px solid var(--border);margin:8px 0;padding:4px 12px">{r.t.title && <strong>{r.t.title}<br /></strong>}{truncate(r.t.body || '', 600)}</blockquote>
              {r.status === 'open' && (
                <div class="row">
                  {r.target_kind !== 'dm' && <ActionForm action={`/app/community/moderation/${r.id}`} fields={{ action: 'hide' }} label="Hide" />}
                  {r.target_kind !== 'dm' && <ActionForm action={`/app/community/moderation/${r.id}`} fields={{ action: 'remove' }} label="Remove" kind="danger" />}
                  {r.t.author_subscriber_id && <ActionForm action={`/app/community/moderation/${r.id}`} fields={{ action: 'ban' }} label="Remove & ban author" kind="danger" confirm="Remove the content and ban its author?" />}
                  <ActionForm action={`/app/community/moderation/${r.id}`} fields={{ action: 'dismiss' }} label="Dismiss" kind="ghost" />
                  {r.target_kind === 'comment' && <a class="btn btn-ghost btn-sm" href={`/app/community/posts/${r.t.post_id}`}>View thread</a>}
                  {r.target_kind === 'post' && <a class="btn btn-ghost btn-sm" href={`/app/community/posts/${r.t.id}`}>View post</a>}
                </div>
              )}
            </> : <p class="muted">The reported content no longer exists.</p>}
          </Card>
        ))}
      </Page>,
    );
  });

  dash.post('/moderation/:id', async (c) => {
    const pub = c.get('pub');
    const r = await one<any>(c.env, 'SELECT * FROM community_reports WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!r) return c.notFound();
    const action = (await form(c.req)).action;
    const table = r.target_kind === 'post' ? 'community_posts' : r.target_kind === 'comment' ? 'community_comments' : null;
    if (action === 'dismiss') {
      await run(c.env, `UPDATE community_reports SET status = 'dismissed' WHERE id = ?`, r.id);
      return back(c, '/app/community/moderation', 'Report dismissed');
    }
    if (table && (action === 'hide' || action === 'remove' || action === 'ban')) await run(c.env, `UPDATE ${table} SET status = ? WHERE id = ? AND pub_id = ?`, action === 'hide' ? 'hidden' : 'removed', r.target_id, pub.id);
    if (action === 'ban') {
      const author = table ? await one<any>(c.env, `SELECT author_subscriber_id AS a FROM ${table} WHERE id = ?`, r.target_id) : await one<any>(c.env, 'SELECT subscriber_id AS a FROM direct_messages WHERE id = ?', r.target_id);
      if (author?.a) await run(c.env, `UPDATE community_members SET status = 'banned' WHERE pub_id = ? AND subscriber_id = ?`, pub.id, author.a);
    }
    await run(c.env, `UPDATE community_reports SET status = 'actioned' WHERE pub_id = ? AND target_id = ? AND status = 'open'`, pub.id, r.target_id);
    await audit(c, 'community.moderate', r.target_id, { action });
    return back(c, '/app/community/moderation', 'Done');
  });

  // ── Direct messages (inbox)
  dash.get('/messages', async (c) => {
    const pub = c.get('pub');
    const convos = await all<any>(c.env, `SELECT d.subscriber_id, MAX(d.created_at) AS last_at, SUM(CASE WHEN d.from_side = 'member' AND d.read_at IS NULL THEN 1 ELSE 0 END) AS unread,
        (SELECT body FROM direct_messages x WHERE x.pub_id = d.pub_id AND x.subscriber_id = d.subscriber_id ORDER BY created_at DESC LIMIT 1) AS last_body, s.email, s.name
      FROM direct_messages d JOIN subscribers s ON s.id = d.subscriber_id WHERE d.pub_id = ? GROUP BY d.subscriber_id ORDER BY last_at DESC LIMIT 200`, pub.id);
    return c.html(
      <Page c={c} title="Messages" tab="/app/community/messages">
        <Card pad={false}>
          <Table rows={convos} rowHref={(v) => `/app/community/messages/${v.subscriber_id}`} empty={<Empty title="No messages yet" body="Members can message the team from the community. You can start a conversation from the Members tab." />} cols={[
            { h: 'Member', r: (v) => <><a href={`/app/community/messages/${v.subscriber_id}`}>{v.name || v.email}</a>{v.unread ? <> <Badge tone="amber">{v.unread} new</Badge></> : null}</> },
            { h: 'Last message', r: (v) => <span class="muted">{truncate(v.last_body || '', 80)}</span> },
            { h: 'When', r: (v) => ago(v.last_at) },
          ]} />
        </Card>
      </Page>,
    );
  });

  dash.get('/messages/:sid', async (c) => {
    const pub = c.get('pub');
    const sub = await one<any>(c.env, 'SELECT id, email, name FROM subscribers WHERE id = ? AND pub_id = ?', c.req.param('sid'), pub.id);
    if (!sub) return c.notFound();
    await run(c.env, `UPDATE direct_messages SET read_at = ? WHERE pub_id = ? AND subscriber_id = ? AND from_side = 'member' AND read_at IS NULL`, now(), pub.id, sub.id);
    const msgs = await all<any>(c.env, `SELECT d.*, u.name AS user_name FROM direct_messages d LEFT JOIN users u ON u.id = d.user_id WHERE d.pub_id = ? AND d.subscriber_id = ? ORDER BY d.created_at LIMIT 500`, pub.id, sub.id);
    return c.html(
      <Page c={c} title={sub.name || sub.email} tab="/app/community/messages" crumbs={[['/app/community/messages', 'Messages']]}>
        <Card>
          <div class="stack" style="max-height:60vh;overflow-y:auto">
            {msgs.length ? msgs.map((m) => (
              <div style={`max-width:75%;padding:10px 12px;border-radius:12px;${m.from_side === 'publication' ? 'margin-left:auto;background:#fffbeb;border:1px solid #fde68a' : 'background:var(--surface-2)'}`}>
                <div class="muted small">{m.from_side === 'publication' ? m.user_name || pub.name : sub.name || sub.email} · {ago(m.created_at)}</div>
                {raw(renderBody(m.body))}
              </div>
            )) : <p class="muted">Start the conversation.</p>}
          </div>
          <form method="post" action={`/app/community/messages/${sub.id}`} class="stack" style="margin-top:14px">
            <Textarea name="body" rows={3} required placeholder={`Message ${sub.name || sub.email}`} />
            <div class="form-actions"><Btn>Send</Btn></div>
          </form>
        </Card>
      </Page>,
    );
  });

  dash.post('/messages/:sid', async (c) => {
    const pub = c.get('pub');
    const sub = await one<any>(c.env, 'SELECT id, email FROM subscribers WHERE id = ? AND pub_id = ?', c.req.param('sid'), pub.id);
    if (!sub) return c.notFound();
    const body = str((await form(c.req)).body, 5000);
    if (!body) return back(c, `/app/community/messages/${sub.id}`, 'Write a message', 'err');
    await insert(c.env, 'direct_messages', { id: id(), pub_id: pub.id, subscriber_id: sub.id, from_side: 'publication', user_id: c.get('user').id, body, created_at: now() });
    await notify(c.env, pub, sub.email, `New message from ${pub.name}`, `<p>${esc(truncate(body, 600)).replace(/\n/g, '<br>')}</p>`, `${siteUrl(c.env, pub)}/community/messages`);
    return back(c, `/app/community/messages/${sub.id}`, 'Message sent');
  });

  // ── Settings: notifications + Discord
  dash.get('/settings', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const cfg = parseJSON<any>(pub.settings, {});
    const d = cfg.discord || {};
    const tiers = await all<any>(c.env, `SELECT id, name FROM tiers WHERE pub_id = ? AND status != 'archived' ORDER BY position`, pub.id);
    const linked = await linkedMembers(c.env, pub.id);
    const roles = d.tier_roles || {};
    return c.html(
      <Page c={c} title="Community settings" tab="/app/community/settings">
        <Grid cols={2}>
          <Card title="Notifications">
            <form method="post" action="/app/community/settings">
              <input type="hidden" name="section" value="notify" />
              <Field label="Notification from-name" hint="Used for invites, replies and DM emails."><Input name="community_from_name" value={cfg.community_from_name || `${pub.name} Community`} /></Field>
              <div class="form-actions"><Btn>Save</Btn></div>
            </form>
          </Card>
          <Card title="Discord integration" actions={discordCfg(pub) ? <Badge tone="green">configured</Badge> : <Badge>off</Badge>}>
            <form method="post" action="/app/community/settings">
              <input type="hidden" name="section" value="discord" />
              <Help>Create a bot at discord.com/developers, enable the Server Members intent, invite it with “Manage Roles”, and place its role above the tier roles. Members link their Discord account at <code>/community/discord</code>; roles then follow their subscription tier.</Help>
              <Field label="Bot token"><Input name="bot_token" type="password" value={d.bot_token ? '••••••••' : ''} placeholder="Bot token" /></Field>
              <Field label="Server (guild) ID"><Input name="guild_id" value={d.guild_id || ''} /></Field>
              <Field label="Role for all subscribers (optional)"><Input name="role_free" value={roles.free || ''} placeholder="Role ID" /></Field>
              <Field label="Role for any premium subscriber"><Input name="role_premium" value={roles.premium || ''} placeholder="Role ID" /></Field>
              {tiers.map((t) => <Field label={`Role for tier “${t.name}”`}><Input name={`role_${t.id}`} value={roles[t.id] || ''} placeholder="Role ID" /></Field>)}
              <div class="form-actions"><Btn>Save & test connection</Btn></div>
            </form>
            {linked.length > 0 && <><hr /><p class="small">{linked.length} member{linked.length === 1 ? '' : 's'} linked.</p><ActionForm action="/app/community/settings/discord-sync" label="Re-sync all roles" /></>}
          </Card>
        </Grid>
      </Page>,
    );
  });

  dash.post('/settings', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const f = await form(c.req);
    if (f.section === 'notify') {
      await patchSettings(c.env, pub, { community_from_name: str(f.community_from_name, 80) || undefined });
      return back(c, '/app/community/settings', 'Saved');
    }
    const cur = parseJSON<any>(pub.settings, {}).discord || {};
    const tier_roles: Record<string, string> = {};
    for (const [k, v] of Object.entries(f)) if (k.startsWith('role_') && str(v)) tier_roles[k.slice(5)] = str(v, 40);
    const token = str(f.bot_token, 200);
    const discord = { bot_token: token && !token.startsWith('••') ? token : cur.bot_token, guild_id: str(f.guild_id, 40), tier_roles };
    await patchSettings(c.env, pub, { discord: discord.bot_token || discord.guild_id ? discord : undefined });
    await audit(c, 'community.discord.update');
    if (discord.bot_token && discord.guild_id) {
      const t = await testDiscord(discord);
      return back(c, '/app/community/settings', `Discord settings saved. ${t.message}`, t.ok ? 'ok' : 'err');
    }
    return back(c, '/app/community/settings', 'Discord settings saved');
  });

  dash.post('/settings/discord-sync', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const linked = await linkedMembers(c.env, pub.id);
    let errors = 0;
    for (const m of linked) { const r = await syncDiscordRoles(c.env, pub, m.subscriber_id); if (!r.startsWith('Synced')) errors++; }
    return back(c, '/app/community/settings', `Synced ${linked.length - errors} member(s)${errors ? `, ${errors} failed (see error log)` : ''}`, errors ? 'err' : 'ok');
  });
}

function PostActions({ p }: { p: any }) {
  return (
    <span class="nowrap">
      {p.pinned ? <ActionForm action={`/app/community/posts/${p.id}/unpin`} label="Unpin" kind="ghost" /> : <ActionForm action={`/app/community/posts/${p.id}/pin`} label="Pin" kind="ghost" />}
      {p.status === 'visible' ? <ActionForm action={`/app/community/posts/${p.id}/hide`} label="Hide" kind="ghost" /> : <ActionForm action={`/app/community/posts/${p.id}/show`} label="Restore" kind="ghost" />}
      <ActionForm action={`/app/community/posts/${p.id}/remove`} label="Remove" kind="danger" confirm="Remove this post?" />
    </span>
  );
}

function ChannelFields({ ch, tiers }: { ch?: any; tiers: any[] }) {
  const sel = parseJSON<string[]>(ch?.tier_ids, []);
  return (
    <>
      <Field label="Name"><Input name="name" value={ch?.name} required placeholder="introductions" /></Field>
      <Field label="Description"><Input name="description" value={ch?.description} /></Field>
      <Field label="Who can access"><Select name="access" value={ch?.access || 'free'} options={[['free', 'All subscribers (free)'], ['premium', 'Any paid subscriber'], ['tiers', 'Specific paid tiers']]} /></Field>
      {tiers.length > 0 && <Field label="Tiers (for “specific paid tiers”)">{tiers.map((t) => <Check name="tier_ids[]" value={t.id} checked={sel.includes(t.id)} label={t.name} />)}</Field>}
      <Toggle name="sync_posts" checked={!!ch?.sync_posts} label="Sync newsletter posts" hint="New published posts are automatically shared here for discussion." />
      <Toggle name="is_default" checked={!!ch?.is_default} label="Default channel" hint="Where new members land." />
    </>
  );
}
