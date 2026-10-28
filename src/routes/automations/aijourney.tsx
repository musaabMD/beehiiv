/** @jsxImportSource hono/jsx */
// Automations: AI Revenue Journey Engine ("describe your goal" → preview → draft automation) and experiment guardrails
// (A/B splits in automations, A/B / multivariate newsletter tests). Registered from routes/automations.tsx before /:id.
import type { Hono } from 'hono';
import type { AppEnv, Ctx, Subscriber } from '../../types';
import { one, all, insert } from '../../lib/db';
import { requirePerm, can, audit } from '../../lib/auth';
import { walk, triggerList, type Step } from '../../lib/automations';
import { outline } from '../../lib/automation-templates';
import { generateJourney, GOAL_EXAMPLES, TONES, type JourneyInput } from '../../lib/aijourneys';
import { guardrailFor, saveGuardrail, removeGuardrail, normalizeGuardrail, runGuardrails, checkAutomation, splitArmStats, sendArmStats, resetSplit, DEFAULT_GUARDRAIL, type GuardrailConfig, type ArmStats } from '../../lib/guardrails';
import { buildEmail, type Content } from '../../lib/sender';
import { aiEnabled } from '../../lib/ai';
import { DashLayout } from '../../ui/layout';
import { Card, Btn, LinkBtn, ActionForm, Field, Input, Textarea, Select, Toggle, Table, Badge, Status, Help, Empty, back } from '../../ui/components';
import { id, now, parseJSON, form, str, ago, num, pct } from '../../lib/util';
import { triggerSummary } from './shared';

const kindIcon: Record<string, string> = { send_email: '✉️', delay: '⏱️', wait_until: '⏳', condition: '🔀', ab_split: '🎲', add_tag: '🏷️', remove_tag: '🏷️', update_field: '✏️', grant_premium: '⭐', notify: '🔔', unsubscribe: '🚫', exit: '⏹', branch: '↳' };

/** Entry card shown at the top of the "New automation" gallery. */
export function AiJourneyEntry() {
  return (
    <a class="callout row between" href="/app/automations/ai" data-ai-journey-entry style="text-decoration:none;margin-bottom:12px">
      <span><strong>✨ Describe your goal — get a complete journey</strong><br /><span class="small muted">“Turn free readers into paid subscribers”, “Sell my $49 course to new subscribers”… Entry points, filters, delays, branches and every email, ready to review as a draft.</span></span>
      <span class="btn btn-primary btn-sm">Build with AI →</span>
    </a>
  );
}

function GuardrailFields(p: { cfg: GuardrailConfig; arms?: string[] }) {
  const g = p.cfg;
  return (
    <>
      <Toggle name="enabled" checked={g.enabled} label="Guardrails on" hint="Stop a harmful or losing arm automatically and send everyone down the safe path." />
      <div class="grid g3">
        <Field label="Max unsubscribe rate (%)"><Input name="max_unsub_pct" type="number" step="0.01" min={0} value={g.max_unsub_pct} /></Field>
        <Field label="Max complaint rate (%)" hint="Gmail/Yahoo require < 0.3%"><Input name="max_complaint_pct" type="number" step="0.01" min={0} value={g.max_complaint_pct} /></Field>
        <Field label="Min revenue per recipient vs control (%)" hint="0 = off"><Input name="min_rpr_pct" type="number" step="1" min={0} max={100} value={g.min_rpr_pct} /></Field>
      </div>
      <div class="grid g3">
        <Field label="Min recipients per arm before judging"><Input name="min_sample" type="number" min={1} value={g.min_sample} /></Field>
        <Field label="Attribution window (days)"><Input name="window_days" type="number" min={1} max={90} value={g.window_days} /></Field>
        <Field label="Control"><Select name="control" value={g.control} options={(p.arms || ['A', 'B']).map((a) => [a, p.arms ? `Path ${a}` : `Variant ${a}`] as [string, string])} /></Field>
      </div>
    </>
  );
}

