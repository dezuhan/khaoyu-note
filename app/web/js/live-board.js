// Cross-window live board updates for the localhost web host. The desktop app uses its own native
// window and the collaborative service uses SSE; this bridge refreshes web/mobile viewers when the
// shared SQLite database is written by another browser, tab or the desktop process.
import * as bridge from "./bridge.js";
import { authState, subscribeAuth } from "./auth.js";
import { openBoard, refreshBoards, state } from "./store.js";

let source = null;
let pendingBoardId = null;
let pendingNotice = false;
let desktopTimer = 0;

function tabId() {
  return window.__KHAOYU_TAB__ || "web";
}

function toast(message) {
  window.dispatchEvent(new CustomEvent("mn:toast", { detail: { message } }));
}

function editingNow() {
  const active = document.activeElement;
  return Boolean(
    active?.isContentEditable ||
      active?.matches?.("input, textarea, select, [contenteditable='true']")
  );
}

async function applyRemoteBoard(boardId) {
  if (!state.board || state.board.id !== boardId) {
    await refreshBoards();
    return;
  }
  if (state.dirty || state.saveState === "saving" || state.saveState === "conflict" || editingNow()) {
    pendingBoardId = boardId;
    if (!pendingNotice) {
      pendingNotice = true;
      toast("Another device saved this board; finish your edit first");
    }
    return;
  }
  pendingBoardId = null;
  pendingNotice = false;
  await openBoard(boardId, { flush: false });
  toast("Board updated from another device");
}

async function onBoardEvent(event) {
  let data;
  try {
    data = JSON.parse(event.data);
  } catch {
    return;
  }
  if (!data?.boardId) return;
  if (data.removed) {
    await refreshBoards();
    if (state.board?.id === data.boardId) {
      const next = state.boards.find((board) => !board.trashedAt && !board.archivedAt);
      if (next) await openBoard(next.id, { flush: false });
    }
    return;
  }
  if (state.board?.id !== data.boardId) {
    await refreshBoards();
    return;
  }
  const remoteUpdatedAt = Number(data.updatedAt);
  if (Number.isFinite(remoteUpdatedAt) && Number.isFinite(Number(state.baseUpdatedAt)) && remoteUpdatedAt <= Number(state.baseUpdatedAt)) {
    return;
  }
  await applyRemoteBoard(data.boardId);
}

function startSource() {
  if (!bridge.hasWeb || source || !authState().user) return;
  try {
    source = new EventSource(`/api/events?tab=${encodeURIComponent(tabId())}`);
    source.addEventListener("board", onBoardEvent);
  } catch {
    source = null;
  }
}

function stopSource() {
  source?.close();
  source = null;
}

function startDesktopPoll() {
  if (!bridge.hasTauri || bridge.hasWeb || desktopTimer) return;
  desktopTimer = setInterval(async () => {
    if (!state.board || state.dirty || state.saveState === "saving" || state.saveState === "conflict" || editingNow()) return;
    try {
      const raw = await bridge.loadBoard(state.board.id);
      if (!raw) return;
      const remote = JSON.parse(raw);
      if (Number(remote.updatedAt) > Number(state.baseUpdatedAt || 0)) {
        await openBoard(state.board.id, { flush: false });
        toast("Board updated from another device");
      }
    } catch {
      /* transient database lock */
    }
  }, 1800);
}

export function initLiveBoard() {
  if (!bridge.hasWeb) {
    startDesktopPoll();
    return;
  }
  subscribeAuth((auth) => {
    if (auth.user) startSource();
    else stopSource();
  });
  startSource();
  window.addEventListener("mn:board-saved", () => {
    // A local save already carries the newest document; do not reload under the editor.
    if (pendingBoardId) {
      pendingBoardId = null;
      pendingNotice = false;
    }
  });
}
