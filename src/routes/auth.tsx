/** @jsxImportSource hono/jsx */
// Module: auth — signup, login (password + magic link), reset, email verification, cross-device login,
// team invites, publication transfers, onboarding, and reader (subscriber) login on publication sites.
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv, Ctx, Module, Publication, User } from '../types';
import { one, all, run, insert } from '../lib/db';
import {
  hashPassword, verifyPassword, createSession, destroySession, currentUser, issueToken, consumeToken,
  createReaderSession, destroyReaderSession, readerEmail, userPubs,
} from '../lib/auth';
import { validateEmail, rateLimit, clientIP } from '../lib/guard';
import { sendTransactional, button } from '../lib/email';
import { siteUrl, appUrl } from '../lib/pub';
import { id, now, token, sha256, slugify, esc, form, str, MIN, DAY } from '../lib/util';
import { PlainLayout } from '../ui/layout';
import { Field, Input, Btn, Select, Textarea, flash, back } from '../ui/components';
import { SiteLayout, SiteMessage } from '../ui/site';

const dash = new Hono<AppEnv>();
const site = new Hono<AppEnv>();
const root = new Hono<AppEnv>();

/** Only allow same-site relative redirects. */
function safeNext(n: string | undefined | null, fallback = '/app'): string {
  if (!n || !n.startsWith('/') || n.startsWith('//') || n.startsWith('/\\')) return fallback;
  return n;
}

async function sendVerify(c: Ctx, user: { id: string; email: string; name: string }) {
  const tok = await issueToken(c.env, 'verify', 7 * DAY, { user_id: user.id });
  await sendTransactional(c.env, user.email, `Verify your email for ${c.env.APP_NAME}`, `<p>Hi ${esc(user.name || 'there')},</p><p>Please confirm this is your email address.</p>${button('Verify email', appUrl(c.env, `/verify/${tok}`))}`);
}

const TOO_MANY = 'Too many attempts. Please wait a few minutes and try again.';

// ───────────────────────── signup ─────────────────────────
root.get('/signup', async (c) => {
  if (await currentUser(c)) return c.redirect('/app');
  const next = c.req.query('next') || '';
  return c.html(
    <PlainLayout title="Create your account" c={c}>
      <h1>Create your account</h1>
      <p class="muted">Start your newsletter in minutes.</p>
      <form method="post" action="/signup">
        <input type="hidden" name="next" value={next} />
        <Field label="Your name"><Input name="name" required autofocus maxlength={120} /></Field>
        <Field label="Email"><Input name="email" type="email" required value={c.req.query('email') || ''} /></Field>
        <Field label="Password" hint="At least 8 characters."><Input name="password" type="password" required attrs={{ minlength: '8', autocomplete: 'new-password' }} /></Field>
        <input type="text" name="website" class="hide" tabindex={-1} autocomplete="off" />
        <Btn>Create account</Btn>
      </form>
      <p class="muted center" style="margin-top:16px">Already have an account? <a href={`/login${next ? `?next=${encodeURIComponent(next)}` : ''}`}>Log in</a></p>
    </PlainLayout>,
  );
});

root.post('/signup', async (c) => {
  const f = await form(c.req);
  const next = safeNext(f.next, '/app/onboarding');
  const fail = (m: string) => back(c, `/signup?email=${encodeURIComponent(str(f.email))}${f.next ? `&next=${encodeURIComponent(f.next)}` : ''}`, m, 'err');
  if (f.website) return fail('Signup blocked.');
  if (!(await rateLimit(c.env, `signup:ip:${clientIP(c.req.raw)}`, 10, 3600))) return fail(TOO_MANY);
  const name = str(f.name, 120);
  const pw = String(f.password || '');
  if (!name) return fail('Please enter your name.');
  if (pw.length < 8) return fail('Password must be at least 8 characters.');
  const v = await validateEmail(str(f.email), { strict: true });
  if (!v.ok) return fail(v.reason || 'Invalid email.');
  const existing = await one<User & { password_hash: string | null }>(c.env, 'SELECT * FROM users WHERE email = ?', v.email);
  if (existing && !existing.is_guest) return fail('An account with that email already exists. Log in instead.');
  const t = now();
  let uid: string;
  if (existing) {
    uid = existing.id; // guest author claiming their account
    await run(c.env, 'UPDATE users SET name = ?, password_hash = ?, is_guest = 0 WHERE id = ?', name, await hashPassword(pw), uid);
  } else {
    uid = id();
    await insert(c.env, 'users', { id: uid, email: v.email, name, password_hash: await hashPassword(pw), created_at: t });
  }
  // Invite/transfer flows sign up without their own workspace; others get one now.
  if (!next.startsWith('/invite/') && !next.startsWith('/transfer/')) {
    const wid = id();
    await insert(c.env, 'workspaces', { id: wid, name: `${name.split(' ')[0]}'s workspace`, owner_id: uid, created_at: t });
    await insert(c.env, 'memberships', { workspace_id: wid, pub_id: '', user_id: uid, role: 'owner', created_at: t });
  }
  await createSession(c, uid);
  await sendVerify(c, { id: uid, email: v.email, name });
  return c.redirect(next, 303);
});

