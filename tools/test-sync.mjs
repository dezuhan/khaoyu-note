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
let remote = { revision: 0, lastSeq: 0, doc: null };
let remoteOps = [];
const appliedOpIds = new Set();
let offline = false;
let readyStatus = 200;
let projectsStatus = 200;
let readyFails = false;
let syncLoginStatus = 201;
let failNextOps = null;
let nextFieldConflicts = [];
let lastOpsBody = null;
const id = "project-sync-test";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function applyMockOperation(document, operation) {
  const doc = clone(document);
  if (!Array.isArray(doc.cards)) doc.cards = [];
  const payload = operation.payload || {};
  if (operation.type === "doc.replace") return clone(payload.doc);
  if (operation.type === "doc.title") {
    doc.title = payload.title;
    return doc;
  }
  if (operation.type === "card.add") {
    doc.cards.push(clone(payload.card));
    return doc;
  }
  if (operation.type === "card.update") {
    const card = doc.cards.find((entry) => entry.id === payload.id);
    if (card) Object.assign(card, clone(payload.patch));
    return doc;
  }
  if (operation.type === "card.delete") {
    doc.cards = doc.cards.filter((card) => card.id !== payload.id);
    return doc;
  }
  if (operation.type === "connections.set") {
    doc.connections = clone(payload.connections || []);
    return doc;
  }
  if (operation.type === "card.move") {
    const card = doc.cards.find((entry) => entry.id === payload.id);
    if (card) {
      for (const key of ["x", "y", "order"]) if (payload[key] !== undefined) card[key] = payload[key];
      if (payload.parentId !== undefined) card.parentId = payload.parentId;
    }
    return doc;
  }
  throw new Error(`mock does not support ${operation.type}`);
}

function applyRemoteOperation(operation) {
  remote.doc = JSON.stringify(applyMockOperation(JSON.parse(remote.doc || "{}"), operation));
  remote.lastSeq += 1;
  remote.revision += 1;
  remoteOps.push({ seq: remote.lastSeq, opId: `remote-${remote.lastSeq}`, ...operation });
}

