'use strict';

const {
  CONTINENTS, TERRITORIES, ADJ, COLORS, MAX_PLAYERS, OBJECTIVES, SYMBOLS, TOTAL_ARMIES, TRADE_SEQ,
  PP_BASE, ACTION_HAND_MAX, BUILDS_PER_TURN, FORTIFY_PER_TURN, TECHS, WEAPONS, ACTION_CARDS, ESCALATION_EVERY,
} = require('./data');

const TERR_IDS = TERRITORIES.map((t) => t.id);
const TERR_BY_ID = Object.fromEntries(TERRITORIES.map((t) => [t.id, t]));
const MUST_TRADE_AT = 5; // com 5 ou mais cartas a troca é obrigatória
const PHASES_ACTIVE = ['reinforce', 'attack', 'fortify'];
const LOG_MAX = 5000; // histórico completo da partida (o estado enviado a cada jogada leva só o final)

// distância (em fronteiras) entre todos os pares de comunidades
const DIST = {};
TERR_IDS.forEach((start) => {
  const d = { [start]: 0 };
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    ADJ[cur].forEach((n) => { if (d[n] === undefined) { d[n] = d[cur] + 1; queue.push(n); } });
  }
  DIST[start] = d;
});

const fail = (error) => ({ ok: false, error });
const ok = () => ({ ok: true });

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Três cartas formam um conjunto se tiverem o mesmo símbolo ou três símbolos diferentes.
// Coringas substituem qualquer símbolo.
function isValidSet(cards) {
  if (cards.length !== 3) return false;
  const syms = cards.filter((c) => c.symbol !== 'coringa').map((c) => c.symbol);
  const unique = new Set(syms).size;
  return syms.length <= 1 || unique === 1 || unique === syms.length;
}

function findSet(hand) {
  for (let a = 0; a < hand.length; a++) {
    for (let b = a + 1; b < hand.length; b++) {
      for (let c = b + 1; c < hand.length; c++) {
        if (isValidSet([hand[a], hand[b], hand[c]])) return [hand[a].id, hand[b].id, hand[c].id];
      }
    }
  }
  return null;
}

class Game {
  constructor(names, rng = Math.random, opts = {}) {
    const n = names.length;
    if (n < 2 || n > MAX_PLAYERS) throw new Error(`O jogo precisa de 2 a ${MAX_PLAYERS} jogadores`);
    this.rng = rng;
    this.expanded = !!opts.expanded;
    this.maxRounds = Math.max(0, Math.floor(Number(opts.maxRounds)) || 0); // 0 = sem limite
    this.first = 0; // quem abre cada rodada
    this.endReason = null; // 'objective' | 'last' | 'limit'
    this.truces = []; // { by, against }: 'against' não ataca 'by' até o próximo turno de 'by'
    this.buff = { ofensiva: false, built: 0 };
    this.phase = 'setup'; // setup | reinforce | attack | fortify | over
    this.turn = 0;
    this.round = 0;
    this.winner = null;
    this.pendingMove = null;
    this.lastCombat = null;
    this.combatSeq = 0;
    this.conqueredThisTurn = false;
    this.fortifies = 0; // remanejamentos feitos no turno atual
    this.tradeCount = 0;
    this.turnInfo = null;
    this.log = [];
    this.logSeq = 0;
    this.startedAt = Date.now(); // relógio da partida
    this.endedAt = null;

    this.players = names.map((name, i) => ({
      name, color: i, alive: true, cards: [], objective: null, pool: 0, ready: false,
      pp: 0, techs: [], weapons: [], actionHand: [], intel: [], afk: false,
    }));

    // Distribui todas as comunidades igualmente, com 1 soldado em cada
    this.terr = {};
    shuffle(TERR_IDS, rng).forEach((id, i) => {
      this.terr[id] = { owner: i % n, armies: 1, locked: 0, w: null, fired: false };
    });

    // Baralho de cartas de ação (modo expandido)
    const actions = [];
    Object.entries(ACTION_CARDS).forEach(([type, def]) => {
      for (let k = 0; k < def.count; k++) actions.push({ id: `a_${type}_${k}`, type });
    });
    this.actionTotal = this.expanded ? actions.length : 0;
    this.actionDeck = this.expanded ? shuffle(actions, rng) : [];
    this.actionDiscard = [];
    this.players.forEach((p, i) => {
      p.pool = TOTAL_ARMIES[n] - this._ownedCount(i);
    });

    // Objetivos
    shuffle(OBJECTIVES, rng).slice(0, n).forEach((def, i) => {
      this.players[i].objective = this._buildObjective(def, i);
    });

    // Baralho: 42 cartas de comunidade + 2 coringas
    const cards = TERRITORIES.map((t, i) => ({
      id: `c${i}`, territory: t.id, symbol: SYMBOLS[i % SYMBOLS.length],
    }));
    cards.push({ id: 'c42', territory: null, symbol: 'coringa' });
    cards.push({ id: 'c43', territory: null, symbol: 'coringa' });
    this.deck = shuffle(cards, rng);
    this.discard = [];

    this._log(null, 'As comunidades foram sorteadas. Distribuam seus soldados iniciais!');
  }

  // ---------- utilidades ----------

  _log(p, t, k, m) {
    this.logSeq += 1;
    // r/ph/at: rodada, fase e hora da jogada (usados na página de histórico)
    this.log.push({ p, t, k, m, n: this.logSeq, r: this.round, ph: this.phase, at: Date.now() });
    if (this.log.length > LOG_MAX) this.log.shift();
  }

  _name(i) { return this.players[i].name; }

  _roll() { return 1 + Math.floor(this.rng() * 6); }

