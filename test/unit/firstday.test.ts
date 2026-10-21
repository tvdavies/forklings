import { describe, expect, test } from 'bun:test';
import { ITEMS } from '../../src/shared/compose';
import {
  closeFirstDay,
  FIRST_DAY_REWARDS,
  FIRST_DAY_STEPS,
  type FirstDay,
  firstDayView,
  isComplete,
  needsReward,
  rewarded,
  rewardFor,
  startFirstDay,
  tickStep,
} from '../../src/shared/firstday';

const T0 = Date.UTC(2026, 9, 21, 9, 0, 0);
const NOTHING = { fed: false, dressed: false, planned: false, won: false };
const doAll = (fd: FirstDay) => FIRST_DAY_STEPS.reduce((f, s, i) => tickStep(f, s, T0 + i), fd);

describe('first-day checklist', () => {
  test('a new player starts with nothing ticked and sees the list', () => {
    const fd = startFirstDay(NOTHING, T0);
    expect(firstDayView(fd)).toEqual({ steps: { feed: false, dress: false, plan: false, win: false }, complete: false, reward: null });
    expect(needsReward(fd)).toBe(false);
  });

  test("an existing player's history ticks the steps they've already done", () => {
    const fd = startFirstDay({ fed: true, dressed: false, planned: true, won: false }, T0);
    expect(firstDayView(fd)?.steps).toEqual({ feed: true, dress: false, plan: true, win: false });
  });

  test('ticking records the time once, and a repeat returns the same record', () => {
    const a = tickStep(startFirstDay(NOTHING, T0), 'feed', T0 + 5);
    expect(a.done.feed).toBe(T0 + 5);
    expect(tickStep(a, 'feed', T0 + 99)).toBe(a);
  });

  test('the reward is due once, when the last step is ticked, in any order', () => {
    let fd = startFirstDay(NOTHING, T0);
    for (const s of ['win', 'plan', 'feed'] as const) {
      fd = tickStep(fd, s, T0);
      expect(needsReward(fd)).toBe(false);
    }
    fd = tickStep(fd, 'dress', T0 + 1);
    expect(isComplete(fd)).toBe(true);
    expect(needsReward(fd)).toBe(true);
    fd = rewarded(fd, 'scarf', T0 + 2);
    expect(needsReward(fd)).toBe(false);
    expect(fd.completedAt).toBe(T0 + 2);
    expect(firstDayView(fd)).toEqual({ steps: { feed: true, dress: true, plan: true, win: true }, complete: true, reward: 'scarf' });
  });

  test('a player whose history covers everything gets the reward too', () => {
    const fd = startFirstDay({ fed: true, dressed: true, planned: true, won: true }, T0);
    expect(needsReward(fd)).toBe(true);
  });

  test('the reward is the first cosmetic starter item the player does not own', () => {
    expect(rewardFor(['beanie', 'glasses', 'mug'])).toBe('scarf');
    expect(rewardFor(['beanie', 'scarf'])).toBe('bowtie');
    expect(rewardFor(FIRST_DAY_REWARDS)).toBeNull();
    for (const id of FIRST_DAY_REWARDS) {
      expect(ITEMS[id]).toBeDefined();
      expect(ITEMS[id].slot).not.toBe('held'); // held items change battles; the reward must not
    }
  });

  test('closing an unfinished list hides it, and finishing it later shows the reward', () => {
    let fd = closeFirstDay(tickStep(startFirstDay(NOTHING, T0), 'feed', T0), T0 + 10);
    expect(firstDayView(fd)).toBeNull();
    fd = tickStep(fd, 'plan', T0 + 20);
    expect(firstDayView(fd)).toBeNull();
    fd = rewarded(doAll(fd), 'scarf', T0 + 30);
    expect(firstDayView(fd)?.complete).toBe(true);
  });

  test('closing the finished card hides it for good', () => {
    const done = rewarded(doAll(startFirstDay(NOTHING, T0)), 'bowtie', T0 + 5);
    const seen = closeFirstDay(done, T0 + 6);
    expect(firstDayView(seen)).toBeNull();
    expect(closeFirstDay(seen, T0 + 7)).toBe(seen);
    expect(firstDayView(tickStep(seen, 'win', T0 + 8))).toBeNull();
  });
});
