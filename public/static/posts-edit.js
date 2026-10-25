// Post / template editor page: autosave, sidebar panels, preview, send flow, comments, history, find & replace.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const data = JSON.parse($('#pe-data').textContent);
  const isTemplate = data.mode === 'template';
  const id = data.post.id;
  const base = isTemplate ? `/app/posts/templates/${id}` : `/app/posts/${id}`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m, ms) => (window.OH?.toast ? OH.toast(m, ms) : alert(m));
  const json = async (url, body, method = 'POST') => {
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `Request failed (${r.status})`), { status: r.status });
    return j;
  };
  const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.now = (...a) => { clearTimeout(t); return fn(...a); }; return d; };

  const title = $('#pe-title');
  const subtitle = $('#pe-subtitle');
  const meta = $('#pe-meta');
  const saveEl = $('#pe-save');
  const autosize = (ta) => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  [title, subtitle].forEach((ta) => { autosize(ta); ta.addEventListener('input', () => autosize(ta)); ta.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (ta === title) subtitle.focus(); else editor._editor.root.items[0]?.view.focus?.(false); } }); });

  // ───────── editor ─────────
  let commentTarget = null;
  const editor = OHEditor.mount($('#pe-editor'), {
    doc: data.doc,
    catalog: data.catalog,
    postId: isTemplate ? null : id,
    features: { collab: !isTemplate, paywall: true, dynamic: true, polls: true, ai: true },
    collab: isTemplate ? null : { url: `/collab/${id}`, avatarsEl: $('#pe-avatars') },
    onChange: () => { markDirty(); updateWords(); },
    onComment: isTemplate ? null : (blockId, quote, open) => {
      showTab('comments');
      if (open) { renderComments(blockId); return; }
      commentTarget = { block_id: blockId, quote };
      $('#pe-comment-target').innerHTML = `On block: <em>${esc((quote || '').slice(0, 60) || 'selected block')}</em> <a href="#" id="pe-ct-clear">×</a>`;
      $('#pe-comment-body').focus();
    },
  });
  window.OHEditor.active = editor;
  editor.on('remote-meta', (m) => {
    if (typeof m.title === 'string' && document.activeElement !== title) { title.value = m.title; autosize(title); }
    if (typeof m.subtitle === 'string' && document.activeElement !== subtitle) { subtitle.value = m.subtitle; autosize(subtitle); }
  });

  // ───────── autosave ─────────
  let dirty = false, saving = false, metaDirty = true, failCount = 0;
  const setStatus = (t, cls = '') => { saveEl.textContent = t; saveEl.className = 'pe-save ' + cls; };
  function markDirty(isMeta) { dirty = true; if (isMeta) metaDirty = true; setStatus('Unsaved changes', 'dirty'); scheduleSave(); }
  const scheduleSave = debounce(() => save(), 1500);
  function serializeMeta() {
    const out = {};
    for (const el of meta.elements) {
      if (!el.name || el.disabled) continue;
      const arr = el.name.endsWith('[]');
      const key = arr ? el.name.slice(0, -2) : el.name;
      if (el.type === 'checkbox') { if (arr) { if (el.checked) (out[key] = out[key] || []).push(el.value); } else out[key] = el.checked; continue; }
      if (el.type === 'radio') { if (el.checked) out[key] = el.value; continue; }
      if (el.multiple) { out[key] = [...el.selectedOptions].map((o) => o.value); continue; }
      if (arr) (out[key] = out[key] || []).push(el.value); else out[key] = el.value;
    }
    return out;
  }
  async function save(opts = {}) {
    if (saving) { scheduleSave(); return; }
    if (!dirty && !opts.force && !opts.snapshot) return;
    saving = true;
    dirty = false;
    setStatus('Saving…', 'saving');
    const body = { title: title.value, subtitle: subtitle.value, content: editor.getDoc(), snapshot: !!opts.snapshot };
    if (metaDirty || opts.snapshot) body.meta = serializeMeta();
    try {
      const r = await json(base, body, 'PUT');
      metaDirty = false;
      failCount = 0;
      setStatus('Saved', 'ok');
      if (r.slug && meta.slug && document.activeElement !== meta.slug && meta.slug.value !== r.slug) { meta.slug.value = r.slug; updateSerp(); }
      if (r.snapped) refreshVersions();
      gauge();
      return r;
    } catch (e) {
      dirty = true;
      if (e.status === 403 || e.status === 413) { setStatus(e.message, 'err'); toast(e.message, 5000); }
      else { failCount++; setStatus(navigator.onLine ? 'Save failed — retrying…' : 'Offline — will retry', 'err'); setTimeout(() => save(), Math.min(30000, 2000 * 2 ** failCount)); }
    } finally { saving = false; }
  }
  window.addEventListener('online', () => dirty && save());
  window.addEventListener('beforeunload', (e) => { if (dirty || saving) { save(); e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); dirty = true; save({ force: true }); }
    if (mod && e.key.toLowerCase() === 'f' && $('#pe-find')) { e.preventDefault(); $('#pe-find').showModal(); $('#pe-find-q').focus(); $('#pe-find-q').select(); runFind(); }
  });

  title.addEventListener('input', () => { autoSlug(); markDirty(); updateSerp(); editor.sendMeta({ title: title.value }); });
  subtitle.addEventListener('input', () => { markDirty(); updateSerp(); editor.sendMeta({ subtitle: subtitle.value }); });
  meta.addEventListener('input', (e) => { if (e.target.name === 'slug') e.target.dataset.slugTouched = '1'; markDirty(true); updateSerp(); if (e.target.closest('[data-panel=audience]')) countRecipients(); });
  meta.addEventListener('change', (e) => { markDirty(true); if (e.target.closest('[data-panel=audience]')) countRecipients(); });

  // ───────── slug / SEO ─────────
  const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  function autoSlug() { const s = meta.slug; if (s && !s.dataset.slugTouched && data.post.status === 'draft') s.value = slugify(title.value) || s.value; }
  function updateSerp() {
    const serp = $('#pe-serp');
    if (!serp) return;
    const text = editor.plainText().replace(/\{\{[^}]+\}\}/g, '').replace(/\s+/g, ' ').trim();
    $('[data-serp-title]', serp).textContent = meta.seo_title?.value || title.value || 'Untitled';
    $('[data-serp-desc]', serp).textContent = meta.seo_description?.value || subtitle.value || (text.slice(0, 157) + (text.length > 157 ? '…' : ''));
    $('[data-serp-slug]', serp).textContent = meta.slug?.value || '';
    if (meta.seo_title) meta.seo_title.placeholder = title.value || 'Meta title';
    if (meta.seo_description) meta.seo_description.placeholder = subtitle.value || text.slice(0, 157);
  }

  // ───────── words + size gauge ─────────
  function updateWords() {
    const n = (editor.plainText().trim().match(/\S+/g) || []).length;
    $('#pe-words').textContent = `${n.toLocaleString()} word${n === 1 ? '' : 's'} · ${Math.max(1, Math.round(n / 230))} min`;
  }
  const gauge = debounce(async () => {
    const g = $('#pe-gauge');
    if (!g) return;
    try {
      const r = isTemplate ? await json('/app/posts/render', { doc: editor.getDoc(), mode: 'email', title: title.value }) : await json(`${base}/preview`, { mode: 'email' });
      const kb = r.bytes / 1024, clip = (data.gmailClip || 104448) / 1024;
      $('.pe-gauge-t', g).textContent = `${kb.toFixed(0)} / ${clip.toFixed(0)} KB`;
      $('.pe-gauge-bar i', g).style.width = Math.min(100, (kb / clip) * 100) + '%';
      g.classList.toggle('warn', kb >= 90 && kb < clip);
      g.classList.toggle('over', kb >= clip);
      g.title = kb >= clip ? 'Gmail will clip this email (over 102 KB). Remove images/blocks or split the issue.' : kb >= 90 ? 'Close to Gmail’s 102 KB clipping limit' : 'Email size — Gmail clips emails over 102 KB';
      lastBytes = r.bytes;
    } catch {}
  }, 2500);
  let lastBytes = 0;
  updateWords(); updateSerp(); gauge();

  // ───────── tabs, reveal toggles, color pickers ─────────
  function showTab(k) {
    $$('.pe-tabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === k));
    $$('.pe-panels [data-panel]').forEach((p) => p.classList.toggle('on', p.dataset.panel === k));
    if (k === 'comments') renderComments();
    if (k === 'audience') countRecipients();
  }
  $$('.pe-tabs [data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $$('[data-reveal]').forEach((cb) => cb.addEventListener('change', () => $(cb.dataset.reveal)?.classList.toggle('hide', !cb.checked)));
  $$('[data-color-for]').forEach((pick) => {
    const txt = meta.querySelector(`[name="${pick.dataset.colorFor}"]`);
    pick.addEventListener('input', () => { txt.value = pick.value; markDirty(true); });
    txt.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(txt.value)) pick.value = txt.value; });
  });

  // ───────── audience count ─────────
  const countRecipients = debounce(async () => {
    const el = $('#pe-recipients');
    if (!el || isTemplate) return;
    const m = serializeMeta();
    try { const r = await json(`${base}/count`, m); el.textContent = r.count.toLocaleString() + ' subscribers'; lastCount = r.count; } catch { el.textContent = '—'; }
  }, 400);
  let lastCount = null;

  // ───────── thumbnail ─────────
  const thumbIn = $('#pe-thumb');
  function setThumb(url) {
    if (!thumbIn) return;
    thumbIn.value = url || '';
    $('#pe-thumb-box').innerHTML = url ? `<img src="${esc(url)}" alt="">` : '<span class="muted small">Drop an image or click to upload</span>';
    let img = $('#pe-thumb-img');
    if (url) { if (!img) { img = document.createElement('img'); img.id = 'pe-thumb-img'; img.className = 'pe-thumb'; $('.pe-paper').prepend(img); } img.src = url; } else img?.remove();
    markDirty(true);
  }
  const uploadThumb = async (f) => { try { setStatus('Uploading…', 'saving'); const r = await OH.upload(f); setThumb(r.url); } catch (e) { toast(e.message); } };
  const pickImg = () => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.onchange = () => i.files[0] && uploadThumb(i.files[0]); i.click(); };
  $('#pe-thumb-upload')?.addEventListener('click', pickImg);
  $('#pe-thumb-box')?.addEventListener('click', pickImg);
  $('#pe-thumb-clear')?.addEventListener('click', () => setThumb(''));
  $('#pe-thumb-library')?.addEventListener('click', async () => {
    const r = await fetch('/app/posts/media.json?type=image').then((x) => x.json());
    const dlg = document.createElement('dialog');
    dlg.className = 'ohe-dialog ohe-media-dlg';
    dlg.innerHTML = `<div class="ohe-mhead"><h3>Choose thumbnail</h3><button type="button" class="btn btn-ghost btn-sm" data-close>✕</button></div><div class="ohe-mgrid">${r.items.map((m) => `<button type="button" class="ohe-mitem" data-url="${esc(m.url)}"><img src="${esc(m.url)}" alt="" loading="lazy"><small>${esc(m.name)}</small></button>`).join('') || '<p class="muted">No images yet.</p>'}</div>`;
    document.body.append(dlg);
    dlg.addEventListener('click', (e) => { const b = e.target.closest('[data-url]'); if (b) { setThumb(b.dataset.url); dlg.close(); } if (e.target.closest('[data-close]')) dlg.close(); });
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
  });
  const tbox = $('#pe-thumb-box');
  tbox?.addEventListener('dragover', (e) => { e.preventDefault(); tbox.classList.add('over'); });
  tbox?.addEventListener('dragleave', () => tbox.classList.remove('over'));
  tbox?.addEventListener('drop', (e) => { e.preventDefault(); tbox.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) uploadThumb(f); });

  // ───────── inline tag / guest author creation ─────────
  async function promptText(t, ph) {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.className = 'ohe-dialog';
      dlg.innerHTML = `<form method="dialog"><h3>${esc(t)}</h3><input class="input" name="v" placeholder="${esc(ph)}" required><div class="ohe-dialog-actions"><button type="button" class="btn btn-ghost btn-sm" value="cancel">Cancel</button><button class="btn btn-primary btn-sm" value="ok">Add</button></div></form>`;
      document.body.append(dlg);
      dlg.querySelector('[value=cancel]').onclick = () => dlg.close('cancel');
      dlg.addEventListener('close', () => { const v = dlg.returnValue === 'ok' ? dlg.querySelector('input').value.trim() : null; dlg.remove(); resolve(v); });
      dlg.showModal();
    });
  }
  $('#pe-add-tag')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const name = await promptText('New content tag', 'e.g. Interviews');
    if (!name) return;
    try { const t = await json(`${base}/tags`, { name }); const sel = meta.querySelector('[name="tag_ids[]"]'); let o = [...sel.options].find((x) => x.value === t.id); if (!o) { o = new Option(t.name, t.id); sel.add(o); } o.selected = true; markDirty(true); } catch (err) { toast(err.message); }
  });
  $('#pe-add-guest')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const name = await promptText('Guest author', 'Full name');
    if (!name) return;
    try { const u = await json(`${base}/guest-author`, { name }); const sel = meta.querySelector('[name="author_ids[]"]'); const o = new Option(u.name + ' (guest)', u.id); sel.add(o); o.selected = true; markDirty(true); } catch (err) { toast(err.message); }
  });

  // ───────── preview ─────────
  const pv = $('#pe-preview');
  let pvMode = 'email';
  async function loadPreview() {
    const as = $('#pe-pv-as').value;
    const sim = as.startsWith('sub:') ? { subscriber_id: as.slice(4) } : as.startsWith('tier:') ? { tier: as.slice(5), name: $('#pe-pv-name').value || 'Alex Reader' } : null;
    const frame = $('#pe-pv-frame');
    try {
      const r = await json(`${base}/preview`, { mode: pvMode, simulate: sim });
      frame.srcdoc = r.html;
      const kb = (r.bytes / 1024).toFixed(1);
      $('#pe-pv-meta').innerHTML = pvMode === 'email'
        ? `<strong>Subject:</strong> ${esc(r.subject || '(no subject)')} &nbsp; <span class="muted">${esc(r.preview_text || '')}</span> &nbsp;·&nbsp; <span class="${r.bytes > r.clip ? 'pe-red' : ''}">${kb} KB${r.bytes > r.clip ? ' — Gmail will clip this email' : ''}</span>`
        : '<span class="muted">Web version — media and embeds play here; inboxes show links instead.</span>';
    } catch (e) { frame.srcdoc = `<p style="font-family:sans-serif;padding:20px">${esc(e.message)}</p>`; }
  }
  $('#pe-preview-btn')?.addEventListener('click', async () => { await save({ force: true }); pv.showModal(); loadPreview(); });
  $$('#pe-pv-mode button').forEach((b) => b.addEventListener('click', () => { pvMode = b.dataset.mode; $$('#pe-pv-mode button').forEach((x) => x.classList.toggle('on', x === b)); loadPreview(); }));
  $$('#pe-pv-device button').forEach((b) => b.addEventListener('click', () => { $('#pe-pv-frame').style.width = b.dataset.w; $$('#pe-pv-device button').forEach((x) => x.classList.toggle('on', x === b)); }));
  $('#pe-pv-as')?.addEventListener('change', loadPreview);
  $('#pe-pv-name')?.addEventListener('change', loadPreview);

  // ───────── send / publish flow ─────────
  const sendDlg = $('#pe-send');
  function walk(blocks, fn) { (blocks || []).forEach((b) => { fn(b); walk(b.data?.blocks, fn); (b.data?.columns || []).forEach((c) => walk(c.blocks, fn)); }); }
  async function openSend() {
    await save({ force: true });
    const m = serializeMeta();
    const doc = editor.getDoc();
    const issues = [], ok = [];
    const check = (good, text, warn) => (good ? ok : warn ? issues : issues).push({ good, text, warn });
    const emailing = m.platform !== 'web';
    let noAlt = 0, hasPaywall = false, emptyImgs = 0;
    walk(doc.blocks, (b) => { if (b.type === 'image') { if (!b.data.src) emptyImgs++; else if (!b.data.alt) noAlt++; } if (b.type === 'paywall') hasPaywall = true; });
    const items = [];
    items.push([!!title.value.trim(), title.value.trim() ? `Title: “${title.value.trim()}”` : 'Add a title', true]);
    if (emailing) {
      const ab = m.ab_enabled && (m.ab_subjects || []).filter(Boolean).length >= 2;
      items.push([true, ab ? `A/B test: ${(m.ab_subjects || []).filter(Boolean).length} subject lines, ${m.ab_sample}% sample, winner by ${m.ab_metric === 'clicks' ? 'clicks' : 'opens'} after ${m.ab_wait} min` : `Subject: “${m.email_subject || title.value}”`]);
      items.push([!!m.preview_text, m.preview_text ? `Preview text: “${m.preview_text}”` : 'No preview text — inboxes will show the first line of the email', false, true]);
      const s = meta.querySelector('[name=sender_id]');
      items.push([true, `From: ${s.selectedOptions[0]?.textContent.replace(' (default)', '')}`]);
      await countRecipients.now();
      items.push([lastCount !== 0, lastCount === null ? 'Recipients: calculating…' : `Recipients: ${lastCount.toLocaleString()} subscriber${lastCount === 1 ? '' : 's'}${m.audience !== 'all' ? ` (${m.audience} only)` : ''}${(m.segment_ids || []).length ? `, ${(m.segment_ids || []).length} segment(s)` : ''}${(m.exclude_segment_ids || []).length ? `, excluding ${(m.exclude_segment_ids || []).length}` : ''}`, lastCount === 0]);
      if (m.cohort_enabled) items.push([true, `Random cohort test enabled`]);
      if (lastBytes) items.push([lastBytes < (data.gmailClip || 104448), `Email size ${(lastBytes / 1024).toFixed(0)} KB${lastBytes >= (data.gmailClip || 104448) ? ' — Gmail will clip it' : ''}`, false, true]);
    }
    items.push([true, m.platform === 'both' ? 'Publishes to email and your website' : m.platform === 'email' ? 'Email only (not on your website)' : 'Website only (no email is sent)']);
    if (hasPaywall) items.push([true, 'Paywall break: free readers see an upgrade prompt']);
    if (noAlt) items.push([false, `${noAlt} image${noAlt > 1 ? 's are' : ' is'} missing alt text`, false, true]);
    if (emptyImgs) items.push([false, `${emptyImgs} empty image block${emptyImgs > 1 ? 's' : ''} will be skipped`, false, true]);
    $('#pe-checklist').innerHTML = items.map(([good, text, blocking, warn]) => `<li class="${good ? 'ok' : warn ? 'warn' : 'bad'}">${good ? '✓' : warn ? '!' : '✕'} ${esc(text)}</li>`).join('');
    const blocking = items.filter(([good, , block]) => !good && block);
    $('#pe-send-go').disabled = blocking.length > 0;
    $('#pe-send-title').textContent = data.post.status === 'published' ? 'Published' : emailing ? 'Review & send' : 'Review & publish';
    updateSendBtn();
    sendDlg.showModal();
  }
  function updateSendBtn() {
    const when = $('input[name="pe-when"]:checked')?.value;
    const m = serializeMeta();
    $('#pe-send-go').textContent = when === 'schedule' ? 'Schedule' : m.platform === 'web' ? 'Publish now' : 'Send now';
  }
  $$('input[name="pe-when"]').forEach((r) => r.addEventListener('change', updateSendBtn));
  $('#pe-when-at')?.addEventListener('focus', () => { const r = $('input[name="pe-when"][value=schedule]'); r.checked = true; updateSendBtn(); });
  $('#pe-send-btn')?.addEventListener('click', () => { if (data.post.status === 'published') { save({ force: true }).then(() => toast('Post updated')); return; } if (data.post.status === 'scheduled') { openSend(); return; } openSend(); });
  $('#pe-send-go')?.addEventListener('click', async () => {
    const when = $('input[name="pe-when"]:checked').value;
    const at = $('#pe-when-at').value;
    const btn = $('#pe-send-go');
    btn.disabled = true;
    try {
      await save({ force: true });
      const r = await json(`${base}/publish`, { mode: when, scheduled_at: at ? new Date(at).toISOString() : null });
      dirty = false;
      toast(r.message);
      setTimeout(() => (location.href = r.redirect || '/app/posts'), 600);
    } catch (e) { toast(e.message, 5000); btn.disabled = false; }
  });
  $('#pe-test-send')?.addEventListener('click', async () => {
    const btn = $('#pe-test-send');
    btn.disabled = true;
    try { await save({ force: true }); const r = await json(`${base}/test`, { emails: $('#pe-test-to').value, as: $('#pe-test-as').value }); toast(r.message + (r.results?.some((x) => /failed|suppressed|invalid/i.test(x)) ? ' — ' + r.results.join('; ') : '')); } catch (e) { toast(e.message, 5000); }
    btn.disabled = false;
  });

  // ───────── comments ─────────
  let comments = [];
  async function loadComments() {
    if (isTemplate || !$('#pe-comments')) return;
    try { comments = (await json(`${base}/comments`, null, 'GET')).comments; } catch { return; }
    const counts = {};
    comments.filter((c) => !c.parent_id && !c.resolved && c.block_id).forEach((c) => (counts[c.block_id] = (counts[c.block_id] || 0) + 1));
    editor.setCommentCounts(counts);
    const open = comments.filter((c) => !c.parent_id && !c.resolved).length;
    $('#pe-comment-count').textContent = open ? String(open) : '';
  }
  function renderComments(filterBlock) {
    const box = $('#pe-comments');
    if (!box) return;
    const threads = comments.filter((c) => !c.parent_id && (!filterBlock || c.block_id === filterBlock));
    const when = (t) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    box.innerHTML = (filterBlock ? `<p class="small"><a href="#" data-cfilter>← All comments</a></p>` : '') + (threads.map((t) => `
      <div class="pe-thread ${t.resolved ? 'resolved' : ''}" data-thread="${t.id}">
        ${t.quote ? `<a href="#" class="pe-quote" data-goto="${esc(t.block_id || '')}">“${esc(t.quote)}”</a>` : t.block_id ? `<a href="#" class="pe-quote" data-goto="${esc(t.block_id)}">Go to block</a>` : ''}
        ${[t, ...comments.filter((r) => r.parent_id === t.id)].map((c) => `<div class="pe-cmt"><div class="row between"><strong class="small">${esc(c.user || 'Someone')}</strong><span class="small muted">${when(c.created_at)}</span></div><div class="pe-cmt-b">${esc(c.body)}</div>${c.mine ? `<a href="#" class="small muted" data-cdel="${c.id}">Delete</a>` : ''}</div>`).join('')}
        <div class="row" style="gap:6px;margin-top:6px"><input class="input" placeholder="Reply…" data-reply="${t.id}" style="height:30px"><button type="button" class="btn btn-ghost btn-sm" data-resolve="${t.id}">${t.resolved ? 'Reopen' : 'Resolve'}</button></div>
      </div>`).join('') || '<p class="muted small">No comments yet.</p>');
  }
  $('#pe-comments')?.addEventListener('click', async (e) => {
    const g = e.target.closest('[data-goto]');
    if (g) { e.preventDefault(); if (g.dataset.goto) editor.focusBlock(g.dataset.goto); }
    if (e.target.closest('[data-cfilter]')) { e.preventDefault(); renderComments(); }
    const r = e.target.closest('[data-resolve]');
    if (r) { await json(`/app/posts/comments/${r.dataset.resolve}/resolve`, {}); await loadComments(); renderComments(); }
    const d = e.target.closest('[data-cdel]');
    if (d) { e.preventDefault(); if (confirm('Delete this comment?')) { await json(`/app/posts/comments/${d.dataset.cdel}/delete`, {}); await loadComments(); renderComments(); } }
  });
  $('#pe-comments')?.addEventListener('keydown', async (e) => {
    const inp = e.target.closest('[data-reply]');
    if (inp && e.key === 'Enter' && inp.value.trim()) { e.preventDefault(); await json(`${base}/comments`, { body: inp.value.trim(), parent_id: inp.dataset.reply }); await loadComments(); renderComments(); }
  });
  $('#pe-comment-add')?.addEventListener('click', async () => {
    const body = $('#pe-comment-body').value.trim();
    if (!body) return;
    try {
      await json(`${base}/comments`, { body, ...(commentTarget || {}) });
      $('#pe-comment-body').value = '';
      commentTarget = null;
      $('#pe-comment-target').textContent = 'On: whole post';
      await loadComments(); renderComments();
    } catch (e) { toast(e.message); }
  });
  document.addEventListener('click', (e) => { if (e.target.id === 'pe-ct-clear') { e.preventDefault(); commentTarget = null; $('#pe-comment-target').textContent = 'On: whole post'; } });
  loadComments();
  setInterval(() => { if (!document.hidden) loadComments().then(() => $('[data-panel=comments].on') && renderComments()); }, 20000);

  // ───────── history ─────────
  async function refreshVersions() {
    const ul = $('#pe-versions');
    if (!ul) return;
    try {
      const r = await json(`${base}/versions`, null, 'GET');
      ul.innerHTML = r.versions.map((v) => `<li class="row between"><span><strong class="small">${esc(v.when)}</strong><br><span class="small muted">${esc(v.name || 'Autosave')} · ${esc(v.title || 'Untitled')}</span></span><span class="row"><button type="button" class="btn btn-ghost btn-sm" data-version-preview="${v.id}">Preview</button><button type="button" class="btn btn-secondary btn-sm" data-version-restore="${v.id}">Restore</button></span></li>`).join('') || '<li class="muted small">No versions yet.</li>';
    } catch {}
  }
  $('#pe-snapshot')?.addEventListener('click', async () => { await save({ snapshot: true, force: true }); toast('Version saved'); refreshVersions(); });
  $('#pe-versions')?.addEventListener('click', async (e) => {
    const p = e.target.closest('[data-version-preview]');
    if (p) window.open(`${base}/versions/${p.dataset.versionPreview}`, '_blank');
    const r = e.target.closest('[data-version-restore]');
    if (r && confirm('Restore this version? Your current draft is saved as a version first, so you can undo this.')) {
      try {
        const res = await json(`${base}/versions/${r.dataset.versionRestore}/restore`, {});
        editor.setDoc(res.doc);
        title.value = res.title; autosize(title);
        dirty = false;
        setStatus('Restored', 'ok');
        refreshVersions();
      } catch (err) { toast(err.message); }
    }
  });

  // ───────── find & replace ─────────
  const caseSens = () => $('#pe-find-case')?.checked;
  function runFind() { const n = editor.find($('#pe-find-q').value, { caseSensitive: caseSens() }); $('#pe-find-count').textContent = `${n} match${n === 1 ? '' : 'es'}`; }
  $('#pe-find-q')?.addEventListener('input', runFind);
  $('#pe-find-case')?.addEventListener('change', runFind);
  $('#pe-find-q')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); editor.findNext(); } });
  $('#pe-find-next')?.addEventListener('click', () => editor.findNext());
  $('#pe-find-one')?.addEventListener('click', () => { editor.replace($('#pe-find-q').value, $('#pe-find-r').value, { caseSensitive: caseSens() }); runFind(); });
  $('#pe-find-all')?.addEventListener('click', () => { const n = editor.replace($('#pe-find-q').value, $('#pe-find-r').value, { all: true, caseSensitive: caseSens() }); toast(`Replaced ${n} occurrence${n === 1 ? '' : 's'}`); runFind(); });
  $('#pe-find')?.addEventListener('close', () => editor.find(''));

  // first focus: title for new posts, else editor
  if (!title.value) title.focus();
  if (!isTemplate && $('[data-panel=audience]')) countRecipients();
})();
