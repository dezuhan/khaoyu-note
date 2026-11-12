// Minimal sync dialog and status indicator for opt-in project sync.

import * as bridge from "./bridge.js";
import { adoptRemoteBoard, persistBoardSnapshot, state } from "./store.js";
import { clearRemoteTemp } from "./remote-temp.js";
import * as sync from "./sync.js";
import { clearRemoteCursors, renderRemoteCursors } from "./remote-cursors.js";

let refs = null;
let overlay = null;
let autoTimer = 0;
let running = false;
let realtime = null;
let realtimeBoardId = null;
let realtimeStarting = false;
let lockTimer = 0;
let cursorTimer = 0;
let realtimeConnectionId = null;
let lockCardId = null;
let lockBoardId = null;
let lockBoardRef = null;

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
  window.addEventListener("beforeunload", closeRealtime);
  document.addEventListener("selectionchange", scheduleCursorSend);
  document.addEventListener("focusin", scheduleCursorSend);
  document.addEventListener("focusout", () => {
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(sendCursor, 160);
  });
  window.addEventListener("beforeunload", () => void sync.releaseEditLock(state.board));
  document.addEventListener("focusin", (event) => {
    const card = editableCard(event.target);
    if (card) void acquireLockFor(card);
  });
  document.addEventListener("pointerdown", (event) => {
    const card = editableCard(event.target);
    if (card) {
      void acquireLockFor(card);
    } else if (!event.target.closest?.(".mn-card[data-id]")) {
      void releaseActiveLock();
    }
  });
  document.addEventListener("focusout", (event) => {
    const card = editableCard(event.target);
    if (!card) return;
    const next = event.relatedTarget;
    if (next && card.contains(next)) return;
    scheduleLockRelease(card.dataset.id);
  });
  if (localStorage.getItem("ky.setupCollaboration") === "1") {
    localStorage.removeItem("ky.setupCollaboration");
    const openAfterBoard = (attempt = 0) => {
      if (state.board) openSyncDialog();
      else if (attempt < 20) setTimeout(() => openAfterBoard(attempt + 1), 250);
    };
    setTimeout(() => openAfterBoard(), 500);
  }
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
  ensureRealtime();
}

function closeRealtime() {
  realtime?.close?.();
  realtime = null;
  realtimeBoardId = null;
  realtimeStarting = false;
  realtimeConnectionId = null;
  clearRemoteCursors();
}

function releaseActiveLock() {
  clearTimeout(lockTimer);
  lockTimer = 0;
  lockCardId = null;
  lockBoardId = null;
  const board = lockBoardRef;
  lockBoardRef = null;
  return sync.releaseEditLock(board);
}

function editableCard(target) {
  const editable = target?.closest?.(
    '[contenteditable="true"], input, textarea, [data-field]'
  );
  return editable?.closest?.(".mn-card[data-id]") || null;
}

async function acquireLockFor(cardEl) {
  if (!cardEl || !state.board || !sync.syncEnabled(state.board)) return;
  const cardId = cardEl.dataset.id;
  if (lockCardId === cardId && lockBoardId === state.board.id) return;
  await releaseActiveLock();
  try {
    const lock = await sync.acquireEditLock(state.board, cardId);
    if (!lock) {
      window.dispatchEvent(
        new CustomEvent("mn:toast", { detail: { message: "This card is being edited by another user" } })
      );
      return;
    }
    lockCardId = cardId;
    lockBoardId = state.board.id;
    lockBoardRef = state.board;
  } catch (error) {
    window.dispatchEvent(
      new CustomEvent("mn:toast", { detail: { message: error.message || "Could not lock this card" } })
    );
  }
}

function scheduleLockRelease(cardId) {
  clearTimeout(lockTimer);
  lockTimer = setTimeout(() => {
    if (lockCardId !== cardId || lockBoardId !== state.board?.id) return;
    const active = editableCard(document.activeElement);
    if (active?.dataset.id === cardId) return;
    void releaseActiveLock();
  }, 350);
}

