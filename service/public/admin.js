// Self-hosted service admin dashboard. The page uses the account session and requires the admin role.

const pane = document.getElementById("admin-pane");
const title = document.getElementById("admin-title");
const navItems = [...document.querySelectorAll(".admin-nav-item")];
const identity = document.getElementById("admin-identity");
const themeButton = document.getElementById("admin-theme");
const themeLabel = document.getElementById("admin-theme-label");

const THEME_KEY = "khaoyu.admin.theme";
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

function showAuth(message) {
  identity.hidden = true;
  pane.innerHTML = `
    <div class="admin-auth">
      <h2>Admin sign in</h2>
      <p>${escapeHtml(message || "Sign in with an account that has the admin role.")}</p>
      <a class="ky-button ky-button-primary" href="/login">Sign in to the service</a>
      <p class="admin-note">The dashboard reads the service account session and never asks for the operator token.</p>
    </div>`;
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
  document.getElementById("admin-name").textContent = admin.displayName || admin.email;
  document.getElementById("admin-email").textContent = admin.email;
  document.getElementById("admin-avatar").outerHTML = avatarHtml({
    displayName: admin.displayName,
    email: admin.email,
    avatarUrl: admin.avatarUrl,
  }).replace('class="admin-avatar', 'id="admin-avatar" class="admin-avatar');
}

function setTheme(theme) {
  document.documentElement.dataset.kyTheme = theme;
  localStorage.setItem(THEME_KEY, theme);
  themeLabel.textContent = theme === "dark" ? "Light mode" : "Dark mode";
}

function initTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  const theme = stored === "light" || stored === "dark"
    ? stored
    : matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  setTheme(theme);
  themeButton.addEventListener("click", () => {
    setTheme(document.documentElement.dataset.kyTheme === "dark" ? "light" : "dark");
  });
}

function statCards(cards) {
  return `<div class="admin-grid">${cards
    .map(
      ([label, value]) =>
        `<div class="admin-card"><span class="admin-card-label">${escapeHtml(label)}</span><span class="admin-card-value">${escapeHtml(value)}</span></div>`
    )
    .join("")}</div>`;
}

