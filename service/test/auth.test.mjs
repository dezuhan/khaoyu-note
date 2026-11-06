import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { createLogger } from "../src/logger.mjs";
import { openDatabase, migrate, MIGRATIONS_DIR } from "../src/db.mjs";
import { createFileMailer } from "../src/auth/mailer.mjs";
import { generateTotp } from "../src/auth/totp.mjs";
import { createService } from "../src/app.mjs";
import { runMaintenance } from "../src/worker.mjs";

const SECRET = "Kx9-vQ2m-Rt7-pL4s-Wb8-nC3d-Hf6-jZ1a";
const PASSWORD = "correct-horse-9";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "khaoyu-auth-"));
}

function configFor(dataDir) {
  return {
    profile: "single-user",
    host: "127.0.0.1",
    port: 0,
    publicUrl: "http://127.0.0.1",
    dataDir,
    secret: SECRET,
    databasePath: path.join(dataDir, "khaoyu-service.db"),
    objectsDir: path.join(dataDir, "objects"),
    tempDir: path.join(dataDir, "tmp"),
    backupsDir: path.join(dataDir, "backups"),
    outboxDir: path.join(dataDir, "outbox"),
    cookieSecure: false,
    publicSharingEnabled: true,
    corsOrigins: ["tauri://localhost"],
    adminToken: "Admin-5f3c9a7e2b8d4c1f6a0e9d3b7c2f8a4e",
    ssoEnabled: true,
    ssoSecret: "Sso-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    ssoHeader: "x-auth-request-email",
    ssoNameHeader: "x-auth-request-name",
    ssoAutoCreate: true,
    trustProxy: true,
    accessTtlMinutes: 15,
    refreshTtlDays: 7,
    deletionGraceDays: 30,
    loginWindowMinutes: 15,
    loginMaxAttempts: 5,
    backupIntervalHours: 24,
    backupRetention: 2,
    auditRetentionDays: 90,
    tempMaxAgeHours: 1,
  };
}

