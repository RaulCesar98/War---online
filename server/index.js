'use strict';

const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const data = require('./data');
const { Game } = require('./game');

const PORT = process.env.PORT || 3000;
const { MAX_PLAYERS } = data;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // salas inativas por 6h são removidas
// Tempo máximo de cada fase: data.PHASE_SECONDS (preparação 40 s, reforço 30 s, ataque 45 s,
// remanejamento 20 s), nunca acima de 60 s. TURN_SECONDS só pode diminuir o limite (útil em testes).
const TURN_SECONDS = Math.min(60, Math.max(1, Number(process.env.TURN_SECONDS) || 60));
const phaseMs = (phase) => Math.min(TURN_SECONDS, data.PHASE_SECONDS[phase] || TURN_SECONDS) * 1000;
const ROUNDS_ALLOWED = data.ROUND_OPTIONS.map((o) => o.rounds);
// Quem está desconectado joga automaticamente após AFK_DELAY_MS; quem já estourou o tempo (ausente) mas
// continua conectado tem AFK_GRACE_MS de tolerância no turno seguinte (qualquer jogada tira a ausência).
const AFK_DELAY_MS = Math.max(300, Number(process.env.AFK_DELAY_MS) || 3000);
const AFK_GRACE_MS = Math.max(300, Number(process.env.AFK_GRACE_MS) || 6000);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));
// endereços IPv4 do servidor (mostrados na barra de status do jogo)
app.get('/api/server', (_req, res) => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  res.json({ ips, port: Number(PORT), hostname: os.hostname() });
});
app.get('/api/map', (_req, res) => {
  res.json({
    territories: data.TERRITORIES,
    edges: data.EDGES,
    continents: data.CONTINENTS,
    colors: data.COLORS,
    tradeSeq: data.TRADE_SEQ,
    maxPlayers: MAX_PLAYERS,
    fortifyPerTurn: data.FORTIFY_PER_TURN,
    turnSeconds: TURN_SECONDS,
    phaseSeconds: Object.fromEntries(Object.keys(data.PHASE_SECONDS).map((k) => [k, phaseMs(k) / 1000])),
    roundOptions: data.ROUND_OPTIONS,
    escalationEvery: data.ESCALATION_EVERY,
    startArmies: data.TOTAL_ARMIES,
    objectives: data.OBJECTIVES,
    expanded: {
      branches: data.BRANCHES,
      techs: data.TECHS,
      weaponLines: data.WEAPON_LINES,
      weapons: data.WEAPONS,
      actionCards: data.ACTION_CARDS,
      handMax: data.ACTION_HAND_MAX,
      buildsPerTurn: data.BUILDS_PER_TURN,
    },
  });
});

// ---------- salas ----------

