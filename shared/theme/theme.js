// Shared theme runtime for the Khaoyu Note desktop and web app.
// The token vocabulary lives in ky.css; this module only resolves and persists the active skin.
//
// Storage keys are per origin, so the desktop webview and the local web host store their own choice.
// The app stores the choice under `ky.theme`, after the historical `mn.theme` key is migrated by
// storage-keys.js.

export const SKINS = ["light", "softLight", "softDark", "dark"];
export const DEFAULT_THEME = "light";
export const THEME_KEY = "khaoyu.theme";

export function isTheme(value) {
  return SKINS.includes(value);
}

export function systemTheme(matchMedia = globalThis.matchMedia) {
  if (typeof matchMedia !== "function") return DEFAULT_THEME;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function readStoredTheme({
  key = THEME_KEY,
  legacyKeys = [],
  fallback = DEFAULT_THEME,
  storage = globalThis.localStorage,
} = {}) {
  const keys = [key, ...legacyKeys];
  for (const candidate of keys) {
    let value = null;
    try {
      value = storage?.getItem(candidate) || null;
    } catch {
      value = null;
    }
    if (isTheme(value)) return value;
  }
  return fallback === "system" ? systemTheme() : isTheme(fallback) ? fallback : DEFAULT_THEME;
}

export function applyTheme(theme, { root = globalThis.document?.documentElement } = {}) {
  const next = isTheme(theme) ? theme : DEFAULT_THEME;
  if (root?.dataset) root.dataset.kyTheme = next;
  return next;
}

export function storeTheme(theme, { key = THEME_KEY, storage = globalThis.localStorage } = {}) {
  if (!isTheme(theme) || !storage) return;
  try {
    storage.setItem(key, theme);
  } catch {
    /* storage can be disabled; the in-memory theme still applies to this page */
  }
}

export function setTheme(
  theme,
  { key = THEME_KEY, storage = globalThis.localStorage, root, onChange } = {}
) {
  const next = applyTheme(theme, { root });
  storeTheme(next, { key, storage });
  if (typeof onChange === "function") onChange(next);
  return next;
}

export function toggleTheme(current) {
  return current === "dark" || current === "softDark" ? "light" : "dark";
}

export function initTheme(options = {}) {
  const theme = readStoredTheme(options);
  return applyTheme(theme, { root: options.root });
}
