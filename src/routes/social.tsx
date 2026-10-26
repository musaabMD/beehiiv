/** @jsxImportSource hono/jsx */
// Module: social — connect Bluesky + Mastodon, compose (text, link, image, AI helper), post now or schedule,
// auto-share newsletter posts on publish, history with live links. LinkedIn/X/Threads/Facebook are share intents.
import { Hono } from 'hono';
import type { Child } from 'hono/jsx';
import { raw } from 'hono/html';
import type { AppEnv, Ctx, Module } from '../types';
import { one, all, run, insert } from '../lib/db';
import { requirePerm, audit, can, secretsConfigured } from '../lib/auth';
import { kick } from '../lib/jobs';
import { siteUrl } from '../lib/pub';
import { storeFile, } from '../lib/media';
import { mediaUrl, aiEnabled } from '../lib/ai';
import {
  API_NETWORKS, INTENT_NETWORKS, connectBluesky, connectMastodon, createSocialPost, validateText, suggestSocialText,
  defaultShareText, mediaKeyFromUrl, SocialError, type SocialAccount, type ApiNetwork,
} from '../lib/social';
import { id, now, form, str, bool, ago, fmtDateTime, truncate } from '../lib/util';
import { DashLayout } from '../ui/layout';
import { Card, Field, Input, Textarea, Select, Toggle, Btn, ActionForm, Table, Badge, Status, Empty, Modal, OpenBtn, Grid, Help, LinkBtn, Json, back } from '../ui/components';

const dash = new Hono<AppEnv>();

function page(c: Ctx, title: string, body: Child, actions?: Child, crumbs?: Array<[string, string]>) {
  return c.html(<DashLayout c={c} title={title} section="marketing" sub="social" actions={actions} crumbs={crumbs}>{body}</DashLayout>);
}

const NET_LABEL = (n: string) => (API_NETWORKS as any)[n]?.label || (INTENT_NETWORKS as any)[n]?.label || n;

