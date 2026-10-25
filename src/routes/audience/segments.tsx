/** @jsxImportSource hono/jsx */
// Segments (dynamic + static) and reusable condition sets, with the visual rule builder.
import { Hono } from 'hono';
import type { AppEnv, Ctx } from '../../types';
import { one, all, run, val, insert, update } from '../../lib/db';
import { countMatching, listMatching, recalcSegment, snapshotToStatic, compile, FIELDS, EMPTY_GROUP, type RuleGroup } from '../../lib/segments';
import { ruleCatalog } from '../../lib/catalog';
import { aiJSON, aiEnabled } from '../../lib/ai';
import { registerPeriodic } from '../../lib/jobs';
import { requirePerm, audit } from '../../lib/auth';
import { Card, Btn, LinkBtn, Field, Input, Textarea, Select, Table, Status, Empty, back, Muted, Help, Json, Pager, ActionForm, Stat, Stats } from '../../ui/components';
import { page, exportCSV } from './shared';
import { form, str, now, id, ago, num, parseJSON, HOUR, fmtDateTime } from '../../lib/util';

const app = new Hono<AppEnv>();

function validGroup(raw: string): RuleGroup {
  const g = parseJSON<RuleGroup>(raw, EMPTY_GROUP);
  return g && Array.isArray(g.rules) ? g : EMPTY_GROUP;
}

async function describe(c: Ctx, text: string): Promise<RuleGroup | null> {
  const cat = await ruleCatalog(c.env, c.get('pub').id);
  const fields = Object.entries(FIELDS).map(([k, f]) => `${k} (${f.label}; cmps: ${f.cmps.join('|')}${f.options ? '; values: ' + f.options.join('|') : ''})`).join('\n');
  const ctx = `Known tags: ${cat.options.tag.slice(0, 60).join(', ') || 'none'}\nSegments: ${cat.options.segment.map(([i, n]) => `${n}=${i}`).join(', ') || 'none'}\nPosts: ${cat.options.post.slice(0, 30).map(([i, n]) => `"${n}"=${i}`).join(', ') || 'none'}\nAutomations: ${cat.options.automation.map(([i, n]) => `${n}=${i}`).join(', ') || 'none'}\nLists: ${cat.options.list.map(([i, n]) => `${n}=${i}`).join(', ') || 'none'}\nTiers: ${cat.options.tier.map(([i, n]) => `${n}=${i}`).join(', ') || 'none'}\nCustom fields: ${cat.options.custom.map((f: any) => f.key).join(', ') || 'none'}\nProducts: ${cat.options.product.map(([i, n]) => `${n}=${i}`).join(', ') || 'none'}`;
  const g = await aiJSON<RuleGroup>(c.env, `Describe this audience as rules: "${text}"\n\n${ctx}`, `You convert plain-English audience descriptions into a JSON rule group for a newsletter platform.
Format: {"op":"and"|"or","rules":[{"field":"...","cmp":"...","value":...} or nested groups]}.
Fields:\n${fields}\nValue notes: dates use number of days for within_days/older_than_days/not_within_days; custom uses {"key":"...","value":"..."}; poll uses {"poll_id","option_id"}; survey uses {"survey_id"}; ids must come from the lists provided. Use only listed fields and comparisons.`);
  if (!g || !Array.isArray(g.rules)) return null;
  const clean = (grp: any): RuleGroup => ({ op: grp.op === 'or' ? 'or' : 'and', rules: (grp.rules || []).filter((r: any) => r.rules || (FIELDS[r.field] && FIELDS[r.field].cmps.includes(r.cmp))).map((r: any) => (r.rules ? clean(r) : r)) });
  return clean(g);
}

