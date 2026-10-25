/** @jsxImportSource hono/jsx */
// Post templates: built-in library + team templates, editor, default style, duplicate.
import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { AppEnv } from '../../types';
import { all, one, run, insert } from '../../lib/db';
import { can, audit } from '../../lib/auth';
import { ruleCatalog } from '../../lib/catalog';
import { parseDoc, renderDoc } from '../../lib/render';
import { buildEmail } from '../../lib/sender';
import { siteUrl } from '../../lib/pub';
import { DashLayout } from '../../ui/layout';
import { Card, Badge, LinkBtn, Btn, Empty, Json, back, ActionForm } from '../../ui/components';
import { icon } from '../../ui/icons';
import { id, now, parseJSON, str, form, fmtDate } from '../../lib/util';
import { StyleFields, styleFromMeta } from './editor';
import { newPost, webPage } from './shared';

const app = new Hono<AppEnv>();
const KINDS: Array<[string, string]> = [['post', 'Post'], ['welcome', 'Welcome email'], ['automation', 'Automation email']];

async function loadTpl(c: any, tid: string, editable = false) {
  const pub = c.get('pub');
  const t = await one<any>(c.env, 'SELECT * FROM templates WHERE id = ? AND (pub_id IS NULL OR pub_id = ?)', tid, pub.id);
  if (!t) return null;
  if (editable && !t.pub_id) return null;
  return t;
}

app.get('/templates', async (c) => {
  const pub = c.get('pub');
  const rows = await all<any>(c.env, `SELECT t.*, u.name AS author FROM templates t LEFT JOIN users u ON u.id = t.created_by WHERE (t.pub_id IS NULL OR t.pub_id = ?) AND t.kind IN ('post','welcome','automation') ORDER BY t.pub_id IS NULL, t.is_default DESC, t.updated_at DESC`, pub.id);
  const team = rows.filter((r) => r.pub_id);
  const lib = rows.filter((r) => !r.pub_id);
  const card = (t: any) => {
    const st = parseJSON<any>(t.style, {});
    const colors = [st.email?.accent, st.email?.link, st.email?.button_bg, st.email?.bg].filter(Boolean);
    return (
      <div class="card pe-tpl" style="margin:0">
        <a class="pe-tpl-thumb" href={`/app/posts/templates/${t.id}/preview`} target="_blank" aria-label={`Preview ${t.name}`}>
          <iframe src={`/app/posts/templates/${t.id}/preview?thumb=1`} loading="lazy" tabindex={-1} title="" />
        </a>
        <div class="card-b stack-sm">
          <div class="row between"><strong>{t.name}</strong><span class="row" style="gap:4px">{t.is_default ? <Badge tone="green">Default</Badge> : null}<Badge tone={t.pub_id ? 'blue' : 'gray'}>{t.pub_id ? KINDS.find((k) => k[0] === t.kind)?.[1] : 'Library'}</Badge></span></div>
          <p class="small muted" style="margin:0">{t.description || (t.author ? `By ${t.author} · ${fmtDate(t.updated_at)}` : '')}</p>
          {colors.length > 0 && <div class="row" style="gap:4px">{colors.map((col) => <span class="swatch" style={`background:${col}`} />)}</div>}
          <div class="row" style="gap:6px">
            <form method="post" action="/app/posts/new" class="inline-form"><input type="hidden" name="template_id" value={t.id} /><Btn small>Use</Btn></form>
            {t.pub_id && <LinkBtn small href={`/app/posts/templates/${t.id}/edit`}>Edit</LinkBtn>}
            <ActionForm action={`/app/posts/templates/${t.id}/duplicate`} label="Duplicate" />
            {!t.is_default && t.kind === 'post' && <ActionForm action={`/app/posts/templates/${t.id}/default`} label="Make default" kind="ghost" />}
            {t.pub_id && <ActionForm action={`/app/posts/templates/${t.id}/delete`} label="Delete" kind="danger" confirm={`Delete template “${t.name}”?`} />}
          </div>
        </div>
      </div>
    );
  };
  return c.html(
    <DashLayout c={c} title="Templates" section="posts" sub="templates" styles={['/static/editor.css']}
      actions={<form method="post" action="/app/posts/templates"><Btn>+ New template</Btn></form>}>
      <h2>Team templates</h2>
      {team.length ? <div class="grid g3">{team.map(card)}</div> : <Card><Empty icon="🧩" title="No team templates yet" body="Save colors, fonts, spacing and a content outline once — reuse it for every post. Duplicate a library template to start." /></Card>}
      <h2 style="margin-top:28px">Template library</h2>
      <div class="grid g3">{lib.map(card)}</div>
    </DashLayout>,
  );
});

