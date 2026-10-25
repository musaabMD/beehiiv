/** @jsxImportSource hono/jsx */
// Ad network: network campaigns (instance superadmins) with brand-safety review, publisher opportunities,
// one-click insertion into posts, bot-filtered click tracking, earnings and post-by-post revenue reports.
import type { Hono } from 'hono';
import type { AppEnv, Ctx } from '../../types';
import { one, all, run, insert } from '../../lib/db';
import { requirePerm } from '../../lib/auth';
import { isBotClick, rateLimit, clientIP } from '../../lib/guard';
import { recordClick } from '../../lib/tracking';
import { creditAd } from '../../lib/billing';
import { progSettings, programmaticReport, candidates, PROG_DEFAULTS } from '../../lib/programmatic';
import { Toggle, Check } from '../../ui/components';
import { DashLayout } from '../../ui/layout';
import { Card, Stats, Stat, Table, Btn, Field, Input, Textarea, Select, Status, Empty, Modal, OpenBtn, ActionForm, back, Grid, Tabs, Badge, Help } from '../../ui/components';
import { id, now, money, num, pct, fmtDate, form, str, int, cents, parseJSON, sha256, DAY } from '../../lib/util';

const CATEGORIES = ['business', 'technology', 'finance', 'marketing', 'health', 'lifestyle', 'education', 'news', 'culture', 'sports', 'travel', 'food'];

function isAdmin(c: Ctx) {
  return !!c.get('user')?.is_superadmin || (c.env.SUPERADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).includes(c.get('user')?.email);
}

/** Make approved network campaigns visible to this publication as opportunities. */
async function materialize(c: Ctx) {
  const pub = c.get('pub');
  const t = now();
  const camps = await all<any>(c.env, `SELECT c.id FROM ad_campaigns c WHERE c.owner_pub_id IS NULL AND c.review_status = 'approved' AND c.status = 'active' AND (c.ends_at IS NULL OR c.ends_at > ?) AND (c.budget_cents = 0 OR c.spent_cents < c.budget_cents) AND NOT EXISTS (SELECT 1 FROM ad_opportunities o WHERE o.campaign_id = c.id AND o.pub_id = ? AND o.programmatic = 0)`, t, pub.id);
  for (const k of camps) await insert(c.env, 'ad_opportunities', { id: id(), campaign_id: k.id, pub_id: pub.id, status: 'available', created_at: t });
}

const priceLabel = (k: any) => (k.pricing === 'cpc' ? `${money(k.rate_cents)} per click` : k.pricing === 'cpm' ? `${money(k.rate_cents)} CPM` : `${money(k.rate_cents)} flat`);

async function upcomingPosts(c: Ctx) {
  return all<any>(c.env, `SELECT id, title, status, scheduled_at FROM posts WHERE pub_id = ? AND status IN ('draft','scheduled') ORDER BY COALESCE(scheduled_at, updated_at) DESC LIMIT 50`, c.get('pub').id);
}

/** Append an ad block to a post's document (one-click insertion). */
export async function insertAdIntoPost(c: Ctx, oppId: string, postId: string): Promise<string | null> {
  const pub = c.get('pub');
  const post = await one<any>(c.env, `SELECT id, content, status FROM posts WHERE id = ? AND pub_id = ?`, postId, pub.id);
  if (!post) return 'Post not found';
  if (!['draft', 'scheduled'].includes(post.status)) return 'Ads can only be inserted into drafts or scheduled posts';
  const doc = parseJSON<any>(post.content, { blocks: [] });
  doc.blocks = Array.isArray(doc.blocks) ? doc.blocks : [];
  if (!doc.blocks.some((b: any) => b.type === 'ad' && b.data?.opportunity_id === oppId)) {
    // place after the first third of the post (a natural mid-roll), or at the end for short posts
    const at = doc.blocks.length > 6 ? Math.ceil(doc.blocks.length / 3) : doc.blocks.length;
    doc.blocks.splice(at, 0, { id: 'b' + id(8), type: 'ad', data: { opportunity_id: oppId, label: 'Together with' } });
  }
  await run(c.env, 'UPDATE posts SET content = ?, updated_at = ? WHERE id = ?', JSON.stringify(doc), now(), post.id);
  await run(c.env, `UPDATE ad_opportunities SET post_id = ?, status = 'placed' WHERE id = ? AND pub_id = ?`, post.id, oppId, pub.id);
  return null;
}

