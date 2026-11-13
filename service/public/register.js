import {
  $,
  api,
  initTheme,
  isEmail,
  queryMessage,
  redirectIfSignedIn,
  setBusy,
  setStatus,
} from "./auth-common.js";

initTheme();
const notice = queryMessage();
if (notice) setStatus(notice.message, notice.kind);

async function applyAuthFeatures() {
  try {
    const response = await fetch("/api/v1/auth/features", { credentials: "same-origin" });
    if (!response.ok) return;
    const features = await response.json();
    const providers = Array.isArray(features.oidcProviders) ? features.oidcProviders : [];
    const oidc = document.getElementById("oidc-providers");
    const separator = document.getElementById("oidc-or");
    if (!oidc || !providers.length) return;
    oidc.replaceChildren();
    for (const provider of providers) {
      const link = document.createElement("a");
      link.className = "auth-oidc-button";
      link.href = `/api/v1/auth/oidc/${encodeURIComponent(provider.id)}/start?mode=register`;
      link.textContent = `Sign up with ${provider.name}`;
      oidc.append(link);
    }
    oidc.hidden = false;
    if (separator) separator.hidden = false;
  } catch {
    /* keep the email form if the features endpoint is unavailable */
  }
}

const form = $("register-form");
const submit = $("register-submit");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = $("username").value.trim();
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
    setStatus("Use 3 to 32 letters, numbers, dots, dashes or underscores for the username.", "error");
    return;
  }
  if (!isEmail(email)) {
    setStatus("Enter a valid email address.", "error");
    return;
  }
  if (password.length < 12) {
    setStatus("Use at least 12 characters for the password.", "error");
    return;
  }
  if (password !== $("confirm").value) {
    setStatus("The passwords do not match.", "error");
    return;
  }
  setBusy(submit, true);
  setStatus("Creating your account...");
  try {
    const result = await api("/api/v1/auth/register", {
      method: "POST",
      body: {
        username,
        email,
        displayName: $("name").value.trim() || undefined,
        password,
      },
    });
    window.location.replace(
      result?.approval === "pending" ? "/login?pending=1" : "/login?registered=1"
    );
  } catch (error) {
    setStatus(error.message || "Could not create the account.", "error");
    setBusy(submit, false);
  }
});

void applyAuthFeatures();
void redirectIfSignedIn();
