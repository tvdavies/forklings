// Animated scenes: hatch reveal, home room, battle replay and evolution.
// Timing and staging follow the concept's five moments.

import { type BattleEvent, type BattleResult, type Snapshot, simulate } from '../shared/battle';
import { ITEMS, type Pose } from '../shared/compose';
import { type Genome, genome, INK, RAMPS, RARITY, RCOL } from '../shared/genome';
import {
  chestClosed,
  chestOpen,
  clamp01,
  ease,
  egg,
  heart,
  idlePose,
  itemIcon,
  Particles,
  RM,
  Stage,
  shield,
  snack,
  spr,
  zzz,
} from './engine';

/* ---------- hatch ---------- */
export function makeHatch(canvas: HTMLCanvasElement, opts: { g: Genome; onHatched?: (g: Genome) => void }) {
  const st = new Stage(canvas, 96, 72, '#2c2146');
  st.floor = [58, '#4a3a6b'];
  const S = { g: opts.g, state: 'idle', t0: 0, parts: new Particles(), burst: false, flash: 0, carded: false, landed: false };
  const stars = Array.from({ length: 22 }, (_, i) => ({ x: (i * 41 + 7) % 96, y: (i * 17 + 3) % 38, p: (i * 0.37) % 5 }));
  const hatch = (g: Genome) => {
    S.g = g;
    S.state = 'hatching';
    S.t0 = st.t;
    S.burst = false;
    S.carded = false;
    S.landed = false;
    S.parts.a = [];
  };
  st.draw = (_x, t, dt) => {
    const g = S.g;
    if (!g) return;
    const bR = RAMPS[g.pal[0]],
      aR = RAMPS[g.pal[1]];
    st.rect(0, 0, 96, 72, '#2c2146');
    st.rect(0, 30, 96, 8, '#33274f');
    st.rect(0, 38, 96, 8, '#3a2d58');
    st.rect(0, 46, 96, 26, '#413361');
    for (const s of stars) {
      if (Math.floor(t * 1.5 + s.p) % 6) st.rect(s.x, s.y, 1, 1, s.p > 3 ? '#fff2dc' : '#8f7fb0');
    }
    st.rect(80, 7, 5, 5, '#fff2dc');
    st.rect(79, 8, 1, 3, '#fff2dc');
    st.rect(85, 8, 1, 3, '#fff2dc');
    st.rect(80, 6, 5, 1, '#fff2dc');
    st.rect(80, 12, 5, 1, '#fff2dc');
    st.rect(82, 7, 3, 3, '#ffe9c4');
    st.rect(0, 58, 96, 14, '#4a3a6b');
    st.rect(0, 58, 96, 1, '#5a4a7b');
    for (let i = 0; i < 96; i += 7) st.rect(i + (i % 3), 57, 2, 1, '#5a4a7b');
    for (let i = 3; i < 96; i += 11) st.rect(i, 63 + (i % 4), 3, 1, '#413361');
    st.rect(33, 55, 30, 2, '#4f2c2c');
    st.rect(31, 56, 34, 2, '#5a3328');
    const gx = 32,
      gy = 58 - 30;
    const T = t - S.t0;
    if (S.state === 'idle') {
      const ph = t % 2.8;
      const lean = ph < 0.36 ? [0, 1, 0, -1][Math.floor(ph / 0.09) % 4] : 0;
      st.img(egg(g, lean, 0), gx, gy);
    } else {
      if (T < 2.95) {
        const W = [
          [0, 0.45, 1],
          [0.9, 0.5, 1],
          [1.8, 0.6, 2],
        ];
        let lean = 0;
        for (const [s, d, a] of W)
          if (T >= s && T < s + d) {
            lean = [a, 0, -a, 0][Math.floor((T - s) / 0.075) % 4];
          }
        const crack = T >= 1.85 ? 2 : T >= 0.95 ? 1 : 0;
        let jit = 0;
        if (T > 2.4) {
          jit = Math.floor(T * 28) % 2 ? 1 : -1;
          const a = clamp01((T - 2.4) / 0.55);
          st.glow(48, 46, 10 + a * 26, '#fff2dc', a * 0.8);
          st.rays(48, 46, 30 + a * 20, T * 1.5, '#fff2dc', a * 0.12, 12);
        }
        if (T > 0.95 && T < 1.05) st.shake(1, 0.08);
        if (T > 1.85 && T < 1.95) st.shake(1, 0.1);
        st.img(egg(g, lean, crack), gx + (RM ? 0 : jit), gy);
      } else {
        if (!S.burst) {
          S.burst = true;
          S.flash = RM ? 0 : 1;
          st.shake(2, 0.22);
          for (let i = 0; i < 14; i++)
            S.parts.add({
              x: 44 + Math.random() * 8,
              y: 38 + Math.random() * 14,
              vx: (Math.random() - 0.5) * 80,
              vy: -30 - Math.random() * 60,
              g: 140,
              s: Math.random() < 0.4 ? 2 : 1,
              c: [bR[3], bR[2], aR[2], '#ffffff'][i % 4],
              life: 1 + Math.random() * 0.6,
              fade: 0.4,
            });
          for (let i = 0; i < (RM ? 10 : 40); i++)
            S.parts.add({
              x: 46 + Math.random() * 4,
              y: 40,
              vx: (Math.random() - 0.5) * 110,
              vy: -50 - Math.random() * 70,
              g: 80,
              drag: 1.2,
              s: 1,
              c: [bR[1], bR[2], aR[1], aR[2], '#ffd166', '#fff2dc'][i % 6],
              life: 1.4 + Math.random() * 1.2,
              fade: 0.5,
            });
        }
        const T2 = T - 2.95;
        if (T2 < 2.2) {
          const a = 1 - T2 / 2.2;
          st.glow(48, 44, 34, bR[3], 0.35 * a);
          st.rays(48, 44, 60, t * 0.6, '#fff2dc', 0.1 * a, 12);
        }
        let y = 0,
          pose: Pose;
        const base = { stage: 0 };
        if (T2 < 0.3) {
          const p = T2 / 0.3;
          y = -14 * (1 - p * p);
          pose = { ...base, sq: -2 };
        } else if (T2 < 0.38) {
          pose = { ...base, sq: 2 };
          if (!S.landed) {
            S.landed = true;
            st.shake(1, 0.08);
            for (let i = 0; i < 8; i++)
              S.parts.add({
                x: 40 + Math.random() * 16,
                y: 57,
                vx: (Math.random() - 0.5) * 40,
                vy: -10 - Math.random() * 15,
                g: 40,
                s: 1,
                c: '#4a3a6b',
                life: 0.5,
                fade: 0.3,
              });
          }
        } else if (T2 < 0.46) pose = { ...base, sq: 1 };
        else if (T2 < 0.75) pose = { ...base, sq: 0 };
        else if (T2 < 1.45) {
          const ph = ((T2 - 0.75) / 0.35) % 1;
          y = -Math.round(Math.sin(ph * Math.PI) * 4);
          pose = { ...base, eyes: 'happy', mouth: 'open', sq: ph < 0.12 || ph > 0.88 ? 1 : ph > 0.25 && ph < 0.75 ? -1 : 0 };
        } else pose = idlePose(g, t, base);
        pose.phase = Math.floor(t * 5) % 2;
        st.img(spr(g, pose), gx, gy + y);
        if (T > 3.7 && !S.carded) {
          S.carded = true;
          opts.onHatched?.(g);
        }
      }
    }
    st.rect(30, 58, 36, 2, '#86523a');
    st.rect(32, 60, 32, 1, '#5a3328');
    for (let i = 31; i < 65; i += 4) st.rect(i, 58, 2, 1, '#c08458');
    S.parts.step(dt);
    S.parts.draw(st);
    if (S.flash > 0) {
      st.fadeAll('#fff6e6', S.flash);
      S.flash -= dt / 0.35;
    }
  };
  return Object.assign(st, { hatch });
}

