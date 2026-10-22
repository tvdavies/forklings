// bun:sqlite behind the small interface the Durable Object's SqlStorage provides, so the
// wallet runs on real SQLite (transactions, constraints, rollbacks) in unit tests.
import { Database } from 'bun:sqlite';
import { type Sql, Wallet } from '../../src/worker/wallet';

export function makeWallet(db = new Database(':memory:')) {
  const sql: Sql = {
    exec(query, ...bindings) {
      const parts = query.split(';').filter((q) => q.trim());
      if (parts.length > 1) {
        for (const q of parts) db.run(q);
        return { toArray: () => [], rowsWritten: 0 };
      }
      const st = db.prepare(query);
      if (/^\s*(SELECT|WITH)/i.test(query)) {
        // biome-ignore lint/suspicious/noExplicitAny: test adapter between two SQL APIs
        const rows = st.all(...(bindings as any[]));
        // biome-ignore lint/suspicious/noExplicitAny: test adapter between two SQL APIs
        return { toArray: () => rows as any[], rowsWritten: 0 };
      }
      // biome-ignore lint/suspicious/noExplicitAny: test adapter between two SQL APIs
      const r = st.run(...(bindings as any[]));
      return { toArray: () => [], rowsWritten: r.changes };
    },
  };
  const w = new Wallet(sql, (fn) => db.transaction(fn)());
  return { w, db };
}
