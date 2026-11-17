// Link-card URL handling. Web links keep the existing shorthand normalisation; custom schemes such
// as khaoyunote:// are stored verbatim and handed to the operating system handler for that scheme
// instead of being sent to the browser.
//
// This module deliberately has no static imports: it is unit tested directly under Node and imports
// the bridge/UI only when a link is actually opened or the allowlist is persisted.

export const WEB_SCHEMES = ["http", "https"];

// http, https and mailto work everywhere without a prompt. Any other scheme has to be added to the
// allowlist first; the first link card that uses it asks for confirmation in the UI.
export const DEFAULT_ALLOWED_SCHEMES = ["http", "https", "mailto"];

// Schemes that can execute or rewrite content in the calling page. They are never opened, even when
// a board or a stale allowlist asks for them.
export const BLOCKED_SCHEMES = [
  "javascript",
  "data",
  "vbscript",
  "blob",
  "about",
  "chrome",
  "resource",
  "moz-extension",
];

const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const SCHEME_NAME = /^[a-zA-Z][a-zA-Z0-9+.-]*$/;
const CACHE_KEY = "ky.externalSchemes";
const SETTING_KEY = "external_schemes";

function toast(message) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("mn:toast", { detail: { message } }));
}

function localStorageSafe() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function isValidScheme(value) {
  return SCHEME_NAME.test(String(value || "").trim());
}

export function isBlockedScheme(value) {
  return BLOCKED_SCHEMES.includes(String(value || "").trim().toLowerCase());
}

/// Return the lower-case scheme of a URL, or "" for a bare host such as "example.com". A host with
/// an explicit port ("example.com:8080", "localhost:3000") is not treated as a scheme.
export function schemeOf(value) {
  const text = String(value || "").trim();
  const match = SCHEME_PATTERN.exec(text);
  if (!match) return "";
  const scheme = match[1].toLowerCase();
  const rest = text.slice(match[0].length);
  if (/^\d/.test(rest) && (scheme.includes(".") || scheme === "localhost")) return "";
  return scheme;
}

/// Earlier builds prefixed every non-web URL with https://, so existing cards can hold
/// "https://khaoyunote://open?...". Recover the intended scheme when the pattern is unambiguous.
function repairMangledScheme(text) {
  const match = /^https?:\/\/([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(text);
  if (!match) return "";
  const inner = match[1].toLowerCase();
  if (WEB_SCHEMES.includes(inner)) return "";
  return `${inner}://${match[2]}`;
}

/// Keep an explicit scheme untouched, including custom ones, and add https:// only to a bare host.
export function normalizeLinkUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const repaired = repairMangledScheme(text);
  if (repaired) return repaired;
  return schemeOf(text) ? text : `https://${text}`;
}

export function classifyLink(value) {
  const url = normalizeLinkUrl(value);
  const scheme = schemeOf(url);
  return {
    url,
    scheme,
    web: WEB_SCHEMES.includes(scheme),
    blocked: Boolean(scheme) && isBlockedScheme(scheme),
  };
}

/// The short label shown in a link card. Custom schemes show the scheme name instead of the
/// meaningless hostname that `new URL("khaoyunote://open?board=welcome")` reports.
export function linkDisplayDomain(value) {
  const target = classifyLink(value);
  if (!target.url) return "";
  if (target.scheme && !target.web) return target.scheme;
  try {
    return new URL(target.url).hostname.replace(/^www\./, "");
  } catch {
    return target.url;
  }
}

function readExtraSchemes() {
  const store = localStorageSafe();
  if (!store) return [];
  try {
    const parsed = JSON.parse(store.getItem(CACHE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => String(entry || "").trim().toLowerCase())
      .filter((entry) => isValidScheme(entry) && !isBlockedScheme(entry));
  } catch {
    return [];
  }
}

function writeExtraSchemes(list) {
  const unique = [
    ...new Set(
      list
        .map((entry) => String(entry || "").trim().toLowerCase())
        .filter((entry) => isValidScheme(entry) && !isBlockedScheme(entry))
    ),
  ];
  const store = localStorageSafe();
  if (store) {
    try {
      store.setItem(CACHE_KEY, JSON.stringify(unique));
    } catch {
      /* storage may be unavailable */
    }
  }
  void import("./bridge.js")
    .then(({ setSetting }) => setSetting(SETTING_KEY, JSON.stringify(unique)))
    .catch(() => {});
  return unique;
}

let hydrated = null;

/// Load the durable allowlist once. localStorage stays the synchronous cache used by click handlers.
export function initExternalLinks() {
  if (hydrated) return hydrated;
  hydrated = (async () => {
    try {
      const { getSetting } = await import("./bridge.js");
      const raw = await getSetting(SETTING_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      writeExtraSchemes([...readExtraSchemes(), ...parsed]);
    } catch {
      /* the local cache remains authoritative */
    }
  })();
  return hydrated;
}

export function loadAllowedSchemes() {
  return [...new Set([...DEFAULT_ALLOWED_SCHEMES, ...readExtraSchemes()])];
}

export function isSchemeAllowed(scheme) {
  return loadAllowedSchemes().includes(String(scheme || "").trim().toLowerCase());
}

/// Add a scheme to the allowlist. Returns false for invalid/blocked names.
export function addAllowedScheme(value) {
  const scheme = String(value || "").trim().toLowerCase().replace(/:$/, "");
  if (!isValidScheme(scheme) || isBlockedScheme(scheme)) return false;
  if (!DEFAULT_ALLOWED_SCHEMES.includes(scheme)) {
    const extras = readExtraSchemes();
    if (!extras.includes(scheme)) writeExtraSchemes([...extras, scheme]);
  }
  return true;
}

/// Remove a scheme from the user-managed part of the allowlist. Defaults stay allowed.
export function removeAllowedScheme(value) {
  const scheme = String(value || "").trim().toLowerCase().replace(/:$/, "");
  const extras = readExtraSchemes();
  if (!extras.includes(scheme)) return false;
  writeExtraSchemes(extras.filter((entry) => entry !== scheme));
  return true;
}

async function confirmScheme(scheme) {
  try {
    const { confirmAction } = await import("./ui.js");
    return await confirmAction({
      title: `Open ${scheme}: links?`,
      message: `This link is not a web address. It will be handed to the application registered for the ${scheme}: scheme on this computer, and the scheme will be added to Settings > Tools > External URL schemes.`,
      confirmLabel: "Open link",
    });
  } catch {
    return false;
  }
}

/// Open a link-card URL. Web links keep the browser fallback; custom schemes go through the native
/// `open_external` command (xdg-open / open / ShellExecuteW) and never silently open unconfirmed.
export async function openLinkUrl(value) {
  const target = classifyLink(value);
  if (!target.url) return null;
  if (target.blocked) {
    toast(`The ${target.scheme}: scheme cannot be opened from a link card.`);
    return null;
  }
  if (!target.web && !isSchemeAllowed(target.scheme)) {
    const confirmed = await confirmScheme(target.scheme);
    if (!confirmed) return null;
    addAllowedScheme(target.scheme);
  }
  try {
    const { openExternal } = await import("./bridge.js");
    await openExternal(target.url);
  } catch (error) {
    if (target.web) {
      try {
        window.open(target.url, "_blank");
      } catch {
        /* popup blocked */
      }
      return null;
    }
    const label = target.scheme ? `${target.scheme}:` : "external";
    toast(`Could not open the ${label} link. ${error?.message || ""}`.trim());
  }
  return null;
}
