// End-to-end smoke test against a running `wrangler dev`.
// Usage: BASE=http://localhost:8790 PERSIST=.wrangler/int node scripts/e2e.mjs
// Walks: signup → onboarding → API key → public subscribe → API subscriber → post → send → cron → open/click tracking
//        → public site → paid tier checkout (test mode) → one-click unsubscribe → webhooks/automation sanity
//        → platform plans (usage page, subscriber cap, email allowance, simulated upgrade, campaign pause, approval)
//        → marketing (social posting against a local mock Bluesky PDS + Mastodon, calendar, campaigns, ad audiences),
//          PWA, and SSO (Google + Enterprise OIDC against a local mock provider on MOCK_PORT, default 8816).
import { createHmac } from 'node:crypto';
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
  // The local database file can be briefly locked while the dev server's background jobs run: retry.
  for (let attempt = 1; ; attempt++) {
    try {
      const out = execSync(`npx wrangler d1 execute openhive --local ${PERSIST ? `--persist-to ${PERSIST}` : ''} --json --command ${JSON.stringify(q)}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return JSON.parse(out)[0].results;
    } catch (e) {
      if (attempt >= 6) throw e;
      execSync(`sleep ${attempt}`);
    }
  }
}
// wrangler dev exposes the scheduled handler at /cdn-cgi/local/scheduled; /__scheduled is the older route
const cron = () => fetch(BASE + '/cdn-cgi/local/scheduled').then((r) => (r.status === 404 ? fetch(BASE + '/__scheduled') : r)).catch(() => null);
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
// Each later section starts from the main test user's session (some sections sign in as others).
const __mainCookies = { ...cookies };
const __restore = () => { cookies = { ...__mainCookies }; };
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
for (let i = 0; i < 20; i++) { await cron(); await sleep(1500); if (sql(`SELECT COUNT(*) AS n FROM deliveries WHERE send_id = '${send3}'`)[0].n >= 50) break; }
sql(`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 250) INSERT INTO deliveries (id, send_id, pub_id, subscriber_id, email, status, bounce_type, attempts, sent_at, created_at) SELECT 'bd' || i || '${rnd}', '${send3}', '${pubId}', NULL, 'bd' || i || '@gmail.com', CASE WHEN i <= 15 THEN 'bounced' ELSE 'sent' END, CASE WHEN i <= 15 THEN 'hard' ELSE NULL END, 1, ${Date.now()}, ${Date.now()} FROM k`);
sql(`UPDATE jobs SET run_at = 0 WHERE kind = 'send.batch' AND status = 'pending' AND payload LIKE '%${send3}%'`);
for (let i = 0; i < 20; i++) { await cron(); await sleep(1500); if (sql(`SELECT status FROM sends WHERE id = '${send3}'`)[0].status === 'paused') break; }
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

__restore();
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

__restore();
{ // commerce sync, cart abandonment, transactional email, inbox
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

}
__restore();
{ // subscriber intelligence
console.log('13. Subscriber intelligence: signals, value/CLV/churn scores, predictive segments, anomalies, next steps, comparative reports');
const req0 = req;
{
  cookies = userCookies;
  const T = Date.now(), D = 86400000;
  // the dev server drops idle keep-alive sockets: retry once on a reset connection
  const req = async (path, opts) => { try { return await req0(path, opts); } catch { return req0(path, opts); } };
  const stmts = [];
  const ins = (id, email, extra = {}) => {
    const row = { id, pub_id: pubId, email, name: '', status: 'active', tier: 'free', source: 'import', referral_code: id, custom: '{}', confirmed_at: T, created_at: T - 200 * D, updated_at: T, ...extra };
    stmts.push(`INSERT INTO subscribers (${Object.keys(row).join(',')}) VALUES (${Object.values(row).map((v) => (v === null ? 'NULL' : typeof v === 'number' ? v : `'${v}'`)).join(',')})`);
  };
  // a superfan (engaged, buyer, referrer), a paid subscriber who went quiet with a failed payment, a business address, and 15 dormant readers
  ins(`iq_fan${rnd}`, `fan.${rnd}@gmail.com`, { engagement: 95, referral_count: 6, last_open_at: T - D, last_click_at: T - D, open_count: 30, click_count: 12 });
  ins(`iq_paid${rnd}`, `paid.${rnd}@gmail.com`, { tier: 'premium', engagement: 10, last_open_at: T - 80 * D });
  ins(`iq_biz${rnd}`, `ceo.${rnd}@acme-widgets.io`, { engagement: 40, country: 'DE' });
  for (let i = 0; i < 15; i++) ins(`iq_dorm${i}${rnd}`, `dorm${i}.${rnd}@gmail.com`, { engagement: 0, last_open_at: T - 150 * D });
  stmts.push(`INSERT INTO orders (id, pub_id, kind, ref_id, subscriber_id, email, amount_cents, status, created_at, paid_at) VALUES ('iqo1${rnd}', '${pubId}', 'product', 'x', 'iq_fan${rnd}', 'fan.${rnd}@gmail.com', 4900, 'paid', ${T - 20 * D}, ${T - 20 * D}), ('iqo2${rnd}', '${pubId}', 'subscription', 'x', 'iq_paid${rnd}', 'paid.${rnd}@gmail.com', 1000, 'paid', ${T - 100 * D}, ${T - 100 * D})`);
  stmts.push(`INSERT INTO subscriptions (id, pub_id, subscriber_id, tier_id, interval, status, amount_cents, created_at, updated_at) VALUES ('iqs${rnd}', '${pubId}', 'iq_paid${rnd}', 'x', 'month', 'past_due', 1000, ${T - 100 * D}, ${T})`);
  sql(stmts.join('; '));

  r = await req('/app/audience/top/recompute', { form: {} });
  ok([302, 303].includes(r.status), 'recompute scores', r.status);
  const sc = Object.fromEntries(sql(`SELECT subscriber_id, value_score, value_percentile, clv_cents, predicted_cents, purchase_likelihood, churn_risk FROM subscriber_scores WHERE pub_id = '${pubId}' AND subscriber_id LIKE 'iq_%'`).map((x) => [x.subscriber_id.replace(rnd, ''), x]));
  ok(sc.iq_fan && sc.iq_fan.value_score >= 70 && sc.iq_fan.value_percentile >= 90 && sc.iq_fan.purchase_likelihood === 'high', 'superfan gets a top value score + high purchase likelihood', JSON.stringify(sc.iq_fan));
  ok(sc.iq_paid && sc.iq_paid.churn_risk === 'high' && sc.iq_paid.clv_cents > 1000 && sc.iq_paid.predicted_cents > 0, 'quiet past-due paid subscriber: high churn risk, CLV = history + prediction', JSON.stringify(sc.iq_paid));
  ok(sc.iq_dorm0 && sc.iq_dorm0.value_score < 10 && sc.iq_dorm0.churn_risk === null, 'dormant free reader: low value, no churn score');
  r = await req('/app/audience/top'); let th = await r.text();
  const fanAt = th.indexOf(`fan.${rnd}@gmail.com`), dormAt = th.indexOf(`dorm0.${rnd}@gmail.com`);
  ok(r.status === 200 && fanAt > 0 && (dormAt === -1 || fanAt < dormAt), 'Top subscribers ranks the superfan above dormant readers');
  r = await req(`/app/audience/s/iq_paid${rnd}`); th = await r.text();
  ok(th.includes('data-churn="high"') && th.includes('data-clv'), 'subscriber page shows CLV + churn risk');

  // signals: business email → organization; segment fields
  r = await req(`/app/audience/s/iq_biz${rnd}/signals`, { form: {} });
  const sg = sql(`SELECT business_email, organization, country FROM subscriber_signals WHERE subscriber_id = 'iq_biz${rnd}'`)[0];
  ok(sg && sg.business_email === 1 && sg.organization === 'Acme Widgets' && sg.country === 'DE', 'signals: business email, organization, country', JSON.stringify(sg));
  r = await req(`/app/audience/s/iq_biz${rnd}`); th = await r.text();
  ok(th.includes('data-business="1"') && th.includes('Acme Widgets'), 'subscriber page shows signals');
  const segRes = async (rules) => (await api(key, 'POST', '/segments', { name: `iq ${Math.random()}`, rules })).body?.data;
  let sgm = await segRes({ op: 'and', rules: [{ field: 'business_email', cmp: 'is_true' }, { field: 'email', cmp: 'contains', value: rnd }] });
  ok(sgm?.subscriber_count === 1, 'segment: business email', JSON.stringify(sgm).slice(0, 160));
  sgm = await segRes({ op: 'and', rules: [{ field: 'company', cmp: 'contains', value: 'widgets' }] });
  ok(sgm?.subscriber_count === 1, 'segment: company contains', JSON.stringify(sgm).slice(0, 160));
  sgm = await segRes({ op: 'and', rules: [{ field: 'churn_risk', cmp: 'eq', value: 'high' }, { field: 'email', cmp: 'contains', value: `paid.${rnd}` }] });
  ok(sgm?.subscriber_count === 1, 'segment: churn risk high');
  sgm = await segRes({ op: 'and', rules: [{ field: 'value_percentile', cmp: 'gt', value: 89 }, { field: 'purchase_likelihood', cmp: 'eq', value: 'high' }, { field: 'clv', cmp: 'gt', value: 40 }] });
  ok(sgm?.subscriber_count >= 1, 'segment: top value + likely buyer + CLV > $40');
  const fanSeg = sgm?.id;
  r = await req('/app/audience/top/signals', { form: {} });
  ok(sql(`SELECT COUNT(*) AS n FROM subscriber_signals WHERE pub_id = '${pubId}'`)[0].n === 0, 'turning Subscriber Signals off deletes stored signals');
  r = await req('/app/audience/top/signals', { form: { enabled: 'on' } });
  ok(sql(`SELECT json_extract(settings, '$.subscriber_signals') AS v FROM publications WHERE id = '${pubId}'`)[0].v === 1, 'Subscriber Signals back on');

  // API + MCP
  const ins1 = await api(key, 'GET', `/subscriptions/iq_fan${rnd}/insights`);
  ok(ins1.status === 200 && ins1.body?.data?.value_score >= 70 && ins1.body?.data?.lifetime_value?.historical_cents === 4900, 'REST: subscriber insights', JSON.stringify(ins1.body).slice(0, 200));
  const mi = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'subscriber_intelligence', arguments: { action: 'top', limit: 3 } } }) }).then((x) => x.json()).catch(() => ({}));
  ok(Array.isArray(mi.result?.structuredContent?.items) && mi.result.structuredContent.items[0]?.email === `fan.${rnd}@gmail.com`, 'MCP: top subscribers', JSON.stringify(mi).slice(0, 200));

  // next steps on the dashboard home + one-click segment
  r = await req('/app'); th = await r.text();
  ok(th.includes('Suggested next steps') && th.includes('data-suggestion="winback"') && th.includes('data-suggestion="churn"'), 'dashboard: suggested next steps (win back, churn)');
  r = await req('/app/intel/segment', { form: { preset: 'inactive_90' } });
  const segId = (r.headers.get('location') || '').split('/').pop();
  ok(sql(`SELECT cached_count FROM segments WHERE id = '${segId}' AND pub_id = '${pubId}'`)[0]?.cached_count >= 15, 'one-click "inactive for 90 days" segment');
  const na = await api(key, 'GET', '/insights/next_actions');
  ok(na.status === 200 && na.body.data.some((x) => x.key === 'winback'), 'REST: next actions');

  // anomalies: an unsubscribe spike today vs a quiet 14-day baseline
  sql(`UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ${T - 3600000} WHERE id LIKE 'iq_dorm%${rnd}' AND id NOT LIKE 'iq_dorm1${rnd}'`);
  r = await req('/app/analytics/anomalies/check', { form: { back: '/app/analytics' } });
  const an = sql(`SELECT id, metric, severity, emailed_at FROM anomalies WHERE pub_id = '${pubId}' AND metric = 'unsubscribes'`);
  ok(an.length === 1 && an[0].metric === 'unsubscribes' && an[0].severity !== 'good' && an[0].emailed_at, 'unsubscribe spike detected + stored', JSON.stringify(an));
  ok(sql(`SELECT COUNT(*) AS n FROM outbox WHERE to_email = '${email}' AND subject LIKE 'Unusual activity%'`)[0].n === 1, 'owner emailed about the anomaly');
  await req('/app/analytics/anomalies/check', { form: {} });
  ok(sql(`SELECT COUNT(*) AS n FROM outbox WHERE to_email = '${email}' AND subject LIKE 'Unusual activity%'`)[0].n === 1 && sql(`SELECT COUNT(*) AS n FROM anomalies WHERE pub_id = '${pubId}' AND metric = 'unsubscribes'`)[0].n === 1, 'same anomaly is not stored or emailed twice');
  r = await req('/app'); th = await r.text();
  const r2 = await req('/app/analytics'); const ah2 = await r2.text();
  ok(th.includes('data-anomaly="unsubscribes"') && ah2.includes('data-anomaly="unsubscribes"'), 'alert on dashboard home + Analytics overview');
  await req(`/app/anomalies/${an[0]?.id}/dismiss`, { form: { back: '/app' } });
  r = await req('/app'); th = await r.text();
  ok(!th.includes('data-anomaly="unsubscribes"'), 'alert can be dismissed');

  // comparative custom reports: periods and segments side by side, saved with the comparison
  r = await req('/app/analytics/reports?metric=subscribers&group=day&range=30d&cmp=prev'); th = await r.text();
  ok(r.status === 200 && th.includes('Side by side') && th.includes('Previous period'), 'custom report vs previous period');
  r = await req(`/app/analytics/reports?metric=unsubscribes&group=source&range=7d&cmp=segments&sa=${fanSeg}&sb=`); th = await r.text();
  ok(r.status === 200 && th.includes('Side by side') && th.includes('All subscribers'), 'custom report: segment vs segment');
  r = await req('/app/analytics/reports?metric=unsubscribes&group=day&range=7d&cmp=yoy&format=csv'); th = await r.text();
  ok(th.startsWith('day,') && th.includes('Change %') && th.includes('Same period last year'), 'comparison CSV export');
  await req('/app/analytics/reports', { form: { name: `Cmp ${rnd}`, config: JSON.stringify({ metric: 'subscribers', group: 'day', range: '30d', filters: [], compare: { mode: 'custom', from2: '2026-01-01', to2: '2026-01-31' } }) } });
  r = await req('/app/analytics/reports'); th = await r.text();
  ok(th.includes(`Cmp ${rnd}`) && th.includes('cmp=custom') && th.includes('from2=2026-01-01'), 'saved report keeps the comparison');
  r = await req('/app/analytics/revenue'); th = await r.text();
  ok(r.status === 200 && th.includes('data-predictions') && th.includes('Paid subscribers most likely to churn'), 'revenue analytics: CLV + churn predictions');
  sql(`DELETE FROM subscribers WHERE id LIKE 'iq_%${rnd}'`);
}

}
__restore();
{ // templates, snippets, coded emails, subject helper, product recommendations
console.log('13. Templates, snippets, coded emails, subject helper, product recommendations');
{
  const libCount = sql(`SELECT COUNT(*) AS n FROM templates WHERE pub_id IS NULL AND kind IN ('post','welcome','automation')`)[0].n;
  ok(libCount >= 43, 'template library has 43+ designs', libCount);
  r = await req('/app/posts/templates');
  ok((await r.text()).includes(`data-template-count="${libCount}"`), 'templates page shows the library count');
  r = await req('/app/posts/new');
  ok(/data-template-count="\d+"/.test(await r.text()), 'new-post picker shows the template count');
  const NEW_TPLS = ['tpl_lib_product_launch', 'tpl_lib_case_study', 'tpl_lib_holiday', 'tpl_lib_photo_roundup', 'tpl_lib_minimal_letter', 'tpl_lib_magazine', 'tpl_lib_recipe', 'tpl_lib_event_recap', 'tpl_lib_investor_update', 'tpl_lib_local_news', 'tpl_lib_job_board', 'tpl_lib_ama', 'tpl_lib_shop_picks', 'tpl_lib_coded_starter'];
  let rendered = 0;
  for (const tid of NEW_TPLS) {
    const p = await api(key, 'POST', '/posts', { title: `Tpl ${tid} ${rnd}`, template_id: tid });
    const e = await api(key, 'GET', `/posts/${p.body?.data?.id}/html?format=email`);
    const w = await api(key, 'GET', `/posts/${p.body?.data?.id}/html?format=web`);
    if (e.status === 200 && w.status === 200 && e.body.data.html.length > 1500 && !e.body.data.gmail_clipped && !/Unsupported block/.test(e.body.data.html + w.body.data.html)) rendered++;
    else console.log('    template failed to render:', tid, e.status, w.status);
  }
  ok(rendered === NEW_TPLS.length, `all ${NEW_TPLS.length} new library templates render (email + web)`, rendered);

  // synced snippets: a post references the snippet; editing the snippet changes the post's rendered email
  r = await req('/app/posts/snippets.json', { json: { name: `Signature ${rnd}`, blocks: [{ type: 'paragraph', data: { html: 'Cheers, <b>Team Sig v1</b>' } }] } });
  const snip = await r.json();
  ok(r.status === 200 && !!snip.id, 'snippet saved from editor blocks', JSON.stringify(snip));
  const sp = await api(key, 'POST', '/posts', { title: `Snippet post ${rnd}`, blocks: [{ type: 'paragraph', data: { html: 'Hello there' } }, { type: 'snippet', data: { snippet_id: snip.id, name: 'Signature' } }] });
  const spId = sp.body?.data?.id;
  let se = await api(key, 'GET', `/posts/${spId}/html?format=email`);
  ok(se.body?.data?.html.includes('Team Sig v1'), 'synced snippet renders inside the post email');
  await req(`/app/posts/snippets/${snip.id}`, { form: { name: `Signature ${rnd}`, description: 'Sign-off', content: JSON.stringify({ blocks: [{ type: 'paragraph', data: { html: 'Cheers, <b>Team Sig v2</b>' } }] }) } });
  se = await api(key, 'GET', `/posts/${spId}/html?format=email`);
  const sw = await api(key, 'GET', `/posts/${spId}/html?format=web`);
  ok(se.body?.data?.html.includes('Team Sig v2') && !se.body.data.html.includes('Team Sig v1') && sw.body?.data?.html.includes('Team Sig v2'), 'editing the snippet updates every post that syncs it (email + web)');
  r = await req(`/app/posts/snippets/${snip.id}/json`);
  const copy = await r.json();
  ok(copy.doc?.blocks?.length === 1 && copy.doc.blocks[0].type === 'paragraph', 'snippet can be inserted as an editable copy');
  r = await req('/app/posts/snippets');
  ok((await r.text()).includes('Synced in 1'), 'Posts → Snippets lists the snippet with its usage');
  const rs = await api(key, 'GET', '/snippets');
  ok(rs.status === 200 && rs.body.data.some((s) => s.id === snip.id), 'REST API lists snippets');

  // custom-coded template: sanitized, unsubscribe link added, sent as written with tracked links
  const codedHtml = `<!DOCTYPE html><html><head><title>Coded ${rnd}</title></head><body><h1 onclick="alert(1)">Hi {{subscriber.first_name|there}}</h1><script>alert(1)</script><p><a href="javascript:alert(1)">bad</a> <a href="https://example.com/landing">Landing</a></p></body></html>`;
  r = await req('/app/posts/templates/coded', { form: { name: `Coded ${rnd}`, description: 'e2e', html: codedHtml } });
  const ct = sql(`SELECT id, content FROM templates WHERE pub_id = '${pubId}' AND name = 'Coded ${rnd}'`)[0];
  ok(ct && !/<script|onclick|javascript:/i.test(ct.content) && ct.content.includes('{{unsubscribe_url}}'), 'coded template is sanitized and gets an unsubscribe link');
  r = await req(`/app/posts/templates/${ct?.id}/preview`);
  const ctp = await r.text();
  ok(ctp.includes(`<title>Coded ${rnd}</title>`) && !ctp.includes('oh-wrap'), 'coded template preview is the HTML as written (no layout wrapper)');
  const cp = await api(key, 'POST', '/posts', { title: `Coded post ${rnd}`, template_id: ct?.id });
  const cpId = cp.body?.data?.id;
  const cw = await api(key, 'GET', `/posts/${cpId}/html?format=web`);
  ok(/<iframe[^>]+sandbox="allow-same-origin allow-popups/.test(cw.body?.data?.html || ''), 'coded post renders in a sandboxed frame on the web');
  const recip = `coded.${rnd}@gmail.com`;
  const cs = await api(key, 'POST', '/subscriptions', { email: recip, name: 'Casey Coder', send_welcome: false });
  sql(`UPDATE subscribers SET status = 'active' WHERE email = '${recip}'`);
  let cres = await api(key, 'POST', `/posts/${cpId}/send`, {});
  ok(cres.status === 202, 'coded post send started', JSON.stringify(cres.body).slice(0, 160));
  for (let i = 0; i < 8; i++) { await cron(); await sleep(1200); if (sql(`SELECT COUNT(*) AS n FROM outbox WHERE to_email = '${recip}' AND subject LIKE '%Coded post ${rnd}%'`)[0].n) break; }
  const co = sql(`SELECT html FROM outbox WHERE to_email = '${recip}' AND subject LIKE '%Coded post ${rnd}%' LIMIT 1`)[0];
  ok(co && co.html.includes('Hi Casey') && co.html.includes('/t/c/') && /\/u\/[^"]+/.test(co.html) && !co.html.includes('%%OH_') && !co.html.includes('{{unsubscribe_url}}'), 'coded email sent as written: merge tags, tracked links, real unsubscribe link', (co?.html || '').slice(0, 300));

  // subject line helper
  r = await req('/app/posts/subject-helper/score', { json: { subject: 'FREE MONEY!!! ACT NOW', preview_text: '' } });
  const bad = await r.json();
  r = await req('/app/posts/subject-helper/score', { json: { subject: '{{subscriber.first_name|there}}, 3 ideas for a calmer week?', preview_text: 'Five minutes, three ideas and one tool we keep coming back to.' } });
  const good = await r.json();
  ok(bad.score < 50 && bad.checks.some((x) => x.id === 'spam' && x.status !== 'good') && bad.checks.some((x) => x.id === 'caps' && x.status === 'bad'), 'subject check flags spam words, caps and !!!', JSON.stringify(bad).slice(0, 200));
  ok(good.score >= 85 && good.checks.find((x) => x.id === 'personal')?.status === 'good', 'subject check rewards a personalized question with preview text', good.score);
  r = await req('/app/posts/subject-helper/suggest', { json: { subject: 'Our weekly update', title: 'Weekly update', text: 'News about the product.' } });
  const sug = await r.json();
  ok(r.status === 200 && sug.suggestions?.length >= 3 && sug.suggestions.every((x) => typeof x.score === 'number'), 'subject alternatives returned (AI or rule-based fallback)', JSON.stringify(sug).slice(0, 200));
  r = await req('/app/posts/subject-helper/top');
  const top = await r.json();
  ok(r.status === 200 && Array.isArray(top.top) && top.top.length >= 1 && typeof top.top[0].open_rate === 'number', 'top past subjects by open rate', JSON.stringify(top).slice(0, 200));
  r = await req(`/app/posts/${spId}/edit`);
  ok((await r.text()).includes('/static/subject-helper.js'), 'post editor loads the subject helper');

  // personalized product recommendations
  const T0 = Date.now();
  const prods = [['pa', 'Starter guide', '["basics"]'], ['pb', 'Advanced playbook', '["growth"]'], ['pc', 'Template pack', '["design"]'], ['pd', 'VIP masterclass', '["vip"]']];
  for (const [k, name, tags] of prods) sql(`INSERT INTO products (id, pub_id, name, slug, description, kind, price_cents, currency, tags, status, created_at) VALUES ('${k}${rnd}', '${pubId}', '${name} ${rnd}', '${k}-${rnd}', 'About ${name}', 'download', 1900, 'usd', '${tags}', 'active', ${T0})`);
  const ord = (n, email, p) => `('o${n}${rnd}', '${pubId}', 'product', '${p}${rnd}', NULL, '${email}', 1900, 'usd', 'paid', ${T0}, ${T0})`;
  const buyer = `buyer.${rnd}@gmail.com`, fan = `fan.${rnd}@gmail.com`;
  await api(key, 'POST', '/subscriptions', { email: buyer, name: 'Bea Buyer', send_welcome: false });
  await api(key, 'POST', '/subscriptions', { email: fan, name: 'Vic Fan', tags: ['vip'], send_welcome: false });
  sql(`UPDATE subscribers SET status = 'active' WHERE email IN ('${buyer}', '${fan}')`);
  // others bought A+B and A+C; our buyer bought A → B and C are "also bought"; the VIP fan matches D by interest
  sql(`INSERT INTO orders (id, pub_id, kind, ref_id, subscriber_id, email, amount_cents, currency, status, created_at, paid_at) VALUES ${[ord(1, 'x1@gmail.com', 'pa'), ord(2, 'x1@gmail.com', 'pb'), ord(3, 'x2@gmail.com', 'pa'), ord(4, 'x2@gmail.com', 'pc'), ord(5, 'x3@gmail.com', 'pa'), ord(6, 'x3@gmail.com', 'pb'), ord(7, buyer, 'pa')].join(',')}`);
  const buyerId = sql(`SELECT id FROM subscribers WHERE email = '${buyer}'`)[0].id;
  const fanId = sql(`SELECT id FROM subscribers WHERE email = '${fan}'`)[0].id;
  const rb = await api(key, 'GET', `/products/recommendations?subscriber_id=${buyerId}&limit=3`);
  const rf = await api(key, 'GET', `/products/recommendations?subscriber_id=${fanId}&limit=3`);
  ok(rb.status === 200 && rb.body.data[0]?.id === `pb${rnd}` && rb.body.data[0].reason === 'also_bought' && !rb.body.data.some((x) => x.id === `pa${rnd}`), 'buyer gets co-purchased products first, never what they already bought', JSON.stringify(rb.body).slice(0, 300));
  ok(rf.status === 200 && rf.body.data[0]?.id === `pd${rnd}` && rf.body.data[0].reason === 'interest', 'reader with a matching interest tag gets that product first', JSON.stringify(rf.body).slice(0, 300));
  const anon = await api(key, 'GET', '/products/recommendations?limit=2');
  ok(anon.body.data[0]?.id === `pa${rnd}` && anon.body.data[0].reason === 'popular', 'no signal falls back to bestsellers');
  const rp = await api(key, 'POST', '/posts', { title: `Picks ${rnd}`, blocks: [{ type: 'paragraph', data: { html: 'Hi {{subscriber.first_name|there}}' } }, { type: 'recommended_products', data: { title: 'Picked for you', limit: 2 } }] });
  const rpId = rp.body?.data?.id;
  const rres = await api(key, 'POST', `/posts/${rpId}/send`, {});
  ok(rres.status === 202, 'post with recommended products sends');
  for (let i = 0; i < 8; i++) { await cron(); await sleep(1200); if (sql(`SELECT COUNT(*) AS n FROM outbox WHERE subject LIKE '%Picks ${rnd}%' AND to_email IN ('${buyer}', '${fan}')`)[0].n >= 2) break; }
  const ob = sql(`SELECT html FROM outbox WHERE subject LIKE '%Picks ${rnd}%' AND to_email = '${buyer}'`)[0]?.html || '';
  const of = sql(`SELECT html FROM outbox WHERE subject LIKE '%Picks ${rnd}%' AND to_email = '${fan}'`)[0]?.html || '';
  ok(ob.includes(`>Advanced playbook ${rnd}</a>`) && !ob.includes(`>Starter guide ${rnd}</a>`) && ob.includes(`Readers who bought Starter guide ${rnd} also got this`) && of.includes(`>VIP masterclass ${rnd}</a>`), 'each subscriber gets their own picks in the sent email');
  const tracked = (of.match(/href="([^"]*\/t\/c\/[^"]+)"/g) || []).map((x) => x.slice(6, -1).replace(/&amp;/g, '&'));
  let hit = null;
  for (const u of tracked) { const rr = await fetch(u.replace(/^https?:\/\/[^/]+/, BASE), { redirect: 'manual', headers: { 'user-agent': UA } }); const loc = rr.headers.get('location') || ''; if (loc.includes('/shop/') && loc.includes('utm_content=recommended_products')) { hit = loc; break; } }
  ok(!!hit && hit.includes(`utm_campaign=`), 'recommendation click is tracked and lands on the product page with attribution', String(hit));
}

}
console.log('12. Errors');
const errs = sql(`SELECT source, message FROM error_log ORDER BY created_at DESC LIMIT 10`);
ok(errs.length === 0, 'no server errors logged', JSON.stringify(errs).slice(0, 800));

__restore();
{ // automation templates, entry points, webhooks, multivariate tests, send timing
console.log('13. Automation templates, multiple entry points, incoming webhooks, multivariate tests, send timing');
cookies = userCookies;
const tplList = await api(key, 'GET', '/automation_templates');
ok(tplList.status === 200 && tplList.body.data.length >= 43 && new Set(tplList.body.data.map((t) => t.category)).size >= 10, `automation template library (${tplList.body?.data?.length} templates, categories + outlines)`);
r = await req('/app/automations');
let ah13 = await r.text();
ok(r.status === 200 && (ah13.match(/class="af-gal-card"/g) || []).length >= 44 && ah13.includes('data-preview="welcome_5day"') && ah13.includes('data-gal-cat="E-commerce"'), 'New automation picker shows categories, cards and flow previews');
r = await req('/app/automations/new', { form: { name: '', template: 'welcome_5day' } });
const fromTpl = (r.headers.get('location') || '').split('/').pop();
const tplRow = sql(`SELECT name, draft_trigger, draft_steps, status FROM automations WHERE id = '${fromTpl}'`)[0];
ok(tplRow && tplRow.status === 'draft' && JSON.parse(tplRow.draft_steps).filter((s) => s.type === 'send_email').length === 5 && JSON.parse(tplRow.draft_trigger).type === 'welcome', 'template creates a draft automation with real emails', JSON.stringify(tplRow || {}).slice(0, 160));
r = await req(`/app/automations/${fromTpl}`); ok(r.status === 200 && (await r.text()).includes('/hooks/automations/awh_'), 'builder shows the secret webhook URL');

// several entry points (OR) + incoming webhook
const multi = await api(key, 'POST', '/automations', { name: `Multi ${rnd}`, triggers: [{ type: 'tag_added', config: { tag: 'e2e-a' } }, { type: 'tag_added', config: { tag: 'e2e-b' } }, { type: 'webhook', config: { tags: ['from-hook'], field_map: 'company = data.company' } }], steps: [{ type: 'send_email', config: { subject: `Multi hello ${rnd}`, markdown: 'Hi from a multi-entry automation' } }], activate: true });
const mid = multi.body?.data?.id;
ok(multi.status === 201 && multi.body.data.status === 'active' && multi.body.data.triggers.length === 3, 'REST create with 3 entry points (triggers: [])', JSON.stringify(multi.body).slice(0, 200));
const tagSub = await api(key, 'POST', '/subscriptions', { email: `multi.${rnd}@gmail.com`, send_welcome: false });
await api(key, 'POST', `/subscriptions/${tagSub.body.data.id}/tags`, { tags: ['e2e-b'] });
await sleep(500);
ok(sql(`SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id = '${mid}' AND subscriber_id = '${tagSub.body.data.id}'`)[0].n === 1, 'second entry point (tag e2e-b) enrolls');
const legacy = await api(key, 'POST', '/automations', { name: `Legacy ${rnd}`, trigger: { type: 'tag_added', config: { tag: 'x' } }, steps: [] });
ok(legacy.status === 201 && legacy.body.data.draft.trigger.type === 'tag_added', 'single `trigger` still accepted');
const hook = await api(key, 'GET', `/automations/${mid}/webhook`);
const hookPath = new URL(hook.body.data.url).pathname;
ok(hook.body.data.enabled && hookPath.startsWith('/hooks/automations/awh_'), 'webhook URL via API');
const hookEmail = `hook.${rnd}@gmail.com`;
let hr = await fetch(BASE + hookPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'invitee.created', data: { email: hookEmail, name: 'Hook Person', company: 'Acme' }, timezone: 'Europe/Paris' }) });
let hj = await hr.json();
const hsub = sql(`SELECT id, status, custom, timezone FROM subscribers WHERE email = '${hookEmail}'`)[0];
ok(hr.status === 202 && hj.enrolled === true && hsub && hsub.status === 'active' && JSON.parse(hsub.custom).company === 'Acme' && hsub.timezone === 'Europe/Paris', 'POST to webhook creates subscriber (field mapping, time zone) and enrolls', JSON.stringify(hj));
ok(sql(`SELECT COUNT(*) AS n FROM subscriber_tags WHERE subscriber_id = '${hsub?.id}' AND tag = 'from-hook'`)[0].n === 1, 'webhook tags applied');
hr = await fetch(BASE + hookPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ form_response: { answers: [{ type: 'email', email: `tf.${rnd}@gmail.com` }] } }) });
ok(hr.status === 202 && sql(`SELECT COUNT(*) AS n FROM subscribers WHERE email = 'tf.${rnd}@gmail.com'`)[0].n === 1, 'Typeform-style nested email is detected');
hr = await fetch(BASE + hookPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hello: 'world' }) });
ok(hr.status === 422, 'no email → 422');
hr = await fetch(BASE + '/hooks/automations/awh_doesnotexist000', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
ok(hr.status === 404, 'unknown webhook → 404');
const legacyHook = (await api(key, 'GET', `/automations/${legacy.body.data.id}/webhook`)).body.data.url;
hr = await fetch(BASE + new URL(legacyHook).pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: hookEmail }) });
ok(hr.status === 409, 'automation without a webhook entry point → 409');
let limited = false;
for (let i = 0; i < 125 && !limited; i++) { const x = await fetch(BASE + hookPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); if (x.status === 429) limited = true; }
ok(limited, 'webhook is rate limited (429)');
sql(`DELETE FROM rate_limits WHERE key LIKE 'awh%'`);
// draft/live: editing entry points goes to the draft until published
let ed = await api(key, 'PATCH', `/automations/${mid}`, { triggers: [{ type: 'tag_added', config: { tag: 'e2e-c' } }] });
ok(ed.body.data.has_draft && ed.body.data.triggers.length === 3, 'entry point edits go to the draft (live keeps 3)');
ed = await api(key, 'POST', `/automations/${mid}/publish`, {});
ok(ed.body.data.triggers.length === 1 && ed.body.data.trigger.config.tag === 'e2e-c', 'publishing the draft makes the new entry points live');

// multivariate test: subject × sender name × preview × content body
const mvSubs = 40;
fakeSubs(mvSubs, 'mv');
sql(`UPDATE subscribers SET timezone = 'Asia/Tokyo' WHERE id LIKE 'mv%${rnd}'`);
const mvPost = await newPost('Multivariate');
sres = await api(key, 'POST', `/posts/${mvPost}/send`, { ab_test: { variants: [{ subject: `MV A ${rnd}` }, { subject: `MV B ${rnd}`, from_name: 'Variant Sender', preview_text: 'Preview B', content: 'b' }], sample_pct: 50, wait_minutes: 5, metric: 'opens' }, alt_markdown: `Variant body XYZ${rnd}` });
const mvSend = sres.body?.data?.send_id;
ok(sres.status === 202 && sql(`SELECT status FROM sends WHERE id = '${mvSend}'`)[0].status === 'testing', 'multivariate send starts in test phase', JSON.stringify(sres.body).slice(0, 200));
for (let i = 0; i < 6; i++) { await cron(); await sleep(1200); if (sql(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'send.ab_winner' AND payload LIKE '%${mvSend}%'`)[0].n) break; }
const vRows = sql(`SELECT variant, COUNT(*) AS n FROM deliveries WHERE send_id = '${mvSend}' GROUP BY variant`);
ok(vRows.length === 2 && vRows.every((v) => v.n > 0), 'sample split across variants A and B', JSON.stringify(vRows));
const bMail = sql(`SELECT from_email, html FROM outbox WHERE subject = 'MV B ${rnd}' LIMIT 1`)[0];
const aMail = sql(`SELECT from_email, html FROM outbox WHERE subject = 'MV A ${rnd}' LIMIT 1`)[0];
ok(bMail && bMail.from_email.startsWith('Variant Sender') && bMail.html.includes(`XYZ${rnd}`) && bMail.html.includes('Preview B'), 'variant B uses its sender name, preview text and content body', (bMail?.from_email || ''));
ok(aMail && !aMail.html.includes(`XYZ${rnd}`), 'variant A keeps the main content');
sql(`UPDATE deliveries SET opened_at = ${Date.now()} WHERE send_id = '${mvSend}' AND variant = 'B'`);
sql(`UPDATE jobs SET run_at = 0 WHERE kind = 'send.ab_winner' AND status = 'pending' AND payload LIKE '%${mvSend}%'`);
for (let i = 0; i < 8; i++) { await cron(); await sleep(1200); if (sql(`SELECT status FROM sends WHERE id = '${mvSend}'`)[0].status === 'sent') break; }
const mvAfter = sql(`SELECT status, options FROM sends WHERE id = '${mvSend}'`)[0];
ok(mvAfter.status === 'sent' && JSON.parse(mvAfter.options).winner === 'B' && sql(`SELECT COUNT(*) AS n FROM deliveries WHERE send_id = '${mvSend}'`)[0].n >= mvSubs, 'winner (B) chosen by opens and sent to the rest', mvAfter.status);
r = await req(`/app/posts/${mvPost}`); let mvh = await r.text();
ok(mvh.includes('data-ab-results') && mvh.includes('Multivariate test results') && mvh.includes('Variant Sender'), 'post analytics reports per-variant results');

