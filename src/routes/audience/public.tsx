/** @jsxImportSource hono/jsx */
// Audience site routes: subscribe, confirm, signup flow (/welcome), polls, surveys.
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv, Ctx, Publication, Subscriber } from '../../types';
import { one, all, run, insert } from '../../lib/db';
import { processSignup, type SignupResult } from '../../lib/signup';
import { confirmToken, subToken, verifySubToken, subscribe } from '../../lib/subscribers';
import { createReaderSession } from '../../lib/auth';
import { settings, siteUrl } from '../../lib/pub';
import { emit } from '../../lib/events';
import { trackView } from '../../lib/tracking';
import { SiteLayout, SiteMessage, SubscribeForm } from '../../ui/site';
import { flash } from '../../ui/components';
import { form, id, now, parseJSON, str, fmtDate, esc } from '../../lib/util';

const site = new Hono<AppEnv>();
const WELCOME = 'oh_welcome';

export interface SurveyQ { id: string; kind: string; label: string; options?: string[]; required?: boolean; help?: string }

async function publicLists(c: Ctx) {
  return all<{ id: string; name: string }>(c.env, 'SELECT id, name FROM lists WHERE pub_id = ? AND public = 1 ORDER BY is_default DESC, created_at', c.get('pub').id);
}

/** Welcome flow steps for this signup. */
function flowSteps(pub: Publication, formFlow?: { survey_id?: string; recommendations?: boolean; referral?: boolean } | null): string[] {
  const cfg = settings(pub);
  const steps: string[] = [];
  const survey = formFlow?.survey_id || cfg.signup_survey_id;
  const configured = cfg.signup_flow || [];
  if (survey) steps.push('survey');
  if (formFlow?.recommendations || configured.includes('recommendations')) steps.push('recommendations');
  if (formFlow?.referral || configured.includes('referral')) steps.push('referral');
  return steps;
}

async function welcomeState(c: Ctx): Promise<{ sub: Subscriber; formId: string | null } | null> {
  const raw = getCookie(c, WELCOME);
  if (!raw) return null;
  const [tok, formId] = raw.split('|');
  const sid = await verifySubToken(c.env, tok);
  if (!sid) return null;
  const sub = await one<Subscriber>(c.env, 'SELECT * FROM subscribers WHERE id = ? AND pub_id = ?', sid, c.get('pub').id);
  return sub ? { sub, formId: formId || null } : null;
}

async function formFlow(c: Ctx, formId: string | null) {
  if (!formId) return null;
  const f = await one<{ live: string | null; draft: string }>(c.env, 'SELECT live, draft FROM forms WHERE id = ? AND pub_id = ?', formId, c.get('pub').id);
  return f ? parseJSON<any>(f.live || f.draft, {}).flow || null : null;
}

function passthrough(f: Record<string, any>, override: Record<string, string> = {}) {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries({ ...f, ...override })) {
    if (k === 'lists' && Array.isArray(v)) v.forEach((x) => out.push(['lists[]', String(x)]));
    else if (typeof v === 'string') out.push([k, v]);
  }
  return out.map(([k, v]) => <input type="hidden" name={k} value={v} />);
}

