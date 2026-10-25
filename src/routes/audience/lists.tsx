/** @jsxImportSource hono/jsx */
// Newsletter lists, custom fields, CSV import (background job) and exports.
import { Hono } from 'hono';
import type { AppEnv, Env, Publication } from '../../types';
import { one, all, run, val, insert, update, batch, stmt, insertStmt } from '../../lib/db';
import { compile } from '../../lib/segments';
import { validateEmail } from '../../lib/guard';
import { emit } from '../../lib/events';
import { registerJob, enqueue, kick } from '../../lib/jobs';
import { settings } from '../../lib/pub';
import { requirePerm, audit } from '../../lib/auth';
import { Card, Btn, LinkBtn, Field, Input, Textarea, Select, Check, Toggle, Table, Status, Empty, back, Muted, Help, ActionForm, Modal, OpenBtn, Progress, Badge } from '../../ui/components';
import { page, exportCSV } from './shared';
import { form, str, now, id, ago, num, parseJSON, parseCSV, slugify, fmtDateTime } from '../../lib/util';

const app = new Hono<AppEnv>();

// ───────── lists ─────────
app.get('/lists', async (c) => {
  const pub = c.get('pub');
  const lists = await all<any>(c.env, `SELECT l.*, (SELECT COUNT(*) FROM list_members lm JOIN subscribers s ON s.id = lm.subscriber_id WHERE lm.list_id = l.id AND lm.status = 'subscribed' AND s.status = 'active') AS members FROM lists l WHERE l.pub_id = ? ORDER BY l.is_default DESC, l.created_at`, pub.id);
  const segments = await all<any>(c.env, 'SELECT id, name FROM segments WHERE pub_id = ? ORDER BY name', pub.id);
  return page(c, { title: 'Newsletter lists', sub: 'lists', actions: <OpenBtn target="#new-list" small>+ New list</OpenBtn> }, <>
    <Help>Run several newsletters from one publication. Readers choose which lists to join on your signup forms and preference center, and each post can be sent to a specific list.</Help>
    {lists.length ? lists.map((l) => (
      <Card title={<>{l.name} {l.is_default ? <Badge tone="amber">default</Badge> : null} {l.public ? <Badge tone="green">reader-selectable</Badge> : <Badge>hidden</Badge>}</>} actions={<><strong>{num(l.members)}</strong> <Muted>active members</Muted></>}>
        <form method="post" action={`/app/audience/lists/${l.id}`} class="grid g2">
          <Field label="Name"><Input name="name" value={l.name} required /></Field>
          <Field label="Description"><Input name="description" value={l.description} /></Field>
          <div class="row"><Check name="is_default" checked={!!l.is_default} label="Default list for new subscribers" /><Check name="public" checked={!!l.public} label="Readers can choose this list" /></div>
          <div class="row end"><Btn small kind="secondary">Save</Btn></div>
        </form>
        <div class="row between" style="margin-top:8px">
          {segments.length > 0 ? (
            <form method="post" action={`/app/audience/lists/${l.id}/add-segment`} class="row">
              <Muted>Add a whole segment:</Muted>
              <Select name="segment_id" options={segments.map((s) => [s.id, s.name] as [string, string])} attrs={{ style: 'width:auto' }} />
              <Btn small kind="secondary">Add</Btn>
            </form>
          ) : <span />}
          <div class="row">
            <LinkBtn small href={`/app/audience?list=${l.id}`}>View members</LinkBtn>
            {!l.is_default && <ActionForm action={`/app/audience/lists/${l.id}/delete`} label="Delete" kind="danger" confirm="Delete this list? Subscribers stay in your audience." />}
          </div>
        </div>
      </Card>
    )) : <Card><Empty icon="☰" title="No lists yet" body="Create lists like “Weekly digest” and “Breaking news” so readers can pick what they get." action={<OpenBtn target="#new-list">Create a list</OpenBtn>} /></Card>}
    <Modal id="new-list" title="New list">
      <form method="post" action="/app/audience/lists">
        <Field label="Name"><Input name="name" required autofocus /></Field>
        <Field label="Description"><Textarea name="description" rows={2} /></Field>
        <Check name="public" checked label="Readers can choose this list" />
        <Check name="is_default" label="Make it the default list" />
        <div class="form-actions"><Btn>Create list</Btn></div>
      </form>
    </Modal>
  </>);
});

