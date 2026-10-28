/** @jsxImportSource hono/jsx */
// Analytics → Deliverability → Guardian (/app/analytics/guardian): health score, incidents timeline, active throttles,
// recommendations; delivery metrics per provider / per send / over time; DMARC authentication; inbox placement seed
// tests. Public: /seed/:token/:placement (one-click placement links inside seed emails). Logic lives in lib/guardian,
// lib/deliverymetrics and lib/dmarc.
import type { Hono } from 'hono';
import { raw } from 'hono/html';
import type { AppEnv, App, Ctx } from '../../types';
import { all, one } from '../../lib/db';
import { requirePerm } from '../../lib/auth';
import { DashLayout } from '../../ui/layout';
import { Card, Grid, Stats, Stat, Table, Badge, Tabs, LineChart, Help, Btn, Field, Textarea, Select, LinkBtn, ActionForm, back } from '../../ui/components';
import { DASH_STYLE } from './parts';
import { healthScore, recommendations, incidentsFor, activeThrottles, addSeeds, runSeedTest, markSeed, placementSummary, SEED_MAX, type Incident } from '../../lib/guardian';
import { deliveryMetrics, metricsByProvider, metricsSeries, sendMetrics, fmtDuration, PROVIDER_NAME, PRICE, ATTRIBUTION_DAYS, type Metrics } from '../../lib/deliverymetrics';
import { authSummary, pubSendingDomains, ruaAddress } from '../../lib/dmarc';
import { ago, fmtDateTime, form, str, now, DAY, money, esc, mailboxProvider } from '../../lib/util';

