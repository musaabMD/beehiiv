// Inbound bounce / complaint / unsubscribe processing, shared by every entry point:
//  - Worker email() handler (Cloudflare Email Routing → bounces@ / fbl@ / the sender address itself)
//  - Worker queue() handler (Cloudflare Email Sending event subscriptions: message.bounced / message.complained / …)
//  - POST /hooks/bounce and /hooks/fbl (any external forwarder)
// Parses RFC 3464 DSNs (multipart/report; report-type=delivery-status), RFC 5965 ARF feedback reports
// (multipart/report; report-type=feedback-report), non-standard MTA bounces and RFC 2369 mailto: unsubscribes,
// then feeds lib/email's classification + suppression code. See docs/DELIVERABILITY.md.
import type { Env } from '../types';
import { one, all, run, insert } from './db';
import { classifyBounce, recordBounce, type BounceType } from './email';
import { verifySubToken, unsubscribe } from './subscribers';
import { senderFor, getPub } from './pub';
import { id, now, DAY } from './util';
import { dmarcRecipient, handleDmarcEmail } from './dmarc';

export type MailKind = 'marketing' | 'transactional';
export type ReportSource = 'email' | 'queue' | 'hook';

// ───────────────────────── MIME ─────────────────────────
export interface MimePart {
  headers: Record<string, string>;
  type: string;                    // lower-case media type, e.g. multipart/report
  params: Record<string, string>;  // content-type parameters (boundary, report-type, charset…)
  body: string;                    // decoded body (text) for leaf parts
  rawBody?: string;                // undecoded body of base64 leaf parts (binary attachments: DMARC .zip / .gz)
  parts: MimePart[];               // children for multipart/* and message/rfc822
}

function splitHead(raw: string): [string, string] {
  const m = /\r?\n\r?\n/.exec(raw);
  return m ? [raw.slice(0, m.index), raw.slice(m.index + m[0].length)] : [raw, ''];
}

/** Parse an RFC 5322 header block (unfolds continuation lines, lower-cases names, keeps the first occurrence). */
export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ').split('\n');
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    if (!(k in out)) out[k] = line.slice(i + 1).trim();
  }
  return out;
}

