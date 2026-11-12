// Durable local mirror and per-operation queue for server-backed boards.
//
// The local-first promise for a remote workspace board means the browser keeps the last known
// document plus every operation that has not been confirmed by the service. IndexedDB is used when
// the host provides it (Tauri WebView2/WebKitGTK and browsers); otherwise the same records are kept
// in localStorage so the Node sync tests and older webviews keep working.
//
// There are two record shapes:
//
// board record (shared by every tab, one per board):
// { boardId, projectId, serverUrl, doc, baseDoc, revision, lastSeq, fieldConflicts,
//   lastSyncedAt, updatedAt }
//
// queue record (one per board *and tab*, so two tabs never overwrite each other's pending edits):
// { queueKey, boardId, tabId, projectId, serverUrl, pendingOps, attempts, nextAttemptAt,
//   lastError, failed, fieldConflicts, updatedAt }

const DB_NAME = "khaoyu-sync";
const DB_VERSION = 2;
const BOARD_STORE = "boards";
const QUEUE_STORE = "queues";
const RECORD_PREFIX = "ky.sync.record.";
const RECORD_INDEX = "ky.sync.records";
const QUEUE_PREFIX = "ky.sync.queue.";
const QUEUE_INDEX = "ky.sync.queues";

let databasePromise = null;
const memoryRecords = new Map();
const memoryQueues = new Map();

function hasIndexedDb() {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

function localStore() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function storageKind() {
  if (hasIndexedDb()) return "indexeddb";
  return localStore() ? "localstorage" : "memory";
}

function openDatabase() {
  if (!hasIndexedDb()) return Promise.resolve(null);
  if (databasePromise) return databasePromise;
  const attempt = new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(BOARD_STORE)) {
          database.createObjectStore(BOARD_STORE, { keyPath: "boardId" });
        }
        if (!database.objectStoreNames.contains(QUEUE_STORE)) {
          database.createObjectStore(QUEUE_STORE, { keyPath: "queueKey" });
        }
      };
      request.onsuccess = () => finish(request.result);
      request.onerror = () => finish(null);
      request.onblocked = () => finish(null);
      setTimeout(() => finish(null), 2500);
    } catch {
      finish(null);
    }
  });
  databasePromise = attempt.then((database) => {
    if (!database) databasePromise = null;
    return database;
  });
  return databasePromise;
}

function whenTransactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB write failed"));
    transaction.onabort = () => reject(new Error("IndexedDB transaction aborted"));
  });
}

// --- generic fallback storage -----------------------------------------------------------------

function readIndex(key) {
  const storage = localStore();
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function writeIndex(key, entries) {
  const storage = localStore();
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify([...new Set(entries)]));
  } catch {
    /* storage can be full or disabled */
  }
}

