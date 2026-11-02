'use strict';

// Regiões da cidade e bônus de soldados por região dominada (ids internos: AN, AS, EU, AF, AI, OC)
const CONTINENTS = {
  AN: { name: 'Zona Norte', bonus: 5, color: '#e08a3c' },
  AS: { name: 'Zona Sul', bonus: 2, color: '#d9534f' },
  EU: { name: 'Centro', bonus: 5, color: '#4f8ad9' },
  AF: { name: 'Baixada', bonus: 3, color: '#b5873a' },
  AI: { name: 'Zona Oeste', bonus: 7, color: '#3fa86b' },
  OC: { name: 'Litoral', bonus: 2, color: '#a15fd0' },
};

// 42 comunidades. x/y são posições no mapa (viewBox 1000x600)
const TERRITORIES = [
  // Zona Norte (9)
  { id: 'alasca', name: 'Morro do Corvo', continent: 'AN', x: 70, y: 95 },
  { id: 'mackenzie', name: 'Vila Esperança', continent: 'AN', x: 160, y: 85 },
  { id: 'groenlandia', name: 'Alto da Serra', continent: 'AN', x: 340, y: 55 },
  { id: 'vancouver', name: 'Beco do Sol', continent: 'AN', x: 130, y: 165 },
  { id: 'ottawa', name: 'Vila Operária', continent: 'AN', x: 225, y: 155 },
  { id: 'labrador', name: 'Jardim das Pedras', continent: 'AN', x: 310, y: 135 },
  { id: 'california', name: 'Rio Seco', continent: 'AN', x: 115, y: 245 },
  { id: 'novayork', name: 'Cidade Velha', continent: 'AN', x: 215, y: 240 },
  { id: 'mexico', name: 'Boa Vista', continent: 'AN', x: 155, y: 325 },
  // Zona Sul (4)
  { id: 'colombia', name: 'Ladeira do Mirante', continent: 'AS', x: 205, y: 400 },
  { id: 'peru', name: 'Vila Beira-Mar', continent: 'AS', x: 180, y: 480 },
  { id: 'brasil', name: 'Morro Azul', continent: 'AS', x: 275, y: 460 },
  { id: 'argentina', name: 'Beco da Lagoa', continent: 'AS', x: 215, y: 555 },
  // Centro (7)
  { id: 'islandia', name: 'Cortiço do Largo', continent: 'EU', x: 430, y: 95 },
  { id: 'inglaterra', name: 'Vila Ferroviária', continent: 'EU', x: 445, y: 175 },
  { id: 'suecia', name: 'Morro da Estação', continent: 'EU', x: 520, y: 105 },
  { id: 'moscou', name: 'Dois Irmãos', continent: 'EU', x: 620, y: 115 },
  { id: 'alemanha', name: 'Vila Mercado', continent: 'EU', x: 510, y: 190 },
  { id: 'polonia', name: 'Rua da Feira', continent: 'EU', x: 590, y: 205 },
  { id: 'portugal', name: 'Travessa do Porto', continent: 'EU', x: 460, y: 260 },
  // Baixada (6)
  { id: 'argelia', name: 'Vila Pântano', continent: 'AF', x: 470, y: 345 },
  { id: 'egito', name: 'Beco do Valão', continent: 'AF', x: 565, y: 335 },
  { id: 'sudao', name: 'Jardim Poeira', continent: 'AF', x: 590, y: 415 },
  { id: 'congo', name: 'Vila Matadouro', continent: 'AF', x: 525, y: 470 },
  { id: 'africadosul', name: 'Conjunto Pedreira', continent: 'AF', x: 545, y: 545 },
  { id: 'madagascar', name: 'Ilha da Maré', continent: 'AF', x: 645, y: 520 },
  // Zona Oeste (12)
  { id: 'orientemedio', name: 'Vila Colina', continent: 'AI', x: 665, y: 290 },
  { id: 'aral', name: 'Rio das Cobras', continent: 'AI', x: 690, y: 185 },
  { id: 'omsk', name: 'Morro do Cruzeiro', continent: 'AI', x: 765, y: 145 },
  { id: 'dudinka', name: 'Sertãozinho', continent: 'AI', x: 815, y: 70 },
  { id: 'siberia', name: 'Nova Aurora', continent: 'AI', x: 890, y: 105 },
  { id: 'tchita', name: 'Pedra do Gato', continent: 'AI', x: 880, y: 185 },
  { id: 'mongolia', name: 'Morro da Antena', continent: 'AI', x: 810, y: 205 },
  { id: 'vladivostok', name: 'Praia dos Pescadores', continent: 'AI', x: 950, y: 150 },
  { id: 'japao', name: 'Cais do Pescador', continent: 'AI', x: 950, y: 255 },
  { id: 'china', name: 'Vila Gigante', continent: 'AI', x: 815, y: 285 },
  { id: 'india', name: 'Favela do Buraco', continent: 'AI', x: 745, y: 350 },
  { id: 'vietna', name: 'Beco da Mata', continent: 'AI', x: 850, y: 365 },
  // Litoral (4)
  { id: 'sumatra', name: 'Ilha da Cruz', continent: 'OC', x: 790, y: 460 },
  { id: 'borneu', name: 'Morro do Farol', continent: 'OC', x: 875, y: 450 },
  { id: 'novaguine', name: 'Vila das Palafitas', continent: 'OC', x: 940, y: 500 },
  { id: 'australia', name: 'Ponta do Mangue', continent: 'OC', x: 860, y: 545 },
];

