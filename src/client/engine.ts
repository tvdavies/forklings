// Rendering engine: crisp pixel layer (whole-number scaled sprites) plus a free
// layer for light, particles and type. Ported from the approved visual concept.
import { compose, eggCols, itemIconCols, mapCols, type Pose, type Px, SLOTS } from '../shared/compose';
import { type Genome, INK } from '../shared/genome';

export const RM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A canvas holding one sprite, keeping the source pixels (used to burst a fainted creature into particles). */
export type SpriteCanvas = HTMLCanvasElement & { cols: Px[] };

export function toCanvas(cols: Px[], w: number, h: number): SpriteCanvas {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d')!;
  const im = x.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = cols[i];
    if (!v) continue;
    const n = parseInt(v.slice(1), 16);
    im.data[i * 4] = n >> 16;
    im.data[i * 4 + 1] = (n >> 8) & 255;
    im.data[i * 4 + 2] = n & 255;
    im.data[i * 4 + 3] = 255;
  }
  x.putImageData(im, 0, 0);
  return Object.assign(c, { cols });
}
export function mapCanvas(map: string[], colMap: Record<string, string>, pad = 1) {
  const r = mapCols(map, colMap, pad);
  return toCanvas(r.cols, r.w, r.h);
}

export const itemsKey = (g: { items?: Record<string, string | null> }) => (g.items ? SLOTS.map(([s]) => g.items![s] || '').join('.') : '');
const cache = new Map<string, SpriteCanvas>();
export function spr(g: Genome, pose: Pose = {}) {
  const key = [
    g.id,
    itemsKey(g),
    pose.stage ?? 1,
    pose.sq || 0,
    pose.eyes || '',
    pose.mouth || '',
    pose.look || 0,
    pose.flash ? 1 : 0,
    pose.sil || '',
    pose.phase || 0,
    pose.L ?? 63,
    pose.noItems ? 1 : 0,
  ].join('|');
  let c = cache.get(key);
  if (!c) {
    if (cache.size > 4000) cache.clear();
    const r = compose(g, pose);
    c = toCanvas(r.cols, 32, 32);
    cache.set(key, c);
  }
  return c;
}
export function egg(g: Genome, lean: number, crack: number) {
  const key = `egg|${g.id}|${lean}|${crack}`;
  let c = cache.get(key);
  if (!c) {
    c = toCanvas(eggCols(g, lean, crack), 32, 32);
    cache.set(key, c);
  }
  return c;
}
const iconCache = new Map<string, SpriteCanvas>();
export function itemIcon(id: string) {
  let c = iconCache.get(id);
  if (!c) {
    const r = itemIconCols(id);
    c = toCanvas(r.cols, r.w, r.h);
    iconCache.set(id, c);
  }
  return c;
}
export { idlePose } from '../shared/compose';

export const CHEST_C = { W: '#86523a', w: '#c08458', y: '#ffd166', k: '#1a1124', D: '#4f2c2c', b: '#2a1f3d' };
export const chestClosed = () =>
  mapCanvas(
    [
      '.WWWWWWWWWWWW.',
      'WwwwwwwwwwwwwW',
      'WwwwwwyywwwwwW',
      'yyyyyyyyyyyyyy',
      'WwwwwwkkwwwwwW',
      'WwwwwwyywwwwwW',
      'WwwwwwwwwwwwwW',
      'WwwwwwwwwwwwwW',
      'DDDDDDDDDDDDDD',
    ],
    CHEST_C,
  );
export const chestOpen = () =>
  mapCanvas(
    [
      '.WWWWWWWWWWWW.',
      'WwwwwwwwwwwwwW',
      'DDDDDDDDDDDDDD',
      '..............',
      'bbbbbbbbbbbbbb',
      'yyyyyyyyyyyyyy',
      'WwwwwwkkwwwwwW',
      'WwwwwwyywwwwwW',
      'WwwwwwwwwwwwwW',
      'WwwwwwwwwwwwwW',
      'DDDDDDDDDDDDDD',
    ],
    CHEST_C,
  );
export const heart = () => mapCanvas(['.r.r.', 'rrrrr', 'rRrrr', '.rrr.', '..r..'], { r: '#ff86bd', R: '#ffd0e6' });
export const zzz = () => mapCanvas(['zzz', '..z', '.z.', 'zzz'], { z: '#d2efff' }, 0);
export const snack = () => mapCanvas(['..g..', '.rrr.', 'rrRrr', 'rrrrr', '.rrr.'], { g: '#4f7d3e', r: '#ff6f62', R: '#ffc2a1' });
export const shield = () =>
  mapCanvas(['.bbbbb.', 'bBBBBBb', 'bBwBBBb', 'bBBBBBb', '.bBBBb.', '..bBb..', '...b...'], { b: '#32449a', B: '#86bdff', w: '#d2efff' });

