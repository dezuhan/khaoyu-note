import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { createLogger } from "../src/logger.mjs";
import { openDatabase, migrate, rollback, migrationStatus, MIGRATIONS_DIR } from "../src/db.mjs";
import { ObjectStore } from "../src/objects.mjs";
import { writeAudit } from "../src/audit.mjs";
import { createBackup, restoreBackup } from "../src/backup.mjs";
import { runMaintenance } from "../src/worker.mjs";
import { createService } from "../src/app.mjs";
import { assertSchemaCurrent } from "../src/app.mjs";
import { logPath } from "../src/app.mjs";

const SECRET = "Kx9-vQ2m-Rt7-pL4s-Wb8-nC3d-Hf6-jZ1a";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "khaoyu-service-"));
}

function configFor(dataDir) {
  return {
    profile: "single-user",
    host: "127.0.0.1",
    port: 0,
    publicUrl: "http://127.0.0.1:0",
    dataDir,
    secret: SECRET,
    databasePath: path.join(dataDir, "khaoyu-service.db"),
    objectsDir: path.join(dataDir, "objects"),
    tempDir: path.join(dataDir, "tmp"),
    backupsDir: path.join(dataDir, "backups"),
    outboxDir: path.join(dataDir, "outbox"),
    cookieSecure: false,
    trustProxy: false,
    accessTtlMinutes: 15,
    refreshTtlDays: 7,
    deletionGraceDays: 30,
    loginWindowMinutes: 15,
    loginMaxAttempts: 5,
    backupIntervalHours: 24,
    backupRetention: 2,
    auditRetentionDays: 90,
    tempMaxAgeHours: 1,
  };
}

const quietLogger = createLogger({ write() {} });

test("configuration fails closed for weak secrets", () => {
  assert.throws(
    () => loadConfig({ KHAOYU_SERVICE_SECRET: "short" }),
    /at least 32 characters/
  );
  assert.throws(
    () => loadConfig({ KHAOYU_SERVICE_SECRET: "replace-with-a-very-long-placeholder-value" }),
    /placeholder/
  );
  const config = loadConfig({ KHAOYU_SERVICE_SECRET: SECRET, KHAOYU_SERVICE_DATA_DIR: tempDir() });
  assert.equal(config.profile, "single-user");
  assert.equal(config.port, 8080);
});

test("migrations are reversible and recreate the schema", () => {
  const dataDir = tempDir();
  const config = configFor(dataDir);
  const db = openDatabase(config.databasePath);
  assert.deepEqual(
    migrationStatus(db).map((entry) => entry.applied),
    [false, false, false]
  );
  assert.deepEqual(migrate(db, { directory: MIGRATIONS_DIR }), [1, 2, 3]);
  assert.deepEqual(
    migrationStatus(db).map((entry) => entry.applied),
    [true, true, true]
  );
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  for (const table of [
    "accounts",
    "projects",
    "project_members",
    "audit_log",
    "objects",
    "sessions",
    "access_tokens",
    "refresh_tokens",
    "email_tokens",
    "login_attempts",
  ]) {
    assert.ok(tables.includes(table), `${table} missing`);
  }
  assert.deepEqual(rollback(db, { directory: MIGRATIONS_DIR, steps: 3 }), [3, 2, 1]);
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'accounts'").get(),
    undefined
  );
  migrate(db, { directory: MIGRATIONS_DIR });
  db.close();
});

test("share tokens are redacted from request logs", () => {
  assert.equal(
    logPath("/api/v1/share/khn_share_supersecret/access"),
    "/api/v1/share/[redacted]/access"
  );
  assert.equal(logPath("/api/v1/projects"), "/api/v1/projects");
});

test("the server refuses to start while a migration is pending", () => {
  const dataDir = tempDir();
  const config = configFor(dataDir);
  const db = openDatabase(config.databasePath);
  assert.throws(() => assertSchemaCurrent(db), /pending migration/);
  migrate(db, { directory: MIGRATIONS_DIR });
  assert.doesNotThrow(() => assertSchemaCurrent(db));
  db.close();
});

