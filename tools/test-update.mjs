// Node checks for update version handling and the release parser. Run with:
// node tools/test-update.mjs
import assert from "node:assert/strict";

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
}

const calls = [];
let currentVersion = "0.34.0";
let release = {
  tag_name: "v0.35.0",
  name: "Khaoyu Note 0.35.0",
  body: "### Added\n- Board search\n- Markdown export",
  html_url: "https://github.com/dezuhan/khaoyu-note/releases/tag/v0.35.0",
  published_at: "2026-11-08T10:00:00Z",
  prerelease: false,
  draft: false,
  assets: [
    {
      name: "Khaoyu Note_0.35.0_x64-setup.exe",
      size: 1234,
      browser_download_url: "https://example.test/setup.exe",
    },
  ],
};
let failure = null;

globalThis.localStorage = new MemoryStorage();
globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async (command) => {
        calls.push(command);
        if (command === "app_version") return currentVersion;
        if (command === "check_update") {
          if (failure) throw new Error(failure);
          return { currentVersion, release };
        }
        throw new Error("unexpected command " + command);
      },
    },
  },
};

const update = await import("../app/web/js/update.js");

// Version parsing and ordering.
assert.equal(update.compareVersions("0.34.0", "0.35.0"), -1);
assert.equal(update.compareVersions("v0.35.0", "0.34.0"), 1);
assert.equal(update.compareVersions("0.34.0", "0.34.0"), 0);
assert.equal(update.compareVersions("0.35.0-beta.1", "0.35.0"), -1);
assert.equal(update.compareVersions("0.35.0-beta.2", "0.35.0-beta.1"), 1);
assert.equal(update.compareVersions("0.35.0-beta.1", "0.35.0-alpha.9"), 1);
assert.equal(update.compareVersions("0.35.0-1", "0.35.0-alpha"), -1);
assert.equal(update.compareVersions("not-a-version", "0.35.0"), 0);

// Release parsing keeps the fields the UI renders.
const parsed = update.parseRelease(release);
assert.equal(parsed.version, "0.35.0");
assert.equal(parsed.tag, "v0.35.0");
assert.equal(parsed.title, "Khaoyu Note 0.35.0");
assert.equal(parsed.assets.length, 1);
assert.equal(parsed.assets[0].name, "Khaoyu Note_0.35.0_x64-setup.exe");
assert.equal(update.parseRelease(null), null);
assert.equal(update.parseRelease({ name: "no tag" }), null);
assert.equal(update.parseRelease({ tag_name: "khaoyu-v0.35.0" }).version, "0.35.0");
assert.equal(update.parseRelease({ tag_name: "tauri-v3.0.0-alpha.6" }).version, "3.0.0-alpha.6");

assert.equal(update.evaluateRelease("0.34.0", release).status, "update");
assert.equal(update.evaluateRelease("0.36.0", release).status, "current");
assert.equal(update.evaluateRelease("0.36.0", release).status, "current");
assert.equal(update.evaluateRelease("0.34.0", null).status, "none");

// The check reads the current version from the host and evaluates the release.
assert.equal(await update.initCurrentVersion(), "0.34.0");
assert.equal(update.currentVersion(), "0.34.0");
let result = await update.checkForUpdates();
assert.equal(result.ok, true);
assert.equal(result.status, "update");
assert.equal(result.latestVersion, "0.35.0");
assert.equal(result.release.tag, "v0.35.0");
assert.equal(update.releaseSummary(), "Update available: v0.35.0");
assert.ok(update.loadCachedState().checkedAt > 0);

// A published release equal to or older than the installed version means no update.
release = { ...release, tag_name: "v0.34.0", name: "Khaoyu Note 0.34.0" };
result = await update.checkForUpdates();
assert.equal(result.status, "current");
assert.equal(update.releaseSummary(), "You are on the latest version (0.34.0)");

// No release yet and network failures are reported without throwing.
release = null;
result = await update.checkForUpdates();
assert.equal(result.status, "none");

release = {
  tag_name: "v0.35.0",
  name: "Khaoyu Note 0.35.0",
  body: "",
  html_url: "https://example.test/release",
  published_at: "2026-11-08T10:00:00Z",
};
failure = "GitHub rate limit reached, try again later";
result = await update.checkForUpdates();
assert.equal(result.ok, false);
assert.equal(result.status, "error");
assert.match(result.message, /rate limit/);
failure = null;

assert.ok(calls.includes("app_version"));
assert.ok(calls.includes("check_update"));

console.log("PASS  update version compare, release parsing, cached state and error handling");
console.log(`${calls.length} host calls`);
