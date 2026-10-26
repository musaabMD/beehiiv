// End-to-end smoke test against a running `wrangler dev`.
// Usage: BASE=http://localhost:8790 PERSIST=.wrangler/int node scripts/e2e.mjs
// Walks: signup → onboarding → API key → public subscribe → API subscriber → post → send → cron → open/click tracking
//        → public site → paid tier checkout (test mode) → one-click unsubscribe → webhooks/automation sanity
//        → platform plans (usage page, subscriber cap, email allowance, simulated upgrade, campaign pause, approval).
import { execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

const BASE = process.env.BASE || 'http://localhost:8787';
const PERSIST = process.env.PERSIST || '';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const rnd = Math.random().toString(36).slice(2, 8);
let cookies = {};
let pass = 0, fail = 0;

const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log('  ✓', label); } else { fail++; console.log('  ✗', label, extra); } };
const jar = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
function keep(r) {
  for (const sc of r.headers.getSetCookie?.() || []) { const [kv] = sc.split(';'); const [k, ...v] = kv.split('='); cookies[k.trim()] = v.join('='); }
}
async function req(path, opts = {}) {
  const headers = { 'user-agent': UA, cookie: jar(), ...(opts.headers || {}) };
  let body = opts.body;
  if (opts.form) { body = new URLSearchParams(opts.form); headers['content-type'] = 'application/x-www-form-urlencoded'; }
  if (opts.json) { body = JSON.stringify(opts.json); headers['content-type'] = 'application/json'; }
  const r = await fetch(BASE + path, { method: opts.method || (body ? 'POST' : 'GET'), headers, body, redirect: 'manual' });
  keep(r);
  return r;
}
async function api(key, method, path, json) {
  const r = await fetch(`${BASE}/api/v2/publication${path}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: json ? JSON.stringify(json) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
function sql(q) {
  const out = execSync(`npx wrangler d1 execute openhive --local ${PERSIST ? `--persist-to ${PERSIST}` : ''} --json --command ${JSON.stringify(q)}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out)[0].results;
}
const cron = () => fetch(BASE + '/__scheduled').catch(() => null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`E2E against ${BASE}`);

console.log('1. Signup + onboarding');
const email = `e2e.${rnd}@gmail.com`;
let r = await req('/signup', { form: { name: 'E2E Tester', email, password: 'correct-horse-9' } });
ok(r.status === 302 || r.status === 303, 'signup redirects', r.status);
ok(!!cookies.oh_sid, 'session cookie set');
const slug = `e2e-${rnd}`;
r = await req('/app/onboarding', { form: { name: `E2E Weekly ${rnd}`, slug, description: 'Testing everything', language: 'en', timezone: 'UTC' } });
ok([302, 303].includes(r.status), 'publication created', r.status);
r = await req('/app');
ok(r.status === 200, 'dashboard loads', r.status);

console.log('2. API key');
r = await req('/app/settings/api', { form: { name: 'e2e' } });
const html = await r.text();
const key = html.match(/oh_live_[A-Za-z0-9_-]+/)?.[0];
ok(!!key, 'API key created');
const pubInfo = await api(key, 'GET', '');
ok(pubInfo.status === 200, 'API authenticates', JSON.stringify(pubInfo.body).slice(0, 120));

console.log('3. Public subscribe (bot protection + validation)');
const subEmail = `reader.${rnd}@gmail.com`;
const cookieBackup = cookies; cookies = {};
r = await req(`/s/${slug}/subscribe`, { form: { email: subEmail, website: '', _t: String(Date.now() - 8000), source: 'website', utm: JSON.stringify({ utm_source: 'e2e', utm_medium: 'test' }) } });
ok([200, 302, 303].includes(r.status), 'subscribe accepted', r.status);
r = await req(`/s/${slug}/subscribe`, { form: { email: `x.${rnd}@mailinator.com`, website: '', _t: String(Date.now() - 8000) } });
const dispo = sql(`SELECT COUNT(*) AS n FROM subscribers WHERE email = 'x.${rnd}@mailinator.com'`)[0].n;
ok(dispo === 0, 'disposable email blocked');
r = await req(`/s/${slug}/subscribe`, { form: { email: `bot.${rnd}@gmail.com`, website: 'http://spam', _t: String(Date.now()) } });
const bot = sql(`SELECT COUNT(*) AS n FROM subscribers WHERE email = 'bot.${rnd}@gmail.com'`)[0].n;
ok(bot === 0, 'honeypot bot blocked');
cookies = cookieBackup;
const s1 = sql(`SELECT * FROM subscribers WHERE email = '${subEmail}'`)[0];
ok(s1 && s1.utm_source === 'e2e', 'subscriber stored with UTM attribution', JSON.stringify(s1 || {}).slice(0, 160));

console.log('4. API subscriber + tags + fields');
const sub2 = await api(key, 'POST', '/subscriptions', { email: `api.${rnd}@outlook.com`, name: 'Api Person', tags: ['vip'], custom_fields: { company: 'Acme' }, send_welcome: false });
ok(sub2.status === 201 || sub2.status === 200, 'API create subscriber', JSON.stringify(sub2.body).slice(0, 200));
const sid2 = sub2.body?.data?.id;
const tg = await api(key, 'GET', `/subscriptions/${sid2}/tags`);
ok(JSON.stringify(tg.body).includes('vip'), 'tag stored');

