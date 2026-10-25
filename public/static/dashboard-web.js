// Live website analytics: polls /app/analytics/web/live.json every 10s and updates the "Right now" card.
(() => {
  const card = document.querySelector('[data-live="visitors"]');
  if (!card) return;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => new Intl.NumberFormat('en-US').format(n || 0);
  async function tick() {
    if (document.hidden) return;
    try {
      const r = await fetch('/app/analytics/web/live.json', { headers: { accept: 'application/json' }, credentials: 'same-origin' });
      if (!r.ok) return;
      const d = await r.json();
      document.querySelector('[data-live="visitors"]').textContent = fmt(d.visitors);
      document.querySelector('[data-live="views"]').textContent = fmt(d.views);
      const max = Math.max(1, ...d.minutes);
      document.querySelector('[data-live="minutes"]').innerHTML = d.minutes.map((n) => `<i style="height:${(n / max) * 100}%" title="${n} views"></i>`).join('');
      document.querySelector('[data-live="pages"]').innerHTML = d.pages.slice(0, 5).map((p) => `<li class="row between"><span class="truncate">${esc(p.path)}</span><strong>${p.n}</strong></li>`).join('') || '<li class="muted">No visitors right now</li>';
    } catch {}
  }
  setInterval(tick, 10000);
  document.addEventListener('visibilitychange', tick);
})();
