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

/** Category order for the library filter (templates.category; team templates without one fall under “Team”). */
export const CATEGORIES = ['Digest', 'Editorial', 'Curation', 'Business', 'Media & events', 'Education', 'Data', 'Welcome', 'Seasonal', 'Automation'];

/** Shared styles + filter script for template galleries (templates page, new-post picker, automation picker). */
export function GalleryAssets() {
  return raw(`<style>
.tg-filter{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 16px}
.tg-filter button{border:1px solid var(--border,#e5e7eb);background:var(--surface,#fff);color:inherit;border-radius:999px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer}
.tg-filter button.on{background:var(--text,#111827);border-color:var(--text,#111827);color:var(--bg,#fff)}
.tg-filter button small{opacity:.6;margin-left:4px}
.tg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px}
.tg-card{margin:0;display:flex;flex-direction:column;overflow:hidden}
.tg-card[hidden]{display:none}
.tg-thumb{display:block;height:250px;overflow:hidden;position:relative;border-bottom:1px solid var(--border,#e5e7eb);background:#f4f4f5}
.tg-thumb iframe{position:absolute;top:0;left:0;width:200%;height:500px;border:0;transform:scale(.5);transform-origin:0 0;pointer-events:none;background:#fff}
.tg-thumb::after{content:"";position:absolute;inset:auto 0 0 0;height:40px;background:linear-gradient(to bottom,rgba(255,255,255,0),rgba(0,0,0,.06))}
.tg-thumb:hover{outline:2px solid var(--accent,#f59e0b);outline-offset:-2px}
.tg-blank{display:flex;align-items:center;justify-content:center;font-size:44px;color:#9ca3af;background:repeating-linear-gradient(45deg,#fafafa,#fafafa 10px,#f4f4f5 10px,#f4f4f5 20px)}
.tg-body{padding:14px;display:flex;flex-direction:column;gap:8px;flex:1}
.tg-body p{margin:0}
.tg-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.tg-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:auto;padding-top:4px}
.tg-swatches{display:flex;gap:3px}
</style><script>
document.addEventListener('click',function(e){var b=e.target.closest('[data-tg-filter]');if(!b)return;var bar=b.closest('.tg-filter');var scope=document.querySelector(bar.dataset.target||'body');bar.querySelectorAll('button').forEach(function(x){x.classList.toggle('on',x===b)});var cat=b.dataset.tgFilter;scope.querySelectorAll('.tg-card[data-cat]').forEach(function(card){card.hidden=!(cat==='all'||card.dataset.cat===cat)});});
</script>`);
}

/** Category filter chips for a gallery (client-side). */
export function CategoryFilter(p: { items: Array<{ category?: string; pub_id?: string | null }>; target: string }) {
  const counts = new Map<string, number>();
  for (const t of p.items) { const k = catOf(t); counts.set(k, (counts.get(k) || 0) + 1); }
  const cats = [...counts.keys()].sort((a, b) => (a === 'Team' ? -1 : b === 'Team' ? 1 : (CATEGORIES.indexOf(a) + 1 || 99) - (CATEGORIES.indexOf(b) + 1 || 99)));
  return (
    <div class="tg-filter" data-target={p.target} role="toolbar" aria-label="Filter templates by category">
      <button type="button" class="on" data-tg-filter="all">All<small>{p.items.length}</small></button>
      {cats.map((k) => <button type="button" data-tg-filter={k}>{k}<small>{counts.get(k)}</small></button>)}
    </div>
  );
}

export const catOf = (t: { category?: string; pub_id?: string | null }) => (t.pub_id ? 'Team' : t.category || 'Other');
const KIND_LABEL: Record<string, string> = { post: 'Post', welcome: 'Welcome email', automation: 'Automation email' };

/** One template card with a live thumbnail rendered from the template itself. */
export function TemplateCard(p: { t: any; children?: any }) {
  const t = p.t;
  const st = parseJSON<any>(t.style, {});
  const colors = [st.email?.bg, st.email?.content_bg, st.email?.accent, st.email?.button_bg, st.email?.link].filter((x, i, a) => x && a.indexOf(x) === i).slice(0, 5);
  return (
    <div class="card tg-card" data-cat={catOf(t)}>
      <a class="tg-thumb" href={`/app/posts/templates/${t.id}/preview`} target="_blank" aria-label={`Preview ${t.name}`}>
        <iframe src={`/app/posts/templates/${t.id}/preview?thumb=1`} loading="lazy" tabindex={-1} title="" />
      </a>
      <div class="tg-body">
        <div class="row between" style="gap:6px;align-items:flex-start"><strong>{t.name}</strong>{colors.length > 0 && <span class="tg-swatches">{colors.map((col) => <span class="swatch" style={`background:${col}`} />)}</span>}</div>
        <div class="tg-meta">
          {t.is_default ? <Badge tone="green">Default</Badge> : null}
          <Badge tone={t.pub_id ? 'blue' : 'gray'}>{t.pub_id ? 'Team' : t.category || 'Library'}</Badge>
          {t.kind !== 'post' && <Badge tone="purple">{KIND_LABEL[t.kind] || t.kind}</Badge>}
        </div>
        <p class="small muted">{t.description || (t.author ? `By ${t.author} · ${fmtDate(t.updated_at)}` : '')}</p>
        <div class="tg-actions">{p.children}</div>
      </div>
    </div>
  );
}

