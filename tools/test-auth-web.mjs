// End-to-end test for the local account layer of the localhost web host. It boots server.mjs on a
// temporary database and a free port, then drives setup, login, sessions, CSRF, author snapshots,
// history and the schema migration over HTTP.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
const tempDirs = [];
const children = [];

function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? "  ::  " + detail : ""}`);
}

function tempDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function spawnServer(dataDir, port, options = {}) {
  const child = spawn(process.execPath, [path.join(root, "server.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      KHAOYU_NOTE_DB_DIR: dataDir,
      KHAOYU_NOTE_BACKUP_DIR: path.join(dataDir, "backups"),
      KHAOYU_WEB_HOST: "127.0.0.1",
      KHAOYU_WEB_PORT: String(port),
    },
    stdio: options.quiet ? "ignore" : "inherit",
  });
  children.push(child);
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, exited };
}

async function startServer(dataDir) {
  const port = await freePort();
  const instance = spawnServer(dataDir, port);
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (instance.child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/status`);
      if (response.ok) return { ...instance, baseUrl };
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const exitCode = instance.child.exitCode;
  await stopServer(instance);
  throw new Error(`web server did not start (exit ${exitCode === null ? "still running" : exitCode})`);
}

async function stopServer(instance) {
  if (!instance) return;
  if (instance.child.exitCode === null) instance.child.kill();
  await Promise.race([instance.exited, new Promise((resolve) => setTimeout(resolve, 4000))]);
  if (instance.child.exitCode === null) {
    instance.child.kill("SIGKILL");
    await Promise.race([instance.exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}

function waitForExit(child, timeoutMs = 8000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function cookieJar() {
  return new Map();
}

function cookieHeader(cookies) {
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function storeCookies(cookies, response) {
  const lines =
    typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  for (const line of lines) {
    const [pair, ...attributes] = line.split(";");
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute))) cookies.delete(name);
    else cookies.set(name, value);
  }
  return lines;
}

async function api(instance, cookies, urlPath, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (cookies.size) headers.cookie = cookieHeader(cookies);
  if (options.csrf) headers["x-khaoyu-csrf"] = cookies.get("khaoyu_local_csrf") || "";
  const response = await fetch(`${instance.baseUrl}${urlPath}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "manual",
  });
  const setCookie = storeCookies(cookies, response);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body, setCookie };
}

function invoke(instance, cookies, cmd, args = {}, options = {}) {
  return api(instance, cookies, "/api/invoke", {
    method: "POST",
    body: { cmd, args },
    csrf: options.csrf !== false,
  });
}

function inspectSchema(dataDir) {
  const database = new DatabaseSync(path.join(dataDir, "khaoyu-note.db"));
  try {
    const version = database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    const boardColumns = database.prepare("PRAGMA table_info(boards)").all().map((row) => row.name);
    const cardColumns = database.prepare("PRAGMA table_info(cards)").all().map((row) => row.name);
    const userColumns = database.prepare("PRAGMA table_info(users)").all().map((row) => row.name);
    return { version, tables, boardColumns, cardColumns, userColumns };
  } finally {
    database.close();
  }
}

function inspectBackup(backupDirectory) {
  const database = new DatabaseSync(path.join(backupDirectory, "khaoyu-note.db"));
  try {
    const count = (table) => Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    return { sessions: count("sessions"), users: count("users"), activity: count("activity_log") };
  } finally {
    database.close();
  }
}

// A database written by schema 1 releases: it has the content tables but no accounts.
function makeSchemaOneDatabase(dataDir) {
  const database = new DatabaseSync(path.join(dataDir, "khaoyu-note.db"));
  database.exec(`
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE boards (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, parent_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  view TEXT NOT NULL, grid INTEGER NOT NULL, show_grid INTEGER NOT NULL,
  theme TEXT, archived_at INTEGER, trashed_at INTEGER, trash TEXT
);
CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  type TEXT NOT NULL, parent_id TEXT,
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
  z REAL NOT NULL, ord REAL NOT NULL, data TEXT NOT NULL
);
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  from_id TEXT NOT NULL, to_id TEXT NOT NULL, data TEXT
);
CREATE TABLE assets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL
);
INSERT INTO meta (key, value) VALUES ('schema_version', '1');
`);
  database.close();
}

function makeNewerSchemaDatabase(dataDir) {
  const database = new DatabaseSync(path.join(dataDir, "khaoyu-note.db"));
  database.exec(`
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta (key, value) VALUES ('schema_version', '4');
`);
  database.close();
}

let instance = null;
try {
  const dataDir = tempDirectory("khaoyu-auth-web-");
  instance = await startServer(dataDir);
  const cookies = cookieJar();

  const initial = await api(instance, cookies, "/api/auth/status");
  check(
    "status reports an empty account table",
    initial.status === 200 &&
      initial.body.userCount === 0 &&
      initial.body.requireLogin === true &&
      initial.body.guestAllowed === false &&
      initial.body.user === null &&
      initial.body.csrfToken === null,
    JSON.stringify(initial.body)
  );

  const shell = await fetch(`${instance.baseUrl}/`);
  const shellHtml = await shell.text();
  check(
    "the static app shell is still served with the web runtime",
    shell.status === 200 && shellHtml.includes("window.__KHAOYU_WEB__")
  );
  check(
    "the injected bridge sends the CSRF header on command calls",
    shellHtml.includes("x-khaoyu-csrf") && shellHtml.includes("/api/invoke")
  );
  const guestVersion = await invoke(instance, cookieJar(), "app_version", {}, { csrf: false });
  check(
    "commands require an account before setup",
    guestVersion.status === 401 && /sign in/i.test(guestVersion.body?.error || ""),
    JSON.stringify({ status: guestVersion.status, body: guestVersion.body })
  );

  const setupBody = {
    username: "Owner",
    email: "owner@example.com",
    firstName: "Dezuhan",
    lastName: "Pratama",
    password: "correct horse battery",
    claimBoards: true,
  };
  const setup = await api(instance, cookies, "/api/auth/setup", { method: "POST", body: setupBody });
  check(
    "setup creates the first admin",
    setup.status === 200 &&
      setup.body?.user?.role === "admin" &&
      setup.body.user.username === "owner" &&
      setup.body.user.email === "owner@example.com" &&
      setup.body.user.displayName === "Dezuhan Pratama",
    JSON.stringify(setup.body)
  );
  check(
    "setup returns a thirty day web session expiry",
    setup.status === 200 &&
      Number.isFinite(setup.body.expiresAt) &&
      setup.body.expiresAt > Date.now() + 29 * 24 * 60 * 60 * 1000,
    String(setup.body?.expiresAt)
  );
  const sessionCookieLine =
    setup.setCookie.find((line) => line.startsWith("khaoyu_local_session=")) || "";
  const csrfCookieLine = setup.setCookie.find((line) => line.startsWith("khaoyu_local_csrf=")) || "";
  check(
    "the session cookie is HttpOnly and SameSite=Strict",
    /HttpOnly/i.test(sessionCookieLine) && /SameSite=Strict/.test(sessionCookieLine),
    sessionCookieLine
  );
  check(
    "the CSRF cookie is script readable and SameSite=Strict",
    csrfCookieLine.length > 0 && !/HttpOnly/i.test(csrfCookieLine) && /SameSite=Strict/.test(csrfCookieLine),
    csrfCookieLine
  );

  const duplicate = await api(instance, cookies, "/api/auth/setup", { method: "POST", body: setupBody });
  check(
    "a second setup is rejected",
    duplicate.status === 409 && /already/i.test(duplicate.body?.error || ""),
    JSON.stringify(duplicate.body)
  );

  const signedIn = await api(instance, cookies, "/api/auth/status");
  check(
    "status reports the signed-in account and its CSRF token",
    signedIn.status === 200 &&
      signedIn.body.userCount === 1 &&
      signedIn.body.user?.username === "owner" &&
      signedIn.body.csrfToken === cookies.get("khaoyu_local_csrf"),
    JSON.stringify(signedIn.body)
  );

  const me = await api(instance, cookies, "/api/auth/me");
  check("me returns the current account", me.status === 200 && me.body?.id === setup.body.user.id);

  const shareInfo = await api(instance, cookies, "/api/share-info");
  check(
    "share info returns full host URLs for board links",
    shareInfo.status === 200 &&
      Array.isArray(shareInfo.body?.urls) &&
      shareInfo.body.urls.includes(instance.baseUrl) &&
      shareInfo.body.boardPath === "/?board=",
    JSON.stringify(shareInfo.body)
  );

  const profile = await api(instance, cookies, "/api/auth/profile", {
    method: "PATCH",
    csrf: true,
    body: {
      firstName: "Dezuhan",
      lastName: "Pratama",
      email: "dezuhan@example.com",
      avatarColor: "#B262C0",
    },
  });
  check(
    "profile changes are stored",
    profile.status === 200 &&
      profile.body.email === "dezuhan@example.com" &&
      profile.body.avatarColor === "#B262C0" &&
      profile.body.displayName === "Dezuhan Pratama",
    JSON.stringify(profile.body)
  );

  const avatarData =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
  const avatarProfile = await api(instance, cookies, "/api/auth/profile", {
    method: "PATCH",
    csrf: true,
    body: { avatarUrl: avatarData },
  });
  check(
    "profile avatar is stored as a data URL",
    avatarProfile.status === 200 && avatarProfile.body.avatarUrl === avatarData,
    JSON.stringify({ status: avatarProfile.status })
  );
  const clearedAvatar = await api(instance, cookies, "/api/auth/profile", {
    method: "PATCH",
    csrf: true,
    body: { avatarUrl: "" },
  });
  check(
    "profile avatar can be removed",
    clearedAvatar.status === 200 && clearedAvatar.body.avatarUrl === "",
    JSON.stringify({ status: clearedAvatar.status })
  );

  const blockedProfile = await api(instance, cookies, "/api/auth/profile", {
    method: "PATCH",
    body: { firstName: "Nope" },
  });
  check(
    "profile changes without CSRF are rejected",
    blockedProfile.status === 403 && /csrf/i.test(blockedProfile.body?.error || ""),
    JSON.stringify(blockedProfile.body)
  );
  const blockedSave = await invoke(
    instance,
    cookies,
    "save_board",
    { id: "blocked-board", data: JSON.stringify({ id: "blocked-board", title: "no" }) },
    { csrf: false }
  );
  check(
    "board saves without CSRF are rejected",
    blockedSave.status === 403 && /csrf/i.test(blockedSave.body?.error || ""),
    JSON.stringify(blockedSave.body)
  );

  const boardId = "board-auth-web";
  const boardDoc = {
    id: boardId,
    title: "Auth board",
    parentId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    view: { x: 0, y: 0, zoom: 1 },
    grid: 24,
    showGrid: true,
    theme: null,
    cards: [
      {
        id: "card-auth-web",
        type: "note",
        x: 20,
        y: 20,
        w: 240,
        h: 70,
        z: 1,
        order: 0,
        text: "signed in",
      },
    ],
    connections: [],
    trash: [],
  };
  const saved = await invoke(instance, cookies, "save_board", {
    id: boardId,
    data: JSON.stringify(boardDoc),
  });
  check(
    "an authenticated save succeeds",
    saved.status === 200 && !saved.body?.error && Number.isFinite(saved.body?.result),
    JSON.stringify(saved.body)
  );

  const loaded = await invoke(instance, cookies, "load_board", { id: boardId });
  const loadedDoc = loaded.body?.result ? JSON.parse(loaded.body.result) : null;
  check(
    "reads expose board and card author snapshots",
    loadedDoc?.createdBy?.source === "local" &&
      loadedDoc.createdBy.id === setup.body.user.id &&
      loadedDoc.createdBy.name === "Dezuhan Pratama" &&
      loadedDoc.updatedBy?.id === setup.body.user.id &&
      loadedDoc.cards?.[0]?.createdBy?.id === setup.body.user.id &&
      loadedDoc.cards?.[0]?.updatedBy?.source === "local",
    JSON.stringify({
      boardCreatedBy: loadedDoc?.createdBy,
      cardCreatedBy: loadedDoc?.cards?.[0]?.createdBy,
    })
  );

  const changed = await api(instance, cookies, "/api/auth/password", {
    method: "POST",
    csrf: true,
    body: { currentPassword: "correct horse battery", newPassword: "an even better password" },
  });
  check(
    "the password can be changed",
    changed.status === 200 && changed.body === null,
    JSON.stringify(changed.body)
  );

  const loggedOut = await api(instance, cookies, "/api/auth/logout", { method: "POST" });
  check(
    "logout clears the session cookies",
    loggedOut.status === 200 &&
      loggedOut.body === null &&
      !cookies.has("khaoyu_local_session") &&
      !cookies.has("khaoyu_local_csrf"),
    JSON.stringify(loggedOut.body)
  );

  check(
    "the session cookie carries a thirty day Max-Age",
    /Max-Age=2592000/.test(sessionCookieLine),
    sessionCookieLine
  );

  loadedDoc.updatedAt = loadedDoc.updatedAt + 1000;
  const guestSave = await invoke(
    instance,
    cookies,
    "save_board",
    { id: boardId, data: JSON.stringify(loadedDoc) },
    { csrf: false }
  );
  check(
    "a signed-out client cannot save",
    guestSave.status === 401 && /sign in/i.test(guestSave.body?.error || ""),
    JSON.stringify({ status: guestSave.status, body: guestSave.body })
  );
  const guestLoaded = await invoke(instance, cookies, "load_board", { id: boardId }, { csrf: false });
  check(
    "a signed-out client cannot read a board",
    guestLoaded.status === 401 && /sign in/i.test(guestLoaded.body?.error || ""),
    JSON.stringify({ status: guestLoaded.status, body: guestLoaded.body })
  );

  const wrongPassword = await api(instance, cookies, "/api/auth/login", {
    method: "POST",
    body: { identifier: "owner", password: "definitely wrong" },
  });
  check(
    "a wrong password returns the generic error",
    wrongPassword.status === 401 && wrongPassword.body?.error === "Invalid username or password",
    JSON.stringify(wrongPassword.body)
  );

  const oldPassword = await api(instance, cookies, "/api/auth/login", {
    method: "POST",
    body: { identifier: "owner", password: "correct horse battery" },
  });
  check(
    "the old password no longer works",
    oldPassword.status === 401 && oldPassword.body?.error === "Invalid username or password",
    JSON.stringify(oldPassword.body)
  );

  const relogin = await api(instance, cookies, "/api/auth/login", {
    method: "POST",
    body: { identifier: "dezuhan@example.com", password: "an even better password" },
  });
  check(
    "login accepts an email and the new password",
    relogin.status === 200 && relogin.body?.user?.id === setup.body.user.id,
    JSON.stringify(relogin.body)
  );

  const backup = await invoke(instance, cookies, "backup_data");
  const backupPath = backup.body?.result;
  const backupState =
    typeof backupPath === "string" && fs.existsSync(backupPath) ? inspectBackup(backupPath) : null;
  check(
    "a backup keeps accounts and activity but no live sessions",
    backup.status === 200 &&
      backupState !== null &&
      backupState.users === 1 &&
      backupState.activity > 0 &&
      backupState.sessions === 0,
    `${backupPath} :: ${JSON.stringify(backupState)}`
  );

  const history = await api(instance, cookies, "/api/auth/history?limit=50&offset=0");
  const actions = Array.isArray(history.body?.entries)
    ? history.body.entries.map((entry) => entry.action)
    : [];
  check(
    "history returns the account activity",
    history.status === 200 &&
      actions.includes("auth.setup") &&
      actions.includes("auth.profile_updated") &&
      actions.includes("auth.password_changed") &&
      actions.includes("auth.login") &&
      actions.includes("auth.logout"),
    JSON.stringify(actions)
  );
  const newestFirst =
    history.body?.entries?.length > 1 &&
    history.body.entries[0].createdAt >= history.body.entries[history.body.entries.length - 1].createdAt;
  check(
    "history entries use the shared shape and are newest first",
    history.body?.hasMore === false &&
      history.body.entries.every(
        (entry) =>
          typeof entry.id === "string" &&
          typeof entry.action === "string" &&
          typeof entry.createdAt === "number"
      ) &&
      newestFirst
  );
  const page = await api(instance, cookies, "/api/auth/history?limit=2");
  check(
    "history pagination reports hasMore",
    page.status === 200 && page.body.entries.length === 2 && page.body.hasMore === true,
    JSON.stringify(page.body)
  );

  const secondJar = cookieJar();
  const secondLogin = await api(instance, secondJar, "/api/auth/login", {
    method: "POST",
    body: { identifier: "owner", password: "an even better password" },
  });
  check("a second web session can sign in", secondLogin.status === 200);
  const revokeAll = await api(instance, cookies, "/api/auth/logout-all", { method: "POST", csrf: true });
  check(
    "logout all revokes every session",
    revokeAll.status === 200 && revokeAll.body === null,
    JSON.stringify(revokeAll.body)
  );
  const secondMe = await api(instance, secondJar, "/api/auth/me");
  check("the other session is revoked", secondMe.status === 200 && secondMe.body === null);

  const ghostJar = cookieJar();
  const ghostStatuses = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await api(instance, ghostJar, "/api/auth/login", {
      method: "POST",
      body: { identifier: "ghost", password: "not the password" },
    });
    ghostStatuses.push(response.status);
  }
  const limited = await api(instance, ghostJar, "/api/auth/login", {
    method: "POST",
    body: { identifier: "ghost", password: "not the password" },
  });
  check(
    "five failed logins are rejected generically",
    ghostStatuses.length === 5 && ghostStatuses.every((status) => status === 401),
    JSON.stringify(ghostStatuses)
  );
  check(
    "the next failed login is rate limited",
    limited.status === 429 && /too many/i.test(limited.body?.error || ""),
    JSON.stringify(limited.body)
  );

  const resetJar = cookieJar();
  const resetLogin = await api(instance, resetJar, "/api/auth/login", {
    method: "POST",
    body: { identifier: "owner", password: "an even better password" },
  });
  const reset = await api(instance, resetJar, "/api/auth/reset", {
    method: "POST",
    csrf: true,
    body: { password: "an even better password", confirmation: "DELETE ALL" },
  });
  check("the local database can be reset after re-authentication", reset.status === 200 && reset.body?.reset === true);
  const resetStatus = await api(instance, cookieJar(), "/api/auth/status");
  check(
    "a reset database returns to first-run setup",
    resetLogin.status === 200 && resetStatus.status === 200 && resetStatus.body?.userCount === 0,
    JSON.stringify(resetStatus.body)
  );

  await stopServer(instance);
  instance = null;
  const schema = inspectSchema(dataDir);
  check("the database is migrated to schema 3", schema.version === "3", String(schema.version));
  check(
    "the auth tables and author columns exist",
    ["users", "sessions", "activity_log"].every((name) => schema.tables.includes(name)) &&
      schema.boardColumns.includes("created_by") &&
      schema.boardColumns.includes("updated_by") &&
      schema.cardColumns.includes("created_by") &&
      schema.cardColumns.includes("updated_by") &&
      schema.userColumns.includes("avatar_url")
  );

  const upgradeDir = tempDirectory("khaoyu-auth-upgrade-");
  makeSchemaOneDatabase(upgradeDir);
  let upgradeServer = await startServer(upgradeDir);
  const upgradeStatus = await api(upgradeServer, cookieJar(), "/api/auth/status");
  check(
    "a schema 1 database starts with no accounts",
    upgradeStatus.status === 200 && upgradeStatus.body.userCount === 0
  );
  await stopServer(upgradeServer);
  upgradeServer = null;
  const upgradedSchema = inspectSchema(upgradeDir);
  check(
    "a schema 1 database is migrated to schema 3",
    upgradedSchema.version === "3" && upgradedSchema.tables.includes("users"),
    String(upgradedSchema.version)
  );
  let restarted = await startServer(upgradeDir);
  const restartedStatus = await api(restarted, cookieJar(), "/api/auth/status");
  check("reopening a migrated database is idempotent", restartedStatus.status === 200);
  await stopServer(restarted);
  restarted = null;

  const newerDir = tempDirectory("khaoyu-auth-newer-");
  makeNewerSchemaDatabase(newerDir);
  // The expected schema rejection writes to stderr, so keep this child quiet.
  const newer = spawnServer(newerDir, await freePort(), { quiet: true });
  const newerExitCode = await waitForExit(newer.child);
  check(
    "a newer database schema is rejected",
    newerExitCode !== null && newerExitCode !== 0,
    `exit ${newerExitCode}`
  );
  if (newer.child.exitCode === null) await stopServer(newer);
} finally {
  await stopServer(instance);
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const directory of tempDirs) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      /* Windows may hold the WAL briefly */
    }
  }
}

const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
