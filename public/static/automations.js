// OpenHive visual automation builder.
// Reads #af-data ({trigger, steps}), #af-meta, #rule-catalog. Autosaves the draft via PUT /app/automations/:id/draft.

// ───────── “New automation” template gallery (automations list page) ─────────
(() => {
  const g = document.getElementById('af-gallery');
  if (!g) return;
  const cards = [...g.querySelectorAll('.af-gal-card')];
  const search = g.querySelector('[data-gal-search]');
  let cat = '';
  const filter = () => {
    const q = (search?.value || '').trim().toLowerCase();
    for (const c of cards) c.hidden = (cat && c.dataset.cat !== cat) || (q && !(c.dataset.q || '').includes(q));
  };
  const show = (key) => g.querySelectorAll('[data-preview]').forEach((pv) => { pv.hidden = pv.dataset.preview !== key; });
  g.querySelector('.af-gal-cats')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-gal-cat]');
    if (!b) return;
    cat = b.dataset.galCat;
    g.querySelectorAll('.af-gal-cats button').forEach((x) => x.classList.toggle('on', x === b));
    filter();
  });
  search?.addEventListener('input', filter);
  search?.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  g.addEventListener('change', (e) => { if (e.target.name === 'template') show(e.target.value); });
  cards.forEach((c) => c.addEventListener('mouseenter', () => show(c.querySelector('input').value)));
  g.querySelector('.af-gal-list')?.addEventListener('mouseleave', () => show(g.querySelector('input[name=template]:checked')?.value || ''));
  const pre = new URLSearchParams(location.search).get('template');
  if (pre) { const r = g.querySelector(`input[name=template][value="${CSS.escape(pre)}"]`); if (r) { r.checked = true; show(pre); document.getElementById('new-automation')?.showModal?.(); } }
})();

