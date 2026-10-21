// The sign-in hero: three house Forklings in a moonlit meadow. They potter about on
// their own; when the sign-in button is hovered or focused they look over and hop, and
// a tap on one makes it hop with a heart. With reduced motion they stay put and blink.
//
// Unlike the other scenes, the meadow fills whatever box it's given: the art keeps
// about 96 rows of height and grows sideways, so wide and narrow frames both fill.

import type { Pose } from '../shared/compose';
import { type Genome, genome } from '../shared/genome';
import { heart, idlePose, Particles, RM, Stage, spr } from './engine';

// Three Forklings from the house generator, picked for colours that sit well together.
const CAST: { seed: string; stage: number; off: number }[] = [
  { seed: '6e6653bd97fd3617a23e094d08f38613ffc79bfdb7b01844e668af56a1e1980a', stage: 1, off: -42 },
  { seed: '7d9cae65cdc078eaa46af16e8de68e53710eb76fa4a3b251cdeb34f4557c43ff', stage: 2, off: 0 },
  { seed: '2069e645d5c6fde85d959b038f5461fa92ea1b6bf6b68b4bad91ebe47211b61c', stage: 1, off: 42 },
];
const ROWS = 96; // target art height
const MAXW = 400; // widest art the scenery is worked out for
const ROAM = 10; // how far a Forkling wanders from its spot, in art pixels

interface Wanderer {
  g: Genome;
  stage: number;
  off: number;
  dx: number;
  dir: number;
  mode: 'idle' | 'walk';
  timer: number;
  hop: number;
  react: number;
  look: number;
}

/** Rolling hills: one height per column. */
const hills = (base: number, amp: number, f: number, ph: number) =>
  Array.from({ length: MAXW }, (_, x) => Math.round(base - amp * Math.sin(x * f + ph) - (amp / 2) * Math.sin(x * f * 2.3 + ph * 1.7)));