  _owned(i) { return TERR_IDS.filter((id) => this.terr[id].owner === i); }

  _ownedCount(i) { return TERR_IDS.reduce((s, id) => s + (this.terr[id].owner === i ? 1 : 0), 0); }

  _ownsContinent(i, c) {
    return TERRITORIES.every((t) => t.continent !== c || this.terr[t.id].owner === i);
  }

  _mustTrade(i) { return this.players[i].cards.length >= MUST_TRADE_AT; }

  _tech(i, id) { return this.expanded && this.players[i].techs.includes(id); }

  // pontos usados quando acaba o limite de rodadas: comunidades + bônus das regiões inteiras
  _score(i) {
    return this._ownedCount(i) + Object.keys(CONTINENTS)
      .reduce((s, c) => s + (this._ownsContinent(i, c) ? CONTINENTS[c].bonus : 0), 0);
  }

  _armies(i) { return TERR_IDS.reduce((s, id) => s + (this.terr[id].owner === i ? this.terr[id].armies : 0), 0); }

  _truced(attacker, defender) {
    return this.truces.some((t) => t.by === defender && t.against === attacker);
  }

  // a comunidade pode atacar o alvo? (vizinho, ou até 2 fronteiras com Motoqueiros)
  _canReach(from, to) {
    if (ADJ[from].includes(to)) return true;
    return this.expanded && this.terr[from].w === 'caca' && DIST[from][to] <= 2;
  }

