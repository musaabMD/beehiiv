/** @jsxImportSource hono/jsx */
// Monitoring & alerting: error log viewer, background job health, and hourly alert emails to admins.
import type { Hono } from 'hono';
import type { AppEnv, Env } from '../../types';
import { all, one, run, val } from '../../lib/db';
import { requirePerm } from '../../lib/auth';
import { registerPeriodic } from '../../lib/jobs';
import { sendTransactional } from '../../lib/email';
import { appUrl } from '../../lib/pub';
import { ago, esc, now, HOUR, DAY } from '../../lib/util';
import { Card, Table, Stats, Stat, Status, Empty, ActionForm, back } from '../../ui/components';
import { page } from './ui';

export function registerMonitoring(dash: Hono<AppEnv>) {
  dash.get('/monitoring', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const t = now();
    const errors = await all<any>(c.env, `SELECT * FROM error_log WHERE pub_id = ? OR pub_id IS NULL ORDER BY created_at DESC LIMIT 100`, pub.id);
    const errs24 = await val<number>(c.env, `SELECT COUNT(*) FROM error_log WHERE (pub_id = ? OR pub_id IS NULL) AND created_at > ?`, pub.id, t - DAY);
    const pending = await val<number>(c.env, `SELECT COUNT(*) FROM jobs WHERE status = 'pending' AND run_at <= ?`, t);
    const failed = await all<any>(c.env, `SELECT id, kind, attempts, error, created_at FROM jobs WHERE status = 'failed' ORDER BY created_at DESC LIMIT 20`);
    const lastCron = await one<{ reset_at: number }>(c.env, `SELECT MAX(reset_at) AS reset_at FROM rate_limits WHERE key LIKE 'periodic:%'`);
    const deferred = await val<number>(c.env, `SELECT COUNT(*) FROM deliveries WHERE pub_id = ? AND status = 'deferred'`, pub.id);
    const whFailed = await val<number>(c.env, `SELECT COUNT(*) FROM webhook_deliveries WHERE pub_id = ? AND status = 'failed' AND created_at > ?`, pub.id, t - DAY);
    return page(c, 'monitoring', 'Monitoring', (
      <>
        <Stats>
          <Stat label="Errors (24h)" value={errs24} tone={errs24 ? 'down' : ''} />
          <Stat label="Jobs waiting" value={pending} sub={lastCron?.reset_at ? `cron active` : 'cron not seen yet'} />
          <Stat label="Failed jobs" value={failed.length} />
          <Stat label="Deferred emails (retrying)" value={deferred} />
          <Stat label="Failed webhooks (24h)" value={whFailed} />
        </Stats>
        <Card title="Error log" actions={errors.length ? <ActionForm action="/app/settings/monitoring/clear" label="Clear" confirm="Clear the error log?" /> : null} pad={false}>
          <Table rows={errors} empty={<Empty title="No errors" body="Errors from requests, jobs and integrations appear here. Admins get an email when new errors occur." icon="✓" />}
            cols={[
              { h: 'When', r: (e) => <span class="nowrap">{ago(e.created_at)}</span> },
              { h: 'Source', r: (e) => <code>{e.source}</code> },
              { h: 'Message', r: (e) => <details><summary>{e.message}</summary><pre class="code">{e.stack || ''}</pre></details> },
            ]} />
        </Card>
        <Card title="Failed background jobs" pad={false}>
          <Table rows={failed} empty="No failed jobs."
            cols={[
              { h: 'Job', r: (j) => <code>{j.kind}</code> },
              { h: 'Attempts', r: (j) => j.attempts },
              { h: 'Error', r: (j) => <span class="truncate">{j.error}</span> },
              { h: '', r: (j) => <ActionForm action={`/app/settings/monitoring/retry/${j.id}`} label="Retry" /> },
            ]} />
        </Card>
        <p class="help">Production logs and traces are also available in the Cloudflare dashboard (Workers → openhive → Observability).</p>
      </>
    ));
  });

  dash.post('/monitoring/clear', requirePerm('admin'), async (c) => {
    await run(c.env, 'DELETE FROM error_log WHERE pub_id = ? OR pub_id IS NULL', c.get('pub').id);
    return back(c, '/app/settings/monitoring', 'Error log cleared');
  });

  dash.post('/monitoring/retry/:id', requirePerm('admin'), async (c) => {
    await run(c.env, `UPDATE jobs SET status = 'pending', attempts = 0, run_at = ?, locked_until = NULL WHERE id = ? AND status = 'failed'`, now(), c.req.param('id'));
    return back(c, '/app/settings/monitoring', 'Job queued for retry');
  });
}

/** Hourly: email each publication's admins when new errors were logged (and about stuck queues). */
registerPeriodic('monitoring.alerts', HOUR, async (env: Env) => {
  const since = now() - HOUR;
  const rows = await all<{ pub_id: string | null; n: number; sample: string }>(env, `SELECT pub_id, COUNT(*) AS n, MAX(source || ': ' || message) AS sample FROM error_log WHERE created_at > ? GROUP BY pub_id`, since);
  const stuck = await val<number>(env, `SELECT COUNT(*) FROM jobs WHERE status = 'pending' AND run_at < ?`, now() - HOUR);
  for (const r of rows) {
    const pubs = r.pub_id ? await all<any>(env, 'SELECT * FROM publications WHERE id = ?', r.pub_id) : await all<any>(env, `SELECT * FROM publications WHERE status != 'deleted' LIMIT 1`);
    for (const pub of pubs) {
      const admins = await all<{ email: string }>(env, `SELECT DISTINCT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE (m.pub_id = ? OR (m.pub_id = '' AND m.workspace_id = ?)) AND m.role IN ('owner','admin')`, pub.id, pub.workspace_id);
      for (const a of admins) {
        await sendTransactional(env, a.email, `[${pub.name}] ${r.n} new error${r.n === 1 ? '' : 's'} in the last hour`,
          `<p>OpenHive logged <strong>${r.n}</strong> error${r.n === 1 ? '' : 's'} in the last hour.</p><p><code>${esc(r.sample).slice(0, 300)}</code></p>${stuck ? `<p>${stuck} background jobs are overdue — check that the cron trigger is running.</p>` : ''}<p><a href="${appUrl(env, '/app/settings/monitoring')}">Open monitoring</a></p>`, pub);
      }
    }
  }
});
