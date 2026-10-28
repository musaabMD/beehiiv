// Unified customer timeline: one chronological feed per subscriber across every module —
// newsletter deliveries / opens / clicks, automation steps (and holdouts), transactional messages, orders (our checkout +
// Shopify / WooCommerce / Stripe), carts, inbox replies, page views, signups, event registrations, community posts,
// custom events (Events API) and the rest of the activity log.
//
// Each source is queried newest-first up to the cursor, then merged; the cursor is "<ms>_<key>" of the last item shown.
import type { Env, Subscriber } from '../types';
import { all } from './db';
import { parseJSON, clamp } from './util';

export const CATEGORIES: Record<string, string> = {
  email: 'Newsletter emails', automation: 'Automations', transactional: 'Transactional', order: 'Orders', cart: 'Carts',
  reply: 'Replies', web: 'Page views', signup: 'Signups', event: 'Events', community: 'Community', custom: 'Custom events', activity: 'Other activity',
};
export type Category = keyof typeof CATEGORIES;

export interface TimelineItem {
  key: string;             // stable unique key (source:id)
  at: number;
  category: Category;
  type: string;            // e.g. email.sent, email.opened, order.paid, custom.<name>
  title: string;
  detail?: string;
  href?: string | null;
  amount_cents?: number;
  currency?: string;
  data?: Record<string, unknown>;
}

// activity rows already shown from their own tables
const COVERED = new Set(['email.opened', 'email.clicked', 'order.paid', 'commerce.order_paid', 'automation.enrolled', 'custom_event', 'cart.abandoned', 'event.registered', 'community.post.created']);
const SIGNUP_TYPES = new Set(['subscription.created', 'subscription.confirmed', 'subscription.deleted', 'subscriber.welcome', 'subscribed', 'confirmed', 'unsubscribed', 'list.subscribed', 'list.unsubscribed']);

export function parseCursor(c: string | undefined | null): { at: number; key: string } | null {
  if (!c) return null;
  const i = c.indexOf('_');
  const at = Number(i > 0 ? c.slice(0, i) : c);
  return Number.isFinite(at) && at > 0 ? { at, key: i > 0 ? c.slice(i + 1) : '￿' } : null;
}

const money = (c: number, cur = 'usd') => (cur.toLowerCase() === 'usd' ? '$' : cur.toUpperCase() + ' ') + (c / 100).toFixed(2);
const host = (u: string) => { try { const x = new URL(u); return x.hostname + x.pathname.replace(/\/$/, ''); } catch { return u.slice(0, 80); } };

