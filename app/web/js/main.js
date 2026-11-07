import * as bridge from "./bridge.js";
import { initInteractions } from "./interact.js";
import { initRender, render, renderSelection, renderView } from "./render.js";
import { initSettings } from "./settings.js";
import { initSyncUI, refresh as refreshSync } from "./sync-ui.js";
import { initShareUI } from "./share-ui.js";
import { initUpdateUI } from "./update-ui.js";
import { maybeShowOnboarding } from "./onboarding.js";
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

async function boot() {
  initTheme();
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
  });

  await refreshBoards();
  const last = localStorage.getItem("mn.lastBoard");
  const remembered = state.boards.find(
    (board) => board.id === last && !board.trashedAt && !board.archivedAt
  );
  if (remembered) {
    await openBoard(remembered.id);
  } else {
    const next = firstOpenableBoard();
    if (next) await openBoard(next.id);
    else await createBoard("Home", { withWelcome: true });
  }
  render("board");
  renderView();
  refreshSync();
  maybeShowOnboarding();
  initUpdateUI();
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
