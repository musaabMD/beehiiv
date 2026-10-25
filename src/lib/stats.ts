// Reporting helpers shared by the REST API and the MCP server.
import type { Env } from '../types';
import { one, all, val } from './db';
import { DAY, now, pct, money } from './util';

export interface PostStats {
  post_id: string;
  recipients: number;
  delivered: number;
  bounced: number;
  unique_opens: number;
  open_rate: number;
  unique_clicks: number;
  click_rate: number;
  click_to_open_rate: number;
  total_clicks: number;
  bot_clicks_filtered: number;
  unsubscribes: number;
  web_views: number;
  ab_variants: Array<{ variant: string; delivered: number; opens: number; clicks: number; open_rate: number }>;
  top_links: Array<{ url: string; clicks: number }>;
}

const rate = (a: number, b: number) => (b ? Math.round((a / b) * 10000) / 100 : 0);

export async function postStats(env: Env, pubId: string, postId: string): Promise<PostStats> {
  const d = await one<any>(
    env,
    `SELECT COUNT(*) AS recipients,
       SUM(CASE WHEN d.status IN ('sent','deferred') THEN 1 ELSE 0 END) AS delivered,
       SUM(CASE WHEN d.status IN ('bounced','complained') THEN 1 ELSE 0 END) AS bounced,
       SUM(CASE WHEN d.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opens,
       SUM(CASE WHEN d.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicks,
       SUM(d.click_count) AS total_clicks
     FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.pub_id = ? AND s.post_id = ?`,
    pubId, postId,
  );
  const bot = await val<number>(env, `SELECT COUNT(*) FROM clicks c JOIN sends s ON s.id = c.send_id WHERE s.pub_id = ? AND s.post_id = ? AND c.is_bot = 1`, pubId, postId);
  const unsub = await val<number>(
    env,
    `SELECT COUNT(DISTINCT d.subscriber_id) FROM deliveries d JOIN sends s ON s.id = d.send_id JOIN subscribers sb ON sb.id = d.subscriber_id
     WHERE s.pub_id = ? AND s.post_id = ? AND sb.status = 'unsubscribed' AND sb.unsubscribed_at >= s.created_at AND sb.unsubscribed_at < s.created_at + ?`,
    pubId, postId, 7 * DAY,
  );
  const views = await val<number>(env, `SELECT COUNT(*) FROM page_views WHERE pub_id = ? AND ref_id = ?`, pubId, postId);
  const ab = await all<any>(
    env,
    `SELECT COALESCE(d.variant,'') AS variant, COUNT(*) AS delivered, SUM(CASE WHEN d.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opens, SUM(CASE WHEN d.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicks
     FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.pub_id = ? AND s.post_id = ? AND d.variant IS NOT NULL GROUP BY d.variant ORDER BY d.variant`,
    pubId, postId,
  );
  const links = await all<any>(env, `SELECT c.url, COUNT(*) AS clicks FROM clicks c JOIN sends s ON s.id = c.send_id WHERE s.pub_id = ? AND s.post_id = ? AND c.is_bot = 0 GROUP BY c.url ORDER BY clicks DESC LIMIT 10`, pubId, postId);
  const delivered = d?.delivered || 0;
  const opens = d?.opens || 0;
  const clicks = d?.clicks || 0;
  return {
    post_id: postId,
    recipients: d?.recipients || 0,
    delivered,
    bounced: d?.bounced || 0,
    unique_opens: opens,
    open_rate: rate(opens, delivered),
    unique_clicks: clicks,
    click_rate: rate(clicks, delivered),
    click_to_open_rate: rate(clicks, opens),
    total_clicks: d?.total_clicks || 0,
    bot_clicks_filtered: bot,
    unsubscribes: unsub,
    web_views: views,
    ab_variants: ab.map((v) => ({ variant: v.variant, delivered: v.delivered, opens: v.opens, clicks: v.clicks, open_rate: rate(v.opens, v.delivered) })),
    top_links: links.map((l) => ({ url: l.url.replace(/[?&]utm_[^&]+/g, ''), clicks: l.clicks })),
  };
}

export async function providerStats(env: Env, pubId: string, postId: string) {
  const rows = await all<any>(
    env,
    `SELECT COALESCE(d.provider,'other') AS provider, COUNT(*) AS sent,
       SUM(CASE WHEN d.status IN ('sent','deferred') THEN 1 ELSE 0 END) AS delivered,
       SUM(CASE WHEN d.status = 'deferred' THEN 1 ELSE 0 END) AS deferred,
       SUM(CASE WHEN d.status = 'bounced' THEN 1 ELSE 0 END) AS bounced,
       SUM(CASE WHEN d.status = 'complained' THEN 1 ELSE 0 END) AS complaints,
       SUM(CASE WHEN d.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opens,
       SUM(CASE WHEN d.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicks
     FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.pub_id = ? AND s.post_id = ? GROUP BY d.provider ORDER BY sent DESC`,
    pubId, postId,
  );
  return rows.map((r) => ({ ...r, delivery_rate: rate(r.delivered, r.sent), open_rate: rate(r.opens, r.delivered), click_rate: rate(r.clicks, r.delivered), bounce_rate: rate(r.bounced, r.sent) }));
}

