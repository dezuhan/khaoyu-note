import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createRedisBus } from "../src/realtime/redis-bus.mjs";

function responseInto(messages) {
  return {
    write(chunk) {
      messages.push(String(chunk));
    },
    end() {},
  };
}

test(
  "Redis bus fans an event out to connected SSE clients",
  { skip: !process.env.TEST_REDIS_URL },
  async () => {
    const prefix = `khaoyu:test:${crypto.randomUUID()}`;
    const logger = { error() {} };
    const first = await createRedisBus({
      url: process.env.TEST_REDIS_URL,
      prefix,
      logger,
    });
    const second = await createRedisBus({
      url: process.env.TEST_REDIS_URL,
      prefix,
      logger,
    });
    const firstMessages = [];
    const secondMessages = [];
    const firstClient = first.subscribe("project-1", "account-a", responseInto(firstMessages));
    const secondClient = second.subscribe("project-1", "account-b", responseInto(secondMessages));
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      second.publish("project-1", { type: "snapshot", revision: 7 });
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.ok(firstMessages.join("").includes('"revision":7'), "first instance received the event");
      assert.ok(secondMessages.join("").includes('"revision":7'), "second instance received the event");
    } finally {
      first.unsubscribe(firstClient);
      second.unsubscribe(secondClient);
      await first.closeAll();
      await second.closeAll();
    }
  }
);
