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

const LAST_WORKSPACE_KEY = "ky.workspaceLast";

function readLastWorkspace(serverUrl) {
  try {
    const all = JSON.parse(localStorage.getItem(LAST_WORKSPACE_KEY) || "{}");
    return String(all[serverUrl] || "");
  } catch {
    return "";
  }
}

function writeLastWorkspace(serverUrl, workspaceId) {
  try {
    const all = JSON.parse(localStorage.getItem(LAST_WORKSPACE_KEY) || "{}");
    all[serverUrl] = workspaceId;
    localStorage.setItem(LAST_WORKSPACE_KEY, JSON.stringify(all));
  } catch {
    /* the preference is optional */
  }
}

// Prefer the workspace the user opened last. On a fresh install the seeded default workspace is
// skipped while another workspace exists, so "Team workspace" is not selected automatically.
function preferredWorkspace(serverUrl, workspaces) {
  const lastId = readLastWorkspace(serverUrl);
  if (lastId) {
    const last = workspaces.find((workspace) => workspace.id === lastId);
    if (last) return last;
  }
  return (
    workspaces.find((workspace) => workspace.id !== "workspace_default") || workspaces[0] || null
  );
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
              `<div class="mn-workspace-local-row"><button type="button" class="mn-workspace-popover-board" data-local-board="${escapeText(
                board.id
              )}"><strong>${escapeText(board.title || "Untitled")}</strong><span>local board</span></button><button type="button" class="mn-icon-btn mn-workspace-local-remove" data-local-remove="${escapeText(
                board.id
              )}" title="Remove local board" aria-label="Remove ${escapeText(
                board.title || "local board"
              )}">${icon("close", 12)}</button></div>`
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
    for (const button of target.querySelectorAll("[data-local-remove]")) {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        const board = boards.find((entry) => entry.id === button.dataset.localRemove);
        if (!board) return;
        const ui = await import("./ui.js");
        const store = await import("./store.js");
        const confirmed = await ui.confirmAction({
          title: "Remove local board?",
          message: `“${escapeText(board.title || "Untitled board")}” and its cards will be permanently deleted from this browser.`,
          confirmLabel: "Remove",
        });
        if (!confirmed) return;
        await store.removeBoard(board.id);
        await renderLocalWorkspaces(view);
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

async function removeServer(server) {
  try {
    const store = await import("./store.js");
    await store.flushRemoteBoard();
  } catch {
    /* the temporary copy is still written by the store */
  }
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
  menu.innerHTML = `<button type="button" class="mn-workspace-server-menu-item" role="menuitem" data-create-workspace="1">${icon("plus", 14)} Create workspace</button><button type="button" class="mn-workspace-server-menu-item is-danger" role="menuitem" data-remove-server="1">${icon("trash", 14)} Remove server</button>`;
  button.parentElement.append(menu);
  const close = () => {
    closeServerMenu();
    document.removeEventListener("pointerdown", outside, true);
  };
  const outside = (event) => {
    if (!menu.contains(event.target) && event.target !== button && !button.contains(event.target)) close();
  };
  document.addEventListener("pointerdown", outside, true);
  menu.querySelector("[data-create-workspace]").addEventListener("click", () => {
    close();
    openCreateWorkspaceDialog([server], document.getElementById("template-btn"));
  });
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
    <div class="mn-workspace-popover-sep"></div>
    <button type="button" class="mn-workspace-popover-row" data-add-server="1">${icon("plus", 16)}<span><strong>Add Server</strong><small>Connect a Khaoyu service</small></span></button>`;
  view.querySelector('[data-local]').addEventListener("click", closePopover);
  view.querySelector('[data-add-server]').addEventListener("click", () => openAddServerDialog(anchor));
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

function workspaceSignature(workspaces) {
  return (workspaces || [])
    .map((workspace) => `${workspace.id}:${workspace.name || ""}:${workspace.role || ""}`)
    .join("|");
}

async function loadServerWorkspaces(server, section, view) {
  const target = section.querySelector('[data-role="workspaces"]');
  const cached = readWorkspaceCache(server.url);
  if (cached?.length) renderWorkspaceRows(server, cached, target, view);
  try {
    const data = await withTimeout(jsonFetch(`${server.url}/api/v1/workspaces`, {}, server.token));
    const workspaces = data.workspaces || [];
    const unchanged = cached?.length && workspaceSignature(cached) === workspaceSignature(workspaces);
    writeWorkspaceCache(server.url, workspaces);
    // The cached rows are already rendered and one workspace is auto-loaded; re-rendering would
    // reload the same board list for no reason.
    if (!unchanged) renderWorkspaceRows(server, workspaces, target, view);
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
  // A single workspace is shown directly, like the reference design. Only show the workspace
  // selector when there is an actual choice to make.
  const selector =
    workspaces.length > 1
      ? `<div class="mn-workspace-popover-boards">${workspaces
          .map(
            (workspace) =>
              `<button type="button" class="mn-workspace-popover-board" data-workspace="${escapeText(
                workspace.id
              )}"><strong>${escapeText(workspace.name || "Workspace")}</strong><span>${escapeText(
                workspace.role || "member"
              )} · default ${escapeText(workspace.memberDefaultBoardRole || "viewer")}</span></button>`
          )
          .join("")}</div>`
      : "";
  target.innerHTML = `${selector}<div data-role="workspace-detail"></div>`;
  for (const button of target.querySelectorAll("[data-workspace]")) {
    const workspace = workspaces.find((entry) => entry.id === button.dataset.workspace);
    button.addEventListener("click", () => selectWorkspace(server, workspace, target, view));
  }
  const preferred = preferredWorkspace(server.url, workspaces);
  if (preferred) selectWorkspace(server, preferred, target, view, { persist: false });
}

function selectWorkspace(server, workspace, target, view, { persist = true } = {}) {
  if (!workspace) return;
  target
    .querySelectorAll("[data-workspace]")
    .forEach((entry) => entry.classList.toggle("is-active", entry.dataset.workspace === workspace.id));
  if (persist) writeLastWorkspace(server.url, workspace.id);
  void loadWorkspaceBoards(server, workspace, target, view);
}

const PROJECTS_CACHE_KEY = "ky.workspaceProjects";

function projectCacheKey(serverUrl, workspaceId) {
  return `${serverUrl}|${workspaceId}`;
}

function readProjectCache(serverUrl, workspaceId) {
  try {
    const all = JSON.parse(localStorage.getItem(PROJECTS_CACHE_KEY) || "{}");
    const entry = all[projectCacheKey(serverUrl, workspaceId)];
    return Array.isArray(entry?.projects) ? entry.projects : null;
  } catch {
    return null;
  }
}

function writeProjectCache(serverUrl, workspaceId, projects) {
  try {
    const all = JSON.parse(localStorage.getItem(PROJECTS_CACHE_KEY) || "{}");
    all[projectCacheKey(serverUrl, workspaceId)] = { projects, at: Date.now() };
    localStorage.setItem(PROJECTS_CACHE_KEY, JSON.stringify(all));
  } catch {
    /* cache is optional */
  }
}

function renderProjectRows(target, server, workspace, projects, root, view, { stale = false } = {}) {
  target.innerHTML = `<div class="mn-workspace-popover-actions"><button type="button" class="mn-btn" data-role="workspace-new-board">New board</button><button type="button" class="mn-btn" data-role="workspace-members">Members</button><button type="button" class="mn-btn" data-role="workspace-invite">Invite</button></div>${
    stale ? `<p class="mn-workspace-form-error" style="padding:8px 8px 0">Server unreachable. Showing the last known boards.</p>` : ""
  }<div class="mn-workspace-popover-boards">${
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
  target
    .querySelector('[data-role="workspace-new-board"]')
    ?.addEventListener("click", () => openCreateWorkspaceBoardDialog(server, workspace, root, view));
  target
    .querySelector('[data-role="workspace-members"]')
    ?.addEventListener("click", () => void openWorkspaceMembers(server, workspace));
  target
    .querySelector('[data-role="workspace-invite"]')
    ?.addEventListener("click", () => void openWorkspaceInvite(server, workspace, root));
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
}

async function loadWorkspaceBoards(server, workspace, root, view) {
  const target = root.querySelector('[data-role="workspace-detail"]');
  if (!target) return;
  const cached = readProjectCache(server.url, workspace.id);
  if (cached) renderProjectRows(target, server, workspace, cached, root, view, { stale: true });
  else target.innerHTML = `<p class="mn-server-note" style="padding:8px">Loading boards...</p>`;
  try {
    const data = await withTimeout(
      jsonFetch(`${server.url}/api/v1/workspaces/${encodeURIComponent(workspace.id)}/boards`, {}, server.token)
    );
    const projects = data.projects || [];
    writeProjectCache(server.url, workspace.id, projects);
    renderProjectRows(target, server, workspace, projects, root, view);
  } catch (error) {
    if (!cached) {
      target.innerHTML = `<p class="mn-workspace-form-error" style="padding:8px">${escapeText(error.message)}</p>`;
    }
  }
}

async function openWorkspaceMembers(server, workspace) {
  closePopover();
  const overlay = document.createElement("div");
  overlay.className = "mn-overlay";
  overlay.innerHTML = `<section class="mn-modal mn-workspace-form" role="dialog" aria-modal="true" aria-label="Workspace members">
    <header class="mn-modal-head"><h2 class="mn-modal-title">Members · ${escapeText(workspace.name || "Workspace")}</h2><button type="button" class="mn-icon-btn mn-modal-close" aria-label="Close">×</button></header>
    <div class="mn-modal-body mn-workspace-form"><p class="mn-workspace-note">Loading members...</p></div>
    <footer class="mn-modal-foot"><button type="button" class="mn-btn" data-role="cancel">Close</button></footer>
  </section>`;
  document.body.append(overlay);
  const body = overlay.querySelector(".mn-modal-body");
  const close = () => {
    overlay.remove();
    void openWorkspacePopover(document.getElementById("template-btn"));
  };
  overlay.querySelector(".mn-modal-close").addEventListener("click", close);
  overlay.querySelector('[data-role="cancel"]').addEventListener("click", close);
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) close();
  });
  const load = async () => {
    try {
      const data = await withTimeout(
        jsonFetch(`${server.url}/api/v1/workspaces/${encodeURIComponent(workspace.id)}/members`, {}, server.token)
      );
      const members = data.members || [];
      const canManage = ["owner", "admin"].includes(data.role);
      body.innerHTML = `<p class="mn-workspace-form-note">${members.length} member${members.length === 1 ? "" : "s"} in this workspace.</p><div data-role="member-list">${members
        .map((member) => {
          const managed = canManage && member.role !== "owner";
          const controls = managed
            ? `<span class="mn-workspace-member-controls"><select class="ky-input" data-member-role="${escapeText(member.id)}"><option value="member"${member.role === "member" ? " selected" : ""}>Member</option><option value="admin"${member.role === "admin" ? " selected" : ""}>Admin</option></select><button type="button" class="mn-btn" data-remove-member="${escapeText(member.id)}">Remove</button></span>`
            : `<span class="mn-workspace-member-role">${escapeText(member.role)}</span>`;
          return `<div class="mn-workspace-member"><div><strong>${escapeText(member.display_name || member.email || "Member")}</strong><small>${escapeText(
            member.username ? `@${member.username} · ${member.email || ""}` : member.email || ""
          )}</small></div>${controls}</div>`;
        })
        .join("")}</div><p class="mn-workspace-form-error" data-role="error" role="status"></p>`;
      body.querySelectorAll("[data-member-role]").forEach((select) => {
        select.addEventListener("change", async () => {
          const error = body.querySelector('[data-role="error"]');
          try {
            await jsonFetch(
              `${server.url}/api/v1/workspaces/${encodeURIComponent(workspace.id)}/members/${encodeURIComponent(select.dataset.memberRole)}`,
              { method: "PATCH", body: { role: select.value } },
              server.token
            );
            error.textContent = "";
            window.dispatchEvent(new CustomEvent("mn:toast", { detail: { message: "Member role updated" } }));
          } catch (failure) {
            error.textContent = failure.message || "Could not update the member.";
            await load();
          }
        });
      });
      body.querySelectorAll("[data-remove-member]").forEach((button) => {
        button.addEventListener("click", async () => {
          const ui = await import("./ui.js");
          const confirmed = await ui.confirmAction({
            title: "Remove workspace member?",
            message: "They will lose access to this workspace and its boards.",
            confirmLabel: "Remove",
          });
          if (!confirmed) return;
          const error = body.querySelector('[data-role="error"]');
          try {
            await jsonFetch(
              `${server.url}/api/v1/workspaces/${encodeURIComponent(workspace.id)}/members/${encodeURIComponent(button.dataset.removeMember)}`,
              { method: "DELETE" },
              server.token
            );
            await load();
            window.dispatchEvent(new CustomEvent("mn:toast", { detail: { message: "Member removed" } }));
          } catch (failure) {
            error.textContent = failure.message || "Could not remove the member.";
          }
        });
      });
    } catch (error) {
      body.innerHTML = `<p class="mn-workspace-form-error" role="status">${escapeText(error.message || "Could not load members.")}</p>`;
    }
  };
  await load();
}

