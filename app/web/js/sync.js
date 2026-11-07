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
    };
  } catch {
    return { url: "", email: "", token: "" };
  }
}

export function saveSyncConfig(config) {
  const url = normalizeServerUrl(config.url);
  const email = String(config.email || "").trim();
  const token = String(config.token || "").trim();
  storage().setItem(CONFIG_KEY, JSON.stringify({ url, email, token }));
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
