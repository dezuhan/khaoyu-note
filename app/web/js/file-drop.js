// Native OS file drops: Tauri forwards absolute paths, the web layer decides the card type.

import * as bridge from "./bridge.js";
import { addCardAt } from "./actions.js";
import { isBlockedUpload, isTemporarilyDisabledType, reportUploadProblem } from "./limits.js";
import { markDirty, state } from "./store.js";

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "avif",
  "ico",
]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "m4a", "aac", "flac"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const RAW_EXTENSIONS = new Set(["raw", "cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "raf", "pef", "srw"]);

let overlay = null;

export function classifyDropFile(name) {
  const extension = String(name || "").split(".").pop().toLowerCase();
  if (RAW_EXTENSIONS.has(extension)) return "file";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  return "file";
}

export function initFileDrop() {
  const tauri = window.__TAURI__;
  if (!tauri?.event?.listen) return;
  overlay = document.createElement("div");
  overlay.className = "mn-file-drop-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `<div class="mn-file-drop-message">Drop files to add them to this board</div>`;
  document.body.append(overlay);

  tauri.event.listen("tauri://drag-enter", (event) => {
    showDropOverlay(event.payload);
  });
  tauri.event.listen("tauri://drag-over", (event) => {
    showDropOverlay(event.payload);
  });
  tauri.event.listen("tauri://drag-leave", () => {
    hideDropOverlay();
  });
  tauri.event.listen("tauri://drag-drop", async (event) => {
    hideDropOverlay();
    const payload = event.payload || {};
    const position = payload.position || {};
    const scale = window.devicePixelRatio || 1;
    await handleDroppedPaths(payload.paths || [], position.x / scale, position.y / scale);
  });
}

function showDropOverlay(payload) {
  if (!overlay) return;
  const count = Array.isArray(payload?.paths) ? payload.paths.length : 0;
  const message = overlay.querySelector(".mn-file-drop-message");
  if (message) {
    message.textContent = count
      ? `Drop ${count} file${count === 1 ? "" : "s"} to add to this board`
      : "Drop files to add them to this board";
  }
  overlay.hidden = false;
}

function hideDropOverlay() {
  if (overlay) overlay.hidden = true;
}

export async function handleDroppedPaths(paths, clientX, clientY) {
  if (!state.board || !paths.length) return 0;
  const viewport = document.getElementById("viewport");
  const rect = viewport.getBoundingClientRect();
  const basePoint = {
    x: (clientX - rect.left - state.view.x) / state.view.zoom,
    y: (clientY - rect.top - state.view.y) / state.view.zoom,
  };
  let added = 0;
  for (let index = 0; index < paths.length; index += 1) {
    const sourcePath = paths[index];
    const name = String(sourcePath).split(/[\\/]/).pop() || "file";
    if (isBlockedUpload(name)) {
      reportUploadProblem(`Skipped ${name}: this file type is not allowed.`);
      continue;
    }
    let kind = classifyDropFile(name);
    // Local media still uploads through this path, but a disabled card type falls back to a file
    // card so the asset is stored and visible instead of becoming a hidden card.
    if ((kind === "audio" || kind === "video") && isTemporarilyDisabledType(kind)) {
      kind = "file";
    }
    let stored = null;
    try {
      stored = await bridge.storeAssetFromPath(sourcePath);
    } catch (error) {
      reportUploadProblem(
        error instanceof Error ? error.message : `Could not import ${name}.`
      );
      continue;
    }
    if (!stored) continue;
    const point = { x: basePoint.x + index * 24, y: basePoint.y + index * 24 };
    const card = addCardAt(kind, point);
    if (!card) continue;
    if (kind === "image") {
      card.src = stored;
      card.caption = card.caption || "";
    } else if (kind === "audio") {
      card.url = stored;
      card.name = name;
    } else if (kind === "video") {
      card.url = stored;
      card.name = name;
    } else {
      card.name = name;
      card.path = stored;
    }
    added += 1;
  }
  if (added) {
    markDirty("board");
    window.dispatchEvent(
      new CustomEvent("mn:toast", {
        detail: { message: `Added ${added} file${added === 1 ? "" : "s"}` },
      })
    );
  }
  return added;
}
