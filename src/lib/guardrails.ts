// Experiment guardrails: owner-set limits for automation A/B splits and newsletter A/B / multivariate tests.
// - max unsubscribe rate, max complaint rate (per arm), min revenue per recipient vs the control arm
// - when an arm breaches (with at least `min_sample` recipients), it is stopped and everyone is routed to the safe arm
//   (the control, unless the control itself is harmful), with a logged plain-English explanation (guardrail_events).
// Engine hooks are tiny and live in the engines: automations.ts reads `config.guardrail.route` on ab_split steps;
// sender.ts calls beforeWinner() in the A/B winner job. Everything else is here (periodic check every 5 minutes).
import type { Env } from '../types';
import { one, all, run, insert } from './db';
import { registerPeriodic, enqueue, logError } from './jobs';
import { getAt, nextPath, walk, type Step, type Path } from './automations';
import { id, now, parseJSON, DAY, MIN } from './util';

export interface GuardrailConfig {
  enabled: boolean;
  /** stop an arm whose unsubscribe rate is above this (percent of its recipients) */
  max_unsub_pct: number;
  /** stop an arm whose spam-complaint rate is above this (percent) */
  max_complaint_pct: number;
  /** stop a variant whose revenue per recipient is below this percent of the control's (0 = off) */
  min_rpr_pct: number;
  /** minimum recipients per arm before judging */
  min_sample: number;
  /** attribution window for unsubscribes, complaints and revenue after the email / split */
  window_days: number;
  /** control arm: 'A' (path A / first variant) or 'B' */
  control: string;
}

export const DEFAULT_GUARDRAIL: GuardrailConfig = { enabled: false, max_unsub_pct: 2, max_complaint_pct: 0.1, min_rpr_pct: 0, min_sample: 100, window_days: 7, control: 'A' };

export function normalizeGuardrail(input: any, base: GuardrailConfig = DEFAULT_GUARDRAIL): GuardrailConfig {
  const n = (v: any, lo: number, hi: number, d: number) => { const x = Number(v); return v === '' || v === null || v === undefined || !isFinite(x) ? d : Math.min(hi, Math.max(lo, x)); };
  const i = input || {};
  return {
    enabled: i.enabled === undefined ? base.enabled : !!i.enabled && i.enabled !== '0' && i.enabled !== 'false',
    max_unsub_pct: n(i.max_unsub_pct, 0, 100, base.max_unsub_pct),
    max_complaint_pct: n(i.max_complaint_pct, 0, 100, base.max_complaint_pct),
    min_rpr_pct: n(i.min_rpr_pct, 0, 100, base.min_rpr_pct),
    min_sample: Math.round(n(i.min_sample, 1, 1_000_000, base.min_sample)),
    window_days: Math.round(n(i.window_days, 1, 90, base.window_days)),
    control: /^[A-E]$/.test(String(i.control || '').toUpperCase()) ? String(i.control).toUpperCase() : base.control,
  };
}

/** Guardrail config for an experiment: per-experiment row, else (newsletters) the publication default. */
export async function guardrailFor(env: Env, pubId: string, kind: 'post' | 'automation', refId: string): Promise<GuardrailConfig | null> {
  const own = await one<{ config: string }>(env, 'SELECT config FROM experiment_guardrails WHERE pub_id = ? AND kind = ? AND ref_id = ?', pubId, kind, refId);
  if (own) return normalizeGuardrail(parseJSON(own.config, {}));
  if (kind === 'post') {
    const def = await one<{ config: string }>(env, `SELECT config FROM experiment_guardrails WHERE pub_id = ? AND kind = 'default' AND ref_id = ''`, pubId);
    if (def) return normalizeGuardrail(parseJSON(def.config, {}));
  }
  return null;
}

export async function saveGuardrail(env: Env, pubId: string, kind: 'default' | 'post' | 'automation', refId: string, cfg: GuardrailConfig) {
  await run(env, `INSERT INTO experiment_guardrails (id, pub_id, kind, ref_id, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pub_id, kind, ref_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`, id(), pubId, kind, refId, JSON.stringify(cfg), now(), now());
}

