// Campaigns: a named group of newsletter posts, social posts, events, automations and landing pages with a date
// range and a goal. Attribution uses the existing UTM tracking: utm_campaign = campaign slug is added to the links
// in campaign posts (and social links), so web visits (page_views.utm_campaign), signups (subscribers.utm_campaign)
// and their purchases (orders) roll up into one report.
import type { Env, Publication } from '../types';
import { one, all, run, val } from './db';
import { now, parseJSON, MIN } from './util';
import { registerPeriodic } from './jobs';
import { tagLink } from './social';
import { getPub, siteUrl } from './pub';

export const ITEM_KINDS: Record<string, string> = { post: 'Newsletter posts', social: 'Social posts', event: 'Events & webinars', automation: 'Automations', page: 'Landing pages' };

export interface Campaign { id: string; pub_id: string; name: string; slug: string; goal: string; goal_kind: string; goal_target: number; starts_at: number | null; ends_at: number | null; status: string; created_at: number }

/** Add utm_source/utm_medium/utm_campaign to one http(s) link unless it already names a campaign. */
export function campaignLink(url: string, pubSlug: string, campaign: string, medium = 'newsletter'): string {
  if (!/^https?:\/\//i.test(url) || url.includes('{{')) return url;
  try {
    const u = new URL(url.replace(/&amp;/g, '&'));
    if (u.searchParams.has('utm_campaign')) return url;
    if (!u.searchParams.has('utm_source')) u.searchParams.set('utm_source', pubSlug);
    if (!u.searchParams.has('utm_medium')) u.searchParams.set('utm_medium', medium);
    u.searchParams.set('utm_campaign', campaign);
    return u.toString();
  } catch {
    return url;
  }
}

/** Rewrite every link in an editor document (inline HTML hrefs, button/image links). Returns null when unchanged. */
export function tagDocLinks(json: string | null, pubSlug: string, campaign: string): string | null {
  const doc = parseJSON<any>(json, null);
  if (!doc || !Array.isArray(doc.blocks)) return null;
  let changed = false;
  const fixHtml = (h: string) => h.replace(/href="([^"]+)"/g, (m, url: string) => {
    const n = campaignLink(url, pubSlug, campaign);
    if (n === url) return m;
    changed = true;
    return `href="${n.replace(/&/g, '&amp;').replace(/"/g, '%22')}"`;
  });
  const fixUrl = (u: unknown) => {
    if (typeof u !== 'string') return u;
    const n = campaignLink(u, pubSlug, campaign);
    if (n !== u) changed = true;
    return n;
  };
  const walk = (blocks: any[]) => {
    for (const b of blocks || []) {
      const d = b?.data;
      if (!d || typeof d !== 'object') continue;
      for (const k of ['html', 'caption', 'cite']) if (typeof d[k] === 'string') d[k] = fixHtml(d[k]);
      if (Array.isArray(d.items)) d.items = d.items.map((i: any) => (typeof i === 'string' ? fixHtml(i) : i && typeof i.html === 'string' ? { ...i, html: fixHtml(i.html) } : i));
      if (Array.isArray(d.rows)) d.rows = d.rows.map((r: any) => (Array.isArray(r) ? r.map((cell: any) => (typeof cell === 'string' ? fixHtml(cell) : cell)) : r));
      if (b.type === 'button' || b.type === 'ad') d.url = fixUrl(d.url);
      if (b.type === 'image') d.link = fixUrl(d.link);
      if (Array.isArray(d.blocks)) walk(d.blocks);
      if (Array.isArray(d.columns)) d.columns.forEach((c: any) => walk(c?.blocks));
    }
  };
  walk(doc.blocks);
  return changed ? JSON.stringify(doc) : null;
}

/** Tag the links of a not-yet-sent post with the campaign slug. Sent/published posts are left alone. */
export async function applyCampaignToPost(env: Env, pub: Publication, slug: string, postId: string): Promise<boolean> {
  const p = await one<{ id: string; content: string; email_content: string | null; status: string }>(env, `SELECT id, content, email_content, status FROM posts WHERE id = ? AND pub_id = ?`, postId, pub.id);
  if (!p || !['draft', 'scheduled'].includes(p.status)) return false;
  const content = tagDocLinks(p.content, pub.slug, slug);
  const email = p.email_content ? tagDocLinks(p.email_content, pub.slug, slug) : null;
  if (!content && !email) return false;
  // Conditional on the content we read, so a concurrent editor save is never overwritten.
  const r = await run(env, `UPDATE posts SET content = ?, email_content = ? WHERE id = ? AND content = ? AND COALESCE(email_content, '') = ?`, content || p.content, email || p.email_content, p.id, p.content, p.email_content || '');
  return !!r.meta.changes;
}

