// Comments popup: all comment threads in the current board and its nested boards.

import * as bridge from "./bridge.js";
import { icon } from "./icons.js";
import { ingestComments } from "./notifications.js";
import { notify, openBoard, setSelection, state, subscribe } from "./store.js";
import { formatCommentTime } from "./time.js";
import { commentAuthor } from "./comment-author.js";

let anchor = null;
let panel = null;
let refreshTimer = 0;
let panelTimer = 0;
let cachedItems = [];

export function initComments(anchorEl) {
  anchor = anchorEl;
  if (!anchor) return;
  anchor.addEventListener("click", () => {
    if (panel) closeCommentsPanel();
    else openCommentsPanel();
  });
  subscribe((kind) => {
    if (kind === "board" || kind === "boards" || kind === "save") {
      scheduleRefresh();
    }
  });
  scheduleRefresh();
}

export function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(async () => {
    const items = await collectComments();
    cachedItems = items;
    updateCount(items.length);
    ingestComments(items);
    if (panel) renderPanel(items);
  }, 350);
}

function updateCount(count) {
  const label = anchor?.querySelector("span");
  if (label) label.textContent = String(count);
  if (anchor) anchor.title = `${count} comment${count === 1 ? "" : "s"}`;
}

function treeBoardIds(rootId) {
  const ids = [];
  const queue = [rootId];
  const guard = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (!id || guard.has(id)) continue;
    guard.add(id);
    ids.push(id);
    for (const board of state.boards) {
      if (board.parentId === id) queue.push(board.id);
    }
  }
  return ids;
}

function boardPath(id) {
  const parts = [];
  let current = state.boards.find((board) => board.id === id);
  const guard = new Set();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    parts.unshift(current.title || "Untitled");
    current = current.parentId ? state.boards.find((board) => board.id === current.parentId) : null;
  }
  return parts.join(" / ");
}

async function collectComments() {
  if (!state.board) return [];
  const items = [];
  for (const boardId of treeBoardIds(state.board.id)) {
    let doc = null;
    if (boardId === state.board.id) {
      // Read the live document so unsaved edits (a just-sent comment) are included.
      doc = state.board;
    } else {
      try {
        const raw = await bridge.loadBoard(boardId);
        if (raw) doc = JSON.parse(raw);
      } catch {
        continue;
      }
    }
    if (!doc) continue;
    const meta = state.boards.find((board) => board.id === boardId);
    const path = meta ? boardPath(boardId) : doc.title || "Board";
    for (const card of doc.cards || []) {
      if (card.type !== "comment") continue;
      const messages = card.messages || [];
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        items.push({
          boardId,
          cardId: card.id,
          messageId: message.id || `${card.id}:${index}:${message.ts || 0}`,
          boardTitle: meta?.title || doc.title || "Board",
          path,
          author: commentAuthor(message).name,
          text: message.text || "",
          ts: message.ts || 0,
        });
      }
    }
  }
  items.sort((a, b) => b.ts - a.ts);
  return items;
}

export async function openCommentsPanel() {
  if (panel || !anchor) return;
  closeCommentsPanel();
  panel = document.createElement("div");
  panel.className = "mn-comments-pop";
  document.body.append(panel);
  renderPanel(cachedItems);

  const rect = anchor.getBoundingClientRect();
  panel.style.top = `${Math.round(rect.bottom + 8)}px`;
  panel.style.right = `${Math.round(window.innerWidth - rect.right)}px`;

  document.addEventListener("pointerdown", onOutsidePointer, true);
  window.addEventListener("keydown", onKeyDown, true);
  panel.addEventListener("pointerdown", (event) => event.stopPropagation());

  const items = await collectComments();
  cachedItems = items;
  updateCount(items.length);
  ingestComments(items);
  if (panel) renderPanel(items);
}

export function closeCommentsPanel() {
  if (!panel) return;
  panel.remove();
  panel = null;
  document.removeEventListener("pointerdown", onOutsidePointer, true);
  window.removeEventListener("keydown", onKeyDown, true);
}

function onOutsidePointer(event) {
  if (panel && !panel.contains(event.target) && !anchor?.contains(event.target)) closeCommentsPanel();
}

function onKeyDown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeCommentsPanel();
  }
}

function renderPanel(items) {
  if (!panel) return;
  panel.innerHTML = `
    <header class="mn-comments-head">
      <span class="mn-comments-title">Comments</span>
      <span class="mn-comments-total">${items.length}</span>
      <button type="button" class="mn-icon-btn mn-comments-close" title="Close">${icon("close", 13)}</button>
    </header>
    <div class="mn-comments-body"></div>`;
  const body = panel.querySelector(".mn-comments-body");
  panel.querySelector(".mn-comments-close").addEventListener("click", closeCommentsPanel);

  if (!items.length) {
    body.innerHTML = `<div class="mn-comments-empty">No comments yet. Use the Comment tool to add one; comments from nested boards show up here too.</div>`;
    return;
  }

  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mn-comments-item";
    button.innerHTML = `
      <span class="mn-avatar">${initials(item.author)}</span>
      <span class="mn-comments-item-body">
        <span class="mn-comments-text">${escape(item.text)}</span>
        <span class="mn-comments-meta">${escape(item.path)}<span class="mn-comments-dot">·</span>${escape(
          formatCommentTime(item.ts) || relativeTime(item.ts)
        )}</span>
      </span>`;
    button.addEventListener("click", () => focusComment(item));
    body.append(button);
  }
}

async function focusComment(item) {
  closeCommentsPanel();
  if (!state.board || state.board.id !== item.boardId) {
    await openBoard(item.boardId);
  }
  const card = state.board?.cards.find((entry) => entry.id === item.cardId);
  if (!card) return;
  setSelection([card.id]);
  const viewport = document.getElementById("viewport");
  if (!viewport) return;
  const rect = viewport.getBoundingClientRect();
  const zoom = Math.min(1.2, Math.max(0.6, state.view.zoom));
  state.view.zoom = zoom;
  state.view.x = rect.width / 2 - (card.x + card.w / 2) * zoom;
  state.view.y = rect.height / 2 - (card.y + card.h / 2) * zoom;
  notify("view");
  notify("selection");
}

function initials(name) {
  return String(name || "You")
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase())
    .join("")
    .slice(0, 2);
}

function relativeTime(seconds) {
  if (!seconds) return "just now";
  const diff = Math.round(Date.now() / 1000 - seconds / 1000);
  if (diff < 60) return "just now";
  const minutes = Math.round(diff / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function escape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