// Fronteiras (bidirecionais)
const EDGES = [
  // Zona Norte
  ['alasca', 'mackenzie'], ['alasca', 'vancouver'], ['mackenzie', 'vancouver'],
  ['mackenzie', 'ottawa'], ['mackenzie', 'groenlandia'], ['vancouver', 'ottawa'],
  ['vancouver', 'california'], ['ottawa', 'labrador'], ['ottawa', 'novayork'],
  ['ottawa', 'california'], ['ottawa', 'groenlandia'], ['labrador', 'groenlandia'],
  ['labrador', 'novayork'], ['california', 'novayork'], ['california', 'mexico'],
  ['novayork', 'mexico'],
  // Zona Sul
  ['colombia', 'peru'], ['colombia', 'brasil'], ['peru', 'brasil'],
  ['peru', 'argentina'], ['brasil', 'argentina'],
  // Centro
  ['islandia', 'inglaterra'], ['islandia', 'suecia'], ['inglaterra', 'suecia'],
  ['inglaterra', 'alemanha'], ['inglaterra', 'portugal'], ['suecia', 'moscou'],
  ['suecia', 'alemanha'], ['alemanha', 'polonia'], ['alemanha', 'portugal'],
  ['polonia', 'moscou'], ['polonia', 'portugal'],
  // Baixada
  ['argelia', 'egito'], ['argelia', 'sudao'], ['argelia', 'congo'],
  ['egito', 'sudao'], ['sudao', 'congo'], ['sudao', 'africadosul'],
  ['sudao', 'madagascar'], ['congo', 'africadosul'], ['africadosul', 'madagascar'],
  // Zona Oeste
  ['aral', 'omsk'], ['aral', 'china'], ['aral', 'india'], ['aral', 'orientemedio'],
  ['omsk', 'dudinka'], ['omsk', 'mongolia'], ['omsk', 'china'],
  ['dudinka', 'siberia'], ['dudinka', 'tchita'], ['dudinka', 'mongolia'],
  ['siberia', 'tchita'], ['siberia', 'vladivostok'], ['tchita', 'vladivostok'],
  ['tchita', 'mongolia'], ['tchita', 'china'], ['mongolia', 'china'],
  ['mongolia', 'japao'], ['mongolia', 'vladivostok'], ['vladivostok', 'japao'],
  ['china', 'india'], ['china', 'vietna'], ['india', 'orientemedio'], ['india', 'vietna'],
  // Litoral
  ['sumatra', 'borneu'], ['sumatra', 'australia'], ['borneu', 'novaguine'],
  ['borneu', 'australia'], ['novaguine', 'australia'],
  // Ligações entre regiões
  ['alasca', 'vladivostok'], ['groenlandia', 'islandia'], ['mexico', 'colombia'],
  ['brasil', 'argelia'], ['portugal', 'argelia'], ['polonia', 'egito'],
  ['polonia', 'orientemedio'], ['moscou', 'aral'], ['moscou', 'orientemedio'],
  ['egito', 'orientemedio'], ['vietna', 'sumatra'],
];

