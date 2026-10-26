/** @jsxImportSource hono/jsx */
// Settings → Plan & usage: the workspace's Lnkbase Newsletter plan, usage bars, plan cards, upgrade/downgrade.
import type { Hono } from 'hono';
import { raw } from 'hono/html';
import type { AppEnv } from '../../types';
import { requirePerm, can, audit } from '../../lib/auth';
import { listPlans, planStatus, isSuperadmin, planPrice, monthlyEquivalent, nextMonthStart, PLAN_FEATURES, LIMITS, FREE_PLAN_ID, BRAND } from '../../lib/plans';
import { changePlan, billingPortalUrl, confirmStripeSession } from '../../lib/platformbilling';
import { sharedAddress } from '../../lib/sharedsender';
import { stripeEnabled } from '../../lib/payments';
import { money, num, fmtDate, form, str } from '../../lib/util';
import { Card, Btn, Badge, Help, back, flash } from '../../ui/components';
import { page } from './ui';

const STYLE = `
.usage-row{display:grid;grid-template-columns:200px 1fr 170px;gap:12px;align-items:center;margin:10px 0;font-size:14px}
.usage-row .progress{height:10px}.usage-row.hot .progress-bar{background:#d97706}.usage-row.over .progress-bar{background:#dc2626}
.usage-v{text-align:right;font-variant-numeric:tabular-nums}
.plan-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
@media(max-width:1100px){.plan-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:640px){.plan-grid{grid-template-columns:1fr}.usage-row{grid-template-columns:1fr}.usage-v{text-align:left}}
.plan-card{border:1px solid var(--border);border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:10px;background:var(--surface)}
.plan-card.current{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.plan-card h4{margin:0;font-size:17px}.plan-price{font-size:28px;font-weight:800}.plan-price small{font-size:13px;font-weight:500;color:var(--muted)}
.plan-card ul{margin:0;padding-left:18px;font-size:13.5px;line-height:1.7}.plan-card form{margin-top:auto}
.iv-toggle{display:inline-flex;border:1px solid var(--border);border-radius:999px;padding:3px;gap:2px}.iv-toggle a{padding:5px 14px;border-radius:999px;font-size:13px;text-decoration:none;color:inherit}.iv-toggle a.on{background:var(--accent);color:#fff}
`;

function UsageRow(p: { label: string; value: number; max: number | null; hint?: string }) {
  const ratio = p.max ? p.value / p.max : 0;
  return (
    <div class={`usage-row ${ratio > 1 || (p.max && p.value >= p.max) ? 'over' : ratio >= LIMITS.WARN_AT ? 'hot' : ''}`} data-usage={p.label}>
      <div><strong>{p.label}</strong>{p.hint && <div class="small muted">{p.hint}</div>}</div>
      <div class="progress"><div class="progress-bar" style={`width:${p.max ? Math.min(100, ratio * 100) : 0}%`} /></div>
      <div class="usage-v">{num(p.value)} / {p.max == null ? 'unlimited' : num(p.max)}{p.max ? ` (${Math.floor(ratio * 100)}%)` : ''}</div>
    </div>
  );
}

