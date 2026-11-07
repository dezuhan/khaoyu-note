// First-run account or server setup. Local-only use is always available.

import * as bridge from "./bridge.js";
import { loadSyncConfig, saveSyncConfig } from "./sync.js";

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
        <label class="mn-onboard-field">API token (for an existing account)
          <input class="ky-input" data-role="token" type="password" autocomplete="off" placeholder="projects:read and projects:write" />
        </label>
        <p class="mn-onboard-status" data-role="status"></p>
        <div class="mn-onboard-actions">
          <button type="button" class="mn-btn mn-btn-primary" data-role="create">Create account</button>
          <button type="button" class="mn-btn" data-role="connect">Connect server</button>
          <button type="button" class="mn-btn mn-btn-quiet" data-role="local">Continue locally</button>
        </div>
      </div>
    </section>`;
  document.body.append(overlay);

  const status = overlay.querySelector('[data-role="status"]');
  const url = overlay.querySelector('[data-role="url"]');
  const token = overlay.querySelector('[data-role="token"]');
  const finish = () => {
    localStorage.setItem(SEEN_KEY, "1");
    overlay.remove();
  };
  overlay.querySelector('[data-role="local"]').addEventListener("click", finish);
  overlay.querySelector('[data-role="create"]').addEventListener("click", () => {
    const target = String(url.value || "").replace(/\/+$/, "") + "/account";
    window.open(target, "_blank", "noopener");
    status.textContent = "Account page opened. After verification, connect here with an API token.";
  });
  overlay.querySelector('[data-role="connect"]').addEventListener("click", () => {
    const server = String(url.value || "").trim();
    const apiToken = String(token.value || "").trim();
    if (!server || !apiToken) {
      status.textContent = "Enter both the server URL and an API token.";
      return;
    }
    saveSyncConfig({ url: server, token: apiToken });
    loadSyncConfig();
    finish();
    window.dispatchEvent(
      new CustomEvent("mn:toast", { detail: { message: "Server connected. Sync a board when ready." } })
    );
  });
}
