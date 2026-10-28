// AI Revenue Journey Engine: "describe your goal" (+ optional product, price, link, audience segment, tone) → a complete
// draft automation (entry points, segment filters, delays, branches, full email copy in the editor block format).
// - Workers AI (lib/ai TEXT_MODEL) returns strict JSON in a compact schema; validateJourney() checks it against TRIGGERS,
//   STEP_TYPES and the segment rule FIELDS, sanitizes copy and rebuilds the step tree with fresh ids.
// - Fallback (no AI binding, engine = 'template', AI error or invalid output): pick the closest of the 45 templates by
//   intent + keyword score and adapt it (name, product/price/link in the CTAs, audience filter, tone).
// The result is previewed (ai_journeys row) and only becomes a *draft* automation when the user confirms.
import type { Env, Publication } from '../types';
import { TRIGGERS, STEP_TYPES, walk, type Step } from './automations';
import { availableTemplates, templateTrigger, type AutomationTemplate } from './automation-templates';
import { FIELDS, type RuleGroup } from './segments';
import { aiText, TEXT_MODEL } from './ai';
import { inline } from './sanitize';
import { id, now, stripTags } from './util';

export interface JourneyInput {
  goal: string;
  product?: string;
  price?: string;
  url?: string;
  segment_id?: string;
  segment_name?: string;
  tone?: string;
}

export interface JourneyPlan {
  source: 'ai' | 'template';
  name: string;
  description: string;
  /** stored trigger JSON (one entry point, or packed list) */
  trigger: any;
  steps: Step[];
  notes: string[];
  template_key?: string;
  ms: number;
}

export const TONES: Array<[string, string]> = [['friendly', 'Friendly'], ['professional', 'Professional'], ['playful', 'Playful'], ['urgent', 'Urgent / direct'], ['personal', 'Personal (founder voice)']];

export const GOAL_EXAMPLES = [
  'Turn free readers into paid subscribers',
  'Sell my $49 course to new subscribers',
  "Win back customers who haven't bought in 90 days",
  'Welcome new subscribers and get them to reply',
  'Recover abandoned carts from my store',
  'Get engaged readers to refer their friends',
];

// ───────── validation ─────────
const MAX_STEPS = 40, MAX_EMAILS = 10, MAX_DEPTH = 3;
const STEP_ALIASES: Record<string, string> = { email: 'send_email', send: 'send_email', wait: 'delay', delay_days: 'delay', if: 'condition', branch: 'condition', if_else: 'condition', split: 'ab_split', ab_test: 'ab_split', random_split: 'ab_split', tag: 'add_tag', untag: 'remove_tag', wait_for: 'wait_until', set_field: 'update_field', end: 'exit' };
const TRIGGER_ALIASES: Record<string, string> = { subscribe: 'signup', subscribed: 'signup', new_subscriber: 'welcome', tag: 'tag_added', purchased: 'purchase', order: 'purchase', store_purchase: 'external_purchase', abandoned_cart: 'cart_abandoned', inactivity: 'inactive', manual: 'api', upgrade: 'upgraded', cancel: 'downgraded' };
// trigger config keys we accept from the model (ids we can't know — product_id, tier_id, list_id… — are dropped)
const TRIGGER_KEYS: Record<string, string[]> = {
  signup: ['sources'], tag_added: ['tag'], field_updated: ['key'], inactive: ['days'], date_field: ['key', 'offset_days'],
  link_clicked: ['url_contains'], external_purchase: ['platform', 'product_contains', 'min_total'], cart_abandoned: ['delay_hours', 'min_value'],
};
// rule fields that don't need an id from this publication
const RULE_FIELDS = new Set(['tier', 'status', 'source', 'utm_source', 'utm_campaign', 'country', 'created_at', 'engagement', 'open_count', 'click_count', 'referral_count', 'last_open_at', 'last_click_at', 'tag', 'clicked_url', 'purchased', 'custom', 'value_score', 'clv', 'purchase_likelihood', 'churn_risk', 'subscription_status', 'trial', 'ext_last_order', 'ext_orders_count', 'ext_total_spent']);
const BLOCK_TYPES = new Set(['paragraph', 'heading', 'button', 'list', 'quote', 'divider']);

