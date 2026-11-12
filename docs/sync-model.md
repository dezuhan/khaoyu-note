# Sync and conflict model

This document records the decisions behind the server sync client after the durable-queue work. It is
the reference for the remaining CRDT question.

## Layers

| Layer | Where | Purpose |
| --- | --- | --- |
| Durable operation queue | `app/web/js/sync-store.js` (IndexedDB, localStorage fallback) | Keeps every unconfirmed operation per board and per tab, plus the last known local document and the last server document. |
| Queue worker | `app/web/js/sync.js` | Captures local diffs as operations, flushes them in order, retries with backoff, rebases on `seq_conflict`, reports `pending`/`syncing`/`blocked`/`failed`/`conflict`/`synced`. |
| Server order | `service/src/auth/routes.mjs` (`POST /projects/:id/ops`) | Assigns one monotonic `seq` per accepted operation inside the project transaction. This is the single source of truth for ordering. |
| Remote fan-out | SSE + Redis (team profile) | Lets other clients replay the operation log (`GET /projects/:id/ops?after=`). |

Local boards stay in SQLite (`app/src-tauri` or `server.mjs`). A remote workspace board is **not**
mirrored into that SQLite database: it has no local board row, so writing it there would make the
desktop MCP server and local search treat a remote board as a local one and vice versa. The durable
IndexedDB mirror is the local-first cache for those boards: it is the same origin, survives reloads,
opens offline and stores the queue. Choosing IndexedDB also keeps the web host (no Rust bridge) and the
Tauri webview on one code path. A future SQLite mirror is a separate product decision; it would need
new bridge commands and a clear ownership flag for MCP search.

## Per-field last-writer-wins

Operations are granular: `doc.title`, `card.add`, `card.update` (a patch of changed fields),
`card.delete`, `card.move`, `connections.set`, plus `doc.replace` for trash and the few bulk fields
that have no operation yet.

Because the server assigns the order, two clients editing the same card converge on the same result:
their patches merge when they touch different fields and the operation with the higher `seq` wins when
they touch the same field. That is last-writer-wins per field with the server sequence as the
timestamp; no client clock is trusted.

The client makes the overlap visible instead of silent:

1. On `seq_conflict` it replays the remote operations and intersects their touched `(cardId, field)`
   pairs with the still-pending local patches.
2. It records `fieldConflicts` on the durable record (server value, server seq, deleted flag) while
   still resending the local patch, so the local value wins as the later writer.
3. The Sync dialog lists the conflicts and offers **Use server values** (replaces the local fields with
   the recorded server values) or **Dismiss**. The status pill appends
   "N field conflict(s) kept local".

This is intentionally not a modal conflict dialog: the queue must keep working while the user is
offline, and the common case (two people editing different fields) needs no interruption.

## Connections and `doc.replace`

Connection edits used to force a whole-document replacement, which could overwrite unrelated remote
cards. They now travel as `connections.set`, a single operation containing the connection array.
`doc.replace` remains for the trash contents, `parentId`/`archivedAt` changes and oversized diffs
(more than 200 operations). Bulk operations may be up to 4 MB; normal card operations stay at 256 KB.
The operation log body limit is 8 MB.

## Causal clocks and field versions

Every operation carries a small causal clock (`{writerId: counter}`). The client merges the clocks of
the operations it replays, so an edit made after seeing a remote change is causally after it. The
service stores the clock on `project_ops` and keeps one row per `(project, card, field)` in
`project_field_versions` with its `seq`, `clock`, actor and update time.

When an operation arrives for a field whose stored clock is concurrent with the incoming clock
(neither dominates), the server keeps the later `seq` as the winner (last writer per field) and
returns a `fieldConflicts` entry in the ops response with the previous value, `remoteSeq` and
`remoteClock`. This is causal conflict detection on top of the central sequence: the sequence decides
the value, the clocks tell the client that two writers acted without seeing each other, even when the
operation log has already been pruned and a replay alone could not prove it.

The clocks are not a replacement for the sequence and do not make the server multi-master. They become
the ordering mechanism only if writes can happen without a common sequencer (peer-to-peer or
multi-master servers); at that point the same `clock` column is the input to a merge/vector-clock
comparison instead of an advisory conflict signal.

## Text merging and CRDT

The current model is operation-based LWW per field, which converges for card metadata, geometry,
titles and todo lists. For text fields it adds a **three-way merge**: when a rebase replays a remote
change, the local pending change is applied on top of the remote value if the two changes touch
different regions (a single contiguous change per side, compared against the old base value). Two
people typing in different paragraphs therefore keep both edits; overlapping changes keep the local
value (server order) and are reported as a field conflict with the server value available.

The live SSE path uses the same merge and captures unsaved local edits before adopting the remote
document. Rebase and live-merge are serialized per board, so the sequence cursor and the merge base
cannot be updated by two paths at once.

Character-level CRDT is not implemented. It becomes worthwhile when simultaneous **same-region** text
editing must merge without a hard lock; the current model deliberately prevents that through the card
lock and treats the remainder as a visible conflict. True character merging needs a different editor
layer:

- rich text (document/note/heading): a text CRDT (Yjs or BlockSuite) inside the document editor,
  with the existing operation log carrying incremental updates instead of whole field patches;
- canvas cards: a card-list CRDT (stable ids, add/remove tombstones) if concurrent structural edits
  must merge without a lock;
- a migration path for boards that already contain text snapshots, plus presence/undo integration.

That work is a milestone of its own and is blocked by nothing in the queue anymore, but it should not
start before the LWW path has production usage: it rewrites the editor's persistence contract. The
resolve order stays: durable queue → per-field LWW + conflict visibility → (if needed) vector clocks →
CRDT.

## Known limits

- Two tabs keep separate queues (per-tab records). A queue left by a closed tab is drained by the next
  `online`/visibility flush, and operation ids make a race between two tabs idempotent. The board
  mirror record is shared, so the last tab to persist wins for the cached document; the server remains
  authoritative.
- `doc.replace` entries are still last-writer-wins for trash contents; a racing trash edit surfaces
  the whole-document conflict dialog.
- A rejected operation that cannot be repaired (for example an edit for a card deleted remotely) fails
  visibly and offers **Discard queued changes**; it is never retried forever.