/* ---------- home ---------- */
interface HomeState {
  g: Genome | null;
  stage: number;
  napping: boolean;
  mood: string;
  x: number;
  dir: number;
  mode: 'idle' | 'walk';
  timer: number;
  react: number;
  kind: string;
  parts: Particles;
  hop: number;
}
export function makeHome(canvas: HTMLCanvasElement) {
  const home = new Stage(canvas, 160, 90, '#3b2c55');
  home.floor = [64, '#7a4a34'];
  const H: HomeState = {
    g: null,
    stage: 0,
    napping: false,
    mood: 'content',
    x: 70,
    dir: 1,
    mode: 'idle',
    timer: 1.5,
    react: -9,
    kind: '',
    parts: new Particles(),
    hop: 0,
  };
  const set = (g: Genome, stage: number, napping: boolean, mood: string) => {
    H.g = g;
    H.stage = stage;
    H.napping = napping;
    H.mood = mood;
  };
  const react = (kind: string) => {
    H.react = home.t;
    H.kind = kind;
    const cx = H.x + 16;
    if (kind === 'feed') {
      for (let i = 0; i < 3; i++)
        H.parts.add({ img: snack(), x: cx - 3 + (i - 1) * 6, y: 30 - i * 4, vx: 0, vy: 20, g: 60, life: 0.7 + i * 0.1, fade: 0.2 });
    }
    if (kind === 'pat' || kind === 'feed') {
      for (let i = 0; i < 3; i++)
        H.parts.add({
          img: heart(),
          x: cx - 10 + i * 8 + Math.random() * 3,
          y: 48 - i * 2,
          vx: (Math.random() - 0.5) * 6,
          vy: -14 - Math.random() * 6,
          life: 1.6,
          fade: 0.5,
        });
    }
    if (kind === 'play' || kind === 'equip') {
      for (let i = 0; i < 16; i++) {
        const a = Math.random() * Math.PI * 2;
        H.parts.add({
          x: cx + Math.cos(a) * 3,
          y: 66 + Math.sin(a) * 3,
          vx: Math.cos(a) * 34,
          vy: Math.sin(a) * 26 - 10,
          drag: 3,
          s: kind === 'equip' ? 2 : 1,
          c: i % 3 ? (kind === 'equip' ? '#eadcff' : '#ffd166') : '#ffffff',
          life: 0.5 + Math.random() * 0.3,
          fade: 0.3,
        });
      }
    }
  };
  const codeCols = ['#6fdc9c', '#86bdff', '#ffd166', '#ff86bd', '#bf98ff'];
  const codeLines = Array.from({ length: 24 }, (_, i) => ({ w: 3 + ((i * 7) % 12), i0: (i * 3) % 5, c: codeCols[(i * 5) % 5] }));
  home.draw = (_x, t, dt) => {
    const g = H.g,
      s = home;
    if (!g) return;
    s.rect(0, 0, 160, 64, '#3b2c55');
    for (let yy = 4; yy < 60; yy += 8) for (let xx = ((yy / 8) % 2) * 4; xx < 160; xx += 8) s.rect(xx, yy, 1, 1, '#45345f');
    s.rect(0, 62, 160, 2, '#2a1f3d');
    for (let yy = 64; yy < 90; yy += 5) {
      s.rect(0, yy, 160, 5, yy % 10 ? '#7a4a34' : '#86523a');
      s.rect(0, yy + 4, 160, 1, '#5a3328');
      for (let xx = (yy * 7) % 23; xx < 160; xx += 31) s.rect(xx, yy, 1, 4, '#5a3328');
    }
    // window follows the player's local time
    const hr = new Date().getHours();
    const day = hr >= 7 && hr < 17,
      dusk = (hr >= 17 && hr < 20) || hr === 6;
    {
      const wx = 62,
        wy = 10;
      s.rect(wx, wy, 34, 26, '#c08458');
      s.rect(wx + 2, wy + 2, 30, 22, day ? '#86bdff' : dusk ? '#ff9f78' : '#32449a');
      if (dusk) {
        s.rect(wx + 2, wy + 14, 30, 10, '#8a5fd6');
        s.rect(wx + 2, wy + 12, 30, 2, '#e0695a');
      }
      if (day) {
        s.rect(wx + 24, wy + 5, 4, 4, '#fff3b8');
        const cxp = wx + 2 + ((t * 3) % 40) - 6;
        for (const [a, b, w] of [
          [0, 0, 6],
          [2, -1, 3],
          [1, 1, 7],
        ])
          if (cxp + a >= wx + 2 && cxp + a + w <= wx + 32) s.rect(cxp + a, wy + 10 + b, w, 1, '#ffffff');
      } else if (!dusk) {
        for (const [a, b] of [
          [5, 5],
          [13, 9],
          [21, 4],
          [28, 11],
          [9, 17],
          [25, 18],
        ])
          if (Math.floor(t + a) % 4) s.rect(wx + a, wy + b, 1, 1, '#fff2dc');
        s.rect(wx + 24, wy + 5, 3, 3, '#fff2dc');
      }
      s.rect(wx + 16, wy + 2, 2, 22, '#c08458');
      s.rect(wx + 2, wy + 12, 30, 1, '#c08458');
      s.rect(wx - 2, wy + 26, 38, 2, '#86523a');
    }
    // desk and monitor
    s.rect(110, 48, 44, 3, '#c08458');
    s.rect(110, 51, 44, 1, '#86523a');
    s.rect(113, 52, 3, 12, '#86523a');
    s.rect(148, 52, 3, 12, '#86523a');
    s.rect(118, 28, 26, 18, INK);
    s.rect(120, 30, 22, 13, '#1c1530');
    s.rect(129, 46, 4, 2, INK);
    s.rect(125, 47, 12, 1, INK);
    const off = Math.floor(t * 2);
    for (let j = 0; j < 6; j++) {
      const ln = codeLines[(j + off) % codeLines.length];
      s.rect(121 + ln.i0, 31 + j * 2, Math.min(ln.w, 20 - ln.i0), 1, ln.c);
    }
    {
      const px0 = 10;
      s.rect(px0, 56, 10, 8, '#cf3a4a');
      s.rect(px0 - 1, 55, 12, 2, '#ff6f62');
      s.rect(px0 + 1, 63, 8, 1, '#7e1f3a');
      for (const [a, b, w, h] of [
        [4, 40, 2, 15],
        [1, 43, 3, 2],
        [6, 41, 3, 2],
        [-1, 47, 3, 2],
        [7, 46, 4, 2],
        [0, 51, 3, 2],
        [6, 50, 3, 2],
      ])
        s.rect(px0 + a, b, w, h, '#4f7d3e');
      s.rect(px0 + 4, 40, 1, 6, '#93b84a');
    }
    for (let yy = 0; yy < 5; yy++) {
      const w = 30 - Math.abs(2 - yy) * 4;
      s.rect(80 - w / 2, 72 + yy, w, 1, '#4e3192');
    }
    for (let yy = 0; yy < 4; yy++) {
      const w = 24 - Math.abs(1.5 - yy) * 4;
      s.rect(132 + (24 - w) / 2, 78 + yy, w, 1, yy === 0 ? '#ffd0e6' : yy === 3 ? '#8c2766' : '#d94c93');
    }
    // creature
    H.timer -= dt;
    const sleepy = H.napping;
    if (!sleepy) {
      if (H.mode === 'idle' && H.timer <= 0) {
        H.mode = 'walk';
        H.dir = H.x < 50 ? 1 : H.x > 92 ? -1 : Math.random() < 0.5 ? -1 : 1;
        H.timer = 1.2 + Math.random() * 1.6;
      } else if (H.mode === 'walk') {
        H.x += H.dir * (H.mood === 'sulking' || H.mood === 'hungry' ? 7 : 13) * dt;
        H.hop += dt;
        if (H.timer <= 0 || H.x < 30 || H.x > 98) {
          H.mode = 'idle';
          H.timer = 1.6 + Math.random() * 2.4;
          H.x = Math.max(30, Math.min(98, H.x));
        }
      }
    } else H.mode = 'idle';
    let y = 0,
      pose: Pose;
    const rt = t - H.react;
    const st = H.stage;
    if (rt < 0.9 && H.kind !== 'nap') {
      const ph = (rt / 0.45) % 1;
      y = -Math.round(Math.sin(ph * Math.PI) * 5);
      pose = { eyes: 'happy', mouth: 'open', sq: ph < 0.12 || ph > 0.88 ? 1 : -1 };
    } else if (sleepy) {
      pose = { eyes: 'sleep', mouth: 'dot', sq: Math.floor(t * 0.8) % 2 };
      if (Math.random() < dt * 0.7) H.parts.add({ img: zzz(), x: H.x + 22, y: 50, vx: 4, vy: -8, life: 2, fade: 0.6 });
    } else if (H.mode === 'walk') {
      const ph = (H.hop / 0.34) % 1;
      y = -Math.round(Math.sin(ph * Math.PI) * 2);
      pose = { sq: ph < 0.15 ? 1 : 0, look: H.dir };
    } else
      pose = idlePose(g, t, {
        look: H.x > 88 ? 1 : 0,
        mouth: H.mood === 'hungry' || H.mood === 'sulking' ? 'frown' : undefined,
        eyes: H.mood === 'sleepy' && Math.floor(t) % 3 === 0 ? 'closed' : undefined,
      });
    pose.stage = st;
    pose.phase = Math.floor(t * 5) % 2;
    s.rect(Math.round(H.x) + 8, 82, 16, 1, '#5a3328');
    s.img(spr(g, pose), H.x, 52 + y, H.mode === 'walk' && H.dir > 0);
    H.parts.step(dt);
    H.parts.draw(s);
  };
  return Object.assign(home, { set, react });
}