async function subscribePage(c: Ctx, opts: { error?: string; suggestion?: string | null; body?: Record<string, any>; status?: 200 | 400 | 429 } = {}) {
  const pub = c.get('pub');
  const base = siteUrl(c.env, pub);
  const lists = await publicLists(c);
  const posts = await all<any>(c.env, `SELECT title, subtitle, slug, published_at FROM posts WHERE pub_id = ? AND status = 'published' AND platform != 'email' AND hide_from_feed = 0 ORDER BY published_at DESC LIMIT 3`, pub.id);
  const subs = await one<{ n: number }>(c.env, `SELECT COUNT(*) AS n FROM subscribers WHERE pub_id = ? AND status = 'active'`, pub.id);
  return c.html(
    await SiteLayout({
      c, title: 'Subscribe', description: pub.description,
      children: (
        <section class="s-wrap s-narrow s-section" style="text-align:center">
          {pub.logo_url && <img src={pub.logo_url} alt="" width="72" height="72" style="border-radius:16px;margin-bottom:16px" />}
          <h1>Subscribe to {pub.name}</h1>
          <p class="s-muted" style="font-size:19px">{pub.description}</p>
          {(subs?.n || 0) >= 50 && <p class="s-muted s-small">Join {subs!.n.toLocaleString()} readers.</p>}
          {opts.error && (
            <div class="s-flash s-flash-err" style="margin:16px 0">
              {opts.error}
              {opts.suggestion && opts.body && (
                <form method="post" action={base + '/subscribe'} style="display:inline;margin-left:6px">
                  {passthrough(opts.body, { email: opts.suggestion })}
                  <button class="s-btn s-btn-ghost" style="height:30px">Use {opts.suggestion}</button>
                </form>
              )}
            </div>
          )}
          <div style="max-width:520px;margin:20px auto">
            <SubscribeForm action={base + '/subscribe'} lists={lists.length > 1 ? lists : undefined} />
          </div>
          {posts.length > 0 && (
            <div style="text-align:left;margin-top:48px">
              <h2 style="font-size:18px">Recent posts</h2>
              {posts.map((p) => (
                <a class="s-card" href={`${base}/p/${p.slug}`} style="padding:14px 0;border-top:1px solid var(--border)">
                  <h3 style="font-size:17px">{p.title}</h3>
                  {p.subtitle && <p>{p.subtitle}</p>}
                  <span class="s-meta">{fmtDate(p.published_at)}</span>
                </a>
              ))}
            </div>
          )}
        </section>
      ),
    }),
    opts.status || 200,
  );
}

site.get('/subscribe', async (c) => {
  await trackView(c);
  return subscribePage(c);
});