class Invalid extends Error {}

function protectMerge(html: string): string {
  // the sanitizer only keeps http(s) hrefs: keep merge-tag links ({{publication.url}}, {{referral_url}}) intact
  const tags: string[] = [];
  const masked = String(html).replace(/\{\{\s*[a-z_.|]+\s*\}\}[^"'\s<]*/gi, (m) => (tags.push(m), `https://merge.invalid/${tags.length - 1}`));
  return inline(masked).replace(/https:\/\/merge\.invalid\/(\d+)/g, (_x, n) => tags[Number(n)] || '');
}

function cleanUrl(u: unknown, fallback: string): string {
  const s = String(u || '').trim();
  if (/^\{\{\s*publication\.url\s*\}\}[\w\-/?=&.#%]*$/.test(s) || /^\{\{\s*referral_url\s*\}\}$/.test(s)) return s;
  if (/^https?:\/\/[^\s"'<>]+$/.test(s)) return s.slice(0, 500);
  return fallback;
}

function toBlocks(body: unknown, notes: string[], defaultUrl: string): any[] {
  const list = Array.isArray(body) ? body : typeof body === 'string' ? String(body).split(/\n{2,}/).map((html) => ({ type: 'paragraph', html })) : [];
  const out: any[] = [];
  for (const raw of list.slice(0, 20)) {
    const b: any = typeof raw === 'string' ? { type: 'paragraph', html: raw } : raw || {};
    const type = String(b.type || 'paragraph').toLowerCase();
    if (!BLOCK_TYPES.has(type)) { notes.push(`dropped an unsupported "${type}" block`); continue; }
    const html = protectMerge(String(b.html ?? b.text ?? '').slice(0, 3000));
    if (type === 'paragraph' && html.trim()) out.push({ id: id(8), type, data: { html } });
    else if (type === 'heading' && html.trim()) out.push({ id: id(8), type, data: { level: Math.min(3, Math.max(2, Number(b.level) || 2)), html } });
    else if (type === 'quote' && html.trim()) out.push({ id: id(8), type, data: { html, cite: stripTags(String(b.cite || '')).slice(0, 120), style: { variant: 'line' } } });
    else if (type === 'button') {
      const label = stripTags(String(b.label || b.text || '')).slice(0, 60).trim();
      if (label) out.push({ id: id(8), type, data: { label, url: cleanUrl(b.url, defaultUrl), align: 'center' } });
    } else if (type === 'list') {
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, 12).map((x: any) => protectMerge(String(typeof x === 'string' ? x : x?.html || '').slice(0, 500))).filter((x: string) => x.trim());
      if (items.length) out.push({ id: id(8), type, data: { ordered: !!b.ordered, items } });
    } else if (type === 'divider') out.push({ id: id(8), type, data: { style: 'line' } });
  }
  return out;
}

function toRules(raw: unknown, notes: string[]): any[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as any).rules) ? (raw as any).rules : [];
  const out: any[] = [];
  for (const r of list.slice(0, 6)) {
    const field = String(r?.field || '');
    const def = FIELDS[field];
    const cmp = String(r?.cmp || r?.op || '');
    if (!def || !RULE_FIELDS.has(field) || !def.cmps.includes(cmp)) { notes.push(`dropped rule ${field || '?'} ${cmp || '?'}`); continue; }
    let value: any = r?.value ?? '';
    if (def.kind === 'date' || def.kind === 'number') value = cmp === 'never' ? '' : Number(value) || 0;
    if (field === 'purchased') { if (cmp !== 'any') { notes.push('dropped a product-specific purchase rule'); continue; } value = ''; }
    if (def.options && cmp !== 'never' && !def.options.includes(String(value))) { notes.push(`dropped rule ${field} = ${value}`); continue; }
    const rule: any = { field, cmp, value: typeof value === 'string' ? value.slice(0, 120) : value };
    if (field === 'custom') rule.key = String(r?.key || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40);
    out.push(rule);
  }
  return out;
}

function normType(t: unknown, aliases: Record<string, string>): string {
  const s = String(t || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return aliases[s] || s;
}

interface Ctx { notes: string[]; count: number; emails: number; defaultUrl: string }

function toSteps(raw: unknown, ctx: Ctx, depth: number): Step[] {
  if (!Array.isArray(raw)) return [];
  if (depth > MAX_DEPTH) throw new Invalid('branches are nested too deeply');
  const out: Step[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const src: any = { ...(r as any), ...((r as any).config && typeof (r as any).config === 'object' ? (r as any).config : {}) };
    const type = normType(src.type, STEP_ALIASES);
    if (!STEP_TYPES[type]) throw new Invalid(`unknown step type "${src.type}"`);
    if (++ctx.count > MAX_STEPS) throw new Invalid(`more than ${MAX_STEPS} steps`);
    const s: Step = { id: id(10), type, config: {} };
    switch (type) {
      case 'send_email': {
        const subject = stripTags(String(src.subject || '')).slice(0, 150).trim();
        if (!subject) throw new Invalid('an email has no subject');
        const blocks = toBlocks(src.body ?? src.blocks ?? src.doc?.blocks ?? src.content, ctx.notes, ctx.defaultUrl);
        if (!blocks.length) throw new Invalid(`email "${subject}" has no body`);
        if (++ctx.emails > MAX_EMAILS) throw new Invalid(`more than ${MAX_EMAILS} emails`);
        s.config = { subject, preview_text: stripTags(String(src.preview_text || src.preview || '')).slice(0, 150), doc: { blocks } };
        break;
      }
      case 'delay': {
        const unit = ['minutes', 'hours', 'days', 'weeks'].includes(String(src.unit)) ? String(src.unit) : 'days';
        const amount = Math.round(Number(src.amount ?? src.days ?? src.hours));
        if (!isFinite(amount) || amount < 1) throw new Invalid('a delay has no length');
        s.config = { amount: Math.min(amount, unit === 'minutes' ? 1440 : unit === 'hours' ? 720 : unit === 'weeks' ? 52 : 365), unit };
        break;
      }
      case 'wait_until': {
        const rules = toRules(src.rules, ctx.notes);
        if (!rules.length) throw new Invalid('a "wait until" step has no valid condition');
        s.config = { mode: 'condition', rules: { op: 'and', rules }, timeout_days: Math.min(60, Math.max(1, Math.round(Number(src.timeout_days) || 7))) };
        break;
      }
      case 'condition':
      case 'ab_split': {
        if (type === 'condition') {
          const rules = toRules(src.rules, ctx.notes);
          if (!rules.length) throw new Invalid('an if/else branch has no valid condition');
          s.config = { rules: { op: src.match === 'any' || src.op === 'or' ? 'or' : 'and', rules } };
        } else s.config = { pct: Math.min(90, Math.max(10, Math.round(Number(src.pct) || 50))) };
        s.yes = toSteps(src.yes ?? src.then ?? src.a, ctx, depth + 1);
        s.no = toSteps(src.no ?? src.else ?? src.b, ctx, depth + 1);
        if (!s.yes.length && !s.no.length) throw new Invalid(`a ${type === 'condition' ? 'branch' : 'split'} has no steps on either path`);
        break;
      }
      case 'add_tag':
      case 'remove_tag': {
        const tags = [].concat(src.tags ?? src.tag ?? []).map((t: any) => String(t).toLowerCase().trim().replace(/[^a-z0-9 _-]/g, '').slice(0, 40)).filter(Boolean).slice(0, 5);
        if (!tags.length) throw new Invalid('a tag step has no tag');
        s.config = { tags };
        break;
      }
      case 'update_field': {
        const key = String(src.key || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40);
        if (!key) throw new Invalid('an update-field step has no field');
        s.config = { key, value: String(src.value ?? '').slice(0, 200) };
        break;
      }
      case 'grant_premium': s.config = { days: Math.min(90, Math.max(1, Math.round(Number(src.days) || 7))) }; break;
      case 'notify': s.config = { email: '', subject: stripTags(String(src.subject || 'Journey update')).slice(0, 120), body: stripTags(String(src.body || '')).slice(0, 500) }; break;
      case 'exit': case 'unsubscribe': break;
      default:
        // needs ids we can't invent (lists, other automations, webhook URLs): not allowed from the model
        throw new Invalid(`step "${type}" needs settings the AI can't know`);
    }
    out.push(s);
  }
  return out;
}

function toTriggers(raw: unknown, notes: string[]): Array<{ type: string; config: any; filter?: RuleGroup }> {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: Array<{ type: string; config: any; filter?: RuleGroup }> = [];
  for (const t of list.slice(0, 4)) {
    const type = normType((t as any)?.type ?? t, TRIGGER_ALIASES);
    if (!TRIGGERS[type]) throw new Invalid(`unknown entry point "${(t as any)?.type ?? t}"`);
    if (type === 'segment_entered' || type === 'webhook') throw new Invalid(`entry point "${type}" needs settings the AI can't know`);
    const cfgIn = { ...((t as any)?.config || {}) };
    for (const k of TRIGGER_KEYS[type] || []) if ((t as any)?.[k] !== undefined && cfgIn[k] === undefined) cfgIn[k] = (t as any)[k];
    const config: any = {};
    for (const k of TRIGGER_KEYS[type] || []) {
      if (cfgIn[k] === undefined || cfgIn[k] === '') continue;
      if (k === 'sources') { const src = [].concat(cfgIn[k]).map(String).filter((x) => FIELDS.source.options!.includes(x)); if (src.length) config.sources = src; }
      else if (['days', 'offset_days', 'min_total', 'delay_hours', 'min_value'].includes(k)) config[k] = Number(cfgIn[k]) || 0;
      else config[k] = String(cfgIn[k]).slice(0, 80);
    }
    if (type === 'inactive' && !config.days) config.days = 60;
    if (type === 'tag_added' && config.tag) config.tag = String(config.tag).toLowerCase();
    const dropped = Object.keys(cfgIn).filter((k) => !(k in config));
    if (dropped.length) notes.push(`entry point ${type}: ignored ${dropped.join(', ')}`);
    const rules = toRules((t as any)?.filter, notes);
    out.push({ type, config, ...(rules.length ? { filter: { op: 'and', rules } as RuleGroup } : {}) });
  }
  if (!out.length) throw new Invalid('no entry point');
  return out;
}

/** Strict validation of a model's JSON plan. Throws Invalid with a reason. */
export function validateJourney(raw: any, input: JourneyInput): { name: string; description: string; triggers: Array<{ type: string; config: any; filter?: RuleGroup }>; steps: Step[]; notes: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Invalid('not a JSON object');
  const notes: string[] = [];
  const triggers = toTriggers(raw.triggers ?? raw.entry_points ?? raw.trigger, notes);
  const ctx: Ctx = { notes, count: 0, emails: 0, defaultUrl: input.url || '{{publication.url}}' };
  const steps = toSteps(raw.steps, ctx, 0);
  if (!ctx.emails) throw new Invalid('the journey sends no email');
  return { name: stripTags(String(raw.name || input.goal)).slice(0, 100), description: stripTags(String(raw.description || '')).slice(0, 400), triggers, steps, notes };
}

// ───────── AI ─────────
function schemaPrompt(): string {
  const trig = Object.entries(TRIGGERS).filter(([k]) => !['segment_entered', 'webhook'].includes(k)).map(([k, v]) => `${k} (${v.label}${TRIGGER_KEYS[k] ? `; config: ${TRIGGER_KEYS[k].join(', ')}` : ''})`).join('; ');
  const fields = [...RULE_FIELDS].map((f) => `${f}: ${FIELDS[f]?.cmps.join('|')}${FIELDS[f]?.options ? ` [${FIELDS[f].options!.join('|')}]` : ''}`).join('; ');
  return `JSON schema:
{"name": string, "description": string,
 "triggers": [{"type": TRIGGER, "config": {...}, "filter": [RULE, ...] (optional audience filter)}],
 "steps": [STEP, ...]}
TRIGGER types: ${trig}.
STEP is one of:
 {"type":"send_email","subject":string,"preview_text":string,"body":[BLOCK,...]}
 {"type":"delay","amount":number,"unit":"hours"|"days"}
 {"type":"condition","rules":[RULE,...],"yes":[STEP...],"no":[STEP...]}
 {"type":"ab_split","pct":50,"yes":[STEP...],"no":[STEP...]}
 {"type":"wait_until","rules":[RULE,...],"timeout_days":number}
 {"type":"add_tag","tags":[string]} | {"type":"remove_tag","tags":[string]} | {"type":"update_field","key":string,"value":string}
 {"type":"grant_premium","days":number} | {"type":"notify","subject":string,"body":string} | {"type":"exit"}
RULE: {"field":FIELD,"cmp":CMP,"value":...}. FIELD: CMP options — ${fields}. Date fields take a number of days. purchased only supports cmp "any" (bought anything).
BLOCK: {"type":"paragraph","html":string} | {"type":"heading","html":string} | {"type":"button","label":string,"url":string} | {"type":"list","items":[string]} | {"type":"quote","html":string,"cite":string}
Inline html may use <b>, <i>, <a href>. Merge tags: {{subscriber.first_name|there}}, {{publication.name}}, {{publication.url}}, {{referral_url}}.
Links: {{publication.url}} (site), {{publication.url}}/upgrade (paid plans), {{publication.url}}/shop (products), or the product link given.`;
}

async function generateWithAI(env: Env, pub: Publication, input: JourneyInput): Promise<{ plan: ReturnType<typeof validateJourney> | null; error?: string }> {
  const system = `You are an expert lifecycle email marketer who designs revenue automations for a newsletter platform. Reply with one JSON object only — no prose, no markdown fences.\n${schemaPrompt()}`;
  const ctxLines = [
    `Publication: ${pub.name}${pub.description ? ` — ${pub.description}` : ''}`,
    `Goal: ${input.goal}`,
    input.product && `Product / offer: ${input.product}`,
    input.price && `Price: ${input.price}`,
    input.url && `Product link: ${input.url}`,
    input.segment_name && `Audience: only subscribers in the segment "${input.segment_name}" (the platform adds this filter; don't add one)`,
    `Tone: ${input.tone || 'friendly'}`,
  ].filter(Boolean).join('\n');
  const prompt = `${ctxLines}

Design the complete automation for this goal: pick the right entry point(s), sensible delays, at least one if/else branch on engagement or purchase so buyers/converters stop getting sales emails, and 3–6 emails. Write the full email copy (2–5 short paragraphs each, one clear call-to-action button, mention the product and price where it fits, no placeholders like [Name] — use merge tags). Tag converters.
Rules that make journeys work:
- Entry filters are checked at the moment of entry. For "hasn't done X in N days" goals use the "inactive" entry point (no opens for N days) with an audience filter, or enter on a purchase and then "delay" N days followed by a condition — never a purchase entry point filtered on "not within N days".
- Paid conversion: a subscriber has converted when tier eq "premium"; link to {{publication.url}}/upgrade. Product sales: purchased any (or ext_last_order within_days for store customers).
- Branch on something meaningful (converted / bought / opened or clicked recently); never on status eq active.
- Before every sales email after the first, check whether they already converted and stop (exit) if so.
Return the JSON object now.`;
  const r = await aiJsonReply(env, system, prompt);
  if (!r.ok) return { plan: null, error: r.text };
  const raw = parseLoose(r.text);
  if (raw === undefined) return { plan: null, error: `the AI reply was not valid JSON (${r.text.length} chars, began “${r.text.slice(0, 60).replace(/\s+/g, ' ')}…”)` };
  if (!raw) return { plan: null, error: 'the AI reply contained no JSON' };
  try { return { plan: validateJourney(raw, input) }; } catch (e: any) {
    if (e instanceof Invalid) return { plan: null, error: 'the AI plan failed validation: ' + e.message };
    throw e;
  }
}


/** One Workers AI call in JSON mode (falls back to a plain call on models/runtimes without response_format). */
async function aiJsonReply(env: Env, system: string, prompt: string): Promise<{ ok: boolean; text: string }> {
  if (!env.AI) return { ok: false, text: 'AI is not configured' };
  const messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
  try {
    const r: any = await env.AI.run(TEXT_MODEL as any, { messages, max_tokens: 4096, temperature: 0.4, response_format: { type: 'json_object' } } as any);
    const out = r?.response ?? r?.result?.response;
    if (out && typeof out === 'object') return { ok: true, text: JSON.stringify(out) };
    if (typeof out === 'string' && out.trim()) return { ok: true, text: out };
  } catch { /* JSON mode unsupported or failed: plain call below */ }
  return aiText(env, prompt, system, 4096);
}

/** Parse a model reply: strips fences/prose and trailing commas, closes a truncated object. undefined = unusable. */
export function parseLoose(text: string): any {
  const t = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  if (start < 0) return undefined;
  const body = t.slice(start);
  const end = body.lastIndexOf('}');
  const tries = [end >= 0 ? body.slice(0, end + 1) : body];
  const stack: string[] = [];
  let inStr = false, escp = false;
  for (const ch of body) {
    if (inStr) { if (escp) escp = false; else if (ch === '\\') escp = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === '{') stack.push('}'); else if (ch === '[') stack.push(']'); else if (ch === '}' || ch === ']') stack.pop();
  }
  if (stack.length) tries.push(body + (inStr ? '"' : '') + stack.reverse().join(''));
  for (const c of tries) {
    for (const v of [c, c.replace(/,\s*([}\]])/g, '$1')]) { try { return JSON.parse(v); } catch { /* next */ } }
  }
  return undefined;
}

// ───────── template fallback ─────────
const INTENTS: Array<{ re: RegExp; keys: string[] }> = [
  { re: /cart|checkout|abandon/i, keys: ['cart_abandoned_discount', 'cart_abandoned'] },
  { re: /trial/i, keys: ['trial_conversion'] },
  { re: /(free|readers?).*(paid|premium|upgrade|member)|upgrade|go paid|paid (sub|plan|member)|premium/i, keys: ['upgrade_nurture', 'trial_conversion'] },
  { re: /cancel|churn|downgrad/i, keys: ['churn_save'] },
  { re: /(win.?back|haven'?t (bought|purchased|ordered)|lapsed|lost) .*(customer|buyer|bought|purchase|order)|customers? who haven'?t/i, keys: ['winback_survey', 'replenish'] },
  { re: /win.?back|inactive|re-?engage|haven'?t opened|stopped opening|dormant/i, keys: ['winback_survey', 'reengage'] },
  { re: /course|class|workshop|cohort|ebook|e-book|guide|template|product|sell|launch|\$\s?\d+/i, keys: ['product_launch', 'lead_magnet_nurture', 'upsell'] },
  { re: /webinar|event|live/i, keys: ['webinar_reminders', 'event_drip'] },
  { re: /refer|invite friends|word of mouth/i, keys: ['referral_ask'] },
  { re: /review|testimonial/i, keys: ['review_request'] },
  { re: /after (they )?(buy|purchase)|post.?purchase|repeat (purchase|order)|upsell|cross.?sell/i, keys: ['upsell', 'post_purchase'] },
  { re: /lead magnet|freebie|download|checklist/i, keys: ['lead_magnet', 'lead_magnet_nurture'] },
  { re: /welcome|onboard|new subscriber|reply/i, keys: ['welcome', 'welcome_5day'] },
  { re: /birthday/i, keys: ['birthday'] },
  { re: /nps|survey|feedback/i, keys: ['nps', 'survey_followup'] },
];

const STOP = new Set(['the', 'a', 'an', 'to', 'my', 'and', 'or', 'of', 'for', 'in', 'into', 'who', 'that', 'with', 'new', 'our', 'your', 'on', 'them', 'their', 'get', 'turn', 'make', 'want', 'i', 'we']);
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9$ ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));

/** Closest template for a goal (+ the score breakdown, for the preview's "why this template"). */
export function pickTemplate(input: JourneyInput): { tpl: AutomationTemplate; why: string } {
  const tpls = availableTemplates();
  const text = [input.goal, input.product].filter(Boolean).join(' ');
  const scores = new Map<string, number>();
  let rank = 0; // the first (most specific) matching intent dominates keyword overlap
  INTENTS.forEach((it) => { if (it.re.test(text)) { const w = rank++ === 0 ? 30 : 8; it.keys.forEach((k, j) => scores.set(k, (scores.get(k) || 0) + w - j)); } });
  const q = new Set(words(text));
  for (const t of tpls) {
    const hay = words(`${t.name} ${t.description} ${t.category}`);
    const overlap = hay.filter((w) => q.has(w) || [...q].some((x) => x.length > 4 && w.startsWith(x.slice(0, 5)))).length;
    scores.set(t.key, (scores.get(t.key) || 0) + overlap);
  }
  const ranked = tpls.map((t) => ({ t, s: scores.get(t.key) || 0 })).sort((a, b) => b.s - a.s);
  const best = ranked[0]?.s > 0 ? ranked[0].t : tpls.find((t) => t.key === 'welcome') || tpls[0];
  const intent = INTENTS.find((it) => it.re.test(text) && it.keys.includes(best.key));
  return { tpl: best, why: intent ? `matched the goal's intent (${best.category})` : 'closest by keywords' };
}

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{23F0}]️?/gu;

/** Adapt a template to the goal: name, product/price/link in CTAs, audience filter, tone. */
export function adaptTemplate(tpl: AutomationTemplate, input: JourneyInput): { name: string; description: string; trigger: any; steps: Step[]; notes: string[] } {
  const notes: string[] = [];
  const steps = tpl.steps();
  const product = (input.product || '').trim();
  const price = (input.price || '').trim();
  const url = input.url && /^https?:\/\//.test(input.url) ? input.url.trim() : '';
  const tone = input.tone || 'friendly';
  let firstSales = true;
  let emails = 0;
  walk(steps, (s) => {
    if (s.type !== 'send_email') return;
    emails++;
    const blocks: any[] = s.config?.doc?.blocks || [];
    const btnIdx = blocks.findIndex((b) => b.type === 'button');
    if (btnIdx >= 0 && (product || url)) {
      const b = blocks[btnIdx];
      const salesy = /\/(shop|upgrade)|get it|buy|start|join|see|offer/i.test(`${b.data.url} ${b.data.label}`);
      if (salesy) {
        if (url) b.data.url = url;
        if (product && /get it|buy|now|see what|offer|plans/i.test(b.data.label)) b.data.label = `Get ${product}`.slice(0, 60);
        if (product && firstSales) {
          blocks.splice(btnIdx, 0, { id: id(8), type: 'paragraph', data: { html: `<strong>${esc(product)}</strong>${price ? ` — ${esc(price)}` : ''}` } });
          firstSales = false;
        }
      }
    }
    if (tone === 'professional' || tone === 'personal') s.config.subject = String(s.config.subject).replace(EMOJI, '').replace(/\s{2,}/g, ' ').trim();
    if (tone === 'personal') { const last = blocks[blocks.length - 1]; if (last?.type === 'paragraph' && /team/.test(last.data.html)) last.data.html = '— {{publication.name}}'; }
  });
  if (product && firstSales && emails) {
    // no CTA to hang the offer on: add it to the first email
    let done = false;
    walk(steps, (s) => { if (done || s.type !== 'send_email') return; s.config.doc.blocks.push({ id: id(8), type: 'paragraph', data: { html: `<strong>${esc(product)}</strong>${price ? ` — ${esc(price)}` : ''}` } }, { id: id(8), type: 'button', data: { label: `Get ${product}`.slice(0, 60), url: url || '{{publication.url}}/shop', align: 'center' } }); done = true; });
  }
  if (tone === 'urgent') {
    const mails: Step[] = []; walk(steps, (s) => { if (s.type === 'send_email') mails.push(s); });
    const last = mails[mails.length - 1];
    if (last && mails.length > 1 && !/last|final|ends/i.test(last.config.subject)) last.config.subject = 'Last chance: ' + last.config.subject;
  }
  // "… in 90 days": inactivity entry points and the first wait use the goal's number of days
  const days = Number((input.goal.match(/(\d{1,3})\s*days?/i) || [])[1]) || 0;
  const trigger = templateTrigger(tpl);
  const tlist: any[] = trigger.triggers?.length ? trigger.triggers : [trigger];
  if (/new (subscriber|reader|signup|member)s?/i.test(input.goal) && !tlist.some((t) => ['welcome', 'signup'].includes(t.type))) {
    tlist.splice(0, tlist.length, { type: 'welcome', config: {} });
    notes.push('Entry point: new subscribers (welcome), so every new reader gets the sequence.');
  }
  if (days) {
    for (const t of tlist) if (t.type === 'inactive') { t.config = { ...t.config, days }; notes.push(`Entry point: no opens for ${days} days.`); }
  }
  if (/customer|bought|buyer|purchas|order/i.test(input.goal) && tlist.some((t) => t.type === 'inactive')) {
    for (const t of tlist) if (t.type === 'inactive') t.filter = { op: 'and', rules: [{ field: 'purchased', cmp: 'any', value: '' }] };
    notes.push('Only customers (anyone who bought something) enter. With a connected store you can switch the filter to “Store: last order — not within days”.');
  }
  if (product || price || url) notes.push(`Added ${[product && 'the product', price && 'its price', url && 'your link'].filter(Boolean).join(', ')} to the call-to-action${firstSales ? '' : 's'}.`);
  if (tone !== 'friendly') notes.push(`Tone "${tone}": adjusted subjects and sign-off; review the copy to match your voice.`);
  return { name: goalName(input.goal) || tpl.name, description: `${tpl.description} (Adapted from the “${tpl.name}” template for: ${input.goal})`.slice(0, 400), trigger: tlist.length === 1 ? tlist[0] : { ...tlist[0], triggers: tlist }, steps, notes };
}

function esc(s: string) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }
function goalName(goal: string) { const g = stripTags(goal).trim().replace(/\s+/g, ' '); return g ? (g[0].toUpperCase() + g.slice(1)).slice(0, 90) : ''; }