export async function removeGuardrail(env: Env, pubId: string, kind: 'default' | 'post' | 'automation', refId: string) {
  await run(env, 'DELETE FROM experiment_guardrails WHERE pub_id = ? AND kind = ? AND ref_id = ?', pubId, kind, refId);
}

// ───────── decision ─────────
export interface ArmStats { arm: string; n: number; unsubs: number; complaints: number; revenue_cents: number }
export interface Verdict { stop: string[]; safe: string; reasons: Record<string, string[]>; allBreached: boolean; explanation: string }

const pctOf = (a: number, b: number) => (b ? (a / b) * 100 : 0);
const fmtPct = (x: number) => (x >= 1 ? x.toFixed(1) : x.toFixed(2)).replace(/\.?0+$/, '') + '%';
const money = (c: number) => '$' + (c / 100).toFixed(2);

/** Pure decision: which arms breach the guardrails and which arm is safe. null = nothing to do. */
export function judge(arms: ArmStats[], cfg: GuardrailConfig, label: (arm: string) => string = (a) => a): Verdict | null {
  if (!cfg.enabled || arms.length < 2) return null;
  const control = arms.find((a) => a.arm === cfg.control) || arms[0];
  const rpr = (a: ArmStats) => (a.n ? a.revenue_cents / a.n : 0);
  const reasons: Record<string, string[]> = {};
  for (const a of arms) {
    if (a.n < cfg.min_sample) continue;
    const r: string[] = [];
    const ur = pctOf(a.unsubs, a.n), cr = pctOf(a.complaints, a.n);
    if (ur > cfg.max_unsub_pct) r.push(`unsubscribe rate ${fmtPct(ur)} (${a.unsubs} of ${a.n}) is above your ${fmtPct(cfg.max_unsub_pct)} limit`);
    if (cr > cfg.max_complaint_pct) r.push(`spam-complaint rate ${fmtPct(cr)} (${a.complaints} of ${a.n}) is above your ${fmtPct(cfg.max_complaint_pct)} limit`);
    if (a !== control && cfg.min_rpr_pct > 0 && control.n >= cfg.min_sample && rpr(control) > 0 && rpr(a) < (rpr(control) * cfg.min_rpr_pct) / 100) {
      r.push(`revenue per recipient ${money(rpr(a))} is below ${fmtPct(cfg.min_rpr_pct)} of the control's ${money(rpr(control))}`);
    }
    if (r.length) reasons[a.arm] = r;
  }
  const breached = Object.keys(reasons);
  if (!breached.length) return null;
  const ok = arms.filter((a) => !reasons[a.arm]);
  const allBreached = !ok.length;
  // safe arm: the control when it's fine; else the best healthy arm (revenue, then fewest complaints/unsubs);
  // when every arm breached, the least harmful one.
  const score = (a: ArmStats) => [pctOf(a.complaints, a.n), pctOf(a.unsubs, a.n), -rpr(a)];
  const leastHarm = [...arms].sort((x, y) => { const a = score(x), b = score(y); return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; })[0];
  const safe = !reasons[control.arm] ? control : ok.length ? [...ok].sort((x, y) => rpr(y) - rpr(x) || pctOf(x.complaints, x.n) - pctOf(y.complaints, y.n) || pctOf(x.unsubs, x.n) - pctOf(y.unsubs, y.n))[0] : leastHarm;
  const stop = arms.map((a) => a.arm).filter((a) => a !== safe.arm);
  const why = breached.map((a) => `${label(a)}: ${reasons[a].join('; ')}`).join('. ');
  const explanation = `${why}. Stopped ${stop.map(label).join(', ')} and routed everyone to ${label(safe.arm)}${safe.arm === control.arm ? ' (the control)' : ''}.`
    + (allBreached ? ` Every arm breached a guardrail — ${label(safe.arm)} is the least harmful; consider pausing this experiment.` : '');
  return { stop, safe: safe.arm, reasons, allBreached, explanation };
}

