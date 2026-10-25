// Timezone helpers (Intl-based, no deps).
export function tzOffsetMs(tz: string, t: number): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t));
    const g = (k: string) => Number(parts.find((p) => p.type === k)?.value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second')) - Math.floor(t / 1000) * 1000;
  } catch {
    return 0;
  }
}

/** "YYYY-MM-DDTHH:mm" wall-clock time in `tz` → UTC ms. */
export function zonedToUtc(local: string, tz: string): number | null {
  const guess = Date.parse((local.length === 16 ? local + ':00' : local) + 'Z');
  if (isNaN(guess)) return null;
  let t = guess - tzOffsetMs(tz, guess);
  t = guess - tzOffsetMs(tz, t); // second pass for DST edges
  return t;
}

/** UTC ms → "YYYY-MM-DDTHH:mm" wall-clock in `tz` (for datetime-local inputs). */
export function utcToZoned(t: number | null | undefined, tz: string): string {
  if (!t) return '';
  return new Date(t + tzOffsetMs(tz, t)).toISOString().slice(0, 16);
}

export function timezones(): string[] {
  try {
    const list = (Intl as any).supportedValuesOf?.('timeZone') as string[] | undefined;
    if (list?.length) return list.includes('UTC') ? list : ['UTC', ...list];
  } catch {}
  return ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'America/Sao_Paulo', 'America/Mexico_City', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Zurich', 'Europe/Istanbul', 'Africa/Cairo', 'Africa/Lagos', 'Asia/Dubai', 'Asia/Riyadh', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland'];
}

export function tzLabel(tz: string, t = Date.now()): string {
  const off = tzOffsetMs(tz, t) / 60000;
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${tz.replace(/_/g, ' ')} (GMT${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')})`;
}
