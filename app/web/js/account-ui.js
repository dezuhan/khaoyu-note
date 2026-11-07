// Account UI: topbar avatar, the Documentation-style account center and the first-run sign-in gate.

import * as bridge from "./bridge.js";
import { icon } from "./icons.js";
import {
  authState,
  changePassword,
  initAuth,
  loadHistory,
  login,
  logout,
  logoutAll,
  setupAdmin,
  subscribeAuth,
  updateProfile,
} from "./auth.js";
import { openSettingsPage } from "./settings.js";

let avatarButton = null;
let modalApi = null;
let accountModal = null;
let gate = null;
let gateKeyHandler = null;
let gateResolve = null;

const AVATAR_TONES = 6;
const HISTORY_LIMIT = 50;

const ACTION_LABELS = {
  "auth.setup": "Admin account created",
  "auth.login": "Signed in",
  "auth.logout": "Signed out",
  "auth.logout_all": "Signed out of every session",
  "auth.password_changed": "Password changed",
  "auth.profile_updated": "Profile updated",
  "board.created": "Created board",
  "board.updated": "Updated board",
  "board.renamed": "Renamed board",
  "board.archived": "Archived board",
  "board.unarchived": "Unarchived board",
  "board.trashed": "Moved board to trash",
  "board.restored": "Restored board",
  "board.deleted": "Deleted board",
};

// ------------------------------------------------------------------ helpers

function escape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function notify(message) {
  window.dispatchEvent(new CustomEvent("mn:toast", { detail: { message } }));
}

