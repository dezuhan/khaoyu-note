import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { createLogger } from "../src/logger.mjs";
import { openDatabase, migrate, MIGRATIONS_DIR } from "../src/db.mjs";
import { createFileMailer } from "../src/auth/mailer.mjs";
import { createService } from "../src/app.mjs";

const SECRET = "Kx9-vQ2m-Rt7-pL4s-Wb8-nC3d-Hf6-jZ1a";
const PASSWORD = "correct-horse-9";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "khaoyu-admin-"));
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
    ssoEnabled: false,
    ssoSecret: "Sso-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    ssoHeader: "x-auth-request-email",
    ssoNameHeader: "x-auth-request-name",
    ssoAutoCreate: false,
    trustProxy: false,
    passkeysEnabled: false,
    rpId: "localhost",
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
  for (const cookie of response.headers.getSetCookie?.() || []) {
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

  async function call(pathname, { method = "GET", body, jar, csrf = true } = {}) {
    const headers = {};
    if (jar && Object.keys(jar).length) headers.Cookie = cookieHeader(jar);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (jar?.khaoyu_csrf && csrf) headers["x-csrf-token"] = jar.khaoyu_csrf;
    const response = await fetch(base + pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    if (jar) absorbCookies(jar, response);
    let payload = null;
    const text = await response.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    return { status: response.status, body: payload, response };
  }

  async function register(email) {
    return call("/api/v1/auth/register", {
      method: "POST",
      body: { email, password: PASSWORD, displayName: email.split("@")[0] },
    });
  }

  async function login(email) {
    const jar = {};
    const result = await call("/api/v1/auth/login", {
      method: "POST",
      body: { email, password: PASSWORD },
      jar,
    });
    return { ...result, jar };
  }

  return { call, register, login, db, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("service admin dashboard API", async (t) => {
  const api = await start();
  t.after(() => api.close());

  await t.test("the admin page and its assets are served", async () => {
    const page = await api.call("/admin");
    assert.equal(page.status, 200);
    assert.match(page.body, /admin\.js/);
    const script = await api.call("/admin.js");
    assert.equal(script.status, 200);
    const style = await api.call("/admin.css");
    assert.equal(style.status, 200);
    for (const [route, marker] of [
      ["/", "login-form"],
      ["/login", "login-form"],
      ["/register", "register-form"],
      ["/reset", "reset-form"],
    ]) {
      const response = await api.call(route);
      assert.equal(response.status, 200, route);
      assert.match(response.body, new RegExp(marker), route);
    }
    for (const asset of ["/auth.css", "/auth-common.js", "/login.js", "/register.js", "/reset.js", "/vendor/qrcode.js"]) {
      assert.equal((await api.call(asset)).status, 200, asset);
    }
    const accountPage = await api.call("/account");
    assert.equal(accountPage.status, 302);
    assert.equal(accountPage.response.headers.get("location"), "/admin#profile");
  });

  const registered = await api.register("admin@example.com");
  assert.equal(registered.status, 202);
  const admin = await api.login("admin@example.com");
  assert.equal(admin.status, 200, JSON.stringify(admin.body));
  assert.ok(admin.jar.khaoyu_access);

  await t.test("the first account is an admin and sees the dashboard", async () => {
    const dashboard = await api.call("/api/v1/admin/dashboard", { jar: admin.jar });
    assert.equal(dashboard.status, 200, JSON.stringify(dashboard.body));
    assert.equal(dashboard.body.admin.email, "admin@example.com");
    assert.equal(dashboard.body.counts.accounts, 1);
    const users = await api.call("/api/v1/admin/users", { jar: admin.jar });
    assert.equal(users.status, 200);
    assert.equal(users.body.users[0].role, "admin");
  });

  await t.test("a member is rejected from admin routes", async () => {
    await api.register("member@example.com");
    const member = await api.login("member@example.com");
    assert.equal(member.status, 200);
    const denied = await api.call("/api/v1/admin/dashboard", { jar: member.jar });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, "admin_required");
  });

  await t.test("an admin can add a member account manually like signup", async () => {
    const email = `manual-${crypto.randomUUID()}@example.com`;
    const created = await api.call("/api/v1/admin/users", {
      method: "POST",
      jar: admin.jar,
      body: { email, password: PASSWORD, displayName: "Manual Member", role: "member" },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.user.email, email);
    assert.equal(created.body.user.role, "member");
    const duplicate = await api.call("/api/v1/admin/users", {
      method: "POST",
      jar: admin.jar,
      body: { email, password: PASSWORD, displayName: "Duplicate", role: "member" },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, "email_taken");
    const weak = await api.call("/api/v1/admin/users", {
      method: "POST",
      jar: admin.jar,
      body: { email: `weak-${crypto.randomUUID()}@example.com`, password: "short" },
    });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.code, "weak_password");
    const login = await api.login(email);
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.equal(login.body.account.role, "member");
    const activity = await api.call("/api/v1/admin/activity?limit=20", { jar: admin.jar });
    assert.ok(activity.body.entries.some((entry) => entry.action === "admin.user_created"));
  });

  await t.test("account management exposes account, security, board and session detail", async () => {
    const detail = await api.call(`/api/v1/admin/users/${admin.body.account.id}`, { jar: admin.jar });
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.user.email, admin.body.account.email);
    assert.equal(detail.body.security.totpEnabled, false);
    assert.equal(detail.body.security.emailVerified, true);
    assert.ok(Array.isArray(detail.body.projects));
    assert.ok(detail.body.sessions.length > 0);
  });

  await t.test("teams can be created and listed with members", async () => {
    const created = await api.call("/api/v1/admin/teams", {
      method: "POST",
      jar: admin.jar,
      body: { name: "Design team" },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const teams = await api.call("/api/v1/admin/teams", { jar: admin.jar });
    assert.equal(teams.status, 200);
    assert.equal(teams.body.total, 1);
    assert.equal(teams.body.teams[0].name, "Design team");
    assert.equal(teams.body.teams[0].member_count, 1);
    const boards = await api.call("/api/v1/admin/boards", { jar: admin.jar });
    assert.equal(boards.status, 200);
    assert.equal(boards.body.total, 1);
    assert.equal(boards.body.boards[0].name, "Design team");
    const members = await api.call(`/api/v1/admin/teams/${created.body.id}/members`, {
      jar: admin.jar,
    });
    assert.equal(members.status, 200);
    assert.equal(members.body.members[0].role, "owner");
  });

  await t.test("teams support update and delete, and admins manage members manually", async () => {
    const created = await api.call("/api/v1/admin/teams", {
      method: "POST",
      jar: admin.jar,
      body: { name: "Operations team" },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    await api.register("teammate@example.com");
    const added = await api.call(`/api/v1/admin/teams/${created.body.id}/members`, {
      method: "POST",
      jar: admin.jar,
      body: { email: "teammate@example.com", role: "editor" },
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.member.role, "editor");
    const duplicate = await api.call(`/api/v1/admin/teams/${created.body.id}/members`, {
      method: "POST",
      jar: admin.jar,
      body: { email: "teammate@example.com", role: "viewer" },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, "already_member");

    const members = await api.call(`/api/v1/admin/teams/${created.body.id}/members`, { jar: admin.jar });
    assert.equal(members.body.members.length, 2);
    const teammate = members.body.members.find((member) => member.email === "teammate@example.com");
    const owner = members.body.members.find((member) => member.role === "owner");
    assert.ok(teammate && owner);

    const updated = await api.call(
      `/api/v1/admin/teams/${created.body.id}/members/${teammate.id}`,
      { method: "PATCH", jar: admin.jar, body: { role: "viewer" } }
    );
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.role, "viewer");
    const ownerEdit = await api.call(
      `/api/v1/admin/teams/${created.body.id}/members/${owner.id}`,
      { method: "PATCH", jar: admin.jar, body: { role: "viewer" } }
    );
    assert.equal(ownerEdit.status, 400);
    assert.equal(ownerEdit.body.code, "owner_immutable");

    const renamed = await api.call(`/api/v1/admin/teams/${created.body.id}`, {
      method: "PATCH",
      jar: admin.jar,
      body: { name: "Operations renamed" },
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.name, "Operations renamed");

    const member = await api.login("member@example.com");
    const deniedAdd = await api.call(`/api/v1/admin/teams/${created.body.id}/members`, {
      method: "POST",
      jar: member.jar,
      body: { email: "admin@example.com", role: "viewer" },
    });
    assert.equal(deniedAdd.status, 403);
    assert.equal(deniedAdd.body.code, "admin_required");

    const removed = await api.call(
      `/api/v1/admin/teams/${created.body.id}/members/${teammate.id}`,
      { method: "DELETE", jar: admin.jar }
    );
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    const afterRemove = await api.call(`/api/v1/admin/teams/${created.body.id}/members`, { jar: admin.jar });
    assert.equal(afterRemove.body.members.length, 1);
    const ownerRemove = await api.call(
      `/api/v1/admin/teams/${created.body.id}/members/${owner.id}`,
      { method: "DELETE", jar: admin.jar }
    );
    assert.equal(ownerRemove.status, 400);

    const deleted = await api.call(`/api/v1/admin/teams/${created.body.id}`, {
      method: "DELETE",
      jar: admin.jar,
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(deleted.body.deleted, true);
    const teams = await api.call("/api/v1/admin/teams", { jar: admin.jar });
    assert.equal(teams.body.teams.some((team) => team.id === created.body.id), false);
    const activity = await api.call("/api/v1/admin/activity?limit=40", { jar: admin.jar });
    for (const action of [
      "admin.team_member_added",
      "admin.team_member_updated",
      "admin.team_member_removed",
      "admin.team_updated",
      "admin.team_deleted",
    ]) {
      assert.ok(activity.body.entries.some((entry) => entry.action === action), action);
    }
  });

  await t.test("role and status changes are audited and enforce the last admin", async () => {
    const self = await api.call(`/api/v1/admin/users/${admin.body.account.id}`, {
      method: "PATCH",
      jar: admin.jar,
      body: { role: "member" },
    });
    assert.equal(self.status, 400);
    assert.equal(self.body.code, "self_lockout");

    const users = await api.call("/api/v1/admin/users", { jar: admin.jar });
    const member = users.body.users.find((user) => user.email === "member@example.com");
    const promoted = await api.call(`/api/v1/admin/users/${member.id}`, {
      method: "PATCH",
      jar: admin.jar,
      body: { role: "admin" },
    });
    assert.equal(promoted.status, 200);
    assert.equal(promoted.body.user.role, "admin");
    const activity = await api.call("/api/v1/admin/activity?limit=20", { jar: admin.jar });
    assert.equal(activity.status, 200);
    assert.ok(activity.body.entries.some((entry) => entry.action === "admin.user_updated"));
    assert.ok(activity.body.entries.some((entry) => entry.action === "admin.team_created"));
  });

  await t.test("mutations require the CSRF header", async () => {
    const blocked = await api.call("/api/v1/admin/teams", {
      method: "POST",
      jar: admin.jar,
      body: { name: "No csrf" },
      csrf: false,
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, "csrf_failed");
  });

  await t.test("a disabled account cannot sign in", async () => {
    const users = await api.call("/api/v1/admin/users", { jar: admin.jar });
    const member = users.body.users.find((user) => user.email === "member@example.com");
    const disabled = await api.call(`/api/v1/admin/users/${member.id}`, {
      method: "PATCH",
      jar: admin.jar,
      body: { status: "disabled" },
    });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.user.status, "disabled");
    const login = await api.login("member@example.com");
    assert.equal(login.status, 401);
  });

  await t.test("password reset works without an email token", async () => {
    await api.register("reset@example.com");
    const updated = await api.call("/api/v1/auth/reset-password", {
      method: "POST",
      body: {
        email: "reset@example.com",
        currentPassword: PASSWORD,
        newPassword: "new-horse-battery-9",
      },
    });
    assert.equal(updated.status, 204, JSON.stringify(updated.body));
    const oldPassword = await api.login("reset@example.com");
    assert.equal(oldPassword.status, 401);
    const newPassword = await api.call("/api/v1/auth/login", {
      method: "POST",
      body: { email: "reset@example.com", password: "new-horse-battery-9" },
    });
    assert.equal(newPassword.status, 200, JSON.stringify(newPassword.body));
  });

  await t.test("the dashboard can change its own password", async () => {
    const changed = await api.call("/api/v1/account/password", {
      method: "POST",
      jar: admin.jar,
      body: { currentPassword: PASSWORD, newPassword: "admin-horse-battery-9" },
    });
    assert.equal(changed.status, 204, JSON.stringify(changed.body));
    const dashboard = await api.call("/api/v1/admin/dashboard", { jar: admin.jar });
    assert.equal(dashboard.status, 200);
    const newLogin = await api.call("/api/v1/auth/login", {
      method: "POST",
      body: { email: "admin@example.com", password: "admin-horse-battery-9" },
    });
    assert.equal(newLogin.status, 200);
  });
});
