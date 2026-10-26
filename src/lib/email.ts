// Low-level mail: Cloudflare Email Sending binding, suppression (global / per-pub / transactional),
// bounce classification, RFC 8058 one-click unsubscribe, Gmail Feedback-ID, local simulation outbox.
import type { Env, Publication } from '../types';
import { one, run, insert, all } from './db';
import { id, now, DAY, HOUR, mailboxProvider } from './util';
import { htmlToText } from './render';

export type SuppressScope = 'global' | 'pub' | 'transactional';

export interface MailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: { email: string; name?: string };
  replyTo?: string | null;
  pub?: Publication | null;
  /** marketing (newsletter/automation) vs transactional (login links, receipts) */
  kind?: 'marketing' | 'transactional';
  unsubscribeUrl?: string;      // https URL; also used for one-click POST
  campaignId?: string;          // send id → Feedback-ID
  headers?: Record<string, string>;
  attachments?: Array<{ content: string; filename: string; type: string; disposition: 'attachment' | 'inline' }>;
  /** Send for real even when EMAIL_MODE=simulate (used only by the demo's "send me a sample" page). */
  forceReal?: boolean;
}

export interface MailResult { ok: boolean; status: 'sent' | 'simulated' | 'failed' | 'suppressed'; messageId?: string; error?: string; code?: string; bounce?: BounceType | null; retry?: boolean }

export type BounceType = 'hard' | 'soft' | 'mailbox_full' | 'dns' | 'policy' | 'complaint';

/** Classify a provider error / DSN into a bounce type and whether we should retry. */
export function classifyBounce(codeOrMessage: string): { type: BounceType; retry: boolean } {
  const m = (codeOrMessage || '').toLowerCase();
  if (/e_recipient_suppressed|complain|abuse|spam report/.test(m)) return { type: 'complaint', retry: false };
  if (/mailbox full|quota|over quota|insufficient storage|5\.2\.2|452/.test(m)) return { type: 'mailbox_full', retry: true };
  if (/dns|nxdomain|no mx|host not found|domain not found|5\.1\.2|4\.4\.[34]/.test(m)) return { type: 'dns', retry: /4\.4\./.test(m) };
  if (/rate limit|try again|temporar|deferred|greylist|4\d\d|timeout|e_rate_limit|e_internal|unavailable/.test(m)) return { type: 'soft', retry: true };
  if (/policy|blocked|blacklist|blocklist|reputation|5\.7\.\d/.test(m)) return { type: 'policy', retry: false };
  if (/user unknown|no such user|does not exist|invalid recipient|5\.1\.1|recipient rejected|e_validation_error|550/.test(m)) return { type: 'hard', retry: false };
  return { type: 'soft', retry: true };
}

/**
 * Global-layer reasons that also block transactional mail. Everything else on the global layer (complaints, FBL reports,
 * policy blocks, mailbox-full / DNS / repeated-soft temporary entries) only blocks marketing, so a reader who marked a
 * newsletter as spam can still get their login link or receipt.
 */
export function blocksTransactional(reason: string): boolean {
  return /^(hard_bounce|manual|invalid|cf_suppressed)/.test(reason);
}

/**
 * Is this address suppressed for this kind of mail? Expired temporary suppressions are ignored.
 * - marketing: the global layer (any reason) + this publication's layer
 * - transactional: the transactional layer + global entries meaning "this mailbox doesn't exist" (see blocksTransactional)
 */
export async function isSuppressed(env: Env, email: string, pubId: string | null, kind: 'marketing' | 'transactional'): Promise<string | null> {
  const t = now();
  const rows = await all<{ scope: string; pub_id: string; reason: string; expires_at: number | null }>(
    env,
    `SELECT scope, pub_id, reason, expires_at FROM suppressions WHERE email = ? AND (expires_at IS NULL OR expires_at > ?)`,
    email.toLowerCase(), t,
  );
  for (const r of rows) {
    if (kind === 'marketing') {
      if (r.scope === 'global') return r.reason;
      if (r.scope === 'pub' && r.pub_id === (pubId || '')) return r.reason;
    } else {
      if (r.scope === 'transactional') return r.reason;
      if (r.scope === 'global' && blocksTransactional(r.reason)) return r.reason;
    }
  }
  return null;
}

