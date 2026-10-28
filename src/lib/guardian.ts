// Autonomous Deliverability Guardian. Every 10 minutes it reads the live signals — bounce, complaint and deferral rates
// per mailbox provider and per workspace, sudden volume spikes, blocklist status (lib/domains), DMARC alignment failures
// (lib/dmarc) — and takes SAFE actions inside fixed limits:
//   - writes send_throttles rows (read by the sending engine): slow a provider or a workspace, or pause a workspace on a
//     severe signal — always with an expiry (max GUARDIAN.MAX_THROTTLE_MS), never below factor 0, never over a row an
//     operator wrote by hand (reason not starting with 'guardian:'), never the 'global' scope (operators only);
//   - opens incidents with a plain-English diagnosis and the recommended fix, and notifies owners / superadmins;
//   - recovers by itself: when the signal clears (or no fresh evidence for RESOLVE_STALE_MS) the incident resolves and
//     its throttle row is removed.
// It never evades filters, rotates IPs/domains, or changes content. Inbox placement seed tests live here too.
import type { Env, Publication } from '../types';
import { all, one, run, insert } from './db';
import { registerPeriodic, logError } from './jobs';
import { sendTransactional, sendMail } from './email';
import { superadminEmails } from './plans';
import { appUrl, getPub, senderFor, siteUrl } from './pub';
import { domainPassRates, pubSendingDomains, sharedDomain, pruneDmarc } from './dmarc';
import { deliveryMetrics, PROVIDER_NAME, PROVIDERS } from './deliverymetrics';
import { id, now, esc, MIN, HOUR, DAY, mailboxProvider, num } from './util';

export const GUARDIAN = {
  EVERY_MS: 10 * MIN,
  WINDOW_MS: 2 * HOUR,               // bounce / deferral window
  COMPLAINT_WINDOW_MS: DAY,          // complaints arrive late; look further back
  MAX_THROTTLE_MS: 2 * HOUR,
  RESOLVE_STALE_MS: 2 * HOUR,        // no fresh evidence for this long → resolve
  PROVIDER_MIN: 200,                 // attempts in the window before a provider signal counts
  WORKSPACE_MIN: 100,
  COMPLAINT_MIN_ACCEPTED: 500,
  PROVIDER_DEFERRAL: [0.10, 0.25],   // warning (half speed), critical (quarter speed)
  PROVIDER_BOUNCE: [0.05, 0.12],
  PROVIDER_COMPLAINT: [0.003, 0.006],
  WS_BOUNCE: [0.04, 0.08],           // warning (half speed 2h), critical (pause 1h)
  WS_COMPLAINT: [0.002, 0.005],
  WS_DEFERRAL: [0.20, 0.40],
  SPIKE_MIN: 2000,                   // last hour attempts, and ≥ SPIKE_FACTOR × the previous 30-day busiest hour
  SPIKE_FACTOR: 3,
  DMARC_MIN: 50,                     // messages in reports over the last 3 days
  DMARC_PASS: [0.9, 0.7],
};

export type Severity = 'info' | 'warning' | 'critical';
interface Finding {
  scope: string; kind: string; severity: Severity; workspaceId?: string | null; metric: number;
  title: string; diagnosis: string; recommendation: string;
  throttle?: { scope: string; factor: number; ms: number; label: string };
}

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const hours = (ms: number) => (ms >= HOUR ? `${Math.round(ms / HOUR)} hour${ms >= 2 * HOUR ? 's' : ''}` : `${Math.round(ms / MIN)} minutes`);
const speed = (f: number) => (f <= 0 ? 'paused' : f <= 0.25 ? 'quarter speed' : f <= 0.5 ? 'half speed' : `${Math.round(f * 100)}% speed`);
const shortName = (p: string) => ({ gmail: 'Gmail', outlook: 'Microsoft', yahoo: 'Yahoo', apple: 'Apple', other: 'smaller providers' } as Record<string, string>)[p] || p;

// ───────── throttles ─────────
export interface Throttle { scope: string; factor: number; reason: string | null; until: number | null; created_at: number | null }

export async function activeThrottles(env: Env, scopes?: string[]): Promise<Throttle[]> {
  const rows = await all<Throttle>(env, `SELECT * FROM send_throttles WHERE until IS NULL OR until > ? ORDER BY scope`, now()).catch(() => []);
  return scopes ? rows.filter((r) => scopes.includes(r.scope)) : rows;
}

/** Write (or tighten / extend) a Guardian throttle. Never overrides an operator's row, never touches 'global'. */
export async function applyThrottle(env: Env, scope: string, factor: number, ms: number, reason: string): Promise<'applied' | 'kept_manual' | 'refused'> {
  if (scope === 'global' || !/^(provider:(gmail|outlook|yahoo|apple|other)|workspace:[A-Za-z0-9_-]+)$/.test(scope)) return 'refused';
  factor = Math.min(1, Math.max(0, factor));
  ms = Math.min(GUARDIAN.MAX_THROTTLE_MS, Math.max(10 * MIN, ms));
  const cur = await one<Throttle>(env, 'SELECT * FROM send_throttles WHERE scope = ?', scope);
  const live = cur && (cur.until == null || cur.until > now());
  if (live && !(cur!.reason || '').startsWith('guardian:')) return 'kept_manual';
  const f = live ? Math.min(Number(cur!.factor), factor) : factor;
  await run(env, `INSERT INTO send_throttles (scope, factor, reason, until, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET factor = excluded.factor, reason = excluded.reason, until = excluded.until`, scope, f, `guardian: ${reason}`.slice(0, 300), now() + ms, now());
  return 'applied';
}

/** Remove a Guardian-written throttle (manual rows stay). */
export async function liftThrottle(env: Env, scope: string) {
  await run(env, `DELETE FROM send_throttles WHERE scope = ? AND reason LIKE 'guardian:%'`, scope);
}

