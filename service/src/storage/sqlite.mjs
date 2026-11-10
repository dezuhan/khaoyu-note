import { DatabaseSync } from "node:sqlite";

// Async storage facade over the built-in synchronous SQLite driver. The service is being moved to
// an async API so the same call sites can run on PostgreSQL; SQLite keeps its zero-dependency role
// for the single-user profile.
function makeApi(raw, { nested = false } = {}) {
  let closed = false;
  // node:sqlite returns null-prototype rows. Copy them so both dialects expose plain objects and
  // callers (and tests) do not depend on the driver's prototype choice.
  const plain = (row) => (row ? { ...row } : undefined);
  const api = {
    dialect: "sqlite",
    async get(sql, params = []) {
      return plain(raw.prepare(sql).get(...params));
    },
    async all(sql, params = []) {
      return raw.prepare(sql).all(...params).map(plain);
    },
    async run(sql, params = []) {
      const result = raw.prepare(sql).run(...params);
      return {
        changes: Number(result.changes || 0),
        lastInsertRowid:
          typeof result.lastInsertRowid === "bigint"
            ? Number(result.lastInsertRowid)
            : result.lastInsertRowid,
      };
    },
    async exec(sql) {
      raw.exec(sql);
    },
    async transaction(fn) {
      // A nested call joins the caller's transaction. Savepoints are not needed yet; the service
      // uses a single write transaction per request path.
      if (nested) return fn(api);
      raw.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(makeApi(raw, { nested: true }));
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          /* the driver already rolled back */
        }
        throw error;
      }
    },
    async close() {
      if (nested || closed) return;
      closed = true;
      raw.close();
    },
  };
  return api;
}

export async function openSqliteStorage(databasePath, { readOnly = false } = {}) {
  const raw = new DatabaseSync(databasePath, { readOnly });
  if (readOnly) {
    raw.exec("PRAGMA busy_timeout = 5000;");
  } else {
    raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }
  return makeApi(raw);
}
