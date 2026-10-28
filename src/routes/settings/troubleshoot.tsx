/** @jsxImportSource hono/jsx */
// Settings → Email → Troubleshoot: pick a message (or paste an email address / message id / delivery id) and get a
// plain-English diagnosis from real data — suppressed and why, bounced (classified), deferred with the retry schedule,
// plan limit, workspace paused/suspended, campaign held for approval or auto-paused, DNS misconfigured, warm-up cap,
// not yet sent — each with the fix and a one-click action where possible. Mounted at /app/settings/email/troubleshoot.
import { Hono } from 'hono';
import type { AppEnv, Env, Module, Publication } from '../../types';
import { one, all } from '../../lib/db';
import { requirePerm, audit } from '../../lib/auth';
import { isSuppressed, unsuppress, blocksTransactional } from '../../lib/email';
import { checkSend } from '../../lib/plans';
import { workspaceSuspended, rampRemaining } from '../../lib/safety';
import { warmupAllowance } from '../../lib/sender';
import { senderFor } from '../../lib/pub';
import { sharedDomain } from '../../lib/sharedsender';
import { checkDomain } from '../../lib/domains';
import { now, form, str, ago, fmtDateTime, parseJSON, domainOf, MIN } from '../../lib/util';
import { Card, Btn, Badge, Table, Help, back } from '../../ui/components';
import { page } from './ui';

const dash = new Hono<AppEnv>();
dash.use('*', requirePerm('admin'));

export type Severity = 'error' | 'warn' | 'ok' | 'info';
export interface Finding {
  code: string; severity: Severity; title: string; detail: string; fix?: string;
  action?: { label: string; url: string; method?: 'get' | 'post'; fields?: Record<string, string>; confirm?: string };
}
export interface Diagnosis { query: string; email: string | null; subject?: string; findings: Finding[]; summary: string; ms: number }

const BOUNCE_EXPLAIN: Record<string, string> = {
  hard: 'the receiving server says this mailbox does not exist (permanent)',
  soft: 'a temporary problem at the receiving server (busy, rate-limited or greylisting)',
  mailbox_full: 'the recipient’s mailbox is full',
  dns: 'the recipient’s domain has no working mail server (DNS / MX problem)',
  policy: 'the receiving server blocked the message for policy or reputation reasons (spam filter, blocklist)',
  complaint: 'the recipient marked a previous email as spam',
};

const SUPPRESS_EXPLAIN = (reason: string): string => {
  const r = reason.split(':')[0];
  return ({
    hard_bounce: 'an earlier email hard-bounced (the mailbox doesn’t exist)', complaint: 'they reported an email as spam', fbl: 'a mailbox provider feedback loop reported a complaint',
    unsubscribe: 'they unsubscribed', manual: 'someone on your team suppressed it by hand', invalid: 'the address failed validation', policy: 'the receiving server blocked mail for policy reasons',
    mailbox_full: 'their mailbox was full (temporary)', dns_failure: 'their domain had no working mail server (temporary)', repeated_soft_bounce: 'three soft bounces in 14 days (temporary)', cf_suppressed: 'Cloudflare Email Sending has it on its suppression list',
  } as Record<string, string>)[r] || reason;
};

const retrySchedule = (attempts: number) => {
  const mins = [15, 30, 60, 120, 240, 360];
  return mins.slice(Math.min(attempts, mins.length - 1)).slice(0, 4).map((m) => (m >= 60 ? `${m / 60}h` : `${m}m`)).join(', ');
};

