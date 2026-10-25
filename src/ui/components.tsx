/** @jsxImportSource hono/jsx */
// Shared dashboard UI components. Server-rendered; behaviour lives in public/static/app.js (data-* hooks).
import type { Child } from 'hono/jsx';
import { raw } from 'hono/html';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Ctx } from '../types';
import { num } from '../lib/util';

type P = { children?: Child; class?: string };

export const Card = (p: P & { title?: Child; actions?: Child; pad?: boolean; id?: string }) => (
  <section class={`card ${p.class || ''}`} id={p.id}>
    {(p.title || p.actions) && (
      <header class="card-h">
        <h3>{p.title}</h3>
        <div class="card-actions">{p.actions}</div>
      </header>
    )}
    <div class={p.pad === false ? '' : 'card-b'}>{p.children}</div>
  </section>
);

export const Grid = (p: P & { cols?: number }) => <div class={`grid g${p.cols || 2} ${p.class || ''}`}>{p.children}</div>;
export const Row = (p: P) => <div class={`row ${p.class || ''}`}>{p.children}</div>;

type BtnKind = 'primary' | 'secondary' | 'ghost' | 'danger';
export const Btn = (p: P & { kind?: BtnKind; type?: 'submit' | 'button'; name?: string; value?: string; confirm?: string; formaction?: string; id?: string; disabled?: boolean; small?: boolean; attrs?: Record<string, string> }) => (
  <button class={`btn btn-${p.kind || 'primary'} ${p.small ? 'btn-sm' : ''} ${p.class || ''}`} type={p.type || 'submit'} name={p.name} value={p.value} data-confirm={p.confirm} formaction={p.formaction} id={p.id} disabled={p.disabled} {...(p.attrs || {})}>
    {p.children}
  </button>
);

export const LinkBtn = (p: P & { href: string; kind?: BtnKind; small?: boolean; target?: string; download?: boolean }) => (
  <a class={`btn btn-${p.kind || 'secondary'} ${p.small ? 'btn-sm' : ''} ${p.class || ''}`} href={p.href} target={p.target} download={p.download}>
    {p.children}
  </a>
);

/** POST form with a single button — for actions like delete/duplicate/send. */
export const ActionForm = (p: P & { action: string; label: Child; kind?: BtnKind; confirm?: string; small?: boolean; fields?: Record<string, string> }) => (
  <form method="post" action={p.action} class="inline-form">
    {Object.entries(p.fields || {}).map(([k, v]) => <input type="hidden" name={k} value={v} />)}
    <Btn kind={p.kind || 'secondary'} confirm={p.confirm} small={p.small ?? true}>{p.label}</Btn>
  </form>
);

export const Field = (p: P & { label?: Child; hint?: Child; for?: string; inline?: boolean }) => (
  <label class={`field ${p.inline ? 'field-inline' : ''} ${p.class || ''}`} for={p.for}>
    {p.label && <span class="field-l">{p.label}</span>}
    {p.children}
    {p.hint && <small class="field-h">{p.hint}</small>}
  </label>
);

export const Input = (p: { name: string; value?: string | number | null; type?: string; placeholder?: string; required?: boolean; min?: string | number; max?: string | number; step?: string; id?: string; class?: string; autofocus?: boolean; readonly?: boolean; list?: string; pattern?: string; maxlength?: number; attrs?: Record<string, string> }) => (
  <input class={`input ${p.class || ''}`} name={p.name} id={p.id} type={p.type || 'text'} value={p.value ?? ''} placeholder={p.placeholder} required={p.required} min={p.min} max={p.max} step={p.step} autofocus={p.autofocus} readonly={p.readonly} list={p.list} pattern={p.pattern} maxlength={p.maxlength} {...(p.attrs || {})} />
);

export const Textarea = (p: { name: string; value?: string | null; rows?: number; placeholder?: string; class?: string; id?: string; required?: boolean; attrs?: Record<string, string> }) => (
  <textarea class={`input ${p.class || ''}`} name={p.name} id={p.id} rows={p.rows || 4} placeholder={p.placeholder} required={p.required} {...(p.attrs || {})}>{p.value ?? ''}</textarea>
);

export const Select = (p: { name: string; value?: string | null; options: Array<[string, string]> | string[]; id?: string; class?: string; autosubmit?: boolean; multiple?: boolean; values?: string[]; attrs?: Record<string, string> }) => (
  <select class={`input ${p.class || ''}`} name={p.name} id={p.id} data-autosubmit={p.autosubmit ? '1' : undefined} multiple={p.multiple} {...(p.attrs || {})}>
    {p.options.map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      const sel = p.multiple ? (p.values || []).includes(v) : String(p.value ?? '') === v;
      return <option value={v} selected={sel}>{l}</option>;
    })}
  </select>
);

