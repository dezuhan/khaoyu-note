import { $, api, initTheme, isEmail, setBusy, setStatus } from "./auth-common.js";

initTheme();
const form = $("reset-form");
const submit = $("reset-submit");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = $("email").value.trim();
  const currentPassword = $("current-password").value;
  const password = $("password").value;
  if (!isEmail(email)) {
    setStatus("Enter a valid email address.", "error");
    return;
  }
  if (!currentPassword) {
    setStatus("Enter your current password.", "error");
    return;
  }
  if (password.length < 12) {
    setStatus("Use at least 12 characters for the new password.", "error");
    return;
  }
  if (password !== $("confirm").value) {
    setStatus("The new passwords do not match.", "error");
    return;
  }
  setBusy(submit, true);
  setStatus("Updating your password...");
  try {
    await api("/api/v1/auth/reset-password", {
      method: "POST",
      body: { email, currentPassword, newPassword: password },
    });
    window.location.replace("/login?reset=1");
  } catch (error) {
    setStatus(error.message || "Could not reset the password.", "error");
    setBusy(submit, false);
  }
});
