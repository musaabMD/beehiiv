/** @jsxImportSource hono/jsx */
// Store integrations: Shopify, WooCommerce and the creator's own Stripe account (purchase sync + cart abandonment).
// Dashboard: /app/settings/commerce (registered from settings/developers). Public: POST /hooks/commerce/:token.
// Also exports the purchase-history card (subscriber page) and the store-revenue card (Analytics → Revenue).
import { Hono } from 'hono';
import type { Hono as HonoT } from 'hono';
import type { AppEnv, Ctx, Subscriber } from '../types';
import { one, all, run, val } from '../lib/db';
import { requirePerm, audit } from '../lib/auth';
import { PLATFORMS, connectStore, hookUrl, storeConfig, handleCommerceWebhook, purchasesFor, externalRevenue, type Platform, type Store } from '../lib/commerce';
import { createAutomation, BadRequest } from './api/rest';
import { form, str, bool, money, num, ago, fmtDateTime, parseJSON } from '../lib/util';
import { Card, Field, Input, Btn, ActionForm, Table, Badge, Status, Grid, Help, Copy, Toggle, Stats, Stat, back } from '../ui/components';
import { page } from './settings/ui';

// ───────── public webhook receiver ─────────
export const root = new Hono<AppEnv>();
root.post('/hooks/commerce/:token', async (c) => {
  const raw = await c.req.text();
  if (raw.length > 2_000_000) return c.json({ error: 'payload too large' }, 413);
  const r = await handleCommerceWebhook(c.env, c.req.param('token'), c.req.raw.headers, raw);
  return c.json(r.body, r.status as any);
});

const RECOVERY_DOC = {
  blocks: [
    { id: 'h1', type: 'heading', data: { level: 2, html: 'You left something in your cart' } },
    { id: 'p1', type: 'paragraph', data: { html: 'Hi {{subscriber.first_name|there}}, your cart is saved. Here is what you picked:' } },
    { id: 'c1', type: 'html', data: { html: '{{cart.items}}' } },
    { id: 'b1', type: 'button', data: { label: 'Complete your order', url: '{{cart.recovery_url}}', align: 'center' } },
  ],
};