function hashText(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function displayNameFor(user) {
  if (!user) return "Guest";
  const composed = `${user.firstName || ""} ${user.lastName || ""}`.trim();
  return user.displayName || composed || user.username || "Account";
}

function initialsFor(user) {
  if (!user) return "G";
  const source = String(user.firstName || user.username || user.displayName || "").trim();
  return source ? source.charAt(0).toUpperCase() : "?";
}

function toneFor(user) {
  if (!user) return "guest";
  const seed = String(user.id || user.username || user.email || "account");
  return String(hashText(seed) % AVATAR_TONES);
}

function avatarColorStyle(user) {
  const color = String(user?.avatarColor || "");
  if (!/^#[0-9a-f]{6}$/i.test(color)) return "";
  return ` style="--mn-avatar-bg: color-mix(in srgb, ${color} 32%, var(--ky-control-active))"`;
}

function roleLabel(user) {
  if (!user) return "Guest";
  if (user.role === "admin") return "Admin";
  const memberRole =
    user.memberRole === "commenter" ? "commenter" : user.memberRole === "viewer" ? "viewer" : "editor";
  return `Member (${memberRole})`;
}

function statusLabel(status) {
  return status === "disabled" ? "Disabled" : "Active";
}

function formatStamp(value) {
  if (!value) return "";
  const stamp = Number(value);
  if (!Number.isFinite(stamp)) return "";
  const date = new Date(stamp < 100000000000 ? stamp * 1000 : stamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function lastLoginLabel(user) {
  if (!user) return "";
  const stamp = formatStamp(user.lastLoginAt);
  return stamp || "First session";
}

function totalCountLabel(count) {
  const total = Number(count) || 0;
  return `${total} ${total === 1 ? "account" : "accounts"}`;
}

function setFormStatus(element, message, isError = false) {
  if (!element) return;
  element.textContent = message || "";
  element.classList.toggle("is-error", Boolean(isError));
}

function finishGate() {
  const resolve = gateResolve;
  gateResolve = null;
  if (resolve) resolve();
}

// The desktop host persists the session file, the web host keeps a 30 day cookie.
function sessionNoteMarkup() {
  return `<p class="mn-account-note">You stay signed in on this ${
    bridge.hasWeb ? "browser for 30 days" : "device"
  }.</p>`;
}

// ------------------------------------------------------------------ avatar

export function initAccountUI(elements = {}) {
  if (avatarButton) return;
  avatarButton = elements.accountBtn || document.getElementById("account-btn");
  modalApi = {
    openModal: elements.openModal,
    closeModal: elements.closeModal,
    confirmAction: elements.confirmAction,
  };
  if (!avatarButton || typeof modalApi.openModal !== "function") return;
  avatarButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openAccountCenter();
  });
  window.addEventListener("mn:open-account", () => openAccountCenter());
  subscribeAuth(() => {
    renderAvatar();
    if (accountModal && accountModal.shell.isConnected) renderAccountShell();
  });
  renderAvatar();
}

function renderAvatar() {
  if (!avatarButton) return;
  const user = authState().user;
  const tone = toneFor(user);
  avatarButton.dataset.tone = tone;
  avatarButton.classList.toggle("is-guest", !user);
  if (user?.avatarUrl) {
    avatarButton.textContent = "";
    avatarButton.classList.add("has-image");
    avatarButton.style.setProperty("--mn-avatar-image", `url("${user.avatarUrl}")`);
  } else {
    avatarButton.textContent = initialsFor(user);
    avatarButton.classList.remove("has-image");
    avatarButton.style.removeProperty("--mn-avatar-image");
  }
  const label = user
    ? `Account menu for ${displayNameFor(user)}${user.role === "admin" ? ", admin" : ""}`
    : "Account menu, not signed in";
  avatarButton.setAttribute("aria-label", label);
  avatarButton.setAttribute("title", label);
  const color = String(user?.avatarColor || "");
  if (!user?.avatarUrl && /^#[0-9a-f]{6}$/i.test(color)) {
    avatarButton.style.setProperty(
      "--mn-avatar-bg",
      `color-mix(in srgb, ${color} 32%, var(--ky-control-active))`
    );
  } else {
    avatarButton.style.removeProperty("--mn-avatar-bg");
  }
}

// ------------------------------------------------------------------ account center

export function openAccountCenter(pane = "information") {
  if (!modalApi?.openModal) return;
  const shell = document.createElement("div");
  shell.className = "mn-docs-shell mn-account-shell";
  accountModal = { shell, active: pane };
  modalApi.openModal({
    title: "Account",
    body: shell,
    footer: [
      {
        label: "Close",
        onClick: () => closeAccountCenter(),
      },
    ],
    width: "min(960px, calc(100vw - 48px))",
  });
  renderAccountShell();
}

function closeAccountCenter() {
  accountModal = null;
  modalApi?.closeModal?.();
}

function accountNavItems() {
  const user = authState().user;
  const items = [];
  if (user && user.role === "admin") items.push(["admin", "Admin Dashboard"]);
  items.push(
    ["information", "Account Information"],
    ["settings", "Account Settings"],
    ["history", "History Activity"]
  );
  return items;
}

function renderAccountShell() {
  if (!accountModal || !accountModal.shell.isConnected) return;
  const user = authState().user;
  const items = accountNavItems();
  if (!items.some(([id]) => id === accountModal.active)) accountModal.active = "information";
  const nav = items
    .map(
      ([id, label]) =>
        `<button type="button" class="mn-docs-nav-item${
          id === accountModal.active ? " is-active" : ""
        }" data-account-pane="${id}">${escape(label)}</button>`
    )
    .join("");
  accountModal.shell.innerHTML = `
    <nav class="mn-docs-nav mn-account-nav" aria-label="Account sections">
      ${nav}
      ${
        user
          ? `<span class="mn-docs-nav-sep"></span>
             <button type="button" class="mn-docs-nav-item mn-account-logout" data-account-action="logout">Log Out</button>`
          : ""
      }
    </nav>
    <div class="mn-docs-pane mn-account-pane" data-role="pane"></div>`;
  for (const button of accountModal.shell.querySelectorAll("[data-account-pane]")) {
    button.addEventListener("click", () => {
      accountModal.active = button.dataset.accountPane;
      renderAccountShell();
    });
  }
  accountModal.shell
    .querySelector('[data-account-action="logout"]')
    ?.addEventListener("click", () => void performLogout());
  renderAccountPane();
}

function renderAccountPane() {
  const pane = accountModal?.shell.querySelector('[data-role="pane"]');
  if (!pane) return;
  const user = authState().user;
  if (accountModal.active === "settings") {
    pane.innerHTML = user ? settingsPane(user) : guestPane("Account Settings", "Sign in to change your profile, password and sessions.");
  } else if (accountModal.active === "history") {
    pane.innerHTML = user ? historyPane() : guestPane("History Activity", "Sign in to see your account activity.");
  } else if (accountModal.active === "admin" && user && user.role === "admin") {
    pane.innerHTML = adminPane(user);
  } else {
    pane.innerHTML = informationPane(user);
  }
  wirePaneActions(pane);
  if (accountModal.active === "history" && user) void fillHistoryPane(pane);
  if (accountModal.active === "admin" && user && user.role === "admin") {
    void bridge
      .appVersion()
      .then((version) => {
        const target = pane.querySelector('[data-role="admin-version"]');
        if (target) target.textContent = version || "unknown";
      })
      .catch(() => {});
  }
}

function identityHead(user) {
  const image = user.avatarUrl
    ? ` style="--mn-avatar-image: url('${escape(user.avatarUrl)}')"`
    : avatarColorStyle(user);
  const classes = `mn-account-chip is-large${user.avatarUrl ? " has-image" : ""}`;
  const content = user.avatarUrl ? "" : escape(initialsFor(user));
  return `
    <div class="mn-account-identity-head">
      <span class="${classes}" data-tone="${escape(toneFor(user))}"${image}>${content}</span>
      <span class="mn-account-identity-copy">
        <strong>${escape(displayNameFor(user))}</strong>
        <span>@${escape(user.username)} · ${escape(roleLabel(user))}</span>
      </span>
    </div>`;
}

function informationPane(user) {
  if (!user) {
    const setup =
      authState().available && authState().userCount === 0
        ? `<button type="button" class="mn-btn mn-btn-quiet" data-account-action="create-admin">Create admin account</button>`
        : "";
    return `
      <h3 class="mn-account-pane-title">Account Information</h3>
      <p class="mn-docs-lead">You are using Khaoyu Note as a guest. Local boards stay available without an account.</p>
      <div class="mn-account-row"><span>Accounts on this computer</span><span class="mn-account-value">${escape(
        totalCountLabel(authState().userCount)
      )}</span></div>
      <div class="mn-account-actions">
        ${setup}
        <button type="button" class="mn-btn mn-btn-primary" data-account-action="sign-in">Sign in</button>
      </div>`;
  }
  return `
    <h3 class="mn-account-pane-title">Account Information</h3>
    ${identityHead(user)}
    <div class="mn-account-row"><span>Username</span><span class="mn-account-value">@${escape(user.username)}</span></div>
    <div class="mn-account-row"><span>Email</span><span class="mn-account-value">${escape(user.email || "Not set")}</span></div>
    <div class="mn-account-row"><span>Role</span><span class="mn-account-value">${escape(roleLabel(user))}</span></div>
    <div class="mn-account-row"><span>Status</span><span class="mn-account-value">${escape(statusLabel(user.status))}</span></div>
    <div class="mn-account-row"><span>Account type</span><span class="mn-account-value">Local account</span></div>
    <div class="mn-account-row"><span>Member since</span><span class="mn-account-value">${escape(
      formatStamp(user.createdAt) || "Unknown"
    )}</span></div>
    <div class="mn-account-row"><span>Last login</span><span class="mn-account-value">${escape(lastLoginLabel(user))}</span></div>`;
}

function guestPane(title, message) {
  return `
    <h3 class="mn-account-pane-title">${escape(title)}</h3>
    <p class="mn-docs-lead">${escape(message)}</p>
    <div class="mn-account-actions">
      <button type="button" class="mn-btn mn-btn-primary" data-account-action="sign-in">Sign in</button>
    </div>`;
}

function settingsPane(user) {
  const color = /^#[0-9a-f]{6}$/i.test(String(user.avatarColor || "")) ? user.avatarColor : "#B262C0";
  return `
    <h3 class="mn-account-pane-title">Account Settings</h3>
    <form class="mn-account-form" data-role="profile-form">
      <span class="mn-account-form-title">Profile</span>
      <div class="mn-account-form-grid">
        <label>First name<input class="ky-input" name="firstName" autocomplete="given-name" value="${escape(
          user.firstName
        )}" /></label>
        <label>Last name<input class="ky-input" name="lastName" autocomplete="family-name" value="${escape(
          user.lastName
        )}" /></label>
        <label>Email<input class="ky-input" name="email" type="email" autocomplete="email" value="${escape(
          user.email
        )}" /></label>
        <label>Avatar color<input class="ky-input mn-account-color" name="avatarColor" type="color" value="${escape(
          color
        )}" /></label>
      </div>
      <p class="mn-account-form-status" data-role="profile-status" role="status"></p>
      <div class="mn-account-actions">
        <button type="submit" class="mn-btn mn-btn-primary">Save profile</button>
        <button type="button" class="mn-btn mn-btn-quiet" data-account-action="reset-avatar">Use automatic color</button>
      </div>
    </form>
    <form class="mn-account-form" data-role="password-form">
      <span class="mn-account-form-title">Change password</span>
      <input class="ky-input" name="currentPassword" type="password" autocomplete="current-password" placeholder="Current password" />
      <input class="ky-input" name="newPassword" type="password" autocomplete="new-password" placeholder="New password (12 or more characters)" />
      <input class="ky-input" name="confirmPassword" type="password" autocomplete="new-password" placeholder="Confirm new password" />
      <p class="mn-account-form-status" data-role="password-status" role="status"></p>
      <div class="mn-account-actions">
        <button type="submit" class="mn-btn">Change password</button>
        <button type="button" class="mn-btn mn-btn-quiet" data-account-action="logout-all">Log out everywhere</button>
      </div>
    </form>
    <div class="mn-account-actions">
      <button type="button" class="mn-btn mn-btn-quiet" data-account-action="open-settings">Open full settings</button>
    </div>`;
}

function historyPane() {
  return `
    <h3 class="mn-account-pane-title">History Activity</h3>
    <p class="mn-account-note">Account and board actions recorded on this computer.</p>
    <div class="mn-account-actions">
      <button type="button" class="mn-btn mn-btn-quiet" data-account-action="history-refresh">Refresh</button>
    </div>
    <div class="mn-account-history" data-role="history">Loading history...</div>`;
}

function adminPane(user) {
  return `
    <h3 class="mn-account-pane-title">Admin Dashboard</h3>
    <p class="mn-docs-lead">Administration for the local database. Only this admin account can open it.</p>
    <div class="mn-admin-grid">
      <div class="mn-admin-card"><span>Accounts</span><strong>${escape(
        totalCountLabel(authState().userCount)
      )}</strong></div>
      <div class="mn-admin-card"><span>Your role</span><strong>${escape(roleLabel(user))}</strong></div>
      <div class="mn-admin-card"><span>App version</span><strong data-role="admin-version">Loading...</strong></div>
    </div>
    <div class="mn-account-actions">
      <button type="button" class="mn-btn" data-account-action="backup">Back up now</button>
      <button type="button" class="mn-btn" data-account-action="integrity">Check database</button>
      <button type="button" class="mn-btn mn-btn-quiet" data-account-action="open-settings">Open settings</button>
    </div>
    <p class="mn-account-form-status" data-role="admin-status" role="status"></p>
    <p class="mn-account-note">User management, role changes and the full audit view arrive in M3.</p>`;
}

function historyLabel(action) {
  return ACTION_LABELS[action] || String(action || "Account activity").replace(/[._]/g, " ");
}

function historyRow(entry) {
  if (!entry) return "";
  const when = formatStamp(entry.createdAt ?? entry.created_at) || "Just now";
  return `
    <div class="mn-account-history-row">
      <span class="mn-account-history-action">${escape(historyLabel(entry.action))}</span>
      <span class="mn-account-history-time">${escape(when)}</span>
    </div>`;
}

async function fillHistoryPane(pane) {
  const box = pane.querySelector('[data-role="history"]');
  if (!box) return;
  try {
    const data = await loadHistory(HISTORY_LIMIT, 0);
    if (!box.isConnected) return;
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    box.innerHTML = entries.length
      ? entries.map(historyRow).join("")
      : `<span class="mn-account-note">No account activity yet.</span>`;
  } catch {
    if (box.isConnected) box.textContent = "History is unavailable.";
  }
}

function wirePaneActions(pane) {
  pane.addEventListener("click", (event) => {
    const button = event.target.closest("[data-account-action]");
    if (!button) return;
    const action = button.dataset.accountAction;
    if (action === "sign-in") {
      closeAccountCenter();
      openLoginOverlay({ dismissible: true });
    } else if (action === "create-admin") {
      closeAccountCenter();
      openSetupOverlay();
    } else if (action === "open-settings") {
      closeAccountCenter();
      openSettingsPage();
    } else if (action === "logout-all") {
      void performLogoutAll();
    } else if (action === "history-refresh") {
      void fillHistoryPane(pane);
    } else if (action === "backup") {
      void runBackup(pane);
    } else if (action === "integrity") {
      void runIntegrity(pane);
    } else if (action === "reset-avatar") {
      void resetAvatar();
    }
  });
  pane.querySelector('[data-role="profile-form"]')?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitProfile(event.target);
  });
  pane.querySelector('[data-role="password-form"]')?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitPasswordChange(event.target);
  });
}

