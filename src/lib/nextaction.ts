// Next Best Action: rules-based "Suggested next steps" for the dashboard home, computed from the publication's own data.
// Each suggestion carries a one-click action: a link, or a POST form (resend to non-openers, start an automation from a
// template, create a ready-made segment).
import type { Env, Publication } from '../types';
import { all, one, val } from './db';
import { parseJSON, now, DAY } from './util';
import { tzOffsetMs } from './tz';
import type { RuleGroup } from './segments';

export interface Suggestion {
  key: string;
  icon: string;
  title: string;
  body: string;
  priority: number;          // higher first
  action: { label: string; href: string; method?: 'get' | 'post'; fields?: Record<string, string>; confirm?: string };
}

const n = (x: number) => Math.round(x).toLocaleString('en-US');
const pctS = (x: number) => `${Math.round(x)}%`;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hour12 = (h: number) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;

/** Ready-made segments the suggestions (and the Top subscribers page) can create in one click. */
export const SEGMENT_PRESETS: Record<string, { name: string; description: string; rules: (arg?: number) => RuleGroup }> = {
  inactive_90: { name: 'Inactive for 90 days', description: 'Active readers who joined over 90 days ago and have not opened in 90 days.', rules: () => ({ op: 'and', rules: [{ field: 'last_open_at', cmp: 'not_within_days', value: 90 }, { field: 'created_at', cmp: 'older_than_days', value: 90 }] }) },
  churn_high: { name: 'Paid subscribers at high churn risk', description: 'Predicted churn risk: high (recomputed every few hours).', rules: () => ({ op: 'and', rules: [{ field: 'churn_risk', cmp: 'eq', value: 'high' }] }) },
  purchase_high: { name: 'Likely buyers (free readers)', description: 'Free readers with a high predicted purchase likelihood.', rules: () => ({ op: 'and', rules: [{ field: 'purchase_likelihood', cmp: 'eq', value: 'high' }, { field: 'tier', cmp: 'eq', value: 'free' }] }) },
  top_10: { name: 'Top 10% most valuable subscribers', description: 'Value score percentile 90 or higher (engagement, revenue, referrals, recency).', rules: () => ({ op: 'and', rules: [{ field: 'value_percentile', cmp: 'gt', value: 89 }] }) },
  near_referral: { name: 'Close to a referral reward', description: 'Readers one or two referrals away from a reward milestone.', rules: (m = 3) => ({ op: 'and', rules: [{ field: 'referral_count', cmp: 'gt', value: Math.max(0, m - 3) }, { field: 'referral_count', cmp: 'lt', value: m }] }) },
  business: { name: 'Business email addresses', description: 'Readers who signed up with a work address (Subscriber Signals).', rules: () => ({ op: 'and', rules: [{ field: 'business_email', cmp: 'is_true' }] }) },
};

const preset = (key: string, label: string, arg?: number): Suggestion['action'] => ({ label, href: '/app/intel/segment', method: 'post', fields: { preset: key, ...(arg !== undefined ? { arg: String(arg) } : {}) } });

