/** @jsxImportSource hono/jsx */
// Module: events — webinars with native streaming (LiveRoom DO), tickets in 10 currencies, reminders, calendar invites,
// recordings + replay products, 1:1 coaching bookings, Luma integration.
import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { AppEnv, Ctx, Env, Module, Publication, Subscriber } from '../types';
import { one, all, run, insert, val } from '../lib/db';
import { requirePerm, currentUser, userPubs, can, readerEmail } from '../lib/auth';
import { DashLayout } from '../ui/layout';
import { Card, Btn, LinkBtn, ActionForm, Field, Input, Textarea, Select, Check, Status, Stat, Stats, Empty, Table, Tabs, Copy, Help, Code, back, Grid, Modal, OpenBtn, Bars } from '../ui/components';
import { SiteLayout, SiteMessage } from '../ui/site';
import { siteUrl, senderFor } from '../lib/pub';
import { storeFile, serveObject } from '../lib/media';
import { emit } from '../lib/events';
import { registerPeriodic } from '../lib/jobs';
import { createCheckout, onOrderPaid, applyOffer, stripeEnabled } from '../lib/payments';
import { subscribe } from '../lib/subscribers';
import { sendMail, sendTransactional, button } from '../lib/email';
import { botScore, clientIP, rateLimit, validateEmail } from '../lib/guard';
import { trackView } from '../lib/tracking';
import { sanitizeHtml } from '../lib/sanitize';
import { buildIcs, googleCalendarUrl, toBase64 } from '../lib/ics';
import { zonedToUtc, utcToZoned, timezones, tzLabel } from '../lib/tz';
import { id, now, slugify, form, str, int, bool, parseJSON, token, fmtDate, num, esc, stripTags, truncate, toCSV, MIN, HOUR, DAY } from '../lib/util';

const dash = new Hono<AppEnv>();
const site = new Hono<AppEnv>();
const root = new Hono<AppEnv>();

// ───────────────── constants & helpers ─────────────────
export const CURRENCIES: Array<[string, string]> = [['usd', 'USD — US dollar'], ['eur', 'EUR — Euro'], ['gbp', 'GBP — British pound'], ['cad', 'CAD — Canadian dollar'], ['aud', 'AUD — Australian dollar'], ['jpy', 'JPY — Japanese yen'], ['inr', 'INR — Indian rupee'], ['brl', 'BRL — Brazilian real'], ['mxn', 'MXN — Mexican peso'], ['chf', 'CHF — Swiss franc']];
const ZERO_DECIMAL = new Set(['jpy']);
const REMINDER_PRESETS: Array<[string, string]> = [['', '—'], ['10', '10 minutes before'], ['15', '15 minutes before'], ['30', '30 minutes before'], ['60', '1 hour before'], ['120', '2 hours before'], ['180', '3 hours before'], ['360', '6 hours before'], ['720', '12 hours before'], ['1440', '1 day before'], ['2880', '2 days before'], ['10080', '1 week before']];
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Amount in the currency's minor unit (cents; yen for JPY). */
function parsePrice(v: unknown, currency: string): number {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));
  if (isNaN(n) || n <= 0) return 0;
  return ZERO_DECIMAL.has(currency) ? Math.round(n) : Math.round(n * 100);
}
export function fmtPrice(minor: number, currency: string): string {
  if (!minor) return 'Free';
  const major = ZERO_DECIMAL.has(currency) ? minor : minor / 100;
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(major); } catch { return `${major} ${currency.toUpperCase()}`; }
}
const priceInput = (minor: number, currency: string) => (minor ? String(ZERO_DECIMAL.has(currency) ? minor : (minor / 100).toFixed(2)) : '');

const evUrl = (env: Env, pub: Publication, ev: any) => `${siteUrl(env, pub)}/events/${ev.slug}`;
const joinUrl = (env: Env, pub: Publication, ev: any, tok: string) => `${siteUrl(env, pub)}/events/${ev.slug}/join/${tok}`;

function whenText(ev: any, start = ev.starts_at, end = ev.ends_at) {
  const d = fmtDate(start, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }, ev.timezone);
  const e = fmtDate(end, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }, ev.timezone);
  return `${d} – ${e}`;
}

async function uniqueEventSlug(env: Env, pubId: string, base: string, except = '') {
  const b = slugify(base || 'event');
  let s = b, i = 2;
  while (await one(env, 'SELECT 1 FROM live_events WHERE pub_id = ? AND slug = ? AND id != ?', pubId, s, except)) s = `${b}-${i++}`;
  return s;
}

function remindersOf(ev: any): number[] {
  return parseJSON<number[]>(ev.reminders, []).map(Number).filter((n) => n > 0).slice(0, 5);
}

async function regCount(env: Env, eventId: string) {
  return val<number>(env, `SELECT COUNT(*) FROM event_registrations WHERE event_id = ? AND kind = 'attendee'`, eventId);
}

function icsFor(env: Env, pub: Publication, ev: any, from: { email: string; name: string }, reg: { id: string; email: string; name: string; token: string }, start = ev.starts_at, end = ev.ends_at) {
  const url = joinUrl(env, pub, ev, reg.token);
  return buildIcs({
    uid: `${reg.id}@openhive`, title: ev.title, description: stripTags(ev.description || '').slice(0, 1500), start, end,
    location: ev.kind === 'in_person' ? ev.location || '' : url, url: ev.kind === 'in_person' ? evUrl(env, pub, ev) : url,
    organizer: { name: from.name, email: from.email }, attendee: { name: reg.name, email: reg.email }, method: 'REQUEST',
  });
}

async function sendConfirmation(env: Env, pub: Publication, ev: any, reg: any, booking?: { starts_at: number; ends_at: number } | null) {
  const from = await senderFor(env, pub, 'transactional');
  const start = booking?.starts_at ?? ev.starts_at, end = booking?.ends_at ?? ev.ends_at;
  const url = joinUrl(env, pub, ev, reg.token);
  const ics = icsFor(env, pub, ev, from, reg, start, end);
  const gcal = googleCalendarUrl({ title: ev.title, description: `${stripTags(ev.description || '').slice(0, 800)}\n\nJoin: ${url}`, start, end, location: ev.kind === 'in_person' ? ev.location || '' : url });
  const html = `<!DOCTYPE html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="540" cellpadding="0" cellspacing="0" style="max-width:100%;background:#fff;border-radius:10px">
${ev.cover_url ? `<tr><td><img src="${esc(ev.cover_url)}" width="540" alt="" style="display:block;width:100%;height:auto;border-radius:10px 10px 0 0"></td></tr>` : ''}
<tr><td style="padding:28px;font-size:15px;line-height:1.6;color:#1f2328">
<p style="margin:0 0 4px;color:#6b7280;font-size:13px">${esc(pub.name)}</p>
<h1 style="margin:0 0 12px;font-size:24px">You're registered: ${esc(ev.title)}</h1>
<p style="margin:0 0 4px"><strong>📅 ${esc(whenText(ev, start, end))}</strong></p>
${ev.kind === 'in_person' && ev.location ? `<p style="margin:0 0 4px">📍 ${esc(ev.location)}</p>` : '<p style="margin:0 0 4px">💻 Online — join from your browser, no downloads needed.</p>'}
<p style="margin:20px 0"><a href="${url}" style="display:inline-block;background:#111827;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">${ev.kind === 'in_person' ? 'View your ticket' : 'Your personal join link'}</a></p>
<p style="margin:0 0 4px;font-size:14px"><a href="${gcal}" style="color:#b45309">Add to Google Calendar</a> · A calendar invite (.ics) is attached for Apple Calendar and Outlook.</p>
<p style="margin:16px 0 0;color:#6b7280;font-size:13px">This link is personal — please don't share it. We'll send a reminder before it starts.</p>
</td></tr></table></td></tr></table></body></html>`;
  return sendMail(env, {
    to: reg.email, subject: `Confirmed: ${ev.title}`, html, pub, kind: 'transactional', from, replyTo: pub.reply_to,
    attachments: [{ content: toBase64(ics), filename: 'invite.ics', type: 'text/calendar', disposition: 'attachment' }],
  });
}

interface RegInput { email: string; name?: string; orderId?: string | null; kind?: 'attendee' | 'replay'; slot?: number | null; reader?: boolean }

/** Register someone for an event: grows the list (source 'event'), creates the registration, emails the invite. */
export async function registerAttendee(env: Env, pub: Publication, ev: any, input: RegInput): Promise<{ ok: boolean; reg?: any; error?: string }> {
  const email = input.email.trim().toLowerCase();
  const sub = await subscribe(env, pub, { email, name: input.name, source: 'event', sourceDetail: ev.id, strict: false, skipConfirm: !!input.reader });
  if (!sub.ok) return { ok: false, error: sub.error };
  const kind = input.kind || 'attendee';
  let booking: any = null;
  if (input.slot && ev.kind === 'coaching') {
    const dur = (parseJSON<any>(ev.coaching, {}).duration_min || 30) * MIN;
    const clash = await one(env, `SELECT 1 FROM bookings WHERE product_id = ? AND status = 'confirmed' AND starts_at < ? AND ends_at > ?`, ev.id, input.slot + dur, input.slot);
    if (clash) return { ok: false, error: 'Sorry — that time was just booked. Please pick another slot.' };
    booking = { id: id(), pub_id: pub.id, product_id: ev.id, order_id: input.orderId ?? null, subscriber_id: sub.subscriber?.id ?? null, email, name: input.name || sub.subscriber?.name || '', starts_at: input.slot, ends_at: input.slot + dur, status: 'confirmed', notes: '', created_at: now() };
    await insert(env, 'bookings', booking);
  }
  let reg = await one<any>(env, 'SELECT * FROM event_registrations WHERE event_id = ? AND email = ?', ev.id, email);
  const start = booking?.starts_at ?? ev.starts_at;
  const passed = remindersOf(ev).filter((m) => start - m * MIN <= now());
  if (reg) {
    const patch: string[] = [];
    const params: unknown[] = [];
    if (reg.kind === 'replay' && kind === 'attendee') { patch.push(`kind = 'attendee'`); }
    if (input.orderId && !reg.order_id) { patch.push('order_id = ?'); params.push(input.orderId); }
    if (booking) { patch.push('booking_id = ?', 'reminders_sent = ?'); params.push(booking.id, JSON.stringify(passed)); }
    if (patch.length) await run(env, `UPDATE event_registrations SET ${patch.join(', ')} WHERE id = ?`, ...params, reg.id);
    reg = await one<any>(env, 'SELECT * FROM event_registrations WHERE id = ?', reg.id);
    if (!booking && !(input.orderId && patch.length)) return { ok: true, reg };
  } else {
    reg = { id: id(), event_id: ev.id, pub_id: pub.id, subscriber_id: sub.subscriber?.id ?? null, email, name: (input.name || sub.subscriber?.name || '').slice(0, 120), order_id: input.orderId ?? null, token: token(18), reminders_sent: JSON.stringify(passed), kind, booking_id: booking?.id ?? null, created_at: now() };
    await insert(env, 'event_registrations', reg);
  }
  if (kind === 'attendee') {
    await emit(env, { pubId: pub.id, type: 'event.registered', subscriberId: reg.subscriber_id, refId: ev.id, data: { event_id: ev.id, title: ev.title, starts_at: start, order_id: input.orderId ?? null } });
    await sendConfirmation(env, pub, ev, reg, booking);
  } else {
    await sendTransactional(env, email, `Your replay: ${ev.title}`, `<p>Thanks for your purchase! Watch the full recording of <strong>${esc(ev.title)}</strong> anytime:</p>${button('Watch the replay', `${evUrl(env, pub, ev)}/replay?t=${reg.token}`)}`, pub);
  }
  return { ok: true, reg };
}

