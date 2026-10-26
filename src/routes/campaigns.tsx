/** @jsxImportSource hono/jsx */
// Module: campaigns — group posts, social posts, events, automations and landing pages into a named campaign with
// a date range and goal, and report combined sends, opens, clicks, visits, signups and revenue (utm_campaign = slug).
import { Hono } from 'hono';
import type { Child } from 'hono/jsx';
import type { AppEnv, Ctx, Module } from '../types';
import { one, all, run, insert } from '../lib/db';
import { requirePerm, audit } from '../lib/auth';
import { ITEM_KINDS, addCampaignItem, removeCampaignItem, campaignReport, trackedSiteLink, type Campaign } from '../lib/campaigns';
import { zonedToUtc, utcToZoned } from '../lib/tz';
import { id, now, form, str, int, slugify, fmtDate, num, money, pct, DAY } from '../lib/util';
import { DashLayout } from '../ui/layout';
import { Card, Field, Input, Textarea, Select, Btn, ActionForm, Table, Badge, Empty, Grid, Help, LinkBtn, Stats, Stat, Progress, Copy, Modal, OpenBtn, back } from '../ui/components';

const dash = new Hono<AppEnv>();

function page(c: Ctx, title: string, body: Child, actions?: Child, crumbs?: Array<[string, string]>) {
  return c.html(<DashLayout c={c} title={title} section="marketing" sub="campaigns" actions={actions} crumbs={crumbs}>{body}</DashLayout>);
}

const GOALS: Array<[string, string]> = [['signups', 'New subscribers'], ['revenue', 'Revenue ($)'], ['clicks', 'Email clicks'], ['registrations', 'Event registrations']];

function CampaignForm(p: { c: Ctx; camp?: Campaign | null }) {
  const tz = p.c.get('pub').timezone || 'UTC';
  const k = p.camp;
  return (
    <form method="post" action={k ? `/app/campaigns/${k.id}` : '/app/campaigns'} class="stack">
      <Grid>
        <Field label="Name"><Input name="name" value={k?.name} required maxlength={120} placeholder="Spring launch" /></Field>
        <Field label="UTM campaign (slug)" hint="utm_campaign value added to links in campaign items. Changing it later splits the report."><Input name="slug" value={k?.slug} pattern="[a-z0-9-]{2,60}" placeholder="auto from the name" /></Field>
      </Grid>
      <Grid>
        <Field label="Starts"><Input name="starts" type="date" value={k?.starts_at ? utcToZoned(k.starts_at, tz).slice(0, 10) : ''} /></Field>
        <Field label="Ends"><Input name="ends" type="date" value={k?.ends_at ? utcToZoned(k.ends_at - 1, tz).slice(0, 10) : ''} /></Field>
      </Grid>
      <Grid>
        <Field label="Goal"><Select name="goal_kind" value={k?.goal_kind || 'signups'} options={GOALS} /></Field>
        <Field label="Target"><Input name="goal_target" type="number" min={0} value={k?.goal_target || ''} placeholder="e.g. 500" /></Field>
      </Grid>
      <Field label="Notes / goal description"><Textarea name="goal" value={k?.goal} rows={2} /></Field>
      <Btn>{k ? 'Save campaign' : 'Create campaign'}</Btn>
    </form>
  );
}