function ArmTable(p: { arms: ArmStats[]; label: (a: string) => string }) {
  return (
    <Table rows={p.arms} cols={[
      { h: 'Arm', r: (a) => <strong>{p.label(a.arm)}</strong> },
      { h: 'Recipients', r: (a) => num(a.n), class: 'right' },
      { h: 'Unsubscribed', r: (a) => <span>{num(a.unsubs)} <span class="muted small">{pct(a.unsubs, a.n, 2)}</span></span>, class: 'right' },
      { h: 'Complaints', r: (a) => <span>{num(a.complaints)} <span class="muted small">{pct(a.complaints, a.n, 2)}</span></span>, class: 'right' },
      { h: 'Revenue / recipient', r: (a) => '$' + (a.n ? a.revenue_cents / a.n / 100 : 0).toFixed(2), class: 'right' },
    ]} />
  );
}

function EventList(p: { events: any[] }) {
  if (!p.events.length) return <p class="muted small">No guardrail has fired yet.</p>;
  return (
    <ul class="list-plain stack-sm" data-guardrail-events>
      {p.events.map((e) => <li><Badge tone="red">stopped {e.stopped}</Badge> <Badge tone="green">safe: {e.safe}</Badge> <span class="muted small">{ago(e.created_at)}</span><div class="small">{e.explanation}</div></li>)}
    </ul>
  );
}

