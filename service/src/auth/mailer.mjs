import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";

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
      return { id, target, delivered: false };
    },
    async close() {},
  };
}

export function createSmtpMailer(config, logger) {
  const smtp = config.smtp;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
  return {
    async send({ to, subject, text, kind }) {
      const info = await transport.sendMail({
        from: smtp.from,
        to,
        subject,
        text,
      });
      logger.info("mail.sent", { kind, messageId: info.messageId });
      return { id: info.messageId, delivered: true };
    },
    async close() {
      transport.close();
    },
  };
}

export function createMailer(config, logger) {
  if (config.smtp?.host) return createSmtpMailer(config, logger);
  return createFileMailer(config, logger);
}

export function readOutbox(config, id) {
  return JSON.parse(fs.readFileSync(path.join(config.outboxDir, `${id}.json`), "utf8"));
}
