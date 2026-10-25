/** @jsxImportSource hono/jsx */
// Public monetization pages on publication sites: pricing/upgrade, gifts, group plans, subscription management,
// storefront, product pages (variants, reviews, coaching booking), orders, downloads, sponsorship booking.
import type { Hono } from 'hono';
import { raw } from 'hono/html';
import type { AppEnv, Ctx } from '../../types';
import { one, all, run, insert, val } from '../../lib/db';
import { createReaderSession } from '../../lib/auth';
import { validateEmail, rateLimit, clientIP } from '../../lib/guard';
import { createCheckout, stripeEnabled, applyOffer } from '../../lib/payments';
import { siteUrl } from '../../lib/pub';
import { serveObject } from '../../lib/media';
import { sanitizeHtml } from '../../lib/sanitize';
import { trackView } from '../../lib/tracking';
import { redeemGift, joinGroup, coachingSlots, ics, tierPrice, pauseSubscription, resumeSubscription, cancelSubscription, reactivateSubscription } from '../../lib/billing';
import { SiteLayout, SiteMessage } from '../../ui/site';
import { flash } from '../../ui/components';
import { FORMATS } from './sponsors';
import { id, now, money, fmtDate, form, str, int, parseJSON, esc, DAY } from '../../lib/util';

async function checkoutGuard(c: Ctx): Promise<boolean> {
  return rateLimit(c.env, 'checkout:' + clientIP(c.req.raw), 30, 3600);
}

function toBase(c: Ctx) {
  return siteUrl(c.env, c.get('pub'));
}

async function page(c: Ctx, title: string, children: any, opts: { description?: string; image?: string | null; status?: 200 | 400 | 404 } = {}) {
  return c.html(await SiteLayout({ c, title, description: opts.description, image: opts.image, children }), opts.status || 200);
}

function err(c: Ctx, to: string, msg: string) {
  flash(c, msg, 'err');
  return c.redirect(to, 303);
}

const paras = (s: string) => (s || '').split(/\n\s*\n/).map((p) => <p>{p}</p>);

async function offerFor(c: Ctx, code: string | undefined, appliesTo: string, targetId: string | null) {
  if (!code) return null;
  const o = await one<any>(c.env, `SELECT * FROM offers WHERE pub_id = ? AND code = ? COLLATE NOCASE AND active = 1`, c.get('pub').id, code.trim());
  if (!o || (o.expires_at && o.expires_at < now()) || (o.max_redemptions && o.redemptions >= o.max_redemptions)) return null;
  if (o.applies_to !== 'all' && o.applies_to !== appliesTo) return null;
  if (o.target_id && o.target_id !== targetId) return null;
  return o;
}
const offerLabel = (o: any, cur = 'usd') => `${o.percent_off ? `${o.percent_off}%` : money(o.amount_off_cents, cur)} off${o.duration === 'forever' ? ' forever' : o.duration === 'repeating' ? ` for ${o.duration_months} months` : ' your first payment'}`;

