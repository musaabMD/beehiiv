/** @jsxImportSource hono/jsx */
// Subscribe form designer: draft/live versions, preview, compare, publish, embed codes.
import { Hono } from 'hono';
import type { AppEnv, Ctx } from '../../types';
import { one, all, run, insert, update } from '../../lib/db';
import { DEFAULT_FORM, formConfig, formCSS, formMarkup, type FormConfig } from '../../lib/forms';
import { audit } from '../../lib/auth';
import { siteUrl } from '../../lib/pub';
import { Card, Btn, LinkBtn, Field, Input, Textarea, Select, Check, Toggle, Table, Status, Empty, back, Muted, Help, ActionForm, Modal, OpenBtn, Copy, Code, Badge } from '../../ui/components';
import { page } from './shared';
import { form, str, int, now, id, ago, num, pct, parseJSON, esc } from '../../lib/util';

const app = new Hono<AppEnv>();
const FONTS: Array<[string, string]> = [
  ['Inter, -apple-system, Segoe UI, Helvetica, Arial, sans-serif', 'Inter / system sans'],
  ['Georgia, "Times New Roman", serif', 'Georgia (serif)'],
  ['"Helvetica Neue", Helvetica, Arial, sans-serif', 'Helvetica'],
  ['"Courier New", Courier, monospace', 'Monospace'],
  ['inherit', 'Inherit from host page'],
];

