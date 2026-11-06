export function createEventHub({ heartbeatMs = 25_000 } = {}) {
  const rooms = new Map();

  function room(projectId) {
    if (!rooms.has(projectId)) rooms.set(projectId, new Set());
    return rooms.get(projectId);
  }

  function presence(projectId) {
    const clients = room(projectId);
    return {
      type: "presence",
      projectId,
      accounts: new Set([...clients].map((client) => client.accountId)).size,
      connections: clients.size,
    };
  }

  function write(client, event) {
    try {
      client.response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {
      /* client disappears; close handler removes it */
    }
  }

  function publish(projectId, event) {
    for (const client of room(projectId)) write(client, event);
  }

  function subscribe(projectId, accountId, response) {
    const client = {
      projectId,
      accountId,
      response,
      heartbeat: null,
    };
    room(projectId).add(client);
    response.write(": connected\n\n");
    write(client, { ...presence(projectId), type: "presence" });
    client.heartbeat = setInterval(() => {
      try {
        response.write(": ping\n\n");
      } catch {
        /* closed */
      }
    }, heartbeatMs);
    client.heartbeat.unref?.();
    return client;
  }

  function unsubscribe(client) {
    if (!client) return;
    if (client.heartbeat) clearInterval(client.heartbeat);
    const clients = room(client.projectId);
    if (!clients.delete(client)) return;
    publish(client.projectId, presence(client.projectId));
    if (!clients.size) rooms.delete(client.projectId);
  }

  function closeAll() {
    for (const clients of rooms.values()) {
      for (const client of clients) {
        if (client.heartbeat) clearInterval(client.heartbeat);
        try {
          client.response.end();
        } catch {
          /* already closed */
        }
      }
    }
    rooms.clear();
  }

  return { subscribe, unsubscribe, publish, presence, closeAll, rooms };
}