export function registerAds(dash: Hono<AppEnv>, root: Hono<AppEnv>) {
  dash.get('/ads', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    await materialize(c);
    const tab = c.req.query('tab') || 'available';
    const opps = await all<any>(c.env, `SELECT o.*, c.name AS cname, c.headline, c.body, c.image_url, c.url, c.pricing, c.rate_cents, c.categories, c.link_params, c.ends_at, a.name AS advertiser, a.logo_url, p.title AS post_title FROM ad_opportunities o JOIN ad_campaigns c ON c.id = o.campaign_id JOIN advertisers a ON a.id = c.advertiser_id LEFT JOIN posts p ON p.id = o.post_id WHERE o.pub_id = ? AND c.owner_pub_id IS NULL ORDER BY o.created_at DESC`, pub.id);
    const posts = await upcomingPosts(c);
    const earned = opps.reduce((a, o) => a + o.earned_cents, 0);
    const clicks = opps.reduce((a, o) => a + o.clicks, 0), bots = opps.reduce((a, o) => a + o.bot_clicks, 0);
    const available = opps.filter((o) => o.status === 'available');
    const placements = opps.filter((o) => ['accepted', 'placed', 'completed'].includes(o.status));
    const history = opps.filter((o) => o.status !== 'available');
    const byPost = await all<any>(c.env, `SELECT p.id, p.title, p.published_at, COUNT(o.id) AS ads, SUM(o.impressions) AS imp, SUM(o.clicks) AS clicks, SUM(o.bot_clicks) AS bots, SUM(o.earned_cents) AS earned FROM ad_opportunities o JOIN posts p ON p.id = o.post_id WHERE o.pub_id = ? GROUP BY p.id ORDER BY p.published_at DESC LIMIT 100`, pub.id);
    const tabs: Array<[string, string]> = [['?tab=available', `Available (${available.length})`], ['?tab=programmatic', 'Programmatic'], ['?tab=placements', 'Placements & earnings'], ['?tab=report', 'Revenue by post'], ['?tab=history', 'History'], ...(isAdmin(c) ? [['?tab=network', 'Network admin'] as [string, string]] : [])];
    const oppCard = (o: any) => (
      <Card title={<>{o.logo_url && <img src={o.logo_url} alt="" width="20" height="20" style="vertical-align:middle;border-radius:4px;margin-right:6px" />}{o.advertiser} · {o.cname}</>} actions={<Badge tone="green">{priceLabel(o)}</Badge>}>
        <Grid>
          <div>
            {o.image_url && <img src={o.image_url} alt="" style="width:100%;border-radius:8px;margin-bottom:8px" />}
            <strong>{o.headline}</strong>
            <p class="muted">{o.body}</p>
            <small class="muted">{parseJSON<string[]>(o.categories, []).join(' · ')}{o.ends_at ? ` · runs until ${fmtDate(o.ends_at)}` : ''}</small>
          </div>
          <div>
            <form method="post" action={`/app/monetize/ads/${o.id}/accept`} class="stack-sm">
              <Field label="Place in post"><Select name="post_id" options={[['', 'Decide later'], ...posts.map((p) => [p.id, `${p.title || '(untitled)'} — ${p.status}${p.scheduled_at ? ' ' + fmtDate(p.scheduled_at) : ''}`] as [string, string])]} /></Field>
              <Field label="Planned send date"><Input name="date" type="date" /></Field>
              <Btn>Claim this ad</Btn>
            </form>
            <ActionForm action={`/app/monetize/ads/${o.id}/decline`} label="Decline" kind="ghost" />
          </div>
        </Grid>
      </Card>
    );
    let body;
    if (tab === 'network' && isAdmin(c)) body = await networkAdmin(c);
    else if (tab === 'programmatic') body = await programmaticTab(c);
    else if (tab === 'placements') body = (
      <Card pad={false}>
        <Table rows={placements} empty="No placements yet — claim an available ad." cols={[
          { h: 'Campaign', r: (o) => <>{o.advertiser}<br /><small class="muted">{o.cname} · {priceLabel(o)}</small></> },
          { h: 'Post', r: (o) => (o.post_title ? <a href={`/app/posts/${o.post_id}`}>{o.post_title}</a> : <form method="post" action={`/app/monetize/ads/${o.id}/insert`} class="row"><Select name="post_id" options={posts.map((p) => [p.id, p.title || '(untitled)'] as [string, string])} /><Btn small kind="secondary">Insert</Btn></form>) },
          { h: 'Impressions', r: (o) => num(o.impressions) },
          { h: 'Clicks', r: (o) => <>{num(o.clicks)}{o.bot_clicks ? <small class="muted"> (+{o.bot_clicks} bot filtered)</small> : null}</> },
          { h: 'CTR', r: (o) => pct(o.clicks, o.impressions) },
          { h: 'Earned', r: (o) => <strong>{money(o.earned_cents)}</strong> },
          { h: 'Status', r: (o) => <Status s={o.status} /> },
          { h: '', class: 'right', r: (o) => (o.post_id && o.status !== 'completed' ? <ActionForm action={`/app/monetize/ads/${o.id}/insert`} fields={{ post_id: o.post_id }} label="Re-insert block" /> : null) },
        ]} />
      </Card>
    );
    else if (tab === 'report') body = (
      <Card title="Ad revenue post by post" pad={false}>
        <Table rows={byPost} empty="Revenue appears once posts with ads are sent." cols={[
          { h: 'Post', r: (r) => <a href={`/app/posts/${r.id}`}>{r.title || '(untitled)'}</a> },
          { h: 'Sent', r: (r) => fmtDate(r.published_at) },
          { h: 'Ads', r: (r) => num(r.ads) },
          { h: 'Impressions', r: (r) => num(r.imp) },
          { h: 'Verified clicks', r: (r) => num(r.clicks) },
          { h: 'Bot clicks filtered', r: (r) => num(r.bots) },
          { h: 'Revenue', r: (r) => <strong>{money(r.earned)}</strong> },
        ]} />
      </Card>
    );
    else if (tab === 'history') body = (
      <Card title="Every opportunity you accepted or declined" pad={false}>
        <Table rows={history} empty="No decisions yet." cols={[
          { h: 'Decided', r: (o) => fmtDate(o.decided_at || o.created_at) },
          { h: 'Advertiser', r: (o) => o.advertiser },
          { h: 'Campaign', r: (o) => o.cname },
          { h: 'Offer', r: (o) => priceLabel(o) },
          { h: 'Decision', r: (o) => <Status s={o.status === 'declined' ? 'declined' : 'accepted'} /> },
          { h: 'Earned', r: (o) => money(o.earned_cents) },
        ]} />
      </Card>
    );
    else body = available.length ? <>{available.map(oppCard)}</> : <Card><Empty icon="📣" title="No ads available right now" body="New campaigns from the OpenHive ad network appear here after brand-safety review. You can also sell your own placements under Sponsorships." action={<a class="btn btn-secondary" href="/app/monetize/sponsorships">Set up sponsorships</a>} /></Card>;
    return c.html(
      <DashLayout c={c} title="Ad network" section="monetize" sub="ads">
        <Stats>
          <Stat label="Ad earnings" value={money(earned)} href="/app/monetize/wallet" sub="paid to your wallet" />
          <Stat label="Verified clicks" value={num(clicks)} sub={`${num(bots)} bot clicks filtered out`} />
          <Stat label="Live placements" value={num(placements.filter((o) => o.status !== 'completed').length)} />
          <Stat label="Available offers" value={num(available.length)} />
        </Stats>
        <Tabs items={tabs} active={tabs.find(([h]) => h === `?tab=${tab}`)?.[0] || tabs[0][0]} />
        {body}
      </DashLayout>,
    );
  });

  async function programmaticTab(c: Ctx) {
    const pub = c.get('pub');
    const cfg = progSettings(pub);
    const days = Math.min(365, Math.max(1, int(c.req.query('days'), 30)));
    const rep = await programmaticReport(c.env, pub.id, now() - days * DAY);
    const eligible = await candidates(c.env, pub, { ...cfg, enabled: true });
    const names = new Map((await all<any>(c.env, `SELECT c.id, c.name, a.name AS advertiser FROM ad_campaigns c JOIN advertisers a ON a.id = c.advertiser_id WHERE c.owner_pub_id IS NULL AND c.programmatic = 1`)).map((r) => [r.id, r]));
    const advertisers = await all<any>(c.env, `SELECT DISTINCT a.id, a.name FROM advertisers a JOIN ad_campaigns c ON c.advertiser_id = a.id WHERE c.owner_pub_id IS NULL AND c.programmatic = 1 ORDER BY a.name`);
    const ecpm = rep.emailImps ? Math.round((rep.earned / rep.emailImps) * 1000) : 0;
    return (
      <>
        <div class={`callout ${cfg.enabled ? 'ok' : ''}`}>
          {cfg.enabled
            ? <>Programmatic ads are <strong>on</strong>: every email {cfg.placement === 'manual' ? 'with a programmatic ad block' : `gets an auto-filled slot at the ${cfg.placement}`} shows the best-paying eligible campaign. {eligible.length} campaign{eligible.length === 1 ? '' : 's'} currently eligible.</>
            : <>Turn on programmatic ads to earn from every send automatically — no need to claim each campaign. Approved network campaigns fill the slot by highest expected earnings.</>}
        </div>
        <Stats>
          <Stat label={`Impressions (${days}d)`} value={num(rep.imps)} sub={`${num(rep.emailImps)} email · ${num(rep.webImps)} web`} />
          <Stat label="Verified clicks" value={num(rep.clicks)} sub={`${num(rep.bots)} bot clicks filtered · CTR ${pct(rep.clicks, rep.imps)}`} />
          <Stat label="eCPM" value={money(ecpm)} sub="earnings per 1,000 email impressions" />
          <Stat label="Programmatic earnings" value={money(rep.earned)} href="/app/monetize/wallet" />
        </Stats>
        <Grid>
          <Card title="Settings">
            <form method="post" action="/app/monetize/ads/programmatic" class="stack-sm">
              <Toggle name="enabled" checked={cfg.enabled} label="Enable programmatic ads" hint="Auto-fill ad slots with approved network campaigns" />
              <Field label="Placement" hint="Auto-insert is skipped in posts that already contain an ad block">
                <Select name="placement" value={cfg.placement} options={[['top', 'Top of the email'], ['middle', 'Middle of the email'], ['bottom', 'Bottom (before any paywall)'], ['manual', 'Only where I place a programmatic ad block']]} />
              </Field>
              <Grid>
                <Field label="Floor CPM" hint="Minimum per 1,000 impressions"><Input name="floor_cpm" type="number" step="0.01" min="0" value={(cfg.floor_cpm_cents / 100).toFixed(2)} /></Field>
                <Field label="Floor CPC" hint="Minimum per verified click"><Input name="floor_cpc" type="number" step="0.01" min="0" value={(cfg.floor_cpc_cents / 100).toFixed(2)} /></Field>
                <Field label="Max ads per email"><Input name="max_ads" type="number" min="1" max="5" value={cfg.max_ads} /></Field>
                <Field label="Slot label"><Input name="label" value={cfg.label} maxlength={40} /></Field>
                <Field label="Frequency cap" hint="Same campaign at most this many times per reader…"><Input name="freq_cap" type="number" min="0" max="50" value={cfg.freq_cap} /></Field>
                <Field label="…within days"><Input name="freq_days" type="number" min="1" max="365" value={cfg.freq_days} /></Field>
              </Grid>
              <Field label="Blocked categories"><Select name="blocked_categories[]" multiple options={CATEGORIES} values={cfg.blocked_categories} /></Field>
              {advertisers.length > 0 && <Field label="Blocked advertisers"><Select name="blocked_advertisers[]" multiple options={advertisers.map((a) => [a.id, a.name] as [string, string])} values={cfg.blocked_advertisers} /></Field>}
              <Toggle name="hide_for_premium" checked={cfg.hide_for_premium} label="Hide ads from premium subscribers" />
              <div class="form-actions"><Btn>Save settings</Btn></div>
            </form>
          </Card>
          <Card title="Eligible right now" pad={false}>
            <Table rows={eligible.slice(0, 15)} empty="No eligible campaigns with these settings. Lower your floors or unblock categories." cols={[
              { h: 'Campaign', r: (k: any) => <>{names.get(k.id)?.advertiser}<br /><small class="muted">{names.get(k.id)?.name}</small></> },
              { h: 'Pricing', r: (k: any) => (k.pricing === 'cpm' ? `${money(k.rate_cents)} CPM` : `${money(k.rate_cents)} / click`) },
              { h: 'Expected eCPM', class: 'right', r: (k: any) => money(Math.round(k.ecpm)) },
            ]} />
          </Card>
        </Grid>
        <Card title="Programmatic revenue by post" actions={<span class="row">{[7, 30, 90, 365].map((d) => <a class={`btn btn-sm ${d === days ? 'btn-secondary' : 'btn-ghost'}`} href={`?tab=programmatic&days=${d}`}>{d}d</a>)}</span>} pad={false}>
          <Table rows={rep.byPost} empty="Earnings appear here after your first send with programmatic ads on." cols={[
            { h: 'Post', r: (r: any) => (r.post_id ? <a href={`/app/posts/${r.post_id}`}>{r.title || '(untitled)'}</a> : <span class="muted">Website</span>) },
            { h: 'Campaigns', r: (r: any) => num(r.campaigns) },
            { h: 'Impressions', r: (r: any) => num(r.imps) },
            { h: 'Verified clicks', r: (r: any) => <>{num(r.clicks)}{r.bots ? <small class="muted"> (+{r.bots} bots)</small> : null}</> },
            { h: 'eCPM', r: (r: any) => money(r.imps ? Math.round((r.earned / r.imps) * 1000) : 0) },
            { h: 'Earned', class: 'right', r: (r: any) => <strong>{money(r.earned)}</strong> },
          ]} />
        </Card>
        <Card title="By campaign" pad={false}>
          <Table rows={rep.byCampaign} empty="No programmatic campaigns served yet." cols={[
            { h: 'Campaign', r: (r: any) => <>{r.advertiser}<br /><small class="muted">{r.name}</small></> },
            { h: 'Pricing', r: (r: any) => (r.pricing === 'cpm' ? `${money(r.rate_cents)} CPM` : `${money(r.rate_cents)} / click`) },
            { h: 'Impressions', r: (r: any) => num(r.imps) },
            { h: 'Clicks', r: (r: any) => num(r.clicks) },
            { h: 'CTR', r: (r: any) => pct(r.clicks, r.imps) },
            { h: 'Earned', class: 'right', r: (r: any) => <strong>{money(r.earned)}</strong> },
          ]} />
        </Card>
        <Help>Programmatic slots use the block <code>{'{"type":"ad_auto","data":{"label":"Sponsored"}}'}</code>; place it in a post to control the exact position. Email impressions are billed (CPM); clicks are bot-filtered and paid once per reader (CPC). Web impressions are reported but not billed.</Help>
      </>
    );
  }

  async function networkAdmin(c: Ctx) {
    const advertisers = await all<any>(c.env, 'SELECT * FROM advertisers WHERE owner_pub_id IS NULL ORDER BY name');
    const camps = await all<any>(c.env, `SELECT c.*, a.name AS advertiser, (SELECT COUNT(*) FROM ad_opportunities o WHERE o.campaign_id = c.id AND o.status IN ('accepted','placed','completed')) AS placements, (SELECT SUM(clicks) FROM ad_opportunities o WHERE o.campaign_id = c.id) AS clicks FROM ad_campaigns c JOIN advertisers a ON a.id = c.advertiser_id WHERE c.owner_pub_id IS NULL ORDER BY c.review_status = 'pending' DESC, c.created_at DESC`);
    return (
      <>
        <div class="callout">You're an instance admin. Campaigns you approve here are offered to every publication on this OpenHive instance.</div>
        <Card title="Campaigns" actions={<><OpenBtn target="#new-adv" kind="secondary" small>+ Advertiser</OpenBtn><OpenBtn target="#new-camp" small>+ Campaign</OpenBtn></>} pad={false}>
          <Table rows={camps} empty="No network campaigns yet." cols={[
            { h: 'Campaign', r: (k) => <>{k.advertiser}<br /><small class="muted">{k.name}</small></> },
            { h: 'Creative', r: (k) => <><strong>{k.headline}</strong><br /><small class="muted">{k.url}</small></> },
            { h: 'Pricing', r: (k) => priceLabel(k) },
            { h: 'Budget', r: (k) => (k.budget_cents ? `${money(k.spent_cents)} / ${money(k.budget_cents)}` : `${money(k.spent_cents)} spent`) },
            { h: 'Placements', r: (k) => `${num(k.placements)} · ${num(k.clicks || 0)} clicks` },
            { h: 'Brand safety', r: (k) => <><Status s={k.review_status} />{k.review_notes && <><br /><small class="muted">{k.review_notes}</small></>}</> },
            { h: 'Programmatic', r: (k) => <form method="post" action={`/app/monetize/ads/campaigns/${k.id}/programmatic`} class="inline-form"><button class={`btn btn-sm ${k.programmatic ? 'btn-secondary' : 'btn-ghost'}`} type="submit" title={k.pricing === 'flat' ? 'Flat-priced campaigns are not auto-filled' : ''}>{k.programmatic ? 'On' : 'Off'}</button>{parseJSON<string[]>(k.target_categories, []).length ? <><br /><small class="muted">targets {parseJSON<string[]>(k.target_categories, []).join(', ')}</small></> : null}</form> },
            { h: '', class: 'right', r: (k) => (
              <form method="post" action={`/app/monetize/ads/review/${k.id}`} class="row end">
                <Input name="notes" placeholder="Review notes" />
                <Btn small name="decision" value="approved">Approve</Btn>
                <Btn small kind="danger" name="decision" value="rejected">Reject</Btn>
                <Btn small kind="ghost" name="decision" value={k.status === 'active' ? 'pause' : 'resume'}>{k.status === 'active' ? 'Pause' : 'Resume'}</Btn>
              </form>
            ) },
          ]} />
        </Card>
        <Modal id="new-adv" title="New advertiser">
          <form method="post" action="/app/monetize/ads/advertisers">
            <Field label="Brand name"><Input name="name" required /></Field>
            <Field label="Website"><Input name="website" type="url" /></Field>
            <Field label="Logo URL"><Input name="logo_url" /></Field>
            <Field label="Contact email"><Input name="contact_email" type="email" /></Field>
            <div class="form-actions"><Btn>Add advertiser</Btn></div>
          </form>
        </Modal>
        <Modal id="new-camp" title="New network campaign" wide>
          {advertisers.length ? (
            <form method="post" action="/app/monetize/ads/campaigns">
              <Grid>
                <Field label="Advertiser"><Select name="advertiser_id" options={advertisers.map((a) => [a.id, a.name] as [string, string])} /></Field>
                <Field label="Campaign name"><Input name="name" required /></Field>
                <Field label="Headline"><Input name="headline" required maxlength={120} /></Field>
                <Field label="Call to action"><Input name="cta_label" value="Learn more" /></Field>
              </Grid>
              <Field label="Body"><Textarea name="body" rows={3} /></Field>
              <Grid>
                <Field label="Destination URL"><Input name="url" type="url" required /></Field>
                <Field label="Image URL"><Input name="image_url" /></Field>
                <Field label="Link parameters" hint="Appended for attribution; {pub} and {post} are replaced"><Input name="link_params" value="utm_source={pub}&utm_medium=newsletter&utm_campaign={post}" /></Field>
                <Field label="Categories"><Select name="categories[]" multiple options={CATEGORIES} /></Field>
                <Field label="Pricing"><Select name="pricing" options={[['cpc', 'Per verified click'], ['cpm', 'Per 1,000 impressions'], ['flat', 'Flat per placement']]} /></Field>
                <Field label="Rate"><Input name="rate" type="number" step="0.01" min="0" required /></Field>
                <Field label="Total budget" hint="0 = unlimited"><Input name="budget" type="number" step="0.01" min="0" value="0" /></Field>
                <Field label="Ends"><Input name="ends" type="date" /></Field>
                <Field label="Target publication categories" hint="Empty = all publications"><Select name="target_categories[]" multiple options={CATEGORIES} /></Field>
              </Grid>
              <Check name="programmatic" checked label="Available for programmatic auto-fill" hint="CPM and CPC campaigns only" />
              <div class="form-actions"><Btn>Create (pending review)</Btn></div>
            </form>
          ) : <p>Add an advertiser first.</p>}
        </Modal>
      </>
    );
  }

  dash.post('/ads/:id/accept', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const f = await form(c.req);
    const o = await one<any>(c.env, `SELECT * FROM ad_opportunities WHERE id = ? AND pub_id = ? AND status = 'available'`, c.req.param('id'), pub.id);
    if (!o) return back(c, '/app/monetize/ads', 'This opportunity is no longer available.', 'err');
    const date = f.date ? Date.parse(f.date) : null;
    await run(c.env, `UPDATE ad_opportunities SET status = 'accepted', decided_at = ?, scheduled_for = ? WHERE id = ?`, now(), date && !isNaN(date) ? date : null, o.id);
    if (f.post_id) {
      const err = await insertAdIntoPost(c, o.id, str(f.post_id));
      if (err) return back(c, '/app/monetize/ads?tab=placements', `Claimed, but: ${err}`, 'err');
      return back(c, '/app/monetize/ads?tab=placements', 'Ad claimed and inserted into your post');
    }
    return back(c, '/app/monetize/ads?tab=placements', 'Ad claimed — insert it into a post when ready');
  });

  dash.post('/ads/:id/decline', requirePerm('manage'), async (c) => {
    await run(c.env, `UPDATE ad_opportunities SET status = 'declined', decided_at = ? WHERE id = ? AND pub_id = ? AND status = 'available'`, now(), c.req.param('id'), c.get('pub').id);
    return back(c, '/app/monetize/ads', 'Opportunity declined');
  });

  dash.post('/ads/:id/insert', requirePerm('manage'), async (c) => {
    const f = await form(c.req);
    const o = await one<any>(c.env, `SELECT id FROM ad_opportunities WHERE id = ? AND pub_id = ? AND status IN ('accepted','placed')`, c.req.param('id'), c.get('pub').id);
    if (!o) return back(c, '/app/monetize/ads?tab=placements', 'Claim the ad first.', 'err');
    const err = await insertAdIntoPost(c, o.id, str(f.post_id));
    return back(c, c.req.header('referer') || '/app/monetize/ads?tab=placements', err || 'Ad block inserted into the post', err ? 'err' : 'ok');
  });

  dash.post('/ads/advertisers', requirePerm('manage'), async (c) => {
    if (!isAdmin(c)) return c.text('Instance admins only', 403);
    const f = await form(c.req);
    await insert(c.env, 'advertisers', { id: id(), name: str(f.name, 120), website: str(f.website, 500) || null, logo_url: str(f.logo_url, 1000) || null, contact_email: str(f.contact_email, 200) || null, created_at: now() });
    return back(c, '/app/monetize/ads?tab=network', 'Advertiser added');
  });

  dash.post('/ads/campaigns', requirePerm('manage'), async (c) => {
    if (!isAdmin(c)) return c.text('Instance admins only', 403);
    const f = await form(c.req);
    const ends = f.ends ? Date.parse(f.ends + 'T23:59:59Z') : null;
    await insert(c.env, 'ad_campaigns', {
      id: id(), advertiser_id: str(f.advertiser_id), owner_pub_id: null, name: str(f.name, 120), headline: str(f.headline, 120), body: str(f.body, 600), image_url: str(f.image_url, 1000) || null,
      cta_label: str(f.cta_label, 40) || 'Learn more', url: str(f.url, 2000), link_params: str(f.link_params, 300), pricing: ['cpc', 'cpm', 'flat'].includes(f.pricing) ? f.pricing : 'cpc',
      rate_cents: cents(f.rate), budget_cents: cents(f.budget), categories: JSON.stringify(f.categories || []), target_categories: JSON.stringify(f.target_categories || []), programmatic: f.programmatic ? 1 : 0, review_status: 'pending', ends_at: ends && !isNaN(ends) ? ends : null, status: 'active', created_at: now(),
    });
    return back(c, '/app/monetize/ads?tab=network', 'Campaign created — review it for brand safety to publish');
  });

  dash.post('/ads/programmatic', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const f = await form(c.req);
    const cfg = {
      ...PROG_DEFAULTS,
      enabled: !!f.enabled,
      placement: ['top', 'middle', 'bottom', 'manual'].includes(f.placement) ? f.placement : 'middle',
      floor_cpm_cents: cents(f.floor_cpm), floor_cpc_cents: cents(f.floor_cpc),
      max_ads: Math.min(5, Math.max(1, int(f.max_ads, 1))),
      freq_cap: Math.min(50, Math.max(0, int(f.freq_cap, 3))), freq_days: Math.min(365, Math.max(1, int(f.freq_days, 30))),
      blocked_categories: (f.blocked_categories || []).filter((x: string) => CATEGORIES.includes(x)),
      blocked_advertisers: (f.blocked_advertisers || []).map((x: string) => str(x, 40)).filter(Boolean),
      hide_for_premium: !!f.hide_for_premium,
      label: str(f.label, 40) || 'Sponsored',
    };
    const fresh = await one<{ settings: string }>(c.env, 'SELECT settings FROM publications WHERE id = ?', pub.id);
    const merged = { ...parseJSON<any>(fresh?.settings, {}), programmatic: cfg };
    await run(c.env, 'UPDATE publications SET settings = ? WHERE id = ?', JSON.stringify(merged), pub.id);
    return back(c, '/app/monetize/ads?tab=programmatic', cfg.enabled ? 'Programmatic ads are on' : 'Programmatic settings saved');
  });

  dash.post('/ads/campaigns/:id/programmatic', requirePerm('manage'), async (c) => {
    if (!isAdmin(c)) return c.text('Instance admins only', 403);
    await run(c.env, `UPDATE ad_campaigns SET programmatic = CASE WHEN programmatic = 1 OR pricing = 'flat' THEN 0 ELSE 1 END WHERE id = ? AND owner_pub_id IS NULL`, c.req.param('id'));
    return back(c, '/app/monetize/ads?tab=network', 'Programmatic availability updated');
  });

  dash.post('/ads/review/:id', requirePerm('manage'), async (c) => {
    if (!isAdmin(c)) return c.text('Instance admins only', 403);
    const f = await form(c.req);
    const d = str(f.decision);
    if (d === 'approved' || d === 'rejected') await run(c.env, 'UPDATE ad_campaigns SET review_status = ?, review_notes = ? WHERE id = ?', d, str(f.notes, 500) || null, c.req.param('id'));
    if (d === 'rejected') await run(c.env, `UPDATE ad_opportunities SET status = 'declined', decided_at = ? WHERE campaign_id = ? AND status = 'available'`, now(), c.req.param('id'));
    if (d === 'pause' || d === 'resume') await run(c.env, 'UPDATE ad_campaigns SET status = ? WHERE id = ?', d === 'pause' ? 'paused' : 'active', c.req.param('id'));
    return back(c, '/app/monetize/ads?tab=network', 'Campaign updated');
  });

  // Ad click tracking: bot clicks are counted separately and never paid.
  root.get('/t/ad/:opp', async (c) => {
    let target: URL;
    try { target = new URL(c.req.query('u') || ''); } catch { return c.text('Invalid link', 400); }
    if (!/^https?:$/.test(target.protocol)) return c.text('Invalid link', 400);
    const o = await one<any>(c.env, `SELECT o.*, c.pricing, c.rate_cents, c.name AS cname, c.url AS curl FROM ad_opportunities o JOIN ad_campaigns c ON c.id = o.campaign_id WHERE o.id = ?`, c.req.param('opp'));
    if (o) {
      const did = c.req.query('d');
      const work = (async () => {
        const ua = c.req.header('user-agent');
        const d = did ? await one<any>(c.env, 'SELECT sent_at FROM deliveries WHERE id = ?', did) : null;
        const bot = isBotClick(ua, d?.sent_at ? now() - d.sent_at : undefined);
        if (bot) { await run(c.env, 'UPDATE ad_opportunities SET bot_clicks = bot_clicks + 1 WHERE id = ?', o.id); return; }
        // one paid click per reader per placement
        const who = did || (await sha256(clientIP(c.req.raw) + (ua || ''))).slice(0, 24);
        const first = await rateLimit(c.env, `adclick:${o.id}:${who}`, 1, 30 * 86400);
        if (!first) return;
        await run(c.env, 'UPDATE ad_opportunities SET clicks = clicks + 1 WHERE id = ?', o.id);
        if (o.pricing === 'cpc') await creditAd(c.env, o.id, o.rate_cents, `${o.cname}: verified click`);
        if (did) await recordClick(c.env, did, target.toString(), c.req.raw);
      })().catch(() => {});
      try { c.executionCtx.waitUntil(work); } catch { await work; }
    }
    return c.redirect(target.toString(), 302);
  });
}

