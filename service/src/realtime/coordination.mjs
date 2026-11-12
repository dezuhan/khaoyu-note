// Ephemeral collaboration coordination: single-use SSE tickets, advisory edit locks, presence keys and
// the worker leader lock. Redis is used in team mode; single-user mode gets an in-process fallback.
import crypto from "node:crypto";
import { createClient } from "redis";

function randomToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function tokenKey(prefix, token) {
  return `${prefix}:rt:${crypto.createHash("sha256").update(token).digest("hex")}`;
}

function memoryCoordination(ttl) {
  const tickets = new Map();
  const locks = new Map();
  const presence = new Map();
  let leader = null;
  const alive = (entry) => entry && entry.expiresAt > Date.now();
  return {
    mode: "memory",
    async health() {
      return { ready: true, mode: "memory" };
    },
    async issueTicket({ projectId, accountId, ttlMs = ttl.ticket }) {
      const token = randomToken();
      tickets.set(token, {
        projectId,
        accountId,
        expiresAt: Date.now() + ttlMs,
      });
      return { token, expiresAt: Date.now() + ttlMs };
    },
    async consumeTicket(token) {
      const entry = tickets.get(token);
      tickets.delete(token);
      return alive(entry) ? entry : null;
    },
    async acquireLock({ projectId, key, accountId, ttlMs = ttl.lock }) {
      const lockKey = `${projectId}:${key}`;
      const current = locks.get(lockKey);
      if (alive(current)) return null;
      const entry = { token: randomToken(), accountId, expiresAt: Date.now() + ttlMs };
      locks.set(lockKey, entry);
      return { ...entry, expiresAt: entry.expiresAt };
    },
    async heartbeatLock({ projectId, key, token, ttlMs = ttl.lock }) {
      const lockKey = `${projectId}:${key}`;
      const current = locks.get(lockKey);
      if (!alive(current) || current.token !== token) return false;
      current.expiresAt = Date.now() + ttlMs;
      return true;
    },
    async releaseLock({ projectId, key, token }) {
      const lockKey = `${projectId}:${key}`;
      const current = locks.get(lockKey);
      if (!alive(current) || current.token !== token) return false;
      locks.delete(lockKey);
      return true;
    },
    async joinPresence({ projectId, accountId, connectionId, ttlMs = ttl.presence }) {
      presence.set(`${projectId}:${connectionId}`, { accountId, expiresAt: Date.now() + ttlMs });
    },
    async leavePresence({ projectId, connectionId }) {
      presence.delete(`${projectId}:${connectionId}`);
    },
    async presenceCount(projectId) {
      const accounts = new Set();
      let connections = 0;
      for (const [key, entry] of presence) {
        if (!key.startsWith(`${projectId}:`)) continue;
        if (!alive(entry)) {
          presence.delete(key);
          continue;
        }
        accounts.add(entry.accountId);
        connections += 1;
      }
      return { accounts: accounts.size, connections };
    },
    async acquireLeader({ ttlMs = ttl.leader }) {
      if (alive(leader)) return null;
      leader = { token: randomToken(), expiresAt: Date.now() + ttlMs };
      return { token: leader.token };
    },
    async renewLeader({ token, ttlMs = ttl.leader }) {
      if (!alive(leader) || leader.token !== token) return false;
      leader.expiresAt = Date.now() + ttlMs;
      return true;
    },
    async releaseLeader({ token }) {
      if (leader?.token !== token) return false;
      leader = null;
      return true;
    },
    async close() {},
  };
}

export function createMemoryCoordination(ttl = {}) {
  return memoryCoordination({
    ticket: ttl.ticket ?? 60_000,
    lock: ttl.lock ?? 15_000,
    presence: ttl.presence ?? 45_000,
    leader: ttl.leader ?? 90_000,
  });
}