app.post('/lists', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const lid = id();
  const first = !(await one(c.env, 'SELECT 1 FROM lists WHERE pub_id = ?', pub.id));
  if (f.is_default === 'on' || first) await run(c.env, 'UPDATE lists SET is_default = 0 WHERE pub_id = ?', pub.id);
  await insert(c.env, 'lists', { id: lid, pub_id: pub.id, name: str(f.name, 120) || 'Untitled list', description: str(f.description, 500), is_default: f.is_default === 'on' || first ? 1 : 0, public: f.public === 'on' ? 1 : 0, created_at: now() });
  return back(c, '/app/audience/lists', 'List created');
});

app.post('/lists/:id', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  if (f.is_default === 'on') await run(c.env, 'UPDATE lists SET is_default = 0 WHERE pub_id = ?', pub.id);
  await update(c.env, 'lists', c.req.param('id'), { name: str(f.name, 120) || 'Untitled list', description: str(f.description, 500), is_default: f.is_default === 'on' ? 1 : 0, public: f.public === 'on' ? 1 : 0 }, pub.id);
  return back(c, '/app/audience/lists', 'List saved');
});

app.post('/lists/:id/delete', async (c) => {
  await run(c.env, 'DELETE FROM lists WHERE id = ? AND pub_id = ? AND is_default = 0', c.req.param('id'), c.get('pub').id);
  return back(c, '/app/audience/lists', 'List deleted');
});

app.post('/lists/:id/add-segment', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const list = await one<any>(c.env, 'SELECT * FROM lists WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
  if (!list) return back(c, '/app/audience/lists', 'List not found', 'err');
  const cc = await compile(c.env, pub.id, { op: 'and', rules: [{ field: 'segment', cmp: 'in', value: str(f.segment_id) }] });
  const res = await run(c.env, `INSERT INTO list_members (list_id, subscriber_id, status, created_at) SELECT ?, s.id, 'subscribed', ? FROM subscribers s WHERE s.pub_id = ? AND s.status = 'active' AND (${cc.sql}) ON CONFLICT(list_id, subscriber_id) DO UPDATE SET status = 'subscribed'`, list.id, now(), pub.id, ...cc.params);
  return back(c, '/app/audience/lists', `Added ${num(res.meta.changes || 0)} subscribers to ${list.name}`);
});

// ───────── custom fields ─────────
app.get('/fields', async (c) => {
  const pub = c.get('pub');
  const rows = await all<any>(c.env, 'SELECT * FROM custom_fields WHERE pub_id = ? ORDER BY label', pub.id);
  const usage = await Promise.all(rows.map((r) => val<number>(c.env, `SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND json_extract(custom, '$.' || ?) IS NOT NULL`, pub.id, r.key)));
  return page(c, { title: 'Custom fields', sub: 'fields', actions: <OpenBtn target="#new-field" small>+ New field</OpenBtn> }, <>
    <Help>Store extra data on each subscriber (company, birthday, plan…). Use it in segments, merge tags like <code>{'{{custom.company}}'}</code>, forms, imports and the API.</Help>
    {rows.length ? (
      <Table<any> rows={rows} cols={[
        { h: 'Label', r: (r) => <strong>{r.label}</strong> },
        { h: 'Key / merge tag', r: (r) => <code>{`{{custom.${r.key}}}`}</code> },
        { h: 'Type', r: (r) => <Badge>{r.kind}</Badge> },
        { h: 'Options', r: (r) => r.kind === 'list' ? parseJSON<string[]>(r.options, []).join(', ') : <Muted>—</Muted> },
        { h: 'Subscribers with value', r: (r) => num(usage[rows.indexOf(r)]) },
        { h: '', r: (r) => <div class="row end"><OpenBtn target={`#f-${r.id}`} kind="secondary" small>Edit</OpenBtn><ActionForm action={`/app/audience/fields/${r.id}/delete`} label="Delete" kind="danger" confirm="Delete this field definition? Existing values stay on subscribers." /></div> },
      ]} />
    ) : <Card><Empty icon="⊞" title="No custom fields" body="Add fields to collect and segment on extra subscriber data." action={<OpenBtn target="#new-field">New field</OpenBtn>} /></Card>}
    {[null, ...rows].map((r) => (
      <Modal id={r ? `f-${r.id}` : 'new-field'} title={r ? `Edit ${r.label}` : 'New custom field'}>
        <form method="post" action={r ? `/app/audience/fields/${r.id}` : '/app/audience/fields'}>
          <Field label="Label"><Input name="label" value={r?.label} required /></Field>
          {!r && <Field label="Key" hint="Letters, numbers and underscores. Leave blank to generate from the label."><Input name="key" pattern="[a-zA-Z0-9_]*" /></Field>}
          <Field label="Type"><Select name="kind" value={r?.kind || 'text'} options={[['text', 'Text'], ['number', 'Number'], ['date', 'Date'], ['boolean', 'Yes / no'], ['list', 'List of options']]} /></Field>
          <Field label="Options (for list type)" hint="One per line"><Textarea name="options" rows={3} value={r ? parseJSON<string[]>(r.options, []).join('\n') : ''} /></Field>
          <div class="form-actions"><Btn>{r ? 'Save' : 'Create field'}</Btn></div>
        </form>
      </Modal>
    ))}
  </>);
});