// ───────── segments ─────────
app.get('/segments', async (c) => {
  const pub = c.get('pub');
  const rows = await all<any>(c.env, 'SELECT * FROM segments WHERE pub_id = ? ORDER BY created_at DESC', pub.id);
  return page(c, { title: 'Segments', sub: 'segments', actions: <LinkBtn href="/app/audience/segments/new" kind="primary" small>+ New segment</LinkBtn> }, (
    rows.length ? (
      <Table<any> rows={rows} rowHref={(s) => `/app/audience/segments/${s.id}`} cols={[
        { h: 'Segment', r: (s) => <><a href={`/app/audience/segments/${s.id}`}>{s.name}</a>{s.description && <div class="small muted">{s.description}</div>}</> },
        { h: 'Type', r: (s) => <Status s={s.kind === 'static' ? 'static' : 'dynamic'} /> },
        { h: 'Subscribers', r: (s) => <strong>{num(s.cached_count)}</strong> },
        { h: 'Calculated', r: (s) => <span class="small">{ago(s.calculated_at)}</span> },
        { h: '', r: (s) => <div class="row end"><ActionForm action={`/app/audience/segments/${s.id}/recalc`} label="Recalculate" /><LinkBtn small href={`/app/audience/segments/${s.id}/members`}>Members</LinkBtn></div> },
      ]} />
    ) : <Card><Empty icon="◎" title="No segments yet" body="Group subscribers by behavior, attributes, engagement, purchases, poll answers and more. Use segments to target sends, power dynamic content, and drive automations." action={<LinkBtn href="/app/audience/segments/new" kind="primary">Create a segment</LinkBtn>} /></Card>
  ));
});

async function editor(c: Ctx, seg: any | null, kind: 'segment' | 'condition') {
  const pub = c.get('pub');
  const cat = await ruleCatalog(c.env, pub.id);
  const rules = seg?.rules || JSON.stringify(EMPTY_GROUP);
  const isSeg = kind === 'segment';
  const base = isSeg ? '/app/audience/segments' : '/app/audience/conditions';
  return page(c, {
    title: seg ? `Edit ${seg.name}` : isSeg ? 'New segment' : 'New condition set', sub: isSeg ? 'segments' : 'conditions',
    crumbs: [[base, isSeg ? 'Segments' : 'Condition sets']], scripts: ['/static/rules.js', '/static/audience-ui.js'],
  }, <>
    <Json id="rule-catalog" data={cat} />
    <form method="post" action={seg ? `${base}/${seg.id}` : base} id="seg-form">
      <div class="split">
        <div>
          <Card title="Conditions" actions={isSeg ? <span class="seg-count" data-seg-count>…</span> : null}>
            <input type="hidden" name="rules" id="rules-input" value={rules} />
            <div data-rules="#rules-input" data-catalog="#rule-catalog" data-preview={isSeg ? `${base}/preview` : `/app/audience/segments/preview`} />
          </Card>
          <Card title="Describe it instead" actions={!aiEnabled(c.env) ? <Muted>AI not configured</Muted> : null}>
            <div class="row">
              <Input name="describe" placeholder="e.g. premium readers in the US who opened anything in the last 30 days" attrs={{ 'data-ai-describe': `${base === '/app/audience/segments' ? base : '/app/audience/segments'}/ai` }} />
              <Btn type="button" kind="secondary" small attrs={{ 'data-ai-describe-btn': '1' }}>Build rules</Btn>
            </div>
            <Help>Describe the audience in plain English and AI will fill in the conditions above. Review them before saving.</Help>
          </Card>
          {isSeg && <Card title="Preview" pad={false}><div data-seg-sample class="card-b"><Muted>Matching subscribers will appear here.</Muted></div></Card>}
        </div>
        <div>
          <Card title="Details">
            <Field label="Name"><Input name="name" value={seg?.name} required placeholder={isSeg ? 'Engaged premium readers' : 'Engaged in last 30 days'} /></Field>
            {isSeg && <Field label="Description"><Textarea name="description" value={seg?.description} rows={2} /></Field>}
            {isSeg && (
              <Field label="Type" hint="Dynamic segments update automatically as subscribers change. Static segments are a fixed snapshot you can add to or remove from by hand.">
                <Select name="kind" value={seg?.kind || 'dynamic'} options={[['dynamic', 'Dynamic (updates automatically)'], ['static', 'Static (fixed snapshot)']]} />
              </Field>
            )}
            {isSeg && seg?.kind === 'static' && <Help>Saving re-snapshots membership from these conditions only if you tick below.</Help>}
            {isSeg && seg?.kind === 'static' && <label class="check"><input type="checkbox" name="resnapshot" /> <span>Replace members with current matches</span></label>}
            <div class="form-actions"><Btn>{seg ? 'Save' : 'Create'}</Btn></div>
          </Card>
          {!isSeg && <Help>Condition sets are reusable rule groups. Reference them from any segment or automation with “Matches condition set”, and edit them in one place.</Help>}
        </div>
      </div>
    </form>
  </>);
}

