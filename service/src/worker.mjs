import fs from "node:fs";
import path from "node:path";
import { createBackup, pruneBackups } from "./backup.mjs";

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

export function runMaintenance(db, config, logger) {
  const tempRemoved = removeOldEntries(config.tempDir, config.tempMaxAgeHours * 3600_000);
  const audit = db
    .prepare("DELETE FROM audit_log WHERE created_at < ?")
    .run(Date.now() - config.auditRetentionDays * 86_400_000);

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
