// Local web host for Khaoyu Note. Serves the same frontend and backs it with the same SQLite
// database and asset folder the desktop app uses, over a small JSON command bridge.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(ROOT, "app", "web");
const HOST = process.env.KHAOYU_WEB_HOST || "127.0.0.1";
const PORT = Number(process.env.KHAOYU_WEB_PORT || process.env.PORT || 1430);
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const DB_FILE = "khaoyu-note.db";
const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const BLOCKED_EXTENSIONS = new Set([
  "exe", "msi", "bat", "cmd", "ps1", "scr", "com", "dll", "jar", "vbs", "js", "lnk",
]);

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
fs.mkdirSync(ASSETS_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
db.exec(`
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, parent_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  view TEXT NOT NULL, grid INTEGER NOT NULL, show_grid INTEGER NOT NULL,
  theme TEXT, archived_at INTEGER, trashed_at INTEGER, trash TEXT
);
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  type TEXT NOT NULL, parent_id TEXT,
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
  z REAL NOT NULL, ord REAL NOT NULL, data TEXT NOT NULL
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
`);

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

const schemaVersion = db
  .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
  .get()?.value;
if (!schemaVersion) {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1')").run();
}

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

function boardRow(id) {
  return db
    .prepare(
      "SELECT id, title, parent_id, created_at, updated_at, view, grid, show_grid, theme, archived_at, trashed_at, trash FROM boards WHERE id = ?"
    )
    .get(id);
}

function readDoc(id) {
  const row = boardRow(id);
  if (!row) return null;
  const cards = db
    .prepare("SELECT data FROM cards WHERE board_id = ? ORDER BY z ASC, ord ASC")
    .all(id)
    .map((entry) => parseJson(entry.data))
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

function writeDoc(doc, expectedUpdatedAt = null) {
  if (!doc || typeof doc !== "object" || typeof doc.id !== "string") {
    throw new Error("board id missing");
  }
  const id = doc.id;
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
      INSERT INTO boards (id, title, parent_id, created_at, updated_at, view, grid, show_grid, theme, archived_at, trashed_at, trash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, parent_id = excluded.parent_id, updated_at = excluded.updated_at,
        view = excluded.view, grid = excluded.grid, show_grid = excluded.show_grid,
        theme = excluded.theme, archived_at = excluded.archived_at,
        trashed_at = excluded.trashed_at, trash = excluded.trash
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
      trash
    );

    db.prepare("DELETE FROM cards WHERE board_id = ?").run(id);
    const insertCard = db.prepare(
      "INSERT INTO cards (id, board_id, type, parent_id, x, y, w, h, z, ord, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const card of Array.isArray(doc.cards) ? doc.cards : []) {
      insertCard.run(
        String(card.id ?? ""),
        id,
        String(card.type ?? "note"),
        card.parentId ?? null,
        Number(card.x) || 0,
        Number(card.y) || 0,
        Number(card.w) || 240,
        Number(card.h) || 70,
        Number(card.z) || 1,
        Number(card.order) || 0,
        JSON.stringify(card)
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
  const base = path.join(os.homedir(), "Documents", "Khaoyu Note Backups");
  fs.mkdirSync(base, { recursive: true });
  let target = path.join(base, `khaoyu-note-${Date.now()}`);
  let counter = 1;
  while (fs.existsSync(target)) target = path.join(base, `khaoyu-note-${Date.now()}-${counter++}`);
  fs.mkdirSync(target, { recursive: true });
  const quoted = path.join(target, DB_FILE).replace(/'/g, "''");
  db.exec(`VACUUM INTO '${quoted}'`);
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

async function fetchLinkPreview(url) {
  const parsed = new URL(String(url));
  if (!["http:", "https:"].includes(parsed.protocol) || blockedPreviewHost(parsed.hostname)) {
    return null;
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

async function invoke(cmd, args = {}) {
  switch (cmd) {
    case "list_boards":
      return listBoards();
    case "load_board": {
      const doc = readDoc(String(args.id));
      return doc ? JSON.stringify(doc) : null;
    }
    case "save_board": {
      const doc = JSON.parse(String(args.data));
      if (doc.id !== args.id) throw new Error("board id mismatch");
      return writeDoc(doc, args.baseUpdatedAt ?? null);
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
    case "mcp_server_path":
      return "";
    case "backup_data":
      return backupData();
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
      const response = await fetch("/api/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
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
    if (request.method === "POST" && url.pathname === "/api/invoke") {
      const body = JSON.parse(await readBody(request));
      try {
        const result = await invoke(String(body.cmd || ""), body.args || {});
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
