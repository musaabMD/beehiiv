// Subject line helper for the post editor (Email tab): live checks + score as you type, AI alternatives
// (Workers AI, rule-based fallback) and the publication's top past subjects by open rate.
// Scoring mirrors scoreSubject() in src/routes/posts/shared.ts — keep the two in sync.
(function () {
  'use strict';
  const SPAM = ['free', 'act now', 'buy now', 'click here', 'limited time', 'urgent', 'winner', 'guarantee', 'guaranteed', 'risk-free', 'risk free', 'no cost', 'cash', '100%', 'earn money', 'make money', 'double your', 'cheap', 'order now', 'once in a lifetime', 'congratulations', 'you won', 'prize', 'credit card', 'no obligation', 'miracle', 'lowest price', 'best price', 'call now', 'apply now', 'exclusive deal', 'save big', 'incredible deal', 'last chance', 'dear friend', 'not spam', 'viagra', 'casino', '$$$', 'cash bonus', 'get paid'];
  const CAPS_OK = ['FAQ', 'USA', 'CEO', 'API', 'NYC', 'SEO', 'PDF', 'CTO', 'CFO', 'NFT', 'ETF', 'IPO', 'GDP', 'NBA', 'NFL'];
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let EMOJI;
  try { EMOJI = new RegExp('\\p{Extended_Pictographic}', 'gu'); } catch { EMOJI = /[☀-➿]|[\uD83C-\uDBFF][\uDC00-\uDFFF]/g; }

  function score(subjectRaw, previewRaw) {
    const subject = String(subjectRaw || '').trim();
    const visible = subject.replace(/\{\{\s*([a-z0-9_.]+)\s*(?:\|\s*([^}]*?))?\s*\}\}/gi, (_, k, fb) => fb || (k.includes('name') ? 'Alex' : 'X'));
    const chars = [...visible].length;
    const words = visible ? visible.split(/\s+/).filter(Boolean).length : 0;
    const emojis = (visible.match(EMOJI) || []).length;
    const lower = visible.toLowerCase();
    const spam = SPAM.filter((w) => new RegExp(`(^|[^a-z0-9])${reEsc(w)}($|[^a-z0-9])`, 'i').test(lower));
    const capsWords = (visible.match(/\b[A-Z]{3,}\b/g) || []).filter((w) => !CAPS_OK.includes(w));
    const letters = visible.replace(/[^A-Za-z]/g, '');
    const allCaps = letters.length >= 6 && letters === letters.toUpperCase();
    const bangs = (visible.match(/!/g) || []).length;
    const preview = String(previewRaw || '').trim();
    const personalized = /\{\{\s*subscriber\./i.test(subject);
    const question = /\?/.test(visible), number = /\d/.test(visible);
    const checks = [];
    if (!chars) return { score: 0, grade: 'poor', chars, words, emojis, checks: [{ id: 'length', label: 'Length', status: 'bad', detail: 'Write a subject line' }] };
    let s = 100;
    if (chars >= 30 && chars <= 50) checks.push({ id: 'length', label: 'Length', status: 'good', detail: `${chars} characters — in the 30–50 sweet spot` });
    else if (chars >= 20 && chars <= 60) { s -= 8; checks.push({ id: 'length', label: 'Length', status: 'warn', detail: `${chars} characters — aim for 30–50 so phones show all of it` }); }
    else { s -= 20; checks.push({ id: 'length', label: 'Length', status: 'bad', detail: `${chars} characters — ${chars < 20 ? 'too short to say much' : 'mobile inboxes cut off after ~60'}` }); }
    if (words >= 4 && words <= 9) checks.push({ id: 'words', label: 'Words', status: 'good', detail: `${words} words — easy to scan` });
    else { s -= 6; checks.push({ id: 'words', label: 'Words', status: 'warn', detail: `${words} word${words === 1 ? '' : 's'} — 4 to 9 words performs best` }); }
    if (!preview) { s -= 10; checks.push({ id: 'preview', label: 'Preview text', status: 'warn', detail: 'Not set — inboxes will show the first line of the email instead' }); }
    else if (preview.toLowerCase() === subject.toLowerCase()) { s -= 8; checks.push({ id: 'preview', label: 'Preview text', status: 'warn', detail: 'Repeats the subject — use it for a second hook' }); }
    else if ([...preview].length < 35) { s -= 3; checks.push({ id: 'preview', label: 'Preview text', status: 'warn', detail: `Set (${[...preview].length} chars) — 40–110 characters fills the preview` }); }
    else checks.push({ id: 'preview', label: 'Preview text', status: 'good', detail: `Set (${[...preview].length} characters)` });
    if (spam.length) { s -= Math.min(30, 12 * spam.length); checks.push({ id: 'spam', label: 'Spam triggers', status: spam.length > 1 ? 'bad' : 'warn', detail: `Avoid ${spam.map((w) => `“${w}”`).join(', ')}` }); }
    else checks.push({ id: 'spam', label: 'Spam triggers', status: 'good', detail: 'No common spam-trigger words' });
    const multi = bangs >= 2 || /[!?]{2,}/.test(visible);
    if (allCaps || capsWords.length >= 2 || multi) { s -= 15; checks.push({ id: 'caps', label: 'Caps & !!!', status: 'bad', detail: allCaps ? 'ALL CAPS reads as shouting and hurts deliverability' : multi ? 'Several “!” or “?!” — one at most' : `Words in caps: ${capsWords.slice(0, 3).join(', ')}` }); }
    else if (capsWords.length === 1 || bangs === 1) { s -= 3; checks.push({ id: 'caps', label: 'Caps & !!!', status: 'warn', detail: capsWords.length ? `“${capsWords[0]}” in caps — fine once` : 'One “!” — fine, don’t add more' }); }
    else checks.push({ id: 'caps', label: 'Caps & !!!', status: 'good', detail: 'No ALL CAPS or !!!' });
    if (emojis <= 2) checks.push({ id: 'emoji', label: 'Emoji', status: 'good', detail: emojis ? `${emojis} emoji — adds personality` : 'None — one emoji can help you stand out' });
    else { s -= 10; checks.push({ id: 'emoji', label: 'Emoji', status: 'bad', detail: `${emojis} emoji — keep it to one or two` }); }
    if (personalized) { s += 5; checks.push({ id: 'personal', label: 'Personalization', status: 'good', detail: 'Uses a merge tag — personal subjects tend to get more opens' }); }
    else checks.push({ id: 'personal', label: 'Personalization', status: 'warn', detail: 'Try {{subscriber.first_name|there}} for a personal touch' });
    if (question || number) { s += 4; checks.push({ id: 'hook', label: 'Question / number', status: 'good', detail: `${[question && 'Asks a question', number && 'uses a number'].filter(Boolean).join(' and ')} — both spark curiosity` }); }
    else checks.push({ id: 'hook', label: 'Question / number', status: 'warn', detail: 'A question or a specific number often lifts opens' });
    s = Math.max(0, Math.min(100, Math.round(s)));
    return { score: s, grade: s >= 85 ? 'great' : s >= 70 ? 'good' : s >= 50 ? 'fair' : 'poor', chars, words, emojis, checks };
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = { good: '✓', warn: '!', bad: '✕' };
  const pct = (x) => (x == null ? '—' : Math.round(x * 1000) / 10 + '%');

  function init() {
    const meta = document.getElementById('pe-meta');
    const subj = meta && meta.querySelector('input[name=email_subject]');
    if (!subj || subj.dataset.shMounted) return;
    subj.dataset.shMounted = '1';
    const prev = meta.querySelector('input[name=preview_text]');
    const titleEl = document.getElementById('pe-title');
    const anchor = (prev && prev.closest('label')) || subj.closest('label');
    const box = document.createElement('div');
    box.className = 'sh';
    box.id = 'subject-helper';
    box.innerHTML = `<div class="sh-head"><div class="sh-ring" aria-hidden="true"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15.5" pathLength="100" class="sh-ring-bg"/><circle cx="18" cy="18" r="15.5" pathLength="100" class="sh-ring-fg" stroke-dasharray="0 100"/></svg><b class="sh-num">0</b></div>
      <div class="sh-sum"><strong>Subject line score <span class="sh-grade"></span></strong><span class="sh-meta small muted"></span><span class="sh-using small muted"></span></div></div>
      <ul class="sh-checks" aria-live="polite"></ul>
      <div class="sh-actions"><button type="button" class="btn btn-secondary btn-sm sh-suggest">✨ Suggest alternatives</button><button type="button" class="btn btn-ghost btn-sm sh-top-btn" aria-expanded="false">🏆 Your top subjects</button></div>
      <div class="sh-out"></div><div class="sh-top" hidden></div>`;
    anchor.after(box);
    const $ = (s) => box.querySelector(s);

    function current() { const s = subj.value.trim(); return { subject: s || (titleEl ? titleEl.value.trim() : ''), usingTitle: !s && !!(titleEl && titleEl.value.trim()) }; }
    function paint() {
      const cur = current();
      const r = score(cur.subject, prev ? prev.value : '');
      $('.sh-num').textContent = r.score;
      $('.sh-ring-fg').setAttribute('stroke-dasharray', `${r.score} 100`);
      box.dataset.grade = r.grade;
      box.dataset.score = r.score;
      $('.sh-grade').textContent = cur.subject ? `· ${r.grade}` : '';
      $('.sh-meta').textContent = cur.subject ? `${r.chars} chars · ${r.words} words · ${r.emojis} emoji` : '';
      $('.sh-using').textContent = cur.usingTitle ? 'Scoring the post title (no subject set — the title is used)' : '';
      $('.sh-checks').innerHTML = r.checks.map((c) => `<li class="sh-c sh-${c.status}" data-check="${c.id}"><i>${ICON[c.status]}</i><span><b>${esc(c.label)}</b> ${esc(c.detail)}</span></li>`).join('');
    }
    let t;
    const later = () => { clearTimeout(t); t = setTimeout(paint, 80); };
    subj.addEventListener('input', later);
    prev && prev.addEventListener('input', later);
    titleEl && titleEl.addEventListener('input', later);
    paint();

    function use(s) {
      subj.value = s;
      subj.dispatchEvent(new Event('input', { bubbles: true }));
      subj.focus();
      paint();
    }
    box.addEventListener('click', (e) => { const b = e.target.closest('[data-use]'); if (b) use(b.dataset.use); });

    $('.sh-suggest').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const cur = current();
      if (!cur.subject) { $('.sh-out').innerHTML = '<p class="small muted">Write a title or subject first.</p>'; return; }
      btn.disabled = true; btn.textContent = '✨ Thinking…';
      try {
        const text = window.OHEditor && OHEditor.plainText ? OHEditor.plainText().slice(0, 3000) : '';
        const res = await fetch('/app/posts/subject-helper/suggest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: subj.value.trim(), title: titleEl ? titleEl.value : '', preview_text: prev ? prev.value : '', text }) });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || 'Could not get suggestions');
        $('.sh-out').innerHTML = (j.message ? `<p class="sh-note small">${esc(j.ai_disabled ? 'AI isn’t enabled on this instance — showing rule-based ideas.' : j.message)}</p>` : '')
          + `<ul class="sh-sugs">${j.suggestions.map((x) => `<li><span class="sh-sc sh-sc-${x.score >= 85 ? 'great' : x.score >= 70 ? 'good' : 'fair'}">${x.score}</span><span class="sh-st">${esc(x.subject)}${x.why ? `<small class="muted">${esc(x.why)}</small>` : ''}</span><button type="button" class="btn btn-ghost btn-sm" data-use="${esc(x.subject)}">Use</button></li>`).join('')}</ul>`;
      } catch (err) { $('.sh-out').innerHTML = `<p class="sh-note small">${esc(err.message)}</p>`; }
      btn.disabled = false; btn.textContent = '✨ Suggest alternatives';
    });

    let topLoaded = false;
    $('.sh-top-btn').addEventListener('click', async (e) => {
      const panel = $('.sh-top');
      const open = panel.hidden;
      panel.hidden = !open;
      e.currentTarget.setAttribute('aria-expanded', String(open));
      if (!open || topLoaded) return;
      panel.innerHTML = '<p class="small muted">Loading…</p>';
      try {
        const j = await (await fetch('/app/posts/subject-helper/top')).json();
        topLoaded = true;
        panel.innerHTML = j.top && j.top.length
          ? `<p class="small muted" style="margin:0 0 6px">Your best subjects by open rate${j.average_open_rate != null ? ` · average ${pct(j.average_open_rate)} across ${j.sent} sends` : ''}</p><ol class="sh-tops">${j.top.map((x) => `<li><span class="sh-st">${esc(x.subject)}</span><span class="sh-or">${pct(x.open_rate)}</span><button type="button" class="btn btn-ghost btn-sm" data-use="${esc(x.subject)}" title="Reuse as a starting point">Reuse</button></li>`).join('')}</ol>`
          : '<p class="small muted">Send a few posts and your best-performing subject lines will show up here.</p>';
      } catch { panel.innerHTML = '<p class="small muted">Could not load your past subjects.</p>'; }
    });
  }
  window.OHSubjectHelper = { score, init };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