async function submitProfile(form) {
  const status = form.querySelector('[data-role="profile-status"]');
  const firstName = String(form.elements.firstName.value || "").trim();
  const lastName = String(form.elements.lastName.value || "").trim();
  const email = String(form.elements.email.value || "").trim();
  const avatarColor = String(form.elements.avatarColor.value || "");
  if (!firstName) {
    setFormStatus(status, "Enter your first name.", true);
    return;
  }
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    setFormStatus(status, "Enter a valid email address.", true);
    return;
  }
  try {
    await updateProfile({ firstName, lastName, email, avatarColor });
    notify("Profile updated");
  } catch (error) {
    setFormStatus(status, error?.message || "Could not update the profile.", true);
  }
}

async function resetAvatar() {
  const user = authState().user;
  if (!user) return;
  try {
    await updateProfile({
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      avatarColor: "",
    });
    notify("Avatar color reset");
  } catch (error) {
    notify(error?.message || "Could not reset the avatar color");
  }
}

async function submitPasswordChange(form) {
  const status = form.querySelector('[data-role="password-status"]');
  const submit = form.querySelector('button[type="submit"]');
  const currentPassword = String(form.elements.currentPassword?.value || "");
  const newPassword = String(form.elements.newPassword?.value || "");
  const confirmPassword = String(form.elements.confirmPassword?.value || "");
  if (!currentPassword) {
    setFormStatus(status, "Enter your current password.", true);
    return;
  }
  if (newPassword.length < 12) {
    setFormStatus(status, "Use at least 12 characters for the new password.", true);
    return;
  }
  if (newPassword !== confirmPassword) {
    setFormStatus(status, "The new passwords do not match.", true);
    return;
  }
  submit.disabled = true;
  setFormStatus(status, "Changing password...");
  try {
    await changePassword({ currentPassword, newPassword });
    form.reset();
    setFormStatus(status, "Password changed.");
    notify("Password changed");
  } catch (error) {
    setFormStatus(status, error?.message || "Could not change the password.", true);
  } finally {
    submit.disabled = false;
  }
}

