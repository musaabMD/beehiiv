// Transactional email API (Mandrill-style): POST /api/v2/publication/transactional/send, MCP tool send_transactional,
// templates and a searchable message log (Settings → Transactional email).
//
// Policy (see docs/API.md → Transactional email):
//  - Sent as transactional mail through the Email Sending binding from the publication's transactional sender.
//  - Suppression: the transactional layer + global "mailbox does not exist" entries apply (lib/email isSuppressed);
//    newsletter unsubscribes and complaints do NOT block receipts and password resets.
//  - Does NOT count toward the plan's monthly marketing email allowance. It has its own caps instead: 60 sends/min per
//    API key and a rolling 24h cap per publication (200 on Free, 5,000 on paid plans), and nothing sends while the
//    workspace's sending is suspended.
import type { Env, Publication } from '../types';
import { one, all, run, insert, val } from './db';
import { sendMailRecorded, sanitizeHeaders, type MailInput } from './email';
import { registerJob, enqueue } from './jobs';
import { loadThrottles, holdReason, factorFrom, providerOf } from './throttle';
import { workspaceSuspended } from './safety';
import { applyMerge, mergeVars } from './render';
import { markdownToHtml } from './markdown';
import { senderFor, siteUrl, appUrl, getPub } from './pub';
import { validateEmail } from './guard';
import { limit } from './apiauth';
import { id, now, esc, parseJSON, slugify, DAY, MIN } from './util';

export const TX_PER_MINUTE_PER_KEY = 60;
export const TX_DAILY = { free: 200, paid: 5000 };
const MAX_ATTACH_BYTES = 5 * 1024 * 1024;

export class TxError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export interface TxInput {
  to: string;
  template_id?: string;              // template id or slug
  subject?: string;
  html?: string;
  markdown?: string;
  text?: string;
  merge_vars?: Record<string, unknown>;
  reply_to?: string;
  from_name?: string;
  /** content_id makes the attachment an inline part (reference it in the HTML as <img src="cid:...">) */
  attachments?: Array<{ filename: string; content: string; type?: string; content_id?: string }>;
  /** custom headers: X-* plus List-Id, References, In-Reply-To, Thread-Index, Thread-Topic */
  headers?: Record<string, string>;
  /** ISO date or epoch ms: send later (up to 30 days ahead) */
  scheduled_at?: string | number;
  /** ISO date or epoch ms: if not handed to the provider by then, the message expires instead of sending */
  expires_at?: string | number;
  tags?: string[];
  idempotency_key?: string;
  track?: boolean;                   // open + click tracking (default false)
}

/** {"order": {"id": 7}} → {"order.id": "7"} (keys lower-cased for {{merge}} tags). */
export function flattenVars(o: Record<string, unknown> | undefined, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(o || {})) {
    const key = (prefix ? `${prefix}.${k}` : k).toLowerCase();
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenVars(v as Record<string, unknown>, key, out);
    else out[key] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
  }
  return out;
}

function layout(pub: Publication, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:100%;background:#fff;border-radius:10px"><tr><td style="padding:28px;font-size:15px;line-height:1.6;color:#1f2328">${body}</td></tr></table>
<p style="font-size:12px;color:#9ca3af">${esc(pub.name)}${pub.address ? ' · ' + esc(pub.address) : ''}</p></td></tr></table></body></html>`;
}

/** Rewrite http(s) links to /t/x/c/<msg>/<n> and add an open pixel. Returns the html and the original links. */
export function addTracking(env: Env, msgId: string, html: string): { html: string; links: string[] } {
  const links: string[] = [];
  const base = appUrl(env, '/t/x');
  let out = html.replace(/(<a\b[^>]*?\bhref=)(["'])(https?:\/\/[^"']+)\2/gi, (_, pre: string, q: string, url: string) => {
    const u = url.replace(/&amp;/g, '&');
    let i = links.indexOf(u);
    if (i < 0) { links.push(u); i = links.length - 1; }
    return `${pre}${q}${base}/c/${msgId}/${i}${q}`;
  });
  const pixel = `<img src="${base}/o/${msgId}.gif" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">`;
  out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, pixel + '</body>') : out + pixel;
  return { html: out, links };
}

