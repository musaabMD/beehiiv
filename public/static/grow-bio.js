// Link-in-bio editor: add/remove/reorder links (buttons + drag), avatar upload, live preview refresh.
(() => {
  const list = document.getElementById('bio-links');
  if (!list) return;
  const row = () => {
    const d = document.createElement('div');
    d.className = 'row bio-link';
    d.draggable = true;
    d.innerHTML = '<span class="muted" style="cursor:grab" title="Drag to reorder">⋮⋮</span><input class="input" name="link_label[]" placeholder="Label" style="flex:1"><input class="input" name="link_url[]" placeholder="https://…" style="flex:2"><button type="button" class="btn btn-ghost btn-sm" data-up>↑</button><button type="button" class="btn btn-ghost btn-sm" data-down>↓</button><button type="button" class="btn btn-ghost btn-sm" data-remove>✕</button>';
    return d;
  };
  document.querySelector('[data-add-link]')?.addEventListener('click', () => { const r = row(); list.appendChild(r); r.querySelector('input').focus(); });
  list.addEventListener('click', (e) => {
    const r = e.target.closest('.bio-link');
    if (!r) return;
    if (e.target.closest('[data-remove]')) { r.remove(); if (!list.children.length) list.appendChild(row()); }
    if (e.target.closest('[data-up]') && r.previousElementSibling) list.insertBefore(r, r.previousElementSibling);
    if (e.target.closest('[data-down]') && r.nextElementSibling) list.insertBefore(r.nextElementSibling, r);
  });
  let dragged = null;
  list.addEventListener('dragstart', (e) => { dragged = e.target.closest('.bio-link'); e.dataTransfer.effectAllowed = 'move'; });
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    const over = e.target.closest('.bio-link');
    if (!dragged || !over || over === dragged) return;
    const rect = over.getBoundingClientRect();
    list.insertBefore(dragged, e.clientY > rect.top + rect.height / 2 ? over.nextSibling : over);
  });
  list.addEventListener('dragend', () => (dragged = null));

  const up = document.querySelector('[data-bio-upload]');
  up?.addEventListener('change', async () => {
    const f = up.files[0];
    if (!f) return;
    try {
      const r = await window.OH.upload(f, { folder: 'bio' });
      document.getElementById('bio-avatar').value = r.url;
      document.getElementById('bio-avatar-preview').src = r.url;
      window.OH.toast('Avatar uploaded — save to publish');
    } catch (err) { window.OH.toast('Upload failed: ' + err.message); }
  });
  const frame = document.getElementById('bio-preview');
  document.querySelector('[data-refresh-preview]')?.addEventListener('click', () => { frame.src = frame.src.split('&r=')[0] + '&r=' + Date.now(); });
})();
