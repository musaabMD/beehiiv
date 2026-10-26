/** @jsxImportSource hono/jsx */
// Module: calendar — a marketing calendar (month / week) of everything scheduled or sent: newsletter posts,
// automation activity, social posts, events, sponsor placements, podcast episodes and campaigns. Scheduled posts
// and social posts can be dragged to another day; newsletter posts are rescheduled through the posts module's own
// schedule route (POST /app/posts/:id/publish {mode:'schedule'}) after a plan + sending-safety check here.
import { Hono } from 'hono';
import type { AppEnv, Ctx, Module } from '../types';
import { one, all } from '../lib/db';
import { requirePerm, can } from '../lib/auth';
import { checkSend, nextMonthStart } from '../lib/plans';
import { countPostRecipients } from '../lib/sender';
import { rescheduleSocialPost } from '../lib/social';
import { zonedToUtc, utcToZoned, tzLabel } from '../lib/tz';
import { now, str, truncate, DAY } from '../lib/util';
import { kick } from '../lib/jobs';
import { DashLayout } from '../ui/layout';
import { Card, LinkBtn, Badge } from '../ui/components';
import type { Post } from '../types';

const dash = new Hono<AppEnv>();

export const KINDS: Record<string, { label: string; color: string }> = {
  post: { label: 'Newsletter posts', color: '#d97706' },
  social: { label: 'Social posts', color: '#2563eb' },
  automation: { label: 'Automations', color: '#7c3aed' },
  event: { label: 'Events & webinars', color: '#059669' },
  sponsor: { label: 'Sponsor placements', color: '#db2777' },
  podcast: { label: 'Podcast episodes', color: '#0891b2' },
  campaign: { label: 'Campaigns', color: '#4b5563' },
};

export interface CalItem { kind: string; id: string; title: string; at: number; status: string; href: string; drag: boolean; sub?: string }

const ymd = (t: number, tz: string) => utcToZoned(t, tz).slice(0, 10);
function addDays(d: string, n: number): string {
  const t = Date.parse(d + 'T00:00:00Z') + n * DAY;
  return new Date(t).toISOString().slice(0, 10);
}
const dow = (d: string) => new Date(d + 'T00:00:00Z').getUTCDay(); // 0 = Sunday

