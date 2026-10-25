/** @jsxImportSource hono/jsx */
// Orders dashboard: every payment (subscriptions, products, tickets, gifts, groups, sponsorships).
import type { Hono } from 'hono';
import type { AppEnv } from '../../types';
import { one, all, run } from '../../lib/db';
import { requirePerm, audit } from '../../lib/auth';
import { emit } from '../../lib/events';
import { stripeEnabled, stripePost, onOrderPaid } from '../../lib/payments';
import { settings, siteUrl } from '../../lib/pub';
import { sendTransactional, button } from '../../lib/email';
import { DashLayout } from '../../ui/layout';
import { Card, Stats, Stat, Table, Btn, LinkBtn, Select, Input, Status, ActionForm, back } from '../../ui/components';
import { money, num, fmtDateTime, parseJSON, toCSV, esc, now } from '../../lib/util';

function orderFilter(q: Record<string, string | undefined>) {
  const where: string[] = ['o.pub_id = ?'];
  const params: unknown[] = [];
  if (q.kind) { where.push('o.kind = ?'); params.push(q.kind); }
  if (q.status) { where.push('o.status = ?'); params.push(q.status); }
  if (q.q) { where.push('(o.email LIKE ? OR o.name LIKE ? OR o.id = ?)'); params.push(`%${q.q}%`, `%${q.q}%`, q.q); }
  if (q.product) { where.push('o.ref_id = ?'); params.push(q.product); }
  return { where: where.join(' AND '), params };
}

const ITEM_SQL = `COALESCE(p.name, t.name, e.title, sp.name, json_extract(o.data, '$.description'))`;

