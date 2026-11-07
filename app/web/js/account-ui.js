// Account UI: topbar avatar, anchored account popover and the first-run sign-in gate.

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
} from "./auth.js";
import { openSettingsPage } from "./settings.js";

let avatarButton = null;
let popover = null;
let gate = null;
let gateKeyHandler = null;

const HISTORY_LIMIT = 20;
const GUEST_KEY = "mn.auth.guest";
const ACTION_LABELS = {
  "auth.setup": "Admin account created",
  "auth.login": "Signed in",
  "auth.logout": "Signed out",
  "auth.logout_all": "Signed out of every session",
  "auth.password_changed": "Password changed",
  "auth.profile_updated": "Profile updated",
};

const AVATAR_TONES = 6;

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
  const memberRole = user.memberRole === "commenter" ? "commenter" : user.memberRole === "viewer" ? "viewer" : "editor";
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

function continueAsGuest() {
  try {
    localStorage.setItem(GUEST_KEY, "1");
  } catch {
    /* storage is optional */
  }
  closeGate();
  notify("Continuing as a guest");
}

// The desktop host persists the session file, the web host always uses a 12 hour cookie.
function rememberFieldMarkup() {
  if (bridge.hasWeb) {
    return `<p class="mn-account-note">This browser session lasts 12 hours.</p>`;
  }
  return `<label class="ky-check"><input type="checkbox" name="remember" checked />Stay signed in on this computer</label>`;
}

// ------------------------------------------------------------------ avatar

export function initAccountUI(elements = {}) {
  if (avatarButton) return;
  avatarButton = elements.accountBtn || document.getElementById("account-btn");
  if (!avatarButton) return;
  avatarButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleAccountPopover();
  });
  window.addEventListener("mn:open-account", () => openAccountPopover());
  subscribeAuth(() => {
    renderAvatar();
    if (popover) {
      renderAccountPopover();
      void fillHistory();
    }
  });
  renderAvatar();
}

function renderAvatar() {
  if (!avatarButton) return;
  const user = authState().user;
  const tone = toneFor(user);
  avatarButton.textContent = initialsFor(user);
  avatarButton.dataset.tone = tone;
  avatarButton.classList.toggle("is-guest", !user);
  const label = user
    ? `Account menu for ${displayNameFor(user)}${user.role === "admin" ? ", admin" : ""}`
    : "Account menu, not signed in";
  avatarButton.setAttribute("aria-label", label);
  avatarButton.setAttribute("title", label);
  const color = String(user?.avatarColor || "");
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    avatarButton.style.setProperty(
      "--mn-avatar-bg",
      `color-mix(in srgb, ${color} 32%, var(--ky-control-active))`
    );
  } else {
    avatarButton.style.removeProperty("--mn-avatar-bg");
  }
}

// ------------------------------------------------------------------ popover

function toggleAccountPopover() {
  if (popover) closeAccountPopover();
  else openAccountPopover();
}

export function openAccountPopover() {
  if (popover || !avatarButton) return;
  popover = document.createElement("div");
  popover.className = "mn-account-pop";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Account menu");
  document.body.append(popover);
  renderAccountPopover();
  positionAccountPopover();
  document.addEventListener("pointerdown", onOutsidePointer, true);
  window.addEventListener("keydown", onPopoverKeyDown, true);
  window.addEventListener("resize", positionAccountPopover);
  popover.addEventListener("click", onPopoverClick);
  popover.addEventListener("submit", onPopoverSubmit);
  void fillHistory();
}

export function closeAccountPopover() {
  if (!popover) return;
  popover.remove();
  popover = null;
  document.removeEventListener("pointerdown", onOutsidePointer, true);
  window.removeEventListener("keydown", onPopoverKeyDown, true);
  window.removeEventListener("resize", positionAccountPopover);
}

function positionAccountPopover() {
  if (!popover || !avatarButton) return;
  const rect = avatarButton.getBoundingClientRect();
  const top = rect.width ? Math.round(rect.bottom + 8) : 34;
  const right = rect.width ? Math.round(window.innerWidth - rect.right) : 8;
  popover.style.top = `${top}px`;
  popover.style.right = `${Math.max(8, right)}px`;
}

function onOutsidePointer(event) {
  if (popover && !popover.contains(event.target) && !avatarButton?.contains(event.target)) {
    closeAccountPopover();
  }
}

function onPopoverKeyDown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeAccountPopover();
  }
}

