/** @jsxImportSource hono/jsx */
import type { Hono } from 'hono';
import type { AppEnv, Ctx } from '../../types';
import { one, all, run, insert, val } from '../../lib/db';
import { requirePerm, audit } from '../../lib/auth';
import { settings, senderFor } from '../../lib/pub';
import { validateEmail } from '../../lib/guard';
import { suppress, unsuppress, sendTransactional } from '../../lib/email';
import { hookKey } from '../core';
import { id, now, form, str, ago, fmtDateTime, domainOf, pct, num, DAY } from '../../lib/util';
import { Card, Field, Input, Select, Btn, ActionForm, Table, Badge, Status, Modal, OpenBtn, Grid, Help, Copy, Stats, Stat, back } from '../../ui/components';
import { page } from './ui';

const PURPOSES: Array<[string, string]> = [['newsletter', 'Newsletters'], ['automations', 'Automations'], ['transactional', 'Transactional (receipts, logins)'], ['community', 'Community notifications']];

/** Domains a publication may send from: verified email domains + the platform MAIL_FROM domain. */
export async function sendableDomains(c: Ctx): Promise<string[]> {
  const rows = await all<{ hostname: string }>(c.env, `SELECT hostname FROM domains WHERE pub_id = ? AND kind = 'email' AND status = 'verified'`, c.get('pub').id);
  return [...new Set([domainOf(c.env.MAIL_FROM), ...rows.map((r) => r.hostname)])];
}

export async function deliverabilityStats(c: Ctx) {
  const pub = c.get('pub');
  const since = now() - 30 * DAY;
  const d = await one<any>(c.env, `SELECT COUNT(*) AS total, SUM(status IN ('sent','deferred')) AS delivered, SUM(status = 'bounced') AS bounced, SUM(status = 'complained' OR bounce_type = 'complaint') AS complained, SUM(status = 'deferred') AS deferred, SUM(opened_at IS NOT NULL) AS opened FROM deliveries WHERE pub_id = ? AND created_at > ?`, pub.id, since);
  const supp = await one<any>(c.env, `SELECT SUM(scope = 'pub') AS pub, (SELECT COUNT(*) FROM suppressions s2 JOIN subscribers sb ON sb.email = s2.email AND sb.pub_id = ? WHERE s2.scope = 'global' AND (s2.expires_at IS NULL OR s2.expires_at > ?)) AS global FROM suppressions WHERE pub_id = ? AND (expires_at IS NULL OR expires_at > ?)`, pub.id, now(), pub.id, now());
  const doms = await all<any>(c.env, `SELECT hostname, status, dns_report, blocklisted FROM domains WHERE pub_id = ? AND kind = 'email'`, pub.id);
  return { d: d || {}, supp: supp || {}, doms };
}

