/** @jsxImportSource hono/jsx */
import type { Hono } from 'hono';
import type { AppEnv, Ctx } from '../../types';
import { one, all, run, insert } from '../../lib/db';
import { requirePerm, audit } from '../../lib/auth';
import { siteUrl, settings } from '../../lib/pub';
import { WEBHOOK_EVENTS } from '../../lib/events';
import { attemptDelivery, createTestDelivery, buildPayload, WEBHOOK_VERSIONS, LATEST_WEBHOOK_VERSION, isWebhookVersion } from '../../lib/webhooks';
import { PROVIDERS } from '../../lib/integrations';
import { id, now, token, sha256, form, str, ago, fmtDateTime, parseJSON } from '../../lib/util';
import { Card, Field, Input, Select, Btn, ActionForm, Table, Badge, Status, Modal, OpenBtn, Grid, Help, Copy, Code, Toggle, back } from '../../ui/components';
import { page, saveSettings } from './ui';

const mask = (s: string) => (s ? s.slice(0, 4) + '•'.repeat(Math.max(4, Math.min(16, s.length - 4))) : '');

export function registerDevelopers(dash: Hono<AppEnv>) {
  // ───────────── Integrations ─────────────
  dash.get('/integrations', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const rows = await all<any>(c.env, 'SELECT * FROM integrations WHERE pub_id = ?', pub.id);
    const s = settings(pub);
    const base = siteUrl(c.env, pub);
    const app = c.env.APP_URL.replace(/\/$/, '');
    const cards = Object.entries(PROVIDERS).map(([key, p]) => {
      const row = rows.find((r) => r.provider === key);
      const cfg = parseJSON<Record<string, any>>(row?.config, {});
      if (key === 'google_analytics' && s.ga_measurement_id && !cfg.measurement_id) cfg.measurement_id = s.ga_measurement_id;
      if (key === 'discord' && s.discord) Object.assign(cfg, s.discord);
      const extra: Record<string, any> = {
        linktree: (
          <div class="stack-sm">
            <Field label="Link-in-bio page (paste into Linktree as a link)"><Copy value={`${base}/bio`} /></Field>
            <Field label="Subscribe page"><Copy value={`${base}/subscribe?utm_source=linktree&utm_medium=social`} /></Field>
            <Help>Every signup from these links is tagged with acquisition source and utm_source=linktree.</Help>
          </div>
        ),
        manychat: (
          <div class="stack-sm">
            <Help>In ManyChat add an <strong>External Request</strong> action: POST to the URL below with header <code>Authorization: Bearer &lt;API key&gt;</code> and JSON body <code>{'{"email": "{{email}}", "utm_source": "manychat"}'}</code>.</Help>
            <Copy value={`${app}/api/v2/publications/${pub.id}/subscriptions`} />
          </div>
        ),
        zapier: (
          <div class="stack-sm">
            <Field label="Inbound: create subscribers (POST, Bearer API key)"><Copy value={`${app}/api/v2/publications/${pub.id}/subscriptions`} /></Field>
            <Help>Outbound: add your Zap/Make "catch hook" URL under <a href="/app/settings/webhooks">Webhooks</a> and pick events. Full reference in the <a href="/docs/api" target="_blank">API docs</a>.</Help>
          </div>
        ),
        discord: (
          <Field label="Tier → role mapping" hint="One per line: tier_id=role_id (use 'premium' for any paid tier).">
            <textarea class="input" name="tier_roles" rows={3}>{Object.entries(cfg.tier_roles || {}).map(([k, v]) => `${k}=${v}`).join('\n')}</textarea>
          </Field>
        ),
      };
      return (
        <Card title={<span class="row">{p.name} {row?.active ? <Badge tone="green">connected</Badge> : <Badge>not connected</Badge>}</span>}>
          <p class="muted">{p.blurb}</p>
          <form method="post" action={`/app/settings/integrations/${key}`} class="stack-sm">
            {p.fields.map((fd) => (
              <Field label={fd.label} hint={fd.hint}>
                <Input name={fd.key} type={fd.secret ? 'password' : 'text'} value={fd.secret ? '' : cfg[fd.key]} placeholder={fd.secret && cfg[fd.key] ? mask(cfg[fd.key]) + ' (saved — leave blank to keep)' : ''} attrs={{ autocomplete: 'off' }} />
              </Field>
            ))}
            {extra[key]}
            {(p.fields.length > 0 || key === 'discord') && (
              <div class="row end">
                {row && <Btn kind="ghost" name="disconnect" value="1" small>Disconnect</Btn>}
                {row && (key === 'hubspot' || key === 'meta') && <Btn kind="secondary" name="test" value="1" small>Send test</Btn>}
                <Btn small>{row ? 'Save' : 'Connect'}</Btn>
              </div>
            )}
          </form>
        </Card>
      );
    });
    return page(c, 'integrations', 'Integrations', <Grid>{cards}</Grid>);
  });

  dash.post('/integrations/:provider', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const key = c.req.param('provider');
    const p = PROVIDERS[key];
    if (!p) return back(c, '/app/settings/integrations', 'Unknown integration', 'err');
    const f = await form(c.req);
    const row = await one<any>(c.env, 'SELECT * FROM integrations WHERE pub_id = ? AND provider = ?', pub.id, key);
    if (f.disconnect) {
      await run(c.env, 'DELETE FROM integrations WHERE pub_id = ? AND provider = ?', pub.id, key);
      if (key === 'google_analytics') await saveSettings(c, { ga_measurement_id: undefined });
      if (key === 'discord') await saveSettings(c, { discord: undefined });
      await audit(c, 'integrations.disconnected', key);
      return back(c, '/app/settings/integrations', `${p.name} disconnected`);
    }
    const old = parseJSON<Record<string, any>>(row?.config, {});
    const cfg: Record<string, any> = { ...old };
    for (const fd of p.fields) {
      const v = str(f[fd.key], 500);
      if (v || !fd.secret) cfg[fd.key] = v;
    }
    if (key === 'discord') {
      const map: Record<string, string> = {};
      for (const line of String(f.tier_roles || '').split(/\n/)) { const [a, b] = line.split('=').map((x) => x.trim()); if (a && b) map[a] = b; }
      cfg.tier_roles = map;
      await saveSettings(c, { discord: { guild_id: cfg.guild_id, bot_token: cfg.bot_token, tier_roles: map } });
    }
    if (key === 'google_analytics') {
      if (cfg.measurement_id && !/^G-[A-Z0-9]{4,}$/i.test(cfg.measurement_id)) return back(c, '/app/settings/integrations', 'GA4 measurement IDs look like G-XXXXXXXXXX', 'err');
      await saveSettings(c, { ga_measurement_id: cfg.measurement_id || undefined });
    }
    if (f.test) {
      const { pushHubspot, pushMetaLead } = await import('../../lib/integrations');
      try {
        if (key === 'hubspot') await pushHubspot(c.env, cfg, c.get('user').email, c.get('user').name);
        if (key === 'meta') await pushMetaLead(c.env, cfg, c.get('user').email, siteUrl(c.env, pub));
        return back(c, '/app/settings/integrations', `${p.name} test succeeded`);
      } catch (e: any) {
        return back(c, '/app/settings/integrations', `${p.name} test failed: ${e.message}`, 'err');
      }
    }
    await run(c.env, `INSERT INTO integrations (id, pub_id, provider, config, active, created_at) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(pub_id, provider) DO UPDATE SET config = excluded.config, active = 1`, id(), pub.id, key, JSON.stringify(cfg), now());
    await audit(c, 'integrations.saved', key);
    return back(c, '/app/settings/integrations', `${p.name} saved`);
  });

  // ───────────── API keys ─────────────
  async function apiPage(c: Ctx, newKey?: string) {
    const pub = c.get('pub');
    const keys = await all<any>(c.env, 'SELECT k.*, u.name AS creator FROM api_keys k LEFT JOIN users u ON u.id = k.created_by WHERE k.pub_id = ? ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC', pub.id);
    const app = c.env.APP_URL.replace(/\/$/, '');
    return page(c, 'api', 'API keys & MCP', (
      <>
        {newKey && (
          <div class="callout ok">
            <strong>Your new API key</strong> — copy it now, it won't be shown again.
            <div style="margin-top:8px"><Copy value={newKey} /></div>
          </div>
        )}
        <Card title="API keys" actions={<OpenBtn target="#newkey" small>Create API key</OpenBtn>} pad={false}>
          <Table
            rows={keys}
            empty="No API keys yet."
            cols={[
              { h: 'Name', r: (k: any) => <strong>{k.name}</strong> },
              { h: 'Key', r: (k: any) => <code>{k.prefix}…</code> },
              { h: 'Created', r: (k: any) => <span class="muted">{ago(k.created_at)}{k.creator ? ` by ${k.creator}` : ''}</span> },
              { h: 'Last used', r: (k: any) => <span class="muted">{ago(k.last_used_at)}</span> },
              { h: 'Status', r: (k: any) => (k.revoked_at ? <Badge tone="red">revoked</Badge> : <Badge tone="green">active</Badge>) },
              { h: '', class: 'right', r: (k: any) => (k.revoked_at ? null : <ActionForm action={`/app/settings/api/${k.id}/revoke`} label="Revoke" kind="danger" confirm="Revoke this key? Integrations using it stop working immediately." />) },
            ]}
          />
        </Card>
        <Grid>
          <Card title="REST API">
            <p>Base URL <code>{app}/api/v2</code>. Authenticate with <code>Authorization: Bearer &lt;key&gt;</code>. Your publication id is <code>{pub.id}</code>.</p>
            <Code>{`curl ${app}/api/v2/publications/${pub.id}/subscriptions \\\n  -H "Authorization: Bearer oh_live_…" \\\n  -H "content-type: application/json" \\\n  -d '{"email":"reader@example.com","utm_source":"my-app"}'`}</Code>
            <a class="btn btn-secondary btn-sm" href="/docs/api" target="_blank">Read the API docs</a>
          </Card>
          <Card title="MCP server (Claude, ChatGPT & other AI tools)">
            <Field label="Server URL"><Copy value={`${app}/mcp`} /></Field>
            <Help>Add this as a remote MCP server (Streamable HTTP) and use an API key as the bearer token. In Claude: Settings → Connectors → Add custom connector. In Claude Code: <code>claude mcp add --transport http openhive {app}/mcp --header "Authorization: Bearer oh_live_…"</code>. The AI can then draft posts, report on opens/clicks/revenue, look up subscribers, build segments and automations, and more — scoped to this publication.</Help>
          </Card>
        </Grid>
        <Modal id="newkey" title="Create API key">
          <form method="post" action="/app/settings/api" class="stack">
            <Field label="Name" hint="Where will you use it? e.g. Zapier, website, Claude"><Input name="name" required autofocus /></Field>
            <div class="form-actions"><Btn>Create key</Btn></div>
          </form>
        </Modal>
      </>
    ));
  }

  dash.get('/api', requirePerm('admin'), (c) => apiPage(c));

  dash.post('/api', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const f = await form(c.req);
    const name = str(f.name, 80) || 'API key';
    const key = `oh_live_${token(24)}`;
    await insert(c.env, 'api_keys', { id: id(), pub_id: pub.id, name, key_hash: await sha256(key), prefix: key.slice(0, 14), created_by: c.get('user').id, created_at: now() });
    await audit(c, 'api_keys.created', name);
    return apiPage(c, key);
  });

  dash.post('/api/:id/revoke', requirePerm('admin'), async (c) => {
    await run(c.env, 'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND pub_id = ? AND revoked_at IS NULL', now(), c.req.param('id'), c.get('pub').id);
    await audit(c, 'api_keys.revoked', c.req.param('id'));
    return back(c, '/app/settings/api', 'Key revoked');
  });

  // ───────────── Webhooks ─────────────
  dash.get('/webhooks', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const hooks = await all<any>(
      c.env,
      `SELECT w.*, (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'failed') AS failed, (SELECT MAX(created_at) FROM webhook_deliveries d WHERE d.webhook_id = w.id) AS last FROM webhooks w WHERE w.pub_id = ? ORDER BY w.created_at`,
      pub.id,
    );
    return page(c, 'webhooks', 'Webhooks', (
      <>
        <Card title="Endpoints" actions={<OpenBtn target="#newhook" small>Add endpoint</OpenBtn>} pad={false}>
          <Table
            rows={hooks}
            empty="No endpoints yet. Webhooks notify your systems the moment something happens."
            rowHref={(h: any) => `/app/settings/webhooks/${h.id}`}
            cols={[
              { h: 'URL', r: (h: any) => <><a href={`/app/settings/webhooks/${h.id}`} class="mono small">{h.url}</a>{h.description && <div class="muted small">{h.description}</div>}</> },
              { h: 'Events', r: (h: any) => { const ev = parseJSON<string[]>(h.events, ['*']); return ev.includes('*') ? <Badge tone="purple">all events</Badge> : <span class="muted small">{ev.length} events</span>; } },
              { h: 'Version', r: (h: any) => <><code class="small">{h.version}</code>{h.version !== LATEST_WEBHOOK_VERSION && <> <Badge tone="amber">upgrade available</Badge></>}</> },
              { h: 'Status', r: (h: any) => (h.active ? <Badge tone="green">enabled</Badge> : <Badge>disabled</Badge>) },
              { h: 'Failed', r: (h: any) => (h.failed ? <Badge tone="red">{h.failed}</Badge> : <span class="muted">0</span>) },
              { h: 'Last delivery', r: (h: any) => <span class="muted">{ago(h.last)}</span> },
            ]}
          />
        </Card>
        <VersionsCard />
        <Card title="Verifying signatures">
          <p>Every request has <code>openhive-signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code> where <code>v1 = HMAC_SHA256(secret, t + "." + rawBody)</code>, plus <code>openhive-event</code>, <code>openhive-delivery</code> and <code>openhive-version</code> headers. Failed deliveries are retried with backoff for ~2 days.</p>
          <Code>{`import crypto from 'node:crypto';\nfunction verify(secret, header, rawBody) {\n  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));\n  const expected = crypto.createHmac('sha256', secret).update(t + '.' + rawBody).digest('hex');\n  return Math.abs(Date.now() / 1000 - t) < 300 && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));\n}`}</Code>
        </Card>
        <Modal id="newhook" title="Add webhook endpoint" wide><HookForm action="/app/settings/webhooks" /></Modal>
      </>
    ));
  });

  dash.post('/webhooks', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const f = await form(c.req);
    const v = hookInput(f);
    if (typeof v === 'string') return back(c, '/app/settings/webhooks', v, 'err');
    const wid = id();
    await insert(c.env, 'webhooks', { id: wid, pub_id: pub.id, url: v.url, description: v.description, events: JSON.stringify(v.events), secret: `whsec_${token(24)}`, version: v.version, active: 1, created_at: now() });
    await audit(c, 'webhooks.created', v.url);
    return back(c, `/app/settings/webhooks/${wid}`, 'Endpoint created');
  });

  dash.get('/webhooks/:id', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const h = await one<any>(c.env, 'SELECT * FROM webhooks WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!h) return back(c, '/app/settings/webhooks', 'Not found', 'err');
    const filter = c.req.query('status') || '';
    const deliveries = await all<any>(c.env, `SELECT * FROM webhook_deliveries WHERE webhook_id = ? ${filter ? 'AND status = ?' : ''} ORDER BY created_at DESC LIMIT 100`, h.id, ...(filter ? [filter] : []));
    const attempts = deliveries.length
      ? await all<any>(c.env, `SELECT * FROM webhook_delivery_attempts WHERE delivery_id IN (${deliveries.map(() => '?').join(',')}) ORDER BY attempt, created_at`, ...deliveries.map((d) => d.id))
      : [];
    const attemptsOf = (did: string) => attempts.filter((a) => a.delivery_id === did);
    const outdated = h.version !== LATEST_WEBHOOK_VERSION;
    return page(c, 'webhooks', 'Webhook endpoint', (
      <>
        {outdated && (
          <div class="callout warn row">
            <span class="grow">This endpoint is pinned to payload version <code>{h.version}</code>. Version <code>{LATEST_WEBHOOK_VERSION}</code> is available — compare the payloads below, update your receiver, then upgrade. You can switch back any time.</span>
            <ActionForm action={`/app/settings/webhooks/${h.id}/version`} fields={{ version: LATEST_WEBHOOK_VERSION }} label={`Upgrade to ${LATEST_WEBHOOK_VERSION}`} kind="primary" confirm={`Upgrade this endpoint to ${LATEST_WEBHOOK_VERSION}? New deliveries will use the new payload shape.`} />
          </div>
        )}
        <Card title={<span class="mono small">{h.url}</span>} actions={<div class="row">
          <ActionForm action={`/app/settings/webhooks/${h.id}/test`} label="Send test event" kind="primary" />
          <ActionForm action={`/app/settings/webhooks/${h.id}/toggle`} label={h.active ? 'Disable' : 'Enable'} />
          <ActionForm action={`/app/settings/webhooks/${h.id}/delete`} label="Delete" kind="danger" confirm="Delete this endpoint and its delivery log?" />
        </div>}>
          <Field label="Signing secret">
            <div class="copy"><input class="input mono" type="password" readonly value={h.secret} id="secret" /><button type="button" class="btn btn-secondary btn-sm" onclick="var i=document.getElementById('secret');i.type=i.type==='password'?'text':'password'">Reveal</button><button type="button" class="btn btn-secondary btn-sm" data-copy={h.secret}>Copy</button></div>
          </Field>
          <ActionForm action={`/app/settings/webhooks/${h.id}/rotate`} label="Rotate secret" confirm="Rotate the secret? Update your receiver right away." />
          <hr />
          <HookForm action={`/app/settings/webhooks/${h.id}`} h={h} />
        </Card>
        <Card title="Delivery log" actions={<form method="get" class="row"><Select name="status" value={filter} autosubmit options={[['', 'All'], ['success', 'Succeeded'], ['failed', 'Failed'], ['retrying', 'Retrying'], ['pending', 'Pending']]} /></form>} pad={false}>
          <Table
            rows={deliveries}
            empty="No deliveries yet. Send a test event."
            cols={[
              { h: 'When', r: (d: any) => <span class="nowrap">{fmtDateTime(d.created_at, pub.timezone)}</span> },
              { h: 'Event', r: (d: any) => <code class="small">{d.event}</code> },
              { h: 'Status', r: (d: any) => <><Status s={d.status} /> {d.response_code ? <code class="small">HTTP {d.response_code}</code> : null}</> },
              { h: 'Version', r: (d: any) => <code class="small">{parseJSON<any>(d.payload, {}).version || '—'}</code> },
              { h: 'Attempts', r: (d: any) => d.attempts },
              { h: 'Details', r: (d: any) => (
                <details><summary class="muted small">payload & attempts</summary>
                  <pre class="small" style="white-space:pre-wrap;max-width:520px">{JSON.stringify(parseJSON(d.payload, {}), null, 2)}</pre>
                  <div class="muted small">Attempts:</div>
                  {attemptsOf(d.id).length ? (
                    <ol class="small" style="max-width:520px;padding-left:18px">
                      {attemptsOf(d.id).map((a) => (
                        <li style="margin-bottom:6px">
                          <span class="nowrap">{fmtDateTime(a.created_at, pub.timezone)}</span> · {a.response_code ? <code>HTTP {a.response_code}</code> : <code>no response</code>} · {a.duration_ms} ms{a.manual ? ' · manual' : ''}
                          <pre class="small" style="white-space:pre-wrap;margin:2px 0 0">{a.error || a.response_body || '—'}</pre>
                        </li>
                      ))}
                    </ol>
                  ) : <pre class="small" style="white-space:pre-wrap;max-width:520px">{d.response_body || '—'}</pre>}
                </details>
              ) },
              { h: '', class: 'right', r: (d: any) => (d.status === 'success' ? null : <ActionForm action={`/app/settings/webhooks/${h.id}/retry/${d.id}`} label="Retry now" />) },
            ]}
          />
        </Card>
        <VersionsCard current={h.version} />
      </>
    ));
  });

  dash.post('/webhooks/:id/version', requirePerm('admin'), async (c) => {
    const f = await form(c.req);
    if (!isWebhookVersion(f.version)) return back(c, `/app/settings/webhooks/${c.req.param('id')}`, 'Unknown payload version', 'err');
    await run(c.env, 'UPDATE webhooks SET version = ? WHERE id = ? AND pub_id = ?', f.version, c.req.param('id'), c.get('pub').id);
    await audit(c, 'webhooks.version_changed', c.req.param('id'), { version: f.version });
    return back(c, `/app/settings/webhooks/${c.req.param('id')}`, `Endpoint now receives version ${f.version} payloads`);
  });

  dash.post('/webhooks/:id', requirePerm('admin'), async (c) => {
    const f = await form(c.req);
    const v = hookInput(f);
    if (typeof v === 'string') return back(c, `/app/settings/webhooks/${c.req.param('id')}`, v, 'err');
    await run(c.env, 'UPDATE webhooks SET url = ?, description = ?, events = ?, version = ? WHERE id = ? AND pub_id = ?', v.url, v.description, JSON.stringify(v.events), v.version, c.req.param('id'), c.get('pub').id);
    await audit(c, 'webhooks.updated', v.url);
    return back(c, `/app/settings/webhooks/${c.req.param('id')}`, 'Endpoint saved');
  });

  dash.post('/webhooks/:id/toggle', requirePerm('admin'), async (c) => {
    await run(c.env, 'UPDATE webhooks SET active = 1 - active WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
    return back(c, `/app/settings/webhooks/${c.req.param('id')}`, 'Endpoint updated');
  });

  dash.post('/webhooks/:id/rotate', requirePerm('admin'), async (c) => {
    await run(c.env, 'UPDATE webhooks SET secret = ? WHERE id = ? AND pub_id = ?', `whsec_${token(24)}`, c.req.param('id'), c.get('pub').id);
    await audit(c, 'webhooks.secret_rotated', c.req.param('id'));
    return back(c, `/app/settings/webhooks/${c.req.param('id')}`, 'Secret rotated');
  });

  dash.post('/webhooks/:id/delete', requirePerm('admin'), async (c) => {
    await run(c.env, 'DELETE FROM webhooks WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
    await audit(c, 'webhooks.deleted', c.req.param('id'));
    return back(c, '/app/settings/webhooks', 'Endpoint deleted');
  });

  dash.post('/webhooks/:id/test', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const h = await one<any>(c.env, 'SELECT * FROM webhooks WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!h) return back(c, '/app/settings/webhooks', 'Not found', 'err');
    const did = await createTestDelivery(c.env, h);
    const ok = await attemptDelivery(c.env, did, true);
    return back(c, `/app/settings/webhooks/${h.id}`, ok ? 'Test event delivered ✓' : 'Test delivery failed — see the log below', ok ? 'ok' : 'err');
  });

  dash.post('/webhooks/:id/retry/:did', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const d = await one<any>(c.env, 'SELECT d.id FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.id = ? AND w.id = ? AND w.pub_id = ?', c.req.param('did'), c.req.param('id'), pub.id);
    if (!d) return back(c, `/app/settings/webhooks/${c.req.param('id')}`, 'Not found', 'err');
    const ok = await attemptDelivery(c.env, d.id, true);
    return back(c, `/app/settings/webhooks/${c.req.param('id')}`, ok ? 'Delivered ✓' : 'Retry failed', ok ? 'ok' : 'err');
  });
}

