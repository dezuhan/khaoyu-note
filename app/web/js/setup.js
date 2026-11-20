// First-run flag left behind by the reset flow. The app has exactly one storage direction now: the
// local SQLite database, so the gate only clears the flag and lets the normal boot continue.

const FLAG = "ky.setupRequired";

export function setupRequired() {
  try {
    return localStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}

export async function initSetupGate() {
  if (!setupRequired()) return false;
  try {
    localStorage.removeItem(FLAG);
    localStorage.setItem("ky.storageMode", "local");
  } catch {
    /* private mode */
  }
  return false;
}