export function registerOrders(dash: Hono<AppEnv>) {
  dash.get('/orders', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const q = c.req.query();
    const { where, params } = orderFilter(q);
    const orders = await all<any>(c.env, `SELECT o.*, ${ITEM_SQL} AS item, o2.code AS offer_code FROM orders o LEFT JOIN products p ON p.id = o.ref_id LEFT JOIN tiers t ON t.id = o.ref_id LEFT JOIN live_events e ON e.id = o.ref_id LEFT JOIN sponsorship_products sp ON sp.id = o.ref_id LEFT JOIN offers o2 ON o2.id = o.offer_id WHERE ${where} ORDER BY o.created_at DESC LIMIT 300`, pub.id, ...params);
    const tot = await one<any>(c.env, `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN o.status = 'paid' THEN o.amount_cents END),0) AS revenue, COALESCE(SUM(CASE WHEN o.status = 'refunded' THEN o.amount_cents END),0) AS refunded, COALESCE(SUM(o.platform_fee_cents),0) AS fees FROM orders o WHERE ${where}`, pub.id, ...params);
    const byKind = await all<any>(c.env, `SELECT kind, COUNT(*) AS n, SUM(amount_cents) AS amt FROM orders WHERE pub_id = ? AND status = 'paid' GROUP BY kind`, pub.id);
    const qs = new URLSearchParams(q as any).toString();
    const cur = orders[0]?.currency || 'usd';
    return c.html(
      <DashLayout c={c} title="Orders" section="monetize" sub="orders" actions={<LinkBtn href={`/app/monetize/orders.csv?${qs}`}>Export CSV</LinkBtn>}>
        <Stats>
          <Stat label="Paid revenue" value={money(tot.revenue, cur)} sub={`${num(tot.n)} orders`} />
          <Stat label="Refunded" value={money(tot.refunded, cur)} />
          <Stat label="Platform fees" value={money(tot.fees, cur)} sub={`${Number(c.env.PLATFORM_FEE_PERCENT || 0)}% fee`} />
          {byKind.slice(0, 2).map((k) => <Stat label={`${k.kind} sales`} value={money(k.amt, cur)} sub={`${num(k.n)} orders`} />)}
        </Stats>
        <Card pad={false} actions={null} title={
          <form method="get" class="row">
            <Input name="q" value={q.q} placeholder="Search email, name, order id" />
            <Select name="kind" value={q.kind} autosubmit options={[['', 'All types'], ['subscription', 'Subscriptions'], ['product', 'Products'], ['ticket', 'Tickets'], ['gift', 'Gifts'], ['group', 'Groups'], ['sponsorship', 'Sponsorships'], ['replay', 'Replays']]} />
            <Select name="status" value={q.status} autosubmit options={[['', 'All statuses'], ['paid', 'Paid'], ['pending', 'Pending'], ['refunded', 'Refunded'], ['failed', 'Failed']]} />
            <Btn kind="secondary" small>Filter</Btn>
          </form>
        }>
          <Table rows={orders} empty="No orders match." cols={[
            { h: 'Date', r: (o) => <span class="nowrap">{fmtDateTime(o.created_at, pub.timezone)}</span> },
            { h: 'Buyer', r: (o) => (o.subscriber_id ? <a href={`/app/audience/s/${o.subscriber_id}`}>{o.name || o.email}<br /><small class="muted">{o.email}</small></a> : <>{o.name || o.email}<br /><small class="muted">{o.email}</small></>) },
            { h: 'Item', r: (o) => <>{o.item || '—'}<br /><small class="muted">{o.kind}{parseJSON<any>(o.data, {}).variant_name ? ` · ${parseJSON<any>(o.data, {}).variant_name}` : ''}</small></> },
            { h: 'Amount', r: (o) => <>{money(o.amount_cents, o.currency)}{o.offer_code && <><br /><small class="muted">code {o.offer_code}</small></>}</> },
            { h: 'Status', r: (o) => <Status s={o.status} /> },
            { h: '', class: 'right', r: (o) => <div class="row end">
              {o.status === 'paid' && <ActionForm action={`/app/monetize/orders/${o.id}/resend`} label="Resend" />}
              {o.status === 'paid' && o.amount_cents > 0 && <ActionForm action={`/app/monetize/orders/${o.id}/refund`} label="Refund" kind="danger" confirm={`Refund ${money(o.amount_cents, o.currency)} to ${o.email}?`} />}
            </div> },
          ]} />
        </Card>
      </DashLayout>,
    );
  });

  dash.get('/orders.csv', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const { where, params } = orderFilter(c.req.query());
    const rows = await all<any>(c.env, `SELECT o.*, ${ITEM_SQL} AS item FROM orders o LEFT JOIN products p ON p.id = o.ref_id LEFT JOIN tiers t ON t.id = o.ref_id LEFT JOIN live_events e ON e.id = o.ref_id LEFT JOIN sponsorship_products sp ON sp.id = o.ref_id WHERE ${where} ORDER BY o.created_at DESC`, pub.id, ...params);
    const csv = toCSV([['order_id', 'date', 'kind', 'item', 'email', 'name', 'amount', 'currency', 'platform_fee', 'status', 'stripe_payment_intent'], ...rows.map((o) => [o.id, new Date(o.created_at).toISOString(), o.kind, o.item, o.email, o.name, (o.amount_cents / 100).toFixed(2), o.currency, (o.platform_fee_cents / 100).toFixed(2), o.status, o.stripe_payment_intent])]);
    await audit(c, 'orders.export');
    return c.body(csv, 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="orders-${pub.slug}.csv"` });
  });

  dash.post('/orders/:id/refund', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const o = await one<any>(c.env, 'SELECT * FROM orders WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!o || o.status !== 'paid') return back(c, '/app/monetize/orders', 'Order not refundable.', 'err');
    if (stripeEnabled(c.env) && o.stripe_payment_intent) {
      try { await stripePost(c.env, 'refunds', { payment_intent: o.stripe_payment_intent }, settings(pub).stripe_account_id || undefined); }
      catch (e: any) { return back(c, '/app/monetize/orders', `Stripe refund failed: ${e.message}`, 'err'); }
    }
    await run(c.env, `UPDATE orders SET status = 'refunded' WHERE id = ?`, o.id);
    if (o.kind === 'product' || o.kind === 'replay') await run(c.env, 'UPDATE products SET sales_count = MAX(0, sales_count - 1), revenue_cents = MAX(0, revenue_cents - ?) WHERE id = ?', o.amount_cents, o.ref_id);
    if (o.kind === 'subscription' || o.kind === 'group') {
      const s = await one<any>(c.env, `SELECT * FROM subscriptions WHERE order_id = ? AND group_owner_id IS NULL`, o.id);
      if (s && s.status !== 'canceled') {
        const { cancelSubscription } = await import('../../lib/billing');
        await cancelSubscription(c.env, pub, s.id, true);
      }
    }
    await audit(c, 'order.refunded', o.id, { amount: o.amount_cents });
    await sendTransactional(c.env, o.email, `Refund issued — ${pub.name}`, `<p>We've refunded ${money(o.amount_cents, o.currency)} for order ${esc(o.id)}. It can take 5–10 days to appear on your statement.</p>`, pub);
    return back(c, '/app/monetize/orders', 'Order refunded');
  });

  dash.post('/orders/:id/resend', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const o = await one<any>(c.env, 'SELECT * FROM orders WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!o || o.status !== 'paid') return back(c, '/app/monetize/orders', 'Only paid orders can be resent.', 'err');
    const base = siteUrl(c.env, pub);
    const link = o.kind === 'gift' ? `${base}/gift/${o.delivery_token}` : o.kind === 'group' ? `${base}/group/${o.delivery_token}` : `${base}/order/${o.id}`;
    const d = parseJSON<any>(o.data, {});
    await sendTransactional(c.env, o.kind === 'gift' && d.recipient_email ? d.recipient_email : o.email, `Your ${pub.name} order`, `<p>Here's the link to your order${d.description ? ` for <strong>${esc(d.description)}</strong>` : ''}.</p>${button('Open your order', link)}`, pub);
    return back(c, '/app/monetize/orders', 'Delivery email resent');
  });
}

