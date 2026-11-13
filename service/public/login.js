import {
  $,
  api,
  initTheme,
  isEmail,
  queryMessage,
  redirectIfSignedIn,
  landingFor,
  setBusy,
  setStatus,
} from "./auth-common.js";

initTheme();
const notice = queryMessage();
if (notice) setStatus(notice.message, notice.kind);

const loginStep = $("login-step");
const loginForm = $("login-form");
const loginSubmit = $("login-submit");
const totpForm = $("totp-form");
const backupForm = $("backup-form");
const title = $("auth-title");
const subtitle = $("auth-subtitle");
let challenge = "";

function setPanelStatus(id, message, kind = "") {
  const element = $(id);
  if (!element) return;
  element.textContent = message || "";
  element.classList.remove("is-error", "is-success");
  if (kind) element.classList.add(`is-${kind}`);
}

function showStep(step) {
  loginStep.hidden = step !== "login";
  totpForm.hidden = step !== "totp";
  backupForm.hidden = step !== "backup";
  if (step === "login") {
    title.textContent = "Welcome back";
    subtitle.textContent = "Sign in to your Khaoyu Note service.";
    setBusy(loginSubmit, false);
  } else if (step === "totp") {
    title.textContent = "Two-factor authentication";
    subtitle.textContent = "Confirm the code from your authenticator app.";
    $("totp-code").value = "";
    setBusy($("totp-submit"), false);
    $("totp-code").focus();
  } else {
    title.textContent = "Use a backup code";
    subtitle.textContent = "One backup code can be used once to sign in.";
    $("backup-code").value = "";
    setBusy($("backup-submit"), false);
    $("backup-code").focus();
  }
}

async function completeLogin(result) {
  window.location.replace(landingFor(result.account));
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!isEmail(email)) {
    setStatus("Enter a valid email address.", "error");
    return;
  }
  if (!password) {
    setStatus("Enter your password.", "error");
    return;
  }
  setBusy(loginSubmit, true);
  setStatus("Signing in...");
  try {
    const result = await api("/api/v1/auth/login/begin", {
      method: "POST",
      body: { email, password },
    });
    if (result.totpRequired) {
      challenge = result.challenge;
      setStatus("");
      showStep("totp");
      return;
    }
    await completeLogin(result);
  } catch (error) {
    setStatus(error.message || "Could not sign in.", "error");
    setBusy(loginSubmit, false);
  }
});

totpForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = $("totp-code").value.trim();
  if (!/^\d{6}$/.test(code)) {
    setPanelStatus("totp-status", "Enter the 6-digit code.", "error");
    return;
  }
  const submit = $("totp-submit");
  setBusy(submit, true);
  setPanelStatus("totp-status", "Verifying...");
  try {
    const result = await api("/api/v1/auth/login/totp", {
      method: "POST",
      body: { challenge, code },
    });
    await completeLogin(result);
  } catch (error) {
    if (error.message && /expired/i.test(error.message)) {
      showStep("login");
      setStatus("Your sign-in attempt expired. Enter your password again.", "error");
      return;
    }
    setPanelStatus("totp-status", error.message || "Invalid authentication code.", "error");
    setBusy(submit, false);
  }
});

backupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = $("backup-code").value.trim();
  if (!code) {
    setPanelStatus("backup-status", "Enter a backup code.", "error");
    return;
  }
  const submit = $("backup-submit");
  setBusy(submit, true);
  setPanelStatus("backup-status", "Signing in...");
  try {
    const result = await api("/api/v1/auth/login/backup", {
      method: "POST",
      body: { challenge, code },
    });
    await completeLogin(result);
  } catch (error) {
    if (error.message && /expired/i.test(error.message)) {
      showStep("login");
      setStatus("Your sign-in attempt expired. Enter your password again.", "error");
      return;
    }
    setPanelStatus("backup-status", error.message || "Invalid backup code.", "error");
    setBusy(submit, false);
  }
});

$("backup-link").addEventListener("click", () => showStep("backup"));
$("totp-link").addEventListener("click", () => showStep("totp"));

async function applyAuthFeatures() {
  try {
    const response = await fetch("/api/v1/auth/features", { credentials: "same-origin" });
    if (!response.ok) return;
    const features = await response.json();
    const providers = Array.isArray(features.oidcProviders) ? features.oidcProviders : [];
    const oidc = document.getElementById("oidc-providers");
    const oidcOr = document.getElementById("oidc-or");
    if (oidc && providers.length) {
      oidc.replaceChildren();
      for (const provider of providers) {
        const link = document.createElement("a");
        link.className = "auth-oidc-button";
        link.href = `/api/v1/auth/oidc/${encodeURIComponent(provider.id)}/start?mode=login`;
        link.textContent = `Continue with ${provider.name}`;
        oidc.append(link);
      }
      oidc.hidden = false;
      if (oidcOr) oidcOr.hidden = false;
    }
    const passkeyLink = document.getElementById("passkey-login-link");
    const passkeySeparator = document.getElementById("passkey-login-separator");
    const passkeysEnabled = features.passkeysEnabled === true;
    if (passkeyLink) passkeyLink.hidden = !passkeysEnabled;
    if (passkeySeparator) passkeySeparator.hidden = !passkeysEnabled;
  } catch {
    /* keep the link if the feature endpoint is unavailable */
  }
}

void applyAuthFeatures();
void redirectIfSignedIn();
