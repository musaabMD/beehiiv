// Custom domains + sending domain authentication (SPF/DKIM/DMARC), live DNS checks over DoH,
// warmup schedule, and blocklist monitoring (sending pauses automatically while listed — see sender.warmupAllowance).
import type { Env } from '../types';
import { all, one, run } from './db';
import { registerPeriodic, logError } from './jobs';
import { sendTransactional } from './email';
import { now, esc, HOUR } from './util';

export interface DnsRecord { key: string; type: 'TXT' | 'CNAME' | 'MX' | 'A'; host: string; value: string; purpose: string; required: boolean }
export interface DnsCheck { key: string; ok: boolean; found: string[]; note?: string }

export const SPF_INCLUDE = 'include:_spf.mx.cloudflare.net';
export const DKIM_SELECTOR = 'cf2024-1';

async function doh(name: string, type: string): Promise<{ status: number; answers: string[] }> {
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' } });
    if (!r.ok) return { status: -1, answers: [] };
    const j: any = await r.json();
    return { status: j.Status, answers: (j.Answer || []).map((a: any) => String(a.data || '').replace(/^"|"$/g, '').replace(/"\s*"/g, '')) };
  } catch {
    return { status: -1, answers: [] };
  }
}

export function appHost(env: Env) {
  return new URL(env.APP_URL).host;
}

