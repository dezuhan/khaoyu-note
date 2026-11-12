// Opt-in project sync between a local board and the self-hosted service.
// The local board remains authoritative unless sync is enabled for it.
//
// Every change is captured as a granular operation, appended to a durable per-board queue
// (sync-store.js) and flushed in the background. A remote workspace board therefore survives
// reloads, offline periods and failed pushes without replacing the whole document.

import * as localStore from "./sync-store.js";

const CONFIG_KEY = "ky.sync.config";
const MAX_BATCH_OPS = 200;
const MAX_PENDING_OPS = 4000;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;
const RETRY_LOCKED_MS = 10000;

// `crypto.randomUUID` is only available in secure contexts, but the web host is documented to run
// on a plain-HTTP LAN address. A local id keeps the queue working there too.
function operationId() {
  try {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Pending operations are stored per tab: two tabs on the same board would otherwise overwrite each
// other's queue record whenever they persist it.
function sessionTabId() {
  const key = "ky.sync.tab";
  try {
    const storageArea = globalThis.sessionStorage;
    if (!storageArea) return `tab-${operationId()}`;
    const existing = storageArea.getItem(key);
    if (existing) return existing;
    const created = `tab-${operationId()}`;
    storageArea.setItem(key, created);
    return created;
  } catch {
    return `tab-${operationId()}`;
  }
}

const TAB_ID = sessionTabId();

function queueKeyFor(boardId) {
  return localStore.queueKeyFor(boardId, TAB_ID);
}

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

function requireConfig() {
  const config = loadSyncConfig();
  if (!config.token) {
    const error = new Error("Sign in to the sync server first");
    error.code = "not_signed_in";
    throw error;
  }
  return { url: normalizeServerUrl(config.url), token: config.token };
}

function findServerToken(serverUrl) {
  try {
    const entries = JSON.parse(storage().getItem("ky.servers") || "[]");
    if (!Array.isArray(entries)) return "";
    const match = entries.find((entry) => {
      if (!entry?.token || !entry?.url) return false;
      try {
        return normalizeServerUrl(entry.url) === serverUrl;
      } catch {
        return false;
      }
    });
    return match?.token || "";
  } catch {
    return "";
  }
}

// Each record remembers the server it belongs to. When several servers are saved this must win over
// the last configured server, otherwise a queue could be posted to the wrong instance.
function credentialsFor(serverUrl) {
  const config = loadSyncConfig();
  const target = serverUrl || (config.url ? normalizeServerUrl(config.url) : "");
  if (!target) {
    const error = new Error("Enter the server URL");
    error.code = "not_signed_in";
    throw error;
  }
  let token = config.token;
  if (serverUrl && normalizeServerUrl(config.url || "") !== serverUrl) {
    token = findServerToken(serverUrl);
  }
  if (!token) {
    const error = new Error("Sign in to the sync server first");
    error.code = "not_signed_in";
    throw error;
  }
  return { url: target, token };
}

async function api(pathname, { method = "GET", body, serverUrl = "", timeoutMs = 20000 } = {}) {
  const config = credentialsFor(serverUrl);
  let response;
  try {
    response = await fetch(config.url + pathname, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
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

// --- Durable queue and status -------------------------------------------------------------

const runtime = new Map();
const priming = new Set();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function documentFromBoard(board) {
  const copy = clone(board);
  delete copy.sync;
  return copy;
}

function serializedBoard(board) {
  const copy = JSON.parse(JSON.stringify(board));
  delete copy.sync;
  return JSON.stringify(copy);
}

function normalizeClockObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const clock = {};
  for (const [key, rawCount] of Object.entries(value)) {
    const count = Number(rawCount);
    if (!key || !Number.isFinite(count) || count < 0) continue;
    clock[String(key).slice(0, 80)] = Math.floor(count);
    if (Object.keys(clock).length >= 64) break;
  }
  return clock;
}

function mergeClockObjects(first, second) {
  const merged = { ...normalizeClockObject(first) };
  for (const [key, count] of Object.entries(normalizeClockObject(second))) {
    merged[key] = Math.max(Number(merged[key] || 0), count);
  }
  return merged;
}

// The server reports a concurrent field write in the ops response. Keep the notice list bounded and
// de-duplicated by card and field.
function mergeFieldConflictLists(existing, incoming) {
  const merged = [];
  const seen = new Set();
  for (const conflict of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!conflict?.cardId || !conflict?.field) continue;
    const key = `${conflict.cardId}|${conflict.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(conflict);
    if (merged.length >= 50) break;
  }
  return merged;
}

function boardPayload(record) {
  return {
    boardId: record.boardId,
    projectId: record.projectId || "",
    serverUrl: record.serverUrl || "",
    doc: record.doc || null,
    baseDoc: record.baseDoc || null,
    revision: Number(record.revision || 0),
    lastSeq: Number(record.lastSeq || 0),
    fieldConflicts: Array.isArray(record.fieldConflicts) ? record.fieldConflicts : [],
    clock: record.clock && typeof record.clock === "object" ? record.clock : {},
    lastSyncedAt: Number(record.lastSyncedAt || 0),
    updatedAt: Date.now(),
  };
}

function queuePayload(record) {
  return {
    queueKey: record.queueKey || queueKeyFor(record.boardId),
    boardId: record.boardId,
    tabId: record.tabId || TAB_ID,
    projectId: record.projectId || "",
    serverUrl: record.serverUrl || "",
    pendingOps: Array.isArray(record.pendingOps) ? record.pendingOps : [],
    attempts: Number(record.attempts || 0),
    nextAttemptAt: Number(record.nextAttemptAt || 0),
    lastError: String(record.lastError || ""),
    failed: Boolean(record.failed),
    conflict: Boolean(record.conflict),
    updatedAt: Date.now(),
  };
}

async function persistRecord(record) {
  record.updatedAt = Date.now();
  await localStore.saveRecord(boardPayload(record));
  const queue = queuePayload(record);
  if (queue.pendingOps.length || queue.failed || queue.conflict) {
    await localStore.saveQueue(queue);
  } else {
    await localStore.deleteQueue(queue.queueKey);
  }
}

function applyRecordToBoard(record) {
  const board = record.boardRef;
  if (!board || !board.sync) return;
  board.sync = {
    ...board.sync,
    projectId: record.projectId,
    revision: record.revision,
    lastSeq: record.lastSeq,
    lastSyncedAt: record.lastSyncedAt,
    serverUrl: record.serverUrl || board.sync.serverUrl || "",
  };
  if (record.conflict) board.sync.conflict = true;
  else delete board.sync.conflict;
}

function describeRecord(record, { ignoreFlight = false } = {}) {
  const pending = record.pendingOps?.length || 0;
  if (!ignoreFlight && record.inFlight) {
    return {
      status: "syncing",
      message: `Syncing ${pending} change${pending === 1 ? "" : "s"}...`,
      pending,
    };
  }
  if (record.conflict) return { status: "conflict", message: "Sync conflict", pending };
  if (record.failed) {
    return {
      status: "failed",
      message: record.lastError ? `Sync failed: ${record.lastError}` : "Sync failed",
      pending,
    };
  }
  const fieldConflicts = record.fieldConflicts?.length || 0;
  const conflictSuffix = fieldConflicts
    ? ` · ${fieldConflicts} field conflict${fieldConflicts === 1 ? "" : "s"} kept local`
    : "";
  if (pending) {
    const retryIn = Math.max(0, Math.ceil((Number(record.nextAttemptAt || 0) - Date.now()) / 1000));
    if (record.lastError === "card_locked") {
      return { status: "blocked", message: "Waiting for a card lock to clear", pending };
    }
    let detail = `${pending} change${pending === 1 ? "" : "s"} waiting`;
    if (record.lastError === "offline") detail = `Offline · ${detail}`;
    else if (record.lastError) detail = `${detail} · ${record.lastError}`;
    if (retryIn > 0) detail += ` · retry in ${retryIn}s`;
    return { status: "pending", message: detail, pending, fieldConflicts };
  }
  return {
    status: "synced",
    message: (record.lastSyncedAt
      ? `Synced ${new Date(record.lastSyncedAt).toLocaleTimeString()}`
      : "Not synced yet") + conflictSuffix,
    pending: 0,
    fieldConflicts,
  };
}

export function syncStatusFor(board) {
  if (!syncEnabled(board)) return { status: "disabled", message: "Sync is off" };
  const record = runtime.get(board.id);
  if (record) return describeRecord(record);
  if (board.sync.conflict) return { status: "conflict", message: "Sync conflict" };
  return {
    status: "synced",
    message: board.sync.lastSyncedAt
      ? `Synced ${new Date(board.sync.lastSyncedAt).toLocaleTimeString()}`
      : "Not synced yet",
  };
}

export function pendingInfoFor(board) {
  const record = board?.id ? runtime.get(board.id) : null;
  if (!record) {
    return {
      pending: 0,
      nextAttemptAt: 0,
      lastError: "",
      conflict: false,
      fieldConflicts: [],
      storage: localStore.storageKind(),
    };
  }
  return {
    pending: record.pendingOps.length,
    nextAttemptAt: record.nextAttemptAt,
    lastError: record.lastError,
    conflict: Boolean(record.conflict),
    fieldConflicts: Array.isArray(record.fieldConflicts) ? record.fieldConflicts : [],
    storage: localStore.storageKind(),
  };
}

function emitStatus(record) {
  applyRecordToBoard(record);
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(
    new CustomEvent("mn:sync-status", {
      detail: { boardId: record.boardId, status: describeRecord(record) },
    })
  );
}

function fromPersisted(persisted, queue, board) {
  const legacy = Array.isArray(persisted?.pendingOps) ? persisted.pendingOps : [];
  const pendingOps = Array.isArray(queue?.pendingOps) && queue.pendingOps.length ? queue.pendingOps : legacy;
  const record = {
    ...(persisted || {}),
    pendingOps,
    fieldConflicts: Array.isArray(persisted?.fieldConflicts) ? persisted.fieldConflicts : [],
    clock: normalizeClockObject(persisted?.clock),
    attempts: Number(queue?.attempts ?? persisted?.attempts ?? 0),
    nextAttemptAt: Number(queue?.nextAttemptAt ?? persisted?.nextAttemptAt ?? 0),
    lastError: String(queue?.lastError ?? persisted?.lastError ?? ""),
    failed: Boolean(queue?.failed ?? persisted?.failed),
    conflict: Boolean(queue?.conflict ?? persisted?.conflict),
    tabId: TAB_ID,
    queueKey: queue?.queueKey || queueKeyFor(persisted?.boardId || ""),
    inFlight: null,
    retryTimer: 0,
    flushTimer: 0,
    boardRef: board || null,
  };
  if (!record.doc && record.baseDoc) record.doc = applyBoardOperations(record.baseDoc, record.pendingOps);
  if (!record.baseDoc && record.doc) record.baseDoc = clone(record.doc);
  return record;
}

// Load a persisted record into memory once so the status pill reflects queued work right after a
// reload, without waiting for the user to edit the board.
export async function primeBoard(board) {
  if (!syncEnabled(board) || runtime.has(board.id) || priming.has(board.id)) return null;
  priming.add(board.id);
  try {
    const [persisted, queue] = await Promise.all([
      localStore.loadRecord(board.id),
      localStore.loadQueue(board.id, TAB_ID),
    ]);
    if (!persisted && !queue) return null;
    if (runtime.has(board.id)) return describeRecord(runtime.get(board.id));
    const record = fromPersisted(persisted, queue, board);
    record.projectId = record.projectId || board.sync.projectId;
    runtime.set(board.id, record);
    emitStatus(record);
    return describeRecord(record);
  } finally {
    priming.delete(board.id);
  }
}

export async function readCachedBoard(boardId) {
  const cached = runtime.get(boardId);
  if (cached) return cached;
  const [persisted, queue] = await Promise.all([
    localStore.loadRecord(boardId),
    localStore.loadQueue(boardId, TAB_ID),
  ]);
  return persisted || queue ? fromPersisted(persisted, queue, null) : null;
}

async function ensureAttached(board, info = {}) {
  if (!board) throw new Error("No board is open");
  if (!board.sync?.projectId && !info.projectId) {
    throw new Error("Sync is not enabled for this board");
  }
  const existing = runtime.get(board.id);
  if (existing) {
    existing.boardRef = board;
    if (info.projectId) existing.projectId = info.projectId;
    if (info.serverUrl) existing.serverUrl = info.serverUrl;
    return existing;
  }
  const [persisted, queue] = await Promise.all([
    localStore.loadRecord(board.id),
    localStore.loadQueue(board.id, TAB_ID),
  ]);
  const current = documentFromBoard(board);
  let record;
  if (persisted || queue) {
    record = fromPersisted(persisted, queue, board);
    record.doc = current;
    if (info.projectId) record.projectId = info.projectId;
    if (info.serverUrl) record.serverUrl = info.serverUrl;
    if (!record.pendingOps.length) {
      if (info.baseDoc) record.baseDoc = clone(info.baseDoc);
      if (info.revision !== undefined) record.revision = Number(info.revision);
      if (info.lastSeq !== undefined) record.lastSeq = Number(info.lastSeq);
      if (info.lastSyncedAt) record.lastSyncedAt = Number(info.lastSyncedAt);
    }
  } else {
    record = {
      boardId: board.id,
      projectId: info.projectId || board.sync.projectId,
      serverUrl: info.serverUrl || "",
      doc: current,
      baseDoc: clone(info.baseDoc || current),
      revision: Number(info.revision ?? board.sync.revision ?? 1),
      lastSeq: Number(info.lastSeq ?? board.sync.lastSeq ?? 0),
      pendingOps: [],
      fieldConflicts: [],
      clock: {},
      attempts: 0,
      nextAttemptAt: 0,
      lastError: "",
      failed: false,
      conflict: false,
      lastSyncedAt: Number(info.lastSyncedAt || Date.now()),
      inFlight: null,
      retryTimer: 0,
      flushTimer: 0,
      tabId: TAB_ID,
      queueKey: queueKeyFor(board.id),
      boardRef: board,
    };
  }
  runtime.set(board.id, record);
  await persistRecord(record);
  emitStatus(record);
  return record;
}

// Attach a freshly opened remote board to its durable mirror. When the cache still holds pending
// operations they win over the server snapshot: the flush below replays the remote changes and then
// resends the local patches, so neither side is dropped.
export async function attachRemoteBoard(board, info = {}) {
  const record = await ensureAttached(board, info);
  const current = documentFromBoard(board);
  record.doc = current;
  record.boardRef = board;
  if (info.projectId) record.projectId = info.projectId;
  if (info.serverUrl) record.serverUrl = info.serverUrl;
  if (!record.pendingOps.length) {
    if (info.baseDoc) record.baseDoc = clone(info.baseDoc);
    if (info.revision !== undefined) record.revision = Number(info.revision);
    if (info.lastSeq !== undefined) record.lastSeq = Number(info.lastSeq);
    if (info.lastSyncedAt) record.lastSyncedAt = Number(info.lastSyncedAt);
  }
  await persistRecord(record);
  emitStatus(record);
  return record;
}

// Capture local edits since the last capture as granular operations. This runs on every save, not
// only after a failure, so the durable record is always the source of truth.
export async function captureBoardChanges(board) {
  if (!syncEnabled(board)) return { status: "disabled", captured: 0, pending: 0 };
  const record = await ensureAttached(board);
  const current = documentFromBoard(board);
  const operations = diffBoardOperations(record.doc, current);
  record.doc = current;
  record.boardRef = board;
  if (operations.length) {
    const clock = { ...normalizeClockObject(record.clock) };
    clock[TAB_ID] = (Number(clock[TAB_ID]) || 0) + 1;
    record.clock = clock;
    for (const operation of operations) {
      record.pendingOps.push({
        opId: `op-${operationId()}`,
        type: operation.type,
        payload: operation.payload,
        clock: clone(clock),
        createdAt: Date.now(),
      });
    }
    if (record.pendingOps.length > MAX_PENDING_OPS) {
      record.pendingOps = [
        {
          opId: `op-${operationId()}`,
          type: "doc.replace",
          payload: { doc: clone(current) },
          createdAt: Date.now(),
        },
      ];
      record.lastError = "queue overflow";
    }
    record.failed = false;
    if (!record.conflict) record.nextAttemptAt = 0;
  }
  await persistRecord(record);
  emitStatus(record);
  return {
    status: operations.length ? "captured" : "unchanged",
    captured: operations.length,
    pending: record.pendingOps.length,
  };
}

export function scheduleFlush(board, delayMs = 0) {
  const record = board?.id ? runtime.get(board.id) : null;
  if (!record) return false;
  clearTimeout(record.flushTimer);
  record.flushTimer = setTimeout(() => {
    record.flushTimer = 0;
    void flushRecord(record);
  }, Math.max(0, Number(delayMs) || 0));
  record.flushTimer.unref?.();
  return true;
}

function backoffDelay(record) {
  record.attempts = Number(record.attempts || 0) + 1;
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(record.attempts - 1, 5));
}

function scheduleRetry(record, delay) {
  record.nextAttemptAt = Date.now() + delay;
  clearTimeout(record.retryTimer);
  record.retryTimer = setTimeout(() => {
    record.retryTimer = 0;
    void flushRecord(record);
  }, delay);
  record.retryTimer.unref?.();
  void persistRecord(record).then(() => emitStatus(record));
}

async function markFailed(record, message) {
  record.failed = true;
  record.lastError = String(message || "Sync failed");
  record.nextAttemptAt = 0;
  clearTimeout(record.retryTimer);
  record.retryTimer = 0;
  await persistRecord(record);
  emitStatus(record);
}

async function postOperations(record, batch) {
  return api(`/api/v1/projects/${record.projectId}/ops`, {
    serverUrl: record.serverUrl,
    timeoutMs: 30000,
    method: "POST",
    body: {
      baseSeq: Number(record.lastSeq || 0),
      ops: batch.map((operation) => ({
        opId: operation.opId,
        type: operation.type,
        payload: operation.payload,
        clock: normalizeClockObject(operation.clock || record.clock),
      })),
    },
  });
}

async function replayRecordOperations(record, after) {
  let cursor = Number(after || 0);
  const applied = [];
  for (let page = 0; page < 10; page += 1) {
    const data = await api(
      `/api/v1/projects/${record.projectId}/ops?after=${encodeURIComponent(String(cursor))}&limit=500`,
      { serverUrl: record.serverUrl }
    );
    applied.push(...(data.ops || []));
    cursor = Number(data.lastSeq);
    if (!data.hasMore) return { ops: applied, lastSeq: cursor, revision: data.revision };
  }
  return { ops: applied, lastSeq: cursor, revision: undefined };
}

// A rebase merges remote operations into the local base. The open editor must adopt the merged
// document as well: otherwise the next save would diff against the merged base and emit inverse
// operations (deleting the cards the server just added, reverting its edits).
async function adoptRecordDocument(record) {
  const board = record.boardRef;
  if (!board || !record.doc) return;
  const merged = clone(record.doc);
  merged.id = board.id;
  merged.sync = {
    ...(board.sync || {}),
    projectId: record.projectId,
    revision: record.revision,
    lastSeq: record.lastSeq,
    lastSyncedAt: record.lastSyncedAt || Date.now(),
    serverUrl: record.serverUrl || board.sync?.serverUrl || "",
  };
  for (const key of ["view", "grid", "showGrid", "theme"]) {
    if (board[key] !== undefined) merged[key] = clone(board[key]);
  }
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    try {
      const store = await import("./store.js");
      if (store.state?.board?.id === board.id) {
        await store.adoptRemoteBoard(merged);
        record.boardRef = store.state.board;
        return;
      }
    } catch {
      /* fall through to the in-place update used by the Node tests */
    }
  }
  for (const key of ["title", "cards", "connections", "trash"]) {
    board[key] = clone(merged[key]);
  }
  board.updatedAt = Date.now();
  board.sync = merged.sync;
}

// A single contiguous change between two strings: the common prefix and suffix are kept and only the
// middle is replaced. This is the shape produced by normal typing, pasting or deleting a selection.
function singleTextChange(before, after) {
  if (typeof before !== "string" || typeof after !== "string" || before === after) return null;
  let start = 0;
  const limit = Math.min(before.length, after.length);
  while (start < limit && before[start] === after[start]) start += 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return { start, end: beforeEnd, insert: after.slice(start, afterEnd) };
}

// Three-way merge for a text field: apply the local change on top of the remote value when the two
// changes are disjoint. Overlapping changes return null and keep the field as a reported conflict.
export function mergeTextValues(base, local, remote) {
  if (typeof base !== "string" || typeof local !== "string" || typeof remote !== "string") return null;
  if (local === base) return remote;
  if (remote === base) return local;
  if (local === remote) return local;
  const localChange = singleTextChange(base, local);
  const remoteChange = singleTextChange(base, remote);
  if (!localChange || !remoteChange) return null;
  const changes = [localChange, remoteChange].sort((first, second) => first.start - second.start);
  // Two insertions at the same caret are ambiguous: keep the local value and report a conflict.
  if (
    changes[0].start === changes[1].start &&
    changes[0].end === changes[0].start &&
    changes[1].end === changes[1].start
  ) {
    return null;
  }
  let cursor = 0;
  let merged = "";
  for (const change of changes) {
    if (change.start < cursor) return null;
    merged += base.slice(cursor, change.start) + change.insert;
    cursor = change.end;
  }
  return merged + base.slice(cursor);
}

function applyTextMerges(record, previousBase, remoteBase) {
  const mergedFields = new Set();
  for (const operation of record.pendingOps) {
    if (operation.type !== "card.update") continue;
    const cardId = operation.payload?.id;
    const patch = operation.payload?.patch;
    if (!cardId || !patch) continue;
    const baseCard = (previousBase.cards || []).find((card) => card.id === cardId);
    const remoteCard = (remoteBase.cards || []).find((card) => card.id === cardId);
    if (!baseCard || !remoteCard) continue;
    for (const field of Object.keys(patch)) {
      if (typeof patch[field] !== "string") continue;
      const merged = mergeTextValues(baseCard[field], patch[field], remoteCard[field]);
      if (merged === null) continue;
      patch[field] = merged;
      mergedFields.add(`${cardId}|${field}`);
    }
  }
  return mergedFields;
}

// Per-field view of the operations that touch card fields, keyed by `cardId|field`. A `*` field
// means the whole card was added, replaced or deleted remotely.
function fieldsOfOperations(operations) {
  const fields = new Map();
  for (const operation of operations || []) {
    const payload = operation.payload || {};
    const seq = Number(operation.seq || 0);
    if (operation.type === "card.update" && payload.id && payload.patch) {
      for (const [field, value] of Object.entries(payload.patch)) {
        fields.set(`${payload.id}|${field}`, { cardId: payload.id, field, value, seq });
      }
    } else if (operation.type === "card.add" && payload.card?.id) {
      for (const [field, value] of Object.entries(payload.card)) {
        fields.set(`${payload.card.id}|${field}`, { cardId: payload.card.id, field, value, seq });
      }
    } else if (operation.type === "card.delete" && payload.id) {
      fields.set(`${payload.id}|*`, { cardId: payload.id, field: "*", value: null, seq, deleted: true });
    } else if (operation.type === "doc.replace" && Array.isArray(payload.doc?.cards)) {
      for (const card of payload.doc.cards) {
        if (card?.id) fields.set(`${card.id}|*`, { cardId: card.id, field: "*", value: null, seq });
      }
    }
  }
  return fields;
}

// Called before a rebase resends the local patches: the server order makes the local value win, so
// this only records the overlap for the conflict notice and the "use server values" action.
function detectFieldConflicts(record, remoteOperations) {
  const remote = fieldsOfOperations(remoteOperations);
  if (!remote.size) return [];
  const pending = fieldsOfOperations(record.pendingOps);
  const conflicts = [];
  const seen = new Set();
  for (const [key, local] of pending) {
    let hit = remote.get(key);
    if (!hit && local.field !== "*") hit = remote.get(`${local.cardId}|*`);
    if (!hit && local.field === "*") {
      for (const [remoteKey, value] of remote) {
        if (!remoteKey.startsWith(`${local.cardId}|`)) continue;
        hit = value;
        break;
      }
    }
    if (!hit) continue;
    const id = `${local.cardId}|${local.field}`;
    if (seen.has(id)) continue;
    seen.add(id);
    conflicts.push({
      cardId: local.cardId,
      field: local.field,
      remoteValue: hit.value === undefined ? null : hit.value,
      remoteDeleted: Boolean(hit.deleted),
      remoteSeq: Number(hit.seq || 0),
    });
    if (conflicts.length >= 50) break;
  }
  return conflicts;
}


// A record can be updated by the flush conflict path and by the SSE path at the same time. Both read
// lastSeq and rewrite the merge base, so they are serialized per board.
function withRecordLock(record, task) {
  const previous = record.reconcilePromise || Promise.resolve();
  const next = previous.then(task, task);
  record.reconcilePromise = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

// Shared by the conflict rebase and the live SSE path: merge replayed remote operations into the
// server base, apply the three-way text merge, then rebuild the local document from the merged base
// plus the still-pending local operations.
function mergeReplayIntoRecord(record, replay) {
  const replayed = Array.isArray(replay.ops) ? replay.ops : [];
  for (const operation of replayed) {
    if (operation.clock) record.clock = mergeClockObjects(record.clock, operation.clock);
  }
  if (!replayed.length) {
    record.lastSeq = Number(replay.lastSeq);
    if (replay.revision !== undefined) record.revision = Number(replay.revision);
    return record.doc;
  }
  const previousBase = clone(record.baseDoc);
  const conflicts = detectFieldConflicts(record, replay.ops);
  const remoteBase = replay.ops.length
    ? applyBoardOperations(previousBase, replay.ops)
    : clone(previousBase);
  const mergedTextFields = applyTextMerges(record, previousBase, remoteBase);
  record.fieldConflicts = conflicts.filter(
    (conflict) => !mergedTextFields.has(`${conflict.cardId}|${conflict.field}`)
  );
  record.baseDoc = remoteBase;
  record.doc = applyBoardOperations(record.baseDoc, record.pendingOps);
  record.lastSeq = Number(replay.lastSeq);
  if (replay.revision !== undefined) record.revision = Number(replay.revision);
  return record.doc;
}

async function rebaseFromRemote(record) {
  return withRecordLock(record, async () => {
    const replay = await replayRecordOperations(record, record.lastSeq);
    mergeReplayIntoRecord(record, replay);
    await persistRecord(record);
    applyRecordToBoard(record);
    await adoptRecordDocument(record);
  });
}

async function resyncFromSnapshot(record) {
  const remote = await api(`/api/v1/projects/${record.projectId}`, { serverUrl: record.serverUrl });
  let doc = {};
  try {
    doc = JSON.parse(remote.snapshot?.doc || "{}");
  } catch {
    doc = {};
  }
  doc.id = record.boardId;
  record.baseDoc = doc;
  record.lastSeq = Number(remote.project.lastSeq || 0);
  record.revision = Number(remote.project.revision || 0);
  record.doc = applyBoardOperations(doc, record.pendingOps);
  await persistRecord(record);
  applyRecordToBoard(record);
  await adoptRecordDocument(record);
}

async function handleFlushFailure(record, error, replays) {
  if (error?.offline) {
    record.lastError = "offline";
    scheduleRetry(record, backoffDelay(record));
    return describeRecord(record, { ignoreFlight: true });
  }
  if (error?.code === "not_signed_in") {
    await markFailed(record, error.message);
    return describeRecord(record, { ignoreFlight: true });
  }
  if (error?.code === "seq_conflict") {
    if (replays >= 3) {
      await markFailed(record, "Could not resolve a sequence conflict");
      return describeRecord(record, { ignoreFlight: true });
    }
    try {
      await rebaseFromRemote(record);
    } catch (replayError) {
      if (replayError?.offline) {
        record.lastError = "offline";
        scheduleRetry(record, backoffDelay(record));
        return describeRecord(record, { ignoreFlight: true });
      }
      await markFailed(record, replayError?.message || "Could not replay remote changes");
      return describeRecord(record, { ignoreFlight: true });
    }
    if (record.pendingOps.some((operation) => operation.type === "doc.replace")) {
      record.conflict = true;
      record.lastError = "Both this board and the server changed";
      await persistRecord(record);
      emitStatus(record);
      return describeRecord(record, { ignoreFlight: true });
    }
    return "retry";
  }
  if (error?.code === "card_locked") {
    record.lastError = "card_locked";
    scheduleRetry(record, RETRY_LOCKED_MS);
    return describeRecord(record, { ignoreFlight: true });
  }
  if (error?.code === "resync_required") {
    if (replays >= 3) {
      await markFailed(record, "The operation log was pruned");
      return describeRecord(record, { ignoreFlight: true });
    }
    try {
      await resyncFromSnapshot(record);
    } catch (resyncError) {
      await markFailed(record, resyncError?.message || "Could not reload the server snapshot");
      return describeRecord(record, { ignoreFlight: true });
    }
    if (record.pendingOps.some((operation) => operation.type === "doc.replace")) {
      record.conflict = true;
      record.lastError = "Both this board and the server changed";
      await persistRecord(record);
      emitStatus(record);
      return describeRecord(record, { ignoreFlight: true });
    }
    return "retry";
  }
  const status = Number(error?.status || 0);
  if (status === 400 || status === 413 || status === 422) {
    if (replays < 1) {
      try {
        // A stale operation (for example an update for a card another client deleted) is retried once
        // against a fresh snapshot; a normal edit then applies, an obsolete one fails visibly.
        await resyncFromSnapshot(record);
      } catch (resyncError) {
        await markFailed(record, resyncError?.message || "Could not reload the server snapshot");
        return describeRecord(record, { ignoreFlight: true });
      }
      return "retry";
    }
    await markFailed(record, error?.body?.error || error?.message || "The server rejected the change");
    return describeRecord(record, { ignoreFlight: true });
  }
  if (!status || status >= 500) {
    record.lastError = error?.message || "Network error";
    scheduleRetry(record, backoffDelay(record));
    return describeRecord(record, { ignoreFlight: true });
  }
  if (status === 401 || status === 403) {
    await markFailed(record, error?.message || "The sync token was rejected");
    return describeRecord(record, { ignoreFlight: true });
  }
  await markFailed(record, error?.message || "Sync failed");
  return describeRecord(record, { ignoreFlight: true });
}

function flushRecord(record) {
  if (record.inFlight) return record.inFlight;
  clearTimeout(record.flushTimer);
  record.flushTimer = 0;
  clearTimeout(record.retryTimer);
  record.retryTimer = 0;
  const run = (async () => {
    try {
      if (record.conflict) return describeRecord(record, { ignoreFlight: true });
      if (!record.pendingOps.length) {
        return { status: "noop", pending: 0, lastSeq: record.lastSeq, revision: record.revision };
      }
      let replays = 0;
      while (record.pendingOps.length) {
        const batch = record.pendingOps.slice(0, MAX_BATCH_OPS);
        let result;
        try {
          result = await postOperations(record, batch);
        } catch (error) {
          const outcome = await handleFlushFailure(record, error, replays);
          if (outcome === "retry") {
            replays += 1;
            if (replays > 3) {
              await markFailed(record, "Could not resolve a sequence conflict");
              return describeRecord(record, { ignoreFlight: true });
            }
            continue;
          }
          return outcome;
        }
        record.baseDoc = applyBoardOperations(record.baseDoc, batch);
        record.clock = mergeClockObjects(record.clock, batch[0]?.clock || {});
        if (Array.isArray(result.fieldConflicts) && result.fieldConflicts.length) {
          record.fieldConflicts = mergeFieldConflictLists(record.fieldConflicts, result.fieldConflicts);
        }
        record.lastSeq = Number(result.lastSeq ?? record.lastSeq);
        record.revision = Number(result.revision ?? record.revision);
        record.pendingOps = record.pendingOps.slice(batch.length);
        record.attempts = 0;
        record.nextAttemptAt = 0;
        record.lastError = "";
        record.failed = false;
        record.conflict = false;
        record.lastSyncedAt = Date.now();
        await persistRecord(record);
        emitStatus(record);
      }
      return {
        status: "pushed",
        pending: 0,
        lastSeq: record.lastSeq,
        revision: record.revision,
      };
    } finally {
      record.inFlight = null;
      emitStatus(record);
    }
  })();
  record.inFlight = run;
  emitStatus(record);
  return run;
}

export async function flushBoardNow(board) {
  if (!syncEnabled(board)) return { status: "disabled" };
  const record = await ensureAttached(board);
  record.boardRef = board;
  return flushRecord(record);
}

// Capture every local change and push immediately. Used when leaving a remote board or during an
// explicit Sync now, where waiting for the debounce would lose work.
export async function pushLiveChanges(board) {
  if (!syncEnabled(board)) return { status: "disabled" };
  await captureBoardChanges(board);
  return flushBoardNow(board);
}

// Flush every board with queued work. The service may be reached again after a reload or after the
// browser comes back online, so this is deliberately independent of the currently open board. Queues
// left behind by another tab (or by a tab that was closed) are drained here as well.
export async function flushQueue() {
  const [records, queues] = await Promise.all([
    localStore.listRecords().catch(() => []),
    localStore.listQueues().catch(() => []),
  ]);
  const recordsById = new Map(records.map((entry) => [entry.boardId, entry]));
  const ids = new Set([...recordsById.keys(), ...runtime.keys(), ...queues.map((queue) => queue.boardId)]);
  let flushed = 0;
  let remaining = 0;
  for (const boardId of ids) {
    let record = runtime.get(boardId);
    if (!record) {
      const persisted = recordsById.get(boardId);
      const ownQueue = queues.find((queue) => queue.boardId === boardId && queue.tabId === TAB_ID) || null;
      if (!persisted && !ownQueue) continue;
      record = fromPersisted(persisted, ownQueue, null);
      runtime.set(boardId, record);
    }
    if (record.conflict) {
      remaining += 1;
    } else if (record.pendingOps.length) {
      const result = await flushRecord(record);
      if (result.status === "pushed") flushed += 1;
      else if (Number(result.pending || 0) > 0 || result.status === "conflict") remaining += 1;
    }
    for (const queue of queues) {
      if (queue.boardId !== boardId || queue.tabId === TAB_ID) continue;
      if (!Array.isArray(queue.pendingOps) || !queue.pendingOps.length) continue;
      const temp = {
        ...record,
        tabId: queue.tabId,
        queueKey: queue.queueKey,
        pendingOps: queue.pendingOps,
        attempts: Number(queue.attempts || 0),
        lastError: String(queue.lastError || ""),
        failed: Boolean(queue.failed),
        conflict: Boolean(queue.conflict),
        inFlight: null,
        retryTimer: 0,
        flushTimer: 0,
        boardRef: null,
      };
      const result = await flushRecord(temp);
      if (result.status === "pushed") {
        flushed += 1;
        await localStore.deleteQueue(queue.queueKey);
      } else if (Number(result.pending || 0) > 0 || result.status === "conflict") {
        remaining += 1;
      }
    }
  }
  return { flushed, remaining };
}

// Import a document that predates the durable mirror (legacy remote-temp) as operations: the diff is
// taken against the last server document so the local edits are queued instead of silently dropped.
export async function importLocalDocument(board, fromDocument = null) {
  if (!syncEnabled(board)) return { status: "disabled", captured: 0, pending: 0 };
  const record = await ensureAttached(board);
  if (record.pendingOps.length) {
    return { status: "unchanged", captured: 0, pending: record.pendingOps.length };
  }
  record.doc = clone(fromDocument || record.baseDoc || documentFromBoard(board));
  await persistRecord(record);
  return captureBoardChanges(board);
}

// Replace the locally kept values with the server values recorded during the conflict, then drop the
// notice. The server already holds these values, so no further push is required.
export async function applyServerFieldValues(board) {
  if (!syncEnabled(board)) return { status: "disabled", applied: 0 };
  const record = await ensureAttached(board);
  const conflicts = Array.isArray(record.fieldConflicts) ? record.fieldConflicts : [];
  let applied = 0;
  for (const conflict of conflicts) {
    if (conflict.remoteDeleted || conflict.field === "*") continue;
    const card = (board.cards || []).find((entry) => entry.id === conflict.cardId);
    if (!card) continue;
    if (conflict.remoteValue === null) delete card[conflict.field];
    else card[conflict.field] = clone(conflict.remoteValue);
    applied += 1;
  }
  record.fieldConflicts = [];
  await persistRecord(record);
  emitStatus(record);
  if (applied) board.updatedAt = Date.now();
  // The server currently holds the value that won the rebase (our local one). Push the applied server
  // values as a normal edit so both sides converge on the user's choice.
  if (applied) {
    await captureBoardChanges(board);
    const result = await flushBoardNow(board);
    return { status: result.status, applied };
  }
  return { status: "applied", applied };
}

export async function dismissFieldConflicts(board) {
  if (!syncEnabled(board)) return { status: "disabled" };
  const record = await ensureAttached(board);
  record.fieldConflicts = [];
  await persistRecord(record);
  emitStatus(record);
  return { status: "dismissed" };
}

// Escape hatch for a queue the server keeps rejecting (for example an edit for a card that no longer
// exists, or an oversized doc.replace). Remote boards reload the server snapshot; local boards keep
// their content but stop pushing the queued operations.
export async function discardQueuedChanges(board) {
  if (!syncEnabled(board)) return { status: "disabled" };
  const record = await ensureAttached(board);
  clearTimeout(record.retryTimer);
  record.retryTimer = 0;
  record.pendingOps = [];
  record.fieldConflicts = [];
  record.failed = false;
  record.conflict = false;
  record.lastError = "";
  record.attempts = 0;
  record.nextAttemptAt = 0;
  record.doc = documentFromBoard(board);
  await persistRecord(record);
  await localStore.deleteBoardQueues(board.id);
  emitStatus(record);
  if (record.serverUrl) return pullBoard(board, { force: true });
  return { status: "cleared", revision: record.revision };
}

export async function clearBoardState(boardId) {
  const record = runtime.get(boardId);
  if (record) {
    clearTimeout(record.retryTimer);
    clearTimeout(record.flushTimer);
    record.retryTimer = 0;
    record.flushTimer = 0;
  }
  runtime.delete(boardId);
  await localStore.deleteRecord(boardId);
  await localStore.deleteBoardQueues(boardId);
}

// --- Edit locks ---------------------------------------------------------------------------

const editLocks = new Map();

export function activeEditLock(boardId) {
  return editLocks.get(boardId) || null;
}

export async function acquireEditLock(board, cardId) {
  if (!syncEnabled(board) || !cardId) return null;
  const current = editLocks.get(board.id);
  if (current?.cardId === cardId) return current;
  if (current) await releaseEditLock(board);
  try {
    const data = await api(`/api/v1/projects/${board.sync.projectId}/locks`, {
      serverUrl: board.sync.serverUrl || "",
      method: "POST",
      body: { key: `card:${cardId}` },
    });
    const lock = {
      cardId,
      token: data.token,
      timer: setInterval(() => {
        api(`/api/v1/projects/${board.sync.projectId}/locks`, {
          serverUrl: board.sync.serverUrl || "",
          method: "POST",
          body: { key: `card:${cardId}`, token: data.token },
        }).catch(() => releaseEditLock(board));
      }, 10_000),
    };
    lock.timer.unref?.();
    editLocks.set(board.id, lock);
    return lock;
  } catch (error) {
    if (error.code === "lock_conflict") return null;
    throw error;
  }
}

export async function releaseEditLock(board) {
  if (!board) return;
  const current = editLocks.get(board.id);
  if (!current) return;
  clearInterval(current.timer);
  editLocks.delete(board.id);
  try {
    await api(`/api/v1/projects/${board.sync.projectId}/locks`, {
      serverUrl: board.sync.serverUrl || "",
      method: "DELETE",
      body: { key: `card:${current.cardId}`, token: current.token },
    });
  } catch {
    /* TTL cleanup handles a lost release */
  }
}

// --- Operation diff and apply -------------------------------------------------------------

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
    // A field that was removed locally (for example `delete card.headerImage`) has no key in the new
    // card, so it must be sent as an explicit null tombstone or the server keeps the old value.
    for (const key of Object.keys(previous)) {
      if (["id", "type"].includes(key)) continue;
      if (!(key in card)) patch[key] = null;
    }
    if (Object.keys(patch).length) operations.push({ type: "card.update", payload: { id, patch } });
  }
  const connectionsChanged = JSON.stringify(from.connections || []) !== JSON.stringify(to.connections || []);
  if (connectionsChanged) {
    operations.push({ type: "connections.set", payload: { connections: clone(to.connections || []) } });
  }
  const trashChanged = JSON.stringify(from.trash || []) !== JSON.stringify(to.trash || []);
  const otherKeys = ["parentId", "archivedAt"];
  const otherChanged = otherKeys.some((key) => JSON.stringify(from[key]) !== JSON.stringify(to[key]));
  // Trash entries can contain whole card trees, so they still travel with the document. Connections
  // have their own operation above, which keeps a connection edit from replacing unrelated cards.
  if (trashChanged || otherChanged) {
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
    } else if (operation.type === "connections.set" && Array.isArray(payload.connections)) {
      doc.connections = clone(payload.connections);
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

// --- Remote operations, realtime and presence ---------------------------------------------

export async function consumeRemoteOperations(board) {
  if (!syncEnabled(board)) return { status: "disabled" };
  const record = await ensureAttached(board);
  try {
    return await withRecordLock(record, async () => {
      // A live remote operation can arrive while local edits are still unsaved. Capture them first so
      // the adoption below merges both sides and the queue keeps the local changes.
      await captureBoardChanges(board);
      const replay = await replayRecordOperations(record, record.lastSeq);
      if (!replay.ops.length) return { status: "current", lastSeq: record.lastSeq };
      mergeReplayIntoRecord(record, replay);
      record.lastSyncedAt = Date.now();
      record.conflict = false;
      await persistRecord(record);
      emitStatus(record);
      const doc = clone(record.doc);
      // Viewport/theme are per-device preferences, not shared board content.
      for (const key of ["view", "grid", "showGrid", "theme"]) {
        if (board[key] !== undefined) doc[key] = clone(board[key]);
      }
      doc.sync = { ...board.sync };
      return { status: "applied", doc, lastSeq: record.lastSeq };
    });
  } catch (error) {
    if (error.code === "resync_required") {
      if (record.pendingOps.length) {
        // Keep the queued local edits: reload the snapshot and replay them on top instead of
        // pulling (which would silently drop the queue).
        await withRecordLock(record, () => resyncFromSnapshot(record));
        const doc = clone(record.doc);
        doc.id = board.id;
        for (const key of ["view", "grid", "showGrid", "theme"]) {
          if (board[key] !== undefined) doc[key] = clone(board[key]);
        }
        doc.sync = { ...board.sync };
        return { status: "resync", doc, lastSeq: record.lastSeq };
      }
      const pulled = await pullBoard(board);
      return { status: "resync", doc: pulled.doc };
    }
    throw error;
  }
}

export async function sendPresence(board, connectionId, cursor, name = "") {
  if (!syncEnabled(board) || !connectionId) return false;
  try {
    await api(`/api/v1/projects/${board.sync.projectId}/presence`, {
      serverUrl: board.sync.serverUrl || "",
      method: "POST",
      body: { connectionId, name, cursor },
    });
    return true;
  } catch {
    return false;
  }
}

// Opens the single-use-ticket SSE stream for a synced board. The caller decides whether to adopt a
// remote document; the stream itself only reports that a change is available.
export async function openRealtime(board, { onUpdate, onStatus, onReady } = {}) {
  if (!syncEnabled(board)) throw new Error("Sync is not enabled for this board");
  if (typeof EventSource === "undefined") return { close() {}, supported: false };
  const config = credentialsFor(board.sync.serverUrl || "");
  const ticket = await api(`/api/v1/projects/${board.sync.projectId}/realtime-ticket`, {
    serverUrl: board.sync.serverUrl || "",
    method: "POST",
  });
  const source = new EventSource(
    `${config.url}/api/v1/projects/${board.sync.projectId}/events?ticket=${encodeURIComponent(ticket.token)}`
  );
  const handle = { supported: true, connectionId: null, close() { source.close(); } };
  source.addEventListener("ready", (event) => {
    try {
      const data = JSON.parse(event.data);
      handle.connectionId = data.connectionId;
      onReady?.(data);
    } catch {
      /* ignore malformed ready event */
    }
  });
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
  return handle;
}

// --- Manual sync and conflicts -------------------------------------------------------------

export async function fetchOps(board, after = 0) {
  if (!syncEnabled(board)) throw new Error("Sync is not enabled for this board");
  return api(`/api/v1/projects/${board.sync.projectId}/ops?after=${encodeURIComponent(String(after))}`);
}

export async function enableBoardSync(board) {
  if (!board) throw new Error("No board is open");
  requireConfig();
  if (!board.sync?.projectId) {
    let parentProjectId = null;
    if (board.parentId) {
      try {
        const parentRaw = await bridgeLoadBoard(board.parentId);
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
  await attachRemoteBoard(board, {
    projectId: board.sync.projectId,
    revision: board.sync.revision,
    lastSeq: board.sync.lastSeq,
    baseDoc: documentFromBoard(board),
  });
  return pushBoard(board);
}

async function bridgeLoadBoard(boardId) {
  const bridge = await import("./bridge.js");
  return bridge.loadBoard(boardId);
}

export async function pushBoard(board) {
  if (!syncEnabled(board)) throw new Error("Sync is not enabled for this board");
  const record = await ensureAttached(board);
  const baseSeq = Number(record.lastSeq || 0);
  const doc = JSON.parse(serializedBoard(board));
  const pendingBefore = record.pendingOps.length;
  const clock = { ...normalizeClockObject(record.clock) };
  clock[TAB_ID] = (Number(clock[TAB_ID]) || 0) + 1;
  record.clock = clock;
  const result = await api(`/api/v1/projects/${record.projectId}/ops`, {
    serverUrl: record.serverUrl,
    timeoutMs: 30000,
    method: "POST",
    body: {
      baseSeq,
      ops: [
        {
          opId: `client-${operationId()}`,
          type: "doc.replace",
          payload: { doc },
          clock: clone(clock),
        },
      ],
    },
  });
  // Operations captured while the request was in flight are newer than the pushed document and
  // must stay queued.
  record.pendingOps = record.pendingOps.slice(pendingBefore);
  record.doc = documentFromBoard(board);
  record.baseDoc = clone(doc);
  record.revision = Number(result.revision ?? record.revision);
  record.lastSeq = Number(result.lastSeq ?? record.lastSeq);
  record.lastSyncedAt = Date.now();
  record.conflict = false;
  record.failed = false;
  record.lastError = "";
  record.fieldConflicts = [];
  record.attempts = 0;
  record.nextAttemptAt = 0;
  await persistRecord(record);
  emitStatus(record);
  if (record.pendingOps.length) scheduleFlush(board, 100);
  return { status: "pushed", revision: record.revision, lastSeq: record.lastSeq };
}

export async function pullBoard(board, { force = false } = {}) {
  if (!syncEnabled(board)) throw new Error("Sync is not enabled for this board");
  const record = await ensureAttached(board);
  const remote = await api(`/api/v1/projects/${record.projectId}`, { serverUrl: record.serverUrl });
  if (!remote.snapshot || !remote.snapshot.doc) return { status: "empty" };
  const revision = Number(remote.project.revision);
  if (!force && revision <= record.revision) return { status: "current", revision };
  const doc = JSON.parse(remote.snapshot.doc);
  doc.id = board.id;
  const document = documentFromBoard(doc);
  record.doc = clone(document);
  record.baseDoc = clone(document);
  record.pendingOps = [];
  record.revision = revision;
  record.lastSeq = Number(remote.project.lastSeq ?? record.lastSeq ?? 0);
  record.lastSyncedAt = Date.now();
  record.conflict = false;
  record.failed = false;
  record.lastError = "";
  record.fieldConflicts = [];
  await persistRecord(record);
  emitStatus(record);
  doc.sync = {
    ...board.sync,
    revision,
    lastSeq: record.lastSeq,
    lastSyncedAt: record.lastSyncedAt,
    conflict: null,
  };
  return { status: "pulled", revision, doc };
}

export async function syncBoard(board) {
  if (!board || !syncEnabled(board)) return { status: "disabled" };
  const record = await ensureAttached(board);
  record.boardRef = board;
  // Capture unsaved-but-not-yet-queued edits so a manual sync also merges per operation.
  if (!record.conflict) await captureBoardChanges(board);
  if (record.pendingOps.length) return flushRecord(record);
  const remote = await api(`/api/v1/projects/${record.projectId}`, { serverUrl: record.serverUrl });
  const remoteRevision = Number(remote.project.revision);
  const baseRevision = Number(record.revision || board.sync.revision || 0);
  const localChanged = Number(board.updatedAt || 0) > Number(record.lastSyncedAt || 0);
  if (remoteRevision <= baseRevision) {
    if (localChanged) {
      try {
        return await pushBoard(board);
      } catch (error) {
        if (error.code !== "seq_conflict") throw error;
        const latest = await api(`/api/v1/projects/${record.projectId}`, { serverUrl: record.serverUrl });
        record.conflict = true;
        await persistRecord(record);
        emitStatus(record);
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
  record.conflict = true;
  await persistRecord(record);
  emitStatus(record);
  return {
    status: "conflict",
    remoteRevision,
    baseRevision,
    remoteDoc: remote.snapshot?.doc ? JSON.parse(remote.snapshot.doc) : null,
  };
}

async function forcePushAtCurrentRevision(board) {
  const record = await ensureAttached(board);
  record.conflict = false;
  await rebaseFromRemote(record);
  return pushBoard(board);
}

export async function resolveSyncConflict(board, choice) {
  if (!syncEnabled(board)) throw new Error("Sync is not enabled for this board");
  if (choice === "server") return pullBoard(board, { force: true });
  if (choice === "local") return forcePushAtCurrentRevision(board);
  throw new Error("Unknown conflict choice");
}

// Test-only hook: drop in-memory state (timers included) without touching persisted records, so a
// suite can exercise a reload.
export function _resetRuntimeForTests() {
  for (const record of runtime.values()) {
    clearTimeout(record.retryTimer);
    clearTimeout(record.flushTimer);
  }
  runtime.clear();
  priming.clear();
}
