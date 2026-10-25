/** @jsxImportSource hono/jsx */
// Recommendation network: discover publications on this instance, recommend (free/reciprocal), signup-flow page.
import type { App, Publication } from '../../types';
import { all, one, run, val, insert } from '../../lib/db';
import { requirePerm, audit } from '../../lib/auth';
import { aiJSON, aiEnabled } from '../../lib/ai';
import { siteUrl, appUrl, getPub } from '../../lib/pub';
import { sendTransactional, button } from '../../lib/email';
import { subscribe } from '../../lib/subscribers';
import { validateEmail, rateLimit, clientIP } from '../../lib/guard';
import { trackView } from '../../lib/tracking';
import { DashLayout } from '../../ui/layout';
import { SiteLayout } from '../../ui/site';
import { Card, Table, Btn, Field, Input, Textarea, Select, Modal, OpenBtn, ActionForm, Status, Empty, back, Help, Badge, Stats, Stat } from '../../ui/components';
import { id, now, form, str, num, esc, truncate, money } from '../../lib/util';
import { pubAdminEmails } from './shared';

const CATEGORIES = ['Business', 'Technology', 'Finance', 'Marketing', 'Health', 'Lifestyle', 'News', 'Politics', 'Science', 'Sports', 'Culture', 'Food', 'Travel', 'Education', 'Crypto', 'Design', 'Other'];

function words(s: string): Set<string> {
  return new Set((s || '').toLowerCase().match(/[a-z]{4,}/g) || []);
}