const ADJ = {};
TERRITORIES.forEach((t) => { ADJ[t.id] = []; });
EDGES.forEach(([a, b]) => { ADJ[a].push(b); ADJ[b].push(a); });

// Facções (a ordem define o índice de cor/facção do jogador)
const COLORS = [
  { id: 'azul', name: 'Azul', faction: 'Falange Azul', hex: '#2f6fdb', text: '#ffffff' },
  { id: 'amarelo', name: 'Amarelo', faction: 'Legião Amarela', hex: '#e8c21a', text: '#1b1b1b' },
  { id: 'vermelho', name: 'Vermelho', faction: 'Comando Rubro', hex: '#d93a3a', text: '#ffffff' },
  { id: 'preto', name: 'Preto', faction: 'Sindicato Negro', hex: '#2b2b2b', text: '#ffffff' },
  { id: 'branco', name: 'Branco', faction: 'Ordem Branca', hex: '#f1f1f1', text: '#1b1b1b' },
  { id: 'verde', name: 'Verde', faction: 'Irmandade Verde', hex: '#2fa34f', text: '#ffffff' },
  { id: 'laranja', name: 'Laranja', faction: 'Aliança Laranja', hex: '#f08a24', text: '#1b1b1b' },
  { id: 'roxo', name: 'Roxo', faction: 'Frente Roxa', hex: '#8e4fd0', text: '#ffffff' },
  { id: 'rosa', name: 'Rosa', faction: 'Rede Rosa', hex: '#f06fb0', text: '#1b1b1b' },
  { id: 'ciano', name: 'Ciano', faction: 'Guarda Ciano', hex: '#22bfd1', text: '#1b1b1b' },
];
const MAX_PLAYERS = COLORS.length; // uma facção por jogador (até 10)

// 14 cartas de objetivo
const OBJECTIVES = [
  { id: 'AI_AS', type: 'continents', required: ['AI', 'AS'], extra: 0 },
  { id: 'AI_AF', type: 'continents', required: ['AI', 'AF'], extra: 0 },
  { id: 'AN_AF', type: 'continents', required: ['AN', 'AF'], extra: 0 },
  { id: 'AN_OC', type: 'continents', required: ['AN', 'OC'], extra: 0 },
  { id: 'EU_AS_X', type: 'continents', required: ['EU', 'AS'], extra: 1 },
  { id: 'EU_OC_X', type: 'continents', required: ['EU', 'OC'], extra: 1 },
  { id: 'T18x2', type: 'territories', n: 18, minArmies: 2 },
  { id: 'T24', type: 'territories', n: 24, minArmies: 1 },
  { id: 'D_azul', type: 'destroy', color: 0 },
  { id: 'D_amarelo', type: 'destroy', color: 1 },
  { id: 'D_vermelho', type: 'destroy', color: 2 },
  { id: 'D_preto', type: 'destroy', color: 3 },
  { id: 'D_branco', type: 'destroy', color: 4 },
  { id: 'D_verde', type: 'destroy', color: 5 },
  { id: 'D_laranja', type: 'destroy', color: 6 },
  { id: 'D_roxo', type: 'destroy', color: 7 },
  { id: 'D_rosa', type: 'destroy', color: 8 },
  { id: 'D_ciano', type: 'destroy', color: 9 },
];

// Cartas de comunidade: símbolos e coringas
const SYMBOLS = ['triangulo', 'quadrado', 'circulo'];
// total de soldados de cada jogador no início (contando 1 por comunidade já sorteada)
const TOTAL_ARMIES = { 2: 40, 3: 35, 4: 30, 5: 25, 6: 20, 7: 18, 8: 16, 9: 15, 10: 14 };
const TRADE_SEQ = [6, 8, 10, 12, 15, 20]; // depois disso: +5 a cada troca

// ---------- ritmo da partida ----------
// Tempo máximo de cada fase, em segundos (TURN_SECONDS no servidor só pode diminuir)
const PHASE_SECONDS = { setup: 40, reinforce: 30, attack: 45, fortify: 20 };
// Duração escolhida na sala (0 = sem limite). Ao fim da última rodada vence quem tiver mais pontos.
const ROUND_OPTIONS = [
  { rounds: 6, name: 'Relâmpago', desc: '6 rodadas' },
  { rounds: 10, name: 'Rápida', desc: '10 rodadas' },
  { rounds: 15, name: 'Longa', desc: '15 rodadas' },
  { rounds: 0, name: 'Clássica', desc: 'sem limite de rodadas' },
];
const DEFAULT_ROUNDS = 10;
const ESCALATION_EVERY = 3; // escalada: +1 soldado de reforço para todos a cada 3 rodadas

