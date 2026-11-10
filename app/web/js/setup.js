// First-run storage setup after a reset. The normal local-first boot skips this screen; the reset
// flow sets a one-shot flag so the user explicitly chooses a storage direction before any board is
// created again.

const FLAG = "mn.setupRequired";

export function setupRequired() {
  try {
    return localStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}

function finishLocal() {
  try {
    localStorage.removeItem(FLAG);
    localStorage.setItem("mn.storageMode", "local");
  } catch {
    /* private mode */
  }
  window.location.reload();
}

export async function initSetupGate() {
  if (!setupRequired()) return false;
  await new Promise(() => {
    const overlay = document.createElement("div");
    overlay.className = "mn-overlay mn-setup-overlay";
    const modal = document.createElement("div");
    modal.className = "mn-modal mn-setup-modal";
    overlay.append(modal);
    document.body.append(overlay);

    let step = "mode";
    let mode = null;
    let storage = null;

    const option = (value, title, description, selected, attribute, stepName, disabled = false) => `
      <button type="button" class="mn-setup-option${selected ? " is-selected" : ""}${
        disabled ? " is-disabled" : ""
      }"
        role="radio" aria-checked="${selected ? "true" : "false"}"
        ${disabled ? 'disabled aria-disabled="true"' : ""}
        data-${attribute}="${value}" data-step="${stepName}">
        <span class="mn-setup-radio" aria-hidden="true"></span>
        <span class="mn-setup-copy">
          <strong>${title}${disabled ? ' <span class="mn-setup-soon">Coming soon</span>' : ""}</strong>
          <span>${description}</span>
        </span>
      </button>`;

    const nav = (backStep, nextStep, nextDisabled = false) => `
      <div class="mn-setup-nav">
        <button type="button" class="mn-btn" data-back="${backStep || ""}" ${
          backStep ? "" : "disabled"
        }>Back</button>
        <button type="button" class="mn-btn mn-btn-primary" data-next="${nextStep}" ${
          nextDisabled ? "disabled" : ""
        }>Next</button>
      </div>`;

    const render = () => {
      if (step === "mode") {
        modal.innerHTML = `
          <header class="mn-modal-head"><h2 class="mn-modal-title">Set up Khaoyu Note</h2></header>
          <div class="mn-modal-body">
            <p class="mn-setup-lead">Choose how this installation will store its boards.</p>
            <div class="mn-setup-options" role="radiogroup" aria-label="Storage mode">
              ${option("single", "Single user", "One local database. No Redis, no account required.", mode === "single", "mode", "mode")}
              ${option("collaboration", "Collaboration", "PostgreSQL + Redis, accounts, sharing and a team service. Disabled until the admin dashboard is ready.", mode === "collaboration", "mode", "mode", true)}
            </div>
            ${nav(null, "mode-next", !mode)}
          </div>`;
      } else if (step === "storage") {
        modal.innerHTML = `
          <header class="mn-modal-head"><h2 class="mn-modal-title">Single-user storage</h2></header>
          <div class="mn-modal-body">
            <p class="mn-setup-lead">Keep the database on this computer. Turso is on the roadmap and disabled in this build.</p>
            <div class="mn-setup-options" role="radiogroup" aria-label="Database storage">
              ${option("local", "Local SQLite", "The current database in the app data folder. Works offline.", storage === "local", "storage", "storage")}
              ${option("turso", "Connect to Turso", "libSQL cloud database. Planned; disabled until the Turso adapter and migration flow are ready.", storage === "turso", "storage", "storage", true)}
            </div>
            ${nav("mode", "storage-next", !storage)}
          </div>`;
      } else {
        const isTurso = step === "turso";
        modal.innerHTML = `
          <header class="mn-modal-head"><h2 class="mn-modal-title">${
            isTurso ? "Turso connection" : "Collaboration"
          }</h2></header>
          <div class="mn-modal-body">
            <p class="mn-setup-lead">${
              isTurso
                ? "Turso support is on the roadmap. This build keeps the local SQLite database."
                : "Collaboration needs the self-hosted service with PostgreSQL and Redis. This local web host cannot switch to it from here."
            }</p>
            ${nav(isTurso ? "storage" : "mode", "unavailable", true)}
          </div>`;
      }

      for (const button of modal.querySelectorAll(".mn-setup-option")) {
        button.addEventListener("click", () => {
          if (button.dataset.mode) {
            if (mode !== button.dataset.mode) storage = null;
            mode = button.dataset.mode;
            render();
          } else if (button.dataset.storage) {
            storage = button.dataset.storage;
            render();
          }
        });
      }
      const back = modal.querySelector("[data-back]");
      if (back && !back.disabled) {
        back.addEventListener("click", () => {
          const target = back.dataset.back;
          if (target) {
            step = target;
            render();
          }
        });
      }
      const next = modal.querySelector("[data-next]");
      if (next && !next.disabled) {
        next.addEventListener("click", () => {
          if (step === "mode") {
            step = mode === "single" ? "storage" : "collaboration";
          } else if (step === "storage") {
            if (storage === "local") {
              finishLocal();
              return;
            }
            step = "turso";
          }
          render();
        });
      }
    };

    render();
  });
}
