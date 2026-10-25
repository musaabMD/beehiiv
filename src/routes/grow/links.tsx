/** @jsxImportSource hono/jsx */
// Magic links: one-click subscribe links (/r/:code?email=…) with UTM passthrough, rate limiting, bot checks,
// a confirmation step only for suspicious clicks, double opt-in respected, and redirect after subscribing.
import type { App, Ctx } from '../../types';
import { all, one, run, insert } from '../../lib/db';
import { requirePerm, audit } from '../../lib/auth';
import { subscribe } from '../../lib/subscribers';
import { rateLimit, clientIP, botScore, validateEmail } from '../../lib/guard';
import { siteUrl } from '../../lib/pub';
import { DashLayout } from '../../ui/layout';
import { SiteLayout, SiteMessage } from '../../ui/site';
import { Card, Table, Btn, Field, Input, Select, Modal, OpenBtn, ActionForm, Empty, back, Help, Copy, Grid, Stats, Stat, Check } from '../../ui/components';
import { id, now, form, str, num, pct, ago, parseJSON, esc } from '../../lib/util';

interface LinkCfg { name: string; utm_source?: string; utm_medium?: string; utm_campaign?: string; tags?: string[]; redirect?: string; redirect_url?: string; post_slug?: string; list_ids?: string[] }

const MERGE_TAGS: Array<[string, string]> = [
  ['OpenHive / beehiiv / ConvertKit (Kit)', '{{email}}'],
  ['Mailchimp', '*|EMAIL|*'],
  ['Substack / Liquid-style', '{{ subscriber.email }}'],
  ['Kit (Liquid)', '{{ subscriber.email_address }}'],
  ['ActiveCampaign', '%EMAIL%'],
];

export function linkUrl(base: string, code: string) {
  return `${base}/r/${code}`;
}