/** The records a user must add for a domain. */
export function recordsFor(env: Env, d: { hostname: string; kind: string; verify_token: string }): DnsRecord[] {
  const h = d.hostname;
  const recs: DnsRecord[] = [
    { key: 'verify', type: 'TXT', host: `_openhive.${h}`, value: `openhive-verify=${d.verify_token}`, purpose: 'Proves you own this domain', required: true },
  ];
  if (d.kind === 'web') {
    recs.push({ key: 'cname', type: 'CNAME', host: h, value: appHost(env), purpose: 'Points your domain at your OpenHive site (proxied through Cloudflare / Cloudflare for SaaS custom hostname)', required: true });
  } else if (d.kind === 'tracking') {
    recs.push({ key: 'cname', type: 'CNAME', host: h, value: appHost(env), purpose: 'Tracking domain — open pixels, click redirects and unsubscribe links in your emails use this host instead of ' + appHost(env), required: true });
  } else {
    recs.push(
      { key: 'spf', type: 'TXT', host: h, value: `v=spf1 ${SPF_INCLUDE} ~all`, purpose: 'SPF — authorizes Cloudflare Email Sending to send for this domain (merge into an existing SPF record; only one v=spf1 record is allowed)', required: true },
      { key: 'dkim', type: 'TXT', host: `${DKIM_SELECTOR}._domainkey.${h}`, value: 'Provided by Cloudflare when you run: npx wrangler email sending enable ' + h, purpose: 'DKIM — cryptographically signs your mail. Added automatically when the zone is on Cloudflare.', required: true },
      { key: 'dmarc', type: 'TXT', host: `_dmarc.${h}`, value: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${h}; adkim=s; aspf=s; pct=100`, purpose: 'DMARC — tells inboxes to reject unaligned mail and sends you reports. adkim/aspf=s require strict alignment with your From domain.', required: true },
      { key: 'mx', type: 'MX', host: h, value: 'Any MX (needed to receive replies and bounces)', purpose: 'Lets the domain receive replies; also required by many inbox filters', required: false },
    );
  }
  return recs;
}

/** Run live DNS checks; returns per-record results and whether ownership is verified. */
export async function checkDomain(env: Env, d: { id: string; hostname: string; kind: string; verify_token: string }): Promise<{ verified: boolean; checks: DnsCheck[] }> {
  const h = d.hostname;
  const checks: DnsCheck[] = [];
  const txtVerify = await doh(`_openhive.${h}`, 'TXT');
  const rootTxt = await doh(h, 'TXT');
  const verifyOk = [...txtVerify.answers, ...rootTxt.answers].some((a) => a.includes(`openhive-verify=${d.verify_token}`));
  checks.push({ key: 'verify', ok: verifyOk, found: txtVerify.answers });
  let cnameOk = false;
  if (d.kind === 'web' || d.kind === 'tracking') {
    const cname = await doh(h, 'CNAME');
    const a = await doh(h, 'A');
    const target = appHost(env);
    const ok = cname.answers.some((x) => x.replace(/\.$/, '') === target) || (a.answers.length > 0 && cname.answers.length === 0);
    cnameOk = ok;
    checks.push({ key: 'cname', ok, found: [...cname.answers, ...a.answers], note: cname.answers.length ? (ok ? undefined : `Points elsewhere — set the CNAME to ${target}`) : a.answers.length ? 'Resolves via A record (fine if proxied through Cloudflare)' : 'No record found' });
  } else {
    const spf = rootTxt.answers.filter((x) => x.startsWith('v=spf1'));
    checks.push({ key: 'spf', ok: spf.length === 1 && spf[0].includes('_spf.mx.cloudflare.net'), found: spf, note: spf.length > 1 ? 'Multiple SPF records — merge them into one' : spf.length && !spf[0].includes('_spf.mx.cloudflare.net') ? `Add ${SPF_INCLUDE}` : undefined });
    const dkim = await doh(`${DKIM_SELECTOR}._domainkey.${h}`, 'TXT');
    checks.push({ key: 'dkim', ok: dkim.answers.some((x) => x.includes('v=DKIM1') || x.includes('p=')), found: dkim.answers.map((x) => x.slice(0, 80) + (x.length > 80 ? '…' : '')) });
    const dmarc = await doh(`_dmarc.${h}`, 'TXT');
    const dm = dmarc.answers.find((x) => x.startsWith('v=DMARC1'));
    checks.push({ key: 'dmarc', ok: !!dm && !/p=none/.test(dm), found: dmarc.answers, note: dm && /p=none/.test(dm) ? 'p=none only monitors — use quarantine or reject for full protection' : undefined });
    const mx = await doh(h, 'MX');
    checks.push({ key: 'mx', ok: mx.answers.length > 0, found: mx.answers });
  }
  const report = { checked_at: now(), checks };
  const verified = verifyOk;
  const prev = await one<any>(env, 'SELECT * FROM domains WHERE id = ?', d.id);
  await run(env, 'UPDATE domains SET status = ?, dns_report = ?, last_checked_at = ? WHERE id = ?', verified ? 'verified' : prev?.status === 'verified' ? 'verified' : 'failed', JSON.stringify(report), now(), d.id);
  if (verified && prev) {
    if (d.kind === 'web') await run(env, 'UPDATE publications SET custom_domain = ? WHERE id = ? AND (custom_domain IS NULL OR custom_domain != ?)', h, prev.pub_id, h);
    if (d.kind === 'email' && !prev.warmup_started_at) await run(env, 'UPDATE domains SET warmup_started_at = ? WHERE id = ?', now(), d.id);
  }
  // Tracking domain: links switch to it only while ownership AND the CNAME check pass, so emails never carry dead links.
  if (d.kind === 'tracking' && prev) {
    if (verified && cnameOk) await run(env, 'UPDATE publications SET tracking_domain = ? WHERE id = ?', h, prev.pub_id);
    else await run(env, 'UPDATE publications SET tracking_domain = NULL WHERE id = ? AND tracking_domain = ?', prev.pub_id, h);
  }
  return { verified, checks };
}

// ───────── Platform (default MAIL_FROM) sending domain ─────────
// The default sender domain isn't a publication's custom domain, so it lives in platform_domains. It gets the same
// warm-up schedule and blocklist checks. Its warm-up clock starts at the first message ever sent from it (inferred from
// the outbox), so an instance that has been sending for weeks isn't suddenly capped after an upgrade.

export function platformHost(env: Env): string {
  return (env.MAIL_FROM.split('@')[1] || '').toLowerCase();
}

/** Platform-owned sending domains: MAIL_FROM's domain plus the shared sender domain (SHARED_FROM_DOMAIN), if different. */
export function platformHosts(env: Env): string[] {
  const shared = (env.SHARED_FROM_DOMAIN || '').trim().toLowerCase();
  return [...new Set([platformHost(env), shared].filter(Boolean))];
}

/** Warm-up row for `host` when it's the default MAIL_FROM domain (created on first use); null otherwise or when disabled. */
export async function platformWarmupDomain(env: Env, host: string): Promise<{ hostname: string; warmup_started_at: number | null; blocklisted: number } | null> {
  if (!host || !platformHosts(env).includes(host) || (env.MAIL_FROM_WARMUP || '').toLowerCase() === 'off') return null;
  let row = await one<any>(env, 'SELECT * FROM platform_domains WHERE hostname = ?', host);
  if (!row) {
    const first = await one<{ t: number | null }>(env, `SELECT MIN(created_at) AS t FROM outbox WHERE from_email LIKE ? AND status IN ('sent','simulated')`, `%@${host}>`);
    await run(env, 'INSERT OR IGNORE INTO platform_domains (hostname, warmup_started_at, blocklisted, dns_report, created_at) VALUES (?, ?, 0, ?, ?)', host, first?.t || now(), '{}', now());
    row = await one<any>(env, 'SELECT * FROM platform_domains WHERE hostname = ?', host);
  }
  return row;
}

/** Restart (or start) warm-up for the platform domain — e.g. after moving MAIL_FROM to a brand-new domain. */
export async function restartPlatformWarmup(env: Env) {
  const host = platformHost(env);
  await run(env, `INSERT INTO platform_domains (hostname, warmup_started_at, blocklisted, dns_report, created_at) VALUES (?, ?, 0, '{}', ?)
    ON CONFLICT(hostname) DO UPDATE SET warmup_started_at = excluded.warmup_started_at`, host, now(), now());
}

/** Warmup schedule: day n → cap (mirrors sender.warmupAllowance). */
export function warmupSchedule(): Array<{ day: number; cap: number | null }> {
  return Array.from({ length: 13 }, (_, i) => ({ day: i + 1, cap: i >= 12 ? null : 200 * 2 ** i }));
}

// ───────── Blocklist monitoring ─────────
export const BLOCKLISTS: Array<{ zone: string; name: string; listed: (ip: string) => boolean }> = [
  // Spamhaus DBL: 127.0.1.x = listed; 127.255.255.x = query error/refused (e.g. via public resolver) — not a listing.
  { zone: 'dbl.spamhaus.org', name: 'Spamhaus DBL', listed: (ip) => /^127\.0\.1\.\d+$/.test(ip) },
  // URIBL: 127.0.0.1 = query refused; 127.0.0.2+ bitmask = listed
  { zone: 'multi.uribl.com', name: 'URIBL', listed: (ip) => /^127\.0\.0\.(\d+)$/.test(ip) && Number(ip.split('.')[3]) > 1 },
  // SURBL: 127.0.0.x bitmask, 127.0.0.1 = access blocked
  { zone: 'multi.surbl.org', name: 'SURBL', listed: (ip) => /^127\.0\.0\.(\d+)$/.test(ip) && Number(ip.split('.')[3]) > 1 },
];

export async function blocklistStatus(domain: string): Promise<Array<{ name: string; listed: boolean; answer: string[] }>> {
  const out = [];
  for (const bl of BLOCKLISTS) {
    const r = await doh(`${domain}.${bl.zone}`, 'A');
    out.push({ name: bl.name, listed: r.answers.some(bl.listed), answer: r.answers });
  }
  return out;
}

export async function checkBlocklists(env: Env) {
  const doms = await all<any>(env, `SELECT d.*, p.name AS pub_name FROM domains d JOIN publications p ON p.id = d.pub_id WHERE d.kind = 'email'`);
  for (const d of doms) {
    try {
      const res = await blocklistStatus(d.hostname);
      const listed = res.filter((r) => r.listed);
      const report = { ...JSON.parse(d.dns_report || '{}'), blocklists: { checked_at: now(), results: res } };
      await run(env, 'UPDATE domains SET blocklisted = ?, dns_report = ? WHERE id = ?', listed.length ? 1 : 0, JSON.stringify(report), d.id);
      if (!!listed.length !== !!d.blocklisted) {
        const admins = await all<{ email: string }>(env, `SELECT DISTINCT u.email FROM memberships m JOIN users u ON u.id = m.user_id JOIN publications p ON p.id = ? WHERE m.role IN ('owner','admin') AND (m.pub_id = p.id OR (m.pub_id = '' AND m.workspace_id = p.workspace_id))`, d.pub_id);
        for (const a of admins) {
          await sendTransactional(env, a.email, listed.length ? `⚠️ ${d.hostname} is on a blocklist — sending paused` : `✅ ${d.hostname} is off the blocklist — sending resumed`,
            listed.length
              ? `<p>Your sending domain <strong>${esc(d.hostname)}</strong> (${esc(d.pub_name)}) was found on: ${listed.map((l) => esc(l.name)).join(', ')}.</p><p>Newsletter sending from this domain is paused to protect your reputation. Request delisting from the blocklist operator, then sending resumes automatically on the next check.</p>`
              : `<p><strong>${esc(d.hostname)}</strong> is no longer listed. Sending has resumed.</p>`);
        }
      }
    } catch (e) {
      await logError(env, 'domains.blocklist', e, d.pub_id);
    }
  }
  // the default MAIL_FROM domain (tracked in platform_domains) — alert the instance operators
  for (const host of platformHosts(env)) {
  const p = await platformWarmupDomain(env, host).catch(() => null);
  if (p) {
    try {
      const res = await blocklistStatus(p.hostname);
      const listed = res.filter((r) => r.listed);
      await run(env, 'UPDATE platform_domains SET blocklisted = ?, dns_report = ? WHERE hostname = ?', listed.length ? 1 : 0, JSON.stringify({ blocklists: { checked_at: now(), results: res } }), p.hostname);
      if (!!listed.length !== !!p.blocklisted) {
        for (const a of (env.SUPERADMIN_EMAILS || '').split(',').map((x) => x.trim()).filter(Boolean)) {
          await sendTransactional(env, a, listed.length ? `⚠️ ${p.hostname} (default sender) is on a blocklist — sending paused` : `✅ ${p.hostname} is off the blocklist — sending resumed`,
            listed.length ? `<p>The platform sending domain <strong>${esc(p.hostname)}</strong> was found on: ${listed.map((l) => esc(l.name)).join(', ')}. Newsletters from it are paused until it's delisted.</p>` : `<p><strong>${esc(p.hostname)}</strong> is no longer listed. Sending has resumed.</p>`);
        }
      }
    } catch (e) {
      await logError(env, 'domains.blocklist', e);
    }
  }
  }
}

registerPeriodic('domains.blocklist', 6 * HOUR, checkBlocklists);

// Re-check unverified domains hourly so they flip to verified without a manual click.
// Tracking domains whose CNAME isn't live yet are re-checked too (they stay inactive until it is).
registerPeriodic('domains.recheck', HOUR, async (env) => {
  const pending = await all<any>(env, `SELECT d.* FROM domains d WHERE (d.status != 'verified' OR (d.kind = 'tracking' AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.id = d.pub_id AND p.tracking_domain = d.hostname))) AND d.created_at > ? LIMIT 50`, now() - 7 * 24 * HOUR);
  for (const d of pending) await checkDomain(env, d).catch((e) => logError(env, 'domains.recheck', e, d.pub_id));
});
