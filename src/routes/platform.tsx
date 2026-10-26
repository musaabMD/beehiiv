/** @jsxImportSource hono/jsx */
// Module: platform — the hosted service's operator area (/app/admin, SUPERADMIN_EMAILS / users.is_superadmin only)
// and the simulated plan checkout (/checkout/plan/:id, used when STRIPE_SECRET_KEY is not set).
// Admin: every workspace with plan, usage, send stats, bounce/complaint rates and status; approve/reject held campaigns,
// resume/cancel safety-paused campaigns, suspend/unsuspend sending, change plans, edit the plan catalog.
import { Hono } from 'hono';
import type { AppEnv, Ctx, Module } from '../types';
import { one, all, run } from '../lib/db';
import { currentUser } from '../lib/auth';
import { DashLayout, PlainLayout } from '../ui/layout';
import { Card, Field, Input, Select, Btn, ActionForm, Table, Badge, Status, Help, Tabs, Stats, Stat, Muted, back, flash } from '../ui/components';
import { listPlans, getPlan, planStatus, isSuperadmin, monthStart, clearPlanCache, LIMITS, FREE_PLAN_ID, effectivePlanId } from '../lib/plans';
import { accountStats, suspendWorkspace, unsuspendWorkspace, approveSend, rejectSend, resumeSend } from '../lib/safety';
import { setPlan, completeCheckout } from '../lib/platformbilling';
import { id, now, num, money, ago, fmtDate, fmtDateTime, form, str, int, esc, DAY } from '../lib/util';
import { audit } from '../lib/auth';

const dash = new Hono<AppEnv>();
const root = new Hono<AppEnv>();

dash.use('*', async (c, next) => {
  if (!isSuperadmin(c.env, c.get('user'))) return c.html(`<p style="font-family:sans-serif;padding:40px">Not found.</p>`, 404);
  await next();
});

const TABS: Array<[string, string]> = [['/app/admin', 'Workspaces'], ['/app/admin/sends', 'Campaign review'], ['/app/admin/plans', 'Plans'], ['/app/admin/events', 'Activity']];
function page(c: Ctx, active: string, title: string, body: any, crumbs?: Array<[string, string]>) {
  return c.html(<DashLayout c={c} title={title} section="admin" crumbs={crumbs} wide><Tabs items={TABS} active={active} />{body}</DashLayout>);
}
const rate = (n: number, d: number, digits = 2) => (d ? `${((n / d) * 100).toFixed(digits)}%` : '—');
const actor = (c: Ctx) => c.get('user').email;

