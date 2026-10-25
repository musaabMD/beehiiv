/** @jsxImportSource hono/jsx */
import type { Hono } from 'hono';
import type { AppEnv } from '../../types';
import { one, all, run, insert, val } from '../../lib/db';
import { requirePerm, audit } from '../../lib/auth';
import { recordsFor, checkDomain, warmupSchedule, blocklistStatus, appHost, type DnsCheck } from '../../lib/domains';
import { warmupAllowance } from '../../lib/sender';
import { id, now, token, form, str, ago, fmtDateTime, num, DAY } from '../../lib/util';
import { Card, Field, Input, Select, Btn, ActionForm, Table, Badge, Status, Modal, OpenBtn, Help, Empty, back } from '../../ui/components';
import { page } from './ui';

const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function registerDomains(dash: Hono<AppEnv>) {
  dash.get('/domains', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const domains = await all<any>(c.env, 'SELECT * FROM domains WHERE pub_id = ? ORDER BY kind DESC, created_at', pub.id);
    const blocks = [];
    for (const d of domains) {
      const recs = recordsFor(c.env, d);
      const report = JSON.parse(d.dns_report || '{}');
      const checks: DnsCheck[] = report.checks || [];
      let warm: any = null;
      if (d.kind === 'email' && d.warmup_started_at) {
        const day = Math.floor((now() - d.warmup_started_at) / DAY);
        const allowance = await warmupAllowance(c.env, `x@${d.hostname}`);
        const cap = day >= 12 ? null : 200 * 2 ** day;
        warm = { day: day + 1, cap, used: cap ? cap - (allowance.remaining === Infinity ? cap : allowance.remaining) : null };
      }
      blocks.push(
        <Card
          title={<span class="row"><Badge tone={d.kind === 'web' ? 'blue' : 'purple'}>{d.kind === 'web' ? 'Website' : 'Sending'}</Badge> <span class="mono">{d.hostname}</span> <Status s={d.status === 'failed' ? 'pending' : d.status} />{d.blocklisted ? <Badge tone="red">blocklisted — sending paused</Badge> : null}</span>}
          actions={<div class="row"><ActionForm action={`/app/settings/domains/${d.id}/check`} label="Check DNS" kind="primary" />{d.kind === 'email' && <ActionForm action={`/app/settings/domains/${d.id}/blocklists`} label="Check blocklists" />}<ActionForm action={`/app/settings/domains/${d.id}/delete`} label="Remove" kind="danger" confirm={`Remove ${d.hostname}?`} /></div>}
          pad={false}
        >
          <Table
            rows={recs}
            cols={[
              { h: 'Type', r: (r) => <code>{r.type}</code> },
              { h: 'Host / name', r: (r) => <code class="small">{r.host}</code> },
              { h: 'Value', r: (r) => <div><code class="small" style="word-break:break-all">{r.value}</code>{r.type !== 'MX' && !r.value.startsWith('Provided') && <div><button type="button" class="btn btn-ghost btn-sm" data-copy={r.value}>Copy</button></div>}</div> },
              { h: 'Purpose', r: (r) => <span class="muted small">{r.purpose}{!r.required && ' (recommended)'}</span> },
              { h: 'Status', r: (r) => { const ck = checks.find((x) => x.key === r.key); return ck ? <span title={(ck.found || []).join('\n') || 'no record'}>{ck.ok ? <Badge tone="green">found</Badge> : <Badge tone={r.required ? 'red' : 'amber'}>missing</Badge>}{ck.note && <div class="muted small">{ck.note}</div>}</span> : <span class="muted">not checked</span>; } },
            ]}
          />
          <div class="card-b">
            {report.checked_at && <p class="muted small">Last checked {ago(report.checked_at)}.</p>}
            {d.kind === 'web' ? (
              <Help>
                Point <code>{d.hostname}</code> at <code>{appHost(c.env)}</code>. If your OpenHive runs on Cloudflare, add the hostname as a <strong>Custom Hostname (Cloudflare for SaaS)</strong> on the app's zone, or add a Worker route <code>{d.hostname}/*</code> if the domain is in the same Cloudflare account. SSL is issued automatically. Once verified, your site is served at https://{d.hostname} and every link in your emails uses it.
              </Help>
            ) : (
              <>
                <Help>
                  On Cloudflare, enable sending with <code>npx wrangler email sending enable {d.hostname}</code> (or Dashboard → Email → Email Sending). Cloudflare adds the DKIM key and SPF for you when the zone is on Cloudflare. <strong>Alignment:</strong> DMARC passes only when the visible From domain matches the DKIM signing domain (adkim=s) and the SPF/Return-Path domain (aspf=s) — so send from an address <em>at</em> {d.hostname}.
                </Help>
                {warm && (
                  <div class="callout">
                    <strong>Warmup — day {warm.day}</strong>: {warm.cap ? <>today's cap {num(warm.cap)} emails, {num(Math.max(0, warm.used || 0))} used. Sends over the cap are queued for the next window.</> : 'complete, no daily cap.'}
                    <div class="row small" style="margin-top:8px;gap:6px">{warmupSchedule().map((w) => <Badge tone={w.day === warm.day ? 'amber' : w.day < warm.day ? 'green' : 'gray'}>D{w.day}: {w.cap ? num(w.cap) : '∞'}</Badge>)}</div>
                  </div>
                )}
                {report.blocklists && (
                  <p class="small">Blocklists ({ago(report.blocklists.checked_at)}): {report.blocklists.results.map((r: any) => <Badge tone={r.listed ? 'red' : 'green'}>{r.name}: {r.listed ? 'listed' : 'clean'}</Badge>)}</p>
                )}
              </>
            )}
          </div>
        </Card>,
      );
    }
    return page(c, 'domains', 'Domains', (
      <>
        <Help>Use your own domain for your website and send email from your own domain with SPF, DKIM and DMARC aligned — the biggest single boost to inbox placement.</Help>
        {domains.length ? blocks : <Card><Empty title="No custom domains yet" body={`Your site lives at ${c.env.APP_URL.replace(/\/$/, '')}/s/${pub.slug} and email is sent from ${c.env.MAIL_FROM}. Add your own domains to brand both.`} action={<OpenBtn target="#add-domain">Add domain</OpenBtn>} /></Card>}
        {domains.length > 0 && <div class="row end"><OpenBtn target="#add-domain">Add domain</OpenBtn></div>}
        <Modal id="add-domain" title="Add a domain">
          <form method="post" action="/app/settings/domains" class="stack">
            <Field label="Domain" hint="e.g. news.example.com (website) or example.com (sending)"><Input name="hostname" required placeholder="news.example.com" /></Field>
            <Field label="Use for"><Select name="kind" options={[['web', 'Website (custom domain)'], ['email', 'Sending email (From address)']]} value="web" /></Field>
            <div class="form-actions"><Btn>Add domain</Btn></div>
          </form>
        </Modal>
      </>
    ));
  });

  dash.post('/domains', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const f = await form(c.req);
    const host = str(f.hostname, 253).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
    const kind = f.kind === 'email' ? 'email' : 'web';
    if (!HOST_RE.test(host)) return back(c, '/app/settings/domains', 'Enter a valid domain like news.example.com', 'err');
    if (host === appHost(c.env)) return back(c, '/app/settings/domains', 'That is the app domain itself.', 'err');
    const exists = await one<any>(c.env, 'SELECT pub_id FROM domains WHERE hostname = ?', host);
    if (exists) return back(c, '/app/settings/domains', exists.pub_id === pub.id ? 'Already added.' : 'That domain is connected to another publication.', 'err');
    if (kind === 'web' && (await val<number>(c.env, `SELECT COUNT(*) FROM domains WHERE pub_id = ? AND kind = 'web'`, pub.id)) >= 1)
      return back(c, '/app/settings/domains', 'A publication can have one website domain. Remove the current one first (add old-domain redirects in Website → Redirects).', 'err');
    const did = id();
    await insert(c.env, 'domains', { id: did, pub_id: pub.id, hostname: host, kind, status: 'pending', verify_token: token(16), created_at: now() });
    await audit(c, 'domains.added', host, { kind });
    return back(c, '/app/settings/domains', `${host} added — now add the DNS records below and click "Check DNS".`);
  });

  dash.post('/domains/:id/check', requirePerm('admin'), async (c) => {
    const d = await one<any>(c.env, 'SELECT * FROM domains WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
    if (!d) return back(c, '/app/settings/domains', 'Not found', 'err');
    const r = await checkDomain(c.env, d);
    if (r.verified) await audit(c, 'domains.verified', d.hostname);
    const missing = r.checks.filter((x) => !x.ok).map((x) => x.key.toUpperCase());
    return back(c, '/app/settings/domains', r.verified ? `${d.hostname} verified ✓${missing.length ? ` — still missing: ${missing.join(', ')}` : ''}` : `Not verified yet — the TXT record _openhive.${d.hostname} wasn't found. DNS changes can take a few minutes.`, r.verified ? 'ok' : 'err');
  });

  dash.post('/domains/:id/blocklists', requirePerm('admin'), async (c) => {
    const d = await one<any>(c.env, `SELECT * FROM domains WHERE id = ? AND pub_id = ? AND kind = 'email'`, c.req.param('id'), c.get('pub').id);
    if (!d) return back(c, '/app/settings/domains', 'Not found', 'err');
    const results = await blocklistStatus(d.hostname);
    const listed = results.filter((r) => r.listed);
    const report = { ...JSON.parse(d.dns_report || '{}'), blocklists: { checked_at: now(), results } };
    await run(c.env, 'UPDATE domains SET blocklisted = ?, dns_report = ? WHERE id = ?', listed.length ? 1 : 0, JSON.stringify(report), d.id);
    return back(c, '/app/settings/domains', listed.length ? `Listed on ${listed.map((l) => l.name).join(', ')} — sending paused` : 'Clean on all blocklists ✓', listed.length ? 'err' : 'ok');
  });

  dash.post('/domains/:id/delete', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const d = await one<any>(c.env, 'SELECT * FROM domains WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!d) return back(c, '/app/settings/domains', 'Not found', 'err');
    await run(c.env, 'DELETE FROM domains WHERE id = ?', d.id);
    if (d.kind === 'web') await run(c.env, 'UPDATE publications SET custom_domain = NULL WHERE id = ? AND custom_domain = ?', pub.id, d.hostname);
    await audit(c, 'domains.removed', d.hostname);
    return back(c, '/app/settings/domains', `${d.hostname} removed`);
  });
}

export { fmtDateTime };