// ───────────────────────── login ─────────────────────────
root.get('/login', async (c) => {
  const next = c.req.query('next') || '';
  if (await currentUser(c)) return c.redirect(safeNext(next));
  return c.html(
    <PlainLayout title="Log in" c={c}>
      <h1>Welcome back</h1>
      <form method="post" action="/login">
        <input type="hidden" name="next" value={next} />
        <Field label="Email"><Input name="email" type="email" required autofocus value={c.req.query('email') || ''} attrs={{ autocomplete: 'email' }} /></Field>
        <Field label={<span class="row between"><span>Password</span><a href="/forgot" class="small muted">Forgot?</a></span>}><Input name="password" type="password" attrs={{ autocomplete: 'current-password' }} /></Field>
        <Btn name="mode" value="password">Log in</Btn>
        <div class="divider-text">or</div>
        <Btn kind="secondary" name="mode" value="magic" attrs={{ formnovalidate: '' }}>Email me a magic link</Btn>
      </form>
      <p class="muted center" style="margin-top:16px">
        <a href="/device">Log in with your phone</a> · New here? <a href={`/signup${next ? `?next=${encodeURIComponent(next)}` : ''}`}>Create an account</a>
      </p>
    </PlainLayout>,
  );
});

root.post('/login', async (c) => {
  const f = await form(c.req);
  const email = str(f.email, 254).toLowerCase();
  const next = safeNext(f.next);
  const ip = clientIP(c.req.raw);
  const backTo = `/login?email=${encodeURIComponent(email)}${f.next ? `&next=${encodeURIComponent(f.next)}` : ''}`;
  const okIp = await rateLimit(c.env, `login:ip:${ip}`, 30, 900);
  const okEmail = await rateLimit(c.env, `login:email:${email}`, 10, 900);
  if (!okIp || !okEmail) return back(c, backTo, TOO_MANY, 'err');
  const user = await one<User & { password_hash: string | null }>(c.env, 'SELECT * FROM users WHERE email = ? AND is_guest = 0', email);
  if (f.mode === 'magic') {
    if (user) {
      const tok = await issueToken(c.env, 'login', 15 * MIN, { user_id: user.id, data: { next } });
      await sendTransactional(c.env, user.email, `Your ${c.env.APP_NAME} login link`, `<p>Click below to log in. This link works once and expires in 15 minutes.</p>${button('Log in', appUrl(c.env, `/magic/${tok}`))}<p style="color:#6b7280;font-size:13px">If you didn't request this, you can ignore this email.</p>`);
    }
    return c.html(
      <PlainLayout title="Check your email">
        <h1>Check your email</h1>
        <p>If an account exists for <strong>{email}</strong>, we've sent a secure, single-use login link. It expires in 15 minutes.</p>
        <p><a href="/login">Back to log in</a></p>
      </PlainLayout>,
    );
  }
  // Always run the full PBKDF2 check (unknown users too) so timing doesn't reveal accounts.
  const ok = await verifyPassword(String(f.password || ''), user?.password_hash ?? null);
  if (!user || !ok) return back(c, backTo, 'Incorrect email or password.', 'err');
  await createSession(c, user.id);
  return c.redirect(next, 303);
});

root.post('/logout', async (c) => {
  await destroySession(c);
  return c.redirect('/login', 303);
});

root.get('/magic/:token', async (c) => {
  const row = await consumeToken(c.env, 'login', c.req.param('token'));
  if (!row) return c.html(<PlainLayout title="Link expired"><h1>This link has expired</h1><p>Login links work once and expire after 15 minutes.</p><p><a class="btn btn-primary" href="/login">Request a new link</a></p></PlainLayout>, 400);
  await createSession(c, row.user_id);
  await run(c.env, 'UPDATE users SET email_verified = 1 WHERE id = ?', row.user_id);
  const data = JSON.parse(row.data || '{}');
  return c.redirect(safeNext(data.next), 303);
});

// ───────────────────────── password reset ─────────────────────────
root.get('/forgot', (c) =>
  c.html(
    <PlainLayout title="Reset password" c={c}>
      <h1>Reset your password</h1>
      <p class="muted">We'll email you a link to choose a new password.</p>
      <form method="post"><Field label="Email"><Input name="email" type="email" required autofocus /></Field><Btn>Send reset link</Btn></form>
      <p class="center" style="margin-top:16px"><a href="/login">Back to log in</a></p>
    </PlainLayout>,
  ),
);

root.post('/forgot', async (c) => {
  const f = await form(c.req);
  const email = str(f.email, 254).toLowerCase();
  if (!(await rateLimit(c.env, `forgot:${clientIP(c.req.raw)}`, 10, 3600)) || !(await rateLimit(c.env, `forgot:${email}`, 3, 3600))) return back(c, '/forgot', TOO_MANY, 'err');
  const user = await one<User>(c.env, 'SELECT * FROM users WHERE email = ? AND is_guest = 0', email);
  if (user) {
    const tok = await issueToken(c.env, 'reset', 30 * MIN, { user_id: user.id });
    await sendTransactional(c.env, user.email, 'Reset your password', `<p>Someone requested a password reset for your ${esc(c.env.APP_NAME)} account.</p>${button('Choose a new password', appUrl(c.env, `/reset/${tok}`))}<p style="color:#6b7280;font-size:13px">The link expires in 30 minutes. If this wasn't you, ignore this email.</p>`);
  }
  return c.html(<PlainLayout title="Check your email"><h1>Check your email</h1><p>If an account exists for <strong>{email}</strong>, a reset link is on its way.</p></PlainLayout>);
});