/** Stored trigger JSON + the audience segment filter on every entry point. */
function withAudience(trigger: any, input: JourneyInput): any {
  const list = (trigger?.triggers?.length ? trigger.triggers : [trigger]).map((t: any) => ({ ...t, config: t.config || {} }));
  if (input.segment_id) {
    const rule = { field: 'segment', cmp: 'in', value: input.segment_id };
    for (const t of list) t.filter = t.filter?.rules?.length ? { op: 'and', rules: [...t.filter.rules, rule] } : { op: 'and', rules: [rule] };
  }
  return list.length === 1 ? list[0] : { ...list[0], triggers: list };
}

/**
 * Generate a journey plan. engine 'auto' uses Workers AI when bound and falls back to a template on any failure;
 * 'template' skips the AI (also the test hook for the fallback path).
 */
export async function generateJourney(env: Env, pub: Publication, input: JourneyInput, opts: { engine?: 'auto' | 'template' } = {}): Promise<JourneyPlan> {
  const t0 = now();
  const notes: string[] = [];
  if (opts.engine !== 'template') {
    if (!env.AI) notes.push('Workers AI isn’t configured on this instance, so the closest template was adapted instead.');
    else {
      try {
        const r = await generateWithAI(env, pub, input);
        if (r.plan) {
          const trigger = withAudience(r.plan.triggers.length === 1 ? r.plan.triggers[0] : { ...r.plan.triggers[0], triggers: r.plan.triggers }, input);
          return { source: 'ai', name: r.plan.name || goalName(input.goal), description: r.plan.description, trigger, steps: r.plan.steps, notes: [...new Set(r.plan.notes)].slice(0, 12), ms: now() - t0 };
        }
        notes.push(`AI draft not used — ${r.error}. Adapted the closest template instead.`);
      } catch (e: any) {
        notes.push(`AI draft failed (${String(e?.message || e).slice(0, 120)}). Adapted the closest template instead.`);
      }
    }
  }
  const { tpl, why } = pickTemplate(input);
  const a = adaptTemplate(tpl, input);
  notes.push(`Based on the “${tpl.name}” template — ${why}.`, ...a.notes);
  return { source: 'template', name: a.name, description: a.description, trigger: withAudience(a.trigger, input), steps: a.steps, notes, template_key: tpl.key, ms: now() - t0 };
}

export { Invalid as JourneyInvalid };