app.post('/templates', async (c) => {
  const tid = id();
  await insert(c.env, 'templates', { id: tid, pub_id: c.get('pub').id, name: 'Untitled template', kind: 'post', description: '', content: '{"blocks":[]}', style: '{}', created_by: c.get('user').id, created_at: now(), updated_at: now() });
  return c.redirect(`/app/posts/templates/${tid}/edit`, 303);
});

app.get('/templates/:id/preview', async (c) => {
  const pub = c.get('pub');
  const t = await loadTpl(c, c.req.param('id'));
  if (!t) return c.notFound();
  const fakePost: any = { id: 'tpl', title: t.name, subtitle: t.description, slug: '', thumbnail_url: null, style: t.style };
  if (c.req.query('mode') === 'web') {
    const r = await renderDoc(parseDoc(t.content), { env: c.env, mode: 'web', pub, siteUrl: siteUrl(c.env, pub), access: true, preview: true });
    return c.html(webPage(c.env, pub, fakePost, r.html));
  }
  const b = await buildEmail(c.env, pub, { title: t.kind === 'post' ? t.name : '', subtitle: t.kind === 'post' ? t.description : '', doc: parseDoc(t.content), style: JSON.stringify(parseJSON<any>(t.style, {}).email || {}), hideHeader: t.kind !== 'post' }, null, { access: true, preview: true });
  let html = b.html;
  if (c.req.query('thumb')) html = html.replace('</head>', '<style>html{zoom:.42;overflow:hidden;pointer-events:none}</style></head>');
  return c.html(html);
});

app.get('/templates/:id/edit', async (c) => {
  const pub = c.get('pub');
  const t = await loadTpl(c, c.req.param('id'), true);
  if (!t) return back(c, '/app/posts/templates', 'Library templates are read-only — duplicate one to customize it', 'err');
  const catalog = await ruleCatalog(c.env, pub.id);
  const style = parseJSON<any>(t.style, {});
  const data = { mode: 'template', post: { id: t.id, title: t.name, subtitle: t.description, status: 'draft' }, doc: parseDoc(t.content), me: { id: c.get('user').id, name: c.get('user').name }, catalog, canPublish: false, siteUrl: siteUrl(c.env, pub), subscribers: [], gmailClip: 102 * 1024 };
  return c.html(
    <DashLayout c={c} title={`Template: ${t.name}`} section="posts" sub="templates" bare styles={['/static/editor.css']} scripts={['/static/editor.js', '/static/posts-edit.js']}>
      <div class="pe" id="pe">
        <header class="pe-top">
          <a href="/app/posts/templates" class="btn btn-ghost btn-sm">← Templates</a>
          <Badge tone="blue">Template</Badge>
          <span class="pe-save" id="pe-save" aria-live="polite">Saved</span>
          <span class="grow" />
          <span class="pe-gauge" id="pe-gauge" title="Email size"><span class="pe-gauge-bar"><i /></span><span class="pe-gauge-t">— KB</span></span>
          <span class="small muted" id="pe-words">0 words</span>
          <button type="button" class="btn btn-ghost btn-sm" data-open="#pe-find" aria-label="Find and replace">{raw(icon('search', 16))}</button>
          <a class="btn btn-secondary btn-sm" href={`/app/posts/templates/${t.id}/preview`} target="_blank">{raw(icon('eye', 16))} Preview</a>
          <form method="post" action="/app/posts/new" class="inline-form"><input type="hidden" name="template_id" value={t.id} /><button class="btn btn-primary btn-sm">Use for new post</button></form>
        </header>
        <div class="pe-body">
          <main class="pe-canvas" id="pe-canvas">
            <div class="pe-paper">
              <textarea id="pe-title" class="pe-title" rows={1} placeholder="Template name" aria-label="Template name">{t.name}</textarea>
              <textarea id="pe-subtitle" class="pe-subtitle" rows={1} placeholder="Short description" aria-label="Description">{t.description}</textarea>
              <div id="pe-editor" />
            </div>
          </main>
          <aside class="pe-side">
            <nav class="pe-tabs" role="tablist"><button type="button" data-tab="settings" class="on">Template</button><button type="button" data-tab="style">Style</button></nav>
            <form id="pe-meta" class="pe-panels" onsubmit="return false">
              <section data-panel="settings" class="on">
                <label class="field"><span class="field-l">Used for</span><select class="input" name="kind">{KINDS.map(([v, l]) => <option value={v} selected={t.kind === v}>{l}</option>)}</select></label>
                <label class="toggle"><input type="checkbox" name="is_default" checked={!!t.is_default} /><span class="toggle-ui" /><span>Default for new posts<small class="field-h">New blank posts start with this template's style.</small></span></label>
                <p class="small muted">Templates are shared with your whole team. Add an outline, sponsor slots (ad blocks), referral and recommendation blocks — every post created from it starts with them. Posts created from this template (including via the API) pick up changes made here.</p>
              </section>
              <section data-panel="style"><StyleFields style={style} /></section>
            </form>
          </aside>
        </div>
      </div>
      <dialog id="pe-find" class="modal">
        <header class="modal-h"><h3>Find &amp; replace</h3><button type="button" class="btn btn-ghost btn-sm" data-close>✕</button></header>
        <div class="modal-b stack">
          <input class="input" id="pe-find-q" placeholder="Find" /><input class="input" id="pe-find-r" placeholder="Replace with" />
          <label class="check"><input type="checkbox" id="pe-find-case" /><span>Match case</span></label>
          <div class="row between"><span class="small muted" id="pe-find-count">0 matches</span><span class="row"><button type="button" class="btn btn-secondary btn-sm" id="pe-find-next">Next</button><button type="button" class="btn btn-secondary btn-sm" id="pe-find-one">Replace</button><button type="button" class="btn btn-primary btn-sm" id="pe-find-all">Replace all</button></span></div>
        </div>
      </dialog>
      <Json id="pe-data" data={data} />
    </DashLayout>,
  );
});

