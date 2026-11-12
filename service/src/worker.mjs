import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createBackup, pruneBackups } from "./backup.mjs";
import { pruneLoginAttempts } from "./auth/throttle.mjs";
import { ObjectStore } from "./objects.mjs";

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

async function purgeOrphanedObjects(db, config, logger) {
  const candidates = (await db.all(`SELECT id FROM objects WHERE NOT EXISTS
       (SELECT 1 FROM project_assets WHERE project_assets.object_id = objects.id)`, []));
  if (!candidates.length) return 0;
  const store = new ObjectStore(db, config.objectsDir, config.objectEncryptionKey);
  let removed = 0;
  for (const object of candidates) {
    // Keep objects that still appear in a version document; card payloads may reference
    // an asset after the project_assets row was removed by an earlier project purge.
    const referenced = (await db.get("SELECT 1 AS found FROM project_versions WHERE doc LIKE ? LIMIT 1", [`%${object.id}%`]));
    if (referenced) continue;
    try {
      if (await store.remove(object.id)) removed += 1;
    } catch (error) {
      logger.error("object.purge_failed", { message: error.message });
    }
  }
  return removed;
}

export async function purgeDeletedAccounts(db, logger, config = null) {
  const due = (await db.all("SELECT id, email FROM accounts WHERE deletion_due_at IS NOT NULL AND deletion_due_at <= ? AND deleted_at IS NULL", [Date.now()]));
  let purged = 0;
  for (const account of due) {
    try {
      await db.transaction(async (tx) => {
        await tx.run("DELETE FROM projects WHERE owner_account_id = ?", [account.id]);
        await tx.run("DELETE FROM accounts WHERE id = ?", [account.id]);
        await tx.run(
          "INSERT INTO audit_log (id, actor_account_id, action, resource_type, resource_id, created_at) VALUES (?, NULL, 'account.purged', 'account', ?, ?)",
          [crypto.randomUUID(), account.id, Date.now()]
        );
      });
      purged += 1;
    } catch (error) {
      logger.error("account.purge_failed", { message: error.message });
    }
  }
  if (purged && config) {
    const objectsRemoved = await purgeOrphanedObjects(db, config, logger);
    if (objectsRemoved) logger.info("objects.purged", { count: objectsRemoved });
  }
  return purged;
}

async function pruneTokens(db) {
  const now = Date.now();
  const access = (await db.run("DELETE FROM access_tokens WHERE expires_at < ? OR revoked_at < ?", [now - 86_400_000, now - 86_400_000])).changes;
  const email = (await db.run("DELETE FROM email_tokens WHERE expires_at < ? OR used_at < ?", [now - 86_400_000, now - 86_400_000])).changes;
  const refresh = (await db.run(`DELETE FROM refresh_tokens WHERE session_id IN
       (SELECT id FROM sessions WHERE revoked_at < ? OR expires_at < ?) AND created_at < ?`, [now - 86_400_000, now - 86_400_000, now - 86_400_000])).changes;
  const shares = (await db.run("DELETE FROM share_attempts WHERE created_at < ?", [now - 30 * 86_400_000])).changes;
  const otp = (await db.run("DELETE FROM email_otps WHERE expires_at < ? OR used_at < ?", [now - 86_400_000, now - 86_400_000])).changes;
  const versions = await pruneVersions(db);
  const notifications = (await db.run("DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < ?", [now - 90 * 86_400_000])).changes;
  const passkeyChallenges = (await db.run("DELETE FROM passkey_challenges WHERE expires_at < ?", [now])).changes;
  const expiredInvitations = (await db.run(`UPDATE project_invitations SET revoked_at = ?
       WHERE revoked_at IS NULL AND accepted_at IS NULL AND expires_at < ?`, [now, now])).changes;
  const expiredShareLinks = (await db.run(`UPDATE share_links SET revoked_at = ?
       WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?`, [now, now])).changes;
  return {
    access: Number(access),
    email: Number(email),
    refresh: Number(refresh),
    shares: Number(shares),
    otp: Number(otp),
    versions,
    notifications: Number(notifications),
    passkeyChallenges: Number(passkeyChallenges),
    expiredInvitations: Number(expiredInvitations),
    expiredShareLinks: Number(expiredShareLinks),
  };
}

async function pruneVersions(db) {
  let removed = 0;
  const projects = (await db.all("SELECT id FROM projects", []));
  for (const project of projects) {
    const result = (await db.run(`DELETE FROM project_versions WHERE project_id = ? AND revision NOT IN
         (SELECT revision FROM project_versions WHERE project_id = ? ORDER BY revision DESC LIMIT 100)`, [project.id, project.id]));
    removed += Number(result.changes);
  }
  return removed;
}

export async function runMaintenance(db, config, logger) {
  const tempRemoved = removeOldEntries(config.tempDir, config.tempMaxAgeHours * 3600_000);
  const audit = (await db.run("DELETE FROM audit_log WHERE created_at < ?", [Date.now() - config.auditRetentionDays * 86_400_000]));
  const purged = await purgeDeletedAccounts(db, logger, config);
  const tokens = await pruneTokens(db);
  await pruneLoginAttempts(db, 30);

  const last = (await db.get("SELECT value FROM service_meta WHERE key = 'last_backup_at'", []));
  const due =
    !last || Date.now() - Number(last.value) >= config.backupIntervalHours * 3600_000;
  let backup = null;
  if (due) {
    try {
      backup = await createBackup(db, config);
      const pruned = pruneBackups(config);
      (await db.run("INSERT INTO service_meta (key, value) VALUES ('last_backup_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(Date.now())]));
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
  const finishedAt = Date.now();
  const summary = JSON.stringify({
    finishedAt,
    tempRemoved,
    auditRemoved: Number(audit.changes || 0),
    tokens,
    backup: backup ? path.basename(backup.directory) : null,
  }).slice(0, 4000);
  await db.run(
    "INSERT INTO service_meta (key, value) VALUES ('last_worker_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [String(finishedAt)]
  );
  await db.run(
    "INSERT INTO service_meta (key, value) VALUES ('last_worker_summary', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [summary]
  );
  if (tokens.expiredInvitations || tokens.expiredShareLinks) {
    logger.info("sharing.expired", {
      invitations: tokens.expiredInvitations,
      shareLinks: tokens.expiredShareLinks,
    });
  }
  return { tempRemoved, auditRemoved: Number(audit.changes || 0), backup, tokens };
}

export function startWorker(db, config, logger, intervalMs = 60_000, mailer = null) {
  let timer = null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runMaintenance(db, config, logger);
      if (mailer?.flush) {
        const result = await mailer.flush();
        if (result?.sent) logger.info("mail.flushed", result);
      }
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