function onPopoverSubmit(event) {
  if (!event.target.matches('[data-role="password-form"]')) return;
  event.preventDefault();
  void submitPasswordChange(event.target);
}

function onPopoverClick(event) {
  const button = event.target.closest("[data-account-action]");
  if (!button) return;
  const action = button.dataset.accountAction;
  if (action === "close") {
    closeAccountPopover();
  } else if (action === "sign-in") {
    closeAccountPopover();
    openLoginOverlay({ dismissible: true });
  } else if (action === "setup") {
    closeAccountPopover();
    openSetupOverlay();
  } else if (action === "open-settings") {
    closeAccountPopover();
    openSettingsPage();
  } else if (action === "logout") {
    void doLogout();
  } else if (action === "logout-all") {
    void doLogoutAll();
  }
}

function renderAccountPopover() {
  if (!popover) return;
  const state = authState();
  const user = state.user;
  const admin = Boolean(user && user.role === "admin");
  popover.innerHTML = `
    ${popoverHead(user)}
    <div class="mn-account-scroll">
      ${accountSection(user, state)}
      ${settingsSection(user)}
      ${historySection(user)}
    </div>
    ${popoverFoot(admin, Boolean(user))}`;
}

function popoverHead(user) {
  const tone = toneFor(user);
  const name = displayNameFor(user);
  const handle = user ? `@${user.username}` : "Not signed in";
  const role = roleLabel(user);
  return `
    <header class="mn-account-pop-head">
      <span class="mn-account-identity">
        <span class="mn-account-chip" data-tone="${escape(tone)}"${avatarColorStyle(user)}>${escape(initialsFor(user))}</span>
        <span class="mn-account-names">
          <span class="mn-account-name">${escape(name)}</span>
          <span class="mn-account-handle">${escape(handle)} · ${escape(role)}</span>
        </span>
      </span>
      <button type="button" class="mn-icon-btn" data-account-action="close" title="Close" aria-label="Close account menu">${icon(
        "close",
        12
      )}</button>
    </header>`;
}

function accountSection(user, state) {
  if (user) {
    return `
      <section class="mn-account-section">
        <h3 class="mn-account-section-title">Account</h3>
        <div class="mn-account-row"><span>Username</span><span class="mn-account-value">@${escape(user.username || "")}</span></div>
        <div class="mn-account-row"><span>Email</span><span class="mn-account-value">${escape(user.email || "Not set")}</span></div>
      </section>`;
  }
  const setup = state.available && state.userCount === 0
    ? `<button type="button" class="mn-btn mn-btn-quiet" data-account-action="setup">Create admin account</button>`
    : "";
  return `
    <section class="mn-account-section">
      <h3 class="mn-account-section-title">Account</h3>
      <p class="mn-account-note">Local boards work without an account. ${escape(totalCountLabel(state.userCount))} on this computer.</p>
      <div class="mn-account-actions">
        ${setup}
        <button type="button" class="mn-btn mn-btn-primary" data-account-action="sign-in">Sign in</button>
      </div>
    </section>`;
}

function settingsSection(user) {
  if (!user) {
    return `
      <section class="mn-account-section">
        <h3 class="mn-account-section-title">Settings</h3>
        <div class="mn-account-row"><span>Role</span><span class="mn-account-value">Guest</span></div>
        <div class="mn-account-row"><span>Status</span><span class="mn-account-value">Local only</span></div>
        <p class="mn-account-note">Sign in to change your password and manage sessions.</p>
      </section>`;
  }
  return `
    <section class="mn-account-section">
      <h3 class="mn-account-section-title">Settings</h3>
      <div class="mn-account-row"><span>Role</span><span class="mn-account-value">${escape(roleLabel(user))}</span></div>
      <div class="mn-account-row"><span>Status</span><span class="mn-account-value">${escape(statusLabel(user.status))}</span></div>
      <div class="mn-account-row"><span>Last login</span><span class="mn-account-value">${escape(lastLoginLabel(user))}</span></div>
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
      <button type="button" class="mn-btn mn-btn-quiet mn-account-wide" data-account-action="open-settings">Open settings</button>
    </section>`;
}

function historySection(user) {
  if (!user) {
    return `
      <section class="mn-account-section">
        <h3 class="mn-account-section-title">History</h3>
        <p class="mn-account-note">Sign in to see account activity.</p>
      </section>`;
  }
  return `
    <section class="mn-account-section">
      <h3 class="mn-account-section-title">History</h3>
      <div class="mn-account-history" data-role="history">Loading history...</div>
    </section>`;
}

