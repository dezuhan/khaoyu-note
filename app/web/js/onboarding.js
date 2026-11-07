// First-run account or server setup. Local-only use is always available.

import * as bridge from "./bridge.js";
import { checkServerReachable, describeConnection, normalizeServerUrl, signIn } from "./sync.js";

const SEEN_KEY = "mn.onboarded";

export function maybeShowOnboarding() {
  if (!bridge.hasTauri && !bridge.hasWeb) return;
  if (localStorage.getItem(SEEN_KEY)) return;
  show();
}

function show() {
  const overlay = document.createElement("div");
  overlay.className = "mn-onboard-overlay";
  overlay.innerHTML = `
    <section class="mn-modal mn-onboard-panel" role="dialog" aria-modal="true" aria-label="Welcome to Khaoyu Note">
      <header class="mn-modal-head"><h2 class="mn-modal-title">Welcome to Khaoyu Note</h2></header>
      <div class="mn-modal-body mn-onboard-body">
        <p class="mn-prefs-note">Your boards are local by default and never require an account. If you use the optional self-hosted service, create an account or connect an existing server.</p>
        <label class="mn-onboard-field">Server URL
          <input class="ky-input" data-role="url" value="http://127.0.0.1:8080" />
        </label>
        <label class="mn-onboard-field">Email
          <input class="ky-input" data-role="email" type="email" autocomplete="username" placeholder="you@example.com" />
        </label>
        <label class="mn-onboard-field">Password
          <input class="ky-input" data-role="password" type="password" autocomplete="current-password" placeholder="Account password" />
        </label>
        <p class="mn-onboard-status" data-role="status"></p>
        <div class="mn-onboard-actions">
          <button type="button" class="mn-btn mn-btn-primary" data-role="create">Create account</button>
          <button type="button" class="mn-btn" data-role="connect">Sign in and connect</button>
          <button type="button" class="mn-btn mn-btn-quiet" data-role="local">Continue locally</button>
        </div>
      </div>
    </section>`;
  document.body.append(overlay);

  const status = overlay.querySelector('[data-role="status"]');
  const url = overlay.querySelector('[data-role="url"]');
  const email = overlay.querySelector('[data-role="email"]');
  const password = overlay.querySelector('[data-role="password"]');
  const connectButton = overlay.querySelector('[data-role="connect"]');
  const finish = () => {
    localStorage.setItem(SEEN_KEY, "1");
    overlay.remove();
  };
  overlay.querySelector('[data-role="local"]').addEventListener("click", finish);
  overlay.querySelector('[data-role="create"]').addEventListener("click", () => {
    let base;
    try {
      base = normalizeServerUrl(url.value);
    } catch (error) {
      status.textContent = error.message || "Enter a valid server URL.";
      return;
    }
    window.open(`${base}/account`, "_blank", "noopener");
    status.textContent = "Account page opened. Create an account there, then sign in here.";
  });
  connectButton.addEventListener("click", async () => {
    const server = String(url.value || "").trim();
    const address = String(email.value || "").trim();
    const secret = String(password.value || "");
    if (!server || !address || !secret) {
      status.textContent = "Enter the server URL, email and password.";
      return;
    }
    connectButton.disabled = true;
    try {
      status.textContent = "Checking connection...";
      const reachable = await checkServerReachable(server);
      if (!reachable.ok) {
        status.textContent = describeConnection(reachable);
        return;
      }
      status.textContent = "Signing in...";
      await signIn({ url: server, email: address, password: secret });
      finish();
      window.dispatchEvent(
        new CustomEvent("mn:toast", {
          detail: { message: "Signed in. Sync a board when ready." },
        })
      );
    } catch (error) {
      status.textContent = error.message || "Could not sign in";
    } finally {
      connectButton.disabled = false;
    }
  });
}
