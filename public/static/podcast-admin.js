// Podcast dashboard: audio upload with progress + duration detection, image upload, show-notes editor, transcript files.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const toast = (m) => (window.OH?.toast ? OH.toast(m) : alert(m));

  function xhrUpload(file, kind, onProgress) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('kind', kind);
      const x = new XMLHttpRequest();
      x.open('POST', '/app/podcasts/upload');
      x.setRequestHeader('accept', 'application/json');
      x.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
      x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch {} x.status < 300 ? resolve(j) : reject(new Error(j.error || 'Upload failed')); };
      x.onerror = () => reject(new Error('Network error'));
      x.send(fd);
    });
  }

  const durationOf = (file) => new Promise((res) => {
    const a = document.createElement('audio');
    a.preload = 'metadata';
    a.onloadedmetadata = () => { res(isFinite(a.duration) ? a.duration : 0); URL.revokeObjectURL(a.src); };
    a.onerror = () => res(0);
    a.src = URL.createObjectURL(file);
  });

  document.querySelectorAll('[data-audio-upload]').forEach((input) => {
    const form = input.closest('form');
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      const bar = $('[data-audio-progress]', form), info = $('[data-audio-info]', form);
      const submit = form.querySelector('button[type=submit],button:not([type])');
      bar.classList.remove('hide');
      if (submit) submit.disabled = true;
      info.textContent = 'Uploading ' + file.name + '…';
      try {
        const [dur, up] = await Promise.all([durationOf(file), xhrUpload(file, 'audio', (p) => (bar.firstElementChild.style.width = Math.round(p * 100) + '%'))]);
        form.querySelector('[name=audio_key]').value = up.key;
        form.querySelector('[name=size]').value = up.size;
        form.querySelector('[name=mime]').value = up.mime;
        form.querySelector('[name=duration]').value = Math.round(dur);
        form.querySelector('[name=audio_url]').value = '';
        const m = Math.floor(dur / 60), s = Math.round(dur % 60);
        info.textContent = `✓ ${file.name} · ${m}:${String(s).padStart(2, '0')} · ${(up.size / 1048576).toFixed(1)} MB — save to apply`;
      } catch (e) { info.textContent = 'Upload failed: ' + e.message; }
      finally { if (submit) submit.disabled = false; bar.classList.add('hide'); }
    });
  });

  document.querySelectorAll('[data-image-upload]').forEach((input) => {
    input.addEventListener('change', async () => {
      let file = input.files[0];
      if (!file) return;
      if (window.OH?.optimizeImage) file = await OH.optimizeImage(file, 3000, 0.9);
      try {
        const up = await xhrUpload(file, 'image');
        const name = input.dataset.imageUpload;
        const field = document.querySelector(`[data-image-field="${name}"]`);
        if (field) field.value = up.url;
        const prev = document.querySelector(`[data-preview="${name}"]`);
        if (prev) { prev.src = up.url; prev.classList.remove('hide'); }
        toast('Image uploaded');
      } catch (e) { toast(e.message); }
    });
  });

  // show-notes rich text
  document.querySelectorAll('[data-rte]').forEach((body) => {
    const form = body.closest('form');
    const hidden = form.querySelector(`input[name="${body.dataset.rte}"]`);
    const sync = () => (hidden.value = body.innerHTML.trim() === '<br>' ? '' : body.innerHTML);
    body.addEventListener('input', sync);
    form.addEventListener('submit', sync);
    body.closest('.rte').querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => {
      body.focus();
      const cmd = b.dataset.cmd;
      if (cmd === 'createLink') { const u = prompt('Link URL'); if (u) document.execCommand('createLink', false, u); }
      else document.execCommand(cmd, false, b.dataset.arg || null);
      sync();
    }));
  });

  document.querySelectorAll('[data-transcript-file]').forEach((input) => input.addEventListener('change', async () => {
    const f = input.files[0];
    if (f) input.closest('form').querySelector('textarea[name=transcript]').value = await f.text();
  }));
})();