function absorbCookies(jar, response) {
  const raw = response.headers.getSetCookie?.() || [];
  for (const cookie of raw) {
    const pair = cookie.split(";")[0];
    const index = pair.indexOf("=");
    if (index > 0) jar[pair.slice(0, index)] = pair.slice(index + 1);
  }
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

async function start() {
  const dataDir = tempDir();
  const config = configFor(dataDir);
  const db = openDatabase(config.databasePath);
  migrate(db, { directory: MIGRATIONS_DIR });
  const logger = createLogger({ write() {} });
  const mailer = createFileMailer(config, logger);
  const server = createService({ config, db, logger, mailer });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  async function call(pathname, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.jar && Object.keys(options.jar).length) headers.Cookie = cookieHeader(options.jar);
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.jar?.khaoyu_csrf && options.csrf !== false) {
      headers["x-csrf-token"] = options.jar.khaoyu_csrf;
    }
    const response = await fetch(base + pathname, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "manual",
    });
    if (options.jar) absorbCookies(options.jar, response);
    let body = null;
    const text = await response.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, body, response };
  }

  async function raw(pathname, { method = "GET", jar, headers = {}, body } = {}) {
    const requestHeaders = { ...headers };
    if (jar && Object.keys(jar).length) requestHeaders.Cookie = cookieHeader(jar);
    if (jar?.khaoyu_csrf) requestHeaders["x-csrf-token"] = jar.khaoyu_csrf;
    const response = await fetch(base + pathname, { method, headers: requestHeaders, body });
    if (jar) absorbCookies(jar, response);
    const buffer = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, buffer, text: buffer.toString("utf8"), response };
  }

  function mailCount(kind, to) {
    return fs
      .readdirSync(config.outboxDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => JSON.parse(fs.readFileSync(path.join(config.outboxDir, file), "utf8")))
      .filter((message) => message.kind === kind && (!to || message.to === to)).length;
  }

  function latestMail(kind, to) {
    const files = fs
      .readdirSync(config.outboxDir)
      .filter((file) => file.endsWith(".json"))
      .sort()
      .reverse();
    for (const file of files) {
      const message = JSON.parse(fs.readFileSync(path.join(config.outboxDir, file), "utf8"));
      if (message.kind === kind && (!to || message.to === to)) return message;
    }
    throw new Error(`no ${kind} mail for ${to}`);
  }

  async function register(email, password = PASSWORD) {
    const result = await call("/api/v1/auth/register", {
      method: "POST",
      body: { email, password, displayName: email.split("@")[0] },
    });
    assert.equal(result.status, 202, JSON.stringify(result.body));
  }

  async function verify(email) {
    const message = latestMail("verify", email);
    const token = message.text.match(/token: (\S+)/)[1];
    const result = await call("/api/v1/auth/verify-email", { method: "POST", body: { token } });
    assert.equal(result.status, 204);
  }

  async function login(email, password = PASSWORD, extra = {}) {
    const jar = {};
    const result = await call("/api/v1/auth/login", {
      method: "POST",
      body: { email, password, ...extra },
      jar,
    });
    return { ...result, jar };
  }

  async function account(email) {
    const password = `${PASSWORD}-${crypto.randomUUID().slice(0, 4)}`;
    await register(email, password);
    await verify(email);
    const logged = await login(email, password);
    assert.equal(logged.status, 200, JSON.stringify(logged.body));
    return { email, password, jar: logged.jar, account: logged.body.account };
  }

  return {
    base,
    config,
    db,
    server,
    call,
    raw,
    register,
    verify,
    login,
    account,
    latestMail,
    mailCount,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

test("account, login, refresh, session, reset and authorization flows", async (t) => {
  const api = await start();
  t.after(() => api.close());

  async function createProject(user, title = "Test project") {
    const created = await api.call("/api/v1/projects", {
      method: "POST",
      jar: user.jar,
      body: { title },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.id;
  }

  async function putSnapshot(user, projectId, doc, revision = 1) {
    const updated = await api.call(`/api/v1/projects/${projectId}/snapshot`, {
      method: "PUT",
      jar: user.jar,
      body: { doc: JSON.stringify(doc), revision },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    return updated.body.revision;
  }

  await t.test("registration requires email verification before login", async () => {
    const email = `verify-${crypto.randomUUID()}@example.com`;
    await api.register(email);
    const before = await api.login(email);
    assert.equal(before.status, 403);
    assert.equal(before.body.error, "Email verification required");
    await api.verify(email);
    const after = await api.login(email);
    assert.equal(after.status, 200);
    assert.equal(after.body.account.email, email);
    assert.ok(after.jar.khaoyu_access);
    assert.ok(after.jar.khaoyu_refresh);
    assert.ok(after.jar.khaoyu_csrf);
    const projects = await api.call("/api/v1/projects", { jar: after.jar });
    assert.equal(projects.status, 200);
    assert.deepEqual(projects.body.projects, []);
  });

  await t.test("trusted-proxy SSO requires a signed email and can auto-create", async () => {
    const email = `sso-${crypto.randomUUID()}@example.com`;
    const signature = crypto
      .createHmac("sha256", api.config.ssoSecret)
      .update(email)
      .digest("hex");
    const created = await api.raw("/api/v1/auth/sso/login", {
      method: "POST",
      headers: {
        "x-auth-request-email": email,
        "x-auth-request-name": "SSO User",
        "x-khaoyu-sso-signature": signature,
      },
    });
    assert.equal(created.status, 200, created.text);
    const body = JSON.parse(created.text);
    assert.equal(body.account.email, email);
    assert.equal(body.account.displayName, "SSO User");
    const jar = {};
    for (const cookie of created.response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0];
      const index = pair.indexOf("=");
      jar[pair.slice(0, index)] = pair.slice(index + 1);
    }
    assert.equal((await api.call("/api/v1/projects", { jar })).status, 200);
    assert.equal((await api.login(email)).status, 401);

    const wrong = await api.raw("/api/v1/auth/sso/login", {
      method: "POST",
      headers: {
        "x-auth-request-email": email,
        "x-khaoyu-sso-signature": "0".repeat(64),
      },
    });
    assert.equal(wrong.status, 401);

    api.config.ssoEnabled = false;
    assert.equal(
      (await api.raw("/api/v1/auth/sso/login", {
        method: "POST",
        headers: {
          "x-auth-request-email": email,
          "x-khaoyu-sso-signature": signature,
        },
      })).status,
      404
    );
    api.config.ssoEnabled = true;
  });

  await t.test("email one-time codes can log in and are single use", async () => {
    const email = `otp-${crypto.randomUUID()}@example.com`;
    await api.register(email);
    await api.verify(email);
    const request = await api.call("/api/v1/auth/otp/request", {
      method: "POST",
      body: { email },
    });
    assert.equal(request.status, 202);
    const message = api.latestMail("otp", email);
    const code = message.text.match(/code: (\d{6})/)[1];
    const login = await api.call("/api/v1/auth/otp/login", {
      method: "POST",
      body: { email, code },
    });
    assert.equal(login.status, 200);
    const reuse = await api.call("/api/v1/auth/otp/login", {
      method: "POST",
      body: { email, code },
    });
    assert.equal(reuse.status, 401);
  });

  await t.test("login errors are generic and throttling blocks repeated failures", async () => {
    const email = `throttle-${crypto.randomUUID()}@example.com`;
    await api.register(email);
    await api.verify(email);
    const unknown = await api.login(`missing-${crypto.randomUUID()}@example.com`);
    const wrong = await api.login(email, "wrong-password-123");
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(unknown.body.error, wrong.body.error);

    api.db.exec("DELETE FROM login_attempts");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await api.login(email, "wrong-password-123");
    }
    const blocked = await api.login(email);
    assert.equal(blocked.status, 429);
    const firstRetry = Number(blocked.response.headers.get("retry-after"));
    assert.ok(firstRetry >= 1);
    const blockedAgain = await api.login(email);
    const secondRetry = Number(blockedAgain.response.headers.get("retry-after"));
    assert.ok(secondRetry > firstRetry, `${secondRetry} should exceed ${firstRetry}`);
    api.db.exec("DELETE FROM login_attempts");
  });

  await t.test("CSRF is required for cookie writes and project access is authorized", async () => {
    const owner = await api.account(`owner-${crypto.randomUUID()}@example.com`);
    const noCsrf = await api.call("/api/v1/projects", {
      method: "POST",
      jar: owner.jar,
      csrf: false,
      body: { title: "Private project" },
    });
    assert.equal(noCsrf.status, 403);
    const created = await api.call("/api/v1/projects", {
      method: "POST",
      jar: owner.jar,
      body: { title: "Private project" },
    });
    assert.equal(created.status, 201);
    const projectId = created.body.id;
    const own = await api.call(`/api/v1/projects/${projectId}`, { jar: owner.jar });
    assert.equal(own.status, 200);
    assert.equal(own.body.project.role, "owner");

    const stranger = await api.account(`stranger-${crypto.randomUUID()}@example.com`);
    const denied = await api.call(`/api/v1/projects/${projectId}`, { jar: stranger.jar });
    assert.equal(denied.status, 404);

    api.db
      .prepare("INSERT INTO project_members (project_id, account_id, role, created_at) VALUES (?, ?, 'viewer', ?)")
      .run(projectId, stranger.account.id, Date.now());
    const visible = await api.call(`/api/v1/projects/${projectId}`, { jar: stranger.jar });
    assert.equal(visible.status, 200);
    assert.equal(visible.body.project.role, "viewer");
    const viewerWrite = await api.call(`/api/v1/projects/${projectId}/snapshot`, {
      method: "PUT",
      jar: stranger.jar,
      body: { doc: "{}", revision: 1 },
    });
    assert.equal(viewerWrite.status, 403);

    const update = await api.call(`/api/v1/projects/${projectId}/snapshot`, {
      method: "PUT",
      jar: owner.jar,
      body: { doc: "{\"cards\":[]}", revision: 1 },
    });
    assert.equal(update.status, 200);
    const stale = await api.call(`/api/v1/projects/${projectId}/snapshot`, {
      method: "PUT",
      jar: owner.jar,
      body: { doc: "{}", revision: 1 },
    });
    assert.equal(stale.status, 409);
  });

  await t.test("admin audit, abuse and stats endpoints require an operator token", async () => {
    const token = "Admin-5f3c9a7e2b8d4c1f6a0e9d3b7c2f8a4e";
    const denied = await api.raw("/api/v1/admin/stats");
    assert.equal(denied.status, 401);
    const stats = await api.raw("/api/v1/admin/stats", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(stats.status, 200);
    assert.ok(JSON.parse(stats.text).accounts >= 1);
    const audit = await api.raw("/api/v1/admin/audit?limit=5", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(audit.status, 200);
    assert.ok(Array.isArray(JSON.parse(audit.text).entries));
    const abuse = await api.raw("/api/v1/admin/abuse-reports", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(abuse.status, 200);
    assert.ok(Array.isArray(JSON.parse(abuse.text).reports));
  });

  await t.test("CORS preflight is limited to configured desktop origins", async () => {
    const allowed = await api.raw("/api/v1/projects", {
      method: "OPTIONS",
      headers: {
        origin: "tauri://localhost",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "tauri://localhost");
    const denied = await api.raw("/api/v1/projects", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "PUT" },
    });
    assert.equal(denied.status, 403);
  });

  await t.test("revision history restores snapshots and SSE emits project changes", async () => {
    const user = await api.account(`history-${crypto.randomUUID()}@example.com`);
    const projectId = await createProject(user, "History");
    let revision = await putSnapshot(user, projectId, {
      id: projectId,
      title: "First",
      cards: [],
      connections: [],
      trash: [],
    }, 1);
    revision = await putSnapshot(user, projectId, {
      id: projectId,
      title: "Second",
      cards: [],
      connections: [],
      trash: [],
    }, revision);

    const versions = await api.call(`/api/v1/projects/${projectId}/versions`, { jar: user.jar });
    assert.equal(versions.status, 200);
    assert.ok(versions.body.versions.some((entry) => entry.revision === revision));
    const restored = await api.call(
      `/api/v1/projects/${projectId}/versions/${revision - 1}/restore`,
      { method: "POST", jar: user.jar }
    );
    assert.equal(restored.status, 200);
    assert.equal(restored.body.revision, revision + 1);
    const snapshot = await api.call(`/api/v1/projects/${projectId}`, { jar: user.jar });
    assert.equal(JSON.parse(snapshot.body.snapshot.doc).title, "First");

    const controller = new AbortController();
    const response = await fetch(`${api.base}/api/v1/projects/${projectId}/events`, {
      headers: { cookie: cookieHeader(user.jar) },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let streamed = "";
    const readUntil = async (pattern) => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const result = await Promise.race([
          reader.read(),
          new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remaining)),
        ]);
        if (result.timeout) break;
        if (result.done) break;
        streamed += Buffer.from(result.value).toString("utf8");
        if (streamed.includes(pattern)) return true;
      }
      return false;
    };
    assert.equal(await readUntil("event: presence"), true);
    const nextRevision = await putSnapshot(user, projectId, {
      id: projectId,
      title: "Third",
      cards: [],
      connections: [],
      trash: [],
    }, restored.body.revision);
    assert.equal(await readUntil("event: snapshot"), true);
    assert.ok(streamed.includes(`"revision":${nextRevision}`));
    controller.abort();
    await reader.cancel().catch(() => {});
  });

  await t.test("share write permissions respect scope, passphrases and revisions", async () => {
    const owner = await api.account(`share-write-${crypto.randomUUID()}@example.com`);
    const projectId = await createProject(owner, "Share writes");
    await api.call(`/api/v1/projects/${projectId}/public-sharing`, {
      method: "POST",
      jar: owner.jar,
      body: { enabled: true },
    });
    const revision = await putSnapshot(owner, projectId, {
      id: projectId,
      title: "Share writes",
      cards: [
        { id: "col1", type: "column", x: 0, y: 0, w: 200, h: 300, z: 1, title: "Column" },
        { id: "child1", type: "note", x: 10, y: 70, w: 180, h: 70, z: 2, parentId: "col1", text: "Child" },
        { id: "sibling1", type: "note", x: 400, y: 0, w: 200, h: 70, z: 3, text: "Sibling" },
      ],
      connections: [],
      trash: [],
    });

    const columnShare = await api.call(`/api/v1/projects/${projectId}/shares`, {
      method: "POST",
      jar: owner.jar,
      body: { scope: "column", targetId: "col1", permission: "comment" },
    });
    const comment = await api.call(`/api/v1/share/${columnShare.body.token}/comments`, {
      method: "POST",
      body: { cardId: "child1", text: "Scoped comment" },
    });
    assert.equal(comment.status, 201);
    const columnAccess = await api.call(`/api/v1/share/${columnShare.body.token}/access`, {
      method: "POST",
      body: {},
    });
    assert.equal(
      columnAccess.body.cards.find((card) => card.id === "child1").shareComments[0].text,
      "Scoped comment"
    );
    assert.equal(
      (await api.call(`/api/v1/share/${columnShare.body.token}/comments`, {
        method: "POST",
        body: { cardId: "sibling1", text: "Leaked comment" },
      })).status,
      404
    );

    const viewShare = await api.call(`/api/v1/projects/${projectId}/shares`, {
      method: "POST",
      jar: owner.jar,
      body: { scope: "item", targetId: "sibling1", permission: "view" },
    });
    assert.equal(
      (await api.call(`/api/v1/share/${viewShare.body.token}/comments`, {
        method: "POST",
        body: { cardId: "sibling1", text: "Not allowed" },
      })).status,
      403
    );

    const editShare = await api.call(`/api/v1/projects/${projectId}/shares`, {
      method: "POST",
      jar: owner.jar,
      body: { scope: "item", targetId: "sibling1", permission: "edit" },
    });
    const edited = await api.call(`/api/v1/share/${editShare.body.token}/cards/sibling1`, {
      method: "PATCH",
      body: { fields: { text: "Edited by share" } },
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.revision, revision + 2);
    const editedAccess = await api.call(`/api/v1/share/${editShare.body.token}/access`, {
      method: "POST",
      body: {},
    });
    assert.equal(editedAccess.body.card.text, "Edited by share");
    assert.equal(
      (await api.call(`/api/v1/share/${editShare.body.token}/cards/sibling1`, {
        method: "PATCH",
        body: { fields: { text: "Stale" }, revision: 1 },
      })).status,
      409
    );

    const notifications = await api.call("/api/v1/notifications", { jar: owner.jar });
    assert.ok(notifications.body.notifications.some((entry) => entry.kind === "share.comment"));
    assert.ok(notifications.body.notifications.some((entry) => entry.kind === "share.edit"));
  });

  await t.test("presence can be opted out and share comments notify mentions", async () => {
    const owner = await api.account(`mention-owner-${crypto.randomUUID()}@example.com`);
    const guestEmail = `mention-guest-${crypto.randomUUID()}@example.com`;
    const guest = await api.account(guestEmail);
    const projectId = await createProject(owner, "Mentions");
    api.db
      .prepare("INSERT INTO project_members (project_id, account_id, role, created_at) VALUES (?, ?, 'commenter', ?)")
      .run(projectId, guest.account.id, Date.now());
    const preference = await api.call("/api/v1/account/presence", {
      method: "PATCH",
      jar: guest.jar,
      body: { presence: false },
    });
    assert.equal(preference.status, 200);
    assert.equal((await api.call("/api/v1/account/presence", { jar: guest.jar })).body.presence, false);

    await api.call(`/api/v1/projects/${projectId}/public-sharing`, {
      method: "POST",
      jar: owner.jar,
      body: { enabled: true },
    });
    await putSnapshot(owner, projectId, {
      id: projectId,
      title: "Mentions",
      cards: [{ id: "mention-card", type: "note", x: 0, y: 0, w: 200, h: 70, z: 1, text: "Mention target" }],
      connections: [],
      trash: [],
    });
    const share = await api.call(`/api/v1/projects/${projectId}/shares`, {
      method: "POST",
      jar: owner.jar,
      body: { scope: "project", permission: "comment" },
    });
    const comment = await api.call(`/api/v1/share/${share.body.token}/comments`, {
      method: "POST",
      body: { cardId: "mention-card", text: `Hello @${guestEmail}` },
    });
    assert.equal(comment.status, 201);
    const notifications = await api.call("/api/v1/notifications", { jar: guest.jar });
    assert.ok(notifications.body.notifications.some((entry) => entry.kind === "comment.mention"));
  });

  await t.test("public sharing is off until the owner enables it", async () => {
    const owner = await api.account(`share-off-${crypto.randomUUID()}@example.com`);
    const projectId = await createProject(owner, "Private sharing");
    const denied = await api.call(`/api/v1/projects/${projectId}/shares`, {
      method: "POST",
      jar: owner.jar,
      body: { scope: "project", permission: "view" },
    });
    assert.equal(denied.status, 409);
    assert.equal(denied.body.code, "sharing_disabled");
    const enabled = await api.call(`/api/v1/projects/${projectId}/public-sharing`, {
      method: "POST",
      jar: owner.jar,
      body: { enabled: true },
    });
    assert.equal(enabled.status, 204);
    const created = await api.call(`/api/v1/projects/${projectId}/shares`, {
      method: "POST",
      jar: owner.jar,
      body: { scope: "project", permission: "view", expiresInDays: 7 },
    });
    assert.equal(created.status, 201);
    assert.ok(created.body.token.startsWith("khn_share_"));
    const access = await api.call(`/api/v1/share/${created.body.token}/access`, {
      method: "POST",
      body: {},
    });
    assert.equal(access.status, 200);
    assert.equal(access.body.scope, "project");
    assert.equal(access.response.headers.get("x-robots-tag"), "noindex, nofollow");
    const disabled = await api.call(`/api/v1/projects/${projectId}/public-sharing`, {
      method: "POST",
      jar: owner.jar,
      body: { enabled: false },
    });
    assert.equal(disabled.status, 204);
    assert.equal(
      (await api.call(`/api/v1/share/${created.body.token}/access`, { method: "POST", body: {} })).status,
      404
    );
  });

  await t.test("share links expose only their project, item or column scope", async () => {
    const owner = await api.account(`share-scope-${crypto.randomUUID()}@example.com`);
    const projectId = await createProject(owner, "Scoped sharing");
    await api.call(`/api/v1/projects/${projectId}/public-sharing`, {
      method: "POST",
      jar: owner.jar,
      body: { enabled: true },
    });
    const doc = {
      id: projectId,
      title: "Scoped sharing",
      cards: [
        { id: "col1", type: "column", x: 0, y: 0, w: 200, h: 300, z: 1, title: "Column" },
        { id: "child1", type: "note", x: 10, y: 70, w: 180, h: 70, z: 2, parentId: "col1", text: "Child" },
        { id: "secret1", type: "note", x: 400, y: 0, w: 200, h: 70, z: 3, text: "Sibling secret" },
        { id: "file1", type: "file", x: 0, y: 400, w: 200, h: 70, z: 4, path: "/home/secret/private.pdf" },
      ],
      connections: [],
      trash: [{ id: "trash1", type: "note", text: "Deleted secret" }],
    };
    await putSnapshot(owner, projectId, doc);

    const projectShare = await api.call(`/api/v1/projects/${projectId}/shares`, {
      method: "POST",
      jar: owner.jar,
      body: { scope: "project", permission: "view" },
    });
    assert.equal(projectShare.status, 201);
    const projectAccess = await api.call(`/api/v1/share/${projectShare.body.token}/access`, {
      method: "POST",
      body: {},
    });
    assert.equal(projectAccess.status, 200);
    assert.equal(projectAccess.body.doc.trash, undefined);
    assert.equal(
      projectAccess.body.doc.cards.find((card) => card.id === "file1").path,
      null
    );

    const item = await api.call(`/api/v1/projects/${projectId}/shares`, {
      method: "POST",
      jar: owner.jar,
      body: { scope: "item", targetId: "secret1", permission: "view" },
    });
    assert.equal(item.status, 201);
    const itemAccess = await api.call(`/api/v1/share/${item.body.token}/access`, {
      method: "POST",
      body: {},
    });
    assert.equal(itemAccess.status, 200);
    assert.equal(itemAccess.body.card.id, "secret1");
    assert.equal(itemAccess.body.doc, undefined);
    assert.equal(itemAccess.body.cards, undefined);

    const column = await api.call(`/api/v1/projects/${projectId}/shares`, {
      method: "POST",
      jar: owner.jar,
      body: { scope: "column", targetId: "col1", permission: "view" },
    });
    assert.equal(column.status, 201);
    const columnAccess = await api.call(`/api/v1/share/${column.body.token}/access`, {
      method: "POST",
      body: {},
    });
    assert.equal(columnAccess.status, 200);
    assert.deepEqual(columnAccess.body.cards.map((card) => card.id).sort(), ["child1", "col1"]);
    assert.equal(columnAccess.body.cards.some((card) => card.id === "secret1"), false);
  });

  await t.test("share passwords, expiry, rotation and revocation are enforced", async () => {
    const owner = await api.account(`share-life-${crypto.randomUUID()}@example.com`);
    const projectId = await createProject(owner, "Share lifecycle");
    await api.call(`/api/v1/projects/${projectId}/public-sharing`, {
      method: "POST",
      jar: owner.jar,
      body: { enabled: true },
    });
    await putSnapshot(owner, projectId, {
      id: projectId,
      title: "Share lifecycle",
      cards: [{ id: "card1", type: "note", x: 0, y: 0, w: 200, h: 70, z: 1, text: "Hello" }],
      connections: [],
      trash: [],
    });
    const protectedShare = await api.call(`/api/v1/projects/${projectId}/shares`, {
      method: "POST",
      jar: owner.jar,
      body: { scope: "item", targetId: "card1", permission: "view", password: "share-password-123" },
    });
    assert.equal(protectedShare.status, 201);
    const noPassword = await api.call(`/api/v1/share/${protectedShare.body.token}/access`, {
      method: "POST",
      body: {},
    });
    assert.equal(noPassword.status, 404);
    const wrongPassword = await api.call(`/api/v1/share/${protectedShare.body.token}/access`, {
      method: "POST",
      body: { password: "wrong-password-123" },
    });
    assert.equal(wrongPassword.status, 404);
    const goodPassword = await api.call(`/api/v1/share/${protectedShare.body.token}/access`, {
      method: "POST",
      body: { password: "share-password-123" },
    });
    assert.equal(goodPassword.status, 200);

    const report = await api.call(`/api/v1/share/${protectedShare.body.token}/report`, {
      method: "POST",
      body: { reason: "This link looks abusive" },
    });
    assert.equal(report.status, 202);
    assert.equal(api.db.prepare("SELECT COUNT(*) AS count FROM abuse_reports").get().count, 1);

    api.config.publicSharingEnabled = false;
    assert.equal(
      (await api.call(`/api/v1/share/${protectedShare.body.token}/access`, {
        method: "POST",
        body: { password: "share-password-123" },
      })).status,
      404
    );
    const disabledCreate = await api.call(`/api/v1/projects/${projectId}/shares`, {
      method: "POST",
      jar: owner.jar,
      body: { scope: "item", targetId: "card1", permission: "view" },
    });
    assert.equal(disabledCreate.status, 409);
    api.config.publicSharingEnabled = true;

    api.db.exec("DELETE FROM share_attempts");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await api.call(`/api/v1/share/${protectedShare.body.token}/access`, {
        method: "POST",
        body: { password: "wrong-password-123" },
      });
    }
    const blocked = await api.call(`/api/v1/share/${protectedShare.body.token}/access`, {
      method: "POST",
      body: { password: "share-password-123" },
    });
    assert.equal(blocked.status, 429);
    api.db.exec("DELETE FROM share_attempts");

    const expiring = await api.call(`/api/v1/projects/${projectId}/shares`, {
      method: "POST",
      jar: owner.jar,
      body: { scope: "item", targetId: "card1", permission: "view", expiresInDays: 1 },
    });
    api.db.prepare("UPDATE share_links SET expires_at = ? WHERE id = ?").run(Date.now() - 1, expiring.body.id);
    assert.equal(
      (await api.call(`/api/v1/share/${expiring.body.token}/access`, { method: "POST", body: {} })).status,
      404
    );

    const rotateSource = await api.call(`/api/v1/projects/${projectId}/shares`, {
      method: "POST",
      jar: owner.jar,
      body: { scope: "item", targetId: "card1", permission: "view" },
    });
    const rotated = await api.call(`/api/v1/projects/${projectId}/shares/${rotateSource.body.id}/rotate`, {
      method: "POST",
      jar: owner.jar,
    });
    assert.equal(rotated.status, 200);
    assert.equal(
      (await api.call(`/api/v1/share/${rotateSource.body.token}/access`, { method: "POST", body: {} })).status,
      404
    );
    assert.equal(
      (await api.call(`/api/v1/share/${rotated.body.token}/access`, { method: "POST", body: {} })).status,
      200
    );
    const revoked = await api.call(`/api/v1/projects/${projectId}/shares/${rotateSource.body.id}`, {
      method: "DELETE",
      jar: owner.jar,
    });
    assert.equal(revoked.status, 204);
    assert.equal(
      (await api.call(`/api/v1/share/${rotated.body.token}/access`, { method: "POST", body: {} })).status,
      404
    );
  });

  await t.test("invitations add members and ownership transfer is guarded", async () => {
    const owner = await api.account(`owner-members-${crypto.randomUUID()}@example.com`);
    const guestEmail = `guest-${crypto.randomUUID()}@example.com`;
    const guest = await api.account(guestEmail);
    const projectId = await createProject(owner, "Membership");
    assert.equal((await api.call(`/api/v1/projects/${projectId}`, { jar: guest.jar })).status, 404);

    const invitation = await api.call(`/api/v1/projects/${projectId}/invitations`, {
      method: "POST",
      jar: owner.jar,
      body: { email: guestEmail, role: "editor" },
    });
    assert.equal(invitation.status, 201);
    const token = api.latestMail("invite", guestEmail).text.match(/token: (\S+)/)[1];
    const accepted = await api.call("/api/v1/invitations/accept", {
      method: "POST",
      jar: guest.jar,
      body: { token },
    });
    assert.equal(accepted.status, 200);
    const guestView = await api.call(`/api/v1/projects/${projectId}`, { jar: guest.jar });
    assert.equal(guestView.status, 200);
    assert.equal(guestView.body.project.role, "editor");

    const members = await api.call(`/api/v1/projects/${projectId}/members`, { jar: owner.jar });
    assert.equal(members.body.members.length, 2);
    const guestId = guest.account.id;
    const demoted = await api.call(`/api/v1/projects/${projectId}/members/${guestId}`, {
      method: "PATCH",
      jar: owner.jar,
      body: { role: "viewer" },
    });
    assert.equal(demoted.status, 204);
    const transfer = await api.call(`/api/v1/projects/${projectId}/transfer`, {
      method: "POST",
      jar: owner.jar,
      body: { accountId: guestId },
    });
    assert.equal(transfer.status, 204);
    const oldOwner = await api.call(`/api/v1/projects/${projectId}`, { jar: owner.jar });
    assert.equal(oldOwner.body.project.role, "editor");
    const newOwner = await api.call(`/api/v1/projects/${projectId}`, { jar: guest.jar });
    assert.equal(newOwner.body.project.role, "owner");
    const forbiddenTransfer = await api.call(`/api/v1/projects/${projectId}/transfer`, {
      method: "POST",
      jar: owner.jar,
      body: { accountId: guestId },
    });
    assert.equal(forbiddenTransfer.status, 403);
  });

  await t.test("notifications are scoped, readable and removed with revoked shares", async () => {
    const owner = await api.account(`notify-owner-${crypto.randomUUID()}@example.com`);
    const guestEmail = `notify-guest-${crypto.randomUUID()}@example.com`;
    const guest = await api.account(guestEmail);
    const projectId = await createProject(owner, "Notifications");
    const invitation = await api.call(`/api/v1/projects/${projectId}/invitations`, {
      method: "POST",
      jar: owner.jar,
      body: { email: guestEmail, role: "editor" },
    });
    const token = api.latestMail("invite", guestEmail).text.match(/token: (\S+)/)[1];
    await api.call("/api/v1/invitations/accept", {
      method: "POST",
      jar: guest.jar,
      body: { token },
    });
    const ownerList = await api.call("/api/v1/notifications", { jar: owner.jar });
    assert.equal(ownerList.status, 200);
    assert.ok(ownerList.body.notifications.some((entry) => entry.kind === "invitation.accepted"));
    assert.ok(ownerList.body.unread >= 1);

    const unread = ownerList.body.notifications.find((entry) => !entry.readAt);
    const read = await api.call(`/api/v1/notifications/${unread.id}/read`, {
      method: "PATCH",
      jar: owner.jar,
    });
    assert.equal(read.status, 204);
    const afterRead = await api.call("/api/v1/notifications", { jar: owner.jar });
    assert.equal(afterRead.body.notifications.find((entry) => entry.id === unread.id).readAt > 0, true);

    const changed = await api.call(`/api/v1/projects/${projectId}/members/${guest.account.id}`, {
      method: "PATCH",
      jar: owner.jar,
      body: { role: "viewer" },
    });
    assert.equal(changed.status, 204);
    const guestList = await api.call("/api/v1/notifications", { jar: guest.jar });
    assert.ok(guestList.body.notifications.some((entry) => entry.kind === "member.role_changed"));

    await api.call(`/api/v1/projects/${projectId}/members/${guest.account.id}`, {
      method: "DELETE",
      jar: owner.jar,
    });
    const removedGuest = await api.call("/api/v1/notifications", { jar: guest.jar });
    assert.equal(removedGuest.body.notifications.length, 0);

    await api.call(`/api/v1/projects/${projectId}/public-sharing`, {
      method: "POST",
      jar: owner.jar,
      body: { enabled: true },
    });
    const share = await api.call(`/api/v1/projects/${projectId}/shares`, {
      method: "POST",
      jar: owner.jar,
      body: { scope: "project", permission: "view" },
    });
    await api.call(`/api/v1/share/${share.body.token}/report`, {
      method: "POST",
      body: { reason: "Reported notification cleanup test" },
    });
    const reported = await api.call("/api/v1/notifications", { jar: owner.jar });
    assert.ok(reported.body.notifications.some((entry) => entry.kind === "share.reported"));
    await api.call(`/api/v1/projects/${projectId}/shares/${share.body.id}`, {
      method: "DELETE",
      jar: owner.jar,
    });
    const cleaned = await api.call("/api/v1/notifications", { jar: owner.jar });
    assert.equal(cleaned.body.notifications.some((entry) => entry.resourceType === "share_link"), false);
    assert.equal(invitation.status, 201);
  });

  await t.test("email notifications require opt-in, are rate limited and can be unsubscribed", async () => {
    const owner = await api.account(`email-owner-${crypto.randomUUID()}@example.com`);
    const projectId = await createProject(owner, "Email notifications");
    await api.call(`/api/v1/projects/${projectId}/public-sharing`, {
      method: "POST",
      jar: owner.jar,
      body: { enabled: true },
    });
    const share = await api.call(`/api/v1/projects/${projectId}/shares`, {
      method: "POST",
      jar: owner.jar,
      body: { scope: "project", permission: "view" },
    });
    const enabled = await api.call("/api/v1/account/email-preferences", {
      method: "PATCH",
      jar: owner.jar,
      body: { notifications: true },
    });
    assert.equal(enabled.status, 200);
    await api.call(`/api/v1/share/${share.body.token}/report`, {
      method: "POST",
      body: { reason: "First notification email" },
    });
    assert.equal(api.mailCount("notification", owner.email), 1);
    await api.call(`/api/v1/share/${share.body.token}/report`, {
      method: "POST",
      body: { reason: "Rate limited notification email" },
    });
    assert.equal(api.mailCount("notification", owner.email), 1);

    const message = api.latestMail("notification", owner.email);
    const token = decodeURIComponent(message.text.match(/unsubscribe\?token=(\S+)/)[1]);
    const unsubscribed = await api.call(`/api/v1/email/unsubscribe?token=${encodeURIComponent(token)}`);
    assert.equal(unsubscribed.status, 200);
    assert.equal(unsubscribed.body.unsubscribed, true);
    const preference = await api.call("/api/v1/account/email-preferences", { jar: owner.jar });
    assert.equal(preference.body.notifications, false);
  });

  await t.test("project assets require authorization and share download permission", async () => {
    const owner = await api.account(`asset-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await api.account(`asset-stranger-${crypto.randomUUID()}@example.com`);
    const projectId = await createProject(owner, "Assets");
    const body = Buffer.from("hello service asset");
    const upload = await api.raw(`/api/v1/projects/${projectId}/assets`, {
      method: "POST",
      jar: owner.jar,
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": "note.txt",
      },
      body,
    });
    assert.equal(upload.status, 201, upload.text);
    const assetId = JSON.parse(upload.text).id;

    const ownDownload = await api.raw(`/api/v1/projects/${projectId}/assets/${assetId}`, {
      jar: owner.jar,
    });
    assert.equal(ownDownload.status, 200);
    assert.equal(ownDownload.buffer.toString(), body.toString());
    assert.equal(
      (await api.raw(`/api/v1/projects/${projectId}/assets/${assetId}`, { jar: stranger.jar })).status,
      404
    );

    api.db
      .prepare("INSERT INTO project_members (project_id, account_id, role, created_at) VALUES (?, ?, 'viewer', ?)")
      .run(projectId, stranger.account.id, Date.now());
    assert.equal(
      (await api.raw(`/api/v1/projects/${projectId}/assets/${assetId}`, { jar: stranger.jar })).status,
      200
    );

    await api.call(`/api/v1/projects/${projectId}/public-sharing`, {
      method: "POST",
      jar: owner.jar,
      body: { enabled: true },
    });
    const allowed = await api.call(`/api/v1/projects/${projectId}/shares`, {
      method: "POST",
      jar: owner.jar,
      body: { scope: "project", permission: "view", downloadAllowed: true },
    });
    const allowedDownload = await api.raw(`/api/v1/share/${allowed.body.token}/assets/${assetId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(allowedDownload.status, 200);
    assert.equal(allowedDownload.buffer.toString(), body.toString());

    const denied = await api.call(`/api/v1/projects/${projectId}/shares`, {
      method: "POST",
      jar: owner.jar,
      body: { scope: "project", permission: "view", downloadAllowed: false },
    });
    const deniedDownload = await api.raw(`/api/v1/share/${denied.body.token}/assets/${assetId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(deniedDownload.status, 403);
  });

  await t.test("scoped API tokens authorize project access without a password", async () => {
    const user = await api.account(`token-${crypto.randomUUID()}@example.com`);
    const readToken = await api.call("/api/v1/account/tokens", {
      method: "POST",
      jar: user.jar,
      body: { name: "read only", scopes: ["projects:read"] },
    });
    assert.equal(readToken.status, 201);
    const readBearer = { Authorization: `Bearer ${readToken.body.token}` };
    const read = await api.call("/api/v1/projects", { headers: readBearer });
    assert.equal(read.status, 200);
    const deniedWrite = await api.call("/api/v1/projects", {
      method: "POST",
      headers: readBearer,
      body: { title: "Denied" },
    });
    assert.equal(deniedWrite.status, 403);
    assert.equal(deniedWrite.body.code, "insufficient_scope");

    const writeToken = await api.call("/api/v1/account/tokens", {
      method: "POST",
      jar: user.jar,
      body: { name: "writer", scopes: ["projects:read", "projects:write"] },
    });
    const writeBearer = { Authorization: `Bearer ${writeToken.body.token}` };
    const created = await api.call("/api/v1/projects", {
      method: "POST",
      headers: writeBearer,
      body: { title: "API project" },
    });
    assert.equal(created.status, 201);
    const listed = await api.call("/api/v1/account/tokens", { jar: user.jar });
    assert.ok(listed.body.tokens.some((token) => token.id === writeToken.body.id));
    const revoked = await api.call(`/api/v1/account/tokens/${writeToken.body.id}`, {
      method: "DELETE",
      jar: user.jar,
    });
    assert.equal(revoked.status, 204);
    assert.equal((await api.call("/api/v1/projects", { headers: writeBearer })).status, 401);
  });

  await t.test("refresh rotates and reuse revokes the session family", async () => {
    const user = await api.account(`refresh-${crypto.randomUUID()}@example.com`);
    const oldRefresh = user.jar.khaoyu_refresh;
    const first = await api.call("/api/v1/auth/refresh", { method: "POST", jar: user.jar });
    assert.equal(first.status, 200);
    assert.notEqual(user.jar.khaoyu_refresh, oldRefresh);
    const newRefresh = user.jar.khaoyu_refresh;

    const replayJar = { khaoyu_refresh: oldRefresh };
    const replay = await api.call("/api/v1/auth/refresh", { method: "POST", jar: replayJar });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.code, "refresh_reuse");

    const afterReplay = await api.call("/api/v1/auth/refresh", {
      method: "POST",
      jar: { khaoyu_refresh: newRefresh },
    });
    assert.equal(afterReplay.status, 401);
  });

  await t.test("sessions can be listed and revoked, and logout-all works", async () => {
    const user = await api.account(`sessions-${crypto.randomUUID()}@example.com`);
    const list = await api.call("/api/v1/auth/sessions", { jar: user.jar });
    assert.equal(list.status, 200);
    assert.equal(list.body.sessions.length, 1);
    assert.equal(list.body.sessions[0].current, true);
    const sessionId = list.body.sessions[0].id;
    const revoked = await api.call(`/api/v1/auth/sessions/${sessionId}`, {
      method: "DELETE",
      jar: user.jar,
    });
    assert.equal(revoked.status, 204);
    const after = await api.call("/api/v1/projects", { jar: user.jar });
    assert.equal(after.status, 401);

    const again = await api.login(user.email, user.password);
    assert.equal(again.status, 200);
    const all = await api.call("/api/v1/auth/logout-all", { method: "POST", jar: again.jar });
    assert.equal(all.status, 204);
    assert.equal((await api.call("/api/v1/projects", { jar: again.jar })).status, 401);
  });

  await t.test("password reset is single use and revokes old sessions", async () => {
    const user = await api.account(`reset-${crypto.randomUUID()}@example.com`);
    const request = await api.call("/api/v1/auth/password-reset/request", {
      method: "POST",
      body: { email: user.email },
    });
    assert.equal(request.status, 202);
    const token = api.latestMail("reset", user.email).text.match(/token: (\S+)/)[1];
    const confirmed = await api.call("/api/v1/auth/password-reset/confirm", {
      method: "POST",
      body: { token, password: "new-correct-horse-9" },
    });
    assert.equal(confirmed.status, 204);
    assert.equal((await api.call("/api/v1/projects", { jar: user.jar })).status, 401);
    assert.equal((await api.login(user.email, user.password)).status, 401);
    assert.equal((await api.login(user.email, "new-correct-horse-9")).status, 200);
    const reuse = await api.call("/api/v1/auth/password-reset/confirm", {
      method: "POST",
      body: { token, password: "another-horse-9" },
    });
    assert.equal(reuse.status, 400);
  });

  await t.test("TOTP can be enabled and is required at login", async () => {
    const user = await api.account(`totp-${crypto.randomUUID()}@example.com`);
    const setup = await api.call("/api/v1/auth/totp/setup", { method: "POST", jar: user.jar });
    assert.equal(setup.status, 200);
    const code = generateTotp(setup.body.secret);
    const enabled = await api.call("/api/v1/auth/totp/enable", {
      method: "POST",
      jar: user.jar,
      body: { code },
    });
    assert.equal(enabled.status, 204);
    await api.call("/api/v1/auth/logout", { method: "POST", jar: user.jar });
    assert.equal((await api.login(user.email, user.password)).status, 401);
    const withCode = await api.login(user.email, user.password, { totp: generateTotp(setup.body.secret) });
    assert.equal(withCode.status, 200);
  });

  await t.test("account deletion has a grace period and can be cancelled", async () => {
    const user = await api.account(`delete-${crypto.randomUUID()}@example.com`);
    const requested = await api.call("/api/v1/account/delete", {
      method: "POST",
      jar: user.jar,
      body: { password: user.password },
    });
    assert.equal(requested.status, 202);
    assert.equal((await api.call("/api/v1/account/export", { jar: user.jar })).status, 200);
    const cancelled = await api.call("/api/v1/account/delete/cancel", {
      method: "POST",
      jar: user.jar,
    });
    assert.equal(cancelled.status, 204);
    await api.call("/api/v1/account/delete", {
      method: "POST",
      jar: user.jar,
      body: { password: user.password },
    });
    api.db
      .prepare("UPDATE accounts SET deletion_due_at = ? WHERE id = ?")
      .run(Date.now() - 1000, user.account.id);
    runMaintenance(api.db, api.config, createLogger({ write() {} }));
    assert.equal(api.db.prepare("SELECT * FROM accounts WHERE id = ?").get(user.account.id), undefined);
    assert.equal((await api.call("/api/v1/account/export", { jar: user.jar })).status, 401);
  });
});
