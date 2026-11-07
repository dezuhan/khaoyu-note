// Shared helpers for the standalone service auth pages.

const STATUS_CLASSES = ["is-error", "is-success"];

export function $(id) {
  return document.getElementById(id);
}

export function setStatus(message, kind = "") {
  const element = $("status");
  if (!element) return;
  element.textContent = message || "";
  element.classList.remove(...STATUS_CLASSES);
  if (kind) element.classList.add(`is-${kind}`);
}

export function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
}

export function csrfToken() {
  const match = document.cookie.match(/(?:^|; )khaoyu_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

export async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (!["GET", "HEAD"].includes(method) && csrfToken()) {
    headers["x-csrf-token"] = csrfToken();
  }
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
    throw new Error(parsed?.error || `Request failed (${response.status})`);
  }
  return parsed;
}

export async function hasSession() {
  try {
    await api("/api/v1/auth/sessions");
    return true;
  } catch {
    return false;
  }
}

export async function redirectIfSignedIn() {
  if (await hasSession()) {
    window.location.replace("/admin");
    return true;
  }
  return false;
}

export function queryMessage() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("registered") === "1") {
    return { message: "Account created. Sign in with your new account.", kind: "success" };
  }
  if (params.get("reset") === "1") {
    return { message: "Password updated. Sign in with the new password.", kind: "success" };
  }
  if (params.get("signedout") === "1") {
    return { message: "You have signed out.", kind: "" };
  }
  return null;
}

export function initTheme() {
  const key = "khaoyu.auth.theme";
  const stored = localStorage.getItem(key);
  const theme = stored === "light" || stored === "dark"
    ? stored
    : window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  document.documentElement.dataset.kyTheme = theme;
  const button = $("auth-theme");
  if (!button) return;
  button.textContent = theme === "dark" ? "Light mode" : "Dark mode";
  button.addEventListener("click", () => {
    const next = document.documentElement.dataset.kyTheme === "dark" ? "light" : "dark";
    document.documentElement.dataset.kyTheme = next;
    localStorage.setItem(key, next);
    button.textContent = next === "dark" ? "Light mode" : "Dark mode";
  });
}

export function isEmail(value) {
  return /^[^\s@]+@[^\s@]+$/.test(String(value || "").trim());
}
