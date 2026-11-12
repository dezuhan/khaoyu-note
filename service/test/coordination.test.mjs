import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createCoordination } from "../src/realtime/coordination.mjs";

test("memory coordination handles tickets, locks, presence and leadership", async () => {
  const coordination = await createCoordination({});
  const ticket = await coordination.issueTicket({ projectId: "p1", accountId: "a1", ttlMs: 500 });
  assert.equal((await coordination.consumeTicket(ticket.token)).accountId, "a1");
  assert.equal(await coordination.consumeTicket(ticket.token), null);
  const expired = await coordination.issueTicket({ projectId: "p1", accountId: "a1", ttlMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(await coordination.consumeTicket(expired.token), null);

  const lock = await coordination.acquireLock({ projectId: "p1", key: "card:1", accountId: "a1", ttlMs: 500 });
  assert.ok(lock?.token);
  assert.equal(await coordination.acquireLock({ projectId: "p1", key: "card:1", accountId: "a2", ttlMs: 500 }), null);
  assert.equal(await coordination.heartbeatLock({ projectId: "p1", key: "card:1", token: lock.token, ttlMs: 500 }), true);
  assert.equal(await coordination.releaseLock({ projectId: "p1", key: "card:1", token: "wrong" }), false);
  assert.equal(await coordination.releaseLock({ projectId: "p1", key: "card:1", token: lock.token }), true);

  await coordination.joinPresence({ projectId: "p1", accountId: "a1", connectionId: "c1" });
  await coordination.joinPresence({ projectId: "p1", accountId: "a1", connectionId: "c2" });
  await coordination.joinPresence({ projectId: "p1", accountId: "a2", connectionId: "c3" });
  assert.deepEqual(await coordination.presenceCount("p1"), { accounts: 2, connections: 3 });
  await coordination.leavePresence({ projectId: "p1", connectionId: "c2" });
  assert.deepEqual(await coordination.presenceCount("p1"), { accounts: 2, connections: 2 });

  const leader = await coordination.acquireLeader({ ttlMs: 500 });
  assert.ok(leader?.token);
  assert.equal(await coordination.acquireLeader({ ttlMs: 500 }), null);
  assert.equal(await coordination.renewLeader({ token: leader.token, ttlMs: 500 }), true);
  assert.equal(await coordination.releaseLeader({ token: leader.token }), true);
  assert.ok((await coordination.acquireLeader({ ttlMs: 500 }))?.token);
  await coordination.close();
});

test(
  "Redis coordination stores tickets, locks, presence and leadership",
  { skip: !process.env.TEST_REDIS_URL },
  async () => {
    const prefix = `kt_${crypto.randomBytes(4).toString("hex")}`;
    const logger = { error() {} };
    const first = await createCoordination({ redisUrl: process.env.TEST_REDIS_URL, prefix, logger });
    const second = await createCoordination({ redisUrl: process.env.TEST_REDIS_URL, prefix, logger });
    try {
      const ticket = await first.issueTicket({ projectId: "p1", accountId: "a1", ttlMs: 1000 });
      assert.equal((await second.consumeTicket(ticket.token)).accountId, "a1");
      assert.equal(await second.consumeTicket(ticket.token), null);

      const lock = await first.acquireLock({ projectId: "p1", key: "card:1", accountId: "a1", ttlMs: 1000 });
      assert.ok(lock?.token);
      assert.equal(await second.acquireLock({ projectId: "p1", key: "card:1", accountId: "a2", ttlMs: 1000 }), null);
      assert.equal(await second.heartbeatLock({ projectId: "p1", key: "card:1", token: lock.token, ttlMs: 1000 }), true);
      assert.equal(await second.releaseLock({ projectId: "p1", key: "card:1", token: lock.token }), true);

      await first.joinPresence({ projectId: "p1", accountId: "a1", connectionId: "c1" });
      await second.joinPresence({ projectId: "p1", accountId: "a2", connectionId: "c2" });
      assert.deepEqual(await first.presenceCount("p1"), { accounts: 2, connections: 2 });
      await second.leavePresence({ projectId: "p1", connectionId: "c2" });
      assert.deepEqual(await first.presenceCount("p1"), { accounts: 1, connections: 1 });

      const leader = await first.acquireLeader({ ttlMs: 1000 });
      assert.ok(leader?.token);
      assert.equal(await second.acquireLeader({ ttlMs: 1000 }), null);
      assert.equal(await second.releaseLeader({ token: leader.token }), true);
    } finally {
      await first.close();
      await second.close();
    }
  }
);
