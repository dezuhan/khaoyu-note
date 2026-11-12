import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";
import { migrate, MIGRATIONS_DIR, openDatabase } from "../src/db.mjs";
import { runMaintenance } from "../src/worker.mjs";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "khaoyu-worker-"));
}

test("maintenance expires invitations and share links and records worker status", async () => {
  const dir = tempDir();
  const db = openDatabase(path.join(dir, "test.db"));
  migrate(db, { directory: MIGRATIONS_DIR });
  const now = Date.now();
  const accountId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  await db.run(
    "INSERT INTO accounts (id, email, display_name, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [accountId, "worker@example.com", "Worker", now, now, now]
  );
  await db.run(
    "INSERT INTO projects (id, owner_account_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [projectId, accountId, "Worker project", now, now]
  );
  await db.run(
    "INSERT INTO project_invitations (id, project_id, email, role, token_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, 'viewer', ?, ?, ?, ?)",
    [crypto.randomUUID(), projectId, "pending@example.com", crypto.randomUUID(), accountId, now, now - 1000]
  );
  await db.run(
    "INSERT INTO share_links (id, project_id, scope, permission, token_hash, created_by, created_at, expires_at) VALUES (?, ?, 'project', 'view', ?, ?, ?, ?)",
    [crypto.randomUUID(), projectId, crypto.randomUUID(), accountId, now, now - 1000]
  );
  for (let seq = 1; seq <= 5; seq += 1) {
    await db.run(
      "INSERT INTO project_ops (project_id, seq, op_id, actor_account_id, type, payload, created_at) VALUES (?, ?, ?, ?, 'doc.title', ?, ?)",
      [projectId, seq, `worker-op-${seq}`, accountId, JSON.stringify({ title: `t${seq}` }), now]
    );
  }
  await db.run(
    "INSERT INTO service_meta (key, value) VALUES ('last_backup_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [String(now)]
  );
  const logger = { info() {}, warn() {}, error() {} };
  const result = await runMaintenance(db, {
    dataDir: dir,
    tempDir: path.join(dir, "tmp"),
    objectsDir: path.join(dir, "objects"),
    backupsDir: path.join(dir, "backups"),
    outboxDir: path.join(dir, "outbox"),
    tempMaxAgeHours: 24,
    auditRetentionDays: 90,
    compactOps: 2,
    opRetentionDays: 7,
    backupIntervalHours: 24,
    backupRetention: 2,
    objectEncryptionKey: "worker-object-key-0123456789abcdef",
  }, logger);
  assert.equal(result.tokens.expiredInvitations, 1);
  assert.equal(result.tokens.expiredShareLinks, 1);
  assert.equal(result.compactedOps, 3);
  assert.equal(Number((await db.get("SELECT COUNT(*) AS count FROM project_ops")).count), 2);
  const invitation = await db.get("SELECT revoked_at FROM project_invitations");
  const share = await db.get("SELECT revoked_at FROM share_links");
  assert.ok(invitation.revoked_at);
  assert.ok(share.revoked_at);
  const lastWorker = await db.get("SELECT value FROM service_meta WHERE key = 'last_worker_at'");
  assert.ok(Number(lastWorker.value) > 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
