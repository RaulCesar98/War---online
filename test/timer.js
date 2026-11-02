'use strict';

// Testa o relógio de fase e a jogada automática. Sobe servidores próprios com tempos curtos:
//   node test/timer.js
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const must = (r, ctx) => assert(r && r.ok, `${ctx}: ${r && r.error}`);

function startServer(port, env) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('rodando')) resolve(child); });
    child.on('error', reject);
    setTimeout(() => reject(new Error('servidor não iniciou')), 8000);
  });
}

function client(url, name) {
  const socket = io(url, { transports: ['websocket'], forceNew: true });
  const c = { socket, name, state: null, room: null };
  socket.on('state', (s) => { c.state = s; });
  socket.on('room', (r) => { c.room = r; });
  c.emit = (ev, data) => new Promise((res) => socket.emit(ev, data, res));
  c.act = (a) => c.emit('action', a);
  c.connected = new Promise((res) => socket.on('connect', res));
  return c;
}

async function room(url, names) {
  const cs = names.map((n) => client(url, n));
  await Promise.all(cs.map((c) => c.connected));
  const made = await cs[0].emit('createRoom', { name: names[0] });
  must(made, 'createRoom');
  for (let i = 1; i < cs.length; i++) must(await cs[i].emit('joinRoom', { name: names[i], code: made.code }), 'join');
  must(await cs[0].emit('startGame', {}), 'start');
  await sleep(200);
  return { cs, code: made.code };
}

(async () => {
  // ---------- tempos curtos: 2 s por fase, 0,5 s para desconectados, 0,8 s para ausentes ----------
  const server = await startServer(3201, { TURN_SECONDS: '2', AFK_DELAY_MS: '500', AFK_GRACE_MS: '800' });
  const url = 'http://localhost:3201';
  try {
    const { cs } = await room(url, ['Ana', 'Bia', 'Caio']);
    const [a, b, c] = cs;

    // o estado traz o relógio
    assert(a.state.timer && a.state.timer.deadline > a.state.timer.now, 'estado deve trazer o prazo');
    assert(a.state.timer.total <= 60000 && a.state.timer.total === 2000, 'prazo total respeita TURN_SECONDS');
    assert.strictEqual(a.state.phase, 'setup');

    // Ana joga normalmente (e não pode ser marcada ausente); Bia e Caio ficam parados
    const mine = Object.entries(a.state.terr).filter(([, t]) => t.o === a.state.me.idx).map(([id]) => id);
    must(await a.act({ type: 'place', territory: mine[0], n: a.state.me.pool }), 'place');
    must(await a.act({ type: 'ready' }), 'ready');
    await sleep(2600);
    assert.notStrictEqual(a.state.phase, 'setup', 'a preparação deve terminar sozinha quando o tempo acaba');
    assert(a.state.players.every((p) => p.pool === 0 || p.idx === a.state.turn), 'todos os soldados iniciais foram distribuídos (só quem joga agora tem reforço)');
    assert(!a.state.players[a.state.me.idx].afk, 'quem jogou não fica ausente');
    assert(a.state.players[b.state.me.idx].afk && a.state.players[c.state.me.idx].afk, 'quem não jogou fica ausente');
    assert(a.state.log.some((l) => l.k === 'auto'), 'o registro informa a jogada automática');
    console.log('✔ preparação: o tempo esgota e o servidor distribui os soldados de quem não jogou');

    // turnos de quem está parado passam sozinhos, sem ataques
    const before = JSON.stringify(Object.values(a.state.terr).map((t) => t.o));
    const roundBefore = a.state.round;
    await sleep(5500);
    assert(a.state.round > roundBefore, 'os turnos devem continuar passando sozinhos');
    assert(a.state.log.filter((l) => l.k === 'auto').length >= 3, 'várias jogadas automáticas registradas');
    assert(!a.state.log.some((l) => /atacou/.test(l.t)), 'a jogada automática não ataca');
    console.log('✔ turno: quem demora é jogado automaticamente (sem atacar) e o jogo segue');
    void before;

    // "Voltei" tira a marca de ausente
    const bIdx = b.state.me.idx;
    assert(a.state.players[bIdx].afk, 'Bia está ausente');
    must(await b.act({ type: 'back' }), 'back');
    await sleep(200);
    assert(!a.state.players[bIdx].afk, '"Voltei" remove a ausência');
    console.log('✔ "Voltei" remove a marca de ausente');
    cs.forEach((x) => x.socket.close());
  } finally {
    server.kill();
  }

  // ---------- jogador desconectado é jogado automaticamente ----------
  const server2 = await startServer(3202, { TURN_SECONDS: '2', AFK_DELAY_MS: '400', AFK_GRACE_MS: '800' });
  try {
    const { cs } = await room('http://localhost:3202', ['Dani', 'Edu']);
    const [d, e] = cs;
    const eIdx = e.state.me.idx;
    e.socket.disconnect();
    const mine = Object.entries(d.state.terr).filter(([, t]) => t.o === d.state.me.idx).map(([id]) => id);
    must(await d.act({ type: 'place', territory: mine[0], n: d.state.me.pool }), 'place');
    must(await d.act({ type: 'ready' }), 'ready');
    await sleep(2600);
    assert.notStrictEqual(d.state.phase, 'setup', 'a partida começa mesmo com um jogador desconectado');
    const r0 = d.state.round;
    await sleep(4500);
    assert(d.state.round > r0 || d.state.turn !== d.state.me.idx, 'o jogo não trava com jogador desconectado');
    assert(d.state.log.some((l) => l.k === 'auto' && l.p === eIdx), 'o desconectado foi jogado automaticamente');
    console.log('✔ jogador desconectado é jogado automaticamente');
    d.socket.close();
  } finally {
    server2.kill();
  }

  // ---------- o limite nunca passa de 60 s ----------
  const server3 = await startServer(3203, { TURN_SECONDS: '999' });
  try {
    const map = await (await fetch('http://localhost:3203/api/map')).json();
    assert.strictEqual(map.turnSeconds, 60, 'o limite é de no máximo 60 segundos');
    console.log('✔ limite máximo de 60 s');
  } finally {
    server3.kill();
  }

  console.log('Testes do relógio concluídos.');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
