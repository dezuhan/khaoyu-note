// Share panel for the desktop board UI. Access is configured from the header.

import * as bridge from "./bridge.js";
import { state } from "./store.js";
import { enableBoardSync, loadSyncConfig } from "./sync.js";
import * as sharing from "./share.js";

let overlay = null;
let refs = null;
let target = null;

export function initShareUI(uiRefs) {
  refs = uiRefs;
  refs.shareButton?.addEventListener("click", () => openSharePanel(null));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && overlay) closeSharePanel();
  });
}

export async function openSharePanel(card = null) {
  target = card;
  if (!state.board) return;
  if (overlay) closeSharePanel();
  overlay = document.createElement("div");
  overlay.className = "mn-share-overlay";
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) closeSharePanel();
  });
  document.body.append(overlay);
  await renderPanel();
}

function closeSharePanel() {
  overlay?.remove();
  overlay = null;
}

function toast(message) {
  window.dispatchEvent(new CustomEvent("mn:toast", { detail: { message } }));
}

function panelShell() {
  overlay.textContent = "";
  const panel = document.createElement("section");
  panel.className = "mn-modal mn-share-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Share");
  const head = document.createElement("header");
  head.className = "mn-modal-head";
  const title = document.createElement("h2");
  title.className = "mn-modal-title";
  title.textContent = target ? "Share this card" : "Share this board";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "mn-icon-btn mn-modal-close";
  close.textContent = "×";
  close.addEventListener("click", closeSharePanel);
  head.append(title, close);
  const body = document.createElement("div");
  body.className = "mn-modal-body mn-share-body";
  panel.append(head, body);
  overlay.append(panel);
  return body;
}

function button(label, className, handler) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.addEventListener("click", handler);
  return element;
}

function isLoopbackUrl(value) {
  try {
    const host = new URL(value).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return true;
  }
}

function connectedShareUrl(created) {
  const sync = loadSyncConfig();
  if (!sync.url) return created?.url || "";
  let candidate;
  try {
    candidate = new URL(created?.url || sync.url);
  } catch {
    return created?.url || "";
  }
  try {
    const server = new URL(sync.url);
    // The service can be configured with a loopback main-app/public URL behind a reverse proxy.
    // The connected server origin is the address the user actually entered, so prefer it.
    if (isLoopbackUrl(candidate.origin) && !isLoopbackUrl(server.origin)) {
      candidate = new URL(candidate.pathname + candidate.search + candidate.hash, server.origin);
    }
    const embedded = candidate.searchParams.get("server");
    if (embedded) {
      const embeddedUrl = new URL(embedded);
      if (isLoopbackUrl(embeddedUrl.origin) && !isLoopbackUrl(server.origin)) {
        candidate.searchParams.set("server", server.origin);
      }
    }
    return candidate.toString();
  } catch {
    return created?.url || "";
  }
}

async function boardShareUrl() {
  if (!bridge.hasWeb || !state.board) return "";
  const info = await bridge.shareInfo();
  const origin = `${window.location.protocol}//${window.location.host}`;
  const candidates = [...(info?.urls || []), origin].filter(Boolean);
  const publicOrigin = loadSyncConfig().publicShareUrl;
  const base = publicOrigin
    ? publicOrigin
    : isLoopbackUrl(origin)
      ? candidates.find((candidate) => !isLoopbackUrl(candidate)) || origin
      : origin;
  return `${String(base).replace(/\/+$/, "")}/?board=${encodeURIComponent(state.board.id)}`;
}

