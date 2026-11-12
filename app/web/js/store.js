// Application state, undo history and persistence scheduling.

import * as bridge from "./bridge.js";
import { createCard, layoutColumns, migrateLegacyKanban, newBoardDoc, uid, welcomeBoard } from "./model.js";
import { applyTheme as applyDocumentTheme, readStoredTheme, storeTheme } from "./theme.js";

export const state = {
  board: null,
  boards: [],
  selection: new Set(),
  view: { x: 0, y: 0, zoom: 1 },
  tool: "select",
  connectionSelection: null,
  theme: "light",
  editing: null,
  dirty: false,
  viewDirty: false,
  saveState: "saved", // saved | saving | unsaved | error | conflict
  conflict: null,
  baseUpdatedAt: null,
  loaded: false,
};

const subscribers = new Set();
export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
export function notify(kind = "board") {
  // Pan and zoom do not mark the document dirty, but they still need a flush on close or switch.
  if (kind === "view" && state.loaded) state.viewDirty = true;
  for (const fn of subscribers) {
    try {
      fn(kind);
    } catch (error) {
      console.error("[store] subscriber failed", error);
    }
  }
}

// ------------------------------------------------------------------ history

export const history = { past: [], future: [] };

export function checkpoint() {
  if (!state.board) return;
  history.past.push(JSON.stringify(state.board));
  if (history.past.length > 120) history.past.shift();
  history.future.length = 0;
  notify("history");
}

function restoreHistory() {
  const board = state.board;
  if (!board) return;
  state.selection = new Set();
  state.editing = null;
  layoutColumns(board);
  state.view = board.view || state.view;
  notify("board");
  notify("view");
  notify("history");
  scheduleSave();
}

export function undo() {
  if (!history.past.length || !state.board) return;
  history.future.push(JSON.stringify(state.board));
  state.board = JSON.parse(history.past.pop());
  restoreHistory();
}

export function redo() {
  if (!history.future.length || !state.board) return;
  history.past.push(JSON.stringify(state.board));
  state.board = JSON.parse(history.future.pop());
  restoreHistory();
}

export function canUndo() {
  return history.past.length > 0;
}
export function canRedo() {
  return history.future.length > 0;
}

// ---------------------------------------------------------------- selections

export function selectedCards() {
  if (!state.board) return [];
  return state.board.cards.filter((card) => state.selection.has(card.id));
}

export function setSelection(ids) {
  state.selection = new Set(ids);
  notify("selection");
}

export function toggleSelection(id) {
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  notify("selection");
}

export function clearSelection() {
  if (!state.selection.size) return;
  state.selection.clear();
  notify("selection");
}

// ------------------------------------------------------------------ saving

let saveTimer = 0;
let retryTimer = 0;
let retryDelay = 1000;
let saveInFlight = false;

// Autosave waits for the user to stop editing, then persists 5 seconds after the last change.
const IDLE_SAVE_MS = 5000;
const MAX_RETRY_DELAY = 30000;

export function markDirty(kind = "board") {
  if (!state.board) return;
  state.board.updatedAt = Date.now();
  state.dirty = true;
  scheduleSave();
  notify(kind);
}

export function scheduleSave() {
  if (!state.board) return;
  state.dirty = true;
  if (!autoSaveEnabled()) {
    state.saveState = "unsaved";
    notify("save");
    return;
  }
  state.saveState = "saving";
  notify("save");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, IDLE_SAVE_MS);
}

function autoSaveEnabled() {
  try {
    const raw = localStorage.getItem("mn.settings");
    if (!raw) return true;
    return JSON.parse(raw).autoUpdateOpenDocuments !== false;
  } catch {
    return true;
  }
}

function clearRetry() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = 0;
  }
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = 0;
    saveNow();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
}

function isConflict(error) {
  const text = String((error && error.message) || error || "");
  return text.startsWith("conflict:") || text.includes("conflict:");
}

function dispatchConflict(conflict) {
  window.dispatchEvent(
    new CustomEvent("mn:save-conflict", {
      detail: { boardId: conflict.boardId, title: conflict.title, doc: conflict.doc },
    })
  );
}

