// The main board frontend owns server/workspace switching and public share viewing. The service
// frontend only owns accounts and administration.

import { icon } from "./icons.js";

const SERVERS_KEY = "ky.servers";
const WORKSPACE_CACHE_KEY = "ky.workspaceCache";
let popover = null;
let boardOverlay = null;
let activeServer = null;

function escapeText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalizeUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

function servers() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SERVERS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((entry) => entry?.url && entry?.token) : [];
  } catch {
    return [];
  }
}

function saveServers(entries) {
  localStorage.setItem(SERVERS_KEY, JSON.stringify(entries.slice(0, 20)));
}

async function jsonFetch(url, options = {}, token = "") {
  const headers = { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = body.code;
    throw error;
  }
  return body;
}

function closePopover() {
  popover?.remove();
  popover = null;
  activeServer = null;
}

function ensurePopover(anchor) {
  closePopover();
  popover = document.createElement("section");
  popover.className = "mn-workspace-popover";
  popover.setAttribute("role", "menu");
  popover.setAttribute("aria-label", "Workspace");
  const rect = anchor?.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - 368, rect ? rect.left : 12));
  const top = Math.min(window.innerHeight - 80, (rect ? rect.bottom : 40) + 6);
  popover.style.left = `${left}px`;
  popover.style.top = `${Math.max(8, top)}px`;
  document.body.append(popover);
  popover.addEventListener("click", (event) => {
    if (event.target === popover) return;
  });
  const onKey = (event) => {
    if (event.key === "Escape") {
      closePopover();
      document.removeEventListener("keydown", onKey, true);
    }
  };
  document.addEventListener("keydown", onKey, true);
  setTimeout(() => {
    const outside = (event) => {
      if (!popover || popover.contains(event.target) || anchor?.contains(event.target)) return;
      closePopover();
      document.removeEventListener("pointerdown", outside, true);
    };
    document.addEventListener("pointerdown", outside, true);
  }, 0);
  return popover;
}

function readWorkspaceCache(serverUrl) {
  try {
    return JSON.parse(localStorage.getItem(WORKSPACE_CACHE_KEY) || "{}")[serverUrl] || null;
  } catch {
    return null;
  }
}

function writeWorkspaceCache(serverUrl, workspaces) {
  try {
    const all = JSON.parse(localStorage.getItem(WORKSPACE_CACHE_KEY) || "{}");
    all[serverUrl] = workspaces;
    localStorage.setItem(WORKSPACE_CACHE_KEY, JSON.stringify(all));
  } catch {
    /* cache is optional */
  }
}

function withTimeout(promise, ms = 6000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Server did not respond. Check the URL and tunnel.")), ms)),
  ]);
}

async function renderLocalWorkspaces(view) {
  const target = view.querySelector('[data-role="local-workspaces"]');
  if (!target) return;
  try {
    const bridge = await import("./bridge.js");
    const boards = (await bridge.listBoards())
      .filter((board) => !board.parentId && !board.archivedAt && !board.trashedAt)
      .slice(0, 8);
    target.innerHTML = boards.length
      ? boards
          .map(
            (board) =>
              `<button type="button" class="mn-workspace-popover-board" data-local-board="${escapeText(
                board.id
              )}"><strong>${escapeText(board.title || "Untitled")}</strong><span>local board</span></button>`
          )
          .join("")
      : `<p class="mn-server-note" style="padding:8px">No local workspaces yet.</p>`;
    for (const button of target.querySelectorAll("[data-local-board]")) {
      button.addEventListener("click", async () => {
        const store = await import("./store.js");
        await store.openBoard(button.dataset.localBoard, { flush: false });
        closePopover();
      });
    }
  } catch {
    target.innerHTML = `<p class="mn-server-note" style="padding:8px">Could not load local workspaces.</p>`;
  }
}

