/** @jsxImportSource hono/jsx */
// Media library (shared upload endpoints for every module), content tags, AI writing endpoint.
import { Hono } from 'hono';
import type { AppEnv } from '../../types';
import { all, one, run, insert, val } from '../../lib/db';
import { storeFile, importFromUrl } from '../../lib/media';
import { aiText, aiImage, aiEnabled, mediaUrl, AI_DISABLED_MSG } from '../../lib/ai';
import { DashLayout } from '../../ui/layout';
import { Card, Table, Btn, Empty, Input, Field, back, ActionForm, Modal, OpenBtn } from '../../ui/components';
import { id, now, str, form, slugify, fmtDate, qs, num } from '../../lib/util';

const app = new Hono<AppEnv>();

const TYPE_SQL: Record<string, string> = { image: `mime LIKE 'image/%'`, audio: `mime LIKE 'audio/%'`, video: `mime LIKE 'video/%'`, file: `mime NOT LIKE 'image/%' AND mime NOT LIKE 'audio/%' AND mime NOT LIKE 'video/%'` };

function fmtSize(n: number) {
  return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

app.post('/media/upload', async (c) => {
  const pub = c.get('pub');
  const body = await c.req.parseBody({ all: true });
  const files = ([] as any[]).concat(body.file || body['file[]'] || []).filter((f) => f instanceof File);
  if (!files.length) return c.json({ error: 'No file uploaded' }, 400);
  try {
    const out = [];
    for (const f of files.slice(0, 20)) {
      const folder = String(body.folder || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 30) || 'uploads';
      out.push(await storeFile(c.env, pub.id, f as File, { folder, userId: c.get('user').id, alt: String(body.alt || '') }));
    }
    const accept = c.req.header('accept') || '';
    if (!accept.includes('json') && c.req.header('content-type')?.includes('multipart') && body.redirect) return back(c, '/app/posts/media', `${out.length} file(s) uploaded`);
    return c.json(out.length === 1 ? out[0] : { files: out });
  } catch (e: any) {
    return c.json({ error: e.message || 'Upload failed' }, 400);
  }
});

app.get('/media.json', async (c) => {
  const pub = c.get('pub');
  const type = c.req.query('type') || '';
  const q = c.req.query('q') || '';
  const before = Number(c.req.query('before') || 0);
  const where = ['pub_id = ?'];
  const params: unknown[] = [pub.id];
  if (TYPE_SQL[type]) where.push(TYPE_SQL[type]);
  if (q) { where.push('(name LIKE ? OR alt LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (before) { where.push('created_at < ?'); params.push(before); }
  const rows = await all<any>(c.env, `SELECT * FROM uploads WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 60`, ...params);
  return c.json({ items: rows.map((r) => ({ id: r.id, url: mediaUrl(c.env, r.key), name: r.name, mime: r.mime, size: r.size, alt: r.alt, source: r.source, created_at: r.created_at })), next: rows.length === 60 ? rows[59].created_at : null });
});

app.post('/media/import', async (c) => {
  const pub = c.get('pub');
  const isJson = (c.req.header('content-type') || '').includes('json');
  const b: any = isJson ? await c.req.json() : await form(c.req);
  const url = str(b.url, 2000);
  try {
    if (!/^https?:\/\//.test(url)) throw new Error('Enter a valid http(s) URL');
    const r = await importFromUrl(c.env, pub.id, url, c.get('user').id);
    return isJson ? c.json(r) : back(c, '/app/posts/media', 'Imported from URL');
  } catch (e: any) {
    return isJson ? c.json({ error: e.message }, 400) : back(c, '/app/posts/media', e.message, 'err');
  }
});

app.post('/media/ai', async (c) => {
  const pub = c.get('pub');
  const isJson = (c.req.header('content-type') || '').includes('json');
  const b: any = isJson ? await c.req.json() : await form(c.req);
  const prompt = str(b.prompt, 1000);
  if (!prompt) return isJson ? c.json({ error: 'Describe the image' }, 400) : back(c, '/app/posts/media', 'Describe the image', 'err');
  const r = await aiImage(c.env, pub.id, prompt, c.get('user').id);
  if (isJson) return r.ok ? c.json({ url: r.url }) : c.json({ error: r.error }, 400);
  return back(c, '/app/posts/media', r.ok ? 'Image generated and added to your library' : r.error || 'Failed', r.ok ? 'ok' : 'err');
});

app.post('/media/:id/alt', async (c) => {
  const f = await form(c.req);
  await run(c.env, 'UPDATE uploads SET alt = ?, name = COALESCE(NULLIF(?, \'\'), name) WHERE id = ? AND pub_id = ?', str(f.alt, 300), str(f.name, 200), c.req.param('id'), c.get('pub').id);
  return back(c, '/app/posts/media', 'Saved');
});

app.post('/media/:id/delete', async (c) => {
  const pub = c.get('pub');
  const u = await one<any>(c.env, 'SELECT * FROM uploads WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
  if (u) {
    await c.env.MEDIA.delete(u.key);
    await run(c.env, 'DELETE FROM uploads WHERE id = ?', u.id);
  }
  return back(c, '/app/posts/media' + qs({ type: c.req.query('type') }), 'File deleted');
});

app.get('/media', async (c) => {
  const pub = c.get('pub');
  const type = c.req.query('type') || '';
  const q = c.req.query('q') || '';
  const where = ['pub_id = ?'];
  const params: unknown[] = [pub.id];
  if (TYPE_SQL[type]) where.push(TYPE_SQL[type]);
  if (q) { where.push('(name LIKE ? OR alt LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const rows = await all<any>(c.env, `SELECT * FROM uploads WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, ...params);
  const used = await val<number>(c.env, 'SELECT COALESCE(SUM(size), 0) FROM uploads WHERE pub_id = ?', pub.id);
  const tab = (t: string, l: string) => <a href={'/app/posts/media' + qs({ type: t || undefined, q })} class={type === t ? 'on' : ''}>{l}</a>;
  return c.html(
    <DashLayout c={c} title="Media library" section="posts" sub="media" styles={['/static/editor.css']} scripts={['/static/posts-media.js']}
      actions={<>
        <OpenBtn target="#m-url" kind="secondary">Import URL</OpenBtn>
        <OpenBtn target="#m-ai" kind="secondary">✨ AI image</OpenBtn>
        <label class="btn btn-primary" for="media-files">Upload files</label>
      </>}>
      <input type="file" id="media-files" multiple hidden />
      <div class="pe-drop" id="media-drop"><strong>Drop files here</strong> <span class="muted">— images are resized and optimized automatically · {fmtSize(used)} used</span><div class="pe-upload-progress" id="media-progress" /></div>
      <div class="row between" style="margin:14px 0">
        <nav class="tabs" style="margin:0;border:0">{tab('', 'All')}{tab('image', 'Images')}{tab('audio', 'Audio')}{tab('video', 'Video')}{tab('file', 'Files')}</nav>
        <form method="get" class="row">{type && <input type="hidden" name="type" value={type} />}<Input name="q" value={q} placeholder="Search by name or alt text" /></form>
      </div>
      {rows.length === 0 ? <Card><Empty icon="🖼" title="No media yet" body="Upload images, audio, video and files to reuse them across posts, pages and products." /></Card> : (
        <div class="pe-media-grid">
          {rows.map((r) => {
            const url = mediaUrl(c.env, r.key);
            return (
              <div class="pe-media-item">
                <div class="pe-media-prev">
                  {r.mime.startsWith('image/') ? <img src={url} alt={r.alt} loading="lazy" /> : r.mime.startsWith('audio/') ? <audio src={url} controls preload="none" /> : r.mime.startsWith('video/') ? <video src={url} preload="metadata" muted /> : <span class="pe-media-ext">{(r.name.split('.').pop() || 'file').toUpperCase()}</span>}
                </div>
                <div class="pe-media-meta">
                  <div class="truncate small" title={r.name} style="max-width:100%"><strong>{r.name}</strong></div>
                  <div class="small muted">{fmtSize(r.size)} · {fmtDate(r.created_at)}{r.source !== 'upload' ? ` · ${r.source}` : ''}</div>
                  {r.mime.startsWith('image/') && !r.alt && <div class="small" style="color:#b45309">⚠ Missing alt text</div>}
                  <form method="post" action={`/app/posts/media/${r.id}/alt`} class="row" style="gap:4px;margin-top:6px;flex-wrap:nowrap">
                    <input class="input" name="alt" value={r.alt} placeholder="Alt text" style="height:30px" aria-label="Alt text" />
                    <Btn small kind="secondary">Save</Btn>
                  </form>
                  <div class="row" style="gap:4px;margin-top:6px">
                    <button type="button" class="btn btn-ghost btn-sm" data-copy={url}>Copy URL</button>
                    <a class="btn btn-ghost btn-sm" href={url} target="_blank">Open</a>
                    <ActionForm action={`/app/posts/media/${r.id}/delete${type ? '?type=' + type : ''}`} label="Delete" kind="danger" confirm="Delete this file? Posts using it will show a broken image." />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <Modal id="m-url" title="Import from URL">
        <form method="post" action="/app/posts/media/import" class="stack"><Field label="Image or file URL"><Input name="url" type="url" required placeholder="https://…" /></Field><div class="form-actions"><Btn>Import</Btn></div></form>
      </Modal>
      <Modal id="m-ai" title="Generate an image with AI">
        {aiEnabled(c.env) ? (
          <form method="post" action="/app/posts/media/ai" class="stack"><Field label="Describe the image"><textarea class="input" name="prompt" rows={3} required placeholder="A watercolor illustration of a lighthouse at dawn" /></Field><div class="form-actions"><Btn>Generate</Btn></div></form>
        ) : <p class="muted">{AI_DISABLED_MSG}</p>}
      </Modal>
    </DashLayout>,
  );
});

// ───────── content tags ─────────
app.get('/tags', async (c) => {
  const pub = c.get('pub');
  const rows = await all<any>(c.env, 'SELECT t.*, (SELECT COUNT(*) FROM post_tags pt WHERE pt.tag_id = t.id) AS posts FROM content_tags t WHERE t.pub_id = ? ORDER BY t.name', pub.id);
  return c.html(
    <DashLayout c={c} title="Content tags" section="posts" sub="tags">
      <div class="split">
        <Card title="Tags" pad={false}>
          <Table rows={rows} empty="No tags yet. Tags group posts on your website (/tag/…)." cols={[
            { h: 'Name', r: (t) => (
              <form method="post" action={`/app/posts/tags/${t.id}`} class="row" style="flex-wrap:nowrap;gap:6px">
                <input class="input" name="name" value={t.name} style="height:30px" aria-label="Name" />
                <input class="input" name="description" value={t.description} placeholder="Description" style="height:30px" aria-label="Description" />
                <Btn small kind="secondary">Save</Btn>
              </form>
            ) },
            { h: 'Slug', r: (t) => <code>/tag/{t.slug}</code> },
            { h: 'Posts', r: (t) => num(t.posts), class: 'right' },
            { h: '', r: (t) => <ActionForm action={`/app/posts/tags/${t.id}/delete`} label="Delete" kind="danger" confirm={`Delete tag “${t.name}”?`} /> },
          ]} />
        </Card>
        <Card title="New tag">
          <form method="post" action="/app/posts/tags" class="stack">
            <Field label="Name"><Input name="name" required maxlength={60} /></Field>
            <Field label="Description"><textarea class="input" name="description" rows={3} /></Field>
            <Btn>Create tag</Btn>
          </form>
        </Card>
      </div>
    </DashLayout>,
  );
});

app.post('/tags', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const name = str(f.name, 60);
  if (!name) return back(c, '/app/posts/tags', 'Name required', 'err');
  const slug = slugify(name);
  if (await one(c.env, 'SELECT id FROM content_tags WHERE pub_id = ? AND slug = ?', pub.id, slug)) return back(c, '/app/posts/tags', 'A tag with that name exists', 'err');
  await insert(c.env, 'content_tags', { id: id(), pub_id: pub.id, name, slug, description: str(f.description, 500) });
  return back(c, '/app/posts/tags', 'Tag created');
});

app.post('/tags/:id', async (c) => {
  const f = await form(c.req);
  const name = str(f.name, 60);
  if (!name) return back(c, '/app/posts/tags', 'Name required', 'err');
  await run(c.env, 'UPDATE content_tags SET name = ?, description = ? WHERE id = ? AND pub_id = ?', name, str(f.description, 500), c.req.param('id'), c.get('pub').id);
  return back(c, '/app/posts/tags', 'Tag saved');
});

app.post('/tags/:id/delete', async (c) => {
  await run(c.env, 'DELETE FROM content_tags WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
  return back(c, '/app/posts/tags', 'Tag deleted');
});

// ───────── AI writing assistant (in-place) ─────────
const PROMPTS: Record<string, (b: any) => string> = {
  rewrite: (b) => `Rewrite the following text to be clearer and more engaging. Keep the meaning and roughly the same length.\n\n${b.text}`,
  shorten: (b) => `Make this text about half as long while keeping the key points:\n\n${b.text}`,
  expand: (b) => `Expand this text with more detail and an example, keeping the same voice:\n\n${b.text}`,
  fix: (b) => `Fix spelling, grammar and punctuation in this text. Change nothing else:\n\n${b.text}`,
  translate: (b) => `Translate this text into ${b.lang || 'Spanish'}. Keep formatting:\n\n${b.text}`,
  tone: (b) => `Rewrite this text in a ${b.tone || 'friendly'} tone:\n\n${b.text}`,
  summarize: (b) => `Summarize this newsletter in 3 short bullet points (use "- " bullets):\n\n${b.text}`,
  subject_lines: (b) => `Suggest 5 compelling email subject lines (under 60 characters, no numbering, one per line) for this newsletter:\n\n${b.text}`,
  outline: (b) => `Write a newsletter outline with section headings (one per line, prefix headings with "## ") about: ${b.prompt || b.text}`,
  write: (b) => `Write newsletter content (2-4 short paragraphs, separated by blank lines) about: ${b.prompt}\n\nContext from the draft so far:\n${(b.text || '').slice(0, 3000)}`,
};

app.post('/ai', async (c) => {
  const pub = c.get('pub');
  const b = await c.req.json<any>().catch(() => ({}));
  if (b.action === 'image') {
    const r = await aiImage(c.env, pub.id, str(b.prompt || b.text, 1000), c.get('user').id);
    return r.ok ? c.json({ url: r.url }) : c.json({ error: r.error }, 400);
  }
  const p = PROMPTS[b.action];
  if (!p) return c.json({ error: 'Unknown action' }, 400);
  if (!aiEnabled(c.env)) return c.json({ error: AI_DISABLED_MSG }, 400);
  const r = await aiText(c.env, p({ ...b, text: str(b.text, 12000), prompt: str(b.prompt, 2000) }), `You are an expert newsletter editor for "${pub.name}". Reply with the resulting text only — no preamble, no quotes around it.`);
  return r.ok ? c.json({ text: r.text }) : c.json({ error: r.text }, 400);
});

export default app;