async function openWorkspaceInvite(server, workspace) {
  closePopover();
  const overlay = document.createElement("div");
  overlay.className = "mn-overlay";
  overlay.innerHTML = `<form class="mn-modal mn-workspace-form" role="dialog" aria-modal="true" aria-label="Invite to workspace">
    <header class="mn-modal-head"><h2 class="mn-modal-title">Invite · ${escapeText(workspace.name || "Workspace")}</h2><button type="button" class="mn-icon-btn mn-modal-close" aria-label="Close">×</button></header>
    <div class="mn-modal-body mn-workspace-form">
      <p class="mn-workspace-form-note">Invite an existing account by email. The invitation expires after seven days.</p>
      <label>Email or username<input class="ky-input" name="email" autocomplete="off" placeholder="member or member@example.com" required /></label>
      <label>Role<select class="ky-input" name="role"><option value="member">Member</option><option value="admin">Admin</option></select></label>
      <p class="mn-workspace-form-error" data-role="error" role="status"></p>
      <div data-role="invite-list"></div>
    </div>
    <footer class="mn-modal-foot"><button type="button" class="mn-btn" data-role="cancel">Cancel</button><button type="submit" class="mn-btn mn-btn-primary">Send invite</button></footer>
  </form>`;
  document.body.append(overlay);
  const form = overlay.querySelector("form");
  const error = form.querySelector('[data-role="error"]');
  const inviteList = form.querySelector('[data-role="invite-list"]');
  const close = () => {
    overlay.remove();
    void openWorkspacePopover(document.getElementById("template-btn"));
  };
  form.querySelector(".mn-modal-close").addEventListener("click", close);
  form.querySelector('[data-role="cancel"]').addEventListener("click", close);
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) close();
  });
  const loadInvites = async () => {
    try {
      const data = await withTimeout(
        jsonFetch(`${server.url}/api/v1/workspaces/${encodeURIComponent(workspace.id)}/invitations`, {}, server.token)
      );
      const pending = (data.invitations || []).filter((invite) => invite.status === "pending");
      inviteList.innerHTML = pending.length
        ? `<div class="mn-workspace-invites"><strong>Pending invitations</strong>${pending
            .map(
              (invite) =>
                `<div class="mn-workspace-invite"><span>${escapeText(
                  invite.username ? `@${invite.username}` : invite.normalized_email || ""
                )}${invite.username ? ` · ${escapeText(invite.normalized_email || "")}` : ""}</span><small>${escapeText(
                  invite.requested_role || "member"
                )}</small></div>`
            )
            .join("")}</div>`
        : "";
    } catch {
      inviteList.innerHTML = "";
    }
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    error.textContent = "";
    try {
      await withTimeout(
        jsonFetch(
          `${server.url}/api/v1/workspaces/${encodeURIComponent(workspace.id)}/invitations`,
          {
            method: "POST",
            body: {
              identifier: form.elements.namedItem("email").value.trim(),
              role: form.elements.namedItem("role").value,
            },
          },
          server.token
        )
      );
      form.reset();
      error.textContent = "Invitation sent.";
      await loadInvites();
    } catch (failure) {
      error.textContent = failure.message || "Could not send the invitation.";
    } finally {
      submit.disabled = false;
    }
  });
  void loadInvites();
}