root.get('/reset/:token', async (c) => {
  const row = await one<any>(c.env, `SELECT * FROM auth_tokens WHERE id = ? AND kind = 'reset' AND used_at IS NULL AND expires_at > ?`, await sha256(c.req.param('token')), now());
  if (!row) return c.html(<PlainLayout title="Link expired"><h1>This reset link has expired</h1><p><a href="/forgot">Request a new one</a></p></PlainLayout>, 400);
  return c.html(
    <PlainLayout title="Choose a new password" c={c}>
      <h1>Choose a new password</h1>
      <form method="post">
        <Field label="New password" hint="At least 8 characters."><Input name="password" type="password" required autofocus attrs={{ minlength: '8', autocomplete: 'new-password' }} /></Field>
        <Field label="Confirm password"><Input name="confirm" type="password" required attrs={{ minlength: '8' }} /></Field>
        <Btn>Save password</Btn>
      </form>
    </PlainLayout>,
  );
});

root.post('/reset/:token', async (c) => {
  const f = await form(c.req);
  const pw = String(f.password || '');
  if (pw.length < 8 || pw !== f.confirm) return back(c, c.req.path, pw.length < 8 ? 'Password must be at least 8 characters.' : 'Passwords do not match.', 'err');
  const row = await consumeToken(c.env, 'reset', c.req.param('token'));
  if (!row) return c.html(<PlainLayout title="Link expired"><h1>This reset link has expired</h1><p><a href="/forgot">Request a new one</a></p></PlainLayout>, 400);
  await run(c.env, 'UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(pw), row.user_id);
  await run(c.env, 'DELETE FROM sessions WHERE user_id = ?', row.user_id); // sign out everywhere
  await createSession(c, row.user_id);
  flash(c, 'Password updated. Other sessions were signed out.');
  return c.redirect('/app', 303);
});

root.get('/verify/:token', async (c) => {
  const row = await consumeToken(c.env, 'verify', c.req.param('token'));
  if (!row) return c.html(<PlainLayout title="Link expired"><h1>This verification link is invalid or expired</h1><p><a href="/app/settings/profile">Resend from your profile</a></p></PlainLayout>, 400);
  await run(c.env, 'UPDATE users SET email_verified = 1 WHERE id = ?', row.user_id);
  const data = JSON.parse(row.data || '{}');
  if (data.email) await run(c.env, 'UPDATE users SET email = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM users WHERE email = ?)', data.email, row.user_id, data.email);
  return c.html(<PlainLayout title="Email verified"><h1>Email verified ✓</h1><p><a class="btn btn-primary" href="/app">Continue</a></p></PlainLayout>);
});

// ───────────────────────── cross-device login ─────────────────────────
const DEVICE_COOKIE = 'oh_device';
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function deviceCode() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return [...b].map((x) => CODE_ALPHA[x % CODE_ALPHA.length]).join('').replace(/^(.{4})/, '$1-');
}

root.get('/device', async (c) => {
  if (await currentUser(c)) return c.redirect('/app');
  const code = deviceCode();
  const secret = token(24);
  await insert(c.env, 'device_logins', { code, poll_hash: await sha256(secret), status: 'pending', user_agent: c.req.header('user-agent')?.slice(0, 200) ?? null, expires_at: now() + 10 * MIN, created_at: now() });
  setCookie(c, DEVICE_COOKIE, `${code}.${secret}`, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 600, secure: new URL(c.req.url).protocol === 'https:' });
  const link = appUrl(c.env, `/device/${code}`);
  return c.html(
    <PlainLayout title="Log in with your phone" c={c}>
      <h1>Log in with your phone</h1>
      <p class="muted">Open this link on a phone where you're signed in (or open the magic link we email you on your phone), then approve.</p>
      <p style="font-size:34px;font-weight:800;letter-spacing:4px;text-align:center;margin:18px 0" class="mono">{code}</p>
      <div class="copy" style="margin-bottom:16px"><input class="input" readonly value={link} /><button type="button" class="btn btn-secondary btn-sm" data-copy={link}>Copy</button></div>
      <form method="post" action="/device/email" class="stack">
        <Field label="Or email the approval link to yourself" hint="Open the email on your phone. It logs the phone in and approves this computer."><Input name="email" type="email" placeholder="you@example.com" required /></Field>
        <Btn kind="secondary">Email me the link</Btn>
      </form>
      <p class="muted center" id="device-status" style="margin-top:16px">Waiting for approval… (expires in 10 minutes)</p>
      <script dangerouslySetInnerHTML={{ __html: `(function(){var t=setInterval(async function(){try{var r=await fetch('/device/poll',{headers:{accept:'application/json'}});var j=await r.json();if(j.status==='approved'){clearInterval(t);document.getElementById('device-status').textContent='Approved! Signing you in…';location.href=j.redirect||'/app';}else if(j.status==='expired'||j.status==='denied'){clearInterval(t);document.getElementById('device-status').innerHTML='This code '+j.status+'. <a href="/device">Get a new code</a>';}}catch(e){}},2000);})();` }} />
    </PlainLayout>,
  );
});

