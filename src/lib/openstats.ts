// Numbers for the public deliverability page (/open), computed from this install's own send records.
// Counted: every real send (issues, automation steps, welcome/confirmation and other transactional mail).
// Left out: test sends. Delivery rate = delivered / (delivered + hard bounced); bounce and complaint
// rates are out of emails sent. Open/click rates are medians across publications with enough mail.
import type { Env } from '../types';
import { all, one } from './db';

const DAY = 86_400_000;
export const MIN_EMAILS = 500;      // below this the page says "not enough email yet"
const MIN_PUB_DELIVERED = 200;      // a publication needs this many delivered to count in the medians

export interface Week { start: number; sent: number; delivered: number; hard: number; complaints: number; opened: number; clicked: number }
export interface OpenStats {
  from: number; to: number;
  sent: number; delivered: number; hard: number; soft: number; complaints: number;
  deliveryRate: number | null; hardRate: number | null; complaintRate: number | null;
  medianOpen: number | null; medianClick: number | null; pubsCounted: number;
  weeks: Week[];
  rejections: Record<string, number>;
  suppressed: number;
  simulated: boolean;
  enough: boolean;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Monday 00:00 UTC of the week containing t
const weekStart = (t: number) => { const d = new Date(t); const day = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day); };

export async function openStats(env: Env, now = Date.now()): Promise<OpenStats> {
  const from = now - 30 * DAY;
  const real = `d.send_id NOT IN (SELECT id FROM sends WHERE kind = 'test')`;
  const tot = await one<any>(env, `
    SELECT COUNT(*) AS sent,
      SUM(CASE WHEN d.status IN ('sent','complained') THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN d.status = 'bounced' AND d.bounce_type = 'hard' THEN 1 ELSE 0 END) AS hard,
      SUM(CASE WHEN d.status = 'bounced' AND COALESCE(d.bounce_type,'') <> 'hard' THEN 1 ELSE 0 END) AS soft,
      SUM(CASE WHEN d.status = 'complained' THEN 1 ELSE 0 END) AS complaints
    FROM deliveries d WHERE d.created_at >= ? AND d.status NOT IN ('queued','suppressed') AND ${real}`, from);
  const sent = Number(tot?.sent || 0), delivered = Number(tot?.delivered || 0), hard = Number(tot?.hard || 0);
  const complaints = Number(tot?.complaints || 0), soft = Number(tot?.soft || 0);

  // Weekly track record, last 12 weeks
  const wFrom = weekStart(now) - 11 * 7 * DAY;
  const rows = await all<any>(env, `
    SELECT CAST((d.created_at - ?) / ? AS INTEGER) AS w, COUNT(*) AS sent,
      SUM(CASE WHEN d.status IN ('sent','complained') THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN d.status = 'bounced' AND d.bounce_type = 'hard' THEN 1 ELSE 0 END) AS hard,
      SUM(CASE WHEN d.status = 'complained' THEN 1 ELSE 0 END) AS complaints,
      SUM(CASE WHEN d.status IN ('sent','complained') AND d.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
      SUM(CASE WHEN d.status IN ('sent','complained') AND d.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked
    FROM deliveries d WHERE d.created_at >= ? AND d.status NOT IN ('queued','suppressed') AND ${real} GROUP BY w`, wFrom, 7 * DAY, wFrom);
  const weeks: Week[] = Array.from({ length: 12 }, (_, i) => ({ start: wFrom + i * 7 * DAY, sent: 0, delivered: 0, hard: 0, complaints: 0, opened: 0, clicked: 0 }));
  for (const r of rows) {
    const w = weeks[Number(r.w)]; if (!w) continue;
    for (const k of ['sent', 'delivered', 'hard', 'complaints', 'opened', 'clicked'] as const) w[k] = Number(r[k] || 0);
  }

  // Medians across publications (so one big sender can't move them)
  const pubs = await all<any>(env, `
    SELECT d.pub_id, SUM(CASE WHEN d.status IN ('sent','complained') THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN d.status IN ('sent','complained') AND d.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
      SUM(CASE WHEN d.status IN ('sent','complained') AND d.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked
    FROM deliveries d WHERE d.created_at >= ? AND ${real} GROUP BY d.pub_id`, from);
  const counted = pubs.filter((p) => Number(p.delivered) >= MIN_PUB_DELIVERED);

  const rej = await all<any>(env, `SELECT reason, SUM(count) AS n FROM email_rejections WHERE day >= ? GROUP BY reason`, new Date(from).toISOString().slice(0, 10)).catch(() => []);
  const suppressed = Number((await one<any>(env, `SELECT COUNT(*) AS n FROM suppressions WHERE created_at >= ?`, from))?.n || 0);

  return {
    from, to: now, sent, delivered, hard, soft, complaints,
    deliveryRate: delivered + hard ? delivered / (delivered + hard) : null,
    hardRate: sent ? hard / sent : null,
    complaintRate: sent ? complaints / sent : null,
    medianOpen: median(counted.map((p) => p.opened / p.delivered)),
    medianClick: median(counted.map((p) => p.clicked / p.delivered)),
    pubsCounted: counted.length,
    weeks,
    rejections: Object.fromEntries(rej.map((r) => [r.reason, Number(r.n)])),
    suppressed,
    simulated: env.EMAIL_MODE === 'simulate' || !env.EMAIL,
    enough: sent >= MIN_EMAILS,
  };
}
