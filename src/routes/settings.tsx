/** @jsxImportSource hono/jsx */
// Module: settings — publication, team & roles, authors, email & senders, domains, integrations,
// API keys, webhooks, payments/billing & exports, workspace, audit log, profile.
import { Hono } from 'hono';
import type { AppEnv, Module, Publication, User } from '../types';
import { one, all, run, insert, val } from '../lib/db';
import { requirePerm, can, audit, hashPassword, verifyPassword, SESSION_COOKIE } from '../lib/auth';
import { settings } from '../lib/pub';
import { storeFile } from '../lib/media';
import { sendTransactional, button } from '../lib/email';
import { validateEmail } from '../lib/guard';
import { id, now, token, sha256, slugify, esc, form, str, int, bool, ago, fmtDateTime, parseJSON, DAY } from '../lib/util';
import { Card, Field, Input, Textarea, Select, Toggle, Btn, ActionForm, Table, Badge, Status, Empty, Modal, OpenBtn, Grid, Help, back, flash } from '../ui/components';
import { getCookie } from 'hono/cookie';
import { page, saveSettings, ROLES } from './settings/ui';
import { registerEmail } from './settings/email';
import { registerDomains } from './settings/domains';
import { registerDevelopers } from './settings/developers';
import { registerAccount } from './settings/account';
import { registerMonitoring } from './settings/monitoring';
import '../lib/domains';
import '../lib/integrations';

const dash = new Hono<AppEnv>();

