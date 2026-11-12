# Live collaboration transport

Khaoyu Note uses **SSE for server-to-client listening** plus authenticated HTTP for client-to-server
operations. WebSocket/WebRTC are not required for this app: updates are server-sequenced and must be
persisted in PostgreSQL/SQLite before broadcast.

## Flow

1. A synced board opens `GET /projects/:id/events?ticket=...`.
2. Local saves are diffed against the last synced baseline into granular operations:
   `doc.title`, `card.add`, `card.update`, `card.delete`, with `doc.replace` as a fallback for
   connections/trash/unsupported bulk changes. The operations are appended to a durable per-board
   queue in IndexedDB (`app/web/js/sync-store.js`) before any network call, so a reload, a crashed
   tab or an offline period cannot drop them; the document mirror is stored next to the queue.
3. A single-flight worker posts the batch to `POST /projects/:id/ops` with `baseSeq`. PostgreSQL/SQLite
   allocates per-project sequence numbers atomically and stores `project_ops`. A retry keeps the same
   `opId`, so the server treats it as idempotent. Network failures retry with exponential backoff,
   `card_locked` waits for the lock to expire, and a `seq_conflict` replays `GET /ops?after=`, applies
   the remote operations to the local base and resends the still-pending local patches. A pending
   `doc.replace` that races a remote change is reported as a conflict instead of being forced.
4. Redis fans the committed `ops` event to every service instance; each instance forwards it to local
   SSE clients.
5. Other clients replay `/projects/:id/ops?after=` and apply the operations to their board. If the log
   was pruned they fetch the snapshot and resync.
6. Presence counts are tracked in Redis; the client refreshes its connection TTL periodically.

## Conflict model and locks

- Operations are ordered by the server, so all clients converge on the same card list.
- Distinct cards merge naturally.
- The app acquires a **hard card lock** while an editable field has focus. A second editor receives a
  toast and the server rejects card updates for that lock with `423 card_locked`; updates by the lock
  owner pass.
- This deliberately prevents concurrent same-card text editing instead of silently applying
  last-writer-wins. Character-level CRDT/OT merging is still not implemented, so true simultaneous
  prose editing remains a future editor-layer project.
- A stale `baseSeq` gets `409 seq_conflict`; the client replays newer operations, rebases its local
  diff and retries.
- Locks have a TTL and are heartbeat refreshed; stale locks expire automatically.

## Cursor/selection presence

- Each SSE connection receives a `ready` event with its connection id.
- The client posts its current card/field/offset/length to
  `POST /projects/:id/presence` (debounced on selection changes).
- The server keeps the cursor in the Redis/memory presence entry and broadcasts the user roster.
- Other clients render a remote caret and selection highlight over the editable field, with the
  user's name label. Presence entries expire when the connection closes.

## Operational readiness

- Server-side SSE fanout, tickets, global presence, operation sequencing and Redis cross-instance
  forwarding are implemented and tested.
- Two browser clients have been verified editing distinct cards on the same board live.
- Synthetic concurrent load: **360 operations, 6 clients, ~986 ops/s locally, p95 8 ms, 64 retried
  sequence conflicts, log/card counts consistent** (`npm run test:collab-load`). This is a
  local smoke benchmark, not a production-scale load test.
- Queues are stored per board **and per tab**, so two tabs cannot overwrite each other's pending
  operations. A queue left behind by a closed tab is drained by the next flush from any tab; operation
  ids keep a race between two tabs idempotent. See `docs/sync-model.md` for the full model.
- A `seq_conflict` rebase records overlapping `(cardId, field)` edits as field conflicts, keeps the
  local value (server order wins), and the Sync dialog offers **Use server values** or **Dismiss**.
- Production-scale load testing, penetration testing and CRDT/OT text merging remain release gates;
  see `docs/production-readiness.md`.