async function dailyCap(env: Env, pub: Publication): Promise<number> {
  const { planStatusForPub } = await import('./plans');
  const st = await planStatusForPub(env, pub, { cachedMs: 60_000 });
  if (!st) return TX_DAILY.paid;
  if (st.suspended) throw new TxError(402, 'suspended', 'Sending is suspended for this account pending review. Contact support.');
  if (st.exempt) return Infinity;
  return st.effective.id === 'free' ? TX_DAILY.free : TX_DAILY.paid;
}

export async function findTemplate(env: Env, pubId: string, ref: string) {
  return one<any>(env, 'SELECT * FROM tx_templates WHERE pub_id = ? AND (id = ? OR slug = ?)', pubId, ref, ref);
}

/** Parse an ISO date or epoch milliseconds; null when absent. */
function parseWhen(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  const t = typeof v === 'number' ? v : /^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v));
  if (!isFinite(t) || t <= 0) throw new TxError(400, 'bad_request', `${field} must be an ISO 8601 date or epoch milliseconds.`);
  return t;
}

/** The rendered message kept while a message is scheduled, queued or waiting for a retry. */
interface TxPayload {
  to: string; subject: string; html: string; text?: string; from: { email: string; name?: string }; replyTo: string | null;
  headers: Record<string, string>; attachments: NonNullable<MailInput['attachments']>;
}
/** D1 rows are limited to ~2 MB; a message we must keep for later has to fit. */
const MAX_STORED_PAYLOAD = 1_800_000;
export const TX_MAX_ATTEMPTS = 5;
export const TX_MAX_SCHEDULE_AHEAD = 30 * DAY;

