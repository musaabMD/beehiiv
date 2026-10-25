/** @jsxImportSource hono/jsx */
// Public publication website: home, posts, archive, tags, authors, search, feeds, sitemaps, robots, account, custom pages.
import { Hono } from 'hono';
import { raw } from 'hono/html';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppEnv, Ctx, Post, Publication } from '../../types';
import { all, one, run, val, insert } from '../../lib/db';
import { renderDoc, parseDoc } from '../../lib/render';
import { sanitizeHtml } from '../../lib/sanitize';
import { settings, siteUrl } from '../../lib/pub';
import { trackView } from '../../lib/tracking';
import { getTags, joinLists, leaveLists } from '../../lib/subscribers';
import { segmentIdsFor } from '../../lib/segments';
import { classifyCrawler } from '../../lib/guard';
import { mediaUrl } from '../../lib/ai';
import { flash } from '../../ui/components';
import { SiteLayout, SiteMessage, SubscribeForm, themeOf } from '../../ui/site';
import { esc, fmtDate, hmac, id, now, parseJSON, stripTags, truncate, form, str, int, DAY, b64url } from '../../lib/util';
import { renderSections, parseSections, postCard, withAuthors, PUBLIC_POSTS, type CardPost } from './sections';
import { effectiveStyle, webFontLink } from '../posts/shared';

const site = new Hono<AppEnv>();
const PER_PAGE = 12;
const REACTIONS = ['❤️', '🔥', '👏', '💡', '😂'];

const base = (c: Ctx) => siteUrl(c.env, c.get('pub'));