/** Operator (superadmin) throttle — may use 'global'. */
export async function setManualThrottle(env: Env, scope: string, factor: number, ms: number | null, reason: string, actor: string) {
  if (!/^(global|provider:(gmail|outlook|yahoo|apple|other)|workspace:[A-Za-z0-9_-]+)$/.test(scope)) throw new Error('Unknown scope');
  await run(env, `INSERT INTO send_throttles (scope, factor, reason, until, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET factor = excluded.factor, reason = excluded.reason, until = excluded.until, created_at = excluded.created_at`,
    scope, Math.min(1, Math.max(0, factor)), `operator ${actor}: ${reason}`.slice(0, 300), ms ? now() + ms : null, now());
}
export async function clearThrottle(env: Env, scope: string) {
  await run(env, 'DELETE FROM send_throttles WHERE scope = ?', scope);
}

// ───────── signals ─────────
const COUNTS = `COUNT(*) AS n,
  SUM(CASE WHEN d.status IN ('sent','complained') THEN 1 ELSE 0 END) AS acc,
  SUM(CASE WHEN d.status = 'bounced' AND d.bounce_type = 'hard' THEN 1 ELSE 0 END) AS hard,
  SUM(CASE WHEN d.status = 'bounced' AND d.bounce_type IN ('hard','policy') THEN 1 ELSE 0 END) AS blocked,
  SUM(CASE WHEN d.status = 'complained' THEN 1 ELSE 0 END) AS compl,
  SUM(CASE WHEN d.status = 'deferred' OR d.attempts > 1 THEN 1 ELSE 0 END) AS def`;
const BASE = `d.status NOT IN ('queued','scheduled','suppressed') AND d.send_id NOT IN (SELECT id FROM sends WHERE kind = 'test')`;
const PROV = `CASE WHEN d.provider IN ('gmail','outlook','yahoo','apple') THEN d.provider ELSE 'other' END`;

async function providerFindings(env: Env, t: number): Promise<{ findings: Finding[]; healthy: Set<string> }> {
  const findings: Finding[] = [], healthy = new Set<string>();
  const rows = await all<any>(env, `SELECT ${PROV} AS p, ${COUNTS} FROM deliveries d WHERE ${BASE} AND d.created_at >= ? GROUP BY 1`, t - GUARDIAN.WINDOW_MS);
  const cRows = await all<any>(env, `SELECT ${PROV} AS p, ${COUNTS} FROM deliveries d WHERE ${BASE} AND d.created_at >= ? GROUP BY 1`, t - GUARDIAN.COMPLAINT_WINDOW_MS);
  for (const p of PROVIDERS) {
    const r = rows.find((x) => x.p === p) || {};
    const n = Number(r.n || 0), def = Number(r.def || 0), blocked = Number(r.blocked || 0);
    const name = shortName(p);
    const scope = `provider:${p}`;
    if (n >= GUARDIAN.PROVIDER_MIN) {
      const dr = def / n, br = blocked / n;
      if (dr >= GUARDIAN.PROVIDER_DEFERRAL[0]) {
        const crit = dr >= GUARDIAN.PROVIDER_DEFERRAL[1];
        const factor = crit ? 0.25 : 0.5;
        findings.push({ scope, kind: 'deferrals', severity: crit ? 'critical' : 'warning', metric: dr,
          title: `${name} is deferring ${pct(dr, 0)} of mail`,
          diagnosis: `${name} temporarily refused ${num(def)} of ${num(n)} emails in the last ${hours(GUARDIAN.WINDOW_MS)} (deferrals are "try again later" answers, usually rate limiting or a reputation check). We slowed ${name} sends to ${speed(factor)} for ${hours(GUARDIAN.MAX_THROTTLE_MS)}; deferred mail keeps retrying for 26 hours.`,
          recommendation: `No action needed while it recovers. If it keeps happening, send to your most engaged ${name} readers first and remove addresses that haven't opened in 90 days.`,
          throttle: { scope, factor, ms: GUARDIAN.MAX_THROTTLE_MS, label: `${name} deferring ${pct(dr, 0)}` } });
      }
      if (br >= GUARDIAN.PROVIDER_BOUNCE[0]) {
        const crit = br >= GUARDIAN.PROVIDER_BOUNCE[1];
        findings.push({ scope, kind: 'bounces', severity: crit ? 'critical' : 'warning', metric: br,
          title: `${name} is rejecting ${pct(br, 1)} of mail`,
          diagnosis: `${num(blocked)} of ${num(n)} emails to ${name} in the last ${hours(GUARDIAN.WINDOW_MS)} were refused permanently (unknown addresses or policy blocks). We slowed ${name} sends to ${speed(0.5)} for ${hours(GUARDIAN.MAX_THROTTLE_MS)} so the rejections don't damage reputation further.`,
          recommendation: `Check the bounce reasons in Settings → Email → Inbound reports. Policy blocks ("5.7.x") mean ${name} distrusts the sending domain: confirm SPF, DKIM and DMARC pass and look for a recently imported list.`,
          throttle: { scope, factor: 0.5, ms: GUARDIAN.MAX_THROTTLE_MS, label: `${name} rejecting ${pct(br, 1)}` } });
      }
      if (dr < GUARDIAN.PROVIDER_DEFERRAL[0] / 2 && br < GUARDIAN.PROVIDER_BOUNCE[0] / 2) { healthy.add(`${scope}|deferrals`); healthy.add(`${scope}|bounces`); }
      else { if (dr < GUARDIAN.PROVIDER_DEFERRAL[0] / 2) healthy.add(`${scope}|deferrals`); if (br < GUARDIAN.PROVIDER_BOUNCE[0] / 2) healthy.add(`${scope}|bounces`); }
    }
    const c = cRows.find((x) => x.p === p) || {};
    const acc = Number(c.acc || 0), compl = Number(c.compl || 0);
    if (acc >= GUARDIAN.COMPLAINT_MIN_ACCEPTED) {
      const cr = compl / acc;
      if (cr >= GUARDIAN.PROVIDER_COMPLAINT[0]) {
        findings.push({ scope, kind: 'complaints', severity: cr >= GUARDIAN.PROVIDER_COMPLAINT[1] ? 'critical' : 'warning', metric: cr,
          title: `${name} readers are marking ${pct(cr, 2)} as spam`,
          diagnosis: `${num(compl)} spam complaints from ${name} out of ${num(acc)} delivered in the last 24 hours — above the 0.3% line mailbox providers enforce. We slowed ${name} sends to half speed for ${hours(GUARDIAN.MAX_THROTTLE_MS)}.`,
          recommendation: 'Find the workspace with the most complaints in Platform admin → Guardian; complaints come almost always from unexpected mail (old or bought lists, no double opt-in).',
          throttle: { scope, factor: 0.5, ms: GUARDIAN.MAX_THROTTLE_MS, label: `${name} complaints ${pct(cr, 2)}` } });
      } else if (cr < GUARDIAN.PROVIDER_COMPLAINT[0] / 2) healthy.add(`${scope}|complaints`);
    }
  }
  return { findings, healthy };
}

