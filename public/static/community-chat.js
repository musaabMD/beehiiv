// OpenHive community group chat client: real-time messages, typing, presence, reactions, replies, edits, images,
// @mentions, unread marking, reports and moderator actions. Works on publication sites and in the dashboard.
(() => {
  const root = document.getElementById('cc');
  const cfgEl = document.getElementById('cc-config');
  if (!root || !cfgEl) return;
  const cfg = JSON.parse(cfgEl.textContent);
  const $ = (s, el = document) => el.querySelector(s);
  const log = $('#cc-log'), input = $('#cc-input'), form = $('#cc-compose'), typingEl = $('#cc-typing'), statusEl = $('#cc-status'), replyEl = $('#cc-replying'), onlineEl = $('#cc-online');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const me = cfg.me;
  const S = (window.OHChat = { ws: null, msgs: new Map(), order: [], online: [], typing: new Map(), replyTo: null, editing: null, mutedUntil: null, banned: false, pending: new Map(), connected: false, unseen: 0 });

  function status(text, kind) { statusEl.textContent = text || ''; statusEl.className = 'cc-status' + (kind ? ' ' + kind : ''); }
  function send(m) { if (S.ws && S.ws.readyState === 1) { S.ws.send(JSON.stringify(m)); return true; } return false; }

  const linkify = (t) => esc(t).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="nofollow noopener">$1</a>').replace(/(^|\s)@([\p{L}\p{N}_.-]{2,40})/gu, '$1<span class="cc-mention">@$2</span>').replace(/\n/g, '<br>');
  const time = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  function renderMsg(m) {
    const mine = m.author_key === me.key;
    const gone = m.status !== 'visible';
    const el = document.createElement('div');
    el.className = 'cc-msg' + (mine ? ' mine' : '') + (gone ? ' gone' : '') + (m.team ? ' team' : '');
    el.dataset.id = m.id;
    const reactions = Object.entries(m.reactions || {}).map(([e, keys]) => `<button type="button" class="cc-react${keys.includes(me.key) ? ' on' : ''}" data-react="${esc(e)}">${esc(e)} <span>${keys.length}</span></button>`).join('');
    el.innerHTML =
      `<div class="cc-meta"><strong>${esc(m.author_name)}</strong>${m.team ? '<span class="cc-tag">Team</span>' : ''}<time>${time(m.created_at)}</time>${m.edited_at && !gone ? '<em>(edited)</em>' : ''}</div>` +
      (m.reply && !gone ? `<div class="cc-quote" data-jump="${esc(m.reply.id)}">↪ <strong>${esc(m.reply.author_name)}</strong> ${esc(m.reply.body)}</div>` : '') +
      (gone ? `<div class="cc-body cc-removed">${m.status === 'deleted' ? 'Message deleted' : 'Message removed by a moderator'}</div>`
        : `<div class="cc-body">${linkify(m.body)}</div>${m.image_url ? `<a href="${esc(m.image_url)}" target="_blank" rel="noopener"><img class="cc-img" src="${esc(m.image_url)}" alt="Image from ${esc(m.author_name)}" loading="lazy"></a>` : ''}`) +
      (gone ? '' : `<div class="cc-reactions">${reactions}</div>`) +
      (gone ? '' : `<div class="cc-actions">
          <button type="button" data-act="reply">Reply</button>
          <span class="cc-emoji-pick">${cfg.emojis.map((e) => `<button type="button" data-react="${e}" title="React ${e}">${e}</button>`).join('')}</span>
          ${mine ? '<button type="button" data-act="edit">Edit</button><button type="button" data-act="delete">Delete</button>' : '<button type="button" data-act="report">Report</button>'}
          ${me.mod && !mine ? `<button type="button" data-act="mod-delete">Remove</button>${m.author_key.startsWith('s:') ? '<button type="button" data-act="mute">Mute 1h</button><button type="button" data-act="ban">Ban</button>' : ''}` : ''}
        </div>`);
    return el;
  }

  function nearBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 120; }
  function scrollDown(force) { if (force || nearBottom()) log.scrollTop = log.scrollHeight; }

  function upsert(m, opts = {}) {
    const existing = S.msgs.get(m.id);
    S.msgs.set(m.id, m);
    const el = renderMsg(m);
    const old = log.querySelector(`[data-id="${CSS.escape(m.id)}"]`);
    if (old) old.replaceWith(el);
    else {
      log.querySelector('.cc-empty')?.remove();
      const stick = nearBottom() || opts.mine;
      log.appendChild(el);
      if (!existing) S.order.push(m.id);
      if (stick) scrollDown(true);
      else if (!opts.history) { S.unseen++; showJump(); }
    }
  }

  let jumpBtn;
  function showJump() {
    if (!jumpBtn) { jumpBtn = document.createElement('button'); jumpBtn.type = 'button'; jumpBtn.className = 'cc-jump'; jumpBtn.onclick = () => { scrollDown(true); hideJump(); markRead(); }; root.querySelector('.cc-main').appendChild(jumpBtn); }
    jumpBtn.textContent = `${S.unseen} new message${S.unseen === 1 ? '' : 's'} ↓`;
    jumpBtn.hidden = false;
  }
  function hideJump() { S.unseen = 0; if (jumpBtn) jumpBtn.hidden = true; }
  log.addEventListener('scroll', () => { if (nearBottom()) { hideJump(); markRead(); } });

  let readTimer;
  function markRead() {
    if (document.hidden || !nearBottom()) return;
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      send({ type: 'read' });
      document.querySelectorAll('[data-chat-unread]').forEach((b) => b.remove());
    }, 400);
  }
  document.addEventListener('visibilitychange', markRead);

  function renderOnline() {
    $('[data-online-count]', root).textContent = S.online.length;
    onlineEl.innerHTML = S.online.map((o) => `<li><i class="cc-dot"></i>${esc(o.name)}${o.key === me.key ? ' <small>(you)</small>' : ''}${o.mod ? ' <small>· mod</small>' : ''}</li>`).join('') || '<li class="cc-muted">Nobody else here yet</li>';
  }

  function renderTyping() {
    const now = Date.now();
    for (const [k, v] of S.typing) if (now - v.at > 3500) S.typing.delete(k);
    const names = [...S.typing.values()].map((v) => v.name);
    typingEl.textContent = names.length === 0 ? '' : names.length === 1 ? `${names[0]} is typing…` : names.length === 2 ? `${names[0]} and ${names[1]} are typing…` : 'Several people are typing…';
  }
  setInterval(renderTyping, 1000);

  function applyMuted() {
    const muted = S.mutedUntil && S.mutedUntil > Date.now();
    input.disabled = muted || S.banned;
    if (S.banned) status('You can no longer post in this community.', 'err');
    else if (muted) status(`A moderator muted you until ${new Date(S.mutedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`, 'err');
    else if (statusEl.classList.contains('err') && /muted/.test(statusEl.textContent)) status('');
  }

  // ── socket
  let retry = 0;
  function connect() {
    if (S.banned) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${cfg.ws}`);
    S.ws = ws;
    ws.onopen = () => { retry = 0; S.connected = true; root.classList.remove('cc-offline'); if (/Reconnecting/.test(statusEl.textContent)) status(''); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      switch (m.type) {
        case 'welcome':
          log.innerHTML = '';
          S.msgs.clear(); S.order = [];
          if (!m.history.length) log.innerHTML = '<div class="cc-empty">No messages yet — say hello 👋</div>';
          for (const h of m.history) upsert(h, { history: true });
          scrollDown(true);
          S.online = m.online; renderOnline();
          S.mutedUntil = m.muted_until; applyMuted();
          markRead();
          break;
        case 'message': {
          const mine = m.message.author_key === me.key;
          if (m.client_id && S.pending.has(m.client_id)) { S.pending.get(m.client_id).remove(); S.pending.delete(m.client_id); }
          S.typing.delete(m.message.author_key); renderTyping();
          upsert(m.message, { mine });
          if (!mine) markRead();
          break;
        }
        case 'edited': { const x = S.msgs.get(m.id); if (x) { x.body = m.body; x.edited_at = m.edited_at; upsert(x); } break; }
        case 'deleted': { const x = S.msgs.get(m.id); if (x) { x.status = m.status; x.body = ''; x.image_url = null; upsert(x); } break; }
        case 'reactions': { const x = S.msgs.get(m.id); if (x) { x.reactions = m.reactions; upsert(x); } break; }
        case 'typing': if (m.key !== me.key) { S.typing.set(m.key, { name: m.name, at: Date.now() }); renderTyping(); } break;
        case 'presence': S.online = m.online; renderOnline(); break;
        case 'room': if (m.room?.name) $('.cc-title', root).textContent = (m.room.kind === 'group' ? '' : '#') + m.room.name; break;
        case 'muted': S.mutedUntil = m.until; applyMuted(); break;
        case 'banned': S.banned = true; applyMuted(); status(m.reason || 'You were removed from this chat.', 'err'); break;
        case 'error':
          if (m.client_id && S.pending.has(m.client_id)) { const p = S.pending.get(m.client_id); p.classList.add('failed'); S.pending.delete(m.client_id); }
          status(m.message, 'err');
          if (m.code === 'muted') applyMuted();
          break;
        case 'notice': status(m.message, 'ok'); setTimeout(() => statusEl.classList.contains('ok') && status(''), 3000); break;
      }
    };
    ws.onclose = (e) => {
      S.connected = false;
      root.classList.add('cc-offline');
      if (e.code === 4003 || S.banned) return;
      status('Reconnecting…');
      setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
    };
  }
  setInterval(() => send({ type: 'ping' }), 25000);

  // ── composing
  let lastTyping = 0;
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    if (Date.now() - lastTyping > 2500 && input.value.trim()) { lastTyping = Date.now(); send({ type: 'typing' }); }
    mentionSuggest();
  });
  input.addEventListener('keydown', (e) => {
    if (mentionBox && !mentionBox.hidden && (e.key === 'Enter' || e.key === 'Tab') && mentionBox.firstChild) { e.preventDefault(); pickMention(mentionBox.firstChild.dataset.name); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    if (e.key === 'Escape') { setReply(null); setEditing(null); }
    if (e.key === 'ArrowUp' && !input.value) { const last = [...S.order].reverse().map((i) => S.msgs.get(i)).find((x) => x && x.author_key === me.key && x.status === 'visible'); if (last) { e.preventDefault(); setEditing(last); } }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    if (S.editing) {
      send({ type: 'edit', id: S.editing.id, text });
      setEditing(null);
      input.value = '';
      return;
    }
    const client_id = Math.random().toString(36).slice(2);
    if (!send({ type: 'send', text, reply_to: S.replyTo?.id || null, client_id })) { status('Not connected — message not sent.', 'err'); return; }
    const p = document.createElement('div');
    p.className = 'cc-msg mine pending';
    p.innerHTML = `<div class="cc-body">${linkify(text)}</div>`;
    log.querySelector('.cc-empty')?.remove();
    log.appendChild(p);
    S.pending.set(client_id, p);
    scrollDown(true);
    input.value = '';
    input.style.height = 'auto';
    setReply(null);
  });

  function setReply(m) {
    S.replyTo = m;
    if (!m) { replyEl.classList.add('hide'); replyEl.innerHTML = ''; return; }
    replyEl.classList.remove('hide');
    replyEl.innerHTML = `Replying to <strong>${esc(m.author_name)}</strong>: ${esc((m.body || '').slice(0, 80))} <button type="button" data-cancel>✕</button>`;
    input.focus();
  }
  function setEditing(m) {
    S.editing = m;
    if (!m) { replyEl.classList.add('hide'); replyEl.innerHTML = ''; return; }
    setReply(null);
    replyEl.classList.remove('hide');
    replyEl.innerHTML = `Editing your message <button type="button" data-cancel>✕</button>`;
    S.editing = m;
    input.value = m.body;
    input.focus();
  }
  replyEl.addEventListener('click', (e) => { if (e.target.closest('[data-cancel]')) { setReply(null); setEditing(null); input.value = ''; } });

  // ── message actions
  log.addEventListener('click', (e) => {
    const msgEl = e.target.closest('.cc-msg');
    const m = msgEl && S.msgs.get(msgEl.dataset.id);
    const jump = e.target.closest('[data-jump]');
    if (jump) { const t = log.querySelector(`[data-id="${CSS.escape(jump.dataset.jump)}"]`); if (t) { t.scrollIntoView({ block: 'center' }); t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1200); } return; }
    if (!m) return;
    const r = e.target.closest('[data-react]');
    if (r) return send({ type: 'react', id: m.id, emoji: r.dataset.react });
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'reply') setReply(m);
    if (a === 'edit') setEditing(m);
    if (a === 'delete' && confirm('Delete this message?')) send({ type: 'delete', id: m.id });
    if (a === 'mod-delete' && confirm('Remove this message for everyone?')) send({ type: 'delete', id: m.id });
    if (a === 'report') { const reason = prompt('Why are you reporting this message? (optional)'); if (reason !== null) send({ type: 'report', id: m.id, reason }); }
    if (a === 'mute') send({ type: 'mute', key: m.author_key, minutes: 60 });
    if (a === 'ban' && confirm(`Ban ${m.author_name} from community chat?`)) send({ type: 'ban', key: m.author_key });
  });

  // ── images
  $('#cc-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return status('Only PNG, JPEG, GIF or WebP images.', 'err');
    let f = file;
    if (window.OH?.optimizeImage) f = await window.OH.optimizeImage(file, 1600, 0.82);
    if (f.size > 5 * 1024 * 1024) return status('Images must be 5 MB or smaller.', 'err');
    status('Uploading image…');
    const fd = new FormData();
    fd.append('file', f);
    try {
      const r = await fetch(cfg.upload, { method: 'POST', body: fd, credentials: 'same-origin', headers: { accept: 'application/json' } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      send({ type: 'send', text: input.value.trim(), image_url: j.url, reply_to: S.replyTo?.id || null, client_id: Math.random().toString(36).slice(2) });
      input.value = '';
      setReply(null);
      status('');
    } catch (err) { status('Upload failed: ' + err.message, 'err'); }
  });

  // ── @mention suggestions (online people + group members)
  let mentionBox;
  function mentionSuggest() {
    const before = input.value.slice(0, input.selectionStart);
    const mm = before.match(/(^|\s)@([\p{L}\p{N}_.-]{0,40})$/u);
    if (!mm) { if (mentionBox) mentionBox.hidden = true; return; }
    const q = mm[2].toLowerCase();
    const names = [...new Set([...S.online.map((o) => o.name), ...(cfg.mentionables || []), ...[...S.msgs.values()].map((x) => x.author_name)])].filter((n) => n && n !== me.name && n.replace(/\s+/g, '').toLowerCase().includes(q)).slice(0, 6);
    if (!names.length) { if (mentionBox) mentionBox.hidden = true; return; }
    if (!mentionBox) { mentionBox = document.createElement('div'); mentionBox.className = 'cc-mentions'; form.appendChild(mentionBox); mentionBox.addEventListener('mousedown', (e) => { const b = e.target.closest('[data-name]'); if (b) { e.preventDefault(); pickMention(b.dataset.name); } }); }
    mentionBox.innerHTML = names.map((n) => `<button type="button" data-name="${esc(n)}">@${esc(n.replace(/\s+/g, ''))} <small>${esc(n)}</small></button>`).join('');
    mentionBox.hidden = false;
  }
  function pickMention(name) {
    const pos = input.selectionStart;
    const before = input.value.slice(0, pos).replace(/@([\p{L}\p{N}_.-]{0,40})$/u, '@' + name.replace(/\s+/g, '') + ' ');
    input.value = before + input.value.slice(pos);
    input.setSelectionRange(before.length, before.length);
    mentionBox.hidden = true;
    input.focus();
  }

  connect();
})();