/** Diagnose a message / address for this publication. Pure data reads (no side effects except the live DNS check). */
export async function diagnose(env: Env, pub: Publication, rawQuery: string): Promise<Diagnosis> {
  const t0 = now();
  const q = rawQuery.trim();
  const findings: Finding[] = [];
  let email: string | null = null;
  let delivery: any = null;
  let outbox: any = null;
  let tx: any = null;
  // 1) what did they paste?
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q)) email = q.toLowerCase();
  else if (q) {
    const id = q.replace(/^<|>$/g, '');
    delivery = await one<any>(env, 'SELECT * FROM deliveries WHERE pub_id = ? AND (id = ? OR message_id = ?) LIMIT 1', pub.id, id, id);
    outbox = await one<any>(env, 'SELECT * FROM outbox WHERE pub_id = ? AND (id = ? OR message_id = ?) LIMIT 1', pub.id, id, id);
    tx = await one<any>(env, 'SELECT * FROM tx_messages WHERE pub_id = ? AND (id = ? OR message_id = ?) LIMIT 1', pub.id, id, id).catch(() => null);
    email = (delivery?.email || outbox?.to_email || tx?.to_email || null)?.toLowerCase() || null;
    if (!email) return { query: q, email: null, findings: [{ code: 'not_found', severity: 'warn', title: 'No message found', detail: `Nothing in this publication matches “${q}”.`, fix: 'Paste the recipient’s email address, or a message id from the Outbox / API response.' }], summary: 'No message found for that id.', ms: now() - t0 };
  }
  if (!email) return { query: q, email: null, findings: [], summary: '', ms: now() - t0 };
  const sub = await one<any>(env, 'SELECT * FROM subscribers WHERE pub_id = ? AND email = ?', pub.id, email);
  if (!delivery && !outbox) delivery = await one<any>(env, 'SELECT * FROM deliveries WHERE pub_id = ? AND email = ? ORDER BY created_at DESC LIMIT 1', pub.id, email);
  // test emails, login links and other one-off mail to this address (no delivery row): the latest outbox entry
  if (!delivery && !outbox) outbox = await one<any>(env, 'SELECT * FROM outbox WHERE pub_id = ? AND to_email = ? ORDER BY created_at DESC LIMIT 1', pub.id, email);
  const send = delivery ? await one<any>(env, 'SELECT * FROM sends WHERE id = ?', delivery.send_id) : null;
  const subject = send?.subject || outbox?.subject || tx?.subject;

  // 2) the subscriber
  if (!sub) findings.push({ code: 'not_subscribed', severity: outbox || tx ? 'info' : 'error', title: 'Not on your list', detail: `${email} isn’t a subscriber of ${pub.name}, so newsletters and automations never go to them${outbox || tx ? ' (one-off emails such as tests still do)' : ''}.`, fix: 'Add them (Audience → Add subscriber), or ask them to subscribe on your site.', action: { label: 'Open Audience', url: '/app/audience' } });
  else if (sub) {
    if (sub.status === 'pending') findings.push({ code: 'unconfirmed', severity: 'error', title: 'Waiting for double opt-in confirmation', detail: `They signed up ${ago(sub.created_at)} but never clicked the confirmation link, so they receive nothing yet.`, fix: 'Ask them to check spam for the confirmation email, or confirm them manually if you have their consent.', action: { label: 'Open subscriber', url: `/app/audience/subscribers/${sub.id}` } });
    else if (sub.status === 'unsubscribed') findings.push({ code: 'unsubscribed', severity: 'error', title: 'Unsubscribed', detail: `They unsubscribed ${ago(sub.unsubscribed_at)}${sub.unsubscribe_reason ? ` (reason: ${sub.unsubscribe_reason})` : ''}. Marketing email stops by law; transactional mail still works.`, fix: 'Only they can resubscribe — send them your subscribe page.' });
    else if (sub.status === 'bounced') findings.push({ code: 'bounced_sub', severity: 'error', title: 'Marked as bounced', detail: 'An earlier email to this address bounced permanently, so we stopped sending to protect your reputation.', fix: 'Confirm the address is correct (typos like gmial.com are common). If they fixed their mailbox, remove the suppression below and they’ll get your next email.' });
    else if (sub.status === 'complained') findings.push({ code: 'complained_sub', severity: 'error', title: 'Reported your email as spam', detail: `They marked an email as spam ${ago(sub.unsubscribed_at)}. They’re unsubscribed and suppressed for this publication.`, fix: 'Don’t re-add them. Complaints above 0.3% hurt delivery for your whole list — check that people expect your emails.' });
    else findings.push({ code: 'active', severity: 'ok', title: 'Active subscriber', detail: `Subscribed ${ago(sub.created_at)} · ${sub.tier} · received ${sub.received_count}, opened ${sub.open_count}, clicked ${sub.click_count}${sub.last_open_at ? ` · last open ${ago(sub.last_open_at)}` : ''}.` });
  }

  // 3) suppression lists
  const sup = await isSuppressed(env, email, pub.id, 'marketing');
  const supRows = await all<any>(env, `SELECT scope, pub_id, reason, expires_at, created_at FROM suppressions WHERE email = ? AND (expires_at IS NULL OR expires_at > ?) AND (scope != 'pub' OR pub_id = ?)`, email, now(), pub.id);
  for (const s of supRows) {
    const temp = !!s.expires_at;
    const removable = s.scope === 'pub' || (s.scope === 'global' && !!sub) || s.scope === 'transactional';
    const why = SUPPRESS_EXPLAIN(s.reason);
    findings.push({
      code: 'suppressed', severity: 'error', title: `Suppressed (${s.scope === 'pub' ? 'this publication' : s.scope === 'global' ? 'all publications' : 'transactional email'})`,
      detail: `Added ${ago(s.created_at)} because ${why}.${temp ? ` It expires automatically ${fmtDateTime(s.expires_at)}.` : ''} ${s.scope === 'transactional' || blocksTransactional(s.reason) ? 'Login links and receipts are blocked too.' : 'Login links and receipts still get through.'}`,
      fix: /complaint|fbl/.test(s.reason) ? 'Don’t remove a complaint suppression unless the person asked you to — it protects your sender reputation.' : temp ? 'Wait for it to expire, or remove it now if the problem is fixed.' : 'Remove it only if you’re sure the address works now (e.g. they fixed a typo or their mailbox).',
      action: removable && !/complaint|fbl/.test(s.reason) ? { label: 'Remove suppression', url: '/app/settings/email/troubleshoot/unsuppress', method: 'post', fields: { email, scope: s.scope }, confirm: `Remove ${email} from the ${s.scope} suppression list?` } : undefined,
    });
  }
  if (sup && !supRows.length) findings.push({ code: 'suppressed', severity: 'error', title: 'Suppressed', detail: `Suppressed because ${SUPPRESS_EXPLAIN(sup)}.` });

  // 4) the latest message
  if (delivery) {
    const d = delivery;
    const what = send ? `“${send.subject}”` : 'the latest email';
    switch (d.status) {
      case 'sent': findings.push({ code: 'delivered', severity: 'ok', title: `${what} was accepted for delivery`, detail: `Handed to the mail system ${ago(d.sent_at)}${d.message_id ? ` (message id ${d.message_id})` : ''}.${d.opened_at ? ` Opened ${ago(d.opened_at)}.` : ' Not opened yet.'}${d.clicked_at ? ` Clicked ${ago(d.clicked_at)}.` : ''}`, fix: d.opened_at ? undefined : 'If they can’t find it: ask them to search for the subject, check Spam / Promotions, and add your From address to contacts.' }); break;
      case 'deferred': findings.push({ code: 'deferred', severity: 'warn', title: `${what} is delayed — retrying automatically`, detail: `The receiving server answered with a temporary error (${BOUNCE_EXPLAIN[d.bounce_type] || d.bounce_type || 'soft'}): “${String(d.error || '').slice(0, 200)}”. Attempt ${d.attempts}; next try ${d.next_attempt_at ? fmtDateTime(d.next_attempt_at) + ` (${d.next_attempt_at > now() ? 'in ' + Math.max(1, Math.round((d.next_attempt_at - now()) / MIN)) + ' min' : 'due now'})` : 'soon'}. Then every ${retrySchedule(d.attempts)} … for up to 26 hours before it counts as a bounce.`, fix: 'Nothing to do — most deferrals clear within an hour. Repeated deferrals from one provider usually mean you’re sending faster than it accepts.' }); break;
      case 'bounced': findings.push({ code: 'bounced', severity: 'error', title: `${what} bounced (${d.bounce_type || 'unknown'})`, detail: `It bounced because ${BOUNCE_EXPLAIN[d.bounce_type] || 'the receiving server rejected it'}. Server said: “${String(d.error || 'no details').slice(0, 300)}”.`, fix: d.bounce_type === 'hard' ? 'Check the address for typos and remove it if it’s wrong.' : d.bounce_type === 'policy' ? 'Their server is filtering your mail: authenticate your own domain (SPF, DKIM, DMARC), avoid link shorteners and spammy wording, and ask them to allow-list your From address.' : 'This usually clears on its own; the next email will be tried again.' }); break;
      case 'failed': {
        const dnsErr = /E_SENDER_NOT_VERIFIED|E_SENDER_DOMAIN_NOT_AVAILABLE|not verified/i.test(d.error || '');
        findings.push({ code: dnsErr ? 'dns_sender' : 'failed', severity: 'error', title: dnsErr ? 'Your sending domain isn’t set up for sending' : `${what} failed`, detail: `Error: “${String(d.error || 'unknown').slice(0, 300)}”.`, fix: dnsErr ? 'Add and verify the domain under Settings → Domains (SPF, DKIM, DMARC), or switch back to the shared sender.' : 'If it was a temporary error it is retried automatically; otherwise send them a test from Settings → Email.', action: dnsErr ? { label: 'Fix DNS in Domains', url: '/app/settings/domains' } : undefined });
        break;
      }
      case 'suppressed': findings.push({ code: 'skipped_suppressed', severity: 'error', title: `${what} was not sent: address suppressed`, detail: `Skipped at send time — ${String(d.error || '').replace(/^suppressed: /, 'reason: ')}.` }); break;
      case 'complained': findings.push({ code: 'complained', severity: 'error', title: `They reported ${what} as spam`, detail: `Complaint received ${ago(d.created_at)}.` }); break;
      case 'scheduled': findings.push({ code: 'scheduled', severity: 'info', title: `${what} is scheduled for them`, detail: `Send-time optimization / time-zone delivery planned it for ${fmtDateTime(d.next_attempt_at, pub.timezone)} (${pub.timezone}).`, fix: 'Nothing to do — it goes out at that time.' }); break;
      case 'queued': findings.push({ code: 'queued', severity: 'info', title: `${what} is being sent right now`, detail: 'It’s in the current batch. Check again in a minute.' }); break;
      default: findings.push({ code: 'delivery_' + d.status, severity: 'info', title: `${what}: ${d.status}`, detail: String(d.error || '') });
    }
  } else if (outbox || tx) {
    const o = outbox || tx;
    findings.push(o.status === 'failed'
      ? { code: 'failed', severity: 'error', title: `“${o.subject}” failed`, detail: `Error: “${String(o.error || '').slice(0, 300)}”.`, fix: /not verified|E_SENDER/i.test(o.error || '') ? 'Verify your sending domain under Settings → Domains.' : undefined }
      : { code: 'delivered', severity: o.status === 'suppressed' ? 'error' : 'ok', title: `“${o.subject}” — ${o.status}`, detail: `${o.status === 'simulated' ? 'Simulated (this instance doesn’t send real email): visible in the Outbox.' : 'Accepted by the mail system'} ${ago(o.created_at)}.` });
  }

  // 5) the campaign itself (held, paused, testing, still sending, or they weren't in the audience)
  const latest = send?.kind === 'post' ? send : await one<any>(env, `SELECT * FROM sends WHERE pub_id = ? AND kind = 'post' ORDER BY created_at DESC LIMIT 1`, pub.id);
  if (latest) {
    const mine = send?.id === latest.id ? delivery : await one<any>(env, 'SELECT * FROM deliveries WHERE send_id = ? AND email = ?', latest.id, email);
    const link = latest.post_id ? `/app/posts/${latest.post_id}` : '/app/posts';
    if (latest.status === 'pending_approval') findings.push({ code: 'held_for_approval', severity: 'warn', title: `“${latest.subject}” is held for a one-time review`, detail: `New accounts’ first large campaign waits for our team to approve it (requested ${ago(latest.created_at)}). Nobody receives it until then.`, fix: 'Nothing to do — you’ll get an email when it’s approved, usually within a few hours.', action: { label: 'See the campaign', url: link } });
    else if (latest.status === 'paused') findings.push({ code: 'campaign_paused', severity: 'error', title: `“${latest.subject}” was paused`, detail: latest.status_reason || 'Sending was paused.', fix: /bounce|complaint/i.test(latest.status_reason || '') ? 'Clean the list (remove bounced, never-opted-in and long-inactive addresses), then reply to the pause email to have it reviewed.' : 'Resume it from the campaign page once the cause is fixed.', action: { label: 'See the campaign', url: link } });
    else if (latest.status === 'testing' && !mine) findings.push({ code: 'ab_waiting', severity: 'info', title: `“${latest.subject}” is in its A/B test phase`, detail: 'A sample of your list is getting the variants; everyone else (including this reader) gets the winner when the test ends.', fix: 'Nothing to do.' });
    else if (latest.status === 'sending' && !mine) findings.push({ code: 'not_yet_sent', severity: 'info', title: `“${latest.subject}” hasn’t reached them yet`, detail: `It’s still going out: ${latest.sent} of ${latest.total} sent so far${latest.status_reason ? ` — ${latest.status_reason}` : ''}.`, fix: 'Nothing to do — large lists go out in batches.' });
    else if (['sent', 'sending'].includes(latest.status) && !mine && sub?.status === 'active' && !(send && send.id === latest.id)) {
      const joinedAfter = sub.created_at > (latest.started_at || latest.created_at);
      findings.push({ code: 'not_in_audience', severity: 'warn', title: `Not a recipient of “${latest.subject}”`, detail: joinedAfter ? `They subscribed ${ago(sub.created_at)}, after this newsletter started sending (${ago(latest.started_at || latest.created_at)}).` : 'They were active, but the send’s audience (tier, segment, list or exclusions) didn’t include them.', fix: joinedAfter ? 'Your welcome automation covers new readers; the next issue will reach them.' : 'Check the post’s audience settings.', action: { label: 'See the campaign', url: link } });
    }
  }
  // automation runs waiting on a plan/ramp pause
  if (sub) {
    const paused = await one<any>(env, `SELECT a.name, l.result, l.created_at FROM automation_runs r JOIN automations a ON a.id = r.automation_id JOIN automation_logs l ON l.run_id = r.id
      WHERE r.subscriber_id = ? AND r.status IN ('active','waiting') AND l.result LIKE 'paused:%' ORDER BY l.created_at DESC LIMIT 1`, sub.id);
    if (paused) findings.push({ code: 'automation_paused', severity: 'warn', title: `Automation “${paused.name}” is holding an email for them`, detail: `${paused.result.replace(/^paused: /, '')} (${ago(paused.created_at)}). The step is retried every 3 hours; nothing is dropped.`, fix: 'Fix the cause below (plan limit or daily ramp) and it continues automatically.' });
  }

  // 6) account-level blockers
  const suspended = await workspaceSuspended(env, pub.workspace_id);
  if (suspended) findings.push({ code: 'workspace_paused', severity: 'error', title: 'Sending is paused for your whole account', detail: suspended, fix: 'Reply to the suspension email or contact support; sending resumes after review.' });
  const gate = await checkSend(env, pub, 1, { dryRun: true }).catch(() => null);
  if (gate && !gate.ok && gate.code !== 'suspended') findings.push({ code: 'plan_limit', severity: 'error', title: gate.code === 'subscriber_cap' ? 'Over your plan’s subscriber limit' : 'Monthly email allowance used up', detail: gate.reason || '', fix: 'Upgrade your plan — sending resumes immediately.', action: { label: 'Upgrade plan', url: '/app/settings/plan' } });
  const ramp = await rampRemaining(env, pub.workspace_id).catch(() => ({ remaining: Infinity, reason: undefined as string | undefined }));
  if (ramp.remaining <= 0) findings.push({ code: 'ramp', severity: 'warn', title: 'New-account daily limit reached', detail: ramp.reason || 'New accounts send a limited number of emails per day for their first days.', fix: 'Sending resumes automatically as the 24-hour window frees up.' });

  // 7) sender + DNS
  const from = await senderFor(env, pub, 'newsletter');
  const fromHost = domainOf(from.email);
  const warm = await warmupAllowance(env, from.email).catch(() => ({ ok: true, remaining: Infinity, reason: undefined as string | undefined }));
  if (!warm.ok) findings.push({ code: /blocklist/i.test(warm.reason || '') ? 'blocklisted' : 'warmup_cap', severity: 'warn', title: /blocklist/i.test(warm.reason || '') ? 'Sending domain is on a blocklist' : 'Warm-up limit reached for today', detail: warm.reason || '', fix: /blocklist/i.test(warm.reason || '') ? 'Request delisting from the blocklist operator; sending resumes on the next check.' : 'Emails over today’s cap go out in the next window automatically.' });
  const doms = await all<any>(env, `SELECT * FROM domains WHERE pub_id = ? AND kind = 'email'`, pub.id);
  const usingShared = fromHost === sharedDomain(env);
  for (const d of doms) {
    const rep = parseJSON<any>(d.dns_report, {});
    const bad = (rep.checks || []).filter((k: any) => !k.ok && ['verify', 'spf', 'dkim', 'dmarc'].includes(k.key)).map((k: any) => k.key.toUpperCase());
    if (d.status !== 'verified' || bad.length) findings.push({ code: 'dns_misconfigured', severity: 'warn', title: `DNS for ${d.hostname} ${d.status !== 'verified' ? 'isn’t verified' : 'is incomplete'}`, detail: `${d.status !== 'verified' ? 'Until the ownership TXT record is found, mail goes out from the shared sender instead of your domain. ' : ''}${bad.length ? `Missing or wrong: ${bad.join(', ')}.` : ''} Last checked ${rep.checked_at ? ago(rep.checked_at) : 'never'}.`, fix: 'Add the exact records shown under Settings → Domains, then re-check (DNS changes can take a few minutes).', action: { label: 'Re-check DNS now', url: `/app/settings/email/troubleshoot/recheck/${d.id}`, method: 'post', fields: { q: email } } });
  }
  findings.push({ code: 'sender', severity: 'info', title: `Sending as ${from.email}`, detail: usingShared ? `The shared sender: SPF, DKIM and DMARC are handled by the platform. Replies go to your reply-to address.` : `Your own domain ${fromHost}.` });

  const worst = findings.find((f) => f.severity === 'error') || findings.find((f) => f.severity === 'warn');
  const summary = worst ? worst.title : findings.some((f) => f.code === 'delivered') ? 'Delivered — nothing is blocking this address.' : 'Nothing is blocking this address.';
  return { query: q, email, subject, findings, summary, ms: now() - t0 };
}