// ───────── overview: accounts + history ─────────
dash.get('/', requirePerm('manage'), async (c) => {
  const pub = c.get('pub');
  const accounts = await all<SocialAccount>(c.env, 'SELECT * FROM social_accounts WHERE pub_id = ? ORDER BY created_at', pub.id);
  const status = str(c.req.query('status'), 20);
  const rows = await all<any>(c.env, `SELECT sp.*, a.handle, p.title AS post_title, cm.name AS campaign_name FROM social_posts sp LEFT JOIN social_accounts a ON a.id = sp.account_id LEFT JOIN posts p ON p.id = sp.post_id LEFT JOIN campaigns cm ON cm.id = sp.campaign_id WHERE sp.pub_id = ? ${status ? 'AND sp.status = ?' : ''} ORDER BY COALESCE(sp.posted_at, sp.scheduled_at, sp.created_at) DESC LIMIT 200`, pub.id, ...(status ? [status] : []));
  const admin = can(c.get('role'), 'admin');
  const secretsOk = secretsConfigured(c.env);
  return page(c, 'Social posts', (
    <>
      {!secretsOk && <div class="callout warn" data-secrets-missing><strong>APP_SECRET is not set.</strong> Social credentials are encrypted at rest with a key derived from it. Run <code>npx wrangler secret put APP_SECRET</code> before connecting accounts.</div>}
      <Card title="Connected accounts" actions={admin ? <div class="row"><OpenBtn target="#connect-bluesky" small kind="secondary">+ Bluesky</OpenBtn><OpenBtn target="#connect-mastodon" small kind="secondary">+ Mastodon</OpenBtn></div> : undefined}>
        {accounts.length ? (
          <Table<SocialAccount> rows={accounts} cols={[
            { h: 'Account', r: (a) => <><Badge tone={a.network === 'bluesky' ? 'blue' : 'purple'}>{NET_LABEL(a.network)}</Badge> <strong>{a.profile_url ? <a href={a.profile_url} target="_blank" rel="noopener">{a.handle}</a> : a.handle}</strong>{a.display_name && a.display_name !== a.handle.replace(/^@/, '') && <div class="small muted">{a.display_name}</div>}</> },
            { h: 'Status', r: (a) => <>{a.status === 'error' ? <Badge tone="red">needs attention</Badge> : <Badge tone="green">connected</Badge>}{a.last_error && <div class="small muted truncate" title={a.last_error}>{a.last_error}</div>}</> },
            { h: 'Auto-share new posts', r: (a) => admin ? <form method="post" action={`/app/social/accounts/${a.id}/auto`} class="inline-form"><input type="hidden" name="on" value={a.auto_share ? '0' : '1'} /><button class={`btn btn-sm ${a.auto_share ? 'btn-primary' : 'btn-secondary'}`} data-auto-share={a.auto_share ? 'on' : 'off'}>{a.auto_share ? 'On' : 'Off'}</button></form> : (a.auto_share ? 'On' : 'Off') },
            { h: '', class: 'right', r: (a) => admin ? <ActionForm action={`/app/social/accounts/${a.id}/delete`} label="Disconnect" kind="danger" confirm={`Disconnect ${a.handle}? Scheduled posts for it are cancelled.`} /> : null },
          ]} />
        ) : <Empty icon="↗" title="No accounts connected" body="Connect Bluesky with an app password or Mastodon with an access token to post and schedule from here, and to auto-share every issue when it's published." />}
        <Help>Auto-share posts the issue title and link (with its thumbnail) to that account when a newsletter post is published. Credentials are encrypted at rest (AES-256-GCM).</Help>
      </Card>
      <Card title="LinkedIn, X, Threads & Facebook">
        <p class="muted">These networks only allow automated posting for apps that pass their review or pay for API access, so they work as <strong>share links</strong>: the composer opens each network's own share window with your text and link filled in, and you click post there. Nothing is posted on your behalf.</p>
        <ul class="small muted">{Object.values(INTENT_NETWORKS).map((n) => <li><strong>{n.label}:</strong> {n.why}</li>)}</ul>
      </Card>
      <Card title="History" pad={false} actions={<form method="get" class="row"><Select name="status" value={status} autosubmit options={[['', 'All statuses'], ['scheduled', 'Scheduled'], ['posted', 'Posted'], ['failed', 'Failed'], ['cancelled', 'Cancelled']]} /></form>}>
        <Table<any> rows={rows} empty={<div style="padding:18px" class="muted">Nothing posted yet.</div>} cols={[
          { h: 'Post', r: (p) => <><div class="truncate" title={p.text}>{p.text || <em class="muted">(link only)</em>}</div><div class="small muted">{NET_LABEL(p.network)} · {p.handle || 'removed account'}{p.post_title ? ` · shares “${truncate(p.post_title, 40)}”` : ''}{p.campaign_name ? ` · campaign ${p.campaign_name}` : ''}</div></> },
          { h: 'Status', r: (p) => <><Status s={p.status} />{p.error && <div class="small muted truncate" title={p.error} data-social-error>{p.error}</div>}</> },
          { h: 'When', r: (p) => <span class="small nowrap">{p.posted_at ? fmtDateTime(p.posted_at, pub.timezone) : p.scheduled_at ? `⏰ ${fmtDateTime(p.scheduled_at, pub.timezone)}` : '—'}</span> },
          { h: 'Live post', r: (p) => p.remote_url ? <a href={p.remote_url} target="_blank" rel="noopener" data-live-url>View ↗</a> : <span class="muted">—</span> },
          { h: '', class: 'right', r: (p) => (
            <div class="row end">
              {p.status === 'scheduled' && <ActionForm action={`/app/social/posts/${p.id}/now`} label="Post now" />}
              {p.status === 'scheduled' && <ActionForm action={`/app/social/posts/${p.id}/cancel`} label="Cancel" kind="danger" />}
              {p.status === 'failed' && <ActionForm action={`/app/social/posts/${p.id}/now`} label="Retry" />}
            </div>
          ) },
        ]} />
      </Card>

      <Modal id="connect-bluesky" title="Connect Bluesky">
        <form method="post" action="/app/social/accounts/bluesky" class="stack">
          <Field label="Handle or email"><Input name="identifier" placeholder="you.bsky.social" required /></Field>
          <Field label="App password" hint={<>Create one at Bluesky → Settings → Privacy and security → <a href="https://bsky.app/settings/app-passwords" target="_blank" rel="noopener">App passwords</a>. Never use your main password.</>}><Input name="app_password" type="password" required attrs={{ autocomplete: 'off', placeholder: 'xxxx-xxxx-xxxx-xxxx' }} /></Field>
          <Field label="Hosting provider (PDS)" hint="Leave as is unless you self-host your Bluesky account."><Input name="service" value="https://bsky.social" /></Field>
          <Toggle name="auto_share" label="Auto-share new newsletter posts" />
          <Btn>Connect</Btn>
        </form>
      </Modal>
      <Modal id="connect-mastodon" title="Connect Mastodon">
        <form method="post" action="/app/social/accounts/mastodon" class="stack">
          <Field label="Instance URL"><Input name="instance" placeholder="https://mastodon.social" required /></Field>
          <Field label="Access token" hint={<>On your instance: Preferences → Development → New application, with scopes <code>read:accounts write:statuses write:media</code>. Copy “Your access token”.</>}><Input name="token" type="password" required attrs={{ autocomplete: 'off' }} /></Field>
          <Toggle name="auto_share" label="Auto-share new newsletter posts" />
          <Btn>Connect</Btn>
        </form>
      </Modal>
    </>
  ), <LinkBtn href="/app/social/new" kind="primary" small>+ New social post</LinkBtn>);
});

