// OpenHive block editor — framework-free WYSIWYG that produces the documented {blocks:[...]} JSON.
// API: OHEditor.mount(el, opts) → { getDoc, setDoc, plainText, insertText, destroy, find, replace, focusBlock, setCommentCounts, on }
// window.OHEditor also proxies plainText/insertText/getDoc to the active instance (used by the ⌘J AI drawer).
(() => {
  'use strict';
  const uid = () => 'b' + Math.random().toString(36).slice(2, 10);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  };
  const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.flush = (...a) => { clearTimeout(t); fn(...a); }; d.cancel = () => clearTimeout(t); return d; };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

  // ───────── inline HTML cleaning (mirrors server sanitizer: inline tags only) ─────────
  const INLINE_OK = new Set(['A', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'CODE', 'BR', 'SPAN', 'MARK', 'SUB', 'SUP', 'SMALL', 'KBD']);
  function cleanInline(node) {
    // node: Element whose children are inline content; returns cleaned HTML string.
    const out = document.createElement('div');
    const walk = (src, dst) => {
      for (const n of [...src.childNodes]) {
        if (n.nodeType === 3) { dst.append(n.textContent.replace(/ /g, ' ')); continue; }
        if (n.nodeType !== 1) continue;
        let tag = n.tagName;
        const st = n.getAttribute('style') || '';
        // Google Docs / Word styled spans → semantic tags
        if (tag === 'SPAN' && !n.hasAttribute('data-footnote')) {
          let wrap = dst;
          const chain = [];
          if (/font-weight:\s*(bold|[6-9]00)/i.test(st)) chain.push('strong');
          if (/font-style:\s*italic/i.test(st)) chain.push('em');
          if (/text-decoration[^;]*underline/i.test(st)) chain.push('u');
          if (/text-decoration[^;]*line-through/i.test(st)) chain.push('s');
          if (/vertical-align:\s*super/i.test(st)) chain.push('sup');
          if (/vertical-align:\s*sub/i.test(st)) chain.push('sub');
          if (/font-family:[^;]*(courier|mono|consolas)/i.test(st)) chain.push('code');
          for (const t of chain) { const e = document.createElement(t); wrap.append(e); wrap = e; }
          walk(n, wrap);
          continue;
        }
        if (tag === 'B' && /font-weight:\s*normal/i.test(st)) { walk(n, dst); continue; } // GDocs wrapper <b style="font-weight:normal">
        if (tag === 'P' || tag === 'DIV' || /^H[1-6]$/.test(tag) || tag === 'LI') { if (dst.childNodes.length) dst.append(document.createElement('br')); walk(n, dst); continue; }
        if (!INLINE_OK.has(tag)) { walk(n, dst); continue; }
        const e = document.createElement(tag === 'B' ? 'strong' : tag === 'I' ? 'em' : tag === 'STRIKE' || tag === 'DEL' ? 's' : tag.toLowerCase());
        if (tag === 'A') {
          const href = n.getAttribute('href') || '';
          if (!/^(https?:|mailto:|tel:|#|\/|\{\{)/i.test(href)) { walk(n, dst); continue; }
          e.setAttribute('href', href);
        }
        if (tag === 'SPAN') {
          if (n.hasAttribute('data-footnote')) { e.setAttribute('data-footnote', n.getAttribute('data-footnote')); e.setAttribute('contenteditable', 'false'); e.className = 'ohe-fn'; dst.append(e); continue; }
          walk(n, dst); continue;
        }
        walk(n, e);
        dst.append(e);
      }
    };
    walk(node, out);
    let html = out.innerHTML.replace(/(<br\s*\/?>\s*)+$/i, '');
    if (!out.textContent.trim() && !/data-footnote|<img/i.test(html)) html = '';
    return html;
  }
  const htmlToNode = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d; };
  const cleanHTML = (html) => cleanInline(htmlToNode(html));
  const textOf = (html) => htmlToNode(html).textContent;

  // ───────── caret helpers ─────────
  const sel = () => window.getSelection();
  function caretRange() { const s = sel(); return s && s.rangeCount ? s.getRangeAt(0) : null; }
  function rangeText(el, fromStart) {
    const r = caretRange();
    if (!r || !el.contains(r.startContainer)) return null;
    const x = document.createRange();
    x.selectNodeContents(el);
    if (fromStart) x.setEnd(r.startContainer, r.startOffset); else x.setStart(r.endContainer, r.endOffset);
    const frag = x.cloneContents();
    const d = document.createElement('div'); d.append(frag);
    return { text: d.textContent, html: d.innerHTML };
  }
  const atStart = (el) => { const t = rangeText(el, true); return t && t.text.length === 0 && !/data-footnote|<img/.test(t.html); };
  const atEnd = (el) => { const t = rangeText(el, false); return t && t.text.replace(/​/g, '').length === 0 && !/data-footnote/.test(t.html); };
  function placeCaret(el, end = true) {
    if (!el) return;
    el.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(!end);
    const s = sel(); s.removeAllRanges(); s.addRange(r);
    el.scrollIntoView({ block: 'nearest' });
  }
  function placeCaretAtOffset(el, offset) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n, left = offset;
    while ((n = walker.nextNode())) {
      if (left <= n.length) { const r = document.createRange(); r.setStart(n, left); r.collapse(true); const s = sel(); s.removeAllRanges(); s.addRange(r); return; }
      left -= n.length;
    }
    placeCaret(el, true);
  }
  function splitAtCaret(el) {
    const r = caretRange();
    if (!r) return '';
    if (!r.collapsed) r.deleteContents();
    const x = document.createRange();
    x.selectNodeContents(el);
    x.setStart(r.endContainer, r.endOffset);
    const d = document.createElement('div');
    d.append(x.extractContents());
    return cleanInline(d);
  }
  function wrapSelection(tag, attrs = {}) {
    const r = caretRange();
    if (!r || r.collapsed) return;
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.append(r.extractContents());
    r.insertNode(el);
    const s = sel(); s.removeAllRanges(); const nr = document.createRange(); nr.selectNodeContents(el); s.addRange(nr);
  }
  function closestTag(tag) {
    const r = caretRange();
    let n = r && r.commonAncestorContainer;
    while (n && n.nodeType !== 1) n = n.parentNode;
    return n ? n.closest(tag) : null;
  }
  function insertHTMLAtCaret(html) {
    document.execCommand('insertHTML', false, html);
  }

  // ───────── embeds (client mirror of parseEmbed for paste detection) ─────────
  const EMBED_RE = [/(youtube\.com\/(watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)/, /(twitter|x)\.com\/[^/]+\/status\/\d+/, /tiktok\.com\/@[^/]+\/video\/\d+/, /instagram\.com\/(p|reel|tv)\//, /bsky\.app\/profile\/[^/]+\/post\//, /stocktwits\.com\/[^/]+\/message\/\d+/, /open\.spotify\.com\/(episode|show|track|playlist)\//, /vimeo\.com\/\d+/, /podcasts\.apple\.com\//, /loom\.com\/share\//];
  const isEmbedUrl = (u) => /^https?:\/\/\S+$/.test(u) && EMBED_RE.some((re) => re.test(u));

  // ───────── block type registry ─────────
  const P = (html = '') => ({ id: uid(), type: 'paragraph', data: { html } });
  const TYPES = {
    paragraph: { label: 'Text', icon: '¶', group: 'Basic', keys: 'paragraph text plain', data: () => ({ html: '' }), text: true },
    h1: { label: 'Heading 1', icon: 'H1', hidden: true, as: 'heading', data: () => ({ level: 1, html: '' }) },
    h2: { label: 'Heading 2', icon: 'H2', group: 'Basic', keys: 'heading title h2', as: 'heading', data: () => ({ level: 2, html: '' }) },
    h3: { label: 'Heading 3', icon: 'H3', group: 'Basic', keys: 'heading subtitle h3', as: 'heading', data: () => ({ level: 3, html: '' }) },
    h4: { label: 'Heading 4', icon: 'H4', group: 'Basic', keys: 'heading h4 small', as: 'heading', data: () => ({ level: 4, html: '' }) },
    heading: { label: 'Heading', icon: 'H', hidden: true, data: () => ({ level: 2, html: '' }), text: true },
    list: { label: 'Bulleted list', icon: '•', group: 'Basic', keys: 'bullet list ul unordered', data: () => ({ ordered: false, items: [''] }) },
    olist: { label: 'Numbered list', icon: '1.', group: 'Basic', keys: 'numbered ordered list ol', as: 'list', data: () => ({ ordered: true, items: [''] }) },
    checklist: { label: 'Checklist', icon: '☑', group: 'Basic', keys: 'todo checklist checkbox task', data: () => ({ items: [{ html: '', checked: false }] }) },
    quote: { label: 'Quote', icon: '❝', group: 'Basic', keys: 'blockquote quote citation pull', data: () => ({ html: '', cite: '', style: { variant: 'line' } }) },
    divider: { label: 'Divider', icon: '—', group: 'Basic', keys: 'divider hr line break separator', data: () => ({ style: 'line' }) },
    code: { label: 'Code', icon: '</>', group: 'Basic', keys: 'code snippet pre programming', data: () => ({ lang: '', code: '' }) },
    image: { label: 'Image', icon: '🖼', group: 'Media', keys: 'image picture photo upload', data: () => ({ src: '', alt: '', title: '', caption: '', width: 100, align: 'center', link: '' }) },
    gallery: { label: 'Image gallery / carousel', icon: '▦', group: 'Media', keys: 'gallery grid carousel slideshow images', data: () => ({ images: [], columns: 2, layout: 'grid' }) },
    embed: { label: 'Embed (YouTube, X, TikTok…)', icon: '▶', group: 'Media', keys: 'embed youtube twitter x tiktok instagram bluesky stocktwits spotify vimeo loom video social', data: () => ({ url: '', caption: '' }) },
    video: { label: 'Video file', icon: '🎬', group: 'Media', keys: 'video mp4 upload', data: () => ({ src: '', poster: '', caption: '' }) },
    audio: { label: 'Audio file', icon: '🎧', group: 'Media', keys: 'audio mp3 sound music voice', data: () => ({ src: '', title: '' }) },
    gif: { label: 'GIF', icon: 'GIF', group: 'Media', keys: 'gif giphy animated meme reaction', pseudo: true },
    attachment: { label: 'File attachment', icon: '📎', group: 'Media', keys: 'file attachment pdf download', data: () => ({ url: '', name: '', size: 0 }) },
    podcast: { label: 'Podcast episode', icon: '🎙', group: 'Media', keys: 'podcast episode player', data: () => ({ episode_id: '' }) },
    button: { label: 'Button', icon: '⬭', group: 'Layout', keys: 'button cta link call to action', data: () => ({ label: 'Read more', url: '', align: 'center' }) },
    columns: { label: 'Columns', icon: '▥', group: 'Layout', keys: 'columns grid side by side layout', data: () => ({ valign: 'top', columns: [{ blocks: [P()] }, { blocks: [P()] }] }) },
    section: { label: 'Section', icon: '▢', group: 'Layout', keys: 'section box background container callout', data: () => ({ blocks: [P()], style: { bg: '#f8fafc', padding: 20, radius: 10, border_width: 0, border_color: '#e5e7eb', border_style: 'solid' } }) },
    table: { label: 'Table', icon: '▤', group: 'Layout', keys: 'table rows columns spreadsheet', data: () => ({ rows: [['', ''], ['', '']], header: true }) },
    spacer: { label: 'Spacer', icon: '↕', group: 'Layout', keys: 'spacer space gap', data: () => ({ height: 24 }) },
    toc: { label: 'Table of contents', icon: '☰', group: 'Layout', keys: 'toc table of contents index anchors', data: () => ({}) },
    html: { label: 'Custom HTML', icon: '⟨⟩', group: 'Layout', keys: 'html custom raw embed code', data: () => ({ html: '' }) },
    paywall: { label: 'Paywall break', icon: '🔒', group: 'Audience', keys: 'paywall premium break subscribers only', feature: 'paywall', data: () => ({}) },
    dynamic: { label: 'Dynamic content', icon: '◐', group: 'Audience', keys: 'dynamic conditional segment personalize audience cohort', feature: 'dynamic', data: () => ({ mode: 'show', rule: { tiers: ['premium'], segment_ids: [], tags: [], cohorts: [], match: 'any' }, blocks: [P()] }) },
    subscribe: { label: 'Subscribe form (web)', icon: '✉', group: 'Audience', keys: 'subscribe form signup newsletter', data: () => ({ label: 'Subscribe' }) },
    poll: { label: 'Poll', icon: '📊', group: 'Grow', keys: 'poll vote survey question', feature: 'polls', data: () => ({ poll_id: '' }) },
    referral: { label: 'Referral block', icon: '🎁', group: 'Grow', keys: 'referral share refer rewards', data: () => ({ title: '' }) },
    recommendations: { label: 'Recommendations', icon: '★', group: 'Grow', keys: 'recommendations newsletters recommend', data: () => ({ title: '', limit: 3 }) },
    ad_auto: { label: 'Programmatic ad', icon: '¤', group: 'Grow', keys: 'ad auto programmatic network sponsor', data: () => ({ label: 'Sponsored' }) },
    ad: { label: 'Ad / sponsor slot', icon: '$', group: 'Grow', keys: 'ad sponsor sponsorship advertisement', data: () => ({ label: 'Together with', headline: '', body: '', url: '', image: '', cta: 'Learn more' }) },
    product: { label: 'Product', icon: '🛍', group: 'Grow', keys: 'product shop digital download sell', data: () => ({ product_id: '' }) },
    event: { label: 'Event', icon: '📅', group: 'Grow', keys: 'event webinar ticket', data: () => ({ event_id: '' }) },
    recommended_products: { label: 'Recommended products (personalized)', icon: '🎯', group: 'Grow', keys: 'recommended products personalized shop upsell cross-sell also bought picks for you', data: () => ({ title: 'Picked for you', limit: 3, cta: 'View', layout: 'grid' }) },
    snippet: { label: 'Saved snippet', icon: '⧉', group: 'Layout', keys: 'snippet reusable saved block synced signature footer sponsor banner', pseudo: true },
    html_document: { label: 'Coded email (full HTML)', icon: '</>', group: 'Layout', keys: 'html coded custom template raw document email code', data: () => ({ html: '' }) },
    ai: { label: 'Write with AI', icon: '✨', group: 'AI', keys: 'ai write generate gpt assistant draft', feature: 'ai', pseudo: true },
    aiimage: { label: 'Generate image with AI', icon: '🎨', group: 'AI', keys: 'ai image generate picture art', feature: 'ai', pseudo: true },
  };
  const realType = (key) => (TYPES[key] && TYPES[key].as) || key;

  const MERGE_TAGS = [['First name', '{{subscriber.first_name|there}}'], ['Full name', '{{subscriber.name}}'], ['Email', '{{subscriber.email}}'], ['Referral link', '{{referral_url}}'], ['Referral count', '{{referral_count}}'], ['Publication name', '{{publication.name}}'], ['Today’s date', '{{date}}']];

  // ═════════════════════════ Editor ═════════════════════════
  class Editor {
    constructor(el, opts) {
      this.el = el;
      this.opts = Object.assign({ features: {}, renderUrl: '/app/posts/render', uploadUrl: '/app/posts/media/upload', mediaUrl: '/app/posts/media.json', aiUrl: '/app/posts/ai', pickerUrl: '/app/posts/picker', pollsUrl: '/app/posts/polls', gifsUrl: '/app/posts/gifs' }, opts || {});
      this.features = Object.assign({ paywall: true, dynamic: true, polls: true, ai: true, collab: false }, this.opts.features || {});
      this.listeners = {};
      this.history = [];
      this.future = [];
      this.commentCounts = {};
      this.peerMap = {};
      el.classList.add('ohe');
      if (this.opts.compact) el.classList.add('ohe-compact');
      el.innerHTML = '';
      this.canvas = h('div', { class: 'ohe-canvas' });
      el.append(this.canvas);
      const doc = this.opts.doc && Array.isArray(this.opts.doc.blocks) ? this.opts.doc : { blocks: [] };
      this.root = new BlockList(this, this.canvas, doc.blocks, null);
      if (!this.root.items.length) this.root.insert(P(), 0);
      this.buildToolbar();
      this.buildSlash();
      this.bind();
      this.lastJSON = JSON.stringify(this.getDoc());
      this.history.push(this.lastJSON);
      this.emitChange = debounce(() => this.commit(), 250);
      this.syncInput();
      this.root.items.forEach((it) => it.view.afterMount && it.view.afterMount());
      active = this;
      if (this.features.collab && this.opts.collab) this.collab = new Collab(this, this.opts.collab);
    }

    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); return this; }
    emit(ev, ...a) { (this.listeners[ev] || []).forEach((f) => f(...a)); }

    getDoc() { return { blocks: this.root.toJSON() }; }
    setDoc(doc, { silent = false, keepHistory = false } = {}) {
      const focusId = this.focusedItem()?.block.id;
      this.root.setBlocks((doc && doc.blocks) || []);
      if (!this.root.items.length) this.root.insert(P(), 0);
      this.lastJSON = JSON.stringify(this.getDoc());
      if (!keepHistory) { this.history = [this.lastJSON]; this.future = []; }
      this.syncInput();
      if (focusId) { const it = this.findItem(focusId); if (it && it.view.focus) it.view.focus(true); }
      if (!silent) { this.opts.onChange && this.opts.onChange(this.getDoc()); this.emit('change', this.getDoc()); }
      if (this.collab) this.collab.snapshot();
    }
    syncInput() { if (this.opts.input) this.opts.input.value = this.lastJSON || JSON.stringify(this.getDoc()); }

    /** called by views on any edit */
    changed() { this.emitChange(); }
    commit() {
      const doc = this.getDoc();
      const json = JSON.stringify(doc);
      if (json === this.lastJSON) return;
      this.lastJSON = json;
      this.pushHistory(json);
      this.syncInput();
      this.opts.onChange && this.opts.onChange(doc);
      this.emit('change', doc);
      if (this.collab) this.collab.diff();
    }
    pushHistory(json) {
      if (this.history[this.history.length - 1] === json) return;
      this.history.push(json);
      if (this.history.length > 150) this.history.shift();
      this.future = [];
    }
    undo() {
      this.emitChange.flush();
      if (this.history.length < 2) return;
      this.future.push(this.history.pop());
      this.restore(this.history[this.history.length - 1]);
    }
    redo() {
      if (!this.future.length) return;
      const j = this.future.pop();
      this.history.push(j);
      this.restore(j);
    }
    restore(json) {
      this.setDoc(JSON.parse(json), { keepHistory: true, silent: true });
      this.lastJSON = json;
      this.syncInput();
      this.opts.onChange && this.opts.onChange(this.getDoc());
      this.emit('change', this.getDoc());
      if (this.collab) this.collab.diff();
    }

    plainText() {
      const out = [];
      const walk = (blocks) => blocks.forEach((b) => {
        const d = b.data || {};
        if (d.html) out.push(textOf(d.html));
        if (Array.isArray(d.items)) d.items.forEach((x) => out.push(textOf(typeof x === 'string' ? x : x.html || '')));
        if (d.code) out.push(d.code);
        if (Array.isArray(d.rows)) d.rows.forEach((r) => out.push(r.map(textOf).join(' ')));
        if (Array.isArray(d.blocks)) walk(d.blocks);
        if (Array.isArray(d.columns)) d.columns.forEach((c) => walk(c.blocks || []));
      });
      walk(this.getDoc().blocks);
      return out.filter(Boolean).join('\n\n');
    }

    /** Insert plain text (from AI etc.) as paragraphs/headings after the focused block. */
    insertText(text) {
      const blocks = textToBlocks(text);
      const it = this.focusedItem() || this.lastFocused || this.root.items[this.root.items.length - 1];
      const list = it ? it.list : this.root;
      let idx = it ? list.items.indexOf(it) + 1 : list.items.length;
      if (it && it.block.type === 'paragraph' && !textOf(it.view.toJSON().data.html).trim()) { idx--; list.remove(it); }
      let last;
      for (const b of blocks) last = list.insert(b, idx++);
      if (last) last.view.focus(true);
      this.changed();
    }

    findItem(id, list = this.root) {
      for (const it of list.items) {
        if (it.block.id === id) return it;
        for (const child of it.view.lists || []) { const f = this.findItem(id, child); if (f) return f; }
      }
      return null;
    }
    itemFromNode(node) {
      const el = node && (node.nodeType === 1 ? node : node.parentElement)?.closest('.ohe-block');
      return el && el._item;
    }
    focusedItem() { return this.itemFromNode(document.activeElement) || (caretRange() && this.itemFromNode(caretRange().startContainer)); }
    topItem(it) { while (it && it.list.parent) it = it.list.parent; return it; }

    focusBlock(id) {
      const it = this.findItem(id);
      if (!it) return;
      it.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      it.el.classList.add('ohe-flash');
      setTimeout(() => it.el.classList.remove('ohe-flash'), 1600);
    }
    setCommentCounts(map) {
      this.commentCounts = map || {};
      this.el.querySelectorAll('.ohe-block').forEach((b) => {
        const n = this.commentCounts[b.dataset.id] || 0;
        let badge = b.querySelector(':scope > .ohe-cbadge');
        if (n && !badge) { badge = h('button', { type: 'button', class: 'ohe-cbadge', 'aria-label': 'Comments', onclick: () => this.opts.onComment && this.opts.onComment(b.dataset.id, null, true) }); b.append(badge); }
        if (badge) { if (n) badge.textContent = '💬 ' + n; else badge.remove(); }
      });
    }

    destroy() {
      document.removeEventListener('selectionchange', this._onSel);
      this.collab && this.collab.close();
      this.toolbar.remove(); this.slash.remove();
      this.el.innerHTML = '';
      if (active === this) active = null;
    }

    // ───────── events ─────────
    bind() {
      const el = this.el;
      el.addEventListener('input', (e) => {
        const it = this.itemFromNode(e.target);
        if (!it) return;
        if (e.target.matches && e.target.matches('[contenteditable=true]')) this.inlineMarkdown(e);
        it.view.sync();
        if (it.block.type === 'paragraph') this.checkSlash(it);
        this.changed();
      });
      el.addEventListener('keydown', (e) => this.onKey(e));
      el.addEventListener('paste', (e) => this.onPaste(e));
      el.addEventListener('focusin', (e) => {
        const it = this.itemFromNode(e.target);
        if (!it) return;
        active = this;
        this.lastFocused = it;
        this.el.querySelectorAll('.ohe-sel').forEach((x) => x !== it.el && !x.contains(it.el) && x.classList.remove('ohe-sel'));
        it.el.classList.add('ohe-sel');
        if (this.collab) this.collab.presence(this.topItem(it).block.id);
        this.emit('focus', it.block.id);
      });
      el.addEventListener('focusout', (e) => {
        const it = this.itemFromNode(e.target);
        if (it && this.collab) setTimeout(() => this.collab.applyPending(), 50);
      });
      el.addEventListener('mousedown', (e) => {
        const it = this.itemFromNode(e.target);
        if (it && !e.target.closest('[contenteditable=true],input,textarea,select,button')) {
          this.el.querySelectorAll('.ohe-sel').forEach((x) => x.classList.remove('ohe-sel'));
          it.el.classList.add('ohe-sel');
          this.lastFocused = it;
        }
      });
      // drag & drop: files anywhere on the canvas
      el.addEventListener('dragover', (e) => {
        if (this.dragItem || [...(e.dataTransfer?.types || [])].includes('Files')) {
          e.preventDefault();
          const target = this.itemFromNode(e.target);
          this.showDropLine(target, e);
        }
      });
      el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) this.hideDropLine(); });
      el.addEventListener('drop', (e) => this.onDrop(e));
      this._onSel = () => this.updateToolbar();
      document.addEventListener('selectionchange', this._onSel);
      window.addEventListener('scroll', () => this.toolbar.classList.contains('on') && this.updateToolbar(), true);
    }

    showDropLine(target, e) {
      if (!this.dropLine) { this.dropLine = h('div', { class: 'ohe-dropline' }); document.body.append(this.dropLine); }
      if (!target) { this.dropTarget = null; this.dropLine.style.display = 'none'; return; }
      const r = target.el.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      this.dropTarget = { item: target, after };
      Object.assign(this.dropLine.style, { display: 'block', top: (after ? r.bottom : r.top) + window.scrollY - 2 + 'px', left: r.left + window.scrollX + 'px', width: r.width + 'px' });
    }
    hideDropLine() { if (this.dropLine) this.dropLine.style.display = 'none'; }

    async onDrop(e) {
      const t = this.dropTarget;
      this.hideDropLine();
      if (this.dragItem) {
        e.preventDefault();
        const src = this.dragItem;
        this.dragItem = null;
        if (!t || t.item === src || src.el.contains(t.item.el)) return;
        const block = src.view.toJSON();
        src.list.remove(src);
        const idx = t.item.list.items.indexOf(t.item) + (t.after ? 1 : 0);
        t.item.list.insert(block, idx);
        this.changed();
        return;
      }
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      // let image blocks handle drops on themselves
      if (e.target.closest('.ohe-dropzone')) return;
      e.preventDefault();
      const list = t ? t.item.list : this.root;
      let idx = t ? list.items.indexOf(t.item) + (t.after ? 1 : 0) : list.items.length;
      for (const f of files) {
        const it = list.insert(fileBlock(f), idx++);
        it.view.uploadFile && it.view.uploadFile(f);
      }
      this.changed();
    }

    onKey(e) {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const target = e.target;
      const it = this.itemFromNode(target);
      // slash menu navigation
      if (this.slash.classList.contains('on')) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.slashMove(e.key === 'ArrowDown' ? 1 : -1); return; }
        if (e.key === 'Enter') { e.preventDefault(); this.slashChoose(); return; }
        if (e.key === 'Escape') { e.preventDefault(); this.hideSlash(); return; }
      }
      if (mod && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
        if (k === 'y') { e.preventDefault(); this.redo(); return; }
        if (k === 'k' && this.isRich(target)) { e.preventDefault(); this.linkPrompt(); return; }
        if (k === 'e' && this.isRich(target)) { e.preventDefault(); this.toggleInline('code'); return; }
        if (e.shiftKey && (e.key === '7' || e.key === '&') && it) { e.preventDefault(); this.convert(it, 'olist'); return; }
        if (e.shiftKey && (e.key === '8' || e.key === '*') && it) { e.preventDefault(); this.convert(it, 'list'); return; }
        if (e.shiftKey && k === 'x' && this.isRich(target)) { e.preventDefault(); document.execCommand('strikeThrough'); return; }
        if (e.altKey === false && ['1', '2', '3'].includes(e.key) && e.shiftKey === false && it && TYPES[it.block.type]?.text) { /* allow browser default */ }
        if (k === 'd' && it && !this.isRich(target)) { e.preventDefault(); this.duplicate(it); return; }
      }
      if (!it) return;
      if (it.view.onKey && it.view.onKey(e) === true) return;
    }
    isRich(t) { return t && t.closest && t.closest('[contenteditable=true]') && this.el.contains(t); }

    // Enter / Backspace behaviour for simple text blocks (paragraph, heading)
    textKey(view, e, el) {
      const it = view.item;
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        const right = splitAtCaret(el);
        view.sync();
        const nb = P(right);
        const ni = it.list.insert(nb, it.list.items.indexOf(it) + 1);
        ni.view.focus(false);
        this.changed();
        return true;
      }
      if (e.key === 'Backspace' && atStart(el) && caretRange()?.collapsed) {
        const idx = it.list.items.indexOf(it);
        if (it.block.type === 'heading') { e.preventDefault(); this.convert(it, 'paragraph'); return true; }
        const prev = it.list.items[idx - 1];
        if (!prev) {
          if (!textOf(el.innerHTML).trim() && it.list.parent && it.list.items.length > 1) { e.preventDefault(); it.list.remove(it); this.changed(); }
          return false;
        }
        e.preventDefault();
        if (prev.view.mergeTarget) {
          const t = prev.view.mergeTarget();
          const len = t.textContent.length;
          const html = cleanInline(el);
          if (html) t.insertAdjacentHTML('beforeend', html);
          prev.view.sync();
          it.list.remove(it);
          t.focus();
          placeCaretAtOffset(t, len);
        } else if (!textOf(el.innerHTML).trim()) {
          it.list.remove(it);
          prev.view.focus(true);
        } else prev.el.classList.add('ohe-sel');
        this.changed();
        return true;
      }
      if (e.key === 'Delete' && atEnd(el) && caretRange()?.collapsed) {
        const next = it.list.items[it.list.items.indexOf(it) + 1];
        if (next && next.view.mergeTarget && TYPES[next.block.type]?.text) {
          e.preventDefault();
          const len = el.textContent.length;
          el.insertAdjacentHTML('beforeend', cleanInline(next.view.mergeTarget()));
          it.list.remove(next);
          view.sync(); placeCaretAtOffset(el, len); this.changed();
          return true;
        }
      }
      if (e.key === 'ArrowUp' && atStart(el)) { const prev = this.neighbor(it, -1); if (prev) { e.preventDefault(); prev.view.focus(true); return true; } }
      if (e.key === 'ArrowDown' && atEnd(el)) { const next = this.neighbor(it, 1); if (next) { e.preventDefault(); next.view.focus(false); return true; } }
      if (e.key === ' ' && it.block.type === 'paragraph') {
        const before = rangeText(el, true);
        if (before && atEnd(el)) {
          // Markdown levels map to the same heading level. In posts the H1 is the post title, so '#' gives an H2;
          // compact editors (automation emails, page sections) have no title and get a real H1.
          const m = { '#': this.opts.compact ? 'h1' : 'h2', '##': 'h2', '###': 'h3', '####': 'h4', '-': 'list', '*': 'list', '1.': 'olist', '>': 'quote', '[]': 'checklist', '[ ]': 'checklist', '```': 'code' }[before.text.trim()];
          if (m && before.text.trim() === el.textContent.trim()) {
            e.preventDefault();
            el.innerHTML = '';
            view.sync();
            this.convert(it, m, true);
            return true;
          }
        }
      }
      return false;
    }
    neighbor(it, dir) {
      const idx = it.list.items.indexOf(it);
      const n = it.list.items[idx + dir];
      return n && n.view.focus ? n : null;
    }

    inlineMarkdown(e) {
      if (e.inputType !== 'insertText') return;
      const r = caretRange();
      if (!r || !r.collapsed || r.startContainer.nodeType !== 3) return;
      const node = r.startContainer, off = r.startOffset;
      const before = node.textContent.slice(0, off);
      const rules = [[/\*\*([^*]+)\*\*$/, 'strong'], [/__([^_]+)__$/, 'strong'], [/`([^`]+)`$/, 'code'], [/(?:^|[^*])\*([^*\s][^*]*)\*$/, 'em'], [/(?:^|[^_\w])_([^_\s][^_]*)_$/, 'em'], [/~~([^~]+)~~$/, 's']];
      for (const [re, tag] of rules) {
        const m = before.match(re);
        if (!m) continue;
        const full = m[0].startsWith(m[1]) ? m[0] : m[0].slice(m[0].indexOf(m[0].replace(/^[^*_`~]/, '')));
        const matchStr = full.replace(/^[^*_`~]/, '');
        const start = off - matchStr.length;
        const range = document.createRange();
        range.setStart(node, start); range.setEnd(node, off);
        range.deleteContents();
        const elx = document.createElement(tag);
        elx.textContent = m[1];
        range.insertNode(elx);
        const space = document.createTextNode('​');
        elx.after(space);
        const s = sel(); const nr = document.createRange(); nr.setStart(space, 1); nr.collapse(true); s.removeAllRanges(); s.addRange(nr);
        return;
      }
    }

    // ───────── paste ─────────
    async onPaste(e) {
      const t = e.target;
      if (t.matches && t.matches('input, textarea')) return; // plain fields
      const it = this.itemFromNode(t);
      if (!it || !this.isRich(t)) return;
      const cd = e.clipboardData;
      const files = [...(cd.files || [])].filter((f) => /^image\//.test(f.type));
      if (files.length) {
        e.preventDefault();
        let idx = it.list.items.indexOf(it) + 1;
        for (const f of files) { const ni = it.list.insert(fileBlock(f), idx++); ni.view.uploadFile(f); }
        this.changed();
        return;
      }
      const html = cd.getData('text/html');
      const text = cd.getData('text/plain');
      // single-element contexts (table cells, captions, list items, quotes) only accept inline content
      const inlineOnly = !['paragraph', 'heading'].includes(it.block.type) || t.closest('.ohe-caption,.ohe-cite,td,th,li');
      if (!html && text && isEmbedUrl(text.trim()) && !inlineOnly) {
        e.preventDefault();
        const ni = it.list.insert({ id: uid(), type: 'embed', data: { url: text.trim(), caption: '' } }, it.list.items.indexOf(it) + (textOf(it.view.toJSON().data.html || '').trim() ? 1 : 0));
        if (!textOf(it.view.toJSON().data.html || '').trim() && it.block.type === 'paragraph') it.list.remove(it);
        ni.view.refresh && ni.view.refresh();
        this.changed();
        return;
      }
      if (!html && text && /^https?:\/\/\S+$/.test(text.trim()) && !caretRange().collapsed) {
        e.preventDefault();
        document.execCommand('createLink', false, text.trim());
        return;
      }
      e.preventDefault();
      if (inlineOnly || (!html && !/\n/.test(text))) {
        const inl = html ? cleanHTML(html) : esc(text).replace(/\n/g, '<br>');
        insertHTMLAtCaret(inl);
        it.view.sync(); this.changed();
        return;
      }
      const blocks = html ? htmlToBlocks(html) : textToBlocks(text);
      if (!blocks.length) return;
      // first block of inline-ish content merges into the current paragraph at the caret
      const el = it.view.mergeTarget ? it.view.mergeTarget() : null;
      let idx = it.list.items.indexOf(it) + 1;
      if (el && blocks[0].type === 'paragraph') {
        const right = splitAtCaret(el);
        el.insertAdjacentHTML('beforeend', blocks.shift().data.html);
        it.view.sync();
        if (right) blocks.push(P(right));
      } else if (el && !el.textContent.trim()) { idx--; it.list.remove(it); }
      let last;
      const added = [];
      for (const b of blocks) added.push((last = it.list.insert(b, idx++)));
      if (last && last.view.focus) last.view.focus(true);
      this.changed();
      this.importPastedImages(added);
    }

    /**
     * Pasted Google Docs (and Drive/Photos) images point at short-lived googleusercontent.com URLs that stop
     * working after a while. Copy them into the media library server-side and swap the src.
     */
    async importPastedImages(items) {
      const expiring = (u) => /^https:\/\/[^/]*googleusercontent\.com\//i.test(u || '');
      const todo = items.filter((x) => x && x.block.type === 'image' && expiring(x.view.d.src));
      if (!todo.length) return;
      OHToast(`Copying ${todo.length} pasted image${todo.length > 1 ? 's' : ''} to your media library…`, 3000);
      let failed = 0;
      await Promise.all(todo.map(async (x) => {
        const from = x.view.d.src;
        try {
          const r = await postJSON(this.opts.importUrl || '/app/posts/media/import', { url: from });
          if (!r.url || x.view.d.src !== from || !x.el.isConnected) return;
          x.view.d.src = r.url;
          x.view.draw();
        } catch { failed++; }
      }));
      this.changed();
      if (failed) OHToast(`${failed} pasted image${failed > 1 ? 's' : ''} could not be copied — re-upload ${failed > 1 ? 'them' : 'it'} before sending (Google image links expire)`, 6000);
    }

    // ───────── structure ops ─────────
    convert(it, key, focus = true) {
      const t = realType(key);
      const cur = it.view.toJSON();
      const text = cur.data.html ?? (Array.isArray(cur.data.items) ? cur.data.items.map((x) => (typeof x === 'string' ? x : x.html || '')).join('<br>') : cur.data.code ? esc(cur.data.code) : '');
      let data = TYPES[key].data();
      if (t === 'paragraph' || t === 'heading' || t === 'quote') data.html = text;
      if (t === 'list') data.items = text ? text.split(/<br\s*\/?>/i).filter((x) => textOf(x).trim() || true) : [''];
      if (t === 'checklist') data.items = (text ? text.split(/<br\s*\/?>/i) : ['']).map((x) => ({ html: x, checked: false }));
      if (t === 'code') data.code = textOf(text.replace(/<br\s*\/?>/gi, '\n'));
      if (cur.data.show_in) data.show_in = cur.data.show_in; // keep the email/web channel
      const nb = { id: cur.id, type: t, data };
      const idx = it.list.items.indexOf(it);
      it.list.remove(it, true);
      const ni = it.list.insert(nb, idx);
      if (focus && ni.view.focus) ni.view.focus(true);
      this.changed();
      return ni;
    }
    duplicate(it) {
      const b = clone(it.view.toJSON());
      const reid = (x) => { x.id = uid(); const d = x.data || {}; (d.blocks || []).forEach(reid); (Array.isArray(d.columns) ? d.columns : []).forEach((c) => (c.blocks || []).forEach(reid)); };
      reid(b);
      it.list.insert(b, it.list.items.indexOf(it) + 1);
      this.changed();
    }
    move(it, dir) {
      const idx = it.list.items.indexOf(it);
      const to = idx + dir;
      if (to < 0 || to >= it.list.items.length) return;
      const b = it.view.toJSON();
      it.list.remove(it);
      const ni = it.list.insert(b, to);
      ni.el.scrollIntoView({ block: 'nearest' });
      this.changed();
    }

    /** Insert a block (by registry key) after `it` (or replace it if it's an empty paragraph). */
    insertType(key, it, replaceEmpty = true) {
      if (TYPES[key].pseudo) return this.pseudo(key, it);
      if (key === 'paywall' && this.root.toJSON().some((b) => b.type === 'paywall')) { OHToast('A post can only have one paywall break'); return; }
      const nb = { id: uid(), type: realType(key), data: TYPES[key].data() };
      const list = it ? it.list : this.root;
      let idx = it ? list.items.indexOf(it) + 1 : list.items.length;
      if (it && replaceEmpty && it.block.type === 'paragraph' && !textOf(it.view.toJSON().data.html).trim()) { idx--; list.remove(it); }
      const ni = list.insert(nb, idx);
      // keep a paragraph after non-text blocks so writing can continue
      if (!TYPES[key].text && !['h2', 'h3', 'h4', 'list', 'olist', 'checklist', 'quote', 'code'].includes(key) && !list.items[idx + 1]) list.insert(P(), idx + 1);
      if (ni.view.focus) ni.view.focus(false);
      else ni.el.classList.add('ohe-sel');
      ni.view.afterMount && ni.view.afterMount();
      if (ni.view.autoOpen) ni.view.autoOpen();
      this.changed();
      return ni;
    }

    async pseudo(key, it) {
      if (key === 'snippet') {
        const blocks = await snippetPicker(this);
        if (!blocks || !blocks.length) return;
        const list = it ? it.list : this.root;
        let idx = it ? list.items.indexOf(it) + 1 : list.items.length;
        if (it && it.block.type === 'paragraph' && !textOf(it.view.toJSON().data.html).trim()) { idx--; list.remove(it, true); }
        let last = null;
        for (const b of blocks) last = list.insert(b, idx++);
        if (!list.items[idx]) list.insert(P(), idx);
        if (last) last.el.classList.add('ohe-sel');
        this.changed();
        return;
      }
      if (key === 'gif') {
        const g = await gifPicker(this);
        if (!g) return;
        const list = it ? it.list : this.root;
        let idx = it ? list.items.indexOf(it) + 1 : list.items.length;
        if (it && it.block.type === 'paragraph' && !textOf(it.view.toJSON().data.html).trim()) { idx--; list.remove(it); }
        const ni = list.insert({ id: uid(), type: 'image', data: { ...TYPES.image.data(), src: g.url, alt: g.alt || 'GIF' } }, idx);
        if (!list.items[idx + 1]) list.insert(P(), idx + 1);
        ni.el.classList.add('ohe-sel');
        this.changed();
        return;
      }
      if (key === 'ai') {
        const prompt = await promptBox('Write with AI', 'What should I write about?', '', { multiline: true });
        if (!prompt) return;
        OHToast('Writing…', 4000);
        try {
          const r = await postJSON(this.opts.aiUrl, { action: 'write', prompt, text: this.plainText().slice(0, 3000) });
          if (it) this.lastFocused = it;
          this.insertText(r.text);
        } catch (err) { OHToast(err.message, 5000); }
      }
      if (key === 'aiimage') {
        const prompt = await promptBox('Generate image', 'Describe the image', '', { multiline: true });
        if (!prompt) return;
        OHToast('Generating image…', 6000);
        try {
          const r = await postJSON(this.opts.aiUrl, { action: 'image', prompt });
          const list = it ? it.list : this.root;
          const ni = list.insert({ id: uid(), type: 'image', data: { ...TYPES.image.data(), src: r.url, alt: prompt.slice(0, 120) } }, it ? list.items.indexOf(it) + 1 : list.items.length);
          ni.el.classList.add('ohe-sel');
          this.changed();
        } catch (err) { OHToast(err.message, 5000); }
      }
    }

    // ───────── slash menu ─────────
    buildSlash() {
      this.slash = h('div', { class: 'ohe-slash', role: 'listbox' });
      this.slashSearch = h('input', { class: 'ohe-slash-q', placeholder: 'Search blocks…', 'aria-label': 'Search blocks' });
      this.slashBody = h('div');
      this.slash.append(this.slashSearch, this.slashBody);
      document.body.append(this.slash);
      this.slashSearch.addEventListener('input', () => { this.slashQuery = this.slashSearch.value.toLowerCase(); this.slashIdx = 0; this.renderSlash(); });
      this.slashSearch.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.slashMove(e.key === 'ArrowDown' ? 1 : -1); }
        else if (e.key === 'Enter') { e.preventDefault(); this.slashChoose(); }
        else if (e.key === 'Escape') { e.preventDefault(); this.hideSlash(); }
      });
      this.slash.addEventListener('mousedown', (e) => {
        const b = e.target.closest('[data-key]');
        if (!b) return;
        e.preventDefault();
        this.slashIdx = +b.dataset.idx;
        this.slashChoose();
      });
      document.addEventListener('mousedown', (e) => { if (!this.slash.contains(e.target)) this.hideSlash(); });
    }
    availableTypes() {
      return Object.entries(TYPES).filter(([k, t]) => !t.hidden && (!t.feature || this.features[t.feature]) && !(this.opts.compact && ['paywall', 'toc', 'subscribe'].includes(k)) && !(this.opts.exclude || []).includes(k));
    }
    openSlash(it, anchorEl, mode = 'replace') {
      this.slashItem = it;
      this.slashMode = mode;
      this.slashQuery = '';
      this.slashIdx = 0;
      this.renderSlash();
      const r = (anchorEl || it.el).getBoundingClientRect();
      const top = Math.min(r.bottom + 6, window.innerHeight - 340);
      Object.assign(this.slash.style, { top: top + window.scrollY + 'px', left: Math.max(8, Math.min(r.left, window.innerWidth - 330)) + window.scrollX + 'px' });
      this.slash.classList.add('on');
      this.slashSearch.value = '';
      this.slashSearch.style.display = mode === 'insert' ? '' : 'none';
      if (mode === 'insert') setTimeout(() => this.slashSearch.focus());
    }
    checkSlash(it) {
      const el = it.view.mergeTarget();
      const t = el.textContent;
      if (t.startsWith('/') && !t.includes(' ', 1) && t.length < 30) {
        if (!this.slash.classList.contains('on') || this.slashItem !== it) this.openSlash(it, el, 'replace');
        this.slashQuery = t.slice(1).toLowerCase();
        this.slashIdx = 0;
        this.renderSlash();
      } else if (this.slashItem === it && this.slashMode === 'replace') this.hideSlash();
    }
    renderSlash() {
      const q = (this.slashQuery || '').trim();
      this.slashList = this.availableTypes().filter(([k, t]) => !q || t.label.toLowerCase().includes(q) || (t.keys || '').includes(q) || k.includes(q));
      if (!this.slashList.length) { this.slashBody.innerHTML = '<div class="ohe-slash-empty">No matching blocks</div>'; return; }
      let group = '';
      this.slashBody.innerHTML = this.slashList.map(([k, t], i) => {
        const g = t.group !== group ? `<div class="ohe-slash-g">${esc((group = t.group))}</div>` : '';
        return `${g}<button type="button" role="option" class="ohe-slash-i ${i === this.slashIdx ? 'on' : ''}" data-key="${k}" data-idx="${i}"><span class="ohe-slash-ic">${esc(t.icon)}</span>${esc(t.label)}</button>`;
      }).join('');
      this.slashBody.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
    }
    slashMove(d) { if (!this.slashList?.length) return; this.slashIdx = (this.slashIdx + d + this.slashList.length) % this.slashList.length; this.renderSlash(); }
    slashChoose() {
      const choice = this.slashList?.[this.slashIdx];
      const it = this.slashItem;
      this.hideSlash();
      if (!choice) return;
      if (this.slashMode === 'replace' && it && it.block.type === 'paragraph') {
        const el = it.view.mergeTarget();
        if (el.textContent.startsWith('/')) { el.innerHTML = ''; it.view.sync(); }
        this.insertType(choice[0], it, true);
      } else this.insertType(choice[0], it, false);
    }
    hideSlash() { this.slash.classList.remove('on'); this.slashItem = null; }

    // ───────── inline toolbar ─────────
    buildToolbar() {
      const B = (cmd, label, html, title) => `<button type="button" data-cmd="${cmd}" aria-label="${label}" title="${title || label}">${html}</button>`;
      this.toolbar = h('div', { class: 'ohe-toolbar', role: 'toolbar', 'aria-label': 'Text formatting' });
      this.toolbar.innerHTML = [
        B('bold', 'Bold', '<b>B</b>', `Bold (${isMac ? '⌘' : 'Ctrl+'}B)`), B('italic', 'Italic', '<i>I</i>', `Italic (${isMac ? '⌘' : 'Ctrl+'}I)`), B('underline', 'Underline', '<u>U</u>'), B('strikeThrough', 'Strikethrough', '<s>S</s>'),
        B('code', 'Inline code', '&lt;/&gt;'), B('link', 'Link', '🔗', `Link (${isMac ? '⌘' : 'Ctrl+'}K)`), B('mark', 'Highlight', '<mark>H</mark>'), B('superscript', 'Superscript', 'x²'), B('subscript', 'Subscript', 'x₂'),
        B('footnote', 'Footnote or citation', '†', 'Footnote / citation'), B('merge', 'Insert merge tag', '{ }', 'Personalize with a merge tag'), B('clear', 'Clear formatting', '⌫', 'Clear formatting'),
        this.features.ai ? '<span class="ohe-tb-sep"></span>' + B('ai', 'AI writing tools', '✨ AI', 'Rewrite, shorten, fix, translate…') : '',
      ].join('');
      document.body.append(this.toolbar);
      this.toolbar.addEventListener('mousedown', (e) => e.preventDefault());
      this.toolbar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-cmd]');
        if (b) this.format(b.dataset.cmd, b);
      });
    }
    updateToolbar() {
      const s = sel();
      if (!s || !s.rangeCount || s.isCollapsed) return this.toolbar.classList.remove('on');
      const r = s.getRangeAt(0);
      const host = (r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement)?.closest('[contenteditable=true]');
      if (!host || !this.el.contains(host) || host.closest('.ohe-code')) return this.toolbar.classList.remove('on');
      const rect = r.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      this.toolbar.classList.add('on');
      const tw = this.toolbar.offsetWidth;
      const top = rect.top + window.scrollY - this.toolbar.offsetHeight - 8;
      Object.assign(this.toolbar.style, { top: (rect.top < 60 ? rect.bottom + window.scrollY + 8 : top) + 'px', left: Math.max(8, Math.min(rect.left + rect.width / 2 - tw / 2, window.innerWidth - tw - 8)) + window.scrollX + 'px' });
      for (const cmd of ['bold', 'italic', 'underline', 'strikeThrough', 'superscript', 'subscript']) {
        let on = false; try { on = document.queryCommandState(cmd); } catch {}
        this.toolbar.querySelector(`[data-cmd="${cmd}"]`)?.classList.toggle('on', on);
      }
      this.toolbar.querySelector('[data-cmd="link"]')?.classList.toggle('on', !!closestTag('a'));
    }
    toggleInline(tag) {
      const ex = closestTag(tag);
      if (ex) { const p = ex.parentNode; while (ex.firstChild) p.insertBefore(ex.firstChild, ex); ex.remove(); }
      else wrapSelection(tag);
      this.afterFormat();
    }
    afterFormat() { const it = this.focusedItem(); if (it) { it.view.sync(); this.changed(); } this.updateToolbar(); }
    async format(cmd, btn) {
      if (['bold', 'italic', 'underline', 'strikeThrough', 'superscript', 'subscript'].includes(cmd)) { document.execCommand(cmd); return this.afterFormat(); }
      if (cmd === 'code') return this.toggleInline('code');
      if (cmd === 'mark') return this.toggleInline('mark');
      if (cmd === 'clear') { document.execCommand('removeFormat'); document.execCommand('unlink'); const m = closestTag('mark') || closestTag('code'); if (m) { const p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); m.remove(); } return this.afterFormat(); }
      if (cmd === 'link') return this.linkPrompt();
      if (cmd === 'footnote') {
        const r = caretRange()?.cloneRange();
        const note = await promptBox('Footnote or citation', 'Note text (URLs become links)', '', { multiline: true });
        if (!note) return;
        restoreRange(r, true);
        insertHTMLAtCaret(`<span data-footnote="${esc(note)}" contenteditable="false" class="ohe-fn"></span>&#8203;`);
        return this.afterFormat();
      }
      if (cmd === 'merge') {
        const r = caretRange()?.cloneRange();
        const tag = await menuBox(btn, MERGE_TAGS.map(([l, v]) => ({ label: l, value: v, sub: v })));
        if (!tag) return;
        restoreRange(r, true);
        document.execCommand('insertText', false, tag);
        return this.afterFormat();
      }
      if (cmd === 'ai') return this.aiEdit(btn);
    }
    /** The rich-text element the AI should rewrite when nothing is selected: the caret's element (list item, cell…) or the block's main text. */
    aiTarget(it, r) {
      let n = r && this.el.contains(r.startContainer) ? r.startContainer : null;
      if (n && n.nodeType !== 1) n = n.parentElement;
      let host = n && n.closest('[contenteditable=true]');
      if (host && it && !it.el.contains(host)) host = null;
      if (host && /^(UL|OL)$/.test(host.tagName)) host = n.closest('li');
      if (!host && it && it.view.mergeTarget) host = it.view.mergeTarget();
      return host && this.el.contains(host) ? host : null;
    }
    /**
     * AI rewrite / fix / translate in place, keeping inline formatting: the selection (or, with nothing selected,
     * the current block's text) is sent as inline HTML, footnotes travel as ⟦fnN⟧ placeholders, and the
     * sanitized HTML that comes back replaces the same range.
     */
    async aiEdit(anchor, item = null) {
      const cur = caretRange();
      let range;
      if (!item && cur && !cur.collapsed && this.el.contains(cur.commonAncestorContainer)) range = cur.cloneRange();
      else {
        const it = item || this.focusedItem() || this.lastFocused;
        const target = it && this.aiTarget(it, item ? null : cur);
        if (!target) { OHToast('Select some text, or click into a text block first', 4000); return; }
        range = document.createRange();
        range.selectNodeContents(target);
      }
      const box = document.createElement('div');
      box.append(range.cloneContents());
      const notes = [];
      box.querySelectorAll('span[data-footnote]').forEach((s) => { notes.push(s.getAttribute('data-footnote')); s.replaceWith(`⟦fn${notes.length}⟧`); });
      const html = cleanInline(box);
      if (!textOf(html).trim()) { OHToast('Select some text, or click into a text block first', 4000); return; }
      const action = await menuBox(anchor, [
        { label: 'Improve writing', value: 'rewrite' }, { label: 'Fix spelling & grammar', value: 'fix' }, { label: 'Make shorter', value: 'shorten' }, { label: 'Make longer', value: 'expand' },
        { label: 'Change tone: friendly', value: 'tone:friendly' }, { label: 'Change tone: professional', value: 'tone:professional' }, { label: 'Change tone: witty', value: 'tone:witty' },
        { label: 'Translate…', value: 'translate' },
      ]);
      if (!action) return;
      let lang;
      if (action === 'translate') { lang = await promptBox('Translate', 'Target language', 'Spanish'); if (!lang) return; }
      OHToast('Working…', 4000);
      try {
        const [act, tone] = action.split(':');
        const res = await postJSON(this.opts.aiUrl, { action: act, tone, lang, html, text: box.textContent });
        let out = typeof res.html === 'string' ? res.html : esc(res.text || '').replace(/\n/g, '<br>');
        const used = new Set();
        out = out.replace(/⟦fn(\d+)⟧/g, (_, n) => { const note = notes[+n - 1]; if (note == null || used.has(n)) return ''; used.add(n); return `<span data-footnote="${esc(note)}"></span>`; });
        notes.forEach((note, i) => { if (!used.has(String(i + 1))) out += `<span data-footnote="${esc(note)}"></span>`; }); // never drop a footnote
        out = cleanHTML(out);
        if (!textOf(out).trim()) throw new Error('The AI returned an empty result');
        if (!range.startContainer.isConnected) throw new Error('The text changed while the AI was working — try again');
        let host = range.commonAncestorContainer;
        if (host.nodeType !== 1) host = host.parentElement;
        host = host.closest('[contenteditable=true]');
        host && host.focus({ preventScroll: true });
        restoreRange(range, false);
        document.execCommand('insertHTML', false, out);
        this.afterFormat();
        const it = host && this.itemFromNode(host);
        if (it) { it.view.sync(); this.changed(); }
        OHToast('Done');
      } catch (err) { OHToast(err.message, 5000); }
    }
    async linkPrompt() {
      const r = caretRange()?.cloneRange();
      const a = closestTag('a');
      const url = await promptBox(a ? 'Edit link' : 'Add link', 'https://… or {{referral_url}}', a ? a.getAttribute('href') : '', { remove: !!a });
      if (url === null) return;
      if (a && url === '') { const p = a.parentNode; while (a.firstChild) p.insertBefore(a.firstChild, a); a.remove(); return this.afterFormat(); }
      if (a) { a.setAttribute('href', url); return this.afterFormat(); }
      restoreRange(r, false);
      const href = /^(https?:|mailto:|tel:|#|\/|\{\{)/i.test(url) ? url : 'https://' + url;
      if (caretRange()?.collapsed) insertHTMLAtCaret(`<a href="${esc(href)}">${esc(url)}</a>`);
      else document.execCommand('createLink', false, href);
      this.afterFormat();
    }

    // ───────── find & replace ─────────
    // Covers every text field of the doc: rich text (paragraphs, headings, lists, quotes + cites, captions,
    // gallery captions, table cells) — matching across inline formatting — plus plain text fields marked
    // data-find (button labels, alt/title, ad/referral/embed text, code). Replacements commit as one undo step.
    findTargets() {
      const out = [];
      this.el.querySelectorAll('[contenteditable=true], input[data-find], textarea[data-find]').forEach((el) => {
        if (el.closest('.ohe-preview')) return;
        if (el.isContentEditable && el.parentElement?.closest('[contenteditable=true]')) return; // nested host: covered by its parent
        out.push(el);
      });
      return out;
    }
    /** Concatenated text of a rich host with a map back to its text nodes (non-editable islands like footnotes skipped). */
    hostText(host) {
      const nodes = [];
      let text = '';
      const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest('[contenteditable=false]') && host.contains(n.parentElement.closest('[contenteditable=false]')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
      let n;
      while ((n = w.nextNode())) { nodes.push({ n, start: text.length }); text += n.textContent; }
      return { text, nodes };
    }
    pointAt(nodes, off, isEnd) {
      for (let i = 0; i < nodes.length; i++) {
        const { n, start } = nodes[i];
        const len = n.textContent.length;
        if (off < start + len || (isEnd && off === start + len) || i === nodes.length - 1) return [n, Math.min(len, Math.max(0, off - start))];
      }
      return null;
    }
    find(q, { caseSensitive = false } = {}) {
      this.findMatches = [];
      this.findRanges = [];
      this.el.querySelectorAll('.ohe-find-hit').forEach((x) => x.classList.remove('ohe-find-hit'));
      if (window.CSS && CSS.highlights) CSS.highlights.delete('ohe-find');
      if (!q) return 0;
      const needle = caseSensitive ? q : q.toLowerCase();
      const scan = (hay, fn) => { const h2 = caseSensitive ? hay : hay.toLowerCase(); let i = 0; while ((i = h2.indexOf(needle, i)) !== -1) { fn(i); i += needle.length; } };
      for (const el of this.findTargets()) {
        if (el.isContentEditable) {
          const { text, nodes } = this.hostText(el);
          scan(text, (i) => {
            const a = this.pointAt(nodes, i, false), b = this.pointAt(nodes, i + q.length, true);
            if (!a || !b) return;
            const r = document.createRange(); r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]);
            this.findMatches.push({ range: r, host: el });
            this.findRanges.push(r);
          });
        } else {
          scan(el.value, (i) => { this.findMatches.push({ field: el, start: i, end: i + q.length }); el.classList.add('ohe-find-hit'); });
        }
      }
      if (window.CSS && CSS.highlights && window.Highlight && this.findRanges.length) CSS.highlights.set('ohe-find', new Highlight(...this.findRanges));
      this.findPos = -1;
      this.findQ = { q, caseSensitive };
      return this.findMatches.length;
    }
    revealMatch(m) {
      const node = m.field || m.host;
      const it = this.itemFromNode(node);
      if (it) { this.el.querySelectorAll('.ohe-sel').forEach((x) => x.classList.remove('ohe-sel')); for (let p = it; p; p = p.list.parent) p.el.classList.add('ohe-sel'); }
      if (m.field) { m.field.focus({ preventScroll: true }); m.field.setSelectionRange(m.start, m.end); }
      else { const s = sel(); s.removeAllRanges(); s.addRange(m.range); }
      (m.field || m.range.startContainer.parentElement).scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    findNext() {
      if (!this.findMatches?.length) return;
      this.findPos = (this.findPos + 1) % this.findMatches.length;
      this.revealMatch(this.findMatches[this.findPos]);
    }
    replace(q, rep, { all = false, caseSensitive = false } = {}) {
      if (!q) return 0;
      this.emitChange.flush(); // earlier typing becomes its own undo step
      if (!this.findMatches || !this.findQ || this.findQ.q !== q || this.findQ.caseSensitive !== caseSensitive) this.find(q, { caseSensitive });
      const matches = all ? [...this.findMatches] : [this.findMatches[Math.max(0, this.findPos)]].filter(Boolean);
      let count = 0;
      const hosts = new Set(), fields = new Map();
      // back to front so earlier offsets/ranges stay valid
      for (const m of matches.reverse()) {
        if (m.field) {
          const v = m.field.value;
          if (v.slice(m.start, m.end).toLowerCase() !== q.toLowerCase()) continue;
          m.field.value = v.slice(0, m.start) + rep + v.slice(m.end);
          fields.set(m.field, true);
          count++;
        } else if (m.range.startContainer.isConnected) {
          const r = m.range;
          r.deleteContents();
          if (rep) r.insertNode(document.createTextNode(rep));
          hosts.add(m.host);
          count++;
        }
      }
      // drop formatting wrappers emptied by a cross-format replacement, then merge text nodes
      for (const host of hosts) {
        host.querySelectorAll('strong,b,em,i,u,s,code,mark,sub,sup,small,a,span:not([data-footnote])').forEach((x) => { if (!x.textContent && !x.querySelector('br,[data-footnote],img')) x.remove(); });
        host.normalize();
      }
      for (const f of fields.keys()) f.dispatchEvent(new Event('input', { bubbles: true })); // settings bars / code views update their data
      const resync = (list) => list.items.forEach((it) => { it.view.sync(); (it.view.lists || []).forEach(resync); });
      resync(this.root);
      this.commit(); // one history entry for the whole replace → a single undo restores it
      this.emitChange.cancel();
      this.find(q, { caseSensitive });
      return count;
    }
  }

  // ═════════════════════════ BlockList ═════════════════════════
  class BlockList {
    constructor(editor, el, blocks, parent) {
      this.editor = editor;
      this.el = el;
      this.parent = parent; // owning item (nested lists)
      this.items = [];
      el.classList.add('ohe-list');
      this.setBlocks(blocks);
    }
    setBlocks(blocks) {
      this.items.forEach((it) => it.view.destroy && it.view.destroy());
      this.items = [];
      this.el.innerHTML = '';
      (blocks || []).forEach((b) => this.insert(b, this.items.length));
    }
    insert(block, index) {
      const b = { id: block.id || uid(), type: block.type, data: clone(block.data || {}) };
      if (!VIEWS[b.type]) return this.insert({ id: b.id, type: 'html', data: { html: `<p>Unsupported block: ${esc(b.type)}</p>` } }, index);
      const it = { block: b, list: this };
      it.el = h('div', { class: 'ohe-block', 'data-id': b.id, 'data-type': b.type });
      it.el._item = it;
      const gutter = h('div', { class: 'ohe-gutter', contenteditable: 'false' },
        h('button', { type: 'button', class: 'ohe-add', 'aria-label': 'Insert block below', title: 'Insert block', onclick: (e) => this.editor.openSlash(it, e.currentTarget, 'insert') }, '+'),
        h('button', { type: 'button', class: 'ohe-handle', draggable: 'true', 'aria-label': 'Drag to move, click for block menu', title: 'Drag to move · click for menu', onclick: (e) => blockMenu(this.editor, it, e.currentTarget), ondragstart: (e) => { this.editor.dragItem = it; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', b.id); it.el.classList.add('ohe-dragging'); }, ondragend: () => { it.el.classList.remove('ohe-dragging'); this.editor.hideDropLine(); } }, '⋮⋮'),
      );
      it.body = h('div', { class: 'ohe-body' });
      it.el.append(gutter, it.body);
      it.view = new VIEWS[b.type](this.editor, it);
      it.view.render();
      paintChannel(it);
      const ref = this.items[index];
      if (ref) this.el.insertBefore(it.el, ref.el); else this.el.append(it.el);
      this.items.splice(index, 0, it);
      if (this.editor.commentCounts?.[b.id]) setTimeout(() => this.editor.setCommentCounts(this.editor.commentCounts));
      return it;
    }
    remove(it, keepIfEmpty = false) {
      const i = this.items.indexOf(it);
      if (i < 0) return;
      it.view.destroy && it.view.destroy();
      it.el.remove();
      this.items.splice(i, 1);
      if (!this.items.length && !keepIfEmpty) this.insert(P(), 0);
    }
    toJSON() { return this.items.map((it) => it.view.toJSON()); }
  }

  // ═════════════════════════ Views ═════════════════════════
  class View {
    constructor(editor, item) { this.ed = editor; this.item = item; this.b = item.block; this.d = item.block.data; }
    get body() { return this.item.body; }
    sync() {}
    toJSON() { this.sync(); return { id: this.b.id, type: this.b.type, data: this.d }; }
    changed() { this.ed.changed(); }
  }

  /** rich text element factory */
  function richEl(tag, html, ph, cls = '') {
    return h(tag, { class: 'ohe-rich ' + cls, contenteditable: 'true', 'data-ph': ph, html: html || '', spellcheck: 'true' });
  }

  class ParagraphView extends View {
    render() {
      this.el = richEl('div', this.d.html, this.ed.opts.placeholder || "Write something, or type '/' for blocks…", 'ohe-p');
      if (this.d.align) this.el.style.textAlign = this.d.align;
      this.body.append(this.el);
    }
    sync() { this.d.html = cleanInline(this.el); }
    focus(end = true) { placeCaret(this.el, end); }
    mergeTarget() { return this.el; }
    onKey(e) { return this.ed.textKey(this, e, this.el); }
  }
  class HeadingView extends ParagraphView {
    render() {
      const lvl = Math.min(4, Math.max(1, +this.d.level || 2));
      this.el = richEl('h' + lvl, this.d.html, `Heading ${lvl}`, 'ohe-h');
      if (this.d.align) this.el.style.textAlign = this.d.align;
      this.body.append(this.el);
    }
    onKey(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const right = splitAtCaret(this.el);
        this.sync();
        this.item.list.insert(P(right), this.item.list.items.indexOf(this.item) + 1).view.focus(false);
        this.changed();
        return true;
      }
      return this.ed.textKey(this, e, this.el);
    }
  }

  class ListView extends View {
    render() {
      this.el = h(this.d.ordered ? 'ol' : 'ul', { class: 'ohe-rich ohe-list-el', contenteditable: 'true', spellcheck: 'true' });
      const build = (items, parent) => items.forEach((x) => {
        const li = h('li', { html: typeof x === 'string' ? x : x.html || '' });
        if (typeof x === 'object' && x.items?.length) { const sub = h(this.d.ordered ? 'ol' : 'ul'); build(x.items, sub); li.append(sub); }
        if (!li.innerHTML) li.innerHTML = '<br>';
        parent.append(li);
      });
      build(this.d.items?.length ? this.d.items : [''], this.el);
      this.body.append(this.el);
    }
    sync() {
      const read = (listEl) => [...listEl.children].filter((c) => c.tagName === 'LI').map((li) => {
        const copy = li.cloneNode(true);
        copy.querySelectorAll('ul,ol').forEach((x) => x.remove());
        const html = cleanInline(copy);
        const sub = li.querySelector(':scope > ul, :scope > ol');
        const kids = sub ? read(sub) : [];
        return kids.length ? { html, items: kids } : html;
      });
      this.d.items = read(this.el);
      if (!this.d.items.length) this.d.items = [''];
    }
    focus(end = true) { const lis = this.el.querySelectorAll('li'); placeCaret(end ? lis[lis.length - 1] : lis[0], end); }
    currentLi() { const r = caretRange(); const n = r && (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement); return n && n.closest('li'); }
    onKey(e) {
      const li = this.currentLi();
      if (!li) return false;
      if (e.key === 'Tab') {
        e.preventDefault();
        const off = rangeText(li, true)?.text.length || 0;
        if (e.shiftKey) {
          const parentLi = li.parentElement.closest('li');
          if (parentLi && this.el.contains(parentLi)) { parentLi.after(li); if (!parentLi.querySelector('ul li, ol li')) parentLi.querySelector('ul,ol')?.remove(); }
        } else {
          const prev = li.previousElementSibling;
          if (prev) { let sub = prev.querySelector(':scope > ul, :scope > ol'); if (!sub) { sub = document.createElement(this.d.ordered ? 'ol' : 'ul'); prev.append(sub); } sub.append(li); }
        }
        placeCaretAtOffset(li, off);
        this.sync(); this.changed();
        return true;
      }
      if (e.key === 'Enter' && !e.shiftKey && !li.textContent.trim() && !li.querySelector('ul,ol')) {
        e.preventDefault();
        const parentLi = li.parentElement.closest('li');
        if (parentLi && this.el.contains(parentLi)) { parentLi.after(li); placeCaret(li); this.sync(); this.changed(); return true; }
        // exit the list: move trailing items into a new list block
        const after = []; let n = li.nextElementSibling; while (n) { after.push(n.innerHTML); const x = n; n = n.nextElementSibling; x.remove(); }
        li.remove();
        this.sync();
        const idx = this.item.list.items.indexOf(this.item);
        const np = this.item.list.insert(P(), idx + 1);
        if (after.length) this.item.list.insert({ id: uid(), type: 'list', data: { ordered: this.d.ordered, items: after.map(cleanHTML) } }, idx + 2);
        if (!this.el.querySelector('li')) this.item.list.remove(this.item);
        np.view.focus(false);
        this.changed();
        return true;
      }
      if (e.key === 'Backspace' && atStart(li) && caretRange()?.collapsed && li === this.el.firstElementChild) {
        e.preventDefault();
        // turn first item into a paragraph
        const html = cleanInline((() => { const c = li.cloneNode(true); c.querySelectorAll('ul,ol').forEach((x) => x.remove()); return c; })());
        li.remove();
        this.sync();
        const idx = this.item.list.items.indexOf(this.item);
        const np = this.item.list.insert(P(html), idx);
        if (!this.el.querySelector('li')) this.item.list.remove(this.item);
        np.view.focus(false);
        this.changed();
        return true;
      }
      if (e.key === 'ArrowUp' && li === this.el.firstElementChild && atStart(li)) { const p = this.ed.neighbor(this.item, -1); if (p) { e.preventDefault(); p.view.focus(true); return true; } }
      if (e.key === 'ArrowDown' && li === this.el.lastElementChild && atEnd(li)) { const n = this.ed.neighbor(this.item, 1); if (n) { e.preventDefault(); n.view.focus(false); return true; } }
      return false;
    }
  }

  class ChecklistView extends View {
    render() {
      this.wrap = h('div', { class: 'ohe-checklist' });
      (this.d.items?.length ? this.d.items : [{ html: '', checked: false }]).forEach((x) => this.wrap.append(this.row(x)));
      this.body.append(this.wrap);
    }
    row(x) {
      const cb = h('input', { type: 'checkbox', 'aria-label': 'Done', onchange: () => { this.sync(); this.changed(); } });
      cb.checked = !!x.checked;
      const t = richEl('div', x.html, 'To-do', 'ohe-check-t');
      const r = h('div', { class: 'ohe-check-row' }, cb, t);
      t.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (!t.textContent.trim()) { r.remove(); this.sync(); const np = this.item.list.insert(P(), this.item.list.items.indexOf(this.item) + 1); if (!this.wrap.children.length) this.item.list.remove(this.item); np.view.focus(); this.changed(); return; }
          const right = splitAtCaret(t);
          const nr = this.row({ html: right, checked: false });
          r.after(nr);
          placeCaret(nr.querySelector('.ohe-check-t'), false);
          this.sync(); this.changed();
        } else if (e.key === 'Backspace' && atStart(t) && !t.textContent && this.wrap.children.length > 1) {
          e.preventDefault();
          const prev = r.previousElementSibling;
          r.remove();
          if (prev) placeCaret(prev.querySelector('.ohe-check-t'));
          this.sync(); this.changed();
        }
      });
      return r;
    }
    sync() { this.d.items = [...this.wrap.children].map((r) => ({ html: cleanInline(r.querySelector('.ohe-check-t')), checked: r.querySelector('input').checked })); }
    focus(end = true) { const ts = this.wrap.querySelectorAll('.ohe-check-t'); placeCaret(end ? ts[ts.length - 1] : ts[0], end); }
  }

  class QuoteView extends View {
    render() {
      const s = (this.d.style = Object.assign({ variant: 'line' }, this.d.style || {}));
      this.q = h('blockquote', { class: 'oh-quote oh-quote-' + s.variant });
      this.el = richEl('div', this.d.html, 'Quote', 'ohe-quote-t');
      this.cite = richEl('div', this.d.cite, '— Attribution (optional)', 'ohe-cite');
      this.q.append(this.el, this.cite);
      this.applyStyle();
      const bar = settingsBar([
        { k: 'variant', label: 'Style', type: 'select', options: [['line', 'Side line'], ['box', 'Box'], ['pull', 'Pull quote']] },
        { k: 'border_color', label: 'Border', type: 'color' }, { k: 'border_width', label: 'Width', type: 'number', min: 0, max: 12 },
        { k: 'bg', label: 'Background', type: 'color' }, { k: 'color', label: 'Text', type: 'color' }, { k: 'italic', label: 'Italic', type: 'checkbox', def: true },
      ], s, () => { this.q.className = 'oh-quote oh-quote-' + s.variant; this.applyStyle(); this.changed(); });
      this.body.append(this.q, bar);
    }
    applyStyle() {
      const s = this.d.style;
      this.q.style.cssText = `${s.border_color ? `--q-border:${s.border_color};` : ''}${s.border_width !== undefined && s.border_width !== '' ? `--q-bw:${s.border_width}px;` : ''}${s.bg ? `--q-bg:${s.bg};` : ''}${s.color ? `--q-color:${s.color};` : ''}${s.italic === false ? 'font-style:normal' : ''}`;
    }
    sync() { this.d.html = cleanInline(this.el); this.d.cite = cleanInline(this.cite); }
    focus(end = true) { placeCaret(this.el, end); }
    mergeTarget() { return this.el; }
    onKey(e) {
      if (e.target === this.cite && e.key === 'Enter') { e.preventDefault(); const np = this.item.list.insert(P(), this.item.list.items.indexOf(this.item) + 1); np.view.focus(); return true; }
      if (e.target === this.el && e.key === 'Enter' && !e.shiftKey && !this.el.textContent.trim()) { e.preventDefault(); this.ed.convert(this.item, 'paragraph'); return true; }
      if (e.target === this.el) return this.ed.textKey(this, e, this.el) && false;
      return false;
    }
  }

  class CodeView extends View {
    render() {
      this.ta = h('textarea', { class: 'ohe-code-ta', spellcheck: 'false', placeholder: 'Paste or type code…', 'aria-label': 'Code', 'data-find': 'code' });
      this.ta.value = this.d.code || '';
      this.lang = h('input', { class: 'ohe-mini', placeholder: 'language', value: this.d.lang || '', 'aria-label': 'Language', list: 'ohe-langs' });
      this.ta.addEventListener('input', () => { this.grow(); this.sync(); this.changed(); });
      this.lang.addEventListener('input', () => { this.sync(); this.changed(); });
      this.ta.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.item.list.insert(P(), this.item.list.items.indexOf(this.item) + 1).view.focus(); }
        if (e.key === 'Backspace' && !this.ta.value) { e.preventDefault(); this.ed.convert(this.item, 'paragraph'); }
      });
      this.body.append(h('div', { class: 'ohe-code' }, h('div', { class: 'ohe-code-bar' }, this.lang, h('span', { class: 'ohe-hint' }, '⌘↵ to exit')), this.ta));
      setTimeout(() => this.grow());
    }
    grow() { this.ta.style.height = 'auto'; this.ta.style.height = Math.max(60, this.ta.scrollHeight + 2) + 'px'; }
    sync() { this.d.code = this.ta.value; this.d.lang = this.lang.value.trim(); }
    focus() { this.ta.focus(); }
  }

  /** Generic "card" block: live server-rendered preview + a settings bar. */
  class CardView extends View {
    fields() { return []; }
    // the editor always previews the block itself, whatever channel it is limited to
    previewDoc() { const { show_in, ...data } = this.d; return { blocks: [{ id: this.b.id, type: this.b.type, data }] }; }
    render() {
      this.preview = h('div', { class: 'ohe-preview', contenteditable: 'false' });
      this.body.append(this.preview);
      const f = this.fields();
      if (f.length) this.body.append(settingsBar(f, this.d, () => { this.refresh(); this.changed(); }, this.ed));
      this.extra && this.extra();
      this.refresh = debounce(() => this.doRefresh(), 350);
      this.doRefresh();
    }
    placeholder() { return `<div class="ohe-ph">${esc(TYPES[this.b.type]?.label || this.b.type)}</div>`; }
    async doRefresh() {
      const ph = this.emptyState && this.emptyState();
      if (ph) { this.preview.innerHTML = ph; return; }
      try {
        const r = await postJSON(this.ed.opts.renderUrl, { doc: this.previewDoc(), mode: 'fragment', post_id: this.ed.opts.postId });
        this.preview.innerHTML = r.html && r.html.trim() ? r.html : this.placeholder();
        this.preview.querySelectorAll('a').forEach((a) => a.addEventListener('click', (e) => e.preventDefault()));
        this.preview.querySelectorAll('form').forEach((f) => f.addEventListener('submit', (e) => e.preventDefault()));
      } catch { this.preview.innerHTML = this.placeholder(); }
    }
  }

  class ButtonView extends CardView {
    fields() { return [{ k: 'label', label: 'Label', type: 'text' }, { k: 'url', label: 'Link', type: 'url' }, { k: 'align', label: 'Align', type: 'select', options: [['left', 'Left'], ['center', 'Center'], ['right', 'Right']] }, { k: 'bg', label: 'Color', type: 'color' }, { k: 'color', label: 'Text', type: 'color' }]; }
    emptyState() { return null; }
  }
  class DividerView extends CardView {
    fields() { return [{ k: 'style', label: 'Style', type: 'select', options: [['line', 'Line'], ['dots', 'Dots'], ['stars', 'Stars'], ['space', 'Blank space']] }, { k: 'color', label: 'Color', type: 'color' }]; }
  }
  class SpacerView extends CardView {
    fields() { return [{ k: 'height', label: 'Height (px)', type: 'number', min: 4, max: 200 }]; }
    emptyState() { return `<div class="ohe-spacer" style="height:${+this.d.height || 24}px"></div>`; }
  }
  class TocView extends CardView {
    emptyState() {
      const hs = [];
      const walk = (bs) => bs.forEach((b) => { if (b.type === 'heading' && b.data.level <= 3) hs.push(b); (b.data.blocks || []).forEach((x) => walk([x])); (Array.isArray(b.data.columns) ? b.data.columns : []).forEach((c) => walk(c.blocks || [])); });
      walk(this.ed.root ? this.ed.root.items.map((i) => i.block) : []);
      return `<nav class="oh-toc"><strong>Contents</strong>${hs.length ? `<ol>${hs.map((x) => `<li class="l${x.data.level}">${esc(textOf(x.data.html))}</li>`).join('')}</ol>` : '<p class="ohe-hint">Headings you add will be listed here with anchor links.</p>'}</nav>`;
    }
    afterMount() { this.ed.on('change', () => this.doRefresh()); }
  }
  class PaywallView extends CardView {
    emptyState() { return '<div class="ohe-paywall">🔒 <strong>Paywall break</strong> — everything below is for premium subscribers. Free readers see an upgrade prompt.</div>'; }
  }
  class SubscribeView extends CardView {
    fields() { return [{ k: 'label', label: 'Button label', type: 'text' }]; }
    emptyState() { return `<div class="oh-subscribe-inline"><input type="email" placeholder="you@example.com" disabled><button class="oh-btn">${esc(this.d.label || 'Subscribe')}</button></div><p class="ohe-hint">Shown on the web only — hidden in emails.</p>`; }
  }
  class AdAutoView extends CardView {
    fields() { return [{ k: 'label', label: 'Label', type: 'text', ph: 'Sponsored' }]; }
    emptyState() { return `<div class="ohe-ph">¤ <strong>Programmatic ad</strong> — filled automatically at send time with the best-paying approved campaign (Monetize → Ad network → Programmatic).</div>`; }
  }
  class ReferralView extends CardView { fields() { return [{ k: 'title', label: 'Title', type: 'text', ph: 'Share this newsletter, earn rewards' }]; } }
  class RecsView extends CardView {
    fields() { return [{ k: 'title', label: 'Title', type: 'text', ph: 'Newsletters we recommend' }, { k: 'limit', label: 'Show', type: 'number', min: 1, max: 6 }]; }
    placeholder() { return '<div class="ohe-ph">★ Recommendations — add some in Grow → Recommendations</div>'; }
  }
  class EmbedView extends CardView {
    fields() { return [{ k: 'url', label: 'URL', type: 'url', ph: 'Paste a YouTube, X, TikTok, Instagram, Bluesky, Stocktwits, Spotify… link', wide: true }, { k: 'caption', label: 'Caption', type: 'text' }]; }
    emptyState() { return this.d.url ? null : '<div class="ohe-ph">▶ Paste a link from YouTube, X, TikTok, Instagram, Bluesky, Stocktwits, Spotify, Vimeo, Apple Podcasts or Loom. <br><small>Emails show a clickable preview card; the web shows the live embed.</small></div>'; }
    autoOpen() { setTimeout(() => this.body.querySelector('input')?.focus(), 30); }
  }
  class HtmlView extends View {
    render() {
      this.ta = h('textarea', { class: 'ohe-code-ta', spellcheck: 'false', placeholder: '<div>Custom HTML…</div>  (scripts and unsafe attributes are removed)', 'aria-label': 'HTML' });
      this.ta.value = this.d.html || '';
      this.preview = h('div', { class: 'ohe-preview', contenteditable: 'false' });
      const toggle = h('button', { type: 'button', class: 'ohe-mini-btn', onclick: () => { this.showPreview = !this.showPreview; this.mode(); } }, 'Preview');
      this.toggle = toggle;
      this.ta.addEventListener('input', () => { this.sync(); this.changed(); this.ta.style.height = 'auto'; this.ta.style.height = Math.max(80, this.ta.scrollHeight) + 'px'; });
      this.body.append(h('div', { class: 'ohe-code' }, h('div', { class: 'ohe-code-bar' }, h('span', { class: 'ohe-hint' }, 'Custom HTML · sanitized'), toggle), this.ta), this.preview);
      this.showPreview = !!this.d.html;
      this.mode();
    }
    async mode() {
      this.ta.parentElement.classList.toggle('hide', this.showPreview);
      this.preview.classList.toggle('hide', !this.showPreview);
      this.toggle.textContent = this.showPreview ? 'Edit HTML' : 'Preview';
      if (this.showPreview) {
        this.ta.parentElement.classList.remove('hide');
        this.ta.style.display = 'none';
        try { const r = await postJSON(this.ed.opts.renderUrl, { doc: { blocks: [{ id: this.b.id, type: 'html', data: { html: this.ta.value } }] }, mode: 'fragment' }); this.preview.innerHTML = r.html || '<div class="ohe-ph">Empty HTML block</div>'; } catch {}
      } else this.ta.style.display = '';
    }
    sync() { this.d.html = this.ta.value; }
    focus() { this.showPreview = false; this.mode(); this.ta.focus(); }
  }

  class PickerView extends CardView {
    kind() { return ''; }
    key() { return ''; }
    extra() {
      const row = h('div', { class: 'ohe-settings' });
      this.select = h('select', { class: 'ohe-mini', 'aria-label': 'Choose' }, h('option', { value: '' }, 'Loading…'));
      this.select.addEventListener('change', () => { this.d[this.key()] = this.select.value; this.onPick && this.onPick(this.select.value); this.doRefresh(); this.changed(); });
      row.append(h('label', {}, h('span', {}, TYPES[this.b.type].label), this.select));
      this.extraControls && this.extraControls(row);
      this.body.append(row);
      this.loadOptions();
    }
    async loadOptions() {
      try {
        const r = await getJSON(`${this.ed.opts.pickerUrl}/${this.kind()}?post=${encodeURIComponent(this.ed.opts.postId || '')}`);
        this.select.innerHTML = `<option value="">— Choose —</option>` + r.items.map((x) => `<option value="${esc(x.id)}" ${x.id === this.d[this.key()] ? 'selected' : ''}>${esc(x.label)}${x.sub ? ' · ' + esc(x.sub) : ''}</option>`).join('');
        if (!r.items.length) this.select.innerHTML = `<option value="">Nothing to choose yet</option>`;
      } catch { this.select.innerHTML = '<option value="">Could not load</option>'; }
    }
    emptyState() { return this.d[this.key()] ? null : `<div class="ohe-ph">${esc(TYPES[this.b.type].icon)} Choose ${esc(TYPES[this.b.type].label.toLowerCase())} below</div>`; }
  }
  class PodcastView extends PickerView { kind() { return 'episodes'; } key() { return 'episode_id'; } }
  class ProductView extends PickerView { kind() { return 'products'; } key() { return 'product_id'; } }
  class EventView extends PickerView { kind() { return 'events'; } key() { return 'event_id'; } }
  class PollView extends PickerView {
    kind() { return 'polls'; } key() { return 'poll_id'; }
    extraControls(row) {
      row.append(h('button', { type: 'button', class: 'ohe-mini-btn', onclick: () => this.createPoll() }, '+ New poll'));
    }
    autoOpen() { if (!this.d.poll_id) setTimeout(() => this.createPoll(), 50); }
    async createPoll() {
      const res = await formBox('New poll', [
        { k: 'question', label: 'Question', ph: 'What should I write about next?' }, { k: 'o1', label: 'Option 1' }, { k: 'o2', label: 'Option 2' }, { k: 'o3', label: 'Option 3 (optional)' }, { k: 'o4', label: 'Option 4 (optional)' },
        { k: 'kind', label: 'Type', type: 'select', options: [['standard', 'Standard poll'], ['trivia', 'Trivia — has a correct answer']] },
        { k: 'correct', label: 'Correct answer (trivia)', type: 'select', options: [['1', 'Option 1'], ['2', 'Option 2'], ['3', 'Option 3'], ['4', 'Option 4']] },
        { k: 'explanation', label: 'Explanation shown after answering (trivia, optional)' },
      ]);
      if (!res) return;
      try {
        const raw = [res.o1, res.o2, res.o3, res.o4];
        const options = raw.filter(Boolean);
        // map the chosen option number onto the filtered list
        const correct = res.kind === 'trivia' ? options.indexOf(raw[Number(res.correct) - 1]) + 1 : 0;
        if (res.kind === 'trivia' && correct < 1) { OHToast('The correct answer must be one of the options you filled in', 4000); return; }
        const r = await postJSON(this.ed.opts.pollsUrl, { question: res.question, options, kind: res.kind, correct, explanation: res.explanation });
        this.d.poll_id = r.id;
        await this.loadOptions();
        this.doRefresh(); this.changed();
      } catch (e) { OHToast(e.message, 4000); }
    }
  }
  class AdView extends PickerView {
    kind() { return 'ads'; } key() { return 'opportunity_id'; }
    fields() { return [{ k: 'label', label: 'Label', type: 'text' }, { k: 'headline', label: 'Headline', type: 'text', wide: true }, { k: 'body', label: 'Body', type: 'text', wide: true }, { k: 'url', label: 'Link', type: 'url' }, { k: 'image', label: 'Image URL', type: 'image' }, { k: 'cta', label: 'Button', type: 'text' }]; }
    onPick(v) { if (v && this.ed.opts.postId) postJSON(`/app/posts/${this.ed.opts.postId}/place-ad`, { opportunity_id: v }).catch(() => {}); }
    emptyState() { return this.d.opportunity_id || this.d.headline ? null : '<div class="ohe-ph">$ Sponsor slot — pick an ad from the network or fill in a direct sponsor below</div>'; }
  }

  class ImageView extends View {
    render() {
      this.wrap = h('div', { class: 'ohe-image' });
      this.body.append(this.wrap);
      this.draw();
    }
    draw() {
      const d = this.d;
      this.wrap.innerHTML = '';
      if (!d.src) {
        const zone = h('div', { class: 'ohe-dropzone', contenteditable: 'false' },
          h('div', { class: 'ohe-dz-t' }, '🖼  Drag & drop an image, or'),
          h('div', { class: 'ohe-dz-actions' },
            h('button', { type: 'button', class: 'ohe-mini-btn', onclick: () => this.pick() }, 'Upload'),
            h('button', { type: 'button', class: 'ohe-mini-btn', onclick: () => this.library() }, 'Media library'),
            h('button', { type: 'button', class: 'ohe-mini-btn', onclick: () => this.fromUrl() }, 'From URL'),
            h('button', { type: 'button', class: 'ohe-mini-btn', onclick: () => this.gif() }, 'GIF'),
            this.ed.features.ai ? h('button', { type: 'button', class: 'ohe-mini-btn', onclick: () => this.ai() }, '✨ AI') : null,
          ),
          this.progress = h('div', { class: 'ohe-progress' }),
        );
        zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('over'));
        zone.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) this.uploadFile(f); });
        this.wrap.append(zone);
        return;
      }
      const img = h('img', { src: d.src, alt: d.alt || '', title: d.title || '', style: { width: (d.width || 100) + '%' } });
      const fig = h('figure', { class: 'oh-figure oh-align-' + (d.align || 'center'), contenteditable: 'false' }, img);
      this.caption = richEl('figcaption', d.caption, 'Add a caption (optional)', 'ohe-caption');
      const warn = h('div', { class: 'ohe-alt-warn' + (d.alt ? ' hide' : '') }, '⚠ Add alt text so screen readers can describe this image');
      const bar = settingsBar([
        { k: 'alt', label: 'Alt text', type: 'text', wide: true, ph: 'Describe the image for accessibility' },
        { k: 'title', label: 'Title', type: 'text' }, { k: 'link', label: 'Link', type: 'url' },
        { k: 'width', label: 'Width %', type: 'range', min: 20, max: 100 },
        { k: 'align', label: 'Align', type: 'select', options: [['center', 'Center'], ['left', 'Left'], ['right', 'Right']] },
        { k: 'radius', label: 'Corners', type: 'number', min: 0, max: 40 },
      ], d, () => { img.style.width = (d.width || 100) + '%'; img.alt = d.alt || ''; img.title = d.title || ''; fig.className = 'oh-figure oh-align-' + (d.align || 'center'); img.style.borderRadius = d.radius !== undefined && d.radius !== '' ? d.radius + 'px' : ''; warn.classList.toggle('hide', !!d.alt); this.changed(); }, this.ed,
        [h('button', { type: 'button', class: 'ohe-mini-btn', onclick: () => { d.src = ''; this.draw(); this.changed(); } }, 'Replace')]);
      this.wrap.append(fig, this.caption, warn, bar);
    }
    sync() { if (this.caption && this.caption.isConnected) this.d.caption = cleanInline(this.caption); }
    pick() { pickFile('image/*', (f) => this.uploadFile(f)); }
    async uploadFile(f) {
      if (!/^image\//.test(f.type)) { OHToast('That file is not an image'); return; }
      this.progress && (this.progress.textContent = 'Uploading…');
      try {
        const r = await upload(this.ed, f);
        this.d.src = r.url;
        if (!this.d.alt) this.d.alt = '';
        this.draw(); this.changed();
      } catch (e) { OHToast(e.message, 4000); if (this.progress) this.progress.textContent = ''; }
    }
    async gif() { const g = await gifPicker(this.ed); if (g) { this.d.src = g.url; this.d.alt = this.d.alt || g.alt || 'GIF'; this.draw(); this.changed(); } }
    async library() { const m = await mediaPicker(this.ed, 'image'); if (m) { this.d.src = m.url; this.d.alt = this.d.alt || m.alt || ''; this.draw(); this.changed(); } }
    async fromUrl() {
      const url = await promptBox('Image from URL', 'https://…', '');
      if (!url) return;
      try { const r = await postJSON('/app/posts/media/import', { url }); this.d.src = r.url; } catch { this.d.src = url; }
      this.draw(); this.changed();
    }
    async ai() {
      const prompt = await promptBox('Generate image', 'Describe the image', '', { multiline: true });
      if (!prompt) return;
      OHToast('Generating…', 6000);
      try { const r = await postJSON(this.ed.opts.aiUrl, { action: 'image', prompt }); this.d.src = r.url; this.d.alt = prompt.slice(0, 120); this.draw(); this.changed(); } catch (e) { OHToast(e.message, 5000); }
    }
    autoOpen() { if (!this.d.src) this.wrap.querySelector('.ohe-mini-btn')?.focus(); }
  }

  class GalleryView extends View {
    render() { this.wrap = h('div', { class: 'ohe-gallery' }); this.body.append(this.wrap); this.draw(); }
    draw() {
      const d = this.d;
      this.wrap.innerHTML = '';
      const grid = h('div', { class: 'ohe-gal-grid', style: { gridTemplateColumns: `repeat(${d.columns || 2}, 1fr)` }, contenteditable: 'false' });
      this.caps = [];
      (d.images || []).forEach((im, i) => {
        // caption: inline rich text (bold / italic / links via the floating toolbar), like image captions
        const cap = richEl('div', im.caption || '', 'Caption (optional)', 'ohe-caption ohe-gal-cap');
        cap.dataset.idx = i;
        this.caps.push(cap);
        grid.append(h('div', { class: 'ohe-gal-item' }, h('img', { src: im.src, alt: im.alt || '' }),
          h('input', { class: 'ohe-mini', placeholder: 'Alt text', value: im.alt || '', 'data-find': 'alt', oninput: (e) => { im.alt = e.target.value; this.changed(); } }),
          cap,
          h('button', { type: 'button', class: 'ohe-x', 'aria-label': 'Remove image', onclick: () => { this.sync(); d.images.splice(i, 1); this.draw(); this.changed(); } }, '✕')));
      });
      grid.append(h('div', { class: 'ohe-gal-add' }, h('button', { type: 'button', class: 'ohe-mini-btn', onclick: () => pickFile('image/*', (f) => this.add(f), true) }, '+ Upload'), h('button', { type: 'button', class: 'ohe-mini-btn', onclick: async () => { const m = await mediaPicker(this.ed, 'image'); if (m) { d.images.push({ src: m.url, alt: m.alt || '' }); this.draw(); this.changed(); } } }, 'Library')));
      this.wrap.append(grid, settingsBar([{ k: 'layout', label: 'Layout', type: 'select', options: [['grid', 'Grid'], ['carousel', 'Carousel (web)']] }, { k: 'columns', label: 'Columns', type: 'select', options: [['2', '2'], ['3', '3'], ['4', '4']] }], d, () => { d.columns = +d.columns; this.draw(); this.changed(); }));
    }
    sync() { (this.caps || []).forEach((cap) => { const im = this.d.images?.[+cap.dataset.idx]; if (im && cap.isConnected) { const v = cleanInline(cap); if (v) im.caption = v; else delete im.caption; } }); }
    onKey(e) {
      // captions are single-line inline text
      if (e.target.closest && e.target.closest('.ohe-gal-cap') && e.key === 'Enter') { e.preventDefault(); return true; }
      return false;
    }
    async add(f) { try { const r = await upload(this.ed, f); this.sync(); this.d.images.push({ src: r.url, alt: '' }); this.draw(); this.changed(); } catch (e) { OHToast(e.message); } }
    async uploadFile(f) { return this.add(f); }
  }

  class FileView extends View {
    // video | audio | attachment
    render() { this.wrap = h('div', { class: 'ohe-file' }); this.body.append(this.wrap); this.draw(); }
    srcKey() { return this.b.type === 'attachment' ? 'url' : 'src'; }
    accept() { return this.b.type === 'video' ? 'video/*' : this.b.type === 'audio' ? 'audio/*' : '*/*'; }
    draw() {
      const d = this.d, k = this.srcKey();
      this.wrap.innerHTML = '';
      if (!d[k]) {
        const zone = h('div', { class: 'ohe-dropzone', contenteditable: 'false' }, h('div', { class: 'ohe-dz-t' }, `${TYPES[this.b.type].icon}  Drop a ${this.b.type === 'attachment' ? 'file' : this.b.type + ' file'} here, or`),
          h('div', { class: 'ohe-dz-actions' }, h('button', { type: 'button', class: 'ohe-mini-btn', onclick: () => pickFile(this.accept(), (f) => this.uploadFile(f)) }, 'Upload'), h('button', { type: 'button', class: 'ohe-mini-btn', onclick: async () => { const m = await mediaPicker(this.ed, this.b.type === 'attachment' ? 'file' : this.b.type); if (m) { d[k] = m.url; if (this.b.type === 'attachment') { d.name = m.name; d.size = m.size; } this.draw(); this.changed(); } } }, 'Library'), h('button', { type: 'button', class: 'ohe-mini-btn', onclick: async () => { const u = await promptBox('File URL', 'https://…', ''); if (u) { d[k] = u; if (this.b.type === 'attachment' && !d.name) d.name = u.split('/').pop(); this.draw(); this.changed(); } } }, 'URL')),
          this.progress = h('div', { class: 'ohe-progress' }));
        zone.addEventListener('dragover', (e) => e.preventDefault());
        zone.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer.files[0]; if (f) this.uploadFile(f); });
        this.wrap.append(zone);
        return;
      }
      let prev;
      if (this.b.type === 'video') prev = h('video', { src: d.src, poster: d.poster || null, controls: true, preload: 'metadata', style: { width: '100%', borderRadius: '8px' } });
      if (this.b.type === 'audio') prev = h('figure', { class: 'oh-audio' }, h('figcaption', { text: d.title || '' }), h('audio', { src: d.src, controls: true, preload: 'none', style: { width: '100%' } }));
      if (this.b.type === 'attachment') prev = h('div', { class: 'oh-attachment' }, '📎 ', h('strong', { text: d.name || 'File' }), h('span', { text: d.size ? ` · ${(d.size / 1048576).toFixed(1)} MB` : '' }));
      const fields = this.b.type === 'video' ? [{ k: 'poster', label: 'Poster image', type: 'image' }, { k: 'caption', label: 'Caption', type: 'text', wide: true }] : this.b.type === 'audio' ? [{ k: 'title', label: 'Title', type: 'text', wide: true }] : [{ k: 'name', label: 'File name', type: 'text', wide: true }];
      const note = this.b.type !== 'attachment' ? h('p', { class: 'ohe-hint' }, 'Inboxes can’t play media: the email version shows a link to the web version instead.') : null;
      this.wrap.append(h('div', { contenteditable: 'false' }, prev), note, settingsBar(fields, d, () => { this.changed(); if (this.b.type === 'audio') prev.querySelector('figcaption').textContent = d.title || ''; }, this.ed, [h('button', { type: 'button', class: 'ohe-mini-btn', onclick: () => { d[k] = ''; this.draw(); this.changed(); } }, 'Replace')]));
    }
    async uploadFile(f) {
      this.progress && (this.progress.textContent = `Uploading ${f.name}…`);
      try {
        const r = await upload(this.ed, f);
        this.d[this.srcKey()] = r.url;
        if (this.b.type === 'attachment') { this.d.name = r.name || f.name; this.d.size = r.size || f.size; }
        if (this.b.type === 'audio' && !this.d.title) this.d.title = f.name.replace(/\.[a-z0-9]+$/i, '');
        this.draw(); this.changed();
      } catch (e) { OHToast(e.message, 4000); this.progress && (this.progress.textContent = ''); }
    }
  }

  class TableView extends View {
    render() { this.wrap = h('div', { class: 'ohe-table-wrap' }); this.body.append(this.wrap); this.draw(); }
    draw() {
      const d = this.d;
      if (!d.rows?.length) d.rows = [['', ''], ['', '']];
      this.table = h('table', { class: 'oh-table' + (d.header ? ' ohe-thead' : '') });
      d.rows.forEach((r, ri) => {
        const tr = h('tr');
        r.forEach((cell, ci) => {
          const td = richEl(d.header && ri === 0 ? 'th' : 'td', cell, '', 'ohe-cell');
          td.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
              e.preventDefault();
              const cells = [...this.table.querySelectorAll('.ohe-cell')];
              const i = cells.indexOf(td) + (e.shiftKey ? -1 : 1);
              if (i >= cells.length) { this.sync(); d.rows.push(d.rows[0].map(() => '')); this.draw(); this.changed(); const c2 = this.table.querySelectorAll('.ohe-cell'); placeCaret(c2[c2.length - d.rows[0].length]); return; }
              if (cells[i]) placeCaret(cells[i]);
            }
            if (e.key === 'Enter' && !e.shiftKey) e.preventDefault();
          });
          tr.append(td);
        });
        this.table.append(tr);
      });
      const btn = (label, fn) => h('button', { type: 'button', class: 'ohe-mini-btn', onclick: () => { this.sync(); fn(); this.draw(); this.changed(); } }, label);
      this.wrap.innerHTML = '';
      this.wrap.append(this.table, h('div', { class: 'ohe-settings', contenteditable: 'false' },
        btn('+ Row', () => d.rows.push(d.rows[0].map(() => ''))), btn('− Row', () => d.rows.length > 1 && d.rows.pop()),
        btn('+ Column', () => d.rows.forEach((r) => r.push(''))), btn('− Column', () => d.rows[0].length > 1 && d.rows.forEach((r) => r.pop())),
        h('label', {}, h('input', { type: 'checkbox', checked: d.header ? true : null, onchange: (e) => { this.sync(); d.header = e.target.checked; this.draw(); this.changed(); } }), ' Header row')));
    }
    sync() { this.d.rows = [...this.table.querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => cleanInline(td))); }
    focus() { placeCaret(this.table.querySelector('.ohe-cell'), false); }
  }

  /** Container views own nested BlockLists (columns, section, dynamic). */
  class ColumnsView extends View {
    render() {
      const d = this.d;
      if (!d.columns?.length) d.columns = [{ blocks: [P()] }, { blocks: [P()] }];
      this.grid = h('div', { class: 'ohe-cols' });
      this.body.append(this.grid);
      this.build();
      const bar = settingsBar([
        { k: '_count', label: 'Columns', type: 'select', options: [['2', '2'], ['3', '3']] },
        { k: '_widths', label: 'Widths', type: 'select', options: [['equal', 'Equal'], ['2-1', 'Wide / narrow'], ['1-2', 'Narrow / wide']] },
        { k: 'valign', label: 'Vertical align', type: 'select', options: [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']] },
      ], Object.assign(d, { _count: String(d.columns.length), _widths: d.columns[0]?.width === 2 ? '2-1' : d.columns[1]?.width === 2 ? '1-2' : 'equal' }), () => this.reconfig());
      this.body.append(bar);
    }
    build() {
      this.sync();
      this.grid.innerHTML = '';
      this.grid.style.alignItems = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[this.d.valign || 'top'];
      this.lists = this.d.columns.map((col) => {
        const cel = h('div', { class: 'ohe-col', style: { flex: `${col.width || 1} 1 0` } });
        this.grid.append(cel);
        return new BlockList(this.ed, cel, col.blocks || [P()], this.item);
      });
    }
    reconfig() {
      const d = this.d;
      this.sync();
      const n = +d._count;
      while (d.columns.length < n) d.columns.push({ blocks: [P()] });
      while (d.columns.length > n) { const extra = d.columns.pop(); d.columns[d.columns.length - 1].blocks.push(...(extra.blocks || []).filter((b) => b.type !== 'paragraph' || textOf(b.data.html).trim())); }
      d.columns.forEach((c, i) => { delete c.width; if (n === 2 && d._widths === '2-1' && i === 0) c.width = 2; if (n === 2 && d._widths === '1-2' && i === 1) c.width = 2; });
      this.lists = null;
      this.build();
      this.changed();
    }
    sync() { if (this.lists) this.lists.forEach((l, i) => { this.d.columns[i].blocks = l.toJSON(); }); }
    toJSON() { this.sync(); const { _count, _widths, ...data } = this.d; return { id: this.b.id, type: 'columns', data: clone(data) }; }
    focus(end) { const l = this.lists[end ? this.lists.length - 1 : 0]; const it = l.items[end ? l.items.length - 1 : 0]; it?.view.focus?.(end); }
  }

  class SectionView extends View {
    render() {
      const s = (this.d.style = Object.assign({ padding: 20, radius: 10 }, this.d.style || {}));
      this.box = h('section', { class: 'oh-section ohe-section' });
      this.body.append(this.box);
      this.lists = [new BlockList(this.ed, this.box, this.d.blocks?.length ? this.d.blocks : [P()], this.item)];
      this.apply();
      this.body.append(settingsBar([
        { k: 'bg', label: 'Background', type: 'color' }, { k: 'bg_image', label: 'Background image', type: 'image' }, { k: 'color', label: 'Text', type: 'color' },
        { k: 'padding', label: 'Padding', type: 'number', min: 0, max: 80 }, { k: 'radius', label: 'Corners', type: 'number', min: 0, max: 40 }, { k: 'margin', label: 'Space below', type: 'number', min: 0, max: 80 },
        { k: 'border_width', label: 'Border', type: 'number', min: 0, max: 12 }, { k: 'border_style', label: 'Border style', type: 'select', options: [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']] }, { k: 'border_color', label: 'Border color', type: 'color' },
      ], s, () => { this.apply(); this.changed(); }, this.ed));
    }
    apply() {
      const s = this.d.style;
      Object.assign(this.box.style, { background: s.bg || 'transparent', backgroundImage: s.bg_image ? `url(${s.bg_image})` : '', backgroundSize: 'cover', color: s.color || '', padding: (s.padding ?? 20) + 'px', borderRadius: (s.radius ?? 10) + 'px', border: s.border_width ? `${s.border_width}px ${s.border_style || 'solid'} ${s.border_color || '#e5e7eb'}` : '1px dashed rgba(0,0,0,.12)', marginBottom: (s.margin ?? 16) + 'px' });
    }
    sync() { if (this.lists) this.d.blocks = this.lists[0].toJSON(); }
    focus(end) { const l = this.lists[0]; l.items[end ? l.items.length - 1 : 0]?.view.focus?.(end); }
  }

  class DynamicView extends View {
    render() {
      const d = this.d;
      d.rule = Object.assign({ tiers: [], segment_ids: [], tags: [], cohorts: [], match: 'any' }, d.rule || {});
      this.label = h('div', { class: 'ohe-dyn-label', contenteditable: 'false' });
      this.box = h('div', { class: 'ohe-dyn-body' });
      this.body.append(h('div', { class: 'ohe-dyn' }, this.label, this.box));
      this.lists = [new BlockList(this.ed, this.box, d.blocks?.length ? d.blocks : [P()], this.item)];
      this.body.append(this.ruleEditor());
      this.updateLabel();
    }
    ruleEditor() {
      const d = this.d, r = d.rule;
      const cat = this.ed.opts.catalog || { options: {} };
      const wrap = h('div', { class: 'ohe-settings ohe-dyn-rules', contenteditable: 'false' });
      const upd = () => { this.updateLabel(); this.changed(); };
      const mode = h('select', { class: 'ohe-mini', 'aria-label': 'Show or hide', onchange: (e) => { d.mode = e.target.value; upd(); } }, h('option', { value: 'show' }, 'Show only to'), h('option', { value: 'hide' }, 'Hide from'));
      mode.value = d.mode || 'show';
      const tierBox = h('span', { class: 'ohe-chips' }, ...[['free', 'Free'], ['premium', 'Premium'], ['visitor', 'Web visitors']].map(([v, l]) => h('label', {}, h('input', { type: 'checkbox', checked: r.tiers.includes(v) ? true : null, onchange: (e) => { r.tiers = e.target.checked ? [...new Set([...r.tiers, v])] : r.tiers.filter((x) => x !== v); upd(); } }), ' ' + l)));
      const segs = (cat.options.segment || []);
      const segSel = h('select', { class: 'ohe-mini', multiple: true, size: Math.min(4, Math.max(2, segs.length)), 'aria-label': 'Segments', onchange: (e) => { r.segment_ids = [...e.target.selectedOptions].map((o) => o.value); upd(); } }, ...segs.map(([id, name]) => h('option', { value: id, selected: r.segment_ids.includes(id) ? true : null }, name)));
      const tags = h('input', { class: 'ohe-mini', placeholder: 'tags, comma separated', value: (r.tags || []).join(', '), list: 'ohe-tag-list', oninput: (e) => { r.tags = e.target.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean); upd(); } });
      const cohorts = h('input', { class: 'ohe-mini', placeholder: 'cohorts e.g. A, B', value: (r.cohorts || []).join(', '), oninput: (e) => { r.cohorts = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); upd(); } });
      const match = h('select', { class: 'ohe-mini', 'aria-label': 'Match', onchange: (e) => { r.match = e.target.value; upd(); } }, h('option', { value: 'any' }, 'match any'), h('option', { value: 'all' }, 'match all'));
      match.value = r.match || 'any';
      const dl = h('datalist', { id: 'ohe-tag-list' }, ...(cat.options.tag || []).map((t) => h('option', { value: t })));
      wrap.append(h('label', {}, mode), h('label', {}, h('span', {}, 'Tiers'), tierBox), segs.length ? h('label', {}, h('span', {}, 'Segments'), segSel) : null, h('label', {}, h('span', {}, 'Tags'), tags), h('label', {}, h('span', {}, 'Cohorts'), cohorts), h('label', {}, match), dl);
      return wrap;
    }
    updateLabel() {
      const r = this.d.rule, bits = [];
      if (r.tiers?.length) bits.push(r.tiers.join(' / '));
      if (r.segment_ids?.length) bits.push(`${r.segment_ids.length} segment${r.segment_ids.length > 1 ? 's' : ''}`);
      if (r.tags?.length) bits.push('tags: ' + r.tags.join(', '));
      if (r.cohorts?.length) bits.push('cohort ' + r.cohorts.join(', '));
      this.label.textContent = `◐ ${this.d.mode === 'hide' ? 'Hidden from' : 'Only shown to'} ${bits.join(' · ') || 'everyone'}`;
    }
    sync() { if (this.lists) this.d.blocks = this.lists[0].toJSON(); }
    focus(end) { const l = this.lists[0]; l.items[end ? l.items.length - 1 : 0]?.view.focus?.(end); }
  }

  // ───────── synced snippet / recommended products / coded email ─────────
  const snippetsUrl = (ed) => ed.opts.snippetsUrl || '/app/posts/snippets';
  class SnippetView extends CardView {
    render() {
      super.render();
      const d = this.d;
      const bar = h('div', { class: 'ohe-snip-bar', contenteditable: 'false' },
        h('span', { class: 'ohe-snip-tag' }, '⧉ Synced snippet'), h('strong', { text: d.name || 'Snippet' }),
        h('span', { class: 'ohe-hint' }, 'Edits to the snippet update every post that uses it'),
        h('a', { class: 'ohe-mini-btn', href: `${snippetsUrl(this.ed)}/${encodeURIComponent(d.snippet_id || '')}/edit`, target: '_blank', rel: 'noopener' }, 'Edit snippet ↗'),
        h('button', { type: 'button', class: 'ohe-mini-btn', title: 'Replace with an editable copy of its blocks', onclick: () => this.detach() }, 'Detach (make a copy)'));
      this.body.prepend(bar);
    }
    placeholder() { return '<div class="ohe-ph">⧉ This snippet is empty or was deleted</div>'; }
    async detach() {
      try {
        const r = await getJSON(`${snippetsUrl(this.ed)}/${encodeURIComponent(this.d.snippet_id)}/json`);
        const list = this.item.list;
        let idx = list.items.indexOf(this.item);
        list.remove(this.item, true);
        for (const b of r.doc.blocks) list.insert({ ...b, id: uid() }, idx++);
        this.ed.changed();
        OHToast('Detached — these blocks are now a copy you can edit here');
      } catch (e) { OHToast('Could not load the snippet'); }
    }
  }
  class RecProductsView extends CardView {
    fields() { return [{ k: 'title', label: 'Title', type: 'text', ph: 'Picked for you' }, { k: 'limit', label: 'Show', type: 'number', min: 1, max: 6 }, { k: 'cta', label: 'Link text', type: 'text', ph: 'View' }, { k: 'layout', label: 'Layout', type: 'select', options: [['grid', 'Grid'], ['list', 'List']] }]; }
    extra() { this.body.append(h('p', { class: 'ohe-hint', contenteditable: 'false', style: { margin: '6px 0 0' } }, '🎯 Personalized per reader at send time: products they haven’t bought, ranked by what similar readers bought, their interests (tags) and popularity — bestsellers when there’s no signal. Links carry UTM attribution.')); }
    placeholder() { return '<div class="ohe-ph">🎯 Recommended products — add products in Monetize → Shop</div>'; }
  }
  class HtmlDocView extends View {
    render() {
      const d = this.d;
      this.ta = h('textarea', { class: 'ohe-code-ta ohe-doc-ta', spellcheck: 'false', placeholder: '<!DOCTYPE html>… paste a full email HTML document. Merge tags work; {{unsubscribe_url}} is added if missing.', 'aria-label': 'Email HTML' });
      this.ta.value = d.html || '';
      this.frame = h('iframe', { class: 'ohe-doc-frame', sandbox: 'allow-same-origin', title: 'Coded email preview' });
      this.toggle = h('button', { type: 'button', class: 'ohe-mini-btn', onclick: () => { this.showCode = !this.showCode; this.mode(); } }, 'Edit HTML');
      const up = h('button', { type: 'button', class: 'ohe-mini-btn', onclick: () => pickFile('.html,.htm,text/html', (f) => { const r = new FileReader(); r.onload = () => { this.ta.value = String(r.result || ''); this.sync(); this.changed(); this.paint(); }; r.readAsText(f); }) }, 'Upload .html');
      this.info = h('span', { class: 'ohe-hint' });
      this.ta.addEventListener('input', () => { this.sync(); this.changed(); this.paintSoon(); });
      this.ta.addEventListener('keydown', (e) => { if (e.key === 'Tab') { e.preventDefault(); this.ta.setRangeText('  ', this.ta.selectionStart, this.ta.selectionEnd, 'end'); } e.stopPropagation(); });
      this.body.append(h('div', { class: 'ohe-doc', contenteditable: 'false' }, h('div', { class: 'ohe-code-bar' }, h('span', { class: 'ohe-hint' }, '</> Coded email · sent exactly as written'), this.info, h('span', { style: { flex: '1' } }), up, this.toggle), this.ta, this.frame));
      this.paintSoon = debounce(() => this.paint(), 300);
      this.showCode = !d.html;
      this.mode();
      this.paint();
    }
    mode() { this.ta.classList.toggle('hide', !this.showCode); this.toggle.textContent = this.showCode ? 'Preview' : 'Edit HTML'; if (this.showCode) setTimeout(() => this.ta.focus()); }
    paint() {
      const v = this.ta.value || '';
      this.frame.srcdoc = v || '<p style="font:14px sans-serif;color:#888;padding:20px">Paste your HTML to see it here.</p>';
      const kb = Math.round(new Blob([v]).size / 1024);
      const unsub = /\{\{\s*unsubscribe_url\s*\}\}/i.test(v);
      this.info.textContent = `${kb} KB · ${unsub ? 'unsubscribe link ✓' : 'unsubscribe footer will be added'}${/<script|\son[a-z]+\s*=/i.test(v) ? ' · scripts will be removed' : ''}`;
    }
    sync() { this.d.html = this.ta.value; }
    focus() { this.showCode = true; this.mode(); }
  }

  /** Insert-snippet picker: choose a snippet and how to insert it (synced reference or editable copy). */
  async function snippetPicker(ed) {
    let items = [];
    try { items = (await getJSON(`${snippetsUrl(ed)}.json`)).items || []; } catch {}
    if (!items.length) { OHToast('No snippets yet — save blocks with ⋮⋮ → “Save as snippet”, or create one in Posts → Snippets', 5000); return null; }
    const list = h('div', { class: 'ohe-snip-list', role: 'radiogroup' }, ...items.map((s, i) => h('label', { class: 'ohe-snip-i' }, h('input', { type: 'radio', name: 'snippet', value: s.id, checked: i === 0 ? true : null }), h('span', {}, h('strong', { text: s.name }), h('small', { text: s.description || s.summary })))));
    const how = h('div', { class: 'ohe-snip-how' },
      h('label', {}, h('input', { type: 'radio', name: 'how', value: 'synced', checked: true }), h('span', {}, h('strong', { text: 'Synced' }), h('small', { text: 'Stays linked — editing the snippet updates this post too' }))),
      h('label', {}, h('input', { type: 'radio', name: 'how', value: 'copy' }), h('span', {}, h('strong', { text: 'Copy' }), h('small', { text: 'Inserts editable blocks — later snippet edits won’t affect this post' }))));
    const f = await dialogBox('Insert a snippet', h('div', { class: 'ohe-form' }, list, how, h('p', { class: 'ohe-hint' }, h('a', { href: snippetsUrl(ed), target: '_blank' }, 'Manage snippets ↗'))), 'Insert');
    if (!f) return null;
    const sid = f.querySelector('[name=snippet]:checked')?.value;
    const mode = f.querySelector('[name=how]:checked')?.value || 'synced';
    const s = items.find((x) => x.id === sid);
    if (!s) return null;
    if (mode === 'synced') return [{ id: uid(), type: 'snippet', data: { snippet_id: s.id, name: s.name } }];
    const r = await getJSON(`${snippetsUrl(ed)}/${encodeURIComponent(s.id)}/json`);
    return (r.doc.blocks || []).map((b) => ({ ...b, id: uid() }));
  }

  /** Save a block (and optionally the blocks after it) as a named snippet; optionally swap them for a synced reference. */
  async function saveAsSnippet(ed, it) {
    const list = it.list;
    const idx = list.items.indexOf(it);
    const after = list.items.length - idx - 1;
    const name = h('input', { class: 'input', name: 'name', placeholder: 'e.g. Signature, Sponsor banner, Footer CTA', required: true });
    const count = h('input', { class: 'input', type: 'number', name: 'count', min: 1, max: after + 1, value: 1, style: { width: '90px' } });
    const replace = h('input', { type: 'checkbox', name: 'replace', checked: true });
    const body = h('div', { class: 'ohe-form' },
      h('label', { class: 'field' }, h('span', { class: 'field-l', text: 'Snippet name' }), name),
      h('label', { class: 'field' }, h('span', { class: 'field-l', text: 'Blocks to include' }), h('span', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, count, h('small', { class: 'ohe-hint', text: after ? `this block + up to ${after} below it` : 'this block' }))),
      h('label', { class: 'check' }, replace, h('span', { text: ' Replace them here with the synced snippet' })));
    const f = await dialogBox('Save as snippet', body, 'Save snippet');
    if (!f) return;
    const n = Math.max(1, Math.min(after + 1, Number(count.value) || 1));
    const its = list.items.slice(idx, idx + n);
    const blocks = its.map((x) => x.view.toJSON());
    try {
      const r = await postJSON(`${snippetsUrl(ed)}.json`, { name: name.value.trim() || 'Untitled snippet', blocks });
      if (replace.checked) {
        its.forEach((x) => list.remove(x, true));
        list.insert({ id: uid(), type: 'snippet', data: { snippet_id: r.id, name: r.name } }, idx);
        ed.changed();
      }
      OHToast(`Saved snippet “${r.name}”`);
    } catch (e) { OHToast(e.message || 'Could not save the snippet', 5000); }
  }

  const VIEWS = {
    paragraph: ParagraphView, heading: HeadingView, list: ListView, checklist: ChecklistView, quote: QuoteView, code: CodeView, html: HtmlView,
    image: ImageView, gallery: GalleryView, video: FileView, audio: FileView, attachment: FileView, embed: EmbedView, table: TableView,
    columns: ColumnsView, section: SectionView, dynamic: DynamicView, button: ButtonView, divider: DividerView, spacer: SpacerView, toc: TocView,
    paywall: PaywallView, subscribe: SubscribeView, poll: PollView, referral: ReferralView, recommendations: RecsView, ad: AdView, ad_auto: AdAutoView,
    podcast: PodcastView, product: ProductView, event: EventView,
    snippet: SnippetView, recommended_products: RecProductsView, html_document: HtmlDocView,
  };

  // ───────── settings bar (generic field editor for block data) ─────────
  function settingsBar(fields, data, onChange, ed, extra = []) {
    const bar = h('div', { class: 'ohe-settings', contenteditable: 'false' });
    for (const f of fields) {
      let input;
      const v = data[f.k] ?? (f.def !== undefined ? f.def : '');
      if (f.type === 'select') {
        input = h('select', { class: 'ohe-mini' }, ...f.options.map(([ov, ol]) => h('option', { value: ov, selected: String(v) === String(ov) ? true : null }, ol)));
        input.addEventListener('change', () => { data[f.k] = input.value; onChange(); });
      } else if (f.type === 'checkbox') {
        input = h('input', { type: 'checkbox', checked: v !== false && v !== '' ? true : null });
        input.addEventListener('change', () => { data[f.k] = input.checked; onChange(); });
      } else if (f.type === 'color') {
        const txt = h('input', { class: 'ohe-mini ohe-color-t', value: v || '', placeholder: 'auto', size: 7 });
        const pick = h('input', { type: 'color', class: 'ohe-color', value: /^#[0-9a-f]{6}$/i.test(v) ? v : '#000000', 'aria-label': f.label });
        pick.addEventListener('input', () => { txt.value = pick.value; data[f.k] = pick.value; onChange(); });
        txt.addEventListener('input', () => { data[f.k] = txt.value.trim(); if (/^#[0-9a-f]{6}$/i.test(txt.value)) pick.value = txt.value; onChange(); });
        input = h('span', { class: 'ohe-color-wrap' }, pick, txt);
      } else if (f.type === 'image') {
        const txt = h('input', { class: 'ohe-mini', value: v || '', placeholder: 'https://…' });
        txt.addEventListener('input', () => { data[f.k] = txt.value.trim(); onChange(); });
        const up = h('button', { type: 'button', class: 'ohe-mini-btn', onclick: () => pickFile('image/*', async (file) => { try { const r = await upload(ed, file); txt.value = r.url; data[f.k] = r.url; onChange(); } catch (e) { OHToast(e.message); } }) }, 'Upload');
        input = h('span', { class: 'ohe-color-wrap' }, txt, up);
      } else {
        input = h('input', { class: 'ohe-mini', type: f.type === 'number' ? 'number' : f.type === 'range' ? 'range' : f.type === 'url' ? 'url' : 'text', value: v ?? '', placeholder: f.ph || '', min: f.min, max: f.max, 'data-find': !f.type || f.type === 'text' ? f.k : null });
        input.addEventListener('input', () => { data[f.k] = f.type === 'number' || f.type === 'range' ? (input.value === '' ? '' : +input.value) : input.value; onChange(); });
      }
      bar.append(h('label', { class: f.wide ? 'wide' : '' }, h('span', {}, f.label), input));
    }
    extra.forEach((x) => bar.append(x));
    return bar;
  }

  // ───────── per-block channel (email / web) ─────────
  const showIn = (b) => (b && b.data && (b.data.show_in === 'email' || b.data.show_in === 'web') ? b.data.show_in : '');
  function paintChannel(it) {
    const ch = showIn(it.block);
    let badge = it.el.querySelector(':scope > .ohe-chan');
    it.el.classList.toggle('ohe-only-email', ch === 'email');
    it.el.classList.toggle('ohe-only-web', ch === 'web');
    if (!ch) { badge && badge.remove(); return; }
    if (!badge) { badge = h('span', { class: 'ohe-chan', contenteditable: 'false' }); it.el.insertBefore(badge, it.body); }
    badge.textContent = ch === 'email' ? '✉ Email only' : '🌐 Web only';
    badge.title = ch === 'email' ? 'Only in the email — hidden on the website (change in the block menu ⋮⋮)' : 'Only on the website — left out of the email (change in the block menu ⋮⋮)';
  }

  // ───────── block menu ─────────
  async function blockMenu(ed, it, anchor) {
    const t = it.block.type;
    const textish = ['paragraph', 'heading', 'list', 'checklist', 'quote', 'code'].includes(t);
    const items = [
      ...(textish ? [{ label: 'Turn into: Text', value: 'to:paragraph' }, { label: 'Turn into: Heading 2', value: 'to:h2' }, { label: 'Turn into: Heading 3', value: 'to:h3' }, { label: 'Turn into: Bulleted list', value: 'to:list' }, { label: 'Turn into: Numbered list', value: 'to:olist' }, { label: 'Turn into: Quote', value: 'to:quote' }, { label: 'Turn into: Code', value: 'to:code' }, { sep: true }] : []),
      ...(['paragraph', 'heading'].includes(t) ? [{ label: 'Align left', value: 'align:left' }, { label: 'Align center', value: 'align:center' }, { label: 'Align right', value: 'align:right' }, { sep: true }] : []),
      ...(ed.features.ai && ['paragraph', 'heading', 'quote'].includes(t) ? [{ label: '✨ AI: rewrite / fix / translate…', value: 'ai' }, { sep: true }] : []),
      ...((ed.opts.channels ?? !ed.opts.compact) ? [
        { label: `Show in: Email and web${!showIn(it.block) ? '  ✓' : ''}`, value: 'show:' },
        { label: `Show in: Email only${showIn(it.block) === 'email' ? '  ✓' : ''}`, value: 'show:email' },
        { label: `Show in: Web only${showIn(it.block) === 'web' ? '  ✓' : ''}`, value: 'show:web' },
        { sep: true },
      ] : []),
      { label: 'Duplicate', value: 'dup', sub: isMac ? '⌘D' : 'Ctrl+D' }, { label: 'Move up', value: 'up' }, { label: 'Move down', value: 'down' },
      ...(ed.opts.onComment ? [{ label: 'Comment', value: 'comment' }] : []),
      { label: 'Wrap in section', value: 'wrap' },
      ...(ed.opts.snippets !== false && !(ed.opts.exclude || []).includes('snippet') && !['snippet', 'paywall', 'html_document'].includes(t) ? [{ label: '⧉ Save as snippet…', value: 'snippet' }] : []),
      { sep: true }, { label: 'Delete', value: 'del', danger: true },
    ];
    const v = await menuBox(anchor, items);
    if (!v) return;
    if (v.startsWith('to:')) ed.convert(it, v.slice(3));
    else if (v === 'ai') ed.aiEdit(anchor, it);
    else if (v.startsWith('show:')) { it.view.sync(); const ch = v.slice(5); if (ch) it.block.data.show_in = ch; else delete it.block.data.show_in; paintChannel(it); ed.changed(); }
    else if (v.startsWith('align:')) { it.view.sync(); it.block.data.align = v.slice(6) === 'left' ? undefined : v.slice(6); it.view.el.style.textAlign = it.block.data.align || ''; ed.changed(); }
    else if (v === 'snippet') saveAsSnippet(ed, it);
    else if (v === 'dup') ed.duplicate(it);
    else if (v === 'up') ed.move(it, -1);
    else if (v === 'down') ed.move(it, 1);
    else if (v === 'del') { it.list.remove(it); ed.changed(); }
    else if (v === 'comment') ed.opts.onComment(ed.topItem(it).block.id, (it.body.textContent || TYPES[it.block.type]?.label || '').replace(/\s+/g, ' ').trim().slice(0, 120));
    else if (v === 'wrap') { const b = it.view.toJSON(); const idx = it.list.items.indexOf(it); it.list.remove(it, true); it.list.insert({ id: uid(), type: 'section', data: { blocks: [b], style: { bg: '#f8fafc', padding: 20, radius: 10 } } }, idx); ed.changed(); }
  }

  // ───────── small UI primitives (menus, prompts, pickers) ─────────
  let openMenu = null;
  function closeMenu(val = null) { if (openMenu) { const m = openMenu; openMenu = null; if (m.off) document.removeEventListener('mousedown', m.off); m.el.remove(); m.resolve(val); } }
  function menuBox(anchor, items) {
    closeMenu();
    return new Promise((resolve) => {
      const el = h('div', { class: 'ohe-menu', role: 'menu' });
      items.forEach((x) => el.append(x.sep ? h('div', { class: 'ohe-menu-sep' }) : h('button', { type: 'button', role: 'menuitem', class: x.danger ? 'danger' : '', onmousedown: (e) => e.preventDefault(), onclick: () => closeMenu(x.value) }, h('span', { text: x.label }), x.sub ? h('small', { text: x.sub }) : null)));
      document.body.append(el);
      const r = anchor.getBoundingClientRect();
      Object.assign(el.style, { top: Math.min(r.bottom + 4, window.innerHeight - el.offsetHeight - 8) + window.scrollY + 'px', left: Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8)) + window.scrollX + 'px' });
      const m = (openMenu = { el, resolve });
      // outside click closes THIS menu only (a stale listener must not close a menu opened after it)
      setTimeout(() => { if (openMenu !== m) return; m.off = (e) => { if (!el.contains(e.target) && openMenu === m) closeMenu(); }; document.addEventListener('mousedown', m.off); });
      el.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
      el.querySelector('button')?.focus({ preventScroll: true });
    });
  }
  function dialogBox(title, body, okLabel = 'OK') {
    return new Promise((resolve) => {
      const dlg = h('dialog', { class: 'ohe-dialog' });
      const form = h('form', { method: 'dialog' }, h('h3', { text: title }), body, h('div', { class: 'ohe-dialog-actions' }, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', value: 'cancel', onclick: () => dlg.close('cancel') }, 'Cancel'), h('button', { class: 'btn btn-primary btn-sm', value: 'ok' }, okLabel)));
      dlg.append(form);
      document.body.append(dlg);
      dlg.addEventListener('close', () => { const v = dlg.returnValue; dlg.remove(); resolve(v === 'ok' ? form : null); });
      dlg.showModal();
      setTimeout(() => form.querySelector('input,textarea')?.focus());
    });
  }
  async function promptBox(title, ph, value, o = {}) {
    const input = o.multiline ? h('textarea', { class: 'input', rows: 4, placeholder: ph, name: 'v' }) : h('input', { class: 'input', placeholder: ph, name: 'v' });
    input.value = value || '';
    if (o.multiline) input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); input.form.requestSubmit(); } });
    const body = h('div', {}, input, o.remove ? h('p', { class: 'ohe-hint' }, 'Clear the field and press OK to remove the link.') : null);
    const f = await dialogBox(title, body);
    return f ? f.querySelector('[name=v]').value.trim() : null;
  }
  async function formBox(title, fields) {
    const body = h('div', { class: 'ohe-form' }, ...fields.map((f) => h('label', { class: 'field' }, h('span', { class: 'field-l', text: f.label }),
      f.type === 'select' ? h('select', { class: 'input', name: f.k }, ...f.options.map(([v, l]) => h('option', { value: v }, l))) : h('input', { class: 'input', name: f.k, placeholder: f.ph || '' }))));
    const fm = await dialogBox(title, body, 'Create');
    if (!fm) return null;
    const out = {};
    fields.forEach((f) => (out[f.k] = fm.querySelector(`[name="${f.k}"]`).value.trim()));
    return out;
  }
  function restoreRange(r, collapseEnd) { if (!r) return; const s = sel(); s.removeAllRanges(); s.addRange(r); if (collapseEnd) s.collapseToEnd(); }
  function pickFile(accept, cb, multiple = false) {
    const i = h('input', { type: 'file', accept, multiple: multiple ? true : null, style: { display: 'none' } });
    i.addEventListener('change', () => { [...i.files].forEach(cb); i.remove(); });
    document.body.append(i);
    i.click();
  }
  async function upload(ed, file) {
    if (window.OH && OH.upload) return OH.upload(file, { url: ed.opts.uploadUrl });
    const fd = new FormData(); fd.append('file', file);
    const r = await fetch(ed.opts.uploadUrl, { method: 'POST', body: fd, headers: { accept: 'application/json' } });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Upload failed'); return j;
  }
  /** GIF search (GIPHY via the server proxy) → imports the chosen GIF into the media library. Resolves {url, alt} or null. */
  function gifPicker(ed) {
    return new Promise((resolve) => {
      const grid = h('div', { class: 'ohe-mgrid ohe-gif-grid' }, h('p', { class: 'ohe-hint' }, 'Loading…'));
      const search = h('input', { class: 'input', placeholder: 'Search GIFs…', 'aria-label': 'Search GIFs' });
      const urlIn = h('input', { class: 'input', placeholder: 'Or paste a GIF URL (https://…)', 'aria-label': 'GIF URL' });
      let done = false;
      const finish = (v) => { if (done) return; done = true; dlg.close(); resolve(v); };
      const importUrl = async (url, alt) => {
        grid.innerHTML = '<p class="ohe-hint">Adding to your media library…</p>';
        try { const r = await postJSON(`${ed.opts.gifsUrl}/import`, { url, title: alt }); finish({ url: r.url, alt: alt || 'GIF' }); }
        catch (e) { OHToast(e.message, 4000); load(); }
      };
      const dlg = h('dialog', { class: 'ohe-dialog ohe-media-dlg' },
        h('div', { class: 'ohe-mhead' }, h('h3', { text: 'Insert a GIF' }), search,
          h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => pickFile('image/gif', async (f) => { try { const r = await upload(ed, f); finish({ url: r.url, alt: f.name.replace(/\.gif$/i, '') }); } catch (e) { OHToast(e.message); } }) }, 'Upload .gif'),
          h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': 'Close', onclick: () => finish(null) }, '✕')),
        h('div', { class: 'ohe-gif-url row' }, urlIn, h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => urlIn.value.trim() && importUrl(urlIn.value.trim(), 'GIF') }, 'Add')),
        grid, h('p', { class: 'ohe-hint ohe-gif-attr' }, 'Powered by GIPHY'));
      document.body.append(dlg);
      dlg.addEventListener('close', () => { dlg.remove(); if (!done) { done = true; resolve(null); } });
      dlg.showModal();
      search.focus();
      const load = async () => {
        try {
          const r = await getJSON(`${ed.opts.gifsUrl}?q=${encodeURIComponent(search.value.trim())}`);
          grid.innerHTML = '';
          if (!r.configured) { grid.append(h('p', { class: 'ohe-hint' }, r.help || 'GIF search is not configured.')); search.disabled = true; return; }
          if (r.error) grid.append(h('p', { class: 'ohe-hint' }, r.error));
          if (!r.results.length && !r.error) grid.append(h('p', { class: 'ohe-hint' }, 'No GIFs found.'));
          r.results.forEach((g) => grid.append(h('button', { type: 'button', class: 'ohe-mitem', title: g.title, onclick: () => importUrl(g.url, g.title) }, h('img', { src: g.preview, alt: g.title, loading: 'lazy' }))));
        } catch { grid.innerHTML = '<p class="ohe-hint">Could not load GIFs</p>'; }
      };
      search.addEventListener('input', debounce(load, 350));
      load();
    });
  }
  function mediaPicker(ed, type) {
    return new Promise(async (resolve) => {
      const grid = h('div', { class: 'ohe-mgrid' }, h('p', { class: 'ohe-hint' }, 'Loading…'));
      const search = h('input', { class: 'input', placeholder: 'Search media…' });
      const dlg = h('dialog', { class: 'ohe-dialog ohe-media-dlg' }, h('div', { class: 'ohe-mhead' }, h('h3', { text: 'Media library' }), search, h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => pickFile(type === 'image' ? 'image/*' : '*/*', async (f) => { try { const r = await upload(ed, f); dlg.close(); resolve(r); } catch (e) { OHToast(e.message); } }) }, 'Upload'), h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { dlg.close(); resolve(null); } }, '✕')), grid);
      document.body.append(dlg);
      dlg.addEventListener('close', () => dlg.remove());
      dlg.showModal();
      const load = async () => {
        try {
          const r = await getJSON(`${ed.opts.mediaUrl}?type=${encodeURIComponent(type || '')}&q=${encodeURIComponent(search.value)}`);
          grid.innerHTML = '';
          if (!r.items.length) grid.append(h('p', { class: 'ohe-hint' }, 'No files yet — upload one.'));
          r.items.forEach((m) => grid.append(h('button', { type: 'button', class: 'ohe-mitem', title: m.name, onclick: () => { dlg.close(); resolve(m); } }, m.mime.startsWith('image/') ? h('img', { src: m.url, alt: m.alt || '', loading: 'lazy' }) : h('span', { class: 'ohe-mext', text: (m.name.split('.').pop() || '').toUpperCase() }), h('small', { text: m.name }))));
        } catch { grid.innerHTML = '<p class="ohe-hint">Could not load media</p>'; }
      };
      search.addEventListener('input', debounce(load, 250));
      load();
    });
  }
  function OHToast(msg, ms) { if (window.OH && OH.toast) OH.toast(msg, ms); else console.log(msg); }
  async function postJSON(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Request failed');
    return j;
  }
  async function getJSON(url) { const r = await fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' }); if (!r.ok) throw new Error('Request failed'); return r.json(); }

  function fileBlock(f) {
    if (/^image\//.test(f.type)) return { id: uid(), type: 'image', data: TYPES.image.data() };
    if (/^video\//.test(f.type)) return { id: uid(), type: 'video', data: TYPES.video.data() };
    if (/^audio\//.test(f.type)) return { id: uid(), type: 'audio', data: TYPES.audio.data() };
    return { id: uid(), type: 'attachment', data: TYPES.attachment.data() };
  }

  // ───────── HTML / text → blocks (paste) ─────────
  function textToBlocks(text) {
    const out = [];
    const paras = String(text || '').replace(/\r/g, '').split(/\n{2,}/);
    for (const raw of paras) {
      const lines = raw.split('\n').filter((l) => l.trim());
      if (!lines.length) continue;
      if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) { out.push({ id: uid(), type: 'list', data: { ordered: false, items: lines.map((l) => esc(l.replace(/^\s*[-*•]\s+/, ''))) } }); continue; }
      if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) { out.push({ id: uid(), type: 'list', data: { ordered: true, items: lines.map((l) => esc(l.replace(/^\s*\d+[.)]\s+/, ''))) } }); continue; }
      const m = lines[0].match(/^(#{1,4})\s+(.*)/);
      if (m && lines.length === 1) { out.push({ id: uid(), type: 'heading', data: { level: Math.max(2, m[1].length), html: esc(m[2]) } }); continue; }
      if (isEmbedUrl(raw.trim())) { out.push({ id: uid(), type: 'embed', data: { url: raw.trim(), caption: '' } }); continue; }
      out.push(P(lines.map((l) => esc(l).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')).join('<br>')));
    }
    return out;
  }

  // ── font-size heading detection (Google Docs / Word paste) ──
  /** font-size in pt from an inline style ('20pt', '26.6667px', '1.5em' relative to 11pt), or 0. */
  function ptOf(style) {
    const m = /font-size:\s*([\d.]+)\s*(pt|px|em|rem)?/i.exec(style || '');
    if (!m) return 0;
    const v = parseFloat(m[1]), u = (m[2] || 'px').toLowerCase();
    return u === 'pt' ? v : u === 'px' ? v * 0.75 : v * 11;
  }
  /** Map each text node's length to the nearest ancestor font-size within `root`. */
  function textSizes(root) {
    const out = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = w.nextNode())) {
      const len = t.textContent.replace(/\s+/g, '').length;
      if (!len) continue;
      let size = 0;
      for (let el = t.parentElement; el && el !== root.parentElement && !size; el = el.parentElement) size = ptOf(el.getAttribute('style'));
      out.push([len, size]);
    }
    return out;
  }
  /** The body text size of the pasted document: the font-size covering the most characters (default 11pt). */
  function bodyFontSize(root) {
    const tally = new Map();
    for (const [len, size] of textSizes(root)) if (size) tally.set(size, (tally.get(size) || 0) + len);
    let best = 0, bestN = 0;
    for (const [size, n] of tally) if (n > bestN) { best = size; bestN = n; }
    return best || 11;
  }
  /** Heading level (2-4) for a short paragraph whose text is all clearly larger than the body size, else 0. */
  function sizeHeading(p, base) {
    const text = p.textContent.replace(/\s+/g, ' ').trim();
    if (!text || text.length > 140 || p.querySelector('br') || /[.!?:;,]$/.test(text) && text.length > 60) return 0;
    const sizes = textSizes(p);
    if (!sizes.length || sizes.some(([, s]) => !s)) return 0;
    const min = Math.min(...sizes.map(([, s]) => s));
    const ratio = min / base;
    if (ratio >= 1.6) return 2;   // e.g. 20pt+ over 11pt body (Docs "Heading 1" size)
    if (ratio >= 1.25) return 3;  // e.g. 14-16pt (Docs "Heading 2/3" sizes)
    if (ratio >= 1.15) return 4;  // e.g. 13pt
    return 0;
  }

  function htmlToBlocks(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,meta,link,title,noscript').forEach((x) => x.remove());
    const baseSize = bodyFontSize(doc.body);
    const out = [];
    let pendingInline = document.createElement('div');
    const flush = () => { const hh = cleanInline(pendingInline); if (hh) out.push(P(hh)); pendingInline = document.createElement('div'); };
    const listItems = (listEl) => [...listEl.children].filter((c) => c.tagName === 'LI').map((li) => {
      const copy = li.cloneNode(true);
      copy.querySelectorAll('ul,ol').forEach((x) => x.remove());
      const sub = li.querySelector('ul,ol');
      const kids = sub ? listItems(sub) : [];
      const hh = cleanInline(copy);
      return kids.length ? { html: hh, items: kids } : hh;
    });
    const walk = (parent) => {
      for (const n of [...parent.childNodes]) {
        if (n.nodeType === 3) { if (n.textContent.trim()) pendingInline.append(n.cloneNode()); continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName;
        if (/^H[1-6]$/.test(tag)) { flush(); const hh = cleanInline(n); if (hh) out.push({ id: uid(), type: 'heading', data: { level: Math.min(4, Math.max(2, +tag[1])), html: hh } }); continue; }
        if (tag === 'P') {
          flush();
          // Google Docs / Word mark manually-styled headings only via font-size on spans: a short paragraph whose
          // text is all noticeably larger than the document's body size becomes a heading.
          const hh = cleanInline(n);
          const lvl = hh ? sizeHeading(n, baseSize) : 0;
          if (lvl) out.push({ id: uid(), type: 'heading', data: { level: lvl, html: hh.replace(/<\/?(strong|b)>/gi, '') } });
          else if (hh) out.push(P(hh));
          n.querySelectorAll('img').forEach((img) => img.src && /^https?:/.test(img.src) && out.push({ id: uid(), type: 'image', data: { ...TYPES.image.data(), src: img.src, alt: img.alt || '' } }));
          continue;
        }
        if (tag === 'UL' || tag === 'OL') { flush(); const items = listItems(n); if (items.length) out.push({ id: uid(), type: 'list', data: { ordered: tag === 'OL', items } }); continue; }
        if (tag === 'BLOCKQUOTE') { flush(); out.push({ id: uid(), type: 'quote', data: { html: cleanInline(n), cite: '', style: { variant: 'line' } } }); continue; }
        if (tag === 'PRE') { flush(); out.push({ id: uid(), type: 'code', data: { lang: '', code: n.textContent } }); continue; }
        if (tag === 'HR') { flush(); out.push({ id: uid(), type: 'divider', data: { style: 'line' } }); continue; }
        if (tag === 'IMG') { flush(); if (/^https?:/.test(n.getAttribute('src') || '')) out.push({ id: uid(), type: 'image', data: { ...TYPES.image.data(), src: n.getAttribute('src'), alt: n.getAttribute('alt') || '' } }); continue; }
        if (tag === 'TABLE') {
          flush();
          const rows = [...n.querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => cleanInline(td)));
          if (rows.length) { const w = Math.max(...rows.map((r) => r.length)); rows.forEach((r) => { while (r.length < w) r.push(''); }); out.push({ id: uid(), type: 'table', data: { rows, header: !!n.querySelector('th') } }); }
          continue;
        }
        if (tag === 'IFRAME') { flush(); const src = n.getAttribute('src') || ''; const m = src.match(/youtube(?:-nocookie)?\.com\/embed\/([\w-]{11})/); if (m) out.push({ id: uid(), type: 'embed', data: { url: 'https://www.youtube.com/watch?v=' + m[1], caption: '' } }); continue; }
        if (['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'BODY', 'HEADER', 'FOOTER', 'FIGURE', 'CENTER'].includes(tag) || (tag === 'B' && /font-weight:\s*normal/i.test(n.getAttribute('style') || '')) || n.id?.startsWith('docs-internal-guid')) {
          if ([...n.children].some((c) => /^(P|H[1-6]|UL|OL|TABLE|BLOCKQUOTE|PRE|DIV|HR|IMG|FIGURE|SECTION)$/.test(c.tagName))) { walk(n); continue; }
          if (tag === 'DIV' || tag === 'FIGURE') { flush(); const hh = cleanInline(n); if (hh) out.push(P(hh)); n.querySelectorAll('img').forEach((img) => /^https?:/.test(img.src) && out.push({ id: uid(), type: 'image', data: { ...TYPES.image.data(), src: img.src, alt: img.alt || '' } })); continue; }
          walk(n);
          continue;
        }
        if (tag === 'BR') { flush(); continue; }
        pendingInline.append(n.cloneNode(true));
      }
    };
    walk(doc.body);
    flush();
    return out;
  }

  // ═════════════════════════ Collaboration client ═════════════════════════
  class Collab {
    constructor(ed, cfg) {
      this.ed = ed;
      this.cfg = cfg;
      this.sent = new Map();
      this.order = [];
      this.pending = new Map();
      this.peers = [];
      this.backoff = 1000;
      this.connect();
    }
    connect() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.ws = new WebSocket(`${proto}//${location.host}${this.cfg.url}`);
      this.ws.onmessage = (e) => this.onMsg(JSON.parse(e.data));
      this.ws.onopen = () => { this.backoff = 1000; this.ed.emit('collab', { connected: true }); };
      this.ws.onclose = () => { this.ed.emit('collab', { connected: false }); if (!this.closed) setTimeout(() => this.connect(), (this.backoff = Math.min(this.backoff * 2, 15000))); };
    }
    close() { this.closed = true; try { this.ws.close(); } catch {} }
    send(m) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
    snapshot() {
      this.sent = new Map(this.ed.root.toJSON().map((b) => [b.id, JSON.stringify(b)]));
      this.order = this.ed.root.items.map((i) => i.block.id);
    }
    onMsg(m) {
      const ed = this.ed;
      if (m.t === 'init') {
        if (m.me) this.me = m.me;
        const local = JSON.stringify(ed.getDoc());
        const remote = JSON.stringify(m.doc);
        if (remote !== local && (m.reset || (m.doc.blocks || []).length)) {
          // the room is the source of truth when it already has content (another editor may be ahead)
          ed.setDoc(m.doc, { silent: !m.reset });
        }
        if (m.title !== undefined) ed.emit('remote-meta', { title: m.title, subtitle: m.subtitle });
        this.snapshot();
        // if we had unsent local edits before connecting, push them
        if (!m.reset && remote !== local && !(m.doc.blocks || []).length) this.diff();
        this.setPeers(m.peers || []);
        return;
      }
      if (m.t === 'peers') return this.setPeers(m.peers);
      if (m.t === 'meta') return ed.emit('remote-meta', m);
      if (m.t === 'op') this.apply(m.op);
    }
    apply(op) {
      const ed = this.ed;
      const focused = ed.focusedItem();
      const focusedTop = focused ? ed.topItem(focused) : null;
      if (op.k === 'upsert') {
        const it = ed.findItem(op.block.id);
        const baseJSON = this.sent.get(op.block.id);
        this.sent.set(op.block.id, JSON.stringify(op.block));
        if (it && it.list === ed.root) {
          if (focusedTop === it) {
            // Someone else edited the paragraph we're typing in: merge both edits when they don't overlap.
            if (this.mergeInto(it, baseJSON, op.block)) return;
            this.pending.set(op.block.id, op); return;
          }
          const idx = ed.root.items.indexOf(it);
          ed.root.remove(it, true);
          ed.root.insert(op.block, idx);
        } else if (!it) ed.root.insert(op.block, Math.min(op.index ?? ed.root.items.length, ed.root.items.length));
      } else if (op.k === 'delete') {
        const it = ed.findItem(op.id);
        this.sent.delete(op.id);
        if (it && it.list === ed.root && it !== focusedTop) ed.root.remove(it);
      } else if (op.k === 'order') {
        const byId = new Map(ed.root.items.map((i) => [i.block.id, i]));
        const ordered = op.ids.map((x) => byId.get(x)).filter(Boolean);
        ed.root.items.forEach((i) => !ordered.includes(i) && ordered.push(i));
        ed.root.items = ordered;
        ordered.forEach((i) => ed.root.el.append(i.el));
      }
      this.order = ed.root.items.map((i) => i.block.id);
      ed.lastJSON = JSON.stringify(ed.getDoc());
      ed.syncInput();
      ed.opts.onChange && ed.opts.onChange(ed.getDoc());
      ed.emit('change', ed.getDoc());
      this.paintPeers();
    }
    /** Three-way merge of a text block's HTML: base (last synced), ours (being typed), theirs (just arrived).
     *  Each side's edit is reduced to one changed region; non-overlapping regions are both applied. */
    mergeInto(it, baseJSON, theirs) {
      try {
        const ed = this.ed;
        const base = baseJSON ? JSON.parse(baseJSON) : null;
        const ours = it.block && ed.root.toJSON().find((b) => b.id === theirs.id);
        const B = base?.data?.html, O = ours?.data?.html, T = theirs?.data?.html;
        if (typeof B !== 'string' || typeof O !== 'string' || typeof T !== 'string' || ours.type !== theirs.type || base.type !== theirs.type) return false;
        const region = (a, b) => {
          let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
          let q = 0; while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
          return { start: p, end: a.length - q, ins: b.slice(p, b.length - q) };
        };
        const ro = region(B, O), rt = region(B, T);
        const oursChanged = ro.start !== ro.end || ro.ins, theirsChanged = rt.start !== rt.end || rt.ins;
        if (!theirsChanged) return true;                     // nothing new from them
        if (oursChanged && !(ro.end <= rt.start || rt.end <= ro.start)) return false; // same words: keep old behaviour
        const apply = (src, r) => src.slice(0, r.start) + r.ins + src.slice(r.end);
        const merged = !oursChanged ? T : ro.start >= rt.start ? apply(apply(B, ro), rt) : apply(apply(B, rt), ro);
        // keep the caret: shift it by the length their edit added before it
        const el = it.el.querySelector('[contenteditable=true]');
        const textLen = (h) => { const d = document.createElement('div'); d.innerHTML = h; return d.textContent.length; };
        const before = el ? rangeText(el, true) : null;
        let caret = before ? before.text.length : null;
        // Their edit moves our caret only if it sits before it. Compare in the same (base) coordinates:
        // when we also edited, theirs is "before" if it ends where ours starts or earlier.
        const theirDelta = textLen(rt.ins) - textLen(B.slice(rt.start, rt.end));
        if (caret != null && (oursChanged ? rt.end <= ro.start : textLen(B.slice(0, rt.start)) < caret)) caret += theirDelta;
        const block = { ...theirs, data: { ...theirs.data, html: merged } };
        const idx = ed.root.items.indexOf(it);
        ed.root.remove(it, true);
        ed.root.insert(block, idx);
        const fresh = ed.root.items[idx];
        const nel = fresh && fresh.el.querySelector('[contenteditable=true]');
        if (nel && caret != null) { nel.focus({ preventScroll: true }); placeCaretAtOffset(nel, Math.max(0, caret)); }
        // the room has their version; send ours on top of it
        this.sent.set(theirs.id, JSON.stringify(theirs));
        this.order = ed.root.items.map((i) => i.block.id);
        ed.lastJSON = JSON.stringify(ed.getDoc());
        ed.syncInput();
        this.diff();
        this.paintPeers();
        return true;
      } catch (e) { return false; }
    }
    applyPending() {
      if (!this.pending.size) return;
      const focusedTop = this.ed.focusedItem() ? this.ed.topItem(this.ed.focusedItem()) : null;
      for (const [id, op] of [...this.pending]) {
        if (focusedTop && focusedTop.block.id === id) continue;
        this.pending.delete(id);
        this.apply(op);
      }
    }
    diff() {
      const blocks = this.ed.root.toJSON();
      const ids = blocks.map((b) => b.id);
      blocks.forEach((b, i) => {
        const j = JSON.stringify(b);
        if (this.sent.get(b.id) !== j) { this.sent.set(b.id, j); this.send({ t: 'op', op: { k: 'upsert', block: b, index: i } }); }
      });
      for (const id of [...this.sent.keys()]) if (!ids.includes(id)) { this.sent.delete(id); this.send({ t: 'op', op: { k: 'delete', id } }); }
      if (ids.join() !== this.order.join()) { this.order = ids; this.send({ t: 'op', op: { k: 'order', ids } }); }
    }
    presence(blockId) { if (blockId !== this.lastPresence) { this.lastPresence = blockId; this.send({ t: 'presence', block: blockId }); } }
    setPeers(peers) {
      this.peers = peers || [];
      this.ed.emit('peers', this.peers, this.me);
      if (this.cfg.avatarsEl) {
        const others = this.peers.filter((p) => !this.me || p.cid !== this.me.cid);
        this.cfg.avatarsEl.innerHTML = others.map((p) => `<span class="ohe-avatar" style="background:${esc(p.color)}" title="${esc(p.name)} is editing">${esc((p.name || '?').slice(0, 1).toUpperCase())}</span>`).join('');
      }
      this.paintPeers();
    }
    paintPeers() {
      this.ed.el.querySelectorAll('.ohe-peer-on').forEach((x) => { x.classList.remove('ohe-peer-on'); x.style.removeProperty('--peer'); x.removeAttribute('data-peer'); });
      for (const p of this.peers) {
        if (this.me && p.cid === this.me.cid) continue;
        const it = p.block && this.ed.findItem(p.block);
        if (it) { it.el.classList.add('ohe-peer-on'); it.el.style.setProperty('--peer', p.color); it.el.setAttribute('data-peer', p.name); }
      }
    }
  }

  // ═════════════════════════ public API ═════════════════════════
  let active = null;
  function mount(el, opts) {
    const ed = new Editor(el, opts || {});
    return {
      getDoc: () => ed.getDoc(),
      setDoc: (doc) => ed.setDoc(doc),
      plainText: () => ed.plainText(),
      insertText: (t) => ed.insertText(t),
      destroy: () => ed.destroy(),
      find: (q, o) => ed.find(q, o),
      findNext: () => ed.findNext(),
      replace: (q, r, o) => ed.replace(q, r, o),
      focusBlock: (id) => ed.focusBlock(id),
      setCommentCounts: (m) => ed.setCommentCounts(m),
      undo: () => ed.undo(),
      redo: () => ed.redo(),
      on: (ev, fn) => ed.on(ev, fn),
      sendMeta: (m) => ed.collab && ed.collab.send({ t: 'meta', ...m }),
      flush: () => ed.emitChange.flush(),
      insertGif: () => ed.pseudo('gif', ed.lastFocused || null),
      _editor: ed,
    };
  }
  const api = {
    mount,
    types: TYPES,
    htmlToBlocks,
    textToBlocks,
    plainText: () => (active ? active.plainText() : ''),
    insertText: (t) => active && active.insertText(t),
    getDoc: () => (active ? active.getDoc() : null),
  };
  window.OHEditor = api;
})();