export async function addCampaignItem(env: Env, pub: Publication, camp: Campaign, kind: string, refId: string): Promise<string | null> {
  if (!ITEM_KINDS[kind]) return 'Unknown item type';
  const table = { post: 'posts', social: 'social_posts', event: 'live_events', automation: 'automations', page: 'pages' }[kind]!;
  const exists = await one(env, `SELECT 1 FROM ${table} WHERE id = ? AND pub_id = ?`, refId, pub.id);
  if (!exists) return 'Item not found';
  await run(env, 'INSERT OR IGNORE INTO campaign_items (campaign_id, pub_id, kind, ref_id, created_at) VALUES (?, ?, ?, ?, ?)', camp.id, pub.id, kind, refId, now());
  if (kind === 'post') await applyCampaignToPost(env, pub, camp.slug, refId);
  if (kind === 'social') {
    const sp = await one<{ link_url: string | null; network: string; status: string }>(env, 'SELECT link_url, network, status FROM social_posts WHERE id = ?', refId);
    await run(env, 'UPDATE social_posts SET campaign_id = ? WHERE id = ? AND pub_id = ?', camp.id, refId, pub.id);
    if (sp?.link_url && sp.status === 'scheduled') {
      const u = new URL(sp.link_url);
      if (!u.searchParams.get('utm_campaign')) await run(env, 'UPDATE social_posts SET link_url = ? WHERE id = ?', tagLink(sp.link_url, sp.network, camp.slug), refId);
    }
  }
  return null;
}

export async function removeCampaignItem(env: Env, pubId: string, campId: string, kind: string, refId: string) {
  await run(env, 'DELETE FROM campaign_items WHERE campaign_id = ? AND pub_id = ? AND kind = ? AND ref_id = ?', campId, pubId, kind, refId);
  if (kind === 'social') await run(env, 'UPDATE social_posts SET campaign_id = NULL WHERE id = ? AND pub_id = ? AND campaign_id = ?', refId, pubId, campId);
}

/** Shareable links for events and landing pages, tagged for the campaign. */
export function trackedSiteLink(env: Env, pub: Publication, path: string, campaign: string, source = 'share', medium = 'campaign'): string {
  const u = new URL(siteUrl(env, pub) + path);
  u.searchParams.set('utm_source', source);
  u.searchParams.set('utm_medium', medium);
  u.searchParams.set('utm_campaign', campaign);
  return u.toString();
}

export interface CampaignReport {
  sends: number; delivered: number; opens: number; clicks: number; openRate: number; clickRate: number;
  automationEmails: number; socialPosted: number; socialScheduled: number; visits: number; signups: number;
  registrations: number; revenueCents: number; orders: number; bySource: Array<{ source: string; signups: number }>;
  posts: Array<{ id: string; title: string; status: string; delivered: number; opens: number; clicks: number }>;
  goalValue: number;
}