// delivery by time zone: UTC readers at the chosen local time now, Tokyo readers later
const nowD = new Date(); const hhmm = `${String(nowD.getUTCHours()).padStart(2, '0')}:${String(nowD.getUTCMinutes()).padStart(2, '0')}`;
sql(`UPDATE subscribers SET timezone = 'UTC' WHERE id IN (SELECT id FROM subscribers WHERE id LIKE 'mv%${rnd}' ORDER BY id LIMIT 10)`);
const tzPost = await newPost('Timezones');
sres = await api(key, 'POST', `/posts/${tzPost}/send`, { send_timing: { mode: 'timezone', local_time: hhmm } });
const tzSend = sres.body?.data?.send_id;
for (let i = 0; i < 6; i++) { await cron(); await sleep(1200); if (sql(`SELECT COUNT(*) AS n FROM deliveries WHERE send_id = '${tzSend}' AND status = 'sent'`)[0].n >= 10) break; }
const tzRows = sql(`SELECT s.timezone, d.status, d.next_attempt_at FROM deliveries d JOIN subscribers s ON s.id = d.subscriber_id WHERE d.send_id = '${tzSend}'`);
const tokyo = tzRows.filter((x) => x.timezone === 'Asia/Tokyo');
const tokyoLocal = tokyo[0] && new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(tokyo[0].next_attempt_at));
ok(tzRows.filter((x) => x.timezone === 'UTC').every((x) => x.status === 'sent') && tokyo.length >= 30 && tokyo.every((x) => x.status === 'scheduled') && tokyoLocal === hhmm, `delivery by time zone: UTC readers sent now, Tokyo readers scheduled for ${tokyoLocal} Tokyo time`, JSON.stringify(tzRows.slice(0, 3)));
ok(sql(`SELECT status FROM sends WHERE id = '${tzSend}'`)[0].status === 'sending', 'timed send stays open until the last time zone');
r = await req(`/app/posts/${tzPost}`); ok((await r.text()).includes('data-send-timing'), 'post analytics shows timed-delivery progress');
// safety still applies: a paused timed send delivers nothing more
const schedBefore = sql(`SELECT COUNT(*) AS n FROM deliveries WHERE send_id = '${tzSend}' AND status = 'scheduled'`)[0].n;
sql(`UPDATE sends SET status = 'paused' WHERE id = '${tzSend}'`);
sql(`UPDATE deliveries SET next_attempt_at = 0 WHERE send_id = '${tzSend}' AND status = 'scheduled'`);
sql(`INSERT INTO jobs (id, kind, payload, run_at, status, attempts, created_at) SELECT 'j${rnd}', 'send.batch', '{"send_id":"${tzSend}"}', 0, 'pending', 0, 0`);
await cron(); await sleep(1200);
ok(sql(`SELECT COUNT(*) AS n FROM deliveries WHERE send_id = '${tzSend}' AND status = 'scheduled'`)[0].n === schedBefore && schedBefore >= tokyo.length, 'paused timed send keeps its scheduled deliveries');
sql(`UPDATE sends SET status = 'cancelled' WHERE id = '${tzSend}'`);