function hookInput(f: Record<string, any>): { url: string; description: string; events: string[]; version: string } | string {
  const url = str(f.url, 1000);
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return 'URL must start with https://';
  } catch {
    return 'Enter a valid URL';
  }
  const events: string[] = f.all_events ? ['*'] : (f.events || []).filter((e: string) => (WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (!events.length) return 'Choose at least one event (or all events).';
  return { url, description: str(f.description, 200), events, version: isWebhookVersion(f.version) ? f.version : LATEST_WEBHOOK_VERSION };
}

/** Available payload versions, their changelog, and a sample payload in each shape. */
const VersionsCard = (p: { current?: string }) => {
  const sample = { id: 'evt_sample', type: 'subscription.created', pubId: 'pub_123', createdMs: Date.UTC(2026, 10, 1, 12), data: { subscriber: { id: 'sub_123', email: 'reader@example.com', name: 'Ada', status: 'active', tier: 'free', source: 'website', utm_source: 'x', utm_medium: 'social', utm_campaign: 'launch', referral_code: 'ADA1', custom: { role: 'founder' }, created_at: Date.UTC(2026, 10, 1, 12) } } };
  return (
    <Card title="Payload versions & changelog">
      <Help>Each endpoint is pinned to a payload version, so new fields or renamed keys never break a receiver. New endpoints get the latest version; upgrade an older endpoint from its page once your receiver handles the new shape.</Help>
      {[...WEBHOOK_VERSIONS].reverse().map((v) => (
        <div style="margin-top:14px">
          <div class="row"><strong class="mono">{v.version}</strong>{v.version === LATEST_WEBHOOK_VERSION && <Badge tone="green">latest</Badge>}{p.current === v.version && <Badge tone="blue">this endpoint</Badge>}<span class="muted small">{v.summary}</span></div>
          <ul class="small" style="margin:6px 0 0 18px">{v.changes.map((x) => <li>{x}</li>)}</ul>
          <details><summary class="muted small">Sample subscription.created payload</summary><pre class="small" style="white-space:pre-wrap">{JSON.stringify(buildPayload(v.version, sample), null, 2)}</pre></details>
        </div>
      ))}
    </Card>
  );
};

const HookForm = (p: { action: string; h?: any }) => {
  const ev = parseJSON<string[]>(p.h?.events, ['*']);
  const groups: Record<string, string[]> = {};
  for (const e of WEBHOOK_EVENTS) (groups[e.split('.')[0]] ||= []).push(e);
  return (
    <form method="post" action={p.action} class="stack">
      <Field label="Endpoint URL"><Input name="url" value={p.h?.url} required placeholder="https://example.com/webhooks/openhive" /></Field>
      <Field label="Description"><Input name="description" value={p.h?.description} /></Field>
      <Field label="Payload version" hint="See “Payload versions & changelog” for what changed between versions."><Select name="version" value={p.h?.version || LATEST_WEBHOOK_VERSION} options={[...WEBHOOK_VERSIONS].reverse().map((v) => [v.version, `${v.version}${v.version === LATEST_WEBHOOK_VERSION ? ' (latest)' : ''}`] as [string, string])} /></Field>
      <Toggle name="all_events" checked={ev.includes('*')} label="Send all events" hint="Including events added in the future." />
      <fieldset class="grid g3">
        {Object.entries(groups).map(([g, list]) => (
          <div><div class="field-l">{g}</div>{list.map((e) => <label class="check"><input type="checkbox" name="events[]" value={e} checked={ev.includes(e)} /><span class="small mono">{e}</span></label>)}</div>
        ))}
      </fieldset>
      <div class="form-actions"><Btn>{p.h ? 'Save endpoint' : 'Create endpoint'}</Btn></div>
    </form>
  );
};
