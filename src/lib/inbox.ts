// Reply inbox (Mailchimp-style "Inbox"). When a publication turns on "Collect replies in Inbox", newsletter and
// automation emails carry Reply-To: reply+<pub-slug>.<delivery-id prefix>@<SHARED_FROM_DOMAIN>. Email Routing delivers
// those replies to the Worker's email() handler (lib/inbound → handleInboundReply), which stores them as threads linked
// to the subscriber and the post. Owners answer from Audience → Inbox; answers go out from the publication's sender with
// In-Reply-To/References so mail clients thread them, and with the same Reply-To so the conversation continues here.
import type { Env, Publication } from '../types';
import { one, run, insert } from './db';
import { sendMail, type MailResult } from './email';
import { emit } from './events';
import { parseMime, type MimePart, type InboundMessage, logInbound } from './inbound';
import { pubBySlug, senderFor, settings, appUrl } from './pub';
import { sharedDomain } from './sharedsender';
import { id, now, esc } from './util';

const SHORT = 12; // delivery-id prefix length in the reply address (ids are 20 random base-36 chars)

export function replyAddress(env: Env, pub: Pick<Publication, 'slug'>, deliveryId: string): string {
  return `reply+${pub.slug.toLowerCase()}.${deliveryId.slice(0, SHORT)}@${sharedDomain(env)}`;
}

export function collectsReplies(pub: Publication): boolean {
  return settings(pub).collect_replies === true;
}

/** Reply-To for one newsletter/automation email (sendMail hook). The delivery row is created just before sending. */
export async function inboxReplyTo(env: Env, pub: Publication, sendId: string, to: string): Promise<string | null> {
  if (!collectsReplies(pub) || !sharedDomain(env)) return null;
  const d = await one<{ id: string }>(env, 'SELECT id FROM deliveries WHERE send_id = ? AND email = ? ORDER BY created_at DESC LIMIT 1', sendId, to.toLowerCase());
  return d ? replyAddress(env, pub, d.id) : null;
}

/** reply+<slug>.<short>@<shared domain> → parts, or null for any other address. */
export function parseReplyAddress(env: Env, rcpt: string): { slug: string; short: string } | null {
  const m = /^reply\+([a-z0-9-]+)\.([a-z0-9]{6,20})@(.+)$/i.exec(rcpt.trim().toLowerCase());
  if (!m || m[3] !== sharedDomain(env)) return null;
  return { slug: m[1], short: m[2] };
}

// ───────── MIME helpers ─────────
/** RFC 2047 encoded-words (=?UTF-8?B?…?= / =?UTF-8?Q?…?=) in headers. */
export function decodeWords(s: string): string {
  return (s || '').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=(\s+(?==\?))?/g, (_, cs: string, enc: string, txt: string) => {
    try {
      let bytes: Uint8Array;
      if (enc.toUpperCase() === 'B') bytes = Uint8Array.from(atob(txt), (c) => c.charCodeAt(0));
      else {
        const out: number[] = [];
        const q = txt.replace(/_/g, ' ');
        for (let i = 0; i < q.length; i++) {
          if (q[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(q.slice(i + 1, i + 3))) { out.push(parseInt(q.slice(i + 1, i + 3), 16)); i += 2; }
          else out.push(...new TextEncoder().encode(q[i]));
        }
        bytes = new Uint8Array(out);
      }
      return new TextDecoder(/utf-?8/i.test(cs) ? 'utf-8' : cs.toLowerCase()).decode(bytes);
    } catch { return txt; }
  });
}

function parseAddress(v: string): { email: string; name: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(v || '');
  if (m) return { email: m[2].trim().toLowerCase(), name: decodeWords(m[1].trim()) };
  return { email: (/([^\s<>"]+@[^\s<>"]+)/.exec(v || '')?.[1] || '').toLowerCase(), name: '' };
}

function bodies(root: MimePart): { text: string; html: string } {
  let text = '', html = '';
  const walk = (p: MimePart) => {
    const disp = (p.headers['content-disposition'] || '').toLowerCase();
    if (disp.startsWith('attachment')) return;
    if (!text && p.type === 'text/plain' && p.body) text = p.body;
    if (!html && p.type === 'text/html' && p.body) html = p.body;
    for (const c of p.parts) walk(c);
  };
  walk(root);
  if (!text && html) text = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
  return { text, html };
}