async function workspaceFindings(env: Env, t: number): Promise<{ findings: Finding[]; healthy: Set<string> }> {
  const findings: Finding[] = [], healthy = new Set<string>();
  const rows = await all<any>(env, `SELECT p.workspace_id AS ws, ${COUNTS} FROM deliveries d JOIN publications p ON p.id = d.pub_id WHERE ${BASE} AND d.created_at >= ? GROUP BY p.workspace_id`, t - GUARDIAN.WINDOW_MS);
  const cRows = await all<any>(env, `SELECT p.workspace_id AS ws, ${COUNTS} FROM deliveries d JOIN publications p ON p.id = d.pub_id WHERE ${BASE} AND d.created_at >= ? GROUP BY p.workspace_id`, t - GUARDIAN.COMPLAINT_WINDOW_MS);
  const names = new Map((await all<any>(env, `SELECT id, name FROM workspaces WHERE id IN (${[...new Set([...rows, ...cRows].map((r) => r.ws))].map(() => '?').join(',') || "''"})`, ...new Set([...rows, ...cRows].map((r) => r.ws)))).map((w) => [w.id, w.name]));
  for (const r of rows) {
    const ws = r.ws, scope = `workspace:${ws}`, n = Number(r.n || 0);
    if (n < GUARDIAN.WORKSPACE_MIN) continue;
    const who = names.get(ws) || 'this workspace';
    const hr = Number(r.hard || 0) / n, dr = Number(r.def || 0) / n;
    if (hr >= GUARDIAN.WS_BOUNCE[0]) {
      const crit = hr >= GUARDIAN.WS_BOUNCE[1];
      const factor = crit ? 0 : 0.5, ms = crit ? HOUR : 2 * HOUR;
      findings.push({ scope, kind: 'bounces', workspaceId: ws, severity: crit ? 'critical' : 'warning', metric: hr,
        title: `${pct(hr, 1)} of recent emails hard-bounced`,
        diagnosis: `${num(Number(r.hard))} of ${num(n)} emails sent by ${who} in the last ${hours(GUARDIAN.WINDOW_MS)} went to addresses that don't exist. Mailbox providers read that as a sign of an old or purchased list. ${crit ? `We paused sending for ${hours(ms)} to protect your reputation` : `We slowed your sending to ${speed(factor)} for ${hours(ms)}`}; it resumes by itself.`,
        recommendation: 'Bounced addresses are already suppressed. If you recently imported a list, remove readers who never opened or confirmed, and turn on double opt-in for new signups.',
        throttle: { scope, factor, ms, label: `hard bounces ${pct(hr, 1)}` } });
    } else if (hr < GUARDIAN.WS_BOUNCE[0] / 2) healthy.add(`${scope}|bounces`);
    if (dr >= GUARDIAN.WS_DEFERRAL[0]) {
      const crit = dr >= GUARDIAN.WS_DEFERRAL[1];
      findings.push({ scope, kind: 'deferrals', workspaceId: ws, severity: crit ? 'critical' : 'warning', metric: dr,
        title: `Mailbox providers are deferring ${pct(dr, 0)} of your mail`,
        diagnosis: `${num(Number(r.def))} of ${num(n)} recent emails got a "try again later" answer. When it's only your mail, providers are usually checking your content or list before accepting more. We slowed your sending to half speed for 2 hours; deferred mail keeps retrying for 26 hours.`,
        recommendation: 'Send to your most engaged readers first, keep links to reputable domains, and check that your sending domain passes SPF, DKIM and DMARC.',
        throttle: { scope, factor: 0.5, ms: 2 * HOUR, label: `deferrals ${pct(dr, 0)}` } });
    } else if (dr < GUARDIAN.WS_DEFERRAL[0] / 2) healthy.add(`${scope}|deferrals`);
  }
  for (const r of cRows) {
    const ws = r.ws, scope = `workspace:${ws}`, acc = Number(r.acc || 0);
    if (acc < GUARDIAN.COMPLAINT_MIN_ACCEPTED) continue;
    const cr = Number(r.compl || 0) / acc;
    if (cr >= GUARDIAN.WS_COMPLAINT[0]) {
      const crit = cr >= GUARDIAN.WS_COMPLAINT[1];
      const factor = crit ? 0 : 0.5;
      findings.push({ scope, kind: 'complaints', workspaceId: ws, severity: crit ? 'critical' : 'warning', metric: cr,
        title: `${pct(cr, 2)} of readers marked your email as spam`,
        diagnosis: `${num(Number(r.compl))} spam complaints out of ${num(acc)} delivered in the last 24 hours. Gmail and Yahoo start filtering senders above 0.3%. ${crit ? 'We paused sending for 2 hours' : 'We slowed your sending to half speed for 2 hours'}; it resumes by itself.`,
        recommendation: 'Make the unsubscribe link easy to find, remind readers why they signed up at the top of the email, and stop mailing people who haven\'t opened in months.',
        throttle: { scope, factor, ms: 2 * HOUR, label: `complaints ${pct(cr, 2)}` } });
    } else if (cr < GUARDIAN.WS_COMPLAINT[0] / 2) healthy.add(`${scope}|complaints`);
  }
  // sudden volume spikes: last hour vs the busiest hour of the previous 30 days
  const lastHour = await all<any>(env, `SELECT p.workspace_id AS ws, COUNT(*) AS n FROM deliveries d JOIN publications p ON p.id = d.pub_id WHERE ${BASE} AND d.created_at >= ? GROUP BY p.workspace_id HAVING n >= ?`, t - HOUR, GUARDIAN.SPIKE_MIN);
  for (const r of lastHour) {
    const peak = Number((await one<any>(env, `SELECT MAX(n) AS m FROM (SELECT CAST(d.created_at / ${HOUR} AS INTEGER) AS h, COUNT(*) AS n FROM deliveries d JOIN publications p ON p.id = d.pub_id WHERE p.workspace_id = ? AND ${BASE} AND d.created_at >= ? AND d.created_at < ? GROUP BY h)`, r.ws, t - 30 * DAY, t - HOUR))?.m || 0);
    const scope = `workspace:${r.ws}`;
    if (Number(r.n) >= GUARDIAN.SPIKE_FACTOR * Math.max(peak, GUARDIAN.SPIKE_MIN / GUARDIAN.SPIKE_FACTOR)) {
      findings.push({ scope, kind: 'volume_spike', workspaceId: r.ws, severity: 'info', metric: Number(r.n),
        title: `Sending volume jumped to ${num(Number(r.n))} emails in an hour`,
        diagnosis: `That's more than ${GUARDIAN.SPIKE_FACTOR}× your busiest hour in the last 30 days (${num(peak)}). Mailbox providers distrust sudden jumps from a sender, so we're pacing the rest at half speed for an hour.`,
        recommendation: 'Nothing to fix if this send was planned. For future large sends, grow volume gradually or schedule the send to go out over a few hours.',
        throttle: { scope, factor: 0.5, ms: HOUR, label: `volume spike ${num(Number(r.n))}/h` } });
    }
  }
  return { findings, healthy };
}

