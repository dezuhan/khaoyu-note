import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { createLogger } from "./logger.mjs";
import { openStorage } from "./storage/index.mjs";
import {
  assertSchemaCurrent,
  createFrontendServer,
  createServiceHandler,
} from "./app.mjs";
import { createQueuedMailer } from "./auth/mailer.mjs";
import { createEventHub } from "./events.mjs";
import { createRedisBus } from "./realtime/redis-bus.mjs";
import { createCoordination } from "./realtime/coordination.mjs";
import { pickServicePorts, displayHost } from "./ports.mjs";
import { startWorker } from "./worker.mjs";

const logger = createLogger();

function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function main() {
  const config = { ...loadConfig() };
  for (const directory of [
    config.dataDir,
    config.objectsDir,
    config.tempDir,
    config.backupsDir,
    config.outboxDir,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const db = await openStorage(config);
  await assertSchemaCurrent(db);
  const mailer = createQueuedMailer(db, config, logger);
  const events = config.redisUrl
    ? await createRedisBus({
        url: config.redisUrl,
        prefix: config.redisPrefix,
        logger,
      })
    : createEventHub();
  const coordination = await createCoordination({
    redisUrl: config.redisUrl,
    prefix: config.redisPrefix,
    logger,
    ttl: {
      ticket: config.realtimeTicketTtlMs,
      lock: config.editLockTtlMs,
      presence: 45_000,
      leader: 90_000,
    },
  });

  const { frontendPort, backendPort } = await pickServicePorts(config.host);
  const host = displayHost(config.host);
  const frontendUrl = `http://${host}:${frontendPort}`;
  const backendUrl = `http://${host}:${backendPort}`;
  if (!process.env.KHAOYU_SERVICE_PUBLIC_URL) {
    config.publicUrl = frontendUrl;
  }
  config.port = backendPort;
  config.corsOrigins = [
    ...new Set([...(config.corsOrigins || []), frontendUrl, backendUrl]),
  ];

  const handler = createServiceHandler({ config, db, logger, mailer, events, coordination });
  const backend = http.createServer((request, response) => {
    let pathname = "/";
    try {
      pathname = new URL(request.url || "/", "http://localhost").pathname;
    } catch {
      pathname = "/";
    }
    const allowed =
      pathname.startsWith("/api/") || pathname === "/healthz" || pathname === "/readyz";
    if (!allowed) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not found", code: "not_found" }));
      return;
    }
    void handler(request, response);
  });
  backend.closeStreams = () => handler.closeStreams?.();
  const frontend = createFrontendServer({
    handler,
    backendHost: host,
    backendPort,
    logger,
  });
  await listenOn(backend, backendPort, config.host);
  await listenOn(frontend, frontendPort, config.host);

  const runtime = {
    frontendPort,
    backendPort,
    frontendUrl,
    backendUrl,
    pid: process.pid,
    startedAt: Date.now(),
  };
  fs.writeFileSync(path.join(config.dataDir, "runtime.json"), `${JSON.stringify(runtime, null, 2)}\n`, {
    mode: 0o600,
  });

  const worker = startWorker(db, config, logger, 60_000, mailer, coordination);
  logger.info("service.started", {
    frontendUrl,
    backendUrl,
    profile: config.profile,
  });
  process.stdout.write(`Khaoyu Note service frontend: ${frontendUrl}\n`);
  process.stdout.write(`Khaoyu Note service backend:  ${backendUrl}\n`);
  process.stdout.write(`Admin dashboard:              ${frontendUrl}/admin\n`);

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    logger.info("service.stopping", { signal });
    worker.stop();
    const streamsClosed = Promise.resolve(handler.closeStreams?.()).catch(() => {});
    let pending = 2;
    const done = async () => {
      pending -= 1;
      if (pending > 0) return;
      await db.close();
      await coordination.close?.();
      await mailer.close?.();
      fs.rmSync(path.join(config.dataDir, "runtime.json"), { force: true });
      logger.info("service.stopped");
      process.exit(0);
    };
    streamsClosed.finally(() => {
      backend.close(done);
      frontend.close(done);
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error("service.failed", { message: error.message });
  process.exit(1);
});
