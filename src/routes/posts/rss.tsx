/** @jsxImportSource hono/jsx */
// RSS-to-send: turn any RSS/Atom feed into newsletter posts (one per item, or a scheduled digest).
import { Hono } from 'hono';
import type { AppEnv, Ctx } from '../../types';
import { all, one, run, insert } from '../../lib/db';
import { requirePerm, audit, can } from '../../lib/auth';
import { kick } from '../../lib/jobs';
import { processFeed, fetchFeed, nextDigestAt } from '../../lib/rss';
import { DashLayout } from '../../ui/layout';
import { Card, Table, Status, Badge, Btn, LinkBtn, ActionForm, Field, Input, Textarea, Select, Toggle, Empty, Help, back } from '../../ui/components';
import { id, now, form, str, int, bool, ago, fmtDateTime, parseJSON } from '../../lib/util';

const app = new Hono<AppEnv>();
app.use('/rss', requirePerm('manage'));
app.use('/rss/*', requirePerm('manage'));

const WEEKDAYS: Array<[string, string]> = [['', 'Every N days'], ['1', 'Mondays'], ['2', 'Tuesdays'], ['3', 'Wednesdays'], ['4', 'Thursdays'], ['5', 'Fridays'], ['6', 'Saturdays'], ['0', 'Sundays']];

async function loadFeed(c: Ctx, fid: string) {
  return one<any>(c.env, 'SELECT * FROM rss_feeds WHERE id = ? AND pub_id = ?', fid, c.get('pub').id);
}

async function FeedForm(c: Ctx, f: any | null) {
  const pub = c.get('pub');
  const templates = await all<any>(c.env, `SELECT id, name FROM templates WHERE (pub_id IS NULL OR pub_id = ?) AND kind = 'post' ORDER BY pub_id IS NULL, name`, pub.id);
  const segments = await all<any>(c.env, 'SELECT id, name FROM segments WHERE pub_id = ? ORDER BY name', pub.id);
  const segIds = parseJSON<string[]>(f?.segment_ids, []);
  const exIds = parseJSON<string[]>(f?.exclude_segment_ids, []);
  const canSend = can(c.get('role'), 'publish');
  return (
    <form method="post" action={f ? `/app/posts/rss/${f.id}` : '/app/posts/rss'} class="stack">
      <Card title="Feed">
        <Field label="Name"><Input name="name" value={f?.name} required placeholder="Company blog" /></Field>
        <Field label="Feed URL" hint="RSS 2.0 or Atom. We check it every 15 minutes."><Input name="url" type="url" value={f?.url} required placeholder="https://example.com/feed.xml" /></Field>
        {!f && <Toggle name="send_latest" label="Also use the most recent item right away" hint="Otherwise only items published after you add the feed are used." />}
      </Card>
      <Card title="What to create">
        <Field label="Mode">
          <Select name="mode" value={f?.mode || 'each'} options={[['each', 'One post for each new item'], ['digest', 'A digest of new items on a schedule']]} />
        </Field>
        <div class="grid g3">
          <Field label="Digest day" hint="Digest mode only"><Select name="digest_weekday" value={f?.digest_weekday == null ? '' : String(f.digest_weekday)} options={WEEKDAYS} /></Field>
          <Field label="…or every N days"><Input name="digest_every_days" type="number" min={1} max={60} value={f?.digest_every_days ?? 7} /></Field>
          <Field label="At (UTC)"><Input name="digest_time" type="time" value={f?.digest_time || '09:00'} /></Field>
        </div>
        <Field label="Max items per digest"><Input name="max_items" type="number" min={1} max={50} value={f?.max_items ?? 10} /></Field>
        <Field label="Subject" hint="Merge tags: {{item.title}} (first item), {{feed.title}}, {{date}}, {{count}}"><Input name="subject_template" value={f?.subject_template ?? '{{item.title}}'} /></Field>
        <Field label="Intro text (optional)" hint="Shown above the items. Same merge tags."><Textarea name="intro" value={f?.intro} rows={3} /></Field>
        <Field label="Template style"><Select name="template_id" value={f?.template_id || ''} options={[['', 'Publication default'], ...templates.map((t) => [t.id, t.name] as [string, string])]} /></Field>
      </Card>
      <Card title="Audience & delivery">
        <Field label="Audience"><Select name="audience" value={f?.audience || 'all'} options={[['all', 'All subscribers'], ['free', 'Free subscribers'], ['premium', 'Premium subscribers']]} /></Field>
        <div class="grid g2">
          <label class="field"><span class="field-l">Send to segments</span><select class="input" name="segment_ids[]" multiple size={Math.min(6, Math.max(3, segments.length))}>{segments.map((s) => <option value={s.id} selected={segIds.includes(s.id)}>{s.name}</option>)}</select><small class="field-h">Empty = everyone in the audience.</small></label>
          <label class="field"><span class="field-l">Exclude segments</span><select class="input" name="exclude_segment_ids[]" multiple size={Math.min(6, Math.max(3, segments.length))}>{segments.map((s) => <option value={s.id} selected={exIds.includes(s.id)}>{s.name}</option>)}</select></label>
        </div>
        <Field label="When a post is created">
          <Select name="action" value={f?.action || 'draft'} options={canSend ? [['draft', 'Save it as a draft for review'], ['send', 'Publish and send it automatically']] : [['draft', 'Save it as a draft for review']]} />
        </Field>
        <Toggle name="active" checked={f ? !!f.active : true} label="Active" hint="Paused feeds are not checked." />
      </Card>
      <div class="form-actions"><LinkBtn href="/app/posts/rss" kind="ghost">Cancel</LinkBtn><Btn>{f ? 'Save feed' : 'Add feed'}</Btn></div>
    </form>
  );
}

