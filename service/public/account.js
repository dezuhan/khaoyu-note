const $ = (id) => document.getElementById(id);
const statusEl = $("status");
let csrf = "";

function setStatus(message) {
  statusEl.textContent = message;
}

function csrfToken() {
  const match = document.cookie.match(/(?:^|; )khaoyu_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : csrf;
}

async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (!["GET", "HEAD"].includes(method)) headers["x-csrf-token"] = csrfToken();
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) throw new Error(parsed?.error || `Request failed (${response.status})`);
  return parsed;
}

function renderSessions(sessions) {
  const list = $("sessions");
  list.textContent = "";
  for (const session of sessions.filter((entry) => !entry.revoked)) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${session.device || "Unknown device"} · ${session.current ? "current" : new Date(session.createdAt).toLocaleString()}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ky-button ky-button-quiet";
    button.textContent = "Revoke";
    button.addEventListener("click", async () => {
      try {
        await api(`/api/v1/auth/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
        setStatus("Session revoked.");
        await refresh();
      } catch (error) {
        setStatus(error.message);
      }
    });
    item.append(label, button);
    list.append(item);
  }
  if (!sessions.length) list.textContent = "No sessions.";
}

function renderTokens(tokens) {
  const list = $("tokens");
  list.textContent = "";
  for (const token of tokens.filter((entry) => !entry.revoked)) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${token.name} · ${token.scopes.join(", ")} · expires ${new Date(token.expiresAt).toLocaleDateString()}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ky-button ky-button-danger";
    button.textContent = "Revoke";
    button.addEventListener("click", async () => {
      try {
        await api(`/api/v1/account/tokens/${encodeURIComponent(token.id)}`, { method: "DELETE" });
        setStatus("API token revoked.");
        await refresh();
      } catch (error) {
        setStatus(error.message);
      }
    });
    item.append(label, button);
    list.append(item);
  }
  if (!tokens.length) list.textContent = "No API tokens.";
}

async function createToken() {
  try {
    const created = await api("/api/v1/account/tokens", {
      method: "POST",
      body: {
        name: $("token-name").value.trim() || "Desktop sync",
        scopes: ["projects:read", "projects:write"],
        expiresInDays: 365,
      },
    });
    $("token-result").textContent = `Copy this token now: ${created.token}`;
    setStatus("API token created. It is shown only once.");
    await refresh();
  } catch (error) {
    setStatus(error.message);
  }
}

async function logoutAll() {
  try {
    await api("/api/v1/auth/logout-all", { method: "POST", body: {} });
    window.location.replace("/login?signedout=1");
  } catch (error) {
    setStatus(error.message);
  }
}

async function logout() {
  try {
    await api("/api/v1/auth/logout", { method: "POST", body: {} });
    window.location.replace("/login?signedout=1");
  } catch (error) {
    setStatus(error.message);
  }
}

async function refresh() {
  try {
    const sessions = await api("/api/v1/auth/sessions");
    const tokens = await api("/api/v1/account/tokens");
    $("account-section").hidden = false;
    $("account-email").textContent = sessions.account?.email || "Signed in";
    renderSessions(sessions.sessions);
    renderTokens(tokens.tokens);
  } catch {
    $("account-section").hidden = true;
    $("redirect-note").hidden = false;
    window.location.replace("/login");
  }
}

$("token-create").addEventListener("click", createToken);
$("logout").addEventListener("click", logout);
$("logout-all").addEventListener("click", logoutAll);
refresh();