function redirectTarget(base: string, cfg: LinkCfg): string {
  if (cfg.redirect === 'custom' && cfg.redirect_url && /^https?:\/\//.test(cfg.redirect_url)) return cfg.redirect_url;
  if (cfg.redirect === 'post' && cfg.post_slug) return `${base}/p/${cfg.post_slug}`;
  if (cfg.redirect === 'recommendations') return `${base}/recommendations`;
  return `${base}/`;
}

export function registerLinks(dash: App, site: App) {
  dash.get('/links', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const base = siteUrl(c.env, pub);
    const links = await all<any>(c.env, `SELECT l.*, (SELECT COUNT(*) FROM subscribers s WHERE s.pub_id = l.pub_id AND s.source = 'magic_link' AND s.source_detail = l.id) AS subs FROM links l WHERE l.pub_id = ? AND l.kind = 'magic_subscribe' ORDER BY l.created_at DESC`, pub.id);
    const posts = await all<any>(c.env, `SELECT slug, title FROM posts WHERE pub_id = ? AND status = 'published' ORDER BY published_at DESC LIMIT 50`, pub.id);
    const lists = await all<any>(c.env, 'SELECT id, name FROM lists WHERE pub_id = ? ORDER BY name', pub.id);
    const clicks = links.reduce((n, l) => n + l.clicks, 0), signups = links.reduce((n, l) => n + l.signups, 0);
    return c.html(
      <DashLayout c={c} title="Magic links" section="grow" sub="links" actions={<OpenBtn target="#new-link">+ New magic link</OpenBtn>}>
        <Help>Magic links subscribe readers in one click — no form. Drop them into other newsletters (with the email merge tag), socials or ads. UTM parameters are carried through to every subscriber, and magic links show up as a filterable acquisition source in Audience → Segments.</Help>
        <Stats>
          <Stat label="Links" value={num(links.length)} />
          <Stat label="Clicks" value={num(clicks)} />
          <Stat label="New subscribers" value={num(signups)} />
          <Stat label="Conversion" value={pct(signups, clicks)} />
        </Stats>
        <Card pad={false}>
          <Table rows={links} rowHref={(l) => `/app/grow/links/${l.id}`} empty={<Empty title="No magic links yet" body="Create a link to grow from partner newsletters, social bios and ads." action={<OpenBtn target="#new-link">Create magic link</OpenBtn>} />} cols={[
            { h: 'Name', r: (l) => <a href={`/app/grow/links/${l.id}`}>{parseJSON<LinkCfg>(l.config, { name: '' }).name || l.code}</a> },
            { h: 'Link', r: (l) => <code class="small">{linkUrl(base, l.code)}</code> },
            { h: 'Clicks', class: 'right', r: (l) => num(l.clicks) },
            { h: 'Subscribers', class: 'right', r: (l) => num(l.subs) },
            { h: 'Created', r: (l) => ago(l.created_at) },
          ]} />
        </Card>
        <Modal id="new-link" title="New magic link" wide>
          <form method="post" action="/app/grow/links"><LinkForm posts={posts} lists={lists} /><div class="form-actions"><Btn>Create link</Btn></div></form>
        </Modal>
      </DashLayout>,
    );
  });

  dash.post('/links', requirePerm('manage'), async (c) => {
    const f = await form(c.req);
    const cfg = cfgFromForm(f);
    if (!cfg.name) return back(c, '/app/grow/links', 'Give the link a name', 'err');
    const lid = id(), code = id(8);
    await insert(c.env, 'links', { id: lid, pub_id: c.get('pub').id, code, url: '', kind: 'magic_subscribe', config: JSON.stringify(cfg), created_at: now() });
    await audit(c, 'magic_link.create', lid);
    return back(c, `/app/grow/links/${lid}`, 'Magic link created');
  });

  dash.get('/links/:id', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const l = await one<any>(c.env, `SELECT * FROM links WHERE id = ? AND pub_id = ? AND kind = 'magic_subscribe'`, c.req.param('id'), pub.id);
    if (!l) return c.notFound();
    const cfg = parseJSON<LinkCfg>(l.config, { name: '' });
    const base = siteUrl(c.env, pub);
    const url = linkUrl(base, l.code);
    const posts = await all<any>(c.env, `SELECT slug, title FROM posts WHERE pub_id = ? AND status = 'published' ORDER BY published_at DESC LIMIT 50`, pub.id);
    const lists = await all<any>(c.env, 'SELECT id, name FROM lists WHERE pub_id = ? ORDER BY name', pub.id);
    const subs = await all<any>(c.env, `SELECT id, email, name, status, utm_source, created_at FROM subscribers WHERE pub_id = ? AND source = 'magic_link' AND source_detail = ? ORDER BY created_at DESC LIMIT 50`, pub.id, l.id);
    const social = (src: string) => `${url}?utm_source=${src}&utm_medium=social`;
    return c.html(
      <DashLayout c={c} title={cfg.name || 'Magic link'} section="grow" sub="links" crumbs={[['/app/grow/links', 'Magic links']]} actions={<ActionForm action={`/app/grow/links/${l.id}/delete`} label="Delete" kind="danger" confirm="Delete this link? Existing links will stop working." small={false} />}>
        <Stats>
          <Stat label="Clicks" value={num(l.clicks)} />
          <Stat label="New subscribers" value={num(l.signups)} />
          <Stat label="Conversion" value={pct(l.signups, l.clicks)} />
        </Stats>
        <div class="split">
          <div>
            <Card title="Share this link">
              <Field label="For other newsletters (one-click, email pre-filled)" hint="Paste the version that matches the sender's platform; their merge tag inserts each reader's email.">
                <div class="stack-sm">{MERGE_TAGS.map(([name, tag]) => <div><small class="muted">{name}</small><Copy value={`${url}?email=${tag}&utm_source=newsletter&utm_medium=email`} /></div>)}</div>
              </Field>
              <Field label="For social bios and posts (shows a one-field form)">
                <div class="stack-sm">
                  <div><small class="muted">Instagram</small><Copy value={social('instagram')} /></div>
                  <div><small class="muted">TikTok</small><Copy value={social('tiktok')} /></div>
                  <div><small class="muted">X</small><Copy value={social('x')} /></div>
                  <div><small class="muted">LinkedIn</small><Copy value={social('linkedin')} /></div>
                </div>
              </Field>
              <Field label="For ads"><Copy value={`${url}?utm_source=ads&utm_medium=cpc&utm_campaign=${encodeURIComponent(cfg.utm_campaign || 'campaign')}`} /></Field>
            </Card>
            <Card title="Subscribers from this link" pad={false}>
              <Table rows={subs} empty="No subscribers yet." cols={[
                { h: 'Subscriber', r: (s) => <a href={`/app/audience/subscribers/${s.id}`}>{s.name || s.email}</a> },
                { h: 'Status', r: (s) => s.status },
                { h: 'UTM source', r: (s) => s.utm_source || '—' },
                { h: 'Joined', r: (s) => ago(s.created_at) },
              ]} />
            </Card>
          </div>
          <Card title="Settings">
            <form method="post" action={`/app/grow/links/${l.id}`}><LinkForm cfg={cfg} posts={posts} lists={lists} /><div class="form-actions"><Btn>Save</Btn></div></form>
          </Card>
        </div>
      </DashLayout>,
    );
  });

  dash.post('/links/:id', requirePerm('manage'), async (c) => {
    const cfg = cfgFromForm(await form(c.req));
    await run(c.env, `UPDATE links SET config = ? WHERE id = ? AND pub_id = ? AND kind = 'magic_subscribe'`, JSON.stringify(cfg), c.req.param('id'), c.get('pub').id);
    return back(c, `/app/grow/links/${c.req.param('id')}`, 'Saved');
  });
  dash.post('/links/:id/delete', requirePerm('manage'), async (c) => {
    await run(c.env, `DELETE FROM links WHERE id = ? AND pub_id = ? AND kind = 'magic_subscribe'`, c.req.param('id'), c.get('pub').id);
    return back(c, '/app/grow/links', 'Link deleted');
  });

  // ── Public magic link
  async function loadLink(c: Ctx) {
    return one<any>(c.env, `SELECT * FROM links WHERE code = ? AND pub_id = ? AND kind = 'magic_subscribe'`, c.req.param('code'), c.get('pub').id);
  }

  async function doSubscribe(c: Ctx, l: any, email: string, extraUtm: Record<string, string>) {
    const pub = c.get('pub');
    const base = siteUrl(c.env, pub);
    const cfg = parseJSON<LinkCfg>(l.config, { name: '' });
    const r = await subscribe(c.env, pub, {
      email, source: 'magic_link', sourceDetail: l.id, tags: cfg.tags, listIds: cfg.list_ids?.length ? cfg.list_ids : undefined,
      utm: { source: extraUtm.utm_source || cfg.utm_source, medium: extraUtm.utm_medium || cfg.utm_medium, campaign: extraUtm.utm_campaign || cfg.utm_campaign, term: extraUtm.utm_term, content: extraUtm.utm_content },
      ip: clientIP(c.req.raw), country: (c.req.raw as any).cf?.country ?? null, referrer: c.req.header('referer') || null, landingPath: `/r/${l.code}`,
    });
    if (!r.ok) return SiteMessage(c, "We couldn't subscribe you", <><p>{r.error}</p>{r.suggestion && <p>Did you mean <a href={`${base}/r/${l.code}?email=${encodeURIComponent(r.suggestion)}`}>{r.suggestion}</a>?</p>}<EmailForm action={`${base}/r/${l.code}`} /></>, 400);
    if (r.created) await run(c.env, 'UPDATE links SET signups = signups + 1 WHERE id = ?', l.id);
    if (r.pending) return SiteMessage(c, 'Check your inbox', <p>We sent a confirmation link to <strong>{email}</strong>. Click it to finish subscribing to {pub.name}.</p>);
    const target = redirectTarget(base, cfg);
    return c.redirect(target + (target.includes('?') ? '&' : '?') + 'subscribed=1', 303);
  }

  const EmailForm = (p: { action: string; email?: string; confirm?: boolean; utm?: Record<string, string> }) => (
    <form method="post" action={p.action} class="s-form" style="max-width:440px;margin:16px auto 0;justify-content:center">
      {p.confirm ? <input type="hidden" name="email" value={p.email} /> : <input type="email" name="email" value={p.email || ''} placeholder="you@example.com" required autocomplete="email" />}
      <input type="text" name="website" class="s-hp" tabindex={-1} autocomplete="off" />
      <input type="hidden" name="_t" value={String(Date.now())} />
      {Object.entries(p.utm || {}).map(([k, v]) => <input type="hidden" name={k} value={v} />)}
      <button class="s-btn">{p.confirm ? 'Click to confirm subscription' : 'Subscribe'}</button>
    </form>
  );

  const utmOf = (q: Record<string, string>) => Object.fromEntries(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].filter((k) => q[k]).map((k) => [k, String(q[k]).slice(0, 100)]));

  site.get('/r/:code', async (c) => {
    const pub = c.get('pub');
    const base = siteUrl(c.env, pub);
    const l = await loadLink(c);
    if (!l) return SiteMessage(c, 'Link not found', <p>This subscribe link is no longer active. <a href={base + '/'}>Visit {pub.name}</a></p>, 404);
    const ip = clientIP(c.req.raw);
    if (!(await rateLimit(c.env, `ml:${ip}`, 30, 60))) return SiteMessage(c, 'Too many requests', <p>Please wait a minute and try again.</p>, 429);
    // prefetches / link scanners never count as clicks or subscribe anyone
    const purpose = (c.req.header('sec-purpose') || c.req.header('purpose') || '').toLowerCase();
    if (!purpose.includes('prefetch')) await run(c.env, 'UPDATE links SET clicks = clicks + 1 WHERE id = ?', l.id);
    const q = c.req.query();
    const utm = utmOf(q);
    const rawEmail = str(q.email, 254);
    const looksLikeTag = /[{}|%*]/.test(rawEmail);
    if (!rawEmail || looksLikeTag) {
      return c.html(await SiteLayout({ c, title: `Subscribe to ${pub.name}`, children: (
        <section class="s-hero"><div class="s-wrap"><h1>{pub.name}</h1><p>{pub.description}</p><EmailForm action={`${base}/r/${l.code}`} utm={utm} /></div></section>
      ) }));
    }
    const v = await validateEmail(rawEmail);
    if (!v.ok) return SiteMessage(c, 'Check your email address', <><p>{v.reason}</p><EmailForm action={`${base}/r/${l.code}`} utm={utm} /></>, 400);
    let score = botScore({ ua: c.req.header('user-agent'), renderedAt: Date.now() - 5000 });
    if (purpose.includes('prefetch')) score += 60;
    if (!(c.req.header('accept') || '').includes('text/html')) score += 20;
    if (!c.req.header('accept-language')) score += 15;
    if (score >= 30) {
      // looks automated (security scanner, prefetcher, bot): require a human click
      return c.html(await SiteLayout({ c, title: `Subscribe to ${pub.name}`, noindex: true, children: (
        <section class="s-hero"><div class="s-wrap"><h1>Subscribe to {pub.name}?</h1><p>Confirm to subscribe <strong>{v.email}</strong>.</p><EmailForm action={`${base}/r/${l.code}`} email={v.email} confirm utm={utm} /></div></section>
      ) }));
    }
    return doSubscribe(c, l, v.email, utm);
  });

  site.post('/r/:code', async (c) => {
    const pub = c.get('pub');
    const l = await loadLink(c);
    if (!l) return SiteMessage(c, 'Link not found', <p>This subscribe link is no longer active.</p>, 404);
    const ip = clientIP(c.req.raw);
    if (!(await rateLimit(c.env, `mlp:${ip}`, 10, 600))) return SiteMessage(c, 'Too many requests', <p>Please wait a few minutes and try again.</p>, 429);
    const f = await form(c.req);
    if (botScore({ honeypot: f.website, renderedAt: f._t, ua: c.req.header('user-agent') }) >= 60) return SiteMessage(c, 'Something went wrong', <p>We couldn't verify this request. Please try again.</p>, 400);
    return doSubscribe(c, l, str(f.email, 254), utmOf(f));
  });
}

