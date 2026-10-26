// Incoming webhook entry point for automations ("Integrations: Calendly, Typeform, Thinkific, Kajabi… or anything").
// Each automation can have a secret URL /hooks/automations/<token>. A POST with JSON (or a form body) carrying an email
// creates/updates the subscriber (optional tags + custom field mapping) and enrolls them.
import type { Env, Publication } from '../types';
import { one, run } from './db';
import { getPub } from './pub';
import { subscribe, setFields, validTimezone as validTz } from './subscribers';
import { enroll, triggerList } from './automations';
import { subscriberMatches } from './segments';
import { token as randomToken, parseJSON } from './util';

export const DEFAULT_EMAIL_PATHS = ['email', 'payload.email', 'data.email', 'email_address', 'contact.email', 'customer.email', 'user.email', 'payload.member_email', 'member.email'];
const DEFAULT_NAME_PATHS = ['name', 'full_name', 'payload.name', 'data.name', 'first_name', 'payload.first_name', 'data.first_name', 'contact.name', 'customer.name', 'user.name', 'member.name'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Read `a.b[0].c` style paths. */
export function getPath(obj: any, path: string): unknown {
  let cur = obj;
  for (const part of String(path).trim().split('.').filter(Boolean)) {
    const m = part.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (!m) return undefined;
    if (m[1]) cur = cur?.[m[1]];
    for (const idx of m[2].match(/\d+/g) || []) cur = cur?.[Number(idx)];
    if (cur === undefined || cur === null) return undefined;
  }
  return cur;
}

/** First string that looks like an email anywhere in the payload (Typeform answers, nested CRM payloads…). */
function findEmail(obj: any, depth = 0): string | null {
  if (depth > 6 || obj === null || obj === undefined) return null;
  if (typeof obj === 'string') return EMAIL_RE.test(obj.trim()) ? obj.trim() : null;
  if (typeof obj !== 'object') return null;
  // prefer keys literally named like email
  if (!Array.isArray(obj)) for (const [k, v] of Object.entries(obj)) if (/e-?mail/i.test(k) && typeof v === 'string' && EMAIL_RE.test(v.trim())) return v.trim();
  for (const v of Array.isArray(obj) ? obj : Object.values(obj)) { const f = findEmail(v, depth + 1); if (f) return f; }
  return null;
}

export function extractEmail(body: any, cfg: any): string | null {
  const custom = String(cfg?.email_path || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of [...custom, ...DEFAULT_EMAIL_PATHS]) {
    const v = getPath(body, p);
    if (typeof v === 'string' && EMAIL_RE.test(v.trim())) return v.trim().toLowerCase();
  }
  return findEmail(body)?.toLowerCase() || null;
}

function extractName(body: any, cfg: any): string {
  const custom = String(cfg?.name_path || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of [...custom, ...DEFAULT_NAME_PATHS]) {
    const v = getPath(body, p);
    if (typeof v === 'string' && v.trim() && !EMAIL_RE.test(v.trim())) return v.trim().slice(0, 120);
  }
  return '';
}

/** "custom_key = json.path" lines → {custom_key: value}. */
export function mapFields(body: any, fieldMap: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = Array.isArray(fieldMap) ? fieldMap.map(String) : String(fieldMap || '').split(/\n|;/);
  for (const line of lines.slice(0, 30)) {
    const [k, p] = line.split('=').map((s) => s?.trim());
    const key = (k || '').replace(/[^a-zA-Z0-9_]/g, '');
    if (!key || !p) continue;
    const v = getPath(body, p);
    if (v !== undefined && v !== null && typeof v !== 'object') out[key] = typeof v === 'string' ? v.slice(0, 500) : v;
  }
  return out;
}

export async function ensureWebhookToken(env: Env, automationId: string): Promise<string> {
  const row = await one<{ webhook_token: string | null }>(env, 'SELECT webhook_token FROM automations WHERE id = ?', automationId);
  if (row?.webhook_token) return row.webhook_token;
  const t = 'awh_' + randomToken(24);
  await run(env, 'UPDATE automations SET webhook_token = COALESCE(webhook_token, ?) WHERE id = ?', t, automationId);
  return (await one<{ webhook_token: string }>(env, 'SELECT webhook_token FROM automations WHERE id = ?', automationId))!.webhook_token;
}

export async function rotateWebhookToken(env: Env, automationId: string): Promise<string> {
  const t = 'awh_' + randomToken(24);
  await run(env, 'UPDATE automations SET webhook_token = ? WHERE id = ?', t, automationId);
  return t;
}

export interface InboundResult { status: number; body: Record<string, unknown> }

/** Handle one inbound POST. `body` is the parsed JSON / form object. */
export async function handleInbound(env: Env, tok: string, body: any, meta: { timezone?: string | null; country?: string | null; ip?: string | null }): Promise<InboundResult> {
  if (!/^awh_[A-Za-z0-9_-]{10,80}$/.test(tok)) return { status: 404, body: { ok: false, error: 'not_found' } };
  const a = await one<any>(env, 'SELECT id, pub_id, name, status, trigger FROM automations WHERE webhook_token = ?', tok);
  if (!a) return { status: 404, body: { ok: false, error: 'not_found' } };
  const entry = triggerList(parseJSON<any>(a.trigger, {})).find((t) => t.type === 'webhook');
  if (!entry) return { status: 409, body: { ok: false, error: 'webhook_not_enabled', message: 'This automation has no published “Incoming webhook” entry point.' } };
  if (a.status !== 'active') return { status: 409, body: { ok: false, error: 'automation_not_active', message: `Automation is ${a.status}. Activate it to accept webhooks.` } };
  if (!body || typeof body !== 'object') return { status: 400, body: { ok: false, error: 'invalid_body', message: 'Send JSON (or a form body) with an email field.' } };
  const cfg = entry.config || {};
  const email = extractEmail(body, cfg);
  if (!email) return { status: 422, body: { ok: false, error: 'email_missing', message: `No email found. Looked at: ${[cfg.email_path, ...DEFAULT_EMAIL_PATHS].filter(Boolean).join(', ')} and every nested value.` } };
  const pub = (await getPub(env, a.pub_id)) as Publication | null;
  if (!pub) return { status: 404, body: { ok: false, error: 'not_found' } };
  const tags = (Array.isArray(cfg.tags) ? cfg.tags : String(cfg.tags || '').split(',')).map((t: string) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 20);
  const custom = mapFields(body, cfg.field_map);
  const tz = typeof body.timezone === 'string' ? body.timezone : typeof getPath(body, 'payload.timezone') === 'string' ? (getPath(body, 'payload.timezone') as string) : meta.timezone;
  const res = await subscribe(env, pub, {
    email, name: extractName(body, cfg), source: 'api', sourceDetail: `webhook:${a.id}`, tags, custom: Object.keys(custom).length ? custom : undefined,
    skipConfirm: !cfg.double_opt_in, country: meta.country ?? null, ip: meta.ip ?? null, timezone: validTz(tz) ? tz : null,
  });
  if (!res.ok || !res.subscriber) return { status: 422, body: { ok: false, error: 'invalid_email', message: res.error || 'Could not add subscriber', suggestion: res.suggestion ?? null } };
  const sub = res.subscriber;
  if (Object.keys(custom).length && !res.created) await setFields(env, pub.id, sub.id, custom);
  if (entry.filter?.rules?.length && !(await subscriberMatches(env, pub.id, entry.filter, sub.id))) {
    return { status: 202, body: { ok: true, subscriber_id: sub.id, created: !!res.created, enrolled: false, reason: 'did not match the entry filter' } };
  }
  const summary = JSON.stringify(body).slice(0, 2000);
  const r = await enroll(env, a.id, sub.id, { trigger: 'webhook', payload: parseJSON(summary, summary) });
  return { status: 202, body: { ok: true, subscriber_id: sub.id, created: !!res.created, pending_confirmation: !!res.pending, enrolled: r.ok, run_id: r.runId ?? null, reason: r.ok ? null : r.reason } };
}
