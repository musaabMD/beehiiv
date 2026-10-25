// Media library page: drag & drop / multi-file upload with automatic image optimization.
(() => {
  const drop = document.getElementById('media-drop');
  const input = document.getElementById('media-files');
  const prog = document.getElementById('media-progress');
  if (!drop || !input) return;
  async function uploadAll(files) {
    let done = 0, failed = [];
    for (const f of files) {
      prog.textContent = `Uploading ${done + 1} of ${files.length}: ${f.name}…`;
      try { await OH.upload(f); done++; } catch (e) { failed.push(`${f.name}: ${e.message}`); }
    }
    prog.textContent = failed.length ? `Uploaded ${done}. Failed: ${failed.join('; ')}` : `Uploaded ${done} file${done === 1 ? '' : 's'}`;
    if (done) setTimeout(() => location.reload(), 500);
  }
  input.addEventListener('change', () => input.files.length && uploadAll([...input.files]));
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); drop.classList.add('over'); } }));
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
  document.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); drop.classList.remove('over'); uploadAll([...e.dataTransfer.files]); } });
  drop.addEventListener('click', () => input.click());
})();
