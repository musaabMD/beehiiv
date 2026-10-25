// Automations engine. Steps are a tree; a run's position is a path like [2,'yes',0].
// Live steps run while a separate draft is edited (automations.draft_steps); publishing swaps them in.
import type { Env, Publication, Subscriber } from '../types';
import { one, all, run, insert } from './db';
import { emit, onEvent, type BusEvent } from './events';
import { registerPeriodic, registerJob, enqueue, logError } from './jobs';
import { addTags, removeTags, setFields, joinLists, leaveLists, unsubscribe } from './subscribers';
import { subscriberMatches, compile, type RuleGroup } from './segments';
import { callWebhook } from './webhooks';
import { deliver, type Content } from './sender';
import { getPub, senderFor } from './pub';
import { sendTransactional } from './email';
import { id, now, parseJSON, MIN, HOUR, DAY, sha256, esc } from './util';

export interface Step { id: string; type: string; config: any; yes?: Step[]; no?: Step[] }
export type Path = Array<number | 'yes' | 'no'>;

export const TRIGGERS: Record<string, { label: string; event?: string; fields?: string[] }> = {
  signup: { label: 'Subscriber signs up', event: 'subscription.created', fields: ['sources', 'source_details'] },
  confirmed: { label: 'Subscriber confirms email', event: 'subscription.confirmed' },
  welcome: { label: 'Welcome (new subscriber, after confirmation)', event: 'subscriber.welcome' },
  tag_added: { label: 'Tag is added', event: 'tag.added', fields: ['tag'] },
  field_updated: { label: 'Custom field is updated', event: 'field.updated', fields: ['key'] },
  list_subscribed: { label: 'Joins a newsletter list', event: 'list.subscribed', fields: ['list_id'] },
  upgraded: { label: 'Upgrades to paid', event: 'subscription.upgraded', fields: ['tier_id'] },
  downgraded: { label: 'Downgrades / cancels', event: 'subscription.downgraded' },
  purchase: { label: 'Purchases a product', event: 'order.paid', fields: ['product_id'] },
  event_registered: { label: 'Registers for an event', event: 'event.registered', fields: ['event_id'] },
  survey_submitted: { label: 'Submits a survey', event: 'survey.response_submitted', fields: ['survey_id'] },
  poll_voted: { label: 'Votes in a poll', event: 'poll.vote', fields: ['poll_id'] },
  email_opened: { label: 'Opens an email', event: 'email.opened', fields: ['post_id'] },
  link_clicked: { label: 'Clicks a link', event: 'email.clicked', fields: ['post_id', 'url_contains'] },
  referral_milestone: { label: 'Reaches a referral milestone', event: 'referral.milestone' },
  segment_entered: { label: 'Enters a segment', fields: ['segment_id'] },
  date_field: { label: 'Date in custom field (birthday, renewal…)', fields: ['key', 'offset_days'] },
  inactive: { label: 'Becomes inactive (no opens for N days)', fields: ['days'] },
  api: { label: 'Enrolled via API or manually' },
};

export const STEP_TYPES: Record<string, string> = {
  send_email: 'Send email', delay: 'Wait for a time', wait_until: 'Wait until…', condition: 'If / else branch', ab_split: 'Random split',
  add_tag: 'Add tag', remove_tag: 'Remove tag', update_field: 'Update custom field', add_to_list: 'Add to list', remove_from_list: 'Remove from list',
  webhook: 'Call webhook', enroll: 'Enroll in another automation', grant_premium: 'Grant premium access', notify: 'Notify team', unsubscribe: 'Unsubscribe', exit: 'Exit automation',
};

export function getAt(steps: Step[], path: Path): Step | null {
  let list: Step[] = steps;
  let cur: Step | null = null;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (typeof p === 'number') { cur = list[p] ?? null; if (!cur) return null; }
    else { list = (cur as any)?.[p] || []; }
  }
  return cur;
}

