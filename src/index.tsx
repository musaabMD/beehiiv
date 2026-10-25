/** @jsxImportSource hono/jsx */
// OpenHive entry: mounts every module, resolves publication sites (path + custom domains), runs cron jobs.
import { Hono } from 'hono';
import type { AppEnv, Env, Module, Subscriber } from './types';
import { one } from './lib/db';
import { requireUser, readerEmail } from './lib/auth';
import { pubBySlug, pubByDomain, settings } from './lib/pub';
import { classifyCrawler } from './lib/guard';
import { logBot } from './lib/tracking';
import { runJobs, runPeriodic, logError } from './lib/jobs';
import { now } from './lib/util';
import './lib/webhooks';
import './lib/sender';
import './lib/automations';

import core from './routes/core';
import landing from './routes/landing';
import auth from './routes/auth';
import dashboard from './routes/dashboard';
import posts from './routes/posts';
import website from './routes/website';
import podcasts from './routes/podcasts';
import community from './routes/community';
import events from './routes/events';
import audience from './routes/audience';
import automations from './routes/automations';
import monetize from './routes/monetize';
import grow from './routes/grow';
import settingsMod from './routes/settings';
import api from './routes/api';

export { CollabRoom } from './lib/collab';
export { LiveRoom } from './lib/live';

const app = new Hono<AppEnv>();

app.onError(async (err, c) => {
  await logError(c.env, 'http:' + new URL(c.req.url).pathname, err, c.get('pub')?.id);
  if (c.req.path.startsWith('/api/') || c.req.header('accept')?.includes('application/json')) return c.json({ error: 'internal_error', message: err.message }, 500);
  return c.html(`<!doctype html><meta charset="utf-8"><title>Error</title><body style="font-family:system-ui;padding:48px;max-width:640px;margin:auto"><h1>Something went wrong</h1><p>${String(err.message).replace(/</g, '&lt;')}</p><p><a href="javascript:history.back()">Go back</a></p></body>`, 500);
});

// ───── Public publication sites: /s/:slug/* ─────
app.use('/s/:slug/*', async (c, next) => {
  const pub = await pubBySlug(c.env, c.req.param('slug'));
  if (!pub || pub.status === 'deleted') return c.text('Publication not found', 404);
  c.set('pub', pub);
  const url = new URL(c.req.url);
  const rel = url.pathname.replace(/^\/s\/[^/]+/, '') || '/';
  // crawler control + AI bot analytics
  const crawler = classifyCrawler(c.req.header('user-agent'));
  if (crawler) {
    const cfg = settings(pub);
    const blocked = (cfg.block_ai_crawlers && crawler.category === 'ai') || (cfg.blocked_crawlers || []).includes(crawler.bot);
    c.executionCtx.waitUntil(logBot(c.env, pub.id, crawler.bot, crawler.category, rel, blocked && rel !== '/robots.txt' ? 'blocked' : 'served').catch(() => {}));
    if (blocked && rel !== '/robots.txt') return c.text('Crawling not permitted', 403);
  }
  // redirects (old links never break)
  if (c.req.method === 'GET') {
    const r = await one<{ id: string; to_url: string; code: number }>(c.env, 'SELECT id, to_url, code FROM redirects WHERE pub_id = ? AND from_path = ?', pub.id, rel.replace(/\/$/, '') || '/');
    if (r) {
      c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE redirects SET hits = hits + 1 WHERE id = ?').bind(r.id).run());
      const to = r.to_url.startsWith('/') ? url.pathname.replace(/^(\/s\/[^/]+).*/, '$1') + r.to_url : r.to_url;
      return c.redirect(to, (r.code === 302 ? 302 : 301) as 301 | 302);
    }
  }
  // reader identity
  const email = await readerEmail(c);
  if (email) {
    const sub = await one<Subscriber>(c.env, 'SELECT * FROM subscribers WHERE pub_id = ? AND email = ?', pub.id, email);
    const premium = !!sub && sub.status === 'active' && (sub.tier === 'premium' || (!!sub.trial_ends_at && sub.trial_ends_at > now()));
    c.set('reader', { email, subscriber: sub, premium });
  } else c.set('reader', null);
  await next();
});
// A site's home is the sub-app '/' route (merged as '/s/:slug'); '/s/:slug/' is normalized in fetch() below.

// ───── Dashboard: /app/* ─────
app.use('/app', requireUser);
app.use('/app/*', requireUser);

const mods: Array<[string, Module]> = [
  ['/app/onboarding', auth],
  ['/app/posts', posts],
  ['/app/website', website],
  ['/app/podcasts', podcasts],
  ['/app/community', community],
  ['/app/events', events],
  ['/app/audience', audience],
  ['/app/automations', automations],
  ['/app/monetize', monetize],
  ['/app/grow', grow],
  ['/app/settings', settingsMod],
  ['/app/api', api],
  ['/app', dashboard], // home, analytics, AI helper
];
for (const [path, m] of mods) if (m.dash) app.route(path, m.dash);

// Root (public, non-publication) routes
for (const m of [core, landing, auth, api, audience, posts, podcasts, events, monetize, grow, community, settingsMod, dashboard, website]) if (m.root) app.route('/', m.root);

// Publication site routes — website last (it owns the "/:page" catch-all)
for (const m of [auth, audience, monetize, grow, podcasts, events, community, posts, settingsMod, dashboard, website]) if (m.site) app.route('/s/:slug', m.site);

app.notFound((c) => c.html(`<!doctype html><meta charset="utf-8"><title>Not found</title><body style="font-family:system-ui;padding:48px;text-align:center"><h1>404</h1><p>This page doesn't exist.</p><p><a href="/">Home</a></p></body>`, 404));

// Paths that must never be rewritten for custom domains
const PLATFORM_PREFIX = /^\/(static|media|listen|t\/|u\/|pref\/|checkout\/|hooks\/|api\/|mcp|embed\/|app|login|signup|logout|collab|live\/|health|favicon)/;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    const appHost = new URL(env.APP_URL).host;
    if (url.host !== appHost && !url.host.endsWith('.workers.dev') && !url.host.startsWith('localhost') && !url.host.startsWith('127.0.0.1')) {
      const pub = await pubByDomain(env, url.host).catch(() => null);
      if (pub && !PLATFORM_PREFIX.test(url.pathname)) {
        url.pathname = `/s/${pub.slug}${url.pathname}`;
        if (/^\/s\/[^/]+\/$/.test(url.pathname)) url.pathname = url.pathname.slice(0, -1);
        const r = new Request(url.toString(), req);
        return app.fetch(r, env, ctx);
      }
    }
    if (/^\/s\/[^/]+\/$/.test(url.pathname)) {
      url.pathname = url.pathname.slice(0, -1); // site home: '/s/slug/' → '/s/slug'
      return app.fetch(new Request(url.toString(), req), env, ctx);
    }
    return app.fetch(req, env, ctx);
  },
  async scheduled(_evt: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      await runPeriodic(env);
      await runJobs(env, 25_000);
    })());
  },
};
