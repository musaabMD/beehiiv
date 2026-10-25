// Subscribe form configuration + rendering (used by the form designer, iframe embeds, JS embeds and the site).
import { esc, parseJSON } from './util';

export interface FormStyle { bg: string; text: string; muted: string; accent: string; button_text: string; font: string; radius: number; border: string; input_bg: string; align: 'left' | 'center' }
export interface FormConfig {
  title: string;
  description: string;
  button: string;
  placeholder: string;
  name_field: boolean;
  custom_fields: string[];                 // custom field keys shown as inputs
  lists: string[];                         // reader-selectable list ids
  tags: string[];                          // tags applied on submit
  success: { mode: 'message' | 'redirect'; message: string; url: string };
  flow: { survey_id: string; recommendations: boolean; referral: boolean };
  popup: { delay: number; scroll: number; exit: boolean; frequency_days: number };
  turnstile: boolean;
  style: FormStyle;
}

export const DEFAULT_FORM: FormConfig = {
  title: 'Subscribe to our newsletter',
  description: 'Get the latest posts delivered straight to your inbox.',
  button: 'Subscribe',
  placeholder: 'you@example.com',
  name_field: false,
  custom_fields: [],
  lists: [],
  tags: [],
  success: { mode: 'message', message: "Thanks for subscribing! Check your inbox.", url: '' },
  flow: { survey_id: '', recommendations: false, referral: false },
  popup: { delay: 8, scroll: 0, exit: false, frequency_days: 7 },
  turnstile: false,
  style: { bg: '#ffffff', text: '#111827', muted: '#6b7280', accent: '#f59e0b', button_text: '#111827', font: 'Inter, -apple-system, Segoe UI, Helvetica, Arial, sans-serif', radius: 10, border: '#e5e7eb', input_bg: '#ffffff', align: 'center' },
};

export function formConfig(json: string | null | undefined): FormConfig {
  const c = parseJSON<Partial<FormConfig>>(json, {});
  return {
    ...DEFAULT_FORM, ...c,
    success: { ...DEFAULT_FORM.success, ...(c.success || {}) },
    flow: { ...DEFAULT_FORM.flow, ...(c.flow || {}) },
    popup: { ...DEFAULT_FORM.popup, ...(c.popup || {}) },
    style: { ...DEFAULT_FORM.style, ...(c.style || {}) },
    custom_fields: c.custom_fields || [], lists: c.lists || [], tags: c.tags || [],
  };
}

export function formCSS(s: FormStyle, scope = '.ohf'): string {
  return `${scope}{--ohf-bg:${s.bg};--ohf-text:${s.text};--ohf-muted:${s.muted};--ohf-accent:${s.accent};--ohf-btext:${s.button_text};--ohf-r:${Number(s.radius) || 0}px;--ohf-border:${s.border};--ohf-ibg:${s.input_bg};font-family:${s.font};color:var(--ohf-text);background:var(--ohf-bg);border:1px solid var(--ohf-border);border-radius:calc(var(--ohf-r) + 4px);padding:24px;box-sizing:border-box;text-align:${s.align};line-height:1.5}
${scope} *{box-sizing:border-box}
${scope}.ohf-full{width:100%}${scope}.ohf-fixed{max-width:480px;margin:0 auto}${scope}.ohf-slim{padding:10px;border-radius:calc(var(--ohf-r) + 2px)}
${scope} h3{margin:0 0 6px;font-size:22px;line-height:1.25}${scope} p.ohf-d{margin:0 0 14px;color:var(--ohf-muted);font-size:15px}
${scope} form{display:flex;flex-wrap:wrap;gap:8px;margin:0;${s.align === 'center' ? 'justify-content:center' : ''}}
${scope}.ohf-slim form{flex-wrap:nowrap}
${scope} input[type=email],${scope} input[type=text]{flex:1 1 200px;min-width:0;height:44px;padding:0 14px;border:1px solid var(--ohf-border);border-radius:var(--ohf-r);background:var(--ohf-ibg);color:var(--ohf-text);font:inherit;font-size:15px}
${scope} button{height:44px;padding:0 20px;border:0;border-radius:var(--ohf-r);background:var(--ohf-accent);color:var(--ohf-btext);font:inherit;font-size:15px;font-weight:650;cursor:pointer;white-space:nowrap}
${scope} button:hover{filter:brightness(.95)}${scope} button:disabled{opacity:.6}
${scope} .ohf-lists{flex-basis:100%;display:flex;gap:14px;flex-wrap:wrap;font-size:14px;${s.align === 'center' ? 'justify-content:center' : ''}}
${scope} .ohf-hp{position:absolute!important;left:-9999px!important;width:1px;height:1px;opacity:0}
${scope} .ohf-msg{flex-basis:100%;font-size:14px;margin-top:4px}${scope} .ohf-err{color:#b91c1c}${scope} .ohf-ok{font-size:16px;font-weight:600}
${scope} .ohf-sug{background:none;border:0;padding:0;height:auto;color:var(--ohf-accent);text-decoration:underline;font-weight:600;font-size:14px}`;
}

export interface FieldDef { key: string; label: string }

/** Inner form markup (no <style>). action = absolute POST url. */
export function formMarkup(cfg: FormConfig, o: { formId: string; layout: string; action: string; lists?: Array<{ id: string; name: string }>; fields?: FieldDef[]; turnstileKey?: string; source?: string; hideHeader?: boolean }): string {
  const lists = (o.lists || []).filter((l) => cfg.lists.includes(l.id));
  const fields = (o.fields || []).filter((f) => cfg.custom_fields.includes(f.key));
  const slim = o.layout === 'slim';
  return `<div class="ohf ohf-${esc(o.layout || 'full')}" data-ohf="${esc(o.formId)}">
${!slim && !o.hideHeader && cfg.title ? `<h3>${esc(cfg.title)}</h3>` : ''}${!slim && !o.hideHeader && cfg.description ? `<p class="ohf-d">${esc(cfg.description)}</p>` : ''}
<form method="post" action="${esc(o.action)}" data-ohf-form>
${cfg.name_field && !slim ? `<input type="text" name="name" placeholder="Your name" autocomplete="name">` : ''}
${slim ? '' : fields.map((f) => `<input type="text" name="custom[${esc(f.key)}]" placeholder="${esc(f.label)}">`).join('')}
<input type="email" name="email" placeholder="${esc(cfg.placeholder)}" required autocomplete="email">
<input type="text" name="website" class="ohf-hp" tabindex="-1" autocomplete="off" aria-hidden="true">
<input type="hidden" name="_t" value="${Date.now()}">
<input type="hidden" name="form_id" value="${esc(o.formId)}">
<input type="hidden" name="source" value="${esc(o.source || 'form')}">
<input type="hidden" name="utm" value="" data-ohf-utm>
${lists.length && !slim ? `<div class="ohf-lists">${lists.map((l) => `<label><input type="checkbox" name="lists[]" value="${esc(l.id)}" checked> ${esc(l.name)}</label>`).join('')}</div>` : ''}
${cfg.turnstile && o.turnstileKey ? `<div class="cf-turnstile" data-sitekey="${esc(o.turnstileKey)}" style="flex-basis:100%"></div>` : ''}
<button type="submit">${esc(cfg.button || 'Subscribe')}</button>
<div class="ohf-msg" aria-live="polite"></div>
</form></div>`;
}
