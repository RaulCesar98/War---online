'use strict';

const assert = require('assert');
const { TERRITORIES, EDGES, ADJ, CONTINENTS, OBJECTIVES, TECHS, WEAPONS, ACTION_CARDS, COLORS, MAX_PLAYERS, TOTAL_ARMIES } = require('../server/data');
const { Game, isValidSet, findSet, TERR_IDS, DIST } = require('../server/game');

// ---------- mapa ----------
assert.strictEqual(TERRITORIES.length, 42, 'devem existir 42 territórios');
assert.strictEqual(OBJECTIVES.length, 18, 'devem existir 18 objetivos');
const ids = new Set(TERR_IDS);
assert.strictEqual(ids.size, 42, 'ids únicos');
EDGES.forEach(([a, b]) => {
  assert(ids.has(a) && ids.has(b), `fronteira inválida ${a}-${b}`);
  assert(a !== b);
});
assert.strictEqual(new Set(EDGES.map(([a, b]) => [a, b].sort().join('|'))).size, EDGES.length, 'fronteiras duplicadas');
TERRITORIES.forEach((t) => {
  assert(CONTINENTS[t.continent], `continente inválido: ${t.id}`);
  assert(ADJ[t.id].length >= 2, `${t.id} tem poucos vizinhos`);
});
const seen = new Set([TERR_IDS[0]]);
const stack = [TERR_IDS[0]];
while (stack.length) ADJ[stack.pop()].forEach((n) => { if (!seen.has(n)) { seen.add(n); stack.push(n); } });
assert.strictEqual(seen.size, 42, 'o mapa deve ser conexo');
const perContinent = {};
TERRITORIES.forEach((t) => { perContinent[t.continent] = (perContinent[t.continent] || 0) + 1; });
assert.deepStrictEqual(perContinent, { AN: 9, AS: 4, EU: 7, AF: 6, AI: 12, OC: 4 });
console.log('✔ mapa OK (42 territórios, conexo)');

// ---------- jogadores: de 2 a 10 ----------
assert.strictEqual(MAX_PLAYERS, 10);
assert.strictEqual(COLORS.length, 10);
assert.strictEqual(new Set(COLORS.map((c) => c.hex)).size, 10, 'cores distintas');
assert.strictEqual(new Set(COLORS.map((c) => c.faction)).size, 10, 'facções distintas');
assert(OBJECTIVES.filter((o) => o.type === 'destroy').length === 10, 'um objetivo de destruir para cada facção');
for (let n = 2; n <= 10; n++) {
  const g = new Game(Array.from({ length: n }, (_, k) => `J${k}`), Math.random);
  assert.strictEqual(new Set(g.players.map((p) => p.objective.id)).size, n, 'objetivos diferentes');
  g.players.forEach((p, i) => {
    assert.strictEqual(p.pool + g._owned(i).length, TOTAL_ARMIES[n]);
    assert(p.pool >= 1, `com ${n} jogadores sobra algo a distribuir`);
  });
  assert.strictEqual(g.players.reduce((s, _, i) => s + g._owned(i).length, 0), 42, 'todas as comunidades têm dono');
}
assert.throws(() => new Game(Array.from({ length: 11 }, (_, k) => `J${k}`)), /2 a 10/);
assert.throws(() => new Game(['A']), /2 a 10/);
console.log('✔ de 2 a 10 jogadores OK');

// ---------- cartas ----------
const C = (symbol) => ({ id: symbol, symbol });
assert(isValidSet([C('triangulo'), C('triangulo'), C('triangulo')]));
assert(isValidSet([C('triangulo'), C('quadrado'), C('circulo')]));
assert(isValidSet([C('triangulo'), C('coringa'), C('circulo')]));
assert(isValidSet([C('triangulo'), C('coringa'), C('coringa')]));
assert(!isValidSet([C('triangulo'), C('triangulo'), C('quadrado')]));
assert(isValidSet([C('triangulo'), C('triangulo'), C('coringa')]));
assert(!isValidSet([C('triangulo'), C('quadrado'), C('quadrado')]));
console.log('✔ regras de troca de cartas OK');

