// Publication website behaviours: modals, pop-ups, UTM capture, copy buttons, reactions, analytics helpers.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

  // capture UTM + referrer on first visit for attribution
  const p = new URLSearchParams(location.search);
  const utm = {};
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'ref_pub']) if (p.get(k)) utm[k] = p.get(k);
  if (Object.keys(utm).length) store.set('oh_utm', JSON.stringify({ ...utm, referrer: document.referrer, landing: location.pathname }));
  else if (!store.get('oh_utm') && document.referrer && !document.referrer.startsWith(location.origin)) store.set('oh_utm', JSON.stringify({ referrer: document.referrer, landing: location.pathname }));
  $$('input[data-utm]').forEach((i) => (i.value = store.get('oh_utm') || ''));

  // modals
  document.addEventListener('click', (e) => {
    const m = e.target.closest('[data-modal]');
    if (m) { e.preventDefault(); $('#m-' + m.dataset.modal)?.showModal(); }
    if (e.target.closest('[data-close]')) e.target.closest('dialog')?.close();
    if (e.target.tagName === 'DIALOG') e.target.close();
  });

  // pop-up: delay / scroll depth / exit intent, with frequency cap
  const pop = $('#m-popup');
  if (pop && !store.get('oh_subscribed')) {
    const cfg = JSON.parse(pop.dataset.popup || '{}');
    const last = Number(store.get('oh_popup_seen') || 0);
    if (Date.now() - last > (cfg.frequency_days ?? 7) * 86400000) {
      let shown = false;
      const show = () => { if (shown || document.querySelector('dialog[open]')) return; shown = true; store.set('oh_popup_seen', String(Date.now())); pop.showModal(); };
      if (cfg.delay) setTimeout(show, cfg.delay * 1000);
      if (cfg.scroll) addEventListener('scroll', () => { const pct = (scrollY + innerHeight) / document.body.scrollHeight * 100; if (pct >= cfg.scroll) show(); }, { passive: true });
      if (cfg.exit) document.addEventListener('mouseout', (e) => { if (!e.relatedTarget && e.clientY < 10) show(); });
    }
  }
  $$('form[data-subscribe]').forEach((f) => f.addEventListener('submit', () => store.set('oh_subscribed', '1')));

  // copy buttons
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    e.preventDefault();
    try { await navigator.clipboard.writeText(b.dataset.copy); const t = b.textContent; b.textContent = 'Copied!'; setTimeout(() => (b.textContent = t), 1500); } catch { prompt('Copy this link', b.dataset.copy); }
  });

  // native share
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-share]');
    if (b && navigator.share) { e.preventDefault(); navigator.share({ title: document.title, url: b.dataset.share }).catch(() => {}); }
  });

  // reactions (progressive enhancement over plain forms)
  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('form[data-react]');
    if (!f) return;
    e.preventDefault();
    const btn = e.submitter;
    const fd = new FormData(f);
    if (btn?.name) fd.set(btn.name, btn.value);
    const r = await fetch(f.action, { method: 'POST', body: fd, headers: { accept: 'application/json' } });
    if (r.status === 401) { $('#m-login')?.showModal() || $('#m-subscribe')?.showModal(); return; }
    const j = await r.json().catch(() => null);
    if (j?.counts) for (const [emoji, n] of Object.entries(j.counts)) { const b = f.querySelector(`button[value="${emoji}"] span`); if (b) b.textContent = n; }
    btn?.classList.toggle('on');
  });

  // carousels: keyboard arrows
  $$('.oh-carousel').forEach((c) => c.setAttribute('tabindex', '0'));
})();

// page-builder carousels: prev/next buttons
(() => {
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-carousel-prev],[data-carousel-next]');
    if (!b) return;
    const car = b.closest('.pb-in')?.querySelector('[data-carousel]');
    if (!car) return;
    const step = car.clientWidth * 0.85;
    car.scrollBy({ left: b.hasAttribute('data-carousel-next') ? step : -step, behavior: 'smooth' });
  });
})();