async function canAccessReplay(c: Ctx, ev: any): Promise<boolean> {
  const t = c.req.query('t');
  if (t && (await one(c.env, 'SELECT 1 FROM event_registrations WHERE event_id = ? AND token = ?', ev.id, t))) return true;
  const email = c.get('reader')?.email || (await readerEmail(c));
  if (email) {
    if (await one(c.env, 'SELECT 1 FROM event_registrations WHERE event_id = ? AND email = ?', ev.id, email)) return true;
    if (ev.replay_product_id && (await one(c.env, `SELECT 1 FROM orders WHERE email = ? AND status = 'paid' AND ref_id = ?`, email, ev.replay_product_id))) return true;
  }
  const u = await currentUser(c);
  return !!u && (await userPubs(c.env, u.id)).some((p) => p.id === ev.pub_id);
}

/** Available coaching slots (UTC ms) for the next N days. */
async function coachingSlots(env: Env, ev: any): Promise<Array<{ day: string; slots: number[] }>> {
  const cfg = parseJSON<any>(ev.coaching, {});
  const dur = Math.max(10, Number(cfg.duration_min) || 30) * MIN;
  const ahead = Math.min(90, Math.max(1, Number(cfg.days_ahead) || 14));
  const avail: Array<{ dow: number; start: string; end: string }> = cfg.availability || [];
  const booked = await all<{ starts_at: number; ends_at: number }>(env, `SELECT starts_at, ends_at FROM bookings WHERE product_id = ? AND status = 'confirmed' AND ends_at > ?`, ev.id, now());
  const out: Array<{ day: string; slots: number[] }> = [];
  const todayLocal = utcToZoned(now(), ev.timezone).slice(0, 10);
  const base = Date.parse(todayLocal + 'T00:00:00Z');
  for (let i = 0; i < ahead; i++) {
    const day = new Date(base + i * DAY).toISOString().slice(0, 10);
    const dow = new Date(day + 'T12:00:00Z').getUTCDay();
    const slots: number[] = [];
    for (const a of avail.filter((x) => Number(x.dow) === dow)) {
      const s = zonedToUtc(`${day}T${a.start}`, ev.timezone), e = zonedToUtc(`${day}T${a.end}`, ev.timezone);
      if (s == null || e == null) continue;
      for (let t = s; t + dur <= e; t += dur) {
        if (t < now() + HOUR) continue;
        if (ev.starts_at && t < ev.starts_at - DAY) continue;
        if (ev.ends_at && t > ev.ends_at) continue;
        if (booked.some((b) => b.starts_at < t + dur && b.ends_at > t)) continue;
        slots.push(t);
      }
    }
    if (slots.length) out.push({ day, slots: slots.sort((a, b) => a - b) });
  }
  return out;
}

// Paid tickets / bookings / replays
// Paid tickets, bookings and replay purchases all use order kind 'ticket' (data.replay marks replay purchases).
onOrderPaid('ticket', async (env, order, pub) => {
  const ev = await one<any>(env, 'SELECT * FROM live_events WHERE id = ?', order.ref_id);
  if (!ev) return;
  const d = parseJSON<any>(order.data, {});
  const r = d.replay
    ? await registerAttendee(env, pub, ev, { email: order.email, name: order.name, orderId: order.id, kind: 'replay', reader: true })
    : await registerAttendee(env, pub, ev, { email: order.email, name: order.name, orderId: order.id, slot: d.slot ? Number(d.slot) : null, reader: true });
  if (r.reg?.subscriber_id) await run(env, 'UPDATE orders SET subscriber_id = COALESCE(subscriber_id, ?) WHERE id = ?', r.reg.subscriber_id, order.id);
  if (d.replay && ev.replay_product_id) await run(env, 'UPDATE products SET sales_count = sales_count + 1, revenue_cents = revenue_cents + ? WHERE id = ?', order.amount_cents, ev.replay_product_id);
});

// Reminder emails (up to 5 per event)
registerPeriodic('events.reminders', MIN - 5000, async (env) => {
  const t = now();
  const evs = await all<any>(env, `SELECT * FROM live_events WHERE status = 'published' AND kind != 'coaching' AND starts_at > ? AND starts_at <= ? AND stream_status != 'ended'`, t, t + 7 * DAY + HOUR);
  for (const ev of evs) {
    const due = remindersOf(ev).filter((m) => t >= ev.starts_at - m * MIN);
    if (!due.length) continue;
    const pub = await one<Publication>(env, 'SELECT * FROM publications WHERE id = ?', ev.pub_id);
    if (!pub) continue;
    for (const m of due) {
      const regs = await all<any>(env, `SELECT * FROM event_registrations WHERE event_id = ? AND kind = 'attendee' AND NOT EXISTS (SELECT 1 FROM json_each(reminders_sent) j WHERE j.value = ?) LIMIT 200`, ev.id, m);
      for (const reg of regs) await sendReminder(env, pub, ev, reg, m, ev.starts_at, ev.ends_at);
    }
  }
  // coaching: remind 1 hour and 15 minutes before each booking
  const books = await all<any>(env, `SELECT b.*, r.id AS reg_id, r.token, r.reminders_sent, e.id AS ev_id FROM bookings b JOIN event_registrations r ON r.booking_id = b.id JOIN live_events e ON e.id = b.product_id WHERE b.status = 'confirmed' AND b.starts_at > ? AND b.starts_at <= ?`, t, t + HOUR + MIN);
  for (const b of books) {
    const ev = await one<any>(env, 'SELECT * FROM live_events WHERE id = ?', b.ev_id);
    const pub = ev && (await one<Publication>(env, 'SELECT * FROM publications WHERE id = ?', ev.pub_id));
    if (!ev || !pub) continue;
    const sent = parseJSON<number[]>(b.reminders_sent, []);
    for (const m of [60, 15]) if (t >= b.starts_at - m * MIN && !sent.includes(m)) await sendReminder(env, pub, ev, { id: b.reg_id, email: b.email, name: b.name, token: b.token }, m, b.starts_at, b.ends_at);
  }
});

async function sendReminder(env: Env, pub: Publication, ev: any, reg: any, m: number, start: number, end: number) {
  const left = Math.max(1, Math.round((start - now()) / MIN));
  const human = left >= 1440 ? `${Math.round(left / 1440)} day${Math.round(left / 1440) > 1 ? 's' : ''}` : left >= 60 ? `${Math.round(left / 60)} hour${Math.round(left / 60) > 1 ? 's' : ''}` : `${left} minutes`;
  const url = joinUrl(env, pub, ev, reg.token);
  await sendTransactional(env, reg.email, `Starting in ${human}: ${ev.title}`, `<p>Hi${reg.name ? ' ' + esc(reg.name.split(' ')[0]) : ''}, a quick reminder that <strong>${esc(ev.title)}</strong> starts in ${human}.</p><p>📅 ${esc(whenText(ev, start, end))}</p>${ev.kind === 'in_person' ? `<p>📍 ${esc(ev.location || '')}</p>${button('View your ticket', url)}` : button('Join the event', url)}<p style="color:#6b7280;font-size:13px">Join from any browser — no downloads required.</p>`, pub, await senderFor(env, pub, 'transactional'));
  await run(env, `UPDATE event_registrations SET reminders_sent = json_insert(COALESCE(reminders_sent, '[]'), '$[#]', CAST(? AS INTEGER)) WHERE id = ?`, m, reg.id);
}

// ───────────────── dashboard ─────────────────
dash.use('*', requirePerm('manage'));

async function getEvent(c: Ctx, eid: string) {
  return one<any>(c.env, 'SELECT * FROM live_events WHERE id = ? AND pub_id = ?', eid, c.get('pub').id);
}

const EvTabs = (p: { ev: any; active: string }) => (
  <Tabs active={p.active} items={[
    [`/app/events/${p.ev.id}`, 'Overview'], [`/app/events/${p.ev.id}/registrations`, p.ev.kind === 'coaching' ? 'Bookings' : 'Registrations'], [`/app/events/${p.ev.id}/orders`, 'Orders & revenue'],
    [`/app/events/${p.ev.id}/promote`, 'Promote'], [`/app/events/${p.ev.id}/replay`, 'Recording & replay'], [`/app/events/${p.ev.id}/edit`, 'Settings'],
  ]} />
);

async function revenueOf(env: Env, ev: any) {
  return all<{ currency: string; total: number; n: number }>(env, `SELECT currency, SUM(amount_cents) AS total, COUNT(*) AS n FROM orders WHERE pub_id = ? AND status = 'paid' AND ((kind IN ('ticket','replay') AND ref_id = ?) OR (ref_id = ? AND ? IS NOT NULL)) GROUP BY currency`, ev.pub_id, ev.id, ev.replay_product_id || '', ev.replay_product_id);
}

dash.get('/', async (c) => {
  const pub = c.get('pub');
  const tab = c.req.query('tab') === 'past' ? 'past' : 'upcoming';
  const evs = await all<any>(c.env, `SELECT e.*, (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.id AND r.kind = 'attendee') AS regs FROM live_events e WHERE e.pub_id = ? AND ${tab === 'past' ? 'e.ends_at < ?' : 'e.ends_at >= ?'} ORDER BY e.starts_at ${tab === 'past' ? 'DESC' : 'ASC'}`, pub.id, now());
  const totalRegs = await val<number>(c.env, `SELECT COUNT(*) FROM event_registrations WHERE pub_id = ? AND kind = 'attendee'`, pub.id);
  const rev = await all<any>(c.env, `SELECT currency, SUM(amount_cents) AS total FROM orders WHERE pub_id = ? AND status = 'paid' AND kind IN ('ticket','replay') GROUP BY currency`, pub.id);
  return c.html(
    <DashLayout c={c} title="Events" section="events" actions={<><LinkBtn href="/app/events/luma">Luma</LinkBtn><LinkBtn href="/app/events/new" kind="primary">New event</LinkBtn></>}>
      <Stats>
        <Stat label="Upcoming events" value={num(await val<number>(c.env, 'SELECT COUNT(*) FROM live_events WHERE pub_id = ? AND ends_at >= ?', pub.id, now()))} />
        <Stat label="Total registrations" value={num(totalRegs)} />
        <Stat label="Ticket revenue" value={rev.length ? rev.map((r) => fmtPrice(r.total, r.currency)).join(' · ') : fmtPrice(0, 'usd')} sub="0% platform fees" />
      </Stats>
      <Tabs active={tab === 'past' ? 'Past' : 'Upcoming'} items={[['/app/events', 'Upcoming'], ['/app/events?tab=past', 'Past']]} />
      <Table rows={evs} rowHref={(e) => `/app/events/${e.id}`} empty={<Empty icon="📅" title={tab === 'past' ? 'No past events' : 'Host your first live event'} body="Webinars, workshops, in-person meetups and 1:1 coaching — with tickets, reminders, calendar invites and recordings. No Zoom required." action={<LinkBtn href="/app/events/new" kind="primary">Create event</LinkBtn>} />} cols={[
        { h: 'Event', r: (e) => <div class="row">{e.cover_url ? <img class="thumb" src={e.cover_url} alt="" /> : <span class="thumb" />}<div><a href={`/app/events/${e.id}`}>{e.title}</a><div class="muted small">{e.kind === 'webinar' ? 'Live webinar' : e.kind === 'in_person' ? 'In person' : '1:1 coaching'}</div></div></div> },
        { h: 'When', r: (e) => <span class="nowrap">{fmtDate(e.starts_at, { dateStyle: 'medium', timeStyle: 'short' }, e.timezone)}</span> },
        { h: 'Price', r: (e) => fmtPrice(e.price_cents, e.currency) },
        { h: 'Registrations', r: (e) => `${num(e.regs)}${e.kind !== 'coaching' ? ` / ${num(e.capacity)}` : ''}`, class: 'right' },
        { h: 'Status', r: (e) => <Status s={e.stream_status === 'live' ? 'live' : e.status === 'draft' ? 'draft' : e.ends_at < now() ? 'ended' : 'scheduled'} /> },
      ]} />
    </DashLayout>,
  );
});