// ---------- RNG determinístico ----------
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function checkInvariants(g) {
  TERR_IDS.forEach((id) => {
    const t = g.terr[id];
    assert(t.owner >= 0 && t.owner < g.players.length, 'dono inválido');
    assert(g.players[t.owner].alive, `território ${id} pertence a jogador eliminado`);
    if (!(g.pendingMove && g.pendingMove.to === id)) assert(t.armies >= 1, `território ${id} sem exércitos`);
  });
  const total = g.deck.length + g.discard.length + g.players.reduce((s, p) => s + p.cards.length, 0);
  assert.strictEqual(total, 44, 'o total de cartas deve ser sempre 44');
  g.players.forEach((p) => assert(p.pool >= 0 && p.pp >= 0));
  const actions = g.actionDeck.length + g.actionDiscard.length + g.players.reduce((s, p) => s + p.actionHand.length, 0);
  assert.strictEqual(actions, g.actionTotal, 'o total de cartas de ação deve ser constante');
  TERR_IDS.forEach((id) => {
    const w = g.terr[id].w;
    assert(w === null || WEAPONS[w], 'arma inválida');
  });
  if (!g.expanded) g.players.forEach((p) => assert(p.techs.length === 0 && p.weapons.length === 0 && !p.actionHand.length));
}

const stats = { research: 0, unlock: 0, build: 0, fire: 0, cards: {}, truceBlocks: 0 };

// tenta ações do modo expandido ao acaso; falhas devem ser limpas (sem alterar o estado)
function tryExpanded(g, i, rng) {
  const p = g.players[i];
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const snap = () => JSON.stringify([g.terr, g.players.map((q) => [q.pool, q.pp, q.techs, q.weapons, q.actionHand.length])]);
  const attempt = (action, onOk) => {
    const before = snap();
    const r = g.act(i, action);
    if (r.ok) onOk && onOk(); else assert.strictEqual(snap(), before, `falha ${action.type} alterou o estado: ${r.error}`);
    return r.ok;
  };
  for (let k = 0; k < 3; k++) {
    attempt({ type: 'research', tech: pick(Object.keys(TECHS)) }, () => stats.research++);
    attempt({ type: 'unlock', weapon: pick(Object.keys(WEAPONS)) }, () => stats.unlock++);
  }
  attempt({ type: 'build', weapon: pick(Object.keys(WEAPONS)), territory: pick(g._owned(i)) }, () => stats.build++);
  p.actionHand.slice().forEach((c) => {
    const mine = g._owned(i);
    const act = {
      type: 'playCard', card: c.id, player: Math.floor(rng() * g.players.length), territory: pick(TERR_IDS),
      from: pick(mine), to: pick(mine), n: 1 + Math.floor(rng() * 3),
    };
    attempt(act, () => { stats.cards[c.type] = (stats.cards[c.type] || 0) + 1; });
  });
}

function tryFire(g, i, rng) {
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  g._owned(i).filter((id) => g.terr[id].w === 'obus' || g.terr[id].w === 'missil').forEach((from) => {
    const r = g.act(i, { type: 'fire', from, to: pick(TERR_IDS) });
    if (r.ok) stats.fire++;
  });
}

function must(res, ctx) { assert(res.ok, `${ctx}: ${res.error}`); }

function playBot(g, i, rng) {
  const p = g.players[i];
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const border = () => g._owned(i).filter((id) => ADJ[id].some((n) => g.terr[n].owner !== i));

  // troca de cartas
  let set = findSet(p.cards);
  while (set && (g._mustTrade(i) || rng() < 0.7)) {
    must(g.act(i, { type: 'trade', cards: set }), 'trade');
    set = findSet(p.cards);
  }
  const placeAll = () => {
    const targets = border();
    const spots = targets.length ? targets : g._owned(i);
    while (p.pool > 0) {
      const n = Math.min(p.pool, 1 + Math.floor(rng() * 6));
      must(g.act(i, { type: 'place', territory: pick(spots), n }), 'place');
    }
  };
  if (g.expanded) tryExpanded(g, i, rng);
  placeAll();
  must(g.act(i, { type: 'endReinforce' }), 'endReinforce');

  // ataque
  for (let k = 0; k < 40 && g.phase === 'attack'; k++) {
    if (g.expanded && rng() < 0.3) { tryExpanded(g, i, rng); tryFire(g, i, rng); }
    const opts = [];
    g._owned(i).forEach((from) => {
      if (g.terr[from].armies < 2) return;
      const reach = g.terr[from].w === 'caca' ? TERR_IDS.filter((x) => DIST[from][x] <= 2 && x !== from) : ADJ[from];
      reach.forEach((to) => {
        if (g.terr[to].owner === i) return;
        if (g.expanded && g._truced(i, g.terr[to].owner)) { stats.truceBlocks++; return; }
        opts.push({ from, to });
      });
    });
    if (!opts.length || rng() < 0.08) break;
    const o = pick(opts);
    const blitz = rng() < 0.4;
    const r = g.act(i, { type: 'attack', ...o, dice: 1 + Math.floor(rng() * 3), blitz });
    must(r, 'attack');
    if (g.pendingMove) {
      const { min, max } = g.pendingMove;
      must(g.act(i, { type: 'occupy', n: rng() < 0.5 ? min : max }), 'occupy');
    }
    if (g.phase === 'over') return;
    checkInvariants(g);
    placeAll(); // pode haver exércitos de troca forçada
    while (g._mustTrade(i)) { must(g.act(i, { type: 'trade', cards: findSet(p.cards) }), 'forced trade'); placeAll(); }
  }
  if (g.phase === 'over') return;
  must(g.act(i, { type: 'endAttack' }), 'endAttack');
  if (g.phase === 'over') return;

  // remanejamento
  const mine = g._owned(i);
  for (let k = 0; k < 3 && g.phase === 'fortify'; k++) {
    const from = pick(mine);
    const to = pick(ADJ[from].filter((n) => g.terr[n].owner === i) || []);
    if (!to) continue;
    const t = g.terr[from];
    const movable = Math.min(t.armies - 1, t.armies - t.locked);
    if (movable >= 1) must(g.act(i, { type: 'fortify', from, to, n: 1 + Math.floor(rng() * movable) }), 'fortify');
  }
  if (g.phase === 'over') return;
  must(g.act(i, { type: 'endTurn' }), 'endTurn');
}