const TABS: Array<[string, string]> = [
  ['/app/analytics/guardian', 'Overview'], ['/app/analytics/guardian?tab=metrics', 'Delivery metrics'],
  ['/app/analytics/guardian?tab=auth', 'Authentication'], ['/app/analytics/guardian?tab=placement', 'Inbox placement'],
];
const P = (x: number | null | undefined, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const usd = (x: number | null | undefined, d = 5) => (x == null ? '—' : `$${x.toFixed(d)}`);
const SEV_TONE: Record<string, 'red' | 'amber' | 'blue'> = { critical: 'red', warning: 'amber', info: 'blue' };

function Page(p: { c: Ctx; tab: string; children?: any }) {
  return p.c.html(
    <DashLayout c={p.c} title="Deliverability Guardian" section="analytics" sub="deliverability" head={<style>{raw(DASH_STYLE)}</style>}
      crumbs={[['/app/analytics/deliverability', 'Deliverability']]}>
      <Tabs items={TABS} active={p.tab} />
      {p.children}
    </DashLayout>,
  );
}

export function IncidentList(p: { rows: Incident[]; empty?: string }) {
  if (!p.rows.length) return <div class="table-empty">{p.empty || 'No incidents. The Guardian checks every 10 minutes.'}</div>;
  return (
    <div class="g-timeline">
      {p.rows.map((i) => (
        <div class="g-inc" data-incident={i.kind} data-status={i.status}>
          <div class="row" style="gap:8px;flex-wrap:wrap">
            <Badge tone={i.status === 'open' ? SEV_TONE[i.severity] || 'gray' : 'green'}>{i.status === 'open' ? i.severity : 'resolved'}</Badge>
            <strong>{i.title}</strong>
            <span class="muted small">{i.scope.startsWith('provider:') ? 'All senders · ' : ''}opened {ago(i.opened_at)}{i.resolved_at ? ` · resolved ${ago(i.resolved_at)}` : ''}</span>
          </div>
          <p style="margin:6px 0">{i.diagnosis}</p>
          {i.action && <p class="small" style="margin:4px 0"><strong>Guardian action:</strong> {i.action}</p>}
          <p class="small muted" style="margin:4px 0"><strong>Recommended:</strong> {i.recommendation}</p>
        </div>
      ))}
    </div>
  );
}

const STYLE = `.g-timeline{display:flex;flex-direction:column}.g-inc{padding:14px 16px;border-bottom:1px solid var(--line,#e7e5e4)}.g-inc:last-child{border-bottom:0}
.g-score{display:flex;align-items:center;gap:20px;flex-wrap:wrap}.g-ring{width:112px;height:112px;border-radius:50%;display:grid;place-items:center;font-size:34px;font-weight:800}
.g-ring.green{background:conic-gradient(#16a34a var(--p),#e7e5e4 0)}.g-ring.amber{background:conic-gradient(#d97706 var(--p),#e7e5e4 0)}.g-ring.red{background:conic-gradient(#dc2626 var(--p),#e7e5e4 0)}
.g-ring span{width:88px;height:88px;border-radius:50%;background:var(--bg,#fff);display:grid;place-items:center}
.g-bar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:#e7e5e4;min-width:120px}.g-bar i{display:block}`;

function MetricStats(p: { m: Metrics; showAuth?: boolean }) {
  const m = p.m;
  return (
    <Stats>
      <Stat label="Accepted" value={P(m.acceptedRate, 2)} sub={`${m.accepted.toLocaleString('en-US')} of ${m.attempted.toLocaleString('en-US')} attempted`} tone={m.attempted && (m.acceptedRate || 0) < 0.97 ? 'down' : ''} />
      <Stat label="Hard bounces" value={P(m.hardRate, 2)} sub="keep under 2%" tone={(m.hardRate || 0) > 0.02 ? 'down' : ''} />
      <Stat label="Complaints" value={P(m.complaintRate, 3)} sub="of accepted · keep under 0.1%" tone={(m.complaintRate || 0) > 0.001 ? 'down' : ''} />
      <Stat label="Deferred at least once" value={P(m.deferralRate, 1)} sub="retried for up to 26h" />
      <Stat label="Time to delivery" value={fmtDuration(m.ttdMedianMs)} sub={`median · p95 ${fmtDuration(m.ttdP95Ms)}`} />
      {p.showAuth !== false && <Stat label="DMARC pass" value={P(m.authPassRate, 1)} sub={m.authMessages ? `${m.authMessages.toLocaleString('en-US')} messages in reports` : 'no DMARC reports yet'} />}
    </Stats>
  );
}

export function registerGuardian(dash: App, root: Hono<AppEnv>) {
  dash.use('/analytics/guardian', requirePerm('manage'));
  dash.use('/analytics/guardian/*', requirePerm('manage'));

  dash.get('/analytics/guardian', async (c) => {
    const pub = c.get('pub');
    const tab = c.req.query('tab') || '';
    if (tab === 'metrics') return metricsTab(c);
    if (tab === 'auth') return authTab(c);
    if (tab === 'placement') return placementTab(c);
    const hosts = await pubSendingDomains(c.env, pub.id);
    const [{ health, m }, incidents, throttles] = await Promise.all([
      healthScore(c.env, pub),
      incidentsFor(c.env, pub.workspace_id, hosts),
      activeThrottles(c.env),
    ]);
    const mine = throttles.filter((t) => t.scope === `workspace:${pub.workspace_id}` || t.scope.startsWith('provider:') || t.scope === 'global');
    const recs = await recommendations(c.env, pub, m);
    return Page({ c, tab: '/app/analytics/guardian', children: <>
      <style>{raw(STYLE)}</style>
      <Grid cols={2}>
        <Card title="Deliverability health">
          <div class="g-score" data-health={health.score}>
            <div class={`g-ring ${health.tone}`} style={`--p:${health.score}%`}><span>{health.score}</span></div>
            <div>
              <div style="font-size:20px;font-weight:700">{health.grade}</div>
              <p class="muted small" style="margin:4px 0">Last 7 days: {m.attempted.toLocaleString('en-US')} emails attempted, {P(m.acceptedRate, 1)} accepted.</p>
              {health.factors.length ? <ul class="small" style="margin:6px 0 0;padding-left:18px">{health.factors.map((f) => <li>{f.label} <span class="muted">−{f.penalty}</span></li>)}</ul> : <p class="small" style="margin:6px 0 0">Nothing is pulling the score down.</p>}
            </div>
          </div>
        </Card>
        <Card title="What the Guardian is doing">
          <p class="small muted" style="margin-top:0">Every 10 minutes it watches bounce, complaint and deferral rates per mailbox provider and for your account, volume spikes, blocklists and DMARC reports. When something goes wrong it slows or briefly pauses sending (always with an expiry), tells you why, and lifts it once things recover. It never changes your content or routes around filters.</p>
          {mine.length ? (
            <Table rows={mine} cols={[
              { h: 'Applies to', r: (t) => t.scope === 'global' ? 'All sending' : t.scope.startsWith('provider:') ? `Mail to ${PROVIDER_NAME[t.scope.slice(9)] || t.scope.slice(9)} (all senders)` : 'Your account' },
              { h: 'Speed', r: (t) => <Badge tone={t.factor <= 0 ? 'red' : 'amber'}>{t.factor <= 0 ? 'paused' : `${Math.round(t.factor * 100)}%`}</Badge> },
              { h: 'Why', r: (t) => <span class="small">{(t.reason || '').replace(/^guardian:\s*/, '').replace(/^operator [^:]+:\s*/, 'Operator: ')}</span> },
              { h: 'Until', r: (t) => (t.until ? fmtDateTime(t.until) : 'until lifted') },
            ]} />
          ) : <p class="small" data-throttles="none"><Badge tone="green">Full speed</Badge> No slowdowns in place.</p>}
        </Card>
      </Grid>
      <Card title="Recommendations">
        <ul style="margin:0;padding-left:18px">{recs.map((r) => <li style="margin:4px 0">{r.text}{r.href && <> <a href={r.href}>Open →</a></>}</li>)}</ul>
      </Card>
      <Card title="Incidents" pad={false}><IncidentList rows={incidents} /></Card>
    </> });
  });

  async function metricsTab(c: Ctx) {
    const pub = c.get('pub');
    const days = [7, 30, 90].includes(Number(c.req.query('days'))) ? Number(c.req.query('days')) : 30;
    const from = now() - days * DAY;
    const [m, prov, series, sends] = await Promise.all([
      deliveryMetrics(c.env, { pubId: pub.id }, from),
      metricsByProvider(c.env, { pubId: pub.id }, from),
      metricsSeries(c.env, { pubId: pub.id }, from),
      sendMetrics(c.env, pub.id, 15),
    ]);
    const r = (a: number, b: number) => (b ? (a / b) * 100 : 0);
    return Page({ c, tab: '/app/analytics/guardian?tab=metrics', children: <>
      <form method="get" class="row" style="margin-bottom:12px"><input type="hidden" name="tab" value="metrics" /><Select name="days" value={String(days)} autosubmit options={[['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']]} /></form>
      <MetricStats m={m} />
      <Stats>
        <Stat label="Sending cost" value={usd(m.costUsd, 2)} sub={`${m.billable.toLocaleString('en-US')} billable sends`} />
        <Stat label="Cost per accepted email" value={usd(m.costPerAcceptedUsd)} sub="Cloudflare Email Sending" />
        <Stat label="Revenue per 1,000 emails" value={m.revenuePer1kCents == null ? '—' : money(Math.round(m.revenuePer1kCents))} sub={`simple ${ATTRIBUTION_DAYS}-day attribution`} />
      </Stats>
      <Card title="Over time">
        <LineChart labels={series.map((s) => s.day.slice(5))} fmt={(n) => `${n.toFixed(1)}%`} series={[
          { label: 'Accepted %', values: series.map((s) => r(s.accepted, s.attempted)) },
          { label: 'Deferred %', values: series.map((s) => r(s.deferred, s.attempted)) },
          { label: 'Hard bounce %', values: series.map((s) => r(s.hard, s.attempted)) },
        ]} />
      </Card>
      <Card title="By mailbox provider" pad={false}>
        <Table rows={prov} empty="No email sent in this period." cols={[
          { h: 'Provider', r: (x) => <strong data-provider={x.provider}>{PROVIDER_NAME[x.provider] || x.provider}</strong> },
          { h: 'Attempted', r: (x) => x.attempted.toLocaleString('en-US'), class: 'right' },
          { h: 'Accepted', r: (x) => P(x.acceptedRate, 2), class: 'right' },
          { h: 'Hard bounce', r: (x) => P(x.hardRate, 2), class: 'right' },
          { h: 'Complaints', r: (x) => P(x.complaintRate, 3), class: 'right' },
          { h: 'Deferred', r: (x) => P(x.deferralRate, 1), class: 'right' },
          { h: 'Median time to delivery', r: (x) => fmtDuration(x.ttdMedianMs), class: 'right' },
        ]} />
      </Card>
      <Card title="By send (latest 15)" pad={false}>
        <Table rows={sends} empty="No sends yet." cols={[
          { h: 'Send', r: (s) => <><strong>{s.subject}</strong><div class="small muted">{s.kind === 'automation' ? 'Automation email' : 'Newsletter'} · {ago(s.created_at)}</div></> },
          { h: 'Attempted', r: (s) => s.m.attempted.toLocaleString('en-US'), class: 'right' },
          { h: 'Accepted', r: (s) => P(s.m.acceptedRate, 2), class: 'right' },
          { h: 'Hard bounce', r: (s) => P(s.m.hardRate, 2), class: 'right' },
          { h: 'Complaints', r: (s) => P(s.m.complaintRate, 3), class: 'right' },
          { h: 'Deferred', r: (s) => P(s.m.deferralRate, 1), class: 'right' },
          { h: 'Time to delivery', r: (s) => <span title={`p95 ${fmtDuration(s.m.ttdP95Ms)}`}>{fmtDuration(s.m.ttdMedianMs)}</span>, class: 'right' },
          { h: 'Cost / accepted', r: (s) => usd(s.m.costPerAcceptedUsd), class: 'right' },
          { h: 'Rev / 1k', r: (s) => (s.m.revenuePer1kCents == null ? '—' : money(Math.round(s.m.revenuePer1kCents))), class: 'right' },
        ]} />
      </Card>
      <Help>
        <strong>How these are counted.</strong> Attempted = emails handed to the mail service (test sends and suppressed addresses left out). Accepted = the reader's provider took it. Hard bounce rate is out of attempted; complaint rate out of accepted. Deferred = needed at least one retry. Time to delivery runs from when the email was queued (or its planned time, for timed sends) to acceptance.
        Cost uses Cloudflare Email Sending's price: ${(PRICE.perMessageUsd * 1000).toFixed(2)} per 1,000 after the first {PRICE.freePerMonth.toLocaleString('en-US')} each month, which are shared by every newsletter on this service, so each month's cost is shared out in proportion. Retries count as sends. The Workers base plan is shared infrastructure and not included.
        Revenue per 1,000 is a simple estimate: paid orders from a reader within {ATTRIBUTION_DAYS} days after they received one of these emails, per 1,000 accepted. It is not full attribution — see Revenue analytics for that.
      </Help>
    </> });
  }

  async function authTab(c: Ctx) {
    const pub = c.get('pub');
    const doms = await all<any>(c.env, `SELECT id, hostname, status FROM domains WHERE pub_id = ? AND kind = 'email' ORDER BY hostname`, pub.id);
    const a = await authSummary(c.env, doms.map((d) => d.hostname), now() - 30 * DAY);
    return Page({ c, tab: '/app/analytics/guardian?tab=auth', children: <>
      {!doms.length && <div class="callout">You don't have a custom sending domain yet, so your email is authenticated by the shared domain and there are no reports of your own. <a href="/app/settings/domains">Add a sending domain</a>.</div>}
      <AuthCards a={a} />
      {doms.length > 0 && <Card title="Report address" pad={false}><Table rows={doms} cols={[
        { h: 'Domain', r: (d) => <strong>{d.hostname}</strong> },
        { h: 'Add to its DMARC record', r: (d) => <code class="small">rua=mailto:{ruaAddress(c.env, d.id)}</code> },
      ]} /></Card>}
    </> });
  }

  async function placementTab(c: Ctx) {
    const pub = c.get('pub');
    const [seeds, summary, tests, posts] = await Promise.all([
      all<any>(c.env, 'SELECT * FROM seed_addresses WHERE pub_id = ? ORDER BY created_at', pub.id),
      placementSummary(c.env, pub.id),
      all<any>(c.env, `SELECT t.*, (SELECT COUNT(*) FROM seed_results r WHERE r.test_id = t.id) AS n, (SELECT COUNT(*) FROM seed_results r WHERE r.test_id = t.id AND r.placement IS NOT NULL) AS marked,
          (SELECT COUNT(*) FROM seed_results r WHERE r.test_id = t.id AND r.placement = 'spam') AS spam FROM seed_tests t WHERE t.pub_id = ? ORDER BY t.created_at DESC LIMIT 10`, pub.id),
      all<any>(c.env, `SELECT id, title, status FROM posts WHERE pub_id = ? AND status IN ('draft','scheduled','published') ORDER BY updated_at DESC LIMIT 50`, pub.id),
    ]);
    return Page({ c, tab: '/app/analytics/guardian?tab=placement', children: <>
      <div class="callout"><strong>This is a sample, not a measurement of your whole list.</strong> A seed test sends a preview to inboxes you own and you tell us where each one landed. Placement depends on each reader's history with you, so treat it as an early warning — a seed in spam is worth acting on; a seed in the inbox doesn't guarantee everyone's is.</div>
      <Card title="Estimated placement by provider (last 90 days)" pad={false}>
        <Table rows={summary} empty="No seed results yet. Add seed inboxes and run a test." cols={[
          { h: 'Provider', r: (x) => <strong data-seed-provider={x.provider}>{PROVIDER_NAME[x.provider] || x.provider}</strong> },
          { h: 'Placement', r: (x) => { const t = x.inbox + x.promotions + x.spam; return t ? <div class="g-bar" title={`${x.inbox} inbox · ${x.promotions} promotions · ${x.spam} spam`}><i style={`width:${(x.inbox / t) * 100}%;background:#16a34a`} /><i style={`width:${(x.promotions / t) * 100}%;background:#d97706`} /><i style={`width:${(x.spam / t) * 100}%;background:#dc2626`} /></div> : <span class="muted">not marked yet</span>; } },
          { h: 'Inbox', r: (x) => x.inbox, class: 'right' }, { h: 'Promotions', r: (x) => x.promotions, class: 'right' }, { h: 'Spam', r: (x) => x.spam, class: 'right' },
          { h: 'Not marked', r: (x) => x.unmarked, class: 'right' },
          { h: 'Sample', r: (x) => <span class="small muted">{x.inbox + x.promotions + x.spam} seed{x.inbox + x.promotions + x.spam === 1 ? '' : 's'}</span> },
        ]} />
      </Card>
      <Grid cols={2}>
        <Card title={`Seed inboxes (${seeds.length}/${SEED_MAX})`}>
          {seeds.length ? <ul style="margin:0 0 12px;padding-left:18px">{seeds.map((s) => <li>{s.email} <span class="muted small">{PROVIDER_NAME[s.provider] || s.provider}</span> <ActionForm action={`/app/analytics/guardian/seeds/${s.id}/delete`} label="Remove" small kind="ghost" /></li>)}</ul> : <p class="muted small">Add inboxes you can check yourself — ideally one each at Gmail, Outlook.com and Yahoo, used like a normal reader would.</p>}
          <form method="post" action="/app/analytics/guardian/seeds" class="stack">
            <Field label="Add seed addresses" hint="One per line. Only addresses you own: each gets real email from you."><Textarea name="emails" rows={3} placeholder={'me.seed@gmail.com\nme.seed@outlook.com'} /></Field>
            <Btn small>Add</Btn>
          </form>
        </Card>
        <Card title="Run a seed test">
          <form method="post" action="/app/analytics/guardian/seed-test" class="stack">
            <Field label="Post to send" hint="Sent exactly as readers get it (subject, sender, content) with three links at the bottom: Inbox, Promotions, Spam. Click the one that matches where it landed — or reply with that word."><Select name="post_id" options={posts.map((p) => [p.id, `${p.title}${p.status !== 'published' ? ` (${p.status})` : ''}`] as [string, string])} /></Field>
            <Btn small disabled={!seeds.length || !posts.length}>Send to {seeds.length} seed{seeds.length === 1 ? '' : 's'}</Btn>
          </form>
        </Card>
      </Grid>
      <Card title="Recent tests" pad={false}>
        <Table rows={tests} empty="No tests yet." cols={[
          { h: 'Subject', r: (t) => <strong>{t.subject}</strong> }, { h: 'Sent', r: (t) => ago(t.created_at) },
          { h: 'Marked', r: (t) => `${t.marked} of ${t.n}` }, { h: 'In spam', r: (t) => (t.spam ? <Badge tone="red">{t.spam}</Badge> : <span class="muted">0</span>) },
        ]} />
      </Card>
    </> });
  }

  dash.post('/analytics/guardian/seeds', requirePerm('manage'), async (c) => {
    const f = await form(c.req);
    const emails = str(f.emails, 4000).split(/[\s,;]+/).filter(Boolean);
    const r = await addSeeds(c.env, c.get('pub').id, emails);
    return back(c, '/app/analytics/guardian?tab=placement', r.added ? `Added ${r.added} seed inbox${r.added === 1 ? '' : 'es'}${r.skipped.length ? ` · skipped ${r.skipped.length} (invalid, duplicate or over ${SEED_MAX})` : ''}` : 'No seed addresses added (invalid, duplicate or limit reached).', r.added ? 'ok' : 'err');
  });
  dash.post('/analytics/guardian/seeds/:id/delete', requirePerm('manage'), async (c) => {
    await c.env.DB.prepare('DELETE FROM seed_addresses WHERE id = ? AND pub_id = ?').bind(c.req.param('id'), c.get('pub').id).run();
    return back(c, '/app/analytics/guardian?tab=placement', 'Seed inbox removed');
  });
  dash.post('/analytics/guardian/seed-test', requirePerm('publish'), async (c) => {
    const pub = c.get('pub');
    const f = await form(c.req);
    const post = await one<any>(c.env, 'SELECT * FROM posts WHERE id = ? AND pub_id = ?', str(f.post_id, 64), pub.id);
    if (!post) return back(c, '/app/analytics/guardian?tab=placement', 'Choose a post.', 'err');
    const recent = await one<any>(c.env, 'SELECT created_at FROM seed_tests WHERE pub_id = ? ORDER BY created_at DESC LIMIT 1', pub.id);
    if (recent && now() - recent.created_at < 5 * 60_000) return back(c, '/app/analytics/guardian?tab=placement', 'One seed test every 5 minutes, please.', 'err');
    const r = await runSeedTest(c.env, pub, post, c.get('user').email);
    return back(c, '/app/analytics/guardian?tab=placement', r.sent ? `Sent to ${r.sent} seed inbox${r.sent === 1 ? '' : 'es'}${r.failed ? ` (${r.failed} failed)` : ''}. Open each one and click where it landed.` : 'Nothing was sent — add seed inboxes first.', r.sent ? 'ok' : 'err');
  });

  // ───────── public: one-click placement links ─────────
  // Link scanners (Outlook Safe Links, security gateways) fetch GET links, so GET only shows a page that submits a POST
  // by script (a button without script) — the placement is recorded by the POST.
  const seedPage = (body: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Placement test</title><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:520px;margin:64px auto;padding:0 16px;text-align:center;color:#1c1917">${body}</body>`;
  root.get('/seed/:tok/:placement', (c) => {
    const tok = c.req.param('tok').replace(/[^a-z0-9]/g, ''), pl = c.req.param('placement').replace(/[^a-z]/g, '');
    if (!['inbox', 'promotions', 'spam'].includes(pl)) return c.html(seedPage('<p>Unknown placement.</p>'), 404);
    return c.html(seedPage(`<form id="f" method="post" action="/seed/${esc(tok)}/${esc(pl)}"><p>Recording that this test email landed in <strong>${esc(pl)}</strong>…</p><noscript><button style="font-size:16px;padding:10px 18px">Confirm: ${esc(pl)}</button></noscript></form><script>document.getElementById('f').submit()</script>`));
  });
  root.post('/seed/:tok/:placement', async (c) => {
    const ok = await markSeed(c.env, c.req.param('tok'), c.req.param('placement'));
    return c.html(seedPage(ok ? `<h1 style="font-size:22px">Thanks — recorded as ${esc(c.req.param('placement'))}.</h1><p style="color:#78716c">You can close this tab. Results show in Analytics → Deliverability → Guardian → Inbox placement.</p>` : '<p>This test link has expired or is invalid.</p>'), ok ? 200 : 404);
  });
}

/** DMARC authentication cards — shared by the Guardian's Authentication tab and the Domains page. */
export function AuthCards(p: { a: Awaited<ReturnType<typeof authSummary>>; compact?: boolean }) {
  const a = p.a;
  return <>
    <Stats>
      <Stat label="DMARC pass (aligned)" value={P(a.passRate, 1)} sub={a.messages ? `${a.messages.toLocaleString('en-US')} messages in reports, last 30 days` : 'no report data yet'} tone={a.passRate != null && a.passRate < 0.9 ? 'down' : ''} />
      <Stat label="DKIM aligned" value={P(a.dkimRate, 1)} />
      <Stat label="SPF aligned" value={P(a.spfRate, 1)} />
      <Stat label="Reports received" value={String(a.reports)} sub={a.lastReportAt ? `last ${ago(a.lastReportAt)}` : 'none yet'} />
    </Stats>
    {!p.compact && a.byReporter.length > 0 && <Card title="By reporting mailbox provider" pad={false}><Table rows={a.byReporter} cols={[
      { h: 'Reporter', r: (x) => <strong>{x.reporter}</strong> }, { h: 'Messages', r: (x) => x.messages.toLocaleString('en-US'), class: 'right' }, { h: 'Pass', r: (x) => P(x.messages ? x.pass / x.messages : null, 1), class: 'right' },
    ]} /></Card>}
    <Card title="Failing sources (neither DKIM nor SPF aligned)" pad={false}>
      <Table rows={a.failing} empty={a.messages ? 'Every reported source passed. 🎉' : 'Reports usually start arriving within a day of publishing the rua address.'} cols={[
        { h: 'Source IP', r: (x) => <code data-failing-ip={x.source_ip}>{x.source_ip}</code> },
        { h: 'Reported by', r: (x) => x.reporter }, { h: 'From domain', r: (x) => x.header_from || x.domain },
        { h: 'Result', r: (x) => <span class="small">DKIM {x.dkim} · SPF {x.spf} · {x.disposition === 'none' ? 'delivered' : x.disposition}</span> },
        { h: 'Messages', r: (x) => x.messages.toLocaleString('en-US'), class: 'right' },
      ]} />
    </Card>
  </>;
}

export { mailboxProvider };
