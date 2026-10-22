// A player's bits: an append-only ledger in the player's own SQLite (Durable Object storage).
// Every entry has a unique key naming what it pays for (a battle side, a day's first win,
// a level, a purchase request), so retrying any request can never pay or charge twice.
// Pure TypeScript over a minimal SQL interface: the Durable Object passes its SqlStorage,
// the tests pass bun:sqlite.
import { battleBits, checkPurchase, levelUpReward, type PurchaseCheck, REWARDS, utcDay, welcomeBits } from '../shared/economy';

type Row = Record<string, SqlStorageValue>;
/** The part of Durable Object SqlStorage the wallet uses. */
export interface Sql {
  exec<T extends Row>(query: string, ...bindings: (string | number | null)[]): { toArray(): T[]; readonly rowsWritten: number };
}
/** Runs `fn` as one transaction: all of its writes happen, or none do. */
export type Tx = <T>(fn: () => T) => T;

export type LedgerKind = 'start' | 'battle' | 'first-win' | 'care' | 'level' | 'evolve' | 'buy';
export type LedgerRow = {
  seq: number;
  key: string;
  at: number;
  day: string;
  delta: number;
  kind: LedgerKind;
  ref: string;
  balance: number;
};
type BalanceRow = { balance: number };
type CountRow = { n: number };
type MetaRow = { v: number };

export interface Today {
  day: string;
  /** Battles that paid full bits today, out of `REWARDS.fullBattlesPerDay`. */
  battles: number;
  firstWin: boolean;
  care: boolean;
  earned: number;
}

export type BuyResult =
  | { ok: true; balance: number; item: string; replay: boolean }
  | ({ ok: false; balance: number } & ({ code: 'request' | 'gone'; error: string } | Extract<PurchaseCheck, { ok: false }>));

