/** @jsxImportSource hono/jsx */
// Module: ad audiences — hashed segment exports for Google Ads Customer Match and Meta Custom Audiences, plus
// secret re-export URLs an ads tool can pull on a schedule. Replaces "retargeting ads" by feeding the user's own ad accounts.
import { Hono } from 'hono';
import type { AppEnv, Ctx, Module } from '../types';
import { one, all, run, insert } from '../lib/db';
import { requirePerm, audit } from '../lib/auth';
import { rateLimit, clientIP } from '../lib/guard';
import { appUrl } from '../lib/pub';
import { AD_PLATFORMS, audienceCsv, segmentName, type AdPlatform } from '../lib/adaudiences';
import { id, now, token, sha256, form, str, num, ago } from '../lib/util';
import { DashLayout } from '../ui/layout';
import { Card, Field, Select, Btn, ActionForm, Table, Badge, Help, Copy, Grid, Input } from '../ui/components';

const dash = new Hono<AppEnv>();
const root = new Hono<AppEnv>();

const isPlatform = (p: string): p is AdPlatform => p === 'google' || p === 'meta';

async function segmentOptions(c: Ctx): Promise<Array<[string, string]>> {
  const segs = await all<{ id: string; name: string; cached_count: number }>(c.env, 'SELECT id, name, cached_count FROM segments WHERE pub_id = ? ORDER BY name', c.get('pub').id);
  return [['all', 'All active subscribers'], ...segs.map((s) => [s.id, `${s.name} (${num(s.cached_count)})`] as [string, string])];
}

function feedUrl(c: Ctx, tok: string) {
  return appUrl(c.env, `/audiences/${tok}.csv`);
}

async function overview(c: Ctx, freshId?: string, freshTok?: string) {
  const pub = c.get('pub');
  const segs = await segmentOptions(c);
  const pre = c.req.query('segment') || 'all';
  const feeds = await all<any>(c.env, `SELECT f.*, s.name AS segment_name FROM ad_audience_feeds f LEFT JOIN segments s ON s.id = f.segment_id WHERE f.pub_id = ? ORDER BY f.revoked_at IS NOT NULL, f.created_at DESC`, pub.id);
  const fresh = freshId ? await one<any>(c.env, 'SELECT * FROM ad_audience_feeds WHERE id = ? AND pub_id = ?', freshId, pub.id) : null;
  return c.html(
    <DashLayout c={c} title="Ad audiences" section="marketing" sub="adaudiences">
      <div class="callout" data-retargeting-note>
        <strong>Retargeting, done with your own ad accounts.</strong> Instead of buying “retargeting ads” through us, export any segment as a privacy-safe customer list and upload it to <strong>Google Ads Customer Match</strong> or <strong>Meta Custom Audiences</strong>. Use it to reach your readers (or build lookalike audiences, or exclude existing subscribers from acquisition ads) on Google Search, YouTube, Gmail, Facebook and Instagram. Emails are normalized and SHA-256 hashed before they leave this platform; the ad networks match the hashes to their own users.
      </div>
      {fresh && freshTok && (
        <Card title="Your new audience URL — copy it now">
          <p>This is the only time the full URL is shown. Anyone with it can download the hashed list for <strong>{fresh.name}</strong>.</p>
          <Copy value={feedUrl(c, freshTok)} />
          <Help>Point your ads tool's scheduled customer-list import (or a sync service such as Zapier, Make or a Google Ads script) at this URL. It always returns the segment's current members.</Help>
        </Card>
      )}
      <Grid>
        <Card title="Download a hashed audience file">
          <form method="get" action="/app/ad-audiences/download" class="stack">
            <Field label="Segment"><Select name="segment" value={pre} options={segs} /></Field>
            <Field label="Format">
              <Select name="platform" options={[['google', AD_PLATFORMS.google.label], ['meta', AD_PLATFORMS.meta.label]]} />
            </Field>
            <Btn>Download CSV</Btn>
          </form>
          <Help>Only active subscribers are included; unsubscribed, bounced and complained addresses never are. Make sure your privacy policy allows sharing hashed contact data with advertising platforms and that your readers consented, as Google's and Meta's customer-list policies require.</Help>
        </Card>
        <Card title="Scheduled re-export link">
          <form method="post" action="/app/ad-audiences/feeds" class="stack">
            <Field label="Segment"><Select name="segment" value={pre} options={segs} /></Field>
            <Field label="Format"><Select name="platform" options={[['google', AD_PLATFORMS.google.label], ['meta', AD_PLATFORMS.meta.label]]} /></Field>
            <Field label="Name (optional)"><Input name="name" placeholder="e.g. Engaged readers → Meta" /></Field>
            <Btn kind="secondary">Create secret URL</Btn>
          </form>
          <Help>A private URL that always serves the current hashed list, for tools that pull a customer list on a schedule. Revoke it any time.</Help>
        </Card>
      </Grid>
      <Card title="How to upload">
        <ul class="small">
          <li><strong>{AD_PLATFORMS.google.label}:</strong> {AD_PLATFORMS.google.upload} <a href={AD_PLATFORMS.google.doc} target="_blank" rel="noopener">Google's guide ↗</a> — Gmail addresses are normalized without dots, as Google requires.</li>
          <li><strong>{AD_PLATFORMS.meta.label}:</strong> {AD_PLATFORMS.meta.upload} <a href={AD_PLATFORMS.meta.doc} target="_blank" rel="noopener">Meta's guide ↗</a></li>
        </ul>
      </Card>
      <Card title="Secret URLs" pad={false}>
        <Table<any> rows={feeds} empty={<div style="padding:18px" class="muted">No re-export URLs yet.</div>} cols={[
          { h: 'Audience', r: (f) => <><strong>{f.name}</strong><div class="small muted">{AD_PLATFORMS[f.platform as AdPlatform]?.label} · {f.segment_id === 'all' ? 'All active subscribers' : f.segment_name || '(deleted segment)'}</div></> },
          { h: 'URL', r: (f) => <code class="small">/audiences/{f.token_hint}…</code> },
          { h: 'Pulls', r: (f) => <span class="small">{f.pull_count} {f.last_pulled_at ? `· last ${ago(f.last_pulled_at)} (${num(f.last_rows || 0)} rows)` : ''}</span> },
          { h: '', class: 'right', r: (f) => f.revoked_at ? <Badge>revoked</Badge> : <ActionForm action={`/app/ad-audiences/feeds/${f.id}/revoke`} label="Revoke" kind="danger" confirm="Revoke this URL? Tools pulling it will stop receiving the list." /> },
        ]} />
      </Card>
    </DashLayout>,
  );
}

