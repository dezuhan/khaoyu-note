import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { HttpError } from "./http.mjs";

function startsWith(buffer, bytes) {
  return bytes.every((byte, index) => buffer[index] === byte);
}

export function detectImageType(buffer) {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "image/gif";
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return null;
}

// Non-image asset types are served as attachments and never rendered inline, so an
// explicit allowlist is enough: the browser will not interpret them as active content.
const ALLOWED_NON_IMAGE_TYPES = new Set([
  "application/octet-stream",
  "application/pdf",
  "text/plain",
  "audio/aac",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-m4a",
  "audio/x-wav",
  "video/mp4",
  "video/ogg",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/x-msvideo",
]);

export function validateUpload(contentType, buffer) {
  const normalized = String(contentType || "").toLowerCase();
  if (normalized === "image/svg+xml") {
    throw new HttpError(415, "SVG uploads are not allowed as assets", "unsupported_media_type");
  }
  if (normalized.startsWith("image/")) {
    const detected = detectImageType(buffer);
    if (!detected) {
      throw new HttpError(415, "image content does not match its media type", "unsupported_media_type");
    }
    if (normalized !== detected && !(normalized === "image/jpg" && detected === "image/jpeg")) {
      throw new HttpError(415, "image content does not match its media type", "unsupported_media_type");
    }
    return true;
  }
  if (!ALLOWED_NON_IMAGE_TYPES.has(normalized)) {
    throw new HttpError(415, "content type is not allowed", "unsupported_media_type");
  }
  return true;
}

export async function scanUpload(config, buffer, logger) {
  if (!config.uploadScanCommand) return true;
  fs.mkdirSync(config.tempDir, { recursive: true });
  const target = path.join(config.tempDir, `scan-${crypto.randomUUID()}`);
  fs.writeFileSync(target, buffer, { mode: 0o600 });
  const [command, ...args] = config.uploadScanCommand.split(/\s+/).filter(Boolean);
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(command, [...args, target], { stdio: "ignore", windowsHide: true });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("upload scanner timed out"));
      }, 10_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    if (code !== 0) {
      logger?.warn("upload.scan_rejected", { code });
      return false;
    }
    return true;
  } finally {
    fs.rmSync(target, { force: true });
  }
}