async function domainFindings(env: Env): Promise<{ findings: Finding[]; healthy: Set<string> }> {
  const findings: Finding[] = [], healthy = new Set<string>();
  const doms = await all<any>(env, `SELECT d.hostname, d.blocklisted, d.dns_report, p.workspace_id FROM domains d JOIN publications p ON p.id = d.pub_id WHERE d.kind = 'email'`);
  const plat = await all<any>(env, `SELECT hostname, blocklisted, dns_report FROM platform_domains`).catch(() => []);
  const listedOn = (r: string) => { try { return (JSON.parse(r || '{}').blocklists?.results || []).filter((x: any) => x.listed).map((x: any) => x.name).join(', '); } catch { return ''; } };
  for (const d of [...doms, ...plat.map((p) => ({ ...p, workspace_id: null }))]) {
    const scope = d.workspace_id ? `domain:${d.hostname}` : 'platform';
    if (d.blocklisted) {
      findings.push({ scope, kind: 'blocklist', workspaceId: d.workspace_id, severity: 'critical', metric: 1,
        title: `${d.hostname} is on a blocklist`,
        diagnosis: `${d.hostname} was found on ${listedOn(d.dns_report) || 'a DNS blocklist'}. Sending from it is paused automatically until it's delisted.`,
        recommendation: 'Request removal from the blocklist operator (each list has a lookup + delisting form), then use "Check blocklists" on the Domains page. Find out how it got listed first: usually a compromised signup form or an old list.' });
    } else healthy.add(`${scope}|blocklist`);
  }
  // DMARC alignment
  const rates = await domainPassRates(env, 3);
  const wsOf = new Map(doms.map((d) => [d.hostname, d.workspace_id]));
  const platHosts = new Set(plat.map((p: any) => p.hostname));
  for (const r of rates) {
    const ws = wsOf.get(r.domain) || null;
    if (!ws && !platHosts.has(r.domain)) continue;
    const scope = ws ? `domain:${r.domain}` : 'platform';
    if (r.messages < GUARDIAN.DMARC_MIN) continue;
    const pr = r.pass / r.messages;
    if (pr < GUARDIAN.DMARC_PASS[0]) {
      const top = await all<any>(env, `SELECT source_ip, reporter, SUM(count) AS n FROM dmarc_records WHERE domain = ? AND day >= ? AND dkim = 'fail' AND spf = 'fail' GROUP BY source_ip, reporter ORDER BY n DESC LIMIT 3`, r.domain, new Date(now() - 3 * DAY).toISOString().slice(0, 10));
      findings.push({ scope, kind: 'dmarc', workspaceId: ws, severity: pr < GUARDIAN.DMARC_PASS[1] ? 'critical' : 'warning', metric: pr,
        title: `Only ${pct(pr, 0)} of mail from ${r.domain} passes DMARC`,
        diagnosis: `Mailbox providers reported ${num(r.messages - r.pass)} of ${num(r.messages)} messages claiming to be from ${r.domain} in the last 3 days as failing both DKIM and SPF alignment${top.length ? ` — mostly from ${top.map((x) => `${x.source_ip} (${x.reporter}, ${num(Number(x.n))})`).join(', ')}` : ''}. That's either a service you use that isn't set up to sign for your domain, or someone spoofing it.`,
        recommendation: `If you recognise the sources (a CRM, helpdesk or another email tool), set up DKIM for ${r.domain} in that tool. If you don't, they're spoofing you: once your own mail passes, move your DMARC policy to p=quarantine.` });
    } else if (pr >= (GUARDIAN.DMARC_PASS[0] + 1) / 2) healthy.add(`${scope}|dmarc`);
  }
  return { findings, healthy };
}

// ───────── incidents ─────────
export interface Incident { id: string; scope: string; workspace_id: string | null; kind: string; severity: Severity; title: string; diagnosis: string; recommendation: string; action: string | null; throttle_scope: string | null; metric: number | null; acted_at: number | null; status: string; opened_at: number; updated_at: number; resolved_at: number | null }