app.post('/fields', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const label = str(f.label, 80);
  const key = (str(f.key, 40) || slugify(label, 40)).replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
  if (!key) return back(c, '/app/audience/fields', 'Invalid key', 'err');
  if (await one(c.env, 'SELECT 1 FROM custom_fields WHERE pub_id = ? AND key = ?', pub.id, key)) return back(c, '/app/audience/fields', `A field with key "${key}" already exists`, 'err');
  const kind = ['text', 'number', 'date', 'boolean', 'list'].includes(f.kind) ? f.kind : 'text';
  await insert(c.env, 'custom_fields', { id: id(), pub_id: pub.id, key, label: label || key, kind, options: JSON.stringify(str(f.options).split('\n').map((x) => x.trim()).filter(Boolean)), created_at: now() });
  return back(c, '/app/audience/fields', 'Field created');
});

app.post('/fields/:id', async (c) => {
  const f = await form(c.req);
  const kind = ['text', 'number', 'date', 'boolean', 'list'].includes(f.kind) ? f.kind : 'text';
  await update(c.env, 'custom_fields', c.req.param('id'), { label: str(f.label, 80), kind, options: JSON.stringify(str(f.options).split('\n').map((x) => x.trim()).filter(Boolean)) }, c.get('pub').id);
  return back(c, '/app/audience/fields', 'Field saved');
});