/* ---------- battle replay ---------- */
/** What a replay needs: both snapshots and the battle seed (the fight is re-simulated), plus the viewer's loot if any. */
export interface Replay {
  a: Snapshot;
  b: Snapshot;
  seed: string;
  loot?: string | null;
  lootNote?: string | null;
}
export interface PlayOpts {
  speed?: number;
  onDone?: (res: BattleResult) => void;
  /** Called with each line of narration as it is shown, so the page can repeat it to screen readers. */
  onLine?: (text: string) => void;
}
type Side = 'L' | 'R';
interface Scheduled {
  ev: BattleEvent;
  t0: number;
  dur: number;
  hitAt: number;
  crit: boolean;
}
interface DamagePop {
  x: number;
  y: number;
  v: string;
  t0: number;
  col?: string;
  crit?: boolean;
}
interface BattleRun {
  rep: Replay;
  res: BattleResult;
  snaps: Snapshot[];
  gs: Genome[];
  L: number;
  Rr: number;
  sched: Scheduled[];
  end: number;
  t0: number;
  speed: number;
  parts: Particles;
  dmg: DamagePop[];
  fired: Record<string, number>;
  gh: number[];
  ghD: number[];
  onDone?: (res: BattleResult) => void;
  onLine?: (text: string) => void;
  loot: string | null;
  doneFired: boolean;
}
export function makeBattle(canvas: HTMLCanvasElement) {
  const battle = new Stage(canvas, 160, 90, '#2c2146');
  battle.floor = [52, '#3b2c55'];
  const PX = 26,
    RX = 102,
    GY = 74;
  const racks = Array.from({ length: 9 }, (_, i) => ({ x: i * 19 - 4, h: 14 + ((i * 7) % 11), w: 12 }));
  let current: BattleRun | null = null;
  const cc = chestClosed(),
    co = chestOpen();
  const play = (rep: Replay, viewerSide: number, opts: PlayOpts = {}) => {
    // Re-simulate from seed + snapshots: the replay is never stored as frames.
    const res = simulate(rep.a, rep.b, rep.seed);
    const snaps = [rep.a, rep.b];
    const L = viewerSide,
      Rr = 1 - viewerSide;
    const gs = snaps.map((s) => {
      const g = { ...genome(s.seed) };
      g.items = s.items || {};
      g.id = `${g.id}|${s.items ? Object.values(s.items).join('.') : ''}`;
      return g;
    });
    const sched: Scheduled[] = [];
    let t = 1.2;
    for (const ev of res.events) {
      const dur = ev.kind === 'special' ? 1.55 : ev.kind === 'strike' ? 1.25 : ev.kind === 'faint' ? 1.3 : 0.95;
      const crit = ev.crit || ev.kind === 'special';
      const hitAt = ev.kind === 'strike' || ev.kind === 'special' ? t + (crit ? 0.35 : 0.25) + 0.12 + (crit ? 0.14 : 0.08) : t + 0.3;
      sched.push({ ev, t0: t, dur, hitAt, crit });
      t += dur;
    }
    const end = t;
    current = {
      rep,
      res,
      snaps,
      gs,
      L,
      Rr,
      sched,
      end,
      t0: battle.t,
      speed: opts.speed || 1,
      parts: new Particles(),
      dmg: [],
      fired: {},
      gh: [res.maxHp[0], res.maxHp[1]],
      ghD: [0, 0],
      onDone: opts.onDone,
      onLine: opts.onLine,
      loot: viewerSide === 0 ? (rep.loot ?? res.loot) : null,
      doneFired: false,
    };
    return res;
  };
  const setSpeed = (v: number) => {
    if (current) {
      const T = (battle.t - current.t0) * current.speed;
      current.speed = v;
      current.t0 = battle.t - T / v;
    }
  };
  const skip = () => {
    if (current) current.t0 = battle.t - (current.end + 0.2) / current.speed;
  };
  battle.draw = (x, t, dt) => {
    const s = battle,
      R = current;
    s.rect(0, 0, 160, 90, '#2c2146');
    s.rect(0, 20, 160, 10, '#33274f');
    s.rect(0, 30, 160, 10, '#3a2d58');
    s.rect(0, 40, 160, 12, '#413361');
    for (const r of racks) {
      s.rect(r.x, 52 - r.h, r.w, r.h, '#2a1f3d');
      for (let yy = 52 - r.h + 2; yy < 50; yy += 3) {
        s.rect(r.x + 2, yy, r.w - 4, 1, '#33264c');
        if (Math.floor(t * 2 + r.x + yy) % 5 === 0) s.rect(r.x + r.w - 4, yy, 1, 1, (r.x + yy) % 3 ? '#6fdc9c' : '#ff6f62');
      }
    }
    s.rect(0, 52, 160, 38, '#3b2c55');
    s.rect(0, 52, 160, 1, '#4a3a6b');
    for (let yy = 57; yy < 90; yy += 6) s.rect(0, yy, 160, 1, '#43325f');
    for (const cx of [PX + 16, RX + 16]) {
      for (let yy = 0; yy < 4; yy++) {
        const w = 34 - Math.abs(1.5 - yy) * 6;
        s.rect(cx - w / 2, GY - 1 + yy, w, 1, yy === 0 ? '#7a6a9b' : '#5a4a7b');
      }
    }
    if (!R) {
      s.text('Find a battle to start', 80, 40, 7, '#b9a8cf', 'center');
      return;
    }
    const T = (t - R.t0) * R.speed,
      sdt = dt * R.speed;
    const once = (k: string, f: () => void) => {
      if (!R.fired[k]) {
        R.fired[k] = 1;
        f();
      }
    };
    const side = (i: number): Side => (i === R.L ? 'L' : 'R');
    const X = { L: PX, R: RX };
    const dx = { L: 0, R: 0 },
      dy = { L: 0, R: 0 };
    const pose: Record<Side, Pose> = { L: idlePose(R.gs[R.L], t), R: idlePose(R.gs[R.Rr], t + 1.3) };
    const vis = { L: true, R: true };
    let msg = `${R.gs[R.L].name} vs @${R.snaps[R.Rr].handle}'s ${R.gs[R.Rr].name}`;
    once('sayStart', () => R.onLine?.(msg));
    const hp = [R.res.maxHp[0], R.res.maxHp[1]];
    for (const sc of R.sched) {
      const ev = sc.ev,
        me = side(ev.who),
        foe = me === 'L' ? 'R' : 'L',
        dir = me === 'L' ? 1 : -1;
      if (T >= sc.hitAt) {
        hp[0] = ev.hp[0];
        hp[1] = ev.hp[1];
      }
      if (T >= sc.t0) {
        msg = ev.text;
        once(`say${sc.t0}`, () => R.onLine?.(ev.text));
      }
      if (ev.kind === 'faint' && T >= sc.t0) {
        vis[me] = T < sc.t0 + 0.5;
        if (T < sc.t0 + 0.5) pose[me] = { eyes: 'closed', mouth: 'frown', sq: 1 };
        else
          once(`dis${sc.t0}`, () => {
            const c = spr(R.gs[ev.who], { eyes: 'closed', mouth: 'frown', sq: 1, stage: R.snaps[ev.who].stage });
            const flip = me === 'R';
            c.cols.forEach((col, i) => {
              if (!col) return;
              const px = i % 32,
                py = Math.floor(i / 32);
              R.parts.add({
                x: X[me] + (flip ? 31 - px : px),
                y: GY - 30 + py,
                vx: (Math.random() - 0.5) * 24,
                vy: -Math.random() * 26 - 4,
                g: 50,
                s: 1,
                c: col,
                life: 0.5 + Math.random() * 0.9,
                fade: 0.5,
              });
            });
          });
        continue;
      }
      const a = T - sc.t0;
      if (a < 0 || a > sc.dur) continue;
      if (ev.kind === 'strike' || ev.kind === 'special') {
        const crit = sc.crit,
          ant = crit ? 0.35 : 0.25,
          dash = 0.12,
          stop = crit ? 0.14 : 0.08;
        let d = 0,
          sq = 0;
        if (a < ant) {
          d = -3 * ease.out(a / ant) * (crit ? 1.6 : 1);
          sq = crit ? 2 : 1;
        } else if (a < ant + dash) {
          const p = (a - ant) / dash;
          d = -3 * (crit ? 1.6 : 1) + (40 + 3 * (crit ? 1.6 : 1)) * p;
          sq = -1;
        } else if (a < ant + dash + stop) {
          d = 40;
          sq = -1;
        } else if (a < ant + dash + stop + 0.45) {
          d = 40 * (1 - ease.out((a - ant - dash - stop) / 0.45));
        }
        dx[me] = d * dir;
        pose[me] = { sq, phase: 0, eyes: sq === 2 ? 'closed' : undefined };
        if (ev.kind === 'special' && a < ant) s.glow(X[me] + 16, GY - 14, 16, RAMPS[R.gs[ev.who].pal[1]][2], 0.5 * (a / ant));
        const h = a - (ant + dash + stop);
        if (h >= 0) {
          once(`hit${sc.t0}`, () => {
            if (ev.miss) {
              R.dmg.push({ x: X[foe] + 16, y: 36, v: 'Miss', t0: t, col: '#b9a8cf' });
            } else {
              R.dmg.push({ x: X[foe] + 16, y: 36, v: `-${ev.dmg}`, t0: t, crit: ev.crit });
              R.ghD[ev.who === 0 ? 1 : 0] = 0.3;
              s.shake(ev.crit ? 2 : 1, ev.crit ? 0.3 : 0.16);
              spark(X[foe] + 16 - dir * 6, 58, ev.crit ? 14 : 8);
            }
          });
          if (!ev.miss && h < 0.9) {
            const f = h < 0.05 || (h >= 0.1 && h < 0.15);
            const kb = 5 * ease.out(clamp01(h / 0.2)) - 5 * ease.inOut(clamp01((h - 0.4) / 0.4));
            dx[foe] = Math.round(kb) * dir;
            pose[foe] = { flash: f, eyes: 'hurt', mouth: 'frown' };
          }
          if (ev.miss && h < 0.5) {
            dy[foe] = -Math.round(Math.sin(clamp01(h / 0.4) * Math.PI) * 4);
            dx[foe] = Math.round(3 * dir * Math.sin(clamp01(h / 0.4) * Math.PI));
          }
        }
      } else if (ev.kind === 'guard') {
        const sh = shield();
        const al = clamp01(a / 0.15) * (1 - clamp01((a - 0.7) / 0.25));
        x.globalAlpha = al;
        s.img(sh, X[me] + 12, GY - 40 - Math.round(ease.back(clamp01(a / 0.3)) * 3));
        x.globalAlpha = 1;
        s.glow(X[me] + 16, GY - 14, 18, '#86bdff', 0.35 * al);
        pose[me] = { sq: 1, eyes: 'closed' };
      } else if (ev.kind === 'heal') {
        s.glow(X[me] + 16, GY - 14, 20, '#6fdc9c', 0.5 * (1 - clamp01((a - 0.6) / 0.35)));
        if (Math.random() < 0.5)
          R.parts.add({
            x: X[me] + 6 + Math.random() * 20,
            y: GY - 4,
            vx: 0,
            vy: -20 - Math.random() * 10,
            s: 1,
            c: Math.random() < 0.5 ? '#cdfcc0' : '#6fdc9c',
            life: 0.9,
            fade: 0.4,
          });
        once(`heal${sc.t0}`, () => R.dmg.push({ x: X[me] + 16, y: 36, v: `+${ev.heal}`, t0: t, col: '#6fdc9c' }));
        pose[me] = { eyes: 'happy', mouth: 'open' };
      }
    }
    const won = R.res.winner === null ? null : R.res.winner === R.L;
    const after = T - R.end;
    if (after >= 0) {
      const a = after;
      if (won) {
        const ph = (a / 0.4) % 1;
        if (a < 1.6) {
          dy.L = -Math.round(Math.sin(ph * Math.PI) * 5);
          pose.L = { eyes: 'happy', mouth: 'open', sq: ph < 0.12 || ph > 0.88 ? 1 : -1 };
        } else pose.L = idlePose(R.gs[R.L], t, { eyes: 'happy' });
      } else if (won === false) pose.R = idlePose(R.gs[R.Rr], t + 1.3, { eyes: 'happy' });
      msg = won ? `Victory. +${R.res.xp[R.L]} XP` : won === false ? `Defeat. +${R.res.xp[R.L]} XP` : `Time! A draw. +${R.res.xp[R.L]} XP`;
      once('sayEnd', () => R.onLine?.(msg));
      if (R.loot && a > 2.2) {
        msg = `Loot: ${ITEMS[R.loot]?.name}`;
        once('sayLoot', () => R.onLine?.(msg));
      }
      const yy = -14 + 38 * ease.back(clamp01(a / 0.35));
      const bc = won ? '#ffd166' : won === false ? '#ff6f62' : '#86bdff';
      if (a < (R.loot ? 2.2 : 99)) {
        s.panel(50, yy, 60, 13, bc, INK);
        s.text(won ? 'Victory' : won === false ? 'Defeat' : 'Draw', 80, yy + 1.5, 9, INK, 'center', 700);
      }
      if (R.loot && a >= 1.8) {
        const b = a - 1.8;
        let cy = GY - 10;
        if (b < 0.35) cy = -12 + (GY - 10 + 12) * (b / 0.35) * (b / 0.35);
        else if (b < 0.55) cy = GY - 10 - Math.round(Math.sin(((b - 0.35) / 0.2) * Math.PI) * 3);
        if (b >= 0.35)
          once('land', () => {
            s.shake(1, 0.1);
            for (let i = 0; i < 10; i++)
              R.parts.add({
                x: 66 + Math.random() * 16,
                y: GY - 1,
                vx: (Math.random() - 0.5) * 40,
                vy: -8 - Math.random() * 12,
                g: 30,
                s: 1,
                c: '#5a4a7b',
                life: 0.5,
                fade: 0.3,
              });
          });
        let wx = 0;
        if ((b > 0.8 && b < 1.0) || (b > 1.2 && b < 1.4)) wx = Math.floor(b * 25) % 2 ? 1 : -1;
        const open = b >= 1.7;
        const it = ITEMS[R.loot];
        const rc = RCOL[it.rarity];
        if (open) {
          const c = b - 1.7;
          once('open', () => {
            for (let i = 0; i < 24; i++)
              R.parts.add({
                x: 73 + Math.random() * 4,
                y: GY - 14,
                vx: (Math.random() - 0.5) * 50,
                vy: -30 - Math.random() * 50,
                g: 40,
                s: 1,
                c: i % 2 ? rc : '#fff2dc',
                life: 1.2 + Math.random(),
                fade: 0.5,
              });
          });
          const ga = Math.min(1, c / 0.2);
          const P = s.P;
          const bx = s.ox + 75 * P,
            gr = x.createLinearGradient(0, s.oy, 0, s.oy + (GY - 10) * P);
          gr.addColorStop(0, 'rgba(255,255,255,0)');
          gr.addColorStop(1, rc);
          x.globalCompositeOperation = 'lighter';
          x.globalAlpha = ga * 0.6;
          x.fillStyle = gr;
          x.fillRect(bx - 7 * P, s.oy, 14 * P, (GY - 10) * P);
          x.globalAlpha = 1;
          x.globalCompositeOperation = 'source-over';
          s.glow(75, GY - 12, 22, rc, 0.5 * ga);
          const ic = itemIcon(R.loot);
          const iy = GY - 14 - 9 * ease.back(clamp01(c / 0.5));
          s.img(ic, 75 - Math.round(ic.width / 2), iy);
          if (c > 0.45) {
            x.globalAlpha = clamp01((c - 0.45) / 0.15);
            const w = Math.max(40, it.name.length * 3.2 + 8);
            s.panel(92, iy - 3, w, 15, INK, rc);
            s.text(it.name, 95, iy - 1.8, 5.5, '#fff2dc');
            s.text(RARITY[it.rarity] + (R.rep.lootNote === 'duplicate' ? ' (dupe: +10 XP)' : ''), 95, iy + 4.6, 4.5, rc);
            x.globalAlpha = 1;
          }
        }
        s.img(open ? co : cc, 68 + wx, open ? cy - 2 : cy);
      }
      if (!R.doneFired && a > (R.loot ? 4.2 : 1.5)) {
        R.doneFired = true;
        R.onDone?.(R.res);
      }
    }
    // shadows and sprites
    for (const k of ['L', 'R'] as const) {
      if (!vis[k]) continue;
      s.rect(X[k] + 8 + Math.round(dx[k]), GY - 1, 16, 1, '#1c1530');
    }
    for (const k of ['L', 'R'] as const) {
      if (!vis[k]) continue;
      const i = k === 'L' ? R.L : R.Rr;
      const p = { ...pose[k], stage: R.snaps[i].stage, phase: Math.floor(t * 5) % 2 };
      s.img(spr(R.gs[i], p), X[k] + dx[k], GY - 30 + dy[k], k === 'R');
    }
    // HP with ghost bars
    for (const i of [0, 1]) {
      if (R.ghD[i] > 0) R.ghD[i] -= sdt;
      else R.gh[i] = Math.max(hp[i], R.gh[i] - 60 * sdt);
      if (R.gh[i] < hp[i]) R.gh[i] = hp[i];
    }
    // HUD type grows on small canvases so names and narration stay at least 15 CSS px tall.
    const k = Math.min(1.5, Math.max(1, 15 / (5.5 * (s.P / (window.devicePixelRatio || 1)))));
    const hw = Math.round(Math.min(64 * k, 75)),
      bh = Math.round(4 * k);
    const hud = (x0: number, i: number) => {
      const g = R.gs[i],
        max = R.res.maxHp[i];
      const lv = `Lv ${R.snaps[i].level}`;
      s.panel(x0, 3, hw, 11 * k + bh + 2, INK, '#4a3a6b');
      s.text(s.fit(g.name, 5.5 * k, hw - 8 - s.measure(lv, 4.5 * k)), x0 + 3, 3 + 1.5 * k, 5.5 * k, '#fff2dc');
      s.text(lv, x0 + hw - 3, 3 + 2 * k, 4.5 * k, '#b9a8cf', 'right');
      const by = Math.round(3 + 11 * k),
        bw = hw - 8;
      s.rect(x0 + 3, by, hw - 6, bh, '#0f0a17');
      const w = Math.round((bw * R.gh[i]) / max),
        f = Math.round((bw * hp[i]) / max);
      s.rect(x0 + 4, by + 1, w, bh - 2, '#fff2dc');
      s.rect(x0 + 4, by + 1, f, bh - 2, hp[i] / max > 0.5 ? '#6fdc9c' : hp[i] / max > 0.2 ? '#ffd166' : '#ff6f62');
    };
    hud(3, R.L);
    hud(157 - hw, R.Rr);
    for (const d of R.dmg) {
      const a = (t - d.t0) * R.speed;
      if (a > 1.1) continue;
      const pop = 1 + 0.7 * Math.max(0, 1 - a / 0.12);
      const sz = (d.crit ? 10 : 8) * pop;
      const al = 1 - clamp01((a - 0.8) / 0.3);
      x.globalAlpha = al;
      s.text(d.v, d.x + 1, d.y - a * 8 + 1, sz, INK, 'center', 700);
      s.text(d.v, d.x, d.y - a * 8, sz, d.col || (d.crit ? '#ffd166' : '#fff2dc'), 'center', 700);
      if (d.crit && a < 0.9) s.text('Critical', d.x, d.y - a * 8 - 7, 5, '#ff86bd', 'center', 700);
      x.globalAlpha = 1;
    }
    R.parts.step(sdt);
    R.parts.draw(s);
    const nh = Math.round(9 * k);
    s.panel(3, 88 - nh, 154, nh, 'rgba(26,17,36,0.9)', '#4a3a6b');
    s.text(s.fit(msg, 5.5 * k, 148), 6, 88 - nh + 1.2 * k, 5.5 * k, '#fff2dc');
    function spark(cx: number, cy: number, n: number) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.3,
          v = 40 + Math.random() * 40;
        R!.parts.add({
          x: cx,
          y: cy,
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v,
          drag: 4,
          s: 1,
          c: i % 3 ? '#ffd166' : '#ffffff',
          life: 0.35,
          fade: 0.2,
        });
      }
    }
  };
  return Object.assign(battle, { play, setSpeed, skip });
}