function readForm(f: Record<string, any>, canSend: boolean) {
  const wd = str(f.digest_weekday);
  return {
    name: str(f.name, 120) || 'RSS feed',
    url: str(f.url, 1000),
    mode: f.mode === 'digest' ? 'digest' : 'each',
    digest_weekday: wd === '' ? null : Math.min(6, Math.max(0, int(wd))),
    digest_every_days: Math.min(60, Math.max(1, int(f.digest_every_days, 7))),
    digest_time: /^\d{2}:\d{2}$/.test(str(f.digest_time)) ? str(f.digest_time) : '09:00',
    max_items: Math.min(50, Math.max(1, int(f.max_items, 10))),
    subject_template: str(f.subject_template, 200) || '{{item.title}}',
    intro: str(f.intro, 2000),
    template_id: str(f.template_id) || null,
    audience: ['all', 'free', 'premium'].includes(f.audience) ? f.audience : 'all',
    segment_ids: JSON.stringify((f.segment_ids || []).filter(Boolean).slice(0, 20)),
    exclude_segment_ids: JSON.stringify((f.exclude_segment_ids || []).filter(Boolean).slice(0, 20)),
    action: f.action === 'send' && canSend ? 'send' : 'draft',
    active: bool(f.active) ? 1 : 0,
  };
}