/** Everything on the calendar between two instants. */
export async function calendarItems(c: Ctx, from: number, to: number, kinds: Set<string>): Promise<CalItem[]> {
  const env = c.env;
  const pub = c.get('pub');
  const canPublish = can(c.get('role'), 'publish');
  const out: CalItem[] = [];
  if (kinds.has('post')) {
    const rows = await all<any>(env, `SELECT id, title, status, platform, scheduled_at, published_at FROM posts WHERE pub_id = ? AND ((status = 'scheduled' AND scheduled_at >= ? AND scheduled_at < ?) OR (status = 'published' AND published_at >= ? AND published_at < ?))`, pub.id, from, to, from, to);
    for (const p of rows) {
      const sched = p.status === 'scheduled';
      out.push({ kind: 'post', id: p.id, title: p.title || 'Untitled', at: sched ? p.scheduled_at : p.published_at, status: sched ? 'scheduled' : p.platform === 'web' ? 'published' : 'sent', href: sched ? `/app/posts/${p.id}/edit` : `/app/posts/${p.id}`, drag: sched && canPublish });
    }
  }
  if (kinds.has('social')) {
    const rows = await all<any>(env, `SELECT sp.id, sp.text, sp.network, sp.status, sp.scheduled_at, sp.posted_at, sp.remote_url, a.handle FROM social_posts sp LEFT JOIN social_accounts a ON a.id = sp.account_id WHERE sp.pub_id = ? AND sp.status IN ('scheduled','posting','posted','failed') AND COALESCE(sp.posted_at, sp.scheduled_at) >= ? AND COALESCE(sp.posted_at, sp.scheduled_at) < ?`, pub.id, from, to);
    for (const s of rows) out.push({ kind: 'social', id: s.id, title: truncate(s.text || s.network, 60), at: s.posted_at || s.scheduled_at, status: s.status, href: s.remote_url || '/app/social', drag: s.status === 'scheduled' && canPublish, sub: `${s.network} ${s.handle || ''}` });
  }
  if (kinds.has('automation')) {
    // automation emails, bucketed by hour then shown as one entry per automation per day
    const rows = await all<any>(env, `SELECT s.automation_id, a.name, CAST(s.created_at / 3600000 AS INTEGER) AS h, COUNT(*) AS n FROM sends s JOIN automations a ON a.id = s.automation_id WHERE s.pub_id = ? AND s.kind = 'automation' AND s.created_at >= ? AND s.created_at < ? GROUP BY s.automation_id, h`, pub.id, from, to);
    const byDay = new Map<string, CalItem>();
    for (const r of rows) {
      const t = r.h * 3600000;
      const k = `${r.automation_id}:${ymd(t, pub.timezone)}`;
      const e = byDay.get(k);
      if (e) { e.sub = String(Number(e.sub) + r.n); continue; }
      byDay.set(k, { kind: 'automation', id: r.automation_id, title: r.name, at: t, status: 'sent', href: `/app/automations/${r.automation_id}`, drag: false, sub: String(r.n) });
    }
    for (const e of byDay.values()) { e.title = `${e.title} · ${e.sub} email${e.sub === '1' ? '' : 's'}`; e.sub = undefined; out.push(e); }
  }
  if (kinds.has('event')) {
    const rows = await all<any>(env, `SELECT id, title, kind, starts_at, stream_status, status FROM live_events WHERE pub_id = ? AND starts_at >= ? AND starts_at < ? AND status != 'deleted'`, pub.id, from, to);
    for (const e of rows) out.push({ kind: 'event', id: e.id, title: e.title, at: e.starts_at, status: e.starts_at > now() ? 'scheduled' : e.stream_status === 'live' ? 'live' : 'done', href: `/app/events/${e.id}`, drag: false, sub: e.kind });
  }
  if (kinds.has('sponsor')) {
    const rows = await all<any>(env, `SELECT o.id, o.status, o.scheduled_for, c.name, a.name AS advertiser FROM ad_opportunities o JOIN ad_campaigns c ON c.id = o.campaign_id LEFT JOIN advertisers a ON a.id = c.advertiser_id WHERE o.pub_id = ? AND o.scheduled_for >= ? AND o.scheduled_for < ? AND o.status IN ('accepted','placed','completed')`, pub.id, from, to);
    for (const s of rows) out.push({ kind: 'sponsor', id: s.id, title: `${s.advertiser || s.name}`, at: s.scheduled_for, status: s.status, href: '/app/monetize/sponsorships', drag: false, sub: s.name });
  }
  if (kinds.has('podcast')) {
    const rows = await all<any>(env, `SELECT e.id, e.title, e.status, e.published_at, e.podcast_id FROM episodes e WHERE e.pub_id = ? AND e.status IN ('scheduled','published') AND e.published_at >= ? AND e.published_at < ?`, pub.id, from, to);
    for (const e of rows) out.push({ kind: 'podcast', id: e.id, title: e.title, at: e.published_at, status: e.status, href: `/app/podcasts/${e.podcast_id}`, drag: false });
  }
  if (kinds.has('campaign')) {
    const rows = await all<any>(env, `SELECT id, name, starts_at, ends_at FROM campaigns WHERE pub_id = ? AND status = 'active' AND ((starts_at >= ? AND starts_at < ?) OR (ends_at >= ? AND ends_at < ?))`, pub.id, from, to, from, to);
    for (const k of rows) {
      if (k.starts_at >= from && k.starts_at < to) out.push({ kind: 'campaign', id: k.id, title: `▶ ${k.name} starts`, at: k.starts_at, status: 'campaign', href: `/app/campaigns/${k.id}`, drag: false });
      if (k.ends_at && k.ends_at >= from && k.ends_at < to) out.push({ kind: 'campaign', id: k.id, title: `■ ${k.name} ends`, at: k.ends_at, status: 'campaign', href: `/app/campaigns/${k.id}`, drag: false });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

dash.get('/', requirePerm('manage'), async (c) => {
  const pub = c.get('pub');
  const tz = pub.timezone || 'UTC';
  const view = c.req.query('view') === 'week' ? 'week' : 'month';
  const today = ymd(now(), tz);
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('date') || '') ? c.req.query('date')! : today;
  const qTypes = c.req.queries('types') || c.req.queries('types[]');
  const kinds = new Set(qTypes && qTypes.length ? qTypes.filter((k) => KINDS[k]) : Object.keys(KINDS));
  let start: string, days: number, prev: string, next: string, label: string;
  if (view === 'month') {
    const first = anchor.slice(0, 8) + '01';
    start = addDays(first, -dow(first));
    const nextFirst = new Date(Date.UTC(+first.slice(0, 4), +first.slice(5, 7), 1)).toISOString().slice(0, 10);
    const last = addDays(nextFirst, -1);
    days = Math.round((Date.parse(addDays(last, 6 - dow(last))) - Date.parse(start)) / DAY) + 1;
    prev = new Date(Date.UTC(+first.slice(0, 4), +first.slice(5, 7) - 2, 1)).toISOString().slice(0, 10);
    next = nextFirst;
    label = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(first + 'T12:00:00Z'));
  } else {
    start = addDays(anchor, -dow(anchor));
    days = 7;
    prev = addDays(start, -7);
    next = addDays(start, 7);
    const fmt = (d: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(d + 'T12:00:00Z'));
    label = `${fmt(start)} – ${fmt(addDays(start, 6))}, ${start.slice(0, 4)}`;
  }
  const from = zonedToUtc(start + 'T00:00', tz)!;
  const to = zonedToUtc(addDays(start, days) + 'T00:00', tz)!;
  const items = await calendarItems(c, from, to, kinds);
  const byDay = new Map<string, CalItem[]>();
  for (const it of items) { const d = ymd(it.at, tz); (byDay.get(d) || byDay.set(d, []).get(d)!).push(it); }
  const month = anchor.slice(0, 7);
  const typesQs = qTypes && qTypes.length ? qTypes.map((k) => `&types=${encodeURIComponent(k)}`).join('') : '';
  const link = (d: string, v = view) => `/app/calendar?view=${v}&date=${d}${typesQs}`;
  const time = (t: number) => utcToZoned(t, tz).slice(11, 16);
  const cells = Array.from({ length: days }, (_, i) => addDays(start, i));
  return c.html(
    <DashLayout c={c} title="Marketing calendar" section="marketing" sub="calendar" wide actions={<div class="row"><LinkBtn href="/app/posts/new" small>+ Post</LinkBtn><LinkBtn href="/app/social/new" small>+ Social post</LinkBtn><LinkBtn href="/app/campaigns" small kind="primary">Campaigns</LinkBtn></div>}>
      <div class="cal-bar">
        <div class="row">
          <a class="btn btn-secondary btn-sm" href={link(prev)} aria-label="Previous">‹</a>
          <a class="btn btn-secondary btn-sm" href={link(today)}>Today</a>
          <a class="btn btn-secondary btn-sm" href={link(next)} aria-label="Next">›</a>
          <h2 class="cal-title" data-cal-label>{label}</h2>
        </div>
        <div class="row">
          <div class="seg"><a href={link(anchor, 'month')} class={view === 'month' ? 'on' : ''}>Month</a><a href={link(anchor, 'week')} class={view === 'week' ? 'on' : ''}>Week</a></div>
        </div>
      </div>
      <form method="get" class="cal-filters" id="cal-filters">
        <input type="hidden" name="view" value={view} /><input type="hidden" name="date" value={anchor} />
        {Object.entries(KINDS).map(([k, v]) => (
          <label class="cal-filter"><input type="checkbox" name="types" value={k} checked={kinds.has(k)} data-autosubmit /><span class="cal-dot" style={`background:${v.color}`} />{v.label}</label>
        ))}
      </form>
      <p class="small muted">Times in {tzLabel(tz)}. Drag a scheduled post or social post to another day to reschedule it (same time of day).</p>
      <div class={`cal cal-${view}`} id="cal" data-tz={tz}>
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div class="cal-h">{d}</div>)}
        {cells.map((d) => {
          const list = byDay.get(d) || [];
          const out = view === 'month' && d.slice(0, 7) !== month;
          return (
            <div class={`cal-day ${out ? 'out' : ''} ${d === today ? 'today' : ''} ${list.length ? '' : 'empty'}`} data-date={d} data-past={d < today ? '1' : '0'}>
              <div class="cal-n"><span class="cal-wd">{new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(new Date(d + 'T12:00:00Z'))} </span>{+d.slice(8)}</div>
              {list.map((it) => (
                <a class={`cal-item k-${it.kind} s-${it.status}`} href={it.href} target={it.href.startsWith('http') ? '_blank' : undefined} style={`--k:${KINDS[it.kind].color}`} draggable={it.drag ? 'true' : undefined} data-kind={it.kind} data-id={it.id} data-drag={it.drag ? '1' : undefined} title={`${KINDS[it.kind].label}: ${it.title} (${it.status})${it.sub ? ' · ' + it.sub : ''}`}>
                  <span class="cal-t">{time(it.at)}</span> {it.title}{it.status === 'failed' && ' ⚠'}
                </a>
              ))}
            </div>
          );
        })}
      </div>
      {!items.length && <Card><p class="muted center" style="margin:0">Nothing scheduled or sent in this period. <a href="/app/posts/new">Write a post</a> or <a href="/app/social/new">schedule a social post</a>.</p></Card>}
      <div class="cal-legend small muted"><Badge>scheduled</Badge> items have a dashed border; sent and posted items are solid.</div>
      <script dangerouslySetInnerHTML={{ __html: CAL_JS }} />
    </DashLayout>,
  );
});

