# Production readiness audit

Snapshot: **0.35.0**, 2026-11-11. This is an engineering audit, not a release approval.

## Verdict

| Area | Status | Production ready? |
| --- | --- | --- |
| Single-user local SQLite | Stable local data path, backup/restore and export implemented | **Yes for local-first use**, with the release gates below |
| Collaboration (PostgreSQL + Redis) | Backend foundation and realtime plumbing implemented in `service/` | **No** — operator/UI hardening and validation remain |
| Turso/libSQL | UI placeholder and export preparation only | **No** — no adapter, migration or token integration exists |
| Web host single-user | Same SQLite and assets; export ZIP implemented | **Beta** — no web import/restore flow yet |

## Collaboration readiness

Implemented in this repository:

- async storage facade with SQLite and PostgreSQL adapters;
- PostgreSQL baseline and reversible migration runner;
- `migrate-to-postgres` row copy that deliberately skips live tokens and forces re-authentication;
- PostgreSQL logical backup/restore with checksums/encryption support;
- Redis event bus for cross-instance SSE fanout, presence/lock primitives and worker leadership;
- operation log, snapshots, revisions, SSE tickets and advisory edit locks;
- team Docker profile with PostgreSQL and Redis, ready/health checks and fail-closed configuration;
- service auth, sharing scopes, memberships, audit log and security tests.

Not ready for a production team deployment:

1. The desktop/web UI still exposes only the local-first path. The setup wizard’s Collaboration option
   is disabled until the admin dashboard/role model (Roadmap Milestone 10) exists, and does not
   connect to the service.
2. OIDC is not implemented; the current SSO path is a trusted-proxy header mode. A real OIDC
   discovery/callback flow is still required for normal deployments.
3. External penetration testing and production-scale load tests are outstanding.
4. Multi-instance Redis/SSE behavior needs a dedicated two-instance validation run.
5. Asset storage is local to the service instance; shared/object storage and asset migration are not
   production-ready.
6. Encryption at rest, least-privilege database roles and a documented multi-instance backup rehearsal
   remain release gates.
7. `service/test/*` PostgreSQL and Redis tests are CI-gated and were skipped in this local environment
   because no disposable PostgreSQL/Redis target was available.

Conclusion: the collaboration backend is a serious beta foundation, but it must not be advertised as
production-ready until items 1–7 are closed.

## Turso readiness

Current state:

- the setup screen has a **Connect to Turso** option, but it is disabled/informational only;
- there is no SQLite-style `libsql` adapter beside the SQLite/PostgreSQL adapters;
- no `@libsql/client` (Node) or libSQL Rust crate is integrated;
- there is no token storage (OS keychain/encrypted configuration), URL validation, TLS enforcement or
  consent screen;
- there is no schema/data migration path, row-count/hash verification or rollback;
- asset files (images, audio, video, uploads) are not represented in a Turso migration plan;
- no libSQL compatibility or migration tests exist.

Conclusion: **Turso cannot yet accept a production migration.** The disabled gate in Settings >
Backup and the export action are preparation only, not a migration implementation.

## Single-user database export/import

- **Export database:** desktop writes a ZIP snapshot; the local web host exposes
  `GET /api/database/export` and streams the same ZIP (database + assets).
- **Import database:** desktop can restore the folder-shaped backup through the existing
  `stage_restore` path and restart. Import on the web host is intentionally disabled because replacing
  the live server database needs maintenance-mode and restart semantics.
- **Turso migration:** disabled. Export the ZIP first, but do not treat it as a completed Turso
  migration.

## Release gates

- [ ] no open P0/P1 defects;
- [ ] backup and restore verified on Windows, Linux and macOS;
- [ ] external penetration test completed;
- [ ] production-scale load test for login, shares and uploads;
- [ ] two-instance PostgreSQL + Redis validation;
- [ ] OIDC implementation and test;
- [ ] object storage plan for service assets;
- [ ] Turso adapter, token storage and migration tests, or the option hidden;
- [ ] release signing and version freeze.

## Audit run — 2026-11-11

Environment: Linux sandbox, Node 26.13.0, local Rust toolchain, no Docker daemon and no running
PostgreSQL/Redis servers.

### Evidence

| Check | Result |
| --- | --- |
| Static modules (`scripts/check-web.cjs`) | 38/38 clean |
| Version consistency | 0.35.0 pass |
| Translation audit | 188/188 keys, 10 languages |
| Main UI suite | **268/268 pass** |
| MCP smoke suite | **15/15 pass** |
| Service tests | **69 pass, 6 skipped** (PostgreSQL/Redis integration skipped) |
| Rust release build | **pass** (optimized Linux binary) |
| `npm audit --omit=dev` for service | **0 vulnerabilities** |
| Full web audit | 19 suites pass; 5 suites fail (see below) |
| Rust tests | 20 pass, **1 fail** (`legacy_data_folder_is_migrated_to_the_new_identity`) |
| `cargo fmt --check` | not run: rustfmt component is not installed |
| Docker image build + Trivy scan | not run: Docker is not available |

### Failing checks

- `tools/test-board-selection.mjs`: 1/4. The test seeds `localStorage` and reloads; the app's
  `beforeunload` save then writes the currently open board back into the index, so the seeded boards
  are overwritten and Home opens. This is a **test-harness failure**, but CI will treat it as a failing
  suite and it must be fixed before a release.
- `tools/test-save-conflict.mjs`: 10/11. “the copy is saved” still reads `Saving...` after the
  fixed 900 ms wait. Timing-sensitive; rerun needed on CI hardware or replace the sleep with a
  condition wait.
- `tools/test-passkeys.mjs`, `tools/test-shares-ui.mjs`, `tools/test-share-view.mjs`: fail because
  their helper cannot start the service process in this environment.
- Rust `legacy_data_folder_is_migrated_to_the_new_identity`: creates the legacy folder at the same
  identifier as the new root, so the migration is a no-op and the assertion fails. The test must use
  distinct legacy/current roots; the production migration path is not exercised by this test.

### Verdict

**NO-GO for a public production deployment today.** The single-user local build is usable as a beta
and its main UI, release build and MCP surface are healthy, but the release cannot be called production
ready while CI has red suites, PostgreSQL/Redis behavior is unvalidated on this machine, no container
scan has run, and signing/pen-test/load-test gates remain open.

Minimum before a public production tag:

1. fix the board-selection and conflict tests (or the underlying unload-save behavior);
2. fix the legacy migration test;
3. run the full web suite and Rust suite green in CI;
4. run service tests against PostgreSQL and Redis;
5. build and scan the service container with Docker/Trivy;
6. execute Linux AppImage/.deb builds on Ubuntu X11 and Wayland;
7. complete signing/notarisation and the external security review;
8. decide whether collaboration and Turso stay disabled (currently they do).
