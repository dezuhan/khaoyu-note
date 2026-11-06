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
    emailVerified: Boolean(account.email_verified_at),
    deletionPending: Boolean(account.deletion_requested_at),
  };
}

function createAccessToken(db, sessionId, ttlMinutes) {
  const token = randomToken(32);
  const now = Date.now();
  const expiresAt = now + ttlMinutes * 60_000;
  db.prepare(
    "INSERT INTO access_tokens (id, session_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
  ).run(crypto.randomUUID(), sessionId, hashToken(token), now, expiresAt);
  return { token, expiresAt };
}

export function createSession(db, config, account, { ipHash, userAgent }) {
  const sessionId = crypto.randomUUID();
  const familyId = crypto.randomUUID();
  const refreshToken = randomToken(48);
  const csrfToken = randomToken(24);
  const now = Date.now();
  const refreshExpiresAt = now + config.refreshTtlDays * 86_400_000;
  db.prepare(
    `INSERT INTO sessions
     (id, account_id, token_hash, family_id, device_label, created_at, last_seen_at, expires_at, ip_hash, user_agent, csrf_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
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
    hashToken(csrfToken)
  );
  db.prepare(
    "INSERT INTO refresh_tokens (id, session_id, token_hash, created_at) VALUES (?, ?, ?, ?)"
  ).run(crypto.randomUUID(), sessionId, hashToken(refreshToken), now);
  const access = createAccessToken(db, sessionId, config.accessTtlMinutes);
  return {
    sessionId,
    refreshToken,
    refreshExpiresAt,
    csrfToken,
    accessToken: access.token,
    accessExpiresAt: access.expiresAt,
  };
}

export function authenticateAccess(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT at.id AS access_id, at.expires_at AS access_expires_at,
              s.id AS session_id, s.family_id, s.csrf_hash, s.last_seen_at,
              a.id, a.email, a.display_name, a.email_verified_at, a.deletion_requested_at,
              a.deleted_at, a.totp_secret, a.totp_enabled_at
       FROM access_tokens at
       JOIN sessions s ON s.id = at.session_id
       JOIN accounts a ON a.id = s.account_id
       WHERE at.token_hash = ? AND at.revoked_at IS NULL AND at.expires_at > ?
         AND s.revoked_at IS NULL AND s.expires_at > ? AND a.deleted_at IS NULL`
    )
    .get(hashToken(token), Date.now(), Date.now());
  if (!row) return null;
  if (Date.now() - Number(row.last_seen_at) > 60_000) {
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(Date.now(), row.session_id);
  }
  return {
    account: {
      id: row.id,
      email: row.email,
      display_name: row.display_name,
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

function revokeFamily(db, familyId) {
  const now = Date.now();
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL").run(
    now,
    familyId
  );
  db.prepare(
    "UPDATE refresh_tokens SET revoked_at = ? WHERE session_id IN (SELECT id FROM sessions WHERE family_id = ?) AND revoked_at IS NULL"
  ).run(now, familyId);
  db.prepare(
    "UPDATE access_tokens SET revoked_at = ? WHERE session_id IN (SELECT id FROM sessions WHERE family_id = ?) AND revoked_at IS NULL"
  ).run(now, familyId);
}

export function rotateRefresh(db, config, refreshToken, { ipHash, userAgent } = {}) {
  if (!refreshToken) throw new AuthError("refresh token missing");
  const tokenHash = hashToken(refreshToken);
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db
      .prepare(
        `SELECT s.*, rt.id AS refresh_id
         FROM refresh_tokens rt
         JOIN sessions s ON s.id = rt.session_id
         JOIN accounts a ON a.id = s.account_id
         WHERE rt.token_hash = ? AND rt.used_at IS NULL AND rt.revoked_at IS NULL
           AND s.revoked_at IS NULL AND s.expires_at > ? AND a.deleted_at IS NULL`
      )
      .get(tokenHash, Date.now());
    if (!current) {
      const history = db
        .prepare(
          `SELECT rt.used_at, rt.revoked_at, s.family_id
           FROM refresh_tokens rt JOIN sessions s ON s.id = rt.session_id
           WHERE rt.token_hash = ?`
        )
        .get(tokenHash);
      if (history && (history.used_at || history.revoked_at)) {
        revokeFamily(db, history.family_id);
        db.exec("COMMIT");
        throw new AuthError("refresh token reuse detected", 401, "refresh_reuse");
      }
      db.exec("ROLLBACK");
      throw new AuthError("invalid refresh token");
    }

    const now = Date.now();
    const nextRefresh = randomToken(48);
    const nextCsrf = randomToken(24);
    const nextRefreshId = crypto.randomUUID();
    db.prepare(
      "UPDATE refresh_tokens SET used_at = ?, replaced_by = ? WHERE id = ?"
    ).run(now, nextRefreshId, current.refresh_id);
    db.prepare(
      "INSERT INTO refresh_tokens (id, session_id, token_hash, created_at) VALUES (?, ?, ?, ?)"
    ).run(nextRefreshId, current.id, hashToken(nextRefresh), now);
    db.prepare(
      "UPDATE sessions SET token_hash = ?, last_seen_at = ?, ip_hash = ?, user_agent = ?, csrf_hash = ? WHERE id = ?"
    ).run(
      hashToken(nextRefresh),
      now,
      ipHash || current.ip_hash,
      userAgent || current.user_agent,
      hashToken(nextCsrf),
      current.id
    );
    db.prepare(
      "UPDATE access_tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL"
    ).run(now, current.id);
    const access = createAccessToken(db, current.id, config.accessTtlMinutes);
    db.exec("COMMIT");
    return {
      sessionId: current.id,
      accessToken: access.token,
      accessExpiresAt: access.expiresAt,
      refreshToken: nextRefresh,
      csrfToken: nextCsrf,
      refreshExpiresAt: current.expires_at,
    };
  } catch (error) {
    if (db.isTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
    }
    throw error;
  }
}

export function revokeSession(db, sessionId, accountId) {
  const now = Date.now();
  const result = db
    .prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL")
    .run(now, sessionId, accountId);
  if (!result.changes) return false;
  db.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL").run(
    now,
    sessionId
  );
  db.prepare("UPDATE access_tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL").run(
    now,
    sessionId
  );
  return true;
}

