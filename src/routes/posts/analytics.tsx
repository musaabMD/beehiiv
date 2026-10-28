/** @jsxImportSource hono/jsx */
// Post analytics: deliveries, bot-filtered opens/clicks, A/B + cohort results, links, providers, web views, polls, resend.
import { postStats } from '../../lib/stats';
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
import { attemptsFor } from '../../lib/email';
import { loadThrottles, holdReason } from '../../lib/throttle';

const app = new Hono<AppEnv>();

app.get('/:id', async (c) => {
  const pub = c.get('pub');
  const post = await loadPost(c, c.req.param('id'));
  if (!post) return c.notFound();
  const pid = post.id;
  const sends = await all<any>(c.env, `SELECT * FROM sends WHERE post_id = ? AND kind != 'try' ORDER BY created_at`, pid);
  const totals = await one<any>(c.env, `SELECT COUNT(DISTINCT COALESCE(d.subscriber_id, d.email)) AS recipients,
      COUNT(DISTINCT CASE WHEN d.status IN ('sent','complained') THEN COALESCE(d.subscriber_id, d.email) END) AS delivered,
      COUNT(DISTINCT CASE WHEN d.opened_at IS NOT NULL THEN COALESCE(d.subscriber_id, d.email) END) AS opens,
      COUNT(DISTINCT CASE WHEN d.clicked_at IS NOT NULL THEN COALESCE(d.subscriber_id, d.email) END) AS clicks,
      SUM(CASE WHEN d.status = 'bounced' THEN 1 ELSE 0 END) AS bounces,
      SUM(CASE WHEN d.status = 'complained' THEN 1 ELSE 0 END) AS complaints,
      SUM(CASE WHEN d.status = 'suppressed' THEN 1 ELSE 0 END) AS suppressed,
      SUM(CASE WHEN d.status = 'deferred' THEN 1 ELSE 0 END) AS deferred,
      SUM(d.open_count) AS total_opens, SUM(d.click_count) AS total_clicks
    FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = ? AND s.kind NOT IN ('test','try')`, pid) || {};
  const firstSent = sends[0]?.started_at || post.published_at || now();
  const unsubs = (await postStats(c.env, pub.id, pid)).unsubscribes;
  const botOpens = (await one<any>(c.env, `SELECT COUNT(*) AS n FROM opens o JOIN sends s ON s.id = o.send_id WHERE s.post_id = ? AND s.kind NOT IN ('test','try') AND o.is_bot = 1`, pid))?.n || 0;
  const botClicks = (await one<any>(c.env, `SELECT COUNT(*) AS n FROM clicks k JOIN sends s ON s.id = k.send_id WHERE s.post_id = ? AND s.kind NOT IN ('test','try') AND k.is_bot = 1`, pid))?.n || 0;
  const delivered = totals.delivered || 0;
  // opens over time (hourly for 48h)
  const openRows = await all<any>(c.env, `SELECT CAST((o.created_at - ?) / ${HOUR} AS INTEGER) AS h, COUNT(DISTINCT o.delivery_id) AS n FROM opens o JOIN sends s ON s.id = o.send_id WHERE s.post_id = ? AND s.kind NOT IN ('test','try') AND o.is_bot = 0 AND o.created_at >= ? GROUP BY h`, firstSent, pid, firstSent);
  const clickRows = await all<any>(c.env, `SELECT CAST((k.created_at - ?) / ${HOUR} AS INTEGER) AS h, COUNT(DISTINCT k.delivery_id) AS n FROM clicks k JOIN sends s ON s.id = k.send_id WHERE s.post_id = ? AND s.kind NOT IN ('test','try') AND k.is_bot = 0 AND k.created_at >= ? GROUP BY h`, firstSent, pid, firstSent);
  const hours = Array.from({ length: 48 }, (_, i) => i);
  const series = (rows: any[]) => hours.map((h) => rows.find((r) => r.h === h)?.n || 0);
  // A/B + cohorts
  const variants = await all<any>(c.env, `SELECT d.variant AS v, COUNT(*) AS n, SUM(CASE WHEN d.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS op, SUM(CASE WHEN d.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS cl FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = ? AND s.kind NOT IN ('test','try') AND d.variant IS NOT NULL GROUP BY d.variant ORDER BY d.variant`, pid);
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
  // A/B + multivariate: report the test sample per variant (deliveries before the winner was picked), then the rollout
  const abSend = [...sends].reverse().find((s) => parseJSON<any>(s.options, {}).ab);
  const abSendOpts = abSend ? parseJSON<any>(abSend.options, {}) : null;
  const abTest = abSendOpts?.ab || null;
  const decidedAt = Number(abSendOpts?.ab_decided_at) || 0;
  const abSample = abSend ? await all<any>(c.env, `SELECT substr(variant,1,1) AS v, COUNT(*) AS n, SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) AS op, SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS cl FROM deliveries WHERE send_id = ? AND variant IS NOT NULL AND status NOT IN ('scheduled','skipped') ${decidedAt ? 'AND created_at <= ?' : ''} GROUP BY substr(variant,1,1) ORDER BY v`, abSend.id, ...(decidedAt ? [decidedAt] : [])) : [];
  const abWinnerRest = abSend && decidedAt ? ((await one<any>(c.env, `SELECT COUNT(*) AS n FROM deliveries WHERE send_id = ? AND created_at > ?`, abSend.id, decidedAt))?.n || 0) : 0;
  // timed sends (send-time optimization / time zones)
  const timedSend = [...sends].reverse().find((s) => parseJSON<any>(s.options, {}).timing);
  const timedInfo = timedSend ? await (async () => {
    const tm = parseJSON<any>(timedSend.options, {}).timing;
    const r = await one<any>(c.env, `SELECT SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled, SUM(CASE WHEN status IN ('sent','deferred') THEN 1 ELSE 0 END) AS sent, MAX(next_attempt_at) AS last FROM deliveries WHERE send_id = ?`, timedSend.id);
    return { mode: tm.mode, local_time: tm.local_time, scheduled: r?.scheduled || 0, sent: r?.sent || 0, last: r?.last || 0 };
  })() : null;
  const links = await all<any>(c.env, `SELECT k.url, COUNT(DISTINCT k.delivery_id) AS uniq, COUNT(*) AS total FROM clicks k JOIN sends s ON s.id = k.send_id WHERE s.post_id = ? AND s.kind NOT IN ('test','try') AND k.is_bot = 0 GROUP BY k.url ORDER BY uniq DESC LIMIT 50`, pid);
  const providers = await all<any>(c.env, `SELECT COALESCE(d.provider,'other') AS provider, COUNT(*) AS n, SUM(CASE WHEN d.status IN ('sent','complained') THEN 1 ELSE 0 END) AS delivered, SUM(CASE WHEN d.status = 'bounced' THEN 1 ELSE 0 END) AS bounced, SUM(CASE WHEN d.status = 'complained' THEN 1 ELSE 0 END) AS complained, SUM(CASE WHEN d.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS op FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = ? AND s.kind NOT IN ('test','try') GROUP BY provider ORDER BY n DESC`, pid);
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
  const nonOpeners = (await one<any>(c.env, `SELECT COUNT(DISTINCT d.subscriber_id) AS n FROM deliveries d JOIN sends s ON s.id = d.send_id JOIN subscribers sb ON sb.id = d.subscriber_id WHERE s.post_id = ? AND s.kind NOT IN ('test','try') AND d.status = 'sent' AND d.opened_at IS NULL AND sb.status = 'active' AND NOT EXISTS (SELECT 1 FROM deliveries d2 JOIN sends s2 ON s2.id = d2.send_id WHERE s2.post_id = ? AND d2.subscriber_id = d.subscriber_id AND d2.opened_at IS NOT NULL)`, pid, pid))?.n || 0;
  const canPublish = can(c.get('role'), 'publish');
  const rate = (a: number, b: number) => (b ? pct(a, b) : '—');
  const stopped = sends.some((s) => ['sending', 'testing'].includes(s.status)) ? holdReason(await loadThrottles(c.env), pub.workspace_id) : null;
  return c.html(
    <DashLayout c={c} title={post.title || 'Untitled post'} section="posts" sub="posts" crumbs={[['/app/posts', 'Posts']]}
      actions={<>
        {post.platform !== 'email' && post.status === 'published' && <LinkBtn href={`${siteUrl(c.env, pub)}/p/${post.slug}`} target="_blank">View on web ↗</LinkBtn>}
        <LinkBtn href={`/app/posts/${pid}/edit`}>Edit post</LinkBtn>
      </>}>
      <p class="muted"><Status s={post.status} /> {post.published_at ? `Published ${fmtDateTime(post.published_at, pub.timezone)}` : ''} {sends.map((s) => <span> · <Status s={s.status} /> {s.subject} ({num(s.sent)}/{num(s.total)})</span>)}</p>
      {sends.filter((s) => s.status_reason && ['paused', 'pending_approval', 'rejected', 'sending'].includes(s.status)).map((s) => (
        <div class={`callout ${s.status === 'paused' || s.status === 'rejected' ? 'danger' : ''}`} data-send-reason={s.status}>
          <strong>{s.status === 'paused' ? 'Paused for safety: ' : s.status === 'pending_approval' ? 'Waiting for review: ' : s.status === 'rejected' ? 'Not sent: ' : 'Sending slowly: '}</strong>{s.status_reason}
          {s.status === 'paused' ? ' Our team has been notified and will review it — clean the list and reply to the email we sent you.' : ''}
        </div>
      ))}
      {stopped && <div class="callout danger" data-stop-banner="post">{stopped} <a href="/app/sending">Sending controls</a></div>}
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
      {abRows.size > 0 && (() => {
        const t = abTest || ab || {};
        const multi = !!t.variants?.length;
        const winner = abSendOpts?.winner || ab?.winner || null;
        const testRows = abSample.length ? abSample : [...abRows.entries()].map(([k, v]) => ({ v: k, ...v }));
        const best = testRows.reduce((m, r) => Math.max(m, (t.metric === 'clicks' ? r.cl : r.op) / Math.max(1, r.n)), 0);
        return (
          <Card title={multi ? 'Multivariate test results' : 'A/B test results'} actions={<span class="small muted">{num(t.sample_pct || 0)}% sample · winner by {t.metric === 'clicks' ? 'click rate' : 'open rate'} after {num(t.wait_minutes || 0)} min{winner ? '' : ' · deciding…'}</span>}>
            <div data-ab-results>
              <Table rows={testRows} cols={[
                { h: 'Variant', r: (r) => <span><strong>{r.v}</strong> {winner === r.v && <Badge tone="green">Winner</Badge>}</span> },
                { h: 'Subject', r: (r) => <span class="small">{t.subjects?.[r.v.charCodeAt(0) - 65] || post.email_subject || post.title}</span> },
                ...(multi ? [
                  { h: 'Preview text', r: (r: any) => <span class="small muted">{t.variants?.[r.v.charCodeAt(0) - 65]?.preview_text || '—'}</span> },
                  { h: 'Sender name', r: (r: any) => <span class="small muted">{t.variants?.[r.v.charCodeAt(0) - 65]?.from_name || 'Default'}</span> },
                  { h: 'Content', r: (r: any) => <span class="small">{t.variants?.[r.v.charCodeAt(0) - 65]?.content === 'b' ? 'Variant B' : 'Main'}</span> },
                ] : []),
                { h: 'Sent', r: (r) => num(r.n), class: 'right' },
                { h: 'Open rate', r: (r) => <span>{rate(r.op, r.n)}</span>, class: 'right' },
                { h: 'Click rate', r: (r) => <span>{rate(r.cl, r.n)}</span>, class: 'right' },
                { h: '', r: (r) => <div style="width:90px;height:6px;border-radius:3px;background:var(--surface-2)"><div style={`width:${best ? Math.round(((t.metric === 'clicks' ? r.cl : r.op) / Math.max(1, r.n) / best) * 100) : 0}%;height:6px;border-radius:3px;background:var(--accent)`} /></div> },
              ]} />
              {winner && abWinnerRest > 0 && <p class="small muted" style="margin:8px 0 0">Variant {winner} was then sent to {num(abWinnerRest)} more subscriber{abWinnerRest === 1 ? '' : 's'}.</p>}
            </div>
          </Card>
        );
      })()}
      {timedInfo && (
        <div class="callout" data-send-timing>
          <strong>{timedInfo.mode === 'sto' ? 'Send-time optimization: ' : `Delivery by time zone (${timedInfo.local_time}): `}</strong>
          {num(timedInfo.sent)} delivered{timedInfo.scheduled ? `, ${num(timedInfo.scheduled)} scheduled — the last one goes out ${fmtDateTime(timedInfo.last, pub.timezone)}` : ' — complete'}.
        </div>
      )}
      <div class="grid g2">
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
      {sends.length > 0 && post.platform !== 'web' && (
        <Card title="Recipients" actions={<LinkBtn href={`/app/posts/${pid}/recipients`}>Look up a recipient</LinkBtn>}>
          <p class="muted" style="margin:0">Every delivery with its status and each attempt to hand it to the mailbox provider (retries included), with the provider's response.</p>
        </Card>
      )}
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

// ───────── per-recipient drill-down: deliveries + attempt history ─────────
const D_STATUSES: Array<[string, string]> = [['', 'All'], ['sent', 'Sent'], ['deferred', 'Retrying'], ['scheduled', 'Scheduled'], ['bounced', 'Bounced'], ['failed', 'Failed'], ['suppressed', 'Suppressed'], ['complained', 'Complained']];
const dTone = (s: string) => (s === 'sent' ? 'green' : s === 'deferred' || s === 'scheduled' || s === 'queued' ? 'amber' : s === 'suppressed' || s === 'skipped' ? 'gray' : 'red') as any;
app.get('/:id/recipients', async (c) => {
  const pub = c.get('pub');
  const post = await loadPost(c, c.req.param('id'));
  if (!post) return c.notFound();
  const q = str(c.req.query('q'), 200).trim().toLowerCase();
  const st = str(c.req.query('status'), 20);
  const w = [`s.post_id = ?`, `s.kind NOT IN ('test','try')`];
  const params: unknown[] = [post.id];
  if (q) { w.push('(d.email LIKE ? OR d.id = ?)'); params.push(`%${q}%`, q); }
  if (st) { w.push('d.status = ?'); params.push(st); }
  const rows = await all<any>(c.env, `SELECT d.id, d.email, d.status, d.attempts, d.provider, d.error, d.sent_at, d.next_attempt_at, d.variant, (SELECT COUNT(*) FROM delivery_attempts a WHERE a.delivery_id = d.id) AS tries FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE ${w.join(' AND ')} ORDER BY d.created_at DESC LIMIT 200`, ...params);
  return c.html(
    <DashLayout c={c} title="Recipients" section="posts" sub="posts" crumbs={[['/app/posts', 'Posts'], [`/app/posts/${post.id}`, post.title || 'Untitled post']]}>
      <form method="get" class="row" style="margin-bottom:12px">
        <input class="input grow" name="q" value={q} placeholder="Email address or delivery id" />
        <select class="input" name="status" style="max-width:180px">{D_STATUSES.map(([v, l]) => <option value={v} selected={v === st}>{l}</option>)}</select>
        <Btn kind="secondary" small>Search</Btn>
      </form>
      <Card pad={false}>
        <Table rows={rows} empty="No deliveries match." cols={[
          { h: 'Recipient', r: (d) => <a href={`/app/posts/${post.id}/d/${d.id}`}>{d.email}</a> },
          { h: 'Status', r: (d) => <Badge tone={dTone(d.status)}>{d.status}</Badge> },
          { h: 'Attempts', r: (d) => num(Math.max(d.tries || 0, d.attempts || 0)), class: 'right' },
          { h: 'Provider', r: (d) => <span style="text-transform:capitalize">{d.provider || 'other'}</span> },
          { h: 'Sent', r: (d) => (d.sent_at ? fmtDateTime(d.sent_at, pub.timezone) : d.next_attempt_at && ['deferred', 'scheduled'].includes(d.status) ? <span class="muted">next {fmtDateTime(d.next_attempt_at, pub.timezone)}</span> : '—') },
          { h: 'Last error', r: (d) => <span class="small muted">{(d.error || '').slice(0, 120)}</span> },
        ]} />
      </Card>
    </DashLayout>,
  );
});
app.get('/:id/d/:did', async (c) => {
  const pub = c.get('pub');
  const post = await loadPost(c, c.req.param('id'));
  if (!post) return c.notFound();
  const d = await one<any>(c.env, `SELECT d.*, s.subject AS send_subject FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE d.id = ? AND s.post_id = ? AND d.pub_id = ?`, c.req.param('did'), post.id, pub.id);
  if (!d) return c.notFound();
  const attempts = await attemptsFor(c.env, d.id);
  return c.html(
    <DashLayout c={c} title={d.email} section="posts" sub="posts" crumbs={[['/app/posts', 'Posts'], [`/app/posts/${post.id}`, post.title || 'Untitled post'], [`/app/posts/${post.id}/recipients`, 'Recipients']]}>
      <Card title="Delivery">
        <dl class="kv">
          <dt>Recipient</dt><dd>{d.email}</dd>
          <dt>Status</dt><dd><Badge tone={dTone(d.status)}>{d.status}</Badge>{d.bounce_type ? <small class="muted"> {d.bounce_type}</small> : null} {d.error && <small class="muted">{d.error}</small>}</dd>
          <dt>Subject</dt><dd>{d.send_subject}{d.variant ? <small class="muted"> · variant {d.variant}</small> : null}</dd>
          <dt>Mailbox provider</dt><dd style="text-transform:capitalize">{d.provider || 'other'}</dd>
          <dt>Delivery id</dt><dd><code>{d.id}</code>{d.message_id && <> · provider <code>{d.message_id}</code></>}</dd>
          {d.sent_at && <><dt>Sent</dt><dd>{fmtDateTime(d.sent_at, pub.timezone)}</dd></>}
          {d.next_attempt_at && ['deferred', 'scheduled'].includes(d.status) && <><dt>Next attempt</dt><dd>{fmtDateTime(d.next_attempt_at, pub.timezone)}</dd></>}
          <dt>Engagement</dt><dd>{d.opened_at ? `opened ${fmtDateTime(d.opened_at, pub.timezone)}` : 'not opened'} · {num(d.click_count)} clicks</dd>
        </dl>
      </Card>
      <Card title={`Attempts (${attempts.length})`} pad={false}>
        <Table rows={attempts} empty="No attempts recorded yet." cols={[
          { h: '#', r: (a) => num(a.attempt) },
          { h: 'When', r: (a) => fmtDateTime(a.created_at, pub.timezone) },
          { h: 'Result', r: (a) => <Badge tone={dTone(a.status === 'simulated' ? 'sent' : a.status)}>{a.status}</Badge> },
          { h: 'Provider response', r: (a) => <code class="small" data-attempt-response>{a.response || '—'}</code> },
          { h: 'Duration', r: (a) => `${num(a.duration_ms)} ms`, class: 'right' },
        ]} />
      </Card>
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
  await run(c.env, `INSERT OR IGNORE INTO segment_members (segment_id, subscriber_id) SELECT DISTINCT ?, d.subscriber_id FROM deliveries d JOIN sends s ON s.id = d.send_id WHERE s.post_id = ? AND s.kind NOT IN ('test','try') AND d.status = 'sent' AND d.subscriber_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM deliveries d2 JOIN sends s2 ON s2.id = d2.send_id WHERE s2.post_id = ? AND d2.subscriber_id = d.subscriber_id AND d2.opened_at IS NOT NULL)`, segId, post.id, post.id);
  try { await startSend(c.env, pub, post, { segment_ids: [segId], exclude_segment_ids: [], list_id: null, audience: 'all', tier_ids: [], ab: null, cohorts: null, subject: str(f.subject, 200) || null });
  } catch (e) {
    const { SendBlockedError } = await import('../../lib/plans');
    if (e instanceof SendBlockedError) return back(c, `/app/posts/${post.id}`, e.message, 'err');
    throw e;
  }
  kick(c.env, c.executionCtx);
  await audit(c, 'post.resend', post.id);
  return back(c, `/app/posts/${post.id}`, 'Resend to non-openers started');
});

export default app;
