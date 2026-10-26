/** @jsxImportSource hono/jsx */
// Subscribers: list (filters, keyset pagination, bulk actions, CSV export), add, and full profile.
import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { AppEnv, Ctx, Subscriber } from '../../types';
import { one, all, run, val, batch, stmt, insertStmt, encodeCursor, decodeCursor } from '../../lib/db';
import { compile } from '../../lib/segments';
import { subscribe, unsubscribe, deleteSubscriber, addTags, removeTags, setFields, joinLists, leaveLists, sendConfirmation, getTags } from '../../lib/subscribers';
import { enroll } from '../../lib/automations';
import { enqueue, kick } from '../../lib/jobs';
import { emit } from '../../lib/events';
import { requirePerm, audit } from '../../lib/auth';
import { Card, Btn, LinkBtn, Field, Input, Select, Check, Toggle, Table, Stat, Stats, Status, Badge, Modal, OpenBtn, Pager, Empty, back, Muted, Help } from '../../ui/components';
import { page, SOURCES, filtersFrom, filterGroup, filterQS, exportCSV } from './shared';
import { form, str, int, now, DAY, ago, fmtDate, fmtDateTime, num, pct, parseJSON, chunk, id as newId } from '../../lib/util';
import { StorePurchasesCard } from '../integrations-commerce';
import { getSignals, enrichSubscriber, signalsEnabled, setSignalsEnabled, domainSignals } from '../../lib/signals';
import {
  scoreSubscriber, scorePublication, topSubscribers, predictionSummary, lastScoredAt, queueScoring,
  VALUE_W, REFERRALS_FOR_FULL_SCORE, MAX_TENURE_MONTHS, PURCHASE_HIGH, PURCHASE_MEDIUM, CHURN_HIGH, CHURN_MEDIUM,
} from '../../lib/predict';

const app = new Hono<AppEnv>();

app.get('/', async (c) => {
  const pub = c.get('pub');
  const f = filtersFrom((k) => c.req.query(k));
  const g = filterGroup(f);
  const cc = await compile(c.env, pub.id, g);
  const cur = decodeCursor(c.req.query('after'));
  const limit = 50;
  const rows = await all<Subscriber>(
    c.env,
    `SELECT s.* FROM subscribers s WHERE s.pub_id = ? AND s.source != 'try_it' AND (${cc.sql}) ${cur ? 'AND (s.created_at < ? OR (s.created_at = ? AND s.id < ?))' : ''} ORDER BY s.created_at DESC, s.id DESC LIMIT ?`,
    pub.id, ...cc.params, ...(cur ? [cur.t, cur.t, cur.id] : []), limit + 1,
  );
  const more = rows.length > limit;
  const list = rows.slice(0, limit);
  const total = await val<number>(c.env, `SELECT COUNT(*) FROM subscribers s WHERE s.pub_id = ? AND s.source != 'try_it' AND (${cc.sql})`, pub.id, ...cc.params);
  const since = now() - 30 * DAY;
  const [active, new30, unsub30, premium] = await Promise.all([
    val<number>(c.env, `SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND status = 'active'`, pub.id),
    val<number>(c.env, `SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND created_at >= ?`, pub.id, since),
    val<number>(c.env, `SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND status = 'unsubscribed' AND unsubscribed_at >= ?`, pub.id, since),
    val<number>(c.env, `SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND status = 'active' AND tier = 'premium'`, pub.id),
  ]);
  const tags = await all<{ tag: string }>(c.env, 'SELECT DISTINCT tag FROM subscriber_tags WHERE pub_id = ? ORDER BY tag LIMIT 300', pub.id);
  const lists = await all<{ id: string; name: string }>(c.env, 'SELECT id, name FROM lists WHERE pub_id = ? ORDER BY name', pub.id);
  const segments = await all<{ id: string; name: string; kind: string }>(c.env, 'SELECT id, name, kind FROM segments WHERE pub_id = ? ORDER BY name', pub.id);
  const automations = await all<{ id: string; name: string; status: string }>(c.env, `SELECT id, name, status FROM automations WHERE pub_id = ? AND status != 'archived' ORDER BY name`, pub.id);
  const filtered = Object.keys(f).length > 0;
  const qs = filterQS(f);

  return page(c, {
    title: 'Subscribers', sub: 'subscribers',
    actions: <>
      <LinkBtn href="/app/audience/top" small>★ Top subscribers</LinkBtn>
      <LinkBtn href="/app/audience/imports" small>Import</LinkBtn>
      <LinkBtn href={`/app/audience/export${qs}`} small>Export CSV</LinkBtn>
      <OpenBtn target="#add-sub" small>+ Add subscriber</OpenBtn>
    </>,
    scripts: ['/static/audience-ui.js'],
  }, <>
    <Stats>
      <Stat label="Active subscribers" value={num(active)} href="/app/audience?status=active" />
      <Stat label="New (30 days)" value={num(new30)} />
      <Stat label="Unsubscribed (30 days)" value={num(unsub30)} href="/app/audience?status=unsubscribed" />
      <Stat label="Premium" value={num(premium)} sub={pct(premium, active)} href="/app/audience?tier=premium&status=active" />
    </Stats>

    <form method="get" class="card card-b filters" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
      <Field label="Search" class="grow"><Input name="q" value={f.q} placeholder="Email or name" /></Field>
      <Field label="Status"><Select name="status" value={f.status} autosubmit options={[['', 'Any'], ['active', 'Active'], ['pending', 'Pending'], ['unsubscribed', 'Unsubscribed'], ['bounced', 'Bounced'], ['complained', 'Complained']]} /></Field>
      <Field label="Tier"><Select name="tier" value={f.tier} autosubmit options={[['', 'Any'], ['free', 'Free'], ['premium', 'Premium']]} /></Field>
      <Field label="Source"><Select name="source" value={f.source} autosubmit options={[['', 'Any'], ...SOURCES.map((s) => [s, s.replace('_', ' ')] as [string, string])]} /></Field>
      <Field label="Tag"><Select name="tag" value={f.tag} autosubmit options={[['', 'Any'], ...tags.map((t) => [t.tag, t.tag] as [string, string])]} /></Field>
      <Field label="List"><Select name="list" value={f.list} autosubmit options={[['', 'Any'], ...lists.map((l) => [l.id, l.name] as [string, string])]} /></Field>
      <Field label="Segment"><Select name="segment" value={f.segment} autosubmit options={[['', 'Any'], ...segments.map((s) => [s.id, s.name] as [string, string])]} /></Field>
      <div class="field"><Btn small>Filter</Btn> {filtered && <a class="btn btn-ghost btn-sm" href="/app/audience">Clear</a>}</div>
    </form>

    <form method="post" action={`/app/audience/bulk${qs}`} id="bulk-form">
      <div class="row between" style="margin-bottom:10px">
        <div class="row">
          <Select name="action" options={[['', 'Bulk action…'], ['add_tag', 'Add tag'], ['remove_tag', 'Remove tag'], ['add_list', 'Add to list'], ['remove_list', 'Remove from list'], ['add_segment', 'Add to static segment'], ['enroll', 'Enroll in automation'], ['unsubscribe', 'Unsubscribe'], ['delete', 'Delete permanently']]} attrs={{ 'data-bulk-action': '1', style: 'width:auto' }} />
          <Input name="tag" placeholder="tag name" class="bulk-opt bulk-add_tag bulk-remove_tag hide" attrs={{ style: 'width:160px' }} />
          <Select name="list_id" class="bulk-opt bulk-add_list bulk-remove_list hide" options={lists.map((l) => [l.id, l.name] as [string, string])} attrs={{ style: 'width:auto' }} />
          <Select name="segment_id" class="bulk-opt bulk-add_segment hide" options={segments.filter((s) => s.kind === 'static').map((s) => [s.id, s.name] as [string, string])} attrs={{ style: 'width:auto' }} />
          <Select name="automation_id" class="bulk-opt bulk-enroll hide" options={automations.map((a) => [a.id, `${a.name}${a.status !== 'active' ? ` (${a.status})` : ''}`] as [string, string])} attrs={{ style: 'width:auto' }} />
          <Select name="scope" options={[['selected', 'Selected rows'], ['all', `All ${num(total)} matching`]]} attrs={{ style: 'width:auto' }} />
          <Btn small kind="secondary" confirm="Apply this action?">Apply</Btn>
        </div>
        <Muted>{num(total)} {filtered ? 'matching' : 'total'}</Muted>
      </div>
      {list.length ? (
        <Table<Subscriber>
          rows={list}
          rowHref={(s) => `/app/audience/s/${s.id}`}
          cols={[
            { h: <input type="checkbox" data-check-all="ids[]" aria-label="Select all" />, r: (s) => <input type="checkbox" name="ids[]" value={s.id} />, class: 'w1' },
            { h: 'Email', r: (s) => <a href={`/app/audience/s/${s.id}`}>{s.email}</a> },
            { h: 'Name', r: (s) => s.name || <Muted>—</Muted> },
            { h: 'Status', r: (s) => <Status s={s.status} /> },
            { h: 'Tier', r: (s) => <Status s={s.tier} /> },
            { h: 'Source', r: (s) => <span class="small">{s.source.replace('_', ' ')}{s.utm_source ? <Muted> · {s.utm_source}</Muted> : null}</span> },
            { h: 'Engagement', r: (s) => <span class={`eng eng-${s.engagement >= 60 ? 'hi' : s.engagement >= 25 ? 'mid' : 'lo'}`}>{s.engagement}</span> },
            { h: 'Joined', r: (s) => <span class="nowrap small" title={fmtDateTime(s.created_at)}>{ago(s.created_at)}</span> },
          ]}
        />
      ) : (
        <Card><Empty title={filtered ? 'No subscribers match these filters' : 'No subscribers yet'} body={filtered ? 'Try clearing a filter.' : 'Add subscribers manually, import a CSV, or embed a signup form on your site.'} action={<><OpenBtn target="#add-sub">Add subscriber</OpenBtn> <LinkBtn href="/app/audience/imports">Import CSV</LinkBtn></>} /></Card>
      )}
    </form>
    <Pager info={list.length ? `Showing ${list.length} of ${num(total)}` : ''} prev={c.req.query('after') ? `/app/audience${qs}` : null} next={more ? `/app/audience${filterQS(f, { after: encodeCursor(list[list.length - 1]) })}` : null} />

    <Modal id="add-sub" title="Add subscriber">
      <form method="post" action="/app/audience/add">
        <Field label="Email"><Input name="email" type="email" required autofocus /></Field>
        <Field label="Name"><Input name="name" /></Field>
        <Field label="Tags" hint="Comma separated"><Input name="tags" placeholder="vip, conference-2026" /></Field>
        {lists.length > 0 && <Field label="Lists">{lists.map((l) => <Check name="lists[]" value={l.id} label={l.name} checked />)}</Field>}
        <Toggle name="skip_confirm" checked label="Mark as confirmed" hint="Skip the double opt-in email (only if they gave you permission)." />
        <Toggle name="send_welcome" checked label="Trigger welcome automations" />
        <div class="form-actions"><Btn>Add subscriber</Btn></div>
      </form>
    </Modal>
    {c.req.query('add') === '1' && <script>{raw(`document.addEventListener('DOMContentLoaded',function(){document.getElementById('add-sub').showModal()})`)}</script>}
  </>);
});

