import { icon } from "./icons.js";
import { SERVICE_LEGACY_KEYS, THEME_KEY, readStoredTheme, setTheme as persistTheme, systemTheme, toggleTheme as nextTheme } from "./theme.js";
// Self-hosted service admin dashboard. The page uses the account session and requires the admin role.

const pane = document.getElementById("admin-pane");
const title = document.getElementById("admin-title");
const navItems = [...document.querySelectorAll(".admin-nav-item")];
const identity = document.getElementById("admin-identity");
const themeButton = document.getElementById("admin-theme");
const hostBadge = document.getElementById("admin-host");
const accountMenu = document.getElementById("admin-account-menu");
const searchButton = document.getElementById("admin-search");
const commandLayer = document.getElementById("admin-command-layer");
const commandInput = document.getElementById("admin-command-input");
const commandList = document.getElementById("admin-command-list");
const helpLayer = document.getElementById("admin-help-layer");
const helpClose = document.getElementById("admin-help-close");

const LEGACY_THEME_KEYS = SERVICE_LEGACY_KEYS;
let page = "overview";
let dashboard = null;
let activityOffset = 0;
let activityFilter = { q: "", action: "" };

class AuthError extends Error {}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : "";
}

function initials(name, email) {
  const value = String(name || email || "?").trim();
  return value ? value.charAt(0).toUpperCase() : "?";
}

function displayName(person) {
  return person.displayName || person.display_name || person.email || person.actorEmail || "Unknown";
}

function avatarHtml(person) {
  const url = person.avatarUrl || person.avatar_url || "";
  const color = person.avatarColor || person.avatar_color || "";
  const style = [];
  if (url) style.push(`background-image:url('${escapeHtml(url)}')`);
  else if (/^#[0-9a-f]{6}$/i.test(color)) {
    style.push(`background:color-mix(in srgb, ${color} 35%, var(--ky-control-active))`);
  }
  return `<span class="admin-avatar${url ? " has-image" : ""}"${style.length ? ` style="${style.join(";")}"` : ""}>${escapeHtml(
    initials(displayName(person), person.email || person.actorEmail)
  )}</span>`;
}

