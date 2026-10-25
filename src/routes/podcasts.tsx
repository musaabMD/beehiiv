/** @jsxImportSource hono/jsx */
// Module: podcasts — native hosting on R2, public + private RSS feeds, imports, transcripts, IAB-style analytics.
import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { AppEnv, Ctx, Env, Module, Publication, Subscriber } from '../types';
import { one, all, run, insert, val } from '../lib/db';
import { requirePerm, readerEmail } from '../lib/auth';
import { DashLayout } from '../ui/layout';
import { Card, Btn, LinkBtn, ActionForm, Field, Input, Textarea, Select, Check, Status, Stat, Stats, Empty, Table, Tabs, Copy, Help, Bars, LineChart, back, Modal, OpenBtn, Grid } from '../ui/components';
import { SiteLayout, SiteMessage } from '../ui/site';
import { siteUrl, appUrl } from '../lib/pub';
import { storeFile, serveObject } from '../lib/media';
import { emit, onEvent } from '../lib/events';
import { registerJob, registerPeriodic, enqueue, kick } from '../lib/jobs';
import { aiTranscribe, aiEnabled, AI_DISABLED_MSG } from '../lib/ai';
import { sendTransactional, button } from '../lib/email';
import { classifyCrawler, isBotClick, clientIP, rateLimit } from '../lib/guard';
import { trackView } from '../lib/tracking';
import { sanitizeHtml } from '../lib/sanitize';
import { APPLE_CATEGORIES, LANGUAGES, buildFeed, parseFeed, detectApp, detectDevice, fmtDuration, type FeedEpisode } from '../lib/podcast';
import { id, now, slugify, form, str, int, bool, parseJSON, sha256, token, fmtDate, num, esc, stripTags, truncate, MIN, DAY } from '../lib/util';

const dash = new Hono<AppEnv>();
const site = new Hono<AppEnv>();
const root = new Hono<AppEnv>();

// ───────────────── shared helpers ─────────────────
const listenUrl = (env: Env, epId: string, k?: string | null) => `${env.APP_URL.replace(/\/$/, '')}/listen/${epId}.mp3${k ? `?k=${encodeURIComponent(k)}` : ''}`;

async function uniqueSlug(env: Env, table: 'podcasts' | 'episodes', scopeCol: string, scopeVal: string, base: string, exceptId?: string): Promise<string> {
  const b = slugify(base || 'untitled');
  let s = b, i = 2;
  while (await one(env, `SELECT 1 FROM ${table} WHERE ${scopeCol} = ? AND slug = ? AND id != ?`, scopeVal, s, exceptId || '')) s = `${b}-${i++}`;
  return s;
}

function epPayload(ep: any, show: any) {
  return { episode: { id: ep.id, guid: ep.guid, title: ep.title, slug: ep.slug, status: ep.status, premium: !!ep.premium, season: ep.season, number: ep.number, duration: ep.duration, published_at: ep.published_at }, podcast: { id: show.id, title: show.title, slug: show.slug } };
}

async function emitEp(env: Env, type: string, ep: any, show: any) {
  await emit(env, { pubId: show.pub_id, type, refId: ep.id, data: epPayload(ep, show), activity: false });
}

/** Create (or reuse) a private feed token for a subscriber. */
export async function ensureFeedToken(env: Env, podcastId: string, subscriberId: string): Promise<string> {
  const row = await one<{ token: string }>(env, 'SELECT token FROM podcast_feed_tokens WHERE podcast_id = ? AND subscriber_id = ? AND revoked_at IS NULL', podcastId, subscriberId);
  if (row) return row.token;
  const t = token(18);
  await insert(env, 'podcast_feed_tokens', { token: t, podcast_id: podcastId, subscriber_id: subscriberId, created_at: now() });
  return t;
}

function privateFeedUrl(env: Env, pub: Publication, show: any, t: string) {
  return `${siteUrl(env, pub)}/podcasts/${show.slug}/private/${t}/feed.xml`;
}

async function premiumPodcastsFor(env: Env, pubId: string, sub: Subscriber): Promise<any[]> {
  const shows = await all<any>(env, 'SELECT * FROM podcasts WHERE pub_id = ?', pubId);
  const tier = sub.tier_id ? await one<any>(env, 'SELECT perks FROM tiers WHERE id = ?', sub.tier_id) : null;
  const perkIds: string[] = parseJSON<any>(tier?.perks, {}).podcast_ids || [];
  return shows.filter((s) => s.access !== 'public' || perkIds.includes(s.id));
}

// Bundle podcasts with paid subscriptions
onEvent(async (env, e) => {
  if (!e.subscriberId) return;
  if (e.type === 'subscription.upgraded') {
    const sub = await one<Subscriber>(env, 'SELECT * FROM subscribers WHERE id = ?', e.subscriberId);
    const pub = await one<Publication>(env, 'SELECT * FROM publications WHERE id = ?', e.pubId);
    if (!sub || !pub) return;
    const shows = await premiumPodcastsFor(env, pub.id, sub);
    if (!shows.length) return;
    const links: string[] = [];
    for (const s of shows) {
      const existed = await one(env, 'SELECT 1 FROM podcast_feed_tokens WHERE podcast_id = ? AND subscriber_id = ? AND revoked_at IS NULL', s.id, sub.id);
      const t = await ensureFeedToken(env, s.id, sub.id);
      if (!existed) links.push(`<li><strong>${esc(s.title)}</strong><br><a href="${privateFeedUrl(env, pub, s, t)}">${privateFeedUrl(env, pub, s, t)}</a></li>`);
    }
    if (links.length)
      await sendTransactional(env, sub.email, `Your private podcast feed for ${pub.name}`, `<p>Your paid subscription includes premium podcast episodes. Add your personal feed to any podcast app:</p><ul>${links.join('')}</ul><p style="color:#6b7280;font-size:13px">Apple Podcasts: Library → ⋯ → Follow a Show by URL. Overcast/Pocket Casts: Add podcast → paste URL. This link is personal — please don't share it.</p>`, pub);
  }
  if (e.type === 'subscription.downgraded' || e.type === 'subscription.deleted') {
    await run(env, `UPDATE podcast_feed_tokens SET revoked_at = ? WHERE subscriber_id = ? AND revoked_at IS NULL AND podcast_id IN (SELECT id FROM podcasts WHERE pub_id = ?)`, now(), e.subscriberId, e.pubId);
  }
});

// Scheduled episodes
registerPeriodic('podcasts.scheduled', MIN - 5000, async (env) => {
  const due = await all<any>(env, `SELECT * FROM episodes WHERE status = 'scheduled' AND published_at <= ? LIMIT 50`, now());
  for (const ep of due) {
    await run(env, `UPDATE episodes SET status = 'published', updated_at = ? WHERE id = ?`, now(), ep.id);
    const show = await one<any>(env, 'SELECT * FROM podcasts WHERE id = ?', ep.podcast_id);
    if (show) await emitEp(env, 'podcast.episode.published', { ...ep, status: 'published' }, show);
  }
});

// Copy imported audio into R2
registerJob('podcast.copy_audio', async (env, p) => {
  const ep = await one<any>(env, 'SELECT * FROM episodes WHERE id = ?', p.episode_id);
  if (!ep || !ep.audio_url || ep.audio_key) return;
  const r = await fetch(ep.audio_url, { headers: { 'user-agent': 'OpenHive-PodcastImport/1.0' } });
  if (!r.ok || !r.body) throw new Error(`audio fetch failed ${r.status}`);
  const ext = (ep.mime || '').includes('mp4') || (ep.mime || '').includes('m4a') ? '.m4a' : '.mp3';
  const key = `${ep.pub_id}/private/podcasts/${ep.id}${ext}`;
  const buf = await r.arrayBuffer();
  await env.MEDIA.put(key, buf, { httpMetadata: { contentType: ep.mime || 'audio/mpeg' } });
  await run(env, 'UPDATE episodes SET audio_key = ?, size = ?, updated_at = ? WHERE id = ?', key, buf.byteLength, now(), ep.id);
});

// ───────────────── dashboard ─────────────────
dash.use('*', requirePerm('manage'));

const PodTabs = (p: { show: any; active: string }) => (
  <Tabs active={p.active} items={[[`/app/podcasts/${p.show.id}`, 'Episodes'], [`/app/podcasts/${p.show.id}/analytics`, 'Analytics'], [`/app/podcasts/${p.show.id}/distribution`, 'Distribution'], [`/app/podcasts/${p.show.id}/settings`, 'Show settings']]} />
);