/** Path of the step after `path` (depth-first, branches rejoin their parent). null = finished. */
export function nextPath(steps: Step[], path: Path): Path | null {
  const p = [...path];
  while (p.length) {
    const idx = p[p.length - 1] as number;
    const parentList = p.length === 1 ? steps : ((getAt(steps, p.slice(0, -2)) as any)?.[p[p.length - 2]] || []);
    if (idx + 1 < parentList.length) { p[p.length - 1] = idx + 1; return p; }
    p.splice(-2, 2); // climb to the branch owner, then continue after it
    if (!p.length) return null;
    const ownerIdx = p[p.length - 1] as number;
    const ownerList = p.length === 1 ? steps : ((getAt(steps, p.slice(0, -2)) as any)?.[p[p.length - 2]] || []);
    if (ownerIdx + 1 < ownerList.length) { p[p.length - 1] = ownerIdx + 1; return p; }
  }
  return null;
}

export function findPathById(steps: Step[], stepId: string, base: Path = []): Path | null {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.id === stepId) return [...base, i];
    for (const br of ['yes', 'no'] as const) {
      if (s[br]?.length) { const f = findPathById(s[br]!, stepId, [...base, i, br]); if (f) return f; }
    }
  }
  return null;
}

export function walk(steps: Step[], fn: (s: Step) => void) {
  for (const s of steps) { fn(s); if (s.yes) walk(s.yes, fn); if (s.no) walk(s.no, fn); }
}

// ───────── enrollment ─────────
export async function enroll(env: Env, automationId: string, subscriberId: string, data: Record<string, unknown> = {}, opts: { force?: boolean } = {}): Promise<{ ok: boolean; runId?: string; reason?: string }> {
  const a = await one<any>(env, 'SELECT * FROM automations WHERE id = ?', automationId);
  if (!a) return { ok: false, reason: 'automation not found' };
  if (a.status !== 'active' && !opts.force) return { ok: false, reason: 'automation is not active' };
  const sub = await one<Subscriber>(env, 'SELECT * FROM subscribers WHERE id = ? AND pub_id = ?', subscriberId, a.pub_id);
  if (!sub) return { ok: false, reason: 'subscriber not found' };
  if (['unsubscribed', 'bounced', 'complained'].includes(sub.status)) return { ok: false, reason: 'subscriber is not active' };
  const existing = await one<any>(env, `SELECT id, status FROM automation_runs WHERE automation_id = ? AND subscriber_id = ? ORDER BY created_at DESC LIMIT 1`, automationId, subscriberId);
  if (existing && (['active', 'waiting'].includes(existing.status) || !a.allow_reentry)) return { ok: false, reason: 'already enrolled' };
  const steps = parseJSON<Step[]>(a.steps, []);
  const rid = id();
  await insert(env, 'automation_runs', { id: rid, automation_id: a.id, pub_id: a.pub_id, subscriber_id: sub.id, status: steps.length ? 'active' : 'completed', step_path: '[0]', next_run_at: now(), data: JSON.stringify(data), created_at: now(), updated_at: now() });
  await log(env, rid, a.id, null, 'enrolled', JSON.stringify(data).slice(0, 300));
  await emit(env, { pubId: a.pub_id, type: 'automation.enrolled', subscriberId: sub.id, refId: a.id, data: { automation: a.name } });
  if (steps.length) await processRun(env, rid);
  return { ok: true, runId: rid };
}

async function log(env: Env, runId: string, automationId: string, stepId: string | null, action: string, result = '') {
  await insert(env, 'automation_logs', { id: id(), run_id: runId, automation_id: automationId, step_id: stepId, action, result: result.slice(0, 1000), created_at: now() });
}

