// Personalized product recommendations for the `recommended_products` block.
// Per subscriber at render/send time: up to N active products they haven't bought, ranked by
//   co-purchase ("readers who bought X also bought Y"), tag/interest match and popularity,
// falling back to bestsellers when there is no signal (anonymous preview, new reader, no orders yet).
// During campaign sends (opts.cache) the publication-wide data (products + co-purchase pairs) is cached per
// isolate for a minute, so each email costs one small per-subscriber query (their own purchases), not a full
// scan. Previews and the API always read fresh data.
import type { Env } from '../types';
import { all } from './db';
import { parseJSON, stripTags } from './util';

export interface RecProduct {
  id: string; name: string; slug: string; description: string; price_cents: number; currency: string; cover_url: string | null;
  tags: string[]; sales: number;
}
export interface Recommendation extends RecProduct { score: number; reason: 'also_bought' | 'interest' | 'popular'; because?: string }

interface PubData { at: number; products: RecProduct[]; pairs: Map<string, Map<string, number>>; maxSales: number }
const cache = new Map<string, PubData>();
const TTL = 60_000;

async function pubData(env: Env, pubId: string, useCache: boolean): Promise<PubData> {
  const hit = cache.get(pubId);
  if (useCache && hit && Date.now() - hit.at < TTL) return hit;
  const rows = await all<any>(env, `SELECT p.id, p.name, p.slug, p.description, p.price_cents, p.currency, p.cover_url, p.tags,
      (SELECT COUNT(*) FROM orders o WHERE o.pub_id = p.pub_id AND o.kind = 'product' AND o.ref_id = p.id AND o.status = 'paid') AS paid
    FROM products p WHERE p.pub_id = ? AND p.status = 'active' ORDER BY p.created_at DESC LIMIT 200`, pubId);
  const products: RecProduct[] = rows.map((r) => ({
    id: r.id, name: r.name, slug: r.slug, description: stripTags(r.description || '').slice(0, 160), price_cents: r.price_cents || 0, currency: r.currency || 'usd', cover_url: r.cover_url || null,
    tags: (parseJSON<any[]>(r.tags, []) || []).map((t) => String(t).toLowerCase().trim()).filter(Boolean), sales: Number(r.paid) || 0,
  }));
  // co-purchase pairs: buyers (by email) who bought both A and B
  const pairRows = await all<{ a: string; b: string; n: number }>(env, `SELECT o1.ref_id AS a, o2.ref_id AS b, COUNT(DISTINCT o1.email) AS n
    FROM orders o1 JOIN orders o2 ON o2.pub_id = o1.pub_id AND o2.email = o1.email AND o2.ref_id != o1.ref_id AND o2.kind = 'product' AND o2.status = 'paid'
    WHERE o1.pub_id = ? AND o1.kind = 'product' AND o1.status = 'paid' GROUP BY o1.ref_id, o2.ref_id LIMIT 5000`, pubId);
  const pairs = new Map<string, Map<string, number>>();
  for (const p of pairRows) {
    if (!pairs.has(p.a)) pairs.set(p.a, new Map());
    pairs.get(p.a)!.set(p.b, Number(p.n) || 0);
  }
  const data: PubData = { at: Date.now(), products, pairs, maxSales: Math.max(0, ...products.map((p) => p.sales)) };
  cache.set(pubId, data);
  return data;
}

/** Forget cached data (tests / after product edits). */
export function clearRecommendCache(pubId?: string) { if (pubId) cache.delete(pubId); else cache.clear(); }

/**
 * Rank products for one reader. `subscriber` may be null (preview / anonymous web visitor) → bestsellers.
 * `tags` are the subscriber's tags (interests); product tags and names are matched against them.
 */
export async function recommendProducts(env: Env, pubId: string, subscriber: { id: string; email: string } | null | undefined, opts: { limit?: number; tags?: string[]; exclude?: string[]; cache?: boolean } = {}): Promise<Recommendation[]> {
  const limit = Math.max(1, Math.min(6, Number(opts.limit) || 3));
  const data = await pubData(env, pubId, !!opts.cache);
  if (!data.products.length) return [];
  let bought = new Set<string>();
  if (subscriber && subscriber.id !== 'preview') {
    const rows = await all<{ ref_id: string }>(env, `SELECT DISTINCT ref_id FROM orders WHERE pub_id = ? AND kind = 'product' AND status = 'paid' AND (subscriber_id = ? OR email = ?)`, pubId, subscriber.id, subscriber.email);
    bought = new Set(rows.map((r) => r.ref_id));
  }
  const exclude = new Set([...(opts.exclude || []), ...bought]);
  const interests = (opts.tags || []).map((t) => String(t).toLowerCase().trim()).filter(Boolean);
  const byId = new Map(data.products.map((p) => [p.id, p]));
  const out: Recommendation[] = [];
  for (const p of data.products) {
    if (exclude.has(p.id)) continue;
    // co-purchase: sum of co-buyers across everything this reader bought (strongest signal)
    let co = 0, because = '';
    for (const b of bought) {
      const n = data.pairs.get(b)?.get(p.id) || 0;
      if (n > co) because = byId.get(b)?.name || because;
      co += n;
    }
    // interest match: exact tag overlap counts double a keyword hit in the name/description
    let interest = 0;
    const hay = `${p.name} ${p.description}`.toLowerCase();
    for (const t of interests) { if (p.tags.includes(t)) interest += 2; else if (t.length > 2 && hay.includes(t)) interest += 1; }
    const popularity = data.maxSales ? Math.log1p(p.sales) / Math.log1p(data.maxSales) : 0;
    const score = co * 3 + interest * 2 + popularity;
    const reason: Recommendation['reason'] = co > 0 ? 'also_bought' : interest > 0 ? 'interest' : 'popular';
    out.push({ ...p, score, reason, because: co > 0 ? because : undefined });
  }
  // ties (no signal at all) fall back to bestsellers, then newest (products are already newest-first)
  out.sort((a, b) => b.score - a.score || b.sales - a.sales);
  return out.slice(0, limit);
}

export function formatPrice(cents: number, currency = 'usd'): string {
  if (!cents) return 'Free';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100); } catch { return `$${(cents / 100).toFixed(2)}`; }
}
