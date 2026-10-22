// The bits ledger on a real SQLite database (bun:sqlite standing in for Durable Object storage):
// replays, retries and racing purchases must never pay or charge twice.
import { describe, expect, test } from 'bun:test';
import { REWARDS, START_BITS, welcomeBits } from '../../src/shared/economy';
import { makeWallet } from './sqlite';

const T0 = Date.UTC(2026, 9, 21, 9, 0, 0);
const DAY = 86400e3;

const owned = new Set<string>();
const me = (level: number) => ({ level, owns: (id: string) => owned.has(id) });
const grantTo = (set: Set<string>, id: string) => () => set.add(id);

describe('opening the wallet', () => {
  test('a new Forkling starts with the starting bits, once', () => {
    const { w } = makeWallet();
    expect(w.open(1, 0, T0)?.delta).toBe(START_BITS);
    expect(w.open(1, 0, T0 + 1000)).toBeNull();
    expect(w.balance()).toBe(START_BITS);
  });
  test('an existing Forkling gets a welcome scaled by level, and its past levels never pay again', () => {
    const { w } = makeWallet();
    w.open(9, 1, T0);
    expect(w.balance()).toBe(welcomeBits(9));
    expect(w.levels(1, 9, T0)).toHaveLength(0);
    expect(w.evolve(1, T0)).toBeNull();
    expect(w.levels(9, 10, T0).map((r) => r.key)).toEqual(['level:10']);
    expect(w.evolve(2, T0)?.delta).toBe(REWARDS.evolve[2]);
  });
});

describe('battle rewards', () => {
  test('replaying the same battle pays nothing more', () => {
    const { w } = makeWallet();
    w.open(1, 0, T0);
    const first = w.battle('b1', 0, 'win', T0);
    expect(first.map((r) => r.kind)).toEqual(['battle', 'first-win']);
    const before = w.balance();
    expect(w.battle('b1', 0, 'win', T0 + 5)).toHaveLength(0);
    expect(w.battle('b1', 0, 'win', T0 + DAY)).toHaveLength(0); // even on a later day
    expect(w.balance()).toBe(before);
    expect(before).toBe(START_BITS + REWARDS.win + REWARDS.firstWinOfDay);
  });
  test('both sides of one battle are paid separately', () => {
    const { w } = makeWallet();
    w.open(1, 0, T0);
    w.battle('b1', 0, 'loss', T0);
    w.battle('b1', 1, 'win', T0);
    expect(w.balance()).toBe(START_BITS + REWARDS.loss + REWARDS.defendWin + REWARDS.firstWinOfDay);
  });
  test('first win of the day pays once per UTC day', () => {
    const { w } = makeWallet();
    w.open(1, 0, T0);
    w.battle('a', 0, 'win', T0);
    w.battle('b', 0, 'win', T0 + 1000);
    expect(w.today(T0).firstWin).toBe(true);
    expect(w.recent(10).filter((r) => r.kind === 'first-win')).toHaveLength(1);
    w.battle('c', 0, 'win', T0 + DAY);
    expect(w.recent(10).filter((r) => r.kind === 'first-win')).toHaveLength(2);
  });
  test('after the daily allowance, only wins pay, and less', () => {
    const { w } = makeWallet();
    w.open(1, 0, T0);
    for (let i = 0; i < REWARDS.fullBattlesPerDay; i++) w.battle(`l${i}`, 0, 'loss', T0 + i);
    const b = w.balance();
    expect(w.battle('x', 0, 'loss', T0 + 100)[0].delta).toBe(0);
    expect(w.battle('y', 0, 'win', T0 + 101).find((r) => r.kind === 'battle')?.delta).toBe(REWARDS.taperedWin);
    expect(w.balance()).toBe(b + REWARDS.taperedWin + REWARDS.firstWinOfDay);
    // The next UTC day starts fresh.
    expect(w.battle('z', 0, 'loss', T0 + DAY)[0].delta).toBe(REWARDS.loss);
  });
});

describe('care and growth rewards', () => {
  test('daily care pays once a day, and only for a well-kept Forkling', () => {
    const { w } = makeWallet();
    w.open(1, 0, T0);
    expect(w.care({ fullness: 90, mood: 20, energy: 90 }, T0)).toBeNull();
    expect(w.care({ fullness: 90, mood: 80, energy: 90 }, T0)?.delta).toBe(REWARDS.dailyCare);
    expect(w.care({ fullness: 90, mood: 80, energy: 90 }, T0 + 60e3)).toBeNull();
    expect(w.care({ fullness: 90, mood: 80, energy: 90 }, T0 + DAY)?.delta).toBe(REWARDS.dailyCare);
  });
  test('each level and evolution pays once, even if reported twice', () => {
    const { w } = makeWallet();
    w.open(1, 0, T0);
    expect(w.levels(1, 3, T0).map((r) => r.delta)).toEqual([9, 11]);
    expect(w.levels(1, 3, T0)).toHaveLength(0);
    expect(w.levels(2, 4, T0).map((r) => r.key)).toEqual(['level:4']);
    expect(w.evolve(1, T0)?.delta).toBe(REWARDS.evolve[1]);
    expect(w.evolve(1, T0)).toBeNull();
  });
});

