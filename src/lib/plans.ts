// Platform plans for the hosted service (Lnkbase Newsletter): the service's own pricing — separate from the paid tiers
// creators sell to their readers. Every plan has every feature; plans differ only in limits:
//   - active subscribers across all of a workspace's publications
//   - marketing emails sent per calendar month (UTC): newsletters + automation emails. Transactional mail (login links,
//     receipts, confirmations) and test sends never count.
// Readers are never turned away: signups and imports over the subscriber cap are accepted, but sending is blocked until
// the workspace upgrades. Sends that would go over the monthly email allowance are blocked before they start.
//
// Everything tunable lives in this file: DEFAULT_PLANS (seeded into `platform_plans` by migration 0022 and editable
// afterwards in Platform admin → Plans) and LIMITS (new-account ramp, approval threshold, campaign/account safety
// thresholds, import quality gate, usage warning level, failed-payment grace).
import type { Env, Publication } from '../types';
import { one, all, run, insert } from './db';
import { appUrl } from './pub';
import { id, now, DAY, MIN, num, esc } from './util';

export const BRAND = { name: 'Lnkbase Newsletter', url: 'https://hive.lnkbase.com' };

export interface PlanDef {
  id: string;
  name: string;
  description: string;
  monthly_cents: number;
  annual_cents: number;
  /** active subscribers across the workspace; null = unlimited */
  max_subscribers: number | null;
  /** marketing emails per calendar month (UTC); null = unlimited */
  monthly_emails: number | null;
  /** "Sent with Lnkbase Newsletter" footer line in emails + badge on publication sites */
  branding: boolean;
}

export interface PlatformPlan extends PlanDef {
  position: number;
  active: boolean;
  stripe_product_id: string | null;
  stripe_price_monthly: string | null;
  stripe_price_annual: string | null;
}

/** Defaults — the single place to change the price list for new installs (annual = 10× monthly). */
export const DEFAULT_PLANS: PlanDef[] = [
  { id: 'free', name: 'Free', description: 'Everything you need to start.', monthly_cents: 0, annual_cents: 0, max_subscribers: 500, monthly_emails: 2_500, branding: true },
  { id: 'starter', name: 'Starter', description: 'For a growing newsletter.', monthly_cents: 1_200, annual_cents: 12_000, max_subscribers: 2_500, monthly_emails: 12_500, branding: false },
  { id: 'pro', name: 'Pro', description: 'For established publications.', monthly_cents: 2_900, annual_cents: 29_000, max_subscribers: 10_000, monthly_emails: 50_000, branding: false },
  { id: 'scale', name: 'Scale', description: 'For large audiences and media companies.', monthly_cents: 12_900, annual_cents: 129_000, max_subscribers: 50_000, monthly_emails: 250_000, branding: false },
];
export const FREE_PLAN_ID = 'free';

/** Features every plan includes (shown on plan cards and the pricing page). */
export const PLAN_FEATURES = ['Every feature included', '0% fee on your revenue', 'Custom domains', 'Paid subscriptions, products & events', 'Automations, API & MCP'];

/** Sending-safety and quota constants (industry-standard heuristics). */
export const LIMITS = {
  /** warn (dashboard banner + one email to the owner per month) at this share of a limit */
  WARN_AT: 0.8,
  /** failed payment: paid limits stay for this long, then the workspace falls back to Free limits */
  GRACE_DAYS: 7,
  /** brand-new workspaces: daily cap on marketing emails for their first days */
  NEW_ACCOUNT_DAYS: 3,
  NEW_ACCOUNT_DAILY_CAP: 200,
  /** first campaign above this many recipients from a not-yet-trusted workspace needs superadmin approval */
  APPROVAL_RECIPIENTS: 1_000,
  /** a running campaign pauses itself above these rates, once it has at least CAMPAIGN_MIN_DELIVERIES attempts */
  CAMPAIGN_MIN_DELIVERIES: 200,
  CAMPAIGN_MAX_HARD_BOUNCE_RATE: 0.02,
  CAMPAIGN_MAX_COMPLAINT_RATE: 0.0008,
  /** account-level: sending is suspended pending review above these rates over the window */
  ACCOUNT_WINDOW_DAYS: 30,
  ACCOUNT_MIN_DELIVERIES: 200,
  ACCOUNT_MAX_BOUNCE_RATE: 0.05,
  ACCOUNT_MAX_COMPLAINT_RATE: 0.003,
  /** imports are rejected when more than this share of rows is invalid / disposable */
  IMPORT_MAX_INVALID_RATE: 0.1,
  /** imports need the consent checkbox on these plans (and from new accounts on any plan) */
  IMPORT_CONSENT_PLANS: ['free'] as string[],
};

