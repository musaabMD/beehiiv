/** @jsxImportSource hono/jsx */
import type { Hono } from 'hono';
import type { AppEnv, Ctx } from '../../types';
import { one, all, run, insert } from '../../lib/db';
import { requirePerm, audit } from '../../lib/auth';
import { settings } from '../../lib/pub';
import { stripeEnabled, stripePost, stripeGet } from '../../lib/payments';
import { sendTransactional, button } from '../../lib/email';
import { validateEmail } from '../../lib/guard';
import { id, now, token, sha256, form, str, ago, fmtDateTime, toCSV, parseJSON, money, esc } from '../../lib/util';
import { Card, Field, Input, Textarea, Btn, ActionForm, Table, Badge, Status, Grid, Help, LinkBtn, Toggle, Stats, Stat, back } from '../../ui/components';
import { page, saveSettings } from './ui';

function csv(c: Ctx, name: string, rows: unknown[][]) {
  return new Response(toCSV(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"` } });
}

export function registerAccount(dash: Hono<AppEnv>) {
  // ───────────── Payments, billing & exports ─────────────
  dash.get('/billing', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const s = settings(pub);
    const enabled = stripeEnabled(c.env);
    let acct: any = null;
    if (enabled && s.stripe_account_id) acct = await stripeGet(c.env, `accounts/${s.stripe_account_id}`).catch(() => null);
    const rev = await one<any>(c.env, `SELECT COALESCE(SUM(amount_cents),0) AS gross, COALESCE(SUM(platform_fee_cents),0) AS fees, COUNT(*) AS n FROM orders WHERE pub_id = ? AND status = 'paid'`, pub.id);
    const fee = Number(c.env.PLATFORM_FEE_PERCENT || '0');
    return page(c, 'billing', 'Payments & billing', (
      <>
        <Stats>
          <Stat label="Platform fee" value={`${fee}%`} sub="on subscriptions, products and tickets" />
          <Stat label="Gross sales" value={money(rev?.gross || 0)} sub={`${rev?.n || 0} paid orders`} />
          <Stat label="Fees paid" value={money(rev?.fees || 0)} />
        </Stats>
        <Grid>
          <Card title="Stripe">
            {enabled ? (
              <>
                <p><Badge tone="green">Stripe connected</Badge> Live payments are enabled on this instance.</p>
                {s.stripe_account_id ? (
                  <>
                    <p>Payout account: <code>{s.stripe_account_id}</code>{' '}
                      {acct && !acct.error ? (acct.charges_enabled ? <Badge tone="green">charges enabled</Badge> : <Badge tone="amber">onboarding incomplete</Badge>) : null}
                      {acct && !acct.error && (acct.payouts_enabled ? <Badge tone="green">payouts enabled</Badge> : <Badge tone="amber">payouts pending</Badge>)}
                    </p>
                    <div class="row">
                      {acct && !acct.charges_enabled && <ActionForm action="/app/settings/billing/connect" label="Finish Stripe onboarding" kind="primary" />}
                      <ActionForm action="/app/settings/billing/dashboard" label="Open Stripe Express dashboard" />
                    </div>
                  </>
                ) : (
                  <>
                    <p class="muted">Connect a Stripe Express account to receive payouts for paid subscriptions, products and tickets directly.</p>
                    <ActionForm action="/app/settings/billing/connect" label="Connect with Stripe" kind="primary" small={false} />
                  </>
                )}
                <form method="post" action="/app/settings/billing/account" class="row" style="margin-top:14px">
                  <Input name="stripe_account_id" value={s.stripe_account_id} placeholder="acct_… (existing Connect account)" class="grow" />
                  <Btn kind="secondary" small>Save account id</Btn>
                </form>
                <Help>Webhook endpoint for Stripe (events: checkout.session.completed, customer.subscription.updated, customer.subscription.deleted, invoice.payment_failed): <code>{c.env.APP_URL.replace(/\/$/, '')}/hooks/stripe</code></Help>
              </>
            ) : (
              <>
                <div class="callout warn"><strong>Test mode.</strong> No Stripe key is configured, so checkouts use the built-in simulated checkout — every purchase flow works end to end, but no money moves.</div>
                <Help>To take real payments: <code>npx wrangler secret put STRIPE_SECRET_KEY</code> and <code>npx wrangler secret put STRIPE_WEBHOOK_SECRET</code>, then point a Stripe webhook at <code>{c.env.APP_URL.replace(/\/$/, '')}/hooks/stripe</code>. Payouts go through Stripe Connect.</Help>
              </>
            )}
          </Card>
          <Card title="Exports">
            <p class="muted">Download your data any time. Your list is yours.</p>
            <div class="stack-sm">
              <LinkBtn href="/app/settings/billing/export/subscribers" download>Subscribers (CSV)</LinkBtn>{' '}
              <LinkBtn href="/app/settings/billing/export/posts" download>Posts (CSV)</LinkBtn>{' '}
              <LinkBtn href="/app/settings/billing/export/orders" download>Orders (CSV)</LinkBtn>
            </div>
          </Card>
        </Grid>
        <Card title="Your Lnkbase Newsletter plan">
          <p>Your plan sets how many subscribers and emails a month you have; every feature is included on every plan, and we take 0% of what you earn here.</p>
          <LinkBtn href="/app/settings/plan">Plan &amp; usage</LinkBtn>
        </Card>
      </>
    ));
  });

  dash.post('/billing/account', requirePerm('admin'), async (c) => {
    const f = await form(c.req);
    const v = str(f.stripe_account_id, 60);
    if (v && !/^acct_[A-Za-z0-9]+$/.test(v)) return back(c, '/app/settings/billing', 'Stripe account ids look like acct_…', 'err');
    await saveSettings(c, { stripe_account_id: v || undefined });
    await audit(c, 'billing.stripe_account_set', v || '(cleared)');
    return back(c, '/app/settings/billing', 'Saved');
  });

  dash.post('/billing/connect', requirePerm('admin'), async (c) => {
    if (!stripeEnabled(c.env)) return back(c, '/app/settings/billing', 'Add STRIPE_SECRET_KEY first.', 'err');
    const pub = c.get('pub');
    const s = settings(pub);
    try {
      let acctId = s.stripe_account_id;
      if (!acctId) {
        const acct = await stripePost(c.env, 'accounts', { type: 'express', email: c.get('user').email, 'business_profile[name]': pub.name, 'capabilities[card_payments][requested]': 'true', 'capabilities[transfers][requested]': 'true', 'metadata[publication_id]': pub.id });
        acctId = acct.id;
        await saveSettings(c, { stripe_account_id: acctId });
      }
      const base = c.env.APP_URL.replace(/\/$/, '');
      const link = await stripePost(c.env, 'account_links', { account: acctId!, refresh_url: `${base}/app/settings/billing`, return_url: `${base}/app/settings/billing`, type: 'account_onboarding' });
      await audit(c, 'billing.stripe_connect_started', acctId!);
      return c.redirect(link.url, 303);
    } catch (e: any) {
      return back(c, '/app/settings/billing', 'Stripe error: ' + e.message, 'err');
    }
  });

  dash.post('/billing/dashboard', requirePerm('admin'), async (c) => {
    const s = settings(c.get('pub'));
    if (!stripeEnabled(c.env) || !s.stripe_account_id) return back(c, '/app/settings/billing', 'Connect Stripe first.', 'err');
    try {
      const l = await stripePost(c.env, `accounts/${s.stripe_account_id}/login_links`, {});
      return c.redirect(l.url, 303);
    } catch (e: any) {
      return back(c, '/app/settings/billing', 'Stripe error: ' + e.message, 'err');
    }
  });

  dash.get('/billing/export/:what', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const what = c.req.param('what');
    await audit(c, 'export.' + what, pub.id);
    if (what === 'subscribers') {
      const rows = await all<any>(c.env, `SELECT s.*, (SELECT group_concat(tag, '|') FROM subscriber_tags t WHERE t.subscriber_id = s.id) AS tags FROM subscribers s WHERE s.pub_id = ? ORDER BY s.created_at`, pub.id);
      const customKeys = [...new Set(rows.flatMap((r) => Object.keys(parseJSON(r.custom, {}))))];
      return csv(c, `${pub.slug}-subscribers`, [
        ['email', 'name', 'status', 'tier', 'source', 'utm_source', 'utm_medium', 'utm_campaign', 'referral_code', 'referral_count', 'opens', 'clicks', 'engagement', 'tags', 'subscribed_at', 'unsubscribed_at', ...customKeys.map((k) => `custom:${k}`)],
        ...rows.map((r) => { const cu = parseJSON<any>(r.custom, {}); return [r.email, r.name, r.status, r.tier, r.source, r.utm_source, r.utm_medium, r.utm_campaign, r.referral_code, r.referral_count, r.open_count, r.click_count, r.engagement, r.tags, new Date(r.created_at).toISOString(), r.unsubscribed_at ? new Date(r.unsubscribed_at).toISOString() : '', ...customKeys.map((k) => cu[k] ?? '')]; }),
      ]);
    }
    if (what === 'posts') {
      const rows = await all<any>(c.env, `SELECT p.*, (SELECT COUNT(*) FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = p.id AND d.status = 'sent') AS recipients, (SELECT COUNT(*) FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = p.id AND d.opened_at IS NOT NULL) AS opens, (SELECT COUNT(*) FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = p.id AND d.clicked_at IS NOT NULL) AS clicks FROM posts p WHERE p.pub_id = ? ORDER BY p.created_at`, pub.id);
      return csv(c, `${pub.slug}-posts`, [['title', 'slug', 'status', 'platform', 'audience', 'subject', 'published_at', 'recipients', 'unique_opens', 'unique_clicks', 'word_count'], ...rows.map((r) => [r.title, r.slug, r.status, r.platform, r.audience, r.email_subject || r.title, r.published_at ? new Date(r.published_at).toISOString() : '', r.recipients, r.opens, r.clicks, r.word_count])]);
    }
    if (what === 'orders') {
      const rows = await all<any>(c.env, 'SELECT * FROM orders WHERE pub_id = ? ORDER BY created_at', pub.id);
      return csv(c, `${pub.slug}-orders`, [['order_id', 'kind', 'item_id', 'email', 'name', 'amount', 'currency', 'platform_fee', 'status', 'created_at', 'paid_at'], ...rows.map((r) => [r.id, r.kind, r.ref_id, r.email, r.name, (r.amount_cents / 100).toFixed(2), r.currency, (r.platform_fee_cents / 100).toFixed(2), r.status, new Date(r.created_at).toISOString(), r.paid_at ? new Date(r.paid_at).toISOString() : ''])]);
    }
    return c.notFound();
  });

  // ───────────── Workspace ─────────────
  dash.get('/workspace', async (c) => {
    const user = c.get('user');
    const pub = c.get('pub');
    const wsList = await all<any>(c.env, `SELECT DISTINCT w.*, (SELECT role FROM memberships m WHERE m.workspace_id = w.id AND m.user_id = ? AND m.pub_id = '') AS ws_role FROM workspaces w WHERE w.id IN (SELECT workspace_id FROM memberships WHERE user_id = ?) OR w.id IN (SELECT p.workspace_id FROM publications p JOIN memberships m ON m.pub_id = p.id WHERE m.user_id = ?) ORDER BY w.created_at`, user.id, user.id, user.id);
    const q = str(c.req.query('q'), 100).toLowerCase();
    const wsIds = wsList.map((w) => w.id);
    const people = wsIds.length
      ? await all<any>(
          c.env,
          `SELECT u.id, u.name, u.email, m.role, m.pub_id, m.workspace_id, w.name AS ws_name, p.name AS pub_name FROM memberships m JOIN users u ON u.id = m.user_id JOIN workspaces w ON w.id = m.workspace_id LEFT JOIN publications p ON p.id = m.pub_id
           WHERE m.workspace_id IN (${wsIds.map(() => '?').join(',')}) ${q ? 'AND (lower(u.name) LIKE ? OR u.email LIKE ?)' : ''} ORDER BY u.name, w.name LIMIT 500`,
          ...wsIds, ...(q ? [`%${q}%`, `%${q}%`] : []),
        )
      : [];
    const byPerson = new Map<string, { name: string; email: string; teams: string[] }>();
    for (const p of people) {
      const e = byPerson.get(p.id) || { name: p.name, email: p.email, teams: [] as string[] };
      e.teams.push(`${p.pub_name || p.ws_name + ' (all)'} · ${p.role}`);
      byPerson.set(p.id, e);
    }
    const pubsByWs = await all<any>(c.env, `SELECT id, name, slug, workspace_id, (SELECT COUNT(*) FROM subscribers s WHERE s.pub_id = publications.id AND s.status = 'active') AS subs FROM publications WHERE workspace_id IN (${wsIds.map(() => '?').join(',') || "''"}) ORDER BY name`, ...wsIds);
    const current = wsList.find((w) => w.id === pub?.workspace_id);
    const transfers = pub ? await all<any>(c.env, `SELECT * FROM transfers WHERE pub_id = ? ORDER BY created_at DESC LIMIT 10`, pub.id) : [];
    const isOwner = c.get('role') === 'owner';
    const consent = pub ? `I, ${user.name || user.email}, the owner of "${pub.name}", consent to transfer full ownership of this publication — including its posts, subscriber list, website, settings and revenue — to the recipient named below. I confirm I have the right to transfer these subscribers and that the recipient will become the data controller for them.` : '';
    return page(c, 'workspace', 'Workspace', (
      <>
        {wsList.map((w) => (
          <Card title={<span class="row">{w.name} {w.id === pub?.workspace_id && <Badge tone="amber">current</Badge>} {w.ws_role && <Badge>{w.ws_role}</Badge>}</span>} actions={w.ws_role === 'owner' || w.ws_role === 'admin' ? <a class="btn btn-secondary btn-sm" href="/app/onboarding?new=1">New publication</a> : undefined}>
            {(w.ws_role === 'owner' || w.ws_role === 'admin') && (
              <form method="post" action={`/app/settings/workspace/${w.id}/rename`} class="row" style="margin-bottom:12px"><Input name="name" value={w.name} class="grow" /><Btn kind="secondary" small>Rename</Btn></form>
            )}
            <Table rows={pubsByWs.filter((p) => p.workspace_id === w.id)} empty="No publications." cols={[
              { h: 'Publication', r: (p: any) => <a href={`/app?pub=${p.id}`}>{p.name}</a> },
              { h: 'URL', r: (p: any) => <code class="small">/s/{p.slug}</code> },
              { h: 'Subscribers', r: (p: any) => p.subs },
            ]} />
          </Card>
        ))}
        <Card title="People across your teams" pad={false}>
          <form method="get" class="row" style="padding:12px 18px"><Input name="q" value={q} placeholder="Search people by name or email…" class="grow" /><Btn kind="secondary" small>Search</Btn></form>
          <Table rows={[...byPerson.values()]} empty="No people found." cols={[
            { h: 'Person', r: (p) => <><strong>{p.name || p.email}</strong><div class="muted small">{p.email}</div></> },
            { h: 'Teams & roles', r: (p) => <div class="row" style="gap:4px">{p.teams.map((t) => <Badge tone="blue">{t}</Badge>)}</div> },
          ]} />
        </Card>
        {pub && (
          <Card title={`Transfer ${pub.name}`}>
            {isOwner ? (
              <form method="post" action="/app/settings/workspace/transfer" class="stack">
                <Help>The recipient must accept and sign. Until then nothing changes. Transfers move the publication into the recipient's workspace.</Help>
                <Field label="Recipient email"><Input name="email" type="email" required /></Field>
                <Field label="Written consent" hint="The recipient reads and signs this statement."><Textarea name="consent" value={consent} rows={5} required /></Field>
                <Toggle name="keep_admin" checked label="Keep admin access after the transfer" />
                <label class="check"><input type="checkbox" name="agree" required /><span>I agree to the statement above.</span></label>
                <div class="form-actions"><Btn kind="danger">Send transfer request</Btn></div>
              </form>
            ) : <p class="muted">Only the owner can transfer a publication.</p>}
            {transfers.length > 0 && (
              <Table rows={transfers} cols={[
                { h: 'To', r: (t: any) => t.to_email },
                { h: 'Status', r: (t: any) => <Status s={t.status} /> },
                { h: 'Sent', r: (t: any) => ago(t.created_at) },
                { h: 'Signed', r: (t: any) => t.signed_name || '—' },
                { h: '', class: 'right', r: (t: any) => (t.status === 'pending' && isOwner ? <ActionForm action={`/app/settings/workspace/transfer/${t.id}/cancel`} label="Cancel" kind="danger" /> : null) },
              ]} />
            )}
          </Card>
        )}
      </>
    ));
  });

  dash.post('/workspace/:id/rename', async (c) => {
    const user = c.get('user');
    const f = await form(c.req);
    const name = str(f.name, 100);
    if (!name) return back(c, '/app/settings/workspace', 'Name required', 'err');
    const r = await run(c.env, `UPDATE workspaces SET name = ? WHERE id = ? AND EXISTS (SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ? AND pub_id = '' AND role IN ('owner','admin'))`, name, c.req.param('id'), c.req.param('id'), user.id);
    return back(c, '/app/settings/workspace', r.meta.changes ? 'Workspace renamed' : 'Not allowed', r.meta.changes ? 'ok' : 'err');
  });

  dash.post('/workspace/transfer', async (c) => {
    const pub = c.get('pub');
    const user = c.get('user');
    if (c.get('role') !== 'owner') return back(c, '/app/settings/workspace', 'Only the owner can transfer.', 'err');
    const f = await form(c.req);
    const v = await validateEmail(str(f.email));
    if (!v.ok) return back(c, '/app/settings/workspace', v.reason, 'err');
    if (v.email === user.email) return back(c, '/app/settings/workspace', "You can't transfer to yourself.", 'err');
    const consent = str(f.consent, 4000);
    if (!consent || !f.agree) return back(c, '/app/settings/workspace', 'Consent statement and agreement are required.', 'err');
    await run(c.env, `UPDATE transfers SET status = 'cancelled' WHERE pub_id = ? AND status = 'pending'`, pub.id);
    const tok = token(24);
    await insert(c.env, 'transfers', { id: id(), pub_id: pub.id, from_user_id: user.id, to_email: v.email, consent_text: consent, token_hash: await sha256(tok), status: 'pending', keep_admin: f.keep_admin ? 1 : 0, created_at: now() });
    await sendTransactional(c.env, v.email, `${user.name || user.email} wants to transfer ${pub.name} to you`, `<p><strong>${esc(user.name || user.email)}</strong> wants to transfer ownership of <strong>${esc(pub.name)}</strong> to you on ${esc(c.env.APP_NAME)}.</p><p>Please read the consent statement and sign to accept.</p>${button('Review transfer', `${c.env.APP_URL.replace(/\/$/, '')}/transfer/${tok}`)}`);
    await audit(c, 'publication.transfer_requested', v.email, { keep_admin: !!f.keep_admin });
    return back(c, '/app/settings/workspace', `Transfer request sent to ${v.email}`);
  });

  dash.post('/workspace/transfer/:id/cancel', async (c) => {
    if (c.get('role') !== 'owner') return back(c, '/app/settings/workspace', 'Not allowed', 'err');
    await run(c.env, `UPDATE transfers SET status = 'cancelled' WHERE id = ? AND pub_id = ? AND status = 'pending'`, c.req.param('id'), c.get('pub').id);
    await audit(c, 'publication.transfer_cancelled', c.req.param('id'));
    return back(c, '/app/settings/workspace', 'Transfer cancelled');
  });
}

export { fmtDateTime };