async function runBackup(pane) {
  const status = pane.querySelector('[data-role="admin-status"]');
  setFormStatus(status, "Creating backup...");
  try {
    const path = await bridge.backupData();
    setFormStatus(status, `Backup created: ${path}`);
    notify("Backup created");
  } catch (error) {
    setFormStatus(status, error?.message || "Backup failed", true);
  }
}

async function runIntegrity(pane) {
  const status = pane.querySelector('[data-role="admin-status"]');
  setFormStatus(status, "Checking database...");
  try {
    const result = await bridge.dbIntegrity();
    setFormStatus(status, `Integrity: ${result}`);
  } catch (error) {
    setFormStatus(status, error?.message || "Integrity check failed", true);
  }
}

async function performLogout() {
  try {
    await logout();
  } catch (error) {
    notify(error?.message || "Could not log out");
    return;
  }
  window.location.reload();
}

async function performLogoutAll() {
  try {
    await logoutAll();
  } catch (error) {
    notify(error?.message || "Could not log out everywhere");
    return;
  }
  window.location.reload();
}

// ------------------------------------------------------------------ gate

export async function initAccountGate() {
  if (!bridge.hasTauri && !bridge.hasWeb) return;
  const state = await initAuth();
  if (!state.available || state.user) return;
  const wait = new Promise((resolve) => {
    gateResolve = resolve;
  });
  if (state.userCount === 0) openSetupOverlay();
  else openLoginOverlay({ dismissible: false });
  await wait;
}

