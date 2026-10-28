/** @jsxImportSource hono/jsx */
// Settings → Transactional email: message log (search, status, opens/clicks), templates, and API usage.
// Root: /t/x/o/:id.gif (open pixel), /t/x/c/:id/:n (click redirect) for messages sent with "track": true.
import { Hono } from 'hono';
import type { Hono as HonoT } from 'hono';
import type { AppEnv } from '../../types';
import { one, all, run } from '../../lib/db';
import { requirePerm, audit } from '../../lib/auth';
import { searchTx, saveTemplate, sendTx, cancelTx, txOpen, txClick, TxError, TX_DAILY, TX_PER_MINUTE_PER_KEY, TX_BATCH_MAX, TX_BATCHES_PER_MINUTE_PER_KEY } from '../../lib/transactional';
import { attemptsFor } from '../../lib/email';
import { loadThrottles, holdReason } from '../../lib/throttle';
import { form, str, ago, fmtDateTime, parseJSON, num } from '../../lib/util';
import { Card, Field, Input, Textarea, Select, Btn, ActionForm, Table, Badge, Status, Grid, Help, Code, Tabs, back } from '../../ui/components';
import { page } from './ui';

export const txRoot = new Hono<AppEnv>();
const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (ch) => ch.charCodeAt(0));
txRoot.get('/t/x/o/:file', async (c) => {
  const mid = c.req.param('file').replace(/\.gif$/, '');
  const task = txOpen(c.env, mid, c.req.header('user-agent') || '').catch(() => {});
  try { c.executionCtx.waitUntil(task); } catch { await task; }
  return new Response(GIF, { headers: { 'content-type': 'image/gif', 'cache-control': 'no-store, max-age=0' } });
});
txRoot.get('/t/x/c/:id/:n', async (c) => {
  const url = await txClick(c.env, c.req.param('id'), Number(c.req.param('n')) || 0, c.req.header('user-agent') || '');
  return url ? c.redirect(url, 302) : c.text('Link not found', 404);
});

const STATUSES: Array<[string, string]> = [['', 'All statuses'], ['sent', 'Sent'], ['simulated', 'Simulated'], ['scheduled', 'Scheduled'], ['queued', 'Queued (sending stopped)'], ['deferred', 'Retrying'], ['failed', 'Failed'], ['suppressed', 'Suppressed'], ['bounced', 'Bounced'], ['complained', 'Complained'], ['expired', 'Expired'], ['cancelled', 'Cancelled']];
const tone = (s: string) => (s === 'sent' || s === 'simulated' ? 'green' : s === 'suppressed' || s === 'deferred' || s === 'queued' ? 'amber' : s === 'sending' || s === 'scheduled' ? 'blue' : s === 'cancelled' || s === 'expired' ? 'gray' : 'red') as any;
const stopBanner = async (c: any) => { const h = holdReason(await loadThrottles(c.env), c.get('pub').workspace_id); return h ? <div class="callout danger" data-stop-banner="tx">{h} <a href="/app/sending">Sending controls</a></div> : null; };