app.post('/add', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const res = await subscribe(c.env, pub, {
    email: str(f.email), name: str(f.name, 120), source: 'manual', tags: str(f.tags).split(',').map((t) => t.trim()).filter(Boolean),
    listIds: f.lists || [], skipConfirm: f.skip_confirm === 'on', sendWelcome: f.send_welcome === 'on', reactivate: true,
  });
  if (!res.ok) return back(c, '/app/audience?add=1', res.error + (res.suggestion ? ` Did you mean ${res.suggestion}?` : ''), 'err');
  await audit(c, 'subscriber.add', res.subscriber!.id, { email: res.subscriber!.email });
  kick(c.env, c.executionCtx);
  return back(c, `/app/audience/s/${res.subscriber!.id}`, res.created ? 'Subscriber added' + (res.pending ? ' — confirmation email sent' : '') : 'Subscriber already existed — updated');
});

app.get('/export', requirePerm('admin'), async (c) => {
  const f = filtersFrom((k) => c.req.query(k));
  await audit(c, 'subscribers.export', undefined, { ...f });
  return exportCSV(c, filterGroup(f), `${c.get('pub').slug}-subscribers`);
});

async function targetIds(c: Ctx, f: Record<string, any>): Promise<string[]> {
  const pub = c.get('pub');
  if (f.scope === 'all') {
    const g = filterGroup(filtersFrom((k) => c.req.query(k)));
    const cc = await compile(c.env, pub.id, g);
    return (await all<{ id: string }>(c.env, `SELECT s.id FROM subscribers s WHERE s.pub_id = ? AND s.source != 'try_it' AND (${cc.sql}) LIMIT 20000`, pub.id, ...cc.params)).map((r) => r.id);
  }
  const ids: string[] = (f.ids || []).map(String).slice(0, 1000);
  if (!ids.length) return [];
  const out: string[] = [];
  for (const ch of chunk(ids, 90)) out.push(...(await all<{ id: string }>(c.env, `SELECT id FROM subscribers WHERE pub_id = ? AND id IN (${ch.map(() => '?').join(',')})`, pub.id, ...ch)).map((r) => r.id));
  return out;
}

