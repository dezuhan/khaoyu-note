export class HttpError extends Error {
  constructor(status, message, code = "http_error", headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

const MAX_BODY = 64 * 1024;

export function applySecurityHeaders(response, config) {
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Cache-Control", "no-store");
  if (config.cookieSecure) {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

export function sendJson(response, status, payload, config, headers = {}) {
  const body = JSON.stringify(payload);
  applySecurityHeaders(response, config);
  for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

export function sendNoContent(response, status, config) {
  applySecurityHeaders(response, config);
  response.writeHead(status);
  response.end();
}

export async function readJson(request) {
  if (!/^application\/json\b/i.test(request.headers["content-type"] || "")) {
    throw new HttpError(415, "JSON body required", "unsupported_media_type");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "request body too large", "payload_too_large");
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value;
  } catch {
    throw new HttpError(400, "invalid JSON body", "invalid_json");
  }
}

export async function readBinary(request, maximum = 100 * 1024 * 1024) {
  const declared = Number(request.headers["content-length"] || 0);
  if (declared > maximum) throw new HttpError(413, "asset is too large", "payload_too_large");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw new HttpError(413, "asset is too large", "payload_too_large");
    chunks.push(chunk);
  }
  if (!size) throw new HttpError(400, "asset is empty", "empty_asset");
  return Buffer.concat(chunks);
}

export function sendBinary(response, config, buffer, { contentType, filename, download = false }) {
  applySecurityHeaders(response, config);
  response.writeHead(200, {
    "Content-Type": contentType || "application/octet-stream",
    "Content-Length": buffer.length,
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${String(filename || "asset").replace(/["\\]/g, "")}"`,
  });
  response.end(buffer);
}

export function appendCookie(response, cookie) {
  const existing = response.getHeader("Set-Cookie");
  const values = Array.isArray(existing) ? existing : existing ? [existing] : [];
  values.push(cookie);
  response.setHeader("Set-Cookie", values);
}

export function clientIp(request, config) {
  if (config.trustProxy) {
    const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return request.socket.remoteAddress || "";
}

export function assertSameOrigin(request, config) {
  const origin = request.headers.origin;
  if (!origin) return;
  let allowed;
  try {
    allowed = new URL(config.publicUrl).origin;
  } catch {
    allowed = config.publicUrl;
  }
  if (origin !== allowed && !config.corsOrigins?.includes(origin)) {
    throw new HttpError(403, "origin not allowed", "origin_denied");
  }}

export function requireString(value, field, maximum = 200) {
  if (typeof value !== "string") throw new HttpError(400, `${field} is required`, "invalid_input");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum) {
    throw new HttpError(400, `${field} is invalid`, "invalid_input");
  }
  return trimmed;
}

export function requirePassword(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 200) {
    throw new HttpError(400, "password must be between 12 and 200 characters", "weak_password");
  }
  return value;
}

export function normalizeEmail(value) {
  const email = requireString(value, "email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "email is invalid", "invalid_email");
  }
  return email;
}