dash.get('/', requirePerm('manage'), async (c) => {
  const pub = c.get('pub');
  const rows = await all<any>(c.env, `SELECT c.*, (SELECT COUNT(*) FROM campaign_items i WHERE i.campaign_id = c.id) AS items, (SELECT COUNT(*) FROM subscribers s WHERE s.pub_id = c.pub_id AND s.utm_campaign = c.slug) AS signups FROM campaigns c WHERE c.pub_id = ? ORDER BY c.status, COALESCE(c.starts_at, c.created_at) DESC`, pub.id);
  return page(c, 'Campaigns', (
    <>
      {rows.length ? (
        <Card pad={false}>
          <Table<any> rows={rows} rowHref={(k) => `/app/campaigns/${k.id}`} cols={[
            { h: 'Campaign', r: (k) => <><a href={`/app/campaigns/${k.id}`}><strong>{k.name}</strong></a> {k.status === 'archived' && <Badge>archived</Badge>}<div class="small muted mono">utm_campaign={k.slug}</div></> },
            { h: 'Dates', r: (k) => <span class="small nowrap">{k.starts_at ? fmtDate(k.starts_at, undefined, pub.timezone) : '—'} → {k.ends_at ? fmtDate(k.ends_at - 1, undefined, pub.timezone) : 'open'}</span> },
            { h: 'Items', r: (k) => k.items },
            { h: 'Signups', r: (k) => <strong>{num(k.signups)}</strong> },
          ]} />
        </Card>
      ) : <Card><Empty icon="◎" title="No campaigns yet" body="A campaign groups everything you do for one push — newsletter issues, social posts, a webinar, an automation and a landing page — and reports them together. Links in campaign posts get utm_campaign automatically, so signups and sales are attributed." action={<OpenBtn target="#new-campaign">Create a campaign</OpenBtn>} /></Card>}
      <Modal id="new-campaign" title="New campaign"><CampaignForm c={c} /></Modal>
    </>
  ), <OpenBtn target="#new-campaign" small>+ New campaign</OpenBtn>);
});

function readForm(c: Ctx, f: Record<string, any>) {
  const tz = c.get('pub').timezone || 'UTC';
  const name = str(f.name, 120);
  const slug = slugify(str(f.slug, 60) || name, 60);
  const starts = /^\d{4}-\d{2}-\d{2}$/.test(f.starts || '') ? zonedToUtc(f.starts + 'T00:00', tz) : null;
  const ends = /^\d{4}-\d{2}-\d{2}$/.test(f.ends || '') ? (zonedToUtc(f.ends + 'T00:00', tz) || 0) + DAY : null;
  return { name, slug, starts_at: starts, ends_at: ends, goal: str(f.goal, 2000), goal_kind: GOALS.some(([k]) => k === f.goal_kind) ? f.goal_kind : 'signups', goal_target: Math.max(0, int(f.goal_target)) };
}

dash.post('/', requirePerm('manage'), async (c) => {
  const pub = c.get('pub');
  const v = readForm(c, await form(c.req));
  if (!v.name) return back(c, '/app/campaigns', 'Name required', 'err');
  if (v.starts_at && v.ends_at && v.ends_at <= v.starts_at) return back(c, '/app/campaigns', 'The end date must be after the start date', 'err');
  if (await one(c.env, 'SELECT 1 FROM campaigns WHERE pub_id = ? AND slug = ?', pub.id, v.slug)) return back(c, '/app/campaigns', `A campaign already uses utm_campaign=${v.slug}`, 'err');
  const cid = id();
  await insert(c.env, 'campaigns', { id: cid, pub_id: pub.id, ...v, status: 'active', created_by: c.get('user').id, created_at: now(), updated_at: now() });
  await audit(c, 'campaign.create', cid, { slug: v.slug });
  return back(c, `/app/campaigns/${cid}`, 'Campaign created — add posts, social posts, events, automations and pages');
});

