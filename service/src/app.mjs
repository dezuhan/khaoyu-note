import http from "node:http";
import { createApiRouter } from "./auth/routes.mjs";
import { migrationStatus } from "./db.mjs";
import { sendJson } from "./http.mjs";

export function assertSchemaCurrent(db) {
  const pending = migrationStatus(db).filter((migration) => !migration.applied);
  if (pending.length) {
    throw new Error(
      `database has ${pending.length} pending migration(s); run the migrate command first`
    );
  }
}

export function logPath(pathname) {
  return pathname.replace(
    /^\/api\/v1\/share\/[^/]+\/access$/,
    "/api/v1/share/[redacted]/access"
  );
}

export function createService({ config, db, logger, mailer }) {
  const api = createApiRouter({ db, config, logger, mailer });
  return http.createServer(async (request, response) => {
    const started = Date.now();
    const url = new URL(request.url || "/", config.publicUrl);
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