/** The right primary action for a template: posts → new post; welcome/automation emails → a new automation from it. */
export function UseTemplate(p: { t: any; label?: string }) {
  if (p.t.kind === 'welcome' || p.t.kind === 'automation') {
    return <form method="post" action="/app/automations/from-template" class="inline-form"><input type="hidden" name="template_id" value={p.t.id} /><Btn small kind="primary">{p.t.kind === 'welcome' ? 'Use as welcome email' : 'Use in automation'}</Btn></form>;
  }
  return <form method="post" action="/app/posts/new" class="inline-form"><input type="hidden" name="template_id" value={p.t.id} /><Btn small kind="primary">{p.label || 'Use'}</Btn></form>;
}

app.get('/templates', async (c) => {
  const pub = c.get('pub');
  const rows = await all<any>(c.env, `SELECT t.*, u.name AS author FROM templates t LEFT JOIN users u ON u.id = t.created_by WHERE (t.pub_id IS NULL OR t.pub_id = ?) AND t.kind IN ('post','welcome','automation') ORDER BY t.pub_id IS NULL, t.is_default DESC, t.updated_at DESC`, pub.id);
  const team = rows.filter((r) => r.pub_id);
  const order = (t: any) => (CATEGORIES.indexOf(t.category) + 1 || 99) * 1000 + (String(t.id).startsWith('tpl_lib_') ? 0 : 500);
  const lib = rows.filter((r) => !r.pub_id).sort((a, b) => order(a) - order(b) || a.created_at - b.created_at);
  const card = (t: any) => (
    <TemplateCard t={t}>
      <UseTemplate t={t} />
      <a class="btn btn-ghost btn-sm" href={`/app/posts/templates/${t.id}/preview`} target="_blank">Preview</a>
      {t.pub_id && <LinkBtn small href={`/app/posts/templates/${t.id}/edit`}>Edit</LinkBtn>}
      <ActionForm action={`/app/posts/templates/${t.id}/duplicate`} label={t.pub_id ? 'Duplicate' : 'Customize'} />
      {!t.is_default && t.kind === 'post' && <ActionForm action={`/app/posts/templates/${t.id}/default`} label="Make default" kind="ghost" />}
      {t.pub_id && <ActionForm action={`/app/posts/templates/${t.id}/delete`} label="Delete" kind="danger" confirm={`Delete template “${t.name}”?`} />}
    </TemplateCard>
  );
  return c.html(
    <DashLayout c={c} title="Templates" section="posts" sub="templates" styles={['/static/editor.css']}
      actions={<form method="post" action="/app/posts/templates"><Btn>+ New template</Btn></form>}>
      <GalleryAssets />
      <p class="muted" style="margin-top:0">Templates hold a content outline and a style (colors, fonts, spacing for email and web). Posts stay linked to their template: editing a template’s style restyles every post made from it, except values a post overrides in its own Style tab.</p>
      <h2>Team templates</h2>
      {team.length ? <div class="tg-grid">{team.map(card)}</div> : <Card><Empty icon="🧩" title="No team templates yet" body="Click “Customize” on any library template to make your own copy, or save a post as a template from the editor." /></Card>}
      <h2 style="margin-top:28px">Template library <span class="muted small" style="font-weight:400">· {lib.length} designs</span></h2>
      <CategoryFilter items={lib} target="#tg-lib" />
      <div class="tg-grid" id="tg-lib">{lib.map(card)}</div>
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
  if (c.req.query('thumb')) html = html.replace('</head>', '<style>html{overflow:hidden;pointer-events:none}</style></head>');
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
                <p class="small muted">Templates are shared with your whole team. Add an outline, sponsor slots (ad blocks), referral and recommendation blocks — every post created from it starts with a copy of that content. Style is linked, not copied: posts created from this template (in the editor or via the API) pick up style changes made here, except the values a post overrides in its own Style tab.</p>
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
  await insert(c.env, 'templates', { id: tid, pub_id: c.get('pub').id, name: `${t.name}${t.pub_id ? ' (copy)' : ''}`, kind: t.kind, description: t.description, content: t.content, style: t.style, category: t.category || '', created_by: c.get('user').id, created_at: now(), updated_at: now() });
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
