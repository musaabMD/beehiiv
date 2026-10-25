/** @jsxImportSource hono/jsx */
// Post analytics: deliveries, bot-filtered opens/clicks, A/B + cohort results, links, providers, web views, polls, resend.
import { Hono } from 'hono';
import type { AppEnv } from '../../types';
import { all, one, insert, run } from '../../lib/db';
import { can, audit } from '../../lib/auth';
import { startSend } from '../../lib/sender';
import { kick } from '../../lib/jobs';
import { parseDoc } from '../../lib/render';
import { siteUrl } from '../../lib/pub';
import { DashLayout } from '../../ui/layout';
import { Card, Stats, Stat, Table, Bars, LineChart, LinkBtn, Btn, Status, Badge, back, Empty } from '../../ui/components';
import { num, pct, fmtDateTime, parseJSON, form, str, id, now, HOUR, DAY } from '../../lib/util';
import { loadPost, walkBlocks } from './shared';

const app = new Hono<AppEnv>();

app.get('/:id', async (c) => {
  const pub = c.get('pub');
  const post = await loadPost(c, c.req.param('id'));
  if (!post) return c.notFound();
  const pid = post.id;
  const sends = await all<any>(c.env, `SELECT * FROM sends WHERE post_id = ? ORDER BY created_at`, pid);
  const totals = await one<any>(c.env, `SELECT COUNT(DISTINCT COALESCE(d.subscriber_id, d.email)) AS recipients,
      COUNT(DISTINCT CASE WHEN d.status IN ('sent','deferred') THEN COALESCE(d.subscriber_id, d.email) END) AS delivered,
      COUNT(DISTINCT CASE WHEN d.opened_at IS NOT NULL THEN COALESCE(d.subscriber_id, d.email) END) AS opens,
      COUNT(DISTINCT CASE WHEN d.clicked_at IS NOT NULL THEN COALESCE(d.subscriber_id, d.email) END) AS clicks,
      SUM(CASE WHEN d.status = 'bounced' THEN 1 ELSE 0 END) AS bounces,
      SUM(CASE WHEN d.status = 'complained' THEN 1 ELSE 0 END) AS complaints,
      SUM(CASE WHEN d.status = 'suppressed' THEN 1 ELSE 0 END) AS suppressed,
      SUM(CASE WHEN d.status = 'deferred' THEN 1 ELSE 0 END) AS deferred,
      SUM(d.open_count) AS total_opens, SUM(d.click_count) AS total_clicks
    FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = ?`, pid) || {};
  const firstSent = sends[0]?.started_at || post.published_at || now();
  const unsubs = (await one<any>(c.env, `SELECT COUNT(DISTINCT a.subscriber_id) AS n FROM activity a WHERE a.pub_id = ? AND a.type = 'subscription.deleted' AND a.created_at BETWEEN ? AND ? AND a.subscriber_id IN (SELECT d.subscriber_id FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = ?)`, pub.id, firstSent, firstSent + 7 * DAY, pid))?.n || 0;
  const botOpens = (await one<any>(c.env, `SELECT COUNT(*) AS n FROM opens o JOIN sends s ON s.id = o.send_id WHERE s.post_id = ? AND o.is_bot = 1`, pid))?.n || 0;
  const botClicks = (await one<any>(c.env, `SELECT COUNT(*) AS n FROM clicks k JOIN sends s ON s.id = k.send_id WHERE s.post_id = ? AND k.is_bot = 1`, pid))?.n || 0;
  const delivered = totals.delivered || 0;
  // opens over time (hourly for 48h)
  const openRows = await all<any>(c.env, `SELECT CAST((o.created_at - ?) / ${HOUR} AS INTEGER) AS h, COUNT(DISTINCT o.delivery_id) AS n FROM opens o JOIN sends s ON s.id = o.send_id WHERE s.post_id = ? AND o.is_bot = 0 AND o.created_at >= ? GROUP BY h`, firstSent, pid, firstSent);
  const clickRows = await all<any>(c.env, `SELECT CAST((k.created_at - ?) / ${HOUR} AS INTEGER) AS h, COUNT(DISTINCT k.delivery_id) AS n FROM clicks k JOIN sends s ON s.id = k.send_id WHERE s.post_id = ? AND k.is_bot = 0 AND k.created_at >= ? GROUP BY h`, firstSent, pid, firstSent);
  const hours = Array.from({ length: 48 }, (_, i) => i);
  const series = (rows: any[]) => hours.map((h) => rows.find((r) => r.h === h)?.n || 0);
  // A/B + cohorts
  const variants = await all<any>(c.env, `SELECT d.variant AS v, COUNT(*) AS n, SUM(CASE WHEN d.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS op, SUM(CASE WHEN d.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS cl FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = ? AND d.variant IS NOT NULL GROUP BY d.variant ORDER BY d.variant`, pid);
  const ab = parseJSON<any>(post.ab_test, null);
  const abRows = new Map<string, { n: number; op: number; cl: number }>();
  const cohortRows = new Map<string, { n: number; op: number; cl: number }>();
  for (const v of variants) {
    const [a, b] = String(v.v).includes('/') ? String(v.v).split('/') : /^[A-D]$/.test(v.v) ? [v.v, null] : [null, v.v];
    for (const [key, map] of [[a, abRows], [b, cohortRows]] as const) {
      if (!key) continue;
      const cur = map.get(key) || { n: 0, op: 0, cl: 0 };
      cur.n += v.n; cur.op += v.op; cur.cl += v.cl;
      map.set(key, cur);
    }
  }
  const links = await all<any>(c.env, `SELECT k.url, COUNT(DISTINCT k.delivery_id) AS uniq, COUNT(*) AS total FROM clicks k JOIN sends s ON s.id = k.send_id WHERE s.post_id = ? AND k.is_bot = 0 GROUP BY k.url ORDER BY uniq DESC LIMIT 50`, pid);
  const providers = await all<any>(c.env, `SELECT COALESCE(d.provider,'other') AS provider, COUNT(*) AS n, SUM(CASE WHEN d.status IN ('sent','deferred') THEN 1 ELSE 0 END) AS delivered, SUM(CASE WHEN d.status = 'bounced' THEN 1 ELSE 0 END) AS bounced, SUM(CASE WHEN d.status = 'complained' THEN 1 ELSE 0 END) AS complained, SUM(CASE WHEN d.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS op FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = ? GROUP BY provider ORDER BY n DESC`, pid);
  const web = await one<any>(c.env, `SELECT COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors FROM page_views WHERE pub_id = ? AND ref_id = ?`, pub.id, pid);
  const webChannels = await all<any>(c.env, `SELECT COALESCE(channel,'direct') AS ch, COUNT(*) AS n FROM page_views WHERE pub_id = ? AND ref_id = ? GROUP BY ch ORDER BY n DESC`, pub.id, pid);
  const signups = (await one<any>(c.env, `SELECT COUNT(*) AS n FROM subscribers WHERE pub_id = ? AND instr(landing_path, ?) > 0`, pub.id, `/p/${post.slug}`))?.n || 0;
  // polls in this post
  const pollIds: string[] = [];
  walkBlocks(parseDoc(post.content).blocks, (b) => { if (b.type === 'poll' && b.data?.poll_id) pollIds.push(b.data.poll_id); });
  const polls = [] as Array<{ q: string; opts: Array<{ label: string; n: number }>; total: number }>;
  for (const pollId of pollIds) {
    const poll = await one<any>(c.env, 'SELECT * FROM polls WHERE id = ? AND pub_id = ?', pollId, pub.id);
    if (!poll) continue;
    const votes = await all<any>(c.env, 'SELECT option_id, COUNT(*) AS n FROM poll_votes WHERE poll_id = ? GROUP BY option_id', pollId);
    const opts = parseJSON<any[]>(poll.options, []).map((o) => ({ label: o.label, n: votes.find((v) => v.option_id === o.id)?.n || 0 }));
    polls.push({ q: poll.question, opts, total: opts.reduce((a, b) => a + b.n, 0) });
  }
  const nonOpeners = (await one<any>(c.env, `SELECT COUNT(DISTINCT d.subscriber_id) AS n FROM deliveries d JOIN sends s ON s.id = d.send_id JOIN subscribers sb ON sb.id = d.subscriber_id WHERE s.post_id = ? AND d.status = 'sent' AND d.opened_at IS NULL AND sb.status = 'active' AND NOT EXISTS (SELECT 1 FROM deliveries d2 JOIN sends s2 ON s2.id = d2.send_id WHERE s2.post_id = ? AND d2.subscriber_id = d.subscriber_id AND d2.opened_at IS NOT NULL)`, pid, pid))?.n || 0;
  const canPublish = can(c.get('role'), 'publish');
  const rate = (a: number, b: number) => (b ? pct(a, b) : '—');
  return c.html(
    <DashLayout c={c} title={post.title || 'Untitled post'} section="posts" sub="posts" crumbs={[['/app/posts', 'Posts']]}
      actions={<>
        {post.platform !== 'email' && post.status === 'published' && <LinkBtn href={`${siteUrl(c.env, pub)}/p/${post.slug}`} target="_blank">View on web ↗</LinkBtn>}
        <LinkBtn href={`/app/posts/${pid}/edit`}>Edit post</LinkBtn>
      </>}>
      <p class="muted"><Status s={post.status} /> {post.published_at ? `Published ${fmtDateTime(post.published_at, pub.timezone)}` : ''} {sends.map((s) => <span> · <Status s={s.status} /> {s.subject} ({num(s.sent)}/{num(s.total)})</span>)}</p>
      {post.platform === 'web' ? null : (
        <Stats>
          <Stat label="Recipients" value={num(totals.recipients || 0)} sub={`${num(delivered)} delivered (${rate(delivered, totals.recipients)})`} />
          <Stat label="Open rate" value={rate(totals.opens || 0, delivered)} sub={`${num(totals.opens || 0)} unique · ${num(botOpens)} bot opens filtered`} />
          <Stat label="Click rate" value={rate(totals.clicks || 0, delivered)} sub={`${num(totals.clicks || 0)} unique · ${num(botClicks)} bot clicks filtered`} />
          <Stat label="Click-to-open" value={rate(totals.clicks || 0, totals.opens || 0)} />
          <Stat label="Unsubscribes" value={num(unsubs)} sub={rate(unsubs, delivered)} />
          <Stat label="Bounces" value={num(totals.bounces || 0)} sub={`${num(totals.deferred || 0)} deferred · ${num(totals.suppressed || 0)} suppressed`} />
          <Stat label="Spam complaints" value={num(totals.complaints || 0)} sub={rate(totals.complaints || 0, delivered)} />
        </Stats>
      )}
      <Stats>
        <Stat label="Web views" value={num(web?.views || 0)} sub={`${num(web?.visitors || 0)} unique visitors`} />
        <Stat label="Signups from this post" value={num(signups)} />
        <Stat label="Words" value={num(post.word_count)} sub={`~${Math.max(1, Math.round(post.word_count / 230))} min read`} />
      </Stats>
      {sends.length > 0 && (
        <Card title="Engagement over the first 48 hours">
          <LineChart labels={hours.map((h) => `${h}h`)} series={[{ label: 'Unique opens', values: series(openRows) }, { label: 'Unique clicks', values: series(clickRows) }]} />
        </Card>
      )}
      <div class="grid g2">
        {abRows.size > 0 && (
          <Card title="Subject line A/B test">
            <Table rows={[...abRows.entries()]} cols={[
              { h: 'Variant', r: ([k]) => <span>{k} {ab?.winner === k && <Badge tone="green">Winner</Badge>}</span> },
              { h: 'Subject', r: ([k]) => <span class="small">{ab?.subjects?.[k.charCodeAt(0) - 65] || '—'}</span> },
              { h: 'Sent', r: ([, v]) => num(v.n), class: 'right' },
              { h: 'Open rate', r: ([, v]) => rate(v.op, v.n), class: 'right' },
              { h: 'Click rate', r: ([, v]) => rate(v.cl, v.n), class: 'right' },
            ]} />
          </Card>
        )}
        {cohortRows.size > 0 && (
          <Card title="Random cohort test">
            <Table rows={[...cohortRows.entries()]} cols={[
              { h: 'Cohort', r: ([k]) => k },
              { h: 'Sent', r: ([, v]) => num(v.n), class: 'right' },
              { h: 'Open rate', r: ([, v]) => rate(v.op, v.n), class: 'right' },
              { h: 'Click rate', r: ([, v]) => rate(v.cl, v.n), class: 'right' },
            ]} />
          </Card>
        )}
      </div>
      <div class="grid g2">
        <Card title="Links clicked" pad={false}>
          <Table rows={links} empty="No human clicks yet." cols={[
            { h: 'URL', r: (l) => <a href={l.url} target="_blank" class="truncate" title={l.url}>{l.url.replace(/[?&]utm_[^&]+/g, '').replace(/^https?:\/\//, '')}</a> },
            { h: 'Unique', r: (l) => num(l.uniq), class: 'right' },
            { h: 'Total', r: (l) => num(l.total), class: 'right' },
            { h: 'CTR', r: (l) => rate(l.uniq, delivered), class: 'right' },
          ]} />
        </Card>
        <Card title="Deliverability by mailbox provider" pad={false}>
          <Table rows={providers} empty="Not sent yet." cols={[
            { h: 'Provider', r: (p) => <span style="text-transform:capitalize">{p.provider}</span> },
            { h: 'Sent', r: (p) => num(p.n), class: 'right' },
            { h: 'Delivered', r: (p) => rate(p.delivered, p.n), class: 'right' },
            { h: 'Bounced', r: (p) => num(p.bounced), class: 'right' },
            { h: 'Complaints', r: (p) => num(p.complained), class: 'right' },
            { h: 'Open rate', r: (p) => rate(p.op, p.delivered), class: 'right' },
          ]} />
        </Card>
      </div>
      <div class="grid g2">
        <Card title="Web traffic sources">
          <Bars rows={webChannels.map((w) => ({ label: w.ch, value: w.n }))} />
        </Card>
        {polls.length > 0 ? (
          <Card title="Poll results">
            {polls.map((p) => (
              <div style="margin-bottom:16px">
                <strong>{p.q}</strong> <span class="muted small">({num(p.total)} votes)</span>
                <Bars rows={p.opts.map((o) => ({ label: o.label, value: o.n, sub: p.total ? pct(o.n, p.total, 0) : '' }))} />
              </div>
            ))}
          </Card>
        ) : <div />}
      </div>
      {canPublish && post.platform !== 'web' && post.status === 'published' && (
        <Card title="Resend to non-openers">
          {nonOpeners ? (
            <form method="post" action={`/app/posts/${pid}/resend`} class="row">
              <span class="muted">{num(nonOpeners)} subscribers haven't opened this post.</span>
              <input class="input grow" name="subject" placeholder={`New subject (optional) — was: ${post.email_subject || post.title}`} maxlength={200} />
              <Btn kind="primary" confirm={`Resend to ${nonOpeners} non-openers?`}>Resend</Btn>
            </form>
          ) : <p class="muted">Everyone who received this post has opened it, or it hasn't been sent yet.</p>}
        </Card>
      )}
      {post.platform === 'web' && sends.length === 0 && <Card><Empty title="Web-only post" body="This post was published to your website only, so there are no email stats." /></Card>}
    </DashLayout>,
  );
});

app.post('/:id/resend', async (c) => {
  const pub = c.get('pub');
  if (!can(c.get('role'), 'publish')) return back(c, `/app/posts/${c.req.param('id')}`, 'Not allowed', 'err');
  const post = await loadPost(c, c.req.param('id'));
  if (!post) return c.notFound();
  const f = await form(c.req);
  // freeze non-openers into a static segment (keeps the send query small at any list size)
  const segId = id();
  await insert(c.env, 'segments', { id: segId, pub_id: pub.id, name: `Non-openers: ${(post.title || 'Untitled').slice(0, 60)} (${new Date().toISOString().slice(0, 10)})`, description: 'Created automatically for a resend', kind: 'static', rules: '{"op":"and","rules":[]}', created_at: now() });
  await run(c.env, `INSERT OR IGNORE INTO segment_members (segment_id, subscriber_id) SELECT DISTINCT ?, d.subscriber_id FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = ? AND d.status = 'sent' AND d.subscriber_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM deliveries d2 JOIN sends s2 ON s2.id = d2.send_id WHERE s2.post_id = ? AND d2.subscriber_id = d.subscriber_id AND d2.opened_at IS NOT NULL)`, segId, post.id, post.id);
  await startSend(c.env, pub, post, { segment_ids: [segId], exclude_segment_ids: [], list_id: null, audience: 'all', tier_ids: [], ab: null, cohorts: null, subject: str(f.subject, 200) || null });
  kick(c.env, c.executionCtx);
  await audit(c, 'post.resend', post.id);
  return back(c, `/app/posts/${post.id}`, 'Resend to non-openers started');
});

export default app;
