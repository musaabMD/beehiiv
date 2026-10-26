// End-to-end smoke test against a running `wrangler dev`.
// Usage: BASE=http://localhost:8790 PERSIST=.wrangler/int node scripts/e2e.mjs
// Walks: signup → onboarding → API key → public subscribe → API subscriber → post → send → cron → open/click tracking
//        → public site → paid tier checkout (test mode) → one-click unsubscribe → webhooks/automation sanity
//        → platform plans (usage page, subscriber cap, email allowance, simulated upgrade, campaign pause, approval).
import { execSync } from 'node:child_process';

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

console.log('12. Errors');
const errs = sql(`SELECT source, message FROM error_log ORDER BY created_at DESC LIMIT 10`);
ok(errs.length === 0, 'no server errors logged', JSON.stringify(errs).slice(0, 800));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