function formatTime(value) {
  if (!value) return "Never";
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function actionLabel(action) {
  const text = String(action || "activity").replace(/[._]/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && method !== "HEAD") {
    const csrf = cookie("khaoyu_csrf");
    if (csrf) headers["x-csrf-token"] = csrf;
  }
  const response = await fetch(path, {
    method,
    headers,
    credentials: "include",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 || response.status === 403) {
    throw new AuthError("admin access required");
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(payload?.error || `Request failed (${response.status})`);
  }
  return payload;
}

function showAuth() {
  identity.hidden = true;
  // Redirect immediately: the dashboard is only meaningful with a signed-in admin session.
  window.location.replace("/login");
}

function showError(error) {
  const box = document.createElement("div");
  box.className = "admin-error";
  box.textContent = error?.message || "Something went wrong.";
  pane.prepend(box);
}

function renderIdentity(admin) {
  if (!admin) {
    identity.hidden = true;
    return;
  }
  identity.hidden = false;
  const label = admin.displayName || admin.email;
  document.getElementById("admin-name").textContent = label;
  document.getElementById("admin-email").textContent = admin.email;
  identity.title = `${label} — account menu`;
  identity.setAttribute("aria-label", `${label} — account menu`);
  document.getElementById("admin-avatar").outerHTML = avatarHtml({
    displayName: admin.displayName,
    email: admin.email,
    avatarUrl: admin.avatarUrl,
  }).replace('class="admin-avatar', 'id="admin-avatar" class="admin-avatar');
}

function setTheme(theme) {
  const applied = persistTheme(theme, { key: THEME_KEY });
  const dark = applied === "dark" || applied === "softDark";
  themeButton.innerHTML = icon(dark ? "sun" : "moon", 16);
  const label = dark ? "Switch to light mode" : "Switch to dark mode";
  themeButton.title = label;
  themeButton.setAttribute("aria-label", label);
}

function initTheme() {
  const theme = readStoredTheme({
    key: THEME_KEY,
    legacyKeys: LEGACY_THEME_KEYS,
    fallback: systemTheme(),
  });
  setTheme(theme);
  themeButton.addEventListener("click", () => {
    setTheme(nextTheme(document.documentElement.dataset.kyTheme));
  });
}

function statCards(cards) {
  return `<div class="admin-grid">${cards
    .map(
      ([label, value]) =>
        `<div class="ky-card admin-card"><span class="admin-card-label">${escapeHtml(label)}</span><span class="admin-card-value">${escapeHtml(value)}</span></div>`
    )
    .join("")}</div>`;
}

function activityTable(entries, compact = false) {
  if (!entries.length) return `<div class="admin-empty">No activity yet.</div>`;
  return `
    <table class="ky-table admin-table">
      <thead><tr><th>Actor</th><th>Action</th><th>Resource</th><th>Time</th></tr></thead>
      <tbody>
        ${entries
          .map(
            (entry) => `
          <tr>
            <td><div class="admin-user">${avatarHtml({
              displayName: entry.actorName || entry.actorEmail,
              email: entry.actorEmail,
              avatarColor: entry.avatarColor || entry.actor_avatar_color,
              avatarUrl: entry.avatarUrl || entry.actor_avatar_url,
            })}<span class="admin-user-copy"><strong>${escapeHtml(
              entry.actorName || entry.actorEmail || "System"
            )}</strong>${compact ? "" : `<span>${escapeHtml(entry.actorEmail || "")}</span>`}</span></div></td>
            <td><span class="admin-activity-action">${escapeHtml(actionLabel(entry.action))}</span></td>
            <td>${escapeHtml(entry.resourceType || entry.resource_type || "")}${
              entry.resourceId || entry.resource_id
                ? ` <span class="admin-time">${escapeHtml(entry.resourceId || entry.resource_id)}</span>`
                : ""
            }</td>
            <td class="admin-time">${escapeHtml(formatTime(entry.createdAt || entry.created_at))}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

function renderOverview() {
  if (!dashboard) return;
  const { counts, recentActivity, recentAccounts } = dashboard;
  pane.innerHTML = `
    ${statCards([
      ["Accounts", counts.accounts],
      ["Active accounts", counts.activeAccounts],
      ["Boards", counts.boards ?? counts.teams],
      ["Activity entries", counts.auditEntries],
    ])}
    <div class="ky-section admin-section">
      <div class="admin-section-head"><div><h2>Recent activity</h2><p>Every recorded account, project and share change.</p></div></div>
      ${activityTable(recentActivity, true)}
    </div>
    <div class="ky-section admin-section">
      <div class="admin-section-head"><div><h2>Recent accounts</h2><p>Newest service members and their status.</p></div></div>
      <div class="admin-team-grid">
        ${recentAccounts
          .map(
            (user) => `
          <div class="admin-team">
            <div class="admin-user">${avatarHtml(user)}<span class="admin-user-copy"><strong>${escapeHtml(
              displayName(user)
            )}</strong><span>${escapeHtml(user.email)}</span></span></div>
            <div class="admin-team-meta">
              <span class="admin-badge ${user.role === "admin" ? "is-admin" : ""}">${escapeHtml(user.role)}</span>
              <span class="admin-badge ${user.status === "active" ? "is-active" : "is-disabled"}">${escapeHtml(
                user.status
              )}</span>
              <span>Joined ${escapeHtml(formatTime(user.createdAt))}</span>
            </div>
          </div>`
          )
          .join("")}
      </div>
    </div>`;
}

function accountDetailRows(data) {
  const user = data.user;
  const security = data.security || {};
  const sessions = (data.sessions || []).filter((session) => !session.revoked);
  const projects = data.projects || [];
  return `
    <div class="admin-account-detail">
      <div class="admin-account-detail-head">
        <div class="admin-user">${avatarHtml(user)}<span class="admin-user-copy"><strong>${escapeHtml(
          displayName(user)
        )}</strong><span>${escapeHtml(user.email)}</span></span></div>
        <button class="ky-button ky-button-quiet" type="button" data-role="detail-close">Close</button>
      </div>
      <div class="admin-detail-grid">
        <div><span>Account ID</span><code>${escapeHtml(user.id)}</code></div>
        <div><span>Role</span>${escapeHtml(user.role)}</div>
        <div><span>Status</span>${escapeHtml(user.status)}</div>
        <div><span>Created</span>${escapeHtml(formatTime(user.createdAt))}</div>
        <div><span>Updated</span>${escapeHtml(formatTime(user.updatedAt))}</div>
        <div><span>Last active</span>${escapeHtml(formatTime(user.lastSeenAt))}</div>
        <div><span>Email verified</span>${security.emailVerified ? "Yes" : "No"}</div>
        <div><span>2FA</span>${security.totpEnabled ? "Authenticator enabled" : "Not enabled"}</div>
        <div><span>Passkeys</span>${escapeHtml(security.passkeyCount ?? 0)}</div>
        <div><span>Boards</span>${escapeHtml(user.projectCount ?? projects.length)}</div>
      </div>
      <div class="admin-detail-columns">
        <section>
          <h4>Boards</h4>
          ${
            projects.length
              ? `<ul class="admin-detail-list">${projects
                  .map(
                    (project) =>
                      `<li><strong>${escapeHtml(project.name)}</strong><span>${escapeHtml(
                        project.role
                      )} · rev ${escapeHtml(project.revision)} · ${escapeHtml(formatTime(project.updatedAt))}</span></li>`
                  )
                  .join("")}</ul>`
              : `<p class="admin-note">No boards.</p>`
          }
        </section>
        <section>
          <h4>Active sessions</h4>
          ${
            sessions.length
              ? `<ul class="admin-detail-list">${sessions
                  .slice(0, 6)
                  .map(
                    (session) =>
                      `<li><strong>${escapeHtml(session.device)}${session.current ? " (current)" : ""}</strong><span>Last seen ${escapeHtml(
                        formatTime(session.lastSeenAt)
                      )}</span></li>`
                  )
                  .join("")}</ul>`
              : `<p class="admin-note">No active sessions.</p>`
          }
        </section>
      </div>
    </div>`;
}

async function renderAccounts(query = "") {
  pane.innerHTML = `<div class="admin-loading">Loading accounts...</div>`;
  let data;
  try {
    data = await api(`/api/v1/admin/users?limit=100&q=${encodeURIComponent(query)}`);
  } catch (error) {
    if (error instanceof AuthError) return showAuth();
    pane.innerHTML = "";
    return showError(error);
  }
  const selfId = dashboard?.admin?.id;
  pane.innerHTML = `
    <div class="ky-section admin-section">
      <div class="admin-section-head"><div><h2>Accounts</h2><p>${data.total} service account${
        data.total === 1 ? "" : "s"
      }.</p></div></div>
      <form class="admin-toolbar" data-role="account-search">
        <input class="admin-search" name="q" value="${escapeHtml(query)}" placeholder="Search name, email or username" autocomplete="off" />
        <button class="ky-button ky-button-primary" type="submit">Search</button>
      </form>
      <form class="admin-toolbar admin-account-create" data-role="account-create">
        <input class="admin-search" name="email" type="email" placeholder="Member email" maxlength="254" required />
        <input class="admin-search" name="displayName" placeholder="Display name" maxlength="120" />
        <input class="admin-search" name="password" type="password" minlength="12" maxlength="200" placeholder="Temporary password (12+ chars)" autocomplete="new-password" required />
        <select class="admin-select" name="role" aria-label="New member role">
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button class="ky-button ky-button-primary" type="submit">Add member</button>
        <p class="admin-note" data-role="account-create-status" role="status"></p>
      </form>
      ${
        data.users.length
          ? `<table class="ky-table admin-table">
        <thead><tr><th>Account</th><th>Role</th><th>Status</th><th>Boards</th><th>Last active</th><th>Updated</th></tr></thead>
        <tbody>
          ${data.users
            .map(
              (user) => `
            <tr data-user="${escapeHtml(user.id)}">
              <td><div class="admin-user">${avatarHtml(user)}<span class="admin-user-copy"><strong>${escapeHtml(
                displayName(user)
              )}</strong><span>${escapeHtml(user.email)}</span></span><button class="admin-detail-button" type="button" data-role="account-detail" data-user="${escapeHtml(
                user.id
              )}">Details</button></div></td>
              <td>
                <select class="admin-select" data-role="role" ${user.id === selfId ? "disabled" : ""}>
                  <option value="member"${user.role === "member" ? " selected" : ""}>Member</option>
                  <option value="admin"${user.role === "admin" ? " selected" : ""}>Admin</option>
                </select>
              </td>
              <td>
                <select class="admin-select" data-role="status" ${user.id === selfId ? "disabled" : ""}>
                  <option value="active"${user.status === "active" ? " selected" : ""}>Active</option>
                  <option value="disabled"${user.status === "disabled" ? " selected" : ""}>Disabled</option>
                </select>
              </td>
              <td>${escapeHtml(user.projectCount)}</td>
              <td class="admin-time">${escapeHtml(formatTime(user.lastSeenAt))}</td>
              <td class="admin-time">${escapeHtml(formatTime(user.updatedAt))}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>`
          : `<div class="admin-empty">No accounts match that search.</div>`
      }
    </div>`;
  pane.querySelector('[data-role="account-search"]').addEventListener("submit", (event) => {
    event.preventDefault();
    renderAccounts(event.target.q.value.trim());
  });
  pane.querySelector('[data-role="account-create"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const status = form.querySelector('[data-role="account-create-status"]');
    status.textContent = "Creating account...";
    try {
      await api("/api/v1/admin/users", {
        method: "POST",
        body: {
          email: form.email.value.trim(),
          displayName: form.displayName.value.trim(),
          password: form.password.value,
          role: form.role.value,
        },
      });
      form.reset();
      dashboard = await api("/api/v1/admin/dashboard");
      await renderAccounts(query);
      const freshStatus = pane.querySelector('[data-role="account-create-status"]');
      if (freshStatus) freshStatus.textContent = "Account created. Share the temporary password securely.";
    } catch (error) {
      if (error instanceof AuthError) return showAuth();
      status.textContent = error.message;
    }
  });
  for (const button of pane.querySelectorAll('button[data-role="account-detail"]')) {
    button.addEventListener("click", async () => {
      const row = button.closest("tr[data-user]");
      if (!row) return;
      const next = row.nextElementSibling;
      if (next?.classList.contains("admin-user-detail")) {
        next.remove();
        return;
      }
      button.disabled = true;
      try {
        const data = await api(`/api/v1/admin/users/${encodeURIComponent(button.dataset.user)}`);
        const detail = document.createElement("tr");
        detail.className = "admin-user-detail";
        detail.innerHTML = `<td colspan="${row.children.length}">${accountDetailRows(data)}</td>`;
        detail.querySelector('[data-role="detail-close"]').addEventListener("click", () => detail.remove());
        row.after(detail);
      } catch (error) {
        if (error instanceof AuthError) return showAuth();
        showError(error);
      } finally {
        button.disabled = false;
      }
    });
  }

  for (const row of pane.querySelectorAll("tr[data-user]")) {
    const userId = row.dataset.user;
    for (const select of row.querySelectorAll("select[data-role]")) {
      select.addEventListener("change", async () => {
        try {
          await api(`/api/v1/admin/users/${encodeURIComponent(userId)}`, {
            method: "PATCH",
            body: { [select.dataset.role]: select.value },
          });
          dashboard = await api("/api/v1/admin/dashboard");
          await renderAccounts(query);
        } catch (error) {
          if (error instanceof AuthError) return showAuth();
          showError(error);
        }
      });
    }
  }
}

async function renderTeams() {
  pane.innerHTML = `<div class="admin-loading">Loading boards...</div>`;
  let data;
  try {
    data = await api("/api/v1/admin/boards?limit=100");
  } catch (error) {
    if (error instanceof AuthError) return showAuth();
    pane.innerHTML = "";
    return showError(error);
  }
  pane.innerHTML = `
    <div class="ky-section admin-section">
      <div class="admin-section-head"><div><h2>Boards</h2><p>${data.total} board${
        data.total === 1 ? "" : "s"
      } owned by service accounts.</p></div></div>
      <form class="admin-toolbar admin-team-create" data-role="team-create">
        <input class="admin-search" name="name" placeholder="New board name" maxlength="120" required />
        <button class="ky-button ky-button-primary" type="submit">Create board</button>
      </form>
      ${
        (data.boards || data.teams).length
          ? `<div class="admin-team-grid">${(data.boards || data.teams)
              .map(
                (team) => `
            <div class="admin-team">
              <div class="admin-team-head">
                <h3>${escapeHtml(team.name)}</h3>
                <div class="admin-team-actions">
                  <button class="ky-button ky-button-quiet" type="button" data-role="members" data-team="${escapeHtml(
                    team.id
                  )}">Members</button>
                  <button class="ky-button ky-button-quiet" type="button" data-role="rename" data-team="${escapeHtml(
                    team.id
                  )}">Rename</button>
                  <button class="ky-button ky-button-quiet admin-danger-text" type="button" data-role="delete" data-team="${escapeHtml(
                    team.id
                  )}">Delete</button>
                </div>
              </div>
              <div class="admin-user">${avatarHtml({
                displayName: team.owner_name,
                email: team.owner_email,
                avatarColor: team.owner_avatar_color,
                avatarUrl: team.owner_avatar_url,
              })}<span class="admin-user-copy"><strong>${escapeHtml(team.owner_name)}</strong><span>${escapeHtml(
                team.owner_email
              )}</span></span></div>
              <div class="admin-team-meta">
                <span data-role="team-member-count">${team.member_count} member${team.member_count === 1 ? "" : "s"}</span>
                <span>rev ${team.revision}</span>
                <span>Updated ${escapeHtml(formatTime(team.updated_at))}</span>
              </div>
              <form class="admin-team-rename" data-rename="${escapeHtml(team.id)}" hidden>
                <input class="admin-search" name="name" value="${escapeHtml(team.name)}" maxlength="120" required />
                <button class="ky-button ky-button-primary" type="submit">Save</button>
                <button class="ky-button ky-button-quiet" type="button" data-cancel>Cancel</button>
              </form>
              <div class="admin-members" data-members="${escapeHtml(team.id)}"></div>
            </div>`
              )
              .join("")}</div>`
          : `<div class="admin-empty">No boards yet. Create the first one above.</div>`
      }
    </div>`;

  pane.querySelector('[data-role="team-create"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = event.target.name.value.trim();
    if (!name) return;
    try {
      await api("/api/v1/admin/boards", { method: "POST", body: { name } });
      await renderTeams();
    } catch (error) {
      if (error instanceof AuthError) return showAuth();
      showError(error);
    }
  });

  async function loadMembers(teamId, box) {
    box.textContent = "Loading members...";
    try {
      const data = await api(`/api/v1/admin/boards/${encodeURIComponent(teamId)}/members`);
      const countEl = box.closest(".admin-team")?.querySelector('[data-role="team-member-count"]');
      if (countEl) {
        countEl.textContent = `${data.members.length} member${data.members.length === 1 ? "" : "s"}`;
      }
      const roles = ["editor", "commenter", "viewer"];
      box.innerHTML = `
        <table class="ky-table admin-table"><thead><tr><th>Member</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
          ${data.members
            .map(
              (member) => `<tr>
                <td><div class="admin-user">${avatarHtml(member)}<span class="admin-user-copy"><strong>${escapeHtml(
                  displayName(member)
                )}</strong><span>${escapeHtml(member.email)}</span></span></div></td>
                <td>${
                  member.role === "owner"
                    ? `<span class="admin-role-owner">Owner</span>`
                    : `<select class="admin-select" data-role="member-role" data-member="${escapeHtml(
                        member.id
                      )}" aria-label="Role for ${escapeHtml(member.email)}">${roles
                        .map(
                          (role) =>
                            `<option value="${role}"${role === member.role ? " selected" : ""}>${role}</option>`
                        )
                        .join("")}</select>`
                }</td>
                <td>${escapeHtml(member.status)}</td>
                <td>${
                  member.role === "owner"
                    ? ""
                    : `<button class="ky-button ky-button-quiet admin-danger-text" type="button" data-role="member-remove" data-member="${escapeHtml(
                        member.id
                      )}">Remove</button>`
                }</td>
              </tr>`
            )
            .join("")}
        </tbody></table>
        <form class="admin-member-add admin-toolbar" data-role="member-add">
          <input class="admin-search" name="email" type="email" placeholder="Member email" maxlength="320" required />
          <select class="admin-select" name="role" aria-label="New member role">${roles
            .map((role) => `<option value="${role}">${role}</option>`)
            .join("")}</select>
          <button class="ky-button ky-button-primary" type="submit">Add member</button>
        </form>
        <p class="admin-note" data-role="member-status" role="status"></p>`;
      const status = box.querySelector('[data-role="member-status"]');
      for (const select of box.querySelectorAll('select[data-role="member-role"]')) {
        select.dataset.previous = select.value;
        select.addEventListener("change", async () => {
          const previous = select.dataset.previous;
          try {
            await api(
              `/api/v1/admin/boards/${encodeURIComponent(teamId)}/members/${encodeURIComponent(select.dataset.member)}`,
              { method: "PATCH", body: { role: select.value } }
            );
            select.dataset.previous = select.value;
            status.textContent = "Member role updated.";
          } catch (error) {
            select.value = previous;
            status.textContent = error.message;
          }
        });
      }
      for (const button of box.querySelectorAll('button[data-role="member-remove"]')) {
        button.addEventListener("click", async () => {
          if (button.dataset.confirm !== "1") {
            button.dataset.confirm = "1";
            button.textContent = "Confirm remove";
            setTimeout(() => {
              button.dataset.confirm = "";
              button.textContent = "Remove";
            }, 4000);
            return;
          }
          try {
            await api(
              `/api/v1/admin/boards/${encodeURIComponent(teamId)}/members/${encodeURIComponent(button.dataset.member)}`,
              { method: "DELETE" }
            );
            await loadMembers(teamId, box);
          } catch (error) {
            status.textContent = error.message;
          }
        });
      }
      box.querySelector('[data-role="member-add"]').addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.target;
        const email = String(form.email.value || "").trim();
        if (!email) return;
        try {
          await api(`/api/v1/admin/boards/${encodeURIComponent(teamId)}/members`, {
            method: "POST",
            body: { email, role: form.role.value },
          });
          await loadMembers(teamId, box);
        } catch (error) {
          status.textContent = error.message;
        }
      });
    } catch (error) {
      box.textContent = error.message;
    }
  }

  for (const button of pane.querySelectorAll('button[data-role="members"]')) {
    button.addEventListener("click", async () => {
      const box = pane.querySelector(`[data-members="${CSS.escape(button.dataset.team)}"]`);
      if (box.dataset.open === "1") {
        box.innerHTML = "";
        box.dataset.open = "0";
        return;
      }
      box.dataset.open = "1";
      await loadMembers(button.dataset.team, box);
    });
  }

  for (const button of pane.querySelectorAll('button[data-role="rename"]')) {
    button.addEventListener("click", () => {
      const form = pane.querySelector(`form[data-rename="${CSS.escape(button.dataset.team)}"]`);
      form.hidden = !form.hidden;
      if (!form.hidden) form.querySelector("input").focus();
    });
  }

  for (const form of pane.querySelectorAll("form.admin-team-rename")) {
    form.querySelector("[data-cancel]").addEventListener("click", () => {
      form.hidden = true;
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = event.target.name.value.trim();
      if (!name) return;
      try {
        await api(`/api/v1/admin/boards/${encodeURIComponent(form.dataset.rename)}`, {
          method: "PATCH",
          body: { name },
        });
        await renderTeams();
      } catch (error) {
        showError(error);
      }
    });
  }

  for (const button of pane.querySelectorAll('button[data-role="delete"]')) {
    button.addEventListener("click", async () => {
      if (button.dataset.confirm !== "1") {
        button.dataset.confirm = "1";
        button.textContent = "Confirm delete";
        setTimeout(() => {
          button.dataset.confirm = "";
          button.textContent = "Delete";
        }, 4000);
        return;
      }
      try {
        await api(`/api/v1/admin/boards/${encodeURIComponent(button.dataset.team)}`, { method: "DELETE" });
        await renderTeams();
      } catch (error) {
        showError(error);
      }
    });
  }
}

