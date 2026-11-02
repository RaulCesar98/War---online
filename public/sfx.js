// Efeitos sonoros sintetizados com WebAudio (sem arquivos de áudio).
// API: SFX.play(nome), SFX.setMuted(bool), SFX.isMuted().
(function () {
  'use strict';

  let ctx = null;
  let master = null;
  let noiseBuf = null;
  let muted = false;
  const lastPlayed = {};
  try { muted = localStorage.getItem('war.mute') === '1'; } catch { /* ignora */ }

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.55;
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp);
      comp.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function noiseBuffer() {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }

  // nota: frequência f, duração dur (s); to = frequência final (glissando); at = atraso (s)
  function tone(f, dur, o = {}) {
    const { type = 'sine', vol = 0.25, at = 0, to = null, attack = 0.004 } = o;
    const t0 = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  // ruído filtrado (impactos, sopros, estalos)
  function noise(dur, o = {}) {
    const { vol = 0.25, at = 0, type = 'lowpass', freq = 1200, to = null, q = 0.8 } = o;
    const t0 = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer();
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.Q.value = q;
    filt.frequency.setValueAtTime(freq, t0);
    if (to) filt.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt);
    filt.connect(g);
    g.connect(master);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + dur + 0.03);
  }

  const arp = (notes, step, o) => notes.forEach((f, i) => tone(f, o.dur || 0.2, { ...o, at: (o.at || 0) + i * step }));

  const SOUNDS = {
    click: () => tone(1100, 0.04, { type: 'square', vol: 0.05 }),
    select: () => tone(520, 0.07, { vol: 0.18, to: 780 }),
    place: () => { tone(280, 0.09, { vol: 0.28, to: 520 }); noise(0.05, { vol: 0.08, type: 'highpass', freq: 3000 }); },
    error: () => { tone(170, 0.16, { type: 'sawtooth', vol: 0.16, to: 110 }); tone(130, 0.2, { type: 'sawtooth', vol: 0.12, at: 0.09, to: 90 }); },
    dice: () => {
      for (let i = 0; i < 7; i++) {
        noise(0.045, { vol: 0.22, type: 'bandpass', freq: 1800 + Math.random() * 1800, at: i * 0.055, q: 3 });
        tone(300 + Math.random() * 300, 0.03, { type: 'square', vol: 0.04, at: i * 0.055 });
      }
    },
    hit: () => { tone(150, 0.16, { type: 'triangle', vol: 0.4, to: 60 }); noise(0.12, { vol: 0.3, freq: 1500, to: 200 }); },
    conquer: () => arp([392, 494, 587, 784], 0.09, { type: 'triangle', vol: 0.28, dur: 0.26 }),
    turn: () => { tone(880, 0.22, { vol: 0.3 }); tone(1320, 0.34, { vol: 0.26, at: 0.12 }); },
    phase: () => tone(660, 0.09, { vol: 0.12, to: 760 }),
    draw: () => { noise(0.18, { type: 'highpass', freq: 800, to: 4000, vol: 0.14 }); tone(1400, 0.2, { vol: 0.12, at: 0.12 }); },
    trade: () => { tone(1568, 0.12, { type: 'triangle', vol: 0.25 }); tone(2093, 0.2, { type: 'triangle', vol: 0.22, at: 0.09 }); tone(1568, 0.1, { vol: 0.1, at: 0.2 }); },
    build: () => [0, 0.16].forEach((at) => { noise(0.1, { vol: 0.35, freq: 900, to: 150, at }); tone(900, 0.14, { type: 'square', vol: 0.07, at, to: 600 }); }),
    fire: () => {
      noise(0.35, { type: 'bandpass', freq: 300, to: 2500, vol: 0.2, q: 1 });
      noise(0.6, { vol: 0.5, freq: 1000, to: 60, at: 0.32 });
      tone(90, 0.55, { vol: 0.45, at: 0.32, to: 35 });
    },
    tech: () => arp([659, 784, 988, 1319], 0.06, { type: 'triangle', vol: 0.2, dur: 0.2 }),
    sabotage: () => { noise(0.4, { type: 'bandpass', freq: 2500, to: 600, vol: 0.2, q: 2 }); tone(420, 0.35, { type: 'sawtooth', vol: 0.14, to: 80 }); },
    truce: () => { tone(523, 0.35, { vol: 0.22 }); tone(659, 0.4, { vol: 0.2, at: 0.14 }); tone(784, 0.5, { vol: 0.18, at: 0.28 }); },
    rage: () => { tone(110, 0.55, { type: 'sawtooth', vol: 0.22, to: 220 }); noise(0.5, { vol: 0.12, freq: 400, to: 1800 }); },
    spy: () => { tone(1800, 0.05, { vol: 0.12 }); tone(1500, 0.05, { vol: 0.12, at: 0.1 }); tone(2100, 0.08, { vol: 0.1, at: 0.2 }); },
    eliminate: () => arp([392, 330, 277, 196], 0.14, { type: 'sawtooth', vol: 0.18, dur: 0.32 }),
    win: () => arp([523, 659, 784, 1047, 784, 1047, 1319], 0.13, { type: 'triangle', vol: 0.3, dur: 0.34 }),
    lose: () => arp([440, 392, 349, 262], 0.2, { type: 'triangle', vol: 0.25, dur: 0.5 }),
    tick: () => tone(1000, 0.05, { type: 'square', vol: 0.06 }),
    tickUrgent: () => tone(1500, 0.07, { type: 'square', vol: 0.12 }),
    timeout: () => { tone(200, 0.3, { type: 'sawtooth', vol: 0.22, to: 120 }); tone(150, 0.35, { type: 'sawtooth', vol: 0.2, at: 0.16, to: 90 }); },
    ready: () => tone(988, 0.16, { vol: 0.2, to: 1319 }),
    start: () => {
      [0, 0.22, 0.44].forEach((at) => { tone(75, 0.3, { vol: 0.55, at, to: 45 }); noise(0.1, { vol: 0.2, freq: 400, at }); });
      tone(196, 0.6, { type: 'triangle', vol: 0.18, at: 0.66 });
      tone(392, 0.7, { type: 'triangle', vol: 0.18, at: 0.66 });
    },
    move: () => noise(0.22, { type: 'bandpass', freq: 500, to: 2200, vol: 0.18, q: 1.2 }),
    chat: () => tone(760, 0.08, { vol: 0.14, to: 980 }),
  };

  window.SFX = {
    play(name) {
      if (muted) return;
      if (!ensure()) return;
      const now = performance.now();
      if (lastPlayed[name] && now - lastPlayed[name] < 45) return; // evita rajadas do mesmo som
      lastPlayed[name] = now;
      const fn = SOUNDS[name];
      if (fn) { try { fn(); } catch { /* ignora */ } }
    },
    isMuted: () => muted,
    setMuted(v) {
      muted = !!v;
      try { localStorage.setItem('war.mute', muted ? '1' : '0'); } catch { /* ignora */ }
    },
  };

  // navegadores só liberam o áudio depois de um gesto do usuário
  ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, ensure, { passive: true }));
})();
