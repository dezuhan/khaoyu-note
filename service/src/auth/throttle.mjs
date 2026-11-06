import { hashIp } from "../audit.mjs";
import { sha256 } from "./tokens.mjs";

function emailHash(email) {
  return sha256(String(email || "").trim().toLowerCase());
}

export function recordLoginAttempt(db, { email, ip, success, secret }) {
  db.prepare(
    "INSERT INTO login_attempts (email_hash, ip_hash, success, created_at) VALUES (?, ?, ?, ?)"
  ).run(
    emailHash(email),
    hashIp(ip, secret) || "unknown",
    success ? 1 : 0,
    Date.now()
  );
}

export function loginBlocked(db, { email, ip, config }) {
  const since = Date.now() - config.loginWindowMinutes * 60_000;
  const emailCount = db
    .prepare(
      "SELECT COUNT(*) AS count FROM login_attempts WHERE email_hash = ? AND success = 0 AND created_at >= ?"
    )
    .get(emailHash(email), since);
  const ipHash = hashIp(ip, config.secret) || "unknown";
  const ipCount = db
    .prepare(
      "SELECT COUNT(*) AS count FROM login_attempts WHERE ip_hash = ? AND success = 0 AND created_at >= ?"
    )
    .get(ipHash, since);
  const count = Math.max(Number(emailCount.count), Number(ipCount.count));
  if (count < config.loginMaxAttempts) return { blocked: false };
  const extra = Math.max(0, count - config.loginMaxAttempts);
  const progressive = Math.min(900, 30 * 2 ** Math.min(extra, 5));
  return {
    blocked: true,
    retryAfter: progressive,
    attempts: count,
  };
}

export function clearLoginFailures(db, { email, ip, secret }) {
  db.prepare("DELETE FROM login_attempts WHERE email_hash = ? AND success = 0").run(emailHash(email));
  db.prepare("DELETE FROM login_attempts WHERE ip_hash = ? AND success = 0").run(
    hashIp(ip, secret) || "unknown"
  );
}

export function pruneLoginAttempts(db, days = 30) {
  return db
    .prepare("DELETE FROM login_attempts WHERE created_at < ?")
    .run(Date.now() - days * 86_400_000).changes;
}
