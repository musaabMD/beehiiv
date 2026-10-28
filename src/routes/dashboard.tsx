/** @jsxImportSource hono/jsx */
// Module: dashboard — home (/app), analytics (/app/analytics/*), AI assistant (POST /app/ai).
import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { AppEnv, Ctx, Module } from '../types';
import { all, one, val } from '../lib/db';
import { siteUrl, settings } from '../lib/pub';
import { can } from '../lib/auth';
import { aiText, aiEnabled, AI_DISABLED_MSG } from '../lib/ai';
import { parseRange, previous, subscriberKpis, emailKpis, revenueKpis, webKpis, runReport, postPerformance, recentActivity, statsSummary, postDeliverability, type Range } from '../lib/analytics';
import { DashLayout } from '../ui/layout';
import { Card, Table, Empty, LinkBtn } from '../ui/components';
import { Kpi, fmtPct, fmtNum, fmtUsd, DASH_STYLE, TrendChart } from './dashboard/parts';
import { registerAnalytics } from './dashboard/analytics';
import { registerExplore } from './dashboard/explore';
import { registerGuardian } from './dashboard/guardian';
import { ago, fmtDate, DAY, stripTags } from '../lib/util';
import { planStatus, maybeWarnUsage } from '../lib/plans';
import { registerIntel, AnomalyAlerts, NextSteps } from './dashboard/intel';
import { activeAnomalies } from '../lib/anomalies';
import { suggestions } from '../lib/nextaction';

const dash = new Hono<AppEnv>();
const site = new Hono<AppEnv>();
const root = new Hono<AppEnv>();

// ───────── Home ─────────
async function checklist(c: Ctx) {
  const pub = c.get('pub');
  const [posts, senders, domains, pages, forms, tiers, members, invites] = await Promise.all([
    val<number>(c.env, `SELECT COUNT(*) FROM posts WHERE pub_id = ? AND status = 'published'`, pub.id),
    val<number>(c.env, `SELECT COUNT(*) FROM sender_addresses WHERE pub_id = ?`, pub.id),
    val<number>(c.env, `SELECT COUNT(*) FROM domains WHERE pub_id = ? AND kind = 'email' AND status = 'verified'`, pub.id),
    val<number>(c.env, `SELECT COUNT(*) FROM pages WHERE pub_id = ?`, pub.id),
    val<number>(c.env, `SELECT COUNT(*) FROM forms WHERE pub_id = ?`, pub.id),
    val<number>(c.env, `SELECT COUNT(*) FROM tiers WHERE pub_id = ? AND status = 'active'`, pub.id),
    val<number>(c.env, `SELECT COUNT(DISTINCT user_id) FROM memberships WHERE workspace_id = ?`, pub.workspace_id),
    val<number>(c.env, `SELECT COUNT(*) FROM invites WHERE workspace_id = ?`, pub.workspace_id),
  ]);
  const themed = pub.theme && pub.theme !== '{}';
  return [
    { done: posts > 0, label: 'Publish your first post', href: '/app/posts/new' },
    { done: domains > 0 || senders > 0, label: 'Set up your sender address & domain', href: '/app/settings/domains' },
    { done: !!themed || pages > 0 || !!pub.logo_url, label: 'Customize your website', href: '/app/website/theme' },
    { done: forms > 0, label: 'Create a subscribe form', href: '/app/audience/forms' },
    { done: tiers > 0 || !!settings(pub).stripe_account_id, label: 'Enable paid subscriptions', href: '/app/monetize' },
    { done: members > 1 || invites > 0, label: 'Invite your team', href: '/app/settings/team' },
  ];
}

const FEED_ICON: Record<string, string> = { subscriber: '＋', order: '$', comment: '💬', unsubscribe: '−' };

