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
import { sendMail } from './email';
import { applyMerge, mergeVars } from './render';
import { markdownToHtml } from './markdown';
import { senderFor, siteUrl, appUrl } from './pub';
import { validateEmail } from './guard';
import { limit } from './apiauth';
import { id, now, esc, parseJSON, slugify, DAY } from './util';

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
  attachments?: Array<{ filename: string; content: string; type?: string }>;
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

/** Send one transactional email. Throws TxError (status + code) for caller errors. */
export async function sendTx(env: Env, pub: Publication, input: TxInput, o: { keyId?: string | null } = {}) {
  if (!input || typeof input !== 'object') throw new TxError(400, 'bad_request', 'JSON body required.');
  const idem = input.idempotency_key ? String(input.idempotency_key).slice(0, 200) : null;
  if (idem) {
    const prev = await one<any>(env, 'SELECT * FROM tx_messages WHERE pub_id = ? AND idempotency_key = ?', pub.id, idem);
    if (prev) return { ...serializeTx(prev), duplicate: true };
  }
  const v = await validateEmail(String(input.to || ''), { strict: false });
  if (!v.ok) throw new TxError(400, 'invalid_recipient', `"to" is not a valid email address${v.reason ? ` (${v.reason})` : ''}.`);
  const to = v.email;
  if (o.keyId) {
    const rl = await limit(env, 'tx:' + o.keyId, TX_PER_MINUTE_PER_KEY, 60);
    if (!rl.ok) throw new TxError(429, 'rate_limited', `Transactional rate limit of ${TX_PER_MINUTE_PER_KEY} emails per minute per API key exceeded.`);
  }
  const cap = await dailyCap(env, pub);
  if (cap !== Infinity && (await val<number>(env, 'SELECT COUNT(*) FROM tx_messages WHERE pub_id = ? AND created_at > ?', pub.id, now() - DAY)) >= cap) {
    throw new TxError(429, 'daily_cap', `This publication has sent ${cap} transactional emails in the last 24 hours, the cap on its plan.`);
  }
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
  const attachments = (input.attachments || []).slice(0, 10).map((a) => ({ content: String(a?.content || '').replace(/\s/g, ''), filename: String(a?.filename || 'attachment').slice(0, 120), type: String(a?.type || 'application/octet-stream'), disposition: 'attachment' as const }));
  const bytes = attachments.reduce((n, a) => n + Math.floor((a.content.length * 3) / 4), 0);
  if (bytes > MAX_ATTACH_BYTES) throw new TxError(400, 'bad_request', 'Attachments may total at most 5 MB.');
  if (attachments.some((a) => !/^[A-Za-z0-9+/]*={0,2}$/.test(a.content))) throw new TxError(400, 'bad_request', 'Attachment content must be base64.');
  const mid = 'tx_' + id(18);
  const track = !!input.track;
  let links: string[] = [];
  if (track) ({ html: body, links } = addTracking(env, mid, body));
  const tags = (Array.isArray(input.tags) ? input.tags : []).map((t) => String(t).trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 10);
  let replyTo: string | null = null;
  if (input.reply_to) { const r = await validateEmail(String(input.reply_to), { strict: false }); if (!r.ok) throw new TxError(400, 'bad_request', 'reply_to is not a valid email address.'); replyTo = r.email; }
  const from = await senderFor(env, pub, 'transactional');
  // reserve the idempotency key before sending so concurrent retries can't double-send
  try {
    await insert(env, 'tx_messages', { id: mid, pub_id: pub.id, api_key_id: o.keyId ?? null, template_id: templateId, to_email: to, subject, status: 'sending', tags: JSON.stringify(tags), idempotency_key: idem, track: track ? 1 : 0, links: JSON.stringify(links), created_at: now() });
  } catch (e: any) {
    if (idem && /UNIQUE/i.test(String(e?.message))) { const prev = await one<any>(env, 'SELECT * FROM tx_messages WHERE pub_id = ? AND idempotency_key = ?', pub.id, idem); if (prev) return { ...serializeTx(prev), duplicate: true }; }
    throw e;
  }
  const res = await sendMail(env, { to, subject, html: body, text: input.text, from: { email: from.email, name: input.from_name ? String(input.from_name).slice(0, 80) : from.name }, replyTo, pub, kind: 'transactional', headers: { 'X-OpenHive-Tx': mid } });
  await run(env, 'UPDATE tx_messages SET status = ?, error = ?, message_id = ? WHERE id = ?', res.status, res.error ?? null, res.messageId ?? null, mid);
  return serializeTx((await one<any>(env, 'SELECT * FROM tx_messages WHERE id = ?', mid))!);
}

export function serializeTx(m: any) {
  const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);
  return { id: m.id, to: m.to_email, subject: m.subject, status: m.status, error: m.error || null, message_id: m.message_id, template_id: m.template_id, tags: parseJSON(m.tags, []), idempotency_key: m.idempotency_key, tracking: !!m.track, opens: m.open_count, clicks: m.click_count, opened_at: iso(m.opened_at), clicked_at: iso(m.clicked_at), created_at: iso(m.created_at) };
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