export function registerPlan(dash: Hono<AppEnv>) {
  dash.get('/plan', async (c) => {
    const pub = c.get('pub');
    const user = c.get('user');
    // returning from Stripe Checkout: confirm the session right away
    const co = c.req.query('checkout');
    if (co && c.req.query('session_id')) {
      if (await confirmStripeSession(c.env, co, c.req.query('session_id')!).catch(() => false)) flash(c, 'Payment received — your new plan is active.');
      return c.redirect('/app/settings/plan', 303);
    }
    const [st, plans] = await Promise.all([planStatus(c.env, pub.workspace_id), listPlans(c.env)]);
    if (!st) return c.text('Workspace not found', 404);
    const interval = c.req.query('interval') === 'year' ? 'year' : c.req.query('interval') === 'month' ? 'month' : (st.ws.plan_interval as 'month' | 'year') || 'month';
    const admin = can(c.get('role'), 'admin');
    const pending = st.ws.plan_pending_id ? plans.find((p) => p.id === st.ws.plan_pending_id) : null;
    const lim = st.effective;
    const sim = !stripeEnabled(c.env);
    const curInterval = st.ws.plan_interval || 'month';
    return page(c, 'plan', 'Plan & usage', <>
      <style>{raw(STYLE)}</style>
      {st.suspended && <div class="callout danger" data-plan-alert="suspended"><strong>Sending is suspended pending review.</strong> {st.ws.sending_note} Your site and signups keep working. Reply to the email we sent you, or contact support.</div>}
      {st.warnings.filter((w) => !w.startsWith('Sending is suspended')).map((w) => <div class="callout warn" data-plan-alert>{w}</div>)}
      {st.exempt && <div class="callout ok">This workspace belongs to a platform operator, so no plan limits apply.</div>}
      {pending && <div class="callout" data-plan-pending>Scheduled: you'll switch to <strong>{pending.name}</strong> on {st.ws.plan_period_end ? fmtDate(st.ws.plan_period_end) : 'the end of the period'}. {admin && <form method="post" action="/app/settings/plan/change" style="display:inline"><input type="hidden" name="plan_id" value={st.ws.plan_id} /><input type="hidden" name="interval" value={curInterval} /><button class="btn btn-ghost btn-sm">Keep {st.plan.name}</button></form>}</div>}
      {st.newAccount.active && <div class="callout" data-plan-ramp>New account: for your first {LIMITS.NEW_ACCOUNT_DAYS} days you can send up to {LIMITS.NEW_ACCOUNT_DAILY_CAP} emails per 24 hours (until {fmtDate(st.newAccount.endsAt)}). Larger sends go out automatically over the following days. Your first campaign to more than {num(LIMITS.APPROVAL_RECIPIENTS)} readers gets a one-time review.</div>}

      <Card title={<>Current plan: {st.plan.name} {st.plan.id !== st.effective.id && <Badge tone="red">Free limits apply</Badge>} {st.ws.plan_status === 'past_due' && <Badge tone="red">Payment failed</Badge>}</>}
        actions={admin && !sim && st.ws.stripe_customer_id ? <form method="post" action="/app/settings/plan/portal"><Btn kind="secondary" small>Manage billing</Btn></form> : undefined}>
        <p class="muted" style="margin-top:0">
          {st.plan.id === FREE_PLAN_ID ? 'Free forever.' : `${money(planPrice(st.plan, curInterval))} / ${curInterval}`}
          {st.ws.plan_period_end && st.plan.id !== FREE_PLAN_ID ? ` · ${pending ? 'Ends' : 'Renews'} ${fmtDate(st.ws.plan_period_end)}` : ''}
          {' · '}Every feature included · 0% fee on your revenue
        </p>
        <UsageRow label="Active subscribers" value={st.usage.subscribers} max={st.exempt ? null : lim.max_subscribers} hint="Across all publications in this workspace" />
        <UsageRow label="Emails this month" value={st.usage.emails_month} max={st.exempt ? null : lim.monthly_emails} hint={`Resets ${fmtDate(nextMonthStart())} · newsletters + automations`} />
        {st.usage.in_flight > 0 && <Help>{num(st.usage.in_flight)} more emails are reserved by sends in progress.</Help>}
        {st.newAccount.active && <UsageRow label="Sent in the last 24h" value={st.usage.emails_24h} max={LIMITS.NEW_ACCOUNT_DAILY_CAP} hint="New-account daily limit" />}
        <Help>Readers are never turned away: signups and imports over your subscriber limit are kept, but sending pauses until you upgrade. Login links, receipts and test emails don't count.</Help>
      </Card>

      <Card title="Plans" actions={<div class="iv-toggle"><a href="?interval=month" class={interval === 'month' ? 'on' : ''}>Monthly</a><a href="?interval=year" class={interval === 'year' ? 'on' : ''}>Annual · 2 months free</a></div>}>
        <div class="plan-grid">
          {plans.map((p) => {
            const isCur = p.id === st.ws.plan_id && (p.id === FREE_PLAN_ID || interval === curInterval);
            const isPending = pending?.id === p.id;
            const up = st.plan.id === FREE_PLAN_ID ? p.id !== FREE_PLAN_ID : monthlyEquivalent(p, interval) > monthlyEquivalent(st.plan, curInterval) || (p.id === st.plan.id && interval === 'year' && curInterval === 'month');
            const label = isCur ? 'Current plan' : isPending ? 'Scheduled' : p.id === st.plan.id ? `Switch to ${interval === 'year' ? 'annual' : 'monthly'}` : up ? `Upgrade to ${p.name}` : `Downgrade to ${p.name}`;
            return (
              <div class={`plan-card ${isCur ? 'current' : ''}`} data-plan={p.id}>
                <h4>{p.name} {isCur && <Badge tone="green">Current</Badge>}</h4>
                <div class="plan-price">{p.monthly_cents === 0 ? '$0' : money(interval === 'year' ? Math.round(p.annual_cents / 12) : p.monthly_cents)}<small> / month{interval === 'year' && p.annual_cents ? `, ${money(p.annual_cents)} billed yearly` : ''}</small></div>
                <p class="muted small" style="margin:0">{p.description}</p>
                <ul>
                  <li>{p.max_subscribers == null ? 'Unlimited' : `Up to ${num(p.max_subscribers)}`} subscribers</li>
                  <li>{p.monthly_emails == null ? 'Unlimited' : num(p.monthly_emails)} emails / month</li>
                  {PLAN_FEATURES.slice(0, 2).map((f) => <li>{f}</li>)}
                  <li>{p.branding ? `"Sent with ${BRAND.name}" footer & badge` : 'No platform branding'}</li>
                </ul>
                {admin && (
                  <form method="post" action="/app/settings/plan/change">
                    <input type="hidden" name="plan_id" value={p.id} /><input type="hidden" name="interval" value={interval} />
                    <Btn kind={up && !isCur ? 'primary' : 'secondary'} disabled={isCur || isPending} attrs={{ style: 'width:100%' }}
                      confirm={!up && !isCur ? `Switch to ${p.name}? It takes effect at the end of your current billing period${p.max_subscribers ? `, with a limit of ${num(p.max_subscribers)} subscribers` : ''}.` : undefined}>{label}</Btn>
                  </form>
                )}
              </div>
            );
          })}
        </div>
        {!admin && <Help>Only workspace owners and admins can change the plan.</Help>}
        {sim && <Help>Test mode: no STRIPE_SECRET_KEY is set, so upgrades use a simulated checkout and no card is charged.</Help>}
        <Help>Upgrades apply immediately. Downgrades take effect at the end of the billing period. Need more than {num(Math.max(...plans.map((p) => p.max_subscribers || 0)))} subscribers? Contact us.</Help>
      </Card>

      <Card title="Sending address">
        <p style="margin-top:0">Without a verified domain, your emails are sent from <code>{sharedAddress(c.env, pub)}</code> with replies going to {pub.reply_to ? <code>{pub.reply_to}</code> : 'the workspace owner\'s email'}. <a href="/app/settings/domains">Verify your own domain</a> to send from your own address.</p>
      </Card>
      {isSuperadmin(c.env, user) && <p><a href="/app/admin">Platform admin →</a></p>}
    </>);
  });

  dash.post('/plan/change', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const f = await form(c.req);
    const interval = f.interval === 'year' ? 'year' : 'month';
    try {
      const r = await changePlan(c.env, pub.workspace_id, str(f.plan_id, 40), interval, c.get('user').id);
      await audit(c, 'plan.change', str(f.plan_id, 40), { interval, result: r.message });
      if (r.redirect) return c.redirect(r.redirect, 303);
      return back(c, '/app/settings/plan', r.message, r.kind || 'ok');
    } catch (e: any) {
      return back(c, '/app/settings/plan', `Billing error: ${e?.message || e}`, 'err');
    }
  });

  dash.post('/plan/portal', requirePerm('admin'), async (c) => {
    const st = await planStatus(c.env, c.get('pub').workspace_id);
    const url = st ? await billingPortalUrl(c.env, st.ws).catch(() => null) : null;
    if (!url) return back(c, '/app/settings/plan', 'Billing portal is not available.', 'err');
    return c.redirect(url, 303);
  });
}
