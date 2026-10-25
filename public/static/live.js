// OpenHive live room: chat + WebRTC one-to-many streaming via the LiveRoom Durable Object (signaling relay).
// Host: camera/mic, screen share (switchable), go live/end, recording (MediaRecorder → R2), moderation.
// Attendee: receives the host stream peer-to-peer, chats, reacts.
(() => {
  const cfgEl = document.getElementById('live-config');
  if (!cfgEl) return;
  const cfg = JSON.parse(cfgEl.textContent);
  const host = cfg.role === 'host';
  const $ = (s, el = document) => el.querySelector(s);
  const root = $('#live');
  const video = $('#live-video');
  const overlay = $('#live-overlay');
  const chatEl = $('#live-chat');
  const chatForm = $('#live-chat-form');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => (window.OH?.toast ? OH.toast(m) : console.log(m));

  const S = (window.OHLive = {
    ws: null, me: null, status: cfg.status || 'scheduled', peers: new Map(), people: new Map(), hostPc: null,
    localStream: null, camTrack: null, micTrack: null, screenTrack: null, recorder: null, chunks: [], removed: false, signals: 0, chat: [], sfuPc: null, sfuBusy: false,
  });
  const rtcConfig = { iceServers: cfg.iceServers || [{ urls: 'stun:stun.cloudflare.com:3478' }] };

  function send(msg) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(msg)); }

  // ───────── UI helpers
  function setStatus(s) {
    S.status = s;
    const b = $('#live-status');
    if (b) { b.textContent = s === 'live' ? '● LIVE' : s === 'ended' ? 'Ended' : 'Scheduled'; b.className = 'live-badge' + (s === 'live' ? ' is-live' : ''); }
    root.dataset.status = s;
    if (host) {
      $('[data-act=golive]')?.classList.toggle('hide', s === 'live');
      $('[data-act=end]')?.classList.toggle('hide', s !== 'live');
    } else {
      if (s === 'ended') {
        showOverlay(cfg.replayUrl ? `The event has ended. <a href="${esc(cfg.replayUrl)}">The replay will be available here.</a>` : 'The event has ended. Thanks for joining!');
        closeHostPc();
      } else if (s !== 'live' && !S.hostPc) showOverlay('Waiting for the host to go live…');
      else if (s === 'live' && !video.srcObject) showOverlay('The host is live — connecting…');
    }
  }
  function showOverlay(html) { overlay.innerHTML = html; overlay.classList.remove('hide'); }
  function hideOverlay() { overlay.classList.add('hide'); }

  function renderMsg(m) {
    const d = document.createElement('div');
    d.className = 'live-msg' + (m.role === 'host' ? ' from-host' : '');
    d.dataset.id = m.id;
    const time = new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    d.innerHTML = `<div class="live-msg-h"><strong>${esc(m.name)}</strong>${m.role === 'host' ? '<span class="live-tag">Host</span>' : ''}<time>${time}</time></div><div class="live-msg-t">${esc(m.text)}</div>` +
      (host ? `<div class="live-msg-a"><button type="button" data-pin="${esc(m.id)}">Pin</button><button type="button" data-del="${esc(m.id)}">Delete</button>${m.role !== 'host' ? `<button type="button" data-mute="${esc(m.uid)}">Mute</button><button type="button" data-remove="${esc(m.uid)}">Remove</button>` : ''}</div>` : '');
    chatEl.appendChild(d);
    chatEl.scrollTop = chatEl.scrollHeight;
  }
  function renderPin(m) {
    const p = $('#live-pin');
    if (!p) return;
    if (!m) { p.classList.add('hide'); p.innerHTML = ''; return; }
    p.classList.remove('hide');
    p.innerHTML = `<span>📌 <strong>${esc(m.name)}:</strong> ${esc(m.text)}</span>${host ? '<button type="button" data-unpin>✕</button>' : ''}`;
  }
  function renderPeople() {
    const ul = $('#live-people');
    if (!ul) return;
    ul.innerHTML = [...S.people.values()].map((p) => `<li><span>${esc(p.name)}${p.muted ? ' <small>(muted)</small>' : ''}</span><span><button type="button" data-mute="${esc(p.uid)}">${p.muted ? 'Unmute' : 'Mute'}</button><button type="button" data-remove="${esc(p.uid)}">Remove</button></span></li>`).join('') || '<li class="muted">No attendees yet</li>';
  }
  function floatEmoji(e) {
    const s = document.createElement('span');
    s.className = 'live-float';
    s.textContent = e;
    s.style.left = 10 + Math.random() * 80 + '%';
    $('.live-stage').appendChild(s);
    setTimeout(() => s.remove(), 2600);
  }

  // ───────── WebRTC
  function newPc(peer) {
    const pc = new RTCPeerConnection(rtcConfig);
    pc.onicecandidate = (e) => { if (e.candidate) send({ type: 'signal', to: peer, data: { candidate: e.candidate } }); };
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState) && host) { S.peers.delete(peer); } };
    return pc;
  }

  async function offerTo(peer) {
    if (!S.localStream) return;
    const old = S.peers.get(peer);
    if (old) try { old.close(); } catch {}
    const pc = newPc(peer);
    S.peers.set(peer, pc);
    S.localStream.getTracks().forEach((t) => pc.addTrack(t, S.localStream));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'signal', to: peer, data: { sdp: pc.localDescription } });
  }

  function closeHostPc() { if (S.hostPc) { try { S.hostPc.close(); } catch {} S.hostPc = null; } }

  async function onSignal(from, data) {
    S.signals++;
    if (host) {
      const pc = S.peers.get(from);
      if (!pc) return;
      if (data.sdp) await pc.setRemoteDescription(data.sdp);
      else if (data.candidate) await pc.addIceCandidate(data.candidate).catch(() => {});
      return;
    }
    // attendee
    if (data.sdp && data.sdp.type === 'offer') {
      closeHostPc();
      const pc = newPc(from);
      S.hostPc = pc;
      pc.ontrack = (e) => {
        if (video.srcObject !== e.streams[0]) {
          video.srcObject = e.streams[0];
          video.muted = true;
          video.play().catch(() => {});
          $('#live-unmute')?.classList.remove('hide');
        }
        hideOverlay();
      };
      await pc.setRemoteDescription(data.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'signal', to: from, data: { sdp: pc.localDescription } });
    } else if (data.candidate && S.hostPc) {
      await S.hostPc.addIceCandidate(data.candidate).catch(() => {});
    }
  }

  function replaceVideoTrack(track) {
    if (S.sfuPc) {
      const sender = S.sfuPc.getSenders().find((x) => x.track && x.track.kind === 'video');
      if (sender && track) sender.replaceTrack(track).catch(() => {});
      else if (track && S.status === 'live') setTimeout(publishSFU, 0);
    }
    for (const pc of S.peers.values()) {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video') || pc.getSenders().find((s) => !s.track);
      if (sender) sender.replaceTrack(track).catch(() => {});
      else if (track && S.localStream) pc.addTrack(track, S.localStream);
    }
    if (!S.localStream) S.localStream = new MediaStream();
    S.localStream.getVideoTracks().forEach((t) => S.localStream.removeTrack(t));
    if (track) S.localStream.addTrack(track);
    video.srcObject = S.localStream;
  }

  // ───────── Cloudflare Realtime SFU (large audiences): host publishes once, attendees pull from the edge
  const SFU = !!cfg.sfu;
  const sfuQuery = (cfg.ws.split('?')[1] || '');
  async function sfuPost(body) {
    const r = await fetch(cfg.sfuEndpoint + (sfuQuery ? '?' + sfuQuery : ''), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.message || j.error || r.status), { status: r.status, code: j.error });
    return j;
  }
  function waitIce(pc, ms = 2500) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((res) => {
      const t = setTimeout(res, ms);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
    });
  }
  function closeSfu() { if (S.sfuPc) { try { S.sfuPc.close(); } catch {} S.sfuPc = null; } }

  async function publishSFU() {
    if (!S.localStream || S.sfuBusy) return;
    S.sfuBusy = true;
    try {
      closeSfu();
      const pc = new RTCPeerConnection(rtcConfig);
      S.sfuPc = pc;
      const trs = S.localStream.getTracks().map((t) => pc.addTransceiver(t, { direction: 'sendonly', streams: [S.localStream] }));
      await pc.setLocalDescription(await pc.createOffer());
      await waitIce(pc);
      const r = await sfuPost({ action: 'publish', sdp: pc.localDescription.sdp, tracks: trs.map((tr) => ({ mid: tr.mid, trackName: tr.sender.track.kind })) });
      await pc.setRemoteDescription(r.answer);
      pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' && S.status === 'live') { toast('Relay connection lost — reconnecting…'); setTimeout(publishSFU, 1500); } };
    } catch (err) { toast('Could not start the relay: ' + err.message); }
    finally { S.sfuBusy = false; }
  }

  async function pullSFU() {
    if (S.sfuBusy) return;
    S.sfuBusy = true;
    try {
      closeSfu();
      const pc = new RTCPeerConnection(rtcConfig);
      S.sfuPc = pc;
      const stream = new MediaStream();
      pc.ontrack = (e) => {
        stream.addTrack(e.track);
        if (video.srcObject !== stream) { video.srcObject = stream; video.muted = true; video.play().catch(() => {}); $('#live-unmute')?.classList.remove('hide'); }
        hideOverlay();
      };
      pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' && S.status === 'live') setTimeout(pullSFU, 2000); };
      const r = await sfuPost({ action: 'pull' });
      await pc.setRemoteDescription(r.offer);
      await pc.setLocalDescription(await pc.createAnswer());
      await waitIce(pc);
      await sfuPost({ action: 'answer', sessionId: r.sessionId, sdp: pc.localDescription.sdp });
    } catch (err) {
      if (err.code === 'not_live') showOverlay('The host is live — waiting for video…');
      else { console.warn('sfu pull failed', err); setTimeout(() => { if (S.status === 'live') pullSFU(); }, 4000); }
    } finally { S.sfuBusy = false; }
  }

  // ───────── socket
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${cfg.ws}`);
    S.ws = ws;
    ws.onmessage = async (ev) => {
      const m = JSON.parse(ev.data);
      switch (m.type) {
        case 'welcome':
          S.me = m.you;
          chatEl.innerHTML = '';
          S.chat = m.chat || [];
          S.chat.forEach(renderMsg);
          renderPin(m.pin);
          $('#live-count').textContent = m.count;
          setStatus(m.status);
          if (m.muted) setMuted(true);
          if (host) {
            S.people = new Map((m.peers || []).map((p) => [p.peer, p]));
            renderPeople();
            if (m.status === 'live' && S.localStream) { if (SFU) publishSFU(); else for (const p of S.people.keys()) offerTo(p); }
          } else if (SFU && m.status === 'live' && m.sfu) pullSFU();
          break;
        case 'sfu':
          if (!host && SFU) { if (m.publication && S.status === 'live') pullSFU(); else if (!m.publication) { closeSfu(); } }
          break;
        case 'chat': S.chat.push(m.message); renderMsg(m.message); break;
        case 'deleted': chatEl.querySelector(`[data-id="${CSS.escape(m.id)}"]`)?.remove(); break;
        case 'cleared': chatEl.innerHTML = ''; renderPin(null); break;
        case 'pin': renderPin(m.message); break;
        case 'count': $('#live-count').textContent = m.count; break;
        case 'stream': setStatus(m.status); if (m.status !== 'live') closeSfu(); break;
        case 'signal': onSignal(m.from, m.data).catch((e) => console.warn('signal error', e)); break;
        case 'peer-joined':
          S.people.set(m.peer, { peer: m.peer, name: m.name, uid: m.uid });
          renderPeople();
          if (!SFU && S.status === 'live' && S.localStream) offerTo(m.peer);
          break;
        case 'peer-left': {
          S.people.delete(m.peer);
          const pc = S.peers.get(m.peer);
          if (pc) try { pc.close(); } catch {}
          S.peers.delete(m.peer);
          renderPeople();
          break;
        }
        case 'peers': S.people = new Map(m.peers.map((p) => [p.peer, p])); renderPeople(); break;
        case 'mute-state': for (const p of S.people.values()) if (p.uid === m.uid) p.muted = m.muted; renderPeople(); break;
        case 'host-left': if (!host && S.status === 'live') { closeHostPc(); video.srcObject = null; showOverlay('The host lost connection — reconnecting…'); } break;
        case 'host-joined': break;
        case 'muted': setMuted(m.muted); toast(m.muted ? 'The host muted you' : 'You can chat again'); break;
        case 'removed': S.removed = true; showOverlay('You were removed from this event by the host.'); closeHostPc(); chatForm.remove(); break;
        case 'reaction': floatEmoji(m.emoji); break;
        case 'error': toast(m.message); break;
      }
    };
    ws.onclose = () => { if (!S.removed) setTimeout(connect, 2000); };
  }

  function setMuted(on) {
    const input = chatForm?.querySelector('input');
    if (input) { input.disabled = on; input.placeholder = on ? 'You are muted' : 'Say something…'; }
  }

  chatForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = chatForm.querySelector('input');
    const text = input.value.trim();
    if (!text) return;
    send({ type: 'chat', text });
    input.value = '';
  });

  document.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t || !root.contains(t)) return;
    if (t.dataset.react) send({ type: 'reaction', emoji: t.dataset.react });
    if (!host) return;
    if (t.dataset.pin) send({ type: 'pin', id: t.dataset.pin });
    if (t.hasAttribute('data-unpin')) send({ type: 'pin', id: null });
    if (t.dataset.del) send({ type: 'delete', id: t.dataset.del });
    if (t.dataset.mute) send({ type: 'mute', uid: t.dataset.mute });
    if (t.dataset.remove && confirm('Remove this attendee from the event?')) send({ type: 'remove', uid: t.dataset.remove });
  });

  $('#live-unmute')?.addEventListener('click', (e) => { video.muted = false; video.play().catch(() => {}); e.currentTarget.classList.add('hide'); });

  // ───────── host controls
  if (host) {
    const btn = (a) => $(`[data-act=${a}]`);
    const enable = () => { ['mic', 'cam', 'record', 'golive'].forEach((a) => (btn(a).disabled = !S.localStream)); };

    btn('camera').onclick = async () => {
      try {
        const cam = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: { echoCancellation: true, noiseSuppression: true } });
        S.camTrack = cam.getVideoTracks()[0];
        S.micTrack = cam.getAudioTracks()[0];
        S.localStream = new MediaStream([S.screenTrack || S.camTrack, S.micTrack].filter(Boolean));
        video.srcObject = S.localStream;
        video.muted = true;
        hideOverlay();
        btn('camera').textContent = '🎥 Camera on';
        btn('camera').disabled = true;
        enable();
        if (S.status === 'live') { if (SFU) publishSFU(); else for (const p of S.people.keys()) offerTo(p); }
        // Host reloaded the studio while already live: resume automatic recording as a new session.
        if (S.status === 'live' && cfg.autoRecord) S.startRecording?.(true);
      } catch (err) { toast('Camera/mic unavailable: ' + err.message); }
    };
    btn('mic').onclick = () => {
      if (!S.micTrack) return;
      S.micTrack.enabled = !S.micTrack.enabled;
      btn('mic').textContent = S.micTrack.enabled ? '🎙 Mute mic' : '🔇 Unmute mic';
    };
    btn('cam').onclick = () => {
      if (!S.camTrack) return;
      S.camTrack.enabled = !S.camTrack.enabled;
      btn('cam').textContent = S.camTrack.enabled ? '📷 Camera off' : '📷 Camera on';
    };
    btn('screen').onclick = async () => {
      if (S.screenTrack) { S.screenTrack.stop(); return; }
      try {
        const scr = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
        S.screenTrack = scr.getVideoTracks()[0];
        replaceVideoTrack(S.screenTrack);
        hideOverlay();
        btn('screen').textContent = '🖥 Stop sharing';
        enable();
        S.screenTrack.onended = () => {
          S.screenTrack = null;
          btn('screen').textContent = '🖥 Share screen';
          replaceVideoTrack(S.camTrack || null);
          if (!S.camTrack) showOverlay('Start your camera or share your screen');
        };
        if (S.status === 'live' && !SFU) for (const p of S.people.keys()) if (!S.peers.has(p)) offerTo(p);
      } catch (err) { if (err.name !== 'NotAllowedError') toast('Screen share failed: ' + err.message); }
    };
    btn('golive').onclick = () => {
      if (!S.localStream) return toast('Start your camera or share your screen first');
      send({ type: 'stream', status: 'live' });
      if (SFU) publishSFU(); else for (const p of S.people.keys()) offerTo(p);
      toast(SFU ? 'You are live — relayed through Cloudflare' : 'You are live!');
      if (cfg.autoRecord) startRecording(true);
    };
    btn('end').onclick = () => {
      if (!confirm('End the event for everyone?')) return;
      send({ type: 'stream', status: 'ended' });
      if (SFU) { sfuPost({ action: 'unpublish' }).catch(() => {}); closeSfu(); }
      for (const pc of S.peers.values()) try { pc.close(); } catch {}
      S.peers.clear();
      stopRecording();
    };

    // Recording: composite whatever is on stage (camera or screen) via a canvas, plus mic audio. Chunks (every 4 s) are
    // uploaded as they are produced, so a closed tab loses at most a few seconds; the server stitches them on finish.
    const REC = { id: null, chunkUrl: null, finishUrl: null, seq: 0, queue: Promise.resolve(), timer: null, failed: 0, starting: false };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    function uploadChunk(blob) {
      const seq = REC.seq++, url = REC.chunkUrl;
      REC.queue = REC.queue.then(async () => {
        for (let attempt = 0; attempt < 6; attempt++) {
          try {
            const r = await fetch(`${url}?seq=${seq}`, { method: 'POST', body: blob, headers: { 'content-type': 'application/octet-stream', accept: 'application/json' }, credentials: 'same-origin' });
            if (r.ok || r.status === 409) return;
          } catch {}
          await sleep(Math.min(1000 * 2 ** attempt, 15000));
        }
        REC.failed++;
        toast('A piece of the recording failed to upload — check your connection.');
      });
    }
    async function startRecording(auto) {
      if (REC.starting || (S.recorder && S.recorder.state !== 'inactive') || !S.localStream || !window.MediaRecorder) return;
      REC.starting = true;
      const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
      try {
        const r = await fetch(`${cfg.recordBase}/start`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ auto: !!auto, mime: mime || 'video/webm' }) });
        const j = await r.json();
        if (!r.ok || !j.id) throw new Error(j.error || r.status);
        Object.assign(REC, { id: j.id, chunkUrl: j.chunkUrl, finishUrl: j.finishUrl, seq: 0, failed: 0 });
      } catch (err) { REC.starting = false; toast('Could not start recording: ' + err.message); return; }
      const canvas = document.createElement('canvas');
      canvas.width = 1280; canvas.height = 720;
      const ctx = canvas.getContext('2d');
      const draw = () => {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (video.videoWidth) {
          const r = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
          const w = video.videoWidth * r, h = video.videoHeight * r;
          ctx.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
        }
      };
      REC.timer = setInterval(draw, 1000 / 30);
      const recStream = canvas.captureStream(30);
      if (S.micTrack) recStream.addTrack(S.micTrack);
      S.recorder = new MediaRecorder(recStream, mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000 } : undefined);
      S.recorder.ondataavailable = (e) => { if (e.data.size) uploadChunk(e.data); };
      S.recorder.onstop = () => {
        clearInterval(REC.timer);
        $('#live-rec').classList.add('hide');
        btn('record').textContent = '⏺ Record';
        const finishUrl = REC.finishUrl;
        REC.id = null;
        toast('Saving recording…');
        REC.queue = REC.queue.then(async () => {
          try {
            const r = await fetch(finishUrl, { method: 'POST', headers: { accept: 'application/json' }, credentials: 'same-origin' });
            toast(r.ok ? 'Recording saved — it will appear under Recording & replay in a moment' : 'Saving the recording failed (' + r.status + ')');
          } catch (err) { toast('Saving the recording failed: ' + err.message); }
        });
      };
      S.recorder.start(4000);
      REC.starting = false;
      $('#live-rec').classList.remove('hide');
      $('#live-rec').textContent = auto ? '● REC (auto)' : '● REC';
      btn('record').textContent = '⏹ Stop recording';
    }
    function stopRecording() { if (S.recorder && S.recorder.state !== 'inactive') S.recorder.stop(); }
    S.startRecording = startRecording;
    S.stopRecording = stopRecording;
    btn('record').onclick = () => { if (S.recorder && S.recorder.state !== 'inactive') stopRecording(); else startRecording(false); };
    // Tab closing mid-session: flush what we have and ask the server to stitch it (it also sweeps abandoned sessions).
    window.addEventListener('pagehide', () => {
      if (!REC.id || !S.recorder || S.recorder.state === 'inactive') return;
      try { S.recorder.requestData(); } catch {}
      try { navigator.sendBeacon(REC.finishUrl + '?late=1'); } catch {}
    });
    setInterval(() => send({ type: 'peers' }), 30000);
  }

  setInterval(() => send({ type: 'ping', t: Date.now() }), 25000);
  connect();
})();
