/** @jsxImportSource hono/jsx */
import type { Child } from 'hono/jsx';
import type { Ctx } from '../../types';
import { PRESETS, delta, METRICS, type Filter, type Range } from '../../lib/analytics';
import { Stat } from '../../ui/components';
import { num, money } from '../../lib/util';

export const fmtPct = (n: number, d = 1) => `${(n || 0).toFixed(d)}%`;
export const fmtNum = (n: number) => num(Math.round(n || 0));
export const fmtUsd = (c: number) => money(c || 0, 'usd');

/** Date range picker (GET form). Preserves other query params passed in `keep`. */
export function RangeBar(p: { c: Ctx; range: Range; keep?: string[]; children?: Child }) {
  const q = p.c.req.query();
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return (
    <form method="get" class="row" style="margin-bottom:16px">
      {(p.keep || []).flatMap((k) => p.c.req.queries(k) || []).length > 0 &&
        (p.keep || []).flatMap((k) => (p.c.req.queries(k) || []).map((v) => <input type="hidden" name={k} value={v} />))}
      <select class="input" name="range" style="width:auto" data-autosubmit="1">
        {PRESETS.map(([k, l]) => <option value={k} selected={p.range.key === k}>{l}</option>)}
        {p.range.key === 'custom' && <option value="custom" selected>Custom</option>}
      </select>
      <details class="range-custom">
        <summary class="btn btn-ghost btn-sm">Custom dates</summary>
        <div class="row" style="margin-top:6px">
          <input class="input" type="date" name="from" value={q.from || iso(p.range.from)} style="width:auto" />
          <span class="muted">to</span>
          <input class="input" type="date" name="to" value={q.to || iso(p.range.to)} style="width:auto" />
          <button class="btn btn-secondary btn-sm">Apply</button>
        </div>
      </details>
      {p.range.key !== 'all' && <span class="muted small">Compared with the previous {Math.max(1, Math.round((p.range.to - p.range.from) / 86400000))} days</span>}
      <span class="grow" />
      {p.children}
    </form>
  );
}

/** KPI tile with % change vs previous period. `invert` = lower is better (unsubs, bounces). */
export function Kpi(p: { label: string; cur: number; prev?: number; fmt?: (n: number) => string; invert?: boolean; href?: string; sub?: Child; points?: boolean }) {
  const f = p.fmt || fmtNum;
  let sub: Child = p.sub;
  let tone = '';
  if (p.prev !== undefined) {
    const d = p.points ? p.cur - p.prev : delta(p.cur, p.prev);
    if (d === null) sub = <span class="kpi-d up">new</span>;
    else {
      const good = p.invert ? d <= 0 : d >= 0;
      tone = Math.abs(d) < 0.05 ? '' : good ? 'up' : 'down';
      sub = (
        <span class={`kpi-d ${tone}`} title={`Previous period: ${f(p.prev)}`}>
          {d > 0 ? '▲' : d < 0 ? '▼' : '•'} {Math.abs(d).toFixed(1)}{p.points ? ' pts' : '%'} <span class="muted">vs prev</span>
        </span>
      );
    }
  }
  return <Stat label={p.label} value={f(p.cur)} sub={sub} href={p.href} />;
}

export function qsWith(c: Ctx, patch: Record<string, string | null>): string {
  const u = new URL(c.req.url);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) u.searchParams.delete(k);
    else u.searchParams.set(k, v);
  }
  return u.pathname + (u.search || '');
}

// ───────── custom conditions (filter chips) ─────────
const OPS: Array<[Filter['op'], string]> = [['eq', 'is'], ['neq', 'is not'], ['contains', 'contains'], ['not_contains', "doesn't contain"]];

export function parseFilters(c: Ctx, metric: string): Filter[] {
  const def = METRICS[metric];
  const out: Filter[] = [];
  for (const raw of c.req.queries('f') || []) {
    const [field, op, ...rest] = raw.split(':');
    const value = rest.join(':');
    if (def?.dims[field] && OPS.some(([o]) => o === op) && value) out.push({ field, op: op as Filter['op'], value });
  }
  // shorthand single-dimension filters (?country=US&device=mobile)
  for (const k of Object.keys(def?.dims || {})) {
    const v = c.req.query(k);
    if (v) out.push({ field: k, op: 'eq', value: v });
  }
  return out;
}

