// Sending safety for a shared, multi-tenant sender: one account must not be able to burn the platform's domain.
// - campaign safety: a running newsletter pauses itself when hard bounces or complaints spike
// - account reputation: bounce/complaint rates over the last 30 days → sending suspended pending superadmin review
// - first-large-campaign approval for workspaces that aren't trusted yet
// - new-account daily ramp (applied by sender.ts send.batch and automations)
// Thresholds live in lib/plans.ts LIMITS.
import type { Env, Publication } from '../types';
import { one, all, run } from './db';
import { registerPeriodic, enqueue } from './jobs';
import { sendTransactional, button } from './email';
import { appUrl, getPub } from './pub';
import { LIMITS, getWorkspace, ownerOf, isExempt, superadminEmails, logPlatformEvent, type WorkspaceRow } from './plans';
import { now, DAY, HOUR, esc, num } from './util';

const pct = (x: number, digits = 2) => `${(x * 100).toFixed(digits)}%`;

// ───────── stats ─────────
export interface SendStats { attempted: number; hard: number; bounced: number; complaints: number; hardRate: number; complaintRate: number }

export async function sendStats(env: Env, sendId: string): Promise<SendStats> {
  const r = await one<any>(env, `SELECT
      SUM(CASE WHEN status IN ('sent','deferred','bounced','complained') THEN 1 ELSE 0 END) AS attempted,
      SUM(CASE WHEN status = 'bounced' AND bounce_type = 'hard' THEN 1 ELSE 0 END) AS hard,
      SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END) AS bounced,
      SUM(CASE WHEN status = 'complained' THEN 1 ELSE 0 END) AS complaints
    FROM deliveries WHERE send_id = ?`, sendId);
  const attempted = r?.attempted || 0;
  return { attempted, hard: r?.hard || 0, bounced: r?.bounced || 0, complaints: r?.complaints || 0, hardRate: attempted ? (r?.hard || 0) / attempted : 0, complaintRate: attempted ? (r?.complaints || 0) / attempted : 0 };
}

/** Why this campaign should pause, or null. */
export function campaignTrip(s: SendStats): string | null {
  if (s.attempted < LIMITS.CAMPAIGN_MIN_DELIVERIES) return null;
  if (s.hardRate > LIMITS.CAMPAIGN_MAX_HARD_BOUNCE_RATE) return `Hard-bounce rate ${pct(s.hardRate)} (${num(s.hard)} of ${num(s.attempted)}) is above the ${pct(LIMITS.CAMPAIGN_MAX_HARD_BOUNCE_RATE, 0)} safety limit — the list likely contains old or purchased addresses.`;
  if (s.complaintRate > LIMITS.CAMPAIGN_MAX_COMPLAINT_RATE) return `Spam-complaint rate ${pct(s.complaintRate)} (${num(s.complaints)} of ${num(s.attempted)}) is above the ${pct(LIMITS.CAMPAIGN_MAX_COMPLAINT_RATE)} safety limit.`;
  return null;
}

export interface AccountStats { attempted: number; bounced: number; complaints: number; bounceRate: number; complaintRate: number }

export async function accountStats(env: Env, wsId: string, windowDays = LIMITS.ACCOUNT_WINDOW_DAYS): Promise<AccountStats> {
  const r = await one<any>(env, `SELECT
      SUM(CASE WHEN d.status IN ('sent','deferred','bounced','complained') THEN 1 ELSE 0 END) AS attempted,
      SUM(CASE WHEN d.status = 'bounced' THEN 1 ELSE 0 END) AS bounced,
      SUM(CASE WHEN d.status = 'complained' THEN 1 ELSE 0 END) AS complaints
    FROM deliveries d WHERE d.pub_id IN (SELECT id FROM publications WHERE workspace_id = ?) AND d.created_at >= ?`, wsId, now() - windowDays * DAY);
  const attempted = r?.attempted || 0;
  return { attempted, bounced: r?.bounced || 0, complaints: r?.complaints || 0, bounceRate: attempted ? (r?.bounced || 0) / attempted : 0, complaintRate: attempted ? (r?.complaints || 0) / attempted : 0 };
}

