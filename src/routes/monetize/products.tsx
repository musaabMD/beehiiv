/** @jsxImportSource hono/jsx */
// Digital products: files, links, guides, templates, ebooks, memberships, 1:1 coaching, replays.
import type { Hono } from 'hono';
import type { AppEnv, Ctx } from '../../types';
import { one, all, run, insert, val } from '../../lib/db';
import { requirePerm } from '../../lib/auth';
import { siteUrl } from '../../lib/pub';
import { storeFile } from '../../lib/media';
import { mediaUrl } from '../../lib/ai';
import { CURRENCIES } from '../../lib/billing';
import { DashLayout } from '../../ui/layout';
import { Card, Stats, Stat, Table, Btn, LinkBtn, Field, Input, Textarea, Select, Status, Empty, ActionForm, back, Grid, Copy, Badge, Help } from '../../ui/components';
import { id, now, money, num, fmtDate, fmtDateTime, form, str, int, cents, slugify, parseJSON } from '../../lib/util';

export const KINDS: Array<[string, string]> = [['download', 'File download'], ['ebook', 'Ebook'], ['template', 'Template'], ['guide', 'Guide (written content)'], ['link', 'Link / external access'], ['membership', 'Membership (time-based)'], ['coaching', '1:1 coaching session'], ['replay', 'Event replay']];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function uniqueSlug(c: Ctx, base: string, exceptId?: string) {
  let slug = slugify(base, 60), i = 2;
  while (await one(c.env, 'SELECT 1 FROM products WHERE pub_id = ? AND slug = ? AND id != ?', c.get('pub').id, slug, exceptId || '')) slug = `${slugify(base, 55)}-${i++}`;
  return slug;
}

function productForm(c: Ctx, p: any | null, automations: any[]) {
  const coaching = parseJSON<any>(p?.coaching, { duration_min: 30, tz: c.get('pub').timezone || 'UTC', availability: [1, 2, 3, 4, 5].map((d) => ({ dow: d, start: '09:00', end: '17:00' })) });
  const avail = (dow: number) => (coaching.availability || []).find((a: any) => Number(a.dow) === dow);
  return (
    <form method="post" action={p ? `/app/monetize/products/${p.id}` : '/app/monetize/products'} enctype="multipart/form-data">
      <Card title="Product">
        <Grid>
          <Field label="Name"><Input name="name" value={p?.name} required placeholder="The Creator Playbook" /></Field>
          <Field label="Type"><Select name="kind" value={p?.kind || 'download'} options={KINDS} attrs={{ 'data-kind-select': '1' }} /></Field>
          <Field label="Price" hint="0 = free lead magnet (buyers become subscribers)"><Input name="price" type="number" step="0.01" min="0" value={p ? (p.price_cents / 100).toFixed(2) : '19.00'} /></Field>
          <Field label="Currency"><Select name="currency" value={p?.currency || 'usd'} options={CURRENCIES.map((x) => [x, x.toUpperCase()] as [string, string])} /></Field>
        </Grid>
        <Field label="Description" hint="Shown on the product page. Blank lines start new paragraphs."><Textarea name="description" rows={5} value={p?.description} /></Field>
        <Grid>
          <Field label="Cover image URL"><Input name="cover_url" value={p?.cover_url} placeholder="https://…" /></Field>
          <Field label="…or upload cover"><input class="input" type="file" name="cover" accept="image/*" /></Field>
          <Field label="Tags" hint="Comma separated — used to organize the storefront"><Input name="tags" value={parseJSON<string[]>(p?.tags, []).join(', ')} /></Field>
          <Field label="Status"><Select name="status" value={p?.status || 'active'} options={[['active', 'Active (on sale)'], ['draft', 'Draft (hidden)'], ['archived', 'Archived']]} /></Field>
        </Grid>
      </Card>
      <Card title="Delivery">
        <Help>What the buyer gets immediately after paying. Delivered automatically by email and on the order page.</Help>
        <Grid>
          <Field label="File (download, ebook, template, replay)" hint={p?.file_key ? `Current: ${p.file_key.split('/').pop()}` : 'Stored privately; buyers get expiring download links'}><input class="input" type="file" name="file" /></Field>
          <Field label="Link URL (link products)"><Input name="link_url" value={p?.link_url} placeholder="https://notion.so/…" /></Field>
          <Field label="Access length in days (memberships)" hint="Blank = lifetime"><Input name="access_days" type="number" min="1" value={p?.access_days ?? ''} /></Field>
          <Field label="Follow-up automation" hint="Enrolls the buyer after purchase"><Select name="automation_id" value={p?.automation_id || ''} options={[['', 'None'], ...automations.map((a) => [a.id, a.name] as [string, string])]} /></Field>
        </Grid>
        <Field label="Guide / membership content" hint="HTML allowed; shown to buyers on their order page"><Textarea name="content" rows={8} value={p?.content} /></Field>
      </Card>
      <Card title="1:1 coaching availability">
        <Grid>
          <Field label="Session length (minutes)"><Input name="duration_min" type="number" min="15" step="5" value={coaching.duration_min} /></Field>
          <Field label="Timezone"><Input name="tz" value={coaching.tz} placeholder="America/New_York" /></Field>
        </Grid>
        <Field label="Location / meeting link" hint="Sent in the confirmation and calendar invite"><Input name="location" value={coaching.location} placeholder="https://meet.google.com/…" /></Field>
        <table class="table">
          <thead><tr><th>Day</th><th>Available</th><th>From</th><th>To</th></tr></thead>
          <tbody>{DOW.map((d, i) => (
            <tr><td>{d}</td><td><input type="checkbox" name={`av_on_${i}`} checked={!!avail(i)} /></td><td><input class="input" type="time" name={`av_start_${i}`} value={avail(i)?.start || '09:00'} /></td><td><input class="input" type="time" name={`av_end_${i}`} value={avail(i)?.end || '17:00'} /></td></tr>
          ))}</tbody>
        </table>
      </Card>
      <div class="form-actions"><Btn>{p ? 'Save product' : 'Create product'}</Btn></div>
    </form>
  );
}

