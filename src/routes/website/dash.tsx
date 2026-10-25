/** @jsxImportSource hono/jsx */
// Website builder dashboard: pages + page builder, theme, navigation, pop-ups & gating, redirects, SEO & crawlers, saved templates.
import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { AppEnv, Ctx, Publication } from '../../types';
import { all, one, run, val, insert, update } from '../../lib/db';
import { requirePerm, audit } from '../../lib/auth';
import { settings, siteUrl } from '../../lib/pub';
import { aiJSON, aiText, AI_DISABLED_MSG } from '../../lib/ai';
import { storeFile } from '../../lib/media';
import { DashLayout } from '../../ui/layout';
import { Card, Grid, Btn, LinkBtn, ActionForm, Field, Input, Textarea, Select, Check, Toggle, Status, Table, Empty, Modal, OpenBtn, Help, Json, back, Muted, Badge } from '../../ui/components';
import { DEFAULT_THEME, themeOf, type Theme } from '../../ui/site';
import { id, now, slugify, parseJSON, form, str, int, bool, ago, fmtDateTime, parseCSV, esc } from '../../lib/util';
import { SECTION_TYPES, STARTER_PAGES, parseSections, resolveChannelId, type Section } from './sections';
import { renderPage, renderHome, AI_CRAWLERS, buildRobots } from './public';
import { GalleryAssets, CategoryFilter } from '../posts/templates';

const dash = new Hono<AppEnv>();
dash.use('*', requirePerm('manage'));