function readFallback(prefix, key) {
  const storage = localStore();
  if (!storage) return null;
  try {
    const raw = storage.getItem(prefix + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeFallback(prefix, indexKey, key, value) {
  const copy = JSON.parse(JSON.stringify(value));
  const storage = localStore();
  if (!storage) return true;
  try {
    storage.setItem(prefix + key, JSON.stringify(copy));
    const entries = readIndex(indexKey);
    if (!entries.includes(key)) writeIndex(indexKey, [...entries, key]);
    return true;
  } catch {
    return false;
  }
}

function removeFallback(prefix, indexKey, key) {
  const storage = localStore();
  if (!storage) return;
  try {
    storage.removeItem(prefix + key);
    writeIndex(
      indexKey,
      readIndex(indexKey).filter((entry) => entry !== key)
    );
  } catch {
    /* storage may be unavailable */
  }
}

// --- board mirror -----------------------------------------------------------------------------

export async function loadRecord(boardId) {
  if (!boardId) return null;
  if (memoryRecords.has(boardId)) return memoryRecords.get(boardId);
  const database = await openDatabase();
  if (!database) return readFallback(RECORD_PREFIX, boardId);
  try {
    return await new Promise((resolve) => {
      const transaction = database.transaction(BOARD_STORE, "readonly");
      const request = transaction.objectStore(BOARD_STORE).get(boardId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(memoryRecords.get(boardId) || null);
    });
  } catch {
    return readFallback(RECORD_PREFIX, boardId);
  }
}

export async function saveRecord(record) {
  if (!record?.boardId) return false;
  const database = await openDatabase();
  if (!database) {
    memoryRecords.set(record.boardId, JSON.parse(JSON.stringify(record)));
    return writeFallback(RECORD_PREFIX, RECORD_INDEX, record.boardId, record);
  }
  try {
    const transaction = database.transaction(BOARD_STORE, "readwrite");
    transaction.objectStore(BOARD_STORE).put(record);
    await whenTransactionDone(transaction);
    return true;
  } catch {
    memoryRecords.set(record.boardId, JSON.parse(JSON.stringify(record)));
    return writeFallback(RECORD_PREFIX, RECORD_INDEX, record.boardId, record);
  }
}

export async function deleteRecord(boardId) {
  if (!boardId) return;
  memoryRecords.delete(boardId);
  const database = await openDatabase();
  if (database) {
    try {
      const transaction = database.transaction(BOARD_STORE, "readwrite");
      transaction.objectStore(BOARD_STORE).delete(boardId);
      await whenTransactionDone(transaction);
    } catch {
      /* fall through to the fallback store */
    }
  }
  removeFallback(RECORD_PREFIX, RECORD_INDEX, boardId);
}

export async function listRecords() {
  const database = await openDatabase();
  if (!database) {
    const ids = new Set(localStore() ? readIndex(RECORD_INDEX) : []);
    for (const boardId of memoryRecords.keys()) ids.add(boardId);
    return [...ids].map((boardId) => memoryRecords.get(boardId) || readFallback(RECORD_PREFIX, boardId)).filter(Boolean);
  }
  try {
    return await new Promise((resolve) => {
      const transaction = database.transaction(BOARD_STORE, "readonly");
      const request = transaction.objectStore(BOARD_STORE).getAll();
      request.onsuccess = () => {
        const byId = new Map((Array.isArray(request.result) ? request.result : []).map((entry) => [entry.boardId, entry]));
        for (const [boardId, record] of memoryRecords) byId.set(boardId, record);
        resolve([...byId.values()]);
      };
      request.onerror = () => resolve([...memoryRecords.values()]);
    });
  } catch {
    return [...memoryRecords.values()];
  }
}

// --- per-tab queue ----------------------------------------------------------------------------

export function queueKeyFor(boardId, tabId) {
  return `${boardId}|${tabId}`;
}

function queueBoardId(queueKey) {
  return String(queueKey || "").split("|")[0] || "";
}

export async function loadQueue(boardId, tabId) {
  if (!boardId || !tabId) return null;
  const queueKey = queueKeyFor(boardId, tabId);
  if (memoryQueues.has(queueKey)) return memoryQueues.get(queueKey);
  const database = await openDatabase();
  if (!database) return readFallback(QUEUE_PREFIX, queueKey);
  try {
    return await new Promise((resolve) => {
      const transaction = database.transaction(QUEUE_STORE, "readonly");
      const request = transaction.objectStore(QUEUE_STORE).get(queueKey);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(memoryQueues.get(queueKey) || null);
    });
  } catch {
    return readFallback(QUEUE_PREFIX, queueKey);
  }
}

export async function saveQueue(queue) {
  if (!queue?.queueKey) return false;
  const database = await openDatabase();
  if (!database) {
    memoryQueues.set(queue.queueKey, JSON.parse(JSON.stringify(queue)));
    return writeFallback(QUEUE_PREFIX, QUEUE_INDEX, queue.queueKey, queue);
  }
  try {
    const transaction = database.transaction(QUEUE_STORE, "readwrite");
    transaction.objectStore(QUEUE_STORE).put(queue);
    await whenTransactionDone(transaction);
    return true;
  } catch {
    memoryQueues.set(queue.queueKey, JSON.parse(JSON.stringify(queue)));
    return writeFallback(QUEUE_PREFIX, QUEUE_INDEX, queue.queueKey, queue);
  }
}

export async function deleteQueue(queueKey) {
  if (!queueKey) return;
  memoryQueues.delete(queueKey);
  const database = await openDatabase();
  if (database) {
    try {
      const transaction = database.transaction(QUEUE_STORE, "readwrite");
      transaction.objectStore(QUEUE_STORE).delete(queueKey);
      await whenTransactionDone(transaction);
    } catch {
      /* fall through to the fallback store */
    }
  }
  removeFallback(QUEUE_PREFIX, QUEUE_INDEX, queueKey);
}

export async function listQueues() {
  const database = await openDatabase();
  if (!database) {
    const keys = new Set(localStore() ? readIndex(QUEUE_INDEX) : []);
    for (const queueKey of memoryQueues.keys()) keys.add(queueKey);
    return [...keys]
      .map((queueKey) => memoryQueues.get(queueKey) || readFallback(QUEUE_PREFIX, queueKey))
      .filter(Boolean);
  }
  try {
    return await new Promise((resolve) => {
      const transaction = database.transaction(QUEUE_STORE, "readonly");
      const request = transaction.objectStore(QUEUE_STORE).getAll();
      request.onsuccess = () => {
        const byKey = new Map((Array.isArray(request.result) ? request.result : []).map((entry) => [entry.queueKey, entry]));
        for (const [queueKey, queue] of memoryQueues) byKey.set(queueKey, queue);
        resolve([...byKey.values()]);
      };
      request.onerror = () => resolve([...memoryQueues.values()]);
    });
  } catch {
    return [...memoryQueues.values()];
  }
}

export async function deleteBoardQueues(boardId) {
  if (!boardId) return;
  memoryQueues.delete(boardId);
  for (const queueKey of [...memoryQueues.keys()]) {
    if (queueBoardId(queueKey) === boardId) memoryQueues.delete(queueKey);
  }
  const database = await openDatabase();
  if (database) {
    try {
      const transaction = database.transaction(QUEUE_STORE, "readwrite");
      const store = transaction.objectStore(QUEUE_STORE);
      for (const queueKey of [...memoryQueues.keys()]) store.delete(queueKey);
      const all = await new Promise((resolve) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
        request.onerror = () => resolve([]);
      });
      for (const queue of [...all, ...memoryQueues.values()]) {
        if (queue.boardId === boardId || queueBoardId(queue.queueKey) === boardId) store.delete(queue.queueKey);
      }
      await whenTransactionDone(transaction);
    } catch {
      /* fall through to the fallback store */
    }
  }
  const storage = localStore();
  if (!storage) return;
  for (const queueKey of readIndex(QUEUE_INDEX)) {
    if (queueBoardId(queueKey) === boardId) removeFallback(QUEUE_PREFIX, QUEUE_INDEX, queueKey);
  }
}

// Test helper: clear every persisted record. Never called by application code.
export async function clearAllRecords() {
  const database = await openDatabase();
  if (database) {
    try {
      const transaction = database.transaction([BOARD_STORE, QUEUE_STORE], "readwrite");
      transaction.objectStore(BOARD_STORE).clear();
      transaction.objectStore(QUEUE_STORE).clear();
      await whenTransactionDone(transaction);
    } catch {
      /* ignore */
    }
  }
  memoryRecords.clear();
  memoryQueues.clear();
  const storage = localStore();
  if (!storage) return;
  try {
    for (const boardId of readIndex(RECORD_INDEX)) storage.removeItem(RECORD_PREFIX + boardId);
    for (const queueKey of readIndex(QUEUE_INDEX)) storage.removeItem(QUEUE_PREFIX + queueKey);
    storage.removeItem(RECORD_INDEX);
    storage.removeItem(QUEUE_INDEX);
  } catch {
    /* ignore */
  }
}