const LANGS: Array<[string, string]> = [['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['it', 'Italian'], ['nl', 'Dutch'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['ja', 'Japanese'], ['zh', 'Chinese']];
const TZS = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Africa/Cairo', 'Asia/Riyadh', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];
const CATEGORIES = ['Technology', 'Business', 'Finance', 'Marketing', 'Culture', 'Politics', 'Health', 'Science', 'Sports', 'Food', 'Travel', 'Education', 'Lifestyle', 'Arts', 'News', 'Other'];

// ───────────────────────── Publication ─────────────────────────
dash.get('/', async (c) => {
  const role = c.get('role');
  if (!can(role, 'manage')) return c.redirect('/app/settings/profile');
  const pub = c.get('pub');
  const s = settings(pub);
  const surveys = await all<{ id: string; title: string }>(c.env, 'SELECT id, title FROM surveys WHERE pub_id = ? ORDER BY created_at DESC', pub.id);
  const admin = can(role, 'admin');
  return page(c, 'publication', 'Publication settings', (
    <form method="post" enctype="multipart/form-data">
      <Card title="Basics">
        <Grid>
          <Field label="Name"><Input name="name" value={pub.name} required maxlength={100} /></Field>
          <Field label="URL slug" hint={`/s/${pub.slug} — changing it breaks old links unless you add redirects.`}><Input name="slug" value={pub.slug} pattern="[a-z0-9-]{2,60}" required /></Field>
        </Grid>
        <Field label="Description"><Textarea name="description" value={pub.description} rows={2} /></Field>
        <Grid cols={3}>
          <Field label="Category"><Select name="category" options={CATEGORIES} value={pub.category || 'Other'} /></Field>
          <Field label="Language"><Select name="language" options={LANGS} value={pub.language} /></Field>
          <Field label="Timezone"><Select name="timezone" options={TZS.includes(pub.timezone) ? TZS : [pub.timezone, ...TZS]} value={pub.timezone} /></Field>
        </Grid>
        <Grid>
          <Field label="Logo" hint="Square image, at least 256×256.">
            <div class="row">{pub.logo_url && <img src={pub.logo_url} class="thumb" alt="" />}<input type="file" name="logo" accept="image/*" class="input" /></div>
          </Field>
          <Field label="Favicon" hint="Optional; the logo is used if empty.">
            <div class="row">{pub.favicon_url && <img src={pub.favicon_url} class="thumb" alt="" />}<input type="file" name="favicon" accept="image/*" class="input" /></div>
          </Field>
        </Grid>
      </Card>
      <Card title="Email">
        <Grid>
          <Field label="From name"><Input name="from_name" value={pub.from_name} placeholder={pub.name} /></Field>
          <Field label="Reply-to address" hint="Replies to your newsletter go here."><Input name="reply_to" type="email" value={pub.reply_to} /></Field>
        </Grid>
        <Field label="Postal address" hint="Required by CAN-SPAM; shown in every email footer."><Input name="address" value={pub.address} /></Field>
        <Field label="Email footer (HTML)" hint="Added to the bottom of every newsletter and automation email."><Textarea name="footer_html" value={pub.footer_html} rows={3} /></Field>
        <Toggle name="double_opt_in" checked={!!s.double_opt_in} label="Double opt-in" hint="New subscribers must confirm by email before they receive anything." />
        <Toggle name="welcome_email" checked={s.welcome_email !== false} label="Welcome email" hint="Triggers your welcome automation when someone subscribes." />
        <Toggle name="utm_tracking" checked={s.utm_tracking !== false} label="Add UTM parameters to links in emails" hint="utm_source=<slug>&utm_medium=newsletter&utm_campaign=<post>" />
        <Grid>
          <Field label="Custom link parameters" hint="Appended to every link in your emails. Placeholders: {pub} {post}"><Input name="link_params" value={s.link_params} placeholder="ref={pub}&issue={post}" /></Field>
          <Field label="Max send rate (emails/minute)" hint="Leave blank for the platform default."><Input name="send_rate_per_minute" type="number" min={50} value={s.send_rate_per_minute ?? ''} /></Field>
        </Grid>
      </Card>
      <Card title="Signups & readers">
        <Grid>
          <Field label="Redirect after signup" hint="Send new subscribers to this URL (e.g. your site). Blank = thank-you page."><Input name="redirect_after_signup" value={s.redirect_after_signup} placeholder="https://" /></Field>
          <Field label="Signup survey" hint="Ask new subscribers a few questions right after they subscribe.">
            <Select name="signup_survey_id" value={s.signup_survey_id || ''} options={[['', 'None'], ...surveys.map((x) => [x.id, x.title] as [string, string])]} />
          </Field>
        </Grid>
        <Grid>
          <Field label="Comments on posts"><Select name="comments" value={s.comments || 'subscribers'} options={[['off', 'Off'], ['subscribers', 'Subscribers can comment'], ['premium', 'Premium subscribers only']]} /></Field>
          <Field label="Blocked email domains" hint="Comma-separated, in addition to the built-in disposable list."><Input name="blocked_domains" value={(s.blocked_domains || []).join(', ')} placeholder="competitor.com, spam.io" /></Field>
        </Grid>
        <Field label="Google Analytics measurement ID" hint="Adds GA4 to your website."><Input name="ga_measurement_id" value={s.ga_measurement_id} placeholder="G-XXXXXXXXXX" /></Field>
      </Card>
      <div class="form-actions">{admin && <a class="btn btn-ghost" href="/app/settings/danger">Delete publication…</a>}<Btn>Save settings</Btn></div>
    </form>
  ));
});

dash.post('/', requirePerm('manage'), async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const name = str(f.name, 100);
  if (!name) return back(c, '/app/settings', 'Name is required.', 'err');
  let slug = slugify(str(f.slug) || pub.slug, 60);
  if (slug !== pub.slug && (await one(c.env, 'SELECT 1 FROM publications WHERE slug = ? AND id != ?', slug, pub.id))) return back(c, '/app/settings', `The URL "${slug}" is taken.`, 'err');
  const reply = str(f.reply_to, 254);
  if (reply) {
    const v = await validateEmail(reply);
    if (!v.ok) return back(c, '/app/settings', 'Reply-to: ' + v.reason, 'err');
  }
  const user = c.get('user');
  let logo = pub.logo_url, favicon = pub.favicon_url;
  try {
    if (f.logo instanceof File && f.logo.size) logo = (await storeFile(c.env, pub.id, f.logo, { folder: 'brand', userId: user.id })).url;
    if (f.favicon instanceof File && f.favicon.size) favicon = (await storeFile(c.env, pub.id, f.favicon, { folder: 'brand', userId: user.id })).url;
  } catch (e: any) {
    return back(c, '/app/settings', 'Upload failed: ' + e.message, 'err');
  }
  await run(
    c.env,
    `UPDATE publications SET name = ?, slug = ?, description = ?, category = ?, language = ?, timezone = ?, logo_url = ?, favicon_url = ?, from_name = ?, reply_to = ?, address = ?, footer_html = ? WHERE id = ?`,
    name, slug, str(f.description, 500), str(f.category, 40), str(f.language, 8) || 'en', str(f.timezone, 60) || 'UTC', logo, favicon, str(f.from_name, 100) || null, reply || null, str(f.address, 300), str(f.footer_html, 5000), pub.id,
  );
  const rate = int(f.send_rate_per_minute, 0);
  await saveSettings(c, {
    double_opt_in: bool(f.double_opt_in), welcome_email: bool(f.welcome_email), utm_tracking: bool(f.utm_tracking), link_params: str(f.link_params, 300) || undefined,
    send_rate_per_minute: rate > 0 ? rate : undefined, redirect_after_signup: str(f.redirect_after_signup, 500) || undefined, signup_survey_id: str(f.signup_survey_id) || undefined,
    comments: (['off', 'subscribers', 'premium'].includes(f.comments) ? f.comments : 'subscribers'),
    blocked_domains: str(f.blocked_domains, 2000).split(/[\s,]+/).map((d) => d.toLowerCase().replace(/^@/, '')).filter(Boolean),
    ga_measurement_id: str(f.ga_measurement_id, 40) || undefined,
  });
  await audit(c, 'settings.publication_updated', pub.id);
  return back(c, '/app/settings', 'Settings saved');
});

dash.get('/danger', requirePerm('admin'), (c) => {
  const pub = c.get('pub');
  return page(c, 'publication', 'Delete publication', (
    <Card title="Delete this publication" class="callout danger">
      <p>This permanently removes <strong>{pub.name}</strong>: posts, subscribers, automations, analytics and its website. This cannot be undone. Export your data first from <a href="/app/settings/billing">Payments & exports</a>.</p>
      {c.get('role') === 'owner' ? (
        <form method="post" class="stack">
          <Field label={`Type "${pub.name}" to confirm`}><Input name="confirm" required /></Field>
          <Btn kind="danger">Delete forever</Btn>
        </form>
      ) : <p class="muted">Only the owner can delete a publication.</p>}
    </Card>
  ));
});

dash.post('/danger', requirePerm('admin'), async (c) => {
  const pub = c.get('pub');
  if (c.get('role') !== 'owner') return back(c, '/app/settings/danger', 'Only the owner can delete a publication.', 'err');
  const f = await form(c.req);
  if (str(f.confirm) !== pub.name) return back(c, '/app/settings/danger', 'The name did not match.', 'err');
  await audit(c, 'publication.deleted', pub.id, { name: pub.name });
  await run(c.env, 'DELETE FROM publications WHERE id = ?', pub.id);
  await run(c.env, 'DELETE FROM memberships WHERE pub_id = ?', pub.id);
  flash(c, `${pub.name} was deleted.`);
  return c.redirect('/app', 303);
});

// ───────────────────────── Team ─────────────────────────
interface MemberRow { user_id: string; email: string; name: string; role: string; pub_id: string; created_at: number; last_seen: number | null }

dash.get('/team', requirePerm('admin'), async (c) => {
  const pub = c.get('pub');
  const members = await all<MemberRow>(
    c.env,
    `SELECT m.user_id, u.email, u.name, m.role, m.pub_id, m.created_at, (SELECT MAX(created_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen
     FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE (m.pub_id = ?) OR (m.pub_id = '' AND m.workspace_id = ?) ORDER BY m.role = 'owner' DESC, u.name`,
    pub.id, pub.workspace_id,
  );
  const invites = await all<any>(c.env, `SELECT * FROM invites WHERE workspace_id = ? AND (pub_id = '' OR pub_id = ?) AND accepted_at IS NULL ORDER BY created_at DESC`, pub.workspace_id, pub.id);
  const me = c.get('user');
  return page(c, 'team', 'Team', (
    <>
      <Card title="Members" actions={<OpenBtn target="#invite" small>Invite teammate</OpenBtn>} pad={false}>
        <Table<MemberRow>
          rows={members}
          cols={[
            { h: 'Person', r: (m) => <><strong>{m.name || m.email}</strong><div class="muted small">{m.email}</div></> },
            { h: 'Access', r: (m) => <Badge tone={m.pub_id ? 'blue' : 'purple'}>{m.pub_id ? 'This publication' : 'Whole workspace'}</Badge> },
            { h: 'Role', r: (m) => m.role === 'owner' ? <Badge tone="amber">owner</Badge> : (
              <form method="post" action="/app/settings/team/role" class="inline-form">
                <input type="hidden" name="user_id" value={m.user_id} /><input type="hidden" name="scope" value={m.pub_id ? 'pub' : 'workspace'} />
                <Select name="role" value={m.role} options={[['admin', 'Admin'], ['member', 'Member'], ['contributor', 'Contributor']]} autosubmit />
              </form>
            ) },
            { h: 'Last active', r: (m) => <span class="muted">{ago(m.last_seen)}</span> },
            { h: '', class: 'right', r: (m) => m.role === 'owner' || m.user_id === me.id ? null : <ActionForm action="/app/settings/team/remove" fields={{ user_id: m.user_id, scope: m.pub_id ? 'pub' : 'workspace' }} label="Remove access" kind="danger" confirm={`Remove ${m.email}? They lose access immediately.`} /> },
          ]}
        />
      </Card>
      <Card title="Pending invites" pad={false}>
        <Table
          rows={invites}
          empty="No pending invites."
          cols={[
            { h: 'Email', r: (i: any) => i.email },
            { h: 'Role', r: (i: any) => <Badge>{i.role}</Badge> },
            { h: 'Scope', r: (i: any) => (i.pub_id ? 'This publication' : 'Workspace') },
            { h: 'Sent', r: (i: any) => <span class="muted">{ago(i.created_at)}</span> },
            { h: '', class: 'right', r: (i: any) => <div class="row end"><ActionForm action={`/app/settings/team/invites/${i.id}/resend`} label="Resend" /><ActionForm action={`/app/settings/team/invites/${i.id}/revoke`} label="Revoke" kind="danger" /></div> },
          ]}
        />
      </Card>
      <Card title="Roles">
        <ul class="list-plain">
          <li><strong>Owner</strong> — everything, including deleting or transferring the publication.</li>
          {ROLES.map(([k, l]) => <li><strong>{k[0].toUpperCase() + k.slice(1)}</strong> — {l.split('— ')[1]}</li>)}
        </ul>
        <Help>Workspace-level roles apply to every publication in the workspace; publication-level roles apply only here and override the workspace role.</Help>
      </Card>
      <Modal id="invite" title="Invite a teammate">
        <form method="post" action="/app/settings/team/invite" class="stack">
          <Field label="Email"><Input name="email" type="email" required autofocus /></Field>
          <Field label="Role"><Select name="role" options={ROLES} value="member" /></Field>
          <Field label="Access"><Select name="scope" options={[['pub', `Only ${pub.name}`], ['workspace', 'Every publication in this workspace']]} value="pub" /></Field>
          <div class="form-actions"><Btn>Send invite</Btn></div>
        </form>
      </Modal>
    </>
  ));
});

async function sendInvite(c: any, inv: { id: string; email: string; role: string; pub_id: string }, tok: string) {
  const pub: Publication = c.get('pub');
  const user: User = c.get('user');
  const target = inv.pub_id ? pub.name : (await one<{ name: string }>(c.env, 'SELECT name FROM workspaces WHERE id = ?', pub.workspace_id))?.name || 'the workspace';
  await sendTransactional(c.env, inv.email, `${user.name || user.email} invited you to ${target}`, `<p><strong>${esc(user.name || user.email)}</strong> invited you to join <strong>${esc(target)}</strong> on ${esc(c.env.APP_NAME)} as <strong>${esc(inv.role)}</strong>.</p>${button('Accept invite', `${c.env.APP_URL.replace(/\/$/, '')}/invite/${tok}`)}<p style="color:#6b7280;font-size:13px">This invite expires in 14 days.</p>`);
}

dash.post('/team/invite', requirePerm('admin'), async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const v = await validateEmail(str(f.email));
  if (!v.ok) return back(c, '/app/settings/team', v.reason, 'err');
  const role = ['admin', 'member', 'contributor'].includes(f.role) ? f.role : 'member';
  const scope = f.scope === 'workspace' ? '' : pub.id;
  if (scope === '' && c.get('role') !== 'owner' && role === 'admin') {
    // admins can't mint workspace-wide admins unless they own the workspace
    const wsRole = await one<any>(c.env, `SELECT role FROM memberships WHERE workspace_id = ? AND pub_id = '' AND user_id = ?`, pub.workspace_id, c.get('user').id);
    if (wsRole?.role !== 'owner' && wsRole?.role !== 'admin') return back(c, '/app/settings/team', 'Only workspace admins can invite workspace-wide admins.', 'err');
  }
  const already = await one(c.env, `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ? AND (m.pub_id = ? OR (m.pub_id = '' AND m.workspace_id = ?))`, v.email, pub.id, pub.workspace_id);
  if (already) return back(c, '/app/settings/team', `${v.email} already has access.`, 'err');
  await run(c.env, `DELETE FROM invites WHERE workspace_id = ? AND pub_id = ? AND email = ? AND accepted_at IS NULL`, pub.workspace_id, scope, v.email);
  const tok = token(24);
  const inv = { id: id(), workspace_id: pub.workspace_id, pub_id: scope, email: v.email, role, token_hash: await sha256(tok), invited_by: c.get('user').id, created_at: now() };
  await insert(c.env, 'invites', inv);
  await sendInvite(c, inv, tok);
  await audit(c, 'team.invited', v.email, { role, scope: scope ? 'publication' : 'workspace' });
  return back(c, '/app/settings/team', `Invite sent to ${v.email}`);
});