function popoverFoot(admin, signedIn) {
  if (!admin && !signedIn) return "";
  return `
    <footer class="mn-account-pop-foot">
      ${
        admin
          ? `<button type="button" class="mn-btn mn-account-admin" disabled>Admin Panel (coming in M3)</button>`
          : ""
      }
      ${
        signedIn
          ? `<button type="button" class="mn-btn mn-btn-danger-outline" data-account-action="logout">Log out</button>`
          : ""
      }
    </footer>`;
}

function historyLabel(action) {
  return ACTION_LABELS[action] || String(action || "Account activity").replace(/[._]/g, " ");
}

function historyRow(entry) {
  if (!entry) return "";
  const action = historyLabel(entry.action);
  const actor = entry.actorName || entry.actor_name || "";
  const when = formatStamp(entry.createdAt ?? entry.created_at) || "Just now";
  return `
    <div class="mn-account-history-row">
      <span class="mn-account-history-action">${escape(action)}</span>
      ${actor ? `<span class="mn-account-history-actor">${escape(actor)}</span>` : ""}
      <span class="mn-account-history-time">${escape(when)}</span>
    </div>`;
}

async function fillHistory() {
  const box = popover?.querySelector('[data-role="history"]');
  if (!box) return;
  try {
    const data = await loadHistory(HISTORY_LIMIT, 0);
    if (!popover) return;
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    box.innerHTML = entries.length
      ? entries.map(historyRow).join("")
      : `<span class="mn-account-note">No account activity yet.</span>`;
  } catch {
    const current = popover?.querySelector('[data-role="history"]');
    if (current) current.textContent = "History is unavailable.";
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

async function doLogout() {
  try {
    await logout();
  } catch (error) {
    notify(error?.message || "Could not log out");
    return;
  }
  closeAccountPopover();
  renderAvatar();
  notify("Signed out");
  if (authState().requireLogin) openLoginOverlay({ dismissible: false });
}

async function doLogoutAll() {
  try {
    await logoutAll();
  } catch (error) {
    notify(error?.message || "Could not log out everywhere");
    return;
  }
  closeAccountPopover();
  renderAvatar();
  notify("Signed out everywhere");
  if (authState().requireLogin) openLoginOverlay({ dismissible: false });
}

// ------------------------------------------------------------------ gate

export async function initAccountGate() {
  if (!bridge.hasTauri && !bridge.hasWeb) return;
  const state = await initAuth();
  if (!state.available) return;
  let guestChosen = false;
  try {
    guestChosen = localStorage.getItem(GUEST_KEY) === "1";
  } catch {
    guestChosen = false;
  }
  if (!state.user && state.requireLogin) openLoginOverlay({ dismissible: false });
  else if (!state.user && state.userCount === 0 && !guestChosen) openSetupOverlay();
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
        ${rememberFieldMarkup()}
        <p class="mn-account-note">Server accounts arrive in M4. Local boards never require an account.</p>
        <p class="mn-onboard-status" data-role="status" role="status"></p>
        <div class="mn-onboard-actions">
          <button type="button" class="mn-btn mn-btn-quiet" data-role="continue-local">Continue locally</button>
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
  gate.querySelector('[data-role="continue-local"]').addEventListener("click", () => {
    continueAsGuest();
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
  const guestButton = dismissible && state.guestAllowed
    ? `<button type="button" class="mn-btn mn-btn-quiet" data-role="continue-local">Continue locally</button>`
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
        ${rememberFieldMarkup()}
        <p class="mn-onboard-status" data-role="status" role="status"></p>
        <div class="mn-onboard-actions">
          ${guestButton}
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
  gate.querySelector('[data-role="continue-local"]')?.addEventListener("click", () => {
    continueAsGuest();
  });
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
    remember: form.elements.remember ? Boolean(form.elements.remember.checked) : true,
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
      remember: values.remember,
    });
    try {
      localStorage.removeItem(GUEST_KEY);
    } catch {
      /* storage is optional */
    }
    closeGate();
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
      remember: form.elements.remember ? Boolean(form.elements.remember.checked) : true,
    });
    try {
      localStorage.removeItem(GUEST_KEY);
    } catch {
      /* storage is optional */
    }
    closeGate();
    renderAvatar();
    notify("Signed in");
  } catch (error) {
    setFormStatus(status, error?.message || "Could not sign in.", true);
  } finally {
    submit.disabled = false;
  }
}