async function loadForm(c: Ctx) {
  return one<any>(c.env, 'SELECT * FROM forms WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
}

app.get('/forms', async (c) => {
  const rows = await all<any>(c.env, 'SELECT * FROM forms WHERE pub_id = ? ORDER BY created_at DESC', c.get('pub').id);
  return page(c, { title: 'Subscribe forms', sub: 'forms', actions: <OpenBtn target="#new-form" small>+ New form</OpenBtn> }, <>
    {rows.length ? (
      <Table<any> rows={rows} rowHref={(f) => `/app/audience/forms/${f.id}`} cols={[
        { h: 'Form', r: (f) => <a href={`/app/audience/forms/${f.id}`}>{f.name}</a> },
        { h: 'Type', r: (f) => <span class="small">{f.kind}{f.kind === 'embed' ? ` · ${f.layout}` : ''}</span> },
        { h: 'Status', r: (f) => !f.live ? <Badge tone="gray">draft</Badge> : f.draft !== f.live ? <Badge tone="amber">unpublished changes</Badge> : <Badge tone="green">live</Badge> },
        { h: 'Views', r: (f) => num(f.views) },
        { h: 'Signups', r: (f) => num(f.submissions) },
        { h: 'Conversion', r: (f) => pct(f.submissions, f.views) },
        { h: 'Updated', r: (f) => ago(f.published_at || f.created_at) },
      ]} />
    ) : <Card><Empty icon="✉" title="No forms yet" body="Create embeddable signup forms for WordPress, Webflow, or any site — plus pop-ups — with your own colors, fonts and success behavior." action={<OpenBtn target="#new-form">Create a form</OpenBtn>} /></Card>}
    <Modal id="new-form" title="New subscribe form">
      <form method="post" action="/app/audience/forms">
        <Field label="Name"><Input name="name" required autofocus placeholder="Homepage footer" /></Field>
        <Field label="Type"><Select name="kind" options={[['embed', 'Embedded form'], ['popup', 'Pop-up'], ['inline', 'Inline (inside posts & pages)']]} /></Field>
        <Field label="Layout"><Select name="layout" options={[['full', 'Full width'], ['fixed', 'Fixed width'], ['slim', 'Slim (email + button)']]} /></Field>
        <div class="form-actions"><Btn>Create</Btn></div>
      </form>
    </Modal>
  </>);
});

app.post('/forms', async (c) => {
  const f = await form(c.req);
  const fid = id(12);
  const kind = ['embed', 'popup', 'inline'].includes(f.kind) ? f.kind : 'embed';
  const layout = ['full', 'fixed', 'slim'].includes(f.layout) ? f.layout : 'full';
  const cfg: FormConfig = { ...DEFAULT_FORM, title: `Subscribe to ${c.get('pub').name}`, description: c.get('pub').description || DEFAULT_FORM.description };
  await insert(c.env, 'forms', { id: fid, pub_id: c.get('pub').id, name: str(f.name, 120) || 'Untitled form', kind, layout, draft: JSON.stringify(cfg), live: null, created_at: now() });
  return back(c, `/app/audience/forms/${fid}`, 'Form created — design it, then publish');
});

function cfgFromForm(f: Record<string, any>, prev: FormConfig): FormConfig {
  const color = (v: unknown, d: string) => (/^#[0-9a-f]{3,8}$/i.test(String(v)) ? String(v) : d);
  return {
    title: str(f.title, 200), description: str(f.description, 600), button: str(f.button, 60) || 'Subscribe', placeholder: str(f.placeholder, 80) || 'you@example.com',
    name_field: f.name_field === 'on', custom_fields: (f.custom_fields as string[]) || [], lists: (f.lists as string[]) || [],
    tags: str(f.tags).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
    success: { mode: f.success_mode === 'redirect' ? 'redirect' : 'message', message: str(f.success_message, 400) || DEFAULT_FORM.success.message, url: /^https?:\/\//.test(str(f.success_url)) ? str(f.success_url, 500) : '' },
    flow: { survey_id: str(f.flow_survey, 40), recommendations: f.flow_recommendations === 'on', referral: f.flow_referral === 'on' },
    popup: { delay: Math.max(0, int(f.popup_delay, 8)), scroll: Math.min(100, Math.max(0, int(f.popup_scroll, 0))), exit: f.popup_exit === 'on', frequency_days: Math.max(0, int(f.popup_frequency, 7)) },
    turnstile: f.turnstile === 'on',
    style: {
      bg: color(f.s_bg, prev.style.bg), text: color(f.s_text, prev.style.text), muted: color(f.s_muted, prev.style.muted), accent: color(f.s_accent, prev.style.accent),
      button_text: color(f.s_button_text, prev.style.button_text), border: color(f.s_border, prev.style.border), input_bg: color(f.s_input_bg, prev.style.input_bg),
      font: FONTS.some(([v]) => v === f.s_font) ? f.s_font : prev.style.font, radius: Math.min(40, Math.max(0, int(f.s_radius, prev.style.radius))), align: f.s_align === 'left' ? 'left' : 'center',
    },
  };
}

app.get('/forms/:id', async (c) => {
  const pub = c.get('pub');
  const fr = await loadForm(c);
  if (!fr) return back(c, '/app/audience/forms', 'Form not found', 'err');
  const cfg = formConfig(fr.draft);
  const [lists, fields, surveys] = await Promise.all([
    all<any>(c.env, 'SELECT id, name FROM lists WHERE pub_id = ? ORDER BY name', pub.id),
    all<any>(c.env, 'SELECT key, label FROM custom_fields WHERE pub_id = ? ORDER BY label', pub.id),
    all<any>(c.env, `SELECT id, title FROM surveys WHERE pub_id = ? AND status = 'active' ORDER BY title`, pub.id),
  ]);
  const app_ = c.env.APP_URL.replace(/\/$/, '');
  const changed = fr.live && fr.live !== fr.draft;
  const s = cfg.style;
  const iframe = `<iframe src="${app_}/embed/form/${fr.id}" width="100%" height="${fr.layout === 'slim' ? 90 : 260}" frameborder="0" scrolling="no" style="border:0;max-width:100%;background:transparent" title="Subscribe"></iframe>`;
  const js = fr.kind === 'popup' ? `<script async src="${app_}/embed/form/${fr.id}.js"></script>` : `<div data-openhive-form="${fr.id}"></div>\n<script async src="${app_}/embed/form/${fr.id}.js"></script>`;
  const attr = `<script async src="${app_}/embed/attribution.js"></script>`;
  return page(c, {
    title: fr.name, sub: 'forms', crumbs: [['/app/audience/forms', 'Forms']], scripts: ['/static/audience-ui.js'], wide: true,
    actions: <>
      {fr.live && <LinkBtn small href={`/app/audience/forms/${fr.id}/compare`}>Compare draft vs live</LinkBtn>}
      <ActionForm action={`/app/audience/forms/${fr.id}/duplicate`} label="Duplicate" />
      <ActionForm action={`/app/audience/forms/${fr.id}/delete`} label="Delete" kind="danger" confirm="Delete this form? Embeds using it will stop working." />
      <form method="post" action={`/app/audience/forms/${fr.id}/publish`} class="inline-form"><Btn small kind="primary" disabled={!!fr.live && !changed}>{fr.live ? (changed ? 'Publish changes' : 'Published') : 'Publish'}</Btn></form>
    </>,
  }, <>
    <div class="callout">{!fr.live ? 'This form is a draft. Publish it to make the embed codes live.' : changed ? 'You have unpublished changes. Embeds keep showing the live version until you publish.' : `Live since ${ago(fr.published_at)} · ${num(fr.views)} views · ${num(fr.submissions)} signups (${pct(fr.submissions, fr.views)})`}</div>
    <div class="form-designer">
      <form method="post" action={`/app/audience/forms/${fr.id}`} data-autosave data-preview="#form-preview">
        <Card title="Basics">
          <Field label="Form name"><Input name="name" value={fr.name} /></Field>
          <div class="grid g2">
            <Field label="Type"><Select name="kind" value={fr.kind} options={[['embed', 'Embedded'], ['popup', 'Pop-up'], ['inline', 'Inline']]} /></Field>
            <Field label="Layout"><Select name="layout" value={fr.layout} options={[['full', 'Full width'], ['fixed', 'Fixed width'], ['slim', 'Slim']]} /></Field>
          </div>
          <Field label="Heading"><Input name="title" value={cfg.title} /></Field>
          <Field label="Description"><Textarea name="description" value={cfg.description} rows={2} /></Field>
          <div class="grid g2">
            <Field label="Email placeholder"><Input name="placeholder" value={cfg.placeholder} /></Field>
            <Field label="Button text"><Input name="button" value={cfg.button} /></Field>
          </div>
        </Card>
        <Card title="Fields & lists">
          <Toggle name="name_field" checked={cfg.name_field} label="Ask for name" />
          {fields.length > 0 && <Field label="Custom fields">{fields.map((fd) => <Check name="custom_fields[]" value={fd.key} label={fd.label} checked={cfg.custom_fields.includes(fd.key)} />)}</Field>}
          {lists.length > 0 ? <Field label="Lists readers can choose" hint="Leave all unchecked to add signups to your default list.">{lists.map((l) => <Check name="lists[]" value={l.id} label={l.name} checked={cfg.lists.includes(l.id)} />)}</Field> : <Help>Create <a href="/app/audience/lists">newsletter lists</a> to let readers pick.</Help>}
          <Field label="Tag new subscribers" hint="Comma separated"><Input name="tags" value={cfg.tags.join(', ')} placeholder="from-homepage" /></Field>
        </Card>
        <Card title="After signup">
          <Field label="Success behavior"><Select name="success_mode" value={cfg.success.mode} options={[['message', 'Show a message'], ['redirect', 'Redirect to a URL']]} /></Field>
          <Field label="Success message"><Input name="success_message" value={cfg.success.message} /></Field>
          <Field label="Redirect URL"><Input name="success_url" type="url" value={cfg.success.url} placeholder={siteUrl(c.env, pub) + '/welcome'} /></Field>
          <Field label="Signup flow" hint="Runs right after subscribing on your site (ignored when redirecting).">
            <Select name="flow_survey" value={cfg.flow.survey_id} options={[['', 'No survey'], ...surveys.map((sv) => [sv.id, `Survey: ${sv.title}`] as [string, string])]} />
          </Field>
          <Check name="flow_recommendations" checked={cfg.flow.recommendations} label="Show recommended newsletters" />
          <Check name="flow_referral" checked={cfg.flow.referral} label="Show referral link" />
        </Card>
        {fr.kind === 'popup' && (
          <Card title="Pop-up trigger">
            <div class="grid g2">
              <Field label="Show after (seconds)"><Input name="popup_delay" type="number" min="0" value={cfg.popup.delay} /></Field>
              <Field label="…or after scrolling (%)"><Input name="popup_scroll" type="number" min="0" max="100" value={cfg.popup.scroll} /></Field>
            </div>
            <Check name="popup_exit" checked={cfg.popup.exit} label="Show on exit intent" />
            <Field label="Show again after (days)"><Input name="popup_frequency" type="number" min="0" value={cfg.popup.frequency_days} /></Field>
          </Card>
        )}
        <Card title="Style">
          <div class="grid g3 swatches">
            {([['s_bg', 'Background', s.bg], ['s_text', 'Text', s.text], ['s_muted', 'Muted text', s.muted], ['s_accent', 'Button', s.accent], ['s_button_text', 'Button text', s.button_text], ['s_border', 'Border', s.border], ['s_input_bg', 'Input background', s.input_bg]] as const).map(([n, l, v]) => <Field label={l}><input class="input" type="color" name={n} value={v} /></Field>)}
            <Field label="Corner radius"><Input name="s_radius" type="number" min="0" max="40" value={s.radius} /></Field>
            <Field label="Alignment"><Select name="s_align" value={s.align} options={[['center', 'Center'], ['left', 'Left']]} /></Field>
          </div>
          <Field label="Font"><Select name="s_font" value={s.font} options={FONTS} /></Field>
        </Card>
        <Card title="Bot protection">
          <Help>Every form includes a hidden honeypot, a render-time check and rate limits; suspicious signups get a one-click confirmation step.</Help>
          {c.env.TURNSTILE_SITE_KEY ? <Toggle name="turnstile" checked={cfg.turnstile} label="Add Cloudflare Turnstile challenge" /> : <Help>Set TURNSTILE_SITE_KEY and TURNSTILE_SECRET to add a Turnstile challenge.</Help>}
        </Card>
        <div class="form-actions sticky-actions"><span class="muted small" data-save-status>Changes save as a draft automatically</span><Btn kind="secondary">Save draft</Btn></div>
      </form>
      <div class="designer-preview">
        <Card title="Draft preview" actions={<div class="device-toggle" data-device="#form-preview"><button type="button" class="on" data-w="100%">Desktop</button><button type="button" data-w="375px">Mobile</button></div>}>
          <div class="preview-stage"><iframe id="form-preview" src={`/app/audience/forms/${fr.id}/preview?v=draft`} class="preview-frame" style="min-height:360px" title="Draft preview" /></div>
        </Card>
        <Card title="Embed codes">
          {!fr.live && <div class="callout warn">Publish the form to activate these codes.</div>}
          <h4>JavaScript embed {fr.kind === 'popup' ? '(pop-up)' : '(recommended)'}</h4>
          <Help>Paste into any site — WordPress (Custom HTML block), Webflow (Embed element), Squarespace, Ghost, Framer or plain HTML.</Help>
          <Code>{js}</Code><Copy value={js} label="Copy JS embed" />
          {fr.kind !== 'popup' && <><h4 style="margin-top:16px">iframe embed</h4><Help>Use where scripts aren't allowed.</Help><Code>{iframe}</Code><Copy value={iframe} label="Copy iframe" /></>}
          <h4 style="margin-top:16px">Attribution script</h4>
          <Help>Add once to every page of your website. It remembers UTM parameters and referrers from a visitor's first visit, so signups are credited to the right source even if they subscribe later on another page.</Help>
          <Code>{attr}</Code><Copy value={attr} label="Copy attribution script" />
          <h4 style="margin-top:16px">Direct link</h4>
          <Copy value={`${app_}/embed/form/${fr.id}`} />
        </Card>
      </div>
    </div>
  </>);
});

app.post('/forms/:id', async (c) => {
  const fr = await loadForm(c);
  if (!fr) return c.json({ error: 'not found' }, 404);
  const f = await form(c.req);
  const cfg = cfgFromForm(f, formConfig(fr.draft));
  await update(c.env, 'forms', fr.id, {
    name: str(f.name, 120) || fr.name, kind: ['embed', 'popup', 'inline'].includes(f.kind) ? f.kind : fr.kind, layout: ['full', 'fixed', 'slim'].includes(f.layout) ? f.layout : fr.layout, draft: JSON.stringify(cfg),
  }, c.get('pub').id);
  if ((c.req.header('accept') || '').includes('json')) return c.json({ ok: true, message: 'Draft saved', changed: fr.live ? JSON.stringify(cfg) !== fr.live : true });
  return back(c, `/app/audience/forms/${fr.id}`, 'Draft saved');
});

app.post('/forms/:id/publish', async (c) => {
  const fr = await loadForm(c);
  if (!fr) return back(c, '/app/audience/forms', 'Form not found', 'err');
  await run(c.env, 'UPDATE forms SET live = draft, published_at = ? WHERE id = ?', now(), fr.id);
  await audit(c, 'form.publish', fr.id);
  return back(c, `/app/audience/forms/${fr.id}`, 'Form published — embeds now show this version');
});

app.post('/forms/:id/duplicate', async (c) => {
  const fr = await loadForm(c);
  if (!fr) return back(c, '/app/audience/forms', 'Form not found', 'err');
  const nid = id(12);
  await insert(c.env, 'forms', { id: nid, pub_id: fr.pub_id, name: fr.name + ' (copy)', kind: fr.kind, layout: fr.layout, draft: fr.draft, live: null, created_at: now() });
  return back(c, `/app/audience/forms/${nid}`, 'Form duplicated');
});

app.post('/forms/:id/delete', async (c) => {
  await run(c.env, 'DELETE FROM forms WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
  return back(c, '/app/audience/forms', 'Form deleted');
});

/** Rendered preview of a version (inputs are inert). */
app.get('/forms/:id/preview', async (c) => {
  const pub = c.get('pub');
  const fr = await loadForm(c);
  if (!fr) return c.text('not found', 404);
  const v = c.req.query('v') === 'live' ? 'live' : 'draft';
  const json = v === 'live' ? fr.live : fr.draft;
  if (!json) return c.html(`<body style="font-family:system-ui;color:#6b7280;display:grid;place-items:center;height:90vh;margin:0">Not published yet</body>`);
  const cfg = formConfig(json);
  const lists = await all<any>(c.env, 'SELECT id, name FROM lists WHERE pub_id = ?', pub.id);
  const fields = await all<any>(c.env, 'SELECT key, label FROM custom_fields WHERE pub_id = ?', pub.id);
  const markup = formMarkup(cfg, { formId: fr.id, layout: fr.layout, action: '#', lists, fields });
  const bg = c.req.query('bg') || '#f4f4f5';
  return c.html(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:24px;background:${esc(bg)};font-family:system-ui}${formCSS(cfg.style)}</style></head><body>${fr.kind === 'popup' ? `<div style="max-width:460px;margin:20px auto;box-shadow:0 20px 60px rgba(0,0,0,.25);border-radius:14px">${markup}</div>` : markup}<script>document.querySelectorAll('form').forEach(f=>f.addEventListener('submit',e=>{e.preventDefault();f.querySelector('.ohf-msg').textContent=${JSON.stringify(cfg.success.mode === 'redirect' ? 'Preview: would redirect to ' + cfg.success.url : cfg.success.message).replace(/</g, '\\u003c')}}))</script></body></html>`);
});

app.get('/forms/:id/compare', async (c) => {
  const fr = await loadForm(c);
  if (!fr) return back(c, '/app/audience/forms', 'Form not found', 'err');
  const d = formConfig(fr.draft);
  const l = formConfig(fr.live);
  const flat = (o: any, p = ''): Record<string, string> => Object.entries(o).reduce((acc, [k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? { ...acc, ...flat(v, p + k + '.') } : { ...acc, [p + k]: Array.isArray(v) ? v.join(', ') : String(v) }), {} as Record<string, string>);
  const fd = flat(d), fl = flat(l);
  const diffs = Object.keys({ ...fd, ...fl }).filter((k) => fd[k] !== fl[k]);
  return page(c, {
    title: `Compare: ${fr.name}`, sub: 'forms', crumbs: [['/app/audience/forms', 'Forms'], [`/app/audience/forms/${fr.id}`, fr.name]], wide: true,
    actions: <form method="post" action={`/app/audience/forms/${fr.id}/publish`} class="inline-form"><Btn small disabled={!diffs.length}>Publish draft</Btn></form>,
  }, <>
    <div class="grid g2">
      <Card title="Live"><iframe src={`/app/audience/forms/${fr.id}/preview?v=live`} class="preview-frame" style="min-height:360px" /></Card>
      <Card title="Draft"><iframe src={`/app/audience/forms/${fr.id}/preview?v=draft`} class="preview-frame" style="min-height:360px" /></Card>
    </div>
    <Card title={`${diffs.length} change${diffs.length === 1 ? '' : 's'}`} pad={false}>
      <Table<string> rows={diffs} empty="Draft and live are identical." cols={[
        { h: 'Setting', r: (k) => <code>{k}</code> },
        { h: 'Live', r: (k) => <span class="diff-old">{fl[k] || '—'}</span> },
        { h: 'Draft', r: (k) => <span class="diff-new">{fd[k] || '—'}</span> },
      ]} />
    </Card>
  </>);
});

export default app;