async function getShow(c: Ctx, sid: string) {
  return one<any>(c.env, 'SELECT * FROM podcasts WHERE id = ? AND pub_id = ?', sid, c.get('pub').id);
}

dash.get('/', async (c) => {
  const pub = c.get('pub');
  const shows = await all<any>(c.env, `SELECT p.*, (SELECT COUNT(*) FROM episodes e WHERE e.podcast_id = p.id AND e.status = 'published') AS eps,
    (SELECT COUNT(*) FROM episode_downloads d WHERE d.podcast_id = p.id AND d.is_bot = 0 AND d.created_at > ?) AS dl30,
    (SELECT COUNT(DISTINCT listener_hash) FROM episode_downloads d WHERE d.podcast_id = p.id AND d.is_bot = 0 AND d.created_at > ?) AS uniq30
    FROM podcasts p WHERE p.pub_id = ? ORDER BY p.created_at DESC`, now() - 30 * DAY, now() - 30 * DAY, pub.id);
  return c.html(
    <DashLayout c={c} title="Podcasts" section="podcasts" actions={<><OpenBtn target="#import" kind="secondary">Import from another host</OpenBtn><LinkBtn href="/app/podcasts/new" kind="primary">New show</LinkBtn></>}>
      {shows.length ? (
        <Table rows={shows} rowHref={(s) => `/app/podcasts/${s.id}`} cols={[
          { h: 'Show', r: (s) => <div class="row">{s.cover_url ? <img class="thumb" src={s.cover_url} alt="" /> : <span class="thumb" />}<div><a href={`/app/podcasts/${s.id}`}>{s.title}</a><div class="muted small">{s.author || '—'} · {s.category}</div></div></div> },
          { h: 'Access', r: (s) => <Status s={s.access === 'public' ? 'free' : 'premium'} /> },
          { h: 'Episodes', r: (s) => num(s.eps), class: 'right' },
          { h: 'Downloads (30d)', r: (s) => num(s.dl30), class: 'right' },
          { h: 'Listeners (30d)', r: (s) => num(s.uniq30), class: 'right' },
        ]} />
      ) : (
        <Card><Empty icon="🎙" title="Host your podcast on OpenHive" body="Upload episodes, get an Apple/Spotify-ready RSS feed, sell private premium feeds, and track IAB-style downloads — with zero platform fees." action={<><LinkBtn href="/app/podcasts/new" kind="primary">Create a show</LinkBtn> <OpenBtn target="#import" kind="secondary">Import existing podcast</OpenBtn></>} /></Card>
      )}
      <Modal id="import" title="Import a podcast from another host">
        <form method="post" action="/app/podcasts/import" class="stack">
          <Field label="Current RSS feed URL" hint="Episodes keep their original GUIDs, so listeners' apps won't show duplicates when you move the feed."><Input name="url" type="url" placeholder="https://feeds.example.com/show.xml" required /></Field>
          <Check name="copy_audio" checked label="Copy audio files into OpenHive storage" hint="Recommended. Otherwise episodes keep streaming from the old host's URLs." />
          <div class="form-actions"><Btn>Import podcast</Btn></div>
        </form>
      </Modal>
    </DashLayout>,
  );
});

function categoryOptions(sel: string, sub: string | null) {
  const value = sub ? `${sel}|${sub}` : sel;
  return raw(Object.entries(APPLE_CATEGORIES).map(([cat, subs]) => `<optgroup label="${esc(cat)}"><option value="${esc(cat)}" ${value === cat ? 'selected' : ''}>${esc(cat)}</option>${subs.map((s) => `<option value="${esc(cat)}|${esc(s)}" ${value === `${cat}|${s}` ? 'selected' : ''}>${esc(cat)} › ${esc(s)}</option>`).join('')}</optgroup>`).join(''));
}

function ShowForm(p: { show?: any; action: string; tiers: any[] }) {
  const s = p.show || { language: 'en', category: 'Technology', kind: 'episodic', access: 'public', explicit: 0 };
  return (
    <form method="post" action={p.action} class="stack">
      <Grid cols={2}>
        <div>
          <Field label="Show title"><Input name="title" value={s.title} required /></Field>
          <Field label="Description" hint="Shown in podcast apps and on your site."><Textarea name="description" value={s.description} rows={5} /></Field>
          <Grid cols={2}>
            <Field label="Author / host"><Input name="author" value={s.author} /></Field>
            <Field label="Owner email" hint="Apple uses this to verify ownership."><Input name="owner_email" type="email" value={s.owner_email} /></Field>
          </Grid>
          <Grid cols={2}>
            <Field label="Language"><Select name="language" value={s.language} options={LANGUAGES} /></Field>
            <Field label="Apple Podcasts category"><select class="input" name="category">{categoryOptions(s.category, s.subcategory)}</select></Field>
          </Grid>
          <Grid cols={2}>
            <Field label="Show type"><Select name="kind" value={s.kind} options={[['episodic', 'Episodic (newest first)'], ['serial', 'Serial (in order)']]} /></Field>
            <Field label="Copyright"><Input name="copyright" value={s.copyright} placeholder={`© ${new Date().getFullYear()} …`} /></Field>
          </Grid>
          <Check name="explicit" checked={!!s.explicit} label="Contains explicit content" />
        </div>
        <div>
          <Field label="Cover art" hint="Square, 1400–3000px JPG or PNG (Apple requirement).">
            <div class="row top">
              <img data-preview="cover_url" src={s.cover_url || ''} class={s.cover_url ? '' : 'hide'} style="width:120px;height:120px;border-radius:10px;object-fit:cover" alt="" />
              <div class="stack-sm grow"><input type="file" accept="image/*" class="input" data-image-upload="cover_url" /><Input name="cover_url" value={s.cover_url} placeholder="or paste an image URL" attrs={{ 'data-image-field': 'cover_url' }} /></div>
            </div>
          </Field>
          <Field label="Access" hint="Premium shows are delivered through private, per-subscriber RSS feeds.">
            <Select name="access" value={s.access} options={[['public', 'Public — free for everyone'], ['both', 'Free + premium episodes (private feed for paid)'], ['premium', 'Premium only (paid subscribers)']]} />
          </Field>
          {p.tiers.length > 0 && <Help>Tip: include this show as a perk on specific paid tiers from Monetize → Paid subscriptions.</Help>}
          <Field label="URL slug"><Input name="slug" value={s.slug} placeholder="auto from title" /></Field>
        </div>
      </Grid>
      <div class="form-actions"><Btn>{p.show ? 'Save show' : 'Create show'}</Btn></div>
    </form>
  );
}

const ADMIN_JS = ['/static/podcast-admin.js'];

dash.get('/new', async (c) => {
  const tiers = await all(c.env, 'SELECT id FROM tiers WHERE pub_id = ?', c.get('pub').id);
  return c.html(<DashLayout c={c} title="New podcast" section="podcasts" crumbs={[['/app/podcasts', 'Podcasts']]} scripts={ADMIN_JS}><Card><ShowForm action="/app/podcasts/new" tiers={tiers} /></Card></DashLayout>);
});

function showFields(f: Record<string, any>) {
  const [category, subcategory] = String(f.category || 'Technology').split('|');
  return {
    title: str(f.title, 200) || 'Untitled podcast', description: str(f.description, 4000), author: str(f.author, 200), owner_email: str(f.owner_email, 200) || null,
    cover_url: str(f.cover_url, 1000) || null, language: str(f.language, 8) || 'en', category: APPLE_CATEGORIES[category] ? category : 'Technology',
    subcategory: subcategory && APPLE_CATEGORIES[category]?.includes(subcategory) ? subcategory : null, explicit: bool(f.explicit) ? 1 : 0,
    kind: f.kind === 'serial' ? 'serial' : 'episodic', copyright: str(f.copyright, 200) || null, access: ['public', 'premium', 'both'].includes(f.access) ? f.access : 'public',
  };
}

dash.post('/new', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const fields = showFields(f);
  const sid = id();
  await insert(c.env, 'podcasts', { id: sid, pub_id: pub.id, slug: await uniqueSlug(c.env, 'podcasts', 'pub_id', pub.id, str(f.slug) || fields.title), ...fields, created_at: now() });
  return back(c, `/app/podcasts/${sid}`, 'Show created — add your first episode.');
});

