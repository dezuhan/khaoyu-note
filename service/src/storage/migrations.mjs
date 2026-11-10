import fs from "node:fs";
import path from "node:path";

// Async migration runner shared by SQLite and PostgreSQL. The existing `db.mjs` runner stays for the
// single-user path until the service runtime is switched over; this module is the foundation for the
// dialect-aware CLI and the PostgreSQL baseline.

export function listMigrations(directory) {
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

export async function ensureMigrationTable(storage) {
  await storage.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at BIGINT NOT NULL
    )
  `);
}

export async function appliedVersions(storage) {
  await ensureMigrationTable(storage);
  return new Set(
    (await storage.all("SELECT version FROM schema_migrations ORDER BY version")).map((row) =>
      Number(row.version)
    )
  );
}

export async function migrationStatus(storage, directory) {
  const applied = await appliedVersions(storage);
  return listMigrations(directory).map((migration) => ({
    version: migration.version,
    name: migration.name,
    applied: applied.has(migration.version),
  }));
}

export async function migrate(storage, { directory, target = Number.POSITIVE_INFINITY } = {}) {
  if (!directory) throw new Error("migration directory is required");
  const applied = await appliedVersions(storage);
  const pending = listMigrations(directory).filter(
    (migration) => !applied.has(migration.version) && migration.version <= target
  );
  const ran = [];
  for (const migration of pending) {
    if (!migration.up) throw new Error(`migration ${migration.version} has no up file`);
    await storage.transaction(async (tx) => {
      await tx.exec(fs.readFileSync(migration.up, "utf8"));
      await tx.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", [
        migration.version,
        migration.name,
        Date.now(),
      ]);
    });
    ran.push(migration.version);
  }
  return ran;
}

export async function rollback(storage, { directory, steps = 1 } = {}) {
  if (!directory) throw new Error("migration directory is required");
  const applied = await appliedVersions(storage);
  const migrations = listMigrations(directory);
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
    await storage.transaction(async (tx) => {
      await tx.exec(fs.readFileSync(migration.down, "utf8"));
      await tx.run("DELETE FROM schema_migrations WHERE version = ?", [migration.version]);
    });
    rolledBack.push(migration.version);
  }
  return rolledBack;
}
