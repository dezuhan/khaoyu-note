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
    if (!raw) return { url: "", token: "" };
    const parsed = JSON.parse(raw);
    return { url: String(parsed.url || ""), token: String(parsed.token || "") };
  } catch {
    return { url: "", token: "" };
  }
}

export function saveSyncConfig(config) {
  const url = normalizeServerUrl(config.url);
  const token = String(config.token || "").trim();
  storage().setItem(CONFIG_KEY, JSON.stringify({ url, token }));
  connectionStatus.state = "unknown";
  connectionStatus.message = "Not checked";
  connectionStatus.url = "";
  connectionStatus.projectCount = null;
  connectionStatus.checkedAt = 0;
  return { url, token };
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
  projectCount: null,
  checkedAt: 0,
};

function recordConnection(state, message, extra = {}) {
  connectionStatus.state = state;
  connectionStatus.message = message;
  connectionStatus.url = extra.url || "";
  connectionStatus.projectCount = extra.projectCount ?? null;
  connectionStatus.checkedAt = Date.now();
  return { ok: state === "connected", ...connectionStatus };
}

const CONNECTION_LABELS = {
  unknown: "Connection not checked",
  checking: "Checking connection...",
  unconfigured: "Connection not configured",
  unreachable: "Server unreachable",
  "not-ready": "Server reachable, database not ready",
  unauthorized: "API token rejected",
  forbidden: "Token lacks projects:read",
  error: "Connection error",
  connected: "Connected",
};

export function describeConnection(status) {
  if (!status || status.state === "unknown") return CONNECTION_LABELS.unknown;
  if (status.state === "checking") return CONNECTION_LABELS.checking;
  if (status.state === "connected") {
    const projects =
      status.projectCount === null
        ? ""
        : `, ${status.projectCount} project${status.projectCount === 1 ? "" : "s"}`;
    return `Connected to ${status.url} · database ready${projects}`;
  }
  const label = CONNECTION_LABELS[status.state] || "Connection not checked";
  return `${label}: ${status.message}`;
}

// Check the server and the token against the real API. `/readyz` proves the service and its
// database respond; an authenticated `GET /projects` proves the token is valid and that the
// database round trip works for this account.
export async function checkConnection({ timeoutMs = 8000 } = {}) {
  let url;
  let token;
  try {
    const config = loadSyncConfig();
    url = normalizeServerUrl(config.url);
    token = String(config.token || "").trim();
  } catch (error) {
    return recordConnection("unconfigured", error.message || "Set the server URL and API token first");
  }
  if (!token) return recordConnection("unconfigured", "Set the server API token first", { url });

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
  return recordConnection("connected", message, { url, projectCount });
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
    throw new Error("Set the sync server API token first");
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
      lastSyncedAt: 0,
    };
  }
  return pushBoard(board);
}

export async function pushBoard(board) {
  if (!syncEnabled(board)) throw new Error("Sync is not enabled for this board");
  const baseRevision = board.sync.revision;
  const result = await api(`/api/v1/projects/${board.sync.projectId}/snapshot`, {
    method: "PUT",
    body: { doc: serializedBoard(board), revision: baseRevision },
  });
  board.sync.revision = result.revision;
  board.sync.lastSyncedAt = Date.now();
  board.sync.conflict = null;
  clearQueue(board.id);
  return { status: "pushed", revision: result.revision };
}

export async function pullBoard(board) {
  if (!syncEnabled(board)) throw new Error("Sync is not enabled for this board");
  const remote = await api(`/api/v1/projects/${board.sync.projectId}`);
  if (!remote.snapshot || !remote.snapshot.doc) return { status: "empty" };
  const revision = Number(remote.project.revision);
  if (revision <= board.sync.revision) return { status: "current", revision };
  const doc = JSON.parse(remote.snapshot.doc);
  doc.id = board.id;
  doc.sync = { ...board.sync, revision, lastSyncedAt: Date.now(), conflict: null };
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
    if (localChanged) return pushBoard(board);
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

export async function flushQueue() {
  const queue = loadQueue();
  if (!queue.length) return { flushed: 0 };
  const remaining = [];
  let flushed = 0;
  for (const entry of queue) {
    try {
      const result = await api(`/api/v1/projects/${entry.projectId}/snapshot`, {
        method: "PUT",
        body: { doc: entry.doc, revision: entry.baseRevision },
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