/** Add a suppression. Temporary when ttlMs is given (soft bounces / mailbox full), permanent otherwise. */
export async function suppress(env: Env, email: string, scope: SuppressScope, reason: string, pubId = '', ttlMs?: number) {
  await run(
    env,
    `INSERT INTO suppressions (id, scope, pub_id, email, reason, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, pub_id, email) DO UPDATE SET reason = excluded.reason, expires_at = excluded.expires_at, created_at = excluded.created_at`,
    id(), scope, scope === 'global' ? '' : pubId, email.toLowerCase(), reason, ttlMs ? now() + ttlMs : null, now(),
  );
}

export async function unsuppress(env: Env, email: string, scope: SuppressScope, pubId = '') {
  await run(env, 'DELETE FROM suppressions WHERE email = ? AND scope = ? AND pub_id = ?', email.toLowerCase(), scope, scope === 'global' ? '' : pubId);
}

/**
 * Apply a bounce/complaint to suppression lists and subscriber status.
 * `kind` is the kind of mail that bounced. Marketing bounces write the global/publication layers; transactional bounces
 * write the transactional layer (plus global for "mailbox does not exist"), so marketing suppressions never block login
 * links while transactional hard bounces do.
 */
export async function recordBounce(env: Env, email: string, pubId: string | null, type: BounceType, detail = '', kind: 'marketing' | 'transactional' = 'marketing') {
  const e = email.toLowerCase();
  const why = detail.slice(0, 80);
  if (kind === 'transactional') {
    if (type === 'hard') {
      await suppress(env, e, 'transactional', 'hard_bounce:' + why);
      await suppress(env, e, 'global', 'hard_bounce:' + why);
      await run(env, `UPDATE subscribers SET status = 'bounced', updated_at = ? WHERE email = ? AND status IN ('active','pending')`, now(), e);
    } else if (type === 'policy') await suppress(env, e, 'transactional', 'policy:' + why);
    else if (type === 'complaint') await suppress(env, e, 'transactional', 'complaint');
    else if (type === 'mailbox_full') await suppress(env, e, 'transactional', 'mailbox_full', '', 3 * DAY);
    else if (type === 'dns') await suppress(env, e, 'transactional', 'dns_failure', '', 7 * DAY);
    return;
  }
  if (type === 'hard') {
    await suppress(env, e, 'global', 'hard_bounce:' + why);
    await run(env, `UPDATE subscribers SET status = 'bounced', updated_at = ? WHERE email = ? AND status IN ('active','pending')`, now(), e);
  } else if (type === 'policy') {
    // content/reputation blocks stop newsletters everywhere but don't block transactional mail
    await suppress(env, e, 'global', 'policy:' + why);
    await run(env, `UPDATE subscribers SET status = 'bounced', updated_at = ? WHERE email = ? AND status IN ('active','pending')`, now(), e);
  } else if (type === 'complaint') {
    await suppress(env, e, pubId ? 'pub' : 'global', 'complaint', pubId || '');
    if (pubId) await run(env, `UPDATE subscribers SET status = 'complained', unsubscribed_at = ?, updated_at = ? WHERE email = ? AND pub_id = ?`, now(), now(), e, pubId);
  } else if (type === 'mailbox_full') {
    await suppress(env, e, 'global', 'mailbox_full', '', 3 * DAY);
  } else if (type === 'dns') {
    await suppress(env, e, 'global', 'dns_failure', '', 7 * DAY);
  } else {
    // soft: escalate to temporary suppression after repeated soft bounces
    const recent = await one<{ n: number }>(env, `SELECT COUNT(*) AS n FROM deliveries WHERE email = ? AND bounce_type = 'soft' AND created_at > ?`, e, now() - 14 * DAY);
    if ((recent?.n || 0) >= 3) await suppress(env, e, 'global', 'repeated_soft_bounce', '', 14 * DAY);
  }
}

export function feedbackId(pub: Publication | null | undefined, campaignId?: string, kind = 'marketing') {
  // Gmail Feedback-ID: CampaignId:CustomerId:MailType:SenderId — lets Postmaster Tools report complaints per newsletter.
  return `${(campaignId || 'na').slice(0, 20)}:${pub?.id || 'platform'}:${kind}:openhive`;
}