export async function createCoordination({ redisUrl, prefix = "khaoyu", logger, ttl = {} } = {}) {
  const limits = {
    ticket: ttl.ticket ?? 60_000,
    lock: ttl.lock ?? 15_000,
    presence: ttl.presence ?? 45_000,
    leader: ttl.leader ?? 90_000,
  };
  if (!redisUrl) return memoryCoordination(limits);
  const client = createClient({ url: redisUrl });
  const report = (error) => logger?.error("redis.coordination_error", { message: error?.message || String(error) });
  client.on("error", report);
  await client.connect();
  const scanPresence = async (projectId) => {
    const match = `${prefix}:presence:${projectId}:*`;
    const accounts = new Set();
    let connections = 0;
    let cursor = "0";
    do {
      const result = await client.scan(cursor, { MATCH: match, COUNT: 200 });
      cursor = result.cursor;
      if (result.keys.length) {
        const values = await client.mGet(result.keys);
        for (const value of values) {
          if (!value) continue;
          try {
            const parsed = JSON.parse(value);
            if (parsed?.accountId) accounts.add(parsed.accountId);
            connections += 1;
          } catch {
            /* expired or malformed entry */
          }
        }
      }
    } while (cursor !== "0");
    return { accounts: accounts.size, connections };
  };
  return {
    mode: "redis",
    async health() {
      return { ready: Boolean(client.isReady), mode: "redis" };
    },
    async issueTicket({ projectId, accountId, ttlMs = limits.ticket }) {
      const token = randomToken();
      const expiresAt = Date.now() + ttlMs;
      await client.set(tokenKey(prefix, token), JSON.stringify({ projectId, accountId, expiresAt }), {
        PX: Math.max(1000, ttlMs),
      });
      return { token, expiresAt };
    },
    async consumeTicket(token) {
      const key = tokenKey(prefix, token);
      let value = null;
      try {
        value = await client.getDel(key);
      } catch {
        value = await client.get(key);
        if (value) await client.del(key);
      }
      if (!value) return null;
      try {
        const parsed = JSON.parse(value);
        return parsed.expiresAt > Date.now() ? parsed : null;
      } catch {
        return null;
      }
    },
    async acquireLock({ projectId, key, accountId, ttlMs = limits.lock }) {
      const lockKey = `${prefix}:lock:${projectId}:${key}`;
      const token = randomToken();
      const result = await client.set(lockKey, token, {
        NX: true,
        PX: Math.max(1000, ttlMs),
      });
      if (!result) return null;
      return { token, accountId, expiresAt: Date.now() + ttlMs };
    },
    async heartbeatLock({ projectId, key, token, ttlMs = limits.lock }) {
      const lockKey = `${prefix}:lock:${projectId}:${key}`;
      const script = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
      const result = await client.eval(script, { keys: [lockKey], arguments: [token, String(ttlMs)] });
      return Number(result) === 1;
    },
    async releaseLock({ projectId, key, token }) {
      const lockKey = `${prefix}:lock:${projectId}:${key}`;
      const script = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
      const result = await client.eval(script, { keys: [lockKey], arguments: [token] });
      return Number(result) === 1;
    },
    async joinPresence({ projectId, accountId, connectionId, ttlMs = limits.presence }) {
      await client.set(
        `${prefix}:presence:${projectId}:${connectionId}`,
        JSON.stringify({ accountId }),
        { PX: Math.max(1000, ttlMs) }
      );
    },
    async leavePresence({ projectId, connectionId }) {
      await client.del(`${prefix}:presence:${projectId}:${connectionId}`);
    },
    async presenceCount(projectId) {
      return scanPresence(projectId);
    },
    async acquireLeader({ ttlMs = limits.leader }) {
      const token = randomToken();
      const result = await client.set(`${prefix}:worker:leader`, token, {
        NX: true,
        PX: Math.max(1000, ttlMs),
      });
      return result ? { token } : null;
    },
    async renewLeader({ token, ttlMs = limits.leader }) {
      const script = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
      const result = await client.eval(script, {
        keys: [`${prefix}:worker:leader`],
        arguments: [token, String(ttlMs)],
      });
      return Number(result) === 1;
    },
    async releaseLeader({ token }) {
      const script = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
      const result = await client.eval(script, { keys: [`${prefix}:worker:leader`], arguments: [token] });
      return Number(result) === 1;
    },
    async close() {
      await client.quit().catch(() => {});
    },
  };
}
