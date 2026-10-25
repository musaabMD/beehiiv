// Small shared helpers. No imports from other lib files (keeps dependency graph flat).

const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyz';

export function id(len = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const b of bytes) s += ALPHA[b % 36];
  return s;
}

export function token(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return b64url(b);
}

export function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

export async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}

/** Constant-time string comparison (timing-attack safe). */
export function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const now = () => Date.now();
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export function slugify(s: string, max = 80): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max) || id(6)
  );
}

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function stripTags(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

export function parseJSON<T = any>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function money(cents: number, currency = 'usd'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format((cents || 0) / 100);
  } catch {
    return `$${((cents || 0) / 100).toFixed(2)}`;
  }
}

export function num(n: number): string {
  return new Intl.NumberFormat('en-US').format(n || 0);
}

export function pct(part: number, whole: number, digits = 1): string {
  if (!whole) return '0%';
  return ((part / whole) * 100).toFixed(digits) + '%';
}

export function fmtDate(ms: number | null | undefined, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }, tz = 'UTC'): string {
  if (!ms) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

export function fmtDateTime(ms: number | null | undefined, tz = 'UTC'): string {
  return fmtDate(ms, { dateStyle: 'medium', timeStyle: 'short' }, tz);
}

export function ago(ms: number | null | undefined): string {
  if (!ms) return 'never';
  const d = Date.now() - ms;
  const f = (n: number, u: string) => `${Math.floor(n)}${u} ago`;
  if (d < MIN) return 'just now';
  if (d < HOUR) return f(d / MIN, 'm');
  if (d < DAY) return f(d / HOUR, 'h');
  if (d < 30 * DAY) return f(d / DAY, 'd');
  return fmtDate(ms);
}

/** datetime-local input value <-> ms (interpreted as UTC offset-less local of given tz is complex; we use the browser-provided ISO with offset when available). */
export function toInputDateTime(ms: number | null | undefined): string {
  if (!ms) return '';
  return new Date(ms).toISOString().slice(0, 16);
}
export function fromInputDateTime(s: string | undefined | null, tzOffsetMin = 0): number | null {
  if (!s) return null;
  const t = Date.parse(s.length === 16 ? s + ':00Z' : s);
  return isNaN(t) ? null : t + tzOffsetMin * MIN;
}

export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

/** Parse a CSV string (RFC 4180-ish). */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

export function toCSV(rows: unknown[][]): string {
  return rows
    .map((r) => r.map((v) => {
      const s = v == null ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','))
    .join('\n');
}

/** Read a form body into a plain object; repeated keys become arrays when key ends with []. */
export async function form(req: Request | { parseBody: (o?: any) => Promise<any> }): Promise<Record<string, any>> {
  const body = await (req as any).parseBody({ all: true });
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k.endsWith('[]')) out[k.slice(0, -2)] = Array.isArray(v) ? v : [v];
    else out[k] = Array.isArray(v) ? v[v.length - 1] : v;
  }
  return out;
}

export function str(v: unknown, max = 10_000): string {
  return (typeof v === 'string' ? v : v == null ? '' : String(v)).trim().slice(0, max);
}
export function int(v: unknown, def = 0): number {
  const n = parseInt(String(v ?? ''), 10);
  return isNaN(n) ? def : n;
}
export function cents(v: unknown): number {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));
  return isNaN(n) ? 0 : Math.round(n * 100);
}
export function bool(v: unknown): boolean {
  return v === true || v === 'on' || v === '1' || v === 'true' || v === 1;
}

export function domainOf(email: string): string {
  return (email.split('@')[1] || '').toLowerCase();
}

export function mailboxProvider(email: string): string {
  const d = domainOf(email);
  if (/^(gmail|googlemail)\.com$/.test(d)) return 'gmail';
  if (/^(outlook|hotmail|live|msn)\.[a-z.]+$/.test(d)) return 'outlook';
  if (/^(yahoo|ymail|rocketmail|aol)\.[a-z.]+$/.test(d)) return 'yahoo';
  if (/^(icloud|me|mac)\.com$/.test(d)) return 'apple';
  if (/^(proton|protonmail)\.(me|com|ch)$/.test(d)) return 'proton';
  return 'other';
}

export function parseUA(ua: string | null | undefined): { device: string; os: string; browser: string } {
  const u = ua || '';
  const device = /ipad|tablet/i.test(u) ? 'tablet' : /mobi|iphone|android/i.test(u) ? 'mobile' : 'desktop';
  const os = /windows/i.test(u) ? 'Windows' : /iphone|ipad|ios/i.test(u) ? 'iOS' : /mac os/i.test(u) ? 'macOS' : /android/i.test(u) ? 'Android' : /linux/i.test(u) ? 'Linux' : 'Other';
  const browser = /edg\//i.test(u) ? 'Edge' : /chrome|crios/i.test(u) ? 'Chrome' : /firefox|fxios/i.test(u) ? 'Firefox' : /safari/i.test(u) ? 'Safari' : 'Other';
  return { device, os, browser };
}

export function qs(params: Record<string, string | number | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? '?' + s : '';
}
