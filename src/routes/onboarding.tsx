/** @jsxImportSource hono/jsx */
// "First authenticated test email in under 10 minutes" — the onboarding wizard after signup (/app/start).
// 1 name the publication (the /app/onboarding form) → 2 shared sender or your own domain (exact DNS records, copy
// buttons, live checking) → 3 send a test email to yourself → 4 see it arrive, with SPF / DKIM / DMARC explained from
// live DNS → 5 import contacts or connect a form. Time-to-first-send (signup → test email) is tracked and shown.
import { Hono } from 'hono';
import type { AppEnv, Ctx, Env, Module } from '../types';
import { one, all, run, insert } from '../lib/db';
import { requirePerm, audit } from '../lib/auth';
import { senderFor } from '../lib/pub';
import { sharedAddress, sharedDomain } from '../lib/sharedsender';
import { recordsFor, SPF_INCLUDE, DKIM_SELECTOR } from '../lib/domains';
import { sendTransactional } from '../lib/email';
import { validateEmail } from '../lib/guard';
import { id, now, token, form, str, esc, MIN, DAY } from '../lib/util';
import { PlainLayout } from '../ui/layout';
import { Btn, back } from '../ui/components';

const dash = new Hono<AppEnv>();
dash.use('*', requirePerm('admin'));

const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

async function progress(c: Ctx) {
  const pub = c.get('pub');
  let p = await one<any>(c.env, 'SELECT * FROM onboarding_progress WHERE pub_id = ?', pub.id);
  if (!p) {
    const user = c.get('user');
    // the clock starts at signup when the publication is the user's first (a fresh signup), else now
    const start = user.created_at > now() - DAY ? Math.min(user.created_at, pub.created_at) : now();
    await run(c.env, 'INSERT OR IGNORE INTO onboarding_progress (pub_id, user_id, started_at, updated_at) VALUES (?, ?, ?, ?)', pub.id, user.id, start, now());
    p = await one<any>(c.env, 'SELECT * FROM onboarding_progress WHERE pub_id = ?', pub.id);
  }
  return p;
}

const dur = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };

// ───────── live DNS (DoH) for the authentication explanation ─────────
async function txt(name: string): Promise<string[]> {
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, { headers: { accept: 'application/dns-json' } });
    const j: any = await r.json();
    return (j.Answer || []).map((a: any) => String(a.data || '').replace(/^"|"$/g, '').replace(/"\s*"/g, ''));
  } catch { return []; }
}

export interface AuthCheck { key: 'spf' | 'dkim' | 'dmarc'; ok: boolean; found: string; meaning: string; fix?: string }

/**
 * SPF / DKIM / DMARC for the domain mail is sent from, explained in plain English.
 * Cloudflare Email Sending publishes SPF on the Return-Path host cf-bounce.<domain> and DKIM at cf-bounce._domainkey;
 * older setups use the root SPF record and the cf2024-1 selector — either passes.
 */
export async function authChecks(host: string): Promise<Array<AuthCheck & { host: string }>> {
  const [root, bounce, dkimCf, dkimOld, dmarc] = await Promise.all([txt(host), txt(`cf-bounce.${host}`), txt(`cf-bounce._domainkey.${host}`), txt(`${DKIM_SELECTOR}._domainkey.${host}`), txt(`_dmarc.${host}`)]);
  const spfB = bounce.find((x) => x.startsWith('v=spf1') && x.includes('_spf.mx.cloudflare.net'));
  const spfR = root.find((x) => x.startsWith('v=spf1')) || '';
  const spfOk = !!spfB || spfR.includes('_spf.mx.cloudflare.net');
  const dkB = dkimCf.find((x) => /v=DKIM1|p=/.test(x));
  const dkO = dkimOld.find((x) => /v=DKIM1|p=/.test(x));
  const dm = dmarc.find((x) => x.startsWith('v=DMARC1')) || '';
  const policy = (dm.match(/p=(\w+)/) || [])[1] || '';
  return [
    { key: 'spf', host: spfB ? `cf-bounce.${host}` : host, ok: spfOk, found: spfB || spfR || 'no SPF record', meaning: 'SPF lists the servers allowed to send for your domain. Inboxes check that the server delivering your email (Cloudflare) is on that list for the bounce address it uses.', fix: `Enable Email Sending for ${host} in Cloudflare (it publishes SPF on cf-bounce.${host}), or add ${SPF_INCLUDE} to your SPF record.` },
    { key: 'dkim', host: dkB ? `cf-bounce._domainkey.${host}` : `${DKIM_SELECTOR}._domainkey.${host}`, ok: !!(dkB || dkO), found: (dkB || dkO || 'no DKIM key found').slice(0, 60), meaning: 'DKIM adds a tamper-proof signature to every email. Inboxes verify it with the public key published in your DNS, proving the message really came from you and wasn’t changed on the way.', fix: `Enable Email Sending for ${host} in Cloudflare — it publishes the DKIM key at cf-bounce._domainkey.${host}.` },
    { key: 'dmarc', host: `_dmarc.${host}`, ok: !!dm, found: dm || 'no DMARC record', meaning: `DMARC tells inboxes what to do when a message claiming to be from ${host} fails SPF/DKIM alignment${policy ? ` — yours says “${policy}”` : ''}, and where to send reports. Gmail and Yahoo require it for bulk senders.`, fix: `Add a TXT record on _dmarc.${host}: v=DMARC1; p=quarantine; rua=mailto:dmarc@${host}` },
  ];
}

