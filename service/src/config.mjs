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

function boolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error("boolean environment values must be true or false");
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

  const adminToken = env.KHAOYU_SERVICE_ADMIN_TOKEN || "";
  if (adminToken) {
    if (Buffer.byteLength(adminToken, "utf8") < 32) {
      throw new Error("KHAOYU_SERVICE_ADMIN_TOKEN must be at least 32 characters");
    }
    if (/^(change|replace|secret|password|example|test)/i.test(adminToken)) {
      throw new Error("KHAOYU_SERVICE_ADMIN_TOKEN still uses a placeholder value");
    }
  }

  const backupPassphrase = env.KHAOYU_SERVICE_BACKUP_PASSPHRASE || "";
  if (backupPassphrase && Buffer.byteLength(backupPassphrase, "utf8") < 12) {
    throw new Error("KHAOYU_SERVICE_BACKUP_PASSPHRASE must be at least 12 characters");
  }

  const requireHttps = boolean(env.KHAOYU_SERVICE_REQUIRE_HTTPS, false);
  if (requireHttps && !publicUrl.startsWith("https://")) {
    throw new Error("KHAOYU_SERVICE_PUBLIC_URL must use https when HTTPS is required");
  }

  const alertWebhook = env.KHAOYU_SERVICE_ALERT_WEBHOOK || "";
  if (alertWebhook && !/^https?:\/\//.test(alertWebhook)) {
    throw new Error("KHAOYU_SERVICE_ALERT_WEBHOOK must be an http or https URL");
  }

  const trustProxy = boolean(env.KHAOYU_SERVICE_TRUST_PROXY, false);
  const ssoEnabled = boolean(env.KHAOYU_SERVICE_SSO_ENABLED, false);  const ssoSecret = env.KHAOYU_SERVICE_SSO_SECRET || "";
  const ssoHeader = (env.KHAOYU_SERVICE_SSO_HEADER || "x-auth-request-email").toLowerCase();
  const ssoNameHeader = (env.KHAOYU_SERVICE_SSO_NAME_HEADER || "x-auth-request-name").toLowerCase();
  if (!/^x-[a-z0-9-]+$/.test(ssoHeader) || !/^x-[a-z0-9-]+$/.test(ssoNameHeader)) {
    throw new Error("SSO headers must be non-standard x-* header names");
  }
  if (ssoEnabled) {
    if (!trustProxy) throw new Error("SSO requires KHAOYU_SERVICE_TRUST_PROXY=true");
    if (Buffer.byteLength(ssoSecret, "utf8") < 32) {
      throw new Error("KHAOYU_SERVICE_SSO_SECRET must be at least 32 characters when SSO is enabled");
    }
  }

  const passkeysEnabled = boolean(env.KHAOYU_SERVICE_PASSKEYS_ENABLED, true);
  const rpId = (env.KHAOYU_SERVICE_RP_ID || new URL(publicUrl).hostname).toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(rpId)) {
    throw new Error("KHAOYU_SERVICE_RP_ID must be a hostname");
  }

  const smtpHost = env.KHAOYU_SERVICE_SMTP_HOST || "";  const smtpUser = env.KHAOYU_SERVICE_SMTP_USER || "";
  const smtpPass = env.KHAOYU_SERVICE_SMTP_PASSWORD || "";
  const smtpFrom = env.KHAOYU_SERVICE_SMTP_FROM || "";
  if (smtpHost && !smtpFrom) {
    throw new Error("KHAOYU_SERVICE_SMTP_FROM is required when SMTP is enabled");
  }
  if (Boolean(smtpUser) !== Boolean(smtpPass)) {
    throw new Error("SMTP user and password must be provided together");
  }
  if (smtpFrom && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(smtpFrom)) {
    throw new Error("KHAOYU_SERVICE_SMTP_FROM must be an email address");
  }

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
    outboxDir: path.join(dataDir, "outbox"),
    cookieSecure: boolean(env.KHAOYU_SERVICE_COOKIE_SECURE, publicUrl.startsWith("https://")),
    trustProxy,
    ssoEnabled,
    ssoSecret,
    ssoHeader,
    ssoNameHeader,
    ssoAutoCreate: boolean(env.KHAOYU_SERVICE_SSO_AUTO_CREATE, false),
    passkeysEnabled,
    rpId,
    publicSharingEnabled: boolean(env.KHAOYU_SERVICE_PUBLIC_SHARING, true),
    adminToken,
    backupPassphrase,
    requireHttps,
    uploadScanCommand: env.KHAOYU_SERVICE_UPLOAD_SCAN_COMMAND || "",
    alertWebhook,
    corsOrigins: (
      env.KHAOYU_SERVICE_CORS_ORIGINS ||
      "tauri://localhost,http://tauri.localhost,http://127.0.0.1:1430,http://localhost:1430"
    )
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    smtp: Object.freeze({
      host: smtpHost,
      port: integer(env.KHAOYU_SERVICE_SMTP_PORT, 587, 1, 65535, "KHAOYU_SERVICE_SMTP_PORT"),
      secure: boolean(env.KHAOYU_SERVICE_SMTP_SECURE, false),
      user: smtpUser,
      pass: smtpPass,
      from: smtpFrom,
    }),
    accessTtlMinutes: integer(env.KHAOYU_SERVICE_ACCESS_TTL_MINUTES, 15, 1, 1440, "KHAOYU_SERVICE_ACCESS_TTL_MINUTES"),
    refreshTtlDays: integer(env.KHAOYU_SERVICE_REFRESH_TTL_DAYS, 7, 1, 90, "KHAOYU_SERVICE_REFRESH_TTL_DAYS"),
    deletionGraceDays: integer(env.KHAOYU_SERVICE_DELETION_GRACE_DAYS, 30, 1, 365, "KHAOYU_SERVICE_DELETION_GRACE_DAYS"),
    loginWindowMinutes: integer(env.KHAOYU_SERVICE_LOGIN_WINDOW_MINUTES, 15, 1, 1440, "KHAOYU_SERVICE_LOGIN_WINDOW_MINUTES"),
    loginMaxAttempts: integer(env.KHAOYU_SERVICE_LOGIN_MAX_ATTEMPTS, 5, 1, 100, "KHAOYU_SERVICE_LOGIN_MAX_ATTEMPTS"),
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
