import { icon } from "./icons.js";
import { SERVICE_LEGACY_KEYS, THEME_KEY, readStoredTheme, setTheme as applyAndStoreTheme, systemTheme, toggleTheme } from "./theme.js";
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

export function landingFor() {
  return "/workspace";
}

export async function hasSession() {
  try {
    const data = await api("/api/v1/auth/sessions");
    return data.account || true;
  } catch {
    return false;
  }
}

export async function redirectIfSignedIn() {
  const account = await hasSession();
  if (account) {
    window.location.replace(landingFor(account));
    return true;
  }
  return false;
}

export function queryMessage() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("registered") === "1") {
    return { message: "Account created. Sign in with your new account.", kind: "success" };
  }
  if (params.get("pending") === "1") {
    return {
      message: "Account created. An administrator must approve it before you can sign in.",
      kind: "",
    };
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
  const theme = readStoredTheme({
    key: THEME_KEY,
    legacyKeys: SERVICE_LEGACY_KEYS,
    fallback: systemTheme(),
  });
  const button = $("auth-theme");
  const paint = (value) => {
    applyAndStoreTheme(value, { key: THEME_KEY });
    if (!button) return;
    const dark = value === "dark" || value === "softDark";
    button.innerHTML = icon(dark ? "sun" : "moon", 14);
    const label = dark ? "Switch to light mode" : "Switch to dark mode";
    button.title = label;
    button.setAttribute("aria-label", label);
  };
  paint(theme);
  button?.addEventListener("click", () => {
    paint(toggleTheme(document.documentElement.dataset.kyTheme));
  });
}

export function isEmail(value) {
  return /^[^\s@]+@[^\s@]+$/.test(String(value || "").trim());
}