function closeGate() {
  if (gateKeyHandler) {
    window.removeEventListener("keydown", gateKeyHandler, true);
    gateKeyHandler = null;
  }
  if (gate) {
    gate.remove();
    gate = null;
  }
}

function createGate(markup, dismissible) {
  gate = document.createElement("div");
  gate.className = "mn-onboard-overlay";
  gate.dataset.role = "account-gate";
  gate.innerHTML = markup;
  document.body.append(gate);
  if (dismissible) {
    gateKeyHandler = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeGate();
      }
    };
    window.addEventListener("keydown", gateKeyHandler, true);
    gate.addEventListener("pointerdown", (event) => {
      if (event.target === gate) closeGate();
    });
  }
  return gate;
}

export function openSetupOverlay() {
  if (gate) return;
  createGate(
    `
    <div class="mn-modal mn-onboard-panel mn-auth-panel" role="dialog" aria-modal="true" aria-label="Create the local admin account">
      <header class="mn-modal-head">
        <div>
          <h2 class="mn-modal-title">Set up your local account</h2>
          <p class="mn-modal-subtitle">This account stays on this computer and controls access to your boards.</p>
        </div>
      </header>
      <form class="mn-modal-body mn-onboard-body" data-role="setup-form" novalidate>
        <div class="mn-auth-grid">
          <label class="mn-onboard-field">Username
            <input class="ky-input" name="username" autocomplete="username" spellcheck="false" placeholder="dezuhan" />
          </label>
          <label class="mn-onboard-field">Email
            <input class="ky-input" name="email" type="email" autocomplete="email" placeholder="owner@localhost" />
          </label>
          <label class="mn-onboard-field">First name
            <input class="ky-input" name="firstName" autocomplete="given-name" placeholder="Dezuhan" />
          </label>
          <label class="mn-onboard-field">Last name
            <input class="ky-input" name="lastName" autocomplete="family-name" placeholder="Optional" />
          </label>
          <label class="mn-onboard-field">Password
            <input class="ky-input" name="password" type="password" autocomplete="new-password" placeholder="12 or more characters" />
          </label>
          <label class="mn-onboard-field">Confirm password
            <input class="ky-input" name="confirmPassword" type="password" autocomplete="new-password" placeholder="Repeat the password" />
          </label>
        </div>
        <label class="ky-check"><input type="checkbox" name="claimBoards" checked />Claim existing boards as yours</label>
        ${sessionNoteMarkup()}
        <p class="mn-account-note">An account is required so every board change is attributed. Server accounts arrive in M4.</p>
        <p class="mn-onboard-status" data-role="status" role="status"></p>
        <div class="mn-onboard-actions">
          <button type="submit" class="mn-btn mn-btn-primary" data-role="create-admin">Create admin</button>
        </div>
      </form>
    </div>`,
    false
  );
  const form = gate.querySelector('[data-role="setup-form"]');
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitSetup(form);
  });
  form.elements.username?.focus();
}