root.get('/device/poll', async (c) => {
  const cookie = getCookie(c, DEVICE_COOKIE) || '';
  const [code, secret] = cookie.split('.');
  if (!code || !secret) return c.json({ status: 'expired' });
  const row = await one<any>(c.env, 'SELECT * FROM device_logins WHERE code = ?', code);
  if (!row || row.poll_hash !== (await sha256(secret))) return c.json({ status: 'expired' });
  if (row.status === 'denied') return c.json({ status: 'denied' });
  if (row.expires_at < now() && row.status === 'pending') return c.json({ status: 'expired' });
  if (row.status === 'approved' && row.user_id) {
    const claim = await run(c.env, `UPDATE device_logins SET status = 'used' WHERE code = ? AND status = 'approved'`, code);
    if (claim.meta.changes) {
      await createSession(c, row.user_id);
      deleteCookie(c, DEVICE_COOKIE, { path: '/' });
      return c.json({ status: 'approved', redirect: '/app' });
    }
  }
  return c.json({ status: row.status === 'used' ? 'expired' : 'pending' });
});

root.post('/device/email', async (c) => {
  const f = await form(c.req);
  const email = str(f.email, 254).toLowerCase();
  const code = (getCookie(c, DEVICE_COOKIE) || '').split('.')[0];
  if (!code) return c.redirect('/device');
  if (!(await rateLimit(c.env, `device:${email}`, 5, 900)) || !(await rateLimit(c.env, `device:ip:${clientIP(c.req.raw)}`, 20, 900))) return back(c, '/device', TOO_MANY, 'err');
  const user = await one<User>(c.env, 'SELECT * FROM users WHERE email = ? AND is_guest = 0', email);
  if (user) {
    const tok = await issueToken(c.env, 'login', 15 * MIN, { user_id: user.id, data: { next: `/device/${code}` } });
    await sendTransactional(c.env, user.email, 'Approve your desktop login', `<p>Open this on your phone to sign in there and approve the login on your computer (code <strong>${esc(code)}</strong>).</p>${button('Approve login', appUrl(c.env, `/magic/${tok}`))}`);
  }
  return c.html(
    <PlainLayout title="Check your phone">
      <h1>Check your email on your phone</h1>
      <p>If an account exists for <strong>{email}</strong>, we sent a link. Open it on your phone and approve code <strong class="mono">{code}</strong>. This page will continue when you approve.</p>
      <p><a href="/device">Back</a></p>
      <script dangerouslySetInnerHTML={{ __html: `setInterval(async function(){var j=await (await fetch('/device/poll')).json();if(j.status==='approved')location.href=j.redirect||'/app';},2000);` }} />
    </PlainLayout>,
  );
});

root.get('/device/:code', async (c) => {
  const code = c.req.param('code').toUpperCase();
  const user = await currentUser(c);
  if (!user) return c.redirect(`/login?next=${encodeURIComponent(`/device/${code}`)}`);
  const row = await one<any>(c.env, 'SELECT * FROM device_logins WHERE code = ?', code);
  if (!row || row.status !== 'pending' || row.expires_at < now())
    return c.html(<PlainLayout title="Code expired"><h1>This code has expired</h1><p>Start again on your computer at <span class="mono">{appUrl(c.env, '/device')}</span>.</p></PlainLayout>, 400);
  return c.html(
    <PlainLayout title="Approve login">
      <h1>Approve login on another device?</h1>
      <p>Signed in as <strong>{user.email}</strong>. A computer is asking to sign in with code <strong class="mono">{code}</strong>.</p>
      <p class="muted small">{row.user_agent}</p>
      <form method="post" class="row">
        <Btn name="decision" value="approve">Approve</Btn>
        <Btn kind="secondary" name="decision" value="deny">Deny</Btn>
      </form>
    </PlainLayout>,
  );
});

root.post('/device/:code', async (c) => {
  const code = c.req.param('code').toUpperCase();
  const user = await currentUser(c);
  if (!user) return c.redirect(`/login?next=${encodeURIComponent(`/device/${code}`)}`);
  const f = await form(c.req);
  const approve = f.decision === 'approve';
  const r = await run(c.env, `UPDATE device_logins SET status = ?, user_id = ? WHERE code = ? AND status = 'pending' AND expires_at > ?`, approve ? 'approved' : 'denied', approve ? user.id : null, code, now());
  return c.html(
    <PlainLayout title={approve ? 'Approved' : 'Denied'}>
      <h1>{!r.meta.changes ? 'This code has expired' : approve ? 'Approved ✓' : 'Login denied'}</h1>
      <p>{approve && r.meta.changes ? 'Your computer will be signed in within a few seconds.' : 'You can close this page.'}</p>
    </PlainLayout>,
  );
});