/** Validate + render a message (no side effects except reading). */
async function prepareTx(env: Env, pub: Publication, input: TxInput, mid: string) {
  const v = await validateEmail(String(input.to || ''), { strict: false });
  if (!v.ok) throw new TxError(400, 'invalid_recipient', `"to" is not a valid email address${v.reason ? ` (${v.reason})` : ''}.`);
  const to = v.email;
  let subject = input.subject || '';
  let html = input.html || '';
  let md = input.markdown || '';
  let templateId: string | null = null;
  if (input.template_id) {
    const t = await findTemplate(env, pub.id, String(input.template_id));
    if (!t) throw new TxError(404, 'not_found', 'Template not found.');
    templateId = t.id;
    subject ||= t.subject;
    if (!html && !md) { if (t.format === 'html') html = t.body; else md = t.body; }
  }
  if (!subject) throw new TxError(400, 'bad_request', 'subject is required (or use a template with a subject).');
  if (!html && !md && !input.text) throw new TxError(400, 'bad_request', 'Provide html, markdown, text or template_id.');
  const sub = await one<any>(env, 'SELECT * FROM subscribers WHERE pub_id = ? AND email = ?', pub.id, to);
  const vars = { ...mergeVars(pub, sub, siteUrl(env, pub)), 'email': to, ...flattenVars(input.merge_vars) };
  subject = applyMerge(subject, vars, false).slice(0, 300);
  let body = html ? applyMerge(html, vars) : md ? applyMerge(markdownToHtml(md).html, vars) : `<p style="white-space:pre-wrap">${esc(applyMerge(input.text || '', vars, false))}</p>`;
  if (!/<html[\s>]/i.test(body)) body = layout(pub, body);
  // attachments; with content_id they are inline parts the HTML references as <img src="cid:...">
  const attachments = (Array.isArray(input.attachments) ? input.attachments : []).slice(0, 10).map((a) => {
    const cid = a?.content_id ? String(a.content_id).replace(/^<|>$/g, '') : '';
    if (cid && !/^[A-Za-z0-9._@-]{1,100}$/.test(cid)) throw new TxError(400, 'bad_request', 'content_id may only contain letters, digits, ".", "_", "@" and "-".');
    const base = { content: String(a?.content || '').replace(/\s/g, ''), filename: String(a?.filename || 'attachment').slice(0, 120), type: String(a?.type || 'application/octet-stream') };
    return cid ? { ...base, disposition: 'inline' as const, contentId: cid } : { ...base, disposition: 'attachment' as const };
  });
  const bytes = attachments.reduce((n, a) => n + Math.floor((a.content.length * 3) / 4), 0);
  if (bytes > MAX_ATTACH_BYTES) throw new TxError(400, 'bad_request', 'Attachments may total at most 5 MB.');
  if (attachments.some((a) => !/^[A-Za-z0-9+/]*={0,2}$/.test(a.content))) throw new TxError(400, 'bad_request', 'Attachment content must be base64.');
  for (const a of attachments) if (a.disposition === 'inline' && !/^image\//.test(a.type)) throw new TxError(400, 'bad_request', `Inline attachment "${a.filename}" must be an image (type image/*).`);
  const hdr = sanitizeHeaders(input.headers);
  if (!hdr.ok) throw new TxError(400, 'bad_request', hdr.error);
  const track = !!input.track;
  let links: string[] = [];
  if (track) ({ html: body, links } = addTracking(env, mid, body));
  const tags = (Array.isArray(input.tags) ? input.tags : []).map((t) => String(t).trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 10);
  let replyTo: string | null = null;
  if (input.reply_to) { const r = await validateEmail(String(input.reply_to), { strict: false }); if (!r.ok) throw new TxError(400, 'bad_request', 'reply_to is not a valid email address.'); replyTo = r.email; }
  const from = await senderFor(env, pub, 'transactional');
  const payload: TxPayload = {
    to, subject, html: body, text: input.text, replyTo, attachments,
    from: { email: from.email, name: input.from_name ? String(input.from_name).slice(0, 80) : from.name },
    headers: { ...hdr.headers, 'X-OpenHive-Tx': mid },
  };
  const meta = attachments.map((a) => ({ filename: a.filename, type: a.type, disposition: a.disposition, content_id: (a as any).contentId || null, bytes: Math.floor((a.content.length * 3) / 4) }));
  return { to, subject, templateId, track, links, tags, payload, meta, customHeaders: hdr.headers };
}

/**
 * Send one transactional email. Throws TxError (status + code) for caller errors.
 * - scheduled_at: queued and sent at that time by the job runner (highest priority queue); cancel with cancelTx.
 * - expires_at: if it hasn't been handed to the provider by then (scheduled, held by a stop, or retrying), it becomes
 *   'expired' and is never sent.
 * - transient provider errors are retried with backoff (up to TX_MAX_ATTEMPTS, never past expires_at).
 * - while sending is stopped (kill switch) the message is stored as 'queued' and goes out when sending resumes.
 */
export async function sendTx(env: Env, pub: Publication, input: TxInput, o: { keyId?: string | null; skipKeyLimit?: boolean } = {}) {
  if (!input || typeof input !== 'object') throw new TxError(400, 'bad_request', 'JSON body required.');
  const idem = input.idempotency_key ? String(input.idempotency_key).slice(0, 200) : null;
  if (idem) {
    const prev = await one<any>(env, 'SELECT * FROM tx_messages WHERE pub_id = ? AND idempotency_key = ?', pub.id, idem);
    if (prev) return { ...serializeTx(prev), duplicate: true };
  }
  const scheduledAt = parseWhen(input.scheduled_at, 'scheduled_at');
  const expiresAt = parseWhen(input.expires_at, 'expires_at');
  if (scheduledAt && scheduledAt > now() + TX_MAX_SCHEDULE_AHEAD) throw new TxError(400, 'bad_request', 'scheduled_at may be at most 30 days ahead.');
  if (scheduledAt && expiresAt && expiresAt <= scheduledAt) throw new TxError(400, 'bad_request', 'expires_at must be after scheduled_at.');
  if (o.keyId && !o.skipKeyLimit) {
    const rl = await limit(env, 'tx:' + o.keyId, TX_PER_MINUTE_PER_KEY, 60);
    if (!rl.ok) throw new TxError(429, 'rate_limited', `Transactional rate limit of ${TX_PER_MINUTE_PER_KEY} emails per minute per API key exceeded.`);
  }
  const cap = await dailyCap(env, pub);
  if (cap !== Infinity && (await val<number>(env, 'SELECT COUNT(*) FROM tx_messages WHERE pub_id = ? AND created_at > ?', pub.id, now() - DAY)) >= cap) {
    throw new TxError(429, 'daily_cap', `This publication has sent ${cap} transactional emails in the last 24 hours, the cap on its plan.`);
  }
  const mid = 'tx_' + id(18);
  const p = await prepareTx(env, pub, input, mid);
  const t = now();
  const held = holdReason(await loadThrottles(env), pub.workspace_id);
  const status = expiresAt && expiresAt <= t ? 'expired' : scheduledAt ? 'scheduled' : held ? 'queued' : 'sending';
  const stored = status === 'scheduled' || status === 'queued' ? JSON.stringify(p.payload) : null;
  if (stored && stored.length > MAX_STORED_PAYLOAD) throw new TxError(400, 'bad_request', 'Scheduled or queued messages may be at most 1.8 MB including attachments.');
  // reserve the idempotency key before sending so concurrent retries can't double-send
  try {
    await insert(env, 'tx_messages', {
      id: mid, pub_id: pub.id, api_key_id: o.keyId ?? null, template_id: p.templateId, to_email: p.to, subject: p.subject, status, tags: JSON.stringify(p.tags), idempotency_key: idem,
      track: p.track ? 1 : 0, links: JSON.stringify(p.links), created_at: t, scheduled_at: scheduledAt, expires_at: expiresAt, payload: stored,
      attachments_meta: JSON.stringify(p.meta), headers: JSON.stringify(p.customHeaders), error: status === 'expired' ? 'expired before it could be sent' : status === 'queued' ? held : null,
    });
  } catch (e: any) {
    if (idem && /UNIQUE/i.test(String(e?.message))) { const prev = await one<any>(env, 'SELECT * FROM tx_messages WHERE pub_id = ? AND idempotency_key = ?', pub.id, idem); if (prev) return { ...serializeTx(prev), duplicate: true }; }
    throw e;
  }
  if (status === 'scheduled') await enqueue(env, 'tx.send', { id: mid }, Math.max(t, scheduledAt!));
  else if (status === 'queued') await enqueue(env, 'tx.send', { id: mid }, t + MIN);
  else if (status === 'sending') await deliverTx(env, pub, mid, p.payload, 0, expiresAt);
  return serializeTx((await one<any>(env, 'SELECT * FROM tx_messages WHERE id = ?', mid))!);
}

/** One attempt (recorded in delivery_attempts); transient failures go back to the queue with backoff. */
async function deliverTx(env: Env, pub: Publication, mid: string, m: TxPayload, attemptsSoFar: number, expiresAt: number | null) {
  const res = await sendMailRecorded(env, mid, { to: m.to, subject: m.subject, html: m.html, text: m.text, from: m.from, replyTo: m.replyTo, pub, kind: 'transactional', headers: m.headers, attachments: m.attachments });
  const attempts = attemptsSoFar + 1;
  if (!res.ok && res.status === 'failed' && res.retry && attempts < TX_MAX_ATTEMPTS) {
    const next = now() + 30_000 * 4 ** (attempts - 1); // 30 s, 2 min, 8 min, 32 min
    const json = JSON.stringify(m);
    if ((!expiresAt || next < expiresAt) && json.length <= MAX_STORED_PAYLOAD) {
      await run(env, `UPDATE tx_messages SET status = 'deferred', error = ?, attempts = ?, payload = ? WHERE id = ?`, res.error ?? null, attempts, json, mid);
      await enqueue(env, 'tx.send', { id: mid }, next);
      return;
    }
  }
  await run(env, 'UPDATE tx_messages SET status = ?, error = ?, message_id = ?, attempts = ?, sent_at = ?, payload = NULL WHERE id = ?', res.status, res.error ?? null, res.messageId ?? null, attempts, res.ok ? now() : null, mid);
}

// Scheduled, queued (kill switch) and retrying transactional messages. Priority 0: never behind newsletter batches.
registerJob('tx.send', async (env, p) => {
  const m = await one<any>(env, 'SELECT * FROM tx_messages WHERE id = ?', p.id);
  if (!m || !['scheduled', 'queued', 'deferred'].includes(m.status)) return;
  if (m.expires_at && now() >= m.expires_at) {
    await run(env, `UPDATE tx_messages SET status = 'expired', error = 'expired before it could be sent', payload = NULL WHERE id = ? AND status IN ('scheduled','queued','deferred')`, m.id);
    return;
  }
  const pub = await getPub(env, m.pub_id);
  if (!pub) return;
  const thr = await loadThrottles(env);
  const held = holdReason(thr, pub.workspace_id) || (factorFrom(thr, pub.workspace_id, providerOf(m.to_email)) <= 0 ? 'Mail to this provider is paused by the deliverability guardian.' : null)
    || (await workspaceSuspended(env, pub.workspace_id));
  if (held) {
    await run(env, `UPDATE tx_messages SET status = 'queued', error = ? WHERE id = ? AND status IN ('scheduled','queued','deferred')`, held.slice(0, 300), m.id);
    return { retryInMs: MIN };
  }
  const claimed = await run(env, `UPDATE tx_messages SET status = 'sending' WHERE id = ? AND status IN ('scheduled','queued','deferred')`, m.id);
  if (!claimed.meta.changes) return;
  const payload = parseJSON<TxPayload | null>(m.payload, null);
  if (!payload) { await run(env, `UPDATE tx_messages SET status = 'failed', error = 'message content missing' WHERE id = ?`, m.id); return; }
  await deliverTx(env, pub, m.id, payload, m.attempts || 0, m.expires_at);
});

/** Cancel a scheduled / queued / retrying message. */
export async function cancelTx(env: Env, pubId: string, msgId: string) {
  const m = await one<any>(env, 'SELECT * FROM tx_messages WHERE pub_id = ? AND id = ?', pubId, msgId);
  if (!m) throw new TxError(404, 'not_found', 'Message not found.');
  const r = await run(env, `UPDATE tx_messages SET status = 'cancelled', payload = NULL, error = NULL WHERE id = ? AND status IN ('scheduled','queued','deferred')`, m.id);
  if (!r.meta.changes) throw new TxError(409, 'not_cancellable', `Only scheduled, queued or retrying messages can be cancelled (this one is ${m.status}).`);
  return serializeTx((await one<any>(env, 'SELECT * FROM tx_messages WHERE id = ?', m.id))!);
}

export const TX_BATCH_MAX = 100;
export const TX_BATCHES_PER_MINUTE_PER_KEY = 10;
/** Up to 100 messages in one call. Each message is independent (own validation, idempotency_key, result). */
export async function sendTxBatch(env: Env, pub: Publication, messages: unknown, o: { keyId?: string | null } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new TxError(400, 'bad_request', 'Send {"messages": [ ... ]} with 1-100 messages.');
  if (messages.length > TX_BATCH_MAX) throw new TxError(400, 'bad_request', `At most ${TX_BATCH_MAX} messages per batch.`);
  if (o.keyId) {
    const rl = await limit(env, 'txb:' + o.keyId, TX_BATCHES_PER_MINUTE_PER_KEY, 60);
    if (!rl.ok) throw new TxError(429, 'rate_limited', `Batch rate limit of ${TX_BATCHES_PER_MINUTE_PER_KEY} batch calls per minute per API key exceeded.`);
  }
  const results: any[] = new Array(messages.length);
  const one1 = async (i: number) => {
    try {
      const r: any = await sendTx(env, pub, messages[i] as TxInput, { keyId: o.keyId, skipKeyLimit: true });
      results[i] = { index: i, ok: true, status: r.duplicate ? 200 : 201, data: r };
    } catch (e: any) {
      if (e instanceof TxError) results[i] = { index: i, ok: false, status: e.status, error: { code: e.code, message: e.message } };
      else results[i] = { index: i, ok: false, status: 500, error: { code: 'internal_error', message: 'Could not send this message; retry it (an idempotency_key makes that safe).' } };
    }
  };
  for (let i = 0; i < messages.length; i += 10) await Promise.all(Array.from({ length: Math.min(10, messages.length - i) }, (_, k) => one1(i + k)));
  return { results, summary: { total: results.length, accepted: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length } };
}

export function serializeTx(m: any) {
  const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);
  return {
    id: m.id, to: m.to_email, subject: m.subject, status: m.status, error: m.error || null, message_id: m.message_id, template_id: m.template_id, tags: parseJSON(m.tags, []), idempotency_key: m.idempotency_key,
    tracking: !!m.track, opens: m.open_count, clicks: m.click_count, opened_at: iso(m.opened_at), clicked_at: iso(m.clicked_at), created_at: iso(m.created_at),
    scheduled_at: iso(m.scheduled_at), expires_at: iso(m.expires_at), sent_at: iso(m.sent_at), attempts: m.attempts ?? 0,
    attachments: parseJSON(m.attachments_meta, []), headers: parseJSON(m.headers, {}),
  };
}