export const Check = (p: { name: string; checked?: boolean; label: Child; value?: string; hint?: Child }) => (
  <label class="check">
    <input type="checkbox" name={p.name} value={p.value || 'on'} checked={!!p.checked} />
    <span>{p.label}{p.hint && <small class="field-h">{p.hint}</small>}</span>
  </label>
);

export const Toggle = (p: { name: string; checked?: boolean; label: Child; hint?: Child }) => (
  <label class="toggle">
    <input type="checkbox" name={p.name} checked={!!p.checked} />
    <span class="toggle-ui" />
    <span>{p.label}{p.hint && <small class="field-h">{p.hint}</small>}</span>
  </label>
);

export const Badge = (p: P & { tone?: 'gray' | 'green' | 'amber' | 'red' | 'blue' | 'purple' }) => <span class={`badge b-${p.tone || 'gray'}`}>{p.children}</span>;

const STATUS_TONE: Record<string, 'gray' | 'green' | 'amber' | 'red' | 'blue' | 'purple'> = {
  active: 'green', published: 'green', sent: 'green', paid: 'green', success: 'green', verified: 'green', approved: 'green', live: 'red', completed: 'green', visible: 'green', accepted: 'green',
  draft: 'gray', archived: 'gray', ended: 'gray', canceled: 'gray', cancelled: 'gray', declined: 'gray', hidden: 'gray', exited: 'gray',
  scheduled: 'blue', sending: 'blue', testing: 'purple', trialing: 'purple', pending: 'amber', paused: 'amber', retrying: 'amber', waiting: 'blue', applied: 'amber', available: 'blue', reported: 'amber', open: 'amber',
  failed: 'red', bounced: 'red', unsubscribed: 'gray', complained: 'red', rejected: 'red', banned: 'red', past_due: 'red', refunded: 'gray',
  premium: 'purple', free: 'gray',
};
export const Status = (p: { s: string | null | undefined }) => <Badge tone={STATUS_TONE[p.s || ''] || 'gray'}>{(p.s || '—').replace(/_/g, ' ')}</Badge>;

export const Stat = (p: { label: Child; value: Child; sub?: Child; href?: string; tone?: string }) => {
  const inner = (
    <>
      <span class="stat-l">{p.label}</span>
      <span class={`stat-v ${p.tone || ''}`}>{p.value}</span>
      {p.sub && <span class="stat-s">{p.sub}</span>}
    </>
  );
  return p.href ? <a class="stat" href={p.href}>{inner}</a> : <div class="stat">{inner}</div>;
};

export const Stats = (p: P) => <div class="stats">{p.children}</div>;

export const Empty = (p: { title: Child; body?: Child; action?: Child; icon?: string }) => (
  <div class="empty">
    <div class="empty-i">{p.icon || '✦'}</div>
    <h3>{p.title}</h3>
    {p.body && <p>{p.body}</p>}
    {p.action && <div class="empty-a">{p.action}</div>}
  </div>
);