// ======================= MODO EXPANDIDO =======================

const PP_BASE = 2; // Pontos de Pesquisa base por turno
const ACTION_HAND_MAX = 5;
const BUILDS_PER_TURN = 1;
const FORTIFY_PER_TURN = 3; // remanejamentos permitidos por turno (a carta Mobilização não conta)

// Ramos da árvore de tecnologia
const BRANCHES = {
  logistica: { name: 'Logística', icon: '🛵' },
  ofensiva: { name: 'Ofensiva', icon: '⚔️' },
  defesa: { name: 'Defesa', icon: '🛡️' },
  inteligencia: { name: 'Inteligência', icon: '📡' },
};

// Árvore de tecnologia: bônus permanentes comprados com Pontos de Pesquisa (PP)
const TECHS = {
  intendencia: { branch: 'logistica', tier: 1, name: 'Recrutamento', cost: 3, req: [], desc: '+1 soldado de reforço por turno.' },
  ferrovias: { branch: 'logistica', tier: 2, name: 'Rede de becos', cost: 5, req: ['intendencia'], desc: 'O remanejamento liga quaisquer comunidades suas conectadas por um caminho de comunidades suas.' },
  industria: { branch: 'logistica', tier: 3, name: 'Caixa da facção', cost: 8, req: ['ferrovias'], desc: '+2 soldados de reforço e +1 PP por turno.' },
  assalto: { branch: 'ofensiva', tier: 1, name: 'Tática de invasão', cost: 3, req: [], desc: 'Empates no 2º e 3º pares de dados favorecem o atacante.' },
  blitzkrieg: { branch: 'ofensiva', tier: 2, name: 'Ocupação relâmpago', cost: 5, req: ['assalto'], desc: 'Toda comunidade dominada recebe +1 soldado grátis.' },
  guerra_total: { branch: 'ofensiva', tier: 3, name: 'Guerra total', cost: 9, req: ['blitzkrieg'], desc: 'Empates em qualquer par de dados favorecem o atacante.' },
  trincheiras: { branch: 'defesa', tier: 1, name: 'Muros e becos', cost: 3, req: [], desc: 'Ao defender com 3 dados, o menor dado ganha +1.' },
  guarnicoes: { branch: 'defesa', tier: 2, name: 'Vigias', cost: 5, req: ['trincheiras'], desc: 'No início do seu turno, +1 soldado na sua comunidade mais fraca.' },
  muralha: { branch: 'defesa', tier: 3, name: 'Comunidade blindada', cost: 8, req: ['guarnicoes'], desc: 'Se o defensor perderia 2 soldados numa rolagem, perde apenas 1.' },
  agentes: { branch: 'inteligencia', tier: 1, name: 'Olheiros', cost: 3, req: [], desc: 'Compra 1 carta de ação extra por turno.' },
  laboratorios: { branch: 'inteligencia', tier: 2, name: 'Central de planejamento', cost: 5, req: ['agentes'], desc: '+2 PP por turno.' },
  propaganda: { branch: 'inteligencia', tier: 3, name: 'Rádio comunitária', cost: 7, req: ['laboratorios'], desc: 'Cada troca de cartas de comunidade rende +2 soldados.' },
};

const WEAPON_LINES = {
  artilharia: { name: 'Poder de fogo', icon: '💥' },
  defesa: { name: 'Defesa', icon: '🧱' },
  mobilidade: { name: 'Veículos e mobilidade', icon: '🏍️' },
};