dash.post('/team/invites/:id/resend', requirePerm('admin'), async (c) => {
  const pub = c.get('pub');
  const inv = await one<any>(c.env, `SELECT * FROM invites WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL`, c.req.param('id'), pub.workspace_id);
  if (!inv) return back(c, '/app/settings/team', 'Invite not found.', 'err');
  const tok = token(24);
  await run(c.env, 'UPDATE invites SET token_hash = ?, created_at = ? WHERE id = ?', await sha256(tok), now(), inv.id);
  await sendInvite(c, inv, tok);
  return back(c, '/app/settings/team', `Invite re-sent to ${inv.email}`);
});

dash.post('/team/invites/:id/revoke', requirePerm('admin'), async (c) => {
  await run(c.env, 'DELETE FROM invites WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL', c.req.param('id'), c.get('pub').workspace_id);
  await audit(c, 'team.invite_revoked', c.req.param('id'));
  return back(c, '/app/settings/team', 'Invite revoked');
});

dash.post('/team/role', requirePerm('admin'), async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const role = ['admin', 'member', 'contributor'].includes(f.role) ? f.role : null;
  if (!role) return back(c, '/app/settings/team', 'Invalid role.', 'err');
  const scope = f.scope === 'workspace' ? '' : pub.id;
  const r = await run(c.env, `UPDATE memberships SET role = ? WHERE workspace_id = ? AND pub_id = ? AND user_id = ? AND role != 'owner'`, role, pub.workspace_id, scope, str(f.user_id));
  if (!r.meta.changes) return back(c, '/app/settings/team', 'Could not change that role.', 'err');
  await audit(c, 'team.role_changed', str(f.user_id), { role, scope: scope ? 'publication' : 'workspace' });
  return back(c, '/app/settings/team', 'Role updated');
});