export function makeMeadow(canvas: HTMLCanvasElement) {
  const st = new Stage(canvas, 144, ROWS, '#221a38');
  // Fill the box: pick the scale from the height, then widen the art to cover the width.
  st.resize = () => {
    const d = window.devicePixelRatio || 1,
      r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * d)),
      h = Math.max(1, Math.round(r.height * d));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    st.P = Math.max(1, Math.round(h / ROWS));
    st.aw = Math.min(MAXW, Math.ceil(w / st.P));
    st.ah = Math.ceil(h / st.P);
    st.ox0 = st.ox = Math.floor((w - st.aw * st.P) / 2);
    st.oy0 = st.oy = Math.floor((h - st.ah * st.P) / 2);
  };
  st.resize();

  const parts = new Particles();
  const cast: Wanderer[] = CAST.map((c, i) => ({
    g: genome(c.seed),
    stage: c.stage,
    off: c.off,
    dx: 0,
    dir: i === 2 ? -1 : 1,
    mode: 'idle',
    timer: 1 + i * 1.3,
    hop: 0,
    react: -9,
    look: 0,
  }));
  const stars = Array.from({ length: 60 }, (_, i) => ({ x: (i * 53 + 11) % MAXW, y: 3 + ((i * 23) % 34), p: (i * 0.61) % 5 }));
  const flies = [-58, 22, 64].map((x, i) => ({ x, y: 8 + (i % 2) * 5, p: i * 2.1 }));
  const far = hills(0, 6, 0.038, 0.8);
  const near = hills(0, 3, 0.06, 2.4);
  // Scenery is laid out from the ground line and the middle, so it suits any width.
  const ground = () => st.ah - 18;
  const mid = () => Math.floor(st.aw / 2);
  const spot = (w: Wanderer) => mid() + w.off + w.dx - 16;

  /** Everyone looks towards `dir` (-1 left, 0 the viewer, 1 right) and hops for joy. */
  const excite = (dir: number) => {
    for (const w of cast) {
      w.look = dir;
      w.mode = 'idle';
      w.timer = 2.5;
      if (!RM) w.react = st.t + Math.random() * 0.15;
    }
  };
  const calm = () => {
    for (const w of cast) w.look = 0;
  };
  // A tap: the nearest Forkling hops and sends up a heart.
  canvas.addEventListener('pointerdown', (e) => {
    const ax = (e.offsetX * (window.devicePixelRatio || 1) - st.ox0) / st.P;
    let best = cast[0];
    for (const w of cast) if (Math.abs(spot(w) + 16 - ax) < Math.abs(spot(best) + 16 - ax)) best = w;
    if (!RM) best.react = st.t;
    parts.add({ img: heart(), x: spot(best) + 13, y: ground() - 34, vx: (Math.random() - 0.5) * 6, vy: -14, life: 1.4, fade: 0.5 });
  });

  st.draw = (_x, t, dt) => {
    const W = st.aw,
      G = ground(),
      M = mid();
    // Sky in three soft bands, dithered where they meet.
    const b1 = Math.round(G * 0.36),
      b2 = Math.round(G * 0.62);
    st.rect(0, 0, W, b1, '#221a38');
    st.rect(0, b1, W, b2 - b1, '#2a2044');
    st.rect(0, b2, W, G - b2, '#33264c');
    for (let x = 0; x < W; x += 2) {
      st.rect(x + ((x / 2) % 2), b1, 1, 1, '#221a38');
      st.rect(x + ((x / 2) % 2), b2, 1, 1, '#2a2044');
    }
    for (const s of stars) {
      if (s.x >= W || s.y >= b2 - 2) continue;
      if (RM || Math.floor(t * 1.2 + s.p) % 7) st.rect(s.x, s.y, 1, 1, s.p > 3.4 ? '#fff2dc' : '#8f7fb0');
    }
    // The moon, upper right.
    const mx = W - 30,
      my = 10;
    st.glow(mx + 6, my + 5, 22, '#bf98ff', 0.18);
    st.rect(mx + 2, my, 9, 11, '#fff2dc');
    st.rect(mx, my + 2, 13, 7, '#fff2dc');
    st.rect(mx + 1, my + 1, 11, 9, '#fff2dc');
    st.rect(mx + 6, my + 2, 3, 2, '#ffe9c4');
    st.rect(mx + 3, my + 6, 2, 2, '#ffe9c4');
    st.rect(mx + 8, my + 7, 2, 1, '#ffe9c4');
    // Hills, then the meadow.
    for (let x = 0; x < W; x++) {
      const fh = G - 19 + far[x],
        nh = G - 8 + near[x];
      st.rect(x, fh, 1, G - fh, '#3b2c55');
      st.rect(x, nh, 1, G - nh, '#413361');
    }
    st.rect(0, G, W, st.ah - G, '#4a3a6b');
    st.rect(0, G, W, 1, '#5a4a7b');
    for (let i = 2; i < W; i += 9) st.rect(i + (i % 4), G - 1, 1, 1, '#5a4a7b');
    for (let i = 5; i < W; i += 13) st.rect(i, G + 5 + (i % 5) * 2, 3, 1, '#413361');
    // Fireflies drift on slow loops.
    for (const f of flies) {
      const fx = M + f.x + (RM ? 0 : Math.round(Math.sin(t * 0.5 + f.p) * 8)),
        fy = G - 22 - f.y + (RM ? 0 : Math.round(Math.sin(t * 0.8 + f.p * 1.3) * 3));
      if (RM || Math.floor(t * 0.9 + f.p) % 3) {
        st.glow(fx + 0.5, fy + 0.5, 3, '#6fdc9c', 0.5);
        st.rect(fx, fy, 1, 1, '#cdfcc0');
      }
    }
    // The Forklings.
    for (const w of cast) {
      w.timer -= dt;
      if (!RM) {
        if (w.mode === 'idle' && w.timer <= 0) {
          w.mode = 'walk';
          w.dir = w.dx < -6 ? 1 : w.dx > 6 ? -1 : Math.random() < 0.5 ? -1 : 1;
          w.timer = 0.8 + Math.random() * 1.2;
        } else if (w.mode === 'walk') {
          w.dx += w.dir * 9 * dt;
          w.hop += dt;
          if (w.timer <= 0 || Math.abs(w.dx) > ROAM) {
            w.mode = 'idle';
            w.timer = 2 + Math.random() * 3;
            w.dx = Math.max(-ROAM, Math.min(ROAM, w.dx));
          }
        }
      }
      let y = 0,
        pose: Pose;
      const rt = t - w.react;
      if (rt >= 0 && rt < 0.9) {
        const ph = (rt / 0.45) % 1;
        y = -Math.round(Math.sin(ph * Math.PI) * 5);
        pose = { eyes: 'happy', mouth: 'open', sq: ph < 0.12 || ph > 0.88 ? 1 : -1, look: w.look };
      } else if (w.mode === 'walk') {
        const ph = (w.hop / 0.34) % 1;
        y = -Math.round(Math.sin(ph * Math.PI) * 2);
        pose = { sq: ph < 0.15 ? 1 : 0, look: w.dir };
      } else pose = idlePose(w.g, t, { look: w.look });
      pose.stage = w.stage;
      pose.phase = Math.floor(t * 5) % 2;
      const x = Math.round(spot(w));
      st.rect(x + 8, G + 3, 16, 1, '#3b2c55');
      st.img(spr(w.g, pose), x, G - 28 + y, w.mode === 'walk' && w.dir > 0);
    }
    parts.step(dt);
    parts.draw(st);
  };
  return Object.assign(st, { excite, calm });
}