async function readProduct(c: Ctx, f: Record<string, any>, existing?: any) {
  const pub = c.get('pub');
  const availability = DOW.map((_, i) => (f[`av_on_${i}`] ? { dow: i, start: str(f[`av_start_${i}`]) || '09:00', end: str(f[`av_end_${i}`]) || '17:00' } : null)).filter(Boolean);
  const row: Record<string, unknown> = {
    name: str(f.name, 160) || 'Untitled product', kind: KINDS.some(([k]) => k === f.kind) ? f.kind : 'download', price_cents: cents(f.price), currency: CURRENCIES.includes(f.currency) ? f.currency : 'usd',
    description: str(f.description, 20000), cover_url: str(f.cover_url, 1000) || null, link_url: str(f.link_url, 2000) || null, content: str(f.content, 200000) || null,
    access_days: f.access_days ? Math.max(1, int(f.access_days)) : null, tags: JSON.stringify(str(f.tags, 500).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)),
    status: ['active', 'draft', 'archived'].includes(f.status) ? f.status : 'active', automation_id: str(f.automation_id) || null,
    coaching: JSON.stringify({ duration_min: Math.max(15, int(f.duration_min, 30)), tz: str(f.tz, 60) || 'UTC', location: str(f.location, 500), availability }),
  };
  if (f.cover instanceof File && f.cover.size) row.cover_url = (await storeFile(c.env, pub.id, f.cover, { folder: 'products', userId: c.get('user').id })).url;
  if (f.file instanceof File && f.file.size) row.file_key = (await storeFile(c.env, pub.id, f.file, { folder: 'private/products', userId: c.get('user').id })).key;
  if (!existing && !row.cover_url) row.cover_url = null;
  return row;
}