app.get('/segments/new', (c) => editor(c, null, 'segment'));
app.get('/segments/:id', async (c) => {
  const seg = await one<any>(c.env, 'SELECT * FROM segments WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
  if (!seg) return back(c, '/app/audience/segments', 'Segment not found', 'err');
  return segmentDetail(c, seg);
});
app.get('/segments/:id/edit', async (c) => {
  const seg = await one<any>(c.env, 'SELECT * FROM segments WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
  if (!seg) return back(c, '/app/audience/segments', 'Segment not found', 'err');
  return editor(c, seg, 'segment');
});

async function segmentDetail(c: Ctx, seg: any) {
  const pub = c.get('pub');
  const lists = await all<any>(c.env, 'SELECT id, name FROM lists WHERE pub_id = ? ORDER BY name', pub.id);
  const g = validGroup(seg.rules);
  const sample = seg.kind === 'static'
    ? await all<any>(c.env, `SELECT s.* FROM segment_members sm JOIN subscribers s ON s.id = sm.subscriber_id WHERE sm.segment_id = ? ORDER BY s.created_at DESC LIMIT 10`, seg.id)
    : await listMatching(c.env, pub.id, g, { limit: 10 });
  return page(c, {
    title: seg.name, sub: 'segments', crumbs: [['/app/audience/segments', 'Segments']],
    actions: <>
      <LinkBtn small href={`/app/audience/segments/${seg.id}/edit`} kind="primary">Edit conditions</LinkBtn>
      <ActionForm action={`/app/audience/segments/${seg.id}/recalc`} label="Recalculate" />
      <LinkBtn small href={`/app/audience/segments/${seg.id}/export`}>Export CSV</LinkBtn>
      <ActionForm action={`/app/audience/segments/${seg.id}/duplicate`} label="Duplicate" />
      <ActionForm action={`/app/audience/segments/${seg.id}/delete`} label="Delete" kind="danger" confirm="Delete this segment? Sends and automations that use it will stop matching it." />
    </>,
  }, <>
    <Stats>
      <Stat label="Active subscribers" value={num(seg.cached_count)} sub={`calculated ${ago(seg.calculated_at)}`} />
      <Stat label="Type" value={<Status s={seg.kind} />} sub={seg.kind === 'static' ? 'fixed membership' : 'updates automatically'} />
      <Stat label="Created" value={<span style="font-size:16px">{fmtDateTime(seg.created_at, pub.timezone)}</span>} />
    </Stats>
    {seg.description && <p class="muted">{seg.description}</p>}
    <div class="split">
      <Card title="Members (latest)" actions={<LinkBtn small href={`/app/audience/segments/${seg.id}/members`}>View all</LinkBtn>} pad={false}>
        <Table<any> rows={sample} empty="No subscribers match yet." rowHref={(s) => `/app/audience/s/${s.id}`} cols={[{ h: 'Email', r: (s) => <a href={`/app/audience/s/${s.id}`}>{s.email}</a> }, { h: 'Status', r: (s) => <Status s={s.status} /> }, { h: 'Joined', r: (s) => ago(s.created_at) }]} />
      </Card>
      <div>
        <Card title="Add segment to a newsletter list">
          {lists.length ? (
            <form method="post" action={`/app/audience/segments/${seg.id}/to-list`} class="row">
              <Select name="list_id" options={lists.map((l) => [l.id, l.name] as [string, string])} attrs={{ style: 'width:auto' }} />
              <Btn small kind="secondary">Add all</Btn>
            </form>
          ) : <Help><a href="/app/audience/lists">Create a list</a> first.</Help>}
        </Card>
        <Card title="Use this segment">
          <ul class="list-plain small">
            <li>Send a post only to this segment (or exclude it) from the post's send settings.</li>
            <li>Show a dynamic content block only to these readers.</li>
            <li>Branch an automation with “In segment”, or trigger one when someone enters it.</li>
          </ul>
        </Card>
      </div>
    </div>
  </>);
}

app.post('/segments', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const g = validGroup(f.rules);
  const sid = id();
  const kind = f.kind === 'static' ? 'static' : 'dynamic';
  await insert(c.env, 'segments', { id: sid, pub_id: pub.id, name: str(f.name, 120) || 'Untitled segment', description: str(f.description, 500), kind, rules: JSON.stringify(g), created_at: now() });
  if (kind === 'static') await snapshotToStatic(c.env, pub.id, sid, g);
  await recalcSegment(c.env, pub.id, sid);
  await audit(c, 'segment.create', sid);
  return back(c, `/app/audience/segments/${sid}`, 'Segment created');
});

app.post('/segments/preview', async (c) => {
  const pub = c.get('pub');
  const body = await c.req.json().catch(() => ({}));
  const g = body?.rules && Array.isArray(body.rules.rules) ? (body.rules as RuleGroup) : EMPTY_GROUP;
  try {
    const count = await countMatching(c.env, pub.id, g);
    const sample = await listMatching(c.env, pub.id, g, { limit: 8 });
    return c.json({ count, sample: sample.map((s: any) => ({ id: s.id, email: s.email, name: s.name, tier: s.tier, created_at: s.created_at })) });
  } catch (e: any) {
    return c.json({ error: 'Invalid rules: ' + e.message }, 400);
  }
});

app.post('/segments/ai', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const text = str(body?.text, 500);
  if (!text) return c.json({ error: 'Describe the audience first' }, 400);
  if (!aiEnabled(c.env)) return c.json({ error: 'AI is not configured on this instance (enable the Workers AI binding).' }, 400);
  const g = await describe(c, text);
  if (!g) return c.json({ error: 'Could not turn that description into rules. Try rephrasing.' }, 422);
  return c.json({ rules: g });
});