export function registerTransactional(dash: HonoT<AppEnv>) {
  dash.get('/transactional', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const q = c.req.query();
    const tab = q.tab === 'templates' ? 'templates' : q.tab === 'api' ? 'api' : 'messages';
    const tabNav = <Tabs active={`/app/settings/transactional?tab=${tab}`} items={[['/app/settings/transactional?tab=messages', 'Messages'], ['/app/settings/transactional?tab=templates', 'Templates'], ['/app/settings/transactional?tab=api', 'API & limits']]} />;
    const app = c.env.APP_URL.replace(/\/$/, '');
    if (tab === 'templates') {
      const rows = await all<any>(c.env, 'SELECT * FROM tx_templates WHERE pub_id = ? ORDER BY updated_at DESC', pub.id);
      const edit = q.edit ? rows.find((t) => t.id === q.edit) : null;
      return page(c, 'transactional', 'Transactional email', (
        <>
          {tabNav}
          <Card title="Templates" pad={false}>
            <Table rows={rows} empty="No templates yet." cols={[
              { h: 'Name', r: (t) => <a href={`/app/settings/transactional?tab=templates&edit=${t.id}`}>{t.name}</a> },
              { h: 'template_id', r: (t) => <code>{t.slug}</code> },
              { h: 'Subject', r: (t) => t.subject },
              { h: 'Format', r: (t) => t.format },
              { h: 'Updated', r: (t) => ago(t.updated_at) },
              { h: '', class: 'right', r: (t) => <ActionForm action={`/app/settings/transactional/templates/${t.id}/delete`} label="Delete" kind="ghost" small confirm="Delete this template? API calls using it will fail." /> },
            ]} />
          </Card>
          <Card title={edit ? `Edit “${edit.name}”` : 'New template'}>
            <form method="post" action="/app/settings/transactional/templates" class="stack-sm">
              {edit && <input type="hidden" name="id" value={edit.id} />}
              <Grid cols={3}>
                <Field label="Name"><Input name="name" value={edit?.name} required /></Field>
                <Field label="template_id (slug)" hint="Used in API calls."><Input name="slug" value={edit?.slug} placeholder="order-receipt" /></Field>
                <Field label="Format"><Select name="format" value={edit?.format || 'markdown'} options={[['markdown', 'Markdown'], ['html', 'HTML']]} /></Field>
              </Grid>
              <Field label="Subject" hint="Merge tags work here too, e.g. Your order {{order.id}}"><Input name="subject" value={edit?.subject} required /></Field>
              <Field label="Body" hint="Use {{merge_vars}} from the API call (nested keys with dots: {{order.total}}), plus {{subscriber.first_name}} and {{publication.name}}. HTML without an <html> tag is wrapped in a simple branded layout.">
                <Textarea name="body" value={edit?.body} rows={12} required />
              </Field>
              <div class="row end">{edit && <a class="btn btn-ghost" href="/app/settings/transactional?tab=templates">Cancel</a>}<Btn>{edit ? 'Save template' : 'Create template'}</Btn></div>
            </form>
          </Card>
          {rows.length > 0 && (
            <Card title="Send a test">
              <form method="post" action="/app/settings/transactional/test" class="row">
                <Select name="template_id" options={rows.map((t) => [t.slug, t.name] as [string, string])} />
                <Input name="to" type="email" value={c.get('user').email} required />
                <Input name="merge_vars" placeholder='{"order": {"id": "1001"}}' />
                <Btn kind="secondary">Send test</Btn>
              </form>
            </Card>
          )}
        </>
      ));
    }
    if (tab === 'api') {
      return page(c, 'transactional', 'Transactional email', (
        <>
          {tabNav}
          <Card title="Send from your app">
            <p>Receipts, password resets, order updates: one recipient per call, authenticated with an API key from <a href="/app/settings/api">API keys</a>. Also available to AI clients as the MCP tool <code>send_transactional</code>.</p>
            <Code>{`curl ${app}/api/v2/publication/transactional/send \\
  -H "Authorization: Bearer $OPENHIVE_API_KEY" -H "Content-Type: application/json" \\
  -d '{"to": "reader@example.com", "template_id": "order-receipt",
       "merge_vars": {"order": {"id": "1001", "total": "$29.00"}},
       "tags": ["receipt"], "idempotency_key": "order-1001", "track": true}'`}</Code>
            <p class="small muted">Or pass <code>subject</code> with <code>html</code>, <code>markdown</code> or <code>text</code> instead of a template. Optional: <code>reply_to</code>, <code>from_name</code>, <code>attachments: [{"{"}filename, content (base64), type, content_id?{"}"}]</code> (5 MB total; with <code>content_id</code> an image is sent inline — reference it as <code>&lt;img src="cid:logo"&gt;</code>), <code>headers</code> (X-* plus List-Id, References, In-Reply-To, Thread-Index, Thread-Topic), <code>scheduled_at</code> (send later, up to 30 days) and <code>expires_at</code> (not delivered by then → expired, never sent). Responses include the message <code>id</code>; look it up with <code>GET /transactional/messages/:id</code>, see every attempt with <code>GET /deliveries/:id/attempts</code>, cancel a scheduled one with <code>POST /transactional/messages/:id/cancel</code>.</p>
          </Card>
          <Card title="Batch sending">
            <p>Send up to {TX_BATCH_MAX} messages per call with <code>POST /transactional/batch</code> and <code>{"{"}"messages": [...]{"}"}</code>. Each message is validated and sent on its own (with its own <code>idempotency_key</code>); the response lists a result per message in the same order (HTTP 207 when some failed).</p>
          </Card>
          <Card title="Rules">
            <ul>
              <li>Sent as transactional mail from your transactional sender (Settings → Email). Newsletter unsubscribes don't block it; hard bounces, complaints about transactional mail, and manual transactional suppressions do.</li>
              <li>Does not use your plan's monthly newsletter emails. Limits: {TX_PER_MINUTE_PER_KEY} per minute per API key, and {num(TX_DAILY.free)} per 24 hours on Free / {num(TX_DAILY.paid)} on paid plans. Nothing sends while sending is suspended.</li>
              <li>A repeated <code>idempotency_key</code> (or <code>Idempotency-Key</code> header) returns the original message instead of sending again.</li>
              <li>Batch calls: {TX_BATCHES_PER_MINUTE_PER_KEY} per minute per API key (each message still counts toward the daily cap).</li>
              <li>Transactional mail has its own top-priority queue: scheduled messages and retries never wait behind newsletter batches. Temporary provider errors are retried with backoff (up to 5 attempts, never past <code>expires_at</code>). If sending is stopped (emergency stop), messages wait as "queued" and go out on resume.</li>
              <li>Opens and clicks are tracked only when you pass <code>"track": true</code>.</li>
            </ul>
          </Card>
        </>
      ));
    }
    const rows = await searchTx(c.env, pub.id, { q: q.q, status: q.status, tag: q.tag, limit: 100 });
    const day = await one<any>(c.env, `SELECT COUNT(*) AS n, SUM(CASE WHEN status IN ('sent','simulated') THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened FROM tx_messages WHERE pub_id = ? AND created_at > ?`, pub.id, Date.now() - 86400000);
    const banner = await stopBanner(c);
    return page(c, 'transactional', 'Transactional email', (
      <>
        {banner}
        {tabNav}
        <Help>Last 24 hours: {num(day?.n || 0)} sent · {num(day?.ok || 0)} delivered to the provider · {num(day?.opened || 0)} opened (tracked messages only).</Help>
        <Card pad={false} title={
          <form method="get" class="row">
            <Input name="q" value={q.q} placeholder="Search recipient, subject, message id" />
            <Select name="status" value={q.status} options={STATUSES} autosubmit />
            <Input name="tag" value={q.tag} placeholder="tag" />
            <Btn kind="secondary" small>Search</Btn>
          </form>
        }>
          <Table rows={rows} empty="No transactional messages yet. Send one with the API (see API & limits)." cols={[
            { h: 'Sent', r: (m) => <span class="nowrap">{fmtDateTime(m.created_at, pub.timezone)}{m.scheduled_at && m.status === 'scheduled' ? <div class="small muted">for {fmtDateTime(m.scheduled_at, pub.timezone)}</div> : null}</span> },
            { h: 'To', r: (m) => <a href={`/app/settings/transactional/m/${m.id}`}>{m.to_email}</a> },
            { h: 'Subject', r: (m) => m.subject },
            { h: 'Status', r: (m) => <Badge tone={tone(m.status)}>{m.status}</Badge> },
            { h: 'Opens', r: (m) => (m.track ? num(m.open_count) : '—') },
            { h: 'Clicks', r: (m) => (m.track ? num(m.click_count) : '—') },
            { h: 'Tags', r: (m) => parseJSON<string[]>(m.tags, []).map((t) => <Badge>{t}</Badge>) },
          ]} />
        </Card>
      </>
    ));
  });

  dash.get('/transactional/m/:id', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const m = await one<any>(c.env, 'SELECT * FROM tx_messages WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!m) return c.notFound();
    const ob = m.message_id ? await one<any>(c.env, 'SELECT html, from_email, headers FROM outbox WHERE message_id = ? AND pub_id = ?', m.message_id, pub.id) : null;
    const tpl = m.template_id ? await one<any>(c.env, 'SELECT name FROM tx_templates WHERE id = ?', m.template_id) : null;
    const attempts = await attemptsFor(c.env, m.id);
    const files = parseJSON<any[]>(m.attachments_meta, []);
    const hdrs = Object.entries(parseJSON<Record<string, string>>(m.headers, {}));
    return page(c, 'transactional', 'Transactional message', (
      <>
        <p><a href="/app/settings/transactional">← All messages</a></p>
        <Card title={m.subject}>
          <dl class="kv">
            <dt>To</dt><dd>{m.to_email}</dd>
            {ob && <><dt>From</dt><dd>{ob.from_email}</dd></>}
            <dt>Status</dt><dd><Badge tone={tone(m.status)}>{m.status}</Badge> {m.error && <small class="muted">{m.error}</small>}</dd>
            <dt>Message id</dt><dd><code>{m.id}</code>{m.message_id && <> · provider <code>{m.message_id}</code></>}</dd>
            {tpl && <><dt>Template</dt><dd>{tpl.name}</dd></>}
            <dt>Tracking</dt><dd>{m.track ? `${num(m.open_count)} opens${m.opened_at ? ` (first ${ago(m.opened_at)})` : ''} · ${num(m.click_count)} clicks` : 'off'}</dd>
            {m.idempotency_key && <><dt>Idempotency key</dt><dd><code>{m.idempotency_key}</code></dd></>}
            <dt>Created</dt><dd>{fmtDateTime(m.created_at, pub.timezone)}</dd>
            {m.scheduled_at && <><dt>Scheduled for</dt><dd>{fmtDateTime(m.scheduled_at, pub.timezone)}</dd></>}
            {m.expires_at && <><dt>Expires</dt><dd>{fmtDateTime(m.expires_at, pub.timezone)}</dd></>}
            {m.sent_at && <><dt>Handed to provider</dt><dd>{fmtDateTime(m.sent_at, pub.timezone)}</dd></>}
            {files.length > 0 && <><dt>Attachments</dt><dd>{files.map((f) => <div>{f.filename} <small class="muted">{f.type}{f.content_id ? ` · inline cid:${f.content_id}` : ''} · {num(f.bytes)} bytes</small></div>)}</dd></>}
            {hdrs.length > 0 && <><dt>Custom headers</dt><dd>{hdrs.map(([k, v]) => <div><code>{k}: {v}</code></div>)}</dd></>}
          </dl>
          {['scheduled', 'queued', 'deferred'].includes(m.status) && <ActionForm action={`/app/settings/transactional/m/${m.id}/cancel`} label="Cancel message" kind="ghost" confirm="Cancel this message? It won't be sent." />}
        </Card>
        <Card title={`Delivery attempts (${attempts.length})`} pad={false}>
          <Table rows={attempts} empty={m.status === 'scheduled' ? 'Not attempted yet — scheduled.' : 'No attempts recorded.'} cols={[
            { h: '#', r: (a) => num(a.attempt) },
            { h: 'When', r: (a) => <span class="nowrap">{fmtDateTime(a.created_at, pub.timezone)}</span> },
            { h: 'Result', r: (a) => <Badge tone={tone(a.status)}>{a.status}</Badge> },
            { h: 'Provider response', r: (a) => <code class="small" data-attempt-response>{a.response || '—'}</code> },
            { h: 'Duration', r: (a) => `${num(a.duration_ms)} ms`, class: 'right' },
          ]} />
        </Card>
        {ob?.html && <Card title="Content"><iframe sandbox="" srcdoc={ob.html} style="width:100%;height:520px;border:1px solid var(--line,#e5e7eb);border-radius:8px;background:#fff" title="Email preview" /></Card>}
      </>
    ));
  });

  dash.post('/transactional/m/:id/cancel', requirePerm('admin'), async (c) => {
    try {
      await cancelTx(c.env, c.get('pub').id, c.req.param('id'));
      await audit(c, 'transactional.cancel', c.req.param('id'));
      return back(c, `/app/settings/transactional/m/${c.req.param('id')}`, 'Message cancelled.');
    } catch (e: any) {
      return back(c, `/app/settings/transactional/m/${c.req.param('id')}`, e instanceof TxError ? e.message : 'Could not cancel.', 'err');
    }
  });

  dash.post('/transactional/templates', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const f = await form(c.req);
    try {
      const tid = await saveTemplate(c.env, pub.id, { id: str(f.id, 40) || undefined, name: str(f.name, 120), slug: str(f.slug, 60), subject: str(f.subject, 300), body: str(f.body, 200_000), format: str(f.format, 10) });
      await audit(c, f.id ? 'transactional.template.update' : 'transactional.template.create', tid);
      return back(c, '/app/settings/transactional?tab=templates', 'Template saved.');
    } catch (e: any) {
      return back(c, '/app/settings/transactional?tab=templates', e instanceof TxError ? e.message : 'Could not save the template.', 'err');
    }
  });

  dash.post('/transactional/templates/:id/delete', requirePerm('admin'), async (c) => {
    await run(c.env, 'DELETE FROM tx_templates WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
    await audit(c, 'transactional.template.delete', c.req.param('id'));
    return back(c, '/app/settings/transactional?tab=templates', 'Template deleted.');
  });

  dash.post('/transactional/test', requirePerm('admin'), async (c) => {
    const f = await form(c.req);
    let vars: Record<string, unknown> = {};
    try { vars = f.merge_vars ? JSON.parse(String(f.merge_vars)) : {}; } catch { return back(c, '/app/settings/transactional?tab=templates', 'Merge vars must be JSON.', 'err'); }
    try {
      const r = await sendTx(c.env, c.get('pub'), { to: str(f.to, 254), template_id: str(f.template_id, 80), merge_vars: vars, tags: ['test'] });
      return back(c, '/app/settings/transactional', `Test ${r.status}: ${r.to}`);
    } catch (e: any) {
      return back(c, '/app/settings/transactional?tab=templates', e instanceof TxError ? e.message : 'Send failed.', 'err');
    }
  });
}