function activityTable(entries, compact = false) {
  if (!entries.length) return `<div class="admin-empty">No activity yet.</div>`;
  return `
    <table class="admin-table">
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
      ["Teams", counts.teams],
      ["Activity entries", counts.auditEntries],
    ])}
    <div class="admin-section">
      <div class="admin-section-head"><div><h2>Recent activity</h2><p>Every recorded account, project and share change.</p></div></div>
      ${activityTable(recentActivity, true)}
    </div>
    <div class="admin-section">
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
    <div class="admin-section">
      <div class="admin-section-head"><div><h2>Accounts</h2><p>${data.total} service account${
        data.total === 1 ? "" : "s"
      }.</p></div></div>
      <form class="admin-toolbar" data-role="account-search">
        <input class="admin-search" name="q" value="${escapeHtml(query)}" placeholder="Search name, email or username" autocomplete="off" />
        <button class="ky-button ky-button-primary" type="submit">Search</button>
      </form>
      ${
        data.users.length
          ? `<table class="admin-table">
        <thead><tr><th>Account</th><th>Role</th><th>Status</th><th>Teams</th><th>Last active</th><th>Updated</th></tr></thead>
        <tbody>
          ${data.users
            .map(
              (user) => `
            <tr data-user="${escapeHtml(user.id)}">
              <td><div class="admin-user">${avatarHtml(user)}<span class="admin-user-copy"><strong>${escapeHtml(
                displayName(user)
              )}</strong><span>${escapeHtml(user.email)}</span></span></div></td>
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
  pane.innerHTML = `<div class="admin-loading">Loading teams...</div>`;
  let data;
  try {
    data = await api("/api/v1/admin/teams?limit=100");
  } catch (error) {
    if (error instanceof AuthError) return showAuth();
    pane.innerHTML = "";
    return showError(error);
  }
  pane.innerHTML = `
    <div class="admin-section">
      <div class="admin-section-head"><div><h2>Teams</h2><p>${data.total} project${
        data.total === 1 ? "" : "s"
      } owned by service accounts.</p></div></div>
      <form class="admin-toolbar" data-role="team-create">
        <input class="admin-search" name="name" placeholder="New team name" maxlength="120" required />
        <button class="ky-button ky-button-primary" type="submit">Create team</button>
      </form>
      ${
        data.teams.length
          ? `<div class="admin-team-grid">${data.teams
              .map(
                (team) => `
            <div class="admin-team">
              <h3>${escapeHtml(team.name)}</h3>
              <div class="admin-user">${avatarHtml({
                displayName: team.owner_name,
                email: team.owner_email,
                avatarColor: team.owner_avatar_color,
                avatarUrl: team.owner_avatar_url,
              })}<span class="admin-user-copy"><strong>${escapeHtml(team.owner_name)}</strong><span>${escapeHtml(
                team.owner_email
              )}</span></span></div>
              <div class="admin-team-meta">
                <span>${team.member_count} member${team.member_count === 1 ? "" : "s"}</span>
                <span>rev ${team.revision}</span>
                <span>Updated ${escapeHtml(formatTime(team.updated_at))}</span>
              </div>
              <div class="admin-actions"><button class="ky-button ky-button-quiet" type="button" data-role="members" data-team="${escapeHtml(
                team.id
              )}">Members</button></div>
              <div class="admin-members" data-members="${escapeHtml(team.id)}"></div>
            </div>`
              )
              .join("")}</div>`
          : `<div class="admin-empty">No teams yet. Create the first one above.</div>`
      }
    </div>`;
  pane.querySelector('[data-role="team-create"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = event.target.name.value.trim();
    if (!name) return;
    try {
      await api("/api/v1/admin/teams", { method: "POST", body: { name } });
      await renderTeams();
    } catch (error) {
      if (error instanceof AuthError) return showAuth();
      showError(error);
    }
  });
  for (const button of pane.querySelectorAll('button[data-role="members"]')) {
    button.addEventListener("click", async () => {
      const box = pane.querySelector(`[data-members="${CSS.escape(button.dataset.team)}"]`);
      if (box.dataset.open === "1") {
        box.innerHTML = "";
        box.dataset.open = "0";
        return;
      }
      box.textContent = "Loading members...";
      try {
        const members = await api(
          `/api/v1/admin/teams/${encodeURIComponent(button.dataset.team)}/members`
        );
        box.innerHTML = `<table class="admin-table"><thead><tr><th>Member</th><th>Role</th><th>Status</th></tr></thead><tbody>${members.members
          .map(
            (member) => `<tr><td><div class="admin-user">${avatarHtml(member)}<span class="admin-user-copy"><strong>${escapeHtml(
              displayName(member)
            )}</strong><span>${escapeHtml(member.email)}</span></span></div></td><td>${escapeHtml(
              member.role
            )}</td><td>${escapeHtml(member.status)}</td></tr>`
          )
          .join("")}</tbody></table>`;
        box.dataset.open = "1";
      } catch (error) {
        box.textContent = error.message;
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
      <div class="admin-section">
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
        <div data-role="activity-body"><div class="admin-loading">Loading activity...</div></div>
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
      body.innerHTML = `<table class="admin-table"><thead><tr><th>Actor</th><th>Action</th><th>Resource</th><th>Time</th></tr></thead><tbody data-role="activity-rows">${activityRows(
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

async function go(next) {
  page = next;
  for (const item of navItems) item.classList.toggle("is-active", item.dataset.page === next);
  title.textContent = next.charAt(0).toUpperCase() + next.slice(1);
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
  if (next === "teams") return renderTeams();
  return renderActivity();
}

function init() {
  initTheme();
  for (const item of navItems) item.addEventListener("click", () => void go(item.dataset.page));
  void go("overview");
}

init();
