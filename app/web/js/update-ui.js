// Automatic and manual update checks. The check reads the latest GitHub release and shows its notes;
// it never downloads or runs an installer.

import * as bridge from "./bridge.js";
import { openModal, toast } from "./ui.js";
import * as update from "./update.js";

let started = false;
let running = false;
let pendingInteractive = false;

export function initUpdateUI() {
  if (started) return;
  started = true;
  const cached = update.loadCachedState();
  if (cached) {
    update.updateState.status = cached.status;
    update.updateState.currentVersion = cached.currentVersion;
    update.updateState.latestVersion = cached.latestVersion;
    update.updateState.message = cached.message;
    update.updateState.checkedAt = cached.checkedAt;
  }
  void update.initCurrentVersion();
  window.addEventListener("mn:check-updates", () => void runCheck({ interactive: true }));
  // Check once at startup, then again every hour.
  setTimeout(() => void runCheck({ interactive: false }), 5000);
  setInterval(() => void runCheck({ interactive: false }), update.CHECK_INTERVAL_MS);
}

async function runCheck({ interactive }) {
  if (running) {
    if (interactive) pendingInteractive = true;
    return;
  }
  running = true;
  try {
    const result = await update.checkForUpdates();
    window.dispatchEvent(new CustomEvent("mn:update-status", { detail: result }));
    if (interactive || pendingInteractive) {
      showResult(result);
      return;
    }
    if (result.status === "update" && result.release) {
      if (update.dismissedVersion() !== result.release.version) showResult(result);
    }
  } catch (error) {
    if (interactive || pendingInteractive) {
      toast(error.message || "Could not check for updates");
    }
  } finally {
    running = false;
    pendingInteractive = false;
  }
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function showResult(result) {
  const release = result.release;
  const updateAvailable = result.status === "update" && release;
  const body = document.createElement("div");
  body.className = "mn-update";

  const summary = document.createElement("p");
  summary.className = "mn-update-meta";
  if (updateAvailable) {
    const published = formatDate(release.publishedAt);
    summary.textContent = `Installed ${result.currentVersion || "unknown"}. Latest release ${
      release.tag
    }${published ? `, published ${published}` : ""}.`;
  } else if (result.status === "current") {
    summary.textContent = `Installed ${result.currentVersion || "unknown"}. You already have the latest release.`;
  } else if (result.status === "none") {
    summary.textContent = "No published GitHub release was found for this project yet.";
  } else {
    summary.textContent = result.message || "Could not check for updates.";
  }
  body.append(summary);

  if (updateAvailable) {
    if (release.notes) {
      const notes = document.createElement("pre");
      notes.className = "mn-update-notes";
      notes.textContent = release.notes;
      body.append(notes);
    } else {
      const empty = document.createElement("p");
      empty.className = "mn-update-meta";
      empty.textContent = "This release has no description.";
      body.append(empty);
    }
    const hint = document.createElement("p");
    hint.className = "mn-update-meta";
    hint.textContent =
      "Open the release page to download the installer for your platform. The app never downloads or runs it for you.";
    body.append(hint);
  }

  const footer = [{ label: "Close" }];
  if (updateAvailable && release.url) {
    footer.unshift({
      label: "Open release page",
      primary: true,
      onClick: () => {
        bridge.openExternal(release.url).catch(() => {});
      },
    });
  }
  openModal({
    title: updateAvailable ? `Update available: ${release.tag}` : "Check for updates",
    body,
    footer,
    width: "min(660px, calc(100vw - 48px))",
  });
  if (updateAvailable) update.dismissVersion(release.version);
}