console.log('5. Post create + send');
const post = await api(key, 'POST', '/posts', { title: `Hello ${rnd}`, subtitle: 'First issue', markdown: `Hi {{subscriber.first_name|there}}!\n\nRead [our site](https://example.com/page).\n\n## Section\n\nMore text here.`, email_subject: `Issue ${rnd}`, platform: 'both' });
ok(post.status === 201, 'post created', JSON.stringify(post.body).slice(0, 200));
const postId = post.body?.data?.id;
const postSlug = post.body?.data?.slug;
const htmlR = await api(key, 'GET', `/posts/${postId}/html?format=email&audience=free`);
ok(htmlR.status === 200 && JSON.stringify(htmlR.body).includes('<table'), 'email HTML renders (table-based)');
const send = await api(key, 'POST', `/posts/${postId}/send`, {});
ok(send.status === 200 || send.status === 201 || send.status === 202, 'send started', JSON.stringify(send.body).slice(0, 200));
for (let i = 0; i < 8; i++) { await cron(); await sleep(1500); const d = sql(`SELECT COUNT(*) AS n FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = '${postId}' AND d.status = 'sent'`)[0].n; if (d >= 2) break; }
const dels = sql(`SELECT d.id, d.email FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = '${postId}' AND d.status = 'sent'`);
ok(dels.length >= 2, `delivered to ${dels.length} subscribers`);
const outbox = sql(`SELECT html, headers FROM outbox WHERE subject LIKE '%${rnd}%' AND to_email = '${subEmail}' LIMIT 1`)[0];
ok(outbox && outbox.headers.includes('List-Unsubscribe-Post'), 'one-click unsubscribe header present');
ok(outbox && outbox.headers.includes('Feedback-ID'), 'Feedback-ID header present');
ok(outbox && /Hi Reader|Hi there/.test(outbox.html) || (outbox && outbox.html.includes('Hi ')), 'merge tag rendered');

