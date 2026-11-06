import crypto from "node:crypto";
import { hashIp, writeAudit } from "../audit.mjs";
import { hashPassword, verifyPassword } from "./passwords.mjs";
import { AuthError, authenticateAccess, authenticateApiToken, createApiToken, createSession, listApiTokens, listSessions, publicAccount, revokeAllSessions, revokeApiToken, revokeByRefreshToken, revokeSession, rotateRefresh } from "./sessions.mjs";
import { bearerToken, hashToken, parseCookies, randomToken, serializeCookie } from "./tokens.mjs";
import { createTotpSecret, generateTotp, totpUri, verifyTotp } from "./totp.mjs";
import { clearLoginFailures, loginBlocked, recordLoginAttempt } from "./throttle.mjs";
import {
  appendCookie,
  assertSameOrigin,
  clientIp,
  HttpError,
  normalizeEmail,
  readJson,
  requirePassword,
  requireString,
  sendJson,
  sendNoContent,
} from "../http.mjs";

function now() {
  return Date.now();
}

function accountById(db, id) {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
}

function setSessionCookies(response, config, tokens) {
  appendCookie(
    response,
    serializeCookie("khaoyu_access", tokens.accessToken, {
      maxAge: Math.floor((tokens.accessExpiresAt - now()) / 1000),
      secure: config.cookieSecure,
    })
  );
  appendCookie(
    response,
    serializeCookie("khaoyu_refresh", tokens.refreshToken, {
      maxAge: Math.floor((tokens.refreshExpiresAt - now()) / 1000),
      secure: config.cookieSecure,
      path: "/api/v1/auth",
    })
  );
  appendCookie(
    response,
    serializeCookie("khaoyu_csrf", tokens.csrfToken, {
      maxAge: Math.floor((tokens.refreshExpiresAt - now()) / 1000),
      httpOnly: false,
      secure: config.cookieSecure,
    })
  );
}

function clearSessionCookies(response, config) {
  for (const [name, path] of [
    ["khaoyu_access", "/"],
    ["khaoyu_refresh", "/api/v1/auth"],
    ["khaoyu_csrf", "/"],
  ]) {
    appendCookie(
      response,
      serializeCookie(name, "", { maxAge: 0, path, secure: config.cookieSecure })
    );
  }
}

