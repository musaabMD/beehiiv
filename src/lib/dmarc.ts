// DMARC aggregate (rua) report ingestion — RFC 7489 Appendix C (and DMARCbis) XML, delivered by mailbox providers as
// email attachments (.zip, .xml.gz or plain .xml) to dmarc@<shared sending domain> or the per-domain address
// dmarc+<domain id>@<shared sending domain>, which the Domains page tells customers to put in their rua= tag.
// Email Routing hands them to the Worker's email() handler → lib/inbound → handleDmarcEmail here.
//
// Reports are unauthenticated mail, so we only store rows for sending domains this install knows (customer sending
// domains + the platform domains) and dedupe on (reporter, report id). Stored per domain, per UTC day, per reporter,
// per source IP and result (dmarc_records); read back as alignment pass rates and failing sources.
import type { Env } from '../types';
import { all, one, run, stmt, batch } from './db';
import { platformHosts } from './domains';
import { id, now, DAY } from './util';
import type { MimePart } from './inbound';

// ───────── address ─────────
export function sharedDomain(env: Env): string {
  return ((env.SHARED_FROM_DOMAIN || '').trim() || (env.MAIL_FROM || '').split('@')[1] || '').toLowerCase();
}
/** The rua address for one customer sending domain (row id keeps it unguessable-ish and lets us cross-check). */
export function ruaAddress(env: Env, domainId?: string | null): string {
  return `dmarc${domainId ? '+' + domainId.toLowerCase() : ''}@${sharedDomain(env)}`;
}
/** Is this recipient one of our DMARC report addresses? Returns the domain id from dmarc+<id>@ when present.
 *  (Any host: reports are only stored for sending domains we know, so dmarc@<customer domain> routed here works too.) */
export function dmarcRecipient(rcpt: string): { domainId: string | null } | null {
  const m = /^(?:dmarc|dmarc-reports|rua)(?:\+([a-z0-9_-]+))?@[a-z0-9.-]+$/i.exec((rcpt || '').trim());
  return m ? { domainId: m[1] ? m[1].toLowerCase() : null } : null;
}

// ───────── XML ─────────
export interface DmarcRow { sourceIp: string; count: number; disposition: string; dkim: string; spf: string; headerFrom: string; dkimDomains: string[]; spfDomains: string[] }
export interface DmarcReport { org: string; reportId: string; begin: number; end: number; domain: string; policy: string; adkim: string; aspf: string; rows: DmarcRow[] }

const unxml = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
const tag = (xml: string, name: string): string => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml); return m ? unxml(m[1]) : ''; };
const block = (xml: string, name: string): string => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml); return m ? m[1] : ''; };
const blocks = (xml: string, name: string): string[] => [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi'))].map((m) => m[1]);

/** Parse an aggregate report. Returns null when it isn't one. Tolerates namespace prefixes (dmarc:record…). */
export function parseDmarcXml(input: string): DmarcReport | null {
  const xml = input.replace(/<(\/?)[A-Za-z0-9_-]+:/g, '<$1').replace(/<\?xml[^>]*\?>/, '');
  if (!/<feedback[\s>]/i.test(xml)) return null;
  const meta = block(xml, 'report_metadata');
  const pol = block(xml, 'policy_published');
  const dr = block(meta, 'date_range');
  const rows: DmarcRow[] = [];
  for (const rec of blocks(xml, 'record')) {
    const row = block(rec, 'row');
    const pe = block(row, 'policy_evaluated');
    const auth = block(rec, 'auth_results');
    rows.push({
      sourceIp: tag(row, 'source_ip') || 'unknown',
      count: Math.max(0, parseInt(tag(row, 'count'), 10) || 0),
      disposition: (tag(pe, 'disposition') || 'none').toLowerCase(),
      dkim: (tag(pe, 'dkim') || 'fail').toLowerCase() === 'pass' ? 'pass' : 'fail',
      spf: (tag(pe, 'spf') || 'fail').toLowerCase() === 'pass' ? 'pass' : 'fail',
      headerFrom: tag(block(rec, 'identifiers'), 'header_from').toLowerCase(),
      dkimDomains: blocks(auth, 'dkim').map((b) => `${tag(b, 'domain').toLowerCase()}=${tag(b, 'result').toLowerCase()}`),
      spfDomains: blocks(auth, 'spf').map((b) => `${tag(b, 'domain').toLowerCase()}=${tag(b, 'result').toLowerCase()}`),
    });
  }
  const sec = (v: string) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n * 1000 : 0; };
  return {
    org: tag(meta, 'org_name') || 'unknown', reportId: tag(meta, 'report_id') || '',
    begin: sec(tag(dr, 'begin')), end: sec(tag(dr, 'end')),
    domain: tag(pol, 'domain').toLowerCase(), policy: tag(pol, 'p').toLowerCase(), adkim: tag(pol, 'adkim') || 'r', aspf: tag(pol, 'aspf') || 'r',
    rows,
  };
}