function serverTitle(server) {
  return `<div class="mn-workspace-server-title">${icon("globe", 14)}<span><strong>${escapeText(
    server.name || new URL(server.url).host
  )}</strong><small>${escapeText(server.email || new URL(server.url).host)}</small></span><button type="button" class="mn-icon-btn mn-workspace-server-menu-btn" data-server-menu="1" aria-label="Server options" title="Server options">${icon("more", 16)}</button></div><div class="mn-workspace-popover-sep"></div>`;
}

function closeServerMenu() {
  popover?.querySelector(".mn-workspace-server-menu")?.remove();
}

function removeServer(server) {
  const next = servers().filter((entry) => entry.url !== server.url);
  saveServers(next);
  try {
    const cache = JSON.parse(localStorage.getItem(WORKSPACE_CACHE_KEY) || "{}");
    delete cache[server.url];
    localStorage.setItem(WORKSPACE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* cache is optional */
  }
  closePopover();
  window.dispatchEvent(new CustomEvent("mn:toast", { detail: { message: "Server removed" } }));
  void openWorkspacePopover(document.getElementById("template-btn"));
}

function openServerMenu(server, section, button) {
  closeServerMenu();
  const menu = document.createElement("div");
  menu.className = "mn-workspace-server-menu";
  menu.setAttribute("role", "menu");
  menu.innerHTML = `<button type="button" class="mn-workspace-server-menu-item is-danger" role="menuitem" data-remove-server="1">${icon("trash", 14)} Remove server</button>`;
  button.parentElement.append(menu);
  const close = () => {
    closeServerMenu();
    document.removeEventListener("pointerdown", outside, true);
  };
  const outside = (event) => {
    if (!menu.contains(event.target) && event.target !== button && !button.contains(event.target)) close();
  };
  document.addEventListener("pointerdown", outside, true);
  menu.querySelector("[data-remove-server]").addEventListener("click", () => {
    close();
    removeServer(server);
  });
}

export async function openWorkspacePopover(anchor) {
  const view = ensurePopover(anchor);
  const current = servers();
  view.innerHTML = `
    <div class="mn-workspace-popover-head"><span>Workspace</span><span>${escapeText(location.host)}</span></div>
    <button type="button" class="mn-workspace-popover-row is-active" data-local="1">${icon("database", 16)}<span><strong>Local storage</strong><small>This browser’s boards</small></span></button>
    <div class="mn-workspace-popover-boards" data-role="local-workspaces"><p class="mn-server-note" style="padding:8px">Loading local workspaces...</p></div>
    <div class="mn-workspace-popover-sep"></div>
    <div data-role="server-sections"></div>
    <button type="button" class="mn-workspace-popover-row" data-add-server="1">${icon("plus", 16)}<span><strong>Add Server</strong><small>Connect a Khaoyu service</small></span></button>
    <div class="mn-workspace-popover-sep"></div>
    <button type="button" class="mn-workspace-popover-row is-muted" data-role="import-workspace">${icon("download", 16)}<span><strong>Import workspace</strong><small>Coming soon</small></span></button>
    <button type="button" class="mn-workspace-popover-row" data-role="create-workspace">${icon("plus", 16)}<span><strong>Create workspace</strong><small>On the connected server</small></span></button>`;
  view.querySelector('[data-local]').addEventListener("click", closePopover);
  view.querySelector('[data-add-server]').addEventListener("click", () => openAddServerDialog(anchor));
  view.querySelector('[data-role="import-workspace"]').addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("mn:toast", { detail: { message: "Workspace import is coming soon" } }));
  });
  view.querySelector('[data-role="create-workspace"]').addEventListener("click", () => {
    openCreateWorkspaceDialog(current, anchor);
  });
  void renderLocalWorkspaces(view);
  const sections = view.querySelector('[data-role="server-sections"]');
  if (!current.length) {
    sections.innerHTML = `<p class="mn-server-note" style="padding:8px">No remote server connected.</p>`;
    return;
  }
  for (const server of current) {
    const section = document.createElement("section");
    section.className = "mn-workspace-server-section";
    section.innerHTML = `${serverTitle(server)}<div data-role="workspaces"><p class="mn-server-note" style="padding:8px">Loading workspaces...</p></div>`;
    sections.append(section);
    section.querySelector("[data-server-menu]").addEventListener("click", (event) => {
      event.stopPropagation();
      openServerMenu(server, section, event.currentTarget);
    });
    void loadServerWorkspaces(server, section, view);
  }
}

