export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const BLOCKED_EXTENSIONS = new Set([
  "exe",
  "msi",
  "bat",
  "cmd",
  "ps1",
  "scr",
  "com",
  "dll",
  "jar",
  "vbs",
  "js",
  "lnk",
]);

export function fileExtension(name) {
  return String(name || "").split(".").pop().toLowerCase();
}

export function isBlockedUpload(name) {
  return BLOCKED_EXTENSIONS.has(fileExtension(name));
}

export function reportUploadProblem(message) {
  window.dispatchEvent(new CustomEvent("mn:toast", { detail: { message } }));
}

// Card tools that are temporarily disabled. Their cards still render, and local media is uploaded
// through the Upload tool, but the rail, shortcuts, palette and drop handling stop creating new
// ones. Settings lists them with a disabled status so the state is discoverable.
export const TEMPORARILY_DISABLED_TOOLS = {
  map: "Map is temporarily disabled.",
  video: "Video links are temporarily disabled. Upload a local video instead.",
  audio: "Audio links are temporarily disabled. Upload a local file instead.",
};

export function toolDisabledReason(key) {
  return TEMPORARILY_DISABLED_TOOLS[key] || "";
}

// Temporarily disabled cards are hidden from boards and templates. This is different from hiding a
// tool in Settings, which only removes the rail button and leaves the feature available.
export function isTemporarilyDisabledType(type) {
  return Boolean(TEMPORARILY_DISABLED_TOOLS[type]);
}