// ───────── accounts ─────────
async function saveAccount(c: Ctx, data: Awaited<ReturnType<typeof connectBluesky>> | Awaited<ReturnType<typeof connectMastodon>>, autoShare: boolean) {
  const pub = c.get('pub');
  const t = now();
  const existing = await one<{ id: string }>(c.env, 'SELECT id FROM social_accounts WHERE pub_id = ? AND network = ? AND remote_id = ? AND service_url = ?', pub.id, data.network, data.remote_id, data.service_url);
  if (existing) {
    await run(c.env, `UPDATE social_accounts SET handle = ?, display_name = ?, profile_url = ?, credentials = ?, auto_share = ?, status = 'active', last_error = NULL, updated_at = ? WHERE id = ?`, data.handle, data.display_name, data.profile_url, data.credentials, autoShare ? 1 : 0, t, existing.id);
  } else {
    await insert(c.env, 'social_accounts', { id: id(), pub_id: pub.id, ...data, auto_share: autoShare ? 1 : 0, status: 'active', created_by: c.get('user').id, created_at: t, updated_at: t });
  }
  await audit(c, 'social.connect', data.handle, { network: data.network });
}

dash.post('/accounts/bluesky', requirePerm('admin'), async (c) => {
  const f = await form(c.req);
  try {
    const data = await connectBluesky(c.env, { service: str(f.service, 200), identifier: str(f.identifier, 200), appPassword: str(f.app_password, 200) });
    await saveAccount(c, data, bool(f.auto_share));
    return back(c, '/app/social', `Connected ${data.handle} on Bluesky`);
  } catch (e: any) {
    return back(c, '/app/social', `Couldn't connect Bluesky: ${e?.message || e}`, 'err');
  }
});

dash.post('/accounts/mastodon', requirePerm('admin'), async (c) => {
  const f = await form(c.req);
  try {
    const data = await connectMastodon(c.env, { instance: str(f.instance, 200), token: str(f.token, 400) });
    await saveAccount(c, data, bool(f.auto_share));
    return back(c, '/app/social', `Connected ${data.handle} on Mastodon`);
  } catch (e: any) {
    return back(c, '/app/social', `Couldn't connect Mastodon: ${e?.message || e}`, 'err');
  }
});

dash.post('/accounts/:id/auto', requirePerm('admin'), async (c) => {
  const f = await form(c.req);
  const on = f.on === '1';
  await run(c.env, 'UPDATE social_accounts SET auto_share = ?, updated_at = ? WHERE id = ? AND pub_id = ?', on ? 1 : 0, now(), c.req.param('id'), c.get('pub').id);
  return back(c, '/app/social', on ? 'Auto-share on: new posts are shared when published' : 'Auto-share off');
});

dash.post('/accounts/:id/delete', requirePerm('admin'), async (c) => {
  const pub = c.get('pub');
  const aid = c.req.param('id');
  await run(c.env, `UPDATE social_posts SET status = 'cancelled', updated_at = ? WHERE account_id = ? AND pub_id = ? AND status = 'scheduled'`, now(), aid, pub.id);
  await run(c.env, 'DELETE FROM social_accounts WHERE id = ? AND pub_id = ?', aid, pub.id);
  await audit(c, 'social.disconnect', aid);
  return back(c, '/app/social', 'Account disconnected; its credentials were deleted');
});

