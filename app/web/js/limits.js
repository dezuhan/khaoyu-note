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
