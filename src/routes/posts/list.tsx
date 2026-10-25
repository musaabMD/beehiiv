/** @jsxImportSource hono/jsx */
import { Hono } from 'hono';
import type { AppEnv, Post } from '../../types';
import { all, one, run } from '../../lib/db';
import { can, audit } from '../../lib/auth';
import { DashLayout } from '../../ui/layout';
import { Card, Table, Status, Badge, Tabs, LinkBtn, Btn, Empty, Select, Input, back, Pager } from '../../ui/components';
import { form, fmtDate, num, pct, parseJSON, qs, str, esc } from '../../lib/util';
import { siteUrl } from '../../lib/pub';
import { newPost, uniqueSlug } from './shared';

const app = new Hono<AppEnv>();
const PAGE = 30;

app.get('/', async (c) => {
  const pub = c.get('pub');
  const role = c.get('role');
  const contributor = !can(role, 'publish');
  const status = contributor ? 'draft' : c.req.query('status') || 'all';
  const q = c.req.query('q') || '';
  const tag = c.req.query('tag') || '';
  const author = c.req.query('author') || '';
  const page = Math.max(1, Number(c.req.query('page') || 1));
  const where: string[] = ['p.pub_id = ?'];
  const params: unknown[] = [pub.id];
  if (status !== 'all') { where.push('p.status = ?'); params.push(status); }
  else where.push(`p.status != 'archived'`);
  if (q) { where.push('(p.title LIKE ? OR p.subtitle LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (tag) { where.push('EXISTS (SELECT 1 FROM post_tags pt WHERE pt.post_id = p.id AND pt.tag_id = ?)'); params.push(tag); }
  if (author) { where.push('EXISTS (SELECT 1 FROM post_authors pa WHERE pa.post_id = p.id AND pa.user_id = ?)'); params.push(author); }
  if (contributor) { where.push('EXISTS (SELECT 1 FROM post_authors pa WHERE pa.post_id = p.id AND pa.user_id = ?)'); params.push(c.get('user').id); }
  const rows = await all<Post & { recipients: number; opens: number; clicks: number; authors: string }>(
    c.env,
    `SELECT p.*,
       (SELECT COUNT(DISTINCT d.subscriber_id) FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = p.id AND d.status IN ('sent','deferred')) AS recipients,
       (SELECT COUNT(DISTINCT d.subscriber_id) FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = p.id AND d.opened_at IS NOT NULL) AS opens,
       (SELECT COUNT(DISTINCT d.subscriber_id) FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = p.id AND d.clicked_at IS NOT NULL) AS clicks,
       (SELECT group_concat(u.name, ', ') FROM post_authors pa JOIN users u ON u.id = pa.user_id WHERE pa.post_id = p.id) AS authors
     FROM posts p WHERE ${where.join(' AND ')}
     ORDER BY COALESCE(p.published_at, p.scheduled_at, p.updated_at) DESC LIMIT ? OFFSET ?`,
    ...params, PAGE + 1, (page - 1) * PAGE,
  );
  const more = rows.length > PAGE;
  const list = rows.slice(0, PAGE);
  const counts = await all<{ status: string; n: number }>(c.env, 'SELECT status, COUNT(*) AS n FROM posts WHERE pub_id = ? GROUP BY status', pub.id);
  const cnt = (s: string) => counts.find((x) => x.status === s)?.n || 0;
  const tags = await all<{ id: string; name: string }>(c.env, 'SELECT id, name FROM content_tags WHERE pub_id = ? ORDER BY name', pub.id);
  const authors = await all<{ id: string; name: string }>(c.env, 'SELECT DISTINCT u.id, u.name FROM post_authors pa JOIN users u ON u.id = pa.user_id JOIN posts p ON p.id = pa.post_id WHERE p.pub_id = ? ORDER BY u.name', pub.id);
  const base = (s: string) => '/app/posts' + qs({ status: s === 'all' ? undefined : s, q, tag, author });
  const total = counts.reduce((n, x) => n + (x.status === 'archived' ? 0 : x.n), 0);
  return c.html(
    <DashLayout c={c} title="Posts" section="posts" sub="posts" actions={<LinkBtn href="/app/posts/new" kind="primary">+ New post</LinkBtn>}>
      {!contributor && (
        <Tabs active={base(status)} items={[[base('all'), `All (${total})`], [base('draft'), `Drafts (${cnt('draft')})`], [base('scheduled'), `Scheduled (${cnt('scheduled')})`], [base('published'), `Published (${cnt('published')})`], [base('archived'), `Archived (${cnt('archived')})`]]} />
      )}
      <form method="get" class="row" style="margin-bottom:14px">
        {status !== 'all' && <input type="hidden" name="status" value={status} />}
        <Input name="q" value={q} placeholder="Search posts…" class="grow" attrs={{ style: 'max-width:320px' }} />
        <Select name="tag" value={tag} options={[['', 'All tags'], ...tags.map((t) => [t.id, t.name] as [string, string])]} autosubmit attrs={{ style: 'width:auto' }} />
        <Select name="author" value={author} options={[['', 'All authors'], ...authors.map((a) => [a.id, a.name] as [string, string])]} autosubmit attrs={{ style: 'width:auto' }} />
        <Btn kind="secondary">Filter</Btn>
      </form>
      {list.length === 0 && !q && status === 'all' && !tag && !author ? (
        <Card><Empty icon="✍️" title="Write your first post" body="Posts can go out as an email, live on your website, or both — all from one draft." action={<LinkBtn href="/app/posts/new" kind="primary">Start writing</LinkBtn>} /></Card>
      ) : (
        <form method="post" action="/app/posts/bulk">
          <Table
            rows={list}
            empty="No posts match these filters."
            rowHref={(p) => (p.status === 'published' && can(role, 'publish') ? `/app/posts/${p.id}` : `/app/posts/${p.id}/edit`)}
            cols={[
              { h: <input type="checkbox" data-check-all="ids[]" aria-label="Select all" />, r: (p) => <input type="checkbox" name="ids[]" value={p.id} aria-label="Select" />, class: 'nowrap' },
              {
                h: 'Post',
                r: (p) => (
                  <div class="row" style="flex-wrap:nowrap">
                    {p.thumbnail_url ? <img class="thumb" src={p.thumbnail_url} alt="" /> : <span class="thumb" style="display:inline-grid;place-items:center">✍️</span>}
                    <div>
                      <a href={`/app/posts/${p.id}/edit`}>{p.title || 'Untitled'}</a>
                      <div class="small muted">{p.authors || '—'}{p.subtitle ? ` · ${p.subtitle.slice(0, 70)}` : ''}</div>
                    </div>
                  </div>
                ),
              },
              { h: 'Status', r: (p) => <Status s={p.status} /> },
              { h: 'Audience', r: (p) => <Badge tone={p.audience === 'premium' ? 'purple' : 'gray'}>{p.audience === 'all' ? 'Everyone' : p.audience}</Badge> },
              { h: 'Platform', r: (p) => <span class="small">{p.platform === 'both' ? 'Email + web' : p.platform === 'email' ? 'Email only' : 'Web only'}</span> },
              { h: 'Sent', r: (p) => num(p.recipients), class: 'right' },
              { h: 'Open rate', r: (p) => (p.recipients ? pct(p.opens, p.recipients) : '—'), class: 'right' },
              { h: 'CTR', r: (p) => (p.recipients ? pct(p.clicks, p.recipients) : '—'), class: 'right' },
              { h: 'Date', r: (p) => <span class="small nowrap">{p.status === 'scheduled' ? `⏰ ${fmtDate(p.scheduled_at, { dateStyle: 'medium', timeStyle: 'short' }, pub.timezone)}` : fmtDate(p.published_at || p.updated_at, { dateStyle: 'medium' }, pub.timezone)}</span> },
              {
                h: '',
                r: (p) => (
                  <span class="row nowrap" style="flex-wrap:nowrap;gap:4px">
                    {p.status === 'published' && p.platform !== 'email' && <a class="btn btn-ghost btn-sm" href={`${siteUrl(c.env, pub)}/p/${p.slug}`} target="_blank" title="View on site">↗</a>}
                    <a class="btn btn-ghost btn-sm" href={`/app/posts/${p.id}/edit`}>Edit</a>
                  </span>
                ),
              },
            ]}
          />
          <div class="row between" style="margin-top:10px">
            <div class="row">
              <span class="small muted">With selected:</span>
              <Btn kind="secondary" small name="action" value="duplicate">Duplicate</Btn>
              {can(role, 'publish') && <Btn kind="secondary" small name="action" value="archive">Archive</Btn>}
              {can(role, 'publish') && status === 'archived' && <Btn kind="secondary" small name="action" value="restore">Restore</Btn>}
              <Btn kind="danger" small name="action" value="delete" confirm="Delete the selected posts permanently? This cannot be undone.">Delete</Btn>
            </div>
            <Pager prev={page > 1 ? base(status) + `${base(status).includes('?') ? '&' : '?'}page=${page - 1}` : null} next={more ? base(status) + `${base(status).includes('?') ? '&' : '?'}page=${page + 1}` : null} />
          </div>
        </form>
      )}
    </DashLayout>,
  );
});

app.post('/bulk', async (c) => {
  const pub = c.get('pub');
  const role = c.get('role');
  const f = await form(c.req);
  const ids: string[] = (f.ids || []).slice(0, 200);
  if (!ids.length) return back(c, '/app/posts', 'Select at least one post', 'err');
  let n = 0;
  for (const pid of ids) {
    const p = await one<Post>(c.env, 'SELECT * FROM posts WHERE id = ? AND pub_id = ?', pid, pub.id);
    if (!p) continue;
    if (!can(role, 'publish') && p.status !== 'draft') continue;
    if (f.action === 'archive' && can(role, 'publish')) { await run(c.env, `UPDATE posts SET status = 'archived', updated_at = ? WHERE id = ?`, Date.now(), pid); n++; }
    else if (f.action === 'restore' && can(role, 'publish')) { await run(c.env, `UPDATE posts SET status = CASE WHEN published_at IS NOT NULL THEN 'published' ELSE 'draft' END, updated_at = ? WHERE id = ?`, Date.now(), pid); n++; }
    else if (f.action === 'delete') { await run(c.env, 'DELETE FROM posts WHERE id = ? AND pub_id = ?', pid, pub.id); n++; }
    else if (f.action === 'duplicate') { await duplicatePost(c, p); n++; }
  }
  await audit(c, 'posts.bulk_' + str(f.action, 20), ids.join(','));
  return back(c, '/app/posts', `${n} post${n === 1 ? '' : 's'} updated`);
});

export async function duplicatePost(c: any, p: Post): Promise<string> {
  const pid = await newPost(c.env, c.get('pub'), c.get('user').id, { title: p.title ? p.title + ' (copy)' : '', subtitle: p.subtitle, content: p.content, style: p.style, template_id: p.template_id });
  await run(c.env, `UPDATE posts SET email_subject = ?, preview_text = ?, platform = ?, audience = ?, tier_ids = ?, list_id = ?, segment_ids = ?, exclude_segment_ids = ?, thumbnail_url = ?, seo = ?, comments_enabled = ?, email_content = ? WHERE id = ?`,
    p.email_subject, p.preview_text, p.platform, p.audience, p.tier_ids, p.list_id, p.segment_ids, p.exclude_segment_ids, p.thumbnail_url, p.seo, p.comments_enabled, p.email_content, pid);
  await run(c.env, 'INSERT OR IGNORE INTO post_tags (post_id, tag_id) SELECT ?, tag_id FROM post_tags WHERE post_id = ?', pid, p.id);
  return pid;
}

// New post: choose blank or a template
app.get('/new', async (c) => {
  const pub = c.get('pub');
  const tpls = await all<any>(c.env, `SELECT id, name, description, pub_id, is_default, kind FROM templates WHERE (pub_id IS NULL OR pub_id = ?) AND kind = 'post' ORDER BY pub_id IS NULL, is_default DESC, name`, pub.id);
  const def = tpls.find((t) => t.pub_id && t.is_default);
  return c.html(
    <DashLayout c={c} title="New post" section="posts" sub="posts" crumbs={[['/app/posts', 'Posts']]}>
      <div class="grid g3">
        <form method="post" action="/app/posts/new" class="card" style="margin:0">
          <div class="card-b stack">
            <h3>Blank post</h3>
            <p class="muted small">{def ? `Starts empty with your default style (“${def.name}”).` : 'Start from an empty canvas.'}</p>
            <Btn kind="primary">Start writing</Btn>
          </div>
        </form>
        {tpls.map((t) => (
          <form method="post" action="/app/posts/new" class="card" style="margin:0">
            <input type="hidden" name="template_id" value={t.id} />
            <div class="card-b stack">
              <div class="row between"><h3 style="margin:0">{t.name}</h3>{t.pub_id ? <Badge tone="blue">Team</Badge> : <Badge>Library</Badge>}</div>
              <p class="muted small">{t.description || 'Team template'}</p>
              <div class="row"><Btn kind="secondary">Use template</Btn><a class="btn btn-ghost btn-sm" href={`/app/posts/templates/${t.id}/preview`} target="_blank">Preview</a></div>
            </div>
          </form>
        ))}
      </div>
    </DashLayout>,
  );
});

app.post('/new', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  let opts: Parameters<typeof newPost>[3] = {};
  const tid = str(f.template_id);
  const tpl = tid
    ? await one<any>(c.env, 'SELECT * FROM templates WHERE id = ? AND (pub_id IS NULL OR pub_id = ?)', tid, pub.id)
    : await one<any>(c.env, `SELECT * FROM templates WHERE pub_id = ? AND is_default = 1 AND kind = 'post' LIMIT 1`, pub.id);
  if (tpl) opts = { content: tid ? tpl.content : '{"blocks":[]}', style: tpl.style, template_id: tpl.id };
  const pid = await newPost(c.env, pub, c.get('user').id, opts);
  return c.redirect(`/app/posts/${pid}/edit`, 303);
});

export default app;
export { uniqueSlug, esc, parseJSON };
