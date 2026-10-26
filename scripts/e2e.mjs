// End-to-end smoke test against a running `wrangler dev`.
// Usage: BASE=http://localhost:8790 PERSIST=.wrangler/int node scripts/e2e.mjs
// Walks: signup → onboarding → API key → public subscribe → API subscriber → post → send → cron → open/click tracking
//        → public site → paid tier checkout (test mode) → one-click unsubscribe → webhooks/automation sanity
//        → platform plans (usage page, subscriber cap, email allowance, simulated upgrade, campaign pause, approval)
//        → marketing (social posting against a local mock Bluesky PDS + Mastodon, calendar, campaigns, ad audiences),
//          PWA, and SSO (Google + Enterprise OIDC against a local mock provider on MOCK_PORT, default 8816).
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

console.log('11m. Marketing: social posting (mock Bluesky + Mastodon), calendar, campaigns, ad audiences, PWA, SSO (mock OIDC)');
{
  // Local mock of the third-party APIs (documented endpoints only): AT Protocol PDS, Mastodon, and two OIDC providers.
  const http = await import('node:http');
  const nodeCrypto = await import('node:crypto');
  const MOCK_PORT = Number(process.env.MOCK_PORT || 8816);
  const MOCK = `http://localhost:${MOCK_PORT}`;
  const log = [];
  const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  const b64u = (b) => Buffer.from(b).toString('base64url');
  const codes = new Map();
  const idp = { google: { sub: 'g-1-' + rnd, email: `google.${rnd}@gmail.com`, email_verified: true, name: 'Goo Gle' }, corp: { sub: 'c-1-' + rnd, email: `alice@corp-${rnd}.example`, email_verified: true, name: 'Alice Corp' } };
  const clients = { google: ['mock-google-client', 'mock-google-secret'], corp: ['corp-client', 'corp-secret'] };
  const readBody = (q) => new Promise((res) => { const ch = []; q.on('data', (d) => ch.push(d)); q.on('end', () => res(Buffer.concat(ch))); });
  const server = http.createServer(async (q, s) => {
    const u = new URL(q.url, MOCK);
    const body = await readBody(q);
    const json = (code, obj) => { s.writeHead(code, { 'content-type': 'application/json' }); s.end(JSON.stringify(obj)); };
    log.push({ method: q.method, path: u.pathname, auth: q.headers.authorization || '', ct: q.headers['content-type'] || '', body: body.toString('utf8', 0, Math.min(body.length, 4000)), size: body.length });
    const m = u.pathname.match(/^\/(google|corp)(\/.*)$/);
    if (m) {
      const [, p, rest] = m;
      const iss = `${MOCK}/${p}`;
      if (rest === '/.well-known/openid-configuration') return json(200, { issuer: iss, authorization_endpoint: `${iss}/authorize`, token_endpoint: `${iss}/token`, jwks_uri: `${iss}/jwks`, userinfo_endpoint: `${iss}/userinfo` });
      if (rest === '/jwks') return json(200, { keys: [jwk] });
      if (rest === '/authorize') {
        const code = 'code-' + nodeCrypto.randomBytes(8).toString('hex');
        codes.set(code, { p, nonce: u.searchParams.get('nonce'), challenge: u.searchParams.get('code_challenge'), client: u.searchParams.get('client_id'), redirect: u.searchParams.get('redirect_uri'), who: { ...idp[p] } });
        s.writeHead(302, { location: `${u.searchParams.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(u.searchParams.get('state'))}` });
        return s.end();
      }
      if (rest === '/token') {
        const f = new URLSearchParams(body.toString());
        const c = codes.get(f.get('code'));
        codes.delete(f.get('code'));
        if (!c || c.p !== p || f.get('client_id') !== clients[p][0] || f.get('client_secret') !== clients[p][1] || f.get('redirect_uri') !== c.redirect) return json(400, { error: 'invalid_grant' });
        if (b64u(nodeCrypto.createHash('sha256').update(f.get('code_verifier') || '').digest()) !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
        const now = Math.floor(Date.now() / 1000);
        const head = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
        const claims = b64u(JSON.stringify({ iss, aud: c.client, sub: c.who.sub, email: c.who.email, email_verified: c.who.email_verified, name: c.who.name, nonce: c.nonce, iat: now, exp: now + 300 }));
        const sig = b64u(nodeCrypto.sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), privateKey));
        return json(200, { access_token: 'at-' + rnd, token_type: 'Bearer', id_token: `${head}.${claims}.${sig}` });
      }
    }
    // AT Protocol (Bluesky PDS)
    if (u.pathname === '/bsky/xrpc/com.atproto.server.createSession') {
      const b = JSON.parse(body.toString() || '{}');
      if (b.identifier !== 'tester.bsky.social' || b.password !== 'abcd-efgh-ijkl-mnop') return json(401, { error: 'AuthenticationRequired', message: 'Invalid identifier or password' });
      return json(200, { accessJwt: 'jwt-' + rnd, refreshJwt: 'r', did: 'did:plc:tester', handle: 'tester.bsky.social' });
    }
    if (u.pathname === '/bsky/xrpc/com.atproto.repo.uploadBlob') {
      if (q.headers.authorization !== 'Bearer jwt-' + rnd) return json(401, { error: 'AuthMissing' });
      return json(200, { blob: { $type: 'blob', ref: { $link: 'bafkreimock' }, mimeType: q.headers['content-type'], size: body.length } });
    }
    if (u.pathname === '/bsky/xrpc/com.atproto.repo.createRecord') {
      if (q.headers.authorization !== 'Bearer jwt-' + rnd) return json(401, { error: 'AuthMissing' });
      const rk = 'rk' + nodeCrypto.randomBytes(4).toString('hex');
      return json(200, { uri: `at://did:plc:tester/app.bsky.feed.post/${rk}`, cid: 'bafyreimock' });
    }
    // Mastodon
    const mastoAuth = q.headers.authorization === 'Bearer masto-token-' + rnd;
    if (u.pathname.startsWith('/masto/api/') && !mastoAuth) return json(401, { error: 'The access token is invalid' });
    if (u.pathname === '/masto/api/v1/accounts/verify_credentials') return json(200, { id: '109', username: 'tester', acct: 'tester', display_name: 'Tester', url: `${MOCK}/masto/@tester` });
    if (u.pathname === '/masto/api/v2/media') return json(200, { id: 'm1', type: 'image', url: `${MOCK}/masto/media/m1.png` });
    if (u.pathname === '/masto/api/v1/statuses') { const b = JSON.parse(body.toString() || '{}'); return json(200, { id: '1100' + log.length, url: `${MOCK}/masto/@tester/1100${log.length}`, content: b.status }); }
    if (u.pathname === '/page') { s.writeHead(200, { 'content-type': 'text/html' }); return s.end('<html><head><title>Mock page</title><meta property="og:title" content="Mock OG title"><meta property="og:description" content="Mock description"></head></html>'); }
    json(404, { error: 'not found' });
  });
  await new Promise((res) => server.listen(MOCK_PORT, res));
  const mockLog = (path) => log.filter((l) => l.path === path);

  try {
    cookies = {};
    const mEmail = `mkt.${rnd}@gmail.com`;
    await req('/signup', { form: { name: 'Mkt Owner', email: mEmail, password: 'correct-horse-9' } });
    const mSlug = `mkt-${rnd}`;
    await req('/app/onboarding', { form: { name: `Mkt ${rnd}`, slug: mSlug, description: 'Marketing', language: 'en', timezone: 'UTC' } });
    const mPub = sql(`SELECT id, workspace_id FROM publications WHERE slug = '${mSlug}'`)[0];
    const mKeyHtml = await (await req('/app/settings/api', { form: { name: 'mkt' } })).text();
    const mKey = mKeyHtml.match(/oh_live_[A-Za-z0-9_-]+/)?.[0];
    const mkt = cookies;

    // ── social accounts ──
    r = await req('/app/social/accounts/bluesky', { form: { identifier: 'tester.bsky.social', app_password: 'wrong-pass', service: `${MOCK}/bsky` } });
    ok(decodeURIComponent(decodeURIComponent(cookies.oh_flash || '')).includes("Couldn't connect Bluesky") && !sql(`SELECT COUNT(*) AS n FROM social_accounts WHERE pub_id = '${mPub.id}'`)[0].n, 'Bluesky: wrong app password is rejected');
    r = await req('/app/social/accounts/bluesky', { form: { identifier: '@tester.bsky.social', app_password: 'abcd-efgh-ijkl-mnop', service: `${MOCK}/bsky` } });
    r = await req('/app/social/accounts/mastodon', { form: { instance: `${MOCK}/masto`, token: `masto-token-${rnd}` } });
    const accts = sql(`SELECT id, network, handle, credentials FROM social_accounts WHERE pub_id = '${mPub.id}' ORDER BY network`);
    ok(accts.length === 2 && accts[0].handle === '@tester.bsky.social' && accts[1].handle.startsWith('@tester@localhost'), 'Bluesky (createSession) and Mastodon (verify_credentials) connected', JSON.stringify(accts.map((a) => a.handle)));
    ok(accts.every((a) => a.credentials.startsWith('v1.') && !a.credentials.includes('abcd-efgh') && !a.credentials.includes('masto-token')), 'credentials are AES-GCM encrypted at rest');
    const [bsky, masto] = accts;

    // ── compose: post now with link + image to both ──
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const fd = new FormData(); fd.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
    const up = await (await fetch(`${BASE}/app/posts/media/upload`, { method: 'POST', headers: { cookie: jar(), 'user-agent': UA }, body: fd })).json();
    const imgKey = sql(`SELECT key FROM uploads WHERE id = '${up.id}'`)[0]?.key;
    ok(!!imgKey, 'image uploaded to the media library');
    r = await req('/app/social/new'); const compose = await r.text();
    ok(r.status === 200 && compose.includes('data-intent="linkedin"') && compose.includes('Write a post for this issue'), 'composer renders (share intents + AI helper)');
    const pf = new URLSearchParams({ text: `Hello from the e2e ${rnd} https://example.com/inline`, link: `${MOCK}/page`, image_key: imgKey, image_alt: 'a pixel', when: 'now' });
    pf.append('accounts[]', bsky.id); pf.append('accounts[]', masto.id);
    r = await fetch(`${BASE}/app/social/posts`, { method: 'POST', headers: { cookie: jar(), 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' }, body: pf, redirect: 'manual' });
    for (let i = 0; i < 6; i++) { await cron(); await sleep(1200); if (sql(`SELECT COUNT(*) AS n FROM social_posts WHERE pub_id = '${mPub.id}' AND status = 'posted'`)[0].n >= 2) break; }
    const posted = sql(`SELECT network, status, remote_url, link_url, error FROM social_posts WHERE pub_id = '${mPub.id}' ORDER BY network`);
    ok(posted.length === 2 && posted.every((p) => p.status === 'posted'), 'post now: both networks posted via the job queue', JSON.stringify(posted));
    ok(posted[0].remote_url?.startsWith('https://bsky.app/profile/tester.bsky.social/post/rk') && posted[1].remote_url?.includes('/masto/@tester/'), 'history links to the live posts', JSON.stringify(posted.map((p) => p.remote_url)));
    const rec = JSON.parse(mockLog('/bsky/xrpc/com.atproto.repo.createRecord').at(-1)?.body || '{}');
    ok(rec.record?.embed?.$type === 'app.bsky.embed.external' && rec.record.embed.external.title === 'Mock OG title' && rec.record.embed.external.thumb?.ref && rec.record.embed.external.uri.includes('utm_source=bluesky') && rec.record.facets?.[0]?.features?.[0]?.uri === 'https://example.com/inline', 'Bluesky record: link card (OG title, image thumb, UTM-tagged) + link facet', JSON.stringify(rec).slice(0, 300));
    ok(mockLog('/bsky/xrpc/com.atproto.repo.uploadBlob').length >= 1 && mockLog('/bsky/xrpc/com.atproto.repo.uploadBlob')[0].ct === 'image/png', 'Bluesky image uploaded as a blob');
    const st = JSON.parse(mockLog('/masto/api/v1/statuses').at(-1)?.body || '{}');
    ok(st.media_ids?.[0] === 'm1' && st.status.includes('utm_source=mastodon') && st.visibility === 'public' && mockLog('/masto/api/v2/media')[0]?.ct.startsWith('multipart/form-data'), 'Mastodon: media upload + status with UTM link', JSON.stringify(st).slice(0, 200));
    r = await req('/app/social'); const hist = await r.text();
    ok(hist.includes('data-live-url') && hist.includes('bsky.app/profile/tester.bsky.social'), 'history page shows live links');

    // ── schedule + failure path ──
    const tomorrow = new Date(Date.now() + 26 * 3600e3);
    const sf = new URLSearchParams({ text: `Scheduled ${rnd}`, link: '', when: 'schedule', scheduled_at: tomorrow.toISOString() }); sf.append('accounts[]', bsky.id);
    await fetch(`${BASE}/app/social/posts`, { method: 'POST', headers: { cookie: jar(), 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' }, body: sf, redirect: 'manual' });
    const sched = sql(`SELECT id, status, scheduled_at FROM social_posts WHERE pub_id = '${mPub.id}' AND text = 'Scheduled ${rnd}'`)[0];
    ok(sched?.status === 'scheduled' && Math.abs(sched.scheduled_at - tomorrow.getTime()) < 2000 && sql(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'social.post' AND payload LIKE '%${sched.id}%' AND status = 'pending'`)[0].n === 1, 'scheduled social post queued for its time');
    const tooLong = new URLSearchParams({ text: 'x'.repeat(301), when: 'now' }); tooLong.append('accounts[]', bsky.id);
    await fetch(`${BASE}/app/social/posts`, { method: 'POST', headers: { cookie: jar(), 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' }, body: tooLong, redirect: 'manual' });
    ok(!sql(`SELECT COUNT(*) AS n FROM social_posts WHERE pub_id = '${mPub.id}' AND length(text) = 301`)[0].n, 'Bluesky 300-character limit enforced');

    // ── AI helper (falls back to a plain draft when Workers AI is unavailable) ──
    const draftPost = await api(mKey, 'POST', '/posts', { title: `Launch issue ${rnd}`, subtitle: 'Big news', markdown: `Read [the launch](https://example.com/launch) and [docs](https://example.com/docs?x=1).`, platform: 'both' });
    const dpId = draftPost.body?.data?.id;
    r = await req('/app/social/suggest', { json: { post_id: dpId, network: 'bluesky' }, headers: { accept: 'application/json' } });
    const sug = await r.json().catch(() => ({}));
    ok(r.status === 200 && typeof sug.text === 'string' && sug.text.length > 5 && sug.text.length <= 300, `AI "write a post for this issue" returns a draft (ai=${sug.ai})`, JSON.stringify(sug).slice(0, 160));

    // ── auto-share on publish ──
    await req(`/app/social/accounts/${bsky.id}/auto`, { form: { on: '1' } });
    const pubPost = await api(mKey, 'POST', '/posts', { title: `Auto ${rnd}`, subtitle: 'Shared automatically', markdown: 'Hello', platform: 'web' });
    await req(`/app/posts/${pubPost.body.data.id}/publish`, { json: { mode: 'now' }, headers: { accept: 'application/json' } });
    for (let i = 0; i < 5; i++) { await cron(); await sleep(1200); if (sql(`SELECT status FROM social_posts WHERE post_id = '${pubPost.body.data.id}'`)[0]?.status === 'posted') break; }
    const auto = sql(`SELECT status, text, link_url, account_id FROM social_posts WHERE post_id = '${pubPost.body.data.id}'`);
    ok(auto.length === 1 && auto[0].account_id === bsky.id && auto[0].status === 'posted' && auto[0].link_url.includes(`/p/`) && auto[0].text.startsWith(`Auto ${rnd}`), 'publishing a post auto-shares it to channels with auto-share on (only those)', JSON.stringify(auto));

    // ── calendar ──
    const schedPost = await api(mKey, 'POST', '/posts', { title: `Calendar ${rnd}`, markdown: 'Hi', platform: 'both' });
    const spId = schedPost.body.data.id;
    const inTwoDays = new Date(Date.now() + 2 * 86400e3); inTwoDays.setUTCHours(15, 30, 0, 0);
    r = await req(`/app/posts/${spId}/publish`, { json: { mode: 'schedule', scheduled_at: inTwoDays.toISOString() }, headers: { accept: 'application/json' } });
    r = await req(`/app/calendar?view=month&date=${inTwoDays.toISOString().slice(0, 10)}`); let calHtml = await r.text();
    ok(r.status === 200 && calHtml.includes(`Calendar ${rnd}`) && calHtml.includes(`data-id="${spId}"`) && calHtml.includes('data-drag="1"') && calHtml.includes(`Auto ${rnd}`), 'month calendar shows scheduled + sent posts and social posts (draggable when scheduled)');
    r = await req(`/app/calendar?view=week&date=${inTwoDays.toISOString().slice(0, 10)}&types=post`); calHtml = await r.text();
    ok(r.status === 200 && calHtml.includes(`Calendar ${rnd}`) && !calHtml.includes('data-kind="social"'), 'week view + type filter');
    const target = new Date(inTwoDays.getTime() + 3 * 86400e3).toISOString().slice(0, 10);
    sql(`UPDATE workspaces SET sending_status = 'suspended' WHERE id = '${mPub.workspace_id}'`);
    r = await req('/app/calendar/move', { json: { kind: 'post', id: spId, date: target }, headers: { accept: 'application/json' } });
    const blocked = await r.json();
    ok(r.status === 402 && blocked.code === 'suspended', 'drag-to-reschedule respects sending safety (suspended → 402)', JSON.stringify(blocked).slice(0, 160));
    sql(`UPDATE workspaces SET sending_status = 'active' WHERE id = '${mPub.workspace_id}'`);
    r = await req('/app/calendar/move', { json: { kind: 'post', id: spId, date: target }, headers: { accept: 'application/json' } });
    const mv = await r.json();
    ok(r.status === 200 && mv.at === `${target}T15:30:00.000Z`, 'move keeps the time of day', JSON.stringify(mv));
    r = await req(`/app/posts/${spId}/publish`, { json: { mode: 'schedule', scheduled_at: mv.at }, headers: { accept: 'application/json' } });
    ok(r.status === 200 && sql(`SELECT scheduled_at FROM posts WHERE id = '${spId}'`)[0].scheduled_at === Date.parse(mv.at), 'post rescheduled through the existing schedule route');
    r = await req('/app/calendar/move', { json: { kind: 'social', id: sched.id, date: target }, headers: { accept: 'application/json' } });
    ok(r.status === 200 && new Date(sql(`SELECT scheduled_at FROM social_posts WHERE id = '${sched.id}'`)[0].scheduled_at).toISOString().slice(0, 10) === target, 'scheduled social post moved on the calendar');
    r = await req('/app/calendar/move', { json: { kind: 'post', id: pubPost.body.data.id, date: target }, headers: { accept: 'application/json' } });
    ok(r.status === 409, 'sent posts cannot be dragged');

    // ── campaigns ──
    r = await req('/app/campaigns', { form: { name: `Spring ${rnd}`, starts: new Date().toISOString().slice(0, 10), ends: target, goal_kind: 'signups', goal_target: '10' } });
    const camp = sql(`SELECT id, slug FROM campaigns WHERE pub_id = '${mPub.id}'`)[0];
    ok(camp && camp.slug === `spring-${rnd}`, 'campaign created with slug = utm_campaign');
    await req(`/app/campaigns/${camp.id}/items`, { form: { kind: 'post', ref_post: dpId } });
    await req(`/app/campaigns/${camp.id}/items`, { form: { kind: 'social', ref_social: sched.id } });
    const tagged = sql(`SELECT content FROM posts WHERE id = '${dpId}'`)[0].content;
    ok(tagged.includes(`utm_campaign=spring-${rnd}`) && tagged.includes(`utm_source=${mSlug}`) && tagged.includes('x=1'), 'links in campaign posts get utm_campaign automatically', tagged.slice(0, 300));
    ok(sql(`SELECT campaign_id FROM social_posts WHERE id = '${sched.id}'`)[0].campaign_id === camp.id, 'social post grouped into the campaign');
    // a reader signs up through a campaign link, then buys something
    const cReader = `camp.reader.${rnd}@gmail.com`;
    const saved = cookies; cookies = {};
    await req(`/s/${mSlug}/subscribe`, { form: { email: cReader, website: '', _t: String(Date.now() - 8000), utm: JSON.stringify({ utm_source: 'bluesky', utm_medium: 'social', utm_campaign: `spring-${rnd}` }) } });
    await fetch(`${BASE}/s/${mSlug}/?utm_source=bluesky&utm_medium=social&utm_campaign=spring-${rnd}`, { headers: { 'user-agent': UA } });
    cookies = saved;
    const cSub = sql(`SELECT id, utm_campaign FROM subscribers WHERE email = '${cReader}'`)[0];
    sql(`INSERT INTO orders (id, pub_id, kind, subscriber_id, email, amount_cents, currency, status, created_at, paid_at) VALUES ('ord${rnd}', '${mPub.id}', 'product', '${cSub?.id}', '${cReader}', 1999, 'usd', 'paid', ${Date.now()}, ${Date.now()})`);
    await api(mKey, 'POST', `/posts/${dpId}/send`, {});
    for (let i = 0; i < 6; i++) { await cron(); await sleep(1200); if (sql(`SELECT COUNT(*) AS n FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = '${dpId}' AND d.status = 'sent'`)[0].n >= 1) break; }
    r = await req(`/app/campaigns/${camp.id}`); const ch = await r.text();
    ok(r.status === 200 && cSub?.utm_campaign === `spring-${rnd}` && /data-campaign-signups[^>]*>1</.test(ch) && /data-campaign-revenue[^>]*>\$19\.99</.test(ch), 'campaign report: attributed signup + revenue', (ch.match(/data-campaign-[a-z]+[^>]*>[^<]*</g) || []).join(' '));
    ok(/data-campaign-delivered[^>]*>[1-9]/.test(ch) && ch.includes('data-campaign-opens'), 'campaign report: combined sends, opens, clicks', (ch.match(/data-campaign-[a-z]+[^>]*>[^<]*</g) || []).join(' '));
    r = await req(`/app/campaigns/${camp.id}/report.csv`); const csvR = await r.text();
    ok(csvR.includes(`utm_campaign,spring-${rnd}`) && csvR.includes('revenue,19.99'), 'campaign report CSV');

    // ── ad audiences ──
    const sha = (s) => nodeCrypto.createHash('sha256').update(s).digest('hex');
    r = await req('/app/ad-audiences'); const aud = await r.text();
    ok(r.status === 200 && aud.includes('data-retargeting-note') && aud.includes('Customer Match'), 'ad audiences page explains it replaces retargeting ads');
    r = await req('/app/ad-audiences/download?segment=all&platform=google'); const g = await r.text();
    const gl = g.trim().split('\n');
    ok(gl[0] === 'Email' && gl.includes(sha(`campreader${rnd}@gmail.com`)) && !g.includes('@'), 'Google Customer Match CSV: Email header, SHA-256 of normalized email (gmail dots removed)', gl.slice(0, 3).join('|'));
    r = await req('/app/ad-audiences/download?segment=all&platform=meta'); const mcsv = await r.text();
    ok(mcsv.split('\n')[0] === 'email' && mcsv.includes(sha(cReader)), 'Meta Custom Audiences CSV: email header, SHA-256 of trimmed lowercase email');
    r = await req('/app/ad-audiences/feeds', { form: { segment: 'all', platform: 'meta', name: 'Everyone → Meta' } });
    const fh = await r.text();
    const feedUrl = fh.match(/https?:\/\/[^"<\s]+\/audiences\/aud_[A-Za-z0-9_-]+\.csv/)?.[0];
    ok(!!feedUrl && !sql(`SELECT COUNT(*) AS n FROM ad_audience_feeds WHERE token_hash LIKE 'aud_%'`)[0].n, 'secret re-export URL shown once (only its hash stored)');
    const pull = await fetch(feedUrl.replace(/^https?:\/\/[^/]+/, BASE));
    ok(pull.status === 200 && (await pull.text()).includes(sha(cReader)), 'ads tool can pull the list with the secret URL (no login)');
    const feedId = sql(`SELECT id FROM ad_audience_feeds WHERE pub_id = '${mPub.id}'`)[0].id;
    await req(`/app/ad-audiences/feeds/${feedId}/revoke`, { form: {} });
    ok((await fetch(feedUrl.replace(/^https?:\/\/[^/]+/, BASE))).status === 404, 'revoked URL stops working');
    r = await req('/app/audience/segments'); ok(r.status === 200, 'segments page renders (with Ad audience button when segments exist)');

    // ── PWA ──
    const man = await fetch(`${BASE}/manifest.webmanifest`);
    const mj = await man.json().catch(() => ({}));
    ok(man.status === 200 && mj.display === 'standalone' && mj.icons?.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'), 'web app manifest with 192/512 + maskable icons');
    for (const p of ['/static/icons/icon-192.png', '/static/icons/icon-512.png', '/static/icons/maskable-512.png', '/static/icons/apple-touch-icon.png']) { const ir = await fetch(BASE + p); if (ir.status !== 200 || !(ir.headers.get('content-type') || '').includes('png')) ok(false, 'icon ' + p, ir.status); }
    const sw = await fetch(`${BASE}/sw.js`); const swt = await sw.text();
    ok(sw.status === 200 && swt.includes("startsWith('/app')") && !/cache\.put\(req, res\.clone\(\)\)[^]*mode === 'navigate'/.test(swt), 'service worker served (static cache + offline page only)');
    ok((await fetch(`${BASE}/offline`)).status === 200, 'offline page served');
    r = await req('/app'); const home = await r.text();
    ok(home.includes('rel="manifest"') && home.includes("serviceWorker.register('/sw.js'"), 'dashboard links the manifest and registers the service worker');

    // ── Sign in with Google (mock OIDC provider) ──
    cookies = {};
    r = await req('/login'); const lh = await r.text();
    if (lh.includes('data-google-signin')) {
      r = await req('/auth/google');
      let loc = r.headers.get('location') || '';
      ok(r.status === 302 && loc.startsWith(`${MOCK}/google/authorize`) && loc.includes('code_challenge_method=S256') && loc.includes('nonce='), 'Google: redirects to the provider with PKCE + nonce');
      let cb = await fetch(loc, { redirect: 'manual' });
      r = await req(new URL(cb.headers.get('location')).pathname + new URL(cb.headers.get('location')).search);
      ok([302, 303].includes(r.status) && (r.headers.get('location') || '').includes('/app/onboarding') && !!cookies.oh_sid, 'Google: new user signed up and sent to onboarding', r.status + ' ' + r.headers.get('location'));
      const gu = sql(`SELECT u.email_verified, (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id AND m.role = 'owner') AS ws FROM users u WHERE email = '${idp.google.email}'`)[0];
      ok(gu?.email_verified === 1 && gu.ws === 1 && sql(`SELECT COUNT(*) AS n FROM user_identities WHERE provider = 'google' AND subject = 'g-1-${rnd}'`)[0].n === 1, 'Google: identity linked, workspace created');
      // existing account with the same verified email links instead of duplicating
      cookies = {};
      idp.google = { sub: 'g-2-' + rnd, email: mEmail, email_verified: true, name: 'Mkt Owner' };
      sql(`UPDATE users SET email_verified = 1 WHERE email = '${mEmail}'`);
      loc = (await req('/auth/google')).headers.get('location');
      cb = await fetch(loc, { redirect: 'manual' });
      r = await req(new URL(cb.headers.get('location')).pathname + new URL(cb.headers.get('location')).search);
      const mUserId = sql(`SELECT id FROM users WHERE email = '${mEmail}'`)[0].id;
      ok([302, 303].includes(r.status) && sql(`SELECT user_id FROM user_identities WHERE provider = 'google' AND subject = 'g-2-${rnd}'`)[0]?.user_id === mUserId && sql(`SELECT COUNT(*) AS n FROM users WHERE email = '${mEmail}'`)[0].n === 1, 'Google: existing account linked by verified email');
      // replayed state is refused
      r = await req(new URL(cb.headers.get('location')).pathname + new URL(cb.headers.get('location')).search);
      ok(r.status === 400, 'Google: callback state is single-use');
    } else ok(true, 'Google sign-in hidden when GOOGLE_CLIENT_ID/SECRET are not configured');

    // ── Enterprise SSO (mock OIDC provider) ──
    cookies = mkt;
    const corpDomain = `corp-${rnd}.example`;
    r = await req('/app/settings/workspace/sso', { form: { issuer: `${MOCK}/corp`, client_id: 'corp-client', client_secret: 'corp-secret', domain: 'gmail.com', default_role: 'member', enabled: 'on' } });
    ok(!sql(`SELECT COUNT(*) AS n FROM workspace_sso WHERE workspace_id = '${mPub.workspace_id}'`)[0].n, 'SSO: public email domains cannot be claimed');
    r = await req('/app/settings/workspace/sso', { form: { issuer: `${MOCK}/corp`, client_id: 'corp-client', client_secret: 'corp-secret', domain: corpDomain, default_role: 'member', enabled: 'on', enforce: 'on' } });
    let wss = sql(`SELECT * FROM workspace_sso WHERE workspace_id = '${mPub.workspace_id}'`)[0];
    ok(wss && wss.client_secret.startsWith('v1.') && !wss.client_secret.includes('corp-secret') && wss.enforce === 0, 'SSO saved (client secret encrypted; cannot enforce before a successful test)');
    r = await req('/app/settings/workspace'); ok((await r.text()).includes(`_lnkbase-sso.${corpDomain}`), 'workspace settings show the SSO card with the DNS TXT record');
    r = await req(`/sso/test/${mPub.workspace_id}`);
    let cb = await fetch(r.headers.get('location'), { redirect: 'manual' });
    r = await req(new URL(cb.headers.get('location')).pathname + new URL(cb.headers.get('location')).search);
    ok(!!sql(`SELECT tested_at FROM workspace_sso WHERE workspace_id = '${mPub.workspace_id}'`)[0].tested_at, 'SSO: admin test sign-in succeeds (signature, nonce, PKCE verified)');
    sql(`UPDATE workspace_sso SET domain_verified_at = ${Date.now()} WHERE workspace_id = '${mPub.workspace_id}'`); // DNS TXT can't be published for a test domain
    await req('/app/settings/workspace/sso', { form: { issuer: `${MOCK}/corp`, client_id: 'corp-client', client_secret: '', domain: corpDomain, default_role: 'member', enabled: 'on', enforce: 'on' } });
    wss = sql(`SELECT enabled, enforce FROM workspace_sso WHERE workspace_id = '${mPub.workspace_id}'`)[0];
    ok(wss.enabled === 1 && wss.enforce === 1, 'SSO enabled and enforced after the test');
    // an existing password account at the domain is now SSO-only
    cookies = {};
    await req('/signup', { form: { name: 'Pre Existing', email: `bob@${corpDomain}`, password: 'correct-horse-9' } });
    ok(!sql(`SELECT COUNT(*) AS n FROM users WHERE email = 'bob@${corpDomain}'`)[0].n, 'SSO enforced: password signup at the domain refused');
    cookies = {};
    r = await req('/login', { form: { email: `alice@${corpDomain}`, password: 'whatever-123', mode: 'password' } });
    ok((r.headers.get('location') || '').startsWith('/sso?email='), 'SSO enforced: password login redirected to SSO');
    r = await req('/sso', { form: { email: `alice@${corpDomain}` } });
    const corpLoc = r.headers.get('location') || '';
    ok(corpLoc.startsWith(`${MOCK}/corp/authorize`) && corpLoc.includes('login_hint='), 'SSO: work email routes to the workspace identity provider');
    cb = await fetch(corpLoc, { redirect: 'manual' });
    r = await req(new URL(cb.headers.get('location')).pathname + new URL(cb.headers.get('location')).search);
    const alice = sql(`SELECT u.id, m.role FROM users u JOIN memberships m ON m.user_id = u.id AND m.workspace_id = '${mPub.workspace_id}' WHERE u.email = 'alice@${corpDomain}'`)[0];
    ok([302, 303].includes(r.status) && alice?.role === 'member' && !!cookies.oh_sid, 'SSO: first sign-in provisions the person into the workspace');
    r = await req('/app'); ok(r.status === 200 && (await r.text()).includes(`Mkt ${rnd}`), 'SSO user lands in the workspace dashboard');
    cookies = {};
    idp.corp = { sub: 'c-9', email: `mallory@evil-${rnd}.example`, email_verified: true, name: 'Mallory' };
    r = await req('/sso', { form: { email: `alice@${corpDomain}` } });
    cb = await fetch(r.headers.get('location'), { redirect: 'manual' });
    r = await req(new URL(cb.headers.get('location')).pathname + new URL(cb.headers.get('location')).search);
    ok(r.status === 403 && !sql(`SELECT COUNT(*) AS n FROM users WHERE email = 'mallory@evil-${rnd}.example'`)[0].n, 'SSO: identities outside the allowed domain are refused');
    cookies = {};
    r = await req('/login', { form: { email: `alice@${corpDomain}`, mode: 'magic' } });
    ok((r.headers.get('location') || '').startsWith('/sso?email='), 'SSO enforced: magic links refused too');
  } finally {
    server.close();
  }
}

console.log('12. Errors');
const errs = sql(`SELECT source, message FROM error_log ORDER BY created_at DESC LIMIT 10`);
ok(errs.length === 0, 'no server errors logged', JSON.stringify(errs).slice(0, 800));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