const SEV_RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 };

async function recipientsFor(env: Env, inc: { scope: string; workspace_id?: string | null; severity: string }): Promise<string[]> {
  const out = new Set<string>();
  if (inc.workspace_id) {
    for (const u of await all<{ email: string }>(env, `SELECT DISTINCT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.role IN ('owner','admin')`, inc.workspace_id)) out.add(u.email);
  }
  if (!inc.workspace_id || inc.severity === 'critical') for (const a of superadminEmails(env)) out.add(a);
  return [...out];
}

async function notify(env: Env, inc: Pick<Incident, 'scope' | 'workspace_id' | 'severity' | 'title' | 'diagnosis' | 'recommendation'>, resolved: boolean) {
  const link = inc.workspace_id ? appUrl(env, '/app/analytics/guardian') : appUrl(env, '/app/admin/guardian');
  for (const to of await recipientsFor(env, inc)) {
    await sendTransactional(env, to, resolved ? `✅ Resolved: ${inc.title}` : `${inc.severity === 'critical' ? '⚠️' : 'ℹ️'} Deliverability: ${inc.title}`,
      resolved
        ? `<p>The Deliverability Guardian saw this recover and lifted any slowdown it had applied:</p><p><strong>${esc(inc.title)}</strong></p><p><a href="${link}">Open the Guardian</a></p>`
        : `<p><strong>${esc(inc.title)}</strong></p><p>${esc(inc.diagnosis)}</p><p><strong>What to do:</strong> ${esc(inc.recommendation)}</p><p><a href="${link}">Open the Guardian</a></p>`).catch(() => {});
  }
}

const RATE_KINDS = new Set(['deferrals', 'bounces', 'complaints', 'volume_spike']);

/** Counts for one provider:/workspace: scope since `since` (fresh evidence after the Guardian acted). */
async function scopeStats(env: Env, scope: string, since: number) {
  const type = scope.slice(0, scope.indexOf(':')), val = scope.slice(scope.indexOf(':') + 1);
  const cond = type === 'provider' ? (val === 'other' ? `COALESCE(d.provider, 'other') NOT IN ('gmail','outlook','yahoo','apple')` : 'd.provider = ?') : 'd.pub_id IN (SELECT id FROM publications WHERE workspace_id = ?)';
  const params = type === 'provider' && val === 'other' ? [] : [val];
  const r = await one<any>(env, `SELECT ${COUNTS} FROM deliveries d WHERE ${BASE} AND d.created_at >= ? AND ${cond}`, since, ...params);
  return { n: Number(r?.n || 0), acc: Number(r?.acc || 0), hard: Number(r?.hard || 0), blocked: Number(r?.blocked || 0), compl: Number(r?.compl || 0), def: Number(r?.def || 0) };
}

/** Is an open rate incident still bad on fresh mail? null = not enough fresh mail to tell. */
async function stillBad(env: Env, i: Incident, since: number): Promise<{ bad: boolean; rate: number } | null> {
  const prov = i.scope.startsWith('provider:');
  const s = await scopeStats(env, i.scope, since);
  if (i.kind === 'complaints') {
    if (s.acc < (prov ? 400 : 200)) return null;
    const rate = s.compl / s.acc;
    return { bad: rate >= (prov ? GUARDIAN.PROVIDER_COMPLAINT[0] : GUARDIAN.WS_COMPLAINT[0]), rate };
  }
  if (s.n < (prov ? GUARDIAN.PROVIDER_MIN / 2 : GUARDIAN.WORKSPACE_MIN / 2)) return null;
  if (i.kind === 'deferrals') { const rate = s.def / s.n; return { bad: rate >= (prov ? GUARDIAN.PROVIDER_DEFERRAL[0] : GUARDIAN.WS_DEFERRAL[0]), rate }; }
  const rate = (prov ? s.blocked : s.hard) / s.n;
  return { bad: rate >= (prov ? GUARDIAN.PROVIDER_BOUNCE[0] : GUARDIAN.WS_BOUNCE[0]), rate };
}

async function resolveIncident(env: Env, i: Incident, t: number, keepThrottle = false) {
  await run(env, `UPDATE guardian_incidents SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?`, t, t, i.id);
  if (i.throttle_scope && !keepThrottle) await liftThrottle(env, i.throttle_scope);
  if (i.severity !== 'info' || i.workspace_id) await notify(env, i, true);
}

