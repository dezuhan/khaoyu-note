import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createApiRouter } from "./auth/routes.mjs";
import { MIGRATIONS_DIR, POSTGRES_MIGRATIONS_DIR } from "./db.mjs";
import { migrationStatus } from "./storage/migrations.mjs";
import { applySecurityHeaders, sendJson } from "./http.mjs";

const PUBLIC_DIR = path.join(import.meta.dirname, "..", "public");
const AUTH_PAGES = {
  "/passkeys": ["passkeys.html", "text/html; charset=utf-8"],
  "/passkeys.js": ["passkeys.js", "text/javascript; charset=utf-8"],
  "/": ["login.html", "text/html; charset=utf-8"],
  "/login": ["login.html", "text/html; charset=utf-8"],
  "/login.js": ["login.js", "text/javascript; charset=utf-8"],
  "/register": ["register.html", "text/html; charset=utf-8"],
  "/register.js": ["register.js", "text/javascript; charset=utf-8"],
  "/reset": ["reset.html", "text/html; charset=utf-8"],
  "/reset.js": ["reset.js", "text/javascript; charset=utf-8"],
  "/auth.css": ["auth.css", "text/css; charset=utf-8"],
  "/auth-common.js": ["auth-common.js", "text/javascript; charset=utf-8"],
  "/account": ["account.html", "text/html; charset=utf-8"],
  "/account.js": ["account.js", "text/javascript; charset=utf-8"],
  "/vendor/qrcode.js": ["vendor/qrcode.js", "text/javascript; charset=utf-8"],
  "/admin": ["admin.html", "text/html; charset=utf-8"],
  "/admin.js": ["admin.js", "text/javascript; charset=utf-8"],
  "/admin.css": ["admin.css", "text/css; charset=utf-8"],
  "/workspace": ["workspace.html", "text/html; charset=utf-8"],
  "/workspace.js": ["workspace.js", "text/javascript; charset=utf-8"],
  "/workspace.css": ["workspace.css", "text/css; charset=utf-8"],
  "/share-view.js": ["share-view.js", "text/javascript; charset=utf-8"],
  "/ui.css": ["ui.css", "text/css; charset=utf-8"],
  "/ky.css": ["ky.css", "text/css; charset=utf-8"],
  "/components.css": ["components.css", "text/css; charset=utf-8"],
  "/icons.js": ["icons.js", "text/javascript; charset=utf-8"],
  "/theme.js": ["theme.js", "text/javascript; charset=utf-8"],
  "/theme-init.js": ["theme-init.js", "text/javascript; charset=utf-8"],
  "/khaoyu-note.svg": ["khaoyu-note.svg", "image/svg+xml"],
  "/favicon-32.png": ["favicon-32.png", "image/png"],
  "/favicon-180.png": ["favicon-180.png", "image/png"],
  "/fonts.css": ["fonts.css", "text/css; charset=utf-8"],
  "/fonts/DMSans-400.woff2": ["fonts/DMSans-400.woff2", "font/woff2"],
  "/fonts/PlayfairDisplay-400.woff2": ["fonts/PlayfairDisplay-400.woff2", "font/woff2"],
  "/fonts/PlusJakartaSans-400.woff2": ["fonts/PlusJakartaSans-400.woff2", "font/woff2"],
  "/fonts/SpaceMono-400.woff2": ["fonts/SpaceMono-400.woff2", "font/woff2"],
  "/fonts/SpaceMono-700.woff2": ["fonts/SpaceMono-700.woff2", "font/woff2"],
};

export async function assertSchemaCurrent(db, { dialect = db.dialect } = {}) {
  const directory = dialect === "postgres" ? POSTGRES_MIGRATIONS_DIR : MIGRATIONS_DIR;
  const pending = (await migrationStatus(db, directory)).filter((migration) => !migration.applied);
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

export function createServiceHandler({ config, db, logger, mailer, events, coordination }) {
  const api = createApiRouter({ db, config, logger, mailer, events, coordination });
  const handler = async (request, response) => {
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
    if (request.method === "GET" && url.pathname === "/account") {
      response.writeHead(302, { Location: "/admin#profile" });
      response.end();
      return;
    }
    // Sharing now lives inside the admin dashboard instead of a separate page.
    if (request.method === "GET" && url.pathname === "/shares") {
      response.writeHead(302, { Location: "/admin#sharing" });
      response.end();
      return;
    }
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
    // The desktop webview and the local web host call /readyz and /healthz cross-origin, so the
    // allowed origins need CORS headers here too, not only on the /api/v1 routes.
    const origin = request.headers.origin;
    if (origin && config.corsOrigins?.includes(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
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
          await db.get("SELECT 1");
          if (!coordination) {
            sendJson(response, 200, { status: "ready" }, config);
            return;
          }
          let realtime = "ok";
          try {
            const health = await coordination.health?.();
            if (health && health.ready === false) realtime = "degraded";
          } catch {
            realtime = "degraded";
          }
          sendJson(response, 200, { status: "ready", realtime }, config);
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
  };
  handler.closeStreams = () => api.closeAll?.();
  return handler;
}

export function createService(options) {
  const handler = createServiceHandler(options);
  const server = http.createServer(handler);
  server.closeStreams = () => handler.closeStreams?.();
  return server;
}

// The frontend listener serves the browser pages and proxies the API to the backend listener.
// Browsers therefore keep one origin for cookies and CSRF while the API has its own port.
export function createFrontendServer({ handler, backendHost, backendPort, logger }) {
  return http.createServer((request, response) => {
    let pathname = "/";
    try {
      pathname = new URL(request.url || "/", "http://localhost").pathname;
    } catch {
      pathname = "/";
    }
    const isApi =
      pathname.startsWith("/api/") || pathname === "/healthz" || pathname === "/readyz";
    if (!isApi) {
      void handler(request, response);
      return;
    }
    const headers = {
      ...request.headers,
      host: `${backendHost}:${backendPort}`,
      "x-forwarded-host": request.headers.host || "",
      "x-forwarded-proto":
        request.headers["x-forwarded-proto"] ||
        (request.socket.encrypted ? "https" : "http"),
    };
    const proxy = http.request(
      {
        host: backendHost,
        port: backendPort,
        path: request.url,
        method: request.method,
        headers,
      },
      (upstream) => {
        response.writeHead(upstream.statusCode || 502, upstream.headers);
        upstream.pipe(response);
      }
    );
    proxy.on("error", (error) => {
      logger?.error?.("http.proxy_failed", { message: error.message });
      if (!response.headersSent) {
        response.writeHead(502, { "Content-Type": "application/json" });
      }
      response.end(JSON.stringify({ error: "backend unavailable", code: "backend_unavailable" }));
    });
    request.pipe(proxy);
  });
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