export function FilterChips(p: { c: Ctx; metric: string; filters: Filter[]; keep?: string[] }) {
  const def = METRICS[p.metric];
  const raw = p.c.req.queries('f') || [];
  const base = new URL(p.c.req.url);
  const removeHref = (i: number) => {
    const u = new URL(base);
    u.searchParams.delete('f');
    raw.filter((_, j) => j !== i).forEach((x) => u.searchParams.append('f', x));
    for (const k of Object.keys(def.dims)) u.searchParams.delete(k);
    return u.pathname + u.search;
  };
  const keep = [...base.searchParams.entries()].filter(([k]) => k !== 'f' && !def.dims[k]);
  return (
    <div class="chips">
      {raw.map((x, i) => {
        const [field, op, ...rest] = x.split(':');
        if (!def.dims[field]) return null;
        return (
          <span class="chip">
            <strong>{def.dims[field][0]}</strong> {OPS.find(([o]) => o === op)?.[1] || op} <em>{rest.join(':')}</em>
            <a href={removeHref(i)} aria-label="Remove filter">✕</a>
          </span>
        );
      })}
      <details class="chip-add">
        <summary class="btn btn-ghost btn-sm">+ Add condition</summary>
        <form method="get" class="row chip-form">
          {keep.map(([k, v]) => <input type="hidden" name={k} value={v} />)}
          {raw.map((x) => <input type="hidden" name="f" value={x} />)}
          <select class="input" name="_field" style="width:auto">{Object.entries(def.dims).map(([k, [l]]) => <option value={k}>{l}</option>)}</select>
          <select class="input" name="_op" style="width:auto">{OPS.map(([o, l]) => <option value={o}>{l}</option>)}</select>
          <input class="input" name="_value" placeholder="value (e.g. US, mobile, twitter)" style="width:220px" required />
          <button class="btn btn-secondary btn-sm">Apply</button>
        </form>
      </details>
    </div>
  );
}

/** Merge the chip form's _field/_op/_value into f= before parsing (call at the top of a handler). */
export function normalizeChipQuery(c: Ctx): string | null {
  const f = c.req.query('_field'), op = c.req.query('_op'), v = c.req.query('_value');
  if (!f || !op || !v) return null;
  const u = new URL(c.req.url);
  u.searchParams.delete('_field'); u.searchParams.delete('_op'); u.searchParams.delete('_value');
  u.searchParams.append('f', `${f}:${op}:${v}`);
  return u.pathname + u.search;
}