/** One page of a subscriber's timeline (newest first). `types` limits categories. */
export async function timeline(env: Env, pubId: string, s: Pick<Subscriber, 'id' | 'email' | 'created_at' | 'source' | 'source_detail'>, o: { cursor?: string | null; types?: string[]; limit?: number } = {}): Promise<{ items: TimelineItem[]; next_cursor: string | null }> {
  const limit = clamp(Math.floor(o.limit || 30), 1, 100);
  const cur = parseCursor(o.cursor);
  const before = cur ? cur.at : Number.MAX_SAFE_INTEGER;
  const want = new Set((o.types || []).filter((t) => t in CATEGORIES));
  const on = (c: Category) => !want.size || want.has(c);
  const n = limit + 1;
  const email = s.email.toLowerCase();
  const q: Array<Promise<TimelineItem[]>> = [];

  if (on('email') || on('automation')) {
    q.push(all<any>(env, `SELECT d.id, COALESCE(d.sent_at, d.created_at) AS at, d.status, d.variant, se.kind, se.subject, se.post_id, se.automation_id, p.title, a.name AS aname FROM deliveries d JOIN sends se ON se.id = d.send_id LEFT JOIN posts p ON p.id = se.post_id LEFT JOIN automations a ON a.id = se.automation_id
      WHERE d.subscriber_id = ? AND d.status != 'scheduled' AND COALESCE(d.sent_at, d.created_at) <= ? ORDER BY at DESC LIMIT ?`, s.id, before, n).then((rows) => rows.map((r) => ({
      key: `d:${r.id}`, at: r.at, category: (r.kind === 'automation' ? 'automation' : 'email') as Category, type: `email.${r.status === 'sent' ? 'sent' : r.status}`,
      title: `${r.status === 'sent' || r.status === 'deferred' ? 'Received' : r.status === 'bounced' ? 'Bounced' : r.status === 'suppressed' ? 'Suppressed' : 'Email ' + r.status}: ${r.subject || r.title || '(no subject)'}`,
      detail: r.kind === 'automation' ? `Automation · ${r.aname || ''}` : r.kind === 'post' ? 'Newsletter' : r.kind,
      href: r.post_id ? `/app/posts/${r.post_id}` : r.automation_id ? `/app/automations/${r.automation_id}/analytics` : null, data: { status: r.status, variant: r.variant },
    }))));
    q.push(all<any>(env, `SELECT d.id, d.opened_at AS at, d.open_count, se.kind, se.subject, se.post_id, se.automation_id FROM deliveries d JOIN sends se ON se.id = d.send_id
      WHERE d.subscriber_id = ? AND d.opened_at IS NOT NULL AND d.opened_at <= ? ORDER BY d.opened_at DESC LIMIT ?`, s.id, before, n).then((rows) => rows.map((r) => ({
      key: `o:${r.id}`, at: r.at, category: (r.kind === 'automation' ? 'automation' : 'email') as Category, type: 'email.opened',
      title: `Opened: ${r.subject || '(no subject)'}`, detail: r.open_count > 1 ? `${r.open_count} opens` : undefined, href: r.post_id ? `/app/posts/${r.post_id}` : null,
    }))));
    q.push(all<any>(env, `SELECT k.id, k.created_at AS at, k.url, se.kind, se.subject, se.post_id FROM deliveries d JOIN clicks k ON k.delivery_id = d.id JOIN sends se ON se.id = d.send_id
      WHERE d.subscriber_id = ? AND d.clicked_at IS NOT NULL AND k.is_bot = 0 AND k.created_at <= ? ORDER BY k.created_at DESC LIMIT ?`, s.id, before, n).then((rows) => rows.map((r) => ({
      key: `k:${r.id}`, at: r.at, category: (r.kind === 'automation' ? 'automation' : 'email') as Category, type: 'email.clicked',
      title: `Clicked ${host(r.url)}`, detail: `in “${r.subject || '(no subject)'}”`, href: r.post_id ? `/app/posts/${r.post_id}` : null, data: { url: r.url },
    }))));
    q.push(all<any>(env, `SELECT h.kind, h.ref_id, h.created_at AS at, p.title, a.name FROM holdout_members h LEFT JOIN posts p ON h.kind = 'post' AND p.id = h.ref_id LEFT JOIN automations a ON h.kind = 'automation' AND a.id = h.ref_id
      WHERE h.subscriber_id = ? AND h.created_at <= ? ORDER BY h.created_at DESC LIMIT ?`, s.id, before, n).then((rows) => rows.map((r) => ({
      key: `h:${r.kind}:${r.ref_id}`, at: r.at, category: (r.kind === 'automation' ? 'automation' : 'email') as Category, type: 'holdout',
      title: r.kind === 'post' ? `Held out (not sent): ${r.title || 'post'}` : `Held out of automation: ${r.name || ''}`, detail: 'Part of the holdout group used to measure incremental lift — not counted as unopened.',
      href: r.kind === 'post' ? `/app/posts/${r.ref_id}` : `/app/automations/${r.ref_id}/analytics`,
    }))));
  }
  if (on('automation')) {
    q.push(all<any>(env, `SELECT l.id, l.created_at AS at, l.action, l.result, r.automation_id, a.name FROM automation_runs r JOIN automation_logs l ON l.run_id = r.id JOIN automations a ON a.id = r.automation_id
      WHERE r.subscriber_id = ? AND l.action != 'send_email' AND l.created_at <= ? ORDER BY l.created_at DESC LIMIT ?`, s.id, before, n).then((rows) => rows.map((r) => ({
      key: `l:${r.id}`, at: r.at, category: 'automation' as Category, type: `automation.${r.action}`,
      title: r.action === 'enrolled' ? `Entered automation: ${r.name}` : r.action === 'completed' ? `Completed automation: ${r.name}` : r.action === 'exited' ? `Left automation: ${r.name}` : `${r.name}: ${r.action.replace(/_/g, ' ')}`,
      detail: r.action === 'enrolled' ? undefined : r.result || undefined, href: `/app/automations/${r.automation_id}/journeys`,
    }))));
  }
  if (on('transactional')) {
    q.push(all<any>(env, `SELECT id, created_at AS at, subject, status, opened_at, clicked_at FROM tx_messages WHERE pub_id = ? AND to_email = ? AND created_at <= ? ORDER BY created_at DESC LIMIT ?`, pubId, email, before, n).then((rows) => rows.flatMap((r) => [
      { key: `t:${r.id}`, at: r.at, category: 'transactional' as Category, type: `transactional.${r.status}`, title: `Transactional: ${r.subject || '(no subject)'}`, detail: r.status, href: `/app/settings/transactional/m/${r.id}` },
      ...(r.opened_at ? [{ key: `to:${r.id}`, at: r.opened_at, category: 'transactional' as Category, type: 'transactional.opened', title: `Opened transactional: ${r.subject || ''}` }] : []),
      ...(r.clicked_at ? [{ key: `tc:${r.id}`, at: r.clicked_at, category: 'transactional' as Category, type: 'transactional.clicked', title: `Clicked in transactional: ${r.subject || ''}` }] : []),
    ].filter((x) => x.at <= before))));
  }
  if (on('order')) {
    q.push(all<any>(env, `SELECT id, kind, status, amount_cents, currency, COALESCE(paid_at, created_at) AS at, data FROM orders WHERE pub_id = ? AND (subscriber_id = ? OR email = ?) AND status IN ('paid','refunded') AND COALESCE(paid_at, created_at) <= ? ORDER BY at DESC LIMIT ?`, pubId, s.id, email, before, n).then((rows) => rows.map((r) => ({
      key: `or:${r.id}`, at: r.at, category: 'order' as Category, type: `order.${r.status}`, title: `${r.status === 'refunded' ? 'Refunded' : 'Paid'} ${money(r.amount_cents, r.currency)} — ${parseJSON<any>(r.data, {}).description || r.kind}`,
      detail: `Checkout · ${r.kind}`, amount_cents: r.amount_cents, currency: r.currency,
    }))));
    q.push(all<any>(env, `SELECT o.id, o.platform, o.status, o.total_cents, o.currency, o.order_number, COALESCE(o.paid_at, o.created_at) AS at, (SELECT GROUP_CONCAT(i.name, ', ') FROM external_order_items i WHERE i.order_id = o.id) AS items FROM external_orders o
      WHERE o.pub_id = ? AND o.email = ? AND COALESCE(o.paid_at, o.created_at) <= ? ORDER BY at DESC LIMIT ?`, pubId, email, before, n).then((rows) => rows.map((r) => ({
      key: `xo:${r.id}`, at: r.at, category: 'order' as Category, type: `store_order.${r.status}`, title: `${r.platform[0].toUpperCase() + r.platform.slice(1)} order${r.order_number ? ' #' + r.order_number : ''}: ${money(r.total_cents, r.currency)} (${r.status})`,
      detail: r.items || undefined, amount_cents: r.total_cents, currency: r.currency,
    }))));
  }
  if (on('cart')) {
    q.push(all<any>(env, `SELECT id, platform, status, total_cents, currency, items, checkout_updated_at AS at, recovered_at FROM abandoned_carts WHERE pub_id = ? AND email = ? AND checkout_updated_at <= ? ORDER BY checkout_updated_at DESC LIMIT ?`, pubId, email, before, n).then((rows) => rows.map((r) => ({
      key: `c:${r.id}`, at: r.at, category: 'cart' as Category, type: `cart.${r.status}`, title: `Cart ${r.status} · ${money(r.total_cents, r.currency)} (${r.platform})`,
      detail: parseJSON<any[]>(r.items, []).map((i) => i.name).filter(Boolean).join(', ') || undefined, amount_cents: r.total_cents, currency: r.currency,
    }))));
  }
  if (on('reply')) {
    q.push(all<any>(env, `SELECT m.id, m.created_at AS at, m.direction, m.subject, m.text, t.id AS tid FROM inbox_threads t JOIN inbox_messages m ON m.thread_id = t.id WHERE t.pub_id = ? AND (t.email = ? OR t.subscriber_id = ?) AND m.created_at <= ? ORDER BY m.created_at DESC LIMIT ?`, pubId, email, s.id, before, n).then((rows) => rows.map((r) => ({
      key: `r:${r.id}`, at: r.at, category: 'reply' as Category, type: r.direction === 'in' ? 'reply.received' : 'reply.sent', title: `${r.direction === 'in' ? 'Replied' : 'You replied'}: ${r.subject || '(no subject)'}`,
      detail: String(r.text || '').replace(/\s+/g, ' ').slice(0, 160) || undefined, href: `/app/audience/inbox/${r.tid}`,
    }))));
  }
  if (on('web')) {
    q.push(all<any>(env, `SELECT id, created_at AS at, path, channel, referrer FROM page_views WHERE subscriber_id = ? AND created_at <= ? ORDER BY created_at DESC LIMIT ?`, s.id, before, n).then((rows) => rows.map((r) => ({
      key: `v:${r.id}`, at: r.at, category: 'web' as Category, type: 'page.viewed', title: `Viewed ${r.path}`, detail: r.channel ? `via ${r.channel}` : undefined,
    }))));
  }
  if (on('event')) {
    q.push(all<any>(env, `SELECT r.id, r.created_at AS at, r.attended_at, e.title, e.id AS eid FROM event_registrations r JOIN live_events e ON e.id = r.event_id WHERE r.pub_id = ? AND (r.subscriber_id = ? OR r.email = ?) AND r.created_at <= ? ORDER BY r.created_at DESC LIMIT ?`, pubId, s.id, email, before, n).then((rows) => rows.flatMap((r) => [
      { key: `e:${r.id}`, at: r.at, category: 'event' as Category, type: 'event.registered', title: `Registered for ${r.title}`, href: `/app/events/${r.eid}` },
      ...(r.attended_at && r.attended_at <= before ? [{ key: `ea:${r.id}`, at: r.attended_at, category: 'event' as Category, type: 'event.attended', title: `Attended ${r.title}`, href: `/app/events/${r.eid}` }] : []),
    ])));
  }
  if (on('community')) {
    q.push(all<any>(env, `SELECT id, created_at AS at, title, body, 'post' AS k FROM community_posts WHERE pub_id = ? AND author_subscriber_id = ? AND created_at <= ?
      UNION ALL SELECT id, created_at AS at, '' AS title, body, 'comment' AS k FROM community_comments WHERE pub_id = ? AND author_subscriber_id = ? AND created_at <= ? ORDER BY at DESC LIMIT ?`, pubId, s.id, before, pubId, s.id, before, n).then((rows) => rows.map((r) => ({
      key: `cm:${r.id}`, at: r.at, category: 'community' as Category, type: `community.${r.k}`, title: r.k === 'post' ? `Posted in the community: ${r.title || String(r.body).slice(0, 60)}` : 'Commented in the community',
      detail: String(r.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160),
    }))));
  }
  if (on('custom')) {
    q.push(all<any>(env, `SELECT id, name, properties, occurred_at AS at FROM custom_events WHERE pub_id = ? AND email = ? AND occurred_at <= ? ORDER BY occurred_at DESC LIMIT ?`, pubId, email, before, n).then((rows) => rows.map((r) => {
      const props = parseJSON<Record<string, unknown>>(r.properties, {});
      const shown = Object.entries(props).slice(0, 4).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
      return { key: `ce:${r.id}`, at: r.at, category: 'custom' as Category, type: `custom.${r.name}`, title: `Event: ${r.name}`, detail: shown || undefined, data: props };
    })));
  }
  if (on('signup') || on('activity')) {
    q.push(all<any>(env, `SELECT id, created_at AS at, type, data, ref_id FROM activity WHERE subscriber_id = ? AND created_at <= ? ORDER BY created_at DESC LIMIT ?`, s.id, before, n * 2).then((rows) => rows.filter((r) => !COVERED.has(r.type)).map((r) => {
      const d = parseJSON<any>(r.data, {});
      const signup = SIGNUP_TYPES.has(r.type);
      const bits = [d.tag && `tag ${d.tag}`, d.source && `via ${d.source}${d.source_detail ? ' (' + d.source_detail + ')' : ''}`, d.list && `list ${d.list}`, d.fields && Object.keys(d.fields).join(', '), d.reason && `reason: ${d.reason}`].filter(Boolean);
      return { key: `a:${r.id}`, at: r.at, category: (signup ? 'signup' : 'activity') as Category, type: r.type, title: r.type.replace(/[._]/g, ' ').replace(/^./, (x: string) => x.toUpperCase()), detail: bits.join(' · ') || undefined };
    }).filter((x) => on(x.category))));
    if (on('signup') && s.created_at <= before) {
      // the signup itself (older subscribers may predate the activity log)
      q.push(Promise.resolve([{ key: `s:${s.id}`, at: s.created_at, category: 'signup' as Category, type: 'subscriber.created', title: `Subscribed${s.source ? ' via ' + s.source.replace(/_/g, ' ') : ''}`, detail: s.source === 'form' && s.source_detail ? `form ${s.source_detail}` : undefined }]));
    }
  }

  const merged = (await Promise.all(q)).flat()
    .filter((x) => x.at && (!cur || x.at < cur.at || (x.at === cur.at && x.key < cur.key)))
    .sort((a, b) => b.at - a.at || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  const items = merged.slice(0, limit);
  const more = merged.length > limit;
  return { items, next_cursor: more && items.length ? `${items[items.length - 1].at}_${items[items.length - 1].key}` : null };
}