globalThis.fetch = async (url, options = {}) => {
  calls.push({ url, method: options.method || "GET", body: options.body });
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
    if (readyFails) throw new Error("blocked by CORS");
    return reply(readyStatus, readyStatus === 200 ? { status: "ready" } : { status: "not_ready" });
  }
  if (method === "POST" && path === "/api/v1/auth/sync-token") {
    if (syncLoginStatus !== 201) {
      return reply(syncLoginStatus, { error: "Invalid email or password" });
    }
    return reply(201, {
      token: "khn_sync_test",
      email: "owner@example.com",
      scopes: ["projects:read", "projects:write"],
      expiresAt: Date.now() + 86_400_000,
    });
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
    remote = { revision: 1, doc: null, lastSeq: 0 };
    remoteOps = [];
    appliedOpIds.clear();
    return reply(201, { id, title: "Board", revision: 1, lastSeq: 0, role: "owner" });
  }
  if (method === "GET" && path === `/api/v1/projects/${id}`) {
    return reply(200, {
      project: { id, revision: remote.revision, lastSeq: remote.lastSeq },
      snapshot: remote.doc ? { revision: remote.revision, doc: remote.doc } : null,
    });
  }
  if (method === "GET" && path === `/api/v1/projects/${id}/ops`) {
    const after = Number(new URL(url).searchParams.get("after") || 0);
    const ops = remoteOps.filter((entry) => entry.seq > after);
    return reply(200, {
      ops,
      lastSeq: remote.lastSeq,
      revision: remote.revision,
      hasMore: false,
    });
  }
  if (method === "POST" && path === `/api/v1/projects/${id}/ops`) {
    if (failNextOps) {
      const failure = failNextOps;
      if (failure.remaining === undefined) {
        failNextOps = null;
      } else {
        failure.remaining -= 1;
        if (failure.remaining <= 0) failNextOps = null;
      }
      return reply(failure.status, { error: failure.message || "injected", code: failure.code });
    }
    const body = JSON.parse(options.body);
    lastOpsBody = body;
    const operations = body.ops || [];
    if (operations.some((operation) => appliedOpIds.has(operation.opId))) {
      return reply(200, { idempotent: true, lastSeq: remote.lastSeq, revision: remote.revision, ops: [] });
    }
    if (Number(body.baseSeq) !== Number(remote.lastSeq)) {
      return reply(409, { error: "sequence conflict", code: "seq_conflict" });
    }
    let doc = JSON.parse(remote.doc || "{}");
    for (const operation of operations) {
      doc = applyMockOperation(doc, operation);
      appliedOpIds.add(operation.opId);
      remote.lastSeq += 1;
      remoteOps.push({
        seq: remote.lastSeq,
        opId: operation.opId,
        type: operation.type,
        payload: operation.payload,
        clock: operation.clock || {},
      });
    }
    remote.doc = JSON.stringify(doc);
    remote.revision += 1;
    const fieldConflicts = nextFieldConflicts.splice(0);
    return reply(200, {
      lastSeq: remote.lastSeq,
      revision: remote.revision,
      idempotent: false,
      fieldConflicts,
      ops: operations.map((operation, index) => ({ seq: remote.lastSeq - operations.length + 1 + index, opId: operation.opId, type: operation.type })),
    });
  }
  if (method === "PUT" && path === `/api/v1/projects/${id}/snapshot`) {
    const body = JSON.parse(options.body);
    if (body.revision !== remote.revision) {
      return reply(409, { error: "revision conflict", code: "revision_conflict" });
    }
    remote = { ...remote, revision: remote.revision + 1, doc: body.doc };
    return reply(200, { revision: remote.revision });
  }
  return reply(404, { error: "not found" });
};

const sync = await import("../app/web/js/sync.js");
const syncStore = await import("../app/web/js/sync-store.js");

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
sync.saveSyncConfig({
  url: "localhost:8080",
  token: "token-value",
  publicShareUrl: "https://notes.example.com",
});
assert.equal(sync.loadSyncConfig().url, "http://localhost:8080");
assert.equal(sync.loadSyncConfig().publicShareUrl, "https://notes.example.com");
assert.throws(
  () => sync.saveSyncConfig({ url: "localhost:8080", publicShareUrl: "ftp://example.com" }),
  /http/
);
sync.saveSyncConfig({ url: "localhost:8080", token: "token-value", publicShareUrl: "" });
assert.equal(sync.loadSyncConfig().publicShareUrl, "");
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

// An older service may not send CORS headers on /readyz; the authenticated call still decides.
readyFails = true;
connection = await sync.checkConnection();
assert.equal(connection.state, "connected");
readyFails = false;

sync.saveSyncConfig({ url: "http://service.test", token: "" });
connection = await sync.checkConnection();
assert.equal(connection.state, "unconfigured");

sync.saveSyncConfig({ url: "http://service.test", token: "token-value" });
assert.equal((await sync.checkConnection()).state, "connected");

// Email and password sign-in stores a scoped token without exposing it to the user.
sync.signOut();
assert.equal(sync.loadSyncConfig().token, "");
await assert.rejects(
  () => sync.signIn({ url: "localhost:8080", email: "owner@example.com" }),
  /password/i
);
const signedIn = await sync.signIn({
  url: "localhost:8080",
  email: "owner@example.com",
  password: "secret-pass",
});
assert.equal(signedIn.url, "http://localhost:8080");
assert.equal(signedIn.email, "owner@example.com");
assert.equal(signedIn.token, "khn_sync_test");
assert.equal(sync.loadSyncConfig().token, "khn_sync_test");
assert.equal(sync.loadSyncConfig().email, "owner@example.com");
assert.equal((await sync.checkConnection()).state, "connected");
assert.match(sync.describeConnection(sync.connectionStatus), /owner@example\.com/);

