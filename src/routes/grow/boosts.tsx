/** @jsxImportSource hono/jsx */
// Boosts = paid recommendations. Advertisers pay a CPA per verified subscriber; publishers earn by recommending.
// Conversions are held 7 days, fraud-scored, then verified (paid to the partner's wallet) or rejected;
// verified subscribers that later bounce/complain within 30 days are clawed back.
import type { App, Env, Publication } from '../../types';
import { all, one, run, val, insert } from '../../lib/db';
import { requirePerm, audit } from '../../lib/auth';
import { onEvent } from '../../lib/events';
import { registerPeriodic } from '../../lib/jobs';
import { DISPOSABLE, rateLimit, clientIP, botScore } from '../../lib/guard';
import { subscribe } from '../../lib/subscribers';
import { siteUrl, getPub } from '../../lib/pub';
import { sendTransactional } from '../../lib/email';
import { trackView } from '../../lib/tracking';
import { DashLayout } from '../../ui/layout';
import { SiteLayout, SiteMessage, SubscribeForm } from '../../ui/site';
import { Card, Table, Btn, Field, Input, Textarea, Modal, OpenBtn, ActionForm, Status, Empty, back, Help, Stats, Stat, Copy, Check, Badge, Grid } from '../../ui/components';
import { id, now, form, str, cents, money, num, pct, ago, truncate, bool, domainOf, DAY, HOUR, esc } from '../../lib/util';
import { pubAdminEmails } from './shared';

const HOLD_DAYS = 7;
const CLAWBACK_DAYS = 30;

/** Fraud score 0-100 for a boost-attributed subscriber. ≥60 = flagged. */
export async function fraudScore(env: Env, sub: any): Promise<number> {
  let score = 0;
  const domain = domainOf(sub.email);
  if (DISPOSABLE.has(domain)) score += 70;
  const local = sub.email.split('@')[0];
  if ((local.match(/\d/g) || []).length >= 6) score += 15;
  if (/^[a-z]{1,2}\d{5,}$/.test(local) || /(.)\1{4,}/.test(local)) score += 15;
  if (sub.ip) {
    const sameIp = await val<number>(env, 'SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND ip = ? AND created_at > ?', sub.pub_id, sub.ip, now() - HOUR);
    if (sameIp > 3) score += 40;
    else if (sameIp > 1) score += 10;
  }
  if (sub.source_detail) {
    // burst: many signups from the same partner in a few minutes
    const burst = await val<number>(env, `SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND source = 'boost' AND source_detail = ? AND created_at > ?`, sub.pub_id, sub.source_detail, now() - 5 * 60_000);
    if (burst > 20) score += 30;
  }
  return Math.min(100, score);
}

/** Record a pending conversion when a boost-attributed subscriber is created. */
onEvent(async (env, e) => {
  if (e.type !== 'subscription.created' || !e.subscriberId) return;
  const d: any = e.data || {};
  if (d.source !== 'boost' || !d.source_detail || d.reactivated || d.resubscribed) return;
  const partner = await one<any>(env, `SELECT bp.*, o.cpa_cents, o.pub_id AS adv_pub_id, o.status AS offer_status, o.budget_cents, o.spent_cents FROM boost_partners bp JOIN boost_offers o ON o.id = bp.offer_id WHERE bp.id = ?`, d.source_detail);
  if (!partner || partner.adv_pub_id !== e.pubId || partner.status !== 'active' || partner.offer_status !== 'active') return;
  if (await one(env, 'SELECT 1 FROM boost_conversions WHERE subscriber_id = ?', e.subscriberId)) return;
  const sub = await one<any>(env, 'SELECT * FROM subscribers WHERE id = ?', e.subscriberId);
  if (!sub) return;
  const score = await fraudScore(env, sub);
  await insert(env, 'boost_conversions', { id: id(), partner_id: partner.id, subscriber_id: sub.id, amount_cents: partner.cpa_cents, status: 'pending', fraud_score: score, created_at: now() });
  await run(env, `UPDATE boost_partners SET subscribers = subscribers + 1, flagged = flagged + ? WHERE id = ?`, score >= 60 ? 1 : 0, partner.id);
});