// ───────── composer ─────────
dash.get('/new', requirePerm('publish'), async (c) => {
  const pub = c.get('pub');
  const accounts = await all<SocialAccount>(c.env, `SELECT * FROM social_accounts WHERE pub_id = ? ORDER BY created_at`, pub.id);
  const posts = await all<any>(c.env, `SELECT id, title, subtitle, slug, status, thumbnail_url FROM posts WHERE pub_id = ? AND status IN ('published','scheduled','draft') ORDER BY COALESCE(published_at, scheduled_at, updated_at) DESC LIMIT 40`, pub.id);
  const images = await all<any>(c.env, `SELECT id, key, name, alt FROM uploads WHERE pub_id = ? AND mime LIKE 'image/%' ORDER BY created_at DESC LIMIT 24`, pub.id);
  const campaigns = await all<any>(c.env, `SELECT id, name FROM campaigns WHERE pub_id = ? AND status = 'active' ORDER BY created_at DESC`, pub.id);
  const pre = c.req.query('post') ? posts.find((p) => p.id === c.req.query('post')) : null;
  const surl = siteUrl(c.env, pub);
  const preLink = pre ? `${surl}/p/${pre.slug}` : '';
  const preImg = pre ? mediaKeyFromUrl(pre.thumbnail_url, pub.id) : null;
  return page(c, 'New social post', (
    <form method="post" action="/app/social/posts" enctype="multipart/form-data" class="split" id="sp-form">
      <div>
        <Card title="Post">
          <Field label="Newsletter issue (optional)" hint="Fills the link and image, and lets AI draft the text.">
            <Select name="post_id" id="sp-post" value={pre?.id || ''} options={[['', '— none —'], ...posts.map((p) => [p.id, `${p.title}${p.status !== 'published' ? ` (${p.status})` : ''}`] as [string, string])]} />
          </Field>
          <Field label={<span class="row between"><span>Text</span><span class="small muted" id="sp-count" /></span>}>
            <Textarea name="text" id="sp-text" rows={6} value={pre ? defaultShareText(pre) : ''} placeholder="What do you want to say?" />
          </Field>
          <div class="row" style="margin:-4px 0 12px">
            <button type="button" class="btn btn-secondary btn-sm" id="sp-ai" data-ai-enabled={aiEnabled(c.env) ? '1' : '0'}>✨ Write a post for this issue</button>
            <small class="muted" id="sp-ai-msg" />
          </div>
          <Field label="Link" hint="UTM tags (utm_source=<network>, utm_medium=social, utm_campaign=<campaign>) are added automatically."><Input name="link" id="sp-link" type="url" value={preLink} placeholder="https://" /></Field>
          <Field label="Image" hint="From your media library, or upload a new one. Bluesky images must be under 1 MB.">
            <div class="sp-images">
              <label class="sp-img none"><input type="radio" name="image_key" value="" checked={!preImg} /><span>No image</span></label>
              {preImg && !images.some((i) => i.key === preImg) && <label class="sp-img"><input type="radio" name="image_key" value={preImg} checked /><img src={mediaUrl(c.env, preImg)} alt="" loading="lazy" /></label>}
              {images.map((i) => <label class="sp-img" title={i.name}><input type="radio" name="image_key" value={i.key} checked={i.key === preImg} /><img src={mediaUrl(c.env, i.key)} alt={i.alt} loading="lazy" /></label>)}
            </div>
            <input type="file" name="image" accept="image/*" class="input" style="margin-top:8px" />
          </Field>
          <Field label="Image description (alt text)"><Input name="image_alt" value={pre?.title || ''} maxlength={1000} /></Field>
        </Card>
      </div>
      <div>
        <Card title="Post to">
          {accounts.length ? accounts.map((a) => (
            <label class="check"><input type="checkbox" name="accounts[]" value={a.id} checked data-net={a.network} /><span>{NET_LABEL(a.network)} · {a.handle}{a.status === 'error' && <Badge tone="red">error</Badge>}</span></label>
          )) : <p class="muted">No connected accounts. <a href="/app/social">Connect Bluesky or Mastodon</a>, or use the share links below.</p>}
          <hr />
          <Field label="When">
            <label class="check"><input type="radio" name="when" value="now" checked /><span>Post now</span></label>
            <label class="check"><input type="radio" name="when" value="schedule" /><span>Schedule</span></label>
            <input type="datetime-local" class="input" name="scheduled_local" data-utc="scheduled_at" />
            <small class="field-h">In your browser's time zone.</small>
          </Field>
          {campaigns.length > 0 && <Field label="Campaign"><Select name="campaign_id" value={c.req.query('campaign') || ''} options={[['', '— none —'], ...campaigns.map((x) => [x.id, x.name] as [string, string])]} /></Field>}
          <Btn>Post</Btn>
        </Card>
        <Card title="Share links (no API)">
          <p class="small muted">Opens each network's own share window with your text and link. You finish posting there.</p>
          <div class="stack-sm" id="sp-intents">
            {Object.entries(INTENT_NETWORKS).map(([k, n]) => <a class="btn btn-secondary btn-sm" target="_blank" rel="noopener" data-intent={k} href={n.url(pre ? defaultShareText(pre) : '', preLink)}>Share on {n.label} ↗</a>)}
          </div>
        </Card>
      </div>
      <Json id="sp-posts" data={Object.fromEntries(posts.map((p) => [p.id, { link: `${surl}/p/${p.slug}`, title: p.title, image: mediaKeyFromUrl(p.thumbnail_url, pub.id), text: defaultShareText(p) }]))} />
      <script dangerouslySetInnerHTML={{ __html: COMPOSER_JS }} />
    </form>
  ), undefined, [['/app/social', 'Social posts']]);
});

