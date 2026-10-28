/** @jsxImportSource hono/jsx */
// Analytics pages: /app/analytics/*
import type { Child } from 'hono/jsx';
import { pageSpeed } from '../../lib/analytics';
import { raw } from 'hono/html';
import type { App, Ctx } from '../../types';
import { all, one, run, insert } from '../../lib/db';
import { requirePerm } from '../../lib/auth';
import {
  parseRange, previous, runReport, METRICS, dimsFor, subscriberKpis, emailKpis, revenueKpis, webKpis, podcastKpis, postPerformance, realtime,
  trafficToSubscribers, engagementDistribution, cohorts, deliverability, postDeliverability, suppressionSummary, type Filter, type Range,
  SEGMENT_SUBJECT, yearAgo, compareReports,
} from '../../lib/analytics';
import { compile, segmentGroup } from '../../lib/segments';
import { activeAnomalies } from '../../lib/anomalies';
import { predictionSummary, topSubscribers, MAX_TENURE_MONTHS } from '../../lib/predict';
import { AnomalyAlerts } from './intel';
import { DashLayout } from '../../ui/layout';
import { Card, Grid, Stats, Stat, Table, LineChart, Bars, Badge, Status, Empty, LinkBtn, Btn, Field, Input, back } from '../../ui/components';
import { TrendChart, RangeBar, Kpi, FilterChips, parseFilters, normalizeChipQuery, CompareChart, csv, qsWith, fmtPct, fmtNum, fmtUsd, DASH_STYLE } from './parts';
import { fmtDate, ago, id, now, parseJSON, str, form, esc } from '../../lib/util';
import { StoreRevenueCard } from '../integrations-commerce';

const head = <style>{raw(DASH_STYLE)}</style>;

function Page(p: { c: Ctx; title: string; sub: string; children?: Child; actions?: Child; scripts?: string[] }) {
  return <DashLayout c={p.c} title={p.title} section="analytics" sub={p.sub} head={head} actions={p.actions} scripts={p.scripts}>{p.children}</DashLayout>;
}

const usdAxis = (n: number) => '$' + Math.round(n / 100).toLocaleString('en-US');