dash.post('/team/remove', requirePerm('admin'), async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const uid = str(f.user_id);
  if (uid === c.get('user').id) return back(c, '/app/settings/team', "You can't remove yourself.", 'err');
  const scope = f.scope === 'workspace' ? '' : pub.id;
  const r = await run(c.env, `DELETE FROM memberships WHERE workspace_id = ? AND pub_id = ? AND user_id = ? AND role != 'owner'`, pub.workspace_id, scope, uid);
  if (!r.meta.changes) return back(c, '/app/settings/team', 'Could not remove that member.', 'err');
  // also drop any pub-level override for this pub so access is gone immediately
  if (scope === '') await run(c.env, `DELETE FROM memberships WHERE pub_id IN (SELECT id FROM publications WHERE workspace_id = ?) AND user_id = ? AND role != 'owner'`, pub.workspace_id, uid);
  else await run(c.env, `DELETE FROM memberships WHERE pub_id = ? AND user_id = ? AND role != 'owner'`, pub.id, uid);
  const left = await val<number>(c.env, 'SELECT COUNT(*) FROM memberships WHERE user_id = ?', uid);
  if (!left) await run(c.env, 'DELETE FROM sessions WHERE user_id = ?', uid);
  await audit(c, 'team.removed', uid, { scope: scope ? 'publication' : 'workspace' });
  return back(c, '/app/settings/team', 'Access removed');
});

