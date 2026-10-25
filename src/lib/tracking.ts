// Engagement + website analytics recording.
import type { Ctx, Env } from '../types';
import { one, run, insert } from './db';
import { emit } from './events';
import { isBotClick, classifyCrawler, clientIP } from './guard';
import { recomputeEngagement } from './subscribers';
import { id, now, parseUA, sha256 } from './util';

export async function recordOpen(env: Env, deliveryId: string, req: Request) {
  const d = await one<any>(env, 'SELECT d.*, s.post_id, s.automation_id FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE d.id = ?', deliveryId);
  if (!d) return;
  const ua = req.headers.get('user-agent') || '';
  const bot = isBotClick(ua) && !/GoogleImageProxy|YahooMailProxy/i.test(ua);
  const { device } = parseUA(ua);
  await insert(env, 'opens', { id: id(), delivery_id: d.id, send_id: d.send_id, pub_id: d.pub_id, is_bot: bot ? 1 : 0, ua: ua.slice(0, 300), country: (req as any).cf?.country ?? null, device, created_at: now() });
  if (bot) return;
  const first = !d.opened_at;
  await run(env, 'UPDATE deliveries SET opened_at = COALESCE(opened_at, ?), open_count = open_count + 1 WHERE id = ?', now(), d.id);
  if (first && d.subscriber_id) {
    await run(env, 'UPDATE subscribers SET open_count = open_count + 1, last_open_at = ? WHERE id = ?', now(), d.subscriber_id);
    await emit(env, { pubId: d.pub_id, type: 'email.opened', subscriberId: d.subscriber_id, refId: d.post_id || d.automation_id, data: { post_id: d.post_id, automation_id: d.automation_id, send_id: d.send_id } });
    await recomputeEngagement(env, d.subscriber_id);
  }
}

export async function recordClick(env: Env, deliveryId: string, url: string, req: Request): Promise<void> {
  const d = await one<any>(env, 'SELECT d.*, s.post_id, s.automation_id FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE d.id = ?', deliveryId);
  if (!d) return;
  const ua = req.headers.get('user-agent') || '';
  const bot = isBotClick(ua, d.sent_at ? now() - d.sent_at : undefined);
  await insert(env, 'clicks', { id: id(), delivery_id: d.id, send_id: d.send_id, pub_id: d.pub_id, url: url.slice(0, 2000), is_bot: bot ? 1 : 0, ua: ua.slice(0, 300), country: (req as any).cf?.country ?? null, created_at: now() });
  if (bot) return;
  const first = !d.clicked_at;
  // a click implies an open (images may be blocked)
  await run(env, 'UPDATE deliveries SET clicked_at = COALESCE(clicked_at, ?), click_count = click_count + 1, opened_at = COALESCE(opened_at, ?) WHERE id = ?', now(), now(), d.id);
  if (d.subscriber_id) {
    await run(env, `UPDATE subscribers SET click_count = click_count + ?, last_click_at = ?, last_open_at = COALESCE(last_open_at, ?) WHERE id = ?`, first ? 1 : 0, now(), now(), d.subscriber_id);
    await emit(env, { pubId: d.pub_id, type: 'email.clicked', subscriberId: d.subscriber_id, refId: d.post_id || d.automation_id, data: { post_id: d.post_id, automation_id: d.automation_id, url } });
    if (first) await recomputeEngagement(env, d.subscriber_id);
  }
}

const SOCIAL = /facebook|instagram|t\.co|twitter|x\.com|linkedin|tiktok|reddit|threads|bsky|youtube|pinterest|mastodon/i;
const SEARCH = /google\.|bing\.|duckduckgo|yahoo\.|yandex|baidu|ecosia|brave\.com\/search/i;
const AI = /chatgpt|openai|perplexity|claude\.ai|gemini\.google|copilot|you\.com/i;
const EMAIL = /mail\.|outlook|gmail|newsletter/i;

export function channelOf(referrer: string | null, utmMedium?: string | null, ownHost?: string): string {
  if (utmMedium) {
    if (/email|newsletter/i.test(utmMedium)) return 'email';
    if (/social/i.test(utmMedium)) return 'social';
    if (/cpc|paid|ads?/i.test(utmMedium)) return 'paid';
  }
  if (!referrer) return 'direct';
  let host = '';
  try { host = new URL(referrer).hostname; } catch { return 'direct'; }
  if (ownHost && host === ownHost) return 'internal';
  if (AI.test(host)) return 'ai';
  if (SEARCH.test(host)) return 'search';
  if (SOCIAL.test(host)) return 'social';
  if (EMAIL.test(host)) return 'email';
  return 'referral';
}

/** Record a page view for website analytics. Call from site GET handlers (skips bots — those go to bot_hits). */
export async function trackView(c: Ctx, refId?: string | null) {
  const pub = c.get('pub');
  const req = c.req.raw;
  const ua = req.headers.get('user-agent');
  if (classifyCrawler(ua)) return;
  const url = new URL(req.url);
  const ref = req.headers.get('referer');
  const { device, os, browser } = parseUA(ua);
  const visitor = (await sha256(`${clientIP(req)}|${ua}|${new Date().toISOString().slice(0, 10)}|${pub.id}`)).slice(0, 20);
  const reader = c.get('reader');
  const utmMedium = url.searchParams.get('utm_medium');
  const task = insert(c.env, 'page_views', {
    id: id(), pub_id: pub.id, path: url.pathname.slice(0, 300), ref_id: refId ?? null, referrer: ref?.slice(0, 500) ?? null,
    channel: channelOf(ref, utmMedium, url.hostname), utm_source: url.searchParams.get('utm_source'), utm_medium: utmMedium, utm_campaign: url.searchParams.get('utm_campaign'),
    country: (req as any).cf?.country ?? null, device, os, browser, visitor_id: visitor, subscriber_id: reader?.subscriber?.id ?? null, created_at: now(),
  });
  try { c.executionCtx.waitUntil(task); } catch { await task; }
}

export async function logBot(env: Env, pubId: string, bot: string, category: string, path: string, action: 'served' | 'blocked') {
  await insert(env, 'bot_hits', { id: id(), pub_id: pubId, bot, category, path: path.slice(0, 300), action, created_at: now() });
}
