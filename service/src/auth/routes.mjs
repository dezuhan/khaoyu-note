import crypto from "node:crypto";
import { hashIp, writeAudit } from "../audit.mjs";
import { hashPassword, verifyPassword } from "./passwords.mjs";
import { AuthError, authenticateAccess, authenticateApiToken, createApiToken, createSession, listApiTokens, listSessions, publicAccount, revokeAllSessions, revokeApiToken, revokeByRefreshToken, revokeSession, rotateRefresh } from "./sessions.mjs";
import { bearerToken, hashToken, parseCookies, randomToken, serializeCookie } from "./tokens.mjs";
import { createTotpSecret, generateTotp, totpUri, verifyTotp } from "./totp.mjs";
import { clearLoginFailures, createRateLimiter, loginBlocked, recordLoginAttempt } from "./throttle.mjs";
import {
  authenticationOptions,
  deletePasskey,
  listPasskeys,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from "./passkeys.mjs";
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
import { OpError, applyOperation, validateOperations } from "../collab-ops.mjs";
import { createMemoryCoordination } from "../realtime/coordination.mjs";
import { scanUpload, validateUpload } from "../uploads.mjs";
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

// A board snapshot carries the whole board document, so it needs much more room than the default
// JSON body limit used by the small auth and account endpoints.
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

// Fixed argon2id hash (same parameters as passwords.mjs) used to make the unknown-email
// login path cost roughly the same as a real password check.
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=1$WLLmuzqbgiFAcmVucbER5Q$dpKYXtQhuHSXN5SvyBevE5/gWs7eEcl2Ogu12D9fbGE";

// Content fields a card can use to reference an uploaded project asset.
const ASSET_REFERENCE_FIELDS = [
  "src",
  "path",
  "url",
  "poster",
  "assetId",
  "asset_id",
  "objectId",
  "object_id",
];

function cardReferencesAsset(card, asset) {
  if (!card) return false;
  return ASSET_REFERENCE_FIELDS.some((field) => {
    const value = card[field];
    if (typeof value !== "string" || !value) return false;
    return value.includes(asset.id) || value.includes(asset.object_id);
  });
}

function integerDays(value) {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new HttpError(400, "expiresInDays must be between 1 and 365", "invalid_expiry");
  }
  return days;
}

