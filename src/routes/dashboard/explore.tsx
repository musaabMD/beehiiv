/** @jsxImportSource hono/jsx */
// 3D analytics explorer: one metric pivoted by up to three dimensions — pivot table with subtotals,
// heatmap shading, stacked bar chart, CSV export, save as report.
import { raw } from 'hono/html';
import type { App, Ctx } from '../../types';
import { all, insert } from '../../lib/db';
import { parseRange, METRICS, pivotDims, runPivot, type PivotResult } from '../../lib/analytics';
import { DashLayout } from '../../ui/layout';
import { Card, Btn, Field, Input, Empty, back } from '../../ui/components';
import { FilterChips, parseFilters, normalizeChipQuery, qsWith, csv, fmtNum, fmtUsd, DASH_STYLE } from './parts';
import { id, now, str, form, parseJSON } from '../../lib/util';

const STYLE = `${DASH_STYLE}
.pivot-wrap{overflow:auto;max-height:70vh;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface)}
.pivot{border-collapse:separate;border-spacing:0;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
.pivot th,.pivot td{padding:7px 10px;border-bottom:1px solid var(--border);white-space:nowrap;text-align:right}
.pivot thead th{position:sticky;top:0;background:#fafafa;z-index:2;font-weight:600;color:var(--muted);font-size:12px}
.pivot th.rh,.pivot td.rh{text-align:left;position:sticky;left:0;background:var(--surface);z-index:1;max-width:280px;overflow:hidden;text-overflow:ellipsis}
.pivot thead th.rh{z-index:3;background:#fafafa}
.pivot tr.sub td{font-weight:600;background:#fcfcfd}.pivot tr.sub td.rh{background:#fcfcfd}
.pivot tr.leaf td.rh{padding-left:26px;color:var(--muted)}
.pivot tr.grand td{font-weight:700;border-top:2px solid var(--border-strong);background:#fafafa}.pivot tr.grand td.rh{background:#fafafa}
.pivot td.tot,.pivot th.tot{border-left:1px solid var(--border);font-weight:600}
.stack{display:flex;flex-direction:column;gap:7px}
.stack-row{display:grid;grid-template-columns:minmax(90px,26%) 1fr 84px;gap:10px;align-items:center;font-size:12.5px}
.stack-row .lbl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stack-bar{display:flex;height:16px;border-radius:5px;overflow:hidden;background:var(--surface-2)}
.stack-bar i{display:block;height:100%}
.stack-row .v{text-align:right}
.legend-wrap{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--muted);margin-bottom:12px}.legend-wrap i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:middle}
.dimpick{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;align-items:end}
@media(max-width:900px){.dimpick{grid-template-columns:1fr 1fr}}
`;

const PALETTE = ['#f59e0b', '#3b82f6', '#10b981', '#ef4444', '#8b5cf6', '#0ea5e9', '#f97316', '#14b8a6', '#ec4899', '#84cc16', '#6366f1', '#a3a3a3', '#78716c'];
const K = (...p: string[]) => p.join('\u0001');

function heat(v: number, max: number): string {
  if (!v || !max) return '';
  const a = Math.min(0.85, 0.08 + (v / max) * 0.77);
  return `background:rgba(245,158,11,${a.toFixed(3)})`;
}