const COMPOSER_JS = `(function(){
var $=function(s){return document.querySelector(s)};var text=$('#sp-text'),link=$('#sp-link'),cnt=$('#sp-count'),sel=$('#sp-post');
var posts=JSON.parse(document.getElementById('sp-posts').textContent||'{}');
var INT={linkedin:function(t,l){return 'https://www.linkedin.com/sharing/share-offsite/?url='+encodeURIComponent(l)},x:function(t,l){return 'https://x.com/intent/post?text='+encodeURIComponent(t)+(l?'&url='+encodeURIComponent(l):'')},threads:function(t,l){return 'https://www.threads.net/intent/post?text='+encodeURIComponent(l?t+' '+l:t)},facebook:function(t,l){return 'https://www.facebook.com/sharer/sharer.php?u='+encodeURIComponent(l)}};
function len(s){try{return Array.from(new Intl.Segmenter('en',{granularity:'grapheme'}).segment(s)).length}catch(e){return Array.from(s).length}}
function upd(){var n=len(text.value);var nets=[].slice.call(document.querySelectorAll('input[name="accounts[]"]:checked')).map(function(i){return i.dataset.net});var lim=nets.indexOf('bluesky')>=0?300:500;cnt.textContent=n+' / '+lim;cnt.style.color=n>lim?'#dc2626':'';
document.querySelectorAll('[data-intent]').forEach(function(a){a.href=INT[a.dataset.intent](text.value,link.value)});}
text.addEventListener('input',upd);link.addEventListener('input',upd);document.addEventListener('change',upd);upd();
sel&&sel.addEventListener('change',function(){var p=posts[sel.value];if(!p)return;link.value=p.link;if(!text.value.trim())text.value=p.text;if(p.image){var r=document.querySelector('input[name=image_key][value="'+p.image+'"]');if(r)r.checked=true;}upd();});
$('#sp-ai').addEventListener('click',async function(){var m=$('#sp-ai-msg');if(!sel.value){m.textContent='Pick a newsletter issue first.';return}m.textContent='Writing…';
var nets=[].slice.call(document.querySelectorAll('input[name="accounts[]"]:checked')).map(function(i){return i.dataset.net});
try{var j=await OH.json('/app/social/suggest',{post_id:sel.value,network:nets[0]||'x'});text.value=j.text;m.textContent=j.ai?'Drafted with AI — edit as you like.':'AI is unavailable, so here is a plain draft from the title.';upd();}catch(e){m.textContent=e.message}});
})();`;