export function registerCommerce(dash: HonoT<AppEnv>) {
  dash.get('/commerce', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const stores = await all<Store>(c.env, 'SELECT * FROM commerce_stores WHERE pub_id = ?', pub.id);
    const [cust, subs, orders, carts, events, recent, revenue] = await Promise.all([
      val<number>(c.env, 'SELECT COUNT(*) FROM commerce_customers WHERE pub_id = ?', pub.id),
      val<number>(c.env, 'SELECT COUNT(*) FROM commerce_customers WHERE pub_id = ? AND subscriber_id IS NOT NULL', pub.id),
      one<any>(c.env, `SELECT COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS rev, MAX(currency) AS cur FROM external_orders WHERE pub_id = ? AND status = 'paid'`, pub.id),
      all<any>(c.env, `SELECT status, COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS amt FROM abandoned_carts WHERE pub_id = ? GROUP BY status`, pub.id),
      all<any>(c.env, 'SELECT * FROM commerce_events WHERE pub_id = ? ORDER BY created_at DESC LIMIT 15', pub.id),
      all<any>(c.env, `SELECT o.*, (SELECT GROUP_CONCAT(i.name, ', ') FROM external_order_items i WHERE i.order_id = o.id) AS items FROM external_orders o WHERE o.pub_id = ? ORDER BY o.created_at DESC LIMIT 15`, pub.id),
      all<any>(c.env, `SELECT * FROM abandoned_carts WHERE pub_id = ? ORDER BY updated_at DESC LIMIT 10`, pub.id),
    ]);
    const cartN = (s: string) => carts.find((x) => x.status === s) || { n: 0, amt: 0 };
    const cur = orders?.cur || 'usd';
    const hasRecovery = await one(c.env, `SELECT 1 FROM automations WHERE pub_id = ? AND status != 'archived' AND (json_extract(trigger, '$.type') = 'cart_abandoned' OR json_extract(draft_trigger, '$.type') = 'cart_abandoned')`, pub.id);
    return page(c, 'commerce', 'Store integrations', (
      <>
        <Stats>
          <Stat label="Store customers" value={num(cust)} sub={`${num(subs)} are subscribers`} />
          <Stat label="Store orders" value={num(orders?.n || 0)} sub={money(orders?.rev || 0, cur)} />
          <Stat label="Abandoned carts" value={num(cartN('abandoned').n)} sub={money(cartN('abandoned').amt, cur)} />
          <Stat label="Recovered carts" value={num(cartN('recovered').n)} sub={money(cartN('recovered').amt, cur)} />
        </Stats>
        <Help>Buyers become subscribers only when the store says they accepted marketing (Shopify email marketing consent, a WooCommerce opt-in field, or Stripe Checkout's promotions consent). Everyone else is kept as a store customer — purchase history and segments work, but they are never emailed.</Help>
        <Grid cols={3}>
          {(Object.keys(PLATFORMS) as Platform[]).map((key) => {
            const p = PLATFORMS[key];
            const s = stores.find((x) => x.platform === key);
            const cfg = s ? storeConfig(s) : storeConfig({ config: '{}' });
            return (
              <Card title={<span class="row">{p.name} {s?.active ? <Badge tone="green">connected</Badge> : <Badge>not connected</Badge>}</span>}>
                {s && (
                  <div class="stack-sm">
                    <Field label="Webhook URL"><Copy value={hookUrl(c.env, s)} /></Field>
                    <p class="small muted">{s.events_count ? `${num(s.events_count)} events · last ${ago(s.last_event_at)}` : 'No events received yet.'}</p>
                  </div>
                )}
                <details class="small" open={!s}>
                  <summary>Setup</summary>
                  <ol>{p.setup.map((x) => <li>{x}</li>)}</ol>
                  <p>Events: {p.events.map((e) => <code>{e} </code>)}</p>
                  {!s && <p class="muted">Save the secret first — the webhook URL appears here.</p>}
                </details>
                <form method="post" action={`/app/settings/commerce/${key}`} class="stack-sm">
                  <Field label={p.secretLabel} hint={p.secretHint}><Input name="secret" type="password" placeholder={s ? 'saved — leave blank to keep' : ''} required={!s} attrs={{ autocomplete: 'off' }} /></Field>
                  <Field label={key === 'stripe' ? 'Account name' : 'Store URL'}><Input name="store_url" value={s?.store_url || ''} placeholder={key === 'shopify' ? 'yourstore.myshopify.com' : key === 'woocommerce' ? 'https://shop.example.com' : ''} /></Field>
                  {key !== 'stripe' && <Field label="Cart counts as abandoned after (hours)"><Input name="abandon_hours" type="number" step="0.25" min="0.25" value={cfg.abandon_hours} /></Field>}
                  <Toggle name="tag_buyers" checked={cfg.tag_buyers} label={`Tag buyers by product (${cfg.tag_prefix}<product>)`} />
                  <div class="row end">
                    {s && <Btn kind="ghost" small name="disconnect" value="1" confirm="Stop receiving events from this store? Stored orders are kept.">Disconnect</Btn>}
                    <Btn small>{s ? 'Save' : 'Connect'}</Btn>
                  </div>
                </form>
              </Card>
            );
          })}
        </Grid>
        <Card title="Cart recovery">
          <p>Automations can start when a checkout is abandoned (trigger <strong>Abandons a cart</strong>, with a delay in hours and a minimum cart value) or when someone buys (<strong>Buys in your store</strong>). Journeys stop automatically when the order completes.</p>
          <p class="small muted">In emails use <code>{'{{cart.items}}'}</code> (a table of the cart), <code>{'{{cart.total}}'}</code>, <code>{'{{cart.item_count}}'}</code>, <code>{'{{cart.first_item}}'}</code> and a button linking to <code>{'{{cart.recovery_url}}'}</code>.</p>
          {hasRecovery ? <p class="muted">You already have a cart-abandonment automation. <a href="/app/automations">Open automations</a></p> : <ActionForm action="/app/settings/commerce/recovery-automation" label="Create a cart recovery automation (draft)" kind="secondary" />}
        </Card>
        <Card title="Recent store orders" pad={false}>
          <Table rows={recent} empty="No orders yet." cols={[
            { h: 'Date', r: (o) => <span class="nowrap">{fmtDateTime(o.created_at, pub.timezone)}</span> },
            { h: 'Store', r: (o) => PLATFORMS[o.platform as Platform]?.name || o.platform },
            { h: 'Buyer', r: (o) => (o.subscriber_id ? <a href={`/app/audience/s/${o.subscriber_id}`}>{o.name || o.email}</a> : <span>{o.name || o.email} <small class="muted">(customer only)</small></span>) },
            { h: 'Items', r: (o) => <small>{o.items || '—'}</small> },
            { h: 'Total', r: (o) => money(o.total_cents, o.currency) },
            { h: 'Status', r: (o) => <Status s={o.status} /> },
          ]} />
        </Card>
        <Card title="Checkouts & carts" pad={false}>
          <Table rows={revenue} empty="No checkouts tracked yet." cols={[
            { h: 'Updated', r: (x) => ago(x.checkout_updated_at) },
            { h: 'Email', r: (x) => (x.subscriber_id ? <a href={`/app/audience/s/${x.subscriber_id}`}>{x.email}</a> : x.email || '—') },
            { h: 'Cart', r: (x) => <small>{parseJSON<any[]>(x.items, []).map((i) => `${i.name}${i.quantity > 1 ? ' ×' + i.quantity : ''}`).join(', ')}</small> },
            { h: 'Value', r: (x) => money(x.total_cents, x.currency) },
            { h: 'Status', r: (x) => <Status s={x.status} /> },
          ]} />
        </Card>
        <Card title="Webhook log" pad={false}>
          <Table rows={events} empty="Nothing received yet." cols={[
            { h: 'Received', r: (e) => ago(e.created_at) },
            { h: 'Store', r: (e) => e.platform },
            { h: 'Event', r: (e) => <code>{e.topic}</code> },
            { h: 'Result', r: (e) => <Badge tone={e.status === 'processed' ? 'green' : e.status === 'ignored' || e.status === 'duplicate' ? 'gray' : 'red'}>{e.status.replace('_', ' ')}</Badge> },
            { h: '', r: (e) => <small class="muted">{e.detail}</small> },
          ]} />
        </Card>
      </>
    ));
  });

  dash.post('/commerce/recovery-automation', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    try {
      const a = await createAutomation(c.env, pub, {
        name: 'Cart recovery',
        description: 'Emails subscribers who left items in their cart. Stops when they complete the order.',
        trigger: { type: 'cart_abandoned', config: { delay_hours: 1, min_value: 0 } },
        steps: [
          { type: 'send_email', config: { subject: 'You left something in your cart', preview_text: 'Your cart is saved — finish checking out.', doc: RECOVERY_DOC } },
          { type: 'delay', config: { amount: 1, unit: 'days' } },
          { type: 'send_email', config: { subject: 'Still thinking it over?', preview_text: '{{cart.first_item}} is waiting for you.', doc: RECOVERY_DOC } },
        ],
      });
      await audit(c, 'automation.create', a.id, { template: 'cart recovery' });
      return c.redirect(`/app/automations/${a.id}`);
    } catch (e: any) {
      return back(c, '/app/settings/commerce', e instanceof BadRequest ? e.message : 'Could not create the automation.', 'err');
    }
  });

  dash.post('/commerce/:platform', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const platform = c.req.param('platform') as Platform;
    if (!PLATFORMS[platform]) return c.notFound();
    const f = await form(c.req);
    if (f.disconnect) {
      await run(c.env, 'UPDATE commerce_stores SET active = 0 WHERE pub_id = ? AND platform = ?', pub.id, platform);
      await audit(c, 'commerce.disconnect', platform);
      return back(c, '/app/settings/commerce', `${PLATFORMS[platform].name} disconnected.`);
    }
    const secret = str(f.secret, 300).trim();
    const existing = await one(c.env, 'SELECT 1 FROM commerce_stores WHERE pub_id = ? AND platform = ?', pub.id, platform);
    if (!secret && !existing) return back(c, '/app/settings/commerce', 'Paste the webhook signing secret.', 'err');
    if (platform === 'stripe' && secret && !secret.startsWith('whsec_')) return back(c, '/app/settings/commerce', 'Stripe endpoint secrets start with whsec_.', 'err');
    const hours = Number(f.abandon_hours);
    await connectStore(c.env, pub.id, platform, { secret, store_url: str(f.store_url, 300).trim() || undefined, config: { tag_buyers: bool(f.tag_buyers), ...(hours > 0 ? { abandon_hours: Math.min(hours, 72) } : {}) } });
    await audit(c, 'commerce.connect', platform);
    return back(c, '/app/settings/commerce', existing ? 'Saved.' : `${PLATFORMS[platform].name} connected — add the webhook URL in your store.`);
  });
}