// Árvore de armas: desbloqueie com PP e construa em comunidades gastando soldados.
// Cada comunidade comporta uma arma, que é destruída se a comunidade for dominada.
// (os ids são internos e usados pelo motor; os nomes aparecem no jogo)
const WEAPONS = {
  canhao: { line: 'artilharia', tier: 1, name: 'Armamento leve', icon: '💥', cost: 3, build: 2, reqW: [], reqT: [], kind: 'passive', desc: 'Ao atacar a partir daqui, seu maior dado ganha +1.' },
  obus: { line: 'artilharia', tier: 2, name: 'Atiradores de elite', icon: '🎯', cost: 5, build: 3, reqW: ['canhao'], reqT: [], kind: 'active', range: 1, dmg: 1, desc: 'Uma vez por turno: atinge uma comunidade vizinha rival, causando 1 baixa (sempre sobra 1 soldado).' },
  missil: { line: 'artilharia', tier: 3, name: 'Drones', icon: '🛸', cost: 8, build: 4, reqW: ['obus'], reqT: ['laboratorios'], kind: 'active', range: 2, dmg: 2, desc: 'Uma vez por turno: atinge uma rival a até 2 fronteiras, causando 2 baixas (sempre sobra 1 soldado).' },
  bunker: { line: 'defesa', tier: 1, name: 'Barricadas', icon: '🧱', cost: 3, build: 2, reqW: [], reqT: [], kind: 'passive', desc: 'Ao defender aqui, seu maior dado ganha +1.' },
  antiaereo: { line: 'defesa', tier: 2, name: 'Rede de olheiros', icon: '📡', cost: 5, build: 2, reqW: ['bunker'], reqT: ['trincheiras'], kind: 'passive', desc: 'Esta comunidade é imune a atiradores, drones e sabotagem.' },
  tanques: { line: 'mobilidade', tier: 1, name: 'Veículos blindados', icon: '🚙', cost: 4, build: 3, reqW: [], reqT: ['assalto'], kind: 'passive', desc: 'Ao atacar daqui com 3 dados, empate no maior par favorece o atacante.' },
  caca: { line: 'mobilidade', tier: 2, name: 'Motoqueiros', icon: '🏍️', cost: 6, build: 3, reqW: ['tanques'], reqT: ['ferrovias'], kind: 'passive', desc: 'Esta comunidade pode atacar rivais a até 2 fronteiras de distância.' },
};

// Cartas de ação (segundo baralho): uma é comprada no início de cada turno
const ACTION_CARDS = {
  reforco: { name: 'Reforço', icon: '📦', count: 4, target: 'none', phases: ['reinforce'], desc: '+3 soldados para distribuir (só na fase de reforço).' },
  pesquisa: { name: 'Pesquisa acelerada', icon: '🧪', count: 3, target: 'none', phases: ['reinforce', 'attack', 'fortify'], desc: '+4 Pontos de Pesquisa.' },
  espionagem: { name: 'Olheiro infiltrado', icon: '🕵️', count: 3, target: 'player', phases: ['reinforce', 'attack', 'fortify'], desc: 'Descubra, em segredo, o objetivo de uma facção rival.' },
  sabotagem: { name: 'Sabotagem', icon: '🧯', count: 3, target: 'territory', phases: ['reinforce', 'attack', 'fortify'], desc: 'Destrói a arma de uma comunidade rival; sem arma, remove 2 soldados (sobra 1).' },
  cessar: { name: 'Trégua', icon: '🕊️', count: 3, target: 'player', phases: ['reinforce', 'attack', 'fortify'], desc: 'A facção escolhida não pode atacar você até o início do seu próximo turno.' },
  ofensiva: { name: 'Ofensiva total', icon: '🔥', count: 3, target: 'none', phases: ['attack'], desc: 'Neste turno, empates no maior par de dados favorecem você.' },
  mobilizacao: { name: 'Mobilização', icon: '🛵', count: 3, target: 'move', phases: ['attack', 'fortify'], desc: 'Mova soldados entre duas comunidades suas quaisquer, mesmo distantes.' },
};

module.exports = {
  CONTINENTS, TERRITORIES, EDGES, ADJ, COLORS, MAX_PLAYERS, OBJECTIVES, SYMBOLS, TOTAL_ARMIES, TRADE_SEQ,
  PHASE_SECONDS, ROUND_OPTIONS, DEFAULT_ROUNDS, ESCALATION_EVERY,
  PP_BASE, ACTION_HAND_MAX, BUILDS_PER_TURN, FORTIFY_PER_TURN, BRANCHES, TECHS, WEAPON_LINES, WEAPONS, ACTION_CARDS,
};