async function loadServerWorkspaces(server, section, view) {
  const target = section.querySelector('[data-role="workspaces"]');
  const cached = readWorkspaceCache(server.url);
  if (cached?.length) renderWorkspaceRows(server, cached, target, view);
  try {
    const data = await withTimeout(jsonFetch(`${server.url}/api/v1/workspaces`, {}, server.token));
    const workspaces = data.workspaces || [];
    writeWorkspaceCache(server.url, workspaces);
    renderWorkspaceRows(server, workspaces, target, view);
  } catch (error) {
    if (!cached?.length) {
      target.innerHTML = `<p class="mn-workspace-form-error" style="padding:8px">${escapeText(error.message)} <button type="button" class="mn-btn" data-role="retry">Retry</button></p>`;
      target.querySelector('[data-role="retry"]')?.addEventListener("click", () => void loadServerWorkspaces(server, section, view));
    }
  }
}

function renderWorkspaceRows(server, workspaces, target, view) {
  if (!workspaces.length) {
    target.innerHTML = `<p class="mn-server-note" style="padding:8px">No workspace is shared with this account.</p>`;
    return;
  }
  target.innerHTML = `<div class="mn-workspace-popover-boards">${workspaces
    .map(
      (workspace) =>
        `<button type="button" class="mn-workspace-popover-board" data-workspace="${escapeText(
          workspace.id
        )}"><strong>${escapeText(workspace.name || "Workspace")}</strong><span>${escapeText(
          workspace.role || "member"
        )} · default ${escapeText(workspace.memberDefaultBoardRole || "viewer")}</span></button>`
    )
    .join("")}</div><div data-role="workspace-detail"></div>`;
  for (const button of target.querySelectorAll("[data-workspace]")) {
    const workspace = workspaces.find((entry) => entry.id === button.dataset.workspace);
    button.addEventListener("click", () => {
      target.querySelectorAll("[data-workspace]").forEach((entry) => entry.classList.toggle("is-active", entry === button));
      void loadWorkspaceBoards(server, workspace, target, view);
    });
  }
}

async function loadWorkspaceBoards(server, workspace, root, view) {
  const target = root.querySelector('[data-role="workspace-detail"]');
  if (!target) return;
  target.innerHTML = `<p class="mn-server-note" style="padding:8px">Loading boards...</p>`;
  try {
    const data = await withTimeout(
      jsonFetch(`${server.url}/api/v1/workspaces/${encodeURIComponent(workspace.id)}/boards`, {}, server.token)
    );
    const projects = data.projects || [];
    target.innerHTML = `<div class="mn-workspace-popover-actions"><button type="button" class="mn-btn" data-role="workspace-members">Members</button><button type="button" class="mn-btn" data-role="workspace-invite">Invite</button></div><div class="mn-workspace-popover-boards">${
      projects.length
        ? projects
            .map(
              (project) =>
                `<button type="button" class="mn-workspace-popover-board" data-project="${escapeText(
                  project.id
                )}"><strong>${escapeText(project.name || "Untitled board")}</strong><span>${escapeText(
                  project.role || "viewer"
                )} · revision ${escapeText(project.revision ?? 1)}</span></button>`
            )
            .join("")
        : `<p class="mn-server-note" style="padding:8px">No boards in this workspace.</p>`
    }</div>`;
    target.querySelector('[data-role="workspace-members"]')?.addEventListener("click", () => void openWorkspaceMembers(server, workspace));
    target.querySelector('[data-role="workspace-invite"]')?.addEventListener("click", () => void openWorkspaceInvite(server, workspace, root));
    for (const button of target.querySelectorAll("[data-project]")) {
      const project = projects.find((entry) => entry.id === button.dataset.project);
      button.addEventListener("click", () => {
        if (["owner", "editor"].includes(String(project.role || ""))) void openEditableBoard(server, project, server.token);
        else {
          closePopover();
          void openBoard(server, project, server.token);
        }
      });
    }
  } catch (error) {
    target.innerHTML = `<p class="mn-workspace-form-error" style="padding:8px">${escapeText(error.message)}</p>`;
  }
}