const STEPS = ['Name', 'Sender', 'Test email', 'Arrived', 'Contacts'];

function Stepper(p: { at: number }) {
  return (
    <ol class="row" style="list-style:none;padding:0;gap:6px;flex-wrap:wrap;margin:0 0 18px" data-stepper>
      {STEPS.map((s, i) => <li class={`badge ${i < p.at ? 'b-green' : i === p.at ? 'b-blue' : 'b-gray'}`}>{i < p.at ? '✓' : i + 1}. {s}</li>)}
    </ol>
  );
}

function Timer(p: { started: number; sent: number | null }) {
  return (
    <div class="callout row between" data-ttfs={p.sent ? String(p.sent - p.started) : ''}>
      {p.sent
        ? <span>⏱️ <strong>First authenticated email sent in {dur(p.sent - p.started)}</strong> {p.sent - p.started < 3 * MIN ? '— under our 3-minute goal 🎉' : p.sent - p.started < 10 * MIN ? '— under 10 minutes' : ''}</span>
        : <span>⏱️ Time since signup: <strong data-ttfs-clock data-start={String(p.started)}>{dur(now() - p.started)}</strong> <span class="muted small">goal: first test email in under 3 minutes</span></span>}
    </div>
  );
}

dash.get('/', async (c) => {
  const pub = c.get('pub');
  const user = c.get('user');
  const p = await progress(c);
  const dom = p.domain_id ? await one<any>(c.env, 'SELECT * FROM domains WHERE id = ? AND pub_id = ?', p.domain_id, pub.id) : null;
  const from = await senderFor(c.env, pub, 'newsletter');
  const step = !p.sender_choice ? 1 : !p.first_send_at ? 2 : !p.next_choice ? 3 : 4;
  const outbox = p.test_outbox_id ? await one<any>(c.env, 'SELECT id, status, error, from_email, created_at FROM outbox WHERE id = ?', p.test_outbox_id) : null;
  const median = await one<{ m: number | null }>(c.env, `SELECT AVG(first_send_at - started_at) AS m FROM (SELECT first_send_at, started_at FROM onboarding_progress WHERE first_send_at IS NOT NULL ORDER BY first_send_at - started_at LIMIT 1 OFFSET (SELECT COUNT(*) FROM onboarding_progress WHERE first_send_at IS NOT NULL) / 2)`);
  const recs = dom ? recordsFor(c.env, dom).filter((r) => r.key !== 'mx') : [];
  const card = 'border:1px solid var(--line,#e5e7eb);border-radius:12px;padding:16px;margin:12px 0';
  return c.html(
    <PlainLayout title="Get your first email out" wide c={c}>
      <h1 style="margin-bottom:4px">{pub.name}: let’s send your first email</h1>
      <p class="muted" style="margin-top:0">Five quick steps. You can skip any of them and come back from the dashboard.</p>
      <Stepper at={step} />
      <Timer started={p.started_at} sent={p.first_send_at} />

      <section style={card} data-step="name"><strong>✓ 1. Publication named</strong> — {pub.name} <a class="small" href="/app/settings">rename</a></section>

      <section style={card} data-step="sender" id="sender">
        <strong>{p.sender_choice ? '✓ ' : ''}2. Choose how you send</strong>
        <form method="post" action="/app/start/sender" class="stack" style="margin-top:10px">
          <label class="row top" style="gap:10px;cursor:pointer"><input type="radio" name="choice" value="shared" checked={p.sender_choice !== 'domain'} />
            <span><strong>Shared sender — ready now (recommended to start)</strong><br /><span class="small muted">Send as <code>{sharedAddress(c.env, pub)}</code>, already authenticated with SPF, DKIM and DMARC. Replies go to {pub.reply_to || user.email}. You can switch to your own domain any time.</span></span></label>
          <label class="row top" style="gap:10px;cursor:pointer"><input type="radio" name="choice" value="domain" checked={p.sender_choice === 'domain'} />
            <span><strong>My own domain</strong><br /><span class="small muted">Best inbox placement and branding. Takes a few DNS records; we’ll keep using the shared sender until they check out.</span>
              <input class="input" name="hostname" placeholder="example.com" value={dom?.hostname || ''} style="margin-top:6px;max-width:320px" /></span></label>
          <div><Btn small={!!p.sender_choice} attrs={{ 'data-sender-continue': '' }}>{p.sender_choice ? 'Update' : 'Continue'}</Btn></div>
        </form>
        {dom && (
          <div style="margin-top:12px" data-dns-records={dom.id}>
            <p class="small"><strong>Add these DNS records at your DNS provider</strong> for <code>{dom.hostname}</code>:</p>
            <div style="overflow-x:auto;max-width:100%"><table class="table small" style="table-layout:fixed;width:100%"><thead><tr><th>Type</th><th>Name</th><th>Value</th><th>Status</th></tr></thead><tbody>
              {recs.map((r) => (
                <tr><td><code>{r.type}</code></td><td><code style="word-break:break-all">{r.host}</code> <button type="button" class="btn btn-ghost btn-sm" data-copy={r.host}>Copy</button></td>
                  <td><code style="word-break:break-all">{r.value}</code>{!r.value.startsWith('Provided') && <> <button type="button" class="btn btn-ghost btn-sm" data-copy={r.value}>Copy</button></>}</td>
                  <td data-rec-status={r.key} class="muted">checking…</td></tr>
              ))}
            </tbody></table></div>
            <p class="small muted" data-dns-live={`/app/settings/domains/${dom.id}/check.json`}>Checking live every 10 seconds. DNS changes usually appear within a few minutes — you can send your test from the shared sender meanwhile.</p>
          </div>
        )}
      </section>

      <section style={card} data-step="test" id="test">
        <strong>{p.first_send_at ? '✓ ' : ''}3. Send a test email to yourself</strong>
        <form method="post" action="/app/start/test" class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
          <input class="input" type="email" name="to" required value={p.test_to || user.email} style="flex:1;min-width:220px" />
          <Btn attrs={{ 'data-send-test': '' }} disabled={!p.sender_choice}>{p.first_send_at ? 'Send again' : 'Send test email'}</Btn>
        </form>
        <p class="small muted">From <code>{from.email}</code>{!p.sender_choice ? ' — choose a sender first' : ''}.</p>
      </section>

      <section style={card} data-step="arrived" id="arrived">
        <strong>{p.first_send_at ? '✓ ' : ''}4. See it arrive</strong>
        {outbox ? (
          <div data-arrival={p.test_outbox_id}>
            <p class="small" data-arrival-status>{outbox.status === 'failed' ? <>❌ Failed: {outbox.error} — <a href={`/app/settings/email/troubleshoot?q=${encodeURIComponent(outbox.id)}`}>diagnose</a></> : outbox.status === 'simulated' ? <>✅ Accepted (this instance simulates sending — <a href={`/app/settings/email/outbox/${outbox.id}`} target="_blank">open the copy in the Outbox</a>)</> : <>✅ Accepted by Cloudflare Email Sending {fmtAgo(outbox.created_at)} — check your inbox for “Your first email from {pub.name}”.</>}</p>
            <p class="small">Sent from <code>{outbox.from_email}</code>. How inboxes authenticate it:</p>
            <ul class="list-plain stack-sm" data-auth-checks><li class="muted small">Checking SPF, DKIM and DMARC…</li></ul>
          </div>
        ) : <p class="small muted">Send the test first — this shows delivery status and your SPF / DKIM / DMARC results.</p>}
      </section>

      <section style={card} data-step="contacts" id="contacts">
        <strong>{p.next_choice ? '✓ ' : ''}5. Bring in your readers</strong>
        <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
          <form method="post" action="/app/start/finish" class="inline-form"><input type="hidden" name="next" value="import" /><Btn kind="secondary">Import contacts (CSV)</Btn></form>
          <form method="post" action="/app/start/finish" class="inline-form"><input type="hidden" name="next" value="form" /><Btn kind="secondary">Connect a signup form</Btn></form>
          <form method="post" action="/app/start/finish" class="inline-form"><input type="hidden" name="next" value="skip" /><Btn kind="ghost" attrs={{ 'data-finish': '' }}>Go to my dashboard</Btn></form>
        </div>
        {median?.m ? <p class="small muted" style="margin-top:10px">Typical time from signup to first email on this platform: {dur(median.m)}.</p> : null}
      </section>

      <script dangerouslySetInnerHTML={{ __html: `(function(){
var ck=document.querySelector('[data-ttfs-clock]');if(ck){var s=+ck.getAttribute('data-start');setInterval(function(){var t=Math.max(0,Math.round((Date.now()-s)/1000));ck.textContent=t<60?t+'s':Math.floor(t/60)+'m '+String(t%60).padStart(2,'0')+'s'},1000)}
var dl=document.querySelector('[data-dns-live]');if(dl){var run=function(){fetch(dl.getAttribute('data-dns-live'),{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(j){(j.checks||[]).forEach(function(k){var el=document.querySelector('[data-rec-status="'+k.key+'"]');if(el){el.className=k.ok?'':'muted';el.textContent=k.ok?'✅ found':'⏳ not yet'+(k.note?' — '+k.note:'')}})}).catch(function(){})};run();setInterval(run,10000)}
var ar=document.querySelector('[data-auth-checks]');if(ar){fetch('/app/start/auth.json',{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(j){ar.innerHTML='';(j.checks||[]).forEach(function(k){var li=document.createElement('li');li.setAttribute('data-auth',k.key);li.innerHTML='<strong>'+(k.ok?'✅ ':'⚠️ ')+k.key.toUpperCase()+(k.ok?' passes':' not set up')+'</strong> <span class="muted small">('+k.host+')</span><div class="small">'+k.meaning+'</div>'+(k.ok?'':'<div class="small"><strong>Fix:</strong> '+k.fix+'</div>');ar.appendChild(li)});if(j.note){var n=document.createElement('li');n.className='small muted';n.textContent=j.note;ar.appendChild(n)}}).catch(function(){ar.innerHTML='<li class="small muted">Couldn’t reach DNS right now.</li>'})}
})();` }} />
    </PlainLayout>,
  );
});