async function renderLocalShareSection(body) {
  const section = document.createElement("div");
  section.className = "mn-share-local";
  const title = document.createElement("div");
  title.className = "mn-share-local-title";
  title.textContent = "Board link";
  const note = document.createElement("p");
  note.className = "mn-prefs-note";
  section.append(title, note);

  if (!bridge.hasWeb) {
    note.textContent =
      "This desktop window is local to this computer. Run the browser edition with node server.mjs to share a board by IP while the host is running.";
    body.append(section);
    return;
  }

  note.textContent =
    "Open this full URL from another device on the same network while this host is running. The viewer signs in with an account on this host.";
  const input = document.createElement("input");
  input.className = "ky-input mn-share-local-url";
  input.readOnly = true;
  input.value = "Loading...";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "mn-btn mn-btn-primary";
  copy.textContent = "Copy board link";
  copy.disabled = true;
  const hint = document.createElement("p");
  hint.className = "mn-account-note";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(input.value);
      toast("Board link copied");
    } catch {
      toast("Could not copy the board link");
    }
  });
  const copyRow = document.createElement("div");
  copyRow.className = "mn-share-copy-row";
  copyRow.append(input, copy);
  section.append(copyRow, hint);
  body.append(section);

  const url = await boardShareUrl();
  if (!url) {
    input.value = "Board link unavailable";
    return;
  }
  input.value = url;
  copy.disabled = false;
  if (isLoopbackUrl(url)) {
    hint.textContent =
      "Only this computer can use this URL. Add a LAN address or set KHAOYU_WEB_PUBLIC_URL for other devices.";
  } else {
    hint.textContent = "Other devices on this network can open this link while the host stays running.";
  }
}