// ───────────────────────── team invites ─────────────────────────
async function findInvite(c: Ctx) {
  return one<any>(
    c.env,
    `SELECT i.*, w.name AS workspace_name, p.name AS pub_name FROM invites i JOIN workspaces w ON w.id = i.workspace_id LEFT JOIN publications p ON p.id = i.pub_id AND i.pub_id != '' WHERE i.token_hash = ? AND i.accepted_at IS NULL`,
    await sha256(c.req.param('token') || ''),
  );
}

root.get('/invite/:token', async (c) => {
  const inv = await findInvite(c);
  if (!inv || inv.created_at < now() - 14 * DAY) return c.html(<PlainLayout title="Invite invalid"><h1>This invite is no longer valid</h1><p>Ask the person who invited you to send a new one.</p></PlainLayout>, 400);
  const user = await currentUser(c);
  const target = inv.pub_name || inv.workspace_name;
  const existing = await one<User>(c.env, 'SELECT * FROM users WHERE email = ? AND is_guest = 0', inv.email);
  return c.html(
    <PlainLayout title="Join the team" c={c}>
      <h1>Join {target}</h1>
      <p>You've been invited as <strong>{inv.role}</strong>{inv.pub_name ? ' on this publication' : ' across the workspace'}.</p>
      {user ? (
        <form method="post">
          <p class="muted">Accept as <strong>{user.email}</strong>{user.email !== inv.email ? ` (invite was sent to ${inv.email})` : ''}.</p>
          <Btn>Accept invite</Btn>
        </form>
      ) : existing ? (
        <p><a class="btn btn-primary" href={`/login?email=${encodeURIComponent(inv.email)}&next=${encodeURIComponent(c.req.path)}`}>Log in to accept</a></p>
      ) : (
        <form method="post" class="stack">
          <Field label="Email"><Input name="email" value={inv.email} readonly /></Field>
          <Field label="Your name"><Input name="name" required autofocus /></Field>
          <Field label="Choose a password" hint="At least 8 characters."><Input name="password" type="password" required attrs={{ minlength: '8' }} /></Field>
          <Btn>Create account & join</Btn>
        </form>
      )}
    </PlainLayout>,
  );
});

root.post('/invite/:token', async (c) => {
  const inv = await findInvite(c);
  if (!inv) return c.html(<PlainLayout title="Invite invalid"><h1>This invite is no longer valid</h1></PlainLayout>, 400);
  let user = await currentUser(c);
  if (!user) {
    const existing = await one<User>(c.env, 'SELECT * FROM users WHERE email = ? AND is_guest = 0', inv.email);
    if (existing) return c.redirect(`/login?email=${encodeURIComponent(inv.email)}&next=${encodeURIComponent(c.req.path)}`, 303);
    const f = await form(c.req);
    const pw = String(f.password || '');
    if (pw.length < 8 || !str(f.name)) return back(c, c.req.path, 'Enter your name and a password of at least 8 characters.', 'err');
    const guest = await one<User>(c.env, 'SELECT * FROM users WHERE email = ? AND is_guest = 1', inv.email);
    const uid = guest?.id || id();
    if (guest) await run(c.env, 'UPDATE users SET name = ?, password_hash = ?, is_guest = 0, email_verified = 1 WHERE id = ?', str(f.name, 120), await hashPassword(pw), uid);
    else await insert(c.env, 'users', { id: uid, email: inv.email, name: str(f.name, 120), password_hash: await hashPassword(pw), email_verified: 1, created_at: now() });
    await createSession(c, uid);
    user = (await one<User>(c.env, 'SELECT * FROM users WHERE id = ?', uid))!;
  }
  const claim = await run(c.env, 'UPDATE invites SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL', now(), inv.id);
  if (!claim.meta.changes) return c.redirect('/app', 303);
  await run(c.env, `INSERT INTO memberships (workspace_id, pub_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, pub_id, user_id) DO UPDATE SET role = excluded.role`, inv.workspace_id, inv.pub_id || '', user.id, inv.role, now());
  await insert(c.env, 'audit_log', { id: id(), pub_id: inv.pub_id || null, user_id: user.id, action: 'team.invite_accepted', target: inv.email, data: JSON.stringify({ role: inv.role }), created_at: now() });
  if (inv.pub_id) setCookie(c, 'oh_pub', inv.pub_id, { path: '/', sameSite: 'Lax', maxAge: 365 * 86400 });
  flash(c, `Welcome to ${inv.pub_name || inv.workspace_name}!`);
  return c.redirect('/app', 303);
});

// ───────────────────────── publication transfer ─────────────────────────
async function findTransfer(c: Ctx) {
  return one<any>(
    c.env,
    `SELECT t.*, p.name AS pub_name, p.workspace_id AS from_workspace, u.name AS from_name, u.email AS from_email FROM transfers t JOIN publications p ON p.id = t.pub_id JOIN users u ON u.id = t.from_user_id WHERE t.token_hash = ? AND t.status = 'pending'`,
    await sha256(c.req.param('token') || ''),
  );
}

