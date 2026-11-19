# Sync API contracts

Phase 0 of the backend realtime plan: the app-facing sync API is written down before it is changed.
The contracts are the source of truth for routes, SSE event envelopes and protocol/error codes.

## Contents

- `openapi.json`: OpenAPI 3.1 document for the routes the desktop app and web editor use.
  Sharing, admin and account-management routes join in Phase 3.
- `events/*.schema.json`: JSON Schema for each SSE event envelope (`ops`, `snapshot`, `presence`).
- `errors.json`: the stable `code` values returned by the sync routes. The plan's working names map
  as `auth_required = authentication_required`, `forbidden_role = forbidden`,
  `stale_base_seq = seq_conflict`.
- `fixtures/*.json`: example payloads validated against the schemas by the contract test.

## Protocol version

Every JSON response carries `X-Khaoyu-Protocol: 1`. Clients send the same header. A client that sends
an unknown major version receives `426` with `code: "protocol_unsupported"`. A missing header is
treated as protocol 1 so older clients keep working.

## Contract test

```bash
node tools/test-contracts.mjs
```

The test validates the fixtures against the schemas, starts the Node service, exercises the routes
live, checks the protocol header and the stale-sequence error code, and verifies that `app/web/js`
still calls the documented endpoints. It uses `tools/service-runner.mjs`, so a packaged server can be
tested with:

```bash
SERVICE_CMD="/path/to/khaoyu-server" node tools/test-contracts.mjs
```

## Changing a contract

A route or event change must update `contracts/` in the same pull request. CI runs the contract test,
so a drifted response fails the build. Keep new fields optional unless all clients already send them.