export async function searchTx(env: Env, pubId: string, q: { q?: string; status?: string; tag?: string; limit?: number; before?: number }) {
  const w = ['pub_id = ?'];
  const p: unknown[] = [pubId];
  if (q.q) { w.push('(to_email LIKE ? OR subject LIKE ? OR id = ? OR message_id = ?)'); p.push(`%${q.q}%`, `%${q.q}%`, q.q, q.q); }
  if (q.status) { w.push('status = ?'); p.push(q.status); }
  if (q.tag) { w.push(`EXISTS (SELECT 1 FROM json_each(tx_messages.tags) j WHERE j.value = ?)`); p.push(q.tag.toLowerCase()); }
  if (q.before) { w.push('created_at < ?'); p.push(q.before); }
  return all<any>(env, `SELECT * FROM tx_messages WHERE ${w.join(' AND ')} ORDER BY created_at DESC LIMIT ?`, ...p, Math.min(Math.max(q.limit || 50, 1), 200));
}

export async function saveTemplate(env: Env, pubId: string, f: { id?: string; name: string; slug?: string; subject: string; body: string; format?: string }) {
  const name = String(f.name || '').trim().slice(0, 120);
  if (!name) throw new TxError(400, 'bad_request', 'Template name is required.');
  const slug = slugify(f.slug || name, 60) || id(8);
  const format = f.format === 'html' ? 'html' : 'markdown';
  const clash = await one<{ id: string }>(env, 'SELECT id FROM tx_templates WHERE pub_id = ? AND slug = ?', pubId, slug);
  if (clash && clash.id !== f.id) throw new TxError(409, 'conflict', `A template with the slug "${slug}" already exists.`);
  if (f.id) {
    await run(env, 'UPDATE tx_templates SET name = ?, slug = ?, subject = ?, body = ?, format = ?, updated_at = ? WHERE id = ? AND pub_id = ?', name, slug, String(f.subject || '').slice(0, 300), String(f.body || '').slice(0, 200_000), format, now(), f.id, pubId);
    return f.id;
  }
  const tid = id();
  await insert(env, 'tx_templates', { id: tid, pub_id: pubId, slug, name, subject: String(f.subject || '').slice(0, 300), body: String(f.body || '').slice(0, 200_000), format, created_at: now(), updated_at: now() });
  return tid;
}

