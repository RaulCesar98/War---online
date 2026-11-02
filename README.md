# WAR · Facções

Jogo de estratégia estilo **WAR** para 2 a 10 jogadores, em tempo real, direto no navegador. Cada jogador comanda uma **facção** que disputa as **comunidades** de uma cidade fictícia. Servidor em Node.js + Express + Socket.IO. Não precisa de banco de dados nem de build.

> Os nomes das comunidades, regiões e facções são **fictícios**. Para trocar nomes, edite `server/data.js` (campos `name` e `faction`).

## Regras dentro do jogo

Há uma janela **📖 Regras** (na tela inicial, na sala e durante a partida) com abas: visão geral, seu turno (com exemplo de dados), cartas, objetivos, modo expandido e partida de 2 a 10 jogadores. Ela é montada a partir dos dados de `server/data.js`, então acompanha qualquer ajuste de regras.

## Rodar localmente

```bash
npm install
npm start
```

Abra http://localhost:3000, crie uma sala e compartilhe o código (ou o link de convite) com os amigos.

## Publicar no Render

1. Suba este projeto para um repositório no GitHub.
2. No Render: **New → Blueprint** (usa o `render.yaml`) **ou** **New → Web Service** com:
   - Build Command: `npm install --omit=dev`
   - Start Command: `npm start`
   - Health Check Path: `/healthz`
3. Pronto. O Render define a variável `PORT` automaticamente.

Observações:
- O estado das partidas fica **em memória**. Se o servidor reiniciar (deploy novo, ou o plano gratuito "dormir" por inatividade), as salas em andamento são perdidas.
- No plano gratuito o primeiro acesso após um período parado pode demorar ~1 minuto para acordar.
- Jogadores que caem ou atualizam a página voltam sozinhos para o mesmo lugar (a sessão fica salva no navegador). Se alguém sumir de vez, o anfitrião pode usar **"Jogar por ele"** para a partida continuar.

## Partidas rápidas

- **Duração (opção do anfitrião na sala):** Relâmpago (6 rodadas), **Rápida (10 rodadas, padrão)**, Longa (15 rodadas) ou Clássica (sem limite). Com limite, se ninguém cumprir o objetivo até o fim da última rodada, vence quem tiver mais **pontos 🏅**: 1 por comunidade + o bônus de cada região inteira dominada (desempate: mais soldados). Todos jogam o mesmo número de turnos; a última rodada é anunciada na tela.
- **Escalada:** a cada 3 rodadas todos ganham +1 soldado de reforço por turno (+1 na 3ª, +2 na 6ª…).
- **Trocas de cartas mais valiosas:** 6, 8, 10, 12, 15, 20 e depois +5.
- **Menos cliques:** "⚡ Distribuir automaticamente" na preparação e no reforço; ao distribuir tudo na preparação você fica pronto; no reforço o jogo passa sozinho para o ataque (se não houver troca de cartas possível nem carta de Reforço na mão); a ocupação é automática quando só há uma quantidade possível, e "Mover tudo"/"Mover o mínimo" ocupam com um clique; usados os 3 remanejamentos, o turno passa sozinho.

## Tempo de jogo, sons e animações