/** Get (or create) the `sends` row that tracks opens/clicks for an automation email step. */
async function stepSend(env: Env, pubId: string, automationId: string, step: Step): Promise<string> {
  const row = await one<{ id: string }>(env, 'SELECT id FROM sends WHERE automation_id = ? AND step_id = ?', automationId, step.id);
  if (row) {
    await run(env, 'UPDATE sends SET subject = ?, total = total + 1 WHERE id = ?', step.config?.subject || '(no subject)', row.id);
    return row.id;
  }
  const sid = id();
  await insert(env, 'sends', { id: sid, pub_id: pubId, automation_id: automationId, step_id: step.id, kind: 'automation', subject: step.config?.subject || '(no subject)', status: 'sending', total: 1, created_at: now(), started_at: now() });
  return sid;
}

function waitMs(c: any): number {
  const n = Math.max(0, Number(c?.amount) || 0);
  return n * (c?.unit === 'minutes' ? MIN : c?.unit === 'hours' ? HOUR : c?.unit === 'weeks' ? 7 * DAY : DAY);
}

/** Next occurrence of weekday/time in a timezone offset (approx: uses UTC when tz math unavailable). */
function nextWeekdayTime(weekdays: number[], time: string): number {
  const [hh, mm] = (time || '09:00').split(':').map(Number);
  const d = new Date();
  for (let i = 0; i < 8; i++) {
    const c = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + i, hh || 0, mm || 0));
    if (c.getTime() > Date.now() && (!weekdays?.length || weekdays.includes(c.getUTCDay()))) return c.getTime();
  }
  return Date.now() + DAY;
}

