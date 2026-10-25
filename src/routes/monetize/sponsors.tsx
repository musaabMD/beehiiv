/** @jsxImportSource hono/jsx */
// Direct sponsorships (sell your own placements) + wallet & payouts.
import type { Hono } from 'hono';
import type { AppEnv } from '../../types';
import { one, all, run, insert } from '../../lib/db';
import { requirePerm, audit } from '../../lib/auth';
import { settings, siteUrl } from '../../lib/pub';
import { stripeEnabled, stripePost } from '../../lib/payments';
import { walletSummary } from '../../lib/billing';
import { insertAdIntoPost } from './ads';
import { DashLayout } from '../../ui/layout';
import { Card, Stats, Stat, Table, Btn, Field, Input, Textarea, Select, Status, Empty, Modal, OpenBtn, ActionForm, back, Grid, Copy, Badge, Help } from '../../ui/components';
import { id, now, money, num, fmtDate, form, str, cents } from '../../lib/util';

export const FORMATS: Array<[string, string]> = [['primary', 'Primary sponsor (top of issue)'], ['secondary', 'Secondary placement (mid-issue)'], ['classified', 'Classified (short text ad)'], ['dedicated', 'Dedicated send']];

export function registerSponsors(dash: Hono<AppEnv>) {
  dash.get('/sponsorships', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const products = await all<any>(c.env, `SELECT sp.*, (SELECT COUNT(*) FROM orders o WHERE o.ref_id = sp.id AND o.kind = 'sponsorship' AND o.status = 'paid') AS sold FROM sponsorship_products sp WHERE sp.pub_id = ? ORDER BY sp.created_at`, pub.id);
    const placements = await all<any>(c.env, `SELECT o.*, c.name AS cname, c.headline, c.body, c.url, c.image_url, c.review_status, c.review_notes, c.status AS cstatus, a.name AS advertiser, a.contact_email, a.website, p.title AS post_title FROM ad_opportunities o JOIN ad_campaigns c ON c.id = o.campaign_id JOIN advertisers a ON a.id = c.advertiser_id LEFT JOIN posts p ON p.id = o.post_id WHERE o.pub_id = ? AND c.owner_pub_id = ? AND c.status != 'pending' ORDER BY COALESCE(o.scheduled_for, o.created_at)`, pub.id, pub.id);
    const posts = await all<any>(c.env, `SELECT id, title FROM posts WHERE pub_id = ? AND status IN ('draft','scheduled') ORDER BY updated_at DESC LIMIT 50`, pub.id);
    const revenue = await one<any>(c.env, `SELECT COALESCE(SUM(amount_cents),0) AS amt, COUNT(*) AS n FROM orders WHERE pub_id = ? AND kind = 'sponsorship' AND status = 'paid'`, pub.id);
    const upcoming = placements.filter((p) => !p.scheduled_for || p.scheduled_for > now() - 86400000);
    return c.html(
      <DashLayout c={c} title="Sponsorships" section="monetize" sub="sponsors" actions={<OpenBtn target="#new-sp">+ Sponsorship product</OpenBtn>}>
        <Stats>
          <Stat label="Sponsorship revenue" value={money(revenue.amt)} sub={`${num(revenue.n)} bookings · 0% platform fees`} />
          <Stat label="Upcoming placements" value={num(upcoming.length)} />
          <Stat label="Awaiting creative review" value={num(placements.filter((p) => p.review_status === 'pending').length)} />
        </Stats>
        <Card title="Booking page">
          <Help>Share this page with brands. They pick a format and date, submit their creative, and pay — placements land on your calendar below.</Help>
          <Copy value={`${siteUrl(c.env, pub)}/sponsor`} />
        </Card>
        <Card title="Sponsorship products" pad={false}>
          <Table rows={products} empty={<Empty title="No sponsorship products" body="Define the placements you sell — formats, descriptions and prices." action={<OpenBtn target="#new-sp">Add a product</OpenBtn>} />} cols={[
            { h: 'Name', r: (p) => <>{p.name}<br /><small class="muted">{FORMATS.find(([k]) => k === p.format)?.[1]}</small></> },
            { h: 'Price', r: (p) => money(p.price_cents) },
            { h: 'Sold', r: (p) => num(p.sold) },
            { h: 'Status', r: (p) => <Status s={p.active ? 'active' : 'paused'} /> },
            { h: '', class: 'right', r: (p) => <div class="row end"><ActionForm action={`/app/monetize/sponsorships/${p.id}/toggle`} label={p.active ? 'Pause' : 'Activate'} /><ActionForm action={`/app/monetize/sponsorships/${p.id}/delete`} label="Delete" kind="danger" confirm="Delete this sponsorship product?" /></div> },
          ]} />
        </Card>
        <Card title="Scheduled sponsor placements" pad={false}>
          <Table rows={placements} empty="No booked placements yet." cols={[
            { h: 'Date', r: (p) => <strong>{p.scheduled_for ? fmtDate(p.scheduled_for, { dateStyle: 'medium' }, pub.timezone) : 'Flexible'}</strong> },
            { h: 'Advertiser', r: (p) => <>{p.advertiser}<br /><small class="muted">{p.contact_email}{p.website ? ` · ${p.website}` : ''}</small></> },
            { h: 'Creative', r: (p) => <><strong>{p.headline}</strong><br /><small class="muted">{p.body?.slice(0, 120)}</small><br /><a href={p.url} target="_blank" class="small">{p.url}</a></> },
            { h: 'Review', r: (p) => <><Status s={p.review_status} />{p.review_notes ? <><br /><small class="muted">{p.review_notes}</small></> : null}</> },
            { h: 'Post', r: (p) => (p.post_title ? <a href={`/app/posts/${p.post_id}`}>{p.post_title}</a> : p.review_status === 'approved' ? <form method="post" action={`/app/monetize/sponsorships/place/${p.id}`} class="row"><Select name="post_id" options={posts.map((x) => [x.id, x.title || '(untitled)'] as [string, string])} /><Btn small kind="secondary">Insert</Btn></form> : '—') },
            { h: '', class: 'right', r: (p) => (p.review_status === 'pending' ? <form method="post" action={`/app/monetize/sponsorships/review/${p.campaign_id}`} class="row end"><Input name="notes" placeholder="Notes to advertiser" /><Btn small name="decision" value="approved">Approve</Btn><Btn small kind="danger" name="decision" value="rejected">Request changes</Btn></form> : <Status s={p.status} />) },
          ]} />
        </Card>
        <Modal id="new-sp" title="New sponsorship product">
          <form method="post" action="/app/monetize/sponsorships">
            <Field label="Name"><Input name="name" required placeholder="Primary sponsor — weekly issue" /></Field>
            <Field label="Format"><Select name="format" options={FORMATS} /></Field>
            <Field label="Price"><Input name="price" type="number" step="0.01" min="0" required /></Field>
            <Field label="Description" hint="Audience size, placement details, what's included"><Textarea name="description" rows={4} /></Field>
            <div class="form-actions"><Btn>Create</Btn></div>
          </form>
        </Modal>
      </DashLayout>,
    );
  });

  dash.post('/sponsorships', requirePerm('manage'), async (c) => {
    const f = await form(c.req);
    await insert(c.env, 'sponsorship_products', { id: id(), pub_id: c.get('pub').id, name: str(f.name, 120), format: FORMATS.some(([k]) => k === f.format) ? f.format : 'primary', description: str(f.description, 2000), price_cents: cents(f.price), active: 1, created_at: now() });
    return back(c, '/app/monetize/sponsorships', 'Sponsorship product created');
  });
  dash.post('/sponsorships/:id/toggle', requirePerm('manage'), async (c) => {
    await run(c.env, 'UPDATE sponsorship_products SET active = 1 - active WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
    return back(c, '/app/monetize/sponsorships', 'Updated');
  });
  dash.post('/sponsorships/:id/delete', requirePerm('manage'), async (c) => {
    await run(c.env, 'DELETE FROM sponsorship_products WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
    return back(c, '/app/monetize/sponsorships', 'Deleted');
  });
  dash.post('/sponsorships/review/:campaign', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const f = await form(c.req);
    const d = f.decision === 'approved' ? 'approved' : 'rejected';
    const camp = await one<any>(c.env, `SELECT c.*, a.contact_email FROM ad_campaigns c JOIN advertisers a ON a.id = c.advertiser_id WHERE c.id = ? AND c.owner_pub_id = ?`, c.req.param('campaign'), pub.id);
    if (!camp) return c.notFound();
    await run(c.env, 'UPDATE ad_campaigns SET review_status = ?, review_notes = ? WHERE id = ?', d, str(f.notes, 500) || null, camp.id);
    if (camp.contact_email) {
      const { sendTransactional } = await import('../../lib/email');
      await sendTransactional(c.env, camp.contact_email, d === 'approved' ? `Your sponsorship with ${pub.name} is approved` : `Changes requested for your ${pub.name} sponsorship`, d === 'approved' ? `<p>Your creative “${camp.headline}” is approved and scheduled.</p>` : `<p>The ${pub.name} team asked for changes to “${camp.headline}”:</p><p>${str(f.notes, 500).replace(/</g, '&lt;')}</p><p>Reply to this email with your updated creative.</p>`, pub);
    }
    return back(c, '/app/monetize/sponsorships', d === 'approved' ? 'Creative approved' : 'Changes requested');
  });
  dash.post('/sponsorships/place/:opp', requirePerm('manage'), async (c) => {
    const err = await insertAdIntoPost(c, c.req.param('opp'), str((await form(c.req)).post_id));
    return back(c, '/app/monetize/sponsorships', err || 'Sponsor block inserted into the post', err ? 'err' : 'ok');
  });

  // ── wallet
  dash.get('/wallet', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const w = await walletSummary(c.env, pub.id);
    const entries = await all<any>(c.env, 'SELECT * FROM wallet_entries WHERE pub_id = ? ORDER BY created_at DESC LIMIT 200', pub.id);
    const acct = settings(pub).stripe_account_id;
    return c.html(
      <DashLayout c={c} title="Wallet & payouts" section="monetize" sub="wallet">
        <Stats>
          <Stat label="Available to pay out" value={money(w.available)} tone={w.available > 0 ? 'up' : ''} />
          <Stat label="Pending" value={money(w.pending)} sub="Earnings clear after a 7-day fraud review window" />
          <Stat label="Paid out" value={money(w.paidOut)} />
          <Stat label="Lifetime network earnings" value={money(w.lifetime)} sub="Ads + boosts" />
        </Stats>
        <Grid>
          <Card title="Request a payout">
            {acct && stripeEnabled(c.env) ? <p>Payouts are sent with Stripe Connect to <code>{acct}</code>.</p> : <div class="callout warn">No Stripe Connect account is linked, so payouts are recorded for manual transfer. Link one in <a href="/app/settings/billing">Payments settings</a>.</div>}
            <form method="post" action="/app/monetize/wallet/payout" class="row">
              <Input name="amount" type="number" step="0.01" min="1" value={(w.available / 100).toFixed(2)} />
              <Btn disabled={w.available < 100}>Pay out</Btn>
            </form>
            <Help>Minimum payout $1.00. Subscription, product, ticket and sponsorship sales are paid directly to your Stripe account at checkout — OpenHive takes {Number(c.env.PLATFORM_FEE_PERCENT || 0)}% platform fees.</Help>
          </Card>
          <Card title="Where earnings come from">
            <ul class="list-plain">
              <li><a href="/app/monetize/ads">Ad network</a> — verified clicks, impressions or flat placements</li>
              <li><a href="/app/grow/boosts">Boosts</a> — paid recommendations (subject to fraud clawbacks)</li>
              <li><a href="/app/monetize/sponsorships">Direct sponsorships</a> — paid to you at checkout</li>
            </ul>
          </Card>
        </Grid>
        <Card title="Activity" pad={false}>
          <Table rows={entries} empty="No wallet activity yet." cols={[
            { h: 'Date', r: (e) => fmtDate(e.created_at) },
            { h: 'Type', r: (e) => <Badge tone={e.kind === 'payout' ? 'blue' : e.kind === 'clawback' ? 'red' : 'green'}>{e.kind}</Badge> },
            { h: 'Description', r: (e) => e.note },
            { h: 'Amount', class: 'right', r: (e) => <strong class={e.amount_cents < 0 ? 'muted' : ''}>{money(e.amount_cents)}</strong> },
            { h: 'Status', r: (e) => <Status s={e.status} /> },
          ]} />
        </Card>
      </DashLayout>,
    );
  });

  dash.post('/wallet/payout', requirePerm('admin'), async (c) => {
    const pub = c.get('pub');
    const w = await walletSummary(c.env, pub.id);
    const amount = Math.min(cents((await form(c.req)).amount), w.available);
    if (amount < 100) return back(c, '/app/monetize/wallet', 'Nothing available to pay out yet.', 'err');
    const acct = settings(pub).stripe_account_id;
    let note = 'Manual payout (record)';
    if (acct && stripeEnabled(c.env)) {
      try {
        const tr = await stripePost(c.env, 'transfers', { amount: String(amount), currency: 'usd', destination: acct, description: `OpenHive wallet payout — ${pub.name}` });
        note = `Stripe Connect transfer ${tr.id}`;
      } catch (e: any) {
        return back(c, '/app/monetize/wallet', `Stripe transfer failed: ${e.message}`, 'err');
      }
    }
    await insert(c.env, 'wallet_entries', { id: id(), pub_id: pub.id, kind: 'payout', amount_cents: -amount, status: 'paid', note, created_at: now() });
    await audit(c, 'wallet.payout', undefined, { amount });
    return back(c, '/app/monetize/wallet', `Payout of ${money(amount)} ${acct && stripeEnabled(c.env) ? 'sent' : 'recorded'}`);
  });
}