export function registerAnalytics(dash: App) {
  dash.use('/analytics/*', requirePerm('manage'));
  dash.use('/analytics', requirePerm('manage'));

  // ───────── Overview ─────────
  dash.get('/analytics', async (c) => {
    const pub = c.get('pub');
    const r = parseRange(c.req.query());
    const p = previous(r);
    const [subs, subsP, em, emP, rev, revP, web, webP, pod, podP] = await Promise.all([
      subscriberKpis(c.env, pub.id, r), subscriberKpis(c.env, pub.id, p), emailKpis(c.env, pub.id, r), emailKpis(c.env, pub.id, p),
      revenueKpis(c.env, pub.id, r), revenueKpis(c.env, pub.id, p), webKpis(c.env, pub.id, r), webKpis(c.env, pub.id, p), podcastKpis(c.env, pub.id, r), podcastKpis(c.env, pub.id, p),
    ]);
    const [newS, unS, pv, vis, revS, dl] = await Promise.all([
      runReport(c.env, pub.id, { metric: 'subscribers', group: 'time', range: r }), runReport(c.env, pub.id, { metric: 'unsubscribes', group: 'time', range: r }),
      runReport(c.env, pub.id, { metric: 'page_views', group: 'time', range: r }), runReport(c.env, pub.id, { metric: 'visitors', group: 'time', range: r }),
      runReport(c.env, pub.id, { metric: 'revenue', group: 'time', range: r }), runReport(c.env, pub.id, { metric: 'downloads', group: 'time', range: r }),
    ]);
    const labels = newS.rows.map((x) => x.label);
    const anoms = await activeAnomalies(c.env, pub.id);
    return c.html(
      <Page c={c} title="Analytics" sub="overview" actions={
        <form method="post" action="/app/analytics/anomalies/check" class="inline-form"><input type="hidden" name="back" value="/app/analytics" /><Btn small kind="ghost" attrs={{ title: 'Compare the last 24 hours with the previous 14 days' }}>Check for anomalies</Btn></form>
      }>
        <AnomalyAlerts items={anoms} back="/app/analytics" />
        <RangeBar c={c} range={r} />
        <h3>Audience</h3>
        <Stats>
          <Kpi label="Active subscribers" cur={subs.active} sub={<span class="muted">{fmtNum(subs.premium)} paid</span>} href="/app/analytics/subscribers" />
          <Kpi label="New subscribers" cur={subs.newSubs} prev={subsP.newSubs} />
          <Kpi label="Unsubscribes" cur={subs.unsubs} prev={subsP.unsubs} invert />
          <Kpi label="Net growth" cur={subs.net} prev={subsP.net} />
        </Stats>
        <h3>Newsletter</h3>
        <Stats>
          <Kpi label="Emails delivered" cur={em.delivered} prev={emP.delivered} href="/app/analytics/posts" />
          <Kpi label="Open rate" cur={em.openRate} prev={emP.openRate} fmt={fmtPct} points />
          <Kpi label="Click-through rate" cur={em.ctr} prev={emP.ctr} fmt={(n) => fmtPct(n, 2)} points sub={undefined} />
          <Kpi label="Bounces" cur={em.bounced} prev={emP.bounced} invert href="/app/analytics/deliverability" />
        </Stats>
        <h3>Website</h3>
        <Stats>
          <Kpi label="Unique visitors" cur={web.visitors} prev={webP.visitors} href="/app/analytics/web" />
          <Kpi label="Page views" cur={web.views} prev={webP.views} />
          <Kpi label="Visitor → subscriber" cur={web.conversion} prev={webP.conversion} fmt={(n) => fmtPct(n, 2)} points />
        </Stats>
        <h3>Revenue &amp; podcast</h3>
        <Stats>
          <Kpi label="Revenue" cur={rev.revenue} prev={revP.revenue} fmt={fmtUsd} href="/app/analytics/revenue" />
          <Kpi label="MRR" cur={rev.mrr} fmt={fmtUsd} sub={<span class="muted">ARR {fmtUsd(rev.arr)}</span>} />
          <Kpi label="Podcast downloads" cur={pod.downloads} prev={podP.downloads} href="/app/analytics/podcasts" />
          <Kpi label="Unique listeners" cur={pod.listeners} prev={podP.listeners} />
        </Stats>
        <Grid cols={2}>
          <Card title="Subscribers: new vs unsubscribed"><LineChart labels={labels} series={[{ label: 'New', values: newS.rows.map((x) => x.value) }, { label: 'Unsubscribed', values: unS.rows.map((x) => x.value), color: '#ef4444' }]} /></Card>
          <Card title="Website traffic"><LineChart labels={labels} series={[{ label: 'Page views', values: pv.rows.map((x) => x.value), color: '#3b82f6' }, { label: 'Visitors', values: vis.rows.map((x) => x.value), color: 'var(--accent)' }]} /></Card>
          <Card title="Revenue"><LineChart labels={labels} series={[{ label: 'Revenue', values: revS.rows.map((x) => x.value), color: '#10b981' }]} fmt={usdAxis} /></Card>
          <Card title="Podcast downloads"><LineChart labels={labels} series={[{ label: 'Downloads', values: dl.rows.map((x) => x.value), color: '#8b5cf6' }]} /></Card>
        </Grid>
      </Page>,
    );
  });

  // ───────── Posts ─────────
  dash.get('/analytics/posts', async (c) => {
    const pub = c.get('pub');
    const r = parseRange(c.req.query(), 'all');
    const sort = c.req.query('sort') || '-published_at';
    const rows = await postPerformance(c.env, pub.id, { range: r, sort });
    if (c.req.query('format') === 'csv')
      return csv(c, 'post-performance', [['Title', 'Published', 'Recipients', 'Delivered', 'Opened', 'Open rate %', 'Clicked', 'CTR %', 'Bounced', 'Unsubscribes', 'Web views', 'Revenue'],
        ...rows.map((x) => [x.title, x.published_at ? new Date(x.published_at).toISOString().slice(0, 10) : '', x.recipients, x.delivered, x.opened, x.open_rate.toFixed(2), x.clicked, x.ctr.toFixed(2), x.bounced, x.unsubscribes, x.web_views, (x.revenue / 100).toFixed(2)])]);
    const compareIds = c.req.queries('c') || [];
    const compared = compareIds.length ? await postPerformance(c.env, pub.id, { ids: compareIds }) : [];
    const sortLink = (k: string, label: string) => {
      const next = sort === `-${k}` ? k : `-${k}`;
      return <a href={qsWith(c, { sort: next })} style="text-decoration:none">{label}{sort.replace('-', '') === k ? (sort.startsWith('-') ? ' ↓' : ' ↑') : ''}</a>;
    };
    const avgOpen = rows.filter((x) => x.delivered).reduce((n, x) => n + x.open_rate, 0) / Math.max(1, rows.filter((x) => x.delivered).length);
    const avgCtr = rows.filter((x) => x.delivered).reduce((n, x) => n + x.ctr, 0) / Math.max(1, rows.filter((x) => x.delivered).length);
    return c.html(
      <Page c={c} title="Post performance" sub="posts" actions={<LinkBtn href={qsWith(c, { format: 'csv' })} small>Export CSV</LinkBtn>}>
        <RangeBar c={c} range={r} keep={['sort']} />
        <Stats>
          <Stat label="Posts published" value={fmtNum(rows.length)} />
          <Stat label="Avg open rate" value={fmtPct(avgOpen)} />
          <Stat label="Avg click-through" value={fmtPct(avgCtr, 2)} sub="bot clicks excluded" />
          <Stat label="Total web views" value={fmtNum(rows.reduce((n, x) => n + x.web_views, 0))} />
        </Stats>
        {compared.length > 0 && (
          <Card title={`Comparing ${compared.length} posts`} actions={<a class="btn btn-ghost btn-sm" href={qsWith(c, { c: null })}>Clear</a>}>
            <CompareChart
              items={compared.map((x) => ({ label: x.title, values: [x.open_rate, x.ctr, x.delivered, x.web_views, x.unsubscribes] }))}
              metrics={['Open rate', 'Click-through rate', 'Delivered', 'Web views', 'Unsubscribes']}
              fmt={(n, i) => (i === 0 ? fmtPct(n) : i === 1 ? fmtPct(n, 2) : fmtNum(n))}
            />
          </Card>
        )}
        <form method="get">
          <input type="hidden" name="range" value={r.key === 'custom' ? '' : r.key} />
          <input type="hidden" name="sort" value={sort} />
          <div class="row between" style="margin-bottom:8px"><span class="muted small">Select posts and compare them side by side.</span><Btn kind="secondary" small>Compare selected</Btn></div>
          <Table
            rows={rows}
            empty={<Empty title="No published posts in this range" body="Publish a post to see its performance here." action={<LinkBtn href="/app/posts/new" kind="primary">Write a post</LinkBtn>} />}
            cols={[
              { h: <input type="checkbox" data-check-all="c" aria-label="Select all" />, r: (x) => <input type="checkbox" name="c" value={x.id} checked={compareIds.includes(x.id)} /> },
              { h: sortLink('title', 'Post'), r: (x) => <a href={`/app/posts/${x.id}`}>{x.title || '(untitled)'}</a> },
              { h: sortLink('published_at', 'Published'), r: (x) => <span class="nowrap">{fmtDate(x.published_at)}</span> },
              { h: sortLink('delivered', 'Delivered'), r: (x) => fmtNum(x.delivered), class: 'right' },
              { h: sortLink('open_rate', 'Open rate'), r: (x) => (x.delivered ? fmtPct(x.open_rate) : '—'), class: 'right' },
              { h: sortLink('ctr', 'CTR'), r: (x) => (x.delivered ? fmtPct(x.ctr, 2) : '—'), class: 'right' },
              { h: sortLink('unsubscribes', 'Unsubs'), r: (x) => fmtNum(x.unsubscribes), class: 'right' },
              { h: sortLink('web_views', 'Web views'), r: (x) => fmtNum(x.web_views), class: 'right' },
              { h: sortLink('revenue', 'Revenue'), r: (x) => (x.revenue ? fmtUsd(x.revenue) : '—'), class: 'right' },
              { h: '', r: (x) => <a class="btn btn-ghost btn-sm" href={`/app/analytics/deliverability?post=${x.id}`}>Inboxes</a> },
            ]}
          />
        </form>
      </Page>,
    );
  });

  // ───────── Website ─────────
  dash.get('/analytics/web/live.json', async (c) => c.json(await realtime(c.env, c.get('pub').id)));

  dash.get('/analytics/web', async (c) => {
    const redirect = normalizeChipQuery(c);
    if (redirect) return c.redirect(redirect);
    const pub = c.get('pub');
    const r = parseRange(c.req.query());
    const filters = parseFilters(c, 'page_views');
    const [kp, kpP, views, visitors, live, traffic, speed] = await Promise.all([
      webKpis(c.env, pub.id, r, filters), webKpis(c.env, pub.id, previous(r), filters),
      runReport(c.env, pub.id, { metric: 'page_views', group: 'time', range: r, filters }), runReport(c.env, pub.id, { metric: 'visitors', group: 'time', range: r, filters }),
      realtime(c.env, pub.id), trafficToSubscribers(c.env, pub.id, r), pageSpeed(c.env, pub.id, r),
    ]);
    const dims = ['channel', 'path', 'referrer', 'country', 'device', 'os', 'browser', 'utm_source', 'utm_campaign'] as const;
    const breakdowns = await Promise.all(dims.map((d) => runReport(c.env, pub.id, { metric: 'visitors', group: d, range: r, filters, limit: 10 })));
    const filterLink = (field: string, value: string) => {
      const u = new URL(c.req.url);
      u.searchParams.append('f', `${field}:eq:${value}`);
      return u.pathname + u.search;
    };
    const Breakdown = (p: { i: number; title: string }) => (
      <Card title={p.title} pad>
        <Bars rows={breakdowns[p.i].rows.map((x) => ({ label: <a href={filterLink(dims[p.i], x.key)} title="Filter by this value">{x.label}</a>, value: x.value }))} />
      </Card>
    );
    const maxMin = Math.max(1, ...live.minutes);
    return c.html(
      <Page c={c} title="Website analytics" sub="web" scripts={['/static/dashboard-web.js']}>
        <RangeBar c={c} range={r} keep={['f']} />
        <FilterChips c={c} metric="page_views" filters={filters} />
        <Grid cols={3}>
          <Card title={<span><span class="live-dot" />Right now</span>} class="live-card">
            <div class="row between"><div><div class="stat-v" data-live="visitors">{fmtNum(live.visitors)}</div><div class="muted small">visitors in the last 30 minutes</div></div><div class="right"><div class="stat-v" data-live="views" style="font-size:18px">{fmtNum(live.views)}</div><div class="muted small">page views</div></div></div>
            <div class="spark" data-live="minutes" style="margin-top:12px">{live.minutes.map((n) => <i style={`height:${(n / maxMin) * 100}%`} title={`${n} views`} />)}</div>
            <ul class="list-plain small" data-live="pages" style="margin-top:10px">{live.pages.slice(0, 5).map((p) => <li class="row between"><span class="truncate">{p.path}</span><strong>{p.n}</strong></li>)}</ul>
          </Card>
          <div style="grid-column:span 2">
            <div class="stats kpis4">
              <Kpi label="Unique visitors" cur={kp.visitors} prev={kpP.visitors} />
              <Kpi label="Page views" cur={kp.views} prev={kpP.views} />
              <Kpi label="New subscribers from web" cur={kp.signups} prev={kpP.signups} />
              <Kpi label="Visitor → subscriber" cur={kp.conversion} prev={kpP.conversion} fmt={(n) => fmtPct(n, 2)} points />
            </div>
            <Card title="Traffic over time"><LineChart labels={views.rows.map((x) => x.label)} series={[{ label: 'Page views', values: views.rows.map((x) => x.value), color: '#3b82f6' }, { label: 'Visitors', values: visitors.rows.map((x) => x.value), color: 'var(--accent)' }]} /></Card>
          </div>
        </Grid>
        <Grid cols={3}>
          <Card title="Page speed (real visitors)" pad>
            {speed.samples ? <>
              <div class="row between"><div><div class="stat-v">{(speed.p75! / 1000).toFixed(1)}s</div><div class="muted small">75th percentile LCP · {speed.p75! <= 2500 ? 'good' : speed.p75! <= 4000 ? 'needs work' : 'poor'}</div></div><div class="right"><div class="stat-v" style="font-size:18px">{Math.round((speed.goodShare || 0) * 100)}%</div><div class="muted small">of views under 2.5s</div></div></div>
              <ul class="list-plain small" style="margin-top:10px">{speed.pages.map((p) => <li class="row between"><span class="truncate">{p.path}</span><strong>{(p.p75 / 1000).toFixed(1)}s</strong></li>)}</ul>
              <p class="muted small" style="margin:8px 0 0">{fmtNum(speed.samples)} page views measured. Largest Contentful Paint as Google measures it; under 2.5s is good.</p>
            </> : <p class="muted small" style="margin:0">Measured from real visitors' browsers as they read your site. Numbers appear after the first visits.</p>}
          </Card>
          <Breakdown i={0} title="Traffic by channel" />
          <Breakdown i={1} title="Top pages" />
          <Breakdown i={2} title="Top referrers" />
          <Breakdown i={3} title="Countries" />
          <Breakdown i={4} title="Devices" />
          <Breakdown i={5} title="Operating systems" />
          <Breakdown i={6} title="Browsers" />
          <Breakdown i={7} title="UTM source" />
          <Breakdown i={8} title="UTM campaign" />
        </Grid>
        <h3 style="margin-top:8px">Traffic → subscribers</h3>
        <p class="help">Which pages, campaigns and referrers produced subscribers in this period. Conversion = signups ÷ unique visitors of that page/source.</p>
        <Grid cols={3}>
          <Card title="By landing page" pad={false}>
            <Table rows={traffic.byLanding} cols={[{ h: 'Page', r: (x) => <span class="truncate" style="max-width:160px">{x.path}</span> }, { h: 'Signups', r: (x) => fmtNum(x.signups), class: 'right' }, { h: 'Conv.', r: (x) => (x.views ? fmtPct((x.signups / x.views) * 100) : '—'), class: 'right' }]} />
          </Card>
          <Card title="By UTM source" pad={false}>
            <Table rows={traffic.byUtm} cols={[{ h: 'Source', r: (x) => x.k }, { h: 'Signups', r: (x) => fmtNum(x.signups), class: 'right' }, { h: 'Conv.', r: (x) => (x.views ? fmtPct((x.signups / x.views) * 100) : '—'), class: 'right' }]} />
          </Card>
          <Card title="By referrer" pad={false}>
            <Table rows={traffic.byRef} cols={[{ h: 'Referrer', r: (x) => x.k }, { h: 'Signups', r: (x) => fmtNum(x.signups), class: 'right' }]} />
          </Card>
        </Grid>
      </Page>,
    );
  });

  // ───────── Bots & AI crawlers ─────────
  dash.get('/analytics/bots', async (c) => {
    const pub = c.get('pub');
    const r = parseRange(c.req.query());
    const [served, blocked, cats, paths, byBot, totals] = await Promise.all([
      runReport(c.env, pub.id, { metric: 'bot_hits', group: 'time', range: r, filters: [{ field: 'action', op: 'eq', value: 'served' }] }),
      runReport(c.env, pub.id, { metric: 'bot_hits', group: 'time', range: r, filters: [{ field: 'action', op: 'eq', value: 'blocked' }] }),
      runReport(c.env, pub.id, { metric: 'bot_hits', group: 'category', range: r }),
      runReport(c.env, pub.id, { metric: 'bot_hits', group: 'path', range: r, limit: 10 }),
      all<any>(c.env, `SELECT bot, category, SUM(CASE WHEN action = 'served' THEN 1 ELSE 0 END) AS served, SUM(CASE WHEN action = 'blocked' THEN 1 ELSE 0 END) AS blocked, MAX(created_at) AS last FROM bot_hits WHERE pub_id = ? AND created_at BETWEEN ? AND ? GROUP BY bot, category ORDER BY served + blocked DESC`, pub.id, r.from, r.to),
      one<any>(c.env, `SELECT COUNT(*) AS n, SUM(CASE WHEN category = 'ai' THEN 1 ELSE 0 END) AS ai, SUM(CASE WHEN action = 'blocked' THEN 1 ELSE 0 END) AS blocked FROM bot_hits WHERE pub_id = ? AND created_at BETWEEN ? AND ?`, pub.id, r.from, r.to),
    ]);
    const humans = await webKpis(c.env, pub.id, r);
    return c.html(
      <Page c={c} title="Bots & AI crawlers" sub="bots" actions={<LinkBtn href="/app/website/seo" small>Crawler controls →</LinkBtn>}>
        <RangeBar c={c} range={r} />
        <Stats>
          <Stat label="Bot requests" value={fmtNum(totals?.n || 0)} sub={`vs ${fmtNum(humans.views)} human page views`} />
          <Stat label="AI crawler requests" value={fmtNum(totals?.ai || 0)} />
          <Stat label="Blocked" value={fmtNum(totals?.blocked || 0)} sub={totals?.n ? fmtPct(((totals.blocked || 0) / totals.n) * 100) + ' of bot traffic' : ''} />
          <Stat label="Served" value={fmtNum((totals?.n || 0) - (totals?.blocked || 0))} />
        </Stats>
        <Card title="Served vs blocked"><LineChart labels={served.rows.map((x) => x.label)} series={[{ label: 'Served', values: served.rows.map((x) => x.value), color: '#3b82f6' }, { label: 'Blocked', values: blocked.rows.map((x) => x.value), color: '#ef4444' }]} /></Card>
        <Grid cols={2}>
          <Card title="By category"><Bars rows={cats.rows.map((x) => ({ label: x.label, value: x.value }))} /></Card>
          <Card title="Most crawled paths"><Bars rows={paths.rows.map((x) => ({ label: x.label, value: x.value }))} /></Card>
        </Grid>
        <Card title="Crawlers" pad={false}>
          <Table rows={byBot} empty="No bot traffic recorded in this period." cols={[
            { h: 'Bot', r: (x) => <strong>{x.bot}</strong> },
            { h: 'Category', r: (x) => <Badge tone={x.category === 'ai' ? 'purple' : x.category === 'search' ? 'blue' : 'gray'}>{x.category}</Badge> },
            { h: 'Served', r: (x) => fmtNum(x.served), class: 'right' },
            { h: 'Blocked', r: (x) => fmtNum(x.blocked), class: 'right' },
            { h: 'Status', r: (x) => (x.blocked && !x.served ? <Badge tone="red">blocked</Badge> : x.blocked ? <Badge tone="amber">partly blocked</Badge> : <Badge tone="green">allowed</Badge>) },
            { h: 'Last seen', r: (x) => ago(x.last) },
          ]} />
        </Card>
      </Page>,
    );
  });

  // ───────── Subscribers ─────────
  dash.get('/analytics/subscribers', async (c) => {
    const pub = c.get('pub');
    const r = parseRange(c.req.query(), '90d');
    const p = previous(r);
    const [k, kP, newS, unS, bySource, byUtm, byCountry, byTier, eng, coh] = await Promise.all([
      subscriberKpis(c.env, pub.id, r), subscriberKpis(c.env, pub.id, p),
      runReport(c.env, pub.id, { metric: 'subscribers', group: 'time', range: r }), runReport(c.env, pub.id, { metric: 'unsubscribes', group: 'time', range: r }),
      runReport(c.env, pub.id, { metric: 'subscribers', group: 'source', range: r }), runReport(c.env, pub.id, { metric: 'subscribers', group: 'utm_source', range: r, limit: 10 }),
      runReport(c.env, pub.id, { metric: 'subscribers', group: 'country', range: r, limit: 10 }), runReport(c.env, pub.id, { metric: 'subscribers', group: 'tier', range: r }),
      engagementDistribution(c.env, pub.id), cohorts(c.env, pub.id, 6),
    ]);
    // cumulative active subscribers line
    let running = k.activeAtStart;
    const cumulative = newS.rows.map((x, i) => (running += x.value - (unS.rows[i]?.value || 0)));
    const SOURCE_LABEL: Record<string, string> = { magic_link: 'Magic links', recommendation: 'Recommendations', boost: 'Boosts', referral: 'Referral program', linkinbio: 'Link in bio', website: 'Website', form: 'Embedded forms', import: 'Import', api: 'API', manual: 'Manual', event: 'Events', product: 'Products' };
    return c.html(
      <Page c={c} title="Subscriber growth" sub="subscribers">
        <RangeBar c={c} range={r} />
        <Stats>
          <Kpi label="Active subscribers" cur={k.active} />
          <Kpi label="New subscribers" cur={k.newSubs} prev={kP.newSubs} />
          <Kpi label="Unsubscribes" cur={k.unsubs} prev={kP.unsubs} invert />
          <Kpi label="Net growth" cur={k.net} prev={kP.net} />
          <Kpi label="Growth rate" cur={k.activeAtStart ? (k.net / k.activeAtStart) * 100 : 0} prev={kP.activeAtStart ? (kP.net / kP.activeAtStart) * 100 : 0} fmt={fmtPct} points />
        </Stats>
        <Grid cols={2}>
          <Card title="Total subscribers"><TrendChart labels={newS.rows.map((x) => x.label)} values={cumulative} /></Card>
          <Card title="New vs unsubscribed"><LineChart labels={newS.rows.map((x) => x.label)} series={[{ label: 'New', values: newS.rows.map((x) => x.value), color: '#10b981' }, { label: 'Unsubscribed', values: unS.rows.map((x) => x.value), color: '#ef4444' }]} /></Card>
          <Card title="Acquisition source"><Bars rows={bySource.rows.map((x) => ({ label: SOURCE_LABEL[x.key] || x.label, value: x.value, sub: bySource.total ? fmtPct((x.value / bySource.total) * 100, 0) : '' }))} /></Card>
          <Card title="UTM source"><Bars rows={byUtm.rows.map((x) => ({ label: x.label, value: x.value }))} /></Card>
          <Card title="Countries"><Bars rows={byCountry.rows.map((x) => ({ label: x.label, value: x.value }))} /></Card>
          <Card title="Engagement (active subscribers)"><Bars rows={eng} /></Card>
        </Grid>
        <Card title="Signup cohorts" pad={false}>
          <Table rows={coh} empty="No signups in the last 6 months." class="heat" cols={[
            { h: 'Signup month', r: (x) => <strong>{x.cohort}</strong> },
            { h: 'Joined', r: (x) => fmtNum(x.joined) },
            { h: 'Still subscribed', r: (x) => <span style={`background:rgba(16,185,129,${(x.retention / 100) * 0.35});padding:2px 8px;border-radius:6px`}>{fmtPct(x.retention, 0)}</span> },
            { h: 'Opened in last 30 days', r: (x) => <span style={`background:rgba(245,158,11,${(x.engaged / 100) * 0.45});padding:2px 8px;border-radius:6px`}>{fmtPct(x.engaged, 0)}</span> },
          ]} />
        </Card>
        <p class="help">Tiers this period: {byTier.rows.map((x) => `${x.label}: ${fmtNum(x.value)}`).join(' · ') || '—'}</p>
      </Page>,
    );
  });

  // ───────── Deliverability ─────────
  dash.get('/analytics/deliverability', async (c) => {
    const pub = c.get('pub');
    const r = parseRange(c.req.query());
    const postId = c.req.query('post');
    const [d, sup, domains, posts] = await Promise.all([
      deliverability(c.env, pub.id, r), suppressionSummary(c.env, pub.id),
      all<any>(c.env, 'SELECT * FROM domains WHERE pub_id = ? ORDER BY kind, hostname', pub.id),
      all<any>(c.env, `SELECT id, title FROM posts WHERE pub_id = ? AND status = 'published' ORDER BY published_at DESC LIMIT 100`, pub.id),
    ]);
    const perPost = postId ? await postDeliverability(c.env, pub.id, postId) : null;
    const postTitle = posts.find((p) => p.id === postId)?.title;
    const BOUNCE_LABEL: Record<string, string> = { hard: 'Hard (address does not exist)', soft: 'Soft (temporary)', mailbox_full: 'Mailbox full', dns: 'DNS failure', policy: 'Policy / blocked', complaint: 'Complaint' };
    const ProviderTable = (p: { rows: any[] }) => (
      <Table rows={p.rows} empty="No deliveries yet." cols={[
        { h: 'Mailbox provider', r: (x) => <strong style="text-transform:capitalize">{x.provider}</strong> },
        { h: 'Sent', r: (x) => fmtNum(x.total), class: 'right' },
        { h: 'Delivered', r: (x) => fmtPct(x.total ? (x.delivered / x.total) * 100 : 0), class: 'right' },
        { h: 'Bounced', r: (x) => fmtNum(x.bounced), class: 'right' },
        { h: 'Complaints', r: (x) => <span class={x.delivered && x.complained / x.delivered > 0.003 ? 'kpi-d down' : ''}>{fmtPct(x.delivered ? (x.complained / x.delivered) * 100 : 0, 2)}</span>, class: 'right' },
        { h: 'Open rate', r: (x) => fmtPct(x.delivered ? (x.opened / x.delivered) * 100 : 0), class: 'right' },
      ]} />
    );
    return c.html(
      <Page c={c} title="Deliverability" sub="deliverability" actions={<LinkBtn href="/app/analytics/guardian" small>Guardian</LinkBtn>}>
        <div class="callout" style="margin-bottom:12px"><strong>Deliverability Guardian</strong> watches your sending every 10 minutes, slows things down when providers push back, and shows your health score, time to delivery, DMARC results and inbox placement tests. <a href="/app/analytics/guardian">Open the Guardian →</a></div>
        <RangeBar c={c} range={r} keep={['post']} />
        <Stats>
          <Stat label="Delivery rate" value={fmtPct(d.deliveryRate, 2)} sub={`${fmtNum(d.delivered)} of ${fmtNum(d.total)}`} tone={d.total && d.deliveryRate < 97 ? 'down' : 'up'} />
          <Stat label="Bounce rate" value={fmtPct(d.bounceRate, 2)} sub={`${fmtNum(d.bounced)} bounced`} tone={d.bounceRate > 2 ? 'down' : ''} />
          <Stat label="Complaint rate" value={fmtPct(d.complaintRate, 3)} sub="Gmail/Yahoo limit: 0.3%" tone={d.complaintRate > 0.3 ? 'down' : ''} />
          <Stat label="Suppressed (skipped)" value={fmtNum(d.suppressed)} />
          <Stat label="Deferred (retrying)" value={fmtNum(d.deferred)} sub="retried for up to 26h" />
        </Stats>
        {d.complaintRate > 0.3 && <div class="callout danger">Your complaint rate is above the 0.3% threshold Gmail and Yahoo enforce. Make unsubscribing easy, confirm new signups (double opt-in) and remove inactive readers.</div>}
        <Grid cols={2}>
          <Card title="Bounces by type"><Bars rows={Object.entries(d.bounces).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: BOUNCE_LABEL[k] || k, value: v }))} /></Card>
          <Card title="Suppression lists" pad={false}>
            <Table rows={sup} empty="Nobody is suppressed." cols={[{ h: 'Layer', r: (x) => <Badge tone={x.scope === 'global' ? 'red' : x.scope === 'pub' ? 'amber' : 'blue'}>{x.scope === 'pub' ? 'publication' : x.scope}</Badge> }, { h: 'Reason', r: (x) => x.reason.replace(/_/g, ' ') }, { h: 'Addresses', r: (x) => fmtNum(x.n), class: 'right' }, { h: 'Temporary', r: (x) => fmtNum(x.temporary), class: 'right' }]} />
          </Card>
        </Grid>
        <Card title="By mailbox provider (all sends in range)" pad={false}><ProviderTable rows={d.providers} /></Card>
        <Card title={postTitle ? `By mailbox provider: ${postTitle}` : 'By mailbox provider for one post'} actions={
          <form method="get" class="row"><input type="hidden" name="range" value={r.key} /><select class="input" name="post" data-autosubmit="1" style="width:260px"><option value="">Choose a post…</option>{posts.map((p) => <option value={p.id} selected={p.id === postId}>{p.title}</option>)}</select></form>
        } pad={false}>
          {perPost ? <ProviderTable rows={perPost} /> : <div class="table-empty">Pick a post to see how each inbox provider handled it.</div>}
        </Card>
        <Card title="Sending domains" actions={<LinkBtn href="/app/settings/domains" small>Manage domains</LinkBtn>} pad={false}>
          <Table rows={domains.filter((x) => x.kind === 'email')} empty="No custom sending domain yet — mail goes out from the platform default address. Add your own domain with DKIM, SPF and DMARC for best inbox placement." cols={[
            { h: 'Domain', r: (x) => <strong>{x.hostname}</strong> },
            { h: 'Status', r: (x) => <Status s={x.status} /> },
            { h: 'Warmup', r: (x) => { if (!x.warmup_started_at) return <span class="muted">not warming</span>; const day = Math.floor((now() - x.warmup_started_at) / 86400000); return day >= 12 ? <Badge tone="green">complete</Badge> : <span>day {day + 1} of 12 · cap {fmtNum(200 * 2 ** day)}/day</span>; } },
            { h: 'Blocklists', r: (x) => (x.blocklisted ? <Badge tone="red">listed — sending paused</Badge> : <Badge tone="green">clean</Badge>) },
            { h: 'Last checked', r: (x) => ago(x.last_checked_at) },
          ]} />
        </Card>
      </Page>,
    );
  });

  // ───────── Revenue ─────────
  dash.get('/analytics/revenue', async (c) => {
    const pub = c.get('pub');
    const r = parseRange(c.req.query(), '365d');
    const p = previous(r);
    const [k, kP] = await Promise.all([revenueKpis(c.env, pub.id, r), revenueKpis(c.env, pub.id, p)]);
    const KINDS = ['subscription', 'product', 'ticket', 'sponsorship', 'gift', 'group', 'replay'];
    const revGroup = r.to - r.from > 95 * 86400000 ? 'month' : 'time';
    const kindSeries = await Promise.all(KINDS.map((kind) => runReport(c.env, pub.id, { metric: 'revenue', group: revGroup, range: r, filters: [{ field: 'kind', op: 'eq', value: kind }] })));
    const b = kindSeries[0].bucket || 'month';
    const fmtB = b === 'month' ? '%Y-%m' : b === 'week' ? '%Y-W%W' : '%Y-%m-%d';
    const earnRows = await all<any>(c.env, `SELECT strftime('${fmtB}', created_at / 1000, 'unixepoch') AS k, kind, SUM(amount_cents) AS v FROM wallet_entries WHERE pub_id = ? AND created_at BETWEEN ? AND ? AND kind IN ('ad','boost','sponsorship') GROUP BY k, kind`, pub.id, r.from, r.to);
    const labelsKeys = kindSeries[0].rows.map((x) => x.key);
    const earnSeries = ['ad', 'boost'].map((kind) => ({ label: kind === 'ad' ? 'Ad network' : 'Boosts', values: labelsKeys.map((key) => Number(earnRows.find((e) => e.k === key && e.kind === kind)?.v) || 0) }));
    const activeKinds = KINDS.map((kind, i) => ({ kind, s: kindSeries[i] })).filter((x) => x.s.total > 0);
    const NAMES: Record<string, string> = { subscription: 'Paid subscriptions', product: 'Digital products', ticket: 'Event tickets', sponsorship: 'Sponsorships', gift: 'Gift subscriptions', group: 'Group subscriptions', replay: 'Replays' };
    const recent = await all<any>(c.env, `SELECT kind, amount_cents, status, note, created_at FROM wallet_entries WHERE pub_id = ? ORDER BY created_at DESC LIMIT 10`, pub.id);
    const byTier = await all<any>(c.env, `SELECT t.name, COUNT(*) AS n, SUM(CASE WHEN s.interval = 'year' THEN s.amount_cents / 12.0 ELSE s.amount_cents END) AS mrr FROM subscriptions s JOIN tiers t ON t.id = s.tier_id WHERE s.pub_id = ? AND s.status IN ('active','past_due') GROUP BY t.name ORDER BY mrr DESC`, pub.id);
    const [pred, topClv, atRisk] = await Promise.all([predictionSummary(c.env, pub.id), topSubscribers(c.env, pub.id, { sort: 'clv', limit: 8 }), topSubscribers(c.env, pub.id, { sort: 'churn', limit: 8 })]);
    return c.html(
      <Page c={c} title="Revenue" sub="revenue">
        <RangeBar c={c} range={r} />
        <StoreRevenueCard c={c} from={r.from} to={r.to} />
        <div class="stats kpis6">
          <Kpi label="Revenue" cur={k.revenue} prev={kP.revenue} fmt={fmtUsd} />
          <Kpi label="MRR" cur={k.mrr} fmt={fmtUsd} sub={<span class="muted">ARR {fmtUsd(k.arr)}</span>} />
          <Kpi label="Paid subscribers" cur={k.paidSubscribers} />
          <Kpi label="New paid" cur={k.newPaid} prev={kP.newPaid} />
          <Kpi label="Churn rate" cur={k.churnRate} prev={kP.churnRate} fmt={fmtPct} invert points sub={undefined} />
          <Kpi label="Ad & boost earnings" cur={k.earnings} prev={kP.earnings} fmt={fmtUsd} />
        </div>
        <p class="help">OpenHive takes 0% platform fees — every number here is yours (minus Stripe processing).</p>
        <Card title="Revenue by source">
          {activeKinds.length ? <LineChart labels={kindSeries[0].rows.map((x) => x.label)} series={activeKinds.map((x) => ({ label: NAMES[x.kind], values: x.s.rows.map((y) => y.value) }))} fmt={usdAxis} /> : <div class="table-empty">No paid orders in this period.</div>}
        </Card>
        <Grid cols={2}>
          <Card title="Revenue split"><Bars rows={k.byKind.map((x) => ({ label: NAMES[x.kind] || x.kind, value: Number(x.v) }))} fmt={fmtUsd} /></Card>
          <Card title="MRR by tier"><Bars rows={byTier.map((x) => ({ label: `${x.name} (${x.n})`, value: Math.round(x.mrr) }))} fmt={fmtUsd} /></Card>
        </Grid>
        <h3 style="margin-top:8px" id="predictions">Lifetime value &amp; predictions</h3>
        <p class="help">Customer lifetime value = revenue so far + predicted future revenue (monthly value × expected remaining months, adjusted for churn risk). Expected subscription length here is {pred.expectedTenure.toFixed(1)} months from your {fmtPct(pred.monthlyChurn * 100)} monthly churn (capped at {MAX_TENURE_MONTHS}). {pred.computedAt ? `Recomputed ${ago(pred.computedAt)}.` : 'Scores are computed in the background every few hours.'} <a href="/app/audience/top">How scores work →</a></p>
        <div class="stats kpis4" data-predictions>
          <Stat label="Avg customer lifetime value" value={fmtUsd(pred.avgClv)} sub={`${fmtNum(pred.customers)} paying readers`} />
          <Stat label="Predicted future revenue" value={fmtUsd(pred.predicted)} sub={`on top of ${fmtUsd(pred.historical)} earned`} />
          <Stat label="Likely buyers" value={fmtNum(pred.purchase.highNonBuyers)} sub="high purchase likelihood, never bought" href="/app/audience/top?sort=purchase" />
          <Stat label="MRR at high churn risk" value={fmtUsd(pred.churn.mrrAtRisk)} sub={`${fmtNum(pred.churn.high)} high · ${fmtNum(pred.churn.medium)} medium risk`} tone={pred.churn.high ? 'down' : ''} href="/app/audience/top?sort=churn" />
        </div>
        <Grid cols={2}>
          <Card title="Highest lifetime value" pad={false}>
            <Table rows={topClv.filter((x) => x.clv_cents > 0)} empty="No paying readers yet." cols={[
              { h: 'Subscriber', r: (x) => <a href={`/app/audience/s/${x.id}`}>{x.name || x.email}</a> },
              { h: 'Earned', r: (x) => fmtUsd(x.revenue_cents), class: 'right' },
              { h: 'Predicted', r: (x) => fmtUsd(x.predicted_cents), class: 'right' },
              { h: 'CLV', r: (x) => <strong>{fmtUsd(x.clv_cents)}</strong>, class: 'right' },
            ]} />
          </Card>
          <Card title="Paid subscribers most likely to churn" pad={false}>
            <Table rows={atRisk.filter((x) => x.churn_risk && x.churn_risk !== 'low')} empty="No paid subscribers at risk right now." cols={[
              { h: 'Subscriber', r: (x) => <a href={`/app/audience/s/${x.id}`}>{x.name || x.email}</a> },
              { h: 'Risk', r: (x) => <Badge tone={x.churn_risk === 'high' ? 'red' : 'amber'}>{x.churn_risk} · {x.churn_score}</Badge> },
              { h: 'Monthly value', r: (x) => fmtUsd(x.monthly_value_cents), class: 'right' },
            ]} />
          </Card>
        </Grid>
        <Card title="Earnings report (ad network & boosts)">
          <LineChart labels={kindSeries[0].rows.map((x) => x.label)} series={earnSeries} fmt={usdAxis} />
        </Card>
        <Card title="Recent wallet activity" actions={<LinkBtn href="/app/monetize/wallet" small>Wallet & payouts</LinkBtn>} pad={false}>
          <Table rows={recent} empty="No earnings yet." cols={[{ h: 'Date', r: (x) => fmtDate(x.created_at) }, { h: 'Type', r: (x) => <Badge>{x.kind}</Badge> }, { h: 'Note', r: (x) => x.note }, { h: 'Status', r: (x) => <Status s={x.status} /> }, { h: 'Amount', r: (x) => <span class={x.amount_cents < 0 ? 'kpi-d down' : ''}>{fmtUsd(x.amount_cents)}</span>, class: 'right' }]} />
        </Card>
      </Page>,
    );
  });

  // ───────── Podcasts ─────────
  dash.get('/analytics/podcasts', async (c) => {
    const pub = c.get('pub');
    const r = parseRange(c.req.query(), '90d');
    const [k, kP, dl, ls, pv, byApp, byDevice, byCountry, eps] = await Promise.all([
      podcastKpis(c.env, pub.id, r), podcastKpis(c.env, pub.id, previous(r)),
      runReport(c.env, pub.id, { metric: 'downloads', group: 'time', range: r }), runReport(c.env, pub.id, { metric: 'listeners', group: 'time', range: r }),
      runReport(c.env, pub.id, { metric: 'page_views', group: 'time', range: r }),
      runReport(c.env, pub.id, { metric: 'downloads', group: 'app', range: r }), runReport(c.env, pub.id, { metric: 'downloads', group: 'device', range: r }), runReport(c.env, pub.id, { metric: 'downloads', group: 'country', range: r, limit: 10 }),
      all<any>(c.env, `SELECT e.id, e.title, e.published_at, p.title AS show, SUM(CASE WHEN d.is_bot = 0 THEN 1 ELSE 0 END) AS downloads, COUNT(DISTINCT CASE WHEN d.is_bot = 0 THEN d.listener_hash END) AS listeners, SUM(d.is_bot) AS bots
        FROM episodes e JOIN podcasts p ON p.id = e.podcast_id LEFT JOIN episode_downloads d ON d.episode_id = e.id AND d.created_at BETWEEN ? AND ?
        WHERE e.pub_id = ? GROUP BY e.id ORDER BY e.published_at DESC LIMIT 50`, r.from, r.to, pub.id),
    ]);
    return c.html(
      <Page c={c} title="Podcast analytics" sub="podcasts" actions={<LinkBtn href="/app/podcasts" small>Manage shows</LinkBtn>}>
        <RangeBar c={c} range={r} />
        <Stats>
          <Kpi label="Downloads" cur={k.downloads} prev={kP.downloads} sub={<span class="muted">IAB-style, bot-filtered</span>} />
          <Kpi label="Unique listeners" cur={k.listeners} prev={kP.listeners} />
          <Kpi label="Bot downloads filtered" cur={k.botDownloads} />
        </Stats>
        <Card title="Downloads alongside website traffic">
          <LineChart labels={dl.rows.map((x) => x.label)} series={[{ label: 'Downloads', values: dl.rows.map((x) => x.value), color: '#8b5cf6' }, { label: 'Unique listeners', values: ls.rows.map((x) => x.value) }, { label: 'Site page views', values: pv.rows.map((x) => x.value), color: '#3b82f6' }]} />
        </Card>
        <Grid cols={3}>
          <Card title="Apps"><Bars rows={byApp.rows.map((x) => ({ label: x.label, value: x.value }))} /></Card>
          <Card title="Devices"><Bars rows={byDevice.rows.map((x) => ({ label: x.label, value: x.value }))} /></Card>
          <Card title="Countries"><Bars rows={byCountry.rows.map((x) => ({ label: x.label, value: x.value }))} /></Card>
        </Grid>
        <Card title="Episodes" pad={false}>
          <Table rows={eps} empty={<Empty title="No episodes yet" body="Upload your first episode to start tracking downloads." action={<LinkBtn href="/app/podcasts" kind="primary">Go to podcasts</LinkBtn>} />} cols={[
            { h: 'Episode', r: (x) => <strong>{x.title}</strong> }, { h: 'Show', r: (x) => x.show }, { h: 'Published', r: (x) => fmtDate(x.published_at) },
            { h: 'Downloads', r: (x) => fmtNum(x.downloads || 0), class: 'right' }, { h: 'Unique listeners', r: (x) => fmtNum(x.listeners || 0), class: 'right' }, { h: 'Bots filtered', r: (x) => fmtNum(x.bots || 0), class: 'right' },
          ]} />
        </Card>
      </Page>,
    );
  });

  // ───────── Custom reports (+ comparative: two periods or two segments side by side) ─────────
  dash.get('/analytics/reports', async (c) => {
    const redirect = normalizeChipQuery(c);
    if (redirect) return c.redirect(redirect);
    const pub = c.get('pub');
    const q = c.req.query();
    const metric = METRICS[q.metric || ''] ? q.metric! : 'page_views';
    const dimKeys = dimsFor(metric).map(([k]) => k);
    const groupQ = q.group || 'time';
    const group = ['time', 'day', 'week', 'month', ...dimKeys].includes(groupQ) ? groupQ : 'time';
    const r = parseRange(q);
    const filters = parseFilters(c, metric);
    const timeGroups = ['time', 'day', 'week', 'month'];
    const isTime = timeGroups.includes(group);
    const segmentable = !!SEGMENT_SUBJECT[metric];
    const cmp = ['prev', 'yoy', 'custom', 'segments'].includes(q.cmp || '') ? q.cmp! : '';
    const segments = await all<{ id: string; name: string }>(c.env, 'SELECT id, name FROM segments WHERE pub_id = ? ORDER BY name', pub.id);
    const segName = (sid: string) => (sid ? segments.find((s) => s.id === sid)?.name || 'Segment' : 'All subscribers');
    const segFilter = async (sid: string | undefined) => (sid && segments.some((s) => s.id === sid) ? compile(c.env, pub.id, segmentGroup(sid)) : null);

    // A = the main report. With segment comparison, A and B are the two segments over the same range.
    const useSegs = cmp === 'segments' && segmentable;
    const report = await runReport(c.env, pub.id, { metric, group, range: r, filters, limit: 50, segment: useSegs ? await segFilter(q.sa) : null });
    let rangeB: Range | null = null;
    if (cmp === 'prev') rangeB = previous(r);
    else if (cmp === 'yoy') rangeB = yearAgo(r);
    else if (cmp === 'custom') { const x = parseRange({ from: q.from2, to: q.to2 }); rangeB = x.key === 'custom' ? { ...x, label: `${q.from2} → ${q.to2}` } : null; }
    // time buckets must match: compare with the same bucket size as A
    const groupB = isTime && group === 'time' ? (report.bucket || 'day') : group;
    const reportB = useSegs ? await runReport(c.env, pub.id, { metric, group, range: r, filters, limit: 50, segment: await segFilter(q.sb) })
      : rangeB ? await runReport(c.env, pub.id, { metric, group: groupB, range: rangeB, filters, limit: 50 }) : null;
    const labelA = useSegs ? segName(q.sa || '') : r.label;
    const labelB = useSegs ? segName(q.sb || '') : rangeB?.label || '';
    const cmpd = reportB ? compareReports(report, reportB, isTime) : null;

    const fmtV = (n: number) => (report.money ? fmtUsd(n) : fmtNum(n));
    const money = (n: number) => (report.money ? (n / 100).toFixed(2) : n);
    if (q.format === 'csv') {
      if (cmpd) return csv(c, `report-${metric}-${group}-compare`, [[group, labelA, labelB, 'Change %'], ...cmpd.rows.map((x) => [x.key, money(x.a), money(x.b), x.change === null ? '' : x.change.toFixed(1)]), ['Total', money(cmpd.totalA), money(cmpd.totalB), cmpd.change === null ? '' : cmpd.change.toFixed(1)]]);
      return csv(c, `report-${metric}-${group}`, [[group, report.label], ...report.rows.map((x) => [x.key, money(x.value)])]);
    }
    const saved = await all<any>(c.env, 'SELECT * FROM saved_reports WHERE pub_id = ? ORDER BY created_at DESC', pub.id);
    const savedHref = (cfg: any) => {
      if (cfg.type === 'pivot') {
        const p = new URLSearchParams({ metric: cfg.metric, range: cfg.range || '30d' });
        (cfg.dims || []).forEach((d: string, i: number) => p.set('d' + (i + 1), d));
        for (const f of cfg.filters || []) p.append('f', `${f.field}:${f.op}:${f.value}`);
        return '/app/analytics/explore?' + p.toString();
      }
      const u = new URLSearchParams();
      u.set('metric', cfg.metric); u.set('group', cfg.group);
      if (cfg.range === 'custom' && cfg.from && cfg.to) { u.set('from', cfg.from); u.set('to', cfg.to); } else if (cfg.range) u.set('range', cfg.range);
      for (const f of cfg.filters || []) u.append('f', `${f.field}:${f.op}:${f.value}`);
      if (cfg.compare?.mode) {
        u.set('cmp', cfg.compare.mode);
        for (const k of ['from2', 'to2', 'sa', 'sb']) if (cfg.compare[k]) u.set(k, cfg.compare[k]);
      }
      return '/app/analytics/reports?' + u.toString();
    };
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const config = {
      metric, group, range: r.key, filters,
      ...(r.key === 'custom' ? { from: iso(r.from), to: iso(r.to) } : {}),
      ...(cmp ? { compare: { mode: cmp, ...(cmp === 'custom' ? { from2: q.from2, to2: q.to2 } : {}), ...(cmp === 'segments' ? { sa: q.sa || '', sb: q.sb || '' } : {}) } } : {}),
    };
    const describe = (cfg: any) => [METRICS[cfg.metric]?.label, cfg.compare?.mode === 'segments' ? 'segment vs segment' : cfg.compare?.mode ? 'vs ' + ({ prev: 'previous period', yoy: 'last year', custom: 'another period' } as any)[cfg.compare.mode] : ''].filter(Boolean).join(' · ');
    const chg = (d: number | null) => (d === null ? <span class="muted">new</span> : <span class={`cmp-d ${Math.abs(d) < 0.05 ? '' : d > 0 ? 'up' : 'down'}`}>{d > 0 ? '▲' : d < 0 ? '▼' : '•'} {Math.abs(d).toFixed(1)}%</span>);
    const keepF = (c.req.queries('f') || []).map((x) => <input type="hidden" name="f" value={x} />);
    const dimLabel = isTime ? 'Period' : dimsFor(metric).find(([k]) => k === group)?.[1] || group;
    return c.html(
      <Page c={c} title="Custom reports" sub="reports" actions={<LinkBtn href={qsWith(c, { format: 'csv' })} small>Export CSV</LinkBtn>}>
        <div class="split">
          <div>
            <Card title="Build a report">
              <form method="get" class="row" data-report-form>
                {keepF}
                <label class="field" style="margin:0"><span class="field-l">Metric</span>
                  <select class="input" name="metric" data-autosubmit="1">{Object.entries(METRICS).map(([k, d]) => <option value={k} selected={k === metric}>{d.label}</option>)}</select>
                </label>
                <label class="field" style="margin:0"><span class="field-l">Group by</span>
                  <select class="input" name="group" data-autosubmit="1">
                    <optgroup label="Time"><option value="time" selected={group === 'time'}>Auto</option><option value="day" selected={group === 'day'}>Day</option><option value="week" selected={group === 'week'}>Week</option><option value="month" selected={group === 'month'}>Month</option></optgroup>
                    <optgroup label="Dimension">{dimsFor(metric).map(([k, l]) => <option value={k} selected={k === group}>{l}</option>)}</optgroup>
                  </select>
                </label>
                <label class="field" style="margin:0"><span class="field-l">Range</span>
                  <select class="input" name="range" data-autosubmit="1">{[['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['365d', 'Last 12 months'], ['ytd', 'Year to date'], ['all', 'All time']].map(([k, l]) => <option value={k} selected={r.key === k}>{l}</option>)}{r.key === 'custom' && <option value="custom" selected>{r.label}</option>}</select>
                </label>
                {r.key === 'custom' && <><input type="hidden" name="from" value={iso(r.from)} /><input type="hidden" name="to" value={iso(r.to)} /></>}
                <label class="field" style="margin:0"><span class="field-l">Compare with</span>
                  <select class="input" name="cmp" data-autosubmit="1">
                    <option value="" selected={!cmp}>Nothing</option>
                    <option value="prev" selected={cmp === 'prev'}>Previous period</option>
                    <option value="yoy" selected={cmp === 'yoy'}>Same period last year</option>
                    <option value="custom" selected={cmp === 'custom'}>Another period…</option>
                    {segmentable && <option value="segments" selected={cmp === 'segments'}>Two segments…</option>}
                  </select>
                </label>
                {cmp === 'custom' && <>
                  <label class="field" style="margin:0"><span class="field-l">From</span><input class="input" type="date" name="from2" value={q.from2 || iso(previous(r).from)} /></label>
                  <label class="field" style="margin:0"><span class="field-l">To</span><input class="input" type="date" name="to2" value={q.to2 || iso(previous(r).to)} /></label>
                  <div class="field" style="margin:0"><span class="field-l">&nbsp;</span><Btn small kind="secondary">Compare</Btn></div>
                </>}
                {cmp === 'segments' && segmentable && <>
                  <label class="field" style="margin:0"><span class="field-l">Segment A</span><select class="input" name="sa" data-autosubmit="1"><option value="">All subscribers</option>{segments.map((s) => <option value={s.id} selected={s.id === q.sa}>{s.name}</option>)}</select></label>
                  <label class="field" style="margin:0"><span class="field-l">Segment B</span><select class="input" name="sb" data-autosubmit="1"><option value="">All subscribers</option>{segments.map((s) => <option value={s.id} selected={s.id === q.sb}>{s.name}</option>)}</select></label>
                </>}
              </form>
              {cmp === 'segments' && !segmentable && <p class="help">This metric isn't tied to subscribers, so it can't be split by segment.</p>}
              <div style="margin-top:12px"><FilterChips c={c} metric={metric} filters={filters} /></div>
            </Card>
            {cmpd ? <>
              <Card title={`${report.label}: ${labelA} vs ${labelB}`} actions={<span data-compare-total><strong>{fmtV(cmpd.totalA)}</strong> <span class="muted">vs</span> <strong>{fmtV(cmpd.totalB)}</strong> {chg(cmpd.change)}</span>}>
                {isTime
                  ? <LineChart labels={report.rows.map((x) => x.label)} series={[{ label: labelA, values: cmpd.rows.map((x) => x.a) }, { label: labelB, values: cmpd.rows.map((x) => x.b), color: '#94a3b8' }]} fmt={report.money ? usdAxis : undefined} />
                  : <Grid cols={2}>
                    <div><h4>{labelA}</h4><Bars rows={cmpd.rows.slice(0, 15).map((x) => ({ label: x.label, value: x.a }))} fmt={fmtV} /></div>
                    <div><h4>{labelB}</h4><Bars rows={cmpd.rows.slice(0, 15).map((x) => ({ label: x.label, value: x.b }))} fmt={fmtV} /></div>
                  </Grid>}
              </Card>
              <Card title="Side by side" pad={false}>
                <Table class="cmp-table" rows={isTime ? [...cmpd.rows].reverse() : cmpd.rows} cols={[
                  { h: isTime ? `Period (${labelA})` : dimLabel, r: (x) => x.key },
                  { h: labelA, r: (x) => fmtV(x.a), class: 'right' },
                  { h: labelB, r: (x) => fmtV(x.b), class: 'right' },
                  { h: 'Change', r: (x) => chg(x.change), class: 'right' },
                ]} />
              </Card>
            </> : <>
              <Card title={`${report.label} · ${r.label}`} actions={<strong>{fmtV(report.total)}</strong>}>
                {isTime
                  ? <LineChart labels={report.rows.map((x) => x.label)} series={[{ label: report.label, values: report.rows.map((x) => x.value) }]} fmt={report.money ? usdAxis : undefined} />
                  : <Bars rows={report.rows.map((x) => ({ label: x.label, value: x.value, sub: report.total && !['visitors', 'listeners'].includes(metric) ? fmtPct((x.value / report.total) * 100, 0) : '' }))} fmt={fmtV} />}
              </Card>
              <Card title="Data" pad={false}>
                <Table rows={isTime ? [...report.rows].reverse() : report.rows} cols={[{ h: dimLabel, r: (x) => x.key }, { h: report.label, r: (x) => fmtV(x.value), class: 'right' }]} />
              </Card>
            </>}
          </div>
          <div>
            <Card title="Save this report">
              <form method="post" action="/app/analytics/reports">
                <input type="hidden" name="config" value={JSON.stringify(config)} />
                <Field label="Name"><Input name="name" placeholder={cmp ? 'e.g. Signups vs last year' : 'e.g. Mobile traffic from X'} required /></Field>
                <Btn small>Save report</Btn>
              </form>
              <p class="help" style="margin:8px 0 0">Saves the metric, grouping, filters, range{cmp ? ' and comparison' : ''}.</p>
            </Card>
            <Card title="Saved reports" pad={false}>
              <Table rows={saved} empty="No saved reports yet." cols={[
                { h: 'Report', r: (x) => { const cfg = parseJSON<any>(x.config, {}); return <span><a href={savedHref(cfg)}>{x.name}</a><div class="muted small">{describe(cfg)}</div></span>; } },
                { h: '', r: (x) => <form method="post" action={`/app/analytics/reports/${x.id}/delete`} class="inline-form"><button class="btn btn-ghost btn-sm" data-confirm="Delete this saved report?">✕</button></form>, class: 'right' },
              ]} />
            </Card>
          </div>
        </div>
      </Page>,
    );
  });

  dash.post('/analytics/reports', async (c) => {
    const f = await form(c.req);
    const cfg = parseJSON<any>(f.config, null);
    if (!cfg || !METRICS[cfg.metric]) return back(c, '/app/analytics/reports', 'Invalid report', 'err');
    await insert(c.env, 'saved_reports', { id: id(), pub_id: c.get('pub').id, name: str(f.name, 120) || 'Untitled report', config: JSON.stringify(cfg), created_by: c.get('user').id, created_at: now() });
    return back(c, '/app/analytics/reports' + (c.req.header('referer')?.includes('?') ? '?' + c.req.header('referer')!.split('?')[1] : ''), 'Report saved');
  });

  dash.post('/analytics/reports/:id/delete', async (c) => {
    await run(c.env, 'DELETE FROM saved_reports WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
    return back(c, '/app/analytics/reports', 'Report deleted');
  });
}

export { esc };
