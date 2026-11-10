import { openSqliteStorage } from "./sqlite.mjs";
import { openPostgresStorage } from "./postgres.mjs";

export { openSqliteStorage, openPostgresStorage };

export function storageKind(config) {
  return config?.databaseUrl ? "postgres" : "sqlite";
}

// The team profile is the multi-user deployment: PostgreSQL is the system of record and Redis is
// required for cross-instance realtime. Fail here instead of silently falling back to SQLite.
export function assertTeamStorage(config) {
  if (config?.profile !== "team") return;
  if (!config.databaseUrl) {
    throw new Error("KHAOYU_SERVICE_DATABASE_URL is required for KHAOYU_SERVICE_PROFILE=team");
  }
  if (!config.redisUrl) {
    throw new Error("KHAOYU_SERVICE_REDIS_URL is required for KHAOYU_SERVICE_PROFILE=team");
  }
}

export async function openStorage(config) {
  assertTeamStorage(config);
  if (config.databaseUrl) {
    return openPostgresStorage({
      databaseUrl: config.databaseUrl,
      databaseSsl: config.databaseSsl,
      databasePoolMax: config.databasePoolMax,
    });
  }
  return openSqliteStorage(config.databasePath);
}

export function isUniqueViolation(error) {
  if (!error) return false;
  if (error.code === "23505") return true;
  if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  return /UNIQUE constraint failed/i.test(String(error.message || ""));
}