app.post('/bulk', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const backTo = '/app/audience' + filterQS(filtersFrom((k) => c.req.query(k)));
  const action = str(f.action);
  if (!action) return back(c, backTo, 'Choose a bulk action', 'err');
  if (action === 'delete' && !(await import('../../lib/auth')).can(c.get('role'), 'admin')) return back(c, backTo, 'Only admins can delete subscribers in bulk', 'err');
  const ids = await targetIds(c, f);
  if (!ids.length) return back(c, backTo, 'No subscribers selected', 'err');
  const small = ids.length <= 200;
  const t = now();
  const inList = (ch: string[]) => ch.map(() => '?').join(',');
  switch (action) {
    case 'add_tag':
    case 'remove_tag': {
      const tag = str(f.tag, 60).toLowerCase();
      if (!tag) return back(c, backTo, 'Enter a tag', 'err');
      if (small) for (const sid of ids) action === 'add_tag' ? await addTags(c.env, pub.id, sid, [tag]) : await removeTags(c.env, pub.id, sid, [tag]);
      else for (const ch of chunk(ids, 90)) await batch(c.env, [action === 'add_tag'
        ? stmt(c.env, `INSERT OR IGNORE INTO subscriber_tags (pub_id, subscriber_id, tag, created_at) SELECT ?, id, ?, ? FROM subscribers WHERE id IN (${inList(ch)})`, pub.id, tag, t, ...ch)
        : stmt(c.env, `DELETE FROM subscriber_tags WHERE tag = ? AND subscriber_id IN (${inList(ch)})`, tag, ...ch)]);
      break;
    }
    case 'add_list':
    case 'remove_list': {
      const lid = str(f.list_id);
      if (!(await one(c.env, 'SELECT 1 FROM lists WHERE id = ? AND pub_id = ?', lid, pub.id))) return back(c, backTo, 'Choose a list', 'err');
      if (small) for (const sid of ids) action === 'add_list' ? await joinLists(c.env, pub.id, sid, [lid]) : await leaveLists(c.env, pub.id, sid, [lid]);
      else for (const ch of chunk(ids, 90)) await batch(c.env, [action === 'add_list'
        ? stmt(c.env, `INSERT INTO list_members (list_id, subscriber_id, status, created_at) SELECT ?, id, 'subscribed', ? FROM subscribers WHERE id IN (${inList(ch)}) ON CONFLICT(list_id, subscriber_id) DO UPDATE SET status = 'subscribed'`, lid, t, ...ch)
        : stmt(c.env, `UPDATE list_members SET status = 'unsubscribed' WHERE list_id = ? AND subscriber_id IN (${inList(ch)})`, lid, ...ch)]);
      break;
    }
    case 'add_segment': {
      const seg = await one<any>(c.env, `SELECT id FROM segments WHERE id = ? AND pub_id = ? AND kind = 'static'`, str(f.segment_id), pub.id);
      if (!seg) return back(c, backTo, 'Choose a static segment', 'err');
      for (const ch of chunk(ids, 90)) await run(c.env, `INSERT OR IGNORE INTO segment_members (segment_id, subscriber_id) SELECT ?, id FROM subscribers WHERE id IN (${inList(ch)})`, seg.id, ...ch);
      const { recalcSegment } = await import('../../lib/segments');
      await recalcSegment(c.env, pub.id, seg.id);
      break;
    }
    case 'enroll': {
      const a = await one<any>(c.env, 'SELECT id, status FROM automations WHERE id = ? AND pub_id = ?', str(f.automation_id), pub.id);
      if (!a) return back(c, backTo, 'Choose an automation', 'err');
      if (a.status !== 'active') return back(c, backTo, 'That automation is not active — activate it first', 'err');
      if (ids.length <= 20) for (const sid of ids) await enroll(c.env, a.id, sid, { source: 'bulk' });
      else {
        for (const ch of chunk(ids, 50)) await batch(c.env, ch.map((sid) => insertStmt(c.env, 'jobs', { id: newId(), kind: 'automation.enroll', payload: JSON.stringify({ automation_id: a.id, subscriber_id: sid, data: { source: 'bulk' } }), run_at: t, status: 'pending', attempts: 0, created_at: t })));
        kick(c.env, c.executionCtx);
      }
      break;
    }
    case 'unsubscribe': {
      if (small) for (const sid of ids) await unsubscribe(c.env, pub.id, sid, 'admin');
      else for (const ch of chunk(ids, 90)) await batch(c.env, [
        stmt(c.env, `UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ?, unsubscribe_reason = 'admin', updated_at = ? WHERE status != 'unsubscribed' AND id IN (${inList(ch)})`, t, t, ...ch),
        stmt(c.env, `UPDATE automation_runs SET status = 'exited' WHERE status IN ('active','waiting') AND subscriber_id IN (${inList(ch)})`, ...ch),
      ]);
      break;
    }
    case 'delete': {
      if (small) for (const sid of ids) await deleteSubscriber(c.env, pub.id, sid);
      else for (const ch of chunk(ids, 90)) await run(c.env, `DELETE FROM subscribers WHERE pub_id = ? AND id IN (${inList(ch)})`, pub.id, ...ch);
      break;
    }
    default:
      return back(c, backTo, 'Unknown action', 'err');
  }
  await audit(c, 'subscribers.bulk.' + action, undefined, { count: ids.length });
  return back(c, backTo, `${action.replace('_', ' ')} applied to ${num(ids.length)} subscriber${ids.length === 1 ? '' : 's'}`);
});

