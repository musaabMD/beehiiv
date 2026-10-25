/** @jsxImportSource hono/jsx */
// Paid subscriptions: tiers, subscribers, MRR, metered paywall.
import type { Hono } from 'hono';
import type { AppEnv, Ctx } from '../../types';
import { one, all, run, insert, val } from '../../lib/db';
import { emit } from '../../lib/events';
import { requirePerm, can, audit } from '../../lib/auth';
import { settings, siteUrl } from '../../lib/pub';
import { stripeEnabled } from '../../lib/payments';
import { syncTierToStripe, pauseSubscription, resumeSubscription, cancelSubscription, reactivateSubscription, CURRENCIES, tierPrice } from '../../lib/billing';
import { DashLayout } from '../../ui/layout';
import { Card, Stats, Stat, Table, Btn, LinkBtn, Field, Input, Textarea, Select, Toggle, Status, Empty, Modal, OpenBtn, ActionForm, back, Grid, Badge, Copy } from '../../ui/components';
import { id, now, money, num, pct, fmtDate, form, str, int, cents, bool, parseJSON, DAY } from '../../lib/util';

export function StripeBanner({ c }: { c: Ctx }) {
  const pub = c.get('pub');
  const acct = settings(pub).stripe_account_id;
  if (!stripeEnabled(c.env))
    return <div class="callout warn"><strong>Test mode.</strong> No Stripe key is configured, so checkouts use the built-in simulator and no real money moves. Add <code>STRIPE_SECRET_KEY</code> and <code>STRIPE_WEBHOOK_SECRET</code> secrets (webhook URL: <code>{c.env.APP_URL}/hooks/stripe</code>) to accept real payments. <a href="/app/settings/billing">Payments settings →</a></div>;
  return <div class="callout ok"><strong>Stripe connected.</strong> {acct ? <>Payouts go to connected account <code>{acct}</code> via Stripe Connect.</> : 'Payments go to the platform Stripe account.'} OpenHive takes <strong>{Number(c.env.PLATFORM_FEE_PERCENT || 0)}% platform fees</strong>.</div>;
}

function tierForm(t: any | null, podcasts: any[], channels: any[]) {
  const perks = parseJSON<any>(t?.perks, {});
  return (
    <form method="post" action={t ? `/app/monetize/tiers/${t.id}` : '/app/monetize/tiers'}>
      <Grid>
        <Field label="Tier name"><Input name="name" value={t?.name} required placeholder="Premium" /></Field>
        <Field label="Currency"><Select name="currency" value={t?.currency || 'usd'} options={CURRENCIES.map((x) => [x, x.toUpperCase()] as [string, string])} /></Field>
        <Field label="Monthly price" hint="0 to disable monthly"><Input name="monthly" type="number" step="0.01" min="0" value={t ? (t.monthly_cents / 100).toFixed(2) : '8.00'} /></Field>
        <Field label="Annual price" hint="0 to disable annual"><Input name="annual" type="number" step="0.01" min="0" value={t ? (t.annual_cents / 100).toFixed(2) : '80.00'} /></Field>
        <Field label="Free trial (days)" hint="0 = no trial"><Input name="trial_days" type="number" min="0" value={t?.trial_days ?? 0} /></Field>
        <Field label="Paid trial price" hint="e.g. 1.00 for “$1 for 30 days” (uses trial days)"><Input name="paid_trial" type="number" step="0.01" min="0" value={t ? (t.paid_trial_cents / 100).toFixed(2) : '0'} /></Field>
      </Grid>
      <Field label="Description"><Textarea name="description" value={t?.description} rows={2} /></Field>
      <Field label="Benefits" hint="One per line — shown on the pricing page"><Textarea name="benefits" rows={4} value={parseJSON<string[]>(t?.benefits, ['Every premium post', 'Full archive access', 'Support independent writing']).join('\n')} /></Field>
      {podcasts.length > 0 && <Field label="Private podcast feeds included"><Select name="podcast_ids[]" multiple values={perks.podcast_ids || []} options={podcasts.map((p) => [p.id, p.title] as [string, string])} /></Field>}
      {channels.length > 0 && <Field label="Gated community channels included"><Select name="channel_ids[]" multiple values={perks.channel_ids || []} options={channels.map((p) => [p.id, p.name] as [string, string])} /></Field>}
      <Toggle name="group_enabled" checked={!!t?.group_enabled} label="Offer group subscriptions" hint="One buyer, many seats — billed per seat" />
      <Field label="Price per seat (per billing interval)"><Input name="group_seat" type="number" step="0.01" min="0" value={t ? (t.group_seat_cents / 100).toFixed(2) : '6.00'} /></Field>
      <div class="form-actions"><Btn>{t ? 'Save tier' : 'Create tier'}</Btn></div>
    </form>
  );
}

