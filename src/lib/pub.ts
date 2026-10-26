import type { Env, Publication } from '../types';
import { one } from './db';
import { parseJSON } from './util';
import { applySharedSender } from './sharedsender';

export interface PubSettings {
  double_opt_in?: boolean;
  welcome_email?: boolean;
  redirect_after_signup?: string;      // url
  paywall_meter?: number;              // free premium posts per 30 days (metered paywall), 0 = off
  robots_txt?: string;
  blocked_crawlers?: string[];         // bot names to block (AI crawlers etc.)
  block_ai_crawlers?: boolean;
  ga_measurement_id?: string;
  link_params?: string;                // appended to every outbound link e.g. utm_source={pub}&utm_medium=newsletter
  utm_tracking?: boolean;              // add utm_source/medium/campaign to links in emails
  comments?: 'off' | 'subscribers' | 'premium';
  blocked_domains?: string[];          // extra email domains to block at signup
  signup_survey_id?: string;
  signup_flow?: string[];              // ['survey','recommendations','referral']
  send_rate_per_minute?: number;
  google_news?: boolean;
  community_from_name?: string;
  stripe_account_id?: string;          // Stripe Connect account
  discord?: { guild_id?: string; bot_token?: string; tier_roles?: Record<string, string> };
  [k: string]: unknown;
}

export function settings(pub: Publication): PubSettings {
  return parseJSON<PubSettings>(pub.settings, {});
}

/** Public base URL of a publication's website (no trailing slash). */
export function siteUrl(env: Env, pub: Pick<Publication, 'slug' | 'custom_domain'>): string {
  if (pub.custom_domain) return `https://${pub.custom_domain}`;
  return `${env.APP_URL.replace(/\/$/, '')}/s/${pub.slug}`;
}

export function appUrl(env: Env, path = ''): string {
  return env.APP_URL.replace(/\/$/, '') + path;
}

export async function getPub(env: Env, id: string): Promise<Publication | null> {
  return one<Publication>(env, 'SELECT * FROM publications WHERE id = ?', id);
}

export async function pubBySlug(env: Env, slug: string): Promise<Publication | null> {
  return one<Publication>(env, 'SELECT * FROM publications WHERE slug = ?', slug);
}

export async function pubByDomain(env: Env, host: string): Promise<Publication | null> {
  return one<Publication>(env, 'SELECT * FROM publications WHERE custom_domain = ?', host.toLowerCase());
}

/** The sender identity for a purpose (newsletter | transactional | automations | community). */
export async function senderFor(env: Env, pub: Publication, purpose = 'newsletter', senderId?: string | null): Promise<{ email: string; name: string }> {
  const row =
    (senderId ? await one<any>(env, 'SELECT email, name FROM sender_addresses WHERE id = ? AND pub_id = ?', senderId, pub.id) : null) ||
    (await one<any>(env, 'SELECT email, name FROM sender_addresses WHERE pub_id = ? AND purpose = ? ORDER BY is_default DESC LIMIT 1', pub.id, purpose)) ||
    (await one<any>(env, 'SELECT email, name FROM sender_addresses WHERE pub_id = ? ORDER BY is_default DESC LIMIT 1', pub.id));
  // Without a verified custom sending domain, mail goes out from the shared sender (<slug>@SHARED_FROM_DOMAIN).
  const s = await applySharedSender(env, pub, { email: row?.email || env.MAIL_FROM, name: row?.name || pub.from_name || pub.name });
  return { email: s.email, name: s.name };
}