function openCreateWorkspaceDialog(serversList, anchor) {
  closePopover();
  const serverOptions = (serversList || [])
    .map(
      (server) =>
        `<option value="${escapeText(server.url)}">${escapeText(server.name || new URL(server.url).host)}</option>`
    )
    .join("");
  const overlay = document.createElement("div");
  overlay.className = "mn-overlay";
  overlay.innerHTML = `<form class="mn-modal mn-workspace-form" role="dialog" aria-modal="true" aria-label="Name your workspace">
    <header class="mn-modal-head"><h2 class="mn-modal-title">Name your workspace</h2><button type="button" class="mn-icon-btn mn-modal-close" aria-label="Close">×</button></header>
    <div class="mn-modal-body mn-workspace-form">
      <p class="mn-workspace-form-note">A workspace is your virtual space to capture, create and plan as just one person or together as a team.</p>
      <label>Workspace name<input class="ky-input" name="name" placeholder="Set a workspace name" autocomplete="off" required /></label>
      <label>Workspace type<select class="ky-input" name="type"><option value="local">Local storage</option>${serverOptions}</select></label>
      <p class="mn-workspace-form-error" data-role="error" role="status"></p>
    </div>
    <footer class="mn-modal-foot"><button type="button" class="mn-btn" data-role="cancel">Cancel</button><button type="submit" class="mn-btn mn-btn-primary">Create</button></footer></form>`;
  document.body.append(overlay);
  const form = overlay.querySelector("form");
  const error = form.querySelector('[data-role="error"]');
  const close = () => overlay.remove();
  form.querySelector(".mn-modal-close").addEventListener("click", close);
  form.querySelector('[data-role="cancel"]').addEventListener("click", close);
  overlay.addEventListener("pointerdown", (event) => { if (event.target === overlay) close(); });
  form.querySelector('[name="type"]').addEventListener("change", () => { error.textContent = ""; });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = form.elements.namedItem("name").value.trim();
    if (!name) { error.textContent = "Enter a workspace name."; return; }
    const type = form.elements.namedItem("type").value;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      if (type === "local") {
        const store = await import("./store.js");
        await store.createBoard(name);
        close();
        await openWorkspacePopover(document.getElementById("template-btn"));
        window.dispatchEvent(new CustomEvent("mn:toast", { detail: { message: "Local workspace created" } }));
        return;
      }
      const server = serversList.find((entry) => entry.url === type);
      if (!server) throw new Error("The selected server is no longer connected.");
      await withTimeout(
        jsonFetch(`${server.url}/api/v1/workspaces`, { method: "POST", body: { name } }, server.token)
      );
      close();
      await openWorkspacePopover(anchor);
      window.dispatchEvent(new CustomEvent("mn:toast", { detail: { message: "Workspace created" } }));
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
    }
  });
}