/** Anonymous, non-personalized responses can be cached at the edge briefly. */
function cacheHeaders(c: Ctx, personalized: boolean) {
  if (personalized || c.get('reader')) c.header('Cache-Control', 'private, no-store');
  else c.header('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
}

function excerpt(doc: { blocks: any[] }, max = 160): string {
  const parts: string[] = [];
  for (const b of doc.blocks || []) {
    if (b.type === 'paragraph' || b.type === 'heading' || b.type === 'quote') parts.push(stripTags(b.data?.html || ''));
    if (parts.join(' ').length > max * 2) break;
  }
  return truncate(parts.join(' ').trim(), max);
}

const CARD_COLS = 'id, slug, title, subtitle, thumbnail_url, published_at, audience, content';

// ───────── Home ─────────
export async function renderHome(c: Ctx): Promise<Response> {
  const pub = c.get('pub');
  const home = await one<any>(c.env, `SELECT * FROM pages WHERE pub_id = ? AND slug = '' AND status = 'published'`, pub.id);
  if (home && !c.req.query('page')) return renderPage(c, home);
  const t = themeOf(pub);
  const page = Math.max(1, int(c.req.query('page'), 1));
  const total = await val<number>(c.env, `SELECT COUNT(*) FROM posts WHERE pub_id = ? AND ${PUBLIC_POSTS}`, pub.id);
  const posts = await withAuthors(c.env, await all<CardPost>(c.env, `SELECT ${CARD_COLS} FROM posts WHERE pub_id = ? AND ${PUBLIC_POSTS} ORDER BY published_at DESC LIMIT ? OFFSET ?`, pub.id, PER_PAGE, (page - 1) * PER_PAGE));
  const b = base(c);
  const reader = c.get('reader');
  const subscribed = reader?.subscriber?.status === 'active';
  const showHero = t.show_hero !== false && page === 1;
  await trackView(c, null);
  cacheHeaders(c, false);
  const pages = Math.ceil(total / PER_PAGE);
  return c.html(
    await SiteLayout({
      c, description: pub.description, image: t.hero_image || pub.logo_url, canonical: b + '/',
      jsonld: { '@context': 'https://schema.org', '@type': 'WebSite', name: pub.name, url: b + '/', description: pub.description, potentialAction: { '@type': 'SearchAction', target: `${b}/search?q={q}`, 'query-input': 'required name=q' } },
      children: (
        <>
          {showHero && (
            <section class="s-hero">
              <div class="s-wrap">
                {pub.logo_url && <img class="s-hero-logo" src={pub.logo_url} alt="" width="72" height="72" fetchpriority="high" />}
                <h1>{t.hero_title || pub.name}</h1>
                <p>{t.hero_subtitle || pub.description}</p>
                {subscribed ? <p class="s-muted">You're subscribed as {reader!.email} ✓</p> : <SubscribeForm action={b + '/subscribe'} source="home" />}
                {t.hero_image && <img class="s-hero-img" src={t.hero_image} alt="" width="1200" height="600" fetchpriority="high" />}
              </div>
            </section>
          )}
          <section class="s-section">
            <div class="s-wrap">
              {posts.length ? (
                <div class="s-posts">{raw(posts.map((p, i) => postCard(b, p, i === 0 && !showHero, pub.timezone)).join(''))}</div>
              ) : (
                <div class="s-empty"><h2>No posts yet</h2><p class="s-muted">Subscribe to get the first issue in your inbox.</p></div>
              )}
              {pages > 1 && (
                <nav class="s-pager">
                  {page > 1 ? <a class="s-btn s-btn-ghost" href={`${b}/?page=${page - 1}`}>← Newer</a> : <span />}
                  <span class="s-muted s-small">Page {page} of {pages}</span>
                  {page < pages ? <a class="s-btn s-btn-ghost" href={`${b}/?page=${page + 1}`}>Older →</a> : <span />}
                </nav>
              )}
            </div>
          </section>
        </>
      ),
    }),
  );
}

site.get('/', (c) => renderHome(c));

// ───────── Metered paywall (signed cookie per publication) ─────────
async function meterRead(c: Ctx): Promise<Array<[string, number]>> {
  const raw0 = getCookie(c, 'ohm_' + c.get('pub').id);
  if (!raw0) return [];
  const [data, sig] = raw0.split('.');
  if (!data || !sig || (await hmac(c.env.APP_URL + ':meter', data)).slice(0, 24) !== sig) return [];
  try {
    const list = JSON.parse(atob(data.replace(/-/g, '+').replace(/_/g, '/'))) as Array<[string, number]>;
    return list.filter((x) => now() - x[1] < 30 * DAY);
  } catch {
    return [];
  }
}
async function meterWrite(c: Ctx, list: Array<[string, number]>) {
  const data = b64url(new TextEncoder().encode(JSON.stringify(list.slice(-50))));
  const sig = (await hmac(c.env.APP_URL + ':meter', data)).slice(0, 24);
  setCookie(c, 'ohm_' + c.get('pub').id, `${data}.${sig}`, { path: '/', maxAge: 30 * 86400, sameSite: 'Lax', httpOnly: true });
}

// ───────── Post page ─────────
async function loadPost(c: Ctx, slug: string): Promise<Post | null> {
  return one<Post>(c.env, `SELECT * FROM posts WHERE pub_id = ? AND slug = ? AND status = 'published' AND platform != 'email'`, c.get('pub').id, slug);
}

async function reactionCounts(c: Ctx, postId: string) {
  const rows = await all<{ emoji: string; n: number }>(c.env, 'SELECT emoji, COUNT(*) AS n FROM reactions WHERE post_id = ? GROUP BY emoji', postId);
  return Object.fromEntries(REACTIONS.map((e) => [e, rows.find((r) => r.emoji === e)?.n || 0]));
}

function commentsMode(pub: Publication): 'off' | 'subscribers' | 'premium' {
  return (settings(pub).comments as any) || 'subscribers';
}

site.get('/p/:post', async (c) => {
  const pub = c.get('pub');
  const post = await loadPost(c, c.req.param('post'));
  if (!post) return SiteMessage(c, 'Post not found', <p>This post doesn't exist or isn't published. <a href={base(c) + '/archive'}>Browse the archive</a></p>, 404);
  const b = base(c);
  const reader = c.get('reader');
  const sub = reader?.subscriber && reader.subscriber.status === 'active' ? reader.subscriber : null;
  const cfg = settings(pub);
  const doc = parseDoc(post.content);
  const hasPaywall = doc.blocks.some((x) => x.type === 'paywall');
  const isPremium = post.audience === 'premium' || hasPaywall;
  let access = !!reader?.premium;
  let personalized = !!reader;
  let meterLeft: number | null = null;
  // metered paywall: N free premium posts per 30 days per visitor
  if (isPremium && !access && Number(cfg.paywall_meter) > 0 && !classifyCrawler(c.req.header('user-agent'))) {
    personalized = true;
    const list = await meterRead(c);
    const limit = Number(cfg.paywall_meter);
    if (list.some((x) => x[0] === post.id)) { access = true; meterLeft = Math.max(0, limit - list.length); }
    else if (list.length < limit) { list.push([post.id, now()]); await meterWrite(c, list); access = true; meterLeft = limit - list.length; }
    else meterLeft = 0;
  }
  // subscriber-gated posts (audience = free): must be a logged-in subscriber
  const gated = post.audience === 'free' && !sub && !reader?.premium;
  const tags = sub ? await getTags(c.env, sub.id) : [];
  const segIds = sub ? await segmentIdsFor(c.env, sub.id) : new Set<string>();
  let bodyHtml: string;
  let paywalled = false;
  if (gated) {
    const preview = { blocks: doc.blocks.filter((x) => x.type !== 'paywall').slice(0, 3) };
    bodyHtml = (await renderDoc(preview, { env: c.env, mode: 'web', pub, siteUrl: b, post, subscriber: null, access: false })).html;
  } else {
    const isPremiumAudience = post.audience === 'premium';
    if (isPremiumAudience && !access) {
      // whole post is premium: show the opening, then the upgrade CTA
      const cut = doc.blocks.findIndex((x) => x.type === 'paywall');
      const preview = { blocks: [...doc.blocks.slice(0, cut >= 0 ? cut : Math.min(3, doc.blocks.length)), { id: 'pw', type: 'paywall', data: {} }] };
      const r = await renderDoc(preview, { env: c.env, mode: 'web', pub, siteUrl: b, post, subscriber: sub, tags, segmentIds: segIds, access: false });
      bodyHtml = r.html; paywalled = true;
    } else {
      const r = await renderDoc(doc, { env: c.env, mode: 'web', pub, siteUrl: b, post, subscriber: sub, tags, segmentIds: segIds, access });
      bodyHtml = r.html; paywalled = r.paywalled;
    }
  }
  const authors = await all<any>(c.env, 'SELECT u.id, u.name, u.avatar_url, u.bio FROM post_authors pa JOIN users u ON u.id = pa.user_id WHERE pa.post_id = ? ORDER BY pa.position', post.id);
  const postTags = await all<any>(c.env, 'SELECT t.name, t.slug, t.id FROM post_tags pt JOIN content_tags t ON t.id = pt.tag_id WHERE pt.post_id = ?', post.id);
  const seo = parseJSON<any>(post.seo, {});
  const desc = seo.description || post.subtitle || post.preview_text || excerpt(doc);
  const title = seo.title || post.title;
  const url = `${b}/p/${post.slug}`;
  const counts = await reactionCounts(c, post.id);
  const mine = sub ? (await all<{ emoji: string }>(c.env, 'SELECT emoji FROM reactions WHERE post_id = ? AND subscriber_id = ?', post.id, sub.id)).map((r) => r.emoji) : [];
  const mode = commentsMode(pub);
  const commentsOn = mode !== 'off' && !!post.comments_enabled;
  const comments = commentsOn ? await all<any>(c.env, `SELECT cm.*, s.name AS author_name, s.email AS author_email FROM comments cm JOIN subscribers s ON s.id = cm.subscriber_id WHERE cm.post_id = ? AND cm.status = 'visible' ORDER BY cm.created_at`, post.id) : [];
  const canComment = commentsOn && !!sub && (mode === 'subscribers' || reader?.premium);
  const related = await withAuthors(c.env, postTags.length
    ? await all<CardPost>(c.env, `SELECT DISTINCT p.id, p.slug, p.title, p.subtitle, p.thumbnail_url, p.published_at, p.audience, p.content FROM posts p JOIN post_tags pt ON pt.post_id = p.id WHERE pt.tag_id IN (${postTags.map(() => '?').join(',')}) AND p.id != ? AND p.pub_id = ? AND p.status = 'published' AND p.platform != 'email' AND p.hide_from_feed = 0 ORDER BY p.published_at DESC LIMIT 3`, ...postTags.map((t) => t.id), post.id, pub.id)
    : await all<CardPost>(c.env, `SELECT ${CARD_COLS} FROM posts WHERE pub_id = ? AND id != ? AND ${PUBLIC_POSTS} ORDER BY published_at DESC LIMIT 3`, pub.id, post.id));
  const prev = await one<any>(c.env, `SELECT slug, title FROM posts WHERE pub_id = ? AND ${PUBLIC_POSTS} AND published_at < ? ORDER BY published_at DESC LIMIT 1`, pub.id, post.published_at || 0);
  const next = await one<any>(c.env, `SELECT slug, title FROM posts WHERE pub_id = ? AND ${PUBLIC_POSTS} AND published_at > ? ORDER BY published_at ASC LIMIT 1`, pub.id, post.published_at || 0);
  await trackView(c, post.id);
  cacheHeaders(c, personalized);
  const image = seo.og_image || post.thumbnail_url;
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'NewsArticle', headline: truncate(title, 110), description: desc, mainEntityOfPage: url,
    datePublished: new Date(post.published_at || post.created_at).toISOString(), dateModified: new Date(post.updated_at).toISOString(),
    image: image ? [image] : undefined, isAccessibleForFree: !isPremium, ...(isPremium ? { hasPart: { '@type': 'WebPageElement', isAccessibleForFree: false, cssSelector: '.oh-paywall' } } : {}),
    author: authors.length ? authors.map((a) => ({ '@type': 'Person', name: a.name, url: `${b}/authors/${a.id}` })) : [{ '@type': 'Organization', name: pub.name }],
    publisher: { '@type': 'Organization', name: pub.name, logo: pub.logo_url ? { '@type': 'ImageObject', url: pub.logo_url } : undefined },
  };
  const tree = threadComments(comments);
  // Post look on the web = site theme ⊕ linked template's web style ⊕ the post's own web overrides
  const webStyle = (await effectiveStyle(c.env, pub.id, post)).web;
  const cssv = (v: unknown) => String(v).replace(/[;"'<>{}\\]/g, '');
  const VARS: Record<string, string> = { font: '--font', heading_font: '--hfont', text: '--text', bg: '--bg', accent: '--accent', accent_text: '--accent-text' };
  const postVars = Object.entries(VARS).filter(([k]) => webStyle[k]).map(([k, v]) => `${v}:${cssv(webStyle[k])}`).join(';');
  const postHead = postVars ? raw(`${webFontLink(webStyle)}<style>:root{${postVars}}</style>`) : undefined;
  return c.html(
    await SiteLayout({
      c, title, description: desc, image, canonical: seo.canonical || url, noindex: !!seo.noindex, jsonld, head: postHead,
      children: (
        <article class="s-article">
          <header class="s-article-h">
            {postTags.length > 0 && <div class="s-tags">{postTags.map((t) => <a class="s-badge" href={`${b}/tag/${t.slug}`}>{t.name}</a>)}</div>}
            <h1>{post.title}</h1>
            {post.subtitle && <p class="s-sub">{post.subtitle}</p>}
            <div class="s-byline">
              {authors.slice(0, 3).map((a) => (a.avatar_url ? <img src={a.avatar_url} alt="" width="36" height="36" /> : <span class="s-avatar">{(a.name || '?').slice(0, 1)}</span>))}
              <span>
                {authors.length ? <>{authors.map((a, i) => <>{i > 0 && ', '}<a href={`${b}/authors/${a.id}`}>{a.name}</a></>)}<br /></> : null}
                <time datetime={new Date(post.published_at || 0).toISOString()}>{fmtDate(post.published_at, { dateStyle: 'long' }, pub.timezone)}</time>
                {post.word_count ? <> · {Math.max(1, Math.round(post.word_count / 230))} min read</> : null}
                {isPremium && <> · <span class="s-lock">🔒 Premium</span></>}
              </span>
            </div>
          </header>
          {post.thumbnail_url && <img class="s-thumb" src={post.thumbnail_url} alt="" width="1200" height="675" fetchpriority="high" />}
          {post.audio_key && (
            <div class="s-listen"><span>🎧 Listen to this post</span><audio controls preload="none" src={mediaUrl(c.env, post.audio_key)} /></div>
          )}
          {meterLeft !== null && access && !reader?.premium && (
            <div class="s-meter">You have <strong>{meterLeft}</strong> free premium {meterLeft === 1 ? 'article' : 'articles'} left this month. <a href={`${b}/upgrade`}>Upgrade for unlimited access</a></div>
          )}
          <div class="s-body">{raw(bodyHtml)}</div>
          {gated && (
            <div class="oh-paywall s-gate">
              <h3>{String(cfg.gate_message || 'This post is for subscribers')}</h3>
              <p>Subscribe for free to keep reading — or log in if you're already subscribed.</p>
              <SubscribeForm action={b + '/subscribe'} source="gate" />
              <p class="s-small"><button type="button" class="s-link" data-modal="login">Already subscribed? Log in</button></p>
            </div>
          )}
          {!gated && !paywalled && (
            <form class="s-reactions" method="post" action={`${url}/react`} data-react>
              {REACTIONS.map((e) => <button name="emoji" value={e} class={mine.includes(e) ? 'on' : ''} aria-label={`React ${e}`}>{e} <span>{counts[e] || ''}</span></button>)}
            </form>
          )}
          <div class="s-share">
            <a class="s-btn s-btn-ghost s-btn-sm" href={`https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(post.title)}`} target="_blank" rel="noopener">Share on X</a>
            <a class="s-btn s-btn-ghost s-btn-sm" href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`} target="_blank" rel="noopener">LinkedIn</a>
            <a class="s-btn s-btn-ghost s-btn-sm" href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`} target="_blank" rel="noopener">Facebook</a>
            <a class="s-btn s-btn-ghost s-btn-sm" href={`mailto:?subject=${encodeURIComponent(post.title)}&body=${encodeURIComponent(url)}`}>Email</a>
            <button type="button" class="s-btn s-btn-ghost s-btn-sm" data-copy={url}>Copy link</button>
          </div>
          {sub?.status !== 'active' && !gated && (
            <div class="s-subscribe-box">
              <h3>Enjoyed this? Subscribe to {pub.name}</h3>
              <p class="s-muted">{pub.description}</p>
              <SubscribeForm action={b + '/subscribe'} source="post" />
            </div>
          )}
          {authors.filter((a) => a.bio).map((a) => (
            <aside class="s-author-card">
              {a.avatar_url ? <img src={a.avatar_url} alt="" width="56" height="56" loading="lazy" /> : <span class="s-avatar s-avatar-lg">{a.name.slice(0, 1)}</span>}
              <div><a href={`${b}/authors/${a.id}`}><strong>{a.name}</strong></a><p class="s-muted">{a.bio}</p></div>
            </aside>
          ))}
          {(prev || next) && (
            <nav class="s-prevnext">
              {prev ? <a href={`${b}/p/${prev.slug}`}><small>← Previous</small><span>{prev.title}</span></a> : <span />}
              {next ? <a href={`${b}/p/${next.slug}`} class="r"><small>Next →</small><span>{next.title}</span></a> : <span />}
            </nav>
          )}
          {commentsOn && (
            <section class="s-comments" id="comments">
              <h3>{comments.length} {comments.length === 1 ? 'comment' : 'comments'}</h3>
              {canComment ? (
                <form method="post" action={`${url}/comments`} class="s-form s-comment-form">
                  <textarea name="body" required maxlength={5000} placeholder="Join the discussion…" />
                  <button class="s-btn">Post comment</button>
                </form>
              ) : (
                <p class="s-muted">
                  {!sub ? <>Only subscribers can comment. <button type="button" class="s-link" data-modal="login">Log in</button> or <button type="button" class="s-link" data-modal="subscribe">subscribe</button>.</> : <>Comments are for premium subscribers. <a href={`${b}/upgrade`}>Upgrade</a></>}
                </p>
              )}
              {raw(tree.map((cm) => commentHtml(cm, url, !!canComment, sub?.id)).join(''))}
            </section>
          )}
          {related.length > 0 && (
            <section class="s-related">
              <h3>Keep reading</h3>
              <div class="s-posts s-posts-3">{raw(related.map((p) => postCard(b, p, false, pub.timezone)).join(''))}</div>
            </section>
          )}
        </article>
      ),
    }),
  );
});

function threadComments(rows: any[]): any[] {
  const byId = new Map(rows.map((r) => [r.id, { ...r, replies: [] as any[] }]));
  const roots: any[] = [];
  for (const r of byId.values()) {
    if (r.parent_id && byId.has(r.parent_id)) byId.get(r.parent_id)!.replies.push(r);
    else roots.push(r);
  }
  return roots;
}

function commentHtml(cm: any, url: string, canReply: boolean, myId?: string, depth = 0): string {
  const name = cm.author_name || String(cm.author_email || 'Reader').split('@')[0];
  const replies = cm.replies.map((r: any) => commentHtml(r, url, canReply, myId, depth + 1)).join('');
  return `<div class="s-comment" id="c-${esc(cm.id)}"><div class="s-meta"><strong>${esc(name)}</strong><span>·</span><time datetime="${new Date(cm.created_at).toISOString()}">${fmtDate(cm.created_at, { dateStyle: 'medium' })}</time></div><div class="s-comment-body">${esc(cm.body).replace(/\n/g, '<br>')}</div><div class="s-comment-actions">${canReply && depth < 3 ? `<details><summary>Reply</summary><form method="post" action="${esc(url)}/comments" class="s-form"><input type="hidden" name="parent_id" value="${esc(cm.id)}"><textarea name="body" required maxlength="5000" placeholder="Write a reply…"></textarea><button class="s-btn s-btn-sm">Reply</button></form></details>` : ''}${myId === cm.subscriber_id ? `<form method="post" action="${esc(url)}/comments/${esc(cm.id)}/delete"><button class="s-link">Delete</button></form>` : `<form method="post" action="${esc(url)}/comments/${esc(cm.id)}/report"><button class="s-link" title="Report to moderators">Report</button></form>`}</div>${replies ? `<div class="s-comment-replies">${replies}</div>` : ''}</div>`;
}

const wantsJSON = (c: Ctx) => (c.req.header('accept') || '').includes('application/json');

site.post('/p/:post/react', async (c) => {
  const post = await loadPost(c, c.req.param('post'));
  if (!post) return c.notFound();
  const sub = c.get('reader')?.subscriber;
  const url = `${base(c)}/p/${post.slug}`;
  if (!sub || sub.status !== 'active') {
    if (wantsJSON(c)) return c.json({ error: 'login_required' }, 401);
    flash(c, 'Log in or subscribe to react', 'err');
    return c.redirect(url, 303);
  }
  const f = await form(c.req);
  const emoji = REACTIONS.includes(f.emoji) ? f.emoji : REACTIONS[0];
  const r = await run(c.env, 'DELETE FROM reactions WHERE post_id = ? AND subscriber_id = ? AND emoji = ?', post.id, sub.id, emoji);
  if (!r.meta.changes) await run(c.env, 'INSERT OR IGNORE INTO reactions (post_id, subscriber_id, emoji, created_at) VALUES (?, ?, ?, ?)', post.id, sub.id, emoji, now());
  const counts = await reactionCounts(c, post.id);
  if (wantsJSON(c)) return c.json({ counts, on: !r.meta.changes });
  return c.redirect(url, 303);
});

site.post('/p/:post/comments', async (c) => {
  const pub = c.get('pub');
  const post = await loadPost(c, c.req.param('post'));
  if (!post) return c.notFound();
  const url = `${base(c)}/p/${post.slug}`;
  const reader = c.get('reader');
  const sub = reader?.subscriber;
  const mode = commentsMode(pub);
  if (mode === 'off' || !post.comments_enabled) return c.redirect(url, 303);
  if (!sub || sub.status !== 'active' || (mode === 'premium' && !reader?.premium)) {
    flash(c, mode === 'premium' ? 'Comments are for premium subscribers' : 'Log in as a subscriber to comment', 'err');
    return c.redirect(url + '#comments', 303);
  }
  const f = await form(c.req);
  const body = str(f.body, 5000);
  if (!body) return c.redirect(url + '#comments', 303);
  const recent = await val<number>(c.env, 'SELECT COUNT(*) FROM comments WHERE subscriber_id = ? AND created_at > ?', sub.id, now() - 60_000);
  if (recent >= 5) { flash(c, 'Slow down — try again in a minute', 'err'); return c.redirect(url + '#comments', 303); }
  let parent: string | null = str(f.parent_id) || null;
  if (parent && !(await one(c.env, 'SELECT id FROM comments WHERE id = ? AND post_id = ?', parent, post.id))) parent = null;
  const cid = id();
  await insert(c.env, 'comments', { id: cid, pub_id: pub.id, post_id: post.id, subscriber_id: sub.id, parent_id: parent, body, status: 'visible', created_at: now() });
  flash(c, 'Comment posted');
  return c.redirect(`${url}#c-${cid}`, 303);
});

site.post('/p/:post/comments/:cid/report', async (c) => {
  const post = await loadPost(c, c.req.param('post'));
  if (!post) return c.notFound();
  await run(c.env, `UPDATE comments SET status = 'reported' WHERE id = ? AND post_id = ? AND status = 'visible'`, c.req.param('cid'), post.id);
  flash(c, 'Thanks — a moderator will review this comment.');
  return c.redirect(`${base(c)}/p/${post.slug}#comments`, 303);
});

site.post('/p/:post/comments/:cid/delete', async (c) => {
  const post = await loadPost(c, c.req.param('post'));
  const sub = c.get('reader')?.subscriber;
  if (!post || !sub) return c.notFound();
  await run(c.env, `DELETE FROM comments WHERE id = ? AND post_id = ? AND subscriber_id = ?`, c.req.param('cid'), post.id, sub.id);
  flash(c, 'Comment deleted');
  return c.redirect(`${base(c)}/p/${post.slug}#comments`, 303);
});

// ───────── Archive / search / tags / authors ─────────
async function listing(c: Ctx, opts: { title: string; heading?: any; where?: string; params?: unknown[]; path: string; q?: string; tag?: string; description?: string }) {
  const pub = c.get('pub');
  const b = base(c);
  const page = Math.max(1, int(c.req.query('page'), 1));
  const where = [`p.pub_id = ?`, `p.status = 'published'`, `p.platform != 'email'`, `p.hide_from_feed = 0`];
  const params: unknown[] = [pub.id];
  if (opts.q) { where.push('(p.title LIKE ? OR p.subtitle LIKE ? OR p.content LIKE ?)'); params.push(`%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`); }
  if (opts.tag) { where.push('EXISTS (SELECT 1 FROM post_tags pt JOIN content_tags t ON t.id = pt.tag_id WHERE pt.post_id = p.id AND t.slug = ?)'); params.push(opts.tag); }
  if (opts.where) { where.push(opts.where); params.push(...(opts.params || [])); }
  const w = where.join(' AND ');
  const total = await val<number>(c.env, `SELECT COUNT(*) FROM posts p WHERE ${w}`, ...params);
  const posts = await withAuthors(c.env, await all<CardPost>(c.env, `SELECT p.id, p.slug, p.title, p.subtitle, p.thumbnail_url, p.published_at, p.audience, p.content FROM posts p WHERE ${w} ORDER BY p.published_at DESC LIMIT ? OFFSET ?`, ...params, PER_PAGE, (page - 1) * PER_PAGE));
  const tags = await all<any>(c.env, `SELECT t.name, t.slug, COUNT(pt.post_id) AS n FROM content_tags t JOIN post_tags pt ON pt.tag_id = t.id JOIN posts p ON p.id = pt.post_id AND p.status = 'published' WHERE t.pub_id = ? GROUP BY t.id ORDER BY n DESC LIMIT 20`, pub.id);
  const pages = Math.ceil(total / PER_PAGE);
  const qs = (pg: number) => `${b}${opts.path}?${new URLSearchParams({ ...(opts.q ? { q: opts.q } : {}), ...(opts.tag && opts.path === '/archive' ? { tag: opts.tag } : {}), page: String(pg) })}`;
  await trackView(c, null);
  cacheHeaders(c, !!opts.q);
  return c.html(
    await SiteLayout({
      c, title: opts.title, description: opts.description, canonical: `${b}${opts.path}`, noindex: !!opts.q,
      children: (
        <section class="s-section">
          <div class="s-wrap">
            {opts.heading || <h1 class="s-page-title">{opts.title}</h1>}
            <form class="s-form s-search" method="get" action={`${b}/search`} role="search">
              <input type="search" name="q" value={opts.q || ''} placeholder="Search posts…" aria-label="Search posts" />
              <button class="s-btn s-btn-ghost">Search</button>
            </form>
            {tags.length > 0 && (
              <div class="s-tags s-tag-filter">
                <a class={`s-badge ${!opts.tag ? 'on' : ''}`} href={`${b}/archive`}>All</a>
                {tags.map((t) => <a class={`s-badge ${opts.tag === t.slug ? 'on' : ''}`} href={`${b}/tag/${t.slug}`}>{t.name} <small>{t.n}</small></a>)}
              </div>
            )}
            {opts.q && <p class="s-muted">{total} {total === 1 ? 'result' : 'results'} for “{opts.q}”</p>}
            {posts.length ? <div class="s-posts">{raw(posts.map((p) => postCard(b, p, false, pub.timezone)).join(''))}</div> : <div class="s-empty"><p class="s-muted">No posts found.</p></div>}
            {pages > 1 && (
              <nav class="s-pager">
                {page > 1 ? <a class="s-btn s-btn-ghost" href={qs(page - 1)}>← Newer</a> : <span />}
                <span class="s-muted s-small">Page {page} of {pages}</span>
                {page < pages ? <a class="s-btn s-btn-ghost" href={qs(page + 1)}>Older →</a> : <span />}
              </nav>
            )}
          </div>
        </section>
      ),
    }),
  );
}

site.get('/archive', (c) => listing(c, { title: 'Archive', path: '/archive', q: str(c.req.query('q'), 200) || undefined, tag: str(c.req.query('tag'), 100) || undefined, description: `Every post from ${c.get('pub').name}` }));
site.get('/search', (c) => listing(c, { title: 'Search', path: '/search', q: str(c.req.query('q'), 200) || '' }));
site.get('/tag/:tag', async (c) => {
  const t = await one<any>(c.env, 'SELECT * FROM content_tags WHERE pub_id = ? AND slug = ?', c.get('pub').id, c.req.param('tag'));
  if (!t) return SiteMessage(c, 'Tag not found', <p><a href={base(c) + '/archive'}>Browse the archive</a></p>, 404);
  return listing(c, { title: t.name, path: `/tag/${t.slug}`, tag: t.slug, description: t.description || `Posts tagged ${t.name}`, heading: <header class="s-page-head"><p class="s-muted s-small">Tag</p><h1 class="s-page-title">{t.name}</h1>{t.description && <p class="s-muted">{t.description}</p>}</header> });
});

site.get('/authors/:id', async (c) => {
  const pub = c.get('pub');
  const a = await one<any>(c.env, `SELECT u.* FROM users u WHERE u.id = ? AND (EXISTS (SELECT 1 FROM post_authors pa JOIN posts p ON p.id = pa.post_id WHERE pa.user_id = u.id AND p.pub_id = ?) OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.workspace_id = ?))`, c.req.param('id'), pub.id, pub.workspace_id);
  if (!a) return SiteMessage(c, 'Author not found', <p><a href={base(c) + '/'}>Home</a></p>, 404);
  const socials = parseJSON<Record<string, string>>(a.socials, {});
  const heading = (
    <header class="s-author-head">
      {a.avatar_url ? <img src={a.avatar_url} alt="" width="96" height="96" /> : <span class="s-avatar s-avatar-xl">{(a.name || '?').slice(0, 1)}</span>}
      <h1 class="s-page-title">{a.name}</h1>
      {a.bio && <p class="s-muted">{a.bio}</p>}
      <div class="s-socials">{Object.entries(socials).filter(([, v]) => v).map(([k, v]) => <a href={/^https?:/.test(v) ? v : k === 'x' || k === 'twitter' ? `https://x.com/${v.replace('@', '')}` : v} target="_blank" rel="noopener me">{k}</a>)}</div>
    </header>
  );
  return listing(c, { title: a.name, path: `/authors/${a.id}`, where: 'EXISTS (SELECT 1 FROM post_authors pa WHERE pa.post_id = p.id AND pa.user_id = ?)', params: [a.id], heading, description: a.bio || `Posts by ${a.name}` });
});

// ───────── Feeds, sitemaps, robots ─────────
const xmlEsc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

site.get('/feed.xml', async (c) => {
  const pub = c.get('pub');
  const b = base(c);
  const posts = await all<Post>(c.env, `SELECT * FROM posts WHERE pub_id = ? AND ${PUBLIC_POSTS} ORDER BY published_at DESC LIMIT 30`, pub.id);
  const items: string[] = [];
  for (const p of posts) {
    const doc = parseDoc(p.content);
    let content: string;
    if (p.audience === 'all') content = (await renderDoc(doc, { env: c.env, mode: 'web', pub, siteUrl: b, post: p, access: false })).html;
    else content = `<p>${esc(p.subtitle || p.preview_text || excerpt(doc, 300))}</p><p><a href="${b}/p/${p.slug}">Read the full post →</a></p>`;
    const authors = await all<{ name: string }>(c.env, 'SELECT u.name FROM post_authors pa JOIN users u ON u.id = pa.user_id WHERE pa.post_id = ?', p.id);
    items.push(`<item><title>${xmlEsc(p.title)}</title><link>${b}/p/${xmlEsc(p.slug)}</link><guid isPermaLink="false">${xmlEsc(p.id)}</guid><pubDate>${new Date(p.published_at || p.created_at).toUTCString()}</pubDate>${authors.map((a) => `<dc:creator>${xmlEsc(a.name)}</dc:creator>`).join('')}<description>${xmlEsc(p.subtitle || excerpt(doc))}</description>${p.thumbnail_url ? `<enclosure url="${xmlEsc(p.thumbnail_url)}" type="image/jpeg" length="0"/>` : ''}<content:encoded>${cdata(content)}</content:encoded></item>`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${xmlEsc(pub.name)}</title><link>${b}/</link><description>${xmlEsc(pub.description)}</description><language>${xmlEsc(pub.language)}</language><atom:link href="${b}/feed.xml" rel="self" type="application/rss+xml"/>${pub.logo_url ? `<image><url>${xmlEsc(pub.logo_url)}</url><title>${xmlEsc(pub.name)}</title><link>${b}/</link></image>` : ''}<lastBuildDate>${new Date(posts[0]?.published_at || now()).toUTCString()}</lastBuildDate>${items.join('')}</channel></rss>`;
  return c.body(xml, 200, { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=300' });
});

site.get('/sitemap.xml', async (c) => {
  const pub = c.get('pub');
  const b = base(c);
  const iso = (t: number) => new Date(t).toISOString();
  const urls: Array<[string, number?]> = [[`${b}/`, now()], [`${b}/archive`]];
  for (const p of await all<any>(c.env, `SELECT slug, updated_at FROM posts WHERE pub_id = ? AND status = 'published' AND platform != 'email' ORDER BY published_at DESC LIMIT 5000`, pub.id)) urls.push([`${b}/p/${p.slug}`, p.updated_at]);
  for (const p of await all<any>(c.env, `SELECT slug, updated_at, seo FROM pages WHERE pub_id = ? AND status = 'published' AND slug != ''`, pub.id)) if (!parseJSON<any>(p.seo, {}).noindex) urls.push([`${b}/${p.slug}`, p.updated_at]);
  for (const t of await all<any>(c.env, `SELECT DISTINCT t.slug FROM content_tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE t.pub_id = ?`, pub.id)) urls.push([`${b}/tag/${t.slug}`]);
  for (const a of await all<any>(c.env, `SELECT DISTINCT pa.user_id FROM post_authors pa JOIN posts p ON p.id = pa.post_id WHERE p.pub_id = ? AND p.status = 'published'`, pub.id)) urls.push([`${b}/authors/${a.user_id}`]);
  const shows = await all<any>(c.env, `SELECT id, slug FROM podcasts WHERE pub_id = ?`, pub.id);
  if (shows.length) urls.push([`${b}/podcasts`]);
  for (const s of shows) {
    urls.push([`${b}/podcasts/${s.slug}`]);
    for (const e of await all<any>(c.env, `SELECT slug, updated_at FROM episodes WHERE podcast_id = ? AND status = 'published' LIMIT 2000`, s.id)) urls.push([`${b}/podcasts/${s.slug}/${e.slug}`, e.updated_at]);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(([u, t]) => `<url><loc>${xmlEsc(u)}</loc>${t ? `<lastmod>${iso(t)}</lastmod>` : ''}</url>`).join('')}</urlset>`;
  return c.body(xml, 200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' });
});

site.get('/news-sitemap.xml', async (c) => {
  const pub = c.get('pub');
  const b = base(c);
  const posts = settings(pub).google_news === false ? [] : await all<any>(c.env, `SELECT slug, title, published_at FROM posts WHERE pub_id = ? AND status = 'published' AND platform != 'email' AND published_at > ? ORDER BY published_at DESC LIMIT 1000`, pub.id, now() - 2 * DAY);
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">${posts.map((p) => `<url><loc>${xmlEsc(`${b}/p/${p.slug}`)}</loc><news:news><news:publication><news:name>${xmlEsc(pub.name)}</news:name><news:language>${xmlEsc(pub.language || 'en')}</news:language></news:publication><news:publication_date>${new Date(p.published_at).toISOString()}</news:publication_date><news:title>${xmlEsc(p.title)}</news:title></news:news></url>`).join('')}</urlset>`;
  return c.body(xml, 200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=600' });
});

/** robots.txt user-agent tokens for crawler names used by guard.ts */
export const ROBOT_TOKENS: Record<string, string> = { 'Meta-AI': 'meta-externalagent', 'Link preview': '' };
export const AI_CRAWLERS = ['GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'CCBot', 'Bytespider', 'Applebot-Extended', 'Meta-AI', 'cohere-ai', 'Amazonbot', 'Diffbot'];

export function buildRobots(pub: Publication, b: string): string {
  const cfg = settings(pub);
  const blocked = new Set<string>(cfg.blocked_crawlers || []);
  if (cfg.block_ai_crawlers) AI_CRAWLERS.forEach((x) => blocked.add(x));
  const lines: string[] = [];
  if (cfg.robots_txt && String(cfg.robots_txt).trim()) lines.push(String(cfg.robots_txt).trim());
  else lines.push('User-agent: *', 'Allow: /', 'Disallow: /account', 'Disallow: /search', 'Disallow: /login');
  for (const name of blocked) {
    const tok = ROBOT_TOKENS[name] ?? name;
    if (tok) lines.push('', `User-agent: ${tok}`, 'Disallow: /');
  }
  lines.push('', `Sitemap: ${b}/sitemap.xml`);
  if (cfg.google_news !== false) lines.push(`Sitemap: ${b}/news-sitemap.xml`);
  return lines.join('\n') + '\n';
}

site.get('/robots.txt', (c) => c.body(buildRobots(c.get('pub'), base(c)), 200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=600' }));

// ───────── Reader account ─────────
site.get('/account', async (c) => {
  const pub = c.get('pub');
  const b = base(c);
  const reader = c.get('reader');
  c.header('Cache-Control', 'private, no-store');
  if (!reader) {
    return SiteMessage(c, 'Your account', (
      <div class="s-stack">
        <p class="s-muted">Log in with your email — we'll send you a secure, single-use link.</p>
        <form method="post" action={b + '/login'} class="s-form" style="justify-content:center">
          <input type="email" name="email" placeholder="you@example.com" required />
          <input type="hidden" name="next" value="/account" />
          <button class="s-btn">Email me a login link</button>
        </form>
      </div>
    ));
  }
  const sub = reader.subscriber;
  const lists = sub ? await all<any>(c.env, `SELECT l.*, lm.status AS member FROM lists l LEFT JOIN list_members lm ON lm.list_id = l.id AND lm.subscriber_id = ? WHERE l.pub_id = ? AND l.public = 1 ORDER BY l.created_at`, sub.id, pub.id) : [];
  const subscription = sub ? await one<any>(c.env, `SELECT s.*, t.name AS tier_name FROM subscriptions s LEFT JOIN tiers t ON t.id = s.tier_id WHERE s.subscriber_id = ? ORDER BY s.created_at DESC LIMIT 1`, sub.id) : null;
  return c.html(
    await SiteLayout({
      c, title: 'Your account', noindex: true,
      children: (
        <section class="s-section">
          <div class="s-wrap s-narrow s-stack">
            <h1 class="s-page-title">Your account</h1>
            <div class="s-box">
              <dl class="s-kv">
                <dt>Email</dt><dd>{reader.email}</dd>
                <dt>Status</dt><dd>{sub ? (sub.status === 'active' ? 'Subscribed' : sub.status) : 'Not subscribed'}</dd>
                <dt>Plan</dt><dd>{reader.premium ? `Premium${subscription?.tier_name ? ` — ${subscription.tier_name}` : ''}` : 'Free'}{subscription?.status && subscription.status !== 'active' ? ` (${subscription.status})` : ''}</dd>
                {sub && <><dt>Member since</dt><dd>{fmtDate(sub.created_at, { dateStyle: 'long' })}</dd></>}
              </dl>
              <div class="s-row">
                {!sub || sub.status !== 'active' ? (
                  <form method="post" action={b + '/subscribe'}><input type="hidden" name="email" value={reader.email} /><input type="hidden" name="_t" value={String(Date.now() - 5000)} /><input type="hidden" name="source" value="account" /><button class="s-btn">Subscribe to {pub.name}</button></form>
                ) : reader.premium ? (
                  <a class="s-btn s-btn-ghost" href={b + '/subscription'}>Manage subscription</a>
                ) : (
                  <a class="s-btn" href={b + '/upgrade'}>Upgrade to premium</a>
                )}
                {sub && <a class="s-btn s-btn-ghost" href={b + '/referrals'}>Refer friends</a>}
              </div>
            </div>
            {sub && lists.length > 0 && (
              <form class="s-box" method="post" action={b + '/account/lists'}>
                <h3>Newsletters</h3>
                {lists.map((l) => <label class="s-check"><input type="checkbox" name="lists[]" value={l.id} checked={l.member === 'subscribed'} /> <span><strong>{l.name}</strong>{l.description && <small class="s-muted"> — {l.description}</small>}</span></label>)}
                <button class="s-btn s-btn-ghost">Save</button>
              </form>
            )}
            <form method="post" action={b + '/logout'}><button class="s-link">Log out</button></form>
          </div>
        </section>
      ),
    }),
  );
});

site.post('/account/lists', async (c) => {
  const pub = c.get('pub');
  const sub = c.get('reader')?.subscriber;
  if (!sub) return c.redirect(base(c) + '/account', 303);
  const f = await form(c.req);
  const chosen: string[] = f.lists || [];
  const lists = await all<{ id: string }>(c.env, 'SELECT id FROM lists WHERE pub_id = ? AND public = 1', pub.id);
  await joinLists(c.env, pub.id, sub.id, lists.filter((l) => chosen.includes(l.id)).map((l) => l.id));
  await leaveLists(c.env, pub.id, sub.id, lists.filter((l) => !chosen.includes(l.id)).map((l) => l.id));
  flash(c, 'Newsletter preferences saved');
  return c.redirect(base(c) + '/account', 303);
});

// ───────── Legal defaults ─────────
async function legal(c: Ctx, kind: 'privacy' | 'terms') {
  const pub = c.get('pub');
  const custom = await one<any>(c.env, `SELECT * FROM pages WHERE pub_id = ? AND slug = ? AND status = 'published'`, pub.id, kind);
  if (custom) return renderPage(c, custom);
  const n = esc(pub.name);
  const body = kind === 'privacy'
    ? `<h2>What we collect</h2><p>When you subscribe to ${n} we store your email address, optional name, subscription preferences and basic engagement data (opens and clicks) so we can deliver the newsletter and improve it.</p><h2>How we use it</h2><p>We use your information only to send you ${n}, manage your subscription and account, process payments you make, and understand what content readers find valuable. We never sell your data.</p><h2>Cookies</h2><p>We use essential cookies to keep you logged in and to remember your preferences, and privacy-friendly analytics to count visits.</p><h2>Your rights</h2><p>You can unsubscribe at any time using the link in every email, update your preferences from your account page, or ask us to delete your data by replying to any email.</p>${pub.address ? `<h2>Contact</h2><p>${esc(pub.address)}</p>` : ''}`
    : `<h2>Using ${n}</h2><p>By subscribing to or using ${n} you agree to these terms. The content is provided for informational purposes and may not be republished without permission.</p><h2>Paid subscriptions</h2><p>Paid plans renew automatically until cancelled. You can cancel or pause at any time from your account; access continues until the end of the current billing period.</p><h2>Community guidelines</h2><p>Be respectful in comments and community spaces. We may remove content or suspend accounts that harass others or break the law.</p><h2>Changes</h2><p>We may update these terms; continued use means you accept the updated terms.</p>`;
  cacheHeaders(c, false);
  return c.html(await SiteLayout({ c, title: kind === 'privacy' ? 'Privacy policy' : 'Terms of service', children: <article class="s-article"><h1>{kind === 'privacy' ? 'Privacy policy' : 'Terms of service'}</h1><p class="s-muted">Last updated {fmtDate(pub.created_at, { dateStyle: 'long' })}</p><div class="s-body">{raw(body)}</div></article> }));
}
site.get('/privacy', (c) => legal(c, 'privacy'));
site.get('/terms', (c) => legal(c, 'terms'));

// ───────── Custom pages ─────────
export async function renderPage(c: Ctx, page: any, opts: { preview?: boolean } = {}): Promise<Response> {
  const pub = c.get('pub');
  const b = base(c);
  const reader = c.get('reader');
  const seo = parseJSON<any>(page.seo, {});
  let locked: 'subscribers' | 'premium' | null = null;
  if (!opts.preview) {
    if (page.paywall === 'subscribers' && !(reader?.subscriber?.status === 'active' || reader?.premium)) locked = 'subscribers';
    if (page.paywall === 'premium' && !reader?.premium) locked = 'premium';
  }
  let inner: string;
  if (locked) {
    inner = `<section class="pb" style="padding:64px 0"><div class="pb-in" style="max-width:640px"><div class="oh-paywall s-gate"><h3>${locked === 'premium' ? 'This page is for premium subscribers' : 'This page is for subscribers'}</h3><p>${locked === 'premium' ? 'Upgrade to unlock it.' : 'Subscribe for free to view it.'}</p>${locked === 'premium' ? `<a class="s-btn" href="${esc(b)}/upgrade">Upgrade</a>` : `<button type="button" class="s-btn" data-modal="subscribe">Subscribe</button>`} <button type="button" class="s-btn s-btn-ghost" data-modal="login">Log in</button></div></div></section>`;
  } else if (page.html_override) {
    inner = `<div class="pb-html">${sanitizeHtml(page.html_override, { blocks: true, media: true, styles: true })}</div>`;
  } else {
    inner = await renderSections(c, pub, parseSections(page.content));
  }
  if (!opts.preview) await trackView(c, page.id);
  cacheHeaders(c, opts.preview || !!locked || page.paywall !== 'none');
  const firstText = parseSections(page.content).map((s) => s.data?.subtitle || s.data?.body || '').find(Boolean);
  return c.html(
    await SiteLayout({
      c, title: page.slug === '' ? seo.title || undefined : seo.title || page.title, description: seo.description || firstText || pub.description, image: seo.og_image || null,
      canonical: seo.canonical || `${b}/${page.slug}`, noindex: !!seo.noindex || opts.preview, bodyClass: 'has-pb',
      children: <div class="pb-page">{raw(inner)}</div>,
    }),
  );
}

site.get('/:page{[a-z0-9][a-z0-9-]*}', async (c) => {
  const page = await one<any>(c.env, `SELECT * FROM pages WHERE pub_id = ? AND slug = ? AND status = 'published'`, c.get('pub').id, c.req.param('page'));
  if (!page) return SiteMessage(c, 'Page not found', <p>We couldn't find that page. <a href={base(c) + '/'}>Go home</a></p>, 404);
  return renderPage(c, page);
});

export default site;