// ───────── attachments: zip / gzip / xml ─────────
const MAX_XML = 25 * 1024 * 1024;

async function inflate(data: Uint8Array, format: 'gzip' | 'deflate-raw'): Promise<Uint8Array> {
  const ds = new DecompressionStream(format as any);
  const out = new Response(new Blob([data]).stream().pipeThrough(ds));
  const buf = new Uint8Array(await out.arrayBuffer());
  if (buf.length > MAX_XML) throw new Error('report too large');
  return buf;
}

/** Extract the files of a .zip (stored or deflated), using the central directory (works with data descriptors). */
export async function unzip(data: Uint8Array): Promise<Array<{ name: string; data: Uint8Array }>> {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files: Array<{ name: string; data: Uint8Array }> = [];
  for (let n = 0; n < count && p + 46 <= data.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(data.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (dv.getUint32(local, true) !== 0x04034b50) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = data.subarray(start, start + csize);
    if (name.endsWith('/')) continue;
    if (method === 0) files.push({ name, data: raw });
    else if (method === 8) files.push({ name, data: await inflate(raw, 'deflate-raw') });
  }
  return files;
}

function b64bytes(s: string): Uint8Array {
  const bin = atob(s.replace(/[^A-Za-z0-9+/=]/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Turn a file's bytes into XML text, unpacking zip / gzip by magic number. */
export async function filesToXml(data: Uint8Array): Promise<string[]> {
  if (data.length > 3 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
    const out: string[] = [];
    for (const f of await unzip(data)) out.push(...(await filesToXml(f.data)));
    return out;
  }
  if (data.length > 2 && data[0] === 0x1f && data[1] === 0x8b) return filesToXml(await inflate(data, 'gzip'));
  const text = new TextDecoder().decode(data);
  return /<feedback[\s>]/i.test(text.replace(/<(\/?)[A-Za-z0-9_-]+:/g, '<$1')) ? [text] : [];
}

/** Every aggregate report in a parsed inbound message (attachments of any common type, or an inline XML body). */
export async function reportsFromMime(root: MimePart): Promise<DmarcReport[]> {
  const out: DmarcReport[] = [];
  const visit = async (p: MimePart) => {
    for (const c of p.parts) await visit(c);
    if (p.parts.length) return;
    const name = (p.params.name || /filename\*?="?([^";]+)/i.exec(p.headers['content-disposition'] || '')?.[1] || '').toLowerCase();
    const looks = /zip|gzip|x-gzip|xml|octet-stream/.test(p.type) || /\.(zip|gz|xml)$/.test(name);
    if (!looks) return;
    let bytes: Uint8Array;
    if (p.rawBody != null && (p.headers['content-transfer-encoding'] || '').toLowerCase() === 'base64') bytes = b64bytes(p.rawBody);
    else bytes = new TextEncoder().encode(p.body);
    try {
      for (const xml of await filesToXml(bytes)) { const r = parseDmarcXml(xml); if (r) out.push(r); }
    } catch { /* corrupt attachment: skip */ }
  };
  await visit(root);
  return out;
}

// ───────── storage ─────────
/** Sending domains this install knows → { workspace, pub } (null = platform domain). */
async function knownDomain(env: Env, domain: string): Promise<{ id: string | null; pubId: string | null } | null> {
  if (!domain) return null;
  if (platformHosts(env).includes(domain)) return { id: null, pubId: null };
  const d = await one<any>(env, `SELECT id, pub_id FROM domains WHERE hostname = ? AND kind = 'email'`, domain);
  return d ? { id: d.id, pubId: d.pub_id } : null;
}

export interface StoreResult { stored: number; skipped: string[] }

export async function storeReport(env: Env, r: DmarcReport, rcpt: string, domainId: string | null): Promise<'stored' | 'duplicate' | 'unknown_domain' | 'mismatch'> {
  const known = await knownDomain(env, r.domain);
  if (!known) return 'unknown_domain';
  if (domainId && known.id && known.id.toLowerCase() !== domainId) return 'mismatch';
  const rid = r.reportId || `${r.begin}-${r.end}-${r.domain}`;
  const exists = await one(env, 'SELECT 1 FROM dmarc_reports WHERE org = ? AND report_id = ?', r.org, rid);
  if (exists) return 'duplicate';
  const messages = r.rows.reduce((a, x) => a + x.count, 0);
  const day = new Date(r.begin || now()).toISOString().slice(0, 10);
  const stmts = [stmt(env, `INSERT OR IGNORE INTO dmarc_reports (id, org, report_id, domain, policy, begin_at, end_at, messages, rcpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id(), r.org.slice(0, 200), rid.slice(0, 200), r.domain, r.policy || null, r.begin || null, r.end || null, messages, rcpt.slice(0, 200), now())];
  for (const x of r.rows) {
    if (!x.count) continue;
    stmts.push(stmt(env, `INSERT INTO dmarc_records (domain, day, reporter, source_ip, header_from, dkim, spf, disposition, count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain, day, reporter, source_ip, header_from, dkim, spf, disposition) DO UPDATE SET count = count + excluded.count`,
      r.domain, day, r.org.slice(0, 200), x.sourceIp.slice(0, 64), (x.headerFrom || r.domain).slice(0, 253), x.dkim, x.spf, x.disposition.slice(0, 20), x.count));
  }
  await batch(env, stmts);
  return 'stored';
}

/** Called by lib/inbound for mail to a DMARC report address. */
export async function handleDmarcEmail(env: Env, root: MimePart, rcpt: string, domainId: string | null): Promise<{ processed: number; results: string[] }> {
  const reports = await reportsFromMime(root);
  const results: string[] = [];
  let n = 0;
  for (const r of reports) {
    const res = await storeReport(env, r, rcpt, domainId);
    results.push(`${r.org}/${r.domain}: ${res}`);
    if (res === 'stored') n++;
  }
  return { processed: n, results };
}

// ───────── reading ─────────
const dayStr = (t: number) => new Date(t).toISOString().slice(0, 10);

export interface AuthSummary {
  messages: number; dmarcPass: number; dkimPass: number; spfPass: number;
  passRate: number | null; dkimRate: number | null; spfRate: number | null;
  reports: number; lastReportAt: number | null;
  byReporter: Array<{ reporter: string; messages: number; pass: number }>;
  failing: Array<{ domain: string; source_ip: string; reporter: string; header_from: string; dkim: string; spf: string; disposition: string; messages: number }>;
  daily: Array<{ day: string; messages: number; pass: number }>;
}

/** Alignment pass rates for these domains over [from, to]. DMARC passes when aligned DKIM or aligned SPF passes. */
export async function authSummary(env: Env, domains: string[], from: number, to = now()): Promise<AuthSummary> {
  const empty: AuthSummary = { messages: 0, dmarcPass: 0, dkimPass: 0, spfPass: 0, passRate: null, dkimRate: null, spfRate: null, reports: 0, lastReportAt: null, byReporter: [], failing: [], daily: [] };
  if (!domains.length) return empty;
  const ph = domains.map(() => '?').join(',');
  const f = dayStr(from), t = dayStr(to);
  const tot = await one<any>(env, `SELECT SUM(count) AS m, SUM(CASE WHEN dkim = 'pass' OR spf = 'pass' THEN count ELSE 0 END) AS p,
      SUM(CASE WHEN dkim = 'pass' THEN count ELSE 0 END) AS dk, SUM(CASE WHEN spf = 'pass' THEN count ELSE 0 END) AS sp
    FROM dmarc_records WHERE domain IN (${ph}) AND day BETWEEN ? AND ?`, ...domains, f, t).catch(() => null);
  const messages = Number(tot?.m || 0);
  if (!messages) {
    const rep = await one<any>(env, `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM dmarc_reports WHERE domain IN (${ph})`, ...domains).catch(() => null);
    return { ...empty, reports: Number(rep?.n || 0), lastReportAt: rep?.last || null };
  }
  const [byReporter, failing, daily, rep] = await Promise.all([
    all<any>(env, `SELECT reporter, SUM(count) AS messages, SUM(CASE WHEN dkim = 'pass' OR spf = 'pass' THEN count ELSE 0 END) AS pass FROM dmarc_records WHERE domain IN (${ph}) AND day BETWEEN ? AND ? GROUP BY reporter ORDER BY messages DESC LIMIT 20`, ...domains, f, t),
    all<any>(env, `SELECT domain, source_ip, reporter, header_from, dkim, spf, disposition, SUM(count) AS messages FROM dmarc_records WHERE domain IN (${ph}) AND day BETWEEN ? AND ? AND dkim = 'fail' AND spf = 'fail' GROUP BY domain, source_ip, reporter, header_from, dkim, spf, disposition ORDER BY messages DESC LIMIT 25`, ...domains, f, t),
    all<any>(env, `SELECT day, SUM(count) AS messages, SUM(CASE WHEN dkim = 'pass' OR spf = 'pass' THEN count ELSE 0 END) AS pass FROM dmarc_records WHERE domain IN (${ph}) AND day BETWEEN ? AND ? GROUP BY day ORDER BY day`, ...domains, f, t),
    one<any>(env, `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM dmarc_reports WHERE domain IN (${ph}) AND COALESCE(begin_at, created_at) >= ?`, ...domains, from - DAY),
  ]);
  const p = Number(tot?.p || 0), dk = Number(tot?.dk || 0), sp = Number(tot?.sp || 0);
  return {
    messages, dmarcPass: p, dkimPass: dk, spfPass: sp, passRate: p / messages, dkimRate: dk / messages, spfRate: sp / messages,
    reports: Number(rep?.n || 0), lastReportAt: rep?.last || null,
    byReporter: byReporter.map((x) => ({ reporter: x.reporter, messages: Number(x.messages), pass: Number(x.pass) })),
    failing: failing.map((x) => ({ ...x, messages: Number(x.messages) })),
    daily: daily.map((x) => ({ day: x.day, messages: Number(x.messages), pass: Number(x.pass) })),
  };
}

/** Sending domains of a publication (custom email domains) — used for its auth pass rate. */
export async function pubSendingDomains(env: Env, pubId: string): Promise<string[]> {
  return (await all<{ hostname: string }>(env, `SELECT hostname FROM domains WHERE pub_id = ? AND kind = 'email'`, pubId)).map((d) => d.hostname);
}

/** Per-domain pass rate for the last `days` (Guardian + platform view). */
export async function domainPassRates(env: Env, days = 3): Promise<Array<{ domain: string; messages: number; pass: number }>> {
  return (await all<any>(env, `SELECT domain, SUM(count) AS messages, SUM(CASE WHEN dkim = 'pass' OR spf = 'pass' THEN count ELSE 0 END) AS pass FROM dmarc_records WHERE day >= ? GROUP BY domain`, dayStr(now() - days * DAY)).catch(() => []))
    .map((x) => ({ domain: x.domain, messages: Number(x.messages), pass: Number(x.pass) }));
}

export async function pruneDmarc(env: Env) {
  await run(env, 'DELETE FROM dmarc_records WHERE day < ?', dayStr(now() - 400 * DAY)).catch(() => {});
}