app.post('/fields/:id/delete', async (c) => {
  await run(c.env, 'DELETE FROM custom_fields WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
  return back(c, '/app/audience/fields', 'Field deleted');
});

// ───────── import / export ─────────
app.get('/imports', async (c) => {
  const pub = c.get('pub');
  const imports = await all<any>(c.env, 'SELECT * FROM imports WHERE pub_id = ? ORDER BY created_at DESC LIMIT 30', pub.id);
  const segments = await all<any>(c.env, 'SELECT id, name, cached_count FROM segments WHERE pub_id = ? ORDER BY name', pub.id);
  const running = imports.some((i) => i.status === 'running' || i.status === 'queued');
  return page(c, { title: 'Import & export', sub: 'imports' }, <>
    {running && <meta http-equiv="refresh" content="4" />}
    <div class="grid g2">
      <Card title="Import subscribers from CSV">
        <form method="post" action="/app/audience/imports/upload" enctype="multipart/form-data">
          <Field label="CSV file" hint="Any export from Substack, Mailchimp, ConvertKit, Ghost or a spreadsheet. First row must be column headers; one column must contain email addresses."><input class="input" type="file" name="file" accept=".csv,text/csv" required /></Field>
          <div class="form-actions"><Btn>Upload & map columns</Btn></div>
        </form>
      </Card>
      <Card title="Export">
        <ul class="list-plain">
          <li class="row between"><span>All subscribers (every status, with tags & custom fields)</span><LinkBtn small href="/app/audience/export">Download CSV</LinkBtn></li>
          <li class="row between"><span>Active subscribers only</span><LinkBtn small href="/app/audience/export?status=active">Download CSV</LinkBtn></li>
          {segments.map((s) => <li class="row between"><span>Segment: {s.name} <Muted>({num(s.cached_count)})</Muted></span><LinkBtn small href={`/app/audience/segments/${s.id}/export`}>Download CSV</LinkBtn></li>)}
        </ul>
        <Help>Exports are limited to admins and recorded in the audit log.</Help>
      </Card>
    </div>
    <Card title="Import history" pad={false}>
      <Table<any> rows={imports} empty="No imports yet." cols={[
        { h: 'File', r: (i) => i.filename },
        { h: 'Status', r: (i) => <Status s={i.status === 'done' ? 'completed' : i.status} /> },
        { h: 'Progress', r: (i) => <div style="min-width:140px"><Progress value={i.imported + i.skipped} max={i.total || 1} /><span class="small muted">{num(i.imported + i.skipped)} / {num(i.total)}</span></div> },
        { h: 'Imported', r: (i) => num(i.imported) },
        { h: 'Skipped', r: (i) => i.skipped ? <a href={`/app/audience/imports/${i.id}`}>{num(i.skipped)}</a> : '0' },
        { h: 'Started', r: (i) => ago(i.created_at) },
      ]} />
    </Card>
  </>);
});

app.post('/imports/upload', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const file = f.file as File;
  if (!file || typeof file === 'string' || !file.size) return back(c, '/app/audience/imports', 'Choose a CSV file', 'err');
  if (file.size > 50 * 1024 * 1024) return back(c, '/app/audience/imports', 'CSV is larger than 50 MB — split it into parts', 'err');
  const text = await file.text();
  const rows = parseCSV(text.replace(/^﻿/, ''));
  if (rows.length < 2) return back(c, '/app/audience/imports', 'That CSV has no data rows', 'err');
  const iid = id();
  await c.env.MEDIA.put(`${pub.id}/private/imports/${iid}.csv`, text, { httpMetadata: { contentType: 'text/csv' } });
  await insert(c.env, 'imports', { id: iid, pub_id: pub.id, filename: file.name.slice(0, 200), total: rows.length - 1, imported: 0, skipped: 0, errors: '[]', status: 'mapping', created_by: c.get('user').id, created_at: now() });
  return c.redirect(`/app/audience/imports/${iid}/map`, 303);
});

function guess(h: string): string {
  const k = h.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (/^(email|emailaddress|mail|subscriberemail|e?mail)$/.test(k)) return 'email';
  if (/^(name|fullname|subscribername|displayname)$/.test(k)) return 'name';
  if (/^(firstname|first|givenname)$/.test(k)) return 'first_name';
  if (/^(lastname|last|surname|familyname)$/.test(k)) return 'last_name';
  if (/^(tags?|labels?|groups?)$/.test(k)) return 'tags';
  if (/^(created|createdat|subscribedat|optintime|signupdate|subscribed|date)$/.test(k)) return 'created_at';
  if (/^(utmsource|source)$/.test(k)) return 'utm_source';
  return '';
}