export function openLoginOverlay({ dismissible = true } = {}) {
  if (gate) return;
  const state = authState();
  const closeButton = dismissible
    ? `<button type="button" class="mn-icon-btn mn-modal-close" data-role="close" title="Close" aria-label="Close sign in">${icon(
        "close",
        12
      )}</button>`
    : "";
  createGate(
    `
    <div class="mn-modal mn-onboard-panel mn-auth-panel" role="dialog" aria-modal="true" aria-label="Sign in">
      <header class="mn-modal-head">
        <h2 class="mn-modal-title">Sign in</h2>
        ${closeButton}
      </header>
      <form class="mn-modal-body mn-onboard-body" data-role="login-form" novalidate>
        <p class="mn-prefs-note">${
          state.requireLogin
            ? "This app requires an account on this computer. Ask the administrator if you need access."
            : "Sign in with your local account to keep boards attributed and secured."
        }</p>
        <label class="mn-onboard-field">Username or email
          <input class="ky-input" name="identifier" autocomplete="username" spellcheck="false" placeholder="dezuhan" />
        </label>
        <label class="mn-onboard-field">Password
          <input class="ky-input" name="password" type="password" autocomplete="current-password" placeholder="Password" />
        </label>
        ${sessionNoteMarkup()}
        <p class="mn-onboard-status" data-role="status" role="status"></p>
        <div class="mn-onboard-actions">
          <button type="submit" class="mn-btn mn-btn-primary" data-role="sign-in">Sign in</button>
        </div>
      </form>
    </div>`,
    dismissible
  );
  const form = gate.querySelector('[data-role="login-form"]');
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitLogin(form);
  });
  gate.querySelector('[data-role="close"]')?.addEventListener("click", closeGate);
  form.elements.identifier?.focus();
}