syncLoginStatus = 401;
await assert.rejects(
  () => sync.signIn({ url: "localhost:8080", email: "owner@example.com", password: "wrong" }),
  /Wrong email or password/
);
syncLoginStatus = 201;

sync.signOut();
assert.equal(sync.loadSyncConfig().token, "");
assert.equal(sync.loadSyncConfig().email, "");
assert.equal(sync.loadSyncConfig().url, "http://localhost:8080");

sync.saveSyncConfig({ url: "http://service.test", token: "token-value" });

const board = {
  id: "b1",
  title: "Sync board",
  cards: [{ id: "c1", type: "note", text: "hello", x: 0, y: 0 }],
  connections: [],
  trash: [],
  updatedAt: 1000,
};

const enabled = await sync.enableBoardSync(board);
assert.equal(enabled.status, "pushed");
assert.equal(board.sync.projectId, id);
assert.equal(board.sync.revision, 2);
assert.equal(JSON.parse(remote.doc).sync, undefined);
assert.equal(sync.syncStatusFor(board).status, "synced");

// Every save is captured as granular operations before the network push is attempted.
board.cards[0].text = "hello edited";
board.updatedAt = Date.now();
const captured = await sync.captureBoardChanges(board);
assert.equal(captured.captured, 1);
assert.equal(captured.pending, 1);
assert.equal(sync.syncStatusFor(board).status, "pending");
assert.equal(sync.pendingInfoFor(board).pending, 1);
assert.equal(sync.pendingInfoFor(board).storage, "localstorage");
const pushed = await sync.flushBoardNow(board);
assert.equal(pushed.status, "pushed");
assert.equal(sync.syncStatusFor(board).status, "synced");
assert.equal(JSON.parse(remote.doc).cards[0].text, "hello edited");
assert.equal((await sync.readCachedBoard(board.id)).pendingOps.length, 0);

// Offline edits stay in the durable queue across a reload and flush when the network returns.
offline = true;
board.cards[0].text = "written offline";
board.updatedAt = Date.now();
await sync.captureBoardChanges(board);
const failedFlush = await sync.flushBoardNow(board);
assert.equal(failedFlush.status, "pending");
assert.match(sync.syncStatusFor(board).message, /Offline/);
assert.equal(sync.syncStatusFor(board).status, "pending");
sync._resetRuntimeForTests();
const reloaded = await sync.readCachedBoard(board.id);
assert.ok(reloaded, "the durable record survives a reload");
assert.equal(reloaded.pendingOps.length, 1);
assert.equal(reloaded.doc.cards[0].text, "written offline");
assert.equal(reloaded.attempts >= 1, true);
assert.equal(reloaded.nextAttemptAt > Date.now(), true);

offline = false;
const flushedAll = await sync.flushQueue();
assert.equal(flushedAll.flushed, 1);
assert.equal(JSON.parse(remote.doc).cards[0].text, "written offline");
assert.equal((await sync.readCachedBoard(board.id)).pendingOps.length, 0);