test("object storage uses opaque content-addressed keys and deduplicates", () => {
  const dataDir = tempDir();
  const config = configFor(dataDir);
  const db = openDatabase(config.databasePath);
  migrate(db, { directory: MIGRATIONS_DIR });
  const store = new ObjectStore(db, config.objectsDir);
  const body = Buffer.from("hello service");
  const first = store.store(body, "text/plain");
  const second = store.store(body, "text/plain");
  assert.equal(first.id, second.id);
  assert.equal(second.deduplicated, true);
  assert.match(first.storage_key, /^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(path.join(config.objectsDir, first.storage_key)));
  assert.deepEqual(store.get(first.id).body, body);
  assert.equal(store.get("missing"), null);
  db.close();
});

test("audit entries hash IP addresses and keep JSON metadata", () => {
  const dataDir = tempDir();
  const config = configFor(dataDir);
  const db = openDatabase(config.databasePath);
  migrate(db, { directory: MIGRATIONS_DIR });
  writeAudit(db, {
    action: "project.test",
    resourceType: "project",
    resourceId: "p1",
    ip: "203.0.113.5",
    metadata: { note: "hello" },
    secret: config.secret,
  });
  const row = db.prepare("SELECT ip_hash, metadata FROM audit_log").get();
  assert.equal(row.ip_hash.length, 64);
  assert.notEqual(row.ip_hash, "203.0.113.5");
  assert.equal(JSON.parse(row.metadata).note, "hello");
  db.close();
});

test("backup and restore round-trip the database and objects", () => {
  const dataDir = tempDir();
  const config = configFor(dataDir);
  let db = openDatabase(config.databasePath);
  migrate(db, { directory: MIGRATIONS_DIR });
  db.prepare("INSERT INTO service_meta (key, value) VALUES ('check', 'before')").run();
  const store = new ObjectStore(db, config.objectsDir);
  const object = store.store(Buffer.from("asset"), "text/plain");
  const backup = createBackup(db, config);
  db.prepare("UPDATE service_meta SET value = 'after' WHERE key = 'check'").run();
  db.close();

  const result = restoreBackup({
    backupDirectory: backup.directory,
    dataDir,
    force: true,
  });
  assert.ok(fs.existsSync(result.safety));
  db = openDatabase(config.databasePath);
  const restored = db.prepare("SELECT value FROM service_meta WHERE key = 'check'").get();
  assert.equal(restored.value, "before");
  const restoredStore = new ObjectStore(db, config.objectsDir);
  assert.deepEqual(restoredStore.get(object.id).body, Buffer.from("asset"));
  db.close();
});

test("worker cleans old temp files and creates a due backup", () => {
  const dataDir = tempDir();
  const config = configFor(dataDir);
  config.backupIntervalHours = 1;
  fs.mkdirSync(config.tempDir, { recursive: true });
  const db = openDatabase(config.databasePath);
  migrate(db, { directory: MIGRATIONS_DIR });
  const old = path.join(config.tempDir, "old.tmp");
  fs.writeFileSync(old, "old");
  const oldTime = new Date(Date.now() - 3 * 3600_000);
  fs.utimesSync(old, oldTime, oldTime);
  const result = runMaintenance(db, config, quietLogger);
  assert.equal(result.tempRemoved, 1);
  assert.ok(result.backup);
  assert.ok(fs.existsSync(path.join(result.backup.directory, "manifest.json")));
  assert.ok(db.prepare("SELECT value FROM service_meta WHERE key = 'last_backup_at'").get());
  db.close();
});

test("health endpoints expose no version, database or configuration", async () => {
  const dataDir = tempDir();
  const config = configFor(dataDir);
  const db = openDatabase(config.databasePath);
  migrate(db, { directory: MIGRATIONS_DIR });
  const server = createService({ config, db, logger: quietLogger });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");
  const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
  assert.deepEqual(await ready.json(), { status: "ready" });
  const missing = await fetch(`http://127.0.0.1:${port}/does-not-exist`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not found" });
  await new Promise((resolve) => server.close(resolve));
  db.close();
});