export async function processRun(env: Env, runId: string): Promise<void> {
  for (let guard = 0; guard < 60; guard++) {
    const r = await one<any>(env, 'SELECT * FROM automation_runs WHERE id = ?', runId);
    if (!r || !['active', 'waiting'].includes(r.status)) return;
    if (r.next_run_at && r.next_run_at > now()) return;
    const a = await one<any>(env, 'SELECT * FROM automations WHERE id = ?', r.automation_id);
    if (!a || a.status === 'archived') { await run(env, `UPDATE automation_runs SET status = 'exited', updated_at = ? WHERE id = ?`, now(), runId); return; }
    if (a.status === 'paused') return;
    const steps = parseJSON<Step[]>(a.steps, []);
    const path = parseJSON<Path>(r.step_path, [0]);
    const step = getAt(steps, path);
    const sub = await one<Subscriber>(env, 'SELECT * FROM subscribers WHERE id = ?', r.subscriber_id);
    if (!step) { await run(env, `UPDATE automation_runs SET status = 'completed', next_run_at = NULL, updated_at = ? WHERE id = ?`, now(), runId); await log(env, runId, a.id, null, 'completed'); return; }
    if (!sub || ['unsubscribed', 'bounced', 'complained'].includes(sub.status)) { await run(env, `UPDATE automation_runs SET status = 'exited', updated_at = ? WHERE id = ?`, now(), runId); await log(env, runId, a.id, step.id, 'exited', 'subscriber inactive'); return; }
    const pub = (await getPub(env, a.pub_id))!;
    const data = parseJSON<Record<string, any>>(r.data, {});
    let next: Path | null = nextPath(steps, path);
    let waitUntil: number | null = null;
    let result = 'ok';
    const c = step.config || {};
    try {
      switch (step.type) {
        case 'send_email': {
          const sendId = await stepSend(env, pub.id, a.id, step);
          const from = await senderFor(env, pub, 'automations', c.sender_id);
          const content: Content = { title: c.title || '', subtitle: c.subtitle || '', doc: c.doc || { blocks: [] }, preview_text: c.preview_text || '', style: c.style ? JSON.stringify(c.style) : null, hideHeader: !c.title };
          const res = await deliver(env, pub, sendId, sub, c.subject || pub.name, content, from);
          result = res.result.status;
          await run(env, `UPDATE sends SET sent = (SELECT COUNT(*) FROM deliveries WHERE send_id = ? AND status IN ('sent','deferred')) WHERE id = ?`, sendId, sendId);
          break;
        }
        case 'delay': waitUntil = now() + waitMs(c); result = `waiting ${c.amount} ${c.unit}`; break;
        case 'wait_until': {
          if (c.mode === 'condition') {
            const ok = await subscriberMatches(env, pub.id, c.rules as RuleGroup, sub.id);
            const started = data['wait_' + step.id] || now();
            if (!ok) {
              if (now() - started > (Number(c.timeout_days) || 7) * DAY) { result = 'timeout'; break; }
              data['wait_' + step.id] = started;
              await run(env, 'UPDATE automation_runs SET data = ? WHERE id = ?', JSON.stringify(data), runId);
              waitUntil = now() + HOUR; next = path; result = 'condition not met yet';
            }
          } else if (c.mode === 'weekday_time') {
            if (!data['wait_' + step.id]) {
              data['wait_' + step.id] = nextWeekdayTime(c.weekdays || [], c.time);
              await run(env, 'UPDATE automation_runs SET data = ? WHERE id = ?', JSON.stringify(data), runId);
            }
            if (now() < data['wait_' + step.id]) { waitUntil = data['wait_' + step.id]; next = path; }
          } else {
            const at = Date.parse(c.at);
            if (!isNaN(at) && now() < at) { waitUntil = at; next = path; }
          }
          break;
        }
        case 'condition': {
          const ok = await subscriberMatches(env, pub.id, (c.rules || { op: 'and', rules: [] }) as RuleGroup, sub.id);
          const br = ok ? 'yes' : 'no';
          result = br;
          if ((step as any)[br]?.length) next = [...path, br, 0];
          break;
        }
        case 'ab_split': {
          const h = parseInt((await sha256(runId + step.id)).slice(0, 6), 16) % 100;
          const br = h < (Number(c.pct) || 50) ? 'yes' : 'no';
          result = br === 'yes' ? 'path A' : 'path B';
          if ((step as any)[br]?.length) next = [...path, br, 0];
          break;
        }
        case 'add_tag': await addTags(env, pub.id, sub.id, [].concat(c.tags || c.tag || [])); break;
        case 'remove_tag': await removeTags(env, pub.id, sub.id, [].concat(c.tags || c.tag || [])); break;
        case 'update_field': await setFields(env, pub.id, sub.id, { [c.key]: c.value }); break;
        case 'add_to_list': await joinLists(env, pub.id, sub.id, [c.list_id]); break;
        case 'remove_from_list': await leaveLists(env, pub.id, sub.id, [c.list_id]); break;
        case 'unsubscribe': await unsubscribe(env, pub.id, sub.id, 'automation'); next = null; break;
        case 'grant_premium': {
          const days = Number(c.days) || 7;
          await run(env, `UPDATE subscribers SET tier = 'premium', trial_ends_at = ?, updated_at = ? WHERE id = ?`, now() + days * DAY, now(), sub.id);
          result = `premium for ${days} days`;
          break;
        }
        case 'enroll': {
          const res = await enroll(env, c.automation_id, sub.id, { from: a.id });
          result = res.ok ? 'enrolled' : res.reason || 'skipped';
          break;
        }
        case 'notify': {
          await sendTransactional(env, c.email, c.subject || `Automation: ${a.name}`, `<p>${esc(c.body || 'A subscriber reached this step.')}</p><p><strong>${esc(sub.email)}</strong> ${esc(sub.name)}</p>`, pub);
          break;
        }
        case 'webhook': {
          const attempts = Number(data['wh_' + step.id] || 0);
          const payload = { automation: { id: a.id, name: a.name }, step_id: step.id, subscriber: { id: sub.id, email: sub.email, name: sub.name, tier: sub.tier, custom: parseJSON(sub.custom, {}) }, data, ...(c.body ? parseJSON(c.body, {}) : {}) };
          const res = await callWebhook(c.url, c.method || 'POST', payload, c.secret);
          result = `HTTP ${res.status}`;
          if (!res.ok) {
            if (attempts < 5) {
              data['wh_' + step.id] = attempts + 1;
              await run(env, 'UPDATE automation_runs SET data = ? WHERE id = ?', JSON.stringify(data), runId);
              waitUntil = now() + [MIN, 5 * MIN, 30 * MIN, 2 * HOUR, 6 * HOUR][attempts];
              next = path;
              result += ` — retry ${attempts + 1}/5`;
            } else result += ' — gave up after 5 retries';
          }
          break;
        }
        case 'exit': next = null; break;
        default: result = 'unknown step type';
      }
    } catch (e: any) {
      await logError(env, 'automation.step', e, pub.id);
      result = 'error: ' + (e?.message || e);
    }
    await log(env, runId, a.id, step.id, step.type, result);
    if (next === null) {
      await run(env, `UPDATE automation_runs SET status = 'completed', next_run_at = NULL, updated_at = ? WHERE id = ?`, now(), runId);
      await log(env, runId, a.id, null, 'completed');
      return;
    }
    if (waitUntil) {
      await run(env, `UPDATE automation_runs SET status = 'waiting', step_path = ?, next_run_at = ?, updated_at = ? WHERE id = ?`, JSON.stringify(step.type === 'delay' ? next : next), waitUntil, now(), runId);
      return;
    }
    await run(env, `UPDATE automation_runs SET status = 'active', step_path = ?, next_run_at = ?, updated_at = ? WHERE id = ?`, JSON.stringify(next), now(), now(), runId);
  }
}