// A sequence conflict replays the remote operations and merges the local patches instead of
// replacing the document.
sync._resetRuntimeForTests();
const mergeBoard = board;
remote.doc = JSON.stringify({
  id: "b1",
  title: "Sync board",
  cards: [
    { id: "c1", type: "note", text: "written offline", x: 0, y: 0 },
    { id: "c2", type: "note", text: "from server", x: 10, y: 10 },
  ],
  connections: [],
  trash: [],
});
mergeBoard.updatedAt = Date.now();
await sync.attachRemoteBoard(mergeBoard, {
  projectId: id,
  revision: remote.revision,
  lastSeq: remote.lastSeq,
  baseDoc: JSON.parse(remote.doc),
});
mergeBoard.cards[0].text = "local wins";
await sync.captureBoardChanges(mergeBoard);
// Another client advances the server after our capture, so the first POST gets a seq_conflict.
applyRemoteOperation({ type: "card.update", payload: { id: "c2", patch: { text: "remote edit" } } });
const merged = await sync.flushBoardNow(mergeBoard);
assert.equal(merged.status, "pushed");
const mergedDoc = JSON.parse(remote.doc);
assert.equal(mergedDoc.cards.find((card) => card.id === "c1").text, "local wins");
assert.equal(mergedDoc.cards.find((card) => card.id === "c2").text, "remote edit");
// The rebase must also update the open board. Otherwise the next save would emit inverse operations
// (deleting c2 or reverting its text) against the merged base.
const remoteAfterMerge = remote.doc;
const recaptured = await sync.captureBoardChanges(mergeBoard);
assert.equal(recaptured.captured, 0);
assert.equal(remote.doc, remoteAfterMerge);
assert.equal(mergeBoard.cards.find((card) => card.id === "c2").text, "remote edit");

// A card locked by another editor blocks the queue and retries later.
sync._resetRuntimeForTests();
await sync.attachRemoteBoard(mergeBoard, {
  projectId: id,
  revision: remote.revision,
  lastSeq: remote.lastSeq,
  baseDoc: JSON.parse(remote.doc),
});
mergeBoard.cards[0].text = "locked edit";
await sync.captureBoardChanges(mergeBoard);
failNextOps = { status: 423, code: "card_locked" };
const locked = await sync.flushBoardNow(mergeBoard);
assert.equal(locked.status, "blocked");
assert.equal(sync.syncStatusFor(mergeBoard).status, "blocked");
assert.equal((await sync.readCachedBoard(mergeBoard.id)).pendingOps.length, 1);
const retried = await sync.flushBoardNow(mergeBoard);
assert.equal(retried.status, "pushed");
assert.equal(JSON.parse(remote.doc).cards[0].text, "locked edit");

// A whole-document replacement that races a remote change is surfaced as a conflict, not forced.
sync._resetRuntimeForTests();
await sync.attachRemoteBoard(mergeBoard, {
  projectId: id,
  revision: remote.revision,
  lastSeq: remote.lastSeq,
  baseDoc: JSON.parse(remote.doc),
});
mergeBoard.connections.push({
  id: "conn_1",
  from: "c1",
  to: "c2",
  fromPoint: null,
  toPoint: null,
  curve: null,
});
await sync.captureBoardChanges(mergeBoard);
applyRemoteOperation({ type: "doc.title", payload: { title: "Remote title" } });
// Connections now travel as their own operation, so the title change and the new connection merge.
const mergedConnection = await sync.flushBoardNow(mergeBoard);
assert.equal(mergedConnection.status, "pushed");
const afterConnection = JSON.parse(remote.doc);
assert.equal(afterConnection.title, "Remote title");
assert.equal(afterConnection.connections.length, 1);
assert.equal(afterConnection.cards.some((card) => card.id === "c2"), true);

// The whole-document fallback (trash contents) still surfaces a conflict instead of overwriting.
mergeBoard.trash.push({ id: "trash-1", cards: [{ id: "trashed", type: "note", text: "gone" }] });
await sync.captureBoardChanges(mergeBoard);
applyRemoteOperation({ type: "doc.title", payload: { title: "Remote title 2" } });
const conflicted = await sync.flushBoardNow(mergeBoard);
assert.equal(conflicted.status, "conflict");
assert.equal(sync.syncStatusFor(mergeBoard).status, "conflict");
const serverChoice = await sync.resolveSyncConflict(mergeBoard, "server");
assert.equal(serverChoice.status, "pulled");
assert.equal(serverChoice.doc.title, "Remote title 2");
assert.equal(sync.syncStatusFor(mergeBoard).conflict, undefined);

