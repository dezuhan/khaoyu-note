const statusEl = document.getElementById("status");
const listEl = document.getElementById("passkey-list");

function setStatus(message) {
  statusEl.textContent = message;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  const padded = String(value).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
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
    headers,
    credentials: "same-origin",
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

function creationOptions(options) {
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

function requestOptions(options) {
  return {
    ...options,
    challenge: base64UrlToBytes(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((entry) => ({
      ...entry,
      id: base64UrlToBytes(entry.id),
    })),
  };
}

function serializeCredential(credential, kind) {
  const response =
    kind === "create"
      ? {
          clientDataJSON: bytesToBase64Url(credential.response.clientDataJSON),
          attestationObject: bytesToBase64Url(credential.response.attestationObject),
          transports: credential.response.getTransports ? credential.response.getTransports() : [],
        }
      : {
          clientDataJSON: bytesToBase64Url(credential.response.clientDataJSON),
          authenticatorData: bytesToBase64Url(credential.response.authenticatorData),
          signature: bytesToBase64Url(credential.response.signature),
          userHandle: credential.response.userHandle
            ? bytesToBase64Url(credential.response.userHandle)
            : null,
        };
  return {
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    type: credential.type,
    response,
    clientExtensionResults: credential.getClientExtensionResults
      ? credential.getClientExtensionResults()
      : {},
  };
}

async function loginWithPassword() {
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  if (!email || !password) return setStatus("Enter email and password.");
  try {
    await api("/api/v1/auth/login", { method: "POST", body: { email, password } });
    setStatus("Signed in. You can register or manage passkeys.");
    await loadPasskeys();
  } catch (error) {
    setStatus(error.message);
  }
}

async function registerPasskey() {
  if (!window.PublicKeyCredential) return setStatus("This browser does not support WebAuthn.");
  try {
    const { options } = await api("/api/v1/auth/passkeys/register/options", { method: "POST", body: {} });
    const credential = await navigator.credentials.create({ publicKey: creationOptions(options) });
    await api("/api/v1/auth/passkeys/register/verify", {
      method: "POST",
      body: { response: serializeCredential(credential, "create"), name: "This device" },
    });
    setStatus("Passkey registered.");
    await generateBackupCodes();
    await loadPasskeys();
  } catch (error) {
    setStatus(error.message);
  }
}

async function loginWithPasskey() {
  const email = document.getElementById("passkey-email").value.trim();
  if (!email) return setStatus("Enter the passkey email.");
  try {
    const { options } = await api("/api/v1/auth/passkeys/login/options", {
      method: "POST",
      body: { email },
    });
    const credential = await navigator.credentials.get({ publicKey: requestOptions(options) });
    await api("/api/v1/auth/passkeys/login/verify", {
      method: "POST",
      body: { email, response: serializeCredential(credential, "get") },
    });
    setStatus("Signed in with a passkey.");
    await loadPasskeys();
  } catch (error) {
    setStatus(error.message);
  }
}

async function loadPasskeys() {
  try {
    const data = await api("/api/v1/auth/passkeys");
    listEl.textContent = "";
    for (const passkey of data.passkeys) {
      const item = document.createElement("li");
      item.textContent = `${passkey.name} · ${passkey.deviceType} · created ${new Date(passkey.createdAt).toLocaleString()}`;
      listEl.append(item);
    }
    if (!data.passkeys.length) listEl.textContent = "No passkeys yet.";
  } catch {
    listEl.textContent = "Sign in to manage passkeys.";
  }
}

async function logout() {
  try {
    await api("/api/v1/auth/logout", { method: "POST", body: {} });
    setStatus("Signed out.");
    await loadPasskeys();
  } catch (error) {
    setStatus(error.message);
  }
}

document.getElementById("login").addEventListener("click", loginWithPassword);
async function generateBackupCodes() {
  const output = document.getElementById("backup-codes");
  try {
    const data = await api("/api/v1/auth/recovery-codes", { method: "POST", body: {} });
    output.textContent = data.codes.join("\n");
    output.hidden = false;
    setStatus("Backup codes generated. Save them now; each code works once.");
  } catch (error) {
    setStatus(error.message);
  }
}

document.getElementById("backup-generate").addEventListener("click", generateBackupCodes);
document.getElementById("passkey-register").addEventListener("click", registerPasskey);
document.getElementById("passkey-login").addEventListener("click", loginWithPasskey);
document.getElementById("logout").addEventListener("click", logout);
loadPasskeys();

async function applyPasskeyFeature() {
  try {
    const response = await fetch("/api/v1/auth/features", { credentials: "same-origin" });
    if (!response.ok) return;
    const features = await response.json();
    if (features.passkeysEnabled) return;
    const register = document.getElementById("passkey-register");
    const login = document.getElementById("passkey-login");
    register.disabled = true;
    login.disabled = true;
    setStatus("Passkeys are temporarily disabled by the service operator. Password and backup-code sign-in remain available.");
  } catch {
    /* leave the page unchanged if the feature endpoint is unavailable */
  }
}

void applyPasskeyFeature();
