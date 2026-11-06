import path from "node:path";

const PROFILES = new Set(["single-user", "team"]);

function integer(value, fallback, minimum, maximum, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const secret = env.KHAOYU_SERVICE_SECRET || "";
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("KHAOYU_SERVICE_SECRET must be at least 32 characters");
  }
  if (new Set(secret).size < 8) {
    throw new Error("KHAOYU_SERVICE_SECRET is too repetitive");
  }
  if (/^(change|replace|secret|password|example|test)/i.test(secret)) {
    throw new Error("KHAOYU_SERVICE_SECRET still uses a placeholder value");
  }

  const profile = env.KHAOYU_SERVICE_PROFILE || "single-user";
  if (!PROFILES.has(profile)) {
    throw new Error("KHAOYU_SERVICE_PROFILE must be single-user or team");
  }

  const host = env.KHAOYU_SERVICE_HOST || "127.0.0.1";
  const port = integer(env.KHAOYU_SERVICE_PORT, 8080, 1, 65535, "KHAOYU_SERVICE_PORT");
  const dataDir = path.resolve(cwd, env.KHAOYU_SERVICE_DATA_DIR || ".khaoyu-service-data");
  const publicUrl = (env.KHAOYU_SERVICE_PUBLIC_URL || `http://${host}:${port}`).replace(/\/+$/, "");

  return Object.freeze({
    profile,
    host,
    port,
    publicUrl,
    dataDir,
    secret,
    databasePath: path.join(dataDir, "khaoyu-service.db"),
    objectsDir: path.join(dataDir, "objects"),
    tempDir: path.join(dataDir, "tmp"),
    backupsDir: path.join(dataDir, "backups"),
    backupIntervalHours: integer(
      env.KHAOYU_SERVICE_BACKUP_INTERVAL_HOURS,
      24,
      1,
      24 * 30,
      "KHAOYU_SERVICE_BACKUP_INTERVAL_HOURS"
    ),
    backupRetention: integer(
      env.KHAOYU_SERVICE_BACKUP_RETENTION,
      7,
      1,
      365,
      "KHAOYU_SERVICE_BACKUP_RETENTION"
    ),
    auditRetentionDays: integer(
      env.KHAOYU_SERVICE_AUDIT_RETENTION_DAYS,
      90,
      1,
      3650,
      "KHAOYU_SERVICE_AUDIT_RETENTION_DAYS"
    ),
    tempMaxAgeHours: integer(
      env.KHAOYU_SERVICE_TEMP_MAX_AGE_HOURS,
      24,
      1,
      24 * 30,
      "KHAOYU_SERVICE_TEMP_MAX_AGE_HOURS"
    ),
  });
}