function cfgFromForm(f: Record<string, any>): LinkCfg {
  return {
    name: str(f.name, 120), utm_source: str(f.utm_source, 100) || undefined, utm_medium: str(f.utm_medium, 100) || undefined, utm_campaign: str(f.utm_campaign, 100) || undefined,
    tags: str(f.tags, 300).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
    redirect: ['home', 'post', 'custom', 'recommendations'].includes(f.redirect) ? f.redirect : 'home', redirect_url: str(f.redirect_url, 500) || undefined, post_slug: str(f.post_slug, 200) || undefined,
    list_ids: f.list_ids || [],
  };
}

function LinkForm(p: { cfg?: LinkCfg; posts: any[]; lists: any[] }) {
  const cfg = p.cfg || { name: '' };
  return (
    <>
      <Field label="Name" hint="Internal, e.g. “Swap with The Morning Brief”"><Input name="name" value={cfg.name} required /></Field>
      <Grid cols={3}>
        <Field label="UTM source"><Input name="utm_source" value={cfg.utm_source} placeholder="partner-newsletter" /></Field>
        <Field label="UTM medium"><Input name="utm_medium" value={cfg.utm_medium} placeholder="email" /></Field>
        <Field label="UTM campaign"><Input name="utm_campaign" value={cfg.utm_campaign} placeholder="spring-swap" /></Field>
      </Grid>
      <Field label="Tags to add" hint="Comma separated"><Input name="tags" value={(cfg.tags || []).join(', ')} /></Field>
      {p.lists.length > 0 && <Field label="Newsletter lists">{p.lists.map((l) => <Check name="list_ids[]" value={l.id} checked={(cfg.list_ids || []).includes(l.id)} label={l.name} />)}</Field>}
      <Grid cols={2}>
        <Field label="After subscribing, send readers to"><Select name="redirect" value={cfg.redirect || 'home'} options={[['home', 'Website home'], ['post', 'A specific post'], ['recommendations', 'Recommended newsletters'], ['custom', 'Custom URL']]} /></Field>
        <Field label="Post (if chosen)"><Select name="post_slug" value={cfg.post_slug || ''} options={[['', '—'], ...p.posts.map((x) => [x.slug, x.title || x.slug] as [string, string])]} /></Field>
      </Grid>
      <Field label="Custom redirect URL (if chosen)"><Input name="redirect_url" value={cfg.redirect_url} placeholder="https://…" /></Field>
      <Help>Double opt-in is respected: if it's on in Settings, magic-link subscribers get a confirmation email first.</Help>
    </>
  );
}