export function revokeAllSessions(db, accountId, exceptSessionId = null) {
  const now = Date.now();
  if (exceptSessionId) {
    db.prepare(
      "UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND id != ? AND revoked_at IS NULL"
    ).run(now, accountId, exceptSessionId);
    db.prepare(
      `UPDATE refresh_tokens SET revoked_at = ? WHERE session_id IN
       (SELECT id FROM sessions WHERE account_id = ? AND id != ?) AND revoked_at IS NULL`
    ).run(now, accountId, exceptSessionId);
    db.prepare(
      `UPDATE access_tokens SET revoked_at = ? WHERE session_id IN
       (SELECT id FROM sessions WHERE account_id = ? AND id != ?) AND revoked_at IS NULL`
    ).run(now, accountId, exceptSessionId);
    return;
  }
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL").run(
    now,
    accountId
  );
  db.prepare(
    `UPDATE refresh_tokens SET revoked_at = ? WHERE session_id IN
     (SELECT id FROM sessions WHERE account_id = ?) AND revoked_at IS NULL`
  ).run(now, accountId);
  db.prepare(
    `UPDATE access_tokens SET revoked_at = ? WHERE session_id IN
     (SELECT id FROM sessions WHERE account_id = ?) AND revoked_at IS NULL`
  ).run(now, accountId);
}

export function revokeByRefreshToken(db, refreshToken) {
  if (!refreshToken) return false;
  const row = db
    .prepare("SELECT s.id, s.account_id FROM sessions s WHERE s.token_hash = ?")
    .get(hashToken(refreshToken));
  return row ? revokeSession(db, row.id, row.account_id) : false;
}

export function authenticateApiToken(db, token) {
  if (!token || !token.startsWith("khn_")) return null;
  const row = db
    .prepare(
      `SELECT t.id AS token_id, t.scopes, t.expires_at,
              a.id, a.email, a.display_name, a.email_verified_at, a.deletion_requested_at,
              a.deleted_at
       FROM api_tokens t JOIN accounts a ON a.id = t.account_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL
         AND (t.expires_at IS NULL OR t.expires_at > ?) AND a.deleted_at IS NULL`
    )
    .get(hashToken(token), Date.now());
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
      email_verified_at: row.email_verified_at,
      deletion_requested_at: row.deletion_requested_at,
    },
    session: null,
    tokenId: row.token_id,
    scopes,
    method: "api",
  };
}

export function createApiToken(db, accountId, { name, scopes, expiresAt }) {
  const token = `khn_${randomToken(32)}`;
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO api_tokens (id, account_id, name, scopes, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, accountId, name, JSON.stringify(scopes), hashToken(token), Date.now(), expiresAt || null);
  return { id, token };
}

export function listApiTokens(db, accountId) {
  return db
    .prepare(
      "SELECT id, name, scopes, created_at, expires_at, revoked_at FROM api_tokens WHERE account_id = ? ORDER BY created_at DESC"
    )
    .all(accountId)
    .map((row) => ({
      id: row.id,
      name: row.name,
      scopes: JSON.parse(row.scopes || "[]"),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revoked: Boolean(row.revoked_at),
    }));
}

export function revokeApiToken(db, accountId, tokenId) {
  return Boolean(
    db
      .prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL")
      .run(Date.now(), tokenId, accountId).changes
  );
}

export function listSessions(db, accountId, currentSessionId = null) {
  return db
    .prepare(
      `SELECT id, device_label, created_at, last_seen_at, expires_at, revoked_at
       FROM sessions WHERE account_id = ? ORDER BY last_seen_at DESC`
    )
    .all(accountId)
    .map((row) => ({
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