function playGame(seed, nPlayers, expanded = false, maxTurns = 3000) {
  const rng = mulberry(seed);
  const g = new Game(Array.from({ length: nPlayers }, (_, k) => `J${k + 1}`), rng, { expanded });
  // fase inicial
  g.players.forEach((p, i) => {
    const mine = g._owned(i);
    while (p.pool > 0) must(g.act(i, { type: 'place', territory: mine[Math.floor(rng() * mine.length)], n: 1 }), 'setup');
    must(g.act(i, { type: 'ready' }), 'ready');
  });
  assert.strictEqual(g.phase, 'reinforce');
  let turns = 0;
  while (g.phase !== 'over' && turns++ < maxTurns) {
    playBot(g, g.turn, rng);
    checkInvariants(g);
  }
  return { g, turns };
}

// ---------- validações de regras ----------
{
  const g = new Game(['A', 'B', 'C'], mulberry(7));
  // 3 jogadores: 35 exércitos cada, 14 territórios
  g.players.forEach((p, i) => assert.strictEqual(p.pool + g._ownedCount(i), 35));
  // não dá para sair do setup sem distribuir tudo
  assert(!g.act(0, { type: 'ready' }).ok);
  // não dá para colocar em território alheio
  const alheio = TERR_IDS.find((id) => g.terr[id].owner !== 0);
  assert(!g.act(0, { type: 'place', territory: alheio, n: 1 }).ok);
  console.log('✔ distribuição inicial OK');
}

const results = { winners: 0, unfinished: 0, turns: 0 };
const N = 90;
for (let s = 1; s <= N; s++) {
  const players = 2 + (s % 9);
  const { g, turns } = playGame(s, players, s % 2 === 0);
  if (g.phase === 'over') {
    results.winners++;
    assert(g.winner !== null && g.players[g.winner].alive);
  } else {
    results.unfinished++;
  }
  results.turns += turns;
}
console.log(`✔ ${N} partidas simuladas (clássico + expandido): ${results.winners} terminaram com vencedor, ${results.unfinished} atingiram o limite de turnos (média ${Math.round(results.turns / N)} turnos)`);
assert(results.winners > N * 0.5, 'a maioria das partidas simuladas deveria terminar');
console.log('  modo expandido:', JSON.stringify(stats));
assert(stats.research > 20 && stats.unlock > 10 && stats.build > 10, 'o bot deveria pesquisar, desbloquear e construir');
assert(Object.keys(stats.cards).length >= 5, 'cartas de ação variadas deveriam ser jogadas');