export interface Col<T> { h: Child; r: (row: T) => Child; class?: string }
export function Table<T>(p: { cols: Col<T>[]; rows: T[]; empty?: Child; class?: string; rowHref?: (row: T) => string }) {
  if (!p.rows.length) return <div class="table-empty">{p.empty || 'Nothing here yet.'}</div>;
  return (
    <div class="table-wrap">
      <table class={`table ${p.class || ''}`}>
        <thead><tr>{p.cols.map((c) => <th class={c.class}>{c.h}</th>)}</tr></thead>
        <tbody>
          {p.rows.map((row) => (
            <tr data-href={p.rowHref ? p.rowHref(row) : undefined} class={p.rowHref ? 'clickable' : ''}>
              {p.cols.map((c) => <td class={c.class}>{c.r(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const Tabs = (p: { items: Array<[string, string]>; active: string }) => (
  <nav class="tabs">
    {p.items.map(([href, label]) => <a href={href} class={href === p.active || label === p.active ? 'on' : ''}>{label}</a>)}
  </nav>
);

export const Pager = (p: { next?: string | null; prev?: string | null; info?: Child }) => (
  <div class="pager">
    <span class="muted">{p.info}</span>
    <span>
      {p.prev && <a class="btn btn-ghost btn-sm" href={p.prev}>← Previous</a>}
      {p.next && <a class="btn btn-ghost btn-sm" href={p.next}>Next →</a>}
    </span>
  </div>
);

export const Copy = (p: { value: string; label?: string }) => (
  <div class="copy">
    <input class="input" readonly value={p.value} />
    <button type="button" class="btn btn-secondary btn-sm" data-copy={p.value}>{p.label || 'Copy'}</button>
  </div>
);

export const Code = (p: { children: string }) => <pre class="code"><code>{p.children}</code></pre>;

/** <dialog> modal; open with a button having data-open="#id". */
export const Modal = (p: P & { id: string; title: Child; wide?: boolean }) => (
  <dialog id={p.id} class={`modal ${p.wide ? 'modal-wide' : ''}`}>
    <header class="modal-h"><h3>{p.title}</h3><button type="button" class="btn btn-ghost btn-sm" data-close>✕</button></header>
    <div class="modal-b">{p.children}</div>
  </dialog>
);

export const OpenBtn = (p: P & { target: string; kind?: BtnKind; small?: boolean }) => (
  <button type="button" class={`btn btn-${p.kind || 'primary'} ${p.small ? 'btn-sm' : ''}`} data-open={p.target}>{p.children}</button>
);

export const Help = (p: P) => <p class="help">{p.children}</p>;
export const Muted = (p: P) => <span class="muted">{p.children}</span>;

export const Progress = (p: { value: number; max: number; label?: Child }) => (
  <div class="progress" title={`${p.value}/${p.max}`}>
    <div class="progress-bar" style={`width:${Math.min(100, p.max ? (p.value / p.max) * 100 : 0)}%`} />
    {p.label && <span>{p.label}</span>}
  </div>
);

// ───────── charts (inline SVG, no JS needed) ─────────
export function LineChart(p: { series: Array<{ label: string; values: number[]; color?: string }>; labels: string[]; height?: number; fmt?: (n: number) => string }) {
  const W = 640, H = p.height || 200, pad = 28;
  const max = Math.max(1, ...p.series.flatMap((s) => s.values));
  const n = Math.max(2, p.labels.length);
  const x = (i: number) => pad + (i * (W - pad * 2)) / (n - 1);
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const colors = ['var(--accent)', '#3b82f6', '#10b981', '#ef4444', '#8b5cf6'];
  const fmt = p.fmt || ((v: number) => num(Math.round(v)));
  const step = Math.ceil(p.labels.length / 8);
  return (
    <figure class="chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        {[0, 0.5, 1].map((f) => <line x1={pad} x2={W - pad} y1={y(max * f)} y2={y(max * f)} class="chart-grid" />)}
        {[0, 0.5, 1].map((f) => <text x={2} y={y(max * f) + 4} class="chart-axis">{fmt(max * f)}</text>)}
        {p.labels.map((l, i) => (i % step === 0 ? <text x={x(i)} y={H - 6} class="chart-axis" text-anchor="middle">{l}</text> : null))}
        {p.series.map((s, si) => (
          <>
            <polyline fill="none" stroke={s.color || colors[si % colors.length]} stroke-width="2.5" points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
            {s.values.map((v, i) => <circle cx={x(i)} cy={y(v)} r="3" fill={s.color || colors[si % colors.length]}><title>{`${s.label} · ${p.labels[i]}: ${fmt(v)}`}</title></circle>)}
          </>
        ))}
      </svg>
      {p.series.length > 1 && (
        <figcaption class="legend">{p.series.map((s, si) => <span><i style={`background:${s.color || colors[si % colors.length]}`} />{s.label}</span>)}</figcaption>
      )}
    </figure>
  );
}

export function Bars(p: { rows: Array<{ label: Child; value: number; sub?: Child }>; fmt?: (n: number) => string; max?: number }) {
  const max = p.max || Math.max(1, ...p.rows.map((r) => r.value));
  const fmt = p.fmt || ((v: number) => num(v));
  if (!p.rows.length) return <div class="table-empty">No data yet.</div>;
  return (
    <div class="bars">
      {p.rows.map((r) => (
        <div class="bar-row">
          <span class="bar-l">{r.label}</span>
          <span class="bar-t"><span class="bar-f" style={`width:${(r.value / max) * 100}%`} /></span>
          <span class="bar-v">{fmt(r.value)}{r.sub && <small> {r.sub}</small>}</span>
        </div>
      ))}
    </div>
  );
}

// ───────── flash messages ─────────
export function flash(c: Ctx, msg: string, kind: 'ok' | 'err' = 'ok') {
  setCookie(c, 'oh_flash', `${kind}:${encodeURIComponent(msg)}`, { path: '/', maxAge: 30, sameSite: 'Lax' });
}
export function readFlash(c: Ctx): { kind: 'ok' | 'err'; msg: string } | null {
  const v = getCookie(c, 'oh_flash');
  if (!v) return null;
  deleteCookie(c, 'oh_flash', { path: '/' });
  const [kind, ...rest] = v.split(':');
  return { kind: kind === 'err' ? 'err' : 'ok', msg: decodeURIComponent(rest.join(':')) };
}

/** Redirect back with a flash message. */
export function back(c: Ctx, to: string, msg?: string, kind: 'ok' | 'err' = 'ok') {
  if (msg) flash(c, msg, kind);
  return c.redirect(to, 303);
}

export const Json = (p: { id: string; data: unknown }) => <script type="application/json" id={p.id}>{raw(JSON.stringify(p.data).replace(/</g, '\\u003c'))}</script>;