export async function saveNow() {
  if (!state.board) return;
  if (state.conflict) {
    // Keep asking the user to resolve the conflict instead of overwriting either version.
    // A pan or zoom alone must not interrupt them with a dialog; that view is simply not saved.
    if (state.dirty) dispatchConflict(state.conflict);
    else state.viewDirty = false;
    return;
  }
  if (!state.dirty && !state.viewDirty) return;
  if (saveInFlight) {
    // A change arrived while a save was running; retry shortly instead of dropping it.
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 500);
    return;
  }
  saveInFlight = true;
  clearTimeout(saveTimer);
  const hadContentChanges = state.dirty;
  state.dirty = false;
  state.board.view = { ...state.view };
  const snapshot = JSON.stringify(state.board);
  const boardId = state.board.id;
  const base = Number.isFinite(state.baseUpdatedAt) ? state.baseUpdatedAt : null;
  try {
    const updatedAt = await bridge.saveBoard(boardId, snapshot, base);
    if (typeof updatedAt === "number" && Number.isFinite(updatedAt)) {
      state.baseUpdatedAt = updatedAt;
    }
    retryDelay = 1000;
    clearRetry();
    state.viewDirty = false;
    state.saveState = state.dirty ? "saving" : "saved";
    window.dispatchEvent(
      new CustomEvent("mn:board-saved", { detail: { boardId, board: state.board } })
    );
  } catch (error) {
    console.error("[store] save failed", error);
    if (isConflict(error)) {
      if (!hadContentChanges && !state.dirty) {
        // Only the viewport was being flushed, so there is nothing worth interrupting the user for.
        state.viewDirty = false;
        state.saveState = "saved";
      } else {
        state.dirty = true;
        state.saveState = "conflict";
        state.conflict = {
          boardId,
          title: state.board && state.board.title ? state.board.title : "Untitled board",
          doc: snapshot,
        };
        dispatchConflict(state.conflict);
      }
    } else {
      state.dirty = true;
      state.saveState = "error";
      scheduleRetry();
    }
  } finally {
    saveInFlight = false;
    notify("save");
  }
}

/// Resolve a write conflict without losing either version: load the newer document from disk,
/// or keep the local document as a separate board.
export async function resolveSaveConflict(mode, conflictOverride = null) {
  const conflict = conflictOverride || state.conflict;
  if (!conflict) return;
  state.conflict = null;
  state.saveState = "saved";
  notify("save");
  if (mode === "copy") {
    let local;
    try {
      local =
        state.board && state.board.id === conflict.boardId
          ? JSON.parse(JSON.stringify(state.board))
          : JSON.parse(conflict.doc);
    } catch {
      local = JSON.parse(conflict.doc);
    }
    local.id = uid("b");
    local.title = `${local.title || "Untitled board"} (copy)`;
    local.parentId = null;
    local.createdAt = Date.now();
    local.updatedAt = Date.now();
    local.trash = [];
    try {
      await bridge.saveBoard(local.id, JSON.stringify(local), null);
    } catch (error) {
      console.error("[store] could not save the conflict copy", error);
      state.saveState = "error";
      notify("save");
      window.dispatchEvent(
        new CustomEvent("mn:toast", {
          detail: { message: "Could not save a copy; your edits are still in memory" },
        })
      );
      return;
    }
    state.dirty = false;
    clearTimeout(saveTimer);
    clearRetry();
    await openBoard(local.id, { flush: false });
    window.dispatchEvent(
      new CustomEvent("mn:toast", { detail: { message: "Your version was saved as a copy" } })
    );
    return;
  }
  state.dirty = false;
  clearTimeout(saveTimer);
  clearRetry();
  await openBoard(conflict.boardId, { flush: false });
}

// ------------------------------------------------------------------ boards

export async function refreshBoards() {
  state.boards = await bridge.listBoards();
  notify("boards");
}

/// Pick a board that can actually be opened: a root project first, never a trashed or nested board.
export function firstOpenableBoard() {
  const roots = state.boards.filter((board) => !board.parentId && !board.trashedAt);
  return roots.find((board) => !board.archivedAt) || roots[0] || state.boards.find((board) => !board.trashedAt) || null;
}

function applyTheme(theme) {
  state.theme = theme;
  applyDocumentTheme(theme);
  storeTheme(theme, { key: "mn.theme" });
  notify("theme");
}

export function setTheme(theme) {
  // Theme is a global appearance preference: it is stored once for the app and must not be
  // written into the board document, otherwise switching boards changes the theme.
  applyTheme(theme);
}

export async function openBoard(id, { flush = true } = {}) {
  if (state.conflict) {
    // A conflict is unresolved; do not abandon the unsaved local version silently.
    dispatchConflict(state.conflict);
    return null;
  }
  if (flush && state.board && state.board.id !== id) {
    // Flush pending edits so the board we leave is consistent on disk (and visible to panels).
    await saveNow();
    if (state.conflict) {
      dispatchConflict(state.conflict);
      return null;
    }
    if (state.saveState === "error") {
      window.dispatchEvent(
        new CustomEvent("mn:toast", {
          detail: { message: "Could not save the current board; staying here to retry" },
        })
      );
      return null;
    }
  }
  const raw = await bridge.loadBoard(id);
  let doc = null;
  if (raw) {
    try {
      doc = JSON.parse(raw);
    } catch (error) {
      console.error("[store] corrupt board", error);
    }
  }
  if (!doc) {
    doc = newBoardDoc("Untitled board");
    doc.id = id;
  }
  if (!Array.isArray(doc.trash)) doc.trash = [];
  if (migrateLegacyKanban(doc)) {
    doc.updatedAt = Date.now();
  }
  state.board = doc;
  // Legacy builds stored a theme per board. Ignore it: the global preference above wins, so a
  // board saved in the past cannot flip the theme when it is opened.
  layoutColumns(doc);
  state.view = doc.view || { x: 0, y: 0, zoom: 1 };
  state.selection = new Set();
  state.editing = null;
  state.loaded = true;
  state.saveState = "saved";
  state.conflict = null;
  state.dirty = false;
  state.baseUpdatedAt = Number.isFinite(doc.updatedAt) ? doc.updatedAt : null;
  retryDelay = 1000;
  clearRetry();
  clearTimeout(saveTimer);
  localStorage.setItem("mn.lastBoard", doc.id);
  notify("board");
  notify("view");
  notify("history");
  state.viewDirty = false;
  await refreshBoards();
  return doc;
}