/** The new part of a reply (drops "On … wrote:" and the quoted lines below it). */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^On .{4,200}wrote:\s*$/.test(l) || (/^On .{4,200}$/.test(l) && /wrote:\s*$/.test(lines[i + 1] || '')) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l) || /^From: .+/.test(l) && /^(Sent|Date): /.test(lines[i + 1] || '')) break;
    if (/^>/.test(l)) continue;
    out.push(l);
  }
  return out.join('\n').trim() || text.trim();
}

// ───────── inbound ─────────
export async function handleInboundReply(env: Env, message: InboundMessage, raw: string, rcpt: string): Promise<{ type: string; processed: number }> {
  const addr = parseReplyAddress(env, rcpt);
  const pub = addr ? await pubBySlug(env, addr.slug) : null;
  const d = pub && addr ? await one<any>(env, `SELECT d.id, d.email, d.subscriber_id, d.send_id, se.post_id, se.automation_id FROM deliveries d JOIN sends se ON se.id = d.send_id WHERE d.pub_id = ? AND d.id LIKE ? LIMIT 1`, pub.id, addr.short + '%') : null;
  if (!pub || !d) {
    message.setReject('Unknown reply address.');
    await logInbound(env, { source: 'email', kind: 'rejected', email: message.from, pubId: pub?.id, detail: `reply to unknown address ${rcpt}` });
    return { type: 'reply', processed: 0 };
  }
  const root = parseMime(raw);
  const h = root.headers;
  const from = parseAddress(decodeWords(h['from'] || '')) ;
  const envelope = (message.from || '').toLowerCase();
  const email = from.email || envelope;
  // The envelope sender is what Email Routing authenticated; header From can be spoofed. A reply is "verified" when either
  // matches the person this email was delivered to.
  const verified = envelope === d.email || (from.email === d.email && !!from.email);
  const subject = decodeWords(h['subject'] || '').slice(0, 300);
  const { text, html } = bodies(root);
  const msgId = (h['message-id'] || '').replace(/[<>]/g, '').trim() || null;
  const inReplyTo = (h['in-reply-to'] || '').replace(/[<>]/g, '').trim() || null;
  if (msgId && (await one(env, 'SELECT 1 FROM inbox_messages WHERE pub_id = ? AND message_id = ?', pub.id, msgId))) return { type: 'reply', processed: 0 }; // redelivery
  const sub = await one<{ id: string }>(env, 'SELECT id FROM subscribers WHERE pub_id = ? AND email = ?', pub.id, email) || (verified && d.subscriber_id ? { id: d.subscriber_id } : null);
  const t = now();
  let thread = inReplyTo ? await one<any>(env, `SELECT t.* FROM inbox_messages m JOIN inbox_threads t ON t.id = m.thread_id WHERE m.pub_id = ? AND m.message_id = ? AND t.email = ?`, pub.id, inReplyTo, email) : null;
  thread ||= await one<any>(env, 'SELECT * FROM inbox_threads WHERE pub_id = ? AND email = ? AND delivery_id = ? ORDER BY created_at DESC LIMIT 1', pub.id, email, d.id);
  if (!thread) {
    const tid = id();
    await insert(env, 'inbox_threads', { id: tid, pub_id: pub.id, email, name: from.name.slice(0, 120), subscriber_id: sub?.id ?? null, delivery_id: d.id, send_id: d.send_id, post_id: d.post_id ?? null, subject: subject.replace(/^(re|aw|fw|fwd):\s*/i, ''), status: 'open', unread: 1, verified: verified ? 1 : 0, message_count: 0, last_message_at: t, created_at: t });
    thread = { id: tid };
  }
  await insert(env, 'inbox_messages', { id: id(), thread_id: thread.id, pub_id: pub.id, direction: 'in', from_email: email, from_name: from.name.slice(0, 120), to_email: rcpt, subject, text: text.slice(0, 50_000), html: html ? html.slice(0, 200_000) : null, message_id: msgId, in_reply_to: inReplyTo, created_at: t });
  await run(env, `UPDATE inbox_threads SET unread = 1, status = 'open', message_count = message_count + 1, last_message_at = ?, subscriber_id = COALESCE(subscriber_id, ?), name = CASE WHEN name = '' THEN ? ELSE name END WHERE id = ?`, t, sub?.id ?? null, from.name.slice(0, 120), thread.id);
  await logInbound(env, { source: 'email', kind: 'reply', email, pubId: pub.id, detail: `reply to ${rcpt}${verified ? '' : ' (sender differs from recipient)'}` });
  if (sub) await emit(env, { pubId: pub.id, type: 'email.replied', subscriberId: sub.id, refId: d.post_id || d.automation_id, data: { thread_id: thread.id, post_id: d.post_id, subject } });
  const cfg = settings(pub);
  if (cfg.inbox_forward) await forwardCopy(env, pub, thread.id, { email, name: from.name }, subject, stripQuoted(text)).catch(() => {});
  return { type: 'reply', processed: 1 };
}