dash.get('/', async (c) => {
  const pub = c.get('pub');
  const user = c.get('user');
  const rk = ['30d', '90d', '365d'].includes(c.req.query('range') || '') ? c.req.query('range')! : '30d';
  const r = parseRange({ range: rk });
  const p = previous(r);
  const showStats = can(c.get('role'), 'manage');
  const [subs, subsP, em, emP, rev, web, webP, growth, unsubs, recent, feed, steps] = await Promise.all([
    subscriberKpis(c.env, pub.id, r), subscriberKpis(c.env, pub.id, p), emailKpis(c.env, pub.id, r), emailKpis(c.env, pub.id, p), revenueKpis(c.env, pub.id, r),
    webKpis(c.env, pub.id, r), webKpis(c.env, pub.id, p),
    runReport(c.env, pub.id, { metric: 'subscribers', group: 'time', range: r }), runReport(c.env, pub.id, { metric: 'unsubscribes', group: 'time', range: r }),
    postPerformance(c.env, pub.id, { limit: 5 }), recentActivity(c.env, pub.id, 10), checklist(c),
  ]);
  const plan = await planStatus(c.env, pub.workspace_id).catch(() => null);
  if (plan) await maybeWarnUsage(c.env, plan).catch(() => {});
  const drafts = await all<any>(c.env, `SELECT id, title, status, scheduled_at, updated_at FROM posts WHERE pub_id = ? AND status IN ('draft','scheduled') ORDER BY updated_at DESC LIMIT 4`, pub.id);
  const [anoms, nba] = showStats ? await Promise.all([activeAnomalies(c.env, pub.id), suggestions(c.env, pub)]) : [[], []];
  let running = subs.activeAtStart;
  const total = growth.rows.map((x, i) => (running += x.value - (unsubs.rows[i]?.value || 0)));
  const hour = new Date().getUTCHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const doneCount = steps.filter((s) => s.done).length;
  return c.html(
    <DashLayout c={c} title="Home" section="home" head={<style>{raw(DASH_STYLE)}</style>} actions={<LinkBtn href="/app/posts/new" kind="primary">New post</LinkBtn>}>
      {plan && plan.warnings.length > 0 && (
        <div class={`callout ${plan.suspended || plan.overSubscribers || plan.emailsLeft === 0 ? 'danger' : 'warn'}`} data-plan-banner>
          {plan.warnings.map((w) => <div>{w}</div>)}
          {!plan.suspended && <div style="margin-top:6px"><a href="/app/settings/plan"><strong>See plans &amp; usage →</strong></a></div>}
        </div>
      )}
      <AnomalyAlerts items={anoms} back="/app" />
      <div class="hello">
        <div>
          <h2>{greet}, {(user.name || user.email).split(' ')[0]} 👋</h2>
          <p class="muted" style="margin:0">Here's how {pub.name} is doing.</p>
        </div>
        <div class="quick">
          <LinkBtn href="/app/posts/new" small>✍️ Write a post</LinkBtn>
          <LinkBtn href="/app/audience?add=1" small>＋ Add subscribers</LinkBtn>
          <LinkBtn href="/app/audience/imports" small>⇪ Import list</LinkBtn>
          <LinkBtn href={siteUrl(c.env, pub)} target="_blank" small>↗ View site</LinkBtn>
        </div>
      </div>
      {showStats && (
        <div class="stats kpis6">
          <Kpi label="Active subscribers" cur={subs.active} sub={<span class="muted">{fmtNum(subs.premium)} paid</span>} href="/app/analytics/subscribers" />
          <Kpi label={`New subscribers (${rk})`} cur={subs.newSubs} prev={subsP.newSubs} href="/app/analytics/subscribers" />
          <Kpi label="Avg open rate" cur={em.openRate} prev={emP.openRate} fmt={fmtPct} points href="/app/analytics/posts" />
          <Kpi label="Avg click rate" cur={em.ctr} prev={emP.ctr} fmt={(n) => fmtPct(n, 2)} points href="/app/analytics/posts" />
          <Kpi label="MRR" cur={rev.mrr} fmt={fmtUsd} sub={<span class="muted">{fmtUsd(rev.revenue)} revenue ({rk})</span>} href="/app/analytics/revenue" />
          <Kpi label="Website visitors" cur={web.visitors} prev={webP.visitors} href="/app/analytics/web" />
        </div>
      )}
      <div class="split">
        <div>
          <NextSteps items={nba} />
          {showStats && (
            <Card title="Subscriber growth" actions={
              <span class="seg-toggle">{[['30d', '30 days'], ['90d', '90 days'], ['365d', '12 months']].map(([k, l]) => <a href={`/app?range=${k}`} class={k === rk ? 'on' : ''}>{l}</a>)}</span>
            }>
              <TrendChart labels={growth.rows.map((x) => x.label)} values={total} />
              <div class="row muted small" style="margin-top:6px"><span>＋{fmtNum(subs.newSubs)} new</span><span>−{fmtNum(subs.unsubs)} unsubscribed</span><span>net {subs.net >= 0 ? '+' : ''}{fmtNum(subs.net)}</span></div>
            </Card>
          )}
          <Card title="Recent posts" actions={<LinkBtn href="/app/analytics/posts" small>All performance</LinkBtn>} pad={false}>
            <Table rows={recent} empty={<Empty title="No posts yet" body="Write your first post — it can go out by email, on the web, or both." action={<LinkBtn href="/app/posts/new" kind="primary">Write a post</LinkBtn>} />} cols={[
              { h: 'Post', r: (x) => <a href={`/app/posts/${x.id}`}>{x.title || '(untitled)'}</a> },
              { h: 'Published', r: (x) => <span class="nowrap muted">{fmtDate(x.published_at)}</span> },
              { h: 'Delivered', r: (x) => (x.platform === 'web' ? <span class="muted">web only</span> : fmtNum(x.delivered)), class: 'right' },
              { h: 'Opens', r: (x) => (x.delivered ? fmtPct(x.open_rate) : '—'), class: 'right' },
              { h: 'Clicks', r: (x) => (x.delivered ? fmtPct(x.ctr, 2) : '—'), class: 'right' },
              { h: 'Views', r: (x) => fmtNum(x.web_views), class: 'right' },
            ]} />
          </Card>
          {drafts.length > 0 && (
            <Card title="Drafts & scheduled" pad={false}>
              <Table rows={drafts} cols={[
                { h: 'Title', r: (x) => <a href={`/app/posts/${x.id}`}>{x.title || '(untitled draft)'}</a> },
                { h: 'Status', r: (x) => (x.status === 'scheduled' ? <span class="badge b-blue">scheduled {fmtDate(x.scheduled_at, { dateStyle: 'medium', timeStyle: 'short' })}</span> : <span class="badge b-gray">draft</span>) },
                { h: 'Edited', r: (x) => <span class="muted">{ago(x.updated_at)}</span>, class: 'right' },
              ]} />
            </Card>
          )}
        </div>
        <div>
          {doneCount < steps.length && (
            <Card title={`Get set up · ${doneCount}/${steps.length}`}>
              <div class="progress" style="margin-bottom:10px"><div class="progress-bar" style={`width:${(doneCount / steps.length) * 100}%`} /></div>
              <ul class="checklist">
                {steps.map((s) => <li class={s.done ? 'done' : ''}><span class="ck">{s.done ? '✓' : ''}</span><a href={s.href}>{s.label}</a></li>)}
              </ul>
            </Card>
          )}
          <Card title="Recent activity">
            {feed.length ? (
              <ul class="feed">
                {feed.map((f) => (
                  <li>
                    <span class={`fi fi-${f.kind}`}>{FEED_ICON[f.kind] || '•'}</span>
                    <div class="grow" style="min-width:0"><a href={f.href} style="text-decoration:none;font-weight:600">{f.title}</a><div class="muted small fd">{f.detail}</div></div>
                    <span class="muted small nowrap">{ago(f.at)}</span>
                  </li>
                ))}
              </ul>
            ) : <p class="muted">New subscribers, purchases and comments will show up here.</p>}
          </Card>
          <Card title="Tips">
            <p class="small muted" style="margin:0">Press <kbd>⌘K</kbd> to jump anywhere and <kbd>⌘J</kbd> to ask the AI assistant things like “how did my last post do?” or “write 5 subject lines”.</p>
          </Card>
        </div>
      </div>
    </DashLayout>,
  );
});