// ───────────────────────── Authors ─────────────────────────
const SOCIALS = ['website', 'x', 'linkedin', 'instagram', 'bluesky', 'youtube', 'tiktok', 'github'];

dash.get('/authors', requirePerm('manage'), async (c) => {
  const pub = c.get('pub');
  const authors = await all<User & { kind: string }>(
    c.env,
    `SELECT DISTINCT u.*, CASE WHEN u.is_guest = 1 THEN 'guest' ELSE 'team' END AS kind FROM users u
     WHERE u.id IN (SELECT user_id FROM memberships WHERE pub_id = ? OR (pub_id = '' AND workspace_id = ?)) OR u.id IN (SELECT user_id FROM pub_authors WHERE pub_id = ?)
     ORDER BY u.is_guest, u.name`,
    pub.id, pub.workspace_id, pub.id,
  );
  const posts = await all<{ user_id: string; n: number }>(c.env, `SELECT pa.user_id, COUNT(*) AS n FROM post_authors pa JOIN posts p ON p.id = pa.post_id WHERE p.pub_id = ? GROUP BY pa.user_id`, pub.id);
  const count = (uid: string) => posts.find((p) => p.user_id === uid)?.n || 0;
  return page(c, 'authors', 'Authors', (
    <>
      <Help>Authors appear in post bylines and on author pages on your website. Add guest authors for one-off contributors — they don't get a login.</Help>
      <Card title="Authors" actions={<OpenBtn target="#guest" small>Add guest author</OpenBtn>} pad={false}>
        <Table
          rows={authors}
          cols={[
            { h: 'Author', r: (u) => <div class="row">{u.avatar_url ? <img src={u.avatar_url} class="thumb" style="border-radius:50%" alt="" /> : <span class="avatar">{(u.name || u.email)[0].toUpperCase()}</span>}<div><strong>{u.name || u.email}</strong><div class="muted small">{u.is_guest ? 'Guest author' : u.email}</div></div></div> },
            { h: 'Bio', r: (u) => <span class="muted truncate">{u.bio || '—'}</span> },
            { h: 'Posts', r: (u) => count(u.id) },
            { h: '', class: 'right', r: (u) => <div class="row end"><OpenBtn target={`#a-${u.id}`} kind="secondary" small>Edit</OpenBtn>{u.is_guest ? <ActionForm action={`/app/settings/authors/${u.id}/delete`} label="Remove" kind="danger" confirm="Remove this guest author from the publication?" /> : null}</div> },
          ]}
        />
      </Card>
      {authors.map((u) => (
        <Modal id={`a-${u.id}`} title={`Edit ${u.name || u.email}`}>
          <AuthorForm u={u} action={`/app/settings/authors/${u.id}`} />
        </Modal>
      ))}
      <Modal id="guest" title="Add guest author"><AuthorForm action="/app/settings/authors/new" guest /></Modal>
    </>
  ));
});