async function load(c: Ctx) {
  return one<Campaign>(c.env, 'SELECT * FROM campaigns WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
}

dash.get('/:id', requirePerm('manage'), async (c) => {
  const pub = c.get('pub');
  const camp = await load(c);
  if (!camp) return c.notFound();
  const rep = await campaignReport(c.env, pub, camp);
  const items = await all<any>(c.env, `SELECT i.kind, i.ref_id,
      CASE i.kind WHEN 'post' THEN (SELECT title || '|' || status FROM posts WHERE id = i.ref_id)
                  WHEN 'social' THEN (SELECT substr(text, 1, 80) || '|' || status FROM social_posts WHERE id = i.ref_id)
                  WHEN 'event' THEN (SELECT title || '|' || slug FROM live_events WHERE id = i.ref_id)
                  WHEN 'automation' THEN (SELECT name || '|' || status FROM automations WHERE id = i.ref_id)
                  WHEN 'page' THEN (SELECT title || '|' || slug FROM pages WHERE id = i.ref_id) END AS info
      FROM campaign_items i WHERE i.campaign_id = ? ORDER BY i.kind, i.created_at`, camp.id);
  const opts = {
    post: await all<any>(c.env, `SELECT id, title AS name, status FROM posts WHERE pub_id = ? AND status != 'archived' ORDER BY updated_at DESC LIMIT 60`, pub.id),
    social: await all<any>(c.env, `SELECT id, substr(text, 1, 60) || ' (' || network || ')' AS name, status FROM social_posts WHERE pub_id = ? AND status IN ('scheduled','posted') ORDER BY created_at DESC LIMIT 60`, pub.id),
    event: await all<any>(c.env, `SELECT id, title AS name, '' AS status FROM live_events WHERE pub_id = ? ORDER BY starts_at DESC LIMIT 60`, pub.id),
    automation: await all<any>(c.env, `SELECT id, name, status FROM automations WHERE pub_id = ? AND status != 'archived' ORDER BY updated_at DESC LIMIT 60`, pub.id),
    page: await all<any>(c.env, `SELECT id, title AS name, status FROM pages WHERE pub_id = ? ORDER BY updated_at DESC LIMIT 60`, pub.id),
  } as Record<string, any[]>;
  const href = (kind: string, rid: string, info: string) => {
    const [, extra] = (info || '').split('|');
    return kind === 'post' ? `/app/posts/${rid}` : kind === 'social' ? '/app/social' : kind === 'event' ? `/app/events/${rid}` : kind === 'automation' ? `/app/automations/${rid}` : `/app/website/pages/${rid}`;
  };
  const target = camp.goal_target || 0;
  const goalLabel = GOALS.find(([k]) => k === camp.goal_kind)?.[1] || 'Goal';
  return page(c, camp.name, (
    <>
      <p class="muted">utm_campaign=<code>{camp.slug}</code> · {camp.starts_at ? fmtDate(camp.starts_at, undefined, pub.timezone) : 'no start'} → {camp.ends_at ? fmtDate(camp.ends_at - 1, undefined, pub.timezone) : 'open-ended'}{camp.goal && <> · {camp.goal}</>}</p>
      <Stats>
        <Stat label="Emails delivered" value={<span data-campaign-delivered>{num(rep.delivered)}</span>} sub={`${rep.sends} newsletter send${rep.sends === 1 ? '' : 's'}${rep.automationEmails ? ` + ${num(rep.automationEmails)} automation` : ''}`} />
        <Stat label="Opens" value={<span data-campaign-opens>{num(rep.opens)}</span>} sub={pct(rep.opens, rep.delivered)} />
        <Stat label="Clicks" value={<span data-campaign-clicks>{num(rep.clicks)}</span>} sub={pct(rep.clicks, rep.delivered)} />
        <Stat label="Site visits" value={num(rep.visits)} sub="utm_campaign + landing pages" />
        <Stat label="Signups" value={<span data-campaign-signups>{num(rep.signups)}</span>} sub="subscribers with this utm_campaign" />
        <Stat label="Revenue" value={<span data-campaign-revenue>{money(rep.revenueCents)}</span>} sub={`${rep.orders} paid order${rep.orders === 1 ? '' : 's'}${rep.registrations ? ` · ${rep.registrations} registrations` : ''}`} />
      </Stats>
      {target > 0 && <Card title={`Goal: ${num(target)} ${goalLabel.toLowerCase()}`}><Progress value={rep.goalValue} max={target} label={`${num(rep.goalValue)} of ${num(target)}`} /></Card>}
      <Grid>
        <Card title="Items" pad={false} actions={<OpenBtn target="#add-item" small>+ Add</OpenBtn>}>
          <Table<any> rows={items} empty={<div style="padding:18px" class="muted">Nothing in this campaign yet.</div>} cols={[
            { h: 'Type', r: (i) => <Badge tone="blue">{ITEM_KINDS[i.kind]?.replace(/s$/, '').replace(/ & webinars/, '')}</Badge> },
            { h: 'Item', r: (i) => { const [name, extra] = String(i.info || '(deleted)|').split('|'); return <><a href={href(i.kind, i.ref_id, i.info)}>{name}</a>{extra && i.kind !== 'event' && i.kind !== 'page' && <span class="small muted"> · {extra}</span>}
              {(i.kind === 'event' || i.kind === 'page') && extra && <div style="margin-top:4px"><Copy value={trackedSiteLink(c.env, pub, i.kind === 'event' ? `/events/${extra}` : `/${extra}`, camp.slug)} /></div>}</>; } },
            { h: '', class: 'right', r: (i) => <ActionForm action={`/app/campaigns/${camp.id}/items/remove`} fields={{ kind: i.kind, ref_id: i.ref_id }} label="Remove" kind="ghost" /> },
          ]} />
        </Card>
        <Card title="Signups by source">
          {rep.bySource.length ? <Table<any> rows={rep.bySource} cols={[{ h: 'utm_source', r: (s) => s.source }, { h: 'Signups', class: 'right', r: (s) => num(s.signups) }]} /> : <p class="muted">No attributed signups yet.</p>}
          <Help>Share any link with <code>?utm_campaign={camp.slug}</code> (e.g. in ads) and signups through it count here. Links inside campaign posts are tagged automatically before they're sent; social posts get <code>utm_source=&lt;network&gt;</code>.</Help>
          <div class="row"><LinkBtn small href={`/app/social/new?campaign=${camp.id}`}>+ Social post for this campaign</LinkBtn></div>
        </Card>
      </Grid>
      {rep.posts.length > 0 && (
        <Card title="Newsletter posts" pad={false}>
          <Table<any> rows={rep.posts} cols={[
            { h: 'Post', r: (p) => <a href={`/app/posts/${p.id}`}>{p.title}</a> },
            { h: 'Status', r: (p) => p.status },
            { h: 'Delivered', class: 'right', r: (p) => num(p.delivered) },
            { h: 'Opens', class: 'right', r: (p) => `${num(p.opens)} (${pct(p.opens, p.delivered)})` },
            { h: 'Clicks', class: 'right', r: (p) => `${num(p.clicks)} (${pct(p.clicks, p.delivered)})` },
          ]} />
        </Card>
      )}
      <Card title="Settings"><CampaignForm c={c} camp={camp} />
        <div class="row" style="margin-top:12px">
          <ActionForm action={`/app/campaigns/${camp.id}/archive`} label={camp.status === 'archived' ? 'Unarchive' : 'Archive'} />
          <ActionForm action={`/app/campaigns/${camp.id}/delete`} label="Delete campaign" kind="danger" confirm="Delete this campaign? Items are kept; tagged links keep their utm_campaign." />
        </div>
      </Card>
      <Modal id="add-item" title="Add to campaign">
        <form method="post" action={`/app/campaigns/${camp.id}/items`} class="stack">
          <Field label="Type"><Select name="kind" id="ci-kind" options={Object.entries(ITEM_KINDS)} /></Field>
          {Object.entries(opts).map(([k, list]) => (
            <Field label={ITEM_KINDS[k]} class={`ci-opt ${k === 'post' ? '' : 'hide'}`} >
              <select class="input" name={`ref_${k}`} data-kind={k}>{list.length ? list.map((o) => <option value={o.id}>{o.name}{o.status ? ` (${o.status})` : ''}</option>) : <option value="">Nothing to add</option>}</select>
            </Field>
          ))}
          <Help>Adding a draft or scheduled post tags its links with utm_campaign={camp.slug}. Posts already sent keep their links (their opens and clicks still count).</Help>
          <Btn>Add</Btn>
        </form>
        <script dangerouslySetInnerHTML={{ __html: `(function(){var s=document.getElementById('ci-kind');function u(){document.querySelectorAll('.ci-opt').forEach(function(f){var k=f.querySelector('select').dataset.kind;f.classList.toggle('hide',k!==s.value)})}s.addEventListener('change',u);u();})();` }} />
      </Modal>
    </>
  ), <LinkBtn small href={`/app/campaigns/${camp.id}/report.csv`}>Export CSV</LinkBtn>, [['/app/campaigns', 'Campaigns']]);
});

dash.post('/:id', requirePerm('manage'), async (c) => {
  const pub = c.get('pub');
  const camp = await load(c);
  if (!camp) return c.notFound();
  const v = readForm(c, await form(c.req));
  if (!v.name) return back(c, `/app/campaigns/${camp.id}`, 'Name required', 'err');
  if (v.slug !== camp.slug && (await one(c.env, 'SELECT 1 FROM campaigns WHERE pub_id = ? AND slug = ?', pub.id, v.slug))) return back(c, `/app/campaigns/${camp.id}`, 'That slug is taken', 'err');
  await run(c.env, 'UPDATE campaigns SET name = ?, slug = ?, starts_at = ?, ends_at = ?, goal = ?, goal_kind = ?, goal_target = ?, updated_at = ? WHERE id = ? AND pub_id = ?', v.name, v.slug, v.starts_at, v.ends_at, v.goal, v.goal_kind, v.goal_target, now(), camp.id, pub.id);
  return back(c, `/app/campaigns/${camp.id}`, 'Saved');
});

dash.post('/:id/items', requirePerm('manage'), async (c) => {
  const pub = c.get('pub');
  const camp = await load(c);
  if (!camp) return c.notFound();
  const f = await form(c.req);
  const kind = str(f.kind, 20);
  const ref = str(f[`ref_${kind}`] ?? f.ref_id, 40);
  if (!ref) return back(c, `/app/campaigns/${camp.id}`, 'Pick an item', 'err');
  const err = await addCampaignItem(c.env, pub, camp, kind, ref);
  return back(c, `/app/campaigns/${camp.id}`, err || 'Added to the campaign', err ? 'err' : 'ok');
});

dash.post('/:id/items/remove', requirePerm('manage'), async (c) => {
  const camp = await load(c);
  if (!camp) return c.notFound();
  const f = await form(c.req);
  await removeCampaignItem(c.env, c.get('pub').id, camp.id, str(f.kind, 20), str(f.ref_id, 40));
  return back(c, `/app/campaigns/${camp.id}`, 'Removed');
});

dash.post('/:id/archive', requirePerm('manage'), async (c) => {
  const camp = await load(c);
  if (!camp) return c.notFound();
  await run(c.env, 'UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?', camp.status === 'archived' ? 'active' : 'archived', now(), camp.id);
  return back(c, `/app/campaigns/${camp.id}`, camp.status === 'archived' ? 'Unarchived' : 'Archived');
});

dash.post('/:id/delete', requirePerm('manage'), async (c) => {
  const camp = await load(c);
  if (!camp) return c.notFound();
  await run(c.env, 'DELETE FROM campaign_items WHERE campaign_id = ?', camp.id);
  await run(c.env, 'UPDATE social_posts SET campaign_id = NULL WHERE campaign_id = ?', camp.id);
  await run(c.env, 'DELETE FROM campaigns WHERE id = ?', camp.id);
  await audit(c, 'campaign.delete', camp.id);
  return back(c, '/app/campaigns', 'Campaign deleted');
});

dash.get('/:id/report.csv', requirePerm('manage'), async (c) => {
  const pub = c.get('pub');
  const camp = await load(c);
  if (!camp) return c.notFound();
  const r = await campaignReport(c.env, pub, camp);
  const rows: unknown[][] = [['metric', 'value'], ['campaign', camp.name], ['utm_campaign', camp.slug], ['newsletter_sends', r.sends], ['emails_delivered', r.delivered], ['opens', r.opens], ['clicks', r.clicks], ['automation_emails', r.automationEmails], ['social_posted', r.socialPosted], ['site_visits', r.visits], ['signups', r.signups], ['event_registrations', r.registrations], ['paid_orders', r.orders], ['revenue', (r.revenueCents / 100).toFixed(2)]];
  const { toCSV } = await import('../lib/util');
  return new Response(toCSV(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="campaign-${camp.slug}.csv"` } });
});

export default { dash } satisfies Module;