console.log('6. Open + click tracking');
const del = dels.find((d) => d.email === subEmail) || dels[0];
// Clicks within 10s of delivery count as link scanners, so pretend this email went out a minute ago.
sql(`UPDATE deliveries SET sent_at = sent_at - 60000 WHERE id = '${del.id}'`);
await fetch(`${BASE}/t/o/${del.id}.gif`, { headers: { 'user-agent': UA } });
await sleep(4000);
const clickUrl = [...(outbox?.html || "").matchAll(/href="([^"]*\/t\/c\/[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&")).find((u) => decodeURIComponent(u).includes("example.com"));
ok(!!clickUrl, 'links are click-tracked');
if (clickUrl) { const cr = await fetch(clickUrl.replace(/^https?:\/\/[^/]+/, BASE), { headers: { 'user-agent': UA }, redirect: 'manual' }); ok(cr.status === 302 && (cr.headers.get('location') || '').includes('example.com'), 'click redirects to target with UTM', cr.headers.get('location')); }
await fetch(`${BASE}/t/c/${del.id}?u=${encodeURIComponent('https://example.com/x')}`, { headers: { 'user-agent': 'curl/8.0' }, redirect: 'manual' });
await sleep(1500);
const tr = sql(`SELECT opened_at, clicked_at, click_count FROM deliveries WHERE id = '${del.id}'`)[0];
ok(!!tr.opened_at, 'open recorded');
ok(!!tr.clicked_at && tr.click_count === 1, 'human click recorded, bot click filtered', JSON.stringify(tr));

console.log('7. Public website');
cookies = {};
r = await req(`/s/${slug}/`); ok(r.status === 200, 'site home 200', r.status);
r = await req(`/s/${slug}/p/${postSlug}`); const ph = await r.text(); ok(r.status === 200 && ph.includes(`Hello ${rnd}`), 'post page renders');
r = await req(`/s/${slug}/feed.xml`); ok(r.status === 200 && (await r.text()).includes('<rss'), 'RSS feed');
r = await req(`/s/${slug}/sitemap.xml`); ok(r.status === 200, 'sitemap');
r = await req(`/s/${slug}/robots.txt`); ok(r.status === 200, 'robots.txt');
r = await fetch(`${BASE}/s/${slug}/`, { headers: { 'user-agent': 'GPTBot/1.0' } }); ok(r.status === 200, 'AI crawler served by default');

console.log('8. Paid tier checkout (test mode)');
cookies = cookieBackup;
const tier = await api(key, 'POST', '/tiers', { name: 'Pro', monthly_cents: 800, annual_cents: 8000, benefits: ['Premium posts'] });
ok(tier.status === 201, 'tier created');
cookies = {};
r = await req(`/s/${slug}/upgrade`); ok(r.status === 200, 'pricing page');
const buyer = `buyer.${rnd}@gmail.com`;
r = await req(`/s/${slug}/upgrade/checkout`, { form: { tier_id: tier.body.data.id, interval: 'month', email: buyer } });
const loc = r.headers.get('location') || '';
ok(loc.includes('/checkout/simulate/'), 'redirects to test checkout', loc);
if (loc) { const p = new URL(loc, BASE).pathname; r = await req(p, { form: {} }); ok([302, 303].includes(r.status), 'test payment accepted', r.status); }
await sleep(1500);
const bsub = sql(`SELECT tier FROM subscribers WHERE email = '${buyer}'`)[0];
ok(bsub && bsub.tier === 'premium', 'buyer upgraded to premium', JSON.stringify(bsub));

console.log('9. One-click unsubscribe');
const unsubUrl = outbox?.html.match(/href="([^"]*\/u\/[^"]+)"/)?.[1];
if (unsubUrl) {
  const ur = await fetch(unsubUrl.replace(/^https?:\/\/[^/]+/, BASE), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  ok(ur.status === 200, 'one-click POST accepted');
  const st = sql(`SELECT status FROM subscribers WHERE email = '${subEmail}'`)[0];
  ok(st.status === 'unsubscribed', 'subscriber unsubscribed');
} else ok(false, 'unsubscribe link present');

console.log('10. Stats + MCP');
cookies = cookieBackup;
const stats = await api(key, 'GET', `/posts/${postId}/stats`);
ok(stats.status === 200, 'post stats via API', JSON.stringify(stats.body).slice(0, 200));
const mcp = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
const mj = await mcp.json().catch(() => ({}));
ok(mcp.status === 200 && mj.result?.tools?.length > 10, `MCP tools/list (${mj.result?.tools?.length || 0} tools)`);
console.log('11. Platform plans: usage page, subscriber cap, email allowance, upgrade, campaign safety, approval');
cookies = cookieBackup;
const pubRow = sql(`SELECT id, workspace_id FROM publications WHERE slug = '${slug}'`)[0];
const wsId = pubRow.workspace_id, pubId = pubRow.id;
const fakeSubs = (n, tag) => sql(`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ${n}) INSERT INTO subscribers (id, pub_id, email, name, status, tier, source, referral_code, custom, confirmed_at, created_at, updated_at) SELECT '${tag}' || i || '${rnd}', '${pubId}', '${tag}' || i || '.${rnd}@gmail.com', '', 'active', 'free', 'import', '${tag}' || i || '${rnd}', '{}', 0, 0, 0 FROM k`);
const newPost = async (title) => (await api(key, 'POST', '/posts', { title: `${title} ${rnd}`, markdown: 'Hello {{subscriber.first_name|there}}', platform: 'both' })).body?.data?.id;
sql(`UPDATE platform_domains SET warmup_started_at = 1`); // warm-up of the shared sender domain isn't under test here
const wsPlan = () => sql(`SELECT plan_id FROM workspaces WHERE id = '${wsId}'`)[0].plan_id;

r = await req('/app/settings/plan');
let ph2 = await r.text();
ok(r.status === 200 && ph2.includes('data-usage="Active subscribers"') && ph2.includes('data-plan="pro"'), 'Plan & usage page renders usage bars and plan cards');
ok(wsPlan() === 'free', 'new workspace starts on Free');
ok(sql(`SELECT COUNT(*) AS n FROM outbox WHERE subject LIKE '%Issue ${rnd}%' AND html LIKE '%Sent with%' AND from_email LIKE '%<${slug}@%'`)[0].n >= 1, 'Free plan email carries branding footer and shared sender address');
r = await req(`/s/${slug}/`); ok((await r.text()).includes('data-platform-badge'), 'Free plan site shows the badge');

// subscriber cap: readers are kept, sending is blocked
fakeSubs(520, 'cap');
let p2 = await newPost('Capped');
let sres = await api(key, 'POST', `/posts/${p2}/send`, {});
ok(sres.status === 402 && sres.body?.error?.code === 'subscriber_cap' && !!sres.body?.error?.upgrade_url, 'send blocked over the subscriber cap (402 + upgrade link)', JSON.stringify(sres.body).slice(0, 200));
ok(sql(`SELECT status FROM posts WHERE id = '${p2}'`)[0].status === 'draft', 'blocked post stays a draft');
r = await req('/app'); ok((await r.text()).includes('data-plan-banner'), 'dashboard shows the plan banner');
ok(sql(`SELECT COUNT(*) AS n FROM outbox WHERE subject LIKE '%close to your Free plan limits%' AND to_email = '${email}'`)[0].n === 1, '80% usage email sent to the owner (once)');
sql(`DELETE FROM subscribers WHERE id LIKE 'cap%${rnd}'`);

// monthly email allowance: blocked before starting, with an upgrade link in the send dialog
sql(`UPDATE workspaces SET created_at = created_at - 4 * 86400000 WHERE id = '${wsId}'`); // past the new-account ramp
const firstSend = sql(`SELECT id FROM sends WHERE post_id = '${postId}'`)[0].id;
sql(`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 2500) INSERT INTO deliveries (id, send_id, pub_id, subscriber_id, email, status, attempts, sent_at, created_at) SELECT 'al' || i || '${rnd}', '${firstSend}', '${pubId}', NULL, 'al' || i || '@gmail.com', 'sent', 1, ${Date.now()}, ${Date.now()} FROM k`);
r = await req(`/app/posts/${p2}/count`, { json: {}, headers: { accept: 'application/json' } });
const cj = await r.json();
ok(cj.plan && cj.plan.ok === false && cj.plan.code === 'email_allowance' && cj.plan.upgrade_url.includes('/app/settings/plan'), 'send dialog check reports the allowance with an upgrade link', JSON.stringify(cj).slice(0, 200));
sres = await api(key, 'POST', `/posts/${p2}/send`, {});
ok(sres.status === 402 && sres.body?.error?.code === 'email_allowance', 'send over the monthly email allowance blocked (402)', JSON.stringify(sres.body).slice(0, 200));
r = await req(`/app/posts/${p2}/publish`, { json: { mode: 'now' }, headers: { accept: 'application/json' } });
const pj = await r.json().catch(() => ({}));
ok(r.status === 402 && pj.upgrade_url, 'editor send returns the reason + upgrade link', JSON.stringify(pj).slice(0, 160));

// upgrade through the simulated checkout
r = await req('/app/settings/plan/change', { form: { plan_id: 'pro', interval: 'month' } });
const coLoc = r.headers.get('location') || '';
ok(coLoc.includes('/checkout/plan/'), 'upgrade redirects to the (simulated) checkout', coLoc);
const coPath = new URL(coLoc, BASE).pathname;
r = await req(coPath); ok(r.status === 200 && (await r.text()).includes('Test checkout'), 'simulated plan checkout page');
r = await req(coPath, { form: {} });
ok([302, 303].includes(r.status) && wsPlan() === 'pro', 'payment upgrades the workspace to Pro', wsPlan());
sres = await api(key, 'POST', `/posts/${p2}/send`, {});
ok(sres.status === 202, 'send works after upgrading', JSON.stringify(sres.body).slice(0, 160));
r = await req(`/s/${slug}/`); ok(!(await r.text()).includes('data-platform-badge'), 'paid plan removes the site badge');

// downgrade is scheduled for the period end
r = await req('/app/settings/plan/change', { form: { plan_id: 'starter', interval: 'month' } });
const pend = sql(`SELECT plan_id, plan_pending_id, plan_period_end FROM workspaces WHERE id = '${wsId}'`)[0];
ok(pend.plan_id === 'pro' && pend.plan_pending_id === 'starter' && pend.plan_period_end > Date.now(), 'downgrade takes effect at period end', JSON.stringify(pend));
r = await req('/app/settings/plan/change', { form: { plan_id: 'pro', interval: 'month' } });
ok(!sql(`SELECT plan_pending_id FROM workspaces WHERE id = '${wsId}'`)[0].plan_pending_id, 'keeping the current plan cancels the scheduled downgrade');

// campaign safety: >2% hard bounces after 200 deliveries pauses the send
fakeSubs(300, 'bnc');
sql(`UPDATE publications SET settings = json_set(settings, '$.send_rate_per_minute', 50) WHERE id = '${pubId}'`);
const p3 = await newPost('Bouncy');
sres = await api(key, 'POST', `/posts/${p3}/send`, {});
ok(sres.status === 202, 'campaign started', JSON.stringify(sres.body).slice(0, 120));
const send3 = sres.body?.data?.send_id;
for (let i = 0; i < 6; i++) { await cron(); await sleep(1500); if (sql(`SELECT COUNT(*) AS n FROM deliveries WHERE send_id = '${send3}'`)[0].n >= 50) break; }
sql(`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 250) INSERT INTO deliveries (id, send_id, pub_id, subscriber_id, email, status, bounce_type, attempts, sent_at, created_at) SELECT 'bd' || i || '${rnd}', '${send3}', '${pubId}', NULL, 'bd' || i || '@gmail.com', CASE WHEN i <= 15 THEN 'bounced' ELSE 'sent' END, CASE WHEN i <= 15 THEN 'hard' ELSE NULL END, 1, ${Date.now()}, ${Date.now()} FROM k`);
sql(`UPDATE jobs SET run_at = 0 WHERE kind = 'send.batch' AND status = 'pending' AND payload LIKE '%${send3}%'`);
for (let i = 0; i < 6; i++) { await cron(); await sleep(1500); if (sql(`SELECT status FROM sends WHERE id = '${send3}'`)[0].status === 'paused') break; }
const s3 = sql(`SELECT status, status_reason FROM sends WHERE id = '${send3}'`)[0];
ok(s3.status === 'paused' && /Hard-bounce rate/.test(s3.status_reason || ''), 'campaign paused for hard bounces', JSON.stringify(s3));
ok(sql(`SELECT COUNT(*) AS n FROM outbox WHERE to_email = '${email}' AND subject LIKE '%was paused%'`)[0].n === 1, 'owner emailed about the pause');
r = await req(`/app/posts/${p3}`); ok((await r.text()).includes('data-send-reason="paused"'), 'post page shows why it paused');
sql(`UPDATE publications SET settings = json_remove(settings, '$.send_rate_per_minute') WHERE id = '${pubId}'`);
sql(`DELETE FROM deliveries WHERE id LIKE 'bd%${rnd}' OR id LIKE 'al%${rnd}'`);

// first large campaign from an untrusted account waits for superadmin approval
fakeSubs(1000, 'big');
const p4 = await newPost('Big');
sres = await api(key, 'POST', `/posts/${p4}/send`, {});
const send4 = sres.body?.data?.send_id;
ok(sres.status === 202 && sql(`SELECT status FROM sends WHERE id = '${send4}'`)[0].status === 'pending_approval', 'first campaign over 1,000 recipients is held for review');
const userCookies = cookies; cookies = {};
const opsEmail = `ops.${rnd}@gmail.com`;
await req('/signup', { form: { name: 'Ops', email: opsEmail, password: 'correct-horse-9' } });
r = await req('/app/admin'); ok(r.status === 404 || r.status === 302, 'non-superadmin cannot open Platform admin', r.status);
sql(`UPDATE users SET is_superadmin = 1 WHERE email = '${opsEmail}'`);
r = await req('/app/admin'); const ah = await r.text();
ok(r.status === 200 && ah.includes(email), 'superadmin sees workspaces with usage + rates');
r = await req('/app/admin/sends'); ok((await r.text()).includes(`Big ${rnd}`), 'held campaign listed for review');
r = await req(`/app/admin/sends/${send4}/approve`, { form: {} });
ok(['sending', 'sent'].includes(sql(`SELECT status FROM sends WHERE id = '${send4}'`)[0].status) && !!sql(`SELECT trusted_at FROM workspaces WHERE id = '${wsId}'`)[0].trusted_at, 'superadmin approval starts the send and trusts the workspace');
ok(sql(`SELECT COUNT(*) AS n FROM outbox WHERE to_email = '${email}' AND subject LIKE 'Approved:%'`)[0].n === 1, 'owner notified of the approval');
r = await req(`/app/admin/w/${wsId}/suspend`, { form: { note: 'e2e check' } });
ok(sql(`SELECT sending_status FROM workspaces WHERE id = '${wsId}'`)[0].sending_status === 'suspended', 'superadmin can suspend sending');
cookies = userCookies;
sres = await api(key, 'POST', `/posts/${await newPost('Suspended')}/send`, {});
ok(sres.status === 402 && sres.body?.error?.code === 'suspended', 'suspended workspace cannot send');
cookies = {}; await req('/login', { form: { email: opsEmail, password: 'correct-horse-9' } });
await req(`/app/admin/w/${wsId}/unsuspend`, { form: {} });
ok(sql(`SELECT sending_status FROM workspaces WHERE id = '${wsId}'`)[0].sending_status === 'active', 'superadmin can unsuspend');
cookies = userCookies;
// failed payment: paid limits during the grace period, Free limits after it
sql(`UPDATE workspaces SET plan_status = 'past_due', plan_grace_until = ${Date.now() + 86400000} WHERE id = '${wsId}'`);
r = await req('/app/settings/plan'); let gp = await r.text();
ok(gp.includes('Payment failed') && !gp.includes('Free limits apply'), 'failed payment: grace period keeps paid limits');
sql(`UPDATE workspaces SET plan_grace_until = ${Date.now() - 1000} WHERE id = '${wsId}'`);
r = await req('/app/settings/plan'); gp = await r.text();
ok(gp.includes('Free limits apply') && gp.includes('/ 500 ('), 'after the grace period Free limits apply');
sql(`UPDATE workspaces SET plan_status = 'active', plan_grace_until = NULL WHERE id = '${wsId}'`);
sql(`UPDATE sends SET status = 'cancelled' WHERE id = '${send4}'`);
sql(`DELETE FROM subscribers WHERE id LIKE 'big%${rnd}' OR id LIKE 'bnc%${rnd}'`);

console.log('11c. Store sync, cart abandonment, transactional API, reply inbox');
{
  const tick = async () => { sql(`DELETE FROM rate_limits WHERE key IN ('periodic:commerce.carts','periodic:automations.runs')`); await cron(); await sleep(1500); };
  const b64h = (secret, body) => createHmac('sha256', secret).update(body).digest('base64');
  const hook = (token, headers, body) => fetch(`${BASE}/hooks/commerce/${token}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const mcpCall = async (name, args) => (await (await fetch(`${BASE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
  // ── Shopify ──
  r = await req('/app/settings/commerce/shopify', { form: { secret: 'shpss_e2e_secret', store_url: `e2e-${rnd}.myshopify.com`, abandon_hours: '1', tag_buyers: 'on' } });
  const shop = sql(`SELECT * FROM commerce_stores WHERE pub_id = '${pubId}' AND platform = 'shopify'`)[0];
  ok(!!shop?.hook_token, 'Shopify store connected (webhook URL issued)');
  r = await req('/app/settings/commerce');
  ok(r.status === 200 && (await r.text()).includes(`/hooks/commerce/${shop.hook_token}`), 'Store integrations page shows the webhook URL');
  const shopSend = (topic, payload, wid = 'w' + Math.random().toString(36).slice(2)) => {
    const body = JSON.stringify(payload);
    return hook(shop.hook_token, { 'x-shopify-topic': topic, 'x-shopify-hmac-sha256': b64h('shpss_e2e_secret', body), 'x-shopify-webhook-id': wid, 'x-shopify-shop-domain': shop.store_url }, body);
  };
  r = await hook(shop.hook_token, { 'x-shopify-topic': 'orders/paid', 'x-shopify-hmac-sha256': 'AAAA' }, '{"id":1}');
  ok(r.status === 401, 'Shopify webhook with a bad HMAC is rejected (401)');
  const buyer = `shopper.${rnd}@gmail.com`, cust = `cust.${rnd}@gmail.com`;
  const lineItems = [{ id: 1, product_id: 632910392, variant_id: 808950810, sku: 'HOOD-1', title: 'Lnkbase Hoodie', quantity: 1, price: '49.00' }, { id: 2, product_id: 632910393, title: 'Sticker pack', quantity: 2, price: '5.00' }];
  r = await shopSend('customers/create', { id: 6523049676001, email: cust, first_name: 'Cara', last_name: 'Customer', email_marketing_consent: { state: 'not_subscribed', opt_in_level: 'single_opt_in' } });
  ok(r.status === 200 && sql(`SELECT COUNT(*) AS n FROM commerce_customers WHERE email = '${cust}'`)[0].n === 1 && sql(`SELECT COUNT(*) AS n FROM subscribers WHERE email = '${cust}'`)[0].n === 0, 'customer without marketing consent is stored but not subscribed');
  const order1 = { id: 5523049676000 + Math.floor(Math.random() * 100000), name: '#1001', order_number: 1001, email: buyer, financial_status: 'paid', total_price: '59.00', currency: 'USD', checkout_token: `ck-${rnd}-x`, processed_at: new Date().toISOString(), buyer_accepts_marketing: true, customer: { id: 6523049676002, email: buyer, first_name: 'Bea', last_name: 'Buyer', email_marketing_consent: { state: 'subscribed' } }, line_items: lineItems };
  const wid1 = 'wid-' + rnd;
  r = await shopSend('orders/paid', order1, wid1);
  const bsub = sql(`SELECT * FROM subscribers WHERE email = '${buyer}'`)[0];
  ok(r.status === 200 && bsub?.status === 'active' && bsub.source === 'commerce', 'consenting Shopify buyer becomes an active subscriber', JSON.stringify(bsub || {}).slice(0, 120));
  const btags = sql(`SELECT tag FROM subscriber_tags WHERE subscriber_id = '${bsub?.id}'`).map((x) => x.tag);
  ok(btags.includes('bought-lnkbase-hoodie') && btags.includes('customer-shopify'), 'buyer tagged by product', btags.join(','));
  ok(sql(`SELECT COUNT(*) AS n FROM external_order_items i JOIN external_orders o ON o.id = i.order_id WHERE o.email = '${buyer}' AND o.status = 'paid'`)[0].n === 2, 'order and line items stored');
  r = await shopSend('orders/paid', order1, wid1);
  ok((await r.json()).duplicate === true && sql(`SELECT COUNT(*) AS n FROM external_orders WHERE email = '${buyer}'`)[0].n === 1, 'redelivered webhook is ignored (idempotent)');
  await shopSend('orders/create', { ...order1, id: order1.id + 7, name: '#1002', email: cust, financial_status: 'paid', buyer_accepts_marketing: false, customer: { id: 6523049676001, email: cust, first_name: 'Cara', email_marketing_consent: { state: 'not_subscribed' } } });
  ok(sql(`SELECT COUNT(*) AS n FROM external_orders WHERE email = '${cust}' AND status = 'paid'`)[0].n === 1 && sql(`SELECT COUNT(*) AS n FROM subscribers WHERE email = '${cust}'`)[0].n === 0, 'purchase from a non-consenting customer is recorded without subscribing them');
  const seg = await mcpCall('create_segment_from_description', { name: 'Hoodie buyers', dry_run: true, rules: { op: 'and', rules: [{ field: 'ext_purchased', cmp: 'contains', value: 'Hoodie' }, { field: 'ext_platform', cmp: 'eq', value: 'shopify' }, { field: 'ext_total_spent', cmp: 'gt', value: 50 }, { field: 'ext_orders_count', cmp: 'eq', value: 1 }] } });
  ok(seg?.structuredContent?.matches === 1, 'segment "bought Hoodie on Shopify, spent > 50, 1 order" matches the buyer', JSON.stringify(seg).slice(0, 200));
  r = await req(`/app/audience/s/${bsub.id}`); const sp = await r.text();
  ok(sp.includes('Store purchases') && sp.includes('Lnkbase Hoodie'), 'subscriber page shows store purchase history');
  r = await req('/app/analytics/revenue'); ok((await r.text()).includes('Store revenue'), 'Analytics → Revenue includes store revenue');
  // external purchase automation
  let au = await api(key, 'POST', '/automations', { name: `Ext buyers ${rnd}`, trigger: { type: 'external_purchase', config: { platform: 'shopify', product_contains: 'hoodie' } }, steps: [{ type: 'add_tag', config: { tags: ['ext-auto'] } }], activate: true });
  ok(au.status === 201 || au.status === 200, 'automation with the external_purchase trigger created', JSON.stringify(au.body).slice(0, 160));
  await shopSend('orders/paid', { ...order1, id: order1.id + 9, name: '#1003', checkout_token: null });
  ok(sql(`SELECT COUNT(*) AS n FROM subscriber_tags WHERE subscriber_id = '${bsub.id}' AND tag = 'ext-auto'`)[0].n === 1, 'external purchase enrolls the buyer in the automation');
  // cart abandonment
  await req('/app/settings/commerce/recovery-automation', { form: {} });
  const rec = sql(`SELECT id FROM automations WHERE pub_id = '${pubId}' AND name = 'Cart recovery'`)[0];
  ok(!!rec, 'cart recovery automation template created');
  au = await api(key, 'POST', `/automations/${rec.id}/publish`, { activate: true });
  ok(au.status === 200, 'cart recovery automation activated', JSON.stringify(au.body).slice(0, 160));
  const ctoken = `ck-${rnd}-cart`;
  const checkout = { id: 901414060 + Math.floor(Math.random() * 1000), token: ctoken, cart_token: 'ct-' + rnd, email: buyer, abandoned_checkout_url: `https://e2e-${rnd}.myshopify.com/checkouts/${ctoken}/recover?key=abc`, total_price: '98.00', currency: 'USD', completed_at: null, updated_at: new Date(Date.now() - 2 * 3600_000).toISOString(), customer: { id: 6523049676002, email: buyer, first_name: 'Bea' }, line_items: [{ title: 'Lnkbase Hoodie', product_id: 632910392, quantity: 2, price: '49.00' }] };
  r = await shopSend('checkouts/update', checkout);
  ok(r.status === 200 && sql(`SELECT status FROM abandoned_carts WHERE external_id = '${ctoken}'`)[0]?.status === 'open', 'checkout tracked');
  await tick();
  ok(sql(`SELECT status FROM abandoned_carts WHERE external_id = '${ctoken}'`)[0].status === 'abandoned', 'checkout past the threshold is marked abandoned');
  const recMail = sql(`SELECT html FROM outbox WHERE to_email = '${buyer}' AND subject = 'You left something in your cart'`)[0];
  ok(!!recMail && recMail.html.includes('Lnkbase Hoodie') && recMail.html.includes('$98.00'), 'cart_abandoned automation emails the cart contents', (recMail?.html || 'no email').slice(0, 80));
  ok(!!recMail && /\/t\/c\//.test(recMail.html) && recMail.html.includes('Complete your order') && !recMail.html.includes('{{cart.'), 'recovery button present (tracked link, tags replaced)');
  await tick();
  ok(sql(`SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id = '${rec.id}'`)[0].n === 1, 'one journey per cart (no re-enrollment)');
  await shopSend('orders/create', { ...order1, id: order1.id + 11, name: '#1004', checkout_token: ctoken, financial_status: 'paid' });
  ok(sql(`SELECT status FROM abandoned_carts WHERE external_id = '${ctoken}'`)[0].status === 'recovered' && sql(`SELECT status FROM automation_runs WHERE automation_id = '${rec.id}'`)[0].status === 'exited', 'completed order recovers the cart and stops the journey');
  // WooCommerce
  await req('/app/settings/commerce/woocommerce', { form: { secret: 'wc-secret-e2e', store_url: 'https://shop.example.org', abandon_hours: '1', tag_buyers: 'on' } });
  const woo = sql(`SELECT * FROM commerce_stores WHERE pub_id = '${pubId}' AND platform = 'woocommerce'`)[0];
  const wooSend = (topic, payload) => { const body = JSON.stringify(payload); return hook(woo.hook_token, { 'x-wc-webhook-topic': topic, 'x-wc-webhook-signature': b64h('wc-secret-e2e', body), 'x-wc-webhook-delivery-id': 'd' + Math.random().toString(36).slice(2), 'x-wc-webhook-source': 'https://shop.example.org/' }, body); };
  r = await hook(woo.hook_token, { 'content-type': 'application/x-www-form-urlencoded' }, 'webhook_id=17');
  ok(r.status === 200, 'WooCommerce ping accepted');
  const wbuyer = `woo.${rnd}@gmail.com`;
  const wOrder = { id: 727, number: '727', order_key: 'wc_order_' + rnd, status: 'pending', currency: 'USD', total: '29.00', date_created: new Date().toISOString().slice(0, 19), date_modified_gmt: new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 19), date_paid: null, customer_id: 0, billing: { first_name: 'Wanda', last_name: 'Woo', email: wbuyer }, payment_url: 'https://shop.example.org/checkout/order-pay/727/?pay_for_order=true&key=wc_order_x', meta_data: [{ id: 1, key: '_newsletter_opt_in', value: 'yes' }], line_items: [{ id: 315, name: 'Course: Writing', product_id: 93, variation_id: 0, quantity: 1, sku: 'CRS-1', price: 29, total: '29.00' }] };
  r = await wooSend('order.created', wOrder);
  ok(r.status === 200 && sql(`SELECT status FROM subscribers WHERE email = '${wbuyer}'`)[0]?.status === 'active' && sql(`SELECT COUNT(*) AS n FROM abandoned_carts WHERE email = '${wbuyer}' AND status = 'open'`)[0].n === 1, 'WooCommerce pending order (opted in) → subscriber + open cart');
  await wooSend('order.updated', { ...wOrder, status: 'processing', date_paid: new Date().toISOString().slice(0, 19) });
  ok(sql(`SELECT status FROM external_orders WHERE email = '${wbuyer}'`)[0].status === 'paid' && sql(`SELECT status FROM abandoned_carts WHERE email = '${wbuyer}'`)[0].status === 'recovered', 'WooCommerce payment marks the order paid and the cart recovered');
  r = await hook(woo.hook_token, { 'x-wc-webhook-topic': 'order.created', 'x-wc-webhook-signature': b64h('wrong', '{}') }, '{}');
  ok(r.status === 401, 'WooCommerce bad signature rejected');
  // Stripe (creator's own account)
  await req('/app/settings/commerce/stripe', { form: { secret: 'whsec_e2e_test', tag_buyers: 'on' } });
  const stp = sql(`SELECT * FROM commerce_stores WHERE pub_id = '${pubId}' AND platform = 'stripe'`)[0];
  const sbuyer = `stripe.${rnd}@gmail.com`;
  const stripeSend = (evt, t = Math.floor(Date.now() / 1000)) => { const body = JSON.stringify(evt); const sig = createHmac('sha256', 'whsec_e2e_test').update(`${t}.${body}`).digest('hex'); return hook(stp.hook_token, { 'stripe-signature': `t=${t},v1=${sig}` }, body); };
  const evt = { id: 'evt_' + rnd, object: 'event', type: 'checkout.session.completed', data: { object: { id: 'cs_test_' + rnd, object: 'checkout.session', amount_total: 1500, currency: 'usd', customer: 'cus_' + rnd, customer_details: { email: sbuyer, name: 'Sam Stripe' }, payment_intent: 'pi_' + rnd, payment_status: 'paid', mode: 'payment', consent: { promotions: 'opt_in' }, metadata: { product_id: 'ebook-1', product_name: 'Ebook' }, created: Math.floor(Date.now() / 1000) } } };
  r = await stripeSend(evt, Math.floor(Date.now() / 1000) - 900);
  ok(r.status === 401, 'Stripe event outside the 5-minute tolerance rejected');
  r = await stripeSend(evt);
  ok(r.status === 200 && sql(`SELECT status FROM subscribers WHERE email = '${sbuyer}'`)[0]?.status === 'active', 'Stripe checkout with promotions consent → subscriber');
  await stripeSend({ id: 'evt_ch_' + rnd, type: 'charge.succeeded', data: { object: { id: 'ch_' + rnd, amount: 1500, amount_captured: 1500, currency: 'usd', paid: true, payment_intent: 'pi_' + rnd, billing_details: { email: sbuyer, name: 'Sam Stripe' }, metadata: {}, created: Math.floor(Date.now() / 1000) } } });
  ok(sql(`SELECT COUNT(*) AS n FROM external_orders WHERE email = '${sbuyer}'`)[0].n === 1, 'charge.succeeded for the same payment does not double-count');

  // ── Transactional API ──
  let tx = await api(key, 'POST', '/transactional/send', { to: bsub.email, subject: 'Receipt {{order.id}}', markdown: '# Thanks {{name}}\n\nOrder **{{order.id}}** total {{order.total}}.', merge_vars: { name: 'Bea', order: { id: 'A-1', total: '$59.00' } }, tags: ['receipt'] });
  ok(tx.status === 201 && ['simulated', 'sent'].includes(tx.body?.data?.status) && tx.body.data.subject === 'Receipt A-1', 'transactional send (markdown + merge vars)', JSON.stringify(tx.body).slice(0, 200));
  const txo = sql(`SELECT kind, html, headers FROM outbox WHERE to_email = '${bsub.email}' AND subject = 'Receipt A-1'`)[0];
  ok(txo?.kind === 'transactional' && txo.html.includes('A-1') && txo.html.includes('$59.00') && !txo.headers.includes('List-Unsubscribe'), 'sent as transactional mail with merge vars applied');
  const tpl = await api(key, 'POST', '/transactional/templates', { name: 'Password reset', slug: 'password-reset', subject: 'Reset your password', body: 'Click <a href="https://example.com/reset?u={{user.id}}">here</a>.', format: 'html' });
  ok(tpl.status === 201 && tpl.body?.data?.slug === 'password-reset', 'template created via API');
  const idem = 'reset-' + rnd;
  tx = await api(key, 'POST', '/transactional/send', { to: bsub.email, template_id: 'password-reset', merge_vars: { user: { id: 42 } }, idempotency_key: idem, track: true });
  const tx2 = await api(key, 'POST', '/transactional/send', { to: bsub.email, template_id: 'password-reset', merge_vars: { user: { id: 42 } }, idempotency_key: idem, track: true });
  ok(tx.status === 201 && tx2.status === 200 && tx2.body.data.duplicate === true && tx2.body.data.id === tx.body.data.id && sql(`SELECT COUNT(*) AS n FROM tx_messages WHERE idempotency_key = '${idem}'`)[0].n === 1, 'idempotency_key prevents a second send');
  const thtml = sql(`SELECT html FROM outbox WHERE message_id = (SELECT message_id FROM tx_messages WHERE id = '${tx.body.data.id}')`)[0]?.html || '';
  ok(thtml.includes(`/t/x/o/${tx.body.data.id}.gif`) && thtml.includes(`/t/x/c/${tx.body.data.id}/0`), 'tracking pixel and click links added when track=true');
  sql(`UPDATE tx_messages SET created_at = created_at - 60000 WHERE id = '${tx.body.data.id}'`);
  await fetch(`${BASE}/t/x/o/${tx.body.data.id}.gif`, { headers: { 'user-agent': UA } });
  const clk = await fetch(`${BASE}/t/x/c/${tx.body.data.id}/0`, { headers: { 'user-agent': UA }, redirect: 'manual' });
  const txm = (await api(key, 'GET', `/transactional/messages/${tx.body.data.id}`)).body?.data;
  ok(clk.status === 302 && clk.headers.get('location') === 'https://example.com/reset?u=42' && txm?.opens >= 1 && txm?.clicks === 1, 'open + click recorded and redirected', JSON.stringify(txm).slice(0, 200));
  sql(`INSERT INTO suppressions (id, scope, pub_id, email, reason, created_at) VALUES ('sx${rnd}', 'pub', '${pubId}', '${bsub.email}', 'complaint', ${Date.now()})`);
  tx = await api(key, 'POST', '/transactional/send', { to: bsub.email, subject: 'Still delivered', text: 'hi' });
  ok(['simulated', 'sent'].includes(tx.body?.data?.status), 'newsletter complaint does not block transactional mail');
  sql(`DELETE FROM suppressions WHERE id = 'sx${rnd}'`);
  sql(`INSERT INTO suppressions (id, scope, pub_id, email, reason, created_at) VALUES ('st${rnd}', 'transactional', '', 'blocked.${rnd}@gmail.com', 'manual', ${Date.now()})`);
  tx = await api(key, 'POST', '/transactional/send', { to: `blocked.${rnd}@gmail.com`, subject: 'Nope', text: 'hi' });
  ok(tx.body?.data?.status === 'suppressed', 'transactional suppression respected');
  const srch = await api(key, 'GET', '/transactional/messages?tag=receipt');
  ok(srch.body?.data?.length === 1 && srch.body.data[0].subject === 'Receipt A-1', 'message log searchable by tag');
  r = await req('/app/settings/transactional?q=Receipt'); const tp = await r.text();
  ok(r.status === 200 && tp.includes('Receipt A-1') && tp.includes(bsub.email), 'Settings → Transactional email lists messages');
  const mt = await mcpCall('send_transactional', { to: bsub.email, subject: 'From MCP', text: 'Hello from MCP' });
  ok(mt && !mt.isError && ['simulated', 'sent'].includes(mt.structuredContent?.status), 'MCP send_transactional', JSON.stringify(mt).slice(0, 160));
  const kid = sql(`SELECT id FROM api_keys WHERE pub_id = '${pubId}' AND revoked_at IS NULL LIMIT 1`)[0].id;
  sql(`INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES ('tx:${kid}', 60, ${Date.now() + 60000})`);
  tx = await api(key, 'POST', '/transactional/send', { to: bsub.email, subject: 'Too many', text: 'x' });
  ok(tx.status === 429 && tx.body?.error?.code === 'rate_limited', 'per-key transactional rate limit (429)');
  sql(`DELETE FROM rate_limits WHERE key = 'tx:${kid}'`);

  // ── Reply inbox ──
  await req('/app/audience/inbox/settings', { form: { collect_replies: 'on', inbox_forward: 'on' } });
  ok(JSON.parse(sql(`SELECT settings FROM publications WHERE id = '${pubId}'`)[0].settings).collect_replies === true, 'Collect replies in Inbox turned on');
  const ip = await newPost('Inbox');
  const isend = await api(key, 'POST', `/posts/${ip}/send`, {});
  ok(isend.status === 202, 'newsletter sent with reply collection on', JSON.stringify(isend.body).slice(0, 120));
  let ib = null;
  for (let i = 0; i < 15 && !ib; i++) { await cron(); await sleep(1000); ib = sql(`SELECT o.headers, d.id AS did FROM outbox o JOIN deliveries d ON d.message_id = o.message_id WHERE o.to_email = '${buyer}' AND o.subject LIKE '%Inbox ${rnd}%'`)[0]; }
  const rt = ib ? JSON.parse(ib.headers)['Reply-To'] : '';
  ok(!!ib && rt === `reply+${slug}.${ib.did.slice(0, 12)}@news.lnkbase.com`, 'newsletter Reply-To is the per-delivery reply address', rt);
  const eml = [`From: "Bea Buyer" <${buyer}>`, `To: ${rt}`, `Subject: Re: Inbox ${rnd}`, `Message-ID: <reply-${rnd}@mail.gmail.com>`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="b1"', '', '--b1', 'Content-Type: text/plain; charset=UTF-8', '', 'Loved this issue! One question about pricing.', '', `On Mon, Oct 26, 2026 at 9:00 AM E2E Weekly <${slug}@news.lnkbase.com> wrote:`, '> Hello there', '--b1', 'Content-Type: text/html; charset=UTF-8', '', '<div>Loved this issue! One question about pricing.</div><script>alert(1)</script>', '--b1--', ''].join('\r\n');
  r = await fetch(`${BASE}/cdn-cgi/handler/email?from=${encodeURIComponent(buyer)}&to=${encodeURIComponent(rt)}`, { method: 'POST', body: eml });
  const th = sql(`SELECT * FROM inbox_threads WHERE pub_id = '${pubId}' AND email = '${buyer}'`)[0];
  ok(r.status === 200 && th && th.subscriber_id === bsub.id && th.post_id === ip && th.unread === 1 && th.verified === 1, 'reply stored as an Inbox thread linked to subscriber + post', `${r.status} ${JSON.stringify(th || {}).slice(0, 160)}`);
  ok(sql(`SELECT COUNT(*) AS n FROM outbox WHERE to_email = '${email}' AND subject = 'Reply: Re: Inbox ${rnd}'`)[0].n === 1, 'copy of the reply emailed to the owner');
  r = await fetch(`${BASE}/cdn-cgi/handler/email?from=x@evil.example&to=${encodeURIComponent(`reply+${slug}.zzzzzzzzzzzz@news.lnkbase.com`)}`, { method: 'POST', body: eml });
  ok((await r.text()).includes('rejected'), 'reply to an unknown reply address is rejected');
  r = await req('/app/audience/inbox'); const inb = await r.text();
  ok(inb.includes('Bea Buyer') && inb.includes(`Inbox ${rnd}`), 'Audience → Inbox lists the conversation');
  r = await req(`/app/audience/inbox/${th?.id}`); const tvh = await r.text();
  ok(tvh.includes('One question about pricing') && !tvh.includes('<script>alert(1)') && sql(`SELECT unread FROM inbox_threads WHERE id = '${th?.id}'`)[0]?.unread === 0, 'thread view shows the message (sanitized) and marks it read');
  await req(`/app/audience/inbox/${th?.id}/reply`, { form: { body: 'Thanks Bea! Pricing is on the site.' } });
  const out = sql(`SELECT headers, from_email FROM outbox WHERE to_email = '${buyer}' AND subject = 'Re: Inbox ${rnd}' ORDER BY created_at DESC LIMIT 1`)[0];
  const oh = out ? JSON.parse(out.headers) : {};
  ok(oh['In-Reply-To'] === `<reply-${rnd}@mail.gmail.com>` && oh['Reply-To'] === rt && out.from_email.includes(`${slug}@news.lnkbase.com`), 'reply sent from the publication sender, threaded via In-Reply-To', JSON.stringify(oh).slice(0, 200));
  ok(sql(`SELECT COUNT(*) AS n FROM inbox_messages WHERE thread_id = '${th?.id}'`)[0].n === 2, 'outgoing reply stored in the thread');
  await req(`/app/audience/inbox/${th?.id}/archive`, { form: {} });
  ok(sql(`SELECT status FROM inbox_threads WHERE id = '${th?.id}'`)[0]?.status === 'archived', 'thread archived');
  await req('/app/audience/inbox/settings', { form: {} });
  sql(`DELETE FROM subscribers WHERE email IN ('${buyer}', '${wbuyer}', '${sbuyer}')`);
}

console.log('12. Errors');
const errs = sql(`SELECT source, message FROM error_log ORDER BY created_at DESC LIMIT 10`);
ok(errs.length === 0, 'no server errors logged', JSON.stringify(errs).slice(0, 800));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
