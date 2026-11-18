// Regression test for the documented single-user setup path:
//   node service/src/cli.mjs migrate
//   node service/src/cli.mjs bootstrap
// A bootstrap failure here breaks the README quick start even when the HTTP service itself works.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(import.meta.dirname, "..", "..");

function runCli(args, env) {
  return spawnSync(process.execPath, ["service/src/cli.mjs", ...args], {
    cwd: root,
    env,
    encoding: "utf8",
  });
}

test("CLI migrate and bootstrap create the owner, workspace and project", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "khaoyu-cli-"));
  const env = {
    ...process.env,
    KHAOYU_SERVICE_DATA_DIR: dataDir,
    KHAOYU_SERVICE_SECRET: crypto.randomBytes(32).toString("hex"),
    KHAOYU_SERVICE_HOST: "127.0.0.1",
    KHAOYU_SERVICE_PORT: "18080",
    KHAOYU_SERVICE_COOKIE_SECURE: "false",
    KHAOYU_SERVICE_PUBLIC_URL: "http://127.0.0.1:18080",
    KHAOYU_BOOTSTRAP_EMAIL: "cli-owner@example.com",
    KHAOYU_BOOTSTRAP_PASSWORD: "cli-bootstrap-password-123",
  };
  try {
    const migrate = runCli(["migrate"], env);
    assert.equal(migrate.status, 0, migrate.stderr);

    const bootstrap = runCli(["bootstrap"], env);
    assert.equal(bootstrap.status, 0, bootstrap.stderr);
    assert.doesNotMatch(bootstrap.stderr, /now is not defined/);

    // Re-running bootstrap must stay idempotent instead of duplicating the owner or project.
    const again = runCli(["bootstrap"], env);
    assert.equal(again.status, 0, again.stderr);

    const db = new DatabaseSync(path.join(dataDir, "khaoyu-service.db"));
    try {
      const account = db
        .prepare("SELECT id, email, role FROM accounts WHERE email = ?")
        .get("cli-owner@example.com");
      assert.ok(account, "bootstrap creates the owner account");
      assert.equal(account.role, "admin");

      const membership = db
        .prepare("SELECT role, state FROM workspace_members WHERE account_id = ?")
        .get(account.id);
      assert.ok(membership, "bootstrap adds the owner to the default workspace");
      assert.equal(membership.role, "owner");
      assert.equal(membership.state, "active");

      const project = db
        .prepare("SELECT id, name FROM projects WHERE owner_account_id = ?")
        .get(account.id);
      assert.ok(project, "bootstrap creates the bootstrap project");
      assert.equal(project.name, "Khaoyu Note");
      const snapshot = db
        .prepare("SELECT revision FROM project_snapshots WHERE project_id = ?")
        .get(project.id);
      assert.equal(Number(snapshot?.revision), 1);

      const accounts = db.prepare("SELECT COUNT(*) AS count FROM accounts").get();
      const projects = db.prepare("SELECT COUNT(*) AS count FROM projects").get();
      assert.equal(Number(accounts.count), 1);
      assert.equal(Number(projects.count), 1);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