/** One Guardian pass. Exported for tests and the platform view's "Run now". */
export async function runGuardian(env: Env, t = now()): Promise<{ opened: number; updated: number; resolved: number; findings: number }> {
  const parts = await Promise.all([providerFindings(env, t), workspaceFindings(env, t), domainFindings(env)]);
  const findings = parts.flatMap((p) => p.findings);
  const healthy = new Set(parts.flatMap((p) => [...p.healthy]));
  const open = await all<Incident>(env, `SELECT * FROM guardian_incidents WHERE status = 'open'`);
  const recent = await all<Incident>(env, `SELECT * FROM guardian_incidents WHERE status = 'resolved' AND resolved_at > ? ORDER BY resolved_at DESC`, t - GUARDIAN.WINDOW_MS);
  let opened = 0, updated = 0, resolved = 0;
  const seen = new Set<string>();
  const act = async (f: Finding) => {
    if (!f.throttle) return '';
    const res = await applyThrottle(env, f.throttle.scope, f.throttle.factor, f.throttle.ms, f.throttle.label);
    return res === 'applied' ? `${f.throttle.factor <= 0 ? 'Paused sending' : `Slowed to ${speed(f.throttle.factor)}`} (${f.throttle.scope}) until ${new Date(t + Math.min(f.throttle.ms, GUARDIAN.MAX_THROTTLE_MS)).toISOString().slice(11, 16)} UTC`
      : res === 'kept_manual' ? 'An operator throttle is already in place; left unchanged' : '';
  };

  // 1. Open rate incidents (provider / workspace) are judged only on mail sent since the Guardian last acted, so a
  //    pause isn't kept alive by the same bad mail that caused it.
  for (const i of open.filter((x) => RATE_KINDS.has(x.kind) && /^(provider|workspace):/.test(x.scope))) {
    seen.add(`${i.scope}|${i.kind}`);
    const since = i.acted_at || i.opened_at;
    if (i.kind === 'volume_spike') { if (t - since >= HOUR) { await resolveIncident(env, i, t, true); resolved++; } continue; }
    const st = await stillBad(env, i, since);
    if (st == null) { if (t - since >= GUARDIAN.RESOLVE_STALE_MS) { await resolveIncident(env, i, t); resolved++; } continue; }
    if (!st.bad) { await resolveIncident(env, i, t); resolved++; continue; }
    // still bad on fresh mail: once the previous throttle has run out, apply it again (and escalate if needed)
    const f = findings.find((x) => x.scope === i.scope && x.kind === i.kind);
    const live = (await activeThrottles(env, [i.throttle_scope || i.scope])).length > 0;
    const action = f && !live ? await act(f) : '';
    await run(env, `UPDATE guardian_incidents SET severity = ?, title = ?, diagnosis = ?, recommendation = ?, metric = ?, action = COALESCE(NULLIF(?, ''), action), acted_at = CASE WHEN ? <> '' THEN ? ELSE acted_at END, updated_at = ? WHERE id = ?`,
      f?.severity || i.severity, f?.title || i.title, f?.diagnosis || i.diagnosis, f?.recommendation || i.recommendation, st.rate, action, action, t, t, i.id);
    if (f && SEV_RANK[f.severity] > SEV_RANK[i.severity]) await notify(env, { ...f, workspace_id: f.workspaceId ?? null }, false);
    updated++;
  }

  // 2. New findings, and domain incidents (blocklist / DMARC) that are re-checked every pass
  for (const f of findings) {
    const key = `${f.scope}|${f.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cur = open.find((i) => i.scope === f.scope && i.kind === f.kind);
    if (cur) {
      await run(env, `UPDATE guardian_incidents SET severity = ?, title = ?, diagnosis = ?, recommendation = ?, metric = ?, updated_at = ? WHERE id = ?`, f.severity, f.title, f.diagnosis, f.recommendation, f.metric, t, cur.id);
      if (SEV_RANK[f.severity] > SEV_RANK[cur.severity]) await notify(env, { ...f, workspace_id: f.workspaceId ?? null }, false);
      updated++;
      continue;
    }
    // Just recovered? The window still holds the old bad mail: only reopen on fresh evidence since the resolution.
    if (RATE_KINDS.has(f.kind) && f.kind !== 'volume_spike') {
      const prev = recent.find((i) => i.scope === f.scope && i.kind === f.kind);
      if (prev) { const st = await stillBad(env, prev, prev.resolved_at || t); if (!st?.bad) continue; }
    } else if (f.kind === 'volume_spike' && recent.some((i) => i.scope === f.scope && i.kind === f.kind)) continue;
    const action = await act(f);
    await insert(env, 'guardian_incidents', { id: id(), scope: f.scope, workspace_id: f.workspaceId ?? null, kind: f.kind, severity: f.severity, title: f.title, diagnosis: f.diagnosis, recommendation: f.recommendation, action, throttle_scope: f.throttle?.scope ?? null, metric: f.metric, acted_at: action ? t : null, status: 'open', opened_at: t, updated_at: t, resolved_at: null });
    if (f.severity !== 'info' || f.workspaceId) await notify(env, { ...f, workspace_id: f.workspaceId ?? null }, false);
    opened++;
  }

  // 3. Domain incidents that cleared (or haven't been seen for a while)
  for (const i of open) {
    const key = `${i.scope}|${i.kind}`;
    if (seen.has(key)) continue;
    if (!healthy.has(key) && t - i.updated_at < GUARDIAN.RESOLVE_STALE_MS) continue;
    await resolveIncident(env, i, t);
    resolved++;
  }
  return { opened, updated, resolved, findings: findings.length };
}

registerPeriodic('guardian', GUARDIAN.EVERY_MS, async (env) => {
  try { await runGuardian(env); } catch (e) { await logError(env, 'guardian', e); }
});
registerPeriodic('guardian.prune', DAY, async (env) => {
  await pruneDmarc(env);
  await run(env, `DELETE FROM send_throttles WHERE until IS NOT NULL AND until < ? AND reason LIKE 'guardian:%'`, now() - DAY).catch(() => {});
  await run(env, `DELETE FROM guardian_incidents WHERE status = 'resolved' AND resolved_at < ?`, now() - 180 * DAY).catch(() => {});
});

// ───────── customer view ─────────
export async function incidentsFor(env: Env, workspaceId: string, pubHosts: string[], limit = 30): Promise<Incident[]> {
  const scopes = [`workspace:${workspaceId}`, ...pubHosts.map((h) => `domain:${h}`)];
  // provider incidents affect everyone on the shared infrastructure: show the open ones
  return all<Incident>(env, `SELECT * FROM guardian_incidents WHERE scope IN (${scopes.map(() => '?').join(',')}) OR (scope LIKE 'provider:%' AND (status = 'open' OR opened_at > ?)) ORDER BY status = 'open' DESC, opened_at DESC LIMIT ?`, ...scopes, now() - 7 * DAY, limit);
}

export interface Health { score: number; grade: string; tone: 'green' | 'amber' | 'red'; factors: Array<{ label: string; penalty: number }> }

/** 0–100 health score for a publication from its last 7 days (rates), its domains and open incidents. */
export async function healthScore(env: Env, pub: Publication): Promise<{ health: Health; m: Awaited<ReturnType<typeof deliveryMetrics>> }> {
  const m = await deliveryMetrics(env, { pubId: pub.id }, now() - 7 * DAY, now(), { money: false });
  const factors: Array<{ label: string; penalty: number }> = [];
  const add = (label: string, p: number) => { if (p >= 0.5) factors.push({ label, penalty: Math.round(p) }); };
  if (m.attempted >= 50) {
    add(`Hard bounces ${pct(m.hardRate || 0, 2)} (keep under 2%)`, Math.min(30, ((m.hardRate || 0) / 0.02) * 12));
    add(`Spam complaints ${pct(m.complaintRate || 0, 3)} (keep under 0.1%)`, Math.min(30, ((m.complaintRate || 0) / 0.001) * 10));
    add(`Deferrals ${pct(m.deferralRate || 0, 1)}`, Math.min(15, ((m.deferralRate || 0) / 0.1) * 8));
  }
  if (m.authPassRate != null && m.authMessages >= 20) add(`DMARC alignment ${pct(m.authPassRate, 0)} pass`, Math.min(20, (1 - m.authPassRate) * 40));
  const hosts = await pubSendingDomains(env, pub.id);
  const listed = hosts.length ? await one<any>(env, `SELECT COUNT(*) AS n FROM domains WHERE pub_id = ? AND kind = 'email' AND blocklisted = 1`, pub.id) : null;
  if (Number(listed?.n || 0)) add('Sending domain on a blocklist', 25);
  const inc = await all<any>(env, `SELECT severity FROM guardian_incidents WHERE status = 'open' AND (scope = ? OR scope IN (${hosts.map(() => '?').join(',') || "''"}))`, `workspace:${pub.workspace_id}`, ...hosts.map((h) => `domain:${h}`));
  for (const i of inc) add(`Open ${i.severity} incident`, i.severity === 'critical' ? 15 : i.severity === 'warning' ? 7 : 2);
  const score = Math.max(0, Math.min(100, Math.round(100 - factors.reduce((a, f) => a + f.penalty, 0))));
  const grade = score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 50 ? 'Needs attention' : 'At risk';
  return { health: { score, grade, tone: score >= 75 ? 'green' : score >= 50 ? 'amber' : 'red', factors }, m };
}

/** Plain-English recommendations from what the publication has set up and how it's performing. */
export async function recommendations(env: Env, pub: Publication, m: Awaited<ReturnType<typeof deliveryMetrics>>): Promise<Array<{ text: string; href?: string }>> {
  const out: Array<{ text: string; href?: string }> = [];
  const doms = await all<any>(env, `SELECT * FROM domains WHERE pub_id = ? AND kind = 'email'`, pub.id);
  if (!doms.length) out.push({ text: 'Send from your own domain. Mail from a shared domain shares its reputation; your own verified domain with SPF, DKIM and DMARC is the biggest single boost to inbox placement.', href: '/app/settings/domains' });
  for (const d of doms) {
    const rep = (() => { try { return JSON.parse(d.dns_report || '{}'); } catch { return {}; } })();
    const dm = (rep.checks || []).find((c: any) => c.key === 'dmarc');
    if (d.status !== 'verified') out.push({ text: `Finish verifying ${d.hostname}.`, href: '/app/settings/domains' });
    else if (!dm?.ok) out.push({ text: `Publish a DMARC record for ${d.hostname} with our report address, so you can see who sends as you.`, href: '/app/settings/domains' });
    const reports = await one<any>(env, `SELECT COUNT(*) AS n FROM dmarc_reports WHERE domain = ?`, d.hostname).catch(() => null);
    if (d.status === 'verified' && !Number(reports?.n || 0)) out.push({ text: `No DMARC reports received for ${d.hostname} yet. Add rua=mailto:dmarc+${String(d.id).toLowerCase()}@${sharedDomain(env)} to its DMARC record (reports start within a day).`, href: '/app/settings/domains' });
  }
  if ((m.complaintRate || 0) > 0.001) out.push({ text: 'Complaints are above 0.1%. Turn on double opt-in, remind readers why they get the email, and keep the unsubscribe link visible.', href: '/app/settings/publication' });
  if ((m.hardRate || 0) > 0.02) out.push({ text: 'Hard bounces are above 2%. Clean imported lists before sending and remove addresses that never confirmed.', href: '/app/audience' });
  if ((m.deferralRate || 0) > 0.1) out.push({ text: 'More than 10% of mail is deferred. Send to your most engaged readers first and spread large sends over a few hours.' });
  const seeds = await one<any>(env, `SELECT COUNT(*) AS n FROM seed_addresses WHERE pub_id = ?`, pub.id).catch(() => null);
  if (!Number(seeds?.n || 0)) out.push({ text: 'Add a few seed inboxes you own (Gmail, Outlook, Yahoo) and run a placement test before big sends.', href: '/app/analytics/guardian?tab=placement' });
  if (!out.length) out.push({ text: 'Nothing to fix right now. Keep sending to people who open, and run a seed test before unusual sends.' });
  return out;
}

// ───────── platform view ─────────
export async function mtaHealth(env: Env, sinceMs = DAY): Promise<{ attempts: number; failed: number; byCode: Array<{ code: string; n: number }> }> {
  const t = now() - sinceMs;
  const tot = await one<any>(env, `SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS f FROM outbox WHERE created_at >= ? AND status IN ('sent','failed')`, t);
  const byCode = await all<any>(env, `SELECT CASE WHEN error LIKE 'E\\_%' ESCAPE '\\' THEN substr(error, 1, instr(error || ' ', ' ') - 1) ELSE substr(COALESCE(error, 'unknown'), 1, 40) END AS code, COUNT(*) AS n FROM outbox WHERE created_at >= ? AND status = 'failed' GROUP BY code ORDER BY n DESC LIMIT 12`, t);
  return { attempts: Number(tot?.n || 0), failed: Number(tot?.f || 0), byCode: byCode.map((r) => ({ code: r.code || 'unknown', n: Number(r.n) })) };
}

export async function worstWorkspaces(env: Env, limit = 15) {
  return all<any>(env, `SELECT p.workspace_id AS ws, w.name, COUNT(*) AS n,
      SUM(CASE WHEN d.status = 'bounced' AND d.bounce_type = 'hard' THEN 1 ELSE 0 END) AS hard,
      SUM(CASE WHEN d.status = 'complained' THEN 1 ELSE 0 END) AS compl,
      SUM(CASE WHEN d.status = 'deferred' OR d.attempts > 1 THEN 1 ELSE 0 END) AS def
    FROM deliveries d JOIN publications p ON p.id = d.pub_id LEFT JOIN workspaces w ON w.id = p.workspace_id
    WHERE ${BASE} AND d.created_at >= ? GROUP BY p.workspace_id HAVING n >= 20
    ORDER BY (CAST(hard AS REAL) / n) * 50 + (CAST(compl AS REAL) / n) * 1000 + (CAST(def AS REAL) / n) * 10 DESC LIMIT ?`, now() - DAY, limit);
}

// ───────── inbox placement seed tests ─────────
export const SEED_MAX = 12;
export const PLACEMENTS = ['inbox', 'promotions', 'spam'] as const;

export async function addSeeds(env: Env, pubId: string, emails: string[]): Promise<{ added: number; skipped: string[] }> {
  const have = Number((await one<any>(env, 'SELECT COUNT(*) AS n FROM seed_addresses WHERE pub_id = ?', pubId))?.n || 0);
  let added = 0;
  const skipped: string[] = [];
  for (const raw of emails) {
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e) || have + added >= SEED_MAX) { skipped.push(e); continue; }
    const r = await run(env, 'INSERT OR IGNORE INTO seed_addresses (id, pub_id, email, provider, created_at) VALUES (?, ?, ?, ?, ?)', id(), pubId, e, mailboxProvider(e), now());
    if (r.meta?.changes) added++; else skipped.push(e);
  }
  return { added, skipped };
}

/** Send a preview of a post to every seed address, each with its own one-click placement links. */
export async function runSeedTest(env: Env, pub: Publication, post: any, userEmail: string): Promise<{ testId: string; sent: number; failed: number }> {
  const seeds = await all<any>(env, 'SELECT * FROM seed_addresses WHERE pub_id = ? ORDER BY created_at', pub.id);
  const { postContent, buildEmail } = await import('./sender');
  const content = await postContent(env, post);
  const built = await buildEmail(env, pub, content, null, { post, access: true });
  const from = await senderFor(env, pub, 'newsletter', post.sender_id);
  const testId = id();
  const subject = post.email_subject || post.title;
  await insert(env, 'seed_tests', { id: testId, pub_id: pub.id, post_id: post.id, subject, created_by: userEmail, created_at: now() });
  let sent = 0, failed = 0;
  for (const s of seeds) {
    const tok = id(24).toLowerCase();
    const link = (p: string) => appUrl(env, `/seed/${tok}/${p}`);
    const box = `<table role="presentation" width="100%" style="margin:24px 0;border-top:1px dashed #d6d3d1"><tr><td style="padding:16px;font:14px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#57534e;text-align:center">Placement test: where did this land?<br><a href="${link('inbox')}" style="color:#15803d">Inbox</a> · <a href="${link('promotions')}" style="color:#b45309">Promotions / other tab</a> · <a href="${link('spam')}" style="color:#b91c1c">Spam / junk</a></td></tr></table>`;
    const html = /<\/body>/i.test(built.html) ? built.html.replace(/<\/body>/i, `${box}</body>`) : built.html + box;
    const shared = sharedDomain(env);
    const res = await sendMail(env, { to: s.email, subject, html, text: `${built.text}\n\nPlacement test — where did this land? Inbox: ${link('inbox')}  Promotions: ${link('promotions')}  Spam: ${link('spam')}`, from, pub, kind: 'marketing', replyTo: shared ? `seed+${tok}@${shared}` : undefined, headers: { 'X-OpenHive-Seed': testId } });
    await insert(env, 'seed_results', { id: tok, test_id: testId, pub_id: pub.id, email: s.email, provider: s.provider, status: res.ok ? 'sent' : 'failed', placement: null, sent_at: now(), marked_at: null });
    if (res.ok) sent++; else failed++;
  }
  return { testId, sent, failed };
}

/** Record where a seed email landed (one-click link or a reply to seed+<token>@). */
export async function markSeed(env: Env, token: string, word: string): Promise<boolean> {
  const w = word.toLowerCase();
  const placement = /^(inbox|primary)$/.test(w) ? 'inbox' : /^promotions?$/.test(w) ? 'promotions' : /^(spam|junk)$/.test(w) ? 'spam' : null;
  if (!placement || !/^[a-z0-9]{8,40}$/.test(token)) return false;
  const r = await run(env, `UPDATE seed_results SET placement = ?, marked_at = ? WHERE id = ? AND sent_at > ?`, placement, now(), token, now() - 30 * DAY);
  return !!r.meta?.changes;
}

export async function placementSummary(env: Env, pubId: string, days = 90) {
  const rows = await all<any>(env, `SELECT CASE WHEN provider IN ('gmail','outlook','yahoo','apple') THEN provider ELSE 'other' END AS provider, placement, COUNT(*) AS n FROM seed_results WHERE pub_id = ? AND status = 'sent' AND sent_at > ? GROUP BY 1, 2`, pubId, now() - days * DAY);
  const out = new Map<string, { provider: string; inbox: number; promotions: number; spam: number; unmarked: number }>();
  for (const r of rows) {
    const o = out.get(r.provider) || { provider: r.provider, inbox: 0, promotions: 0, spam: 0, unmarked: 0 };
    if (r.placement === 'inbox' || r.placement === 'promotions' || r.placement === 'spam') o[r.placement as 'inbox'] += Number(r.n); else o.unmarked += Number(r.n);
    out.set(r.provider, o);
  }
  return [...out.values()].sort((a, b) => PROVIDERS.indexOf(a.provider as any) - PROVIDERS.indexOf(b.provider as any));
}

export { PROVIDER_NAME, getPub, siteUrl };
