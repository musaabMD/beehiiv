/** @jsxImportSource hono/jsx */
// Shared dashboard pieces for revenue intelligence: attributed revenue (lib/attribution), holdout lift (lib/holdout)
// and the unified customer timeline (lib/timeline). Used by posts/analytics, automations, dashboard/analytics and
// audience/subscribers — each page renders its own section from these.
import { Card, Stats, Stat, Table, Badge, Btn, Field, Input, Help, Muted } from '../ui/components';
import { MODELS, MODEL_LABEL, type Model } from '../lib/attribution';
import type { LiftReport, PropTest, HoldoutConfig, HoldoutKind } from '../lib/holdout';
import { CATEGORIES, type TimelineItem } from '../lib/timeline';
import { num, fmtDateTime } from '../lib/util';

export const usd = (c: number) => (c < 0 ? '−$' : '$') + (Math.round(Math.abs(c)) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctTxt = (x: number) => (x * 100).toFixed(1) + '%';
const ptsTxt = (x: number) => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(1) + ' pts';

/** Attributed revenue of one post (all three models side by side). */
export function PostRevenueCard(p: { rev: { by_model: Record<Model, { revenue: number; orders: number }>; sent: number; revenue_per_1000: number; recent_orders: any[] }; windowDays: number; tz?: string }) {
  const r = p.rev;
  return (
    <Card title="Revenue from this email" actions={<span class="small muted">orders within {p.windowDays} days of a click · <a href="/app/analytics/revenue#attribution">settings</a></span>}>
      <div data-post-revenue={String(r.by_model.last_click.revenue)}>
        <Stats>
          {MODELS.map((m) => <Stat label={MODEL_LABEL[m]} value={usd(r.by_model[m].revenue)} sub={`${num(r.by_model[m].orders)} order${r.by_model[m].orders === 1 ? '' : 's'}`} />)}
          <Stat label="Revenue per 1,000 emails" value={usd(r.revenue_per_1000)} sub={`last click · ${num(r.sent)} delivered`} />
        </Stats>
        {r.recent_orders.length > 0 ? (
          <Table rows={r.recent_orders} cols={[
            { h: 'Order', r: (o: any) => <span>{o.kind} · {o.email}</span> },
            { h: 'Clicked', r: (o: any) => <span class="small">{fmtDateTime(o.touch_at, p.tz)}</span> },
            { h: 'Ordered', r: (o: any) => <span class="small">{fmtDateTime(o.ordered_at, p.tz)}</span> },
            { h: 'Amount', r: (o: any) => usd(o.amount_cents), class: 'right' },
          ]} />
        ) : <Help>No orders credited to this email yet. A reader who clicks it and then buys — a paid subscription, a product, a ticket or a store order — within {p.windowDays} days shows up here.</Help>}
      </div>
    </Card>
  );
}

function LiftRow(p: { label: string; t: PropTest }) {
  const t = p.t;
  return (
    <tr>
      <td>{p.label}</td>
      <td class="right">{pctTxt(t.treated.rate)} <span class="muted small">({num(t.treated.x)}/{num(t.treated.n)})</span></td>
      <td class="right">{pctTxt(t.holdout.rate)} <span class="muted small">({num(t.holdout.x)}/{num(t.holdout.n)})</span></td>
      <td class="right">{ptsTxt(t.diff)}{t.lift !== null ? <span class="muted small"> ({t.lift >= 0 ? '+' : ''}{Math.round(t.lift * 100)}%)</span> : null}</td>
      <td class="right small">{ptsTxt(t.ci[0])} to {ptsTxt(t.ci[1])}</td>
      <td class="right">{t.significant ? <Badge tone={t.diff >= 0 ? 'green' : 'red'}>p = {t.p.toFixed(3)}</Badge> : <Badge>p = {t.p.toFixed(2)}</Badge>}</td>
    </tr>
  );
}

/** Holdout setting + incremental lift report for a post or an automation. */
export function HoldoutCard(p: { kind: HoldoutKind; action: string; cfg: HoldoutConfig | null; report: LiftReport | null; locked?: boolean; canEdit: boolean }) {
  const pct = p.cfg?.pct || 0;
  const r = p.report;
  const what = p.kind === 'post' ? 'not sent this post' : 'not enrolled';
  return (
    <Card title="Holdout test — incremental lift" id="holdout" actions={pct ? <Badge tone="blue">{pct}% held out</Badge> : <Badge>off</Badge>}>
      <div data-holdout={String(pct)}>
        <Help>
          A holdout group is a random {pct || 10}% of eligible readers who are deliberately {what}. Comparing what they do over the next {p.cfg?.window_days || 7} days
          with readers who {p.kind === 'post' ? 'got the email' : 'went through the automation'} shows what the email actually caused — the sales and visits that would not have happened anyway.
          Held-out readers are picked by a stable hash (the same readers every time), recorded on their timeline and never counted as "didn't open".
        </Help>
        {p.canEdit && !p.locked && (
          <form method="post" action={p.action} class="row">
            <Field label="Hold out (% of readers)" inline><Input name="pct" type="number" min={0} max={50} step="0.5" value={pct} /></Field>
            <Field label="Conversion window (days)" inline><Input name="window_days" type="number" min={1} max={60} value={p.cfg?.window_days || 7} /></Field>
            <Btn small kind="secondary">Save holdout</Btn>
          </form>
        )}
        {p.locked && <p class="small muted">This post has been sent, so its holdout can't change. {pct ? '' : 'It was sent without a holdout.'}</p>}
        {r && r.holdout > 0 && (
          <div data-lift>
            <div class="table-wrap"><table class="table">
              <thead><tr><th>Outcome within {r.window_days} days</th><th class="right">{p.kind === 'post' ? 'Sent' : 'Enrolled'} ({num(r.treated)})</th><th class="right">Holdout ({num(r.holdout)})</th><th class="right">Lift</th><th class="right">95% range</th><th class="right">Significance</th></tr></thead>
              <tbody>
                <LiftRow label="Placed an order" t={r.purchase} />
                <LiftRow label="Visited your site" t={r.visit} />
                <LiftRow label="Upgraded to paid" t={r.upgrade} />
                <tr>
                  <td>Revenue per reader</td>
                  <td class="right">{usd(r.revenue.treated.mean)}</td>
                  <td class="right">{usd(r.revenue.holdout.mean)}</td>
                  <td class="right">{r.revenue.diff >= 0 ? '+' : '−'}{usd(Math.abs(r.revenue.diff))}</td>
                  <td class="right small">{usd(r.revenue.ci[0])} to {usd(r.revenue.ci[1])}</td>
                  <td class="right"><strong data-incremental={String(Math.round(r.revenue.incremental))}>{r.revenue.incremental >= 0 ? '+' : '−'}{usd(Math.abs(r.revenue.incremental))}</strong> <span class="muted small">incremental</span></td>
                </tr>
              </tbody>
            </table></div>
            <ul class="small" data-lift-summary>{r.summary.map((s) => <li>{s}</li>)}</ul>
            <p class="help">How to read this: "Lift" is the difference between the two groups. The 95% range is where the true difference most likely lies; if it includes zero, the email may have made no difference. Significance uses a two-proportion z-test — p below 0.05 means a gap this big would rarely happen by chance.</p>
          </div>
        )}
        {r && r.holdout === 0 && pct > 0 && <p class="muted small">No readers held back yet — results appear after the next {p.kind === 'post' ? 'send' : 'enrollments'}.</p>}
      </div>
    </Card>
  );
}

/** One page of the unified customer timeline with category filters and "older" pagination. */
export function TimelineCard(p: { base: string; items: TimelineItem[]; next: string | null; types: string[]; tz?: string }) {
  const qs = (types: string[], cursor?: string | null) => {
    const u = new URLSearchParams();
    if (types.length) u.set('tl', types.join(','));
    if (cursor) u.set('tl_before', cursor);
    const s = u.toString();
    return `${p.base}${s ? '?' + s : ''}#timeline`;
  };
  const toggle = (k: string) => (p.types.includes(k) ? p.types.filter((x) => x !== k) : [...p.types, k]);
  const TONE: Record<string, any> = { email: 'blue', automation: 'purple', transactional: 'gray', order: 'green', cart: 'amber', reply: 'blue', web: 'gray', signup: 'green', event: 'purple', community: 'blue', custom: 'amber', activity: 'gray' };
  return (
    <Card title="Customer timeline" id="timeline" actions={<span class="small muted">Everything this reader did, newest first</span>}>
      <div class="row wrap" style="gap:6px;margin-bottom:10px" data-timeline-filters>
        <a href={qs([])} class={`btn btn-sm ${p.types.length ? 'btn-ghost' : 'btn-secondary'}`}>All</a>
        {Object.entries(CATEGORIES).map(([k, label]) => <a href={qs(toggle(k))} class={`btn btn-sm ${p.types.includes(k) ? 'btn-secondary' : 'btn-ghost'}`} data-tl={k}>{label}</a>)}
      </div>
      {p.items.length ? (
        <ul class="timeline" data-timeline>
          {p.items.map((it) => (
            <li data-tl-type={it.type} data-tl-cat={it.category}>
              <Badge tone={TONE[it.category]}>{CATEGORIES[it.category]}</Badge> {it.href ? <a href={it.href}><strong>{it.title}</strong></a> : <strong>{it.title}</strong>}
              {it.detail ? <div class="small muted">{it.detail}</div> : null}
              <div class="small muted">{fmtDateTime(it.at, p.tz)}</div>
            </li>
          ))}
        </ul>
      ) : <Help>Nothing here{p.types.length ? ' for these filters' : ''} yet.</Help>}
      <div class="row between" style="margin-top:8px">
        {p.next ? <a class="btn btn-secondary btn-sm" href={qs(p.types, p.next)} data-tl-older>Older →</a> : <Muted>{p.items.length ? 'Beginning of the timeline' : ''}</Muted>}
        {p.next || p.types.length ? <a class="small" href={qs(p.types)}>Newest</a> : null}
      </div>
    </Card>
  );
}

export function ModelPicker(p: { model: Model; href: (m: Model) => string }) {
  return <span class="row" style="gap:4px">{MODELS.map((m) => <a class={`btn btn-sm ${m === p.model ? 'btn-secondary' : 'btn-ghost'}`} href={p.href(m)} data-model={m}>{MODEL_LABEL[m]}</a>)}</span>;
}