/** Grouped horizontal bars comparing several items across metrics (posts compare view). */
export function CompareChart(p: { items: Array<{ label: string; values: number[] }>; metrics: string[]; fmt?: (n: number, i: number) => string }) {
  const colors = ['var(--accent)', '#3b82f6', '#10b981', '#ef4444', '#8b5cf6', '#0ea5e9', '#f97316', '#14b8a6'];
  return (
    <div class="compare">
      {p.metrics.map((m, mi) => {
        const max = Math.max(0.0001, ...p.items.map((it) => it.values[mi]));
        return (
          <div class="compare-group">
            <h4>{m}</h4>
            {p.items.map((it, ii) => (
              <div class="bar-row">
                <span class="bar-l" title={it.label}>{it.label}</span>
                <span class="bar-t"><span class="bar-f" style={`width:${(it.values[mi] / max) * 100}%;background:${colors[ii % colors.length]}`} /></span>
                <span class="bar-v">{p.fmt ? p.fmt(it.values[mi], mi) : fmtNum(it.values[mi])}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function csv(c: Ctx, name: string, rows: unknown[][]) {
  const body = rows.map((r) => r.map((v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\n');
  return c.body(body, 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}.csv"` });
}

export const DASH_STYLE = `
.table th.right{text-align:right}.kpi-d{font-size:12px;font-weight:600}.kpi-d.up{color:var(--green)}.kpi-d.down{color:var(--danger)}
.chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
.chip{display:inline-flex;gap:6px;align-items:center;background:var(--surface);border:1px solid var(--border);border-radius:999px;padding:3px 6px 3px 12px;font-size:12.5px}
.chip em{font-style:normal;color:var(--accent-strong);font-weight:600}.chip a{text-decoration:none;color:var(--faint);padding:0 4px}.chip a:hover{color:var(--danger)}
.chip-add{position:relative}.chip-form{position:absolute;z-index:10;top:110%;left:0;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px;box-shadow:var(--shadow-lg);flex-wrap:nowrap}
.range-custom summary{list-style:none}.range-custom summary::-webkit-details-marker{display:none}
.compare{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px}.compare-group h4{margin-bottom:8px}.compare .bar-row{margin-bottom:6px}
.live-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#ef4444;margin-right:6px;animation:pulse 1.6s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(239,68,68,.5)}70%{box-shadow:0 0 0 8px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}
.spark{display:flex;align-items:flex-end;gap:2px;height:48px}.spark i{flex:1;background:var(--accent);border-radius:2px 2px 0 0;min-height:2px;transition:height .3s}
.checklist{list-style:none;padding:0;margin:0}.checklist li{display:flex;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid var(--border)}.checklist li:last-child{border:0}
.checklist .ck{width:20px;height:20px;border-radius:50%;border:2px solid var(--border-strong);display:grid;place-items:center;font-size:11px;flex:none}.checklist li.done .ck{background:var(--green);border-color:var(--green);color:#fff}.checklist li.done a{color:var(--muted);text-decoration:line-through}
.feed{list-style:none;padding:0;margin:0}.feed li{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);align-items:flex-start}.feed li:last-child{border:0}.feed .fd{display:block;max-width:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.feed .fi{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;flex:none;font-size:13px}
.fi-subscriber{background:#d1fae5}.fi-order{background:#fef3c7}.fi-comment{background:#dbeafe}.fi-unsubscribe{background:#f3f4f6}
.quick{display:flex;gap:8px;flex-wrap:wrap}
.heat td{text-align:center;font-variant-numeric:tabular-nums}
.kpis4{grid-template-columns:repeat(4,minmax(0,1fr))}@media(max-width:1280px){.kpis4{grid-template-columns:repeat(2,minmax(0,1fr))}}.kpis6{grid-template-columns:repeat(6,minmax(0,1fr))}@media(max-width:1280px){.kpis4{grid-template-columns:repeat(4,minmax(0,1fr))}@media(max-width:1280px){.kpis4{grid-template-columns:repeat(2,minmax(0,1fr))}}.kpis6{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:640px){.kpis4{grid-template-columns:repeat(4,minmax(0,1fr))}@media(max-width:1280px){.kpis4{grid-template-columns:repeat(2,minmax(0,1fr))}}.kpis6{grid-template-columns:repeat(2,minmax(0,1fr))}}
.hello{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px}.hello h2{font-size:22px;margin:0}
.seg-toggle{display:inline-flex;border:1px solid var(--border);border-radius:8px;overflow:hidden}.seg-toggle a{padding:4px 10px;text-decoration:none;font-size:12.5px;color:var(--muted)}.seg-toggle a.on{background:var(--surface-2);color:var(--text);font-weight:600}
`;

/** Line/area chart with a zoomed y-axis (for cumulative totals where a 0 baseline hides the trend). */
export function TrendChart(p: { labels: string[]; values: number[]; height?: number; color?: string; fmt?: (n: number) => string }) {
  const W = 640, H = p.height || 200, padL = 44, padB = 22, padT = 10;
  const vals = p.values.length ? p.values : [0];
  let min = Math.min(...vals), max = Math.max(...vals);
  if (max === min) { max += 1; min = Math.max(0, min - 1); }
  const span = max - min;
  min = Math.max(0, Math.floor(min - span * 0.15));
  max = Math.ceil(max + span * 0.1);
  const n = Math.max(2, vals.length);
  const x = (i: number) => padL + (i * (W - padL - 8)) / (n - 1);
  const y = (v: number) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  const f = p.fmt || fmtNum;
  const color = p.color || 'var(--accent)';
  const line = vals.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const step = Math.ceil(p.labels.length / 8);
  return (
    <figure class="chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        {[0, 0.5, 1].map((t) => { const v = min + (max - min) * t; return <><line x1={padL} x2={W - 8} y1={y(v)} y2={y(v)} class="chart-grid" /><text x={2} y={y(v) + 4} class="chart-axis">{f(v)}</text></>; })}
        {p.labels.map((l, i) => (i % step === 0 ? <text x={x(i)} y={H - 6} class="chart-axis" text-anchor="middle">{l}</text> : null))}
        <polygon points={`${x(0)},${H - padB} ${line} ${x(vals.length - 1)},${H - padB}`} fill={color} opacity="0.12" />
        <polyline fill="none" stroke={color} stroke-width="2.5" points={line} />
        {vals.map((v, i) => <circle cx={x(i)} cy={y(v)} r="2.5" fill={color}><title>{`${p.labels[i]}: ${f(v)}`}</title></circle>)}
      </svg>
    </figure>
  );
}