// ───────── triggers ─────────
function triggerMatches(trigger: any, e: BusEvent): boolean {
  const def = TRIGGERS[trigger.type];
  if (!def || def.event !== e.type) return false;
  const c = trigger.config || {};
  const d: any = e.data || {};
  switch (trigger.type) {
    case 'signup':
      if (c.sources?.length && !c.sources.includes(d.source)) return false;
      if (c.source_details?.length && !c.source_details.includes(d.source_detail)) return false;
      return true;
    case 'tag_added': return !c.tag || String(c.tag).toLowerCase() === d.tag;
    case 'field_updated': return !c.key || Object.prototype.hasOwnProperty.call(d.fields || {}, c.key);
    case 'list_subscribed': return !c.list_id || c.list_id === d.list_id;
    case 'upgraded': return !c.tier_id || c.tier_id === d.tier_id;
    case 'purchase': return d.kind === 'product' || d.kind === 'replay' ? !c.product_id || c.product_id === d.ref_id : false;
    case 'event_registered': return !c.event_id || c.event_id === d.event_id;
    case 'survey_submitted': return !c.survey_id || c.survey_id === d.survey_id;
    case 'poll_voted': return !c.poll_id || c.poll_id === d.poll_id;
    case 'email_opened': return !c.post_id || c.post_id === d.post_id;
    case 'link_clicked': return (!c.post_id || c.post_id === d.post_id) && (!c.url_contains || String(d.url || '').includes(c.url_contains));
    default: return true;
  }
}

onEvent(async (env, e) => {
  if (!e.subscriberId) return;
  if (!Object.values(TRIGGERS).some((t) => t.event === e.type)) return;
  const autos = await all<any>(env, `SELECT id, trigger FROM automations WHERE pub_id = ? AND status = 'active'`, e.pubId);
  for (const a of autos) {
    const trig = parseJSON<any>(a.trigger, {});
    if (trig.filter?.rules?.length && !(await subscriberMatches(env, e.pubId, trig.filter, e.subscriberId))) continue;
    if (triggerMatches(trig, e)) await enroll(env, a.id, e.subscriberId, { trigger: e.type, ...(e.data || {}) });
  }
});

// Due runs (delays, waits, webhook retries)
registerPeriodic('automations.runs', MIN - 5000, async (env) => {
  const due = await all<{ id: string }>(env, `SELECT id FROM automation_runs WHERE status IN ('active','waiting') AND next_run_at <= ? ORDER BY next_run_at LIMIT 200`, now());
  for (const r of due) await processRun(env, r.id);
});