describe('buying', () => {
  const offer = { id: 'g20261021a', level: 1, price: 40 };
  test('a purchase charges once and grants the item', () => {
    const { w } = makeWallet();
    const mine = new Set<string>();
    const as = { level: 1, owns: (id: string) => mine.has(id) };
    w.open(1, 0, T0);
    const r = w.buy('req-0000001', offer, as, grantTo(mine, offer.id), T0);
    expect(r).toMatchObject({ ok: true, replay: false, balance: START_BITS - 40 });
    expect(mine.has(offer.id)).toBe(true);
  });
  test('retrying the same request is answered again without a second charge', () => {
    const { w } = makeWallet();
    const mine = new Set<string>();
    const as = { level: 1, owns: (id: string) => mine.has(id) };
    w.open(1, 0, T0);
    w.buy('req-0000001', offer, as, grantTo(mine, offer.id), T0);
    const again = w.buy('req-0000001', offer, as, grantTo(mine, offer.id), T0 + 10);
    expect(again).toMatchObject({ ok: true, replay: true, balance: START_BITS - 40 });
    expect(w.recent(10).filter((r) => r.kind === 'buy')).toHaveLength(1);
  });
  test('a request id cannot be reused for a different item', () => {
    const { w } = makeWallet();
    const mine = new Set<string>();
    const as = { level: 1, owns: (id: string) => mine.has(id) };
    w.open(1, 0, T0);
    w.buy('req-0000001', offer, as, grantTo(mine, offer.id), T0);
    const r = w.buy('req-0000001', { ...offer, id: 'other' }, as, grantTo(mine, 'other'), T0);
    expect(r).toMatchObject({ ok: false, code: 'request' });
    expect(mine.has('other')).toBe(false);
  });
  test('two different requests for the same item: the second finds it owned and charges nothing', () => {
    const { w } = makeWallet();
    const mine = new Set<string>();
    const as = { level: 1, owns: (id: string) => mine.has(id) };
    w.open(1, 0, T0);
    w.buy('tap-aaaaaaaa', offer, as, grantTo(mine, offer.id), T0);
    const r = w.buy('tap-bbbbbbbb', offer, as, grantTo(mine, offer.id), T0);
    expect(r).toMatchObject({ ok: false, code: 'owned', balance: START_BITS - 40 });
  });
  test('cannot spend the same bits twice', () => {
    const { w } = makeWallet();
    const mine = new Set<string>();
    const as = { level: 5, owns: (id: string) => mine.has(id) };
    w.open(1, 0, T0); // 50 bits
    const a = w.buy('tap-aaaaaaaa', { id: 'a', level: 1, price: 40 }, as, grantTo(mine, 'a'), T0);
    const b = w.buy('tap-bbbbbbbb', { id: 'b', level: 1, price: 40 }, as, grantTo(mine, 'b'), T0);
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, code: 'funds', error: 'You need 30 more bits.' });
    expect(mine.has('b')).toBe(false);
    expect(w.balance()).toBe(10);
  });
  test('level-locked items are refused with the level to reach', () => {
    const { w } = makeWallet();
    w.open(1, 0, T0);
    const r = w.buy('tap-aaaaaaaa', { id: 'x', level: 4, price: 10 }, me(2), () => owned.add('x'), T0);
    expect(r).toMatchObject({ ok: false, code: 'locked', error: 'Unlocks at level 4: 2 levels to go.' });
    expect(w.balance()).toBe(START_BITS);
  });
  test('malformed request ids are refused before anything is checked', () => {
    const { w } = makeWallet();
    w.open(1, 0, T0);
    for (const id of [undefined, 42, '', 'short', 'has spaces in it', 'x'.repeat(65)])
      expect(w.buy(id, offer, me(1), () => {}, T0)).toMatchObject({ ok: false, code: 'request' });
  });
  test('if granting the item fails, the charge is rolled back', () => {
    const { w } = makeWallet();
    w.open(1, 0, T0);
    expect(() =>
      w.buy(
        'tap-aaaaaaaa',
        offer,
        me(1),
        () => {
          throw new Error('disk full');
        },
        T0,
      ),
    ).toThrow('disk full');
    expect(w.balance()).toBe(START_BITS);
    expect(w.has('buy:tap-aaaaaaaa')).toBe(false);
    expect(w.drain().map((r) => r.kind)).toEqual(['start']);
  });
  test('the balance can never go below zero, even by a bug elsewhere', () => {
    const { db } = makeWallet();
    expect(() =>
      db.run("INSERT INTO ledger (key, at, day, delta, kind, ref, balance) VALUES ('x', 0, '2026-10-21', -5, 'buy', 'x', -5)"),
    ).toThrow();
  });
});

describe('the analytics mirror', () => {
  test('every posted entry is handed over once for D1', () => {
    const { w } = makeWallet();
    w.open(1, 0, T0);
    w.battle('b1', 0, 'win', T0);
    w.battle('b1', 0, 'win', T0); // replay: nothing new
    expect(w.drain().map((r) => r.key)).toEqual(['start', 'battle:b1:0', `first-win:2026-10-21`]);
    expect(w.drain()).toEqual([]);
  });
});