// ───────── workspaces ─────────
dash.get('/', async (c) => {
  const q = str(c.req.query('q'), 100).trim().toLowerCase();
  const status = c.req.query('status') || '';
  const t = now();
  const where: string[] = [];
  const params: unknown[] = [];
  if (q) { where.push(`(LOWER(w.name) LIKE ? OR LOWER(u.email) LIKE ? OR w.id IN (SELECT workspace_id FROM publications WHERE slug LIKE ? OR LOWER(name) LIKE ?))`); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  if (status === 'suspended') where.push(`w.sending_status = 'suspended'`);
  if (status === 'paid') where.push(`w.plan_id != 'free'`);
  if (status === 'past_due') where.push(`w.plan_status = 'past_due'`);
  const rows = await all<any>(c.env, `SELECT w.*, u.email AS owner_email,
      (SELECT COUNT(*) FROM publications p WHERE p.workspace_id = w.id AND p.status != 'deleted') AS pubs,
      (SELECT COUNT(*) FROM subscribers s WHERE s.status = 'active' AND s.pub_id IN (SELECT id FROM publications WHERE workspace_id = w.id)) AS subs,
      (SELECT COUNT(*) FROM deliveries d WHERE d.sent_at >= ? AND d.pub_id IN (SELECT id FROM publications WHERE workspace_id = w.id)) AS emails_month,
      (SELECT COUNT(*) FROM deliveries d WHERE d.created_at >= ? AND d.status IN ('sent','deferred','bounced','complained') AND d.pub_id IN (SELECT id FROM publications WHERE workspace_id = w.id)) AS att30,
      (SELECT COUNT(*) FROM deliveries d WHERE d.created_at >= ? AND d.status = 'bounced' AND d.pub_id IN (SELECT id FROM publications WHERE workspace_id = w.id)) AS b30,
      (SELECT COUNT(*) FROM deliveries d WHERE d.created_at >= ? AND d.status = 'complained' AND d.pub_id IN (SELECT id FROM publications WHERE workspace_id = w.id)) AS c30,
      (SELECT COUNT(*) FROM sends s WHERE s.status IN ('paused','pending_approval') AND s.pub_id IN (SELECT id FROM publications WHERE workspace_id = w.id)) AS held
    FROM workspaces w LEFT JOIN users u ON u.id = w.owner_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY w.created_at DESC LIMIT 200`,
    monthStart(t), t - LIMITS.ACCOUNT_WINDOW_DAYS * DAY, t - LIMITS.ACCOUNT_WINDOW_DAYS * DAY, t - LIMITS.ACCOUNT_WINDOW_DAYS * DAY, ...params);
  const plans = await listPlans(c.env, { includeInactive: true });
  const pn = (pid: string) => plans.find((p) => p.id === pid);
  const [pending, paused, suspended, total, paid] = await Promise.all([
    one<{ n: number }>(c.env, `SELECT COUNT(*) AS n FROM sends WHERE status = 'pending_approval'`),
    one<{ n: number }>(c.env, `SELECT COUNT(*) AS n FROM sends WHERE status = 'paused'`),
    one<{ n: number }>(c.env, `SELECT COUNT(*) AS n FROM workspaces WHERE sending_status = 'suspended'`),
    one<{ n: number }>(c.env, `SELECT COUNT(*) AS n FROM workspaces`),
    one<{ n: number }>(c.env, `SELECT COUNT(*) AS n FROM workspaces WHERE plan_id != 'free'`),
  ]);
  return page(c, '/app/admin', 'Platform admin', <>
    <Stats>
      <Stat label="Workspaces" value={num(total?.n || 0)} sub={`${num(paid?.n || 0)} on paid plans`} />
      <Stat label="Waiting for approval" value={num(pending?.n || 0)} href="/app/admin/sends" />
      <Stat label="Paused campaigns" value={num(paused?.n || 0)} href="/app/admin/sends" />
      <Stat label="Suspended accounts" value={num(suspended?.n || 0)} href="/app/admin?status=suspended" />
    </Stats>
    <form method="get" class="row" style="margin:14px 0;gap:8px">
      <input class="input" name="q" value={q} placeholder="Search workspace, owner email, publication…" style="max-width:360px" />
      <Select name="status" value={status} options={[['', 'All'], ['suspended', 'Suspended'], ['paid', 'Paid plans'], ['past_due', 'Payment failed']]} attrs={{ style: 'max-width:200px' }} />
      <Btn kind="secondary" small>Filter</Btn>
    </form>
    <Card pad={false}>
      <Table<any> rows={rows} empty="No workspaces." rowHref={(w) => `/app/admin/w/${w.id}`} cols={[
        { h: 'Workspace', r: (w) => <><strong>{w.name}</strong><div class="small muted">{w.owner_email} · {w.pubs} pub{w.pubs === 1 ? '' : 's'}</div></> },
        { h: 'Plan', r: (w) => <>{pn(w.plan_id)?.name || w.plan_id}{w.plan_status === 'past_due' ? <> <Badge tone="red">past due</Badge></> : null}{w.plan_pending_id ? <div class="small muted">→ {w.plan_pending_id}</div> : null}</> },
        { h: 'Subscribers', r: (w) => { const p = pn(effectivePlanId(w)); return <span class={p?.max_subscribers && w.subs > p.max_subscribers ? 'text-danger' : ''}>{num(w.subs)}{p?.max_subscribers ? <Muted> / {num(p.max_subscribers)}</Muted> : null}</span>; } },
        { h: 'Emails (month)', r: (w) => { const p = pn(effectivePlanId(w)); return <>{num(w.emails_month)}{p?.monthly_emails ? <Muted> / {num(p.monthly_emails)}</Muted> : null}</>; } },
        { h: 'Sent 30d', r: (w) => num(w.att30) },
        { h: 'Bounce', r: (w) => <span style={w.att30 >= LIMITS.ACCOUNT_MIN_DELIVERIES && w.b30 / w.att30 > LIMITS.ACCOUNT_MAX_BOUNCE_RATE ? 'color:#dc2626;font-weight:600' : ''}>{rate(w.b30, w.att30, 1)}</span> },
        { h: 'Complaints', r: (w) => <span style={w.att30 >= LIMITS.ACCOUNT_MIN_DELIVERIES && w.c30 / w.att30 > LIMITS.ACCOUNT_MAX_COMPLAINT_RATE ? 'color:#dc2626;font-weight:600' : ''}>{rate(w.c30, w.att30, 2)}</span> },
        { h: 'Status', r: (w) => <>{w.sending_status === 'suspended' ? <Badge tone="red">suspended</Badge> : w.held ? <Badge tone="amber">{w.held} held</Badge> : <Badge tone="green">active</Badge>}{!w.trusted_at ? <div class="small muted">new</div> : null}</> },
        { h: 'Created', r: (w) => ago(w.created_at) },
      ]} />
    </Card>
  </>);
});

dash.get('/w/:id', async (c) => {
  const st = await planStatus(c.env, c.req.param('id'));
  if (!st) return c.notFound();
  const ws = st.ws;
  const [owner, pubs, sends, events, acct, plans] = await Promise.all([
    one<any>(c.env, 'SELECT email, name FROM users WHERE id = ?', ws.owner_id),
    all<any>(c.env, `SELECT p.id, p.slug, p.name, p.status, (SELECT COUNT(*) FROM subscribers s WHERE s.pub_id = p.id AND s.status = 'active') AS subs FROM publications p WHERE p.workspace_id = ? ORDER BY p.created_at`, ws.id),
    all<any>(c.env, `SELECT s.*, p.name AS pub_name FROM sends s JOIN publications p ON p.id = s.pub_id WHERE p.workspace_id = ? AND s.kind = 'post' ORDER BY s.created_at DESC LIMIT 25`, ws.id),
    all<any>(c.env, 'SELECT * FROM platform_events WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 30', ws.id),
    accountStats(c.env, ws.id),
    listPlans(c.env, { includeInactive: true }),
  ]);
  return page(c, '/app/admin', ws.name, <>
    {st.suspended && <div class="callout danger">Sending suspended {ws.sending_changed_at ? ago(ws.sending_changed_at) : ''}: {ws.sending_note}</div>}
    <div class="grid g2">
      <Card title="Account">
        <p style="margin-top:0">Owner: <strong>{owner?.email}</strong> {owner?.name}<br />Created {fmtDateTime(ws.created_at)} ({ago(ws.created_at)}){st.newAccount.active ? ' · new-account ramp active' : ''}<br />
          Trusted for large campaigns: {ws.trusted_at ? fmtDate(ws.trusted_at) : 'not yet'}{st.exempt ? ' · operator workspace (exempt)' : ''}</p>
        <p>Plan: <strong>{st.plan.name}</strong>{ws.plan_interval ? ` (${ws.plan_interval})` : ''} · status {ws.plan_status}{ws.plan_grace_until ? ` · grace until ${fmtDate(ws.plan_grace_until)}` : ''}{ws.plan_period_end ? ` · period ends ${fmtDate(ws.plan_period_end)}` : ''}{ws.plan_pending_id ? ` · pending → ${ws.plan_pending_id}` : ''}<br />
          Limits in force: {st.effective.name} · {num(st.usage.subscribers)} / {st.effective.max_subscribers ? num(st.effective.max_subscribers) : '∞'} subscribers · {num(st.usage.emails_month)} / {st.effective.monthly_emails ? num(st.effective.monthly_emails) : '∞'} emails this month{st.usage.in_flight ? ` (+${num(st.usage.in_flight)} in flight)` : ''}</p>
        <p>Last {LIMITS.ACCOUNT_WINDOW_DAYS} days: {num(acct.attempted)} sent · bounce {rate(acct.bounced, acct.attempted)} · complaints {rate(acct.complaints, acct.attempted, 3)}{ws.stripe_customer_id ? <><br />Stripe: {ws.stripe_customer_id} {ws.stripe_subscription_id}</> : null}</p>
      </Card>
      <Card title="Actions">
        <form method="post" action={`/app/admin/w/${ws.id}/plan`} class="row" style="gap:8px;flex-wrap:wrap">
          <Select name="plan_id" value={ws.plan_id} options={plans.map((p) => [p.id, p.name] as [string, string])} />
          <Select name="interval" value={ws.plan_interval || 'month'} options={[['month', 'Monthly'], ['year', 'Annual']]} />
          <Btn kind="secondary" small confirm="Change this workspace's plan now (no charge — it's comped until changed)?">Set plan</Btn>
        </form>
        <Help>Sets the plan immediately with no billing period (comped). A paying customer's Stripe subscription is not changed.</Help>
        {ws.sending_status === 'suspended'
          ? <form method="post" action={`/app/admin/w/${ws.id}/unsuspend`} class="stack"><Input name="note" placeholder="Note to the owner (optional)" /><Btn small>Unsuspend sending</Btn></form>
          : <form method="post" action={`/app/admin/w/${ws.id}/suspend`} class="stack"><Input name="note" placeholder="Reason (shown to the owner)" required /><Btn kind="danger" small confirm="Suspend sending for this workspace? In-flight campaigns pause.">Suspend sending</Btn></form>}
        <div class="row" style="gap:8px;margin-top:10px">
          {!ws.trusted_at ? <ActionForm action={`/app/admin/w/${ws.id}/trust`} label="Trust (skip first-campaign review)" /> : <ActionForm action={`/app/admin/w/${ws.id}/untrust`} label="Require review again" />}
        </div>
      </Card>
    </div>
    <Card title="Publications" pad={false}>
      <Table<any> rows={pubs} cols={[{ h: 'Name', r: (p) => <a href={`/s/${p.slug}`} target="_blank">{p.name}</a> }, { h: 'Slug', r: (p) => p.slug }, { h: 'Active subscribers', r: (p) => num(p.subs) }, { h: 'Status', r: (p) => <Status s={p.status} /> }]} />
    </Card>
    <Card title="Recent campaigns" pad={false}>
      <Table<any> rows={sends} empty="No campaigns yet." cols={sendCols(c)} />
    </Card>
    <Card title="Activity" pad={false}>
      <Table<any> rows={events} empty="Nothing yet." cols={[{ h: 'When', r: (e) => ago(e.created_at) }, { h: 'Event', r: (e) => <Status s={e.kind} /> }, { h: 'Detail', r: (e) => <span class="small">{e.detail}</span> }, { h: 'By', r: (e) => e.actor || <Muted>system</Muted> }]} />
    </Card>
  </>, [['/app/admin', 'Platform admin']]);
});

dash.post('/w/:id/plan', async (c) => {
  const f = await form(c.req);
  const plan = await getPlan(c.env, str(f.plan_id, 40));
  if (plan.id !== f.plan_id) return back(c, `/app/admin/w/${c.req.param('id')}`, 'Unknown plan', 'err');
  await setPlan(c.env, c.req.param('id'), plan.id, f.interval === 'year' ? 'year' : 'month', { periodEnd: null, actor: actor(c), note: 'set by operator' });
  await audit(c, 'platform.plan_set', c.req.param('id'), { plan: plan.id });
  return back(c, `/app/admin/w/${c.req.param('id')}`, `Plan set to ${plan.name}`);
});
dash.post('/w/:id/suspend', async (c) => {
  const f = await form(c.req);
  const ok = await suspendWorkspace(c.env, c.req.param('id'), str(f.note, 500) || 'Suspended by the platform team', actor(c));
  await audit(c, 'platform.suspend', c.req.param('id'), { note: str(f.note, 500) });
  return back(c, `/app/admin/w/${c.req.param('id')}`, ok ? 'Sending suspended' : 'Already suspended');
});
dash.post('/w/:id/unsuspend', async (c) => {
  const f = await form(c.req);
  const ok = await unsuspendWorkspace(c.env, c.req.param('id'), actor(c), str(f.note, 500));
  await audit(c, 'platform.unsuspend', c.req.param('id'));
  return back(c, `/app/admin/w/${c.req.param('id')}`, ok ? 'Sending restored' : 'Not suspended');
});
dash.post('/w/:id/trust', async (c) => {
  await run(c.env, 'UPDATE workspaces SET trusted_at = ? WHERE id = ?', now(), c.req.param('id'));
  return back(c, `/app/admin/w/${c.req.param('id')}`, 'Workspace trusted');
});
dash.post('/w/:id/untrust', async (c) => {
  await run(c.env, 'UPDATE workspaces SET trusted_at = NULL WHERE id = ?', c.req.param('id'));
  return back(c, `/app/admin/w/${c.req.param('id')}`, 'First large campaign will need review again');
});

// ───────── campaign review ─────────
function sendCols(c: Ctx) {
  return [
    { h: 'Campaign', r: (s: any) => <><strong>{s.subject}</strong><div class="small muted">{s.pub_name}{s.ws_name ? <> · <a href={`/app/admin/w/${s.workspace_id}`}>{s.ws_name}</a></> : null}</div></> },
    { h: 'Recipients', r: (s: any) => <>{num(s.sent)} / {num(s.total)}</> },
    { h: 'Status', r: (s: any) => <><Status s={s.status} />{s.status_reason ? <div class="small muted" style="max-width:360px">{s.status_reason}</div> : null}</> },
    { h: 'Created', r: (s: any) => ago(s.created_at) },
    { h: '', r: (s: any) => (
      <div class="row" style="gap:6px;flex-wrap:wrap">
        {s.status === 'pending_approval' && <ActionForm action={`/app/admin/sends/${s.id}/approve`} label="Approve" kind="primary" />}
        {s.status === 'paused' && <ActionForm action={`/app/admin/sends/${s.id}/resume`} label="Resume" confirm="Resume sending this campaign?" />}
        {['pending_approval', 'paused'].includes(s.status) && (
          <form method="post" action={`/app/admin/sends/${s.id}/reject`} class="inline-form row" style="gap:4px"><input class="input input-sm" name="reason" placeholder="Reason (optional)" style="width:160px" /><Btn kind="danger" small>Reject</Btn></form>
        )}
      </div>
    ) },
  ];
}

dash.get('/sends', async (c) => {
  const q = `SELECT s.*, p.name AS pub_name, w.name AS ws_name, w.id AS workspace_id FROM sends s JOIN publications p ON p.id = s.pub_id JOIN workspaces w ON w.id = p.workspace_id`;
  const [held, paused, recent] = await Promise.all([
    all<any>(c.env, `${q} WHERE s.status = 'pending_approval' ORDER BY s.created_at LIMIT 100`),
    all<any>(c.env, `${q} WHERE s.status = 'paused' ORDER BY s.created_at DESC LIMIT 100`),
    all<any>(c.env, `${q} WHERE s.reviewed_at IS NOT NULL ORDER BY s.reviewed_at DESC LIMIT 25`),
  ]);
  return page(c, '/app/admin/sends', 'Campaign review', <>
    <Help>First campaigns above {num(LIMITS.APPROVAL_RECIPIENTS)} recipients from new workspaces wait here. Campaigns pause themselves when hard bounces exceed {(LIMITS.CAMPAIGN_MAX_HARD_BOUNCE_RATE * 100).toFixed(0)}% or complaints exceed {(LIMITS.CAMPAIGN_MAX_COMPLAINT_RATE * 100).toFixed(2)}% (after {LIMITS.CAMPAIGN_MIN_DELIVERIES} deliveries).</Help>
    <Card title={`Waiting for approval (${held.length})`} pad={false}><Table<any> rows={held} empty="Nothing waiting." cols={sendCols(c)} /></Card>
    <Card title={`Paused by safety checks (${paused.length})`} pad={false}><Table<any> rows={paused} empty="No paused campaigns." cols={sendCols(c)} /></Card>
    <Card title="Recently reviewed" pad={false}><Table<any> rows={recent} empty="None yet." cols={sendCols(c)} /></Card>
  </>);
});

dash.post('/sends/:id/approve', async (c) => {
  const ok = await approveSend(c.env, c.req.param('id'), actor(c));
  if (ok) { const { kick } = await import('../lib/jobs'); kick(c.env, c.executionCtx); }
  await audit(c, 'platform.send_approved', c.req.param('id'));
  return back(c, '/app/admin/sends', ok ? 'Approved — sending now' : 'Nothing to approve');
});
dash.post('/sends/:id/reject', async (c) => {
  const f = await form(c.req);
  const ok = await rejectSend(c.env, c.req.param('id'), actor(c), str(f.reason, 500));
  await audit(c, 'platform.send_rejected', c.req.param('id'));
  return back(c, '/app/admin/sends', ok ? 'Rejected — the owner was notified' : 'Nothing to reject');
});
dash.post('/sends/:id/resume', async (c) => {
  const ok = await resumeSend(c.env, c.req.param('id'), actor(c));
  if (ok) { const { kick } = await import('../lib/jobs'); kick(c.env, c.executionCtx); }
  await audit(c, 'platform.send_resumed', c.req.param('id'));
  return back(c, '/app/admin/sends', ok ? 'Resumed' : 'Not paused');
});

// ───────── plan catalog ─────────
dash.get('/plans', async (c) => {
  const plans = await listPlans(c.env, { includeInactive: true });
  return page(c, '/app/admin/plans', 'Plans', <>
    <Help>The hosted service's own plans (not creators' paid tiers). Every plan includes every feature; only limits differ. Prices in USD cents. Leave limits empty for unlimited. Stripe prices are created automatically on first checkout unless you paste existing price ids. Changes apply within a minute; the marketing pricing page reads these via <code>listPlans(env)</code>.</Help>
    {plans.map((p) => (
      <Card title={<>{p.name} <Muted>({p.id})</Muted> {!p.active && <Badge>inactive</Badge>}</>}>
        <form method="post" action={`/app/admin/plans/${p.id}`}>
          <div class="grid g4">
            <Field label="Name"><Input name="name" value={p.name} required /></Field>
            <Field label="Monthly (cents)"><Input name="monthly_cents" type="number" min={0} value={p.monthly_cents} /></Field>
            <Field label="Annual (cents)"><Input name="annual_cents" type="number" min={0} value={p.annual_cents} /></Field>
            <Field label="Position"><Input name="position" type="number" value={p.position} /></Field>
            <Field label="Max subscribers"><Input name="max_subscribers" type="number" min={0} value={p.max_subscribers ?? ''} /></Field>
            <Field label="Emails / month"><Input name="monthly_emails" type="number" min={0} value={p.monthly_emails ?? ''} /></Field>
            <Field label="Stripe price (monthly)"><Input name="stripe_price_monthly" value={p.stripe_price_monthly} /></Field>
            <Field label="Stripe price (annual)"><Input name="stripe_price_annual" value={p.stripe_price_annual} /></Field>
          </div>
          <Field label="Description"><Input name="description" value={p.description} /></Field>
          <div class="row" style="gap:16px">
            <label><input type="checkbox" name="branding" checked={p.branding} /> "Sent with Lnkbase Newsletter" branding</label>
            <label><input type="checkbox" name="active" checked={p.active} disabled={p.id === FREE_PLAN_ID} /> Offered</label>
            <Btn small>Save</Btn>
          </div>
        </form>
      </Card>
    ))}
  </>);
});

