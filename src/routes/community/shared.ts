// Community helpers: access control, membership, notifications, body rendering, post sync.
import type { Env, Publication, Role, Subscriber } from '../../types';
import { one, all, run, insert, val } from '../../lib/db';
import { onEvent, emit } from '../../lib/events';
import { sendMail } from '../../lib/email';
import { settings, senderFor, siteUrl, getPub } from '../../lib/pub';
import { id, now, esc, parseJSON, stripTags, truncate } from '../../lib/util';
import { parseDoc } from '../../lib/render';

export type CRole = 'admin' | 'manager' | 'moderator' | 'member';
export const CROLES: CRole[] = ['admin', 'manager', 'moderator', 'member'];

/** Workspace role → community role for team members acting as the publication. */
export function teamCommunityRole(role: Role | undefined): CRole {
  if (role === 'owner' || role === 'admin') return 'admin';
  if (role === 'member') return 'manager';
  return 'moderator';
}

export const canModerate = (r?: string | null) => r === 'admin' || r === 'manager' || r === 'moderator';
export const canManage = (r?: string | null) => r === 'admin' || r === 'manager';

export interface Channel { id: string; pub_id: string; name: string; slug: string; description: string; access: string; tier_ids: string; is_default: number; sync_posts: number; position: number }

export function channelAccess(ch: Channel, sub: Subscriber | null | undefined, premium: boolean): { ok: boolean; reason?: 'subscribe' | 'upgrade' } {
  if (!sub || sub.status !== 'active') return { ok: false, reason: 'subscribe' };
  if (ch.access === 'free') return { ok: true };
  if (!premium) return { ok: false, reason: 'upgrade' };
  if (ch.access === 'tiers') {
    const tiers = parseJSON<string[]>(ch.tier_ids, []);
    if (tiers.length && !tiers.includes(sub.tier_id || '')) return { ok: false, reason: 'upgrade' };
  }
  return { ok: true };
}

export async function getMember(env: Env, pubId: string, subscriberId: string | undefined | null) {
  if (!subscriberId) return null;
  return one<any>(env, 'SELECT * FROM community_members WHERE pub_id = ? AND subscriber_id = ?', pubId, subscriberId);
}

export async function ensureDefaultChannel(env: Env, pubId: string) {
  const n = await val<number>(env, 'SELECT COUNT(*) FROM channels WHERE pub_id = ?', pubId);
  if (!n) await insert(env, 'channels', { id: id(), pub_id: pubId, name: 'General', slug: 'general', description: 'Introduce yourself and chat with fellow readers.', access: 'free', tier_ids: '[]', is_default: 1, sync_posts: 0, position: 0, created_at: now() });
}

/** Community notification email using the community from-name. */
export async function notify(env: Env, pub: Publication, to: string, subject: string, bodyHtml: string, link?: string) {
  const s = await senderFor(env, pub, 'community');
  const name = (settings(pub).community_from_name as string) || `${pub.name} Community`;
  const html = `<!DOCTYPE html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px"><table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:100%;background:#fff;border-radius:10px"><tr><td style="padding:24px 26px;font-size:15px;line-height:1.6;color:#1f2328"><p style="margin:0 0 6px;font-weight:800;font-size:16px">${esc(name)}</p>${bodyHtml}${link ? `<p style="margin:20px 0 0"><a href="${esc(link)}" style="display:inline-block;background:#111827;color:#fff;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:600">Open in community</a></p>` : ''}</td></tr></table><p style="font-size:12px;color:#9ca3af">You're receiving this because you're a member of the ${esc(pub.name)} community.</p></td></tr></table></body></html>`;
  return sendMail(env, { to, subject, html, pub, kind: 'transactional', from: { email: s.email, name } });
}

/** Plain text → safe HTML paragraphs with autolinks. */
export function renderBody(text: string): string {
  return esc(text || '')
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" rel="nofollow noopener" target="_blank">$1</a>')}</p>`)
    .join('');
}

export async function authorNames(env: Env, rows: Array<{ author_subscriber_id?: string | null; author_user_id?: string | null }>, pubId: string) {
  const subIds = [...new Set(rows.map((r) => r.author_subscriber_id).filter(Boolean))] as string[];
  const userIds = [...new Set(rows.map((r) => r.author_user_id).filter(Boolean))] as string[];
  const names = new Map<string, { name: string; role: string; team: boolean }>();
  if (subIds.length) {
    const subs = await all<any>(env, `SELECT s.id, s.name, s.email, cm.display_name, cm.role FROM subscribers s LEFT JOIN community_members cm ON cm.subscriber_id = s.id AND cm.pub_id = ? WHERE s.id IN (${subIds.map(() => '?').join(',')})`, pubId, ...subIds);
    for (const s of subs) names.set(s.id, { name: s.display_name || s.name || s.email.split('@')[0], role: s.role || 'member', team: false });
  }
  if (userIds.length) {
    const users = await all<any>(env, `SELECT id, name, email FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`, ...userIds);
    for (const u of users) names.set(u.id, { name: u.name || u.email.split('@')[0], role: 'team', team: true });
  }
  return (r: { author_subscriber_id?: string | null; author_user_id?: string | null }) => names.get((r.author_user_id || r.author_subscriber_id) as string) || { name: 'Unknown', role: 'member', team: false };
}

export async function createCommunityPost(env: Env, pub: Publication, p: { channel_id: string; title: string; body: string; author_subscriber_id?: string | null; author_user_id?: string | null; post_id?: string | null; pinned?: boolean }) {
  const pid = id();
  await insert(env, 'community_posts', { id: pid, pub_id: pub.id, channel_id: p.channel_id, author_subscriber_id: p.author_subscriber_id ?? null, author_user_id: p.author_user_id ?? null, title: p.title.slice(0, 200), body: p.body.slice(0, 20000), post_id: p.post_id ?? null, pinned: p.pinned ? 1 : 0, status: 'visible', reply_count: 0, like_count: 0, last_activity_at: now(), created_at: now() });
  await emit(env, { pubId: pub.id, type: 'community.post.created', subscriberId: p.author_subscriber_id ?? null, refId: pid, data: { post_id: pid, channel_id: p.channel_id, title: p.title } });
  return pid;
}

// Sync newsletter posts into channels that opted in.
onEvent(async (env, e) => {
  if (e.type !== 'post.published') return;
  const chans = await all<Channel>(env, 'SELECT * FROM channels WHERE pub_id = ? AND sync_posts = 1', e.pubId);
  if (!chans.length) return;
  const post = await one<any>(env, 'SELECT * FROM posts WHERE id = ?', e.refId);
  const pub = await getPub(env, e.pubId);
  if (!post || !pub || post.platform === 'email') return;
  for (const ch of chans) {
    if (await one(env, 'SELECT 1 FROM community_posts WHERE channel_id = ? AND post_id = ?', ch.id, post.id)) continue;
    const text = parseDoc(post.content).blocks.filter((b) => b.type === 'paragraph').map((b) => stripTags(b.data?.html || '')).join(' ');
    const excerpt = truncate(post.subtitle || post.preview_text || text, 280);
    await createCommunityPost(env, pub, { channel_id: ch.id, title: post.title, body: `${excerpt}\n\nRead the full post: ${siteUrl(env, pub)}/p/${post.slug}`, author_user_id: post.created_by, post_id: post.id });
  }
});