function activityRows(entries) {
  if (!entries.length) return "";
  return entries
    .map(
      (entry) => `
    <tr>
      <td><div class="admin-user">${avatarHtml({
        displayName: entry.actor_name || entry.actor_email,
        email: entry.actor_email,
        avatarColor: entry.actor_avatar_color,
        avatarUrl: entry.actor_avatar_url,
      })}<span class="admin-user-copy"><strong>${escapeHtml(
        entry.actor_name || entry.actor_email || "System"
      )}</strong><span>${escapeHtml(entry.actor_email || "")}</span></span></div></td>
      <td><span class="admin-activity-action">${escapeHtml(actionLabel(entry.action))}</span></td>
      <td>${escapeHtml(entry.resource_type)}${entry.resource_id ? ` <span class="admin-time">${escapeHtml(entry.resource_id)}</span>` : ""}</td>
      <td class="admin-time">${escapeHtml(formatTime(entry.created_at))}</td>
    </tr>`
    )
    .join("");
}

async function renderActivity({ append = false } = {}) {
  if (!append) {
    activityOffset = 0;
    pane.innerHTML = `
      <div class="ky-section admin-section admin-activity">
        <div class="admin-section-head"><div><h2>Activity</h2><p>All users, newest first.</p></div></div>
        <form class="admin-toolbar" data-role="activity-search">
          <input class="admin-search" name="q" value="${escapeHtml(activityFilter.q)}" placeholder="Search actor, action or resource" />
          <select class="admin-select" name="action">
            ${["", "auth.", "project.", "account.", "admin.", "share."]
              .map(
                (value) =>
                  `<option value="${value}"${activityFilter.action === value ? " selected" : ""}>${
                    value ? value.replace(".", "") : "All actions"
                  }</option>`
              )
              .join("")}
          </select>
          <button class="ky-button ky-button-primary" type="submit">Filter</button>
        </form>
        <div class="admin-activity-scroll" data-role="activity-scroll">
          <div data-role="activity-body"><div class="admin-loading">Loading activity...</div></div>
        </div>
        <div class="admin-actions" data-role="activity-more"></div>
      </div>`;
    pane.querySelector('[data-role="activity-search"]').addEventListener("submit", (event) => {
      event.preventDefault();
      activityFilter = { q: event.target.q.value.trim(), action: event.target.action.value };
      void renderActivity();
    });
  }
  const body = pane.querySelector('[data-role="activity-body"]');
  try {
    const query = new URLSearchParams({
      limit: "100",
      offset: String(activityOffset),
      q: activityFilter.q,
      action: activityFilter.action,
    });
    const data = await api(`/api/v1/admin/activity?${query}`);
    if (!append) {
      if (!data.entries.length) {
        body.innerHTML = `<div class="admin-empty">No activity matches that filter.</div>`;
        return;
      }
      body.innerHTML = `<table class="ky-table admin-table"><thead><tr><th>Actor</th><th>Action</th><th>Resource</th><th>Time</th></tr></thead><tbody data-role="activity-rows">${activityRows(
        data.entries
      )}</tbody></table>`;
    } else {
      body.querySelector('[data-role="activity-rows"]')?.insertAdjacentHTML("beforeend", activityRows(data.entries));
    }
    activityOffset += data.entries.length;
    const more = pane.querySelector('[data-role="activity-more"]');
    more.innerHTML = "";
    if (activityOffset < data.total) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ky-button ky-button-quiet";
      button.textContent = `Load more (${activityOffset} of ${data.total})`;
      button.addEventListener("click", () => void renderActivity({ append: true }));
      more.append(button);
    }
  } catch (error) {
    if (error instanceof AuthError) return showAuth();
    body.innerHTML = `<div class="admin-error">${escapeHtml(error.message)}</div>`;
  }
}

