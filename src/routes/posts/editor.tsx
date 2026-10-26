/** @jsxImportSource hono/jsx */
// Post editor page + JSON endpoints (autosave, preview, send flow, comments, versions, pickers).
import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { AppEnv, Ctx, Post, Subscriber } from '../../types';
import { all, one, run, insert, val } from '../../lib/db';
import { can, audit } from '../../lib/auth';
import { emit } from '../../lib/events';
import { kick } from '../../lib/jobs';
import { ruleCatalog } from '../../lib/catalog';
import { countRecipients, publishPost, sendTest, buildEmail, postContent, type SendOptions } from '../../lib/sender';
import { checkSend, SendBlockedError, LIMITS } from '../../lib/plans';
import { rampRemaining, needsApproval } from '../../lib/safety';
import { parseDoc, renderDoc, GMAIL_CLIP_BYTES, htmlToText, parseEmbed, resolveBlueskyDid } from '../../lib/render';
import { siteUrl, senderFor } from '../../lib/pub';
import { validateEmail } from '../../lib/guard';
import { aiSpeech, aiEnabled, mediaUrl, AI_DISABLED_MSG } from '../../lib/ai';
import { DashLayout } from '../../ui/layout';
import { Json, back, Badge } from '../../ui/components';
import { icon } from '../../ui/icons';
import { id, now, parseJSON, slugify, str, esc, fmtDateTime, MIN } from '../../lib/util';
import { loadPost, wordCount, uniqueSlug, snapshot, renderPreview, simulatedSubscriber, autoSeo, postAuthors, authorChoices, webPage, walkBlocks, type Simulate } from './shared';
import { duplicatePost } from './list';

const app = new Hono<AppEnv>();

const FONT_OPTIONS: Array<[string, string]> = [
  ['', 'Default'],
  ["-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif", 'System sans'],
  ["Georgia, 'Times New Roman', serif", 'Georgia (serif)'],
  ["'Helvetica Neue', Helvetica, Arial, sans-serif", 'Helvetica'],
  ["Verdana, Geneva, sans-serif", 'Verdana'],
  ["'Trebuchet MS', Tahoma, sans-serif", 'Trebuchet'],
  ["'Courier New', Courier, monospace", 'Courier (mono)'],
  ['Inter, -apple-system, sans-serif', 'Inter (web)'],
  ['Lora, Georgia, serif', 'Lora (web)'],
  ['Merriweather, Georgia, serif', 'Merriweather (web)'],
  ["'Playfair Display', Georgia, serif", 'Playfair Display (web)'],
  ["'DM Sans', sans-serif", 'DM Sans (web)'],
];

export const EMAIL_TOKENS: Array<[string, string, string]> = [
  ['font', 'Body font', 'font'], ['heading_font', 'Heading font', 'font'], ['font_size', 'Font size (px)', 'number'], ['line_height', 'Line height', 'number'],
  ['text', 'Text color', 'color'], ['muted', 'Muted text', 'color'], ['bg', 'Background', 'color'], ['content_bg', 'Content background', 'color'], ['accent', 'Accent', 'color'], ['link', 'Links', 'color'],
  ['button_bg', 'Button background', 'color'], ['button_text', 'Button text', 'color'], ['border', 'Borders', 'color'], ['radius', 'Corner radius (px)', 'number'], ['width', 'Email width (px)', 'number'], ['spacing', 'Block spacing (px)', 'number'],
];
export const WEB_TOKENS: Array<[string, string, string]> = [
  ['font', 'Body font', 'font'], ['heading_font', 'Heading font', 'font'], ['text', 'Text color', 'color'], ['bg', 'Background', 'color'], ['accent', 'Accent', 'color'], ['accent_text', 'Text on accent', 'color'],
];

/** Style token editor (shared by posts and templates). name prefix: style_email_ / style_web_ */
export function StyleFields(p: { style: any }) {
  const s = p.style || {};
  const field = (scope: 'email' | 'web', [k, label, kind]: [string, string, string]) => {
    const v = s[scope]?.[k] ?? '';
    const name = `style_${scope}_${k}`;
    if (kind === 'font') return <label class="field"><span class="field-l">{label}</span><select class="input" name={name}>{FONT_OPTIONS.map(([fv, fl]) => <option value={fv} selected={fv === v}>{fl}</option>)}</select></label>;
    if (kind === 'color') return <label class="field pe-color"><span class="field-l">{label}</span><span class="row" style="flex-wrap:nowrap"><input type="color" class="input" value={/^#[0-9a-f]{6}$/i.test(v) ? v : '#000000'} data-color-for={name} /><input class="input" name={name} value={v} placeholder="default" /></span></label>;
    return <label class="field"><span class="field-l">{label}</span><input class="input" type="number" step="any" name={name} value={v} placeholder="default" /></label>;
  };
  return (
    <div>
      <h4>Email</h4>
      <div class="pe-grid2">{EMAIL_TOKENS.map((t) => field('email', t))}</div>
      <h4 style="margin-top:12px">Web</h4>
      <div class="pe-grid2">{WEB_TOKENS.map((t) => field('web', t))}</div>
    </div>
  );
}

export function styleFromMeta(m: Record<string, any>): { email: Record<string, any>; web: Record<string, any> } {
  const out: any = { email: {}, web: {} };
  for (const [scope, list] of [['email', EMAIL_TOKENS], ['web', WEB_TOKENS]] as const) {
    for (const [k, , kind] of list) {
      const v = m[`style_${scope}_${k}`];
      if (v === undefined || v === null || String(v).trim() === '') continue;
      out[scope][k] = kind === 'number' ? Number(v) : String(v).slice(0, 200);
    }
  }
  return out;
}

const arr = (v: any): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : v ? [String(v)] : []);

