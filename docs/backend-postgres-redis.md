# Backend: PostgreSQL, Redis and realtime editing

Status: accepted. Phase 1 storage conversion, PostgreSQL backup/restore and the Redis SSE fanout are
implemented. The server uses the async storage adapter for both SQLite and PostgreSQL; `team` starts
with PostgreSQL and Redis and fails closed if either is unavailable. Presence is still per-instance,
and SSE tickets, edit locks and the operation log remain for the next realtime phase.

## Decision

- `KHAOYU_SERVICE_PROFILE=team` requires PostgreSQL and Redis. `single-user` keeps SQLite and the
  in-process event hub, so local deployments keep their zero-dependency behaviour.
- PostgreSQL is the system of record for accounts, projects, snapshots, operation logs, revisions,
  shares, assets metadata and audit rows.
- Redis is ephemeral coordination only: pub/sub fanout, presence, edit locks, SSE tickets, rate
  limiting and the worker leader lock. Losing Redis never loses board data.
- Storage is reached through one async adapter (`get`, `all`, `run`, `exec`, `transaction`, `close`)
  for SQLite and PostgreSQL. There is no ORM and no dual-write.
- Realtime transport is SSE plus HTTP operation batches. WebSocket is deferred.
- Realtime editing uses a server-sequenced operation log with snapshot compaction. Text editing is
  serialised with a soft edit lock; geometry and other fields use last-write-wins. CRDT is deferred.
- `PUT /api/v1/projects/:id/snapshot` stays for older clients and becomes a `doc.replace` operation.

## Storage layout

```text
service/src/storage/index.mjs       openStorage, storageKind, assertTeamStorage, isUniqueViolation
service/src/storage/sqlite.mjs      async facade over node:sqlite
service/src/storage/postgres.mjs    pg Pool, ? -> $n placeholders, transactions
service/src/storage/migrations.mjs  async migration runner for both dialects
service/src/storage/migrate-data.mjs durable SQLite -> PostgreSQL row copy
```

The async conversion is staged: first the SQLite adapter replaces direct `DatabaseSync` calls and the
existing test suite must stay green; then the PostgreSQL driver is added and the same suite runs
against both dialects. This avoids changing behaviour and storage at the same time.

## Schema additions

- `projects.last_seq` and `project_snapshots.last_seq` track the operation sequence covered by a
  compacted snapshot.
- `project_ops` stores one row per operation with a per-project `seq`, a client `op_id` for
  idempotency, the actor, the operation type and a JSONB payload. Unique keys are
  `(project_id, seq)` and `(project_id, op_id)`.
- `project_versions` gains `last_seq` and `kind`; revisions are written on compaction, restore and
  explicit checkpoints, not on every operation.
- PostgreSQL stores emails as lowercase `TEXT` with unique indexes on `lower(email)` and
  `lower(username)`; this keeps the SQLite `COLLATE NOCASE` semantics without requiring the `citext`
  extension. `BIGINT` millisecond timestamps, identity columns and `SMALLINT` booleans keep the
  existing code semantics.
- SQLite migrations stay in `service/src/migrations`; PostgreSQL has a baseline in
  `service/src/migrations/postgres/001_baseline` and receives the same new migrations. The baseline
  is validated against the 13 SQLite migrations by a table/column parity test.

### Migration commands

```text
node src/cli.mjs migrate-postgres --database-url <url>
node src/cli.mjs status-postgres --database-url <url>
node src/cli.mjs rollback-postgres --steps 1 --database-url <url>
node src/cli.mjs migrate-to-postgres --sqlite <path> --database-url <url> [--dry-run]
node src/cli.mjs bootstrap-postgres --database-url <url>
node src/cli.mjs backup-postgres --database-url <url>
node src/cli.mjs restore-postgres <backup-directory> [--force] --database-url <url>
```

`migrate-to-postgres` copies durable rows only. Sessions, access/refresh tokens, email tokens, login
attempts, OTPs, share attempts and passkey challenges are skipped so the cutover forces a fresh
sign-in. The target must be a fresh migrated database; object files are copied separately.
PostgreSQL backups are logical JSON snapshots (`format: 3`) with the same encryption and object
checksums as the SQLite backup. `restore-postgres` writes into a migrated database and requires
`--force` when rows already exist. The `TEST_DATABASE_URL` used by CI and local tests must point at a
disposable database because the PostgreSQL parity test drops and recreates the public schema tables.

## API additions

| Endpoint | Purpose |
| --- | --- |
| `POST /api/v1/projects/:id/ops` | Apply an idempotent operation batch with `baseSeq` |
| `GET /api/v1/projects/:id/ops?after=` | Replay operations, or ask for a full resync |
| `POST /api/v1/projects/:id/realtime-ticket` | Single-use, 60 second SSE ticket |
| `GET /api/v1/projects/:id/events?ticket=` | SSE stream of `ops`, `presence`, `lock`, `resync` |
| `POST/DELETE /api/v1/projects/:id/locks` | Acquire, heartbeat or release an advisory edit lock |

New error codes: `seq_conflict`, `resync_required`, `op_invalid`, `op_too_large`, `rate_limited`.
Locks are advisory; the server does not reject a write only because another client holds a lock.

## Data flow

1. A client obtains a realtime ticket and opens the SSE stream.
2. The server validates membership and sends the current snapshot, `lastSeq` and presence.
3. An edit becomes a batch of operations with a client-generated `opId` and `baseSeq`.
4. One PostgreSQL transaction checks the role, validates the operations, handles idempotency, allocates
   the sequence range, stores the operations and applies them to the cached document.
5. After commit, the instance publishes the batch to Redis; every instance forwards it to its local SSE
   clients. The sender receives an acknowledgement with the new `seq`.
6. A reconnecting client asks for operations after `lastSeq`; if the operations were pruned, the server
   answers `resync_required` and the client reloads a snapshot.
7. Compaction writes a snapshot and a revision every `compactOps` operations or `compactMs`
   milliseconds. Old operations are pruned after `opRetentionDays`.

## Failure behaviour

- Redis down: writes continue against PostgreSQL; realtime falls back to the local hub; `/readyz`
  reports `realtime: degraded` rather than failing readiness.
- PostgreSQL down: requests that need data return 503; the process stays alive and reconnects.
- Worker leader loss: another instance acquires the Redis lock; maintenance jobs are idempotent.
- Missing or stale sequence: `seq_conflict` with the operations since the base, or `resync_required`.
- Duplicate `opId`: return the existing sequence instead of writing the operation again.
- Oversized or unauthorised batch: rejected before the transaction with a stable error code.

## Rollout

1. Async SQLite adapter, then PostgreSQL driver and migrations; run the service suite on both.
2. Redis bus, presence, tickets, locks, worker leader; verify two instances.
3. Operation log, client sync integration, compaction and conflict UX.
4. Team onboarding (invitations, account pages, OIDC) and production hardening.

## Out of scope

CRDT/OT character-level merging, WebSocket, multi-region active-active, PostgreSQL row-level security,
object storage migration and moving the desktop app off SQLite.