// ───────── profile ─────────
async function loadSub(c: Ctx) {
  return one<Subscriber>(c.env, 'SELECT * FROM subscribers WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
}

app.get('/s/:id', async (c) => {
  const pub = c.get('pub');
  const s = await loadSub(c);
  if (!s) return back(c, '/app/audience', 'Subscriber not found', 'err');
  const [tags, lists, fields, history, activity, runs, orders, votes, responses, community, referrer, referred, subs, automations, allTags] = await Promise.all([
    getTags(c.env, s.id),
    all<any>(c.env, `SELECT l.id, l.name, lm.status FROM lists l LEFT JOIN list_members lm ON lm.list_id = l.id AND lm.subscriber_id = ? WHERE l.pub_id = ? ORDER BY l.name`, s.id, pub.id),
    all<any>(c.env, 'SELECT key, label, kind, options FROM custom_fields WHERE pub_id = ? ORDER BY label', pub.id),
    all<any>(c.env, `SELECT d.*, se.kind, se.subject, se.post_id, se.automation_id, p.title AS post_title, a.name AS automation_name FROM deliveries d JOIN sends se ON se.id = d.send_id LEFT JOIN posts p ON p.id = se.post_id LEFT JOIN automations a ON a.id = se.automation_id WHERE d.subscriber_id = ? ORDER BY d.created_at DESC LIMIT 200`, s.id),
    all<any>(c.env, 'SELECT * FROM activity WHERE subscriber_id = ? ORDER BY created_at DESC LIMIT 100', s.id),
    all<any>(c.env, `SELECT r.*, a.name, (SELECT COUNT(*) FROM automation_logs l WHERE l.run_id = r.id) AS steps FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE r.subscriber_id = ? ORDER BY r.created_at DESC LIMIT 50`, s.id),
    all<any>(c.env, `SELECT * FROM orders WHERE pub_id = ? AND (subscriber_id = ? OR email = ?) ORDER BY created_at DESC LIMIT 50`, pub.id, s.id, s.email),
    all<any>(c.env, `SELECT v.*, p.question, p.options FROM poll_votes v JOIN polls p ON p.id = v.poll_id WHERE v.subscriber_id = ? ORDER BY v.created_at DESC LIMIT 50`, s.id),
    all<any>(c.env, `SELECT r.*, sv.title, sv.questions FROM survey_responses r JOIN surveys sv ON sv.id = r.survey_id WHERE r.subscriber_id = ? ORDER BY r.created_at DESC LIMIT 50`, s.id),
    one<any>(c.env, 'SELECT * FROM community_members WHERE pub_id = ? AND subscriber_id = ?', pub.id, s.id),
    s.referred_by ? one<any>(c.env, 'SELECT id, email FROM subscribers WHERE id = ?', s.referred_by) : Promise.resolve(null),
    all<any>(c.env, 'SELECT id, email, created_at FROM subscribers WHERE referred_by = ? ORDER BY created_at DESC LIMIT 20', s.id),
    all<any>(c.env, `SELECT * FROM subscriptions WHERE subscriber_id = ? ORDER BY created_at DESC LIMIT 10`, s.id),
    all<any>(c.env, `SELECT id, name, status FROM automations WHERE pub_id = ? AND status = 'active' ORDER BY name`, pub.id),
    all<{ tag: string }>(c.env, 'SELECT DISTINCT tag FROM subscriber_tags WHERE pub_id = ? ORDER BY tag LIMIT 300', pub.id),
  ]);
  const sigOn = signalsEnabled(pub);
  const [scores, signals] = await Promise.all([scoreSubscriber(c.env, pub.id, s.id).catch(() => null), sigOn ? getSignals(c.env, s.id) : Promise.resolve(null)]);
  if (sigOn && !signals && s.status === 'active') c.executionCtx.waitUntil(enrichSubscriber(c.env, s).catch(() => {}));
  const dom = domainSignals(s.email);
  const custom = parseJSON<Record<string, any>>(s.custom, {});
  const sent = history.filter((h) => ['sent', 'deferred'].includes(h.status)).length;
  const opened = history.filter((h) => h.opened_at).length;
  const clicked = history.filter((h) => h.clicked_at).length;
  let sourceDetail: any = s.source_detail;
  if (s.source === 'form' && s.source_detail) sourceDetail = (await one<any>(c.env, 'SELECT name FROM forms WHERE id = ?', s.source_detail))?.name || s.source_detail;
  if ((s.source === 'recommendation' || s.source === 'boost') && s.source_detail) sourceDetail = (await one<any>(c.env, 'SELECT name FROM publications WHERE id = ?', s.source_detail))?.name || s.source_detail;
  const optLabel = (opts: string, oid: string) => parseJSON<any[]>(opts, []).find((o) => o.id === oid)?.label || oid;

  return page(c, {
    title: s.name || s.email, sub: 'subscribers', crumbs: [['/app/audience', 'Subscribers']],
    actions: <>
      {s.status === 'pending' && <form method="post" action={`/app/audience/s/${s.id}/action`} class="inline-form"><input type="hidden" name="do" value="confirm" /><Btn small kind="secondary">Resend confirmation</Btn></form>}
      {s.status === 'active'
        ? <form method="post" action={`/app/audience/s/${s.id}/action`} class="inline-form"><input type="hidden" name="do" value="unsubscribe" /><Btn small kind="secondary" confirm="Unsubscribe this reader?">Unsubscribe</Btn></form>
        : <form method="post" action={`/app/audience/s/${s.id}/action`} class="inline-form"><input type="hidden" name="do" value="resubscribe" /><Btn small kind="secondary" confirm="Only resubscribe readers who asked you to. Continue?">Resubscribe</Btn></form>}
      <form method="post" action={`/app/audience/s/${s.id}/action`} class="inline-form"><input type="hidden" name="do" value="delete" /><Btn small kind="danger" confirm="Permanently delete this subscriber and their data (GDPR erasure)?">Delete</Btn></form>
    </>,
  }, <>
    <Stats>
      <Stat label="Status" value={<Status s={s.status} />} sub={s.status === 'unsubscribed' ? `${ago(s.unsubscribed_at)}${s.unsubscribe_reason ? ' · ' + s.unsubscribe_reason : ''}` : `since ${fmtDate(s.confirmed_at || s.created_at)}`} />
      <Stat label="Engagement score" value={s.engagement} sub={`last open ${ago(s.last_open_at)}`} />
      <Stat label="Emails received" value={num(sent)} sub={`${pct(opened, sent)} opened · ${pct(clicked, sent)} clicked`} />
      <Stat label="Referrals" value={num(s.referral_count)} sub={`code ${s.referral_code}`} />
    </Stats>
    {scores && (
      <Stats>
        <Stat label="Value score" value={<span data-value-score>{scores.value_score}</span>} sub={scores.value_percentile !== null ? `top ${Math.max(1, 100 - scores.value_percentile)}% of your readers` : 'engagement, revenue, referrals, recency'} href="/app/audience/top" />
        <Stat label="Customer lifetime value" value={<span data-clv>{'$' + (scores.clv_cents / 100).toFixed(2)}</span>} sub={`$${(scores.revenue_cents / 100).toFixed(2)} so far + $${(scores.predicted_cents / 100).toFixed(2)} predicted`} />
        <Stat label="Purchase likelihood" value={<span data-purchase={scores.purchase_likelihood}><Badge tone={scores.purchase_likelihood === 'high' ? 'green' : scores.purchase_likelihood === 'medium' ? 'amber' : 'gray'}>{scores.purchase_likelihood}</Badge></span>} sub={<span title={scores.explain.purchase.join(', ')}>{scores.purchase_score}/100 · {scores.explain.purchase.length ? scores.explain.purchase.slice(0, 2).map((x) => x.replace(/^\+\d+ /, '')).join(', ') : 'no buying signals yet'}</span>} />
        <Stat label="Churn risk" value={scores.churn_risk ? <span data-churn={scores.churn_risk}><Badge tone={scores.churn_risk === 'high' ? 'red' : scores.churn_risk === 'medium' ? 'amber' : 'green'}>{scores.churn_risk}</Badge></span> : <Muted>—</Muted>} sub={scores.churn_risk ? <span title={scores.explain.churn.join(', ')}>{scores.churn_score}/100{scores.explain.churn.length ? ' · ' + scores.explain.churn.slice(0, 2).map((x) => x.replace(/^\+\d+ /, '')).join(', ') : ''}</span> : 'paid subscribers only'} />
      </Stats>
    )}
    <div class="split">
      <div>
        <Card title="Engagement history" pad={false}>
          <Table<any> rows={history} empty="No emails sent to this subscriber yet." cols={[
            { h: 'Email', r: (h) => h.post_id ? <a href={`/app/posts/${h.post_id}`}>{h.post_title || h.subject}</a> : h.automation_id ? <span>{h.subject} <Muted>· {h.automation_name || 'automation'}</Muted></span> : <span>{h.subject}</span> },
            { h: 'Sent', r: (h) => <span class="small nowrap">{fmtDateTime(h.sent_at || h.created_at, pub.timezone)}</span> },
            { h: 'Delivery', r: (h) => <Status s={h.status} /> },
            { h: 'Opened', r: (h) => h.opened_at ? <span title={fmtDateTime(h.opened_at)}>✓ {h.open_count > 1 ? `×${h.open_count}` : ''}</span> : <Muted>—</Muted> },
            { h: 'Clicked', r: (h) => h.clicked_at ? <span title={fmtDateTime(h.clicked_at)}>✓ {h.click_count > 1 ? `×${h.click_count}` : ''}</span> : <Muted>—</Muted> },
          ]} />
        </Card>
        <Card title="Activity">
          {activity.length ? <ul class="timeline">{activity.map((a) => { const d = parseJSON<any>(a.data, {}); return <li><strong>{a.type.replace(/[._]/g, ' ')}</strong> {d.tag ? <Badge>{d.tag}</Badge> : null}{d.url ? <Muted> {String(d.url).slice(0, 80)}</Muted> : null}{d.source ? <Muted> via {d.source}</Muted> : null}<div class="small muted">{fmtDateTime(a.created_at, pub.timezone)}</div></li>; })}</ul> : <Help>No activity yet.</Help>}
        </Card>
        <Card title="Automation journeys" pad={false}>
          <Table<any> rows={runs} empty="Not enrolled in any automation." cols={[
            { h: 'Automation', r: (r) => <a href={`/app/automations/${r.automation_id}`}>{r.name}</a> },
            { h: 'Status', r: (r) => <Status s={r.status} /> },
            { h: 'Steps run', r: (r) => r.steps },
            { h: 'Next step', r: (r) => r.next_run_at && ['active', 'waiting'].includes(r.status) ? fmtDateTime(r.next_run_at, pub.timezone) : <Muted>—</Muted> },
            { h: 'Enrolled', r: (r) => ago(r.created_at) },
          ]} />
          {automations.length > 0 && (
            <form method="post" action={`/app/audience/s/${s.id}/action`} class="card-b row">
              <input type="hidden" name="do" value="enroll" />
              <Select name="automation_id" options={automations.map((a) => [a.id, a.name] as [string, string])} attrs={{ style: 'width:auto' }} />
              <Btn small kind="secondary">Enroll</Btn>
            </form>
          )}
        </Card>
        {(orders.length > 0 || subs.length > 0) && (
          <Card title="Purchases & subscriptions" pad={false}>
            <Table<any> rows={subs} empty="" cols={[{ h: 'Subscription', r: (x) => x.interval + 'ly' }, { h: 'Status', r: (x) => <Status s={x.status} /> }, { h: 'Amount', r: (x) => `${(x.amount_cents / 100).toFixed(2)} ${x.currency.toUpperCase()}` }, { h: 'Renews', r: (x) => fmtDate(x.current_period_end) }]} />
            <Table<any> rows={orders} empty="" cols={[{ h: 'Order', r: (o) => <span>{parseJSON<any>(o.data, {}).description || o.kind}</span> }, { h: 'Status', r: (o) => <Status s={o.status} /> }, { h: 'Amount', r: (o) => `${(o.amount_cents / 100).toFixed(2)} ${o.currency.toUpperCase()}` }, { h: 'Date', r: (o) => fmtDate(o.created_at) }]} />
          </Card>
        )}
        <StorePurchasesCard c={c} sub={s} />
        {(votes.length > 0 || responses.length > 0) && (
          <Card title="Poll & survey answers">
            <ul class="list-plain">
              {votes.map((v) => <li><Muted>Poll</Muted> <a href={`/app/audience/polls/${v.poll_id}`}>{v.question}</a> → <strong>{optLabel(v.options, v.option_id)}</strong> <Muted>· {v.channel} · {ago(v.created_at)}</Muted></li>)}
              {responses.map((r) => {
                const qs = parseJSON<any[]>(r.questions, []);
                const ans = parseJSON<Record<string, any>>(r.answers, {});
                return <li><Muted>Survey</Muted> <a href={`/app/audience/surveys/${r.survey_id}`}>{r.title}</a> <Muted>· {ago(r.created_at)}</Muted>
                  <dl class="kv small" style="margin-top:6px">{qs.filter((q) => ans[q.id] !== undefined).map((q) => <><dt>{q.label}</dt><dd>{Array.isArray(ans[q.id]) ? ans[q.id].join(', ') : String(ans[q.id])}</dd></>)}</dl></li>;
              })}
            </ul>
          </Card>
        )}
      </div>
      <div>
        <Card title="Subscriber signals" actions={sigOn ? <form method="post" action={`/app/audience/s/${s.id}/signals`} class="inline-form"><Btn small kind="ghost">Refresh</Btn></form> : undefined}>
          {!sigOn ? <Help>Subscriber Signals is off for this publication. <a href="/app/audience/top">Turn it on</a> to enrich readers with public profile data.</Help> : <div data-signals>
            {signals?.gravatar_status === 'found' && (
              <div class="row" style="gap:12px;flex-wrap:nowrap;margin-bottom:10px">
                {signals.avatar_url && <img src={signals.avatar_url} alt="" width="48" height="48" style="border-radius:50%;flex:none" loading="lazy" />}
                <div style="min-width:0">
                  <strong>{signals.display_name || s.name || s.email}</strong>
                  {(signals.job_title || signals.company) && <div class="small" data-job>{[signals.job_title, signals.company].filter(Boolean).join(' at ')}</div>}
                  {signals.location && <div class="small muted">{signals.location}</div>}
                </div>
              </div>
            )}
            <dl class="kv small">
              <dt>Email type</dt><dd data-business={dom.business ? '1' : '0'}>{dom.business ? <Badge tone="blue">business</Badge> : <Badge>personal</Badge>} <Muted>{dom.domain}</Muted></dd>
              {dom.organization && <><dt>Organization</dt><dd>{dom.organization}</dd></>}
              {(signals?.country || s.country) && <><dt>Country</dt><dd>{signals?.country || s.country}</dd></>}
              {signals && signals.socials.length > 0 && <><dt>Social</dt><dd>{signals.socials.map((x: { url: string; label: string }) => <a href={x.url} target="_blank" rel="noopener nofollow" class="badge b-gray" style="margin:0 4px 4px 0;text-decoration:none">{x.label}</a>)}</dd></>}
              {signals?.profile_url && <><dt>Profile</dt><dd><a href={signals.profile_url} target="_blank" rel="noopener nofollow">Public Gravatar profile ↗</a></dd></>}
            </dl>
            <Help>{!signals ? 'Looking up public signals in the background…' : signals.gravatar_status === 'found' ? `From their public Gravatar profile · checked ${ago(signals.updated_at)}` : signals.gravatar_status === 'none' ? `No public Gravatar profile · checked ${ago(signals.updated_at)}` : `Profile lookup pending · checked ${ago(signals.updated_at)}`}</Help>
          </div>}
        </Card>
        <Card title="Details">
          <form method="post" action={`/app/audience/s/${s.id}/update`}>
            <Field label="Email"><Input name="email" value={s.email} readonly /></Field>
            <Field label="Name"><Input name="name" value={s.name} /></Field>
            <Field label="Tier" hint={s.trial_ends_at && s.trial_ends_at > now() ? `Premium access until ${fmtDate(s.trial_ends_at)}` : 'Manually comp a reader. Paid subscriptions are managed in Monetize.'}><Select name="tier" value={s.tier} options={[['free', 'Free'], ['premium', 'Premium']]} /></Field>
            {fields.map((fd) => {
              const v = custom[fd.key];
              if (fd.kind === 'boolean') return <Field label={fd.label}><Select name={`custom[${fd.key}]`} value={v === true || v === 'true' ? 'true' : v === false || v === 'false' ? 'false' : ''} options={[['', '—'], ['true', 'Yes'], ['false', 'No']]} /></Field>;
              if (fd.kind === 'list') return <Field label={fd.label}><Select name={`custom[${fd.key}]`} value={v ?? ''} options={[['', '—'], ...parseJSON<string[]>(fd.options, []).map((o) => [o, o] as [string, string])]} /></Field>;
              return <Field label={fd.label}><Input name={`custom[${fd.key}]`} value={v ?? ''} type={fd.kind === 'number' ? 'number' : fd.kind === 'date' ? 'date' : 'text'} attrs={fd.kind === 'number' ? { step: 'any' } : undefined} /></Field>;
            })}
            {Object.keys(custom).filter((k) => !fields.some((fd) => fd.key === k)).map((k) => <Field label={k} hint="Not a defined custom field"><Input name={`custom[${k}]`} value={String(custom[k])} /></Field>)}
            <div class="form-actions"><Btn small>Save</Btn></div>
          </form>
        </Card>
        <Card title="Tags">
          <div class="row" style="margin-bottom:10px">{tags.length ? tags.map((t) => <form method="post" action={`/app/audience/s/${s.id}/tags`} class="inline-form"><input type="hidden" name="remove" value={t} /><button class="badge b-blue tag-x" title="Remove tag">{t} ✕</button></form>) : <Muted>No tags</Muted>}</div>
          <form method="post" action={`/app/audience/s/${s.id}/tags`} class="row">
            <Input name="add" placeholder="Add tags (comma separated)" list="tag-options" />
            <datalist id="tag-options">{allTags.map((t) => <option value={t.tag} />)}</datalist>
            <Btn small kind="secondary">Add</Btn>
          </form>
        </Card>
        <Card title="Newsletter lists">
          {lists.length ? (
            <form method="post" action={`/app/audience/s/${s.id}/lists`}>
              {lists.map((l) => <Check name="lists[]" value={l.id} label={l.name} checked={l.status === 'subscribed'} />)}
              <div class="form-actions"><Btn small kind="secondary">Save lists</Btn></div>
            </form>
          ) : <Help>No lists yet. <a href="/app/audience/lists">Create one</a>.</Help>}
        </Card>
        <Card title="Acquisition">
          <dl class="kv small">
            <dt>Source</dt><dd>{s.source.replace('_', ' ')}{sourceDetail ? ` · ${sourceDetail}` : ''}</dd>
            {s.utm_source && <><dt>UTM source</dt><dd>{s.utm_source}</dd></>}
            {s.utm_medium && <><dt>UTM medium</dt><dd>{s.utm_medium}</dd></>}
            {s.utm_campaign && <><dt>UTM campaign</dt><dd>{s.utm_campaign}</dd></>}
            {s.utm_term && <><dt>UTM term</dt><dd>{s.utm_term}</dd></>}
            {s.utm_content && <><dt>UTM content</dt><dd>{s.utm_content}</dd></>}
            {s.referrer_url && <><dt>Referrer</dt><dd class="truncate">{s.referrer_url}</dd></>}
            {s.landing_path && <><dt>Landing page</dt><dd>{s.landing_path}</dd></>}
            {s.country && <><dt>Country</dt><dd>{s.country}</dd></>}
            <dt>Subscribed</dt><dd>{fmtDateTime(s.created_at, pub.timezone)}</dd>
            <dt>Referred by</dt><dd>{referrer ? <a href={`/app/audience/s/${referrer.id}`}>{referrer.email}</a> : '—'}</dd>
          </dl>
          {referred.length > 0 && <><h4 style="margin-top:14px">Referred readers</h4><ul class="list-plain small">{referred.map((r) => <li><a href={`/app/audience/s/${r.id}`}>{r.email}</a> <Muted>{ago(r.created_at)}</Muted></li>)}</ul></>}
        </Card>
        <Card title="Gift premium access">
          <form method="post" action={`/app/audience/s/${s.id}/action`} class="row">
            <input type="hidden" name="do" value="gift" />
            <Input name="days" type="number" value="30" min="1" max="3650" attrs={{ style: 'width:90px' }} /><Muted>days</Muted>
            <Btn small kind="secondary">Gift</Btn>
          </form>
        </Card>
        <Card title="Community">
          {community ? <p>Member · <Status s={community.role} /> <Status s={community.status} /><br /><Muted>joined {ago(community.joined_at)}</Muted></p> : <Help>Not a community member.</Help>}
        </Card>
      </div>
    </div>
  </>);
});

// ───────── top subscribers (value score, CLV, purchase likelihood, churn risk) + Subscriber Signals setting ─────────
const LEVEL_TONE: Record<string, 'green' | 'amber' | 'red' | 'gray'> = { high: 'green', medium: 'amber', low: 'gray' };
const RISK_TONE: Record<string, 'green' | 'amber' | 'red' | 'gray'> = { high: 'red', medium: 'amber', low: 'green' };
const usd = (c: number) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const PresetBtn = (p: { preset: string; label: string }) => (
  <form method="post" action="/app/intel/segment" class="inline-form"><input type="hidden" name="preset" value={p.preset} /><Btn small kind="secondary">{p.label}</Btn></form>
);

app.get('/top', async (c) => {
  const pub = c.get('pub');
  const sortQ = c.req.query('sort');
  const sort = (['value', 'clv', 'purchase', 'churn'].includes(sortQ || '') ? sortQ : 'value') as 'value' | 'clv' | 'purchase' | 'churn';
  const [rows, summary, scoredAt, sigCount] = await Promise.all([
    topSubscribers(c.env, pub.id, { sort, limit: 50 }), predictionSummary(c.env, pub.id), lastScoredAt(c.env, pub.id),
    val<number>(c.env, `SELECT COUNT(*) FROM subscriber_signals WHERE pub_id = ? AND (gravatar_status = 'found' OR business_email = 1)`, pub.id),
  ]);
  if (!scoredAt) { await queueScoring(c.env, pub.id); kick(c.env, c.executionCtx); }
  const enabled = signalsEnabled(pub);
  const tabs: Array<[string, string]> = [['value', 'Most valuable'], ['clv', 'Lifetime value'], ['purchase', 'Likely to buy'], ['churn', 'Churn risk (paid)']];
  return page(c, {
    title: 'Top subscribers', sub: 'subscribers', crumbs: [['/app/audience', 'Subscribers']],
    actions: <>
      <form method="post" action="/app/audience/top/recompute" class="inline-form"><Btn small kind="secondary">Recompute now</Btn></form>
    </>,
  }, <>
    <Stats>
      <Stat label="Subscribers scored" value={num(summary.scored)} sub={scoredAt ? `updated ${ago(scoredAt)}` : 'computing in the background…'} />
      <Stat label="Avg customer lifetime value" value={usd(summary.avgClv)} sub={`${num(summary.customers)} paying readers`} href="/app/analytics/revenue#predictions" />
      <Stat label="Likely to buy" value={num(summary.purchase.high)} sub={`${num(summary.purchase.highNonBuyers)} have never bought`} href="/app/audience/top?sort=purchase" />
      <Stat label="Paid at high churn risk" value={num(summary.churn.high)} sub={`${usd(summary.churn.mrrAtRisk)}/mo at risk`} href="/app/audience/top?sort=churn" />
    </Stats>
    <div class="row" style="margin-bottom:12px;gap:6px;flex-wrap:wrap">
      {tabs.map(([k, l]) => <a class={`btn btn-sm ${k === sort ? 'btn-primary' : 'btn-ghost'}`} href={`/app/audience/top?sort=${k}`}>{l}</a>)}
      <span class="grow" />
      <Muted>Save as a segment:</Muted>
      <PresetBtn preset="top_10" label="Top 10%" />
      <PresetBtn preset="purchase_high" label="Likely buyers" />
      <PresetBtn preset="churn_high" label="At-risk paid" />
      {enabled && <PresetBtn preset="business" label="Business emails" />}
    </div>
    <Card pad={false}>
          <Table<any> rows={rows} rowHref={(x) => `/app/audience/s/${x.id}`} empty={<Empty title={scoredAt ? 'Nothing to rank here yet' : 'Scoring your subscribers…'} body={scoredAt ? (sort === 'churn' ? 'No paid subscribers yet.' : 'Scores appear once you have active subscribers.') : 'This runs in the background and takes a few seconds for most lists. Refresh in a moment.'} />} cols={[
            { h: '#', r: (x) => <span class="muted small">{rows.indexOf(x) + 1}</span>, class: 'w1' },
            { h: 'Subscriber', r: (x) => <span class="row" style="gap:8px;flex-wrap:nowrap">{x.avatar_url ? <img src={x.avatar_url} alt="" width="24" height="24" style="border-radius:50%;flex:none" loading="lazy" /> : null}<span style="min-width:0"><a href={`/app/audience/s/${x.id}`}>{x.name || x.email}</a>{(x.job_title || x.company) && <div class="muted small truncate">{[x.job_title, x.company].filter(Boolean).join(' · ')}</div>}</span></span> },
            { h: 'Value', r: (x) => <span title={`Percentile ${x.value_percentile}`}><strong>{x.value_score}</strong> <Muted>top {Math.max(1, 100 - x.value_percentile)}%</Muted></span>, class: 'right' },
            { h: 'Engagement', r: (x) => x.engagement, class: 'right' },
            { h: 'Referrals', r: (x) => x.referral_count, class: 'right' },
            { h: 'Revenue', r: (x) => (x.revenue_cents ? usd(x.revenue_cents) : <Muted>—</Muted>), class: 'right' },
            { h: 'CLV', r: (x) => (x.clv_cents ? usd(x.clv_cents) : <Muted>—</Muted>), class: 'right' },
            { h: 'Buy', r: (x) => <Badge tone={LEVEL_TONE[x.purchase_likelihood]}>{x.purchase_likelihood}</Badge> },
            { h: 'Churn', r: (x) => (x.churn_risk ? <Badge tone={RISK_TONE[x.churn_risk]}>{x.churn_risk}</Badge> : <Muted>free</Muted>) },
            { h: 'Last active', r: (x) => <span class="small nowrap">{x.last_active_at ? ago(x.last_active_at) : '—'}</span> },
          ]} />
    </Card>
    <div class="grid g2">
      <div>
        <Card title="How the scores work">
          <dl class="kv small">
            <dt>Value score</dt><dd>0–100: engagement ({VALUE_W.engagement}), revenue vs your top payers ({VALUE_W.revenue}), referrals ({VALUE_W.referrals}, full at {REFERRALS_FOR_FULL_SCORE}) and recency ({VALUE_W.recency}, full within 7 days of activity, zero after 90).</dd>
            <dt>Lifetime value</dt><dd>Revenue so far + predicted: monthly value × expected remaining months ({summary.expectedTenure.toFixed(1)} from your {(summary.monthlyChurn * 100).toFixed(1)}% monthly churn, max {MAX_TENURE_MONTHS}) × a churn-risk factor.</dd>
            <dt>Purchase likelihood</dt><dd>Points for engagement, site visits in 90 days, past purchases, recent activity and recent clicks. High ≥ {PURCHASE_HIGH}, medium ≥ {PURCHASE_MEDIUM}.</dd>
            <dt>Churn risk</dt><dd>Paid subscribers only: past-due payment, paused, trial ending, no opens in 30/60 days, low engagement, no site visits, new subscription. High ≥ {CHURN_HIGH}, medium ≥ {CHURN_MEDIUM}.</dd>
          </dl>
          <Help>Recomputed every few hours. Every score is also a segment field (Audience → Segments) so you can target or exclude these readers.</Help>
        </Card>
      </div>
      <div>
        <Card title="Subscriber Signals">
          <p class="small" style="margin-top:0">Enrich subscribers with free, <strong>public</strong> signals: their public Gravatar profile (name, photo, location, job title, company, verified social accounts), the organization behind a work email address, and country from data you already have. Nothing private is looked up.</p>
          <form method="post" action="/app/audience/top/signals">
            <Toggle name="enabled" checked={enabled} label="Enrich subscribers with public signals" hint={enabled ? `${num(sigCount)} subscribers have signals so far. Turning this off deletes stored signals.` : 'Off — no lookups are made and nothing is stored.'} />
            <div class="form-actions"><Btn small kind="secondary">Save</Btn></div>
          </form>
        </Card>
      </div>
    </div>
  </>);
});

app.post('/top/recompute', async (c) => {
  const pub = c.get('pub');
  const r = await scorePublication(c.env, pub.id, { budgetMs: 8000 });
  if (!r.done) { await enqueue(c.env, 'intel.scores', { pub_id: pub.id, after: r.after, started: now() }); kick(c.env, c.executionCtx); }
  return back(c, '/app/audience/top', r.done ? `Scored ${num(r.scored)} subscribers` : 'Scoring continues in the background');
});

app.post('/top/signals', requirePerm('admin'), async (c) => {
  const f = await form(c.req);
  const on = f.enabled === 'on';
  await setSignalsEnabled(c.env, c.get('pub').id, on);
  await audit(c, 'settings.subscriber_signals', undefined, { enabled: on });
  return back(c, '/app/audience/top', on ? 'Subscriber Signals turned on — enrichment runs in the background' : 'Subscriber Signals turned off and stored signals deleted');
});

app.post('/s/:id/signals', async (c) => {
  const pub = c.get('pub');
  const s = await loadSub(c);
  if (!s) return back(c, '/app/audience', 'Subscriber not found', 'err');
  if (!signalsEnabled(pub)) return back(c, `/app/audience/s/${s.id}`, 'Subscriber Signals is turned off for this publication', 'err');
  await enrichSubscriber(c.env, s, { force: true });
  return back(c, `/app/audience/s/${s.id}`, 'Signals refreshed');
});

app.post('/s/:id/update', async (c) => {
  const pub = c.get('pub');
  const s = await loadSub(c);
  if (!s) return back(c, '/app/audience', 'Subscriber not found', 'err');
  const f = await form(c.req);
  const custom: Record<string, unknown> = {};
  const defs = await all<any>(c.env, 'SELECT key, kind FROM custom_fields WHERE pub_id = ?', pub.id);
  for (const [k, v] of Object.entries(f)) {
    const m = k.match(/^custom\[([a-zA-Z0-9_]+)\]$/);
    if (!m) continue;
    const def = defs.find((d) => d.key === m[1]);
    const raw = str(v, 1000);
    custom[m[1]] = raw === '' ? null : def?.kind === 'number' ? Number(raw) : def?.kind === 'boolean' ? raw === 'true' : raw;
  }
  await run(c.env, 'UPDATE subscribers SET name = ?, updated_at = ? WHERE id = ?', str(f.name, 120), now(), s.id);
  if (Object.keys(custom).length) await setFields(c.env, pub.id, s.id, custom);
  const tier = f.tier === 'premium' ? 'premium' : 'free';
  if (tier !== s.tier) {
    await run(c.env, 'UPDATE subscribers SET tier = ?, trial_ends_at = NULL, updated_at = ? WHERE id = ?', tier, now(), s.id);
    await emit(c.env, { pubId: pub.id, type: tier === 'premium' ? 'subscription.upgraded' : 'subscription.downgraded', subscriberId: s.id, data: { manual: true, tier } });
  }
  await audit(c, 'subscriber.update', s.id);
  return back(c, `/app/audience/s/${s.id}`, 'Subscriber saved');
});

app.post('/s/:id/tags', async (c) => {
  const pub = c.get('pub');
  const s = await loadSub(c);
  if (!s) return back(c, '/app/audience', 'Subscriber not found', 'err');
  const f = await form(c.req);
  if (f.remove) await removeTags(c.env, pub.id, s.id, [str(f.remove)]);
  if (f.add) await addTags(c.env, pub.id, s.id, str(f.add).split(',').map((t) => t.trim()).filter(Boolean));
  return back(c, `/app/audience/s/${s.id}`, f.remove ? 'Tag removed' : 'Tags added');
});

app.post('/s/:id/lists', async (c) => {
  const pub = c.get('pub');
  const s = await loadSub(c);
  if (!s) return back(c, '/app/audience', 'Subscriber not found', 'err');
  const f = await form(c.req);
  const chosen: string[] = f.lists || [];
  const lists = await all<{ id: string }>(c.env, 'SELECT id FROM lists WHERE pub_id = ?', pub.id);
  await joinLists(c.env, pub.id, s.id, lists.filter((l) => chosen.includes(l.id)).map((l) => l.id));
  await leaveLists(c.env, pub.id, s.id, lists.filter((l) => !chosen.includes(l.id)).map((l) => l.id));
  return back(c, `/app/audience/s/${s.id}`, 'Lists updated');
});

app.post('/s/:id/action', async (c) => {
  const pub = c.get('pub');
  const s = await loadSub(c);
  if (!s) return back(c, '/app/audience', 'Subscriber not found', 'err');
  const f = await form(c.req);
  const to = `/app/audience/s/${s.id}`;
  switch (f.do) {
    case 'unsubscribe':
      await unsubscribe(c.env, pub.id, s.id, 'admin');
      await audit(c, 'subscriber.unsubscribe', s.id);
      return back(c, to, 'Unsubscribed');
    case 'resubscribe':
      await run(c.env, `UPDATE subscribers SET status = 'active', unsubscribed_at = NULL, unsubscribe_reason = NULL, updated_at = ? WHERE id = ?`, now(), s.id);
      await run(c.env, `DELETE FROM suppressions WHERE email = ? AND scope = 'pub' AND pub_id = ?`, s.email, pub.id);
      await emit(c.env, { pubId: pub.id, type: 'subscription.created', subscriberId: s.id, data: { resubscribed: true, by: 'admin' } });
      await audit(c, 'subscriber.resubscribe', s.id);
      return back(c, to, 'Resubscribed');
    case 'delete':
      if (!(await import('../../lib/auth')).can(c.get('role'), 'admin')) return back(c, to, 'Only admins can delete subscribers', 'err');
      await deleteSubscriber(c.env, pub.id, s.id);
      await run(c.env, 'DELETE FROM activity WHERE subscriber_id = ?', s.id);
      await audit(c, 'subscriber.delete', s.id, { email: s.email });
      return back(c, '/app/audience', `Deleted ${s.email}`);
    case 'confirm':
      await sendConfirmation(c.env, pub, s);
      return back(c, to, 'Confirmation email sent');
    case 'enroll': {
      const r = await enroll(c.env, str(f.automation_id), s.id, { source: 'manual' });
      return back(c, to, r.ok ? 'Enrolled in automation' : `Could not enroll: ${r.reason}`, r.ok ? 'ok' : 'err');
    }
    case 'gift': {
      const days = Math.min(3650, Math.max(1, int(f.days, 30)));
      const until = Math.max(now(), s.trial_ends_at || 0) + days * DAY;
      await run(c.env, `UPDATE subscribers SET tier = 'premium', trial_ends_at = ?, updated_at = ? WHERE id = ?`, until, now(), s.id);
      await emit(c.env, { pubId: pub.id, type: 'subscription.upgraded', subscriberId: s.id, data: { gift_days: days, manual: true } });
      await audit(c, 'subscriber.gift', s.id, { days });
      return back(c, to, `Gifted ${days} days of premium`);
    }
  }
  return back(c, to, 'Unknown action', 'err');
});

export default app;
export { enqueue };
