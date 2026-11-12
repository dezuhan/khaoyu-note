import crypto from "node:crypto";
import { hashToken, randomToken } from "./tokens.mjs";

export class AuthError extends Error {
  constructor(message, status = 401, code = "unauthorized") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function publicAccount(account) {
  return {
    id: account.id,
    email: account.email,
    displayName: account.display_name,
    role: account.role || "member",
    approved: account.approved_at !== null && account.approved_at !== undefined,
    emailVerified: Boolean(account.email_verified_at),
    deletionPending: Boolean(account.deletion_requested_at),
  };
}

async function createAccessToken(db, sessionId, ttlMinutes) {
  const token = randomToken(32);
  const now = Date.now();
  const expiresAt = now + ttlMinutes * 60_000;
  await db.run(
    "INSERT INTO access_tokens (id, session_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    [crypto.randomUUID(), sessionId, hashToken(token), now, expiresAt]
  );
  return { token, expiresAt };
}

export async function createSession(db, config, account, { ipHash, userAgent }) {
  const sessionId = crypto.randomUUID();
  const familyId = crypto.randomUUID();
  const refreshToken = randomToken(48);
  const csrfToken = randomToken(24);
  const now = Date.now();
  const refreshExpiresAt = now + config.refreshTtlDays * 86_400_000;
  await db.run(
    `INSERT INTO sessions
     (id, account_id, token_hash, family_id, device_label, created_at, last_seen_at, expires_at, ip_hash, user_agent, csrf_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      account.id,
      hashToken(refreshToken),
      familyId,
      deviceLabel(userAgent),
      now,
      now,
      refreshExpiresAt,
      ipHash || null,
      userAgent || null,
      hashToken(csrfToken),
    ]
  );
  await db.run(
    "INSERT INTO refresh_tokens (id, session_id, token_hash, created_at) VALUES (?, ?, ?, ?)",
    [crypto.randomUUID(), sessionId, hashToken(refreshToken), now]
  );
  const access = await createAccessToken(db, sessionId, config.accessTtlMinutes);
  return {
    sessionId,
    refreshToken,
    refreshExpiresAt,
    csrfToken,
    accessToken: access.token,
    accessExpiresAt: access.expiresAt,
  };
}

export async function authenticateAccess(db, token) {
  if (!token) return null;
  const row = await db.get(
    `SELECT at.id AS access_id, at.expires_at AS access_expires_at,
            s.id AS session_id, s.family_id, s.csrf_hash, s.last_seen_at,
            a.id, a.email, a.display_name, a.username, a.first_name, a.last_name,
            a.avatar_color, a.avatar_url, a.role, a.status, a.approved_at,
            a.email_verified_at, a.deletion_requested_at,
            a.deleted_at, a.totp_secret, a.totp_enabled_at
     FROM access_tokens at
     JOIN sessions s ON s.id = at.session_id
     JOIN accounts a ON a.id = s.account_id
     WHERE at.token_hash = ? AND at.revoked_at IS NULL AND at.expires_at > ?
       AND s.revoked_at IS NULL AND s.expires_at > ? AND a.deleted_at IS NULL
       AND a.status = 'active' AND a.approved_at IS NOT NULL`,
    [hashToken(token), Date.now(), Date.now()]
  );
  if (!row) return null;
  if (Date.now() - Number(row.last_seen_at) > 60_000) {
    await db.run("UPDATE sessions SET last_seen_at = ? WHERE id = ?", [
      Date.now(),
      row.session_id,
    ]);
  }
  return {
    account: {
      id: row.id,
      email: row.email,
      display_name: row.display_name,
      username: row.username,
      first_name: row.first_name,
      last_name: row.last_name,
      avatar_color: row.avatar_color,
      avatar_url: row.avatar_url,
      role: row.role,
      status: row.status,
      email_verified_at: row.email_verified_at,
      deletion_requested_at: row.deletion_requested_at,
      totp_secret: row.totp_secret,
      totp_enabled_at: row.totp_enabled_at,
    },
    session: {
      id: row.session_id,
      familyId: row.family_id,
      csrfHash: row.csrf_hash,
      accessExpiresAt: row.access_expires_at,
    },
    method: "access",
  };
}

async function revokeFamily(db, familyId) {
  const now = Date.now();
  await db.run("UPDATE sessions SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL", [
    now,
    familyId,
  ]);
  await db.run(
    "UPDATE refresh_tokens SET revoked_at = ? WHERE session_id IN (SELECT id FROM sessions WHERE family_id = ?) AND revoked_at IS NULL",
    [now, familyId]
  );
  await db.run(
    "UPDATE access_tokens SET revoked_at = ? WHERE session_id IN (SELECT id FROM sessions WHERE family_id = ?) AND revoked_at IS NULL",
    [now, familyId]
  );
}

export async function rotateRefresh(db, config, refreshToken, { ipHash, userAgent } = {}) {
  if (!refreshToken) throw new AuthError("refresh token missing");
  const tokenHash = hashToken(refreshToken);
  let reusedFamily = null;
  let invalid = false;
  const result = await db.transaction(async (tx) => {
    const current = await tx.get(
      `SELECT s.*, rt.id AS refresh_id
       FROM refresh_tokens rt
       JOIN sessions s ON s.id = rt.session_id
       JOIN accounts a ON a.id = s.account_id
       WHERE rt.token_hash = ? AND rt.used_at IS NULL AND rt.revoked_at IS NULL
         AND s.revoked_at IS NULL AND s.expires_at > ? AND a.deleted_at IS NULL
         AND a.status = 'active'`,
      [tokenHash, Date.now()]
    );
    if (!current) {
      const history = await tx.get(
        `SELECT rt.used_at, rt.revoked_at, s.family_id
         FROM refresh_tokens rt JOIN sessions s ON s.id = rt.session_id
         WHERE rt.token_hash = ?`,
        [tokenHash]
      );
      if (history && (history.used_at || history.revoked_at)) {
        await revokeFamily(tx, history.family_id);
        reusedFamily = history.family_id;
        return null;
      }
      invalid = true;
      return null;
    }

    const now = Date.now();
    const nextRefresh = randomToken(48);
    const nextCsrf = randomToken(24);
    const nextRefreshId = crypto.randomUUID();
    await tx.run("UPDATE refresh_tokens SET used_at = ?, replaced_by = ? WHERE id = ?", [
      now,
      nextRefreshId,
      current.refresh_id,
    ]);
    await tx.run(
      "INSERT INTO refresh_tokens (id, session_id, token_hash, created_at) VALUES (?, ?, ?, ?)",
      [nextRefreshId, current.id, hashToken(nextRefresh), now]
    );
    await tx.run(
      "UPDATE sessions SET token_hash = ?, last_seen_at = ?, ip_hash = ?, user_agent = ?, csrf_hash = ? WHERE id = ?",
      [
        hashToken(nextRefresh),
        now,
        ipHash || current.ip_hash,
        userAgent || current.user_agent,
        hashToken(nextCsrf),
        current.id,
      ]
    );
    await tx.run(
      "UPDATE access_tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL",
      [now, current.id]
    );
    const access = await createAccessToken(tx, current.id, config.accessTtlMinutes);
    return {
      sessionId: current.id,
      accessToken: access.token,
      accessExpiresAt: access.expiresAt,
      refreshToken: nextRefresh,
      csrfToken: nextCsrf,
      refreshExpiresAt: current.expires_at,
    };
  });
  if (reusedFamily) throw new AuthError("refresh token reuse detected", 401, "refresh_reuse");
  if (invalid || !result) throw new AuthError("invalid refresh token");
  return result;
}

export async function revokeSession(db, sessionId, accountId) {
  const now = Date.now();
  const result = await db.run(
    "UPDATE sessions SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
    [now, sessionId, accountId]
  );
  if (!result.changes) return false;
  await db.run(
    "UPDATE refresh_tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL",
    [now, sessionId]
  );
  await db.run(
    "UPDATE access_tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL",
    [now, sessionId]
  );
  return true;
}

export async function revokeAllSessions(db, accountId, exceptSessionId = null) {
  const now = Date.now();
  if (exceptSessionId) {
    await db.run(
      "UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND id != ? AND revoked_at IS NULL",
      [now, accountId, exceptSessionId]
    );
    await db.run(
      `UPDATE refresh_tokens SET revoked_at = ? WHERE session_id IN
       (SELECT id FROM sessions WHERE account_id = ? AND id != ?) AND revoked_at IS NULL`,
      [now, accountId, exceptSessionId]
    );
    await db.run(
      `UPDATE access_tokens SET revoked_at = ? WHERE session_id IN
       (SELECT id FROM sessions WHERE account_id = ? AND id != ?) AND revoked_at IS NULL`,
      [now, accountId, exceptSessionId]
    );
    return;
  }
  await db.run("UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL", [
    now,
    accountId,
  ]);
  await db.run(
    `UPDATE refresh_tokens SET revoked_at = ? WHERE session_id IN
     (SELECT id FROM sessions WHERE account_id = ?) AND revoked_at IS NULL`,
    [now, accountId]
  );
  await db.run(
    `UPDATE access_tokens SET revoked_at = ? WHERE session_id IN
     (SELECT id FROM sessions WHERE account_id = ?) AND revoked_at IS NULL`,
    [now, accountId]
  );
}

export async function revokeByRefreshToken(db, refreshToken) {
  if (!refreshToken) return false;
  const row = await db.get("SELECT s.id, s.account_id FROM sessions s WHERE s.token_hash = ?", [
    hashToken(refreshToken),
  ]);
  return row ? await revokeSession(db, row.id, row.account_id) : false;
}

export async function authenticateApiToken(db, token) {
  if (!token || !token.startsWith("khn_")) return null;
  const row = await db.get(
    `SELECT t.id AS token_id, t.scopes, t.expires_at,
            a.id, a.email, a.display_name, a.username, a.avatar_color, a.avatar_url,
            a.role, a.status, a.approved_at, a.email_verified_at, a.deletion_requested_at,
            a.deleted_at
     FROM api_tokens t JOIN accounts a ON a.id = t.account_id
     WHERE t.token_hash = ? AND t.revoked_at IS NULL
       AND (t.expires_at IS NULL OR t.expires_at > ?) AND a.deleted_at IS NULL
       AND a.status = 'active' AND a.approved_at IS NOT NULL`,
    [hashToken(token), Date.now()]
  );
  if (!row) return null;
  let scopes = [];
  try {
    scopes = JSON.parse(row.scopes);
  } catch {
    scopes = [];
  }
  return {
    account: {
      id: row.id,
      email: row.email,
      display_name: row.display_name,
      username: row.username,
      avatar_color: row.avatar_color,
      avatar_url: row.avatar_url,
      role: row.role,
      status: row.status,
      email_verified_at: row.email_verified_at,
      deletion_requested_at: row.deletion_requested_at,
    },
    session: null,
    tokenId: row.token_id,
    scopes,
    method: "api",
  };
}

export async function createApiToken(db, accountId, { name, scopes, expiresAt }) {
  const token = `khn_${randomToken(32)}`;
  const id = crypto.randomUUID();
  await db.run(
    "INSERT INTO api_tokens (id, account_id, name, scopes, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, accountId, name, JSON.stringify(scopes), hashToken(token), Date.now(), expiresAt || null]
  );
  return { id, token };
}

export async function listApiTokens(db, accountId) {
  const rows = await db.all(
    "SELECT id, name, scopes, created_at, expires_at, revoked_at FROM api_tokens WHERE account_id = ? ORDER BY created_at DESC",
    [accountId]
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    scopes: JSON.parse(row.scopes || "[]"),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revoked: Boolean(row.revoked_at),
  }));
}

export async function revokeApiToken(db, accountId, tokenId) {
  const result = await db.run(
    "UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
    [Date.now(), tokenId, accountId]
  );
  return Boolean(result.changes);
}

export async function listSessions(db, accountId, currentSessionId = null) {
  const rows = await db.all(
    `SELECT id, device_label, created_at, last_seen_at, expires_at, revoked_at
     FROM sessions WHERE account_id = ? ORDER BY last_seen_at DESC`,
    [accountId]
  );
  return rows.map((row) => ({
    id: row.id,
    device: row.device_label || "Unknown device",
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revoked: Boolean(row.revoked_at),
    current: row.id === currentSessionId,
  }));
}

export function deviceLabel(userAgent) {
  const value = String(userAgent || "").trim();
  if (!value) return "Unknown device";
  return value.slice(0, 120);
}