function validateSetup(values) {
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(values.username)) {
    return "Use 3 to 32 letters, numbers, dots, dashes or underscores for the username.";
  }
  if (!values.firstName) return "Enter your first name.";
  if (values.firstName.length > 80) return "The first name is too long.";
  if (values.lastName.length > 80) return "The last name is too long.";
  if (!/^[^\s@]+@[^\s@]+$/.test(values.email)) return "Enter an email address like owner@localhost.";
  if (values.password.length < 12 || values.password.length > 200) {
    return "Use a password between 12 and 200 characters.";
  }
  if (values.password !== values.confirmPassword) return "The passwords do not match.";
  return "";
}

async function submitSetup(form) {
  const status = form.querySelector('[data-role="status"]');
  const submit = form.querySelector('[data-role="create-admin"]');
  const values = {
    username: String(form.elements.username.value || "").trim(),
    email: String(form.elements.email.value || "").trim(),
    firstName: String(form.elements.firstName.value || "").trim(),
    lastName: String(form.elements.lastName.value || "").trim(),
    password: String(form.elements.password.value || ""),
    confirmPassword: String(form.elements.confirmPassword.value || ""),
    claimBoards: Boolean(form.elements.claimBoards.checked),
  };
  const problem = validateSetup(values);
  if (problem) {
    setFormStatus(status, problem, true);
    return;
  }
  submit.disabled = true;
  setFormStatus(status, "Creating the admin account...");
  try {
    await setupAdmin({
      username: values.username,
      email: values.email,
      firstName: values.firstName,
      lastName: values.lastName,
      password: values.password,
      claimBoards: values.claimBoards,
      remember: true,
    });
    closeGate();
    finishGate();
    renderAvatar();
    notify(`Admin account created. Welcome, ${values.firstName}.`);
  } catch (error) {
    setFormStatus(status, error?.message || "Could not create the admin account.", true);
  } finally {
    submit.disabled = false;
  }
}

async function submitLogin(form) {
  const status = form.querySelector('[data-role="status"]');
  const submit = form.querySelector('[data-role="sign-in"]');
  const identifier = String(form.elements.identifier.value || "").trim();
  const password = String(form.elements.password.value || "");
  if (!identifier || !password) {
    setFormStatus(status, "Enter your username or email and password.", true);
    return;
  }
  submit.disabled = true;
  setFormStatus(status, "Signing in...");
  try {
    await login({
      identifier,
      password,
      remember: true,
    });
    closeGate();
    finishGate();
    renderAvatar();
    notify("Signed in");
  } catch (error) {
    setFormStatus(status, error?.message || "Could not sign in.", true);
  } finally {
    submit.disabled = false;
  }
}
