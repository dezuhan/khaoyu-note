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
7. `service/test/*` PostgreSQL and Redis tests are CI-gated. In the 2026-11-11 verification pass the
   Redis integration passed locally with `TEST_REDIS_URL` set; the PostgreSQL tests stayed skipped
   because the local test role rejected authentication.

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

## Audit run — 2026-11-11 (verification pass)

Environment: Linux, Node 26.13.0, Playwright Chromium. PostgreSQL 18 and Redis 7 were running, but
the local PostgreSQL test role rejected authentication, so the PostgreSQL integration tests stayed
skipped. Rust 1.99.1 and Cargo were installed with rustup, but the Tauri crate needs GTK/ATK
development libraries that are missing and cannot be installed without root. Docker is not available.

### Evidence

| Check | Result |
| --- | --- |
| Static modules (`scripts/check-web.cjs`) | 38/38 clean |
| Version consistency | 0.35.0 pass |
| Translation audit | 190/190 keys, 10 languages |
| Main UI suite | **268/268 pass** |
| Feature browser suites | save-conflict 11/11, save-retry 4/4, board-selection 4/4, rename 8/8, board-card-title 5/5, column-layout 9/9, column-title 7/7, tool-drop 6/6, wrap 5/5, tooltips 7/7, line-area 6/6, card-features 24/24, fonts 5/5, web-mode 10/10, auth-web 44/44, onboarding pass |
| Service-backed browser suites | passkeys, shares-ui, share-view and the rewritten account suite (14 checks) pass with a disposable service |
| Service tests | **72 pass, 5 skipped** with `TEST_REDIS_URL` set (PostgreSQL integration skipped); the suite now covers logout CSRF and the invitation rate limit |
| Web host smoke | `/status` pass, version 0.35.0 on Node 26.13.0 |
| MCP smoke suite | not run: the Tauri crate build needs GTK/ATK development libraries |
| `cargo fmt --all --check` (app/src-tauri) | pass |
| Rust tests, `cargo clippy` | blocked: the Tauri crate needs GTK/ATK dev libraries that are unavailable without root |
| Docker image build + Trivy scan | not run: Docker is not available |
| `npm audit --omit=dev` for service | not run in this pass |

### Notes

- Resolved since the first pass: save-conflict is 11/11, board-selection is 4/4, and the passkey,
  shares and share-view suites start the service successfully. The earlier failures are no longer
  reproducible in this environment.
- `tools/test-account-ui.mjs` was rewritten in the same pass: it now covers `/account` redirecting
  to `/admin`, registration on `/register`, sign-in on `/login`, and the account section of the admin
  dashboard (sessions, API tokens, password change, sign out everywhere). It runs 14 checks and was
  added to `.github/workflows/ci.yml`.
- Rust `legacy_data_folder_is_migrated_to_the_new_identity`: the first pass observed a failure because
  the test created the legacy folder at the same identifier as the new root. It cannot be re-verified
  here without Cargo; fix the test roots and confirm under `cargo test`.

### Verdict

**NO-GO for a public production deployment today.** The single-user local build is usable as a beta
and its main UI, web host and service foundation are healthy, but the release cannot be called
production ready while PostgreSQL integration is unvalidated, no container scan has run, and
signing/pen-test/load-test gates remain open.

Minimum before a public production tag:

1. keep the account UI suite green in CI (rewritten and wired in on 2026-11-11);
2. fix the legacy migration test and run the full web and Rust suites green in CI;
3. run service tests against PostgreSQL (Redis already passes locally);
4. build and scan the service container with Docker/Trivy;
5. execute Linux/macOS packaging on native runners;
6. complete signing/notarisation and the external security review;
7. decide whether collaboration and Turso stay disabled (currently they do).