export function accountTrip(s: AccountStats): string | null {
  if (s.attempted < LIMITS.ACCOUNT_MIN_DELIVERIES) return null;
  if (s.bounceRate > LIMITS.ACCOUNT_MAX_BOUNCE_RATE) return `Bounce rate ${pct(s.bounceRate)} over the last ${LIMITS.ACCOUNT_WINDOW_DAYS} days (limit ${pct(LIMITS.ACCOUNT_MAX_BOUNCE_RATE, 0)})`;
  if (s.complaintRate > LIMITS.ACCOUNT_MAX_COMPLAINT_RATE) return `Complaint rate ${pct(s.complaintRate)} over the last ${LIMITS.ACCOUNT_WINDOW_DAYS} days (limit ${pct(LIMITS.ACCOUNT_MAX_COMPLAINT_RATE, 1)})`;
  return null;
}

// ───────── notifications ─────────
async function notifyOwner(env: Env, ws: WorkspaceRow, subject: string, html: string) {
  const owner = await ownerOf(env, ws);
  if (owner) await sendTransactional(env, owner.email, subject, html).catch(() => {});
}
async function notifyOps(env: Env, subject: string, html: string) {
  for (const a of superadminEmails(env)) await sendTransactional(env, a, subject, html).catch(() => {});
}

// ───────── campaign pause ─────────
/** Pause a running campaign for safety. Returns true when it paused it. */
export async function pauseSend(env: Env, send: { id: string; pub_id: string; subject: string; post_id?: string | null }, reason: string): Promise<boolean> {
  const res = await run(env, `UPDATE sends SET status = 'paused', status_reason = ? WHERE id = ? AND status IN ('sending','testing')`, reason, send.id);
  if (!res.meta.changes) return false;
  const pub = await getPub(env, send.pub_id);
  const ws = pub ? await getWorkspace(env, pub.workspace_id) : null;
  await logPlatformEvent(env, { workspaceId: ws?.id, sendId: send.id, kind: 'campaign_paused', detail: reason });
  const link = appUrl(env, send.post_id ? `/app/posts/${send.post_id}` : '/app/posts');
  if (ws) await notifyOwner(env, ws, `Your newsletter "${send.subject}" was paused`,
    `<p>We paused <strong>${esc(send.subject)}</strong> (${esc(pub?.name || '')}) while it was sending:</p><p>${esc(reason)}</p>
     <p>Recipients who already got it are unaffected; nobody else will receive it until our team reviews it. Clean the list (remove addresses that bounced, people who didn't opt in, and long-inactive readers) and reply to this email to have it reviewed.</p>${button('See the campaign', link)}`);
  await notifyOps(env, `[Platform] Campaign paused: ${send.subject}`, `<p>Workspace <strong>${esc(ws?.name || '?')}</strong> · ${esc(pub?.name || '')}</p><p>${esc(reason)}</p>${button('Review in Platform admin', appUrl(env, '/app/admin/sends'))}`);
  return true;
}

/** Check a running campaign after a batch; pauses it (and checks the account) when it trips. */
export async function checkCampaign(env: Env, send: { id: string; pub_id: string; subject: string; post_id?: string | null }): Promise<string | null> {
  const reason = campaignTrip(await sendStats(env, send.id));
  if (!reason) return null;
  await pauseSend(env, send, reason);
  const pub = await getPub(env, send.pub_id);
  if (pub) await checkAccount(env, pub.workspace_id);
  return reason;
}

// ───────── account suspension ─────────
export async function suspendWorkspace(env: Env, wsId: string, note: string, actor: string | null = null) {
  const res = await run(env, `UPDATE workspaces SET sending_status = 'suspended', sending_note = ?, sending_changed_at = ? WHERE id = ? AND sending_status != 'suspended'`, note, now(), wsId);
  if (!res.meta.changes) return false;
  // pause anything in flight
  await run(env, `UPDATE sends SET status = 'paused', status_reason = ? WHERE status IN ('sending','testing') AND pub_id IN (SELECT id FROM publications WHERE workspace_id = ?)`, 'Account sending suspended: ' + note, wsId);
  await logPlatformEvent(env, { workspaceId: wsId, kind: 'suspended', detail: note, actor });
  const ws = await getWorkspace(env, wsId);
  if (ws) {
    await notifyOwner(env, ws, 'Sending is suspended on your account',
      `<p>We've suspended sending for <strong>${esc(ws.name)}</strong> while our team reviews it:</p><p>${esc(note)}</p><p>Your publications, website and subscribers are unaffected and readers can still sign up — only email sending is on hold. Reply to this email if you think this is a mistake.</p>`);
    if (!actor) await notifyOps(env, `[Platform] Sending suspended: ${ws.name}`, `<p>${esc(note)}</p>${button('Review in Platform admin', appUrl(env, `/app/admin/w/${ws.id}`))}`);
  }
  return true;
}

