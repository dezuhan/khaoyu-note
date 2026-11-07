// Local web host for Khaoyu Note. Serves the same frontend and backs it with the same SQLite
// database and asset folder the desktop app uses, over a small JSON command bridge.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { zipSync } from "fflate";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(ROOT, "app", "web");
const HOST = process.env.KHAOYU_WEB_HOST || "127.0.0.1";
const PORT = Number(process.env.KHAOYU_WEB_PORT || process.env.PORT || 1430);
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const DB_FILE = "khaoyu-note.db";
const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const UPDATE_REPO = "dezuhan/khaoyu-note";
const BLOCKED_EXTENSIONS = new Set([
  "exe", "msi", "bat", "cmd", "ps1", "scr", "com", "dll", "jar", "vbs", "js", "lnk",
]);
const CURRENT_SCHEMA_VERSION = 2;
const PASSWORD_SCHEME = "pbkdf2-sha256";
const PASSWORD_ITERATIONS = 600000;
const PASSWORD_KEY_BYTES = 32;
const SESSION_TOKEN_BYTES = 32;
const WEB_SESSION_MS = 12 * 60 * 60 * 1000;
const SESSION_COOKIE = "khaoyu_local_session";
const CSRF_COOKIE = "khaoyu_local_csrf";
const CSRF_HEADER = "x-khaoyu-csrf";
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_FAILURES = 5;
const HISTORY_PAGE_SIZE = 20;
const HISTORY_MAX_PAGE_SIZE = 100;

function defaultDataDir() {
  if (process.env.APPDATA) return path.join(process.env.APPDATA, "com.dezuhan.khaoyunote");
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "com.dezuhan.khaoyunote");
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "com.dezuhan.khaoyunote");
}

const DATA_DIR = process.env.KHAOYU_NOTE_DB_DIR || defaultDataDir();
const DB_PATH = path.join(DATA_DIR, DB_FILE);
const ASSETS_DIR = path.join(DATA_DIR, "assets");
const BACKUP_DIR =
  process.env.KHAOYU_NOTE_BACKUP_DIR ||
  path.join(os.homedir(), "Documents", "Khaoyu Note Backups");
