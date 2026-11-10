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

export async function enqueueEmail(db, { to, subject, text, kind }, error) {
  await db.run(
    `INSERT INTO email_jobs (id, to_address, subject, body, kind, attempts, last_error, next_at, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      to,
      subject,
      text,
      kind,
      error ? String(error.message || error).slice(0, 500) : null,
      Date.now(),
      Date.now(),
    ]
  );
}

export async function flushEmailJobs(db, base, logger, limit = 20) {
  const jobs = await db.all(
    "SELECT * FROM email_jobs WHERE sent_at IS NULL AND attempts < 10 AND next_at <= ? ORDER BY next_at LIMIT ?",
    [Date.now(), limit]
  );
  let sent = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      await base.send({
        to: job.to_address,
        subject: job.subject,
        text: job.body,
        kind: job.kind,
      });
      await db.run("UPDATE email_jobs SET sent_at = ? WHERE id = ?", [Date.now(), job.id]);
      sent += 1;
    } catch (error) {
      failed += 1;
      const attempts = Number(job.attempts) + 1;
      const delay = Math.min(30 * 60_000, 60_000 * 2 ** attempts);
      await db.run(
        "UPDATE email_jobs SET attempts = ?, last_error = ?, next_at = ? WHERE id = ?",
        [attempts, String(error.message || error).slice(0, 500), Date.now() + delay, job.id]
      );
      logger?.warn("mail.retry_scheduled", { id: job.id, attempts });
    }
  }
  return { sent, failed, total: jobs.length };
}

export function createQueuedMailer(db, config, logger, baseMailer = null) {
  const base = baseMailer || createMailer(config, logger);
  return {
    async send(payload) {
      try {
        return await base.send(payload);
      } catch (error) {
        await enqueueEmail(db, payload, error);
        logger?.warn("mail.queued_for_retry", { kind: payload.kind });
        return { queued: true, error: error.message };
      }
    },
    async flush(limit = 20) {
      return flushEmailJobs(db, base, logger, limit);
    },
    async close() {
      await base.close?.();
    },
  };
}

export function readOutbox(config, id) {
  return JSON.parse(fs.readFileSync(path.join(config.outboxDir, `${id}.json`), "utf8"));
}