export async function createBoard(title = "Untitled board", { withWelcome = false } = {}) {
  const doc = withWelcome ? welcomeBoard() : newBoardDoc(title);
  if (!withWelcome) doc.title = title;
  if (withWelcome) {
    const boardCard = doc.cards.find((card) => card.type === "board");
    if (boardCard) {
      const child = newBoardDoc("Examples board", doc.id);
      const childHeading = createCard("heading", 120, 100, { text: "Examples board" });
      childHeading.w = 320;
      const childNote = createCard("note", 120, 200, {
        text: "Nested boards keep related cards together. Open this board from its card anytime.",
      });
      childNote.w = 320;
      childNote.h = 110;
      child.cards.push(childHeading, childNote);
      child.view = { x: 40, y: -10, zoom: 1 };
      await bridge.saveBoard(child.id, JSON.stringify(child));
      boardCard.boardId = child.id;
    }
  }
  await bridge.saveBoard(doc.id, JSON.stringify(doc), null);
  state.board = doc;
  state.selection = new Set();
  state.editing = null;
  layoutColumns(doc);
  state.view = doc.view || { x: 0, y: 0, zoom: 1 };
  state.loaded = true;
  state.saveState = "saved";
  state.conflict = null;
  state.dirty = false;
  state.baseUpdatedAt = Number.isFinite(doc.updatedAt) ? doc.updatedAt : null;
  retryDelay = 1000;
  clearRetry();
  clearTimeout(saveTimer);
  localStorage.setItem("mn.lastBoard", doc.id);
  notify("board");
  notify("view");
  notify("history");
  state.viewDirty = false;
  await refreshBoards();
  return doc;
}

export async function removeBoard(id, options = {}) {
  const { openNext = true } = options;
  const wasOpen = state.board && state.board.id === id;
  if (wasOpen && state.conflict) {
    dispatchConflict(state.conflict);
    return;
  }
  if (wasOpen) {
    // Flush first, then detach, so the next openBoard cannot write the deleted board back to disk.
    await saveNow();
    if (state.conflict) {
      dispatchConflict(state.conflict);
      return;
    }
    if (state.saveState === "error") {
      window.dispatchEvent(
        new CustomEvent("mn:toast", {
          detail: { message: "Could not save this board before deleting it; try again" },
        })
      );
      return;
    }
    state.board = null;
    state.dirty = false;
  }
  await bridge.deleteBoard(id);
  state.baseUpdatedAt = null;
  state.conflict = null;
  await refreshBoards();
  if (state.board && state.board.id === id) {
    state.board = null;
  }
  if (!state.board && openNext) {
    const next = firstOpenableBoard();
    if (next) await openBoard(next.id);
    else await createBoard("Home", { withWelcome: true });
  }
}

export function initTheme() {
  applyTheme(readStoredTheme({ key: "mn.theme", fallback: "light" }));
}

export async function exportCurrentBoard() {
  if (!state.board) return null;
  const json = JSON.stringify(state.board, null, 2);
  return bridge.exportBoard(json);
}

/// Adopt a server document after an explicit pull or conflict choice.
export async function adoptRemoteBoard(doc) {
  if (!doc || !state.board || doc.id !== state.board.id) return;
  const previousBase = state.baseUpdatedAt;
  state.board = doc;
  layoutColumns(doc);
  state.view = doc.view || state.view;
  state.selection = new Set();
  state.editing = null;
  state.conflict = null;
  state.dirty = false;
  state.baseUpdatedAt = previousBase;
  const updatedAt = await bridge.saveBoard(doc.id, JSON.stringify(doc), previousBase);
  state.baseUpdatedAt = typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : Date.now();
  notify("board");
  notify("view");
  notify("history");
}

/// Persist sync metadata without marking the document dirty.
export async function persistBoardSnapshot() {
  if (!state.board) return false;
  const snapshot = JSON.stringify(state.board);
  try {
    const updatedAt = await bridge.saveBoard(state.board.id, snapshot, state.baseUpdatedAt);
    if (typeof updatedAt === "number" && Number.isFinite(updatedAt)) state.baseUpdatedAt = updatedAt;
    return true;
  } catch (error) {
    console.error("[store] could not persist sync metadata", error);
    return false;
  }
}
