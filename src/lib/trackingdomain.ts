// Custom tracking domains: a publication can serve open pixels, click redirects, unsubscribe and preference links from
// its own verified hostname (e.g. links.example.com, a CNAME to the app host) instead of APP_URL. Verification reuses
// lib/domains (domains row with kind = 'tracking'); publications.tracking_domain is set only while verified.
// The router (src/index.tsx) accepts tracking paths on those hosts and redirects anything else to the app.
import type { Env, Publication } from '../types';
import { one } from './db';

/** Paths a tracking host serves. Everything else on that host redirects to APP_URL. */
export const TRACKING_PATH = /^\/(t\/|u\/|pref\/|static\/|favicon|health$)/;

function appBase(env: Env) {
  return env.APP_URL.replace(/\/$/, '');
}

/** Base URL for tracking/unsubscribe links in this publication's emails. */
export function trackingBase(env: Env, pub: Pick<Publication, 'id'> | null | undefined): string {
  const host = (pub as any)?.tracking_domain as string | null | undefined;
  return host ? `https://${host}` : appBase(env);
}

/** Move an APP_URL link (…/u/<tok>, …/pref/<tok>) onto the publication's tracking host. */
export function onTrackingHost(env: Env, pub: Pick<Publication, 'id'> | null | undefined, url: string): string {
  const base = appBase(env);
  const tb = trackingBase(env, pub);
  return tb !== base && url.startsWith(base + '/') ? tb + url.slice(base.length) : url;
}

const cache = new Map<string, { at: number; ok: boolean }>();
/** Is `host` a verified tracking domain of some publication? (cached for a minute per isolate) */
export async function isTrackingHost(env: Env, host: string): Promise<boolean> {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  const hit = cache.get(h);
  if (hit && Date.now() - hit.at < 60_000) return hit.ok;
  const ok = !!(await one(env, 'SELECT 1 FROM publications WHERE tracking_domain = ? LIMIT 1', h).catch(() => null));
  cache.set(h, { at: Date.now(), ok });
  return ok;
}

/**
 * Router hook: a request on a verified tracking host. Tracking paths pass through (null = continue); any other path
 * redirects to the same path on the app host, so a tracking domain never serves the dashboard or a site.
 */
export async function routeTrackingHost(env: Env, req: Request): Promise<Response | null | undefined> {
  const url = new URL(req.url);
  if (!(await isTrackingHost(env, url.host))) return undefined; // not a tracking host
  if (TRACKING_PATH.test(url.pathname)) return null;
  return Response.redirect(appBase(env) + (url.pathname === '/' ? '/' : url.pathname) + url.search, 302);
}

export function clearTrackingCache() {
  cache.clear();
}
