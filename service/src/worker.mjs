import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createBackup, pruneBackups } from "./backup.mjs";
import { pruneLoginAttempts } from "./auth/throttle.mjs";

function removeOldEntries(directory, maxAgeMs) {
  if (!fs.existsSync(directory)) return 0;
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      continue;
    }
    if (stat.mtimeMs >= cutoff) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

export function purgeDeletedAccounts(db, logger) {
  const due = db
    .prepare("SELECT id, email FROM accounts WHERE deletion_due_at IS NOT NULL AND deletion_due_at <= ? AND deleted_at IS NULL")
    .all(Date.now());
  let purged = 0;
  for (const account of due) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "DELETE FROM projects WHERE owner_account_id = ?"
      ).run(account.id);
      db.prepare("DELETE FROM accounts WHERE id = ?").run(account.id);
      db.exec("COMMIT");
      db.prepare(
        "INSERT INTO audit_log (id, actor_account_id, action, resource_type, resource_id, created_at) VALUES (?, NULL, 'account.purged', 'account', ?, ?)"
      ).run(crypto.randomUUID(), account.id, Date.now());
      purged += 1;
    } catch (error) {
      db.exec("ROLLBACK");
      logger.error("account.purge_failed", { message: error.message });
    }
  }
  return purged;
}

function pruneTokens(db) {
  const now = Date.now();
  const access = db
    .prepare("DELETE FROM access_tokens WHERE expires_at < ? OR revoked_at < ?")
    .run(now - 86_400_000, now - 86_400_000).changes;
  const email = db
    .prepare("DELETE FROM email_tokens WHERE expires_at < ? OR used_at < ?")
    .run(now - 86_400_000, now - 86_400_000).changes;
  const refresh = db
    .prepare(
      `DELETE FROM refresh_tokens WHERE session_id IN
       (SELECT id FROM sessions WHERE revoked_at < ? OR expires_at < ?) AND created_at < ?`
    )
    .run(now - 86_400_000, now - 86_400_000, now - 86_400_000).changes;
  const shares = db
    .prepare("DELETE FROM share_attempts WHERE created_at < ?")
    .run(now - 30 * 86_400_000).changes;
  const otp = db
    .prepare("DELETE FROM email_otps WHERE expires_at < ? OR used_at < ?")
    .run(now - 86_400_000, now - 86_400_000).changes;
  const versions = pruneVersions(db);
  const notifications = db
    .prepare("DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < ?")
    .run(now - 90 * 86_400_000).changes;
  const passkeyChallenges = db
    .prepare("DELETE FROM passkey_challenges WHERE expires_at < ?")
    .run(now).changes;
  return {
    access: Number(access),
    email: Number(email),
    refresh: Number(refresh),
    shares: Number(shares),
    otp: Number(otp),
    versions,
    notifications: Number(notifications),
    passkeyChallenges: Number(passkeyChallenges),
  };
}

function pruneVersions(db) {
  let removed = 0;
  const projects = db.prepare("SELECT id FROM projects").all();
  for (const project of projects) {
    const result = db
      .prepare(
        `DELETE FROM project_versions WHERE project_id = ? AND revision NOT IN
         (SELECT revision FROM project_versions WHERE project_id = ? ORDER BY revision DESC LIMIT 100)`
      )
      .run(project.id, project.id);
    removed += Number(result.changes);
  }
  return removed;
}

export function runMaintenance(db, config, logger) {
  const tempRemoved = removeOldEntries(config.tempDir, config.tempMaxAgeHours * 3600_000);
  const audit = db
    .prepare("DELETE FROM audit_log WHERE created_at < ?")
    .run(Date.now() - config.auditRetentionDays * 86_400_000);
  const purged = purgeDeletedAccounts(db, logger);
  const tokens = pruneTokens(db);
  pruneLoginAttempts(db, 30);

  const last = db.prepare("SELECT value FROM service_meta WHERE key = 'last_backup_at'").get();
  const due =
    !last || Date.now() - Number(last.value) >= config.backupIntervalHours * 3600_000;
  let backup = null;
  if (due) {
    try {
      backup = createBackup(db, config);
      const pruned = pruneBackups(config);
      db.prepare(
        "INSERT INTO service_meta (key, value) VALUES ('last_backup_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(String(Date.now()));
      logger.info("backup.created", {
        directory: backup.directory,
        pruned: pruned.length,
      });
    } catch (error) {
      logger.error("backup.failed", { message: error.message });
    }
  }

  if (tempRemoved || audit.changes) {
    logger.info("maintenance.cleaned", {
      tempRemoved,
      auditRemoved: Number(audit.changes || 0),
    });
  }
  return { tempRemoved, auditRemoved: Number(audit.changes || 0), backup };
}

export function startWorker(db, config, logger, intervalMs = 60_000) {
  let timer = null;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    try {
      runMaintenance(db, config, logger);
    } catch (error) {
      logger.error("worker.failed", { message: error.message });
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return {
    runOnce: tick,
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
