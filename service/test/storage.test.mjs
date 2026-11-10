import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isUniqueViolation, openStorage, storageKind } from "../src/storage/index.mjs";
import { openSqliteStorage } from "../src/storage/sqlite.mjs";
import { openPostgresStorage, toPostgresPlaceholders } from "../src/storage/postgres.mjs";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "khaoyu-storage-"));
}

test("placeholder conversion keeps quoted strings and comments intact", () => {
  assert.equal(
    toPostgresPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?"),
    "SELECT * FROM t WHERE a = $1 AND b = $2"
  );
  assert.equal(
    toPostgresPlaceholders("SELECT '?' AS q, ? AS v -- ? stays\n/* ? stays */ AND c = ?"),
    "SELECT '?' AS q, $1 AS v -- ? stays\n/* ? stays */ AND c = $2"
  );
});

test("SQLite storage exposes an async get/all/run/transaction API", async () => {
  const db = await openSqliteStorage(path.join(tempDir(), "storage.db"));
  try {
    assert.equal(db.dialect, "sqlite");
    await db.exec("CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
    const inserted = await db.run("INSERT INTO items (id, name) VALUES (?, ?)", ["a", "one"]);
    assert.equal(inserted.changes, 1);
    assert.deepEqual(await db.get("SELECT id, name FROM items WHERE id = ?", ["a"]), {
      id: "a",
      name: "one",
    });
    assert.equal(await db.get("SELECT id FROM items WHERE id = ?", ["missing"]), undefined);
    assert.deepEqual(await db.all("SELECT id FROM items ORDER BY id"), [{ id: "a" }]);

    await db.transaction(async (tx) => {
      await tx.run("INSERT INTO items (id, name) VALUES (?, ?)", ["b", "two"]);
    });
    assert.equal((await db.all("SELECT id FROM items")).length, 2);

    await db.transaction(async (tx) => {
      await tx.transaction(async (inner) => {
        await inner.run("INSERT INTO items (id, name) VALUES (?, ?)", ["nested", "three"]);
      });
    });
    assert.equal((await db.all("SELECT id FROM items")).length, 3);

    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.run("INSERT INTO items (id, name) VALUES (?, ?)", ["c", "three"]);
        throw new Error("rollback please");
      }),
      /rollback please/
    );
    assert.equal(await db.get("SELECT id FROM items WHERE id = ?", ["c"]), undefined);

    let unique;
    try {
      await db.run("INSERT INTO items (id, name) VALUES (?, ?)", ["a", "duplicate"]);
    } catch (error) {
      unique = error;
    }
    assert.equal(isUniqueViolation(unique), true);
  } finally {
    await db.close();
  }
});

test("openStorage selects SQLite without a database URL", async () => {
  const config = { profile: "single-user", databasePath: path.join(tempDir(), "select.db") };
  assert.equal(storageKind(config), "sqlite");
  const db = await openStorage(config);
  try {
    assert.equal(db.dialect, "sqlite");
  } finally {
    await db.close();
  }
});

test("team profile fails closed without PostgreSQL and Redis", async () => {
  await assert.rejects(
    openStorage({ profile: "team", databasePath: path.join(tempDir(), "unused.db") }),
    /KHAOYU_SERVICE_DATABASE_URL/
  );
  await assert.rejects(
    openStorage({
      profile: "team",
      databasePath: path.join(tempDir(), "unused.db"),
      databaseUrl: "postgres://user:pass@127.0.0.1:5432/khaoyu",
    }),
    /KHAOYU_SERVICE_REDIS_URL/
  );
});

test(
  "PostgreSQL storage round-trips when TEST_DATABASE_URL is set",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const db = await openPostgresStorage({
      databaseUrl: process.env.TEST_DATABASE_URL,
      databasePoolMax: 2,
    });
    const table = `storage_probe_${process.pid}_${Date.now()}`;
    try {
      assert.equal(db.dialect, "postgres");
      await db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, name TEXT NOT NULL)`);
      await db.transaction(async (tx) => {
        await tx.run(`INSERT INTO ${table} (id, name) VALUES (?, ?)`, ["a", "one"]);
      });
      assert.deepEqual(await db.get(`SELECT id, name FROM ${table} WHERE id = ?`, ["a"]), {
        id: "a",
        name: "one",
      });
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.run(`INSERT INTO ${table} (id, name) VALUES (?, ?)`, ["b", "two"]);
          throw new Error("rollback please");
        }),
        /rollback please/
      );
      assert.equal(await db.get(`SELECT id FROM ${table} WHERE id = ?`, ["b"]), undefined);
      let unique;
      try {
        await db.run(`INSERT INTO ${table} (id, name) VALUES (?, ?)`, ["a", "duplicate"]);
      } catch (error) {
        unique = error;
      }
      assert.equal(isUniqueViolation(unique), true);
    } finally {
      await db.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
      await db.close();
    }
  }
);
