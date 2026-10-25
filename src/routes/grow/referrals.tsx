/** @jsxImportSource hono/jsx */
// Referral program: milestones/rewards, leaderboard, awards fulfillment; reader page /referrals.
import { raw } from 'hono/html';
import type { App } from '../../types';
import { all, one, run, val, insert, update } from '../../lib/db';
import { requirePerm, audit } from '../../lib/auth';
import { renderDoc, styleFor } from '../../lib/render';
import { siteUrl } from '../../lib/pub';
import { DashLayout } from '../../ui/layout';
import { SiteLayout, SiteMessage } from '../../ui/site';
import { Card, Stats, Stat, Table, Btn, Field, Input, Textarea, Select, Modal, OpenBtn, ActionForm, Status, Empty, back, Grid, Help, Progress } from '../../ui/components';
import { trackView } from '../../lib/tracking';
import { id, now, form, str, int, num, ago, esc } from '../../lib/util';

const KINDS: Array<[string, string]> = [['digital', 'Digital (link / download)'], ['promo', 'Promo code'], ['premium', 'Free premium access (days)'], ['physical', 'Physical item (we email for address)']];

const PAYLOAD_HINT: Record<string, string> = { digital: 'URL the reader receives', promo: 'The promo code', premium: 'Number of premium days', physical: 'Internal note (optional)' };

function RewardFields(p: { r?: any }) {
  const r = p.r || {};
  return (
    <>
      <Grid cols={2}>
        <Field label="Milestone (referrals)"><Input name="milestone" type="number" min={1} value={r.milestone ?? 3} required /></Field>
        <Field label="Reward type"><Select name="kind" value={r.kind || 'digital'} options={KINDS} /></Field>
      </Grid>
      <Field label="Reward name"><Input name="name" value={r.name} placeholder="Exclusive sticker pack" required /></Field>
      <Field label="Description"><Textarea name="description" value={r.description} rows={2} /></Field>
      <Field label="Payload" hint="Digital: URL · Promo: code · Premium: days · Physical: note"><Input name="payload" value={r.payload} /></Field>
      <Field label="Image URL" hint="Shown on the referral page"><Input name="image_url" value={r.image_url} placeholder="https://…" /></Field>
    </>
  );
}

function rewardFromForm(f: Record<string, any>) {
  return { milestone: Math.max(1, int(f.milestone, 1)), name: str(f.name, 120), description: str(f.description, 600), kind: KINDS.some(([k]) => k === f.kind) ? f.kind : 'digital', payload: str(f.payload, 500), image_url: str(f.image_url, 500) || null };
}