/** Rank candidate publications for `me`: AI when available, else category + description word overlap. */
export async function suggestPartners(env: any, me: Publication, candidates: Publication[]): Promise<Array<{ pub: Publication; reason: string }>> {
  if (!candidates.length) return [];
  if (aiEnabled(env)) {
    const list = candidates.slice(0, 60).map((p) => ({ id: p.id, name: p.name, category: p.category, description: truncate(p.description, 200) }));
    const r = await aiJSON<Array<{ id: string; reason: string }>>(
      env,
      `My newsletter: "${me.name}" (${me.category || 'uncategorized'}): ${me.description}\n\nCandidates:\n${JSON.stringify(list)}\n\nReturn the 6 best recommendation partners (audiences likely to overlap) as [{"id":"…","reason":"one short sentence"}].`,
      'You match newsletters for cross-recommendation partnerships.',
    );
    if (Array.isArray(r) && r.length) {
      const out = r.map((x) => ({ pub: candidates.find((p) => p.id === x.id)!, reason: String(x.reason || '') })).filter((x) => x.pub);
      if (out.length) return out;
    }
  }
  const mine = words(`${me.name} ${me.description}`);
  return candidates
    .map((p) => {
      let score = p.category && p.category === me.category ? 5 : 0;
      const shared = [...words(`${p.name} ${p.description}`)].filter((w) => mine.has(w));
      score += shared.length;
      return { pub: p, score, reason: p.category && p.category === me.category ? `Same category (${p.category})${shared.length ? ` · shared topics: ${shared.slice(0, 3).join(', ')}` : ''}` : shared.length ? `Shared topics: ${shared.slice(0, 3).join(', ')}` : 'Active publication on the network' };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(({ pub, reason }) => ({ pub, reason }));
}

export function registerRecommendations(dash: App, site: App) {
  dash.get('/recommendations', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const q = str(c.req.query('q'), 80);
    const cat = str(c.req.query('category'), 40);
    const mine = await all<any>(c.env, `SELECT r.*, p.name AS t_name, p.slug AS t_slug, p.description AS t_desc, p.category AS t_cat,
        (SELECT COUNT(*) FROM subscribers s WHERE s.pub_id = r.target_pub_id AND s.source = 'recommendation' AND s.source_detail = r.pub_id) AS attributed,
        (SELECT COUNT(*) FROM recommendations x WHERE x.pub_id = r.target_pub_id AND x.target_pub_id = r.pub_id AND x.status = 'active') AS reciprocated
      FROM recommendations r LEFT JOIN publications p ON p.id = r.target_pub_id WHERE r.pub_id = ? AND r.status != 'ended' ORDER BY r.position, r.created_at`, pub.id);
    const incoming = await all<any>(c.env, `SELECT r.*, p.name, p.slug, p.description, p.id AS from_id,
        (SELECT COUNT(*) FROM subscribers s WHERE s.pub_id = ? AND s.source = 'recommendation' AND s.source_detail = r.pub_id) AS sent_to_me,
        (SELECT COUNT(*) FROM recommendations x WHERE x.pub_id = ? AND x.target_pub_id = r.pub_id AND x.status != 'ended') AS i_recommend
      FROM recommendations r JOIN publications p ON p.id = r.pub_id WHERE r.target_pub_id = ? AND r.status = 'active' ORDER BY r.created_at DESC`, pub.id, pub.id, pub.id);
    const recommendedIds = new Set(mine.map((m) => m.target_pub_id).filter(Boolean));
    const where = ['p.id != ?', `p.status = 'active'`];
    const params: unknown[] = [pub.id];
    if (q) { where.push('(p.name LIKE ? OR p.description LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    if (cat) { where.push('p.category = ?'); params.push(cat); }
    const directory = await all<Publication & { subs: number }>(c.env, `SELECT p.*, (SELECT COUNT(*) FROM subscribers s WHERE s.pub_id = p.id AND s.status = 'active') AS subs FROM publications p WHERE ${where.join(' AND ')} ORDER BY subs DESC, p.created_at DESC LIMIT 60`, ...params);
    const suggestions = c.req.query('suggest') ? await suggestPartners(c.env, pub, directory.filter((d) => !recommendedIds.has(d.id))) : [];
    const totalSent = mine.reduce((n, m) => n + (m.attributed || 0), 0);
    const totalReceived = incoming.reduce((n, m) => n + (m.sent_to_me || 0), 0);

    return c.html(
      <DashLayout c={c} title="Recommendations" section="grow" sub="recommendations" actions={<OpenBtn target="#add-external" kind="secondary">+ External newsletter</OpenBtn>}>
        <Stats>
          <Stat label="You recommend" value={num(mine.filter((m) => m.status === 'active').length)} />
          <Stat label="Subscribers you sent" value={num(totalSent)} />
          <Stat label="Recommending you" value={num(incoming.length)} />
          <Stat label="Subscribers you received" value={num(totalReceived)} />
        </Stats>
        <Card title="Your recommendations" pad={false} actions={<small class="muted">Shown after signup and in the Recommendations post block</small>}>
          <Table rows={mine} empty={<Empty title="No recommendations yet" body="Recommend newsletters your readers will love. It's free, and partners often recommend you back." />} cols={[
            { h: '', r: (m) => <span class="nowrap"><ActionForm action={`/app/grow/recommendations/${m.id}/move`} fields={{ dir: 'up' }} label="↑" kind="ghost" /><ActionForm action={`/app/grow/recommendations/${m.id}/move`} fields={{ dir: 'down' }} label="↓" kind="ghost" /></span> },
            { h: 'Newsletter', r: (m) => <><strong>{m.t_name || m.ext_name}</strong> {m.target_pub_id ? <Badge tone="blue">network</Badge> : <Badge>external</Badge>}{m.reciprocated ? <> <Badge tone="green">reciprocal</Badge></> : null}<div class="muted small">{truncate(m.t_desc || m.ext_description || m.ext_url || '', 90)}</div></> },
            { h: 'Status', r: (m) => <Status s={m.status} /> },
            { h: 'Subscribers sent', class: 'right', r: (m) => (m.target_pub_id ? num(m.attributed) : '—') },
            { h: '', class: 'right nowrap', r: (m) => <>
              {m.status === 'active' ? <ActionForm action={`/app/grow/recommendations/${m.id}/status`} fields={{ status: 'paused' }} label="Pause" /> : <ActionForm action={`/app/grow/recommendations/${m.id}/status`} fields={{ status: 'active' }} label="Resume" />}
              <ActionForm action={`/app/grow/recommendations/${m.id}/status`} fields={{ status: 'ended' }} label="End" kind="danger" confirm="End this recommendation?" />
            </> },
          ]} />
        </Card>
        <Card title="Recommending you" pad={false}>
          <Table rows={incoming} empty="No publications recommend you yet. Recommend others — many reciprocate." cols={[
            { h: 'Publication', r: (r) => <><strong>{r.name}</strong><div class="muted small">{truncate(r.description, 90)}</div></> },
            { h: 'Subscribers sent to you', class: 'right', r: (r) => num(r.sent_to_me) },
            { h: '', class: 'right', r: (r) => r.i_recommend ? <Badge tone="green">You recommend them</Badge> : <ActionForm action="/app/grow/recommendations/add" fields={{ target_pub_id: r.from_id, reciprocal: '1' }} label="Recommend back" kind="primary" /> },
          ]} />
        </Card>
        <Card title="Discover the network" actions={<a class="btn btn-accent btn-sm" href={`/app/grow/recommendations?suggest=1${q ? `&q=${encodeURIComponent(q)}` : ''}`}>✦ Suggest partners{aiEnabled(c.env) ? ' with AI' : ''}</a>}>
          <form class="row" method="get" style="margin-bottom:14px">
            <input class="input grow" name="q" value={q} placeholder="Search newsletters by name or topic" />
            <Select name="category" value={cat} options={[['', 'All categories'], ...CATEGORIES.map((x) => [x, x] as [string, string])]} class="" />
            <Btn kind="secondary">Search</Btn>
          </form>
          {suggestions.length > 0 && (
            <div class="callout warn" style="margin-bottom:14px">
              <strong>Suggested partners</strong>
              <ul class="list-plain">{suggestions.map((s) => <li class="row between"><span><strong>{s.pub.name}</strong> <small class="muted">— {s.reason}</small></span><ActionForm action="/app/grow/recommendations/add" fields={{ target_pub_id: s.pub.id }} label="Recommend" kind="primary" /></li>)}</ul>
            </div>
          )}
          <Table rows={directory} empty="No other publications match. Invite fellow writers to the network!" cols={[
            { h: 'Newsletter', r: (p) => <><strong>{p.name}</strong> {p.category && <Badge>{p.category}</Badge>}<div class="muted small">{truncate(p.description, 110)}</div></> },
            { h: 'Subscribers', class: 'right', r: (p) => num(p.subs) },
            { h: '', class: 'right nowrap', r: (p) => <><a class="btn btn-ghost btn-sm" href={siteUrl(c.env, p)} target="_blank">View</a>{recommendedIds.has(p.id) ? <Badge tone="green">Recommended</Badge> : <ActionForm action="/app/grow/recommendations/add" fields={{ target_pub_id: p.id }} label="Recommend" kind="primary" />}</> },
          ]} />
        </Card>
        <Modal id="add-external" title="Recommend an external newsletter">
          <form method="post" action="/app/grow/recommendations/add">
            <Field label="Name"><Input name="ext_name" required /></Field>
            <Field label="Subscribe URL"><Input name="ext_url" type="url" required placeholder="https://…" /></Field>
            <Field label="Why you recommend it"><Textarea name="ext_description" rows={2} /></Field>
            <Field label="Logo URL"><Input name="ext_logo" /></Field>
            <Help>External newsletters appear as links (no one-click subscribe or attribution).</Help>
            <div class="form-actions"><Btn>Add</Btn></div>
          </form>
        </Modal>
      </DashLayout>,
    );
  });

  dash.post('/recommendations/add', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const f = await form(c.req);
    const pos = (await val<number>(c.env, 'SELECT COALESCE(MAX(position), 0) FROM recommendations WHERE pub_id = ?', pub.id)) + 1;
    if (f.target_pub_id) {
      const target = await getPub(c.env, f.target_pub_id);
      if (!target || target.id === pub.id) return back(c, '/app/grow/recommendations', 'Publication not found', 'err');
      const existing = await one<any>(c.env, 'SELECT id, status FROM recommendations WHERE pub_id = ? AND target_pub_id = ?', pub.id, target.id);
      const reciprocal = !!(await one(c.env, `SELECT 1 FROM recommendations WHERE pub_id = ? AND target_pub_id = ? AND status = 'active'`, target.id, pub.id));
      if (existing) await run(c.env, `UPDATE recommendations SET status = 'active', reciprocal = ? WHERE id = ?`, reciprocal ? 1 : 0, existing.id);
      else await insert(c.env, 'recommendations', { id: id(), pub_id: pub.id, target_pub_id: target.id, reciprocal: reciprocal ? 1 : 0, status: 'active', position: pos, created_at: now() });
      if (reciprocal) await run(c.env, 'UPDATE recommendations SET reciprocal = 1 WHERE pub_id = ? AND target_pub_id = ?', target.id, pub.id);
      // notify the partner with a one-click reciprocate link
      const emails = await pubAdminEmails(c.env, target);
      for (const e of emails)
        await sendTransactional(c.env, e, `${pub.name} now recommends ${target.name}`, `<p><strong>${esc(pub.name)}</strong> just added <strong>${esc(target.name)}</strong> to their recommendations. Their readers can now subscribe to you in one click after signing up.</p>${reciprocal ? '<p>You already recommend them — this is now a reciprocal partnership. 🎉</p>' : `<p>Want to return the favor? Recommend them back in one click:</p>${button('Recommend ' + pub.name, appUrl(c.env, `/app/grow/recommendations?pub=${target.id}`))}`}`, target);
      await audit(c, 'recommendation.add', target.id);
      return back(c, '/app/grow/recommendations', `You now recommend ${target.name}${reciprocal ? ' (reciprocal)' : ''}`);
    }
    const name = str(f.ext_name, 120), url = str(f.ext_url, 500);
    if (!name || !/^https?:\/\//.test(url)) return back(c, '/app/grow/recommendations', 'Name and a valid URL are required', 'err');
    await insert(c.env, 'recommendations', { id: id(), pub_id: pub.id, ext_name: name, ext_url: url, ext_description: str(f.ext_description, 300), ext_logo: str(f.ext_logo, 500) || null, status: 'active', position: pos, created_at: now() });
    return back(c, '/app/grow/recommendations', 'External recommendation added');
  });

  dash.post('/recommendations/:id/status', requirePerm('manage'), async (c) => {
    const f = await form(c.req);
    const status = ['active', 'paused', 'ended'].includes(f.status) ? f.status : 'paused';
    const rec = await one<any>(c.env, 'SELECT * FROM recommendations WHERE id = ? AND pub_id = ?', c.req.param('id'), c.get('pub').id);
    if (!rec) return back(c, '/app/grow/recommendations', 'Not found', 'err');
    await run(c.env, 'UPDATE recommendations SET status = ? WHERE id = ?', status, rec.id);
    if (rec.target_pub_id && status !== 'active') await run(c.env, 'UPDATE recommendations SET reciprocal = 0 WHERE pub_id = ? AND target_pub_id = ?', rec.target_pub_id, rec.pub_id);
    return back(c, '/app/grow/recommendations', `Recommendation ${status === 'active' ? 'resumed' : status}`);
  });

  dash.post('/recommendations/:id/move', requirePerm('manage'), async (c) => {
    const pub = c.get('pub');
    const dir = (await form(c.req)).dir === 'up' ? -1 : 1;
    const rows = await all<any>(c.env, `SELECT id FROM recommendations WHERE pub_id = ? AND status != 'ended' ORDER BY position, created_at`, pub.id);
    const i = rows.findIndex((r) => r.id === c.req.param('id'));
    const j = i + dir;
    if (i >= 0 && j >= 0 && j < rows.length) [rows[i], rows[j]] = [rows[j], rows[i]];
    for (let k = 0; k < rows.length; k++) await run(c.env, 'UPDATE recommendations SET position = ? WHERE id = ?', k, rows[k].id);
    return back(c, '/app/grow/recommendations');
  });

  // ── Signup flow: "You might also like" with one-click subscribes (free recs + paid boosts)
  async function recsFor(env: any, pubId: string) {
    const free = await all<any>(env, `SELECT r.id, r.target_pub_id, r.ext_name, r.ext_url, r.ext_description, r.ext_logo, p.name, p.description, p.logo_url, p.slug FROM recommendations r LEFT JOIN publications p ON p.id = r.target_pub_id WHERE r.pub_id = ? AND r.status = 'active' ORDER BY r.position LIMIT 12`, pubId);
    const paid = await all<any>(env, `SELECT bp.id AS partner_id, o.id AS offer_id, p.id AS target_pub_id, p.name, p.description, p.logo_url, p.slug FROM boost_partners bp JOIN boost_offers o ON o.id = bp.offer_id JOIN publications p ON p.id = o.pub_id
      WHERE bp.partner_pub_id = ? AND bp.status = 'active' AND o.status = 'active' AND (o.budget_cents = 0 OR o.spent_cents + o.cpa_cents <= o.budget_cents) LIMIT 6`, pubId);
    const seen = new Set(free.map((f) => f.target_pub_id).filter(Boolean));
    return { free, paid: paid.filter((p) => !seen.has(p.target_pub_id)) };
  }

  site.get('/recommendations', async (c) => {
    const pub = c.get('pub');
    await trackView(c, 'recommendations');
    const reader = c.get('reader');
    const email = reader?.email || str(c.req.query('email'), 254);
    const { free, paid } = await recsFor(c.env, pub.id);
    const base = siteUrl(c.env, pub);
    const next = str(c.req.query('next'), 300) || base + '/';
    const items = [
      ...paid.map((p) => ({ value: `b:${p.partner_id}`, name: p.name, desc: p.description, logo: p.logo_url, ext: null as string | null })),
      ...free.map((f) => ({ value: f.target_pub_id ? `r:${f.id}` : '', name: f.name || f.ext_name, desc: f.description || f.ext_description, logo: f.logo_url || f.ext_logo, ext: f.target_pub_id ? null : f.ext_url })),
    ];
    return c.html(
      await SiteLayout({
        c, title: 'Recommended newsletters', noindex: true,
        children: (
          <section class="s-wrap s-narrow" style="padding:48px 20px">
            <h1>{email ? "You're subscribed! 🎉" : 'Newsletters we recommend'}</h1>
            <p class="s-muted">{pub.name} recommends these newsletters. {email ? 'Pick any to subscribe in one click.' : ''}</p>
            {!items.length ? <p><a class="s-btn" href={next}>Continue to {pub.name}</a></p> : (
              <form method="post" action={base + '/recommendations'} class="s-stack">
                <input type="hidden" name="next" value={next} />
                {items.map((it) => (
                  <label class="s-box" style="display:flex;gap:14px;align-items:center;cursor:pointer">
                    {it.ext ? <span style="width:20px" /> : <input type="checkbox" name="pick[]" value={it.value} checked style="width:20px;height:20px" />}
                    {it.logo ? <img src={it.logo} alt="" style="width:44px;height:44px;border-radius:10px;object-fit:cover" /> : <span style="width:44px;height:44px;border-radius:10px;background:var(--accent);display:grid;place-items:center;font-weight:800">{(it.name || '?').slice(0, 1)}</span>}
                    <span style="flex:1"><strong>{it.name}</strong><span class="s-muted s-small" style="display:block">{truncate(it.desc || '', 140)}</span></span>
                    {it.ext && <a class="s-btn s-btn-ghost" href={it.ext} target="_blank" rel="noopener">Visit</a>}
                  </label>
                ))}
                {email ? <input type="hidden" name="email" value={email} /> : <input class="s-input" type="email" name="email" placeholder="you@example.com" required style="width:100%" />}
                <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="s-btn">Subscribe to selected</button><a class="s-btn s-btn-ghost" href={next}>Skip</a></div>
              </form>
            )}
          </section>
        ),
      }),
    );
  });

  site.post('/recommendations', async (c) => {
    const pub = c.get('pub');
    const f = await form(c.req);
    const base = siteUrl(c.env, pub);
    const next = str(f.next, 300) || base + '/';
    if (!(await rateLimit(c.env, `recs:${clientIP(c.req.raw)}`, 20, 600))) return c.text('Too many requests', 429);
    const v = await validateEmail(str(f.email, 254));
    if (!v.ok) return back(c, base + '/recommendations', v.reason || 'Invalid email', 'err');
    const picks: string[] = f.pick || [];
    let count = 0;
    for (const p of picks.slice(0, 12)) {
      const [kind, ref] = p.split(':');
      if (kind === 'r') {
        const rec = await one<any>(c.env, `SELECT * FROM recommendations WHERE id = ? AND pub_id = ? AND status = 'active' AND target_pub_id IS NOT NULL`, ref, pub.id);
        const target = rec && (await getPub(c.env, rec.target_pub_id));
        if (!target) continue;
        const r = await subscribe(c.env, target, { email: v.email, source: 'recommendation', sourceDetail: pub.id, ip: clientIP(c.req.raw), country: (c.req.raw as any).cf?.country ?? null, referrer: base });
        if (r.ok && r.created) { await run(c.env, 'UPDATE recommendations SET subscribers_sent = subscribers_sent + 1 WHERE id = ?', rec.id); count++; }
      } else if (kind === 'b') {
        const bp = await one<any>(c.env, `SELECT bp.*, o.pub_id AS adv_pub_id FROM boost_partners bp JOIN boost_offers o ON o.id = bp.offer_id WHERE bp.id = ? AND bp.partner_pub_id = ? AND bp.status = 'active' AND o.status = 'active'`, ref, pub.id);
        const target = bp && (await getPub(c.env, bp.adv_pub_id));
        if (!target) continue;
        const r = await subscribe(c.env, target, { email: v.email, source: 'boost', sourceDetail: bp.id, ip: clientIP(c.req.raw), country: (c.req.raw as any).cf?.country ?? null, referrer: base });
        if (r.ok && r.created) count++;
      }
    }
    return back(c, next, count ? `Subscribed to ${count} newsletter${count === 1 ? '' : 's'}` : undefined);
  });
}

export { CATEGORIES };