/** Verify matured conversions, pay partners, claw back fakes. Exported for tests/admin. */
export async function verifyBoosts(env: Env, pubId?: string): Promise<{ verified: number; rejected: number; clawed: number }> {
  const res = { verified: 0, rejected: 0, clawed: 0 };
  const due = await all<any>(env, `SELECT bc.*, bp.offer_id, bp.partner_pub_id, o.pub_id AS adv_pub_id, o.budget_cents, o.spent_cents, s.status AS sub_status, s.open_count, s.click_count
    FROM boost_conversions bc JOIN boost_partners bp ON bp.id = bc.partner_id JOIN boost_offers o ON o.id = bp.offer_id LEFT JOIN subscribers s ON s.id = bc.subscriber_id
    WHERE bc.status = 'pending' AND bc.created_at <= ? ${pubId ? 'AND o.pub_id = ?' : ''} LIMIT 500`, now() - HOLD_DAYS * DAY, ...(pubId ? [pubId] : []));
  for (const c of due) {
    const offer = await one<any>(env, 'SELECT * FROM boost_offers WHERE id = ?', c.offer_id);
    const budgetLeft = !offer.budget_cents || offer.spent_cents + c.amount_cents <= offer.budget_cents;
    const genuine = c.sub_status === 'active' && c.fraud_score < 60 && (c.open_count > 0 || c.click_count > 0);
    if (genuine && budgetLeft) {
      await run(env, `UPDATE boost_conversions SET status = 'verified' WHERE id = ?`, c.id);
      await run(env, 'UPDATE boost_offers SET spent_cents = spent_cents + ? WHERE id = ?', c.amount_cents, c.offer_id);
      await run(env, 'UPDATE boost_partners SET verified_subscribers = verified_subscribers + 1, earned_cents = earned_cents + ? WHERE id = ?', c.amount_cents, c.partner_id);
      await insert(env, 'wallet_entries', { id: id(), pub_id: c.partner_pub_id, kind: 'boost', ref_id: c.id, amount_cents: c.amount_cents, status: 'available', note: 'Boost: verified subscriber', created_at: now() });
      res.verified++;
      if (offer.budget_cents && offer.spent_cents + c.amount_cents * 2 > offer.budget_cents) await run(env, `UPDATE boost_offers SET status = 'paused' WHERE id = ? AND status = 'active'`, offer.id);
    } else {
      await run(env, `UPDATE boost_conversions SET status = 'clawed_back' WHERE id = ?`, c.id);
      await run(env, 'UPDATE boost_partners SET flagged = flagged + ? WHERE id = ?', c.fraud_score >= 60 || c.sub_status !== 'active' ? 1 : 0, c.partner_id);
      res.rejected++;
    }
  }
  // claw back verified conversions whose subscriber turned out fake (bounced/complained) within 30 days
  const fakes = await all<any>(env, `SELECT bc.*, bp.offer_id, bp.partner_pub_id FROM boost_conversions bc JOIN boost_partners bp ON bp.id = bc.partner_id JOIN boost_offers o ON o.id = bp.offer_id JOIN subscribers s ON s.id = bc.subscriber_id
    WHERE bc.status = 'verified' AND bc.created_at > ? AND s.status IN ('bounced','complained') ${pubId ? 'AND o.pub_id = ?' : ''} LIMIT 500`, now() - CLAWBACK_DAYS * DAY, ...(pubId ? [pubId] : []));
  for (const c of fakes) {
    await clawback(env, c);
    res.clawed++;
  }
  return res;
}