/* ---------- evolution ---------- */
// Build-up, reveal and bounce, then the old and new forms settle side by side with the stat gains
// underneath. With reduced motion, the silhouettes crossfade once instead of flickering.
export function makeEvo(canvas: HTMLCanvasElement, g: Genome, from: number, to: number, chips: [string, string][], onDone?: () => void) {
  const evo = new Stage(canvas, 96, 72, '#1c1530');
  const E = { parts: new Particles(), fired: {} as Record<string, number>, done: false, t0: evo.t };
  const LEN = 7.5;
  const swaps: number[] = [];
  {
    let tt = 1.45,
      d = 0.42;
    while (tt < 3.8) {
      swaps.push(tt);
      tt += d;
      d = Math.max(0.045, d * 0.8);
    }
  }
  evo.draw = (x, t, dt) => {
    const s = evo,
      T = t - E.t0,
      bR = RAMPS[g.pal[0]];
    const once = (k: string, f: () => void) => {
      if (!E.fired[k]) {
        E.fired[k] = 1;
        f();
      }
    };
    s.rect(0, 0, 96, 72, '#1c1530');
    const floor = (cx: number, fy: number) => {
      for (let yy = 0; yy < 4; yy++) {
        const w = 40 - Math.abs(1.5 - yy) * 8;
        s.rect(cx - w / 2, fy + yy, w, 1, yy === 0 ? '#4a3a6b' : '#33264c');
      }
    };
    const gx = 32,
      gy = 59 - 30;
    // How far the ending has moved into its side-by-side layout (0 centred, 1 settled).
    const k = T < 3.8 ? 0 : RM ? clamp01((T - 3.8 - 1.4) / 0.4) : ease.inOut(clamp01((T - 3.8 - 1.4) / 0.5));
    if (!RM) floor(48 + 24 * k, 58 - 9 * k);
    else if (k < 1) {
      x.globalAlpha = 1 - k;
      floor(48, 58);
      x.globalAlpha = 1;
    }
    if (T < 1.2) {
      s.img(spr(g, idlePose(g, t, { stage: from })), gx, gy);
      s.text(`${g.name} is evolving`, 48, 6, 6, '#fff2dc', 'center');
    } else if (T < 3.8) {
      const a = clamp01((T - 1.2) / 2.6);
      if (Math.random() < (RM ? 0.15 : 0.6))
        E.parts.add({
          x: 30 + Math.random() * 36,
          y: 60,
          vx: 0,
          vy: -18 - Math.random() * 20,
          s: 1,
          c: Math.random() < 0.5 ? bR[3] : '#fff2dc',
          life: 1.4,
          fade: 0.6,
        });
      s.glow(48, 44, 14 + a * 20, bR[2], 0.35 + a * 0.4);
      if (RM) {
        const f = ease.inOut(clamp01((T - swaps[0]) / (3.8 - swaps[0])));
        x.globalAlpha = 1 - f;
        s.img(spr(g, { stage: from, sil: '#fff2dc', noItems: true }), gx, gy);
        x.globalAlpha = f;
        s.img(spr(g, { stage: to, sil: '#fff2dc', noItems: true }), gx, gy);
        x.globalAlpha = 1;
      } else {
        let idx = -1;
        for (let i = 0; i < swaps.length; i++) if (T >= swaps[i]) idx = i;
        const showNew = idx % 2 === 0;
        s.img(spr(g, { stage: showNew ? to : from, sil: '#fff2dc', noItems: true }), gx, gy);
      }
      s.text(`${g.name} is evolving`, 48, 6, 6, '#fff2dc', 'center');
    } else {
      once('burst', () => {
        for (let i = 0; i < (RM ? 10 : 36); i++) {
          const an = Math.random() * Math.PI * 2,
            v = 30 + Math.random() * 60;
          E.parts.add({
            x: 48,
            y: 44,
            vx: Math.cos(an) * v,
            vy: Math.sin(an) * v,
            drag: 2,
            s: Math.random() < 0.3 ? 2 : 1,
            c: [bR[2], bR[3], '#ffd166', '#fff2dc'][i % 4],
            life: 1.2 + Math.random() * 0.8,
            fade: 0.5,
          });
        }
      });
      const a = T - 3.8;
      s.rays(48 + 24 * k, 44 - 9 * k, 70, RM ? 0 : t * 0.5, '#fff2dc', 0.1, 14);
      s.glow(48 + 24 * k, 44 - 9 * k, 30, bR[3], 0.3);
      let y = 0,
        pose: Pose;
      if (!RM && a > 0.5 && a < 1.2) {
        const ph = ((a - 0.5) / 0.35) % 1;
        y = -Math.round(Math.sin(ph * Math.PI) * 4);
        pose = { stage: to, eyes: 'happy', mouth: 'open', sq: ph < 0.12 || ph > 0.88 ? 1 : -1 };
      } else pose = idlePose(g, t, { stage: to });
      pose.phase = Math.floor(t * 5) % 2;
      if (RM) {
        // Crossfade from the centred reveal to the side-by-side layout.
        x.globalAlpha = 1 - k;
        s.img(spr(g, pose), gx, gy);
        x.globalAlpha = 1;
      }
      if (k > 0) {
        // Old form on the left, an arrow, the new form on the right.
        x.globalAlpha = k;
        floor(24, 49);
        if (RM) floor(72, 49);
        s.img(spr(g, idlePose(g, t + 0.7, { stage: from })), 8, 20);
        s.rect(43, 35, 6, 2, '#ffd166');
        s.rect(49, 33, 1, 6, '#ffd166');
        s.rect(50, 34, 1, 4, '#ffd166');
        s.rect(51, 35, 1, 2, '#ffd166');
        if (RM) s.img(spr(g, pose), 56, 20);
        x.globalAlpha = 1;
      }
      if (!RM) s.img(spr(g, pose), gx + 24 * k, gy + y - 9 * k);
      // Stat chips sit in rows under the two forms once they have settled.
      let row = 0,
        rowW = 0;
      const laid = chips.map(([txt, c]) => {
        const w = Math.round(s.measure(txt, 5) + 6);
        if (rowW && rowW + 3 + w > 92) {
          row++;
          rowW = 0;
        }
        const at = { txt, c, w, row, x: rowW ? rowW + 3 : 0 };
        rowW = at.x + w;
        return at;
      });
      laid.forEach(({ txt, c, w, row: r, x: rx }, i) => {
        const ca = a - 2 - i * 0.3;
        if (ca < 0) return;
        const last = laid.filter((l) => l.row === r).pop()!;
        const cx0 = Math.round(48 - (last.x + last.w) / 2 + rx);
        const sc = RM ? 1 : ease.back(clamp01(ca / 0.3));
        x.globalAlpha = clamp01(ca / (RM ? 0.3 : 0.12));
        s.panel(cx0, 55 + r * 9, w, 8, INK, c);
        s.text(txt, cx0 + w / 2, 55 + r * 9 + 1.2, 5 * Math.max(0.6, sc), c, 'center');
        x.globalAlpha = 1;
      });
      if (a < 0.5) s.fadeAll('#fff6e6', RM ? 0 : 1 - a / 0.5);
      if (T > LEN && !E.done) {
        E.done = true;
        onDone?.();
      }
    }
    E.parts.step(dt);
    E.parts.draw(s);
    if (T >= 3.6 && T < 3.8 && !RM) s.fadeAll('#fff6e6', (T - 3.6) / 0.2);
  };
  return evo;
}