const AuthorForm = (p: { u?: User; action: string; guest?: boolean }) => {
  const s = parseJSON<Record<string, string>>(p.u?.socials, {});
  return (
    <form method="post" action={p.action} enctype="multipart/form-data" class="stack">
      <Field label="Name"><Input name="name" value={p.u?.name} required /></Field>
      {p.guest && <Field label="Email (optional)" hint="Lets them claim the profile later by signing up with this email."><Input name="email" type="email" /></Field>}
      <Field label="Bio"><Textarea name="bio" value={p.u?.bio} rows={3} /></Field>
      <Field label="Avatar"><div class="row">{p.u?.avatar_url && <img src={p.u.avatar_url} class="thumb" alt="" />}<input type="file" name="avatar" accept="image/*" class="input" /></div></Field>
      <Grid>{SOCIALS.map((k) => <Field label={k === 'x' ? 'X / Twitter' : k[0].toUpperCase() + k.slice(1)}><Input name={`social_${k}`} value={s[k]} placeholder="https://" /></Field>)}</Grid>
      <div class="form-actions"><Btn>Save</Btn></div>
    </form>
  );
};

function socialsFrom(f: Record<string, any>) {
  const out: Record<string, string> = {};
  for (const k of SOCIALS) { const v = str(f[`social_${k}`], 300); if (v) out[k] = v; }
  return JSON.stringify(out);
}

dash.post('/authors/new', requirePerm('manage'), async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const name = str(f.name, 120);
  if (!name) return back(c, '/app/settings/authors', 'Name is required.', 'err');
  let email = str(f.email, 254).toLowerCase();
  if (email) {
    const v = await validateEmail(email);
    if (!v.ok) return back(c, '/app/settings/authors', v.reason, 'err');
    const existing = await one<User>(c.env, 'SELECT * FROM users WHERE email = ?', v.email);
    if (existing) {
      await run(c.env, 'INSERT OR IGNORE INTO pub_authors (pub_id, user_id, created_at) VALUES (?, ?, ?)', pub.id, existing.id, now());
      return back(c, '/app/settings/authors', `${existing.name || existing.email} added as an author`);
    }
  } else email = `guest-${id(10)}@guest.openhive.invalid`;
  const uid = id();
  let avatar: string | null = null;
  if (f.avatar instanceof File && f.avatar.size) avatar = (await storeFile(c.env, pub.id, f.avatar, { folder: 'authors' })).url;
  await insert(c.env, 'users', { id: uid, email, name, bio: str(f.bio, 2000), avatar_url: avatar, socials: socialsFrom(f), is_guest: 1, created_at: now() });
  await insert(c.env, 'pub_authors', { pub_id: pub.id, user_id: uid, created_at: now() });
  await audit(c, 'authors.guest_added', uid, { name });
  return back(c, '/app/settings/authors', `Guest author ${name} added`);
});

dash.post('/authors/:id', requirePerm('manage'), async (c) => {
  const pub = c.get('pub');
  const uid = c.req.param('id');
  const allowed = await one(c.env, `SELECT 1 FROM users u WHERE u.id = ? AND (u.id IN (SELECT user_id FROM memberships WHERE pub_id = ? OR (pub_id = '' AND workspace_id = ?)) OR u.id IN (SELECT user_id FROM pub_authors WHERE pub_id = ?))`, uid, pub.id, pub.workspace_id, pub.id);
  if (!allowed) return back(c, '/app/settings/authors', 'Author not found.', 'err');
  const f = await form(c.req);
  const target = await one<User>(c.env, 'SELECT * FROM users WHERE id = ?', uid);
  let avatar = target?.avatar_url ?? null;
  if (f.avatar instanceof File && f.avatar.size) avatar = (await storeFile(c.env, pub.id, f.avatar, { folder: 'authors' })).url;
  await run(c.env, 'UPDATE users SET name = ?, bio = ?, avatar_url = ?, socials = ? WHERE id = ?', str(f.name, 120) || target?.name || '', str(f.bio, 2000), avatar, socialsFrom(f), uid);
  return back(c, '/app/settings/authors', 'Author profile saved');
});

dash.post('/authors/:id/delete', requirePerm('manage'), async (c) => {
  const pub = c.get('pub');
  await run(c.env, 'DELETE FROM pub_authors WHERE pub_id = ? AND user_id = ?', pub.id, c.req.param('id'));
  return back(c, '/app/settings/authors', 'Guest author removed');
});

