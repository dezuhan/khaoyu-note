# Live collaboration transport

Khaoyu Note uses **SSE for server-to-client listening** plus authenticated HTTP for client-to-server
operations. WebSocket/WebRTC are not required for this app: updates are server-sequenced and must be
persisted in PostgreSQL/SQLite before broadcast.

## Flow

1. A synced board opens `GET /projects/:id/events?ticket=...`.
2. Local saves are diffed against the last synced baseline into granular operations:
   `doc.title`, `card.add`, `card.update`, `card.delete`, with `doc.replace` as a fallback for
   connections/trash/unsupported bulk changes.
3. The client posts the batch to `POST /projects/:id/ops` with `baseSeq`. PostgreSQL/SQLite allocates
   per-project sequence numbers atomically and stores `project_ops`.
4. Redis fans the committed `ops` event to every service instance; each instance forwards it to local
   SSE clients.
5. Other clients replay `/projects/:id/ops?after=` and apply the operations to their board. If the log
   was pruned they fetch the snapshot and resync.
6. Presence counts are tracked in Redis; the client refreshes its connection TTL periodically.

## Conflict model

- Operations are ordered by the server, so all clients converge on the same card list.
- Distinct cards/fields merge naturally.
- **Same text field edited concurrently is last-writer-wins.** There is no character-level CRDT/OT or
  cursor/selection awareness yet. Treat highly concurrent prose editing as beta.
- A stale `baseSeq` gets `409 seq_conflict`; the client replays newer operations, rebases its local
  diff and retries.
- Local lock presence is advisory; it does not reject writes.

## Operational readiness

- Server-side SSE fanout, tickets, global presence, operation sequencing and Redis cross-instance
  forwarding are implemented and tested.
- Two browser clients have been verified editing distinct cards on the same board live.
- Production load testing and CRDT/OT text merging are still release gates; see
  `docs/production-readiness.md`.