registerExplore(dash);
registerIntel(dash);
registerAnalytics(dash);
registerGuardian(dash, root); // Analytics → Deliverability → Guardian (+ /seed/* placement links)

// ───────── AI assistant (⌘J) ─────────
const STATS_RE = /\b(open rate|opens?|ctr|click|clicks|click-through|revenue|mrr|arr|earn|money|sales|subscriber|subscribers|growth|grow|unsubscrib|churn|stats|statistics|perform|performance|how (did|is|are|many|much)|traffic|visitors|views|best post|top post|worst|compare|analytics|numbers|report|deliverab|bounce)\b/i;
const WRITE_RE = /\b(write|draft|rewrite|rephrase|subject line|headline|title idea|intro|outline|summar|translate|fix (the )?(spelling|grammar)|proofread|shorten|expand|tone|cta|call to action|tweet|social post)\b/i;

function rangeFromQuestion(q: string): Range {
  const s = q.toLowerCase();
  if (/today|24 ?h|yesterday/.test(s)) return parseRange({ range: '7d' });
  if (/(last|past) ?7 ?days|this week|last week|week/.test(s)) return parseRange({ range: '7d' });
  if (/90 ?days|quarter|3 months/.test(s)) return parseRange({ range: '90d' });
  if (/year|12 months|annual|ytd/.test(s)) return parseRange({ range: /ytd|this year/.test(s) ? 'ytd' : '365d' });
  if (/this month|mtd/.test(s)) return parseRange({ range: 'mtd' });
  if (/all time|ever|since (the )?start/.test(s)) return parseRange({ range: 'all' });
  return parseRange({ range: '30d' });
}

