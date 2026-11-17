// OS deep links: khaoyunote://open?board=<id>. The Rust side (lib.rs, `parse_deep_link`) validates the
// URL and forwards only a board id or a human-readable error, so this module only has to switch to an
// existing local board. Web host/browser previews never receive Tauri events and stay a no-op.

import * as bridge from "./bridge.js";
import { closeSettingsPage } from "./settings.js";
import { openBoard, refreshBoards, state } from "./store.js";
import { toast } from "./ui.js";

function updateBoardUrl(boardId) {
  const params = new URLSearchParams(window.location.search);
  params.set("board", boardId);
  const query = params.toString();
  history.replaceState(null, "", `${window.location.pathname}?${query}${window.location.hash}`);
}

export async function handleDeepLink(payload) {
  if (!payload) return;
  if (payload.error) {
    toast(String(payload.error));
    return;
  }
  const boardId = String(payload.boardId || "");
  if (!boardId) return;
  try {
    closeSettingsPage();
  } catch {
    /* settings may not be open */
  }
  await refreshBoards();
  const board = state.boards.find(
    (entry) => entry.id === boardId && !entry.trashedAt && !entry.archivedAt
  );
  if (!board) {
    toast("This deep link points to a board that is not in the local database.");
    return;
  }
  if (state.board?.id !== boardId) await openBoard(boardId);
  updateBoardUrl(boardId);
}

export function initDeepLinks() {
  // Also usable as a DOM event by the local web host and the browser test.
  window.addEventListener("mn:deep-link", (event) => {
    void handleDeepLink(event.detail);
  });
  if (!bridge.hasTauri) return;
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen === "function") {
    void listen("mn:deep-link", (event) => {
      void handleDeepLink(event.payload);
    }).catch(() => {});
  }
  void bridge
    .takePendingDeepLink()
    .then((payload) => {
      if (payload) void handleDeepLink(payload);
    })
    .catch(() => {});
}
