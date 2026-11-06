// Notification center fed by comment activity across the current board tree.

import * as bridge from "./bridge.js";
import { icon } from "./icons.js";
import { notify, openBoard, setSelection, state } from "./store.js";

const STORAGE_KEY = "ui_notifications";
const MAX_ITEMS = 200;

let anchor = null;
let panel = null;
let notifications = [];
let loaded = false;
let loadPromise = null;
let saveTimer = 0;

export function initNotifications(anchorEl) {
  anchor = anchorEl;
  if (!anchor) return;
  anchor.innerHTML = `${icon("bell", 16)}<span class="mn-notify-badge" hidden></span>`;
  anchor.addEventListener("click", () => {
    if (panel) closeNotificationsPanel();
    else openNotificationsPanel();
  });
  loadNotifications();
}

async function loadNotifications() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await bridge.getSetting(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      notifications = Array.isArray(parsed) ? parsed : [];
    } catch {
      notifications = [];
    }
    loaded = true;
    refreshBadge();
    if (panel) renderPanel();
  })();
  return loadPromise;
}

function saveNotifications() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    bridge.setSetting(STORAGE_KEY, JSON.stringify(notifications)).catch(() => {});
  }, 150);
}

function active() {
  return notifications.filter((item) => !item.removed);
}

export async function ingestComments(items) {
  await loadNotifications();
  const known = new Set(notifications.map((item) => item.key));
  let changed = false;
  for (const item of items || []) {
    const key = `${item.boardId}:${item.cardId}:${item.messageId}`;
    if (known.has(key)) continue;
    known.add(key);
    notifications.unshift({
      id: `ntf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      key,
      boardId: item.boardId,
      cardId: item.cardId,
      messageId: item.messageId,
      author: item.author || "You",
      text: item.text || "",
      path: item.path || "Board",
      ts: item.ts || Date.now(),
      read: false,
      removed: false,
    });
    changed = true;
  }
  if (!changed) return;
  notifications = notifications.slice(0, MAX_ITEMS);
  refreshBadge();
  saveNotifications();
  if (panel) renderPanel();
}

function refreshBadge() {
  if (!anchor) return;
  const unread = active().filter((item) => !item.read).length;
  const badge = anchor.querySelector(".mn-notify-badge");
  if (badge) {
    badge.textContent = unread > 99 ? "99+" : String(unread);
    badge.hidden = unread === 0;
  }
  anchor.title = unread ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "Notifications";
  anchor.classList.toggle("has-unread", unread > 0);
}

export async function openNotificationsPanel() {
  if (panel || !anchor) return;
  await loadNotifications();
  panel = document.createElement("div");
  panel.className = "mn-notify-pop";
  document.body.append(panel);
  renderPanel();
  const rect = anchor.getBoundingClientRect();
  panel.style.top = `${Math.round(rect.bottom + 8)}px`;
  panel.style.right = `${Math.round(window.innerWidth - rect.right)}px`;
  document.addEventListener("pointerdown", onOutsidePointer, true);
  window.addEventListener("keydown", onKeyDown, true);
  panel.addEventListener("pointerdown", (event) => event.stopPropagation());
}

export function closeNotificationsPanel() {
  if (!panel) return;
  panel.remove();
  panel = null;
  document.removeEventListener("pointerdown", onOutsidePointer, true);
  window.removeEventListener("keydown", onKeyDown, true);
}

function onOutsidePointer(event) {
  if (panel && !panel.contains(event.target) && !anchor?.contains(event.target)) {
    closeNotificationsPanel();
  }
}

function onKeyDown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeNotificationsPanel();
  }
}

function renderPanel() {
  if (!panel) return;
  const items = active();
  const unread = items.filter((item) => !item.read).length;
  panel.innerHTML = `
    <header class="mn-notify-head">
      <span class="mn-notify-title">Notifications</span>
      <span class="mn-notify-unread">${unread}</span>
      <button type="button" class="mn-icon-btn mn-notify-close" title="Close">${icon("close", 13)}</button>
    </header>
    <div class="mn-notify-actions">
      <button type="button" class="mn-btn mn-btn-quiet" data-notify="read-all"${
        unread ? "" : " disabled"
      }>Mark all as read</button>
      <button type="button" class="mn-btn mn-btn-quiet" data-notify="delete-all"${
        items.length ? "" : " disabled"
      }>Delete all</button>
    </div>
    <div class="mn-notify-body"></div>`;
  panel.querySelector(".mn-notify-close").addEventListener("click", closeNotificationsPanel);
  panel.querySelector('[data-notify="read-all"]').addEventListener("click", markAllRead);
  panel.querySelector('[data-notify="delete-all"]').addEventListener("click", deleteAll);

  const body = panel.querySelector(".mn-notify-body");
  if (!items.length) {
    body.innerHTML = `<div class="mn-notify-empty">No notifications. New comment activity will appear here.</div>`;
    return;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = `mn-notify-item${item.read ? "" : " is-unread"}`;
    row.innerHTML = `
      <button type="button" class="mn-notify-open">
        <span class="mn-notify-dot" aria-hidden="true"></span>
        <span class="mn-notify-copy">
          <span class="mn-notify-text">${escape(item.text || "New comment")}</span>
          <span class="mn-notify-meta">${escape(item.author || "You")} · ${escape(item.path || "Board")} · ${relativeTime(item.ts)}</span>
        </span>
      </button>
      <span class="mn-notify-item-actions">
        <button type="button" class="mn-notify-action" data-notify-action="read">${
          item.read ? "Mark unread" : "Mark read"
        }</button>
        <button type="button" class="mn-notify-remove" data-notify-action="remove" title="Remove notification" aria-label="Remove notification">${icon(
          "close",
          11
        )}</button>
      </span>`;
    row.querySelector(".mn-notify-open").addEventListener("click", () => openNotification(item));
    row.querySelector('[data-notify-action="read"]').addEventListener("click", () => toggleRead(item.id));
    row.querySelector('[data-notify-action="remove"]').addEventListener("click", () => removeNotification(item.id));
    body.append(row);
  }
}

function markAllRead() {
  let changed = false;
  for (const item of notifications) {
    if (!item.removed && !item.read) {
      item.read = true;
      changed = true;
    }
  }
  if (!changed) return;
  saveNotifications();
  refreshBadge();
  renderPanel();
}

function toggleRead(id) {
  const item = notifications.find((entry) => entry.id === id);
  if (!item) return;
  item.read = !item.read;
  saveNotifications();
  refreshBadge();
  renderPanel();
}

function removeNotification(id) {
  const item = notifications.find((entry) => entry.id === id);
  if (!item) return;
  item.removed = true;
  saveNotifications();
  refreshBadge();
  renderPanel();
}

function deleteAll() {
  if (!active().length) return;
  for (const item of notifications) item.removed = true;
  saveNotifications();
  refreshBadge();
  renderPanel();
}

async function openNotification(item) {
  item.read = true;
  saveNotifications();
  refreshBadge();
  closeNotificationsPanel();
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
