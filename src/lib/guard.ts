// Protection layer: email validation, bot detection, rate limiting, crawler classification.
import type { Env } from '../types';
import { one, run } from './db';
import { now, domainOf } from './util';

// ───────── Email validation ─────────
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

// Compact disposable-domain list (most common providers). Operators can extend via publication settings.
export const DISPOSABLE = new Set(
  `0-mail.com 10minutemail.com 10minutemail.net 20minutemail.com 33mail.com anonbox.net armyspy.com burnermail.io byom.de cuvox.de dayrep.com
discard.email dispostable.com dropmail.me einrot.com emailondeck.com fakeinbox.com fakemail.net fleckens.hu getairmail.com getnada.com
guerrillamail.biz guerrillamail.com guerrillamail.de guerrillamail.info guerrillamail.net guerrillamail.org guerrillamailblock.com gustr.com
harakirimail.com incognitomail.org jetable.org jourrapide.com mailcatch.com maildrop.cc mailexpire.com mailinator.com mailinator.net
mailinator2.com mailnesia.com mailnull.com mailtemp.info mintemail.com moakt.com mohmal.com mytemp.email mytrashmail.com nada.email
nwytg.net objectmail.com rhyta.com sharklasers.com spam4.me spambog.com spambox.us spamgourmet.com spamex.com superrito.com teleworm.us
temp-mail.io temp-mail.org tempail.com tempinbox.com tempmail.com tempmail.net tempmail.plus tempmailo.com tempr.email throwawaymail.com
trash-mail.com trashmail.com trashmail.de trashmail.net trbvm.com wegwerfmail.de yopmail.com yopmail.fr yopmail.net mail.tm emlpro.com
inboxkitten.com mailpoof.com tmail.ws tmpmail.org tmpmail.net linshiyouxiang.net 1secmail.com 1secmail.org 1secmail.net`.split(/\s+/),
);

const COMMON = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'live.com', 'msn.com', 'protonmail.com', 'proton.me', 'me.com', 'googlemail.com', 'ymail.com', 'comcast.net', 'hey.com', 'fastmail.com', 'gmx.com', 'mail.com', 'zoho.com', 'yandex.com'];
const TYPO_FIX: Record<string, string> = {
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gnail.com': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.con': 'gmail.com', 'gmaill.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gmail.cm': 'gmail.com', 'gmali.com': 'gmail.com',
  'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yahoo.co': 'yahoo.com', 'yahoo.con': 'yahoo.com', 'hotmal.com': 'hotmail.com', 'hotmial.com': 'hotmail.com', 'hotmail.co': 'hotmail.com', 'hotmail.con': 'hotmail.com',
  'outlok.com': 'outlook.com', 'outlook.co': 'outlook.com', 'outloo.com': 'outlook.com', 'iclod.com': 'icloud.com', 'icloud.co': 'icloud.com', 'icoud.com': 'icloud.com',
};

function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

export function suggestEmail(email: string): string | null {
  const [local, domain] = email.toLowerCase().split('@');
  if (!domain) return null;
  if (TYPO_FIX[domain]) return `${local}@${TYPO_FIX[domain]}`;
  if (COMMON.includes(domain)) return null;
  let best: string | null = null, bestD = 3;
  for (const c of COMMON) {
    const dd = lev(domain, c);
    if (dd > 0 && dd < bestD) { bestD = dd; best = c; }
  }
  return best && bestD <= 2 ? `${local}@${best}` : null;
}