dash.get('/', requirePerm('admin'), (c) => overview(c));

dash.get('/download', requirePerm('admin'), async (c) => {
  const pub = c.get('pub');
  const seg = str(c.req.query('segment'), 40) || 'all';
  const platform = str(c.req.query('platform'), 10);
  if (!isPlatform(platform)) return c.text('Unknown platform', 400);
  const name = await segmentName(c.env, pub.id, seg);
  if (!name) return c.notFound();
  const { csv, rows } = await audienceCsv(c.env, pub.id, seg, platform);
  await audit(c, 'adaudience.export', seg, { platform, rows });
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${pub.slug}-${platform}-audience-${new Date().toISOString().slice(0, 10)}.csv"`, 'x-audience-rows': String(rows) } });
});

dash.post('/feeds', requirePerm('admin'), async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const seg = str(f.segment, 40) || 'all';
  const platform = str(f.platform, 10);
  if (!isPlatform(platform)) return c.text('Unknown platform', 400);
  const sname = await segmentName(c.env, pub.id, seg);
  if (!sname) return c.notFound();
  const tok = `aud_${token(24)}`;
  const fid = id();
  await insert(c.env, 'ad_audience_feeds', { id: fid, pub_id: pub.id, segment_id: seg, platform, name: str(f.name, 120) || `${sname} → ${platform === 'google' ? 'Google' : 'Meta'}`, token_hash: await sha256(tok), token_hint: tok.slice(0, 10), pull_count: 0, created_by: c.get('user').id, created_at: now() });
  await audit(c, 'adaudience.feed_create', fid, { platform, segment: seg });
  // Shown once in this response (never in a URL or the database; only its hash is stored).
  c.header('cache-control', 'no-store');
  return overview(c, fid, tok);
});

dash.post('/feeds/:id/revoke', requirePerm('admin'), async (c) => {
  await run(c.env, 'UPDATE ad_audience_feeds SET revoked_at = ? WHERE id = ? AND pub_id = ? AND revoked_at IS NULL', now(), c.req.param('id'), c.get('pub').id);
  await audit(c, 'adaudience.feed_revoke', c.req.param('id'));
  return c.redirect('/app/ad-audiences', 303);
});

// Public pull URL (secret token). No cookies or session; the token alone authorizes this one list.
root.get('/audiences/:file', async (c) => {
  const tok = c.req.param('file').replace(/\.csv$/, '');
  if (!/^aud_[A-Za-z0-9_-]{20,}$/.test(tok)) return c.text('Not found', 404);
  if (!(await rateLimit(c.env, `audfeed:${clientIP(c.req.raw)}`, 60, 3600))) return c.text('Too many requests', 429);
  const feed = await one<any>(c.env, 'SELECT * FROM ad_audience_feeds WHERE token_hash = ? AND revoked_at IS NULL', await sha256(tok));
  if (!feed || !isPlatform(feed.platform)) return c.text('Not found', 404);
  if (!(await segmentName(c.env, feed.pub_id, feed.segment_id))) return c.text('Segment deleted', 410);
  const { csv, rows } = await audienceCsv(c.env, feed.pub_id, feed.segment_id, feed.platform);
  await run(c.env, 'UPDATE ad_audience_feeds SET pull_count = pull_count + 1, last_pulled_at = ?, last_rows = ? WHERE id = ?', now(), rows, feed.id);
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'content-disposition': `inline; filename="audience-${feed.platform}.csv"` } });
});

export default { dash, root } satisfies Module;