root.get('/transfer/:token', async (c) => {
  const t = await findTransfer(c);
  if (!t) return c.html(<PlainLayout title="Transfer invalid"><h1>This transfer link is no longer valid</h1></PlainLayout>, 400);
  const user = await currentUser(c);
  const next = encodeURIComponent(c.req.path);
  return c.html(
    <PlainLayout title="Accept publication transfer" wide c={c}>
      <h1>Accept ownership of {t.pub_name}</h1>
      <p><strong>{t.from_name || t.from_email}</strong> wants to transfer this publication to <strong>{t.to_email}</strong>.</p>
      <div class="callout warn" style="white-space:pre-wrap">{t.consent_text}</div>
      <p class="muted small">{t.keep_admin ? 'The current owner will keep admin access after the transfer.' : 'The current owner will lose access after the transfer.'}</p>
      {!user ? (
        <p class="row"><a class="btn btn-primary" href={`/login?email=${encodeURIComponent(t.to_email)}&next=${next}`}>Log in to accept</a><a class="btn btn-secondary" href={`/signup?email=${encodeURIComponent(t.to_email)}&next=${next}`}>Create an account</a></p>
      ) : user.email !== t.to_email ? (
        <div class="callout danger">You're signed in as {user.email}. Sign in as {t.to_email} to accept. <form method="post" action="/logout" class="inline-form"><button class="btn btn-ghost btn-sm">Sign out</button></form></div>
      ) : (
        <form method="post" class="stack">
          <Field label="Type your full name to sign and accept" hint={`Signing as ${user.email}`}><Input name="signature" required autofocus placeholder={user.name} /></Field>
          <label class="check"><input type="checkbox" name="agree" required /><span>I have read and agree to the statement above, and accept ownership and responsibility for this publication and its subscribers.</span></label>
          <div class="row"><Btn>Accept transfer</Btn><Btn kind="secondary" name="decision" value="decline" attrs={{ formnovalidate: '' }}>Decline</Btn></div>
        </form>
      )}
    </PlainLayout>,
  );
});

root.post('/transfer/:token', async (c) => {
  const t = await findTransfer(c);
  if (!t) return c.html(<PlainLayout title="Transfer invalid"><h1>This transfer link is no longer valid</h1></PlainLayout>, 400);
  const user = await currentUser(c);
  if (!user || user.email !== t.to_email) return c.redirect(c.req.path, 303);
  const f = await form(c.req);
  if (f.decision === 'decline') {
    await run(c.env, `UPDATE transfers SET status = 'cancelled' WHERE id = ?`, t.id);
    await sendTransactional(c.env, t.from_email, `Transfer of ${t.pub_name} declined`, `<p>${esc(user.email)} declined the transfer of <strong>${esc(t.pub_name)}</strong>.</p>`);
    return c.html(<PlainLayout title="Declined"><h1>Transfer declined</h1><p>The current owner has been notified.</p></PlainLayout>);
  }
  const sig = str(f.signature, 120);
  if (!sig || !f.agree) return back(c, c.req.path, 'Type your name and tick the agreement to accept.', 'err');
  // Recipient's workspace (owned), or a new one.
  let ws = await one<{ workspace_id: string }>(c.env, `SELECT workspace_id FROM memberships WHERE user_id = ? AND pub_id = '' AND role = 'owner' LIMIT 1`, user.id);
  if (!ws) {
    const wid = id();
    await insert(c.env, 'workspaces', { id: wid, name: `${(user.name || user.email).split(' ')[0]}'s workspace`, owner_id: user.id, created_at: now() });
    await insert(c.env, 'memberships', { workspace_id: wid, pub_id: '', user_id: user.id, role: 'owner', created_at: now() });
    ws = { workspace_id: wid };
  }
  const claim = await run(c.env, `UPDATE transfers SET status = 'accepted', accepted_at = ?, signed_name = ? WHERE id = ? AND status = 'pending'`, now(), sig, t.id);
  if (!claim.meta.changes) return c.redirect('/app', 303);
  await run(c.env, 'UPDATE publications SET workspace_id = ? WHERE id = ?', ws.workspace_id, t.pub_id);
  await run(c.env, 'DELETE FROM memberships WHERE pub_id = ?', t.pub_id);
  if (t.keep_admin) await insert(c.env, 'memberships', { workspace_id: ws.workspace_id, pub_id: t.pub_id, user_id: t.from_user_id, role: 'admin', created_at: now() });
  await insert(c.env, 'audit_log', { id: id(), pub_id: t.pub_id, user_id: user.id, action: 'publication.transferred', target: user.email, data: JSON.stringify({ from: t.from_email, signed_name: sig, consent: t.consent_text }), created_at: now() });
  await sendTransactional(c.env, t.from_email, `${t.pub_name} has been transferred`, `<p>${esc(user.email)} accepted ownership of <strong>${esc(t.pub_name)}</strong> (signed: ${esc(sig)}).</p><p>${t.keep_admin ? 'You keep admin access.' : 'You no longer have access.'}</p>`);
  setCookie(c, 'oh_pub', t.pub_id, { path: '/', sameSite: 'Lax', maxAge: 365 * 86400 });
  flash(c, `You now own ${t.pub_name}.`);
  return c.redirect('/app', 303);
});

