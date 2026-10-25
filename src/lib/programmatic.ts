// Programmatic ads: always-on, auto-filled ad slots. At render/send time each `ad_auto` slot picks the best eligible
// approved network campaign by expected earnings (eCPM), respecting budgets, floors, blocked categories/advertisers,
// publication targeting and per-subscriber frequency caps. Each rendered ad records an impression; CPM is billed from
// email impressions, CPC from bot-filtered clicks via /t/ad/:opportunity — both credited to the wallet.
import type { Env, Publication, Post, Subscriber } from '../types';
import { all, one, run, val } from './db';
import { registerPeriodic } from './jobs';
import { settings } from './pub';
import { id, now, sha256, parseJSON, DAY, MIN } from './util';

export interface ProgSettings {
  enabled: boolean;
  floor_cpm_cents: number;      // minimum CPM accepted for CPM campaigns
  floor_cpc_cents: number;      // minimum per-click rate for CPC campaigns
  blocked_categories: string[];
  blocked_advertisers: string[];
  max_ads: number;              // max auto-filled ads per email / page
  placement: 'top' | 'middle' | 'bottom' | 'manual';
  freq_cap: number;             // max times one subscriber sees the same campaign…
  freq_days: number;            // …within this many days
  hide_for_premium: boolean;
  label: string;
}

export const PROG_DEFAULTS: ProgSettings = {
  enabled: false, floor_cpm_cents: 0, floor_cpc_cents: 0, blocked_categories: [], blocked_advertisers: [], max_ads: 1,
  placement: 'middle', freq_cap: 3, freq_days: 30, hide_for_premium: true, label: 'Sponsored',
};

export function progSettings(pub: Publication): ProgSettings {
  const raw = (settings(pub) as any).programmatic || {};
  return { ...PROG_DEFAULTS, ...raw };
}

interface Candidate { id: string; advertiser_id: string; pricing: string; rate_cents: number; categories: string; target_categories: string; ecpm: number }

/** Eligible campaigns for a publication, best expected earnings first. */
export async function candidates(env: Env, pub: Publication, cfg: ProgSettings, subscriberId?: string | null, exclude: string[] = []): Promise<Candidate[]> {
  const t = now();
  const rows = await all<any>(
    env,
    `SELECT c.id, c.advertiser_id, c.pricing, c.rate_cents, c.categories, c.target_categories,
            COALESCE((SELECT SUM(o.clicks) FROM ad_opportunities o WHERE o.campaign_id = c.id), 0) AS clicks,
            COALESCE((SELECT SUM(o.impressions) FROM ad_opportunities o WHERE o.campaign_id = c.id), 0) AS imps
     FROM ad_campaigns c
     WHERE c.owner_pub_id IS NULL AND c.programmatic = 1 AND c.review_status = 'approved' AND c.status = 'active'
       AND c.pricing IN ('cpm','cpc')
       AND (c.starts_at IS NULL OR c.starts_at <= ?) AND (c.ends_at IS NULL OR c.ends_at > ?)
       AND (c.budget_cents = 0 OR c.spent_cents < c.budget_cents)`,
    t, t,
  );
  let capped = new Set<string>();
  if (subscriberId && cfg.freq_cap > 0) {
    const seen = await all<{ campaign_id: string; n: number }>(env, `SELECT campaign_id, COUNT(*) AS n FROM ad_impressions WHERE subscriber_id = ? AND created_at > ? GROUP BY campaign_id`, subscriberId, t - Math.max(1, cfg.freq_days) * DAY);
    capped = new Set(seen.filter((s) => s.n >= cfg.freq_cap).map((s) => s.campaign_id));
  }
  const blockedCats = new Set(cfg.blocked_categories.map((x) => x.toLowerCase()));
  const blockedAdv = new Set(cfg.blocked_advertisers);
  const out: Candidate[] = [];
  for (const r of rows) {
    if (exclude.includes(r.id) || capped.has(r.id) || blockedAdv.has(r.advertiser_id)) continue;
    const cats = parseJSON<string[]>(r.categories, []).map((x) => x.toLowerCase());
    if (cats.some((x) => blockedCats.has(x))) continue;
    const targets = parseJSON<string[]>(r.target_categories, []).map((x) => x.toLowerCase());
    if (targets.length && !targets.includes(String(pub.category || '').toLowerCase())) continue;
    if (r.pricing === 'cpm' && r.rate_cents < cfg.floor_cpm_cents) continue;
    if (r.pricing === 'cpc' && r.rate_cents < cfg.floor_cpc_cents) continue;
    // expected CTR with a 0.5% prior so new campaigns get a fair chance
    const ctr = (Number(r.clicks) + 1) / (Number(r.imps) + 200);
    const ecpm = r.pricing === 'cpm' ? r.rate_cents : r.rate_cents * ctr * 1000;
    out.push({ ...r, ecpm });
  }
  return out.sort((a, b) => b.ecpm - a.ecpm);
}

