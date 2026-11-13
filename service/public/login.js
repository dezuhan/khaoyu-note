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

const form = $("login-form");
const submit = $("login-submit");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = $("email").value.trim();
  const password = $("password").value;
  const recovery = $("recovery-code").value.trim();
  if (!isEmail(email)) {
    setStatus("Enter a valid email address.", "error");
    return;
  }
  if (!recovery && !password) {
    setStatus("Enter your password or a backup code.", "error");
    return;
  }
  setBusy(submit, true);
  setStatus("Signing in...");
  try {
    let result;
    if (recovery) {
      result = await api("/api/v1/auth/recovery-login", {
        method: "POST",
        body: { email, code: recovery },
      });
    } else {
      result = await api("/api/v1/auth/login", {
        method: "POST",
        body: {
          email,
          password,
          totp: $("totp").value.trim() || undefined,
        },
      });
    }
    window.location.replace(landingFor(result.account));
  } catch (error) {
    setStatus(error.message || "Could not sign in.", "error");
    setBusy(submit, false);
  }
});

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