export function registerEmail(dash: Hono<AppEnv>) {
  dash.get('/email', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const s = settings(pub);
    const senders = await all<any>(c.env, 'SELECT * FROM sender_addresses WHERE pub_id = ? ORDER BY purpose, is_default DESC', pub.id);
    const domains = await sendableDomains(c);
    const q = str(c.req.query('q'), 120).toLowerCase();
    const outbox = await all<any>(c.env, `SELECT id, to_email, from_email, subject, status, error, created_at FROM outbox WHERE pub_id = ? ${q ? 'AND (to_email LIKE ? OR subject LIKE ?)' : ''} ORDER BY created_at DESC LIMIT 200`, pub.id, ...(q ? [`%${q}%`, `%${q}%`] : []));
    const sq = str(c.req.query('sq'), 120).toLowerCase();
    const supps = await all<any>(
      c.env,
      `SELECT * FROM suppressions WHERE ((scope = 'pub' AND pub_id = ?) OR (scope IN ('global','transactional') AND email IN (SELECT email FROM subscribers WHERE pub_id = ?))) ${sq ? 'AND email LIKE ?' : ''} ORDER BY created_at DESC LIMIT 200`,
      pub.id, pub.id, ...(sq ? [`%${sq}%`] : []),
    );
    const key = await hookKey(c.env);
    const base = c.env.APP_URL.replace(/\/$/, '');
    const { d, supp, doms } = await deliverabilityStats(c);
    const total = Number(d.total || 0);
    const dkimOk = doms.some((x: any) => JSON.parse(x.dns_report || '{}').checks?.find((k: any) => k.key === 'dkim')?.ok);
    const spfOk = doms.some((x: any) => JSON.parse(x.dns_report || '{}').checks?.find((k: any) => k.key === 'spf')?.ok);
    const dmarcOk = doms.some((x: any) => JSON.parse(x.dns_report || '{}').checks?.find((k: any) => k.key === 'dmarc')?.ok);
    const usingPlatform = !doms.some((x: any) => x.status === 'verified');
    const check = (ok: boolean, label: string, hint: string) => <li class="row top"><span>{ok ? '✅' : '⚠️'}</span><span><strong>{label}</strong><div class="muted small">{hint}</div></span></li>;
    const bounceRate = total ? Number(d.bounced || 0) / total : 0;
    const complaintRate = total ? Number(d.complained || 0) / total : 0;
    return page(c, 'email', 'Email & senders', (
      <>
        <Stats>
          <Stat label="Delivered (30d)" value={pct(Number(d.delivered || 0), total)} sub={`${num(Number(d.delivered || 0))} of ${num(total)}`} />
          <Stat label="Bounce rate" value={pct(Number(d.bounced || 0), total, 2)} tone={bounceRate > 0.02 ? 'down' : ''} sub="Keep under 2%" />
          <Stat label="Complaint rate" value={pct(Number(d.complained || 0), total, 3)} tone={complaintRate > 0.001 ? 'down' : ''} sub="Gmail/Yahoo require < 0.3%" />
          <Stat label="Suppressed addresses" value={num(Number(supp.pub || 0) + Number(supp.global || 0))} sub={`${num(Number(supp.pub || 0))} publication · ${num(Number(supp.global || 0))} global`} />
        </Stats>
        <Grid>
          <Card title="Deliverability checklist">
            <ul class="list-plain stack-sm">
              {check(!usingPlatform && spfOk, 'SPF', usingPlatform ? `Sending from the platform domain (${domainOf(c.env.MAIL_FROM)}). Add your own domain under Domains.` : 'Your domain authorizes Cloudflare Email Sending.')}
              {check(usingPlatform || dkimOk, 'DKIM signing', 'Every message is signed by Cloudflare Email Sending.')}
              {check(!usingPlatform && dmarcOk, 'DMARC with alignment', 'p=quarantine or reject, adkim=s; aspf=s.')}
              {check(true, 'One-click unsubscribe (RFC 8058)', 'List-Unsubscribe + List-Unsubscribe-Post headers on every newsletter, as Gmail and Yahoo require.')}
              {check(true, 'Feedback-ID tagging', 'Each campaign is tagged so Gmail Postmaster reports complaint rates per newsletter.')}
              {check(!!s.double_opt_in, 'Double opt-in', s.double_opt_in ? 'New subscribers confirm their address.' : 'Optional — turn on in Publication settings for the cleanest list.')}
              {check(true, 'Signup protection', 'Disposable, invalid and typo’d emails blocked; bots detected; signup endpoints rate-limited.')}
              {check(!doms.some((x: any) => x.blocklisted), 'Not on blocklists', 'Sending domains are checked against Spamhaus DBL, URIBL and SURBL every 6 hours; sending pauses automatically if listed.')}
            </ul>
          </Card>
          <Card title="Bounce & feedback-loop processing">
            <Help>Bounces are classified (hard, soft, mailbox full, DNS) — hard bounces and complaints are suppressed permanently; soft bounces and full mailboxes get temporary suppressions that expire on their own. Deferred mail is retried for 26 hours before it counts as a bounce.</Help>
            <Field label="Bounce webhook (JSON or DSN)"><Copy value={`${base}/hooks/bounce?key=${key}`} /></Field>
            <Field label="Feedback-loop (ARF) endpoint" hint="Register this address/endpoint with mailbox-provider FBL programs (Yahoo CFL, Microsoft JMRP, etc.). Complaints are added to this publication's suppression list."><Copy value={`${base}/hooks/fbl?key=${key}`} /></Field>
            <Help>Example: <code>curl -X POST -H 'content-type: application/json' -d '{"{"}"email":"x@y.com","type":"complaint"{"}"}' '{base}/hooks/bounce?key=…'</code></Help>
          </Card>
        </Grid>

        <Card title="Sender addresses" actions={<OpenBtn target="#sender" small>Add sender</OpenBtn>} pad={false}>
          <Table
            rows={senders}
            empty="No sender addresses — emails go from the platform default."
            cols={[
              { h: 'From', r: (x: any) => <><strong>{x.name || pub.name}</strong> <span class="muted">&lt;{x.email}&gt;</span></> },
              { h: 'Used for', r: (x: any) => <Badge tone="blue">{PURPOSES.find((p) => p[0] === x.purpose)?.[1] || x.purpose}</Badge> },
              { h: 'Default', r: (x: any) => (x.is_default ? <Badge tone="green">default</Badge> : <ActionForm action={`/app/settings/email/senders/${x.id}/default`} label="Make default" />) },
              { h: '', class: 'right', r: (x: any) => <ActionForm action={`/app/settings/email/senders/${x.id}/delete`} label="Remove" kind="danger" confirm="Remove this sender address?" /> },
            ]}
          />
        </Card>

        <Card title="Send a test email">
          <form method="post" action="/app/settings/email/test" class="row">
            <Input name="to" type="email" required value={c.get('user').email} class="grow" />
            <Select name="purpose" options={PURPOSES} value="newsletter" />
            <Btn kind="secondary">Send test</Btn>
          </form>
        </Card>

        <Card title="Suppression list" actions={<OpenBtn target="#suppress" small kind="secondary">Add address</OpenBtn>} pad={false}>
          <form method="get" class="row" style="padding:12px 18px"><Input name="sq" value={sq} placeholder="Search suppressed emails…" class="grow" /><Btn kind="secondary" small>Search</Btn></form>
          <Table
            rows={supps}
            empty="No suppressed addresses."
            cols={[
              { h: 'Email', r: (x: any) => x.email },
              { h: 'Layer', r: (x: any) => <Badge tone={x.scope === 'global' ? 'red' : x.scope === 'transactional' ? 'purple' : 'amber'}>{x.scope === 'pub' ? 'publication' : x.scope}</Badge> },
              { h: 'Reason', r: (x: any) => <code class="small">{x.reason}</code> },
              { h: 'Type', r: (x: any) => (x.expires_at ? <span>Temporary · {x.expires_at > now() ? `expires ${fmtDateTime(x.expires_at)}` : 'expired'}</span> : <span>Permanent</span>) },
              { h: 'Added', r: (x: any) => <span class="muted">{ago(x.created_at)}</span> },
              { h: '', class: 'right', r: (x: any) => <ActionForm action="/app/settings/email/suppressions/remove" fields={{ email: x.email, scope: x.scope }} label="Remove" confirm={x.scope === 'global' ? 'Remove a global suppression? Only do this if you are sure the address is valid.' : undefined} /> },
            ]}
          />
        </Card>

        <Card title="Outbox" actions={<span class="muted small">Every email sent or simulated (last 200). Locally, emails are simulated and only appear here.</span>} pad={false}>
          <form method="get" class="row" style="padding:12px 18px"><Input name="q" value={q} placeholder="Search recipient or subject…" class="grow" /><Btn kind="secondary" small>Search</Btn></form>
          <Table
            rows={outbox}
            empty="No emails yet."
            cols={[
              { h: 'Sent', r: (x: any) => <span class="nowrap">{ago(x.created_at)}</span> },
              { h: 'To', r: (x: any) => x.to_email },
              { h: 'Subject', r: (x: any) => <span class="truncate">{x.subject}</span> },
              { h: 'Status', r: (x: any) => <span title={x.error || ''}><Status s={x.status === 'simulated' ? 'sent' : x.status} />{x.status === 'simulated' && <span class="muted small"> simulated</span>}</span> },
              { h: '', class: 'right', r: (x: any) => <button type="button" class="btn btn-secondary btn-sm" data-preview={`/app/settings/email/outbox/${x.id}`}>View</button> },
            ]}
          />
        </Card>
        <Modal id="preview" title="Email preview" wide>
          <iframe id="preview-frame" class="preview-frame" sandbox="allow-popups allow-popups-to-escape-sandbox" title="Email preview" />
        </Modal>
        <script dangerouslySetInnerHTML={{ __html: `document.addEventListener('click',function(e){var b=e.target.closest('[data-preview]');if(!b)return;document.getElementById('preview-frame').src=b.dataset.preview;document.getElementById('preview').showModal();});` }} />

        <Modal id="sender" title="Add sender address">
          <form method="post" action="/app/settings/email/senders" class="stack">
            <Field label="From name"><Input name="name" value={pub.from_name || pub.name} /></Field>
            <Field label="From email" hint={`Must use a verified domain: ${domains.join(', ')}. Verify more under Domains.`}><Input name="email" type="email" required placeholder={`hello@${domains[domains.length - 1]}`} /></Field>
            <Field label="Used for"><Select name="purpose" options={PURPOSES} value="newsletter" /></Field>
            <label class="check"><input type="checkbox" name="is_default" checked /><span>Default for this purpose</span></label>
            <div class="form-actions"><Btn>Add sender</Btn></div>
          </form>
        </Modal>
        <Modal id="suppress" title="Suppress an address">
          <form method="post" action="/app/settings/email/suppressions" class="stack">
            <Field label="Email(s)" hint="One per line or comma-separated."><textarea class="input" name="emails" rows={4} required /></Field>
            <Field label="Layer"><Select name="scope" options={[['pub', 'This publication (marketing)'], ['transactional', 'Transactional emails'], ['global', 'Global (all mail from this instance)']]} value="pub" /></Field>
            <Field label="Duration"><Select name="days" options={[['0', 'Permanent'], ['3', '3 days'], ['7', '7 days'], ['30', '30 days']]} value="0" /></Field>
            <div class="form-actions"><Btn>Suppress</Btn></div>
          </form>
        </Modal>
      </>
    ));
  });

  dash.get('/email/outbox/:id', requirePerm('admin'), async (c) => {
    const row = await one<any>(c.env, 'SELECT * FROM outbox WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
    if (!row) return c.text('Not found', 404);
    const hdr = JSON.parse(row.headers || '{}');
    const meta = `<div style="font:13px system-ui;background:#f9fafb;border-bottom:1px solid #e5e7eb;padding:10px 14px;color:#374151"><b>From:</b> ${escH(row.from_email)}<br><b>To:</b> ${escH(row.to_email)}<br><b>Subject:</b> ${escH(row.subject)}<br>${Object.entries(hdr).map(([k, v]) => `<b>${escH(k)}:</b> ${escH(String(v))}`).join('<br>')}${row.error ? `<br><b style="color:#b91c1c">Error:</b> ${escH(row.error)}` : ''}</div>`;
    return new Response(meta + row.html, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "script-src 'none'; frame-ancestors 'self'", 'x-frame-options': 'SAMEORIGIN' } });
  });

  dash.post('/email/senders', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const f = await form(c.req);
    const v = await validateEmail(str(f.email));
    if (!v.ok) return back(c, '/app/settings/email', v.reason, 'err');
    const allowed = await sendableDomains(c);
    if (!allowed.includes(domainOf(v.email))) return back(c, '/app/settings/email', `${domainOf(v.email)} isn't verified. Add and verify it under Domains first.`, 'err');
    const purpose = PURPOSES.some((p) => p[0] === f.purpose) ? f.purpose : 'newsletter';
    const isDefault = f.is_default ? 1 : (await val<number>(c.env, 'SELECT COUNT(*) FROM sender_addresses WHERE pub_id = ? AND purpose = ?', pub.id, purpose)) === 0 ? 1 : 0;
    if (isDefault) await run(c.env, 'UPDATE sender_addresses SET is_default = 0 WHERE pub_id = ? AND purpose = ?', pub.id, purpose);
    await insert(c.env, 'sender_addresses', { id: id(), pub_id: pub.id, email: v.email, name: str(f.name, 100), purpose, is_default: isDefault, created_at: now() });
    await audit(c, 'email.sender_added', v.email, { purpose });
    return back(c, '/app/settings/email', 'Sender added');
  });

  dash.post('/email/senders/:id/default', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const s = await one<any>(c.env, 'SELECT * FROM sender_addresses WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!s) return back(c, '/app/settings/email', 'Not found', 'err');
    await run(c.env, 'UPDATE sender_addresses SET is_default = (id = ?) WHERE pub_id = ? AND purpose = ?', s.id, pub.id, s.purpose);
    return back(c, '/app/settings/email', 'Default sender updated');
  });

  dash.post('/email/senders/:id/delete', requirePerm('admin'), async (c) => {
    await run(c.env, 'DELETE FROM sender_addresses WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
    await audit(c, 'email.sender_removed', c.req.param('id'));
    return back(c, '/app/settings/email', 'Sender removed');
  });

  dash.post('/email/test', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const f = await form(c.req);
    const v = await validateEmail(str(f.to));
    if (!v.ok) return back(c, '/app/settings/email', v.reason, 'err');
    const from = await senderFor(c.env, pub, str(f.purpose) || 'newsletter');
    const res = await sendTransactional(c.env, v.email, `Test email from ${pub.name}`, `<p>This is a test from <strong>${escH(pub.name)}</strong>, sent from <code>${escH(from.email)}</code>.</p><p>If you're reading this, sending works. 🎉</p>`, pub, from);
    return back(c, '/app/settings/email', res.ok ? `Test ${res.status === 'simulated' ? 'simulated (see Outbox)' : 'sent'} to ${v.email}` : `Send failed: ${res.error}`, res.ok ? 'ok' : 'err');
  });

  dash.post('/email/suppressions', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const f = await form(c.req);
    const scope = ['pub', 'transactional', 'global'].includes(f.scope) ? f.scope : 'pub';
    const days = Number(f.days) || 0;
    const emails = String(f.emails || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')).slice(0, 1000);
    for (const e of emails) await suppress(c.env, e, scope, 'manual', pub.id, days ? days * DAY : undefined);
    await audit(c, 'email.suppressed', `${emails.length} addresses`, { scope, days });
    return back(c, '/app/settings/email', `${emails.length} address(es) suppressed`);
  });

  dash.post('/email/suppressions/remove', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const f = await form(c.req);
    const email = str(f.email).toLowerCase();
    const scope = ['pub', 'transactional', 'global'].includes(f.scope) ? f.scope : 'pub';
    // global entries can only be lifted for addresses on this publication's list
    if (scope === 'global' && !(await one(c.env, 'SELECT 1 FROM subscribers WHERE pub_id = ? AND email = ?', pub.id, email))) return back(c, '/app/settings/email', 'Not found', 'err');
    await unsuppress(c.env, email, scope, pub.id);
    await audit(c, 'email.unsuppressed', email, { scope });
    return back(c, '/app/settings/email', `${email} removed from suppression`);
  });
}

function escH(s: string) {
  return String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
}