function openAddServerDialog(anchor) {
  closePopover();
  const overlay = document.createElement("div");
  overlay.className = "mn-overlay";
  overlay.innerHTML = `<form class="mn-modal mn-workspace-form" role="dialog" aria-modal="true" aria-label="Add server">
    <header class="mn-modal-head"><h2 class="mn-modal-title">Add Server</h2><button type="button" class="mn-icon-btn mn-modal-close" aria-label="Close">×</button></header>
    <div class="mn-modal-body mn-workspace-form">
      <label>Server URL<input class="ky-input" name="url" placeholder="https://admin.example.com" autocomplete="url" required /></label>
      <label>Account email<input class="ky-input" name="email" type="email" autocomplete="email" required /></label>
      <label>Password<input class="ky-input" name="password" type="password" autocomplete="current-password" required /></label>
      <p class="mn-workspace-form-error" data-role="error" role="status"></p>
    </div>
    <footer class="mn-modal-foot"><button type="button" class="mn-btn" data-role="cancel">Cancel</button><button type="submit" class="mn-btn mn-btn-primary">Connect server</button></footer>
  </form>`;
  document.body.append(overlay);
  const form = overlay.querySelector("form");
  const errorEl = form.querySelector('[data-role="error"]');
  const close = () => overlay.remove();
  form.querySelector(".mn-modal-close").addEventListener("click", close);
  form.querySelector('[data-role="cancel"]').addEventListener("click", close);
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) close();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = normalizeUrl(form.url.value);
    if (!url) {
      errorEl.textContent = "Enter a valid server URL.";
      return;
    }
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    errorEl.textContent = "Connecting...";
    try {
      const data = await jsonFetch(`${url}/api/v1/auth/sync-token`, {
        method: "POST",
        body: { email: form.email.value.trim(), password: form.password.value },
      });
      if (!data.token) throw new Error("The server did not return a sync token.");
      const entries = servers().filter((entry) => entry.url !== url);
      entries.unshift({ url, name: new URL(url).host, email: form.email.value.trim(), token: data.token });
      saveServers(entries);
      close();
      await openWorkspacePopover(anchor);
    } catch (error) {
      errorEl.textContent = error.message || "Could not connect the server.";
      submit.disabled = false;
    }
  });
}

function ensureBoardOverlay() {
  if (boardOverlay) return boardOverlay;
  boardOverlay = document.createElement("section");
  boardOverlay.className = "mn-server-view";
  boardOverlay.innerHTML = `<header class="mn-server-bar"><button type="button" class="mn-btn" data-role="back">Back</button><strong data-role="title">Board</strong><span class="mn-server-bar-spacer"></span></header><main class="mn-server-content" data-role="content"></main>`;
  document.body.append(boardOverlay);
  boardOverlay.querySelector('[data-role="back"]').addEventListener("click", () => {
    boardOverlay.remove();
    boardOverlay = null;
  });
  return boardOverlay;
}

function boardCard(card) {
  const type = String(card.type || "card");
  let body = "";
  if (type === "heading") body = `<h3>${escapeText(card.text || "Heading")}</h3>`;
  else if (Array.isArray(card.items)) {
    body = `${card.title ? `<h3>${escapeText(card.title)}</h3>` : ""}${card.items
      .map((item) => `<p>${item?.checked || item?.done ? "☑" : "☐"} ${escapeText(item?.text || item || "")}</p>`)
      .join("")}`;
  } else if (Array.isArray(card.cells)) {
    body = card.cells.map((row) => `<p>${(row || []).map((cell) => escapeText(cell)).join(" · ")}</p>`).join("");
  } else {
    body = `${card.title && !["note", "document"].includes(type) ? `<h3>${escapeText(card.title)}</h3>` : ""}<p>${escapeText(
      card.text || card.description || card.caption || card.url || type
    )}</p>`;
  }
  return `<article class="mn-server-board-card" style="left:${Number(card.x) || 0}px;top:${Number(card.y) || 0}px;width:${Math.max(
    80,
    Number(card.w) || 220
  )}px;height:${Math.max(40, Number(card.h) || 90)}px;z-index:${Number(card.z) || 1}">${body}</article>`;
}

function renderBoard(container, doc) {
  const cards = [...(doc?.cards || [])].sort((a, b) => Number(a.z || 0) - Number(b.z || 0));
  if (!cards.length) {
    container.innerHTML = `<p class="mn-server-empty">This board is empty.</p>`;
    return;
  }
  const minX = Math.min(...cards.map((card) => Number(card.x) || 0));
  const minY = Math.min(...cards.map((card) => Number(card.y) || 0));
  const maxX = Math.max(...cards.map((card) => (Number(card.x) || 0) + (Number(card.w) || 220)));
  const maxY = Math.max(...cards.map((card) => (Number(card.y) || 0) + (Number(card.h) || 90)));
  container.innerHTML = `<div class="mn-server-board" style="width:${Math.max(
    620,
    maxX - minX + 64
  )}px;height:${Math.max(420, maxY - minY + 64)}px">${cards
    .map((card) => boardCard({ ...card, x: (Number(card.x) || 0) - minX + 32, y: (Number(card.y) || 0) - minY + 32 }))
    .join("")}</div>`;
}

