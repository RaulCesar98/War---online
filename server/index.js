'use strict';

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

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));
app.get('/api/map', (_req, res) => {
  res.json({
    territories: data.TERRITORIES,
    edges: data.EDGES,
    continents: data.CONTINENTS,
    colors: data.COLORS,
    tradeSeq: data.TRADE_SEQ,
    maxPlayers: MAX_PLAYERS,
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

function broadcast(room) {
  room.touched = Date.now();
  const info = publicRoom(room);
  room.players.forEach((p, i) => {
    if (!p.socketId) return;
    const sock = io.sockets.sockets.get(p.socketId);
    if (!sock) return;
    sock.emit('room', { ...info, me: { idx: i, isHost: p.token === room.hostToken } });
    if (room.game) sock.emit('state', room.game.view(i));
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
      if (!room.players.length) rooms.delete(room.code);
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
    room.game = new Game(room.players.map((p) => p.name), Math.random, { expanded: room.expanded });
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
    if (!anyone && now - room.touched > ROOM_TTL_MS) rooms.delete(code);
  });
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`WAR rodando em http://localhost:${PORT}`));
