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
    trustProxy: false,
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
    register,
    verify,
    login,
    account,
    latestMail,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

test("account, login, refresh, session, reset and authorization flows", async (t) => {
  const api = await start();
  t.after(() => api.close());

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
    assert.ok(Number(blocked.response.headers.get("retry-after")) >= 1);
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