/** Particle motion in art pixels per second; `g` is gravity, `s` the square size, `fade` the seconds of fade-out at the end of `life`. */
interface ParticleMotion {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  g: number;
  s: number;
  fade: number;
  drag: number;
}
/** A particle is either a sprite image or a coloured square. */
type ParticleLook = { img: HTMLCanvasElement; c?: undefined } | { c: string; img?: undefined };
export type Particle = ParticleMotion & ParticleLook;
export type ParticleInit = Omit<ParticleMotion, 'g' | 's' | 'fade' | 'drag'> &
  Partial<Pick<ParticleMotion, 'g' | 's' | 'fade' | 'drag'>> &
  ParticleLook;

export class Particles {
  a: Particle[] = [];
  add(p: ParticleInit) {
    this.a.push(Object.assign({ g: 0, s: 1, fade: 0.3, drag: 0 }, p));
  }
  step(dt: number) {
    for (const p of this.a) {
      p.vy += p.g * dt;
      if (p.drag) {
        p.vx *= 1 - p.drag * dt;
        p.vy *= 1 - p.drag * dt;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    this.a = this.a.filter((p) => p.life > 0);
  }
  draw(st: Stage) {
    const x = st.ctx,
      P = st.P;
    for (const p of this.a) {
      x.globalAlpha = Math.max(0, Math.min(1, p.life / p.fade));
      if (p.img) {
        x.drawImage(p.img, Math.round(st.ox + p.x * P), Math.round(st.oy + p.y * P), p.img.width * P, p.img.height * P);
      } else {
        x.fillStyle = p.c;
        x.fillRect(st.ox + p.x * P, st.oy + p.y * P, p.s * P, p.s * P);
      }
    }
    x.globalAlpha = 1;
  }
}

/** Per-frame scene callback: the 2D context, scene time and frame delta, both in seconds. */
export type DrawFn = (x: CanvasRenderingContext2D, t: number, dt: number) => void;

const stages: Stage[] = [];
export class Stage {
  c: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  aw: number;
  ah: number;
  bg: string;
  visible = true;
  P = 1;
  ox = 0;
  oy = 0;
  ox0 = 0;
  oy0 = 0;
  last = performance.now();
  t = 0;
  shakeT = 0;
  shakeA = 0;
  floor: [number, string] | null = null;
  draw: DrawFn | null = null;
  err = 0;
  constructor(canvas: HTMLCanvasElement, aw: number, ah: number, bg: string) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.aw = aw;
    this.ah = ah;
    this.bg = bg;
    if (window.ResizeObserver) new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    if (window.IntersectionObserver)
      new IntersectionObserver(
        (es) => {
          this.visible = es[es.length - 1].isIntersecting;
        },
        { rootMargin: '100px' },
      ).observe(canvas);
    stages.push(this);
  }
  resize() {
    const d = window.devicePixelRatio || 1,
      r = this.c.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * d)),
      h = Math.max(1, Math.round(r.height * d));
    if (this.c.width !== w) this.c.width = w;
    if (this.c.height !== h) this.c.height = h;
    this.P = Math.max(1, Math.floor(Math.min(w / this.aw, h / this.ah)));
    this.ox0 = Math.floor((w - this.aw * this.P) / 2);
    this.oy0 = Math.floor((h - this.ah * this.P) / 2);
    this.ox = this.ox0;
    this.oy = this.oy0;
  }
  shake(a: number, d: number) {
    if (RM) return;
    this.shakeA = a;
    this.shakeT = d;
  }
  frame(now: number) {
    const dt = Math.max(0, Math.min(0.05, (now - this.last) / 1000));
    this.last = now;
    this.t += dt;
    const x = this.ctx;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.imageSmoothingEnabled = false;
    x.globalAlpha = 1;
    x.fillStyle = this.bg;
    x.fillRect(0, 0, this.c.width, this.c.height);
    if (this.floor) {
      x.fillStyle = this.floor[1];
      const fy = this.oy0 + this.floor[0] * this.P;
      x.fillRect(0, fy, this.c.width, this.c.height - fy);
    }
    let sx = 0,
      sy = 0;
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      sx = (Math.random() < 0.5 ? -1 : 1) * this.shakeA;
      sy = (Math.random() < 0.5 ? -1 : 1) * Math.round(this.shakeA / 2);
    }
    this.ox = this.ox0 + sx * this.P;
    this.oy = this.oy0 + sy * this.P;
    x.save();
    x.beginPath();
    x.rect(this.ox0, this.oy0, this.aw * this.P, this.ah * this.P);
    x.clip();
    if (this.draw) this.draw(x, this.t, dt);
    x.restore();
  }
  img(c: HTMLCanvasElement, ax: number, ay: number, flip?: boolean) {
    const P = this.P,
      x = this.ctx,
      sx = Math.round(this.ox + Math.round(ax) * P),
      sy = Math.round(this.oy + Math.round(ay) * P);
    if (flip) {
      x.save();
      x.translate(sx + c.width * P, sy);
      x.scale(-1, 1);
      x.drawImage(c, 0, 0, c.width * P, c.height * P);
      x.restore();
    } else x.drawImage(c, sx, sy, c.width * P, c.height * P);
  }
  rect(ax: number, ay: number, w: number, h: number, col: string) {
    this.ctx.fillStyle = col;
    this.ctx.fillRect(this.ox + Math.round(ax) * this.P, this.oy + Math.round(ay) * this.P, Math.round(w) * this.P, Math.round(h) * this.P);
  }
  text(s: string, ax: number, ay: number, size: number, col: string, align?: CanvasTextAlign, weight?: number) {
    const x = this.ctx;
    x.font = `${weight || 600} ${Math.max(8, Math.round(size * this.P))}px "Pixelify Sans", system-ui, sans-serif`;
    x.fillStyle = col;
    x.textAlign = align || 'left';
    x.textBaseline = 'top';
    x.fillText(s, this.ox + ax * this.P, this.oy + ay * this.P);
  }
  glow(ax: number, ay: number, r: number, col: string, a: number) {
    const x = this.ctx,
      P = this.P,
      gx = this.ox + ax * P,
      gy = this.oy + ay * P,
      gr = x.createRadialGradient(gx, gy, 0, gx, gy, Math.max(1, r * P));
    gr.addColorStop(0, col);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    x.globalAlpha = a;
    x.globalCompositeOperation = 'lighter';
    x.fillStyle = gr;
    x.fillRect(gx - r * P, gy - r * P, 2 * r * P, 2 * r * P);
    x.globalCompositeOperation = 'source-over';
    x.globalAlpha = 1;
  }
  rays(ax: number, ay: number, r: number, rot: number, col: string, a: number, n?: number) {
    const x = this.ctx,
      P = this.P;
    x.save();
    x.translate(this.ox + ax * P, this.oy + ay * P);
    x.rotate(rot);
    x.globalAlpha = a;
    x.fillStyle = col;
    n = n || 10;
    for (let i = 0; i < n; i++) {
      x.rotate((Math.PI * 2) / n);
      x.beginPath();
      x.moveTo(0, 0);
      x.lineTo(r * P, -r * P * 0.12);
      x.lineTo(r * P, r * P * 0.12);
      x.closePath();
      x.fill();
    }
    x.restore();
    x.globalAlpha = 1;
  }
  panel(ax: number, ay: number, w: number, h: number, fill?: string, border?: string) {
    this.rect(ax, ay, w, h, border || INK);
    this.rect(ax + 1, ay + 1, w - 2, h - 2, fill || '#33264c');
  }
  fadeAll(col: string, a: number) {
    const x = this.ctx;
    x.globalAlpha = Math.max(0, Math.min(1, a));
    x.fillStyle = col;
    x.fillRect(this.ox0, this.oy0, this.aw * this.P, this.ah * this.P);
    x.globalAlpha = 1;
  }
  destroy() {
    const i = stages.indexOf(this);
    if (i >= 0) stages.splice(i, 1);
  }
}
function loop(now: number) {
  for (const s of stages) {
    try {
      if (s.visible && s.c.isConnected && s.c.offsetParent !== null) s.frame(now);
      else s.last = now;
    } catch (e) {
      if (!s.err) {
        s.err = 1;
        console.error(e);
      }
    }
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

export const ease = {
  out: (t: number) => 1 - (1 - t) ** 3,
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  back: (t: number) => {
    const c1 = 1.70158,
      c3 = c1 + 1;
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  },
};
export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Draw a sprite into a small standalone canvas at a whole-number scale (thumbnails, icons). */
export function paintStatic(canvas: HTMLCanvasElement, src: HTMLCanvasElement, cssSize: number) {
  const d = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssSize * d);
  canvas.height = Math.round(cssSize * d);
  const x = canvas.getContext('2d')!;
  x.imageSmoothingEnabled = false;
  const P = Math.max(1, Math.floor(canvas.width / Math.max(src.width, src.height)));
  x.clearRect(0, 0, canvas.width, canvas.height);
  x.drawImage(
    src,
    Math.floor((canvas.width - src.width * P) / 2),
    Math.floor((canvas.height - src.height * P) / 2),
    src.width * P,
    src.height * P,
  );
}
