// PlayerDO's first-day checklist, run against bun:sqlite standing in for Durable Object storage.
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { StoredReplay } from '../../src/worker/player';

// The Durable Object base class only needs to keep ctx and env for these tests.
mock.module('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
const { PlayerDO } = await import('../../src/worker/player');

/** Just enough of SqlStorage: exec(query, ...bindings).toArray(). */
function fakeSql(db: Database) {
  return {
    exec(q: string, ...b: (string | number | null)[]) {
      if (
        !b.length &&
        q
          .trim()
          .split(';')
          .filter((s) => s.trim()).length > 1
      ) {
        db.run(q);
        return { toArray: () => [] };
      }
      const rows = db.query(q).all(...b);
      return { toArray: () => rows };
    },
  };
}
/** publish() writes to D1; the tests don't read it back. */
const fakeD1 = { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) };

const T0 = Date.UTC(2026, 9, 21, 9, 0, 0);
const replay = { a: { handle: 'me' }, b: { handle: 'npc-carl', bot: false }, seed: 'x' } as unknown as StoredReplay;

function makePlayer() {
  const db = new Database(':memory:');
  const ctx = { storage: { sql: fakeSql(db) } };
  // biome-ignore lint/suspicious/noExplicitAny: test doubles for the Workers runtime types
  const p = new PlayerDO(ctx as any, { DB: fakeD1 } as any);
  return { p, db };
}

describe('PlayerDO first-day checklist', () => {
  let p: InstanceType<typeof PlayerDO>;
  let db: Database;
  beforeEach(async () => {
    ({ p, db } = makePlayer());
    await p.init('gh:101', 'pip');
    await p.hatch('salt', T0);
  });

  test('a fresh hatch shows an empty list', async () => {
    const v = await p.view(T0 + 1000);
    expect(v.firstDay).toEqual({ steps: { feed: false, dress: false, plan: false, win: false }, complete: false, reward: null });
  });

  test('feeding, dressing, a plan and a win tick the steps and give the scarf once', async () => {
    await p.care('pat', T0 + 1000);
    expect((await p.view(T0 + 1000)).firstDay?.steps.feed).toBe(false);
    await p.care('feed', T0 + 2000);
    await p.equip('head', 'beanie', T0 + 3000);
    await p.setTactics({ aggression: 80 }, T0 + 4000);
    await p.recordBattle('b1', 0, replay, { winner: 1, xp: [5, 10], loot: null }, 0, T0 + 5000);
    let v = await p.view(T0 + 5000);
    expect(v.firstDay).toEqual({ steps: { feed: true, dress: true, plan: true, win: false }, complete: false, reward: null });
    expect(v.inventory.map((i) => i.item)).not.toContain('scarf');

    await p.recordBattle('b2', 0, replay, { winner: 0, xp: [10, 5], loot: null }, 0, T0 + 6000);
    v = await p.view(T0 + 6000);
    expect(v.firstDay).toEqual({ steps: { feed: true, dress: true, plan: true, win: true }, complete: true, reward: 'scarf' });
    expect(v.inventory.filter((i) => i.item === 'scarf')).toHaveLength(1);

    await p.recordBattle('b3', 0, replay, { winner: 0, xp: [10, 5], loot: null }, 0, T0 + 7000);
    expect((await p.view(T0 + 7000)).inventory.filter((i) => i.source === 'first-day')).toHaveLength(1);

    await p.closeFirstDay(T0 + 8000);
    expect((await p.view(T0 + 8000)).firstDay).toBeNull();
  });

  test('a strategy script counts as a plan, and a bad one does not', async () => {
    await p.setScript('when hp < : heal', T0 + 1000);
    expect((await p.view(T0 + 1000)).firstDay?.steps.plan).toBe(false);
    await p.setScript('otherwise: strike', T0 + 2000);
    expect((await p.view(T0 + 2000)).firstDay?.steps.plan).toBe(true);
  });

  test('taking an item off is not dressing up', async () => {
    await p.equip('head', null, T0 + 1000);
    expect((await p.view(T0 + 1000)).firstDay?.steps.dress).toBe(false);
  });

  test('closing the list early hides it until the last step is done', async () => {
    await p.closeFirstDay(T0 + 1000);
    expect((await p.view(T0 + 1000)).firstDay).toBeNull();
    await p.care('feed', T0 + 2000);
    await p.equip('face', 'glasses', T0 + 3000);
    await p.setTactics({}, T0 + 4000);
    await p.recordBattle('b1', 1, replay, { winner: 1, xp: [5, 10], loot: null }, 0, T0 + 5000);
    expect((await p.view(T0 + 5000)).firstDay).toEqual({
      steps: { feed: true, dress: true, plan: true, win: true },
      complete: true,
      reward: 'scarf',
    });
  });

  test('a player from before the list existed gets the steps their history covers', async () => {
    await p.care('feed', T0 + 1000);
    await p.recordBattle('b1', 0, replay, { winner: 0, xp: [10, 5], loot: null }, 0, T0 + 2000);
    db.run("DELETE FROM profile WHERE k = 'firstDay'");
    expect((await p.view(T0 + 3000)).firstDay?.steps).toEqual({ feed: true, dress: false, plan: false, win: true });
  });

  test('house NPCs never get a list or a reward', async () => {
    const { p: npc } = makePlayer();
    await npc.init('npc:npc-carl', 'npc-carl');
    await npc.setupNpc('salt', T0, 200, { head: 'cap' }, {}, T0);
    await npc.care('feed', T0 + 1000);
    await npc.setTactics({}, T0 + 2000);
    await npc.recordBattle('b1', 0, replay, { winner: 0, xp: [10, 5], loot: null }, 0, T0 + 3000);
    const v = await npc.view(T0 + 3000);
    expect(v.firstDay).toBeNull();
    expect(v.inventory.map((i) => i.item)).not.toContain('scarf');
  });
});