// ───────── Editor page ─────────
app.get('/:id/edit', async (c) => {
  const pub = c.get('pub');
  const post = await loadPost(c, c.req.param('id'));
  if (!post) return c.notFound();
  const role = c.get('role');
  const user = c.get('user');
  const canPublish = can(role, 'publish');
  const [catalog, authors, choices, tags, postTags, senders, lists, tiers, segments, subs, versions, defaultSender] = await Promise.all([
    ruleCatalog(c.env, pub.id),
    postAuthors(c.env, post.id),
    authorChoices(c.env, pub),
    all<{ id: string; name: string }>(c.env, 'SELECT id, name FROM content_tags WHERE pub_id = ? ORDER BY name', pub.id),
    all<{ tag_id: string }>(c.env, 'SELECT tag_id FROM post_tags WHERE post_id = ?', post.id),
    all<{ id: string; email: string; name: string; purpose: string }>(c.env, 'SELECT id, email, name, purpose FROM sender_addresses WHERE pub_id = ? ORDER BY is_default DESC', pub.id),
    all<{ id: string; name: string }>(c.env, 'SELECT id, name FROM lists WHERE pub_id = ? ORDER BY is_default DESC, name', pub.id),
    all<{ id: string; name: string }>(c.env, `SELECT id, name FROM tiers WHERE pub_id = ? AND status != 'archived' ORDER BY position`, pub.id),
    all<{ id: string; name: string; cached_count: number }>(c.env, 'SELECT id, name, cached_count FROM segments WHERE pub_id = ? ORDER BY name', pub.id),
    all<{ id: string; email: string; name: string; tier: string }>(c.env, `SELECT id, email, name, tier FROM subscribers WHERE pub_id = ? AND status = 'active' ORDER BY engagement DESC, created_at DESC LIMIT 50`, pub.id),
    all<{ id: string; title: string; created_at: number; name: string | null }>(c.env, 'SELECT v.id, v.title, v.created_at, u.name FROM post_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.post_id = ? ORDER BY v.created_at DESC LIMIT 50', post.id),
    senderFor(c.env, pub, 'newsletter'),
  ]);
  const ab = parseJSON<any>(post.ab_test, null);
  const cohort = parseJSON<any>(post.cohort_test, null);
  const seo = parseJSON<any>(post.seo, {});
  const style = parseJSON<any>(post.style, {});
  const tierIds = parseJSON<string[]>(post.tier_ids, []);
  const segIds = parseJSON<string[]>(post.segment_ids, []);
  const exSegIds = parseJSON<string[]>(post.exclude_segment_ids, []);
  const tagIds = postTags.map((t) => t.tag_id);
  const authorIds = authors.map((a) => a.id);
  const surl = siteUrl(c.env, pub);
  const auto = autoSeo(post);
  const data = {
    post: { id: post.id, title: post.title, subtitle: post.subtitle, slug: post.slug, status: post.status, platform: post.platform, updated_at: post.updated_at, scheduled_at: post.scheduled_at, published_at: post.published_at, audio: post.audio_key ? mediaUrl(c.env, post.audio_key) : null },
    doc: parseDoc(post.content),
    me: { id: user.id, name: user.name || user.email },
    catalog,
    canPublish,
    siteUrl: surl,
    gmailClip: GMAIL_CLIP_BYTES,
    subscribers: subs,
    defaultSender,
    timezone: pub.timezone,
    aiEnabled: aiEnabled(c.env),
  };
  const sel = (v: string | null | undefined, o: string) => (v || '') === o;
  const statusLabel = post.status === 'scheduled' ? `Scheduled · ${fmtDateTime(post.scheduled_at, pub.timezone)}` : post.status;
  const primaryLabel = post.status === 'published' ? 'Update' : post.status === 'scheduled' ? 'Scheduled' : post.platform === 'web' ? 'Publish' : 'Send';
  return c.html(
    <DashLayout c={c} title={post.title || 'Untitled post'} section="posts" sub="posts" bare styles={['/static/editor.css']} scripts={['/static/editor.js', '/static/posts-edit.js', '/static/subject-helper.js']}>
      <div class="pe" id="pe">
        <header class="pe-top">
          <a href="/app/posts" class="btn btn-ghost btn-sm" aria-label="Back to posts">← Posts</a>
          <span id="pe-status-badge"><Badge tone={post.status === 'published' ? 'green' : post.status === 'scheduled' ? 'blue' : 'gray'}>{statusLabel}</Badge></span>
          <span class="pe-save" id="pe-save" aria-live="polite">Saved</span>
          <div class="pe-avatars" id="pe-avatars" aria-label="Collaborators" />
          <span class="grow" />
          <span class="pe-gauge" id="pe-gauge" title="Email size — Gmail clips emails over 102 KB"><span class="pe-gauge-bar"><i /></span><span class="pe-gauge-t">— KB</span></span>
          <span class="small muted" id="pe-words">0 words</span>
          <button type="button" class="btn btn-ghost btn-sm" data-gif aria-label="Insert GIF" title="Insert a GIF">GIF</button>
          <button type="button" class="btn btn-ghost btn-sm" data-open="#pe-find" aria-label="Find and replace" title="Find & replace (⌘F)">{raw(icon('search', 16))}</button>
          <button type="button" class="btn btn-secondary btn-sm" id="pe-preview-btn">{raw(icon('eye', 16))} Preview</button>
          {canPublish ? (
            <button type="button" class="btn btn-primary btn-sm" id="pe-send-btn">{primaryLabel}</button>
          ) : (
            <span class="small muted" title="Contributors can draft; a member publishes">Draft only</span>
          )}
          <details class="pe-more">
            <summary class="btn btn-ghost btn-sm" aria-label="More actions">•••</summary>
            <div class="pe-more-menu">
              {post.status === 'published' && <a href={`/app/posts/${post.id}`}>View analytics</a>}
              {post.status === 'published' && post.platform !== 'email' && <a href={`${surl}/p/${post.slug}`} target="_blank">View on website ↗</a>}
              <form method="post" action={`/app/posts/${post.id}/duplicate`}><button>Duplicate</button></form>
              <form method="post" action={`/app/posts/${post.id}/save-template`}><button>Save as template</button></form>
              {canPublish && <form method="post" action={`/app/posts/${post.id}/audio`}><button>{post.audio_key ? 'Regenerate audio version' : 'Generate audio version'}</button></form>}
              {canPublish && post.status === 'scheduled' && <form method="post" action={`/app/posts/${post.id}/unschedule`}><button>Cancel schedule</button></form>}
              {canPublish && post.status === 'published' && <form method="post" action={`/app/posts/${post.id}/unpublish`}><button data-confirm="Unpublish? The post will be removed from your website.">Unpublish from web</button></form>}
              {canPublish && post.status !== 'archived' && <form method="post" action={`/app/posts/${post.id}/archive`}><button>Archive</button></form>}
              <form method="post" action={`/app/posts/${post.id}/delete`}><button class="danger" data-confirm="Delete this post permanently?">Delete</button></form>
            </div>
          </details>
        </header>
        <div class="pe-body">
          <main class="pe-canvas" id="pe-canvas">
            <div class="pe-paper">
              {post.thumbnail_url && <img class="pe-thumb" src={post.thumbnail_url} alt="" id="pe-thumb-img" />}
              <textarea id="pe-title" class="pe-title" rows={1} placeholder="Title" aria-label="Title">{post.title}</textarea>
              <textarea id="pe-subtitle" class="pe-subtitle" rows={1} placeholder="Add a subtitle…" aria-label="Subtitle">{post.subtitle}</textarea>
              <div class="pe-byline small muted">{authors.map((a) => a.name).join(', ') || user.name}</div>
              <div id="pe-editor" />
            </div>
          </main>
          <aside class="pe-side">
            <nav class="pe-tabs" role="tablist">
              {[['settings', 'Settings'], ['email', 'Email'], ['audience', 'Audience'], ['seo', 'SEO'], ['style', 'Style'], ['comments', 'Comments'], ['history', 'History']].map(([k, l], i) => (
                <button type="button" role="tab" data-tab={k} class={i === 0 ? 'on' : ''}>{l}{k === 'comments' && <span class="pe-count" id="pe-comment-count" />}</button>
              ))}
            </nav>
            <form id="pe-meta" class="pe-panels" onsubmit="return false">
              <section data-panel="settings" class="on">
                <label class="field"><span class="field-l">URL slug</span><span class="pe-slug"><span class="muted small">/p/</span><input class="input" name="slug" value={post.slug} data-slug-touched={post.status !== 'draft' ? '1' : ''} /></span></label>
                <label class="field"><span class="field-l">Authors</span>
                  <select class="input" name="author_ids[]" multiple size={Math.min(6, Math.max(3, choices.length))}>
                    {choices.map((u) => <option value={u.id} selected={authorIds.includes(u.id)}>{u.name || u.email}{u.is_guest ? ' (guest)' : ''}</option>)}
                  </select>
                  <small class="field-h">Bylines appear in the order selected. <a href="#" id="pe-add-guest">+ Add guest author</a></small>
                </label>
                <label class="field"><span class="field-l">Content tags</span>
                  <select class="input" name="tag_ids[]" multiple size={Math.min(6, Math.max(3, tags.length))} id="pe-tags">
                    {tags.map((t) => <option value={t.id} selected={tagIds.includes(t.id)}>{t.name}</option>)}
                  </select>
                  <small class="field-h"><a href="#" id="pe-add-tag">+ New tag</a></small>
                </label>
                <div class="field"><span class="field-l">Thumbnail</span>
                  <input type="hidden" name="thumbnail_url" value={post.thumbnail_url || ''} id="pe-thumb" />
                  <div class="pe-thumb-box" id="pe-thumb-box">{post.thumbnail_url ? <img src={post.thumbnail_url} alt="" /> : <span class="muted small">Drop an image or click to upload</span>}</div>
                  <div class="row" style="margin-top:6px"><button type="button" class="btn btn-secondary btn-sm" id="pe-thumb-upload">Upload</button><button type="button" class="btn btn-ghost btn-sm" id="pe-thumb-library">Library</button><button type="button" class="btn btn-ghost btn-sm" id="pe-thumb-clear">Remove</button></div>
                </div>
                <label class="toggle"><input type="checkbox" name="comments_enabled" checked={!!post.comments_enabled} /><span class="toggle-ui" /><span>Allow comments</span></label>
                <label class="toggle"><input type="checkbox" name="hide_from_feed" checked={!!post.hide_from_feed} /><span class="toggle-ui" /><span>Hide from website feed<small class="field-h">Still reachable by direct link.</small></span></label>
                {post.audio_key && <div class="field"><span class="field-l">Audio version</span><audio controls preload="none" src={mediaUrl(c.env, post.audio_key)} style="width:100%" /></div>}
              </section>

              <section data-panel="email">
                <label class="field"><span class="field-l">Subject line</span><input class="input" name="email_subject" value={post.email_subject || ''} placeholder={post.title || 'Defaults to the title'} maxlength={200} /><small class="field-h">Merge tags work here, e.g. {'{{subscriber.first_name|Friend}}'}</small></label>
                <label class="field"><span class="field-l">Preview text</span><input class="input" name="preview_text" value={post.preview_text} placeholder="Shown after the subject in the inbox" maxlength={200} /></label>
                <label class="field"><span class="field-l">From</span>
                  <select class="input" name="sender_id">
                    <option value="">{defaultSender.name} &lt;{defaultSender.email}&gt; (default)</option>
                    {senders.map((s) => <option value={s.id} selected={post.sender_id === s.id}>{s.name} &lt;{s.email}&gt; · {s.purpose}</option>)}
                  </select>
                  <small class="field-h"><a href="/app/settings/email">Manage sender addresses</a></small>
                </label>
                <div class="pe-box">
                  <label class="toggle"><input type="checkbox" name="ab_enabled" checked={!!ab?.subjects?.length} data-reveal="#pe-ab" /><span class="toggle-ui" /><span><strong>A/B test subject lines</strong><small class="field-h">Send variants to a sample, then the winner to everyone else.</small></span></label>
                  <div id="pe-ab" class={ab?.subjects?.length ? '' : 'hide'}>
                    {[0, 1, 2, 3].map((i) => <label class="field"><span class="field-l">Subject {String.fromCharCode(65 + i)}{i < 2 ? '' : ' (optional)'}</span><input class="input" name="ab_subjects[]" value={ab?.subjects?.[i] || ''} maxlength={200} /></label>)}
                    <div class="pe-grid2">
                      <label class="field"><span class="field-l">Sample size %</span><input class="input" type="number" min="2" max="50" name="ab_sample" value={ab?.sample_pct ?? 20} /></label>
                      <label class="field"><span class="field-l">Wait (minutes)</span><input class="input" type="number" min="10" max="1440" name="ab_wait" value={ab?.wait_minutes ?? 60} /></label>
                    </div>
                    <label class="field"><span class="field-l">Winner chosen by</span><select class="input" name="ab_metric"><option value="opens" selected={ab?.metric !== 'clicks'}>Open rate</option><option value="clicks" selected={ab?.metric === 'clicks'}>Click rate</option></select></label>
                    {ab?.winner && <p class="small">Winner: <strong>Subject {ab.winner}</strong></p>}
                  </div>
                </div>
                <div class="pe-box">
                  <label class="toggle"><input type="checkbox" name="cohort_enabled" checked={!!cohort?.cohorts?.length} data-reveal="#pe-cohort" /><span class="toggle-ui" /><span><strong>Random cohort test</strong><small class="field-h">Randomly split the list into cohorts. Use dynamic content blocks with a cohort rule to show different content to each.</small></span></label>
                  <div id="pe-cohort" class={cohort?.cohorts?.length ? '' : 'hide'}>
                    {[0, 1, 2, 3].map((i) => (
                      <div class="pe-grid2">
                        <label class="field"><span class="field-l">Cohort name</span><input class="input" name="cohort_names[]" value={cohort?.cohorts?.[i]?.name ?? (i < 2 ? String.fromCharCode(65 + i) : '')} /></label>
                        <label class="field"><span class="field-l">% of list</span><input class="input" type="number" min="0" max="100" name="cohort_pcts[]" value={cohort?.cohorts?.[i]?.pct ?? (i < 2 ? 50 : '')} /></label>
                      </div>
                    ))}
                  </div>
                </div>
              </section>

              <section data-panel="audience">
                <label class="field"><span class="field-l">Publish to</span>
                  <select class="input" name="platform">
                    <option value="both" selected={sel(post.platform, 'both')}>Email and website</option>
                    <option value="email" selected={sel(post.platform, 'email')}>Email only</option>
                    <option value="web" selected={sel(post.platform, 'web')}>Website only</option>
                  </select>
                </label>
                <label class="field"><span class="field-l">Audience</span>
                  <select class="input" name="audience">
                    <option value="all" selected={sel(post.audience, 'all')}>Everyone (free + premium)</option>
                    <option value="free" selected={sel(post.audience, 'free')}>Free subscribers only</option>
                    <option value="premium" selected={sel(post.audience, 'premium')}>Premium subscribers only</option>
                  </select>
                  <small class="field-h">Use a paywall break block to give free readers a preview.</small>
                </label>
                {tiers.length > 0 && <label class="field"><span class="field-l">Only these paid tiers</span><select class="input" name="tier_ids[]" multiple>{tiers.map((t) => <option value={t.id} selected={tierIds.includes(t.id)}>{t.name}</option>)}</select></label>}
                {lists.length > 0 && <label class="field"><span class="field-l">Newsletter list</span><select class="input" name="list_id"><option value="">All subscribers</option>{lists.map((l) => <option value={l.id} selected={post.list_id === l.id}>{l.name}</option>)}</select></label>}
                <label class="field"><span class="field-l">Send to segments</span><select class="input" name="segment_ids[]" multiple size={Math.min(6, Math.max(3, segments.length))}>{segments.map((s) => <option value={s.id} selected={segIds.includes(s.id)}>{s.name}</option>)}</select><small class="field-h">Leave empty to send to everyone in the audience.</small></label>
                <label class="field"><span class="field-l">Exclude segments</span><select class="input" name="exclude_segment_ids[]" multiple size={Math.min(6, Math.max(3, segments.length))}>{segments.map((s) => <option value={s.id} selected={exSegIds.includes(s.id)}>{s.name}</option>)}</select></label>
                <div class="pe-recipients"><span class="stat-l">Estimated recipients</span><strong id="pe-recipients">…</strong></div>
              </section>

              <section data-panel="seo">
                <label class="field"><span class="field-l">Meta title</span><input class="input" name="seo_title" value={seo.title || ''} placeholder={auto.title} maxlength={120} /></label>
                <label class="field"><span class="field-l">Meta description</span><textarea class="input" name="seo_description" rows={3} placeholder={auto.description} maxlength={300}>{seo.description || ''}</textarea><small class="field-h">Auto-generated from your post when left empty.</small></label>
                <label class="field"><span class="field-l">Social image URL</span><input class="input" name="og_image" value={seo.og_image || ''} placeholder="Defaults to the thumbnail" /></label>
                <label class="field"><span class="field-l">Canonical URL</span><input class="input" name="canonical" value={seo.canonical || ''} placeholder="Only if first published elsewhere" /></label>
                <label class="toggle"><input type="checkbox" name="noindex" checked={!!seo.noindex} /><span class="toggle-ui" /><span>Hide from search engines (noindex)</span></label>
                <div class="pe-serp" id="pe-serp">
                  <div class="pe-serp-url">{surl.replace(/^https?:\/\//, '')} › p › <span data-serp-slug>{post.slug}</span></div>
                  <div class="pe-serp-title" data-serp-title>{auto.title || 'Untitled'}</div>
                  <div class="pe-serp-desc" data-serp-desc>{auto.description}</div>
                </div>
              </section>

              <section data-panel="style">
                <p class="small muted">Overrides for this post. Defaults come from the template and your publication's email style.</p>
                <StyleFields style={style} />
              </section>

              <section data-panel="comments">
                <p class="small muted">Select a block and choose “Comment” from its menu, or comment on the whole draft.</p>
                <div id="pe-comments" />
                <div class="pe-comment-new">
                  <textarea class="input" id="pe-comment-body" rows={2} placeholder="Comment on this draft…" />
                  <div class="row between"><span class="small muted" id="pe-comment-target">On: whole post</span><button type="button" class="btn btn-secondary btn-sm" id="pe-comment-add">Comment</button></div>
                </div>
              </section>

              <section data-panel="history">
                <div class="row between"><p class="small muted" style="margin:0">Versions are saved on publish, manually, and every few minutes while you write.</p><button type="button" class="btn btn-secondary btn-sm" id="pe-snapshot">Save version</button></div>
                <ul class="list-plain" id="pe-versions">
                  {versions.map((v) => (
                    <li class="row between"><span><strong class="small">{fmtDateTime(v.created_at, pub.timezone)}</strong><br /><span class="small muted">{v.name || 'Autosave'} · {v.title || 'Untitled'}</span></span><span class="row"><button type="button" class="btn btn-ghost btn-sm" data-version-preview={v.id}>Preview</button><button type="button" class="btn btn-secondary btn-sm" data-version-restore={v.id}>Restore</button></span></li>
                  ))}
                </ul>
              </section>
            </form>
          </aside>
        </div>
      </div>

      <dialog id="pe-preview" class="modal pe-preview-modal">
        <header class="modal-h">
          <h3>Preview</h3>
          <div class="row">
            <div class="device-toggle" id="pe-pv-mode"><button type="button" data-mode="email" class="on">Email</button><button type="button" data-mode="web">Web</button></div>
            <div class="device-toggle" id="pe-pv-device"><button type="button" data-w="100%" class="on">Desktop</button><button type="button" data-w="390px">Mobile</button></div>
            <select class="input" id="pe-pv-as" style="width:auto" aria-label="View as">
              <option value="">View as: no subscriber (merge tags shown)</option>
              <option value="tier:free">Simulated free subscriber</option>
              <option value="tier:premium">Simulated premium subscriber</option>
              {subs.map((s) => <option value={`sub:${s.id}`}>{s.name || s.email} ({s.tier})</option>)}
            </select>
            <input class="input" id="pe-pv-name" placeholder="Simulated name" style="width:150px" />
          </div>
          <button type="button" class="btn btn-ghost btn-sm" data-close>✕</button>
        </header>
        <div class="pe-pv-meta small" id="pe-pv-meta" />
        <div class="pe-pv-wrap"><iframe id="pe-pv-frame" title="Preview" sandbox="allow-same-origin allow-popups allow-scripts" /></div>
      </dialog>

      <dialog id="pe-send" class="modal modal-wide">
        <header class="modal-h"><h3 id="pe-send-title">Review &amp; send</h3><button type="button" class="btn btn-ghost btn-sm" data-close>✕</button></header>
        <div class="modal-b">
          <div class="grid g2">
            <div>
              <ul class="pe-checklist" id="pe-checklist" />
              <div class="pe-box">
                <strong>Send a test</strong>
                <div class="row" style="margin-top:8px">
                  <input class="input grow" id="pe-test-to" placeholder="you@example.com, teammate@example.com" value={user.email} />
                  <select class="input" id="pe-test-as" style="width:auto"><option value="">As free reader</option><option value="premium">As premium reader</option>{subs.slice(0, 20).map((s) => <option value={`sub:${s.id}`}>As {s.name || s.email}</option>)}</select>
                  <button type="button" class="btn btn-secondary btn-sm" id="pe-test-send">Send test</button>
                </div>
              </div>
            </div>
            <div>
              <div class="pe-box">
                <strong>When</strong>
                <label class="check" style="margin-top:8px"><input type="radio" name="pe-when" value="now" checked /><span>Now</span></label>
                <label class="check"><input type="radio" name="pe-when" value="schedule" /><span>Schedule for later</span></label>
                <input type="datetime-local" class="input" id="pe-when-at" data-utc-value={post.scheduled_at ? new Date(post.scheduled_at).toISOString() : ''} />
                <small class="field-h">Your local time. Publication time zone: {pub.timezone}</small>
              </div>
              <div class="callout warn hide" id="pe-send-warn" />
              <div class="form-actions"><button type="button" class="btn btn-secondary" data-close>Keep editing</button><button type="button" class="btn btn-primary" id="pe-send-go">Send now</button></div>
            </div>
          </div>
        </div>
      </dialog>

      <dialog id="pe-find" class="modal">
        <header class="modal-h"><h3>Find &amp; replace</h3><button type="button" class="btn btn-ghost btn-sm" data-close>✕</button></header>
        <div class="modal-b stack">
          <input class="input" id="pe-find-q" placeholder="Find" autofocus />
          <input class="input" id="pe-find-r" placeholder="Replace with" />
          <label class="check"><input type="checkbox" id="pe-find-case" /><span>Match case</span></label>
          <div class="row between"><span class="small muted" id="pe-find-count">0 matches</span><span class="row"><button type="button" class="btn btn-secondary btn-sm" id="pe-find-next">Next</button><button type="button" class="btn btn-secondary btn-sm" id="pe-find-one">Replace</button><button type="button" class="btn btn-primary btn-sm" id="pe-find-all">Replace all</button></span></div>
        </div>
      </dialog>

      <Json id="pe-data" data={data} />
    </DashLayout>,
  );
});

/** Bluesky embeds need the author's DID: resolve the handle once at save time and store it on the block. */
async function resolveEmbedDids(doc: { blocks: any[] }) {
  const todo: any[] = [];
  walkBlocks(doc.blocks, (b) => {
    if (b.type !== 'embed' || !b.data) return;
    const e = parseEmbed(String(b.data.url || ''));
    if (!e || e.provider !== 'bluesky') { delete b.data.did; return; }
    const handle = e.id.split('/')[0];
    if (b.data.did && b.data.did_for === handle) return;
    todo.push({ d: b.data, handle });
  });
  await Promise.all(todo.slice(0, 20).map(async (x) => {
    const did = await resolveBlueskyDid(x.handle);
    if (did) { x.d.did = did; x.d.did_for = x.handle; } else { delete x.d.did; delete x.d.did_for; }
  }));
}

// ───────── Autosave ─────────
app.put('/:id', async (c) => {
  const pub = c.get('pub');
  const user = c.get('user');
  const post = await loadPost(c, c.req.param('id'));
  if (!post) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json<any>();
  const m: Record<string, any> = body.meta || {};
  const canPublish = can(c.get('role'), 'publish');
  if (!canPublish && post.status !== 'draft') return c.json({ error: 'Contributors can only edit drafts' }, 403);
  const doc = body.content && Array.isArray(body.content.blocks) ? body.content : parseDoc(post.content);
  await resolveEmbedDids(doc);
  const content = JSON.stringify(doc);
  if (content.length > 4_000_000) return c.json({ error: 'Post is too large' }, 413);
  const title = body.title !== undefined ? str(body.title, 300) : post.title;
  const patch: Record<string, unknown> = { title, subtitle: body.subtitle !== undefined ? str(body.subtitle, 500) : post.subtitle, content, word_count: wordCount(doc), updated_at: now() };
  let slug = post.slug;
  if (body.meta) {
    const wantSlug = slugify(str(m.slug) || title || 'untitled');
    if (wantSlug !== post.slug) slug = await uniqueSlug(c.env, pub.id, wantSlug, post.id);
    const abSubjects = arr(m.ab_subjects).map((s) => s.slice(0, 200)).filter(Boolean);
    const cohortNames = arr(m.cohort_names);
    const cohortPcts = Array.isArray(m.cohort_pcts) ? m.cohort_pcts : [];
    const cohorts = cohortNames.map((name, i) => ({ name: name.slice(0, 40), pct: Number(cohortPcts[i]) || 0 })).filter((x) => x.name && x.pct > 0);
    const segIds = arr(m.segment_ids);
    const validSeg = segIds.length ? (await all<{ id: string }>(c.env, `SELECT id FROM segments WHERE pub_id = ? AND id IN (${segIds.map(() => '?').join(',')})`, pub.id, ...segIds)).map((r) => r.id) : [];
    Object.assign(patch, {
      slug,
      email_subject: str(m.email_subject, 200) || null,
      preview_text: str(m.preview_text, 200),
      sender_id: str(m.sender_id) || null,
      thumbnail_url: str(m.thumbnail_url, 1000) || null,
      comments_enabled: m.comments_enabled ? 1 : 0,
      hide_from_feed: m.hide_from_feed ? 1 : 0,
      platform: ['email', 'web', 'both'].includes(m.platform) ? m.platform : post.platform,
      audience: ['all', 'free', 'premium'].includes(m.audience) ? m.audience : post.audience,
      tier_ids: JSON.stringify(arr(m.tier_ids)),
      list_id: str(m.list_id) || null,
      segment_ids: JSON.stringify(validSeg),
      exclude_segment_ids: JSON.stringify(arr(m.exclude_segment_ids)),
      ab_test: m.ab_enabled && abSubjects.length >= 2 ? JSON.stringify({ ...parseJSON(post.ab_test, {}), subjects: abSubjects, sample_pct: Math.min(50, Math.max(2, Number(m.ab_sample) || 20)), wait_minutes: Math.min(1440, Math.max(10, Number(m.ab_wait) || 60)), metric: m.ab_metric === 'clicks' ? 'clicks' : 'opens' }) : null,
      cohort_test: m.cohort_enabled && cohorts.length >= 2 ? JSON.stringify({ cohorts }) : null,
      seo: JSON.stringify({ title: str(m.seo_title, 120) || undefined, description: str(m.seo_description, 300) || undefined, og_image: str(m.og_image, 1000) || undefined, canonical: str(m.canonical, 1000) || undefined, noindex: m.noindex ? true : undefined }),
      style: JSON.stringify(styleFromMeta(m)),
    });
    // authors (ordered) + tags
    const authorIds = arr(m.author_ids);
    if (authorIds.length) {
      const allowed = new Set((await authorChoices(c.env, pub)).map((u) => u.id));
      await run(c.env, 'DELETE FROM post_authors WHERE post_id = ?', post.id);
      let pos = 0;
      for (const uid of authorIds) if (allowed.has(uid)) await insert(c.env, 'post_authors', { post_id: post.id, user_id: uid, position: pos++ });
    }
    const tagIds = arr(m.tag_ids);
    await run(c.env, 'DELETE FROM post_tags WHERE post_id = ?', post.id);
    for (const tid of tagIds) await run(c.env, 'INSERT OR IGNORE INTO post_tags (post_id, tag_id) SELECT ?, id FROM content_tags WHERE id = ? AND pub_id = ?', post.id, tid, pub.id);
  }
  const cols = Object.keys(patch);
  await run(c.env, `UPDATE posts SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND pub_id = ?`, ...cols.map((k) => patch[k]), post.id, pub.id);
  // version snapshots: on request, or every 5 minutes of autosave
  const lastV = await val<number>(c.env, 'SELECT COALESCE(MAX(created_at), 0) FROM post_versions WHERE post_id = ?', post.id);
  let snapped = false;
  if (body.snapshot || (now() - lastV > 5 * MIN && content !== post.content)) {
    await snapshot(c.env, { id: post.id, title, content }, body.snapshot ? user.id : null);
    snapped = true;
  }
  if (post.status === 'published' && content !== post.content && now() - post.updated_at > 5 * MIN) {
    await emit(c.env, { pubId: pub.id, type: 'post.updated', refId: post.id, data: { post_id: post.id, title, slug }, activity: false });
  }
  return c.json({ ok: true, updated_at: patch.updated_at, slug, snapped, words: patch.word_count });
});

// ───────── Preview / render / counts ─────────
app.post('/:id/preview', async (c) => {
  const pub = c.get('pub');
  const post = await loadPost(c, c.req.param('id'));
  if (!post) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json<{ mode?: string; simulate?: Simulate }>().catch(() => ({} as any));
  const r = await renderPreview(c.env, pub, post, b.mode === 'web' ? 'web' : 'email', b.simulate);
  const subject = post.email_subject || post.title;
  return c.json({ ...r, subject, preview_text: post.preview_text, clip: GMAIL_CLIP_BYTES });
});

/**
 * Byte size of the email exactly as the sender builds it for one recipient: full layout, click-tracking
 * redirect URLs on every link, open pixel, signed unsubscribe/preferences footer. Measured for a free and a
 * premium reader (paywalled content differs) and the larger one is reported — that's what Gmail clips.
 */
async function sendSize(c: Ctx, post: Post) {
  const pub = c.get('pub');
  const real = await one<Subscriber>(c.env, `SELECT * FROM subscribers WHERE pub_id = ? AND status = 'active' ORDER BY created_at LIMIT 1`, pub.id);
  const base = real || (await simulatedSubscriber(c.env, pub, { tier: 'free', name: 'Alex Reader', email: 'alex.reader@example.com' }))!;
  const content = await postContent(c.env, post);
  const sizes: number[] = [];
  for (const tier of ['free', 'premium'] as const) {
    const sub: Subscriber = { ...base, id: real ? base.id : id(), tier };
    const b = await buildEmail(c.env, pub, content, sub, { deliveryId: id(), post, access: tier === 'premium' });
    sizes.push(b.bytes);
  }
  const bytes = Math.max(...sizes);
  return { bytes, free_bytes: sizes[0], premium_bytes: sizes[1], clip: GMAIL_CLIP_BYTES, warn_at: 90 * 1024, warn: bytes >= 90 * 1024 && bytes < GMAIL_CLIP_BYTES, over: bytes >= GMAIL_CLIP_BYTES };
}

app.post('/:id/email-size', async (c) => {
  const post = await loadPost(c, c.req.param('id'));
  if (!post) return c.json({ error: 'not_found' }, 404);
  return c.json(await sendSize(c, post));
});

/** Render an arbitrary doc. mode: email | web | fragment (web body only, used by editor block previews) | email-size (send-mode byte count). */
app.post('/render', async (c) => {
  const pub = c.get('pub');
  const b = await c.req.json<any>().catch(() => ({}));
  const doc = b.doc && Array.isArray(b.doc.blocks) ? b.doc : { blocks: [] };
  const fake: Post = { id: b.post_id || 'preview', pub_id: pub.id, title: str(b.title, 300), subtitle: str(b.subtitle, 500), slug: 'preview', content: JSON.stringify(doc), email_content: null, status: 'draft', platform: 'both', audience: 'all', tier_ids: '[]', list_id: null, segment_ids: '[]', exclude_segment_ids: '[]', email_subject: null, preview_text: str(b.preview_text, 200), ab_test: null, cohort_test: null, sender_id: null, thumbnail_url: null, seo: '{}', template_id: null, style: JSON.stringify(b.style || {}), comments_enabled: 1, hide_from_feed: 0, audio_key: null, word_count: 0, scheduled_at: null, published_at: null, created_by: null, created_at: now(), updated_at: now() };
  if (b.mode === 'fragment') {
    const sub = await simulatedSubscriber(c.env, pub, b.simulate);
    const r = await renderDoc(doc, { env: c.env, mode: 'web', pub, siteUrl: siteUrl(c.env, pub), subscriber: sub, access: true, preview: true });
    return c.json({ html: r.html, bytes: r.bytes });
  }
  if (b.mode === 'email-size') return c.json(await sendSize(c, fake));
  const r = await renderPreview(c.env, pub, fake, b.mode === 'web' ? 'web' : 'email', b.simulate);
  return c.json(r);
});

app.post('/:id/count', async (c) => {
  const pub = c.get('pub');
  const b = await c.req.json<any>().catch(() => ({}));
  const o: SendOptions = { audience: ['free', 'premium'].includes(b.audience) ? b.audience : 'all', tier_ids: arr(b.tier_ids), list_id: str(b.list_id) || null, segment_ids: arr(b.segment_ids), exclude_segment_ids: arr(b.exclude_segment_ids) };
  const count = await countRecipients(c.env, pub.id, o);
  // plan check for the send dialog: blocked sends show the reason + upgrade link before anything starts
  const gate = await checkSend(c.env, pub, count, { dryRun: true });
  const ramp = gate.ok ? await rampRemaining(c.env, pub.workspace_id) : { remaining: Infinity };
  const approval = gate.ok && (await needsApproval(c.env, pub, count));
  return c.json({
    count,
    plan: {
      ok: gate.ok, code: gate.code ?? null, reason: gate.reason ?? null, upgrade_url: gate.upgradeUrl,
      notice: approval ? `This is your first campaign to more than ${LIMITS.APPROVAL_RECIPIENTS.toLocaleString()} readers, so it gets a one-time review before it goes out (usually within a few hours).`
        : ramp.remaining !== Infinity && count > ramp.remaining ? `New accounts send up to ${LIMITS.NEW_ACCOUNT_DAILY_CAP} emails a day for their first ${LIMITS.NEW_ACCOUNT_DAYS} days — ${ramp.remaining.toLocaleString()} go out now and the rest follow automatically.` : null,
    },
  });
});

// ───────── Send flow ─────────
app.post('/:id/test', async (c) => {
  const pub = c.get('pub');
  const post = await loadPost(c, c.req.param('id'));
  if (!post) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json<any>().catch(() => ({}));
  const emails = String(b.emails || '').split(/[\s,;]+/).filter(Boolean).slice(0, 10);
  if (!emails.length) return c.json({ error: 'Enter at least one email address' }, 400);
  const sim: Simulate = String(b.as || '').startsWith('sub:') ? { subscriber_id: String(b.as).slice(4) } : { tier: b.as === 'premium' ? 'premium' : 'free', name: c.get('user').name };
  const realSub = sim.subscriber_id ? await simulatedSubscriber(c.env, pub, sim) : null;
  const results: string[] = [];
  for (const e of emails) {
    const v = await validateEmail(e);
    if (!v.ok) { results.push(`${e}: ${v.reason}`); continue; }
    const r = await sendTest(c.env, pub, post, v.email, realSub ? { ...realSub, email: v.email } : { tier: sim.tier, name: sim.name || '', email: v.email });
    results.push(`${v.email}: ${r.status}${r.error ? ' — ' + r.error : ''}`);
  }
  return c.json({ ok: true, message: `Test sent to ${emails.length} address${emails.length > 1 ? 'es' : ''}`, results });
});

app.post('/:id/publish', async (c) => {
  const pub = c.get('pub');
  if (!can(c.get('role'), 'publish')) return c.json({ error: 'You do not have permission to publish' }, 403);
  const post = await loadPost(c, c.req.param('id'));
  if (!post) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json<any>().catch(() => ({}));
  if (!post.title.trim()) return c.json({ error: 'Add a title before publishing' }, 400);
  if (post.status === 'published') return c.json({ ok: true, message: 'Post updated', redirect: `/app/posts/${post.id}` });
  if (b.mode === 'schedule') {
    const at = Date.parse(b.scheduled_at);
    if (isNaN(at) || at < now() + 60_000) return c.json({ error: 'Pick a time at least a minute in the future' }, 400);
    await run(c.env, `UPDATE posts SET status = 'scheduled', scheduled_at = ?, updated_at = ? WHERE id = ?`, at, now(), post.id);
    await snapshot(c.env, post, c.get('user').id);
    await emit(c.env, { pubId: pub.id, type: 'post.scheduled', refId: post.id, data: { post_id: post.id, title: post.title, scheduled_at: new Date(at).toISOString() }, activity: false });
    await audit(c, 'post.schedule', post.id);
    return c.json({ ok: true, message: `Scheduled for ${fmtDateTime(at, pub.timezone)}`, redirect: `/app/posts?status=scheduled` });
  }
  await snapshot(c.env, post, c.get('user').id);
  let sendId: string | null;
  try { sendId = await publishPost(c.env, pub, post); }
  catch (e) {
    if (e instanceof SendBlockedError) return c.json({ error: e.message, code: e.code, upgrade_url: e.upgradeUrl }, 402);
    throw e;
  }
  kick(c.env, c.executionCtx);
  await audit(c, 'post.publish', post.id, { send_id: sendId });
  return c.json({ ok: true, message: post.platform === 'web' ? 'Published to your website' : 'Sending started', redirect: `/app/posts/${post.id}` });
});

const statusAction = (path: string, sql: string, msg: string, perm: 'publish' | 'draft' = 'publish') =>
  app.post(`/:id/${path}`, async (c) => {
    if (!can(c.get('role'), perm)) return back(c, `/app/posts/${c.req.param('id')}/edit`, 'Not allowed', 'err');
    const post = await loadPost(c, c.req.param('id'));
    if (!post) return c.notFound();
    await run(c.env, sql, now(), post.id);
    await audit(c, 'post.' + path, post.id);
    return back(c, `/app/posts/${post.id}/edit`, msg);
  });
statusAction('unschedule', `UPDATE posts SET status = 'draft', scheduled_at = NULL, updated_at = ? WHERE id = ?`, 'Schedule cancelled — back to draft');
statusAction('unpublish', `UPDATE posts SET status = 'draft', updated_at = ? WHERE id = ?`, 'Unpublished from the website');
statusAction('archive', `UPDATE posts SET status = 'archived', updated_at = ? WHERE id = ?`, 'Post archived');

app.post('/:id/delete', async (c) => {
  const post = await loadPost(c, c.req.param('id'));
  if (!post) return c.notFound();
  if (!can(c.get('role'), 'publish') && post.status !== 'draft') return back(c, `/app/posts/${post.id}/edit`, 'Not allowed', 'err');
  await run(c.env, 'DELETE FROM posts WHERE id = ? AND pub_id = ?', post.id, c.get('pub').id);
  await audit(c, 'post.delete', post.id);
  return back(c, '/app/posts', 'Post deleted');
});

app.post('/:id/duplicate', async (c) => {
  const post = await loadPost(c, c.req.param('id'));
  if (!post) return c.notFound();
  const pid = await duplicatePost(c, post);
  return back(c, `/app/posts/${pid}/edit`, 'Duplicated — you are editing the copy');
});

app.post('/:id/save-template', async (c) => {
  const post = await loadPost(c, c.req.param('id'));
  if (!post) return c.notFound();
  const tid = id();
  await insert(c.env, 'templates', { id: tid, pub_id: c.get('pub').id, name: post.title ? `${post.title} (template)` : 'Untitled template', kind: 'post', description: post.subtitle || '', content: post.content, style: post.style, created_by: c.get('user').id, created_at: now(), updated_at: now() });
  return back(c, `/app/posts/templates/${tid}/edit`, 'Saved as a team template');
});

app.post('/:id/audio', async (c) => {
  const pub = c.get('pub');
  if (!can(c.get('role'), 'publish')) return back(c, '/app/posts', 'Not allowed', 'err');
  const post = await loadPost(c, c.req.param('id'));
  if (!post) return c.notFound();
  if (!aiEnabled(c.env)) return back(c, `/app/posts/${post.id}/edit`, AI_DISABLED_MSG, 'err');
  const r = await renderDoc(parseDoc(post.content), { env: c.env, mode: 'web', pub, siteUrl: siteUrl(c.env, pub), post, access: true });
  const text = `${post.title}. ${post.subtitle ? post.subtitle + '. ' : ''}${htmlToText(r.html).replace(/\([^)]*https?:[^)]*\)/g, '')}`;
  const key = `${pub.id}/audio/${post.id}.mp3`;
  const res = await aiSpeech(c.env, key, text, pub.language || 'en');
  if (!res.ok) return back(c, `/app/posts/${post.id}/edit`, 'Audio generation failed: ' + res.error, 'err');
  await run(c.env, 'UPDATE posts SET audio_key = ?, updated_at = ? WHERE id = ?', key, now(), post.id);
  return back(c, `/app/posts/${post.id}/edit`, 'Audio version generated');
});

// ───────── Tags & guest authors (inline from the editor) ─────────
app.post('/:id/tags', async (c) => {
  const pub = c.get('pub');
  const b = await c.req.json<any>().catch(() => ({}));
  const name = str(b.name, 60);
  if (!name) return c.json({ error: 'Name required' }, 400);
  const slug = slugify(name);
  const ex = await one<{ id: string; name: string }>(c.env, 'SELECT id, name FROM content_tags WHERE pub_id = ? AND slug = ?', pub.id, slug);
  if (ex) return c.json(ex);
  const tid = id();
  await insert(c.env, 'content_tags', { id: tid, pub_id: pub.id, name, slug, description: '' });
  return c.json({ id: tid, name });
});

app.post('/:id/guest-author', async (c) => {
  const pub = c.get('pub');
  const b = await c.req.json<any>().catch(() => ({}));
  const name = str(b.name, 120);
  if (!name) return c.json({ error: 'Name required' }, 400);
  const uid = id();
  await insert(c.env, 'users', { id: uid, email: `guest-${uid}@guest.invalid`, name, bio: str(b.bio, 1000) || null, socials: JSON.stringify({ pub_id: pub.id, website: str(b.website, 300) || undefined }), is_guest: 1, created_at: now() });
  return c.json({ id: uid, name });
});

// ───────── Draft comments ─────────
app.get('/:id/comments', async (c) => {
  const post = await loadPost(c, c.req.param('id'));
  if (!post) return c.json({ error: 'not_found' }, 404);
  const rows = await all<any>(c.env, 'SELECT dc.*, u.name AS user_name, u.email AS user_email FROM draft_comments dc LEFT JOIN users u ON u.id = dc.user_id WHERE dc.post_id = ? ORDER BY dc.created_at', post.id);
  return c.json({ comments: rows.map((r) => ({ id: r.id, block_id: r.block_id, parent_id: r.parent_id, body: r.body, quote: r.quote, resolved: !!r.resolved, created_at: r.created_at, user: r.user_name || r.user_email, mine: r.user_id === c.get('user').id })) });
});

app.post('/:id/comments', async (c) => {
  const post = await loadPost(c, c.req.param('id'));
  if (!post) return c.json({ error: 'not_found' }, 404);
  const b = await c.req.json<any>().catch(() => ({}));
  const body = str(b.body, 4000);
  if (!body) return c.json({ error: 'Comment is empty' }, 400);
  const cid = id();
  await insert(c.env, 'draft_comments', { id: cid, post_id: post.id, block_id: str(b.block_id) || null, parent_id: str(b.parent_id) || null, user_id: c.get('user').id, body, quote: str(b.quote, 300) || null, resolved: 0, created_at: now() });
  return c.json({ ok: true, id: cid });
});

app.post('/comments/:cid/:action', async (c) => {
  const pub = c.get('pub');
  const cm = await one<any>(c.env, 'SELECT dc.* FROM draft_comments dc JOIN posts p ON p.id = dc.post_id WHERE dc.id = ? AND p.pub_id = ?', c.req.param('cid'), pub.id);
  if (!cm) return c.json({ error: 'not_found' }, 404);
  const action = c.req.param('action');
  if (action === 'resolve') await run(c.env, 'UPDATE draft_comments SET resolved = 1 - resolved WHERE id = ? OR parent_id = ?', cm.id, cm.id);
  else if (action === 'delete') {
    if (cm.user_id !== c.get('user').id && !can(c.get('role'), 'manage')) return c.json({ error: 'Not allowed' }, 403);
    await run(c.env, 'DELETE FROM draft_comments WHERE id = ? OR parent_id = ?', cm.id, cm.id);
  }
  return c.json({ ok: true });
});

// ───────── Versions ─────────
app.get('/:id/versions', async (c) => {
  const post = await loadPost(c, c.req.param('id'));
  if (!post) return c.json({ error: 'not_found' }, 404);
  const rows = await all<any>(c.env, 'SELECT v.id, v.title, v.created_at, u.name FROM post_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.post_id = ? ORDER BY v.created_at DESC LIMIT 50', post.id);
  return c.json({ versions: rows.map((r) => ({ ...r, when: fmtDateTime(r.created_at, c.get('pub').timezone) })) });
});

app.get('/:id/versions/:vid', async (c) => {
  const pub = c.get('pub');
  const post = await loadPost(c, c.req.param('id'));
  if (!post) return c.notFound();
  const v = await one<any>(c.env, 'SELECT * FROM post_versions WHERE id = ? AND post_id = ?', c.req.param('vid'), post.id);
  if (!v) return c.notFound();
  const r = await renderDoc(parseDoc(v.content), { env: c.env, mode: 'web', pub, siteUrl: siteUrl(c.env, pub), post, access: true, preview: true });
  return c.html(webPage(c.env, pub, { ...post, title: v.title }, r.html, `Version from ${fmtDateTime(v.created_at, pub.timezone)}`));
});

app.post('/:id/versions/:vid/restore', async (c) => {
  const post = await loadPost(c, c.req.param('id'));
  if (!post) return c.json({ error: 'not_found' }, 404);
  if (!can(c.get('role'), 'publish') && post.status !== 'draft') return c.json({ error: 'Not allowed' }, 403);
  const v = await one<any>(c.env, 'SELECT * FROM post_versions WHERE id = ? AND post_id = ?', c.req.param('vid'), post.id);
  if (!v) return c.json({ error: 'not_found' }, 404);
  await snapshot(c.env, post, c.get('user').id); // so the restore itself can be undone
  await run(c.env, 'UPDATE posts SET title = ?, content = ?, updated_at = ? WHERE id = ?', v.title, v.content, now(), post.id);
  // reset any live collaboration room so everyone gets the restored doc
  try { await c.env.COLLAB.get(c.env.COLLAB.idFromName(post.id)).fetch('https://collab/reset', { method: 'POST' }); } catch {}
  return c.json({ ok: true, title: v.title, doc: parseDoc(v.content) });
});

// ───────── Inline polls + block pickers ─────────
app.post('/polls', async (c) => {
  const pub = c.get('pub');
  const b = await c.req.json<any>().catch(() => ({}));
  const question = str(b.question, 300);
  const options = arr(b.options).map((l) => l.slice(0, 120)).filter(Boolean).slice(0, 8);
  if (!question || options.length < 2) return c.json({ error: 'A poll needs a question and at least two options' }, 400);
  const pid = id();
  const opts = options.map((label) => ({ id: id(6), label }));
  const trivia = b.kind === 'trivia';
  const ci = Number(b.correct) - 1;
  if (trivia && !(ci >= 0 && ci < opts.length)) return c.json({ error: 'Choose which option is the correct answer' }, 400);
  await insert(c.env, 'polls', { id: pid, pub_id: pub.id, question, options: JSON.stringify(opts), purpose: ['topic', 'product', 'pricing'].includes(b.purpose) ? b.purpose : 'general', kind: trivia ? 'trivia' : 'standard', correct_option_id: trivia ? opts[ci].id : null, explanation: trivia ? str(b.explanation, 1000) : '', created_at: now() });
  return c.json({ id: pid, question });
});

app.get('/picker/:kind', async (c) => {
  const pub = c.get('pub');
  const k = c.req.param('kind');
  const postId = c.req.query('post') || '';
  let items: Array<{ id: string; label: string; sub?: string }> = [];
  if (k === 'polls') items = (await all<any>(c.env, 'SELECT id, question, kind FROM polls WHERE pub_id = ? ORDER BY created_at DESC LIMIT 100', pub.id)).map((r) => ({ id: r.id, label: r.question, sub: r.kind === 'trivia' ? 'Trivia' : undefined }));
  if (k === 'episodes') items = (await all<any>(c.env, `SELECT e.id, e.title, p.title AS show FROM episodes e JOIN podcasts p ON p.id = e.podcast_id WHERE e.pub_id = ? ORDER BY e.created_at DESC LIMIT 100`, pub.id)).map((r) => ({ id: r.id, label: r.title, sub: r.show }));
  if (k === 'products') items = (await all<any>(c.env, `SELECT id, name, price_cents FROM products WHERE pub_id = ? AND status != 'archived' ORDER BY created_at DESC LIMIT 100`, pub.id)).map((r) => ({ id: r.id, label: r.name, sub: r.price_cents ? `$${(r.price_cents / 100).toFixed(2)}` : 'Free' }));
  if (k === 'events') items = (await all<any>(c.env, `SELECT id, title, starts_at FROM live_events WHERE pub_id = ? ORDER BY starts_at DESC LIMIT 100`, pub.id)).map((r) => ({ id: r.id, label: r.title, sub: fmtDateTime(r.starts_at, pub.timezone) }));
  if (k === 'ads') items = (await all<any>(c.env, `SELECT o.id, o.status, o.post_id, c.headline, a.name AS advertiser FROM ad_opportunities o JOIN ad_campaigns c ON c.id = o.campaign_id JOIN advertisers a ON a.id = c.advertiser_id WHERE o.pub_id = ? AND o.status IN ('accepted','placed','available') AND (o.post_id IS NULL OR o.post_id = ?) ORDER BY o.created_at DESC LIMIT 100`, pub.id, postId)).map((r) => ({ id: r.id, label: `${r.advertiser}: ${r.headline}`, sub: r.status }));
  if (k === 'segments') items = (await all<any>(c.env, 'SELECT id, name, cached_count FROM segments WHERE pub_id = ? ORDER BY name', pub.id)).map((r) => ({ id: r.id, label: r.name, sub: `${r.cached_count} subscribers` }));
  return c.json({ items });
});

/** Ad slot: mark an opportunity as placed in this post when the editor inserts it. */
app.post('/:id/place-ad', async (c) => {
  const pub = c.get('pub');
  const b = await c.req.json<any>().catch(() => ({}));
  await run(c.env, `UPDATE ad_opportunities SET post_id = ?, status = CASE WHEN status IN ('available','accepted') THEN 'placed' ELSE status END, decided_at = COALESCE(decided_at, ?) WHERE id = ? AND pub_id = ?`, c.req.param('id'), now(), str(b.opportunity_id), pub.id);
  return c.json({ ok: true });
});

export default app;
export { walkBlocks };
export type { Ctx };
