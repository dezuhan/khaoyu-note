import fs from "node:fs";
import { loadConfig } from "./config.mjs";
import { createLogger } from "./logger.mjs";
import { openDatabase } from "./db.mjs";
import { assertSchemaCurrent, createService, listen } from "./app.mjs";
import { startWorker } from "./worker.mjs";

const logger = createLogger();

async function main() {
  const config = loadConfig();
  for (const directory of [config.dataDir, config.objectsDir, config.tempDir, config.backupsDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const db = openDatabase(config.databasePath);
  assertSchemaCurrent(db);
  const server = createService({ config, db, logger });
  await listen(server, config);
  const worker = startWorker(db, config, logger);
  logger.info("service.started", {
    host: config.host,
    port: config.port,
    profile: config.profile,
  });

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    logger.info("service.stopping", { signal });
    worker.stop();
    server.close(() => {
      db.close();
      logger.info("service.stopped");
      process.exit(0);
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
