// Event pages: countdowns, viewer-local times, coaching slot picker.
(() => {
  document.querySelectorAll('[data-local-time]').forEach((el) => {
    const d = new Date(el.dataset.localTime);
    if (!isNaN(d)) el.textContent = d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  });
  const tick = () => document.querySelectorAll('[data-countdown]').forEach((el) => {
    const ms = new Date(el.dataset.countdown) - Date.now();
    if (ms <= 0) { el.innerHTML = '<div><b>Live</b><small>now</small></div>'; return; }
    const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4), s = Math.floor((ms % 6e4) / 1e3);
    el.innerHTML = [[d, 'days'], [h, 'hrs'], [m, 'min'], [s, 'sec']].map(([v, l]) => `<div><b>${v}</b><small>${l}</small></div>`).join('');
  });
  tick();
  setInterval(tick, 1000);
  const slots = document.querySelector('[data-slots]');
  if (slots) {
    const input = document.querySelector('[data-slot-input]');
    const submit = document.querySelector('[data-slot-submit]');
    if (submit) submit.disabled = true;
    slots.addEventListener('click', (e) => {
      const b = e.target.closest('[data-slot]');
      if (!b) return;
      slots.querySelectorAll('.on').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      input.value = b.dataset.slot;
      if (submit) submit.disabled = false;
    });
  }
})();