const CAL_JS = `(function(){
var cal=document.getElementById('cal');if(!cal)return;var drag=null;
cal.addEventListener('dragstart',function(e){var a=e.target.closest('[data-drag]');if(!a)return;drag=a;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',a.dataset.id);a.classList.add('dragging');});
cal.addEventListener('dragend',function(){if(drag)drag.classList.remove('dragging');cal.querySelectorAll('.drop').forEach(function(d){d.classList.remove('drop')});});
cal.addEventListener('dragover',function(e){var d=e.target.closest('.cal-day');if(!d||!drag||d.dataset.past==='1')return;e.preventDefault();cal.querySelectorAll('.drop').forEach(function(x){x!==d&&x.classList.remove('drop')});d.classList.add('drop');});
cal.addEventListener('drop',async function(e){var d=e.target.closest('.cal-day');if(!d||!drag)return;e.preventDefault();d.classList.remove('drop');var it=drag;drag=null;
if(it.closest('.cal-day')===d)return;
try{var j=await OH.json('/app/calendar/move',{kind:it.dataset.kind,id:it.dataset.id,date:d.dataset.date});
if(j.kind==='post'){await OH.json('/app/posts/'+encodeURIComponent(j.id)+'/publish',{mode:'schedule',scheduled_at:j.at});}
d.appendChild(it);OH.toast&&OH.toast(j.message||'Rescheduled');setTimeout(function(){location.reload()},700);}
catch(err){var m=(err.data&&(err.data.error||err.data.message))||err.message;OH.toast?OH.toast(m,5000):alert(m);if(err.data&&err.data.upgrade_url&&confirm(m+'\\n\\nOpen Plan & usage?'))location.href=err.data.upgrade_url;}
});
})();`;

