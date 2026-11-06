import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

export function openDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  return db;
}

export function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
}

export function listMigrations(directory = MIGRATIONS_DIR) {
  const migrations = new Map();
  for (const file of fs.readdirSync(directory).sort()) {
    const match = file.match(/^(\d+)_(.+)\.(up|down)\.sql$/);
    if (!match) continue;
    const version = Number(match[1]);
    const entry = migrations.get(version) || { version, name: match[2] };
    entry[match[3]] = path.join(directory, file);
    migrations.set(version, entry);
  }
  return [...migrations.values()].sort((a, b) => a.version - b.version);
}

export function appliedVersions(db) {
  ensureMigrationTable(db);
  return new Set(
    db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => row.version)
  );
}

export function migrationStatus(db, directory = MIGRATIONS_DIR) {
  const applied = appliedVersions(db);
  return listMigrations(directory).map((migration) => ({
    version: migration.version,
    name: migration.name,
    applied: applied.has(migration.version),
  }));
}

export function migrate(db, { directory = MIGRATIONS_DIR, target = Number.POSITIVE_INFINITY } = {}) {
  ensureMigrationTable(db);
  const applied = appliedVersions(db);
  const pending = listMigrations(directory).filter(
    (migration) => !applied.has(migration.version) && migration.version <= target
  );
  const ran = [];
  for (const migration of pending) {
    if (!migration.up) throw new Error(`migration ${migration.version} has no up file`);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(fs.readFileSync(migration.up, "utf8"));
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
      ).run(migration.version, migration.name, Date.now());
      db.exec("COMMIT");
      ran.push(migration.version);
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${migration.version} failed: ${error.message}`, {
        cause: error,
      });
    }
  }
  return ran;
}

export function rollback(db, { directory = MIGRATIONS_DIR, steps = 1 } = {}) {
  ensureMigrationTable(db);
  const migrations = listMigrations(directory);
  const applied = appliedVersions(db);
  const candidates = migrations
    .filter((migration) => applied.has(migration.version))
    .sort((a, b) => b.version - a.version)
    .slice(0, steps);
  const rolledBack = [];
  for (const migration of candidates) {
    if (!migration.down) {
      throw new Error(
        `migration ${migration.version} is not reversible because no down file exists`
      );
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(fs.readFileSync(migration.down, "utf8"));
      db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(migration.version);
      db.exec("COMMIT");
      rolledBack.push(migration.version);
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`rollback ${migration.version} failed: ${error.message}`, {
        cause: error,
      });
    }
  }
  return rolledBack;
}