async function logEvent(env: Env, e: { pubId: string; kind: 'post' | 'automation'; refId: string; target: string; stopped: string; safe: string; explanation: string; metrics: unknown; moved?: number }) {
  await insert(env, 'guardrail_events', { id: id(), pub_id: e.pubId, kind: e.kind, ref_id: e.refId, target: e.target, stopped: e.stopped, safe: e.safe, explanation: e.explanation.slice(0, 2000), metrics: JSON.stringify(e.metrics), moved: e.moved || 0, created_at: now() });
}

// ───────── metrics ─────────
const revenueSql = (subCol: string, fromCol: string) => `(
  COALESCE((SELECT SUM(o.amount_cents) FROM orders o WHERE o.subscriber_id = ${subCol} AND o.status = 'paid' AND o.paid_at >= ${fromCol} AND o.paid_at < ${fromCol} + ?), 0) +
  COALESCE((SELECT SUM(x.total_cents) FROM external_orders x WHERE x.subscriber_id = ${subCol} AND x.status = 'paid' AND x.paid_at >= ${fromCol} AND x.paid_at < ${fromCol} + ?), 0))`;

/** Per-variant stats for a newsletter send (letters A–E). */
export async function sendArmStats(env: Env, sendId: string, windowDays: number): Promise<ArmStats[]> {
  const w = windowDays * DAY;
  const rows = await all<any>(env, `SELECT substr(d.variant,1,1) AS arm, COUNT(*) AS n,
      SUM(CASE WHEN s.status = 'unsubscribed' AND s.unsubscribed_at >= d.sent_at AND s.unsubscribed_at < d.sent_at + ? THEN 1 ELSE 0 END) AS unsubs,
      SUM(CASE WHEN d.status = 'complained' OR (s.status = 'complained' AND s.unsubscribed_at >= d.sent_at AND s.unsubscribed_at < d.sent_at + ?) THEN 1 ELSE 0 END) AS complaints,
      SUM(${revenueSql('d.subscriber_id', 'd.sent_at')}) AS revenue_cents
    FROM deliveries d LEFT JOIN subscribers s ON s.id = d.subscriber_id
    WHERE d.send_id = ? AND d.sent_at IS NOT NULL AND d.variant IS NOT NULL AND substr(d.variant,1,1) BETWEEN 'A' AND 'E'
    GROUP BY substr(d.variant,1,1) ORDER BY arm`, w, w, w, w, sendId);
  return rows.map((r) => ({ arm: r.arm, n: Number(r.n) || 0, unsubs: Number(r.unsubs) || 0, complaints: Number(r.complaints) || 0, revenue_cents: Number(r.revenue_cents) || 0 }));
}

/** Per-path stats for one ab_split step of an automation ('A' = yes path, 'B' = no path). */
export async function splitArmStats(env: Env, automationId: string, stepId: string, windowDays: number): Promise<ArmStats[]> {
  const w = windowDays * DAY;
  const rows = await all<any>(env, `SELECT CASE WHEN l.result LIKE 'path A%' THEN 'A' ELSE 'B' END AS arm, COUNT(DISTINCT l.run_id) AS n,
      SUM(CASE WHEN s.status = 'unsubscribed' AND s.unsubscribed_at >= l.created_at AND s.unsubscribed_at < l.created_at + ? THEN 1 ELSE 0 END) AS unsubs,
      SUM(CASE WHEN s.status = 'complained' AND s.unsubscribed_at >= l.created_at AND s.unsubscribed_at < l.created_at + ? THEN 1 ELSE 0 END) AS complaints,
      SUM(${revenueSql('r.subscriber_id', 'l.created_at')}) AS revenue_cents
    FROM automation_logs l JOIN automation_runs r ON r.id = l.run_id LEFT JOIN subscribers s ON s.id = r.subscriber_id
    WHERE l.automation_id = ? AND l.step_id = ? AND l.action = 'ab_split' AND (l.result LIKE 'path A%' OR l.result LIKE 'path B%')
    GROUP BY arm ORDER BY arm`, w, w, w, w, automationId, stepId);
  const out = rows.map((r) => ({ arm: r.arm, n: Number(r.n) || 0, unsubs: Number(r.unsubs) || 0, complaints: Number(r.complaints) || 0, revenue_cents: Number(r.revenue_cents) || 0 }));
  for (const arm of ['A', 'B']) if (!out.some((x) => x.arm === arm)) out.push({ arm, n: 0, unsubs: 0, complaints: 0, revenue_cents: 0 });
  return out.sort((a, b) => a.arm.localeCompare(b.arm));
}

