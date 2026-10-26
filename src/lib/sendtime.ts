// Send timing for newsletters:
// - Send-time optimization ("sto"): each subscriber gets the email at the hour they usually open (from their historical
//   opens), within 24 hours of the send starting; no history → the publication's best hour.
// - Delivery by time zone ("timezone"): each subscriber gets it at a chosen local time (e.g. 09:00) in their own time zone
//   (subscribers.timezone from Cloudflare request.cf.timezone; fallback to the publication's time zone).
// sender.ts parks every recipient as a 'scheduled' delivery with next_attempt_at = planned time, then hands due ones to the
// normal sending path (plan limits, warm-up, new-account ramp, campaign auto-pause all still apply).
import type { Env, Publication, Subscriber } from '../types';
import { all } from './db';
import { validTimezone } from './subscribers';
import { HOUR, MIN, DAY } from './util';

export interface SendTiming { mode: 'sto' | 'timezone'; local_time?: string; planned?: boolean; from?: number }

export function normalizeTiming(t: any): SendTiming | null {
  if (!t || typeof t !== 'object') return null;
  if (t.mode === 'sto') return { mode: 'sto' };
  if (t.mode === 'timezone') {
    const m = String(t.local_time || '09:00').match(/^(\d{1,2}):(\d{2})$/);
    const hh = m ? Math.min(23, Number(m[1])) : 9, mm = m ? Math.min(59, Number(m[2])) : 0;
    return { mode: 'timezone', local_time: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` };
  }
  return null;
}

export function describeTiming(t: SendTiming | null): string {
  if (!t) return 'All at once';
  return t.mode === 'sto' ? 'Send-time optimization (each subscriber’s usual open hour, within 24h)' : `${t.local_time} in each subscriber’s time zone`;
}

/** Offset of `tz` from UTC at instant `at`, in ms (local − UTC). */
export function tzOffsetMs(tz: string, at: number): number {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
    return Math.round((asUtc - at) / MIN) * MIN;
  } catch { return 0; }
}

/** Next instant (≥ from − 1 minute) when the wall clock in `tz` shows hh:mm. Always within ~24h of `from`. */
export function nextLocalTime(tz: string, hh: number, mm: number, from: number): number {
  const zone = validTimezone(tz) ? tz : 'UTC';
  const local = new Date(from + tzOffsetMs(zone, from));
  for (let k = 0; k < 3; k++) {
    const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + k, hh, mm);
    let at = wall - tzOffsetMs(zone, wall);
    at = wall - tzOffsetMs(zone, at); // second pass settles DST transitions
    if (at >= from - MIN) return at;
  }
  return from;
}

/** Next instant at UTC hour `h` (+ minute offset) at or after `from`. */
export function nextUtcHour(h: number, from: number, minute = 0): number {
  const d = new Date(from);
  let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, minute);
  if (at < from - MIN) {
    // this hour already started: if we're still inside it, send now; otherwise tomorrow
    if (d.getUTCHours() === h) return from;
    at += DAY;
  }
  return at;
}

/** Most common UTC open hour per subscriber (human opens, last 180 days). */
export async function bestHours(env: Env, subIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!subIds.length) return out;
  const rows = await all<{ sid: string; h: number; n: number }>(env,
    `SELECT d.subscriber_id AS sid, CAST((o.created_at / ${HOUR}) % 24 AS INTEGER) AS h, COUNT(*) AS n
     FROM deliveries d JOIN opens o ON o.delivery_id = d.id
     WHERE d.subscriber_id IN (${subIds.map(() => '?').join(',')}) AND o.is_bot = 0 AND o.created_at > ?
     GROUP BY d.subscriber_id, h`, ...subIds, Date.now() - 180 * DAY);
  const best = new Map<string, { h: number; n: number }>();
  for (const r of rows) { const b = best.get(r.sid); if (!b || r.n > b.n) best.set(r.sid, { h: r.h, n: r.n }); }
  for (const [sid, b] of best) out.set(sid, b.h);
  return out;
}

/** The publication's best UTC open hour (last 90 days), or 09:00 in its time zone when there is no history. */
export async function pubBestHour(env: Env, pub: Publication): Promise<number> {
  const rows = await all<{ h: number; n: number }>(env, `SELECT CAST((created_at / ${HOUR}) % 24 AS INTEGER) AS h, COUNT(*) AS n FROM opens WHERE pub_id = ? AND is_bot = 0 AND created_at > ? GROUP BY h ORDER BY n DESC LIMIT 1`, pub.id, Date.now() - 90 * DAY);
  if (rows[0]?.n >= 5) return rows[0].h;
  return new Date(nextLocalTime(pub.timezone || 'UTC', 9, 0, Date.now())).getUTCHours();
}

/** Small, stable spread inside the hour so a big list doesn't all land on minute 0. */
function spread(sid: string, maxMin = 40): number {
  let h = 0;
  for (let i = 0; i < sid.length; i++) h = (h * 31 + sid.charCodeAt(i)) >>> 0;
  return h % maxMin;
}

/** Planned delivery time per subscriber (ms). */
export async function planTimes(env: Env, pub: Publication, subs: Subscriber[], timing: SendTiming, from: number, fallbackHour?: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (timing.mode === 'timezone') {
    const [hh, mm] = (timing.local_time || '09:00').split(':').map(Number);
    for (const s of subs) {
      const tz = (s as any).timezone && validTimezone((s as any).timezone) ? (s as any).timezone : pub.timezone || 'UTC';
      out.set(s.id, nextLocalTime(tz, hh || 0, mm || 0, from));
    }
    return out;
  }
  const hours = await bestHours(env, subs.map((s) => s.id));
  const fb = fallbackHour ?? (await pubBestHour(env, pub));
  for (const s of subs) out.set(s.id, nextUtcHour(hours.get(s.id) ?? fb, from, spread(s.id)));
  return out;
}