- **Relógio:** cada fase tem seu tempo: **preparação 40 s, reforço 30 s, ataque 45 s, remanejamento 20 s** (ajuste em `PHASE_SECONDS`, em `server/data.js`), com contagem regressiva na tela (amarela aos 20 s, vermelha e com "tiques" nos últimos 10 s).
- **Jogada automática:** se o tempo acabar, o servidor joga por quem não agiu: distribui os reforços nas comunidades de fronteira (começando pelas mais fracas), troca cartas se for obrigatório, resolve uma ocupação pendente e encerra o turno **sem atacar**.
- **Ausente:** quem estoura o tempo fica marcado como *ausente*; nos turnos seguintes o jogo joga por essa pessoa após ~6 s, até ela clicar em **Voltei** ou jogar por conta própria. Jogadores desconectados são jogados automaticamente após ~3 s.
- **Sons:** efeitos sintetizados no navegador (WebAudio), sem arquivos de áudio: cliques, reforços, dados, golpes, conquista, tecnologia, armas, cartas, vitória, fim de tempo e mais. O botão 🔊 no canto inferior esquerdo liga/desliga e lembra a escolha.
- **Animações:** números de soldados que sobem/descem sobre as comunidades, anéis na conquista, projéteis nos ataques e disparos, tremor nos alvos, cartas entrando na mão, relógio pulsando e confete na vitória. Respeita a preferência do sistema por *menos movimento*.
- Variáveis opcionais do servidor (úteis em testes): `TURN_SECONDS` (só pode diminuir o limite de 60), `AFK_DELAY_MS` e `AFK_GRACE_MS`.

## Regras

**A cidade:** 42 comunidades em 6 regiões. Bônus de reforço por região inteira dominada: Zona Oeste 7, Zona Norte 5, Centro 5, Baixada 3, Zona Sul 2, Litoral 2.

**Facções (até 10 jogadores):** Falange Azul, Legião Amarela, Comando Rubro, Sindicato Negro, Ordem Branca, Irmandade Verde, Aliança Laranja, Frente Roxa, Rede Rosa e Guarda Ciano (atribuídas por ordem de entrada na sala).

**Preparação:** as comunidades são sorteadas com 1 soldado cada; cada jogador distribui o restante dos seus soldados iniciais (total por jogador de 40/35/30/25/20/18/16/15/14 para 2/3/4/5/6/7/8/9/10 jogadores, contando os já posicionados) ao mesmo tempo.

**Turno:**
1. **Reforço:** comunidades ÷ 2 (mínimo 3) + bônus de regiões + escalada (+1 a cada 3 rodadas) + troca de cartas.
2. **Ataque:** o atacante rola até 3 dados (deixa sempre 1 soldado), o defensor rola até 3 dados (um por soldado). Comparação dos maiores dados em pares; **empate favorece a defesa**. Ao dominar, move-se no mínimo o número de dados rolados.
3. **Remanejamento:** mover entre comunidades vizinhas suas; soldados que acabaram de chegar não se movem de novo no turno.

**Cartas de comunidade:** 42 cartas (▲ ■ ●) + 2 coringas. Quem domina ao menos 1 comunidade no turno ganha 1 carta. Troca de 3 iguais ou 3 diferentes (coringa vale por qualquer um) por 6, 8, 10, 12, 15, 20 e depois +5 soldados (sequência global). Cada carta de uma comunidade sua na troca dá +2 soldados nela. Com 5+ cartas a troca é obrigatória. Eliminar uma facção dá as cartas dela.

**Objetivos (18 cartas, secretas):** dominar Zona Oeste + Zona Sul; Zona Oeste + Baixada; Zona Norte + Baixada; Zona Norte + Litoral; Centro + Zona Sul + 1 região à escolha; Centro + Litoral + 1 região à escolha; 18 comunidades com 2+ soldados cada; 24 comunidades; ou destruir uma das 10 facções (se ela não está na partida, é a sua, ou outro jogador a elimina primeiro, o objetivo vira "24 comunidades"). Vence quem cumprir o objetivo durante o seu turno, ou a última facção restante, ou (com limite de rodadas) quem tiver mais pontos ao fim da última rodada.

## Modo expandido (opcional)

O anfitrião escolhe na sala (caixa "Modo expandido", ligada por padrão). Desligado, o jogo segue as regras acima.

**Pontos de Pesquisa (PP):** no início do turno, 2 PP + 1 a cada 6 comunidades + 1 por região completa. Acumulam entre turnos.

**Árvore de Tecnologia** (bônus permanentes; cada nó exige o anterior do ramo):