dash.post('/import', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const url = str(f.url, 1000);
  let xml: string;
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'OpenHive-PodcastImport/1.0', accept: 'application/rss+xml, application/xml, text/xml' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    xml = await r.text();
  } catch (e: any) {
    return back(c, '/app/podcasts', `Couldn't fetch that feed: ${e.message}`, 'err');
  }
  if (!/<rss|<channel/i.test(xml)) return back(c, '/app/podcasts', "That URL doesn't look like a podcast RSS feed.", 'err');
  const feed = parseFeed(xml);
  const sid = id();
  await insert(c.env, 'podcasts', {
    id: sid, pub_id: pub.id, slug: await uniqueSlug(c.env, 'podcasts', 'pub_id', pub.id, feed.title), title: feed.title.slice(0, 200), description: feed.description.slice(0, 4000),
    author: feed.author, owner_email: feed.owner_email || null, cover_url: feed.cover_url || null, language: feed.language, category: feed.category, subcategory: feed.subcategory || null,
    explicit: feed.explicit ? 1 : 0, kind: feed.kind, copyright: feed.copyright || null, access: 'public', import_url: url, created_at: now(),
  });
  const copy = bool(f.copy_audio);
  let n = 0;
  for (const it of feed.items) {
    if (!it.audio_url) continue;
    const eid = id();
    await insert(c.env, 'episodes', {
      id: eid, podcast_id: sid, pub_id: pub.id, guid: it.guid || crypto.randomUUID(), title: it.title.slice(0, 300), slug: await uniqueSlug(c.env, 'episodes', 'podcast_id', sid, it.title),
      description: sanitizeHtml(it.description, { blocks: true }).slice(0, 20000), audio_url: it.audio_url, mime: it.mime, size: it.size, duration: it.duration,
      season: it.season, number: it.number, episode_type: it.episode_type, explicit: it.explicit ? 1 : 0, image_url: it.image || null,
      status: 'published', published_at: it.published_at, created_at: now(), updated_at: now(),
    });
    if (copy) await enqueue(c.env, 'podcast.copy_audio', { episode_id: eid }, now() + n * 2000);
    n++;
  }
  if (copy) kick(c.env, c.executionCtx);
  return back(c, `/app/podcasts/${sid}`, `Imported "${feed.title}" with ${n} episodes${copy ? ' — audio is being copied in the background' : ''}. Set up an RSS redirect at your old host to move listeners over.`);
});

