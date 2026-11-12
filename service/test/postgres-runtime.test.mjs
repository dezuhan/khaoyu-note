import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createService } from "../src/app.mjs";
import { createFileMailer } from "../src/auth/mailer.mjs";
import { createLogger } from "../src/logger.mjs";
import { POSTGRES_MIGRATIONS_DIR } from "../src/db.mjs";
import { openPostgresStorage } from "../src/storage/postgres.mjs";
import { migrate, rollback } from "../src/storage/migrations.mjs";
import { createPostgresBackup, restorePostgresBackup } from "../src/storage/backup-postgres.mjs";
import { ObjectStore } from "../src/objects.mjs";

async function resetPostgresSchema(storage) {
  await storage.exec("DROP SCHEMA IF EXISTS public CASCADE");
  await storage.exec("CREATE SCHEMA public");
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "khaoyu-pg-runtime-"));
}

function configFor(dataDir) {
  return {
    profile: "single-user",
    host: "127.0.0.1",
    port: 0,
    publicUrl: "http://127.0.0.1",
    dataDir,
    secret: "Kx9-vQ2m-Rt7-pL4s-Wb8-nC3d-Hf6-jZ1a",
    databasePath: path.join(dataDir, "unused.db"),
    objectsDir: path.join(dataDir, "objects"),
    tempDir: path.join(dataDir, "tmp"),
    backupsDir: path.join(dataDir, "backups"),
    outboxDir: path.join(dataDir, "outbox"),
    cookieSecure: false,
    publicSharingEnabled: true,
    corsOrigins: ["tauri://localhost"],
    trustProxy: false,
    passkeysEnabled: false,
    rpId: "localhost",
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

test(
  "the service routes run against PostgreSQL storage",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const db = await openPostgresStorage({
      databaseUrl: process.env.TEST_DATABASE_URL,
      databasePoolMax: 4,
    });
    const dataDir = tempDir();
    const config = configFor(dataDir);
    const logger = createLogger({ write() {} });
    const mailer = createFileMailer(config, logger);
    let server = null;
    try {
      await resetPostgresSchema(db);
      await migrate(db, { directory: POSTGRES_MIGRATIONS_DIR });

      server = createService({ config, db, logger, mailer });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      const jar = {};
      async function call(pathname, { method = "GET", body } = {}) {
        const headers = {};
        if (body !== undefined) headers["content-type"] = "application/json";
        if (jar.khaoyu_csrf) headers["x-csrf-token"] = jar.khaoyu_csrf;
        const cookie = Object.entries(jar)
          .map(([key, value]) => `${key}=${value}`)
          .join("; ");
        if (cookie) headers.cookie = cookie;
        const response = await fetch(base + pathname, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        for (const header of response.headers.getSetCookie?.() || []) {
          const [pair] = header.split(";");
          const index = pair.indexOf("=");
          if (index > 0) jar[pair.slice(0, index)] = pair.slice(index + 1);
        }
        const text = await response.text();
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = null;
        }
        return { status: response.status, body: parsed };
      }

      const email = `pg-runtime-${crypto.randomUUID()}@example.com`;
      const registered = await call("/api/v1/auth/register", {
        method: "POST",
        body: { email, password: "correct-horse-9", displayName: "PG runtime" },
      });
      assert.equal(registered.status, 202);
      assert.equal(
        (
          await call("/api/v1/auth/login", {
            method: "POST",
            body: { email, password: "correct-horse-9" },
          })
        ).status,
        200
      );
      const created = await call("/api/v1/projects", {
        method: "POST",
        body: { title: "PostgreSQL project" },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const projectId = created.body.id;
      const doc = { id: projectId, title: "First", cards: [], connections: [], trash: [] };
      const updated = await call(`/api/v1/projects/${projectId}/snapshot`, {
        method: "PUT",
        body: { doc: JSON.stringify(doc), revision: 1 },
      });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      const loaded = await call(`/api/v1/projects/${projectId}`);
      assert.equal(loaded.status, 200);
      assert.equal(JSON.parse(loaded.body.snapshot.doc).title, "First");
      assert.equal(Number(loaded.body.project.revision), 2);
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      await rollback(db, { directory: POSTGRES_MIGRATIONS_DIR, steps: 1 }).catch(() => {});
      await db.exec("DROP TABLE IF EXISTS schema_migrations").catch(() => {});
      await db.close().catch(() => {});
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
);

test(
  "PostgreSQL logical backups round-trip rows and objects",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const db = await openPostgresStorage({
      databaseUrl: process.env.TEST_DATABASE_URL,
      databasePoolMax: 4,
    });
    const dataDir = tempDir();
    const config = configFor(dataDir);
    try {
      await resetPostgresSchema(db);
      await migrate(db, { directory: POSTGRES_MIGRATIONS_DIR });

      const now = Date.now();
      await db.run(
        "INSERT INTO accounts (id, email, display_name, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        ["backup-a1", "backup@example.com", "Backup Owner", now, now, now]
      );
      await db.run(
        "INSERT INTO projects (id, owner_account_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ["backup-p1", "backup-a1", "Backup project", now, now]
      );
      await db.run(
        "INSERT INTO project_members (project_id, account_id, role, created_at) VALUES (?, ?, 'owner', ?)",
        ["backup-p1", "backup-a1", now]
      );
      await db.run(
        "INSERT INTO project_snapshots (project_id, revision, doc, updated_by, updated_at) VALUES (?, 1, ?, ?, ?)",
        ["backup-p1", JSON.stringify({ id: "backup-p1", title: "Backup", cards: [] }), "backup-a1", now]
      );
      const store = new ObjectStore(db, config.objectsDir);
      const object = await store.store(Buffer.from("backup object"), "text/plain");

      const backup = await createPostgresBackup(db, config);
      assert.equal(backup.manifest.dialect, "postgres");
      assert.equal(backup.manifest.database.tables.accounts, 1);
      const restored = await restorePostgresBackup({
        backupDirectory: backup.directory,
        databaseUrl: process.env.TEST_DATABASE_URL,
        objectsDir: config.objectsDir,
        force: true,
      });
      assert.equal(restored.tables.accounts, 1);
      assert.equal(
        (await db.get("SELECT display_name FROM accounts WHERE id = ?", ["backup-a1"])).display_name,
        "Backup Owner"
      );
      assert.equal(
        (await db.get("SELECT COUNT(*) AS count FROM project_snapshots")).count,
        1
      );
      assert.ok(fs.existsSync(path.join(config.objectsDir, object.storage_key)));
    } finally {
      await rollback(db, { directory: POSTGRES_MIGRATIONS_DIR, steps: 1 }).catch(() => {});
      await db.exec("DROP TABLE IF EXISTS schema_migrations").catch(() => {});
      await db.close().catch(() => {});
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
);
