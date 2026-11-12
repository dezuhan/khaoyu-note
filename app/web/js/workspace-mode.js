// Workspace and public-share views hosted by the main web UI. The service frontend only handles
// accounts/admin; board data and share viewing belong here.

const SERVERS_KEY = "mn.servers";
let overlay = null;

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

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement("section");
  overlay.className = "mn-server-view";
  overlay.innerHTML = `
    <header class="mn-server-bar">
      <button type="button" class="mn-btn" data-role="back">Back</button>
      <strong data-role="title">Workspace</strong>
      <span class="mn-server-bar-spacer"></span>
      <button type="button" class="mn-btn" data-role="refresh">Refresh</button>
    </header>
    <div class="mn-server-layout">
      <aside class="mn-server-sidebar" data-role="sidebar"></aside>
      <main class="mn-server-content" data-role="content"></main>
    </div>`;
  document.body.append(overlay);
  overlay.querySelector('[data-role="back"]').addEventListener("click", closeServerView);
  overlay.querySelector('[data-role="refresh"]').addEventListener("click", () => {
    if (overlay?.dataset.mode === "workspace") void renderWorkspace();
  });
  return overlay;
}

function closeServerView() {
  overlay?.remove();
  overlay = null;
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
  return `<article class="mn-server-board-card" data-card="${escapeText(card.id)}" style="left:${Number(card.x) || 0}px;top:${Number(card.y) || 0}px;width:${Math.max(
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

async function openBoard(server, project, token = "") {
  const view = ensureOverlay();
  view.dataset.mode = "board";
  view.querySelector('[data-role="title"]').textContent = project.name || project.title || "Board";
  view.querySelector('[data-role="sidebar"]').innerHTML = "";
  const content = view.querySelector('[data-role="content"]');
  content.innerHTML = `<p class="mn-server-empty">Loading board...</p>`;
  try {
    const data = await jsonFetch(`${server.url}/api/v1/projects/${encodeURIComponent(project.id)}`, {}, token);
    const snapshot = data.snapshot || {};
    let doc = {};
    try {
      doc = JSON.parse(snapshot.doc || "{}");
    } catch {
      doc = {};
    }
    renderBoard(content, doc);
    content.insertAdjacentHTML("afterbegin", `<p class="mn-server-note">Read-only shared view · ${escapeText(project.role || "viewer")}</p>`);
  } catch (error) {
    content.innerHTML = `<p class="mn-server-empty">${escapeText(error.message)}</p>`;
  }
}

async function renderWorkspace() {
  const view = ensureOverlay();
  view.dataset.mode = "workspace";
  view.querySelector('[data-role="title"]').textContent = "Workspace";
  view.querySelector('[data-role="content"]').innerHTML = "";
  const sidebar = view.querySelector('[data-role="sidebar"]');
  const content = view.querySelector('[data-role="content"]');
  const current = servers();
  sidebar.innerHTML = `
    <h2>Servers</h2>
    <div data-role="server-list"></div>
    <button type="button" class="mn-btn mn-server-add" data-role="add-server">+ Add Server</button>
    <p class="mn-server-note">Local boards stay in this browser. Add a Khaoyu service URL to open its shared team workspace.</p>`;
  const list = sidebar.querySelector('[data-role="server-list"]');
  if (!current.length) {
    list.innerHTML = `<p class="mn-server-note">No remote server connected.</p>`;
  }
  for (const server of current) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mn-server-item";
    button.textContent = server.name || server.url;
    button.addEventListener("click", () => void loadServerProjects(server));
    list.append(button);
  }
  sidebar.querySelector('[data-role="add-server"]').addEventListener("click", addServer);
  if (current[0]) void loadServerProjects(current[0]);
  else {
    content.innerHTML = `<div class="mn-server-empty"><h2>Team workspace</h2><p>Connect a server to see boards shared with your account.</p></div>`;
  }
}

async function loadServerProjects(server) {
  const view = ensureOverlay();
  const content = view.querySelector('[data-role="content"]');
  content.innerHTML = `<p class="mn-server-empty">Loading ${escapeText(server.name || server.url)}...</p>`;
  try {
    const data = await jsonFetch(`${server.url}/api/v1/projects`, {}, server.token);
    const projects = data.projects || [];
    content.innerHTML = `<h2>${escapeText(server.name || new URL(server.url).host)}</h2><div class="mn-server-board-list">${
      projects.length
        ? projects
            .map(
              (project) =>
                `<button type="button" class="mn-server-board-link" data-project="${escapeText(project.id)}"><strong>${escapeText(
                  project.name || "Untitled board"
                )}</strong><span>${escapeText(project.role || "viewer")} · revision ${escapeText(project.revision ?? 1)}</span></button>`
            )
            .join("")
        : `<p class="mn-server-empty">No boards are shared with this account.</p>`
    }</div>`;
    for (const button of content.querySelectorAll("[data-project]")) {
      const project = projects.find((entry) => entry.id === button.dataset.project);
      button.addEventListener("click", () => void openBoard(server, project, server.token));
    }
  } catch (error) {
    content.innerHTML = `<p class="mn-server-empty">${escapeText(error.message)} <button type="button" class="mn-btn" data-role="retry">Retry</button></p>`;
    content.querySelector('[data-role="retry"]')?.addEventListener("click", () => void loadServerProjects(server));
  }
}

async function addServer() {
  const url = normalizeUrl(window.prompt("Khaoyu service URL", "https://admin.example.com") || "");
  if (!url) return;
  const email = window.prompt("Account email") || "";
  if (!email) return;
  const password = window.prompt("Account password") || "";
  if (!password) return;
  try {
    const data = await jsonFetch(`${url}/api/v1/auth/sync-token`, {
      method: "POST",
      body: { email, password },
    });
    if (!data.token) throw new Error("The server did not return a sync token.");
    const entries = servers().filter((entry) => entry.url !== url);
    entries.unshift({ url, name: new URL(url).host, email, token: data.token });
    saveServers(entries);
    await renderWorkspace();
  } catch (error) {
    window.alert(`Could not connect: ${error.message}`);
  }
}

export function initWorkspaceLauncher(uiRefs) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mn-btn mn-workspace-launcher";
  button.textContent = "Workspace";
  button.title = "Workspace and servers";
  button.addEventListener("click", () => void renderWorkspace());
  const left = document.querySelector(".mn-menubar-left");
  if (left) left.append(button);
  return button;
}

export async function openWorkspaceFromQuery() {
  if (new URLSearchParams(location.search).get("workspace") === "1") {
    await renderWorkspace();
    return true;
  }
  return false;
}

export async function openShareFromQuery() {
  const params = new URLSearchParams(location.search);
  const token = params.get("share");
  if (!token) return false;
  const server = normalizeUrl(params.get("server") || "");
  if (!server) {
    ensureOverlay().querySelector('[data-role="content"]').innerHTML =
      `<p class="mn-server-empty">This share link is missing its server URL.</p>`;
    return true;
  }
  const view = ensureOverlay();
  view.dataset.mode = "share";
  view.querySelector('[data-role="sidebar"]').innerHTML = "";
  view.querySelector('[data-role="title"]').textContent = "Shared board";
  const content = view.querySelector('[data-role="content"]');
  content.innerHTML = `<p class="mn-server-empty">Opening shared board...</p>`;
  try {
    const data = await jsonFetch(`${server}/api/v1/share/${encodeURIComponent(token)}/access`, {
      method: "POST",
      body: {},
    });
    const snapshot = data.doc || {};
    renderBoard(content, snapshot);
    content.insertAdjacentHTML("afterbegin", `<p class="mn-server-note">Shared read-only view · do not forward this link to people who should not have access.</p>`);
  } catch (error) {
    content.innerHTML = `<p class="mn-server-empty">${escapeText(error.message || "This share link is invalid or expired.")}</p>`;
  }
  return true;
}
