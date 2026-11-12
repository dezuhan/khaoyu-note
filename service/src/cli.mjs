import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { MIGRATIONS_DIR, POSTGRES_MIGRATIONS_DIR } from "./db.mjs";
import { createBackup, restoreBackup } from "./backup.mjs";
import { writeAudit } from "./audit.mjs";
import { hashPassword } from "./auth/passwords.mjs";
import { openPostgresStorage } from "./storage/postgres.mjs";
import { openStorage } from "./storage/index.mjs";
import {
  migrate as migrateStorage,
  rollback as rollbackStorage,
  migrationStatus as migrationStatusStorage,
} from "./storage/migrations.mjs";
import { copySqliteToPostgres } from "./storage/migrate-data.mjs";
import { createPostgresBackup, restorePostgresBackup } from "./storage/backup-postgres.mjs";

function usage() {
  console.log(`Khaoyu Note service

  node src/cli.mjs migrate
  node src/cli.mjs rollback [--steps 1]
  node src/cli.mjs status
  node src/cli.mjs migrate-postgres [--database-url <url>]
  node src/cli.mjs rollback-postgres [--steps 1] [--database-url <url>]
  node src/cli.mjs status-postgres [--database-url <url>]
  node src/cli.mjs migrate-to-postgres [--sqlite <path>] [--database-url <url>] [--dry-run]
  node src/cli.mjs bootstrap-postgres [--database-url <url>]
  node src/cli.mjs backup-postgres [--database-url <url>]
  node src/cli.mjs restore-postgres <backup-directory> [--force] [--database-url <url>]
  node src/cli.mjs invalidate-sessions-postgres [--database-url <url>]
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

async function open(config) {
  prepareData(config);
  return openStorage(config);
}

function postgresConfig(args, config) {
  const index = args.indexOf("--database-url");
  const databaseUrl =
    index >= 0 ? String(args[index + 1] || "") : String(config.databaseUrl || "");
  if (!databaseUrl) {
    throw new Error("--database-url or KHAOYU_SERVICE_DATABASE_URL is required");
  }
  return {
    databaseUrl,
    databaseSsl: config.databaseSsl,
    databasePoolMax: config.databasePoolMax,
  };
}

async function bootstrap(config, db, password) {
  const email = (process.env.KHAOYU_BOOTSTRAP_EMAIL || "owner@localhost").trim().toLowerCase();
  const name = (process.env.KHAOYU_BOOTSTRAP_NAME || "Owner").trim();
  const projectName = (process.env.KHAOYU_BOOTSTRAP_PROJECT || "Khaoyu Note").trim();
  let account = await db.get("SELECT id, email FROM accounts WHERE email = ?", [email]);
  let createdAccount = false;
  if (!account) {
    account = { id: crypto.randomUUID(), email };
    const now = Date.now();
    await db.run(
      "INSERT INTO accounts (id, email, display_name, password_hash, email_verified_at, role, approved_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'admin', ?, ?, ?)",
      [account.id, email, name, password.hash, now, now, now, now]
    );
    createdAccount = true;
  } else {
    await db.run(
      "UPDATE accounts SET password_hash = COALESCE(password_hash, ?), email_verified_at = COALESCE(email_verified_at, ?), role = 'admin', updated_at = ? WHERE id = ?",
      [password.hash, Date.now(), Date.now(), account.id]
    );
  }
  let project = await db.get(
    "SELECT id, name FROM projects WHERE owner_account_id = ? AND name = ?",
    [account.id, projectName]
  );
  let createdProject = false;
  if (!project) {
    project = { id: crypto.randomUUID(), name: projectName };
    const now = Date.now();
    await db.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO projects (id, owner_account_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [project.id, account.id, project.name, now, now]
      );
      await tx.run(
        "INSERT INTO project_members (project_id, account_id, role, created_at) VALUES (?, ?, 'owner', ?)",
        [project.id, account.id, now]
      );
      await tx.run(
        "INSERT INTO project_snapshots (project_id, revision, doc, updated_by, updated_at) VALUES (?, 1, ?, ?, ?)",
        [
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
          now,
        ]
      );
    });
    createdProject = true;
  }
  await writeAudit(db, {
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
    const db = await open(config);
    try {
      const directory = config.databaseUrl ? POSTGRES_MIGRATIONS_DIR : MIGRATIONS_DIR;
      const ran = await migrateStorage(db, { directory });
      console.log(JSON.stringify({ migrated: ran }, null, 2));
    } finally {
      await db.close();
    }
    return;
  }
  if (command === "migrate-postgres") {
    const db = await openPostgresStorage(postgresConfig(args, config));
    try {
      const ran = await migrateStorage(db, { directory: POSTGRES_MIGRATIONS_DIR });
      console.log(JSON.stringify({ dialect: "postgres", migrated: ran }, null, 2));
    } finally {
      await db.close();
    }
    return;
  }
  if (command === "rollback-postgres") {
    const index = args.indexOf("--steps");
    const steps = index >= 0 ? Number(args[index + 1]) : 1;
    if (!Number.isInteger(steps) || steps < 1) throw new Error("--steps must be a positive integer");
    const db = await openPostgresStorage(postgresConfig(args, config));
    try {
      const rolled = await rollbackStorage(db, {
        directory: POSTGRES_MIGRATIONS_DIR,
        steps,
      });
      console.log(JSON.stringify({ dialect: "postgres", rolledBack: rolled }, null, 2));
    } finally {
      await db.close();
    }
    return;
  }
  if (command === "status-postgres") {
    const db = await openPostgresStorage(postgresConfig(args, config));
    try {
      const status = await migrationStatusStorage(db, POSTGRES_MIGRATIONS_DIR);
      console.log(JSON.stringify({ dialect: "postgres", migrations: status }, null, 2));
    } finally {
      await db.close();
    }
    return;
  }
  if (command === "bootstrap-postgres") {
    const raw = process.env.KHAOYU_BOOTSTRAP_PASSWORD || "";
    if (raw.length < 12 || raw.length > 200) {
      throw new Error("KHAOYU_BOOTSTRAP_PASSWORD must be between 12 and 200 characters");
    }
    const db = await openPostgresStorage(postgresConfig(args, config));
    try {
      const result = await bootstrap(config, db, { hash: await hashPassword(raw) });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await db.close();
    }
    return;
  }
  if (command === "backup-postgres") {
    const db = await openPostgresStorage(postgresConfig(args, config));
    try {
      const backup = await createPostgresBackup(db, config);
      console.log(backup.directory);
    } finally {
      await db.close();
    }
    return;
  }
  if (command === "restore-postgres") {
    const databaseUrlIndex = args.indexOf("--database-url");
    const directory = args.find(
      (value, index) =>
        !value.startsWith("--") && (databaseUrlIndex < 0 || index !== databaseUrlIndex + 1)
    );
    if (!directory) throw new Error("restore-postgres needs a backup directory");
    const result = await restorePostgresBackup({
      backupDirectory: path.resolve(directory),
      ...postgresConfig(args, config),
      objectsDir: config.objectsDir,
      force: args.includes("--force"),
      passphrase: config.backupPassphrase || null,
    });
    console.log(JSON.stringify({ restored: true, ...result }, null, 2));
    return;
  }
  if (command === "invalidate-sessions-postgres") {
    const db = await openPostgresStorage(postgresConfig(args, config));
    try {
      const now = Date.now();
      const sessions = (
        await db.run("UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL", [now])
      ).changes;
      await db.run("UPDATE refresh_tokens SET revoked_at = ? WHERE revoked_at IS NULL", [now]);
      await db.run("UPDATE access_tokens SET revoked_at = ? WHERE revoked_at IS NULL", [now]);
      console.log(JSON.stringify({ revokedSessions: Number(sessions) }, null, 2));
    } finally {
      await db.close();
    }
    return;
  }
  if (command === "migrate-to-postgres") {
    const sqliteIndex = args.indexOf("--sqlite");
    const sqlitePath =
      sqliteIndex >= 0 ? String(args[sqliteIndex + 1] || "") : config.databasePath;
    if (!sqlitePath) throw new Error("--sqlite <path> is required");
    const report = await copySqliteToPostgres({
      sqlitePath,
      ...postgresConfig(args, config),
      dryRun: args.includes("--dry-run"),
      onProgress: (event) => {
        if (!event.dryRun) {
          console.error(
            `copied ${event.table}: ${event.copied}/${event.rows}${event.rows === 0 ? "" : " rows"}`
          );
        }
      },
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (command === "rollback") {
    const index = args.indexOf("--steps");
    const steps = index >= 0 ? Number(args[index + 1]) : 1;
    if (!Number.isInteger(steps) || steps < 1) throw new Error("--steps must be a positive integer");
    const db = await open(config);
    try {
      const directory = config.databaseUrl ? POSTGRES_MIGRATIONS_DIR : MIGRATIONS_DIR;
      const rolled = await rollbackStorage(db, { directory, steps });
      console.log(JSON.stringify({ rolledBack: rolled }, null, 2));
    } finally {
      await db.close();
    }
    return;
  }
  if (command === "status") {
    const db = await open(config);
    try {
      const directory = config.databaseUrl ? POSTGRES_MIGRATIONS_DIR : MIGRATIONS_DIR;
      const status = await migrationStatusStorage(db, directory);
      console.log(JSON.stringify(status, null, 2));
    } finally {
      await db.close();
    }
    return;
  }
  if (command === "backup") {
    const db = await open(config);
    try {
      const backup = await createBackup(db, config);
      console.log(backup.directory);
    } finally {
      await db.close();
    }
    return;
  }
  if (command === "restore") {
    const directory = args.find((value) => !value.startsWith("--"));
    if (!directory) throw new Error("restore needs a backup directory");
    if (config.databaseUrl) {
      const result = await restorePostgresBackup({
        backupDirectory: path.resolve(directory),
        databaseUrl: config.databaseUrl,
        databaseSsl: config.databaseSsl,
        databasePoolMax: config.databasePoolMax,
        objectsDir: config.objectsDir,
        force: args.includes("--force"),
        passphrase: config.backupPassphrase || null,
      });
      console.log(JSON.stringify({ restored: true, ...result }, null, 2));
      return;
    }
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
    const db = await open(config);
    try {
      const now = Date.now();
      const sessions = (
        await db.run("UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL", [now])
      ).changes;
      await db.run("UPDATE refresh_tokens SET revoked_at = ? WHERE revoked_at IS NULL", [now]);
      await db.run("UPDATE access_tokens SET revoked_at = ? WHERE revoked_at IS NULL", [now]);
      console.log(JSON.stringify({ revokedSessions: Number(sessions) }, null, 2));
    } finally {
      await db.close();
    }
    return;
  }
  if (command === "bootstrap") {
    const raw = process.env.KHAOYU_BOOTSTRAP_PASSWORD || "";
    if (raw.length < 12 || raw.length > 200) {
      throw new Error("KHAOYU_BOOTSTRAP_PASSWORD must be between 12 and 200 characters");
    }
    const db = await open(config);
    try {
      const result = await bootstrap(config, db, { hash: await hashPassword(raw) });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await db.close();
    }
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