// A rejected token fails the queue visibly while keeping the operations.
sync._resetRuntimeForTests();
await sync.attachRemoteBoard(mergeBoard, {
  projectId: id,
  revision: remote.revision,
  lastSeq: remote.lastSeq,
  baseDoc: JSON.parse(remote.doc),
});
mergeBoard.cards[0].text = "after reauth";
await sync.captureBoardChanges(mergeBoard);
failNextOps = { status: 401, message: "token rejected" };
const rejected = await sync.flushBoardNow(mergeBoard);
assert.equal(rejected.status, "failed");
assert.equal(sync.syncStatusFor(mergeBoard).status, "failed");
assert.equal((await sync.readCachedBoard(mergeBoard.id)).pendingOps.length, 1);
const recovered = await sync.flushBoardNow(mergeBoard);
assert.equal(recovered.status, "pushed");

// A change the server keeps rejecting fails visibly and offers a discard path instead of wedging.
sync._resetRuntimeForTests();
await sync.attachRemoteBoard(mergeBoard, {
  projectId: id,
  revision: remote.revision,
  lastSeq: remote.lastSeq,
  baseDoc: JSON.parse(remote.doc),
});
mergeBoard.cards[0].text = "obsolete edit";
await sync.captureBoardChanges(mergeBoard);
failNextOps = { status: 400, code: "op_invalid", message: "card not found", remaining: 2 };
const rejectedOperation = await sync.flushBoardNow(mergeBoard);
assert.equal(rejectedOperation.status, "failed");
assert.equal(sync.syncStatusFor(mergeBoard).status, "failed");
assert.equal((await sync.readCachedBoard(mergeBoard.id)).pendingOps.length > 0, true);
const discarded = await sync.discardQueuedChanges(mergeBoard);
assert.equal(discarded.status, "cleared");
assert.equal((await sync.readCachedBoard(mergeBoard.id)).pendingOps.length, 0);
assert.equal(sync.syncStatusFor(mergeBoard).status, "synced");

// A legacy temporary document is imported as operations instead of being shown as already synced.
sync._resetRuntimeForTests();
remote.doc = JSON.stringify({
  id: "b1",
  title: "Server",
  cards: [{ id: "legacy", type: "note", text: "server value" }],
  connections: [],
  trash: [],
});
board.cards = [{ id: "legacy", type: "note", text: "legacy local" }];
board.connections = [];
board.trash = [];
board.title = "Server";
await sync.attachRemoteBoard(board, {
  projectId: id,
  revision: remote.revision,
  lastSeq: remote.lastSeq,
  baseDoc: JSON.parse(remote.doc),
});
const imported = await sync.importLocalDocument(board, JSON.parse(remote.doc));
assert.equal(imported.captured > 0, true);
const importedPush = await sync.flushBoardNow(board);
assert.equal(importedPush.status, "pushed");
assert.equal(JSON.parse(remote.doc).cards.find((card) => card.id === "legacy").text, "legacy local");

// A concurrent edit of the same card field keeps the local value (server order wins) but records the
// conflict, and the server value can be applied afterwards.
sync._resetRuntimeForTests();
remote.doc = JSON.stringify({
  id: "b1",
  title: "Conflict board",
  cards: [{ id: "cf", type: "note", text: "base" }],
  connections: [],
  trash: [],
});
remote.lastSeq = 0;
remote.revision = 1;
remoteOps = [];
appliedOpIds.clear();
const conflictBoard = {
  id: "b1",
  title: "Conflict board",
  cards: [{ id: "cf", type: "note", text: "base" }],
  connections: [],
  trash: [],
  sync: { projectId: id, revision: 1, lastSeq: 0 },
};
await sync.attachRemoteBoard(conflictBoard, {
  projectId: id,
  revision: 1,
  lastSeq: 0,
  baseDoc: JSON.parse(remote.doc),
});
conflictBoard.cards[0].text = "local edit";
await sync.captureBoardChanges(conflictBoard);
applyRemoteOperation({ type: "card.update", payload: { id: "cf", patch: { text: "remote edit" } } });
const conflictPush = await sync.flushBoardNow(conflictBoard);
assert.equal(conflictPush.status, "pushed");
assert.equal(JSON.parse(remote.doc).cards[0].text, "local edit");
const conflictCache = await sync.readCachedBoard("b1");
assert.equal(conflictCache.fieldConflicts.length, 1);
assert.equal(conflictCache.fieldConflicts[0].field, "text");
assert.equal(conflictCache.fieldConflicts[0].remoteValue, "remote edit");
assert.match(sync.syncStatusFor(conflictBoard).message, /field conflict/);
const appliedServerValues = await sync.applyServerFieldValues(conflictBoard);
assert.equal(appliedServerValues.applied, 1);
assert.equal(conflictBoard.cards[0].text, "remote edit");
assert.equal((await sync.readCachedBoard("b1")).fieldConflicts.length, 0);