app.get('/imports/:id/map', async (c) => {
  const pub = c.get('pub');
  const imp = await one<any>(c.env, 'SELECT * FROM imports WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
  if (!imp) return back(c, '/app/audience/imports', 'Import not found', 'err');
  const obj = await c.env.MEDIA.get(`${pub.id}/private/imports/${imp.id}.csv`);
  if (!obj) return back(c, '/app/audience/imports', 'Import file missing — upload again', 'err');
  const rows = parseCSV((await obj.text()).replace(/^﻿/, ''));
  const head = rows[0];
  const sample = rows.slice(1, 6);
  const fields = await all<any>(c.env, 'SELECT key, label FROM custom_fields WHERE pub_id = ? ORDER BY label', pub.id);
  const lists = await all<any>(c.env, 'SELECT id, name, is_default FROM lists WHERE pub_id = ? ORDER BY name', pub.id);
  const opts: Array<[string, string]> = [['', 'Ignore'], ['email', 'Email'], ['name', 'Full name'], ['first_name', 'First name'], ['last_name', 'Last name'], ['tags', 'Tags (comma separated)'], ['created_at', 'Subscribed date'], ['utm_source', 'Source / UTM source'], ...fields.map((f) => [`custom:${f.key}`, `Custom: ${f.label}`] as [string, string]), ['new_field', 'Create new custom field from column']];
  const dbl = settings(pub).double_opt_in;
  return page(c, { title: `Import ${imp.filename}`, sub: 'imports', crumbs: [['/app/audience/imports', 'Import & export']] }, (
    <form method="post" action={`/app/audience/imports/${imp.id}/run`}>
      <Card title={`Map columns · ${num(imp.total)} rows`} pad={false}>
        <div class="table-wrap" style="border:0">
          <table class="table">
            <thead><tr>{head.map((h, i) => <th><div>{h || `Column ${i + 1}`}</div><Select name={`col_${i}`} value={guess(h)} options={opts} attrs={{ style: 'min-width:150px;margin-top:6px' }} /></th>)}</tr></thead>
            <tbody>{sample.map((r) => <tr>{head.map((_, i) => <td class="small">{(r[i] || '').slice(0, 60)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </Card>
      <Card title="Options">
        <Field label="Add tags to everyone in this import" hint="Comma separated"><Input name="tags" placeholder={`import-${new Date().toISOString().slice(0, 10)}`} /></Field>
        {lists.length > 0 && <Field label="Add to lists">{lists.map((l) => <Check name="lists[]" value={l.id} label={l.name} checked={!!l.is_default} />)}</Field>}
        <Toggle name="send_welcome" label="Trigger welcome automations for new subscribers" hint="Leave off for migrations from another platform." />
        {dbl ? <Toggle name="require_confirm" label="Send double opt-in confirmation emails" hint="Imported subscribers will be pending until they confirm." /> : null}
        <Toggle name="update_existing" checked label="Update names & custom fields of existing subscribers" />
        <Help>Every address is validated: invalid syntax, disposable domains and typo'd domains (gmial.com) are skipped with a reason. Previously unsubscribed or bounced readers are never resubscribed.</Help>
        <div class="form-actions"><a class="btn btn-ghost" href="/app/audience/imports">Cancel</a><Btn>Start import</Btn></div>
      </Card>
    </form>
  ));
});

app.post('/imports/:id/run', async (c) => {
  const pub = c.get('pub');
  const imp = await one<any>(c.env, `SELECT * FROM imports WHERE id = ? AND pub_id = ? AND status = 'mapping'`, c.req.param('id'), pub.id);
  if (!imp) return back(c, '/app/audience/imports', 'Import not found or already started', 'err');
  const f = await form(c.req);
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) if (k.startsWith('col_') && v) map[k.slice(4)] = String(v);
  if (!Object.values(map).includes('email')) return back(c, `/app/audience/imports/${imp.id}/map`, 'Map one column to Email', 'err');
  // create custom fields for "new_field" columns
  const obj = await c.env.MEDIA.get(`${pub.id}/private/imports/${imp.id}.csv`);
  const head = parseCSV(((await obj?.text()) || '').split('\n')[0] || '')[0] || [];
  for (const [idx, v] of Object.entries(map)) {
    if (v !== 'new_field') continue;
    const label = (head[Number(idx)] || `field_${idx}`).slice(0, 80);
    const key = slugify(label, 40).replace(/-/g, '_');
    await run(c.env, 'INSERT OR IGNORE INTO custom_fields (id, pub_id, key, label, kind, options, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id(), pub.id, key, label, 'text', '[]', now());
    map[idx] = `custom:${key}`;
  }
  const opts = {
    map, tags: str(f.tags).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean), lists: (f.lists as string[]) || [],
    send_welcome: f.send_welcome === 'on', require_confirm: f.require_confirm === 'on', update_existing: f.update_existing === 'on',
  };
  await run(c.env, `UPDATE imports SET status = 'queued', errors = '[]' WHERE id = ?`, imp.id);
  await enqueue(c.env, 'audience.import', { import_id: imp.id, pub_id: pub.id, offset: 1, opts });
  kick(c.env, c.executionCtx);
  await audit(c, 'subscribers.import', imp.id, { rows: imp.total });
  return back(c, '/app/audience/imports', `Import started: ${num(imp.total)} rows`);
});

app.get('/imports/:id', async (c) => {
  const imp = await one<any>(c.env, 'SELECT * FROM imports WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
  if (!imp) return back(c, '/app/audience/imports', 'Import not found', 'err');
  const errors = parseJSON<Array<{ row: number; email: string; reason: string }>>(imp.errors, []);
  return page(c, { title: `Import: ${imp.filename}`, sub: 'imports', crumbs: [['/app/audience/imports', 'Import & export']] }, <>
    <p>{num(imp.imported)} imported · {num(imp.skipped)} skipped · {num(imp.total)} rows · <Status s={imp.status} /></p>
    <Table<any> rows={errors} empty="No skipped rows." cols={[{ h: 'Row', r: (e) => e.row }, { h: 'Email', r: (e) => e.email || <Muted>(empty)</Muted> }, { h: 'Reason', r: (e) => e.reason }]} />
    {imp.skipped > errors.length && <Help>Showing the first {errors.length} skipped rows.</Help>}
  </>);
});

const CHUNK = 250;

/** Process an import chunk with batched writes. Re-enqueues itself until done. */
registerJob('audience.import', async (env: Env, p: any) => {
  const imp = await one<any>(env, 'SELECT * FROM imports WHERE id = ?', p.import_id);
  if (!imp) return;
  const pub = await one<Publication>(env, 'SELECT * FROM publications WHERE id = ?', imp.pub_id);
  const obj = await env.MEDIA.get(`${imp.pub_id}/private/imports/${imp.id}.csv`);
  if (!pub || !obj) { await run(env, `UPDATE imports SET status = 'failed' WHERE id = ?`, imp.id); return; }
  const rows = parseCSV((await obj.text()).replace(/^﻿/, ''));
  const o = p.opts;
  const map: Record<string, string> = o.map;
  const slice = rows.slice(p.offset, p.offset + CHUNK);
  const errors = parseJSON<any[]>(imp.errors, []);
  const blocked = settings(pub).blocked_domains;
  const t = now();
  const parsed: Array<{ row: number; email: string; name: string; tags: string[]; custom: Record<string, string>; created: number | null; utm: string | null }> = [];
  const seen = new Set<string>();
  let skipped = 0;
  slice.forEach((r, i) => {
    const rec = { row: p.offset + i + 1, email: '', name: '', first: '', last: '', tags: [] as string[], custom: {} as Record<string, string>, created: null as number | null, utm: null as string | null };
    for (const [idx, target] of Object.entries(map)) {
      const v = (r[Number(idx)] || '').trim();
      if (!v) continue;
      if (target === 'email') rec.email = v.toLowerCase();
      else if (target === 'name') rec.name = v;
      else if (target === 'first_name') rec.first = v;
      else if (target === 'last_name') rec.last = v;
      else if (target === 'tags') rec.tags.push(...v.split(/[,;|]/).map((x) => x.trim().toLowerCase()).filter(Boolean));
      else if (target === 'created_at') { const d = Date.parse(v); if (!isNaN(d)) rec.created = d; }
      else if (target === 'utm_source') rec.utm = v.slice(0, 120);
      else if (target.startsWith('custom:')) rec.custom[target.slice(7)] = v.slice(0, 500);
    }
    if (!rec.name && (rec.first || rec.last)) rec.name = `${rec.first} ${rec.last}`.trim();
    parsed.push({ row: rec.row, email: rec.email, name: rec.name.slice(0, 120), tags: rec.tags, custom: rec.custom, created: rec.created, utm: rec.utm });
  });
  const valid: typeof parsed = [];
  for (const r of parsed) {
    const v = await validateEmail(r.email, { extraBlocked: blocked });
    if (!v.ok) { skipped++; if (errors.length < 500) errors.push({ row: r.row, email: r.email, reason: v.reason || 'invalid' }); continue; }
    if (seen.has(v.email)) { skipped++; if (errors.length < 500) errors.push({ row: r.row, email: r.email, reason: 'Duplicate row in file' }); continue; }
    seen.add(v.email);
    valid.push({ ...r, email: v.email });
  }
  // existing subscribers + global suppressions
  const existing = new Map<string, any>();
  const suppressed = new Set<string>();
  for (let i = 0; i < valid.length; i += 90) {
    const ch = valid.slice(i, i + 90).map((r) => r.email);
    for (const s of await all<any>(env, `SELECT id, email, status, name, custom FROM subscribers WHERE pub_id = ? AND email IN (${ch.map(() => '?').join(',')})`, pub.id, ...ch)) existing.set(s.email, s);
    for (const s of await all<any>(env, `SELECT email FROM suppressions WHERE email IN (${ch.map(() => '?').join(',')}) AND scope = 'global' AND (expires_at IS NULL OR expires_at > ?)`, ...ch, t)) suppressed.add(s.email);
  }
  const stmts: D1PreparedStatement[] = [];
  const newIds: string[] = [];
  let imported = 0;
  for (const r of valid) {
    const ex = existing.get(r.email);
    let sid: string;
    if (ex) {
      sid = ex.id;
      if (o.update_existing) {
        const custom = { ...parseJSON(ex.custom, {}), ...r.custom };
        stmts.push(stmt(env, 'UPDATE subscribers SET name = CASE WHEN ? != \'\' THEN ? ELSE name END, custom = ?, updated_at = ? WHERE id = ?', r.name, r.name, JSON.stringify(custom), t, sid));
      }
      imported++;
    } else if (suppressed.has(r.email)) {
      skipped++;
      if (errors.length < 500) errors.push({ row: r.row, email: r.email, reason: 'Address previously hard-bounced or complained (suppressed)' });
      continue;
    } else {
      sid = id();
      newIds.push(sid);
      stmts.push(insertStmt(env, 'subscribers', {
        id: sid, pub_id: pub.id, email: r.email, name: r.name, status: o.require_confirm ? 'pending' : 'active', tier: 'free', source: 'import', source_detail: imp.id,
        utm_source: r.utm, referral_code: id(10), custom: JSON.stringify(r.custom), confirmed_at: o.require_confirm ? null : t, created_at: r.created || t, updated_at: t,
      }, true));
      imported++;
    }
    for (const tag of [...r.tags, ...o.tags]) stmts.push(stmt(env, 'INSERT OR IGNORE INTO subscriber_tags (pub_id, subscriber_id, tag, created_at) VALUES (?, ?, ?, ?)', pub.id, sid, tag.slice(0, 60), t));
    for (const lid of o.lists) stmts.push(stmt(env, `INSERT INTO list_members (list_id, subscriber_id, status, created_at) SELECT ?, ?, 'subscribed', ? WHERE EXISTS (SELECT 1 FROM lists WHERE id = ? AND pub_id = ?) ON CONFLICT(list_id, subscriber_id) DO NOTHING`, lid, sid, t, lid, pub.id));
  }
  await batch(env, stmts);
  // lifecycle for newly created subscribers
  if (newIds.length && (o.send_welcome || o.require_confirm)) {
    const { sendConfirmation } = await import('../../lib/subscribers');
    for (const sid of newIds) {
      const sub = await one<any>(env, 'SELECT * FROM subscribers WHERE id = ?', sid);
      if (!sub) continue;
      if (o.require_confirm) await sendConfirmation(env, pub, sub);
      else {
        await emit(env, { pubId: pub.id, type: 'subscription.created', subscriberId: sid, data: { source: 'import' } });
        await emit(env, { pubId: pub.id, type: 'subscriber.welcome', subscriberId: sid, activity: false });
      }
    }
  } else if (newIds.length) {
    for (const sid of newIds) await insert(env, 'activity', { id: id(), pub_id: pub.id, subscriber_id: sid, type: 'subscribed', ref_id: imp.id, data: JSON.stringify({ source: 'import' }), created_at: t });
  }
  const nextOffset = p.offset + CHUNK;
  const done = nextOffset >= rows.length;
  await run(env, `UPDATE imports SET imported = imported + ?, skipped = skipped + ?, errors = ?, status = ? WHERE id = ?`, imported, skipped, JSON.stringify(errors), done ? 'done' : 'running', imp.id);
  if (done) await env.MEDIA.delete(`${imp.pub_id}/private/imports/${imp.id}.csv`);
  else await enqueue(env, 'audience.import', { ...p, offset: nextOffset });
});

export default app;