/** Shared response handling for site + embed submissions. */
export async function respondSignup(c: Ctx, res: SignupResult, body: Record<string, any>, mode: 'site' | 'json') {
  const pub = c.get('pub');
  const base = siteUrl(c.env, pub);
  if (res.kind === 'error') {
    if (mode === 'json') return c.json({ ok: false, error: res.message, suggestion: res.suggestion ?? null }, res.status);
    return subscribePage(c, { error: res.message, suggestion: res.suggestion, body, status: res.status });
  }
  if (res.kind === 'confirm_human') {
    if (mode === 'json') return c.json({ ok: false, confirm: true, human: res.token, message: 'Please confirm you are human.' }, 200);
    return c.html(
      await SiteLayout({
        c, title: 'One more step', noindex: true,
        children: (
          <section class="s-wrap s-narrow s-message">
            <h1>One more step</h1>
            <p class="s-muted">Please confirm you want to subscribe <strong>{res.email}</strong> to {pub.name}.</p>
            <form method="post" action={base + '/subscribe'}>
              {passthrough(body, { _human: res.token, website: '' })}
              <button class="s-btn">Yes, subscribe me</button>
            </form>
          </section>
        ),
      }),
    );
  }
  // ok
  if (res.fake || !res.subscriber) {
    if (mode === 'json') return c.json({ ok: true, pending: true, message: 'Thanks! Check your inbox to confirm.' });
    return SiteMessage(c, 'Check your inbox', <p class="s-muted">If that address can receive email, a confirmation is on its way.</p>);
  }
  const sub = res.subscriber;
  const successMsg = res.form?.success.mode === 'message' && res.form.success.message ? res.form.success.message : null;
  if (res.pending) {
    if (mode === 'json') return c.json({ ok: true, pending: true, message: successMsg || 'Almost there! Check your inbox to confirm your subscription.' });
    return SiteMessage(c, 'Check your inbox', <><p>We sent a confirmation link to <strong>{sub.email}</strong>.</p><p class="s-muted">Click it to finish subscribing to {pub.name}. Can't find it? Check your spam or promotions folder.</p></>);
  }
  if (res.created && sub.tier === 'free') await createReaderSession(c, sub.email);
  const wval = `${await subToken(c.env, sub.id)}|${res.formId || ''}`;
  setCookie(c, WELCOME, wval, { path: '/', maxAge: 3600, sameSite: 'Lax', httpOnly: true });
  const steps = flowSteps(pub, res.form?.flow);
  let redirect: string | null = null;
  if (res.form?.success.mode === 'redirect' && res.form.success.url) redirect = res.form.success.url;
  // embeds run cross-site (cookies are blocked there), so hand the flow state over in the URL
  else if (steps.length) redirect = mode === 'json' ? `${base}/welcome?w=${encodeURIComponent(wval)}` : `${base}/welcome`;
  else if (settings(pub).redirect_after_signup) redirect = String(settings(pub).redirect_after_signup);
  if (mode === 'json') return c.json({ ok: true, pending: false, message: successMsg || `You're subscribed to ${pub.name}!`, redirect });
  if (redirect) return c.redirect(redirect, 303);
  flash(c, `You're subscribed to ${pub.name}! 🎉`);
  return c.redirect(base + '/', 303);
}

site.post('/subscribe', async (c) => {
  const f = await form(c.req);
  const res = await processSignup(c.env, c.req.raw, c.get('pub'), f);
  const json = (c.req.header('accept') || '').includes('application/json');
  return respondSignup(c, res, f, json ? 'json' : 'site');
});

site.get('/confirm/:token', async (c) => {
  const r = await confirmToken(c.env, c.req.param('token'));
  const pub = c.get('pub');
  if (!r || r.pub.id !== pub.id) return SiteMessage(c, 'Link expired', <p class="s-muted">This confirmation link is invalid or has expired. <a href={siteUrl(c.env, pub) + '/subscribe'}>Subscribe again</a>.</p>, 400);
  if (r.sub.tier === 'free') await createReaderSession(c, r.sub.email);
  setCookie(c, WELCOME, `${await subToken(c.env, r.sub.id)}|${r.sub.source === 'form' ? r.sub.source_detail || '' : ''}`, { path: '/', maxAge: 3600, sameSite: 'Lax', httpOnly: true });
  const steps = flowSteps(pub, await formFlow(c, r.sub.source === 'form' ? r.sub.source_detail : null));
  if (steps.length) return c.redirect(siteUrl(c.env, pub) + '/welcome', 303);
  const redirect = settings(pub).redirect_after_signup;
  if (redirect) return c.redirect(String(redirect), 303);
  return SiteMessage(c, "You're confirmed! 🎉", <><p>Thanks for confirming. You'll get the next issue of <strong>{pub.name}</strong> in your inbox.</p><p><a class="s-btn" href={siteUrl(c.env, pub) + '/'}>Read the latest posts</a></p></>);
});

// ───── signup flow ─────
site.get('/welcome', async (c) => {
  const pub = c.get('pub');
  const base = siteUrl(c.env, pub);
  const w = c.req.query('w');
  if (w) {
    if (await verifySubToken(c.env, w.split('|')[0])) setCookie(c, WELCOME, w, { path: '/', maxAge: 3600, sameSite: 'Lax', httpOnly: true });
    return c.redirect(base + '/welcome', 303);
  }
  const st = await welcomeState(c);
  if (!st) return c.redirect(base + '/', 302);
  const ff = await formFlow(c, st.formId);
  const steps = flowSteps(pub, ff);
  let step = c.req.query('step') || steps[0] || 'done';
  const nextOf = (s: string) => steps[steps.indexOf(s) + 1] || 'done';
  const progress = steps.length ? <p class="s-muted s-small">Step {Math.min(steps.indexOf(step) + 1, steps.length)} of {steps.length}</p> : null;

  if (step === 'survey') {
    const sid = ff?.survey_id || settings(pub).signup_survey_id;
    const survey = sid ? await one<any>(c.env, `SELECT * FROM surveys WHERE id = ? AND pub_id = ? AND status = 'active'`, sid, pub.id) : null;
    const answered = survey ? await one(c.env, 'SELECT 1 FROM survey_responses WHERE survey_id = ? AND subscriber_id = ?', survey.id, st.sub.id) : true;
    if (!survey || answered) step = nextOf('survey');
    else
      return c.html(await SiteLayout({ c, title: survey.title, noindex: true, children: <section class="s-wrap s-narrow s-section">{progress}<h1>Welcome! A quick question or two</h1><SurveyForm c={c} survey={survey} next={`/welcome?step=${nextOf('survey')}`} skip={`${base}/welcome?step=${nextOf('survey')}`} /></section> }));
  }
  if (step === 'recommendations') {
    const recs = await all<any>(c.env, `SELECT r.*, p.name AS t_name, p.description AS t_desc, p.slug AS t_slug, p.logo_url AS t_logo FROM recommendations r LEFT JOIN publications p ON p.id = r.target_pub_id WHERE r.pub_id = ? AND r.status = 'active' ORDER BY r.position LIMIT 8`, pub.id);
    if (!recs.length) step = nextOf('recommendations');
    else
      return c.html(
        await SiteLayout({
          c, title: 'Recommended for you', noindex: true,
          children: (
            <section class="s-wrap s-narrow s-section">
              {progress}
              <h1>{pub.name} recommends</h1>
              <p class="s-muted">Subscribe to more great newsletters with one click.</p>
              <form method="post" action={`${base}/welcome/recommendations`} class="s-stack">
                <input type="hidden" name="next" value={nextOf('recommendations')} />
                {recs.map((r) => (
                  <label class="s-box" style="display:flex;gap:12px;align-items:center;cursor:pointer">
                    {r.target_pub_id ? <input type="checkbox" name="recs[]" value={r.id} checked /> : <span />}
                    {(r.t_logo || r.ext_logo) && <img src={r.t_logo || r.ext_logo} alt="" width="40" height="40" style="border-radius:8px" />}
                    <span style="flex:1"><strong>{r.t_name || r.ext_name}</strong><br /><span class="s-muted s-small">{r.t_desc || r.ext_description}</span></span>
                    {!r.target_pub_id && r.ext_url && <a href={r.ext_url} target="_blank" rel="noopener" class="s-btn s-btn-ghost">Visit</a>}
                  </label>
                ))}
                <div style="display:flex;gap:10px"><button class="s-btn">Continue</button><a class="s-btn s-btn-ghost" href={`${base}/welcome?step=${nextOf('recommendations')}`}>Skip</a></div>
              </form>
            </section>
          ),
        }),
      );
  }
  if (step === 'referral') {
    const rewards = await all<any>(c.env, 'SELECT milestone, name, description FROM referral_rewards WHERE pub_id = ? ORDER BY milestone', pub.id);
    const link = `${base}/subscribe?ref=${st.sub.referral_code}`;
    return c.html(
      await SiteLayout({
        c, title: 'Share with friends', noindex: true,
        children: (
          <section class="s-wrap s-narrow s-section" style="text-align:center">
            {progress}
            <h1>Share {pub.name} with friends</h1>
            <p class="s-muted">Send your personal link to friends{rewards.length ? ' and earn rewards' : ''}.</p>
            <div class="oh-copy" style="max-width:520px;margin:20px auto"><input readonly value={link} /><button type="button" data-copy={link}>Copy</button></div>
            {rewards.length > 0 && (
              <div class="s-box" style="text-align:left;max-width:520px;margin:0 auto 20px">
                {rewards.map((r) => <p style="margin:0 0 8px"><strong>{r.milestone} referral{r.milestone === 1 ? '' : 's'}</strong> → {r.name}<br /><span class="s-muted s-small">{r.description}</span></p>)}
              </div>
            )}
            <p><a class="s-btn" href={`${base}/welcome?step=done`}>Done</a></p>
          </section>
        ),
      }),
    );
  }
  // done
  deleteCookie(c, WELCOME, { path: '/' });
  const redirect = settings(pub).redirect_after_signup;
  if (redirect) return c.redirect(String(redirect), 303);
  return SiteMessage(c, "You're all set! 🎉", <><p>Welcome to <strong>{pub.name}</strong>. Your first issue is on its way.</p><p><a class="s-btn" href={base + '/'}>Start reading</a></p></>);
});

site.post('/welcome/recommendations', async (c) => {
  const pub = c.get('pub');
  const base = siteUrl(c.env, pub);
  const st = await welcomeState(c);
  const f = await form(c.req);
  if (st) {
    for (const rid of (f.recs as string[]) || []) {
      const r = await one<any>(c.env, `SELECT * FROM recommendations WHERE id = ? AND pub_id = ? AND status = 'active' AND target_pub_id IS NOT NULL`, rid, pub.id);
      if (!r) continue;
      const target = await one<Publication>(c.env, 'SELECT * FROM publications WHERE id = ?', r.target_pub_id);
      if (!target) continue;
      const res = await subscribe(c.env, target, { email: st.sub.email, name: st.sub.name, source: 'recommendation', sourceDetail: pub.id, country: st.sub.country });
      if (res.ok && res.created) await run(c.env, 'UPDATE recommendations SET subscribers_sent = subscribers_sent + 1 WHERE id = ?', r.id);
    }
  }
  return c.redirect(`${base}/welcome?step=${encodeURIComponent(str(f.next, 30) || 'done')}`, 303);
});

// ───── polls ─────
async function pollResults(c: Ctx, poll: any, mine: string | null, msg?: string) {
  const opts = parseJSON<Array<{ id: string; label: string }>>(poll.options, []);
  const counts = await all<{ option_id: string; n: number }>(c.env, 'SELECT option_id, COUNT(*) AS n FROM poll_votes WHERE poll_id = ? GROUP BY option_id', poll.id);
  const total = counts.reduce((a, b) => a + b.n, 0);
  const base = siteUrl(c.env, c.get('pub'));
  const trivia = poll.kind === 'trivia' && !!poll.correct_option_id;
  return c.html(
    await SiteLayout({
      c, title: poll.question, noindex: true,
      children: (
        <section class="s-wrap s-narrow s-section">
          {msg && <div class="s-flash s-flash-ok" style="margin:0 0 16px">{msg}</div>}
          <div class="oh-poll">
            {trivia && <p class="s-badge" style="margin:0 0 8px">Trivia</p>}
            <p class="oh-poll-q">{poll.question}</p>
            {!mine && !poll.closed ? (
              <form method="post" action={`${base}/poll/${poll.id}/vote`}>
                {opts.map((o) => <button class="oh-poll-opt" name="o" value={o.id}>{o.label}</button>)}
              </form>
            ) : (
              <>
                {trivia && mine && (
                  <div class={`s-flash ${mine === poll.correct_option_id ? 's-flash-ok' : 's-flash-err'}`} style="margin:0 0 12px">
                    {mine === poll.correct_option_id ? '🎉 Correct!' : `Not quite — the answer is “${opts.find((o) => o.id === poll.correct_option_id)?.label || ''}”.`}
                    {poll.explanation ? <div style="margin-top:6px;font-weight:400">{poll.explanation}</div> : null}
                  </div>
                )}
                {opts.map((o) => {
                  const n = counts.find((x) => x.option_id === o.id)?.n || 0;
                  const pct = total ? Math.round((n / total) * 100) : 0;
                  const mark = trivia && (mine || poll.closed) ? (o.id === poll.correct_option_id ? ' ✅' : mine === o.id ? ' ❌' : '') : mine === o.id ? ' ✓' : '';
                  return <div class="oh-poll-result"><i style={`width:${pct}%`} /><span><span>{o.label}{mark}</span><strong>{pct}%</strong></span></div>;
                })}
                <p class="s-muted s-small">{total} vote{total === 1 ? '' : 's'}{trivia && total ? ` · ${Math.round(((counts.find((x) => x.option_id === poll.correct_option_id)?.n || 0) / total) * 100)}% got it right` : ''}{poll.closed ? ' · poll closed' : ''}</p>
              </>
            )}
          </div>
          <p><a href={base + '/'}>← Back to {c.get('pub').name}</a></p>
        </section>
      ),
    }),
  );
}

async function castVote(c: Ctx, poll: any, optionId: string, subscriberId: string | null, channel: 'email' | 'web', postId: string | null): Promise<boolean> {
  const opts = parseJSON<Array<{ id: string }>>(poll.options, []);
  if (poll.closed || !opts.some((o) => o.id === optionId)) return false;
  const res = await run(c.env, 'INSERT OR IGNORE INTO poll_votes (id, poll_id, pub_id, subscriber_id, option_id, post_id, channel, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id(), poll.id, poll.pub_id, subscriberId, optionId, postId, channel, now());
  if (res.meta.changes) await emit(c.env, { pubId: poll.pub_id, type: 'poll.vote', subscriberId, refId: poll.id, data: { poll_id: poll.id, option_id: optionId, post_id: postId, channel } });
  return !!res.meta.changes;
}

site.get('/poll/:id', async (c) => {
  const poll = await one<any>(c.env, 'SELECT * FROM polls WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
  if (!poll) return SiteMessage(c, 'Poll not found', <p>This poll does not exist.</p>, 404);
  const reader = c.get('reader');
  let mine = c.req.query('voted') || getCookie(c, 'oh_pv_' + poll.id) || null;
  if (reader?.subscriber) mine = (await one<any>(c.env, 'SELECT option_id FROM poll_votes WHERE poll_id = ? AND subscriber_id = ?', poll.id, reader.subscriber.id))?.option_id || mine;
  return pollResults(c, poll, mine, c.req.query('voted') && poll.kind !== 'trivia' ? 'Thanks for voting!' : undefined);
});

// one-click vote from an email
site.get('/poll/:id/vote', async (c) => {
  const pub = c.get('pub');
  const poll = await one<any>(c.env, 'SELECT * FROM polls WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
  if (!poll) return SiteMessage(c, 'Poll not found', <p>This poll does not exist.</p>, 404);
  const o = c.req.query('o') || '';
  const d = c.req.query('d');
  let subId: string | null = null;
  if (d) subId = (await one<any>(c.env, 'SELECT subscriber_id FROM deliveries WHERE id = ? AND pub_id = ?', d, pub.id))?.subscriber_id || null;
  if (!subId) subId = c.get('reader')?.subscriber?.id || null;
  if (subId) {
    await castVote(c, poll, o, subId, d ? 'email' : 'web', c.req.query('post') || null);
    const mine = (await one<any>(c.env, 'SELECT option_id FROM poll_votes WHERE poll_id = ? AND subscriber_id = ?', poll.id, subId))?.option_id;
    return c.redirect(`${siteUrl(c.env, pub)}/poll/${poll.id}?voted=${encodeURIComponent(mine || o)}`, 303);
  }
  if (!getCookie(c, 'oh_pv_' + poll.id) && (await castVote(c, poll, o, null, 'web', c.req.query('post') || null))) setCookie(c, 'oh_pv_' + poll.id, o, { path: '/', maxAge: 365 * 86400, sameSite: 'Lax' });
  return c.redirect(`${siteUrl(c.env, pub)}/poll/${poll.id}?voted=${encodeURIComponent(getCookie(c, 'oh_pv_' + poll.id) || o)}`, 303);
});

site.post('/poll/:id/vote', async (c) => {
  const pub = c.get('pub');
  const poll = await one<any>(c.env, 'SELECT * FROM polls WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
  if (!poll) return c.notFound();
  const f = await form(c.req);
  const o = str(f.o, 40);
  const subId = c.get('reader')?.subscriber?.id || null;
  if (subId) await castVote(c, poll, o, subId, 'web', str(f.post, 40) || null);
  else if (!getCookie(c, 'oh_pv_' + poll.id) && (await castVote(c, poll, o, null, 'web', str(f.post, 40) || null))) setCookie(c, 'oh_pv_' + poll.id, o, { path: '/', maxAge: 365 * 86400, sameSite: 'Lax' });
  const ref = c.req.header('referer');
  if ((c.req.header('accept') || '').includes('json')) return c.json({ ok: true });
  // Trivia always goes to the result page so the reader sees whether they were right.
  return c.redirect(ref && ref.includes('/p/') && poll.kind !== 'trivia' ? ref : `${siteUrl(c.env, pub)}/poll/${poll.id}?voted=${encodeURIComponent(o)}`, 303);
});

// ───── surveys ─────
export const SurveyForm = (p: { c: Ctx; survey: any; next?: string; skip?: string; delivery?: string | null; error?: string; values?: Record<string, any>; askEmail?: boolean }) => {
  const qs = parseJSON<SurveyQ[]>(p.survey.questions, []);
  const base = siteUrl(p.c.env, p.c.get('pub'));
  const v = p.values || {};
  return (
    <form method="post" action={`${base}/survey/${p.survey.id}`} class="s-stack">
      {p.survey.description && <p class="s-muted">{p.survey.description}</p>}
      {p.error && <div class="s-flash s-flash-err" style="margin:0">{p.error}</div>}
      {p.next && <input type="hidden" name="next" value={p.next} />}
      {p.delivery && <input type="hidden" name="d" value={p.delivery} />}
      {p.askEmail && <label class="s-field"><span>Your email (optional)</span><input class="s-input" type="email" name="email" value={v.email || ''} style="width:100%" /></label>}
      {qs.map((q) => {
        const name = `q_${q.id}`;
        const val = v[name];
        const label = <span>{q.label}{q.required ? ' *' : ''}</span>;
        switch (q.kind) {
          case 'long': return <label class="s-field">{label}<textarea class="s-input" name={name} rows={4} required={q.required} style="width:100%;height:auto;padding:10px">{val || ''}</textarea></label>;
          case 'single': return <fieldset class="s-field">{label}{(q.options || []).map((o) => <label style="display:block;margin:4px 0"><input type="radio" name={name} value={o} checked={val === o} required={q.required} /> {o}</label>)}</fieldset>;
          case 'multi': return <fieldset class="s-field">{label}{(q.options || []).map((o) => <label style="display:block;margin:4px 0"><input type="checkbox" name={`${name}[]`} value={o} checked={Array.isArray(val) && val.includes(o)} /> {o}</label>)}</fieldset>;
          case 'dropdown': return <label class="s-field">{label}<select class="s-input" name={name} required={q.required} style="width:100%"><option value="">Choose…</option>{(q.options || []).map((o) => <option selected={val === o}>{o}</option>)}</select></label>;
          case 'rating': return <fieldset class="s-field">{label}<div style="display:flex;gap:6px">{[1, 2, 3, 4, 5].map((n) => <label class="s-box" style="padding:6px 12px;cursor:pointer"><input type="radio" name={name} value={String(n)} checked={val === String(n)} required={q.required} /> {'★'.repeat(n)}</label>)}</div></fieldset>;
          case 'nps': return <fieldset class="s-field">{label}<div style="display:flex;gap:4px;flex-wrap:wrap">{Array.from({ length: 11 }, (_, n) => <label class="s-box" style="padding:6px 10px;cursor:pointer"><input type="radio" name={name} value={String(n)} checked={val === String(n)} required={q.required} /> {n}</label>)}</div><span class="s-muted s-small">0 = not at all likely · 10 = extremely likely</span></fieldset>;
          case 'date': return <label class="s-field">{label}<input class="s-input" type="date" name={name} value={val || ''} required={q.required} style="width:100%" /></label>;
          default: return <label class="s-field">{label}<input class="s-input" type="text" name={name} value={val || ''} required={q.required} style="width:100%" /></label>;
        }
      })}
      <div style="display:flex;gap:10px"><button class="s-btn">Submit</button>{p.skip && <a class="s-btn s-btn-ghost" href={p.skip}>Skip</a>}</div>
    </form>
  );
};

async function surveyIdentity(c: Ctx, delivery?: string | null, email?: string | null): Promise<string | null> {
  const pub = c.get('pub');
  const reader = c.get('reader');
  if (reader?.subscriber) return reader.subscriber.id;
  const w = await welcomeState(c);
  if (w) return w.sub.id;
  if (delivery) {
    const d = await one<any>(c.env, 'SELECT subscriber_id FROM deliveries WHERE id = ? AND pub_id = ?', delivery, pub.id);
    if (d?.subscriber_id) return d.subscriber_id;
  }
  if (email) return (await one<any>(c.env, 'SELECT id FROM subscribers WHERE pub_id = ? AND email = ?', pub.id, email.toLowerCase().trim()))?.id || null;
  return null;
}

site.get('/survey/:id', async (c) => {
  const pub = c.get('pub');
  const survey = await one<any>(c.env, 'SELECT * FROM surveys WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
  if (!survey) return SiteMessage(c, 'Survey not found', <p>This survey does not exist.</p>, 404);
  if (survey.status !== 'active') return SiteMessage(c, survey.title, <p class="s-muted">This survey is closed. Thanks for your interest!</p>);
  await trackView(c, survey.id);
  const d = c.req.query('d') || null;
  const who = await surveyIdentity(c, d);
  return c.html(await SiteLayout({ c, title: survey.title, noindex: true, children: <section class="s-wrap s-narrow s-section"><h1>{survey.title}</h1><SurveyForm c={c} survey={survey} delivery={d} askEmail={!who} /></section> }));
});

site.post('/survey/:id', async (c) => {
  const pub = c.get('pub');
  const survey = await one<any>(c.env, 'SELECT * FROM surveys WHERE id = ? AND pub_id = ?', c.req.param('id'), pub.id);
  if (!survey || survey.status !== 'active') return c.notFound();
  const f = await form(c.req);
  const qs = parseJSON<SurveyQ[]>(survey.questions, []);
  const answers: Record<string, unknown> = {};
  for (const q of qs) {
    const raw = q.kind === 'multi' ? f[`q_${q.id}`] : f[`q_${q.id}`];
    const val = Array.isArray(raw) ? raw.map((x) => str(x, 500)).filter(Boolean) : str(raw, 5000);
    if (q.required && (!val || (Array.isArray(val) && !val.length))) {
      const next = str(f.next, 200);
      return c.html(await SiteLayout({ c, title: survey.title, noindex: true, children: <section class="s-wrap s-narrow s-section"><h1>{survey.title}</h1><SurveyForm c={c} survey={survey} next={next || undefined} delivery={str(f.d, 40) || null} error={`Please answer: ${q.label}`} values={f} askEmail={!!f.email} /></section> }), 400);
    }
    if (val && (!Array.isArray(val) || val.length)) answers[q.id] = val;
  }
  const subId = await surveyIdentity(c, str(f.d, 40) || null, str(f.email, 254) || null);
  if (subId) {
    const dup = await one(c.env, 'SELECT 1 FROM survey_responses WHERE survey_id = ? AND subscriber_id = ? AND created_at > ?', survey.id, subId, now() - 60_000);
    if (dup) return SiteMessage(c, 'Thank you!', <p>{survey.thank_you}</p>);
  }
  const rid = id();
  await insert(c.env, 'survey_responses', { id: rid, survey_id: survey.id, pub_id: pub.id, subscriber_id: subId, answers: JSON.stringify(answers), created_at: now() });
  await emit(c.env, { pubId: pub.id, type: 'survey.response_submitted', subscriberId: subId, refId: survey.id, data: { survey_id: survey.id, survey_title: survey.title, response_id: rid, answers } });
  const next = str(f.next, 200);
  if (next.startsWith('/')) return c.redirect(siteUrl(c.env, pub) + next, 303);
  return SiteMessage(c, 'Thank you!', <><p>{survey.thank_you}</p><p><a href={siteUrl(c.env, pub) + '/'}>← Back to {pub.name}</a></p></>);
});

export default site;
export { esc };
