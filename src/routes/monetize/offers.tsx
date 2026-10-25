/** @jsxImportSource hono/jsx */
// Discount offers, coupon & promo codes, custom group deals.
import type { Hono } from 'hono';
import type { AppEnv } from '../../types';
import { one, all, run, insert } from '../../lib/db';
import { requirePerm } from '../../lib/auth';
import { siteUrl } from '../../lib/pub';
import { sendTransactional, button } from '../../lib/email';
import { DashLayout } from '../../ui/layout';
import { Card, Table, Btn, Field, Input, Select, Status, Empty, Modal, OpenBtn, ActionForm, back, Grid } from '../../ui/components';
import { id, now, money, num, fmtDate, form, str, int, cents, token, esc } from '../../lib/util';

export function registerOffers(dash: Hono<AppEnv>) {
  dash.get('/offers', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const [offers, tiers, products, events] = await Promise.all([
      all<any>(c.env, 'SELECT * FROM offers WHERE pub_id = ? ORDER BY created_at DESC', pub.id),
      all<any>(c.env, `SELECT id, name FROM tiers WHERE pub_id = ? AND status != 'archived'`, pub.id),
      all<any>(c.env, `SELECT id, name, slug FROM products WHERE pub_id = ? AND status != 'archived'`, pub.id),
      all<any>(c.env, 'SELECT id, title FROM live_events WHERE pub_id = ? ORDER BY starts_at DESC LIMIT 50', pub.id),
    ]);
    const base = siteUrl(c.env, pub);
    const targetName = (o: any) => tiers.find((t) => t.id === o.target_id)?.name || products.find((t) => t.id === o.target_id)?.name || events.find((t) => t.id === o.target_id)?.title || '';
    const shareUrl = (o: any) => {
      const prod = products.find((p) => p.id === o.target_id);
      if (prod) return `${base}/shop/${prod.slug}?code=${encodeURIComponent(o.code)}`;
      if (o.applies_to === 'product') return `${base}/shop?code=${encodeURIComponent(o.code)}`;
      return `${base}/upgrade?code=${encodeURIComponent(o.code)}`;
    };
    return c.html(
      <DashLayout c={c} title="Offers & codes" section="monetize" sub="offers" actions={<OpenBtn target="#new-offer">+ New offer</OpenBtn>}>
        <Card pad={false}>
          <Table rows={offers} empty={<Empty title="No offers yet" body="Create discount offers, coupon and promotion codes for subscriptions, products and event tickets." action={<OpenBtn target="#new-offer">Create an offer</OpenBtn>} />} cols={[
            { h: 'Code', r: (o) => <><strong class="mono">{o.code}</strong><br /><small class="muted">{o.name}</small></> },
            { h: 'Discount', r: (o) => (o.percent_off ? `${o.percent_off}% off` : `${money(o.amount_off_cents)} off`) + (o.applies_to === 'subscription' || o.applies_to === 'all' ? ` · ${o.duration === 'repeating' ? `${o.duration_months} months` : o.duration}` : '') },
            { h: 'Applies to', r: (o) => <>{o.applies_to}{o.target_id && <><br /><small class="muted">{targetName(o)}</small></>}</> },
            { h: 'Redeemed', r: (o) => `${num(o.redemptions)}${o.max_redemptions ? ` / ${num(o.max_redemptions)}` : ''}` },
            { h: 'Expires', r: (o) => (o.expires_at ? <span class={o.expires_at < now() ? 'muted' : ''}>{fmtDate(o.expires_at)}</span> : 'Never') },
            { h: 'Status', r: (o) => <Status s={o.active && (!o.expires_at || o.expires_at > now()) ? 'active' : 'ended'} /> },
            { h: 'Share', r: (o) => <button type="button" class="btn btn-ghost btn-sm" data-copy={shareUrl(o)}>Copy link</button> },
            { h: '', class: 'right', r: (o) => <div class="row end">
              <ActionForm action={`/app/monetize/offers/${o.id}/toggle`} label={o.active ? 'Deactivate' : 'Activate'} />
              <ActionForm action={`/app/monetize/offers/${o.id}/delete`} label="Delete" kind="danger" confirm="Delete this offer?" />
            </div> },
          ]} />
        </Card>
        <Modal id="new-offer" title="New offer" wide>
          <form method="post" action="/app/monetize/offers">
            <Grid>
              <Field label="Code" hint="Letters and numbers, e.g. LAUNCH25"><Input name="code" required pattern="[A-Za-z0-9_-]{2,40}" placeholder="LAUNCH25" /></Field>
              <Field label="Internal name"><Input name="name" placeholder="Launch week" /></Field>
              <Field label="Percent off"><Input name="percent_off" type="number" min="0" max="100" placeholder="25" /></Field>
              <Field label="…or amount off"><Input name="amount_off" type="number" step="0.01" min="0" placeholder="5.00" /></Field>
              <Field label="Applies to"><Select name="applies_to" options={[['subscription', 'Paid subscriptions'], ['product', 'Digital products'], ['event', 'Event tickets'], ['all', 'Everything']]} /></Field>
              <Field label="Specific item (optional)"><Select name="target_id" options={[['', 'Any'], ...tiers.map((t) => [t.id, `Tier: ${t.name}`] as [string, string]), ...products.map((t) => [t.id, `Product: ${t.name}`] as [string, string]), ...events.map((t) => [t.id, `Event: ${t.title}`] as [string, string])]} /></Field>
              <Field label="Duration (subscriptions)"><Select name="duration" options={[['once', 'First payment only'], ['repeating', 'Several months'], ['forever', 'Forever']]} /></Field>
              <Field label="Months (if repeating)"><Input name="duration_months" type="number" min="1" value="3" /></Field>
              <Field label="Max redemptions" hint="Blank = unlimited"><Input name="max_redemptions" type="number" min="1" /></Field>
              <Field label="Expires"><Input name="expires" type="date" /></Field>
            </Grid>
            <div class="form-actions"><Btn>Create offer</Btn></div>
          </form>
        </Modal>
      </DashLayout>,
    );
  });

  dash.post('/offers', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const f = await form(c.req);
    const code = str(f.code, 40).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    const pctOff = Math.min(100, Math.max(0, int(f.percent_off)));
    const amt = cents(f.amount_off);
    if (!code) return back(c, '/app/monetize/offers', 'Enter a code.', 'err');
    if (!pctOff && !amt) return back(c, '/app/monetize/offers', 'Set a percent or amount off.', 'err');
    if (await one(c.env, 'SELECT 1 FROM offers WHERE pub_id = ? AND code = ? COLLATE NOCASE', pub.id, code)) return back(c, '/app/monetize/offers', 'That code already exists.', 'err');
    const exp = f.expires ? Date.parse(f.expires + 'T23:59:59Z') : null;
    await insert(c.env, 'offers', {
      id: id(), pub_id: pub.id, code, name: str(f.name, 80), applies_to: ['subscription', 'product', 'event', 'all'].includes(f.applies_to) ? f.applies_to : 'all', target_id: str(f.target_id) || null,
      percent_off: pctOff, amount_off_cents: pctOff ? 0 : amt, duration: ['once', 'repeating', 'forever'].includes(f.duration) ? f.duration : 'once', duration_months: f.duration === 'repeating' ? Math.max(1, int(f.duration_months, 1)) : null,
      max_redemptions: f.max_redemptions ? Math.max(1, int(f.max_redemptions)) : null, expires_at: exp && !isNaN(exp) ? exp : null, active: 1, created_at: now(),
    });
    return back(c, '/app/monetize/offers', `Offer ${code} created`);
  });

  dash.post('/offers/:id/toggle', requirePerm('manage'), async (c) => {
    await run(c.env, 'UPDATE offers SET active = 1 - active WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
    return back(c, '/app/monetize/offers', 'Offer updated');
  });
  dash.post('/offers/:id/delete', requirePerm('manage'), async (c) => {
    await run(c.env, 'DELETE FROM offers WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
    return back(c, '/app/monetize/offers', 'Offer deleted');
  });

  // ── custom group deals for teams & companies
  dash.get('/groups', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const tiers = await all<any>(c.env, `SELECT id, name, currency FROM tiers WHERE pub_id = ? AND status = 'active'`, pub.id);
    const deals = await all<any>(c.env, `SELECT d.*, t.name AS tier_name, t.currency FROM group_deals d LEFT JOIN tiers t ON t.id = d.tier_id WHERE d.pub_id = ? ORDER BY d.created_at DESC`, pub.id);
    const groups = await all<any>(c.env, `SELECT s.*, sb.email, t.name AS tier_name, o.delivery_token, (SELECT COUNT(*) FROM subscriptions m WHERE m.group_owner_id = s.id AND m.status = 'active') AS used FROM subscriptions s JOIN subscribers sb ON sb.id = s.subscriber_id LEFT JOIN tiers t ON t.id = s.tier_id LEFT JOIN orders o ON o.id = s.order_id WHERE s.pub_id = ? AND s.seats > 1 AND s.group_owner_id IS NULL ORDER BY s.created_at DESC`, pub.id);
    const base = siteUrl(c.env, pub);
    return c.html(
      <DashLayout c={c} title="Group subscriptions" section="monetize" sub="tiers" crumbs={[['/app/monetize', 'Paid subscriptions']]} actions={<OpenBtn target="#new-deal">+ Custom group deal</OpenBtn>}>
        <Card title="Active team plans" pad={false}>
          <Table rows={groups} empty="No group subscriptions yet. Enable groups on a tier to sell seats on your pricing page." cols={[
            { h: 'Buyer', r: (g) => <a href={`/app/audience/s/${g.subscriber_id}`}>{g.email}</a> },
            { h: 'Tier', r: (g) => g.tier_name },
            { h: 'Seats used', r: (g) => `${g.used + 1} / ${g.seats}` },
            { h: 'Status', r: (g) => <Status s={g.status} /> },
            { h: 'Join link', r: (g) => (g.delivery_token ? <button type="button" class="btn btn-ghost btn-sm" data-copy={`${base}/group/${g.delivery_token}`}>Copy</button> : '—') },
          ]} />
        </Card>
        <Card title="Custom deals" pad={false}>
          <Table rows={deals} empty="No custom deals yet." cols={[
            { h: 'Company', r: (d) => <>{d.company}<br /><small class="muted">{d.contact_email}</small></> },
            { h: 'Plan', r: (d) => `${d.tier_name} · ${d.seats} seats` },
            { h: 'Price', r: (d) => `${money(d.price_cents, d.currency)} / ${d.interval}` },
            { h: 'Status', r: (d) => <Status s={d.status === 'offered' ? 'pending' : d.status} /> },
            { h: 'Link', r: (d) => <button type="button" class="btn btn-ghost btn-sm" data-copy={`${base}/group/${d.token}`}>Copy</button> },
          ]} />
        </Card>
        <Modal id="new-deal" title="Custom group deal">
          <form method="post" action="/app/monetize/groups">
            <Field label="Company"><Input name="company" required /></Field>
            <Field label="Contact email" hint="We'll email them the offer link"><Input name="email" type="email" required /></Field>
            <Grid>
              <Field label="Tier"><Select name="tier_id" options={tiers.map((t) => [t.id, t.name] as [string, string])} /></Field>
              <Field label="Seats"><Input name="seats" type="number" min="2" value="10" /></Field>
              <Field label="Total price"><Input name="price" type="number" step="0.01" min="0" required /></Field>
              <Field label="Billing"><Select name="interval" options={[['year', 'Per year'], ['month', 'Per month']]} /></Field>
            </Grid>
            <div class="form-actions"><Btn>Create & send deal</Btn></div>
          </form>
        </Modal>
      </DashLayout>,
    );
  });

  dash.post('/groups', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const f = await form(c.req);
    const tier = await one<any>(c.env, 'SELECT * FROM tiers WHERE id = ? AND pub_id = ?', f.tier_id, pub.id);
    if (!tier) return back(c, '/app/monetize/groups', 'Create a paid tier first.', 'err');
    const tok = token(18);
    const price = cents(f.price);
    await insert(c.env, 'group_deals', { id: id(), pub_id: pub.id, company: str(f.company, 120), contact_email: str(f.email, 200).toLowerCase(), tier_id: tier.id, seats: Math.max(2, int(f.seats, 10)), price_cents: price, interval: f.interval === 'month' ? 'month' : 'year', token: tok, status: 'offered', created_at: now() });
    const url = `${siteUrl(c.env, pub)}/group/${tok}`;
    await sendTransactional(c.env, str(f.email), `A team subscription offer from ${pub.name}`, `<p>Hi ${esc(str(f.company))} team — here's your custom group plan for <strong>${esc(pub.name)}</strong>: ${int(f.seats)} seats of ${esc(tier.name)} for ${money(price, tier.currency)} per ${f.interval === 'month' ? 'month' : 'year'}.</p>${button('Review & accept', url)}`, pub);
    return back(c, '/app/monetize/groups', 'Deal created and emailed');
  });
}