/** Purchase request ids come from the client (one per tap) and make retries safe. */
export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export class Wallet {
  /** Entries posted since the last drain, for the analytics mirror in D1. */
  pending: LedgerRow[] = [];
  private depth = 0;

  constructor(
    private sql: Sql,
    private tx: Tx,
  ) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS ledger (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, at INTEGER NOT NULL,
        day TEXT NOT NULL, delta INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, balance INTEGER NOT NULL CHECK (balance >= 0));
      CREATE INDEX IF NOT EXISTS ledger_day ON ledger(day, kind);
      CREATE TABLE IF NOT EXISTS wallet_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
    `);
  }

  balance(): number {
    return this.sql.exec<BalanceRow>('SELECT balance FROM ledger ORDER BY seq DESC LIMIT 1').toArray()[0]?.balance ?? 0;
  }
  has(key: string): boolean {
    return this.sql.exec('SELECT 1 FROM ledger WHERE key = ?', key).toArray().length > 0;
  }
  get opened(): boolean {
    return this.has('start');
  }
  /** One transaction around `fn`; calls nested inside it join the outer one. */
  private atomic<T>(fn: () => T): T {
    if (this.depth) return fn();
    const mark = this.pending.length;
    this.depth++;
    try {
      return this.tx(fn);
    } catch (e) {
      this.pending.length = mark; // rolled back: those entries never happened
      throw e;
    } finally {
      this.depth--;
    }
  }

  private meta(k: string): number | null {
    return this.sql.exec<MetaRow>('SELECT v FROM wallet_meta WHERE k = ?', k).toArray()[0]?.v ?? null;
  }

  /**
   * Append one entry, unless its key was used before (then nothing happens and it returns null).
   * Runs in a transaction; a debit that would take the balance below zero throws and changes nothing.
   */
  private post(key: string, delta: number, kind: LedgerKind, ref: string, now: number): LedgerRow | null {
    return this.atomic(() => {
      if (this.has(key)) return null;
      const balance = this.balance() + delta;
      if (balance < 0) throw new Error(`ledger: ${key} would overdraw`);
      this.sql.exec(
        'INSERT INTO ledger (key, at, day, delta, kind, ref, balance) VALUES (?, ?, ?, ?, ?, ?, ?)',
        key,
        now,
        utcDay(now),
        delta,
        kind,
        ref,
        balance,
      );
      const row = this.sql.exec<LedgerRow>('SELECT * FROM ledger WHERE key = ?', key).toArray()[0];
      this.pending.push(row);
      return row;
    });
  }

  /**
   * Open the wallet once. `level` and `stage` are the creature's now: a new Forkling gets the
   * usual start, an older one a welcome scaled by level, and only later levels and stages pay.
   */
  open(level: number, stage: number, now: number): LedgerRow | null {
    if (this.opened) return null;
    return this.atomic(() => {
      this.sql.exec('INSERT OR IGNORE INTO wallet_meta (k, v) VALUES (?, ?), (?, ?)', 'baseLevel', level, 'baseStage', stage);
      return this.post('start', welcomeBits(level), 'start', `level ${level}`, now);
    });
  }

  /** Bits for one side of a battle, plus the day's first-win bonus. Safe to call again for the same battle. */
  battle(id: string, side: 0 | 1, outcome: 'win' | 'loss' | 'draw', now: number): LedgerRow[] {
    const day = utcDay(now);
    const out: LedgerRow[] = [];
    this.atomic(() => {
      const paid =
        this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM ledger WHERE day = ? AND kind = 'battle' AND delta > 0", day).toArray()[0]?.n ??
        0;
      let bits = battleBits(side, outcome);
      if (paid >= REWARDS.fullBattlesPerDay) bits = outcome === 'win' ? Math.min(bits, REWARDS.taperedWin) : 0;
      const b = this.post(`battle:${id}:${side}`, bits, 'battle', id, now);
      if (b) out.push(b);
      // Only once the battle itself was new: a replayed battle can't claim the bonus either.
      if (b && outcome === 'win') {
        const fw = this.post(`first-win:${day}`, REWARDS.firstWinOfDay, 'first-win', id, now);
        if (fw) out.push(fw);
      }
    });
    return out;
  }

  /** Once a day, for care that leaves the Forkling fed, happy and rested. */
  care(stats: { fullness: number; mood: number; energy: number }, now: number): LedgerRow | null {
    const min = REWARDS.careBonusMin;
    if (stats.fullness < min || stats.mood < min || stats.energy < min) return null;
    return this.post(`care:${utcDay(now)}`, REWARDS.dailyCare, 'care', 'daily care', now);
  }

  /** Bits for each level above `from` up to `to`, once each, and never for levels held before the wallet opened. */
  levels(from: number, to: number, now: number): LedgerRow[] {
    const base = this.meta('baseLevel') ?? 1;
    const out: LedgerRow[] = [];
    for (let l = Math.max(from, base) + 1; l <= to; l++) {
      const r = this.post(`level:${l}`, levelUpReward(l), 'level', `level ${l}`, now);
      if (r) out.push(r);
    }
    return out;
  }

  /** Bits for evolving into `stage`, once, unless it was reached before the wallet opened. */
  evolve(stage: number, now: number): LedgerRow | null {
    const base = this.meta('baseStage') ?? 0;
    const bits = REWARDS.evolve[stage] ?? 0;
    if (stage <= base || !bits) return null;
    return this.post(`evolve:${stage}`, bits, 'evolve', `stage ${stage}`, now);
  }

  /**
   * Buy an item: check, charge and grant in one transaction. `grant` adds it to the wardrobe.
   * The same request id always gets the same answer and charges at most once.
   */
  buy(
    requestId: unknown,
    offer: { id: string; level: number; price: number },
    me: { level: number; owns: (id: string) => boolean },
    grant: () => void,
    now: number,
  ): BuyResult {
    if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId))
      return { ok: false, code: 'request', error: 'Bad purchase request. Reload and try again.', balance: this.balance() };
    const key = `buy:${requestId}`;
    return this.atomic((): BuyResult => {
      const prior = this.sql.exec<LedgerRow>('SELECT * FROM ledger WHERE key = ?', key).toArray()[0];
      if (prior) {
        if (prior.ref !== offer.id)
          return { ok: false, code: 'request', error: 'That purchase request was already used.', balance: this.balance() };
        return { ok: true, balance: this.balance(), item: offer.id, replay: true };
      }
      const balance = this.balance();
      const check = checkPurchase(offer, { level: me.level, bits: balance, owned: me.owns(offer.id) });
      if (!check.ok) return { ...check, balance };
      this.post(key, -offer.price, 'buy', offer.id, now);
      grant();
      return { ok: true, balance: this.balance(), item: offer.id, replay: false };
    });
  }

  today(now: number): Today {
    const day = utcDay(now);
    const rows = this.sql.exec<LedgerRow>("SELECT * FROM ledger WHERE day = ? AND kind != 'buy'", day).toArray();
    return {
      day,
      battles: rows.filter((r) => r.kind === 'battle' && r.delta > 0).length,
      firstWin: rows.some((r) => r.kind === 'first-win'),
      care: rows.some((r) => r.kind === 'care'),
      earned: rows.reduce((s, r) => s + (r.kind === 'start' ? 0 : r.delta), 0),
    };
  }

  recent(limit = 20): LedgerRow[] {
    return this.sql.exec<LedgerRow>('SELECT * FROM ledger ORDER BY seq DESC LIMIT ?', limit).toArray();
  }

  drain(): LedgerRow[] {
    const p = this.pending;
    this.pending = [];
    return p;
  }
}