fs.mkdirSync(ASSETS_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
db.exec(`
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, parent_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  view TEXT NOT NULL, grid INTEGER NOT NULL, show_grid INTEGER NOT NULL,
  theme TEXT, archived_at INTEGER, trashed_at INTEGER, trash TEXT,
  created_by TEXT, updated_by TEXT
);
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  type TEXT NOT NULL, parent_id TEXT,
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
  z REAL NOT NULL, ord REAL NOT NULL, data TEXT NOT NULL,
  created_by TEXT, updated_by TEXT
);
CREATE INDEX IF NOT EXISTS cards_board ON cards(board_id);
CREATE INDEX IF NOT EXISTS cards_parent ON cards(parent_id);
CREATE INDEX IF NOT EXISTS boards_parent ON boards(parent_id);
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  from_id TEXT NOT NULL, to_id TEXT NOT NULL, data TEXT
);
CREATE INDEX IF NOT EXISTS connections_board ON connections(board_id);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT UNIQUE COLLATE NOCASE,
  first_name TEXT,
  last_name TEXT,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  member_role TEXT NOT NULL DEFAULT 'editor' CHECK (member_role IN ('editor', 'commenter', 'viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  avatar_color TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT,
  host TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  actor_source TEXT,
  actor_name TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_actor ON activity_log(actor_user_id, created_at);
CREATE INDEX IF NOT EXISTS activity_created ON activity_log(created_at);
`);

// Schema 2 added the auth tables and the author columns. Existing databases only need the columns;
// the CREATE statements above already cover tables.
function tableColumns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function ensureColumn(table, column, definition) {
  if (!tableColumns(table).includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("boards", "created_by", "TEXT");
ensureColumn("boards", "updated_by", "TEXT");
ensureColumn("cards", "created_by", "TEXT");
ensureColumn("cards", "updated_by", "TEXT");

// Older desktop builds wrote seconds. Keep both hosts reading the same scale.
for (const [table, column] of [
  ["boards", "created_at"], ["boards", "updated_at"], ["boards", "archived_at"],
  ["boards", "trashed_at"], ["assets", "created_at"],
]) {
  db.exec(
    `UPDATE ${table} SET ${column} = ${column} * 1000
     WHERE ${column} IS NOT NULL AND ${column} > 0 AND ${column} < 100000000000`
  );
}

const schemaRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
const storedSchemaVersion = Number.parseInt(schemaRow?.value || "0", 10) || 0;
if (storedSchemaVersion > CURRENT_SCHEMA_VERSION) {
  throw new Error(
    `Database schema ${storedSchemaVersion} is newer than this app supports (${CURRENT_SCHEMA_VERSION})`
  );
}
db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
  String(CURRENT_SCHEMA_VERSION)
);

const startedAt = Date.now();
const webInfo = {
  mode: "web",
  host: HOST,
  port: PORT,
  url: `http://${HOST}:${PORT}`,
  database: DB_PATH,
  assets: ASSETS_DIR,
  version: VERSION,
};

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// Local accounts. Password hashes use the same format as the desktop app:
// pbkdf2-sha256$<iterations>$<salt_base64url>$<hash_base64url>.
class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function secureEqual(left, right) {
  const first = Buffer.from(String(left));
  const second = Buffer.from(String(right));
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, PASSWORD_KEY_BYTES, "sha256");
  return [
    PASSWORD_SCHEME,
    String(PASSWORD_ITERATIONS),
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

function verifyPassword(password, encoded) {
  const parts = String(encoded || "").split("$");
  if (parts.length !== 4 || parts[0] !== PASSWORD_SCHEME) return false;
  const iterations = Number.parseInt(parts[1], 10);
  if (!Number.isSafeInteger(iterations) || iterations <= 0) return false;
  let salt = null;
  let expected = null;
  try {
    salt = Buffer.from(parts[2], "base64url");
    expected = Buffer.from(parts[3], "base64url");
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;
  const derived = crypto.pbkdf2Sync(String(password), salt, iterations, expected.length, "sha256");
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

// Verifying a throwaway hash for unknown accounts keeps the login timing flat.
let dummyPasswordHashCache = null;
function dummyPasswordHash() {
  if (!dummyPasswordHashCache) dummyPasswordHashCache = hashPassword("khaoyu-note-dummy-password");
  return dummyPasswordHashCache;
}

function displayName(firstName, lastName, username) {
  const joined = `${String(firstName || "").trim()} ${String(lastName || "").trim()}`.trim();
  return joined || String(username);
}

function validateUsername(username) {
  const value = String(username || "");
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(value)) {
    throw new RequestError(
      "Username must be 3 to 32 characters using letters, numbers, dots, underscores or hyphens",
      400
    );
  }
}

function validateEmail(email) {
  const value = String(email || "").trim();
  const at = value.indexOf("@");
  const local = at > 0 ? value.slice(0, at) : "";
  const domain = at > 0 ? value.slice(at + 1) : "";
  if (
    !local ||
    !domain ||
    /\s/.test(value) ||
    value.length > 254
  ) {
    throw new RequestError("Enter a valid email address", 400);
  }
}

function validatePassword(password) {
  const value = String(password || "");
  if (value.length < 12) throw new RequestError("Password must be at least 12 characters", 400);
  if (value.length > 200) throw new RequestError("Password is too long", 400);
}

function validateNameFields(firstName, lastName) {
  const first = String(firstName || "").trim();
  if (!first || first.length > 80) throw new RequestError("First name is required", 400);
  if (String(lastName || "").trim().length > 80) {
    throw new RequestError("Last name is too long", 400);
  }
}

function validateAvatarColor(avatarColor) {
  if (avatarColor === null || avatarColor === undefined || avatarColor === "") return "";
  const value = String(avatarColor).trim();
  if (!/^#[0-9A-Fa-f]{6}$/.test(value)) {
    throw new RequestError("Avatar color must be a hex color", 400);
  }
  return value;
}

const USER_COLUMNS =
  "id, username, email, first_name, last_name, display_name, role, member_role, status, avatar_color, created_at, updated_at, last_login_at";

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email ?? "",
    firstName: row.first_name ?? "",
    lastName: row.last_name ?? "",
    displayName: row.display_name,
    role: row.role,
    memberRole: row.member_role,
    status: row.status,
    avatarColor: row.avatar_color ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at ?? null,
  };
}

function userRowById(id) {
  return db.prepare(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE id = ?`).get(id) ?? null;
}

function userRowByIdentifier(identifier) {
  const value = String(identifier || "").trim().toLowerCase();
  if (!value) return null;
  return (
    db
      .prepare(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE username = ? OR email = ? LIMIT 1`)
      .get(value, value) ?? null
  );
}

function countUsers() {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM users").get().count);
}

function insertUser({ username, email, firstName, lastName, password, role }) {
  validateUsername(username);
  validateEmail(email);
  validatePassword(password);
  validateNameFields(firstName, lastName);
  const id = `u_${crypto.randomUUID()}`;
  const now = Date.now();
  try {
    db.prepare(
      `INSERT INTO users (id, username, email, first_name, last_name, display_name, password_hash,
         role, member_role, status, avatar_color, created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'editor', 'active', NULL, ?, ?, NULL)`
    ).run(
      id,
      username.trim().toLowerCase(),
      email.trim().toLowerCase(),
      firstName.trim(),
      lastName.trim(),
      displayName(firstName, lastName, username),
      hashPassword(password),
      role,
      now,
      now
    );
  } catch (error) {
    const text = String(error?.message || error);
    if (text.includes("users.username")) throw new RequestError("That username is already taken", 409);
    if (text.includes("users.email")) throw new RequestError("That email is already registered", 409);
    throw error;
  }
  return publicUser(userRowById(id));
}

function authorJson(actor) {
  if (!actor) return null;
  return JSON.stringify({ source: "local", id: actor.id, name: actor.displayName });
}

function logActivity(actor, action, resourceType = null, resourceId = null, metadata = null) {
  db.prepare(
    `INSERT INTO activity_log (id, actor_user_id, actor_source, actor_name, action, resource_type,
       resource_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `a_${crypto.randomUUID()}`,
    actor ? actor.id : null,
    actor ? "local" : "guest",
    actor ? actor.displayName : null,
    action,
    resourceType,
    resourceId,
    metadata == null ? null : JSON.stringify(metadata),
    Date.now()
  );
}

function claimUnattributed(user) {
  const author = authorJson(user);
  for (const statement of [
    "UPDATE boards SET created_by = ? WHERE created_by IS NULL",
    "UPDATE boards SET updated_by = ? WHERE updated_by IS NULL",
    "UPDATE cards SET created_by = ? WHERE created_by IS NULL",
    "UPDATE cards SET updated_by = ? WHERE updated_by IS NULL",
  ]) {
    db.prepare(statement).run(author);
  }
}

function createSession(userId) {
  const sessionId = `s_${crypto.randomUUID()}`;
  const token = crypto.randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  const csrf = crypto.randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  const now = Date.now();
  const expiresAt = now + WEB_SESSION_MS;
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, host, created_at, last_seen_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, 'web', ?, ?, ?, NULL)`
  ).run(sessionId, userId, sha256Hex(token), sha256Hex(csrf), now, now, expiresAt);
  return { sessionId, token, csrf, expiresAt };
}

function requireLocalLogin() {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'require_local_login'").get();
  return row?.value === "true";
}

function readCookies(request) {
  const cookies = {};
  for (const part of String(request.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

function requestIsSecure(request) {
  if (request.socket && request.socket.encrypted) return true;
  const forwarded = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  return forwarded === "https";
}

function cookieLine(request, name, value, options = {}) {
  const parts = [`${name}=${value}`, "Path=/", "SameSite=Strict"];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.maxAge != null) parts.push(`Max-Age=${options.maxAge}`);
  if (requestIsSecure(request)) parts.push("Secure");
  return parts.join("; ");
}

function setSessionCookies(request, response, session) {
  const maxAge = Math.floor(WEB_SESSION_MS / 1000);
  response.setHeader("Set-Cookie", [
    cookieLine(request, SESSION_COOKIE, session.token, { httpOnly: true, maxAge }),
    cookieLine(request, CSRF_COOKIE, session.csrf, { maxAge }),
  ]);
}

function clearSessionCookies(request, response) {
  response.setHeader("Set-Cookie", [
    cookieLine(request, SESSION_COOKIE, "", { httpOnly: true, maxAge: 0 }),
    cookieLine(request, CSRF_COOKIE, "", { maxAge: 0 }),
  ]);
}

function currentSession(request) {
  const token = readCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.csrf_hash,
              u.id, u.username, u.email, u.first_name, u.last_name, u.display_name, u.role,
              u.member_role, u.status, u.avatar_color, u.created_at, u.updated_at, u.last_login_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.status = 'active'`
    )
    .get(sha256Hex(token), Date.now());
  if (!row) return null;
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(Date.now(), row.session_id);
  return { sessionId: row.session_id, csrfHash: row.csrf_hash, user: publicUser(row) };
}

function requireSession(request) {
  const session = currentSession(request);
  if (!session) throw new RequestError("Sign in required", 401);
  return session;
}

function requireCsrf(request, session) {
  const header = String(request.headers[CSRF_HEADER] || "");
  const cookie = String(readCookies(request)[CSRF_COOKIE] || "");
  if (!header || !cookie || header !== cookie) {
    throw new RequestError("Invalid or missing CSRF token", 403);
  }
  if (!session.csrfHash || !secureEqual(sha256Hex(header), session.csrfHash)) {
    throw new RequestError("Invalid or missing CSRF token", 403);
  }
}

function markLogin(userId) {
  const now = Date.now();
  db.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?").run(now, now, userId);
}

// Five failures per identifier and client address inside a 15 minute window, then 429.
const failedAttempts = new Map();

function clientAddress(request) {
  return String(request.socket?.remoteAddress || "");
}

function failureKey(scope, identifier, request) {
  return `${scope}|${String(identifier || "").trim().toLowerCase()}|${clientAddress(request)}`;
}

function failureState(key) {
  const entry = failedAttempts.get(key);
  if (!entry) return { blocked: false, retryAfter: 0 };
  const now = Date.now();
  if (entry.resetAt <= now) {
    failedAttempts.delete(key);
    return { blocked: false, retryAfter: 0 };
  }
  return {
    blocked: entry.count >= AUTH_MAX_FAILURES,
    retryAfter: Math.ceil((entry.resetAt - now) / 1000),
  };
}

function recordFailure(key) {
  const now = Date.now();
  let entry = failedAttempts.get(key);
  if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + AUTH_WINDOW_MS };
  entry.count += 1;
  failedAttempts.set(key, entry);
  if (failedAttempts.size > 10_000) {
    for (const [entryKey, value] of failedAttempts) {
      if (value.resetAt <= now) failedAttempts.delete(entryKey);
    }
  }
}

function clearFailures(key) {
  failedAttempts.delete(key);
}

function transaction(callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function historyEntry(row) {
  return {
    id: row.id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    metadata: parseJson(row.metadata, null),
    createdAt: row.created_at,
  };
}

function boardRow(id) {
  return db
    .prepare(
      "SELECT id, title, parent_id, created_at, updated_at, view, grid, show_grid, theme, archived_at, trashed_at, trash, created_by, updated_by FROM boards WHERE id = ?"
    )
    .get(id);
}

function readDoc(id) {
  const row = boardRow(id);
  if (!row) return null;
  const cards = db
    .prepare("SELECT data, created_by, updated_by FROM cards WHERE board_id = ? ORDER BY z ASC, ord ASC")
    .all(id)
    .map((entry) => {
      const card = parseJson(entry.data);
      if (card) {
        card.createdBy = parseJson(entry.created_by, null);
        card.updatedBy = parseJson(entry.updated_by, null);
      }
      return card;
    })
    .filter(Boolean);
  const connections = db
    .prepare("SELECT data FROM connections WHERE board_id = ?")
    .all(id)
    .map((entry) => parseJson(entry.data))
    .filter(Boolean);
  const doc = {
    id: row.id,
    title: row.title,
    parentId: row.parent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: parseJson(row.created_by, null),
    updatedBy: parseJson(row.updated_by, null),
    view: parseJson(row.view, { x: 0, y: 0, zoom: 1 }),
    grid: row.grid,
    showGrid: row.show_grid !== 0,
    theme: row.theme,
    cards,
    connections,
    trash: parseJson(row.trash, []),
  };
  if (row.archived_at != null) doc.archivedAt = row.archived_at;
  if (row.trashed_at != null) doc.trashedAt = row.trashed_at;
  return doc;
}

function writeDoc(doc, expectedUpdatedAt = null, actor = null) {
  if (!doc || typeof doc !== "object" || typeof doc.id !== "string") {
    throw new Error("board id missing");
  }
  const id = doc.id;
  const author = authorJson(actor);
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare("SELECT created_at, updated_at, archived_at, trashed_at, trash FROM boards WHERE id = ?")
      .get(id);
    if (expectedUpdatedAt != null) {
      if (!existing) throw new Error("conflict: the board no longer exists");
      if (existing.updated_at !== expectedUpdatedAt) {
        throw new Error("conflict: the board was changed by another writer, reload it and try again");
      }
    }
    const createdAt = Number.isFinite(doc.createdAt) ? doc.createdAt : existing?.created_at ?? Date.now();
    const updatedAt = Number.isFinite(doc.updatedAt) ? doc.updatedAt : Date.now();
    const archivedAt = doc.archivedAt !== undefined ? doc.archivedAt : existing?.archived_at ?? null;
    const trashedAt = doc.trashedAt !== undefined ? doc.trashedAt : existing?.trashed_at ?? null;
    const trash = doc.trash !== undefined ? JSON.stringify(doc.trash) : existing?.trash ?? null;

    db.prepare(`
      INSERT INTO boards (id, title, parent_id, created_at, updated_at, view, grid, show_grid, theme, archived_at, trashed_at, trash, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, parent_id = excluded.parent_id, updated_at = excluded.updated_at,
        view = excluded.view, grid = excluded.grid, show_grid = excluded.show_grid,
        theme = excluded.theme, archived_at = excluded.archived_at,
        trashed_at = excluded.trashed_at, trash = excluded.trash,
        created_by = COALESCE(boards.created_by, excluded.created_by),
        updated_by = excluded.updated_by
    `).run(
      id,
      typeof doc.title === "string" ? doc.title : "Untitled board",
      doc.parentId ?? null,
      createdAt,
      updatedAt,
      JSON.stringify(doc.view || { x: 0, y: 0, zoom: 1 }),
      Number.isFinite(doc.grid) ? doc.grid : 24,
      doc.showGrid === false ? 0 : 1,
      doc.theme ?? null,
      archivedAt,
      trashedAt,
      trash,
      author,
      author
    );

    const cardAuthors = new Map();
    for (const row of db.prepare("SELECT id, created_by FROM cards WHERE board_id = ?").all(id)) {
      cardAuthors.set(row.id, row.created_by);
    }

    db.prepare("DELETE FROM cards WHERE board_id = ?").run(id);
    const insertCard = db.prepare(
      "INSERT INTO cards (id, board_id, type, parent_id, x, y, w, h, z, ord, data, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const card of Array.isArray(doc.cards) ? doc.cards : []) {
      const cardId = String(card.id ?? "");
      let createdBy = cardAuthors.get(cardId) || null;
      if (createdBy === null && card.createdBy !== undefined) {
        createdBy = JSON.stringify(card.createdBy);
      }
      if (createdBy === null) createdBy = author;
      insertCard.run(
        cardId,
        id,
        String(card.type ?? "note"),
        card.parentId ?? null,
        Number(card.x) || 0,
        Number(card.y) || 0,
        Number(card.w) || 240,
        Number(card.h) || 70,
        Number(card.z) || 1,
        Number(card.order) || 0,
        JSON.stringify(card),
        createdBy,
        author
      );
    }

    db.prepare("DELETE FROM connections WHERE board_id = ?").run(id);
    const insertConnection = db.prepare(
      "INSERT INTO connections (id, board_id, from_id, to_id, data) VALUES (?, ?, ?, ?, ?)"
    );
    for (const connection of Array.isArray(doc.connections) ? doc.connections : []) {
      insertConnection.run(
        String(connection.id ?? ""),
        id,
        String(connection.from ?? ""),
        String(connection.to ?? ""),
        JSON.stringify(connection)
      );
    }
    db.exec("COMMIT");
    return updatedAt;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function listBoards() {
  return db
    .prepare(
      "SELECT id, title, parent_id, created_at, updated_at, archived_at, trashed_at FROM boards ORDER BY updated_at DESC"
    )
    .all()
    .map((row) => ({
      id: row.id,
      title: row.title,
      parentId: row.parent_id,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
      trashedAt: row.trashed_at,
    }));
}

function collectDescendants(id, out = [], seen = new Set()) {
  if (seen.has(id)) return out;
  seen.add(id);
  out.push(id);
  for (const child of db.prepare("SELECT id FROM boards WHERE parent_id = ?").all(id)) {
    collectDescendants(child.id, out, seen);
  }
  return out;
}

function deleteBoardTree(id) {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const boardId of collectDescendants(id)) {
      db.prepare("DELETE FROM cards WHERE board_id = ?").run(boardId);
      db.prepare("DELETE FROM connections WHERE board_id = ?").run(boardId);
      db.prepare("DELETE FROM boards WHERE id = ?").run(boardId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function storeAsset(name, base64) {
  const cleanName = path.basename(String(name || "asset"));
  const extension = path.extname(cleanName).slice(1).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(extension)) throw new Error("This file type is not allowed");
  const bytes = Buffer.from(String(base64 || ""), "base64");
  if (bytes.length > MAX_ASSET_BYTES) throw new Error("Asset is larger than the 100 MB limit");
  const safe = cleanName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const file = `${crypto.randomUUID()}-${safe}`;
  const target = path.join(ASSETS_DIR, file);
  fs.writeFileSync(target, bytes);
  db.prepare("INSERT INTO assets (id, name, path, created_at) VALUES (?, ?, ?, ?)").run(
    crypto.randomUUID(),
    cleanName,
    target,
    Date.now()
  );
  return target;
}

function copyDir(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function backupData() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  let target = path.join(BACKUP_DIR, `khaoyu-note-${Date.now()}`);
  let counter = 1;
  while (fs.existsSync(target)) target = path.join(BACKUP_DIR, `khaoyu-note-${Date.now()}-${counter++}`);
  fs.mkdirSync(target, { recursive: true });
  const quoted = path.join(target, DB_FILE).replace(/'/g, "''");
  db.exec(`VACUUM INTO '${quoted}'`);
  // A backup carries accounts and activity, never live login tokens. Overwrite the deleted session
  // rows and rebuild the file so the tokens are not recoverable from free pages.
  const backup = new DatabaseSync(path.join(target, DB_FILE));
  try {
    backup.exec("PRAGMA secure_delete = ON; DELETE FROM sessions; VACUUM;");
  } finally {
    backup.close();
  }
  if (fs.existsSync(ASSETS_DIR)) copyDir(ASSETS_DIR, path.join(target, "assets"));
  return target;
}

function blockedPreviewHost(host) {
  const value = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!value || value === "localhost" || value.endsWith(".local")) return true;
  return /^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1$|172\.(1[6-9]|2\d|3[01])\.)/.test(value);
}

function metaImage(html) {
  const lower = html.toLowerCase();
  for (const key of ["og:image:url", "og:image", "twitter:image"]) {
    let from = 0;
    while (true) {
      const pos = lower.indexOf(key, from);
      if (pos < 0) break;
      const rawWindow = html.slice(pos + key.length, pos + key.length + 400);
      const lowerWindow = lower.slice(pos + key.length, pos + key.length + 400);
      const content = lowerWindow.indexOf("content");
      if (content >= 0) {
        const match = rawWindow.slice(content).match(/content\s*=\s*["']([^"']+)["']/i);
        if (match?.[1]) return match[1].replaceAll("&amp;", "&");
      }
      from = pos + key.length;
    }
  }
  return null;
}

function youtubeVideoId(url) {
  const host = String(url.hostname || "").toLowerCase().replace(/^www\./, "");
  const path = url.pathname || "";
  const segment = (prefix) => (path.startsWith(prefix) ? path.slice(prefix.length).split("/")[0] : "");
  if (host === "youtu.be") return path.slice(1).split("/")[0] || null;
  if (!["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"].includes(host)) {
    return null;
  }
  const fromQuery = url.searchParams.get("v");
  if (fromQuery) return fromQuery;
  return segment("/shorts/") || segment("/embed/") || segment("/live/") || null;
}

function videoThumbnailUrls(url) {
  const id = youtubeVideoId(url);
  if (!id) return [];
  return ["maxresdefault", "hqdefault"].map((name) => `https://img.youtube.com/vi/${id}/${name}.jpg`);
}

async function downloadPreviewImage(imageUrl) {
  const image = await fetch(imageUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
    headers: { "user-agent": `KhaoyuNote/${VERSION} link preview` },
  });
  if (!image.ok) return null;
  const mime = String(image.headers.get("content-type") || "image/png").split(";")[0];
  if (!mime.startsWith("image/")) return null;
  const bytes = Buffer.from(await image.arrayBuffer());
  if (!bytes.length || bytes.length > 5_000_000) return null;
  const extension = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "png";
  return { data: bytes.toString("base64"), name: `link-hero.${extension}`, mime };
}

async function fetchLinkPreview(url) {
  const parsed = new URL(String(url));
  if (!["http:", "https:"].includes(parsed.protocol) || blockedPreviewHost(parsed.hostname)) {
    return null;
  }
  // YouTube links resolve straight to their thumbnail; the watch page is often a consent page.
  for (const candidate of videoThumbnailUrls(parsed)) {
    if (blockedPreviewHost(new URL(candidate).hostname)) continue;
    const preview = await downloadPreviewImage(candidate);
    if (preview) return preview;
  }
  const page = await fetch(parsed, {
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
    headers: { "user-agent": `KhaoyuNote/${VERSION} link preview` },
  });
  if (!page.ok) return null;
  if (blockedPreviewHost(new URL(page.url).hostname)) return null;
  const length = Number(page.headers.get("content-length") || 0);
  if (length > 2_000_000) return null;
  const html = await page.text();
  if (html.length > 2_000_000) return null;
  const rawImage = metaImage(html);
  if (!rawImage) return null;
  const imageUrl = new URL(rawImage, page.url);
  if (blockedPreviewHost(imageUrl.hostname)) return null;
  return downloadPreviewImage(imageUrl.href);
}

async function checkUpdate() {
  const response = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
    signal: AbortSignal.timeout(8000),
    headers: {
      "user-agent": `KhaoyuNote/${VERSION}`,
      accept: "application/vnd.github+json",
    },
  });
  if (response.status === 404) {
    return { currentVersion: VERSION, release: null };
  }
  if (response.status === 403 || response.status === 429) {
    throw new Error("GitHub rate limit reached, try again later");
  }
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status}`);
  }
  const text = await response.text();
  if (text.length > 1_000_000) {
    throw new Error("the release description is too large");
  }
  return { currentVersion: VERSION, release: JSON.parse(text) };
}

function exportBackupZip() {
  const source = backupData();
  const entries = {};
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(target);
      } else {
        const relative = path.relative(source, target).split(path.sep).join("/");
        entries[relative] = new Uint8Array(fs.readFileSync(target));
      }
    }
  };
  walk(source);
  const zipPath = `${source}.zip`;
  fs.writeFileSync(zipPath, Buffer.from(zipSync(entries, { level: 6 })));
  return zipPath;
}

async function invoke(cmd, args = {}, actor = null) {
  switch (cmd) {
    case "list_boards":
      return listBoards();
    case "load_board": {
      const doc = readDoc(String(args.id));
      return doc ? JSON.stringify(doc) : null;
    }
    case "save_board": {
      if (!actor && requireLocalLogin()) throw new Error("Sign in required");
      if (
        actor &&
        actor.role === "member" &&
        (actor.memberRole === "viewer" || actor.memberRole === "commenter")
      ) {
        throw new Error("You do not have permission to edit this board");
      }
      const doc = JSON.parse(String(args.data));
      if (doc.id !== args.id) throw new Error("board id mismatch");
      return writeDoc(doc, args.baseUpdatedAt ?? null, actor);
    }
    case "delete_board":
      deleteBoardTree(String(args.id));
      return null;
    case "rename_board": {
      const title = String(args.title || "").trim();
      if (!title) throw new Error("title cannot be empty");
      db.prepare("UPDATE boards SET title = ?, updated_at = ? WHERE id = ?").run(
        title,
        Date.now(),
        String(args.id)
      );
      return null;
    }
    case "archive_board":
      db.prepare("UPDATE boards SET archived_at = ? WHERE id = ?").run(
        args.archived ? Date.now() : null,
        String(args.id)
      );
      return null;
    case "trash_board":
      db.prepare("UPDATE boards SET trashed_at = ? WHERE id = ?").run(
        args.trashed ? Date.now() : null,
        String(args.id)
      );
      return null;
    case "store_asset":
      return storeAsset(args.name, args.data);
    case "fetch_link_preview":
      return fetchLinkPreview(args.url);
    case "store_asset_from_path":
      throw new Error("Dropping local paths is only available in the desktop app");
    case "get_setting": {
      const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(String(args.key));
      return row?.value ?? null;
    }
    case "set_setting":
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
        String(args.key),
        String(args.value)
      );
      return null;
    case "app_data_dir":
      return DATA_DIR;
    case "app_version":
      return VERSION;
    case "check_update":
      return checkUpdate();
    case "mcp_server_path":
      return "";
    case "backup_data":
      return backupData();
    case "export_backup_zip":
      return exportBackupZip();
    case "db_integrity":
      return db.prepare("PRAGMA integrity_check").get().integrity_check;
    case "export_board":
      throw new Error("Use the browser download from the web toolbar");
    case "stage_restore":
      throw new Error("Restore from a folder is available in the desktop app");
    case "open_external":
      return null;
    case "open_path":
      return null;
    case "download_asset":
      return null;
    case "restart_app":
      return null;
    case "rename_app":
      return null;
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
};

function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
}

function assetPath(value) {
  const resolved = path.resolve(String(value || ""));
  if (!resolved.startsWith(ASSETS_DIR + path.sep)) throw new Error("not an app asset");
  return resolved;
}

function serveAsset(request, response, download = false) {
  const url = new URL(request.url, webInfo.url);
  const file = assetPath(url.searchParams.get("path"));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404);
    response.end("not found");
    return;
  }
  const name = path.basename(file).replace(/^[0-9a-f-]{36}-/i, "");
  response.writeHead(200, {
    "Content-Type": contentType(file),
    "Content-Length": fs.statSync(file).size,
    ...(download ? { "Content-Disposition": `attachment; filename="${name.replace(/"/g, "")}"` } : {}),
  });
  fs.createReadStream(file).pipe(response);
}