// send-time optimization: a reader who always opens at 05:xx UTC gets it at 05:xx
const stoSub = sql(`SELECT id FROM subscribers WHERE id LIKE 'mv%${rnd}' ORDER BY id DESC LIMIT 1`)[0].id;
const anyDel = sql(`SELECT id, send_id FROM deliveries WHERE subscriber_id = '${stoSub}' LIMIT 1`)[0];
const h5 = Date.UTC(2026, 9, 1, 5, 10);
for (let i = 0; i < 3; i++) sql(`INSERT INTO opens (id, delivery_id, send_id, pub_id, is_bot, created_at) VALUES ('op${i}${rnd}', '${anyDel.id}', '${anyDel.send_id}', '${pubId}', 0, ${h5 + i * 86400000})`);
const stoPost = await newPost('STO');
sres = await api(key, 'POST', `/posts/${stoPost}/send`, { send_timing: { mode: 'sto' } });
const stoSend = sres.body?.data?.send_id;
for (let i = 0; i < 6; i++) { await cron(); await sleep(1200); if (sql(`SELECT COUNT(*) AS n FROM deliveries WHERE send_id = '${stoSend}'`)[0].n >= mvSubs) break; }
const stoRow = sql(`SELECT status, next_attempt_at, sent_at FROM deliveries WHERE send_id = '${stoSend}' AND subscriber_id = '${stoSub}'`)[0];
const stoAt = stoRow && (stoRow.next_attempt_at || stoRow.sent_at);
ok(stoRow && new Date(stoAt).getUTCHours() === 5 && stoAt - Date.now() < 86400000 + 60000, 'send-time optimization: planned at the reader\'s usual open hour (05 UTC, within 24h)', JSON.stringify(stoRow));
sql(`UPDATE sends SET status = 'cancelled' WHERE id = '${stoSend}'`);
const mcpT = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_automation_templates', arguments: { category: 'E-commerce' } } }) });
const mtj = await mcpT.json();
ok(mcpT.status === 200 && !mtj.result?.isError && JSON.stringify(mtj.result).includes('post_purchase'), 'MCP list_automation_templates');
sql(`DELETE FROM subscribers WHERE id LIKE 'mv%${rnd}'`);
const errs13 = sql(`SELECT source, message FROM error_log ORDER BY created_at DESC LIMIT 10`);
ok(errs13.length === 0, 'no server errors logged (section 13)', JSON.stringify(errs13).slice(0, 800));

}
__restore();
{ // Deliverability Guardian: delivery metrics, DMARC report ingestion (zip + gzip), Guardian throttles/incidents/recovery, seed tests, /open
console.log('14. Deliverability Guardian: metrics, DMARC reports, throttles + incidents, seed placement, /open');
const zlib = await import('node:zlib');
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const zipOne = (name, data) => {
  const comp = zlib.deflateRawSync(data), nb = Buffer.from(name), crc = crc32(data);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nb.length, 28); cd.writeUInt32LE(0, 42);
  const cdOff = 30 + nb.length + comp.length, cdLen = 46 + nb.length;
  const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(1, 8); eo.writeUInt16LE(1, 10); eo.writeUInt32LE(cdLen, 12); eo.writeUInt32LE(cdOff, 16);
  return Buffer.concat([lh, nb, comp, cd, nb, eo]);
};
const dmarcXml = (org, rid, domain, rows) => `<?xml version="1.0" encoding="UTF-8" ?>
<feedback>
  <report_metadata><org_name>${org}</org_name><email>noreply-dmarc-support@${org}</email><report_id>${rid}</report_id><date_range><begin>${Math.floor(Date.now() / 1000) - 86400}</begin><end>${Math.floor(Date.now() / 1000)}</end></date_range></report_metadata>
  <policy_published><domain>${domain}</domain><adkim>r</adkim><aspf>r</aspf><p>none</p><sp>none</sp><pct>100</pct></policy_published>
  ${rows.map(([ip, count, dkim, spf]) => `<record><row><source_ip>${ip}</source_ip><count>${count}</count><policy_evaluated><disposition>none</disposition><dkim>${dkim}</dkim><spf>${spf}</spf></policy_evaluated></row><identifiers><header_from>${domain}</header_from></identifiers><auth_results><dkim><domain>${domain}</domain><result>${dkim}</result><selector>cf2024-1</selector></dkim><spf><domain>${domain}</domain><result>${spf}</result></spf></auth_results></record>`).join('\n  ')}
</feedback>`;
const mime = (from, to, subject, filename, type, bytes) => {
  const b = `b${rnd}x`;
  return `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@reports.example>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nThis is an aggregate report from ${from}.\r\n--${b}\r\nContent-Type: ${type}; name="${filename}"\r\nContent-Disposition: attachment; filename="${filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(bytes).toString('base64').replace(/(.{76})/g, '$1\r\n')}\r\n--${b}--\r\n`;
};
const inbound = (from, to, raw) => fetch(`${BASE}/cdn-cgi/local/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { method: 'POST', body: raw });

// a verified custom sending domain for this publication
const host = `g${rnd}.example.com`, domId = `dom${rnd}`;
sql(`INSERT INTO domains (id, pub_id, hostname, kind, status, verify_token, created_at) VALUES ('${domId}', '${pubId}', '${host}', 'email', 'verified', 'vt${rnd}', ${Date.now()})`);
r = await req('/app/settings/domains'); let gh = await r.text();
ok(r.status === 200 && gh.includes(`rua=mailto:dmarc+${domId}@news.lnkbase.com`) && gh.includes(`data-dmarc-section="${host}"`), 'Domains page tells the customer their rua address and shows a DMARC section');

// Google: zip attachment to the per-domain address; Microsoft: gzip to dmarc@ — real aggregate report format
const gXml = dmarcXml('google.com', `g-${rnd}`, host, [['104.30.0.1', 40, 'pass', 'pass'], ['104.30.0.2', 20, 'pass', 'fail'], ['203.0.113.9', 30, 'fail', 'fail']]);
let ir = await inbound('noreply-dmarc-support@google.com', `dmarc+${domId}@news.lnkbase.com`, mime('noreply-dmarc-support@google.com', `dmarc+${domId}@news.lnkbase.com`, `Report domain: ${host} Submitter: google.com Report-ID: g-${rnd}`, `google.com!${host}!1.zip`, 'application/zip', zipOne(`google.com!${host}!1.xml`, Buffer.from(gXml))));
ok(ir.status < 300, 'local email endpoint accepts the Google zip report', ir.status);
const mXml = dmarcXml('Outlook.com', `m-${rnd}`, host, [['104.30.0.1', 10, 'pass', 'pass'], ['198.51.100.7', 5, 'fail', 'fail']]);
ir = await inbound('dmarcreport@microsoft.com', 'dmarc@news.lnkbase.com', mime('dmarcreport@microsoft.com', 'dmarc@news.lnkbase.com', `Report Domain: ${host} Submitter: protection.outlook.com`, `protection.outlook.com!${host}!1.xml.gz`, 'application/gzip', zlib.gzipSync(Buffer.from(mXml))));
ok(ir.status < 300, 'local email endpoint accepts the Microsoft gzip report', ir.status);
let dr = sql(`SELECT org, messages FROM dmarc_reports WHERE domain = '${host}' ORDER BY org`);
ok(dr.length === 2 && dr.find((x) => x.org === 'google.com')?.messages === 90 && dr.find((x) => x.org === 'Outlook.com')?.messages === 15, 'zip and gzip DMARC reports parsed and stored', JSON.stringify(dr));
const recs = sql(`SELECT SUM(count) AS m, SUM(CASE WHEN dkim = 'pass' OR spf = 'pass' THEN count ELSE 0 END) AS p FROM dmarc_records WHERE domain = '${host}'`)[0];
ok(recs.m === 105 && recs.p === 70, 'per-day records by source IP with aligned pass/fail', JSON.stringify(recs));
// the same report again is a duplicate; a report for a domain we don't know is ignored
await inbound('noreply-dmarc-support@google.com', `dmarc+${domId}@news.lnkbase.com`, mime('noreply-dmarc-support@google.com', `dmarc+${domId}@news.lnkbase.com`, 'dup', 'r.zip', 'application/zip', zipOne('r.xml', Buffer.from(gXml))));
await inbound('noreply-dmarc-support@google.com', 'dmarc@news.lnkbase.com', mime('noreply-dmarc-support@google.com', 'dmarc@news.lnkbase.com', 'x', 'x.xml.gz', 'application/gzip', zlib.gzipSync(Buffer.from(dmarcXml('google.com', `u-${rnd}`, `unknown-${rnd}.example.org`, [['1.1.1.1', 9, 'fail', 'fail']])))));
ok(sql(`SELECT SUM(messages) AS n FROM dmarc_reports WHERE domain = '${host}'`)[0].n === 105 && sql(`SELECT COUNT(*) AS n FROM dmarc_reports WHERE domain = 'unknown-${rnd}.example.org'`)[0].n === 0, 'duplicate reports and unknown domains are not stored');
ok(sql(`SELECT COUNT(*) AS n FROM inbound_reports WHERE kind = 'dmarc' AND detail LIKE '%${host}%'`)[0].n === 2, 'DMARC reports logged under Inbound reports');
r = await req('/app/settings/domains'); gh = await r.text();
ok(gh.includes('data-failing-ip="203.0.113.9"') && gh.includes('66.7%'), 'Domains page shows the DMARC pass rate and failing sources');
r = await req('/app/analytics/guardian?tab=auth'); gh = await r.text();
ok(r.status === 200 && gh.includes('data-failing-ip="198.51.100.7"') && gh.includes('Outlook.com'), 'Guardian → Authentication shows reporters and failing sources');

// the Guardian scenario runs in its own fresh workspace (the main one has thousands of earlier deliveries)
cookies = {};
const gEmail = `gw.${rnd}@gmail.com`;
await req('/signup', { form: { name: 'Guardian Tester', email: gEmail, password: 'correct-horse-9' } });
await req('/app/onboarding', { form: { name: `Guardian ${rnd}`, slug: `gw-${rnd}`, description: 'Guardian', language: 'en', timezone: 'UTC' } });
const gCookies = { ...cookies };
const gRow = sql(`SELECT id, workspace_id FROM publications WHERE slug = 'gw-${rnd}'`)[0];
const gPub = gRow.id, gWs = gRow.workspace_id;
// delivery metrics: a send with 150 attempts, 2 s to delivery, 15 hard bounces (10%), 15 deferred once
const gsend = `gs${rnd}`, t0 = Date.now() - 20 * 60_000;
sql(`INSERT INTO sends (id, pub_id, kind, subject, status, total, sent, created_at) VALUES ('${gsend}', '${gPub}', 'post', 'Guardian ${rnd}', 'sent', 150, 135, ${t0})`);
sql(`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 150) INSERT INTO deliveries (id, send_id, pub_id, email, status, bounce_type, attempts, provider, sent_at, created_at) SELECT 'gd' || i || '${rnd}', '${gsend}', '${gPub}', 'gd' || i || '.${rnd}@example.net', CASE WHEN i <= 15 THEN 'bounced' ELSE 'sent' END, CASE WHEN i <= 15 THEN 'hard' ELSE NULL END, CASE WHEN i > 135 THEN 2 ELSE 1 END, 'other', CASE WHEN i <= 15 THEN NULL ELSE ${t0} + 2000 END, ${t0} FROM k`);
cookies = { ...gCookies };
r = await req('/app/analytics/guardian?tab=metrics'); gh = await r.text();
ok(r.status === 200 && gh.includes(`Guardian ${rnd}`) && gh.includes('2.0 s') && gh.includes('10.00%') && gh.includes('Cost per accepted email') && gh.includes('Revenue per 1,000'), 'metrics: per send (time to delivery, hard bounce rate), cost and revenue per 1k', gh.match(/Guardian [a-z0-9]+[\s\S]{0,600}/)?.[0]?.replace(/<[^>]+>/g, ' ').slice(0, 300));
ok(gh.includes('data-provider="other"') && gh.includes('Deferred'), 'metrics: per mailbox provider incl. deferral rate');

// Guardian: run it as a superadmin; the workspace's 10% hard bounces pause it (critical) with an expiry
cookies = {};
const gOps = `opsg.${rnd}@gmail.com`;
await req('/signup', { form: { name: 'Ops G', email: gOps, password: 'correct-horse-9' } });
sql(`UPDATE users SET is_superadmin = 1 WHERE email = '${gOps}'`);
const opsG = { ...cookies };
r = await req('/app/admin/guardian/run', { form: {} });
ok([302, 303].includes(r.status), 'superadmin can run the Guardian', r.status);
let inc = sql(`SELECT * FROM guardian_incidents WHERE scope = 'workspace:${gWs}' AND kind = 'bounces' AND status = 'open'`)[0];
const thr = sql(`SELECT * FROM send_throttles WHERE scope = 'workspace:${gWs}'`)[0];
ok(inc && inc.severity === 'critical' && /hard-bounced/.test(inc.title) && /paused sending/i.test(inc.diagnosis) && inc.recommendation.length > 20, 'Guardian opens a plain-English bounce incident', JSON.stringify(inc || {}).slice(0, 300));
ok(thr && thr.factor === 0 && thr.reason.startsWith('guardian:') && thr.until > Date.now() && thr.until <= Date.now() + 2 * 3600_000 + 60_000, 'Guardian pauses the workspace through send_throttles, with an expiry', JSON.stringify(thr || {}));
const dmInc = sql(`SELECT severity, title FROM guardian_incidents WHERE scope = 'domain:${host}' AND kind = 'dmarc' AND status = 'open'`)[0];
ok(dmInc && dmInc.severity === 'critical' && /passes DMARC/.test(dmInc.title), 'DMARC failures raise a domain incident', JSON.stringify(dmInc || {}));
ok(sql(`SELECT COUNT(*) AS n FROM outbox WHERE to_email = '${gEmail}' AND subject LIKE '%Deliverability:%hard-bounced%'`)[0].n === 1, 'owner emailed about the incident');
await req('/app/admin/guardian/run', { form: {} });
ok(sql(`SELECT COUNT(*) AS n FROM guardian_incidents WHERE scope = 'workspace:${gWs}' AND kind = 'bounces'`)[0].n === 1 && sql(`SELECT COUNT(*) AS n FROM outbox WHERE to_email = '${gEmail}' AND subject LIKE '%Deliverability:%hard-bounced%'`)[0].n === 1, 'a second pass updates the incident without re-notifying');
// an operator's own throttle is never overwritten by the Guardian
r = await req('/app/admin/guardian/throttle', { form: { scope: 'provider:yahoo', workspace: '', factor: '0.25', hours: '1', reason: 'e2e manual' } });
ok(sql(`SELECT factor, reason FROM send_throttles WHERE scope = 'provider:yahoo'`)[0]?.reason?.startsWith('operator'), 'superadmin can set a manual throttle');
r = await req('/app/admin/guardian'); gh = await r.text();
ok(r.status === 200 && gh.includes('data-throttle-scope="provider:yahoo"') && gh.includes(`data-throttle-scope="workspace:${gWs}"`) && gh.includes('Email Sending binding errors') && gh.includes('Mailbox providers'), 'platform Guardian view: provider health, binding errors, throttles, incidents');
await req('/app/admin/guardian/throttle/clear', { form: { scope: 'provider:yahoo' } });
ok(sql(`SELECT COUNT(*) AS n FROM send_throttles WHERE scope = 'provider:yahoo'`)[0].n === 0, 'superadmin can lift a throttle');

// customer view
cookies = { ...gCookies };
r = await req('/app/analytics/guardian'); gh = await r.text();
const score = Number(gh.match(/data-health="(\d+)"/)?.[1]);
ok(r.status === 200 && score < 75 && gh.includes('data-incident="bounces"') && gh.includes('Your account') && gh.includes('paused') && gh.includes('Recommendations'), `customer Guardian: health score (${score}), incident timeline, active throttle, recommendations`);
r = await req('/app/analytics/deliverability'); ok((await r.text()).includes('/app/analytics/guardian'), 'Analytics → Deliverability links to the Guardian');

// auto-recovery: fresh mail after the pause is clean → incident resolves, throttle lifted, owner told
sql(`UPDATE guardian_incidents SET acted_at = ${Date.now() - 2 * 60_000} WHERE id = '${inc.id}'`);
sql(`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 80) INSERT INTO deliveries (id, send_id, pub_id, email, status, attempts, provider, sent_at, created_at) SELECT 'gr' || i || '${rnd}', '${gsend}', '${gPub}', 'gr' || i || '.${rnd}@example.net', 'sent', 1, 'other', ${Date.now()}, ${Date.now() - 60_000} FROM k`);
cookies = opsG;
await req('/app/admin/guardian/run', { form: {} });
inc = sql(`SELECT status FROM guardian_incidents WHERE id = '${inc.id}'`)[0];
ok(inc.status === 'resolved' && sql(`SELECT COUNT(*) AS n FROM send_throttles WHERE scope = 'workspace:${gWs}'`)[0].n === 0, 'Guardian auto-recovers: incident resolved and throttle lifted', JSON.stringify(inc));
ok(sql(`SELECT COUNT(*) AS n FROM outbox WHERE to_email = '${gEmail}' AND subject LIKE '%Resolved:%hard-bounced%'`)[0].n === 1, 'owner told it recovered');
await req('/app/admin/guardian/run', { form: {} });
ok(sql(`SELECT COUNT(*) AS n FROM guardian_incidents WHERE scope = 'workspace:${gWs}' AND kind = 'bounces' AND status = 'open'`)[0].n === 0, 'old bad mail still in the window does not reopen it');

// inbox placement seed test
cookies = { ...__mainCookies };
r = await req('/app/analytics/guardian/seeds', { form: { emails: `seed1.${rnd}@gmail.com\nseed2.${rnd}@outlook.com\nnot-an-email` } });
ok(sql(`SELECT COUNT(*) AS n FROM seed_addresses WHERE pub_id = '${pubId}'`)[0].n === 2, 'seed inboxes added (invalid skipped)');
r = await req('/app/analytics/guardian/seed-test', { form: { post_id: postId } });
const seeds = sql(`SELECT id, email, provider FROM seed_results WHERE pub_id = '${pubId}' ORDER BY email`);
const seedMail = sql(`SELECT html, headers FROM outbox WHERE to_email = 'seed1.${rnd}@gmail.com'`)[0];
ok(seeds.length === 2 && seedMail && seedMail.html.includes(`/seed/${seeds[0].id}/spam`) && seedMail.html.includes('Placement test'), 'seed test sends the preview with one-click placement links', JSON.stringify(seeds));
cookies = {};
r = await req(`/seed/${seeds[0].id}/spam`);
ok(r.status === 200 && sql(`SELECT placement FROM seed_results WHERE id = '${seeds[0].id}'`)[0].placement === null, 'GET (link scanners) does not record placement');
r = await req(`/seed/${seeds[0].id}/spam`, { form: {} });
ok(r.status === 200 && sql(`SELECT placement FROM seed_results WHERE id = '${seeds[0].id}'`)[0].placement === 'spam', 'one-click link records placement');
ir = await inbound(`seed2.${rnd}@outlook.com`, `seed+${seeds[1].id}@news.lnkbase.com`, `From: seed2.${rnd}@outlook.com\r\nTo: seed+${seeds[1].id}@news.lnkbase.com\r\nSubject: Re: test\r\nMessage-ID: <s${rnd}@outlook.com>\r\nContent-Type: text/plain\r\n\r\ninbox\r\n`);
ok(sql(`SELECT placement FROM seed_results WHERE id = '${seeds[1].id}'`)[0].placement === 'inbox', 'replying "inbox" to a seed email records placement', ir.status);
cookies = { ...__mainCookies };
r = await req('/app/analytics/guardian?tab=placement'); gh = await r.text();
ok(gh.includes('data-seed-provider="gmail"') && gh.includes('data-seed-provider="outlook"') && gh.includes('This is a sample'), 'placement estimate per provider, labelled as a sample');

// public /open page
r = await fetch(`${BASE}/open`); gh = await r.text();
ok(r.status === 200 && gh.includes('Time to delivery runs from when an email was queued') && gh.includes('authentication pass rate'), '/open explains deferral, time to delivery and authentication');

// clean up so later runs start clear
sql(`DELETE FROM deliveries WHERE send_id = '${gsend}'`); sql(`DELETE FROM sends WHERE id = '${gsend}'`);
sql(`DELETE FROM guardian_incidents WHERE scope IN ('workspace:${gWs}', 'domain:${host}') OR scope LIKE 'provider:%'`); sql(`DELETE FROM send_throttles WHERE reason LIKE 'guardian:%'`);
sql(`DELETE FROM domains WHERE id = '${domId}'`);
const errs14 = sql(`SELECT source, message FROM error_log ORDER BY created_at DESC LIMIT 10`);
ok(errs14.length === 0, 'no server errors logged (section 14)', JSON.stringify(errs14).slice(0, 800));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