function issueEmailToken(db, config, accountId, kind, ttlMs) {
  const token = randomToken(32);
  db.prepare(
    "INSERT INTO email_tokens (id, account_id, kind, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(crypto.randomUUID(), accountId, kind, hashToken(token), now() + ttlMs, now());
  return token;
}

function consumeEmailToken(db, token, kind) {
  const row = db
    .prepare(
      "SELECT * FROM email_tokens WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?"
    )
    .get(hashToken(token), kind, now());
  if (!row) throw new HttpError(400, "token is invalid or expired", "invalid_token");
  const changed = db
    .prepare("UPDATE email_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL")
    .run(now(), row.id);
  if (!changed.changes) throw new HttpError(400, "token is invalid or expired", "invalid_token");
  return row;
}

function requireAuth(request, response, db, config) {
  const cookies = parseCookies(request.headers.cookie);
  const bearer = bearerToken(request);
  const token = bearer || cookies.khaoyu_access;
  const auth = authenticateAccess(db, token) || (bearer ? authenticateApiToken(db, bearer) : null);
  if (!auth) throw new HttpError(401, "authentication required", "authentication_required");
  if (auth.method !== "api" && !bearer && !["GET", "HEAD"].includes(request.method)) {
    const header = request.headers["x-csrf-token"];
    const cookie = cookies.khaoyu_csrf;
    if (!header || !cookie || header !== cookie || hashToken(header) !== auth.session.csrfHash) {
      throw new HttpError(403, "CSRF token missing or invalid", "csrf_failed");
    }
  }
  return { ...auth, cookies };
}

function requireSessionAuth(request, response, db, config) {
  const auth = requireAuth(request, response, db, config);
  if (auth.method === "api") {
    throw new HttpError(403, "this endpoint requires a user session", "session_required");
  }
  return auth;
}

function requireScope(auth, scope) {
  if (auth.method === "api" && !auth.scopes?.includes(scope)) {
    throw new HttpError(403, `scope ${scope} required`, "insufficient_scope");
  }
}

function projectRole(db, projectId, accountId) {
  return db
    .prepare("SELECT role FROM project_members WHERE project_id = ? AND account_id = ?")
    .get(projectId, accountId)?.role;
}

async function sendVerification(db, config, mailer, account, token) {
  await mailer.send({
    to: account.email,
    kind: "verify",
    subject: "Verify your Khaoyu Note email",
    text: `Verification token: ${token}`,
  });
  writeAudit(db, {
    actorAccountId: account.id,
    action: "auth.verification_sent",
    resourceType: "account",
    resourceId: account.id,
    secret: config.secret,
  });
}

async function sendReset(db, config, mailer, account, token) {
  await mailer.send({
    to: account.email,
    kind: "reset",
    subject: "Reset your Khaoyu Note password",
    text: `Reset token: ${token}`,
  });
  writeAudit(db, {
    actorAccountId: account.id,
    action: "auth.reset_sent",
    resourceType: "account",
    resourceId: account.id,
    secret: config.secret,
  });
}

export function createApiRouter({ db, config, logger, mailer }) {
  return async function route(request, response) {
    const url = new URL(request.url || "/", config.publicUrl);
    if (!url.pathname.startsWith("/api/v1/")) return false;
    const method = request.method;
    const ip = clientIp(request, config);
    const ipHash = hashIp(ip, config.secret);

    try {
      if (!["GET", "HEAD"].includes(method)) assertSameOrigin(request, config);

      if (method === "POST" && url.pathname === "/api/v1/auth/register") {
        const body = await readJson(request);
        const email = normalizeEmail(body.email);
        const password = requirePassword(body.password);
        const displayName =
          typeof body.displayName === "string" && body.displayName.trim()
            ? requireString(body.displayName, "displayName", 80)
            : email.split("@")[0];
        let account;
        try {
          account = {
            id: crypto.randomUUID(),
            email,
            display_name: displayName,
            email_verified_at: null,
            deletion_requested_at: null,
            deleted_at: null,
          };
          db.prepare(
            "INSERT INTO accounts (id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
          ).run(account.id, email, displayName, await hashPassword(password), now(), now());
        } catch (error) {
          if (!/UNIQUE/.test(error.message)) throw error;
          const existing = db.prepare("SELECT * FROM accounts WHERE email = ?").get(email);
          if (existing && !existing.email_verified_at && !existing.deleted_at) {
            const token = issueEmailToken(db, config, existing.id, "verify", 24 * 3600_000);
            await sendVerification(db, config, mailer, existing, token);
          }
          sendJson(response, 202, { status: "verification_pending" }, config);
          return true;
        }
        const token = issueEmailToken(db, config, account.id, "verify", 24 * 3600_000);
        await sendVerification(db, config, mailer, account, token);
        sendJson(response, 202, { status: "verification_pending" }, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/verify-email") {
        const body = await readJson(request);
        const resource = consumeEmailToken(db, requireString(body.token, "token", 200), "verify");
        db.prepare("UPDATE accounts SET email_verified_at = ?, updated_at = ? WHERE id = ?").run(
          now(),
          now(),
          resource.account_id
        );
        writeAudit(db, {
          actorAccountId: resource.account_id,
          action: "auth.email_verified",
          resourceType: "account",
          resourceId: resource.account_id,
          secret: config.secret,
        });
        sendNoContent(response, 204, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/login") {
        const body = await readJson(request);
        const email = normalizeEmail(body.email);
        const throttle = loginBlocked(db, { email, ip, config });
        if (throttle.blocked) {
          recordLoginAttempt(db, { email, ip, success: false, secret: config.secret });
          logger.warn("auth.login_blocked", {
            attempts: throttle.attempts,
            retryAfter: throttle.retryAfter,
          });
          sendJson(response, 429, { error: "Too many attempts" }, config, {
            "Retry-After": String(throttle.retryAfter),
          });
          return true;
        }
        const account = db.prepare("SELECT * FROM accounts WHERE email = ?").get(email);
        const valid = account ? await verifyPassword(body.password, account.password_hash) : false;
        if (!valid || account.deleted_at) {
          recordLoginAttempt(db, { email, ip, success: false, secret: config.secret });
          sendJson(response, 401, { error: "Invalid email or password" }, config);
          return true;
        }
        if (!account.email_verified_at) {
          sendJson(response, 403, { error: "Email verification required" }, config);
          return true;
        }
        if (account.totp_enabled_at && !verifyTotp(account.totp_secret, body.totp)) {
          recordLoginAttempt(db, { email, ip, success: false, secret: config.secret });
          sendJson(response, 401, { error: "Invalid email or password" }, config);
          return true;
        }
        clearLoginFailures(db, { email, ip, secret: config.secret });
        const session = createSession(db, config, account, {
          ipHash,
          userAgent: request.headers["user-agent"],
        });
        setSessionCookies(response, config, session);
        writeAudit(db, {
          actorAccountId: account.id,
          action: "auth.login",
          resourceType: "session",
          resourceId: session.sessionId,
          ip,
          secret: config.secret,
        });
        sendJson(
          response,
          200,
          {
            account: publicAccount(account),
            csrfToken: session.csrfToken,
            accessExpiresAt: session.accessExpiresAt,
          },
          config
        );
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/refresh") {
        const cookies = parseCookies(request.headers.cookie);
        const rotated = rotateRefresh(db, config, cookies.khaoyu_refresh, {
          ipHash,
          userAgent: request.headers["user-agent"],
        });
        const sessionRow = db
          .prepare("SELECT account_id FROM sessions WHERE id = ?")
          .get(rotated.sessionId);
        const account = accountById(db, sessionRow.account_id);
        setSessionCookies(response, config, rotated);
        writeAudit(db, {
          actorAccountId: account.id,
          action: "auth.refresh",
          resourceType: "session",
          resourceId: rotated.sessionId,
          ip,
          secret: config.secret,
        });
        sendJson(
          response,
          200,
          {
            account: publicAccount(account),
            csrfToken: rotated.csrfToken,
            accessExpiresAt: rotated.accessExpiresAt,
          },
          config
        );
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/logout") {
        const cookies = parseCookies(request.headers.cookie);
        const auth = authenticateAccess(db, cookies.khaoyu_access);
        if (auth) revokeSession(db, auth.session.id, auth.account.id);
        else revokeByRefreshToken(db, cookies.khaoyu_refresh);
        clearSessionCookies(response, config);
        sendNoContent(response, 204, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/logout-all") {
        const auth = requireSessionAuth(request, response, db, config);
        revokeAllSessions(db, auth.account.id);
        clearSessionCookies(response, config);
        writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "auth.logout_all",
          resourceType: "account",
          resourceId: auth.account.id,
          ip,
          secret: config.secret,
        });
        sendNoContent(response, 204, config);
        return true;
      }

      if (method === "GET" && url.pathname === "/api/v1/auth/sessions") {
        const auth = requireSessionAuth(request, response, db, config);
        sendJson(response, 200, { sessions: listSessions(db, auth.account.id, auth.session.id) }, config);
        return true;
      }

      const sessionMatch = url.pathname.match(/^\/api\/v1\/auth\/sessions\/([^/]+)$/);
      if (method === "DELETE" && sessionMatch) {
        const auth = requireSessionAuth(request, response, db, config);
        const revoked = revokeSession(db, sessionMatch[1], auth.account.id);
        if (!revoked) throw new HttpError(404, "session not found", "not_found");
        writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "auth.session_revoked",
          resourceType: "session",
          resourceId: sessionMatch[1],
          ip,
          secret: config.secret,
        });
        sendNoContent(response, 204, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/password-reset/request") {
        const body = await readJson(request);
        const email = normalizeEmail(body.email);
        const account = db.prepare("SELECT * FROM accounts WHERE email = ? AND deleted_at IS NULL").get(email);
        if (account) {
          const token = issueEmailToken(db, config, account.id, "reset", 3600_000);
          await sendReset(db, config, mailer, account, token);
        }
        sendJson(response, 202, { status: "accepted" }, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/password-reset/confirm") {
        const body = await readJson(request);
        const token = requireString(body.token, "token", 200);
        const password = requirePassword(body.password);
        const resource = consumeEmailToken(db, token, "reset");
        db.prepare("UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?").run(
          await hashPassword(password),
          now(),
          resource.account_id
        );
        revokeAllSessions(db, resource.account_id);
        writeAudit(db, {
          actorAccountId: resource.account_id,
          action: "auth.password_reset",
          resourceType: "account",
          resourceId: resource.account_id,
          ip,
          secret: config.secret,
        });
        sendNoContent(response, 204, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/totp/setup") {
        const auth = requireSessionAuth(request, response, db, config);
        if (auth.account.totp_enabled_at) throw new HttpError(409, "TOTP is already enabled", "totp_enabled");
        const secret = createTotpSecret();
        db.prepare("UPDATE accounts SET totp_secret = ?, updated_at = ? WHERE id = ?").run(
          secret,
          now(),
          auth.account.id
        );
        sendJson(
          response,
          200,
          { secret, uri: totpUri(secret, auth.account.email) },
          config
        );
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/totp/enable") {
        const auth = requireSessionAuth(request, response, db, config);
        const body = await readJson(request);
        if (!verifyTotp(auth.account.totp_secret, body.code)) {
          throw new HttpError(400, "invalid TOTP code", "invalid_totp");
        }
        db.prepare("UPDATE accounts SET totp_enabled_at = ?, updated_at = ? WHERE id = ?").run(
          now(),
          now(),
          auth.account.id
        );
        writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "auth.totp_enabled",
          resourceType: "account",
          resourceId: auth.account.id,
          ip,
          secret: config.secret,
        });
        sendNoContent(response, 204, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/totp/disable") {
        const auth = requireSessionAuth(request, response, db, config);
        const body = await readJson(request);
        const account = accountById(db, auth.account.id);
        if (!(await verifyPassword(body.password, account.password_hash))) {
          throw new HttpError(401, "invalid password", "invalid_credentials");
        }
        if (account.totp_enabled_at && !verifyTotp(account.totp_secret, body.code)) {
          throw new HttpError(400, "invalid TOTP code", "invalid_totp");
        }
        db.prepare(
          "UPDATE accounts SET totp_secret = NULL, totp_enabled_at = NULL, updated_at = ? WHERE id = ?"
        ).run(now(), auth.account.id);
        writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "auth.totp_disabled",
          resourceType: "account",
          resourceId: auth.account.id,
          ip,
          secret: config.secret,
        });
        sendNoContent(response, 204, config);
        return true;
      }

      if (method === "GET" && url.pathname === "/api/v1/account/export") {
        const auth = requireSessionAuth(request, response, db, config);
        const account = accountById(db, auth.account.id);
        const projects = db
          .prepare(
            `SELECT p.*, m.role FROM projects p JOIN project_members m ON m.project_id = p.id
             WHERE m.account_id = ? AND p.deleted_at IS NULL`
          )
          .all(auth.account.id);
        const exportedProjects = projects.map((project) => {
          const snapshot = db
            .prepare("SELECT revision, doc, updated_at FROM project_snapshots WHERE project_id = ?")
            .get(project.id);
          let doc = null;
          if (snapshot) {
            try {
              doc = JSON.parse(snapshot.doc);
            } catch {
              doc = null;
            }
          }
          return {
            id: project.id,
            name: project.name,
            role: project.role,
            revision: project.revision,
            snapshot: snapshot
              ? { revision: snapshot.revision, updatedAt: snapshot.updated_at, doc }
              : null,
          };
        });
        writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "account.exported",
          resourceType: "account",
          resourceId: auth.account.id,
          ip,
          secret: config.secret,
        });
        sendJson(
          response,
          200,
          {
            account: {
              email: account.email,
              displayName: account.display_name,
              createdAt: account.created_at,
            },
            projects: exportedProjects,
          },
          config
        );
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/account/delete") {
        const auth = requireSessionAuth(request, response, db, config);
        const body = await readJson(request);
        const account = accountById(db, auth.account.id);
        if (!(await verifyPassword(body.password, account.password_hash))) {
          throw new HttpError(401, "invalid password", "invalid_credentials");
        }
        const requestedAt = now();
        const dueAt = requestedAt + config.deletionGraceDays * 86_400_000;
        db.prepare(
          "UPDATE accounts SET deletion_requested_at = ?, deletion_due_at = ?, updated_at = ? WHERE id = ?"
        ).run(requestedAt, dueAt, requestedAt, auth.account.id);
        revokeAllSessions(db, auth.account.id, auth.session.id);
        writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "account.deletion_requested",
          resourceType: "account",
          resourceId: auth.account.id,
          metadata: { dueAt },
          ip,
          secret: config.secret,
        });
        sendJson(response, 202, { deletionScheduledFor: dueAt }, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/account/delete/cancel") {
        const auth = requireSessionAuth(request, response, db, config);
        db.prepare(
          "UPDATE accounts SET deletion_requested_at = NULL, deletion_due_at = NULL, updated_at = ? WHERE id = ?"
        ).run(now(), auth.account.id);
        writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "account.deletion_cancelled",
          resourceType: "account",
          resourceId: auth.account.id,
          ip,
          secret: config.secret,
        });
        sendNoContent(response, 204, config);
        return true;
      }

      if (method === "GET" && url.pathname === "/api/v1/account/tokens") {
        const auth = requireSessionAuth(request, response, db, config);
        sendJson(response, 200, { tokens: listApiTokens(db, auth.account.id) }, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/account/tokens") {
        const auth = requireSessionAuth(request, response, db, config);
        const body = await readJson(request);
        const name = requireString(body.name, "name", 80);
        const allowed = new Set(["projects:read", "projects:write"]);
        const scopes = Array.isArray(body.scopes) ? [...new Set(body.scopes)] : [];
        if (!scopes.length || scopes.some((scope) => !allowed.has(scope))) {
          throw new HttpError(400, "scopes are invalid", "invalid_scopes");
        }
        const days = Number.isInteger(body.expiresInDays) ? body.expiresInDays : 90;
        if (days < 1 || days > 365) {
          throw new HttpError(400, "expiresInDays must be between 1 and 365", "invalid_expiry");
        }
        const created = createApiToken(db, auth.account.id, {
          name,
          scopes,
          expiresAt: now() + days * 86_400_000,
        });
        writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "api_token.created",
          resourceType: "api_token",
          resourceId: created.id,
          metadata: { scopes },
          ip,
          secret: config.secret,
        });
        sendJson(response, 201, { id: created.id, token: created.token, scopes, expiresInDays: days }, config);
        return true;
      }

      const tokenMatch = url.pathname.match(/^\/api\/v1\/account\/tokens\/([^/]+)$/);
      if (method === "DELETE" && tokenMatch) {
        const auth = requireSessionAuth(request, response, db, config);
        if (!revokeApiToken(db, auth.account.id, tokenMatch[1])) {
          throw new HttpError(404, "token not found", "not_found");
        }
        writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "api_token.revoked",
          resourceType: "api_token",
          resourceId: tokenMatch[1],
          ip,
          secret: config.secret,
        });
        sendNoContent(response, 204, config);
        return true;
      }

      if (method === "GET" && url.pathname === "/api/v1/projects") {
        const auth = requireAuth(request, response, db, config);
        requireScope(auth, "projects:read");
        const projects = db
          .prepare(
            `SELECT p.id, p.name, p.revision, p.created_at, p.updated_at, m.role
             FROM projects p JOIN project_members m ON m.project_id = p.id
             WHERE m.account_id = ? AND p.deleted_at IS NULL ORDER BY p.updated_at DESC`
          )
          .all(auth.account.id);
        sendJson(response, 200, { projects }, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/projects") {
        const auth = requireAuth(request, response, db, config);
        requireScope(auth, "projects:write");
        const body = await readJson(request);
        const title = requireString(body.title, "title", 120);
        const projectId = crypto.randomUUID();
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare(
            "INSERT INTO projects (id, owner_account_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
          ).run(projectId, auth.account.id, title, now(), now());
          db.prepare(
            "INSERT INTO project_members (project_id, account_id, role, created_at) VALUES (?, ?, 'owner', ?)"
          ).run(projectId, auth.account.id, now());
          db.prepare(
            "INSERT INTO project_snapshots (project_id, revision, doc, updated_by, updated_at) VALUES (?, 1, ?, ?, ?)"
          ).run(projectId, JSON.stringify({ id: projectId, title, cards: [], connections: [], trash: [] }), auth.account.id, now());
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "project.created",
          resourceType: "project",
          resourceId: projectId,
          ip,
          secret: config.secret,
        });
        sendJson(response, 201, { id: projectId, title, revision: 1, role: "owner" }, config);
        return true;
      }

      const projectMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)$/);
      if (method === "GET" && projectMatch) {
        const auth = requireAuth(request, response, db, config);
        requireScope(auth, "projects:read");
        const role = projectRole(db, projectMatch[1], auth.account.id);
        if (!role) throw new HttpError(404, "project not found", "not_found");
        const project = db
          .prepare("SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL")
          .get(projectMatch[1]);
        if (!project) throw new HttpError(404, "project not found", "not_found");
        const snapshot = db
          .prepare("SELECT revision, doc, updated_at FROM project_snapshots WHERE project_id = ?")
          .get(project.id);
        sendJson(response, 200, { project: { id: project.id, name: project.name, revision: project.revision, role }, snapshot }, config);
        return true;
      }

      const snapshotMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/snapshot$/);
      if (method === "PUT" && snapshotMatch) {
        const auth = requireAuth(request, response, db, config);
        requireScope(auth, "projects:write");
        const role = projectRole(db, snapshotMatch[1], auth.account.id);
        if (!role) throw new HttpError(404, "project not found", "not_found");
        if (!["owner", "editor"].includes(role)) {
          throw new HttpError(403, "editor role required", "forbidden");
        }
        const body = await readJson(request);
        const doc = requireString(body.doc, "doc", 64 * 1024);
        const project = db
          .prepare("SELECT revision FROM projects WHERE id = ? AND deleted_at IS NULL")
          .get(snapshotMatch[1]);
        if (!project) throw new HttpError(404, "project not found", "not_found");
        if (body.revision !== undefined && Number(body.revision) !== project.revision) {
          throw new HttpError(409, "revision conflict", "revision_conflict");
        }
        const revision = project.revision + 1;
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("UPDATE projects SET revision = ?, updated_at = ? WHERE id = ?").run(
            revision,
            now(),
            snapshotMatch[1]
          );
          db.prepare(
            "UPDATE project_snapshots SET revision = ?, doc = ?, updated_by = ?, updated_at = ? WHERE project_id = ?"
          ).run(revision, doc, auth.account.id, now(), snapshotMatch[1]);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "project.snapshot_updated",
          resourceType: "project",
          resourceId: snapshotMatch[1],
          metadata: { revision },
          ip,
          secret: config.secret,
        });
        sendJson(response, 200, { revision }, config);
        return true;
      }

      throw new HttpError(404, "not found", "not_found");
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.message, code: error.code }, config, error.headers);
      } else if (error instanceof AuthError) {
        sendJson(response, error.status, { error: error.message, code: error.code }, config);
      } else {
        logger.error("api.failed", { message: error.message });
        sendJson(response, 500, { error: "internal server error", code: "internal_error" }, config);
      }
      return true;
    }
  };
}
