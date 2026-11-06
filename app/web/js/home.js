// Home screen: project cards with previews, plus Archive and Trash views.

import * as bridge from "./bridge.js";
import { icon } from "./icons.js";
import { paintBoardPreview } from "./preview.js";
import { createBoard, openBoard, refreshBoards, removeBoard, state, subscribe } from "./store.js";

let page = null;
let previewCache = new Map();
let renderToken = 0;
let homeTab = "projects";
const selectedProjects = new Set();

export function initHome(element) {
  page = element;
  subscribe((kind) => {
    if (kind === "boards" && page && !page.hidden) renderHome();
  });
}

export function showHome() {
  if (!page) return;
  page.hidden = false;
  const app = document.getElementById("app");
  if (app) app.hidden = true;
  renderHome();
}

export function hideHome() {
  if (!page) return;
  page.hidden = true;
  const app = document.getElementById("app");
  if (app) app.hidden = false;
}

export async function backToBoard() {
  const current = state.board
    ? state.boards.find((board) => board.id === state.board.id && !board.trashedAt)
    : null;
  if (!current) {
    const openable = state.boards.filter((board) => !board.parentId && !board.trashedAt);
    const next = openable.find((board) => !board.archivedAt) || openable[0];
    if (!next) {
      window.dispatchEvent(
        new CustomEvent("mn:toast", { detail: { message: "No projects left. Create a project first." } })
      );
      return;
    }
    await openBoard(next.id);
  }
  hideHome();
}

export function homeVisible() {
  return Boolean(page && !page.hidden);
}