// Operations carry a causal clock, and the server can report a concurrent field write directly even
// when no operation replay is needed.
sync._resetRuntimeForTests();
await sync.attachRemoteBoard(conflictBoard, {
  projectId: id,
  revision: remote.revision,
  lastSeq: remote.lastSeq,
  baseDoc: JSON.parse(remote.doc),
});
conflictBoard.cards[0].text = "clocked edit";
await sync.captureBoardChanges(conflictBoard);
const clocked = await sync.readCachedBoard("b1");
const clockedOp = clocked.pendingOps[0];
assert.ok(clockedOp.clock && Object.keys(clockedOp.clock).length === 1);
assert.ok(Object.values(clockedOp.clock)[0] >= 1);
nextFieldConflicts = [
  {
    cardId: "cf",
    field: "text",
    remoteValue: "server side",
    remoteSeq: remote.lastSeq + 1,
    remoteClock: { other: 1 },
  },
];
const clockPush = await sync.flushBoardNow(conflictBoard);
assert.equal(clockPush.status, "pushed");
assert.equal((await sync.readCachedBoard("b1")).fieldConflicts.length, 1);
assert.equal((await sync.readCachedBoard("b1")).fieldConflicts[0].remoteValue, "server side");

// Replaying an operation with a foreign clock merges it, so the next operation is causally after it.
sync._resetRuntimeForTests();
await sync.attachRemoteBoard(conflictBoard, {
  projectId: id,
  revision: remote.revision,
  lastSeq: remote.lastSeq,
  baseDoc: JSON.parse(remote.doc),
});
conflictBoard.cards[0].text = "before replay";
await sync.captureBoardChanges(conflictBoard);
applyRemoteOperation({
  type: "card.update",
  payload: { id: "cf", patch: { text: "clocked remote" } },
  clock: { otherTab: 1 },
});
const replayPush = await sync.flushBoardNow(conflictBoard);
assert.equal(replayPush.status, "pushed");
assert.equal((await sync.readCachedBoard("b1")).clock.otherTab, 1);
conflictBoard.cards[0].text = "after merge";
await sync.captureBoardChanges(conflictBoard);
const mergedClock = await sync.readCachedBoard("b1");
assert.equal(mergedClock.pendingOps[0].clock.otherTab, 1);
await sync.flushBoardNow(conflictBoard);
assert.equal(lastOpsBody.ops[0].clock.otherTab, 1);

// Concurrent text edits in different regions merge instead of replacing each other.
assert.equal(sync.mergeTextValues("hello world", "hi world", "hello there"), "hi there");
assert.equal(sync.mergeTextValues("hello world", "hello world", "hello there"), "hello there");
assert.equal(sync.mergeTextValues("hello world", "hi world", "hello world"), "hi world");
assert.equal(sync.mergeTextValues("same", "same local", "same remote"), null);