export async function summary(env: Env, pubId: string, days = 30) {
  const since = now() - days * DAY;
  const q = async (sql: string, ...p: unknown[]) => (await val<number>(env, sql, ...p)) || 0;
  const total = await q(`SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND status = 'active'`, pubId);
  const premium = await q(`SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND status = 'active' AND tier = 'premium'`, pubId);
  const added = await q(`SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND created_at >= ?`, pubId, since);
  const unsubs = await q(`SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND unsubscribed_at >= ?`, pubId, since);
  const e = await one<any>(
    env,
    `SELECT SUM(CASE WHEN d.status IN ('sent','deferred') THEN 1 ELSE 0 END) AS delivered, SUM(CASE WHEN d.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opens, SUM(CASE WHEN d.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicks
     FROM deliveries d WHERE d.pub_id = ? AND d.created_at >= ?`,
    pubId, since,
  );
  const revenue = await q(`SELECT COALESCE(SUM(amount_cents),0) FROM orders WHERE pub_id = ? AND status = 'paid' AND paid_at >= ?`, pubId, since);
  const revenueByKind = await all<any>(env, `SELECT kind, COALESCE(SUM(amount_cents),0) AS cents, COUNT(*) AS orders FROM orders WHERE pub_id = ? AND status = 'paid' AND paid_at >= ? GROUP BY kind`, pubId, since);
  const wallet = await q(`SELECT COALESCE(SUM(amount_cents),0) FROM wallet_entries WHERE pub_id = ? AND created_at >= ? AND kind IN ('ad','boost','sponsorship','clawback')`, pubId, since);
  const posts = await q(`SELECT COUNT(*) FROM posts WHERE pub_id = ? AND status = 'published' AND published_at >= ?`, pubId, since);
  const views = await q(`SELECT COUNT(*) FROM page_views WHERE pub_id = ? AND created_at >= ?`, pubId, since);
  const delivered = e?.delivered || 0;
  const data = {
    period_days: days,
    active_subscribers: total,
    premium_subscribers: premium,
    new_subscribers: added,
    unsubscribes: unsubs,
    net_growth: added - unsubs,
    emails_delivered: delivered,
    open_rate: rate(e?.opens || 0, delivered),
    click_rate: rate(e?.clicks || 0, delivered),
    revenue_cents: revenue,
    revenue_by_kind: revenueByKind,
    network_earnings_cents: wallet,
    posts_published: posts,
    web_views: views,
  };
  const sentence = `Over the last ${days} days you gained ${added} subscribers (${unsubs} unsubscribed, net ${added - unsubs >= 0 ? '+' : ''}${added - unsubs}) and now have ${total} active subscribers (${premium} premium). ` +
    `You published ${posts} posts; ${delivered} emails were delivered with a ${data.open_rate}% open rate and ${data.click_rate}% click rate. ` +
    `Revenue was ${money(revenue)}${wallet ? ` plus ${money(wallet)} from ads, boosts and sponsorships` : ''}. The website had ${views} page views.`;
  return { ...data, summary: sentence };
}

export async function growthSeries(env: Env, pubId: string, days = 30) {
  const since = now() - days * DAY;
  const added = await all<any>(env, `SELECT date(created_at/1000,'unixepoch') AS day, COUNT(*) AS n FROM subscribers WHERE pub_id = ? AND created_at >= ? GROUP BY day`, pubId, since);
  const lost = await all<any>(env, `SELECT date(unsubscribed_at/1000,'unixepoch') AS day, COUNT(*) AS n FROM subscribers WHERE pub_id = ? AND unsubscribed_at >= ? GROUP BY day`, pubId, since);
  const bySource = await all<any>(env, `SELECT source, COUNT(*) AS n FROM subscribers WHERE pub_id = ? AND created_at >= ? GROUP BY source ORDER BY n DESC`, pubId, since);
  const a = Object.fromEntries(added.map((r) => [r.day, r.n]));
  const l = Object.fromEntries(lost.map((r) => [r.day, r.n]));
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now() - i * DAY).toISOString().slice(0, 10);
    series.push({ day, new: a[day] || 0, unsubscribed: l[day] || 0 });
  }
  return { series, by_source: bySource };
}

export async function earnings(env: Env, pubId: string, days = 30) {
  const since = now() - days * DAY;
  const orders = await all<any>(env, `SELECT date(paid_at/1000,'unixepoch') AS day, kind, SUM(amount_cents) AS cents FROM orders WHERE pub_id = ? AND status = 'paid' AND paid_at >= ? GROUP BY day, kind ORDER BY day`, pubId, since);
  const wallet = await all<any>(env, `SELECT kind, status, SUM(amount_cents) AS cents FROM wallet_entries WHERE pub_id = ? AND created_at >= ? GROUP BY kind, status`, pubId, since);
  const mrr = await val<number>(env, `SELECT COALESCE(SUM(CASE WHEN interval = 'year' THEN amount_cents / 12 ELSE amount_cents END),0) FROM subscriptions WHERE pub_id = ? AND status IN ('active','trialing')`, pubId);
  const total = orders.reduce((n, r) => n + (r.cents || 0), 0);
  return { period_days: days, total_cents: total, mrr_cents: mrr || 0, by_day: orders, network: wallet, summary: `Earned ${money(total)} in the last ${days} days; monthly recurring revenue is ${money(mrr || 0)}.` };
}

export function statsSentence(title: string, s: PostStats): string {
  return `"${title}" reached ${s.delivered} inboxes: ${s.unique_opens} unique opens (${s.open_rate}%), ${s.unique_clicks} unique clicks (${s.click_rate}% CTR, ${s.click_to_open_rate}% click-to-open), ${s.unsubscribes} unsubscribes, ${s.web_views} web views. ${s.bot_clicks_filtered} bot clicks were filtered out.`;
}

export { pct };