const rooms = new Map();
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => LETTERS[crypto.randomInt(LETTERS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 16);

function publicRoom(room) {
  return {
    code: room.code,
    started: !!room.game,
    expanded: room.expanded,
    rounds: room.rounds,
    players: room.players.map((p, i) => ({
      idx: i,
      name: p.name,
      connected: p.connected,
      isHost: p.token === room.hostToken,
      color: data.COLORS[i % data.COLORS.length],
    })),
    chat: room.chat.slice(-50),
  };
}

// Arma (ou mantém) o relógio da fase atual. O prazo só é reiniciado quando a fase ou o turno muda.
function armTimer(room) {
  const g = room.game;
  if (!g || g.phase === 'over') {
    clearTimeout(room.timer);
    room.timer = null;
    room.timerKey = '';
    room.deadline = 0;
    return;
  }
  const key = g.phase === 'setup' ? 'setup' : `${g.phase}|${g.turn}|${g.round}`;
  if (key === room.timerKey) return;
  clearTimeout(room.timer);
  room.timerKey = key;
  let ms = phaseMs(g.phase);
  if (g.phase !== 'setup') {
    const rp = room.players[g.turn];
    if (!(rp && rp.connected)) ms = Math.min(ms, AFK_DELAY_MS);
    else if (g.players[g.turn].afk) ms = Math.min(ms, AFK_GRACE_MS);
  }
  room.timerMs = ms;
  room.deadline = Date.now() + ms;
  room.timer = setTimeout(() => onTimeout(room, key), ms);
}

// Tempo esgotado: o servidor joga por quem não agiu (distribui reforços e encerra o turno, sem atacar).
function onTimeout(room, key) {
  const g = room.game;
  if (!g || room.timerKey !== key || g.phase === 'over') return;
  try {
    if (g.phase === 'setup') {
      g.players.forEach((p, i) => {
        if (p.alive && !p.ready) { g.autoPlay(i); p.afk = true; }
      });
    } else {
      const i = g.turn;
      const res = g.autoPlay(i);
      if (!res.ok) console.error('autoPlay falhou:', res.error);
      g.players[i].afk = true;
    }
  } catch (err) {
    console.error('Erro na jogada automática', err);
  }
  room.timerKey = ''; // força recalcular o prazo da próxima fase
  broadcast(room);
}

function broadcast(room) {
  room.touched = Date.now();
  armTimer(room);
  const info = publicRoom(room);
  room.players.forEach((p, i) => {
    if (!p.socketId) return;
    const sock = io.sockets.sockets.get(p.socketId);
    if (!sock) return;
    sock.emit('room', { ...info, me: { idx: i, isHost: p.token === room.hostToken } });
    if (room.game) {
      sock.emit('state', { ...room.game.view(i), timer: { deadline: room.deadline, now: Date.now(), total: room.timerMs || phaseMs(room.game.phase) } });
    }
  });
}

function findRoom(socket) {
  const room = rooms.get(socket.data.code);
  if (!room) return {};
  const idx = room.players.findIndex((p) => p.token === socket.data.token);
  return { room, idx, player: room.players[idx] };
}

function attach(socket, room, player) {
  player.socketId = socket.id;
  player.connected = true;
  socket.data.code = room.code;
  socket.data.token = player.token;
  socket.join(room.code);
}

function ensureHost(room) {
  const host = room.players.find((p) => p.token === room.hostToken);
  if (host && host.connected) return;
  const next = room.players.find((p) => p.connected);
  if (next) room.hostToken = next.token;
}

io.on('connection', (socket) => {
  socket.on('createRoom', (payload, cb) => {
    if (typeof cb !== 'function') return;
    const name = cleanName(payload && payload.name);
    if (!name) return cb({ ok: false, error: 'Digite seu nome.' });
    const room = {
      code: makeCode(), hostToken: null, players: [], game: null, chat: [], touched: Date.now(), expanded: true,
      rounds: data.DEFAULT_ROUNDS,
      timer: null, timerKey: '', deadline: 0,
    };
    const player = { token: crypto.randomUUID(), name, socketId: null, connected: false };
    room.players.push(player);
    room.hostToken = player.token;
    rooms.set(room.code, room);
    attach(socket, room, player);
    cb({ ok: true, code: room.code, token: player.token });
    broadcast(room);
  });

  socket.on('joinRoom', (payload, cb) => {
    if (typeof cb !== 'function') return;
    const name = cleanName(payload && payload.name);
    const code = String((payload && payload.code) || '').trim().toUpperCase();
    if (!name) return cb({ ok: false, error: 'Digite seu nome.' });
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Sala não encontrada.' });
    if (room.game) return cb({ ok: false, error: 'A partida dessa sala já começou.' });
    if (room.players.length >= MAX_PLAYERS) return cb({ ok: false, error: `Sala cheia (máximo de ${MAX_PLAYERS} jogadores).` });
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return cb({ ok: false, error: 'Já existe um jogador com esse nome na sala.' });
    }
    const player = { token: crypto.randomUUID(), name, socketId: null, connected: false };
    room.players.push(player);
    attach(socket, room, player);
    cb({ ok: true, code: room.code, token: player.token });
    broadcast(room);
  });

  socket.on('rejoin', (payload, cb) => {
    if (typeof cb !== 'function') return;
    const room = rooms.get(String((payload && payload.code) || '').toUpperCase());
    const player = room && room.players.find((p) => p.token === (payload && payload.token));
    if (!player) return cb({ ok: false, error: 'Sessão expirada.' });
    attach(socket, room, player);
    ensureHost(room);
    cb({ ok: true, code: room.code, token: player.token });
    broadcast(room);
  });

  socket.on('leaveRoom', () => {
    const { room, idx, player } = findRoom(socket);
    if (!room || !player) return;
    socket.leave(room.code);
    socket.data.code = null;
    socket.data.token = null;
    player.socketId = null;
    player.connected = false;
    if (!room.game) {
      room.players.splice(idx, 1);
      if (!room.players.length) { clearTimeout(room.timer); rooms.delete(room.code); }
    }
    if (rooms.has(room.code)) { ensureHost(room); broadcast(room); }
  });

  socket.on('setOptions', (payload, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const { room, player } = findRoom(socket);
    if (!room) return reply({ ok: false, error: 'Sala não encontrada.' });
    if (player.token !== room.hostToken) return reply({ ok: false, error: 'Só o anfitrião pode mudar as regras.' });
    if (room.game) return reply({ ok: false, error: 'A partida já começou.' });
    if (payload && typeof payload.expanded === 'boolean') room.expanded = payload.expanded;
    if (payload && ROUNDS_ALLOWED.includes(payload.rounds)) room.rounds = payload.rounds;
    reply({ ok: true });
    broadcast(room);
  });

  socket.on('startGame', (_p, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const { room, player } = findRoom(socket);
    if (!room) return reply({ ok: false, error: 'Sala não encontrada.' });
    if (player.token !== room.hostToken) return reply({ ok: false, error: 'Só o anfitrião pode iniciar.' });
    if (room.game) return reply({ ok: false, error: 'A partida já começou.' });
    room.players = room.players.filter((p) => p.connected);
    if (room.players.length < 2) return reply({ ok: false, error: 'São necessários ao menos 2 jogadores conectados.' });
    room.game = new Game(room.players.map((p) => p.name), Math.random, { expanded: room.expanded, maxRounds: room.rounds });
    reply({ ok: true });
    broadcast(room);
  });

  socket.on('action', (a, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const { room, idx } = findRoom(socket);
    if (!room || !room.game) return reply({ ok: false, error: 'Partida não iniciada.' });
    let res;
    try {
      res = room.game.act(idx, a);
    } catch (err) {
      console.error('Erro na ação', err);
      res = { ok: false, error: 'Erro interno ao processar a jogada.' };
    }
    reply(res);
    if (res.ok) broadcast(room);
  });

  // Histórico completo da partida (página "Histórico")
  socket.on('history', (_p, cb) => {
    if (typeof cb !== 'function') return;
    const { room } = findRoom(socket);
    if (!room || !room.game) return cb({ ok: false, error: 'Partida não iniciada.' });
    cb({ ok: true, log: room.game.log });
  });

  // O anfitrião joga automaticamente por um jogador desconectado
  socket.on('autoPlay', (payload, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const { room, player } = findRoom(socket);
    if (!room || !room.game) return reply({ ok: false, error: 'Partida não iniciada.' });
    if (player.token !== room.hostToken) return reply({ ok: false, error: 'Só o anfitrião pode fazer isso.' });
    const target = room.players[payload && payload.idx];
    if (!target || target.connected) return reply({ ok: false, error: 'O jogador está conectado.' });
    const res = room.game.autoPlay(payload.idx);
    reply(res);
    if (res.ok) broadcast(room);
  });

  socket.on('backToLobby', (_p, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const { room, player } = findRoom(socket);
    if (!room || !room.game) return reply({ ok: false });
    if (player.token !== room.hostToken) return reply({ ok: false, error: 'Só o anfitrião pode fazer isso.' });
    if (room.game.phase !== 'over') return reply({ ok: false, error: 'A partida ainda está em andamento.' });
    room.game = null;
    reply({ ok: true });
    broadcast(room);
  });

  // medição de latência: o cliente envia e mede o tempo até a resposta
  socket.on('latency', (_p, cb) => { if (typeof cb === 'function') cb(Date.now()); });

  socket.on('chat', (text) => {
    const { room, player } = findRoom(socket);
    if (!room) return;
    const msg = String(text || '').trim().slice(0, 200);
    if (!msg) return;
    room.chat.push({ name: player.name, text: msg, at: Date.now() });
    if (room.chat.length > 100) room.chat.shift();
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const { room, player } = findRoom(socket);
    if (!room || !player || player.socketId !== socket.id) return;
    player.connected = false;
    player.socketId = null;
    ensureHost(room);
    broadcast(room);
  });
});

setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    const anyone = room.players.some((p) => p.connected);
    if (!anyone && now - room.touched > ROOM_TTL_MS) { clearTimeout(room.timer); rooms.delete(code); }
  });
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`WAR rodando em http://localhost:${PORT}`));