sync._resetRuntimeForTests();
remote.doc = JSON.stringify({
  id: "b1",
  title: "Text merge",
  cards: [{ id: "cf", type: "note", text: "hello world" }],
  connections: [],
  trash: [],
});
remote.lastSeq = 0;
remote.revision = 1;
remoteOps = [];
appliedOpIds.clear();
const textBoard = {
  id: "b1",
  title: "Text merge",
  cards: [{ id: "cf", type: "note", text: "hello world" }],
  connections: [],
  trash: [],
  sync: { projectId: id, revision: 1, lastSeq: 0 },
};
await sync.attachRemoteBoard(textBoard, {
  projectId: id,
  revision: 1,
  lastSeq: 0,
  baseDoc: JSON.parse(remote.doc),
});
textBoard.cards[0].text = "hi world";
await sync.captureBoardChanges(textBoard);
applyRemoteOperation({ type: "card.update", payload: { id: "cf", patch: { text: "hello there" } } });
const textMerged = await sync.flushBoardNow(textBoard);
assert.equal(textMerged.status, "pushed");
assert.equal(JSON.parse(remote.doc).cards[0].text, "hi there");
assert.equal((await sync.readCachedBoard("b1")).fieldConflicts.length, 0);

// Overlapping text edits cannot merge, so the local value wins and the conflict is reported.
sync._resetRuntimeForTests();
remote.doc = JSON.stringify({
  id: "b1",
  title: "Text overlap",
  cards: [{ id: "cf", type: "note", text: "same" }],
  connections: [],
  trash: [],
});
remote.lastSeq = 0;
remote.revision = 1;
remoteOps = [];
appliedOpIds.clear();
const overlapBoard = {
  id: "b1",
  title: "Text overlap",
  cards: [{ id: "cf", type: "note", text: "same" }],
  connections: [],
  trash: [],
  sync: { projectId: id, revision: 1, lastSeq: 0 },
};
await sync.attachRemoteBoard(overlapBoard, {
  projectId: id,
  revision: 1,
  lastSeq: 0,
  baseDoc: JSON.parse(remote.doc),
});
overlapBoard.cards[0].text = "same local";
await sync.captureBoardChanges(overlapBoard);
applyRemoteOperation({ type: "card.update", payload: { id: "cf", patch: { text: "same remote" } } });
const overlapPush = await sync.flushBoardNow(overlapBoard);
assert.equal(overlapPush.status, "pushed");
assert.equal(JSON.parse(remote.doc).cards[0].text, "same local");
assert.equal((await sync.readCachedBoard("b1")).fieldConflicts.length, 1);
await sync.dismissFieldConflicts(overlapBoard);

// Queues are per tab: a queue left by another tab is drained instead of being overwritten.
sync._resetRuntimeForTests();
remote.doc = JSON.stringify({
  id: "b1",
  title: "Multi tab",
  cards: [{ id: "mt", type: "note", text: "base" }],
  connections: [],
  trash: [],
});
remote.lastSeq = 0;
remote.revision = 1;
remoteOps = [];
appliedOpIds.clear();
const multiBoard = {
  id: "b1",
  title: "Multi tab",
  cards: [{ id: "mt", type: "note", text: "base" }],
  connections: [],
  trash: [],
  sync: { projectId: id, revision: 1, lastSeq: 0 },
};
await sync.attachRemoteBoard(multiBoard, {
  projectId: id,
  revision: 1,
  lastSeq: 0,
  baseDoc: JSON.parse(remote.doc),
});
await syncStore.saveQueue({
  queueKey: "b1|other-tab",
  boardId: "b1",
  tabId: "other-tab",
  projectId: id,
  serverUrl: "",
  pendingOps: [
    {
      opId: "other-tab-op-1",
      type: "card.update",
      payload: { id: "mt", patch: { text: "other tab" } },
      createdAt: Date.now(),
    },
  ],
  attempts: 0,
  nextAttemptAt: 0,
  lastError: "",
  failed: false,
  conflict: false,
  updatedAt: Date.now(),
});
const otherTabFlush = await sync.flushQueue();
assert.equal(otherTabFlush.flushed >= 1, true);
assert.equal(JSON.parse(remote.doc).cards[0].text, "other tab");
assert.equal(await syncStore.loadQueue("b1", "other-tab"), null);

