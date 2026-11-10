import * as bridge from "./bridge.js";
import { initAutoBackup } from "./auto-backup.js";
import { initAuth } from "./auth.js";
import { initInteractions } from "./interact.js";
import { initRender, render, renderSelection, renderView } from "./render.js";
import { initSettings } from "./settings.js";
import { initSyncUI, refresh as refreshSync } from "./sync-ui.js";
import { initShareUI } from "./share-ui.js";
import { initUpdateUI } from "./update-ui.js";
import {
  createBoard,
  firstOpenableBoard,
  initTheme,
  openBoard,
  refreshBoards,
  state,
  subscribe,
} from "./store.js";
import { initContextMenu, initUI } from "./ui.js";
import { initSetupGate } from "./setup.js";
import { initLanguage } from "./i18n.js";

const refs = {
  viewport: document.getElementById("viewport"),
  world: document.getElementById("world"),
  cards: document.getElementById("cards"),
  connections: document.getElementById("connections"),
};

const uiRefs = {
  toolrail: document.getElementById("toolrail"),
  homeBtn: document.getElementById("home-btn"),
  templateBtn: document.getElementById("template-btn"),
  boardTitle: document.getElementById("board-title"),
  breadcrumb: document.getElementById("breadcrumb"),
  menubar: document.getElementById("menubar"),
  commandSearchBtn: document.getElementById("command-search-btn"),
  saveState: document.getElementById("save-state"),
  syncButton: document.getElementById("sync-state"),
  syncState: document.getElementById("sync-state"),
  shareButton: document.getElementById("share-btn"),
  accountBtn: document.getElementById("account-btn"),
  undoBtn: document.getElementById("undo-btn"),
  redoBtn: document.getElementById("redo-btn"),
  commentCount: document.getElementById("comment-count"),
  notificationBtn: document.getElementById("notification-btn"),
  helpBtn: document.getElementById("help-btn"),
  themeBtn: document.getElementById("theme-btn"),
  languageBtn: document.getElementById("language-btn"),
  settingsBtn: document.getElementById("settings-btn"),
  zoomBar: document.querySelector(".mn-zoom"),
  zoomLabel: document.getElementById("zoom-label"),
  menuLayer: document.getElementById("menu-layer"),
  toast: document.getElementById("toast"),
  homePage: document.getElementById("home-page"),
};

function requestedBoardId() {
  try {
    return new URLSearchParams(window.location.search).get("board") || "";
  } catch {
    return "";
  }
}

// Keep the address bar on a full board URL while the app is served over HTTP.
function syncBoardUrl() {
  if (!/^https?:$/.test(window.location.protocol)) return;
  try {
    const url = new URL(window.location.href);
    if (state.board?.id) url.searchParams.set("board", state.board.id);
    else url.searchParams.delete("board");
    window.history.replaceState(null, "", url);
  } catch {
    /* the address bar is optional */
  }
}

async function boot() {
  initTheme();
  initLanguage();
  // After a reset, choose the storage direction before any board or setting is read.
  await initSetupGate();
  await initAuth();
  await initSettings();
  initRender(refs);
  initInteractions(refs);
  initUI(uiRefs);
  initSyncUI(uiRefs);
  initShareUI(uiRefs);
  initContextMenu();

  subscribe((kind) => {
    if (kind === "board" || kind === "geometry") render(kind);
    else if (kind === "view") renderView();
    else if (kind === "selection") renderSelection();
    if (kind === "board" || kind === "save" || kind === "history") refreshSync();
    if (kind === "board") syncBoardUrl();
  });

  await refreshBoards();
  const requested = requestedBoardId();
  const requestedBoard = requested
    ? state.boards.find(
        (board) => board.id === requested && !board.trashedAt && !board.archivedAt
      )
    : null;
  const last = localStorage.getItem("mn.lastBoard");
  const remembered = state.boards.find(
    (board) => board.id === last && !board.trashedAt && !board.archivedAt
  );
  if (requestedBoard) {
    await openBoard(requestedBoard.id);
  } else if (remembered) {
    await openBoard(remembered.id);
  } else {
    const next = firstOpenableBoard();
    if (next) await openBoard(next.id);
    else await createBoard("Home", { withWelcome: true });
  }
  syncBoardUrl();
  render("board");
  renderView();
  refreshSync();
  initUpdateUI();
  initAutoBackup();
  document.getElementById("boot")?.remove();
  document.fonts?.ready.then(() => {
    if (state.board) render("geometry");
  });
}

boot().catch((error) => {
  console.error(error);
  const bootEl = document.getElementById("boot");
  if (bootEl) {
    bootEl.className = "is-error";
    bootEl.textContent = "Failed to start:\n" + (error && error.stack ? error.stack : error);
  }
});