const FONTS = ['Inter', 'Lora', 'Merriweather', 'Playfair Display', 'Source Serif 4', 'DM Sans', 'Space Grotesk', 'IBM Plex Sans', 'Libre Baskerville', 'Work Sans', 'Manrope', 'Fraunces', 'Roboto', 'Open Sans', 'Poppins', 'Georgia', 'system-ui'];
const fontStack = (f: string) => (f === 'system-ui' ? '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif' : f === 'Georgia' ? 'Georgia, "Times New Roman", serif' : /Lora|Merriweather|Serif|Baskerville|Fraunces|Playfair/.test(f) ? `"${f}", Georgia, serif` : `"${f}", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`);
const firstFont = (stack: string) => stack.split(',')[0].replace(/["']/g, '').trim();

export const THEME_PRESETS: Record<string, { label: string; theme: Partial<Theme> }> = {
  classic: { label: 'Classic', theme: { font: fontStack('Inter'), heading_font: fontStack('Inter'), bg: '#ffffff', surface: '#f8fafc', text: '#111827', muted: '#6b7280', accent: '#f59e0b', accent_text: '#111827', border: '#e5e7eb', radius: 10, layout: 'classic', header: 'left', dark_mode: false } },
  editorial: { label: 'Editorial', theme: { font: fontStack('Source Serif 4'), heading_font: fontStack('Playfair Display'), bg: '#fffdf8', surface: '#f6f1e7', text: '#1c1917', muted: '#78716c', accent: '#b91c1c', accent_text: '#ffffff', border: '#e7e0d3', radius: 2, shadow: 'none', layout: 'magazine', header: 'center', dark_mode: false } },
  midnight: { label: 'Midnight', theme: { font: fontStack('DM Sans'), heading_font: fontStack('Space Grotesk'), bg: '#0b1020', surface: '#121a30', text: '#e5e7eb', muted: '#94a3b8', accent: '#818cf8', accent_text: '#0b1020', border: '#1f2a44', radius: 14, shadow: '0 8px 24px rgba(0,0,0,.35)', layout: 'classic', header: 'left', dark_mode: false } },
  fresh: { label: 'Fresh', theme: { font: fontStack('Manrope'), heading_font: fontStack('Manrope'), bg: '#ffffff', surface: '#f0fdf4', text: '#052e16', muted: '#4b5563', accent: '#16a34a', accent_text: '#ffffff', border: '#dcfce7', radius: 16, layout: 'classic', header: 'left', dark_mode: true } },
  minimal: { label: 'Minimal', theme: { font: fontStack('IBM Plex Sans'), heading_font: fontStack('IBM Plex Sans'), bg: '#ffffff', surface: '#fafafa', text: '#0a0a0a', muted: '#737373', accent: '#0a0a0a', accent_text: '#ffffff', border: '#e5e5e5', radius: 6, shadow: 'none', layout: 'minimal', header: 'center', dark_mode: true } },
  magazine: { label: 'Magazine', theme: { font: fontStack('Work Sans'), heading_font: fontStack('Fraunces'), bg: '#ffffff', surface: '#fff7ed', text: '#1f2937', muted: '#6b7280', accent: '#ea580c', accent_text: '#ffffff', border: '#fed7aa', radius: 8, layout: 'magazine', header: 'left', dark_mode: false } },
};

async function saveSettings(c: Ctx, patch: Record<string, unknown>) {
  const pub = c.get('pub');
  const cur = settings(pub);
  const next = { ...cur, ...patch };
  await run(c.env, 'UPDATE publications SET settings = ? WHERE id = ?', JSON.stringify(next), pub.id);
  c.set('pub', { ...pub, settings: JSON.stringify(next) } as any);
}

async function snapshotPage(c: Ctx, page: any) {
  await insert(c.env, 'page_versions', { id: id(), page_id: page.id, snapshot: JSON.stringify({ title: page.title, slug: page.slug, content: page.content, html_override: page.html_override, seo: page.seo, paywall: page.paywall }), created_by: c.get('user').id, created_at: now() });
  const old = await all<{ id: string }>(c.env, 'SELECT id FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 60', page.id);
  for (const o of old) await run(c.env, 'DELETE FROM page_versions WHERE id = ?', o.id);
}

async function getPage(c: Ctx, pid: string) {
  return one<any>(c.env, 'SELECT * FROM pages WHERE id = ? AND pub_id = ?', pid, c.get('pub').id);
}

async function uniqueSlug(c: Ctx, want: string, exceptId?: string): Promise<string> {
  const reserved = new Set(['archive', 'p', 'tag', 'authors', 'search', 'feed.xml', 'sitemap.xml', 'robots.txt', 'account', 'login', 'logout', 'subscribe', 'confirm', 'welcome', 'poll', 'survey', 'upgrade', 'gift', 'group', 'subscription', 'shop', 'order', 'download', 'sponsor', 'r', 'bio', 'recommendations', 'referrals', 'podcasts', 'events', 'community']);
  let s = want === '' ? '' : slugify(want, 60);
  if (s !== '' && reserved.has(s)) s = `${s}-page`;
  let n = 2;
  const base = s;
  while (await one(c.env, 'SELECT id FROM pages WHERE pub_id = ? AND slug = ? AND id != ?', c.get('pub').id, s, exceptId || '')) {
    if (base === '') return `home-${id(4)}`;
    s = `${base}-${n++}`;
  }
  return s;
}

function withIds(sections: Array<Partial<Section>>): Section[] {
  return sections.filter((s) => s && SECTION_TYPES[s.type as string]).map((s) => ({ id: id(8), type: s.type as string, data: s.data || {}, style: s.style || {} }));
}

const pageUrl = (c: Ctx, slug: string) => `${siteUrl(c.env, c.get('pub'))}/${slug}`;

// ───────── Pages ─────────
dash.get('/', async (c) => {
  const pub = c.get('pub');
  const pages = await all<any>(c.env, 'SELECT * FROM pages WHERE pub_id = ? ORDER BY slug = \'\' DESC, updated_at DESC', pub.id);
  const tpls = await all<any>(c.env, `SELECT id, name, content FROM templates WHERE pub_id = ? AND kind = 'website_page' ORDER BY name`, pub.id);
  const base = siteUrl(c.env, pub);
  return c.html(
    <DashLayout c={c} title="Website" section="website" sub="pages" actions={<><LinkBtn href={base + '/'} target="_blank">View site ↗</LinkBtn><OpenBtn target="#new-page">+ New page</OpenBtn></>}>
      <div class="callout">Your site is live at <a href={base + '/'} target="_blank"><strong>{base}/</strong></a>. Connect a custom domain in <a href="/app/settings/domains">Settings → Domains</a>.</div>
      <Card title="AI website builder" actions={<Badge tone="purple">AI</Badge>}>
        <form method="post" action="/app/website/ai/page" enctype="multipart/form-data" class="stack">
          <Grid cols={2}>
            <Field label="Describe the page you want" hint="e.g. “A landing page for a weekly climate newsletter with testimonials, a FAQ and pricing”"><Textarea name="prompt" rows={3} required placeholder="A bold landing page for…" /></Field>
            <Field label="Screenshot to copy (optional)" hint="Upload a screenshot of a layout you like — we'll match its structure."><input class="input" type="file" name="screenshot" accept="image/*" /></Field>
          </Grid>
          <div class="row end"><Btn>Generate page</Btn></div>
        </form>
      </Card>
      <GalleryAssets />
      <style>{raw('.tg-thumb-page iframe{width:400%;height:1100px;transform:scale(.25)}')}</style>
      <h2 style="margin-top:8px">Start from a page template</h2>
      <CategoryFilter items={[...Object.values(STARTER_PAGES), ...tpls.map((t) => ({ category: 'Team', pub_id: pub.id }))]} target="#tg-pages" />
      <div class="tg-grid" id="tg-pages" style="margin-bottom:24px">
        {tpls.map((t) => (
          <PageTplCard name={t.name} cat="Team" desc={`Saved page · ${parseSections(t.content).map((x) => SECTION_TYPES[x.type]).filter(Boolean).join(', ')}`} preview={`/app/website/page-templates/saved/${t.id}/preview`} fields={{ template_id: t.id, title: t.name }} />
        ))}
        {Object.entries(STARTER_PAGES).map(([k, t]) => (
          <PageTplCard name={t.title} cat={t.category} desc={t.description} slug={t.slug} preview={`/app/website/page-templates/${k}/preview`} fields={{ starter: k, title: t.title }} />
        ))}
      </div>
      <Card title="Pages" pad={false}>
        <Table
          rows={pages}
          rowHref={(p) => `/app/website/pages/${p.id}`}
          empty={<Empty title="No custom pages yet" body="Your home page uses the default layout. Create pages like About, a landing page, or a premium page — or override the home page." action={<OpenBtn target="#new-page">Create a page</OpenBtn>} />}
          cols={[
            { h: 'Page', r: (p) => <><a href={`/app/website/pages/${p.id}`}>{p.title}</a><br /><Muted>/{p.slug}{p.slug === '' && ' (home page)'}</Muted></> },
            { h: 'Status', r: (p) => <Status s={p.status} /> },
            { h: 'Access', r: (p) => (p.paywall === 'none' ? <Muted>Public</Muted> : <Badge tone="purple">{p.paywall}</Badge>) },
            { h: 'In nav', r: (p) => (p.slug === '' ? '—' : <ActionForm action={`/app/website/pages/${p.id}/nav`} label={p.show_in_nav ? 'Shown' : 'Hidden'} kind={p.show_in_nav ? 'secondary' : 'ghost'} />) },
            { h: 'Updated', r: (p) => <Muted>{ago(p.updated_at)}</Muted> },
            {
              h: '', class: 'right nowrap', r: (p) => (
                <>
                  {p.status === 'published' && <LinkBtn href={pageUrl(c, p.slug)} target="_blank" small kind="ghost">View</LinkBtn>}{' '}
                  <ActionForm action={`/app/website/pages/${p.id}/status`} label={p.status === 'published' ? 'Unpublish' : 'Publish'} fields={{ status: p.status === 'published' ? 'draft' : 'published' }} />{' '}
                  <ActionForm action={`/app/website/pages/${p.id}/duplicate`} label="Duplicate" kind="ghost" />{' '}
                  <ActionForm action={`/app/website/pages/${p.id}/delete`} label="Delete" kind="danger" confirm="Delete this page? This cannot be undone." />
                </>
              ),
            },
          ]}
        />
      </Card>
      <Modal id="new-page" title="New page">
        <form method="post" action="/app/website/pages" class="stack">
          <Field label="Title"><Input name="title" required placeholder="About" autofocus /></Field>
          <Field label="URL slug" hint="Leave empty to derive from the title. Use “/” to replace the home page."><Input name="slug" placeholder="about" /></Field>
          <Field label="Start from">
            <Select name="starter" value="blank" options={[['blank', 'Blank page'], ...Object.entries(STARTER_PAGES).map(([k, t]) => [k, `${t.title} — ${t.category} template`] as [string, string]), ...tpls.map((t) => [`saved:${t.id}`, `${t.name} — saved page`] as [string, string])]} />
          </Field>
          <div class="form-actions"><Btn>Create page</Btn></div>
        </form>
      </Modal>
    </DashLayout>,
  );
});

/** A page-template card with a live, scaled-down render of the page. */
function PageTplCard(p: { name: string; cat: string; desc: string; slug?: string; preview: string; fields: Record<string, string> }) {
  return (
    <div class="card tg-card" data-cat={p.cat}>
      <a class="tg-thumb tg-thumb-page" href={p.preview} target="_blank" aria-label={`Preview ${p.name}`}><iframe src={p.preview} loading="lazy" tabindex={-1} title="" /></a>
      <div class="tg-body">
        <div class="row between" style="gap:6px"><strong>{p.name}</strong><Badge tone={p.cat === 'Team' ? 'blue' : 'gray'}>{p.cat}</Badge></div>
        <p class="small muted">{p.desc}</p>
        {p.slug !== undefined && <p class="small muted mono">/{p.slug || ' (home page)'}</p>}
        <div class="tg-actions">
          <ActionForm action="/app/website/pages" fields={p.fields} label="Use this template" kind="primary" />
          <a class="btn btn-ghost btn-sm" href={p.preview} target="_blank">Preview</a>
        </div>
      </div>
    </div>
  );
}

/** Live preview of a built-in (or saved team) page template, rendered with the publication's theme. */
async function previewTemplatePage(c: Ctx, title: string, sections: any[]) {
  c.set('reader', null);
  const fake = { id: 'tpl', pub_id: c.get('pub').id, title, slug: 'preview', content: JSON.stringify({ sections: withIds(sections) }), html_override: null, seo: '{}', paywall: 'none' };
  const res = await renderPage(c, fake, { preview: true });
  return new Response(await res.text(), { headers: { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'SAMEORIGIN' } });
}

dash.get('/page-templates/saved/:id/preview', async (c) => {
  const t = await one<any>(c.env, `SELECT * FROM templates WHERE id = ? AND pub_id = ? AND kind = 'website_page'`, c.req.param('id'), c.get('pub').id);
  if (!t) return c.notFound();
  return previewTemplatePage(c, t.name, parseJSON<any>(t.content, {}).sections || []);
});

dash.get('/page-templates/:key/preview', async (c) => {
  const st = STARTER_PAGES[c.req.param('key')];
  if (!st) return c.notFound();
  return previewTemplatePage(c, st.title, st.sections);
});

dash.post('/pages', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  let sections: Section[] = [];
  const title = str(f.title, 120) || 'Untitled page';
  let slugWant = str(f.slug, 80);
  if (!f.template_id && String(f.starter || '').startsWith('saved:')) f.template_id = String(f.starter).slice(6);
  if (f.template_id) {
    const t = await one<any>(c.env, `SELECT * FROM templates WHERE id = ? AND pub_id = ? AND kind = 'website_page'`, f.template_id, pub.id);
    if (t) sections = withIds(parseJSON<any>(t.content, {}).sections || []);
  } else if (f.starter && STARTER_PAGES[f.starter]) {
    const st = STARTER_PAGES[f.starter];
    sections = withIds(st.sections);
    if (!slugWant) slugWant = st.slug === '' ? '/' : st.slug;
  }
  let slug: string;
  const hasHome = await one(c.env, `SELECT id FROM pages WHERE pub_id = ? AND slug = ''`, pub.id);
  if (slugWant === '/' && !hasHome) slug = '';
  else slug = await uniqueSlug(c, slugWant && slugWant !== '/' ? slugWant : title);
  const pid = id();
  await insert(c.env, 'pages', { id: pid, pub_id: pub.id, title, slug, content: JSON.stringify({ sections }), seo: '{}', paywall: 'none', status: 'draft', show_in_nav: 0, created_at: now(), updated_at: now() });
  await audit(c, 'website.page.create', pid, { title });
  return back(c, `/app/website/pages/${pid}`, 'Page created');
});

dash.post('/pages/:id/status', async (c) => {
  const p = await getPage(c, c.req.param('id'));
  if (!p) return c.notFound();
  const f = await form(c.req);
  const status = f.status === 'published' ? 'published' : 'draft';
  await run(c.env, 'UPDATE pages SET status = ?, updated_at = ? WHERE id = ?', status, now(), p.id);
  return back(c, f.back || '/app/website', status === 'published' ? 'Page published' : 'Page unpublished');
});

dash.post('/pages/:id/nav', async (c) => {
  const p = await getPage(c, c.req.param('id'));
  if (!p) return c.notFound();
  await run(c.env, 'UPDATE pages SET show_in_nav = ? WHERE id = ?', p.show_in_nav ? 0 : 1, p.id);
  return back(c, c.req.header('referer')?.includes('/nav') ? '/app/website/nav' : '/app/website', p.show_in_nav ? 'Removed from navigation' : 'Added to navigation');
});

dash.post('/pages/:id/duplicate', async (c) => {
  const p = await getPage(c, c.req.param('id'));
  if (!p) return c.notFound();
  const pid = id();
  const slug = await uniqueSlug(c, (p.slug || 'home') + '-copy');
  await insert(c.env, 'pages', { ...p, id: pid, title: p.title + ' (copy)', slug, status: 'draft', show_in_nav: 0, created_at: now(), updated_at: now() });
  return back(c, `/app/website/pages/${pid}`, 'Page duplicated');
});

dash.post('/pages/:id/delete', async (c) => {
  const p = await getPage(c, c.req.param('id'));
  if (!p) return c.notFound();
  await run(c.env, 'DELETE FROM pages WHERE id = ?', p.id);
  await run(c.env, 'DELETE FROM page_versions WHERE page_id = ?', p.id);
  await audit(c, 'website.page.delete', p.id, { title: p.title });
  return back(c, '/app/website', 'Page deleted');
});

// Builder
dash.get('/pages/:id', async (c) => {
  const pub = c.get('pub');
  const p = await getPage(c, c.req.param('id'));
  if (!p) return c.notFound();
  const [tags, podcasts, savedSections, versions] = await Promise.all([
    all<any>(c.env, 'SELECT slug, name FROM content_tags WHERE pub_id = ? ORDER BY name', pub.id),
    all<any>(c.env, 'SELECT id, title FROM podcasts WHERE pub_id = ? ORDER BY title', pub.id),
    all<any>(c.env, `SELECT id, name, kind, content FROM templates WHERE pub_id = ? AND kind IN ('website_section','website_block') ORDER BY kind = 'website_block' DESC, name`, pub.id),
    val<number>(c.env, 'SELECT COUNT(*) FROM page_versions WHERE page_id = ?', p.id),
  ]);
  const data = {
    page: { id: p.id, title: p.title, slug: p.slug, status: p.status, paywall: p.paywall, show_in_nav: !!p.show_in_nav, seo: parseJSON(p.seo, {}), html_override: p.html_override || '', use_html: !!p.html_override, sections: parseSections(p.content) },
    types: SECTION_TYPES,
    tags: tags.map((t) => [t.slug, t.name]),
    podcasts: podcasts.map((x) => [x.id, x.title]),
    saved: savedSections.map((t) => ({ id: t.id, name: t.name, kind: t.kind, section: parseJSON<any>(t.content, {}).section })).filter((t) => t.section && SECTION_TYPES[t.section.type]),
    siteUrl: siteUrl(c.env, pub),
    versions,
  };
  return c.html(
    <DashLayout c={c} title={p.title} section="website" sub="pages" wide crumbs={[['/app/website', 'Website']]} styles={['/static/builder.css', '/static/editor.css']} scripts={['/static/editor.js', '/static/builder.js']}
      actions={<>
        <LinkBtn href={`/app/website/pages/${p.id}/versions`} kind="ghost" small>History ({versions})</LinkBtn>
        {p.status === 'published' && <LinkBtn href={pageUrl(c, p.slug)} target="_blank" small>View ↗</LinkBtn>}
        <button type="button" class="btn btn-secondary btn-sm" data-pb-save>Save</button>
        <button type="button" class="btn btn-primary btn-sm" data-pb-publish>{p.status === 'published' ? 'Save & update' : 'Publish'}</button>
      </>}>
      <div id="pb-root" class="pb-root"><p class="muted">Loading builder…</p></div>
      <Json id="pb-data" data={data} />
    </DashLayout>,
  );
});

dash.post('/pages/:id/save', async (c) => {
  const p = await getPage(c, c.req.param('id'));
  if (!p) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json<any>();
  const sections = Array.isArray(b.sections) ? b.sections.filter((s: any) => s && SECTION_TYPES[s.type]).map((s: any) => ({ id: String(s.id || id(8)).slice(0, 20), type: s.type, data: s.data || {}, style: s.style || {} })) : parseSections(p.content);
  const slug = typeof b.slug === 'string' ? await uniqueSlug(c, b.slug.replace(/^\/+/, ''), p.id) : p.slug;
  const seo = b.seo && typeof b.seo === 'object' ? { title: str(b.seo.title, 200), description: str(b.seo.description, 400), og_image: str(b.seo.og_image, 500), canonical: str(b.seo.canonical, 500), noindex: !!b.seo.noindex } : parseJSON(p.seo, {});
  const html = b.use_html ? str(b.html_override, 500_000) || null : null;
  const status = b.publish ? 'published' : p.status;
  const patch = { title: str(b.title, 120) || p.title, slug, content: JSON.stringify({ sections }), seo: JSON.stringify(seo), paywall: ['none', 'subscribers', 'premium'].includes(b.paywall) ? b.paywall : p.paywall, html_override: html, status, show_in_nav: b.show_in_nav === undefined ? p.show_in_nav : b.show_in_nav ? 1 : 0, updated_at: now() };
  await update(c.env, 'pages', p.id, patch, c.get('pub').id);
  await snapshotPage(c, { ...p, ...patch });
  return c.json({ ok: true, slug, status, url: pageUrl(c, slug), message: b.publish ? 'Published' : 'Saved' });
});

dash.post('/pages/:id/preview', async (c) => {
  const p = await getPage(c, c.req.param('id'));
  if (!p) return c.text('not found', 404);
  const b = await c.req.json<any>();
  c.set('reader', null);
  const fake = { ...p, title: b.title || p.title, content: JSON.stringify({ sections: b.sections || [] }), html_override: b.use_html ? b.html_override || '' : null, seo: JSON.stringify(b.seo || {}) };
  const res = await renderPage(c, fake, { preview: true });
  return new Response(await res.text(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
});

dash.get('/pages/:id/versions', async (c) => {
  const p = await getPage(c, c.req.param('id'));
  if (!p) return c.notFound();
  const versions = await all<any>(c.env, 'SELECT v.*, u.name AS author FROM page_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.page_id = ? ORDER BY v.created_at DESC', p.id);
  return c.html(
    <DashLayout c={c} title="Version history" section="website" sub="pages" crumbs={[['/app/website', 'Website'], [`/app/website/pages/${p.id}`, p.title]]}>
      <Card title={`${versions.length} saved versions`} pad={false}>
        <Table rows={versions} empty="Versions are saved every time you save the page." cols={[
          { h: 'Saved', r: (v) => fmtDateTime(v.created_at, c.get('pub').timezone) },
          { h: 'By', r: (v) => v.author || '—' },
          { h: 'Title', r: (v) => parseJSON<any>(v.snapshot, {}).title },
          { h: 'Sections', r: (v) => parseSections(parseJSON<any>(v.snapshot, {}).content).length },
          { h: '', class: 'right', r: (v) => <ActionForm action={`/app/website/versions/${v.id}/restore`} label="Restore" confirm="Restore this version? The current version is kept in history." /> },
        ]} />
      </Card>
    </DashLayout>,
  );
});

dash.post('/versions/:vid/restore', async (c) => {
  const pub = c.get('pub');
  const v = await one<any>(c.env, 'SELECT * FROM page_versions WHERE id = ?', c.req.param('vid'));
  if (!v) return c.notFound();
  const snap = parseJSON<any>(v.snapshot, {});
  if (String(v.page_id).startsWith('theme:')) {
    if (v.page_id !== `theme:${pub.id}`) return c.notFound();
    await run(c.env, 'UPDATE publications SET theme = ? WHERE id = ?', JSON.stringify(snap.theme || {}), pub.id);
    return back(c, '/app/website/theme', 'Theme restored');
  }
  const p = await getPage(c, v.page_id);
  if (!p) return c.notFound();
  await snapshotPage(c, p);
  await update(c.env, 'pages', p.id, { title: snap.title ?? p.title, content: snap.content ?? p.content, html_override: snap.html_override ?? null, seo: snap.seo ?? p.seo, paywall: snap.paywall ?? p.paywall, updated_at: now() }, pub.id);
  return back(c, `/app/website/pages/${p.id}`, 'Version restored');
});

dash.post('/pages/:id/save-template', async (c) => {
  const pub = c.get('pub');
  const p = await getPage(c, c.req.param('id'));
  if (!p) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json<any>();
  const name = str(b.name, 120) || 'Saved';
  // kind: 'block' = reusable single block (website_block), 'section' = legacy section template, otherwise a whole page
  const kind = b.kind === 'block' ? 'website_block' : b.kind === 'section' ? 'website_section' : 'website_page';
  if (kind !== 'website_page' && !SECTION_TYPES[b.section?.type]) return c.json({ error: 'Unknown section type' }, 400);
  const content = kind !== 'website_page' ? { section: { type: b.section?.type, data: b.section?.data || {}, style: b.section?.style || {} } } : { sections: Array.isArray(b.sections) ? b.sections : parseSections(p.content) };
  const tid = id();
  await insert(c.env, 'templates', { id: tid, pub_id: pub.id, name, kind, description: '', content: JSON.stringify(content), style: '{}', created_by: c.get('user').id, created_at: now(), updated_at: now() });
  return c.json({ ok: true, id: tid, kind, message: kind === 'website_block' ? `Saved “${name}” to your block library` : `Saved “${name}” to your templates` });
});

dash.get('/youtube-check', async (c) => {
  const ch = await resolveChannelId(c.req.query('q') || '');
  return c.json({ channel_id: ch });
});

// Upload (fallback when the posts media endpoint is not available)
dash.post('/upload', async (c) => {
  const body = await c.req.parseBody();
  const file = body.file as File;
  if (!file || typeof file === 'string') return c.json({ error: 'No file' }, 400);
  try {
    const s = await storeFile(c.env, c.get('pub').id, file, { folder: 'website', userId: c.get('user').id, alt: str(body.alt) });
    return c.json(s);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// ───────── AI ─────────
const SECTION_SCHEMA = `Sections JSON schema: an array of {"type": one of ${Object.keys(SECTION_TYPES).join('|')}, "data": {...}, "style": {"bg"?: css color, "color"?: css color, "padding"?: "sm"|"md"|"lg"|"xl", "align"?: "left"|"center", "width"?: "narrow"|"normal"|"wide"}}.
data by type: hero {title, subtitle, eyebrow, show_form(boolean), button, cta_label, cta_url}; text {html}; posts {title, count}; subscribe {title, body, button}; testimonials {title, items:[{quote,name,role}]}; faq {title, items:[{q,a}]}; pricing {title, body}; cta {title, body, label, url}; columns {columns:[{title, body}]}; video {url}; youtube {title, channel_id}; podcast {title, count}; products {title, count}; events {title, count}; spacer {height}; image {src, alt, caption}; grid {title, columns, images:[{src,alt}]}.`;

dash.post('/ai/page', async (c) => {
  const pub = c.get('pub');
  const body = await c.req.parseBody();
  const prompt = str(body.prompt, 2000);
  let layoutHint = '';
  const shot = body.screenshot as File | undefined;
  if (shot && typeof shot !== 'string' && shot.size && c.env.AI) {
    try {
      const bytes = [...new Uint8Array(await shot.arrayBuffer())];
      const r: any = await c.env.AI.run('@cf/llava-hf/llava-1.5-7b-hf' as any, { image: bytes, prompt: 'Describe this web page layout section by section from top to bottom (hero, features, testimonials, pricing, FAQ, footer etc.), including headlines you can read.', max_tokens: 400 } as any);
      layoutHint = String(r?.description || r?.response || '');
    } catch {}
  }
  if (shot && typeof shot !== 'string' && shot.size && !layoutHint) layoutHint = `The user uploaded a reference screenshot named "${shot.name}".`;
  let sections: Section[] = [];
  let title = 'AI page';
  let usedAI = false;
  if (c.env.AI) {
    const out = await aiJSON<any>(c.env, `Publication: "${pub.name}" — ${pub.description}\nRequest: ${prompt}\n${layoutHint ? `Reference layout: ${layoutHint}\n` : ''}Return {"title": string, "slug": string, "sections": [...]} with 4-8 sections and real, specific copy (no lorem ipsum).`, `You design newsletter websites using a fixed set of page sections.\n${SECTION_SCHEMA}`);
    if (out?.sections?.length) {
      sections = withIds(out.sections);
      title = str(out.title, 120) || title;
      usedAI = sections.length > 0;
    }
  }
  if (!usedAI) {
    const st = STARTER_PAGES.landing;
    sections = withIds(st.sections);
    sections[0].data = { ...sections[0].data, title: prompt.slice(0, 80) || pub.name, subtitle: pub.description };
    title = prompt.split(/[.\n]/)[0].slice(0, 60) || 'New page';
  }
  const pid = id();
  const slug = await uniqueSlug(c, title);
  await insert(c.env, 'pages', { id: pid, pub_id: pub.id, title, slug, content: JSON.stringify({ sections }), seo: '{}', paywall: 'none', status: 'draft', show_in_nav: 0, created_at: now(), updated_at: now() });
  return back(c, `/app/website/pages/${pid}`, usedAI ? 'AI generated a draft page — review and publish when ready' : `${c.env.AI ? 'AI could not generate a layout' : AI_DISABLED_MSG} We started you from the landing template instead.`, usedAI ? 'ok' : 'err');
});

dash.post('/ai/element', async (c) => {
  const b = await c.req.json<any>();
  const prompt = str(b.prompt, 2000);
  if (!c.env.AI) return c.json({ error: AI_DISABLED_MSG }, 400);
  const r = await aiText(c.env, `Build this widget: ${prompt}\nPublication: ${c.get('pub').name}.`, 'You write a single self-contained HTML snippet (inline <style> and <script> allowed, no external resources except https CDNs) that renders a small live widget for a newsletter website — e.g. countdown timers, calculators, quizzes, live clocks, tip jars. Use system fonts, responsive layout, and a light neutral design. Output only the HTML, no markdown fences, no explanations.', 2500);
  if (!r.ok) return c.json({ error: r.text }, 400);
  const html = r.text.replace(/^```[a-z]*\n?|```$/gim, '').trim();
  return c.json({ section: { id: id(8), type: 'html', data: { html, sandbox: true, height: 380, title: prompt.slice(0, 60) }, style: { padding: 'md' } } });
});

// ───────── Theme ─────────
function themeFromForm(f: Record<string, any>, cur: Theme): Theme {
  const color = (v: any, d: string) => (/^#[0-9a-f]{3,8}$/i.test(String(v || '')) ? String(v) : d);
  return {
    ...cur,
    font: f.font ? fontStack(String(f.font)) : cur.font,
    heading_font: f.heading_font ? fontStack(String(f.heading_font)) : cur.heading_font,
    bg: color(f.bg, cur.bg), surface: color(f.surface, cur.surface), text: color(f.text, cur.text), muted: color(f.muted, cur.muted),
    accent: color(f.accent, cur.accent), accent_text: color(f.accent_text, cur.accent_text), border: color(f.border, cur.border),
    radius: Math.max(0, Math.min(32, int(f.radius, cur.radius))),
    shadow: ({ none: 'none', soft: DEFAULT_THEME.shadow, strong: '0 10px 30px rgba(0,0,0,.12)' } as Record<string, string>)[f.shadow] ?? cur.shadow,
    max_width: Math.max(640, Math.min(1600, int(f.max_width, cur.max_width))),
    layout: ['classic', 'magazine', 'minimal'].includes(f.layout) ? f.layout : cur.layout,
    header: f.header === 'center' ? 'center' : 'left',
    dark_mode: bool(f.dark_mode),
    show_hero: bool(f.show_hero),
    hero_title: str(f.hero_title, 200), hero_subtitle: str(f.hero_subtitle, 400), hero_image: str(f.hero_image, 500),
    custom_css: str(f.custom_css, 20_000),
  };
}

const shadowKey = (s: string) => (s === 'none' ? 'none' : s.includes('30px') ? 'strong' : 'soft');

dash.get('/theme', async (c) => {
  const pub = c.get('pub');
  const t = themeOf(pub);
  const versions = await all<any>(c.env, `SELECT id, created_at FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 15`, `theme:${pub.id}`);
  const colorField = (name: keyof Theme, label: string) => (
    <Field label={label}><div class="row"><input type="color" class="input" name={name} value={String(t[name])} data-sync={`#hex-${name}`} /><input class="input mono" id={`hex-${name}`} value={String(t[name])} data-sync-to={name} style="width:110px" /></div></Field>
  );
  return c.html(
    <DashLayout c={c} title="Theme & layout" section="website" sub="theme" wide styles={['/static/builder.css']} scripts={['/static/builder.js']}>
      <div class="theme-grid">
        <form method="post" action="/app/website/theme" id="theme-form" class="theme-form">
          <Card title="Presets">
            <div class="preset-row">
              {Object.entries(THEME_PRESETS).map(([k, pr]) => (
                <button type="submit" class="preset" formaction={`/app/website/theme/preset/${k}`} title={`Apply ${pr.label}`}>
                  <span class="preset-sw" style={`background:${pr.theme.bg};color:${pr.theme.text};border-color:${pr.theme.border}`}><i style={`background:${pr.theme.accent}`} /><b style={`font-family:${pr.theme.heading_font}`}>Aa</b></span>
                  <span>{pr.label}</span>
                </button>
              ))}
            </div>
          </Card>
          <Card title="Brand">
            <Field label="Logo"><div class="row"><Input name="logo_url" value={pub.logo_url} placeholder="https://…" /><button type="button" class="btn btn-secondary btn-sm" data-upload="logo_url">Upload</button></div></Field>
            <Field label="Favicon"><div class="row"><Input name="favicon_url" value={pub.favicon_url} placeholder="https://…" /><button type="button" class="btn btn-secondary btn-sm" data-upload="favicon_url">Upload</button></div></Field>
          </Card>
          <Card title="Typography">
            <Grid cols={2}>
              <Field label="Body font"><Select name="font" value={firstFont(t.font)} options={FONTS.map((f) => [f, f] as [string, string])} /></Field>
              <Field label="Heading font"><Select name="heading_font" value={firstFont(t.heading_font)} options={FONTS.map((f) => [f, f] as [string, string])} /></Field>
            </Grid>
          </Card>
          <Card title="Colors">
            <Grid cols={2}>
              {colorField('bg', 'Background')}{colorField('surface', 'Surface')}{colorField('text', 'Text')}{colorField('muted', 'Muted text')}{colorField('accent', 'Accent / buttons')}{colorField('accent_text', 'Button text')}{colorField('border', 'Borders')}
            </Grid>
            <Toggle name="dark_mode" checked={t.dark_mode} label="Automatic dark mode" hint="Follows the reader's system setting" />
          </Card>
          <Card title="Shape & layout">
            <Grid cols={2}>
              <Field label={`Corner radius`}><input class="input" type="range" min="0" max="24" name="radius" value={String(t.radius)} /></Field>
              <Field label="Shadows"><Select name="shadow" value={shadowKey(t.shadow)} options={[['none', 'None'], ['soft', 'Soft'], ['strong', 'Strong']]} /></Field>
              <Field label="Home layout"><Select name="layout" value={t.layout} options={[['classic', 'Classic grid'], ['magazine', 'Magazine (featured post)'], ['minimal', 'Minimal list']]} /></Field>
              <Field label="Header"><Select name="header" value={t.header} options={[['left', 'Logo left'], ['center', 'Spread / centered']]} /></Field>
              <Field label="Content width (px)"><Input type="number" name="max_width" value={t.max_width} min={640} max={1600} step="20" /></Field>
            </Grid>
          </Card>
          <Card title="Home hero">
            <Toggle name="show_hero" checked={t.show_hero !== false} label="Show hero with subscribe form" />
            <Field label="Headline" hint="Defaults to your publication name"><Input name="hero_title" value={t.hero_title} placeholder={pub.name} /></Field>
            <Field label="Subheadline" hint="Defaults to your description"><Textarea name="hero_subtitle" value={t.hero_subtitle} rows={2} placeholder={pub.description} /></Field>
            <Field label="Hero image"><div class="row"><Input name="hero_image" value={t.hero_image} placeholder="https://…" /><button type="button" class="btn btn-secondary btn-sm" data-upload="hero_image">Upload</button></div></Field>
            <Help>Want a fully custom home page? Create a page with the slug “/” in <a href="/app/website">Pages</a>.</Help>
          </Card>
          <Card title="Custom CSS">
            <Textarea name="custom_css" value={t.custom_css} rows={6} class="mono" placeholder=".s-hero h1 { letter-spacing: -0.03em; }" />
          </Card>
          <div class="theme-actions"><Btn>Save theme</Btn><span class="muted small">Saved themes are kept in history below.</span></div>
          {versions.length > 0 && (
            <Card title="Theme history">
              <ul class="list-plain">{versions.map((v) => <li class="row between"><span>{fmtDateTime(v.created_at, pub.timezone)}</span><button class="btn btn-ghost btn-sm" formaction={`/app/website/versions/${v.id}/restore`} data-confirm="Restore this theme?">Restore</button></li>)}</ul>
            </Card>
          )}
        </form>
        <div class="theme-preview">
          <div class="row between"><strong>Live preview</strong><div class="device-toggle" data-device><button type="button" class="on" data-w="100%">Desktop</button><button type="button" data-w="390px">Mobile</button></div></div>
          <iframe id="theme-frame" class="preview-frame" title="Theme preview" src="about:blank" />
        </div>
      </div>
    </DashLayout>,
  );
});

dash.post('/theme', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const next = themeFromForm(f, themeOf(pub));
  await run(c.env, 'UPDATE publications SET theme = ?, logo_url = ?, favicon_url = ? WHERE id = ?', JSON.stringify(next), str(f.logo_url, 500) || null, str(f.favicon_url, 500) || null, pub.id);
  await insert(c.env, 'page_versions', { id: id(), page_id: `theme:${pub.id}`, snapshot: JSON.stringify({ theme: next }), created_by: c.get('user').id, created_at: now() });
  await audit(c, 'website.theme.update');
  return back(c, '/app/website/theme', 'Theme saved');
});

dash.post('/theme/preview', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const next = themeFromForm(f, themeOf(pub));
  c.set('pub', { ...pub, theme: JSON.stringify(next), logo_url: str(f.logo_url, 500) || pub.logo_url } as Publication);
  c.set('reader', null);
  const res = await renderHome(c);
  return new Response(await res.text(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
});

dash.post('/theme/preset/:name', async (c) => {
  const pub = c.get('pub');
  const pr = THEME_PRESETS[c.req.param('name')];
  if (!pr) return c.notFound();
  const cur = themeOf(pub);
  const next = { ...cur, ...pr.theme };
  await insert(c.env, 'page_versions', { id: id(), page_id: `theme:${pub.id}`, snapshot: JSON.stringify({ theme: cur }), created_by: c.get('user').id, created_at: now() });
  await run(c.env, 'UPDATE publications SET theme = ? WHERE id = ?', JSON.stringify(next), pub.id);
  return back(c, '/app/website/theme', `${pr.label} theme applied (previous theme saved in history)`);
});

// ───────── Navigation ─────────
dash.get('/nav', async (c) => {
  const pub = c.get('pub');
  const links = await all<any>(c.env, 'SELECT * FROM nav_links WHERE pub_id = ? ORDER BY location, position', pub.id);
  const pages = await all<any>(c.env, `SELECT id, title, slug, show_in_nav, status FROM pages WHERE pub_id = ? AND slug != '' ORDER BY title`, pub.id);
  const linkTable = (loc: string) => {
    const rows = links.filter((l) => l.location === loc);
    return (
      <Table rows={rows} empty="No links yet." cols={[
        { h: 'Label', r: (l) => <form method="post" action={`/app/website/nav/${l.id}`} class="row"><input class="input" name="label" value={l.label} style="max-width:180px" /><input class="input" name="url" value={l.url} /><Btn kind="ghost" small>Save</Btn></form> },
        { h: '', class: 'right nowrap', r: (l) => <><ActionForm action={`/app/website/nav/${l.id}/move`} fields={{ dir: 'up' }} label="↑" kind="ghost" /> <ActionForm action={`/app/website/nav/${l.id}/move`} fields={{ dir: 'down' }} label="↓" kind="ghost" /> <ActionForm action={`/app/website/nav/${l.id}/delete`} label="Remove" kind="danger" /></> },
      ]} />
    );
  };
  return c.html(
    <DashLayout c={c} title="Navigation" section="website" sub="nav">
      <Grid cols={2}>
        <Card title="Header links" pad={false}>{linkTable('header')}</Card>
        <Card title="Footer links" pad={false}>{linkTable('footer')}</Card>
      </Grid>
      <Grid cols={2}>
        <Card title="Add a link">
          <form method="post" action="/app/website/nav" class="stack">
            <Field label="Label"><Input name="label" required placeholder="About" /></Field>
            <Field label="URL" hint="Use /path for pages on your site, or a full https:// link"><Input name="url" required placeholder="/about" /></Field>
            <Field label="Location"><Select name="location" options={[['header', 'Header'], ['footer', 'Footer']]} /></Field>
            <div class="form-actions"><Btn>Add link</Btn></div>
          </form>
        </Card>
        <Card title="Pages in the header">
          {pages.length ? (
            <ul class="list-plain">{pages.map((p) => <li class="row between"><span>{p.title} <Muted>/{p.slug}</Muted> {p.status !== 'published' && <Badge>draft</Badge>}</span><ActionForm action={`/app/website/pages/${p.id}/nav`} label={p.show_in_nav ? 'Shown' : 'Hidden'} kind={p.show_in_nav ? 'secondary' : 'ghost'} /></li>)}</ul>
          ) : <Help>Create pages in <a href="/app/website">Pages</a> to add them here.</Help>}
          <Help>The header always includes Archive, Log in and Subscribe. Signup and login open as modals on every page.</Help>
        </Card>
      </Grid>
    </DashLayout>,
  );
});

dash.post('/nav', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const loc = f.location === 'footer' ? 'footer' : 'header';
  const pos = (await val<number>(c.env, 'SELECT COALESCE(MAX(position), 0) FROM nav_links WHERE pub_id = ? AND location = ?', pub.id, loc)) + 1;
  await insert(c.env, 'nav_links', { id: id(), pub_id: pub.id, location: loc, label: str(f.label, 60), url: str(f.url, 500), position: pos });
  return back(c, '/app/website/nav', 'Link added');
});

dash.post('/nav/:id', async (c) => {
  const f = await form(c.req);
  await run(c.env, 'UPDATE nav_links SET label = ?, url = ? WHERE id = ? AND pub_id = ?', str(f.label, 60), str(f.url, 500), c.req.param('id'), c.get('pub').id);
  return back(c, '/app/website/nav', 'Link saved');
});

dash.post('/nav/:id/delete', async (c) => {
  await run(c.env, 'DELETE FROM nav_links WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
  return back(c, '/app/website/nav', 'Link removed');
});

dash.post('/nav/:id/move', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const l = await one<any>(c.env, 'SELECT * FROM nav_links WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
  if (!l) return c.notFound();
  const rows = await all<any>(c.env, 'SELECT id FROM nav_links WHERE pub_id = ? AND location = ? ORDER BY position', pub.id, l.location);
  const i = rows.findIndex((r) => r.id === l.id);
  const j = f.dir === 'up' ? i - 1 : i + 1;
  if (j >= 0 && j < rows.length) [rows[i], rows[j]] = [rows[j], rows[i]];
  for (let k = 0; k < rows.length; k++) await run(c.env, 'UPDATE nav_links SET position = ? WHERE id = ?', k + 1, rows[k].id);
  return back(c, '/app/website/nav');
});

// ───────── Pop-ups & gating ─────────
dash.get('/popups', async (c) => {
  const pub = c.get('pub');
  const cfg = settings(pub);
  const p = parseJSON<any>(cfg.popup as any, {}) || {};
  return c.html(
    <DashLayout c={c} title="Pop-ups & gating" section="website" sub="popups" scripts={["/static/builder.js"]}>
      <form method="post" action="/app/website/popups">
        <Grid cols={2}>
          <Card title="Subscribe pop-up">
            <Toggle name="enabled" checked={!!p.enabled} label="Show a subscribe pop-up to visitors who aren't subscribed" />
            <Field label="Title"><Input name="title" value={p.title} placeholder={`Join ${pub.name}`} /></Field>
            <Field label="Body"><Textarea name="body" value={p.body} rows={2} placeholder={pub.description} /></Field>
            <Field label="Button label"><Input name="button" value={p.button} placeholder="Subscribe" /></Field>
            <Field label="Image (optional)"><div class="row"><Input name="image" value={p.image} placeholder="https://…" /><button type="button" class="btn btn-secondary btn-sm" data-upload="image">Upload</button></div></Field>
            <Grid cols={2}>
              <Field label="Show after (seconds)" hint="0 = off"><Input type="number" name="delay" value={p.delay ?? 8} min={0} max={600} /></Field>
              <Field label="Show at scroll depth (%)" hint="0 = off"><Input type="number" name="scroll" value={p.scroll ?? 0} min={0} max={100} /></Field>
              <Field label="Show again after (days)"><Input type="number" name="frequency_days" value={p.frequency_days ?? 7} min={0} max={365} /></Field>
            </Grid>
            <Check name="exit" checked={!!p.exit} label="Also show on exit intent (desktop)" />
          </Card>
          <Card title="Gated content">
            <Field label="Metered paywall" hint="Let visitors read this many premium posts free every 30 days before asking them to upgrade. 0 = off (hard paywall)."><Input type="number" name="paywall_meter" value={Number(cfg.paywall_meter) || 0} min={0} max={50} /></Field>
            <Field label="Subscriber-only gate message" hint="Shown on posts whose audience is “free subscribers”, which require readers to subscribe/log in."><Input name="gate_message" value={String(cfg.gate_message || '')} placeholder="This post is for subscribers" /></Field>
            <Field label="Comments"><Select name="comments" value={String(cfg.comments || 'subscribers')} options={[['subscribers', 'Subscribers can comment'], ['premium', 'Premium subscribers only'], ['off', 'Comments off']]} /></Field>
            <Help>Individual pages can be gated too: open a page and set its access to Subscribers or Premium.</Help>
          </Card>
        </Grid>
        <div class="form-actions"><Btn>Save</Btn></div>
      </form>
    </DashLayout>,
  );
});

dash.post('/popups', async (c) => {
  const f = await form(c.req);
  const popup = { enabled: bool(f.enabled), title: str(f.title, 120), body: str(f.body, 500), button: str(f.button, 40), image: str(f.image, 500), delay: int(f.delay, 8), scroll: int(f.scroll, 0), exit: bool(f.exit), frequency_days: int(f.frequency_days, 7) };
  await saveSettings(c, { popup: JSON.stringify(popup), paywall_meter: Math.max(0, int(f.paywall_meter, 0)), gate_message: str(f.gate_message, 200), comments: ['off', 'subscribers', 'premium'].includes(f.comments) ? f.comments : 'subscribers' });
  return back(c, '/app/website/popups', 'Saved');
});

// ───────── Redirects ─────────
const normPath = (p: string) => '/' + str(p, 500).replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+/, '').replace(/\/+$/, '');

dash.get('/redirects', async (c) => {
  const rows = await all<any>(c.env, 'SELECT * FROM redirects WHERE pub_id = ? ORDER BY created_at DESC', c.get('pub').id);
  const base = siteUrl(c.env, c.get('pub'));
  return c.html(
    <DashLayout c={c} title="Redirects" section="website" sub="redirects">
      <Grid cols={2}>
        <Card title="Add redirect">
          <form method="post" action="/app/website/redirects" class="stack">
            <Field label="From path" hint={`Old path on your site, e.g. /2023/my-old-post (relative to ${base})`}><Input name="from_path" required placeholder="/old-path" /></Field>
            <Field label="To" hint="A path on your site (/p/new-slug) or a full URL"><Input name="to_url" required placeholder="/p/new-slug" /></Field>
            <Field label="Type"><Select name="code" options={[['301', '301 — permanent'], ['302', '302 — temporary']]} /></Field>
            <div class="form-actions"><Btn>Add redirect</Btn></div>
          </form>
        </Card>
        <Card title="Bulk import (CSV)">
          <form method="post" action="/app/website/redirects/import" enctype="multipart/form-data" class="stack">
            <Help>Columns: <code>from,to[,code]</code>. One redirect per line. Existing paths are updated.</Help>
            <Field label="CSV file"><input class="input" type="file" name="file" accept=".csv,text/csv" /></Field>
            <Field label="…or paste"><Textarea name="text" rows={4} class="mono" placeholder={'/old,/p/new\n/blog/a,https://example.com/a,302'} /></Field>
            <div class="form-actions"><Btn kind="secondary">Import</Btn></div>
          </form>
        </Card>
      </Grid>
      <Card title={`${rows.length} redirects`} pad={false}>
        <Table rows={rows} empty="No redirects yet. Old links keep working when you rename posts or move from another platform." cols={[
          { h: 'From', r: (r) => <a class="mono" href={base + r.from_path} target="_blank">{r.from_path}</a> },
          { h: 'To', r: (r) => <span class="mono truncate">{r.to_url}</span> },
          { h: 'Type', r: (r) => r.code },
          { h: 'Hits', r: (r) => r.hits },
          { h: '', class: 'right', r: (r) => <ActionForm action={`/app/website/redirects/${r.id}/delete`} label="Delete" kind="danger" /> },
        ]} />
      </Card>
    </DashLayout>,
  );
});

async function upsertRedirect(c: Ctx, from: string, to: string, code: number) {
  await run(c.env, `INSERT INTO redirects (id, pub_id, from_path, to_url, code, hits, created_at) VALUES (?, ?, ?, ?, ?, 0, ?) ON CONFLICT(pub_id, from_path) DO UPDATE SET to_url = excluded.to_url, code = excluded.code`, id(), c.get('pub').id, normPath(from), str(to, 1000), code === 302 ? 302 : 301, now());
}

dash.post('/redirects', async (c) => {
  const f = await form(c.req);
  if (!str(f.from_path) || !str(f.to_url)) return back(c, '/app/website/redirects', 'From and To are required', 'err');
  if (normPath(f.from_path) === '/') return back(c, '/app/website/redirects', 'You cannot redirect the home page', 'err');
  await upsertRedirect(c, f.from_path, f.to_url, int(f.code, 301));
  return back(c, '/app/website/redirects', 'Redirect saved');
});

dash.post('/redirects/import', async (c) => {
  const body = await c.req.parseBody();
  let text = str(body.text, 1_000_000);
  const file = body.file as File | undefined;
  if (file && typeof file !== 'string' && file.size) text = await file.text();
  let n = 0;
  for (const row of parseCSV(text)) {
    const [from, to, code] = row.map((x) => x.trim());
    if (!from || !to || /^from$/i.test(from) || normPath(from) === '/') continue;
    await upsertRedirect(c, from, to, int(code, 301));
    n++;
  }
  return back(c, '/app/website/redirects', `Imported ${n} redirects`);
});

dash.post('/redirects/:id/delete', async (c) => {
  await run(c.env, 'DELETE FROM redirects WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
  return back(c, '/app/website/redirects', 'Redirect deleted');
});

// ───────── SEO & crawlers ─────────
const SEARCH_CRAWLERS = ['Googlebot', 'Bingbot', 'DuckDuckBot', 'YandexBot', 'Baiduspider', 'Applebot'];
const SEO_CRAWLERS = ['AhrefsBot', 'SemrushBot', 'MJ12bot', 'DotBot'];

dash.get('/seo', async (c) => {
  const pub = c.get('pub');
  const cfg = settings(pub);
  const blocked = new Set<string>(cfg.blocked_crawlers || []);
  const base = siteUrl(c.env, pub);
  const hits = await all<any>(c.env, `SELECT bot, category, SUM(CASE WHEN action = 'served' THEN 1 ELSE 0 END) AS served, SUM(CASE WHEN action = 'blocked' THEN 1 ELSE 0 END) AS blocked FROM bot_hits WHERE pub_id = ? AND created_at > ? GROUP BY bot, category ORDER BY served + blocked DESC`, pub.id, now() - 30 * 86400000);
  const hit = (b: string) => hits.find((h) => h.bot === b);
  const group = (title: string, names: string[], hint: string) => (
    <Card title={title}>
      <Help>{hint}</Help>
      {names.map((n) => (
        <label class="check"><input type="checkbox" name="blocked[]" value={n} checked={blocked.has(n)} /><span><strong>{n}</strong> <Muted>{hit(n) ? `· ${hit(n).served} served, ${hit(n).blocked} blocked (30d)` : ''}</Muted></span></label>
      ))}
    </Card>
  );
  return c.html(
    <DashLayout c={c} title="SEO & crawlers" section="website" sub="seo">
      <form method="post" action="/app/website/seo">
        <Grid cols={2}>
          <div>
            <Card title="Search appearance">
              <Field label="Default meta description" hint="Used for pages without their own. Post descriptions are generated automatically from the subtitle or first paragraph when not set."><Textarea name="meta_description" rows={2} value={String(cfg.meta_description || '')} placeholder={pub.description} /></Field>
              <Field label="Google Search Console verification" hint="The content value of the google-site-verification meta tag"><Input name="google_site_verification" value={String(cfg.google_site_verification || '')} /></Field>
              <Field label="Bing Webmaster verification" hint="The content value of the msvalidate.01 meta tag"><Input name="bing_site_verification" value={String(cfg.bing_site_verification || '')} /></Field>
              <Toggle name="google_news" checked={cfg.google_news !== false} label="Google News" hint="Adds NewsArticle structured data (already on every post) and a news sitemap for posts from the last 48 hours." />
            </Card>
            <Card title="Sitemaps & feeds">
              <ul class="list-plain">
                <li><a href={`${base}/sitemap.xml`} target="_blank" class="mono">{base}/sitemap.xml</a></li>
                <li><a href={`${base}/news-sitemap.xml`} target="_blank" class="mono">{base}/news-sitemap.xml</a></li>
                <li><a href={`${base}/feed.xml`} target="_blank" class="mono">{base}/feed.xml</a></li>
                <li><a href={`${base}/robots.txt`} target="_blank" class="mono">{base}/robots.txt</a></li>
              </ul>
            </Card>
            <Card title="robots.txt">
              <Help>Leave empty to use the default. Blocked crawlers below are appended automatically, plus your sitemap lines.</Help>
              <Textarea name="robots_txt" rows={6} class="mono" value={String(cfg.robots_txt || '')} placeholder={'User-agent: *\nAllow: /\nDisallow: /account'} />
              <details><summary class="muted small">Preview generated robots.txt</summary><pre class="code">{buildRobots(pub, base)}</pre></details>
            </Card>
          </div>
          <div>
            <Card title="AI crawlers">
              <Toggle name="block_ai_crawlers" checked={!!cfg.block_ai_crawlers} label="Block all AI crawlers" hint="Blocks AI training and answer-engine bots in robots.txt and at the edge (they get a 403)." />
            </Card>
            {group('Block individual AI crawlers', AI_CRAWLERS, 'Choose exactly which AI bots may read your site.')}
            {group('Search engines', SEARCH_CRAWLERS, 'Blocking search engines removes your site from search results.')}
            {group('SEO tools', SEO_CRAWLERS, 'Third-party SEO crawlers that can be safely blocked.')}
            <Help>See what was served vs. blocked in <a href="/app/analytics/bots">Analytics → Bots & AI crawlers</a>.</Help>
          </div>
        </Grid>
        <div class="form-actions"><Btn>Save SEO settings</Btn></div>
      </form>
    </DashLayout>,
  );
});

dash.post('/seo', async (c) => {
  const f = await form(c.req);
  const verif = (v: any) => str(v, 200).replace(/.*content=["']([^"']+)["'].*/i, '$1').replace(/[<>"]/g, '');
  await saveSettings(c, {
    meta_description: str(f.meta_description, 400), google_site_verification: verif(f.google_site_verification), bing_site_verification: verif(f.bing_site_verification),
    google_news: bool(f.google_news), robots_txt: str(f.robots_txt, 20_000), block_ai_crawlers: bool(f.block_ai_crawlers), blocked_crawlers: (f.blocked || []).map((x: string) => str(x, 60)),
  });
  await audit(c, 'website.seo.update');
  return back(c, '/app/website/seo', 'SEO settings saved');
});

// ───────── Saved templates ─────────
dash.get('/templates', async (c) => {
  const rows = await all<any>(c.env, `SELECT t.*, u.name AS author FROM templates t LEFT JOIN users u ON u.id = t.created_by WHERE t.pub_id = ? AND t.kind IN ('website_page','website_section','website_block') ORDER BY t.kind, t.name`, c.get('pub').id);
  return c.html(
    <DashLayout c={c} title="Saved blocks & pages" section="website" sub="templates">
      <Help>In the page builder, use “Save as block” on any section to add it to your block library, or “Save whole page as template” on the Page tab. Saved blocks appear under “Your blocks” in the builder's “Add section” menu; saved pages appear in the page template gallery when creating a page. Shared with your whole team.</Help>
      <Card title={`${rows.length} templates`} pad={false}>
        <Table rows={rows} empty={<Empty title="No saved templates yet" body="Open a page in the builder and use “Save as block” on a section, or save the whole page as a template." action={<LinkBtn href="/app/website">Go to pages</LinkBtn>} />} cols={[
          { h: 'Name', r: (t) => <form method="post" action={`/app/website/templates/${t.id}/rename`} class="row"><input class="input" name="name" value={t.name} style="max-width:260px" /><Btn kind="ghost" small>Rename</Btn></form> },
          { h: 'Type', r: (t) => <Badge tone={t.kind === 'website_page' ? 'blue' : t.kind === 'website_block' ? 'green' : 'purple'}>{t.kind === 'website_page' ? 'Page' : t.kind === 'website_block' ? 'Block' : 'Section'}</Badge> },
          { h: 'Contents', r: (t) => { const ct = parseJSON<any>(t.content, {}); return <Muted>{t.kind === 'website_page' ? (ct.sections || []).map((s: any) => SECTION_TYPES[s.type]).join(', ') : SECTION_TYPES[ct.section?.type] || '—'}</Muted>; } },
          { h: 'By', r: (t) => <Muted>{t.author || '—'} · {ago(t.created_at)}</Muted> },
          { h: '', class: 'right nowrap', r: (t) => <>{t.kind === 'website_page' && <ActionForm action="/app/website/pages" fields={{ template_id: t.id, title: t.name }} label="New page from this" />} <ActionForm action={`/app/website/templates/${t.id}/delete`} label="Delete" kind="danger" confirm="Delete this template?" /></> },
        ]} />
      </Card>
    </DashLayout>,
  );
});

dash.post('/templates/:id/rename', async (c) => {
  const f = await form(c.req);
  await run(c.env, `UPDATE templates SET name = ?, updated_at = ? WHERE id = ? AND pub_id = ?`, str(f.name, 120) || 'Untitled', now(), c.req.param('id'), c.get('pub').id);
  return back(c, '/app/website/templates', 'Renamed');
});

dash.post('/templates/:id/delete', async (c) => {
  await run(c.env, `DELETE FROM templates WHERE id = ? AND pub_id = ? AND kind LIKE 'website_%'`, c.req.param('id'), c.get('pub').id);
  return back(c, '/app/website/templates', 'Template deleted');
});

export default dash;