const TONE: Record<Severity, 'red' | 'amber' | 'green' | 'blue'> = { error: 'red', warn: 'amber', ok: 'green', info: 'blue' };
const ICON: Record<Severity, string> = { error: '⛔', warn: '⚠️', ok: '✅', info: 'ℹ️' };

dash.get('/', async (c) => {
  const pub = c.get('pub');
  const q = str(c.req.query('q'), 200);
  const dx = q ? await diagnose(c.env, pub, q) : null;
  if (c.req.query('format') === 'json') return c.json(dx || { findings: [] });
  const recent = await all<any>(c.env, `SELECT d.id, d.email, d.status, d.bounce_type, d.created_at, s.subject FROM deliveries d JOIN sends s ON s.id = d.send_id
    WHERE d.pub_id = ? AND d.status NOT IN ('sent') ORDER BY d.created_at DESC LIMIT 15`, pub.id);
  const out = await all<any>(c.env, `SELECT id, to_email, subject, status, created_at FROM outbox WHERE pub_id = ? ORDER BY created_at DESC LIMIT 10`, pub.id);
  return page(c, 'email', 'Troubleshoot delivery', (
    <>
      <p><a href="/app/settings/email">← Email &amp; senders</a></p>
      <Card>
        <form method="get" class="row" style="gap:8px;flex-wrap:wrap" data-troubleshoot-form>
          <input class="input" name="q" value={q} required placeholder="reader@example.com, a message id, or a delivery id" style="flex:1;min-width:260px" autofocus />
          <Btn>Diagnose</Btn>
        </form>
        <Help>Paste the address of someone who says they didn’t get your email — or pick a message below. The diagnosis reads suppression lists, bounces, retries, plan limits, campaign holds and your DNS.</Help>
      </Card>
      {dx && (
        <Card title={<span>Diagnosis for <span class="mono">{dx.email || dx.query}</span>{dx.subject ? <span class="muted small"> · {dx.subject}</span> : null}</span>} actions={<span class="muted small">{dx.ms} ms</span>}>
          <p data-diagnosis-summary><strong>{dx.summary}</strong></p>
          <ul class="list-plain stack" data-findings>
            {dx.findings.map((f) => (
              <li class="row top" data-finding={f.code}>
                <span aria-hidden="true">{ICON[f.severity]}</span>
                <div style="flex:1">
                  <div><strong>{f.title}</strong> <Badge tone={TONE[f.severity]}>{f.severity === 'ok' ? 'ok' : f.severity === 'info' ? 'info' : f.severity === 'warn' ? 'attention' : 'blocking'}</Badge></div>
                  <div class="small">{f.detail}</div>
                  {f.fix && <div class="small"><strong>Fix:</strong> {f.fix}</div>}
                  {f.action && (f.action.method === 'post'
                    ? <form method="post" action={f.action.url} class="inline-form" style="margin-top:6px">{Object.entries(f.action.fields || {}).map(([k, v]) => <input type="hidden" name={k} value={v} />)}<Btn small kind="secondary" confirm={f.action.confirm}>{f.action.label}</Btn></form>
                    : <div style="margin-top:6px"><a class="btn btn-secondary btn-sm" href={f.action.url}>{f.action.label}</a></div>)}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title="Messages that didn’t go out normally" pad={false}>
        <Table rows={recent} empty="No failed, bounced, deferred or suppressed messages. 🎉" cols={[
          { h: 'To', r: (r: any) => <a href={`?q=${encodeURIComponent(r.id)}`}>{r.email}</a> },
          { h: 'Email', r: (r: any) => r.subject },
          { h: 'Status', r: (r: any) => <Badge tone={r.status === 'deferred' || r.status === 'scheduled' ? 'amber' : 'red'}>{r.status}{r.bounce_type ? ` · ${r.bounce_type}` : ''}</Badge> },
          { h: '', class: 'right', r: (r: any) => <a class="btn btn-ghost btn-sm" href={`?q=${encodeURIComponent(r.id)}`}>Diagnose</a> },
        ]} />
      </Card>
      <Card title="Recent emails" pad={false}>
        <Table rows={out} empty="Nothing sent yet." cols={[
          { h: 'To', r: (r: any) => r.to_email },
          { h: 'Subject', r: (r: any) => r.subject },
          { h: 'Status', r: (r: any) => <Badge tone={r.status === 'failed' || r.status === 'suppressed' ? 'red' : 'green'}>{r.status}</Badge> },
          { h: '', class: 'right', r: (r: any) => <a class="btn btn-ghost btn-sm" href={`?q=${encodeURIComponent(r.id)}`}>Diagnose</a> },
        ]} />
      </Card>
    </>
  ));
});

dash.post('/unsuppress', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const email = str(f.email, 254).toLowerCase();
  const scope = ['pub', 'transactional', 'global'].includes(f.scope) ? f.scope : 'pub';
  if (scope === 'global' && !(await one(c.env, 'SELECT 1 FROM subscribers WHERE pub_id = ? AND email = ?', pub.id, email))) return back(c, '/app/settings/email/troubleshoot', 'Not found', 'err');
  const row = await one<any>(c.env, `SELECT reason FROM suppressions WHERE email = ? AND scope = ? AND pub_id = ?`, email, scope, scope === 'global' ? '' : pub.id);
  if (row && /complaint|fbl/.test(row.reason)) return back(c, `/app/settings/email/troubleshoot?q=${encodeURIComponent(email)}`, 'Complaint suppressions can’t be removed from here.', 'err');
  await unsuppress(c.env, email, scope, pub.id);
  // a bounced subscriber whose mailbox works again becomes active, so the next email reaches them
  if (scope !== 'transactional') await c.env.DB.prepare(`UPDATE subscribers SET status = 'active', updated_at = ? WHERE pub_id = ? AND email = ? AND status = 'bounced'`).bind(now(), pub.id, email).run();
  await audit(c, 'email.unsuppressed', email, { scope, via: 'troubleshoot' });
  return back(c, `/app/settings/email/troubleshoot?q=${encodeURIComponent(email)}`, `${email} removed from the ${scope} suppression list`);
});

dash.post('/recheck/:id', async (c) => {
  const pub = c.get('pub');
  const d = await one<any>(c.env, 'SELECT * FROM domains WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
  const q = str((await form(c.req)).q, 200);
  if (!d) return back(c, '/app/settings/email/troubleshoot', 'Not found', 'err');
  const r = await checkDomain(c.env, d);
  const missing = r.checks.filter((k) => !k.ok && k.key !== 'mx').map((k) => k.key.toUpperCase());
  return back(c, `/app/settings/email/troubleshoot?q=${encodeURIComponent(q)}`, r.verified && !missing.length ? `${d.hostname}: all records found ✓` : `${d.hostname}: ${r.verified ? 'verified' : 'not verified'}${missing.length ? ` — missing ${missing.join(', ')}` : ''}`, r.verified && !missing.length ? 'ok' : 'err');
});

export default { dash } satisfies Module;