function parseContentType(v: string | undefined): { type: string; params: Record<string, string> } {
  const [t, ...rest] = (v || 'text/plain').split(';');
  const params: Record<string, string> = {};
  for (const p of rest) {
    const i = p.indexOf('=');
    if (i > 0) params[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
  return { type: t.trim().toLowerCase(), params };
}

function decodeBody(body: string, cte: string | undefined): string {
  const enc = (cte || '').toLowerCase();
  try {
    if (enc === 'base64') {
      const bin = atob(body.replace(/[^A-Za-z0-9+/=]/g, ''));
      return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
    }
    if (enc === 'quoted-printable') {
      const bytes: number[] = [];
      const s = body.replace(/=\r?\n/g, '');
      for (let i = 0; i < s.length; i++) {
        if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
        else bytes.push(...new TextEncoder().encode(s[i]));
      }
      return new TextDecoder().decode(new Uint8Array(bytes));
    }
  } catch { /* fall through to raw */ }
  return body;
}

export function parseMime(raw: string, depth = 0): MimePart {
  const [head, rawBody] = splitHead(raw);
  const headers = parseHeaders(head);
  const { type, params } = parseContentType(headers['content-type']);
  const part: MimePart = { headers, type, params, body: '', parts: [] };
  if (depth > 6) return part;
  if (type.startsWith('multipart/') && params.boundary) {
    const b = '--' + params.boundary;
    const chunks = rawBody.split(b);
    for (const chunk of chunks.slice(1)) {
      if (chunk.startsWith('--')) break; // closing boundary
      part.parts.push(parseMime(chunk.replace(/^\r?\n/, '').replace(/\r?\n$/, ''), depth + 1));
    }
  } else if (type === 'message/rfc822' || type === 'message/global') {
    part.parts.push(parseMime(decodeBody(rawBody, headers['content-transfer-encoding']), depth + 1));
  } else {
    part.body = decodeBody(rawBody, headers['content-transfer-encoding']);
    if ((headers['content-transfer-encoding'] || '').toLowerCase() === 'base64' && !type.startsWith('text/')) part.rawBody = rawBody;
  }
  return part;
}

function walk(p: MimePart, fn: (p: MimePart) => void) {
  fn(p);
  for (const c of p.parts) walk(c, fn);
}

function find(p: MimePart, pred: (p: MimePart) => boolean): MimePart | null {
  let hit: MimePart | null = null;
  walk(p, (x) => { if (!hit && pred(x)) hit = x; });
  return hit;
}

/** Header blocks of a message/delivery-status or message/feedback-report body (separated by blank lines). */
function fieldGroups(body: string): Array<Record<string, string>> {
  return body.replace(/\r\n/g, '\n').split(/\n\s*\n/).map((g) => parseHeaders(g)).filter((g) => Object.keys(g).length);
}

const addr = (v: string | undefined): string | null => {
  const m = /([A-Za-z0-9._%+'=-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec((v || '').replace(/^[a-z0-9-]+;\s*/i, ''));
  return m ? m[1].toLowerCase() : null;
};

// ───────────────────────── report parsing ─────────────────────────
export interface OriginalRef {
  feedbackId?: string;     // X-OpenHive-Feedback-ID (campaign:pub:kind:openhive)
  campaign?: string;       // X-OpenHive-Campaign (send id)
  messageId?: string;      // original Message-ID
  to?: string;             // original To
  unsubToken?: string;     // /u/<token> from List-Unsubscribe or the body — identifies the subscriber even when FBLs redact the recipient
}

export interface ParsedRecipient { email: string; action: string; status: string; diagnostic: string }

export type ParsedReport =
  | { type: 'dsn'; recipients: ParsedRecipient[]; original: OriginalRef; standard: boolean }
  | { type: 'arf'; feedbackType: string; recipients: string[]; original: OriginalRef }
  | { type: 'unsubscribe'; from: string | null }
  | { type: 'auto'; reason: string }
  | { type: 'other' };

function originalRef(root: MimePart): OriginalRef {
  // the quoted original: message/rfc822 child, or text/rfc822-headers body
  const msg = find(root, (p) => p.type === 'message/rfc822' || p.type === 'message/global');
  const hdrPart = find(root, (p) => p.type === 'text/rfc822-headers' || p.type === 'message/rfc822-headers');
  const orig = msg?.parts[0];
  const h: Record<string, string> = { ...(hdrPart ? parseHeaders(hdrPart.body) : {}), ...(orig?.headers || {}) };
  let text = '';
  if (orig) walk(orig, (p) => { if (p.body) text += '\n' + p.body; });
  if (hdrPart) text += '\n' + hdrPart.body;
  const tok = /\/u\/([A-Za-z0-9_-]+\.[A-Za-z0-9]+)/.exec(`${h['list-unsubscribe'] || ''}\n${text}`)?.[1];
  return {
    feedbackId: h['x-openhive-feedback-id'] || h['feedback-id'] || undefined,
    campaign: h['x-openhive-campaign'] || undefined,
    messageId: (h['message-id'] || '').replace(/[<>]/g, '') || undefined,
    to: addr(h['to']) || undefined,
    unsubToken: tok,
  };
}

/** Classify and parse a raw inbound message. */
export function parseReport(raw: string, envelopeFrom = ''): ParsedReport {
  const root = parseMime(raw);
  const subject = (root.headers['subject'] || '').trim();
  const from = (root.headers['from'] || '') + ' ' + envelopeFrom;

  // RFC 5965 ARF feedback report
  const fb = find(root, (p) => p.type === 'message/feedback-report');
  if (fb || (root.type === 'multipart/report' && root.params['report-type'] === 'feedback-report')) {
    const f = fb ? fieldGroups(fb.body).reduce((a, g) => ({ ...a, ...g }), {} as Record<string, string>) : {};
    const original = originalRef(root);
    const rcpts = new Set<string>();
    for (const k of ['original-rcpt-to', 'removal-recipient']) { const a = addr(f[k]); if (a) rcpts.add(a); }
    if (!rcpts.size && original.to) rcpts.add(original.to);
    return { type: 'arf', feedbackType: (f['feedback-type'] || 'abuse').toLowerCase(), recipients: [...rcpts], original };
  }

  // RFC 3464 DSN
  const ds = find(root, (p) => p.type === 'message/delivery-status' || p.type === 'message/global-delivery-status');
  if (ds) {
    const groups = fieldGroups(ds.body);
    const recipients: ParsedRecipient[] = [];
    for (const g of groups) {
      const email = addr(g['final-recipient']) || addr(g['original-recipient']);
      if (!email) continue;
      recipients.push({ email, action: (g['action'] || 'failed').toLowerCase(), status: g['status'] || '', diagnostic: (g['diagnostic-code'] || '').replace(/^smtp;\s*/i, '') });
    }
    return { type: 'dsn', recipients, original: originalRef(root), standard: true };
  }

  // Auto-replies / out-of-office: never bounce or forward these (mail loops)
  const auto = (root.headers['auto-submitted'] || '').toLowerCase();
  const prec = (root.headers['precedence'] || '').toLowerCase();
  const isDaemon = /mailer-daemon|postmaster|mail delivery (subsystem|system)/i.test(from);
  if (!isDaemon && ((auto && auto !== 'no') || /^(auto_reply|bulk|junk|list)$/.test(prec) || root.headers['x-autoreply'] || root.headers['x-autorespond'])) return { type: 'auto', reason: auto || prec || 'auto-reply' };

  // Non-standard bounces (qmail, some Exchange setups): best effort, recipients verified against our sends later
  if (isDaemon && /undeliver|undelivered|delivery (status|failure|has failed)|failure notice|returned mail|could not be delivered|mail delivery failed/i.test(subject + ' ' + from)) {
    let text = '';
    walk(root, (p) => { if (p.type.startsWith('text/') && p.body) text += '\n' + p.body; });
    const recipients: ParsedRecipient[] = [];
    const seen = new Set<string>();
    for (const m of text.matchAll(/<?([A-Za-z0-9._%+'=-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>?:?\s*\n?\s*(.{0,300})/g)) {
      const email = m[1].toLowerCase();
      if (seen.has(email)) continue;
      const code = /\b([45]\.\d{1,3}\.\d{1,3})\b/.exec(m[2])?.[1] || /\b([45]\d\d)\b/.exec(m[2])?.[1] || '';
      if (!code && !/unknown|does not exist|no such|invalid|rejected|full|quota/i.test(m[2])) continue;
      seen.add(email);
      recipients.push({ email, action: 'failed', status: code, diagnostic: m[2].trim().slice(0, 200) });
    }
    return { type: 'dsn', recipients, original: originalRef(root), standard: false };
  }

  // RFC 2369 mailto: unsubscribe (List-Unsubscribe: <mailto:sender?subject=unsubscribe>)
  if (/^\s*(re:\s*)?unsubscribe\b/i.test(subject)) return { type: 'unsubscribe', from: addr(root.headers['from']) || addr(envelopeFrom) };

  return { type: 'other' };
}

// ───────────────────────── shared application logic ─────────────────────────
interface Ctx { pubId: string | null; kind: MailKind; campaign: string | null; messageId: string | null }

/** Work out which publication / kind of mail a report is about from the quoted original + our own outbox. */
export async function resolveContext(env: Env, email: string, o: Partial<OriginalRef> & { pubId?: string | null; kind?: MailKind | null }): Promise<Ctx> {
  const fid = (o.feedbackId || '').split(':');
  let pubId: string | null = o.pubId || (fid[3] === 'openhive' && fid[1] && fid[1] !== 'platform' ? fid[1] : null);
  let kind: MailKind | null = o.kind || (fid[2] === 'transactional' ? 'transactional' : fid[2] === 'marketing' ? 'marketing' : null);
  let campaign = o.campaign || (fid[3] === 'openhive' && fid[0] && fid[0] !== 'na' ? fid[0] : null);
  const messageId = o.messageId || null;
  if (!pubId && campaign) pubId = (await one<any>(env, 'SELECT pub_id FROM sends WHERE id = ?', campaign))?.pub_id || null;
  if ((!pubId || !kind) && messageId) {
    const d = await one<any>(env, 'SELECT pub_id, send_id FROM deliveries WHERE message_id = ? LIMIT 1', messageId);
    if (d) { pubId ||= d.pub_id; kind ||= 'marketing'; campaign ||= d.send_id; }
    else {
      const ob = await one<any>(env, 'SELECT pub_id, kind FROM outbox WHERE message_id = ? LIMIT 1', messageId);
      if (ob) { pubId ||= ob.pub_id; kind ||= ob.kind; }
    }
  }
  if (!kind) {
    // most recent message to this address decides (within 30 days)
    const ob = await one<any>(env, 'SELECT pub_id, kind FROM outbox WHERE to_email = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1', email, now() - 30 * DAY);
    if (ob) { kind = ob.kind === 'transactional' ? 'transactional' : 'marketing'; pubId ||= ob.pub_id; }
  }
  return { pubId, kind: kind || 'marketing', campaign, messageId };
}

/** Did we actually email this address recently? Unauthenticated inbound mail can only suppress addresses we mailed. */
export async function sentRecently(env: Env, email: string): Promise<boolean> {
  return !!(await one(env, 'SELECT 1 FROM outbox WHERE to_email = ? AND created_at > ? LIMIT 1', email.toLowerCase(), now() - 45 * DAY))
    || !!(await one(env, 'SELECT 1 FROM deliveries WHERE email = ? AND created_at > ? LIMIT 1', email.toLowerCase(), now() - 45 * DAY));
}

export async function logInbound(env: Env, r: { source: ReportSource; kind: string; email?: string | null; pubId?: string | null; mailKind?: string | null; bounceType?: string | null; detail?: string }) {
  await insert(env, 'inbound_reports', { id: id(), source: r.source, kind: r.kind, email: r.email ?? null, pub_id: r.pubId ?? null, mail_kind: r.mailKind ?? null, bounce_type: r.bounceType ?? null, detail: (r.detail || '').slice(0, 500), created_at: now() }).catch(() => {});
}

export interface BounceInput {
  email: string;
  /** 'complaint' or a BounceType; omitted → classified from status + diagnostic */
  type?: BounceType | 'bounce' | 'complaint' | null;
  status?: string;        // enhanced status code, e.g. 5.1.1
  diagnostic?: string;
  pubId?: string | null;
  kind?: MailKind | null;
  original?: Partial<OriginalRef>;
}

/** Classify a bounce from an enhanced status code + diagnostic text. 5.x.x is permanent even if the text looks soft. */
export function classify(status: string, diagnostic: string): BounceType {
  const s = (status || '').trim();
  const c = classifyBounce(`${s} ${diagnostic || ''}`.trim() || 'hard').type;
  if (/^5\./.test(s) || /^5\d\d\b/.test((diagnostic || '').trim())) return c === 'soft' ? 'hard' : c;
  return c;
}

/** Apply one bounce (any source): suppression layer by mail kind, subscriber status, delivery row. */
export async function applyBounce(env: Env, it: BounceInput, source: ReportSource): Promise<{ email: string; type: BounceType; kind: MailKind; pubId: string | null }> {
  const email = it.email.trim().toLowerCase();
  const ctx = await resolveContext(env, email, { ...(it.original || {}), pubId: it.pubId, kind: it.kind });
  const type: BounceType = it.type === 'complaint' ? 'complaint'
    : it.type && it.type !== 'bounce' ? it.type
    : !it.status && !it.diagnostic ? 'hard' // "this address bounced" with no detail = permanent
    : classify(it.status || '', it.diagnostic || '');
  await recordBounce(env, email, ctx.pubId, type, it.diagnostic || it.status || source, ctx.kind);
  if (ctx.kind === 'marketing') {
    const st = type === 'complaint' ? 'complained' : 'bounced';
    if (ctx.messageId && (await one(env, 'SELECT 1 FROM deliveries WHERE message_id = ?', ctx.messageId))) await run(env, `UPDATE deliveries SET status = ?, bounce_type = ? WHERE message_id = ?`, st, type, ctx.messageId);
    else if (ctx.campaign) await run(env, `UPDATE deliveries SET status = ?, bounce_type = ? WHERE send_id = ? AND email = ?`, st, type, ctx.campaign, email);
    else await run(env, `UPDATE deliveries SET status = ?, bounce_type = ? WHERE id = (SELECT id FROM deliveries WHERE email = ? ORDER BY created_at DESC LIMIT 1)`, st, type, email);
  }
  if (ctx.kind === 'transactional' && ctx.messageId) await run(env, `UPDATE tx_messages SET status = ?, error = ? WHERE message_id = ?`, type === 'complaint' ? 'complained' : 'bounced', (it.diagnostic || it.status || type).slice(0, 300), ctx.messageId).catch(() => {}); // transactional API log
  await logInbound(env, { source, kind: type === 'complaint' ? 'complaint' : 'bounce', email, pubId: ctx.pubId, mailKind: ctx.kind, bounceType: type, detail: [it.status, it.diagnostic].filter(Boolean).join(' ') });
  return { email, type, kind: ctx.kind, pubId: ctx.pubId };
}

/** Complaint (ARF / FBL / Email Sending complained event). */
export async function applyComplaint(env: Env, it: { email: string; pubId?: string | null; kind?: MailKind | null; original?: Partial<OriginalRef>; detail?: string }, source: ReportSource) {
  return applyBounce(env, { email: it.email, type: 'complaint', pubId: it.pubId, kind: it.kind, original: it.original, diagnostic: it.detail || 'complaint' }, source);
}

/** Resolve the subscriber behind an unsubscribe token (works when the FBL redacted the recipient address). */
async function subFromToken(env: Env, tok?: string): Promise<{ email: string; pubId: string } | null> {
  if (!tok) return null;
  const sid = await verifySubToken(env, tok);
  if (!sid) return null;
  const s = await one<any>(env, 'SELECT email, pub_id FROM subscribers WHERE id = ?', sid);
  return s ? { email: s.email, pubId: s.pub_id } : null;
}

// ───────────────────────── entry points ─────────────────────────

/** POST /hooks/bounce — JSON items ({email, type?, diagnostic?, pub_id?, kind?}) or a raw DSN. Trusted (keyed). */
export async function processBounceHook(env: Env, contentType: string, bodyText: string): Promise<{ processed: number }> {
  let n = 0;
  if (contentType.includes('json')) {
    let j: any;
    try { j = JSON.parse(bodyText); } catch { return { processed: 0 }; }
    for (const x of Array.isArray(j) ? j : [j]) {
      if (!x || typeof x.email !== 'string' || !x.email.includes('@')) continue;
      await applyBounce(env, { email: x.email, type: x.type === 'complaint' ? 'complaint' : 'bounce', diagnostic: x.diagnostic || '', status: x.status || '', pubId: x.pub_id || null, kind: x.kind === 'transactional' ? 'transactional' : x.kind === 'marketing' ? 'marketing' : null }, 'hook');
      n++;
    }
    return { processed: n };
  }
  const r = parseReport(bodyText);
  if (r.type === 'dsn' && r.recipients.length) {
    for (const rc of r.recipients) {
      if (rc.action === 'delayed' || rc.action === 'delivered' || rc.action === 'relayed' || rc.action === 'expanded') continue;
      await applyBounce(env, { email: rc.email, status: rc.status, diagnostic: rc.diagnostic, original: r.original }, 'hook');
      n++;
    }
    return { processed: n };
  }
  if (r.type === 'arf') return { processed: (await applyArf(env, r, 'hook', false)).length };
  // legacy: bare "Final-Recipient: x / Diagnostic-Code: y" text without MIME structure
  for (const m of bodyText.matchAll(/(?:Final-Recipient|Original-Rcpt-To|Original-Recipient):\s*(?:rfc822;)?\s*<?([^\s>;]+@[^\s>;]+)/gi)) {
    await applyBounce(env, { email: m[1], status: bodyText.match(/Status:\s*(\S+)/i)?.[1] || '', diagnostic: bodyText.match(/Diagnostic-Code:\s*(.+)/i)?.[1] || 'hard' }, 'hook');
    n++;
  }
  return { processed: n };
}

async function applyArf(env: Env, r: Extract<ParsedReport, { type: 'arf' }>, source: ReportSource, verify: boolean): Promise<string[]> {
  const targets = new Map<string, string | null>(); // email → pub
  for (const e of r.recipients) targets.set(e, null);
  const viaTok = await subFromToken(env, r.original.unsubToken);
  if (viaTok) targets.set(viaTok.email.toLowerCase(), viaTok.pubId);
  const done: string[] = [];
  if (r.feedbackType === 'not-spam') return done;
  for (const [email, pubId] of targets) {
    if (verify && !pubId && !(await sentRecently(env, email))) { await logInbound(env, { source, kind: 'ignored', email, detail: 'ARF for an address we have not mailed' }); continue; }
    await applyComplaint(env, { email, pubId, original: r.original, detail: `fbl:${r.feedbackType}` }, source);
    done.push(email);
  }
  return done;
}

/** POST /hooks/fbl — raw ARF report (or a forwarded copy of the complained-about message). Trusted (keyed). */
export async function processFblHook(env: Env, text: string): Promise<{ processed: number }> {
  const r = parseReport(text);
  if (r.type === 'arf') return { processed: (await applyArf(env, r, 'hook', false)).length };
  // Not a MIME ARF: legacy header scrape (Original-Rcpt-To / Removal-Recipient / To + campaign headers)
  // Prefer explicit recipient fields. Otherwise use To: from the embedded original message (or the last To:),
  // never the report's own To:, which is our FBL/abuse mailbox, and never one of our own addresses.
  const pick = (src: string, re: RegExp) => [...new Set([...src.matchAll(re)].map((m) => m[1].toLowerCase()))];
  let emails = pick(text, /(?:Original-Rcpt-To|Removal-Recipient):\s*(?:rfc822;)?\s*<?([^\s>;]+@[^\s>;]+)/gi);
  if (!emails.length) {
    const at = text.search(/Content-Type:\s*(?:message\/rfc822|text\/rfc822-headers)/i);
    const tos = pick(at >= 0 ? text.slice(at) : text, /^To:\s*(?:[^<\r\n]*<)?([^\s>]+@[^\s>]+)/gim);
    emails = tos.length ? [tos[tos.length - 1]] : [];
  }
  const own = [env.MAIL_FROM, env.FBL_ADDRESS, env.BOUNCE_ADDRESS].filter(Boolean).map((a) => String(a).toLowerCase());
  const ownDomain = (env.MAIL_FROM || '').split('@')[1]?.toLowerCase();
  emails = emails.filter((e) => !own.includes(e) && !(ownDomain && /^(abuse|fbl|bounces?|postmaster)@/.test(e) && e.endsWith('@' + ownDomain)));
  const original: OriginalRef = {
    feedbackId: text.match(/X-OpenHive-Feedback-ID:\s*([^\r\n]+)/i)?.[1] || text.match(/^Feedback-ID:\s*([^\r\n]+)/im)?.[1],
    campaign: text.match(/X-OpenHive-Campaign:\s*(\S+)/i)?.[1],
  };
  for (const e of emails) await applyComplaint(env, { email: e, original, detail: 'fbl' }, 'hook');
  return { processed: emails.length };
}

/** mailto: unsubscribe — unsubscribe the sender from every publication that mails them from this address. */
async function applyMailtoUnsubscribe(env: Env, from: string, rcpt: string): Promise<number> {
  const subs = await all<any>(env, `SELECT id, pub_id FROM subscribers WHERE email = ? AND status IN ('active','pending')`, from);
  let n = 0;
  for (const s of subs) {
    const pub = await getPub(env, s.pub_id);
    if (!pub) continue;
    const senders = new Set<string>([(await senderFor(env, pub, 'newsletter')).email.toLowerCase(), (await senderFor(env, pub, 'automations')).email.toLowerCase()]);
    for (const r of await all<any>(env, 'SELECT email FROM sender_addresses WHERE pub_id = ?', pub.id)) senders.add(String(r.email).toLowerCase());
    if (!senders.has(rcpt)) continue;
    await unsubscribe(env, pub.id, s.id, 'mailto');
    await logInbound(env, { source: 'email', kind: 'unsubscribe', email: from, pubId: pub.id, mailKind: 'marketing', detail: `List-Unsubscribe mailto to ${rcpt}` });
    n++;
  }
  return n;
}

/** Minimal shape of Cloudflare's ForwardableEmailMessage that we use (keeps this testable). */
export interface InboundMessage {
  from: string;
  to: string;
  raw: ReadableStream<Uint8Array> | string;
  rawSize?: number;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<unknown>;
}

const MAX_INBOUND = 4 * 1024 * 1024;
const MAX_DMARC = 20 * 1024 * 1024; // big senders' reports (base64 zip) can be several MB

/** Worker email() handler body: Email Routing delivers bounces@ / fbl@ / sender-address mail here. */
export async function handleInboundEmail(env: Env, message: InboundMessage): Promise<{ type: string; processed: number }> {
  const rcpt = (message.to || '').toLowerCase();
  const raw = typeof message.raw === 'string' ? message.raw : await new Response(message.raw).text();
  // DMARC aggregate reports to dmarc@ / dmarc+<domain id>@ (lib/dmarc): stored, never forwarded or bounced.
  const dm = dmarcRecipient(rcpt);
  if (dm) {
    const res = await handleDmarcEmail(env, parseMime(raw.length > MAX_DMARC ? raw.slice(0, MAX_DMARC) : raw), rcpt, dm.domainId);
    await logInbound(env, { source: 'email', kind: res.processed ? 'dmarc' : 'ignored', email: message.from, detail: `DMARC report to ${rcpt}: ${res.results.join('; ') || 'no aggregate report found'}` });
    return { type: 'dmarc', processed: res.processed };
  }
  // Seed-test replies (seed+<token>@): "inbox" / "promotions" / "spam" as the first word records placement (lib/guardian).
  if (/^seed\+[a-z0-9]+@/i.test(rcpt)) {
    const word = /\b(inbox|primary|promotions?|spam|junk)\b/i.exec(`${parseHeaders(splitHead(raw)[0])['subject'] || ''}`)?.[1] || /^\s*(inbox|primary|promotions?|spam|junk)\b/im.exec(splitHead(raw)[1])?.[1];
    const ok = word ? await (await import('./guardian')).markSeed(env, rcpt.slice(5, rcpt.indexOf('@')), word) : false;
    await logInbound(env, { source: 'email', kind: ok ? 'seed' : 'ignored', email: message.from, detail: `seed placement reply to ${rcpt}: ${word || 'no placement word'}` });
    return { type: 'seed', processed: ok ? 1 : 0 };
  }
  const r = parseReport(raw.length > MAX_INBOUND ? raw.slice(0, MAX_INBOUND) : raw, message.from || '');
  // Reader replies to reply+<slug>.<delivery>@SHARED_FROM_DOMAIN land in the publication's Inbox (lib/inbox).
  if ((r.type === 'other' || r.type === 'unsubscribe') && rcpt.startsWith('reply+')) return (await import('./inbox')).handleInboundReply(env, message, raw.length > MAX_INBOUND ? raw.slice(0, MAX_INBOUND) : raw, rcpt);
  switch (r.type) {
    case 'dsn': {
      let n = 0;
      for (const rc of r.recipients) {
        if (rc.action !== 'failed') { if (rc.action === 'delayed') await logInbound(env, { source: 'email', kind: 'delayed', email: rc.email, detail: `${rc.status} ${rc.diagnostic}` }); continue; }
        // A DSN is unauthenticated mail: only act on addresses we actually sent to.
        if (!(await sentRecently(env, rc.email))) { await logInbound(env, { source: 'email', kind: 'ignored', email: rc.email, detail: 'DSN for an address we have not mailed' }); continue; }
        await applyBounce(env, { email: rc.email, status: rc.status, diagnostic: rc.diagnostic, original: r.original }, 'email');
        n++;
      }
      return { type: 'dsn', processed: n };
    }
    case 'arf':
      return { type: 'arf', processed: (await applyArf(env, r, 'email', true)).length };
    case 'unsubscribe':
      return { type: 'unsubscribe', processed: r.from ? await applyMailtoUnsubscribe(env, r.from, rcpt) : 0 };
    case 'auto':
      await logInbound(env, { source: 'email', kind: 'ignored', email: message.from, detail: `auto-reply to ${rcpt} (${r.reason})` });
      return { type: 'auto', processed: 0 };
    default: {
      // Human mail (replies to the sender address). Forward when configured, otherwise reject so the sender knows.
      if (env.INBOUND_FORWARD_TO) {
        await message.forward(env.INBOUND_FORWARD_TO, new Headers({ 'X-OpenHive-Original-Rcpt': rcpt }));
        await logInbound(env, { source: 'email', kind: 'forwarded', email: message.from, detail: `${rcpt} → ${env.INBOUND_FORWARD_TO}` });
      } else {
        message.setReject('This address only processes delivery reports. Reply to the newsletter author directly.');
        await logInbound(env, { source: 'email', kind: 'rejected', email: message.from, detail: `to ${rcpt}: not a report and INBOUND_FORWARD_TO is not set` });
      }
      return { type: 'other', processed: 0 };
    }
  }
}

/** Cloudflare Email Sending event (delivered via an event subscription → Queue → queue() handler). */
export interface SendingEvent {
  type: string;
  payload: {
    eventId?: string; messageId?: string; sender?: string; recipient?: string;
    delivery?: { status?: string; smtpEnhancedStatusCode?: string; smtpResponse?: string };
    bounce?: { type?: 'hard' | 'soft'; classification?: string; reason?: string };
    rejection?: { reason?: string; detail?: string };
    complaint?: { type?: string };
  };
}

export async function handleSendingEvent(env: Env, e: SendingEvent): Promise<string> {
  const p = e?.payload || {};
  const email = (p.recipient || '').toLowerCase();
  if (!email) return 'ignored';
  const original = { messageId: p.messageId };
  switch (e.type) {
    case 'cf.email.sending.message.bounced': {
      const status = p.delivery?.smtpEnhancedStatusCode || '';
      const diag = p.bounce?.reason || p.delivery?.smtpResponse || '';
      // soft bounces whose retries ran out still count as soft (repeated ones escalate to a temporary suppression)
      const c = classifyBounce(`${status} ${diag}`).type;
      const type: BounceType = p.bounce?.type === 'soft' ? (c === 'mailbox_full' || c === 'dns' ? c : 'soft') : classify(status || '5.0.0', diag);
      await applyBounce(env, { email, type, status, diagnostic: diag, original }, 'queue');
      return 'bounce';
    }
    case 'cf.email.sending.message.complained':
      await applyComplaint(env, { email, original, detail: `cf:${p.complaint?.type || 'abuse'}` }, 'queue');
      return 'complaint';
    case 'cf.email.sending.message.rejected':
      if (p.rejection?.reason === 'suppressed') {
        // Cloudflare's own suppression list blocks every send to this address — mirror it so we stop trying.
        const { suppress } = await import('./email');
        await suppress(env, email, 'global', 'cf_suppressed');
        await logInbound(env, { source: 'queue', kind: 'bounce', email, bounceType: 'hard', detail: `rejected: ${p.rejection?.detail || 'suppressed'}` });
        return 'suppressed';
      }
      await logInbound(env, { source: 'queue', kind: 'ignored', email, detail: `rejected: ${p.rejection?.reason || ''} ${p.rejection?.detail || ''}` });
      return 'ignored';
    case 'cf.email.sending.message.deferred':
      await logInbound(env, { source: 'queue', kind: 'delayed', email, detail: p.delivery?.smtpResponse || '' });
      return 'delayed';
    default:
      return 'ignored';
  }
}
