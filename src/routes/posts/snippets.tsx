/** @jsxImportSource hono/jsx */
// Posts → Snippets: named reusable content blocks (signature, sponsor banner, footer CTA…).
// Inserted from the editor either as a copy or as a synced reference block {type:'snippet', data:{snippet_id}}
// that lib/render.ts renders from the snippet's current content — so editing a snippet updates every post,
// template and automation email that uses it (sent emails keep what was sent).
import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { AppEnv, Env } from '../../types';
import { all, one, run, insert } from '../../lib/db';
import { audit } from '../../lib/auth';
import { parseDoc, emailLayout, renderDoc, styleFor, type Block } from '../../lib/render';
import { siteUrl } from '../../lib/pub';
import { DashLayout } from '../../ui/layout';
import { Card, Btn, Empty, Json, back, ActionForm, Badge, Field, Input } from '../../ui/components';
import { id, now, str, form, fmtDate } from '../../lib/util';

const app = new Hono<AppEnv>();

export interface Snippet { id: string; pub_id: string; name: string; description: string; content: string; created_by: string | null; created_at: number; updated_at: number }

const TYPE_LABEL: Record<string, string> = { paragraph: 'Text', heading: 'Heading', image: 'Image', button: 'Button', section: 'Section', columns: 'Columns', ad: 'Sponsor', quote: 'Quote', list: 'List', divider: 'Divider', html: 'HTML', referral: 'Referral', recommended_products: 'Products' };

/** Strip ids and nested snippet references to itself; give blocks fresh ids. */
export function cleanSnippetBlocks(blocks: any[], selfId?: string): Block[] {
  const out: Block[] = [];
  for (const b of Array.isArray(blocks) ? blocks.slice(0, 200) : []) {
    if (!b || typeof b.type !== 'string') continue;
    if (b.type === 'snippet' && selfId && b.data?.snippet_id === selfId) continue;
    if (b.type === 'paywall' || b.type === 'html_document') continue;
    out.push({ id: id(8), type: b.type, data: b.data && typeof b.data === 'object' ? b.data : {} });
  }
  return out;
}

/** How many posts / templates / automations reference a snippet as a synced block. */
export async function snippetUsage(env: Env, pubId: string, sid: string): Promise<{ posts: number; templates: number; automations: number }> {
  const like = `%"snippet_id":"${sid.replace(/[%_"]/g, '')}"%`;
  const [p, t, a] = await Promise.all([
    one<{ n: number }>(env, `SELECT COUNT(*) AS n FROM posts WHERE pub_id = ? AND (content LIKE ? OR email_content LIKE ?)`, pubId, like, like),
    one<{ n: number }>(env, `SELECT COUNT(*) AS n FROM templates WHERE pub_id = ? AND content LIKE ?`, pubId, like),
    one<{ n: number }>(env, `SELECT COUNT(*) AS n FROM automations WHERE pub_id = ? AND (steps LIKE ? OR draft_steps LIKE ?)`, pubId, like, like),
  ]);
  return { posts: p?.n || 0, templates: t?.n || 0, automations: a?.n || 0 };
}

export async function createSnippet(env: Env, pubId: string, userId: string | null, name: string, blocks: any[], description = ''): Promise<string> {
  const sid = id();
  await insert(env, 'snippets', { id: sid, pub_id: pubId, name: str(name, 120) || 'Untitled snippet', description: str(description, 500), content: JSON.stringify({ blocks: cleanSnippetBlocks(blocks) }), created_by: userId, created_at: now(), updated_at: now() });
  return sid;
}

function summary(content: string): string {
  const blocks = parseDoc(content).blocks;
  if (!blocks.length) return 'Empty';
  const kinds = [...new Set(blocks.map((b) => TYPE_LABEL[b.type] || b.type))];
  return `${blocks.length} block${blocks.length === 1 ? '' : 's'} · ${kinds.slice(0, 4).join(', ')}`;
}