// ───────────────────────── Profile ─────────────────────────
dash.get('/profile', async (c) => {
  const user = c.get('user');
  const s = parseJSON<Record<string, string>>(user.socials, {});
  const sessions = await all<any>(c.env, 'SELECT id, user_agent, created_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC', user.id, now());
  const cur = await sha256(getCookie(c, SESSION_COOKIE) || '');
  return page(c, 'profile', 'My profile', (
    <>
      <Card title="Profile">
        <form method="post" action="/app/settings/profile" enctype="multipart/form-data">
          <Grid>
            <Field label="Name"><Input name="name" value={user.name} required /></Field>
            <Field label="Email" hint={user.email_verified ? 'Verified ✓' : 'Not verified yet.'}><Input name="email" type="email" value={user.email} required /></Field>
          </Grid>
          <Field label="Bio" hint="Shown on your author page and bylines."><Textarea name="bio" value={user.bio} rows={3} /></Field>
          <Field label="Avatar"><div class="row">{user.avatar_url && <img src={user.avatar_url} class="thumb" style="border-radius:50%" alt="" />}<input type="file" name="avatar" accept="image/*" class="input" /></div></Field>
          <Grid cols={4}>{SOCIALS.map((k) => <Field label={k === 'x' ? 'X / Twitter' : k[0].toUpperCase() + k.slice(1)}><Input name={`social_${k}`} value={s[k]} placeholder="https://" /></Field>)}</Grid>
          <div class="form-actions">{!user.email_verified && <Btn kind="secondary" formaction="/app/settings/profile/verify">Resend verification</Btn>}<Btn>Save profile</Btn></div>
        </form>
      </Card>
      <Card title="Change password">
        <form method="post" action="/app/settings/profile/password">
          <Grid cols={3}>
            <Field label="Current password"><Input name="current" type="password" attrs={{ autocomplete: 'current-password' }} /></Field>
            <Field label="New password"><Input name="password" type="password" required attrs={{ minlength: '8', autocomplete: 'new-password' }} /></Field>
            <Field label="Confirm"><Input name="confirm" type="password" required attrs={{ minlength: '8' }} /></Field>
          </Grid>
          <div class="form-actions"><Btn>Update password</Btn></div>
        </form>
      </Card>
      <Card title="Active sessions" actions={<ActionForm action="/app/settings/profile/sessions/revoke-all" label="Log out everywhere else" kind="danger" confirm="Sign out of all other devices?" />} pad={false}>
        <Table
          rows={sessions}
          cols={[
            { h: 'Device', r: (s: any) => <><span class="truncate">{s.user_agent || 'Unknown device'}</span> {s.id === cur && <Badge tone="green">this device</Badge>}</> },
            { h: 'Signed in', r: (s: any) => fmtDateTime(s.created_at) },
            { h: 'Expires', r: (s: any) => <span class="muted">{fmtDateTime(s.expires_at)}</span> },
            { h: '', class: 'right', r: (s: any) => s.id === cur ? null : <ActionForm action="/app/settings/profile/sessions/revoke" fields={{ id: s.id }} label="Revoke" kind="danger" /> },
          ]}
        />
      </Card>
    </>
  ));
});

dash.post('/profile', async (c) => {
  const user = c.get('user');
  const f = await form(c.req);
  const name = str(f.name, 120);
  if (!name) return back(c, '/app/settings/profile', 'Name is required.', 'err');
  let avatar = user.avatar_url;
  const pub = c.get('pub');
  if (f.avatar instanceof File && f.avatar.size) avatar = (await storeFile(c.env, pub?.id || 'users', f.avatar, { folder: 'avatars', userId: user.id })).url;
  await run(c.env, 'UPDATE users SET name = ?, bio = ?, avatar_url = ?, socials = ? WHERE id = ?', name, str(f.bio, 2000), avatar, socialsFrom(f), user.id);
  const email = str(f.email, 254).toLowerCase();
  if (email && email !== user.email) {
    const v = await validateEmail(email, { strict: true });
    if (!v.ok) return back(c, '/app/settings/profile', v.reason, 'err');
    if (await one(c.env, 'SELECT 1 FROM users WHERE email = ?', v.email)) return back(c, '/app/settings/profile', 'That email is already used by another account.', 'err');
    const { issueToken } = await import('../lib/auth');
    const tok = await issueToken(c.env, 'verify', DAY, { user_id: user.id, data: { email: v.email } });
    await sendTransactional(c.env, v.email, 'Confirm your new email', `<p>Confirm <strong>${esc(v.email)}</strong> as the new email for your ${esc(c.env.APP_NAME)} account.</p>${button('Confirm email', `${c.env.APP_URL.replace(/\/$/, '')}/verify/${tok}`)}`);
    return back(c, '/app/settings/profile', `Profile saved. Check ${v.email} to confirm the new address.`);
  }
  return back(c, '/app/settings/profile', 'Profile saved');
});