/**
 * Validate a drag-to-reschedule. Social posts are moved here. Newsletter posts are only checked (permission,
 * status, future time, plan limits and account suspension); the browser then calls the posts module's schedule route.
 */
dash.post('/move', requirePerm('publish'), async (c) => {
  const pub = c.get('pub');
  const tz = pub.timezone || 'UTC';
  const b = await c.req.json<any>().catch(() => ({}));
  const date = str(b.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'Bad date' }, 400);
  const kind = str(b.kind, 20);
  const itemId = str(b.id, 40);
  const moveTo = (old: number) => zonedToUtc(`${date}T${utcToZoned(old, tz).slice(11, 16)}`, tz)!;
  if (kind === 'social') {
    const sp = await one<any>(c.env, `SELECT * FROM social_posts WHERE id = ? AND pub_id = ?`, itemId, pub.id);
    if (!sp || sp.status !== 'scheduled') return c.json({ error: 'Only scheduled social posts can be moved' }, 409);
    const at = moveTo(sp.scheduled_at || now());
    if (at < now() + 30_000) return c.json({ error: 'Pick a day in the future' }, 400);
    await rescheduleSocialPost(c.env, pub.id, sp.id, at);
    kick(c.env, c.executionCtx);
    return c.json({ ok: true, kind, id: sp.id, at: new Date(at).toISOString(), message: `Social post moved to ${date}` });
  }
  if (kind !== 'post') return c.json({ error: 'Only scheduled posts and social posts can be moved' }, 400);
  const post = await one<Post>(c.env, `SELECT * FROM posts WHERE id = ? AND pub_id = ?`, itemId, pub.id);
  if (!post || post.status !== 'scheduled' || !post.scheduled_at) return c.json({ error: 'Only scheduled posts can be moved' }, 409);
  const at = moveTo(post.scheduled_at);
  if (at < now() + 60_000) return c.json({ error: 'Pick a day in the future' }, 400);
  if (post.platform !== 'web') {
    const gate = await checkSend(c.env, pub, await countPostRecipients(c.env, pub, post), { dryRun: true });
    // A full monthly allowance only blocks dates before it resets.
    if (!gate.ok && !(gate.code === 'email_allowance' && at >= nextMonthStart())) return c.json({ error: gate.reason, code: gate.code, upgrade_url: gate.upgradeUrl }, 402);
  }
  return c.json({ ok: true, kind, id: post.id, at: new Date(at).toISOString(), message: `Post moved to ${date}` });
});

dash.get('/items.json', requirePerm('manage'), async (c) => {
  const from = Number(c.req.query('from')) || now() - 30 * DAY;
  const to = Math.min(Number(c.req.query('to')) || now() + 30 * DAY, from + 120 * DAY);
  const qTypes = c.req.queries('types');
  return c.json({ items: await calendarItems(c, from, to, new Set(qTypes?.length ? qTypes : Object.keys(KINDS))) });
});

export default { dash } satisfies Module;