app.get('/snippets', async (c) => {
  const pub = c.get('pub');
  const rows = await all<Snippet & { author: string | null }>(c.env, `SELECT s.*, u.name AS author FROM snippets s LEFT JOIN users u ON u.id = s.created_by WHERE s.pub_id = ? ORDER BY s.updated_at DESC`, pub.id);
  const usage = await Promise.all(rows.map((s) => snippetUsage(c.env, pub.id, s.id)));
  return c.html(
    <DashLayout c={c} title="Snippets" section="posts" sub="snippets" styles={['/static/editor.css']}
      actions={<form method="post" action="/app/posts/snippets"><input type="hidden" name="name" value="Untitled snippet" /><Btn kind="primary">+ New snippet</Btn></form>}>
      <p class="muted" style="margin-top:0;max-width:760px">Snippets are reusable blocks — your signature, a sponsor banner, a footer call to action. Insert one from the editor’s <b>+</b> menu (“Saved snippet”) or save any blocks with the block menu ⋮⋮ → “Save as snippet”. <b>Synced</b> snippets update everywhere they’re used when you edit them here; <b>copies</b> become ordinary blocks you can change per post.</p>
      {rows.length === 0 ? (
        <Card><Empty icon="🧩" title="No snippets yet" body="Create your first snippet here, or open any post, click a block’s ⋮⋮ handle and choose “Save as snippet”." /></Card>
      ) : (
        <div class="tg-grid sn-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px">
          {rows.map((s, i) => {
            const u = usage[i];
            const total = u.posts + u.templates + u.automations;
            return (
              <div class="card sn-card" style="margin:0;display:flex;flex-direction:column;overflow:hidden" data-snippet={s.id}>
                <a href={`/app/posts/snippets/${s.id}/edit`} class="sn-thumb" style="display:block;height:190px;overflow:hidden;position:relative;border-bottom:1px solid var(--border,#e5e7eb);background:#f4f4f5" aria-label={`Edit ${s.name}`}>
                  <iframe src={`/app/posts/snippets/${s.id}/preview?thumb=1`} loading="lazy" tabindex={-1} title="" style="position:absolute;top:0;left:0;width:200%;height:380px;border:0;transform:scale(.5);transform-origin:0 0;pointer-events:none;background:#fff" />
                </a>
                <div style="padding:14px;display:flex;flex-direction:column;gap:8px;flex:1">
                  <div class="row between" style="gap:6px"><strong>{s.name}</strong>{total ? <Badge tone="green">Synced in {total}</Badge> : <Badge>Not used yet</Badge>}</div>
                  <p class="small muted" style="margin:0">{s.description || summary(s.content)}</p>
                  {total > 0 && <p class="small muted" style="margin:0">{[u.posts && `${u.posts} post${u.posts === 1 ? '' : 's'}`, u.templates && `${u.templates} template${u.templates === 1 ? '' : 's'}`, u.automations && `${u.automations} automation${u.automations === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</p>}
                  <p class="small muted" style="margin:0">Updated {fmtDate(s.updated_at)}{s.author ? ` · ${s.author}` : ''}</p>
                  <div class="row" style="gap:6px;margin-top:auto;flex-wrap:wrap">
                    <a class="btn btn-secondary btn-sm" href={`/app/posts/snippets/${s.id}/edit`}>Edit</a>
                    <a class="btn btn-ghost btn-sm" href={`/app/posts/snippets/${s.id}/preview`} target="_blank">Preview</a>
                    <ActionForm action={`/app/posts/snippets/${s.id}/duplicate`} label="Duplicate" kind="ghost" />
                    <ActionForm action={`/app/posts/snippets/${s.id}/delete`} label="Delete" kind="danger" confirm={total ? `“${s.name}” is synced into ${total} place(s). Deleting it removes it from those emails and pages. Delete anyway?` : `Delete snippet “${s.name}”?`} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </DashLayout>,
  );
});

app.post('/snippets', async (c) => {
  const f = await form(c.req);
  const sid = await createSnippet(c.env, c.get('pub').id, c.get('user').id, str(f.name, 120) || 'Untitled snippet', []);
  return c.redirect(`/app/posts/snippets/${sid}/edit`, 303);
});

async function loadSnippet(c: any, sid: string) {
  return one<Snippet>(c.env, 'SELECT * FROM snippets WHERE id = ? AND pub_id = ?', sid, c.get('pub').id);
}

app.get('/snippets/:id/edit', async (c) => {
  const s = await loadSnippet(c, c.req.param('id'));
  if (!s) return c.notFound();
  const u = await snippetUsage(c.env, c.get('pub').id, s.id);
  const total = u.posts + u.templates + u.automations;
  return c.html(
    <DashLayout c={c} title={`Snippet: ${s.name}`} section="posts" sub="snippets" crumbs={[['/app/posts/snippets', 'Snippets']]} styles={['/static/editor.css']} scripts={['/static/editor.js']}>
      <form method="post" action={`/app/posts/snippets/${s.id}`} id="sn-form" class="stack" style="max-width:820px">
        <div class="grid g2">
          <Field label="Name"><Input name="name" value={s.name} required maxlength={120} /></Field>
          <Field label="Description" hint="Optional — shown in the snippet picker"><Input name="description" value={s.description} maxlength={500} /></Field>
        </div>
        {total > 0 && <p class="small" style="margin:0"><Badge tone="green">Synced</Badge> Saving updates {total} place{total === 1 ? '' : 's'} that use this snippet ({u.posts} posts, {u.templates} templates, {u.automations} automations).</p>}
        <input type="hidden" name="content" id="sn-content" value={s.content} />
        <div class="card" style="padding:18px 18px 18px 46px"><div id="sn-editor" /></div>
        <div class="row" style="gap:8px"><Btn kind="primary">Save snippet</Btn><a class="btn btn-ghost" href={`/app/posts/snippets/${s.id}/preview`} target="_blank">Preview email</a><a class="btn btn-ghost" href="/app/posts/snippets">Cancel</a></div>
      </form>
      <Json id="sn-data" data={{ doc: parseDoc(s.content) }} />
      {raw(`<script>document.addEventListener('DOMContentLoaded',function(){var d=JSON.parse(document.getElementById('sn-data').textContent);var ed=OHEditor.mount(document.getElementById('sn-editor'),{doc:d.doc,input:document.getElementById('sn-content'),compact:true,channels:false,exclude:['snippet','html_document'],features:{paywall:false,dynamic:true,polls:true,ai:true,collab:false}});document.getElementById('sn-form').addEventListener('submit',function(){ed.flush&&ed.flush();document.getElementById('sn-content').value=JSON.stringify(ed.getDoc());});});</script>`)}
    </DashLayout>,
  );
});

app.post('/snippets/:id', async (c) => {
  const s = await loadSnippet(c, c.req.param('id'));
  if (!s) return c.notFound();
  const f = await form(c.req);
  let blocks: any[] = parseDoc(s.content).blocks;
  try { const d = JSON.parse(String(f.content || '')); if (Array.isArray(d?.blocks)) blocks = d.blocks; } catch {}
  await run(c.env, 'UPDATE snippets SET name = ?, description = ?, content = ?, updated_at = ? WHERE id = ? AND pub_id = ?', str(f.name, 120) || s.name, str(f.description, 500), JSON.stringify({ blocks: cleanSnippetBlocks(blocks, s.id) }), now(), s.id, s.pub_id);
  await audit(c, 'snippet.update', s.id);
  return back(c, `/app/posts/snippets`, `Snippet “${str(f.name, 120) || s.name}” saved`);
});

app.post('/snippets/:id/duplicate', async (c) => {
  const s = await loadSnippet(c, c.req.param('id'));
  if (!s) return c.notFound();
  const sid = await createSnippet(c.env, s.pub_id, c.get('user').id, `${s.name} (copy)`, parseDoc(s.content).blocks, s.description);
  return back(c, `/app/posts/snippets/${sid}/edit`, 'Snippet duplicated');
});

app.post('/snippets/:id/delete', async (c) => {
  const s = await loadSnippet(c, c.req.param('id'));
  if (!s) return c.notFound();
  await run(c.env, 'DELETE FROM snippets WHERE id = ? AND pub_id = ?', s.id, s.pub_id);
  await audit(c, 'snippet.delete', s.id);
  return back(c, '/app/posts/snippets', `Snippet “${s.name}” deleted`);
});

app.get('/snippets/:id/preview', async (c) => {
  const pub = c.get('pub');
  const s = await loadSnippet(c, c.req.param('id'));
  if (!s) return c.notFound();
  const style = styleFor(pub);
  const r = await renderDoc(parseDoc(s.content), { env: c.env, mode: 'email', pub, siteUrl: siteUrl(c.env, pub), access: true, preview: true, style });
  let html = emailLayout(r.html || `<p style="color:${style.muted}">This snippet is empty.</p>`, { pub, style, hideHeader: true, title: s.name });
  if (c.req.query('thumb')) html = html.replace('</head>', '<style>html{overflow:hidden;pointer-events:none}</style></head>');
  return c.html(html);
});

// ───────── JSON for the editor (insert picker, save-as-snippet) ─────────
app.get('/snippets.json', async (c) => {
  const rows = await all<Snippet>(c.env, 'SELECT id, name, description, content, updated_at FROM snippets WHERE pub_id = ? ORDER BY updated_at DESC LIMIT 200', c.get('pub').id);
  return c.json({ items: rows.map((s) => ({ id: s.id, name: s.name, description: s.description, summary: summary(s.content), updated_at: s.updated_at })) });
});

app.get('/snippets/:id/json', async (c) => {
  const s = await loadSnippet(c, c.req.param('id'));
  if (!s) return c.json({ error: 'not_found' }, 404);
  return c.json({ id: s.id, name: s.name, description: s.description, doc: { blocks: cleanSnippetBlocks(parseDoc(s.content).blocks) } });
});

app.post('/snippets.json', async (c) => {
  const b = await c.req.json<any>().catch(() => ({}));
  const blocks = Array.isArray(b.blocks) ? b.blocks : [];
  if (!blocks.length) return c.json({ error: 'Choose at least one block to save' }, 400);
  const name = str(b.name, 120);
  if (!name) return c.json({ error: 'Give the snippet a name' }, 400);
  const sid = await createSnippet(c.env, c.get('pub').id, c.get('user').id, name, blocks, str(b.description, 500));
  await audit(c, 'snippet.create', sid);
  return c.json({ id: sid, name });
});

export default app;