// ───────── cards used by other pages ─────────
/** Subscriber page: purchases from connected stores (matched by email). */
export async function StorePurchasesCard(p: { c: Ctx; sub: Pick<Subscriber, 'pub_id' | 'email'> }) {
  const rows = await purchasesFor(p.c.env, p.sub.pub_id, p.sub.email);
  if (!rows.length) return <></>;
  const paid = rows.filter((r) => r.status === 'paid');
  const cur = rows[0].currency;
  return (
    <Card title={`Store purchases · ${money(paid.reduce((n, r) => n + r.total_cents, 0), cur)} across ${paid.length} order${paid.length === 1 ? '' : 's'}`} pad={false}>
      <Table<any> rows={rows} cols={[
        { h: 'Store', r: (o) => PLATFORMS[o.platform as Platform]?.name || o.platform },
        { h: 'Order', r: (o) => <span>{o.order_number || o.external_id}<br /><small class="muted">{o.items || ''}</small></span> },
        { h: 'Status', r: (o) => <Status s={o.status} /> },
        { h: 'Amount', r: (o) => money(o.total_cents, o.currency) },
        { h: 'Date', r: (o) => fmtDateTime(o.paid_at || o.created_at) },
      ]} />
    </Card>
  );
}

/** Analytics → Revenue: store revenue in the selected range, per platform. */
export async function StoreRevenueCard(p: { c: Ctx; from: number; to: number }) {
  const rows = await externalRevenue(p.c.env, p.c.get('pub').id, p.from, p.to);
  if (!rows.length) return <></>;
  return (
    <Card title="Store revenue (Shopify / WooCommerce / Stripe)" actions={<a href="/app/settings/commerce" class="small">Store integrations</a>}>
      <Stats>{rows.map((r) => <Stat label={PLATFORMS[r.platform as Platform]?.name || r.platform} value={money(r.revenue, r.currency)} sub={`${num(r.orders)} orders`} />)}</Stats>
    </Card>
  );
}
