import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createApiRouter } from "./auth/routes.mjs";
import { migrationStatus } from "./db.mjs";
import { applySecurityHeaders, sendJson } from "./http.mjs";

const PUBLIC_DIR = path.join(import.meta.dirname, "..", "public");
const AUTH_PAGES = {
  "/passkeys": ["passkeys.html", "text/html; charset=utf-8"],
  "/passkeys.js": ["passkeys.js", "text/javascript; charset=utf-8"],
  "/account": ["account.html", "text/html; charset=utf-8"],
  "/account.js": ["account.js", "text/javascript; charset=utf-8"],
  "/shares": ["shares.html", "text/html; charset=utf-8"],
  "/shares.js": ["shares.js", "text/javascript; charset=utf-8"],
  "/share-view.js": ["share-view.js", "text/javascript; charset=utf-8"],
  "/ui.css": ["ui.css", "text/css; charset=utf-8"],
  "/ky.css": ["ky.css", "text/css; charset=utf-8"],
};

export function assertSchemaCurrent(db) {
  const pending = migrationStatus(db).filter((migration) => !migration.applied);
  if (pending.length) {
    throw new Error(
      `database has ${pending.length} pending migration(s); run the migrate command first`
    );
  }
}

export function logPath(pathname) {
  return pathname
    .replace(/^\/api\/v1\/share\/[^/]+/, "/api/v1/share/[redacted]")
    .replace(/^\/s\/[^/]+$/, "/s/[redacted]");
}

export function createService({ config, db, logger, mailer }) {
  const api = createApiRouter({ db, config, logger, mailer });
  const server = http.createServer(async (request, response) => {
    const started = Date.now();
    let url;
    try {
      url = new URL(request.url || "/", config.publicUrl);
    } catch {
      sendJson(response, 400, { error: "bad request", code: "bad_request" }, config);
      return;
    }
    const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const secure = request.socket.encrypted || (config.trustProxy && forwardedProto === "https");
    if (config.requireHttps && !secure) {
      sendJson(response, 426, { error: "HTTPS required", code: "https_required" }, config);
      return;
    }
    const sharePage = /^\/s\/[^/]+$/.test(url.pathname);
    const authPage =
      request.method === "GET"
        ? AUTH_PAGES[url.pathname] || (sharePage ? ["share.html", "text/html; charset=utf-8"] : null)
        : null;
    if (authPage) {
      applySecurityHeaders(response, config);
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"
      );
      if (sharePage) response.setHeader("X-Robots-Tag", "noindex, nofollow");
      let body;
      try {
        body = fs.readFileSync(path.join(PUBLIC_DIR, authPage[0]));
      } catch (error) {
        logger.error("http.page_failed", { message: error.message });
        sendJson(response, 500, { error: "internal server error" }, config);
        return;
      }
      response.writeHead(200, { "Content-Type": authPage[1] });
      response.end(body);
      return;
    }
    response.on("finish", () => {
      if (url.pathname !== "/healthz" && url.pathname !== "/readyz") {
        logger.info("http.request", {
          method: request.method,
          path: logPath(url.pathname),
          status: response.statusCode,
          durationMs: Date.now() - started,
        });
      }
    });

    try {
      if (await api(request, response)) return;
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/healthz") {
        sendJson(response, 200, { status: "ok" }, config);
        return;
      }
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/readyz") {
        try {
          db.prepare("SELECT 1").get();
          sendJson(response, 200, { status: "ready" }, config);
        } catch {
          sendJson(response, 503, { status: "not_ready" }, config);
        }
        return;
      }
      sendJson(response, 404, { error: "not found" }, config);
    } catch (error) {
      logger.error("http.failed", { message: error.message });
      if (!response.headersSent) {
        sendJson(response, 500, { error: "internal server error" }, config);
      } else {
        response.end();
      }
    }
  });
  server.closeStreams = () => api.closeAll?.();
  return server;
}

export function listen(server, config) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