app.post('/segments/:id', async (c) => {
  const pub = c.get('pub');
  const seg = await one<any>(c.env, 'SELECT * FROM segments WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
  if (!seg) return back(c, '/app/audience/segments', 'Segment not found', 'err');
  const f = await form(c.req);
  const g = validGroup(f.rules);
  const kind = f.kind === 'static' ? 'static' : 'dynamic';
  await update(c.env, 'segments', seg.id, { name: str(f.name, 120) || seg.name, description: str(f.description, 500), kind, rules: JSON.stringify(g) }, pub.id);
  if (kind === 'static' && (seg.kind !== 'static' || f.resnapshot === 'on')) await snapshotToStatic(c.env, pub.id, seg.id, g);
  await recalcSegment(c.env, pub.id, seg.id);
  await audit(c, 'segment.update', seg.id);
  return back(c, `/app/audience/segments/${seg.id}`, 'Segment saved');
});

app.post('/segments/:id/recalc', async (c) => {
  const n = await recalcSegment(c.env, c.get('pub').id, c.req.param('id'));
  return back(c, c.req.header('referer') || '/app/audience/segments', `Recalculated: ${num(n)} subscribers`);
});

app.post('/segments/:id/duplicate', async (c) => {
  const pub = c.get('pub');
  const seg = await one<any>(c.env, 'SELECT * FROM segments WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
  if (!seg) return back(c, '/app/audience/segments', 'Segment not found', 'err');
  const sid = id();
  await insert(c.env, 'segments', { id: sid, pub_id: pub.id, name: seg.name + ' (copy)', description: seg.description, kind: seg.kind, rules: seg.rules, created_at: now() });
  if (seg.kind === 'static') await run(c.env, 'INSERT INTO segment_members (segment_id, subscriber_id) SELECT ?, subscriber_id FROM segment_members WHERE segment_id = ?', sid, seg.id);
  await recalcSegment(c.env, pub.id, sid);
  return back(c, `/app/audience/segments/${sid}`, 'Segment duplicated');
});

app.post('/segments/:id/delete', async (c) => {
  await run(c.env, 'DELETE FROM segments WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
  await audit(c, 'segment.delete', c.req.param('id'));
  return back(c, '/app/audience/segments', 'Segment deleted');
});

app.get('/segments/:id/export', requirePerm('admin'), async (c) => {
  const seg = await one<any>(c.env, 'SELECT * FROM segments WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
  if (!seg) return back(c, '/app/audience/segments', 'Segment not found', 'err');
  await audit(c, 'segment.export', seg.id);
  return exportCSV(c, { op: 'and', rules: [{ field: 'segment', cmp: 'in', value: seg.id }] }, `segment-${seg.name}`, true);
});

app.post('/segments/:id/to-list', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const list = await one<any>(c.env, 'SELECT id, name FROM lists WHERE id = ? AND pub_id = ?', str(f.list_id), pub.id);
  if (!list) return back(c, `/app/audience/segments/${c.req.param('id')}`, 'Choose a list', 'err');
  const cc = await compile(c.env, pub.id, { op: 'and', rules: [{ field: 'segment', cmp: 'in', value: c.req.param('id') }] });
  const res = await run(c.env, `INSERT INTO list_members (list_id, subscriber_id, status, created_at) SELECT ?, s.id, 'subscribed', ? FROM subscribers s WHERE s.pub_id = ? AND s.status = 'active' AND (${cc.sql}) ON CONFLICT(list_id, subscriber_id) DO UPDATE SET status = 'subscribed'`, list.id, now(), pub.id, ...cc.params);
  return back(c, `/app/audience/segments/${c.req.param('id')}`, `Added ${num(res.meta.changes || 0)} subscribers to ${list.name}`);
});

app.get('/segments/:id/members', async (c) => {
  const pub = c.get('pub');
  const seg = await one<any>(c.env, 'SELECT * FROM segments WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
  if (!seg) return back(c, '/app/audience/segments', 'Segment not found', 'err');
  const after = c.req.query('after') || '';
  const rows = seg.kind === 'static'
    ? await all<any>(c.env, `SELECT s.* FROM segment_members sm JOIN subscribers s ON s.id = sm.subscriber_id WHERE sm.segment_id = ? AND s.id > ? ORDER BY s.id LIMIT 51`, seg.id, after)
    : await listMatching(c.env, pub.id, validGroup(seg.rules), { after: after || undefined, limit: 51, activeOnly: false });
  const more = rows.length > 50;
  const list = rows.slice(0, 50);
  return page(c, { title: `${seg.name} · members`, sub: 'segments', crumbs: [['/app/audience/segments', 'Segments'], [`/app/audience/segments/${seg.id}`, seg.name]] }, <>
    {seg.kind === 'static' && (
      <Card title="Add members">
        <form method="post" action={`/app/audience/segments/${seg.id}/members`} class="row">
          <Input name="emails" placeholder="Emails, comma separated" /><Btn small kind="secondary">Add</Btn>
        </form>
      </Card>
    )}
    <Table<any> rows={list} empty="No members." cols={[
      { h: 'Email', r: (s) => <a href={`/app/audience/s/${s.id}`}>{s.email}</a> },
      { h: 'Name', r: (s) => s.name || <Muted>—</Muted> },
      { h: 'Status', r: (s) => <Status s={s.status} /> },
      { h: 'Tier', r: (s) => <Status s={s.tier} /> },
      { h: 'Engagement', r: (s) => s.engagement },
      { h: '', r: (s) => seg.kind === 'static' ? <ActionForm action={`/app/audience/segments/${seg.id}/members/remove`} fields={{ subscriber_id: s.id }} label="Remove" /> : null },
    ]} />
    <Pager next={more ? `?after=${list[list.length - 1].id}` : null} prev={after ? '?' : null} />
  </>);
});

app.post('/segments/:id/members', async (c) => {
  const pub = c.get('pub');
  const seg = await one<any>(c.env, `SELECT * FROM segments WHERE id = ? AND pub_id = ? AND kind = 'static'`, c.req.param('id'), pub.id);
  if (!seg) return back(c, '/app/audience/segments', 'Static segment not found', 'err');
  const f = await form(c.req);
  let added = 0;
  for (const e of str(f.emails, 20000).split(/[,\s;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    const s = await one<any>(c.env, 'SELECT id FROM subscribers WHERE pub_id = ? AND email = ?', pub.id, e);
    if (s) added += (await run(c.env, 'INSERT OR IGNORE INTO segment_members (segment_id, subscriber_id) VALUES (?, ?)', seg.id, s.id)).meta.changes || 0;
  }
  await recalcSegment(c.env, pub.id, seg.id);
  return back(c, `/app/audience/segments/${seg.id}/members`, `Added ${added} member${added === 1 ? '' : 's'}`);
});

app.post('/segments/:id/members/remove', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const seg = await one<any>(c.env, 'SELECT id FROM segments WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
  if (seg) {
    await run(c.env, 'DELETE FROM segment_members WHERE segment_id = ? AND subscriber_id = ?', seg.id, str(f.subscriber_id));
    await recalcSegment(c.env, pub.id, seg.id);
  }
  return back(c, `/app/audience/segments/${c.req.param('id')}/members`, 'Member removed');
});

// ───────── condition sets ─────────
app.get('/conditions', async (c) => {
  const rows = await all<any>(c.env, 'SELECT * FROM condition_sets WHERE pub_id = ? ORDER BY name', c.get('pub').id);
  const usage = async (csid: string) => (await val<number>(c.env, `SELECT COUNT(*) FROM segments WHERE pub_id = ? AND rules LIKE ?`, c.get('pub').id, `%"${csid}"%`)) + (await val<number>(c.env, `SELECT COUNT(*) FROM automations WHERE pub_id = ? AND (steps LIKE ? OR trigger LIKE ?)`, c.get('pub').id, `%"${csid}"%`, `%"${csid}"%`));
  const counts = await Promise.all(rows.map((r) => usage(r.id)));
  return page(c, { title: 'Condition sets', sub: 'conditions', actions: <LinkBtn href="/app/audience/conditions/new" kind="primary" small>+ New condition set</LinkBtn> }, (
    rows.length ? (
      <Table<any> rows={rows} rowHref={(r) => `/app/audience/conditions/${r.id}`} cols={[
        { h: 'Name', r: (r) => <a href={`/app/audience/conditions/${r.id}`}>{r.name}</a> },
        { h: 'Conditions', r: (r) => validGroup(r.rules).rules.length },
        { h: 'Used by', r: (r) => `${counts[rows.indexOf(r)]} segment(s)/automation(s)` },
        { h: 'Created', r: (r) => ago(r.created_at) },
        { h: '', r: (r) => <ActionForm action={`/app/audience/conditions/${r.id}/delete`} label="Delete" kind="danger" confirm="Delete this condition set? Rules referencing it will match everyone." /> },
      ]} />
    ) : <Card><Empty icon="⋔" title="No condition sets" body="Save a group of conditions once (e.g. “engaged in the last 30 days”) and reuse it across segments and automation branches." action={<LinkBtn href="/app/audience/conditions/new" kind="primary">New condition set</LinkBtn>} /></Card>
  ));
});
app.get('/conditions/new', (c) => editor(c, null, 'condition'));
app.get('/conditions/:id', async (c) => {
  const cs = await one<any>(c.env, 'SELECT * FROM condition_sets WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
  if (!cs) return back(c, '/app/audience/conditions', 'Not found', 'err');
  return editor(c, cs, 'condition');
});
app.post('/conditions', async (c) => {
  const f = await form(c.req);
  const cid = id();
  await insert(c.env, 'condition_sets', { id: cid, pub_id: c.get('pub').id, name: str(f.name, 120) || 'Untitled', rules: JSON.stringify(validGroup(f.rules)), created_at: now() });
  return back(c, '/app/audience/conditions', 'Condition set created');
});
app.post('/conditions/:id', async (c) => {
  const f = await form(c.req);
  await update(c.env, 'condition_sets', c.req.param('id'), { name: str(f.name, 120) || 'Untitled', rules: JSON.stringify(validGroup(f.rules)) }, c.get('pub').id);
  return back(c, '/app/audience/conditions', 'Condition set saved');
});
app.post('/conditions/:id/delete', async (c) => {
  await run(c.env, 'DELETE FROM condition_sets WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
  return back(c, '/app/audience/conditions', 'Condition set deleted');
});

// Keep dynamic segment counts + membership caches fresh (dynamic content and targeting use them).
registerPeriodic('segments.recalc', HOUR, async (env) => {
  const segs = await all<{ id: string; pub_id: string }>(env, `SELECT id, pub_id FROM segments WHERE kind = 'dynamic' ORDER BY COALESCE(calculated_at, 0) LIMIT 50`);
  for (const s of segs) await recalcSegment(env, s.pub_id, s.id);
});

// Expire gifted / reward premium access (no paid subscription behind it).
registerPeriodic('audience.expire_premium', HOUR, async (env) => {
  const { emit } = await import('../../lib/events');
  const t = now();
  const rows = await all<{ id: string; pub_id: string }>(env, `SELECT id, pub_id FROM subscribers WHERE tier = 'premium' AND trial_ends_at IS NOT NULL AND trial_ends_at < ? AND NOT EXISTS (SELECT 1 FROM subscriptions x WHERE x.subscriber_id = subscribers.id AND x.status IN ('active','trialing','past_due')) LIMIT 500`, t);
  for (const r of rows) {
    await run(env, `UPDATE subscribers SET tier = 'free', trial_ends_at = NULL, updated_at = ? WHERE id = ?`, t, r.id);
    await emit(env, { pubId: r.pub_id, type: 'subscription.downgraded', subscriberId: r.id, data: { reason: 'premium_access_expired' } });
  }
});

export default app;