function injectRuntime(html) {
  const script = `
<script>
window.__KHAOYU_WEB__ = ${JSON.stringify(webInfo)};
window.__TAURI__ = {
  core: {
    invoke: async (cmd, args = {}) => {
      if (cmd === "open_external") { window.open(args.url, "_blank", "noopener"); return null; }
      if (cmd === "open_path") { window.open("/api/asset?path=" + encodeURIComponent(args.path), "_blank", "noopener"); return null; }
      if (cmd === "download_asset") {
        const a = document.createElement("a");
        a.href = "/api/download?path=" + encodeURIComponent(args.path);
        a.download = "";
        document.body.append(a); a.click(); a.remove();
        return "Downloads";
      }
      if (cmd === "export_board") {
        const blob = new Blob([args.data], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "board.json"; a.click();
        URL.revokeObjectURL(a.href);
        return "download";
      }
      if (cmd === "restart_app") { location.reload(); return null; }
      const csrfMatch = document.cookie.match(/(?:^|;\s*)khaoyu_local_csrf=([^;]+)/);
      const headers = { "content-type": "application/json" };
      if (csrfMatch) headers["x-khaoyu-csrf"] = csrfMatch[1];
      const response = await fetch("/api/invoke", {
        method: "POST",
        headers,
        body: JSON.stringify({ cmd, args })
      });
      let body;
      try { body = await response.json(); } catch { body = { error: "Invalid server response" }; }
      if (!response.ok || body.error) throw new Error(body.error || "Web backend error");
      return body.result;
    },
    convertFileSrc: (value) => {
      if (!value || /^(https?:|data:|blob:)/i.test(value)) return value;
      return "/api/asset?path=" + encodeURIComponent(value);
    }
  }
};
</script>`;
  return html.replace("</head>", `${script}</head>`);
}