function openCreateWorkspaceBoardDialog(server, workspace, root, view) {
  const overlay = document.createElement("div");
  overlay.className = "mn-overlay";
  overlay.innerHTML = `<form class="mn-modal mn-workspace-form" role="dialog" aria-modal="true" aria-label="New board">
    <header class="mn-modal-head"><h2 class="mn-modal-title">New board</h2><button type="button" class="mn-icon-btn mn-modal-close" aria-label="Close">×</button></header>
    <div class="mn-modal-body mn-workspace-form">
      <p class="mn-workspace-form-note">The board is created inside ${escapeText(workspace.name || "this workspace")}.</p>
      <label>Board name<input class="ky-input" name="title" placeholder="Untitled board" autocomplete="off" required /></label>
      <p class="mn-workspace-form-error" data-role="error" role="status"></p>
    </div>
    <footer class="mn-modal-foot"><button type="button" class="mn-btn" data-role="cancel">Cancel</button><button type="submit" class="mn-btn mn-btn-primary">Create board</button></footer></form>`;
  document.body.append(overlay);
  const form = overlay.querySelector("form");
  const error = form.querySelector('[data-role="error"]');
  const close = () => overlay.remove();
  form.querySelector(".mn-modal-close").addEventListener("click", close);
  form.querySelector('[data-role="cancel"]').addEventListener("click", close);
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) close();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = form.elements.namedItem("title").value.trim() || "Untitled board";
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const created = await withTimeout(
        jsonFetch(
          `${server.url}/api/v1/projects`,
          { method: "POST", body: { title, workspaceId: workspace.id } },
          server.token
        )
      );
      close();
      closePopover();
      await openEditableBoard(
        server,
        {
          id: created.id,
          name: created.title || title,
          revision: created.revision || 1,
          role: created.role || "owner",
        },
        server.token
      );
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
    }
  });
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

