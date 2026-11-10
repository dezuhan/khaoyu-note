import { createClient } from "redis";
import { createEventHub } from "../events.mjs";

// Cross-instance SSE fanout. The local hub still owns the socket lifecycle and presence counts for
// this instance; Redis carries published events to every instance. Redis is coordination only, never
// the source of truth for board data.
export async function createRedisBus({ url, prefix = "khaoyu", logger, heartbeatMs = 25_000 } = {}) {
  if (!url) throw new Error("KHAOYU_SERVICE_REDIS_URL is required for the Redis event bus");
  const hub = createEventHub({ heartbeatMs });
  const publisher = createClient({ url });
  const subscriber = publisher.duplicate();
  const channel = `${prefix}:events`;
  const report = (error) => logger?.error("redis.error", { message: error?.message || String(error) });
  publisher.on("error", report);
  subscriber.on("error", report);

  await publisher.connect();
  await subscriber.connect();
  await subscriber.subscribe(channel, (message) => {
    try {
      const event = JSON.parse(message);
      if (!event?.projectId) return;
      hub.publish(event.projectId, event);
    } catch (error) {
      logger?.error("redis.event_decode_failed", { message: error.message });
    }
  });

  return {
    subscribe: (projectId, accountId, response, options) =>
      hub.subscribe(projectId, accountId, response, options),
    unsubscribe: (client) => hub.unsubscribe(client),
    presence: (projectId) => hub.presence(projectId),
    publish(projectId, event) {
      const payload = JSON.stringify({ ...event, projectId });
      void publisher.publish(channel, payload).catch((error) => {
        logger?.error("redis.publish_failed", { message: error.message });
        hub.publish(projectId, { ...event, projectId });
      });
    },
    async closeAll() {
      hub.closeAll();
      await subscriber.quit().catch(() => {});
      await publisher.quit().catch(() => {});
    },
    local: hub,
  };
}
