const $ = (selector) => document.querySelector(selector);
const SERVERS_KEY = "khaoyu.workspaceServers";

function hostLabel(value) {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function escapeText(value) {
  const element = document.createElement("span");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

async function api(pathname, options = {}) {
  const headers = { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) };
  const csrf = document.cookie.match(/(?:^|;\s*)khaoyu_csrf=([^;]+)/);
  if (csrf) headers["x-csrf-token"] = decodeURIComponent(csrf[1]);
  const response = await fetch(pathname, {
    ...options,
    headers,
    credentials: "same-origin",
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 401) {
    window.location.replace("/login");
    throw new Error("Sign in required");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function currentServer() {
  return { name: hostLabel(window.location.origin), url: window.location.origin, current: true };
}

function storedServers() {
  try {
    const value = JSON.parse(localStorage.getItem(SERVERS_KEY) || "[]");
    return Array.isArray(value) ? value.filter((entry) => entry && typeof entry.url === "string") : [];
  } catch {
    return [];
  }
}

function saveServers(servers) {
  localStorage.setItem(SERVERS_KEY, JSON.stringify(servers.slice(0, 12)));
}

function normalizeServerUrl(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  try {
    const url = new URL(withScheme);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

function renderServers() {
  const list = $("#workspace-servers");
  list.textContent = "";
  const current = currentServer();
  const items = [
    { name: "Local storage", url: "", local: true },
    current,
    ...storedServers().filter((entry) => entry.url !== current.url),
  ];
  for (const entry of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `workspace-server${entry.current ? " is-current" : ""}`;
    button.innerHTML = `<span><strong>${escapeText(entry.name)}</strong><small>${escapeText(
      entry.local ? "This browser’s local web host" : hostLabel(entry.url)
    )}</small></span>`;
    button.addEventListener("click", async () => {
      if (entry.current) return;
      if (entry.local) {
        const saved = localStorage.getItem("khaoyu.localAppUrl") || "http://127.0.0.1:1430";
        const input = window.prompt("Local web host URL", saved);
        if (!input) return;
        const url = normalizeServerUrl(input);
        if (!url) return;
        localStorage.setItem("khaoyu.localAppUrl", url);
        window.location.href = url;
        return;
      }
      window.location.href = `${entry.url}/workspace`;
    });
    list.append(button);
  }
}

async function addServer() {
  const input = window.prompt("Server URL", "https://note.example.com");
  if (!input) return;
  const url = normalizeServerUrl(input);
  if (!url) {
    window.alert("Enter a valid http:// or https:// server URL.");
    return;
  }
  const name = window.prompt("Server name", hostLabel(url)) || hostLabel(url);
  const servers = storedServers().filter((entry) => entry.url !== url);
  servers.unshift({ name: String(name).slice(0, 80), url });
  saveServers(servers);
  renderServers();
}

function cardContent(card) {
  if (card.type === "heading") return `<h3>${escapeText(card.text || "Heading")}</h3>`;
  if (card.type === "todo" || Array.isArray(card.items)) {
    const items = (card.items || [])
      .map((item) => `<p>${item?.checked || item?.done ? "☑" : "☐"} ${escapeText(item?.text || item || "")}</p>`)
      .join("");
    return `${card.title ? `<h3>${escapeText(card.title)}</h3>` : ""}${items}`;
  }
  if (Array.isArray(card.cells)) {
    const rows = card.cells
      .map((row) => `<p>${(row || []).map((cell) => escapeText(cell)).join(" · ")}</p>`)
      .join("");
    return rows;
  }
  const title = card.title && card.type !== "note" && card.type !== "document" ? `<h3>${escapeText(card.title)}</h3>` : "";
  return `${title}<p>${escapeText(card.text || card.description || card.caption || card.url || card.type || "")}</p>`;
}

function renderViewer(project, snapshot) {
  $("#workspace-viewer-title").textContent = project.name || "Board";
  $("#workspace-viewer-mode").textContent = project.role || "viewer";
  const canvas = $("#workspace-viewer-canvas");
  canvas.textContent = "";
  const doc = JSON.parse(snapshot.doc || "{}");
  const cards = [...(doc.cards || [])].sort((a, b) => Number(a.z || 0) - Number(b.z || 0));
  if (!cards.length) {
    const empty = document.createElement("p");
    empty.className = "admin-note";
    empty.textContent = "This board is empty.";
    canvas.append(empty);
    $("#workspace-viewer").hidden = false;
    return;
  }
  const minX = Math.min(...cards.map((card) => Number(card.x) || 0));
  const minY = Math.min(...cards.map((card) => Number(card.y) || 0));
  const maxX = Math.max(...cards.map((card) => (Number(card.x) || 0) + (Number(card.w) || 220)));
  const maxY = Math.max(...cards.map((card) => (Number(card.y) || 0) + (Number(card.h) || 90)));
  const board = document.createElement("div");
  board.className = "workspace-viewer-board";
  board.style.width = `${Math.max(620, maxX - minX + 64)}px`;
  board.style.height = `${Math.max(420, maxY - minY + 64)}px`;
  for (const card of cards) {
    const element = document.createElement("article");
    element.className = "workspace-viewer-card";
    element.style.left = `${(Number(card.x) || 0) - minX + 32}px`;
    element.style.top = `${(Number(card.y) || 0) - minY + 32}px`;
    element.style.width = `${Math.max(80, Number(card.w) || 220)}px`;
    element.style.height = `${Math.max(40, Number(card.h) || 90)}px`;
    element.style.zIndex = String(Number(card.z) || 1);
    element.innerHTML = cardContent(card);
    board.append(element);
  }
  canvas.append(board);
  $("#workspace-viewer").hidden = false;
}

async function render() {
  $("#workspace-host").textContent = window.location.host;
  renderServers();
  let session;
  try {
    session = await api("/api/v1/auth/sessions");
  } catch {
    return;
  }
  const account = session.account || {};
  $("#workspace-account").textContent = `${account.displayName || account.email || "Member"} · ${account.role || "member"}`;
  if (account.role !== "admin") $("#workspace-admin-link").hidden = true;
  const data = await api("/api/v1/projects");
  const projects = data.projects || [];
  $("#workspace-subtitle").textContent = `${projects.length} board${projects.length === 1 ? "" : "s"} · shared database`;
  const boards = $("#workspace-boards");
  boards.textContent = "";
  if (!projects.length) {
    const empty = document.createElement("div");
    empty.className = "workspace-empty";
    empty.textContent = "No boards are shared with this account yet.";
    boards.append(empty);
    return;
  }
  for (const project of projects) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-board";
    button.innerHTML = `<strong>${escapeText(project.name || "Untitled board")}</strong><span class="workspace-board-meta">${escapeText(
      project.role || "viewer"
    )} · revision ${escapeText(project.revision ?? 1)}</span>`;
    button.addEventListener("click", async () => {
      try {
        const snapshot = await api(`/api/v1/projects/${encodeURIComponent(project.id)}`);
        renderViewer(project, snapshot.snapshot || {});
      } catch (error) {
        window.alert(error.message);
      }
    });
    boards.append(button);
  }
}

$("#workspace-add-server").addEventListener("click", addServer);
$("#workspace-refresh").addEventListener("click", () => render().catch((error) => window.alert(error.message)));
$("#workspace-viewer-close").addEventListener("click", () => {
  $("#workspace-viewer").hidden = true;
});
$("#workspace-logout").addEventListener("click", async () => {
  try {
    await api("/api/v1/auth/logout", { method: "POST" });
  } finally {
    window.location.replace("/login");
  }
});

render().catch((error) => {
  $("#workspace-subtitle").textContent = error.message;
});