function EventForm(p: { ev?: any; action: string; tiersExist?: boolean }) {
  const e = p.ev || { kind: 'webinar', timezone: 'UTC', capacity: 10000, currency: 'usd', access: 'public', reminders: '[1440,60]', status: 'published', coaching: '{}' };
  const rem = remindersOf(e);
  const coach = parseJSON<any>(e.coaching, {});
  const avail: any[] = coach.availability || [];
  const tzs = timezones();
  return (
    <form method="post" action={p.action} class="split" data-event-form>
      <div>
        <Card>
          <Field label="Event type"><Select name="kind" value={e.kind} options={[['webinar', 'Live webinar (streamed in the browser)'], ['in_person', 'In-person event'], ['coaching', '1:1 coaching sessions (bookable slots)']]} attrs={{ 'data-kind': '1' }} /></Field>
          <Field label="Title"><Input name="title" value={e.title} required /></Field>
          <Field label="Description" hint="Basic HTML allowed (paragraphs, links, lists)."><Textarea name="description" value={e.description} rows={7} /></Field>
          <Field label="Cover image">
            <img data-preview="cover_url" src={e.cover_url || ''} class={e.cover_url ? '' : 'hide'} style="max-width:100%;max-height:200px;border-radius:8px;margin-bottom:6px" alt="" />
            <input type="file" accept="image/*" class="input" data-image-upload="cover_url" />
            <Input name="cover_url" value={e.cover_url} placeholder="or image URL" attrs={{ 'data-image-field': 'cover_url' }} />
          </Field>
          <Grid cols={2}>
            <Field label={<span data-when-label>Starts</span>}><input type="datetime-local" class="input" name="starts_local" value={utcToZoned(e.starts_at, e.timezone)} required /></Field>
            <Field label="Ends"><input type="datetime-local" class="input" name="ends_local" value={utcToZoned(e.ends_at, e.timezone)} required /></Field>
          </Grid>
          <Field label="Timezone"><select class="input" name="timezone">{tzs.map((z) => <option value={z} selected={z === e.timezone}>{z.replace(/_/g, ' ')}</option>)}</select></Field>
          <div data-show-kind="in_person"><Field label="Location / address"><Input name="location" value={e.location} placeholder="Venue, street, city" /></Field></div>
          <div data-show-kind="coaching">
            <Card title="Coaching availability">
              <Grid cols={2}>
                <Field label="Session length (minutes)"><Input name="duration_min" type="number" min="10" step="5" value={coach.duration_min || 30} /></Field>
                <Field label="Bookable days ahead"><Input name="days_ahead" type="number" min="1" max="90" value={coach.days_ahead || 14} /></Field>
              </Grid>
              <Help>Times are in the event timezone. The start/end dates above bound the booking window.</Help>
              <table class="table"><tbody>
                {DOW.map((d, i) => {
                  const a = avail.find((x) => Number(x.dow) === i);
                  return (
                    <tr><td><label class="check" style="margin:0"><input type="checkbox" name={`dow_${i}`} checked={!!a} /> <span>{d}</span></label></td>
                      <td><input type="time" class="input" name={`start_${i}`} value={a?.start || '09:00'} /></td><td><input type="time" class="input" name={`end_${i}`} value={a?.end || '17:00'} /></td></tr>
                  );
                })}
              </tbody></table>
            </Card>
          </div>
        </Card>
      </div>
      <div>
        <Card title="Tickets & access">
          <Grid cols={2}>
            <Field label="Price" hint="Empty = free"><Input name="price" value={priceInput(e.price_cents, e.currency)} placeholder="0.00" /></Field>
            <Field label="Currency"><Select name="currency" value={e.currency} options={CURRENCIES} /></Field>
          </Grid>
          <Field label="Capacity" hint="Up to 10,000 attendees."><Input name="capacity" type="number" min="1" max="10000" value={e.capacity} /></Field>
          <Field label="Who can register"><Select name="access" value={e.access} options={[['public', 'Anyone (registrants join your list)'], ['subscribers', 'Subscribers only'], ['premium', 'Premium subscribers only']]} /></Field>
          <Help>Discount codes: create an offer with "applies to: events" in Monetize → Offers.</Help>
          <Field label="Visibility"><Select name="status" value={e.status} options={[['published', 'Published (listed on your site)'], ['unlisted', 'Unlisted (link only)'], ['draft', 'Draft']]} /></Field>
        </Card>
        <Card title="Reminder emails" actions={<span class="muted small">up to 5</span>}>
          {[0, 1, 2, 3, 4].map((i) => <Field><Select name="reminders[]" value={rem[i] ? String(rem[i]) : ''} options={REMINDER_PRESETS} /></Field>)}
          <Help>Every registrant also gets a confirmation email with a calendar invite (.ics) and their personal join link.</Help>
        </Card>
        <Card>
          <Field label="URL slug"><Input name="slug" value={e.slug} placeholder="auto from title" /></Field>
          <div class="form-actions"><Btn>{p.ev ? 'Save event' : 'Create event'}</Btn></div>
        </Card>
      </div>
    </form>
  );
}

const EV_JS = ['/static/events-admin.js'];

dash.get('/new', (c) => c.html(<DashLayout c={c} title="New event" section="events" crumbs={[['/app/events', 'Events']]} scripts={EV_JS}><EventForm action="/app/events/new" /></DashLayout>));

function eventFields(f: Record<string, any>) {
  const tz = timezones().includes(f.timezone) ? f.timezone : 'UTC';
  const currency = CURRENCIES.some(([k]) => k === f.currency) ? f.currency : 'usd';
  const starts = zonedToUtc(str(f.starts_local), tz);
  let ends = zonedToUtc(str(f.ends_local), tz);
  if (!starts) return { error: 'Please choose a start date and time.' };
  if (!ends || ends <= starts) ends = starts + HOUR;
  const kind = ['webinar', 'in_person', 'coaching'].includes(f.kind) ? f.kind : 'webinar';
  const reminders = [...new Set(((f.reminders as string[]) || []).map(Number).filter((n) => n > 0))].slice(0, 5).sort((a, b) => b - a);
  const availability = DOW.map((_, i) => (bool(f[`dow_${i}`]) ? { dow: i, start: str(f[`start_${i}`]) || '09:00', end: str(f[`end_${i}`]) || '17:00' } : null)).filter(Boolean);
  return {
    fields: {
      title: str(f.title, 200) || 'Untitled event', description: sanitizeHtml(str(f.description, 20000), { blocks: true }), kind, cover_url: str(f.cover_url, 1000) || null,
      starts_at: starts, ends_at: ends, timezone: tz, location: str(f.location, 300) || null, capacity: Math.min(10000, Math.max(1, int(f.capacity, 10000))),
      price_cents: parsePrice(f.price, currency), currency, access: ['public', 'subscribers', 'premium'].includes(f.access) ? f.access : 'public',
      reminders: JSON.stringify(reminders), status: ['published', 'unlisted', 'draft'].includes(f.status) ? f.status : 'published',
      coaching: JSON.stringify({ duration_min: Math.max(10, int(f.duration_min, 30)), days_ahead: Math.min(90, Math.max(1, int(f.days_ahead, 14))), availability }),
    },
  };
}

dash.post('/new', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const r = eventFields(f);
  if (r.error) return back(c, '/app/events/new', r.error, 'err');
  const eid = id();
  await insert(c.env, 'live_events', { id: eid, pub_id: pub.id, slug: await uniqueEventSlug(c.env, pub.id, str(f.slug) || r.fields!.title), ...r.fields, created_at: now() });
  return back(c, `/app/events/${eid}`, 'Event created');
});