(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const canvas = $('#af-canvas');
  if (!canvas) return;
  const data = JSON.parse($('#af-data').textContent);
  const meta = JSON.parse($('#af-meta').textContent);
  const catalog = JSON.parse($('#rule-catalog').textContent);
  const panel = $('#af-panel');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => (window.OH?.toast ? OH.toast(m) : alert(m));
  const uid = () => Math.random().toString(36).slice(2, 12);
  const BRANCH = new Set(['condition', 'ab_split']);

  // Several entry points (OR): stored as {...first, triggers: [...]} — see lib/automations triggerList()
  const initialTriggers = (() => {
    const t = data.trigger || {};
    const list = Array.isArray(t.triggers) && t.triggers.length ? t.triggers : t.type ? [{ type: t.type, config: t.config || {}, ...(t.filter ? { filter: t.filter } : {}) }] : [];
    return list.length ? list : [{ type: 'welcome', config: {} }];
  })();
  const state = { triggers: initialTriggers, steps: Array.isArray(data.steps) ? data.steps : [] };
  let triggerIdx = 0;
  Object.defineProperty(state, 'trigger', { get: () => state.triggers[triggerIdx] || state.triggers[0] });
  let allowReentry = !!meta.allowReentry;
  let selected = 'trigger';
  const checked = new Set();
  let editor = null;
  let dirty = false, saving = null, saveTimer = null;

  const ICON = { send_email: '✉️', delay: '⏱️', wait_until: '⏳', condition: '🔀', ab_split: '🎲', add_tag: '🏷️', remove_tag: '🏷️', update_field: '✏️', add_to_list: '📋', remove_from_list: '📋', webhook: '🔗', enroll: '↪️', grant_premium: '⭐', notify: '🔔', unsubscribe: '🚫', exit: '⏹️' };
  const GROUPS = [
    ['Messages', ['send_email', 'notify']],
    ['Timing', ['delay', 'wait_until']],
    ['Logic', ['condition', 'ab_split']],
    ['Subscriber', ['add_tag', 'remove_tag', 'update_field', 'add_to_list', 'remove_from_list', 'grant_premium', 'unsubscribe']],
    ['Integrations & flow', ['webhook', 'enroll', 'exit']],
  ];
  const STEP_HELP = {
    send_email: 'Send an email built with the newsletter editor.', notify: 'Email a teammate when someone reaches this step.', delay: 'Wait a fixed amount of time.', wait_until: 'Wait for a date, a weekday/time, or a condition.',
    condition: 'Split into Yes / No paths using subscriber attributes, segments or behaviour.', ab_split: 'Randomly split subscribers between two paths.', add_tag: 'Add one or more tags.', remove_tag: 'Remove tags.',
    update_field: 'Set a custom field value.', add_to_list: 'Subscribe to a newsletter list.', remove_from_list: 'Unsubscribe from a list.', grant_premium: 'Give temporary premium access.', unsubscribe: 'Unsubscribe the subscriber.',
    webhook: 'Call your own system (retried automatically).', enroll: 'Start another automation.', exit: 'End the journey here.',
  };
  const DEFAULTS = {
    send_email: () => ({ subject: '', preview_text: '', doc: { blocks: [] } }), delay: () => ({ amount: 1, unit: 'days' }), wait_until: () => ({ mode: 'datetime' }),
    condition: () => ({ rules: { op: 'and', rules: [] } }), ab_split: () => ({ pct: 50 }), add_tag: () => ({ tags: [] }), remove_tag: () => ({ tags: [] }),
    update_field: () => ({ key: '', value: '' }), webhook: () => ({ url: '', method: 'POST', secret: '', body: '' }), grant_premium: () => ({ days: 7 }), notify: () => ({ email: meta.userEmail || '', subject: '', body: '' }),
  };
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // ───────── tree helpers ─────────
  function find(id, list = state.steps, key = 'root') {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.id === id) return { list, index: i, step: s, key };
      for (const b of ['yes', 'no']) if (s[b]) { const f = find(id, s[b], `${s.id}:${b}`); if (f) return f; }
    }
    return null;
  }
  function listByKey(key) {
    if (key === 'root') return state.steps;
    const [sid, b] = key.split(':');
    const f = find(sid);
    if (!f) return null;
    f.step[b] = f.step[b] || [];
    return f.step[b];
  }
  function contains(step, id) {
    for (const b of ['yes', 'no']) for (const s of step[b] || []) if (s.id === id || contains(s, id)) return true;
    return false;
  }
  function clone(step) {
    const c = JSON.parse(JSON.stringify(step));
    const reid = (s) => { s.id = uid(); for (const b of ['yes', 'no']) (s[b] || []).forEach(reid); };
    reid(c);
    return c;
  }
  const names = () => {
    const m = {};
    for (const k of ['list', 'segment', 'tier', 'product', 'event', 'post']) for (const [id, n] of catalog.options[k] || []) m[id] = n;
    for (const p of catalog.options.poll || []) m[p.id] = p.question;
    for (const s of catalog.options.survey || []) m[s.id] = s.title;
    for (const [id, n] of meta.automations || []) m[id] = n;
    for (const [id, n] of meta.forms || []) m[id] = n;
    return m;
  };
  const countRules = (g) => (!g || !Array.isArray(g.rules) ? 0 : g.rules.reduce((n, r) => n + (r.rules ? countRules(r) : 1), 0));

  function summary(s) {
    const c = s.config || {};
    const n = names();
    switch (s.type) {
      case 'send_email': return c.subject ? `“${c.subject}”` : 'No subject yet';
      case 'delay': return `${c.amount || 0} ${c.unit || 'days'}`;
      case 'wait_until': return c.mode === 'condition' ? `until ${countRules(c.rules)} condition(s) match (max ${c.timeout_days || 7}d)` : c.mode === 'weekday_time' ? `next ${(c.weekdays || []).map((d) => DAYS[d]).join('/') || 'day'} at ${c.time || '09:00'} UTC` : c.at ? `until ${new Date(c.at).toLocaleString()}` : 'until a date';
      case 'condition': return `${countRules(c.rules)} condition(s)`;
      case 'ab_split': return `${c.pct ?? 50}% A / ${100 - (c.pct ?? 50)}% B`;
      case 'add_tag': case 'remove_tag': return [].concat(c.tags || []).join(', ') || 'No tag chosen';
      case 'update_field': return c.key ? `${c.key} = ${c.value ?? ''}` : 'No field chosen';
      case 'add_to_list': case 'remove_from_list': return n[c.list_id] || 'No list chosen';
      case 'webhook': return c.url ? `${c.method || 'POST'} ${c.url}` : 'No URL';
      case 'enroll': return n[c.automation_id] || 'No automation chosen';
      case 'grant_premium': return `${c.days || 7} days`;
      case 'notify': return c.email || 'No recipient';
      case 'unsubscribe': return 'Unsubscribes the subscriber';
      case 'exit': return 'Ends the journey';
    }
    return '';
  }
  function triggerSummary(t = state.trigger) {
    const c = t.config || {}, n = names();
    if (t.type === 'webhook') return [c.tags?.length ? `tags: ${[].concat(c.tags).join(', ')}` : '', c.email_path ? `email at ${c.email_path}` : 'email detected automatically'].filter(Boolean).join(' · ');
    const bits = [];
    if (c.sources?.length) bits.push(c.sources.join(', '));
    if (t.type === 'custom_event') bits.push(c.name ? `event “${c.name}”` : 'any event');
    for (const k of ['tag', 'key', 'url_contains']) if (c[k]) bits.push(c[k]);
    for (const k of ['list_id', 'tier_id', 'product_id', 'event_id', 'survey_id', 'poll_id', 'post_id', 'segment_id']) if (c[k]) bits.push(n[c[k]] || c[k]);
    if (t.type === 'inactive') bits.push(`${c.days || 30} days`);
    if (t.type === 'date_field' && c.offset_days) bits.push(`${c.offset_days}d offset`);
    if (countRules(t.filter)) bits.push(`${countRules(t.filter)} audience filter(s)`);
    return bits.join(' · ') || 'Any subscriber';
  }
  const problems = (s) => {
    const c = s.config || {};
    if (s.type === 'send_email' && (!c.subject || !(c.doc?.blocks || []).length)) return 'Needs a subject and content';
    if (s.type === 'webhook' && !/^https?:\/\//.test(c.url || '')) return 'Needs a valid URL';
    if ((s.type === 'add_to_list' || s.type === 'remove_from_list') && !c.list_id) return 'Choose a list';
    if (s.type === 'enroll' && !c.automation_id) return 'Choose an automation';
    if ((s.type === 'add_tag' || s.type === 'remove_tag') && !(c.tags || []).length) return 'Add a tag';
    if (s.type === 'condition' && !countRules(c.rules)) return 'Add at least one condition';
    return '';
  };

  // ───────── canvas ─────────
  let dragId = null;
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  function render() {
    canvas.innerHTML = '';
    const entries = el('div', 'af-entries');
    state.triggers.forEach((tr, i) => {
      if (i) entries.append(el('span', 'af-or', 'OR'));
      const multi = state.triggers.length > 1;
      const t = el('div', 'af-card af-trigger' + (selected === 'trigger' && triggerIdx === i ? ' on' : ''), `<span class="af-ic">${tr.type === 'webhook' ? '🔌' : '⚡'}</span><div class="af-body"><div class="af-kicker">${multi ? `Entry point ${i + 1}` : 'Trigger'}</div><strong>${esc(meta.triggers[tr.type]?.label || 'Choose a trigger')}</strong><div class="af-sum">${esc(triggerSummary(tr))}</div></div>`);
      t.tabIndex = 0;
      t.dataset.entry = String(i);
      t.onclick = () => { triggerIdx = i; select('trigger'); };
      entries.append(t);
    });
    const add = el('button', 'af-add-entry', '+ Add another entry point');
    add.type = 'button';
    add.title = 'Subscribers enter when ANY entry point matches';
    add.onclick = () => { state.triggers.push({ type: 'tag_added', config: {} }); triggerIdx = state.triggers.length - 1; selected = 'trigger'; changed(); renderPanel(); };
    entries.append(add);
    canvas.append(entries, renderList(state.steps, 'root'), el('div', 'af-end', 'End of automation'));
    updateBulk();
  }

  function renderList(list, key) {
    const wrap = el('div', 'af-list');
    list.forEach((s, i) => { wrap.append(adder(key, i)); wrap.append(stepNode(s, key)); });
    wrap.append(adder(key, list.length));
    return wrap;
  }

  function adder(key, index) {
    const a = el('div', 'af-add');
    const b = el('button', 'af-plus', '+');
    b.type = 'button';
    b.title = 'Add a step here';
    b.onclick = (e) => { e.stopPropagation(); openPicker(key, index); };
    a.append(el('span', 'af-line'), b, el('span', 'af-line'));
    a.addEventListener('dragover', (e) => { if (dragId) { e.preventDefault(); a.classList.add('drop'); } });
    a.addEventListener('dragleave', () => a.classList.remove('drop'));
    a.addEventListener('drop', (e) => { e.preventDefault(); a.classList.remove('drop'); if (dragId) moveStep(dragId, key, index); dragId = null; });
    return a;
  }

  function stepNode(s, key) {
    const node = el('div', 'af-node');
    const warn = problems(s);
    const card = el('div', `af-card af-t-${s.type}` + (selected === s.id ? ' on' : '') + (checked.has(s.id) ? ' checked' : ''),
      `<input type="checkbox" class="af-check" title="Select for bulk actions" ${checked.has(s.id) ? 'checked' : ''}>` +
      `<span class="af-ic">${ICON[s.type] || '•'}</span><div class="af-body"><div class="af-kicker">${esc(meta.stepTypes[s.type] || s.type)}</div><div class="af-sum">${esc(summary(s))}</div>${warn ? `<div class="af-warn">⚠ ${esc(warn)}</div>` : ''}</div>` +
      `<span class="af-tools"><button type="button" data-act="dup" title="Duplicate">⧉</button><button type="button" data-act="del" title="Delete">✕</button></span>`);
    card.draggable = true;
    card.tabIndex = 0;
    card.dataset.id = s.id;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.af-check')) return;
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'dup') return duplicateStep(s.id);
      if (act === 'del') return deleteStep(s.id);
      select(s.id);
    });
    card.querySelector('.af-check').addEventListener('change', (e) => { e.target.checked ? checked.add(s.id) : checked.delete(s.id); render(); });
    card.addEventListener('dragstart', (e) => { dragId = s.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.id); card.classList.add('dragging'); });
    card.addEventListener('dragend', () => { dragId = null; card.classList.remove('dragging'); });
    node.append(card);
    if (BRANCH.has(s.type)) {
      const br = el('div', 'af-branches');
      const labels = s.type === 'ab_split' ? [`Path A · ${s.config?.pct ?? 50}%`, `Path B · ${100 - (s.config?.pct ?? 50)}%`] : ['Yes', 'No'];
      ['yes', 'no'].forEach((b, i) => {
        s[b] = s[b] || [];
        const col = el('div', `af-branch af-branch-${b}`);
        col.append(el('div', 'af-branch-label', esc(labels[i])), renderList(s[b], `${s.id}:${b}`));
        br.append(col);
      });
      node.append(br);
    }
    return node;
  }

  // ───────── mutations ─────────
  function changed(opts = {}) {
    dirty = true;
    setSave('Unsaved changes…');
    if (opts.render !== false) render();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 700);
  }

  function insertStep(key, index, type) {
    const list = listByKey(key);
    if (!list) return;
    const s = { id: uid(), type, config: (DEFAULTS[type] || (() => ({})))() };
    if (BRANCH.has(type)) { s.yes = []; s.no = []; }
    list.splice(index, 0, s);
    selected = s.id;
    changed();
    renderPanel();
  }

  function moveStep(id, key, index) {
    const src = find(id);
    const target = listByKey(key);
    if (!src || !target) return;
    if (key !== 'root') {
      const owner = key.split(':')[0];
      if (owner === id || contains(src.step, owner)) return toast("Can't move a step inside itself");
    }
    if (src.list === target && src.index < index) index--;
    src.list.splice(src.index, 1);
    target.splice(index, 0, src.step);
    changed();
  }

  function duplicateStep(id) {
    const f = find(id);
    if (!f) return;
    const c = clone(f.step);
    f.list.splice(f.index + 1, 0, c);
    selected = c.id;
    changed();
    renderPanel();
  }

  function deleteStep(id) {
    const f = find(id);
    if (!f) return;
    const n = (f.step.yes?.length || 0) + (f.step.no?.length || 0);
    if (!confirm(n ? `Delete this step and the ${n} step(s) inside its branches?` : 'Delete this step?')) return;
    f.list.splice(f.index, 1);
    checked.delete(id);
    if (selected === id || !find(selected)) selected = 'trigger';
    changed();
    renderPanel();
  }

  // ───────── bulk reorder ─────────
  const bulk = $('#af-bulk');
  function selection() {
    const items = [...checked].map((id) => find(id)).filter(Boolean);
    if (!items.length) return null;
    const list = items[0].list;
    if (items.some((x) => x.list !== list)) return { error: 'Select steps from the same path to move them together.' };
    return { list, idx: items.map((x) => x.index).sort((a, b) => a - b) };
  }
  function updateBulk() {
    if (!bulk) return;
    bulk.hidden = checked.size === 0;
    $('#af-bulk-count').textContent = `${checked.size} selected`;
  }
  bulk?.addEventListener('click', (e) => {
    const act = e.target.closest('[data-bulk]')?.dataset.bulk;
    if (!act) return;
    if (act === 'clear') { checked.clear(); return render(); }
    const sel = selection();
    if (!sel) return;
    if (sel.error) return toast(sel.error);
    const { list, idx } = sel;
    if (act === 'up') {
      for (const i of idx) if (i > 0 && !idx.includes(i - 1)) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; idx[idx.indexOf(i)] = i - 1; }
    } else if (act === 'down') {
      for (const i of [...idx].reverse()) if (i < list.length - 1 && !idx.includes(i + 1)) { [list[i + 1], list[i]] = [list[i], list[i + 1]]; idx[idx.indexOf(i)] = i + 1; }
    } else if (act === 'to') {
      const pos = parseInt($('#af-bulk-pos').value, 10);
      if (!pos) return toast('Enter a position number');
      const moving = idx.map((i) => list[i]);
      for (const i of [...idx].reverse()) list.splice(i, 1);
      list.splice(Math.max(0, Math.min(pos - 1, list.length)), 0, ...moving);
    } else if (act === 'delete') {
      if (!confirm(`Delete ${idx.length} step(s) and anything inside their branches?`)) return;
      for (const i of [...idx].reverse()) list.splice(i, 1);
      checked.clear();
      if (!find(selected)) selected = 'trigger';
      renderPanel();
    }
    changed();
  });

  // ───────── step picker ─────────
  const picker = $('#af-picker');
  let pickTarget = null;
  function openPicker(key, index) {
    pickTarget = { key, index };
    $('#af-picker-body').innerHTML = GROUPS.map(([g, types]) => `<div class="af-pick-group"><div class="field-l">${g}</div><div class="af-pick-grid">${types.map((t) => `<button type="button" class="af-pick" data-type="${t}"><span class="af-ic">${ICON[t]}</span><span><strong>${esc(meta.stepTypes[t])}</strong><small>${esc(STEP_HELP[t] || '')}</small></span></button>`).join('')}</div></div>`).join('');
    picker.showModal();
  }
  picker?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-type]');
    if (!b || !pickTarget) return;
    picker.close();
    insertStep(pickTarget.key, pickTarget.index, b.dataset.type);
  });

  // ───────── side panel ─────────
  function select(id) {
    selected = id;
    render();
    renderPanel();
    if (innerWidth < 1100) panel.scrollIntoView({ behavior: 'smooth' });
  }

  const F = {
    field(label, input, hint) {
      const w = el('label', 'field');
      w.append(el('span', 'field-l', esc(label)));
      w.append(input);
      if (hint) w.append(el('small', 'field-h', hint));
      return w;
    },
    input(obj, key, attrs = {}, cast) {
      const i = el('input', 'input');
      Object.assign(i, attrs);
      i.value = obj[key] ?? '';
      i.addEventListener('input', () => { obj[key] = cast ? cast(i.value) : i.value; changed(); });
      return i;
    },
    number(obj, key, attrs = {}) { return F.input(obj, key, { type: 'number', ...attrs }, (v) => (v === '' ? '' : Number(v))); },
    textarea(obj, key, rows = 4, attrs = {}) {
      const t = el('textarea', 'input');
      t.rows = rows;
      Object.assign(t, attrs);
      t.value = obj[key] ?? '';
      t.addEventListener('input', () => { obj[key] = t.value; changed(); });
      return t;
    },
    select(obj, key, options, empty) {
      const s = el('select', 'input');
      const opts = (empty !== undefined ? [['', empty]] : []).concat(options.map((o) => (Array.isArray(o) ? o : [o, o])));
      s.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}" ${String(obj[key] ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('');
      s.addEventListener('change', () => { obj[key] = s.value; changed(); });
      return s;
    },
    rules(obj, key, label, hint) {
      const wrap = el('div', 'field');
      wrap.append(el('span', 'field-l', esc(label)));
      const hid = 'r' + uid();
      const input = el('input');
      input.type = 'hidden';
      input.id = hid;
      input.value = JSON.stringify(obj[key] && obj[key].rules ? obj[key] : { op: 'and', rules: [] });
      const box = el('div');
      box.dataset.rules = '#' + hid;
      box.dataset.catalog = '#rule-catalog';
      wrap.append(input, box);
      if (hint) wrap.append(el('small', 'field-h', hint));
      setTimeout(() => {
        if (!window.OHRules) { box.textContent = 'Rule builder failed to load.'; return; }
        window.OHRules.mount(box);
        box.addEventListener('rules:change', (e) => { obj[key] = e.detail; changed(); });
      });
      return wrap;
    },
    note(html, cls = 'callout') { return el('div', cls, html); },
  };

  function renderPanel() {
    if (editor?.destroy) try { editor.destroy(); } catch {}
    editor = null;
    panel.innerHTML = '';
    if (selected === 'trigger') return triggerPanel();
    const f = find(selected);
    if (!f) { selected = 'trigger'; return triggerPanel(); }
    stepPanel(f.step);
  }

  const TRIGGER_FIELDS = {
    signup: (c) => [checkGroup(c, 'sources', catalogSources(), 'Only when the signup source is', 'Leave empty for every signup. “magic_link” = one-click subscribe links.'), multi(c, 'source_details', meta.forms, 'Only from these forms')],
    tag_added: (c) => [F.field('Tag', withList(F.input(c, 'tag', { placeholder: 'e.g. vip' }), catalog.options.tag), 'Leave empty for any tag.')],
    field_updated: (c) => [F.field('Custom field', F.select(c, 'key', (catalog.options.custom || []).map((x) => [x.key, x.label]), 'Any field'))],
    list_subscribed: (c) => [F.field('List', F.select(c, 'list_id', catalog.options.list || [], 'Any list'))],
    upgraded: (c) => [F.field('Paid tier', F.select(c, 'tier_id', catalog.options.tier || [], 'Any tier'))],
    purchase: (c) => [F.field('Product', F.select(c, 'product_id', catalog.options.product || [], 'Any product'))],
    event_registered: (c) => [F.field('Event', F.select(c, 'event_id', catalog.options.event || [], 'Any event'))],
    survey_submitted: (c) => [F.field('Survey', F.select(c, 'survey_id', (catalog.options.survey || []).map((s) => [s.id, s.title]), 'Any survey'))],
    poll_voted: (c) => [F.field('Poll', F.select(c, 'poll_id', (catalog.options.poll || []).map((p) => [p.id, p.question]), 'Any poll'))],
    email_opened: (c) => [F.field('Post', F.select(c, 'post_id', catalog.options.post || [], 'Any email'))],
    link_clicked: (c) => [F.field('Post', F.select(c, 'post_id', catalog.options.post || [], 'Any email')), F.field('Link URL contains', F.input(c, 'url_contains', { placeholder: 'e.g. /pricing' }))],
    segment_entered: (c) => [F.field('Segment', F.select(c, 'segment_id', catalog.options.segment || [], 'Choose a segment…'), 'Checked every 15 minutes; subscribers enter once when they join the segment.')],
    date_field: (c) => [F.field('Date field', F.select(c, 'key', (catalog.options.custom || []).map((x) => [x.key, x.label]), 'Choose a field…'), 'Field values like 1990-05-21. Runs yearly on the anniversary.'), F.field('Offset (days)', F.number(c, 'offset_days'), 'Negative = before the date, positive = after.')],
    inactive: (c) => [F.field('Days without opening', F.number(c, 'days', { min: 1, placeholder: '30' }))],
    external_purchase: (c) => [F.field('Store', F.select(c, 'platform', [['shopify', 'Shopify'], ['woocommerce', 'WooCommerce'], ['stripe', 'Stripe']], 'Any store')), F.field('Product name contains (or product id)', F.input(c, 'product_contains', { placeholder: 'e.g. Hoodie' })), F.field('Minimum order total', F.number(c, 'min_total', { min: 0, placeholder: '0' }))],
    cart_abandoned: (c) => [F.field('Wait (hours) after the checkout was last updated', F.number(c, 'delay_hours', { min: 0.25, step: 0.25, placeholder: '1' }), 'Only subscribers are emailed. The journey stops as soon as the order completes.'), F.field('Minimum cart value', F.number(c, 'min_value', { min: 0, placeholder: '0' })), F.note('Use {{cart.items}}, {{cart.total}} and a button linking to {{cart.recovery_url}} in your emails.')],
    custom_event: (c) => [F.field('Event name', F.input(c, 'name', { placeholder: 'e.g. trial_started' }), 'Sent with POST /api/v2/publication/events. Leave empty for any event.'), F.field('Only when properties match (optional)', F.textarea(c, 'properties', 3, { placeholder: 'plan = pro\namount >= 100\nsku contains HOOD' }), 'One per line: key = value, != , > , >= , < , <= , contains, exists. Dots reach nested keys.')],
    api: () => [F.note(`Enroll subscribers from your app:<br><code>POST ${esc(meta.apiUrl)}</code><br><span class="small">Body: {"email": "reader@example.com"}. Authorization: Bearer &lt;API key&gt;.</span>`)],
    webhook: (c) => webhookFields(c),
  };

  // ───────── incoming webhook entry point ─────────
  const SNIPPETS = {
    Calendly: (u) => `<ol><li>Create a webhook subscription for <b>invitee.created</b> (Calendly API or an integration like Zapier).</li><li>Calendly sends the invitee as <code>payload.email</code> / <code>payload.name</code> / <code>payload.timezone</code> — detected automatically, and the time zone is saved for delivery by time zone.</li></ol><pre>curl -X POST https://api.calendly.com/webhook_subscriptions \\
  -H "Authorization: Bearer $CALENDLY_TOKEN" -H "Content-Type: application/json" \\
  -d '{"url": "${u}", "events": ["invitee.created"],
       "organization": "https://api.calendly.com/organizations/YOUR_ORG", "scope": "organization"}'</pre>`,
    Typeform: () => `<ol><li>In your form: <b>Connect → Webhooks → Add a webhook</b>, paste the URL and switch it on.</li><li>The email answer inside <code>form_response.answers</code> is found automatically. Map other answers with “Custom fields” below, e.g. <code>company = form_response.hidden.company</code>.</li></ol>`,
    Thinkific: () => `<ol><li><b>Settings → Code &amp; analytics → Webhooks → New webhook</b>.</li><li>Pick a topic such as <b>User signup</b>, <b>Enrollment created</b> or <b>Order created</b> and paste the URL.</li><li>The student email (<code>payload.email</code> or <code>payload.user.email</code>) is detected automatically.</li></ol>`,
    Kajabi: () => `<ol><li>Use Kajabi's outbound webhook for a Form or Offer (or Zapier's Kajabi trigger) and paste the URL.</li><li>The member's email is detected automatically; set “Email field” below if your payload has several emails.</li></ol>`,
    Zapier: (u) => `<ol><li>Add an action: <b>Webhooks by Zapier → POST</b>.</li><li>URL: <code>${u}</code> · Payload type: <b>JSON</b>.</li><li>Data: <code>email</code>, <code>name</code> and any extra fields (map them below).</li></ol>`,
    Make: (u) => `<ol><li>Add <b>HTTP → Make a request</b>, method <b>POST</b>, URL <code>${u}</code>.</li><li>Body type <b>Raw</b>, content type <b>JSON</b>: <code>{"email": "{{1.email}}", "name": "{{1.name}}"}</code></li></ol>`,
    n8n: (u) => `<ol><li>Add an <b>HTTP Request</b> node: method <b>POST</b>, URL <code>${u}</code>.</li><li>Send body → JSON: <code>{"email": "={{$json.email}}"}</code></li></ol>`,
    cURL: (u) => `<pre>curl -X POST '${u}' \\
  -H 'Content-Type: application/json' \\
  -d '{"email": "reader@example.com", "name": "Ada", "data": {"plan": "pro"}}'</pre><p class="small">Responses: 202 enrolled · 409 automation not active / not published · 422 no email found · 429 rate limited (120/min).</p>`,
  };
  let snipOpen = 'Calendly';
  function webhookFields(c) {
    const out = [];
    const urlBox = el('div', 'af-hook-url');
    const inp = el('input', 'input');
    inp.readOnly = true;
    inp.value = meta.webhookUrl;
    inp.setAttribute('aria-label', 'Webhook URL');
    const copy = el('button', 'btn btn-secondary btn-sm', 'Copy');
    copy.type = 'button';
    copy.onclick = () => { navigator.clipboard?.writeText(inp.value).then(() => toast('Webhook URL copied'), () => { inp.select(); document.execCommand('copy'); }); };
    urlBox.append(inp, copy);
    out.push(F.field('Your secret webhook URL', urlBox, 'Anyone with this URL can add subscribers to this automation — keep it private.'));
    if (!meta.webhookLive) out.push(F.note(meta.status === 'active' ? 'Publish your changes to start accepting webhook requests.' : 'Activate this automation to start accepting webhook requests (until then the URL answers 409).', 'callout warn'));
    out.push(F.field('Email field (JSON path)', F.input(c, 'email_path', { placeholder: 'Auto: ' + (meta.emailPaths || []).slice(0, 4).join(', ') + '…' }), 'Leave empty to detect it. Use dots and [0] for nesting, e.g. payload.invitee.email. Several paths: separate with commas.'));
    out.push(F.field('Name field (JSON path)', F.input(c, 'name_path', { placeholder: 'Auto: name, payload.name, first_name…' })));
    const tagsIn = el('input', 'input');
    tagsIn.value = [].concat(c.tags || []).join(', ');
    tagsIn.placeholder = 'e.g. calendly, booked-call';
    tagsIn.addEventListener('input', () => { c.tags = tagsIn.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean); changed(); });
    out.push(F.field('Add tags', withList(tagsIn, catalog.options.tag), 'Added to every subscriber who comes in through this webhook.'));
    out.push(F.field('Custom fields', F.textarea(c, 'field_map', 3, { placeholder: 'company = payload.questions_and_answers[0].answer\nplan = data.plan' }), 'One per line: custom_field_key = json.path'));
    const dbl = el('label', 'toggle', `<input type="checkbox" ${c.double_opt_in ? 'checked' : ''}><span class="toggle-ui"></span><span>Require email confirmation<small class="field-h">Off: people from the integration are subscribed right away (they gave you their email there).</small></span>`);
    dbl.querySelector('input').addEventListener('change', (e) => { c.double_opt_in = e.target.checked || undefined; changed({ render: false }); });
    out.push(dbl);
    const snip = el('div', 'field');
    snip.append(el('span', 'field-l', 'Setup guides'));
    const tabs = el('div', 'af-snips');
    const body = el('div', 'af-snip');
    const draw = () => { tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.k === snipOpen)); body.innerHTML = SNIPPETS[snipOpen](esc(inp.value)); };
    for (const k of Object.keys(SNIPPETS)) { const b = el('button', null, k); b.type = 'button'; b.dataset.k = k; b.onclick = () => { snipOpen = k; draw(); }; tabs.append(b); }
    snip.append(tabs, body);
    draw();
    out.push(snip);
    const row = el('div', 'row');
    const test = el('button', 'btn btn-secondary btn-sm', 'Send a test request');
    test.type = 'button';
    test.title = `Posts {"email": "${meta.userEmail}"} to the URL`;
    test.onclick = async () => {
      try {
        const r = await fetch(inp.value.replace(/^https?:\/\/[^/]+/, ''), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: meta.userEmail, name: 'Webhook test', source: 'openhive-test' }) });
        const j = await r.json().catch(() => ({}));
        toast(r.ok ? `Test accepted (${r.status}) — ${j.enrolled ? 'enrolled' : j.reason || 'not enrolled'}` : `${r.status}: ${j.message || j.error || 'failed'}`);
      } catch (e) { toast('Test failed: ' + e.message); }
    };
    row.append(test);
    if (meta.canPublish) {
      const rot = el('button', 'btn btn-ghost btn-sm', 'Regenerate URL');
      rot.type = 'button';
      rot.onclick = async () => {
        if (!confirm('Create a new secret URL? The current one stops working immediately — update your integrations.')) return;
        try { const r = await OH.json(`/app/automations/${meta.id}/webhook/rotate`, {}); meta.webhookUrl = r.url; inp.value = r.url; draw(); toast('New webhook URL created'); } catch (e) { toast(e.message); }
      };
      row.append(rot);
    }
    out.push(row);
    return out;
  }
  function catalogSources() { return (meta.sources || []).map((s) => [s, s.replace(/_/g, ' ')]); }
  function withList(input, opts) {
    const id = 'dl' + uid();
    input.setAttribute('list', id);
    const dl = el('datalist');
    dl.id = id;
    dl.innerHTML = (opts || []).map((t) => `<option value="${esc(t)}">`).join('');
    const w = el('div');
    w.append(input, dl);
    return w;
  }
  function checkGroup(obj, key, options, label, hint) {
    const w = el('div', 'field');
    w.append(el('span', 'field-l', esc(label)));
    const g = el('div', 'af-checks');
    const cur = new Set(obj[key] || []);
    for (const [v, l] of options) {
      const lab = el('label', 'check', `<input type="checkbox" value="${esc(v)}" ${cur.has(v) ? 'checked' : ''}><span>${esc(l)}</span>`);
      lab.querySelector('input').addEventListener('change', (e) => { e.target.checked ? cur.add(v) : cur.delete(v); obj[key] = [...cur]; if (!obj[key].length) delete obj[key]; changed(); });
      g.append(lab);
    }
    w.append(g);
    if (hint) w.append(el('small', 'field-h', hint));
    return w;
  }
  function multi(obj, key, options, label) {
    if (!options?.length) return el('span');
    const s = el('select', 'input');
    s.multiple = true;
    const cur = new Set(obj[key] || []);
    s.innerHTML = options.map(([v, l]) => `<option value="${esc(v)}" ${cur.has(v) ? 'selected' : ''}>${esc(l)}</option>`).join('');
    s.addEventListener('change', () => { obj[key] = [...s.selectedOptions].map((o) => o.value); if (!obj[key].length) delete obj[key]; changed(); });
    return F.field(label, s, 'Hold ⌘/Ctrl to choose several. Leave empty for all.');
  }

  function triggerPanel() {
    if (triggerIdx >= state.triggers.length) triggerIdx = 0;
    const t = state.trigger;
    t.config = t.config || {};
    const multi = state.triggers.length > 1;
    const h = el('div', 'af-panel-h', `<span class="af-ic">⚡</span><div><div class="af-kicker">${multi ? `Entry point ${triggerIdx + 1} of ${state.triggers.length}` : 'Trigger'}</div><strong>When should subscribers enter?</strong></div>${multi ? '<span class="af-panel-tools"><button type="button" class="btn btn-danger btn-sm" data-act="rm-entry">Remove</button></span>' : ''}`);
    h.querySelector('[data-act=rm-entry]')?.addEventListener('click', () => { state.triggers.splice(triggerIdx, 1); triggerIdx = 0; changed(); renderPanel(); });
    panel.append(h);
    if (multi) panel.append(el('p', 'help', 'Subscribers enter when <b>any</b> entry point matches (each subscriber enters once unless re-entry is on).'));
    const sel = el('select', 'input');
    sel.innerHTML = Object.entries(meta.triggers).map(([k, d]) => `<option value="${k}" ${k === t.type ? 'selected' : ''}>${esc(d.label)}</option>`).join('');
    sel.addEventListener('change', () => { t.type = sel.value; t.config = {}; changed(); renderPanel(); });
    panel.append(F.field(multi ? 'Entry point' : 'Trigger', sel));
    for (const node of (TRIGGER_FIELDS[t.type] || (() => []))(t.config)) panel.append(node);
    panel.append(F.rules(t, 'filter', 'Audience filter (optional)', 'Only subscribers matching these conditions enter. Leave empty for everyone.'));
    const re = el('label', 'toggle', `<input type="checkbox" ${allowReentry ? 'checked' : ''}><span class="toggle-ui"></span><span>Allow re-entry<small class="field-h">Let subscribers go through this automation more than once.</small></span>`);
    re.querySelector('input').addEventListener('change', (e) => { allowReentry = e.target.checked; changed({ render: false }); });
    panel.append(re);
  }

  function docToText(doc) {
    return (doc?.blocks || []).map((b) => (b.data?.html || (b.data?.items || []).join('\n') || b.data?.label || '').replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')).filter(Boolean).join('\n\n');
  }
  function textToDoc(text) {
    return { blocks: text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => ({ id: uid(), type: 'paragraph', data: { html: esc(p).replace(/\n/g, '<br>') } })) };
  }

  function stepPanel(s) {
    const c = (s.config = s.config || {});
    const h = el('div', 'af-panel-h', `<span class="af-ic">${ICON[s.type] || '•'}</span><div><div class="af-kicker">Step</div><strong>${esc(meta.stepTypes[s.type])}</strong></div><span class="af-panel-tools"><button type="button" class="btn btn-ghost btn-sm" data-act="dup">Duplicate</button><button type="button" class="btn btn-danger btn-sm" data-act="del">Delete</button></span>`);
    h.querySelector('[data-act=dup]').onclick = () => duplicateStep(s.id);
    h.querySelector('[data-act=del]').onclick = () => deleteStep(s.id);
    panel.append(h);
    if (STEP_HELP[s.type]) panel.append(el('p', 'help', esc(STEP_HELP[s.type])));
    switch (s.type) {
      case 'send_email': {
        panel.append(F.field('Subject line', F.input(c, 'subject', { placeholder: 'Welcome to {{publication.name}}' }), 'Merge tags like {{subscriber.first_name|there}} work here.'));
        panel.append(F.field('Preview text', F.input(c, 'preview_text', { placeholder: 'Shown after the subject in the inbox' })));
        panel.append(F.field('Heading (optional)', F.input(c, 'title', { placeholder: 'Shown as the email title' })));
        panel.append(F.field('From', F.select(c, 'sender_id', (meta.senders || []).map((x) => [x.id, `${x.name || ''} <${x.email}> · ${x.purpose}`]), 'Default automations sender')));
        const design = el('div', 'af-design', `<span class="field-l">Design</span><div class="row between" style="gap:6px;flex-wrap:wrap"><span class="small ${c.template_name ? '' : 'muted'}">${c.template_name ? `Template: <strong>${esc(c.template_name)}</strong>${c.style && Object.keys(c.style).length ? ' · custom colors & fonts' : ''}` : 'Publication default style'}</span><span class="row" style="gap:6px"><button type="button" class="btn btn-secondary btn-sm" data-a="tpl">Start from template</button>${c.style && Object.keys(c.style).length ? '<button type="button" class="btn btn-ghost btn-sm" data-a="unstyle">Use default style</button>' : ''}</span></div>`);
        design.querySelector('[data-a=tpl]').onclick = () => pickTemplate(c);
        const un = design.querySelector('[data-a=unstyle]');
        if (un) un.onclick = () => { delete c.style; delete c.template_id; delete c.template_name; changed({ render: false }); renderPanel(); };
        panel.append(design);
        const box = el('div', 'af-email-editor');
        panel.append(el('span', 'field-l', 'Content'), box);
        if (window.OHEditor?.mount) {
          try {
            editor = window.OHEditor.mount(box, { doc: c.doc || { blocks: [] }, compact: true, features: { paywall: false, collab: false, dynamic: true, polls: true, ai: true }, catalog, onChange(doc) { c.doc = doc; changed({ render: false }); clearTimeout(renderTimer); renderTimer = setTimeout(render, 600); } });
          } catch (e) { editor = null; box.innerHTML = ''; }
        }
        if (!editor) {
          const ta = el('textarea', 'input');
          ta.rows = 10;
          ta.placeholder = 'Write your email. Separate paragraphs with a blank line.';
          ta.value = docToText(c.doc);
          const complex = (c.doc?.blocks || []).some((b) => !['paragraph', 'heading'].includes(b.type));
          ta.addEventListener('input', () => { c.doc = textToDoc(ta.value); changed({ render: false }); clearTimeout(renderTimer); renderTimer = setTimeout(render, 600); });
          box.append(ta);
          if (complex) box.append(el('small', 'field-h', 'This email contains rich blocks; editing here replaces them with plain paragraphs.'));
        }
        const actions = el('div', 'row', `<button type="button" class="btn btn-secondary btn-sm" data-a="preview">Preview</button><button type="button" class="btn btn-secondary btn-sm" data-a="test">Send test</button>`);
        actions.querySelector('[data-a=preview]').onclick = () => preview(c);
        actions.querySelector('[data-a=test]').onclick = () => testSend(c);
        panel.append(actions);
        break;
      }
      case 'delay': {
        const row = el('div', 'row');
        row.append(F.number(c, 'amount', { min: 0, style: 'width:110px' }), F.select(c, 'unit', [['minutes', 'minutes'], ['hours', 'hours'], ['days', 'days'], ['weeks', 'weeks']]));
        panel.append(F.field('Wait for', row));
        break;
      }
      case 'wait_until': {
        const modeSel = F.select(c, 'mode', [['datetime', 'A specific date and time'], ['weekday_time', 'A day of the week and time'], ['condition', 'A condition is met']]);
        modeSel.addEventListener('change', () => renderPanel());
        panel.append(F.field('Wait until', modeSel));
        if ((c.mode || 'datetime') === 'datetime') {
          const i = el('input', 'input');
          i.type = 'datetime-local';
          if (c.at) { const d = new Date(c.at); if (!isNaN(d)) i.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
          i.addEventListener('change', () => { c.at = i.value ? new Date(i.value).toISOString() : ''; changed(); });
          panel.append(F.field('Date & time (your local time)', i, 'If the date has passed, subscribers continue immediately.'));
        } else if (c.mode === 'weekday_time') {
          panel.append(checkGroup(c, 'weekdays', DAYS.map((d, i) => [i, d]), 'On', 'Leave empty for the next day at that time.'));
          c.weekdays = (c.weekdays || []).map(Number);
          c.time = c.time || '09:00';
          panel.append(F.field('At (UTC)', F.input(c, 'time', { type: 'time' })));
        } else {
          panel.append(F.rules(c, 'rules', 'Continue when the subscriber matches', 'Checked hourly.'));
          panel.append(F.field('Give up after (days)', F.number(c, 'timeout_days', { min: 1, placeholder: '7' }), 'After this, the subscriber continues anyway.'));
        }
        break;
      }
      case 'condition':
        panel.append(F.rules(c, 'rules', 'Subscribers who match go down the “Yes” path', 'Use attributes, tags, segments, reusable condition sets, engagement, purchases or whether another automation started.'));
        break;
      case 'ab_split': {
        const r = el('input');
        r.type = 'range'; r.min = 1; r.max = 99; r.value = c.pct ?? 50; r.style.width = '100%';
        const out = el('div', 'muted small', `${r.value}% path A / ${100 - r.value}% path B`);
        r.addEventListener('input', () => { c.pct = Number(r.value); out.textContent = `${r.value}% path A / ${100 - r.value}% path B`; changed(); });
        panel.append(F.field('Split', r), out);
        break;
      }
      case 'add_tag': case 'remove_tag': {
        const i = el('input', 'input');
        i.value = (c.tags || []).join(', ');
        i.placeholder = 'tag-one, tag-two';
        i.addEventListener('input', () => { c.tags = i.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean); changed(); });
        panel.append(F.field('Tags', withList(i, catalog.options.tag), 'Separate several tags with commas.'));
        break;
      }
      case 'update_field': {
        const fields = catalog.options.custom || [];
        panel.append(F.field('Field', fields.length ? F.select(c, 'key', fields.map((x) => [x.key, x.label]), 'Choose a field…') : F.input(c, 'key', { placeholder: 'field_key' }), fields.length ? '' : 'Create custom fields under Audience → Custom fields.'));
        panel.append(F.field('Value', F.input(c, 'value', { placeholder: 'Leave empty to clear the field' })));
        break;
      }
      case 'add_to_list': case 'remove_from_list':
        panel.append(F.field('List', F.select(c, 'list_id', catalog.options.list || [], 'Choose a list…')));
        break;
      case 'webhook': {
        panel.append(F.field('URL', F.input(c, 'url', { type: 'url', placeholder: 'https://example.com/hooks/openhive' })));
        panel.append(F.field('Method', F.select(c, 'method', ['POST', 'PUT', 'PATCH', 'GET'])));
        panel.append(F.field('Signing secret (optional)', F.input(c, 'secret', { placeholder: 'Used to sign the OpenHive-Signature header' })));
        const body = F.textarea(c, 'body', 5, { placeholder: '{"source": "openhive"}' });
        const err = el('small', 'field-h');
        body.addEventListener('input', () => { try { if (body.value.trim()) JSON.parse(body.value); err.textContent = 'Merged into the payload next to subscriber, automation and data.'; err.style.color = ''; } catch { err.textContent = 'Invalid JSON'; err.style.color = 'var(--danger)'; } });
        const fld = F.field('Extra JSON fields (optional)', body);
        fld.append(err);
        panel.append(fld, F.note('Failed calls are retried automatically up to 5 times (1m, 5m, 30m, 2h, 6h). Every attempt appears in the journey timeline.', 'callout'));
        break;
      }
      case 'enroll':
        panel.append(F.field('Automation', F.select(c, 'automation_id', meta.automations || [], 'Choose an automation…'), 'The other automation must be active.'));
        break;
      case 'grant_premium':
        panel.append(F.field('Premium access for (days)', F.number(c, 'days', { min: 1 })));
        break;
      case 'notify':
        panel.append(F.field('Send to', F.input(c, 'email', { type: 'email' })), F.field('Subject', F.input(c, 'subject', { placeholder: 'A subscriber reached this step' })), F.field('Message', F.textarea(c, 'body', 3)));
        break;
      case 'unsubscribe':
        panel.append(F.note('The subscriber is unsubscribed from your publication and the journey ends.', 'callout warn'));
        break;
      case 'exit':
        panel.append(F.note('Subscribers who reach this step leave the automation.', 'callout'));
        break;
    }
  }
  let renderTimer = null;

  // ───────── start from template (welcome / automation / post designs) ─────────
  let tplCache = null;
  async function getJSON(url) {
    const r = await fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Request failed');
    return j;
  }
  async function pickTemplate(c) {
    let dlg = $('#af-tplpick');
    if (!dlg) {
      dlg = el('dialog', 'modal modal-wide af-tplpick');
      dlg.id = 'af-tplpick';
      dlg.innerHTML = `<header class="modal-h"><h3>Start from a template</h3><button type="button" class="btn btn-ghost btn-sm" data-close>✕</button></header><div class="modal-b"><div class="af-tplpick-filter" role="toolbar"></div><div class="af-tplpick-grid"><p class="muted">Loading templates…</p></div></div>`;
      const css = el('style', null, `.af-tplpick{width:min(1100px,96vw)}.af-tplpick-filter{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}.af-tplpick-filter button{border:1px solid var(--border,#e5e7eb);background:none;border-radius:999px;padding:4px 12px;font:inherit;font-size:13px;cursor:pointer;color:inherit}.af-tplpick-filter button.on{background:var(--text,#111);color:var(--bg,#fff);border-color:var(--text,#111)}.af-tplpick-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px;max-height:65vh;overflow:auto}.af-tplpick-card{border:1px solid var(--border,#e5e7eb);border-radius:10px;overflow:hidden;background:var(--surface,#fff);display:flex;flex-direction:column;text-align:left;padding:0;cursor:pointer;font:inherit;color:inherit}.af-tplpick-card:hover{outline:2px solid var(--accent,#f59e0b)}.af-tplpick-card[hidden]{display:none}.af-tplpick-th{height:200px;overflow:hidden;position:relative;background:#f4f4f5;border-bottom:1px solid var(--border,#e5e7eb)}.af-tplpick-th iframe{position:absolute;top:0;left:0;width:200%;height:400px;border:0;transform:scale(.5);transform-origin:0 0;pointer-events:none}.af-tplpick-b{padding:10px 12px}.af-tplpick-b small{display:block;color:var(--muted,#6b7280);margin-top:2px}`);
      dlg.append(css);
      document.body.append(dlg);
      dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target === dlg) dlg.close(); });
    }
    dlg.showModal();
    const grid = dlg.querySelector('.af-tplpick-grid');
    const bar = dlg.querySelector('.af-tplpick-filter');
    try {
      tplCache = tplCache || (await getJSON('/app/automations/email-templates')).templates;
      const kindLabel = { welcome: 'Welcome emails', automation: 'Automation emails', post: 'Newsletter designs' };
      const groups = [...new Set(tplCache.map((t) => t.kind))];
      bar.innerHTML = `<button type="button" class="on" data-k="">All</button>${groups.map((k) => `<button type="button" data-k="${esc(k)}">${esc(kindLabel[k] || k)}</button>`).join('')}`;
      grid.innerHTML = tplCache.map((t) => `<button type="button" class="af-tplpick-card" data-id="${esc(t.id)}" data-kind="${esc(t.kind)}"><span class="af-tplpick-th"><iframe src="/app/posts/templates/${encodeURIComponent(t.id)}/preview?thumb=1" loading="lazy" tabindex="-1" title=""></iframe></span><span class="af-tplpick-b"><strong>${esc(t.name)}</strong><small>${esc(t.team ? 'Team template' : (kindLabel[t.kind] || t.kind).replace(/s$/, ''))}${t.category && !t.team ? ' · ' + esc(t.category) : ''}</small></span></button>`).join('') || '<p class="muted">No templates yet.</p>';
      bar.onclick = (e) => {
        const b = e.target.closest('button[data-k]');
        if (!b) return;
        bar.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        grid.querySelectorAll('.af-tplpick-card').forEach((card) => { card.hidden = !!b.dataset.k && card.dataset.kind !== b.dataset.k; });
      };
      grid.onclick = async (e) => {
        const card = e.target.closest('.af-tplpick-card');
        if (!card) return;
        if ((c.doc?.blocks || []).length && !confirm('Replace this email’s content and style with the template?')) return;
        try {
          const t = await getJSON(`/app/automations/email-templates/${encodeURIComponent(card.dataset.id)}`);
          c.doc = t.doc;
          c.style = t.style || {};
          c.template_id = t.template_id;
          c.template_name = t.template_name;
          if (!c.subject && t.subject) c.subject = t.subject;
          if (!c.preview_text && t.preview_text) c.preview_text = t.preview_text;
          dlg.close();
          changed();
          renderPanel();
          toast(`Loaded “${t.template_name}”`);
        } catch (err) { toast('Could not load template: ' + err.message); }
      };
    } catch (err) { grid.innerHTML = `<p class="muted">Could not load templates: ${esc(err.message)}</p>`; }
  }

  // ───────── preview / test ─────────
  async function preview(c) {
    try {
      const r = await OH.json(`/app/automations/${meta.id}/preview-email`, { config: c });
      const dlg = $('#af-preview');
      $('#af-preview-frame').srcdoc = r.html;
      dlg.querySelector('h3').textContent = `Email preview · as ${r.as} · ${(r.bytes / 1024).toFixed(1)} KB${r.bytes > 102 * 1024 ? ' ⚠ Gmail will clip this' : ''}`;
      dlg.showModal();
    } catch (e) { toast('Preview failed: ' + e.message); }
  }
  async function testSend(c) {
    const to = prompt('Send a test to', meta.userEmail || '');
    if (!to) return;
    try {
      const r = await OH.json(`/app/automations/${meta.id}/test-email`, { config: c, to });
      toast(r.ok ? `Test sent to ${r.to}${r.status === 'simulated' ? ' (simulated locally — see Outbox)' : ''}` : `Failed: ${r.error || r.status}`);
    } catch (e) { toast('Test failed: ' + e.message); }
  }

  // ───────── saving ─────────
  const saveEl = $('#af-save');
  function setSave(t) { if (saveEl) saveEl.textContent = t; }
  async function save() {
    clearTimeout(saveTimer);
    if (saving) { await saving; }
    if (!dirty) return;
    dirty = false;
    setSave('Saving…');
    saving = fetch(`/app/automations/${meta.id}/draft`, { method: 'PUT', headers: { 'content-type': 'application/json', accept: 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ triggers: state.triggers, steps: state.steps, allow_reentry: allowReentry }) })
      .then(async (r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        setSave(j.has_draft && meta.status !== 'draft' ? 'Draft saved · publish to go live' : 'All changes saved');
        const pf = $('#af-publish-form');
        if (pf && meta.status !== 'draft' && meta.status !== 'archived') pf.style.display = j.has_draft ? '' : 'none';
        if (!j.has_draft) { $('#af-draft-note')?.remove(); $('#af-draft-banner')?.remove(); }
        const banner = $('#af-draft-banner');
        if (j.has_draft && meta.status !== 'draft' && !banner && !$('#af-draft-note')) {
          const n = el('div', 'callout warn', `<strong>You have unpublished changes.</strong> The live version keeps running until you publish. <a href="/app/automations/${meta.id}/compare">Compare draft vs live</a>`);
          n.id = 'af-draft-note';
          $('.af-shell').before(n);
        }
      })
      .catch((e) => { dirty = true; setSave('Save failed — retrying'); saveTimer = setTimeout(save, 3000); console.error(e); })
      .finally(() => { saving = null; });
    await saving;
  }
  addEventListener('beforeunload', (e) => { if (dirty || saving) { e.preventDefault(); e.returnValue = ''; } });
  // make sure the draft is saved before publish/activate
  document.addEventListener('submit', async (e) => {
    const f = e.target;
    if (f.id !== 'af-publish-form' || (!dirty && !saving)) return;
    e.preventDefault();
    await save();
    f.submit();
  });

  render();
  renderPanel();
})();