// ───────── plans ─────────
let planCache: { at: number; plans: PlatformPlan[] } | null = null;

function fromRow(r: any): PlatformPlan {
  return {
    id: r.id, name: r.name, description: r.description || '', monthly_cents: Number(r.monthly_cents) || 0, annual_cents: Number(r.annual_cents) || 0,
    max_subscribers: r.max_subscribers == null ? null : Number(r.max_subscribers), monthly_emails: r.monthly_emails == null ? null : Number(r.monthly_emails),
    branding: !!r.branding, position: Number(r.position) || 0, active: r.active == null ? true : !!r.active,
    stripe_product_id: r.stripe_product_id || null, stripe_price_monthly: r.stripe_price_monthly || null, stripe_price_annual: r.stripe_price_annual || null,
  };
}

async function loadPlans(env: Env): Promise<PlatformPlan[]> {
  if (planCache && now() - planCache.at < MIN) return planCache.plans;
  let plans: PlatformPlan[] = [];
  try { plans = (await all<any>(env, 'SELECT * FROM platform_plans ORDER BY position, monthly_cents')).map(fromRow); } catch { plans = []; }
  if (!plans.length) plans = DEFAULT_PLANS.map((p, i) => fromRow({ ...p, position: i, active: 1 }));
  planCache = { at: now(), plans };
  return plans;
}

export function clearPlanCache() { planCache = null; }

/**
 * The hosted service's plans, cheapest first — used by the marketing site's pricing page and the Plan & usage page.
 * Only active plans unless `includeInactive`. Prices are in cents (USD); annual_cents is the yearly price.
 */
export async function listPlans(env: Env, opts: { includeInactive?: boolean } = {}): Promise<PlatformPlan[]> {
  const plans = await loadPlans(env);
  return opts.includeInactive ? plans : plans.filter((p) => p.active);
}

export async function getPlan(env: Env, planId: string | null | undefined): Promise<PlatformPlan> {
  const plans = await loadPlans(env);
  return plans.find((p) => p.id === planId) || plans.find((p) => p.id === FREE_PLAN_ID) || fromRow({ ...DEFAULT_PLANS[0] });
}

/** Price per month for comparing plans across intervals. */
export function monthlyEquivalent(p: PlanDef, interval: string | null | undefined): number {
  return interval === 'year' ? p.annual_cents / 12 : p.monthly_cents;
}

export function planPrice(p: PlanDef, interval: string | null | undefined): number {
  return interval === 'year' ? p.annual_cents : p.monthly_cents;
}

// ───────── workspaces ─────────
export interface WorkspaceRow {
  id: string; name: string; owner_id: string; created_at: number;
  plan_id: string; plan_interval: string | null; plan_status: string; plan_period_end: number | null;
  plan_pending_id: string | null; plan_pending_interval: string | null; plan_grace_until: number | null;
  stripe_customer_id: string | null; stripe_subscription_id: string | null;
  sending_status: string; sending_note: string | null; sending_changed_at: number | null; trusted_at: number | null; usage_warned: string | null;
}

export async function getWorkspace(env: Env, wsId: string): Promise<WorkspaceRow | null> {
  return one<WorkspaceRow>(env, 'SELECT * FROM workspaces WHERE id = ?', wsId);
}