function pageStatus(message) {
  const status = document.querySelector(".admin-page-status");
  if (status) status.textContent = message;
}

async function readAvatarFile(file) {
  if (!file) return "";
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read the image"));
    reader.readAsDataURL(file);
  });
  const image = await new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("That file is not a readable image"));
    element.src = dataUrl;
  });
  const max = 256;
  const ratio = Math.min(1, max / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * ratio));
  canvas.height = Math.max(1, Math.round(image.height * ratio));
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

function avatarPerson(person) {
  return {
    displayName: person.displayName || person.email,
    email: person.email,
    avatarColor: person.avatarColor || person.avatar_color || "",
    avatarUrl: person.avatarUrl || person.avatar_url || "",
  };
}

async function renderProfile() {
  pane.innerHTML = `<div class="admin-loading">Loading profile...</div>`;
  let sessionData;
  let dashboardData;
  let detail;
  try {
    sessionData = await api("/api/v1/auth/sessions");
    dashboardData = await api("/api/v1/admin/dashboard");
    detail = await api(`/api/v1/admin/users/${encodeURIComponent(sessionData.account.id)}`);
  } catch (error) {
    if (error instanceof AuthError) return showAuth();
    pane.innerHTML = "";
    return showError(error);
  }
  dashboard = dashboardData;
  renderIdentity(dashboard.admin);
  const account = detail.user;
  const avatar = avatarPerson(account);
  let avatarData = avatar.avatarUrl;
  pane.innerHTML = `
    <div class="ky-section admin-section">
      <div class="admin-section-head"><div><h2>Profile</h2><p>The account and public identity used by this dashboard.</p></div></div>
      <form data-role="profile-form" class="admin-profile-form">
        <div class="admin-profile-avatar">
          <div data-role="profile-avatar">${avatarHtml(avatar)}</div>
          <label class="ky-button ky-button-quiet admin-file-button">
            Change picture
            <input type="file" accept="image/png,image/jpeg,image/webp" data-role="avatar-file" hidden />
          </label>
          <button class="ky-button ky-button-quiet" type="button" data-role="avatar-clear"${avatarData ? "" : " disabled"}>Remove picture</button>
        </div>
        <div class="admin-form-grid admin-profile-grid">
          <label class="admin-field"><span>Display name</span><input class="admin-search" name="displayName" maxlength="120" value="${escapeHtml(account.displayName || "")}" required /></label>
          <label class="admin-field"><span>First name</span><input class="admin-search" name="firstName" maxlength="80" value="${escapeHtml(account.firstName || "")}" /></label>
          <label class="admin-field"><span>Last name</span><input class="admin-search" name="lastName" maxlength="80" value="${escapeHtml(account.lastName || "")}" /></label>
          <label class="admin-field"><span>Avatar colour</span><input class="admin-color-input" name="avatarColor" type="color" value="${escapeHtml(account.avatarColor || "#8b5cf6")}" /></label>
        </div>
        <div class="admin-actions admin-actions-spaced">
          <button class="ky-button ky-button-primary" type="submit">Save profile</button>
          <span class="admin-note admin-page-status" role="status"></span>
        </div>
      </form>
      <div class="admin-detail-grid admin-profile-meta">
        <div><span>Email</span>${escapeHtml(account.email)}</div>
        <div><span>Role</span>${escapeHtml(account.role)}</div>
        <div><span>Account ID</span><code>${escapeHtml(account.id)}</code></div>
        <div><span>Created</span>${escapeHtml(formatTime(account.createdAt))}</div>
        <div><span>Last active</span>${escapeHtml(formatTime(account.lastSeenAt))}</div>
      </div>
    </div>`;

  const form = pane.querySelector('[data-role="profile-form"]');
  const avatarBox = pane.querySelector('[data-role="profile-avatar"]');
  const clearButton = pane.querySelector('[data-role="avatar-clear"]');
  const paintAvatar = () => {
    avatarBox.innerHTML = avatarHtml({ ...avatar, displayName: form.displayName.value || avatar.displayName, avatarUrl: avatarData });
    clearButton.disabled = !avatarData;
  };
  form.displayName.addEventListener("input", paintAvatar);
  form.avatarColor.addEventListener("input", () => {
    avatar.avatarColor = form.avatarColor.value;
    paintAvatar();
  });
  form.querySelector('[data-role="avatar-file"]').addEventListener("change", async (event) => {
    try {
      const file = event.target.files?.[0];
      if (!file) return;
      avatarData = await readAvatarFile(file);
      paintAvatar();
      pageStatus("Picture ready. Save the profile to apply it.");
    } catch (error) {
      pageStatus(error.message);
    }
  });
  clearButton.addEventListener("click", () => {
    avatarData = "";
    paintAvatar();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api(`/api/v1/admin/users/${encodeURIComponent(account.id)}`, {
        method: "PATCH",
        body: {
          displayName: form.displayName.value.trim(),
          firstName: form.firstName.value.trim(),
          lastName: form.lastName.value.trim(),
          avatarColor: form.avatarColor.value,
          avatarUrl: avatarData,
        },
      });
      dashboard = await api("/api/v1/admin/dashboard");
      renderIdentity(dashboard.admin);
      pageStatus("Profile saved.");
    } catch (error) {
      if (error instanceof AuthError) return showAuth();
      pageStatus(error.message);
    }
  });
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  const padded = String(value).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(value).length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function passkeyCreationOptions(options) {
  return {
    ...options,
    challenge: base64UrlToBytes(options.challenge),
    user: { ...options.user, id: base64UrlToBytes(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((entry) => ({
      ...entry,
      id: base64UrlToBytes(entry.id),
    })),
  };
}

function serializePasskey(credential) {
  return {
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bytesToBase64Url(credential.response.clientDataJSON),
      attestationObject: bytesToBase64Url(credential.response.attestationObject),
      transports: credential.response.getTransports ? credential.response.getTransports() : [],
    },
    clientExtensionResults: credential.getClientExtensionResults
      ? credential.getClientExtensionResults()
      : {},
  };
}

async function loadPasskeyList() {
  const list = pane.querySelector('[data-role="passkey-list"]');
  if (!list) return;
  try {
    const data = await api("/api/v1/auth/passkeys");
    const passkeys = (data.passkeys || []).filter((passkey) => !passkey.revoked);
    list.innerHTML = passkeys.length
      ? passkeys
          .map(
            (passkey) => `<li class="admin-passkey">
              <div><strong>${escapeHtml(passkey.name || "Passkey")}</strong><span>${escapeHtml(
                passkey.deviceType || "device"
              )} · created ${escapeHtml(formatTime(passkey.createdAt))}</span></div>
              <button class="ky-button ky-button-quiet admin-danger-text" type="button" data-role="passkey-delete" data-id="${escapeHtml(
                passkey.id
              )}">Remove</button>
            </li>`
          )
          .join("")
      : `<li class="admin-note">No passkeys registered.</li>`;
    for (const button of list.querySelectorAll('[data-role="passkey-delete"]')) {
      button.addEventListener("click", async () => {
        if (button.dataset.confirm !== "1") {
          button.dataset.confirm = "1";
          button.textContent = "Confirm remove";
          return;
        }
        try {
          await api(`/api/v1/auth/passkeys/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" });
          await loadPasskeyList();
          pageStatus("Passkey removed.");
        } catch (error) {
          pageStatus(error.message);
          button.dataset.confirm = "";
          button.textContent = "Remove";
        }
      });
    }
  } catch (error) {
    list.textContent = error.message;
  }
}

async function renderSecurity() {
  pane.innerHTML = `<div class="admin-loading">Loading security...</div>`;
  let tokensData;
  let features = { passkeysEnabled: true };
  try {
    [tokensData, features] = await Promise.all([
      api("/api/v1/account/tokens"),
      api("/api/v1/auth/features").catch(() => ({ passkeysEnabled: true })),
    ]);
  } catch (error) {
    if (error instanceof AuthError) return showAuth();
    pane.innerHTML = "";
    return showError(error);
  }
  const tokens = (tokensData.tokens || []).filter((token) => !token.revoked);
  pane.innerHTML = `
    <div class="ky-section admin-section">
      <div class="admin-section-head"><div><h2>Password</h2><p>Changing it signs out every other session.</p></div></div>
      <form data-role="password-form" novalidate>
        <div class="admin-form-grid">
          <label class="admin-field"><span>Current password</span><input class="admin-search" name="currentPassword" type="password" autocomplete="current-password" /></label>
          <label class="admin-field"><span>New password</span><input class="admin-search" name="newPassword" type="password" autocomplete="new-password" /></label>
          <label class="admin-field"><span>Confirm new password</span><input class="admin-search" name="confirmPassword" type="password" autocomplete="new-password" /></label>
        </div>
        <div class="admin-actions admin-actions-spaced">
          <button class="ky-button ky-button-primary" type="submit">Update password</button>
          <span class="admin-note admin-page-status" role="status"></span>
        </div>
      </form>
    </div>

    <div class="ky-section admin-section">
      <div class="admin-section-head"><div><h2>Two-factor authentication</h2><p>Add an authenticator app as a second sign-in step.</p></div></div>
      <p class="admin-note" data-role="totp-status">Checking...</p>
      <div data-role="totp-setup" hidden>
        <p class="admin-note">Scan this code with an authenticator app, or enter the secret manually.</p>
        <div class="admin-totp-qr" data-role="totp-qr" aria-label="Authenticator QR code"></div>
        <div class="admin-form-grid">
          <label class="admin-field"><span>Secret</span><input class="admin-search" data-role="totp-secret" readonly /></label>
          <label class="admin-field"><span>6-digit code</span><input class="admin-search" data-role="totp-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" /></label>
        </div>
        <div class="admin-actions admin-actions-spaced">
          <button class="ky-button ky-button-primary" type="button" data-role="totp-enable">Enable 2FA</button>
          <button class="ky-button ky-button-quiet" type="button" data-role="totp-cancel">Cancel</button>
        </div>
      </div>
      <div data-role="totp-enabled" hidden>
        <p class="admin-note">Authenticator app is enabled. Keep a backup device and recovery plan.</p>
        <button class="ky-button ky-button-danger" type="button" data-role="totp-disable-start">Disable 2FA</button>
      </div>
      <div data-role="totp-disable" hidden>
        <div class="admin-form-grid">
          <label class="admin-field"><span>Password</span><input class="admin-search" data-role="totp-disable-password" type="password" autocomplete="current-password" /></label>
          <label class="admin-field"><span>6-digit code</span><input class="admin-search" data-role="totp-disable-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" /></label>
        </div>
        <div class="admin-actions admin-actions-spaced">
          <button class="ky-button ky-button-danger" type="button" data-role="totp-disable-confirm">Disable 2FA</button>
          <button class="ky-button ky-button-quiet" type="button" data-role="totp-disable-cancel">Cancel</button>
        </div>
      </div>
      <button class="ky-button ky-button-primary" type="button" data-role="totp-setup-start">Set up authenticator</button>
    </div>

    <div class="ky-section admin-section">
      <div class="admin-section-head"><div><h2>Passkeys</h2><p>${
        features.passkeysEnabled
          ? "Register a device credential for passwordless sign-in."
          : "Temporarily disabled by the service operator."
      }</p></div></div>
      ${
        features.passkeysEnabled
          ? `<p class="admin-note" data-role="passkey-readiness"></p>
             <button class="ky-button ky-button-primary" type="button" data-role="passkey-register">Register a passkey</button>
             <ul class="admin-passkey-list" data-role="passkey-list"></ul>`
          : `<p class="admin-note">Passkey registration and passkey sign-in are switched off for now. Password, authenticator 2FA and backup codes remain available.</p>`
      }
    </div>

    <div class="ky-section admin-section">
      <div class="admin-section-head"><div><h2>Backup codes</h2><p>One-time codes for signing in when your passkey is unavailable. Each code works once.</p></div></div>
      <p class="admin-note" data-role="recovery-status">Checking backup codes...</p>
      <div class="admin-actions admin-actions-spaced">
        <button class="ky-button ky-button-quiet" type="button" data-role="recovery-generate">Generate new backup codes</button>
      </div>
      <div class="admin-backup-codes" data-role="recovery-codes" hidden>
        <p class="admin-note">Save these codes somewhere safe. They are shown only once.</p>
        <ol data-role="recovery-list"></ol>
        <div class="admin-actions">
          <button class="ky-button ky-button-quiet" type="button" data-role="recovery-copy">Copy codes</button>
          <button class="ky-button ky-button-quiet" type="button" data-role="recovery-download">Download .txt</button>
        </div>
      </div>
    </div>

    <div class="ky-section admin-section">
      <div class="admin-section-head"><div><h2>API tokens</h2><p>Scoped tokens for desktop sync.</p></div></div>
      <form class="admin-toolbar" data-role="token-form">
        <input class="admin-search" name="name" value="Desktop sync" maxlength="80" />
        <button class="ky-button ky-button-primary" type="submit">Create token</button>
      </form>
      <p class="admin-note" data-role="token-result"></p>
      ${
        tokens.length
          ? `<table class="ky-table admin-table"><thead><tr><th>Name</th><th>Scopes</th><th>Expires</th><th></th></tr></thead><tbody>${tokens
              .map(
                (token) => `<tr>
                  <td>${escapeHtml(token.name)}</td>
                  <td class="admin-time">${escapeHtml((token.scopes || []).join(", "))}</td>
                  <td class="admin-time">${token.expiresAt ? escapeHtml(formatTime(token.expiresAt)) : "Never"}</td>
                  <td><button class="admin-danger-button" type="button" data-role="revoke-token" data-id="${escapeHtml(
                    token.id
                  )}">Revoke</button></td>
                </tr>`
              )
              .join("")}</tbody></table>`
          : `<div class="admin-empty">No API tokens.</div>`
      }
    </div>`;

  const passwordForm = pane.querySelector('[data-role="password-form"]');
  passwordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = passwordForm.newPassword.value;
    if (!passwordForm.currentPassword.value) return pageStatus("Enter your current password.");
    if (password.length < 12) return pageStatus("Use at least 12 characters.");
    if (password !== passwordForm.confirmPassword.value) return pageStatus("The new passwords do not match.");
    try {
      await api("/api/v1/account/password", {
        method: "POST",
        body: { currentPassword: passwordForm.currentPassword.value, newPassword: password },
      });
      passwordForm.reset();
      pageStatus("Password updated. Other sessions were signed out.");
    } catch (error) {
      pageStatus(error.message);
    }
  });

  const totpStatus = pane.querySelector('[data-role="totp-status"]');
  const totpSetup = pane.querySelector('[data-role="totp-setup"]');
  const totpEnabled = pane.querySelector('[data-role="totp-enabled"]');
  const totpDisable = pane.querySelector('[data-role="totp-disable"]');
  const totpStart = pane.querySelector('[data-role="totp-setup-start"]');
  const paintTotp = (enabled) => {
    totpStatus.textContent = enabled
      ? "Enabled with an authenticator app."
      : "Not enabled. Add an authenticator app for a second sign-in step.";
    totpStart.hidden = enabled;
    totpEnabled.hidden = !enabled;
    totpSetup.hidden = true;
    totpDisable.hidden = true;
  };
  try {
    const status = await api("/api/v1/auth/totp");
    paintTotp(status.enabled);
  } catch {
    totpStatus.textContent = "2FA status unavailable.";
  }
  totpStart.addEventListener("click", async () => {
    try {
      const data = await api("/api/v1/auth/totp/setup", { method: "POST", body: {} });
      pane.querySelector('[data-role="totp-secret"]').value = data.secret;
      pane.querySelector('[data-role="totp-code"]').value = "";
      const qr = pane.querySelector('[data-role="totp-qr"]');
      qr.textContent = "";
      if (window.qrcode) {
        const code = window.qrcode(0, "M");
        code.addData(data.uri);
        code.make();
        qr.innerHTML = code.createSvgTag(4, 2);
      } else {
        qr.textContent = "QR preview unavailable. Enter the secret manually.";
      }
      totpSetup.hidden = false;
      totpStart.hidden = true;
      totpEnabled.hidden = true;
      pageStatus("Scan the code, then confirm with a 6-digit code.");
    } catch (error) {
      pageStatus(error.message);
    }
  });
  pane.querySelector('[data-role="totp-enable"]').addEventListener("click", async () => {
    const code = pane.querySelector('[data-role="totp-code"]').value.trim();
    if (!/^\d{6}$/.test(code)) return pageStatus("Enter the 6-digit code from the authenticator app.");
    try {
      await api("/api/v1/auth/totp/enable", { method: "POST", body: { code } });
      paintTotp(true);
      pageStatus("Two-factor authentication enabled.");
    } catch (error) {
      pageStatus(error.message);
    }
  });
  pane.querySelector('[data-role="totp-cancel"]').addEventListener("click", () => paintTotp(false));
  pane.querySelector('[data-role="totp-disable-start"]').addEventListener("click", () => {
    totpDisable.hidden = false;
    totpEnabled.hidden = true;
  });
  pane.querySelector('[data-role="totp-disable-cancel"]').addEventListener("click", () => paintTotp(true));
  pane.querySelector('[data-role="totp-disable-confirm"]').addEventListener("click", async () => {
    const password = pane.querySelector('[data-role="totp-disable-password"]').value;
    const code = pane.querySelector('[data-role="totp-disable-code"]').value.trim();
    if (!password) return pageStatus("Enter your password.");
    if (!/^\d{6}$/.test(code)) return pageStatus("Enter the current 6-digit code.");
    try {
      await api("/api/v1/auth/totp/disable", { method: "POST", body: { password, code } });
      paintTotp(false);
      pageStatus("Two-factor authentication disabled.");
    } catch (error) {
      pageStatus(error.message);
    }
  });

  const passkeyReadiness = pane.querySelector('[data-role="passkey-readiness"]');
  const passkeyButton = pane.querySelector('[data-role="passkey-register"]');
  if (passkeyButton && (!window.PublicKeyCredential || !window.isSecureContext)) {
    passkeyButton.disabled = true;
    passkeyReadiness.textContent = "Passkeys need a secure context (localhost or HTTPS) and WebAuthn support.";
  } else if (passkeyButton) {
    passkeyReadiness.textContent = "Passkeys are available on this device.";
  }
  passkeyButton?.addEventListener("click", async () => {
    passkeyButton.disabled = true;
    try {
      const { options } = await api("/api/v1/auth/passkeys/register/options", { method: "POST", body: {} });
      const credential = await navigator.credentials.create({ publicKey: passkeyCreationOptions(options) });
      await api("/api/v1/auth/passkeys/register/verify", {
        method: "POST",
        body: { response: serializePasskey(credential), name: "Admin dashboard" },
      });
      await loadPasskeyList();
      await generateRecoveryCodes();
      pageStatus("Passkey registered. Save the backup codes below.");
    } catch (error) {
      pageStatus(error.message || "Passkey registration was cancelled.");
    } finally {
      passkeyButton.disabled = false;
    }
  });
  if (passkeyButton) await loadPasskeyList();

  const recoveryStatus = pane.querySelector('[data-role="recovery-status"]');
  const recoveryBox = pane.querySelector('[data-role="recovery-codes"]');
  const recoveryList = pane.querySelector('[data-role="recovery-list"]');
  let recoveryCodes = [];
  const refreshRecoveryStatus = async () => {
    try {
      const data = await api("/api/v1/auth/recovery-codes");
      recoveryStatus.textContent = data.remaining
        ? `${data.remaining} unused backup code${data.remaining === 1 ? "" : "s"}.`
        : "No unused backup codes. Generate a new set.";
    } catch {
      recoveryStatus.textContent = "Backup code status unavailable.";
    }
  };
  const showRecoveryCodes = (codes) => {
    recoveryCodes = codes;
    recoveryList.innerHTML = codes.map((code) => `<li><code>${escapeHtml(code)}</code></li>`).join("");
    recoveryBox.hidden = false;
    refreshRecoveryStatus();
  };
  const generateRecoveryCodes = async () => {
    try {
      const data = await api("/api/v1/auth/recovery-codes", { method: "POST", body: {} });
      showRecoveryCodes(data.codes || []);
      pageStatus("Backup codes generated. Save them now.");
    } catch (error) {
      pageStatus(error.message);
    }
  };
  pane.querySelector('[data-role="recovery-generate"]').addEventListener("click", generateRecoveryCodes);
  pane.querySelector('[data-role="recovery-copy"]').addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join("\n"));
      pageStatus("Backup codes copied.");
    } catch {
      pageStatus("Could not copy the backup codes.");
    }
  });
  pane.querySelector('[data-role="recovery-download"]').addEventListener("click", () => {
    const blob = new Blob(
      [`Khaoyu Note backup codes for ${dashboard?.admin?.email || "this account"}\nEach code works once.\n\n${recoveryCodes.join("\n")}\n`],
      { type: "text/plain" }
    );
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "khaoyu-note-backup-codes.txt";
    link.click();
    URL.revokeObjectURL(link.href);
  });
  await refreshRecoveryStatus();

  pane.querySelector('[data-role="token-form"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const created = await api("/api/v1/account/tokens", {
        method: "POST",
        body: {
          name: event.target.name.value.trim() || "Desktop sync",
          scopes: ["projects:read", "projects:write"],
          expiresInDays: 365,
        },
      });
      await renderSecurity();
      pane.querySelector('[data-role="token-result"]').textContent = `Copy this token now: ${created.token}`;
    } catch (error) {
      showError(error);
    }
  });
  for (const button of pane.querySelectorAll('[data-role="revoke-token"]')) {
    button.addEventListener("click", async () => {
      try {
        await api(`/api/v1/account/tokens/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" });
        await renderSecurity();
      } catch (error) {
        showError(error);
      }
    });
  }
}

async function renderSessions() {
  pane.innerHTML = `<div class="admin-loading">Loading sessions...</div>`;
  let sessionData;
  try {
    sessionData = await api("/api/v1/auth/sessions");
  } catch (error) {
    if (error instanceof AuthError) return showAuth();
    pane.innerHTML = "";
    return showError(error);
  }
  const sessions = (sessionData.sessions || []).filter((entry) => !entry.revoked);
  pane.innerHTML = `
    <div class="ky-section admin-section">
      <div class="admin-section-head"><div><h2>Login sessions</h2><p>${sessions.length} active session${
        sessions.length === 1 ? "" : "s"
      }. Revoking a session signs that device out.</p></div></div>
      ${
        sessions.length
          ? `<table class="ky-table admin-table"><thead><tr><th>Device</th><th>Created</th><th>Last seen</th><th></th></tr></thead><tbody>${sessions
              .map(
                (session) => `<tr>
                  <td>${escapeHtml(session.device)}${session.current ? ' <span class="admin-badge is-active">Current</span>' : ""}</td>
                  <td class="admin-time">${escapeHtml(formatTime(session.createdAt))}</td>
                  <td class="admin-time">${escapeHtml(formatTime(session.lastSeenAt))}</td>
                  <td><button class="admin-danger-button" type="button" data-role="revoke-session" data-id="${escapeHtml(
                    session.id
                  )}"${session.current ? " disabled" : ""}>Revoke</button></td>
                </tr>`
              )
              .join("")}</tbody></table>`
          : `<div class="admin-empty">No active sessions.</div>`
      }
      <div class="admin-actions admin-actions-spaced">
        <button class="ky-button" type="button" data-role="logout">Sign out</button>
        <button class="ky-button ky-button-quiet" type="button" data-role="logout-all">Sign out everywhere</button>
        <span class="admin-note admin-page-status" role="status"></span>
      </div>
    </div>`;
  for (const button of pane.querySelectorAll('[data-role="revoke-session"]')) {
    button.addEventListener("click", async () => {
      try {
        await api(`/api/v1/auth/sessions/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" });
        await renderSessions();
      } catch (error) {
        if (error instanceof AuthError) return showAuth();
        showError(error);
      }
    });
  }
  pane.querySelector('[data-role="logout"]').addEventListener("click", async () => {
    await api("/api/v1/auth/logout", { method: "POST" });
    window.location.replace("/login?signedout=1");
  });
  pane.querySelector('[data-role="logout-all"]').addEventListener("click", async () => {
    await api("/api/v1/auth/logout-all", { method: "POST" });
    window.location.replace("/login?signedout=1");
  });
}

// ---------------------------------------------------------------- sharing
// The old /shares page is merged into the dashboard: the same forms render inside the admin shell.

let sharingProject = null;
let sharingDoc = null;

function sharingStatus(message) {
  const status = document.getElementById("status");
  if (status) status.textContent = message;
}

function renderSharingPublicState() {
  const enabled = Boolean(sharingProject?.publicSharingEnabled);
  const state = document.getElementById("public-state");
  if (!state) return;
  state.textContent = enabled
    ? "Public sharing is enabled. Anyone with a link can access the selected scope."
    : "Public sharing is disabled. Create links only after enabling it.";
  document.getElementById("enable-box").hidden = enabled;
  document.getElementById("disable-box").hidden = !enabled;
}

function setSharingTargets() {
  const scope = document.getElementById("scope").value;
  const wrap = document.getElementById("target-wrap");
  wrap.hidden = scope === "project";
  const select = document.getElementById("target");
  select.textContent = "";
  const cards = (sharingDoc?.cards || []).filter((card) =>
    scope === "column" ? card.type === "column" : true
  );
  for (const card of cards) {
    const option = document.createElement("option");
    option.value = card.id;
    option.textContent = `${card.type || "card"} · ${card.text || card.title || card.id}`.slice(0, 80);
    select.append(option);
  }
}

async function loadSharingLinks() {
  const data = await api(`/api/v1/projects/${sharingProject.id}/shares`);
  renderSharingLinks(data.shares);
}

function renderSharingLinks(shares) {
  const list = document.getElementById("shares");
  list.textContent = "";
  const visible = shares.filter((entry) => !entry.revoked);
  for (const share of visible) {
    const item = document.createElement("li");
    item.className = "admin-share-row";
    const label = document.createElement("span");
    const expiry = share.expiresAt ? new Date(share.expiresAt).toLocaleDateString() : "no expiry";
    const flags = [share.downloadAllowed ? "downloads" : "no downloads"];
    if (share.watermark) flags.push("watermark");
    if (share.downloadLimit !== null && share.downloadLimit !== undefined) {
      flags.push(`downloads ${share.downloadCount || 0}/${share.downloadLimit}`);
    }
    label.textContent = `${share.scope}${share.targetId ? " · " + share.targetId : ""} · ${
      share.permission
    } · ${expiry} · ${flags.join(" · ")}`;
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "ky-button ky-button-danger";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", async () => {
      try {
        await api(`/api/v1/projects/${sharingProject.id}/shares/${encodeURIComponent(share.id)}`, {
          method: "DELETE",
        });
        sharingStatus("Share link revoked.");
        await loadSharingLinks();
      } catch (error) {
        sharingStatus(error.message);
      }
    });
    item.append(label, revoke);
    list.append(item);
  }
  if (!visible.length) list.textContent = "No share links.";
}

async function loadSharingProject({ acknowledge = false } = {}) {
  const projectId = document.getElementById("project").value;
  const data = await api(`/api/v1/projects/${encodeURIComponent(projectId)}`);
  sharingProject = data.project;
  try {
    sharingDoc = JSON.parse(data.snapshot?.doc || "{}");
  } catch {
    sharingDoc = { cards: [] };
  }
  document.getElementById("sharing-content").hidden = false;
  if (acknowledge) document.getElementById("acknowledge").checked = false;
  renderSharingPublicState();
  setSharingTargets();
  await loadSharingLinks();
}

async function renderSharing() {
  pane.innerHTML = `<div class="admin-loading">Loading sharing...</div>`;
  let data;
  try {
    data = await api("/api/v1/projects");
  } catch (error) {
    if (error instanceof AuthError) return showAuth();
    pane.innerHTML = "";
    return showError(error);
  }
  pane.innerHTML = `
    <div class="ky-section admin-section">
      <div class="admin-section-head">
        <div><h2>Sharing</h2><p>Share a whole project, one card, or a column. Public sharing is off by default and every link is scoped.</p></div>
        <button class="ky-button ky-button-quiet" id="refresh" type="button">Refresh</button>
      </div>
      <label class="admin-field"><span>Project</span><select class="admin-select" id="project"></select></label>
    </div>

    <div id="sharing-content" hidden>
      <div class="ky-section admin-section">
        <div class="admin-section-head"><div><h2>Public sharing</h2><p id="public-state" class="admin-note"></p></div></div>
        <div id="enable-box">
          <div class="admin-warning">
            Enabling public sharing allows anyone with a link to view the selected scope. Search engines are excluded, but a copied link is a bearer secret. Do not enable this for private material.
          </div>
          <label class="admin-check"><input id="acknowledge" type="checkbox" /> I understand that share links can be forwarded and accessed by anyone who has them.</label>
          <div class="admin-actions">
            <button class="ky-button ky-button-primary" id="enable-sharing" type="button">Enable public sharing</button>
          </div>
        </div>
        <div id="disable-box" hidden>
          <div class="admin-actions">
            <button id="disable-sharing" type="button" class="ky-button ky-button-danger">Disable and revoke all links</button>
          </div>
        </div>
      </div>

      <div class="ky-section admin-section">
        <div class="admin-section-head"><div><h2>Create a link</h2><p>The raw token is shown once; copy it before leaving this page.</p></div></div>
        <div class="admin-share-form">
          <label class="admin-field"><span>Scope</span>
            <select class="admin-search" id="scope">
              <option value="project">Whole project</option>
              <option value="item">One card</option>
              <option value="column">Column and children</option>
            </select>
          </label>
          <label class="admin-field" id="target-wrap" hidden><span>Target</span><select class="admin-search" id="target"></select></label>
          <label class="admin-field"><span>Permission</span>
            <select class="admin-search" id="permission">
              <option value="view">View</option>
              <option value="comment">Comment</option>
              <option value="edit">Edit</option>
              <option value="manage">Manage</option>
            </select>
          </label>
        </div>
        <div class="admin-form-grid">
          <label class="admin-field"><span>Expiry days</span><input class="admin-search" id="expiry" type="number" min="1" max="365" placeholder="Never" /></label>
          <label class="admin-field"><span>Passphrase</span><input class="admin-search" id="password" type="password" autocomplete="new-password" /></label>
          <label class="admin-field"><span>Downloads</span><label class="admin-check"><input id="download" type="checkbox" /> Allow asset downloads</label></label>
          <label class="admin-field"><span>Max downloads</span><input class="admin-search" id="download-limit" type="number" min="1" max="10000" placeholder="Unlimited" /></label>
          <label class="admin-field"><span>Watermark</span><label class="admin-check"><input id="watermark" type="checkbox" /> Overlay a watermark on the shared view</label></label>
        </div>
        <div class="admin-actions admin-actions-spaced">
          <button class="ky-button ky-button-primary" id="create" type="button">Create share link</button>
        </div>
        <p id="token" class="admin-share-token"></p>
      </div>

      <div class="ky-section admin-section">
        <div class="admin-section-head"><div><h2>Existing links</h2><p>Every link is scoped to the selected project or target.</p></div></div>
        <ul id="shares" class="admin-share-list"></ul>
      </div>
    </div>
    <p id="status" class="admin-note" role="status"></p>`;

  const projectSelect = document.getElementById("project");
  for (const project of data.projects || []) {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.name;
    projectSelect.append(option);
  }
  if (!data.projects?.length) {
    sharingStatus("Create a project in the app before sharing.");
  }

  projectSelect.addEventListener("change", async () => {
    try {
      await loadSharingProject();
    } catch (error) {
      sharingStatus(error.message);
    }
  });
  document.getElementById("refresh").addEventListener("click", async () => {
    // Rebuild the project list as well: a project may have been created elsewhere since the load.
    await renderSharing();
  });
  document.getElementById("scope").addEventListener("change", setSharingTargets);
  document.getElementById("enable-sharing").addEventListener("click", async () => {
    if (!document.getElementById("acknowledge").checked) {
      sharingStatus("Tick the acknowledgement before enabling public sharing.");
      return;
    }
    try {
      await api(`/api/v1/projects/${sharingProject.id}/public-sharing`, {
        method: "POST",
        body: { enabled: true, acknowledge: true },
      });
      sharingStatus("Public sharing enabled.");
      await loadSharingProject({ acknowledge: true });
    } catch (error) {
      sharingStatus(error.message);
    }
  });
  document.getElementById("disable-sharing").addEventListener("click", async () => {
    try {
      await api(`/api/v1/projects/${sharingProject.id}/public-sharing`, {
        method: "POST",
        body: { enabled: false },
      });
      sharingStatus("Public sharing disabled and existing links revoked.");
      await loadSharingProject({ acknowledge: true });
    } catch (error) {
      sharingStatus(error.message);
    }
  });
  document.getElementById("create").addEventListener("click", async () => {
    try {
      const scope = document.getElementById("scope").value;
      const downloadAllowed = document.getElementById("download").checked;
      const limitValue = document.getElementById("download-limit").value;
      if (limitValue && !downloadAllowed) {
        sharingStatus("Enable asset downloads before setting a download limit.");
        return;
      }
      const body = {
        scope,
        permission: document.getElementById("permission").value,
        downloadAllowed,
        watermark: document.getElementById("watermark").checked,
      };
      if (limitValue) body.downloadLimit = Number(limitValue);
      if (scope !== "project") body.targetId = document.getElementById("target").value;
      if (document.getElementById("expiry").value) {
        body.expiresInDays = Number(document.getElementById("expiry").value);
      }
      if (document.getElementById("password").value) {
        body.password = document.getElementById("password").value;
      }
      const created = await api(`/api/v1/projects/${sharingProject.id}/shares`, {
        method: "POST",
        body,
      });
      document.getElementById("token").textContent = `Copy this link token now: ${created.token}`;
      document.getElementById("password").value = "";
      sharingStatus("Share link created.");
      await loadSharingLinks();
    } catch (error) {
      sharingStatus(error.message);
    }
  });

  if (!data.projects?.length) return;
  try {
    await loadSharingProject();
  } catch (error) {
    sharingStatus(error.message);
  }
}

// ---------------------------------------------------------------- menus and commands

const COMMANDS = [
  { id: "overview", label: "Go to Overview", hint: "Dashboard", run: () => void go("overview") },
  { id: "accounts", label: "Go to Accounts", hint: "Dashboard", run: () => void go("accounts") },
  { id: "boards", label: "Go to Boards", hint: "Dashboard", run: () => void go("boards") },
  { id: "activity", label: "Go to Activity", hint: "Dashboard", run: () => void go("activity") },
  { id: "sharing", label: "Go to Sharing", hint: "Dashboard", run: () => void go("sharing") },
  { id: "profile", label: "Open Profile", hint: "Account Management", run: () => void go("profile") },
  { id: "security", label: "Open Security", hint: "Account Management", run: () => void go("security") },
  { id: "sessions", label: "Open Login sessions", hint: "Account Management", run: () => void go("sessions") },
  { id: "theme", label: "Toggle light or dark theme", hint: "View", run: () => toggleTheme() },
  { id: "help", label: "Open help", hint: "Help", run: () => openHelp() },
  { id: "logout", label: "Log out of the service", hint: "Account", run: () => void logout() },
];

let commandMatches = COMMANDS;
let commandIndex = 0;

function setAccountMenu(open) {
  accountMenu.hidden = !open;
  identity.setAttribute("aria-expanded", String(open));
}

function closeAccountMenu() {
  setAccountMenu(false);
}

function openHelp() {
  closeAccountMenu();
  closeCommandPalette();
  helpLayer.hidden = false;
}

function closeHelp() {
  helpLayer.hidden = true;
}

function toggleTheme() {
  setTheme(nextTheme(document.documentElement.dataset.kyTheme));
}

async function logout() {
  closeAccountMenu();
  closeCommandPalette();
  closeHelp();
  try {
    await api("/api/v1/auth/logout", { method: "POST" });
  } catch {
    /* clearing the session is best effort; the login page still opens */
  }
  window.location.replace("/login?signedout=1");
}

function runAccountAction(action) {
  closeAccountMenu();
  if (action === "dashboard") return void go("overview");
  if (action === "account") return void go("profile");
  if (action === "help") return openHelp();
  if (action === "logout") return void logout();
}

function setActiveCommand(index) {
  const items = [...commandList.querySelectorAll(".admin-command-item")];
  if (!items.length) return;
  commandIndex = (index + items.length) % items.length;
  items.forEach((item, itemIndex) => item.classList.toggle("is-active", itemIndex === commandIndex));
}

function renderCommands(query = "") {
  const search = query.trim().toLowerCase();
  commandMatches = COMMANDS.filter((command) => command.label.toLowerCase().includes(search));
  commandIndex = 0;
  commandList.textContent = "";
  for (const command of commandMatches) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "admin-command-item";
    item.setAttribute("role", "option");
    item.dataset.id = command.id;
    item.innerHTML = `<span>${escapeHtml(command.label)}</span><span>${escapeHtml(command.hint)}</span>`;
    item.addEventListener("click", () => runCommand(command.id));
    commandList.append(item);
  }
  if (!commandMatches.length) {
    const empty = document.createElement("div");
    empty.className = "admin-command-item";
    empty.textContent = "No matching commands.";
    commandList.append(empty);
  }
  setActiveCommand(0);
}

function openCommandPalette() {
  closeAccountMenu();
  closeHelp();
  commandLayer.hidden = false;
  commandInput.value = "";
  renderCommands("");
  commandInput.focus();
}

function closeCommandPalette() {
  commandLayer.hidden = true;
}

function runCommand(id) {
  const command = COMMANDS.find((entry) => entry.id === id);
  closeCommandPalette();
  if (command) command.run();
}

const PAGE_TITLES = {
  overview: "Overview",
  accounts: "Accounts",
  boards: "Boards",
  activity: "Activity",
  sharing: "Sharing",
  profile: "Profile",
  security: "Security",
  sessions: "Login sessions",
};

async function go(next) {
  if (!PAGE_TITLES[next]) next = "overview";
  page = next;
  for (const item of navItems) item.classList.toggle("is-active", item.dataset.page === next);
  title.textContent = PAGE_TITLES[next];
  try {
    window.history.replaceState(null, "", next === "overview" ? "/admin" : `/admin#${next}`);
  } catch {
    /* the address bar is optional */
  }
  if (next === "overview") {
    try {
      dashboard = await api("/api/v1/admin/dashboard");
      renderIdentity(dashboard.admin);
      renderOverview();
    } catch (error) {
      if (error instanceof AuthError) return showAuth();
      showError(error);
    }
    return;
  }
  if (next === "accounts") return renderAccounts();
  if (next === "boards") return renderTeams();
  if (next === "sharing") return renderSharing();
  if (next === "profile") return renderProfile();
  if (next === "security") return renderSecurity();
  if (next === "sessions") return renderSessions();
  return renderActivity();
}

function init() {
  initTheme();
  if (hostBadge) hostBadge.textContent = window.location.host;
  for (const item of navItems) item.addEventListener("click", () => void go(item.dataset.page));

  document.getElementById("admin-home").addEventListener("click", () => void go("overview"));
  document.querySelectorAll(".admin-nav-icon[data-icon]").forEach((element) => {
    element.innerHTML = icon(element.dataset.icon, 14);
  });
  const searchIcon = document.getElementById("admin-search-icon");
  if (searchIcon) searchIcon.innerHTML = icon("search", 14);
  identity.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!identity.hidden) setAccountMenu(accountMenu.hidden);
  });
  accountMenu.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (button) runAccountAction(button.dataset.action);
  });

  searchButton.addEventListener("click", () => openCommandPalette());
  commandInput.addEventListener("input", () => renderCommands(commandInput.value));
  commandInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveCommand(commandIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveCommand(commandIndex - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const command = commandMatches[commandIndex];
      if (command) runCommand(command.id);
    }
  });
  commandLayer.addEventListener("click", (event) => {
    if (event.target === commandLayer) closeCommandPalette();
  });
  helpLayer.addEventListener("click", (event) => {
    if (event.target === helpLayer) closeHelp();
  });
  helpClose.addEventListener("click", () => closeHelp());

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openCommandPalette();
    } else if (event.key === "Escape") {
      closeAccountMenu();
      closeCommandPalette();
      closeHelp();
    }
  });
  document.addEventListener("click", (event) => {
    if (
      !accountMenu.hidden &&
      !accountMenu.contains(event.target) &&
      !identity.contains(event.target)
    ) {
      closeAccountMenu();
    }
  });

  const initial = window.location.hash.replace(/^#/, "");
  void go(PAGE_TITLES[initial] ? initial : "overview");
}

init();
