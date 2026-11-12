// Durable temporary buffer for remote workspace boards. Every remote edit is written here before
// the short network push, so switching workspaces or closing the tab cannot lose local changes.
const PREFIX = "ky.remoteTemp.";
const MAX_TEMP_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function remoteTempKey(boardId) {
  return PREFIX + boardId;
}

export function writeRemoteTemp(board, extra = {}) {
  if (!board?.id) return null;
  const payload = {
    board,
    boardId: board.id,
    projectId: board.sync?.projectId || null,
    savedAt: Date.now(),
    ...extra,
  };
  try {
    localStorage.setItem(remoteTempKey(board.id), JSON.stringify(payload));
    return payload;
  } catch {
    return null;
  }
}

export function readRemoteTemp(boardId) {
  if (!boardId) return null;
  try {
    const raw = localStorage.getItem(remoteTempKey(boardId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.board || parsed.boardId !== boardId) return null;
    if (Date.now() - Number(parsed.savedAt || 0) > MAX_TEMP_AGE_MS) {
      clearRemoteTemp(boardId);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearRemoteTemp(boardId) {
  if (!boardId) return;
  try {
    localStorage.removeItem(remoteTempKey(boardId));
  } catch {
    /* storage may be unavailable */
  }
}
