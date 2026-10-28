// Visual rule builder. Markup:
//   <input type="hidden" name="rules" value='{"op":"and","rules":[]}' id="rules-input">
//   <div data-rules="#rules-input" data-catalog="#rule-catalog"></div>
//   <script type="application/json" id="rule-catalog">{fields:{...}, options:{...}}</script>
// Changes are written back to the hidden input as JSON. Dispatches 'rules:change' on the container.
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const CMP_LABEL = {
    eq: 'is', neq: 'is not', equals: 'equals', contains: 'contains', not_contains: 'does not contain', ends_with: 'ends with', is_empty: 'is empty', not_empty: 'is not empty',
    gt: 'greater than', lt: 'less than', within_days: 'within last (days)', older_than_days: 'more than (days) ago', not_within_days: 'not within last (days)', never: 'never',
    before: 'before', after: 'after', has: 'has', not_has: 'does not have', exists: 'is set', not_exists: 'is not set', yes: 'yes', no: 'no', any: 'any product',
    started: 'has started', not_started: 'has not started', completed: 'has completed', active: 'is currently in', in: 'is in', not_in: 'is not in',
    answered: 'answered', not_answered: 'did not answer', chose: 'chose option', responded: 'responded', not_responded: 'did not respond', answer_equals: 'answer equals',
    is_true: 'yes', is_false: 'no', matches: 'matches', not_matches: 'does not match', performed: 'performed', not_performed: 'did not perform',
  };
  const NO_VALUE = new Set(['is_empty', 'not_empty', 'never', 'exists', 'is_true', 'is_false', 'any']);

  function optionsFor(cat, kind) {
    const o = cat.options || {};
    const map = { tag: o.tag, tier: o.tier, segment: o.segment, post: o.post, automation: o.automation, list: o.list, product: o.product, event: o.event, condition_set: o.condition_set };
    return map[kind];
  }

  function valueInput(cat, field, rule) {
    const def = cat.fields[field] || {};
    const v = rule.value;
    if (NO_VALUE.has(rule.cmp)) return '';
    if (def.kind === 'enum') return `<select class="input r-val">${def.options.map((x) => `<option ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>`;
    if (def.kind === 'custom') {
      const fields = (cat.options.custom || []);
      return `<select class="input r-key">${fields.map((f) => `<option value="${esc(f.key)}" ${v?.key === f.key ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select>` + (['exists', 'not_exists'].includes(rule.cmp) ? '' : `<input class="input r-cval" value="${esc(v?.value ?? '')}" placeholder="value">`);
    }
    if (def.kind === 'poll') {
      const polls = cat.options.poll || [];
      const p = polls.find((x) => x.id === (v?.poll_id ?? v)) || polls[0];
      let h = `<select class="input r-poll">${polls.map((x) => `<option value="${esc(x.id)}" ${p && x.id === p.id ? 'selected' : ''}>${esc(x.question)}</option>`).join('')}</select>`;
      if (rule.cmp === 'chose' && p) h += `<select class="input r-popt">${(p.options || []).map((x) => `<option value="${esc(x.id)}" ${v?.option_id === x.id ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>`;
      return h;
    }
    if (def.kind === 'survey') {
      const surveys = cat.options.survey || [];
      const s = surveys.find((x) => x.id === (v?.survey_id ?? v)) || surveys[0];
      let h = `<select class="input r-survey">${surveys.map((x) => `<option value="${esc(x.id)}" ${s && x.id === s.id ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</select>`;
      if (rule.cmp === 'answer_equals' && s) h += `<select class="input r-sq">${(s.questions || []).map((q) => `<option value="${esc(q.id)}" ${v?.question_id === q.id ? 'selected' : ''}>${esc(q.label)}</option>`).join('')}</select><input class="input r-sval" value="${esc(v?.value ?? '')}" placeholder="answer">`;
      return h;
    }
    if (def.kind === 'custom_event') {
      const o = v && typeof v === 'object' ? v : { name: v || '' };
      return `<input class="input r-ev" value="${esc(o.name ?? '')}" placeholder="event name"><input class="input r-evd" type="number" min="0" style="width:90px" value="${esc(o.days ?? '')}" placeholder="any time" title="within the last N days (empty = ever)"><input class="input r-evc" type="number" min="1" style="width:70px" value="${esc(o.count ?? '')}" placeholder="1×" title="at least this many times">`;
    }
    const opts = optionsFor(cat, def.kind);
    if (opts) {
      const list = opts.map((x) => (Array.isArray(x) ? x : [x, x]));
      return `<select class="input r-val">${list.map(([id, label]) => `<option value="${esc(id)}" ${String(id) === String(v) ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
    }
    const type = def.kind === 'number' || /days/.test(rule.cmp) ? 'number' : rule.cmp === 'before' || rule.cmp === 'after' ? 'date' : 'text';
    return `<input class="input r-val" type="${type}" value="${esc(v ?? '')}">`;
  }

  function render(container, group, cat, depth = 0) {
    const wrap = document.createElement('div');
    wrap.className = 'rules';
    const op = document.createElement('div');
    op.className = 'rule-op';
    op.innerHTML = `<button type="button" data-op="and" class="${group.op !== 'or' ? 'on' : ''}">Match ALL</button><button type="button" data-op="or" class="${group.op === 'or' ? 'on' : ''}">Match ANY</button>`;
    op.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; group.op = b.dataset.op; container.refresh(); });
    wrap.appendChild(op);
    group.rules.forEach((rule, idx) => {
      if (rule.rules) {
        const sub = render(container, rule, cat, depth + 1);
        const x = document.createElement('button');
        x.type = 'button'; x.className = 'rule-x'; x.textContent = '✕ remove group';
        x.onclick = () => { group.rules.splice(idx, 1); container.refresh(); };
        sub.prepend(x);
        wrap.appendChild(sub);
        return;
      }
      const row = document.createElement('div');
      row.className = 'rule-row';
      const def = cat.fields[rule.field] || Object.values(cat.fields)[0];
      row.innerHTML =
        `<select class="input r-field">${Object.entries(cat.fields).map(([k, f]) => `<option value="${k}" ${k === rule.field ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select>` +
        `<select class="input r-cmp">${def.cmps.map((cmp) => `<option value="${cmp}" ${cmp === rule.cmp ? 'selected' : ''}>${esc(CMP_LABEL[cmp] || cmp)}</option>`).join('')}</select>` +
        valueInput(cat, rule.field, rule) +
        `<button type="button" class="rule-x" title="Remove">✕</button>`;
      row.querySelector('.r-field').onchange = (e) => { rule.field = e.target.value; rule.cmp = cat.fields[rule.field].cmps[0]; rule.value = undefined; container.refresh(); };
      row.querySelector('.r-cmp').onchange = (e) => { rule.cmp = e.target.value; container.refresh(); };
      row.querySelector('.rule-x').onclick = () => { group.rules.splice(idx, 1); container.refresh(); };
      const sync = () => {
        const k = row.querySelector('.r-key');
        if (k) rule.value = { key: k.value, value: row.querySelector('.r-cval')?.value };
        else if (row.querySelector('.r-poll')) rule.value = { poll_id: row.querySelector('.r-poll').value, option_id: row.querySelector('.r-popt')?.value };
        else if (row.querySelector('.r-ev')) rule.value = { name: row.querySelector('.r-ev').value.trim(), days: Number(row.querySelector('.r-evd').value) || undefined, count: Number(row.querySelector('.r-evc').value) || undefined };
        else if (row.querySelector('.r-survey')) rule.value = { survey_id: row.querySelector('.r-survey').value, question_id: row.querySelector('.r-sq')?.value, value: row.querySelector('.r-sval')?.value };
        else { const v = row.querySelector('.r-val'); rule.value = v ? v.value : undefined; }
        container.save();
      };
      row.querySelectorAll('.r-val,.r-key,.r-cval,.r-sval,.r-ev,.r-evd,.r-evc').forEach((el) => el.addEventListener('input', sync));
      row.querySelectorAll('select.r-val,.r-key').forEach((el) => el.addEventListener('change', sync));
      row.querySelectorAll('.r-poll,.r-survey').forEach((el) => el.addEventListener('change', () => { sync(); container.refresh(); }));
      row.querySelectorAll('.r-popt,.r-sq').forEach((el) => el.addEventListener('change', sync));
      if (rule.value === undefined && !NO_VALUE.has(rule.cmp)) setTimeout(sync);
      wrap.appendChild(row);
    });
    const add = document.createElement('div');
    add.className = 'row';
    add.innerHTML = `<button type="button" class="btn btn-ghost btn-sm" data-add>+ Add condition</button>${depth < 2 ? '<button type="button" class="btn btn-ghost btn-sm" data-group>+ Add group</button>' : ''}`;
    add.querySelector('[data-add]').onclick = () => { const f = Object.keys(cat.fields)[0]; group.rules.push({ field: f, cmp: cat.fields[f].cmps[0] }); container.refresh(); };
    add.querySelector('[data-group]')?.addEventListener('click', () => { group.rules.push({ op: 'and', rules: [] }); container.refresh(); });
    wrap.appendChild(add);
    return wrap;
  }

  function mount(el) {
    const input = document.querySelector(el.dataset.rules);
    const cat = JSON.parse(document.querySelector(el.dataset.catalog || '#rule-catalog').textContent);
    let group;
    try { group = JSON.parse(input.value || '{}'); } catch { group = {}; }
    if (!group.rules) group = { op: 'and', rules: [] };
    el.save = () => { input.value = JSON.stringify(group); el.dispatchEvent(new CustomEvent('rules:change', { detail: group })); };
    el.refresh = () => { el.innerHTML = ''; el.appendChild(render(el, group, cat)); el.save(); };
    el.refresh();
  }

  window.OHRules = { mount };
  document.querySelectorAll('[data-rules]').forEach(mount);
})();