app.get('/rss', async (c) => {
  const pub = c.get('pub');
  const feeds = await all<any>(c.env, `SELECT f.*, (SELECT COUNT(DISTINCT post_id) FROM rss_items i WHERE i.feed_id = f.id AND i.post_id IS NOT NULL) AS posts FROM rss_feeds f WHERE f.pub_id = ? ORDER BY f.created_at DESC`, pub.id);
  return c.html(
    <DashLayout c={c} title="RSS to send" section="posts" sub="rss" actions={<LinkBtn href="/app/posts/rss/new" kind="primary">+ Add feed</LinkBtn>}>
      <Help>Automatically turn a blog, YouTube channel, podcast or any RSS/Atom feed into newsletter issues — one post per new item, or a weekly digest.</Help>
      <Card pad={false}>
        <Table<any> rows={feeds} rowHref={(f) => `/app/posts/rss/${f.id}`}
          empty={<Empty icon="⟳" title="No feeds yet" body="Add a feed and new items become drafts or sends automatically." action={<LinkBtn href="/app/posts/rss/new" kind="primary">Add a feed</LinkBtn>} />}
          cols={[
            { h: 'Feed', r: (f) => <><a href={`/app/posts/rss/${f.id}`}>{f.name}</a><div class="small muted truncate">{f.url}</div></> },
            { h: 'Mode', r: (f) => f.mode === 'digest' ? <Badge tone="purple">Digest</Badge> : <Badge>Each item</Badge> },
            { h: 'Delivery', r: (f) => f.action === 'send' ? <Badge tone="green">Auto-send</Badge> : <Badge tone="blue">Draft</Badge> },
            { h: 'Posts', r: (f) => f.posts },
            { h: 'Last checked', r: (f) => f.last_error ? <span class="muted" title={f.last_error}>⚠ {ago(f.last_checked_at)}</span> : ago(f.last_checked_at) },
            { h: 'Status', r: (f) => <Status s={f.active ? 'active' : 'paused'} /> },
          ]} />
      </Card>
    </DashLayout>,
  );
});

app.get('/rss/new', async (c) => c.html(<DashLayout c={c} title="Add RSS feed" section="posts" sub="rss" crumbs={[['/app/posts/rss', 'RSS to send']]}>{await FeedForm(c, null)}</DashLayout>));

app.post('/rss', async (c) => {
  const f = await form(c.req);
  const data = readForm(f, can(c.get('role'), 'publish'));
  try { await fetchFeed(data.url); } catch (e: any) { return back(c, '/app/posts/rss/new', `Could not read that feed: ${e.message}`, 'err'); }
  const fid = id();
  await insert(c.env, 'rss_feeds', { id: fid, pub_id: c.get('pub').id, ...data, created_by: c.get('user').id, created_at: now() });
  await audit(c, 'rss.created', data.url);
  const res = await processFeed(c.env, fid, { sendLatest: bool(f.send_latest) });
  kick(c.env, c.executionCtx);
  return back(c, `/app/posts/rss/${fid}`, `Feed added — ${res.fetched} items found${res.posts.length ? `, ${res.posts.length} post created` : ''}. New items will be picked up automatically.`);
});