export function registerTiers(dash: Hono<AppEnv>) {
  dash.get('/', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const [tiers, podcasts, channels] = await Promise.all([
      all<any>(c.env, `SELECT t.*, (SELECT COUNT(*) FROM subscriptions s WHERE s.tier_id = t.id AND s.status IN ('active','trialing')) AS subs FROM tiers t WHERE t.pub_id = ? ORDER BY t.status = 'archived', t.position, t.created_at`, pub.id),
      all<any>(c.env, 'SELECT id, title FROM podcasts WHERE pub_id = ?', pub.id),
      all<any>(c.env, 'SELECT id, name FROM channels WHERE pub_id = ?', pub.id),
    ]);
    const counts = Object.fromEntries((await all<any>(c.env, `SELECT status, COUNT(*) AS n FROM subscriptions WHERE pub_id = ? GROUP BY status`, pub.id)).map((r) => [r.status, r.n]));
    const mrr = await val<number>(c.env, `SELECT COALESCE(SUM(CASE WHEN interval = 'year' THEN amount_cents / 12.0 ELSE amount_cents END), 0) FROM subscriptions WHERE pub_id = ? AND status = 'active' AND group_owner_id IS NULL`, pub.id);
    const canceled30 = await val<number>(c.env, `SELECT COUNT(*) FROM subscriptions WHERE pub_id = ? AND status = 'canceled' AND updated_at > ?`, pub.id, now() - 30 * DAY);
    const active = (counts.active || 0) + (counts.trialing || 0);
    const status = c.req.query('status') || '';
    const subs = await all<any>(c.env, `SELECT s.*, sb.email, sb.name, t.name AS tier_name FROM subscriptions s JOIN subscribers sb ON sb.id = s.subscriber_id LEFT JOIN tiers t ON t.id = s.tier_id WHERE s.pub_id = ? ${status ? 'AND s.status = ?' : ''} ORDER BY s.updated_at DESC LIMIT 200`, pub.id, ...(status ? [status] : []));
    const meter = Number(settings(pub).paywall_meter || 0);
    const cur = tiers[0]?.currency || 'usd';
    const admin = can(c.get('role'), 'admin');
    return c.html(
      <DashLayout c={c} title="Paid subscriptions" section="monetize" sub="tiers" actions={<>{admin && <OpenBtn target="#new-tier">+ New tier</OpenBtn>}<LinkBtn href={`${siteUrl(c.env, pub)}/upgrade`} target="_blank">View pricing page</LinkBtn></>}>
        <StripeBanner c={c} />
        <Stats>
          <Stat label="MRR" value={money(Math.round(mrr), cur)} sub={`ARR ${money(Math.round(mrr * 12), cur)}`} />
          <Stat label="Paid subscribers" value={num(counts.active || 0)} sub={`${num(counts.trialing || 0)} trialing`} />
          <Stat label="Paused" value={num(counts.paused || 0)} sub={`${num(counts.past_due || 0)} past due`} />
          <Stat label="Churn (30d)" value={pct(canceled30, active + canceled30)} sub={`${num(canceled30)} canceled`} />
        </Stats>
        <Card title="Tiers" actions={admin ? <OpenBtn target="#new-tier" kind="secondary" small>+ New tier</OpenBtn> : null} pad={false}>
          <Table rows={tiers} empty={<Empty title="No paid tiers yet" body="Create a tier to start earning from premium posts, private podcast feeds and gated community channels — with 0% platform fees." action={admin ? <OpenBtn target="#new-tier">Create your first tier</OpenBtn> : null} />} cols={[
            { h: 'Tier', r: (t) => <><a href={`/app/monetize/tiers/${t.id}`}>{t.name}</a>{t.group_enabled ? <> <Badge tone="blue">groups</Badge></> : null}</> },
            { h: 'Monthly', r: (t) => (t.monthly_cents ? money(t.monthly_cents, t.currency) : '—') },
            { h: 'Annual', r: (t) => (t.annual_cents ? money(t.annual_cents, t.currency) : '—') },
            { h: 'Trial', r: (t) => (t.trial_days ? `${t.trial_days} days${t.paid_trial_cents ? ` for ${money(t.paid_trial_cents, t.currency)}` : ' free'}` : '—') },
            { h: 'Subscribers', r: (t) => num(t.subs) },
            { h: 'Status', r: (t) => <Status s={t.status} /> },
            { h: '', class: 'right', r: (t) => admin ? <div class="row end">
              {t.status === 'active' && <ActionForm action={`/app/monetize/tiers/${t.id}/status`} fields={{ status: 'paused' }} label="Pause" />}
              {t.status === 'paused' && <ActionForm action={`/app/monetize/tiers/${t.id}/status`} fields={{ status: 'active' }} label="Resume" />}
              {t.status !== 'archived' && <ActionForm action={`/app/monetize/tiers/${t.id}/status`} fields={{ status: 'archived' }} label="Archive" kind="danger" confirm="Archive this tier? Existing subscribers keep access until they cancel." />}
              {t.status === 'archived' && t.subs === 0 && <ActionForm action={`/app/monetize/tiers/${t.id}/delete`} label="Delete" kind="danger" confirm="Delete permanently?" />}
            </div> : null },
          ]} />
        </Card>
        <Grid>
          <Card title="Metered paywall">
            <form method="post" action="/app/monetize/paywall">
              <Field label="Free premium posts per reader every 30 days" hint="New York Times–style meter. 0 = hard paywall at every paywall break."><Input name="meter" type="number" min="0" max="50" value={meter} /></Field>
              <Btn kind="secondary">Save meter</Btn>
            </form>
          </Card>
          <Card title="Growth tools">
            <ul class="list-plain">
              <li><a href="/app/monetize/offers">Discount offers & promo codes</a> — percent or amount off, once / repeating / forever</li>
              <li><a href={`${siteUrl(c.env, pub)}/gift`} target="_blank">Gift subscriptions page</a></li>
              <li><a href="/app/monetize/groups">Group deals for teams & companies</a></li>
            </ul>
          </Card>
        </Grid>
        <Card title="Subscriptions" actions={<form method="get" class="row"><Select name="status" value={status} autosubmit options={[['', 'All statuses'], ['active', 'Active'], ['trialing', 'Trialing'], ['paused', 'Paused'], ['past_due', 'Past due'], ['canceled', 'Canceled']]} /></form>} pad={false}>
          <Table rows={subs} empty="No subscriptions yet." cols={[
            { h: 'Subscriber', r: (s) => <a href={`/app/audience/s/${s.subscriber_id}`}>{s.name || s.email}<br /><small class="muted">{s.email}</small></a> },
            { h: 'Plan', r: (s) => <>{s.tier_name || '—'} <small class="muted">{s.interval === 'year' ? 'annual' : 'monthly'}</small>{s.seats > 1 && <> <Badge tone="blue">{s.seats} seats</Badge></>}{s.group_owner_id && <> <Badge>team seat</Badge></>}{s.gift_from_email && <> <Badge tone="purple">gift</Badge></>}</> },
            { h: 'Amount', r: (s) => (s.amount_cents ? `${money(s.amount_cents, s.currency)}/${s.interval === 'year' ? 'yr' : 'mo'}` : '—') },
            { h: 'Status', r: (s) => <><Status s={s.status} />{s.cancel_at_period_end && s.status !== 'canceled' ? <> <Badge tone="amber">cancels {fmtDate(s.current_period_end)}</Badge></> : null}</> },
            { h: 'Renews / ends', r: (s) => (s.status === 'trialing' ? `trial ends ${fmtDate(s.trial_ends_at)}` : fmtDate(s.current_period_end)) },
            { h: '', class: 'right', r: (s) => admin && !s.group_owner_id ? <div class="row end">
              {['active', 'trialing', 'past_due'].includes(s.status) && <ActionForm action={`/app/monetize/subscriptions/${s.id}/pause`} label="Pause" />}
              {s.status === 'paused' && <ActionForm action={`/app/monetize/subscriptions/${s.id}/resume`} label="Resume" />}
              {s.cancel_at_period_end && s.status !== 'canceled' ? <ActionForm action={`/app/monetize/subscriptions/${s.id}/reactivate`} label="Undo cancel" /> : null}
              {s.status !== 'canceled' && !s.cancel_at_period_end && <ActionForm action={`/app/monetize/subscriptions/${s.id}/cancel`} label="Cancel" kind="danger" confirm="Cancel at the end of the current period?" />}
            </div> : null },
          ]} />
        </Card>
        <Modal id="new-tier" title="New paid tier" wide>{tierForm(null, podcasts, channels)}</Modal>
      </DashLayout>,
    );
  });

  dash.get('/tiers/:id', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const t = await one<any>(c.env, 'SELECT * FROM tiers WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!t) return c.notFound();
    const [podcasts, channels] = await Promise.all([all<any>(c.env, 'SELECT id, title FROM podcasts WHERE pub_id = ?', pub.id), all<any>(c.env, 'SELECT id, name FROM channels WHERE pub_id = ?', pub.id)]);
    const base = siteUrl(c.env, pub);
    return c.html(
      <DashLayout c={c} title={t.name} section="monetize" sub="tiers" crumbs={[['/app/monetize', 'Paid subscriptions']]}>
        <div class="split">
          <Card title="Tier settings">{tierForm(t, podcasts, channels)}</Card>
          <div>
            <Card title="Checkout links">
              <Field label="Monthly"><Copy value={`${base}/upgrade?tier=${t.id}&interval=month`} /></Field>
              <Field label="Annual"><Copy value={`${base}/upgrade?tier=${t.id}&interval=year`} /></Field>
              {t.group_enabled ? <Field label="Team / group"><Copy value={`${base}/upgrade?tier=${t.id}&group=1`} /></Field> : null}
            </Card>
            <Card title="Stripe">
              {t.stripe_product_id ? <p>Product <code>{t.stripe_product_id}</code></p> : <p class="muted">{stripeEnabled(c.env) ? 'Not synced yet — save to sync.' : 'Synced automatically when Stripe is configured.'}</p>}
            </Card>
          </div>
        </div>
      </DashLayout>,
    );
  });

  const readTier = (f: Record<string, any>) => ({
    name: str(f.name, 80) || 'Premium', description: str(f.description, 1000), currency: CURRENCIES.includes(f.currency) ? f.currency : 'usd',
    monthly_cents: cents(f.monthly), annual_cents: cents(f.annual), trial_days: Math.max(0, int(f.trial_days)), paid_trial_cents: cents(f.paid_trial),
    benefits: JSON.stringify(str(f.benefits, 4000).split('\n').map((x) => x.trim()).filter(Boolean)),
    perks: JSON.stringify({ podcast_ids: f.podcast_ids || [], channel_ids: f.channel_ids || [] }),
    group_enabled: bool(f.group_enabled) ? 1 : 0, group_seat_cents: cents(f.group_seat),
  });

  dash.post('/tiers', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const t = readTier(await form(c.req));
    if (!t.monthly_cents && !t.annual_cents) return back(c, '/app/monetize', 'Set a monthly or annual price.', 'err');
    const tid = id();
    const pos = await val<number>(c.env, 'SELECT COALESCE(MAX(position), 0) + 1 FROM tiers WHERE pub_id = ?', pub.id);
    await insert(c.env, 'tiers', { id: tid, pub_id: pub.id, ...t, status: 'active', position: pos, created_at: now() });
    await emit(c.env, { pubId: pub.id, type: 'tier.created', refId: tid, data: { tier: { id: tid, ...t } }, activity: false });
    await audit(c, 'tier.created', tid);
    try { await syncTierToStripe(c.env, pub, tid); } catch (e: any) { return back(c, '/app/monetize', `Tier created, but Stripe sync failed: ${e.message}`, 'err'); }
    return back(c, '/app/monetize', 'Tier created');
  });

  dash.post('/tiers/:id', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const t = readTier(await form(c.req));
    const tid = c.req.param('id');
    const cols = Object.keys(t);
    await run(c.env, `UPDATE tiers SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND pub_id = ?`, ...cols.map((k) => (t as any)[k]), tid, pub.id);
    try { await syncTierToStripe(c.env, pub, tid); } catch (e: any) { return back(c, `/app/monetize/tiers/${tid}`, `Saved, but Stripe sync failed: ${e.message}`, 'err'); }
    return back(c, `/app/monetize/tiers/${tid}`, 'Tier saved');
  });

  dash.post('/tiers/:id/status', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const status = str((await form(c.req)).status);
    if (!['active', 'paused', 'archived'].includes(status)) return back(c, '/app/monetize');
    const t = await one<any>(c.env, 'SELECT * FROM tiers WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!t) return c.notFound();
    await run(c.env, 'UPDATE tiers SET status = ? WHERE id = ?', status, t.id);
    const type = status === 'paused' ? 'tier.paused' : status === 'archived' ? 'tier.deleted' : 'tier.resumed';
    await emit(c.env, { pubId: pub.id, type, refId: t.id, data: { tier: { id: t.id, name: t.name, status } }, activity: false });
    if (status === 'archived') try { await syncTierToStripe(c.env, pub, t.id); } catch {}
    return back(c, '/app/monetize', `Tier ${status === 'active' ? 'resumed' : status}`);
  });

  dash.post('/tiers/:id/delete', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const t = await one<any>(c.env, 'SELECT * FROM tiers WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!t) return c.notFound();
    const used = await val<number>(c.env, 'SELECT COUNT(*) FROM subscriptions WHERE tier_id = ?', t.id);
    if (used) {
      await run(c.env, `UPDATE tiers SET status = 'archived' WHERE id = ?`, t.id);
      return back(c, '/app/monetize', 'This tier has subscription history, so it was archived instead of deleted.');
    }
    await run(c.env, 'DELETE FROM tiers WHERE id = ?', t.id);
    await emit(c.env, { pubId: pub.id, type: 'tier.deleted', refId: t.id, data: { tier: { id: t.id, name: t.name } }, activity: false });
    return back(c, '/app/monetize', 'Tier deleted');
  });

  dash.post('/paywall', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const meter = Math.max(0, Math.min(50, int((await form(c.req)).meter)));
    const s = { ...settings(pub), paywall_meter: meter };
    await run(c.env, 'UPDATE publications SET settings = ? WHERE id = ?', JSON.stringify(s), pub.id);
    return back(c, '/app/monetize', meter ? `Metered paywall: ${meter} free premium posts per 30 days` : 'Hard paywall enabled');
  });

  for (const action of ['pause', 'resume', 'cancel', 'reactivate'] as const) {
    dash.post(`/subscriptions/:id/${action}`, requirePerm('admin'), async (c) => {
      const pub = c.get('pub');
      const sid = c.req.param('id');
      try {
        const ok = action === 'pause' ? await pauseSubscription(c.env, pub, sid) : action === 'resume' ? await resumeSubscription(c.env, pub, sid) : action === 'cancel' ? await cancelSubscription(c.env, pub, sid, false) : await reactivateSubscription(c.env, pub, sid);
        await audit(c, `subscription.${action}`, sid);
        return back(c, c.req.header('referer') || '/app/monetize', ok ? `Subscription ${action === 'reactivate' ? 'reactivated' : action + (action.endsWith('e') ? 'd' : 'ed')}` : 'Nothing to change');
      } catch (e: any) {
        return back(c, '/app/monetize', `Stripe error: ${e.message}`, 'err');
      }
    });
  }
}

export { tierPrice };
