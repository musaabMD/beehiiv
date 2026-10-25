/** @jsxImportSource hono/jsx */
// Module: automations — visual builder, draft/live workflow, journeys, analytics. Engine: src/lib/automations.ts
import { Hono } from 'hono';
import type { AppEnv, Ctx, Module, Publication, Subscriber } from '../types';
import { one, all, run, insert, val } from '../lib/db';
import { requirePerm, can, audit } from '../lib/auth';
import { enroll, publishDraft, getAt, TRIGGERS, STEP_TYPES, type Step, type Path } from '../lib/automations';
import { registerJob, enqueue, kick } from '../lib/jobs';
import { ruleCatalog } from '../lib/catalog';
import { listMatching, segmentGroup } from '../lib/segments';
import { buildEmail, type Content } from '../lib/sender';
import { sendMail } from '../lib/email';
import { senderFor } from '../lib/pub';
import { FIELDS } from '../lib/segments';
import { DashLayout } from '../ui/layout';
import { Card, Btn, LinkBtn, ActionForm, Field, Input, Textarea, Toggle, Table, Empty, Status, Stat, Stats, Tabs, Modal, OpenBtn, Json, back, Bars, Badge } from '../ui/components';
import { id, now, parseJSON, form, str, int, bool, ago, fmtDateTime, num, pct } from '../lib/util';
import { TEMPLATES, templateByKey } from './automations/templates';
import { GalleryAssets, TemplateCard } from './posts/templates';
import { stepSummary, triggerSummary, flatten, stepLabel, normalizeSteps, normalizeTrigger, BRANCH_TYPES } from './automations/shared';

const dash = new Hono<AppEnv>();
const site = new Hono<AppEnv>();
const root = new Hono<AppEnv>();

dash.use('*', requirePerm('draft'));

interface AutomationRow {
  id: string; pub_id: string; name: string; description: string; status: string; trigger: string; steps: string;
  draft_trigger: string | null; draft_steps: string | null; allow_reentry: number; published_at: number | null; created_at: number; updated_at: number;
}