export function registerAiJourneys(dash: Hono<AppEnv>) {
  // ───────── AI journey: describe your goal ─────────
  dash.get('/ai', async (c) => {
    const pub = c.get('pub');
    const segs = await all<{ id: string; name: string }>(c.env, 'SELECT id, name FROM segments WHERE pub_id = ? ORDER BY name', pub.id);
    const recent = await all<any>(c.env, 'SELECT id, goal, source, automation_id, created_at FROM ai_journeys WHERE pub_id = ? ORDER BY created_at DESC LIMIT 8', pub.id);
    const q = c.req.query();
    return c.html(
      <DashLayout c={c} title="Build a journey from your goal" section="automations" crumbs={[['/app/automations', 'Automations']]}>
        <Card>
          <form method="post" action="/app/automations/ai" class="stack" id="ai-journey-form">
            <Field label="Describe your goal" hint="One sentence is enough. The more specific, the better the journey.">
              <Textarea name="goal" rows={2} required value={q.goal || ''} placeholder="Turn free readers into paid subscribers" attrs={{ 'data-goal': '', maxlength: '300' }} />
            </Field>
            <div class="row" style="flex-wrap:wrap;gap:6px">{GOAL_EXAMPLES.map((g) => <button type="button" class="btn btn-ghost btn-sm" data-goal-example={g}>{g}</button>)}</div>
            <details open={!!(q.product || q.price)}>
              <summary class="small"><strong>Optional context</strong> — product, price, audience, tone</summary>
              <div class="grid g3" style="margin-top:10px">
                <Field label="Product / offer"><Input name="product" value={q.product || ''} placeholder="Writing Masterclass" /></Field>
                <Field label="Price"><Input name="price" value={q.price || ''} placeholder="$49" /></Field>
                <Field label="Link (optional)"><Input name="url" type="url" value={q.url || ''} placeholder="https://…" /></Field>
              </div>
              <div class="grid g2">
                <Field label="Audience segment" hint="Only subscribers in this segment enter the journey."><Select name="segment_id" value="" options={[['', 'Everyone matching the entry point'], ...segs.map((s) => [s.id, s.name] as [string, string])]} /></Field>
                <Field label="Tone"><Select name="tone" value="friendly" options={TONES} /></Field>
              </div>
            </details>
            <Field label="Engine">
              <Select name="engine" value={aiEnabled(c.env) ? 'auto' : 'template'} options={[['auto', aiEnabled(c.env) ? 'AI (Workers AI), template fallback' : 'AI — not configured on this instance (uses templates)'], ['template', 'Closest template only (no AI)']]} />
            </Field>
            <div class="form-actions"><a class="btn btn-ghost" href="/app/automations#new-automation">Browse templates instead</a><Btn id="ai-journey-go">Generate preview</Btn></div>
            <p class="small muted" id="ai-journey-wait" hidden>Designing your journey… AI drafts take 20–60 seconds. Nothing is created until you confirm.</p>
          </form>
        </Card>
        {recent.length > 0 && (
          <Card title="Recent journeys" pad={false}>
            <Table rows={recent} cols={[
              { h: 'Goal', r: (r: any) => <a href={`/app/automations/ai/${r.id}`}>{r.goal}</a> },
              { h: 'Built by', r: (r: any) => <Badge tone={r.source === 'ai' ? 'purple' : 'gray'}>{r.source === 'ai' ? 'AI' : 'template'}</Badge> },
              { h: '', r: (r: any) => r.automation_id ? <a href={`/app/automations/${r.automation_id}`}>Open automation</a> : <span class="muted small">preview</span> },
              { h: '', r: (r: any) => <span class="muted small">{ago(r.created_at)}</span>, class: 'right' },
            ]} />
          </Card>
        )}
        <script dangerouslySetInnerHTML={{ __html: `(function(){var f=document.getElementById('ai-journey-form'),g=f.querySelector('[data-goal]');document.querySelectorAll('[data-goal-example]').forEach(function(b){b.addEventListener('click',function(){g.value=b.getAttribute('data-goal-example');g.focus()})});f.addEventListener('submit',function(){var b=document.getElementById('ai-journey-go');b.disabled=true;b.textContent='Generating…';document.getElementById('ai-journey-wait').hidden=false})})();` }} />
      </DashLayout>,
    );
  });

  dash.post('/ai', async (c) => {
    const pub = c.get('pub');
    const f = await form(c.req);
    const goal = str(f.goal, 300).trim();
    if (goal.length < 4) return back(c, '/app/automations/ai', 'Describe your goal in a few words.', 'err');
    const seg = str(f.segment_id) ? await one<{ id: string; name: string }>(c.env, 'SELECT id, name FROM segments WHERE id = ? AND pub_id = ?', str(f.segment_id), pub.id) : null;
    const input: JourneyInput = { goal, product: str(f.product, 120) || undefined, price: str(f.price, 40) || undefined, url: /^https?:\/\//.test(str(f.url)) ? str(f.url, 500) : undefined, segment_id: seg?.id, segment_name: seg?.name, tone: TONES.some(([k]) => k === f.tone) ? f.tone : 'friendly' };
    const plan = await generateJourney(c.env, pub, input, { engine: f.engine === 'template' ? 'template' : 'auto' });
    const jid = id();
    await insert(c.env, 'ai_journeys', {
      id: jid, pub_id: pub.id, user_id: c.get('user').id, goal, context: JSON.stringify({ ...input, engine: f.engine === 'template' ? 'template' : 'auto' }), source: plan.source, template_key: plan.template_key ?? null,
      plan: JSON.stringify({ name: plan.name, description: plan.description, trigger: plan.trigger, steps: plan.steps }), notes: JSON.stringify(plan.notes), ms: plan.ms, created_at: now(),
    });
    return c.redirect(`/app/automations/ai/${jid}`, 303);
  });

  dash.get('/ai/:jid', async (c) => {
    const pub = c.get('pub');
    const j = await one<any>(c.env, 'SELECT * FROM ai_journeys WHERE id = ? AND pub_id = ?', c.req.param('jid'), pub.id);
    if (!j) return c.notFound();
    const plan = parseJSON<any>(j.plan, {});
    const ctx = parseJSON<any>(j.context, {});
    const steps: Step[] = plan.steps || [];
    const emails: Step[] = [];
    walk(steps, (s) => { if (s.type === 'send_email') emails.push(s); });
    const user = c.get('user');
    const sample = { id: 'preview', pub_id: pub.id, email: user.email, name: user.name, tier: 'free', referral_code: 'preview', referral_count: 0, custom: '{}', created_at: now() } as unknown as Subscriber;
    const previews: string[] = [];
    for (const e of emails) {
      const cfg = e.config || {};
      const content: Content = { title: '', subtitle: '', doc: cfg.doc || { blocks: [] }, preview_text: cfg.preview_text || '', style: null, hideHeader: true };
      previews.push((await buildEmail(c.env, pub, content, sample, { preview: true })).html);
    }
    const regen = `/app/automations/ai?${new URLSearchParams(Object.entries({ goal: j.goal, product: ctx.product || '', price: ctx.price || '', url: ctx.url || '' }).filter(([, v]) => v) as any).toString()}`;
    const notes: string[] = parseJSON(j.notes, []);
    return c.html(
      <DashLayout c={c} title={plan.name || 'Journey preview'} section="automations" wide crumbs={[['/app/automations', 'Automations'], ['/app/automations/ai', 'Build from goal']]} styles={['/static/automations.css']}
        actions={j.automation_id ? <LinkBtn href={`/app/automations/${j.automation_id}`}>Open the draft automation</LinkBtn> : <form method="post" action={`/app/automations/ai/${j.id}/create`} class="inline-form"><Btn class="btn-accent" attrs={{ 'data-create-journey': '' }}>Create draft automation</Btn></form>}>
        <div class="callout row between" data-journey-source={j.source}>
          <span><Badge tone={j.source === 'ai' ? 'purple' : 'gray'}>{j.source === 'ai' ? '✨ AI-generated' : '📋 Adapted template'}</Badge> <strong>Goal:</strong> {j.goal}{ctx.product ? <> · {ctx.product}{ctx.price ? ` (${ctx.price})` : ''}</> : null}{ctx.segment_name ? <> · segment “{ctx.segment_name}”</> : null}</span>
          <span class="small muted">{j.ms ? `${(j.ms / 1000).toFixed(1)}s` : ''} · <a href={regen}>Edit &amp; regenerate</a></span>
        </div>
        {notes.length > 0 && <Help><ul class="small" style="margin:0;padding-left:18px">{notes.map((n) => <li>{n}</li>)}</ul></Help>}
        <div class="grid g2" style="align-items:start">
          <Card title="Flow">
            {plan.description && <p class="small muted">{plan.description}</p>}
            <div class="af-gal-entry"><div class="af-kicker">Entry point{triggerList(plan.trigger).length > 1 ? 's' : ''}</div>
              {triggerList(plan.trigger).map((t, i) => <div>{i ? <span class="badge b-gray">OR</span> : null} ⚡ {triggerSummary(t)}{t.filter?.rules?.length ? <span class="small muted"> · only if {t.filter.rules.map((r: any) => r.field === 'segment' ? `in segment “${ctx.segment_name || r.value}”` : `${r.field} ${r.cmp} ${r.value}`).join(' and ')}</span> : null}</div>)}
            </div>
            <ol class="af-gal-flow" data-journey-flow>
              {outline(steps).map((o) => <li class={`t-${o.type}`} style={`margin-left:${o.depth * 16}px`}><span aria-hidden="true">{kindIcon[o.type] || '•'}</span> {o.text}</li>)}
            </ol>
            <p class="small muted">{emails.length} email{emails.length === 1 ? '' : 's'} · created as a <strong>draft</strong> — nothing is sent until you activate it.</p>
          </Card>
          <div class="stack">
            {emails.map((e, i) => (
              <Card title={<span>✉️ {e.config?.subject}</span>}>
                {e.config?.preview_text && <p class="small muted" style="margin-top:0">Preview text: {e.config.preview_text}</p>}
                <iframe class="preview-frame" title={`Email ${i + 1} preview`} srcdoc={previews[i]} style="width:100%;height:420px;border:1px solid var(--line,#e5e7eb);border-radius:8px" data-journey-email />
              </Card>
            ))}
          </div>
        </div>
      </DashLayout>,
    );
  });

  dash.post('/ai/:jid/create', async (c) => {
    const pub = c.get('pub');
    const j = await one<any>(c.env, 'SELECT * FROM ai_journeys WHERE id = ? AND pub_id = ?', c.req.param('jid'), pub.id);
    if (!j) return c.notFound();
    if (j.automation_id) return c.redirect(`/app/automations/${j.automation_id}`, 303);
    const plan = parseJSON<any>(j.plan, {});
    const steps: Step[] = plan.steps || [];
    walk(steps, (st) => { if (st.type === 'notify' && !st.config?.email) st.config = { ...st.config, email: c.get('user').email }; });
    const aid = id();
    await insert(c.env, 'automations', {
      id: aid, pub_id: pub.id, name: String(plan.name || j.goal).slice(0, 120), description: String(plan.description || '').slice(0, 500), status: 'draft', trigger: '{}', steps: '[]',
      draft_trigger: JSON.stringify(plan.trigger || {}), draft_steps: JSON.stringify(steps), allow_reentry: 0, created_by: c.get('user').id, created_at: now(), updated_at: now(),
    });
    await c.env.DB.prepare('UPDATE ai_journeys SET automation_id = ? WHERE id = ?').bind(aid, j.id).run();
    await audit(c, 'automation.create', aid, { ai_journey: j.id, source: j.source, template: j.template_key });
    return back(c, `/app/automations/${aid}`, `Draft created from your goal — review every email, then activate.`);
  });

  // ───────── guardrails overview (newsletter tests + automation splits) ─────────
  dash.get('/guardrails', async (c) => {
    const pub = c.get('pub');
    const defRow = await one<any>(c.env, `SELECT config FROM experiment_guardrails WHERE pub_id = ? AND kind = 'default' AND ref_id = ''`, pub.id);
    const def = normalizeGuardrail(parseJSON(defRow?.config, {}));
    const autos = await all<any>(c.env, `SELECT a.id, a.name, a.status, g.config FROM automations a LEFT JOIN experiment_guardrails g ON g.pub_id = a.pub_id AND g.kind = 'automation' AND g.ref_id = a.id
      WHERE a.pub_id = ? AND a.status != 'archived' AND (a.steps LIKE '%"ab_split"%' OR a.draft_steps LIKE '%"ab_split"%') ORDER BY a.updated_at DESC`, pub.id);
    const tests = await all<any>(c.env, `SELECT s.id, s.post_id, s.subject, s.status, s.options, s.created_at, g.config FROM sends s LEFT JOIN experiment_guardrails g ON g.pub_id = s.pub_id AND g.kind = 'post' AND g.ref_id = s.post_id
      WHERE s.pub_id = ? AND s.kind = 'post' AND s.options LIKE '%"ab":{%' ORDER BY s.created_at DESC LIMIT 20`, pub.id);
    const events = await all<any>(c.env, 'SELECT * FROM guardrail_events WHERE pub_id = ? ORDER BY created_at DESC LIMIT 30', pub.id);
    const canEdit = can(c.get('role'), 'publish');
    return c.html(
      <DashLayout c={c} title="Experiment guardrails" section="automations" crumbs={[['/app/automations', 'Automations']]}
        actions={canEdit ? <ActionForm action="/app/automations/guardrails/check" label="Check now" kind="secondary" small={false} /> : undefined}>
        <Help>Guardrails watch every arm of an experiment — automation random splits and newsletter A/B / multivariate tests. When an arm's unsubscribe or complaint rate crosses your limit, or it earns too little versus the control, it is stopped automatically and everyone goes down the safe path. Every decision is logged below. Checked every 5 minutes, and right before a newsletter test picks its winner.</Help>
        <Card title="Newsletter tests — publication default">
          <form method="post" action="/app/automations/guardrails/default" class="stack">
            <GuardrailFields cfg={def} arms={undefined} />
            {canEdit && <div class="form-actions"><Btn>Save default</Btn></div>}
          </form>
        </Card>
        <Card title="Recent newsletter tests" pad={false}>
          <Table rows={tests} empty="No A/B or multivariate newsletter tests yet." cols={[
            { h: 'Subject', r: (t: any) => <a href={`/app/posts/${t.post_id}`}>{t.subject}</a> },
            { h: 'Status', r: (t: any) => <Status s={t.status} /> },
            { h: 'Guardrail', r: (t: any) => { const o = parseJSON<any>(t.options, {}); return o.guardrail ? <Badge tone="red">routed to {o.guardrail.safe}</Badge> : t.config ? <Badge tone={normalizeGuardrail(parseJSON(t.config, {})).enabled ? 'green' : 'gray'}>custom</Badge> : <Badge tone={def.enabled ? 'green' : 'gray'}>{def.enabled ? 'default' : 'off'}</Badge>; } },
            { h: '', class: 'right', r: (t: any) => <a href={`/app/automations/guardrails/send/${t.id}`}>Details</a> },
          ]} />
        </Card>
        <Card title="Automations with random splits" pad={false}>
          <Table rows={autos} empty="No automation uses a random split yet." cols={[
            { h: 'Automation', r: (a: any) => <a href={`/app/automations/${a.id}/guardrails`}>{a.name}</a> },
            { h: 'Status', r: (a: any) => <Status s={a.status} /> },
            { h: 'Guardrail', r: (a: any) => <Badge tone={a.config && normalizeGuardrail(parseJSON(a.config, {})).enabled ? 'green' : 'gray'}>{a.config && normalizeGuardrail(parseJSON(a.config, {})).enabled ? 'on' : 'off'}</Badge> },
          ]} />
        </Card>
        <Card title="Guardrail log"><EventList events={events} /></Card>
      </DashLayout>,
    );
  });

  dash.post('/guardrails/default', requirePerm('publish'), async (c) => {
    const f = await form(c.req);
    const cfg = normalizeGuardrail({ ...f, enabled: !!f.enabled });
    await saveGuardrail(c.env, c.get('pub').id, 'default', '', cfg);
    await audit(c, 'guardrails.default_saved', '', { ...cfg });
    return back(c, '/app/automations/guardrails', cfg.enabled ? 'Guardrails on for newsletter tests' : 'Default saved (guardrails off)');
  });

  dash.post('/guardrails/check', requirePerm('publish'), async (c) => {
    const n = await runGuardrails(c.env, c.get('pub').id);
    return back(c, c.req.header('referer')?.includes('/guardrails') ? new URL(c.req.header('referer')!).pathname : '/app/automations/guardrails', n ? `${n} guardrail decision${n === 1 ? '' : 's'} made — see the log` : 'All experiments are within their guardrails');
  });

  dash.get('/guardrails/send/:sid', async (c) => {
    const pub = c.get('pub');
    const s = await one<any>(c.env, `SELECT * FROM sends WHERE id = ? AND pub_id = ? AND kind = 'post'`, c.req.param('sid'), pub.id);
    if (!s) return c.notFound();
    const own = await one<any>(c.env, `SELECT config FROM experiment_guardrails WHERE pub_id = ? AND kind = 'post' AND ref_id = ?`, pub.id, s.post_id);
    const cfg = (await guardrailFor(c.env, pub.id, 'post', s.post_id)) || DEFAULT_GUARDRAIL;
    const arms = await sendArmStats(c.env, s.id, cfg.window_days);
    const o = parseJSON<any>(s.options, {});
    const events = await all<any>(c.env, `SELECT * FROM guardrail_events WHERE pub_id = ? AND kind = 'post' AND ref_id = ? ORDER BY created_at DESC`, pub.id, s.id);
    const letters = (o.ab?.subjects || ['A', 'B']).map((_: any, i: number) => String.fromCharCode(65 + i));
    return c.html(
      <DashLayout c={c} title={`Test: ${s.subject}`} section="automations" crumbs={[['/app/automations', 'Automations'], ['/app/automations/guardrails', 'Guardrails']]}>
        <p><Status s={s.status} /> {o.winner ? <>Winner: <strong>{o.winner}</strong></> : 'No winner yet'} {o.guardrail ? <Badge tone="red">guardrail routed everyone to {o.guardrail.safe}</Badge> : null}</p>
        <Card title="Variants" pad={false}><ArmTable arms={arms} label={(a) => `Variant ${a}`} /></Card>
        <Card title={own ? 'Guardrails for this post' : 'Guardrails for this post (using the publication default)'}>
          <form method="post" action={`/app/automations/guardrails/post/${s.post_id}`} class="stack">
            <input type="hidden" name="send_id" value={s.id} />
            <GuardrailFields cfg={cfg} arms={letters} />
            <div class="form-actions">{own && <Btn kind="ghost" name="reset" value="1">Use the default</Btn>}<Btn>Save for this post</Btn></div>
          </form>
        </Card>
        <Card title="Log"><EventList events={events} /></Card>
      </DashLayout>,
    );
  });

  dash.post('/guardrails/post/:postId', requirePerm('publish'), async (c) => {
    const pub = c.get('pub');
    const post = await one<any>(c.env, 'SELECT id FROM posts WHERE id = ? AND pub_id = ?', c.req.param('postId'), pub.id);
    if (!post) return c.notFound();
    const f = await form(c.req);
    if (f.reset) await removeGuardrail(c.env, pub.id, 'post', post.id);
    else await saveGuardrail(c.env, pub.id, 'post', post.id, normalizeGuardrail({ ...f, enabled: !!f.enabled }));
    return back(c, f.send_id ? `/app/automations/guardrails/send/${str(f.send_id, 40)}` : '/app/automations/guardrails', 'Guardrails saved');
  });
}

/** Per-automation guardrails tab (/app/automations/:id/guardrails). */
export function registerAutomationGuardrails(dash: Hono<AppEnv>, tabs: (c: Ctx, a: any) => any) {
  dash.get('/:id/guardrails', async (c) => {
    const pub = c.get('pub');
    const a = await one<any>(c.env, 'SELECT * FROM automations WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!a) return c.notFound();
    const cfg = (await guardrailFor(c.env, pub.id, 'automation', a.id)) || DEFAULT_GUARDRAIL;
    const live = parseJSON<Step[]>(a.steps, []);
    const splitSteps: Step[] = [];
    walk(live, (s) => { if (s.type === 'ab_split') splitSteps.push(s); });
    const draftSplits = !splitSteps.length && a.draft_steps && a.draft_steps.includes('"ab_split"');
    const stats = await Promise.all(splitSteps.map((s) => splitArmStats(c.env, a.id, s.id, cfg.window_days)));
    const events = await all<any>(c.env, `SELECT * FROM guardrail_events WHERE pub_id = ? AND kind = 'automation' AND ref_id = ? ORDER BY created_at DESC`, pub.id, a.id);
    const canEdit = can(c.get('role'), 'publish');
    return c.html(
      <DashLayout c={c} title={a.name} section="automations" wide crumbs={[['/app/automations', 'Automations']]} styles={['/static/automations.css']}>
        {tabs(c, a)}
        <Help>Guardrails judge each random split's paths: unsubscribes, spam complaints and revenue per recipient (paid orders and store orders) within the attribution window after the split. A path that crosses a limit is stopped, new and in-progress subscribers go down the safe path, and the decision is logged.</Help>
        <Card title="Guardrail settings">
          <form method="post" action={`/app/automations/${a.id}/guardrails`} class="stack">
            <GuardrailFields cfg={cfg} arms={['A', 'B']} />
            {canEdit && <div class="form-actions"><Btn>Save guardrails</Btn></div>}
          </form>
        </Card>
        {!splitSteps.length ? <Card><Empty icon="🎲" title={draftSplits ? 'Publish your draft to start the experiment' : 'No random split yet'} body="Add a “Random split” step in the builder to A/B test two paths. Guardrails apply to every split in this automation." /></Card> : splitSteps.map((s, i) => (
          <Card title={<span>🎲 Split {i + 1} — {s.config?.pct || 50}% path A {s.config?.guardrail ? <Badge tone="red">stopped — everyone takes path {s.config.guardrail.route === 'yes' ? 'A' : 'B'}</Badge> : <Badge tone="green">running</Badge>}</span>} pad={false}
            actions={s.config?.guardrail && canEdit ? <ActionForm action={`/app/automations/${a.id}/guardrails/reset`} fields={{ step_id: s.id }} label="Resume the split" kind="ghost" confirm="Resume random assignment for this split?" /> : undefined}>
            <ArmTable arms={stats[i]} label={(x) => `Path ${x}`} />
            {s.config?.guardrail?.reason && <div class="card-b small">{s.config.guardrail.reason}</div>}
          </Card>
        ))}
        <Card title="Log" actions={canEdit ? <ActionForm action={`/app/automations/${a.id}/guardrails/check`} label="Check now" kind="secondary" /> : undefined}><EventList events={events} /></Card>
      </DashLayout>,
    );
  });

  dash.post('/:id/guardrails', requirePerm('publish'), async (c) => {
    const pub = c.get('pub');
    const a = await one<any>(c.env, 'SELECT id FROM automations WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
    if (!a) return c.notFound();
    const f = await form(c.req);
    const cfg = normalizeGuardrail({ ...f, enabled: !!f.enabled, control: f.control === 'B' ? 'B' : 'A' });
    await saveGuardrail(c.env, pub.id, 'automation', a.id, cfg);
    await audit(c, 'guardrails.saved', a.id, { ...cfg });
    return back(c, `/app/automations/${a.id}/guardrails`, cfg.enabled ? 'Guardrails on' : 'Guardrails saved (off)');
  });

  dash.post('/:id/guardrails/check', requirePerm('publish'), async (c) => {
    const a = await one<any>(c.env, 'SELECT id FROM automations WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
    if (!a) return c.notFound();
    const n = await checkAutomation(c.env, a.id);
    return back(c, `/app/automations/${a.id}/guardrails`, n ? `Guardrail fired on ${n} split${n === 1 ? '' : 's'} — see the log` : 'All paths are within the guardrails');
  });

  dash.post('/:id/guardrails/reset', requirePerm('publish'), async (c) => {
    const f = await form(c.req);
    await resetSplit(c.env, c.req.param('id'), c.get('pub').id, str(f.step_id, 40));
    await audit(c, 'guardrails.split_resumed', c.req.param('id'), { step: f.step_id });
    return back(c, `/app/automations/${c.req.param('id')}/guardrails`, 'Split resumed — new subscribers are assigned at random again');
  });
}

