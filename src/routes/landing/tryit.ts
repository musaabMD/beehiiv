// "Send me a sample issue" (/try): a visitor types their email and gets a real issue of the demo newsletter,
// sent through the normal pipeline (tracking, unsubscribe, headers), then watches it go sent → opened → clicked.
// Only on when TRY_IT=1 (the public demo). One email per address per day, a few per visitor, a daily cap overall.
// The address is stored as an unsubscribed subscriber so it is never mailed again and isn't counted as a reader.
import type { Hono } from 'hono';
import type { AppEnv, Env, Post, Publication, Subscriber } from '../../types';
import { one, insert, run } from '../../lib/db';
import { id, now, str, esc } from '../../lib/util';
import { validateEmail, rateLimit, clientIP, botScore } from '../../lib/guard';
import { postContent, deliver } from '../../lib/sender';
import { senderFor } from '../../lib/pub';
import { shell } from './marketing';

type Ctx = { purchaseUrl: string; priceLabel: string; contact?: string; loggedIn?: boolean };

const enabled = (env: Env) => env.TRY_IT === '1' && !!env.EMAIL;

async function samplePost(env: Env, pub: Publication): Promise<Post | null> {
  if (env.TRY_POST_ID) { const p = await one<Post>(env, 'SELECT * FROM posts WHERE id = ? AND pub_id = ?', env.TRY_POST_ID, pub.id); if (p) return p; }
  return one<Post>(env, `SELECT * FROM posts WHERE pub_id = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1`, pub.id);
}

function formPage(c: Ctx, msg = '', email = '') {
  return shell({ ...c, title: 'Get a sample issue · OpenHive', description: 'Get a real issue of the OpenHive demo newsletter in your inbox and watch it get delivered, opened and clicked.', body: `
<section class="hero"><div class="wrap narrow">
  <div class="eyebrow">Try it</div>
  <h1>Get a real issue in your inbox</h1>
  <p class="lead">Type your email and we'll send you the latest issue of <b>The Demo Dispatch</b>, the demo newsletter, through the same pipeline your readers would get: your own domain, tracking, one-click unsubscribe. Then watch it on the next page as it's sent, opened and clicked.</p>
  ${msg ? `<div class="note" style="margin-bottom:18px">${esc(msg)}</div>` : ''}
  <form method="post" action="/try" class="card" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding:16px">
    <input type="email" name="email" required value="${esc(email)}" placeholder="you@example.com" aria-label="Your email" style="flex:1;min-width:220px;height:46px;border:1px solid var(--line);border-radius:12px;padding:0 14px;font:inherit;background:#fff">
    <input type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px">
    <input type="hidden" name="_t" value="${Date.now()}">
    <button class="btn btn-primary" type="submit">Send me a sample</button>
  </form>
  <p class="small muted" style="margin-top:12px">One email, once. We don't add you to any list, and the unsubscribe link in it works like it would for a real reader. Check your spam folder too, and tell us where it landed.</p>
</div></section>
<section style="padding-top:0"><div class="wrap narrow"><h2>What to look at</h2><ul class="ticks">
  <li><span>✓</span><span><b>Where it lands:</b> Primary, Promotions or spam.</span></li>
  <li><span>✓</span><span><b>Who it's from:</b> the demo's own domain, signed with DKIM and passing SPF and DMARC. In Gmail, open "Show original" to see the checks.</span></li>
  <li><span>✓</span><span><b>Unsubscribe:</b> Gmail and Yahoo show their own one-click unsubscribe button.</span></li>
  <li><span>✓</span><span><b>Tracking:</b> open it and click a link; the status page updates within seconds.</span></li>
</ul></div></section>` });
}

function statusPage(c: Ctx, did: string, email: string) {
  return shell({ ...c, title: 'Your sample is on its way · OpenHive', description: 'Live status of your sample email.', body: `
<section class="hero"><div class="wrap narrow">
  <div class="eyebrow">Try it</div>
  <h1>Your sample is on its way</h1>
  <p class="lead">Sent to <b>${esc(email)}</b>. This page updates by itself.</p>
  <div class="card" id="st" style="padding:8px 22px">
    ${[['sent', 'Handed to Cloudflare Email Sending', 'Signed with DKIM for the demo’s domain.'], ['opened', 'Opened', 'Open the email. Apple Mail can open emails on its own, so opens are a hint, not proof.'], ['clicked', 'Clicked', 'Click any link in the email. Clicks in the first 10 seconds are treated as link scanners.']]
      .map(([k, t, d]) => `<div data-step="${k}" style="display:flex;gap:14px;padding:16px 0;border-bottom:1px solid var(--line)"><span class="dot" style="width:22px;height:22px;border-radius:999px;border:2px solid var(--line);flex:none;margin-top:2px"></span><div><b>${t}</b> <span class="when muted small"></span><div class="muted small">${d}</div></div></div>`).join('')}
    <p id="flt" class="small muted" style="margin:12px 0 0"></p>
    <p id="err" class="small" style="color:#b91c1c;margin:12px 0"></p>
  </div>
  <p class="small muted" style="margin-top:14px">Didn't get it in a minute? Check spam and Promotions. <a href="/open" style="text-decoration:underline">See this install's live deliverability numbers</a>.</p>
</div></section>
<script>
(function(){var u='/try/s/${esc(did)}.json',t0=Date.now();
function tick(){fetch(u).then(function(r){return r.json()}).then(function(d){
  [['sent',d.sent_at],['opened',d.opened_at],['clicked',d.clicked_at]].forEach(function(x){var el=document.querySelector('[data-step='+x[0]+']');if(!el||!x[1])return;
    el.querySelector('.dot').style.cssText+='background:#059669;border-color:#059669';el.querySelector('.when').textContent='· '+new Date(x[1]).toLocaleTimeString();});
  document.getElementById('err').textContent=d.error?('Problem: '+d.error):'';
  var f=document.getElementById('flt');var n=(d.bot_opens||0)+(d.bot_clicks||0);f.textContent=n?('Filtered out: '+d.bot_opens+' scanner open'+(d.bot_opens==1?'':'s')+' and '+d.bot_clicks+' scanner click'+(d.bot_clicks==1?'':'s')+'. Mail providers and security tools check links before you do; those aren\'t counted.'):'';
  if(!d.clicked_at&&Date.now()-t0<30*60*1000)setTimeout(tick,3000);}).catch(function(){setTimeout(tick,6000)})}
tick();})();
</script>` });
}