/** UTF-8 local part: letters/digits/marks of any script plus the RFC 5322 atext symbols, no leading/trailing/double dot. */
const INTL_LOCAL_RE = /^(?!\.)(?!.*\.\.)[\p{L}\p{N}\p{M}!#$%&'*+/=?^_`{|}~.-]+(?<!\.)$/u;

/** Unicode domain → ASCII (punycode) via the WHATWG URL parser (IDNA/UTS-46). null when it isn't a valid hostname. */
export function toAsciiDomain(domain: string): string | null {
  if (!domain || /[\s/\\?#@%:[\]]/.test(domain)) return null;
  try {
    const h = new URL(`http://${domain}/`).hostname;
    return /^[a-z0-9.-]+$/.test(h) && h.includes('.') ? h : null;
  } catch { return null; }
}

/** Latin lookalikes from Cyrillic/Greek and accented letters, folded to ASCII (for homograph checks only). */
const CONFUSABLE: Record<string, string> = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ј': 'j', 'ӏ': 'l', 'ԁ': 'd', 'ɡ': 'g', 'ı': 'i', 'ѕ': 's', 'һ': 'h', 'ο': 'o', 'α': 'a', 'ν': 'v', 'κ': 'k', 'τ': 't', 'ε': 'e', 'ι': 'i', 'ӧ': 'o', 'ⅼ': 'l', 'ｍ': 'm' };
export function foldLookalikes(s: string): string {
  return [...s.normalize('NFKD')].map((ch) => CONFUSABLE[ch] ?? ch).join('').replace(/\p{M}/gu, '');
}

export interface EmailCheck { ok: boolean; email: string; reason?: string; suggestion?: string | null }

const mxCache = new Map<string, { ok: boolean; at: number }>();

/** DNS MX lookup over HTTPS (Cloudflare DoH). Falls back to "ok" if DNS is unreachable. */
export async function hasMX(domain: string): Promise<boolean> {
  const c = mxCache.get(domain);
  if (c && Date.now() - c.at < 3600_000) return c.ok;
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, { headers: { accept: 'application/dns-json' } });
    if (!r.ok) return true;
    const j: any = await r.json();
    let ok = j.Status === 0 && Array.isArray(j.Answer) && j.Answer.length > 0;
    if (!ok && j.Status === 0) {
      // RFC 5321: fall back to A record
      const a = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`, { headers: { accept: 'application/dns-json' } });
      const aj: any = await a.json();
      ok = Array.isArray(aj.Answer) && aj.Answer.length > 0;
    }
    mxCache.set(domain, { ok, at: Date.now() });
    return ok;
  } catch {
    return true;
  }
}

/** Validate one email submission. `strict` adds the DNS MX check (used for 1st-party signups and API). */
export async function validateEmail(raw: string, opts: { strict?: boolean; extraBlocked?: string[] } = {}): Promise<EmailCheck> {
  let email = (raw || '').trim().normalize('NFC').toLowerCase();
  const bad = { ok: false, email, reason: 'That email address looks invalid.' };
  // International email (RFC 6531 / IDNA): UTF-8 local parts, and domains converted to punycode (xn--) for sending and
  // storage, so the disposable/typo/MX checks below run on the same ASCII form as everyone else.
  if (/[^\x00-\x7f]/.test(email)) {
    const at = email.lastIndexOf('@');
    if (at < 1) return bad;
    const uLocal = email.slice(0, at), uDomain = email.slice(at + 1);
    if (!INTL_LOCAL_RE.test(uLocal) || new TextEncoder().encode(uLocal).length > 64) return bad;
    const ascii = toAsciiDomain(uDomain);
    if (!ascii) return bad;
    // homograph of a big mailbox provider (gmаil.com with a Cyrillic "а") → treat like a typo
    const look = foldLookalikes(uDomain);
    const target = TYPO_FIX[look] || (COMMON.includes(look) ? look : null);
    if (ascii !== uDomain && target) return { ok: false, email, reason: `Did you mean ${uLocal}@${target}?`, suggestion: `${uLocal}@${target}` };
    email = `${uLocal}@${ascii}`;
    if (new TextEncoder().encode(email).length > 254 || !EMAIL_RE.test(`x@${ascii}`)) return { ...bad, email };
  } else if (!email || email.length > 254 || !EMAIL_RE.test(email)) return bad;
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at), domain = email.slice(at + 1);
  if (local.length > 64 && !/[^\x00-\x7f]/.test(local)) return { ok: false, email, reason: 'That email address looks invalid.' };
  if (DISPOSABLE.has(domain) || opts.extraBlocked?.includes(domain)) return { ok: false, email, reason: 'Disposable email addresses are not allowed.' };
  if (/^(test|example|invalid|localhost)$/.test(domain.split('.').pop() || '') || /^example\.(com|org|net)$/.test(domain))
    return { ok: false, email, reason: 'Please use a real email address.' };
  if (TYPO_FIX[domain]) return { ok: false, email, reason: 'Did you mean ' + `${local}@${TYPO_FIX[domain]}?`, suggestion: `${local}@${TYPO_FIX[domain]}` };
  if (opts.strict && !(await hasMX(domain))) return { ok: false, email, reason: `The domain ${domain} cannot receive email.` };
  return { ok: true, email, suggestion: suggestEmail(email) };
}

// ───────── Rate limiting (fixed window in D1) ─────────
export async function rateLimit(env: Env, key: string, limit: number, windowSec: number): Promise<boolean> {
  const t = now();
  const row = await one<{ count: number; reset_at: number }>(env, 'SELECT count, reset_at FROM rate_limits WHERE key = ?', key);
  if (!row || row.reset_at < t) {
    await run(env, 'INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)', key, t + windowSec * 1000);
    return true;
  }
  if (row.count >= limit) return false;
  await run(env, 'UPDATE rate_limits SET count = count + 1 WHERE key = ?', key);
  return true;
}

export function clientIP(req: Request): string {
  return req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')?.split(',')[0].trim() || '0.0.0.0';
}

// ───────── Bot detection ─────────
const BOT_UA = /bot|crawl|spider|slurp|curl|wget|python-requests|httpclient|axios|node-fetch|go-http|java\/|libwww|headless|phantom|selenium|puppeteer|playwright|scrapy|okhttp|postman|insomnia/i;

export interface BotSignals { honeypot?: string; renderedAt?: string | number; ua?: string | null; turnstileOk?: boolean | null }

/** Score 0-100 (higher = more bot-like). >= 60 → reject, 30-59 → suspicious (ask to confirm). */
export function botScore(s: BotSignals): number {
  let score = 0;
  if (s.honeypot) score += 100;
  if (!s.ua) score += 40;
  else if (BOT_UA.test(s.ua)) score += 70;
  const rendered = Number(s.renderedAt || 0);
  if (rendered) {
    const elapsed = Date.now() - rendered;
    if (elapsed < 1500) score += 50; // filled faster than a human
    if (elapsed > 86_400_000) score += 10;
  } else score += 15;
  if (s.turnstileOk === false) score += 80;
  if (s.turnstileOk === true) score -= 50;
  return Math.max(0, Math.min(100, score));
}

export async function verifyTurnstile(env: Env, tokenStr: string | undefined, ip: string): Promise<boolean | null> {
  if (!env.TURNSTILE_SECRET) return null;
  if (!tokenStr) return false;
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: tokenStr, remoteip: ip }),
  });
  const j: any = await r.json().catch(() => ({}));
  return !!j.success;
}

// ───────── Crawler classification & click bots ─────────
const CRAWLERS: Array<[RegExp, string, string]> = [
  [/GPTBot/i, 'GPTBot', 'ai'], [/ChatGPT-User/i, 'ChatGPT-User', 'ai'], [/OAI-SearchBot/i, 'OAI-SearchBot', 'ai'], [/ClaudeBot|Claude-Web|anthropic-ai/i, 'ClaudeBot', 'ai'],
  [/PerplexityBot/i, 'PerplexityBot', 'ai'], [/Google-Extended/i, 'Google-Extended', 'ai'], [/CCBot/i, 'CCBot', 'ai'], [/Bytespider/i, 'Bytespider', 'ai'],
  [/Applebot-Extended/i, 'Applebot-Extended', 'ai'], [/meta-externalagent|FacebookBot/i, 'Meta-AI', 'ai'], [/cohere-ai/i, 'cohere-ai', 'ai'], [/Amazonbot/i, 'Amazonbot', 'ai'], [/Diffbot/i, 'Diffbot', 'ai'],
  [/Googlebot/i, 'Googlebot', 'search'], [/bingbot/i, 'Bingbot', 'search'], [/DuckDuckBot/i, 'DuckDuckBot', 'search'], [/YandexBot/i, 'YandexBot', 'search'], [/Baiduspider/i, 'Baiduspider', 'search'], [/Applebot/i, 'Applebot', 'search'],
  [/AhrefsBot/i, 'AhrefsBot', 'seo'], [/SemrushBot/i, 'SemrushBot', 'seo'], [/MJ12bot/i, 'MJ12bot', 'seo'], [/DotBot/i, 'DotBot', 'seo'],
  [/facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|Discordbot|TelegramBot|WhatsApp/i, 'Link preview', 'preview'],
];

export function classifyCrawler(ua: string | null | undefined): { bot: string; category: string } | null {
  if (!ua) return { bot: 'No user agent', category: 'other' };
  for (const [re, name, cat] of CRAWLERS) if (re.test(ua)) return { bot: name, category: cat };
  if (BOT_UA.test(ua)) return { bot: 'Generic bot', category: 'scraper' };
  return null;
}

/** Email-security scanners and prefetchers that click/open every link. */
const SCANNER_UA = /barracuda|mimecast|proofpoint|symantec|forcepoint|trendmicro|sophos|fireeye|cisco|ironport|microsoft office|ms-office|safelinks|googleimageproxy|yahoomailproxy|bingpreview|linkcheck|urlscan|python|curl|wget|go-http|headless/i;

export function isBotClick(ua: string | null | undefined, msSinceSend?: number): boolean {
  if (!ua) return true;
  if (SCANNER_UA.test(ua) || BOT_UA.test(ua)) return true;
  if (msSinceSend !== undefined && msSinceSend < 10_000) return true; // clicked within seconds of delivery = scanner
  return false;
}

/** Browser versions no reader still uses (security scanners often send ancient user agents, e.g. Gecko/2002). */
export function isAncientUA(ua: string | null | undefined): boolean {
  if (!ua) return true;
  const gecko = ua.match(/Gecko\/(\d{4})\d{4}/); if (gecko && Number(gecko[1]) < 2016 && !/Firefox\/\d{3}/.test(ua)) return true;
  if (/rv:1\.\d/.test(ua) || /MSIE [1-9]\./.test(ua) || /Windows NT [45]\./.test(ua)) return true;
  const chrome = ua.match(/Chrome\/(\d+)/); if (chrome && Number(chrome[1]) < 70) return true;
  const ff = ua.match(/Firefox\/(\d+)/); if (ff && Number(ff[1]) < 60) return true;
  return false;
}

/** Cloud/hosting networks. People click from home, mobile and office ISPs; scanners click from data centers.
 *  Privacy relays (iCloud Private Relay rides on Cloudflare/Akamai/Fastly) are deliberately not listed. */
const DATACENTER = /amazon|aws|google cloud|microsoft corporation|azure|digitalocean|ovh|hetzner|linode|contabo|oracle|alibaba|tencent|leaseweb|scaleway|vultr|choopa|m247|datacamp|hostinger|ionos|gcore|psychz|quadranet|colocrossing|servers\.com|hostwinds|kamatera|upcloud|netcup|interserver|vpsserver|zenlayer/i;
export function isDatacenter(cf: any): boolean {
  const org = String(cf?.asOrganization || '');
  return !!org && DATACENTER.test(org);
}

/** Apple Mail Privacy Protection & Gmail image proxy opens aren't human reads. */
export function isMachineOpen(ua: string | null | undefined): boolean {
  if (!ua) return true;
  return /GoogleImageProxy|YahooMailProxy/i.test(ua) ? false /* proxies do reflect real opens */ : /Mozilla\/5\.0$/.test(ua.trim()) || BOT_UA.test(ua);
}

export function emailDomain(email: string) {
  return domainOf(email);
}