export async function suggestions(env: Env, pub: Publication, limit = 5): Promise<Suggestion[]> {
  const t = now();
  const out: Suggestion[] = [];
  const pubId = pub.id;
  const safe = async (fn: () => Promise<void>) => { try { await fn(); } catch (e) { console.error('nextaction', e); } };

  // 1. Resend the latest newsletter to readers who didn't open it
  await safe(async () => {
    const s = await one<any>(env, `SELECT se.id, se.post_id, p.title, se.created_at,
        SUM(CASE WHEN d.status IN ('sent','complained') THEN 1 ELSE 0 END) AS delivered, SUM(CASE WHEN d.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
        SUM(CASE WHEN d.status = 'sent' AND d.opened_at IS NULL AND d.subscriber_id IS NOT NULL THEN 1 ELSE 0 END) AS unopened
      FROM sends se JOIN posts p ON p.id = se.post_id JOIN deliveries d ON d.send_id = se.id
      WHERE se.pub_id = ? AND se.kind = 'post' AND se.status = 'sent' AND se.created_at BETWEEN ? AND ?
      GROUP BY se.id ORDER BY se.created_at DESC LIMIT 1`, pubId, t - 14 * DAY, t - DAY);
    if (!s || Number(s.delivered) < 20 || Number(s.unopened) < 10) return;
    const resent = await val<number>(env, `SELECT COUNT(*) FROM sends WHERE pub_id = ? AND post_id = ? AND kind = 'post' AND created_at > ?`, pubId, s.post_id, s.created_at);
    if (resent) return;
    const rate = (Number(s.opened) / Number(s.delivered)) * 100;
    if (rate >= 70) return;
    out.push({
      key: 'resend', icon: '↻', priority: 90,
      title: `Resend “${s.title || 'your last issue'}” to the ${n(s.unopened)} readers who didn't open it`,
      body: `It reached a ${pctS(rate)} open rate. A resend with a fresh subject line typically adds another third of the original opens.`,
      action: { label: 'Resend to non-openers', href: `/app/posts/${s.post_id}/resend`, method: 'post', confirm: `Resend to ${n(s.unopened)} non-openers now?` },
    });
  });

  // 2. Win back inactive readers
  await safe(async () => {
    const inactive = await val<number>(env, `SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND status = 'active' AND source != 'try_it' AND created_at < ? AND (last_open_at IS NULL OR last_open_at < ?)`, pubId, t - 90 * DAY, t - 90 * DAY);
    if (inactive < 10) return;
    const autos = await all<{ trigger: string; draft_trigger: string | null }>(env, `SELECT trigger, draft_trigger FROM automations WHERE pub_id = ? AND status != 'archived'`, pubId);
    const hasWinback = autos.some((a) => parseJSON<any>(a.trigger, {}).type === 'inactive' || parseJSON<any>(a.draft_trigger, {}).type === 'inactive');
    out.push(hasWinback
      ? { key: 'winback', icon: '☾', priority: 60, title: `${n(inactive)} readers haven't opened anything in 90 days`, body: 'You already have a re-engagement automation. Save them as a segment to exclude them from big sends and protect your deliverability.', action: preset('inactive_90', 'Create the segment') }
      : { key: 'winback', icon: '☾', priority: 75, title: `Win back ${n(inactive)} readers inactive for 90 days`, body: 'Start the re-engagement template: one "still want this?" email, then it tags or removes readers who stay silent — good for your inbox placement.', action: { label: 'Start the re-engagement template', href: '/app/automations/new', method: 'post', fields: { template: 'reengage', name: 'Re-engagement' } } });
  });

  // 3. Paid subscribers at risk of churning
  await safe(async () => {
    const r = await one<any>(env, `SELECT COUNT(*) AS n, COALESCE(SUM(monthly_value_cents), 0) AS mrr FROM subscriber_scores WHERE pub_id = ? AND churn_risk = 'high'`, pubId);
    if (!r || Number(r.n) < 1) return;
    out.push({ key: 'churn', icon: '⚠', priority: 80, title: `${n(r.n)} paid subscriber${Number(r.n) === 1 ? ' is' : 's are'} at high risk of cancelling`, body: `They bring in $${n(Number(r.mrr) / 100)}/month. A personal note or an exclusive post now is cheaper than winning them back later.`, action: preset('churn_high', 'Create an at-risk segment') });
  });

  // 4. Free readers likely to buy
  await safe(async () => {
    const likely = await val<number>(env, `SELECT COUNT(*) FROM subscriber_scores x JOIN subscribers s ON s.id = x.subscriber_id WHERE x.pub_id = ? AND x.purchase_likelihood = 'high' AND s.tier = 'free' AND s.status = 'active'`, pubId);
    if (likely < 5) return;
    const tiers = await val<number>(env, `SELECT COUNT(*) FROM tiers WHERE pub_id = ? AND status = 'active'`, pubId);
    out.push(tiers
      ? { key: 'upsell', icon: '$', priority: 65, title: `${n(likely)} free readers are likely to buy`, body: 'They are highly engaged, visit your site and click your emails. Send them a premium offer or a free trial.', action: preset('purchase_high', 'Create a likely-buyers segment') }
      : { key: 'upsell', icon: '$', priority: 55, title: `${n(likely)} engaged readers look ready to pay — but you have no paid tier`, body: 'Add a premium tier and offer them early access.', action: { label: 'Set up paid subscriptions', href: '/app/monetize' } });
  });

  // 5. Best send time (human opens over the last 90 days, in the publication's timezone)
  await safe(async () => {
    const rows = await all<{ k: string; n: number }>(env, `SELECT strftime('%w %H', created_at / 1000, 'unixepoch') AS k, COUNT(*) AS n FROM opens WHERE pub_id = ? AND is_bot = 0 AND created_at > ? GROUP BY k`, pubId, t - 90 * DAY);
    const total = rows.reduce((a, r) => a + Number(r.n), 0);
    if (total < 50) return;
    const off = Math.round(tzOffsetMs(pub.timezone || 'UTC', t) / 3600000);
    const byDay = new Array(7).fill(0), byHour = new Array(24).fill(0);
    for (const r of rows) {
      const [d, h] = r.k.split(' ').map(Number);
      let hh = h + off, dd = d;
      if (hh < 0) { hh += 24; dd = (dd + 6) % 7; } else if (hh >= 24) { hh -= 24; dd = (dd + 1) % 7; }
      byDay[dd] += Number(r.n); byHour[hh] += Number(r.n);
    }
    const bh = byHour.indexOf(Math.max(...byHour)), bd = byDay.indexOf(Math.max(...byDay));
    const hourShare = byHour[bh] / total, dayShare = byDay[bd] / total;
    // only worth saying when the best hour clearly beats an even spread (1/24 of opens)
    if (hourShare < 1.5 / 24) return;
    out.push({ key: 'send_time', icon: '◷', priority: 40, title: `Your best send time is ${DAYS[bd]} around ${hour12(bh)}`, body: `${pctS(hourShare * 100)} of the last 90 days' human opens happen between ${hour12(bh)} and ${hour12((bh + 1) % 24)}, and ${DAYS[bd]} gets ${pctS(dayShare * 100)} of opens (${pub.timezone || 'UTC'}). Schedule your next issue for then.`, action: { label: 'Write the next issue', href: '/app/posts/new' } });
  });

  // 6. Readers close to a referral milestone
  await safe(async () => {
    const milestones = (await all<{ milestone: number }>(env, 'SELECT DISTINCT milestone FROM referral_rewards WHERE pub_id = ? ORDER BY milestone', pubId)).map((m) => Number(m.milestone)).filter((m) => m > 1);
    if (!milestones.length) {
      const referrers = await val<number>(env, `SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND referral_count > 0`, pubId);
      if (referrers >= 3) out.push({ key: 'referral', icon: '★', priority: 45, title: `${n(referrers)} readers already referred a friend — reward them`, body: 'Add referral milestones (e.g. a sticker pack at 3, premium at 10) so word of mouth compounds.', action: { label: 'Set up referral rewards', href: '/app/grow' } });
      return;
    }
    let best = { m: 0, count: 0 };
    for (const m of milestones) {
      const c = await val<number>(env, `SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND status = 'active' AND referral_count BETWEEN ? AND ?`, pubId, Math.max(1, m - 2), m - 1);
      if (c > best.count) best = { m, count: c };
    }
    if (!best.count) return;
    out.push({ key: 'referral', icon: '★', priority: 50, title: `${n(best.count)} reader${best.count === 1 ? ' is' : 's are'} close to a referral milestone`, body: `They are one or two referrals away from the ${best.m}-referral reward. A friendly nudge with their link usually tips them over.`, action: preset('near_referral', 'Create the segment', best.m) });
  });

  // 7. Welcome email performance
  await safe(async () => {
    const autos = await all<any>(env, `SELECT id, name, status, trigger FROM automations WHERE pub_id = ? AND status = 'active'`, pubId);
    const welcome = autos.find((a) => ['welcome', 'signup'].includes(parseJSON<any>(a.trigger, {}).type));
    const subs = await val<number>(env, `SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND status = 'active' AND source != 'try_it'`, pubId);
    if (!welcome) {
      if (subs >= 1) out.push({ key: 'welcome', icon: '✉', priority: 70, title: 'New readers get no welcome email', body: 'Welcome emails are opened 4× more than regular issues. Send your best posts and set expectations from day one.', action: { label: 'Design a welcome email', href: '/app/automations/welcome' } });
      return;
    }
    const r = await one<any>(env, `SELECT SUM(CASE WHEN d.status IN ('sent','complained') THEN 1 ELSE 0 END) AS delivered, SUM(CASE WHEN d.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked, SUM(CASE WHEN d.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened
      FROM sends se JOIN deliveries d ON d.send_id = se.id WHERE se.pub_id = ? AND se.kind = 'automation' AND se.automation_id = ?`, pubId, welcome.id);
    const delivered = Number(r?.delivered) || 0;
    if (delivered < 20) return;
    const ctr = (Number(r.clicked) / delivered) * 100;
    if (ctr >= 20) return;
    out.push({ key: 'welcome', icon: '✉', priority: 55, title: `Your welcome email has a ${pctS(ctr)} click rate — add a lead magnet`, body: `${pctS((Number(r.opened) / delivered) * 100)} of new readers open it but few click. Offer a free guide, checklist or your best post as a button.`, action: { label: 'Edit the welcome email', href: `/app/automations/${welcome.id}` } });
  });

  // 8. Publishing cadence
  await safe(async () => {
    const last = await val<number | null>(env, `SELECT MAX(published_at) FROM posts WHERE pub_id = ? AND status = 'published'`, pubId);
    if (!last) return;
    const d = Math.floor((t - last) / DAY);
    if (d < 14) return;
    out.push({ key: 'cadence', icon: '✎', priority: 68, title: `It's been ${d} days since your last post`, body: 'Readers forget newsletters that go quiet, and inbox providers trust regular senders more. Even a short update helps.', action: { label: 'Write a post', href: '/app/posts/new' } });
  });

  // 9. Thank the most valuable readers
  await safe(async () => {
    const top = await val<number>(env, `SELECT COUNT(*) FROM subscriber_scores WHERE pub_id = ? AND value_percentile >= 90`, pubId);
    if (top < 5) return;
    out.push({ key: 'top', icon: '♥', priority: 30, title: `Thank your ${n(top)} most valuable readers`, body: 'Your top 10% by engagement, purchases, referrals and recency. A personal thank-you or early access keeps superfans close.', action: { label: 'See top subscribers', href: '/app/audience/top' } });
  });

  return out.sort((a, b) => b.priority - a.priority).slice(0, limit);
}