export function registerSite(site: Hono<AppEnv>) {
  // ───── Pricing / upgrade
  site.get('/upgrade', async (c) => {
    const pub = c.get('pub');
    const base = toBase(c);
    const reader = c.get('reader');
    await trackView(c);
    const tiers = await all<any>(c.env, `SELECT * FROM tiers WHERE pub_id = ? AND status = 'active' ORDER BY position, monthly_cents`, pub.id);
    const interval = c.req.query('interval') === 'year' ? 'year' : 'month';
    const code = c.req.query('code') || '';
    const groupMode = c.req.query('group') === '1';
    const focus = c.req.query('tier');
    const offer = code ? await offerFor(c, code, 'subscription', null) : null;
    const qs = (o: Record<string, string>) => '?' + new URLSearchParams({ ...(code ? { code } : {}), ...(focus ? { tier: focus } : {}), ...(c.req.query('post') ? { post: c.req.query('post')! } : {}), ...o }).toString();
    if (!tiers.length) return SiteMessage(c, 'Premium is coming soon', <p>{pub.name} doesn't offer paid subscriptions yet. <a href={base + '/'}>Back to the newsletter</a></p>);
    const hasAnnual = tiers.some((t) => t.annual_cents > 0), hasMonthly = tiers.some((t) => t.monthly_cents > 0);
    const subscribed = reader?.premium;
    return page(c, `Upgrade to ${pub.name} premium`, (
      <section class="s-section"><div class="s-wrap">
        <div style="text-align:center;margin-bottom:28px">
          <h1>{groupMode ? 'Plans for teams' : `Support ${pub.name}`}</h1>
          <p class="s-muted">{groupMode ? 'One subscription, a seat for everyone on your team.' : 'Get every premium post, the full archive and all member perks.'}</p>
          {subscribed && <p><strong>You're a premium subscriber.</strong> <a href={base + '/subscription'}>Manage your subscription</a></p>}
          {offer && <p class="s-badge" style="font-size:15px;padding:4px 12px">🎉 Code <strong>{offer.code}</strong>: {offerLabel(offer, tiers[0].currency)}</p>}
          {code && !offer && <p class="s-muted">The code “{code}” isn't valid anymore.</p>}
          {hasAnnual && hasMonthly && <div class="s-toggle"><a href={qs({ interval: 'month' })} class={interval === 'month' ? 'on' : ''}>Monthly</a><a href={qs({ interval: 'year' })} class={interval === 'year' ? 'on' : ''}>Annual{(() => { const t = tiers.find((x) => x.annual_cents && x.monthly_cents); return t ? ` · save ${Math.max(0, Math.round(100 - (t.annual_cents / (t.monthly_cents * 12)) * 100))}%` : ''; })()}</a></div>}
        </div>
        <div class="s-grid" style="align-items:stretch">
          {!groupMode && (
            <div class="s-tier">
              <h3>Free</h3>
              <div class="s-price">{money(0, tiers[0].currency)}</div>
              <ul><li>Free posts by email</li><li>Public archive</li></ul>
              <div style="margin-top:auto">{reader?.subscriber?.status === 'active' ? <span class="s-muted">Your current plan</span> : <button type="button" class="s-btn s-btn-ghost" data-modal="subscribe">Subscribe free</button>}</div>
            </div>
          )}
          {tiers.filter((t) => !groupMode || t.group_enabled).map((t) => {
            const iv = (interval === 'year' && t.annual_cents) || !t.monthly_cents ? 'year' : 'month';
            const full = tierPrice(t, iv as any);
            const ofs = offer && (!offer.target_id || offer.target_id === t.id) ? offer : null;
            const disc = ofs ? Math.max(0, full - (ofs.percent_off ? Math.round((full * ofs.percent_off) / 100) : ofs.amount_off_cents)) : full;
            const benefits = parseJSON<string[]>(t.benefits, []);
            const isCurrent = reader?.subscriber?.tier_id === t.id && subscribed;
            return (
              <form method="post" action={`${base}/upgrade/checkout`} class={`s-tier ${focus === t.id || (!focus && tiers.length === 1) ? 'featured' : ''}`}>
                <h3>{t.name}</h3>
                {groupMode ? (
                  <div class="s-price">{money(t.group_seat_cents, t.currency)}<small> / seat / {iv}</small></div>
                ) : (
                  <div class="s-price">{disc !== full && <s class="s-muted" style="font-size:20px;margin-right:6px">{money(full, t.currency)}</s>}{money(disc, t.currency)}<small> / {iv}</small></div>
                )}
                {!groupMode && t.trial_days > 0 && <div class="s-badge">{t.paid_trial_cents ? `${money(t.paid_trial_cents, t.currency)} for ${t.trial_days} days` : `${t.trial_days}-day free trial`}</div>}
                {t.description && <p class="s-muted">{t.description}</p>}
                <ul>{benefits.map((b) => <li>{b}</li>)}</ul>
                <input type="hidden" name="tier_id" value={t.id} />
                <input type="hidden" name="interval" value={iv} />
                <input type="hidden" name="code" value={ofs ? code : ''} />
                <input type="hidden" name="post" value={c.req.query('post') || ''} />
                {groupMode && <label class="s-field"><span>Seats</span><input class="s-input" type="number" name="seats" min="2" max="1000" value="5" /></label>}
                {!reader && <input class="s-input" type="email" name="email" placeholder="you@example.com" required autocomplete="email" />}
                <div style="margin-top:auto">
                  {isCurrent && !groupMode ? <a class="s-btn s-btn-ghost" href={base + '/subscription'}>Current plan · manage</a> : <button class="s-btn" style="width:100%">{groupMode ? 'Buy team plan' : t.trial_days ? 'Start trial' : `Upgrade to ${t.name}`}</button>}
                </div>
              </form>
            );
          })}
        </div>
        <p class="s-muted s-small" style="text-align:center;margin-top:24px">
          {tiers.some((t) => t.group_enabled) && !groupMode && <><a href={`${base}/upgrade?group=1`}>Buying for a team?</a> · </>}
          <a href={`${base}/gift`}>Give a gift subscription</a> · Cancel any time.{!stripeEnabled(c.env) && ' (Test mode — no real charges.)'}
        </p>
      </div></section>
    ));
  });

  site.post('/upgrade/checkout', async (c) => {
    const pub = c.get('pub');
    const base = toBase(c);
    const f = await form(c.req);
    if (!(await checkoutGuard(c))) return err(c, `${base}/upgrade`, 'Too many attempts. Please try again later.');
    const t = await one<any>(c.env, `SELECT * FROM tiers WHERE id = ? AND pub_id = ? AND status = 'active'`, f.tier_id, pub.id);
    if (!t) return err(c, `${base}/upgrade`, 'That plan is not available.');
    const reader = c.get('reader');
    let email = reader?.email || '';
    if (!email) {
      const v = await validateEmail(str(f.email), { strict: true });
      if (!v.ok) return err(c, `${base}/upgrade`, v.reason || 'Please enter a valid email.');
      email = v.email;
    }
    const interval: 'month' | 'year' = f.interval === 'year' && t.annual_cents ? 'year' : t.monthly_cents ? 'month' : 'year';
    const seats = Math.min(1000, int(f.seats));
    if (seats >= 2 && t.group_enabled) {
      const amount = seats * t.group_seat_cents;
      const r = await createCheckout(c.env, { pub, kind: 'group', refId: t.id, email, subscriberId: reader?.subscriber?.id, amountCents: amount, currency: t.currency, description: `${pub.name} ${t.name} — team plan, ${seats} seats`, data: { seats, interval }, recurring: { interval } });
      return c.redirect(r.url, 303);
    }
    const full = tierPrice(t, interval);
    const offer = await offerFor(c, str(f.code), 'subscription', t.id);
    const disc = offer ? (await applyOffer(c.env, pub.id, offer.code, 'subscription', t.id, full)).amount : full;
    const trialDays = t.trial_days || 0;
    const renewal = offer?.duration === 'forever' ? disc : full;
    const live = stripeEnabled(c.env);
    // Stripe charges via the recurring price (+ coupon); test mode charges today's amount directly.
    const chargeNow = live ? full : trialDays ? t.paid_trial_cents : disc;
    const post = str(f.post);
    const r = await createCheckout(c.env, {
      pub, kind: 'subscription', refId: t.id, email, subscriberId: reader?.subscriber?.id, amountCents: chargeNow, currency: t.currency,
      description: `${pub.name} — ${t.name} (${interval === 'year' ? 'annual' : 'monthly'})`, offerId: offer?.id ?? null,
      data: { interval, full_amount_cents: renewal, post: post || null },
      recurring: { interval, trialDays, trialAmountCents: t.paid_trial_cents || 0 },
      discount: live && offer ? { percent_off: offer.percent_off || undefined, amount_off_cents: offer.amount_off_cents || undefined, duration: offer.duration, months: offer.duration_months } : null,
      successUrl: undefined,
    });
    return c.redirect(r.url, 303);
  });

  // ───── Gifts
  site.get('/gift', async (c) => {
    const pub = c.get('pub');
    const base = toBase(c);
    await trackView(c);
    const tiers = await all<any>(c.env, `SELECT * FROM tiers WHERE pub_id = ? AND status = 'active' ORDER BY position`, pub.id);
    if (!tiers.length) return SiteMessage(c, 'Gifts unavailable', <p>{pub.name} doesn't offer paid subscriptions yet.</p>);
    return page(c, `Give ${pub.name}`, (
      <section class="s-section"><div class="s-wrap s-narrow">
        <h1>🎁 Give {pub.name}</h1>
        <p class="s-muted">Send a premium subscription to someone who'd love it. They'll get an email with a link to redeem — no renewal, no card needed on their side.</p>
        <form method="post" action={`${base}/gift`} class="s-box s-stack">
          <label class="s-field"><span>Plan</span><select class="s-input" name="tier_id">{tiers.map((t) => <option value={t.id}>{t.name} — {money(t.monthly_cents || Math.round(t.annual_cents / 12), t.currency)}/month</option>)}</select></label>
          <label class="s-field"><span>Length</span><select class="s-input" name="months"><option value="1">1 month</option><option value="3">3 months</option><option value="6">6 months</option><option value="12" selected>12 months</option></select></label>
          <label class="s-field"><span>Recipient's email</span><input class="s-input" type="email" name="recipient_email" required /></label>
          <label class="s-field"><span>Personal message (optional)</span><textarea class="s-input" name="message" rows={3} style="height:auto;padding:10px 14px" maxlength={500}></textarea></label>
          <label class="s-field"><span>Your name</span><input class="s-input" name="from_name" required /></label>
          <label class="s-field"><span>Your email (for the receipt)</span><input class="s-input" type="email" name="email" value={c.get('reader')?.email || ''} required /></label>
          <button class="s-btn">Continue to payment</button>
        </form>
      </div></section>
    ));
  });

  site.post('/gift', async (c) => {
    const pub = c.get('pub');
    const base = toBase(c);
    const f = await form(c.req);
    if (!(await checkoutGuard(c))) return err(c, `${base}/gift`, 'Too many attempts. Please try again later.');
    const t = await one<any>(c.env, `SELECT * FROM tiers WHERE id = ? AND pub_id = ? AND status = 'active'`, f.tier_id, pub.id);
    if (!t) return err(c, `${base}/gift`, 'That plan is not available.');
    const buyer = await validateEmail(str(f.email), { strict: true });
    const rec = await validateEmail(str(f.recipient_email), { strict: true });
    if (!buyer.ok || !rec.ok) return err(c, `${base}/gift`, (buyer.ok ? rec.reason : buyer.reason) || 'Check the email addresses.');
    const months = [1, 3, 6, 12].includes(int(f.months)) ? int(f.months) : 12;
    const amount = months === 12 && t.annual_cents ? t.annual_cents : (t.monthly_cents || Math.round(t.annual_cents / 12)) * months;
    const r = await createCheckout(c.env, { pub, kind: 'gift', refId: t.id, email: buyer.email, name: str(f.from_name, 120), amountCents: amount, currency: t.currency, description: `Gift: ${months} month${months > 1 ? 's' : ''} of ${pub.name} ${t.name}`, data: { months, recipient_email: rec.email, message: str(f.message, 500), from_name: str(f.from_name, 120) } });
    return c.redirect(r.url, 303);
  });

  site.get('/gift/:token', async (c) => {
    const pub = c.get('pub');
    const base = toBase(c);
    const o = await one<any>(c.env, `SELECT o.*, t.name AS tier_name FROM orders o LEFT JOIN tiers t ON t.id = o.ref_id WHERE o.delivery_token = ? AND o.pub_id = ? AND o.kind = 'gift'`, c.req.param('token'), pub.id);
    if (!o || o.status !== 'paid') return SiteMessage(c, 'Gift not found', <p>This gift link isn't valid.</p>, 404);
    const d = parseJSON<any>(o.data, {});
    return page(c, 'Redeem your gift', (
      <section class="s-section"><div class="s-wrap s-narrow" style="text-align:center">
        <h1>🎁 You've got a gift</h1>
        <p><strong>{d.from_name || o.email}</strong> gave you <strong>{d.months} month{d.months > 1 ? 's' : ''} of {pub.name} {o.tier_name}</strong>.</p>
        {d.message && <blockquote class="oh-quote" style="text-align:left">{d.message}</blockquote>}
        {d.redeemed_at ? <p class="s-muted">This gift was redeemed on {fmtDate(d.redeemed_at)}. <a href={base + '/'}>Start reading →</a></p> : (
          <form method="post" class="s-form" style="justify-content:center">
            <input type="email" name="email" value={d.recipient_email || ''} required />
            <button class="s-btn">Redeem gift</button>
          </form>
        )}
      </div></section>
    ));
  });

  site.post('/gift/:token', async (c) => {
    const pub = c.get('pub');
    const base = toBase(c);
    const f = await form(c.req);
    const v = await validateEmail(str(f.email));
    if (!v.ok) return err(c, `${base}/gift/${c.req.param('token')}`, v.reason || 'Enter a valid email');
    const r = await redeemGift(c.env, pub, c.req.param('token'), v.email);
    if (!r.ok) return err(c, `${base}/gift/${c.req.param('token')}`, r.error!);
    await createReaderSession(c, v.email);
    flash(c, 'Gift redeemed — enjoy full premium access!');
    return c.redirect(base + '/', 303);
  });

  // ───── Group plans + custom deals
  site.get('/group/:token', async (c) => {
    const pub = c.get('pub');
    const tok = c.req.param('token');
    const order = await one<any>(c.env, `SELECT o.*, t.name AS tier_name FROM orders o LEFT JOIN tiers t ON t.id = o.ref_id WHERE o.delivery_token = ? AND o.pub_id = ? AND o.kind = 'group' AND o.status = 'paid'`, tok, pub.id);
    if (order) {
      const owner = await one<any>(c.env, 'SELECT * FROM subscriptions WHERE order_id = ? AND group_owner_id IS NULL', order.id);
      const used = owner ? 1 + (await val<number>(c.env, `SELECT COUNT(*) FROM subscriptions WHERE group_owner_id = ? AND status = 'active'`, owner.id)) : 0;
      return page(c, `Join ${pub.name}`, (
        <section class="s-section"><div class="s-wrap s-narrow" style="text-align:center">
          <h1>Join your team on {pub.name}</h1>
          <p class="s-muted">{order.name || order.email} added you to a {order.tier_name} team plan. {owner ? `${used} of ${owner.seats} seats used.` : ''}</p>
          <form method="post" class="s-form" style="justify-content:center"><input type="email" name="email" placeholder="your work email" required /><button class="s-btn">Claim my seat</button></form>
        </div></section>
      ));
    }
    const deal = await one<any>(c.env, `SELECT d.*, t.name AS tier_name, t.currency FROM group_deals d JOIN tiers t ON t.id = d.tier_id WHERE d.token = ? AND d.pub_id = ?`, tok, pub.id);
    if (!deal) return SiteMessage(c, 'Link not found', <p>This team link isn't valid.</p>, 404);
    if (deal.status === 'paid') return SiteMessage(c, 'Already accepted', <p>This deal has been accepted. Check {deal.contact_email} for your team join link.</p>);
    return page(c, `Team offer for ${deal.company}`, (
      <section class="s-section"><div class="s-wrap s-narrow">
        <div class="s-tier featured">
          <h1>{pub.name} for {deal.company}</h1>
          <div class="s-price">{money(deal.price_cents, deal.currency)}<small> / {deal.interval}</small></div>
          <p>{deal.seats} seats of <strong>{deal.tier_name}</strong> — every teammate gets full premium access with their own email.</p>
          <form method="post" action={`${toBase(c)}/group/${tok}/pay`} class="s-form"><input type="email" name="email" value={deal.contact_email} required /><button class="s-btn">Accept & pay</button></form>
        </div>
      </div></section>
    ));
  });

  site.post('/group/:token', async (c) => {
    const pub = c.get('pub');
    const base = toBase(c);
    const v = await validateEmail(str((await form(c.req)).email), { strict: true });
    if (!v.ok) return err(c, `${base}/group/${c.req.param('token')}`, v.reason || 'Enter a valid email');
    const r = await joinGroup(c.env, pub, c.req.param('token'), v.email);
    if (!r.ok) return err(c, `${base}/group/${c.req.param('token')}`, r.error!);
    await createReaderSession(c, v.email);
    flash(c, `Welcome! You now have premium access to ${pub.name}.`);
    return c.redirect(base + '/', 303);
  });

  site.post('/group/:token/pay', async (c) => {
    const pub = c.get('pub');
    const base = toBase(c);
    const deal = await one<any>(c.env, `SELECT d.*, t.name AS tier_name, t.currency FROM group_deals d JOIN tiers t ON t.id = d.tier_id WHERE d.token = ? AND d.pub_id = ? AND d.status = 'offered'`, c.req.param('token'), pub.id);
    if (!deal) return err(c, base + '/', 'This deal is no longer available.');
    const v = await validateEmail(str((await form(c.req)).email));
    if (!v.ok) return err(c, `${base}/group/${deal.token}`, v.reason || 'Enter a valid email');
    const r = await createCheckout(c.env, { pub, kind: 'group', refId: deal.tier_id, email: v.email, name: deal.company, amountCents: deal.price_cents, currency: deal.currency, description: `${pub.name} ${deal.tier_name} — ${deal.company} (${deal.seats} seats)`, data: { seats: deal.seats, deal_id: deal.id, interval: deal.interval }, recurring: { interval: deal.interval === 'month' ? 'month' : 'year' } });
    return c.redirect(r.url, 303);
  });

  // ───── Manage subscription (logged-in readers)
  site.get('/subscription', async (c) => {
    const pub = c.get('pub');
    const base = toBase(c);
    const reader = c.get('reader');
    if (!reader?.subscriber) return SiteMessage(c, 'Manage your subscription', <><p>Log in to manage your subscription.</p><p><button type="button" class="s-btn" data-modal="login">Log in</button></p></>);
    const subs = await all<any>(c.env, `SELECT s.*, t.name AS tier_name, t.monthly_cents, t.annual_cents FROM subscriptions s LEFT JOIN tiers t ON t.id = s.tier_id WHERE s.subscriber_id = ? ORDER BY s.status = 'canceled', s.created_at DESC`, reader.subscriber.id);
    const orders = await all<any>(c.env, `SELECT * FROM orders WHERE pub_id = ? AND email = ? AND status IN ('paid','refunded') ORDER BY created_at DESC LIMIT 20`, pub.id, reader.email);
    return page(c, 'Your subscription', (
      <section class="s-section"><div class="s-wrap s-narrow">
        <h1>Your subscription</h1>
        <p class="s-muted">{reader.email} · {reader.premium ? 'Premium' : 'Free'} reader</p>
        {!subs.length && <div class="s-box"><p>You're on the free plan.</p><a class="s-btn" href={base + '/upgrade'}>See premium plans</a></div>}
        {subs.map((s) => (
          <div class="s-box" style="margin-bottom:14px">
            <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
              <div>
                <h3 style="margin:0">{s.tier_name || 'Premium'} {s.group_owner_id ? '(team seat)' : s.seats > 1 ? `(team · ${s.seats} seats)` : ''}{s.gift_from_email ? ' (gift)' : ''}</h3>
                <p class="s-muted" style="margin:4px 0">
                  {s.amount_cents ? `${money(s.amount_cents, s.currency)} / ${s.interval}` : 'No charge'} · <span class="s-badge">{s.status}</span>
                  {s.status === 'trialing' && ` · trial ends ${fmtDate(s.trial_ends_at)}`}
                  {['active', 'trialing'].includes(s.status) && s.current_period_end ? ` · ${s.cancel_at_period_end ? 'access ends' : 'renews'} ${fmtDate(s.current_period_end)}` : ''}
                </p>
              </div>
              {!s.group_owner_id && !s.gift_from_email && (
                <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                  {['active', 'trialing'].includes(s.status) && !s.cancel_at_period_end && <form method="post" action={`${base}/subscription/${s.id}/pause`}><button class="s-btn s-btn-ghost">Pause</button></form>}
                  {s.status === 'paused' && <form method="post" action={`${base}/subscription/${s.id}/resume`}><button class="s-btn">Resume</button></form>}
                  {s.cancel_at_period_end && s.status !== 'canceled' ? <form method="post" action={`${base}/subscription/${s.id}/reactivate`}><button class="s-btn">Keep my subscription</button></form> : null}
                  {s.status !== 'canceled' && !s.cancel_at_period_end && <form method="post" action={`${base}/subscription/${s.id}/cancel`}><button class="s-btn s-btn-ghost">Cancel</button></form>}
                </div>
              )}
            </div>
            {['active', 'trialing'].includes(s.status) && !s.group_owner_id && (
              <p class="s-small" style="margin:10px 0 0">
                {s.interval === 'month' && s.annual_cents ? <a href={`${base}/upgrade?tier=${s.tier_id}&interval=year`}>Switch to annual and save</a> : null}
                {s.interval === 'year' && s.monthly_cents ? <a href={`${base}/upgrade?tier=${s.tier_id}&interval=month`}>Switch to monthly</a> : null}
                {' · '}<a href={`${base}/upgrade`}>Change plan</a>
              </p>
            )}
          </div>
        ))}
        {orders.length > 0 && <><h3 style="margin-top:28px">Receipts</h3><table class="s-table">{orders.map((o) => <tr><td>{fmtDate(o.created_at)}</td><td>{parseJSON<any>(o.data, {}).description || o.kind}</td><td>{money(o.amount_cents, o.currency)}</td><td>{o.status}</td><td><a href={`${base}/order/${o.id}`}>View</a></td></tr>)}</table></>}
      </div></section>
    ));
  });

  for (const action of ['pause', 'resume', 'cancel', 'reactivate'] as const) {
    site.post(`/subscription/:id/${action}`, async (c) => {
      const pub = c.get('pub');
      const base = toBase(c);
      const reader = c.get('reader');
      const s = reader?.subscriber ? await one<any>(c.env, 'SELECT id FROM subscriptions WHERE id = ? AND subscriber_id = ? AND group_owner_id IS NULL', c.req.param('id'), reader.subscriber.id) : null;
      if (!s) return err(c, `${base}/subscription`, 'Subscription not found.');
      try {
        if (action === 'pause') await pauseSubscription(c.env, pub, s.id);
        if (action === 'resume') await resumeSubscription(c.env, pub, s.id);
        if (action === 'cancel') await cancelSubscription(c.env, pub, s.id, false);
        if (action === 'reactivate') await reactivateSubscription(c.env, pub, s.id);
      } catch (e: any) {
        return err(c, `${base}/subscription`, 'We could not update your subscription: ' + e.message);
      }
      flash(c, { pause: 'Subscription paused — you can resume any time.', resume: 'Welcome back! Your subscription is active again.', cancel: 'Subscription canceled. You keep access until the end of the period.', reactivate: 'Your subscription will continue.' }[action]);
      return c.redirect(`${base}/subscription`, 303);
    });
  }

  // ───── Storefront
  site.get('/shop', async (c) => {
    const pub = c.get('pub');
    const base = toBase(c);
    await trackView(c);
    const tag = c.req.query('tag') || '';
    const products = await all<any>(c.env, `SELECT * FROM products WHERE pub_id = ? AND status = 'active' ${tag ? 'AND tags LIKE ?' : ''} ORDER BY created_at DESC`, pub.id, ...(tag ? [`%"${tag}"%`] : []));
    const tags = [...new Set((await all<any>(c.env, `SELECT tags FROM products WHERE pub_id = ? AND status = 'active'`, pub.id)).flatMap((r) => parseJSON<string[]>(r.tags, [])))];
    const code = c.req.query('code');
    return page(c, 'Shop', (
      <section class="s-section"><div class="s-wrap">
        <h1>Shop</h1>
        <p class="s-muted">Guides, templates, courses and sessions from {pub.name}.</p>
        {tags.length > 0 && <nav class="s-tabs"><a href={`${base}/shop`} class={!tag ? 'on' : ''}>All</a>{tags.map((t) => <a href={`${base}/shop?tag=${encodeURIComponent(t)}`} class={tag === t ? 'on' : ''}>{t}</a>)}</nav>}
        {!products.length ? <p class="s-muted">Nothing for sale yet — check back soon.</p> : (
          <div class="s-posts">{products.map((p) => (
            <a class="s-card" href={`${base}/shop/${p.slug}${code ? `?code=${encodeURIComponent(code)}` : ''}`}>
              {p.cover_url ? <img class="s-card-img" src={p.cover_url} alt="" loading="lazy" /> : <div class="s-card-img" />}
              <h3>{p.name}</h3>
              <p>{(p.description || '').slice(0, 140)}</p>
              <div class="s-meta"><strong>{p.price_cents ? money(p.price_cents, p.currency) : 'Free'}</strong>{p.kind === 'coaching' && <span class="s-badge">1:1 session</span>}{p.kind === 'membership' && <span class="s-badge">membership</span>}</div>
            </a>
          ))}</div>
        )}
      </div></section>
    ));
  });

  site.get('/shop/:product', async (c) => {
    const pub = c.get('pub');
    const base = toBase(c);
    const p = await one<any>(c.env, `SELECT * FROM products WHERE pub_id = ? AND slug = ? AND status = 'active'`, pub.id, c.req.param('product'));
    if (!p) return SiteMessage(c, 'Not found', <p>This product isn't available. <a href={`${base}/shop`}>Back to the shop</a></p>, 404);
    await trackView(c, p.id);
    const [variants, reviews] = await Promise.all([
      all<any>(c.env, 'SELECT * FROM product_variants WHERE product_id = ? ORDER BY position', p.id),
      all<any>(c.env, `SELECT * FROM product_reviews WHERE product_id = ? AND status = 'approved' ORDER BY created_at DESC LIMIT 50`, p.id),
    ]);
    const reviewTok = c.req.query('review');
    const canReview = reviewTok ? await one<any>(c.env, `SELECT id, name FROM orders WHERE delivery_token = ? AND ref_id = ? AND status = 'paid'`, reviewTok, p.id) : null;
    const slots = p.kind === 'coaching' ? await coachingSlots(c.env, p) : [];
    const tz = parseJSON<any>(p.coaching, {}).tz || 'UTC';
    const code = c.req.query('code') || '';
    const offer = code ? await offerFor(c, code, 'product', p.id) : null;
    const avg = reviews.length ? reviews.reduce((a, r) => a + r.rating, 0) / reviews.length : 0;
    const reader = c.get('reader');
    const days: Record<string, typeof slots> = {};
    for (const s of slots.slice(0, 120)) (days[fmtDate(s.start, { weekday: 'short', month: 'short', day: 'numeric' }, tz)] ||= []).push(s);
    const jsonld = { '@context': 'https://schema.org', '@type': 'Product', name: p.name, description: (p.description || '').slice(0, 300), image: p.cover_url || undefined, offers: { '@type': 'Offer', price: (p.price_cents / 100).toFixed(2), priceCurrency: p.currency.toUpperCase(), availability: 'https://schema.org/InStock' }, ...(reviews.length ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: avg.toFixed(1), reviewCount: reviews.length } } : {}) };
    return c.html(await SiteLayout({ c, title: p.name, description: (p.description || '').slice(0, 160), image: p.cover_url, jsonld, children: (
      <section class="s-section"><div class="s-wrap">
        <p class="s-small"><a href={`${base}/shop`}>← Shop</a></p>
        <div class="oh-columns" style="gap:40px;align-items:flex-start">
          <div class="oh-col" style="flex:1 1 0">{p.cover_url ? <img src={p.cover_url} alt="" style="width:100%;border-radius:var(--radius)" /> : <div class="s-card-img" />}</div>
          <div class="oh-col" style="flex:1 1 0">
            <h1>{p.name}</h1>
            {reviews.length > 0 && <p class="s-muted">{'★'.repeat(Math.round(avg))}{'☆'.repeat(5 - Math.round(avg))} {avg.toFixed(1)} · {reviews.length} review{reviews.length > 1 ? 's' : ''}</p>}
            <div class="s-price" style="margin:8px 0 16px">{p.price_cents ? money(p.price_cents, p.currency) : 'Free'}</div>
            {offer && p.price_cents > 0 && <p class="s-badge">Code {offer.code}: {offer.percent_off ? `${offer.percent_off}%` : money(offer.amount_off_cents, p.currency)} off</p>}
            <div class="s-body" style="font-size:17px">{paras(p.description)}</div>
            <form method="post" action={`${base}/shop/${p.slug}/buy`} class="s-box s-stack">
              {variants.length > 0 && <label class="s-field"><span>Option</span><select class="s-input" name="variant_id"><option value="">Standard — {money(p.price_cents, p.currency)}</option>{variants.map((v) => <option value={v.id}>{v.name} — {money(v.price_cents, p.currency)}</option>)}</select></label>}
              {p.kind === 'coaching' && (
                Object.keys(days).length ? (
                  <fieldset class="s-field" style="border:0;padding:0"><span>Pick a time ({tz})</span>
                    <div style="max-height:280px;overflow:auto;border:1px solid var(--border);border-radius:var(--radius);padding:10px">
                      {Object.entries(days).map(([d, ss]) => <div style="margin-bottom:8px"><strong class="s-small">{d}</strong><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px">{ss.map((s) => <label class="s-badge" style="cursor:pointer"><input type="radio" name="slot" value={String(s.start)} required /> {fmtDate(s.start, { timeStyle: 'short' }, tz)}</label>)}</div></div>)}
                    </div>
                  </fieldset>
                ) : <p class="s-muted">No open times right now — check back soon.</p>
              )}
              {p.kind === 'coaching' && <label class="s-field"><span>What would you like to cover?</span><textarea class="s-input" name="notes" rows={2} style="height:auto;padding:10px 14px"></textarea></label>}
              <input class="s-input" name="name" placeholder="Your name" value={reader?.subscriber?.name || ''} />
              <input class="s-input" type="email" name="email" placeholder="you@example.com" value={reader?.email || ''} required />
              {p.price_cents > 0 && <input class="s-input" name="code" placeholder="Discount code" value={offer ? code : ''} />}
              <button class="s-btn" disabled={p.kind === 'coaching' && !slots.length}>{p.price_cents ? (p.kind === 'coaching' ? 'Book & pay' : 'Buy now') : 'Get it free'}</button>
              {!p.price_cents && <p class="s-small s-muted">You'll also join the {pub.name} newsletter. Unsubscribe any time.</p>}
            </form>
          </div>
        </div>
        <div class="s-narrow" style="margin:48px auto 0">
          <h2>Reviews</h2>
          {canReview && (
            <form method="post" action={`${base}/shop/${p.slug}/review`} class="s-box s-stack" style="margin-bottom:20px">
              <input type="hidden" name="token" value={reviewTok} />
              <strong>Leave a review</strong>
              <select class="s-input" name="rating">{[5, 4, 3, 2, 1].map((n) => <option value={String(n)}>{'★'.repeat(n)} ({n})</option>)}</select>
              <input class="s-input" name="name" value={canReview.name || ''} placeholder="Name shown with your review" required />
              <textarea class="s-input" name="body" rows={4} style="height:auto;padding:10px 14px" placeholder="What did you think?"></textarea>
              <button class="s-btn">Submit review</button>
            </form>
          )}
          {reviews.length ? reviews.map((r) => <div class="s-comment"><div class="s-meta"><strong>{r.name}</strong> {'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)} · {fmtDate(r.created_at)}</div><p>{r.body}</p></div>) : <p class="s-muted">No reviews yet.</p>}
        </div>
      </div></section>
    ) }));
  });

  site.post('/shop/:product/buy', async (c) => {
    const pub = c.get('pub');
    const base = toBase(c);
    const p = await one<any>(c.env, `SELECT * FROM products WHERE pub_id = ? AND slug = ? AND status = 'active'`, pub.id, c.req.param('product'));
    if (!p) return err(c, `${base}/shop`, 'This product is not available.');
    const back = `${base}/shop/${p.slug}`;
    if (!(await checkoutGuard(c))) return err(c, back, 'Too many attempts. Please try again later.');
    const f = await form(c.req);
    const v = await validateEmail(str(f.email), { strict: true });
    if (!v.ok) return err(c, back, v.reason || 'Please enter a valid email.');
    const variant = f.variant_id ? await one<any>(c.env, 'SELECT * FROM product_variants WHERE id = ? AND product_id = ?', f.variant_id, p.id) : null;
    let amount = variant ? variant.price_cents : p.price_cents;
    let offerId: string | null = null;
    if (f.code && amount > 0) {
      const r = await applyOffer(c.env, pub.id, str(f.code), 'product', p.id, amount);
      if (r.error) return err(c, back, r.error);
      amount = r.amount; offerId = r.offerId;
    }
    const data: Record<string, unknown> = { variant_name: variant?.name || null, product_slug: p.slug };
    if (p.kind === 'coaching') {
      const slot = Number(f.slot);
      const open = await coachingSlots(c.env, p);
      if (!open.some((s) => s.start === slot)) return err(c, back, 'That time was just taken — please pick another.');
      data.slot_start = slot; data.notes = str(f.notes, 1000);
    }
    const r = await createCheckout(c.env, { pub, kind: p.kind === 'replay' ? 'replay' : 'product', refId: p.id, variantId: variant?.id ?? null, email: v.email, name: str(f.name, 120), subscriberId: c.get('reader')?.subscriber?.id, amountCents: amount, currency: p.currency, description: `${p.name}${variant ? ` — ${variant.name}` : ''}`, offerId, data });
    return c.redirect(r.url, 303);
  });

  site.post('/shop/:product/review', async (c) => {
    const pub = c.get('pub');
    const base = toBase(c);
    const p = await one<any>(c.env, `SELECT * FROM products WHERE pub_id = ? AND slug = ?`, pub.id, c.req.param('product'));
    const f = await form(c.req);
    const o = p ? await one<any>(c.env, `SELECT id FROM orders WHERE delivery_token = ? AND ref_id = ? AND status = 'paid'`, str(f.token), p.id) : null;
    if (!p || !o) return err(c, `${base}/shop`, 'Only buyers can review this product.');
    if (await one(c.env, 'SELECT 1 FROM product_reviews WHERE order_id = ?', o.id)) return err(c, `${base}/shop/${p.slug}`, 'You already reviewed this product — thank you!');
    await insert(c.env, 'product_reviews', { id: id(), product_id: p.id, pub_id: pub.id, order_id: o.id, name: str(f.name, 80) || 'Verified buyer', rating: Math.max(1, Math.min(5, int(f.rating, 5))), body: str(f.body, 3000), status: 'pending', created_at: now() });
    flash(c, 'Thanks! Your review will appear once approved.');
    return c.redirect(`${base}/shop/${p.slug}`, 303);
  });

  // ───── Orders + delivery
  site.get('/order/:id', async (c) => {
    const pub = c.get('pub');
    const base = toBase(c);
    const o = await one<any>(c.env, 'SELECT * FROM orders WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!o) return SiteMessage(c, 'Order not found', <p>We couldn't find that order.</p>, 404);
    const d = parseJSON<any>(o.data, {});
    if (o.status === 'pending') {
      const retry = !stripeEnabled(c.env) ? `${c.env.APP_URL}/checkout/simulate/${o.id}` : null;
      return SiteMessage(c, 'Waiting for payment', <><p>We haven't received payment for this order yet. If you just paid, this page updates in a few seconds.</p>{raw('<meta http-equiv="refresh" content="5">')}{retry && <p><a class="s-btn" href={retry}>Complete payment</a></p>}</>);
    }
    if (o.status === 'refunded') return SiteMessage(c, 'Order refunded', <p>This order was refunded.</p>);
    const p = ['product', 'replay'].includes(o.kind) ? await one<any>(c.env, 'SELECT * FROM products WHERE id = ?', o.ref_id) : null;
    const variant = o.variant_id ? await one<any>(c.env, 'SELECT * FROM product_variants WHERE id = ?', o.variant_id) : null;
    const booking = p?.kind === 'coaching' ? await one<any>(c.env, 'SELECT * FROM bookings WHERE order_id = ?', o.id) : null;
    const expired = p?.kind === 'membership' && p.access_days && o.paid_at + p.access_days * DAY < now();
    let delivery: any = null;
    if (o.kind === 'subscription') delivery = <><p>Your premium access is active. 🎉</p><p><a class="s-btn" href={d.post ? `${base}/p/${d.post}` : base + '/'}>{d.post ? 'Continue reading' : 'Start reading'}</a> <a class="s-btn s-btn-ghost" href={`${base}/subscription`}>Manage subscription</a></p><p class="s-small s-muted">Reading on another device? <button type="button" class="s-btn s-btn-ghost" data-modal="login" style="height:auto;padding:2px 8px">Log in with {o.email}</button></p></>;
    else if (o.kind === 'gift') delivery = <p>We emailed the gift to <strong>{d.recipient_email}</strong>.{d.redeemed_at ? ' It has been redeemed.' : ''} You can also share this link: <br /><code style="word-break:break-all">{base}/gift/{o.delivery_token}</code></p>;
    else if (o.kind === 'group') delivery = <><p>Your team plan is active. Share this link so each teammate can claim a seat:</p><div class="oh-copy"><input readonly value={`${base}/group/${o.delivery_token}`} /><button type="button" data-copy={`${base}/group/${o.delivery_token}`}>Copy</button></div></>;
    else if (o.kind === 'sponsorship') delivery = <p>Your sponsorship for {d.date ? fmtDate(Date.parse(d.date)) : 'an upcoming issue'} is booked. The team will review your creative and confirm by email.</p>;
    else if (o.kind === 'ticket') delivery = <p>You're registered! {d.event_slug ? <a href={`${base}/events/${d.event_slug}`}>View event details</a> : 'Check your email for event details.'}</p>;
    else if (p) {
      if (expired) delivery = <p>Your access to this membership ended on {fmtDate(o.paid_at + p.access_days * DAY)}. <a href={`${base}/shop/${p.slug}`}>Renew access</a></p>;
      else if (booking) delivery = <><p>Your session is booked for <strong>{fmtDate(booking.starts_at, { dateStyle: 'full', timeStyle: 'short' }, parseJSON<any>(p.coaching, {}).tz || 'UTC')}</strong> ({parseJSON<any>(p.coaching, {}).tz || 'UTC'}).</p>{parseJSON<any>(p.coaching, {}).location && <p>Where: {parseJSON<any>(p.coaching, {}).location}</p>}<p><a class="s-btn" href={`${base}/order/${o.id}/calendar.ics`}>Add to calendar</a></p></>;
      else {
        const file = variant?.file_key || p.file_key;
        const link = variant?.link_url || p.link_url;
        delivery = (
          <>
            {file && <p><a class="s-btn" href={`${base}/download/${o.delivery_token}`}>⬇ Download {p.name}</a></p>}
            {link && <p><a class="s-btn" href={link} target="_blank" rel="noopener">Open {p.name} →</a></p>}
            {p.content && <div class="s-body s-box">{raw(sanitizeHtml(p.content, { blocks: true, media: true, styles: true }))}</div>}
            {p.kind === 'membership' && p.access_days && <p class="s-muted s-small">Access until {fmtDate(o.paid_at + p.access_days * DAY)}.</p>}
            {!file && !link && !p.content && <p>Thanks for your purchase! Check your email for details.</p>}
          </>
        );
      }
    }
    return page(c, 'Thank you', (
      <section class="s-section"><div class="s-wrap s-narrow">
        <h1>Thank you{o.name ? `, ${o.name.split(' ')[0]}` : ''}!</h1>
        <p class="s-muted">Order {o.id} · {d.description || o.kind} · {money(o.amount_cents, o.currency)} · {fmtDate(o.paid_at || o.created_at)}</p>
        <div style="margin:24px 0">{delivery}</div>
        <p class="s-small s-muted">A confirmation was sent to {o.email}.</p>
      </div></section>
    ));
  });

  site.get('/order/:id/calendar.ics', async (c) => {
    const pub = c.get('pub');
    const o = await one<any>(c.env, 'SELECT * FROM orders WHERE id = ? AND pub_id = ? AND status = ?', c.req.param('id'), pub.id, 'paid');
    const b = o ? await one<any>(c.env, 'SELECT b.*, p.name, p.coaching FROM bookings b JOIN products p ON p.id = b.product_id WHERE b.order_id = ?', o.id) : null;
    if (!b) return c.notFound();
    const loc = parseJSON<any>(b.coaching, {}).location || '';
    return c.body(ics({ uid: b.id, start: b.starts_at, end: b.ends_at, title: `${b.name} — ${pub.name}`, description: loc, location: loc, organizer: c.env.MAIL_FROM }), 200, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="session.ics"' });
  });

  site.get('/download/:token', async (c) => {
    const pub = c.get('pub');
    const o = await one<any>(c.env, `SELECT * FROM orders WHERE delivery_token = ? AND pub_id = ? AND kind IN ('product','replay')`, c.req.param('token'), pub.id);
    if (!o || o.status !== 'paid') return SiteMessage(c, 'Download unavailable', <p>This download link isn't valid.</p>, 404);
    const p = await one<any>(c.env, 'SELECT * FROM products WHERE id = ?', o.ref_id);
    const variant = o.variant_id ? await one<any>(c.env, 'SELECT * FROM product_variants WHERE id = ?', o.variant_id) : null;
    const key = variant?.file_key || p?.file_key;
    if (!p || !key) return SiteMessage(c, 'No file', <p>This product has no downloadable file.</p>, 404);
    if (p.access_days && o.paid_at + p.access_days * DAY < now()) return SiteMessage(c, 'Access expired', <p>Your access to this product has ended.</p>, 403);
    const d = parseJSON<any>(o.data, {});
    d.downloads = (d.downloads || 0) + 1;
    if (d.downloads > 25) return SiteMessage(c, 'Download limit reached', <p>This link has been used too many times. Reply to your receipt email and we'll help.</p>, 429);
    await run(c.env, 'UPDATE orders SET data = ? WHERE id = ?', JSON.stringify(d), o.id);
    const name = (key.split('/').pop() || 'download').replace(/^[a-z0-9]{16}/, slugName(p.name));
    return serveObject(c.env, key, c.req.raw, { 'content-disposition': `attachment; filename="${name.replace(/"/g, '')}"`, 'cache-control': 'private, no-store' });
  });

  // ───── Sponsorship booking
  site.get('/sponsor', async (c) => {
    const pub = c.get('pub');
    const base = toBase(c);
    await trackView(c);
    const products = await all<any>(c.env, 'SELECT * FROM sponsorship_products WHERE pub_id = ? AND active = 1 ORDER BY price_cents', pub.id);
    const subs = await val<number>(c.env, `SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND status = 'active'`, pub.id);
    const booked = await all<any>(c.env, `SELECT o.scheduled_for FROM ad_opportunities o JOIN ad_campaigns k ON k.id = o.campaign_id WHERE o.pub_id = ? AND k.owner_pub_id = ? AND o.scheduled_for > ? AND k.status = 'active'`, pub.id, pub.id, now());
    if (!products.length) return SiteMessage(c, `Sponsor ${pub.name}`, <p>Sponsorships aren't open right now. Contact us at {pub.reply_to || c.env.MAIL_FROM}.</p>);
    const minDate = new Date(now() + 3 * DAY).toISOString().slice(0, 10);
    return page(c, `Sponsor ${pub.name}`, (
      <section class="s-section"><div class="s-wrap s-narrow">
        <h1>Sponsor {pub.name}</h1>
        <p class="s-muted">Reach {subs.toLocaleString('en-US')} engaged subscribers. {pub.description}</p>
        <div class="s-grid" style="margin:20px 0">{products.map((p) => <div class="s-box"><strong>{p.name}</strong><div class="s-price" style="font-size:24px">{money(p.price_cents)}</div><p class="s-small s-muted">{FORMATS.find(([k]) => k === p.format)?.[1]}</p><p class="s-small">{p.description}</p></div>)}</div>
        {booked.length > 0 && <p class="s-small s-muted">Already booked: {booked.map((b) => fmtDate(b.scheduled_for)).join(', ')}</p>}
        <form method="post" action={`${base}/sponsor`} class="s-box s-stack">
          <label class="s-field"><span>Placement</span><select class="s-input" name="product_id">{products.map((p) => <option value={p.id}>{p.name} — {money(p.price_cents)}</option>)}</select></label>
          <label class="s-field"><span>Preferred date</span><input class="s-input" type="date" name="date" min={minDate} required /></label>
          <label class="s-field"><span>Company</span><input class="s-input" name="company" required /></label>
          <label class="s-field"><span>Contact email</span><input class="s-input" type="email" name="email" required /></label>
          <label class="s-field"><span>Website</span><input class="s-input" type="url" name="website" placeholder="https://" /></label>
          <label class="s-field"><span>Headline</span><input class="s-input" name="headline" maxlength={100} required /></label>
          <label class="s-field"><span>Ad copy</span><textarea class="s-input" name="body" rows={4} maxlength={600} style="height:auto;padding:10px 14px" required></textarea></label>
          <label class="s-field"><span>Link</span><input class="s-input" type="url" name="url" required placeholder="https://" /></label>
          <label class="s-field"><span>Image URL (optional)</span><input class="s-input" type="url" name="image_url" /></label>
          <label class="s-field"><span>Button label</span><input class="s-input" name="cta" value="Learn more" maxlength={30} /></label>
          <button class="s-btn">Continue to payment</button>
        </form>
      </div></section>
    ));
  });

  site.post('/sponsor', async (c) => {
    const pub = c.get('pub');
    const base = toBase(c);
    if (!(await checkoutGuard(c))) return err(c, `${base}/sponsor`, 'Too many attempts. Please try again later.');
    const f = await form(c.req);
    const sp = await one<any>(c.env, 'SELECT * FROM sponsorship_products WHERE id = ? AND pub_id = ? AND active = 1', f.product_id, pub.id);
    if (!sp) return err(c, `${base}/sponsor`, 'Pick a placement.');
    const v = await validateEmail(str(f.email), { strict: true });
    if (!v.ok) return err(c, `${base}/sponsor`, v.reason || 'Enter a valid email.');
    let url: URL;
    try { url = new URL(str(f.url)); if (!/^https?:$/.test(url.protocol)) throw 0; } catch { return err(c, `${base}/sponsor`, 'Enter a valid link.'); }
    const date = Date.parse(str(f.date));
    const advId = id(), campId = id(), oppId = id();
    await insert(c.env, 'advertisers', { id: advId, name: str(f.company, 120), website: str(f.website, 500) || null, contact_email: v.email, owner_pub_id: pub.id, created_at: now() });
    await insert(c.env, 'ad_campaigns', { id: campId, advertiser_id: advId, owner_pub_id: pub.id, name: `${sp.name} — ${str(f.company, 80)}`, headline: str(f.headline, 100), body: str(f.body, 600), image_url: str(f.image_url, 1000) || null, cta_label: str(f.cta, 30) || 'Learn more', url: url.toString(), pricing: 'flat', rate_cents: sp.price_cents, budget_cents: sp.price_cents, review_status: 'pending', starts_at: isNaN(date) ? null : date, status: 'pending', created_at: now() });
    await insert(c.env, 'ad_opportunities', { id: oppId, campaign_id: campId, pub_id: pub.id, status: 'pending', scheduled_for: isNaN(date) ? null : date, created_at: now() });
    const r = await createCheckout(c.env, { pub, kind: 'sponsorship', refId: sp.id, email: v.email, name: str(f.company, 120), amountCents: sp.price_cents, currency: 'usd', description: `Sponsorship: ${sp.name} (${str(f.date)})`, data: { campaign_id: campId, opportunity_id: oppId, date: str(f.date), company: str(f.company, 120), product_name: sp.name } });
    return c.redirect(r.url, 303);
  });
}

function slugName(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'file';
}

export { esc };