async function load(c: Ctx): Promise<AutomationRow | null> {
  return one<AutomationRow>(c.env, 'SELECT * FROM automations WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
}

/** id → display name map for summaries (lists, automations, segments, tiers, products, events, surveys, polls, posts). */
async function nameMap(c: Ctx): Promise<Record<string, string>> {
  const pid = c.get('pub').id;
  const q: Array<[string, string]> = [['lists', 'name'], ['automations', 'name'], ['segments', 'name'], ['tiers', 'name'], ['products', 'name'], ['live_events', 'title'], ['surveys', 'title'], ['polls', 'question'], ['posts', 'title']];
  const parts = await Promise.all(q.map(([t, col]) => all<{ id: string; n: string }>(c.env, `SELECT id, ${col} AS n FROM ${t} WHERE pub_id = ?`, pid)));
  const rows = parts.flat();
  return Object.fromEntries(rows.map((r) => [r.id, r.n]));
}

const draftOf = (a: AutomationRow) => ({ trigger: parseJSON<any>(a.draft_trigger ?? a.trigger, {}), steps: parseJSON<Step[]>(a.draft_steps ?? a.steps, []) });
const liveOf = (a: AutomationRow) => ({ trigger: parseJSON<any>(a.trigger, {}), steps: parseJSON<Step[]>(a.steps, []) });
const hasDraft = (a: AutomationRow) => a.draft_steps !== null || a.draft_trigger !== null;

function AutomationTabs(p: { a: AutomationRow; active: string }) {
  const base = `/app/automations/${p.a.id}`;
  return <Tabs active={p.active} items={[[base, 'Builder'], [`${base}/journeys`, 'Journeys'], [`${base}/analytics`, 'Analytics'], [`${base}/compare`, 'Draft vs live']]} />;
}

// ───────────────────────── list ─────────────────────────
dash.get('/', async (c) => {
  const pub = c.get('pub');
  const rows = await all<any>(
    c.env,
    `SELECT a.*,
      (SELECT COUNT(*) FROM automation_runs r WHERE r.automation_id = a.id) AS enrolled,
      (SELECT COUNT(*) FROM automation_runs r WHERE r.automation_id = a.id AND r.status IN ('active','waiting')) AS in_progress,
      (SELECT COUNT(*) FROM automation_runs r WHERE r.automation_id = a.id AND r.status = 'completed') AS completed,
      (SELECT COUNT(*) FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.automation_id = a.id AND d.status IN ('sent','deferred')) AS sent,
      (SELECT COUNT(*) FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.automation_id = a.id AND d.opened_at IS NOT NULL) AS opened,
      (SELECT COUNT(*) FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.automation_id = a.id AND d.clicked_at IS NOT NULL) AS clicked
     FROM automations a WHERE a.pub_id = ? ORDER BY CASE a.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, a.updated_at DESC`,
    pub.id,
  );
  const names = await nameMap(c);
  const tot = rows.reduce((acc, r) => ({ active: acc.active + (r.status === 'active' ? 1 : 0), inprog: acc.inprog + r.in_progress, sent: acc.sent + r.sent, opened: acc.opened + r.opened }), { active: 0, inprog: 0, sent: 0, opened: 0 });
  const showArchived = c.req.query('archived') === '1';
  const visible = rows.filter((r) => showArchived || r.status !== 'archived');
  return c.html(
    <DashLayout c={c} title="Automations" section="automations" actions={<OpenBtn target="#new-automation">+ New automation</OpenBtn>}>
      <Stats>
        <Stat label="Active automations" value={num(tot.active)} />
        <Stat label="Subscribers in a journey" value={num(tot.inprog)} />
        <Stat label="Emails sent by automations" value={num(tot.sent)} />
        <Stat label="Average open rate" value={pct(tot.opened, tot.sent)} />
      </Stats>
      {visible.length ? (
        <Card pad={false} title="Your automations" actions={<a class="btn btn-ghost btn-sm" href={showArchived ? '/app/automations' : '/app/automations?archived=1'}>{showArchived ? 'Hide archived' : 'Show archived'}</a>}>
          <Table
            rowHref={(r: any) => `/app/automations/${r.id}`}
            rows={visible}
            cols={[
              { h: 'Name', r: (r: any) => <div><a href={`/app/automations/${r.id}`}>{r.name}</a>{(r.draft_steps !== null || r.draft_trigger !== null) && r.status !== 'draft' ? <> <Badge tone="amber">unpublished changes</Badge></> : null}<div class="small muted">{triggerSummary(parseJSON(r.draft_trigger ?? r.trigger, {}), names)}</div></div> },
              { h: 'Status', r: (r: any) => <Status s={r.status} /> },
              { h: 'Enrolled', r: (r: any) => num(r.enrolled), class: 'right' },
              { h: 'In progress', r: (r: any) => num(r.in_progress), class: 'right' },
              { h: 'Completed', r: (r: any) => num(r.completed), class: 'right' },
              { h: 'Emails sent', r: (r: any) => num(r.sent), class: 'right' },
              { h: 'Open rate', r: (r: any) => pct(r.opened, r.sent), class: 'right' },
              { h: 'Click rate', r: (r: any) => pct(r.clicked, r.sent), class: 'right' },
              {
                h: '', class: 'right nowrap', r: (r: any) => (
                  <span class="row end" style="flex-wrap:nowrap;gap:4px">
                    <ActionForm action={`/app/automations/${r.id}/duplicate`} label="Duplicate" kind="ghost" />
                    {r.status !== 'archived' && can(c.get('role'), 'manage') && <ActionForm action={`/app/automations/${r.id}/archive`} label="Archive" kind="ghost" confirm="Archive this automation? Subscribers currently in it will exit." />}
                    {can(c.get('role'), 'manage') && <ActionForm action={`/app/automations/${r.id}/delete`} label="Delete" kind="danger" confirm="Delete this automation and its journey history permanently?" />}
                  </span>
                ),
              },
            ]}
          />
        </Card>
      ) : (
        <Card>
          <Empty icon="⚡" title="Automate your newsletter" body="Send welcome series, deliver lead magnets, nurture readers toward paid plans and win back inactive subscribers — all on autopilot." action={<OpenBtn target="#new-automation">Create your first automation</OpenBtn>} />
        </Card>
      )}
      <Modal id="new-automation" title="New automation" wide>
        <form method="post" action="/app/automations/new" class="stack">
          <Field label="Name"><Input name="name" placeholder="e.g. Welcome series" /></Field>
          <div class="field-l">Start from</div>
          <div class="af-templates">
            <label class="af-tpl"><input type="radio" name="template" value="" checked /><span><strong>Blank automation</strong><small>Pick a trigger and build your own flow.</small></span></label>
            {TEMPLATES.map((t) => <label class="af-tpl"><input type="radio" name="template" value={t.key} /><span><strong>{t.name}</strong><small>{t.description}</small></span></label>)}
          </div>
          <div class="form-actions"><a class="btn btn-ghost" href="/app/automations/welcome">Design a welcome email from a template →</a><Btn>Create automation</Btn></div>
        </form>
      </Modal>
    </DashLayout>,
  );
});

dash.post('/new', async (c) => {
  const f = await form(c.req);
  const tpl = templateByKey(str(f.template));
  const aid = id();
  const name = str(f.name, 120) || tpl?.name || 'Untitled automation';
  const trigger = tpl ? tpl.trigger : { type: 'welcome', config: {} };
  const steps = tpl ? tpl.steps() : [];
  await insert(c.env, 'automations', {
    id: aid, pub_id: c.get('pub').id, name, description: tpl?.description || '', status: 'draft', trigger: '{}', steps: '[]',
    draft_trigger: JSON.stringify(trigger), draft_steps: JSON.stringify(steps), allow_reentry: 0, created_by: c.get('user').id, created_at: now(), updated_at: now(),
  });
  await audit(c, 'automation.create', aid, { template: tpl?.key });
  return c.redirect(`/app/automations/${aid}`, 303);
});

// ───────────────────────── email templates (welcome / automation / post designs) ─────────────────────────
const TPL_KINDS = `('welcome','automation','post')`;
const tplRow = (c: Ctx, tid: string) => one<any>(c.env, `SELECT * FROM templates WHERE id = ? AND (pub_id IS NULL OR pub_id = ?) AND kind IN ${TPL_KINDS}`, tid, c.get('pub').id);
const freshIds = (blocks: any[]): any[] => (blocks || []).map((b) => ({
  ...b, id: id(8),
  data: b.data && Array.isArray(b.data.blocks) ? { ...b.data, blocks: freshIds(b.data.blocks) } : b.data && Array.isArray(b.data.columns) ? { ...b.data, columns: b.data.columns.map((col: any) => ({ ...col, blocks: freshIds(col.blocks) })) } : b.data,
}));
/** A send_email step config built from a template: copies its blocks and its email style tokens. */
function emailFromTemplate(t: any) {
  const subject = t.kind === 'welcome' ? 'Welcome to {{publication.name}}' : t.kind === 'automation' ? t.name : '';
  return { subject, preview_text: t.kind === 'post' ? '' : String(t.description || '').slice(0, 140), doc: { blocks: freshIds(parseJSON<any>(t.content, { blocks: [] }).blocks || []) }, style: parseJSON<any>(t.style, {}).email || {}, template_id: t.id, template_name: t.name };
}

/** Template list for the “Start from template” picker in email steps. */
dash.get('/email-templates', async (c) => {
  const rows = await all<any>(c.env, `SELECT id, name, description, kind, category, pub_id FROM templates WHERE (pub_id IS NULL OR pub_id = ?) AND kind IN ${TPL_KINDS} ORDER BY CASE kind WHEN 'welcome' THEN 0 WHEN 'automation' THEN 1 ELSE 2 END, pub_id IS NULL, created_at`, c.get('pub').id);
  return c.json({ templates: rows.map((t) => ({ id: t.id, name: t.name, description: t.description, kind: t.kind, category: t.pub_id ? 'Team' : t.category || '', team: !!t.pub_id })) });
});

dash.get('/email-templates/:tid', async (c) => {
  const t = await tplRow(c, c.req.param('tid'));
  if (!t) return c.json({ error: 'not_found' }, 404);
  return c.json(emailFromTemplate(t));
});

/** Create a draft automation whose first step is an email built from a template (welcome templates get the welcome trigger). */
dash.post('/from-template', async (c) => {
  const f = await form(c.req);
  const t = await tplRow(c, str(f.template_id));
  if (!t) return back(c, '/app/automations', 'Template not found', 'err');
  const aid = id();
  const welcome = t.kind === 'welcome';
  const steps = [{ id: id(10), type: 'send_email', config: emailFromTemplate(t) }];
  await insert(c.env, 'automations', {
    id: aid, pub_id: c.get('pub').id, name: welcome ? `Welcome email · ${t.name}` : t.name, description: t.description || '', status: 'draft', trigger: '{}', steps: '[]',
    draft_trigger: JSON.stringify({ type: 'welcome', config: {} }), draft_steps: JSON.stringify(steps), allow_reentry: 0, created_by: c.get('user').id, created_at: now(), updated_at: now(),
  });
  await audit(c, 'automation.create', aid, { template_id: t.id });
  return back(c, `/app/automations/${aid}`, welcome ? `Welcome email created from “${t.name}” — review it, then activate to send it to new subscribers.` : `Automation created from “${t.name}” — pick a trigger, then activate.`);
});

/** Welcome email entry point (linked from Settings): open existing welcome automations, or pick a design to create one. */
dash.get('/welcome', async (c) => {
  const pub = c.get('pub');
  const existing = await all<any>(c.env, `SELECT id, name, status FROM automations WHERE pub_id = ? AND status != 'archived' AND json_extract(COALESCE(draft_trigger, trigger), '$.type') = 'welcome' ORDER BY status = 'active' DESC, updated_at DESC`, pub.id);
  const tpls = await all<any>(c.env, `SELECT * FROM templates WHERE (pub_id IS NULL OR pub_id = ?) AND kind = 'welcome' ORDER BY pub_id IS NULL, created_at`, pub.id);
  return c.html(
    <DashLayout c={c} title="Welcome email" section="automations" crumbs={[['/app/automations', 'Automations']]}>
      <GalleryAssets />
      <p class="muted" style="margin-top:0">The welcome email goes out automatically when someone subscribes (after confirmation, if double opt-in is on). It's an automation with the “Welcome” trigger, so you can add more emails, delays and branches later.</p>
      {existing.length > 0 && (
        <Card title="Your welcome automations">
          <div class="stack-sm">{existing.map((a) => <div class="row between"><span><a href={`/app/automations/${a.id}`}><strong>{a.name}</strong></a> <Status s={a.status} /></span><LinkBtn small href={`/app/automations/${a.id}`}>Open</LinkBtn></div>)}</div>
        </Card>
      )}
      <h2>Start a welcome email from a design</h2>
      <div class="tg-grid">
        {tpls.map((t) => (
          <TemplateCard t={t}>
            <form method="post" action="/app/automations/from-template" class="inline-form"><input type="hidden" name="template_id" value={t.id} /><Btn small kind="primary">Use this design</Btn></form>
            <a class="btn btn-ghost btn-sm" href={`/app/posts/templates/${t.id}/preview`} target="_blank">Preview</a>
          </TemplateCard>
        ))}
      </div>
      <p class="small muted" style="margin-top:16px">Want a multi-email onboarding sequence instead? Create a new automation and pick “Welcome series”. Design your own welcome templates in <a href="/app/posts/templates">Posts → Templates</a> (set “Used for” to Welcome email).</p>
    </DashLayout>,
  );
});

dash.post('/:id/duplicate', async (c) => {
  const a = await load(c);
  if (!a) return c.notFound();
  const nid = id();
  const d = draftOf(a);
  await insert(c.env, 'automations', {
    id: nid, pub_id: a.pub_id, name: `${a.name} (copy)`, description: a.description, status: 'draft', trigger: '{}', steps: '[]',
    draft_trigger: JSON.stringify(d.trigger), draft_steps: JSON.stringify(d.steps), allow_reentry: a.allow_reentry, created_by: c.get('user').id, created_at: now(), updated_at: now(),
  });
  return back(c, `/app/automations/${nid}`, 'Automation duplicated');
});

dash.post('/:id/archive', requirePerm('manage'), async (c) => {
  const a = await load(c);
  if (!a) return c.notFound();
  await run(c.env, `UPDATE automations SET status = 'archived', updated_at = ? WHERE id = ?`, now(), a.id);
  await run(c.env, `UPDATE automation_runs SET status = 'exited', updated_at = ? WHERE automation_id = ? AND status IN ('active','waiting')`, now(), a.id);
  await audit(c, 'automation.archive', a.id);
  return back(c, '/app/automations', 'Automation archived');
});

dash.post('/:id/delete', requirePerm('manage'), async (c) => {
  const a = await load(c);
  if (!a) return c.notFound();
  await run(c.env, 'DELETE FROM automation_logs WHERE automation_id = ?', a.id);
  await run(c.env, 'DELETE FROM automations WHERE id = ?', a.id);
  await audit(c, 'automation.delete', a.id, { name: a.name });
  return back(c, '/app/automations', 'Automation deleted');
});

// ───────────────────────── status ─────────────────────────
dash.post('/:id/activate', requirePerm('publish'), async (c) => {
  const a = await load(c);
  if (!a) return c.notFound();
  if (hasDraft(a)) await publishDraft(c.env, a.id, a.pub_id);
  const fresh = (await load(c))!;
  if (!parseJSON<Step[]>(fresh.steps, []).length) return back(c, `/app/automations/${a.id}`, 'Add at least one step before activating.', 'err');
  await run(c.env, `UPDATE automations SET status = 'active', updated_at = ? WHERE id = ?`, now(), a.id);
  await audit(c, 'automation.activate', a.id);
  return back(c, `/app/automations/${a.id}`, 'Automation is live 🎉');
});

dash.post('/:id/pause', requirePerm('publish'), async (c) => {
  const a = await load(c);
  if (!a) return c.notFound();
  await run(c.env, `UPDATE automations SET status = 'paused', updated_at = ? WHERE id = ?`, now(), a.id);
  return back(c, `/app/automations/${a.id}`, 'Automation paused — subscribers will wait where they are.');
});

dash.post('/:id/resume', requirePerm('publish'), async (c) => {
  const a = await load(c);
  if (!a) return c.notFound();
  await run(c.env, `UPDATE automations SET status = 'active', updated_at = ? WHERE id = ?`, now(), a.id);
  kick(c.env, c.executionCtx);
  return back(c, `/app/automations/${a.id}`, 'Automation resumed');
});

dash.post('/:id/publish', requirePerm('publish'), async (c) => {
  const a = await load(c);
  if (!a) return c.notFound();
  await publishDraft(c.env, a.id, a.pub_id);
  await audit(c, 'automation.publish', a.id);
  if ((c.req.header('accept') || '').includes('json')) return c.json({ ok: true });
  return back(c, `/app/automations/${a.id}`, a.status === 'active' ? 'Changes published — running journeys continue on the new version.' : 'Draft saved as the live version.');
});

dash.post('/:id/discard', async (c) => {
  const a = await load(c);
  if (!a) return c.notFound();
  if (!a.published_at) return back(c, `/app/automations/${a.id}`, 'This automation has never been published — nothing to revert to.', 'err');
  await run(c.env, 'UPDATE automations SET draft_trigger = NULL, draft_steps = NULL, updated_at = ? WHERE id = ?', now(), a.id);
  return back(c, `/app/automations/${a.id}`, 'Draft discarded');
});

dash.post('/:id/settings', async (c) => {
  const a = await load(c);
  if (!a) return c.notFound();
  const f = await form(c.req);
  await run(c.env, 'UPDATE automations SET name = ?, description = ?, allow_reentry = ?, updated_at = ? WHERE id = ?', str(f.name, 120) || a.name, str(f.description, 500), bool(f.allow_reentry) ? 1 : 0, now(), a.id);
  return back(c, `/app/automations/${a.id}`, 'Settings saved');
});

// ───────────────────────── builder ─────────────────────────
dash.get('/:id', async (c) => {
  const a = await load(c);
  if (!a) return c.notFound();
  const pub = c.get('pub');
  const d = draftOf(a);
  const [catalog, senders, forms, autos] = await Promise.all([
    ruleCatalog(c.env, pub.id),
    all<any>(c.env, 'SELECT id, email, name, purpose FROM sender_addresses WHERE pub_id = ? ORDER BY is_default DESC', pub.id),
    all<any>(c.env, 'SELECT id, name FROM forms WHERE pub_id = ? ORDER BY name', pub.id),
    all<any>(c.env, `SELECT id, name FROM automations WHERE pub_id = ? AND id != ? AND status != 'archived' ORDER BY name`, pub.id, a.id),
  ]);
  const canPublish = can(c.get('role'), 'publish');
  const draftPending = hasDraft(a) && !!a.published_at;
  const meta = {
    id: a.id, status: a.status, canPublish, allowReentry: !!a.allow_reentry,
    triggers: TRIGGERS, stepTypes: STEP_TYPES, sources: FIELDS.source.options,
    senders, forms: forms.map((f) => [f.id, f.name]), automations: autos.map((x) => [x.id, x.name]),
    apiUrl: `${c.env.APP_URL.replace(/\/$/, '')}/api/v2/automations/${a.id}/enroll`, userEmail: c.get('user').email,
  };
  return c.html(
    <DashLayout
      c={c} title={a.name} section="automations" wide crumbs={[['/app/automations', 'Automations']]}
      styles={['/static/automations.css', '/static/editor.css']}
      scripts={['/static/rules.js', '/static/editor.js', '/static/automations.js']}
      actions={
        <>
          <Status s={a.status} />
          <span class="af-save muted small" id="af-save">All changes saved</span>
          <OpenBtn target="#af-settings" kind="secondary">Settings</OpenBtn>
          {canPublish && a.status === 'active' && <ActionForm action={`/app/automations/${a.id}/pause`} label="Pause" kind="secondary" small={false} />}
          {canPublish && a.status === 'paused' && <ActionForm action={`/app/automations/${a.id}/resume`} label="Resume" kind="secondary" small={false} />}
          {canPublish && (a.status === 'active' || a.status === 'paused') && <form method="post" action={`/app/automations/${a.id}/publish`} class="inline-form" id="af-publish-form" style={draftPending ? '' : 'display:none'}><Btn class="btn-accent" confirm="Publish your draft? Subscribers already in the journey continue from the same step on the new version.">Publish changes</Btn></form>}
          {canPublish && (a.status === 'draft' || a.status === 'archived') && <form method="post" action={`/app/automations/${a.id}/activate`} class="inline-form" id="af-publish-form"><Btn class="btn-accent" confirm="Activate this automation? New subscribers matching the trigger will start the journey.">Activate</Btn></form>}
        </>
      }
    >
      <AutomationTabs a={a} active={`/app/automations/${a.id}`} />
      {draftPending && (
        <div class="callout warn row between" id="af-draft-banner">
          <span><strong>You have unpublished changes.</strong> The live version keeps running until you publish.</span>
          <span class="row"><a class="btn btn-secondary btn-sm" href={`/app/automations/${a.id}/compare`}>Compare draft vs live</a><ActionForm action={`/app/automations/${a.id}/discard`} label="Discard draft" kind="ghost" confirm="Throw away your draft changes and go back to the live version?" /></span>
        </div>
      )}
      {a.status === 'draft' && <div class="callout">This automation is a draft. Build your flow, then {canPublish ? 'click Activate' : 'ask an editor to activate it'} to start enrolling subscribers.</div>}
      {!canPublish && <div class="callout warn">You're a contributor: you can edit this draft, but only members and admins can activate or publish it.</div>}
      <div class="af-shell">
        <div class="af-canvas-wrap">
          <div class="af-bulk" id="af-bulk" hidden>
            <span id="af-bulk-count">0 selected</span>
            <button type="button" class="btn btn-secondary btn-sm" data-bulk="up">↑ Move up</button>
            <button type="button" class="btn btn-secondary btn-sm" data-bulk="down">↓ Move down</button>
            <label class="row small">Move to position <input type="number" min="1" class="input af-pos" id="af-bulk-pos" /></label>
            <button type="button" class="btn btn-secondary btn-sm" data-bulk="to">Move</button>
            <button type="button" class="btn btn-danger btn-sm" data-bulk="delete">Delete</button>
            <button type="button" class="btn btn-ghost btn-sm" data-bulk="clear">Clear</button>
          </div>
          <div id="af-canvas" class="af-canvas" aria-label="Automation flow" />
        </div>
        <aside class="af-panel" id="af-panel" />
      </div>
      <dialog id="af-picker" class="modal af-picker">
        <header class="modal-h"><h3>Add a step</h3><button type="button" class="btn btn-ghost btn-sm" data-close>✕</button></header>
        <div class="modal-b" id="af-picker-body" />
      </dialog>
      <dialog id="af-preview" class="modal modal-wide">
        <header class="modal-h"><h3>Email preview</h3><button type="button" class="btn btn-ghost btn-sm" data-close>✕</button></header>
        <div class="modal-b"><iframe id="af-preview-frame" class="preview-frame" title="Email preview" /></div>
      </dialog>
      <Modal id="af-settings" title="Automation settings">
        <form method="post" action={`/app/automations/${a.id}/settings`} class="stack">
          <Field label="Name"><Input name="name" value={a.name} required /></Field>
          <Field label="Description"><Textarea name="description" value={a.description} rows={3} /></Field>
          <Toggle name="allow_reentry" checked={!!a.allow_reentry} label="Allow subscribers to re-enter" hint="When off, each subscriber can go through this automation only once." />
          <Field label="Enroll via API" hint="POST with your API key and {&quot;email&quot;: &quot;…&quot;} or {&quot;subscriber_id&quot;: &quot;…&quot;}"><input class="input mono" readonly value={meta.apiUrl} /></Field>
          <div class="form-actions"><Btn>Save</Btn></div>
        </form>
      </Modal>
      <Json id="af-data" data={{ trigger: d.trigger, steps: d.steps }} />
      <Json id="af-meta" data={meta} />
      <Json id="rule-catalog" data={catalog} />
    </DashLayout>,
  );
});

dash.get('/:id/draft', async (c) => {
  const a = await load(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  return c.json({ ...draftOf(a), live: liveOf(a), status: a.status, has_draft: hasDraft(a) });
});

dash.put('/:id/draft', async (c) => {
  const a = await load(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json<any>().catch(() => null);
  if (!body) return c.json({ error: 'invalid_json' }, 400);
  const trigger = normalizeTrigger(body.trigger);
  const steps = normalizeSteps(body.steps);
  const tj = JSON.stringify(trigger), sj = JSON.stringify(steps);
  // identical to live → no pending draft
  const same = a.published_at && tj === JSON.stringify(normalizeTrigger(parseJSON(a.trigger, {}))) && sj === JSON.stringify(normalizeSteps(parseJSON(a.steps, [])));
  await run(c.env, 'UPDATE automations SET draft_trigger = ?, draft_steps = ?, updated_at = ? WHERE id = ?', same ? null : tj, same ? null : sj, now(), a.id);
  if (typeof body.allow_reentry === 'boolean') await run(c.env, 'UPDATE automations SET allow_reentry = ? WHERE id = ?', body.allow_reentry ? 1 : 0, a.id);
  return c.json({ ok: true, has_draft: !same, steps, trigger });
});

/** Preview / test-send an email step from the builder (simulated subscriber). */
async function stepEmail(c: Ctx, body: any) {
  const pub = c.get('pub');
  const cfg = body?.config || {};
  const content: Content = { title: cfg.title || '', subtitle: '', doc: cfg.doc || { blocks: [] }, preview_text: cfg.preview_text || '', style: cfg.style && typeof cfg.style === 'object' ? JSON.stringify(cfg.style) : null, hideHeader: !cfg.title };
  const sample = (await one<Subscriber>(c.env, `SELECT * FROM subscribers WHERE pub_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`, pub.id)) ||
    ({ id: 'preview', pub_id: pub.id, email: c.get('user').email, name: c.get('user').name, tier: 'free', referral_code: 'preview', referral_count: 0, custom: '{}', created_at: now() } as Subscriber);
  const built = await buildEmail(c.env, pub, content, sample, {});
  return { built, sample, cfg, pub };
}

dash.post('/:id/preview-email', async (c) => {
  const a = await load(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const { built, sample } = await stepEmail(c, await c.req.json());
  return c.json({ html: built.html, bytes: built.bytes, as: sample.email });
});

dash.post('/:id/test-email', async (c) => {
  const a = await load(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json<any>();
  const { built, cfg, pub } = await stepEmail(c, body);
  const to = str(body.to) || c.get('user').email;
  const from = await senderFor(c.env, pub as Publication, 'automations', cfg.sender_id);
  const res = await sendMail(c.env, { to, subject: '[Test] ' + (cfg.subject || a.name), html: built.html, text: built.text, from, pub: pub as Publication, kind: 'transactional' });
  return c.json({ ok: res.ok, status: res.status, error: res.error, to });
});

// ───────────────────────── compare ─────────────────────────
dash.get('/:id/compare', async (c) => {
  const a = await load(c);
  if (!a) return c.notFound();
  const names = await nameMap(c);
  const d = draftOf(a), l = liveOf(a);
  const dFlat = flatten(d.steps), lFlat = flatten(l.steps);
  const lById = new Map(lFlat.map((f) => [f.step.id, f]));
  const dById = new Map(dFlat.map((f) => [f.step.id, f]));
  const sig = (s: Step) => JSON.stringify({ t: s.type, c: s.config });
  const stateOf = (f: (typeof dFlat)[number], other: Map<string, any>) => {
    const o = other.get(f.step.id);
    if (!o) return 'added';
    if (sig(o.step) !== sig(f.step)) return 'changed';
    if (o.label !== f.label || o.depth !== f.depth) return 'moved';
    return 'same';
  };
  const trigChanged = JSON.stringify(normalizeTrigger(d.trigger)) !== JSON.stringify(normalizeTrigger(l.trigger));
  const counts = { added: dFlat.filter((f) => !lById.has(f.step.id)).length, removed: lFlat.filter((f) => !dById.has(f.step.id)).length, changed: dFlat.filter((f) => stateOf(f, lById) === 'changed').length };
  const Col = (p: { title: string; flat: typeof dFlat; trig: any; other: Map<string, any>; side: 'draft' | 'live' }) => (
    <Card title={p.title}>
      <div class={`af-cmp-row ${trigChanged ? 'changed' : ''}`}><strong>Trigger</strong><div class="small muted">{triggerSummary(p.trig, names)}</div></div>
      {p.flat.length ? p.flat.map((f) => {
        const st = p.side === 'draft' ? stateOf(f, p.other) : p.other.has(f.step.id) ? stateOf(f, p.other) : 'removed';
        return (
          <div class={`af-cmp-row ${st}`} style={`margin-left:${f.depth * 22}px`}>
            {f.label && <span class="badge b-gray">{f.label}</span>} <strong>{stepLabel(f.step)}</strong> {st !== 'same' && <span class="af-cmp-tag">{st}</span>}
            <div class="small muted">{stepSummary(f.step, names)}</div>
          </div>
        );
      }) : <p class="muted">No steps.</p>}
    </Card>
  );
  return c.html(
    <DashLayout c={c} title={a.name} section="automations" wide crumbs={[['/app/automations', 'Automations']]} styles={['/static/automations.css']}
      actions={hasDraft(a) && a.published_at && can(c.get('role'), 'publish') ? <form method="post" action={`/app/automations/${a.id}/publish`} class="inline-form"><Btn class="btn-accent">Publish draft</Btn></form> : undefined}>
      <AutomationTabs a={a} active={`/app/automations/${a.id}/compare`} />
      {!a.published_at ? <div class="callout">This automation has never been published, so there is no live version yet.</div>
        : !hasDraft(a) ? <div class="callout ok">The draft matches the live version — nothing to publish.</div>
        : <div class="callout warn">{trigChanged ? 'Trigger changed · ' : ''}{counts.added} added · {counts.removed} removed · {counts.changed} changed. Running journeys continue from their current step after publishing; subscribers on removed steps exit.</div>}
      <div class="grid g2">
        <Col title="Live version" flat={lFlat} trig={l.trigger} other={dById} side="live" />
        <Col title="Draft" flat={dFlat} trig={d.trigger} other={lById} side="draft" />
      </div>
    </DashLayout>,
  );
});

// ───────────────────────── journeys ─────────────────────────
dash.get('/:id/journeys', async (c) => {
  const a = await load(c);
  if (!a) return c.notFound();
  const status = c.req.query('status') || '';
  const q = (c.req.query('q') || '').trim().toLowerCase();
  const page = Math.max(1, int(c.req.query('page'), 1));
  const where: string[] = ['r.automation_id = ?'];
  const params: unknown[] = [a.id];
  if (status) { where.push(status === 'in_progress' ? `r.status IN ('active','waiting')` : 'r.status = ?'); if (status !== 'in_progress') params.push(status); }
  if (q) { where.push('(s.email LIKE ? OR s.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const runs = await all<any>(c.env, `SELECT r.*, s.email, s.name FROM automation_runs r LEFT JOIN subscribers s ON s.id = r.subscriber_id WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT 51 OFFSET ?`, ...params, (page - 1) * 50);
  const total = await val<number>(c.env, `SELECT COUNT(*) FROM automation_runs r LEFT JOIN subscribers s ON s.id = r.subscriber_id WHERE ${where.join(' AND ')}`, ...params);
  const segments = await all<any>(c.env, 'SELECT id, name, cached_count FROM segments WHERE pub_id = ? ORDER BY name', a.pub_id);
  const steps = liveOf(a).steps;
  const names = await nameMap(c);
  const current = (r: any) => {
    if (r.status === 'completed' || r.status === 'exited') return <span class="muted">—</span>;
    const s = getAt(steps, parseJSON<Path>(r.step_path, [0]));
    return s ? <span>{stepLabel(s)} <span class="small muted">{stepSummary(s, names)}</span></span> : <span class="muted">end</span>;
  };
  const base = `/app/automations/${a.id}/journeys`;
  const qsBase = (o: Record<string, string | number>) => base + '?' + new URLSearchParams({ status, q, ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)])) }).toString();
  return c.html(
    <DashLayout c={c} title={a.name} section="automations" wide crumbs={[['/app/automations', 'Automations']]} styles={['/static/automations.css']}
      actions={can(c.get('role'), 'publish') ? <OpenBtn target="#af-enroll">Enroll subscribers</OpenBtn> : undefined}>
      <AutomationTabs a={a} active={base} />
      {a.status !== 'active' && <div class="callout warn">This automation is {a.status}. Enrolled subscribers only progress while it is active.</div>}
      <Card pad={false} title={`${num(total)} journeys`} actions={
        <form method="get" class="row">
          <input class="input" name="q" value={q} placeholder="Search email or name" style="width:220px" />
          <select class="input" name="status" data-autosubmit style="width:160px">
            {[['', 'All statuses'], ['in_progress', 'In progress'], ['waiting', 'Waiting'], ['completed', 'Completed'], ['exited', 'Exited'], ['failed', 'Failed']].map(([v, l]) => <option value={v} selected={v === status}>{l}</option>)}
          </select>
          <Btn kind="secondary" small>Filter</Btn>
        </form>
      }>
        <Table
          rows={runs.slice(0, 50)}
          rowHref={(r: any) => `${base}/${r.id}`}
          empty="No one has entered this automation yet."
          cols={[
            { h: 'Subscriber', r: (r: any) => <div><a href={`${base}/${r.id}`}>{r.email || '(deleted subscriber)'}</a><div class="small muted">{r.name}</div></div> },
            { h: 'Status', r: (r: any) => <Status s={r.status} /> },
            { h: 'Current step', r: current },
            { h: 'Started', r: (r: any) => ago(r.created_at) },
            { h: 'Next run', r: (r: any) => (r.next_run_at && ['active', 'waiting'].includes(r.status) ? fmtDateTime(r.next_run_at, c.get('pub').timezone) : '—') },
          ]}
        />
        <div class="pager" style="padding:10px 14px">
          <span class="muted">Page {page}</span>
          <span>{page > 1 && <a class="btn btn-ghost btn-sm" href={qsBase({ page: page - 1 })}>← Previous</a>}{runs.length > 50 && <a class="btn btn-ghost btn-sm" href={qsBase({ page: page + 1 })}>Next →</a>}</span>
        </div>
      </Card>
      <Modal id="af-enroll" title="Enroll subscribers">
        <form method="post" action={`/app/automations/${a.id}/enroll`} class="stack">
          <Field label="One subscriber" hint="Email address of an existing subscriber."><Input name="email" type="email" placeholder="reader@example.com" /></Field>
          <div class="divider-text">or</div>
          <Field label="A whole segment" hint="Every active subscriber in the segment is enrolled in the background.">
            <select class="input" name="segment_id"><option value="">Choose a segment…</option>{segments.map((s) => <option value={s.id}>{s.name} ({num(s.cached_count)})</option>)}</select>
          </Field>
          <div class="form-actions"><Btn>Enroll</Btn></div>
        </form>
      </Modal>
    </DashLayout>,
  );
});

dash.get('/:id/journeys/:runId', async (c) => {
  const a = await load(c);
  if (!a) return c.notFound();
  const r = await one<any>(c.env, 'SELECT r.*, s.email, s.name, s.id AS sid FROM automation_runs r LEFT JOIN subscribers s ON s.id = r.subscriber_id WHERE r.id = ? AND r.automation_id = ?', c.req.param('runId'), a.id);
  if (!r) return c.notFound();
  const logs = await all<any>(c.env, 'SELECT * FROM automation_logs WHERE run_id = ? ORDER BY created_at, rowid', r.id);
  const stepMap = new Map(flatten(liveOf(a).steps).map((f) => [f.step.id, f.step]));
  const names = await nameMap(c);
  const emails = await all<any>(c.env, `SELECT d.*, s.step_id, s.subject FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.automation_id = ? AND d.subscriber_id = ? ORDER BY d.created_at`, a.id, r.subscriber_id);
  return c.html(
    <DashLayout c={c} title={r.email || 'Journey'} section="automations" crumbs={[['/app/automations', 'Automations'], [`/app/automations/${a.id}/journeys`, a.name]]} styles={['/static/automations.css']}
      actions={['active', 'waiting'].includes(r.status) && can(c.get('role'), 'publish') ? <ActionForm action={`/app/automations/${a.id}/runs/${r.id}/exit`} label="Remove from automation" kind="danger" small={false} confirm="Stop this subscriber's journey?" /> : undefined}>
      <div class="split">
        <Card title="Timeline">
          <ul class="timeline">
            {logs.map((l) => {
              const s = l.step_id ? stepMap.get(l.step_id) : null;
              return (
                <li>
                  <strong>{s ? stepLabel(s) : l.action === 'enrolled' ? 'Entered automation' : l.action === 'completed' ? 'Completed automation' : l.action === 'exited' ? 'Exited' : STEP_TYPES[l.action] || l.action}</strong>
                  {s && <span class="muted small"> · {stepSummary(s, names)}</span>}
                  <div class="small muted">{fmtDateTime(l.created_at, c.get('pub').timezone)}{l.result && l.result !== 'ok' ? ` — ${l.result}` : ''}</div>
                </li>
              );
            })}
          </ul>
        </Card>
        <div>
          <Card title="Journey">
            <dl class="kv">
              <dt>Status</dt><dd><Status s={r.status} /></dd>
              <dt>Started</dt><dd>{fmtDateTime(r.created_at, c.get('pub').timezone)}</dd>
              <dt>Next step at</dt><dd>{r.next_run_at && ['active', 'waiting'].includes(r.status) ? fmtDateTime(r.next_run_at, c.get('pub').timezone) : '—'}</dd>
              <dt>Subscriber</dt><dd>{r.sid ? <a href={`/app/audience/subscribers/${r.sid}`}>{r.email}</a> : 'deleted'}</dd>
            </dl>
          </Card>
          <Card title="Emails in this journey" pad={false}>
            <Table rows={emails} empty="No emails yet." cols={[
              { h: 'Email', r: (e: any) => e.subject },
              { h: 'Status', r: (e: any) => <Status s={e.status} /> },
              { h: 'Opened', r: (e: any) => (e.opened_at ? '✓' : '—'), class: 'center' },
              { h: 'Clicked', r: (e: any) => (e.clicked_at ? '✓' : '—'), class: 'center' },
            ]} />
          </Card>
        </div>
      </div>
    </DashLayout>,
  );
});

dash.post('/:id/runs/:runId/exit', requirePerm('publish'), async (c) => {
  const a = await load(c);
  if (!a) return c.notFound();
  const res = await run(c.env, `UPDATE automation_runs SET status = 'exited', next_run_at = NULL, updated_at = ? WHERE id = ? AND automation_id = ? AND status IN ('active','waiting')`, now(), c.req.param('runId'), a.id);
  if (res.meta.changes) await insert(c.env, 'automation_logs', { id: id(), run_id: c.req.param('runId'), automation_id: a.id, step_id: null, action: 'exited', result: `removed by ${c.get('user').email}`, created_at: now() });
  return back(c, `/app/automations/${a.id}/journeys/${c.req.param('runId')}`, 'Subscriber removed from the automation');
});

dash.post('/:id/enroll', requirePerm('publish'), async (c) => {
  const a = await load(c);
  if (!a) return c.notFound();
  const isJson = (c.req.header('content-type') || '').includes('json');
  const body: any = isJson ? await c.req.json().catch(() => ({})) : await form(c.req);
  const reply = (ok: boolean, msg: string, extra: Record<string, unknown> = {}) =>
    isJson ? c.json({ ok, message: msg, ...extra }, ok ? 200 : 400) : back(c, `/app/automations/${a.id}/journeys`, msg, ok ? 'ok' : 'err');
  if (a.status !== 'active') return reply(false, 'Activate the automation before enrolling subscribers.');
  const segId = str(body.segment_id);
  if (segId) {
    const seg = await one<any>(c.env, 'SELECT id, name FROM segments WHERE id = ? AND pub_id = ?', segId, a.pub_id);
    if (!seg) return reply(false, 'Segment not found');
    await enqueue(c.env, 'automation.enroll_segment', { automation_id: a.id, pub_id: a.pub_id, segment_id: seg.id, after: null });
    kick(c.env, c.executionCtx);
    return reply(true, `Enrolling everyone in “${seg.name}” in the background.`);
  }
  const key = str(body.subscriber_id) || str(body.email).toLowerCase();
  if (!key) return reply(false, 'Enter an email or choose a segment.');
  const sub = await one<Subscriber>(c.env, 'SELECT * FROM subscribers WHERE pub_id = ? AND (id = ? OR email = ?)', a.pub_id, key, key);
  if (!sub) return reply(false, 'No subscriber with that email.');
  const res = await enroll(c.env, a.id, sub.id, { trigger: 'manual', by: c.get('user').email });
  return reply(res.ok, res.ok ? `${sub.email} enrolled` : `Could not enroll: ${res.reason}`, { run_id: res.runId });
});

registerJob('automation.enroll_segment', async (env, p) => {
  const subs = await listMatching(env, p.pub_id, segmentGroup(p.segment_id), { after: p.after || undefined, limit: 200 });
  for (const s of subs) await enroll(env, p.automation_id, s.id, { trigger: 'segment', segment_id: p.segment_id });
  if (subs.length === 200) await enqueue(env, 'automation.enroll_segment', { ...p, after: subs[subs.length - 1].id });
});

// ───────────────────────── analytics ─────────────────────────
async function stats(c: Ctx, a: AutomationRow) {
  const [runs, emails, reached] = await Promise.all([
    one<any>(c.env, `SELECT COUNT(*) AS enrolled, SUM(CASE WHEN status IN ('active','waiting') THEN 1 ELSE 0 END) AS in_progress, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed, SUM(CASE WHEN status = 'exited' THEN 1 ELSE 0 END) AS exited FROM automation_runs WHERE automation_id = ?`, a.id),
    all<any>(c.env, `SELECT s.step_id, s.subject, COUNT(d.id) AS delivered, SUM(CASE WHEN d.status IN ('sent','deferred') THEN 1 ELSE 0 END) AS sent, SUM(CASE WHEN d.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened, SUM(CASE WHEN d.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked, SUM(CASE WHEN d.status IN ('bounced','failed') THEN 1 ELSE 0 END) AS bounced, SUM(CASE WHEN sub.unsubscribed_at IS NOT NULL AND sub.unsubscribed_at > d.created_at THEN 1 ELSE 0 END) AS unsubs FROM sends s LEFT JOIN deliveries d ON d.send_id = s.id LEFT JOIN subscribers sub ON sub.id = d.subscriber_id WHERE s.automation_id = ? GROUP BY s.id`, a.id),
    all<any>(c.env, `SELECT step_id, COUNT(DISTINCT run_id) AS n FROM automation_logs WHERE automation_id = ? AND step_id IS NOT NULL GROUP BY step_id`, a.id),
  ]);
  return { runs: { enrolled: runs?.enrolled || 0, in_progress: runs?.in_progress || 0, completed: runs?.completed || 0, exited: runs?.exited || 0 }, emails, reached: Object.fromEntries(reached.map((r) => [r.step_id, r.n])) as Record<string, number> };
}

dash.get('/:id/stats', async (c) => {
  const a = await load(c);
  if (!a) return c.json({ error: 'not_found' }, 404);
  return c.json(await stats(c, a));
});

dash.get('/:id/analytics', async (c) => {
  const a = await load(c);
  if (!a) return c.notFound();
  const s = await stats(c, a);
  const names = await nameMap(c);
  const flat = flatten(liveOf(a).steps);
  const emailById = new Map(s.emails.map((e) => [e.step_id, e]));
  const emailSteps = flat.filter((f) => f.step.type === 'send_email');
  const totals = s.emails.reduce((t, e) => ({ sent: t.sent + (e.sent || 0), opened: t.opened + (e.opened || 0), clicked: t.clicked + (e.clicked || 0) }), { sent: 0, opened: 0, clicked: 0 });
  return c.html(
    <DashLayout c={c} title={a.name} section="automations" wide crumbs={[['/app/automations', 'Automations']]} styles={['/static/automations.css']}>
      <AutomationTabs a={a} active={`/app/automations/${a.id}/analytics`} />
      <Stats>
        <Stat label="Enrolled" value={num(s.runs.enrolled)} />
        <Stat label="In progress" value={num(s.runs.in_progress)} />
        <Stat label="Completed" value={num(s.runs.completed)} sub={`${pct(s.runs.completed, s.runs.enrolled)} completion rate`} />
        <Stat label="Exited early" value={num(s.runs.exited)} />
        <Stat label="Emails sent" value={num(totals.sent)} sub={`${pct(totals.opened, totals.sent)} open · ${pct(totals.clicked, totals.sent)} click`} />
      </Stats>
      <Card title="Email performance" pad={false}>
        <Table
          rows={emailSteps}
          empty="This automation has no email steps yet."
          cols={[
            { h: 'Email', r: (f) => <div><strong>{f.step.config?.subject || '(no subject)'}</strong>{f.label && <div class="small muted">Branch: {f.label}</div>}</div> },
            { h: 'Sent', r: (f) => num(emailById.get(f.step.id)?.sent || 0), class: 'right' },
            { h: 'Opens', r: (f) => { const e = emailById.get(f.step.id); return <span>{num(e?.opened || 0)} <span class="muted small">{pct(e?.opened || 0, e?.sent || 0)}</span></span>; }, class: 'right' },
            { h: 'Clicks', r: (f) => { const e = emailById.get(f.step.id); return <span>{num(e?.clicked || 0)} <span class="muted small">{pct(e?.clicked || 0, e?.sent || 0)}</span></span>; }, class: 'right' },
            { h: 'Bounced', r: (f) => num(emailById.get(f.step.id)?.bounced || 0), class: 'right' },
            { h: 'Unsubscribed', r: (f) => num(emailById.get(f.step.id)?.unsubs || 0), class: 'right' },
          ]}
        />
      </Card>
      <Card title="Funnel — subscribers who reached each step">
        <Bars max={Math.max(1, s.runs.enrolled)} rows={[
          { label: <strong>Entered</strong>, value: s.runs.enrolled },
          ...flat.map((f) => ({ label: <span style={`padding-left:${f.depth * 14}px`}>{f.label ? <span class="muted">{f.label} › </span> : null}{stepLabel(f.step)} <span class="muted small">{stepSummary(f.step, names)}</span></span>, value: s.reached[f.step.id] || 0, sub: pct(s.reached[f.step.id] || 0, s.runs.enrolled) })),
          { label: <strong>Completed</strong>, value: s.runs.completed },
        ]} />
      </Card>
    </DashLayout>,
  );
});

export default { dash, site, root } satisfies Module;