// ───────── automations ─────────
const pathLabel = (arm: string) => `path ${arm}`;

/** Every ab_split step (with its path in the tree). */
function splits(steps: Step[]): Array<{ step: Step; path: Path }> {
  const out: Array<{ step: Step; path: Path }> = [];
  const visit = (list: Step[], base: Path) => list.forEach((s, i) => {
    const p: Path = [...base, i];
    if (s.type === 'ab_split') out.push({ step: s, path: p });
    if (s.yes) visit(s.yes, [...p, 'yes']);
    if (s.no) visit(s.no, [...p, 'no']);
  });
  visit(steps, []);
  return out;
}

/** Route a split: write config.guardrail on the live (and draft) step, then move in-flight journeys off the stopped path. */
async function routeSplit(env: Env, a: any, stepId: string, safeArm: string, explanation: string): Promise<number> {
  const route = safeArm === 'A' ? 'yes' : 'no';
  const mark = (list: Step[]) => { let hit = false; walk(list, (s) => { if (s.id === stepId && s.type === 'ab_split') { s.config = { ...(s.config || {}), guardrail: { route, at: now(), reason: explanation.slice(0, 500) } }; hit = true; } }); return hit; };
  const live = parseJSON<Step[]>(a.steps, []);
  mark(live);
  const draft = a.draft_steps ? parseJSON<Step[]>(a.draft_steps, []) : null;
  if (draft) mark(draft);
  await run(env, 'UPDATE automations SET steps = ?, draft_steps = ?, updated_at = ? WHERE id = ?', JSON.stringify(live), draft ? JSON.stringify(draft) : null, now(), a.id);
  // in-flight journeys inside the stopped path continue at the start of the safe path (or after the split when it's empty)
  const sp = splits(live).find((x) => x.step.id === stepId);
  if (!sp) return 0;
  const loser = route === 'yes' ? 'no' : 'yes';
  const prefix = JSON.stringify([...sp.path, loser]).slice(0, -1); // "[2,\"no\"" — step_path starts with this
  const runs = await all<any>(env, `SELECT id, step_path FROM automation_runs WHERE automation_id = ? AND status IN ('active','waiting')`, a.id);
  const safeList = (sp.step as any)[route] as Step[] | undefined;
  const dest: Path | null = safeList?.length ? [...sp.path, route, 0] : nextPath(live, sp.path);
  let moved = 0;
  for (const r of runs) {
    if (!(String(r.step_path).startsWith(prefix + ',') || String(r.step_path) === prefix + ']')) continue;
    if (dest && getAt(live, dest)) await run(env, `UPDATE automation_runs SET step_path = ?, status = 'active', next_run_at = ?, updated_at = ? WHERE id = ?`, JSON.stringify(dest), now(), now(), r.id);
    else await run(env, `UPDATE automation_runs SET status = 'completed', next_run_at = NULL, updated_at = ? WHERE id = ?`, now(), r.id);
    await insert(env, 'automation_logs', { id: id(), run_id: r.id, automation_id: a.id, step_id: stepId, action: 'guardrail', result: `moved from ${pathLabel(loser === 'yes' ? 'A' : 'B')} to ${pathLabel(safeArm)}`, created_at: now() });
    moved++;
  }
  return moved;
}

