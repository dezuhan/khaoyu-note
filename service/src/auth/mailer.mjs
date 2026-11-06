import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function createFileMailer(config, logger) {
  fs.mkdirSync(config.outboxDir, { recursive: true, mode: 0o700 });
  return {
    async send({ to, subject, text, link, kind }) {
      const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const payload = {
        id,
        to,
        subject,
        text,
        link,
        kind,
        queuedAt: new Date().toISOString(),
      };
      const target = path.join(config.outboxDir, `${id}.json`);
      fs.writeFileSync(target, JSON.stringify(payload, null, 2), { mode: 0o600 });
      logger.info("mail.queued", { id, kind });
      return { id, target };
    },
  };
}

export function readOutbox(config, id) {
  return JSON.parse(fs.readFileSync(path.join(config.outboxDir, `${id}.json`), "utf8"));
}