| Ramo | Nível 1 | Nível 2 | Nível 3 |
|---|---|---|---|
| 🛵 Logística | Recrutamento (3 PP): +1 reforço/turno | Rede de becos (5): remanejar entre comunidades suas conectadas | Caixa da facção (8): +2 reforço e +1 PP/turno |
| ⚔️ Ofensiva | Tática de invasão (3): empate no 2º/3º par favorece o atacante | Ocupação relâmpago (5): +1 soldado grátis ao dominar | Guerra total (9): empate em qualquer par favorece o atacante |
| 🛡️ Defesa | Muros e becos (3): defendendo com 3 dados, o menor ganha +1 | Vigias (5): +1 soldado na comunidade mais fraca por turno | Comunidade blindada (8): o defensor perde no máximo 1 soldado por rolagem |
| 📡 Inteligência | Olheiros (3): +1 carta de ação/turno | Central de planejamento (5): +2 PP/turno | Rádio comunitária (7): troca de cartas rende +2 soldados |

**Árvore de Arsenal:** desbloqueie com PP (algumas armas exigem tecnologias) e **construa nas comunidades** gastando soldados (1 construção por turno, 1 arma por comunidade; a arma é destruída se a comunidade for dominada).

| Linha | Arma | PP | Construção | Efeito |
|---|---|---|---|---|
| Poder de fogo | 💥 Armamento leve | 3 | 2 | Atacando daqui, o maior dado ganha +1 |
| Poder de fogo | 🎯 Atiradores de elite | 5 | 3 | 1 disparo/turno em vizinha rival: 1 baixa (sobra 1) |
| Poder de fogo | 🛸 Drones (req. Central de planejamento) | 8 | 4 | 1 disparo/turno a até 2 fronteiras: 2 baixas (sobra 1) |
| Defesa | 🧱 Barricadas | 3 | 2 | Defendendo aqui, o maior dado ganha +1 |
| Defesa | 📡 Rede de olheiros (req. Muros e becos) | 5 | 2 | Imune a atiradores, drones e sabotagem |
| Veículos e mobilidade | 🚙 Veículos blindados (req. Tática de invasão) | 4 | 3 | Atacando daqui com 3 dados, empate no maior par favorece o atacante |
| Veículos e mobilidade | 🏍️ Motoqueiros (req. Rede de becos) | 6 | 3 | Ataca rivais a até 2 fronteiras |

**Cartas de ação** (segundo baralho de 22 cartas; compra 1 por turno, máx. 5 na mão, jogadas no seu turno): 📦 Reforço (+3 soldados), 🧪 Pesquisa acelerada (+4 PP), 🕵️ Olheiro infiltrado (revela o objetivo de um rival só para você), 🧯 Sabotagem (destrói a arma de uma comunidade rival ou remove 2 soldados), 🕊️ Trégua (uma facção não pode atacar você até o seu próximo turno), 🔥 Ofensiva total (empates no maior par favorecem você no turno), 🛵 Mobilização (move soldados entre duas comunidades suas quaisquer).

Para ajustar o equilíbrio, edite as tabelas `TECHS`, `WEAPONS` e `ACTION_CARDS` em `server/data.js` (custos, textos, quantidade de cada carta); os efeitos em si estão em `server/game.js`.

## Testes

```bash
npm test                 # valida o mapa e simula 90 partidas completas (2 a 10 jogadores)
npm run test:timer       # relógio de fase e jogada automática (sobe servidores de teste sozinho)
npm start                # em outro terminal:
node test/e2e.js         # teste multiplayer ponta a ponta via Socket.IO (inclui sala de 10 jogadores)
```

## Estrutura

```
server/data.js    comunidades, regiões, facções, objetivos, árvores e cartas
server/game.js    motor de regras (toda a lógica fica no servidor)
server/index.js   Express + Socket.IO (salas, reconexão, chat)
public/           interface (HTML, CSS, JS puro)
test/             simulação do motor e teste ponta a ponta
```
