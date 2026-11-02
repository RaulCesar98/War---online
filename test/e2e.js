'use strict';

// Teste ponta a ponta contra um servidor em execução: node test/e2e.js [url]
const assert = require('assert');
const { io } = require('socket.io-client');

const URL = process.argv[2] || 'http://localhost:3000';

function client(name) {
  const socket = io(URL, { transports: ['websocket'], forceNew: true });
  const c = { socket, name, state: null, room: null, token: null };
  socket.on('state', (s) => { c.state = s; });
  socket.on('room', (r) => { c.room = r; });
  c.emit = (ev, data) => new Promise((res) => socket.emit(ev, data, res));
  c.act = (a) => c.emit('action', a);
  c.connected = new Promise((res) => socket.on('connect', res));
  return c;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const must = (r, ctx) => assert(r && r.ok, `${ctx}: ${r && r.error}`);

(async () => {
  const [a, b, c] = ['Ana', 'Bruno', 'Carla'].map(client);
  await Promise.all([a.connected, b.connected, c.connected]);

  const created = await a.emit('createRoom', { name: 'Ana' });
  must(created, 'createRoom');
  const code = created.code;
  assert(/^[A-Z]{4}$/.test(code));

  assert(!(await b.emit('joinRoom', { name: '', code })).ok, 'nome vazio deve falhar');
  assert(!(await b.emit('joinRoom', { name: 'Bruno', code: 'ZZZZ' })).ok, 'sala inexistente deve falhar');
  const joinedB = await b.emit('joinRoom', { name: 'Bruno', code: code.toLowerCase() });
  must(joinedB, 'join b');
  assert(!(await c.emit('joinRoom', { name: 'bruno', code })).ok, 'nome duplicado deve falhar');
  must(await c.emit('joinRoom', { name: 'Carla', code }), 'join c');
  await sleep(100);
  assert.strictEqual(a.room.players.length, 3);

  assert(!(await b.emit('startGame', {})).ok, 'só o anfitrião inicia');
  must(await a.emit('startGame', {}), 'start');
  await sleep(150);
  [a, b, c].forEach((x) => {
    assert(x.state, `${x.name} deve receber o estado`);
    assert.strictEqual(x.state.phase, 'setup');
  });

  // sigilo: cada cliente só vê o próprio objetivo
  assert(a.state.me.objective && a.state.players.every((p) => p.objective === undefined), 'objetivos alheios não podem vazar');

  // fase inicial: cada jogador distribui tudo no 1º território seu
  for (const x of [a, b, c]) {
    const mine = Object.entries(x.state.terr).filter(([, t]) => t.o === x.state.me.idx).map(([id]) => id);
    assert(!(await x.act({ type: 'ready' })).ok, 'não pode ficar pronto sem distribuir');
    must(await x.act({ type: 'place', territory: mine[0], n: x.state.me.pool }), 'place setup');
    assert(!(await x.act({ type: 'ready' })).ok, 'distribuir tudo já deixa pronto');
    await sleep(50);
  }
  await sleep(150);
  assert.strictEqual(a.state.phase, 'reinforce');
  const players = { [a.state.me.idx]: a, [b.state.me.idx]: b, [c.state.me.idx]: c };
  const cur = players[a.state.turn];
  const other = [a, b, c].find((x) => x !== cur);
  assert(!(await other.act({ type: 'endTurn' })).ok, 'jogador fora da vez não joga');

  // um turno completo pelo servidor
  const mine = Object.entries(cur.state.terr).filter(([, t]) => t.o === cur.state.me.idx).map(([id]) => id);
  must(await cur.act({ type: 'place', territory: mine[0], n: cur.state.me.pool }), 'place reinforce');
  await sleep(150);
  if (cur.state.phase === 'reinforce') must(await cur.act({ type: 'endReinforce' }), 'endReinforce');
  must(await cur.act({ type: 'endTurn' }), 'endTurn');
  await sleep(150);
  assert.notStrictEqual(a.state.turn, cur.state.me.idx, 'a vez deve passar');
  console.log('✔ sala, convite, início, setup e turno OK');

  // reconexão com token
  const oldIdx = b.state.me.idx;
  b.socket.disconnect();
  await sleep(200);
  assert(!a.room.players[oldIdx].connected, 'desconexão deve ser refletida');
  const b2 = client('Bruno2');
  await b2.connected;
  assert(!(await b2.emit('rejoin', { code, token: 'invalido' })).ok, 'token inválido deve falhar');
  must(await b2.emit('rejoin', { code, token: joinedB.token }), 'rejoin');
  await sleep(150);
  assert.strictEqual(b2.state.me.idx, oldIdx, 'deve voltar ao mesmo assento');
  assert(a.room.players[oldIdx].connected, 'reconexão deve ser refletida');
  console.log('✔ reconexão com token OK');

  // chat
  a.socket.emit('chat', 'olá!');
  await sleep(150);
  assert(a.room.chat.some((m) => m.text === 'olá!' && m.name === 'Ana'));
  console.log('✔ chat OK');

  [a, b, b2, c].forEach((x) => x.socket.close());

  // sala cheia: 10 jogadores entram, o 11º é recusado e a partida começa com todos
  const crowd = Array.from({ length: 10 }, (_, k) => client(`P${k + 1}`));
  await Promise.all(crowd.map((x) => x.connected));
  const made = await crowd[0].emit('createRoom', { name: 'P1' });
  must(made, 'createRoom 10');
  for (let k = 1; k < 10; k++) must(await crowd[k].emit('joinRoom', { name: `P${k + 1}`, code: made.code }), `join P${k + 1}`);
  const extra = client('P11');
  await extra.connected;
  const refused = await extra.emit('joinRoom', { name: 'P11', code: made.code });
  assert(!refused.ok && /10/.test(refused.error), 'o 11º jogador deve ser recusado');
  must(await crowd[0].emit('startGame', {}), 'start 10');
  await sleep(300);
  crowd.forEach((x) => assert(x.state && x.state.players.length === 10, `${x.name} deve ver 10 jogadores`));
  const objs = new Set(crowd.map((x) => x.state.me.objective));
  assert(objs.size >= 8, 'objetivos secretos variados');
  for (const x of crowd) {
    const mine = Object.entries(x.state.terr).filter(([, t]) => t.o === x.state.me.idx).map(([id]) => id);
    must(await x.act({ type: 'place', territory: mine[0], n: x.state.me.pool }), `place ${x.name}`);
    assert(!(await x.act({ type: 'ready' })).ok, `ready automático ${x.name}`);
  }
  await sleep(300);
  assert.strictEqual(crowd[0].state.phase, 'reinforce', 'a guerra começa quando os 10 estão prontos');
  console.log('✔ sala com 10 jogadores OK (11º recusado, partida inicia)');
  [...crowd, extra].forEach((x) => x.socket.close());
  console.log('Teste ponta a ponta concluído.');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