export function mountTryIt(root: Hono<AppEnv>, ctxFor: (c: any) => Promise<Ctx>) {
  root.get('/try', async (c) => {
    if (!enabled(c.env)) return c.redirect('/', 302);
    return c.html(formPage(await ctxFor(c)));
  });

  root.post('/try', async (c) => {
    if (!enabled(c.env)) return c.redirect('/', 302);
    const ctx = await ctxFor(c);
    c.header('cache-control', 'no-store');
    const f = await c.req.parseBody();
    const raw = str(f.email, 254);
    const ip = clientIP(c.req.raw);
    if (botScore({ honeypot: String(f.website || ''), renderedAt: String(f._t || ''), ua: c.req.header('user-agent') || null, turnstileOk: null }) >= 30) return c.html(formPage(ctx, 'That looked automated. Please try again.', raw), 400);
    if (!(await rateLimit(c.env, `try:ip:${ip}`, 3, 3600))) return c.html(formPage(ctx, 'You\'ve requested a few samples already. Try again in an hour.', raw), 429);
    const v = await validateEmail(raw, { strict: true });
    if (!v.ok) return c.html(formPage(ctx, v.suggestion ? `Did you mean ${v.suggestion}?` : v.reason || 'That email address looks invalid.', v.suggestion || raw), 400);
    if (!(await rateLimit(c.env, `try:email:${v.email}`, 1, 86400))) return c.html(formPage(ctx, 'We already sent a sample to that address today.', raw), 429);
    if (!(await rateLimit(c.env, 'try:global', Number(c.env.TRY_DAILY_CAP) || 100, 86400))) return c.html(formPage(ctx, 'Today\'s samples are all used up. Please try again tomorrow.', raw), 429);

    const pub = await one<Publication>(c.env, 'SELECT * FROM publications WHERE slug = ?', c.env.TRY_PUB_SLUG || 'demo');
    const post = pub ? await samplePost(c.env, pub) : null;
    if (!pub || !post) return c.html(formPage(ctx, 'The demo newsletter has no published issue to send yet.', raw), 503);

    // Store the address as an unsubscribed subscriber: never mailed again, not counted as a reader.
    let sub = await one<Subscriber>(c.env, 'SELECT * FROM subscribers WHERE pub_id = ? AND email = ?', pub.id, v.email);
    if (!sub) {
      const sid = id();
      await insert(c.env, 'subscribers', { id: sid, pub_id: pub.id, email: v.email, name: '', status: 'unsubscribed', tier: 'free', source: 'try_it', source_detail: 'sample', referral_code: id(10), custom: '{}', unsubscribed_at: now(), created_at: now(), updated_at: now() });
      sub = await one<Subscriber>(c.env, 'SELECT * FROM subscribers WHERE id = ?', sid);
    }
    const sendId = id();
    const subject = `Sample: ${post.email_subject || post.title}`;
    await insert(c.env, 'sends', { id: sendId, pub_id: pub.id, post_id: post.id, kind: 'try', subject, status: 'sent', total: 1, sent: 0, failed: 0, options: '{}', created_at: now(), started_at: now(), completed_at: now() });
    const from = await senderFor(c.env, pub, 'newsletter', post.sender_id);
    const r = await deliver(c.env, pub, sendId, sub!, subject, await postContent(c.env, post), from, { post, forceReal: true });
    await run(c.env, 'UPDATE sends SET sent = ?, failed = ? WHERE id = ?', r.result.ok ? 1 : 0, r.result.ok ? 0 : 1, sendId);
    return c.redirect(`/try/s/${r.deliveryId}`, 303);
  });

  root.get('/try/s/:id{.+\\.json}', async (c) => {
    const did = c.req.param('id').replace(/\.json$/, '');
    const d = await one<any>(c.env, `SELECT d.status, d.sent_at, d.opened_at, d.clicked_at, d.error FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE d.id = ? AND s.kind = 'try'`, did);
    c.header('cache-control', 'no-store');
    if (!d) return c.json({ error: 'not found' }, 404);
    const bots = await one<any>(c.env, `SELECT (SELECT COUNT(*) FROM opens WHERE delivery_id = ? AND is_bot = 1) AS o, (SELECT COUNT(*) FROM clicks WHERE delivery_id = ? AND is_bot = 1) AS k`, did, did);
    return c.json({ bot_opens: bots?.o || 0, bot_clicks: bots?.k || 0, status: d.status, sent_at: d.sent_at, opened_at: d.opened_at, clicked_at: d.clicked_at, error: d.status === 'sent' ? null : d.error || (d.status === 'suppressed' ? 'This address is on a suppression list.' : null) });
  });

  root.get('/try/s/:id', async (c) => {
    const d = await one<any>(c.env, `SELECT d.id, d.email FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE d.id = ? AND s.kind = 'try'`, c.req.param('id'));
    if (!d) return c.redirect('/try', 302);
    c.header('cache-control', 'no-store');
    return c.html(statusPage(await ctxFor(c), d.id, d.email));
  });

}
