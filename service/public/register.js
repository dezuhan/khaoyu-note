import {
  $,
  api,
  initTheme,
  isEmail,
  redirectIfSignedIn,
  setBusy,
  setStatus,
} from "./auth-common.js";

initTheme();
const form = $("register-form");
const submit = $("register-submit");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = $("email").value.trim();
  const password = $("password").value;
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
    await api("/api/v1/auth/register", {
      method: "POST",
      body: {
        email,
        displayName: $("name").value.trim() || undefined,
        password,
      },
    });
    window.location.replace("/login?registered=1");
  } catch (error) {
    setStatus(error.message || "Could not create the account.", "error");
    setBusy(submit, false);
  }
});

void redirectIfSignedIn();
