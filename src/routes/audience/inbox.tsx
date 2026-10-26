/** @jsxImportSource hono/jsx */
// Audience → Inbox: readers' replies to newsletters (Mailchimp-style Inbox). Mounted at /app/audience/inbox.
// Replies arrive through Email Routing → email() → lib/inbox. Settings for the feature live on this page.
import { Hono } from 'hono';
import type { AppEnv } from '../../types';
import { one, all, run, val } from '../../lib/db';
import { requirePerm, audit } from '../../lib/auth';
import { settings } from '../../lib/pub';
import { sendInboxReply, stripQuoted, replyAddress } from '../../lib/inbox';
import { sharedDomain } from '../../lib/sharedsender';
import { sanitizeHtml } from '../../lib/sanitize';
import { form, str, bool, ago, fmtDateTime, num } from '../../lib/util';
import { DashLayout } from '../../ui/layout';
import { Card, Field, Input, Textarea, Btn, ActionForm, Table, Badge, Toggle, Help, Tabs, Empty, back } from '../../ui/components';
import { saveSettings } from '../settings/ui';

const inbox = new Hono<AppEnv>();
inbox.use('*', requirePerm('manage'));

inbox.get('/', async (c) => {
  const pub = c.get('pub');
  const cfg = settings(pub);
  const q = c.req.query();
  const view = q.view === 'archived' ? 'archived' : q.view === 'unread' ? 'unread' : 'open';
  const where = view === 'archived' ? `t.status = 'archived'` : view === 'unread' ? `t.status = 'open' AND t.unread = 1` : `t.status = 'open'`;
  const params: unknown[] = [pub.id];
  let search = '';
  if (q.q) { search = ' AND (t.email LIKE ? OR t.name LIKE ? OR t.subject LIKE ?)'; params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  const threads = await all<any>(c.env, `SELECT t.*, p.title AS post_title, (SELECT text FROM inbox_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_text FROM inbox_threads t LEFT JOIN posts p ON p.id = t.post_id WHERE t.pub_id = ? AND ${where}${search} ORDER BY t.last_message_at DESC LIMIT 200`, ...params);
  const unread = await val<number>(c.env, `SELECT COUNT(*) FROM inbox_threads WHERE pub_id = ? AND status = 'open' AND unread = 1`, pub.id);
  const example = replyAddress(c.env, pub, 'abc123def456');
  return c.html(
    <DashLayout c={c} title="Inbox" section="audience" sub="inbox">
      {!cfg.collect_replies && (
        <div class="callout">Replies are not being collected yet. Turn on <strong>Collect replies in Inbox</strong> below and readers' replies to your newsletters land here instead of your mailbox.</div>
      )}
      <Card pad={false} title={
        <div class="row" style="justify-content:space-between;width:100%">
          <Tabs active={view === 'open' ? '/app/audience/inbox' : `/app/audience/inbox?view=${view}`} items={[['/app/audience/inbox', 'Open'], ['/app/audience/inbox?view=unread', `Unread${unread ? ` (${unread})` : ''}`], ['/app/audience/inbox?view=archived', 'Archived']]} />
          <form method="get" class="row"><input type="hidden" name="view" value={view} /><Input name="q" value={q.q} placeholder="Search name, email, subject" /><Btn kind="secondary" small>Search</Btn></form>
        </div>
      }>
        {threads.length ? (
          <Table rows={threads} rowHref={(t) => `/app/audience/inbox/${t.id}`} cols={[
            { h: '', r: (t) => (t.unread ? <span class="badge b-blue" title="Unread">●</span> : '') },
            { h: 'From', r: (t) => <a href={`/app/audience/inbox/${t.id}`}>{t.unread ? <strong>{t.name || t.email}</strong> : t.name || t.email}<br /><small class="muted">{t.email}</small></a> },
            { h: 'Conversation', r: (t) => <span>{t.subject || '(no subject)'}{t.message_count > 1 && <small class="muted"> · {t.message_count}</small>}<br /><small class="muted">{stripQuoted(t.last_text || '').slice(0, 120)}</small></span> },
            { h: 'Newsletter', r: (t) => <small>{t.post_title || (t.send_id ? 'Automation email' : '—')}</small> },
            { h: 'Last', r: (t) => <span class="nowrap">{ago(t.last_message_at)}</span> },
          ]} />
        ) : (
          <Empty title={view === 'archived' ? 'No archived conversations' : 'No replies yet'} body={cfg.collect_replies ? 'When readers reply to a newsletter, the conversation shows up here.' : 'Turn on reply collection below to start.'} />
        )}
      </Card>
      <Card title="Reply settings">
        <form method="post" action="/app/audience/inbox/settings" class="stack-sm">
          <Toggle name="collect_replies" checked={!!cfg.collect_replies} label="Collect replies in Inbox" hint={`New newsletter and automation emails get Reply-To: ${example.replace('abc123def456', '<id>')} so replies land here, linked to the subscriber and the post. Off by default: replies go to your usual reply-to address.`} />
          <Toggle name="inbox_forward" checked={!!cfg.inbox_forward} label="Email me a copy of each reply" hint="Replying to that copy writes to the reader directly (it won't be in the Inbox thread)." />
          <Field label="Send copies to" hint="Defaults to the workspace owner."><Input name="inbox_forward_to" type="email" value={typeof cfg.inbox_forward_to === 'string' ? cfg.inbox_forward_to : ''} placeholder="you@example.com" /></Field>
          <div class="row end"><Btn small>Save</Btn></div>
        </form>
        <Help>Platform operators: replies are received through Cloudflare Email Routing on <code>{sharedDomain(c.env) || 'the shared sending domain'}</code> — a <code>reply+*</code> (or catch-all) rule must send to this Worker. {unread ? `${num(unread)} unread.` : ''}</Help>
      </Card>
    </DashLayout>,
  );
});

inbox.post('/settings', requirePerm('admin'), async (c) => {
  const f = await form(c.req);
  const to = str(f.inbox_forward_to, 254).trim().toLowerCase();
  if (to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return back(c, '/app/audience/inbox', 'That copy address looks invalid.', 'err');
  await saveSettings(c, { collect_replies: bool(f.collect_replies), inbox_forward: bool(f.inbox_forward), inbox_forward_to: to || undefined });
  await audit(c, 'inbox.settings', undefined, { collect_replies: bool(f.collect_replies), inbox_forward: bool(f.inbox_forward) });
  return back(c, '/app/audience/inbox', bool(f.collect_replies) ? 'Saved. New emails will collect replies here.' : 'Saved.');
});

inbox.get('/:id', async (c) => {
  const pub = c.get('pub');
  const t = await one<any>(c.env, `SELECT t.*, p.title AS post_title FROM inbox_threads t LEFT JOIN posts p ON p.id = t.post_id WHERE t.id = ? AND t.pub_id = ?`, c.req.param('id'), pub.id);
  if (!t) return c.notFound();
  if (t.unread) await run(c.env, 'UPDATE inbox_threads SET unread = 0 WHERE id = ?', t.id);
  const msgs = await all<any>(c.env, 'SELECT * FROM inbox_messages WHERE thread_id = ? ORDER BY created_at', t.id);
  const sub = t.subscriber_id ? await one<any>(c.env, 'SELECT id, email, name, status, tier FROM subscribers WHERE id = ?', t.subscriber_id) : null;
  return c.html(
    <DashLayout c={c} title={t.subject || 'Conversation'} section="audience" sub="inbox" crumbs={[['Inbox', '/app/audience/inbox']]}
      actions={<div class="row">
        <ActionForm action={`/app/audience/inbox/${t.id}/unread`} label="Mark unread" kind="ghost" small />
        <ActionForm action={`/app/audience/inbox/${t.id}/${t.status === 'archived' ? 'unarchive' : 'archive'}`} label={t.status === 'archived' ? 'Move to inbox' : 'Archive'} kind="secondary" small />
      </div>}>
      <div class="grid g3" style="grid-template-columns:2fr 1fr">
        <div class="stack">
          {msgs.map((m) => (
            <Card title={<span>{m.direction === 'out' ? <Badge tone="purple">You</Badge> : null} {m.from_name || m.from_email} <small class="muted">· {fmtDateTime(m.created_at, pub.timezone)}</small></span>}>
              <div style="white-space:pre-wrap">{m.direction === 'in' ? stripQuoted(m.text || '') : m.text}</div>
              {m.direction === 'in' && (m.text || '').trim() !== stripQuoted(m.text || '') && (
                <details class="small muted"><summary>Show quoted text</summary><div style="white-space:pre-wrap">{m.text}</div></details>
              )}
              {m.html && <details class="small"><summary>View formatted message</summary><iframe sandbox="" srcdoc={sanitizeHtml(m.html)} style="width:100%;height:360px;border:1px solid #e5e7eb;border-radius:8px;background:#fff" title="Message" /></details>}
            </Card>
          ))}
          <Card title={`Reply to ${t.name || t.email}`}>
            <form method="post" action={`/app/audience/inbox/${t.id}/reply`} class="stack-sm">
              <Textarea name="body" rows={6} required placeholder="Write a reply…" />
              <div class="row end"><Btn>Send reply</Btn></div>
            </form>
            <Help>Sent from your publication's sender, threaded with the reader's message. Their next reply comes back here.</Help>
          </Card>
        </div>
        <div class="stack">
          <Card title="Reader">
            <p><strong>{t.name || t.email}</strong><br /><span class="muted">{t.email}</span></p>
            {!t.verified && <p class="small"><Badge tone="amber">unverified</Badge> The sender differs from the person this email was delivered to (forwarded or alias).</p>}
            {sub ? <p><a href={`/app/audience/s/${sub.id}`}>Open subscriber profile</a> · {sub.status} · {sub.tier}</p> : <p class="muted">Not a subscriber of this publication.</p>}
          </Card>
          <Card title="In reply to">
            <p>{t.post_title ? <a href={`/app/posts/${t.post_id}`}>{t.post_title}</a> : t.send_id ? 'An automation email' : '—'}</p>
          </Card>
        </div>
      </div>
    </DashLayout>,
  );
});

inbox.post('/:id/reply', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const body = str(f.body, 20_000).trim();
  if (!body) return back(c, `/app/audience/inbox/${c.req.param('id')}`, 'Write a reply first.', 'err');
  const r = await sendInboxReply(c.env, pub, c.req.param('id'), body, c.get('user').id);
  if (!r.ok) return back(c, `/app/audience/inbox/${c.req.param('id')}`, `Reply not sent: ${r.error || r.status}`, 'err');
  await audit(c, 'inbox.reply', c.req.param('id'));
  return back(c, `/app/audience/inbox/${c.req.param('id')}`, r.status === 'simulated' ? 'Reply saved (simulated sending).' : 'Reply sent.');
});

for (const [action, sql, msg] of [
  ['archive', `status = 'archived', unread = 0`, 'Archived.'],
  ['unarchive', `status = 'open'`, 'Moved to inbox.'],
  ['unread', `unread = 1`, 'Marked unread.'],
] as const) {
  inbox.post(`/:id/${action}`, async (c) => {
    await run(c.env, `UPDATE inbox_threads SET ${sql} WHERE id = ? AND pub_id = ?`, c.req.param('id'), c.get('pub').id);
    return back(c, action === 'unarchive' ? `/app/audience/inbox/${c.req.param('id')}` : '/app/audience/inbox', msg);
  });
}

export default inbox;