function fmtAgo(t: number) { const s = Math.round((now() - t) / 1000); return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`; }

dash.post('/sender', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  await progress(c);
  if (f.choice === 'domain') {
    const host = str(f.hostname, 253).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^.*@/, '').replace(/\.$/, '');
    if (!HOST_RE.test(host)) return back(c, '/app/start#sender', 'Enter a domain like example.com', 'err');
    if (host === sharedDomain(c.env)) return back(c, '/app/start#sender', 'That’s the shared sender’s domain — pick “Shared sender” instead.', 'err');
    let d = await one<any>(c.env, `SELECT * FROM domains WHERE hostname = ?`, host);
    if (d && d.pub_id !== pub.id) return back(c, '/app/start#sender', 'That domain is connected to another publication.', 'err');
    if (!d) {
      const did = id();
      await insert(c.env, 'domains', { id: did, pub_id: pub.id, hostname: host, kind: 'email', status: 'pending', verify_token: token(16), created_at: now() });
      d = { id: did };
      await audit(c, 'domains.added', host, { kind: 'email', via: 'onboarding' });
    }
    // newsletters send as newsletter@<domain> once it verifies (the shared sender is used until then)
    if (!(await one(c.env, `SELECT 1 FROM sender_addresses WHERE pub_id = ? AND email = ?`, pub.id, `newsletter@${host}`))) {
      await run(c.env, `UPDATE sender_addresses SET is_default = 0 WHERE pub_id = ? AND purpose = 'newsletter'`, pub.id);
      await insert(c.env, 'sender_addresses', { id: id(), pub_id: pub.id, email: `newsletter@${host}`, name: pub.from_name || pub.name, purpose: 'newsletter', is_default: 1, created_at: now() });
    }
    await run(c.env, `UPDATE onboarding_progress SET sender_choice = 'domain', domain_id = ?, updated_at = ? WHERE pub_id = ?`, d.id, now(), pub.id);
    return back(c, '/app/start#sender', `${host} added — add the DNS records below. Meanwhile your test goes out from the shared sender.`);
  }
  await run(c.env, `UPDATE onboarding_progress SET sender_choice = 'shared', updated_at = ? WHERE pub_id = ?`, now(), pub.id);
  return c.redirect('/app/start#test', 303);
});

dash.post('/test', async (c) => {
  const pub = c.get('pub');
  const p = await progress(c);
  const f = await form(c.req);
  const v = await validateEmail(str(f.to, 254));
  if (!v.ok) return back(c, '/app/start#test', v.reason || 'Invalid email', 'err');
  if (!p.sender_choice) await run(c.env, `UPDATE onboarding_progress SET sender_choice = 'shared' WHERE pub_id = ?`, pub.id);
  const from = await senderFor(c.env, pub, 'newsletter');
  const t = now();
  const res = await sendTransactional(c.env, v.email, `Your first email from ${pub.name}`,
    `<p>🎉 It works! This is the first email from <strong>${esc(pub.name)}</strong>, sent from <code>${esc(from.email)}</code>.</p><p>It was signed with DKIM and sent from a domain with SPF and DMARC, so inboxes can verify it really came from you. Go back to the setup page to see exactly how it was authenticated.</p><p style="color:#6b7280;font-size:13px">Sent ${new Date(t).toUTCString()}</p>`, pub, from);
  const ob = await one<{ id: string }>(c.env, 'SELECT id FROM outbox WHERE to_email = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1', v.email, t - 1000);
  await run(c.env, `UPDATE onboarding_progress SET test_to = ?, test_outbox_id = ?, test_status = ?, first_send_at = CASE WHEN ? THEN COALESCE(first_send_at, ?) ELSE first_send_at END, updated_at = ? WHERE pub_id = ?`,
    v.email, ob?.id ?? null, res.status, res.ok ? 1 : 0, t, now(), pub.id);
  return back(c, '/app/start#arrived', res.ok ? `Test email ${res.status === 'simulated' ? 'simulated' : 'sent'} to ${v.email}` : `Send failed: ${res.error}`, res.ok ? 'ok' : 'err');
});

dash.get('/auth.json', async (c) => {
  const pub = c.get('pub');
  const p = await progress(c);
  const ob = p.test_outbox_id ? await one<any>(c.env, 'SELECT from_email FROM outbox WHERE id = ?', p.test_outbox_id) : null;
  const fromEmail = (ob?.from_email || '').match(/<([^>]+)>/)?.[1] || (await senderFor(c.env, pub, 'newsletter')).email;
  const host = fromEmail.split('@')[1] || sharedDomain(c.env);
  const checks = await authChecks(host);
  const shared = host === sharedDomain(c.env);
  return c.json({ host, shared, checks, note: shared ? 'This is the shared sender’s domain — the platform maintains these records for you.' : null });
});

dash.get('/status.json', async (c) => {
  const p = await progress(c);
  const ob = p.test_outbox_id ? await one<any>(c.env, 'SELECT status, error, created_at FROM outbox WHERE id = ?', p.test_outbox_id) : null;
  return c.json({ started_at: p.started_at, first_send_at: p.first_send_at, ttfs_ms: p.first_send_at ? p.first_send_at - p.started_at : null, sender: p.sender_choice, test: ob, completed: !!p.completed_at });
});

dash.post('/finish', async (c) => {
  const pub = c.get('pub');
  await progress(c);
  const f = await form(c.req);
  const next = ['import', 'form', 'skip'].includes(f.next) ? f.next : 'skip';
  await run(c.env, `UPDATE onboarding_progress SET next_choice = ?, completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE pub_id = ?`, next, now(), now(), pub.id);
  return c.redirect(next === 'import' ? '/app/audience/imports' : next === 'form' ? '/app/audience/forms' : '/app', 303);
});

export async function onboardingStats(env: Env) {
  return all<any>(env, 'SELECT first_send_at - started_at AS ms FROM onboarding_progress WHERE first_send_at IS NOT NULL ORDER BY updated_at DESC LIMIT 100');
}

export default { dash } satisfies Module;