/** Combined report. Email numbers come from campaign posts (+ automation emails within the date range). */
export async function campaignReport(env: Env, pub: Publication, camp: Campaign): Promise<CampaignReport> {
  const items = await all<{ kind: string; ref_id: string }>(env, 'SELECT kind, ref_id FROM campaign_items WHERE campaign_id = ? AND pub_id = ?', camp.id, pub.id);
  const ids = (k: string) => items.filter((i) => i.kind === k).map((i) => i.ref_id);
  const inList = (n: number) => Array(n).fill('?').join(',') || "''";
  const postIds = ids('post'), autoIds = ids('automation'), eventIds = ids('event'), socialIds = ids('social');
  const from = camp.starts_at || 0, to = camp.ends_at || 8.64e15;

  const posts = postIds.length ? await all<any>(env, `SELECT p.id, p.title, p.status,
      (SELECT COUNT(*) FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = p.id AND s.kind = 'post' AND d.status = 'sent') AS delivered,
      (SELECT COUNT(*) FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = p.id AND s.kind = 'post' AND d.opened_at IS NOT NULL) AS opens,
      (SELECT COUNT(*) FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = p.id AND s.kind = 'post' AND d.clicked_at IS NOT NULL) AS clicks
      FROM posts p WHERE p.pub_id = ? AND p.id IN (${inList(postIds.length)})`, pub.id, ...postIds) : [];
  const sends = postIds.length ? await val<number>(env, `SELECT COUNT(*) FROM sends WHERE pub_id = ? AND kind = 'post' AND post_id IN (${inList(postIds.length)})`, pub.id, ...postIds) : 0;
  const auto = autoIds.length ? await one<any>(env, `SELECT COUNT(*) AS n, SUM(CASE WHEN d.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS o, SUM(CASE WHEN d.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS k FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.pub_id = ? AND s.kind = 'automation' AND d.status = 'sent' AND s.automation_id IN (${inList(autoIds.length)}) AND s.created_at BETWEEN ? AND ?`, pub.id, ...autoIds, from, to) : null;
  const delivered = posts.reduce((a, p) => a + p.delivered, 0) + (auto?.n || 0);
  const opens = posts.reduce((a, p) => a + p.opens, 0) + (auto?.o || 0);
  const clicks = posts.reduce((a, p) => a + p.clicks, 0) + (auto?.k || 0);
  const social = socialIds.length ? await one<any>(env, `SELECT SUM(CASE WHEN status = 'posted' THEN 1 ELSE 0 END) AS posted, SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) AS sched FROM social_posts WHERE pub_id = ? AND id IN (${inList(socialIds.length)})`, pub.id, ...socialIds) : null;
  const pageIds = ids('page');
  const visits = await val<number>(env, `SELECT COUNT(*) FROM page_views WHERE pub_id = ? AND (utm_campaign = ? ${pageIds.length ? `OR (ref_id IN (${inList(pageIds.length)}) AND created_at BETWEEN ? AND ?)` : ''})`, pub.id, camp.slug, ...(pageIds.length ? [...pageIds, from, to] : []));
  const signups = await val<number>(env, `SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND utm_campaign = ?`, pub.id, camp.slug);
  const bySource = await all<{ source: string; signups: number }>(env, `SELECT COALESCE(utm_source, source, 'direct') AS source, COUNT(*) AS signups FROM subscribers WHERE pub_id = ? AND utm_campaign = ? GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, pub.id, camp.slug);
  const registrations = eventIds.length ? await val<number>(env, `SELECT COUNT(*) FROM event_registrations WHERE pub_id = ? AND event_id IN (${inList(eventIds.length)})`, pub.id, ...eventIds) : 0;
  // Revenue: paid orders by subscribers who signed up through the campaign, plus tickets for campaign events.
  const rev = await one<any>(env, `SELECT COUNT(*) AS n, COALESCE(SUM(o.amount_cents), 0) AS cents FROM orders o WHERE o.pub_id = ? AND o.status = 'paid' AND (
      o.subscriber_id IN (SELECT id FROM subscribers WHERE pub_id = ? AND utm_campaign = ?)
      OR lower(o.email) IN (SELECT email FROM subscribers WHERE pub_id = ? AND utm_campaign = ?)
      ${eventIds.length ? `OR (o.kind = 'ticket' AND o.ref_id IN (${inList(eventIds.length)}))` : ''})`, pub.id, pub.id, camp.slug, pub.id, camp.slug, ...eventIds);
  const r: CampaignReport = {
    sends, delivered, opens, clicks, openRate: delivered ? opens / delivered : 0, clickRate: delivered ? clicks / delivered : 0,
    automationEmails: auto?.n || 0, socialPosted: social?.posted || 0, socialScheduled: social?.sched || 0, visits, signups, registrations,
    revenueCents: rev?.cents || 0, orders: rev?.n || 0, bySource, posts, goalValue: 0,
  };
  r.goalValue = camp.goal_kind === 'revenue' ? Math.round(r.revenueCents / 100) : camp.goal_kind === 'clicks' ? r.clicks : camp.goal_kind === 'registrations' ? r.registrations : r.signups;
  return r;
}

// Posts added to a campaign and edited afterwards get their new links tagged before they go out.
registerPeriodic('campaigns.utm', 5 * MIN, async (env) => {
  const rows = await all<{ pub_id: string; slug: string; ref_id: string }>(env, `SELECT c.pub_id, c.slug, i.ref_id FROM campaign_items i JOIN campaigns c ON c.id = i.campaign_id JOIN posts p ON p.id = i.ref_id WHERE i.kind = 'post' AND c.status = 'active' AND p.status IN ('draft','scheduled') AND p.updated_at > ? LIMIT 200`, now() - 7 * 86_400_000);
  for (const r of rows) {
    const pub = await getPub(env, r.pub_id);
    if (pub) await applyCampaignToPost(env, pub, r.slug, r.ref_id).catch(() => false);
  }
});
