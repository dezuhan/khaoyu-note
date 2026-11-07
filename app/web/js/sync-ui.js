// Minimal sync dialog and status indicator for opt-in project sync.

import { adoptRemoteBoard, persistBoardSnapshot, state } from "./store.js";
import * as sync from "./sync.js";

let refs = null;
let overlay = null;
let autoTimer = 0;
let running = false;

function toast(message) {
  window.dispatchEvent(new CustomEvent("mn:toast", { detail: { message } }));
}

export function initSyncUI(uiRefs) {
  refs = uiRefs;
  refs.syncButton?.addEventListener("click", openSyncDialog);
  window.addEventListener("mn:board-saved", onBoardSaved);
  window.addEventListener("online", () => {
    sync.flushQueue().finally(refresh);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && overlay) closeDialog();
  });
  refresh();
}

export function refresh() {
  if (!refs?.syncState) return;
  if (!state.board) {
    refs.syncState.textContent = "Sync off";
    refs.syncState.dataset.status = "disabled";
    return;
  }
  const status = sync.syncStatusFor(state.board);
  refs.syncState.textContent =
    status.status === "synced" ? status.message : status.message || "Sync";
  refs.syncState.dataset.status = status.status;
  if (overlay) renderStatus();
}

function onBoardSaved(event) {
  if (event.detail?.boardId !== state.board?.id) return;
  if (!sync.syncEnabled(state.board)) return;
  if (state.board.sync.conflict) return;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => runSync({ quiet: true }), 1200);
}

export function openSyncDialog() {
  if (overlay) return;
  overlay = document.createElement("div");
  overlay.className = "mn-sync-overlay";
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeDialog();
  });
  document.body.append(overlay);
  renderDialog();
}

function closeDialog() {
  overlay?.remove();
  overlay = null;
}

function renderDialog() {
  if (!overlay || !state.board) return;
  const board = state.board;
  const config = sync.loadSyncConfig();
  const enabled = sync.syncEnabled(board);
  const status = sync.syncStatusFor(board);
  overlay.textContent = "";

  const panel = document.createElement("section");
  panel.className = "mn-modal mn-sync-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Server sync");

  const head = document.createElement("header");
  head.className = "mn-modal-head";
  const title = document.createElement("h2");
  title.className = "mn-modal-title";
  title.textContent = "Server sync";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "mn-icon-btn mn-modal-close";
  close.setAttribute("aria-label", "Close sync");
  close.textContent = "×";
  close.addEventListener("click", closeDialog);
  head.append(title, close);

  const body = document.createElement("div");
  body.className = "mn-modal-body mn-sync-body";

  const note = document.createElement("p");
  note.className = "mn-prefs-note";
  note.textContent =
    "Local boards remain authoritative. Sync is opt-in per board and deleting a local board never deletes server data.";
  body.append(note);

  const urlLabel = document.createElement("label");
  urlLabel.className = "mn-sync-field";
  urlLabel.textContent = "Server URL";
  const url = document.createElement("input");
  url.className = "ky-input";
  url.type = "url";
  url.placeholder = "https://notes.example.com";
  url.value = config.url;
  urlLabel.append(url);

  const tokenLabel = document.createElement("label");
  tokenLabel.className = "mn-sync-field";
  tokenLabel.textContent = "API token";
  const token = document.createElement("input");
  token.className = "ky-input";
  token.type = "password";
  token.autocomplete = "off";
  token.placeholder = "projects:read and projects:write";
  token.value = config.token;
  tokenLabel.append(token);
  body.append(urlLabel, tokenLabel);

  const statusLine = document.createElement("div");
  statusLine.className = "mn-sync-status";
  statusLine.dataset.role = "sync-status";
  statusLine.dataset.status = status.status;
  statusLine.textContent = status.message;
  body.append(statusLine);

  if (enabled) {
    const info = document.createElement("div");
    info.className = "mn-sync-meta";
    info.textContent = `Project ${board.sync.projectId} · revision ${board.sync.revision}`;
    body.append(info);
  }

  if (board.sync?.conflict) {
    const conflict = document.createElement("div");
    conflict.className = "mn-sync-conflict";
    const text = document.createElement("p");
    text.textContent =
      "Both this board and the server changed. Choose which version to keep. The other version stays available in server revision history.";
    const actions = document.createElement("div");
    actions.className = "mn-sync-actions";
    const server = document.createElement("button");
    server.type = "button";
    server.className = "mn-btn";
    server.textContent = "Use server";
    server.addEventListener("click", () => resolveConflict("server"));
    const local = document.createElement("button");
    local.type = "button";
    local.className = "mn-btn mn-btn-primary";
    local.textContent = "Keep local";
    local.addEventListener("click", () => resolveConflict("local"));
    actions.append(server, local);
    conflict.append(text, actions);
    body.append(conflict);
  }

  const foot = document.createElement("footer");
  foot.className = "mn-modal-foot mn-sync-foot";
  const save = button("Save connection", "mn-btn", async () => {
    sync.saveSyncConfig({ url: url.value.trim(), token: token.value.trim() });
    toast("Sync connection saved");
    refresh();
  });
  const primary = button(enabled ? "Sync now" : "Enable for this board", "mn-btn mn-btn-primary", async () => {
    sync.saveSyncConfig({ url: url.value.trim(), token: token.value.trim() });
    await runSync();
  });
  foot.append(save, primary);
  if (enabled) {
    foot.append(
      button("Disable for this board", "mn-btn mn-btn-quiet", async () => {
        delete state.board.sync;
        await persistBoardSnapshot();
        refresh();
        renderDialog();
        toast("Sync disabled for this board; server data was not deleted");
      })
    );
  }
  foot.append(button("Close", "mn-btn mn-btn-quiet", closeDialog));

  panel.append(head, body, foot);
  overlay.append(panel);
}

function button(label, className, handler) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.addEventListener("click", () => handler());
  return element;
}

function renderStatus() {
  if (!overlay) return;
  const line = overlay.querySelector('[data-role="sync-status"]');
  if (!line) return;
  const status = sync.syncStatusFor(state.board);
  line.dataset.status = status.status;
  line.textContent = status.message;
}

async function runSync({ quiet = false } = {}) {
  if (running || !state.board) return;
  running = true;
  try {
    let result;
    if (!sync.syncEnabled(state.board)) result = await sync.enableBoardSync(state.board);
    else result = await sync.syncBoard(state.board);
    if (result.status === "pulled") {
      await adoptRemoteBoard(result.doc);
    } else if (result.status === "conflict") {
      state.board.sync.conflict = true;
      await persistBoardSnapshot();
    } else {
      await persistBoardSnapshot();
    }
    if (!quiet) toast(result.status === "conflict" ? "Sync conflict" : "Sync complete");
  } catch (error) {
    if (error.offline) {
      sync.enqueueForOffline(state.board);
      if (!quiet) toast("Offline: changes queued for sync");
    } else if (!quiet) {
      toast(error.message || "Sync failed");
    }
  } finally {
    running = false;
    refresh();
    if (overlay) renderDialog();
  }
}

async function resolveConflict(choice) {
  if (!state.board?.sync) return;
  try {
    const result = await sync.resolveSyncConflict(state.board, choice);
    if (result.status === "pulled" && result.doc) await adoptRemoteBoard(result.doc);
    else {
      state.board.sync.conflict = null;
      await persistBoardSnapshot();
    }
    toast(choice === "server" ? "Server version adopted" : "Local version pushed");
  } catch (error) {
    toast(error.message || "Could not resolve sync conflict");
  }
  refresh();
  if (overlay) renderDialog();
}