/** Send one email. Never throws. In local dev without the binding (or EMAIL_MODE=simulate) it writes to the outbox only. */
export async function sendMail(env: Env, m: MailInput): Promise<MailResult> {
  const kind = m.kind || 'marketing';
  const to = m.to.trim().toLowerCase();
  const sup = await isSuppressed(env, to, m.pub?.id ?? null, kind);
  if (sup) return { ok: false, status: 'suppressed', error: 'suppressed: ' + sup };

  const from = m.from || { email: env.MAIL_FROM, name: m.pub?.from_name || m.pub?.name || env.APP_NAME };
  // Feedback-ID is platform-controlled on Cloudflare Email Sending (it sets its own for Postmaster Tools, and sending it
  // ourselves fails the whole request with E_HEADER_NOT_ALLOWED), so ours travels as an X- header. Bounce (DSN) and
  // complaint (ARF) reports quote the original headers, which is how lib/inbound maps them to a publication + mail kind.
  const headers: Record<string, string> = { 'X-OpenHive-Feedback-ID': feedbackId(m.pub, m.campaignId, kind), ...(m.headers || {}) };
  if (m.unsubscribeUrl && kind === 'marketing') {
    headers['List-Unsubscribe'] = `<${m.unsubscribeUrl}>, <mailto:${from.email}?subject=unsubscribe>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  if (m.campaignId) headers['X-OpenHive-Campaign'] = m.campaignId;
  const text = m.text || htmlToText(m.html);
  const simulate = !env.EMAIL || (env.EMAIL_MODE === 'simulate' && !m.forceReal);
  let res: MailResult;
  if (simulate) {
    res = { ok: true, status: 'simulated', messageId: 'sim-' + id() };
  } else {
    try {
      const r = await env.EMAIL!.send({
        to,
        from: { email: from.email, name: from.name || undefined },
        replyTo: m.replyTo || undefined,
        subject: m.subject,
        html: m.html,
        text,
        headers,
        attachments: m.attachments as any,
      } as any);
      res = { ok: true, status: 'sent', messageId: (r as any)?.messageId };
    } catch (e: any) {
      const code = String(e?.code || '');
      const msg = `${code} ${e?.message || e}`.trim();
      const c = classifyBounce(msg);
      res = { ok: false, status: 'failed', error: msg, code, bounce: c.type, retry: c.retry };
      if (code === 'E_SENDER_NOT_VERIFIED' || code === 'E_SENDER_DOMAIN_NOT_AVAILABLE' || code === 'E_ACCOUNT_SUSPENDED') res.retry = false, res.bounce = null;
    }
  }
  await insert(env, 'outbox', {
    id: id(), pub_id: m.pub?.id ?? null, to_email: to, from_email: `${from.name || ''} <${from.email}>`, subject: m.subject,
    html: m.html.length > 400_000 ? m.html.slice(0, 400_000) : m.html, headers: JSON.stringify(m.replyTo ? { ...headers, 'Reply-To': m.replyTo } : headers), status: res.status, error: res.error ?? null,
    message_id: res.messageId ?? null, kind, created_at: now(),
  });
  // Marketing senders (sender.ts, automations) record bounces against their delivery rows. Transactional mail (login
  // links, receipts, confirmations) has none, so permanent failures feed the transactional layer here.
  if (kind === 'transactional' && res.status === 'failed' && res.bounce && !res.retry) {
    await recordBounce(env, to, m.pub?.id ?? null, res.bounce, res.error || '', 'transactional').catch(() => {});
  }
  return res;
}

/** Transactional helper with a simple branded layout. */
export async function sendTransactional(env: Env, to: string, subject: string, bodyHtml: string, pub?: Publication | null, from?: { email: string; name?: string }): Promise<MailResult> {
  const brand = pub?.name || env.APP_NAME;
  const html = `<!DOCTYPE html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:100%;background:#fff;border-radius:10px"><tr><td style="padding:28px 28px 8px;font-size:18px;font-weight:800;color:#111">${brand.replace(/</g, '&lt;')}</td></tr>
<tr><td style="padding:8px 28px 28px;font-size:15px;line-height:1.6;color:#1f2328">${bodyHtml}</td></tr></table>
<p style="font-size:12px;color:#9ca3af">Sent by ${brand.replace(/</g, '&lt;')}${pub?.address ? ' · ' + pub.address.replace(/</g, '&lt;') : ''}</p></td></tr></table></body></html>`;
  return sendMail(env, { to, subject, html, pub, kind: 'transactional', from });
}

export function button(label: string, url: string) {
  return `<p style="margin:20px 0"><a href="${url.replace(/"/g, '&quot;')}" style="display:inline-block;background:#111827;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${label.replace(/</g, '&lt;')}</a></p>`;
}

export { mailboxProvider, HOUR };
