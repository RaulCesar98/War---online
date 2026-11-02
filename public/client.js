(async () => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const NS = 'http://www.w3.org/2000/svg';

  const MAP = await fetch('/api/map').then((r) => r.json());
  const TERR = Object.fromEntries(MAP.territories.map((t) => [t.id, t]));
  const ADJ = {};
  MAP.territories.forEach((t) => { ADJ[t.id] = []; });
  MAP.edges.forEach(([a, b]) => { ADJ[a].push(b); ADJ[b].push(a); });
  const SYM = { triangulo: '▲', quadrado: '■', circulo: '●', coringa: '★' };
  const PHASES = [['reinforce', 'Reforço'], ['attack', 'Ataque'], ['fortify', 'Remanejamento']];

  const socket = io();
  let ROOM = null;
  let S = null;
  let sel = { a: null, b: null };
  let selKey = '';
  let qty = 1;
  let dice = 3;
  let handSel = new Set();
  let prevTerr = null;
  let seenCombat = 0;
  let tab = 'log';
  let objHidden = false;
  let rulesOpen = false;
  let rulesTab = 'visao';
  let modalKey = '';
  let winDismissed = false;
  let occupyKey = '';
  let occupyN = 0;
  let wasMyTurn = false;
  let chatSeen = 0;
  const X = MAP.expanded;
  let mode = null; // { kind: 'fire', from } | { kind: 'card', card, def, from, to }
  let treeOpen = false;
  let treeTab = 'tech';
  const ACTIVE_PHASES = ['reinforce', 'attack', 'fortify'];

  // ---------- relógio da fase, sons e animações ----------

  const REDUCED = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const sfx = (name) => { if (window.SFX) window.SFX.play(name); };
  let fxLayer = null;
  let lastSeq = null; // último evento do registro já tratado (sons/efeitos)
  let lastChatLen = null;
  let timerEnd = 0;
  let timerTotal = 60000;
  let lastTick = -1;
  let bannerKey = '';
  let bannerFlipUntil = 0;
  let prevCardIds = null;
  let prevActionIds = null;
  const dealUntil = {};

  function showMuteState() {
    const b = $('#muteFab');
    const m = !!(window.SFX && window.SFX.isMuted());
    b.textContent = m ? '🔇' : '🔊';
    b.classList.toggle('off', m);
  }
  $('#muteFab').onclick = () => {
    window.SFX.setMuted(!window.SFX.isMuted());
    showMuteState();
    sfx('select');
  };
  showMuteState();
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && !b.disabled && b.id !== 'muteFab') sfx('click');
  });

  // --- efeitos no mapa (camada SVG acima das comunidades) ---

  function fxFloat(id, text, col) {
    if (REDUCED || !fxLayer) return;
    const t = TERR[id];
    const e = el('text', { class: 'fx-float', x: t.x, y: t.y - 24, fill: col }, fxLayer);
    e.textContent = text;
    setTimeout(() => e.remove(), 1250);
  }

  function fxRing(id, col, big) {
    if (REDUCED || !fxLayer) return;
    const t = TERR[id];
    const c = el('circle', { class: 'fx-ring', cx: t.x, cy: t.y, r: big ? 26 : 20, stroke: col }, fxLayer);
    setTimeout(() => c.remove(), 900);
  }

  function fxClass(id, cls, ms) {
    const g = nodeEls[id];
    if (!g || REDUCED) return;
    g.classList.remove(cls);
    void g.getBBox();
    g.classList.add(cls);
    setTimeout(() => g.classList.remove(cls), ms);
  }
  const fxShake = (id) => fxClass(id, 'shake', 500);
  const fxPulse = (id) => fxClass(id, 'pulse', 550);

  function popBadge(id) {
    const wb = nodeEls[id] && $('.wbadge', nodeEls[id]);
    if (!wb || REDUCED) return;
    wb.classList.add('pop');
    setTimeout(() => wb.classList.remove('pop'), 700);
  }

  // projétil que atravessa o mapa de uma comunidade à outra
  function fxShot(from, to, col, onEnd) {
    if (REDUCED || !fxLayer || !g_anim()) { if (onEnd) onEnd(); return; }
    const a = TERR[from];
    const b = TERR[to];
    const g = el('g', {}, fxLayer);
    el('circle', { class: 'fx-shot', r: 6, fill: col, style: `color:${col}` }, g);
    const anim = g.animate(
      [{ transform: `translate(${a.x}px, ${a.y}px)` }, { transform: `translate(${b.x}px, ${b.y}px)` }],
      { duration: 430, easing: 'ease-in', fill: 'forwards' },
    );
    anim.onfinish = () => { g.remove(); if (onEnd) onEnd(); };
  }
  const g_anim = () => typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';

  function confetti() {
    if (REDUCED) return;
    const cv = document.createElement('canvas');
    cv.className = 'confetti';
    cv.width = window.innerWidth;
    cv.height = window.innerHeight;
    document.body.appendChild(cv);
    const cx = cv.getContext('2d');
    const parts = Array.from({ length: 150 }, () => ({
      x: Math.random() * cv.width,
      y: -20 - Math.random() * cv.height * 0.6,
      vx: (Math.random() - 0.5) * 3,
      vy: 2 + Math.random() * 4,
      s: 6 + Math.random() * 8,
      r: Math.random() * 6,
      vr: (Math.random() - 0.5) * 0.3,
      c: MAP.colors[Math.floor(Math.random() * MAP.colors.length)].hex,
    }));
    const t0 = performance.now();
    (function frame(t) {
      cx.clearRect(0, 0, cv.width, cv.height);
      parts.forEach((p) => {
        p.x += p.vx; p.y += p.vy; p.vy += 0.05; p.r += p.vr;
        cx.save();
        cx.translate(p.x, p.y);
        cx.rotate(p.r);
        cx.fillStyle = p.c;
        cx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6);
        cx.restore();
      });
      if (t - t0 < 4500) requestAnimationFrame(frame); else cv.remove();
    }(t0));
  }

  // animação e sons de um combate recém-resolvido
  function fxCombat(c) {
    sfx('dice');
    fxPulse(c.from);
    fxShot(c.from, c.to, '#ff5a5f', () => {
      fxShake(c.to);
      fxRing(c.to, c.conquered ? '#7dffa8' : '#ff9d2e');
    });
    const hits = Math.min(4, c.lossA + c.lossD);
    for (let k = 0; k < hits; k++) setTimeout(() => sfx('hit'), 480 + k * 130);
  }

  // sons e efeitos de cada tipo de evento do registro (valem para todos os jogadores)
  function handleEvent(l) {
    const m = l.m || {};
    const col = l.p !== null && l.p !== undefined && S.players[l.p] ? color(S.players[l.p].color).hex : '#ffffff';
    switch (l.k) {
      case 'turn': sfx(m.player === me() ? 'turn' : 'phase'); break;
      case 'start': sfx('start'); toast('A guerra começou!'); break;
      case 'ready': sfx('ready'); break;
      case 'conquer': setTimeout(() => sfx('conquer'), REDUCED ? 0 : 700); if (m.to) fxRing(m.to, col, true); break;
      case 'destroy': sfx('sabotage'); if (m.to) { fxShake(m.to); fxFloat(m.to, '💥', '#ffffff'); } break;
      case 'eliminate': sfx('eliminate'); toast(l.t); break;
      case 'win':
        sfx(S.winner === me() ? 'win' : 'lose');
        if (S.winner === me()) confetti();
        break;
      case 'fire':
        sfx('fire');
        if (m.from && m.to) fxShot(m.from, m.to, '#ffb347', () => { fxRing(m.to, '#ff7a3c', true); fxShake(m.to); });
        break;
      case 'build': sfx('build'); if (m.to) { fxRing(m.to, '#f0b429'); popBadge(m.to); } break;
      case 'tech': case 'unlock': sfx('tech'); break;
      case 'card': sfx('draw'); break;
      case 'draw': if (l.p === me()) sfx('draw'); break;
      case 'trade': sfx('trade'); break;
      case 'spy': sfx('spy'); break;
      case 'sabotage': sfx('sabotage'); if (m.to) { fxRing(m.to, '#d93a3a', true); fxShake(m.to); } break;
      case 'truce': sfx('truce'); break;
      case 'rage': sfx('rage'); break;
      case 'move': sfx('move'); if (m.from && m.to) fxShot(m.from, m.to, '#cfe8ff'); break;
      case 'place': if (m.to) fxRing(m.to, '#7dffa8'); break;
      case 'auto': sfx('timeout'); toast(l.t); break;
      default:
    }
  }

  function processEvents() {
    if (lastSeq === null) { lastSeq = S.logSeq; return; }
    const fresh = S.log.filter((l) => l.n > lastSeq);
    lastSeq = S.logSeq;
    if (fresh.length > 14) return; // muitos eventos de uma vez (reconexão): não toca tudo junto
    fresh.forEach(handleEvent);
  }

  // --- relógio ---

  function tickTimer() {
    const box = $('#timer');
    if (!S || S.phase === 'over' || !timerEnd) { box.classList.add('hidden'); return; }
    const rem = Math.max(0, timerEnd - Date.now());
    const secs = Math.ceil(rem / 1000);
    const waitingMe = S.phase === 'setup' ? !myReady() : myTurn();
    box.classList.remove('hidden');
    $('#timerFill').style.width = `${Math.min(100, (rem / timerTotal) * 100)}%`;
    box.classList.toggle('warn', secs <= 20 && secs > 10);
    box.classList.toggle('urgent', secs <= 10);
    const who = S.phase === 'setup' ? 'Preparação' : waitingMe ? 'Sua vez' : S.players[S.turn].name;
    $('#timerText').textContent = `⏱ ${secs}s · ${who}`;
    if (waitingMe && secs <= 10 && secs > 0 && secs !== lastTick) {
      lastTick = secs;
      sfx(secs <= 3 ? 'tickUrgent' : 'tick');
    }
    if (secs > 10) lastTick = -1;
  }
  setInterval(tickTimer, 250);

  // ---------- regras de alcance (espelham o servidor) ----------

  const distCache = {};
  function dist(a, b) {
    if (!distCache[a]) {
      const d = { [a]: 0 };
      const q = [a];
      while (q.length) {
        const c = q.shift();
        ADJ[c].forEach((n) => { if (d[n] === undefined) { d[n] = d[c] + 1; q.push(n); } });
      }
      distCache[a] = d;
    }
    return distCache[a][b];
  }
  const hasTech = (id) => !!S && S.expanded && S.players[S.me.idx].techs.includes(id);
  const canReach = (from, to) => ADJ[from].includes(to) || (S.expanded && S.terr[from].w === 'caca' && dist(from, to) <= 2);
  function connectedOwn(from, to) {
    const seen = new Set([from]);
    const q = [from];
    while (q.length) {
      const c = q.shift();
      if (c === to) return true;
      ADJ[c].forEach((n) => { if (!seen.has(n) && S.terr[n].o === S.me.idx) { seen.add(n); q.push(n); } });
    }
    return false;
  }
  const canFortify = (from, to) => from !== to && (hasTech('ferrovias') ? connectedOwn(from, to) : ADJ[from].includes(to));
  function fireTargets(from) {
    const w = X.weapons[S.terr[from].w];
    if (!w || w.kind !== 'active') return [];
    return MAP.territories.map((t) => t.id)
      .filter((id) => S.terr[id].o !== S.me.idx && dist(from, id) <= w.range && S.terr[id].w !== 'antiaereo' && S.terr[id].a > 1);
  }
  // alvos válidos da Sabotagem: inimigo sem Rede de olheiros, com arma ou ao menos 2 soldados
  const sabotageTargets = () => MAP.territories.map((t) => t.id)
    .filter((id) => S.terr[id].o !== S.me.idx && S.terr[id].w !== 'antiaereo' && (S.terr[id].w || S.terr[id].a > 1));

  // ---------- utilidades ----------

  const loadSession = () => { try { return JSON.parse(localStorage.getItem('war.session')); } catch { return null; } };
  const saveSession = (s) => { try { localStorage.setItem('war.session', JSON.stringify(s)); } catch { /* ignora */ } };
  const clearSession = () => { try { localStorage.removeItem('war.session'); } catch { /* ignora */ } };

  let toastTimer;
  function toast(msg, err) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('err', !!err);
    el.classList.add('show');
    if (err) sfx('error');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function showScreen(name) {
    ['home', 'lobby', 'game'].forEach((s) => $('#' + s).classList.toggle('hidden', s !== name));
  }

  const color = (i) => MAP.colors[i % MAP.colors.length];
  const dot = (i) => `<span class="dot" style="background:${color(i).hex}"></span>`;
  const me = () => S.me.idx;
  const myTurn = () => S.turn === me() && S.phase !== 'over';
  const meInfo = () => S.players[me()];
  const myReady = () => meInfo().ready;

  function send(action) {
    socket.emit('action', action, (res) => { if (!res || !res.ok) toast((res && res.error) || 'Jogada inválida.', true); });
  }

  // ---------- conexão ----------

  socket.on('connect', () => {
    $('#conn').classList.add('hidden');
    const s = loadSession();
    if (s) {
      socket.emit('rejoin', s, (res) => {
        if (!res || !res.ok) { clearSession(); ROOM = null; S = null; showScreen('home'); }
      });
    } else {
      showScreen('home');
    }
  });
  socket.on('disconnect', () => $('#conn').classList.remove('hidden'));

  socket.on('room', (r) => {
    if (lastChatLen !== null && r.chat.length > lastChatLen) sfx('chat');
    lastChatLen = r.chat.length;
    ROOM = r;
    if (!r.started) {
      S = null;
      lastSeq = null;
      timerEnd = 0;
      prevTerr = null;
      winDismissed = false;
      treeOpen = false;
      mode = null;
      renderLobby();
      showScreen('lobby');
      if (!rulesOpen) closeModal();
    } else if (S) {
      renderPlayers();
      renderChat();
    }
  });

  socket.on('state', (st) => {
    const first = !S;
    S = st;
    if (st.timer && st.timer.deadline) {
      timerEnd = Date.now() + (st.timer.deadline - st.timer.now);
      timerTotal = Math.max(1000, st.timer.total || 60000);
    } else {
      timerEnd = 0;
    }
    if (first) { lastSeq = null; prevCardIds = null; prevActionIds = null; showScreen('game'); seenCombat = (S.lastCombat && S.lastCombat.id) || 0; chatSeen = ROOM ? ROOM.chat.length : 0; }
    renderGame();
  });

  // ---------- início / sala ----------

  const nameInput = $('#nameInput');
  const codeInput = $('#codeInput');
  try { nameInput.value = localStorage.getItem('war.name') || ''; } catch { /* ignora */ }
  const urlCode = new URLSearchParams(location.search).get('sala');
  if (urlCode) codeInput.value = urlCode.toUpperCase().slice(0, 4);

  function enter(res) {
    if (!res || !res.ok) return toast((res && res.error) || 'Não foi possível entrar.', true);
    saveSession({ code: res.code, token: res.token });
    try { localStorage.setItem('war.name', nameInput.value.trim()); } catch { /* ignora */ }
    history.replaceState(null, '', location.pathname);
  }
  $('#createBtn').onclick = () => socket.emit('createRoom', { name: nameInput.value }, enter);
  $('#joinBtn').onclick = () => socket.emit('joinRoom', { name: nameInput.value, code: codeInput.value }, enter);
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#joinBtn').click(); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') (codeInput.value ? $('#joinBtn') : $('#createBtn')).click(); });
  $('#rulesHomeBtn').onclick = () => { rulesOpen = true; renderModal(); };
  $('#rulesLobbyBtn').onclick = () => { rulesOpen = true; renderModal(); };

  $('#copyLinkBtn').onclick = async () => {
    const url = `${location.origin}/?sala=${ROOM.code}`;
    try { await navigator.clipboard.writeText(url); toast('Link copiado!'); } catch { toast(url); }
  };
  $('#startBtn').onclick = () => socket.emit('startGame', {}, (res) => { if (!res.ok) toast(res.error, true); });
  $('#leaveLobbyBtn').onclick = () => { socket.emit('leaveRoom'); clearSession(); ROOM = null; S = null; showScreen('home'); };
  $('#expandedChk').onchange = (e) => socket.emit('setOptions', { expanded: e.target.checked }, (r) => { if (!r.ok) toast(r.error, true); });

  function renderLobby() {
    $('#lobbyCode').textContent = ROOM.code;
    $('#lobbyPlayers').innerHTML = ROOM.players.map((p) => `
      <li>${dot(p.idx)}<span style="flex:1">${esc(p.name)}${p.idx === ROOM.me.idx ? ' (você)' : ''}<small class="faction">${esc(color(p.idx).faction)}</small></span>
      ${p.isHost ? '<span class="badge">anfitrião</span>' : ''}
      ${p.connected ? '' : '<span class="badge off">offline</span>'}</li>`).join('');
    const online = ROOM.players.filter((p) => p.connected).length;
    const host = ROOM.me.isHost;
    $('#expandedChk').checked = !!ROOM.expanded;
    $('#expandedChk').disabled = !host;
    $('#expandedRow').classList.toggle('off', !host);
    $('#startBtn').classList.toggle('hidden', !host);
    $('#startBtn').disabled = online < 2;
    $('#lobbyHint').textContent = host
      ? (online < 2 ? `Compartilhe o código com seus amigos. A partida comporta de 2 a ${MAP.maxPlayers} jogadores (${ROOM.players.length}/${MAP.maxPlayers} na sala).` : `${online} jogador(es) prontos. Inicie quando todos entrarem.`)
      : 'Aguardando o anfitrião iniciar a partida…';
  }

  // ---------- mapa ----------

  const nodeEls = {};
  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    Object.entries(attrs || {}).forEach(([k, v]) => e.setAttribute(k, v));
    if (parent) parent.appendChild(e);
    return e;
  }

  function buildMap() {
    const svg = $('#map');
    svg.innerHTML = '';
    const defs = el('defs', {}, svg);
    const grad = el('radialGradient', { id: 'ocean', cx: '50%', cy: '40%', r: '75%' }, defs);
    el('stop', { offset: '0%', 'stop-color': '#27243f' }, grad);
    el('stop', { offset: '100%', 'stop-color': '#0c0e1b' }, grad);
    el('rect', { x: 0, y: 0, width: 1000, height: 600, fill: 'url(#ocean)' }, svg);

    // manchas dos regiões
    const blobs = el('g', { opacity: 0.3 }, svg);
    MAP.edges.forEach(([a, b]) => {
      const A = TERR[a]; const B = TERR[b];
      if (A.continent !== B.continent) return;
      el('line', { x1: A.x, y1: A.y, x2: B.x, y2: B.y, stroke: MAP.continents[A.continent].color, 'stroke-width': 62, 'stroke-linecap': 'round' }, blobs);
    });
    MAP.territories.forEach((t) => el('circle', { cx: t.x, cy: t.y, r: 31, fill: MAP.continents[t.continent].color }, blobs));

    // fronteiras
    const lines = el('g', { stroke: 'rgba(255,255,255,.35)', 'stroke-width': 1.6 }, svg);
    MAP.edges.forEach(([a, b]) => {
      const A = TERR[a]; const B = TERR[b];
      if (Math.abs(A.x - B.x) > 500) { // ligação que dá a volta no mapa
        const [L, R] = A.x < B.x ? [A, B] : [B, A];
        el('line', { x1: L.x, y1: L.y, x2: 0, y2: L.y + 12, 'stroke-dasharray': '5 4' }, lines);
        el('line', { x1: R.x, y1: R.y, x2: 1000, y2: R.y - 12, 'stroke-dasharray': '5 4' }, lines);
      } else {
        el('line', { x1: A.x, y1: A.y, x2: B.x, y2: B.y, 'stroke-dasharray': A.continent === B.continent ? '' : '6 4' }, lines);
      }
    });

    // comunidades
    MAP.territories.forEach((t) => {
      const g = el('g', { class: 'node', 'data-id': t.id }, svg);
      el('circle', { class: 'halo', cx: t.x, cy: t.y, r: 27 }, g);
      el('circle', { class: 'body', cx: t.x, cy: t.y, r: 21, fill: '#666' }, g);
      const army = el('text', { class: 'army', x: t.x, y: t.y + 1 }, g);
      army.textContent = '';
      const label = el('text', { class: 'label', x: t.x, y: t.y + 36 }, g);
      label.textContent = t.name;
      const wb = el('g', { class: 'wbadge', transform: `translate(${t.x + 17},${t.y - 17})`, style: 'display:none' }, g);
      el('circle', { r: 10 }, wb);
      el('text', {}, wb);
      g.addEventListener('click', () => onTerritory(t.id));
      nodeEls[t.id] = g;
    });
    fxLayer = el('g', { id: 'fx', 'pointer-events': 'none' }, svg);
  }

  function updateMap() {
    let armiesUp = false;
    MAP.territories.forEach((t) => {
      const g = nodeEls[t.id];
      const s = S.terr[t.id];
      const c = color(s.o);
      const body = $('.body', g);
      const army = $('.army', g);
      body.setAttribute('fill', c.hex);
      army.setAttribute('fill', c.text);
      const showing = S.pendingMove && S.pendingMove.to === t.id ? 0 : s.a;
      army.textContent = showing;
      if (prevTerr) {
        const pv = prevTerr[t.id];
        if (pv.a !== s.a || pv.o !== s.o) { g.classList.remove('flash'); void g.getBBox(); g.classList.add('flash'); }
        if (pv.o !== s.o) {
          fxRing(t.id, c.hex, true);
        } else if (pv.a !== s.a) {
          const d = s.a - pv.a;
          fxFloat(t.id, d > 0 ? `+${d}` : `${d}`, d > 0 ? '#7dffa8' : '#ff7a7a');
          if (d > 0) armiesUp = true;
        }
        if (s.w && pv.w !== s.w) popBadge(t.id);
      }
      g.classList.remove('sel', 'sel2', 'target', 'ally', 'dim', 'fire-target');
      const wb = $('.wbadge', g);
      if (S.expanded && s.w) {
        wb.style.display = '';
        $('text', wb).textContent = X.weapons[s.w].icon;
        wb.classList.toggle('fired', !!s.f);
      } else {
        wb.style.display = 'none';
      }
    });
    // seleção e alvos
    if (sel.a) nodeEls[sel.a].classList.add('sel');
    if (sel.b) nodeEls[sel.b].classList.add('sel2');
    if (sel.a && myTurn() && !mode) {
      if (S.phase === 'attack' && !S.pendingMove) {
        MAP.territories.map((t) => t.id).filter((n) => S.terr[n].o !== me() && canReach(sel.a, n))
          .forEach((n) => nodeEls[n].classList.add('target'));
      } else if (S.phase === 'fortify') {
        MAP.territories.map((t) => t.id).filter((n) => S.terr[n].o === me() && canFortify(sel.a, n))
          .forEach((n) => nodeEls[n].classList.add('ally'));
      }
    }
    if (mode && myTurn()) {
      if (mode.kind === 'fire') fireTargets(mode.from).forEach((n) => nodeEls[n].classList.add('fire-target'));
      else if (mode.def.target === 'territory') {
        sabotageTargets().forEach((n) => nodeEls[n].classList.add('fire-target'));
      } else if (mode.def.target === 'move') {
        if (mode.from) nodeEls[mode.from].classList.add('sel');
        if (mode.to) nodeEls[mode.to].classList.add('sel2');
      }
    }
    if (armiesUp) sfx('place');
    prevTerr = JSON.parse(JSON.stringify(S.terr));

    // legenda de regiões
    $('#legend').innerHTML = Object.entries(MAP.continents).map(([k, c]) => {
      const ts = MAP.territories.filter((t) => t.continent === k);
      const owners = new Set(ts.map((t) => S.terr[t.id].o));
      const holder = owners.size === 1 ? [...owners][0] : null;
      return `<span class="lg"><i style="background:${c.color}"></i>${c.name} <b>+${c.bonus}</b>${holder !== null ? ` ${dot(holder)}` : ''}</span>`;
    }).join('');
  }

  function placeMode() {
    if (S.phase === 'setup') return !myReady() && S.me.pool > 0;
    return myTurn() && (S.phase === 'reinforce' || (S.phase === 'attack' && S.me.pool > 0));
  }

  function onTerritory(id) {
    if (!S) return;
    const t = S.terr[id];
    const mine = t.o === me();
    if (S.phase === 'over') return;
    if (S.phase !== 'setup' && !myTurn()) { sel = { a: id, b: null }; return renderGame(); }
    if (S.phase === 'setup' && myReady()) return toast('Você já está pronto. Aguarde os outros jogadores.');
    if (mode && handleModeClick(id)) return;
    if (placeMode()) {
      if (!mine) return toast('Escolha uma comunidade sua.', true);
      sel = { a: id, b: null };
    } else if (S.phase === 'attack') {
      if (S.pendingMove) return;
      if (mine) {
        if (t.a < 2) return toast('Para atacar, a comunidade precisa ter 2 ou mais soldados.', true);
        sel = { a: id, b: null };
      } else if (sel.a && canReach(sel.a, id)) {
        sel.b = id;
      } else {
        return toast('Escolha primeiro uma comunidade sua que alcance este alvo.', true);
      }
    } else if (S.phase === 'fortify') {
      if (!mine) return toast('No remanejamento, use apenas comunidades suas.', true);
      if (sel.a && sel.a !== id && canFortify(sel.a, id)) sel.b = id;
      else sel = { a: id, b: null };
    } else if (S.phase === 'reinforce') {
      return;
    }
    sfx('select');
    renderGame();
  }

  // clique no mapa enquanto uma arma ou carta aguarda alvo; devolve true se tratou o clique
  function handleModeClick(id) {
    const mine = S.terr[id].o === me();
    if (mode.kind === 'fire') {
      if (!fireTargets(mode.from).includes(id)) { toast('Alvo inválido: escolha uma rival em alcance (marcada em laranja).', true); return true; }
      send({ type: 'fire', from: mode.from, to: id });
      mode = null;
      renderGame();
      return true;
    }
    const target = mode.def.target;
    if (target === 'territory') {
      if (!sabotageTargets().includes(id)) { toast('Alvo inválido: escolha um alvo rival (borda laranja) com arma ou 2+ soldados, sem Rede de olheiros.', true); return true; }
      send({ type: 'playCard', card: mode.card, territory: id });
      mode = null;
      renderGame();
      return true;
    }
    if (target === 'move') {
      if (!mine) { toast('Escolha comunidades suas.', true); return true; }
      if (!mode.from || mode.from === id) { mode.from = id; mode.to = null; } else mode.to = id;
      renderGame();
      return true;
    }
    toast('Escolha o jogador no painel de ações.', true);
    return true;
  }

  // ---------- renderização geral ----------

  function renderGame() {
    const key = `${S.phase}|${S.turn}`;
    if (key !== selKey) { selKey = key; sel = { a: null, b: null }; handSel = new Set(); mode = null; }
    if (mode && (!myTurn() || S.pendingMove)) mode = null;
    if (mode && mode.kind === 'card' && !S.me.actionHand.some((c) => c.id === mode.card)) mode = null;
    if (mode && mode.kind === 'fire' && (S.terr[mode.from].o !== me() || S.terr[mode.from].f)) mode = null;
    // valida seleção
    if (sel.a && S.terr[sel.a].o !== me() && myTurn()) sel = { a: null, b: null };
    if (S.phase === 'attack' && myTurn() && !placeMode()) {
      if (sel.a && S.terr[sel.a].a < 2) sel = { a: null, b: null };
      if (sel.b && S.terr[sel.b].o === me()) sel.b = null;
    }
    handSel = new Set([...handSel].filter((id) => S.me.cards.some((c) => c.id === id)));

    renderTopbar();
    updateMap();
    processEvents();
    renderBanner();
    renderActions();
    renderResearch();
    renderCombat();
    renderPlayers();
    renderObjective();
    renderHand();
    renderActionHand();
    renderLog();
    renderModal();
    tickTimer();

    const mt = myTurn() && S.phase !== 'setup';
    if (mt && !wasMyTurn) toast('É a sua vez!');
    wasMyTurn = mt;
    document.title = mt ? '▶ Sua vez! — WAR · Facções' : 'WAR · Facções';
  }

  function renderTopbar() {
    const idx = PHASES.findIndex(([k]) => k === S.phase);
    const chips = S.phase === 'setup'
      ? '<span class="chip active">Preparação</span>'
      : PHASES.map(([k, n], i) => `<span class="chip ${k === S.phase ? 'active' : i < idx ? 'done' : ''}">${n}</span>`).join('');
    $('#topbar').innerHTML = `
      <span class="room">SALA ${esc(ROOM.code)}</span>
      <div class="phases">${chips}</div>
      <span class="muted">${S.round ? `Rodada ${S.round} · ` : ''}Baralho: ${S.deckCount}</span>
      <button id="rulesBtn" class="mini">Regras</button>
      <button id="exitBtn" class="mini">Sair</button>`;
    $('#rulesBtn').onclick = () => { rulesOpen = true; renderModal(); };
    $('#exitBtn').onclick = () => {
      if (!confirm('Sair da partida? Você poderá voltar com este mesmo navegador enquanto a sala existir.')) return;
      clearSession(); socket.emit('leaveRoom'); ROOM = null; S = null; showScreen('home');
    };
  }

  function renderBanner() {
    const b = $('#banner');
    const cur = S.players[S.turn];
    let html;
    let mine = false;
    if (S.phase === 'over') {
      html = `🏆 ${esc(S.players[S.winner].name)} venceu a partida!`;
    } else if (S.phase === 'setup') {
      html = myReady() ? 'Aguardando os outros jogadores…' : S.me.pool === 0 ? 'Tudo distribuído<small>Clique em “Estou pronto” quando quiser começar.</small>' : `Distribua seus soldados iniciais<small>Restam ${S.me.pool}. Clique numa comunidade sua, escolha a quantidade e confirme.</small>`;
    } else if (myTurn()) {
      mine = true;
      const t = {
        reinforce: `Sua vez — Reforço<small>Distribua ${S.me.pool} soldado(s)${S.turnInfo ? ` (${S.turnInfo.base} por comunidades${S.turnInfo.continents.length ? ' + regiões' : ''})` : ''}. Você também pode trocar cartas.</small>`,
        attack: 'Sua vez — Ataque<small>Escolha uma comunidade sua (2+ soldados) e depois uma vizinha rival.</small>',
        fortify: 'Sua vez — Remanejamento<small>Mova soldados entre comunidades vizinhas suas ou encerre o turno.</small>',
      };
      html = t[S.phase];
    } else {
      html = `${dot(cur.color)} Vez de <b>${esc(cur.name)}</b><small>${{ reinforce: 'Posicionando reforços…', attack: 'Atacando…', fortify: 'Remanejando tropas…' }[S.phase]}</small>`;
    }
    const key = `${S.phase}|${S.turn}|${S.round}`;
    if (key !== bannerKey) { bannerKey = key; bannerFlipUntil = Date.now() + 700; }
    if (meInfo().afk && S.phase !== 'over') {
      html += '<small class="afk-note">⏸ Você está ausente (o tempo acabou e o jogo jogou por você). <button class="mini" data-back="1">Voltei</button></small>';
    }
    b.className = 'banner' + (mine ? ' mine' : '') + (Date.now() < bannerFlipUntil ? ' flip' : '');
    b.innerHTML = html;
  }

  $('#banner').addEventListener('click', (e) => {
    if (e.target.closest('[data-back]')) send({ type: 'back' });
  });

  // ---------- ações ----------

  function ctxMax() {
    if (mode && mode.kind === 'card' && mode.def.target === 'move') {
      if (!mode.from) return 0;
      const f = S.terr[mode.from];
      return Math.max(0, Math.min(f.a - 1, f.a - f.l));
    }
    if (placeMode()) return S.me.pool;
    if (S.phase === 'fortify' && sel.a && sel.b) {
      const f = S.terr[sel.a];
      return Math.max(0, Math.min(f.a - 1, f.a - f.l));
    }
    return 1;
  }

  function stepperHtml(label, max) {
    qty = Math.max(1, Math.min(qty, max || 1));
    return `
      <div class="stepper">
        <button data-do="qty-">−</button><span class="qty">${qty}</span><button data-do="qty+">+</button>
        <button data-do="qtymax">Máx (${max})</button>
      </div>
      <button class="primary" data-do="${label.act}" ${max < 1 ? 'disabled' : ''}>${label.text} ${qty}</button>`;
  }

  function modeHtml() {
    const cancel = '<button data-do="cancelMode">Cancelar</button>';
    if (mode.kind === 'fire') {
      const w = X.weapons[S.terr[mode.from].w];
      return `<div class="selbox mode-box">${w.icon} <b>${esc(w.name)}</b> em ${esc(TERR[mode.from].name)}: clique numa comunidade rival em alcance (borda laranja).</div>${cancel}`;
    }
    const d = mode.def;
    const head = `<div class="selbox mode-box">${d.icon} <b>${esc(d.name)}</b><br><small>${esc(d.desc)}</small></div>`;
    if (d.target === 'player') {
      const opts = S.players.filter((q) => q.alive && q.idx !== me())
        .map((q) => `<button data-do="cardPlayer" data-p="${q.idx}">${dot(q.color)} ${esc(q.name)}</button>`).join('');
      return `${head}<div class="btn-row">${opts}</div>${cancel}`;
    }
    if (d.target === 'territory') return `${head}<p class="muted">Clique numa comunidade rival no mapa.</p>${cancel}`;
    if (!mode.from) return `${head}<p class="muted">Clique na comunidade de <b>origem</b> (sua).</p>${cancel}`;
    if (!mode.to) return `${head}<p class="muted">Origem: <b>${esc(TERR[mode.from].name)}</b>. Clique na comunidade de <b>destino</b> (sua).</p>${cancel}`;
    return `${head}<div class="selbox">${esc(TERR[mode.from].name)} ➜ ${esc(TERR[mode.to].name)}</div>${stepperHtml({ act: 'cardMove', text: 'Mobilizar' }, ctxMax())}${cancel}`;
  }

  function arsenalHtml() {
    if (!S.expanded || !myTurn() || !ACTIVE_PHASES.includes(S.phase) || S.pendingMove) return '';
    if (!sel.a || S.terr[sel.a].o !== me()) return '';
    const t = S.terr[sel.a];
    const name = esc(TERR[sel.a].name);
    if (t.w) {
      const w = X.weapons[t.w];
      let extra = '';
      if (w.kind === 'active') {
        if (S.phase === 'attack' && !t.f) extra = `<button data-do="fireMode" ${fireTargets(sel.a).length ? '' : 'disabled'}>🎯 Disparar</button>${fireTargets(sel.a).length ? '' : '<small>Nenhum alvo em alcance.</small>'}`;
        else extra = `<small>${t.f ? 'Já disparou neste turno.' : 'Dispara na fase de ataque.'}</small>`;
      }
      return `<div class="arsenal-box"><span class="wname">${w.icon} ${esc(w.name)} em ${name}</span><small>${esc(w.desc)}</small>${extra}</div>`;
    }
    const unlocked = S.players[me()].weapons;
    if (!unlocked.length) return `<div class="arsenal-box"><small>Sem arma em ${name}. Desbloqueie armas no <b>Arsenal</b> para construí-las.</small></div>`;
    const done = S.buff.built >= X.buildsPerTurn;
    const btns = unlocked.map((id) => {
      const w = X.weapons[id];
      const bad = done || t.a - w.build < 1;
      return `<button data-do="build" data-w="${id}" ${bad ? 'disabled' : ''} title="${esc(w.desc)}">${w.icon} ${esc(w.name)} (−${w.build})</button>`;
    }).join('');
    return `<div class="arsenal-box"><small>Construir em <b>${name}</b> (${t.a} soldado(s)). ${done ? 'Você já construiu neste turno.' : 'Gasta soldados da comunidade; 1 arma por turno.'}</small><div class="btn-row">${btns}</div></div>`;
  }

  function renderActions() {
    const box = $('#actions');
    if (mode && myTurn()) {
      box.innerHTML = `<div class="panel-title">Ações</div><div class="actions-body">${modeHtml()}</div>`;
      return;
    }
    const p = S.phase;
    let h = '';
    if (p === 'over') {
      const host = ROOM && ROOM.me.isHost;
      h = `<p>A partida terminou.</p>${host ? '<button class="primary" data-do="lobby">Voltar à sala</button>' : '<p class="muted">Aguardando o anfitrião…</p>'}
           <button data-do="showWin">Ver resultado</button>`;
    } else if (p === 'setup') {
      if (myReady()) {
        h = '<p class="muted">Você está pronto. Aguardando os demais jogadores…</p>';
      } else if (S.me.pool > 0) {
        if (sel.a && S.terr[sel.a].o === me()) {
          h = `<div class="selbox">Colocar em <b>${esc(TERR[sel.a].name)}</b> (${S.terr[sel.a].a} soldado(s))</div>${stepperHtml({ act: 'place', text: 'Colocar' }, S.me.pool)}`;
        } else {
          h = `<p class="muted">Clique em uma comunidade sua para adicionar soldados. Faltam <b>${S.me.pool}</b>.</p>`;
        }
      } else {
        h = '<p>Tudo distribuído!</p><button class="primary" data-do="ready">Estou pronto</button>';
      }
    } else if (!myTurn()) {
      h = '<p class="muted">Aguarde sua vez. Enquanto isso, clique nas comunidades para inspecionar.</p>';
    } else if (p === 'reinforce' || placeMode()) {
      const need = S.me.mustTrade ? '<p class="muted">⚠ Você tem 5 ou mais cartas: é obrigatório trocar.</p>' : '';
      const body = sel.a && S.terr[sel.a].o === me()
        ? `<div class="selbox">Colocar em <b>${esc(TERR[sel.a].name)}</b> (${S.terr[sel.a].a} soldado(s))</div>${stepperHtml({ act: 'place', text: 'Colocar' }, S.me.pool)}`
        : `<p class="muted">${S.me.pool > 0 ? `Clique em uma comunidade sua para reforçar. Restam <b>${S.me.pool}</b>.` : 'Reforços distribuídos.'}</p>`;
      const next = p === 'reinforce'
        ? `<button class="primary" data-do="endReinforce" ${S.me.pool > 0 || S.me.mustTrade ? 'disabled' : ''}>Ir para o ataque ➜</button>` : '';
      h = need + body + next;
    } else if (p === 'attack') {
      if (S.me.mustTrade) {
        h = '<p class="muted">⚠ Você tem 5 ou mais cartas: troque antes de continuar.</p>';
      } else if (sel.a && sel.b) {
        const f = S.terr[sel.a]; const t = S.terr[sel.b];
        const maxDice = Math.min(3, f.a - 1);
        dice = Math.max(1, Math.min(dice, maxDice));
        h = `<div class="selbox"><b>${esc(TERR[sel.a].name)}</b> (${f.a}) ⚔ <b>${esc(TERR[sel.b].name)}</b> (${t.a}) ${dot(t.o)}</div>
          <div class="dice-pick">${[1, 2, 3].filter((n) => n <= maxDice).map((n) => `<button data-do="dice" data-v="${n}" class="${n === dice ? 'on' : ''}">${n} dado${n > 1 ? 's' : ''}</button>`).join('')}</div>
          <div class="btn-row"><button class="danger" data-do="attack">Atacar</button><button class="danger" data-do="blitz">Atacar até o fim</button></div>`;
      } else if (sel.a) {
        h = `<div class="selbox">Atacando de <b>${esc(TERR[sel.a].name)}</b> (${S.terr[sel.a].a}). Escolha uma vizinha rival (marcada em vermelho).</div>`;
      } else {
        h = '<p class="muted">Escolha uma comunidade sua com 2+ soldados para atacar a partir dela.</p>';
      }
      h += `<div class="btn-row"><button data-do="endAttack" ${S.me.mustTrade ? 'disabled' : ''}>Remanejar ➜</button><button data-do="endTurn" ${S.me.mustTrade ? 'disabled' : ''}>Encerrar turno</button></div>`;
    } else if (p === 'fortify') {
      if (sel.a && sel.b) {
        h = `<div class="selbox">Mover de <b>${esc(TERR[sel.a].name)}</b> para <b>${esc(TERR[sel.b].name)}</b></div>${stepperHtml({ act: 'fortify', text: 'Mover' }, ctxMax())}`;
      } else if (sel.a) {
        h = `<div class="selbox">Origem: <b>${esc(TERR[sel.a].name)}</b>. Escolha um vizinho seu (marcado em verde).</div>`;
      } else {
        h = '<p class="muted">Clique em uma comunidade sua e depois em uma vizinha sua para mover tropas. Tropas que acabaram de chegar não se movem de novo neste turno.</p>';
      }
      h += '<button class="primary" data-do="endTurn">Encerrar turno ✔</button>';
    }
    h += arsenalHtml();
    box.innerHTML = `<div class="panel-title">Ações</div><div class="actions-body">${h}</div>`;
  }

  $('#actions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-do]');
    if (!b || !S) return;
    const act = b.dataset.do;
    const max = ctxMax();
    switch (act) {
      case 'fireMode': mode = { kind: 'fire', from: sel.a }; return renderGame();
      case 'build': send({ type: 'build', weapon: b.dataset.w, territory: sel.a }); return;
      case 'cancelMode': mode = null; return renderGame();
      case 'cardPlayer': send({ type: 'playCard', card: mode.card, player: Number(b.dataset.p) }); mode = null; return renderGame();
      case 'cardMove': send({ type: 'playCard', card: mode.card, from: mode.from, to: mode.to, n: qty }); mode = null; return renderGame();
      case 'qty-': qty = Math.max(1, qty - 1); return renderActions();
      case 'qty+': qty = Math.min(max, qty + 1); return renderActions();
      case 'qtymax': qty = max; return renderActions();
      case 'place': send({ type: 'place', territory: sel.a, n: qty }); return;
      case 'ready': send({ type: 'ready' }); return;
      case 'endReinforce': send({ type: 'endReinforce' }); return;
      case 'dice': dice = Number(b.dataset.v); return renderActions();
      case 'attack': send({ type: 'attack', from: sel.a, to: sel.b, dice }); return;
      case 'blitz': send({ type: 'attack', from: sel.a, to: sel.b, blitz: true }); return;
      case 'endAttack': send({ type: 'endAttack' }); return;
      case 'fortify': send({ type: 'fortify', from: sel.a, to: sel.b, n: qty }); sel.b = null; return;
      case 'endTurn': send({ type: 'endTurn' }); return;
      case 'lobby': socket.emit('backToLobby', {}, (r) => { if (!r.ok) toast(r.error, true); }); return;
      case 'showWin': winDismissed = false; renderModal(); return;
      default:
    }
  });

  // ---------- combate ----------

  function renderCombat() {
    const box = $('#combat');
    const c = S.lastCombat;
    if (!c) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const isNew = c.id !== seenCombat;
    seenCombat = c.id;
    const pairs = Math.min(c.attDice.length, c.defDice.length);
    const die = (n, cls, lost) => `<span class="die ${cls}${lost ? ' lost' : ''}${isNew ? ' roll' : ''}">${n}</span>`;
    const att = c.attDice.map((n, k) => die(n, 'att', k < pairs && !(n > c.defDice[k]))).join('');
    const def = c.defDice.map((n, k) => die(n, 'def', k < pairs && n > c.attDice[k])).join('');
    box.innerHTML = `
      <div class="panel-title">Último combate${c.rounds > 1 ? ` <span class="muted">(${c.rounds} rodadas, último lance)</span>` : ''}</div>
      <div class="combat-row"><span class="who">${dot(c.attColor)}${esc(c.att)}</span>${att}</div>
      <div class="combat-row"><span class="who">${dot(c.defColor)}${esc(c.def)}</span>${def}</div>
      <div class="combat-sum">${esc(TERR[c.from].name)} ➜ ${esc(TERR[c.to].name)} · perdas: ataque <b>${c.lossA}</b>, defesa <b>${c.lossD}</b>${c.conquered ? ' · <b style="color:var(--ok)">CONQUISTADO!</b>' : ''}</div>
      ${c.notes && c.notes.length ? `<div class="combat-notes">⚡ ${c.notes.map(esc).join(' · ')}</div>` : ''}`;
    if (isNew) fxCombat(c);
    if (isNew && c.conquered) toast(`${c.att} dominou ${TERR[c.to].name}!`);
  }

  // ---------- modo expandido: pesquisa, cartas de ação, árvores ----------

  function renderResearch() {
    const box = $('#research');
    if (!S.expanded || S.phase === 'setup') { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const p = S.players[me()];
    box.innerHTML = `<div class="panel-title">Pesquisa e arsenal</div>
      <div class="res-row"><span class="pp" title="Pontos de Pesquisa">🔬 ${p.pp} PP</span>
        <button data-open="tech">🧪 Tecnologia ${p.techs.length}/${Object.keys(X.techs).length}</button>
        <button data-open="arsenal">💥 Arsenal ${p.weapons.length}/${Object.keys(X.weapons).length}</button></div>`;
  }
  $('#research').addEventListener('click', (e) => {
    const b = e.target.closest('[data-open]');
    if (!b || !S) return;
    treeTab = b.dataset.open;
    treeOpen = true;
    renderModal();
  });

  function renderActionHand() {
    const panel = $('#actionPanel');
    if (!S.expanded || S.phase === 'setup') { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    const hand = S.me.actionHand;
    if (prevActionIds) hand.filter((c) => !prevActionIds.has(c.id)).forEach((c) => { dealUntil[c.id] = Date.now() + 800; });
    prevActionIds = new Set(hand.map((c) => c.id));
    $('#actionInfo').textContent = `${hand.length}/${X.handMax} · baralho ${S.actionDeckCount}`;
    const canPlay = myTurn() && ACTIVE_PHASES.includes(S.phase) && !S.pendingMove;
    $('#actionHand').innerHTML = hand.length ? hand.map((c) => {
      const d = X.actionCards[c.type];
      const ok = canPlay && d.phases.includes(S.phase);
      return `<div class="acard ${dealUntil[c.id] > Date.now() ? 'deal' : ''}"><span class="ic">${d.icon}</span><div><b>${esc(d.name)}</b><small>${esc(d.desc)}</small></div>
        <button data-play="${c.id}" ${ok ? '' : 'disabled'}>Jogar</button></div>`;
    }).join('') : '<span class="muted">Sem cartas de ação. Você compra uma no início de cada turno.</span>';
  }
  $('#actionHand').addEventListener('click', (e) => {
    const b = e.target.closest('[data-play]');
    if (!b || !S) return;
    const card = S.me.actionHand.find((c) => c.id === b.dataset.play);
    if (!card) return;
    const def = X.actionCards[card.type];
    if (def.target === 'none') { send({ type: 'playCard', card: card.id }); return; }
    mode = { kind: 'card', card: card.id, def, from: null, to: null };
    qty = 1;
    renderGame();
  });

  const techName = (id) => X.techs[id].name;

  function treeHtml() {
    const p = S.players[me()];
    const canAct = myTurn() && ACTIVE_PHASES.includes(S.phase) && !S.pendingMove;
    const tabs = `<div class="tree-tabs">
      <button class="tab ${treeTab === 'tech' ? 'active' : ''}" data-treetab="tech">🧪 Árvore de Tecnologia</button>
      <button class="tab ${treeTab === 'arsenal' ? 'active' : ''}" data-treetab="arsenal">💥 Árvore de Arsenal</button></div>`;
    let body;
    if (treeTab === 'tech') {
      body = `<div class="tree-grid cols4">${Object.entries(X.branches).map(([bid, br]) => {
        const nodes = Object.entries(X.techs).filter(([, t]) => t.branch === bid).sort((a, b) => a[1].tier - b[1].tier);
        return `<div class="tree-col"><h4>${br.icon} ${esc(br.name)}</h4>${nodes.map(([id, t]) => {
          const owned = p.techs.includes(id);
          const reqOk = t.req.every((r) => p.techs.includes(r));
          const buy = !owned && reqOk && canAct && p.pp >= t.cost;
          const cls = owned ? 'owned' : buy ? 'avail' : 'locked';
          return `<div class="tnode ${cls}" ${buy ? `data-tech="${id}"` : ''}>${owned ? '<span class="tag">OK</span>' : ''}<b>${esc(t.name)}</b>
            <span class="cost">${t.cost} PP</span> ${esc(t.desc)}
            ${t.req.length && !owned ? `<span class="req">Requer: ${t.req.map((r) => `${p.techs.includes(r) ? '✔' : '✖'} ${esc(techName(r))}`).join(', ')}</span>` : ''}</div>`;
        }).join('')}</div>`;
      }).join('')}</div>`;
    } else {
      body = `<div class="tree-grid cols3">${Object.entries(X.weaponLines).map(([lid, ln]) => {
        const nodes = Object.entries(X.weapons).filter(([, w]) => w.line === lid).sort((a, b) => a[1].tier - b[1].tier);
        return `<div class="tree-col"><h4>${ln.icon} ${esc(ln.name)}</h4>${nodes.map(([id, w]) => {
          const owned = p.weapons.includes(id);
          const reqW = w.reqW.every((r) => p.weapons.includes(r));
          const reqT = w.reqT.every((r) => p.techs.includes(r));
          const buy = !owned && reqW && reqT && canAct && p.pp >= w.cost;
          const cls = owned ? 'owned' : buy ? 'avail' : 'locked';
          const reqs = [
            ...w.reqW.map((r) => `${p.weapons.includes(r) ? '✔' : '✖'} ${esc(X.weapons[r].name)}`),
            ...w.reqT.map((r) => `${p.techs.includes(r) ? '✔' : '✖'} ${esc(techName(r))}`),
          ];
          return `<div class="tnode ${cls}" ${buy ? `data-weapon="${id}"` : ''}>${owned ? '<span class="tag">OK</span>' : ''}<b>${w.icon} ${esc(w.name)}</b>
            <span class="cost">${w.cost} PP</span> · construir: ${w.build} soldado(s)<br>${esc(w.desc)}
            ${reqs.length && !owned ? `<span class="req">Requer: ${reqs.join(', ')}</span>` : ''}</div>`;
        }).join('')}</div>`;
      }).join('')}</div>`;
    }
    const hint = canAct
      ? 'Clique num nó dourado para comprá-lo. Armas desbloqueadas são construídas nas comunidades, gastando soldados.'
      : 'Você só pode pesquisar e desbloquear durante o seu turno.';
    return `<h2>Árvores de evolução <span class="pp" style="font-size:.9rem;float:right">🔬 ${p.pp} PP</span></h2>${tabs}${body}
      <p class="muted" style="margin-top:12px">${hint}</p>
      <button class="primary" id="closeTree" style="width:100%;margin-top:8px">Fechar</button>`;
  }

  function closeRules() {
    rulesOpen = false;
    modalKey = '';
    if (S) renderModal(); else closeModal();
  }

  $('#modalBox').addEventListener('click', (e) => {
    const rt = e.target.closest('[data-rtab]');
    if (rt) { rulesTab = rt.dataset.rtab; renderModal(); const b = $('.rules-body'); if (b) b.scrollTop = 0; return; }
    if (e.target.closest('#closeRules') || e.target.closest('#closeRulesX')) { closeRules(); return; }
    if (!S) return;
    const tab = e.target.closest('[data-treetab]');
    if (tab) { treeTab = tab.dataset.treetab; renderModal(); return; }
    const t = e.target.closest('[data-tech]');
    if (t) { send({ type: 'research', tech: t.dataset.tech }); return; }
    const w = e.target.closest('[data-weapon]');
    if (w) { send({ type: 'unlock', weapon: w.dataset.weapon }); return; }
    if (e.target.closest('#closeTree')) { treeOpen = false; renderModal(); }
  });

  // ---------- jogadores, objetivo, cartas, log ----------

  // trégua entre mim e o jogador q
  function truceNote(q) {
    if (!S.expanded || q === me()) return '';
    const protectsMe = S.truces.some((t) => t.by === q && t.against === me());
    const protectsHim = S.truces.some((t) => t.by === me() && t.against === q);
    return `${protectsMe ? '<span class="badge" title="Você não pode atacá-lo até o próximo turno dele">🕊️ trégua: você não ataca</span>' : ''}${protectsHim ? '<span class="badge" title="Ele não pode atacar você até o seu próximo turno">🕊️ ele não ataca você</span>' : ''}`;
  }

  function renderPlayers() {
    if (!S || !ROOM) return;
    const host = ROOM.me.isHost;
    $('#players').innerHTML = `<div class="panel-title">Jogadores</div><div class="players">${S.players.map((p) => {
      const rp = ROOM.players[p.idx];
      const offline = rp && !rp.connected;
      const waiting = S.phase === 'setup' ? !p.ready : S.turn === p.idx;
      const canAuto = host && offline && p.alive && S.phase !== 'over' && waiting;
      return `<div class="pl ${S.turn === p.idx && S.phase !== 'setup' && S.phase !== 'over' ? 'turn' : ''} ${p.alive ? '' : 'dead'}">
        ${dot(p.color)}<span class="nm">${esc(p.name)}${p.idx === me() ? ' (você)' : ''}<small class="faction">${esc(color(p.color).faction)}</small></span>
        <span>${S.phase === 'setup' ? (p.ready ? '✔' : '…') : S.turn === p.idx && S.phase !== 'over' ? '▶' : ''}</span>
        <div class="stats"><span>🗺 <b>${p.territories}</b></span><span>⚔ <b>${p.armies}</b></span><span>🃏 <b>${p.cards}</b></span>${S.expanded ? `<span title="Pontos de Pesquisa">🔬 <b>${p.pp}</b></span><span title="Tecnologias + armas">🧪 <b>${p.techs.length + p.weapons.length}</b></span><span title="Cartas de ação">🎴 <b>${p.actionCards}</b></span>` : ''}${p.pool && S.phase !== 'setup' ? `<span>+<b>${p.pool}</b> a distribuir</span>` : ''}</div>
        <span></span><span></span>
        ${offline || canAuto || p.afk || truceNote(p.idx) ? `<div class="extra">${offline ? '<span class="badge off">offline</span>' : ''}${p.afk ? '<span class="badge off" title="Estourou o tempo; joga automaticamente até voltar">ausente</span>' : ''}${truceNote(p.idx)}${canAuto ? `<button class="mini" data-auto="${p.idx}">Jogar por ele</button>` : ''}</div>` : ''}
      </div>`;
    }).join('')}</div>`;
  }
  $('#players').addEventListener('click', (e) => {
    const b = e.target.closest('[data-auto]');
    if (!b) return;
    socket.emit('autoPlay', { idx: Number(b.dataset.auto) }, (r) => { if (!r.ok) toast(r.error, true); });
  });

  function renderObjective() {
    const o = $('#objective');
    o.textContent = S.me.objective;
    o.classList.toggle('hide', objHidden);
    let intel = $('#intelBox');
    if (!intel) { intel = document.createElement('div'); intel.id = 'intelBox'; intel.className = 'intel'; o.after(intel); }
    const list = S.me.intel || [];
    intel.classList.toggle('hidden', !list.length);
    intel.innerHTML = list.map((i) => `🕵️ <b>${esc(S.players[i.player].name)}</b>: ${esc(i.text)}`).join('<br>');
    intel.style.filter = objHidden ? 'blur(6px)' : '';
    $('#eyeBtn').textContent = objHidden ? 'mostrar' : 'ocultar';
  }
  $('#eyeBtn').onclick = () => { objHidden = !objHidden; if (S) renderObjective(); };

  function validSet(cards) {
    if (cards.length !== 3) return false;
    const syms = cards.filter((c) => c.symbol !== 'coringa').map((c) => c.symbol);
    const u = new Set(syms).size;
    return syms.length <= 1 || u === 1 || u === syms.length;
  }
  const nextTradeValue = () => S.nextTrade;

  function renderHand() {
    const h = $('#hand');
    const cards = S.me.cards;
    if (!cards.length) {
      h.innerHTML = '<span class="empty">Você ainda não tem cartas. Domine ao menos uma comunidade por turno para ganhar uma.</span>';
    } else {
      const fresh = prevCardIds ? cards.filter((c) => !prevCardIds.has(c.id)) : [];
      fresh.forEach((c) => { dealUntil[c.id] = Date.now() + 800; });
      h.innerHTML = cards.map((c) => {
        const t = c.territory ? TERR[c.territory] : null;
        const owned = t && S.terr[c.territory].o === me();
        return `<div class="tcard ${c.symbol === 'coringa' ? 'wild' : ''} ${handSel.has(c.id) ? 'sel' : ''} ${dealUntil[c.id] > Date.now() ? 'deal' : ''}" data-card="${c.id}">
          ${owned ? '<span class="plus">+2</span>' : ''}
          <div class="band" style="background:${t ? MAP.continents[t.continent].color : '#fff'}"></div>
          <div class="sym">${SYM[c.symbol]}</div>
          <div class="tn">${t ? esc(t.name) : 'Coringa'}</div>
        </div>`;
      }).join('');
    }
    prevCardIds = new Set(cards.map((c) => c.id));
    const canNow = myTurn() && (S.phase === 'reinforce' || (S.phase === 'attack' && S.me.mustTrade));
    const chosen = cards.filter((c) => handSel.has(c.id));
    const btn = $('#tradeBtn');
    btn.classList.toggle('hidden', !canNow || !cards.length);
    btn.disabled = !validSet(chosen);
    btn.textContent = `Trocar cartas por ${nextTradeValue()} soldados`;
    $('#tradeInfo').textContent = `próxima troca: ${nextTradeValue()}`;
  }
  $('#hand').addEventListener('click', (e) => {
    const c = e.target.closest('[data-card]');
    if (!c || !S) return;
    const id = c.dataset.card;
    if (handSel.has(id)) handSel.delete(id);
    else if (handSel.size < 3) handSel.add(id);
    renderHand();
  });
  $('#tradeBtn').onclick = () => {
    send({ type: 'trade', cards: [...handSel] });
    handSel = new Set();
  };

  $('#tabLog').onclick = () => { tab = 'log'; renderLog(); };
  $('#tabChat').onclick = () => { tab = 'chat'; chatSeen = ROOM ? ROOM.chat.length : 0; renderLog(); };

  function renderLog() {
    $('#tabLog').classList.toggle('active', tab === 'log');
    $('#tabChat').classList.toggle('active', tab === 'chat');
    $('#chatForm').classList.toggle('hidden', tab !== 'chat');
    const box = $('#logBox');
    if (tab === 'log') {
      box.innerHTML = S.log.map((l) => `<div class="logline ${l.p === null ? 'sys' : ''}"><i ${l.p !== null ? `style="background:${color(S.players[l.p].color).hex}"` : ''}></i><span>${esc(l.t)}</span></div>`).join('');
    } else {
      renderChat();
    }
    box.scrollTop = box.scrollHeight;
  }

  function renderChat() {
    if (!ROOM) return;
    const unread = tab !== 'chat' ? Math.max(0, ROOM.chat.length - chatSeen) : 0;
    $('#tabChat').textContent = unread ? `Chat (${unread})` : 'Chat';
    if (tab !== 'chat') return;
    chatSeen = ROOM.chat.length;
    const box = $('#logBox');
    box.innerHTML = ROOM.chat.length
      ? ROOM.chat.map((m) => `<div class="chatline"><b>${esc(m.name)}:</b> ${esc(m.text)}</div>`).join('')
      : '<span class="muted">Nenhuma mensagem ainda.</span>';
    box.scrollTop = box.scrollHeight;
  }

  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chatInput');
    if (input.value.trim()) socket.emit('chat', input.value);
    input.value = '';
  });

  // ---------- modais ----------

  function closeModal() { $('#modal').classList.add('hidden'); occupyKey = ''; modalKey = ''; }

  function openModal(html, wide, key) {
    modalKey = key || '';
    $('#modalBox').className = `modal-box${wide ? ' wide' : ''}`;
    $('#modalBox').innerHTML = html;
    $('#modal').classList.remove('hidden');
  }

  // ---------- janela de regras ----------

  const RULES_TABS = [
    ['visao', '🏙️ Visão geral'],
    ['turno', '🎲 Seu turno'],
    ['cartas', '🃏 Cartas'],
    ['objetivos', '🎯 Objetivos'],
    ['expandido', '🧪 Modo expandido'],
    ['partida', '👥 Partida (2 a ' + MAP.maxPlayers + ')'],
  ];

  function objectiveText(o) {
    if (o.type === 'continents') {
      const regs = o.required.map((k) => MAP.continents[k].name).join(' e ');
      const extra = o.extra ? ` e mais ${o.extra === 1 ? 'uma região' : `${o.extra} regiões`} à sua escolha` : '';
      return `Dominar por inteiro ${regs}${extra}.`;
    }
    if (o.type === 'territories') {
      return o.minArmies > 1
        ? `Dominar ${o.n} comunidades e ocupar cada uma delas com pelo menos ${o.minArmies} soldados.`
        : `Dominar ${o.n} comunidades à sua escolha.`;
    }
    return `Destruir totalmente a facção ${MAP.colors[o.color].faction}.`;
  }

  function rulesBody(tab) {
    const regions = Object.values(MAP.continents);
    const die = (n, cls, lost) => `<span class="die ${cls}${lost ? ' lost' : ''}">${n}</span>`;
    if (tab === 'visao') {
      return `<p>A cidade tem <b>${MAP.territories.length} comunidades</b> divididas em <b>${regions.length} regiões</b>. Cada jogador comanda uma <b>facção</b>; cada comunidade que a facção controla tem seus <b>soldados</b>. Vence quem cumprir o <b>objetivo secreto</b> primeiro, durante o seu turno, ou a última facção em pé.</p>
        <h3>Regiões e bônus de reforço</h3>
        <p>Dominar uma região inteira rende soldados extras a cada turno:</p>
        <div class="chips">${regions.map((r) => `<span class="rchip" style="border-color:${r.color}"><i style="background:${r.color}"></i>${esc(r.name)} <b>+${r.bonus}</b></span>`).join('')}</div>
        <h3>Como começa</h3>
        <ul>
          <li>As comunidades são sorteadas entre os jogadores, com 1 soldado em cada.</li>
          <li>Todos distribuem os soldados iniciais <b>ao mesmo tempo</b> e clicam em “Estou pronto”.</li>
          <li>A facção que começa é sorteada; depois os turnos seguem em ordem.</li>
        </ul>
        <h3>Dicas rápidas</h3>
        <ul>
          <li>Clique numa comunidade sua para selecioná-la; o painel de ações mostra o que fazer em cada fase.</li>
          <li>Comunidades marcadas em vermelho são alvos de ataque; em verde, destinos de remanejamento.</li>
          <li>Se cair a conexão, atualize a página: você volta ao seu lugar.</li>
        </ul>`;
    }
    if (tab === 'turno') {
      return `<ol class="steps">
          <li><b>Reforço.</b> Receba soldados = comunidades ÷ 2 (mínimo 3) + bônus das regiões inteiras que você domina. Distribua onde quiser entre as suas comunidades. Aqui você também troca cartas.</li>
          <li><b>Ataque.</b> De uma comunidade com 2+ soldados contra uma vizinha rival, quantas vezes quiser. O atacante rola até <b>3 dados</b> (sempre deixa 1 soldado para trás); o defensor rola até <b>3 dados</b> (um por soldado). Ao dominar, mova pelo menos tantos soldados quanto dados rolou.</li>
          <li><b>Remanejamento.</b> Mova soldados entre comunidades vizinhas suas, deixando 1 em cada origem. Soldados que acabaram de chegar não se movem de novo no turno.</li>
          <li><b>Fim do turno.</b> Se dominou ao menos uma comunidade, você recebe uma carta.</li>
        </ol>
        <h3>Tempo de jogo</h3>
        <p>Cada fase (preparação, reforço, ataque e remanejamento) tem <b>no máximo ${MAP.turnSeconds} segundos</b>, com um relógio na tela. Se o tempo acabar, o jogo <b>joga por você</b>: distribui seus reforços nas comunidades de fronteira, resolve uma ocupação pendente e encerra o turno, sem atacar. Quem estoura o tempo fica marcado como <b>ausente</b>: nos turnos seguintes a jogada automática vem logo (após uns 10 segundos) até você clicar em “Voltei” ou jogar por conta própria. Jogadores desconectados também são jogados automaticamente.</p>
        <h3>Como os dados são comparados</h3>
        <p>Ordene os dados de cada lado do maior para o menor e compare em pares. <b>Quem perde o par perde 1 soldado; em caso de empate, a defesa vence.</b></p>
        <div class="example">
          <div class="combat-row"><span class="who">Atacante</span>${die(6, 'att')}${die(4, 'att', true)}${die(2, 'att')}</div>
          <div class="combat-row"><span class="who">Defensor</span>${die(5, 'def', true)}${die(4, 'def')}</div>
          <p class="muted">6 × 5: o atacante vence, o defensor perde 1. 4 × 4: empate, a defesa vence e o atacante perde 1. O terceiro dado do atacante não tem par.</p>
        </div>`;
    }
    if (tab === 'cartas') {
      const seq = MAP.tradeSeq.join(', ');
      return `<h3>Cartas de comunidade</h3>
        <p>Existem ${MAP.territories.length} cartas, uma para cada comunidade, com um símbolo (▲ ■ ●), e 2 coringas (★). Ao <b>dominar ao menos uma comunidade no turno</b> você recebe 1 carta.</p>
        <ul>
          <li><b>Troca:</b> 3 cartas do mesmo símbolo <i>ou</i> 3 símbolos diferentes; o coringa vale por qualquer um.</li>
          <li><b>Soldados da troca:</b> ${seq} e depois +5 a cada troca. A sequência é <b>global</b>: sobe para todos.</li>
          <li><b>Bônus de comunidade:</b> cada carta da troca cuja comunidade é sua dá +2 soldados nela.</li>
          <li><b>Limite:</b> com 5 ou mais cartas a troca é obrigatória.</li>
          <li><b>Eliminação:</b> ao eliminar uma facção, você fica com as cartas dela.</li>
        </ul>`;
    }
    if (tab === 'objetivos') {
      return `<p>Cada jogador recebe <b>um objetivo em segredo</b>. São ${MAP.objectives.length} cartas possíveis:</p>
        <div class="obj-list">${MAP.objectives.map((o) => `<div class="obj">${esc(objectiveText(o))}</div>`).join('')}</div>
        <p class="muted">Se a facção que você devia destruir não está na partida, é a sua própria ou é eliminada por outro jogador, o seu objetivo vira “dominar 24 comunidades”. O vencedor é quem cumprir o objetivo durante o seu turno.</p>`;
    }
    if (tab === 'expandido') {
      const techs = Object.entries(X.branches).map(([bid, br]) => `<tr><th>${br.icon} ${esc(br.name)}</th>${Object.values(X.techs).filter((t) => t.branch === bid).sort((a, b) => a.tier - b.tier)
        .map((t) => `<td><b>${esc(t.name)}</b> <span class="cost">${t.cost} PP</span><br>${esc(t.desc)}</td>`).join('')}</tr>`).join('');
      const weapons = Object.values(X.weapons).map((w) => `<tr><td>${w.icon} <b>${esc(w.name)}</b></td><td>${w.cost} PP</td><td>${w.build}</td><td>${esc(w.desc)}${w.reqT.length || w.reqW.length ? `<br><span class="muted">Requer: ${[...w.reqW.map((r) => X.weapons[r].name), ...w.reqT.map((r) => X.techs[r].name)].map(esc).join(', ')}</span>` : ''}</td></tr>`).join('');
      const cards = Object.values(X.actionCards).map((c) => `<tr><td>${c.icon} <b>${esc(c.name)}</b> ×${c.count}</td><td>${esc(c.desc)}</td></tr>`).join('');
      return `<p>Opção do anfitrião na sala. Acrescenta <b>Pontos de Pesquisa (PP)</b>, uma <b>árvore de tecnologia</b>, uma <b>árvore de armas</b> e um <b>segundo baralho</b> de cartas de ação.</p>
        <h3>Pontos de Pesquisa</h3><p>No início do turno: 2 PP + 1 a cada 6 comunidades + 1 por região completa. Eles acumulam.</p>
        <h3>Árvore de tecnologia</h3><p>Bônus permanentes. Cada nível exige o anterior do ramo.</p>
        <div class="table-wrap"><table class="rtable">${techs}</table></div>
        <h3>Árvore de armas</h3><p>Desbloqueie com PP e construa nas suas comunidades gastando soldados (1 construção por turno, 1 arma por comunidade). A arma é destruída se a comunidade for dominada.</p>
        <div class="table-wrap"><table class="rtable"><tr><th>Arma</th><th>Custo</th><th>Soldados</th><th>Efeito</th></tr>${weapons}</table></div>
        <h3>Cartas de ação</h3><p>Compre 1 por turno (máx. ${X.handMax} na mão) e jogue no seu turno.</p>
        <div class="table-wrap"><table class="rtable">${cards}</table></div>`;
    }
    // partida
    const n = Number(MAP.maxPlayers);
    const rows = Object.entries(MAP.startArmies).map(([p, total]) => {
      const per = MAP.territories.length / Number(p);
      return `<tr><td>${p} jogadores</td><td>${total}</td><td>~${per.toFixed(1).replace('.0', '').replace('.', ',')}</td><td>~${Math.round(total - per)}</td></tr>`;
    }).join('');
    return `<p>O jogo comporta de <b>2 a ${n} jogadores</b>, cada um com a sua facção, por ordem de entrada na sala.</p>
      <div class="faction-grid">${MAP.colors.map((c, i) => `<div class="fcard"><span class="dot" style="background:${c.hex}"></span><span><b>${esc(c.faction)}</b><small>${i + 1}º a entrar</small></span></div>`).join('')}</div>
      <h3>Soldados iniciais</h3>
      <div class="table-wrap"><table class="rtable"><tr><th>Jogadores</th><th>Total por jogador</th><th>Comunidades</th><th>A distribuir</th></tr>${rows}</table></div>
      <p class="muted">Com mais jogadores cada um começa com menos comunidades e a disputa por regiões inteiras é mais longa. Partidas grandes funcionam melhor com o modo expandido, que dá mais o que fazer a cada turno.</p>
      <h3>Sala e conexão</h3>
      <ul>
        <li>O anfitrião cria a sala, compartilha o código de 4 letras (ou o link) e inicia a partida.</li>
        <li>Quem cai ou atualiza a página volta ao mesmo lugar. Se alguém sumir, o anfitrião usa “Jogar por ele”.</li>
        <li>Uma sala suporta no máximo ${n} jogadores; depois que a partida começa, ninguém novo entra.</li>
      </ul>`;
  }

  function rulesHtml() {
    const tabs = RULES_TABS.map(([k, label]) => `<button class="tab ${rulesTab === k ? 'active' : ''}" data-rtab="${k}">${label}</button>`).join('');
    return `<div class="rules-head"><h2>📖 Regras do jogo</h2><button class="mini" id="closeRulesX" aria-label="Fechar">✕</button></div>
      <div class="rules-tabs">${tabs}</div>
      <div class="rules-body">${rulesBody(rulesTab)}</div>
      <button class="primary" id="closeRules" style="width:100%;margin-top:12px">Entendi</button>`;
  }

  function winHtml() {
    const w = S.players[S.winner];
    return `<div class="trophy">🏆</div><h2 style="text-align:center">${esc(w.name)} venceu!</h2>
      <p style="text-align:center">${dot(w.color)} Objetivo: ${esc(w.objective || '')}</p>
      <div class="win-list">${S.players.map((p) => `<div class="${p.idx === S.winner ? 'winner' : ''}">${dot(p.color)} <b>${esc(p.name)}</b> — ${p.territories} comunidades<br><span class="muted">${esc(p.objective || '')}</span></div>`).join('')}</div>
      <div class="btn-row">
        ${ROOM && ROOM.me.isHost ? '<button class="primary" id="againBtn">Nova partida (voltar à sala)</button>' : ''}
        <button id="closeWin">Fechar</button>
      </div>`;
  }

  function renderModal() {
    if (S && S.pendingMove && S.phase !== 'over') {
      const pm = S.pendingMove;
      const key = `occ|${pm.from}|${pm.to}`;
      if (occupyKey === key) return;
      occupyKey = key;
      occupyN = pm.min;
      openModal(`<h2>Comunidade dominada!</h2>
        <p>Quantos soldados mover de <b>${esc(TERR[pm.from].name)}</b> para <b>${esc(TERR[pm.to].name)}</b>?</p>
        <div style="text-align:center;font-size:2.2rem;font-weight:900" id="occN">${occupyN}</div>
        <input type="range" id="occRange" min="${pm.min}" max="${pm.max}" value="${occupyN}">
        <div class="btn-row" style="margin-top:10px"><button id="occMin">Mínimo (${pm.min})</button><button id="occMax">Máximo (${pm.max})</button></div>
        <button class="primary" id="occOk" style="width:100%;margin-top:12px">Ocupar</button>`);
      const range = $('#occRange');
      const setN = (v) => { occupyN = Number(v); range.value = v; $('#occN').textContent = v; };
      range.oninput = () => setN(range.value);
      $('#occMin').onclick = () => setN(pm.min);
      $('#occMax').onclick = () => setN(pm.max);
      $('#occOk').onclick = () => send({ type: 'occupy', n: occupyN });
      return;
    }
    if (rulesOpen) {
      occupyKey = '';
      const key = `rules|${rulesTab}`;
      if (modalKey !== key) openModal(rulesHtml(), true, key);
      return;
    }
    if (S && S.expanded && treeOpen && S.phase !== 'over') {
      openModal(treeHtml(), true);
      occupyKey = '';
      return;
    }
    if (S && S.phase === 'over' && !winDismissed) {
      openModal(winHtml());
      occupyKey = '';
      $('#closeWin').onclick = () => { winDismissed = true; closeModal(); };
      const again = $('#againBtn');
      if (again) again.onclick = () => socket.emit('backToLobby', {}, (r) => { if (!r.ok) toast(r.error, true); });
      return;
    }
    closeModal();
  }

  $('#modal').addEventListener('click', (e) => {
    if (e.target !== $('#modal')) return;
    if (rulesOpen) closeRules();
    else if (treeOpen && S) { treeOpen = false; renderModal(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (rulesOpen) closeRules();
    else if (treeOpen && S) { treeOpen = false; renderModal(); }
  });

  buildMap();
})();