export async function unsuspendWorkspace(env: Env, wsId: string, actor: string | null, note = '') {
  const res = await run(env, `UPDATE workspaces SET sending_status = 'active', sending_note = ?, sending_changed_at = ? WHERE id = ? AND sending_status = 'suspended'`, note || null, now(), wsId);
  if (!res.meta.changes) return false;
  await logPlatformEvent(env, { workspaceId: wsId, kind: 'unsuspended', detail: note, actor });
  const ws = await getWorkspace(env, wsId);
  if (ws) await notifyOwner(env, ws, 'Sending is restored on your account', `<p>Sending is active again for <strong>${esc(ws.name)}</strong>.${note ? ' ' + esc(note) : ''}</p><p>Paused campaigns stay paused — resume or resend them from the post when you're ready.</p>`);
  return true;
}

/** Account-level reputation check. Suspends sending when rates over the window exceed the limits. */
export async function checkAccount(env: Env, wsId: string): Promise<string | null> {
  const ws = await getWorkspace(env, wsId);
  if (!ws || ws.sending_status === 'suspended' || (await isExempt(env, ws))) return null;
  const reason = accountTrip(await accountStats(env, wsId));
  if (reason) await suspendWorkspace(env, wsId, reason);
  return reason;
}

registerPeriodic('safety.accounts', HOUR, async (env) => {
  const rows = await all<{ workspace_id: string }>(env, `SELECT DISTINCT p.workspace_id FROM deliveries d JOIN publications p ON p.id = d.pub_id WHERE d.created_at >= ? LIMIT 500`, now() - 2 * DAY);
  for (const r of rows) await checkAccount(env, r.workspace_id);
  // late bounces/complaints on campaigns that are still sending
  for (const s of await all<any>(env, `SELECT id, pub_id, subject, post_id FROM sends WHERE status = 'sending' AND kind = 'post' LIMIT 200`)) await checkCampaign(env, s);
});

// ───────── first large campaign approval ─────────
export async function needsApproval(env: Env, pub: Pick<Publication, 'workspace_id'>, recipients: number): Promise<boolean> {
  if (recipients <= LIMITS.APPROVAL_RECIPIENTS) return false;
  const ws = await getWorkspace(env, pub.workspace_id);
  if (!ws || ws.trusted_at) return false;
  return !(await isExempt(env, ws));
}

export async function requestApproval(env: Env, pub: Publication, send: { id: string; subject: string; total: number; post_id?: string | null }) {
  const ws = await getWorkspace(env, pub.workspace_id);
  await logPlatformEvent(env, { workspaceId: pub.workspace_id, sendId: send.id, kind: 'approval_requested', detail: `${send.total} recipients: ${send.subject}` });
  if (ws) await notifyOwner(env, ws, `"${send.subject}" is waiting for a quick review`,
    `<p>Your first campaign to more than ${num(LIMITS.APPROVAL_RECIPIENTS)} readers (<strong>${num(send.total)}</strong> recipients) gets a one-time review by our team before it goes out — it protects the shared sending reputation every newsletter here relies on.</p><p>You'll get an email as soon as it's approved, usually within a few hours. Later campaigns go out immediately.</p>${button('See the campaign', appUrl(env, send.post_id ? `/app/posts/${send.post_id}` : '/app/posts'))}`);
  await notifyOps(env, `[Platform] Approval needed: ${send.subject} (${num(send.total)} recipients)`, `<p>${esc(pub.name)} · workspace ${esc(ws?.name || '')}</p>${button('Review', appUrl(env, '/app/admin/sends'))}`);
}