  _connectedOwn(i, from, to) {
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === to) return true;
      ADJ[cur].forEach((n) => {
        if (!seen.has(n) && this.terr[n].owner === i) { seen.add(n); queue.push(n); }
      });
    }
    return false;
  }

  _drawAction(i) {
    const p = this.players[i];
    if (p.actionHand.length >= ACTION_HAND_MAX) return false;
    if (!this.actionDeck.length && this.actionDiscard.length) {
      this.actionDeck = shuffle(this.actionDiscard, this.rng);
      this.actionDiscard = [];
    }
    const card = this.actionDeck.pop();
    if (!card) return false;
    p.actionHand.push(card);
    return true;
  }

  _nextTradeValue() {
    return this.tradeCount < TRADE_SEQ.length
      ? TRADE_SEQ[this.tradeCount]
      : TRADE_SEQ[TRADE_SEQ.length - 1] + 5 * (this.tradeCount - TRADE_SEQ.length + 1);
  }

  _buildObjective(def, i) {
    const n = this.players.length;
    if (def.type === 'continents') {
      const names = def.required.map((c) => CONTINENTS[c].name);
      const text = `Dominar na totalidade ${names.join(' e ')}${def.extra ? ' e mais uma região à sua escolha' : ''}.`;
      return { ...def, text };
    }
    if (def.type === 'territories') {
      const text = def.minArmies > 1
        ? `Dominar ${def.n} comunidades e ocupar cada uma delas com pelo menos ${def.minArmies} soldados.`
        : `Dominar ${def.n} comunidades à sua escolha.`;
      return { ...def, text };
    }
    // destruir uma facção: se ele não existe, é você mesmo ou foi destruído por outro, domine 24 comunidades
    if (def.color >= n || def.color === i) {
      return { id: def.id, type: 'territories', n: 24, minArmies: 1, text: 'Dominar 24 comunidades à sua escolha.' };
    }
    const cor = COLORS[def.color].faction;
    return {
      ...def, target: def.color, done: false,
      text: `Destruir totalmente a facção ${cor}. Se outro jogador a eliminar primeiro, domine 24 comunidades à sua escolha.`,
    };
  }

  _objectiveDone(i) {
    const o = this.players[i].objective;
    if (o.type === 'continents') {
      if (!o.required.every((c) => this._ownsContinent(i, c))) return false;
      if (!o.extra) return true;
      const others = Object.keys(CONTINENTS).filter((c) => !o.required.includes(c));
      return others.filter((c) => this._ownsContinent(i, c)).length >= o.extra;
    }
    if (o.type === 'territories') {
      return this._owned(i).filter((id) => this.terr[id].armies >= o.minArmies).length >= o.n;
    }
    return !!o.done;
  }

  _checkWin(i) {
    if (this.phase === 'over') return true;
    const alive = this.players.filter((p) => p.alive).length;
    if (alive === 1 && this.players[i].alive) return this._win(i, 'dominou a cidade, restando apenas a sua facção', 'last');
    if (this.players[i].alive && this._objectiveDone(i)) return this._win(i, 'cumpriu o seu objetivo', 'objective');
    return false;
  }

  // fim do limite de rodadas: vence quem tem mais pontos (desempate: mais soldados, depois mais cartas)
  _endByLimit() {
    const ranked = this.players.map((p, i) => i).filter((i) => this.players[i].alive)
      .sort((a, b) => this._score(b) - this._score(a) || this._armies(b) - this._armies(a)
        || this.players[b].cards.length - this.players[a].cards.length);
    const w = ranked[0];
    this._log(null, `Fim das ${this.maxRounds} rodadas! Placar: ${ranked.map((i) => `${this._name(i)} ${this._score(i)}`).join(', ')}.`, 'limit');
    return this._win(w, `fez mais pontos ao fim das ${this.maxRounds} rodadas (${this._score(w)} pontos)`, 'limit');
  }

  _win(i, why, reason) {
    this.phase = 'over';
    this.endReason = reason;
    this.winner = i;
    this.endedAt = Date.now();
    this.pendingMove = null;
    this._log(i, `${this._name(i)} venceu a partida: ${why}!`, 'win');
    return true;
  }

  // ---------- fluxo ----------

  act(i, a) {
    if (!a || typeof a.type !== 'string') return fail('Ação inválida.');
    if (this.phase === 'over') return fail('A partida já terminou.');
    if (!this.players[i] || !this.players[i].alive) return fail('Você foi eliminado.');
    const res = this._dispatch(i, a);
    if (res.ok && this.players[i]) this.players[i].afk = false; // jogou por conta própria: deixa de estar ausente
    return res;
  }

  _dispatch(i, a) {
    switch (a.type) {
      case 'place': return this._place(i, a);
      case 'autoPlace': return this._autoPlace(i);
      case 'ready': return this._ready(i);
      case 'trade': return this._trade(i, a);
      case 'endReinforce': return this._endReinforce(i);
      case 'attack': return this._attack(i, a);
      case 'occupy': return this._occupy(i, a);
      case 'endAttack': return this._endAttack(i);
      case 'fortify': return this._fortify(i, a);
      case 'endTurn': return this._endTurn(i);
      case 'back': return ok(); // "voltei": act() tira o jogador do estado de ausente
      case 'research': return this._research(i, a);
      case 'unlock': return this._unlock(i, a);
      case 'build': return this._build(i, a);
      case 'fire': return this._fire(i, a);
      case 'playCard': return this._playCard(i, a);
      default: return fail('Ação desconhecida.');
    }
  }

  _isTurn(i) { return this.turn === i; }

  _place(i, a) {
    const p = this.players[i];
    const n = Math.floor(Number(a.n));
    if (!(n >= 1)) return fail('Quantidade inválida.');
    if (this.phase === 'setup') {
      if (p.ready) return fail('Você já confirmou a distribuição.');
    } else {
      if (!this._isTurn(i)) return fail('Não é a sua vez.');
      if (!(this.phase === 'reinforce' || (this.phase === 'attack' && p.pool > 0))) {
        return fail('Não é possível colocar soldados agora.');
      }
    }
    const t = this.terr[a.territory];
    if (!t || t.owner !== i) return fail('Escolha uma comunidade sua.');
    if (n > p.pool) return fail('Você não tem tantos soldados para distribuir.');
    t.armies += n;
    p.pool -= n;
    if (this.phase !== 'setup') {
      this._log(i, `${p.name} colocou ${n} soldado(s) em ${TERR_BY_ID[a.territory].name}.`, 'reinforce', { to: a.territory, n });
    }
    this._afterPlace(i);
    return ok();
  }

  // "Distribuir automaticamente": espalha o que falta nas fronteiras mais fracas
  _autoPlace(i) {
    const p = this.players[i];
    if (this.phase === 'setup') {
      if (p.ready) return fail('Você já confirmou a distribuição.');
    } else if (!this._isTurn(i) || !(this.phase === 'reinforce' || (this.phase === 'attack' && p.pool > 0))) {
      return fail('Não é possível colocar soldados agora.');
    }
    if (p.pool <= 0) return fail('Não há soldados para distribuir.');
    this._dumpPool(i);
    this._afterPlace(i);
    return ok();
  }

  // Avança sozinho quando não sobra nada a decidir: na preparação, fica pronto ao zerar os soldados;
  // no reforço, vai para o ataque se não houver troca possível nem carta de Reforço na mão.
  _afterPlace(i) {
    const p = this.players[i];
    if (p.pool > 0) return;
    if (this.phase === 'setup') { this._ready(i); return; }
    if (this.phase !== 'reinforce' || findSet(p.cards)) return;
    if (this.expanded && p.actionHand.some((c) => c.type === 'reforco')) return;
    this._endReinforce(i);
  }

  _dumpPool(i) {
    const p = this.players[i];
    const mine = this._owned(i);
    const border = mine.filter((id) => ADJ[id].some((n) => this.terr[n].owner !== i));
    const spots = border.length ? border : mine;
    const placed = {};
    while (p.pool > 0 && spots.length) {
      const min = Math.min(...spots.map((id) => this.terr[id].armies));
      const weakest = spots.filter((id) => this.terr[id].armies === min);
      const id = weakest[Math.floor(this.rng() * weakest.length)];
      this.terr[id].armies += 1;
      placed[id] = (placed[id] || 0) + 1;
      p.pool -= 1;
    }
    if (this.phase !== 'setup') {
      Object.entries(placed).forEach(([id, n]) => {
        this._log(i, `${p.name} colocou ${n} soldado(s) em ${TERR_BY_ID[id].name} (automático).`, 'reinforce', { to: id, n });
      });
    }
  }

  _ready(i) {
    const p = this.players[i];
    if (this.phase !== 'setup') return fail('A fase inicial já terminou.');
    if (p.ready) return fail('Você já está pronto.');
    if (p.pool > 0) return fail(`Distribua todos os soldados (faltam ${p.pool}).`);
    p.ready = true;
    this._log(i, `${p.name} está pronto.`, 'ready');
    if (this.players.every((q) => q.ready)) this._startPlay();
    return ok();
  }

  _startPlay() {
    this.round = 1;
    const first = Math.floor(this.rng() * this.players.length);
    this.first = first;
    this._log(null, `A guerra começou!${this.maxRounds ? ` A partida dura ${this.maxRounds} rodadas.` : ''}`, 'start');
    this._beginTurn(first);
  }

  _beginTurn(i) {
    this.turn = i;
    this.phase = 'reinforce';
    this.conqueredThisTurn = false;
    this.fortifies = 0;
    this.pendingMove = null;
    this.lastCombat = null;
    this.buff = { ofensiva: false, built: 0 };
    this.truces = this.truces.filter((t) => t.by !== i);
    TERR_IDS.forEach((id) => { this.terr[id].locked = 0; this.terr[id].fired = false; });
    const count = this._ownedCount(i);
    const base = Math.max(3, Math.floor(count / 2));
    const continents = Object.keys(CONTINENTS)
      .filter((c) => this._ownsContinent(i, c))
      .map((c) => ({ c, bonus: CONTINENTS[c].bonus }));
    let tech = 0;
    if (this._tech(i, 'intendencia')) tech += 1;
    if (this._tech(i, 'industria')) tech += 2;
    const war = Math.floor(this.round / ESCALATION_EVERY); // escalada: a guerra esquenta com o passar das rodadas
    const total = base + continents.reduce((s, x) => s + x.bonus, 0) + tech + war;
    const p = this.players[i];
    this.turnInfo = { base, continents, tech, war, total, pp: 0 };
    p.pool += total;
    const extra = continents.length ? ` + regiões (${continents.map((x) => `${CONTINENTS[x.c].name} +${x.bonus}`).join(', ')})` : '';
    this._log(i, `Vez de ${this._name(i)}: ${total} soldados de reforço (${count} comunidades → ${base}${extra}${tech ? ` + tecnologia ${tech}` : ''}${war ? ` + escalada ${war}` : ''}).`, 'turn', { player: i });

    if (this.expanded) {
      const pp = PP_BASE + Math.floor(count / 6) + continents.length
        + (this._tech(i, 'industria') ? 1 : 0) + (this._tech(i, 'laboratorios') ? 2 : 0);
      p.pp += pp;
      this.turnInfo.pp = pp;
      if (this._tech(i, 'guarnicoes')) {
        const mine = this._owned(i);
        const min = Math.min(...mine.map((id) => this.terr[id].armies));
        const weakest = mine.filter((id) => this.terr[id].armies === min);
        const id = weakest[Math.floor(this.rng() * weakest.length)];
        this.terr[id].armies += 1;
        this._log(i, `Os vigias reforçaram ${TERR_BY_ID[id].name} (+1).`, 'place', { to: id });
      }
      let drawn = 0;
      for (let k = 0; k < 1 + (this._tech(i, 'agentes') ? 1 : 0); k++) if (this._drawAction(i)) drawn++;
      this._log(i, `${p.name} recebeu ${pp} PP${drawn ? ` e ${drawn} carta(s) de ação` : ''}.`, 'draw');
    }
  }

  _trade(i, a) {
    const p = this.players[i];
    if (!this._isTurn(i)) return fail('Não é a sua vez.');
    const allowed = this.phase === 'reinforce' || (this.phase === 'attack' && this._mustTrade(i));
    if (!allowed) return fail('Você só pode trocar cartas na fase de reforço.');
    const ids = Array.isArray(a.cards) ? a.cards : [];
    if (new Set(ids).size !== 3) return fail('Escolha 3 cartas diferentes.');
    const cards = ids.map((id) => p.cards.find((c) => c.id === id));
    if (cards.some((c) => !c)) return fail('Carta inválida.');
    if (!isValidSet(cards)) return fail('Troque 3 cartas do mesmo símbolo ou 3 símbolos diferentes (coringa vale por qualquer um).');

    const armies = this._nextTradeValue() + (this._tech(i, 'propaganda') ? 2 : 0);
    this.tradeCount++;
    p.cards = p.cards.filter((c) => !ids.includes(c.id));
    this.discard.push(...cards);
    p.pool += armies;
    const bonusTerr = [];
    cards.forEach((c) => {
      if (c.territory && this.terr[c.territory].owner === i) {
        this.terr[c.territory].armies += 2;
        bonusTerr.push(TERR_BY_ID[c.territory].name);
      }
    });
    this._log(i, `${p.name} trocou 3 cartas por ${armies} soldados${bonusTerr.length ? ` (+2 em ${bonusTerr.join(', ')})` : ''}.`, 'trade', { n: armies });
    return ok();
  }

  _endReinforce(i) {
    const p = this.players[i];
    if (!this._isTurn(i) || this.phase !== 'reinforce') return fail('Não é possível encerrar o reforço agora.');
    if (p.pool > 0) return fail(`Distribua todos os soldados (faltam ${p.pool}).`);
    if (this._mustTrade(i)) return fail('Você tem 5 ou mais cartas: troque antes de continuar.');
    this.phase = 'attack';
    this._log(i, `${p.name} passou para o ataque.`, 'phase', { phase: 'attack' });
    if (this._checkWin(i)) return ok();
    return ok();
  }

  _attack(i, a) {
    const p = this.players[i];
    if (!this._isTurn(i) || this.phase !== 'attack') return fail('Não é a fase de ataque.');
    if (this.pendingMove) return fail('Mova os soldados para a comunidade dominada primeiro.');
    if (p.pool > 0) return fail('Distribua os soldados da troca antes de atacar.');
    if (this._mustTrade(i)) return fail('Você tem 5 ou mais cartas: troque antes de atacar.');
    const f = this.terr[a.from];
    const t = this.terr[a.to];
    if (!f || !t) return fail('Comunidade inválida.');
    if (f.owner !== i) return fail('A comunidade de origem deve ser sua.');
    if (t.owner === i) return fail('Você não pode atacar uma comunidade sua.');
    if (!this._canReach(a.from, a.to)) return fail('As comunidades não são vizinhas.');
    if (this.expanded && this._truced(i, t.owner)) return fail('Trégua: esse jogador não pode ser atacado por você agora.');
    if (f.armies < 2) return fail('É preciso ter ao menos 2 soldados para atacar.');
    const wanted = Math.floor(Number(a.dice));
    if (!a.blitz && !(wanted >= 1)) return fail('Escolha de 1 a 3 dados.');

    const defender = t.owner;
    const agg = {
      from: a.from, to: a.to, att: p.name, def: this._name(defender), attColor: p.color, defColor: this.players[defender].color,
      rounds: 0, lossA: 0, lossD: 0, attDice: [], defDice: [], conquered: false, notes: [],
    };
    let diceUsed = 0;
    do {
      const maxDice = Math.min(3, f.armies - 1);
      diceUsed = a.blitz ? maxDice : Math.min(wanted, maxDice);
      const att = Array.from({ length: diceUsed }, () => this._roll()).sort((x, y) => y - x);
      const def = Array.from({ length: Math.min(3, t.armies) }, () => this._roll()).sort((x, y) => y - x);
      const notes = [];
      let tie0 = false;
      let tie1 = false;
      // cada dado guarda se recebeu +1, para o painel de combate mostrar de onde veio o valor
      const A = att.map((v) => ({ v, b: 0 }));
      const D = def.map((v) => ({ v, b: 0 }));
      const bump = (d) => { if (d.v < 6) { d.v += 1; d.b = 1; } };
      if (this.expanded) {
        if (f.w === 'canhao') { bump(A[0]); notes.push(`${WEAPONS.canhao.name}: ataque +1`); }
        if (t.w === 'bunker') { bump(D[0]); notes.push(`${WEAPONS.bunker.name}: defesa +1`); }
        if (D.length === 3 && this._tech(defender, 'trincheiras')) { bump(D[2]); notes.push(`${TECHS.trincheiras.name}: defesa +1`); }
        A.sort((x, y) => y.v - x.v);
        D.sort((x, y) => y.v - x.v);
        if (this.buff.ofensiva) { tie0 = true; notes.push('Ofensiva total'); }
        if (this._tech(i, 'guerra_total')) { tie0 = true; notes.push(TECHS.guerra_total.name); }
        if (f.w === 'tanques' && A.length === 3) { tie0 = true; notes.push(WEAPONS.tanques.name); }
        tie1 = tie0 || this._tech(i, 'assalto');
      }
      let lossA = 0;
      let lossD = 0;
      const pairs = []; // resultado de cada par (maior × maior, 2º × 2º, 3º × 3º)
      for (let k = 0; k < Math.min(A.length, D.length); k++) {
        const tie = k === 0 ? tie0 : tie1;
        const attWins = A[k].v > D[k].v || (A[k].v === D[k].v && tie);
        pairs.push({ w: attWins ? 'att' : 'def', tie: A[k].v === D[k].v });
        if (attWins) lossD++; else lossA++;
      }
      const wall = lossD > 1 && this._tech(defender, 'muralha');
      if (wall) { lossD = 1; notes.push(`${TECHS.muralha.name}: defesa perde só 1`); }
      t.armies -= lossD;
      f.armies -= lossA;
      agg.lossA += lossA;
      agg.lossD += lossD;
      agg.rounds++;
      agg.attDice = A.map((d) => d.v);
      agg.defDice = D.map((d) => d.v);
      agg.attBonus = A.map((d) => d.b);
      agg.defBonus = D.map((d) => d.b);
      agg.pairs = pairs;
      agg.lastLossA = lossA;
      agg.lastLossD = lossD;
      agg.wall = wall;
      agg.notes = [...new Set(notes)];
      if (t.armies <= 0) agg.conquered = true;
    } while (a.blitz && !agg.conquered && f.armies >= 2);

    agg.id = ++this.combatSeq;
    this.lastCombat = agg;
    const dest = TERR_BY_ID[a.to].name;
    this._log(i, `${p.name} atacou ${dest} (${agg.def}) a partir de ${TERR_BY_ID[a.from].name}: ${agg.lossA} baixa(s) no ataque, ${agg.lossD} na defesa.`, 'attack', {
      from: a.from, to: a.to, def: defender, lossA: agg.lossA, lossD: agg.lossD, rounds: agg.rounds, conquered: agg.conquered,
    });

    if (agg.conquered) {
      t.owner = i;
      t.armies = 0;
      t.locked = 0;
      if (t.w) { this._log(i, `${WEAPONS[t.w].name} em ${dest} foi destruído quando a comunidade foi dominada.`, 'destroy', { to: a.to }); t.w = null; }
      this.conqueredThisTurn = true;
      this.pendingMove = { from: a.from, to: a.to, min: diceUsed, max: f.armies - 1 };
      this._log(i, `${p.name} dominou ${dest}!`, 'conquer', { from: a.from, to: a.to, def: defender });
      if (this._ownedCount(defender) === 0) this._eliminate(i, defender);
      // sem escolha (mínimo = máximo): ocupa direto, sem perguntar
      if (this.pendingMove.min >= this.pendingMove.max) this._occupy(i, { n: this.pendingMove.max });
    }
    return ok();
  }

  _eliminate(killer, victim) {
    const v = this.players[victim];
    const k = this.players[killer];
    v.alive = false;
    v.pool = 0;
    const taken = v.cards.length;
    k.cards.push(...v.cards);
    v.cards = [];
    this.actionDiscard.push(...v.actionHand);
    v.actionHand = [];
    this._log(killer, `${k.name} eliminou ${v.name}${taken ? ` e ficou com suas ${taken} carta(s)` : ''}!`, 'eliminate');
    if (k.objective.type === 'destroy' && k.objective.target === victim) k.objective.done = true;
    // quem tinha de destruir essa facção, mas não foi quem o eliminou, troca de objetivo
    this.players.forEach((p, idx) => {
      if (idx !== killer && p.alive && p.objective.type === 'destroy' && p.objective.target === victim) {
        p.objective = {
          id: 'T24', type: 'territories', n: 24, minArmies: 1,
          text: 'Dominar 24 comunidades à sua escolha (a facção que você devia destruir foi eliminada por outro jogador).',
        };
      }
    });
  }

  _occupy(i, a) {
    const pm = this.pendingMove;
    if (!this._isTurn(i) || !pm) return fail('Não há comunidade para ocupar.');
    const n = Math.floor(Number(a.n));
    if (!(n >= pm.min && n <= pm.max)) return fail(`Mova entre ${pm.min} e ${pm.max} soldados.`);
    this.terr[pm.from].armies -= n;
    this.terr[pm.to].armies = n;
    this.pendingMove = null;
    this._log(i, `${this._name(i)} ocupou ${TERR_BY_ID[pm.to].name} com ${n} soldado(s) vindos de ${TERR_BY_ID[pm.from].name}.`, 'occupy', { from: pm.from, to: pm.to, n });
    if (this._tech(i, 'blitzkrieg')) {
      this.terr[pm.to].armies += 1;
      this._log(i, 'Ocupação relâmpago: +1 soldado grátis na comunidade dominada.', 'place', { to: pm.to });
    }
    this._checkWin(i);
    return ok();
  }

  _draw(i) {
    if (!this.deck.length && this.discard.length) {
      this.deck = shuffle(this.discard, this.rng);
      this.discard = [];
    }
    const card = this.deck.pop();
    if (!card) return;
    this.players[i].cards.push(card);
    this._log(i, `${this._name(i)} recebeu uma carta de comunidade por dominar comunidades.`, 'draw');
  }

  _endAttack(i) {
    const p = this.players[i];
    if (!this._isTurn(i) || this.phase !== 'attack') return fail('Não é a fase de ataque.');
    if (this.pendingMove) return fail('Mova os soldados para a comunidade dominada primeiro.');
    if (p.pool > 0) return fail(`Distribua todos os soldados (faltam ${p.pool}).`);
    if (this._mustTrade(i)) return fail('Você tem 5 ou mais cartas: troque antes de continuar.');
    if (this.conqueredThisTurn) this._draw(i);
    this.phase = 'fortify';
    this._log(i, `${p.name} passou para o remanejamento.`, 'phase', { phase: 'fortify' });
    this._checkWin(i);
    return ok();
  }

  _fortify(i, a) {
    if (!this._isTurn(i) || this.phase !== 'fortify') return fail('Não é a fase de remanejamento.');
    const f = this.terr[a.from];
    const t = this.terr[a.to];
    if (!f || !t || f.owner !== i || t.owner !== i) return fail('Escolha duas comunidades suas.');
    if (a.from === a.to) return fail('Escolha comunidades diferentes.');
    if (this.fortifies >= FORTIFY_PER_TURN) return fail(`Você já fez os ${FORTIFY_PER_TURN} remanejamentos deste turno. Encerre o turno.`);
    if (this._tech(i, 'ferrovias')) {
      if (!this._connectedOwn(i, a.from, a.to)) return fail('Sem rede de becos: as comunidades precisam estar ligadas por comunidades suas.');
    } else if (!ADJ[a.from].includes(a.to)) {
      return fail('Só é possível mover entre comunidades vizinhas.');
    }
    const n = Math.floor(Number(a.n));
    const movable = Math.min(f.armies - 1, f.armies - f.locked);
    if (!(n >= 1 && n <= movable)) return fail(movable > 0 ? `Você pode mover até ${movable} soldado(s) daqui.` : 'Não há soldados disponíveis para mover daqui.');
    f.armies -= n;
    t.armies += n;
    t.locked += n; // soldados que acabaram de chegar não se movem de novo neste turno
    this.fortifies++;
    this._log(i, `${this._name(i)} moveu ${n} soldado(s) de ${TERR_BY_ID[a.from].name} para ${TERR_BY_ID[a.to].name}.`, 'move', { from: a.from, to: a.to, n });
    if (this._checkWin(i)) return ok();
    // remanejamentos esgotados e nenhuma carta de ação jogável aqui: o turno passa sozinho
    const cardsLeft = this.expanded && this.players[i].actionHand.some((c) => ACTION_CARDS[c.type].phases.includes('fortify'));
    if (this.fortifies >= FORTIFY_PER_TURN && !cardsLeft) this._endTurn(i);
    return ok();
  }

  _endTurn(i) {
    if (!this._isTurn(i)) return fail('Não é a sua vez.');
    if (this.phase === 'attack') {
      const r = this._endAttack(i);
      if (!r.ok) return r;
      if (this.phase === 'over') return ok();
    }
    if (this.phase !== 'fortify') return fail('Termine o reforço e o ataque antes de encerrar o turno.');
    this._checkWin(i);
    if (this.phase === 'over') return ok();
    let next = i;
    const before = this.round;
    do {
      next = (next + 1) % this.players.length;
      if (next === this.first) this.round++; // a rodada vira quando a vez volta a quem abriu a partida
    } while (!this.players[next].alive);
    if (this.maxRounds && this.round > this.maxRounds) {
      this.round = this.maxRounds;
      this._endByLimit();
      return ok();
    }
    if (this.round !== before && this.maxRounds && this.round === this.maxRounds) {
      this._log(null, 'Última rodada! Ao final dela vence quem tiver mais pontos.', 'lastRound');
    }
    this._beginTurn(next);
    return ok();
  }

  // ---------- modo expandido: tecnologia, armas e cartas de ação ----------

  // valida que o jogador pode usar ações do modo expandido agora
  _expandedTurn(i) {
    if (!this.expanded) return 'O modo expandido não está ativo nesta partida.';
    if (!this._isTurn(i) || !PHASES_ACTIVE.includes(this.phase)) return 'Só é possível durante o seu turno.';
    if (this.pendingMove) return 'Mova os soldados para a comunidade dominada primeiro.';
    return null;
  }

  _research(i, a) {
    const err = this._expandedTurn(i);
    if (err) return fail(err);
    const p = this.players[i];
    const def = TECHS[a.tech];
    if (!def) return fail('Tecnologia desconhecida.');
    if (p.techs.includes(a.tech)) return fail('Você já pesquisou essa tecnologia.');
    if (!def.req.every((r) => p.techs.includes(r))) return fail('Pesquise antes as tecnologias anteriores do ramo.');
    if (p.pp < def.cost) return fail(`Pontos de Pesquisa insuficientes (${p.pp}/${def.cost}).`);
    p.pp -= def.cost;
    p.techs.push(a.tech);
    this._log(i, `${p.name} pesquisou ${def.name}.`, 'tech');
    return ok();
  }

  _unlock(i, a) {
    const err = this._expandedTurn(i);
    if (err) return fail(err);
    const p = this.players[i];
    const def = WEAPONS[a.weapon];
    if (!def) return fail('Arma desconhecida.');
    if (p.weapons.includes(a.weapon)) return fail('Você já desbloqueou essa arma.');
    if (!def.reqW.every((r) => p.weapons.includes(r))) return fail('Desbloqueie antes as armas anteriores da linha.');
    if (!def.reqT.every((r) => p.techs.includes(r))) {
      return fail(`Requer tecnologia: ${def.reqT.filter((r) => !p.techs.includes(r)).map((r) => TECHS[r].name).join(', ')}.`);
    }
    if (p.pp < def.cost) return fail(`Pontos de Pesquisa insuficientes (${p.pp}/${def.cost}).`);
    p.pp -= def.cost;
    p.weapons.push(a.weapon);
    this._log(i, `${p.name} desbloqueou a arma ${def.name}.`, 'unlock');
    return ok();
  }

  _build(i, a) {
    const err = this._expandedTurn(i);
    if (err) return fail(err);
    const p = this.players[i];
    const def = WEAPONS[a.weapon];
    if (!def || !p.weapons.includes(a.weapon)) return fail('Você ainda não desbloqueou essa arma.');
    const t = this.terr[a.territory];
    if (!t || t.owner !== i) return fail('Escolha uma comunidade sua.');
    if (t.w) return fail('Essa comunidade já tem uma arma.');
    if (this.buff.built >= BUILDS_PER_TURN) return fail('Você já construiu uma arma neste turno.');
    if (t.armies - def.build < 1) return fail(`Precisa de ${def.build + 1} soldados na comunidade (${def.build} são gastos na construção).`);
    t.armies -= def.build;
    t.w = a.weapon;
    this.buff.built++;
    this._log(i, `${p.name} construiu ${def.name} em ${TERR_BY_ID[a.territory].name} (−${def.build} soldados).`, 'build', { to: a.territory });
    return ok();
  }

  _fire(i, a) {
    const err = this._expandedTurn(i);
    if (err) return fail(err);
    if (this.phase !== 'attack') return fail('Armas só disparam na fase de ataque.');
    const p = this.players[i];
    if (p.pool > 0) return fail('Distribua todos os soldados antes de disparar.');
    if (this._mustTrade(i)) return fail('Você tem 5 ou mais cartas: troque antes de continuar.');
    const f = this.terr[a.from];
    const t = this.terr[a.to];
    if (!f || !t || f.owner !== i) return fail('Escolha uma comunidade sua com arma.');
    const def = f.w && WEAPONS[f.w];
    if (!def || def.kind !== 'active') return fail('Essa comunidade não tem arma de disparo.');
    if (f.fired) return fail('Essa arma já disparou neste turno.');
    if (t.owner === i) return fail('Escolha um alvo rival.');
    if (DIST[a.from][a.to] > def.range) return fail(`Alvo fora de alcance (${def.range} fronteira${def.range > 1 ? 's' : ''}).`);
    if (this._truced(i, t.owner)) return fail('Trégua: esse jogador não pode ser atacado por você agora.');
    if (t.w === 'antiaereo') return fail(`O alvo tem ${WEAPONS.antiaereo.name} e é imune.`);
    const dmg = Math.min(def.dmg, t.armies - 1);
    if (dmg < 1) return fail('O alvo só tem 1 soldado: não pode ser atingido.');
    t.armies -= dmg;
    f.fired = true;
    this._log(i, `${p.name} disparou ${def.name} de ${TERR_BY_ID[a.from].name} em ${TERR_BY_ID[a.to].name} (${this._name(t.owner)}): ${dmg} baixa(s).`, 'fire', { from: a.from, to: a.to, n: dmg, def: t.owner });
    return ok();
  }

  _playCard(i, a) {
    const err = this._expandedTurn(i);
    if (err) return fail(err);
    const p = this.players[i];
    const idx = p.actionHand.findIndex((c) => c.id === a.card);
    if (idx < 0) return fail('Carta inválida.');
    const card = p.actionHand[idx];
    const def = ACTION_CARDS[card.type];
    if (!def.phases.includes(this.phase)) return fail('Essa carta não pode ser jogada nesta fase.');
    const targetPlayer = () => {
      const j = Math.floor(Number(a.player));
      const q = this.players[j];
      return q && j !== i && q.alive ? j : -1;
    };
    switch (card.type) {
      case 'reforco':
        p.pool += 3;
        this._log(i, `${p.name} jogou ${def.name}: +3 soldados.`, 'card');
        break;
      case 'pesquisa':
        p.pp += 4;
        this._log(i, `${p.name} jogou ${def.name}: +4 PP.`, 'card');
        break;
      case 'espionagem': {
        const j = targetPlayer();
        if (j < 0) return fail('Escolha um adversário.');
        p.intel.push({ player: j, text: this.players[j].objective.text });
        this._log(i, `${p.name} espionou ${this._name(j)}.`, 'spy');
        break;
      }
      case 'sabotagem': {
        const t = this.terr[a.territory];
        if (!t || t.owner === i) return fail('Escolha uma comunidade rival.');
        if (t.w === 'antiaereo') return fail(`O alvo tem ${WEAPONS.antiaereo.name} e é imune.`);
        const name = TERR_BY_ID[a.territory].name;
        if (t.w) {
          this._log(i, `${p.name} sabotou ${name}: ${WEAPONS[t.w].name} destruído!`, 'sabotage', { to: a.territory });
          t.w = null;
        } else if (t.armies > 1) {
          const lost = Math.min(2, t.armies - 1);
          t.armies -= lost;
          this._log(i, `${p.name} sabotou ${name} (${this._name(t.owner)}): ${lost} soldado(s) eliminado(s).`, 'sabotage', { to: a.territory });
        } else {
          return fail('Não há nada para sabotar nessa comunidade.');
        }
        break;
      }
      case 'cessar': {
        const j = targetPlayer();
        if (j < 0) return fail('Escolha um adversário.');
        if (!this._truced(j, i)) this.truces.push({ by: i, against: j });
        this._log(i, `${p.name} firmou trégua: ${this._name(j)} não pode atacá-lo até o próximo turno dele.`, 'truce');
        break;
      }
      case 'ofensiva':
        this.buff.ofensiva = true;
        this._log(i, `${p.name} declarou Ofensiva total neste turno!`, 'rage');
        break;
      case 'mobilizacao': {
        const f = this.terr[a.from];
        const t = this.terr[a.to];
        if (!f || !t || f.owner !== i || t.owner !== i || a.from === a.to) return fail('Escolha duas comunidades suas diferentes.');
        const n = Math.floor(Number(a.n));
        const movable = Math.min(f.armies - 1, f.armies - f.locked);
        if (!(n >= 1 && n <= movable)) return fail(movable > 0 ? `Você pode mover até ${movable} soldado(s) daqui.` : 'Não há soldados disponíveis para mover daqui.');
        f.armies -= n;
        t.armies += n;
        t.locked += n;
        this._log(i, `${p.name} mobilizou ${n} soldado(s) de ${TERR_BY_ID[a.from].name} para ${TERR_BY_ID[a.to].name}.`, 'move', { from: a.from, to: a.to, n });
        break;
      }
      default: return fail('Carta desconhecida.');
    }
    p.actionHand.splice(idx, 1);
    this.actionDiscard.push(card);
    return ok();
  }

  // Joga automaticamente por um jogador ausente (usado pelo anfitrião)
  autoPlay(i) {
    const p = this.players[i];
    if (!p || !p.alive || this.phase === 'over') return fail('Nada a fazer.');
    const dump = () => this._dumpPool(i);
    const announce = () => this._log(i, `${p.name} demorou: jogada automática.`, 'auto');
    if (this.phase === 'setup') {
      if (p.ready) return fail('Esse jogador já está pronto.');
      announce();
      dump();
      return this._ready(i);
    }
    if (!this._isTurn(i)) return fail('Não é a vez desse jogador.');
    announce();
    if (this.pendingMove) this._occupy(i, { n: this.pendingMove.min });
    if (this.phase === 'over') return ok();
    while (this._mustTrade(i)) {
      const set = findSet(p.cards);
      if (!set) break;
      this._trade(i, { cards: set });
    }
    dump();
    if (this.phase === 'reinforce') this._endReinforce(i);
    return this._endTurn(i);
  }

  // ---------- visão enviada aos clientes ----------

  view(i) {
    const over = this.phase === 'over';
    const me = this.players[i];
    const terr = {};
    TERR_IDS.forEach((id) => {
      const t = this.terr[id];
      terr[id] = { o: t.owner, a: t.armies, l: t.locked, w: t.w, f: t.fired };
    });
    return {
      expanded: this.expanded,
      truces: this.truces,
      buff: this.buff,
      actionDeckCount: this.actionDeck.length,
      phase: this.phase,
      turn: this.turn,
      round: this.round,
      maxRounds: this.maxRounds,
      winner: this.winner,
      endReason: this.endReason,
      players: this.players.map((p, idx) => ({
        idx,
        name: p.name,
        color: p.color,
        alive: p.alive,
        cards: p.cards.length,
        pool: p.pool,
        ready: p.ready,
        afk: p.afk,
        pp: p.pp,
        techs: p.techs,
        weapons: p.weapons,
        actionCards: p.actionHand.length,
        territories: this._ownedCount(idx),
        armies: this._armies(idx),
        score: this._score(idx),
        objective: over ? p.objective.text : undefined,
      })),
      terr,
      me: {
        idx: i,
        cards: me.cards,
        objective: me.objective.text,
        pool: me.pool,
        mustTrade: this._mustTrade(i),
        actionHand: me.actionHand,
        intel: me.intel,
      },
      pendingMove: this.turn === i ? this.pendingMove : null,
      pendingMoveInfo: this.pendingMove ? { to: this.pendingMove.to } : null,
      lastCombat: this.lastCombat,
      turnInfo: this.turnInfo,
      deckCount: this.deck.length,
      tradeCount: this.tradeCount,
      fortifiesLeft: Math.max(0, FORTIFY_PER_TURN - this.fortifies),
      nextTrade: this._nextTradeValue(),
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      log: this.log.slice(-60),
      logSeq: this.logSeq,
    };
  }
}

module.exports = { Game, isValidSet, findSet, TERR_IDS, DIST };