// Manual sync still pushes when only the local board changed, pulls when only the server changed,
// and reports a conflict when both changed.
board.updatedAt = board.sync.lastSyncedAt + 1000;
assert.equal((await sync.syncBoard(board)).status, "pushed");
const afterPush = board.sync.revision;
assert.equal(afterPush, remote.revision);

remote = {
  revision: afterPush + 1,
  lastSeq: remote.lastSeq,
  doc: JSON.stringify({ id: "server-board", title: "Server", cards: [], updatedAt: 3000 }),
};
board.updatedAt = board.sync.lastSyncedAt - 1;
const pulledBoard = await sync.syncBoard(board);
assert.equal(pulledBoard.status, "pulled");
assert.equal(pulledBoard.doc.id, board.id);
assert.equal(pulledBoard.doc.sync.revision, afterPush + 1);
// Mimic the UI adopting the pulled document before the next edit.
board.sync = pulledBoard.doc.sync;
board.title = pulledBoard.doc.title;
board.cards = pulledBoard.doc.cards;
board.connections = pulledBoard.doc.connections;
board.trash = pulledBoard.doc.trash;

remote = {
  revision: afterPush + 2,
  lastSeq: remote.lastSeq,
  doc: JSON.stringify({ id: "server-board", title: "Remote change", cards: [], updatedAt: 4000 }),
};
board.updatedAt = board.sync.lastSyncedAt + 1000;
const conflict = await sync.syncBoard(board);
assert.equal(conflict.status, "conflict");
assert.equal(conflict.remoteRevision, afterPush + 2);

// Granular live operations: different cards can be merged without replacing the whole document.
const liveBefore = {
  id: "b1",
  title: "Board",
  cards: [
    { id: "a", type: "note", text: "one", x: 0, y: 0 },
    { id: "b", type: "note", text: "two", x: 10, y: 10 },
  ],
  connections: [],
  trash: [],
};
const liveAfter = {
  ...liveBefore,
  title: "Live board",
  cards: [
    { id: "a", type: "note", text: "one edited", x: 0, y: 0 },
    { id: "b", type: "note", text: "two", x: 10, y: 10 },
    { id: "c", type: "note", text: "three", x: 20, y: 20 },
  ],
};
const liveOps = sync.diffBoardOperations(liveBefore, liveAfter);
assert.equal(liveOps.some((op) => op.type === "doc.title"), true);
assert.equal(liveOps.some((op) => op.type === "card.update" && op.payload.id === "a"), true);
assert.equal(liveOps.some((op) => op.type === "card.add" && op.payload.card.id === "c"), true);
const appliedLive = sync.applyBoardOperations(liveBefore, liveOps);
assert.equal(appliedLive.title, "Live board");
assert.equal(appliedLive.cards.find((card) => card.id === "a").text, "one edited");
assert.equal(appliedLive.cards.some((card) => card.id === "c"), true);
assert.deepEqual(sync.diffBoardOperations(liveBefore, { ...liveBefore, view: { x: 1 } }), []);
// A field removed on the card is sent as an explicit null tombstone.
const tombstoneOps = sync.diffBoardOperations(
  { cards: [{ id: "a", type: "note", headerImage: "hero.png" }], connections: [], trash: [] },
  { cards: [{ id: "a", type: "note" }], connections: [], trash: [] }
);
assert.equal(tombstoneOps.length, 1);
assert.equal(tombstoneOps[0].payload.patch.headerImage, null);

sync._resetRuntimeForTests();

console.log("PASS  sync config, sign-in, durable per-op queue, offline reload, merge, lock, conflict and failure states");
console.log(`${calls.length} fake service calls`);
