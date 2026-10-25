// OpenHive website builder: drag-and-drop page sections with live preview, HTML mode, templates, AI widgets.
// Also powers the theme editor live preview and generic [data-upload] buttons.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => (window.OH?.toast ? OH.toast(m) : alert(m));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  async function upload(file) {
    const fd = new FormData();
    const f = window.OH?.optimizeImage && file.type.startsWith('image/') ? await OH.optimizeImage(file) : file;
    fd.append('file', f);
    const r = await fetch('/app/website/upload', { method: 'POST', body: fd, headers: { accept: 'application/json' }, credentials: 'same-origin' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Upload failed');
    return j.url;
  }
  const pickFile = (accept = 'image/*') => new Promise((res) => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.onchange = () => res(i.files[0] || null); i.click(); });

  // generic upload buttons: <button data-upload="inputName">
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-upload]');
    if (!b) return;
    e.preventDefault();
    const file = await pickFile();
    if (!file) return;
    const input = b.closest('form')?.querySelector(`[name="${b.dataset.upload}"]`);
    b.disabled = true; const label = b.textContent; b.textContent = 'Uploading…';
    try { const url = await upload(file); if (input) { input.value = url; input.dispatchEvent(new Event('input', { bubbles: true })); } toast('Uploaded'); }
    catch (err) { toast(err.message); }
    finally { b.disabled = false; b.textContent = label; }
  });

  // device toggles
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-device] button');
    if (!b) return;
    $$('button', b.parentElement).forEach((x) => x.classList.toggle('on', x === b));
    const frame = $('#theme-frame') || $('#pb-frame');
    if (frame) frame.style.width = b.dataset.w;
  });

  // ───────── Theme editor ─────────
  const tf = $('#theme-form');
  if (tf) {
    const frame = $('#theme-frame');
    const refresh = debounce(async () => {
      const r = await fetch('/app/website/theme/preview', { method: 'POST', body: new FormData(tf), credentials: 'same-origin' });
      frame.srcdoc = await r.text();
    }, 350);
    tf.addEventListener('input', (e) => {
      const t = e.target;
      if (t.dataset.sync) { const o = $(t.dataset.sync); if (o) o.value = t.value; }
      if (t.dataset.syncTo) { const o = tf.querySelector(`[name="${t.dataset.syncTo}"]`); if (o && /^#[0-9a-f]{6}$/i.test(t.value)) o.value = t.value; }
      refresh();
    });
    tf.addEventListener('change', refresh);
    frame.addEventListener('load', () => { try { frame.contentDocument.addEventListener('click', (ev) => { if (ev.target.closest('a,form,button')) ev.preventDefault(); }, true); } catch {} });
    refresh();
  }

  // ───────── Page builder ─────────
  const root = $('#pb-root');
  const dataEl = $('#pb-data');
  if (!root || !dataEl) return;
  const D = JSON.parse(dataEl.textContent);
  const page = D.page;
  const state = { sections: page.sections || [], sel: null, tab: 'sections', dirty: false };

  const opts = (list) => list.map(([v, l]) => [v, l]);
  const STYLE = [
    ['bg', 'color', 'Background'], ['color', 'color', 'Text color'], ['bg_image', 'image', 'Background image'],
    ['padding', 'select', 'Spacing', [['none', 'None'], ['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large'], ['xl', 'Extra large']]],
    ['align', 'select', 'Alignment', [['', 'Default'], ['left', 'Left'], ['center', 'Center'], ['right', 'Right']]],
    ['width', 'select', 'Width', [['narrow', 'Narrow'], ['normal', 'Normal'], ['wide', 'Wide'], ['full', 'Full bleed']]],
  ];
  const IMG_ITEM = [['src', 'image', 'Image'], ['alt', 'text', 'Alt text'], ['caption', 'text', 'Caption'], ['link', 'text', 'Link']];
  const F = {
    hero: [['eyebrow', 'text', 'Eyebrow'], ['title', 'text', 'Headline'], ['subtitle', 'textarea', 'Subheadline'], ['show_form', 'bool', 'Show subscribe form', true], ['button', 'text', 'Button label'], ['image', 'image', 'Image'], ['layout', 'select', 'Image placement', [['stacked', 'Below the text'], ['split', 'Side by side']]], ['cta_label', 'text', 'Secondary link label'], ['cta_url', 'text', 'Secondary link URL']],
    text: [],
    image: IMG_ITEM,
    grid: [['title', 'text', 'Title'], ['columns', 'number', 'Columns'], ['images', 'list', 'Images', IMG_ITEM]],
    carousel: [['title', 'text', 'Title'], ['images', 'list', 'Slides', IMG_ITEM.slice(0, 3)]],
    posts: [['title', 'text', 'Title'], ['count', 'number', 'Number of posts'], ['tag', 'select', 'Only posts tagged', [['', 'All posts'], ...opts(D.tags)]], ['layout', 'select', 'Layout', [['grid', 'Grid'], ['list', 'List']]]],
    subscribe: [['title', 'text', 'Title'], ['body', 'textarea', 'Text'], ['button', 'text', 'Button label']],
    testimonials: [['title', 'text', 'Title'], ['items', 'list', 'Testimonials', [['quote', 'textarea', 'Quote'], ['name', 'text', 'Name'], ['role', 'text', 'Role'], ['avatar', 'image', 'Avatar']]]],
    faq: [['title', 'text', 'Title'], ['items', 'list', 'Questions', [['q', 'text', 'Question'], ['a', 'textarea', 'Answer']]]],
    pricing: [['title', 'text', 'Title'], ['body', 'textarea', 'Intro'], ['show_free', 'bool', 'Show the free plan', true]],
    cta: [['title', 'text', 'Headline'], ['body', 'textarea', 'Text'], ['label', 'text', 'Button label'], ['url', 'text', 'Button URL']],
    columns: [['columns', 'list', 'Columns', [['image', 'image', 'Image'], ['title', 'text', 'Title'], ['body', 'textarea', 'Text'], ['label', 'text', 'Link label'], ['link', 'text', 'Link URL']]]],
    video: [['title', 'text', 'Title'], ['url', 'text', 'YouTube, Vimeo or MP4 URL']],
    youtube: [['title', 'text', 'Title'], ['channel_id', 'youtube', 'YouTube channel (URL, @handle or ID)'], ['count', 'number', 'Videos to show'], ['feature_latest', 'bool', 'Feature the latest video', true]],
    podcast: [['title', 'text', 'Title'], ['podcast_id', 'select', 'Show', [['', 'All shows'], ...opts(D.podcasts)]], ['count', 'number', 'Episodes']],
    products: [['title', 'text', 'Title'], ['count', 'number', 'Products']],
    events: [['title', 'text', 'Title'], ['count', 'number', 'Events']],
    html: [['html', 'code', 'HTML'], ['sandbox', 'bool', 'Widget mode: run scripts in a sandboxed frame'], ['height', 'number', 'Widget height (px)']],
    spacer: [['height', 'number', 'Height (px)']],
  };
  const DEFAULTS = {
    hero: { title: 'A headline that makes people subscribe', subtitle: 'One line on what readers get and how often.', show_form: true },
    text: { doc: { blocks: [{ id: uid(), type: 'heading', data: { level: 2, html: 'A section heading' } }, { id: uid(), type: 'paragraph', data: { html: 'Write something great here.' } }] } },
    image: {}, grid: { columns: 3, images: [] }, carousel: { images: [] }, posts: { title: 'Latest posts', count: 6 }, subscribe: { title: 'Subscribe', body: 'Get every new post in your inbox.' },
    testimonials: { title: 'What readers say', items: [{ quote: 'Best newsletter I read.', name: 'Reader name', role: 'Subscriber' }] },
    faq: { title: 'Frequently asked questions', items: [{ q: 'How often do you publish?', a: 'Every week.' }] }, pricing: { title: 'Plans' },
    cta: { title: 'Ready to join?', body: 'It takes ten seconds.', label: 'Subscribe', url: '#' }, columns: { columns: [{ title: 'One', body: '' }, { title: 'Two', body: '' }, { title: 'Three', body: '' }] },
    video: {}, youtube: { title: 'Latest videos', count: 6, feature_latest: true }, podcast: { title: 'Latest episodes', count: 5 }, products: { title: 'Shop', count: 6 }, events: { title: 'Upcoming events', count: 4 },
    html: { html: '<div style="padding:24px;border:1px dashed #ccc;border-radius:12px;text-align:center">Your HTML here</div>' }, spacer: { height: 48 },
  };
  const ICON = { hero: '★', text: '¶', image: '▣', grid: '▦', carousel: '⇆', posts: '☰', subscribe: '✉', testimonials: '❝', faq: '?', pricing: '$', cta: '➜', columns: '▥', video: '▶', youtube: '▶', podcast: '🎙', products: '🛍', events: '📅', html: '</>', spacer: '↕' };

  const summary = (s) => s.data?.title || s.data?.eyebrow || (s.type === 'text' ? (s.data?.doc?.blocks || []).map((b) => (b.data?.html || '').replace(/<[^>]+>/g, '')).join(' ').slice(0, 40) : '') || '';
  const markDirty = () => { state.dirty = true; refreshPreview(); };

  root.innerHTML = `
    <div class="pb-shell">
      <aside class="pb-panel">
        <nav class="pb-tabs"><button type="button" data-tab="sections" class="on">Sections</button><button type="button" data-tab="page">Page</button><button type="button" data-tab="html">HTML</button></nav>
        <div class="pb-body" id="pb-body"></div>
      </aside>
      <div class="pb-stage">
        <div class="pb-stagebar"><span class="muted small" id="pb-status">${page.status === 'published' ? 'Published' : 'Draft'} · <a href="${esc(D.siteUrl)}/${esc(page.slug)}" target="_blank">/${esc(page.slug)}</a></span><div class="device-toggle" data-device><button type="button" class="on" data-w="100%">Desktop</button><button type="button" data-w="390px">Mobile</button></div></div>
        <div class="pb-frame-wrap"><iframe id="pb-frame" class="pb-frame" title="Page preview"></iframe></div>
      </div>
    </div>`;
  const body = $('#pb-body');
  const frame = $('#pb-frame');

  $$('.pb-tabs button', root).forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; state.sel = null; $$('.pb-tabs button', root).forEach((x) => x.classList.toggle('on', x === b)); render(); }));

  let editorInstance = null;
  function destroyEditor() { try { editorInstance?.destroy?.(); } catch {} editorInstance = null; }

  function render() {
    destroyEditor();
    if (state.tab === 'page') return renderPageTab();
    if (state.tab === 'html') return renderHtmlTab();
    if (state.sel) return renderSettings(state.sections.find((s) => s.id === state.sel));
    renderList();
  }

  // ── sections list with drag and drop
  function renderList() {
    body.innerHTML = `
      ${page.use_html ? '<div class="callout warn small">This page uses custom HTML (HTML tab). Sections are kept but not shown until you switch back.</div>' : ''}
      <ul class="pb-list" id="pb-list">${state.sections.map((s, i) => `
        <li class="pb-item" draggable="true" data-id="${esc(s.id)}">
          <span class="pb-handle" title="Drag to reorder">⋮⋮</span>
          <button type="button" class="pb-item-main" data-edit="${esc(s.id)}"><span class="pb-ic">${ICON[s.type] || '•'}</span><span><strong>${esc(D.types[s.type] || s.type)}</strong><small>${esc(summary(s))}</small></span></button>
          <span class="pb-item-actions">
            <button type="button" title="Move up" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" title="Move down" data-down="${i}" ${i === state.sections.length - 1 ? 'disabled' : ''}>↓</button>
            <button type="button" title="Duplicate" data-dup="${i}">⧉</button>
            <button type="button" title="Save as block" data-saveblock="${i}">☆</button>
            <button type="button" title="Delete" data-del="${i}">✕</button>
          </span>
        </li>`).join('') || '<li class="muted pb-empty">No sections yet — add one below.</li>'}
      </ul>
      <div class="pb-add">
        <button type="button" class="btn btn-primary btn-sm" id="pb-add-btn">+ Add section</button>
        <button type="button" class="btn btn-secondary btn-sm" id="pb-ai-btn">✨ AI widget</button>
      </div>
      <div class="pb-menu" id="pb-menu" hidden>
        <div class="pb-menu-grid">${Object.entries(D.types).map(([k, l]) => `<button type="button" data-add="${k}"><span>${ICON[k] || '•'}</span>${esc(l)}</button>`).join('')}</div>
        <p class="muted small" style="margin:12px 0 6px"><strong>Your blocks</strong> · saved with “Save as block”, shared with your team</p>
        ${D.saved.length ? `<div class="pb-menu-grid">${D.saved.map((t) => `<button type="button" data-saved="${esc(t.id)}" title="${esc(D.types[t.section.type] || t.section.type)}"><span>${t.kind === 'website_block' ? (ICON[t.section.type] || '☆') : '☆'}</span><span style="width:auto;color:inherit;text-align:left">${esc(t.name)}<small class="muted" style="display:block;font-size:11px">${esc(D.types[t.section.type] || '')}</small></span></button>`).join('')}</div>` : '<p class="muted small" style="margin:0">No saved blocks yet. Open any section and click “Save as block” to reuse it on other pages.</p>'}
      </div>`;
    $('#pb-add-btn').onclick = () => { $('#pb-menu').hidden = !$('#pb-menu').hidden; };
    $('#pb-ai-btn').onclick = aiWidget;
    $$('[data-add]', body).forEach((b) => b.onclick = () => addSection({ type: b.dataset.add, data: JSON.parse(JSON.stringify(DEFAULTS[b.dataset.add] || {})), style: {} }));
    $$('[data-saved]', body).forEach((b) => b.onclick = () => { const t = D.saved.find((x) => x.id === b.dataset.saved); if (t) { addSection(JSON.parse(JSON.stringify(t.section))); toast(`Inserted “${t.name}”`); } });
    $$('[data-saveblock]', body).forEach((b) => b.onclick = () => saveBlock(state.sections[+b.dataset.saveblock]));
    $$('[data-edit]', body).forEach((b) => b.onclick = () => { state.sel = b.dataset.edit; render(); highlight(); });
    const move = (i, j) => { const [x] = state.sections.splice(i, 1); state.sections.splice(j, 0, x); markDirty(); render(); };
    $$('[data-up]', body).forEach((b) => b.onclick = () => move(+b.dataset.up, +b.dataset.up - 1));
    $$('[data-down]', body).forEach((b) => b.onclick = () => move(+b.dataset.down, +b.dataset.down + 1));
    $$('[data-dup]', body).forEach((b) => b.onclick = () => { const s = JSON.parse(JSON.stringify(state.sections[+b.dataset.dup])); s.id = uid(); state.sections.splice(+b.dataset.dup + 1, 0, s); markDirty(); render(); });
    $$('[data-del]', body).forEach((b) => b.onclick = () => { if (confirm('Remove this section?')) { state.sections.splice(+b.dataset.del, 1); markDirty(); render(); } });
    // drag & drop
    let dragId = null;
    $$('.pb-item', body).forEach((li) => {
      li.addEventListener('dragstart', (e) => { dragId = li.dataset.id; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      li.addEventListener('dragend', () => { li.classList.remove('dragging'); $$('.pb-item', body).forEach((x) => x.classList.remove('over')); });
      li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('over'); });
      li.addEventListener('dragleave', () => li.classList.remove('over'));
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = state.sections.findIndex((s) => s.id === dragId);
        const to = state.sections.findIndex((s) => s.id === li.dataset.id);
        if (from < 0 || to < 0 || from === to) return;
        move(from, to);
      });
    });
  }

  // Save one section as a reusable block (templates.kind = website_block); it appears under “Your blocks”.
  async function saveBlock(s) {
    if (!s) return;
    const name = prompt('Name this block (it will be available on every page)', summary(s) || D.types[s.type]);
    if (!name) return;
    try {
      const section = JSON.parse(JSON.stringify({ type: s.type, data: s.data, style: s.style || {} }));
      const j = await postJSON(`/app/website/pages/${page.id}/save-template`, { kind: 'block', name, section });
      if (!j.id) throw new Error(j.error || 'Save failed');
      D.saved.unshift({ id: j.id, name, kind: 'website_block', section });
      toast(j.message);
      if (!state.sel) render();
    } catch (e) { toast('Could not save block: ' + e.message); }
  }

  function addSection(s) {
    s.id = uid();
    const idx = state.sections.length;
    state.sections.splice(idx, 0, s);
    state.sel = s.id;
    markDirty();
    render();
  }

  async function aiWidget() {
    const prompt = window.prompt('Describe the widget (e.g. “countdown to our launch on Dec 1”, “tip calculator”, “quiz about our topic”)');
    if (!prompt) return;
    toast('Generating widget…');
    try {
      const r = await fetch('/app/website/ai/element', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ prompt }), credentials: 'same-origin' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'AI request failed');
      addSection(j.section);
      toast('Widget added');
    } catch (e) { alert(e.message); }
  }

  // ── field rendering
  function fieldHtml(def, val, path) {
    const [key, kind, label, extra] = def;
    const name = `${path}${key}`;
    const v = val ?? (kind === 'bool' ? extra === true : '');
    switch (kind) {
      case 'textarea': return `<label class="field"><span class="field-l">${esc(label)}</span><textarea class="input" rows="3" data-f="${esc(name)}">${esc(v)}</textarea></label>`;
      case 'code': return `<label class="field"><span class="field-l">${esc(label)}</span><textarea class="input mono" rows="12" data-f="${esc(name)}" spellcheck="false">${esc(v)}</textarea></label>`;
      case 'number': return `<label class="field"><span class="field-l">${esc(label)}</span><input class="input" type="number" data-f="${esc(name)}" data-num value="${esc(v)}"></label>`;
      case 'bool': return `<label class="check"><input type="checkbox" data-f="${esc(name)}" data-bool ${v === true || v === 'true' ? 'checked' : ''}><span>${esc(label)}</span></label>`;
      case 'select': return `<label class="field"><span class="field-l">${esc(label)}</span><select class="input" data-f="${esc(name)}">${extra.map(([o, l]) => `<option value="${esc(o)}" ${String(o) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
      case 'color': return `<label class="field"><span class="field-l">${esc(label)}</span><span class="row"><input type="color" class="input" data-f="${esc(name)}" value="${/^#[0-9a-f]{6}$/i.test(v) ? v : '#ffffff'}" ${v ? '' : 'data-unset'}><button type="button" class="btn btn-ghost btn-sm" data-clear="${esc(name)}">${v ? 'Clear' : 'Not set'}</button></span></label>`;
      case 'image': return `<label class="field pb-imgfield"><span class="field-l">${esc(label)}</span><span class="row"><input class="input" data-f="${esc(name)}" value="${esc(v)}" placeholder="https://… or drop an image"><button type="button" class="btn btn-secondary btn-sm" data-pick="${esc(name)}">Upload</button></span>${v ? `<img src="${esc(v)}" alt="" class="pb-thumb">` : ''}</label>`;
      case 'youtube': return `<label class="field"><span class="field-l">${esc(label)}</span><span class="row"><input class="input" data-f="${esc(name)}" value="${esc(v)}" placeholder="https://youtube.com/@channel"><button type="button" class="btn btn-secondary btn-sm" data-ytcheck="${esc(name)}">Check</button></span><small class="field-h">New uploads appear automatically (refreshed hourly).</small></label>`;
      case 'list': {
        const items = Array.isArray(v) ? v : [];
        return `<div class="field"><span class="field-l">${esc(label)}</span><div class="pb-listfield">${items.map((it, i) => `<div class="pb-li"><div class="row between"><strong class="small">#${i + 1}</strong><span><button type="button" class="btn btn-ghost btn-sm" data-li-up="${esc(name)}:${i}">↑</button><button type="button" class="btn btn-ghost btn-sm" data-li-del="${esc(name)}:${i}">Remove</button></span></div>${extra.map((sub) => fieldHtml(sub, it[sub[0]], `${name}.${i}.`)).join('')}</div>`).join('')}<button type="button" class="btn btn-secondary btn-sm" data-li-add="${esc(name)}">+ Add</button>${extra[0][1] === 'image' ? ` <button type="button" class="btn btn-ghost btn-sm" data-li-bulk="${esc(name)}">Upload several</button>` : ''}</div></div>`;
      }
      default: return `<label class="field"><span class="field-l">${esc(label)}</span><input class="input" data-f="${esc(name)}" value="${esc(v)}"></label>`;
    }
  }
  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  function setPath(obj, path, val) {
    const ks = path.split('.');
    let o = obj;
    for (let i = 0; i < ks.length - 1; i++) { const k = ks[i]; if (o[k] == null) o[k] = /^\d+$/.test(ks[i + 1]) ? [] : {}; o = o[k]; }
    o[ks[ks.length - 1]] = val;
  }

  function renderSettings(s) {
    if (!s) { state.sel = null; return renderList(); }
    s.style = s.style || {};
    const fields = F[s.type] || [];
    body.innerHTML = `
      <div class="pb-settings-h"><button type="button" class="btn btn-ghost btn-sm" id="pb-back">← Sections</button><strong>${esc(D.types[s.type])}</strong></div>
      <div class="pb-settings">
        ${s.type === 'text' ? `<div id="pb-text-editor" class="pb-text-editor"></div>` : ''}
        ${fields.map((f) => fieldHtml(f, getPath(s.data, f[0]), 'data.')).join('')}
        <details class="pb-style" ${Object.keys(s.style).length ? 'open' : ''}><summary>Section style</summary>${STYLE.map((f) => fieldHtml(f, s.style[f[0]], 'style.')).join('')}</details>
        <div class="row" style="margin-top:12px"><button type="button" class="btn btn-secondary btn-sm" id="pb-save-section">☆ Save as block</button><button type="button" class="btn btn-danger btn-sm" id="pb-del-section">Delete section</button></div>
      </div>`;
    $('#pb-back').onclick = () => { state.sel = null; render(); };
    $('#pb-del-section').onclick = () => { if (confirm('Delete this section?')) { state.sections = state.sections.filter((x) => x.id !== s.id); state.sel = null; markDirty(); render(); } };
    $('#pb-save-section').onclick = () => saveBlock(s);
    if (s.type === 'text') mountText(s);
    bindFields(s);
  }

  function mountText(s) {
    const el = $('#pb-text-editor');
    if (window.OHEditor?.mount) {
      if (!s.data.doc && s.data.html) s.data.doc = { blocks: [{ id: uid(), type: 'html', data: { html: s.data.html } }] };
      editorInstance = OHEditor.mount(el, { doc: s.data.doc || { blocks: [] }, compact: true, features: { paywall: false, dynamic: false, polls: false, ai: true, collab: false }, onChange: (doc) => { s.data.doc = doc; delete s.data.html; markDirty(); } });
    } else {
      const html = s.data.html ?? (s.data.doc?.blocks || []).map((b) => (b.type === 'heading' ? `<h${b.data.level || 2}>${b.data.html}</h${b.data.level || 2}>` : b.type === 'paragraph' ? `<p>${b.data.html}</p>` : b.data?.html || '')).join('\n');
      el.innerHTML = `<label class="field"><span class="field-l">Content (HTML)</span><textarea class="input" rows="10" id="pb-text-html">${esc(html)}</textarea><small class="field-h">Basic HTML: &lt;h2&gt;, &lt;p&gt;, &lt;a&gt;, &lt;ul&gt;, &lt;img&gt;…</small></label>`;
      $('#pb-text-html').addEventListener('input', (e) => { s.data.html = e.target.value; delete s.data.doc; markDirty(); });
    }
  }

  function bindFields(s) {
    const write = (el) => {
      const path = el.dataset.f;
      let v = el.dataset.bool !== undefined ? el.checked : el.value;
      if (el.dataset.num !== undefined) v = el.value === '' ? '' : Number(el.value);
      setPath(s, path, v);
      if (el.type === 'color') { delete el.dataset.unset; const b = body.querySelector(`[data-clear="${path}"]`); if (b) b.textContent = 'Clear'; }
      markDirty();
      const li = $$('.pb-item-main small'); // keep list summaries fresh next time
      void li;
    };
    $$('[data-f]', body).forEach((el) => {
      el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'color' ? 'change' : 'input', () => write(el));
      if (el.type === 'color') el.addEventListener('input', () => write(el));
    });
    $$('[data-clear]', body).forEach((b) => b.onclick = () => { setPath(s, b.dataset.clear, ''); markDirty(); renderSettings(s); });
    $$('[data-pick]', body).forEach((b) => b.onclick = async () => {
      const file = await pickFile();
      if (!file) return;
      b.textContent = '…';
      try { const url = await upload(file); setPath(s, b.dataset.pick, url); markDirty(); renderSettings(s); } catch (e) { toast(e.message); b.textContent = 'Upload'; }
    });
    $$('.pb-imgfield', body).forEach((lab) => {
      lab.addEventListener('dragover', (e) => { e.preventDefault(); lab.classList.add('over'); });
      lab.addEventListener('dragleave', () => lab.classList.remove('over'));
      lab.addEventListener('drop', async (e) => {
        e.preventDefault(); lab.classList.remove('over');
        const file = e.dataTransfer.files[0];
        const input = $('[data-f]', lab);
        if (!file || !input) return;
        try { const url = await upload(file); setPath(s, input.dataset.f, url); markDirty(); renderSettings(s); } catch (err) { toast(err.message); }
      });
    });
    $$('[data-li-add]', body).forEach((b) => b.onclick = () => { const arr = getPath(s, b.dataset.liAdd) || []; arr.push({}); setPath(s, b.dataset.liAdd, arr); markDirty(); renderSettings(s); });
    $$('[data-li-del]', body).forEach((b) => b.onclick = () => { const [p, i] = b.dataset.liDel.split(':'); const arr = getPath(s, p) || []; arr.splice(+i, 1); markDirty(); renderSettings(s); });
    $$('[data-li-up]', body).forEach((b) => b.onclick = () => { const [p, i] = b.dataset.liUp.split(':'); const arr = getPath(s, p) || []; const k = +i; if (k > 0) { [arr[k - 1], arr[k]] = [arr[k], arr[k - 1]]; markDirty(); renderSettings(s); } });
    $$('[data-li-bulk]', body).forEach((b) => b.onclick = () => {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
      inp.onchange = async () => {
        const arr = getPath(s, b.dataset.liBulk) || [];
        b.textContent = 'Uploading…';
        for (const f of inp.files) { try { arr.push({ src: await upload(f), alt: '' }); } catch (e) { toast(e.message); } }
        setPath(s, b.dataset.liBulk, arr); markDirty(); renderSettings(s);
      };
      inp.click();
    });
    $$('[data-ytcheck]', body).forEach((b) => b.onclick = async () => {
      const input = body.querySelector(`[data-f="${b.dataset.ytcheck}"]`);
      b.textContent = '…';
      const r = await fetch(`/app/website/youtube-check?q=${encodeURIComponent(input.value)}`, { credentials: 'same-origin' }).then((x) => x.json());
      b.textContent = 'Check';
      if (r.channel_id) { input.value = r.channel_id; setPath(s, b.dataset.ytcheck, r.channel_id); markDirty(); toast('Channel found'); } else toast('Channel not found — paste the channel URL or ID (starts with UC)');
    });
  }

  // ── page tab
  function renderPageTab() {
    const seo = page.seo || {};
    body.innerHTML = `
      <div class="pb-settings">
        <label class="field"><span class="field-l">Page title</span><input class="input" data-p="title" value="${esc(page.title)}"></label>
        <label class="field"><span class="field-l">URL slug</span><span class="row"><span class="muted small">/</span><input class="input" data-p="slug" value="${esc(page.slug)}" placeholder="(empty = home page)"></span><small class="field-h">Leave empty to make this your home page.</small></label>
        <label class="field"><span class="field-l">Who can see this page</span><select class="input" data-p="paywall"><option value="none">Everyone</option><option value="subscribers">Subscribers only</option><option value="premium">Premium subscribers only</option></select></label>
        <label class="check"><input type="checkbox" data-p="show_in_nav" ${page.show_in_nav ? 'checked' : ''}><span>Show in the site header</span></label>
        <h4 style="margin-top:18px">SEO</h4>
        <label class="field"><span class="field-l">Meta title</span><input class="input" data-seo="title" value="${esc(seo.title || '')}" placeholder="${esc(page.title)}"></label>
        <label class="field"><span class="field-l">Meta description</span><textarea class="input" rows="3" data-seo="description" placeholder="Generated automatically from the page when empty">${esc(seo.description || '')}</textarea><small class="field-h"><span id="pb-desc-count">${(seo.description || '').length}</span>/160</small></label>
        <label class="field pb-imgfield"><span class="field-l">Social image</span><span class="row"><input class="input" data-seo="og_image" value="${esc(seo.og_image || '')}" placeholder="https://…"><button type="button" class="btn btn-secondary btn-sm" id="pb-og-up">Upload</button></span></label>
        <label class="field"><span class="field-l">Canonical URL</span><input class="input" data-seo="canonical" value="${esc(seo.canonical || '')}" placeholder="Optional"></label>
        <label class="check"><input type="checkbox" data-seo="noindex" ${seo.noindex ? 'checked' : ''}><span>Hide from search engines (noindex)</span></label>
        <div class="pb-serp"><span class="pb-serp-url">${esc(D.siteUrl)}/${esc(page.slug)}</span><span class="pb-serp-t" id="pb-serp-t">${esc(seo.title || page.title)}</span><span class="pb-serp-d" id="pb-serp-d">${esc(seo.description || 'Description generated from your page content.')}</span></div>
        <h4 style="margin-top:18px">Templates</h4>
        <button type="button" class="btn btn-secondary btn-sm" id="pb-save-page-tpl">Save whole page as template</button>
      </div>`;
    $('[data-p="paywall"]', body).value = page.paywall || 'none';
    $$('[data-p]', body).forEach((el) => el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => { page[el.dataset.p] = el.type === 'checkbox' ? el.checked : el.value; state.dirty = true; if (el.dataset.p === 'title') refreshPreview(); }));
    $$('[data-seo]', body).forEach((el) => el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
      page.seo = page.seo || {};
      page.seo[el.dataset.seo] = el.type === 'checkbox' ? el.checked : el.value;
      state.dirty = true;
      $('#pb-desc-count').textContent = (page.seo.description || '').length;
      $('#pb-serp-t').textContent = page.seo.title || page.title;
      $('#pb-serp-d').textContent = page.seo.description || 'Description generated from your page content.';
    }));
    $('#pb-og-up').onclick = async () => { const f = await pickFile(); if (!f) return; try { const url = await upload(f); page.seo.og_image = url; state.dirty = true; renderPageTab(); } catch (e) { toast(e.message); } };
    $('#pb-save-page-tpl').onclick = async () => { const name = prompt('Template name', page.title); if (!name) return; const j = await postJSON(`/app/website/pages/${page.id}/save-template`, { kind: 'page', name, sections: state.sections }); toast(j.message); };
  }

  // ── HTML tab
  function renderHtmlTab() {
    body.innerHTML = `
      <div class="pb-settings">
        <label class="toggle"><input type="checkbox" id="pb-use-html" ${page.use_html ? 'checked' : ''}><span class="toggle-ui"></span><span>Use custom HTML for this page<small class="field-h">Full control over the page body. Your site header, footer and theme stay in place. Scripts and unsafe attributes are removed.</small></span></label>
        <textarea class="input mono" id="pb-html" rows="22" spellcheck="false" placeholder="<section>…</section>">${esc(page.html_override || '')}</textarea>
        <div class="row"><button type="button" class="btn btn-secondary btn-sm" id="pb-convert">Copy current sections into HTML</button></div>
      </div>`;
    $('#pb-use-html').onchange = (e) => { page.use_html = e.target.checked; markDirty(); };
    $('#pb-html').addEventListener('input', debounce((e) => { page.html_override = e.target.value; markDirty(); }, 300));
    $('#pb-convert').onclick = async () => {
      const html = await previewHtml({ use_html: false });
      const doc = new DOMParser().parseFromString(html, 'text/html');
      page.html_override = doc.querySelector('.pb-page')?.innerHTML.trim() || '';
      page.use_html = true;
      markDirty();
      renderHtmlTab();
    };
  }

  // ── preview
  async function postJSON(url, data) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(data), credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Request failed');
    return j;
  }
  async function previewHtml(over = {}) {
    const r = await fetch(`/app/website/pages/${page.id}/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: page.title, sections: state.sections, use_html: page.use_html, html_override: page.html_override, seo: page.seo, ...over }), credentials: 'same-origin' });
    return r.text();
  }
  const refreshPreview = debounce(async () => {
    const y = frame.contentWindow?.scrollY || 0;
    frame.srcdoc = await previewHtml();
    frame.onload = () => {
      try {
        const d = frame.contentDocument;
        frame.contentWindow.scrollTo(0, y);
        d.addEventListener('click', (e) => {
          if (e.target.closest('a,button,form,input')) e.preventDefault();
          const sec = e.target.closest('section.pb');
          if (sec && state.tab === 'sections') { state.sel = sec.id.replace(/^s-/, ''); render(); highlight(); }
        }, true);
        d.addEventListener('submit', (e) => e.preventDefault(), true);
        highlight();
      } catch {}
    };
  }, 350);
  function highlight() {
    try {
      const d = frame.contentDocument;
      $$('section.pb', d).forEach((x) => x.classList.toggle('pb-selected', x.id === 's-' + state.sel));
      const el = state.sel && d.getElementById('s-' + state.sel);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch {}
  }

  // ── save / publish
  async function save(publish) {
    const payload = { title: page.title, slug: page.slug, sections: state.sections, seo: page.seo, paywall: page.paywall, show_in_nav: page.show_in_nav, use_html: page.use_html, html_override: page.html_override, publish };
    try {
      const j = await postJSON(`/app/website/pages/${page.id}/save`, payload);
      state.dirty = false;
      page.slug = j.slug;
      page.status = j.status;
      $('#pb-status').innerHTML = `${j.status === 'published' ? 'Published' : 'Draft'} · <a href="${esc(j.url)}" target="_blank">/${esc(j.slug)}</a>`;
      toast(j.message);
    } catch (e) { alert('Save failed: ' + e.message); }
  }
  document.querySelector('[data-pb-save]')?.addEventListener('click', () => save(false));
  document.querySelector('[data-pb-publish]')?.addEventListener('click', () => save(true));
  document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(false); } });
  addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

  render();
  refreshPreview();
})();