function serveStatic(request, response) {
  const url = new URL(request.url, webInfo.url);
  const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = path.resolve(WEB_ROOT, relative);
  if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + path.sep)) {
    response.writeHead(403);
    response.end("forbidden");
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404);
    response.end("not found");
    return;
  }
  let data = fs.readFileSync(file);
  if (file === path.join(WEB_ROOT, "index.html")) {
    data = Buffer.from(injectRuntime(data.toString("utf8")));
  }
  response.writeHead(200, {
    "Content-Type": contentType(file),
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  response.end(data);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 160 * 1024 * 1024) {
        reject(new Error("request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

async function jsonBody(request) {
  const raw = await readBody(request);
  if (!raw.trim()) return {};
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new RequestError("Invalid request body", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError("Invalid request body", 400);
  }
  return body;
}

function rateLimitFor(key, response) {
  const state = failureState(key);
  if (!state.blocked) return;
  response.setHeader("Retry-After", String(state.retryAfter));
  throw new RequestError("Too many failed attempts, try again later", 429);
}

function failLogin(key) {
  recordFailure(key);
  throw new RequestError("Invalid username or password", 401);
}

function authStatus(request) {
  const session = currentSession(request);
  const requireLogin = requireLocalLogin();
  return {
    userCount: countUsers(),
    requireLogin,
    guestAllowed: !requireLogin,
    user: session ? session.user : null,
    csrfToken: session ? readCookies(request)[CSRF_COOKIE] || null : null,
  };
}

async function handleAuth(request, response, url) {
  const pathname = url.pathname;
  const method = request.method;

  if (pathname === "/api/auth/status") {
    if (method !== "GET") throw new RequestError("method not allowed", 405);
    sendJson(response, 200, authStatus(request));
    return;
  }

  if (pathname === "/api/auth/setup") {
    if (method !== "POST") throw new RequestError("method not allowed", 405);
    const body = await jsonBody(request);
    const key = failureKey("setup", body.email ?? body.username ?? "", request);
    rateLimitFor(key, response);
    const claims = body.claimBoards !== false;
    let result = null;
    try {
      const input = {
        username: String(body.username || "").trim(),
        email: String(body.email || "").trim(),
        firstName: String(body.firstName || "").trim(),
        lastName: String(body.lastName || "").trim(),
        password: String(body.password || ""),
      };
      result = transaction(() => {
        if (countUsers() > 0) throw new RequestError("This database already has an account", 409);
        const user = insertUser({ ...input, role: "admin" });
        if (claims) claimUnattributed(user);
        const session = createSession(user.id);
        markLogin(user.id);
        logActivity(user, "auth.setup", "user", user.id, { claimedBoards: claims });
        return { user: publicUser(userRowById(user.id)), session };
      });
    } catch (error) {
      if (error instanceof RequestError && error.status === 400) recordFailure(key);
      throw error;
    }
    setSessionCookies(request, response, result.session);
    sendJson(response, 200, { user: result.user, expiresAt: result.session.expiresAt });
    return;
  }

  if (pathname === "/api/auth/login") {
    if (method !== "POST") throw new RequestError("method not allowed", 405);
    const body = await jsonBody(request);
    const identifier = String(body.identifier || "").trim();
    const password = String(body.password || "");
    const key = failureKey("login", identifier, request);
    rateLimitFor(key, response);
    const row = userRowByIdentifier(identifier);
    const verified = verifyPassword(password, row ? row.password_hash : dummyPasswordHash());
    if (!row || row.status !== "active" || !verified) failLogin(key);
    const session = transaction(() => {
      const created = createSession(row.id);
      markLogin(row.id);
      logActivity(publicUser(row), "auth.login", "session", created.sessionId, {});
      return created;
    });
    clearFailures(key);
    setSessionCookies(request, response, session);
    sendJson(response, 200, {
      user: publicUser(userRowById(row.id)),
      expiresAt: session.expiresAt,
    });
    return;
  }

  if (pathname === "/api/auth/logout") {
    if (method !== "POST") throw new RequestError("method not allowed", 405);
    const session = currentSession(request);
    if (session) {
      db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(
        Date.now(),
        session.sessionId
      );
      logActivity(session.user, "auth.logout", "session", session.sessionId, {});
    }
    clearSessionCookies(request, response);
    sendJson(response, 200, null);
    return;
  }

  if (pathname === "/api/auth/logout-all") {
    if (method !== "POST") throw new RequestError("method not allowed", 405);
    const session = requireSession(request);
    requireCsrf(request, session);
    transaction(() => {
      db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(
        Date.now(),
        session.user.id
      );
      logActivity(session.user, "auth.logout_all", "session", null, {});
    });
    clearSessionCookies(request, response);
    sendJson(response, 200, null);
    return;
  }

  if (pathname === "/api/auth/me") {
    if (method !== "GET") throw new RequestError("method not allowed", 405);
    const session = currentSession(request);
    sendJson(response, 200, session ? session.user : null);
    return;
  }

  if (pathname === "/api/auth/profile") {
    if (method !== "PATCH") throw new RequestError("method not allowed", 405);
    const session = requireSession(request);
    requireCsrf(request, session);
    const body = await jsonBody(request);
    const current = userRowById(session.user.id);
    if (!current) throw new RequestError("Sign in required", 401);
    const firstName = body.firstName === undefined ? current.first_name ?? "" : String(body.firstName).trim();
    const lastName = body.lastName === undefined ? current.last_name ?? "" : String(body.lastName).trim();
    validateNameFields(firstName, lastName);
    let email = current.email;
    if (body.email !== undefined) {
      const value = String(body.email);
      validateEmail(value);
      email = value.trim().toLowerCase();
      const clash = db.prepare("SELECT id FROM users WHERE email = ? AND id <> ?").get(email, current.id);
      if (clash) throw new RequestError("That email is already registered", 409);
    }
    let avatarColor = current.avatar_color;
    if (body.avatarColor !== undefined) {
      const normalized = validateAvatarColor(body.avatarColor);
      avatarColor = normalized === "" ? null : normalized;
    }
    transaction(() => {
      db.prepare(
        `UPDATE users SET first_name = ?, last_name = ?, email = ?, avatar_color = ?,
           display_name = ?, updated_at = ? WHERE id = ?`
      ).run(
        firstName,
        lastName,
        email,
        avatarColor,
        displayName(firstName, lastName, current.username),
        Date.now(),
        current.id
      );
      logActivity(
        publicUser(userRowById(current.id)),
        "auth.profile_updated",
        "user",
        current.id,
        {}
      );
    });
    sendJson(response, 200, publicUser(userRowById(current.id)));
    return;
  }

  if (pathname === "/api/auth/password") {
    if (method !== "POST") throw new RequestError("method not allowed", 405);
    const session = requireSession(request);
    requireCsrf(request, session);
    const body = await jsonBody(request);
    const current = userRowById(session.user.id);
    if (!current) throw new RequestError("Sign in required", 401);
    if (!verifyPassword(String(body.currentPassword || ""), current.password_hash)) {
      throw new RequestError("Current password is not correct", 400);
    }
    const newPassword = String(body.newPassword || "");
    validatePassword(newPassword);
    transaction(() => {
      db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(
        hashPassword(newPassword),
        Date.now(),
        current.id
      );
      db.prepare(
        "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL"
      ).run(Date.now(), current.id, session.sessionId);
      logActivity(session.user, "auth.password_changed", "user", current.id, {});
    });
    sendJson(response, 200, null);
    return;
  }

  if (pathname === "/api/auth/history") {
    if (method !== "GET") throw new RequestError("method not allowed", 405);
    const session = requireSession(request);
    const limitValue = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    const limit = Number.isFinite(limitValue)
      ? Math.min(HISTORY_MAX_PAGE_SIZE, Math.max(1, limitValue))
      : HISTORY_PAGE_SIZE;
    const offsetValue = Number.parseInt(url.searchParams.get("offset") ?? "", 10);
    const offset = Number.isFinite(offsetValue) ? Math.max(0, offsetValue) : 0;
    const rows = db
      .prepare(
        `SELECT id, action, resource_type, resource_id, metadata, created_at
         FROM activity_log WHERE actor_user_id = ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(session.user.id, limit + 1, offset);
    sendJson(response, 200, {
      entries: rows.slice(0, limit).map(historyEntry),
      hasMore: rows.length > limit,
    });
    return;
  }

  throw new RequestError("not found", 404);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, webInfo.url);
    if (request.method === "GET" && url.pathname === "/status") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(
          {
            ...webInfo,
            startedAt,
            uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
            node: process.version,
          },
          null,
          2
        )
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/asset") {
      serveAsset(request, response, false);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/download") {
      serveAsset(request, response, true);
      return;
    }
    if (url.pathname.startsWith("/api/auth/")) {
      await handleAuth(request, response, url);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/invoke") {
      const session = currentSession(request);
      if (session) requireCsrf(request, session);
      const body = JSON.parse(await readBody(request));
      try {
        const result = await invoke(String(body.cmd || ""), body.args || {}, session ? session.user : null);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ result }));
      } catch (error) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
    if (request.method === "GET" || request.method === "HEAD") {
      serveStatic(request, response);
      return;
    }
    response.writeHead(405);
    response.end("method not allowed");
  } catch (error) {
    if (error instanceof RequestError) {
      response.writeHead(error.status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify({ error: error.message }));
      return;
    }
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Khaoyu Note web: ${webInfo.url}`);
  console.log(`database: ${DB_PATH}`);
  console.log(`status:   ${webInfo.url}/status`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
