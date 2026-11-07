import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { openDatabase, migrate, rollback, migrationStatus, MIGRATIONS_DIR } from "./db.mjs";
import { createBackup, restoreBackup } from "./backup.mjs";
import { writeAudit } from "./audit.mjs";
import { hashPassword } from "./auth/passwords.mjs";

function usage() {
  console.log(`Khaoyu Note service

  node src/cli.mjs migrate
  node src/cli.mjs rollback [--steps 1]
  node src/cli.mjs status
  node src/cli.mjs backup
  node src/cli.mjs restore <backup-directory> [--force]
  node src/cli.mjs bootstrap
  node src/cli.mjs invalidate-sessions

Environment: KHAOYU_SERVICE_* variables. See .env.example.`);
}

function prepareData(config) {
  for (const directory of [config.dataDir, config.objectsDir, config.tempDir, config.backupsDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function open(config) {
  prepareData(config);
  return openDatabase(config.databasePath);
}

function bootstrap(config, db, password) {
  const email = (process.env.KHAOYU_BOOTSTRAP_EMAIL || "owner@localhost").trim().toLowerCase();
  const name = (process.env.KHAOYU_BOOTSTRAP_NAME || "Owner").trim();
  const projectName = (process.env.KHAOYU_BOOTSTRAP_PROJECT || "Khaoyu Note").trim();
  let account = db.prepare("SELECT id, email FROM accounts WHERE email = ?").get(email);
  let createdAccount = false;
  if (!account) {
    account = { id: crypto.randomUUID(), email };
    const now = Date.now();
    db.prepare(
      "INSERT INTO accounts (id, email, display_name, password_hash, email_verified_at, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'admin', ?, ?)"
    ).run(account.id, email, name, password.hash, now, now, now);
    createdAccount = true;
  } else {
    db.prepare(
      "UPDATE accounts SET password_hash = COALESCE(password_hash, ?), email_verified_at = COALESCE(email_verified_at, ?), role = 'admin', updated_at = ? WHERE id = ?"
    ).run(password.hash, Date.now(), Date.now(), account.id);
  }
  let project = db.prepare("SELECT id, name FROM projects WHERE owner_account_id = ? AND name = ?").get(
    account.id,
    projectName
  );
  let createdProject = false;
  if (!project) {
    project = { id: crypto.randomUUID(), name: projectName };
    const now = Date.now();
    db.prepare(
      "INSERT INTO projects (id, owner_account_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run(project.id, account.id, project.name, now, now);
    db.prepare(
      "INSERT INTO project_members (project_id, account_id, role, created_at) VALUES (?, ?, 'owner', ?)"
    ).run(project.id, account.id, now);
    db.prepare(
      "INSERT INTO project_snapshots (project_id, revision, doc, updated_by, updated_at) VALUES (?, 1, ?, ?, ?)"
    ).run(
      project.id,
      JSON.stringify({
        id: project.id,
        title: project.name,
        parentId: null,
        cards: [],
        connections: [],
        trash: [],
      }),
      account.id,
      now
    );
    createdProject = true;
  }
  writeAudit(db, {
    actorAccountId: account.id,
    action: "service.bootstrap",
    resourceType: "project",
    resourceId: project.id,
    metadata: { createdAccount, createdProject },
    secret: config.secret,
  });
  return { account, project, createdAccount, createdProject };
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    usage();
    return;
  }
  const config = loadConfig();
  return run(command, args, config);
}

async function run(command, args, config) {
  if (command === "migrate") {
    const db = open(config);
    const ran = migrate(db, { directory: MIGRATIONS_DIR });
    db.close();
    console.log(JSON.stringify({ migrated: ran }, null, 2));
    return;
  }
  if (command === "rollback") {
    const index = args.indexOf("--steps");
    const steps = index >= 0 ? Number(args[index + 1]) : 1;
    if (!Number.isInteger(steps) || steps < 1) throw new Error("--steps must be a positive integer");
    const db = open(config);
    const rolled = rollback(db, { directory: MIGRATIONS_DIR, steps });
    db.close();
    console.log(JSON.stringify({ rolledBack: rolled }, null, 2));
    return;
  }
  if (command === "status") {
    const db = open(config);
    const status = migrationStatus(db, MIGRATIONS_DIR);
    db.close();
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  if (command === "backup") {
    const db = open(config);
    const backup = createBackup(db, config);
    db.close();
    console.log(backup.directory);
    return;
  }
  if (command === "restore") {
    const directory = args.find((value) => !value.startsWith("--"));
    if (!directory) throw new Error("restore needs a backup directory");
    const result = restoreBackup({
      backupDirectory: path.resolve(directory),
      dataDir: config.dataDir,
      force: args.includes("--force"),
      passphrase: config.backupPassphrase || null,
    });
    console.log(JSON.stringify({ restored: true, safety: result.safety }, null, 2));
    return;
  }
  if (command === "invalidate-sessions") {
    const db = open(config);
    const now = Date.now();
    const sessions = db
      .prepare("UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL")
      .run(now).changes;
    db.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE revoked_at IS NULL").run(now);
    db.prepare("UPDATE access_tokens SET revoked_at = ? WHERE revoked_at IS NULL").run(now);
    db.close();
    console.log(JSON.stringify({ revokedSessions: Number(sessions) }, null, 2));
    return;
  }
  if (command === "bootstrap") {
    const raw = process.env.KHAOYU_BOOTSTRAP_PASSWORD || "";
    if (raw.length < 12 || raw.length > 200) {
      throw new Error("KHAOYU_BOOTSTRAP_PASSWORD must be between 12 and 200 characters");
    }
    const db = open(config);
    const result = bootstrap(config, db, { hash: await hashPassword(raw) });
    db.close();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  usage();
  process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