function relativeTime(value) {
  if (!value) return "";
  // Accept both the old second timestamps and the current millisecond ones.
  const stamp = value < 100000000000 ? value * 1000 : value;
  const diff = Math.round((Date.now() - stamp) / 1000);
  if (diff < 60) return "just now";
  const minutes = Math.round(diff / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

async function loadDoc(id) {
  try {
    const raw = await bridge.loadBoard(id);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function archiveProject(id, archived) {
  await bridge.archiveBoard(id, archived);
  await refreshBoards();
  renderHome();
}

async function trashProject(id, trashed) {
  await bridge.trashBoard(id, trashed);
  await refreshBoards();
  renderHome();
}

function homeDialog({ title, message, value = null, confirmLabel = "Save", danger = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "mn-overlay";
    overlay.innerHTML = `<div class="mn-modal mn-home-dialog">
        <header class="mn-modal-head"><h2 class="mn-modal-title">${escapeText(title)}</h2></header>
        <div class="mn-modal-body">${
          value === null
            ? `<p class="mn-confirm-text">${escapeText(message)}</p>`
            : `<label class="mn-settings-label" for="home-dialog-name">${escapeText(
                message
              )}</label><input class="ky-input" id="home-dialog-name" value="${escapeText(value)}" />`
        }</div>
        <footer class="mn-modal-foot">
          <button type="button" class="mn-btn" data-dialog="cancel">Cancel</button>
          <button type="button" class="mn-btn${danger ? " mn-btn-danger" : " mn-btn-primary"}" data-dialog="ok">${escapeText(
            confirmLabel
          )}</button>
        </footer>
      </div>`;
    document.body.append(overlay);
    const input = overlay.querySelector("#home-dialog-name");
    const close = (result) => {
      overlay.remove();
      resolve(result);
    };
    overlay.querySelector('[data-dialog="cancel"]').addEventListener("click", () => close(null));
    overlay.querySelector('[data-dialog="ok"]').addEventListener("click", () => {
      close(value === null ? true : (input.value || "").trim());
    });
    overlay.addEventListener("pointerdown", (event) => {
      if (event.target === overlay) close(null);
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(null);
      } else if (event.key === "Enter" && input) {
        event.preventDefault();
        close((input.value || "").trim());
      }
    });
    if (input) {
      input.focus();
      input.select();
    }
  });
}

async function renameProject(meta) {
  const name = await homeDialog({
    title: "Rename project",
    message: "Project name",
    value: meta.title || "Untitled",
    confirmLabel: "Rename",
  });
  if (!name || name === meta.title) return;
  await bridge.renameBoard(meta.id, name);
  if (state.board?.id === meta.id) state.board.title = name;
  await refreshBoards();
  renderHome();
}

function toggleProjectSelection(id) {
  if (selectedProjects.has(id)) selectedProjects.delete(id);
  else selectedProjects.add(id);
  renderHome();
}

async function bulkArchive(archived) {
  const ids = [...selectedProjects];
  if (!ids.length) return;
  for (const id of ids) await bridge.archiveBoard(id, archived);
  selectedProjects.clear();
  await refreshBoards();
  renderHome();
}

async function bulkTrash(trashed) {
  const ids = [...selectedProjects];
  if (!ids.length) return;
  for (const id of ids) await bridge.trashBoard(id, trashed);
  selectedProjects.clear();
  await refreshBoards();
  renderHome();
}

async function bulkDelete() {
  const ids = [...selectedProjects];
  if (!ids.length) return;
  const confirmed = await homeDialog({
    title: "Delete projects?",
    message: `${ids.length} project${ids.length === 1 ? "" : "s"} will be deleted permanently.`,
    confirmLabel: "Delete forever",
    danger: true,
  });
  if (!confirmed) return;
  for (const id of ids) await bridge.deleteBoard(id);
  if (state.board && ids.includes(state.board.id)) state.board = null;
  selectedProjects.clear();
  await refreshBoards();
  renderHome();
}

async function deleteAllTrash() {
  const trashed = state.boards.filter((board) => !board.parentId && board.trashedAt);
  if (!trashed.length) return;
  const confirmed = await homeDialog({
    title: "Empty Trash?",
    message: `All ${trashed.length} project${trashed.length === 1 ? "" : "s"} in Trash will be deleted permanently.`,
    confirmLabel: "Delete all",
    danger: true,
  });
  if (!confirmed) return;
  for (const board of trashed) await bridge.deleteBoard(board.id);
  if (state.board && trashed.some((board) => board.id === state.board.id)) state.board = null;
  selectedProjects.clear();
  await refreshBoards();
  renderHome();
}

async function renderHome() {
  if (!page) return;
  const token = ++renderToken;
  const rootMetas = state.boards.filter((board) => !board.parentId);
  const entries = rootMetas.map((meta) => ({ meta }));
  if (token !== renderToken) return;

  const active = entries.filter((entry) => !entry.meta.archivedAt && !entry.meta.trashedAt);
  const archived = entries.filter((entry) => entry.meta.archivedAt && !entry.meta.trashedAt);
  const trashed = entries.filter((entry) => entry.meta.trashedAt);
  const visible = homeTab === "archive" ? archived : homeTab === "trash" ? trashed : active;
  const visibleIds = new Set(visible.map((entry) => entry.meta.id));
  for (const id of [...selectedProjects]) {
    if (!visibleIds.has(id)) selectedProjects.delete(id);
  }
  const selectedCount = selectedProjects.size;
  const primaryBulk =
    homeTab === "trash"
      ? { action: "restore", label: "Restore selected" }
      : homeTab === "archive"
        ? { action: "archive", label: "Unarchive selected" }
        : { action: "archive", label: "Archive selected" };
  const secondaryBulk =
    homeTab === "trash"
      ? { action: "delete", label: "Delete permanently" }
      : { action: "trash", label: "Move to trash" };
  const nestedCount = state.boards.length - rootMetas.length;
  const titles = { projects: "Projects", archive: "Archive", trash: "Trash" };

  page.innerHTML = `
    <div class="mn-home-inner">
      <header class="mn-home-head">
        <div class="mn-home-brand">
          <span class="mn-home-mark">N</span>
          <div>
            <h1 class="mn-home-title">Khaoyu Note</h1>
            <p class="mn-home-sub">Your projects, stored locally in SQLite. No account, no cloud.</p>
          </div>
        </div>
        <div class="mn-home-actions">
          <button type="button" class="mn-btn mn-btn-quiet" id="home-welcome">Welcome board</button>
          <button type="button" class="mn-btn mn-btn-quiet" id="home-close">Back to board</button>
        </div>
      </header>

      <section class="mn-home-new">
        <label class="mn-settings-label" for="home-new-name">New project</label>
        <div class="mn-home-new-row">
          <input class="ky-input" id="home-new-name" placeholder="Project name" />
          <button type="button" class="mn-btn mn-btn-primary" id="home-create">${icon("plus", 13)} Create</button>
        </div>
      </section>

      <div class="mn-home-tabs" role="tablist">
        ${[
          ["projects", "Projects", active.length],
          ["archive", "Archive", archived.length],
          ["trash", "Trash", trashed.length],
        ]
          .map(
            ([key, label, count]) =>
              `<button type="button" class="mn-home-tab${homeTab === key ? " is-active" : ""}" data-tab="${key}" role="tab">${label}<span>${count}</span></button>`
          )
          .join("")}
      </div>

      <section class="mn-home-recent">
        <div class="mn-home-recent-head">
          <h2 class="mn-home-h2">${titles[homeTab]}</h2>
          <span class="mn-home-count">${visible.length} project${visible.length === 1 ? "" : "s"}${
    homeTab === "projects" && nestedCount
      ? `, ${nestedCount} nested board${nestedCount === 1 ? "" : "s"} inside`
      : ""
  }</span>
          ${
            homeTab === "trash" && visible.length
              ? `<button type="button" class="mn-btn mn-btn-quiet mn-home-delete-all" id="home-delete-all">Delete all</button>`
              : ""
          }
        </div>
        ${
          selectedCount
            ? `<div class="mn-home-bulk">
          <strong>${selectedCount} selected</strong>
          <button type="button" class="mn-btn mn-btn-quiet" data-bulk="select-all">Select all</button>
          <button type="button" class="mn-btn mn-btn-quiet" data-bulk="${primaryBulk.action}">${primaryBulk.label}</button>
          <button type="button" class="mn-btn mn-btn-quiet" data-bulk="${secondaryBulk.action}">${secondaryBulk.label}</button>
          <button type="button" class="mn-btn mn-btn-quiet" data-bulk="clear">Clear</button>
        </div>`
            : ""
        }
        <div class="mn-home-grid" id="home-grid"></div>
      </section>
    </div>`;

  page.querySelectorAll(".mn-home-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      selectedProjects.clear();
      homeTab = tab.dataset.tab;
      renderHome();
    });
  });

  const grid = page.querySelector("#home-grid");
  const emptyText = {
    projects: "No projects yet. Create one above, or drop in the welcome board.",
    archive: "No archived projects.",
    trash: "Trash is empty.",
  };
  grid.innerHTML = visible.length ? "" : `<div class="mn-home-empty">${emptyText[homeTab]}</div>`;

  for (const entry of visible) {
    const { meta } = entry;
    const card = document.createElement("button");
    card.type = "button";
    card.className = "mn-project-card";
    card.dataset.id = meta.id;
    if (selectedProjects.has(meta.id)) card.classList.add("is-multi-selected");
    card.innerHTML = `
      <input type="checkbox" class="mn-check mn-project-check" data-role="select" ${
        selectedProjects.has(meta.id) ? "checked" : ""
      } title="Select project" aria-label="Select project" />
      <span class="mn-project-preview" data-role="preview"></span>
      <span class="mn-project-meta">
        <span class="mn-project-title">${escapeText(meta.title || "Untitled")}</span>
        <span class="mn-project-time">${relativeTime(meta.updatedAt)}</span>
      </span>
      <span class="mn-project-actions">
        ${
          homeTab === "trash"
            ? `<button type="button" class="mn-project-delete" data-role="restore" title="Restore project">${icon(
                "undo",
                13
              )}</button>`
            : `<button type="button" class="mn-project-delete" data-role="archive" title="${
                homeTab === "archive" ? "Unarchive project" : "Archive project"
              }">${icon("archive", 13)}</button>`
        }
        <button type="button" class="mn-project-delete" data-role="delete" title="${
          homeTab === "trash" ? "Delete permanently" : "Move to trash"
        }">${icon("trash", 13)}</button>
      </span>`;
    card.addEventListener("click", async (event) => {
      if (event.target.closest("[data-role='select']")) {
        event.preventDefault();
        event.stopPropagation();
        toggleProjectSelection(meta.id);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        toggleProjectSelection(meta.id);
        return;
      }
      if (event.target.closest("[data-role='delete']")) {
        event.preventDefault();
        event.stopPropagation();
        if (homeTab === "trash") {
          await removeBoard(meta.id, { openNext: false });
          await renderHome();
        } else {
          await trashProject(meta.id, true);
        }
        return;
      }
      if (event.target.closest("[data-role='restore']")) {
        event.preventDefault();
        event.stopPropagation();
        await trashProject(meta.id, false);
        return;
      }
      if (event.target.closest("[data-role='archive']")) {
        event.preventDefault();
        event.stopPropagation();
        await archiveProject(meta.id, homeTab !== "archive");
        return;
      }
      hideHome();
      await openBoard(meta.id);
    });
    card.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openProjectMenu(event, entry);
    });
    grid.append(card);
    fillPreview(card.querySelector('[data-role="preview"]'), meta, undefined, token);
  }

  page.querySelector("#home-create").addEventListener("click", async () => {
    const input = page.querySelector("#home-new-name");
    const name = (input.value || "").trim() || "Untitled board";
    hideHome();
    await createBoard(name);
    await refreshBoards();
  });
  page.querySelector("#home-delete-all")?.addEventListener("click", deleteAllTrash);
  page.querySelector('[data-bulk="select-all"]')?.addEventListener("click", () => {
    for (const entry of visible) selectedProjects.add(entry.meta.id);
    renderHome();
  });
  page.querySelector('[data-bulk="clear"]')?.addEventListener("click", () => {
    selectedProjects.clear();
    renderHome();
  });
  page.querySelector('[data-bulk="archive"]')?.addEventListener("click", () => {
    bulkArchive(homeTab !== "archive");
  });
  page.querySelector('[data-bulk="trash"]')?.addEventListener("click", () => bulkTrash(true));
  page.querySelector('[data-bulk="restore"]')?.addEventListener("click", () => bulkTrash(false));
  page.querySelector('[data-bulk="delete"]')?.addEventListener("click", bulkDelete);
  page.querySelector("#home-welcome").addEventListener("click", async () => {
    hideHome();
    await createBoard("Home", { withWelcome: true });
    await refreshBoards();
  });
  page.querySelector("#home-close").addEventListener("click", backToBoard);
}

function openProjectMenu(event, entry) {
  const { meta } = entry;
  const trashed = Boolean(meta.trashedAt);
  const archived = Boolean(meta.archivedAt);
  const items = [
    { type: "label", text: meta.title || "Untitled" },
    { text: "Open", kbd: "Enter", onClick: async () => { hideHome(); await openBoard(meta.id); } },
    { text: "Rename", onClick: () => renameProject(meta) },
    { type: "sep" },
  ];
  if (trashed) {
    items.push({ text: "Restore", onClick: () => trashProject(meta.id, false) });
    items.push({
      text: "Delete forever",
      danger: true,
      onClick: () => removeBoard(meta.id, { openNext: false }).then(renderHome),
    });
  } else {
    items.push({
      text: archived ? "Unarchive" : "Archive",
      onClick: () => archiveProject(meta.id, !archived),
    });
    items.push({
      text: "Move to trash",
      danger: true,
      onClick: () => trashProject(meta.id, true),
    });
  }
  window.dispatchEvent(
    new CustomEvent("mn:open-menu", { detail: { x: event.clientX, y: event.clientY, items } })
  );
}

async function fillPreview(container, meta, doc, token) {
  if (!container) return;
  if (!doc) {
    const cached = previewCache.get(meta.id);
    doc = cached && cached.updatedAt === meta.updatedAt ? cached.doc : await loadDoc(meta.id);
    if (doc) previewCache.set(meta.id, { updatedAt: meta.updatedAt, doc });
  }
  if (token !== renderToken) return;
  paintBoardPreview(container, doc);
}

function escapeText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