export async function approveSend(env: Env, sendId: string, actor: string): Promise<boolean> {
  const send = await one<any>(env, `SELECT * FROM sends WHERE id = ? AND status = 'pending_approval'`, sendId);
  if (!send) return false;
  const ab = (() => { try { return !!JSON.parse(send.options || '{}').ab; } catch { return false; } })();
  await run(env, `UPDATE sends SET status = ?, status_reason = NULL, reviewed_by = ?, reviewed_at = ?, started_at = ? WHERE id = ?`, ab ? 'testing' : 'sending', actor, now(), now(), sendId);
  const pub = await getPub(env, send.pub_id);
  if (pub) await run(env, 'UPDATE workspaces SET trusted_at = COALESCE(trusted_at, ?) WHERE id = ?', now(), pub.workspace_id);
  await enqueue(env, 'send.batch', { send_id: sendId });
  await logPlatformEvent(env, { workspaceId: pub?.workspace_id, sendId, kind: 'approved', actor });
  const ws = pub ? await getWorkspace(env, pub.workspace_id) : null;
  if (ws) await notifyOwner(env, ws, `Approved: "${send.subject}" is sending now`, `<p>Your campaign <strong>${esc(send.subject)}</strong> was approved and is going out to ${num(send.total)} readers. Future campaigns send right away.</p>`);
  return true;
}

export async function rejectSend(env: Env, sendId: string, actor: string, reason: string): Promise<boolean> {
  const send = await one<any>(env, `SELECT * FROM sends WHERE id = ? AND status IN ('pending_approval','paused')`, sendId);
  if (!send) return false;
  await run(env, `UPDATE sends SET status = 'rejected', status_reason = ?, reviewed_by = ?, reviewed_at = ?, completed_at = ? WHERE id = ?`, reason || 'Rejected by review', actor, now(), now(), sendId);
  const pub = await getPub(env, send.pub_id);
  await logPlatformEvent(env, { workspaceId: pub?.workspace_id, sendId, kind: 'rejected', detail: reason, actor });
  const ws = pub ? await getWorkspace(env, pub.workspace_id) : null;
  if (ws) await notifyOwner(env, ws, `"${send.subject}" was not sent`, `<p>After review, your campaign <strong>${esc(send.subject)}</strong> won't be sent${reason ? `:</p><p>${esc(reason)}` : '.'}</p><p>Reply to this email if you have questions — usually it's about how the list was collected.</p>`);
  return true;
}

/** Resume a campaign paused by a safety check (superadmin). */
export async function resumeSend(env: Env, sendId: string, actor: string): Promise<boolean> {
  const send = await one<any>(env, `SELECT * FROM sends WHERE id = ? AND status = 'paused'`, sendId);
  if (!send) return false;
  const ab = (() => { try { const o = JSON.parse(send.options || '{}'); return !!o.ab && o.phase === 'test'; } catch { return false; } })();
  await run(env, `UPDATE sends SET status = ?, status_reason = NULL, reviewed_by = ?, reviewed_at = ? WHERE id = ?`, ab ? 'testing' : 'sending', actor, now(), sendId);
  await enqueue(env, 'send.batch', { send_id: sendId });
  const pub = await getPub(env, send.pub_id);
  await logPlatformEvent(env, { workspaceId: pub?.workspace_id, sendId, kind: 'resumed', actor });
  return true;
}

// ───────── new-account ramp ─────────
/** Emails this workspace may still send in the rolling 24h window while it's new (Infinity once the ramp is over). */
export async function rampRemaining(env: Env, wsId: string): Promise<{ remaining: number; reason?: string }> {
  const ws = await getWorkspace(env, wsId);
  if (!ws || now() >= ws.created_at + LIMITS.NEW_ACCOUNT_DAYS * DAY || (await isExempt(env, ws))) return { remaining: Infinity };
  const sent = await one<{ n: number }>(env, `SELECT COUNT(*) AS n FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE d.pub_id IN (SELECT id FROM publications WHERE workspace_id = ?) AND d.sent_at >= ? AND s.kind NOT IN ('test','try')`, wsId, now() - DAY);
  const remaining = Math.max(0, LIMITS.NEW_ACCOUNT_DAILY_CAP - (sent?.n || 0));
  return { remaining, reason: remaining ? undefined : `New accounts can send ${LIMITS.NEW_ACCOUNT_DAILY_CAP} emails per day for their first ${LIMITS.NEW_ACCOUNT_DAYS} days — the rest goes out automatically as the daily allowance frees up.` };
}

/** Is sending blocked for the workspace right now (suspended)? Cheap check used by every send batch. */
export async function workspaceSuspended(env: Env, wsId: string): Promise<string | null> {
  const ws = await getWorkspace(env, wsId);
  if (!ws || ws.sending_status !== 'suspended') return null;
  if (await isExempt(env, ws)) return null;
  return 'Account sending suspended' + (ws.sending_note ? `: ${ws.sending_note}` : '');
}
