// Opt-in project sync between a local board and the self-hosted service.
// The local board remains authoritative unless sync is enabled for it.

import * as bridge from "./bridge.js";

const CONFIG_KEY = "mn.sync.config";
const QUEUE_KEY = "mn.sync.queue";
const MAX_QUEUE = 20;

export const syncState = {
  status: "disabled",
  message: "Sync is off",
  boardId: null,
  revision: null,
};

function storage() {
  return globalThis.localStorage;
}

export function loadSyncConfig() {
  try {
    const raw = storage().getItem(CONFIG_KEY);
    if (!raw) return { url: "", email: "", token: "" };
    const parsed = JSON.parse(raw);
    return {
      url: String(parsed.url || ""),
      email: String(parsed.email || ""),
      token: String(parsed.token || ""),
      publicShareUrl: String(parsed.publicShareUrl || ""),
    };
  } catch {
    return { url: "", email: "", token: "", publicShareUrl: "" };
  }
}

export function saveSyncConfig(config) {
  const url = config.url ? normalizeServerUrl(config.url) : "";
  const email = String(config.email || "").trim();
  const token = String(config.token || "").trim();
  const publicShareUrl = config.publicShareUrl
    ? normalizeServerUrl(config.publicShareUrl)
    : "";
  storage().setItem(CONFIG_KEY, JSON.stringify({ url, email, token, publicShareUrl }));
  connectionStatus.state = "unknown";
  connectionStatus.message = "Not checked";
  connectionStatus.url = "";
  connectionStatus.email = "";
  connectionStatus.projectCount = null;
  connectionStatus.checkedAt = 0;
  return { url, email, token };
}

// A local service usually runs on http://localhost:PORT, so a bare host or host:port is accepted.
// Only loopback and private addresses get an automatic http scheme; anything else defaults to https
// so a typo in a remote host cannot silently downgrade the connection.
export function normalizeServerUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Enter the server URL");
  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    const authority = candidate.split("/")[0];
    const host = (
      authority.startsWith("[")
        ? authority.slice(1, authority.indexOf("]"))
        : authority.split(":")[0]
    ).toLowerCase();
    const local =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
    candidate = `${local ? "http" : "https"}://${candidate}`;
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("That is not a valid server URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Server URL must start with http:// or https://");
  }
  if (!parsed.hostname) throw new Error("Server URL needs a host");
  if (parsed.username || parsed.password) {
    throw new Error("Server URL must not contain credentials");
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${path}`;
}

export const connectionStatus = {
  state: "unknown",
  message: "Not checked",
  url: "",
  email: "",
  projectCount: null,
  checkedAt: 0,
};

function recordConnection(state, message, extra = {}) {
  connectionStatus.state = state;
  connectionStatus.message = message;
  connectionStatus.url = extra.url || "";
  connectionStatus.email = extra.email || "";
  connectionStatus.projectCount = extra.projectCount ?? null;
  connectionStatus.checkedAt = Date.now();
  return { ok: state === "connected" || state === "reachable", ...connectionStatus };
}

const CONNECTION_LABELS = {
  unknown: "Connection not checked",
  checking: "Checking connection...",
  unconfigured: "Connection not configured",
  unreachable: "Server unreachable",
  reachable: "Server reachable, database ready",
  "not-ready": "Server reachable, database not ready",
  unauthorized: "Sign in rejected",
  forbidden: "Account lacks project access",
  error: "Connection error",
  connected: "Connected",
};

export function describeConnection(status) {
  if (!status || status.state === "unknown") return CONNECTION_LABELS.unknown;
  if (status.state === "checking") return CONNECTION_LABELS.checking;
  if (status.state === "reachable") return `${CONNECTION_LABELS.reachable} · ${status.url}`;
  if (status.state === "connected") {
    const who = status.email ? ` as ${status.email}` : "";
    const projects =
      status.projectCount === null
        ? ""
        : `, ${status.projectCount} project${status.projectCount === 1 ? "" : "s"}`;
    return `Connected to ${status.url}${who} · database ready${projects}`;
  }
  const label = CONNECTION_LABELS[status.state] || "Connection not checked";
  return `${label}: ${status.message}`;
}

// Reachability check used before signing in: it proves the service and its database answer without
// needing credentials.
export async function checkServerReachable(url, { timeoutMs = 8000 } = {}) {
  let serverUrl;
  try {
    serverUrl = normalizeServerUrl(url);
  } catch (error) {
    return recordConnection("unconfigured", error.message || "Enter the server URL");
  }
  try {
    const ready = await fetch(`${serverUrl}/readyz`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!ready.ok) {
      return recordConnection("not-ready", `The server answered ${ready.status}`, { url: serverUrl });
    }
    return recordConnection("reachable", "Server reachable and database ready", { url: serverUrl });
  } catch {
    return recordConnection("unreachable", `No response from ${serverUrl}`, { url: serverUrl });
  }
}

// Sign in with email and password. The server returns a scoped project token; it is stored locally
// and never shown, so the board sync keeps using bearer auth without the user handling tokens.
export async function signIn({ url, email, password, timeoutMs = 10000 } = {}) {
  const serverUrl = normalizeServerUrl(url);
  const address = String(email || "").trim();
  if (!address) throw new Error("Enter the account email");
  if (!password) throw new Error("Enter the account password");
  let response;
  try {
    response = await fetch(`${serverUrl}/api/v1/auth/sync-token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email: address, password }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error(`No response from ${serverUrl}`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) throw new Error("Wrong email or password");
    if (response.status === 429) throw new Error("Too many attempts, wait a moment and try again");
    throw new Error(body?.error || `Sign in failed (${response.status})`);
  }
  if (!body?.token) throw new Error("The server did not return a sync token");
  storage().setItem(
    CONFIG_KEY,
    JSON.stringify({
      url: serverUrl,
      email: String(body.email || address),
      token: body.token,
      publicShareUrl: loadSyncConfig().publicShareUrl || "",
    })
  );
  return loadSyncConfig();
}