app.get('/rss/:id', async (c) => {
  const feed = await loadFeed(c, c.req.param('id'));
  if (!feed) return back(c, '/app/posts/rss', 'Feed not found', 'err');
  const posts = await all<any>(c.env, `SELECT p.id, p.title, p.status, p.created_at, COUNT(i.guid) AS items FROM rss_items i JOIN posts p ON p.id = i.post_id WHERE i.feed_id = ? GROUP BY p.id ORDER BY p.created_at DESC LIMIT 50`, feed.id);
  const items = await all<any>(c.env, `SELECT * FROM rss_items WHERE feed_id = ? ORDER BY COALESCE(published_at, seen_at) DESC LIMIT 30`, feed.id);
  const next = feed.mode === 'digest' ? nextDigestAt(feed, feed.last_sent_at || feed.created_at) : null;
  return c.html(
    <DashLayout c={c} title={feed.name} section="posts" sub="rss" crumbs={[['/app/posts/rss', 'RSS to send']]}
      actions={<>
        <ActionForm action={`/app/posts/rss/${feed.id}/check`} label="Check now" kind="primary" small={false} />
        <ActionForm action={`/app/posts/rss/${feed.id}/toggle`} label={feed.active ? 'Pause' : 'Resume'} small={false} />
        <ActionForm action={`/app/posts/rss/${feed.id}/delete`} label="Delete" kind="danger" confirm="Delete this feed? Posts already created are kept." small={false} />
      </>}>
      {feed.last_error && <div class="callout danger">Last check failed: {feed.last_error}</div>}
      <div class="callout">
        <strong>{feed.feed_title || feed.name}</strong> · {feed.mode === 'digest' ? `Digest of up to ${feed.max_items} items${next ? ` · next ${next <= now() ? 'on the next check' : fmtDateTime(next)}` : ''}` : 'One post per new item'} · {feed.action === 'send' ? 'sent automatically' : 'saved as drafts'} · last checked {ago(feed.last_checked_at)}
      </div>
      <Card title="Posts created from this feed" pad={false}>
        <Table<any> rows={posts} empty="No posts yet — they appear here as new items are published."
          cols={[
            { h: 'Post', r: (p) => <a href={p.status === 'draft' ? `/app/posts/${p.id}/edit` : `/app/posts/${p.id}`}>{p.title || '(untitled)'}</a> },
            { h: 'Items', r: (p) => p.items },
            { h: 'Status', r: (p) => <Status s={p.status} /> },
            { h: 'Created', r: (p) => ago(p.created_at) },
          ]} />
      </Card>
      <Card title="Recent feed items" pad={false}>
        <Table<any> rows={items} empty="No items seen yet."
          cols={[
            { h: 'Item', r: (i) => i.link ? <a href={i.link} target="_blank" rel="noopener">{i.title}</a> : i.title },
            { h: 'Published', r: (i) => i.published_at ? ago(i.published_at) : '—' },
            { h: 'Status', r: (i) => i.status === 'baseline' ? <Badge>Existing when added</Badge> : i.status === 'pending' ? <Badge tone="amber">Waiting</Badge> : <Badge tone="green">Used</Badge> },
          ]} />
      </Card>
      <h3>Settings</h3>
      {await FeedForm(c, feed)}
    </DashLayout>,
  );
});

app.post('/rss/:id', async (c) => {
  const feed = await loadFeed(c, c.req.param('id'));
  if (!feed) return back(c, '/app/posts/rss', 'Feed not found', 'err');
  const data = readForm(await form(c.req), can(c.get('role'), 'publish'));
  if (data.url !== feed.url) {
    try { await fetchFeed(data.url); } catch (e: any) { return back(c, `/app/posts/rss/${feed.id}`, `Could not read that feed: ${e.message}`, 'err'); }
  }
  const cols = Object.keys(data);
  await run(c.env, `UPDATE rss_feeds SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND pub_id = ?`, ...cols.map((k) => (data as any)[k]), feed.id, c.get('pub').id);
  await audit(c, 'rss.updated', feed.id);
  return back(c, `/app/posts/rss/${feed.id}`, 'Feed saved');
});

app.post('/rss/:id/check', async (c) => {
  const feed = await loadFeed(c, c.req.param('id'));
  if (!feed) return back(c, '/app/posts/rss', 'Feed not found', 'err');
  const res = await processFeed(c.env, feed.id, { force: feed.mode === 'digest' });
  kick(c.env, c.executionCtx);
  if (res.error) return back(c, `/app/posts/rss/${feed.id}`, `Check failed: ${res.error}`, 'err');
  return back(c, `/app/posts/rss/${feed.id}`, res.posts.length ? `Created ${res.posts.length} post${res.posts.length === 1 ? '' : 's'}: ${res.posts.map((p) => p.title).join(', ')}` : `Checked ${res.fetched} items — nothing new to send.`);
});

app.post('/rss/:id/toggle', async (c) => {
  await run(c.env, 'UPDATE rss_feeds SET active = 1 - active WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
  return back(c, `/app/posts/rss/${c.req.param('id')}`, 'Feed updated');
});

app.post('/rss/:id/delete', async (c) => {
  await run(c.env, 'DELETE FROM rss_feeds WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
  await audit(c, 'rss.deleted', c.req.param('id'));
  return back(c, '/app/posts/rss', 'Feed deleted');
});

export default app;
