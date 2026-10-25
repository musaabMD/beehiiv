// Shared signup pipeline for /subscribe (site) and /f/:id (embedded forms):
// rate limits → bot scoring (honeypot, timing, UA, Turnstile) → strict validation → attribution → subscribe().
import type { Env, Publication, Subscriber } from '../types';
import { one, run } from './db';
import { botScore, clientIP, rateLimit, verifyTurnstile } from './guard';
import { subscribe } from './subscribers';
import { formConfig, type FormConfig } from './forms';
import { hmac, parseJSON, str } from './util';

export type SignupResult =
  | { kind: 'ok'; subscriber: Subscriber | null; pending: boolean; created: boolean; fake?: boolean; form?: FormConfig | null; formId?: string | null }
  | { kind: 'error'; message: string; suggestion?: string | null; status: 400 | 429 }
  | { kind: 'confirm_human'; token: string; email: string };

async function humanToken(env: Env, email: string, ts: number) {
  return `${ts}.${(await hmac(env.APP_URL + ':human', `${email}:${ts}`)).slice(0, 24)}`;
}
async function humanTokenOk(env: Env, email: string, tok: string | undefined) {
  if (!tok) return false;
  const [ts] = tok.split('.');
  if (!ts || Date.now() - Number(ts) > 15 * 60_000) return false;
  return tok === (await humanToken(env, email, Number(ts)));
}

export async function processSignup(env: Env, req: Request, pub: Publication, f: Record<string, any>, opts: { formId?: string | null } = {}): Promise<SignupResult> {
  const ip = clientIP(req);
  const email = str(f.email, 254).toLowerCase();
  if (!(await rateLimit(env, `signup:ip:${pub.id}:${ip}`, 10, 600))) return { kind: 'error', message: 'Too many signup attempts. Please try again in a few minutes.', status: 429 };
  if (!(await rateLimit(env, `signup:ipglobal:${ip}`, 40, 3600))) return { kind: 'error', message: 'Too many signup attempts. Please try again later.', status: 429 };

  const humanOk = await humanTokenOk(env, email, f._human);
  if (!humanOk) {
    const ts = await verifyTurnstile(env, f['cf-turnstile-response'], ip);
    const score = botScore({ honeypot: f.website, renderedAt: f._t, ua: req.headers.get('user-agent'), turnstileOk: ts });
    if (score >= 60) return { kind: 'ok', subscriber: null, pending: false, created: false, fake: true }; // silent drop
    if (score >= 30) return { kind: 'confirm_human', token: await humanToken(env, email, Date.now()), email };
  }
  if (email && !(await rateLimit(env, `signup:email:${pub.id}:${email}`, 5, 3600))) return { kind: 'error', message: 'Too many attempts for this email address. Please try again later.', status: 429 };

  // attribution
  const attr = parseJSON<Record<string, string>>(typeof f.utm === 'string' ? f.utm : '', {});
  const formId = opts.formId || str(f.form_id, 40) || null;
  let form: FormConfig | null = null;
  let source = str(f.source, 30) || 'website';
  let sourceDetail: string | null = null;
  if (formId) {
    const row = await one<{ id: string; live: string | null; draft: string }>(env, 'SELECT id, live, draft FROM forms WHERE id = ? AND pub_id = ?', formId, pub.id);
    if (row) { form = formConfig(row.live || row.draft); source = source === 'website' || !source ? 'form' : source; sourceDetail = row.id; }
  }
  if (attr.ref_pub && attr.ref_pub !== pub.id) {
    const rp = await one<{ id: string }>(env, 'SELECT id FROM publications WHERE id = ?', attr.ref_pub);
    if (rp) { source = 'recommendation'; sourceDetail = rp.id; }
  }
  const refCode = str(f.ref || attr.ref, 40) || null;
  if (refCode && source === 'website') source = 'referral';
  const allowed = new Set(['website', 'form', 'popup', 'magic_link', 'referral', 'recommendation', 'boost', 'linkinbio', 'event', 'product']);
  if (!allowed.has(source)) source = 'website';
  if (source === 'popup') { sourceDetail = sourceDetail || 'popup'; source = 'form'; }

  const custom: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) {
    const m = k.match(/^custom\[([a-zA-Z0-9_]+)\]$/);
    if (m && typeof v === 'string' && v.trim()) custom[m[1]] = v.trim().slice(0, 500);
  }
  const lists: string[] = Array.isArray(f.lists) ? f.lists.map(String) : [];
  const res = await subscribe(env, pub, {
    email, name: str(f.name, 120), source, sourceDetail,
    utm: { source: attr.utm_source || str(f.utm_source, 120) || undefined, medium: attr.utm_medium || str(f.utm_medium, 120) || undefined, campaign: attr.utm_campaign || str(f.utm_campaign, 120) || undefined, term: attr.utm_term, content: attr.utm_content },
    referrer: attr.referrer || req.headers.get('referer'), landingPath: attr.landing || null,
    referralCode: refCode, tags: form?.tags || [], custom: Object.keys(custom).length ? custom : undefined,
    listIds: lists.length ? lists : undefined, country: (req as any).cf?.country ?? null, ip, strict: true, reactivate: true,
  });
  if (!res.ok) return { kind: 'error', message: res.error || 'Could not subscribe.', suggestion: res.suggestion, status: 400 };
  if (formId && form) await run(env, 'UPDATE forms SET submissions = submissions + 1 WHERE id = ?', formId);
  return { kind: 'ok', subscriber: res.subscriber || null, pending: !!res.pending, created: !!res.created, form, formId };
}