function saveServerConnection(url, email, token) {
  const entries = servers().filter((entry) => entry.url !== url);
  entries.unshift({ url, name: new URL(url).host, email, token });
  saveServers(entries);
}

const OIDC_ERROR_TEXT = {
  invalid_app_origin: "This app origin is not allowed by the server.",
  account_missing: "No account exists for that email. Ask an administrator for an invitation.",
  account_pending: "Your account is waiting for administrator approval.",
  account_disabled: "That account is disabled.",
  domain_not_allowed: "That email domain is not allowed by the server.",
  email_unverified: "The provider did not return a verified email address.",
  provider_failed: "The provider could not complete sign-in. Please try again.",
  access_denied: "Sign-in was cancelled.",
  invalid_state: "The sign-in attempt expired. Please try again.",
  provider_unavailable: "This sign-in provider is not available on the server.",
};

function openAddServerDialog(anchor) {
  closePopover();
  const overlay = document.createElement("div");
  overlay.className = "mn-overlay";
  document.body.append(overlay);
  const close = () => {
    window.removeEventListener("message", onOidcMessage);
    window.removeEventListener("storage", onServerStorage);
    overlay.remove();
  };
  let selectedUrl = "";
  let features = null;
  let errorText = "";
  let challenge = "";
  let loginEmail = "";
  const knownServers = new Map(servers().map((entry) => [entry.url, entry.token]));
  function onServerStorage(event) {
    if (event.key !== SERVERS_KEY || !event.newValue) return;
    let entries;
    try {
      entries = JSON.parse(event.newValue);
    } catch {
      return;
    }
    if (!Array.isArray(entries)) return;
    const added = entries.find((entry) => entry?.url && knownServers.get(entry.url) !== entry.token);
    if (!added) return;
    close();
    void openWorkspacePopover(anchor);
    window.dispatchEvent(
      new CustomEvent("mn:toast", { detail: { message: "Server connected with OIDC" } })
    );
  }
  window.addEventListener("storage", onServerStorage);

  function focusError() {
    overlay.querySelector('[data-role="error"]')?.focus?.();
  }

  function renderStep1() {
    selectedUrl = "";
    features = null;
    overlay.innerHTML = `<form class="mn-modal mn-workspace-form" role="dialog" aria-modal="true" aria-label="Add server">
      <header class="mn-modal-head"><h2 class="mn-modal-title">Add Server</h2><button type="button" class="mn-icon-btn mn-modal-close" aria-label="Close">×</button></header>
      <div class="mn-modal-body mn-workspace-form">
        <p class="mn-workspace-form-note">Enter the Khaoyu service address first. The next step lists the sign-in methods that server supports.</p>
        <label>Server URL<input class="ky-input" name="url" placeholder="https://admin.example.com" autocomplete="url" required /></label>
        <p class="mn-workspace-form-error" data-role="error" role="status">${escapeText(errorText)}</p>
      </div>
      <footer class="mn-modal-foot"><button type="button" class="mn-btn" data-role="cancel">Cancel</button><button type="submit" class="mn-btn mn-btn-primary">Continue</button></footer>
    </form>`;
    const form = overlay.querySelector("form");
    form.querySelector(".mn-modal-close").addEventListener("click", close);
    form.querySelector('[data-role="cancel"]').addEventListener("click", close);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const url = normalizeUrl(form.url.value);
      if (!url) {
        errorText = "Enter a valid server URL.";
        form.querySelector('[data-role="error"]').textContent = errorText;
        return;
      }
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      form.querySelector('[data-role="error"]').textContent = "Checking server sign-in options...";
      try {
        const data = await withTimeout(jsonFetch(`${url}/api/v1/auth/features`), 8000);
        if (!data || typeof data !== "object") throw new Error("The server did not return sign-in options.");
        selectedUrl = url;
        features = data;
        renderStep2();
      } catch (error) {
        errorText = error.message || "Could not reach the server.";
        renderStep1();
        focusError();
      }
    });
  }

  function renderStep2() {
    const providers = Array.isArray(features?.oidcProviders) ? features.oidcProviders : [];
    const oidcMarkup = providers.length
      ? `<div class="mn-workspace-or"><span>or</span></div>
         <div class="mn-workspace-oidc${providers.length > 1 ? " is-row" : ""}" data-role="oidc">
           ${providers
             .map(
               (provider) =>
                 `<button type="button" class="mn-btn mn-workspace-oidc-btn" data-oidc-provider="${escapeText(
                   provider.id
                 )}">Continue with ${escapeText(provider.name || provider.id)}</button>`
             )
             .join("")}
         </div>`
      : "";
    overlay.innerHTML = `<form class="mn-modal mn-workspace-form" role="dialog" aria-modal="true" aria-label="Sign in">
      <header class="mn-modal-head"><h2 class="mn-modal-title">Sign in</h2><button type="button" class="mn-icon-btn mn-modal-close" aria-label="Close">×</button></header>
      <div class="mn-modal-body mn-workspace-form">
        <p class="mn-workspace-form-note">Connected to <strong>${escapeText(new URL(selectedUrl).host)}</strong>.</p>
        <label>Email<input class="ky-input" name="email" type="email" autocomplete="email" value="${escapeText(loginEmail)}" required /></label>
        <label>Password<input class="ky-input" name="password" type="password" autocomplete="current-password" required /></label>
        <p class="mn-workspace-form-error" data-role="error" role="status">${escapeText(errorText)}</p>
        <button type="submit" class="mn-btn mn-btn-primary mn-workspace-signin">Sign in</button>
        ${oidcMarkup}
      </div>
      <footer class="mn-modal-foot"><button type="button" class="mn-btn" data-role="back">Back</button><button type="button" class="mn-btn" data-role="cancel">Cancel</button></footer>
    </form>`;
    errorText = "";
    const form = overlay.querySelector("form");
    form.querySelector(".mn-modal-close").addEventListener("click", close);
    form.querySelector('[data-role="cancel"]').addEventListener("click", close);
    form.querySelector('[data-role="back"]').addEventListener("click", () => {
      errorText = "";
      renderStep1();
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      form.querySelector('[data-role="error"]').textContent = "Signing in...";
      try {
        loginEmail = form.email.value.trim();
        const data = await jsonFetch(`${selectedUrl}/api/v1/auth/sync-token/begin`, {
          method: "POST",
          body: { email: loginEmail, password: form.password.value },
        });
        if (data.totpRequired) {
          challenge = data.challenge;
          renderSyncChallenge("totp");
          return;
        }
        if (!data.token) throw new Error("The server did not return a sync token.");
        finishSyncLogin(data.token, data.email || loginEmail);
      } catch (error) {
        form.querySelector('[data-role="error"]').textContent = error.message || "Could not sign in.";
        submit.disabled = false;
      }
    });
    for (const button of form.querySelectorAll("[data-oidc-provider]")) {
      button.addEventListener("click", () => {
        const provider = button.dataset.oidcProvider;
        const url = `${selectedUrl}/api/v1/auth/oidc/${encodeURIComponent(
          provider
        )}/start?mode=login&origin=${encodeURIComponent(location.origin)}`;
        const popup = window.open(url, "khaoyu-oidc", "width=520,height=720");
        if (!popup) {
          form.querySelector('[data-role="error"]').textContent =
            "Allow pop-ups to sign in with this provider.";
          return;
        }
        form.querySelector('[data-role="error"]').textContent =
          "Complete the sign-in in the opened window.";
      });
    }
  }

  function finishSyncLogin(token, email) {
    saveServerConnection(selectedUrl, email || loginEmail, token);
    close();
    void openWorkspacePopover(anchor);
    window.dispatchEvent(
      new CustomEvent("mn:toast", { detail: { message: "Server connected" } })
    );
  }

  function renderSyncChallenge(kind) {
    const backup = kind === "backup";
    overlay.innerHTML = `<form class="mn-modal mn-workspace-form" role="dialog" aria-modal="true" aria-label="${
      backup ? "Use a backup code" : "Two-factor authentication"
    }">
      <header class="mn-modal-head"><h2 class="mn-modal-title">${
        backup ? "Use a backup code" : "Two-factor authentication"
      }</h2><button type="button" class="mn-icon-btn mn-modal-close" aria-label="Close">×</button></header>
      <div class="mn-modal-body mn-workspace-form">
        <p class="mn-workspace-form-note">${
          backup
            ? "Enter one of the backup codes you saved when setting up two-factor authentication."
            : `Enter the 6-digit code from your authenticator app for ${escapeText(loginEmail)}.`
        }</p>
        <label>${backup ? "Backup code" : "Authentication code"}<input class="ky-input" name="code" ${
          backup ? 'autocomplete="one-time-code" placeholder="XXXXX-XXXXX"' : 'inputmode="numeric" autocomplete="one-time-code" placeholder="123456" maxlength="6"'
        } required /></label>
        <p class="mn-workspace-form-error" data-role="error" role="status">${escapeText(errorText)}</p>
        <button type="submit" class="mn-btn mn-btn-primary mn-workspace-signin">${
          backup ? "Sign in with backup code" : "Verify"
        }</button>
        <button type="button" class="auth-link mn-workspace-challenge-link" data-role="switch">${
          backup ? "Use an authenticator code instead" : "Use a backup code instead"
        }</button>
      </div>
      <footer class="mn-modal-foot"><button type="button" class="mn-btn" data-role="back">Back</button><button type="button" class="mn-btn" data-role="cancel">Cancel</button></footer>
    </form>`;
    errorText = "";
    const form = overlay.querySelector("form");
    form.querySelector(".mn-modal-close").addEventListener("click", close);
    form.querySelector('[data-role="cancel"]').addEventListener("click", close);
    form.querySelector('[data-role="back"]').addEventListener("click", () => {
      errorText = "Enter your password again.";
      renderStep2();
    });
    form.querySelector('[data-role="switch"]').addEventListener("click", () => {
      errorText = "";
      renderSyncChallenge(backup ? "totp" : "backup");
    });
    form.querySelector("input[name=code]").focus();
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      form.querySelector('[data-role="error"]').textContent = backup ? "Signing in..." : "Verifying...";
      try {
        const data = await jsonFetch(
          `${selectedUrl}/api/v1/auth/sync-token/${backup ? "backup" : "totp"}`,
          { method: "POST", body: { challenge, code: form.elements.namedItem("code").value.trim() } }
        );
        if (!data.token) throw new Error("The server did not return a sync token.");
        finishSyncLogin(data.token, data.email || loginEmail);
      } catch (error) {
        if (/expired/i.test(String(error.message || ""))) {
          errorText = "Your sign-in attempt expired. Enter your password again.";
          renderStep2();
          return;
        }
        form.querySelector('[data-role="error"]').textContent =
          error.message || "Could not complete two-factor authentication.";
        submit.disabled = false;
      }
    });
  }

  function onOidcMessage(event) {
    if (event.origin !== location.origin || !event.data || event.data.type !== "khaoyu-oidc") return;
    const data = event.data;
    if (data.error) {
      errorText = OIDC_ERROR_TEXT[data.error] || "Could not sign in with that provider.";
      const errorEl = overlay.querySelector('[data-role="error"]');
      if (errorEl) errorEl.textContent = errorText;
      return;
    }
    if (!data.token) return;
    const url = normalizeUrl(data.server || selectedUrl);
    saveServerConnection(url, data.email || "", data.token);
    close();
    void openWorkspacePopover(anchor);
    window.dispatchEvent(
      new CustomEvent("mn:toast", { detail: { message: "Server connected with OIDC" } })
    );
  }

  window.addEventListener("message", onOidcMessage);
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) close();
  });
  renderStep1();
}

// The OIDC popup redirects back to this app with a short-lived fragment. When it was opened from
// the Add Server dialog, hand the token to the opener and close; otherwise store it locally.
export function takeOidcReturn() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const token = params.get("oidc") || "";
  const error = params.get("oidc_error") || "";
  if (!token && !error) return false;
  const payload = {
    type: "khaoyu-oidc",
    token,
    error,
    email: params.get("email") || "",
    server: params.get("server") || "",
  };
  window.history.replaceState(null, "", location.pathname + location.search);
  if (window.opener && window.opener !== window && !window.opener.closed) {
    try {
      window.opener.postMessage(payload, location.origin);
    } catch {
      /* the opener may have navigated away */
    }
    window.close();
    return true;
  }
  if (token && payload.server) {
    const url = normalizeUrl(payload.server);
    if (url) {
      saveServerConnection(url, payload.email, token);
      setTimeout(
        () =>
          window.dispatchEvent(
            new CustomEvent("mn:toast", { detail: { message: "Server connected with OIDC" } })
          ),
        0
      );
    }
  }
  // The popup may lose its opener reference across the provider redirect. It still carries the
  // window name assigned by window.open, so close it and let the opener's storage listener or
  // the local connection pick up the new server.
  if (window.name === "khaoyu-oidc") {
    window.close();
    return true;
  }
  return false;
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

function parseSnapshotDoc(data, projectId) {
  let doc = {};
  try {
    doc = JSON.parse(data.snapshot?.doc || "{}");
  } catch {
    doc = {};
  }
  doc.id = projectId;
  return doc;
}

async function loadProjectDocument(server, project, token) {
  const data = await jsonFetch(`${server.url}/api/v1/projects/${encodeURIComponent(project.id)}`, {}, token);
  return {
    doc: parseSnapshotDoc(data, project.id),
    revision: Number(data.project?.revision ?? project.revision) || 1,
    lastSeq: Number(data.project?.lastSeq ?? project.lastSeq ?? 0),
    serverUrl: server.url,
  };
}

async function openEditableBoard(server, project, token) {
  closePopover();
  const view = ensureBoardOverlay();
  view.querySelector('[data-role="title"]').textContent = project.name || "Board";
  const content = view.querySelector('[data-role="content"]');
  content.innerHTML = `<p class="mn-server-empty">Opening editable board...</p>`;
  const [store, sync, syncUi, remoteTemp, syncStore] = await Promise.all([
    import("./store.js"),
    import("./sync.js"),
    import("./sync-ui.js"),
    import("./remote-temp.js"),
    import("./sync-store.js"),
  ]);
  let cached = null;
  try {
    cached = await syncStore.loadRecord(project.id);
  } catch {
    cached = null;
  }
  let doc;
  let revision;
  let lastSeq;
  let baseDoc;
  let offline = false;
  try {
    // A dead tunnel must not hang boot or the workspace popover; the cache is the fallback.
    const remote = await withTimeout(loadProjectDocument(server, project, token), 10000);
    baseDoc = remote.doc;
    revision = remote.revision;
    lastSeq = remote.lastSeq;
    // Pending local operations win over the server snapshot; the flush replays the server changes
    // first and then resends the local patches.
    doc = cached?.pendingOps?.length && cached.doc ? cached.doc : remote.doc;
  } catch (error) {
    if (!cached?.doc) {
      content.innerHTML = `<p class="mn-server-empty">${escapeText(error.message)}</p>`;
      return;
    }
    doc = cached.doc;
    revision = Number(cached.revision) || 1;
    lastSeq = Number(cached.lastSeq) || 0;
    baseDoc = cached.baseDoc;
    offline = true;
  }
  const pending = remoteTemp.readRemoteTemp(project.id);
  const legacyDocument = pending?.board?.id === project.id ? pending.board : null;
  if (legacyDocument) doc = legacyDocument;
  try {
    await store.openRemoteBoard(doc, {
      projectId: project.id,
      revision,
      lastSeq,
      lastSyncedAt: Number(cached?.lastSyncedAt) || Date.now(),
    });
    sync.saveSyncConfig({ url: server.url, email: server.email || "", token });
    await sync.attachRemoteBoard(store.state.board, {
      projectId: project.id,
      revision,
      lastSeq,
      baseDoc,
      serverUrl: server.url,
    });
    localStorage.setItem("ky.lastBoard", project.id);
    if (legacyDocument) {
      // A temporary copy from an older build is diffed into operations against the server document.
      try {
        await sync.importLocalDocument(store.state.board, baseDoc || cached?.baseDoc || doc);
      } catch {
        /* the normal capture below still runs */
      }
    }
    let pushed = { status: "pending" };
    try {
      pushed = await sync.flushBoardNow(store.state.board);
    } catch {
      pushed = { status: "pending" };
    }
    if (pushed.status === "pushed" || pushed.status === "noop") remoteTemp.clearRemoteTemp(project.id);
    view.remove();
    boardOverlay = null;
    syncUi.refresh();
    const message = offline
      ? "Opened the cached board (offline); changes will sync later"
      : pushed.status === "pushed" || pushed.status === "noop"
        ? "Opened team board"
        : "Opened team board; changes are queued";
    window.dispatchEvent(new CustomEvent("mn:toast", { detail: { message } }));
  } catch (error) {
    content.innerHTML = `<p class="mn-server-empty">${escapeText(error.message)}</p>`;
  }
}

// Reopen the last remote workspace board after a reload, using the durable local mirror offline.
export async function openCachedBoard(boardId) {
  if (!boardId) return false;
  let syncStore;
  try {
    syncStore = await import("./sync-store.js");
  } catch {
    return false;
  }
  const record = await syncStore.loadRecord(boardId).catch(() => null);
  if (!record?.doc || !record.projectId) return false;
  const sync = await import("./sync.js");
  const config = sync.loadSyncConfig();
  const serverUrl = normalizeUrl(record.serverUrl || config.url);
  const token =
    servers().find((entry) => normalizeUrl(entry.url) === serverUrl)?.token || config.token || "";
  if (!serverUrl || !token) return false;
  const server = {
    url: serverUrl,
    token,
    email: config.email || "",
    name: new URL(serverUrl).host,
  };
  await openEditableBoard(
    server,
    { id: record.projectId, name: record.doc.title || "Board", revision: record.revision },
    token
  );
  return true;
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