dash.post('/suggest', requirePerm('publish'), async (c) => {
  const pub = c.get('pub');
  const b = await c.req.json<any>().catch(() => ({}));
  const post = await one<any>(c.env, 'SELECT title, subtitle, content FROM posts WHERE id = ? AND pub_id = ?', str(b.post_id, 40), pub.id);
  if (!post) return c.json({ error: 'Post not found' }, 404);
  const net = (['bluesky', 'mastodon', 'linkedin', 'x', 'threads', 'facebook'].includes(b.network) ? b.network : 'x') as ApiNetwork;
  return c.json(await suggestSocialText(c.env, pub, post, net));
});

dash.post('/posts', requirePerm('publish'), async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const text = str(f.text, 5000);
  let link = str(f.link, 2000);
  if (link && !/^https?:\/\//i.test(link)) return back(c, '/app/social/new', 'Links must start with http:// or https://', 'err');
  const accountIds: string[] = (f.accounts || []).map(String);
  if (!accountIds.length) return back(c, '/app/social/new', 'Choose at least one connected account (or use the share links).', 'err');
  const accounts = await all<SocialAccount>(c.env, `SELECT * FROM social_accounts WHERE pub_id = ? AND id IN (${accountIds.map(() => '?').join(',')})`, pub.id, ...accountIds);
  if (!accounts.length) return back(c, '/app/social/new', 'Account not found', 'err');
  for (const a of accounts) {
    const err = validateText(a.network, text, link);
    if (err) return back(c, '/app/social/new', err, 'err');
  }
  let at: number | null = null;
  if (f.when === 'schedule') {
    at = Date.parse(str(f.scheduled_at, 40));
    if (isNaN(at) || at < now() + 30_000) return back(c, '/app/social/new', 'Pick a time in the future to schedule.', 'err');
  }
  let imageKey = str(f.image_key, 300) || null;
  if (imageKey && !imageKey.startsWith(pub.id + '/')) imageKey = null;
  const file = f.image as File | undefined;
  if (file && typeof file === 'object' && file.size) {
    try { imageKey = (await storeFile(c.env, pub.id, file, { userId: c.get('user').id, alt: str(f.image_alt, 500) })).key; }
    catch (e: any) { return back(c, '/app/social/new', e.message, 'err'); }
  }
  const postId = str(f.post_id, 40) || null;
  const campaignId = str(f.campaign_id, 40) || null;
  for (const a of accounts) {
    await createSocialPost(c.env, { pubId: pub.id, account: a, text, link: link || null, imageKey, imageAlt: str(f.image_alt, 1000), at, postId: postId && (await one(c.env, 'SELECT 1 FROM posts WHERE id = ? AND pub_id = ?', postId, pub.id)) ? postId : null, campaignId, userId: c.get('user').id });
  }
  await audit(c, at ? 'social.schedule' : 'social.post', accounts.map((a) => a.handle).join(','));
  kick(c.env, c.executionCtx);
  return back(c, '/app/social', at ? `Scheduled for ${fmtDateTime(at, pub.timezone)}` : `Posting to ${accounts.length} account${accounts.length > 1 ? 's' : ''}…`);
});

dash.post('/posts/:id/cancel', requirePerm('publish'), async (c) => {
  await run(c.env, `UPDATE social_posts SET status = 'cancelled', updated_at = ? WHERE id = ? AND pub_id = ? AND status = 'scheduled'`, now(), c.req.param('id'), c.get('pub').id);
  return back(c, '/app/social', 'Cancelled');
});

dash.post('/posts/:id/now', requirePerm('publish'), async (c) => {
  const r = await run(c.env, `UPDATE social_posts SET status = 'scheduled', scheduled_at = ?, error = NULL, attempts = 0, updated_at = ? WHERE id = ? AND pub_id = ? AND status IN ('scheduled','failed')`, now(), now(), c.req.param('id'), c.get('pub').id);
  if (r.meta.changes) {
    const { enqueue } = await import('../lib/jobs');
    await enqueue(c.env, 'social.post', { id: c.req.param('id') });
    kick(c.env, c.executionCtx);
  }
  return back(c, '/app/social', r.meta.changes ? 'Posting…' : 'Nothing to post');
});


export default { dash } satisfies Module;