/** Optional copy of each reply to the owner (or settings.inbox_forward_to). Sent as a normal email, so the destination
 *  doesn't have to be a verified Email Routing address; replying to it reaches the reader directly. */
async function forwardCopy(env: Env, pub: Publication, threadId: string, from: { email: string; name: string }, subject: string, text: string) {
  const cfg = settings(pub);
  const to = (typeof cfg.inbox_forward_to === 'string' && cfg.inbox_forward_to) || (await one<{ email: string }>(env, 'SELECT u.email FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE w.id = ?', pub.workspace_id))?.email;
  if (!to) return;
  const html = `<p style="color:#6b7280;font-size:13px">${esc(from.name || from.email)} &lt;${esc(from.email)}&gt; replied to <strong>${esc(pub.name)}</strong>:</p>
<div style="white-space:pre-wrap;border-left:3px solid #e5e7eb;padding:4px 12px;margin:12px 0">${esc(text.slice(0, 20_000))}</div>
<p><a href="${esc(appUrl(env, `/app/audience/inbox/${threadId}?pub=${pub.id}`))}">Open in Inbox</a></p>`;
  await sendMail(env, { to, subject: `Reply: ${subject || '(no subject)'}`, html, pub, kind: 'transactional', replyTo: from.email, headers: { 'X-OpenHive-Inbox': threadId } });
}

// ───────── outbound ─────────
export async function sendInboxReply(env: Env, pub: Publication, threadId: string, body: string, userId: string | null): Promise<MailResult & { error?: string }> {
  const th = await one<any>(env, 'SELECT * FROM inbox_threads WHERE id = ? AND pub_id = ?', threadId, pub.id);
  if (!th) return { ok: false, status: 'failed', error: 'thread not found' };
  const last = await one<any>(env, `SELECT message_id, subject FROM inbox_messages WHERE thread_id = ? AND direction = 'in' AND message_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`, th.id);
  const refs = (await one<{ r: string }>(env, `SELECT GROUP_CONCAT('<' || message_id || '>', ' ') AS r FROM (SELECT message_id FROM inbox_messages WHERE thread_id = ? AND message_id IS NOT NULL ORDER BY created_at LIMIT 20)`, th.id))?.r || '';
  const from = await senderFor(env, pub, 'newsletter');
  const subject = /^re:/i.test(last?.subject || th.subject) ? (last?.subject || th.subject) : `Re: ${last?.subject || th.subject || pub.name}`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2328;white-space:pre-wrap">${esc(body)}</div>`;
  const headers: Record<string, string> = {};
  if (last?.message_id) { headers['In-Reply-To'] = `<${last.message_id}>`; headers['References'] = refs || `<${last.message_id}>`; }
  const replyTo = th.delivery_id ? replyAddress(env, pub, th.delivery_id) : null;
  const res = await sendMail(env, { to: th.email, subject, html, text: body, from, pub, kind: 'transactional', replyTo, headers });
  if (res.ok) {
    const t = now();
    await insert(env, 'inbox_messages', { id: id(), thread_id: th.id, pub_id: pub.id, direction: 'out', from_email: from.email, from_name: from.name, to_email: th.email, subject, text: body.slice(0, 50_000), html: null, message_id: res.messageId ?? null, in_reply_to: last?.message_id ?? null, sent_by: userId, created_at: t });
    await run(env, 'UPDATE inbox_threads SET message_count = message_count + 1, last_message_at = ?, unread = 0 WHERE id = ?', t, th.id);
  }
  return res;
}
