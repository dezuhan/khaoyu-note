// Share panel for the desktop board UI. Access is configured from the header.

import { state } from "./store.js";
import { loadSyncConfig } from "./sync.js";
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

async function renderPanel() {
  const body = panelShell();
  const board = state.board;
  const projectId = board.sync?.projectId;
  const sync = loadSyncConfig();
  if (!sync.url || !sync.token || !projectId) {
    const note = document.createElement("p");
    note.className = "mn-prefs-note";
    note.textContent = sync.url && sync.token
      ? "Enable server sync for this board before sharing. Sharing is per board."
      : "Connect a server URL and scoped API token in the Sync control before sharing.";
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
  permissionLabel.append(permission);

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

  const tokenOutput = document.createElement("p");
  tokenOutput.className = "mn-share-token";
  body.append(tokenOutput);

  body.append(
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
        const url = sharing.shareUrl(created.token);
        tokenOutput.textContent = url;
        tokenOutput.dataset.url = url;
        toast("Share link created. Copy it now.");
      } catch (error) {
        toast(error.message);
      }
    })
  );

  body.append(
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
