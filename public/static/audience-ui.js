// Audience module UI: bulk actions, live segment preview, AI segment builder, form designer autosave, survey builder.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const toast = (m) => (window.OH?.toast ? OH.toast(m) : console.log(m));

  // ── bulk actions: reveal the option inputs for the chosen action
  const act = $('[data-bulk-action]');
  if (act) {
    const sync = () => $$('.bulk-opt').forEach((el) => el.classList.toggle('hide', !el.classList.contains('bulk-' + act.value)));
    act.addEventListener('change', sync);
    sync();
    $('#bulk-form')?.addEventListener('submit', (e) => {
      const scope = e.target.querySelector('[name=scope]')?.value;
      if (scope === 'selected' && !$$('input[name="ids[]"]:checked', e.target).length) { e.preventDefault(); toast('Select at least one subscriber, or choose "All matching"'); }
    });
  }

  // ── segment editor: live count + sample
  const rulesEl = $('[data-rules][data-preview]');
  if (rulesEl) {
    const countEl = $('[data-seg-count]');
    const sampleEl = $('[data-seg-sample]');
    const preview = debounce(async () => {
      let rules;
      try { rules = JSON.parse($(rulesEl.dataset.rules).value); } catch { return; }
      if (countEl) countEl.textContent = 'Counting…';
      try {
        const r = await fetch(rulesEl.dataset.preview, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ rules }), credentials: 'same-origin' });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'error');
        if (countEl) countEl.innerHTML = `<strong>${j.count.toLocaleString()}</strong> active subscriber${j.count === 1 ? '' : 's'} match`;
        if (sampleEl) sampleEl.innerHTML = j.sample.length ? `<table class="table"><tbody>${j.sample.map((s) => `<tr><td><a href="/app/audience/s/${esc(s.id)}">${esc(s.email)}</a></td><td>${esc(s.name || '')}</td><td><span class="badge b-${s.tier === 'premium' ? 'purple' : 'gray'}">${esc(s.tier)}</span></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No active subscribers match these conditions.</p>';
      } catch (err) { if (countEl) countEl.textContent = err.message; }
    }, 400);
    rulesEl.addEventListener('rules:change', preview);
    preview();
  }

  // ── AI: describe a segment in plain English
  const aiBtn = $('[data-ai-describe-btn]');
  if (aiBtn) {
    aiBtn.addEventListener('click', async () => {
      const input = $('[data-ai-describe]');
      const text = input.value.trim();
      if (!text) return toast('Describe the audience first');
      aiBtn.disabled = true; aiBtn.textContent = 'Building…';
      try {
        const r = await fetch(input.dataset.aiDescribe, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ text }), credentials: 'same-origin' });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Failed');
        const container = $('[data-rules]');
        $(container.dataset.rules).value = JSON.stringify(j.rules);
        window.OHRules.mount(container);
        toast('Rules updated — review before saving');
      } catch (e) { toast(e.message); }
      aiBtn.disabled = false; aiBtn.textContent = 'Build rules';
    });
    $('[data-ai-describe]').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); aiBtn.click(); } });
  }

  // ── form designer: autosave draft + refresh preview
  const designer = $('form[data-autosave]');
  if (designer) {
    const frame = $(designer.dataset.preview);
    const status = $('[data-save-status]', designer);
    const save = debounce(async () => {
      status && (status.textContent = 'Saving…');
      try {
        const r = await fetch(designer.action, { method: 'POST', body: new FormData(designer), headers: { accept: 'application/json' }, credentials: 'same-origin' });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Save failed');
        status && (status.textContent = 'Draft saved' + (j.changed ? ' · publish to make it live' : ''));
        if (frame) frame.src = frame.src.split('#')[0].replace(/([?&])t=\d+/, '') + (frame.src.includes('?') ? '&' : '?') + 't=' + Date.now();
      } catch (e) { status && (status.textContent = e.message); }
    }, 600);
    designer.addEventListener('input', save);
    designer.addEventListener('change', save);
  }
  $$('[data-device]').forEach((box) => box.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-w]');
    if (!b) return;
    $$('button', box).forEach((x) => x.classList.toggle('on', x === b));
    const f = $(box.dataset.device);
    if (f) { f.style.width = b.dataset.w; f.style.margin = '0 auto'; f.style.display = 'block'; }
  }));
  // auto-height for preview iframes
  $$('iframe.preview-frame').forEach((f) => f.addEventListener('load', () => { try { f.style.height = Math.max(240, f.contentDocument.documentElement.scrollHeight + 10) + 'px'; } catch {} }));

  // ── survey builder
  const sb = $('[data-survey-builder]');
  if (sb) {
    const input = $(sb.dataset.surveyBuilder);
    const kinds = JSON.parse($('#survey-kinds').textContent);
    let qs;
    try { qs = JSON.parse(input.value || '[]'); } catch { qs = []; }
    const choice = (k) => ['single', 'multi', 'dropdown'].includes(k);
    const rid = () => Math.random().toString(36).slice(2, 8);
    const save = () => { input.value = JSON.stringify(qs); };
    const render = () => {
      sb.innerHTML = '';
      qs.forEach((q, i) => {
        const card = document.createElement('section');
        card.className = 'card survey-q';
        card.innerHTML = `<header class="card-h"><h3>Question ${i + 1}</h3><div class="card-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-up ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
            <button type="button" class="btn btn-ghost btn-sm" data-down ${i === qs.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
            <button type="button" class="btn btn-ghost btn-sm" data-dup title="Duplicate">⧉</button>
            <button type="button" class="btn btn-danger btn-sm" data-del title="Delete">✕</button></div></header>
          <div class="card-b">
            <label class="field"><span class="field-l">Question</span><input class="input" data-k="label" value="${esc(q.label)}" required></label>
            <div class="grid g2"><label class="field"><span class="field-l">Type</span><select class="input" data-k="kind">${kinds.map(([k, l]) => `<option value="${k}" ${k === q.kind ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
            <label class="check" style="align-self:end"><input type="checkbox" data-k="required" ${q.required ? 'checked' : ''}> <span>Required</span></label></div>
            ${choice(q.kind) ? `<label class="field"><span class="field-l">Options</span><textarea class="input" rows="4" data-k="options" placeholder="One option per line">${esc((q.options || []).join('\n'))}</textarea></label>` : ''}
          </div>`;
        card.addEventListener('input', (e) => {
          const k = e.target.dataset.k;
          if (k === 'label') q.label = e.target.value;
          if (k === 'options') q.options = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean);
          save();
        });
        card.addEventListener('change', (e) => {
          const k = e.target.dataset.k;
          if (k === 'kind') { q.kind = e.target.value; if (choice(q.kind) && !(q.options || []).length) q.options = ['Option 1', 'Option 2']; save(); render(); }
          if (k === 'required') { q.required = e.target.checked; save(); }
        });
        card.querySelector('[data-up]').onclick = () => { [qs[i - 1], qs[i]] = [qs[i], qs[i - 1]]; save(); render(); };
        card.querySelector('[data-down]').onclick = () => { [qs[i + 1], qs[i]] = [qs[i], qs[i + 1]]; save(); render(); };
        card.querySelector('[data-dup]').onclick = () => { qs.splice(i + 1, 0, { ...q, id: rid(), options: q.options ? [...q.options] : undefined }); save(); render(); };
        card.querySelector('[data-del]').onclick = () => { if (qs.length > 1 || confirm('Remove the last question?')) { qs.splice(i, 1); save(); render(); } };
        sb.appendChild(card);
      });
      const add = document.createElement('div');
      add.className = 'row';
      add.innerHTML = kinds.map(([k, l]) => `<button type="button" class="btn btn-secondary btn-sm" data-add="${k}">+ ${esc(l)}</button>`).join('');
      add.addEventListener('click', (e) => {
        const k = e.target.closest('[data-add]')?.dataset.add;
        if (!k) return;
        qs.push({ id: rid(), kind: k, label: '', options: choice(k) ? ['Option 1', 'Option 2'] : undefined, required: false });
        save(); render();
        sb.querySelectorAll('[data-k=label]')[qs.length - 1]?.focus();
      });
      sb.appendChild(add);
    };
    render();
  }

  // ── survey AI summary
  $$('form[data-ajax-summary]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = $('.ai-summary', f);
    const b = $('button', f);
    b.disabled = true; out.textContent = 'Summarizing…';
    try {
      const r = await fetch(f.action, { method: 'POST', headers: { accept: 'application/json' }, credentials: 'same-origin' });
      const j = await r.json();
      out.textContent = j.text || j.error || 'No summary';
    } catch (err) { out.textContent = err.message; }
    b.disabled = false;
  }));
})();