function ensureRealtime() {
  const board = state.board;
  if (!board || !sync.syncEnabled(board) || !sync.loadSyncConfig().token) {
    closeRealtime();
    return;
  }
  if (realtimeBoardId === board.id || realtimeStarting) return;
  closeRealtime();
  realtimeStarting = true;
  sync
    .openRealtime(board, {
      onReady: ({ connectionId }) => {
        realtimeConnectionId = connectionId;
        sendCursor();
      },
      onUpdate: async ({ type, data }) => {
        if (type === "presence") {
          if (Number.isFinite(Number(data?.accounts))) {
            refs?.syncState?.setAttribute("data-presence", String(data.accounts));
            refs?.syncState?.setAttribute(
              "title",
              `${data.accounts} user${data.accounts === 1 ? "" : "s"} in this project`
            );
          }
          renderRemoteCursors(data?.users || [], realtimeConnectionId);
          return;
        }
        if (type === "ops") {
          try {
            const result = await sync.consumeRemoteOperations(state.board);
            if (result.doc) {
              await adoptRemoteBoard(result.doc);
              await persistBoardSnapshot();
            }
            refresh();
          } catch {
            /* the normal sync pass will surface errors */
          }
          return;
        }
        if (type !== "snapshot") return;
        if (state.dirty) {
          if (state.board) state.board.sync.conflict = true;
          refresh();
          return;
        }
        try {
          const pulled = await sync.pullBoard(state.board);
          if (pulled.status === "pulled") {
            await adoptRemoteBoard(pulled.doc);
            await persistBoardSnapshot();
          }
          refresh();
        } catch {
          /* the normal sync pass will surface errors */
        }
      },
      onStatus: (status) => {
        if (status === "offline") {
          closeRealtime();
          setTimeout(ensureRealtime, 4000);
        }
      },
    })
    .then((handle) => {
      realtimeStarting = false;
      if (!handle?.supported) return;
      realtime = handle;
      realtimeBoardId = board.id;
    })
    .catch(() => {
      realtimeStarting = false;
    });
}

function currentCursor() {
  const active = document.activeElement;
  if (!active || !state.board) return null;
  const field = active.closest?.('[contenteditable="true"], textarea, input');
  const card = field?.closest?.(".mn-card[data-id]");
  if (!field || !card) return null;
  let offset = 0;
  let length = 0;
  if (field.tagName === "INPUT" || field.tagName === "TEXTAREA") {
    offset = field.selectionStart || 0;
    length = Math.max(0, (field.selectionEnd || offset) - offset);
  } else {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !field.contains(selection.anchorNode)) return null;
    const range = selection.getRangeAt(0);
    const before = document.createRange();
    before.selectNodeContents(field);
    before.setEnd(range.startContainer, range.startOffset);
    offset = before.toString().length;
    length = range.toString().length;
  }
  return {
    cardId: card.dataset.id,
    field: field.dataset.field || "text",
    offset,
    length,
  };
}

function sendCursor() {
  if (!state.board || !realtimeConnectionId || !sync.syncEnabled(state.board)) return;
  const cursor = currentCursor();
  const config = sync.loadSyncConfig();
  void sync.sendPresence(state.board, realtimeConnectionId, cursor, config.email || "Guest");
}

function scheduleCursorSend() {
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(sendCursor, 120);
}