/** Check one automation's splits. Returns the events written. */
export async function checkAutomation(env: Env, automationId: string): Promise<number> {
  const a = await one<any>(env, 'SELECT * FROM automations WHERE id = ?', automationId);
  if (!a) return 0;
  const cfg = await guardrailFor(env, a.pub_id, 'automation', a.id);
  if (!cfg?.enabled) return 0;
  const control = cfg.control === 'B' ? 'B' : 'A';
  let events = 0;
  for (const { step } of splits(parseJSON<Step[]>(a.steps, []))) {
    if (step.config?.guardrail?.route) continue; // already decided
    const arms = await splitArmStats(env, a.id, step.id, cfg.window_days);
    const v = judge(arms, { ...cfg, control }, pathLabel);
    if (!v) continue;
    const moved = await routeSplit(env, a, step.id, v.safe, v.explanation);
    await logEvent(env, { pubId: a.pub_id, kind: 'automation', refId: a.id, target: step.id, stopped: v.stop.map(pathLabel).join(', '), safe: pathLabel(v.safe), explanation: v.explanation + (moved ? ` ${moved} subscriber${moved === 1 ? '' : 's'} in progress moved to ${pathLabel(v.safe)}.` : ''), metrics: { arms, config: cfg }, moved });
    events++;
    const fresh = await one<any>(env, 'SELECT * FROM automations WHERE id = ?', a.id);
    if (fresh) Object.assign(a, fresh);
  }
  await run(env, `UPDATE experiment_guardrails SET last_checked_at = ? WHERE pub_id = ? AND kind = 'automation' AND ref_id = ?`, now(), a.pub_id, a.id);
  return events;
}

/** Undo a guardrail decision on a split (owner override): the split goes back to random assignment. */
export async function resetSplit(env: Env, automationId: string, pubId: string, stepId: string) {
  const a = await one<any>(env, 'SELECT * FROM automations WHERE id = ? AND pub_id = ?', automationId, pubId);
  if (!a) return;
  const clear = (list: Step[]) => walk(list, (s) => { if (s.id === stepId && s.config?.guardrail) { const { guardrail, ...rest } = s.config; s.config = rest; } });
  const live = parseJSON<Step[]>(a.steps, []); clear(live);
  const draft = a.draft_steps ? parseJSON<Step[]>(a.draft_steps, []) : null; if (draft) clear(draft);
  await run(env, 'UPDATE automations SET steps = ?, draft_steps = ?, updated_at = ? WHERE id = ?', JSON.stringify(live), draft ? JSON.stringify(draft) : null, now(), a.id);
}

// ───────── newsletters ─────────
const variantLabel = (arm: string) => `variant ${arm}`;

/** Re-route a newsletter test to `safe`: winner = safe for everyone not yet sent (same transition as the winner job). */
async function routeSend(env: Env, send: any, safe: string) {
  const o: any = parseJSON(send.options, {});
  o.winner = safe;
  o.guardrail = { at: now(), safe };
  if (o.phase === 'test') { o.phase = 'main'; o.ab_decided_at = now(); }
  await run(env, `UPDATE sends SET status = CASE WHEN status = 'testing' THEN 'sending' ELSE status END, options = ?, cursor = CASE WHEN status = 'testing' THEN NULL ELSE cursor END WHERE id = ?`, JSON.stringify(o), send.id);
  // timed sends: main-phase rows already planned with the old winner get the safe variant
  await run(env, `UPDATE deliveries SET variant = ? || substr(variant, 2) WHERE send_id = ? AND status = 'scheduled' AND variant IS NOT NULL AND substr(variant,1,1) != ?`, safe, send.id, safe);
  if (send.post_id) {
    const post = await one<any>(env, 'SELECT ab_test FROM posts WHERE id = ?', send.post_id);
    const ab = parseJSON<any>(post?.ab_test, {});
    ab.winner = safe;
    await run(env, 'UPDATE posts SET ab_test = ? WHERE id = ?', JSON.stringify(ab), send.post_id);
  }
}

