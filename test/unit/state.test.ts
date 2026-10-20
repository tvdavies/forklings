import { describe, expect, test } from 'bun:test';
import { advance, care, newState, stageForXp, levelForXp, STAGE_XP, MAX_CATCHUP_MS, moodWord } from '../../src/shared/state';

const H = 3600 * 1000;
const T0 = Date.UTC(2026, 9, 21, 0, 0, 0);

describe('lazy pet state', () => {
  test('reading twice at the same time changes nothing', () => {
    const s = advance(newState(T0), T0 + 5 * H);
    expect(advance(s, T0 + 5 * H)).toEqual(s);
  });

  test('advancing in one jump or many small reads gives the same result', () => {
    const one = advance(newState(T0), T0 + 9 * H);
    let many = newState(T0);
    for (let t = T0; t <= T0 + 9 * H; t += 20 * 60 * 1000) many = advance(many, t);
    expect(many.fullness).toBeCloseTo(one.fullness, 6);
    expect(many.mood).toBeCloseTo(one.mood, 6);
    expect(many.energy).toBeCloseTo(one.energy, 6);
    expect(many.xp).toBeCloseTo(one.xp, 6);
  });

  test('hunger rises and mood falls while you are away', () => {
    const s = advance(newState(T0), T0 + 11 * H);
    expect(s.fullness).toBeLessThan(20);
    expect(s.mood).toBeLessThan(70);
    expect(moodWord(s, T0 + 11 * H)).toBe('hungry');
  });

  test('values stay within 0..100 and catch-up is capped', () => {
    const s = advance(newState(T0), T0 + 400 * 24 * H);
    for (const k of ['fullness', 'mood', 'energy'] as const) { expect(s[k]).toBeGreaterThanOrEqual(0); expect(s[k]).toBeLessThanOrEqual(100); }
    const capped = advance(newState(T0), T0 + MAX_CATCHUP_MS);
    expect(s.xp).toBeCloseTo(capped.xp, 6);
  });

  test('time never runs backwards', () => {
    const s = newState(T0);
    expect(advance(s, T0 - H)).toEqual(s);
  });

  test('napping restores energy faster', () => {
    const tired = { ...newState(T0), energy: 10 };
    const nap = care(tired, 'nap', T0).state;
    expect(advance(nap, T0 + 0.25 * H).energy).toBeGreaterThan(advance(tired, T0 + 0.25 * H).energy + 10);
  });
});

describe('care actions', () => {
  test('feeding fills up and gives XP only when hungry', () => {
    const hungry = { ...newState(T0), fullness: 30 };
    const r = care(hungry, 'feed', T0);
    expect(r.ok).toBe(true); expect(r.state.fullness).toBe(65); expect(r.xpGain).toBeGreaterThan(0);
    expect(care({ ...newState(T0), fullness: 98 }, 'feed', T0).ok).toBe(false);
  });

  test('play needs energy', () => {
    expect(care({ ...newState(T0), energy: 5 }, 'play', T0).ok).toBe(false);
    const r = care(newState(T0), 'play', T0);
    expect(r.ok).toBe(true); expect(r.state.energy).toBe(68);
  });

  test('a napping pet ignores everything except waking', () => {
    const nap = care(newState(T0), 'nap', T0).state;
    expect(care(nap, 'feed', T0 + 1000).ok).toBe(false);
    expect(care(nap, 'nap', T0 + 1000).state.napUntil).toBe(T0 + 1000);
  });
});

describe('growth and evolution', () => {
  test('stages follow XP thresholds', () => {
    expect(stageForXp(0)).toBe(0);
    expect(stageForXp(STAGE_XP[1] - 1)).toBe(0);
    expect(stageForXp(STAGE_XP[1])).toBe(1);
    expect(stageForXp(STAGE_XP[2])).toBe(2);
  });

  test('a well-fed pet grows passively over time', () => {
    let s = newState(T0);
    for (let h = 1; h <= 24; h++) { s = advance(s, T0 + h * H); if (s.fullness < 60) s = care(s, 'feed', T0 + h * H).state; if (s.mood < 60) s = care(s, 'pat', T0 + h * H).state; }
    expect(s.xp).toBeGreaterThan(STAGE_XP[1]);
    expect(stageForXp(s.xp)).toBeGreaterThanOrEqual(1);
  });

  test('level rises monotonically with XP', () => {
    let last = 0;
    for (let xp = 0; xp < 5000; xp += 7) { const l = levelForXp(xp); expect(l).toBeGreaterThanOrEqual(last); last = l; }
  });
});