dash.post('/profile/verify', async (c) => {
  const user = c.get('user');
  const { issueToken } = await import('../lib/auth');
  const tok = await issueToken(c.env, 'verify', 7 * DAY, { user_id: user.id });
  await sendTransactional(c.env, user.email, `Verify your email for ${c.env.APP_NAME}`, `<p>Please confirm this is your email address.</p>${button('Verify email', `${c.env.APP_URL.replace(/\/$/, '')}/verify/${tok}`)}`);
  return back(c, '/app/settings/profile', 'Verification email sent');
});

dash.post('/profile/password', async (c) => {
  const user = c.get('user');
  const f = await form(c.req);
  const row = await one<{ password_hash: string | null }>(c.env, 'SELECT password_hash FROM users WHERE id = ?', user.id);
  if (row?.password_hash && !(await verifyPassword(String(f.current || ''), row.password_hash))) return back(c, '/app/settings/profile', 'Current password is incorrect.', 'err');
  const pw = String(f.password || '');
  if (pw.length < 8) return back(c, '/app/settings/profile', 'New password must be at least 8 characters.', 'err');
  if (pw !== f.confirm) return back(c, '/app/settings/profile', 'Passwords do not match.', 'err');
  await run(c.env, 'UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(pw), user.id);
  const cur = await sha256(getCookie(c, SESSION_COOKIE) || '');
  await run(c.env, 'DELETE FROM sessions WHERE user_id = ? AND id != ?', user.id, cur);
  return back(c, '/app/settings/profile', 'Password updated; other devices were signed out.');
});

dash.post('/profile/sessions/revoke', async (c) => {
  const f = await form(c.req);
  await run(c.env, 'DELETE FROM sessions WHERE id = ? AND user_id = ?', str(f.id), c.get('user').id);
  return back(c, '/app/settings/profile', 'Session revoked');
});

dash.post('/profile/sessions/revoke-all', async (c) => {
  const cur = await sha256(getCookie(c, SESSION_COOKIE) || '');
  await run(c.env, 'DELETE FROM sessions WHERE user_id = ? AND id != ?', c.get('user').id, cur);
  return back(c, '/app/settings/profile', 'Signed out of all other devices');
});

// ───────────────────────── Audit log ─────────────────────────
dash.get('/audit', requirePerm('admin'), async (c) => {
  const pub = c.get('pub');
  const q = str(c.req.query('q'), 100);
  const who = str(c.req.query('user'), 40);
  const before = int(c.req.query('before'), 0);
  const rows = await all<any>(
    c.env,
    `SELECT a.*, u.name AS user_name, u.email AS user_email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.pub_id = ? ${q ? 'AND (a.action LIKE ? OR a.target LIKE ?)' : ''} ${who ? 'AND a.user_id = ?' : ''} ${before ? 'AND a.created_at < ?' : ''}
     ORDER BY a.created_at DESC LIMIT 100`,
    pub.id, ...(q ? [`%${q}%`, `%${q}%`] : []), ...(who ? [who] : []), ...(before ? [before] : []),
  );
  const people = await all<any>(c.env, 'SELECT DISTINCT u.id, u.name, u.email FROM audit_log a JOIN users u ON u.id = a.user_id WHERE a.pub_id = ?', pub.id);
  const nextUrl = rows.length === 100 ? `/app/settings/audit?${new URLSearchParams({ q, user: who, before: String(rows[rows.length - 1].created_at) })}` : null;
  return page(c, 'audit', 'Audit log', (
    <>
      <form method="get" class="row" style="margin-bottom:14px">
        <Input name="q" value={q} placeholder="Search actions or targets…" class="grow" />
        <Select name="user" value={who} options={[['', 'Everyone'], ...people.map((p) => [p.id, p.name || p.email] as [string, string])]} autosubmit />
        <Btn kind="secondary">Filter</Btn>
      </form>
      <Card pad={false}>
        <Table
          rows={rows}
          empty="No activity recorded yet."
          cols={[
            { h: 'When', r: (r: any) => <span class="nowrap">{fmtDateTime(r.created_at, pub.timezone)}</span> },
            { h: 'Who', r: (r: any) => r.user_name || r.user_email || <span class="muted">system</span> },
            { h: 'Action', r: (r: any) => <code>{r.action}</code> },
            { h: 'Target', r: (r: any) => <span class="truncate">{r.target || ''}</span> },
            { h: 'Details', r: (r: any) => (r.data && r.data !== '{}' ? <details><summary class="muted small">view</summary><pre class="small">{JSON.stringify(parseJSON(r.data, {}), null, 2)}</pre></details> : null) },
          ]}
        />
      </Card>
      {nextUrl && <div class="pager"><span /><a class="btn btn-ghost btn-sm" href={nextUrl}>Older →</a></div>}
    </>
  ));
});

registerEmail(dash);
registerDomains(dash);
registerDevelopers(dash);
registerAccount(dash);
registerMonitoring(dash);

const root = new Hono<AppEnv>();
export default { dash, root } satisfies Module;
