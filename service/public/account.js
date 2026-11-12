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

let totpEnabled = false;
let totpSecret = "";

function renderTotp(enabled) {
  totpEnabled = Boolean(enabled);
  const status = $("totp-status");
  status.textContent = totpEnabled
    ? "Enabled with an authenticator app."
    : "Not enabled. Add an authenticator app for a second sign-in step.";
  $("totp-setup-start").hidden = totpEnabled;
  $("totp-enabled").hidden = !totpEnabled;
  $("totp-setup").hidden = true;
  $("totp-disable").hidden = true;
}

async function loadTotp() {
  try {
    const data = await api("/api/v1/auth/totp");
    renderTotp(data.enabled);
  } catch {
    $("totp-status").textContent = "2FA status unavailable.";
  }
}

function renderPasskeyReadiness() {
  const element = $("passkey-readiness");
  if (!window.PublicKeyCredential) {
    element.textContent = "This browser does not expose WebAuthn, so passkeys are unavailable here.";
    return;
  }
  element.textContent = window.isSecureContext
    ? "Passkeys are available on this device. Use the passkey page to register one."
    : "Passkeys need a secure context. Use localhost or HTTPS; plain HTTP on a LAN/public IP cannot register a passkey.";
}

function showPasskeyStatus() {
  renderPasskeyReadiness();
}

async function startTotpSetup() {
  try {
    const data = await api("/api/v1/auth/totp/setup", { method: "POST", body: {} });
    totpSecret = data.secret;
    $("totp-secret").value = data.secret;
    $("totp-code").value = "";
    const qr = $("totp-qr");
    qr.textContent = "";
    if (window.qrcode) {
      const code = window.qrcode(0, "M");
      code.addData(data.uri);
      code.make();
      qr.innerHTML = code.createSvgTag(4, 2);
    } else {
      qr.textContent = "QR preview unavailable. Enter the secret manually.";
    }
    $("totp-setup").hidden = false;
    $("totp-enabled").hidden = true;
    $("totp-setup-start").hidden = true;
    $("totp-status").textContent = "Scan the code, then confirm with a 6-digit code.";
    setStatus("Authenticator setup started.");
  } catch (error) {
    setStatus(error.message);
  }
}

async function enableTotp() {
  const code = $("totp-code").value.trim();
  if (!/^\d{6}$/.test(code)) return setStatus("Enter the 6-digit code from the authenticator app.");
  try {
    await api("/api/v1/auth/totp/enable", { method: "POST", body: { code } });
    totpSecret = "";
    setStatus("Two-factor authentication enabled.");
    await loadTotp();
  } catch (error) {
    setStatus(error.message);
  }
}

async function disableTotp() {
  const password = $("totp-disable-password").value;
  const code = $("totp-disable-code").value.trim();
  if (!password) return setStatus("Enter your password.");
  if (!/^\d{6}$/.test(code)) return setStatus("Enter the current 6-digit code.");
  try {
    await api("/api/v1/auth/totp/disable", { method: "POST", body: { password, code } });
    $("totp-disable-password").value = "";
    $("totp-disable-code").value = "";
    setStatus("Two-factor authentication disabled.");
    await loadTotp();
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
    await loadTotp();
    renderPasskeyReadiness();
  } catch {
    $("account-section").hidden = true;
    $("redirect-note").hidden = false;
    window.location.replace("/login");
  }
}

$("token-create").addEventListener("click", createToken);
$("logout").addEventListener("click", logout);
$("logout-all").addEventListener("click", logoutAll);
$("totp-setup-start").addEventListener("click", startTotpSetup);
$("totp-copy-secret").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(totpSecret || $("totp-secret").value);
    setStatus("Authenticator secret copied.");
  } catch {
    setStatus("Could not copy the secret.");
  }
});
$("totp-enable").addEventListener("click", enableTotp);
$("totp-cancel").addEventListener("click", () => {
  $("totp-setup").hidden = true;
  $("totp-setup-start").hidden = false;
  $("totp-status").textContent = "Not enabled. Add an authenticator app for a second sign-in step.";
});
$("totp-disable-start").addEventListener("click", () => {
  $("totp-disable").hidden = false;
  $("totp-enabled").hidden = true;
});
$("totp-disable-cancel").addEventListener("click", () => {
  $("totp-disable").hidden = true;
  $("totp-enabled").hidden = true;
  renderTotp(totpEnabled);
});
$("totp-disable-confirm").addEventListener("click", disableTotp);
async function applyAccountFeatures() {
  try {
    const features = await api("/api/v1/auth/features");
    if (!features.passkeysEnabled) {
      document.getElementById("account-passkeys")?.setAttribute("hidden", "");
      document.getElementById("account-passkeys-link")?.setAttribute("hidden", "");
    }
  } catch {
    /* keep passkey UI when the feature endpoint is unavailable */
  }
}

window.addEventListener("focus", showPasskeyStatus);
void applyAccountFeatures();
refresh();