export const serializeTemplate = (t: any) => ({ id: t.id, slug: t.slug, name: t.name, subject: t.subject, format: t.format, body: t.body, created_at: new Date(t.created_at).toISOString(), updated_at: new Date(t.updated_at).toISOString() });

// ───────── tracking ─────────
export async function txOpen(env: Env, msgId: string, ua: string) {
  if (/bot|crawler|spider|preview/i.test(ua) && !/GoogleImageProxy|YahooMailProxy/i.test(ua)) return;
  await run(env, 'UPDATE tx_messages SET open_count = open_count + 1, opened_at = COALESCE(opened_at, ?) WHERE id = ? AND track = 1', now(), msgId);
}

export async function txClick(env: Env, msgId: string, idx: number, ua: string): Promise<string | null> {
  const m = await one<{ links: string; created_at: number }>(env, 'SELECT links, created_at FROM tx_messages WHERE id = ? AND track = 1', msgId);
  const url = m ? parseJSON<string[]>(m.links, [])[idx] : null;
  if (!url) return null;
  // link scanners fetch every link within seconds of delivery; don't count those
  if (now() - m!.created_at > 10_000 && !/bot|crawler|spider|scanner|preview/i.test(ua)) {
    await run(env, 'UPDATE tx_messages SET click_count = click_count + 1, clicked_at = COALESCE(clicked_at, ?), open_count = MAX(open_count, 1), opened_at = COALESCE(opened_at, ?) WHERE id = ?', now(), now(), msgId);
  }
  return url;
}