async function clawback(env: Env, c: any) {
  await run(env, `UPDATE boost_conversions SET status = 'clawed_back' WHERE id = ? AND status = 'verified'`, c.id);
  await run(env, 'UPDATE boost_offers SET spent_cents = MAX(0, spent_cents - ?) WHERE id = ?', c.amount_cents, c.offer_id);
  await run(env, 'UPDATE boost_partners SET clawed_back_cents = clawed_back_cents + ?, flagged = flagged + 1 WHERE id = ?', c.amount_cents, c.partner_id);
  await insert(env, 'wallet_entries', { id: id(), pub_id: c.partner_pub_id, kind: 'clawback', ref_id: c.id, amount_cents: -c.amount_cents, status: 'available', note: 'Boost clawback: fake subscriber', created_at: now() });
}

registerPeriodic('boosts.verify', HOUR, async (env) => {
  await verifyBoosts(env);
});

const partnerLink = (env: Env, adv: { slug: string; custom_domain: string | null }, partnerId: string) => `${siteUrl(env, adv)}/b/${partnerId}`;

export function registerBoosts(dash: App, site: App) {
  dash.get('/boosts', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const offers = await all<any>(c.env, `SELECT o.*, (SELECT COUNT(*) FROM boost_partners bp WHERE bp.offer_id = o.id AND bp.status = 'active') AS active_partners, (SELECT COUNT(*) FROM boost_partners bp WHERE bp.offer_id = o.id AND bp.status = 'applied') AS applications, (SELECT COALESCE(SUM(subscribers),0) FROM boost_partners bp WHERE bp.offer_id = o.id) AS subs FROM boost_offers o WHERE o.pub_id = ? ORDER BY o.created_at DESC`, pub.id);
    const market = await all<any>(c.env, `SELECT o.*, p.name, p.description, p.category, p.slug, p.custom_domain, (SELECT COUNT(*) FROM subscribers s WHERE s.pub_id = p.id AND s.status = 'active') AS subs FROM boost_offers o JOIN publications p ON p.id = o.pub_id
      WHERE o.status = 'active' AND o.pub_id != ? AND NOT EXISTS (SELECT 1 FROM boost_partners bp WHERE bp.offer_id = o.id AND bp.partner_pub_id = ?) AND (o.budget_cents = 0 OR o.spent_cents < o.budget_cents) ORDER BY o.cpa_cents DESC LIMIT 50`, pub.id, pub.id);
    const mine = await all<any>(c.env, `SELECT bp.*, o.cpa_cents, o.status AS offer_status, p.name, p.slug, p.custom_domain, (SELECT COUNT(*) FROM boost_conversions bc WHERE bc.partner_id = bp.id AND bc.status = 'pending') AS pending FROM boost_partners bp JOIN boost_offers o ON o.id = bp.offer_id JOIN publications p ON p.id = o.pub_id WHERE bp.partner_pub_id = ? ORDER BY bp.created_at DESC`, pub.id);
    const earned = await val<number>(c.env, `SELECT COALESCE(SUM(amount_cents),0) FROM wallet_entries WHERE pub_id = ? AND kind IN ('boost','clawback')`, pub.id);
    const spent = offers.reduce((n, o) => n + o.spent_cents, 0);
    return c.html(
      <DashLayout c={c} title="Boosts" section="grow" sub="boosts" actions={<OpenBtn target="#new-offer">+ Create boost offer</OpenBtn>}>
        <Help>Boosts are paid recommendations. <strong>Grow</strong>: pay other newsletters a fixed amount for every verified subscriber they send you. <strong>Earn</strong>: get paid to recommend other newsletters in your signup flow. Subscribers are held {HOLD_DAYS} days and fraud-checked before payout; fakes are clawed back.</Help>
        <Stats>
          <Stat label="Spent on boosts" value={money(spent)} />
          <Stat label="Subscribers from boosts" value={num(offers.reduce((n, o) => n + (o.subs || 0), 0))} />
          <Stat label="Earned from boosts" value={money(earned)} href="/app/monetize/wallet" />
          <Stat label="Active partnerships" value={num(mine.filter((m) => m.status === 'active').length)} />
        </Stats>
        <Card title="Grow: your boost offers" pad={false}>
          <Table rows={offers} rowHref={(o) => `/app/grow/boosts/offers/${o.id}`} empty={<Empty title="No boost offers" body="Create an offer to let other newsletters recommend you for a fee per verified subscriber." action={<OpenBtn target="#new-offer">Create boost offer</OpenBtn>} />} cols={[
            { h: 'Offer', r: (o) => <><a href={`/app/grow/boosts/offers/${o.id}`}>{money(o.cpa_cents)} per subscriber</a><div class="muted small">{truncate(o.description, 80)}</div></> },
            { h: 'Status', r: (o) => <Status s={o.status} /> },
            { h: 'Partners', r: (o) => <>{o.active_partners}{o.applications ? <> <Badge tone="amber">{o.applications} new</Badge></> : null}</> },
            { h: 'Subscribers', class: 'right', r: (o) => num(o.subs) },
            { h: 'Spend', class: 'right', r: (o) => <>{money(o.spent_cents)}{o.budget_cents ? <span class="muted"> / {money(o.budget_cents)}</span> : null}</> },
          ]} />
        </Card>
        <Card title="Earn: your partnerships" pad={false}>
          <Table rows={mine} empty="You haven't applied to any boosts yet. Browse the marketplace below." cols={[
            { h: 'Newsletter', r: (m) => <strong>{m.name}</strong> },
            { h: 'Pays', r: (m) => `${money(m.cpa_cents)} / subscriber` },
            { h: 'Status', r: (m) => <Status s={m.status === 'active' && m.offer_status !== 'active' ? m.offer_status : m.status} /> },
            { h: 'Sent', class: 'right', r: (m) => <>{num(m.subscribers)}<div class="muted small">{num(m.verified_subscribers)} verified · {num(m.pending)} pending</div></> },
            { h: 'Earned', class: 'right', r: (m) => <>{money(m.earned_cents - m.clawed_back_cents)}{m.clawed_back_cents ? <div class="muted small">−{money(m.clawed_back_cents)} clawed back</div> : null}</> },
            { h: 'Your boost link', r: (m) => (m.status === 'active' ? <Copy value={partnerLink(c.env, m, m.id)} /> : <span class="muted small">{m.status === 'applied' ? 'Awaiting approval' : '—'}</span>) },
            { h: '', class: 'right nowrap', r: (m) => (['active', 'paused'].includes(m.status) ? <>{m.status === 'active' ? <ActionForm action={`/app/grow/boosts/partners/${m.id}/status`} fields={{ status: 'paused' }} label="Pause" /> : <ActionForm action={`/app/grow/boosts/partners/${m.id}/status`} fields={{ status: 'active' }} label="Resume" />}<ActionForm action={`/app/grow/boosts/partners/${m.id}/status`} fields={{ status: 'ended' }} label="End" kind="danger" confirm="End this partnership?" /></> : null) },
          ]} />
          <div class="card-b"><Help>Active boosts appear automatically on your <a href={`${siteUrl(c.env, pub)}/recommendations`} target="_blank">signup recommendations page</a>. You can also share your boost link anywhere.</Help></div>
        </Card>
        <Card title="Marketplace: boosts you can apply to" pad={false}>
          <Table rows={market} empty="No open boost offers right now." cols={[
            { h: 'Newsletter', r: (m) => <><strong>{m.name}</strong> {m.category && <Badge>{m.category}</Badge>}<div class="muted small">{truncate(m.description || m.description, 100)}</div></> },
            { h: 'Pays', r: (m) => <strong>{money(m.cpa_cents)}</strong> },
            { h: 'Their audience', class: 'right', r: (m) => num(m.subs) },
            { h: 'Budget left', class: 'right', r: (m) => (m.budget_cents ? money(m.budget_cents - m.spent_cents) : 'Unlimited') },
            { h: '', class: 'right', r: (m) => <ActionForm action={`/app/grow/boosts/offers/${m.id}/apply`} label={m.auto_accept ? 'Start earning' : 'Apply'} kind="primary" /> },
          ]} />
        </Card>
        <Modal id="new-offer" title="Create a boost offer">
          <form method="post" action="/app/grow/boosts/offers">
            <Grid cols={2}>
              <Field label="Pay per verified subscriber (USD)"><Input name="cpa" type="number" step="0.01" min="0.5" value="2.00" required /></Field>
              <Field label="Total budget (USD)" hint="0 = unlimited"><Input name="budget" type="number" step="1" min="0" value="200" /></Field>
            </Grid>
            <Field label="Pitch to partners"><Textarea name="description" rows={3} placeholder="Why should other newsletters recommend you?" /></Field>
            <Check name="auto_accept" label="Auto-accept applications" hint="Otherwise you approve each partner." />
            <div class="form-actions"><Btn>Create offer</Btn></div>
          </form>
        </Modal>
      </DashLayout>,
    );
  });

  dash.post('/boosts/offers', requirePerm('admin'), async (c) => {
    const f = await form(c.req);
    const cpa = cents(f.cpa);
    if (cpa < 50) return back(c, '/app/grow/boosts', 'Minimum is $0.50 per subscriber', 'err');
    const oid = id();
    await insert(c.env, 'boost_offers', { id: oid, pub_id: c.get('pub').id, cpa_cents: cpa, budget_cents: cents(f.budget), description: str(f.description, 600), auto_accept: bool(f.auto_accept), status: 'active', created_at: now() });
    await audit(c, 'boost_offer.create', oid, { cpa });
    return back(c, `/app/grow/boosts/offers/${oid}`, 'Boost offer created — it is now listed in the marketplace');
  });

  dash.get('/boosts/offers/:id', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const o = await one<any>(c.env, 'SELECT * FROM boost_offers WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!o) return c.notFound();
    const partners = await all<any>(c.env, `SELECT bp.*, p.name, p.slug, p.description,
        (SELECT COUNT(*) FROM deliveries d JOIN subscribers s ON s.id = d.subscriber_id WHERE s.pub_id = ? AND s.source = 'boost' AND s.source_detail = bp.id AND d.status = 'sent') AS delivered,
        (SELECT COUNT(*) FROM deliveries d JOIN subscribers s ON s.id = d.subscriber_id WHERE s.pub_id = ? AND s.source = 'boost' AND s.source_detail = bp.id AND d.opened_at IS NOT NULL) AS opened,
        (SELECT COUNT(*) FROM subscribers s WHERE s.pub_id = ? AND s.source = 'boost' AND s.source_detail = bp.id AND s.status = 'active') AS still_active,
        (SELECT COUNT(*) FROM boost_conversions bc WHERE bc.partner_id = bp.id AND bc.status = 'pending') AS pending
      FROM boost_partners bp JOIN publications p ON p.id = bp.partner_pub_id WHERE bp.offer_id = ? ORDER BY bp.status = 'applied' DESC, bp.created_at DESC`, pub.id, pub.id, pub.id, o.id);
    const convs = await all<any>(c.env, `SELECT bc.*, s.email, p.name AS partner FROM boost_conversions bc JOIN boost_partners bp ON bp.id = bc.partner_id JOIN publications p ON p.id = bp.partner_pub_id LEFT JOIN subscribers s ON s.id = bc.subscriber_id WHERE bp.offer_id = ? ORDER BY bc.created_at DESC LIMIT 50`, o.id);
    return c.html(
      <DashLayout c={c} title={`Boost: ${money(o.cpa_cents)} per subscriber`} section="grow" sub="boosts" crumbs={[['/app/grow/boosts', 'Boosts']]} actions={<>
        {o.status === 'active' ? <ActionForm action={`/app/grow/boosts/offers/${o.id}/status`} fields={{ status: 'paused' }} label="Pause offer" small={false} /> : o.status !== 'ended' ? <ActionForm action={`/app/grow/boosts/offers/${o.id}/status`} fields={{ status: 'active' }} label="Resume offer" small={false} /> : null}
        {o.status !== 'ended' && <ActionForm action={`/app/grow/boosts/offers/${o.id}/status`} fields={{ status: 'ended' }} label="End offer" kind="danger" confirm="End this offer for all partners?" small={false} />}
      </>}>
        <Stats>
          <Stat label="Status" value={<Status s={o.status} />} />
          <Stat label="Spent" value={money(o.spent_cents)} sub={o.budget_cents ? `of ${money(o.budget_cents)} budget` : 'Unlimited budget'} />
          <Stat label="Subscribers" value={num(partners.reduce((n, p) => n + p.subscribers, 0))} sub={`${num(partners.reduce((n, p) => n + p.verified_subscribers, 0))} verified`} />
          <Stat label="Flagged as suspicious" value={num(partners.reduce((n, p) => n + p.flagged, 0))} />
        </Stats>
        <Card title="Partners & applications" pad={false}>
          <Table rows={partners} empty="No partners yet. Your offer is listed in every publication's Boosts marketplace." cols={[
            { h: 'Partner', r: (p) => <><strong>{p.name}</strong><div class="muted small">{truncate(p.description, 70)}</div></> },
            { h: 'Status', r: (p) => <Status s={p.status} /> },
            { h: 'Subscribers', class: 'right', r: (p) => <>{num(p.subscribers)}<div class="muted small">{num(p.verified_subscribers)} verified · {num(p.pending)} pending</div></> },
            { h: 'Engagement', class: 'right', r: (p) => <>{pct(p.opened, p.delivered)} open rate<div class="muted small">{num(p.still_active)} still subscribed</div></> },
            { h: 'Flagged', class: 'right', r: (p) => (p.flagged ? <Badge tone="red">{p.flagged}</Badge> : '0') },
            { h: 'Spend', class: 'right', r: (p) => <>{money(p.earned_cents - p.clawed_back_cents)}{p.clawed_back_cents ? <div class="muted small">{money(p.clawed_back_cents)} clawed back</div> : null}</> },
            { h: '', class: 'right nowrap', r: (p) => <>
              {p.status === 'applied' && <><ActionForm action={`/app/grow/boosts/partners/${p.id}/status`} fields={{ status: 'active' }} label="Accept" kind="primary" /><ActionForm action={`/app/grow/boosts/partners/${p.id}/status`} fields={{ status: 'rejected' }} label="Reject" kind="ghost" /></>}
              {p.status === 'active' && <ActionForm action={`/app/grow/boosts/partners/${p.id}/status`} fields={{ status: 'paused' }} label="Pause" />}
              {p.status === 'paused' && <ActionForm action={`/app/grow/boosts/partners/${p.id}/status`} fields={{ status: 'active' }} label="Resume" />}
              {['active', 'paused'].includes(p.status) && <ActionForm action={`/app/grow/boosts/partners/${p.id}/status`} fields={{ status: 'ended' }} label="End" kind="danger" confirm="End this partnership?" />}
              {p.earned_cents > p.clawed_back_cents && <ActionForm action={`/app/grow/boosts/partners/${p.id}/clawback`} label="Claw back fakes" kind="ghost" confirm="Claw back payouts for this partner's subscribers that unsubscribed, bounced, or never opened?" />}
            </> },
          ]} />
        </Card>
        <Card title="Recent conversions" pad={false}>
          <Table rows={convs} empty="No conversions yet." cols={[
            { h: 'Subscriber', r: (v) => v.email || '(deleted)' },
            { h: 'Partner', r: (v) => v.partner },
            { h: 'Status', r: (v) => <Status s={v.status === 'clawed_back' ? 'rejected' : v.status} /> },
            { h: 'Fraud score', r: (v) => <Badge tone={v.fraud_score >= 60 ? 'red' : v.fraud_score >= 30 ? 'amber' : 'green'}>{v.fraud_score}</Badge> },
            { h: 'Amount', class: 'right', r: (v) => money(v.amount_cents) },
            { h: 'When', r: (v) => <>{ago(v.created_at)}{v.status === 'pending' && <div class="muted small">verifies {ago(v.created_at - HOLD_DAYS * DAY).replace(' ago', '')} after signup</div>}</> },
          ]} />
        </Card>
      </DashLayout>,
    );
  });

  dash.post('/boosts/offers/:id/status', requirePerm('admin'), async (c) => {
    const status = (await form(c.req)).status;
    if (!['active', 'paused', 'ended'].includes(status)) return back(c, '/app/grow/boosts', 'Invalid status', 'err');
    await run(c.env, 'UPDATE boost_offers SET status = ? WHERE id = ? AND pub_id = ?', status, c.req.param('id'), c.get('pub').id);
    if (status === 'ended') await run(c.env, `UPDATE boost_partners SET status = 'ended' WHERE offer_id = ? AND status IN ('active','paused','applied')`, c.req.param('id'));
    return back(c, `/app/grow/boosts/offers/${c.req.param('id')}`, `Offer ${status === 'active' ? 'resumed' : status}`);
  });

  dash.post('/boosts/offers/:id/apply', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const o = await one<any>(c.env, `SELECT * FROM boost_offers WHERE id = ? AND status = 'active' AND pub_id != ?`, c.req.param('id'), pub.id);
    if (!o) return back(c, '/app/grow/boosts', 'Offer is no longer available', 'err');
    const status = o.auto_accept ? 'active' : 'applied';
    await run(c.env, `INSERT INTO boost_partners (id, offer_id, partner_pub_id, status, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(offer_id, partner_pub_id) DO UPDATE SET status = excluded.status`, id(), o.id, pub.id, status, now());
    const adv = await getPub(c.env, o.pub_id);
    if (adv) for (const e of await pubAdminEmails(c.env, adv))
      await sendTransactional(c.env, e, `${pub.name} ${status === 'active' ? 'joined' : 'applied to'} your boost`, `<p><strong>${esc(pub.name)}</strong> ${status === 'active' ? 'is now recommending you (auto-accepted)' : 'applied to recommend you'} for ${money(o.cpa_cents)} per verified subscriber.</p><p>Review partners in Grow → Boosts.</p>`, adv);
    return back(c, '/app/grow/boosts', status === 'active' ? 'You are now earning from this boost' : 'Application sent');
  });

  dash.post('/boosts/partners/:id/status', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const status = (await form(c.req)).status;
    if (!['active', 'paused', 'ended', 'rejected'].includes(status)) return back(c, '/app/grow/boosts', 'Invalid status', 'err');
    const bp = await one<any>(c.env, `SELECT bp.*, o.pub_id AS adv_pub_id FROM boost_partners bp JOIN boost_offers o ON o.id = bp.offer_id WHERE bp.id = ?`, c.req.param('id'));
    if (!bp || (bp.adv_pub_id !== pub.id && bp.partner_pub_id !== pub.id)) return c.notFound();
    // only the advertiser can accept/reject applications
    if (bp.partner_pub_id === pub.id && (status === 'rejected' || (status === 'active' && bp.status === 'applied'))) return back(c, '/app/grow/boosts', 'Only the advertiser can approve', 'err');
    await run(c.env, 'UPDATE boost_partners SET status = ? WHERE id = ?', status, bp.id);
    if (bp.status === 'applied' && status === 'active') {
      const partner = await getPub(c.env, bp.partner_pub_id);
      if (partner) for (const e of await pubAdminEmails(c.env, partner)) await sendTransactional(c.env, e, `Your boost application to ${pub.name} was accepted`, `<p>You can now earn by recommending <strong>${esc(pub.name)}</strong>. It appears on your signup recommendations page automatically.</p>`, partner);
    }
    return back(c, bp.adv_pub_id === pub.id ? `/app/grow/boosts/offers/${bp.offer_id}` : '/app/grow/boosts', `Partnership ${status}`);
  });

  dash.post('/boosts/partners/:id/clawback', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const bp = await one<any>(c.env, `SELECT bp.*, o.pub_id AS adv_pub_id FROM boost_partners bp JOIN boost_offers o ON o.id = bp.offer_id WHERE bp.id = ? AND o.pub_id = ?`, c.req.param('id'), pub.id);
    if (!bp) return c.notFound();
    const fakes = await all<any>(c.env, `SELECT bc.*, bp.offer_id, bp.partner_pub_id FROM boost_conversions bc JOIN boost_partners bp ON bp.id = bc.partner_id JOIN subscribers s ON s.id = bc.subscriber_id
      WHERE bc.partner_id = ? AND bc.status = 'verified' AND bc.created_at > ? AND (s.status != 'active' OR (s.open_count = 0 AND s.click_count = 0) OR bc.fraud_score >= 60)`, bp.id, now() - CLAWBACK_DAYS * DAY);
    for (const f of fakes) await clawback(c.env, f);
    await audit(c, 'boost.clawback', bp.id, { count: fakes.length });
    return back(c, `/app/grow/boosts/offers/${bp.offer_id}`, fakes.length ? `Clawed back ${fakes.length} payout(s)` : 'No fake subscribers found within the 30-day window');
  });

  // ── Partner boost landing page on the advertiser's site
  site.get('/b/:partnerId', async (c) => {
    const pub = c.get('pub');
    const bp = await one<any>(c.env, `SELECT bp.*, p.name AS partner_name FROM boost_partners bp JOIN boost_offers o ON o.id = bp.offer_id JOIN publications p ON p.id = bp.partner_pub_id WHERE bp.id = ? AND o.pub_id = ?`, c.req.param('partnerId'), pub.id);
    if (!bp) return SiteMessage(c, 'Link not found', <p>This link is no longer active.</p>, 404);
    await trackView(c, 'boost:' + bp.id);
    return c.html(await SiteLayout({ c, title: `Subscribe to ${pub.name}`, children: (
      <section class="s-hero"><div class="s-wrap">
        <p class="s-muted">Recommended by <strong>{bp.partner_name}</strong></p>
        <h1>{pub.name}</h1><p>{pub.description}</p>
        <SubscribeForm action={`${siteUrl(c.env, pub)}/b/${bp.id}`} source="boost" />
      </div></section>
    ) }));
  });

  site.post('/b/:partnerId', async (c) => {
    const pub = c.get('pub');
    const base = siteUrl(c.env, pub);
    const bp = await one<any>(c.env, `SELECT bp.* FROM boost_partners bp JOIN boost_offers o ON o.id = bp.offer_id WHERE bp.id = ? AND o.pub_id = ?`, c.req.param('partnerId'), pub.id);
    const f = await form(c.req);
    const ip = clientIP(c.req.raw);
    if (!(await rateLimit(c.env, `boost:${ip}`, 10, 600))) return SiteMessage(c, 'Slow down', <p>Too many attempts. Try again in a few minutes.</p>, 429);
    if (botScore({ honeypot: f.website, renderedAt: f._t, ua: c.req.header('user-agent') }) >= 60) return SiteMessage(c, 'Something went wrong', <p>We couldn't verify your signup. Please try again.</p>, 400);
    const active = bp && bp.status === 'active';
    const r = await subscribe(c.env, pub, { email: str(f.email, 254), source: active ? 'boost' : 'recommendation', sourceDetail: active ? bp.id : bp?.partner_pub_id, ip, country: (c.req.raw as any).cf?.country ?? null, referrer: c.req.header('referer') || null, strict: true });
    if (!r.ok) return back(c, `${base}/b/${c.req.param('partnerId')}`, r.error || 'Could not subscribe', 'err');
    return SiteMessage(c, r.pending ? 'Check your inbox' : "You're subscribed!", <p>{r.pending ? 'Confirm your email to start receiving ' : 'Welcome to '}<strong>{pub.name}</strong>. <a href={base + '/'}>Read the latest posts →</a></p>);
  });
}