async function accountById(db, id) {
  return (await db.get("SELECT * FROM accounts WHERE id = ?", [id]));
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

async function issueEmailToken(db, config, accountId, kind, ttlMs) {
  const token = randomToken(32);
  (await db.run("INSERT INTO email_tokens (id, account_id, kind, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)", [crypto.randomUUID(), accountId, kind, hashToken(token), now() + ttlMs, now()]));
  return token;
}

async function consumeEmailToken(db, token, kind) {
  const row = (await db.get("SELECT * FROM email_tokens WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?", [hashToken(token), kind, now()]));
  if (!row) throw new HttpError(400, "token is invalid or expired", "invalid_token");
  const changed = (await db.run("UPDATE email_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL", [now(), row.id]));
  if (!changed.changes) throw new HttpError(400, "token is invalid or expired", "invalid_token");
  return row;
}

async function requireAuth(request, response, db, config) {
  const cookies = parseCookies(request.headers.cookie);
  const bearer = bearerToken(request);
  const token = bearer || cookies.khaoyu_access;
  const auth =
    (await authenticateAccess(db, token)) ||
    (bearer ? await authenticateApiToken(db, bearer) : null);
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

async function requireSessionAuth(request, response, db, config) {
  const auth = await requireAuth(request, response, db, config);
  if (auth.method === "api") {
    throw new HttpError(403, "this endpoint requires a user session", "session_required");
  }
  return auth;
}

async function requireAdminAccount(request, response, db, config) {
  const auth = await requireSessionAuth(request, response, db, config);
  if (auth.account.role !== "admin" || auth.account.status !== "active") {
    throw new HttpError(403, "admin access required", "admin_required");
  }
  return auth;
}

const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function createRecoveryCode() {
  let raw = "";
  for (let index = 0; index < 10; index += 1) {
    raw += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
  }
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

function normalizeRecoveryCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function adminAccount(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    username: row.username || "",
    firstName: row.first_name || "",
    lastName: row.last_name || "",
    avatarColor: row.avatar_color || "",
    avatarUrl: row.avatar_url || "",
    role: row.role || "member",
    status: row.status || "active",
    approved: row.approved_at !== null && row.approved_at !== undefined,
    approvedAt: row.approved_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at ?? null,
    projectCount: Number(row.project_count ?? 0),
  };
}

const ADMIN_ACCOUNT_COLUMNS =
  "a.id, a.email, a.display_name, a.username, a.first_name, a.last_name, a.avatar_color, a.avatar_url, a.role, a.status, a.approved_at, a.created_at, a.updated_at";
const REGISTRATION_MODE_KEY = "registration_mode";

async function registrationMode(db) {
  const row = await db.get("SELECT value FROM service_meta WHERE key = ?", [REGISTRATION_MODE_KEY]);
  return row?.value === "public" ? "public" : "private";
}

async function workspaceShared(db) {
  const row = await db.get("SELECT value FROM service_meta WHERE key = 'workspace_mode'", []);
  return row?.value !== "private";
}

async function addWorkspaceViewersForProject(db, projectId) {
  if (!(await workspaceShared(db))) return;
  await db.run(
    `INSERT INTO project_members (project_id, account_id, role, created_at)
     SELECT ?, a.id, 'viewer', ? FROM accounts a
     WHERE a.deleted_at IS NULL AND a.status = 'active' AND a.approved_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = ? AND m.account_id = a.id)`,
    [projectId, now(), projectId]
  );
}

async function addWorkspaceViewersForAccount(db, accountId) {
  if (!(await workspaceShared(db))) return;
  await db.run(
    `INSERT INTO project_members (project_id, account_id, role, created_at)
     SELECT p.id, ?, 'viewer', ? FROM projects p
     WHERE p.deleted_at IS NULL AND p.owner_account_id <> ?
       AND NOT EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.account_id = ?)`,
    [accountId, now(), accountId, accountId]
  );
}

function accountApproved(account) {
  return account?.approved_at !== null && account?.approved_at !== undefined;
}

function requireApproved(account) {
  if (!accountApproved(account)) {
    throw new HttpError(403, "account is waiting for administrator approval", "account_pending");
  }
}

async function startSession(db, config, account, options) {
  requireApproved(account);
  return createSession(db, config, account, options);
}

function validateAdminAvatar(value) {
  if (value === null || value === undefined || value === "") return "";
  const text = String(value);
  if (text.length > 1_500_000) throw new HttpError(400, "avatar is too large", "invalid_avatar");
  const prefix = text.slice(0, 64).toLowerCase();
  const accepted = [
    "data:image/png;base64,",
    "data:image/jpeg;base64,",
    "data:image/jpg;base64,",
    "data:image/gif;base64,",
    "data:image/webp;base64,",
  ].some((candidate) => prefix.startsWith(candidate));
  if (!accepted) throw new HttpError(400, "avatar must be a PNG, JPEG, GIF or WebP data URL", "invalid_avatar");
  return text;
}

function requireScope(auth, scope) {
  if (auth.method === "api" && !auth.scopes?.includes(scope)) {
    throw new HttpError(403, `scope ${scope} required`, "insufficient_scope");
  }
}

async function projectRole(db, projectId, accountId) {
  return (await db.get("SELECT role FROM project_members WHERE project_id = ? AND account_id = ?", [projectId, accountId]))?.role;
}

async function sendReset(db, config, mailer, account, token) {
  await mailer.send({
    to: account.email,
    kind: "reset",
    subject: "Reset your Khaoyu Note password",
    text: `Reset token: ${token}`,
  });
  await writeAudit(db, {
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

async function issueOtp(db, account, secret) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  (await db.run("INSERT INTO email_otps (id, account_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)", [crypto.randomUUID(), account.id, otpHash(account.id, code, secret), now(), now() + 10 * 60_000]));
  return code;
}

async function verifyShareForWrite(db, config, { token, body, ip, minimum }) {
  if (!config.publicSharingEnabled) throw new HttpError(404, "not found", "not_found");
  const share = await findShare(db, token);
  if (!share || share.revoked_at || (share.expires_at !== null && Number(share.expires_at) <= now())) {
    throw new HttpError(404, "not found", "not_found");
  }
  if (!shareAllows(share.permission, minimum)) {
    throw new HttpError(403, "share permission denied", "forbidden");
  }
  if (await shareBlocked(db, { shareId: share.id, ip, config })) {
    throw new HttpError(429, "too many attempts", "rate_limited", { "Retry-After": "300" });
  }
  if (share.password_hash && !(await verifyPassword(body.password, share.password_hash))) {
    await recordShareAttempt(db, { shareId: share.id, ip, success: false, config });
    throw new HttpError(404, "not found", "not_found");
  }
  await recordShareAttempt(db, { shareId: share.id, ip, success: true, config });
  (await db.run("UPDATE share_links SET last_accessed_at = ? WHERE id = ?", [now(), share.id]));
  return share;
}

export function createApiRouter({ db, config, logger, mailer, events: providedEvents, coordination: providedCoordination }) {
  const objects = new ObjectStore(db, config.objectsDir, config.objectEncryptionKey);
  const events = providedEvents || createEventHub();
  const collab = providedCoordination || createMemoryCoordination({
    ticket: config.realtimeTicketTtlMs,
    lock: config.editLockTtlMs,
  });
  const adminRate = new Map();
  const blockedExtensions = new Set([
    "exe", "msi", "bat", "cmd", "ps1", "scr", "com", "dll", "jar", "vbs", "js", "lnk",
  ]);
  const rateWindowMs = 15 * 60_000;
  const registerRate = createRateLimiter({ windowMs: rateWindowMs, max: 60 });
  const passwordResetRate = createRateLimiter({ windowMs: rateWindowMs, max: 5 });
  const otpRequestRate = createRateLimiter({ windowMs: rateWindowMs, max: 5 });
  const passkeyLoginRate = createRateLimiter({ windowMs: rateWindowMs, max: 20 });
  const recoveryLoginRate = createRateLimiter({ windowMs: rateWindowMs, max: 10 });
  const accountSecurityRate = createRateLimiter({ windowMs: rateWindowMs, max: 10 });
  const accountPasswordRate = createRateLimiter({ windowMs: rateWindowMs, max: 5 });
  const passwordResetConfirmRate = createRateLimiter({ windowMs: rateWindowMs, max: 10 });
  const accountExportRate = createRateLimiter({ windowMs: 60 * 60_000, max: 10 });
  const accountDestructiveRate = createRateLimiter({ windowMs: 60 * 60_000, max: 5 });
  const accountKey = (auth, ipHash) => `${auth.account.id}:${ipHash}`;
  const shareReportRate = createRateLimiter({ windowMs: rateWindowMs, max: 5 });
  const invitationRate = createRateLimiter({ windowMs: rateWindowMs, max: 20 });

  function enforceRate(limiter, key) {
    const result = limiter.check(key);
    if (result.blocked) {
      throw new HttpError(429, "too many requests", "rate_limited", {
        "Retry-After": String(result.retryAfter),
      });
    }
  }

  async function broadcastPresence(projectId) {
    const users = await collab.presenceState(projectId);
    events.publish(projectId, {
      type: "presence",
      projectId,
      accounts: new Set(users.map((entry) => entry.accountId)).size,
      connections: users.length,
      users,
      global: true,
    });
  }

  async function emailRecipients(accountIds, payload) {
    await Promise.all(
      accountIds.map((accountId) =>
        emailNotification(db, config, mailer, logger, accountId, payload)
      )
    );
  }

  function pruneAdminRate() {
    const current = Date.now();
    for (const [key, hits] of adminRate) {
      if (current >= hits.resetAt) adminRate.delete(key);
    }
  }

  function requireAdmin(request, ipHash) {
    if (!config.adminToken) throw new HttpError(404, "not found", "not_found");
    pruneAdminRate();
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

  async function bumpRevision(projectId, expectedRevision, client = db) {
    const result = await client.run(
      "UPDATE projects SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
      [now(), projectId, expectedRevision]
    );
    if (result.changes !== 1) {
      throw new HttpError(409, "revision conflict", "revision_conflict");
    }
    return expectedRevision + 1;
  }

  async function writeDocRevision(projectId, doc, expectedRevision, actorId) {
    const serialized = typeof doc === "string" ? doc : JSON.stringify(doc);
    return db.transaction(async (tx) => {
      const revision = await bumpRevision(projectId, expectedRevision, tx);
      await tx.run(
        "UPDATE project_snapshots SET revision = ?, doc = ?, updated_by = ?, updated_at = ? WHERE project_id = ?",
        [revision, serialized, actorId, now(), projectId]
      );
      await tx.run(
        "INSERT INTO project_versions (id, project_id, revision, doc, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [crypto.randomUUID(), projectId, revision, serialized, actorId, now()]
      );
      return revision;
    });
  }

  async function saveSharedDoc(projectId, doc, expectedRevision, actorId) {
    return writeDocRevision(projectId, doc, expectedRevision, actorId);
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
        const entries = (await db.all(`SELECT id, actor_account_id, action, resource_type, resource_id, ip_hash, metadata, created_at
             FROM audit_log ORDER BY created_at DESC LIMIT ?`, [limit]))
          .map((entry) => ({
            ...entry,
            metadata: entry.metadata ? JSON.parse(entry.metadata) : null,
          }));
        await writeAudit(db, {
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
        const reports = (await db.all(`SELECT r.id, r.share_id, r.reason, r.reporter_ip_hash, r.created_at, r.status,
                    s.project_id, s.scope, s.target_id
             FROM abuse_reports r JOIN share_links s ON s.id = r.share_id
             ORDER BY r.created_at DESC LIMIT 200`, []));
        sendJson(response, 200, { reports }, config);
        return true;
      }

      if (method === "GET" && url.pathname === "/api/v1/admin/stats") {
        requireAdmin(request, ipHash);
        const count = async (table) =>
          Number((await db.get(`SELECT COUNT(*) AS count FROM ${table}`, [])).count);
        sendJson(
          response,
          200,
          {
            accounts: await count("accounts"),
            projects: await count("projects"),
            shareLinks: await count("share_links"),
            abuseReports: await count("abuse_reports"),
            notifications: await count("notifications"),
            auditEntries: await count("audit_log"),
          },
          config
        );
        return true;
      }

      if (method === "GET" && url.pathname === "/api/v1/admin/dashboard") {
        const auth = await requireAdminAccount(request, response, db, config);
        const count = async (sql, ...args) => Number((await db.get(sql, [...args]))?.count || 0);
        const recentActivity = (await db.all(`SELECT l.id, l.action, l.resource_type, l.resource_id, l.created_at,
                    a.email, a.display_name, a.avatar_color, a.avatar_url
             FROM audit_log l LEFT JOIN accounts a ON a.id = l.actor_account_id
             ORDER BY l.created_at DESC LIMIT 8`, []));
        const recentAccounts = (await db.all(`SELECT id, email, display_name, username, avatar_color, avatar_url, role, status,
                    created_at, updated_at FROM accounts
             WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 5`, []));
        sendJson(
          response,
          200,
          {
            admin: {
              id: auth.account.id,
              email: auth.account.email,
              displayName: auth.account.display_name,
              avatarUrl: auth.account.avatar_url || "",
            },
            counts: {
              accounts: await count("SELECT COUNT(*) AS count FROM accounts WHERE deleted_at IS NULL"),
              activeAccounts: await count(
                "SELECT COUNT(*) AS count FROM accounts WHERE deleted_at IS NULL AND status = 'active'"
              ),
              pendingAccounts: await count(
                "SELECT COUNT(*) AS count FROM accounts WHERE deleted_at IS NULL AND approved_at IS NULL"
              ),
              boards: await count("SELECT COUNT(*) AS count FROM projects WHERE deleted_at IS NULL"),
              teams: await count("SELECT COUNT(*) AS count FROM projects WHERE deleted_at IS NULL"),
              auditEntries: await count("SELECT COUNT(*) AS count FROM audit_log"),
              shareLinks: await count("SELECT COUNT(*) AS count FROM share_links WHERE revoked_at IS NULL"),
            },
            recentActivity: recentActivity.map((entry) => ({
              id: entry.id,
              action: entry.action,
              resourceType: entry.resource_type,
              resourceId: entry.resource_id,
              createdAt: entry.created_at,
              actorEmail: entry.email || "",
              actorName: entry.display_name || "",
              avatarColor: entry.avatar_color || "",
              avatarUrl: entry.avatar_url || "",
            })),
            recentAccounts: recentAccounts.map((row) => ({
              id: row.id,
              email: row.email,
              displayName: row.display_name,
              username: row.username || "",
              avatarColor: row.avatar_color || "",
              avatarUrl: row.avatar_url || "",
              role: row.role,
              status: row.status,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            })),
          },
          config
        );
        return true;
      }

      if (method === "GET" && url.pathname === "/api/v1/admin/settings") {
        await requireAdminAccount(request, response, db, config);
        sendJson(response, 200, { registrationMode: await registrationMode(db) }, config);
        return true;
      }

      if (method === "PATCH" && url.pathname === "/api/v1/admin/settings") {
        const auth = await requireAdminAccount(request, response, db, config);
        const body = await readJson(request);
        const mode = String(body.registrationMode || "");
        if (!["private", "public"].includes(mode)) {
          throw new HttpError(400, "registrationMode must be private or public", "invalid_registration_mode");
        }
        await db.run(
          "INSERT INTO service_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          [REGISTRATION_MODE_KEY, mode]
        );
        await writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "admin.registration_mode_changed",
          resourceType: "service",
          resourceId: null,
          metadata: { mode },
          ip,
          secret: config.secret,
        });
        sendJson(response, 200, { registrationMode: mode }, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/admin/users") {
        const auth = await requireAdminAccount(request, response, db, config);
        const body = await readJson(request);
        const email = normalizeEmail(body.email);
        const password = requirePassword(body.password);
        const displayName =
          typeof body.displayName === "string" && body.displayName.trim()
            ? requireString(body.displayName, "displayName", 120)
            : email.split("@")[0];
        const role = body.role === undefined ? "member" : String(body.role);
        if (!["admin", "member"].includes(role)) {
          throw new HttpError(400, "role is invalid", "invalid_role");
        }
        const id = crypto.randomUUID();
        try {
          await db.run(
            `INSERT INTO accounts (id, email, display_name, password_hash, email_verified_at, role, approved_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, email, displayName, await hashPassword(password), now(), role, now(), now(), now()]
          );
        } catch (error) {
          if (/UNIQUE|duplicate key/i.test(String(error.message || ""))) {
            throw new HttpError(409, "email is already registered", "email_taken");
          }
          throw error;
        }
        await addWorkspaceViewersForAccount(db, id);
        await writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "admin.user_created",
          resourceType: "account",
          resourceId: id,
          metadata: { email, role },
          ip,
          secret: config.secret,
        });
        const created = (await db.get(`SELECT ${ADMIN_ACCOUNT_COLUMNS},
                    (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.account_id = a.id AND s.revoked_at IS NULL) AS last_seen_at,
                    (SELECT COUNT(*) FROM project_members m WHERE m.account_id = a.id) AS project_count
             FROM accounts a WHERE a.id = ?`, [id]));
        sendJson(response, 201, { user: adminAccount(created) }, config);
        return true;
      }

      if (method === "GET" && url.pathname === "/api/v1/admin/users") {
        await requireAdminAccount(request, response, db, config);
        const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50));
        const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
        const clauses = ["a.deleted_at IS NULL"];
        const params = [];
        if (q) {
          const like = `%${q}%`;
          clauses.push(
            "(lower(a.email) LIKE ? OR lower(a.display_name) LIKE ? OR lower(COALESCE(a.username, '')) LIKE ?)"
          );
          params.push(like, like, like);
        }
        const where = clauses.join(" AND ");
        const total = Number(
          (await db.get(`SELECT COUNT(*) AS count FROM accounts a WHERE ${where}`, [...params])).count
        );
        const users = (await db.all(`SELECT ${ADMIN_ACCOUNT_COLUMNS},
                    (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.account_id = a.id AND s.revoked_at IS NULL) AS last_seen_at,
                    (SELECT COUNT(*) FROM project_members m WHERE m.account_id = a.id) AS project_count
             FROM accounts a WHERE ${where}
             ORDER BY a.updated_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]))
          .map(adminAccount);
        sendJson(response, 200, { users, total, limit, offset }, config);
        return true;
      }

      const adminUserMatch = url.pathname.match(/^\/api\/v1\/admin\/users\/([^/]+)$/);
      if (method === "GET" && adminUserMatch) {
        await requireAdminAccount(request, response, db, config);
        const targetId = decodeURIComponent(adminUserMatch[1]);
        const user = (await db.get(`SELECT ${ADMIN_ACCOUNT_COLUMNS}, a.totp_enabled_at, a.email_verified_at,
                    (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.account_id = a.id AND s.revoked_at IS NULL) AS last_seen_at,
                    (SELECT COUNT(*) FROM project_members m WHERE m.account_id = a.id) AS project_count
             FROM accounts a WHERE a.id = ? AND a.deleted_at IS NULL`, [targetId]));
        if (!user) throw new HttpError(404, "account not found", "not_found");
        const sessions = await listSessions(db, targetId);
        const projects = await db.all(
          `SELECT p.id, p.name, p.revision, p.updated_at, m.role
           FROM project_members m JOIN projects p ON p.id = m.project_id
           WHERE m.account_id = ? AND p.deleted_at IS NULL
           ORDER BY p.updated_at DESC LIMIT 50`,
          [targetId]
        );
        const passkeys = Number(
          (await db.get("SELECT COUNT(*) AS count FROM passkey_credentials WHERE account_id = ?", [targetId])).count
        );
        sendJson(response, 200, {
          user: adminAccount(user),
          security: {
            totpEnabled: Boolean(user.totp_enabled_at),
            passkeyCount: passkeys,
            emailVerified: Boolean(user.email_verified_at),
          },
          sessions,
          projects: projects.map((project) => ({
            id: project.id,
            name: project.name,
            revision: project.revision,
            role: project.role,
            updatedAt: project.updated_at,
          })),
        }, config);
        return true;
      }

      if (method === "PATCH" && adminUserMatch) {
        const auth = await requireAdminAccount(request, response, db, config);
        const targetId = decodeURIComponent(adminUserMatch[1]);
        const current = (await db.get(`SELECT ${ADMIN_ACCOUNT_COLUMNS} FROM accounts a WHERE a.id = ? AND a.deleted_at IS NULL`, [targetId]));
        if (!current) throw new HttpError(404, "account not found", "not_found");
        const body = await readJson(request);
        const role = body.role === undefined ? current.role : String(body.role);
        const status = body.status === undefined ? current.status : String(body.status);
        const approved = body.approved === undefined ? accountApproved(current) : Boolean(body.approved);
        if (!["admin", "member"].includes(role)) {
          throw new HttpError(400, "role is invalid", "invalid_role");
        }
        if (!["active", "disabled"].includes(status)) {
          throw new HttpError(400, "status is invalid", "invalid_status");
        }
        if (targetId === auth.account.id && (role !== "admin" || status !== "active" || !approved)) {
          throw new HttpError(400, "you cannot demote, disable or unapprove your own account", "self_lockout");
        }
        if (
          (role !== "admin" || status !== "active") &&
          current.role === "admin" &&
          current.status === "active"
        ) {
          const adminCount = Number(
            (await db.get("SELECT COUNT(*) AS count FROM accounts WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL", [])).count
          );
          if (adminCount <= 1) {
            throw new HttpError(400, "at least one active admin is required", "last_admin");
          }
        }
        const displayName =
          body.displayName === undefined
            ? current.display_name
            : requireString(body.displayName, "displayName", 120);
        const firstName =
          body.firstName === undefined ? current.first_name : String(body.firstName).trim().slice(0, 80);
        const lastName =
          body.lastName === undefined ? current.last_name : String(body.lastName).trim().slice(0, 80);
        let avatarColor =
          body.avatarColor === undefined ? current.avatar_color : String(body.avatarColor || "").trim();
        if (avatarColor && !/^#[0-9a-f]{6}$/i.test(avatarColor)) {
          throw new HttpError(400, "avatarColor must be a hex color", "invalid_avatar");
        }
        const avatarUrl =
          body.avatarUrl === undefined ? current.avatar_url : validateAdminAvatar(body.avatarUrl);
        (await db.run(`UPDATE accounts SET display_name = ?, first_name = ?, last_name = ?, avatar_color = ?,
             avatar_url = ?, role = ?, status = ?, approved_at = ?, updated_at = ? WHERE id = ?`, [displayName,
          firstName || null,
          lastName || null,
          avatarColor || null,
          avatarUrl || null,
          role,
          status,
          approved ? (current.approved_at ?? now()) : null,
          now(),
          targetId]));
        if (status === "disabled" && current.status !== "disabled") {
          (await db.run("UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL", [now(),
            targetId]));
          (await db.run("UPDATE access_tokens SET revoked_at = ? WHERE session_id IN (SELECT id FROM sessions WHERE account_id = ?) AND revoked_at IS NULL", [now(), targetId]));
          (await db.run("UPDATE refresh_tokens SET revoked_at = ? WHERE session_id IN (SELECT id FROM sessions WHERE account_id = ?) AND revoked_at IS NULL", [now(), targetId]));
        }
        if (approved) await addWorkspaceViewersForAccount(db, targetId);
        await writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "admin.user_updated",
          resourceType: "account",
          resourceId: targetId,
          metadata: { role, status, approved },
          ip,
          secret: config.secret,
        });
        const updated = (await db.get(`SELECT ${ADMIN_ACCOUNT_COLUMNS},
                    (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.account_id = a.id AND s.revoked_at IS NULL) AS last_seen_at,
                    (SELECT COUNT(*) FROM project_members m WHERE m.account_id = a.id) AS project_count
             FROM accounts a WHERE a.id = ?`, [targetId]));
        sendJson(response, 200, { user: adminAccount(updated) }, config);
        return true;
      }

      if (method === "GET" && (url.pathname === "/api/v1/admin/teams" || url.pathname === "/api/v1/admin/boards")) {
        await requireAdminAccount(request, response, db, config);
        const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50));
        const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
        const clauses = ["p.deleted_at IS NULL"];
        const params = [];
        if (q) {
          const like = `%${q}%`;
          clauses.push("(lower(p.name) LIKE ? OR lower(a.email) LIKE ? OR lower(a.display_name) LIKE ?)");
          params.push(like, like, like);
        }
        const where = clauses.join(" AND ");
        const total = Number(
          (await db.get(`SELECT COUNT(*) AS count FROM projects p JOIN accounts a ON a.id = p.owner_account_id WHERE ${where}`, [...params])).count
        );
        const teams = (await db.all(`SELECT p.id, p.name, p.revision, p.sync_enabled, p.created_at, p.updated_at,
                    a.id AS owner_id, a.email AS owner_email, a.display_name AS owner_name,
                    a.avatar_color AS owner_avatar_color, a.avatar_url AS owner_avatar_url,
                    (SELECT COUNT(*) FROM project_members m WHERE m.project_id = p.id) AS member_count,
                    (SELECT COUNT(*) FROM project_snapshots s WHERE s.project_id = p.id) AS snapshot_count
             FROM projects p JOIN accounts a ON a.id = p.owner_account_id
             WHERE ${where} ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]));
        sendJson(response, 200, { boards: teams, teams, total, limit, offset }, config);
        return true;
      }

      if (method === "POST" && (url.pathname === "/api/v1/admin/teams" || url.pathname === "/api/v1/admin/boards")) {
        const auth = await requireAdminAccount(request, response, db, config);
        const body = await readJson(request);
        const name = requireString(body.name ?? body.title, "name", 120);
        const ownerId =
          body.ownerAccountId === undefined
            ? auth.account.id
            : requireString(body.ownerAccountId, "ownerAccountId", 200);
        const owner = (await db.get("SELECT id FROM accounts WHERE id = ? AND deleted_at IS NULL AND status = 'active'", [ownerId]));
        if (!owner) throw new HttpError(404, "owner account not found", "not_found");
        const projectId = crypto.randomUUID();
        await db.transaction(async (tx) => {
          await tx.run(
            "INSERT INTO projects (id, owner_account_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            [projectId, ownerId, name, now(), now()]
          );
          await tx.run(
            "INSERT INTO project_members (project_id, account_id, role, created_at) VALUES (?, ?, 'owner', ?)",
            [projectId, ownerId, now()]
          );
          await tx.run(
            "INSERT INTO project_snapshots (project_id, revision, doc, updated_by, updated_at) VALUES (?, 1, ?, ?, ?)",
            [
              projectId,
              JSON.stringify({ id: projectId, title: name, cards: [], connections: [], trash: [] }),
              auth.account.id,
              now(),
            ]
          );
        });
        await addWorkspaceViewersForProject(db, projectId);
        await writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "admin.team_created",
          resourceType: "project",
          resourceId: projectId,
          metadata: { name, ownerId },
          ip,
          secret: config.secret,
        });
        sendJson(response, 201, { id: projectId, name, ownerId, revision: 1 }, config);
        return true;
      }

      const adminTeamMatch = url.pathname.match(/^\/api\/v1\/admin\/(?:teams|boards)\/([^/]+)$/);
      if (method === "PATCH" && adminTeamMatch) {
        const auth = await requireAdminAccount(request, response, db, config);
        const projectId = decodeURIComponent(adminTeamMatch[1]);
        const project = (await db.get("SELECT id, name FROM projects WHERE id = ? AND deleted_at IS NULL", [projectId]));
        if (!project) throw new HttpError(404, "team not found", "not_found");
        const body = await readJson(request);
        const name = requireString(body.name, "name", 120);
        await db.run("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?", [name, now(), projectId]);
        await writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "admin.team_updated",
          resourceType: "project",
          resourceId: projectId,
          metadata: { name, previousName: project.name },
          ip,
          secret: config.secret,
        });
        sendJson(response, 200, { id: projectId, name }, config);
        return true;
      }

      if (method === "DELETE" && adminTeamMatch) {
        const auth = await requireAdminAccount(request, response, db, config);
        const projectId = decodeURIComponent(adminTeamMatch[1]);
        const project = (await db.get("SELECT id, name FROM projects WHERE id = ? AND deleted_at IS NULL", [projectId]));
        if (!project) throw new HttpError(404, "team not found", "not_found");
        const ids = [projectId];
        let frontier = [projectId];
        while (frontier.length) {
          const marks = frontier.map(() => "?").join(",");
          const children = await db.all(
            `SELECT id FROM projects WHERE parent_project_id IN (${marks}) AND deleted_at IS NULL`,
            frontier
          );
          const next = children.map((row) => row.id).filter((id) => !ids.includes(id));
          ids.push(...next);
          frontier = next;
        }
        const at = now();
        await db.transaction(async (tx) => {
          const marks = ids.map(() => "?").join(",");
          await tx.run(
            `UPDATE projects SET deleted_at = ?, updated_at = ?, public_sharing_enabled = 0 WHERE id IN (${marks})`,
            [at, at, ...ids]
          );
          await tx.run(
            `UPDATE share_links SET revoked_at = ? WHERE project_id IN (${marks}) AND revoked_at IS NULL`,
            [at, ...ids]
          );
          await tx.run(
            `UPDATE project_invitations SET revoked_at = ? WHERE project_id IN (${marks}) AND revoked_at IS NULL`,
            [at, ...ids]
          );
        });
        await writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "admin.team_deleted",
          resourceType: "project",
          resourceId: projectId,
          metadata: { name: project.name, cascaded: ids.length - 1 },
          ip,
          secret: config.secret,
        });
        sendJson(response, 200, { id: projectId, deleted: true, cascaded: ids.length - 1 }, config);
        return true;
      }

      const adminTeamMembersMatch = url.pathname.match(/^\/api\/v1\/admin\/(?:teams|boards)\/([^/]+)\/members$/);
      if (method === "POST" && adminTeamMembersMatch) {
        const auth = await requireAdminAccount(request, response, db, config);
        const projectId = decodeURIComponent(adminTeamMembersMatch[1]);
        const project = (await db.get("SELECT id, name FROM projects WHERE id = ? AND deleted_at IS NULL", [projectId]));
        if (!project) throw new HttpError(404, "team not found", "not_found");
        const body = await readJson(request);
        const role = String(body.role || "viewer").toLowerCase();
        if (!["editor", "commenter", "viewer"].includes(role)) {
          throw new HttpError(400, "role must be editor, commenter or viewer", "invalid_role");
        }
        const accountId = body.accountId ? requireString(body.accountId, "accountId", 200) : null;
        const email = body.email ? requireString(body.email, "email", 320).trim().toLowerCase() : null;
        if (!accountId && !email) throw new HttpError(400, "email is required", "email_required");
        const account = accountId
          ? await db.get("SELECT id, email, display_name, status FROM accounts WHERE id = ? AND deleted_at IS NULL", [accountId])
          : await db.get("SELECT id, email, display_name, status FROM accounts WHERE email = ? AND deleted_at IS NULL", [email]);
        if (!account) throw new HttpError(404, "account not found", "account_not_found");
        if (account.status !== "active") throw new HttpError(400, "account is not active", "account_inactive");
        const existing = await db.get("SELECT role FROM project_members WHERE project_id = ? AND account_id = ?", [projectId, account.id]);
        if (existing) {
          // A workspace-wide viewer row is upgraded when an admin explicitly grants a stronger role.
          if (existing.role !== "viewer" || role === "viewer") {
            throw new HttpError(409, "account is already a member", "already_member");
          }
          await db.run("UPDATE project_members SET role = ? WHERE project_id = ? AND account_id = ?", [role, projectId, account.id]);
        } else {
          await db.run("INSERT INTO project_members (project_id, account_id, role, created_at) VALUES (?, ?, ?, ?)", [projectId, account.id, role, now()]);
        }
        await writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "admin.team_member_added",
          resourceType: "project",
          resourceId: projectId,
          metadata: { accountId: account.id, email: account.email, role },
          ip,
          secret: config.secret,
        });
        sendJson(response, 201, { project: { id: project.id, name: project.name }, member: { id: account.id, email: account.email, displayName: account.display_name, role } }, config);
        return true;
      }
      if (method === "GET" && adminTeamMembersMatch) {
        await requireAdminAccount(request, response, db, config);
        const projectId = decodeURIComponent(adminTeamMembersMatch[1]);
        const project = (await db.get("SELECT id, name FROM projects WHERE id = ? AND deleted_at IS NULL", [projectId]));
        if (!project) throw new HttpError(404, "team not found", "not_found");
        const members = (await db.all(`SELECT a.id, a.email, a.display_name, a.username, a.avatar_color, a.avatar_url,
                    a.status, m.role, m.created_at
             FROM project_members m JOIN accounts a ON a.id = m.account_id
             WHERE m.project_id = ? AND a.deleted_at IS NULL
             ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 WHEN 'commenter' THEN 2 ELSE 3 END,
                      a.display_name`, [projectId]));
        sendJson(response, 200, { project, members }, config);
        return true;
      }


      const adminTeamMemberMatch = url.pathname.match(/^\/api\/v1\/admin\/(?:teams|boards)\/([^/]+)\/members\/([^/]+)$/);
      if ((method === "PATCH" || method === "DELETE") && adminTeamMemberMatch) {
        const auth = await requireAdminAccount(request, response, db, config);
        const projectId = decodeURIComponent(adminTeamMemberMatch[1]);
        const accountId = decodeURIComponent(adminTeamMemberMatch[2]);
        const project = (await db.get("SELECT id, name FROM projects WHERE id = ? AND deleted_at IS NULL", [projectId]));
        if (!project) throw new HttpError(404, "team not found", "not_found");
        const member = (await db.get("SELECT role FROM project_members WHERE project_id = ? AND account_id = ?", [projectId, accountId]));
        if (!member) throw new HttpError(404, "member not found", "not_found");
        if (member.role === "owner") throw new HttpError(400, "the team owner cannot be changed or removed", "owner_immutable");
        if (method === "PATCH") {
          const body = await readJson(request);
          const role = String(body.role || "").toLowerCase();
          if (!["editor", "commenter", "viewer"].includes(role)) {
            throw new HttpError(400, "role must be editor, commenter or viewer", "invalid_role");
          }
          await db.run("UPDATE project_members SET role = ? WHERE project_id = ? AND account_id = ?", [role, projectId, accountId]);
          await writeAudit(db, {
            actorAccountId: auth.account.id,
            action: "admin.team_member_updated",
            resourceType: "project",
            resourceId: projectId,
            metadata: { accountId, role },
            ip,
            secret: config.secret,
          });
          sendJson(response, 200, { projectId, accountId, role }, config);
          return true;
        }
        await db.run("DELETE FROM project_members WHERE project_id = ? AND account_id = ?", [projectId, accountId]);
        await writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "admin.team_member_removed",
          resourceType: "project",
          resourceId: projectId,
          metadata: { accountId },
          ip,
          secret: config.secret,
        });
        sendJson(response, 200, { projectId, accountId, removed: true }, config);
        return true;
      }

      if (method === "GET" && url.pathname === "/api/v1/admin/activity") {
        await requireAdminAccount(request, response, db, config);
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50));
        const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
        const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
        const action = String(url.searchParams.get("action") || "").trim().toLowerCase();
        const actor = String(url.searchParams.get("actor") || "").trim();
        const clauses = ["1 = 1"];
        const params = [];
        if (q) {
          const like = `%${q}%`;
          clauses.push(
            "(lower(l.action) LIKE ? OR lower(COALESCE(l.resource_id, '')) LIKE ? OR lower(COALESCE(a.email, '')) LIKE ? OR lower(COALESCE(a.display_name, '')) LIKE ?)"
          );
          params.push(like, like, like, like);
        }
        if (action) {
          clauses.push("lower(l.action) LIKE ?");
          params.push(`${action}%`);
        }
        if (actor) {
          clauses.push("l.actor_account_id = ?");
          params.push(actor);
        }
        const where = clauses.join(" AND ");
        const total = Number(
          (await db.get(`SELECT COUNT(*) AS count FROM audit_log l LEFT JOIN accounts a ON a.id = l.actor_account_id WHERE ${where}`, [...params])).count
        );
        const entries = (await db.all(`SELECT l.id, l.actor_account_id, l.action, l.resource_type, l.resource_id, l.ip_hash,
                    l.metadata, l.created_at,
                    a.email AS actor_email, a.display_name AS actor_name,
                    a.avatar_color AS actor_avatar_color, a.avatar_url AS actor_avatar_url
             FROM audit_log l LEFT JOIN accounts a ON a.id = l.actor_account_id
             WHERE ${where} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]))
          .map((entry) => ({
            ...entry,
            metadata: entry.metadata ? JSON.parse(entry.metadata) : null,
          }));
        sendJson(response, 200, { entries, total, limit, offset }, config);
        return true;
      }

      const publicReportMatch = url.pathname.match(/^\/api\/v1\/share\/([^/]+)\/report$/);
      if (method === "POST" && publicReportMatch) {
        if (!config.publicSharingEnabled) throw new HttpError(404, "not found", "not_found");
        const token = decodeURIComponent(publicReportMatch[1]);
        const share = await findShare(db, token);
        if (
          !share ||
          share.revoked_at ||
          (share.expires_at !== null && Number(share.expires_at) <= now())
        ) {
          throw new HttpError(404, "not found", "not_found");
        }
        enforceRate(shareReportRate, `${share.id}:${hashIp(ip, config.secret) || "unknown"}`);
        const body = await readJson(request);
        const reason = requireString(body.reason, "reason", 500);
        if (reason.length < 3) throw new HttpError(400, "reason is too short", "invalid_reason");
        (await db.run("INSERT INTO abuse_reports (id, share_id, reason, reporter_ip_hash, created_at) VALUES (?, ?, ?, ?, ?)", [crypto.randomUUID(), share.id, reason, hashIp(ip, config.secret), now()]));
        await writeAudit(db, {
          action: "share.reported",
          resourceType: "share_link",
          resourceId: share.id,
          ip,
          secret: config.secret,
        });
        await notifyProjectOwners(db, share.project_id, {
          kind: "share.reported",
          title: "A shared link was reported",
          body: reason,
          resourceType: "share_link",
          resourceId: share.id,
        });
        await emailRecipients(
          (await db.all("SELECT account_id FROM project_members WHERE project_id = ? AND role = 'owner'", [share.project_id]))
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
        const share = await findShare(db, token);
        if (
          !share ||
          share.revoked_at ||
          (share.expires_at !== null && Number(share.expires_at) <= now())
        ) {
          throw new HttpError(404, "not found", "not_found");
        }
        if (await shareBlocked(db, { shareId: share.id, ip, config })) {
          throw new HttpError(429, "too many attempts", "rate_limited", {
            "Retry-After": "300",
          });
        }
        const body = await readJson(request);
        if (share.password_hash) {
          const valid = await verifyPassword(body.password, share.password_hash);
          if (!valid) {
            await recordShareAttempt(db, { shareId: share.id, ip, success: false, config });
            throw new HttpError(404, "not found", "not_found");
          }
        }
        await recordShareAttempt(db, { shareId: share.id, ip, success: true, config });
        (await db.run("UPDATE share_links SET last_accessed_at = ? WHERE id = ?", [now(), share.id]));
        const payload = await sharedPayload(db, share);
        if (!payload) throw new HttpError(404, "not found", "not_found");
        await writeAudit(db, {
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
            watermark: Boolean(share.watermark),
            downloadLimit: share.download_limit,
            downloadCount: share.download_count,
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
        const snapshot = await projectSnapshot(db, share.project_id);
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
        const revision = await saveSharedDoc(
          share.project_id,
          snapshot.doc,
          snapshot.project.revision,
          null
        );
        events.publish(share.project_id, {
          type: "snapshot",
          projectId: share.project_id,
          revision,
        });
        await writeAudit(db, {
          action: "share.comment_added",
          resourceType: "share_link",
          resourceId: share.id,
          metadata: { cardId, revision },
          ip,
          secret: config.secret,
        });
        await notifyProjectOwners(db, share.project_id, {
          kind: "share.comment",
          title: "New comment on a shared link",
          body: "A shared link received a new comment.",
          resourceType: "share_link",
          resourceId: share.id,
        });
        const mentionEmails = [
          ...new Set(
            (text.match(/@([^\s@]+@[^\s@]+\.[^\s@]+)/g) || [])
              .map((mention) => mention.slice(1).toLowerCase())
              .slice(0, 10)
          ),
        ];
        if (mentionEmails.length) {
          const members = (await db.all("SELECT a.id, a.email FROM project_members m JOIN accounts a ON a.id = m.account_id WHERE m.project_id = ?", [share.project_id]));
          for (const email of mentionEmails) {
            const member = members.find((entry) => entry.email.toLowerCase() === email);
            if (!member) continue;
            await createNotification(db, {
              accountId: member.id,
              kind: "comment.mention",
              title: "You were mentioned in a shared comment",
              body: "A shared link mentioned you in a comment.",
              resourceType: "share_link",
              resourceId: share.id,
            });
            await emailNotification(db, config, mailer, logger, member.id, {
              kind: "comment.mention",
              title: "You were mentioned in a shared comment",
              body: "A shared link in one of your projects mentioned you in a comment.",
            });
          }
        }
        await emailRecipients(
          (await db.all("SELECT account_id FROM project_members WHERE project_id = ? AND role = 'owner'", [share.project_id]))
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
        const snapshot = await projectSnapshot(db, share.project_id);
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
        const revision = await saveSharedDoc(
          share.project_id,
          snapshot.doc,
          snapshot.project.revision,
          null
        );
        events.publish(share.project_id, {
          type: "snapshot",
          projectId: share.project_id,
          revision,
        });
        await writeAudit(db, {
          action: "share.card_edited",
          resourceType: "share_link",
          resourceId: share.id,
          metadata: { cardId, revision },
          ip,
          secret: config.secret,
        });
        await notifyProjectOwners(db, share.project_id, {
          kind: "share.edit",
          title: "A shared link edited a card",
          body: "A shared link edited a card in the project.",
          resourceType: "share_link",
          resourceId: share.id,
        });
        await emailRecipients(
          (await db.all("SELECT account_id FROM project_members WHERE project_id = ? AND role = 'owner'", [share.project_id]))
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
        const share = await findShare(db, decodeURIComponent(publicAssetMatch[1]));
        if (
          !share ||
          share.revoked_at ||
          (share.expires_at !== null && Number(share.expires_at) <= now())
        ) {
          throw new HttpError(404, "not found", "not_found");
        }
        if (!share.download_allowed) throw new HttpError(403, "download not allowed", "download_denied");
        if (await shareBlocked(db, { shareId: share.id, ip, config })) {
          throw new HttpError(429, "too many attempts", "rate_limited", { "Retry-After": "300" });
        }
        const body = await readJson(request);
        if (share.password_hash && !(await verifyPassword(body.password, share.password_hash))) {
          await recordShareAttempt(db, { shareId: share.id, ip, success: false, config });
          throw new HttpError(404, "not found", "not_found");
        }
        const assetId = decodeURIComponent(publicAssetMatch[2]);
        const asset = (await db.get("SELECT * FROM project_assets WHERE id = ? AND project_id = ?", [assetId, share.project_id]));
        if (!asset) throw new HttpError(404, "not found", "not_found");
        if (share.scope !== "project") {
          // Only cards inside the shared scope may expose the asset, and only through a
          // known reference field: an asset id merely mentioned in card text does not count.
          const snapshot = await projectSnapshot(db, share.project_id);
          if (!snapshot) throw new HttpError(404, "not found", "not_found");
          const scopedCards = (snapshot.doc.cards || []).filter((card) =>
            cardInShareScope(snapshot.doc, share, card.id)
          );
          if (!scopedCards.some((card) => cardReferencesAsset(card, asset))) {
            throw new HttpError(404, "not found", "not_found");
          }
        }
        const object = await objects.get(asset.object_id);
        if (!object) throw new HttpError(404, "not found", "not_found");
        if (share.download_limit !== null) {
          const claimed = await db.run(
            "UPDATE share_links SET download_count = download_count + 1 WHERE id = ? AND download_count < ?",
            [share.id, share.download_limit]
          );
          if (!claimed.changes) {
            throw new HttpError(403, "download limit reached", "download_limit_reached");
          }
        } else {
          await db.run("UPDATE share_links SET download_count = download_count + 1 WHERE id = ?", [share.id]);
        }
        await recordShareAttempt(db, { shareId: share.id, ip, success: true, config });
        (await db.run("UPDATE share_links SET last_accessed_at = ? WHERE id = ?", [now(), share.id]));
        await writeAudit(db, {
          action: "share.asset_downloaded",
          resourceType: "share_link",
          resourceId: share.id,
          metadata: { assetId, downloadLimit: share.download_limit },
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
        let account = (await db.get("SELECT * FROM accounts WHERE email = ?", [email]));
        if (!account) {
          if (!config.ssoAutoCreate) {
            throw new HttpError(403, "SSO account does not exist", "sso_account_missing");
          }
          const displayName = String(
            request.headers[config.ssoNameHeader] || email.split("@")[0]
          ).slice(0, 120);
          const id = crypto.randomUUID();
          const firstAccount = Number((await db.get("SELECT COUNT(*) AS count FROM accounts", [])).count) === 0;
          const mode = await registrationMode(db);
          const approvedAt = firstAccount || mode === "public" ? now() : null;
          (await db.run("INSERT INTO accounts (id, email, display_name, password_hash, email_verified_at, role, approved_at, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)", [id, email, displayName, now(), firstAccount ? "admin" : "member", approvedAt, now(), now()]));
          account = (await db.get("SELECT * FROM accounts WHERE id = ?", [id]));
          if (approvedAt !== null) await addWorkspaceViewersForAccount(db, account.id);
        }
        if (account.deleted_at) {
          throw new HttpError(403, "account is pending deletion", "account_deleted");
        }
        if (account.status === "disabled") {
          throw new HttpError(403, "account is disabled", "account_disabled");
        }
        const session = await startSession(db, config, account, {
          ipHash,
          userAgent: request.headers["user-agent"],
        });
        setSessionCookies(response, config, session);
        await writeAudit(db, {
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

      if (method === "POST" && url.pathname === "/api/v1/auth/passkeys/register/options") {
        if (!config.passkeysEnabled) throw new HttpError(404, "not found", "not_found");
        const auth = await requireSessionAuth(request, response, db, config);
        enforceRate(accountSecurityRate, accountKey(auth, ipHash));
        const options = await registrationOptions(db, config, auth.account);
        sendJson(response, 200, { options }, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/passkeys/register/verify") {
        if (!config.passkeysEnabled) throw new HttpError(404, "not found", "not_found");
        const auth = await requireSessionAuth(request, response, db, config);
        enforceRate(accountSecurityRate, accountKey(auth, ipHash));
        const body = await readJson(request);
        try {
          const id = await verifyRegistration(db, config, auth.account, body.response, body.name);
          await writeAudit(db, {
            actorAccountId: auth.account.id,
            action: "auth.passkey_added",
            resourceType: "passkey",
            resourceId: id,
            ip,
            secret: config.secret,
          });
          sendJson(response, 201, { id }, config);
        } catch (error) {
          throw new HttpError(400, error.message || "passkey registration failed", "passkey_failed");
        }
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/passkeys/login/options") {
        if (!config.passkeysEnabled) throw new HttpError(404, "not found", "not_found");
        enforceRate(passkeyLoginRate, ipHash);
        const body = await readJson(request);
        const email = normalizeEmail(body.email);
        const options = await authenticationOptions(db, config, email);
        sendJson(response, 200, { options }, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/passkeys/login/verify") {
        if (!config.passkeysEnabled) throw new HttpError(404, "not found", "not_found");
        enforceRate(passkeyLoginRate, ipHash);
        const body = await readJson(request);
        const email = normalizeEmail(body.email);
        try {
          const account = await verifyAuthentication(db, config, email, body.response);
          const session = await startSession(db, config, account, {
            ipHash,
            userAgent: request.headers["user-agent"],
          });
          setSessionCookies(response, config, session);
          await writeAudit(db, {
            actorAccountId: account.id,
            action: "auth.passkey_login",
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
        } catch (error) {
          await writeAudit(db, {
            action: "auth.passkey_failed",
            resourceType: "account",
            ip,
            secret: config.secret,
          });
          throw new HttpError(401, "passkey authentication failed", "invalid_credentials");
        }
        return true;
      }

      if (method === "GET" && url.pathname === "/api/v1/auth/passkeys") {
        if (!config.passkeysEnabled) throw new HttpError(404, "not found", "not_found");
        const auth = await requireSessionAuth(request, response, db, config);
        sendJson(response, 200, { passkeys: await listPasskeys(db, auth.account.id) }, config);
        return true;
      }

      const passkeyMatch = url.pathname.match(/^\/api\/v1\/auth\/passkeys\/([^/]+)$/);
      if (method === "DELETE" && passkeyMatch) {
        if (!config.passkeysEnabled) throw new HttpError(404, "not found", "not_found");
        const auth = await requireSessionAuth(request, response, db, config);
        let removed;
        try {
          removed = await deletePasskey(db, auth.account.id, decodeURIComponent(passkeyMatch[1]));
        } catch (error) {
          throw new HttpError(409, error.message, "passkey_last_credential");
        }
        if (!removed) throw new HttpError(404, "passkey not found", "not_found");
        await writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "auth.passkey_removed",
          resourceType: "passkey",
          resourceId: decodeURIComponent(passkeyMatch[1]),
          ip,
          secret: config.secret,
        });
        sendNoContent(response, 204, config);
        return true;
      }

      if (method === "GET" && url.pathname === "/api/v1/auth/features") {
        sendJson(response, 200, {
          passkeysEnabled: Boolean(config.passkeysEnabled),
          registrationMode: await registrationMode(db),
        }, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/register") {
        enforceRate(registerRate, ipHash);
        const body = await readJson(request);
        const email = normalizeEmail(body.email);
        const password = requirePassword(body.password);
        const displayName =
          typeof body.displayName === "string" && body.displayName.trim()
            ? requireString(body.displayName, "displayName", 80)
            : email.split("@")[0];
        let account;
        let approvedAt = null;
        try {
          account = {
            id: crypto.randomUUID(),
            email,
            display_name: displayName,
            email_verified_at: now(),
            deletion_requested_at: null,
            deleted_at: null,
          };
          const firstAccount = Number((await db.get("SELECT COUNT(*) AS count FROM accounts", [])).count) === 0;
          const mode = await registrationMode(db);
          approvedAt = firstAccount || mode === "public" ? now() : null;
          (await db.run("INSERT INTO accounts (id, email, display_name, password_hash, email_verified_at, role, approved_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [account.id,
            email,
            displayName,
            await hashPassword(password),
            now(),
            firstAccount ? "admin" : "member",
            approvedAt,
            now(),
            now()]));
        } catch (error) {
          if (!/UNIQUE/.test(error.message)) throw error;
          const duplicateMode = await registrationMode(db);
          sendJson(response, 202, {
            status: "registered",
            approval: duplicateMode === "public" ? "approved" : "pending",
          }, config);
          return true;
        }
        if (approvedAt !== null) await addWorkspaceViewersForAccount(db, account.id);
        sendJson(response, 202, {
          status: "registered",
          approval: approvedAt === null ? "pending" : "approved",
        }, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/verify-email") {
        throw new HttpError(410, "Email verification is disabled", "verification_disabled");
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/otp/request") {
        enforceRate(otpRequestRate, ipHash);
        const body = await readJson(request);
        const email = normalizeEmail(body.email);
        const account = (await db.get("SELECT * FROM accounts WHERE email = ? AND deleted_at IS NULL AND status = 'active'", [email]));
        if (account && account.email_verified_at) {
          const recent = (await db.get("SELECT created_at FROM email_otps WHERE account_id = ? ORDER BY created_at DESC LIMIT 1", [account.id]));
          if (!recent || now() - Number(recent.created_at) >= 60_000) {
            const code = await issueOtp(db, account, config.secret);
            await mailer.send({
              to: account.email,
              kind: "otp",
              subject: "Your Khaoyu Note login code",
              text: `One-time login code: ${code}`,
            });
            await writeAudit(db, {
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
        const throttle = await loginBlocked(db, { email, ip, config });
        if (throttle.blocked) {
          await recordLoginAttempt(db, { email, ip, success: false, secret: config.secret });
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
        const account = (await db.get("SELECT * FROM accounts WHERE email = ? AND deleted_at IS NULL AND status = 'active'", [email]));
        const otp = account
          ? (await db.get("SELECT * FROM email_otps WHERE account_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1", [account.id, now()]))
          : null;
        const valid =
          Boolean(otp) &&
          Number(otp.attempts) < 5 &&
          otp.code_hash === otpHash(account.id, code, config.secret);
        if (!valid) {
          if (account) {
            (await db.run("UPDATE email_otps SET attempts = attempts + 1 WHERE id = ?", [otp?.id || ""]));
          }
          await recordLoginAttempt(db, { email, ip, success: false, secret: config.secret });
          sendJson(response, 401, { error: "Invalid email or code" }, config);
          return true;
        }
        if (account.totp_enabled_at && !verifyTotp(account.totp_secret, body.totp)) {
          await recordLoginAttempt(db, { email, ip, success: false, secret: config.secret });
          sendJson(response, 401, { error: "Invalid email or code" }, config);
          return true;
        }
        (await db.run("UPDATE email_otps SET used_at = ? WHERE id = ?", [now(), otp.id]));
        await clearLoginFailures(db, { email, ip, secret: config.secret });
        const session = await startSession(db, config, account, {
          ipHash,
          userAgent: request.headers["user-agent"],
        });
        setSessionCookies(response, config, session);
        await writeAudit(db, {
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

      if (method === "POST" && url.pathname === "/api/v1/auth/recovery-codes") {
        const auth = await requireSessionAuth(request, response, db, config);
        enforceRate(accountSecurityRate, accountKey(auth, ipHash));
        const codes = Array.from({ length: 10 }, () => createRecoveryCode());
        await db.transaction(async (tx) => {
          await tx.run("DELETE FROM recovery_codes WHERE account_id = ?", [auth.account.id]);
          for (const code of codes) {
            await tx.run(
              "INSERT INTO recovery_codes (id, account_id, code_hash, created_at) VALUES (?, ?, ?, ?)",
              [crypto.randomUUID(), auth.account.id, hashToken(normalizeRecoveryCode(code)), now()]
            );
          }
        });
        await writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "auth.recovery_codes_created",
          resourceType: "account",
          resourceId: auth.account.id,
          metadata: { count: codes.length },
          ip,
          secret: config.secret,
        });
        sendJson(response, 201, { codes, remaining: codes.length }, config);
        return true;
      }

      if (method === "GET" && url.pathname === "/api/v1/auth/recovery-codes") {
        const auth = await requireSessionAuth(request, response, db, config);
        const row = (await db.get(
          `SELECT COUNT(*) AS remaining, MIN(created_at) AS created_at
           FROM recovery_codes WHERE account_id = ? AND used_at IS NULL`,
          [auth.account.id]
        ));
        sendJson(response, 200, {
          remaining: Number(row?.remaining || 0),
          createdAt: row?.created_at || null,
        }, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/recovery-login") {
        enforceRate(recoveryLoginRate, ipHash);
        const body = await readJson(request);
        const email = normalizeEmail(body.email);
        const code = normalizeRecoveryCode(body.code);
        if (code.length !== 10) {
          throw new HttpError(401, "Invalid email or backup code", "invalid_credentials");
        }
        const throttle = await loginBlocked(db, { email, ip, config });
        if (throttle.blocked) {
          await recordLoginAttempt(db, { email, ip, success: false, secret: config.secret });
          sendJson(response, 429, { error: "Too many attempts" }, config, {
            "Retry-After": String(throttle.retryAfter),
          });
          return true;
        }
        const account = (await db.get(
          "SELECT * FROM accounts WHERE email = ? AND deleted_at IS NULL AND status = 'active'",
          [email]
        ));
        const recovery = account
          ? (await db.get(
              `SELECT id FROM recovery_codes
               WHERE account_id = ? AND code_hash = ? AND used_at IS NULL`,
              [account.id, hashToken(code)]
            ))
          : null;
        if (!recovery) {
          await recordLoginAttempt(db, { email, ip, success: false, secret: config.secret });
          sendJson(response, 401, { error: "Invalid email or backup code", code: "invalid_credentials" }, config);
          return true;
        }
        (await db.run("UPDATE recovery_codes SET used_at = ? WHERE id = ?", [now(), recovery.id]));
        await clearLoginFailures(db, { email, ip, secret: config.secret });
        const session = await startSession(db, config, account, {
          ipHash,
          userAgent: request.headers["user-agent"],
        });
        setSessionCookies(response, config, session);
        await writeAudit(db, {
          actorAccountId: account.id,
          action: "auth.recovery_login",
          resourceType: "session",
          resourceId: session.sessionId,
          ip,
          secret: config.secret,
        });
        sendJson(response, 200, {
          account: publicAccount(account),
          csrfToken: session.csrfToken,
          accessExpiresAt: session.accessExpiresAt,
        }, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/login") {
        const body = await readJson(request);
        const email = normalizeEmail(body.email);
        const throttle = await loginBlocked(db, { email, ip, config });
        if (throttle.blocked) {
          await recordLoginAttempt(db, { email, ip, success: false, secret: config.secret });
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
        const account = (await db.get("SELECT * FROM accounts WHERE email = ?", [email]));
        // Hash against a fixed dummy hash when the account or hash is missing so the
        // unknown-email path costs about the same as a real verification.
        const valid = await verifyPassword(
          body.password,
          account?.password_hash || DUMMY_PASSWORD_HASH
        );
        if (!valid || !account || account.deleted_at || account.status === "disabled") {
          await recordLoginAttempt(db, { email, ip, success: false, secret: config.secret });
          sendJson(response, 401, { error: "Invalid email or password" }, config);
          return true;
        }
        if (account.totp_enabled_at && !verifyTotp(account.totp_secret, body.totp)) {
          await recordLoginAttempt(db, { email, ip, success: false, secret: config.secret });
          sendJson(response, 401, { error: "Invalid email or password" }, config);
          return true;
        }
        await clearLoginFailures(db, { email, ip, secret: config.secret });
        const session = await startSession(db, config, account, {
          ipHash,
          userAgent: request.headers["user-agent"],
        });
        setSessionCookies(response, config, session);
        await writeAudit(db, {
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

      // Email and password sign-in for the desktop sync client. The client never shows a token:
      // this endpoint verifies the password and returns a scoped project token instead.
      if (method === "POST" && url.pathname === "/api/v1/auth/sync-token") {
        const body = await readJson(request);
        const email = normalizeEmail(body.email);
        const password = typeof body.password === "string" ? body.password : "";
        if (!password || password.length > 200) {
          throw new HttpError(400, "password is required", "invalid_input");
        }
        const throttle = await loginBlocked(db, { email, ip, config });
        if (throttle.blocked) {
          await recordLoginAttempt(db, { email, ip, success: false, secret: config.secret });
          logger.warn("auth.login_blocked", {
            attempts: throttle.attempts,
            retryAfter: throttle.retryAfter,
          });
          void sendAlert(config, logger, {
            event: "auth.login_blocked",
            method: "sync-token",
            attempts: throttle.attempts,
            retryAfter: throttle.retryAfter,
            ipHash,
          });
          sendJson(response, 429, { error: "Too many attempts" }, config, {
            "Retry-After": String(throttle.retryAfter),
          });
          return true;
        }
        const account = (await db.get("SELECT * FROM accounts WHERE email = ?", [email]));
        const valid = await verifyPassword(
          password,
          account?.password_hash || DUMMY_PASSWORD_HASH
        );
        if (!valid || !account || account.deleted_at || account.status === "disabled") {
          await recordLoginAttempt(db, { email, ip, success: false, secret: config.secret });
          sendJson(response, 401, { error: "Invalid email or password" }, config);
          return true;
        }
        if (account.totp_enabled_at && !verifyTotp(account.totp_secret, body.totp)) {
          await recordLoginAttempt(db, { email, ip, success: false, secret: config.secret });
          sendJson(response, 401, { error: "Invalid email or password" }, config);
          return true;
        }
        requireApproved(account);
        await clearLoginFailures(db, { email });
        const scopes = ["projects:read", "projects:write"];
        const expiresAt = now() + 365 * 86_400_000;
        (await db.run("UPDATE api_tokens SET revoked_at = ? WHERE account_id = ? AND name = ? AND revoked_at IS NULL", [now(), account.id, "app-sync"]));
        const created = await createApiToken(db, account.id, { name: "app-sync", scopes, expiresAt });
        await writeAudit(db, {
          actorAccountId: account.id,
          action: "auth.sync_token_issued",
          resourceType: "account",
          resourceId: account.id,
          ip,
          secret: config.secret,
          metadata: { scopes },
        });
        sendJson(
          response,
          201,
          { token: created.token, email: account.email, scopes, expiresAt },
          config
        );
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/refresh") {
        const cookies = parseCookies(request.headers.cookie);
        const rotated = await rotateRefresh(db, config, cookies.khaoyu_refresh, {
          ipHash,
          userAgent: request.headers["user-agent"],
        });
        const sessionRow = (await db.get("SELECT account_id FROM sessions WHERE id = ?", [rotated.sessionId]));
        const account = await accountById(db, sessionRow.account_id);
        setSessionCookies(response, config, rotated);
        await writeAudit(db, {
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
        const auth = await authenticateAccess(db, cookies.khaoyu_access);
        // Logout is a state-changing cookie request, so it carries the same double-submit CSRF
        // requirement as other cookie writes. Requiring it also stops a cross-site form from
        // signing the user out silently.
        if (auth || cookies.khaoyu_refresh) {
          const header = request.headers["x-csrf-token"];
          const csrfCookie = cookies.khaoyu_csrf;
          if (!header || !csrfCookie || header !== csrfCookie) {
            throw new HttpError(403, "CSRF token missing or invalid", "csrf_failed");
          }
          if (auth && hashToken(header) !== auth.session.csrfHash) {
            throw new HttpError(403, "CSRF token missing or invalid", "csrf_failed");
          }
        }
        if (auth) await revokeSession(db, auth.session.id, auth.account.id);
        else await revokeByRefreshToken(db, cookies.khaoyu_refresh);
        clearSessionCookies(response, config);
        sendNoContent(response, 204, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/logout-all") {
        const auth = await requireSessionAuth(request, response, db, config);
        await revokeAllSessions(db, auth.account.id);
        clearSessionCookies(response, config);
        await writeAudit(db, {
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
        const auth = await requireSessionAuth(request, response, db, config);
        sendJson(
          response,
          200,
          {
            account: publicAccount(auth.account),
            sessions: await listSessions(db, auth.account.id, auth.session.id),
          },
          config
        );
        return true;
      }

      const sessionMatch = url.pathname.match(/^\/api\/v1\/auth\/sessions\/([^/]+)$/);
      if (method === "DELETE" && sessionMatch) {
        const auth = await requireSessionAuth(request, response, db, config);
        const revoked = await revokeSession(db, sessionMatch[1], auth.account.id);
        if (!revoked) throw new HttpError(404, "session not found", "not_found");
        await writeAudit(db, {
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

      if (method === "POST" && url.pathname === "/api/v1/auth/reset-password") {
        const body = await readJson(request);
        const email = normalizeEmail(body.email);
        const throttle = await loginBlocked(db, { email, ip, config });
        if (throttle.blocked) {
          await recordLoginAttempt(db, { email, ip, success: false, secret: config.secret });
          sendJson(response, 429, { error: "Too many attempts" }, config, {
            "Retry-After": String(throttle.retryAfter),
          });
          return true;
        }
        const account = (await db.get("SELECT * FROM accounts WHERE email = ? AND deleted_at IS NULL AND status = 'active'", [email]));
        const valid = await verifyPassword(
          String(body.currentPassword || ""),
          account?.password_hash || DUMMY_PASSWORD_HASH
        );
        if (!valid || !account) {
          await recordLoginAttempt(db, { email, ip, success: false, secret: config.secret });
          sendJson(response, 401, { error: "Invalid email or password" }, config);
          return true;
        }
        const password = requirePassword(body.newPassword);
        (await db.run("UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?", [await hashPassword(password),
          now(),
          account.id]));
        await revokeAllSessions(db, account.id);
        await clearLoginFailures(db, { email, ip, secret: config.secret });
        await writeAudit(db, {
          actorAccountId: account.id,
          action: "auth.password_reset",
          resourceType: "account",
          resourceId: account.id,
          ip,
          secret: config.secret,
        });
        sendNoContent(response, 204, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/password-reset/request") {
        enforceRate(passwordResetRate, ipHash);
        const body = await readJson(request);
        const email = normalizeEmail(body.email);
        const account = (await db.get("SELECT * FROM accounts WHERE email = ? AND deleted_at IS NULL", [email]));
        if (account) {
          const token = await issueEmailToken(db, config, account.id, "reset", 3600_000);
          await sendReset(db, config, mailer, account, token);
        }
        sendJson(response, 202, { status: "accepted" }, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/password-reset/confirm") {
        enforceRate(passwordResetConfirmRate, ipHash);
        const body = await readJson(request);
        const token = requireString(body.token, "token", 200);
        const password = requirePassword(body.password);
        const resource = await consumeEmailToken(db, token, "reset");
        (await db.run("UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?", [await hashPassword(password),
          now(),
          resource.account_id]));
        await revokeAllSessions(db, resource.account_id);
        await writeAudit(db, {
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

      if (method === "GET" && url.pathname === "/api/v1/auth/totp") {
        const auth = await requireSessionAuth(request, response, db, config);
        sendJson(response, 200, { enabled: Boolean(auth.account.totp_enabled_at) }, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/totp/setup") {
        const auth = await requireSessionAuth(request, response, db, config);
        enforceRate(accountSecurityRate, accountKey(auth, ipHash));
        if (auth.account.totp_enabled_at) throw new HttpError(409, "TOTP is already enabled", "totp_enabled");
        const secret = createTotpSecret();
        (await db.run("UPDATE accounts SET totp_secret = ?, updated_at = ? WHERE id = ?", [secret,
          now(),
          auth.account.id]));
        sendJson(
          response,
          200,
          { secret, uri: totpUri(secret, auth.account.email) },
          config
        );
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/auth/totp/enable") {
        const auth = await requireSessionAuth(request, response, db, config);
        enforceRate(accountSecurityRate, accountKey(auth, ipHash));
        const body = await readJson(request);
        if (!verifyTotp(auth.account.totp_secret, body.code)) {
          throw new HttpError(400, "invalid TOTP code", "invalid_totp");
        }
        (await db.run("UPDATE accounts SET totp_enabled_at = ?, updated_at = ? WHERE id = ?", [now(),
          now(),
          auth.account.id]));
        await writeAudit(db, {
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
        const auth = await requireSessionAuth(request, response, db, config);
        enforceRate(accountSecurityRate, accountKey(auth, ipHash));
        const body = await readJson(request);
        const account = await accountById(db, auth.account.id);
        if (!(await verifyPassword(body.password, account.password_hash))) {
          throw new HttpError(401, "invalid password", "invalid_credentials");
        }
        if (account.totp_enabled_at && !verifyTotp(account.totp_secret, body.code)) {
          throw new HttpError(400, "invalid TOTP code", "invalid_totp");
        }
        (await db.run("UPDATE accounts SET totp_secret = NULL, totp_enabled_at = NULL, updated_at = ? WHERE id = ?", [now(), auth.account.id]));
        await writeAudit(db, {
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

      if (method === "GET" && url.pathname === "/api/v1/account/profile") {
        const auth = await requireSessionAuth(request, response, db, config);
        const user = (await db.get(`SELECT ${ADMIN_ACCOUNT_COLUMNS},
                    (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.account_id = a.id AND s.revoked_at IS NULL) AS last_seen_at,
                    (SELECT COUNT(*) FROM project_members m WHERE m.account_id = a.id) AS project_count
             FROM accounts a WHERE a.id = ? AND a.deleted_at IS NULL`, [auth.account.id]));
        if (!user) throw new HttpError(404, "account not found", "not_found");
        sendJson(response, 200, { user: adminAccount(user) }, config);
        return true;
      }

      if (method === "PATCH" && url.pathname === "/api/v1/account/profile") {
        const auth = await requireSessionAuth(request, response, db, config);
        enforceRate(accountSecurityRate, accountKey(auth, ipHash));
        const current = (await db.get(`SELECT ${ADMIN_ACCOUNT_COLUMNS} FROM accounts a WHERE a.id = ? AND a.deleted_at IS NULL`, [auth.account.id]));
        if (!current) throw new HttpError(404, "account not found", "not_found");
        const body = await readJson(request);
        const displayName =
          body.displayName === undefined
            ? current.display_name
            : requireString(body.displayName, "displayName", 120);
        const firstName =
          body.firstName === undefined ? current.first_name : String(body.firstName).trim().slice(0, 80);
        const lastName =
          body.lastName === undefined ? current.last_name : String(body.lastName).trim().slice(0, 80);
        let avatarColor =
          body.avatarColor === undefined ? current.avatar_color : String(body.avatarColor || "").trim();
        if (avatarColor && !/^#[0-9a-f]{6}$/i.test(avatarColor)) {
          throw new HttpError(400, "avatarColor must be a hex color", "invalid_avatar");
        }
        const avatarUrl =
          body.avatarUrl === undefined ? current.avatar_url : validateAdminAvatar(body.avatarUrl);
        (await db.run(`UPDATE accounts SET display_name = ?, first_name = ?, last_name = ?, avatar_color = ?,
             avatar_url = ?, updated_at = ? WHERE id = ?`, [displayName,
          firstName || null,
          lastName || null,
          avatarColor || null,
          avatarUrl || null,
          now(),
          auth.account.id]));
        await writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "account.profile_updated",
          resourceType: "account",
          resourceId: auth.account.id,
          ip,
          secret: config.secret,
        });
        const updated = (await db.get(`SELECT ${ADMIN_ACCOUNT_COLUMNS},
                    (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.account_id = a.id AND s.revoked_at IS NULL) AS last_seen_at,
                    (SELECT COUNT(*) FROM project_members m WHERE m.account_id = a.id) AS project_count
             FROM accounts a WHERE a.id = ?`, [auth.account.id]));
        sendJson(response, 200, { user: adminAccount(updated) }, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/account/password") {
        const auth = await requireSessionAuth(request, response, db, config);
        enforceRate(accountPasswordRate, accountKey(auth, ipHash));
        const body = await readJson(request);
        const account = await accountById(db, auth.account.id);
        if (!(await verifyPassword(String(body.currentPassword || ""), account.password_hash))) {
          throw new HttpError(400, "Current password is not correct", "invalid_password");
        }
        const password = requirePassword(body.newPassword);
        (await db.run("UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?", [await hashPassword(password),
          now(),
          account.id]));
        const keepSession = auth.session.id;
        (await db.run("UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND id <> ? AND revoked_at IS NULL", [now(), account.id, keepSession]));
        (await db.run("UPDATE access_tokens SET revoked_at = ? WHERE session_id IN (SELECT id FROM sessions WHERE account_id = ? AND id <> ?) AND revoked_at IS NULL", [now(), account.id, keepSession]));
        (await db.run("UPDATE refresh_tokens SET revoked_at = ? WHERE session_id IN (SELECT id FROM sessions WHERE account_id = ? AND id <> ?) AND revoked_at IS NULL", [now(), account.id, keepSession]));
        await writeAudit(db, {
          actorAccountId: account.id,
          action: "auth.password_changed",
          resourceType: "account",
          resourceId: account.id,
          ip,
          secret: config.secret,
        });
        sendNoContent(response, 204, config);
        return true;
      }

      if (method === "GET" && url.pathname === "/api/v1/account/export") {
        const auth = await requireSessionAuth(request, response, db, config);
        enforceRate(accountExportRate, accountKey(auth, ipHash));
        const account = await accountById(db, auth.account.id);
        const projects = (await db.all(`SELECT p.*, m.role FROM projects p JOIN project_members m ON m.project_id = p.id
             WHERE m.account_id = ? AND p.deleted_at IS NULL`, [auth.account.id]));
        const exportedProjects = [];
        for (const project of projects) {
          const snapshot = await db.get(
            "SELECT revision, doc, updated_at FROM project_snapshots WHERE project_id = ?",
            [project.id]
          );
          let doc = null;
          if (snapshot) {
            try {
              doc = JSON.parse(snapshot.doc);
            } catch {
              doc = null;
            }
          }
          exportedProjects.push({
            id: project.id,
            name: project.name,
            role: project.role,
            revision: project.revision,
            snapshot: snapshot
              ? { revision: snapshot.revision, updatedAt: snapshot.updated_at, doc }
              : null,
          });
        }
        await writeAudit(db, {
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
        const auth = await requireSessionAuth(request, response, db, config);
        enforceRate(accountDestructiveRate, accountKey(auth, ipHash));
        const body = await readJson(request);
        const account = await accountById(db, auth.account.id);
        if (!(await verifyPassword(body.password, account.password_hash))) {
          throw new HttpError(401, "invalid password", "invalid_credentials");
        }
        const requestedAt = now();
        const dueAt = requestedAt + config.deletionGraceDays * 86_400_000;
        (await db.run("UPDATE accounts SET deletion_requested_at = ?, deletion_due_at = ?, updated_at = ? WHERE id = ?", [requestedAt, dueAt, requestedAt, auth.account.id]));
        await revokeAllSessions(db, auth.account.id, auth.session.id);
        await writeAudit(db, {
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
        const auth = await requireSessionAuth(request, response, db, config);
        enforceRate(accountDestructiveRate, accountKey(auth, ipHash));
        (await db.run("UPDATE accounts SET deletion_requested_at = NULL, deletion_due_at = NULL, updated_at = ? WHERE id = ?", [now(), auth.account.id]));
        await writeAudit(db, {
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
        const auth = await requireSessionAuth(request, response, db, config);
        sendJson(response, 200, { tokens: await listApiTokens(db, auth.account.id) }, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/account/tokens") {
        const auth = await requireSessionAuth(request, response, db, config);
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
        const created = await createApiToken(db, auth.account.id, {
          name,
          scopes,
          expiresAt: now() + days * 86_400_000,
        });
        await writeAudit(db, {
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
        const auth = await requireSessionAuth(request, response, db, config);
        if (!await revokeApiToken(db, auth.account.id, tokenMatch[1])) {
          throw new HttpError(404, "token not found", "not_found");
        }
        await writeAudit(db, {
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
        const auth = await requireAuth(request, response, db, config);
        requireScope(auth, method === "GET" ? "projects:read" : "projects:write");
        const projectId = shareCollectionMatch[1];
        const role = await projectRole(db, projectId, auth.account.id);
        if (!role) throw new HttpError(404, "project not found", "not_found");
        if (!hasRole(role, "editor")) throw new HttpError(403, "editor role required", "forbidden");
        if (method === "GET") {
          const links = (await db.all("SELECT id, scope, target_id, permission, download_allowed, watermark, download_limit, download_count, created_at, expires_at, revoked_at, last_accessed_at FROM share_links WHERE project_id = ? ORDER BY created_at DESC", [projectId]))
            .map((link) => ({
              id: link.id,
              scope: link.scope,
              targetId: link.target_id,
              permission: link.permission,
              downloadAllowed: Boolean(link.download_allowed),
              watermark: Boolean(link.watermark),
              downloadLimit: link.download_limit,
              downloadCount: link.download_count,
              createdAt: link.created_at,
              expiresAt: link.expires_at,
              revoked: Boolean(link.revoked_at),
              lastAccessedAt: link.last_accessed_at,
            }));
          sendJson(response, 200, { shares: links }, config);
          return true;
        }
        const body = await readJson(request);
        const snapshot = await projectSnapshot(db, projectId);
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
        const downloadAllowed = Boolean(body.downloadAllowed);
        const watermark = body.watermark === true || body.watermark === 1 || body.watermark === "1";
        let downloadLimit = null;
        if (body.downloadLimit !== undefined && body.downloadLimit !== null && body.downloadLimit !== "") {
          const parsed = Number(body.downloadLimit);
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10000) {
            throw new HttpError(400, "downloadLimit must be 1 to 10000", "invalid_download_limit");
          }
          if (!downloadAllowed) {
            throw new HttpError(400, "downloadLimit requires downloads to be enabled", "downloads_disabled");
          }
          downloadLimit = parsed;
        }
        const created = await createShareLink(db, {
          projectId,
          scope,
          targetId,
          permission,
          passwordHash,
          expiresAt,
          downloadAllowed,
          watermark,
          downloadLimit,
          createdBy: auth.account.id,
        });
        await writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "share.created",
          resourceType: "share_link",
          resourceId: created.id,
          metadata: { scope, permission, targetId, expiresAt },
          ip,
          secret: config.secret,
        });
        sendJson(response, 201, {
          id: created.id,
          token: created.token,
          url: `${config.sharePublicUrl || config.publicUrl}/s/${encodeURIComponent(created.token)}`,
          scope,
          permission,
          expiresAt,
          downloadAllowed,
          watermark,
          downloadLimit,
        }, config);
        return true;
      }

      const shareItemMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/shares\/([^/]+)$/);
      if (method === "DELETE" && shareItemMatch) {
        const auth = await requireAuth(request, response, db, config);
        requireScope(auth, "projects:write");
        const role = await projectRole(db, shareItemMatch[1], auth.account.id);
        if (!hasRole(role, "editor")) throw new HttpError(403, "editor role required", "forbidden");
        if (!(await revokeShare(db, shareItemMatch[1], shareItemMatch[2], auth.account.id, config))) {
          throw new HttpError(404, "share not found", "not_found");
        }
        await removeResourceNotifications(db, "share_link", shareItemMatch[2]);
        sendNoContent(response, 204, config);
        return true;
      }

      const shareRotateMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/shares\/([^/]+)\/rotate$/);
      if (method === "POST" && shareRotateMatch) {
        const auth = await requireAuth(request, response, db, config);
        requireScope(auth, "projects:write");
        const role = await projectRole(db, shareRotateMatch[1], auth.account.id);
        if (!hasRole(role, "editor")) throw new HttpError(403, "editor role required", "forbidden");
        const token = await rotateShare(db, shareRotateMatch[1], shareRotateMatch[2], auth.account.id);
        if (!token) throw new HttpError(404, "share not found", "not_found");
        await writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "share.rotated",
          resourceType: "share_link",
          resourceId: shareRotateMatch[2],
          ip,
          secret: config.secret,
        });
        sendJson(response, 200, {
          token,
          url: `${config.sharePublicUrl || config.publicUrl}/s/${encodeURIComponent(token)}`,
        }, config);
        return true;
      }

      const publicFlagMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/public-sharing$/);
      if (method === "POST" && publicFlagMatch) {
        const auth = await requireAuth(request, response, db, config);
        requireScope(auth, "projects:write");
        const role = await projectRole(db, publicFlagMatch[1], auth.account.id);
        if (role !== "owner") throw new HttpError(403, "owner role required", "forbidden");
        const body = await readJson(request);
        if (body.enabled === true && body.acknowledge !== true) {
          throw new HttpError(
            400,
            "public sharing requires explicit acknowledgement",
            "acknowledgement_required"
          );
        }
        (await db.run("UPDATE projects SET public_sharing_enabled = ?, updated_at = ? WHERE id = ?", [body.enabled ? 1 : 0,
          now(),
          publicFlagMatch[1]]));
        if (!body.enabled) {
          (await db.run("UPDATE share_links SET revoked_at = ? WHERE project_id = ? AND revoked_at IS NULL", [now(), publicFlagMatch[1]]));
          (await db.run("DELETE FROM notifications WHERE resource_type = 'share_link' AND resource_id IN (SELECT id FROM share_links WHERE project_id = ?)", [publicFlagMatch[1]]));
        }
        await writeAudit(db, {
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
        const auth = await requireSessionAuth(request, response, db, config);
        const projectId = invitationCollectionMatch[1];
        const role = await projectRole(db, projectId, auth.account.id);
        if (method === "GET" && !hasRole(role, "editor")) {
          throw new HttpError(403, "editor role required", "forbidden");
        }
        if (method === "POST" && role !== "owner") {
          throw new HttpError(403, "owner role required", "forbidden");
        }
        if (method === "POST") {
          enforceRate(invitationRate, `${auth.account.id}:${hashIp(ip, config.secret) || "unknown"}`);
        }
        if (method === "GET") {
          const invitations = (await db.all("SELECT id, email, role, created_at, expires_at, accepted_at, revoked_at FROM project_invitations WHERE project_id = ? ORDER BY created_at DESC", [projectId]))
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
        const existing = (await db.get("SELECT 1 FROM project_members m JOIN accounts a ON a.id = m.account_id WHERE m.project_id = ? AND a.email = ?", [projectId, email]));
        if (existing) throw new HttpError(409, "account is already a member", "already_member");
        const created = await createInvitation(db, {
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
        await writeAudit(db, {
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
        const auth = await requireSessionAuth(request, response, db, config);
        const role = await projectRole(db, invitationItemMatch[1], auth.account.id);
        if (role !== "owner") throw new HttpError(403, "owner role required", "forbidden");
        const result = (await db.run("UPDATE project_invitations SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL", [now(), invitationItemMatch[2], invitationItemMatch[1]]));
        if (!result.changes) throw new HttpError(404, "invitation not found", "not_found");
        sendNoContent(response, 204, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/invitations/accept") {
        const auth = await requireSessionAuth(request, response, db, config);
        const body = await readJson(request);
        const result = await acceptInvitation(db, {
          token: requireString(body.token, "token", 200),
          account: auth.account,
        });
        if (!result) throw new HttpError(404, "invitation not found", "not_found");
        await notifyProjectOwners(db, result.projectId, {
          except: auth.account.id,
          kind: "invitation.accepted",
          title: "Invitation accepted",
          body: `${auth.account.email} joined as ${result.role}.`,
        });
        await emailRecipients(
          (await db.all("SELECT account_id FROM project_members WHERE project_id = ? AND role = 'owner' AND account_id != ?", [result.projectId, auth.account.id]))
            .map((row) => row.account_id),
          {
            kind: "invitation.accepted",
            title: "Invitation accepted",
            body: `${auth.account.email} joined a project as ${result.role}.`,
          }
        );
        await writeAudit(db, {
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
        const auth = await requireSessionAuth(request, response, db, config);
        const role = await projectRole(db, membersMatch[1], auth.account.id);
        if (!role) throw new HttpError(404, "project not found", "not_found");
        const members = (await db.all(`SELECT a.id, a.email, a.display_name, m.role, m.created_at
             FROM project_members m JOIN accounts a ON a.id = m.account_id
             WHERE m.project_id = ? ORDER BY m.created_at`, [membersMatch[1]]));
        sendJson(response, 200, { members }, config);
        return true;
      }

      const memberMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/members\/([^/]+)$/);
      if (memberMatch && (method === "PATCH" || method === "DELETE")) {
        const auth = await requireSessionAuth(request, response, db, config);
        if ((await projectRole(db, memberMatch[1], auth.account.id)) !== "owner") {
          throw new HttpError(403, "owner role required", "forbidden");
        }
        const target = (await db.get("SELECT role FROM project_members WHERE project_id = ? AND account_id = ?", [memberMatch[1], memberMatch[2]]));
        if (!target) throw new HttpError(404, "member not found", "not_found");
        if (target.role === "owner") throw new HttpError(409, "cannot change the owner", "owner_protected");
        if (method === "PATCH") {
          const body = await readJson(request);
          if (!["editor", "commenter", "viewer"].includes(body.role)) {
            throw new HttpError(400, "invalid member role", "invalid_role");
          }
          (await db.run("UPDATE project_members SET role = ? WHERE project_id = ? AND account_id = ?", [body.role,
            memberMatch[1],
            memberMatch[2]]));
          await createNotification(db, {
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
          await writeAudit(db, {
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
        (await db.run("DELETE FROM project_members WHERE project_id = ? AND account_id = ?", [memberMatch[1],
          memberMatch[2]]));
        await writeAudit(db, {
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
        const auth = await requireSessionAuth(request, response, db, config);
        if ((await projectRole(db, transferMatch[1], auth.account.id)) !== "owner") {
          throw new HttpError(403, "owner role required", "forbidden");
        }
        const body = await readJson(request);
        const target = requireString(body.accountId, "accountId", 200);
        const targetRole = await projectRole(db, transferMatch[1], target);
        if (!targetRole) throw new HttpError(404, "member not found", "not_found");
        if (target === auth.account.id) throw new HttpError(409, "already the owner", "invalid_transfer");
        await db.transaction(async (tx) => {
          await tx.run(
            "UPDATE project_members SET role = 'editor' WHERE project_id = ? AND account_id = ?",
            [transferMatch[1], auth.account.id]
          );
          await tx.run(
            "UPDATE project_members SET role = 'owner' WHERE project_id = ? AND account_id = ?",
            [transferMatch[1], target]
          );
          await tx.run("UPDATE projects SET owner_account_id = ?, updated_at = ? WHERE id = ?", [
            target,
            now(),
            transferMatch[1],
          ]);
        });
        await writeAudit(db, {
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
        const auth = await requireAuth(request, response, db, config);
        requireScope(auth, "projects:read");
        const projects = (await db.all(`SELECT p.id, p.name, p.revision, p.created_at, p.updated_at, p.parent_project_id, m.role
             FROM projects p JOIN project_members m ON m.project_id = p.id
             WHERE m.account_id = ? AND p.deleted_at IS NULL ORDER BY p.updated_at DESC`, [auth.account.id]));
        sendJson(response, 200, { projects }, config);
        return true;
      }

      if (method === "POST" && url.pathname === "/api/v1/projects") {
        const auth = await requireAuth(request, response, db, config);
        requireScope(auth, "projects:write");
        const body = await readJson(request);
        const title = requireString(body.title, "title", 120);
        let parentProjectId = null;
        if (body.parentProjectId !== undefined && body.parentProjectId !== null) {
          parentProjectId = requireString(body.parentProjectId, "parentProjectId", 200);
          const parentRole = await projectRole(db, parentProjectId, auth.account.id);
          if (!parentRole || !hasRole(parentRole, "editor")) {
            throw new HttpError(404, "parent project not found", "not_found");
          }
        }
        const projectId = crypto.randomUUID();
        await db.transaction(async (tx) => {
          await tx.run(
            "INSERT INTO projects (id, owner_account_id, name, parent_project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            [projectId, auth.account.id, title, parentProjectId, now(), now()]
          );
          await tx.run(
            "INSERT INTO project_members (project_id, account_id, role, created_at) VALUES (?, ?, 'owner', ?)",
            [projectId, auth.account.id, now()]
          );
          await tx.run(
            "INSERT INTO project_snapshots (project_id, revision, doc, updated_by, updated_at) VALUES (?, 1, ?, ?, ?)",
            [
              projectId,
              JSON.stringify({ id: projectId, title, cards: [], connections: [], trash: [] }),
              auth.account.id,
              now(),
            ]
          );
        });
        await addWorkspaceViewersForProject(db, projectId);
        await writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "project.created",
          resourceType: "project",
          resourceId: projectId,
          ip,
          secret: config.secret,
        });
        sendJson(
          response,
          201,
          { id: projectId, title, revision: 1, role: "owner", parentProjectId },
          config
        );
        return true;
      }

      if (method === "GET" && url.pathname === "/api/v1/account/presence") {
        const auth = await requireSessionAuth(request, response, db, config);
        const preference = (await db.get("SELECT presence_enabled FROM email_preferences WHERE account_id = ?", [auth.account.id]));
        sendJson(
          response,
          200,
          { presence: preference ? Boolean(preference.presence_enabled) : true },
          config
        );
        return true;
      }

      if (method === "PATCH" && url.pathname === "/api/v1/account/presence") {
        const auth = await requireSessionAuth(request, response, db, config);
        const body = await readJson(request);
        if (typeof body.presence !== "boolean") {
          throw new HttpError(400, "presence must be a boolean", "invalid_input");
        }
        (await db.run(`INSERT INTO email_preferences (account_id, presence_enabled, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET presence_enabled = excluded.presence_enabled, updated_at = excluded.updated_at`, [auth.account.id, body.presence ? 1 : 0, now()]));
        sendJson(response, 200, { presence: body.presence }, config);
        return true;
      }

      if (method === "GET" && url.pathname === "/api/v1/account/email-preferences") {
        const auth = await requireSessionAuth(request, response, db, config);
        const preference = (await db.get("SELECT notifications FROM email_preferences WHERE account_id = ?", [auth.account.id]));
        sendJson(response, 200, { notifications: Boolean(preference?.notifications) }, config);
        return true;
      }

      if (method === "PATCH" && url.pathname === "/api/v1/account/email-preferences") {
        const auth = await requireSessionAuth(request, response, db, config);
        const body = await readJson(request);
        if (typeof body.notifications !== "boolean") {
          throw new HttpError(400, "notifications must be a boolean", "invalid_input");
        }
        (await db.run(`INSERT INTO email_preferences (account_id, notifications, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET notifications = excluded.notifications, updated_at = excluded.updated_at`, [auth.account.id, body.notifications ? 1 : 0, now()]));
        sendJson(response, 200, { notifications: body.notifications }, config);
        return true;
      }

      if (url.pathname === "/api/v1/email/unsubscribe" && (method === "GET" || method === "POST")) {
        let token = url.searchParams.get("token") || "";
        if (!token && /^application\/json\b/i.test(request.headers["content-type"] || "")) {
          const body = await readJson(request);
          token = String(body.token || "");
        }
        const accountId = verifyUnsubscribeToken(token, config.secret);
        if (!accountId) throw new HttpError(400, "invalid unsubscribe token", "invalid_token");
        if (method === "GET") {
          const action = `/api/v1/email/unsubscribe?token=${encodeURIComponent(token)}`;
          const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Unsubscribe from Khaoyu Note email</title></head>
<body><h1>Email notifications</h1>
<p>Confirm that you no longer want email notifications from Khaoyu Note. Nothing has changed yet.</p>
<form method="post" action="${action}"><button type="submit">Unsubscribe</button></form>
</body></html>`;
          applySecurityHeaders(response, config);
          // The default site CSP is `default-src 'none'`, which also blocks the form action.
          // This page needs nothing else, so allow only a same-origin form post.
          response.setHeader(
            "Content-Security-Policy",
            "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
          );
          response.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": Buffer.byteLength(page),
          });
          response.end(page);
          return true;
        }
        (await db.run(`INSERT INTO email_preferences (account_id, notifications, updated_at) VALUES (?, 0, ?)
           ON CONFLICT(account_id) DO UPDATE SET notifications = 0, updated_at = excluded.updated_at`, [accountId, now()]));
        await writeAudit(db, {
          action: "account.email_unsubscribed",
          resourceType: "account",
          resourceId: accountId,
          secret: config.secret,
        });
        sendJson(response, 200, { unsubscribed: true }, config);
        return true;
      }

      if (method === "GET" && url.pathname === "/api/v1/notifications") {
        const auth = await requireSessionAuth(request, response, db, config);
        const notifications = await listNotifications(db, { accountId: auth.account.id });
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
        const auth = await requireSessionAuth(request, response, db, config);
        const result = (await db.run("UPDATE notifications SET read_at = ? WHERE account_id = ? AND read_at IS NULL", [now(), auth.account.id]));
        sendJson(response, 200, { updated: Number(result.changes) }, config);
        return true;
      }

      const notificationReadMatch = url.pathname.match(/^\/api\/v1\/notifications\/([^/]+)\/read$/);
      if (method === "PATCH" && notificationReadMatch) {
        const auth = await requireSessionAuth(request, response, db, config);
        const result = (await db.run("UPDATE notifications SET read_at = ? WHERE id = ? AND account_id = ? AND read_at IS NULL", [now(), notificationReadMatch[1], auth.account.id]));
        if (!result.changes) throw new HttpError(404, "notification not found", "not_found");
        sendNoContent(response, 204, config);
        return true;
      }

      const realtimeTicketMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/realtime-ticket$/);
      if (method === "POST" && realtimeTicketMatch) {
        const auth = await requireAuth(request, response, db, config);
        requireScope(auth, "projects:read");
        const projectId = decodeURIComponent(realtimeTicketMatch[1]);
        const role = await projectRole(db, projectId, auth.account.id);
        if (!role) throw new HttpError(404, "project not found", "not_found");
        const ticket = await collab.issueTicket({
          projectId,
          accountId: auth.account.id,
          ttlMs: config.realtimeTicketTtlMs,
        });
        sendJson(response, 201, ticket, config);
        return true;
      }

      const locksMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/locks$/);
      if ((method === "POST" || method === "DELETE") && locksMatch) {
        const auth = await requireAuth(request, response, db, config);
        requireScope(auth, "projects:write");
        const projectId = decodeURIComponent(locksMatch[1]);
        const role = await projectRole(db, projectId, auth.account.id);
        if (!role) throw new HttpError(404, "project not found", "not_found");
        if (!["owner", "editor"].includes(role)) throw new HttpError(403, "editor role required", "forbidden");
        const body = await readJson(request);
        const key = requireString(body.key, "key", 200);
        if (method === "DELETE") {
          const released = await collab.releaseLock({
            projectId,
            key,
            token: requireString(body.token, "token", 200),
          });
          if (!released) throw new HttpError(409, "lock does not belong to this token", "lock_conflict");
          await writeAudit(db, {
            actorAccountId: auth.account.id,
            action: "project.lock_released",
            resourceType: "project",
            resourceId: projectId,
            metadata: { key },
            ip,
            secret: config.secret,
          });
          sendJson(response, 200, { released: true }, config);
          return true;
        }
        if (body.token !== undefined) {
          const renewed = await collab.heartbeatLock({
            projectId,
            key,
            token: requireString(body.token, "token", 200),
            ttlMs: config.editLockTtlMs,
          });
          if (!renewed) throw new HttpError(409, "lock expired or belongs to another client", "lock_conflict");
          sendJson(response, 200, { renewed: true, key }, config);
          return true;
        }
        const lock = await collab.acquireLock({
          projectId,
          key,
          accountId: auth.account.id,
          ttlMs: config.editLockTtlMs,
        });
        if (!lock) throw new HttpError(409, "lock is held by another client", "lock_conflict");
        await writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "project.lock_acquired",
          resourceType: "project",
          resourceId: projectId,
          metadata: { key },
          ip,
          secret: config.secret,
        });
        sendJson(response, 201, { key, ...lock }, config);
        return true;
      }

      const eventsMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/events$/);
      if (method === "GET" && eventsMatch) {
        const projectId = decodeURIComponent(eventsMatch[1]);
        const ticketValue = url.searchParams.get("ticket");
        let auth;
        if (ticketValue) {
          const consumed = await collab.consumeTicket(ticketValue);
          if (!consumed || consumed.projectId !== projectId) {
            throw new HttpError(401, "invalid or expired realtime ticket", "ticket_invalid");
          }
          const account = await db.get("SELECT id, email, display_name FROM accounts WHERE id = ? AND deleted_at IS NULL AND status = 'active'", [consumed.accountId]);
          if (!account) throw new HttpError(401, "invalid or expired realtime ticket", "ticket_invalid");
          auth = { account: { id: account.id, email: account.email, displayName: account.display_name } };
        } else {
          auth = await requireAuth(request, response, db, config);
        }
        const role = await projectRole(db, projectId, auth.account.id);
        if (!role) throw new HttpError(404, "project not found", "not_found");
        applySecurityHeaders(response, config);
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        response.flushHeaders();
        const preference = (await db.get("SELECT presence_enabled FROM email_preferences WHERE account_id = ?", [auth.account.id]));
        const presenceEnabled = preference ? Boolean(preference.presence_enabled) : true;
        const client = events.subscribe(projectId, auth.account.id, response, {
          presence: presenceEnabled,
        });
        const connectionId = crypto.randomUUID();
        const presenceName = auth.account.display_name || auth.account.email || "";
        const refreshPresence = async () => {
          if (!presenceEnabled) return;
          await collab.updatePresence({
            projectId,
            accountId: auth.account.id,
            connectionId,
            name: presenceName,
          });
          await broadcastPresence(projectId);
        };
        let presenceTimer = null;
        if (presenceEnabled) {
          await collab.joinPresence({ projectId, accountId: auth.account.id, connectionId });
          response.write(`event: ready\ndata: ${JSON.stringify({ connectionId, accountId: auth.account.id })}\n\n`);
          void refreshPresence().catch((error) => logger.error("presence.join_failed", { message: error.message }));
          presenceTimer = setInterval(() => {
            void refreshPresence().catch((error) => logger.error("presence.refresh_failed", { message: error.message }));
          }, 20_000);
          presenceTimer.unref?.();
        } else {
          response.write(`event: ready\ndata: ${JSON.stringify({ connectionId, accountId: auth.account.id })}\n\n`);
        }
        request.on("close", () => {
          events.unsubscribe(client);
          if (presenceTimer) clearInterval(presenceTimer);
          if (!presenceEnabled) return;
          void collab.leavePresence({ projectId, connectionId })
            .then(() => broadcastPresence(projectId))
            .catch((error) => logger.error("presence.leave_failed", { message: error.message }));
        });
        return true;
      }

      const presenceMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/presence$/);
      if (method === "POST" && presenceMatch) {
        const auth = await requireAuth(request, response, db, config);
        const projectId = decodeURIComponent(presenceMatch[1]);
        if (!(await projectRole(db, projectId, auth.account.id))) {
          throw new HttpError(404, "project not found", "not_found");
        }
        const body = await readJson(request);
        const connectionId = requireString(body.connectionId, "connectionId", 100);
        const name = typeof body.name === "string" ? body.name.slice(0, 80) : "";
        let cursor;
        if (body.cursor === null) {
          cursor = null;
        } else if (body.cursor && typeof body.cursor === "object") {
          const cardId = String(body.cursor.cardId || "").slice(0, 100);
          const field = String(body.cursor.field || "").slice(0, 40);
          const offset = Math.max(0, Math.min(1_000_000, Number(body.cursor.offset) || 0));
          const length = Math.max(0, Math.min(1_000_000, Number(body.cursor.length) || 0));
          if (cardId) cursor = { cardId, field, offset, length };
        }
        const updated = await collab.updatePresence({
          projectId,
          accountId: auth.account.id,
          connectionId,
          name,
          cursor,
        });
        if (!updated) throw new HttpError(404, "presence connection expired", "presence_expired");
        await broadcastPresence(projectId);
        sendNoContent(response, 204, config);
        return true;
      }

      const versionsMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/versions$/);
      if (method === "GET" && versionsMatch) {
        const auth = await requireAuth(request, response, db, config);
        requireScope(auth, "projects:read");
        const role = await projectRole(db, versionsMatch[1], auth.account.id);
        if (!role) throw new HttpError(404, "project not found", "not_found");
        const versions = (await db.all(`SELECT revision, created_by, created_at, length(doc) AS bytes
             FROM project_versions WHERE project_id = ? ORDER BY revision DESC LIMIT 100`, [versionsMatch[1]]));
        sendJson(response, 200, { versions }, config);
        return true;
      }

      const restoreMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/versions\/(\d+)\/restore$/);
      if (method === "POST" && restoreMatch) {
        const auth = await requireAuth(request, response, db, config);
        requireScope(auth, "projects:write");
        const role = await projectRole(db, restoreMatch[1], auth.account.id);
        if (!role) throw new HttpError(404, "project not found", "not_found");
        if (!hasRole(role, "editor")) throw new HttpError(403, "editor role required", "forbidden");
        const version = (await db.get("SELECT doc FROM project_versions WHERE project_id = ? AND revision = ?", [restoreMatch[1], Number(restoreMatch[2])]));
        if (!version) throw new HttpError(404, "version not found", "not_found");
        const current = (await db.get("SELECT revision FROM projects WHERE id = ? AND deleted_at IS NULL", [restoreMatch[1]]));
        if (!current) throw new HttpError(404, "project not found", "not_found");
        const revision = await writeDocRevision(
          restoreMatch[1],
          version.doc,
          current.revision,
          auth.account.id
        );
        events.publish(restoreMatch[1], {
          type: "snapshot",
          projectId: restoreMatch[1],
          revision,
          restoredFrom: Number(restoreMatch[2]),
          actor: auth.account.id,
        });
        await writeAudit(db, {
          actorAccountId: auth.account.id,
          action: "project.version_restored",
          resourceType: "project",
          resourceId: restoreMatch[1],
          metadata: { fromRevision: Number(restoreMatch[2]), revision },
          ip,
          secret: config.secret,
        });
        await notifyProjectMembers(db, restoreMatch[1], {
          except: auth.account.id,
          kind: "project.version_restored",
          title: "Project restored to an earlier revision",
          body: `Revision ${revision} was restored from revision ${restoreMatch[2]}.`,
        });
        await emailRecipients(
          (await db.all("SELECT account_id FROM project_members WHERE project_id = ? AND account_id != ?", [restoreMatch[1], auth.account.id]))
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
        const auth = await requireAuth(request, response, db, config);
        const projectId = assetCollectionMatch[1];
        const role = await projectRole(db, projectId, auth.account.id);
        if (!role) throw new HttpError(404, "project not found", "not_found");
        if (method === "GET") {
          requireScope(auth, "projects:read");
          const assets = (await db.all("SELECT id, name, content_type, bytes, created_at FROM project_assets WHERE project_id = ? ORDER BY created_at DESC", [projectId]))
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
        validateUpload(contentType, data);
        if (!(await scanUpload(config, data, logger))) {
          throw new HttpError(422, "asset was rejected by the upload scanner", "upload_rejected");
        }
        const object = await objects.store(data, contentType);
        const assetId = crypto.randomUUID();
        (await db.run("INSERT INTO project_assets (id, project_id, object_id, name, content_type, bytes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [assetId, projectId, object.id, filename, contentType, data.length, auth.account.id, now()]));
        await writeAudit(db, {
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
        const auth = await requireAuth(request, response, db, config);
        requireScope(auth, "projects:read");
        const role = await projectRole(db, assetItemMatch[1], auth.account.id);
        if (!role) throw new HttpError(404, "project not found", "not_found");
        const asset = (await db.get("SELECT * FROM project_assets WHERE id = ? AND project_id = ?", [assetItemMatch[2], assetItemMatch[1]]));
        if (!asset) throw new HttpError(404, "asset not found", "not_found");
        const object = await objects.get(asset.object_id);
        if (!object) throw new HttpError(404, "asset not found", "not_found");
        sendBinary(response, config, object.body, {
          contentType: asset.content_type,
          filename: asset.name,
          download: !String(asset.content_type || "").toLowerCase().startsWith("image/"),
        });
        return true;
      }

      const projectMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)$/);
      if (method === "GET" && projectMatch) {
        const auth = await requireAuth(request, response, db, config);
        requireScope(auth, "projects:read");
        const role = await projectRole(db, projectMatch[1], auth.account.id);
        if (!role) throw new HttpError(404, "project not found", "not_found");
        const project = (await db.get("SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL", [projectMatch[1]]));
        if (!project) throw new HttpError(404, "project not found", "not_found");
        const snapshot = (await db.get("SELECT revision, doc, updated_at FROM project_snapshots WHERE project_id = ?", [project.id]));
        sendJson(response, 200, {
          project: {
            id: project.id,
            name: project.name,
            revision: project.revision,
            lastSeq: Number(project.last_seq || 0),
            role,
            parentProjectId: project.parent_project_id,
            publicSharingEnabled: Boolean(project.public_sharing_enabled),
          },
          snapshot,
        }, config);
        return true;
      }

      const opsMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/ops$/);
      if (method === "POST" && opsMatch) {
        const auth = await requireAuth(request, response, db, config);
        requireScope(auth, "projects:write");
        const projectId = decodeURIComponent(opsMatch[1]);
        const role = await projectRole(db, projectId, auth.account.id);
        if (!role) throw new HttpError(404, "project not found", "not_found");
        if (!["owner", "editor"].includes(role)) throw new HttpError(403, "editor role required", "forbidden");
        const body = await readJson(request, 8 * 1024 * 1024);
        let operations;
        try {
          operations = validateOperations(body.ops);
        } catch (error) {
          if (error instanceof OpError) throw new HttpError(error.status || 400, error.message, error.code);
          throw error;
        }
        const baseSeq = Number(body.baseSeq ?? 0);
        if (!Number.isInteger(baseSeq) || baseSeq < 0) {
          throw new HttpError(400, "baseSeq must be a non-negative integer", "op_invalid");
        }
        const lockedCards = [];
        for (const operation of operations) {
          if (!["card.update", "card.delete", "card.move"].includes(operation.type)) continue;
          const cardId = String(operation.payload?.id || "");
          if (!cardId) continue;
          const owner = await collab.lockOwner({ projectId, key: `card:${cardId}` });
          if (owner && owner.accountId !== auth.account.id) lockedCards.push(cardId);
        }
        if (lockedCards.length) {
          throw new HttpError(423, "card is locked by another editor", "card_locked");
        }
        let result;
        try {
          result = await db.transaction(async (tx) => {
            const project = (await tx.get("SELECT id, revision, last_seq FROM projects WHERE id = ? AND deleted_at IS NULL", [projectId]));
            if (!project) throw new HttpError(404, "project not found", "not_found");
            const marks = operations.map(() => "?").join(",");
            const existing = (await tx.all(
              `SELECT op_id, seq FROM project_ops WHERE project_id = ? AND op_id IN (${marks})`,
              [projectId, ...operations.map((op) => op.opId)]
            ));
            if (existing.length) {
              return {
                idempotent: true,
                seq: Number(existing[0].seq),
                lastSeq: Number(project.last_seq),
                revision: Number(project.revision),
              };
            }
            if (Number(baseSeq) !== Number(project.last_seq)) {
              throw new HttpError(409, "sequence conflict", "seq_conflict");
            }
            const snapshot = (await tx.get("SELECT doc FROM project_snapshots WHERE project_id = ?", [projectId]));
            let doc;
            try {
              doc = JSON.parse(snapshot?.doc || "{}");
            } catch {
              doc = { id: projectId, title: "Untitled", cards: [], connections: [], trash: [] };
            }
            let seq = Number(project.last_seq);
            const applied = [];
            for (const operation of operations) {
              try {
                applyOperation(doc, operation);
              } catch (error) {
                if (error instanceof OpError) throw new HttpError(400, error.message, error.code);
                throw error;
              }
              seq += 1;
              await tx.run(
                `INSERT INTO project_ops (project_id, seq, op_id, actor_account_id, type, payload, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [projectId, seq, operation.opId, auth.account.id, operation.type, JSON.stringify(operation.payload), now()]
              );
              applied.push({ seq, opId: operation.opId, type: operation.type });
            }
            const revision = Number(project.revision) + 1;
            const serialized = JSON.stringify(doc);
            await tx.run(
              "UPDATE project_snapshots SET revision = ?, doc = ?, last_seq = ?, updated_by = ?, updated_at = ? WHERE project_id = ?",
              [revision, serialized, seq, auth.account.id, now(), projectId]
            );
            await tx.run(
              "UPDATE projects SET revision = ?, last_seq = ?, updated_at = ? WHERE id = ?",
              [revision, seq, now(), projectId]
            );
            await tx.run(
              `INSERT INTO project_versions (id, project_id, revision, doc, created_by, created_at, last_seq, kind)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'ops')`,
              [crypto.randomUUID(), projectId, revision, serialized, auth.account.id, now(), seq]
            );
            return { idempotent: false, seq, lastSeq: seq, revision, ops: applied };
          });
        } catch (error) {
          if (error instanceof OpError) throw new HttpError(400, error.message, error.code);
          throw error;
        }
        if (!result.idempotent) {
          events.publish(projectId, {
            type: "ops",
            projectId,
            seq: result.seq,
            lastSeq: result.lastSeq,
            revision: result.revision,
            ops: result.ops,
            actor: auth.account.id,
          });
          await writeAudit(db, {
            actorAccountId: auth.account.id,
            action: "project.ops_applied",
            resourceType: "project",
            resourceId: projectId,
            metadata: { fromSeq: baseSeq, toSeq: result.lastSeq, count: result.ops.length },
            ip,
            secret: config.secret,
          });
        }
        sendJson(response, 200, result, config);
        return true;
      }

      if (method === "GET" && opsMatch) {
        const auth = await requireAuth(request, response, db, config);
        requireScope(auth, "projects:read");
        const projectId = decodeURIComponent(opsMatch[1]);
        const role = await projectRole(db, projectId, auth.account.id);
        if (!role) throw new HttpError(404, "project not found", "not_found");
        const project = (await db.get("SELECT last_seq, revision FROM projects WHERE id = ? AND deleted_at IS NULL", [projectId]));
        if (!project) throw new HttpError(404, "project not found", "not_found");
        const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 200));
        const minRow = (await db.get("SELECT MIN(seq) AS min_seq FROM project_ops WHERE project_id = ?", [projectId]));
        const minSeq = minRow?.min_seq === null || minRow?.min_seq === undefined ? null : Number(minRow.min_seq);
        if (after > 0 && minSeq !== null && after < minSeq - 1) {
          throw new HttpError(409, "operation log pruned; reload the snapshot", "resync_required");
        }
        const rows = (await db.all(
          `SELECT seq, op_id, actor_account_id, type, payload, created_at
           FROM project_ops WHERE project_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
          [projectId, after, limit]
        ));
        const ops = rows.map((row) => {
          let payload = null;
          try {
            payload = JSON.parse(row.payload);
          } catch {
            payload = null;
          }
          return {
            seq: Number(row.seq),
            opId: row.op_id,
            actor: row.actor_account_id,
            type: row.type,
            payload,
            createdAt: Number(row.created_at),
          };
        });
        sendJson(response, 200, {
          projectId,
          lastSeq: Number(project.last_seq),
          revision: Number(project.revision),
          after,
          ops,
          hasMore: ops.length > 0 && ops[ops.length - 1].seq < Number(project.last_seq),
        }, config);
        return true;
      }

      const snapshotMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/snapshot$/);
      if (method === "PUT" && snapshotMatch) {
        const auth = await requireAuth(request, response, db, config);
        requireScope(auth, "projects:write");
        const role = await projectRole(db, snapshotMatch[1], auth.account.id);
        if (!role) throw new HttpError(404, "project not found", "not_found");
        if (!["owner", "editor"].includes(role)) {
          throw new HttpError(403, "editor role required", "forbidden");
        }
        const body = await readJson(request, MAX_SNAPSHOT_BYTES);
        const doc = requireString(body.doc, "doc", MAX_SNAPSHOT_BYTES);
        const project = (await db.get("SELECT revision FROM projects WHERE id = ? AND deleted_at IS NULL", [snapshotMatch[1]]));
        if (!project) throw new HttpError(404, "project not found", "not_found");
        if (body.revision !== undefined && Number(body.revision) !== project.revision) {
          throw new HttpError(409, "revision conflict", "revision_conflict");
        }
        const revision = await writeDocRevision(
          snapshotMatch[1],
          doc,
          project.revision,
          auth.account.id
        );
        events.publish(snapshotMatch[1], {
          type: "snapshot",
          projectId: snapshotMatch[1],
          revision,
          actor: auth.account.id,
        });
        await writeAudit(db, {
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
