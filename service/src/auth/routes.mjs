import crypto from "node:crypto";
import { hashIp, writeAudit } from "../audit.mjs";
import { hashPassword, verifyPassword } from "./passwords.mjs";
import { AuthError, authenticateAccess, authenticateApiToken, createApiToken, createSession, listApiTokens, listSessions, publicAccount, revokeAllSessions, revokeApiToken, revokeByRefreshToken, revokeSession, rotateRefresh } from "./sessions.mjs";
import { bearerToken, hashToken, parseCookies, randomToken, serializeCookie } from "./tokens.mjs";
import { createTotpSecret, generateTotp, totpUri, verifyTotp } from "./totp.mjs";
import { clearLoginFailures, loginBlocked, recordLoginAttempt } from "./throttle.mjs";
import {
  acceptInvitation,
  cardInShareScope,
  createInvitation,
  createShareLink,
  findShare,
  hasRole,
  projectSnapshot,
  recordShareAttempt,
  revokeShare,
  rotateShare,
  shareAllows,
  shareBlocked,
  sharedPayload,
} from "../sharing.mjs";
import {
  appendCookie,
  applySecurityHeaders,
  assertSameOrigin,
  clientIp,
  HttpError,
  normalizeEmail,
  readBinary,
  readJson,
  requirePassword,
  requireString,
  sendBinary,
  sendJson,
  sendNoContent,
} from "../http.mjs";
import { ObjectStore } from "../objects.mjs";
import { createEventHub } from "../events.mjs";
import { sendAlert } from "../alerts.mjs";
import {
  createNotification,
  emailNotification,
  listNotifications,
  notifyProjectMembers,
  notifyProjectOwners,
  removeResourceNotifications,
  verifyUnsubscribeToken,
} from "../notifications.mjs";

function now() {
  return Date.now();
}

function integerDays(value) {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new HttpError(400, "expiresInDays must be between 1 and 365", "invalid_expiry");
  }
  return days;
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

function otpHash(accountId, code, secret) {
  return crypto.createHmac("sha256", secret).update(`${accountId}:${code}`).digest("hex");
}

function issueOtp(db, account, secret) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  db.prepare(
    "INSERT INTO email_otps (id, account_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
  ).run(crypto.randomUUID(), account.id, otpHash(account.id, code, secret), now(), now() + 10 * 60_000);
  return code;
}

async function verifyShareForWrite(db, config, { token, body, ip, minimum }) {
  if (!config.publicSharingEnabled) throw new HttpError(404, "not found", "not_found");
  const share = findShare(db, token);
  if (!share || share.revoked_at || (share.expires_at !== null && Number(share.expires_at) <= now())) {
    throw new HttpError(404, "not found", "not_found");
  }
  if (!shareAllows(share.permission, minimum)) {
    throw new HttpError(403, "share permission denied", "forbidden");
  }
  if (shareBlocked(db, { shareId: share.id, ip, config })) {
    throw new HttpError(429, "too many attempts", "rate_limited", { "Retry-After": "300" });
  }
  if (share.password_hash && !(await verifyPassword(body.password, share.password_hash))) {
    recordShareAttempt(db, { shareId: share.id, ip, success: false, config });
    throw new HttpError(404, "not found", "not_found");
  }
  recordShareAttempt(db, { shareId: share.id, ip, success: true, config });
  db.prepare("UPDATE share_links SET last_accessed_at = ? WHERE id = ?").run(now(), share.id);
  return share;
}

