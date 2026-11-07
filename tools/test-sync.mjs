// Node checks for the opt-in sync engine. Run with: node tools/test-sync.mjs
import assert from "node:assert/strict";

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
}

globalThis.localStorage = new MemoryStorage();
const calls = [];
let remote = { revision: 0, doc: null };
let offline = false;
let readyStatus = 200;
let projectsStatus = 200;
const id = "project-sync-test";

globalThis.fetch = async (url, options = {}) => {
  calls.push({ url, method: options.method || "GET" });
  if (offline) throw new Error("network down");
  const path = new URL(url).pathname;
  const method = options.method || "GET";
  const reply = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  });
  if (method === "GET" && path === "/readyz") {
    return reply(readyStatus, readyStatus === 200 ? { status: "ready" } : { status: "not_ready" });
  }
  if (method === "GET" && path === "/api/v1/projects") {
    return reply(
      projectsStatus,
      projectsStatus === 200
        ? { projects: [{ id: "p1" }, { id: "p2" }] }
        : { error: projectsStatus === 401 ? "unauthorized" : "forbidden" }
    );
  }
  if (method === "POST" && path === "/api/v1/projects") {
    remote = { revision: 1, doc: null };
    return reply(201, { id, title: "Board", revision: 1, role: "owner" });
  }
  if (method === "GET" && path === `/api/v1/projects/${id}`) {
    return reply(200, {
      project: { id, revision: remote.revision },
      snapshot: remote.doc ? { revision: remote.revision, doc: remote.doc } : null,
    });
  }
  if (method === "PUT" && path === `/api/v1/projects/${id}/snapshot`) {
    const body = JSON.parse(options.body);
    if (body.revision !== remote.revision) {
      return reply(409, { error: "revision conflict", code: "revision_conflict" });
    }
    remote = { revision: remote.revision + 1, doc: body.doc };
    return reply(200, { revision: remote.revision });
  }
  return reply(404, { error: "not found" });
};

const sync = await import("../app/web/js/sync.js");

// A local service is addressed without a scheme, and it must not be forced onto a domain.
assert.equal(sync.normalizeServerUrl("localhost:8080"), "http://localhost:8080");
assert.equal(sync.normalizeServerUrl("127.0.0.1:8080/"), "http://127.0.0.1:8080");
assert.equal(sync.normalizeServerUrl("http://localhost:8080/"), "http://localhost:8080");
assert.equal(sync.normalizeServerUrl("notes.example.com"), "https://notes.example.com");
assert.equal(
  sync.normalizeServerUrl("https://notes.example.com/base/"),
  "https://notes.example.com/base"
);
assert.throws(() => sync.normalizeServerUrl("ftp://notes.example.com"), /http/);
assert.throws(() => sync.normalizeServerUrl(""), /server URL/i);

// The connection check proves readiness and the authenticated database round trip.
sync.saveSyncConfig({ url: "localhost:8080", token: "token-value" });
assert.equal(sync.loadSyncConfig().url, "http://localhost:8080");
let connection = await sync.checkConnection();
assert.equal(connection.state, "connected");
assert.equal(connection.projectCount, 2);

projectsStatus = 401;
connection = await sync.checkConnection();
assert.equal(connection.state, "unauthorized");

projectsStatus = 403;
connection = await sync.checkConnection();
assert.equal(connection.state, "forbidden");

projectsStatus = 200;
readyStatus = 503;
connection = await sync.checkConnection();
assert.equal(connection.state, "not-ready");

readyStatus = 200;
const liveFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("network down");
};
connection = await sync.checkConnection();
assert.equal(connection.state, "unreachable");
globalThis.fetch = liveFetch;

sync.saveSyncConfig({ url: "http://service.test", token: "" });
connection = await sync.checkConnection();
assert.equal(connection.state, "unconfigured");

sync.saveSyncConfig({ url: "http://service.test", token: "token-value" });
assert.equal((await sync.checkConnection()).state, "connected");

const board = {
  id: "b1",
  title: "Sync board",
  cards: [{ id: "c1", type: "note", text: "hello" }],
  updatedAt: 1000,
};

const enabled = await sync.enableBoardSync(board);
assert.equal(enabled.status, "pushed");
assert.equal(board.sync.projectId, id);
assert.equal(board.sync.revision, 2);
assert.equal(JSON.parse(remote.doc).sync, undefined);

board.updatedAt = board.sync.lastSyncedAt + 1000;
assert.equal((await sync.syncBoard(board)).status, "pushed");
assert.equal(board.sync.revision, 3);
assert.equal(JSON.parse(remote.doc).cards[0].text, "hello");

remote = {
  revision: 4,
  doc: JSON.stringify({ id: "server-board", title: "Server", cards: [], updatedAt: 3000 }),
};
board.updatedAt = board.sync.lastSyncedAt - 1;
const pulled = await sync.syncBoard(board);
assert.equal(pulled.status, "pulled");
assert.equal(pulled.doc.id, board.id);
assert.equal(pulled.doc.sync.revision, 4);
board.sync = pulled.doc.sync;

remote = {
  revision: 5,
  doc: JSON.stringify({ id: "server-board", title: "Remote change", cards: [], updatedAt: 4000 }),
};
board.updatedAt = board.sync.lastSyncedAt + 1000;
const conflict = await sync.syncBoard(board);
assert.equal(conflict.status, "conflict");
assert.equal(conflict.remoteRevision, 5);

const serverChoice = await sync.resolveSyncConflict(board, "server");
assert.equal(serverChoice.status, "pulled");
assert.equal(serverChoice.doc.sync.revision, 5);
board.sync = serverChoice.doc.sync;

board.updatedAt = 6000;
offline = true;
await assert.rejects(() => sync.syncBoard(board), (error) => error.offline === true);
sync.enqueueForOffline(board);
assert.equal(sync.syncStatusFor(board).status, "offline");
const queued = JSON.parse(localStorage.getItem("mn.sync.queue"));
assert.equal(queued.length, 1);
assert.equal(queued[0].projectId, id);

offline = false;
const flushed = await sync.flushQueue();
assert.equal(flushed.flushed, 1);
assert.equal(sync.loadSyncConfig().token, "token-value");
const writes = calls.filter((call) => call.method === "DELETE");
assert.equal(writes.length, 0);

console.log("PASS  sync url, connection status, create, push, pull, conflict, offline queue and no delete");
console.log(`${calls.length} fake service calls`);
