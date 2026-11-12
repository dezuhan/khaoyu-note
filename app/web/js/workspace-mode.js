// The main board frontend owns server/workspace switching and public share viewing. The service
// frontend only owns accounts and administration.

const SERVERS_KEY = "mn.servers";
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

function serverRow(server, active) {
  return `<button type="button" class="mn-workspace-popover-row${active ? " is-active" : ""}" data-server="${escapeText(
    server.url
  )}"><span><strong>${escapeText(server.name || new URL(server.url).host)}</strong><small>${escapeText(
    server.email || new URL(server.url).host
  )}</small></span></button>`;
}

export async function openWorkspacePopover(anchor) {
  const view = ensurePopover(anchor);
  view.innerHTML = `
    <div class="mn-workspace-popover-head"><span>Workspace</span><span>${escapeText(location.host)}</span></div>
    <button type="button" class="mn-workspace-popover-row is-active" data-local="1"><span><strong>Local storage</strong><small>This browser’s boards</small></span></button>
    <div class="mn-workspace-popover-sep"></div>
    <div data-role="server-rows"></div>
    <div data-role="server-boards"></div>
    <button type="button" class="mn-workspace-popover-row" data-add-server="1"><span><strong>+ Add Server</strong><small>Connect a Khaoyu service</small></span></button>`;
  const rows = view.querySelector('[data-role="server-rows"]');
  const current = servers();
  rows.innerHTML = current.length
    ? current.map((server) => serverRow(server, activeServer?.url === server.url)).join("")
    : `<p class="mn-server-note" style="padding:8px">No remote server connected.</p>`;
  view.querySelector('[data-local]').addEventListener("click", closePopover);
  view.querySelector('[data-add-server]').addEventListener("click", () => openAddServerDialog(anchor));
  for (const button of rows.querySelectorAll("[data-server]")) {
    const server = current.find((entry) => entry.url === button.dataset.server);
    button.addEventListener("click", () => loadServerBoards(server, view));
  }
  if (current[0]) loadServerBoards(current[0], view);
}

async function loadServerBoards(server, view) {
  if (!server || !view) return;
  activeServer = server;
  const rows = view.querySelector('[data-role="server-rows"]');
  for (const button of rows.querySelectorAll("[data-server]")) {
    button.classList.toggle("is-active", button.dataset.server === server.url);
  }
  const target = view.querySelector('[data-role="server-boards"]');
  target.innerHTML = `<p class="mn-server-note" style="padding:8px">Loading ${escapeText(server.name)}...</p>`;
  try {
    const data = await jsonFetch(`${server.url}/api/v1/workspaces`, {}, server.token);
    const workspaces = data.workspaces || [];
    if (!workspaces.length) {
      target.innerHTML = `<p class="mn-server-note" style="padding:8px">No workspace is shared with this account.</p>`;
      return;
    }
    target.innerHTML = `<div class="mn-workspace-popover-head"><span>Workspaces</span></div><div data-role="workspace-rows">${workspaces
      .map(
        (workspace) =>
          `<button type="button" class="mn-workspace-popover-row" data-workspace="${escapeText(workspace.id)}"><span><strong>${escapeText(
            workspace.name || "Workspace"
          )}</strong><small>${escapeText(workspace.role || "member")} · default ${escapeText(
            workspace.memberDefaultBoardRole || "viewer"
          )}</small></span></button>`
      )
      .join("")}</div><div data-role="workspace-boards"></div>`;
    const workspaceRows = target.querySelector('[data-role="workspace-rows"]');
    for (const button of workspaceRows.querySelectorAll("[data-workspace]")) {
      const workspace = workspaces.find((entry) => entry.id === button.dataset.workspace);
      button.addEventListener("click", () => loadWorkspaceBoards(server, workspace, target));
    }
    await loadWorkspaceBoards(server, workspaces[0], target);
  } catch (error) {
    target.innerHTML = `<p class="mn-workspace-form-error" style="padding:8px">${escapeText(error.message)}</p>`;
  }
}

async function loadWorkspaceBoards(server, workspace, root) {
  if (!server || !workspace || !root) return;
  for (const button of root.querySelectorAll("[data-workspace]")) {
    button.classList.toggle("is-active", button.dataset.workspace === workspace.id);
  }
  const target = root.querySelector('[data-role="workspace-boards"]');
  target.innerHTML = `<p class="mn-server-note" style="padding:8px">Loading boards...</p>`;
  try {
    const data = await jsonFetch(
      `${server.url}/api/v1/workspaces/${encodeURIComponent(workspace.id)}/boards`,
      {},
      server.token
    );
    const projects = data.projects || [];
    target.innerHTML = projects.length
      ? `<div class="mn-workspace-popover-boards">${projects
          .map(
            (project) =>
              `<button type="button" class="mn-workspace-popover-board" data-project="${escapeText(project.id)}"><strong>${escapeText(
                project.name || "Untitled board"
              )}</strong><span>${escapeText(project.role || "viewer")} · revision ${escapeText(project.revision ?? 1)}</span></button>`
          )
          .join("")}</div>`
      : `<p class="mn-server-note" style="padding:8px">No boards in this workspace.</p>`;
    for (const button of target.querySelectorAll("[data-project]")) {
      const project = projects.find((entry) => entry.id === button.dataset.project);
      button.addEventListener("click", () => {
        if (["owner", "editor"].includes(String(project.role || ""))) {
          void openEditableBoard(server, project, server.token);
        } else {
          closePopover();
          void openBoard(server, project, server.token);
        }
      });
    }
  } catch (error) {
    target.innerHTML = `<p class="mn-workspace-form-error" style="padding:8px">${escapeText(error.message)}</p>`;
  }
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