async function renderPanel() {
  const body = panelShell();
  await renderLocalShareSection(body);
  const board = state.board;
  let projectId = board.sync?.projectId;
  const sync = loadSyncConfig();
  if (sync.url && sync.token && !projectId) {
    const loading = document.createElement("p");
    loading.className = "mn-prefs-note";
    loading.textContent = "Connecting this board to the server...";
    body.append(loading);
    try {
      await enableBoardSync(board);
      projectId = board.sync?.projectId;
      loading.remove();
    } catch (error) {
      loading.textContent = error.message || "Could not connect the board to the server.";
      body.append(button("Change connection", "mn-btn", () => {
        closeSharePanel();
        void import("./settings.js").then((settingsModule) => settingsModule.openSettingsPage("server"));
      }));
      return;
    }
  }
  if (!sync.url || !sync.token || !projectId) {
    const note = document.createElement("p");
    note.className = "mn-prefs-note";
    note.textContent = sync.url && sync.token
      ? "Enable server sync for this board to create public share links. The board link above works without the service."
      : "Optional: connect a self-hosted service in the Sync control for public share links with permissions and expiry.";
    body.append(note);
    body.append(button("Close", "mn-btn", closeSharePanel));
    return;
  }

  let project;
  try {
    project = await sharing.readProject(projectId);
  } catch (error) {
    const note = document.createElement("p");
    note.className = "mn-prefs-note";
    note.textContent = error.message;
    body.append(note);
    return;
  }

  const scope = target ? (target.type === "column" ? "column" : "item") : "project";
  const status = document.createElement("p");
  status.className = "mn-prefs-note";
  status.textContent = project.project.publicSharingEnabled
    ? "Board sharing is on. Create a link for this board or the selected card."
    : "Board sharing is off. Enable it with the warning first.";
  body.append(status);

  if (!project.project.publicSharingEnabled) {
    const warning = document.createElement("div");
    warning.className = "mn-share-warning";
    warning.textContent =
      "A share link is a bearer secret. Anyone who receives it can open the selected scope. Search engines are excluded, but do not share private material.";
    const acknowledge = document.createElement("label");
    acknowledge.className = "mn-share-check";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const text = document.createElement("span");
    text.textContent = "I understand and want to enable board sharing.";
    acknowledge.append(checkbox, text);
    body.append(warning, acknowledge);
    body.append(
      button("Enable board sharing", "mn-btn mn-btn-primary", async () => {
        if (!checkbox.checked) return toast("Tick the acknowledgement first");
        try {
          await sharing.enableSharing(projectId);
          toast("Board sharing enabled");
          await renderPanel();
        } catch (error) {
          toast(error.message);
        }
      })
    );
    return;
  }

  const createHeading = document.createElement("div");
  createHeading.className = "mn-share-section-title";
  createHeading.textContent = "Create a share link";
  body.append(createHeading);

  const targetLabel = document.createElement("div");
  targetLabel.className = "mn-share-target";
  targetLabel.textContent = target
    ? `Target: ${target.type} ${target.title || target.text || target.id} (${target.id})`
    : "Target: the whole board";
  body.append(targetLabel);

  const fields = document.createElement("div");
  fields.className = "mn-share-fields";
  const permissionLabel = document.createElement("label");
  permissionLabel.textContent = "Access type";
  const permissionWrap = document.createElement("span");
  permissionWrap.className = "ky-select";
  const permission = document.createElement("select");
  permission.className = "ky-input";
  for (const [value, label] of [
    ["view", "View only"],
    ["comment", "Can comment"],
    ["edit", "Can edit"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    permission.append(option);
  }
  const chevron = document.createElement("span");
  chevron.className = "ky-chevron";
  chevron.setAttribute("aria-hidden", "true");
  permissionWrap.append(permission, chevron);
  permissionLabel.append(permissionWrap);

  const passwordLabel = document.createElement("label");
  passwordLabel.textContent = "Password (optional)";
  const password = document.createElement("input");
  password.className = "ky-input";
  password.type = "password";
  password.autocomplete = "new-password";
  password.placeholder = "12+ characters";
  passwordLabel.append(password);

  const expiryLabel = document.createElement("label");
  expiryLabel.textContent = "Expiry days (optional)";
  const expiry = document.createElement("input");
  expiry.className = "ky-input";
  expiry.type = "number";
  expiry.min = "1";
  expiry.max = "365";
  expiry.placeholder = "Never";
  expiryLabel.append(expiry);

  const downloadLabel = document.createElement("label");
  downloadLabel.className = "mn-share-check";
  const download = document.createElement("input");
  download.type = "checkbox";
  const downloadText = document.createElement("span");
  downloadText.textContent = "Allow asset downloads";
  downloadLabel.append(download, downloadText);
  fields.append(permissionLabel, passwordLabel, expiryLabel, downloadLabel);
  body.append(fields);
  window.KySelect?.enhanceAll(fields);

  const tokenOutput = document.createElement("p");
  tokenOutput.className = "mn-share-token";

  const actions = document.createElement("div");
  actions.className = "mn-share-actions";
  actions.append(
    button("Create share link", "mn-btn mn-btn-primary", async () => {
      try {
        const created = await sharing.createShare(projectId, {
          scope,
          targetId: target?.id,
          permission: permission.value,
          password: password.value,
          expiresInDays: expiry.value ? Number(expiry.value) : undefined,
          downloadAllowed: download.checked,
        });
        const url = connectedShareUrl(created) || sharing.shareUrl(created.token);
        tokenOutput.textContent = url;
        tokenOutput.dataset.url = url;
        toast("Share link created. Copy it now.");
      } catch (error) {
        toast(error.message);
      }
    })
  );
  actions.append(
    button("Copy last link", "mn-btn mn-btn-quiet", async () => {
      if (!tokenOutput.dataset.url) return toast("Create a link first");
      try {
        await navigator.clipboard.writeText(tokenOutput.dataset.url);
        toast("Share link copied");
      } catch {
        toast("Could not copy the link");
      }
    })
  );
  body.append(actions, tokenOutput);

  const linksHeading = document.createElement("div");
  linksHeading.className = "mn-share-section-title";
  linksHeading.textContent = "Active links";
  body.append(linksHeading);

  const list = document.createElement("ul");
  list.className = "mn-share-list";
  try {
    const shares = await sharing.listShares(projectId);
    for (const entry of shares.filter((item) => !item.revoked)) {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = `${entry.scope}${entry.targetId ? " · " + entry.targetId : ""} · ${entry.permission}`;
      const revoke = button("Revoke", "mn-btn mn-btn-quiet", async () => {
        try {
          await sharing.revokeShare(projectId, entry.id);
          toast("Share link revoked");
          await renderPanel();
        } catch (error) {
          toast(error.message);
        }
      });
      item.append(label, revoke);
      list.append(item);
    }
    if (!list.children.length) {
      const empty = document.createElement("li");
      empty.textContent = "No active links.";
      empty.className = "muted";
      list.append(empty);
    }
  } catch (error) {
    list.textContent = error.message;
  }
  body.append(list);
}
