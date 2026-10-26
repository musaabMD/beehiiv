/** @jsxImportSource hono/jsx */
// Subscriber intelligence on the dashboard: anomaly alerts, "Suggested next steps", one-click preset segments.
import type { App, Ctx } from '../../types';
import { insert } from '../../lib/db';
import { requirePerm, audit } from '../../lib/auth';
import { back, Card, LinkBtn } from '../../ui/components';
import { activeAnomalies, dismissAnomaly, checkPublication } from '../../lib/anomalies';
import { SEGMENT_PRESETS, type Suggestion } from '../../lib/nextaction';
import { recalcSegment } from '../../lib/segments';
import { id, now, ago, form, str, int } from '../../lib/util';
import '../../lib/signals';
import '../../lib/predict';

type Anom = Awaited<ReturnType<typeof activeAnomalies>>[number];

/** Dismissible anomaly alerts (dashboard home + Analytics overview). */
export function AnomalyAlerts(p: { items: Anom[]; back: string }) {
  if (!p.items.length) return null;
  return (
    <div class="anoms" data-anomalies>
      {p.items.map((a) => (
        <div class={`callout anom ${a.severity === 'critical' ? 'danger' : a.severity === 'good' ? 'ok' : 'warn'}`} data-anomaly={a.metric}>
          <strong>{a.severity === 'good' ? '▲' : '⚠'}</strong>
          <div class="grow">{a.message} {a.href && <a href={a.href}>Look into it →</a>} <span class="small" style="opacity:.7">· {ago(a.created_at)}</span></div>
          <form method="post" action={`/app/anomalies/${a.id}/dismiss`}><input type="hidden" name="back" value={p.back} /><button class="anom-x" title="Dismiss" aria-label="Dismiss alert">✕</button></form>
        </div>
      ))}
    </div>
  );
}

function ActionBtn(p: { a: Suggestion['action'] }) {
  if (p.a.method === 'post')
    return (
      <form method="post" action={p.a.href} class="inline-form">
        {Object.entries(p.a.fields || {}).map(([k, v]) => <input type="hidden" name={k} value={v} />)}
        <button class="btn btn-secondary btn-sm" data-confirm={p.a.confirm}>{p.a.label} →</button>
      </form>
    );
  return <LinkBtn href={p.a.href} small kind="secondary">{p.a.label} →</LinkBtn>;
}

/** "Suggested next steps" card for the dashboard home. */
export function NextSteps(p: { items: Suggestion[] }) {
  if (!p.items.length) return null;
  return (
    <Card title="Suggested next steps" id="next-steps">
      <ul class="nba">
        {p.items.map((s) => (
          <li data-suggestion={s.key}>
            <span class="ni" aria-hidden="true">{s.icon}</span>
            <div class="grow" style="min-width:0">
              <div class="nt">{s.title}</div>
              <div class="nb">{s.body}</div>
              <ActionBtn a={s.action} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const safeBack = (v: unknown, def: string) => { const s = str(v, 300); return s.startsWith('/app') ? s : def; };

export function registerIntel(dash: App) {
  dash.post('/anomalies/:id/dismiss', requirePerm('manage'), async (c) => {
    const f = await form(c.req);
    await dismissAnomaly(c.env, c.get('pub').id, c.req.param('id'));
    return back(c, safeBack(f.back, '/app'), 'Alert dismissed');
  });

  dash.post('/analytics/anomalies/check', requirePerm('manage'), async (c) => {
    const f = await form(c.req);
    const n = await checkPublication(c.env, c.get('pub'));
    return back(c, safeBack(f.back, '/app/analytics'), n ? `${n} new anomal${n === 1 ? 'y' : 'ies'} found` : 'Nothing unusual in the last 24 hours');
  });

  // One-click ready-made segments (Suggested next steps, Top subscribers).
  dash.post('/intel/segment', requirePerm('manage'), async (c: Ctx) => {
    const f = await form(c.req);
    const key = str(f.preset, 40);
    const p = SEGMENT_PRESETS[key];
    if (!p) return back(c, '/app', 'Unknown segment', 'err');
    const arg = f.arg !== undefined ? int(f.arg, 3) : undefined;
    const sid = id();
    const name = key === 'near_referral' ? `${p.name} (${arg})` : p.name;
    await insert(c.env, 'segments', { id: sid, pub_id: c.get('pub').id, name: `${name} · ${new Date().toISOString().slice(0, 10)}`, description: p.description, kind: 'dynamic', rules: JSON.stringify(p.rules(arg)), created_at: now() });
    await recalcSegment(c.env, c.get('pub').id, sid);
    await audit(c, 'segment.create', sid, { preset: key });
    return back(c, `/app/audience/segments/${sid}`, 'Segment created — send to it, or use it in an automation');
  });
}