app.put('/templates/:id', async (c) => {
  const pub = c.get('pub');
  const t = await loadTpl(c, c.req.param('id'), true);
  if (!t) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json<any>();
  const m = b.meta || {};
  const doc = b.content && Array.isArray(b.content.blocks) ? b.content : parseDoc(t.content);
  const kind = KINDS.some((k) => k[0] === m.kind) ? m.kind : t.kind;
  await run(c.env, 'UPDATE templates SET name = ?, description = ?, content = ?, kind = ?, style = ?, updated_at = ? WHERE id = ? AND pub_id = ?',
    str(b.title, 120) || 'Untitled template', str(b.subtitle, 500), JSON.stringify(doc), kind, b.meta ? JSON.stringify(styleFromMeta(m)) : t.style, now(), t.id, pub.id);
  if (b.meta) {
    if (m.is_default && !t.is_default) { await run(c.env, 'UPDATE templates SET is_default = 0 WHERE pub_id = ?', pub.id); await run(c.env, 'UPDATE templates SET is_default = 1 WHERE id = ?', t.id); }
    else if (!m.is_default && t.is_default) await run(c.env, 'UPDATE templates SET is_default = 0 WHERE id = ?', t.id);
  }
  return c.json({ ok: true, updated_at: now() });
});

app.post('/templates/:id/duplicate', async (c) => {
  const t = await loadTpl(c, c.req.param('id'));
  if (!t) return c.notFound();
  const tid = id();
  await insert(c.env, 'templates', { id: tid, pub_id: c.get('pub').id, name: `${t.name}${t.pub_id ? ' (copy)' : ''}`, kind: t.kind, description: t.description, content: t.content, style: t.style, created_by: c.get('user').id, created_at: now(), updated_at: now() });
  return back(c, `/app/posts/templates/${tid}/edit`, 'Template duplicated');
});

app.post('/templates/:id/default', async (c) => {
  const pub = c.get('pub');
  let t = await loadTpl(c, c.req.param('id'));
  if (!t) return c.notFound();
  let tid = t.id;
  if (!t.pub_id) {
    tid = id();
    await insert(c.env, 'templates', { id: tid, pub_id: pub.id, name: t.name, kind: 'post', description: t.description, content: t.content, style: t.style, created_by: c.get('user').id, created_at: now(), updated_at: now() });
  }
  await run(c.env, 'UPDATE templates SET is_default = 0 WHERE pub_id = ?', pub.id);
  await run(c.env, 'UPDATE templates SET is_default = 1 WHERE id = ? AND pub_id = ?', tid, pub.id);
  await audit(c, 'template.default', tid);
  return back(c, '/app/posts/templates', `“${t.name}” is now the default style for new posts`);
});

app.post('/templates/:id/delete', async (c) => {
  const t = await loadTpl(c, c.req.param('id'), true);
  if (!t) return c.notFound();
  await run(c.env, 'DELETE FROM templates WHERE id = ? AND pub_id = ?', t.id, c.get('pub').id);
  return back(c, '/app/posts/templates', 'Template deleted');
});

export default app;
