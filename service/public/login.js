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

const form = $("login-form");
const submit = $("login-submit");

form.addEventListener("submit", async (event) => {
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
  setBusy(submit, true);
  setStatus("Signing in...");
  try {
    await api("/api/v1/auth/login", {
      method: "POST",
      body: {
        email,
        password,
        totp: $("totp").value.trim() || undefined,
      },
    });
    window.location.replace("/admin");
  } catch (error) {
    setStatus(error.message || "Could not sign in.", "error");
    setBusy(submit, false);
  }
});

void redirectIfSignedIn();