dash.post('/plans/:id', async (c) => {
  const f = await form(c.req);
  const pid = c.req.param('id');
  const lim = (v: unknown) => (String(v ?? '').trim() === '' ? null : Math.max(0, int(v)));
  const oldPrices = await one<any>(c.env, 'SELECT monthly_cents, annual_cents FROM platform_plans WHERE id = ?', pid);
  if (!oldPrices) return back(c, '/app/admin/plans', 'Unknown plan', 'err');
  const monthly = Math.max(0, int(f.monthly_cents)), annual = Math.max(0, int(f.annual_cents));
  // a price change needs new Stripe prices (old ones are immutable) unless explicit ids were pasted
  const priceChanged = monthly !== oldPrices.monthly_cents || annual !== oldPrices.annual_cents;
  await run(c.env, `UPDATE platform_plans SET name = ?, description = ?, monthly_cents = ?, annual_cents = ?, max_subscribers = ?, monthly_emails = ?, branding = ?, active = ?, position = ?, stripe_price_monthly = ?, stripe_price_annual = ?, updated_at = ? WHERE id = ?`,
    str(f.name, 60) || pid, str(f.description, 300), monthly, annual, lim(f.max_subscribers), lim(f.monthly_emails), f.branding ? 1 : 0, pid === FREE_PLAN_ID || f.active ? 1 : 0, int(f.position),
    priceChanged && !str(f.stripe_price_monthly) ? null : str(f.stripe_price_monthly, 100) || null, priceChanged && !str(f.stripe_price_annual) ? null : str(f.stripe_price_annual, 100) || null, now(), pid);
  clearPlanCache();
  await audit(c, 'platform.plan_edited', pid);
  return back(c, '/app/admin/plans', 'Plan saved');
});