function onBoardSaved(event) {
  if (event.detail?.boardId !== state.board?.id) return;
  if (!sync.syncEnabled(state.board)) return;
  if (state.board.sync.conflict) return;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(async () => {
    try {
      const result = await sync.pushLiveChanges(state.board);
      if (result.status === "pushed" || result.status === "noop") {
        clearRemoteTemp(event.detail.boardId);
        await persistBoardSnapshot();
        refresh();
      } else if (result.status === "conflict") {
        await runSync({ quiet: true });
      }
    } catch (error) {
      if (error.offline) {
        sync.enqueueForOffline(state.board);
        refresh();
      } else if (error.code === "card_locked") {
        window.dispatchEvent(
          new CustomEvent("mn:toast", { detail: { message: "A card is locked by another editor" } })
        );
      }
    }
  }, state.remote ? 120 : 500);
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
  const config = sync.loadSyncConfig();
  if (config.token) {
    void updateConnection();
  } else if (config.url) {
    void sync.checkServerReachable(config.url).then((result) => renderConnection(result));
  }
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
  url.type = "text";
  url.placeholder = "http://127.0.0.1:8080";
  url.value = config.url;
  urlLabel.append(url);

  const emailLabel = document.createElement("label");
  emailLabel.className = "mn-sync-field";
  emailLabel.textContent = "Email";
  const email = document.createElement("input");
  email.className = "ky-input";
  email.type = "email";
  email.autocomplete = "username";
  email.placeholder = "you@example.com";
  email.value = config.email;
  emailLabel.append(email);

  const passwordLabel = document.createElement("label");
  passwordLabel.className = "mn-sync-field";
  passwordLabel.textContent = "Password";
  const password = document.createElement("input");
  password.className = "ky-input";
  password.type = "password";
  password.autocomplete = "current-password";
  password.placeholder = config.token ? "Leave empty to stay signed in" : "Account password";
  passwordLabel.append(password);

  body.append(urlLabel, emailLabel, passwordLabel);

  const signedIn = document.createElement("div");
  signedIn.className = "mn-sync-signed-in";
  signedIn.textContent = config.token
    ? `Signed in as ${config.email || "this account"}`
    : "Not signed in yet. Use your account email and password.";
  body.append(signedIn);

  if (!config.token) {
    body.append(
      button("Create an account on this server", "mn-btn mn-btn-quiet", () => {
        try {
          bridge.openExternal(`${sync.normalizeServerUrl(url.value)}/account`).catch(() => {});
        } catch (error) {
          toast(error.message || "Enter the server URL first");
        }
      })
    );
  }

  const statusLine = document.createElement("div");
  statusLine.className = "mn-sync-status";
  statusLine.dataset.role = "sync-status";
  statusLine.dataset.status = status.status;
  statusLine.textContent = status.message;
  body.append(statusLine);

  const connection = document.createElement("div");
  connection.className = "mn-sync-connection";
  connection.dataset.role = "sync-connection";
  connection.dataset.status = sync.connectionStatus.state;
  connection.textContent = connectionText(sync.connectionStatus);
  body.append(connection);

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
  const applyFields = () => {
    const current = sync.loadSyncConfig();
    const saved = sync.saveSyncConfig({
      url: url.value,
      email: email.value,
      token: current.token,
      publicShareUrl: current.publicShareUrl,
    });
    url.value = saved.url;
    return saved;
  };
  const checkButton = button("Check connection", "mn-btn", async () => {
    const current = sync.loadSyncConfig();
    if (!current.token) {
      renderConnection(await sync.checkServerReachable(url.value));
      return;
    }
    try {
      applyFields();
    } catch (error) {
      renderConnection({ state: "unconfigured", message: error.message, projectCount: null });
      toast(error.message || "Could not use that server URL");
      return;
    }
    await updateConnection();
  });
  const primary = button(
    enabled ? "Sync now" : config.token ? "Check connection and connect" : "Sign in and connect",
    "mn-btn mn-btn-primary",
    async () => {
      const before = sync.loadSyncConfig();
      let saved;
      try {
        saved = applyFields();
      } catch (error) {
        renderConnection({ state: "unconfigured", message: error.message, projectCount: null });
        toast(error.message || "Could not use that server URL");
        return;
      }
      if (enabled) {
        await runSync();
        return;
      }
      const emailChanged = Boolean(before.email) && before.email !== saved.email;
      const needsSignIn = !saved.token || password.value.length > 0 || emailChanged;
      primary.disabled = true;
      try {
        if (needsSignIn) {
          if (!password.value) {
            const message = saved.token
              ? "Enter the password to sign in with this email"
              : "Enter the account password";
            renderConnection({ state: "unconfigured", message, projectCount: null });
            toast(message);
            return;
          }
          const reachable = await sync.checkServerReachable(saved.url);
          renderConnection(reachable);
          if (!reachable.ok) {
            toast(connectionText(reachable));
            return;
          }
          renderConnection({ state: "checking", message: "Signing in...", projectCount: null });
          try {
            await sync.signIn({
              url: saved.url,
              email: saved.email,
              password: password.value,
            });
          } catch (error) {
            renderConnection({
              state: "unauthorized",
              message: error.message || "Sign in failed",
              projectCount: null,
            });
            toast(error.message || "Sign in failed");
            return;
          }
          password.value = "";
          email.value = sync.loadSyncConfig().email;
        }
        const result = await updateConnection();
        if (!result.ok) {
          toast(connectionText(result));
          return;
        }
        await runSync();
      } finally {
        primary.disabled = false;
      }
    }
  );
  foot.append(checkButton, primary);
  if (config.token && !enabled) {
    foot.append(
      button("Sign out", "mn-btn mn-btn-quiet", () => {
        sync.signOut();
        toast("Signed out of the sync server");
        renderDialog();
      })
    );
  }
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

function connectionText(status) {
  return sync.describeConnection(status);
}

function renderConnection(status) {
  const line = overlay?.querySelector('[data-role="sync-connection"]');
  if (!line) return;
  line.dataset.status = status.state;
  line.textContent = connectionText(status);
}

async function updateConnection() {
  renderConnection({ state: "checking", message: "Checking...", projectCount: null });
  const result = await sync.checkConnection();
  renderConnection(result);
  return result;
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
