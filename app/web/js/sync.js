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
  storage().setItem(CONFIG_KEY, JSON.stringify({ url: config.url, token: config.token }));
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
  if (!config.url || !config.token) {
    throw new Error("Set the sync server URL and API token first");
  }
  return { url: config.url.replace(/\/+$/, ""), token: config.token };
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