dash.get('/events', async (c) => {
  const events = await all<any>(c.env, `SELECT e.*, w.name AS ws_name FROM platform_events e LEFT JOIN workspaces w ON w.id = e.workspace_id ORDER BY e.created_at DESC LIMIT 200`);
  return page(c, '/app/admin/events', 'Platform activity', (
    <Card pad={false}>
      <Table<any> rows={events} empty="Nothing yet." cols={[
        { h: 'When', r: (e) => ago(e.created_at) },
        { h: 'Workspace', r: (e) => e.workspace_id ? <a href={`/app/admin/w/${e.workspace_id}`}>{e.ws_name || e.workspace_id}</a> : '—' },
        { h: 'Event', r: (e) => <Status s={e.kind} /> },
        { h: 'Detail', r: (e) => <span class="small">{e.detail}</span> },
        { h: 'By', r: (e) => e.actor || <Muted>system</Muted> },
      ]} />
    </Card>
  ));
});

// ───────── simulated plan checkout (no STRIPE_SECRET_KEY) ─────────
async function checkoutFor(c: Ctx) {
  const co = await one<any>(c.env, 'SELECT * FROM platform_checkouts WHERE id = ?', c.req.param('id'));
  if (!co) return null;
  const user = await currentUser(c);
  if (!user) return { co, user: null, allowed: false };
  const m = await one(c.env, `SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ? AND role IN ('owner','admin')`, co.workspace_id, user.id);
  return { co, user, allowed: !!m || isSuperadmin(c.env, user) };
}