// ───────────────────────── onboarding (dash /app/onboarding) ─────────────────────────
const CATEGORIES = ['Technology', 'Business', 'Finance', 'Marketing', 'Culture', 'Politics', 'Health', 'Science', 'Sports', 'Food', 'Travel', 'Education', 'Lifestyle', 'Arts', 'News', 'Other'];
const LANGS: Array<[string, string]> = [['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['it', 'Italian'], ['nl', 'Dutch'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['ja', 'Japanese'], ['zh', 'Chinese']];
const TZS = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Africa/Cairo', 'Asia/Riyadh', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];

dash.get('/', async (c) => {
  const user = c.get('user');
  const pubs = c.get('pubs') || [];
  const isNew = c.req.query('new') === '1';
  if (pubs.length && !isNew) return c.redirect('/app');
  return c.html(
    <PlainLayout title="Create your publication" wide c={c}>
      <h1>{pubs.length ? 'Create another publication' : `Welcome, ${user.name.split(' ')[0] || 'there'}! Let's set up your newsletter`}</h1>
      <p class="muted">You can change all of this later in Settings.</p>
      <form method="post" class="stack">
        <Field label="Publication name"><Input name="name" required autofocus maxlength={100} placeholder="The Weekly Dispatch" attrs={{ 'data-slug-src': '' }} /></Field>
        <Field label="URL" hint={`Your site will live at ${appUrl(c.env, '/s/')}<slug> until you connect a custom domain.`}><Input name="slug" placeholder="weekly-dispatch" pattern="[a-z0-9-]{2,60}" attrs={{ 'data-slug': '' }} /></Field>
        <Field label="What's it about?"><Textarea name="description" rows={2} placeholder="One sentence readers will see on your site and signup forms." /></Field>
        <div class="grid g3">
          <Field label="Category"><Select name="category" options={CATEGORIES} value="Technology" /></Field>
          <Field label="Language"><Select name="language" options={LANGS} value="en" /></Field>
          <Field label="Timezone"><Select name="timezone" options={TZS} value="UTC" /></Field>
        </div>
        <div class="row end">{pubs.length > 0 && <a class="btn btn-ghost" href="/app">Cancel</a>}<Btn>Create publication</Btn></div>
      </form>
      <script dangerouslySetInnerHTML={{ __html: `(function(){var s=document.querySelector('[data-slug-src]'),t=document.querySelector('[data-slug]'),edited=false;t.addEventListener('input',function(){edited=true});s.addEventListener('input',function(){if(!edited)t.value=s.value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60)});})();` }} />
    </PlainLayout>,
  );
});

dash.post('/', async (c) => {
  const user = c.get('user');
  const f = await form(c.req);
  const name = str(f.name, 100);
  if (!name) return back(c, '/app/onboarding?new=1', 'Give your publication a name.', 'err');
  let slug = slugify(str(f.slug) || name, 60);
  if (slug.length < 2) slug = slugify(name + '-' + id(4), 60);
  if (['app', 'api', 'admin', 'www', 'static', 'media', 'docs', 'login', 'signup'].includes(slug)) slug += '-news';
  if (await one(c.env, 'SELECT 1 FROM publications WHERE slug = ?', slug)) return back(c, '/app/onboarding?new=1', `The URL "${slug}" is taken. Try another.`, 'err');
  let ws = await one<{ workspace_id: string }>(c.env, `SELECT workspace_id FROM memberships WHERE user_id = ? AND pub_id = '' AND role IN ('owner','admin') ORDER BY role = 'owner' DESC LIMIT 1`, user.id);
  const t = now();
  if (!ws) {
    const wid = id();
    await insert(c.env, 'workspaces', { id: wid, name: `${(user.name || user.email).split(' ')[0]}'s workspace`, owner_id: user.id, created_at: t });
    await insert(c.env, 'memberships', { workspace_id: wid, pub_id: '', user_id: user.id, role: 'owner', created_at: t });
    ws = { workspace_id: wid };
  }
  const pid = id();
  await insert(c.env, 'publications', {
    id: pid, workspace_id: ws.workspace_id, slug, name, description: str(f.description, 500), category: str(f.category, 40) || null,
    language: str(f.language, 8) || 'en', timezone: str(f.timezone, 60) || 'UTC', from_name: name, settings: JSON.stringify({ utm_tracking: true, welcome_email: true, comments: 'subscribers' }), created_at: t,
  });
  // creator gets explicit owner rights on this publication (covers admins of shared workspaces)
  const wsRole = await one<{ role: string }>(c.env, `SELECT role FROM memberships WHERE workspace_id = ? AND pub_id = '' AND user_id = ?`, ws.workspace_id, user.id);
  if (wsRole?.role !== 'owner') await insert(c.env, 'memberships', { workspace_id: ws.workspace_id, pub_id: pid, user_id: user.id, role: 'owner', created_at: t });
  await insert(c.env, 'lists', { id: id(), pub_id: pid, name: 'Newsletter', description: `The main ${name} newsletter`, is_default: 1, public: 1, created_at: t });
  await insert(c.env, 'sender_addresses', { id: id(), pub_id: pid, email: c.env.MAIL_FROM, name, purpose: 'newsletter', is_default: 1, created_at: t });
  await insert(c.env, 'audit_log', { id: id(), pub_id: pid, user_id: user.id, action: 'publication.created', target: slug, data: '{}', created_at: t });
  setCookie(c, 'oh_pub', pid, { path: '/', sameSite: 'Lax', maxAge: 365 * 86400 });
  flash(c, `${name} is live! Write your first post when you're ready.`);
  return c.redirect('/app', 303);
});

// ───────────────────────── reader login (publication sites) ─────────────────────────
function sitePath(c: Ctx, pub: Publication, path: string): string {
  // Rewritten custom-domain paths look like /s/<slug>/...; turn into an absolute site URL.
  const rel = path.replace(new RegExp(`^/s/${pub.slug}`), '') || '/';
  return siteUrl(c.env, pub) + (rel.startsWith('/') ? rel : '/' + rel);
}

site.get('/login', async (c) => {
  const pub = c.get('pub');
  const base = siteUrl(c.env, pub);
  const next = c.req.query('next') || '';
  const reader = c.get('reader');
  return c.html(
    await SiteLayout({
      c, title: 'Log in', noindex: true,
      children: (
        <section class="s-wrap s-narrow s-message">
          <h1>Log in to {pub.name}</h1>
          {reader ? (
            <p>You're logged in as <strong>{reader.email}</strong>. <a href={base + '/account'}>Go to your account</a></p>
          ) : (
            <>
              <p class="s-muted">Enter your email and we'll send you a secure, single-use login link. One login works on every publication hosted here.</p>
              <form method="post" class="s-form" style="justify-content:center;max-width:460px;margin:0 auto">
                <input type="email" name="email" placeholder="you@example.com" required autocomplete="email" />
                <input type="hidden" name="next" value={next} />
                <button class="s-btn">Email me a link</button>
              </form>
            </>
          )}
        </section>
      ),
    }),
  );
});

site.post('/login', async (c) => {
  const pub = c.get('pub');
  const f = await form(c.req);
  const email = str(f.email, 254).toLowerCase();
  const ip = clientIP(c.req.raw);
  if (!(await rateLimit(c.env, `rlogin:ip:${ip}`, 20, 900)) || !(await rateLimit(c.env, `rlogin:${email}`, 5, 900)))
    return SiteMessage(c, 'Slow down', <p>Too many login attempts. Please try again in a few minutes.</p>, 429);
  const v = await validateEmail(email);
  if (!v.ok) return SiteMessage(c, 'Check your email address', <p>{v.reason} <a href="javascript:history.back()">Go back</a></p>, 400);
  const sub = await one<{ id: string; status: string }>(c.env, `SELECT id, status FROM subscribers WHERE pub_id = ? AND email = ? AND status IN ('active','pending')`, pub.id, v.email);
  const base = siteUrl(c.env, pub);
  const nextPath = f.next ? sitePath(c, pub, String(f.next)) : base + '/';
  if (sub) {
    const tok = await issueToken(c.env, 'reader_login', 15 * MIN, { pub_id: pub.id, subscriber_id: sub.id, data: { email: v.email, next: nextPath } });
    await sendTransactional(c.env, v.email, `Log in to ${pub.name}`, `<p>Click below to log in to <strong>${esc(pub.name)}</strong>. This link works once and expires in 15 minutes.</p>${button('Log in', `${base}/login/${tok}`)}`, pub);
  } else {
    await sendTransactional(c.env, v.email, `Subscribe to ${pub.name}`, `<p>Someone tried to log in to <strong>${esc(pub.name)}</strong> with this email, but it isn't subscribed yet.</p>${button('Subscribe', `${base}/subscribe?email=${encodeURIComponent(v.email)}`)}<p style="color:#6b7280;font-size:13px">If this wasn't you, ignore this email.</p>`, pub);
  }
  return SiteMessage(
    c, 'Check your inbox',
    <><p>We sent an email to <strong>{v.email}</strong>. If you're subscribed it contains a login link (valid 15 minutes); otherwise it explains how to subscribe.</p><p class="s-muted">Not subscribed yet? <a href={base + '/subscribe'}>Subscribe here</a>.</p></>,
  );
});

site.get('/login/:token', async (c) => {
  const pub = c.get('pub');
  const row = await consumeToken(c.env, 'reader_login', c.req.param('token'));
  if (!row) return SiteMessage(c, 'Link expired', <p>Login links work once and expire after 15 minutes. <a href={siteUrl(c.env, pub) + '/login'}>Request a new one</a>.</p>, 400);
  const data = JSON.parse(row.data || '{}');
  await createReaderSession(c, data.email);
  await run(c.env, `UPDATE subscribers SET status = 'active', confirmed_at = COALESCE(confirmed_at, ?) WHERE id = ? AND status = 'pending'`, now(), row.subscriber_id);
  const base = siteUrl(c.env, pub);
  const next = typeof data.next === 'string' && (data.next.startsWith(base) || data.next.startsWith(c.env.APP_URL)) ? data.next : base + '/';
  return c.redirect(next, 303);
});

site.post('/logout', async (c) => {
  await destroyReaderSession(c);
  return c.redirect(siteUrl(c.env, c.get('pub')) + '/', 303);
});

export { safeNext, readerEmail, userPubs };
export default { dash, site, root } satisfies Module;