dash.post('/upload', async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ error: 'No file' }, 400);
  const kind = String(body.kind || 'image');
  try {
    const stored = await storeFile(c.env, c.get('pub').id, file, { folder: kind === 'audio' ? 'private/podcasts' : kind === 'transcript' ? 'private/transcripts' : 'podcast-art', userId: c.get('user').id });
    return c.json(stored);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

dash.get('/:id', async (c) => {
  const show = await getShow(c, c.req.param('id'));
  if (!show) return c.notFound();
  const status = c.req.query('status') || '';
  const eps = await all<any>(c.env, `SELECT e.*, (SELECT COUNT(*) FROM episode_downloads d WHERE d.episode_id = e.id AND d.is_bot = 0) AS dl FROM episodes e WHERE e.podcast_id = ? ${status ? 'AND e.status = ?' : ''} ORDER BY COALESCE(e.published_at, e.created_at) DESC`, show.id, ...(status ? [status] : []));
  const pub = c.get('pub');
  return c.html(
    <DashLayout c={c} title={show.title} section="podcasts" crumbs={[['/app/podcasts', 'Podcasts']]} actions={<><LinkBtn href={`${siteUrl(c.env, pub)}/podcasts/${show.slug}`} target="_blank">View show page</LinkBtn><LinkBtn href={`/app/podcasts/${show.id}/episodes/new`} kind="primary">New episode</LinkBtn></>}>
      <PodTabs show={show} active={`/app/podcasts/${show.id}`} />
      <form method="get" class="row" style="margin-bottom:12px"><Select name="status" value={status} autosubmit options={[['', 'All episodes'], ['published', 'Published'], ['scheduled', 'Scheduled'], ['draft', 'Drafts'], ['archived', 'Archived']]} attrs={{ style: 'width:200px' }} /></form>
      <Table rows={eps} rowHref={(e) => `/app/podcasts/${show.id}/episodes/${e.id}`} empty={<Empty icon="🎧" title="No episodes yet" body="Upload audio, write show notes, and publish — your feed updates instantly." action={<LinkBtn href={`/app/podcasts/${show.id}/episodes/new`} kind="primary">Upload an episode</LinkBtn>} />} cols={[
        { h: 'Episode', r: (e) => <div><a href={`/app/podcasts/${show.id}/episodes/${e.id}`}>{e.title}</a><div class="muted small">{e.season ? `S${e.season} ` : ''}{e.number ? `E${e.number} · ` : ''}{e.duration ? fmtDuration(e.duration) : 'no audio'}{e.premium ? ' · 🔒 premium' : ''}{e.transcript ? ' · transcript' : ''}</div></div> },
        { h: 'Status', r: (e) => <Status s={e.status} /> },
        { h: 'Date', r: (e) => <span class="nowrap">{fmtDate(e.published_at || e.created_at, { dateStyle: 'medium', timeStyle: e.status === 'scheduled' ? 'short' : undefined }, pub.timezone)}</span> },
        { h: 'Downloads', r: (e) => num(e.dl), class: 'right' },
      ]} />
    </DashLayout>,
  );
});

dash.get('/:id/settings', async (c) => {
  const show = await getShow(c, c.req.param('id'));
  if (!show) return c.notFound();
  const tiers = await all(c.env, 'SELECT id FROM tiers WHERE pub_id = ?', c.get('pub').id);
  return c.html(
    <DashLayout c={c} title={show.title} section="podcasts" crumbs={[['/app/podcasts', 'Podcasts']]} scripts={ADMIN_JS}>
      <PodTabs show={show} active={`/app/podcasts/${show.id}/settings`} />
      <Card title="Show details"><ShowForm show={show} action={`/app/podcasts/${show.id}/settings`} tiers={tiers} /></Card>
      <Card title="Delete show">
        <p class="muted">Deletes the show, all episodes, audio files and analytics. Your RSS feed will stop working.</p>
        <ActionForm action={`/app/podcasts/${show.id}/delete`} label="Delete show" kind="danger" confirm="Delete this show and all of its episodes? This cannot be undone." />
      </Card>
    </DashLayout>,
  );
});

dash.post('/:id/settings', async (c) => {
  const show = await getShow(c, c.req.param('id'));
  if (!show) return c.notFound();
  const f = await form(c.req);
  const fields = showFields(f);
  const slug = str(f.slug) ? await uniqueSlug(c.env, 'podcasts', 'pub_id', show.pub_id, str(f.slug), show.id) : show.slug;
  await run(c.env, `UPDATE podcasts SET title=?, description=?, author=?, owner_email=?, cover_url=?, language=?, category=?, subcategory=?, explicit=?, kind=?, copyright=?, access=?, slug=? WHERE id = ?`,
    fields.title, fields.description, fields.author, fields.owner_email, fields.cover_url, fields.language, fields.category, fields.subcategory, fields.explicit, fields.kind, fields.copyright, fields.access, slug, show.id);
  return back(c, `/app/podcasts/${show.id}/settings`, 'Show saved');
});

dash.post('/:id/delete', async (c) => {
  const show = await getShow(c, c.req.param('id'));
  if (!show) return c.notFound();
  const eps = await all<any>(c.env, 'SELECT * FROM episodes WHERE podcast_id = ?', show.id);
  for (const e of eps) {
    if (e.audio_key) await c.env.MEDIA.delete(e.audio_key).catch(() => {});
    await emitEp(c.env, 'podcast.episode.deleted', e, show);
  }
  await run(c.env, 'DELETE FROM episode_downloads WHERE podcast_id = ?', show.id);
  await run(c.env, 'DELETE FROM podcast_feed_tokens WHERE podcast_id = ?', show.id);
  await run(c.env, 'DELETE FROM podcasts WHERE id = ?', show.id);
  return back(c, '/app/podcasts', 'Show deleted');
});

dash.get('/:id/distribution', async (c) => {
  const show = await getShow(c, c.req.param('id'));
  if (!show) return c.notFound();
  const pub = c.get('pub');
  const feed = `${siteUrl(c.env, pub)}/podcasts/${show.slug}/feed.xml`;
  const tokens = await val<number>(c.env, 'SELECT COUNT(*) FROM podcast_feed_tokens WHERE podcast_id = ? AND revoked_at IS NULL', show.id);
  const recent = await all<any>(c.env, `SELECT t.*, s.email FROM podcast_feed_tokens t JOIN subscribers s ON s.id = t.subscriber_id WHERE t.podcast_id = ? ORDER BY COALESCE(t.last_access_at, t.created_at) DESC LIMIT 25`, show.id);
  return c.html(
    <DashLayout c={c} title={show.title} section="podcasts" crumbs={[['/app/podcasts', 'Podcasts']]}>
      <PodTabs show={show} active={`/app/podcasts/${show.id}/distribution`} />
      <Grid cols={2}>
        <div>
          <Card title="Your RSS feed">
            {show.access === 'premium' ? <div class="callout warn">This show is premium-only, so the public feed is locked. Paid subscribers get personal private feeds.</div> : null}
            <Copy value={feed} />
            <p style="margin-top:10px"><a href={feed + '?preview=1'} target="_blank">Open feed ↗</a></p>
          </Card>
          <Card title="Listening links" actions={<span class="muted small">Shown on your show page</span>}>
            <form method="post" action={`/app/podcasts/${show.id}/distribution`} class="stack">
              <Field label="Apple Podcasts URL"><Input name="apple_url" type="url" value={show.apple_url} placeholder="https://podcasts.apple.com/…" /></Field>
              <Field label="Spotify URL"><Input name="spotify_url" type="url" value={show.spotify_url} placeholder="https://open.spotify.com/show/…" /></Field>
              <Field label="YouTube URL"><Input name="youtube_url" type="url" value={show.youtube_url} placeholder="https://youtube.com/@…" /></Field>
              <Field label="RSS redirect (moving away)" hint="Set this only if you're moving this podcast to a different host. The feed will 301-redirect and announce <itunes:new-feed-url> so apps follow you."><Input name="redirect_url" type="url" value={show.redirect_url} placeholder="https://new-host.example/feed.xml" /></Field>
              <div class="form-actions"><Btn>Save links</Btn></div>
            </form>
          </Card>
        </div>
        <div>
          <Card title="Submit to directories">
            <ol class="stack" style="padding-left:18px;margin:0">
              <li><strong>Apple Podcasts</strong> — open <a href="https://podcastsconnect.apple.com" target="_blank">Podcasts Connect</a>, click <em>+ → New Show → Add a show with an RSS feed</em>, paste your feed URL. Apple emails the owner address ({show.owner_email || 'set one in Show settings'}) to verify.</li>
              <li><strong>Spotify</strong> — go to <a href="https://podcasters.spotify.com" target="_blank">Spotify for Creators</a> → <em>Get started → Find an existing show</em>, paste the feed URL and verify with the code sent to the owner email.</li>
              <li><strong>YouTube</strong> — in <a href="https://studio.youtube.com" target="_blank">YouTube Studio</a> → <em>Create → New podcast → Submit RSS feed</em>.</li>
              <li><strong>Everywhere else</strong> (Overcast, Pocket Casts, Castro…) picks it up from Apple's directory automatically. You can also submit to <a href="https://podcastindex.org/add" target="_blank">Podcast Index</a>.</li>
            </ol>
            <Help>Apple requires cover art between 1400×1400 and 3000×3000 and at least one published episode.</Help>
          </Card>
          <Card title="Private premium feeds" actions={<span class="badge b-purple">{num(tokens)} active</span>}>
            <p class="muted">Paid subscribers automatically receive a personal private feed by email when they upgrade (shows set to <em>premium</em> or <em>free + premium</em>, or listed as a tier perk). Feeds are revoked when they cancel.</p>
            <Table rows={recent} empty="No private feeds issued yet." cols={[
              { h: 'Subscriber', r: (t) => t.email },
              { h: 'Last used', r: (t) => (t.last_access_at ? fmtDate(t.last_access_at) : 'never') },
              { h: '', r: (t) => (t.revoked_at ? <span class="badge b-gray">revoked</span> : <ActionForm action={`/app/podcasts/${show.id}/tokens/${t.token}/revoke`} label="Revoke" kind="danger" confirm="Revoke this private feed?" />) },
            ]} />
          </Card>
        </div>
      </Grid>
    </DashLayout>,
  );
});

dash.post('/:id/distribution', async (c) => {
  const show = await getShow(c, c.req.param('id'));
  if (!show) return c.notFound();
  const f = await form(c.req);
  await run(c.env, 'UPDATE podcasts SET apple_url = ?, spotify_url = ?, youtube_url = ?, redirect_url = ? WHERE id = ?', str(f.apple_url, 500) || null, str(f.spotify_url, 500) || null, str(f.youtube_url, 500) || null, str(f.redirect_url, 500) || null, show.id);
  return back(c, `/app/podcasts/${show.id}/distribution`, 'Distribution settings saved');
});

dash.post('/:id/tokens/:token/revoke', async (c) => {
  const show = await getShow(c, c.req.param('id'));
  if (!show) return c.notFound();
  await run(c.env, 'UPDATE podcast_feed_tokens SET revoked_at = ? WHERE token = ? AND podcast_id = ?', now(), c.req.param('token'), show.id);
  return back(c, `/app/podcasts/${show.id}/distribution`, 'Private feed revoked');
});

dash.get('/:id/analytics', async (c) => {
  const show = await getShow(c, c.req.param('id'));
  if (!show) return c.notFound();
  const days = int(c.req.query('days'), 30);
  const since = days > 0 ? now() - days * DAY : 0;
  const w = 'podcast_id = ? AND created_at >= ?';
  const [tot, bots, byDay, byCountry, byApp, byDevice, byEp] = await Promise.all([
    one<any>(c.env, `SELECT COUNT(*) AS dl, COUNT(DISTINCT listener_hash) AS uniq FROM episode_downloads WHERE ${w} AND is_bot = 0`, show.id, since),
    val<number>(c.env, `SELECT COUNT(*) FROM episode_downloads WHERE ${w} AND is_bot = 1`, show.id, since),
    all<any>(c.env, `SELECT day, COUNT(*) AS dl, COUNT(DISTINCT listener_hash) AS uniq FROM episode_downloads WHERE ${w} AND is_bot = 0 GROUP BY day ORDER BY day`, show.id, since),
    all<any>(c.env, `SELECT COALESCE(country, '??') AS k, COUNT(*) AS n FROM episode_downloads WHERE ${w} AND is_bot = 0 GROUP BY k ORDER BY n DESC LIMIT 10`, show.id, since),
    all<any>(c.env, `SELECT COALESCE(app, 'Unknown') AS k, COUNT(*) AS n FROM episode_downloads WHERE ${w} AND is_bot = 0 GROUP BY k ORDER BY n DESC LIMIT 10`, show.id, since),
    all<any>(c.env, `SELECT COALESCE(device, 'Other') AS k, COUNT(*) AS n FROM episode_downloads WHERE ${w} AND is_bot = 0 GROUP BY k ORDER BY n DESC LIMIT 10`, show.id, since),
    all<any>(c.env, `SELECT e.id, e.title, e.published_at, COUNT(d.id) AS dl, COUNT(DISTINCT d.listener_hash) AS uniq FROM episodes e LEFT JOIN episode_downloads d ON d.episode_id = e.id AND d.is_bot = 0 AND d.created_at >= ? WHERE e.podcast_id = ? GROUP BY e.id ORDER BY dl DESC LIMIT 50`, since, show.id),
  ]);
  // fill daily series
  const span = days > 0 ? days : Math.max(1, byDay.length);
  const labels: string[] = [];
  const dl: number[] = [], uq: number[] = [];
  const map = new Map(byDay.map((r) => [r.day, r]));
  const start = days > 0 ? now() - (days - 1) * DAY : byDay.length ? Date.parse(byDay[0].day) : now();
  for (let i = 0; i < span; i++) {
    const d = new Date(start + i * DAY).toISOString().slice(0, 10);
    labels.push(d.slice(5));
    dl.push(map.get(d)?.dl || 0);
    uq.push(map.get(d)?.uniq || 0);
  }
  return c.html(
    <DashLayout c={c} title={show.title} section="podcasts" crumbs={[['/app/podcasts', 'Podcasts']]}>
      <PodTabs show={show} active={`/app/podcasts/${show.id}/analytics`} />
      <form method="get" class="row" style="margin-bottom:12px"><Select name="days" value={String(days)} autosubmit options={[['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last 12 months'], ['0', 'All time']]} attrs={{ style: 'width:180px' }} /><span class="muted small">IAB-style: one download per listener per episode per day; bots and probe requests are excluded.</span></form>
      <Stats>
        <Stat label="Downloads" value={num(tot?.dl)} />
        <Stat label="Unique listeners" value={num(tot?.uniq)} />
        <Stat label="Avg per episode" value={num(byEp.length ? Math.round((tot?.dl || 0) / byEp.filter((e) => e.published_at).length || 0) : 0)} />
        <Stat label="Bot downloads filtered" value={num(bots)} sub="Never counted in your stats" />
      </Stats>
      <Card title="Downloads over time"><LineChart labels={labels} series={[{ label: 'Downloads', values: dl }, { label: 'Unique listeners', values: uq }]} /></Card>
      <Grid cols={3}>
        <Card title="Countries"><Bars rows={byCountry.map((r) => ({ label: r.k, value: r.n }))} /></Card>
        <Card title="Apps"><Bars rows={byApp.map((r) => ({ label: r.k, value: r.n }))} /></Card>
        <Card title="Devices"><Bars rows={byDevice.map((r) => ({ label: r.k, value: r.n }))} /></Card>
      </Grid>
      <Card title="Episodes" pad={false}>
        <Table rows={byEp} cols={[
          { h: 'Episode', r: (e) => <a href={`/app/podcasts/${show.id}/episodes/${e.id}`}>{e.title}</a> },
          { h: 'Published', r: (e) => fmtDate(e.published_at) },
          { h: 'Downloads', r: (e) => num(e.dl), class: 'right' },
          { h: 'Unique listeners', r: (e) => num(e.uniq), class: 'right' },
        ]} />
      </Card>
    </DashLayout>,
  );
});

function EpisodeForm(p: { show: any; ep?: any; tz: string }) {
  const e = p.ep || { episode_type: 'full', status: 'draft', premium: p.show.access === 'premium' ? 1 : 0 };
  const action = p.ep ? `/app/podcasts/${p.show.id}/episodes/${e.id}` : `/app/podcasts/${p.show.id}/episodes/new`;
  return (
    <form method="post" action={action} class="split" data-episode-form>
      <div>
        <Card>
          <Field label="Title"><Input name="title" value={e.title} required /></Field>
          <Field label="Audio" hint="MP3 or M4A. Duration and file size are detected automatically.">
            <div class="stack-sm">
              <input type="file" accept="audio/*" class="input" data-audio-upload />
              <div class="progress hide" data-audio-progress><div class="progress-bar" style="width:0%" /></div>
              <div class="muted small" data-audio-info>{e.audio_key || e.audio_url ? `Current: ${e.audio_key ? 'hosted on OpenHive' : e.audio_url} · ${fmtDuration(e.duration)} · ${(e.size / 1048576).toFixed(1)} MB` : 'No audio yet'}</div>
              {(e.audio_key || e.audio_url) && p.ep ? <audio controls preload="none" src={`/listen/${e.id}.mp3?preview=1`} style="width:100%" /> : null}
              <Input name="audio_url" value={e.audio_url} placeholder="…or an external audio URL" />
            </div>
            <input type="hidden" name="audio_key" value={e.audio_key || ''} />
            <input type="hidden" name="size" value={String(e.size || 0)} />
            <input type="hidden" name="mime" value={e.mime || 'audio/mpeg'} />
            <input type="hidden" name="duration" value={String(e.duration || 0)} />
          </Field>
          <Field label="Show notes">
            <div class="rte">
              <div class="rte-bar"><button type="button" data-cmd="bold"><b>B</b></button><button type="button" data-cmd="italic"><i>I</i></button><button type="button" data-cmd="createLink">Link</button><button type="button" data-cmd="insertUnorderedList">• List</button><button type="button" data-cmd="insertOrderedList">1. List</button><button type="button" data-cmd="formatBlock" data-arg="h3">Heading</button></div>
              <div class="rte-body input" contenteditable={true} data-rte="description">{raw(sanitizeHtml(e.description || '', { blocks: true }))}</div>
            </div>
            <input type="hidden" name="description" value={e.description || ''} />
          </Field>
          <Field label="Transcript" hint="Plain text or WebVTT. Generate automatically with AI, or upload a .txt/.vtt file.">
            <Textarea name="transcript" value={e.transcript} rows={8} />
            <div class="row" style="margin-top:6px"><input type="file" accept=".txt,.vtt,text/plain,text/vtt" data-transcript-file class="input" style="max-width:280px" />
              {p.ep && (e.audio_key || e.audio_url) ? <Btn kind="secondary" small formaction={`/app/podcasts/${p.show.id}/episodes/${e.id}/transcribe`}>✨ Generate transcript</Btn> : null}
            </div>
          </Field>
        </Card>
      </div>
      <div>
        <Card title="Publish">
          <Field label="Status"><Select name="status" value={e.status === 'archived' ? 'draft' : e.status} options={[['draft', 'Draft'], ['published', 'Published'], ['scheduled', 'Scheduled']]} attrs={{ 'data-status': '1' }} /></Field>
          <Field label="Publish date" hint={`Your timezone. For scheduled episodes, it goes live automatically.`}>
            <input type="datetime-local" class="input" data-utc="published_at_utc" data-utc-value={e.published_at ? new Date(e.published_at).toISOString() : ''} />
          </Field>
          <Check name="premium" checked={!!e.premium} label="Premium episode" hint="Only in paid subscribers' private feeds and on the site for premium readers." />
          <div class="form-actions"><Btn>{p.ep ? 'Save episode' : 'Create episode'}</Btn></div>
        </Card>
        <Card title="Details">
          <Grid cols={2}>
            <Field label="Season"><Input name="season" type="number" min="1" value={e.season} /></Field>
            <Field label="Episode #"><Input name="number" type="number" min="0" value={e.number} /></Field>
          </Grid>
          <Field label="Episode type"><Select name="episode_type" value={e.episode_type} options={[['full', 'Full'], ['trailer', 'Trailer'], ['bonus', 'Bonus']]} /></Field>
          <Check name="explicit" checked={!!e.explicit} label="Explicit" />
          <Field label="Episode art (optional)">
            <img data-preview="image_url" src={e.image_url || ''} class={e.image_url ? '' : 'hide'} style="width:96px;height:96px;border-radius:8px;object-fit:cover" alt="" />
            <input type="file" accept="image/*" class="input" data-image-upload="image_url" />
            <Input name="image_url" value={e.image_url} placeholder="Image URL" attrs={{ 'data-image-field': 'image_url' }} />
          </Field>
          <Field label="URL slug"><Input name="slug" value={e.slug} placeholder="auto" /></Field>
          {p.ep && <Field label="GUID" hint="Permanent identifier used by podcast apps."><Input name="guid_ro" value={e.guid} readonly /></Field>}
        </Card>
        {p.ep && (
          <Card title="More">
            <div class="row">
              {e.status !== 'archived' ? <ActionForm action={`/app/podcasts/${p.show.id}/episodes/${e.id}/archive`} label="Archive" /> : <ActionForm action={`/app/podcasts/${p.show.id}/episodes/${e.id}/unarchive`} label="Unarchive" />}
              <ActionForm action={`/app/podcasts/${p.show.id}/episodes/${e.id}/delete`} label="Delete" kind="danger" confirm="Delete this episode and its audio?" />
            </div>
            <Help>Embed in a post: add a <em>Podcast</em> block with episode ID <code>{e.id}</code>.</Help>
          </Card>
        )}
      </div>
    </form>
  );
}

dash.get('/:id/episodes/new', async (c) => {
  const show = await getShow(c, c.req.param('id'));
  if (!show) return c.notFound();
  return c.html(<DashLayout c={c} title="New episode" section="podcasts" crumbs={[['/app/podcasts', 'Podcasts'], [`/app/podcasts/${show.id}`, show.title]]} scripts={ADMIN_JS} styles={['/static/podcast-admin.css']}><EpisodeForm show={show} tz={c.get('pub').timezone} /></DashLayout>);
});

dash.get('/:id/episodes/:eid', async (c) => {
  const show = await getShow(c, c.req.param('id'));
  const ep = show && (await one<any>(c.env, 'SELECT * FROM episodes WHERE id = ? AND podcast_id = ?', c.req.param('eid'), show.id));
  if (!show || !ep) return c.notFound();
  return c.html(<DashLayout c={c} title={ep.title} section="podcasts" crumbs={[['/app/podcasts', 'Podcasts'], [`/app/podcasts/${show.id}`, show.title]]} scripts={ADMIN_JS} styles={['/static/podcast-admin.css']} actions={ep.status === 'published' ? <LinkBtn href={`${siteUrl(c.env, c.get('pub'))}/podcasts/${show.slug}/${ep.slug}`} target="_blank">View episode page</LinkBtn> : undefined}><EpisodeForm show={show} ep={ep} tz={c.get('pub').timezone} /></DashLayout>);
});

async function saveEpisode(c: Ctx, show: any, existing: any | null) {
  const f = await form(c.req);
  const title = str(f.title, 300) || 'Untitled episode';
  let status = ['draft', 'published', 'scheduled'].includes(f.status) ? f.status : 'draft';
  let publishedAt = f.published_at_utc ? Date.parse(f.published_at_utc) : NaN;
  const audioKey = str(f.audio_key, 500) || null;
  const audioUrl = str(f.audio_url, 1000) || null;
  if (audioKey && !audioKey.startsWith(show.pub_id + '/')) return { error: 'Invalid audio file' };
  if (status !== 'draft' && !audioKey && !audioUrl) return { error: 'Upload audio before publishing.' };
  if (status === 'scheduled') {
    if (isNaN(publishedAt)) return { error: 'Pick a date and time to schedule this episode.' };
    if (publishedAt <= now()) status = 'published';
  }
  if (status === 'published' && isNaN(publishedAt)) publishedAt = existing?.published_at || now();
  const fields = {
    title, description: sanitizeHtml(str(f.description, 50000), { blocks: true }), audio_key: audioKey, audio_url: audioKey ? null : audioUrl,
    mime: str(f.mime, 60) || 'audio/mpeg', size: int(f.size), duration: Math.round(Number(f.duration) || 0), season: int(f.season) || null, number: int(f.number) || null,
    episode_type: ['full', 'trailer', 'bonus'].includes(f.episode_type) ? f.episode_type : 'full', explicit: bool(f.explicit) ? 1 : 0, premium: bool(f.premium) ? 1 : 0,
    image_url: str(f.image_url, 1000) || null, transcript: str(f.transcript, 400000) || null, status, published_at: isNaN(publishedAt) ? null : publishedAt, updated_at: now(),
  };
  const slug = await uniqueSlug(c.env, 'episodes', 'podcast_id', show.id, str(f.slug) || (existing?.slug && !str(f.slug) ? existing.slug : title), existing?.id);
  if (existing) {
    if (existing.audio_key && existing.audio_key !== audioKey) await c.env.MEDIA.delete(existing.audio_key).catch(() => {});
    const cols = Object.keys(fields);
    await run(c.env, `UPDATE episodes SET ${cols.map((k) => `${k} = ?`).join(', ')}, slug = ? WHERE id = ?`, ...cols.map((k) => (fields as any)[k]), slug, existing.id);
    const ep = { ...existing, ...fields, slug };
    if (status === 'published' && existing.status !== 'published') await emitEp(c.env, 'podcast.episode.published', ep, show);
    else await emitEp(c.env, 'podcast.episode.updated', ep, show);
    return { id: existing.id };
  }
  const eid = id();
  await insert(c.env, 'episodes', { id: eid, podcast_id: show.id, pub_id: show.pub_id, guid: crypto.randomUUID(), slug, ...fields, created_at: now() });
  if (status === 'published') await emitEp(c.env, 'podcast.episode.published', { id: eid, ...fields, slug }, show);
  return { id: eid };
}

dash.post('/:id/episodes/new', async (c) => {
  const show = await getShow(c, c.req.param('id'));
  if (!show) return c.notFound();
  const r = await saveEpisode(c, show, null);
  if (r.error) return back(c, `/app/podcasts/${show.id}/episodes/new`, r.error, 'err');
  return back(c, `/app/podcasts/${show.id}/episodes/${r.id}`, 'Episode created');
});

dash.post('/:id/episodes/:eid', async (c) => {
  const show = await getShow(c, c.req.param('id'));
  const ep = show && (await one<any>(c.env, 'SELECT * FROM episodes WHERE id = ? AND podcast_id = ?', c.req.param('eid'), show.id));
  if (!show || !ep) return c.notFound();
  const r = await saveEpisode(c, show, ep);
  if (r.error) return back(c, `/app/podcasts/${show.id}/episodes/${ep.id}`, r.error, 'err');
  return back(c, `/app/podcasts/${show.id}/episodes/${ep.id}`, 'Episode saved');
});

dash.post('/:id/episodes/:eid/:action{archive|unarchive|delete|transcribe}', async (c) => {
  const show = await getShow(c, c.req.param('id'));
  const ep = show && (await one<any>(c.env, 'SELECT * FROM episodes WHERE id = ? AND podcast_id = ?', c.req.param('eid'), show.id));
  if (!show || !ep) return c.notFound();
  const base = `/app/podcasts/${show.id}`;
  switch (c.req.param('action')) {
    case 'archive':
      await run(c.env, `UPDATE episodes SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?`, now(), now(), ep.id);
      await emitEp(c.env, 'podcast.episode.archived', { ...ep, status: 'archived' }, show);
      return back(c, base, 'Episode archived — removed from feeds');
    case 'unarchive':
      await run(c.env, `UPDATE episodes SET status = 'draft', archived_at = NULL, updated_at = ? WHERE id = ?`, now(), ep.id);
      return back(c, `${base}/episodes/${ep.id}`, 'Episode restored as a draft');
    case 'delete':
      if (ep.audio_key) await c.env.MEDIA.delete(ep.audio_key).catch(() => {});
      await run(c.env, 'DELETE FROM episode_downloads WHERE episode_id = ?', ep.id);
      await run(c.env, 'DELETE FROM episodes WHERE id = ?', ep.id);
      await emitEp(c.env, 'podcast.episode.deleted', ep, show);
      return back(c, base, 'Episode deleted');
    case 'transcribe': {
      if (!aiEnabled(c.env)) return back(c, `${base}/episodes/${ep.id}`, AI_DISABLED_MSG + ' You can paste or upload a transcript instead.', 'err');
      let audio: ArrayBuffer | null = null;
      if (ep.audio_key) audio = (await (await c.env.MEDIA.get(ep.audio_key))?.arrayBuffer()) || null;
      else if (ep.audio_url) audio = await fetch(ep.audio_url).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
      if (!audio) return back(c, `${base}/episodes/${ep.id}`, 'Audio file not found', 'err');
      if (audio.byteLength > 25 * 1024 * 1024) return back(c, `${base}/episodes/${ep.id}`, 'Audio is larger than 25 MB — upload a transcript file instead.', 'err');
      const t = await aiTranscribe(c.env, audio);
      if (!t.ok) return back(c, `${base}/episodes/${ep.id}`, t.text, 'err');
      await run(c.env, 'UPDATE episodes SET transcript = ?, transcript_vtt = ?, updated_at = ? WHERE id = ?', t.text, t.vtt || null, now(), ep.id);
      return back(c, `${base}/episodes/${ep.id}`, 'Transcript generated');
    }
  }
  return c.notFound();
});

// ───────────────── public site ─────────────────
async function showBySlug(c: Ctx) {
  return one<any>(c.env, 'SELECT * FROM podcasts WHERE pub_id = ? AND slug = ?', c.get('pub').id, c.req.param('show'));
}

function canHearPremium(c: Ctx) {
  return !!c.get('reader')?.premium;
}

const Player = (p: { src: string; title?: string }) => <audio class="pod-audio" controls preload="none" src={p.src} title={p.title} />;

site.get('/podcasts', async (c) => {
  const pub = c.get('pub');
  const base = siteUrl(c.env, pub);
  const shows = await all<any>(c.env, `SELECT p.*, (SELECT COUNT(*) FROM episodes e WHERE e.podcast_id = p.id AND e.status = 'published') AS eps FROM podcasts p WHERE p.pub_id = ? ORDER BY p.created_at`, pub.id);
  await trackView(c);
  return c.html(await SiteLayout({
    c, title: 'Podcasts', description: `Podcasts from ${pub.name}`, head: <link rel="stylesheet" href="/static/podcast-site.css" />,
    children: (
      <section class="s-wrap s-section">
        <h1>Podcasts</h1>
        {shows.length ? (
          <div class="s-grid">{shows.map((s) => (
            <a class="s-card" href={`${base}/podcasts/${s.slug}`}>
              {s.cover_url ? <img class="pod-cover" src={s.cover_url} alt="" loading="lazy" /> : <div class="pod-cover pod-cover-empty">🎙</div>}
              <h3>{s.title}</h3>
              <p>{truncate(stripTags(s.description), 140)}</p>
              <div class="s-meta">{s.eps} episodes{s.access !== 'public' ? <span class="s-lock">🔒 Premium</span> : null}</div>
            </a>
          ))}</div>
        ) : <p class="s-muted">No podcasts yet.</p>}
      </section>
    ),
  }));
});

site.get('/podcasts/:show/feed.xml', async (c) => {
  const pub = c.get('pub');
  const show = await showBySlug(c);
  if (!show) return c.text('Not found', 404);
  if (show.redirect_url && c.req.query('preview') !== '1') return c.redirect(show.redirect_url, 301);
  if (show.access === 'premium' && c.req.query('preview') !== '1') return c.text('This podcast is for paid subscribers. Use your private feed link.', 403);
  const eps = await all<any>(c.env, `SELECT * FROM episodes WHERE podcast_id = ? AND status = 'published' AND premium = 0 AND (audio_key IS NOT NULL OR audio_url IS NOT NULL) ORDER BY published_at DESC LIMIT 1000`, show.id);
  return c.body(feedXml(c.env, pub, show, eps, null), 200, { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=300' });
});

site.get('/podcasts/:show/private/:token/feed.xml', async (c) => {
  const pub = c.get('pub');
  const show = await showBySlug(c);
  if (!show) return c.text('Not found', 404);
  const t = await one<any>(c.env, 'SELECT * FROM podcast_feed_tokens WHERE token = ? AND podcast_id = ?', c.req.param('token'), show.id);
  if (!t || t.revoked_at) return c.text('This private feed is no longer active. Renew your subscription to restore access.', 403);
  const sub = await one<Subscriber>(c.env, 'SELECT * FROM subscribers WHERE id = ?', t.subscriber_id);
  if (!sub || sub.status !== 'active') return c.text('Subscription inactive', 403);
  await run(c.env, 'UPDATE podcast_feed_tokens SET last_access_at = ? WHERE token = ?', now(), t.token);
  if (await rateLimit(c.env, 'pfeed:' + t.token, 1, 86400))
    c.executionCtx.waitUntil(emit(c.env, { pubId: pub.id, type: 'podcast.private_feed.accessed', subscriberId: sub.id, refId: show.id, data: { podcast: { id: show.id, title: show.title }, user_agent: c.req.header('user-agent') || '' } }));
  const eps = await all<any>(c.env, `SELECT * FROM episodes WHERE podcast_id = ? AND status = 'published' AND (audio_key IS NOT NULL OR audio_url IS NOT NULL) ORDER BY published_at DESC LIMIT 1000`, show.id);
  return c.body(feedXml(c.env, pub, show, eps, t.token), 200, { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'private, max-age=300', 'x-robots-tag': 'noindex' });
});

function feedXml(env: Env, pub: Publication, show: any, eps: any[], tok: string | null) {
  const base = siteUrl(env, pub);
  const items: FeedEpisode[] = eps.map((e) => ({
    guid: e.guid, title: e.title, description: e.description || '', enclosure: listenUrl(env, e.id, tok), mime: e.mime, size: e.size, duration: e.duration,
    season: e.season, number: e.number, episode_type: e.episode_type, explicit: e.explicit, image: e.image_url, published_at: e.published_at || e.created_at,
    link: `${base}/podcasts/${show.slug}/${e.slug}`, transcriptUrl: e.transcript ? `${base}/podcasts/${show.slug}/${e.slug}/transcript.txt` : null,
  }));
  return buildFeed({
    title: show.title, description: show.description || pub.description, author: show.author || pub.name, owner_email: show.owner_email, cover_url: show.cover_url || pub.logo_url,
    language: show.language, category: show.category, subcategory: show.subcategory, explicit: show.explicit, kind: show.kind, copyright: show.copyright, redirect_url: show.redirect_url,
    link: `${base}/podcasts/${show.slug}`, selfUrl: tok ? `${base}/podcasts/${show.slug}/private/${tok}/feed.xml` : `${base}/podcasts/${show.slug}/feed.xml`, guid: show.id,
  }, items, { privateFeed: !!tok });
}

site.get('/podcasts/:show', async (c) => {
  const pub = c.get('pub');
  const base = siteUrl(c.env, pub);
  const show = await showBySlug(c);
  if (!show) return SiteMessage(c, 'Podcast not found', <p>This show doesn't exist.</p>, 404);
  const eps = await all<any>(c.env, `SELECT * FROM episodes WHERE podcast_id = ? AND status = 'published' ORDER BY ${show.kind === 'serial' ? 'season, number, published_at' : 'published_at DESC'}`, show.id);
  const reader = c.get('reader');
  const premium = canHearPremium(c);
  let privateUrl: string | null = null;
  if (premium && reader?.subscriber && show.access !== 'public') privateUrl = privateFeedUrl(c.env, pub, show, await ensureFeedToken(c.env, show.id, reader.subscriber.id));
  const feed = `${base}/podcasts/${show.slug}/feed.xml`;
  await trackView(c, show.id);
  return c.html(await SiteLayout({
    c, title: show.title, description: truncate(stripTags(show.description), 200), image: show.cover_url, head: <><link rel="stylesheet" href="/static/podcast-site.css" /><link rel="alternate" type="application/rss+xml" title={show.title} href={feed} /></>,
    jsonld: { '@context': 'https://schema.org', '@type': 'PodcastSeries', name: show.title, description: stripTags(show.description), image: show.cover_url, url: `${base}/podcasts/${show.slug}`, webFeed: feed, author: { '@type': 'Person', name: show.author || pub.name } },
    children: (
      <div class="s-wrap s-section">
        <header class="pod-hero">
          {show.cover_url ? <img class="pod-hero-cover" src={show.cover_url} alt="" /> : <div class="pod-hero-cover pod-cover-empty">🎙</div>}
          <div>
            <h1>{show.title}</h1>
            <p class="s-muted">{show.author}{show.author ? ' · ' : ''}{show.category}{show.subcategory ? ` › ${show.subcategory}` : ''}</p>
            <div class="pod-desc">{raw(sanitizeHtml(show.description.replace(/\n/g, '<br>'), { blocks: true }))}</div>
            <div class="pod-links">
              {show.apple_url && <a class="s-btn s-btn-ghost" href={show.apple_url} target="_blank" rel="noopener">Apple Podcasts</a>}
              {show.spotify_url && <a class="s-btn s-btn-ghost" href={show.spotify_url} target="_blank" rel="noopener">Spotify</a>}
              {show.youtube_url && <a class="s-btn s-btn-ghost" href={show.youtube_url} target="_blank" rel="noopener">YouTube</a>}
              {show.access !== 'premium' && <button type="button" class="s-btn s-btn-ghost" data-copy={feed}>Copy RSS</button>}
            </div>
          </div>
        </header>
        {show.access !== 'public' && (
          <div class="s-box pod-private">
            {privateUrl ? (
              <><strong>🔒 Your private premium feed</strong><p class="s-muted">Add this personal link to your podcast app to get every premium episode. Don't share it.</p><div class="oh-copy"><input readonly value={privateUrl} /><button type="button" data-copy={privateUrl}>Copy</button></div></>
            ) : (
              <><strong>🔒 Premium episodes</strong><p class="s-muted">Paid subscribers get a private feed with every episode, ad-free in their favorite app.</p><a class="s-btn" href={`${base}/upgrade`}>Upgrade to listen</a>{!reader && <> <button type="button" class="s-btn s-btn-ghost" data-modal="login">Log in</button></>}</>
            )}
          </div>
        )}
        <h2 style="margin-top:32px">Episodes</h2>
        <div class="pod-list">
          {eps.length ? eps.map((e) => {
            const locked = (e.premium || show.access === 'premium') && !premium;
            return (
              <article class="pod-ep">
                <div class="pod-ep-meta s-meta">{fmtDate(e.published_at, { dateStyle: 'medium' }, pub.timezone)} · {fmtDuration(e.duration)}{e.season ? ` · S${e.season}` : ''}{e.number ? ` E${e.number}` : ''}{locked ? <span class="s-lock">🔒 Premium</span> : null}</div>
                <h3><a href={`${base}/podcasts/${show.slug}/${e.slug}`}>{e.title}</a></h3>
                <p class="s-muted">{truncate(stripTags(e.description || ''), 220)}</p>
                {!locked && <Player src={listenUrl(c.env, e.id)} title={e.title} />}
              </article>
            );
          }) : <p class="s-muted">No episodes published yet.</p>}
        </div>
      </div>
    ),
  }));
});

site.get('/podcasts/:show/:episode/transcript.txt', async (c) => {
  const show = await showBySlug(c);
  const ep = show && (await one<any>(c.env, `SELECT * FROM episodes WHERE podcast_id = ? AND slug = ? AND status = 'published'`, show.id, c.req.param('episode')));
  if (!show || !ep || !ep.transcript) return c.text('Not found', 404);
  if ((ep.premium || show.access === 'premium') && !canHearPremium(c)) return c.text('Premium', 403);
  return c.text(ep.transcript);
});

site.get('/podcasts/:show/:episode', async (c) => {
  const pub = c.get('pub');
  const base = siteUrl(c.env, pub);
  const show = await showBySlug(c);
  const ep = show && (await one<any>(c.env, `SELECT * FROM episodes WHERE podcast_id = ? AND slug = ? AND status = 'published'`, show.id, c.req.param('episode')));
  if (!show || !ep) return SiteMessage(c, 'Episode not found', <p>This episode doesn't exist or isn't published yet.</p>, 404);
  const locked = (ep.premium || show.access === 'premium') && !canHearPremium(c);
  const more = await all<any>(c.env, `SELECT title, slug, published_at, duration FROM episodes WHERE podcast_id = ? AND status = 'published' AND id != ? ORDER BY published_at DESC LIMIT 5`, show.id, ep.id);
  const url = `${base}/podcasts/${show.slug}/${ep.slug}`;
  await trackView(c, ep.id);
  return c.html(await SiteLayout({
    c, title: `${ep.title} — ${show.title}`, description: truncate(stripTags(ep.description || show.description), 200), image: ep.image_url || show.cover_url, canonical: url,
    head: <link rel="stylesheet" href="/static/podcast-site.css" />,
    jsonld: { '@context': 'https://schema.org', '@type': 'PodcastEpisode', name: ep.title, url, datePublished: new Date(ep.published_at).toISOString(), description: stripTags(ep.description || ''), timeRequired: `PT${Math.round(ep.duration / 60)}M`, episodeNumber: ep.number || undefined, associatedMedia: locked ? undefined : { '@type': 'MediaObject', contentUrl: listenUrl(c.env, ep.id) }, partOfSeries: { '@type': 'PodcastSeries', name: show.title, url: `${base}/podcasts/${show.slug}` } },
    children: (
      <article class="s-article">
        <a class="s-muted pod-back" href={`${base}/podcasts/${show.slug}`}>← {show.title}</a>
        <header class="pod-ep-hero">
          {(ep.image_url || show.cover_url) && <img src={ep.image_url || show.cover_url} alt="" class="pod-ep-cover" />}
          <div>
            <div class="s-meta">{fmtDate(ep.published_at, { dateStyle: 'long' }, pub.timezone)} · {fmtDuration(ep.duration)}{ep.season ? ` · Season ${ep.season}` : ''}{ep.number ? ` · Episode ${ep.number}` : ''}</div>
            <h1>{ep.title}</h1>
          </div>
        </header>
        {locked ? (
          <div class="oh-paywall"><h3>🔒 This is a premium episode</h3><p>Upgrade to listen and get a private feed for your podcast app.</p><div class="oh-paywall-actions"><a class="oh-btn" href={`${base}/upgrade`}>Upgrade</a> <button type="button" class="oh-btn oh-btn-ghost" data-modal="login">Log in</button></div></div>
        ) : (
          <div class="pod-player"><Player src={listenUrl(c.env, ep.id)} title={ep.title} /><a class="s-small s-muted" href={listenUrl(c.env, ep.id)} download>Download MP3</a></div>
        )}
        <div class="s-body">{raw(sanitizeHtml(ep.description || '', { blocks: true }))}</div>
        {ep.transcript && !locked && (
          <details class="pod-transcript"><summary>Transcript</summary><div>{ep.transcript.split(/\n{2,}|\r\n\r\n/).map((para: string) => <p>{para.replace(/^WEBVTT\s*/, '')}</p>)}</div></details>
        )}
        {more.length > 0 && (
          <section class="pod-more"><h3>More episodes</h3>{more.map((m) => <a href={`${base}/podcasts/${show.slug}/${m.slug}`}><span>{m.title}</span><small class="s-muted">{fmtDate(m.published_at)} · {fmtDuration(m.duration)}</small></a>)}</section>
        )}
      </article>
    ),
  }));
});

// ───────────────── tracked downloads ─────────────────
root.get('/listen/:file', async (c) => {
  const epId = c.req.param('file').replace(/\.(mp3|m4a)$/, '');
  const ep = await one<any>(c.env, `SELECT e.*, p.access, p.pub_id AS ppub FROM episodes e JOIN podcasts p ON p.id = e.podcast_id WHERE e.id = ?`, epId);
  if (!ep || (!ep.audio_key && !ep.audio_url)) return c.text('Not found', 404);
  const preview = c.req.query('preview') === '1';
  // Access control: premium episodes need a valid private-feed token, a premium reader session, or a team preview
  let allowed = ep.status === 'published' && !ep.premium && ep.access !== 'premium';
  const k = c.req.query('k');
  if (!allowed && k) {
    const t = await one<any>(c.env, `SELECT t.*, s.status FROM podcast_feed_tokens t JOIN subscribers s ON s.id = t.subscriber_id WHERE t.token = ? AND t.podcast_id = ? AND t.revoked_at IS NULL`, k, ep.podcast_id);
    allowed = !!t && t.status === 'active' && ep.status === 'published';
  }
  if (!allowed && ep.status === 'published') {
    const email = await readerEmail(c);
    if (email) {
      const s = await one<Subscriber>(c.env, 'SELECT * FROM subscribers WHERE pub_id = ? AND email = ?', ep.ppub, email);
      allowed = !!s && s.status === 'active' && (s.tier === 'premium' || (!!s.trial_ends_at && s.trial_ends_at > now()));
    }
  }
  if (!allowed && preview) {
    const { currentUser, userPubs } = await import('../lib/auth');
    const u = await currentUser(c);
    allowed = !!u && (await userPubs(c.env, u.id)).some((p) => p.id === ep.ppub);
  }
  if (!allowed) return c.text('This episode is for premium subscribers.', 403);

  if (!preview) {
    const range = c.req.header('range') || '';
    const m = range.match(/bytes=(\d*)-(\d*)/);
    const probe = !!m && m[1] !== '' && m[2] !== '' && Number(m[2]) - Number(m[1]) < 2;
    if (!probe && c.req.method === 'GET') c.executionCtx.waitUntil(recordDownload(c.env, ep, c.req.raw, m ? Number(m[1] || 0) : 0).catch(() => {}));
  }
  if (!ep.audio_key) return c.redirect(ep.audio_url, 302);
  return serveObject(c.env, ep.audio_key, c.req.raw, { 'cache-control': 'private, max-age=3600', 'content-disposition': `inline; filename="${slugify(ep.title)}.mp3"` });
});

async function recordDownload(env: Env, ep: any, req: Request, offset: number) {
  const ua = req.headers.get('user-agent') || '';
  const day = new Date().toISOString().slice(0, 10);
  const hash = (await sha256(`${clientIP(req)}|${ua}`)).slice(0, 32);
  const bot = !!classifyCrawler(ua) || (!/podcast|spotify|overcast|castro|pocket|castbox|apple|itunes|corem|stitcher|deezer|amazon|alexa|player|antenna|fountain|podverse|audible|mozilla/i.test(ua) && isBotClick(ua)) ? 1 : 0;
  await run(env, `INSERT OR IGNORE INTO episode_downloads (id, episode_id, podcast_id, pub_id, listener_hash, app, device, country, is_bot, bytes, day, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id(), ep.id, ep.podcast_id, ep.pub_id, hash, detectApp(ua), detectDevice(ua), (req as any).cf?.country ?? null, bot, offset, day, now());
}

export default { dash, site, root } satisfies Module;