dash.post('/ai', async (c) => {
  const pub = c.get('pub');
  const body = await c.req.json<{ q?: string; path?: string; context?: { selection?: string; editor?: string } }>().catch(() => ({} as any));
  const q = String(body.q || '').trim().slice(0, 4000);
  if (!q) return c.json({ text: 'Ask me anything about your publication — stats, ideas, drafts, subject lines.' });
  const path = String(body.path || '');
  const inEditor = /^\/app\/(posts|automations)\//.test(path);
  const selection = String(body.context?.selection || '').slice(0, 4000);
  const editor = String(body.context?.editor || '').slice(0, 6000);
  const canStats = can(c.get('role'), 'manage');

  // Stats questions: ground the answer in real numbers.
  if (STATS_RE.test(q) && !WRITE_RE.test(q) && canStats) {
    const r = rangeFromQuestion(q);
    const summary = await statsSummary(c.env, pub.id, r);
    // a specific post?
    const posts = await all<{ id: string; title: string }>(c.env, `SELECT id, title FROM posts WHERE pub_id = ? AND status = 'published' AND title != '' ORDER BY published_at DESC LIMIT 200`, pub.id);
    const ql = q.toLowerCase();
    let post = posts.find((p) => p.title.length > 3 && ql.includes(p.title.toLowerCase()));
    if (!post && /\b(last|latest|most recent|newest) (post|issue|newsletter|email|send)\b/.test(ql)) post = posts[0];
    let postData: any = null;
    let postText = '';
    if (post) {
      const [perf] = await postPerformance(c.env, pub.id, { ids: [post.id] });
      const prov = await postDeliverability(c.env, pub.id, post.id);
      postData = { ...perf, providers: prov };
      if (perf) {
        const bestProv = prov.filter((x: any) => x.delivered > 10).sort((a: any, b: any) => b.opened / b.delivered - a.opened / a.delivered)[0];
        postText = `"${perf.title}" (published ${fmtDate(perf.published_at)}) was delivered to ${fmtNum(perf.delivered)} inboxes with a ${fmtPct(perf.open_rate)} open rate and ${fmtPct(perf.ctr, 2)} click-through rate (bots excluded). It drove ${fmtNum(perf.web_views)} web views and ${fmtNum(perf.unsubscribes)} unsubscribes${perf.bounced ? `; ${fmtNum(perf.bounced)} emails bounced` : ''}.${bestProv ? ` ${bestProv.provider} readers engaged most (${fmtPct((bestProv.opened / bestProv.delivered) * 100)} opens).` : ''}`;
      }
    }
    const actions = [
      post ? { label: 'Post analytics', href: `/app/analytics/posts?c=${post.id}` } : { label: 'Open analytics', href: '/app/analytics' },
      /revenue|mrr|arr|earn|money|sales|churn/i.test(q) ? { label: 'Revenue report', href: '/app/analytics/revenue' } : /traffic|visitor|views/i.test(q) ? { label: 'Website analytics', href: '/app/analytics/web' } : /deliverab|bounce/i.test(q) ? { label: 'Deliverability', href: '/app/analytics/deliverability' } : { label: 'Subscriber growth', href: '/app/analytics/subscribers' },
    ];
    const grounded = (postText ? postText + '\n\n' : '') + summary.text;
    if (aiEnabled(c.env)) {
      const res = await aiText(c.env,
        `Question: ${q}\n\nVerified data (JSON):\n${JSON.stringify({ ...summary.data, post: postData })}\n\nPlain-English summary of the data:\n${grounded}`,
        `You are the analytics assistant inside Lnkbase Newsletter, a newsletter platform, for the publication "${pub.name}". Answer the user's question in plain English using ONLY the verified data provided. Lead with the direct answer, cite concrete numbers, compare to the previous period when available, and end with one practical suggestion. Keep it under 150 words. Never invent numbers.`, 700);
      if (res.ok && res.text) return c.json({ text: res.text, actions, data: summary.data });
    }
    return c.json({ text: grounded, actions, data: summary.data });
  }

  // Writing / general help.
  if (!aiEnabled(c.env)) {
    const tips: string[] = [AI_DISABLED_MSG];
    if (canStats) tips.push('Stats questions still work without AI — try "How did my last post do?" or "What was my revenue this month?"');
    return c.json({ text: tips.join('\n\n'), actions: [{ label: 'Analytics', href: '/app/analytics' }] });
  }
  const writing = WRITE_RE.test(q);
  const recentTitles = (await all<{ title: string }>(c.env, `SELECT title FROM posts WHERE pub_id = ? AND status = 'published' ORDER BY published_at DESC LIMIT 8`, pub.id)).map((x) => x.title).filter(Boolean);
  const system = `You are the AI assistant built into Lnkbase Newsletter, a hosted newsletter platform (posts editor, audience & segments, automations, website builder, monetization, podcasts, events, community). You are helping the team behind "${pub.name}"${pub.description ? ` — ${stripTags(pub.description).slice(0, 200)}` : ''}. Recent post titles: ${recentTitles.join('; ') || 'none yet'}.
When asked to write, return only the requested text in clean prose (Markdown-free unless lists are requested). When asked how to do something in OpenHive, give short numbered steps referencing the dashboard sections (Posts, Audience, Automations, Website, Grow, Monetize, Podcasts, Events, Community, Analytics, Settings).`;
  const prompt = [q, selection ? `\n\nSelected text:\n"""${selection}"""` : '', !selection && editor && writing ? `\n\nCurrent draft (for context):\n"""${editor}"""` : ''].join('');
  const res = await aiText(c.env, prompt, system, 1200);
  if (!res.ok) return c.json({ text: res.text });
  const actions: Array<{ label: string; href: string }> = [];
  if (/segment/i.test(q)) actions.push({ label: 'Build a segment', href: '/app/audience/segments/new' });
  if (/automation|welcome|sequence/i.test(q)) actions.push({ label: 'Automations', href: '/app/automations' });
  if (writing && !inEditor) actions.push({ label: 'Start a post', href: '/app/posts/new' });
  return c.json({ text: res.text, actions, insert: writing && inEditor && !/subject line|headline|title idea/i.test(q) ? res.text : undefined });
});

export default { dash, site, root } satisfies Module;
