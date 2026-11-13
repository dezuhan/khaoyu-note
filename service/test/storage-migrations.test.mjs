import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MIGRATIONS_DIR,
  POSTGRES_MIGRATIONS_DIR,
  migrate as migrateSqlite,
  openDatabase,
} from "../src/db.mjs";
import { openSqliteStorage } from "../src/storage/sqlite.mjs";
import { openPostgresStorage } from "../src/storage/postgres.mjs";
import {
  migrate as migrateStorage,
  migrationStatus,
  rollback as rollbackStorage,
} from "../src/storage/migrations.mjs";
import { copySqliteToPostgres } from "../src/storage/migrate-data.mjs";

async function resetPostgresSchema(storage) {
  await storage.exec("DROP SCHEMA IF EXISTS public CASCADE");
  await storage.exec("CREATE SCHEMA public");
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "khaoyu-migrations-"));
}

test("async migration runner applies and rolls back the SQLite schema", async () => {
  const db = await openSqliteStorage(path.join(tempDir(), "migrations.db"));
  try {
    assert.deepEqual(
      await migrateStorage(db, { directory: MIGRATIONS_DIR }),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]
    );
    const status = await migrationStatus(db, MIGRATIONS_DIR);
    assert.equal(status.length, 21);
    assert.equal(status.every((entry) => entry.applied), true);
    assert.deepEqual(await rollbackStorage(db, { directory: MIGRATIONS_DIR, steps: 21 }), [
      21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
    ]);
    assert.equal(
      await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'accounts'"),
      undefined
    );
  } finally {
    await db.close();
  }
});

test(
  "PostgreSQL baseline matches the SQLite table and column names",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const storage = await openPostgresStorage({
      databaseUrl: process.env.TEST_DATABASE_URL,
      databasePoolMax: 2,
    });
    const sqliteDir = tempDir();
    const sqlite = openDatabase(path.join(sqliteDir, "parity.db"));
    try {
      await resetPostgresSchema(storage);
      assert.deepEqual(await migrateStorage(storage, { directory: POSTGRES_MIGRATIONS_DIR }), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
      assert.equal(
        (await migrationStatus(storage, POSTGRES_MIGRATIONS_DIR))[0].applied,
        true
      );

      migrateSqlite(sqlite, { directory: MIGRATIONS_DIR });
      const sqliteTables = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'"
        )
        .all()
        .map((row) => row.name)
        .sort();
      const postgresTables = (
        await storage.all(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations' AND table_name NOT LIKE 'storage_probe_%'"
        )
      )
        .map((row) => row.table_name)
        .sort();
      assert.deepEqual(postgresTables, sqliteTables);

      for (const table of sqliteTables) {
        const sqliteColumns = sqlite
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => row.name)
          .sort();
        const postgresColumns = (
          await storage.all(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?",
            [table]
          )
        )
          .map((row) => row.column_name)
          .sort();
        assert.deepEqual(postgresColumns, sqliteColumns, `columns for ${table}`);
      }

      assert.deepEqual(await rollbackStorage(storage, { directory: POSTGRES_MIGRATIONS_DIR, steps: 9 }), [9, 8, 7, 6, 5, 4, 3, 2, 1]);
      assert.equal(
        await storage.get(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'accounts'"
        ),
        undefined
      );
    } finally {
      sqlite.close();
      await storage.exec("DROP TABLE IF EXISTS schema_migrations").catch(() => {});
      await storage.close();
      fs.rmSync(sqliteDir, { recursive: true, force: true });
    }
  }
);

