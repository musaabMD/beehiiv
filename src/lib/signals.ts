// Subscriber Signals: enrich subscribers with free, public signals.
//  - Gravatar public profile (https://api.gravatar.com/v3/profiles/<sha256(email)>): name, avatar, location, job title,
//    company and *verified* social accounts. Only what the person chose to make public; 404s are cached and respected.
//  - Organization + "business email" from the email domain (free-mail and disposable providers are not businesses).
//  - Country from data we already have (signup geo, website visits, email opens).
// Runs in the background (periodic `intel.signals`); a publication can turn it off (settings.subscriber_signals = false),
// which also deletes what was stored for it.
import type { Env, Publication } from '../types';
import { all, one, run } from './db';
import { registerPeriodic } from './jobs';
import { rateLimit, DISPOSABLE } from './guard';
import { sha256, now, DAY, MIN, parseJSON } from './util';
import { settings } from './pub';

/** Subscribers enriched per periodic tick (all publications) — each may cost one Gravatar lookup. */
export const SIGNALS_PER_TICK = 30;
/** Gravatar lookups per hour (the public API allows ~1,000/hour without a key). */
export const GRAVATAR_PER_HOUR = 900;
/** Re-check a subscriber's signals after this long; cached Gravatar answers live this long. */
export const SIGNALS_TTL = 30 * DAY;
export const GRAVATAR_ERROR_RETRY = DAY;

export const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'yahoo.co.jp', 'yahoo.co.in', 'ymail.com', 'rocketmail.com',
  'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'hotmail.it', 'outlook.com', 'outlook.fr', 'outlook.de', 'live.com', 'live.co.uk', 'live.fr', 'msn.com', 'windowslive.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'aim.com', 'protonmail.com', 'protonmail.ch', 'proton.me', 'pm.me', 'tutanota.com', 'tuta.io',
  'hey.com', 'fastmail.com', 'fastmail.fm', 'zoho.com', 'zohomail.com', 'gmx.com', 'gmx.net', 'gmx.de', 'web.de', 't-online.de', 'freenet.de',
  'mail.com', 'email.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'bk.ru', 'inbox.ru', 'list.ru', 'rambler.ru', 'qq.com', '163.com', '126.com', 'sina.com', 'yeah.net',
  'naver.com', 'daum.net', 'hanmail.net', 'seznam.cz', 'libero.it', 'virgilio.it', 'orange.fr', 'wanadoo.fr', 'free.fr', 'laposte.net', 'sfr.fr',
  'btinternet.com', 'sky.com', 'virginmedia.com', 'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'cox.net', 'charter.net', 'bellsouth.net',
  'shaw.ca', 'rogers.com', 'sympatico.ca', 'bigpond.com', 'optusnet.com.au', 'rediffmail.com', 'uol.com.br', 'bol.com.br', 'terra.com.br', 'hushmail.com', 'duck.com', 'skiff.com',
]);

export interface DomainSignals { domain: string; business: boolean; organization: string | null }

/** Organization and business-ness from an email domain. Free-mail and disposable domains are personal addresses. */
export function domainSignals(email: string): DomainSignals {
  const domain = (email.split('@')[1] || '').toLowerCase().trim();
  if (!domain || FREE_MAIL.has(domain) || DISPOSABLE.has(domain)) return { domain, business: false, organization: null };
  const parts = domain.split('.');
  // registrable label: acme.co.uk → acme, mail.acme.io → acme
  const sld = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);
  let label = parts.length >= 3 && sld.has(parts[parts.length - 2]) ? parts[parts.length - 3] : parts[parts.length - 2] || parts[0];
  label = label.replace(/[-_]+/g, ' ').trim();
  const organization = label ? label.replace(/\b\w/g, (ch) => ch.toUpperCase()) : null;
  return { domain, business: true, organization };
}

export interface GravatarProfile {
  display_name?: string; avatar_url?: string; profile_url?: string; location?: string; job_title?: string; company?: string;
  socials: Array<{ service: string; label: string; url: string }>;
}