export function signOut() {
  const config = loadSyncConfig();
  storage().setItem(CONFIG_KEY, JSON.stringify({ url: config.url, email: "", token: "" }));
  connectionStatus.state = "unknown";
  connectionStatus.message = "Not checked";
  connectionStatus.url = "";
  connectionStatus.email = "";
  connectionStatus.projectCount = null;
  connectionStatus.checkedAt = 0;
  return loadSyncConfig();
}

// Check the server and the token against the real API. `/readyz` proves the service and its
// database respond; an authenticated `GET /projects` proves the token is valid and that the
// database round trip works for this account.
export async function checkConnection({ timeoutMs = 8000 } = {}) {
  let url;
  let email;
  let token;
  try {
    const config = loadSyncConfig();
    url = normalizeServerUrl(config.url);
    email = String(config.email || "").trim();
    token = String(config.token || "").trim();
  } catch (error) {
    return recordConnection("unconfigured", error.message || "Enter the server URL first");
  }
  if (!token) {
    return recordConnection("unconfigured", "Sign in with your email and password", { url, email });
  }

  // `/readyz` can be blocked by CORS on an older service, so a failed readiness call is not proof
  // that the server is unreachable. The authenticated project call below is the deciding check.
  let readiness = "ok";
  try {
    const ready = await fetch(`${url}/readyz`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!ready.ok) {
      return recordConnection("not-ready", `The server answered ${ready.status}`, { url });
    }
  } catch {
    readiness = "unknown";
  }

  let response;
  try {
    response = await fetch(`${url}/api/v1/projects`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return recordConnection("unreachable", `No response from ${url}`, { url });
  }
  if (response.status === 401) {
    return recordConnection("unauthorized", "The API token was rejected", { url });
  }
  if (response.status === 403) {
    return recordConnection("forbidden", "The token is missing the projects:read scope", { url });
  }
  if (!response.ok) {
    return recordConnection("error", `The server answered ${response.status}`, { url });
  }
  const body = await response.json().catch(() => null);
  const projectCount = Array.isArray(body?.projects) ? body.projects.length : null;
  const message =
    readiness === "ok" ? "Connected and database ready" : "Connected and database answered";
  return recordConnection("connected", message, { url, email, projectCount });
}

export function syncEnabled(board) {
  return Boolean(board && board.sync && board.sync.projectId);
}

export function syncStatusFor(board) {
  if (!syncEnabled(board)) return { status: "disabled", message: "Sync is off" };
  const queue = loadQueue();
  if (queue.some((entry) => entry.boardId === board.id)) {
    return { status: "offline", message: "Waiting to sync" };
  }
  if (board.sync.conflict) return { status: "conflict", message: "Sync conflict" };
  return {
    status: "synced",
    message: board.sync.lastSyncedAt ? `Synced ${new Date(board.sync.lastSyncedAt).toLocaleTimeString()}` : "Not synced yet",
  };
}

function requireConfig() {
  const config = loadSyncConfig();
  if (!config.token) {
    throw new Error("Sign in to the sync server first");
  }
  return { url: normalizeServerUrl(config.url), token: config.token };
}

async function api(pathname, { method = "GET", body } = {}) {
  const config = requireConfig();
  let response;
  try {
    response = await fetch(config.url + pathname, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    const offline = new Error("offline");
    offline.offline = true;
    throw offline;
  }
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const error = new Error(parsed?.error || `sync failed (${response.status})`);
    error.status = response.status;
    error.code = parsed?.code;
    error.body = parsed;
    throw error;
  }
  return parsed;
}

const liveBases = new Map();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function documentFromBoard(board) {
  const copy = clone(board);
  delete copy.sync;
  return copy;
}

function rememberBase(board, doc) {
  if (!board || !doc) return;
  const base = clone(doc);
  delete base.sync;
  liveBases.set(board.id, base);
}

export function forgetLiveBase(boardId) {
  liveBases.delete(boardId);
}

export function diffBoardOperations(from, to) {
  if (!from || !to) return [{ type: "doc.replace", payload: { doc: clone(to) } }];
  const operations = [];
  if (String(from.title || "") !== String(to.title || "")) {
    operations.push({ type: "doc.title", payload: { title: String(to.title || "").slice(0, 200) } });
  }
  const before = new Map((from.cards || []).map((card) => [card.id, card]));
  const after = new Map((to.cards || []).map((card) => [card.id, card]));
  for (const [id, card] of after) {
    if (!before.has(id)) {
      operations.push({ type: "card.add", payload: { card: clone(card) } });
    }
  }
  for (const id of before.keys()) {
    if (!after.has(id)) operations.push({ type: "card.delete", payload: { id } });
  }
  for (const [id, card] of after) {
    const previous = before.get(id);
    if (!previous) continue;
    const patch = {};
    for (const [key, value] of Object.entries(card)) {
      if (["id", "type"].includes(key)) continue;
      if (JSON.stringify(previous[key]) !== JSON.stringify(value)) patch[key] = clone(value);
    }
    if (Object.keys(patch).length) operations.push({ type: "card.update", payload: { id, patch } });
  }
  const connectionsChanged = JSON.stringify(from.connections || []) !== JSON.stringify(to.connections || []);
  const trashChanged = JSON.stringify(from.trash || []) !== JSON.stringify(to.trash || []);
  const otherKeys = ["parentId", "archivedAt"];
  const otherChanged = otherKeys.some((key) => JSON.stringify(from[key]) !== JSON.stringify(to[key]));
  if (connectionsChanged || trashChanged || otherChanged) {
    return [{ type: "doc.replace", payload: { doc: clone(to) } }];
  }
  if (!operations.length) return [];
  if (operations.length > 200) return [{ type: "doc.replace", payload: { doc: clone(to) } }];
  return operations;
}

export function applyBoardOperations(document, operations) {
  return applyOperationsToDocument(document, operations);
}

function applyOperationsToDocument(document, operations) {
  const doc = clone(document);
  if (!Array.isArray(doc.cards)) doc.cards = [];
  if (!Array.isArray(doc.connections)) doc.connections = [];
  if (!Array.isArray(doc.trash)) doc.trash = [];
  for (const operation of operations || []) {
    const payload = operation.payload || {};
    if (operation.type === "doc.replace" && payload.doc) {
      doc.id = payload.doc.id ?? doc.id;
      doc.title = payload.doc.title ?? doc.title;
      doc.cards = Array.isArray(payload.doc.cards) ? payload.doc.cards : [];
      doc.connections = Array.isArray(payload.doc.connections) ? payload.doc.connections : [];
      doc.trash = Array.isArray(payload.doc.trash) ? payload.doc.trash : [];
    } else if (operation.type === "doc.title") {
      doc.title = String(payload.title || "").slice(0, 200);
    } else if (operation.type === "card.add" && payload.card?.id) {
      if (!doc.cards.some((card) => card.id === payload.card.id)) doc.cards.push(clone(payload.card));
    } else if (operation.type === "card.update" && payload.id) {
      const card = doc.cards.find((entry) => entry.id === payload.id);
      if (card && payload.patch) Object.assign(card, clone(payload.patch));
    } else if (operation.type === "card.delete" && payload.id) {
      const removed = new Set([payload.id]);
      const queue = [payload.id];
      while (queue.length) {
        const current = queue.shift();
        for (const card of doc.cards) {
          if (card.parentId === current && !removed.has(card.id)) {
            removed.add(card.id);
            queue.push(card.id);
          }
        }
      }
      doc.cards = doc.cards.filter((card) => !removed.has(card.id));
      doc.connections = doc.connections.filter(
        (connection) => !removed.has(connection.from) && !removed.has(connection.to)
      );
    } else if (operation.type === "card.move" && payload.id) {
      const card = doc.cards.find((entry) => entry.id === payload.id);
      if (card) {
        for (const key of ["x", "y", "order"]) {
          if (payload[key] !== undefined) card[key] = Number(payload[key]);
        }
        if (payload.parentId !== undefined) card.parentId = payload.parentId;
      }
    }
  }
  return doc;
}

async function replayOperations(board, after) {
  let cursor = after;
  const applied = [];
  for (let page = 0; page < 10; page += 1) {
    const data = await api(
      `/api/v1/projects/${board.sync.projectId}/ops?after=${encodeURIComponent(String(cursor))}&limit=500`
    );
    applied.push(...(data.ops || []));
    cursor = Number(data.lastSeq);
    if (!data.hasMore) return { ops: applied, lastSeq: cursor, revision: data.revision };
  }
  return { ops: applied, lastSeq: cursor, revision: undefined };
}

export async function pushLiveChanges(board) {
  if (!syncEnabled(board)) return { status: "disabled" };
  let base = liveBases.get(board.id);
  if (!base) {
    const remote = await api(`/api/v1/projects/${board.sync.projectId}`);
    if (remote.snapshot?.doc) {
      base = JSON.parse(remote.snapshot.doc);
      base.id = board.id;
      rememberBase(board, base);
      board.sync.revision = Number(remote.project.revision);
      board.sync.lastSeq = Number(remote.project.lastSeq || 0);
    }
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = documentFromBoard(board);
    const operations = diffBoardOperations(base, current);
    if (!operations.length) {
      return { status: "noop", lastSeq: Number(board.sync.lastSeq || 0) };
    }
    try {
      const result = await api(`/api/v1/projects/${board.sync.projectId}/ops`, {
        method: "POST",
        body: {
          baseSeq: Number(board.sync.lastSeq || 0),
          ops: operations.map((operation) => ({
            opId: `live-${crypto.randomUUID()}`,
            ...operation,
          })),
        },
      });
      board.sync.revision = result.revision;
      board.sync.lastSeq = result.lastSeq;
      board.sync.lastSyncedAt = Date.now();
      board.sync.conflict = null;
      rememberBase(board, current);
      clearQueue(board.id);
      return { status: "pushed", ops: operations.length, lastSeq: result.lastSeq };
    } catch (error) {
      if (error.code !== "seq_conflict" || attempt >= 2) throw error;
      const replay = await replayOperations(board, Number(board.sync.lastSeq || 0));
      base = applyOperationsToDocument(base || {}, replay.ops);
      rememberBase(board, base);
      board.sync.lastSeq = replay.lastSeq;
      if (replay.revision !== undefined) board.sync.revision = replay.revision;
    }
  }
  return { status: "conflict", lastSeq: Number(board.sync.lastSeq || 0) };
}

export async function consumeRemoteOperations(board) {
  if (!syncEnabled(board)) return { status: "disabled" };
  try {
    const replay = await replayOperations(board, Number(board.sync.lastSeq || 0));
    if (!replay.ops.length) return { status: "current", lastSeq: replay.lastSeq };
    const currentBase = liveBases.get(board.id) || documentFromBoard(board);
    const nextBase = applyOperationsToDocument(currentBase, replay.ops);
    rememberBase(board, nextBase);
    board.sync.lastSeq = replay.lastSeq;
    if (replay.revision !== undefined) board.sync.revision = replay.revision;
    board.sync.lastSyncedAt = Date.now();
    board.sync.conflict = null;
    const doc = applyOperationsToDocument(documentFromBoard(board), replay.ops);
    // Viewport/theme are per-device preferences, not shared board content.
    for (const key of ["view", "grid", "showGrid", "theme"]) {
      if (board[key] !== undefined) doc[key] = clone(board[key]);
    }
    doc.sync = { ...board.sync };
    return { status: "applied", doc, lastSeq: replay.lastSeq };
  } catch (error) {
    if (error.code === "resync_required") {
      const pulled = await pullBoard(board);
      return { status: "resync", doc: pulled.doc };
    }
    throw error;
  }
}

function serializedBoard(board) {
  const copy = JSON.parse(JSON.stringify(board));
  delete copy.sync;
  return JSON.stringify(copy);
}

function loadQueue() {
  try {
    return JSON.parse(storage().getItem(QUEUE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveQueue(queue) {
  storage().setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE)));
}

function enqueue(board) {
  if (!syncEnabled(board)) return;
  const queue = loadQueue().filter((entry) => entry.boardId !== board.id);
  queue.push({
    boardId: board.id,
    projectId: board.sync.projectId,
    baseRevision: board.sync.revision,
    baseSeq: Number(board.sync.lastSeq || 0),
    doc: serializedBoard(board),
    queuedAt: Date.now(),
  });
  saveQueue(queue);
}

export function clearQueue(boardId) {
  saveQueue(loadQueue().filter((entry) => entry.boardId !== boardId));
}

export async function enableBoardSync(board) {
  if (!board) throw new Error("No board is open");
  const config = requireConfig();
  void config;
  if (!board.sync?.projectId) {
    let parentProjectId = null;
    if (board.parentId) {
      try {
        const parentRaw = await bridge.loadBoard(board.parentId);
        const parent = parentRaw ? JSON.parse(parentRaw) : null;
        parentProjectId = parent?.sync?.projectId || null;
      } catch {
        parentProjectId = null;
      }
    }
    const created = await api("/api/v1/projects", {
      method: "POST",
      body: { title: board.title || "Untitled board", parentProjectId },
    });
    board.sync = {
      projectId: created.id,
      revision: created.revision || 1,
      lastSeq: 0,
      lastSyncedAt: 0,
    };
  }
  return pushBoard(board);
}

export async function pushBoard(board) {
  if (!syncEnabled(board)) throw new Error("Sync is not enabled for this board");
  const baseSeq = Number(board.sync.lastSeq || 0);
  const result = await api(`/api/v1/projects/${board.sync.projectId}/ops`, {
    method: "POST",
    body: {
      baseSeq,
      ops: [
        {
          opId: `client-${crypto.randomUUID()}`,
          type: "doc.replace",
          payload: { doc: JSON.parse(serializedBoard(board)) },
        },
      ],
    },
  });
  board.sync.revision = result.revision;
  board.sync.lastSeq = result.lastSeq;
  board.sync.lastSyncedAt = Date.now();
  board.sync.conflict = null;
  rememberBase(board, board);
  clearQueue(board.id);
  return { status: "pushed", revision: result.revision, lastSeq: result.lastSeq };
}

export async function pullBoard(board) {
  if (!syncEnabled(board)) throw new Error("Sync is not enabled for this board");
  const remote = await api(`/api/v1/projects/${board.sync.projectId}`);
  if (!remote.snapshot || !remote.snapshot.doc) return { status: "empty" };
  const revision = Number(remote.project.revision);
  if (revision <= board.sync.revision) return { status: "current", revision };
  const doc = JSON.parse(remote.snapshot.doc);
  doc.id = board.id;
  doc.sync = {
    ...board.sync,
    revision,
    lastSeq: Number(remote.project.lastSeq ?? board.sync.lastSeq ?? 0),
    lastSyncedAt: Date.now(),
    conflict: null,
  };
  rememberBase(board, doc);
  return { status: "pulled", revision, doc };
}

async function forcePushAtCurrentRevision(board) {
  const remote = await api(`/api/v1/projects/${board.sync.projectId}`);
  board.sync.revision = Number(remote.project.revision);
  return pushBoard(board);
}

export async function resolveSyncConflict(board, choice) {
  if (!syncEnabled(board)) throw new Error("Sync is not enabled for this board");
  if (choice === "server") return pullBoard(board);
  if (choice === "local") return forcePushAtCurrentRevision(board);
  throw new Error("Unknown conflict choice");
}

export async function syncBoard(board) {
  if (!board) return { status: "disabled" };
  if (!syncEnabled(board)) return { status: "disabled" };
  const remote = await api(`/api/v1/projects/${board.sync.projectId}`);
  const remoteRevision = Number(remote.project.revision);
  const baseRevision = Number(board.sync.revision || 0);
  const localChanged = Number(board.updatedAt || 0) > Number(board.sync.lastSyncedAt || 0);
  if (remoteRevision <= baseRevision) {
    if (localChanged) {
      try {
        return await pushBoard(board);
      } catch (error) {
        if (error.code !== "seq_conflict") throw error;
        const latest = await api(`/api/v1/projects/${board.sync.projectId}`);
        return {
          status: "conflict",
          remoteRevision: Number(latest.project.revision),
          baseRevision,
          remoteDoc: latest.snapshot?.doc ? JSON.parse(latest.snapshot.doc) : null,
        };
      }
    }
    return { status: "current", revision: baseRevision };
  }
  if (!localChanged) return pullBoard(board);
  return {
    status: "conflict",
    remoteRevision,
    baseRevision,
    remoteDoc: remote.snapshot?.doc ? JSON.parse(remote.snapshot.doc) : null,
  };
}

export async function fetchOps(board, after = 0) {
  if (!syncEnabled(board)) throw new Error("Sync is not enabled for this board");
  return api(`/api/v1/projects/${board.sync.projectId}/ops?after=${encodeURIComponent(String(after))}`);
}

// Opens the single-use-ticket SSE stream for a synced board. The caller decides whether to adopt a
// remote document; the stream itself only reports that a change is available.
export async function openRealtime(board, { onUpdate, onStatus } = {}) {
  if (!syncEnabled(board)) throw new Error("Sync is not enabled for this board");
  if (typeof EventSource === "undefined") return { close() {}, supported: false };
  const config = requireConfig();
  const ticket = await api(`/api/v1/projects/${board.sync.projectId}/realtime-ticket`, {
    method: "POST",
  });
  const source = new EventSource(
    `${config.url}/api/v1/projects/${board.sync.projectId}/events?ticket=${encodeURIComponent(ticket.token)}`
  );
  for (const type of ["ops", "snapshot", "presence"]) {
    source.addEventListener(type, (event) => {
      try {
        onUpdate?.({ type, data: JSON.parse(event.data) });
      } catch {
        onUpdate?.({ type, data: null });
      }
    });
  }
  source.onerror = () => onStatus?.("offline");
  source.onopen = () => onStatus?.("connected");
  return {
    supported: true,
    close() {
      source.close();
    },
  };
}

export async function flushQueue() {
  const queue = loadQueue();
  if (!queue.length) return { flushed: 0 };
  const remaining = [];
  let flushed = 0;
  for (const entry of queue) {
    try {
      const result = await api(`/api/v1/projects/${entry.projectId}/ops`, {
        method: "POST",
        body: {
          baseSeq: Number(entry.baseSeq || 0),
          ops: [
            {
              opId: `offline-${crypto.randomUUID()}`,
              type: "doc.replace",
              payload: { doc: JSON.parse(entry.doc) },
            },
          ],
        },
      });
      void result;
      flushed += 1;
    } catch {
      remaining.push(entry);
    }
  }
  saveQueue(remaining);
  return { flushed, remaining: remaining.length };
}

export function enqueueForOffline(board) {
  enqueue(board);
}
