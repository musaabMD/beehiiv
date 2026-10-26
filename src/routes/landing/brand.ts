// Brand and pricing shown on the marketing site. Lnkbase Newsletter is one of the Lnkbase products,
// served at hive.lnkbase.com. Internal names (database, headers, package) stay "openhive".

export const BRAND = 'Lnkbase Newsletter';
export const PARENT = { name: 'Lnkbase', url: 'https://lnkbase.com' };

/** Link mark in an amber square. */
export const LOGO = '<svg width="28" height="28" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15" fill="#1c1917"/><path d="M27 37a8 8 0 0 0 11.3 0l7-7a8 8 0 0 0-11.3-11.3l-2 2" fill="none" stroke="#f59e0b" stroke-width="5.5" stroke-linecap="round"/><path d="M37 27a8 8 0 0 0-11.3 0l-7 7a8 8 0 0 0 11.3 11.3l2-2" fill="none" stroke="#fff" stroke-width="5.5" stroke-linecap="round"/></svg>';
export const FAVICON = `data:image/svg+xml,${encodeURIComponent(LOGO.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ').replace(' aria-hidden="true"', ''))}`;
export const wordmark = (size = 18) => `<span style="display:inline-flex;align-items:center;gap:10px;font-weight:800;font-size:${size}px;letter-spacing:-.01em">${LOGO}<span>Lnkbase <span style="font-weight:500;color:var(--muted)">Newsletter</span></span></span>`;

/** Hosted plans. All features on every plan; only limits differ. 0% fee on creators' revenue.
 *  Keep in sync with the platform_plans table (src/lib/plans.ts) — the pricing page prefers the table when present. */
export interface Plan { id: string; name: string; monthly: number; subscribers: number; emails: number; blurb: string; highlight?: boolean }
export const PLANS: Plan[] = [
  { id: 'free', name: 'Free', monthly: 0, subscribers: 500, emails: 2500, blurb: 'Start a newsletter today. A small "Sent with Lnkbase Newsletter" line in emails.' },
  { id: 'starter', name: 'Starter', monthly: 12, subscribers: 2500, emails: 12500, blurb: 'No "Sent with" line, every feature, room to grow.' },
  { id: 'pro', name: 'Pro', monthly: 29, subscribers: 10000, emails: 50000, blurb: 'For growing newsletters with paid tiers, products and events.', highlight: true },
  { id: 'scale', name: 'Scale', monthly: 129, subscribers: 50000, emails: 250000, blurb: 'Big lists, weekly sends, plenty of room for automations.' },
];

/** Cheapest plan that fits a list sending one issue a week (~4.3 emails per subscriber a month). null = custom. */
export function planFor(subscribers: number, plans: Plan[] = PLANS): Plan | null {
  return plans.find((p) => p.subscribers >= subscribers && p.emails >= Math.ceil(subscribers * 4.3)) || null;
}

/** Live plans from the platform_plans table (edited in Admin → Plans), shaped for the marketing pages.
 *  Falls back to PLANS when the table is empty or unreachable. */
export async function livePlans(env: any): Promise<Plan[]> {
  try {
    const { listPlans } = await import('../../lib/plans');
    const rows = await listPlans(env);
    const blurbs = new Map(PLANS.map((p) => [p.id, p]));
    const out = rows.filter((r) => r.max_subscribers != null && r.monthly_emails != null).map((r) => ({
      id: r.id, name: r.name, monthly: Math.round(r.monthly_cents / 100), subscribers: r.max_subscribers!, emails: r.monthly_emails!,
      blurb: blurbs.get(r.id)?.blurb || r.description || '', highlight: blurbs.get(r.id)?.highlight,
    }));
    return out.length ? out : PLANS;
  } catch { return PLANS; }
}
