// MCP (Model Context Protocol) server: tool registry + JSON-RPC 2.0 dispatcher (streamable HTTP, JSON responses).
// Lets Claude, ChatGPT and other AI clients work inside a publication with an API key.
import type { Env, Publication, Post, Subscriber } from '../types';
import { one, all, run, val, insert, update } from './db';
import { parseDoc, type Block } from './render';
import { FIELDS, recalcSegment, snapshotToStatic, countMatching, EMPTY_GROUP, type RuleGroup } from './segments';
import { TRIGGERS, STEP_TYPES, publishDraft, enroll } from './automations';
import { aiImage } from './ai';
import { getSubscriber, getTags, subscribe, addTags } from './subscribers';
import { siteUrl, settings } from './pub';
import { emit } from './events';
import { markdownToBlocks } from './markdown';
import { postStats, providerStats, summary, growthSeries, earnings, statsSentence } from './stats';
import { createPost, updatePost, serializePost, serializeSub, iso } from '../routes/api/rest';
import { DOCS } from './docs-content';
import { id, now, slugify, parseJSON, stripTags, money, clamp, int, DAY } from './util';

export const PROTOCOL_VERSION = '2025-06-18';
export const SERVER_INFO = { name: 'openhive', title: 'OpenHive', version: '1.0.0' };

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  run: (env: Env, pub: Publication, args: any) => Promise<unknown>;
}