test(
  "durable SQLite rows copy into the PostgreSQL schema",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const sqliteDir = tempDir();
    const sqlitePath = path.join(sqliteDir, "source.db");
    const sqlite = openDatabase(sqlitePath);
    const storage = await openPostgresStorage({
      databaseUrl: process.env.TEST_DATABASE_URL,
      databasePoolMax: 2,
    });
    let sqliteClosed = false;
    try {
      migrateSqlite(sqlite, { directory: MIGRATIONS_DIR });
      const now = Date.now();
      sqlite
        .prepare(
          "INSERT INTO accounts (id, email, display_name, password_hash, email_verified_at, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'admin', 'active', ?, ?)"
        )
        .run("a1", "owner@example.com", "Owner", "hash", now, now, now);
      sqlite
        .prepare(
          "INSERT INTO projects (id, owner_account_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run("p1", "a1", "Root", now, now);
      sqlite
        .prepare(
          "INSERT INTO projects (id, owner_account_id, name, parent_project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("p2", "a1", "Nested", "p1", now, now);
      sqlite
        .prepare(
          "INSERT INTO project_members (project_id, account_id, role, created_at) VALUES (?, ?, 'owner', ?)"
        )
        .run("p1", "a1", now);
      sqlite
        .prepare(
          "INSERT INTO project_members (project_id, account_id, role, created_at) VALUES (?, ?, 'owner', ?)"
        )
        .run("p2", "a1", now);
      sqlite
        .prepare(
          "INSERT INTO project_snapshots (project_id, revision, doc, updated_by, updated_at) VALUES (?, 1, ?, ?, ?)"
        )
        .run("p1", JSON.stringify({ id: "p1", title: "Root", cards: [], connections: [] }), "a1", now);
      sqlite
        .prepare(
          "INSERT INTO objects (id, sha256, bytes, content_type, storage_key, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("o1", "abc123", 3, "text/plain", "ab/c1/abc123", now);
      sqlite
        .prepare(
          "INSERT INTO project_assets (id, project_id, object_id, name, content_type, bytes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run("asset1", "p1", "o1", "note.txt", "text/plain", 3, "a1", now);
      sqlite
        .prepare(
          "INSERT INTO api_tokens (id, account_id, name, scopes, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("tok1", "a1", "desktop", JSON.stringify(["projects:read"]), "hash-token", now);
      sqlite
        .prepare(
          "INSERT INTO notifications (id, account_id, kind, title, resource_type, resource_id, created_at) VALUES (?, ?, ?, ?, 'project', ?, ?)"
        )
        .run("n1", "a1", "test", "Hello", "p1", now);
      sqlite
        .prepare(
          "INSERT INTO email_preferences (account_id, notifications, updated_at) VALUES (?, 1, ?)"
        )
        .run("a1", now);
      sqlite
        .prepare(
          "INSERT INTO audit_log (id, actor_account_id, action, resource_type, resource_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("log1", "a1", "project.created", "project", "p1", now);
      sqlite
        .prepare("INSERT INTO service_meta (key, value) VALUES (?, ?)")
        .run("last_backup_at", String(now));
      sqlite.close();
      sqliteClosed = true;

      await resetPostgresSchema(storage);
      await migrateStorage(storage, { directory: POSTGRES_MIGRATIONS_DIR });

      const report = await copySqliteToPostgres({
        sqlitePath,
        databaseUrl: process.env.TEST_DATABASE_URL,
        databasePoolMax: 2,
      });
      assert.equal(report.tables.accounts.copied, 1);
      assert.equal(report.tables.projects.copied, 2);
      assert.equal(report.tables.project_assets.copied, 1);
      assert.equal((await storage.get("SELECT parent_project_id FROM projects WHERE id = ?", ["p2"]))
        .parent_project_id, "p1");
      assert.equal(
        (await storage.get("SELECT display_name FROM accounts WHERE id = ?", ["a1"])).display_name,
        "Owner"
      );
      assert.equal(
        (await storage.get("SELECT name FROM project_assets WHERE id = ?", ["asset1"])).name,
        "note.txt"
      );
      assert.equal(
        (await storage.get("SELECT COUNT(*) AS count FROM project_members")).count,
        2
      );

      await rollbackStorage(storage, { directory: POSTGRES_MIGRATIONS_DIR, steps: 1 });
    } finally {
      if (!sqliteClosed) sqlite.close();
      await storage.exec("DROP TABLE IF EXISTS schema_migrations").catch(() => {});
      await storage.close();
      fs.rmSync(sqliteDir, { recursive: true, force: true });
    }
  }
);