function parseProfile(j: any): GravatarProfile {
  const s = (v: unknown, n = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);
  const url = (v: unknown) => { const u = s(v, 500); return u && /^https:\/\//i.test(u) ? u : undefined; };
  const socials = (Array.isArray(j?.verified_accounts) ? j.verified_accounts : [])
    .filter((a: any) => a && !a.is_hidden && url(a.url))
    .slice(0, 12)
    .map((a: any) => ({ service: s(a.service_type, 40) || 'link', label: s(a.service_label, 60) || s(a.service_type, 40) || 'Profile', url: url(a.url)! }));
  return { display_name: s(j?.display_name), avatar_url: url(j?.avatar_url), profile_url: url(j?.profile_url), location: s(j?.location), job_title: s(j?.job_title), company: s(j?.company), socials };
}

/**
 * Look up a public Gravatar profile (cached across publications by email hash). Returns null when there is no public
 * profile, or undefined when the lookup was skipped (rate limit / network error) and should be retried later.
 */
export async function gravatarProfile(env: Env, email: string, opts: { force?: boolean } = {}): Promise<GravatarProfile | null | undefined> {
  const hash = await sha256(email.trim().toLowerCase());
  const cached = await one<{ status: string; data: string; fetched_at: number }>(env, 'SELECT status, data, fetched_at FROM gravatar_cache WHERE hash = ?', hash);
  const t = now();
  if (cached && !opts.force) {
    const fresh = cached.status === 'error' ? t - cached.fetched_at < GRAVATAR_ERROR_RETRY : t - cached.fetched_at < SIGNALS_TTL;
    if (fresh) return cached.status === 'found' ? parseJSON<GravatarProfile>(cached.data, { socials: [] }) : cached.status === 'none' ? null : undefined;
  }
  if (!(await rateLimit(env, 'gravatar:api', GRAVATAR_PER_HOUR, 3600))) return undefined;
  let status: 'found' | 'none' | 'error' = 'error';
  let profile: GravatarProfile | null = null;
  try {
    const r = await fetch(`https://api.gravatar.com/v3/profiles/${hash}`, { headers: { accept: 'application/json', 'user-agent': 'LnkbaseNewsletter/1.0 (+subscriber-signals)' }, signal: AbortSignal.timeout(5000) });
    if (r.status === 404) status = 'none';
    else if (r.status === 429) { await run(env, 'INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES (?, ?, ?)', 'gravatar:api', GRAVATAR_PER_HOUR + 1, t + 15 * MIN); return undefined; }
    else if (r.ok) { profile = parseProfile(await r.json()); status = 'found'; }
  } catch { status = 'error'; }
  await run(env, 'INSERT OR REPLACE INTO gravatar_cache (hash, status, data, fetched_at) VALUES (?, ?, ?, ?)', hash, status, JSON.stringify(profile || {}), t);
  return status === 'found' ? profile : status === 'none' ? null : undefined;
}

export function signalsEnabled(pub: Pick<Publication, 'settings'>): boolean {
  return (settings(pub as Publication) as any).subscriber_signals !== false;
}

/** Best country we already know for a subscriber: signup geo, then website visits, then email opens. */
async function knownCountry(env: Env, sub: { id: string; pub_id: string; country: string | null }): Promise<string | null> {
  if (sub.country) return sub.country;
  const pv = await one<{ country: string }>(env, `SELECT country FROM page_views WHERE pub_id = ? AND subscriber_id = ? AND country IS NOT NULL AND country != '' ORDER BY created_at DESC LIMIT 1`, sub.pub_id, sub.id);
  if (pv?.country) return pv.country;
  const op = await one<{ country: string }>(env, `SELECT o.country FROM opens o JOIN deliveries d ON d.id = o.delivery_id WHERE d.subscriber_id = ? AND o.is_bot = 0 AND o.country IS NOT NULL AND o.country != '' ORDER BY o.created_at DESC LIMIT 1`, sub.id);
  return op?.country || null;
}

/** Enrich one subscriber. `gravatar: false` stores domain/country signals only. */
export async function enrichSubscriber(env: Env, sub: { id: string; pub_id: string; email: string; country: string | null }, opts: { gravatar?: boolean; force?: boolean } = {}) {
  const d = domainSignals(sub.email);
  const country = await knownCountry(env, sub);
  let g: GravatarProfile | null | undefined = undefined;
  if (opts.gravatar !== false) g = await gravatarProfile(env, sub.email, { force: opts.force });
  const prev = await one<any>(env, 'SELECT * FROM subscriber_signals WHERE subscriber_id = ?', sub.id);
  // keep previously found Gravatar data when this lookup was skipped
  const keep = g === undefined && prev?.gravatar_status === 'found';
  const status = g === undefined ? (keep ? 'found' : opts.gravatar === false ? 'skipped' : 'error') : g ? 'found' : 'none';
  const pick = (k: keyof GravatarProfile) => (keep ? prev[k] ?? null : g ? (g[k] as string | undefined) ?? null : null);
  const socials = keep ? prev.socials : JSON.stringify(g?.socials || []);
  await run(env, `INSERT INTO subscriber_signals (subscriber_id, pub_id, gravatar_status, display_name, avatar_url, profile_url, location, job_title, company, socials, social_count, email_domain, business_email, organization, country, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(subscriber_id) DO UPDATE SET gravatar_status = excluded.gravatar_status, display_name = excluded.display_name, avatar_url = excluded.avatar_url, profile_url = excluded.profile_url,
      location = excluded.location, job_title = excluded.job_title, company = excluded.company, socials = excluded.socials, social_count = excluded.social_count, email_domain = excluded.email_domain,
      business_email = excluded.business_email, organization = excluded.organization, country = excluded.country, updated_at = excluded.updated_at`,
    sub.id, sub.pub_id, status, pick('display_name'), pick('avatar_url'), pick('profile_url'), pick('location'), pick('job_title'), pick('company'), socials, parseJSON<any[]>(socials, []).length,
    d.domain, d.business ? 1 : 0, d.organization, country, now(),
  );
  // a retryable error: make the row due again soon instead of in SIGNALS_TTL
  if (status === 'error' || status === 'skipped') await run(env, 'UPDATE subscriber_signals SET updated_at = ? WHERE subscriber_id = ?', now() - SIGNALS_TTL + GRAVATAR_ERROR_RETRY, sub.id);
}

export async function getSignals(env: Env, subscriberId: string) {
  const r = await one<any>(env, 'SELECT * FROM subscriber_signals WHERE subscriber_id = ?', subscriberId);
  return r ? { ...r, socials: parseJSON<GravatarProfile['socials']>(r.socials, []), business_email: !!r.business_email } : null;
}

/** Turn enrichment on/off for a publication. Turning it off deletes the stored signals. */
export async function setSignalsEnabled(env: Env, pubId: string, on: boolean) {
  await run(env, `UPDATE publications SET settings = json_set(COALESCE(NULLIF(settings, ''), '{}'), '$.subscriber_signals', json(?)) WHERE id = ?`, on ? 'true' : 'false', pubId);
  if (!on) await run(env, 'DELETE FROM subscriber_signals WHERE pub_id = ?', pubId);
}

/** One periodic pass: enrich the subscribers that are missing signals or are due for a refresh. */
export async function enrichDue(env: Env, limit = SIGNALS_PER_TICK) {
  const pubs = await all<Publication>(env, `SELECT id, settings FROM publications WHERE status = 'active'`);
  let left = limit;
  for (const p of pubs) {
    if (left <= 0) break;
    if (!signalsEnabled(p)) continue;
    const due = await all<{ id: string; pub_id: string; email: string; country: string | null }>(env, `
      SELECT s.id, s.pub_id, s.email, s.country FROM subscribers s LEFT JOIN subscriber_signals g ON g.subscriber_id = s.id
      WHERE s.pub_id = ? AND s.status = 'active' AND s.source != 'try_it' AND (g.subscriber_id IS NULL OR g.updated_at < ?)
      ORDER BY g.updated_at IS NOT NULL, s.created_at DESC LIMIT ?`, p.id, now() - SIGNALS_TTL, left);
    for (const s of due) {
      await enrichSubscriber(env, s);
      left--;
    }
  }
}

registerPeriodic('intel.signals', 10 * MIN, (env) => enrichDue(env));
