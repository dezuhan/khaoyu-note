import http from "node:http";
import { migrationStatus } from "./db.mjs";

export function assertSchemaCurrent(db) {
  const pending = migrationStatus(db).filter((migration) => !migration.applied);
  if (pending.length) {
    throw new Error(
      `database has ${pending.length} pending migration(s); run the migrate command first`
    );
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(body);
}

export function createService({ config, db, logger }) {
  return http.createServer((request, response) => {
    const started = Date.now();
    const url = new URL(request.url || "/", config.publicUrl);
    response.on("finish", () => {
      if (url.pathname !== "/healthz" && url.pathname !== "/readyz") {
        logger.info("http.request", {
          method: request.method,
          path: url.pathname,
          status: response.statusCode,
          durationMs: Date.now() - started,
        });
      }
    });

    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/healthz") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/readyz") {
      try {
        db.prepare("SELECT 1").get();
        sendJson(response, 200, { status: "ready" });
      } catch {
        sendJson(response, 503, { status: "not_ready" });
      }
      return;
    }
    sendJson(response, 404, { error: "not found" });
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
