const $ = (id) => document.getElementById(id);
let project = null;
let doc = null;

function setStatus(message) {
  $("status").textContent = message;
}

function csrfToken() {
  const match = document.cookie.match(/(?:^|; )khaoyu_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
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
  if (!response.ok) {
    const error = new Error(parsed?.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = parsed?.code;
    throw error;
  }
  return parsed;
}

async function login() {
  try {
    await api("/api/v1/auth/login", {
      method: "POST",
      body: { email: $("login-email").value.trim(), password: $("login-password").value },
    });
    setStatus("Signed in.");
    await boot();
  } catch (error) {
    setStatus(error.message);
  }
}

function setTargetOptions() {
  const scope = $("scope").value;
  $("target-wrap").hidden = scope === "project";
  const select = $("target");
  select.textContent = "";
  const cards = (doc?.cards || []).filter((card) => (scope === "column" ? card.type === "column" : true));
  for (const card of cards) {
    const option = document.createElement("option");
    option.value = card.id;
    option.textContent = `${card.type || "card"} · ${card.text || card.title || card.id}`.slice(0, 80);
    select.append(option);
  }
}

function renderPublicState() {
  const enabled = Boolean(project?.publicSharingEnabled);
  $("public-state").textContent = enabled
    ? "Public sharing is enabled. Anyone with a link can access the selected scope."
    : "Public sharing is disabled. Create links only after enabling it.";
  $("enable-box").hidden = enabled;
  $("disable-box").hidden = !enabled;
}

function renderShares(shares) {
  const list = $("shares");
  list.textContent = "";
  const visible = shares.filter((entry) => !entry.revoked);
  for (const share of visible) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    const expiry = share.expiresAt ? new Date(share.expiresAt).toLocaleDateString() : "no expiry";
    label.textContent = `${share.scope}${share.targetId ? " · " + share.targetId : ""} · ${share.permission} · ${expiry}${share.revoked ? " · revoked" : ""}`;
    if (!share.revoked) {
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "danger";
      revoke.textContent = "Revoke";
      revoke.addEventListener("click", async () => {
        try {
          await api(`/api/v1/projects/${project.id}/shares/${encodeURIComponent(share.id)}`, {
            method: "DELETE",
          });
          setStatus("Share link revoked.");
          await loadShares();
        } catch (error) {
          setStatus(error.message);
        }
      });
      item.append(label, revoke);
    } else {
      item.append(label);
    }
    list.append(item);
  }
  if (!visible.length) list.textContent = "No share links.";
}

async function loadShares() {
  const data = await api(`/api/v1/projects/${project.id}/shares`);
  renderShares(data.shares);
}

async function loadProject() {
  const data = await api(`/api/v1/projects/${encodeURIComponent($("project").value)}`);
  project = data.project;
  try {
    doc = JSON.parse(data.snapshot?.doc || "{}");
  } catch {
    doc = { cards: [] };
  }
  $("content").hidden = false;
  $("login-section").hidden = true;
  renderPublicState();
  setTargetOptions();
  await loadShares();
}

async function loadProjects() {
  const data = await api("/api/v1/projects");
  $("content").hidden = false;
  $("login-section").hidden = true;
  const select = $("project");
  select.textContent = "";
  for (const entry of data.projects) {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = entry.name;
    select.append(option);
  }
  if (data.projects.length) await loadProject();
  else setStatus("Create a project in the app before sharing.");
}

async function boot() {
  try {
    await api("/api/v1/auth/sessions");
    $("login-section").hidden = true;
    await loadProjects();
  } catch {
    $("content").hidden = true;
    $("login-section").hidden = false;
  }
}

async function enableSharing() {
  if (!$("acknowledge").checked) {
    setStatus("Tick the acknowledgement before enabling public sharing.");
    return;
  }
  try {
    await api(`/api/v1/projects/${project.id}/public-sharing`, {
      method: "POST",
      body: { enabled: true, acknowledge: true },
    });
    setStatus("Public sharing enabled.");
    await loadProject();
  } catch (error) {
    setStatus(error.message);
  }
}

async function disableSharing() {
  try {
    await api(`/api/v1/projects/${project.id}/public-sharing`, {
      method: "POST",
      body: { enabled: false },
    });
    setStatus("Public sharing disabled and existing links revoked.");
    await loadProject();
  } catch (error) {
    setStatus(error.message);
  }
}

async function createShare() {
  try {
    const scope = $("scope").value;
    const body = {
      scope,
      permission: $("permission").value,
      downloadAllowed: $("download").checked,
    };
    if (scope !== "project") body.targetId = $("target").value;
    if ($("expiry").value) body.expiresInDays = Number($("expiry").value);
    if ($("password").value) body.password = $("password").value;
    const created = await api(`/api/v1/projects/${project.id}/shares`, { method: "POST", body });
    $("token").textContent = `Copy this link token now: ${created.token}`;
    setStatus("Share link created.");
    $("password").value = "";
    await loadShares();
  } catch (error) {
    setStatus(error.message);
  }
}

$("login").addEventListener("click", login);
$("project").addEventListener("change", loadProject);
$("refresh").addEventListener("click", loadProject);
$("scope").addEventListener("change", setTargetOptions);
$("enable-sharing").addEventListener("click", enableSharing);
$("disable-sharing").addEventListener("click", disableSharing);
$("create").addEventListener("click", createShare);
boot();