/** Find or create the programmatic opportunity for (campaign, publication, post). Deterministic id → idempotent. */
async function opportunityFor(env: Env, campaignId: string, pubId: string, postId: string | null): Promise<string> {
  const oid = 'pg' + (await sha256(`${campaignId}:${pubId}:${postId || ''}`)).slice(0, 18);
  await run(env, `INSERT OR IGNORE INTO ad_opportunities (id, campaign_id, pub_id, post_id, status, programmatic, decided_at, created_at) VALUES (?, ?, ?, ?, 'placed', 1, ?, ?)`, oid, campaignId, pubId, postId, now(), now());
  return oid;
}

export interface SlotCtx {
  env: Env; pub: Publication; post?: Post | null; subscriber?: Subscriber | null; deliveryId?: string | null;
  mode: 'email' | 'web'; preview?: boolean; access?: boolean;
}

/**
 * Fill one programmatic slot. Returns the opportunity to render (real sends / web views — impression recorded),
 * or just a campaign id for previews and test sends (nothing recorded). null = no eligible ad.
 */
export async function fillSlot(c: SlotCtx, alreadyShown: string[]): Promise<{ opportunityId?: string; campaignId: string } | null> {
  const cfg = progSettings(c.pub);
  if (!cfg.enabled) return null;
  if (alreadyShown.length >= Math.max(1, cfg.max_ads)) return null;
  const premium = c.subscriber ? c.subscriber.tier === 'premium' : !!c.access && c.mode === 'web';
  if (cfg.hide_for_premium && premium && !c.preview) return null;
  const realSub = c.subscriber && c.subscriber.id !== 'preview' ? c.subscriber.id : null;
  const list = await candidates(c.env, c.pub, cfg, realSub, alreadyShown);
  const best = list[0];
  if (!best) return null;
  const record = !c.preview && (c.mode === 'web' || !!c.deliveryId);
  if (!record) return { campaignId: best.id };
  const oid = await opportunityFor(c.env, best.id, c.pub.id, c.post?.id ?? null);
  await run(
    c.env,
    `INSERT OR IGNORE INTO ad_impressions (id, opportunity_id, campaign_id, pub_id, post_id, subscriber_id, delivery_id, channel, billed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id(), oid, best.id, c.pub.id, c.post?.id ?? null, realSub, c.deliveryId ?? null, c.mode,
    c.mode === 'web' ? 1 : 0, // web views are reported, not billed (no bot signal at render time); CPC still pays for web clicks
    now(),
  );
  return { opportunityId: oid, campaignId: best.id };
}

function hasAdBlock(blocks: any[]): boolean {
  return JSON.stringify(blocks).includes('"type":"ad');
}

/** Auto-insert a programmatic slot at the configured placement when a post has no ad blocks of its own. */
export function autoInsert<T extends { blocks: any[] }>(doc: T, pub: Publication, post: Post | null | undefined, mode: 'email' | 'web'): T {
  if (mode !== 'email' || !post) return doc;
  const cfg = progSettings(pub);
  if (!cfg.enabled || cfg.placement === 'manual' || hasAdBlock(doc.blocks || [])) return doc;
  const blocks = [...(doc.blocks || [])];
  const paywall = blocks.findIndex((b) => b?.type === 'paywall');
  const end = paywall === -1 ? blocks.length : paywall; // keep ads in the part every reader sees
  const at = cfg.placement === 'top' ? 0 : cfg.placement === 'bottom' ? end : Math.min(end, Math.max(1, Math.floor(end / 2)));
  blocks.splice(at, 0, { id: 'auto_ad', type: 'ad_auto', data: { label: cfg.label } });
  return { ...doc, blocks };
}

/** Bill CPM for email impressions (exact cents, no rounding drift) and keep opportunity counters fresh. */
export async function settleProgrammatic(env: Env): Promise<number> {
  const { creditAd } = await import('./billing');
  const opps = await all<any>(env, `SELECT o.id, o.earned_cents, c.pricing, c.rate_cents, c.name AS cname FROM ad_opportunities o JOIN ad_campaigns c ON c.id = o.campaign_id WHERE o.programmatic = 1 AND EXISTS (SELECT 1 FROM ad_impressions i WHERE i.opportunity_id = o.id AND i.billed = 0) LIMIT 200`);
  let credited = 0;
  for (const o of opps) {
    const fresh = await val<number>(env, `SELECT COUNT(*) FROM ad_impressions WHERE opportunity_id = ? AND billed = 0`, o.id);
    await run(env, `UPDATE ad_impressions SET billed = 1 WHERE opportunity_id = ? AND billed = 0`, o.id);
    const emailImps = await val<number>(env, `SELECT COUNT(*) FROM ad_impressions WHERE opportunity_id = ? AND channel = 'email'`, o.id);
    const allImps = await val<number>(env, `SELECT COUNT(*) FROM ad_impressions WHERE opportunity_id = ?`, o.id);
    await run(env, `UPDATE ad_opportunities SET impressions = ? WHERE id = ?`, allImps, o.id);
    if (o.pricing === 'cpm' && fresh) {
      const cpmEarned = await val<number>(env, `SELECT COALESCE(SUM(amount_cents), 0) FROM wallet_entries WHERE ref_id = ? AND kind = 'ad' AND note LIKE '%(CPM)%'`, o.id);
      const owed = Math.floor((emailImps * o.rate_cents) / 1000) - cpmEarned;
      if (owed > 0) credited += await creditAd(env, o.id, owed, `${o.cname}: programmatic impressions (CPM)`);
    }
  }
  return credited;
}

registerPeriodic('ads.programmatic_settle', 15 * MIN, async (env) => { await settleProgrammatic(env); });

/** Report rows for the Programmatic tab. */
export async function programmaticReport(env: Env, pubId: string, since: number) {
  const totals = await one<any>(env, `SELECT COUNT(*) AS imps, SUM(CASE WHEN channel = 'email' THEN 1 ELSE 0 END) AS email_imps, SUM(CASE WHEN channel = 'web' THEN 1 ELSE 0 END) AS web_imps FROM ad_impressions WHERE pub_id = ? AND created_at > ?`, pubId, since);
  const money = await one<any>(env, `SELECT COALESCE(SUM(o.clicks), 0) AS clicks, COALESCE(SUM(o.bot_clicks), 0) AS bots, COALESCE(SUM(o.earned_cents), 0) AS earned FROM ad_opportunities o WHERE o.pub_id = ? AND o.programmatic = 1 AND o.created_at > ?`, pubId, since);
  const byPost = await all<any>(env, `SELECT o.post_id, p.title, COUNT(DISTINCT o.campaign_id) AS campaigns, SUM((SELECT COUNT(*) FROM ad_impressions i WHERE i.opportunity_id = o.id)) AS imps, SUM((SELECT COUNT(*) FROM ad_impressions i WHERE i.opportunity_id = o.id AND i.channel = 'email')) AS email_imps, SUM(o.clicks) AS clicks, SUM(o.bot_clicks) AS bots, SUM(o.earned_cents) AS earned FROM ad_opportunities o LEFT JOIN posts p ON p.id = o.post_id WHERE o.pub_id = ? AND o.programmatic = 1 AND o.created_at > ? GROUP BY o.post_id ORDER BY MAX(o.created_at) DESC LIMIT 100`, pubId, since);
  const byCampaign = await all<any>(env, `SELECT c.id, c.name, a.name AS advertiser, c.pricing, c.rate_cents, SUM((SELECT COUNT(*) FROM ad_impressions i WHERE i.opportunity_id = o.id)) AS imps, SUM(o.clicks) AS clicks, SUM(o.bot_clicks) AS bots, SUM(o.earned_cents) AS earned FROM ad_opportunities o JOIN ad_campaigns c ON c.id = o.campaign_id JOIN advertisers a ON a.id = c.advertiser_id WHERE o.pub_id = ? AND o.programmatic = 1 AND o.created_at > ? GROUP BY c.id ORDER BY earned DESC LIMIT 100`, pubId, since);
  return { imps: totals?.imps || 0, emailImps: totals?.email_imps || 0, webImps: totals?.web_imps || 0, clicks: money?.clicks || 0, bots: money?.bots || 0, earned: money?.earned || 0, byPost, byCampaign };
}
