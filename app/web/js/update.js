// Update check against the latest published GitHub release. The app only reads the release and its
// notes; it never downloads or runs an installer.

import * as bridge from "./bridge.js";

export const UPDATE_REPO = "dezuhan/khaoyu-note";
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;

const CACHE_KEY = "ky.update.cache";
const DISMISSED_KEY = "ky.update.dismissed";

export const updateState = {
  status: "idle",
  currentVersion: "",
  latestVersion: "",
  release: null,
  message: "Not checked yet",
  checkedAt: 0,
};

function storage() {
  return globalThis.localStorage;
}

function persistState() {
  try {
    storage().setItem(
      CACHE_KEY,
      JSON.stringify({
        status: updateState.status,
        currentVersion: updateState.currentVersion,
        latestVersion: updateState.latestVersion,
        message: updateState.message,
        checkedAt: updateState.checkedAt,
      })
    );
  } catch {
    /* storage is optional */
  }
}

export function loadCachedState() {
  try {
    const raw = storage().getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      status: String(parsed.status || "idle"),
      currentVersion: String(parsed.currentVersion || ""),
      latestVersion: String(parsed.latestVersion || ""),
      message: String(parsed.message || "Not checked yet"),
      checkedAt: Number(parsed.checkedAt || 0),
    };
  } catch {
    return null;
  }
}

// Semver comparison with prerelease support. Returns -1, 0 or 1.
export function compareVersions(left, right) {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  if (!a || !b) return 0;
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumber = Number(x);
    const yNumber = Number(y);
    const xNumeric = Number.isInteger(xNumber);
    const yNumeric = Number.isInteger(yNumber);
    if (xNumeric && yNumeric) {
      if (xNumber !== yNumber) return xNumber > yNumber ? 1 : -1;
      continue;
    }
    if (xNumeric) return -1;
    if (yNumeric) return 1;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

export function normalizeVersion(value) {
  const text = String(value || "")
    .trim()
    .replace(/^v/i, "");
  if (!text) return null;
  const [core, ...rest] = text.split("-");
  const parts = core.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length < 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    return null;
  }
  return {
    major: parts[0],
    minor: parts[1],
    patch: parts[2],
    prerelease: rest.join("-").split(".").filter(Boolean),
  };
}

export function parseRelease(release) {
  if (!release || typeof release !== "object") return null;
  const tag = String(release.tag_name || release.tagName || "").trim();
  // Tags may carry a project prefix such as `khaoyu-v0.34.0`; take the semver part for comparison.
  const match = tag.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  const version = match ? match[1] : tag.replace(/^v/i, "");
  if (!version) return null;
  return {
    tag,
    version,
    title: String(release.name || tag || version).trim(),
    notes: String(release.body || "").trim(),
    url: String(release.html_url || release.htmlUrl || ""),
    publishedAt: String(release.published_at || release.publishedAt || ""),
    prerelease: Boolean(release.prerelease),
    draft: Boolean(release.draft),
    assets: Array.isArray(release.assets)
      ? release.assets.map((asset) => ({
          name: String(asset.name || ""),
          size: Number(asset.size || 0),
          url: String(asset.browser_download_url || asset.browserDownloadUrl || ""),
        }))
      : [],
  };
}

export function evaluateRelease(currentVersion, release) {
  const parsed = parseRelease(release);
  if (!parsed) {
    return { status: "none", currentVersion: String(currentVersion || ""), release: null };
  }
  const comparison = compareVersions(currentVersion, parsed.version);
  return {
    status: comparison < 0 ? "update" : "current",
    currentVersion: String(currentVersion || ""),
    release: parsed,
  };
}

export async function initCurrentVersion() {
  if (updateState.currentVersion) return updateState.currentVersion;
  try {
    updateState.currentVersion = String((await bridge.appVersion()) || "");
  } catch {
    updateState.currentVersion = "";
  }
  return updateState.currentVersion;
}

export function currentVersion() {
  return updateState.currentVersion;
}

export function releaseSummary() {
  if (updateState.status === "update" && updateState.release) {
    return `Update available: ${updateState.release.tag}`;
  }
  return updateState.message || "Not checked yet";
}

export function dismissedVersion() {
  try {
    return storage().getItem(DISMISSED_KEY) || "";
  } catch {
    return "";
  }
}

export function dismissVersion(version) {
  try {
    storage().setItem(DISMISSED_KEY, String(version || ""));
  } catch {
    /* storage is optional */
  }
}

export async function checkForUpdates() {
  if (updateState.status === "checking") return { ok: false, ...updateState };
  updateState.status = "checking";
  updateState.message = "Checking for updates...";
  let result;
  try {
    const payload = await bridge.checkUpdate();
    const current = String(
      payload?.currentVersion || updateState.currentVersion || (await initCurrentVersion()) || ""
    );
    updateState.currentVersion = current;
    const evaluated = evaluateRelease(current, payload?.release ?? null);
    updateState.status = evaluated.status;
    updateState.latestVersion = evaluated.release?.version || "";
    updateState.release = evaluated.release;
    updateState.message =
      evaluated.status === "update"
        ? `Update available: ${evaluated.release.tag}`
        : evaluated.status === "current"
          ? `You are on the latest version (${current})`
          : "No published release found";
    result = { ok: true, ...updateState };
  } catch (error) {
    updateState.status = "error";
    updateState.release = null;
    updateState.latestVersion = "";
    updateState.message = error?.message || "Could not check for updates";
    result = { ok: false, ...updateState };
  }
  updateState.checkedAt = Date.now();
  persistState();
  return result;
}