// Polling triggers: segment entry, date fields, inactivity
registerPeriodic('automations.poll_triggers', 15 * MIN, async (env) => {
  const autos = await all<any>(env, `SELECT id, pub_id, trigger FROM automations WHERE status = 'active'`);
  for (const a of autos) {
    const trig = parseJSON<any>(a.trigger, {});
    const c = trig.config || {};
    let g: RuleGroup | null = null;
    if (trig.type === 'segment_entered' && c.segment_id) g = { op: 'and', rules: [{ field: 'segment', cmp: 'in', value: c.segment_id }] };
    else if (trig.type === 'inactive') g = { op: 'and', rules: [{ field: 'last_open_at', cmp: 'not_within_days', value: Number(c.days) || 30 }, { field: 'created_at', cmp: 'older_than_days', value: Number(c.days) || 30 }] };
    if (g) {
      g.rules.push({ field: 'automation', cmp: 'not_started', value: a.id });
      const cc = await compile(env, a.pub_id, g);
      const subs = await all<{ id: string }>(env, `SELECT s.id FROM subscribers s WHERE s.pub_id = ? AND s.status = 'active' AND (${cc.sql}) LIMIT 500`, a.pub_id, ...cc.params);
      for (const s of subs) await enroll(env, a.id, s.id, { trigger: trig.type });
    }
    if (trig.type === 'date_field' && c.key) {
      const key = String(c.key).replace(/[^a-zA-Z0-9_]/g, '');
      const offset = Number(c.offset_days) || 0;
      const target = new Date(Date.now() - offset * DAY).toISOString().slice(5, 10); // MM-DD (anniversary style)
      const subs = await all<{ id: string }>(env, `SELECT id FROM subscribers WHERE pub_id = ? AND status = 'active' AND substr(json_extract(custom, '$.${key}'), 6, 5) = ?`, a.pub_id, target);
      for (const s of subs) {
        const today = new Date().toISOString().slice(0, 10);
        const already = await one(env, `SELECT 1 FROM automation_runs WHERE automation_id = ? AND subscriber_id = ? AND json_extract(data, '$.date') = ?`, a.id, s.id, today);
        if (!already) {
          await run(env, `UPDATE automations SET allow_reentry = 1 WHERE id = ?`, a.id);
          await enroll(env, a.id, s.id, { trigger: 'date_field', date: today });
        }
      }
    }
  }
});

registerJob('automation.enroll', async (env, p) => {
  await enroll(env, p.automation_id, p.subscriber_id, p.data || {});
});

/** Draft workflow helpers */
export async function publishDraft(env: Env, automationId: string, pubId: string) {
  const a = await one<any>(env, 'SELECT * FROM automations WHERE id = ? AND pub_id = ?', automationId, pubId);
  if (!a) return;
  await run(env, `UPDATE automations SET trigger = COALESCE(draft_trigger, trigger), steps = COALESCE(draft_steps, steps), draft_trigger = NULL, draft_steps = NULL, published_at = ?, updated_at = ? WHERE id = ?`, now(), now(), automationId);
  // Re-anchor in-flight runs by step id so live journeys survive edits.
  const oldSteps = parseJSON<Step[]>(a.steps, []);
  const newSteps = parseJSON<Step[]>(a.draft_steps || a.steps, []);
  const runs = await all<any>(env, `SELECT id, step_path FROM automation_runs WHERE automation_id = ? AND status IN ('active','waiting')`, automationId);
  for (const r of runs) {
    const cur = getAt(oldSteps, parseJSON<Path>(r.step_path, [0]));
    const np = cur ? findPathById(newSteps, cur.id) : null;
    if (np) await run(env, 'UPDATE automation_runs SET step_path = ? WHERE id = ?', JSON.stringify(np), r.id);
    else await run(env, `UPDATE automation_runs SET status = 'exited', updated_at = ? WHERE id = ?`, now(), r.id);
  }
}

export { enqueue };
