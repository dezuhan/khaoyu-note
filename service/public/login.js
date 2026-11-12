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
    if (recovery) {
      await api("/api/v1/auth/recovery-login", {
        method: "POST",
        body: { email, code: recovery },
      });
    } else {
      await api("/api/v1/auth/login", {
        method: "POST",
        body: {
          email,
          password,
          totp: $("totp").value.trim() || undefined,
        },
      });
    }
    window.location.replace("/admin");
  } catch (error) {
    setStatus(error.message || "Could not sign in.", "error");
    setBusy(submit, false);
  }
});

void redirectIfSignedIn();
