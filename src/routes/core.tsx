/** @jsxImportSource hono/jsx */
// Core public routes: media, tracking, one-click unsubscribe, preferences, simulated checkout, inbound hooks.
import { Hono } from 'hono';
import type { AppEnv, Module, Publication, Subscriber } from '../types';
import { one, all, run } from '../lib/db';
import { serveObject } from '../lib/media';
import { recordOpen, recordClick } from '../lib/tracking';
import { verifySubToken, unsubscribe, joinLists, leaveLists, getSubscriber } from '../lib/subscribers';
import { markPaid, verifyStripeSignature } from '../lib/payments';
import { recordBounce, classifyBounce, suppress } from '../lib/email';
import { emit } from '../lib/events';
import { siteUrl } from '../lib/pub';
import { PlainLayout } from '../ui/layout';
import { money, now, parseJSON, esc, form, str } from '../lib/util';

const root = new Hono<AppEnv>();

const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));

root.get('/health', (c) => c.json({ ok: true, app: c.env.APP_NAME, time: new Date().toISOString() }));

// R2 media
root.get('/media/*', async (c) => {
  const key = decodeURIComponent(new URL(c.req.url).pathname.replace(/^\/media\//, ''));
  if (!key || key.includes('..')) return c.notFound();
  if (key.includes('/private/')) return c.text('Forbidden', 403);
  return serveObject(c.env, key, c.req.raw);
});

// Open pixel
root.get('/t/o/:token', async (c) => {
  const tok = c.req.param('token').replace(/\.gif$/, '');
  c.executionCtx.waitUntil(recordOpen(c.env, tok, c.req.raw).catch(() => {}));
  return new Response(GIF, { headers: { 'content-type': 'image/gif', 'cache-control': 'no-store, no-cache, must-revalidate, private', 'content-length': String(GIF.length) } });
});

// Click redirect (bot clicks recorded but filtered from reports)
root.get('/t/c/:token', async (c) => {
  const u = c.req.query('u') || '';
  let target: URL;
  try { target = new URL(u); } catch { return c.text('Invalid link', 400); }
  if (!/^https?:$/.test(target.protocol)) return c.text('Invalid link', 400);
  c.executionCtx.waitUntil(recordClick(c.env, c.req.param('token'), target.toString(), c.req.raw).catch(() => {}));
  return c.redirect(target.toString(), 302);
});

async function subFromToken(c: any): Promise<{ sub: Subscriber; pub: Publication } | null> {
  const sid = await verifySubToken(c.env, c.req.param('tok'));
  if (!sid) return null;
  const sub = await one<Subscriber>(c.env, 'SELECT * FROM subscribers WHERE id = ?', sid);
  if (!sub) return null;
  const pub = await one<Publication>(c.env, 'SELECT * FROM publications WHERE id = ?', sub.pub_id);
  return pub ? { sub, pub } : null;
}

// RFC 8058 one-click unsubscribe (mail clients POST "List-Unsubscribe=One-Click")
root.post('/u/:tok', async (c) => {
  const r = await subFromToken(c);
  if (!r) return c.text('Invalid link', 400);
  const body = await c.req.parseBody().catch(() => ({} as any));
  await unsubscribe(c.env, r.pub.id, r.sub.id, (body as any)['List-Unsubscribe'] === 'One-Click' ? 'one-click' : str((body as any).reason) || 'link');
  if ((body as any)['List-Unsubscribe'] === 'One-Click') return c.text('Unsubscribed');
  return c.html(<PlainLayout title="Unsubscribed"><h1>You're unsubscribed</h1><p>You won't receive any more emails from <strong>{r.pub.name}</strong>.</p><form method="post" action={`/u/${c.req.param('tok')}/resubscribe`}><button class="btn btn-secondary">Oops, resubscribe me</button></form></PlainLayout>);
});

root.get('/u/:tok', async (c) => {
  const r = await subFromToken(c);
  if (!r) return c.html(<PlainLayout title="Invalid link"><h1>This link is invalid</h1></PlainLayout>, 400);
  return c.html(
    <PlainLayout title={`Unsubscribe from ${r.pub.name}`}>
      <h1>Unsubscribe from {r.pub.name}?</h1>
      <p class="muted">{r.sub.email}</p>
      <form method="post" class="stack">
        <label class="field"><span class="field-l">Tell us why (optional)</span>
          <select class="input" name="reason"><option value="">Choose a reason…</option><option>Too many emails</option><option>Not relevant to me</option><option>I never signed up</option><option>Other</option></select>
        </label>
        <button class="btn btn-danger">Unsubscribe</button>
      </form>
      <p><a href={`/pref/${c.req.param('tok')}`}>Manage preferences instead</a></p>
    </PlainLayout>,
  );
});

root.post('/u/:tok/resubscribe', async (c) => {
  const r = await subFromToken(c);
  if (!r) return c.text('Invalid link', 400);
  await run(c.env, `UPDATE subscribers SET status = 'active', unsubscribed_at = NULL, updated_at = ? WHERE id = ?`, now(), r.sub.id);
  await run(c.env, `DELETE FROM suppressions WHERE email = ? AND scope = 'pub' AND pub_id = ?`, r.sub.email, r.pub.id);
  await emit(c.env, { pubId: r.pub.id, type: 'subscription.created', subscriberId: r.sub.id, data: { resubscribed: true } });
  return c.html(<PlainLayout title="Resubscribed"><h1>Welcome back!</h1><p>You're subscribed to {r.pub.name} again.</p></PlainLayout>);
});

// Preference center: lists + unsubscribe all
root.get('/pref/:tok', async (c) => {
  const r = await subFromToken(c);
  if (!r) return c.html(<PlainLayout title="Invalid link"><h1>This link is invalid</h1></PlainLayout>, 400);
  const lists = await all<any>(c.env, `SELECT l.*, lm.status AS member FROM lists l LEFT JOIN list_members lm ON lm.list_id = l.id AND lm.subscriber_id = ? WHERE l.pub_id = ? AND l.public = 1 ORDER BY l.created_at`, r.sub.id, r.pub.id);
  return c.html(
    <PlainLayout title="Email preferences" c={c}>
      <h1>Email preferences</h1>
      <p class="muted">{r.sub.email} · {r.pub.name}</p>
      <form method="post" class="stack">
        <label class="field"><span class="field-l">Name</span><input class="input" name="name" value={r.sub.name} /></label>
        {lists.length > 0 && (
          <fieldset class="stack"><legend class="field-l">Newsletters</legend>
            {lists.map((l) => <label class="check"><input type="checkbox" name="lists[]" value={l.id} checked={l.member === 'subscribed'} /><span>{l.name}<small class="field-h">{l.description}</small></span></label>)}
          </fieldset>
        )}
        <button class="btn btn-primary">Save preferences</button>
      </form>
      <hr />
      <p>{r.sub.status === 'active' ? <a href={`/u/${c.req.param('tok')}`}>Unsubscribe from all emails</a> : <span>You are currently unsubscribed.</span>}</p>
      <p><a href={siteUrl(c.env, r.pub)}>Visit {r.pub.name} →</a></p>
    </PlainLayout>,
  );
});

root.post('/pref/:tok', async (c) => {
  const r = await subFromToken(c);
  if (!r) return c.text('Invalid link', 400);
  const f = await form(c.req);
  await run(c.env, 'UPDATE subscribers SET name = ?, updated_at = ? WHERE id = ?', str(f.name, 120), now(), r.sub.id);
  const lists = await all<{ id: string }>(c.env, 'SELECT id FROM lists WHERE pub_id = ? AND public = 1', r.pub.id);
  const chosen: string[] = f.lists || [];
  await joinLists(c.env, r.pub.id, r.sub.id, lists.filter((l) => chosen.includes(l.id)).map((l) => l.id));
  await leaveLists(c.env, r.pub.id, r.sub.id, lists.filter((l) => !chosen.includes(l.id)).map((l) => l.id));
  const { flash } = await import('../ui/components');
  flash(c, 'Preferences saved');
  return c.redirect(`/pref/${c.req.param('tok')}`, 303);
});

// Test-mode checkout (used when STRIPE_SECRET_KEY is not set)
root.get('/checkout/simulate/:id', async (c) => {
  const o = await one<any>(c.env, 'SELECT * FROM orders WHERE id = ?', c.req.param('id'));
  if (!o) return c.notFound();
  const pub = await one<Publication>(c.env, 'SELECT * FROM publications WHERE id = ?', o.pub_id);
  const d = parseJSON<any>(o.data, {});
  return c.html(
    <PlainLayout title="Test checkout">
      <div class="flash flash-err">Test mode — no real payment is taken. Add STRIPE_SECRET_KEY to accept real payments.</div>
      <h1>{pub?.name}</h1>
      <p><strong>{d.description}</strong></p>
      <p class="stat-v">{money(o.amount_cents, o.currency)}{d.recurring ? ` / ${d.recurring.interval}` : ''}</p>
      {d.recurring?.trialDays ? <p class="muted">{d.recurring.trialDays}-day trial{d.recurring.trialAmountCents ? ` for ${money(d.recurring.trialAmountCents, o.currency)}` : ' free'}</p> : null}
      <p class="muted">{o.email}</p>
      {o.status === 'paid' ? <p>Already paid. <a href={`${siteUrl(c.env, pub!)}/order/${o.id}`}>View order</a></p> : (
        <form method="post" class="stack">
          <label class="field"><span class="field-l">Card number (test)</span><input class="input" value="4242 4242 4242 4242" readonly /></label>
          <button class="btn btn-primary">Pay {money(o.amount_cents, o.currency)}</button>
        </form>
      )}
    </PlainLayout>,
  );
});

root.post('/checkout/simulate/:id', async (c) => {
  const o = await one<any>(c.env, 'SELECT * FROM orders WHERE id = ?', c.req.param('id'));
  if (!o) return c.notFound();
  await markPaid(c.env, o.id, {});
  const pub = await one<Publication>(c.env, 'SELECT * FROM publications WHERE id = ?', o.pub_id);
  const d = parseJSON<any>(o.data, {});
  return c.redirect(d.success_url || `${siteUrl(c.env, pub!)}/order/${o.id}`, 303);
});

// Stripe webhooks: checkout completion + subscription lifecycle
root.post('/hooks/stripe', async (c) => {
  const payload = await c.req.text();
  if (!(await verifyStripeSignature(c.env, payload, c.req.header('stripe-signature')))) return c.text('bad signature', 400);
  const evt = JSON.parse(payload);
  const obj = evt.data?.object || {};
  switch (evt.type) {
    case 'checkout.session.completed': {
      const orderId = obj.metadata?.order_id || obj.client_reference_id;
      if (orderId) {
        await run(c.env, 'UPDATE orders SET stripe_session_id = ? WHERE id = ?', obj.id, orderId);
        if (obj.customer) await run(c.env, 'UPDATE subscribers SET stripe_customer_id = ? WHERE id = (SELECT subscriber_id FROM orders WHERE id = ?)', obj.customer, orderId);
        await markPaid(c.env, orderId, { paymentIntent: obj.payment_intent, stripeSubscriptionId: obj.subscription });
      }
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = await one<any>(c.env, 'SELECT * FROM subscriptions WHERE stripe_subscription_id = ?', obj.id);
      if (sub) {
        const status = evt.type.endsWith('deleted') ? 'canceled' : obj.pause_collection ? 'paused' : obj.status === 'trialing' ? 'trialing' : obj.status === 'past_due' ? 'past_due' : obj.status === 'canceled' ? 'canceled' : 'active';
        await run(c.env, 'UPDATE subscriptions SET status = ?, current_period_end = ?, updated_at = ? WHERE id = ?', status, (obj.current_period_end || 0) * 1000 || null, now(), sub.id);
        if (status === 'canceled') {
          await run(c.env, `UPDATE subscribers SET tier = 'free', tier_id = NULL, updated_at = ? WHERE id = ?`, now(), sub.subscriber_id);
          await emit(c.env, { pubId: sub.pub_id, type: 'subscription.downgraded', subscriberId: sub.subscriber_id, data: { tier_id: sub.tier_id, reason: 'canceled' } });
        }
      }
      break;
    }
    case 'invoice.payment_failed': {
      if (obj.subscription) await run(c.env, `UPDATE subscriptions SET status = 'past_due', updated_at = ? WHERE stripe_subscription_id = ?`, now(), obj.subscription);
      break;
    }
  }
  return c.json({ received: true });
});

/**
 * Inbound bounce / complaint / feedback-loop processing.
 * Accepts JSON {email, type?: 'bounce'|'complaint', diagnostic?: string, pub_id?} or ARF reports (text) from mailbox provider FBLs.
 * Protect with ?key=<first 16 chars of sha256(APP_URL)> (shown in Settings → Email).
 */
async function hookKey(env: any) {
  const { sha256 } = await import('../lib/util');
  return (await sha256(env.APP_URL + ':hooks')).slice(0, 16);
}

root.post('/hooks/bounce', async (c) => {
  if (c.req.query('key') !== (await hookKey(c.env))) return c.text('forbidden', 403);
  const ct = c.req.header('content-type') || '';
  const items: Array<{ email: string; type?: string; diagnostic?: string; pub_id?: string }> = [];
  if (ct.includes('json')) {
    const j: any = await c.req.json();
    for (const x of Array.isArray(j) ? j : [j]) items.push(x);
  } else {
    const text = await c.req.text();
    for (const m of text.matchAll(/(?:Final-Recipient|Original-Rcpt-To|Original-Recipient):\s*(?:rfc822;)?\s*<?([^\s>;]+@[^\s>;]+)/gi)) items.push({ email: m[1], diagnostic: text.match(/Diagnostic-Code:\s*(.+)/i)?.[1] || text.match(/Status:\s*(\S+)/i)?.[1] || '' });
  }
  for (const it of items) {
    const cls = it.type === 'complaint' ? { type: 'complaint' as const } : classifyBounce(it.diagnostic || 'hard');
    await recordBounce(c.env, it.email, it.pub_id || null, cls.type, it.diagnostic || '');
    await run(c.env, `UPDATE deliveries SET status = ?, bounce_type = ? WHERE id = (SELECT id FROM deliveries WHERE email = ? ORDER BY created_at DESC LIMIT 1)`, cls.type === 'complaint' ? 'complained' : 'bounced', cls.type, it.email.toLowerCase());
  }
  return c.json({ processed: items.length });
});

// Feedback loop (ARF) reports → complaint suppression for the publication found via Feedback-ID / campaign header
root.post('/hooks/fbl', async (c) => {
  if (c.req.query('key') !== (await hookKey(c.env))) return c.text('forbidden', 403);
  const text = await c.req.text();
  const emails = [...new Set([...text.matchAll(/(?:Original-Rcpt-To|Removal-Recipient|^To):\s*<?([^\s>]+@[^\s>]+)/gim)].map((m) => m[1].toLowerCase()))];
  const fid = text.match(/Feedback-ID:\s*([^\r\n]+)/i)?.[1] || '';
  const campaign = text.match(/X-OpenHive-Campaign:\s*(\S+)/i)?.[1] || fid.split(':')[0];
  let pubId = fid.split(':')[1] || '';
  if (!pubId && campaign) pubId = (await one<any>(c.env, 'SELECT pub_id FROM sends WHERE id = ?', campaign))?.pub_id || '';
  for (const e of emails) {
    await recordBounce(c.env, e, pubId || null, 'complaint', 'fbl');
    if (!pubId) await suppress(c.env, e, 'global', 'fbl');
    if (campaign) await run(c.env, `UPDATE deliveries SET status = 'complained', bounce_type = 'complaint' WHERE send_id = ? AND email = ?`, campaign, e);
  }
  return c.json({ processed: emails.length });
});

export { hookKey };
export default { root } satisfies Module;