export function superadminEmails(env: Env): string[] {
  return (env.SUPERADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Instance operator: users.is_superadmin or listed in SUPERADMIN_EMAILS. */
export function isSuperadmin(env: Env, user: { email: string; is_superadmin?: number } | null | undefined): boolean {
  if (!user) return false;
  return !!user.is_superadmin || superadminEmails(env).includes(user.email.toLowerCase());
}

export async function ownerOf(env: Env, ws: Pick<WorkspaceRow, 'owner_id'>): Promise<{ id: string; email: string; name: string; is_superadmin: number } | null> {
  return one(env, 'SELECT id, email, name, is_superadmin FROM users WHERE id = ?', ws.owner_id);
}

/** Superadmins' own workspaces are never capped (no plan limits, ramp, approval or account suspension). */
export async function isExempt(env: Env, ws: Pick<WorkspaceRow, 'owner_id'>): Promise<boolean> {
  return isSuperadmin(env, await ownerOf(env, ws));
}

/** The plan whose limits apply now: the subscribed plan, or Free once a failed payment's grace period has ended. */
export function effectivePlanId(ws: Pick<WorkspaceRow, 'plan_id' | 'plan_status' | 'plan_grace_until'>): string {
  if (ws.plan_status === 'past_due' && ws.plan_grace_until && ws.plan_grace_until < now()) return FREE_PLAN_ID;
  return ws.plan_id || FREE_PLAN_ID;
}

export function monthStart(t = now()): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
export function nextMonthStart(t = now()): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
const monthKey = (t = now()) => new Date(t).toISOString().slice(0, 7);

// ───────── usage ─────────
export interface Usage {
  /** active subscribers across the workspace's publications */
  subscribers: number;
  /** marketing emails sent since the 1st of this month (UTC) */
  emails_month: number;
  /** marketing emails sent in the last 24 hours (new-account ramp) */
  emails_24h: number;
  /** recipients still to go in newsletters that are sending or waiting for approval (reserved against the allowance) */
  in_flight: number;
}

const usageCache = new Map<string, { at: number; u: Usage }>();
const PUBS = `SELECT id FROM publications WHERE workspace_id = ? AND status != 'deleted'`;

export async function usage(env: Env, wsId: string, opts: { cachedMs?: number } = {}): Promise<Usage> {
  const hit = usageCache.get(wsId);
  if (opts.cachedMs && hit && now() - hit.at < opts.cachedMs) return hit.u;
  const t = now();
  const [subs, month, day, flight] = await Promise.all([
    one<{ n: number }>(env, `SELECT COUNT(*) AS n FROM subscribers WHERE status = 'active' AND pub_id IN (${PUBS})`, wsId),
    one<{ n: number }>(env, `SELECT COUNT(*) AS n FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE d.pub_id IN (${PUBS}) AND d.sent_at >= ? AND s.kind NOT IN ('test','try')`, wsId, monthStart(t)),
    one<{ n: number }>(env, `SELECT COUNT(*) AS n FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE d.pub_id IN (${PUBS}) AND d.sent_at >= ? AND s.kind NOT IN ('test','try')`, wsId, t - DAY),
    one<{ n: number }>(env, `SELECT COALESCE(SUM(MAX(total - sent - failed, 0)), 0) AS n FROM sends WHERE pub_id IN (${PUBS}) AND kind = 'post' AND status IN ('sending','testing','pending_approval')`, wsId),
  ]);
  const u: Usage = { subscribers: subs?.n || 0, emails_month: month?.n || 0, emails_24h: day?.n || 0, in_flight: flight?.n || 0 };
  usageCache.set(wsId, { at: t, u });
  return u;
}

/** Count emails we just approved against the cached usage, so cached checks (automations) don't overshoot. */
function reserve(wsId: string, n: number) {
  const hit = usageCache.get(wsId);
  if (hit) { hit.u.emails_month += n; hit.u.emails_24h += n; }
}

// ───────── status ─────────
export interface PlanStatus {
  ws: WorkspaceRow;
  /** the plan the workspace is subscribed to */
  plan: PlatformPlan;
  /** the plan whose limits apply now (Free after the failed-payment grace period) */
  effective: PlatformPlan;
  exempt: boolean;
  usage: Usage;
  pct: { subscribers: number; emails: number };
  newAccount: { active: boolean; endsAt: number; cap: number; remaining: number };
  suspended: boolean;
  overSubscribers: boolean;
  emailsLeft: number; // Infinity when unlimited
  warnings: string[];
  upgradeUrl: string;
}

export async function planStatus(env: Env, wsOrId: string | WorkspaceRow, opts: { cachedMs?: number } = {}): Promise<PlanStatus | null> {
  const ws = typeof wsOrId === 'string' ? await getWorkspace(env, wsOrId) : wsOrId;
  if (!ws) return null;
  const [plan, effective, exempt, u] = await Promise.all([getPlan(env, ws.plan_id), getPlan(env, effectivePlanId(ws)), isExempt(env, ws), usage(env, ws.id, opts)]);
  const maxSubs = exempt ? null : effective.max_subscribers;
  const maxEmails = exempt ? null : effective.monthly_emails;
  const pct = { subscribers: maxSubs ? u.subscribers / maxSubs : 0, emails: maxEmails ? u.emails_month / maxEmails : 0 };
  const endsAt = ws.created_at + LIMITS.NEW_ACCOUNT_DAYS * DAY;
  const newActive = !exempt && now() < endsAt;
  const st: PlanStatus = {
    ws, plan, effective, exempt, usage: u, pct,
    newAccount: { active: newActive, endsAt, cap: LIMITS.NEW_ACCOUNT_DAILY_CAP, remaining: newActive ? Math.max(0, LIMITS.NEW_ACCOUNT_DAILY_CAP - u.emails_24h) : Infinity },
    suspended: !exempt && ws.sending_status === 'suspended',
    overSubscribers: maxSubs != null && u.subscribers > maxSubs,
    emailsLeft: maxEmails == null ? Infinity : Math.max(0, maxEmails - u.emails_month - u.in_flight),
    warnings: [],
    upgradeUrl: appUrl(env, '/app/settings/plan'),
  };
  if (st.suspended) st.warnings.push(`Sending is suspended pending review${ws.sending_note ? `: ${ws.sending_note}` : ''}. Contact support to restore it.`);
  if (ws.plan_status === 'past_due') {
    st.warnings.push(ws.plan_grace_until && ws.plan_grace_until > now()
      ? `Your last payment failed. Update your payment method before ${new Date(ws.plan_grace_until).toUTCString().slice(0, 16)} to keep ${plan.name} limits.`
      : `Your payment failed and the grace period has ended — Free plan limits apply until you update your payment method.`);
  }
  if (st.overSubscribers) st.warnings.push(`You have ${num(u.subscribers)} active subscribers — more than the ${num(maxSubs!)} on the ${effective.name} plan. New readers are still being added, but sending is paused until you upgrade.`);
  else if (maxSubs && pct.subscribers >= LIMITS.WARN_AT) st.warnings.push(`You're at ${Math.floor(pct.subscribers * 100)}% of your ${num(maxSubs)} subscriber limit on ${effective.name}.`);
  if (maxEmails && u.emails_month >= maxEmails) st.warnings.push(`You've used all ${num(maxEmails)} emails on ${effective.name} this month. Sending is paused until ${new Date(nextMonthStart()).toUTCString().slice(5, 16)} or until you upgrade.`);
  else if (maxEmails && pct.emails >= LIMITS.WARN_AT) st.warnings.push(`You've used ${Math.floor(pct.emails * 100)}% of this month's ${num(maxEmails)} emails on ${effective.name}.`);
  return st;
}

export async function planStatusForPub(env: Env, pub: Pick<Publication, 'workspace_id'>, opts: { cachedMs?: number } = {}) {
  return planStatus(env, pub.workspace_id, opts);
}

/** Does this publication's workspace show "Sent with Lnkbase Newsletter" branding? Cached per isolate for a minute. */
const brandCache = new Map<string, { at: number; v: boolean }>();
export async function showsBranding(env: Env, workspaceId: string): Promise<boolean> {
  const hit = brandCache.get(workspaceId);
  if (hit && now() - hit.at < MIN) return hit.v;
  let v = false;
  try {
    const ws = await getWorkspace(env, workspaceId);
    v = !!ws && (await getPlan(env, effectivePlanId(ws))).branding && !(await isExempt(env, ws));
  } catch { v = false; }
  brandCache.set(workspaceId, { at: now(), v });
  return v;
}

export function clearBrandingCache(workspaceId?: string) {
  if (workspaceId) brandCache.delete(workspaceId);
  else brandCache.clear();
}

export function brandingUrl(slug: string) {
  return `${BRAND.url}/?ref=${encodeURIComponent(slug)}`;
}

/** Footer line for Free-plan emails. */
export function emailBrandingHtml(slug: string, color = '#6b7280') {
  return `<div style="margin:6px 0 10px"><a href="${esc(brandingUrl(slug))}" style="color:${color};text-decoration:none">Sent with <strong>${esc(BRAND.name)}</strong></a></div>`;
}

// ───────── send gate ─────────
export class SendBlockedError extends Error {
  code: string;
  upgradeUrl: string;
  constructor(code: string, message: string, upgradeUrl: string) {
    super(message);
    this.code = code;
    this.upgradeUrl = upgradeUrl;
  }
}

export interface Gate { ok: boolean; code?: 'suspended' | 'subscriber_cap' | 'email_allowance'; reason?: string; upgradeUrl: string; status?: PlanStatus }

/**
 * May this publication send `recipients` marketing emails now? Checked before a newsletter starts (fresh usage) and
 * before each automation email (usage cached for a minute). The new-account daily cap throttles instead of blocking
 * (see sender.ts), and first-large-campaign approval holds instead of blocking (see safety.ts).
 */
export async function checkSend(env: Env, pub: Pick<Publication, 'workspace_id' | 'id'>, recipients: number, opts: { cachedMs?: number; dryRun?: boolean } = {}): Promise<Gate> {
  const st = await planStatus(env, pub.workspace_id, opts);
  const upgradeUrl = appUrl(env, '/app/settings/plan');
  if (!st) return { ok: true, upgradeUrl };
  if (st.exempt) return { ok: true, upgradeUrl, status: st };
  await maybeWarnUsage(env, st).catch(() => {});
  if (st.suspended) return { ok: false, code: 'suspended', reason: `Sending is suspended for this account pending review${st.ws.sending_note ? ` (${st.ws.sending_note})` : ''}. Contact support.`, upgradeUrl, status: st };
  if (st.overSubscribers) {
    return { ok: false, code: 'subscriber_cap', upgradeUrl, status: st, reason: `Your workspace has ${num(st.usage.subscribers)} active subscribers, over the ${num(st.effective.max_subscribers!)} included in the ${st.effective.name} plan. Every reader is kept, but sending is paused until you upgrade.` };
  }
  if (st.emailsLeft !== Infinity && recipients > st.emailsLeft) {
    const lim = st.effective.monthly_emails!;
    return { ok: false, code: 'email_allowance', upgradeUrl, status: st, reason: `This would send ${num(recipients)} email${recipients === 1 ? '' : 's'}, but only ${num(st.emailsLeft)} of your ${num(lim)} monthly emails on the ${st.effective.name} plan are left${st.usage.in_flight ? ` (${num(st.usage.in_flight)} are reserved by sends in progress)` : ''}. Upgrade, or wait until the allowance resets on ${new Date(nextMonthStart()).toUTCString().slice(5, 16)}.` };
  }
  if (!opts.dryRun) reserve(st.ws.id, recipients);
  return { ok: true, upgradeUrl, status: st };
}

/** Throws SendBlockedError when the gate says no. */
export async function assertCanSend(env: Env, pub: Pick<Publication, 'workspace_id' | 'id'>, recipients: number): Promise<Gate> {
  const g = await checkSend(env, pub, recipients);
  if (!g.ok) {
    await logPlatformEvent(env, { workspaceId: pub.workspace_id, kind: 'send_blocked', detail: `${g.code}: ${recipients} recipients` });
    throw new SendBlockedError(g.code!, g.reason!, g.upgradeUrl);
  }
  return g;
}

/** One email per month to the owner when a workspace reaches 80% of a limit. */
export async function maybeWarnUsage(env: Env, st: PlanStatus) {
  if (st.exempt) return;
  const hot = st.pct.subscribers >= LIMITS.WARN_AT || st.pct.emails >= LIMITS.WARN_AT;
  if (!hot || st.ws.usage_warned === monthKey()) return;
  const res = await run(env, 'UPDATE workspaces SET usage_warned = ? WHERE id = ? AND (usage_warned IS NULL OR usage_warned != ?)', monthKey(), st.ws.id, monthKey());
  if (!res.meta.changes) return;
  st.ws.usage_warned = monthKey();
  const owner = await ownerOf(env, st.ws);
  if (!owner) return;
  const lines = [
    st.effective.max_subscribers ? `<li>Active subscribers: <strong>${num(st.usage.subscribers)}</strong> of ${num(st.effective.max_subscribers)} (${Math.floor(st.pct.subscribers * 100)}%)</li>` : '',
    st.effective.monthly_emails ? `<li>Emails this month: <strong>${num(st.usage.emails_month)}</strong> of ${num(st.effective.monthly_emails)} (${Math.floor(st.pct.emails * 100)}%)</li>` : '',
  ].join('');
  const { sendTransactional, button } = await import('./email');
  await sendTransactional(env, owner.email, `You're close to your ${st.effective.name} plan limits`,
    `<p>Heads up — your workspace <strong>${esc(st.ws.name)}</strong> is using more than ${Math.round(LIMITS.WARN_AT * 100)}% of its plan:</p><ul>${lines}</ul>
     <p>Readers are never turned away, but sending pauses once a limit is reached. Upgrading takes a minute and applies immediately.</p>${button('See plans & usage', st.upgradeUrl)}`);
  await logPlatformEvent(env, { workspaceId: st.ws.id, kind: 'usage_warning', detail: `subs ${Math.floor(st.pct.subscribers * 100)}%, emails ${Math.floor(st.pct.emails * 100)}%` });
}

export async function logPlatformEvent(env: Env, e: { workspaceId?: string | null; sendId?: string | null; kind: string; detail?: string; actor?: string | null }) {
  await insert(env, 'platform_events', { id: id(), workspace_id: e.workspaceId ?? null, send_id: e.sendId ?? null, kind: e.kind, detail: (e.detail || '').slice(0, 1000), actor: e.actor ?? null, created_at: now() }).catch(() => {});
}