function PivotTable(p: { r: PivotResult; fmt: (n: number) => string }) {
  const { r, fmt } = p;
  const has2 = r.dims.length > 1, has3 = r.dims.length > 2;
  const cols = has2 ? r.d2 : [];
  // heat scale on the most granular cells shown
  const vals = has3 ? [...r.leaf.values()] : has2 ? [...r.cell.values()] : [...r.row.values()];
  const max = Math.max(0, ...vals);
  const cellsFor = (get: (b: string) => number, shade: boolean) => cols.map((b) => { const v = get(b); return <td style={shade ? heat(v, max) : ''}>{v ? fmt(v) : '·'}</td>; });
  return (
    <div class="pivot-wrap">
      <table class="pivot">
        <thead>
          <tr>
            <th class="rh">{r.dims[0].label}{has3 ? ` › ${r.dims[2].label}` : ''}</th>
            {cols.map((b) => <th title={b}>{b.length > 22 ? b.slice(0, 21) + '…' : b}</th>)}
            <th class="tot">{has2 ? 'Total' : r.label}</th>
          </tr>
        </thead>
        <tbody>
          {r.d1.map((a) => (
            <>
              <tr class={has3 ? 'sub' : ''}>
                <td class="rh" title={a}>{a}</td>
                {cellsFor((b) => r.cell.get(K(a, b)) || 0, !has3)}
                <td class="tot" style={!has2 ? heat(r.row.get(a) || 0, max) : ''}>{fmt(r.row.get(a) || 0)}</td>
              </tr>
              {has3 && r.d3.filter((cc) => r.row3.get(K(a, cc))).map((cc) => (
                <tr class="leaf">
                  <td class="rh" title={cc}>{cc}</td>
                  {cellsFor((b) => r.leaf.get(K(a, b, cc)) || 0, true)}
                  <td class="tot">{fmt(r.row3.get(K(a, cc)) || 0)}</td>
                </tr>
              ))}
            </>
          ))}
          <tr class="grand">
            <td class="rh">Total</td>
            {cols.map((b) => <td>{fmt(r.col.get(b) || 0)}</td>)}
            <td class="tot">{fmt(r.total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Horizontal stacked bars: one bar per dim1 value, segments by dim2 (or dim3 when only… dim1+dim3 never happens). */
function StackedBars(p: { r: PivotResult; fmt: (n: number) => string }) {
  const { r, fmt } = p;
  const has2 = r.dims.length > 1;
  const segs = has2 ? r.d2 : [];
  const max = Math.max(1, ...r.d1.map((a) => r.row.get(a) || 0));
  const color = (i: number) => PALETTE[i % PALETTE.length];
  return (
    <>
      {has2 && <div class="legend-wrap">{segs.map((b, i) => <span><i style={`background:${color(i)}`} />{b}</span>)}</div>}
      <div class="stack">
        {r.d1.map((a) => {
          const tot = r.row.get(a) || 0;
          return (
            <div class="stack-row">
              <span class="lbl" title={a}>{a}</span>
              <span class="stack-bar" style={`width:${Math.max(2, (tot / max) * 100)}%`}>
                {has2
                  ? segs.map((b, i) => { const v = r.cell.get(K(a, b)) || 0; const sum = segs.reduce((s, bb) => s + (r.cell.get(K(a, bb)) || 0), 0) || 1; return v ? <i style={`width:${(v / sum) * 100}%;background:${color(i)}`} title={`${a} · ${b}: ${fmt(v)}`} /> : null; })
                  : <i style={`width:100%;background:${color(0)}`} />}
              </span>
              <span class="v">{fmt(tot)}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

export function registerExplore(dash: App) {
  dash.get('/analytics/explore', async (c) => {
    const redirect = normalizeChipQuery(c);
    if (redirect) return c.redirect(redirect);
    const pub = c.get('pub');
    const metric = METRICS[c.req.query('metric') || ''] ? c.req.query('metric')! : 'subscribers';
    const opts = pivotDims(metric);
    const keys = new Set(opts.map(([k]) => k));
    const pick = (q: string | undefined, def: string) => (q && keys.has(q) ? q : q === '' ? '' : def);
    const defaults = metric === 'subscribers' ? ['source', 'country', 'tier'] : metric === 'page_views' || metric === 'visitors' ? ['channel', 'device', 'visitor_type'] : metric === 'emails' || metric === 'opens' ? ['post', 'provider', 'week'] : [opts[3]?.[0] || 'week', opts[4]?.[0] || '', ''];
    const d1 = pick(c.req.query('d1'), defaults[0]) || defaults[0];
    const d2 = pick(c.req.query('d2'), defaults[1] || '');
    const d3 = d2 ? pick(c.req.query('d3'), defaults[2] || '') : '';
    const dims = [d1, d2, d3].filter(Boolean).filter((d, i, a) => a.indexOf(d) === i);
    const range = parseRange(c.req.query());
    const filters = parseFilters(c, metric);
    const r = await runPivot(c.env, pub.id, { metric, dims, range, filters });
    const fmt = (n: number) => (r.money ? fmtUsd(n) : fmtNum(n));

    if (c.req.query('format') === 'csv') {
      const rows: unknown[][] = [[...r.dims.map((d) => d.label), r.label]];
      if (r.dims.length === 3) for (const [k, v] of r.leaf) rows.push([...k.split('\u0001'), r.money ? (v / 100).toFixed(2) : v]);
      else if (r.dims.length === 2) for (const [k, v] of r.cell) rows.push([...k.split('\u0001'), r.money ? (v / 100).toFixed(2) : v]);
      else for (const [k, v] of r.row) rows.push([k, r.money ? (v / 100).toFixed(2) : v]);
      return csv(c, `explore-${metric}-${r.dims.map((d) => d.key).join('-')}`, rows);
    }

    const saved = await all<any>(c.env, `SELECT * FROM saved_reports WHERE pub_id = ? AND config LIKE '%"type":"pivot"%' ORDER BY created_at DESC LIMIT 30`, pub.id);
    const savedHref = (cfg: any) => {
      const u = new URLSearchParams({ metric: cfg.metric, range: cfg.range || '30d' });
      (cfg.dims || []).forEach((d: string, i: number) => u.set('d' + (i + 1), d));
      for (const f of cfg.filters || []) u.append('f', `${f.field}:${f.op}:${f.value}`);
      return '/app/analytics/explore?' + u.toString();
    };
    const sel = (name: string, value: string, allowNone: boolean) => (
      <label class="field" style="margin:0"><span class="field-l">{name === 'd1' ? 'Rows' : name === 'd2' ? 'Columns' : 'Break down by'}</span>
        <select class="input" name={name} data-autosubmit="1">
          {allowNone && <option value="" selected={!value}>— none —</option>}
          {opts.map(([k, l]) => <option value={k} selected={k === value}>{l}</option>)}
        </select>
      </label>
    );
    return c.html(
      <DashLayout c={c} title="3D explorer" section="analytics" sub="explore" head={<style>{raw(STYLE)}</style>} wide
        actions={<a class="btn btn-secondary btn-sm" href={qsWith(c, { format: 'csv' })}>Export CSV</a>}>
        <Card>
          <form method="get" class="dimpick">
            {(c.req.queries('f') || []).map((x) => <input type="hidden" name="f" value={x} />)}
            <label class="field" style="margin:0"><span class="field-l">Metric</span>
              <select class="input" name="metric" data-autosubmit="1">{Object.entries(METRICS).map(([k, d]) => <option value={k} selected={k === metric}>{d.label}</option>)}</select>
            </label>
            {sel('d1', d1, false)}
            {sel('d2', d2, true)}
            {d2 ? sel('d3', d3, true) : <span />}
            <label class="field" style="margin:0"><span class="field-l">Range</span>
              <select class="input" name="range" data-autosubmit="1">{[['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['365d', 'Last 12 months'], ['ytd', 'Year to date'], ['all', 'All time']].map(([k, l]) => <option value={k} selected={range.key === k}>{l}</option>)}</select>
            </label>
          </form>
          <div style="margin-top:12px"><FilterChips c={c} metric={metric} filters={filters} /></div>
        </Card>
        {r.total === 0 ? (
          <Card><Empty icon="▦" title="No data for this view" body="Try a longer date range, another metric, or remove a condition." /></Card>
        ) : (
          <>
            <Card title={`${r.label} by ${r.dims.map((d) => d.label).join(' × ')} · ${range.label}`} actions={<strong>{fmt(r.total)}</strong>} pad={false}>
              <PivotTable r={r} fmt={fmt} />
            </Card>
            <div class="split">
              <Card title={r.dims.length > 1 ? `${r.dims[0].label}, stacked by ${r.dims[1].label}` : r.dims[0].label}>
                <StackedBars r={r} fmt={fmt} />
              </Card>
              <div>
                <Card title="Save this view">
                  <form method="post" action="/app/analytics/explore">
                    <input type="hidden" name="config" value={JSON.stringify({ type: 'pivot', metric, dims: r.dims.map((d) => d.key), range: range.key, filters })} />
                    <Field label="Name"><Input name="name" placeholder="e.g. Signups by source × country" required /></Field>
                    <Btn small>Save report</Btn>
                  </form>
                </Card>
                <Card title="Saved views">
                  {saved.length ? <ul class="list-plain">{saved.map((x) => <li><a href={savedHref(parseJSON(x.config, {}))}>{x.name}</a></li>)}</ul> : <p class="muted small">No saved views yet.</p>}
                </Card>
                <p class="help">Top values are shown per dimension; the rest are grouped as “(other)”. Every subtotal is computed exactly, including unique counts.</p>
              </div>
            </div>
          </>
        )}
      </DashLayout>,
    );
  });

  dash.post('/analytics/explore', async (c: Ctx) => {
    const f = await form(c.req);
    const cfg = parseJSON<any>(f.config, null);
    if (!cfg || cfg.type !== 'pivot' || !METRICS[cfg.metric] || !Array.isArray(cfg.dims)) return back(c, '/app/analytics/explore', 'Invalid view', 'err');
    await insert(c.env, 'saved_reports', { id: id(), pub_id: c.get('pub').id, name: str(f.name, 120) || 'Untitled view', config: JSON.stringify(cfg), created_by: c.get('user').id, created_at: now() });
    const ref = c.req.header('referer');
    return back(c, ref && ref.includes('/app/analytics/explore') ? new URL(ref).pathname + new URL(ref).search : '/app/analytics/explore', 'View saved');
  });
}