export function registerProducts(dash: Hono<AppEnv>) {
  dash.get('/products', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const tag = c.req.query('tag') || '';
    const products = await all<any>(c.env, `SELECT p.*, (SELECT COUNT(*) FROM product_reviews r WHERE r.product_id = p.id AND r.status = 'pending') AS pending_reviews FROM products p WHERE p.pub_id = ? ${tag ? `AND p.tags LIKE ?` : ''} ORDER BY p.status = 'archived', p.created_at DESC`, pub.id, ...(tag ? [`%"${tag}"%`] : []));
    const allTags = [...new Set((await all<any>(c.env, 'SELECT tags FROM products WHERE pub_id = ?', pub.id)).flatMap((r) => parseJSON<string[]>(r.tags, [])))];
    const totals = await one<any>(c.env, `SELECT COALESCE(SUM(sales_count),0) AS sales, COALESCE(SUM(revenue_cents),0) AS revenue FROM products WHERE pub_id = ?`, pub.id);
    const base = siteUrl(c.env, pub);
    return c.html(
      <DashLayout c={c} title="Digital products" section="monetize" sub="products" actions={<><LinkBtn href={`${base}/shop`} target="_blank">View storefront</LinkBtn><LinkBtn href="/app/monetize/products/new" kind="primary">+ New product</LinkBtn></>}>
        <Stats>
          <Stat label="Products" value={num(products.filter((p) => p.status === 'active').length)} sub={`${products.length} total`} />
          <Stat label="Sales" value={num(totals.sales)} />
          <Stat label="Revenue" value={money(totals.revenue, products[0]?.currency || 'usd')} sub="0% platform fees" />
        </Stats>
        {allTags.length > 0 && <div class="row" style="margin-bottom:12px"><a class={`btn btn-sm ${!tag ? 'btn-primary' : 'btn-ghost'}`} href="/app/monetize/products">All</a>{allTags.map((t) => <a class={`btn btn-sm ${tag === t ? 'btn-primary' : 'btn-ghost'}`} href={`?tag=${encodeURIComponent(t)}`}>#{t}</a>)}</div>}
        <Card pad={false}>
          <Table rows={products} rowHref={(p) => `/app/monetize/products/${p.id}`} empty={<Empty icon="🛍" title="Sell your first digital product" body="Files, guides, templates, ebooks, memberships and 1:1 coaching — delivered automatically, sold on your site and inside emails. Free products work as lead magnets." action={<a class="btn btn-primary" href="/app/monetize/products/new">Create a product</a>} />} cols={[
            { h: '', r: (p) => (p.cover_url ? <img class="thumb" src={p.cover_url} alt="" /> : <div class="thumb" />) },
            { h: 'Product', r: (p) => <><a href={`/app/monetize/products/${p.id}`}>{p.name}</a><br /><small class="muted">{KINDS.find(([k]) => k === p.kind)?.[1]}{parseJSON<string[]>(p.tags, []).map((t) => ` #${t}`).join('')}</small></> },
            { h: 'Price', r: (p) => (p.price_cents ? money(p.price_cents, p.currency) : <Badge tone="green">Free</Badge>) },
            { h: 'Sales', r: (p) => num(p.sales_count) },
            { h: 'Revenue', r: (p) => money(p.revenue_cents, p.currency) },
            { h: 'Status', r: (p) => <><Status s={p.status} />{p.pending_reviews ? <> <Badge tone="amber">{p.pending_reviews} review{p.pending_reviews > 1 ? 's' : ''}</Badge></> : null}</> },
            { h: '', class: 'right', r: (p) => <ActionForm action={`/app/monetize/products/${p.id}/duplicate`} label="Duplicate" /> },
          ]} />
        </Card>
      </DashLayout>,
    );
  });

  dash.get('/products/new', requirePerm('manage'), async (c) => {
    const automations = await all<any>(c.env, 'SELECT id, name FROM automations WHERE pub_id = ?', c.get('pub').id);
    return c.html(<DashLayout c={c} title="New product" section="monetize" sub="products" crumbs={[['/app/monetize/products', 'Products']]}>{productForm(c, null, automations)}</DashLayout>);
  });

  dash.post('/products', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const f = await form(c.req);
    let row: Record<string, unknown>;
    try { row = await readProduct(c, f); } catch (e: any) { return back(c, '/app/monetize/products/new', e.message, 'err'); }
    const pid = id();
    await insert(c.env, 'products', { id: pid, pub_id: pub.id, slug: await uniqueSlug(c, String(row.name)), ...row, created_at: now() });
    return back(c, `/app/monetize/products/${pid}`, 'Product created');
  });

  dash.get('/products/:id', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const p = await one<any>(c.env, 'SELECT * FROM products WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!p) return c.notFound();
    const [variants, reviews, orders, bookings, automations] = await Promise.all([
      all<any>(c.env, 'SELECT * FROM product_variants WHERE product_id = ? ORDER BY position', p.id),
      all<any>(c.env, 'SELECT * FROM product_reviews WHERE product_id = ? ORDER BY created_at DESC LIMIT 100', p.id),
      all<any>(c.env, `SELECT * FROM orders WHERE pub_id = ? AND ref_id = ? AND kind IN ('product','replay') ORDER BY created_at DESC LIMIT 50`, pub.id, p.id),
      all<any>(c.env, `SELECT * FROM bookings WHERE product_id = ? AND starts_at > ? ORDER BY starts_at LIMIT 50`, p.id, now() - 86400000),
      all<any>(c.env, 'SELECT id, name FROM automations WHERE pub_id = ?', pub.id),
    ]);
    const avg = reviews.filter((r) => r.status === 'approved');
    const base = siteUrl(c.env, pub);
    return c.html(
      <DashLayout c={c} title={p.name} section="monetize" sub="products" crumbs={[['/app/monetize/products', 'Products']]} actions={<><LinkBtn href={`${base}/shop/${p.slug}`} target="_blank">View</LinkBtn><form method="post" action={`/app/monetize/products/${p.id}/duplicate`} class="inline-form"><Btn kind="secondary">Duplicate</Btn></form></>}>
        <Stats>
          <Stat label="Sales" value={num(p.sales_count)} />
          <Stat label="Revenue" value={money(p.revenue_cents, p.currency)} />
          <Stat label="Rating" value={avg.length ? (avg.reduce((a, r) => a + r.rating, 0) / avg.length).toFixed(1) + ' ★' : '—'} sub={`${avg.length} approved reviews`} />
        </Stats>
        <div class="split">
          <div>{productForm(c, p, automations)}</div>
          <div>
            <Card title="Share & sell">
              <Field label="Product page"><Copy value={`${base}/shop/${p.slug}`} /></Field>
              <Help>Sell inside emails: add a <strong>Product</strong> block in the post or automation editor and pick “{p.name}” (block id <code>{p.id}</code>).</Help>
            </Card>
            <Card title="Variants" actions={<small class="muted">Optional</small>}>
              {variants.length > 0 && <ul class="list-plain">{variants.map((v) => (
                <li class="row between"><span><strong>{v.name}</strong> · {money(v.price_cents, p.currency)}{v.file_key ? ' · file' : v.link_url ? ' · link' : ''}</span><ActionForm action={`/app/monetize/variants/${v.id}/delete`} label="Remove" kind="danger" /></li>
              ))}</ul>}
              <form method="post" action={`/app/monetize/products/${p.id}/variants`} enctype="multipart/form-data" class="stack-sm">
                <Input name="name" placeholder="Variant name (e.g. Pro license)" required />
                <Input name="price" type="number" step="0.01" min="0" placeholder="Price" required />
                <Input name="link_url" placeholder="Own link (optional)" />
                <input class="input" type="file" name="file" />
                <Btn kind="secondary" small>Add variant</Btn>
              </form>
            </Card>
            {p.kind === 'coaching' && <Card title="Upcoming bookings">{bookings.length ? <ul class="list-plain">{bookings.map((b) => <li>{fmtDateTime(b.starts_at, parseJSON<any>(p.coaching, {}).tz || 'UTC')} — {b.name || b.email} <Status s={b.status} /></li>)}</ul> : <p class="muted">No bookings yet.</p>}</Card>}
            <Card title="Reviews">
              {reviews.length ? <ul class="list-plain">{reviews.map((r) => (
                <li><div class="row between"><strong>{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)} {r.name}</strong><Status s={r.status} /></div><p>{r.body}</p>
                  <div class="row">{r.status !== 'approved' && <ActionForm action={`/app/monetize/reviews/${r.id}/approved`} label="Approve" />}{r.status !== 'rejected' && <ActionForm action={`/app/monetize/reviews/${r.id}/rejected`} label="Reject" kind="danger" />}</div></li>
              ))}</ul> : <p class="muted">Buyers are invited to review 3 days after purchase. Reviews appear after you approve them.</p>}
            </Card>
            <Card title="Recent orders" pad={false}>
              <Table rows={orders} empty="No orders yet." cols={[{ h: 'Buyer', r: (o) => o.email }, { h: 'Amount', r: (o) => money(o.amount_cents, o.currency) }, { h: '', r: (o) => <Status s={o.status} /> }, { h: 'Date', r: (o) => fmtDate(o.created_at) }]} />
            </Card>
          </div>
        </div>
      </DashLayout>,
    );
  });

  dash.post('/products/:id', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const p = await one<any>(c.env, 'SELECT * FROM products WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!p) return c.notFound();
    let row: Record<string, unknown>;
    try { row = await readProduct(c, await form(c.req), p); } catch (e: any) { return back(c, `/app/monetize/products/${p.id}`, e.message, 'err'); }
    if (row.name !== p.name) row.slug = await uniqueSlug(c, String(row.name), p.id);
    const cols = Object.keys(row);
    await run(c.env, `UPDATE products SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...cols.map((k) => row[k]), p.id);
    return back(c, `/app/monetize/products/${p.id}`, 'Product saved');
  });

  dash.post('/products/:id/duplicate', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const p = await one<any>(c.env, 'SELECT * FROM products WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!p) return c.notFound();
    const nid = id();
    const copy = { ...p, id: nid, name: `${p.name} (copy)`, slug: await uniqueSlug(c, `${p.name} copy`), status: 'draft', sales_count: 0, revenue_cents: 0, created_at: now() };
    await insert(c.env, 'products', copy);
    for (const v of await all<any>(c.env, 'SELECT * FROM product_variants WHERE product_id = ?', p.id)) await insert(c.env, 'product_variants', { ...v, id: id(), product_id: nid });
    return back(c, `/app/monetize/products/${nid}`, 'Product duplicated (saved as draft)');
  });

  dash.post('/products/:id/variants', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const p = await one<any>(c.env, 'SELECT id FROM products WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!p) return c.notFound();
    const f = await form(c.req);
    let fileKey: string | null = null;
    if (f.file instanceof File && f.file.size) fileKey = (await storeFile(c.env, pub.id, f.file, { folder: 'private/products', userId: c.get('user').id })).key;
    const pos = await val<number>(c.env, 'SELECT COALESCE(MAX(position),0)+1 FROM product_variants WHERE product_id = ?', p.id);
    await insert(c.env, 'product_variants', { id: id(), product_id: p.id, name: str(f.name, 120), price_cents: cents(f.price), file_key: fileKey, link_url: str(f.link_url, 2000) || null, position: pos });
    return back(c, `/app/monetize/products/${p.id}`, 'Variant added');
  });

  dash.post('/variants/:id/delete', requirePerm('manage'), async (c) => {
    const v = await one<any>(c.env, 'SELECT v.* FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ? AND p.pub_id = ?', c.req.param('id'), c.get('pub').id);
    if (!v) return c.notFound();
    await run(c.env, 'DELETE FROM product_variants WHERE id = ?', v.id);
    return back(c, `/app/monetize/products/${v.product_id}`, 'Variant removed');
  });

  dash.post('/reviews/:id/:status', requirePerm('manage'), async (c) => {
    const status = c.req.param('status');
    if (!['approved', 'rejected'].includes(status)) return c.notFound();
    const r = await one<any>(c.env, 'SELECT * FROM product_reviews WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
    if (!r) return c.notFound();
    await run(c.env, 'UPDATE product_reviews SET status = ? WHERE id = ?', status, r.id);
    return back(c, `/app/monetize/products/${r.product_id}`, `Review ${status}`);
  });
}

