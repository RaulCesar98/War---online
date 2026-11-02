(async () => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
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
  let kit = 'obj'; // aba do painel "objetivo / cartas / ação / pesquisa"
  let autoKitKey = '';
  const ACTIVE_PHASES = ['reinforce', 'attack', 'fortify'];

  // ícone e categoria de cada tipo de jogada (lista de jogadas, histórico e legenda do mapa)
  const KINDS = {
    start: ['🏁', 'turn'], turn: ['🔄', 'turn'], phase: ['➡️', 'turn'], ready: ['✔️', 'turn'], auto: ['⏱️', 'turn'], win: ['🏆', 'turn'],
    lastRound: ['⏳', 'turn'], limit: ['🏁', 'turn'],
    reinforce: ['➕', 'reinforce'], place: ['➕', 'reinforce'],
    attack: ['⚔️', 'attack'], conquer: ['🚩', 'attack'], destroy: ['💥', 'attack'], eliminate: ['☠️', 'attack'], fire: ['🎯', 'attack'],
    occupy: ['🚶', 'move'], move: ['🔁', 'move'],
    trade: ['🃏', 'cards'], draw: ['🂠', 'cards'], card: ['🎴', 'cards'], spy: ['🕵️', 'cards'], truce: ['🕊️', 'cards'], rage: ['🔥', 'cards'], sabotage: ['🧨', 'cards'],
    build: ['🏗️', 'arsenal'], tech: ['🧪', 'arsenal'], unlock: ['🔓', 'arsenal'],
  };
  const KIND_FILTERS = [['all', 'Tudo'], ['attack', '⚔️ Ataques'], ['move', '🔁 Movimentos'], ['reinforce', '➕ Reforços'], ['cards', '🃏 Cartas'], ['arsenal', '🧪 Arsenal'], ['turn', '🔄 Turnos']];
  const kindOf = (l) => KINDS[l.k] || ['•', 'turn'];
  const NO_TICKER = ['phase', 'draw', 'ready'];
  const canReplay = (l) => !!(l.m && (l.m.to || l.m.from));

  // ---------- relógio da fase, sons e animações ----------

  const REDUCED = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const sfx = (name) => { if (window.SFX) window.SFX.play(name); };
  let fxLayer = null;
  let trailLayer = null; // rastros e setas ficam abaixo das comunidades
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

  // --- trajetos no mapa: tropas que marcham, setas de ataque, reforços que caem ---

  const pHex = (p) => (p !== null && p !== undefined && S.players[p] ? color(S.players[p].color).hex : '#ffffff');
  const pText = (p) => (p !== null && p !== undefined && S.players[p] ? color(S.players[p].color).text : '#000000');

  // caminho mais curto de comunidade em comunidade (só pelas do dono, quando informado)
  function pathIds(from, to, owner) {
    if (ADJ[from].includes(to)) return [from, to];
    const prev = { [from]: null };
    const q = [from];
    while (q.length) {
      const c = q.shift();
      if (c === to) break;
      ADJ[c].forEach((n) => {
        if (!(n in prev) && (n === to || owner === null || owner === undefined || S.terr[n].o === owner)) { prev[n] = c; q.push(n); }
      });
    }
    if (!(to in prev)) return [from, to];
    const out = [];
    for (let c = to; c !== null; c = prev[c]) out.unshift(c);
    return out;
  }

  // trechos retos do caminho; uma ligação que dá a volta no mapa sai por uma borda e entra pela outra
  function pathSegs(ids) {
    const raw = [];
    for (let k = 1; k < ids.length; k++) {
      const A = TERR[ids[k - 1]];
      const B = TERR[ids[k]];
      if (Math.abs(A.x - B.x) <= 500) { raw.push([A.x, A.y, B.x, B.y]); continue; }
      const left = A.x < B.x;
      raw.push([A.x, A.y, left ? 0 : 1000, left ? A.y + 12 : A.y - 12]);
      raw.push([left ? 1000 : 0, left ? B.y - 12 : B.y + 12, B.x, B.y]);
    }
    return raw.map(([x1, y1, x2, y2]) => ({ x1, y1, x2, y2, len: Math.hypot(x2 - x1, y2 - y1) }));
  }

  // ponta de seta encostada na borda do círculo de destino
  function arrowHead(sg, col, parent) {
    const ang = Math.atan2(sg.y2 - sg.y1, sg.x2 - sg.x1);
    const back = Math.min(23, sg.len);
    const x = sg.x2 - Math.cos(ang) * back;
    const y = sg.y2 - Math.sin(ang) * back;
    return el('polygon', { class: 'fx-head', points: '0,0 -13,-8 -13,8', fill: col, transform: `translate(${x},${y}) rotate(${(ang * 180) / Math.PI})` }, parent);
  }

  function fadeOut(node, after) {
    setTimeout(() => { node.classList.add('fx-gone'); setTimeout(() => node.remove(), 650); }, after);
  }

  // ficha com a quantidade de soldados percorrendo o caminho, com rastro e seta até o destino
  function fxTravel(ids, { col, txt, label, onEnd }) {
    if (REDUCED || !fxLayer) { if (onEnd) onEnd(); return; }
    const segs = pathSegs(ids);
    const total = segs.reduce((s, x) => s + x.len, 0) || 1;
    const dur = Math.min(2300, Math.max(850, 500 + total * 2.4));
    const trail = el('g', { class: 'fx-trailset' }, trailLayer);
    const lines = segs.map((sg) => el('line', { class: 'fx-trail', x1: sg.x1, y1: sg.y1, x2: sg.x1, y2: sg.y1, stroke: col }, trail));
    const tok = el('g', { class: 'fx-token' }, fxLayer);
    el('circle', { r: 13, fill: col }, tok);
    if (label) { const t = el('text', { fill: txt }, tok); t.textContent = label; }
    const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);
    const t0 = performance.now();
    (function frame(now) {
      const p = Math.min(1, (now - t0) / dur);
      let rem = ease(p) * total;
      let pos = null;
      segs.forEach((sg, k) => {
        const part = Math.max(0, Math.min(sg.len, rem));
        const r = sg.len ? part / sg.len : 1;
        const x = sg.x1 + (sg.x2 - sg.x1) * r;
        const y = sg.y1 + (sg.y2 - sg.y1) * r;
        lines[k].setAttribute('x2', x);
        lines[k].setAttribute('y2', y);
        if (!pos && rem <= sg.len) pos = [x, y];
        rem -= sg.len;
      });
      if (!pos) { const l = segs[segs.length - 1]; pos = [l.x2, l.y2]; }
      tok.setAttribute('transform', `translate(${pos[0]},${pos[1]})`);
      if (p < 1) { requestAnimationFrame(frame); return; }
      arrowHead(segs[segs.length - 1], col, trail);
      tok.classList.add('arrive');
      setTimeout(() => tok.remove(), 400);
      fadeOut(trail, 1100);
      fxPulse(ids[ids.length - 1]);
      if (onEnd) onEnd();
    }(t0));
  }

  // seta de ataque (tracejada e animada) que some sozinha
  function fxArrow(ids, col, ms = 1700) {
    if (REDUCED || !trailLayer) return;
    const segs = pathSegs(ids);
    const g = el('g', { class: 'fx-attack' }, trailLayer);
    segs.forEach((sg) => el('line', { x1: sg.x1, y1: sg.y1, x2: sg.x2, y2: sg.y2, stroke: col }, g));
    arrowHead(segs[segs.length - 1], col, g);
    fadeOut(g, ms);
  }

  // reforço: ficha cai do alto sobre a comunidade
  function fxDrop(id, n, col, txt, onEnd) {
    if (REDUCED || !fxLayer) { if (onEnd) onEnd(); return; }
    const t = TERR[id];
    const tok = el('g', { class: 'fx-token' }, fxLayer);
    el('circle', { r: 12, fill: col }, tok);
    const tx = el('text', { fill: txt }, tok);
    tx.textContent = `+${n}`;
    const t0 = performance.now();
    const dur = 520;
    (function frame(now) {
      const p = Math.min(1, (now - t0) / dur);
      tok.setAttribute('transform', `translate(${t.x},${t.y - 70 * (1 - p * p)})`);
      tok.style.opacity = Math.min(1, p * 3);
      if (p < 1) { requestAnimationFrame(frame); return; }
      tok.classList.add('arrive');
      setTimeout(() => tok.remove(), 400);
      if (onEnd) onEnd();
    }(t0));
  }

  // soldados a caminho: o número do destino só muda quando a ficha chega
  const holds = {};
  let freshHolds = {};
  const shownArmy = (id) => {
    const s = S.terr[id];
    if (S.pendingMove && S.pendingMove.to === id) return 0;
    return Math.max(0, s.a - (holds[id] || 0));
  };
  function holdArmy(id, n) {
    holds[id] = (holds[id] || 0) + n;
    freshHolds[id] = (freshHolds[id] || 0) + n;
  }
  function releaseArmy(id, n) {
    holds[id] = Math.max(0, (holds[id] || 0) - n);
    if (!holds[id]) delete holds[id];
    if (!S || !nodeEls[id]) return;
    $('.army', nodeEls[id]).textContent = shownArmy(id);
    fxClass(id, 'flash', 800);
    fxFloat(id, `+${n}`, '#7dffa8');
    sfx('place');
  }

  // legenda que aparece sobre o mapa narrando cada jogada
  const tickerQ = [];
  let tickerBusy = false;
  let tickerTimer;
  function queueTicker(l) {
    tickerQ.push(l);
    if (tickerQ.length > 5) tickerQ.shift();
    if (!tickerBusy) nextTicker();
  }
  function nextTicker() {
    const l = tickerQ.shift();
    if (!l) { tickerBusy = false; return; }
    tickerBusy = true;
    showTicker(l);
    setTimeout(nextTicker, tickerQ.length ? 1500 : 900);
  }
  function showTicker(l) {
    const box = $('#ticker');
    box.innerHTML = `<span class="tk-ic">${kindOf(l)[0]}</span><span>${esc(l.t)}</span>`;
    box.style.setProperty('--pc', pHex(l.p));
    box.classList.remove('show');
    void box.offsetWidth;
    box.classList.add('show');
    clearTimeout(tickerTimer);
    tickerTimer = setTimeout(() => box.classList.remove('show'), 4500);
  }

  // repete no mapa uma jogada do registro (sem mexer nos números)
  function replay(l) {
    const m = l.m || {};
    const col = pHex(l.p);
    showTicker(l);
    if ((l.k === 'move' || l.k === 'occupy') && m.from && m.to) {
      sfx('move');
      fxPulse(m.from);
      fxTravel(pathIds(m.from, m.to, l.k === 'move' ? l.p : null), { col, txt: pText(l.p), label: m.n ? String(m.n) : '' });
    } else if ((l.k === 'attack' || l.k === 'fire' || l.k === 'conquer') && m.from && m.to) {
      sfx(l.k === 'fire' ? 'fire' : 'dice');
      fxPulse(m.from);
      fxArrow(pathIds(m.from, m.to, null), l.k === 'fire' ? '#ffb347' : '#ff5a5f');
      fxShot(m.from, m.to, l.k === 'fire' ? '#ffb347' : '#ff5a5f', () => { fxShake(m.to); fxRing(m.to, l.k === 'conquer' ? col : '#ff9d2e', true); });
    } else if (l.k === 'reinforce' && m.to) {
      fxDrop(m.to, m.n || 1, col, pText(l.p), () => fxFloat(m.to, `+${m.n || 1}`, '#7dffa8'));
    } else if (m.to) {
      fxPulse(m.to);
      fxRing(m.to, col, true);
    }
  }

  // animação e sons de um combate recém-resolvido
  function fxCombat(c) {
    sfx('dice');
    fxPulse(c.from);
    fxArrow(pathIds(c.from, c.to, null), '#ff5a5f');
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
      case 'lastRound': sfx('rage'); toast('⏳ Última rodada! Ao final vence quem tiver mais pontos.'); break;
      case 'win':
        sfx(S.winner === me() ? 'win' : 'lose');
        if (S.winner === me()) confetti();
        break;
      case 'fire':
        sfx('fire');
        if (m.from && m.to) {
          fxArrow(pathIds(m.from, m.to, null), '#ffb347');
          fxShot(m.from, m.to, '#ffb347', () => { fxRing(m.to, '#ff7a3c', true); fxShake(m.to); });
        }
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
      case 'move': case 'occupy': {
        // a ficha sai da origem e só soma no destino quando chega
        sfx('move');
        if (!m.from || !m.to) break;
        const n = m.n || 0;
        if (n) holdArmy(m.to, n);
        fxPulse(m.from);
        fxTravel(pathIds(m.from, m.to, l.k === 'move' ? l.p : null), {
          col, txt: pText(l.p), label: n ? String(n) : '', onEnd: () => { if (n) releaseArmy(m.to, n); },
        });
        break;
      }
      case 'reinforce':
        if (m.to && m.n) {
          holdArmy(m.to, m.n);
          fxDrop(m.to, m.n, col, pText(l.p), () => releaseArmy(m.to, m.n));
        }
        break;
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
    fresh.filter((l) => !NO_TICKER.includes(l.k)).forEach(queueTicker);
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

  // --- barra de status: tempo de partida, IP do servidor e latência ---

  let clockSkew = 0; // relógio do servidor − relógio local
  let latency = null; // ms da última medição (null = sem resposta)
  let SERVER = null;
  fetch('/api/server').then((r) => r.json()).then((d) => { SERVER = d; updateStatus(); }).catch(() => {});

  const fmtDuration = (ms) => {
    const t = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = String(t % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  };

  function measureLatency() {
    if (!socket.connected) { latency = null; updateStatus(); return; }
    const t0 = performance.now();
    socket.timeout(4000).emit('latency', {}, (err) => {
      latency = err ? null : Math.round(performance.now() - t0);
      updateStatus();
    });
  }
  setInterval(measureLatency, 2000);

  function updateStatus() {
    const time = $('#sbTime');
    if (!time || !S) return;
    const end = S.endedAt || Date.now() + clockSkew;
    time.textContent = fmtDuration(end - (S.startedAt || end));
    $('#sbTimeBox').title = S.endedAt ? 'Duração total da partida' : 'Tempo de partida';
    if (SERVER) {
      const ip = SERVER.ips[0] || location.hostname;
      $('#sbHost').textContent = `${ip}:${SERVER.port}`;
      $('#sbHostBox').title = `Servidor ${SERVER.hostname}\nIPs: ${SERVER.ips.join(', ') || '—'}\nVocê está conectado por ${location.host}`;
    }
    const ping = $('#sbPing');
    ping.className = `sb-ping ${latency === null ? 'bad' : latency < 80 ? 'good' : latency < 200 ? 'mid' : 'bad'}`;
    $('b', ping).textContent = latency === null ? 'sem resposta' : `${latency} ms`;
  }
  setInterval(updateStatus, 1000);

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
      Object.keys(holds).forEach((k) => delete holds[k]);
      if (histOpen) closeHistory();
      histLog = [];
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
    if (st.timer && st.timer.now) clockSkew = st.timer.now - Date.now();
    if (st.timer && st.timer.deadline) {
      timerEnd = Date.now() + (st.timer.deadline - st.timer.now);
      timerTotal = Math.max(1000, st.timer.total || 60000);
    } else {
      timerEnd = 0;
    }
    if (first) { lastSeq = null; prevCardIds = null; prevActionIds = null; showScreen('game'); seenCombat = (S.lastCombat && S.lastCombat.id) || 0; chatSeen = ROOM ? ROOM.chat.length : 0; }
    renderGame();
    if (first && location.hash === '#historico') openHistory(false);
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
  $('#roundsSel').innerHTML = MAP.roundOptions.map((o) => `<option value="${o.rounds}">${esc(o.name)} · ${esc(o.desc)}</option>`).join('');
  $('#roundsSel').onchange = (e) => socket.emit('setOptions', { rounds: Number(e.target.value) }, (r) => { if (!r.ok) toast(r.error, true); });

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
    $('#roundsSel').value = String(ROOM.rounds || 0);
    $('#roundsSel').disabled = !host;
    $('#roundsRow').classList.toggle('off', !host);
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

    trailLayer = el('g', { id: 'trails', 'pointer-events': 'none' }, svg);

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
      army.textContent = shownArmy(t.id);
      if (prevTerr) {
        const pv = prevTerr[t.id];
        // soldados a caminho só aparecem (com o "+n") quando a ficha chega
        const d = s.a - pv.a - (freshHolds[t.id] || 0);
        if (d !== 0 || pv.o !== s.o) { g.classList.remove('flash'); void g.getBBox(); g.classList.add('flash'); }
        if (pv.o !== s.o) {
          fxRing(t.id, c.hex, true);
        } else if (d !== 0) {
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
      } else if (S.phase === 'fortify' && S.fortifiesLeft > 0) {
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
    freshHolds = {};

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
      if (S.fortifiesLeft <= 0) return toast(`Você já usou os ${MAP.fortifyPerTurn} remanejamentos deste turno. Encerre o turno.`, true);
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

    // ajuda contextual: com 5+ cartas, abre a aba de cartas uma vez por fase
    if (myTurn() && S.me.mustTrade && autoKitKey !== selKey) { autoKitKey = selKey; kit = 'cards'; }

    renderTopbar();
    processEvents(); // antes do mapa: registra os soldados que ainda estão a caminho
    updateMap();
    renderBanner();
    renderActions();
    renderKit();
    renderResearch();
    renderCombat();
    renderPlayers();
    renderObjective();
    renderHand();
    renderActionHand();
    renderLog();
    renderModal();
    if (histOpen) mergeHistory();
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
      ${S.round ? `<span class="${S.maxRounds && S.round >= S.maxRounds && S.phase !== 'over' ? 'round-last' : 'muted'}">Rodada ${S.round}${S.maxRounds ? `/${S.maxRounds}` : ''}</span>` : ''}
      <div class="statusbar">
        <span id="sbTimeBox">⏱ <b id="sbTime">0:00</b></span>
        <span id="sbHostBox">🖥 <b id="sbHost">…</b></span>
        <span id="sbPing" class="sb-ping" title="Latência: tempo de ida e volta até o servidor">📶 <b>…</b></span>
      </div>
      <div class="top-actions">
        <button id="histBtn" class="mini">📜 Histórico</button>
        <button id="rulesBtn" class="mini">📖 Regras</button>
        <button id="exitBtn" class="mini">Sair</button>
      </div>`;
    $('#histBtn').onclick = () => openHistory(true);
    updateStatus();
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
        reinforce: `Sua vez — Reforço<small>Distribua ${S.me.pool} soldado(s)${S.turnInfo ? ` (${S.turnInfo.base} por comunidades${S.turnInfo.continents.length ? ' + regiões' : ''}${S.turnInfo.war ? ` + ${S.turnInfo.war} de escalada` : ''})` : ''}. Você também pode trocar cartas.</small>`,
        attack: 'Sua vez — Ataque<small>Escolha uma comunidade sua (2+ soldados) e depois uma vizinha rival.</small>',
        fortify: `Sua vez — Remanejamento<small>${S.fortifiesLeft > 0 ? `Restam ${S.fortifiesLeft} de ${MAP.fortifyPerTurn} remanejamentos. Mova soldados entre comunidades vizinhas suas ou encerre o turno.` : 'Remanejamentos esgotados: encerre o turno.'}</small>`,
      };
      html = t[S.phase];
    } else {
      html = `${dot(cur.color)} Vez de <b>${esc(cur.name)}</b><small>${{ reinforce: 'Posicionando reforços…', attack: 'Atacando…', fortify: 'Remanejando tropas…' }[S.phase]}</small>`;
    }
    const key = `${S.phase}|${S.turn}|${S.round}`;
    if (key !== bannerKey) { bannerKey = key; bannerFlipUntil = Date.now() + 700; }
    if (S.maxRounds && S.round >= S.maxRounds && S.phase !== 'over' && S.phase !== 'setup') {
      html += '<small class="last-note">⏳ Última rodada: ao final vence quem tiver mais pontos 🏅</small>';
    }
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

  const AUTO_PLACE_BTN = '<button data-do="autoPlace" title="Espalha os soldados que faltam nas suas comunidades de fronteira, começando pelas mais fracas">⚡ Distribuir automaticamente</button>';
  const CLEAR_SEL_BTN = '<button data-do="clearSel" title="Desfaz a seleção (Esc)">✖ Cancelar seleção</button>';

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
          h = `<p class="muted">Clique em uma comunidade sua para adicionar soldados. Faltam <b>${S.me.pool}</b>. Ao distribuir tudo, você fica pronto.</p>`;
        }
        h += AUTO_PLACE_BTN;
      } else {
        h = '<p>Tudo distribuído!</p><button class="primary" data-do="ready">Estou pronto</button>';
      }
    } else if (!myTurn()) {
      h = '<p class="muted">Aguarde sua vez. Enquanto isso, clique nas comunidades para inspecionar.</p>';
    } else if (p === 'reinforce' || placeMode()) {
      const need = S.me.mustTrade ? '<p class="muted">⚠ Você tem 5 ou mais cartas: é obrigatório trocar (aba 🃏 Cartas).</p>' : '';
      const body = sel.a && S.terr[sel.a].o === me()
        ? `<div class="selbox">Colocar em <b>${esc(TERR[sel.a].name)}</b> (${S.terr[sel.a].a} soldado(s))</div>${stepperHtml({ act: 'place', text: 'Colocar' }, S.me.pool)}`
        : `<p class="muted">${S.me.pool > 0 ? `Clique em uma comunidade sua para reforçar. Restam <b>${S.me.pool}</b>.` : 'Reforços distribuídos.'}</p>`;
      const auto = S.me.pool > 0 ? AUTO_PLACE_BTN : '';
      const next = p === 'reinforce'
        ? `<button class="primary" data-do="endReinforce" ${S.me.pool > 0 || S.me.mustTrade ? 'disabled' : ''}>Ir para o ataque ➜</button>` : '';
      h = need + body + auto + next;
    } else if (p === 'attack') {
      if (S.me.mustTrade) {
        h = '<p class="muted">⚠ Você tem 5 ou mais cartas: troque antes de continuar (aba 🃏 Cartas).</p>';
      } else if (sel.a && sel.b) {
        const f = S.terr[sel.a]; const t = S.terr[sel.b];
        const maxDice = Math.min(3, f.a - 1);
        dice = Math.max(1, Math.min(dice, maxDice));
        const defDice = Math.min(3, t.a);
        const mods = attackMods(sel.a, sel.b, dice, defDice);
        h = `<div class="selbox"><b>${esc(TERR[sel.a].name)}</b> (${f.a}) ⚔ <b>${esc(TERR[sel.b].name)}</b> (${t.a}) ${dot(t.o)}</div>
          <div class="dice-pick">${[1, 2, 3].filter((n) => n <= maxDice).map((n) => `<button data-do="dice" data-v="${n}" class="${n === dice ? 'on' : ''}">${n} dado${n > 1 ? 's' : ''}</button>`).join('')}</div>
          <div class="dice-explain">
            <div class="de-count"><span>🎲 Você rola <b>${dice}</b></span><span>${dot(t.o)} ${esc(S.players[t.o].name)} rola <b>${defDice}</b></span></div>
            <small>${maxDice < 3 ? `Máximo de ${maxDice} dado(s): 1 soldado sempre fica na origem. ` : ''}A defesa rola 1 dado por soldado (até 3).</small>
            <small>Os dados são comparados do maior para o menor; em cada par, quem tirar menos perde 1 soldado. <b>Empate: defesa vence.</b> ${Math.min(dice, defDice) === 1 ? 'Só 1 par: 1 soldado sai do jogo nesta rolagem.' : `São <b>${Math.min(dice, defDice)}</b> pares: ${Math.min(dice, defDice)} soldados saem do jogo nesta rolagem, somando os dois lados.`}</small>
            ${mods.length ? `<small class="de-mods">⚡ ${mods.join(' · ')}</small>` : ''}
            <button class="link small" data-do="diceRules">Ver regras dos dados</button>
          </div>
          <div class="btn-row"><button class="danger" data-do="attack">Atacar</button><button class="danger" data-do="blitz" title="Rola com o máximo de dados até dominar ou ficar com 1 soldado">Atacar até o fim</button></div>`;
      } else if (sel.a) {
        h = `<div class="selbox">Atacando de <b>${esc(TERR[sel.a].name)}</b> (${S.terr[sel.a].a}). Escolha uma vizinha rival (marcada em vermelho).</div>`;
      } else {
        h = '<p class="muted">Escolha uma comunidade sua com 2+ soldados para atacar a partir dela.</p>';
      }
      h += `<div class="btn-row"><button data-do="endAttack" ${S.me.mustTrade ? 'disabled' : ''}>Remanejar ➜</button><button data-do="endTurn" ${S.me.mustTrade ? 'disabled' : ''}>Encerrar turno</button></div>`;
    } else if (p === 'fortify') {
      const left = S.fortifiesLeft;
      const total = MAP.fortifyPerTurn;
      const pips = Array.from({ length: total }, (_, k) => `<i class="${k < total - left ? 'used' : ''}"></i>`).join('');
      h = `<div class="fort-left"><span class="pips">${pips}</span><span>${left ? `<b>${left}</b> de ${total} remanejamentos restantes neste turno` : '<b>Remanejamentos esgotados</b> neste turno'}</span></div>`;
      if (!left) {
        h += '<p class="muted">Você já fez os remanejamentos permitidos. Encerre o turno.</p>';
      } else if (sel.a && sel.b) {
        h += `<div class="selbox">Mover de <b>${esc(TERR[sel.a].name)}</b> para <b>${esc(TERR[sel.b].name)}</b></div>${stepperHtml({ act: 'fortify', text: 'Mover' }, ctxMax())}${CLEAR_SEL_BTN}`;
      } else if (sel.a) {
        h += `<div class="selbox">Origem: <b>${esc(TERR[sel.a].name)}</b>. Escolha um vizinho seu (marcado em verde).</div>${CLEAR_SEL_BTN}`;
      } else {
        h += '<p class="muted">Clique em uma comunidade sua e depois em uma vizinha sua. Cada movimento conta 1 remanejamento, não importa quantos soldados leve. Tropas que acabaram de chegar não se movem de novo neste turno.</p>';
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
      case 'clearSel': sel = { a: null, b: null }; return renderGame();
      case 'cardPlayer': send({ type: 'playCard', card: mode.card, player: Number(b.dataset.p) }); mode = null; return renderGame();
      case 'cardMove': send({ type: 'playCard', card: mode.card, from: mode.from, to: mode.to, n: qty }); mode = null; return renderGame();
      case 'qty-': qty = Math.max(1, qty - 1); return renderActions();
      case 'qty+': qty = Math.min(max, qty + 1); return renderActions();
      case 'qtymax': qty = max; return renderActions();
      case 'place': send({ type: 'place', territory: sel.a, n: qty }); return;
      case 'autoPlace': send({ type: 'autoPlace' }); return;
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
      case 'diceRules': rulesTab = 'dados'; rulesOpen = true; renderModal(); return;
      default:
    }
  });

  // ---------- combate ----------

  // dados lado a lado em pares (maior × maior, 2º × 2º, 3º × 3º), dizendo quem perdeu soldado em cada par
  const PAIR_NAMES = ['maior', '2º', '3º'];
  function duelHtml({ att, def, attBonus = [], defBonus = [], pairs, roll, labels = ['Ataque', 'Defesa'] }) {
    const pr = pairs || att.slice(0, Math.min(att.length, def.length)).map((a, k) => ({ w: a > def[k] ? 'att' : 'def', tie: a === def[k] }));
    const n = Math.max(att.length, def.length);
    const die = (v, cls, lost, bonus) => (v === undefined
      ? '<span class="die none">–</span>'
      : `<span class="die ${cls}${lost ? ' lost' : ''}${roll ? ' roll' : ''}">${v}${bonus ? '<sup title="Bônus de +1">+1</sup>' : ''}</span>`);
    const cols = Array.from({ length: n }, (_, k) => {
      const p = pr[k];
      let verdict = '<span class="verdict none">sem par<small>não conta</small></span>';
      if (p && p.w === 'att') verdict = `<span class="verdict att-win">defesa −1${p.tie ? '<small>empate a favor do ataque</small>' : ''}</span>`;
      if (p && p.w === 'def') verdict = `<span class="verdict def-win">ataque −1${p.tie ? '<small>empate: defesa vence</small>' : ''}</span>`;
      return `<div class="pair${p ? '' : ' unpaired'}"><span class="pair-name">${PAIR_NAMES[k]}</span>${die(att[k], 'att', p && p.w === 'def', attBonus[k])}<span class="vs">×</span>${die(def[k], 'def', p && p.w === 'att', defBonus[k])}${verdict}</div>`;
    }).join('');
    return `<div class="duel"><div class="duel-side"><span class="pair-name"></span><span class="side-l att">${labels[0]}</span><span class="vs"></span><span class="side-l def">${labels[1]}</span></div>${cols}</div>`;
  }

  // o que muda a regra dos dados neste ataque (modo expandido)
  function attackMods(from, to, nAtt, nDef) {
    if (!S.expanded) return [];
    const f = S.terr[from];
    const t = S.terr[to];
    const mine = S.players[me()].techs;
    const theirs = S.players[t.o].techs;
    const out = [];
    if (f.w === 'canhao') out.push(`${X.weapons.canhao.icon} seu maior dado ganha +1`);
    if (t.w === 'bunker') out.push(`${X.weapons.bunker.icon} o maior dado da defesa ganha +1`);
    if (nDef === 3 && theirs.includes('trincheiras')) out.push('🧱 o menor dado da defesa ganha +1');
    if (mine.includes('guerra_total')) out.push('⚔️ todo empate fica com você');
    else {
      if (S.buff.ofensiva || (f.w === 'tanques' && nAtt === 3)) out.push('⚔️ empate no maior par fica com você');
      if (mine.includes('assalto')) out.push('⚔️ empates no 2º e 3º pares ficam com você');
    }
    if (theirs.includes('muralha')) out.push('🛡️ a defesa perde no máximo 1 soldado por rolagem');
    return out;
  }

  function renderCombat() {
    const box = $('#combat');
    const c = S.lastCombat;
    if (!c) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const isNew = c.id !== seenCombat;
    seenCombat = c.id;
    const neg = (n) => (n ? `−${n}` : '0');
    const last = c.rounds > 1 && c.lastLossA !== undefined ? ` <span class="muted">(última: ataque ${neg(c.lastLossA)}, defesa ${neg(c.lastLossD)})</span>` : '';
    box.innerHTML = `
      <div class="panel-title">Último combate${c.rounds > 1 ? ` <span class="muted">${c.rounds} rolagens · abaixo a última</span>` : ''}</div>
      <div class="combat-head">${dot(c.attColor)}<b>${esc(c.att)}</b><span class="muted">${esc(TERR[c.from].name)}</span><span class="sw">⚔</span>${dot(c.defColor)}<b>${esc(c.def)}</b><span class="muted">${esc(TERR[c.to].name)}</span></div>
      ${duelHtml({ att: c.attDice, def: c.defDice, attBonus: c.attBonus, defBonus: c.defBonus, pairs: c.pairs, roll: isNew })}
      <div class="combat-sum">${c.rounds > 1 ? 'Total do ataque' : 'Resultado'}: ataque <b>${neg(c.lossA)}</b> · defesa <b>${neg(c.lossD)}</b>${last}${c.conquered ? ' · <b style="color:var(--ok)">DOMINADA!</b>' : ''}</div>
      ${c.notes && c.notes.length ? `<div class="combat-notes">⚡ ${c.notes.map(esc).join(' · ')}</div>` : ''}`;
    if (isNew) fxCombat(c);
    if (isNew && c.conquered) toast(`${c.att} dominou ${TERR[c.to].name}!`);
  }

  // ---------- modo expandido: pesquisa, cartas de ação, árvores ----------

  // abas do painel pessoal: objetivo, cartas, cartas de ação e pesquisa
  function renderKit() {
    const exp = S.expanded && S.phase !== 'setup';
    if (!exp && (kit === 'acts' || kit === 'res')) kit = 'obj';
    $$('#kitTabs [data-kit]').forEach((b) => {
      const k = b.dataset.kit;
      b.classList.toggle('hidden', !exp && (k === 'acts' || k === 'res'));
      b.classList.toggle('active', k === kit);
    });
    $$('.kit-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== kit));
  }
  $('#kitTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kit]');
    if (!b || !S) return;
    kit = b.dataset.kit;
    renderKit();
  });

  function renderResearch() {
    const box = $('#research');
    if (!S.expanded || S.phase === 'setup') return;
    const p = S.players[me()];
    box.innerHTML = `<div class="res-row"><span class="pp" title="Pontos de Pesquisa">🔬 ${p.pp} PP</span>
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
    if (!S.expanded || S.phase === 'setup') return;
    const hand = S.me.actionHand;
    if (prevActionIds) hand.filter((c) => !prevActionIds.has(c.id)).forEach((c) => { dealUntil[c.id] = Date.now() + 800; });
    prevActionIds = new Set(hand.map((c) => c.id));
    $('#actsCount').textContent = hand.length || '';
    $('#actionInfo').textContent = `${hand.length}/${X.handMax} na mão · baralho de ação: ${S.actionDeckCount}`;
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
      const mark = S.phase === 'setup' ? (p.ready ? ' ✔' : ' …') : '';
      const pool = p.pool && S.phase !== 'setup' ? `<span class="badge">+${p.pool} a distribuir</span>` : '';
      const extra = `${pool}${offline ? '<span class="badge off">offline</span>' : ''}${p.afk ? '<span class="badge off" title="Estourou o tempo; joga automaticamente até voltar">ausente</span>' : ''}${truceNote(p.idx)}${canAuto ? `<button class="mini" data-auto="${p.idx}">Jogar por ele</button>` : ''}`;
      return `<div class="pl ${S.turn === p.idx && S.phase !== 'setup' && S.phase !== 'over' ? 'turn' : ''} ${p.alive ? '' : 'dead'}">
        ${dot(p.color)}<span class="nm" title="${esc(color(p.color).faction)}">${esc(p.name)}${p.idx === me() ? ' <small>(você)</small>' : ''}${mark}</span>
        <span class="stats">${S.maxRounds ? `<span title="Pontos (comunidades + bônus das regiões inteiras): vence quem tiver mais ao fim das ${S.maxRounds} rodadas">🏅 <b>${p.score}</b></span>` : ''}<span title="Comunidades">🗺 <b>${p.territories}</b></span><span title="Soldados">⚔ <b>${p.armies}</b></span><span title="Cartas">🃏 <b>${p.cards}</b></span>${S.expanded ? `<span title="Pontos de Pesquisa">🔬 <b>${p.pp}</b></span>` : ''}</span>
        ${extra ? `<div class="extra">${extra}</div>` : ''}
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
    $('#eyeBtn').textContent = objHidden ? '👁 mostrar objetivo' : '🙈 ocultar objetivo';
  }
  $('#eyeBtn').onclick = () => { objHidden = !objHidden; if (S) renderObjective(); };

  function validSet(cards) {
    if (cards.length !== 3) return false;
    const syms = cards.filter((c) => c.symbol !== 'coringa').map((c) => c.symbol);
    const u = new Set(syms).size;
    return syms.length <= 1 || u === 1 || u === syms.length;
  }
  const nextTradeValue = () => S.nextTrade;

  // ---------- regras da troca de cartas ----------

  const symHtml = (s) => `<span class="msym ${s}">${SYM[s]}</span>`;
  // valor da troca de número n (0 = primeira da partida); a sequência é global
  const tradeValueAt = (n) => (n < MAP.tradeSeq.length ? MAP.tradeSeq[n] : MAP.tradeSeq[MAP.tradeSeq.length - 1] + 5 * (n - MAP.tradeSeq.length + 1));

  // quantas cartas faltam para ter 3 que formem uma troca válida
  function cardsMissing(cards) {
    const wild = cards.filter((c) => c.symbol === 'coringa').length;
    const count = (s) => cards.filter((c) => c.symbol === s).length;
    const syms = ['triangulo', 'quadrado', 'circulo'];
    const same = Math.min(...syms.map((s) => Math.max(0, 3 - count(s) - wild)));
    const distinct = syms.filter((s) => count(s) > 0).length;
    const diff = Math.max(0, 3 - Math.min(3, distinct + wild));
    return Math.min(same, diff);
  }

  // que regra as 3 cartas escolhidas seguem (ou por que não valem)
  function setRule(cards) {
    const syms = cards.filter((c) => c.symbol !== 'coringa').map((c) => c.symbol);
    const u = new Set(syms).size;
    const wild = cards.length - syms.length;
    const wildNote = wild ? ` — ${wild > 1 ? `os ${SYM.coringa} coringas substituem` : `o ${SYM.coringa} coringa substitui`} o que falta` : '';
    if (syms.length <= 1) return { ok: true, text: `Coringas completam a combinação${syms.length ? ` com ${SYM[syms[0]]}` : ''}` };
    if (u === 1) return { ok: true, text: `3 do mesmo símbolo (${SYM[syms[0]]})${wildNote}` };
    if (u === syms.length) return { ok: true, text: `3 símbolos diferentes${wildNote}` };
    return { ok: false, text: 'Não vale: 2 cartas iguais e 1 diferente. Escolha 3 iguais ou 3 diferentes.' };
  }

  // melhor troca possível: prioriza cartas de comunidades suas (+2) e guarda os coringas
  function bestSet(cards) {
    let best = null;
    let bestScore = -Infinity;
    for (let a = 0; a < cards.length; a++) {
      for (let b = a + 1; b < cards.length; b++) {
        for (let c = b + 1; c < cards.length; c++) {
          const set = [cards[a], cards[b], cards[c]];
          if (!validSet(set)) continue;
          const score = set.reduce((s, x) => s + (x.territory && S.terr[x.territory].o === me() ? 10 : 0) - (x.symbol === 'coringa' ? 5 : 0), 0);
          if (score > bestScore) { bestScore = score; best = set; }
        }
      }
    }
    return best;
  }

  function tradeReward(chosen) {
    const base = nextTradeValue();
    const radio = S.expanded && S.players[me()].techs.includes('propaganda') ? 2 : 0;
    const bonus = chosen.filter((c) => c.territory && S.terr[c.territory].o === me()).map((c) => TERR[c.territory].name);
    return { base, radio, bonus, total: base + radio };
  }

  function renderTradeGuide(cards, canNow) {
    const missing = cardsMissing(cards);
    const ready = missing === 0;
    const plural = (n, s, p) => (n === 1 ? s : p);
    let cls = 'info';
    let msg;
    if (myTurn() && S.me.mustTrade) {
      cls = 'warn';
      msg = `<b>Troca obrigatória:</b> você tem ${cards.length} cartas (com 5 ou mais é preciso trocar). Escolha 3 cartas abaixo.`;
    } else if (canNow && ready) {
      cls = 'ok';
      msg = '<b>Você pode trocar agora.</b> Escolha 3 cartas ou use “Sugerir troca”.';
    } else if (ready) {
      cls = 'ok';
      msg = `<b>Você já tem uma troca pronta.</b> Ela só pode ser feita na fase de <b>Reforço</b> do seu turno${cards.length >= 4 ? ' — com mais 1 carta ela vira obrigatória' : ''}.`;
    } else {
      msg = `<b>${plural(missing, 'Falta 1 carta', `Faltam ${missing} cartas`)}</b> para formar uma troca. Você ganha 1 carta no fim de cada turno em que dominar ao menos uma comunidade.`;
    }
    $('#tradeStatus').className = `trade-status ${cls}`;
    $('#tradeStatus').innerHTML = msg;

    // regra aplicada às cartas selecionadas
    const chosen = cards.filter((c) => handSel.has(c.id));
    let sel = '';
    if (chosen.length && chosen.length < 3) {
      sel = `<div class="tg-sel">Selecionadas: ${chosen.map((c) => symHtml(c.symbol)).join(' ')} — escolha mais ${3 - chosen.length}.</div>`;
    } else if (chosen.length === 3) {
      const r = setRule(chosen);
      if (r.ok) {
        const rw = tradeReward(chosen);
        const parts = [`<b>${rw.base}</b> soldados (${S.tradeCount + 1}ª troca da partida)`];
        if (rw.radio) parts.push(`<b>+2</b> pela ${esc(X.techs.propaganda.name)}`);
        if (rw.bonus.length) parts.push(`<b>+2</b> direto em ${rw.bonus.map(esc).join(', ')} (carta de comunidade sua)`);
        sel = `<div class="tg-sel ok">✔ ${chosen.map((c) => symHtml(c.symbol)).join(' ')} ${esc(r.text)}<br>Você recebe: ${parts.join(' · ')}</div>`;
      } else {
        sel = `<div class="tg-sel bad">✖ ${chosen.map((c) => symHtml(c.symbol)).join(' ')} ${esc(r.text)}</div>`;
      }
    }

    // sequência global de valores
    const seq = Array.from({ length: 6 }, (_, k) => Math.max(0, S.tradeCount - 2) + k)
      .map((n) => `<span class="${n < S.tradeCount ? 'past' : n === S.tradeCount ? 'next' : ''}">${tradeValueAt(n)}</span>`).join('<i>›</i>');
    const suggest = canNow && ready && cards.length >= 3 ? '<button class="mini" data-suggest="1">✨ Sugerir troca</button>' : '';
    $('#tradeGuide').innerHTML = `${sel}
      <div class="tg-rule">Vale trocar: ${symHtml('triangulo')}${symHtml('triangulo')}${symHtml('triangulo')} 3 iguais <span class="muted">ou</span> ${symHtml('triangulo')}${symHtml('quadrado')}${symHtml('circulo')} 3 diferentes. ${symHtml('coringa')} coringa vale qualquer símbolo. ${suggest}</div>
      <div class="tg-seq" title="O valor sobe para todos a cada troca feita na partida">Valor das trocas: ${seq}<i>…</i></div>`;
  }
  $('#tradeGuide').addEventListener('click', (e) => {
    if (!e.target.closest('[data-suggest]') || !S) return;
    const set = bestSet(S.me.cards);
    if (set) { handSel = new Set(set.map((c) => c.id)); renderHand(); }
  });

  function renderHand() {
    const h = $('#hand');
    const cards = S.me.cards;
    if (!cards.length) {
      h.innerHTML = '<span class="empty">Nenhuma carta na mão.</span>';
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
    const rw = tradeReward(chosen);
    btn.textContent = validSet(chosen)
      ? `Trocar por ${rw.total} soldados${rw.bonus.length ? ` (+${rw.bonus.length * 2} nas comunidades)` : ''}`
      : `Trocar cartas (escolha 3 válidas)`;
    renderTradeGuide(cards, canNow);
    $('#tradeInfo').textContent = `Baralho: ${S.deckCount} cartas · ${S.tradeCount} troca(s) feita(s) na partida`;
    $('#cardsCount').textContent = cards.length || '';
    // destaca a aba quando dá para trocar agora
    $('#kitTabs [data-kit="cards"]').classList.toggle('alert', canNow && (S.me.mustTrade || hasSet(cards)));
  }
  function hasSet(cards) {
    for (let a = 0; a < cards.length; a++) {
      for (let b = a + 1; b < cards.length; b++) {
        for (let c = b + 1; c < cards.length; c++) if (validSet([cards[a], cards[b], cards[c]])) return true;
      }
    }
    return false;
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

  // uma linha da lista de jogadas: ícone do tipo, cor do jogador e "▶" para rever no mapa
  function logLineHtml(l) {
    const [icon, cat] = kindOf(l);
    const rp = canReplay(l);
    return `<div class="logline k-${cat}${l.p === null || l.p === undefined ? ' sys' : ''}${rp ? ' replay' : ''}" ${rp ? `data-n="${l.n}" title="Ver no mapa"` : ''} style="--pc:${pHex(l.p)}">
      <span class="lic">${icon}</span><span class="ltx">${esc(l.t)}</span>${rp ? '<span class="lgo">▶</span>' : ''}</div>`;
  }
  $('#logBox').addEventListener('click', (e) => {
    const row = e.target.closest('[data-n]');
    if (!row || !S) return;
    const l = S.log.find((x) => x.n === Number(row.dataset.n));
    if (l) replay(l);
  });
  $('#historyLink').onclick = () => openHistory(true);

  $('#tabLog').onclick = () => { tab = 'log'; renderLog(); };
  $('#tabChat').onclick = () => { tab = 'chat'; chatSeen = ROOM ? ROOM.chat.length : 0; renderLog(); };

  function renderLog() {
    $('#tabLog').classList.toggle('active', tab === 'log');
    $('#tabChat').classList.toggle('active', tab === 'chat');
    $('#chatForm').classList.toggle('hidden', tab !== 'chat');
    $('#historyLink').classList.toggle('hidden', tab !== 'log');
    const box = $('#logBox');
    if (tab === 'log') {
      box.innerHTML = S.log.filter((l) => l.k !== 'phase').slice(-40).map(logLineHtml).join('');
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

  // ---------- página de histórico ----------

  let histOpen = false;
  let histPushed = false;
  let histLog = [];
  let histKind = 'all';
  let histPlayer = 'all';
  let histQuery = '';
  const PHASE_NAMES = Object.fromEntries(PHASES);

  function openHistory(push) {
    if (!S) return;
    histOpen = true;
    if (push && location.hash !== '#historico') { history.pushState(null, '', '#historico'); histPushed = true; }
    $('#history').classList.remove('hidden');
    document.body.classList.add('noscroll');
    $('#history').scrollTop = 0;
    mergeHistory();
    // o estado traz só as últimas jogadas; o servidor manda a partida inteira
    socket.emit('history', {}, (res) => {
      if (!res || !res.ok) return;
      const known = new Set(res.log.map((l) => l.n));
      histLog = [...res.log, ...histLog.filter((l) => !known.has(l.n))].sort((a, b) => a.n - b.n);
      renderHistory();
    });
  }

  function closeHistory(fromNav) {
    if (!histOpen) return;
    histOpen = false;
    $('#history').classList.add('hidden');
    document.body.classList.remove('noscroll');
    if (!fromNav && location.hash === '#historico') {
      if (histPushed) history.back(); else history.replaceState(null, '', location.pathname + location.search);
    }
    histPushed = false;
  }

  window.addEventListener('popstate', () => {
    if (location.hash === '#historico') { if (!histOpen) openHistory(false); } else closeHistory(true);
  });

  function mergeHistory() {
    const last = histLog.length ? histLog[histLog.length - 1].n : 0;
    S.log.forEach((l) => { if (l.n > last) histLog.push(l); });
    renderHistory();
  }

  const hTime = (at) => (at ? new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');

  function historyStats(log) {
    const st = S.players.map(() => ({ atk: 0, conq: 0, kills: 0, lost: 0, moved: 0 }));
    log.forEach((l) => {
      const m = l.m || {};
      const s = st[l.p];
      if (!s) return;
      if (l.k === 'attack') {
        s.atk++;
        s.kills += m.lossD || 0;
        s.lost += m.lossA || 0;
        if (st[m.def]) { st[m.def].lost += m.lossD || 0; st[m.def].kills += m.lossA || 0; }
      } else if (l.k === 'conquer') s.conq++;
      else if (l.k === 'move') s.moved += m.n || 0;
      else if (l.k === 'fire') { s.kills += m.n || 0; if (st[m.def]) st[m.def].lost += m.n || 0; }
    });
    return st;
  }

  // agrupa as jogadas por turno (cada "Vez de ..." abre um grupo)
  function historyGroups(log) {
    const groups = [];
    let g = null;
    log.forEach((l) => {
      if (!g || l.k === 'turn') {
        g = { r: l.r || 0, p: l.k === 'turn' ? l.p : null, items: [] };
        groups.push(g);
      }
      g.items.push(l);
    });
    return groups;
  }

  function matchesHistory(l) {
    if (l.k === 'phase') return false;
    if (histKind !== 'all' && kindOf(l)[1] !== histKind) return false;
    if (histPlayer !== 'all') {
      const pi = Number(histPlayer);
      if (l.p !== pi && !(l.m && l.m.def === pi)) return false;
    }
    return !histQuery || l.t.toLowerCase().includes(histQuery);
  }

  function renderHistory() {
    if (!histOpen || !S) return;
    const log = histLog;
    const st = historyStats(log);
    $('#historyCount').textContent = `${log.filter((l) => l.k !== 'phase').length} jogadas`;
    $('#historyStats').innerHTML = S.players.map((p, i) => `
      <div class="hstat ${p.alive ? '' : 'dead'}" style="--pc:${color(p.color).hex}">
        <div class="hs-name">${dot(p.color)} ${esc(p.name)}${i === me() ? ' <small>(você)</small>' : ''}</div>
        <div class="hs-grid">
          <span title="Comunidades agora">🗺 <b>${p.territories}</b></span>
          <span title="Ataques feitos">⚔️ <b>${st[i].atk}</b></span>
          <span title="Comunidades conquistadas">🚩 <b>${st[i].conq}</b></span>
          <span title="Soldados rivais derrubados">💀 <b>${st[i].kills}</b></span>
          <span title="Soldados perdidos">🩸 <b>${st[i].lost}</b></span>
          <span title="Soldados remanejados">🔁 <b>${st[i].moved}</b></span>
        </div>
      </div>`).join('');

    $('#historyKinds').innerHTML = KIND_FILTERS.map(([k, label]) => `<button class="chip ${histKind === k ? 'active' : ''}" data-hkind="${k}">${label}</button>`).join('');
    const sel = $('#historyPlayer');
    const opts = `<option value="all">Todos os jogadores</option>${S.players.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('')}`;
    if (sel.dataset.sig !== opts) { sel.innerHTML = opts; sel.dataset.sig = opts; }
    sel.value = histPlayer;

    const filtering = histKind !== 'all' || histPlayer !== 'all' || histQuery;
    const groups = historyGroups(log).reverse(); // turno mais recente primeiro
    const html = groups.map((g) => {
      const items = g.items.filter((l) => matchesHistory(l) || (!filtering && l.k === 'phase'));
      if (!items.length) return '';
      const count = (k) => g.items.filter((l) => l.k === k).length;
      const placed = g.items.filter((l) => l.k === 'reinforce').reduce((s, l) => s + (l.m.n || 0), 0);
      const sum = [
        placed ? `➕ ${placed}` : '', count('attack') ? `⚔️ ${count('attack')}` : '', count('conquer') ? `🚩 ${count('conquer')}` : '',
        count('move') ? `🔁 ${count('move')}` : '',
      ].filter(Boolean).map((s) => `<span>${s}</span>`).join('');
      const head = g.p === null
        ? `<span class="hg-title">${g.r ? 'Início da guerra' : 'Preparação'}</span>`
        : `<span class="hg-title">${dot(S.players[g.p].color)} ${esc(S.players[g.p].name)}</span><span class="muted">Rodada ${g.r}</span>`;
      const rows = items.map((l) => {
        if (l.k === 'phase') return `<div class="hphase"><span>${esc(PHASE_NAMES[l.m.phase] || '')}</span></div>`;
        const [icon, cat] = kindOf(l);
        return `<div class="hitem k-${cat}" style="--pc:${pHex(l.p)}">
          <span class="htime">${hTime(l.at)}</span><span class="hic">${icon}</span><span class="htx">${esc(l.t)}</span>
          ${canReplay(l) ? `<button class="mini" data-hreplay="${l.n}">▶ ver no mapa</button>` : ''}</div>`;
      }).join('');
      return `<section class="hgroup" style="--pc:${g.p === null ? 'var(--line)' : pHex(g.p)}"><header>${head}<span class="hg-sum">${sum}</span></header>${rows}</section>`;
    }).join('');
    $('#historyList').innerHTML = html || '<p class="muted hempty">Nenhuma jogada encontrada com esses filtros.</p>';
  }

  $('#historyBack').onclick = () => closeHistory();
  $('#historyKinds').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hkind]');
    if (!b) return;
    histKind = b.dataset.hkind;
    renderHistory();
  });
  $('#historyPlayer').onchange = (e) => { histPlayer = e.target.value; renderHistory(); };
  $('#historySearch').addEventListener('input', (e) => { histQuery = e.target.value.trim().toLowerCase(); renderHistory(); });
  $('#historyList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hreplay]');
    if (!b) return;
    const l = histLog.find((x) => x.n === Number(b.dataset.hreplay));
    if (!l) return;
    closeHistory();
    $('.map-wrap').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' });
    setTimeout(() => replay(l), 250);
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
    ['turno', '🔄 Seu turno'],
    ['dados', '🎲 Dados'],
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
    if (tab === 'visao') {
      return `<p>A cidade tem <b>${MAP.territories.length} comunidades</b> divididas em <b>${regions.length} regiões</b>. Cada jogador comanda uma <b>facção</b>; cada comunidade que a facção controla tem seus <b>soldados</b>. Vence quem cumprir o <b>objetivo secreto</b> primeiro, durante o seu turno, ou a última facção em pé.</p>
        <h3>Duração da partida</h3>
        <p>O anfitrião escolhe na sala: ${MAP.roundOptions.map((o) => `<b>${esc(o.name)}</b> (${esc(o.desc)})`).join(', ')}. Com limite, se ninguém cumprir o objetivo até o fim da última rodada, vence quem tiver mais <b>pontos 🏅</b>: 1 por comunidade + o bônus de cada região inteira dominada (desempate: mais soldados). Todos jogam o mesmo número de turnos.</p>
        <h3>Regiões e bônus de reforço</h3>
        <p>Dominar uma região inteira rende soldados extras a cada turno:</p>
        <div class="chips">${regions.map((r) => `<span class="rchip" style="border-color:${r.color}"><i style="background:${r.color}"></i>${esc(r.name)} <b>+${r.bonus}</b></span>`).join('')}</div>
        <h3>Como começa</h3>
        <ul>
          <li>As comunidades são sorteadas entre os jogadores, com 1 soldado em cada.</li>
          <li>Todos distribuem os soldados iniciais <b>ao mesmo tempo</b>; quem termina fica pronto na hora (ou use “⚡ Distribuir automaticamente”).</li>
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
          <li><b>Reforço.</b> Receba soldados = comunidades ÷ 2 (mínimo 3) + bônus das regiões inteiras que você domina + <b>escalada</b> (+1 a cada ${MAP.escalationEvery} rodadas: +1 na ${MAP.escalationEvery}ª, +2 na ${MAP.escalationEvery * 2}ª…). Distribua onde quiser entre as suas comunidades. Aqui você também troca cartas. Ao distribuir tudo, o jogo já passa para o ataque, a menos que você tenha uma troca de cartas possível.</li>
          <li><b>Ataque.</b> De uma comunidade com 2+ soldados contra uma vizinha rival, quantas vezes quiser. O atacante rola até <b>3 dados</b> (sempre deixa 1 soldado para trás); o defensor rola até <b>3 dados</b> (um por soldado). Ao dominar, mova pelo menos tantos soldados quanto dados rolou.</li>
          <li><b>Remanejamento.</b> Mova soldados entre comunidades vizinhas suas, deixando 1 em cada origem. São no máximo <b>${MAP.fortifyPerTurn} remanejamentos por turno</b>: cada movimento conta 1, não importa quantos soldados leve. Soldados que acabaram de chegar não se movem de novo no turno. A carta Mobilização não entra nesse limite. Usados os ${MAP.fortifyPerTurn}, o turno passa sozinho.</li>
          <li><b>Fim do turno.</b> Se dominou ao menos uma comunidade, você recebe uma carta.</li>
        </ol>
        <h3>Tempo de jogo</h3>
        <p>Cada fase tem um relógio na tela: <b>preparação ${MAP.phaseSeconds.setup} s</b>, <b>reforço ${MAP.phaseSeconds.reinforce} s</b>, <b>ataque ${MAP.phaseSeconds.attack} s</b> e <b>remanejamento ${MAP.phaseSeconds.fortify} s</b>. Se o tempo acabar, o jogo <b>joga por você</b>: distribui seus reforços nas comunidades de fronteira, resolve uma ocupação pendente e encerra o turno, sem atacar. Quem estoura o tempo fica marcado como <b>ausente</b>: nos turnos seguintes a jogada automática vem logo (após uns 6 segundos) até você clicar em “Voltei” ou jogar por conta própria. Jogadores desconectados também são jogados automaticamente.</p>
        <h3>Atalhos para jogar rápido</h3>
        <ul>
          <li><b>⚡ Distribuir automaticamente</b> espalha os soldados que faltam nas suas fronteiras mais fracas.</li>
          <li><b>Atacar até o fim</b> resolve um ataque inteiro num clique.</li>
          <li>Ao dominar, “Mover tudo” ou “Mover o mínimo” já ocupam; se só há uma quantidade possível, a ocupação é automática.</li>
        </ul>
        <h3>Dados</h3>
        <p>Cada ataque é decidido nos dados: maior contra maior, segundo contra segundo; quem tirar menos perde 1 soldado e <b>empate é da defesa</b>.</p>
        <button class="mini" data-rtab="dados">🎲 Ver as regras dos dados com exemplos</button>`;
    }
    if (tab === 'dados') {
      const ex = (title, att, def, text) => `<div class="example"><b>${title}</b>${duelHtml({ att, def })}<p class="muted">${text}</p></div>`;
      const rows = [1, 2, 3, 4, 5].map((n) => `<tr><td>${n === 5 ? '4 ou mais' : n} soldado${n > 1 ? 's' : ''}</td><td>${n === 1 ? 'não pode atacar' : `até ${Math.min(3, n - 1)}`}</td><td>${Math.min(3, n)}</td></tr>`).join('');
      return `<h3>1. Quantos dados cada lado rola</h3>
        <ul>
          <li><b>Atacante:</b> escolhe de 1 a 3 dados, mas no máximo <b>soldados da comunidade − 1</b> (um soldado sempre fica para trás).</li>
          <li><b>Defensor:</b> não escolhe nada. Rola automaticamente <b>1 dado por soldado</b> na comunidade atacada, até 3.</li>
        </ul>
        <div class="table-wrap"><table class="rtable dice-table"><tr><th>Soldados na comunidade</th><th>Dados ao atacar</th><th>Dados ao defender</th></tr>${rows}</table></div>
        <h3>2. Como comparar</h3>
        <ol class="steps">
          <li>Cada lado ordena os próprios dados do <b>maior para o menor</b>.</li>
          <li>Forme pares: o maior do ataque contra o maior da defesa, o 2º contra o 2º, o 3º contra o 3º.</li>
          <li>Em cada par, <b>quem tirou o número menor perde 1 soldado</b>.</li>
          <li><b>Empate: a defesa vence</b> (o atacante perde o soldado).</li>
          <li>Dados sem par (quando um lado rolou mais dados) <b>não contam</b>.</li>
        </ol>
        <p>Por isso, em cada rolagem saem do jogo tantos soldados quanto o <b>menor</b> número de dados entre os dois lados.</p>
        <h3>3. Exemplos</h3>
        ${ex('3 dados contra 2', [6, 4, 2], [5, 4], '6 × 5: o ataque vence e a defesa perde 1. 4 × 4: empate, a defesa vence e o ataque perde 1. O 2 do ataque ficou sem par e não conta. Resultado: cada lado perde 1.')}
        ${ex('2 dados contra 3', [5, 3], [6, 2, 1], '5 × 6: a defesa vence. 3 × 2: o ataque vence. O 1 da defesa não tem par. Cada lado perde 1.')}
        ${ex('Empates', [4, 4, 1], [4, 3, 1], '4 × 4 e 1 × 1 são empates: a defesa vence os dois. 4 × 3: o ataque vence. O ataque perde 2, a defesa perde 1.')}
        <h3>4. Depois da rolagem</h3>
        <ul>
          <li>Você pode rolar de novo quantas vezes quiser, enquanto tiver 2 ou mais soldados na origem.</li>
          <li><b>Atacar até o fim</b> rola sempre com o máximo de dados, até dominar a comunidade ou sobrar 1 soldado na origem.</li>
          <li>Quando a defesa fica sem soldados, a comunidade é sua: mova para lá <b>pelo menos tantos soldados quantos dados você rolou</b> na última rolagem.</li>
        </ul>
        <h3>5. Modificadores do modo expandido</h3>
        <p>Algumas armas, tecnologias e cartas mudam a regra. No painel de combate, um dado com bônus aparece com <b>+1</b>, e o painel de ataque lista os modificadores que valem antes de você rolar.</p>
        <div class="table-wrap"><table class="rtable">
          <tr><th>Efeito</th><th>De onde vem</th></tr>
          <tr><td>Maior dado do ataque +1</td><td>${X.weapons.canhao.icon} ${esc(X.weapons.canhao.name)} na comunidade que ataca</td></tr>
          <tr><td>Maior dado da defesa +1</td><td>${X.weapons.bunker.icon} ${esc(X.weapons.bunker.name)} na comunidade atacada</td></tr>
          <tr><td>Menor dado da defesa +1 (com 3 dados)</td><td>🧪 ${esc(X.techs.trincheiras.name)}</td></tr>
          <tr><td>Empate no maior par fica com o ataque</td><td>🔥 ${esc(X.actionCards.ofensiva.name)} ou ${X.weapons.tanques.icon} ${esc(X.weapons.tanques.name)} (atacando com 3 dados)</td></tr>
          <tr><td>Empates no 2º e 3º pares ficam com o ataque</td><td>🧪 ${esc(X.techs.assalto.name)}</td></tr>
          <tr><td>Todo empate fica com o ataque</td><td>🧪 ${esc(X.techs.guerra_total.name)}</td></tr>
          <tr><td>A defesa perde no máximo 1 soldado por rolagem</td><td>🧪 ${esc(X.techs.muralha.name)}</td></tr>
        </table></div>
        <p class="muted">Um dado nunca passa de 6.</p>`;
    }
    if (tab === 'cartas') {
      const hand = (syms) => syms.map((x) => symHtml(x)).join('');
      const ok = (syms, why) => `<div class="set-ex ok"><span class="set-cards">${hand(syms)}</span><span>✔ ${why}</span></div>`;
      const bad = (syms, why) => `<div class="set-ex bad"><span class="set-cards">${hand(syms)}</span><span>✖ ${why}</span></div>`;
      const vals = Array.from({ length: 9 }, (_, n) => `<td>${tradeValueAt(n)}</td>`).join('');
      return `<h3>1. Como você ganha cartas</h3>
        <p>Existem ${MAP.territories.length} cartas, uma para cada comunidade, cada uma com um símbolo (${hand(['triangulo', 'quadrado', 'circulo'])}), e mais 2 coringas (${symHtml('coringa')}). No fim de cada turno em que você <b>dominou ao menos uma comunidade</b>, recebe <b>1 carta</b> (só uma, mesmo dominando várias).</p>
        <h3>2. Quais combinações valem</h3>
        <p>Uma troca usa sempre <b>3 cartas</b>. Valem só dois tipos:</p>
        <div class="set-grid">
          ${ok(['triangulo', 'triangulo', 'triangulo'], '3 do mesmo símbolo')}
          ${ok(['triangulo', 'quadrado', 'circulo'], '3 símbolos diferentes')}
          ${ok(['quadrado', 'coringa', 'quadrado'], 'o coringa vira ■ (3 iguais)')}
          ${ok(['triangulo', 'circulo', 'coringa'], 'o coringa vira ■ (3 diferentes)')}
          ${bad(['triangulo', 'triangulo', 'circulo'], '2 iguais e 1 diferente não vale')}
          ${bad(['quadrado', 'circulo'], 'só 2 cartas: falta 1')}
        </div>
        <p class="muted">No painel de cartas, o jogo mostra quantas cartas faltam para você ter uma troca, qual regra as 3 cartas escolhidas seguem e quanto você vai receber. O botão “Sugerir troca” escolhe a melhor combinação para você.</p>
        <h3>3. Quando trocar</h3>
        <ul>
          <li>Só no <b>seu turno</b>, na fase de <b>Reforço</b>. Os soldados recebidos são distribuídos na hora, junto com os reforços.</li>
          <li><b>Com 5 ou mais cartas a troca é obrigatória:</b> você não avança de fase sem trocar. Se isso acontecer no meio do ataque (ao eliminar alguém e herdar as cartas dele), troque ali mesmo.</li>
        </ul>
        <h3>4. Quanto vale cada troca</h3>
        <p>O valor depende de <b>quantas trocas já foram feitas na partida, por qualquer jogador</b>. Cada troca faz o valor subir para todos.</p>
        <div class="table-wrap"><table class="rtable dice-table"><tr><th>Troca da partida</th>${Array.from({ length: 9 }, (_, n) => `<th>${n + 1}ª</th>`).join('')}</tr><tr><td>Soldados</td>${vals}</tr></table></div>
        <p class="muted">Depois da ${MAP.tradeSeq.length}ª troca, cada uma vale 5 a mais que a anterior.</p>
        <h3>5. Bônus extras</h3>
        <ul>
          <li><b>Carta de comunidade sua:</b> cada carta da troca cuja comunidade é sua dá <b>+2 soldados direto nela</b> (a carta mostra um selo +2).</li>
          <li><b>${esc(X.techs.propaganda.name)}</b> (modo expandido): +2 soldados em toda troca.</li>
          <li><b>Eliminação:</b> ao eliminar uma facção, você fica com as cartas dela.</li>
        </ul>`;
    }
    if (tab === 'objetivos') {
      return `<p>Cada jogador recebe <b>um objetivo em segredo</b>. São ${MAP.objectives.length} cartas possíveis:</p>
        <div class="obj-list">${MAP.objectives.map((o) => `<div class="obj">${esc(objectiveText(o))}</div>`).join('')}</div>
        <p class="muted">Se a facção que você devia destruir não está na partida, é a sua própria ou é eliminada por outro jogador, o seu objetivo vira “dominar 24 comunidades”. O vencedor é quem cumprir o objetivo durante o seu turno. Com limite de rodadas, se ninguém cumprir até o fim, vence quem tiver mais pontos 🏅.</p>`;
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
    const byLimit = S.endReason === 'limit';
    const how = byLimit
      ? `${dot(w.color)} Fim das ${S.maxRounds} rodadas: <b>${w.score} pontos</b> (comunidades + bônus das regiões)`
      : `${dot(w.color)} Objetivo: ${esc(w.objective || '')}`;
    const list = byLimit ? S.players.slice().sort((a, b) => b.score - a.score || b.armies - a.armies) : S.players;
    const tie = byLimit && S.players.some((p) => p.idx !== S.winner && p.alive && p.score === w.score);
    return `<div class="trophy">🏆</div><h2 style="text-align:center">${esc(w.name)} venceu!</h2>
      <p style="text-align:center">${how}${tie ? '<br><small class="muted">Empate em pontos: desempatou quem tinha mais soldados.</small>' : ''}</p>
      <div class="win-list">${list.map((p) => `<div class="${p.idx === S.winner ? 'winner' : ''}">${dot(p.color)} <b>${esc(p.name)}</b> — ${byLimit ? `🏅 ${p.score} pontos · ⚔ ${p.armies} soldados · ` : ''}${p.territories} comunidades<br><span class="muted">${esc(p.objective || '')}</span></div>`).join('')}</div>
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
        <p class="muted">Mínimo ${pm.min}: o número de dados que você rolou na última rolagem. Máximo ${pm.max}: 1 soldado sempre fica na origem.</p>
        <div style="text-align:center;font-size:2.2rem;font-weight:900" id="occN">${occupyN}</div>
        <input type="range" id="occRange" min="${pm.min}" max="${pm.max}" value="${occupyN}">
        <div class="btn-row" style="margin-top:10px"><button id="occMin">Mover ${pm.min} (mínimo)</button><button id="occMax">Mover ${pm.max} (tudo)</button></div>
        <button class="primary" id="occOk" style="width:100%;margin-top:12px">Ocupar com o valor escolhido</button>`);
      const range = $('#occRange');
      const setN = (v) => { occupyN = Number(v); range.value = v; $('#occN').textContent = v; };
      range.oninput = () => setN(range.value);
      // atalhos de um clique: já ocupam
      $('#occMin').onclick = () => send({ type: 'occupy', n: pm.min });
      $('#occMax').onclick = () => send({ type: 'occupy', n: pm.max });
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
    else if (histOpen) closeHistory();
    else if (treeOpen && S) { treeOpen = false; renderModal(); }
    else if (S && S.phase === 'fortify' && sel.a && !mode) { sel = { a: null, b: null }; renderGame(); }
  });

  buildMap();
})();
