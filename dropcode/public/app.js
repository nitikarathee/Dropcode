(() => {
  'use strict';

  // ---------- constants ----------
  const MAX_DIRECT = 500 * 1024 * 1024;   // per file, device to device
  const MAX_RELAY = 50 * 1024 * 1024;     // per file, through the server
  const DC_CHUNK = 32 * 1024;
  const RELAY_CHUNK = 64 * 1024;
  const DC_BUFFER_LIMIT = 1024 * 1024;
  const DIRECT_WAIT_MS = 6000;            // how long to wait for a direct link before saying "relay"
  const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  const PREVIEW_TYPES = /^image\/(png|jpe?g|gif|webp|avif)$/;
  const forceRelay = new URLSearchParams(location.search).has('relay');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- tiny helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      node.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids) node.append(kid);
    return node;
  }

  function fmtSize(n) {
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  function cleanName(name) {
    const n = String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 180);
    return n || 'file';
  }

  function fileExt(name) {
    const i = name.lastIndexOf('.');
    return i > 0 && i < name.length - 1 ? name.slice(i + 1, i + 5).toUpperCase() : 'FILE';
  }

  function b64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function unb64(str) {
    const s = atob(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = el('textarea', { 'aria-hidden': 'true' });
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
      return ok;
    }
  }

  // ---------- state ----------
  const views = { home: $('#view-home'), wait: $('#view-wait'), live: $('#view-live') };
  const statusBox = $('#status');
  const statusText = $('#status-text');
  const log = $('#log');
  const empty = $('#empty');

  const state = fresh();

  function fresh() {
    return {
      role: null, code: null, peer: null,
      es: null, pc: null, dc: null,
      paired: false, ended: false,
      pendingIce: [],
      outgoing: new Map(), incoming: new Map(),
      nextId: 0, unsaved: 0, unread: 0,
      urls: [],
      directTimer: null, expiryTimer: null,
    };
  }

  function reset() {
    clearTimeout(state.directTimer);
    clearInterval(state.expiryTimer);
    if (state.es) state.es.close();
    if (state.dc) { try { state.dc.close(); } catch { /* ignore */ } }
    if (state.pc) { try { state.pc.close(); } catch { /* ignore */ } }
    for (const u of state.urls) URL.revokeObjectURL(u);
    log.replaceChildren();
    empty.hidden = false;
    Object.assign(state, fresh());
    statusBox.hidden = true;
    $('#compose').hidden = false;
    $('#leave-btn').hidden = false;
    $('#ended').hidden = true;
    $('#home-ticket').classList.remove('tear');
    $('#wait-ticket').classList.remove('tear');
    document.title = 'Dropcode';
  }

  function showView(name) {
    for (const [k, v] of Object.entries(views)) v.hidden = k !== name;
    const h = views[name].querySelector('h1');
    if (h) h.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  function goHome(message) {
    reset();
    showView('home');
    const notice = $('#notice');
    notice.hidden = !message;
    notice.textContent = message || '';
    $('#create-btn').disabled = false;
    $('#join-btn').disabled = false;
  }

  const MODE_TEXT = {
    connecting: ['Connecting', 'Setting up the link between your devices'],
    direct: ['Direct connection', 'Files travel straight between your two devices'],
    relay: ['Through the server', 'Files pass through the Dropcode server on the way and are not stored'],
    ended: ['Disconnected', 'The other device has left'],
  };

  function setMode(mode) {
    if (state.ended && mode !== 'ended') return;
    statusBox.hidden = false;
    statusBox.dataset.mode = mode;
    statusText.textContent = MODE_TEXT[mode][0];
    statusBox.title = MODE_TEXT[mode][1];
  }

  // ---------- server calls ----------
  async function api(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let data = null;
    try { data = await r.json(); } catch { /* no body */ }
    if (!r.ok) {
      const err = new Error((data && data.error) || 'Something went wrong. Try again.');
      err.status = r.status;
      throw err;
    }
    return data;
  }

  async function relayPost(obj) {
    const r = await fetch(`/api/send?code=${state.code}&peer=${state.peer}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(obj),
    });
    if (!r.ok) throw new Error('relay failed');
  }

  // ---------- pairing ----------
  async function createRoom() {
    const j = await api('/api/create');
    state.role = 'host';
    state.code = j.code;
    state.peer = j.peer;
    $('#code').replaceChildren(el('span', {}, j.code.slice(0, 3)), el('span', {}, j.code.slice(3)));
    $('#code').setAttribute('aria-label', `Your code is ${j.code.split('').join(' ')}`);
    $('#site-name').textContent = location.host;
    showView('wait');
    connectEvents();
    let left = j.ttl;
    const tick = () => {
      const m = Math.floor(left / 60);
      const s = String(Math.max(left, 0) % 60).padStart(2, '0');
      $('#expiry').textContent = `${m}:${s}`;
      left -= 1;
    };
    tick();
    state.expiryTimer = setInterval(tick, 1000);
  }

  async function joinRoom(code) {
    const j = await api('/api/join', { code });
    state.role = 'guest';
    state.code = j.code;
    state.peer = j.peer;
    connectEvents();
  }

  function connectEvents() {
    const es = new EventSource(`/api/events?code=${state.code}&peer=${state.peer}`);
    state.es = es;
    es.addEventListener('paired', onPaired);
    es.addEventListener('msg', (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m && m.t === 'sig') onSignal(m); else handleControl(m);
    });
    es.addEventListener('closed', () => onPeerGone());
    es.addEventListener('expired', () => goHome('That code expired. Get a new one to try again.'));
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED && state.es === es) onPeerGone();
    };
  }

  function onPeerGone() {
    if (!state.paired) { goHome('The connection was lost. Get a new code to try again.'); return; }
    if (state.ended) return;
    state.ended = true;
    clearTimeout(state.directTimer);
    if (state.es) state.es.close();
    if (state.dc) { try { state.dc.close(); } catch { /* ignore */ } state.dc = null; }
    if (state.pc) { try { state.pc.close(); } catch { /* ignore */ } state.pc = null; }
    setMode('ended');
    $('#compose').hidden = true;
    $('#leave-btn').hidden = true;
    $('#ended').hidden = false;
    for (const t of state.incoming.values()) t.item.fail('Interrupted');
    state.incoming.clear();
    for (const t of state.outgoing.values()) t.aborted = true;
  }

  function onPaired() {
    if (state.paired) return;
    state.paired = true;
    clearInterval(state.expiryTimer);
    setMode('connecting');
    if (forceRelay) {
      setMode('relay');
    } else {
      startWebRTC();
      state.directTimer = setTimeout(() => {
        if (!state.dc || state.dc.readyState !== 'open') setMode('relay');
      }, DIRECT_WAIT_MS);
    }
    const ticket = state.role === 'host' ? $('#wait-ticket') : $('#home-ticket');
    const go = () => { if (state.paired) showView('live'); };
    if (reducedMotion) {
      go();
    } else {
      ticket.classList.add('tear');
      setTimeout(go, 600);
    }
  }

  // ---------- direct connection (WebRTC) ----------
  function startWebRTC() {
    if (!('RTCPeerConnection' in window)) return;
    let pc;
    try { pc = new RTCPeerConnection({ iceServers: ICE_SERVERS }); } catch { return; }
    state.pc = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) relayPost({ t: 'sig', ice: e.candidate }).catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && !state.ended) setMode('relay');
    };

    if (state.role === 'host') {
      setupChannel(pc.createDataChannel('dropcode', { ordered: true }));
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .then(() => relayPost({ t: 'sig', sdp: pc.localDescription }))
        .catch(() => {});
    } else {
      pc.ondatachannel = (e) => setupChannel(e.channel);
    }
  }

  async function onSignal(m) {
    const pc = state.pc;
    if (!pc) return;
    try {
      if (m.sdp) {
        await pc.setRemoteDescription(m.sdp);
        if (m.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          await relayPost({ t: 'sig', sdp: pc.localDescription });
        }
        for (const ice of state.pendingIce.splice(0)) await pc.addIceCandidate(ice).catch(() => {});
      }
      if (m.ice) {
        if (pc.remoteDescription) await pc.addIceCandidate(m.ice).catch(() => {});
        else state.pendingIce.push(m.ice);
      }
    } catch { /* the relay fallback still works */ }
  }

  function setupChannel(dc) {
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      state.dc = dc;
      clearTimeout(state.directTimer);
      setMode('direct');
    };
    dc.onclose = () => {
      if (state.dc === dc) {
        state.dc = null;
        if (!state.ended) setMode('relay');
      }
    };
    dc.onmessage = (e) => {
      if (typeof e.data === 'string') {
        try { handleControl(JSON.parse(e.data)); } catch { /* ignore */ }
      } else {
        handleBinary(e.data);
      }
    };
  }

  // ---------- sending ----------
  function pickTransport() {
    return state.dc && state.dc.readyState === 'open' ? 'direct' : 'relay';
  }

  async function sendControl(obj, via) {
    if (via === 'direct') {
      if (!state.dc || state.dc.readyState !== 'open') throw new Error('Connection dropped');
      state.dc.send(JSON.stringify(obj));
    } else {
      await relayPost(obj);
    }
  }

  async function sendText(text) {
    const via = pickTransport();
    const item = addItem({ dir: 'out', kind: 'text', text });
    try {
      await sendControl({ t: 'text', text }, via);
      item.done();
    } catch {
      item.fail('Not sent. Check the connection.');
    }
  }

  async function sendFile(file) {
    const via = pickTransport();
    const limit = via === 'direct' ? MAX_DIRECT : MAX_RELAY;
    const item = addItem({ dir: 'out', kind: 'file', name: file.name, size: file.size, mime: file.type, blob: file });
    if (file.size > limit) {
      item.fail(`Too large to send ${via === 'direct' ? 'directly' : 'through the server'} (limit ${fmtSize(limit)})`);
      return;
    }
    const id = state.nextId++;
    const rec = { item, aborted: false };
    state.outgoing.set(id, rec);
    try {
      await sendControl({ t: 'file', id, name: file.name, size: file.size, mime: file.type || '' }, via);
      const chunk = via === 'direct' ? DC_CHUNK : RELAY_CHUNK;
      item.progress(0, file.size);
      for (let off = 0; off < file.size; off += chunk) {
        if (rec.aborted || state.ended) throw new Error('Stopped');
        const buf = await file.slice(off, off + chunk).arrayBuffer();
        if (via === 'direct') {
          const dc = state.dc;
          while (dc && dc.readyState === 'open' && dc.bufferedAmount > DC_BUFFER_LIMIT) await sleep(15);
          if (!dc || dc.readyState !== 'open') throw new Error('Connection dropped');
          const framed = new Uint8Array(4 + buf.byteLength);
          new DataView(framed.buffer).setUint32(0, id);
          framed.set(new Uint8Array(buf), 4);
          dc.send(framed.buffer);
        } else {
          await relayPost({ t: 'chunk', id, d: b64(buf) });
        }
        item.progress(Math.min(off + chunk, file.size), file.size);
      }
      await sendControl({ t: 'end', id }, via);
      item.done();
    } catch (err) {
      if (!rec.aborted) item.fail(state.ended ? 'Interrupted' : 'Failed. Check the connection.');
    } finally {
      state.outgoing.delete(id);
    }
  }

  async function sendFiles(files) {
    for (const f of files) await sendFile(f);
  }

  // ---------- receiving ----------
  function handleControl(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'text':
        if (typeof m.text === 'string') {
          addItem({ dir: 'in', kind: 'text', text: m.text.slice(0, 200000) }).done();
          noteIncoming();
        }
        break;
      case 'file': {
        const id = Number(m.id);
        const size = Number(m.size);
        if (!Number.isInteger(id) || !Number.isFinite(size) || size < 0) return;
        const name = cleanName(m.name);
        const mime = typeof m.mime === 'string' ? m.mime.slice(0, 100) : '';
        const item = addItem({ dir: 'in', kind: 'file', name, size, mime });
        if (size > MAX_DIRECT) {
          item.fail(`Too large to receive (limit ${fmtSize(MAX_DIRECT)})`);
          relayPost({ t: 'abort', id }).catch(() => {});
          return;
        }
        state.incoming.set(id, { item, chunks: [], got: 0, size, name, mime });
        item.progress(0, size);
        noteIncoming();
        break;
      }
      case 'chunk':
        if (typeof m.d === 'string') onChunk(Number(m.id), unb64(m.d));
        break;
      case 'end':
        finishIncoming(Number(m.id));
        break;
      case 'abort': {
        const rec = state.outgoing.get(Number(m.id));
        if (rec) { rec.aborted = true; rec.item.fail('The other device refused this file (too large)'); }
        break;
      }
      default:
    }
  }

  function handleBinary(buf) {
    if (buf.byteLength < 4) return;
    const id = new DataView(buf).getUint32(0);
    onChunk(id, new Uint8Array(buf, 4));
  }

  function onChunk(id, bytes) {
    const t = state.incoming.get(id);
    if (!t) return;
    t.chunks.push(bytes);
    t.got += bytes.byteLength;
    t.item.progress(Math.min(t.got, t.size), t.size);
  }

  function finishIncoming(id) {
    const t = state.incoming.get(id);
    if (!t) return;
    state.incoming.delete(id);
    if (t.got !== t.size) { t.item.fail('Incomplete. Ask the other device to send it again.'); return; }
    const blob = new Blob(t.chunks, { type: t.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    state.urls.push(url);
    state.unsaved += 1;
    t.item.done(url);
  }

  function noteIncoming() {
    if (!document.hidden) return;
    state.unread += 1;
    document.title = `(${state.unread}) Dropcode`;
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { state.unread = 0; document.title = 'Dropcode'; }
  });

  // ---------- transfer list ----------
  function addItem(o) {
    empty.hidden = true;
    const incoming = o.dir === 'in';
    const li = el('li', { class: `item ${o.dir} ${o.kind}` });
    const thumb = el('div', { class: 'thumb', 'aria-hidden': 'true' }, o.kind === 'text' ? 'Aa' : fileExt(o.name));
    const body = el('div', { class: 'body' });
    const act = el('div', { class: 'act' });
    const state_ = el('span', { class: 'state' }, incoming ? 'Received' : 'Sending');
    const bar = el('div', { class: 'bar', hidden: true });
    const fill = el('i');
    bar.append(fill);
    let saveLink = null;
    let saved = false;

    if (o.kind === 'text') {
      body.append(el('p', { class: 'txt' }, o.text));
      body.append(el('div', { class: 'sub' }, state_));
      const copy = el('button', { type: 'button' }, 'Copy');
      copy.addEventListener('click', async () => {
        copy.textContent = (await copyText(o.text)) ? 'Copied' : 'Press Ctrl+C';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1600);
      });
      act.append(copy);
      if (/^https?:\/\/\S+$/i.test(o.text.trim())) {
        act.append(el('a', { href: o.text.trim(), target: '_blank', rel: 'noopener noreferrer' }, 'Open'));
      }
    } else {
      body.append(el('div', { class: 'name' }, o.name));
      body.append(el('div', { class: 'sub' }, el('span', {}, fmtSize(o.size)), state_));
      body.append(bar);
      saveLink = el('a', { class: 'save', hidden: true }, 'Save');
      saveLink.addEventListener('click', () => {
        if (!saved) { saved = true; state.unsaved = Math.max(0, state.unsaved - 1); }
      });
      act.append(saveLink);
      if (!incoming && o.blob && PREVIEW_TYPES.test(o.mime || '')) showPreview(thumb, URL.createObjectURL(o.blob));
    }

    li.append(thumb, body, act);
    log.prepend(li);

    function showPreview(box, url) {
      state.urls.push(url);
      box.replaceChildren(el('img', { src: url, alt: '' }));
    }

    return {
      progress(done, total) {
        bar.hidden = false;
        const pct = total ? Math.round((done / total) * 100) : 100;
        fill.style.width = `${pct}%`;
        state_.textContent = `${incoming ? 'Receiving' : 'Sending'} ${pct}%`;
      },
      done(url) {
        bar.hidden = true;
        state_.textContent = incoming ? 'Received' : 'Sent';
        if (url && saveLink) {
          saveLink.href = url;
          saveLink.download = o.name;
          saveLink.hidden = false;
          if (PREVIEW_TYPES.test(o.mime || '')) showPreview(thumb, url);
        }
      },
      fail(msg) {
        li.classList.add('failed');
        bar.hidden = true;
        state_.textContent = msg;
      },
    };
  }

  // ---------- wiring ----------
  const codeInput = $('#code-input');
  const joinForm = $('#join-form');
  let joining = false;

  function showError(id, msg) {
    const box = $(id);
    box.hidden = !msg;
    box.textContent = msg || '';
  }

  $('#create-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    showError('#create-err', '');
    $('#notice').hidden = true;
    try {
      await createRoom();
    } catch (err) {
      showError('#create-err', err.message);
      btn.disabled = false;
    }
  });

  codeInput.addEventListener('input', () => {
    const d = codeInput.value.replace(/\D/g, '').slice(0, 6);
    codeInput.value = d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d;
    showError('#join-err', '');
    if (d.length === 6) joinForm.requestSubmit();
  });

  joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (joining) return;
    const digits = codeInput.value.replace(/\D/g, '');
    if (digits.length !== 6) { showError('#join-err', 'Enter all six digits.'); return; }
    joining = true;
    $('#join-btn').disabled = true;
    $('#notice').hidden = true;
    try {
      await joinRoom(digits);
    } catch (err) {
      showError('#join-err', err.message);
      $('#join-btn').disabled = false;
      codeInput.focus();
    } finally {
      joining = false;
    }
  });

  $('#cancel-btn').addEventListener('click', async () => {
    if (state.code) {
      await fetch(`/api/leave?code=${state.code}&peer=${state.peer}`, { method: 'POST' }).catch(() => {});
    }
    goHome();
  });

  $('#copy-link').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const ok = await copyText(`${location.origin}/#${state.code}`);
    btn.textContent = ok ? 'Link copied' : 'Copy failed';
    setTimeout(() => { btn.textContent = 'Copy link'; }, 1600);
  });

  $('#leave-btn').addEventListener('click', async () => {
    if (state.unsaved > 0 && !confirm("You have received files you haven't saved yet. Disconnect anyway?")) return;
    if (state.code && !state.ended) {
      await fetch(`/api/leave?code=${state.code}&peer=${state.peer}`, { method: 'POST' }).catch(() => {});
    }
    goHome();
  });

  $('#restart-btn').addEventListener('click', () => {
    if (state.unsaved > 0 && !confirm("You have received files you haven't saved yet. Start over anyway?")) return;
    goHome();
  });

  $('#file-input').addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    e.target.value = '';
    if (files.length) sendFiles(files);
  });

  const textForm = $('#text-form');
  const textInput = $('#text-input');

  textForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = textInput.value;
    if (!text.trim() || state.ended) return;
    textInput.value = '';
    sendText(text.slice(0, 100000));
  });

  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); textForm.requestSubmit(); }
  });

  function liveNow() { return state.paired && !state.ended && !views.live.hidden; }

  const drop = $('#drop');
  window.addEventListener('dragover', (e) => {
    if (!liveNow()) return;
    e.preventDefault();
    drop.classList.add('over');
  });
  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) drop.classList.remove('over');
  });
  window.addEventListener('drop', (e) => {
    if (!liveNow()) return;
    e.preventDefault();
    drop.classList.remove('over');
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) sendFiles(files);
  });

  document.addEventListener('paste', (e) => {
    if (!liveNow()) return;
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
    if (!files.length) return;
    e.preventDefault();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    sendFiles(files.map((f) => {
      if (f.name && f.name !== 'image.png') return f;
      const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      return new File([f], `pasted-${stamp}.${ext}`, { type: f.type });
    }));
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.paired && state.unsaved > 0) { e.preventDefault(); e.returnValue = ''; }
  });

  window.addEventListener('pagehide', () => {
    if (state.code && !state.ended) navigator.sendBeacon(`/api/leave?code=${state.code}&peer=${state.peer}`);
  });

  // ---------- start ----------
  const m = location.hash.match(/^#(\d{6})$/);
  if (m) {
    history.replaceState(null, '', location.pathname + location.search);
    codeInput.value = `${m[1].slice(0, 3)} ${m[1].slice(3)}`;
    joinForm.requestSubmit();
  }
})();
