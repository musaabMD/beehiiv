// OpenHive dashboard behaviours (no framework). Exposes window.OH helpers for module scripts.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const OH = (window.OH = window.OH || {});

  OH.toast = (msg, ms = 2200) => {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  };

  OH.json = async (url, body, method) => {
    const r = await fetch(url, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : { text: await r.text() };
    if (!r.ok) throw Object.assign(new Error(data.error || data.message || r.statusText), { data, status: r.status });
    return data;
  };

  OH.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Resize/compress an image client-side: max 1600px, WebP/JPEG ~82%. GIF/SVG untouched. */
  OH.optimizeImage = async (file, max = 1600, quality = 0.82) => {
    if (!/^image\/(png|jpe?g|webp|avif)$/.test(file.type)) return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 400_000) return file;
      const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
      const type = file.type === 'image/png' ? 'image/webp' : 'image/jpeg';
      const blob = await new Promise((res) => canvas.toBlob(res, type, quality));
      if (!blob || blob.size >= file.size) return file;
      return new File([blob], file.name.replace(/\.[a-z0-9]+$/i, type === 'image/webp' ? '.webp' : '.jpg'), { type });
    } catch { return file; }
  };

  /** Upload to the media library. Returns {id, url, name, mime, size}. */
  OH.upload = async (file, opts = {}) => {
    const f = file.type.startsWith('image/') && opts.optimize !== false ? await OH.optimizeImage(file) : file;
    const fd = new FormData();
    fd.append('file', f);
    if (opts.folder) fd.append('folder', opts.folder);
    if (opts.alt) fd.append('alt', opts.alt);
    const r = await fetch(opts.url || '/app/posts/media/upload', { method: 'POST', body: fd, credentials: 'same-origin', headers: { accept: 'application/json' } });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Upload failed');
    return j;
  };

  // ── sidebar (mobile)
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-toggle-side]');
    if (t) $('#side')?.classList.toggle('open');
  });

  // ── confirm buttons
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-confirm]');
    if (b && b.dataset.confirm && !confirm(b.dataset.confirm)) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // ── copy
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    e.preventDefault();
    try { await navigator.clipboard.writeText(b.dataset.copy); OH.toast('Copied'); } catch { prompt('Copy:', b.dataset.copy); }
  });

  // ── dialogs
  document.addEventListener('click', (e) => {
    const o = e.target.closest('[data-open]');
    if (o) { const d = $(o.dataset.open); if (d?.showModal) { d.showModal(); d.querySelector('[autofocus],input:not([type=hidden]),textarea')?.focus(); } }
    const c = e.target.closest('[data-close]');
    if (c) c.closest('dialog')?.close();
  });
  document.addEventListener('click', (e) => { if (e.target.tagName === 'DIALOG') e.target.close(); });

  // ── clickable rows
  document.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-href]');
    if (tr && !e.target.closest('a,button,input,select,label,form')) location.href = tr.dataset.href;
  });

  // ── autosubmit selects / filters
  document.addEventListener('change', (e) => {
    if (e.target.matches('[data-autosubmit]')) e.target.form?.requestSubmit();
  });

  // ── select-all checkboxes for bulk actions
  document.addEventListener('change', (e) => {
    if (e.target.matches('[data-check-all]')) {
      const scope = e.target.closest('form') || document;
      $$(`input[type=checkbox][name="${e.target.dataset.checkAll}"]`, scope).forEach((x) => (x.checked = e.target.checked));
    }
  });

  // ── command palette (⌘K)
  const pal = $('#palette');
  const items = JSON.parse($('#palette-data')?.textContent || '[]');
  let sel = 0;
  const renderPal = () => {
    const q = $('input', pal).value.toLowerCase().trim();
    const list = items.filter(([l]) => !q || l.toLowerCase().includes(q)).slice(0, 40);
    sel = Math.min(sel, Math.max(0, list.length - 1));
    $('ul', pal).innerHTML = list.map(([l, h], i) => `<li class="${i === sel ? 'on' : ''}"><a href="${OH.esc(h)}">${OH.esc(l)}</a></li>`).join('') || '<li class="muted" style="padding:10px">No matches</li>';
  };
  const openPal = () => { if (!pal) return; pal.showModal(); $('input', pal).value = ''; sel = 0; renderPal(); $('input', pal).focus(); };
  pal?.querySelector('input').addEventListener('input', () => { sel = 0; renderPal(); });
  pal?.addEventListener('keydown', (e) => {
    const n = $$('li a', pal).length;
    if (e.key === 'ArrowDown') { sel = (sel + 1) % Math.max(1, n); renderPal(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { sel = (sel - 1 + n) % Math.max(1, n); renderPal(); e.preventDefault(); }
    if (e.key === 'Enter') { const a = $$('li a', pal)[sel]; if (a) location.href = a.getAttribute('href'); e.preventDefault(); }
  });
  document.addEventListener('click', (e) => { if (e.target.closest('[data-palette]')) openPal(); });

  // ── AI assistant (⌘J)
  const drawer = $('#ai-drawer');
  const toggleAI = (force) => { if (!drawer) return; const show = force ?? drawer.hidden; drawer.hidden = !show; if (show) $('textarea', drawer).focus(); };
  document.addEventListener('click', (e) => { if (e.target.closest('[data-ai]')) toggleAI(); if (e.target.closest('[data-ai-close]')) toggleAI(false); });
  const log = drawer && $('.ai-log', drawer);
  const addMsg = (who, text, actions) => {
    const d = document.createElement('div');
    d.className = 'ai-msg ' + who;
    d.textContent = text;
    if (actions?.length) {
      const a = document.createElement('div');
      a.className = 'ai-actions';
      for (const act of actions) {
        const b = document.createElement(act.href ? 'a' : 'button');
        b.className = 'btn btn-secondary btn-sm';
        b.textContent = act.label;
        if (act.href) b.href = act.href;
        else b.onclick = () => { navigator.clipboard.writeText(act.copy || text); OH.toast('Copied'); };
        a.appendChild(b);
      }
      d.appendChild(a);
    }
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  };
  OH.ask = async (q, context) => {
    const r = await OH.json('/app/ai', { q, path: location.pathname, context });
    return r;
  };
  drawer?.querySelector('.ai-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ta = $('textarea', drawer);
    const q = ta.value.trim();
    if (!q) return;
    ta.value = '';
    addMsg('me', q);
    const pending = addMsg('ai', 'Thinking…');
    try {
      const sel = window.getSelection()?.toString() || '';
      const r = await OH.ask(q, { selection: sel.slice(0, 4000), editor: window.OHEditor?.plainText?.().slice(0, 6000) });
      pending.remove();
      addMsg('ai', r.text || '(no answer)', [{ label: 'Copy' }, ...(r.actions || [])]);
      if (r.insert && window.OHEditor?.insertText) window.OHEditor.insertText(r.insert);
    } catch (err) { pending.textContent = 'Error: ' + err.message; }
  });
  drawer?.querySelector('textarea').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) drawer.querySelector('.ai-form').requestSubmit(); });

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return; // e.g. the editor already used ⌘K for a link
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); pal?.open ? pal.close() : openPal(); }
    if (mod && e.key.toLowerCase() === 'j') { e.preventDefault(); toggleAI(); }
  });

  // ── forms that submit via fetch and show a toast (data-ajax)
  document.addEventListener('submit', async (e) => {
    const f = e.target;
    if (!f.matches('form[data-ajax]')) return;
    e.preventDefault();
    const r = await fetch(f.action, { method: f.method || 'POST', body: new FormData(f), headers: { accept: 'application/json' }, credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    OH.toast(j.message || (r.ok ? 'Saved' : 'Error: ' + (j.error || r.status)));
    if (r.ok && f.dataset.ajax === 'reload') location.reload();
  });

  // ── local time rendering: <time data-local datetime="ISO">
  $$('time[data-local]').forEach((t) => { const d = new Date(t.getAttribute('datetime')); if (!isNaN(d)) t.textContent = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: t.dataset.local === 'date' ? undefined : 'short' }); });
  // datetime-local inputs: send UTC alongside (inputs with data-utc="fieldname")
  document.addEventListener('submit', (e) => {
    $$('input[type=datetime-local][data-utc]', e.target).forEach((i) => {
      let h = e.target.querySelector(`input[name="${i.dataset.utc}"]`);
      if (!h) { h = document.createElement('input'); h.type = 'hidden'; h.name = i.dataset.utc; e.target.appendChild(h); }
      h.value = i.value ? new Date(i.value).toISOString() : '';
    });
  }, true);
  // fill datetime-local inputs from UTC (data-utc-value="ISO")
  $$('input[type=datetime-local][data-utc-value]').forEach((i) => {
    const d = new Date(i.dataset.utcValue);
    if (!isNaN(d)) i.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
})();
