import { hashIp } from "../audit.mjs";
import { sha256 } from "./tokens.mjs";

function emailHash(email) {
  return sha256(String(email || "").trim().toLowerCase());
}

export async function recordLoginAttempt(db, { email, ip, success, secret }) {
  await db.run(
    "INSERT INTO login_attempts (email_hash, ip_hash, success, created_at) VALUES (?, ?, ?, ?)",
    [emailHash(email), hashIp(ip, secret) || "unknown", success ? 1 : 0, Date.now()]
  );
}

export async function loginBlocked(db, { email, ip, config }) {
  const since = Date.now() - config.loginWindowMinutes * 60_000;
  const emailCount = await db.get(
    "SELECT COUNT(*) AS count FROM login_attempts WHERE email_hash = ? AND success = 0 AND created_at >= ?",
    [emailHash(email), since]
  );
  const ipHash = hashIp(ip, config.secret) || "unknown";
  const ipCount = await db.get(
    "SELECT COUNT(*) AS count FROM login_attempts WHERE ip_hash = ? AND success = 0 AND created_at >= ?",
    [ipHash, since]
  );
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

export async function clearLoginFailures(db, { email }) {
  // A successful login only clears the per-email counter. The per-IP counter is kept so
  // an attacker with one valid account cannot reset the shared IP-wide throttle. Failed
  // attempts for this email are removed from both counters because the row is shared.
  await db.run("DELETE FROM login_attempts WHERE email_hash = ? AND success = 0", [emailHash(email)]);
}

// Bounded per-process limiter for endpoints that do not need durable attempt rows.
// Entries expire after one window and the map is capped so memory cannot grow forever.
export function createRateLimiter({ windowMs, max, maxEntries = 10_000 }) {
  const hits = new Map();
  let lastPrune = 0;
  const prune = (nowMs) => {
    if (nowMs - lastPrune < windowMs) return;
    lastPrune = nowMs;
    for (const [key, entry] of hits) {
      if (entry.resetAt <= nowMs) hits.delete(key);
    }
  };
  return {
    check(key) {
      const nowMs = Date.now();
      prune(nowMs);
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= nowMs) {
        if (hits.size >= maxEntries) {
          const oldest = hits.keys().next();
          if (!oldest.done) hits.delete(oldest.value);
        }
        entry = { count: 0, resetAt: nowMs + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      if (entry.count > max) {
        return {
          blocked: true,
          retryAfter: Math.max(1, Math.ceil((entry.resetAt - nowMs) / 1000)),
        };
      }
      return { blocked: false, retryAfter: 0 };
    },
  };
}

export async function pruneLoginAttempts(db, days = 30) {
  return (
    await db.run("DELETE FROM login_attempts WHERE created_at < ?", [
      Date.now() - days * 86_400_000,
    ])
  ).changes;
}
