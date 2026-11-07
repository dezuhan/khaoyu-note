// Account UI: topbar avatar, the first-run sign-in gate and the settings opener.

import * as bridge from "./bridge.js";
import { icon } from "./icons.js";
import { authState, initAuth, login, setupAdmin, subscribeAuth } from "./auth.js";
import { openSettingsPage } from "./settings.js";

let avatarButton = null;
let gate = null;
let gateKeyHandler = null;
let gateResolve = null;

const AVATAR_TONES = 6;

// ------------------------------------------------------------------ helpers

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
  if (!avatarButton) return;
  avatarButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openSettingsPage("account");
  });
  window.addEventListener("mn:open-account", () => openSettingsPage("account"));
  window.addEventListener("mn:open-login", () => openLoginOverlay());
  subscribeAuth(() => renderAvatar());
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