const S = (props: Record<string, any>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const num = (description: string) => ({ type: 'integer', description });
const arr = (description: string, items: Record<string, unknown> = { type: 'string' }) => ({ type: 'array', description, items });
const obj = (description: string) => ({ type: 'object', description, additionalProperties: true });

class ToolError extends Error {}

const blocksToText = (blocks: Block[]): string =>
  blocks
    .map((b) => {
      const d = b.data || {};
      switch (b.type) {
        case 'heading': return `${'#'.repeat(d.level || 2)} ${stripTags(d.html || '')}`;
        case 'paragraph': return stripTags(d.html || '');
        case 'list': return (d.items || []).map((x: string, i: number) => `${d.ordered ? `${i + 1}.` : '-'} ${stripTags(x)}`).join('\n');
        case 'quote': return `> ${stripTags(d.html || '')}`;
        case 'code': return '```' + (d.lang || '') + '\n' + (d.code || '') + '\n```';
        case 'image': return `![${d.alt || ''}](${d.src})`;
        case 'paywall': return '--- paywall ---';
        case 'columns': return (d.columns || []).map((c: any) => blocksToText(c.blocks || [])).join('\n\n');
        case 'section': case 'dynamic': return blocksToText(d.blocks || []);
        default: return `[${b.type}]`;
      }
    })
    .filter(Boolean)
    .join('\n\n');

async function findPost(env: Env, pub: Publication, ref: string): Promise<Post> {
  const p = await one<Post>(env, 'SELECT * FROM posts WHERE pub_id = ? AND (id = ? OR slug = ?)', pub.id, ref, ref);
  if (!p) throw new ToolError(`Post "${ref}" not found. Use list_posts to find ids.`);
  return p;
}

async function ownerId(env: Env, pub: Publication): Promise<string | null> {
  return (await one<any>(env, 'SELECT owner_id FROM workspaces WHERE id = ?', pub.workspace_id))?.owner_id ?? null;
}

const FIELD_DOC = Object.entries(FIELDS).map(([k, f]) => `${k} (${f.cmps.join('|')}${f.options ? `; values: ${f.options.join(',')}` : ''})`).join('; ');

export const TOOLS: Tool[] = [
  // ───────── posts ─────────
  {
    name: 'list_posts', title: 'List posts', description: 'List posts (newest first) with status and headline stats.',
    inputSchema: S({ status: str('draft|scheduled|published|archived'), limit: num('Max results (default 20, max 100)'), query: str('Search in titles') }),
    annotations: { readOnlyHint: true },
    run: async (env, pub, a) => {
      const rows = await all<Post>(env, `SELECT * FROM posts WHERE pub_id = ? ${a.status ? 'AND status = ?' : ''} ${a.query ? 'AND title LIKE ?' : ''} ORDER BY created_at DESC LIMIT ?`, pub.id, ...(a.status ? [a.status] : []), ...(a.query ? [`%${a.query}%`] : []), clamp(int(a.limit, 20), 1, 100));
      const out = [];
      for (const p of rows) {
        const s = p.status === 'published' ? await postStats(env, pub.id, p.id) : null;
        out.push({ id: p.id, title: p.title, status: p.status, published_at: iso(p.published_at), scheduled_at: iso(p.scheduled_at), web_url: `${siteUrl(env, pub)}/p/${p.slug}`, ...(s ? { delivered: s.delivered, open_rate: s.open_rate, click_rate: s.click_rate } : {}) });
      }
      return out;
    },
  },
  {
    name: 'get_post', title: 'Get post', description: 'Get a post: metadata, content as Markdown-like text, and engagement stats.',
    inputSchema: S({ id: str('Post id or slug') }, ['id']), annotations: { readOnlyHint: true },
    run: async (env, pub, a) => {
      const p = await findPost(env, pub, a.id);
      const stats = await postStats(env, pub.id, p.id);
      return { ...serializePost(env, pub, p), text: blocksToText(parseDoc(p.content).blocks), stats, summary: p.status === 'published' ? statsSentence(p.title, stats) : `Draft "${p.title}" (${p.word_count} words).` };
    },
  },
  {
    name: 'draft_post', title: 'Draft a post', description: 'Create a draft post from Markdown (headings, lists, quotes, code fences, images, tables; a line "--- paywall ---" inserts a paywall break). Optionally start from a template.',
    inputSchema: S({ title: str('Post title'), subtitle: str('Subtitle'), markdown: str('Body in Markdown'), template_id: str('Template id to start from'), email_subject: str('Email subject (defaults to title)'), preview_text: str('Inbox preview text'), audience: str('all|free|premium'), platform: str('email|web|both') }, ['title']),
    run: async (env, pub, a) => {
      const p = await createPost(env, pub, a);
      return { id: p.id, title: p.title, status: p.status, word_count: p.word_count, edit_url: `${env.APP_URL.replace(/\/$/, '')}/app/posts/${p.id}`, web_url: `${siteUrl(env, pub)}/p/${p.slug}` };
    },
  },
  {
    name: 'update_post', title: 'Update a post', description: 'Edit a post: replace the body (markdown), append/prepend markdown, or change title/subtitle/subject/preview/audience.',
    inputSchema: S({ id: str('Post id or slug'), title: str('New title'), subtitle: str(''), email_subject: str(''), preview_text: str(''), audience: str('all|free|premium'), markdown: str('Replace the whole body'), append_markdown: str('Add to the end'), prepend_markdown: str('Add to the beginning') }, ['id']),
    run: async (env, pub, a) => {
      const p = await findPost(env, pub, a.id);
      const b: Record<string, any> = {};
      for (const k of ['title', 'subtitle', 'email_subject', 'preview_text', 'audience']) if (a[k] !== undefined) b[k] = a[k];
      if (a.markdown) b.markdown = a.markdown;
      else if (a.append_markdown || a.prepend_markdown) {
        const cur = parseDoc(p.content).blocks;
        b.blocks = [...(a.prepend_markdown ? markdownToBlocks(a.prepend_markdown) : []), ...cur, ...(a.append_markdown ? markdownToBlocks(a.append_markdown) : [])];
      }
      const u = await updatePost(env, pub, p, b);
      return { id: u.id, title: u.title, status: u.status, word_count: u.word_count, updated_at: iso(u.updated_at) };
    },
  },
  {
    name: 'set_ab_test', title: 'Set subject line A/B test', description: 'Configure a subject line A/B test on a draft or scheduled post. A sample of the audience receives each subject; the winner (by opens or clicks) goes to everyone else.',
    inputSchema: S({ post_id: str('Post id or slug'), subjects: arr('2-5 subject lines'), sample_pct: num('Percent of audience in the test (2-50, default 20)'), wait_minutes: num('Minutes before picking the winner (default 60)'), metric: str('opens|clicks') }, ['post_id', 'subjects']),
    run: async (env, pub, a) => {
      const p = await findPost(env, pub, a.post_id);
      if (!['draft', 'scheduled'].includes(p.status)) throw new ToolError('A/B tests can only be set before sending.');
      const subjects = (a.subjects || []).filter(Boolean).slice(0, 5);
      if (subjects.length < 2) throw new ToolError('Provide at least 2 subject lines.');
      const ab = { subjects, sample_pct: clamp(int(a.sample_pct, 20), 2, 50), wait_minutes: clamp(int(a.wait_minutes, 60), 5, 1440), metric: a.metric === 'clicks' ? 'clicks' : 'opens' };
      await updatePost(env, pub, p, { ab_test: ab, email_subject: subjects[0] });
      return { post_id: p.id, ab_test: ab, note: `${ab.sample_pct}% of recipients will be split across ${subjects.length} subjects; the winner by ${ab.metric} is sent to the rest after ${ab.wait_minutes} minutes.` };
    },
  },
  // ───────── analytics ─────────
  {
    name: 'get_stats', title: 'Get stats', description: 'Answer questions like "what was my open rate / CTR / revenue last month?". Returns numbers plus a plain-English summary. Pass post_id for a single post.',
    inputSchema: S({ days: num('Period in days (default 30)'), post_id: str('Optional post id or slug') }), annotations: { readOnlyHint: true },
    run: async (env, pub, a) => {
      if (a.post_id) {
        const p = await findPost(env, pub, a.post_id);
        const s = await postStats(env, pub.id, p.id);
        return { post: { id: p.id, title: p.title }, ...s, summary: statsSentence(p.title, s) };
      }
      return summary(env, pub.id, clamp(int(a.days, 30), 1, 365));
    },
  },
  {
    name: 'compare_posts', title: 'Compare posts', description: 'Compare performance across many posts in one request (open rate, CTR, clicks, unsubscribes, web views), sorted.',
    inputSchema: S({ post_ids: arr('Specific post ids (optional)'), limit: num('Most recent N published posts when post_ids is omitted (default 20, max 100)'), sort_by: str('open_rate|click_rate|unique_clicks|unsubscribes|web_views|published_at') }), annotations: { readOnlyHint: true },
    run: async (env, pub, a) => {
      const posts = a.post_ids?.length
        ? await all<Post>(env, `SELECT * FROM posts WHERE pub_id = ? AND id IN (${a.post_ids.map(() => '?').join(',')})`, pub.id, ...a.post_ids)
        : await all<Post>(env, `SELECT * FROM posts WHERE pub_id = ? AND status = 'published' ORDER BY published_at DESC LIMIT ?`, pub.id, clamp(int(a.limit, 20), 1, 100));
      const rows: any[] = [];
      for (const p of posts) {
        const s = await postStats(env, pub.id, p.id);
        rows.push({ id: p.id, title: p.title, published_at: iso(p.published_at), delivered: s.delivered, open_rate: s.open_rate, click_rate: s.click_rate, unique_clicks: s.unique_clicks, unsubscribes: s.unsubscribes, web_views: s.web_views });
      }
      const key = a.sort_by || 'open_rate';
      rows.sort((x: any, y: any) => (key === 'published_at' ? String(y[key]).localeCompare(String(x[key])) : (y[key] || 0) - (x[key] || 0)));
      const avg = (k: string) => (rows.length ? Math.round((rows.reduce((n, r: any) => n + (r[k] || 0), 0) / rows.length) * 100) / 100 : 0);
      return { posts: rows, averages: { open_rate: avg('open_rate'), click_rate: avg('click_rate') }, best: rows[0]?.title ?? null, summary: rows.length ? `Across ${rows.length} posts the average open rate is ${avg('open_rate')}% and CTR ${avg('click_rate')}%. Best by ${key}: "${rows[0].title}".` : 'No posts to compare.' };
    },
  },
  {
    name: 'deliverability_by_provider', title: 'Deliverability by mailbox provider', description: 'Delivery, bounce, complaint, open and click rates per mailbox provider (Gmail, Outlook, Yahoo, Apple…) for a post.',
    inputSchema: S({ post_id: str('Post id or slug') }, ['post_id']), annotations: { readOnlyHint: true },
    run: async (env, pub, a) => {
      const p = await findPost(env, pub, a.post_id);
      return { post: { id: p.id, title: p.title }, providers: await providerStats(env, pub.id, p.id) };
    },
  },
  {
    name: 'reports', title: 'Growth & earnings reports', description: 'Subscriber growth report (daily new/unsubscribed + acquisition sources) or earnings report (orders by day/kind, MRR, ads/boost earnings).',
    inputSchema: S({ report: str('growth|earnings'), days: num('Period in days (default 30)') }, ['report']), annotations: { readOnlyHint: true },
    run: async (env, pub, a) => (a.report === 'earnings' ? earnings(env, pub.id, clamp(int(a.days, 30), 1, 365)) : growthSeries(env, pub.id, clamp(int(a.days, 30), 1, 365))),
  },
  // ───────── audience ─────────
  {
    name: 'get_subscriber', title: 'Look up a subscriber', description: "A subscriber's full profile, tags, acquisition source, engagement score, per-post engagement history and recent activity.",
    inputSchema: S({ email_or_id: str('Email address or subscriber id') }, ['email_or_id']), annotations: { readOnlyHint: true },
    run: async (env, pub, a) => {
      const s = await getSubscriber(env, pub.id, a.email_or_id);
      if (!s) throw new ToolError('Subscriber not found.');
      const history = await all<any>(env, `SELECT p.title, d.status, d.sent_at, d.opened_at, d.open_count, d.clicked_at, d.click_count FROM deliveries d JOIN sends se ON se.id = d.send_id LEFT JOIN posts p ON p.id = se.post_id WHERE d.subscriber_id = ? ORDER BY d.created_at DESC LIMIT 50`, s.id);
      const activity = await all<any>(env, 'SELECT type, data, created_at FROM activity WHERE subscriber_id = ? ORDER BY created_at DESC LIMIT 50', s.id);
      const orders = await all<any>(env, `SELECT kind, amount_cents, currency, status, created_at FROM orders WHERE subscriber_id = ? ORDER BY created_at DESC LIMIT 20`, s.id);
      return { ...serializeSub(s, await getTags(env, s.id)), email_history: history.map((h) => ({ post: h.title || '(automation email)', status: h.status, sent_at: iso(h.sent_at), opened: !!h.opened_at, opens: h.open_count, clicked: !!h.clicked_at, clicks: h.click_count })), activity: activity.map((x) => ({ type: x.type, data: parseJSON(x.data, {}), at: iso(x.created_at) })), orders: orders.map((o) => ({ ...o, created_at: iso(o.created_at) })) };
    },
  },
  {
    name: 'add_subscriber', title: 'Add a subscriber', description: 'Subscribe an email address (validated; double opt-in respected) with optional tags.',
    inputSchema: S({ email: str('Email'), name: str('Name'), tags: arr('Tags to add') }, ['email']),
    run: async (env, pub, a) => {
      const r = await subscribe(env, pub, { email: a.email, name: a.name, source: 'api', tags: a.tags, strict: true });
      if (!r.ok) throw new ToolError(r.error || 'Invalid email');
      return { id: r.subscriber!.id, email: r.subscriber!.email, status: r.subscriber!.status, created: r.created };
    },
  },
  {
    name: 'list_segments', title: 'List segments', description: 'List audience segments with subscriber counts.',
    inputSchema: S({}), annotations: { readOnlyHint: true },
    run: async (env, pub) => (await all<any>(env, 'SELECT id, name, kind, description, cached_count, rules FROM segments WHERE pub_id = ? ORDER BY name', pub.id)).map((s) => ({ ...s, rules: parseJSON(s.rules, {}) })),
  },
  {
    name: 'create_segment_from_description', title: 'Build a segment', description: `Build a segment from a plain-English description. Translate the description into rules: {"op":"and"|"or","rules":[{"field","cmp","value"} | nested group]}. Fields (comparators): ${FIELD_DOC}. Notes: days-based comparators take a number; tag takes the tag name; custom takes {"key","value"}; poll takes {"poll_id","option_id"}; segment/list/automation/post/product/event take an id. Set dry_run to preview the count without saving.`,
    inputSchema: S({ name: str('Segment name'), description: str('The plain-English description'), rules: obj('Rule group JSON'), kind: str('dynamic (default) | static'), dry_run: { type: 'boolean', description: 'Only count matches' } }, ['name', 'rules']),
    run: async (env, pub, a) => {
      const rules: RuleGroup = a.rules && Array.isArray(a.rules.rules) ? a.rules : { op: 'and', rules: Array.isArray(a.rules) ? a.rules : [] };
      for (const r of JSON.stringify(rules).matchAll(/"field":"([^"]+)"/g)) if (!FIELDS[r[1]]) throw new ToolError(`Unknown field "${r[1]}".`);
      const count = await countMatching(env, pub.id, rules);
      if (a.dry_run) return { matches: count, rules };
      const sid = id();
      await insert(env, 'segments', { id: sid, pub_id: pub.id, name: String(a.name), description: String(a.description || ''), kind: a.kind === 'static' ? 'static' : 'dynamic', rules: JSON.stringify(rules), created_at: now() });
      if (a.kind === 'static') await snapshotToStatic(env, pub.id, sid, rules);
      await recalcSegment(env, pub.id, sid);
      return { id: sid, name: a.name, matches: count, rules };
    },
  },
  {
    name: 'tag_subscriber', title: 'Tag a subscriber', description: 'Add tags to a subscriber.',
    inputSchema: S({ email_or_id: str('Email or id'), tags: arr('Tags') }, ['email_or_id', 'tags']),
    run: async (env, pub, a) => {
      const s = await getSubscriber(env, pub.id, a.email_or_id);
      if (!s) throw new ToolError('Subscriber not found.');
      await addTags(env, pub.id, s.id, a.tags);
      return { id: s.id, tags: await getTags(env, s.id) };
    },
  },
  // ───────── automations ─────────
  {
    name: 'list_automations', title: 'List automations', description: 'List automations with trigger, status and enrollment counts.',
    inputSchema: S({}), annotations: { readOnlyHint: true },
    run: async (env, pub) => (await all<any>(env, `SELECT a.id, a.name, a.status, a.trigger, (SELECT COUNT(*) FROM automation_runs r WHERE r.automation_id = a.id) AS enrolled FROM automations a WHERE a.pub_id = ? ORDER BY a.created_at DESC`, pub.id)).map((a) => ({ ...a, trigger: parseJSON(a.trigger, {}) })),
  },
  {
    name: 'create_automation', title: 'Create an automation', description: `Create an automation. trigger = {"type", "config"}; types: ${Object.entries(TRIGGERS).map(([k, t]) => `${k} (${t.label}${t.fields ? `; config: ${t.fields.join(',')}` : ''})`).join('; ')}. steps = [{"id","type","config","yes"?,"no"?}]; step types: ${Object.entries(STEP_TYPES).map(([k, l]) => `${k}=${l}`).join(', ')}. Configs: send_email {subject, preview_text, markdown (converted) or doc}, delay {amount, unit: minutes|hours|days|weeks}, condition {rules} with yes/no branches, add_tag {tags}, update_field {key,value}, webhook {url, method}, wait_until {mode: datetime|weekday_time|condition, ...}. Created as draft unless activate=true.`,
    inputSchema: S({ name: str('Name'), description: str(''), trigger: obj('Trigger'), steps: arr('Steps', { type: 'object' }), activate: { type: 'boolean', description: 'Activate immediately' } }, ['name', 'trigger', 'steps']),
    run: async (env, pub, a) => {
      if (!TRIGGERS[a.trigger?.type]) throw new ToolError(`Unknown trigger type "${a.trigger?.type}".`);
      const steps = normalizeSteps(a.steps || []);
      const aid = id();
      await insert(env, 'automations', { id: aid, pub_id: pub.id, name: String(a.name), description: String(a.description || ''), status: a.activate ? 'active' : 'draft', trigger: JSON.stringify({ type: a.trigger.type, config: a.trigger.config || {} }), steps: JSON.stringify(steps), published_at: a.activate ? now() : null, created_at: now(), updated_at: now() });
      return { id: aid, status: a.activate ? 'active' : 'draft', steps: steps.length, edit_url: `${env.APP_URL.replace(/\/$/, '')}/app/automations/${aid}` };
    },
  },
  {
    name: 'update_automation', title: 'Edit an automation', description: 'Edit an automation. For a live (active) automation, changes go to a draft version while the live one keeps running; set publish=true to make them live. status can be active|paused.',
    inputSchema: S({ id: str('Automation id'), name: str(''), trigger: obj('Trigger'), steps: arr('Steps', { type: 'object' }), status: str('active|paused'), publish: { type: 'boolean', description: 'Publish draft changes' } }, ['id']),
    run: async (env, pub, a) => {
      const au = await one<any>(env, 'SELECT * FROM automations WHERE id = ? AND pub_id = ?', a.id, pub.id);
      if (!au) throw new ToolError('Automation not found.');
      const patch: Record<string, unknown> = { updated_at: now() };
      if (a.name) patch.name = a.name;
      const live = au.status === 'active';
      if (a.trigger) patch[live ? 'draft_trigger' : 'trigger'] = JSON.stringify({ type: a.trigger.type, config: a.trigger.config || {} });
      if (a.steps) patch[live ? 'draft_steps' : 'steps'] = JSON.stringify(normalizeSteps(a.steps));
      if (a.status && ['active', 'paused'].includes(a.status)) patch.status = a.status;
      await update(env, 'automations', au.id, patch, pub.id);
      if (a.publish && live) await publishDraft(env, au.id, pub.id);
      const fresh = await one<any>(env, 'SELECT status, draft_steps FROM automations WHERE id = ?', au.id);
      return { id: au.id, status: fresh.status, has_unpublished_draft: !!fresh.draft_steps };
    },
  },
  {
    name: 'enroll_subscriber', title: 'Enroll in automation', description: 'Enroll a subscriber into an active automation.',
    inputSchema: S({ automation_id: str('Automation id'), email_or_id: str('Subscriber') }, ['automation_id', 'email_or_id']),
    run: async (env, pub, a) => {
      const s = await getSubscriber(env, pub.id, a.email_or_id);
      if (!s) throw new ToolError('Subscriber not found.');
      const au = await one(env, 'SELECT id FROM automations WHERE id = ? AND pub_id = ?', a.automation_id, pub.id);
      if (!au) throw new ToolError('Automation not found.');
      const r = await enroll(env, a.automation_id, s.id, { via: 'mcp' });
      if (!r.ok) throw new ToolError(r.reason || 'Could not enroll');
      return { journey_id: r.runId };
    },
  },
  // ───────── media ─────────
  {
    name: 'generate_image', title: 'Generate an AI image', description: 'Generate an image from a prompt and save it to the media library. Returns the image URL to use in posts.',
    inputSchema: S({ prompt: str('Image description') }, ['prompt']),
    run: async (env, pub, a) => {
      const r = await aiImage(env, pub.id, String(a.prompt).slice(0, 1000));
      if (!r.ok) throw new ToolError(r.error || 'Image generation failed');
      return { url: r.url };
    },
  },
  // ───────── website ─────────
  {
    name: 'manage_website', title: 'Website pages, redirects & SEO', description: 'Manage the website. action: list_pages | get_page | create_page {title, slug?, markdown|html|sections, status?, seo?, paywall?} | update_page {page_id, ...} | list_redirects | create_redirect {from_path, to_url, code?} | delete_redirect {redirect_id} | get_seo | update_seo {robots_txt?, block_ai_crawlers?, blocked_crawlers?, google_news?, ga_measurement_id?}.',
    inputSchema: S({ action: str('Action name'), page_id: str(''), title: str(''), slug: str(''), markdown: str(''), html: str(''), sections: arr('Builder sections', { type: 'object' }), status: str('draft|published'), seo: obj('{title, description, og_image, noindex}'), paywall: str('none|subscribers|premium'), show_in_nav: { type: 'boolean' }, from_path: str(''), to_url: str(''), code: num('301|302'), redirect_id: str(''), robots_txt: str(''), block_ai_crawlers: { type: 'boolean' }, blocked_crawlers: arr(''), google_news: { type: 'boolean' }, ga_measurement_id: str('') }, ['action']),
    run: async (env, pub, a) => {
      const base = siteUrl(env, pub);
      switch (a.action) {
        case 'list_pages': return (await all<any>(env, 'SELECT id, title, slug, status, paywall, show_in_nav, updated_at FROM pages WHERE pub_id = ? ORDER BY created_at', pub.id)).map((p) => ({ ...p, url: `${base}/${p.slug}`, updated_at: iso(p.updated_at) }));
        case 'get_page': {
          const p = await one<any>(env, 'SELECT * FROM pages WHERE id = ? AND pub_id = ?', a.page_id, pub.id);
          if (!p) throw new ToolError('Page not found.');
          return { ...p, content: parseJSON(p.content, {}), seo: parseJSON(p.seo, {}) };
        }
        case 'create_page': case 'update_page': {
          const existing = a.action === 'update_page' ? await one<any>(env, 'SELECT * FROM pages WHERE id = ? AND pub_id = ?', a.page_id, pub.id) : null;
          if (a.action === 'update_page' && !existing) throw new ToolError('Page not found.');
          const html = a.html ?? (a.markdown ? (await import('./markdown')).markdownToHtml(a.markdown).html : undefined);
          const slug = a.slug !== undefined ? slugify(a.slug) : existing ? existing.slug : slugify(a.title || 'page');
          if (await one(env, 'SELECT 1 FROM pages WHERE pub_id = ? AND slug = ? AND id != ?', pub.id, slug, existing?.id || '')) throw new ToolError(`A page with slug "${slug}" exists.`);
          const row: Record<string, unknown> = { title: a.title ?? existing?.title ?? 'Untitled', slug, updated_at: now() };
          if (a.sections) row.content = JSON.stringify({ sections: a.sections.map((s: any) => ({ id: s.id || id(8), type: s.type, data: s.data || {}, style: s.style || {} })) });
          if (html !== undefined) row.html_override = html;
          if (a.status) row.status = a.status === 'published' ? 'published' : 'draft';
          if (a.seo) row.seo = JSON.stringify({ ...parseJSON(existing?.seo, {}), ...a.seo });
          if (a.paywall) row.paywall = a.paywall;
          if (a.show_in_nav !== undefined) row.show_in_nav = a.show_in_nav ? 1 : 0;
          if (existing) {
            await insert(env, 'page_versions', { id: id(), page_id: existing.id, snapshot: JSON.stringify(existing), created_by: null, created_at: now() });
            await update(env, 'pages', existing.id, row, pub.id);
            return { id: existing.id, url: `${base}/${slug}`, updated: true };
          }
          const pid = id();
          await insert(env, 'pages', { id: pid, pub_id: pub.id, content: '{"sections":[]}', seo: '{}', paywall: 'none', status: 'draft', show_in_nav: 0, created_at: now(), ...row });
          return { id: pid, url: `${base}/${slug}`, status: row.status || 'draft' };
        }
        case 'list_redirects': return all(env, 'SELECT id, from_path, to_url, code, hits FROM redirects WHERE pub_id = ? ORDER BY created_at DESC', pub.id);
        case 'create_redirect': {
          const from = '/' + String(a.from_path || '').replace(/^\/+/, '').replace(/\/$/, '');
          if (from === '/' || !a.to_url) throw new ToolError('from_path and to_url are required.');
          const rid = id();
          await run(env, 'INSERT INTO redirects (id, pub_id, from_path, to_url, code, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(pub_id, from_path) DO UPDATE SET to_url = excluded.to_url, code = excluded.code', rid, pub.id, from, a.to_url, a.code === 302 ? 302 : 301, now());
          return { from_path: from, to_url: a.to_url, code: a.code === 302 ? 302 : 301 };
        }
        case 'delete_redirect': await run(env, 'DELETE FROM redirects WHERE id = ? AND pub_id = ?', a.redirect_id, pub.id); return { deleted: true };
        case 'get_seo': { const s = settings(pub); return { robots_txt: s.robots_txt || null, block_ai_crawlers: !!s.block_ai_crawlers, blocked_crawlers: s.blocked_crawlers || [], google_news: !!s.google_news, ga_measurement_id: s.ga_measurement_id || null, sitemap: `${base}/sitemap.xml` }; }
        case 'update_seo': {
          const cur = await one<any>(env, 'SELECT settings FROM publications WHERE id = ?', pub.id);
          const s = parseJSON<Record<string, unknown>>(cur?.settings, {});
          for (const k of ['robots_txt', 'block_ai_crawlers', 'blocked_crawlers', 'google_news', 'ga_measurement_id']) if (a[k] !== undefined) s[k] = a[k];
          await run(env, 'UPDATE publications SET settings = ? WHERE id = ?', JSON.stringify(s), pub.id);
          return { updated: true, settings: s };
        }
      }
      throw new ToolError('Unknown action.');
    },
  },
  // ───────── community ─────────
  {
    name: 'community', title: 'Community posts & DMs', description: 'Read and reply in the community. action: list_posts {channel?, limit?} | get_post {post_id} (with comments) | reply_post {post_id, body} | list_dms (latest conversations) | get_dm {subscriber_id} | reply_dm {subscriber_id, body}.',
    inputSchema: S({ action: str(''), channel: str('Channel slug'), post_id: str(''), subscriber_id: str(''), body: str('Reply text'), limit: num('') }, ['action']),
    run: async (env, pub, a) => {
      switch (a.action) {
        case 'list_posts': return (await all<any>(env, `SELECT p.id, p.title, substr(p.body,1,280) AS excerpt, p.reply_count, p.like_count, p.pinned, c.slug AS channel, p.created_at FROM community_posts p JOIN channels c ON c.id = p.channel_id WHERE p.pub_id = ? AND p.status = 'visible' ${a.channel ? 'AND c.slug = ?' : ''} ORDER BY p.last_activity_at DESC LIMIT ?`, pub.id, ...(a.channel ? [a.channel] : []), clamp(int(a.limit, 20), 1, 100))).map((p) => ({ ...p, created_at: iso(p.created_at) }));
        case 'get_post': {
          const p = await one<any>(env, 'SELECT * FROM community_posts WHERE id = ? AND pub_id = ?', a.post_id, pub.id);
          if (!p) throw new ToolError('Community post not found.');
          const comments = await all<any>(env, `SELECT cc.id, cc.parent_id, cc.body, cc.created_at, s.name AS member, s.email FROM community_comments cc LEFT JOIN subscribers s ON s.id = cc.author_subscriber_id WHERE cc.post_id = ? AND cc.status = 'visible' ORDER BY cc.created_at`, p.id);
          return { id: p.id, title: p.title, body: p.body, comments: comments.map((x) => ({ ...x, member: x.member || x.email || 'Team', created_at: iso(x.created_at) })) };
        }
        case 'reply_post': {
          const p = await one<any>(env, 'SELECT id FROM community_posts WHERE id = ? AND pub_id = ?', a.post_id, pub.id);
          if (!p || !a.body) throw new ToolError('post_id and body are required.');
          const cid = id();
          await insert(env, 'community_comments', { id: cid, pub_id: pub.id, post_id: p.id, author_user_id: await ownerId(env, pub), body: String(a.body).slice(0, 10000), status: 'visible', created_at: now() });
          await run(env, 'UPDATE community_posts SET reply_count = reply_count + 1, last_activity_at = ? WHERE id = ?', now(), p.id);
          return { comment_id: cid };
        }
        case 'list_dms': return (await all<any>(env, `SELECT d.subscriber_id, s.email, s.name, MAX(d.created_at) AS last_at, SUM(CASE WHEN d.from_side = 'member' AND d.read_at IS NULL THEN 1 ELSE 0 END) AS unread FROM direct_messages d JOIN subscribers s ON s.id = d.subscriber_id WHERE d.pub_id = ? GROUP BY d.subscriber_id ORDER BY last_at DESC LIMIT 50`, pub.id)).map((r) => ({ ...r, last_at: iso(r.last_at) }));
        case 'get_dm': return (await all<any>(env, 'SELECT from_side, body, created_at FROM direct_messages WHERE pub_id = ? AND subscriber_id = ? ORDER BY created_at DESC LIMIT 100', pub.id, a.subscriber_id)).reverse().map((m) => ({ ...m, created_at: iso(m.created_at) }));
        case 'reply_dm': {
          const s = await one<Subscriber>(env, 'SELECT id FROM subscribers WHERE id = ? AND pub_id = ?', a.subscriber_id, pub.id);
          if (!s || !a.body) throw new ToolError('subscriber_id and body are required.');
          const mid = id();
          await insert(env, 'direct_messages', { id: mid, pub_id: pub.id, subscriber_id: s.id, from_side: 'publication', user_id: await ownerId(env, pub), body: String(a.body).slice(0, 10000), created_at: now() });
          await run(env, `UPDATE direct_messages SET read_at = ? WHERE pub_id = ? AND subscriber_id = ? AND from_side = 'member' AND read_at IS NULL`, now(), pub.id, s.id);
          return { message_id: mid };
        }
      }
      throw new ToolError('Unknown action.');
    },
  },
  // ───────── ads ─────────
  {
    name: 'ads', title: 'Ad offers & revenue', description: 'action: list_opportunities {status?: available|accepted|declined|placed|completed} | revenue_report {days?} (per placement and per post, bot clicks filtered).',
    inputSchema: S({ action: str(''), status: str(''), days: num('') }, ['action']), annotations: { readOnlyHint: true },
    run: async (env, pub, a) => {
      if (a.action === 'list_opportunities') return (await all<any>(env, `SELECT o.id, o.status, o.scheduled_for, o.post_id, c.name AS campaign, c.headline, c.pricing, c.rate_cents, adv.name AS advertiser FROM ad_opportunities o JOIN ad_campaigns c ON c.id = o.campaign_id JOIN advertisers adv ON adv.id = c.advertiser_id WHERE o.pub_id = ? ${a.status ? 'AND o.status = ?' : ''} ORDER BY o.created_at DESC LIMIT 100`, pub.id, ...(a.status ? [a.status] : []))).map((o) => ({ ...o, rate: money(o.rate_cents), scheduled_for: iso(o.scheduled_for) }));
      if (a.action === 'revenue_report') {
        const since = now() - clamp(int(a.days, 30), 1, 365) * DAY;
        const rows = await all<any>(env, `SELECT o.id, c.name AS campaign, p.title AS post, o.impressions, o.clicks, o.bot_clicks, o.earned_cents FROM ad_opportunities o JOIN ad_campaigns c ON c.id = o.campaign_id LEFT JOIN posts p ON p.id = o.post_id WHERE o.pub_id = ? AND o.created_at >= ? AND o.status IN ('placed','completed') ORDER BY o.earned_cents DESC`, pub.id, since);
        const total = rows.reduce((n, r) => n + (r.earned_cents || 0), 0);
        return { total: money(total), total_cents: total, placements: rows.map((r) => ({ ...r, earned: money(r.earned_cents) })) };
      }
      throw new ToolError('Unknown action.');
    },
  },
  // ───────── podcasts ─────────
  {
    name: 'podcasts', title: 'Podcast shows & episodes', description: 'action: list_shows | list_episodes {podcast_id} | create_episode {podcast_id, title, description?, audio_url?, season?, number?, premium?, publish_at? (ISO)}.',
    inputSchema: S({ action: str(''), podcast_id: str(''), title: str(''), description: str(''), audio_url: str(''), season: num(''), number: num(''), premium: { type: 'boolean' }, publish_at: str('') }, ['action']),
    run: async (env, pub, a) => {
      if (a.action === 'list_shows') return all(env, `SELECT p.id, p.title, p.slug, p.access, (SELECT COUNT(*) FROM episodes e WHERE e.podcast_id = p.id) AS episodes FROM podcasts p WHERE p.pub_id = ?`, pub.id);
      const pod = await one<any>(env, 'SELECT * FROM podcasts WHERE id = ? AND pub_id = ?', a.podcast_id, pub.id);
      if (!pod) throw new ToolError('Podcast not found.');
      if (a.action === 'list_episodes') return (await all<any>(env, `SELECT e.id, e.title, e.status, e.published_at, (SELECT COUNT(*) FROM episode_downloads d WHERE d.episode_id = e.id AND d.is_bot = 0) AS downloads FROM episodes e WHERE e.podcast_id = ? ORDER BY e.created_at DESC LIMIT 100`, pod.id)).map((e) => ({ ...e, published_at: iso(e.published_at) }));
      if (a.action === 'create_episode') {
        if (!a.title) throw new ToolError('title is required.');
        const at = a.publish_at ? Date.parse(a.publish_at) : NaN;
        const eid = id();
        let slug = slugify(a.title);
        if (await one(env, 'SELECT 1 FROM episodes WHERE podcast_id = ? AND slug = ?', pod.id, slug)) slug += '-' + id(4);
        const status = !isNaN(at) ? (at > now() ? 'scheduled' : 'published') : 'draft';
        await insert(env, 'episodes', { id: eid, podcast_id: pod.id, pub_id: pub.id, guid: crypto.randomUUID(), title: a.title, slug, description: a.description || '', audio_url: a.audio_url || null, season: a.season ?? null, number: a.number ?? null, premium: a.premium ? 1 : 0, status, published_at: isNaN(at) ? null : at, created_at: now(), updated_at: now() });
        if (status === 'published') await emit(env, { pubId: pub.id, type: 'podcast.episode.published', refId: eid, data: { episode_id: eid, title: a.title }, activity: false });
        return { id: eid, status, page_url: `${siteUrl(env, pub)}/podcasts/${pod.slug}/${slug}` };
      }
      throw new ToolError('Unknown action.');
    },
  },
  // ───────── products ─────────
  {
    name: 'products', title: 'Digital products & codes', description: 'action: list | create_product {name, price (USD, 0 = free lead magnet), kind?: download|link|guide|template|ebook|membership|coaching, description?, link_url?, content?} | create_coupon {code, percent_off? | amount_off (USD)?, applies_to?: all|subscription|product|event, target_id?, max_redemptions?, expires_at?}.',
    inputSchema: S({ action: str(''), name: str(''), price: { type: 'number' }, kind: str(''), description: str(''), link_url: str(''), content: str(''), code: str(''), percent_off: num(''), amount_off: { type: 'number' }, applies_to: str(''), target_id: str(''), max_redemptions: num(''), expires_at: str('') }, ['action']),
    run: async (env, pub, a) => {
      if (a.action === 'list') return (await all<any>(env, 'SELECT id, name, slug, kind, price_cents, status, sales_count, revenue_cents FROM products WHERE pub_id = ? ORDER BY created_at DESC', pub.id)).map((p) => ({ ...p, price: money(p.price_cents), revenue: money(p.revenue_cents) }));
      if (a.action === 'create_product') {
        if (!a.name) throw new ToolError('name is required.');
        const pid = id();
        let slug = slugify(a.name);
        if (await one(env, 'SELECT 1 FROM products WHERE pub_id = ? AND slug = ?', pub.id, slug)) slug += '-' + id(4);
        const kinds = ['download', 'link', 'guide', 'template', 'ebook', 'membership', 'coaching'];
        await insert(env, 'products', { id: pid, pub_id: pub.id, name: a.name, slug, description: a.description || '', kind: kinds.includes(a.kind) ? a.kind : 'guide', price_cents: Math.max(0, Math.round((Number(a.price) || 0) * 100)), link_url: a.link_url || null, content: a.content || null, status: 'active', created_at: now() });
        return { id: pid, url: `${siteUrl(env, pub)}/shop/${slug}` };
      }
      if (a.action === 'create_coupon') {
        const code = String(a.code || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
        if (!code) throw new ToolError('code is required.');
        if (!a.percent_off && !a.amount_off) throw new ToolError('percent_off or amount_off is required.');
        if (await one(env, 'SELECT 1 FROM offers WHERE pub_id = ? AND code = ?', pub.id, code)) throw new ToolError('That code exists.');
        const oid = id();
        await insert(env, 'offers', { id: oid, pub_id: pub.id, code, name: code, applies_to: ['all', 'subscription', 'product', 'event'].includes(a.applies_to) ? a.applies_to : 'all', target_id: a.target_id || null, percent_off: clamp(int(a.percent_off), 0, 100), amount_off_cents: Math.round((Number(a.amount_off) || 0) * 100), max_redemptions: a.max_redemptions || null, expires_at: a.expires_at ? Date.parse(a.expires_at) || null : null, active: 1, created_at: now() });
        return { id: oid, code };
      }
      throw new ToolError('Unknown action.');
    },
  },
  // ───────── docs ─────────
  {
    name: 'search_docs', title: 'Search OpenHive docs', description: 'Search the OpenHive documentation (setup, deploy, API, MCP, deliverability, support) without leaving the chat.',
    inputSchema: S({ query: str('What to look for') }, ['query']), annotations: { readOnlyHint: true },
    run: async (_env, _pub, a) => searchDocs(String(a.query || '')),
  },
];

function normalizeSteps(steps: any[]): any[] {
  return steps.map((s) => {
    const config = { ...(s.config || {}) };
    if (s.type === 'send_email' && config.markdown && !config.doc) { config.doc = { blocks: markdownToBlocks(config.markdown) }; delete config.markdown; }
    return { id: s.id || id(8), type: String(s.type), config, ...(s.yes ? { yes: normalizeSteps(s.yes) } : {}), ...(s.no ? { no: normalizeSteps(s.no) } : {}) };
  });
}

export function searchDocs(query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  const hits: Array<{ page: string; title: string; heading: string; excerpt: string; score: number; url: string }> = [];
  for (const d of DOCS) {
    const sections = d.body.split(/\n(?=#{1,3} )/);
    for (const sec of sections) {
      const lower = sec.toLowerCase();
      let score = 0;
      for (const t of terms) { const n = lower.split(t).length - 1; score += n; if (sec.split('\n')[0].toLowerCase().includes(t)) score += 5; }
      if (!score) continue;
      const heading = sec.split('\n')[0].replace(/^#+\s*/, '');
      const idx = Math.max(0, lower.indexOf(terms[0] || ''));
      hits.push({ page: d.slug, title: d.title, heading, excerpt: sec.slice(Math.max(0, idx - 120), idx + 400).replace(/\s+/g, ' ').trim(), score, url: `/docs/${d.slug}#${heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}` });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 8);
}

// ───────── JSON-RPC ─────────
type RpcReq = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: any };
const ok = (id: any, result: unknown) => ({ jsonrpc: '2.0', id, result });
const err = (id: any, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export async function handleRpc(env: Env, pub: Publication, msg: RpcReq): Promise<object | null> {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg?.id, -32600, 'Invalid Request');
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case 'initialize':
      return ok(msg.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: `You are connected to the OpenHive publication "${pub.name}". Use list_posts/get_post before editing, get_stats for numbers, and search_docs for how-to questions. Drafts are never sent automatically.`,
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return ok(msg.id, {});
    case 'tools/list':
      return ok(msg.id, { tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return err(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
      try {
        const result = await tool.run(env, pub, msg.params?.arguments || {});
        return ok(msg.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: Array.isArray(result) ? { items: result } : (result as object), isError: false });
      } catch (e: any) {
        return ok(msg.id, { content: [{ type: 'text', text: e instanceof ToolError ? e.message : `Error: ${e?.message || e}` }], isError: true });
      }
    }
    default:
      return isNotification ? null : err(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export { EMPTY_GROUP, val };