/** Evaluate a newsletter send's variants. Returns true when it re-routed the send. */
export async function checkSend(env: Env, sendId: string): Promise<boolean> {
  const send = await one<any>(env, 'SELECT * FROM sends WHERE id = ?', sendId);
  if (!send || !send.post_id || !['testing', 'sending', 'sent', 'paused'].includes(send.status)) return false;
  const o: any = parseJSON(send.options, {});
  if (!o.ab || o.guardrail) return false;
  // the test phase is still going out: judge only once the whole sample has been sent (otherwise unsent sample
  // recipients would be skipped by the main phase)
  if (send.status === 'testing' && (send.cursor || !(await one(env, 'SELECT 1 FROM deliveries WHERE send_id = ? LIMIT 1', send.id)))) return false;
  const cfg = await guardrailFor(env, send.pub_id, 'post', send.post_id);
  if (!cfg?.enabled) return false;
  const arms = await sendArmStats(env, send.id, cfg.window_days);
  const v = judge(arms, cfg, variantLabel);
  if (!v) return false;
  // after the test, only the current winner matters: nothing to do if it's already the safe one
  if (o.phase === 'main' && o.winner === v.safe) {
    o.guardrail = { at: now(), safe: v.safe, note: 'winner already safe' };
    await run(env, 'UPDATE sends SET options = ? WHERE id = ?', JSON.stringify(o), send.id);
    await logEvent(env, { pubId: send.pub_id, kind: 'post', refId: send.id, target: send.post_id, stopped: v.stop.map(variantLabel).join(', '), safe: variantLabel(v.safe), explanation: v.explanation + ` The winning variant was already ${v.safe}, so nothing else changed.`, metrics: { arms, config: cfg } });
    return false;
  }
  await routeSend(env, send, v.safe);
  const rest = send.status === 'sent' ? ' The send had already finished, so this applies to resends and the recorded winner.' : ' Everyone who hasn\'t received it yet gets ' + variantLabel(v.safe) + '.';
  await logEvent(env, { pubId: send.pub_id, kind: 'post', refId: send.id, target: send.post_id, stopped: v.stop.map(variantLabel).join(', '), safe: variantLabel(v.safe), explanation: v.explanation + rest, metrics: { arms, config: cfg } });
  if (send.status === 'testing') await enqueue(env, 'send.batch', { send_id: send.id });
  return true;
}

/**
 * Hook for the A/B winner job (sender.ts): evaluate guardrails first. true = the guardrail already routed everyone to
 * the safe variant (the job must not pick a winner by opens/clicks).
 */
export async function beforeWinner(env: Env, send: { id: string }): Promise<boolean> {
  try { return await checkSend(env, send.id); } catch (e) { await logError(env, 'guardrails.winner', e); return false; }
}

/** Run every guardrail check (cron every 5 minutes; also used by "Check now"). */
export async function runGuardrails(env: Env, pubId?: string): Promise<number> {
  let n = 0;
  const autos = await all<{ id: string }>(env, `SELECT a.id FROM automations a JOIN experiment_guardrails g ON g.pub_id = a.pub_id AND g.kind = 'automation' AND g.ref_id = a.id
    WHERE a.status IN ('active','paused') AND (a.steps LIKE '%"ab_split"%') ${pubId ? 'AND a.pub_id = ?' : ''} LIMIT 200`, ...(pubId ? [pubId] : []));
  for (const a of autos) n += await checkAutomation(env, a.id).catch((e) => (logError(env, 'guardrails.automation', e), 0));
  const sends = await all<{ id: string }>(env, `SELECT s.id FROM sends s WHERE s.kind = 'post' AND s.status IN ('testing','sending','sent') AND s.created_at > ? AND s.options LIKE '%"ab":{%'
    AND s.options NOT LIKE '%"guardrail":%' AND EXISTS (SELECT 1 FROM experiment_guardrails g WHERE g.pub_id = s.pub_id AND ((g.kind = 'post' AND g.ref_id = s.post_id) OR g.kind = 'default'))
    ${pubId ? 'AND s.pub_id = ?' : ''} ORDER BY s.created_at DESC LIMIT 100`, now() - 14 * DAY, ...(pubId ? [pubId] : []));
  for (const s of sends) n += (await checkSend(env, s.id).catch((e) => (logError(env, 'guardrails.send', e), false))) ? 1 : 0;
  return n;
}

registerPeriodic('guardrails.check', 5 * MIN, async (env) => { await runGuardrails(env); });