dash.post('/upload', async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ error: 'No file' }, 400);
  try {
    return c.json(await storeFile(c.env, c.get('pub').id, file, { folder: 'event-art', userId: c.get('user').id }));
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// ── Luma integration
async function lumaKey(env: Env, pubId: string): Promise<string | null> {
  const row = await one<any>(env, `SELECT config FROM integrations WHERE pub_id = ? AND provider = 'luma' AND active = 1`, pubId);
  return parseJSON<any>(row?.config, {}).api_key || null;
}
async function luma(env: Env, key: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`https://api.lu.ma/public/v1/${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-luma-api-key': key, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.message || `Luma API error ${r.status}`);
  return j;
}

dash.get('/luma', async (c) => {
  const pub = c.get('pub');
  const key = await lumaKey(c.env, pub.id);
  let entries: any[] = [];
  let error = '';
  if (key && c.req.query('load') === '1') {
    try { entries = (await luma(c.env, key, 'calendar/list-events')).entries || []; } catch (e: any) { error = e.message; }
  }
  const imported = new Set((await all<any>(c.env, 'SELECT luma_event_id FROM live_events WHERE pub_id = ? AND luma_event_id IS NOT NULL', pub.id)).map((r) => r.luma_event_id));
  return c.html(
    <DashLayout c={c} title="Luma calendar" section="events" crumbs={[['/app/events', 'Events']]}>
      <Card title="Connect Luma">
        <p class="muted">Sync events with your Luma calendar: import Luma events into your newsletter site, or push OpenHive events to Luma. Find your API key in Luma → Calendar → Settings → Developer.</p>
        <form method="post" action="/app/events/luma/key" class="row">
          <Input name="api_key" type="password" placeholder={key ? '•••••••• (connected)' : 'Luma API key'} attrs={{ style: 'max-width:360px' }} />
          <Btn>{key ? 'Update key' : 'Connect'}</Btn>
          {key && <Btn kind="danger" formaction="/app/events/luma/disconnect">Disconnect</Btn>}
        </form>
      </Card>
      {key && (
        <Card title="Import from Luma" actions={<LinkBtn href="/app/events/luma?load=1" small>Load events</LinkBtn>}>
          {error && <div class="callout danger">{error}</div>}
          {entries.length ? (
            <form method="post" action="/app/events/luma/import">
              <Table rows={entries} cols={[
                { h: '', r: (en) => <input type="checkbox" name="ids[]" value={en.api_id || en.event?.api_id} disabled={imported.has(en.api_id || en.event?.api_id)} /> },
                { h: 'Event', r: (en) => en.event?.name },
                { h: 'Starts', r: (en) => fmtDate(Date.parse(en.event?.start_at), { dateStyle: 'medium', timeStyle: 'short' }, en.event?.timezone || 'UTC') },
                { h: '', r: (en) => (imported.has(en.api_id || en.event?.api_id) ? <span class="badge b-green">imported</span> : '') },
              ]} />
              <div class="form-actions"><Btn>Import selected</Btn></div>
            </form>
          ) : <p class="muted">{c.req.query('load') ? 'No events found in your Luma calendar.' : 'Click "Load events" to fetch your Luma calendar.'}</p>}
        </Card>
      )}
    </DashLayout>,
  );
});

dash.post('/luma/key', requirePerm('admin'), async (c) => {
  const f = await form(c.req);
  const k = str(f.api_key, 200);
  if (!k) return back(c, '/app/events/luma', 'Enter an API key', 'err');
  await run(c.env, `INSERT INTO integrations (id, pub_id, provider, config, active, created_at) VALUES (?, ?, 'luma', ?, 1, ?) ON CONFLICT(pub_id, provider) DO UPDATE SET config = excluded.config, active = 1`, id(), c.get('pub').id, JSON.stringify({ api_key: k }), now());
  return back(c, '/app/events/luma', 'Luma connected');
});
dash.post('/luma/disconnect', requirePerm('admin'), async (c) => {
  await run(c.env, `DELETE FROM integrations WHERE pub_id = ? AND provider = 'luma'`, c.get('pub').id);
  return back(c, '/app/events/luma', 'Luma disconnected');
});

dash.post('/luma/import', async (c) => {
  const pub = c.get('pub');
  const key = await lumaKey(c.env, pub.id);
  if (!key) return back(c, '/app/events/luma', 'Connect Luma first', 'err');
  const f = await form(c.req);
  const ids: string[] = f.ids || [];
  let n = 0;
  for (const lid of ids) {
    try {
      const j = await luma(c.env, key, `event/get?api_id=${encodeURIComponent(lid)}`);
      const e = j.event || j;
      const geo = e.geo_address_json || {};
      await insert(c.env, 'live_events', {
        id: id(), pub_id: pub.id, slug: await uniqueEventSlug(c.env, pub.id, e.name), title: String(e.name || 'Luma event').slice(0, 200),
        description: sanitizeHtml(String(e.description_md || e.description || '').replace(/\n/g, '<br>'), { blocks: true }), kind: geo.address ? 'in_person' : 'webinar',
        cover_url: e.cover_url || null, starts_at: Date.parse(e.start_at), ends_at: Date.parse(e.end_at || e.start_at) || Date.parse(e.start_at) + HOUR, timezone: e.timezone || 'UTC',
        location: geo.full_address || geo.address || null, luma_event_id: lid, status: 'published', created_at: now(),
      });
      n++;
    } catch {}
  }
  return back(c, '/app/events', `Imported ${n} event${n === 1 ? '' : 's'} from Luma`);
});

dash.get('/:id', async (c) => {
  const ev = await getEvent(c, c.req.param('id'));
  if (!ev) return c.notFound();
  const pub = c.get('pub');
  const [regs, attended, rev, recent] = await Promise.all([
    regCount(c.env, ev.id),
    val<number>(c.env, `SELECT COUNT(*) FROM event_registrations WHERE event_id = ? AND attended_at IS NOT NULL`, ev.id),
    revenueOf(c.env, ev),
    all<any>(c.env, `SELECT * FROM event_registrations WHERE event_id = ? ORDER BY created_at DESC LIMIT 8`, ev.id),
  ]);
  let liveCount = 0;
  try { liveCount = ((await (await c.env.LIVE.get(c.env.LIVE.idFromName(ev.id)).fetch('https://live/info')).json()) as any).count || 0; } catch {}
  const url = evUrl(c.env, pub, ev);
  return c.html(
    <DashLayout c={c} title={ev.title} section="events" crumbs={[['/app/events', 'Events']]} actions={<><LinkBtn href={url} target="_blank">View page</LinkBtn>{ev.kind !== 'in_person' && <LinkBtn href={`/app/events/${ev.id}/studio`} kind="primary">{ev.stream_status === 'live' ? '● Return to studio' : 'Open studio'}</LinkBtn>}</>}>
      <EvTabs ev={ev} active={`/app/events/${ev.id}`} />
      <Stats>
        <Stat label={ev.kind === 'coaching' ? 'Bookings' : 'Registrations'} value={num(regs)} sub={ev.kind !== 'coaching' ? `of ${num(ev.capacity)} seats` : undefined} />
        <Stat label="Attended" value={num(attended)} sub={regs ? `${Math.round((attended / regs) * 100)}% show-up` : undefined} />
        <Stat label="Revenue" value={rev.length ? rev.map((r) => fmtPrice(r.total, r.currency)).join(' · ') : fmtPrice(0, ev.currency)} sub={`${rev.reduce((a, r) => a + r.n, 0)} orders · 0% fees`} />
        <Stat label="In the room now" value={num(liveCount)} sub={<Status s={ev.stream_status === 'live' ? 'live' : ev.stream_status} />} />
      </Stats>
      <Grid cols={2}>
        <Card title="Details">
          <dl class="kv">
            <dt>When</dt><dd>{whenText(ev)}<div class="muted small">{tzLabel(ev.timezone, ev.starts_at)}</div></dd>
            <dt>Type</dt><dd>{ev.kind === 'webinar' ? 'Live webinar' : ev.kind === 'in_person' ? `In person — ${ev.location || 'no location set'}` : '1:1 coaching'}</dd>
            <dt>Price</dt><dd>{fmtPrice(ev.price_cents, ev.currency)}</dd>
            <dt>Access</dt><dd>{ev.access}</dd>
            <dt>Reminders</dt><dd>{remindersOf(ev).map((m) => REMINDER_PRESETS.find(([k]) => k === String(m))?.[1] || `${m} min before`).join(', ') || 'none'}</dd>
            <dt>Page</dt><dd><a href={url} target="_blank">{url}</a></dd>
          </dl>
        </Card>
        <Card title="Latest registrations" actions={<LinkBtn href={`/app/events/${ev.id}/registrations`} small>View all</LinkBtn>}>
          <Table rows={recent} empty="No registrations yet — share your event page." cols={[
            { h: 'Name', r: (r) => <div>{r.name || '—'}<div class="muted small">{r.email}</div></div> },
            { h: '', r: (r) => (r.order_id ? <span class="badge b-green">paid</span> : r.kind === 'replay' ? <span class="badge b-purple">replay</span> : <span class="badge b-gray">free</span>) },
            { h: 'Registered', r: (r) => fmtDate(r.created_at) },
          ]} />
        </Card>
      </Grid>
    </DashLayout>,
  );
});

dash.get('/:id/edit', async (c) => {
  const ev = await getEvent(c, c.req.param('id'));
  if (!ev) return c.notFound();
  return c.html(
    <DashLayout c={c} title={ev.title} section="events" crumbs={[['/app/events', 'Events']]} scripts={EV_JS}>
      <EvTabs ev={ev} active={`/app/events/${ev.id}/edit`} />
      <EventForm ev={ev} action={`/app/events/${ev.id}/edit`} />
      <Card title="Danger zone">
        <div class="row">
          <ActionForm action={`/app/events/${ev.id}/duplicate`} label="Duplicate event" />
          <ActionForm action={`/app/events/${ev.id}/delete`} label="Delete event" kind="danger" confirm="Delete this event and all registrations? Paid orders are kept for your records." />
        </div>
      </Card>
    </DashLayout>,
  );
});

dash.post('/:id/edit', async (c) => {
  const ev = await getEvent(c, c.req.param('id'));
  if (!ev) return c.notFound();
  const f = await form(c.req);
  const r = eventFields(f);
  if (r.error) return back(c, `/app/events/${ev.id}/edit`, r.error, 'err');
  const fields = { ...r.fields!, slug: str(f.slug) ? await uniqueEventSlug(c.env, ev.pub_id, str(f.slug), ev.id) : ev.slug };
  const cols = Object.keys(fields);
  await run(c.env, `UPDATE live_events SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...cols.map((k) => (fields as any)[k]), ev.id);
  return back(c, `/app/events/${ev.id}/edit`, 'Event saved');
});

dash.post('/:id/duplicate', async (c) => {
  const ev = await getEvent(c, c.req.param('id'));
  if (!ev) return c.notFound();
  const nid = id();
  const { id: _i, slug: _s, recording_key: _r, replay_product_id: _p, luma_event_id: _l, stream_status: _st, stream_started_at: _ss, created_at: _c, ...rest } = ev;
  await insert(c.env, 'live_events', { ...rest, id: nid, title: ev.title + ' (copy)', slug: await uniqueEventSlug(c.env, ev.pub_id, ev.slug + '-copy'), status: 'draft', stream_status: 'scheduled', created_at: now() });
  return back(c, `/app/events/${nid}/edit`, 'Event duplicated as a draft');
});

dash.post('/:id/delete', async (c) => {
  const ev = await getEvent(c, c.req.param('id'));
  if (!ev) return c.notFound();
  if (ev.recording_key) await c.env.MEDIA.delete(ev.recording_key).catch(() => {});
  await run(c.env, 'DELETE FROM bookings WHERE product_id = ?', ev.id);
  await run(c.env, 'DELETE FROM live_events WHERE id = ?', ev.id);
  return back(c, '/app/events', 'Event deleted');
});

dash.get('/:id/registrations', async (c) => {
  const ev = await getEvent(c, c.req.param('id'));
  if (!ev) return c.notFound();
  const q = str(c.req.query('q'));
  const rows = await all<any>(c.env, `SELECT r.*, b.starts_at AS b_start, b.ends_at AS b_end, b.status AS b_status, o.amount_cents, o.currency AS o_currency FROM event_registrations r LEFT JOIN bookings b ON b.id = r.booking_id LEFT JOIN orders o ON o.id = r.order_id WHERE r.event_id = ? ${q ? 'AND (r.email LIKE ? OR r.name LIKE ?)' : ''} ORDER BY ${ev.kind === 'coaching' ? 'b.starts_at' : 'r.created_at DESC'} LIMIT 2000`, ev.id, ...(q ? [`%${q}%`, `%${q}%`] : []));
  return c.html(
    <DashLayout c={c} title={ev.title} section="events" crumbs={[['/app/events', 'Events']]} actions={<><LinkBtn href={`/app/events/${ev.id}/registrations.csv`}>Export CSV</LinkBtn><OpenBtn target="#add-reg">Add attendee</OpenBtn></>}>
      <EvTabs ev={ev} active={`/app/events/${ev.id}/registrations`} />
      <form method="get" class="row" style="margin-bottom:12px"><Input name="q" value={q} placeholder="Search name or email" attrs={{ style: 'max-width:320px' }} /><Btn kind="secondary" small>Search</Btn><span class="muted small">{num(rows.length)} shown</span></form>
      <Table rows={rows} empty="No registrations yet." cols={[
        { h: 'Attendee', r: (r) => <div>{r.subscriber_id ? <a href={`/app/audience/subscribers/${r.subscriber_id}`}>{r.name || r.email}</a> : r.name || r.email}<div class="muted small">{r.email}</div></div> },
        ...(ev.kind === 'coaching' ? [{ h: 'Session', r: (r: any) => (r.b_start ? <span class="nowrap">{fmtDate(r.b_start, { dateStyle: 'medium', timeStyle: 'short' }, ev.timezone)}{r.b_status === 'canceled' ? ' (canceled)' : ''}</span> : '—') }] : []),
        { h: 'Ticket', r: (r) => (r.order_id ? fmtPrice(r.amount_cents || 0, r.o_currency || ev.currency) : r.kind === 'replay' ? 'Replay' : 'Free') },
        { h: 'Registered', r: (r) => fmtDate(r.created_at, { dateStyle: 'medium', timeStyle: 'short' }) },
        { h: 'Attended', r: (r) => (
          <form method="post" action={`/app/events/${ev.id}/registrations/${r.id}/checkin`} class="inline-form"><button class={`btn btn-sm ${r.attended_at ? 'btn-accent' : 'btn-secondary'}`}>{r.attended_at ? '✓ Checked in' : 'Check in'}</button></form>
        ) },
        { h: '', r: (r) => <div class="row"><ActionForm action={`/app/events/${ev.id}/registrations/${r.id}/resend`} label="Resend invite" /><ActionForm action={`/app/events/${ev.id}/registrations/${r.id}/remove`} label="Remove" kind="danger" confirm="Remove this registration?" /></div> },
      ]} />
      <Modal id="add-reg" title="Add attendee">
        <form method="post" action={`/app/events/${ev.id}/registrations/add`} class="stack">
          <Field label="Email"><Input name="email" type="email" required /></Field>
          <Field label="Name"><Input name="name" /></Field>
          <Help>They'll receive the confirmation email with calendar invite and join link.</Help>
          <div class="form-actions"><Btn>Add attendee</Btn></div>
        </form>
      </Modal>
    </DashLayout>,
  );
});