async function openEditableBoard(server, project, token) {
  closePopover();
  const view = ensureBoardOverlay();
  view.querySelector('[data-role="title"]').textContent = project.name || "Board";
  const content = view.querySelector('[data-role="content"]');
  content.innerHTML = `<p class="mn-server-empty">Opening editable board...</p>`;
  try {
    const data = await jsonFetch(`${server.url}/api/v1/projects/${encodeURIComponent(project.id)}`, {}, token);
    const doc = JSON.parse(data.snapshot?.doc || "{}");
    doc.id = project.id;
    const [store, sync, syncUi] = await Promise.all([
      import("./store.js"),
      import("./sync.js"),
      import("./sync-ui.js"),
    ]);
    await store.openRemoteBoard(doc, {
      projectId: project.id,
      revision: Number(project.revision) || 1,
      lastSeq: Number(data.project?.lastSeq || project.lastSeq || 0),
      lastSyncedAt: Date.now(),
    });
    sync.saveSyncConfig({ url: server.url, email: server.email || "", token });
    await sync.pushLiveChanges(store.state.board);
    view.remove();
    boardOverlay = null;
    syncUi.refresh();
    window.dispatchEvent(new CustomEvent("mn:toast", { detail: { message: "Opened team board" } }));
  } catch (error) {
    content.innerHTML = `<p class="mn-server-empty">${escapeText(error.message)}</p>`;
  }
}

async function openBoard(server, project, token = "") {
  const view = ensureBoardOverlay();
  view.querySelector('[data-role="title"]').textContent = project.name || "Board";
  const content = view.querySelector('[data-role="content"]');
  content.innerHTML = `<p class="mn-server-empty">Loading board...</p>`;
  try {
    const data = await jsonFetch(`${server.url}/api/v1/projects/${encodeURIComponent(project.id)}`, {}, token);
    let doc = {};
    try {
      doc = JSON.parse(data.snapshot?.doc || "{}");
    } catch {
      doc = {};
    }
    renderBoard(content, doc);
    content.insertAdjacentHTML("afterbegin", `<p class="mn-server-note">Read-only shared view · ${escapeText(project.role || "viewer")}</p>`);
  } catch (error) {
    content.innerHTML = `<p class="mn-server-empty">${escapeText(error.message)}</p>`;
  }
}

export async function openWorkspaceFromQuery() {
  if (new URLSearchParams(location.search).get("workspace") !== "1") return false;
  openWorkspacePopover(document.getElementById("template-btn"));
  return true;
}

export async function openShareFromQuery() {
  const params = new URLSearchParams(location.search);
  const token = params.get("share");
  if (!token) return false;
  const server = normalizeUrl(params.get("server") || "");
  const view = ensureBoardOverlay();
  view.querySelector('[data-role="title"]').textContent = "Shared board";
  const content = view.querySelector('[data-role="content"]');
  if (!server) {
    content.innerHTML = `<p class="mn-server-empty">This share link is missing its server URL.</p>`;
    return true;
  }
  content.innerHTML = `<p class="mn-server-empty">Opening shared board...</p>`;
  try {
    const data = await jsonFetch(`${server}/api/v1/share/${encodeURIComponent(token)}/access`, {
      method: "POST",
      body: {},
    });
    renderBoard(content, data.doc || {});
    content.insertAdjacentHTML("afterbegin", `<p class="mn-server-note">Shared read-only view · do not forward this link to people who should not have access.</p>`);
  } catch (error) {
    content.innerHTML = `<p class="mn-server-empty">${escapeText(error.message || "This share link is invalid or expired.")}</p>`;
  }
  return true;
}