export function createApiRouter({ db, config, logger, mailer }) {
  const objects = new ObjectStore(db, config.objectsDir);
  const events = createEventHub();
  const adminRate = new Map();
  const blockedExtensions = new Set([
    "exe", "msi", "bat", "cmd", "ps1", "scr", "com", "dll", "jar", "vbs", "js", "lnk",
  ]);

  async function emailRecipients(accountIds, payload) {
    await Promise.all(
      accountIds.map((accountId) =>
        emailNotification(db, config, mailer, logger, accountId, payload)
      )
    );
  }

  function requireAdmin(request, ipHash) {
    if (!config.adminToken) throw new HttpError(404, "not found", "not_found");
    const hits = adminRate.get(ipHash) || { count: 0, resetAt: Date.now() + 60_000 };
    if (Date.now() >= hits.resetAt) {
      hits.count = 0;
      hits.resetAt = Date.now() + 60_000;
    }
    hits.count += 1;
    adminRate.set(ipHash, hits);
    if (hits.count > 60) throw new HttpError(429, "too many admin requests", "rate_limited");
    const token = bearerToken(request);
    const expected = Buffer.from(config.adminToken);
    const actual = Buffer.from(String(token || ""));
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      throw new HttpError(401, "admin authentication required", "authentication_required");
    }
  }

  function saveSharedDoc(projectId, doc, revision, actorId) {    const serialized = JSON.stringify(doc);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE projects SET revision = ?, updated_at = ? WHERE id = ?").run(
        revision,
        now(),
        projectId
      );
      db.prepare(
        "UPDATE project_snapshots SET revision = ?, doc = ?, updated_by = ?, updated_at = ? WHERE project_id = ?"
      ).run(revision, serialized, actorId, now(), projectId);
      db.prepare(
        "INSERT INTO project_versions (id, project_id, revision, doc, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(crypto.randomUUID(), projectId, revision, serialized, actorId, now());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const route = async function route(request, response) {
    const url = new URL(request.url || "/", config.publicUrl);
    if (!url.pathname.startsWith("/api/v1/")) return false;
    const method = request.method;
    const ip = clientIp(request, config);
    const ipHash = hashIp(ip, config.secret);
    const origin = request.headers.origin;
    const corsAllowed = Boolean(origin) && Boolean(config.corsOrigins?.includes(origin));
    if (corsAllowed) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      response.setHeader(
        "Access-Control-Allow-Headers",
        "authorization, content-type, x-csrf-token, x-file-name"
      );
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      response.setHeader("Access-Control-Max-Age", "600");
    }

    try {
      if (method === "OPTIONS") {
        if (!corsAllowed) throw new HttpError(403, "origin not allowed", "origin_denied");
        response.writeHead(204);
        response.end();
        return true;
      }
      if (!["GET", "HEAD"].includes(method)) assertSameOrigin(request, config);

      if (method === "GET" && url.pathname === "/api/v1/admin/audit") {
        requireAdmin(request, ipHash);
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 100));
        const entries = db
          .prepare(
            `SELECT id, actor_account_id, action, resource_type, resource_id, ip_hash, metadata, created_at
             FROM audit_log ORDER BY created_at DESC LIMIT ?`
          )
          .all(limit)
          .map((entry) => ({
            ...entry,
            metadata: entry.metadata ? JSON.parse(entry.metadata) : null,
          }));
        writeAudit(db, {
          action: "admin.audit_exported",
          resourceType: "admin",
          metadata: { count: entries.length },
          ip,
          secret: config.secret,
        });
        sendJson(response, 200, { entries }, config);
        return true;
      }

      if (method === "GET" && url.pathname === "/api/v1/admin/abuse-reports") {
        requireAdmin(request, ipHash);
        const reports = db
          .prepare(
            `SELECT r.id, r.share_id, r.reason, r.reporter_ip_hash, r.created_at, r.status,
                    s.project_id, s.scope, s.target_id
             FROM abuse_reports r JOIN share_links s ON s.id = r.share_id
             ORDER BY r.created_at DESC LIMIT 200`
          )
          .all();
        sendJson(response, 200, { reports }, config);
        return true;
      }

      if (method === "GET" && url.pathname === "/api/v1/admin/stats") {
        requireAdmin(request, ipHash);
        const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
        sendJson(
          response,
          200,
          {
            accounts: count("accounts"),
            projects: count("projects"),
            shareLinks: count("share_links"),
            abuseReports: count("abuse_reports"),
            notifications: count("notifications"),
            auditEntries: count("audit_log"),
          },
          config
        );
        return true;
      }

      const publicReportMatch = url.pathname.match(/^\/api\/v1\/share\/([^/]+)\/report$/);
      if (method === "POST" && publicReportMatch) {
        const token = decodeURIComponent(publicReportMatch[1]);
        const share = findShare(db, token);
        if (!share || share.revoked_at) throw new HttpError(404, "not found", "not_found");
        const body = await readJson(request);
        const reason = requireString(body.reason, "reason", 500);
        if (reason.length < 3) throw new HttpError(400, "reason is too short", "invalid_reason");
        db.prepare(
          "INSERT INTO abuse_reports (id, share_id, reason, reporter_ip_hash, created_at) VALUES (?, ?, ?, ?, ?)"
        ).run(crypto.randomUUID(), share.id, reason, hashIp(ip, config.secret), now());
        writeAudit(db, {
          action: "share.reported",
          resourceType: "share_link",
          resourceId: share.id,
          ip,
          secret: config.secret,
        });
        notifyProjectOwners(db, share.project_id, {
          kind: "share.reported",
          title: "A shared link was reported",
          body: reason,
          resourceType: "share_link",
          resourceId: share.id,
        });
        await emailRecipients(
          db
            .prepare("SELECT account_id FROM project_members WHERE project_id = ? AND role = 'owner'")
            .all(share.project_id)
            .map((row) => row.account_id),
          {
            kind: "share.reported",
            title: "A shared link was reported",
            body: "A shared link in your project was reported.",
          }
        );
        sendJson(response, 202, { status: "reported" }, config);
        return true;
      }

      const publicShareMatch = url.pathname.match(/^\/api\/v1\/share\/([^/]+)\/access$/);
      if (method === "POST" && publicShareMatch) {
        if (!config.publicSharingEnabled) throw new HttpError(404, "not found", "not_found");
        const token = decodeURIComponent(publicShareMatch[1]);
        const share = findShare(db, token);
        if (
          !share ||
          share.revoked_at ||
          (share.expires_at !== null && Number(share.expires_at) <= now())
        ) {
          throw new HttpError(404, "not found", "not_found");
        }
        if (shareBlocked(db, { shareId: share.id, ip, config })) {
          throw new HttpError(429, "too many attempts", "rate_limited", {
            "Retry-After": "300",
          });
        }
        const body = await readJson(request);
        if (share.password_hash) {
          const valid = await verifyPassword(body.password, share.password_hash);
          if (!valid) {
            recordShareAttempt(db, { shareId: share.id, ip, success: false, config });
            throw new HttpError(404, "not found", "not_found");
          }
        }
        recordShareAttempt(db, { shareId: share.id, ip, success: true, config });
        db.prepare("UPDATE share_links SET last_accessed_at = ? WHERE id = ?").run(now(), share.id);
        const payload = sharedPayload(db, share);
        if (!payload) throw new HttpError(404, "not found", "not_found");
        writeAudit(db, {
          action: "share.accessed",
          resourceType: "share_link",
          resourceId: share.id,
          metadata: { scope: share.scope, permission: share.permission },
          ip,
          secret: config.secret,
        });
        sendJson(
          response,
          200,
          {
            ...payload,
            expiresAt: share.expires_at,
            downloadAllowed: Boolean(share.download_allowed),
          },
          config,
          { "X-Robots-Tag": "noindex, nofollow" }
        );
        return true;
      }

      const shareCommentMatch = url.pathname.match(/^\/api\/v1\/share\/([^/]+)\/comments$/);
      if (method === "POST" && shareCommentMatch) {
        assertSameOrigin(request, config);
        const body = await readJson(request);
        const share = await verifyShareForWrite(db, config, {
          token: decodeURIComponent(shareCommentMatch[1]),
          body,
          ip,
          minimum: "comment",
        });
        const snapshot = projectSnapshot(db, share.project_id);
        if (!snapshot) throw new HttpError(404, "not found", "not_found");
        const cardId = requireString(body.cardId, "cardId", 200);
        if (!cardInShareScope(snapshot.doc, share, cardId)) {
          throw new HttpError(404, "card not found in this share", "not_found");
        }
        const card = snapshot.doc.cards.find((entry) => entry.id === cardId);
        const text = requireString(body.text, "text", 2000);
        if (body.revision !== undefined && Number(body.revision) !== snapshot.project.revision) {
          throw new HttpError(409, "revision conflict", "revision_conflict");
        }
        card.shareComments = Array.isArray(card.shareComments) ? card.shareComments : [];
        if (card.shareComments.length >= 500) {
          throw new HttpError(409, "comment limit reached", "comment_limit");
        }
        const comment = {
          id: crypto.randomUUID(),
          author: "Shared guest",
          text,
          ts: now(),
        };
        card.shareComments.push(comment);
        const revision = snapshot.project.revision + 1;
        saveSharedDoc(share.project_id, snapshot.doc, revision, null);
        events.publish(share.project_id, {
          type: "snapshot",
          projectId: share.project_id,
          revision,
        });
        writeAudit(db, {
          action: "share.comment_added",
          resourceType: "share_link",
          resourceId: share.id,
          metadata: { cardId, revision },
          ip,
          secret: config.secret,
        });
        notifyProjectOwners(db, share.project_id, {
          kind: "share.comment",
          title: "New comment on a shared link",
          body: "A shared link received a new comment.",
          resourceType: "share_link",
          resourceId: share.id,
        });
        await emailRecipients(
          db
            .prepare("SELECT account_id FROM project_members WHERE project_id = ? AND role = 'owner'")
            .all(share.project_id)
            .map((row) => row.account_id),
          {
            kind: "share.comment",
            title: "New comment on a shared link",
            body: "A shared link in your project received a new comment.",
          }
        );
        sendJson(response, 201, { revision, comment }, config);
        return true;
      }

      const shareCardMatch = url.pathname.match(/^\/api\/v1\/share\/([^/]+)\/cards\/([^/]+)$/);
      if (method === "PATCH" && shareCardMatch) {
        assertSameOrigin(request, config);
        const body = await readJson(request);
        const share = await verifyShareForWrite(db, config, {
          token: decodeURIComponent(shareCardMatch[1]),
          body,
          ip,
          minimum: "edit",
        });
        const snapshot = projectSnapshot(db, share.project_id);
        if (!snapshot) throw new HttpError(404, "not found", "not_found");
        const cardId = decodeURIComponent(shareCardMatch[2]);
        if (!cardInShareScope(snapshot.doc, share, cardId)) {
          throw new HttpError(404, "card not found in this share", "not_found");
        }
        const card = snapshot.doc.cards.find((entry) => entry.id === cardId);
        if (!body.fields || typeof body.fields !== "object" || Array.isArray(body.fields)) {
          throw new HttpError(400, "fields are required", "invalid_input");
        }
        if (body.revision !== undefined && Number(body.revision) !== snapshot.project.revision) {
          throw new HttpError(409, "revision conflict", "revision_conflict");
        }
        const limits = { text: 20_000, title: 2_000, caption: 2_000, description: 2_000, url: 2_000 };
        let changed = 0;
        for (const [key, limit] of Object.entries(limits)) {
          if (body.fields[key] === undefined) continue;
          if (typeof body.fields[key] !== "string" || body.fields[key].length > limit) {
            throw new HttpError(400, `invalid field: ${key}`, "invalid_input");
          }
          card[key] = body.fields[key];
          changed += 1;
        }
        if (typeof body.fields.checked === "boolean") {
          card.checked = body.fields.checked;
          changed += 1;
        }
        if (!changed) throw new HttpError(400, "no editable fields", "invalid_input");
        const revision = snapshot.project.revision + 1;
        saveSharedDoc(share.project_id, snapshot.doc, revision, null);
        events.publish(share.project_id, {
          type: "snapshot",
          projectId: share.project_id,
          revision,
        });
        writeAudit(db, {
          action: "share.card_edited",
          resourceType: "share_link",
          resourceId: share.id,
          metadata: { cardId, revision },
          ip,
          secret: config.secret,
        });
        notifyProjectOwners(db, share.project_id, {
          kind: "share.edit",
          title: "A shared link edited a card",
          body: "A shared link edited a card in the project.",
          resourceType: "share_link",
          resourceId: share.id,
        });
        await emailRecipients(
          db
            .prepare("SELECT account_id FROM project_members WHERE project_id = ? AND role = 'owner'")
            .all(share.project_id)
            .map((row) => row.account_id),
          {
            kind: "share.edit",
            title: "A shared link edited a card",
            body: "A shared link in your project edited a card.",
          }
        );
        sendJson(response, 200, { revision }, config);
        return true;
      }

      const publicAssetMatch = url.pathname.match(/^\/api\/v1\/share\/([^/]+)\/assets\/([^/]+)$/);
      if (method === "POST" && publicAssetMatch) {
        if (!config.publicSharingEnabled) throw new HttpError(404, "not found", "not_found");
        const share = findShare(db, decodeURIComponent(publicAssetMatch[1]));
        if (
          !share ||
          share.revoked_at ||
          (share.expires_at !== null && Number(share.expires_at) <= now())
        ) {
          throw new HttpError(404, "not found", "not_found");
        }
        if (!share.download_allowed) throw new HttpError(403, "download not allowed", "download_denied");
        if (shareBlocked(db, { shareId: share.id, ip, config })) {
          throw new HttpError(429, "too many attempts", "rate_limited", { "Retry-After": "300" });
        }
        const body = await readJson(request);
        if (share.password_hash && !(await verifyPassword(body.password, share.password_hash))) {
          recordShareAttempt(db, { shareId: share.id, ip, success: false, config });
          throw new HttpError(404, "not found", "not_found");
        }
        const assetId = decodeURIComponent(publicAssetMatch[2]);
        const asset = db
          .prepare("SELECT * FROM project_assets WHERE id = ? AND project_id = ?")
          .get(assetId, share.project_id);
        if (!asset) throw new HttpError(404, "not found", "not_found");
        if (share.scope !== "project") {
          const scoped = sharedPayload(db, share);
          if (!scoped || !JSON.stringify(scoped).includes(assetId)) {
            throw new HttpError(404, "not found", "not_found");
          }
        }
        const object = objects.get(asset.object_id);
        if (!object) throw new HttpError(404, "not found", "not_found");
        recordShareAttempt(db, { shareId: share.id, ip, success: true, config });
        db.prepare("UPDATE share_links SET last_accessed_at = ? WHERE id = ?").run(now(), share.id);
        writeAudit(db, {
          action: "share.asset_downloaded",
          resourceType: "share_link",
          resourceId: share.id,
          metadata: { assetId },
          ip,
          secret: config.secret,
        });
        sendBinary(response, config, object.body, {
          contentType: asset.content_type,
          filename: asset.name,
          download: true,
        });
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/sso/login") {
        if (!config.ssoEnabled) throw new HttpError(404, "not found", "not_found");
        const headerEmail = request.headers[config.ssoHeader];
        const signature = request.headers["x-khaoyu-sso-signature"];
        if (typeof headerEmail !== "string" || typeof signature !== "string") {
          throw new HttpError(401, "SSO authentication required", "authentication_required");
        }
        let email;
        try {
          email = normalizeEmail(headerEmail);
        } catch {
          throw new HttpError(401, "SSO authentication required", "authentication_required");
        }
        const expected = crypto.createHmac("sha256", config.ssoSecret).update(email).digest("hex");
        const expectedBuffer = Buffer.from(expected);
        const actualBuffer = Buffer.from(signature.toLowerCase());
        if (
          expectedBuffer.length !== actualBuffer.length ||
          !crypto.timingSafeEqual(expectedBuffer, actualBuffer)
        ) {
          throw new HttpError(401, "SSO authentication required", "authentication_required");
        }
        let account = db.prepare("SELECT * FROM accounts WHERE email = ?").get(email);
        if (!account) {
          if (!config.ssoAutoCreate) {
            throw new HttpError(403, "SSO account does not exist", "sso_account_missing");
          }
          const displayName = String(
            request.headers[config.ssoNameHeader] || email.split("@")[0]
          ).slice(0, 120);
          const id = crypto.randomUUID();
          db.prepare(
            "INSERT INTO accounts (id, email, display_name, password_hash, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)"
          ).run(id, email, displayName, now(), now(), now());
          account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
        }
        if (account.deleted_at) {
          throw new HttpError(403, "account is pending deletion", "account_deleted");
        }
        const session = createSession(db, config, account, {
          ipHash,
          userAgent: request.headers["user-agent"],
        });
        setSessionCookies(response, config, session);
        writeAudit(db, {
          actorAccountId: account.id,
          action: "auth.login_sso",
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

      if (method === "POST" && url.pathname === "/api/v1/auth/otp/request") {
        const body = await readJson(request);
        const email = normalizeEmail(body.email);
        const account = db
          .prepare("SELECT * FROM accounts WHERE email = ? AND deleted_at IS NULL")
          .get(email);
        if (account && account.email_verified_at) {
          const recent = db
            .prepare("SELECT created_at FROM email_otps WHERE account_id = ? ORDER BY created_at DESC LIMIT 1")
            .get(account.id);
          if (!recent || now() - Number(recent.created_at) >= 60_000) {
            const code = issueOtp(db, account, config.secret);
            await mailer.send({
              to: account.email,
              kind: "otp",
              subject: "Your Khaoyu Note login code",
              text: `One-time login code: ${code}`,
            });
            writeAudit(db, {
              actorAccountId: account.id,
              action: "auth.otp_sent",
              resourceType: "account",
              resourceId: account.id,
              secret: config.secret,
            });
          }
        }
        sendJson(response, 202, { status: "accepted" }, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/otp/login") {
        const body = await readJson(request);
        const email = normalizeEmail(body.email);
        const code = String(body.code || "");
        if (!/^\d{6}$/.test(code)) throw new HttpError(401, "Invalid email or code", "invalid_credentials");
        const throttle = loginBlocked(db, { email, ip, config });
        if (throttle.blocked) {
          recordLoginAttempt(db, { email, ip, success: false, secret: config.secret });
          void sendAlert(config, logger, {
            event: "auth.login_blocked",
            method: "otp",
            attempts: throttle.attempts,
            retryAfter: throttle.retryAfter,
            ipHash,
          });
          sendJson(response, 429, { error: "Too many attempts" }, config, {
            "Retry-After": String(throttle.retryAfter),
          });
          return true;
        }
        const account = db
          .prepare("SELECT * FROM accounts WHERE email = ? AND deleted_at IS NULL")
          .get(email);
        const otp = account
          ? db
              .prepare(
                "SELECT * FROM email_otps WHERE account_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1"
              )
              .get(account.id, now())
          : null;
        const valid =
          Boolean(otp) &&
          Number(otp.attempts) < 5 &&
          otp.code_hash === otpHash(account.id, code, config.secret);
        if (!valid || !account.email_verified_at) {
          if (account) {
            db.prepare("UPDATE email_otps SET attempts = attempts + 1 WHERE id = ?").run(
              otp?.id || ""
            );
          }
          recordLoginAttempt(db, { email, ip, success: false, secret: config.secret });
          sendJson(response, 401, { error: "Invalid email or code" }, config);
          return true;
        }
        if (account.totp_enabled_at && !verifyTotp(account.totp_secret, body.totp)) {
          recordLoginAttempt(db, { email, ip, success: false, secret: config.secret });
          sendJson(response, 401, { error: "Invalid email or code" }, config);
          return true;
        }
        db.prepare("UPDATE email_otps SET used_at = ? WHERE id = ?").run(now(), otp.id);
        clearLoginFailures(db, { email, ip, secret: config.secret });
        const session = createSession(db, config, account, {
          ipHash,
          userAgent: request.headers["user-agent"],
        });
        setSessionCookies(response, config, session);
        writeAudit(db, {
          actorAccountId: account.id,
          action: "auth.login_otp",
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
          void sendAlert(config, logger, {
            event: "auth.login_blocked",
            method: "password",
            attempts: throttle.attempts,
            retryAfter: throttle.retryAfter,
            ipHash,
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

      const shareCollectionMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/shares$/);
      if (shareCollectionMatch && (method === "GET" || method === "POST")) {
        const auth = requireSessionAuth(request, response, db, config);
        const projectId = shareCollectionMatch[1];
        const role = projectRole(db, projectId, auth.account.id);
        if (!role) throw new HttpError(404, "project not found", "not_found");
        if (!hasRole(role, "editor")) throw new HttpError(403, "editor role required", "forbidden");
        if (method === "GET") {
          const links = db
            .prepare(
              "SELECT id, scope, target_id, permission, download_allowed, created_at, expires_at, revoked_at, last_accessed_at FROM share_links WHERE project_id = ? ORDER BY created_at DESC"
            )
            .all(projectId)
            .map((link) => ({
              id: link.id,
              scope: link.scope,
              targetId: link.target_id,
              permission: link.permission,
              downloadAllowed: Boolean(link.download_allowed),
              createdAt: link.created_at,
              expiresAt: link.expires_at,
              revoked: Boolean(link.revoked_at),
              lastAccessedAt: link.last_accessed_at,
            }));
          sendJson(response, 200, { shares: links }, config);
          return true;
        }
        const body = await readJson(request);
        const snapshot = projectSnapshot(db, projectId);
        if (!snapshot) throw new HttpError(404, "project not found", "not_found");
        if (!config.publicSharingEnabled) {
          throw new HttpError(409, "public sharing is disabled by the operator", "sharing_disabled");
        }
        if (!snapshot.project.public_sharing_enabled) {
          throw new HttpError(409, "public sharing is disabled for this project", "sharing_disabled");
        }
        const scope = ["project", "item", "column"].includes(body.scope) ? body.scope : null;
        const permission = ["view", "comment", "edit", "manage"].includes(body.permission)
          ? body.permission
          : null;
        if (!scope || !permission) throw new HttpError(400, "invalid share scope or permission", "invalid_share");
        let targetId = null;
        if (scope !== "project") {
          targetId = requireString(body.targetId, "targetId", 200);
          const card = (snapshot.doc.cards || []).find((entry) => entry.id === targetId);
          if (!card || (scope === "column" && card.type !== "column")) {
            throw new HttpError(404, "shared target not found", "not_found");
          }
        }
        const passwordHash =
          body.password === undefined || body.password === ""
            ? null
            : await hashPassword(requirePassword(body.password));
        const expiresAt =
          body.expiresInDays === undefined || body.expiresInDays === null
            ? null
            : now() + integerDays(body.expiresInDays) * 86_400_000;
        const created = createShareLink(db, {
          projectId,
          scope,
          targetId,
          permission,
          passwordHash,
          expiresAt,
          downloadAllowed: Boolean(body.downloadAllowed),
          createdBy: auth.account.id,
        });
        writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "share.created",
          resourceType: "share_link",
          resourceId: created.id,
          metadata: { scope, permission, targetId, expiresAt },
          ip,
          secret: config.secret,
        });
        sendJson(response, 201, { id: created.id, token: created.token, scope, permission, expiresAt }, config);
        return true;
      }

      const shareItemMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/shares\/([^/]+)$/);
      if (method === "DELETE" && shareItemMatch) {
        const auth = requireSessionAuth(request, response, db, config);
        const role = projectRole(db, shareItemMatch[1], auth.account.id);
        if (!hasRole(role, "editor")) throw new HttpError(403, "editor role required", "forbidden");
        if (!revokeShare(db, shareItemMatch[1], shareItemMatch[2], auth.account.id, config)) {
          throw new HttpError(404, "share not found", "not_found");
        }
        removeResourceNotifications(db, "share_link", shareItemMatch[2]);
        sendNoContent(response, 204, config);
        return true;
      }

      const shareRotateMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/shares\/([^/]+)\/rotate$/);
      if (method === "POST" && shareRotateMatch) {
        const auth = requireSessionAuth(request, response, db, config);
        const role = projectRole(db, shareRotateMatch[1], auth.account.id);
        if (!hasRole(role, "editor")) throw new HttpError(403, "editor role required", "forbidden");
        const token = rotateShare(db, shareRotateMatch[1], shareRotateMatch[2], auth.account.id);
        if (!token) throw new HttpError(404, "share not found", "not_found");
        writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "share.rotated",
          resourceType: "share_link",
          resourceId: shareRotateMatch[2],
          ip,
          secret: config.secret,
        });
        sendJson(response, 200, { token }, config);
        return true;
      }

      const publicFlagMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/public-sharing$/);
      if (method === "POST" && publicFlagMatch) {
        const auth = requireSessionAuth(request, response, db, config);
        const role = projectRole(db, publicFlagMatch[1], auth.account.id);
        if (role !== "owner") throw new HttpError(403, "owner role required", "forbidden");
        const body = await readJson(request);
        db.prepare("UPDATE projects SET public_sharing_enabled = ?, updated_at = ? WHERE id = ?").run(
          body.enabled ? 1 : 0,
          now(),
          publicFlagMatch[1]
        );
        if (!body.enabled) {
          db.prepare(
            "UPDATE share_links SET revoked_at = ? WHERE project_id = ? AND revoked_at IS NULL"
          ).run(now(), publicFlagMatch[1]);
          db.prepare(
            "DELETE FROM notifications WHERE resource_type = 'share_link' AND resource_id IN (SELECT id FROM share_links WHERE project_id = ?)"
          ).run(publicFlagMatch[1]);
        }
        writeAudit(db, {
          actorAccountId: auth.account.id,
          action: body.enabled ? "project.public_sharing_enabled" : "project.public_sharing_disabled",
          resourceType: "project",
          resourceId: publicFlagMatch[1],
          ip,
          secret: config.secret,
        });
        sendNoContent(response, 204, config);
        return true;
      }

      const invitationCollectionMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/invitations$/);
      if (invitationCollectionMatch && (method === "GET" || method === "POST")) {
        const auth = requireSessionAuth(request, response, db, config);
        const projectId = invitationCollectionMatch[1];
        const role = projectRole(db, projectId, auth.account.id);
        if (method === "GET" && !hasRole(role, "editor")) {
          throw new HttpError(403, "editor role required", "forbidden");
        }
        if (method === "POST" && role !== "owner") {
          throw new HttpError(403, "owner role required", "forbidden");
        }
        if (method === "GET") {
          const invitations = db
            .prepare(
              "SELECT id, email, role, created_at, expires_at, accepted_at, revoked_at FROM project_invitations WHERE project_id = ? ORDER BY created_at DESC"
            )
            .all(projectId)
            .map((invitation) => ({
              id: invitation.id,
              email: invitation.email,
              role: invitation.role,
              createdAt: invitation.created_at,
              expiresAt: invitation.expires_at,
              accepted: Boolean(invitation.accepted_at),
              revoked: Boolean(invitation.revoked_at),
            }));
          sendJson(response, 200, { invitations }, config);
          return true;
        }
        const body = await readJson(request);
        const email = normalizeEmail(body.email);
        const invitedRole = ["editor", "commenter", "viewer"].includes(body.role) ? body.role : null;
        if (!invitedRole) throw new HttpError(400, "invalid invitation role", "invalid_role");
        const existing = db
          .prepare(
            "SELECT 1 FROM project_members m JOIN accounts a ON a.id = m.account_id WHERE m.project_id = ? AND a.email = ?"
          )
          .get(projectId, email);
        if (existing) throw new HttpError(409, "account is already a member", "already_member");
        const created = createInvitation(db, {
          projectId,
          email,
          role: invitedRole,
          invitedBy: auth.account.id,
          expiresAt: now() + 7 * 86_400_000,
        });
        await mailer.send({
          to: email,
          kind: "invite",
          subject: "Invitation to a Khaoyu Note project",
          text: `Invitation token: ${created.token}`,
        });
        writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "invitation.created",
          resourceType: "project_invitation",
          resourceId: created.id,
          metadata: { role: invitedRole },
          ip,
          secret: config.secret,
        });
        sendJson(response, 201, { id: created.id, email, role: invitedRole }, config);
        return true;
      }

      const invitationItemMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/invitations\/([^/]+)$/);
      if (method === "DELETE" && invitationItemMatch) {
        const auth = requireSessionAuth(request, response, db, config);
        const role = projectRole(db, invitationItemMatch[1], auth.account.id);
        if (role !== "owner") throw new HttpError(403, "owner role required", "forbidden");
        const result = db
          .prepare(
            "UPDATE project_invitations SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL"
          )
          .run(now(), invitationItemMatch[2], invitationItemMatch[1]);
        if (!result.changes) throw new HttpError(404, "invitation not found", "not_found");
        sendNoContent(response, 204, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/invitations/accept") {
        const auth = requireSessionAuth(request, response, db, config);
        const body = await readJson(request);
        const result = acceptInvitation(db, {
          token: requireString(body.token, "token", 200),
          account: auth.account,
        });
        if (!result) throw new HttpError(404, "invitation not found", "not_found");
        notifyProjectOwners(db, result.projectId, {
          except: auth.account.id,
          kind: "invitation.accepted",
          title: "Invitation accepted",
          body: `${auth.account.email} joined as ${result.role}.`,
        });
        await emailRecipients(
          db
            .prepare("SELECT account_id FROM project_members WHERE project_id = ? AND role = 'owner' AND account_id != ?")
            .all(result.projectId, auth.account.id)
            .map((row) => row.account_id),
          {
            kind: "invitation.accepted",
            title: "Invitation accepted",
            body: `${auth.account.email} joined a project as ${result.role}.`,
          }
        );
        writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "invitation.accepted",
          resourceType: "project",
          resourceId: result.projectId,
          metadata: { role: result.role, alreadyMember: Boolean(result.alreadyMember) },
          ip,
          secret: config.secret,
        });
        sendJson(response, 200, result, config);
        return true;
      }

      const membersMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/members$/);
      if (method === "GET" && membersMatch) {
        const auth = requireSessionAuth(request, response, db, config);
        const role = projectRole(db, membersMatch[1], auth.account.id);
        if (!role) throw new HttpError(404, "project not found", "not_found");
        const members = db
          .prepare(
            `SELECT a.id, a.email, a.display_name, m.role, m.created_at
             FROM project_members m JOIN accounts a ON a.id = m.account_id
             WHERE m.project_id = ? ORDER BY m.created_at`
          )
          .all(membersMatch[1]);
        sendJson(response, 200, { members }, config);
        return true;
      }

      const memberMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/members\/([^/]+)$/);
      if (memberMatch && (method === "PATCH" || method === "DELETE")) {
        const auth = requireSessionAuth(request, response, db, config);
        if (projectRole(db, memberMatch[1], auth.account.id) !== "owner") {
          throw new HttpError(403, "owner role required", "forbidden");
        }
        const target = db
          .prepare("SELECT role FROM project_members WHERE project_id = ? AND account_id = ?")
          .get(memberMatch[1], memberMatch[2]);
        if (!target) throw new HttpError(404, "member not found", "not_found");
        if (target.role === "owner") throw new HttpError(409, "cannot change the owner", "owner_protected");
        if (method === "PATCH") {
          const body = await readJson(request);
          if (!["editor", "commenter", "viewer"].includes(body.role)) {
            throw new HttpError(400, "invalid member role", "invalid_role");
          }
          db.prepare("UPDATE project_members SET role = ? WHERE project_id = ? AND account_id = ?").run(
            body.role,
            memberMatch[1],
            memberMatch[2]
          );
          createNotification(db, {
            accountId: memberMatch[2],
            kind: "member.role_changed",
            title: "Project role changed",
            body: `Your role is now ${body.role}.`,
            resourceType: "project",
            resourceId: memberMatch[1],
          });
          await emailNotification(db, config, mailer, logger, memberMatch[2], {
            kind: "member.role_changed",
            title: "Project role changed",
            body: `Your role is now ${body.role}.`,
          });
          writeAudit(db, {
            actorAccountId: auth.account.id,
            action: "member.role_changed",
            resourceType: "project",
            resourceId: memberMatch[1],
            metadata: { accountId: memberMatch[2], role: body.role },
            ip,
            secret: config.secret,
          });
          sendNoContent(response, 204, config);
          return true;
        }
        db.prepare("DELETE FROM project_members WHERE project_id = ? AND account_id = ?").run(
          memberMatch[1],
          memberMatch[2]
        );
        writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "member.removed",
          resourceType: "project",
          resourceId: memberMatch[1],
          metadata: { accountId: memberMatch[2] },
          ip,
          secret: config.secret,
        });
        sendNoContent(response, 204, config);
        return true;
      }

      const transferMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/transfer$/);
      if (method === "POST" && transferMatch) {
        const auth = requireSessionAuth(request, response, db, config);
        if (projectRole(db, transferMatch[1], auth.account.id) !== "owner") {
          throw new HttpError(403, "owner role required", "forbidden");
        }
        const body = await readJson(request);
        const target = requireString(body.accountId, "accountId", 200);
        const targetRole = projectRole(db, transferMatch[1], target);
        if (!targetRole) throw new HttpError(404, "member not found", "not_found");
        if (target === auth.account.id) throw new HttpError(409, "already the owner", "invalid_transfer");
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("UPDATE project_members SET role = 'editor' WHERE project_id = ? AND account_id = ?").run(
            transferMatch[1],
            auth.account.id
          );
          db.prepare("UPDATE project_members SET role = 'owner' WHERE project_id = ? AND account_id = ?").run(
            transferMatch[1],
            target
          );
          db.prepare("UPDATE projects SET owner_account_id = ?, updated_at = ? WHERE id = ?").run(
            target,
            now(),
            transferMatch[1]
          );
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "project.ownership_transferred",
          resourceType: "project",
          resourceId: transferMatch[1],
          metadata: { to: target },
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
        requireScope(auth, "projects:write");        const body = await readJson(request);
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

      if (method === "GET" && url.pathname === "/api/v1/account/email-preferences") {
        const auth = requireSessionAuth(request, response, db, config);
        const preference = db
          .prepare("SELECT notifications FROM email_preferences WHERE account_id = ?")
          .get(auth.account.id);
        sendJson(response, 200, { notifications: Boolean(preference?.notifications) }, config);
        return true;
      }

      if (method === "PATCH" && url.pathname === "/api/v1/account/email-preferences") {
        const auth = requireSessionAuth(request, response, db, config);
        const body = await readJson(request);
        if (typeof body.notifications !== "boolean") {
          throw new HttpError(400, "notifications must be a boolean", "invalid_input");
        }
        db.prepare(
          `INSERT INTO email_preferences (account_id, notifications, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET notifications = excluded.notifications, updated_at = excluded.updated_at`
        ).run(auth.account.id, body.notifications ? 1 : 0, now());
        sendJson(response, 200, { notifications: body.notifications }, config);
        return true;
      }

      if (method === "GET" && url.pathname === "/api/v1/email/unsubscribe") {
        const token = url.searchParams.get("token") || "";
        const accountId = verifyUnsubscribeToken(token, config.secret);
        if (!accountId) throw new HttpError(400, "invalid unsubscribe token", "invalid_token");
        db.prepare(
          `INSERT INTO email_preferences (account_id, notifications, updated_at) VALUES (?, 0, ?)
           ON CONFLICT(account_id) DO UPDATE SET notifications = 0, updated_at = excluded.updated_at`
        ).run(accountId, now());
        writeAudit(db, {
          action: "account.email_unsubscribed",
          resourceType: "account",
          resourceId: accountId,
          secret: config.secret,
        });
        sendJson(response, 200, { unsubscribed: true }, config);
        return true;
      }

      if (method === "GET" && url.pathname === "/api/v1/notifications") {
        const auth = requireSessionAuth(request, response, db, config);
        const notifications = listNotifications(db, { accountId: auth.account.id });
        sendJson(
          response,
          200,
          {
            notifications: notifications.map((entry) => ({
              id: entry.id,
              kind: entry.kind,
              title: entry.title,
              body: entry.body,
              resourceType: entry.resource_type,
              resourceId: entry.resource_id,
              createdAt: entry.created_at,
              readAt: entry.read_at,
            })),
            unread: notifications.filter((entry) => !entry.read_at).length,
          },
          config
        );
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/notifications/read-all") {
        const auth = requireSessionAuth(request, response, db, config);
        const result = db
          .prepare("UPDATE notifications SET read_at = ? WHERE account_id = ? AND read_at IS NULL")
          .run(now(), auth.account.id);
        sendJson(response, 200, { updated: Number(result.changes) }, config);
        return true;
      }

      const notificationReadMatch = url.pathname.match(/^\/api\/v1\/notifications\/([^/]+)\/read$/);
      if (method === "PATCH" && notificationReadMatch) {
        const auth = requireSessionAuth(request, response, db, config);
        const result = db
          .prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND account_id = ? AND read_at IS NULL")
          .run(now(), notificationReadMatch[1], auth.account.id);
        if (!result.changes) throw new HttpError(404, "notification not found", "not_found");
        sendNoContent(response, 204, config);
        return true;
      }

      const eventsMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/events$/);
      if (method === "GET" && eventsMatch) {
        const auth = requireAuth(request, response, db, config);
        const role = projectRole(db, eventsMatch[1], auth.account.id);
        if (!role) throw new HttpError(404, "project not found", "not_found");
        applySecurityHeaders(response, config);
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        response.flushHeaders();
        const client = events.subscribe(eventsMatch[1], auth.account.id, response);
        request.on("close", () => events.unsubscribe(client));
        return true;
      }

      const versionsMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/versions$/);
      if (method === "GET" && versionsMatch) {
        const auth = requireAuth(request, response, db, config);
        requireScope(auth, "projects:read");
        const role = projectRole(db, versionsMatch[1], auth.account.id);
        if (!role) throw new HttpError(404, "project not found", "not_found");
        const versions = db
          .prepare(
            `SELECT revision, created_by, created_at, length(doc) AS bytes
             FROM project_versions WHERE project_id = ? ORDER BY revision DESC LIMIT 100`
          )
          .all(versionsMatch[1]);
        sendJson(response, 200, { versions }, config);
        return true;
      }

      const restoreMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/versions\/(\d+)\/restore$/);
      if (method === "POST" && restoreMatch) {
        const auth = requireAuth(request, response, db, config);
        requireScope(auth, "projects:write");
        const role = projectRole(db, restoreMatch[1], auth.account.id);
        if (!role) throw new HttpError(404, "project not found", "not_found");
        if (!hasRole(role, "editor")) throw new HttpError(403, "editor role required", "forbidden");
        const version = db
          .prepare("SELECT doc FROM project_versions WHERE project_id = ? AND revision = ?")
          .get(restoreMatch[1], Number(restoreMatch[2]));
        if (!version) throw new HttpError(404, "version not found", "not_found");
        const current = db
          .prepare("SELECT revision FROM projects WHERE id = ? AND deleted_at IS NULL")
          .get(restoreMatch[1]);
        if (!current) throw new HttpError(404, "project not found", "not_found");
        const revision = current.revision + 1;
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("UPDATE projects SET revision = ?, updated_at = ? WHERE id = ?").run(
            revision,
            now(),
            restoreMatch[1]
          );
          db.prepare(
            "UPDATE project_snapshots SET revision = ?, doc = ?, updated_by = ?, updated_at = ? WHERE project_id = ?"
          ).run(revision, version.doc, auth.account.id, now(), restoreMatch[1]);
          db.prepare(
            "INSERT INTO project_versions (id, project_id, revision, doc, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)"
          ).run(crypto.randomUUID(), restoreMatch[1], revision, version.doc, auth.account.id, now());
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        events.publish(restoreMatch[1], {
          type: "snapshot",
          projectId: restoreMatch[1],
          revision,
          restoredFrom: Number(restoreMatch[2]),
          actor: auth.account.id,
        });
        writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "project.version_restored",
          resourceType: "project",
          resourceId: restoreMatch[1],
          metadata: { fromRevision: Number(restoreMatch[2]), revision },
          ip,
          secret: config.secret,
        });
        notifyProjectMembers(db, restoreMatch[1], {
          except: auth.account.id,
          kind: "project.version_restored",
          title: "Project restored to an earlier revision",
          body: `Revision ${revision} was restored from revision ${restoreMatch[2]}.`,
        });
        await emailRecipients(
          db
            .prepare("SELECT account_id FROM project_members WHERE project_id = ? AND account_id != ?")
            .all(restoreMatch[1], auth.account.id)
            .map((row) => row.account_id),
          {
            kind: "project.version_restored",
            title: "Project restored to an earlier revision",
            body: `Revision ${revision} was restored from revision ${restoreMatch[2]}.`,
          }
        );
        sendJson(response, 200, { revision, restoredFrom: Number(restoreMatch[2]) }, config);
        return true;
      }

      const assetCollectionMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/assets$/);
      if (assetCollectionMatch && (method === "GET" || method === "POST")) {
        const auth = requireAuth(request, response, db, config);
        const projectId = assetCollectionMatch[1];
        const role = projectRole(db, projectId, auth.account.id);
        if (!role) throw new HttpError(404, "project not found", "not_found");
        if (method === "GET") {
          requireScope(auth, "projects:read");
          const assets = db
            .prepare(
              "SELECT id, name, content_type, bytes, created_at FROM project_assets WHERE project_id = ? ORDER BY created_at DESC"
            )
            .all(projectId)
            .map((asset) => ({
              id: asset.id,
              name: asset.name,
              contentType: asset.content_type,
              bytes: asset.bytes,
              createdAt: asset.created_at,
            }));
          sendJson(response, 200, { assets }, config);
          return true;
        }
        requireScope(auth, "projects:write");
        if (!hasRole(role, "editor")) throw new HttpError(403, "editor role required", "forbidden");
        const filename = String(request.headers["x-file-name"] || "asset")
          .split(/[\\/]/)
          .pop()
          .slice(0, 200);
        const extension = filename.split(".").pop().toLowerCase();
        if (blockedExtensions.has(extension)) {
          throw new HttpError(400, "file type is not allowed", "blocked_file_type");
        }
        const contentType = String(request.headers["content-type"] || "application/octet-stream")
          .split(";")[0]
          .trim();
        const data = await readBinary(request);
        const object = objects.store(data, contentType);
        const assetId = crypto.randomUUID();
        db.prepare(
          "INSERT INTO project_assets (id, project_id, object_id, name, content_type, bytes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(assetId, projectId, object.id, filename, contentType, data.length, auth.account.id, now());
        writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "asset.uploaded",
          resourceType: "project_asset",
          resourceId: assetId,
          metadata: { projectId, bytes: data.length, contentType },
          ip,
          secret: config.secret,
        });
        sendJson(
          response,
          201,
          { id: assetId, name: filename, contentType, bytes: data.length },
          config
        );
        return true;
      }

      const assetItemMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/assets\/([^/]+)$/);
      if (method === "GET" && assetItemMatch) {
        const auth = requireAuth(request, response, db, config);
        requireScope(auth, "projects:read");
        const role = projectRole(db, assetItemMatch[1], auth.account.id);
        if (!role) throw new HttpError(404, "project not found", "not_found");
        const asset = db
          .prepare("SELECT * FROM project_assets WHERE id = ? AND project_id = ?")
          .get(assetItemMatch[2], assetItemMatch[1]);
        if (!asset) throw new HttpError(404, "asset not found", "not_found");
        const object = objects.get(asset.object_id);
        if (!object) throw new HttpError(404, "asset not found", "not_found");
        sendBinary(response, config, object.body, {
          contentType: asset.content_type,
          filename: asset.name,
          download: false,
        });
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
          db.prepare(
            "INSERT INTO project_versions (id, project_id, revision, doc, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)"
          ).run(crypto.randomUUID(), snapshotMatch[1], revision, doc, auth.account.id, now());
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        events.publish(snapshotMatch[1], {
          type: "snapshot",
          projectId: snapshotMatch[1],
          revision,
          actor: auth.account.id,
        });
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
  route.closeAll = events.closeAll;
  return route;
}