export function registerReferrals(dash: App, site: App) {
  dash.get('/', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const [rewards, leaders, awards, totalRefs, referrers, awardsCount] = await Promise.all([
      all<any>(c.env, `SELECT r.*, (SELECT COUNT(*) FROM referral_awards a WHERE a.reward_id = r.id) AS awarded FROM referral_rewards r WHERE r.pub_id = ? ORDER BY milestone`, pub.id),
      all<any>(c.env, `SELECT id, email, name, referral_count, referral_code FROM subscribers WHERE pub_id = ? AND referral_count > 0 ORDER BY referral_count DESC, created_at LIMIT 10`, pub.id),
      all<any>(c.env, `SELECT a.*, r.name AS reward, r.kind, r.milestone, s.email, s.name AS sub_name FROM referral_awards a JOIN referral_rewards r ON r.id = a.reward_id JOIN subscribers s ON s.id = a.subscriber_id WHERE a.pub_id = ? ORDER BY a.created_at DESC LIMIT 50`, pub.id),
      val<number>(c.env, `SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND referred_by IS NOT NULL`, pub.id),
      val<number>(c.env, `SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND referral_count > 0`, pub.id),
      val<number>(c.env, `SELECT COUNT(*) FROM referral_awards WHERE pub_id = ?`, pub.id),
    ]);
    const thirty = await val<number>(c.env, `SELECT COUNT(*) FROM subscribers WHERE pub_id = ? AND referred_by IS NOT NULL AND created_at > ?`, pub.id, now() - 30 * 86400000);
    const preview = await renderDoc({ blocks: [{ type: 'referral', data: {} }] }, { env: c.env, mode: 'email', pub, siteUrl: siteUrl(c.env, pub), access: true, style: styleFor(pub), subscriber: leaders[0] ? (await one<any>(c.env, 'SELECT * FROM subscribers WHERE id = ?', leaders[0].id)) : null });
    return c.html(
      <DashLayout c={c} title="Referral program" section="grow" sub="referrals" actions={<OpenBtn target="#new-reward">+ Add reward</OpenBtn>}>
        <Stats>
          <Stat label="Referred subscribers" value={num(totalRefs)} sub={`${num(thirty)} in the last 30 days`} />
          <Stat label="Active referrers" value={num(referrers)} />
          <Stat label="Rewards earned" value={num(awardsCount)} />
          <Stat label="Milestones" value={num(rewards.length)} />
        </Stats>
        <div class="split">
          <div>
            <Card title="Milestones & rewards" actions={<OpenBtn target="#new-reward" kind="secondary" small>+ Add</OpenBtn>} pad={false}>
              <Table rows={rewards} empty={<Empty title="No rewards yet" body="Add milestones like '3 referrals → sticker pack' to motivate readers to share." action={<OpenBtn target="#new-reward">Add your first reward</OpenBtn>} />} cols={[
                { h: 'Milestone', r: (r) => <strong>{r.milestone} referrals</strong> },
                { h: 'Reward', r: (r) => <><div>{r.name}</div><small class="muted">{r.description}</small></> },
                { h: 'Type', r: (r) => <Status s={r.kind} /> },
                { h: 'Awarded', r: (r) => num(r.awarded), class: 'right' },
                { h: '', class: 'right nowrap', r: (r) => <><OpenBtn target={`#edit-${r.id}`} kind="ghost" small>Edit</OpenBtn><ActionForm action={`/app/grow/rewards/${r.id}/delete`} label="Delete" kind="danger" confirm="Delete this reward?" /></> },
              ]} />
            </Card>
            <Card title="Recent rewards earned" pad={false}>
              <Table rows={awards} empty="Nobody has reached a milestone yet." cols={[
                { h: 'Subscriber', r: (a) => <a href={`/app/audience/subscribers/${a.subscriber_id}`}>{a.sub_name || a.email}</a> },
                { h: 'Reward', r: (a) => `${a.reward} (${a.milestone})` },
                { h: 'Status', r: (a) => <Status s={a.status} /> },
                { h: 'When', r: (a) => ago(a.created_at) },
                { h: '', class: 'right nowrap', r: (a) => a.status === 'awarded' ? <><ActionForm action={`/app/grow/awards/${a.id}/fulfill`} label="Mark fulfilled" /><ActionForm action={`/app/grow/awards/${a.id}/reject`} label="Reject" kind="ghost" /></> : null },
              ]} />
            </Card>
          </div>
          <div>
            <Card title="Top referrers" pad={false}>
              <Table rows={leaders} empty="No referrals yet." cols={[
                { h: '#', r: (l) => String(leaders.indexOf(l) + 1) },
                { h: 'Reader', r: (l) => <a href={`/app/audience/subscribers/${l.id}`}>{l.name || l.email}</a> },
                { h: 'Referrals', r: (l) => <strong>{l.referral_count}</strong>, class: 'right' },
              ]} />
            </Card>
            <Card title="Referral block preview">
              <Help>Drop the <strong>Referral</strong> block into any post. Each reader sees their own link and progress. Readers can also visit <a href={`${siteUrl(c.env, pub)}/referrals`} target="_blank">/referrals</a>.</Help>
              <div style="border:1px solid var(--border);border-radius:8px;padding:12px;background:#fff">{raw(preview.html)}</div>
            </Card>
          </div>
        </div>
        <Modal id="new-reward" title="Add reward">
          <form method="post" action="/app/grow/rewards"><RewardFields /><div class="form-actions"><Btn>Add reward</Btn></div></form>
        </Modal>
        {rewards.map((r) => (
          <Modal id={`edit-${r.id}`} title="Edit reward">
            <form method="post" action={`/app/grow/rewards/${r.id}`}><RewardFields r={r} /><div class="form-actions"><Btn>Save</Btn></div></form>
          </Modal>
        ))}
      </DashLayout>,
    );
  });

  dash.post('/rewards', requirePerm('manage'), async (c) => {
    const r = rewardFromForm(await form(c.req));
    if (!r.name) return back(c, '/app/grow', 'Reward name is required', 'err');
    await insert(c.env, 'referral_rewards', { id: id(), pub_id: c.get('pub').id, ...r, created_at: now() });
    await audit(c, 'referral_reward.create', r.name);
    return back(c, '/app/grow', 'Reward added');
  });
  dash.post('/rewards/:id', requirePerm('manage'), async (c) => {
    await update(c.env, 'referral_rewards', c.req.param('id'), rewardFromForm(await form(c.req)), c.get('pub').id);
    return back(c, '/app/grow', 'Reward updated');
  });
  dash.post('/rewards/:id/delete', requirePerm('manage'), async (c) => {
    await run(c.env, 'DELETE FROM referral_rewards WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
    return back(c, '/app/grow', 'Reward deleted');
  });
  dash.post('/awards/:id/:action{fulfill|reject}', requirePerm('manage'), async (c) => {
    const status = c.req.param('action') === 'fulfill' ? 'fulfilled' : 'rejected';
    await run(c.env, 'UPDATE referral_awards SET status = ? WHERE id = ? AND pub_id = ?', status, c.req.param('id'), c.get('pub').id);
    return back(c, '/app/grow', `Reward marked ${status}`);
  });

  // ── Reader referral dashboard
  site.get('/referrals', async (c) => {
    const pub = c.get('pub');
    const reader = c.get('reader');
    await trackView(c, 'referrals');
    const base = siteUrl(c.env, pub);
    const rewards = await all<any>(c.env, 'SELECT * FROM referral_rewards WHERE pub_id = ? ORDER BY milestone', pub.id);
    const sub = reader?.subscriber;
    if (!sub) {
      return SiteMessage(c, 'Refer friends, earn rewards', (
        <>
          <p class="s-muted">Subscribe or log in to get your personal referral link.</p>
          {rewards.length > 0 && <ul style="text-align:left;display:inline-block">{rewards.map((r) => <li><strong>{r.milestone} referrals</strong> — {r.name}</li>)}</ul>}
          <p><button class="s-btn" data-modal="subscribe">Subscribe</button> <button class="s-btn s-btn-ghost" data-modal="login">Log in</button></p>
        </>
      ));
    }
    const link = `${base}/subscribe?ref=${sub.referral_code}`;
    const next = rewards.find((r) => r.milestone > sub.referral_count);
    const awards = await all<any>(c.env, 'SELECT reward_id, status FROM referral_awards WHERE subscriber_id = ?', sub.id);
    const won = new Set(awards.map((a) => a.reward_id));
    const text = encodeURIComponent(`I read ${pub.name} and think you'd like it too:`);
    const u = encodeURIComponent(link);
    return c.html(
      await SiteLayout({
        c, title: 'Your referrals', noindex: true,
        children: (
          <section class="s-wrap s-narrow" style="padding:48px 20px">
            <h1>Share {pub.name}</h1>
            <p class="s-muted">You've referred <strong>{sub.referral_count}</strong> {sub.referral_count === 1 ? 'reader' : 'readers'}.{next ? ` ${next.milestone - sub.referral_count} more to unlock “${next.name}”.` : ''}</p>
            <div class="oh-copy" style="margin:20px 0"><input readonly value={link} /><button type="button" data-copy={link}>Copy link</button></div>
            <div class="s-share">
              <a class="s-btn s-btn-ghost" target="_blank" rel="noopener" href={`https://twitter.com/intent/tweet?text=${text}&url=${u}`}>Share on X</a>
              <a class="s-btn s-btn-ghost" target="_blank" rel="noopener" href={`https://www.linkedin.com/sharing/share-offsite/?url=${u}`}>LinkedIn</a>
              <a class="s-btn s-btn-ghost" target="_blank" rel="noopener" href={`https://www.facebook.com/sharer/sharer.php?u=${u}`}>Facebook</a>
              <a class="s-btn s-btn-ghost" target="_blank" rel="noopener" href={`https://wa.me/?text=${text}%20${u}`}>WhatsApp</a>
              <a class="s-btn s-btn-ghost" href={`mailto:?subject=${encodeURIComponent(pub.name)}&body=${text}%20${u}`}>Email</a>
              <button class="s-btn s-btn-ghost" data-share={link}>More…</button>
            </div>
            {rewards.length > 0 && (
              <div class="s-stack">
                <h2>Rewards</h2>
                {rewards.map((r) => {
                  const pct = Math.min(100, (sub.referral_count / r.milestone) * 100);
                  return (
                    <div class="s-box" style="display:flex;gap:16px;align-items:center">
                      {r.image_url && <img src={r.image_url} alt="" style="width:64px;height:64px;object-fit:cover;border-radius:8px" />}
                      <div style="flex:1">
                        <strong>{r.name}</strong> <span class="s-badge">{r.milestone} referrals</span>
                        {won.has(r.id) && <span class="s-badge" style="margin-left:6px">✓ Unlocked</span>}
                        <div class="s-muted s-small">{r.description}</div>
                        <div style="height:8px;background:var(--surface);border-radius:8px;margin-top:8px;overflow:hidden"><div style={`height:100%;width:${pct}%;background:var(--accent)`} /></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        ),
      }),
    );
  });
}