root.get('/checkout/plan/:id', async (c) => {
  const r = await checkoutFor(c);
  if (!r) return c.notFound();
  if (!r.user) return c.redirect('/login?next=' + encodeURIComponent(`/checkout/plan/${r.co.id}`));
  if (!r.allowed) return c.text('Forbidden', 403);
  const plan = await getPlan(c.env, r.co.plan_id);
  const ws = await one<any>(c.env, 'SELECT name FROM workspaces WHERE id = ?', r.co.workspace_id);
  return c.html(
    <PlainLayout title="Test checkout">
      <div class="flash flash-err">Test mode — no real payment is taken. Add STRIPE_SECRET_KEY to bill plans through Stripe.</div>
      <h1>Lnkbase Newsletter — {plan.name}</h1>
      <p class="muted">{ws?.name}</p>
      <p class="stat-v">{money(r.co.amount_cents)} / {r.co.interval}</p>
      <p class="muted">{plan.max_subscribers ? `Up to ${num(plan.max_subscribers)} subscribers` : 'Unlimited subscribers'} · {plan.monthly_emails ? `${num(plan.monthly_emails)} emails / month` : 'unlimited emails'}</p>
      {r.co.status === 'paid' ? <p>Already paid. <a href="/app/settings/plan">Back to your plan</a></p> : (
        <form method="post" class="stack">
          <label class="field"><span class="field-l">Card number (test)</span><input class="input" value="4242 4242 4242 4242" readonly /></label>
          <button class="btn btn-primary" id="pay">Pay {money(r.co.amount_cents)}</button>
          <a href="/app/settings/plan" class="btn btn-ghost">Cancel</a>
        </form>
      )}
    </PlainLayout>,
  );
});

root.post('/checkout/plan/:id', async (c) => {
  const r = await checkoutFor(c);
  if (!r) return c.notFound();
  if (!r.allowed) return c.text('Forbidden', 403);
  if (c.env.STRIPE_SECRET_KEY) return c.text('Test checkout is disabled when Stripe is configured', 400);
  const ok = await completeCheckout(c.env, r.co.id);
  const plan = await getPlan(c.env, r.co.plan_id);
  flash(c, ok ? `Payment received — you're on ${plan.name}.` : 'This checkout was already completed.');
  return c.redirect('/app/settings/plan', 303);
});

export default { dash, root } satisfies Module;
