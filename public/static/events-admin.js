// Event editor: show fields for the selected event type, cover upload.
(() => {
  const form = document.querySelector('[data-event-form]');
  if (form) {
    const kind = form.querySelector('[data-kind]');
    const sync = () => {
      form.querySelectorAll('[data-show-kind]').forEach((el) => (el.style.display = el.dataset.showKind === kind.value ? '' : 'none'));
      const lbl = form.querySelector('[data-when-label]');
      if (lbl) lbl.textContent = kind.value === 'coaching' ? 'Bookings open' : 'Starts';
    };
    kind.addEventListener('change', sync);
    sync();
  }
  document.querySelectorAll('[data-image-upload]').forEach((input) => input.addEventListener('change', async () => {
    let file = input.files[0];
    if (!file) return;
    if (window.OH?.optimizeImage) file = await OH.optimizeImage(file);
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch('/app/events/upload', { method: 'POST', body: fd, headers: { accept: 'application/json' } });
    const j = await r.json();
    if (!r.ok) return window.OH?.toast(j.error || 'Upload failed');
    const name = input.dataset.imageUpload;
    const field = document.querySelector(`[data-image-field="${name}"]`);
    if (field) field.value = j.url;
    const prev = document.querySelector(`[data-preview="${name}"]`);
    if (prev) { prev.src = j.url; prev.classList.remove('hide'); }
  }));
})();