dash.get('/:id/registrations.csv', async (c) => {
  const ev = await getEvent(c, c.req.param('id'));
  if (!ev) return c.notFound();
  const rows = await all<any>(c.env, `SELECT r.*, o.amount_cents, o.currency AS o_currency, b.starts_at AS b_start FROM event_registrations r LEFT JOIN orders o ON o.id = r.order_id LEFT JOIN bookings b ON b.id = r.booking_id WHERE r.event_id = ? ORDER BY r.created_at`, ev.id);
  const csv = toCSV([['name', 'email', 'type', 'paid', 'currency', 'session_start', 'registered_at', 'attended_at'], ...rows.map((r) => [r.name, r.email, r.kind, r.amount_cents ? (ZERO_DECIMAL.has(r.o_currency) ? r.amount_cents : r.amount_cents / 100) : 0, r.o_currency || '', r.b_start ? new Date(r.b_start).toISOString() : '', new Date(r.created_at).toISOString(), r.attended_at ? new Date(r.attended_at).toISOString() : ''])]);
  return c.body(csv, 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${ev.slug}-registrations.csv"` });
});

dash.post('/:id/registrations/add', async (c) => {
  const ev = await getEvent(c, c.req.param('id'));
  if (!ev) return c.notFound();
  const f = await form(c.req);
  const r = await registerAttendee(c.env, c.get('pub'), ev, { email: str(f.email), name: str(f.name, 120), reader: true });
  return back(c, `/app/events/${ev.id}/registrations`, r.ok ? 'Attendee added and invite sent' : r.error || 'Could not add attendee', r.ok ? 'ok' : 'err');
});

dash.post('/:id/registrations/:rid/:action{checkin|resend|remove}', async (c) => {
  const ev = await getEvent(c, c.req.param('id'));
  const reg = ev && (await one<any>(c.env, 'SELECT * FROM event_registrations WHERE id = ? AND event_id = ?', c.req.param('rid'), ev.id));
  if (!ev || !reg) return c.notFound();
  const to = `/app/events/${ev.id}/registrations`;
  switch (c.req.param('action')) {
    case 'checkin':
      await run(c.env, 'UPDATE event_registrations SET attended_at = CASE WHEN attended_at IS NULL THEN ? ELSE NULL END WHERE id = ?', now(), reg.id);
      return back(c, to);
    case 'resend': {
      const b = reg.booking_id ? await one<any>(c.env, 'SELECT * FROM bookings WHERE id = ?', reg.booking_id) : null;
      await sendConfirmation(c.env, c.get('pub'), ev, reg, b);
      return back(c, to, `Invite re-sent to ${reg.email}`);
    }
    case 'remove':
      if (reg.booking_id) await run(c.env, `UPDATE bookings SET status = 'canceled' WHERE id = ?`, reg.booking_id);
      await run(c.env, 'DELETE FROM event_registrations WHERE id = ?', reg.id);
      return back(c, to, 'Registration removed');
  }
  return c.notFound();
});

dash.get('/:id/orders', async (c) => {
  const ev = await getEvent(c, c.req.param('id'));
  if (!ev) return c.notFound();
  const orders = await all<any>(c.env, `SELECT o.*, f.code FROM orders o LEFT JOIN offers f ON f.id = o.offer_id WHERE o.pub_id = ? AND ((o.kind IN ('ticket','replay') AND o.ref_id = ?) OR (o.ref_id = ? AND ? IS NOT NULL)) ORDER BY o.created_at DESC LIMIT 1000`, ev.pub_id, ev.id, ev.replay_product_id || '', ev.replay_product_id);
  const rev = await revenueOf(c.env, ev);
  const byKind = await all<any>(c.env, `SELECT CASE WHEN json_extract(data, '$.replay') THEN 'replay' WHEN kind = 'ticket' THEN 'ticket' ELSE 'replay' END AS kind, COUNT(*) AS n, SUM(amount_cents) AS total FROM orders WHERE pub_id = ? AND status = 'paid' AND ((kind IN ('ticket','replay') AND ref_id = ?) OR (ref_id = ? AND ? IS NOT NULL)) GROUP BY 1`, ev.pub_id, ev.id, ev.replay_product_id || '', ev.replay_product_id);
  return c.html(
    <DashLayout c={c} title={ev.title} section="events" crumbs={[['/app/events', 'Events']]}>
      <EvTabs ev={ev} active={`/app/events/${ev.id}/orders`} />
      <Stats>
        <Stat label="Gross revenue" value={rev.length ? rev.map((r) => fmtPrice(r.total, r.currency)).join(' · ') : fmtPrice(0, ev.currency)} />
        <Stat label="Paid orders" value={num(rev.reduce((a, r) => a + r.n, 0))} />
        <Stat label="Platform fees" value={fmtPrice(0, ev.currency)} sub="0% — payouts go straight to your Stripe" />
        {!stripeEnabled(c.env) && <Stat label="Payments" value="Test mode" sub="Add STRIPE_SECRET_KEY to go live" />}
      </Stats>
      {byKind.length > 0 && <Card title="Revenue by type"><Bars rows={byKind.map((k) => ({ label: k.kind === 'ticket' ? 'Tickets & bookings' : 'Replay sales', value: k.total, sub: `${k.n} orders` }))} fmt={(n) => fmtPrice(n, ev.currency)} /></Card>}
      <Table rows={orders} empty="No orders yet." cols={[
        { h: 'Buyer', r: (o) => <div>{o.subscriber_id ? <a href={`/app/audience/subscribers/${o.subscriber_id}`}>{o.name || o.email}</a> : o.name || o.email}<div class="muted small">{o.email}</div></div> },
        { h: 'Type', r: (o) => (o.kind === 'ticket' && !parseJSON<any>(o.data, {}).replay ? (ev.kind === 'coaching' ? 'Booking' : 'Ticket') : 'Replay') },
        { h: 'Amount', r: (o) => fmtPrice(o.amount_cents, o.currency), class: 'right' },
        { h: 'Code', r: (o) => o.code || '—' },
        { h: 'Status', r: (o) => <Status s={o.status} /> },
        { h: 'Date', r: (o) => fmtDate(o.created_at, { dateStyle: 'medium', timeStyle: 'short' }) },
      ]} />
    </DashLayout>,
  );
});

dash.get('/:id/promote', async (c) => {
  const ev = await getEvent(c, c.req.param('id'));
  if (!ev) return c.notFound();
  const pub = c.get('pub');
  const url = evUrl(c.env, pub, ev);
  const block = JSON.stringify({ type: 'event', data: { event_id: ev.id } });
  const key = await lumaKey(c.env, pub.id);
  return c.html(
    <DashLayout c={c} title={ev.title} section="events" crumbs={[['/app/events', 'Events']]}>
      <EvTabs ev={ev} active={`/app/events/${ev.id}/promote`} />
      <Grid cols={2}>
        <div>
          <Card title="Event page"><Copy value={url} /><Help>Share it anywhere. Free events grow your list — every registrant is added as a subscriber with source "event".</Help></Card>
          <Card title="Promote in your newsletter">
            <p class="muted">Add an <strong>Event</strong> block to any post or automation email (event ID below). It renders a card with date and a register button, in the inbox and on the web.</p>
            <Copy value={ev.id} label="Copy event ID" />
            <div style="margin-top:8px"><Copy value={block} label="Copy block JSON" /></div>
            <p style="margin-top:12px"><LinkBtn href="/app/posts/new" kind="primary">Write a post about it</LinkBtn></p>
          </Card>
          <Card title="Share">
            <div class="row">
              <LinkBtn href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(ev.title)}&url=${encodeURIComponent(url)}`} target="_blank" small>Share on X</LinkBtn>
              <LinkBtn href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`} target="_blank" small>LinkedIn</LinkBtn>
              <LinkBtn href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`} target="_blank" small>Facebook</LinkBtn>
              <LinkBtn href={`${url}/calendar.ics`} small>Download .ics</LinkBtn>
            </div>
          </Card>
        </div>
        <div>
          <Card title="Luma">
            {key ? (
              ev.luma_event_id ? <p>✓ Linked to Luma event <code>{ev.luma_event_id}</code>.</p> : (
                <><p class="muted">Publish this event on your Luma calendar too.</p><ActionForm action={`/app/events/${ev.id}/luma/push`} label="Push to Luma" kind="primary" small={false} /></>
              )
            ) : <p class="muted">Connect Luma to cross-post events to your Luma calendar. <a href="/app/events/luma">Connect Luma →</a></p>}
          </Card>
          <Card title="On your website">
            <p class="muted">Published events appear automatically at <a href={`${siteUrl(c.env, pub)}/events`} target="_blank">/events</a>. Add a link to your navigation from Website → Navigation.</p>
          </Card>
        </div>
      </Grid>
    </DashLayout>,
  );
});

dash.post('/:id/luma/push', async (c) => {
  const ev = await getEvent(c, c.req.param('id'));
  if (!ev) return c.notFound();
  const key = await lumaKey(c.env, ev.pub_id);
  if (!key) return back(c, '/app/events/luma', 'Connect Luma first', 'err');
  try {
    const j = await luma(c.env, key, 'event/create', {
      name: ev.title, start_at: new Date(ev.starts_at).toISOString(), end_at: new Date(ev.ends_at).toISOString(), timezone: ev.timezone,
      description_md: `${stripTags(ev.description || '')}\n\nRegister: ${evUrl(c.env, c.get('pub'), ev)}`, meeting_url: ev.kind === 'webinar' ? evUrl(c.env, c.get('pub'), ev) : undefined,
      geo_address_json: ev.kind === 'in_person' && ev.location ? { type: 'manual', address: ev.location } : undefined,
    });
    const lid = j.api_id || j.event?.api_id;
    if (lid) await run(c.env, 'UPDATE live_events SET luma_event_id = ? WHERE id = ?', lid, ev.id);
    return back(c, `/app/events/${ev.id}/promote`, 'Event published to Luma');
  } catch (e: any) {
    return back(c, `/app/events/${ev.id}/promote`, `Luma: ${e.message}`, 'err');
  }
});

dash.get('/:id/replay', async (c) => {
  const ev = await getEvent(c, c.req.param('id'));
  if (!ev) return c.notFound();
  const pub = c.get('pub');
  const product = ev.replay_product_id ? await one<any>(c.env, 'SELECT * FROM products WHERE id = ?', ev.replay_product_id) : null;
  return c.html(
    <DashLayout c={c} title={ev.title} section="events" crumbs={[['/app/events', 'Events']]} scripts={EV_JS}>
      <EvTabs ev={ev} active={`/app/events/${ev.id}/replay`} />
      <Grid cols={2}>
        <Card title="Recording">
          {ev.recording_key ? (
            <>
              <video controls preload="metadata" src={`/app/events/${ev.id}/recording`} style="width:100%;border-radius:8px;background:#000" />
              <p class="muted small" style="margin-top:8px">Registrants can watch at <a href={`${evUrl(c.env, pub, ev)}/replay`} target="_blank">{evUrl(c.env, pub, ev)}/replay</a></p>
              <ActionForm action={`/app/events/${ev.id}/recording/delete`} label="Delete recording" kind="danger" confirm="Delete the recording?" />
            </>
          ) : <p class="muted">Recordings are captured automatically from the studio when you click <strong>Record</strong>. You can also upload a video file.</p>}
          <form method="post" action={`/app/events/${ev.id}/recording`} enctype="multipart/form-data" class="stack" style="margin-top:12px">
            <Field label={ev.recording_key ? 'Replace with a file' : 'Upload a recording'}><input type="file" name="file" accept="video/mp4,video/webm,video/quicktime" class="input" required /></Field>
            <div class="form-actions"><Btn kind="secondary">Upload</Btn></div>
          </form>
        </Card>
        <Card title="Sell the replay">
          {product ? (
            <>
              <p>Replay product: <strong>{product.name}</strong> — {fmtPrice(product.price_cents, product.currency)} · {num(product.sales_count)} sold</p>
              <p class="muted small">Listed in your storefront and on the event page after it ends. Everyone who registered gets the replay free.</p>
              <form method="post" action={`/app/events/${ev.id}/replay/product`} class="row">
                <Input name="price" value={priceInput(product.price_cents, product.currency)} attrs={{ style: 'max-width:140px' }} />
                <Select name="status" value={product.status} options={[['active', 'On sale'], ['archived', 'Not for sale']]} attrs={{ style: 'max-width:160px' }} />
                <Btn kind="secondary">Update</Btn>
              </form>
            </>
          ) : (
            <form method="post" action={`/app/events/${ev.id}/replay/product`} class="stack">
              <p class="muted">Turn the recording into a product people can buy after the event (0% platform fees).</p>
              <Field label={`Replay price (${ev.currency.toUpperCase()})`}><Input name="price" placeholder="19.00" required /></Field>
              <div class="form-actions"><Btn>Create replay product</Btn></div>
            </form>
          )}
        </Card>
      </Grid>
    </DashLayout>,
  );
});

dash.post('/:id/replay/product', async (c) => {
  const ev = await getEvent(c, c.req.param('id'));
  if (!ev) return c.notFound();
  const f = await form(c.req);
  const price = parsePrice(f.price, ev.currency);
  const url = `${evUrl(c.env, c.get('pub'), ev)}/replay`;
  if (ev.replay_product_id && (await one(c.env, 'SELECT 1 FROM products WHERE id = ?', ev.replay_product_id))) {
    await run(c.env, 'UPDATE products SET price_cents = ?, status = ? WHERE id = ?', price, f.status === 'archived' ? 'archived' : 'active', ev.replay_product_id);
    return back(c, `/app/events/${ev.id}/replay`, 'Replay product updated');
  }
  const pid = id();
  let slug = 'replay-' + ev.slug, i = 2;
  while (await one(c.env, 'SELECT 1 FROM products WHERE pub_id = ? AND slug = ?', ev.pub_id, slug)) slug = `replay-${ev.slug}-${i++}`;
  await insert(c.env, 'products', { id: pid, pub_id: ev.pub_id, name: `Replay: ${ev.title}`, slug, description: `Full recording of "${ev.title}". ${stripTags(ev.description || '').slice(0, 400)}`, kind: 'replay', price_cents: price, currency: ev.currency, cover_url: ev.cover_url, link_url: url, status: 'active', created_at: now() });
  await run(c.env, 'UPDATE live_events SET replay_product_id = ? WHERE id = ?', pid, ev.id);
  return back(c, `/app/events/${ev.id}/replay`, 'Replay product created');
});

dash.get('/:id/recording', async (c) => {
  const ev = await getEvent(c, c.req.param('id'));
  if (!ev || !ev.recording_key) return c.notFound();
  return serveObject(c.env, ev.recording_key, c.req.raw, { 'cache-control': 'private, max-age=600' });
});

dash.post('/:id/recording', async (c) => {
  const ev = await getEvent(c, c.req.param('id'));
  if (!ev) return c.notFound();
  const body = await c.req.parseBody();
  const raw0 = body.file;
  if (!(raw0 instanceof File)) return c.json({ error: 'No file' }, 400);
  const type = (raw0.type || 'video/webm').split(';')[0];
  const file = new File([raw0], raw0.name || 'recording.webm', { type });
  try {
    const stored = await storeFile(c.env, ev.pub_id, file, { folder: 'private/recordings', userId: c.get('user').id, source: 'recording' });
    if (ev.recording_key && ev.recording_key !== stored.key) await c.env.MEDIA.delete(ev.recording_key).catch(() => {});
    await run(c.env, 'UPDATE live_events SET recording_key = ? WHERE id = ?', stored.key, ev.id);
    if (c.req.header('accept')?.includes('json')) return c.json({ ok: true, key: stored.key });
    return back(c, `/app/events/${ev.id}/replay`, 'Recording saved');
  } catch (e: any) {
    if (c.req.header('accept')?.includes('json')) return c.json({ error: e.message }, 400);
    return back(c, `/app/events/${ev.id}/replay`, e.message, 'err');
  }
});

dash.post('/:id/recording/delete', async (c) => {
  const ev = await getEvent(c, c.req.param('id'));
  if (!ev) return c.notFound();
  if (ev.recording_key) await c.env.MEDIA.delete(ev.recording_key).catch(() => {});
  await run(c.env, 'UPDATE live_events SET recording_key = NULL WHERE id = ?', ev.id);
  return back(c, `/app/events/${ev.id}/replay`, 'Recording deleted');
});

const LiveRoomUI = (p: { cfg: Record<string, unknown>; host: boolean; title: string; pinnedNote?: string }) => (
  <div class={`live ${p.host ? 'live-host' : 'live-guest'}`} id="live">
    <div class="live-main">
      <div class="live-stage">
        <video id="live-video" playsinline autoplay muted={p.host} />
        <div class="live-overlay" id="live-overlay">{p.host ? 'Start your camera to preview' : 'Waiting for the host to go live…'}</div>
        <button type="button" class="live-unmute hide" id="live-unmute">🔊 Click to unmute</button>
        <div class="live-badges"><span class="live-badge" id="live-status">Scheduled</span><span class="live-badge">👥 <span id="live-count">0</span></span><span class="live-badge hide" id="live-rec">● REC</span></div>
      </div>
      {p.host ? (
        <div class="live-controls">
          <button type="button" class="btn btn-secondary" data-act="camera">🎥 Start camera</button>
          <button type="button" class="btn btn-secondary" data-act="mic" disabled>🎙 Mute mic</button>
          <button type="button" class="btn btn-secondary" data-act="cam" disabled>📷 Camera off</button>
          <button type="button" class="btn btn-secondary" data-act="screen">🖥 Share screen</button>
          <button type="button" class="btn btn-secondary" data-act="record" disabled>⏺ Record</button>
          <span class="grow" />
          <button type="button" class="btn btn-accent" data-act="golive" disabled>Go live</button>
          <button type="button" class="btn btn-danger hide" data-act="end">End event</button>
        </div>
      ) : (
        <div class="live-reactions">{['👏', '❤️', '🔥', '😂', '🎉', '🙌'].map((e) => <button type="button" data-react={e}>{e}</button>)}</div>
      )}
      {p.host && <p class="live-note">Video streams peer-to-peer from your browser (great for small and medium rooms). For very large audiences, set a Cloudflare Realtime SFU URL in Settings → Integrations and the room will relay through it.</p>}
    </div>
    <aside class="live-side">
      <div class="live-pin hide" id="live-pin" />
      {p.host && <div class="live-people"><strong>Attendees</strong><ul id="live-people" /></div>}
      <div class="live-chat" id="live-chat" />
      <form class="live-chat-form" id="live-chat-form"><input type="text" maxlength={1000} placeholder="Say something…" autocomplete="off" /><button>Send</button></form>
    </aside>
    <script type="application/json" id="live-config">{raw(JSON.stringify(p.cfg).replace(/</g, '\\u003c'))}</script>
  </div>
);

function liveCfg(env: Env, pub: Publication, ev: any, extra: Record<string, unknown>) {
  const cfg = parseJSON<any>(pub.settings, {});
  return { eventId: ev.id, title: ev.title, iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }], sfuUrl: cfg.live_sfu_url || null, ...extra };
}

dash.get('/:id/studio', async (c) => {
  const ev = await getEvent(c, c.req.param('id'));
  if (!ev) return c.notFound();
  const pub = c.get('pub');
  return c.html(
    <DashLayout c={c} title={`Studio · ${ev.title}`} section="events" crumbs={[['/app/events', 'Events'], [`/app/events/${ev.id}`, ev.title]]} styles={['/static/live.css']} scripts={['/static/live.js']} wide
      actions={<LinkBtn href={`${evUrl(c.env, pub, ev)}`} target="_blank">Attendee page</LinkBtn>}>
      <LiveRoomUI host title={ev.title} cfg={liveCfg(c.env, pub, ev, { ws: `/live/${ev.id}`, role: 'host', recordUrl: `/app/events/${ev.id}/recording`, status: ev.stream_status })} />
    </DashLayout>,
  );
});

// ───────────────── public site ─────────────────
async function eventBySlug(c: Ctx) {
  return one<any>(c.env, `SELECT * FROM live_events WHERE pub_id = ? AND slug = ? AND status != 'draft'`, c.get('pub').id, c.req.param('ev'));
}

const SITE_HEAD = <><link rel="stylesheet" href="/static/events-site.css" /></>;
const SITE_JS = ['/static/events-site.js'];

site.get('/events', async (c) => {
  const pub = c.get('pub');
  const base = siteUrl(c.env, pub);
  const upcoming = await all<any>(c.env, `SELECT * FROM live_events WHERE pub_id = ? AND status = 'published' AND ends_at >= ? ORDER BY starts_at`, pub.id, now());
  const past = await all<any>(c.env, `SELECT * FROM live_events WHERE pub_id = ? AND status = 'published' AND ends_at < ? AND kind != 'coaching' ORDER BY starts_at DESC LIMIT 24`, pub.id, now());
  await trackView(c);
  const CardEv = (p: { e: any }) => (
    <a class="s-card ev-card" href={`${base}/events/${p.e.slug}`}>
      {p.e.cover_url ? <img class="s-card-img" src={p.e.cover_url} alt="" loading="lazy" /> : <div class="s-card-img ev-date-tile"><span>{fmtDate(p.e.starts_at, { month: 'short' }, p.e.timezone)}</span><strong>{fmtDate(p.e.starts_at, { day: 'numeric' }, p.e.timezone)}</strong></div>}
      <div class="s-meta">{p.e.kind === 'coaching' ? '1:1 sessions' : fmtDate(p.e.starts_at, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }, p.e.timezone)}{p.e.stream_status === 'live' ? <span class="s-lock">● LIVE</span> : null}</div>
      <h3>{p.e.title}</h3>
      <p>{truncate(stripTags(p.e.description || ''), 140)}</p>
      <div class="s-meta">{fmtPrice(p.e.price_cents, p.e.currency)} · {p.e.kind === 'in_person' ? `📍 ${p.e.location || 'In person'}` : 'Online'}</div>
    </a>
  );
  return c.html(await SiteLayout({
    c, title: 'Events', description: `Upcoming events from ${pub.name}`, head: SITE_HEAD,
    children: (
      <section class="s-wrap s-section">
        <h1>Events</h1>
        {upcoming.length ? <div class="s-posts">{upcoming.map((e) => <CardEv e={e} />)}</div> : <p class="s-muted">No upcoming events right now — subscribe to hear about the next one.</p>}
        {past.length > 0 && <><h2 style="margin-top:48px">Past events</h2><div class="s-posts">{past.map((e) => <CardEv e={e} />)}</div></>}
      </section>
    ),
  }));
});

site.get('/events/:ev/calendar.ics', async (c) => {
  const ev = await eventBySlug(c);
  if (!ev) return c.text('Not found', 404);
  const pub = c.get('pub');
  const ics = buildIcs({ uid: `${ev.id}@openhive`, title: ev.title, description: stripTags(ev.description || ''), start: ev.starts_at, end: ev.ends_at, location: ev.location || evUrl(c.env, pub, ev), url: evUrl(c.env, pub, ev) });
  return c.body(ics, 200, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': `attachment; filename="${ev.slug}.ics"` });
});

site.get('/events/:ev', async (c) => {
  const ev = await eventBySlug(c);
  if (!ev) return SiteMessage(c, 'Event not found', <p>This event doesn't exist.</p>, 404);
  const pub = c.get('pub');
  const base = siteUrl(c.env, pub);
  const url = evUrl(c.env, pub, ev);
  const reader = c.get('reader');
  const existing = reader ? await one<any>(c.env, `SELECT * FROM event_registrations WHERE event_id = ? AND email = ? AND kind = 'attendee'`, ev.id, reader.email) : null;
  const taken = await regCount(c.env, ev.id);
  const soldOut = ev.kind !== 'coaching' && taken >= ev.capacity;
  const ended = ev.ends_at < now() && ev.kind !== 'coaching';
  const product = ev.replay_product_id ? await one<any>(c.env, `SELECT * FROM products WHERE id = ? AND status = 'active'`, ev.replay_product_id) : null;
  const slots = ev.kind === 'coaching' ? await coachingSlots(c.env, ev) : [];
  const gate = ev.access === 'premium' && !reader?.premium ? 'premium' : ev.access === 'subscribers' && !(reader?.subscriber && reader.subscriber.status === 'active') ? 'subscribers' : null;
  const err = c.req.query('error');
  await trackView(c, ev.id);
  const coach = parseJSON<any>(ev.coaching, {});

  const RegisterForm = () => (
    <form method="post" action={`${url}/register`} class="s-form ev-form s-stack">
      <input type="text" name="name" placeholder="Your name" value={reader?.subscriber?.name || ''} required autocomplete="name" />
      <input type="email" name="email" placeholder="you@example.com" value={reader?.email || ''} required autocomplete="email" />
      {ev.price_cents > 0 && <input type="text" name="code" placeholder="Discount code (optional)" />}
      {ev.kind === 'coaching' && <input type="hidden" name="slot" value="" data-slot-input />}
      <input type="text" name="website" class="s-hp" tabindex={-1} autocomplete="off" />
      <input type="hidden" name="_t" value={String(Date.now())} />
      <button class="s-btn" data-slot-submit={ev.kind === 'coaching' ? '1' : undefined}>{ev.kind === 'coaching' ? (ev.price_cents ? `Book for ${fmtPrice(ev.price_cents, ev.currency)}` : 'Book session') : ev.price_cents ? `Get ticket — ${fmtPrice(ev.price_cents, ev.currency)}` : 'Register free'}</button>
    </form>
  );

  return c.html(await SiteLayout({
    c, title: ev.title, description: truncate(stripTags(ev.description || ''), 200), image: ev.cover_url, canonical: url, head: SITE_HEAD, scripts: SITE_JS, noindex: ev.status === 'unlisted',
    jsonld: {
      '@context': 'https://schema.org', '@type': 'Event', name: ev.title, startDate: new Date(ev.starts_at).toISOString(), endDate: new Date(ev.ends_at).toISOString(),
      eventAttendanceMode: ev.kind === 'in_person' ? 'https://schema.org/OfflineEventAttendanceMode' : 'https://schema.org/OnlineEventAttendanceMode',
      eventStatus: 'https://schema.org/EventScheduled', image: ev.cover_url || undefined, description: stripTags(ev.description || ''),
      location: ev.kind === 'in_person' ? { '@type': 'Place', name: ev.location, address: ev.location } : { '@type': 'VirtualLocation', url },
      organizer: { '@type': 'Organization', name: pub.name, url: base },
      offers: { '@type': 'Offer', price: (ZERO_DECIMAL.has(ev.currency) ? ev.price_cents : ev.price_cents / 100).toFixed(2), priceCurrency: ev.currency.toUpperCase(), url, availability: soldOut ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock' },
    },
    children: (
      <div class="s-wrap s-section ev-page">
        <div class="ev-grid">
          <div>
            {ev.cover_url && <img src={ev.cover_url} alt="" class="ev-cover" />}
            <div class="s-meta">{ev.kind === 'webinar' ? 'Live online event' : ev.kind === 'in_person' ? 'In-person event' : '1:1 coaching'}{ev.stream_status === 'live' ? <span class="s-lock">● LIVE NOW</span> : null}</div>
            <h1>{ev.title}</h1>
            {ev.kind !== 'coaching' && (
              <p class="ev-when"><strong>📅 {whenText(ev)}</strong><br /><span class="s-muted s-small">Your time: <span data-local-time={new Date(ev.starts_at).toISOString()} /></span></p>
            )}
            {ev.kind === 'in_person' && ev.location && <p>📍 {ev.location}</p>}
            {ev.kind === 'coaching' && <p class="s-muted">{coach.duration_min || 30}-minute private video sessions · times shown in {ev.timezone.replace(/_/g, ' ')}</p>}
            <div class="s-body">{raw(sanitizeHtml(ev.description || '', { blocks: true }))}</div>
          </div>
          <aside class="ev-box s-box">
            {err && <div class="s-flash s-flash-err">{err}</div>}
            {!ended && ev.kind !== 'coaching' && ev.starts_at > now() && <div class="ev-countdown" data-countdown={new Date(ev.starts_at).toISOString()} />}
            {existing && ev.kind !== 'coaching' ? (
              <div class="s-stack">
                <strong>✓ You're registered</strong>
                {ev.kind !== 'in_person' && !ended && <a class="s-btn" href={`${url}/join/${existing.token}`}>{ev.stream_status === 'live' ? 'Join now' : 'Open event room'}</a>}
                {ended && ev.recording_key && <a class="s-btn" href={`${url}/replay?t=${existing.token}`}>Watch the replay</a>}
                <a class="s-small" href={`${url}/calendar.ics`}>Add to calendar</a>
              </div>
            ) : ended ? (
              <div class="s-stack">
                <strong>This event has ended.</strong>
                {ev.recording_key && product ? (
                  <form method="post" action={`${url}/replay/buy`} class="s-form s-stack">
                    <p class="s-muted">Watch the full recording.</p>
                    <input type="email" name="email" placeholder="you@example.com" value={reader?.email || ''} required />
                    <input type="text" name="code" placeholder="Discount code (optional)" />
                    <button class="s-btn">Buy replay — {fmtPrice(product.price_cents, product.currency)}</button>
                  </form>
                ) : ev.recording_key ? <a class="s-btn" href={`${url}/replay`}>Watch the replay</a> : <p class="s-muted">Subscribe to hear about the next one.</p>}
              </div>
            ) : gate ? (
              <div class="s-stack">
                <strong>{gate === 'premium' ? '🔒 For premium subscribers' : '🔒 For subscribers'}</strong>
                <p class="s-muted">{gate === 'premium' ? 'Upgrade your subscription to join this event.' : 'Subscribe (free) to register for this event.'}</p>
                {gate === 'premium' ? <a class="s-btn" href={`${base}/upgrade`}>Upgrade</a> : <button type="button" class="s-btn" data-modal="subscribe">Subscribe</button>}
                {!reader && <button type="button" class="s-btn s-btn-ghost" data-modal="login">Log in</button>}
              </div>
            ) : soldOut ? (
              <strong>Sold out — all {num(ev.capacity)} seats are taken.</strong>
            ) : ev.kind === 'coaching' ? (
              <div class="s-stack">
                <strong>Pick a time</strong>
                {slots.length ? (
                  <div class="ev-slots" data-slots>{slots.map((d) => (
                    <div class="ev-slot-day"><div class="s-small s-muted">{fmtDate(Date.parse(d.day + 'T12:00:00Z'), { weekday: 'short', month: 'short', day: 'numeric' }, 'UTC')}</div>
                      <div class="ev-slot-list">{d.slots.map((t) => <button type="button" data-slot={String(t)}>{fmtDate(t, { hour: 'numeric', minute: '2-digit' }, ev.timezone)}</button>)}</div></div>
                  ))}</div>
                ) : <p class="s-muted">No open slots right now — check back soon.</p>}
                {slots.length > 0 && <RegisterForm />}
              </div>
            ) : (
              <div class="s-stack">
                <div class="ev-price">{fmtPrice(ev.price_cents, ev.currency)}</div>
                <RegisterForm />
                <p class="s-small s-muted">{ev.capacity - taken < 50 ? `Only ${ev.capacity - taken} seat${ev.capacity - taken === 1 ? '' : 's'} left · ` : ''}You'll get a calendar invite and reminders by email.</p>
              </div>
            )}
          </aside>
        </div>
      </div>
    ),
  }));
});

site.post('/events/:ev/register', async (c) => {
  const ev = await eventBySlug(c);
  if (!ev) return c.text('Not found', 404);
  const pub = c.get('pub');
  const url = evUrl(c.env, pub, ev);
  const fail = (m: string) => c.redirect(`${url}?error=${encodeURIComponent(m)}`, 303);
  const f = await form(c.req);
  const ip = clientIP(c.req.raw);
  if (!(await rateLimit(c.env, `evreg:${ip}`, 10, 600))) return fail('Too many attempts — please wait a few minutes.');
  if (botScore({ honeypot: f.website, renderedAt: f._t, ua: c.req.header('user-agent') }) >= 60) return fail('Please try again.');
  const email = str(f.email, 254).toLowerCase();
  const v = await validateEmail(email, { strict: true });
  if (!v.ok) return fail(v.reason || 'Invalid email');
  if (ev.ends_at < now() && ev.kind !== 'coaching') return fail('This event has ended.');
  const reader = c.get('reader');
  if (ev.access === 'premium' && !reader?.premium) return fail('This event is for premium subscribers.');
  if (ev.access === 'subscribers' && !(reader?.subscriber && reader.subscriber.status === 'active')) {
    const s = await one<Subscriber>(c.env, `SELECT * FROM subscribers WHERE pub_id = ? AND email = ? AND status = 'active'`, pub.id, email);
    if (!s) return fail('This event is for subscribers — subscribe first, then register.');
  }
  if (ev.kind !== 'coaching' && (await regCount(c.env, ev.id)) >= ev.capacity) return fail('Sorry, this event is sold out.');
  let slot: number | null = null;
  if (ev.kind === 'coaching') {
    slot = int(f.slot) || null;
    const avail = (await coachingSlots(c.env, ev)).flatMap((d) => d.slots);
    if (!slot || !avail.includes(slot)) return fail('Please pick an available time slot.');
  }
  const name = str(f.name, 120);
  if (ev.price_cents > 0) {
    const off = await applyOffer(c.env, pub.id, str(f.code) || undefined, 'event', ev.id, ev.price_cents);
    if (off.error) return fail(off.error);
    const sub = await one<Subscriber>(c.env, 'SELECT id FROM subscribers WHERE pub_id = ? AND email = ?', pub.id, email);
    const co = await createCheckout(c.env, {
      pub, kind: 'ticket', refId: ev.id, email, name, subscriberId: sub?.id ?? null, amountCents: off.amount, currency: ev.currency,
      description: ev.kind === 'coaching' ? `${ev.title} — ${fmtDate(slot!, { dateStyle: 'medium', timeStyle: 'short' }, ev.timezone)}` : `Ticket: ${ev.title}`,
      offerId: off.offerId, data: { slot }, successUrl: `${url}/registered`, cancelUrl: url,
    });
    await run(c.env, `UPDATE orders SET data = json_set(data, '$.success_url', ?) WHERE id = ?`, `${url}/registered?o=${co.orderId}`, co.orderId);
    if (off.amount <= 0) return c.redirect(`${url}/registered?o=${co.orderId}`, 303);
    return c.redirect(co.url, 303);
  }
  const r = await registerAttendee(c.env, pub, ev, { email, name, slot, reader: reader?.email === email });
  if (!r.ok) return fail(r.error || 'Registration failed');
  return c.redirect(`${url}/registered?t=${r.reg.token}`, 303);
});

site.get('/events/:ev/registered', async (c) => {
  const ev = await eventBySlug(c);
  if (!ev) return c.text('Not found', 404);
  const pub = c.get('pub');
  const url = evUrl(c.env, pub, ev);
  let reg: any = null;
  const t = c.req.query('t'), o = c.req.query('o'), sid = c.req.query('session_id');
  if (t) reg = await one<any>(c.env, 'SELECT * FROM event_registrations WHERE event_id = ? AND token = ?', ev.id, t);
  else if (o || sid) {
    const order = await one<any>(c.env, `SELECT * FROM orders WHERE pub_id = ? AND (id = ? OR stripe_session_id = ?)`, pub.id, o || '', sid || '');
    if (order) reg = await one<any>(c.env, 'SELECT * FROM event_registrations WHERE event_id = ? AND (order_id = ? OR email = ?) ORDER BY created_at DESC', ev.id, order.id, order.email);
    if (!reg && order) return SiteMessage(c, 'Payment received', <p>We're confirming your payment — your ticket and calendar invite will arrive by email in a moment.</p>);
  }
  if (!reg) return c.redirect(url, 302);
  const booking = reg.booking_id ? await one<any>(c.env, 'SELECT * FROM bookings WHERE id = ?', reg.booking_id) : null;
  const start = booking?.starts_at ?? ev.starts_at, end = booking?.ends_at ?? ev.ends_at;
  const join = joinUrl(c.env, pub, ev, reg.token);
  const gcal = googleCalendarUrl({ title: ev.title, description: `Join: ${join}`, start, end, location: ev.kind === 'in_person' ? ev.location || '' : join });
  return c.html(await SiteLayout({
    c, title: `Registered: ${ev.title}`, noindex: true, head: SITE_HEAD, scripts: SITE_JS,
    children: (
      <section class="s-wrap s-narrow s-message">
        <div class="ev-check">✓</div>
        <h1>You're in!</h1>
        <p class="s-muted">We sent your confirmation and calendar invite to <strong>{reg.email}</strong>.</p>
        <p><strong>{ev.title}</strong><br />{whenText(ev, start, end)}</p>
        <div class="row-center">
          {ev.kind !== 'in_person' && <a class="s-btn" href={join}>Open event room</a>}
          <a class="s-btn s-btn-ghost" href={gcal} target="_blank" rel="noopener">Google Calendar</a>
          <a class="s-btn s-btn-ghost" href={`${url}/calendar.ics`}>Apple / Outlook (.ics)</a>
        </div>
        {start > now() && <div class="ev-countdown" data-countdown={new Date(start).toISOString()} />}
      </section>
    ),
  }));
});

site.get('/events/:ev/join/:token', async (c) => {
  const ev = await eventBySlug(c);
  if (!ev) return c.text('Not found', 404);
  return c.redirect(`${evUrl(c.env, c.get('pub'), ev)}/live?t=${encodeURIComponent(c.req.param('token'))}`, 302);
});

site.get('/events/:ev/live', async (c) => {
  const ev = await eventBySlug(c);
  if (!ev) return c.text('Not found', 404);
  const pub = c.get('pub');
  const url = evUrl(c.env, pub, ev);
  const t = c.req.query('t') || '';
  const reg = t ? await one<any>(c.env, `SELECT * FROM event_registrations WHERE event_id = ? AND token = ? AND kind = 'attendee'`, ev.id, t) : null;
  if (!reg) {
    const email = c.get('reader')?.email;
    const r2 = email ? await one<any>(c.env, `SELECT token FROM event_registrations WHERE event_id = ? AND email = ? AND kind = 'attendee'`, ev.id, email) : null;
    if (r2) return c.redirect(`${url}/live?t=${r2.token}`, 302);
    return SiteMessage(c, 'Registration required', <><p>Use the personal join link from your confirmation email, or register below.</p><p><a class="s-btn" href={url}>Register for {ev.title}</a></p></>, 403);
  }
  if (ev.stream_status === 'ended' && ev.recording_key) return c.redirect(`${url}/replay?t=${t}`, 302);
  return c.html(await SiteLayout({
    c, title: `Live: ${ev.title}`, noindex: true, head: <><link rel="stylesheet" href="/static/live.css" />{SITE_HEAD}</>, scripts: ['/static/live.js', ...SITE_JS], bodyClass: 'live-body',
    children: (
      <section class="s-wrap s-section">
        <div class="ev-live-head"><div><div class="s-meta">{pub.name}</div><h1>{ev.title}</h1></div>{ev.starts_at > now() && <div class="ev-countdown ev-countdown-sm" data-countdown={new Date(ev.starts_at).toISOString()} />}</div>
        <LiveRoomUI host={false} title={ev.title} cfg={liveCfg(c.env, pub, ev, { ws: `/live/${ev.id}?t=${encodeURIComponent(t)}`, role: 'attendee', name: reg.name || reg.email.split('@')[0], status: ev.stream_status, replayUrl: `${url}/replay?t=${t}` })} />
      </section>
    ),
  }));
});

site.get('/events/:ev/replay', async (c) => {
  const ev = await eventBySlug(c);
  if (!ev) return c.text('Not found', 404);
  const pub = c.get('pub');
  const url = evUrl(c.env, pub, ev);
  if (!ev.recording_key) return SiteMessage(c, 'Replay not available yet', <p>The recording will be available here soon after the event.</p>);
  if (!(await canAccessReplay(c, ev))) {
    const product = ev.replay_product_id ? await one<any>(c.env, `SELECT * FROM products WHERE id = ? AND status = 'active'`, ev.replay_product_id) : null;
    return SiteMessage(c, `Replay: ${ev.title}`, product ? (
      <form method="post" action={`${url}/replay/buy`} class="s-form s-stack" style="max-width:420px;margin:0 auto">
        <p class="s-muted">Watch the full recording on demand.</p>
        <input type="email" name="email" placeholder="you@example.com" required />
        <input type="text" name="code" placeholder="Discount code (optional)" />
        <button class="s-btn">Buy replay — {fmtPrice(product.price_cents, product.currency)}</button>
      </form>
    ) : <p>The replay is available to registrants. Use the link from your email or <button type="button" class="s-btn s-btn-ghost" data-modal="login">log in</button>.</p>, 403);
  }
  const q = c.req.query('t') ? `?t=${encodeURIComponent(c.req.query('t')!)}` : '';
  await trackView(c, ev.id);
  return c.html(await SiteLayout({
    c, title: `Replay: ${ev.title}`, noindex: true, head: SITE_HEAD,
    children: (
      <section class="s-wrap s-section">
        <div class="s-meta">Replay · {fmtDate(ev.starts_at, { dateStyle: 'long' }, ev.timezone)}</div>
        <h1>{ev.title}</h1>
        <video class="ev-replay" controls playsinline preload="metadata" src={`${url}/replay/video${q}`} poster={ev.cover_url || undefined} />
        <div class="s-body" style="max-width:720px;margin-top:24px">{raw(sanitizeHtml(ev.description || '', { blocks: true }))}</div>
      </section>
    ),
  }));
});

site.get('/events/:ev/replay/video', async (c) => {
  const ev = await eventBySlug(c);
  if (!ev || !ev.recording_key) return c.text('Not found', 404);
  if (!(await canAccessReplay(c, ev))) return c.text('Forbidden', 403);
  return serveObject(c.env, ev.recording_key, c.req.raw, { 'cache-control': 'private, max-age=600' });
});

site.post('/events/:ev/replay/buy', async (c) => {
  const ev = await eventBySlug(c);
  if (!ev) return c.text('Not found', 404);
  const pub = c.get('pub');
  const url = evUrl(c.env, pub, ev);
  const product = ev.replay_product_id ? await one<any>(c.env, `SELECT * FROM products WHERE id = ? AND status = 'active'`, ev.replay_product_id) : null;
  if (!product) return c.redirect(url, 303);
  const f = await form(c.req);
  if (!(await rateLimit(c.env, `evbuy:${clientIP(c.req.raw)}`, 10, 600))) return c.redirect(`${url}?error=${encodeURIComponent('Too many attempts')}`, 303);
  const v = await validateEmail(str(f.email), { strict: true });
  if (!v.ok) return c.redirect(`${url}?error=${encodeURIComponent(v.reason || 'Invalid email')}`, 303);
  const off = await applyOffer(c.env, pub.id, str(f.code) || undefined, 'event', ev.id, product.price_cents);
  if (off.error) return c.redirect(`${url}?error=${encodeURIComponent(off.error)}`, 303);
  const co = await createCheckout(c.env, { pub, kind: 'ticket', refId: ev.id, email: v.email, amountCents: off.amount, currency: product.currency, description: product.name, offerId: off.offerId, data: { replay: true }, successUrl: `${url}/replay/purchased`, cancelUrl: url });
  await run(c.env, `UPDATE orders SET data = json_set(data, '$.success_url', ?) WHERE id = ?`, `${url}/replay/purchased?o=${co.orderId}`, co.orderId);
  return c.redirect(off.amount <= 0 ? `${url}/replay/purchased?o=${co.orderId}` : co.url, 303);
});

site.get('/events/:ev/replay/purchased', async (c) => {
  const ev = await eventBySlug(c);
  if (!ev) return c.text('Not found', 404);
  const order = await one<any>(c.env, `SELECT * FROM orders WHERE pub_id = ? AND (id = ? OR stripe_session_id = ?) AND status = 'paid'`, c.get('pub').id, c.req.query('o') || '', c.req.query('session_id') || '');
  const reg = order ? await one<any>(c.env, 'SELECT token FROM event_registrations WHERE event_id = ? AND email = ?', ev.id, order.email) : null;
  if (reg) return c.redirect(`${evUrl(c.env, c.get('pub'), ev)}/replay?t=${reg.token}`, 302);
  return SiteMessage(c, 'Thanks for your purchase!', <p>We're confirming your payment. Your replay link is on its way to your inbox.</p>);
});

// ───────────────── live room WebSocket ─────────────────
root.get('/live/:eventId', async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return c.text('Expected WebSocket', 426);
  const ev = await one<any>(c.env, 'SELECT * FROM live_events WHERE id = ?', c.req.param('eventId'));
  if (!ev) return c.text('Not found', 404);
  const headers = new Headers(c.req.raw.headers);
  headers.set('x-event', ev.id);
  const t = c.req.query('t');
  if (t) {
    const reg = await one<any>(c.env, `SELECT * FROM event_registrations WHERE event_id = ? AND token = ? AND kind = 'attendee'`, ev.id, t);
    if (!reg) return c.text('Invalid ticket', 403);
    headers.set('x-role', 'attendee');
    headers.set('x-uid', reg.id);
    headers.set('x-name', reg.name || reg.email.split('@')[0]);
  } else {
    const u = await currentUser(c);
    const pubs = u ? await userPubs(c.env, u.id) : [];
    const p = pubs.find((x) => x.id === ev.pub_id);
    if (!u || !p || !can(p.role, 'manage')) return c.text('Forbidden', 403);
    headers.set('x-role', 'host');
    headers.set('x-uid', 'host:' + u.id);
    headers.set('x-name', u.name || 'Host');
  }
  const stub = c.env.LIVE.get(c.env.LIVE.idFromName(ev.id));
  return stub.fetch(new Request(c.req.url, { headers }));
});

export default { dash, site, root } satisfies Module;