// ---------- autoPlay ----------
{
  const g = new Game(['A', 'B', 'C'], mulberry(99));
  g.players.forEach((p, i) => { if (i < 2) { g.autoPlay(i); } });
  assert.strictEqual(g.phase, 'setup');
  assert(g.autoPlay(2).ok);
  assert.strictEqual(g.phase, 'reinforce');
  const t = g.turn;
  assert(g.autoPlay(t).ok);
  assert.notStrictEqual(g.turn, t);
  console.log('✔ autoPlay OK');
}
// ---------- regras do modo expandido (testes dirigidos) ----------
{
  const g = new Game(['A', 'B'], mulberry(5), { expanded: true });
  g.players.forEach((p, i) => { g._owned(i).forEach((id) => { g.terr[id].armies = 1; }); p.pool = 0; p.ready = true; });
  g._startPlay();
  const me = g.turn;
  const foe = 1 - me;
  const p = g.players[me];
  const act = (a) => g.act(me, a);
  assert(p.pp >= 2, 'recebe PP no início do turno');
  assert(g.players[me].actionHand.length >= 1, 'compra carta de ação');

  // pré-requisitos e custo
  assert(!act({ type: 'research', tech: 'ferrovias' }).ok, 'exige tecnologia anterior');
  p.pp = 0;
  assert(!act({ type: 'research', tech: 'intendencia' }).ok, 'exige PP');
  p.pp = 100;
  assert(act({ type: 'research', tech: 'intendencia' }).ok);
  assert(!act({ type: 'research', tech: 'intendencia' }).ok, 'não repete');
  assert(!act({ type: 'unlock', weapon: 'obus' }).ok, 'obus exige canhão');
  assert(!act({ type: 'unlock', weapon: 'tanques' }).ok, 'blindados exigem Doutrina de assalto');
  assert(act({ type: 'unlock', weapon: 'canhao' }).ok);
  assert(act({ type: 'unlock', weapon: 'obus' }).ok);
  assert(!act({ type: 'unlock', weapon: 'missil' }).ok, 'míssil exige Laboratórios');
  assert(act({ type: 'unlock', weapon: 'bunker' }).ok);

  // construção
  const [a, b] = g._owned(me);
  g.terr[a].armies = 5;
  g.terr[b].armies = 5;
  assert(!act({ type: 'build', weapon: 'canhao', territory: g._owned(foe)[0] }).ok, 'só em território seu');
  assert(!act({ type: 'build', weapon: 'caca', territory: a }).ok, 'arma bloqueada');
  assert(act({ type: 'build', weapon: 'obus', territory: a }).ok);
  assert.strictEqual(g.terr[a].armies, 2, 'construção gasta exércitos');
  assert(!act({ type: 'build', weapon: 'bunker', territory: b }).ok, 'só 1 construção por turno');

  // disparo do obuseiro: precisa estar na fase de ataque, causa 1 baixa e sobra 1
  p.pool = 0;
  assert(!act({ type: 'fire', from: a, to: g._owned(foe)[0] }).ok, 'não dispara na fase de reforço');
  p.pool = 0;
  g.phase = 'attack';
  const adjFoe = ADJ[a].find((n) => g.terr[n].owner === foe);
  if (adjFoe) {
    g.terr[adjFoe].armies = 3;
    assert(act({ type: 'fire', from: a, to: adjFoe }).ok);
    assert.strictEqual(g.terr[adjFoe].armies, 2);
    assert(!act({ type: 'fire', from: a, to: adjFoe }).ok, 'um disparo por turno');
    g.terr[a].fired = false;
    g.terr[adjFoe].armies = 1;
    assert(!act({ type: 'fire', from: a, to: adjFoe }).ok, 'não mata o último exército');
    g.terr[adjFoe].w = 'antiaereo';
    g.terr[adjFoe].armies = 4;
    assert(!act({ type: 'fire', from: a, to: adjFoe }).ok, 'antiaéreo é imune');
    g.terr[adjFoe].w = null;
  }

  // cessar-fogo impede ataque do adversário
  g.players[me].actionHand.push({ id: 'x_cessar', type: 'cessar' });
  assert(act({ type: 'playCard', card: 'x_cessar', player: foe }).ok);
  g.terr[a].armies = 4;
  const target = adjFoe || ADJ[a].find((n) => g.terr[n].owner === foe);
  if (target) {
    // o adversário (foe) não pode atacar 'me' enquanto o cessar-fogo durar
    assert(g._truced(foe, me));
  }
  // espionagem revela o objetivo
  g.players[me].actionHand.push({ id: 'x_esp', type: 'espionagem' });
  assert(act({ type: 'playCard', card: 'x_esp', player: foe }).ok);
  assert.strictEqual(g.players[me].intel[0].text, g.players[foe].objective.text);
  assert(!act({ type: 'playCard', card: 'x_esp', player: foe }).ok, 'carta já foi usada');

  // Caças alcançam território a 2 fronteiras; Ferrovias liberam remanejamento distante
  g.terr[a].w = 'caca';
  const far = TERR_IDS.find((x) => DIST[a][x] === 2);
  assert(g._canReach(a, far));
  const far3 = TERR_IDS.find((x) => DIST[a][x] === 3);
  assert(!g._canReach(a, far3));
  console.log('✔ regras do modo expandido OK');
}

console.log('Todos os testes passaram.');
