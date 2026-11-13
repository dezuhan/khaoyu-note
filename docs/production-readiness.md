# Production readiness audit

Snapshot: **0.36.0**, 2026-11-12. This is an engineering audit, not a release approval.

## Verdict

| Area | Status | Production ready? |
| --- | --- | --- |
| Single-user local SQLite | Stable local data path, backup/restore and export implemented | **Yes for local-first use**, with the release gates below |
| Collaboration (PostgreSQL + Redis) | Team Docker stack, realtime plumbing and client integration implemented | **Beta** — external production gates remain |
| Turso/libSQL | UI placeholder and export preparation only | **No** — no adapter, migration or token integration exists |
| Web host single-user | Same SQLite and assets; export ZIP implemented | **Beta** — no web import/restore flow yet |

## Collaboration readiness

Implemented in this repository:

- async storage facade with SQLite and PostgreSQL adapters;
- PostgreSQL baseline and reversible migration runner;
- `migrate-to-postgres` row copy that deliberately skips live tokens and forces re-authentication;
- PostgreSQL logical backup/restore with checksums/encryption support;
- Redis event bus for cross-instance SSE fanout, global presence, single-use SSE tickets and
  advisory edit locks;
- per-project operation log with idempotent batches, sequence conflicts and replay/resync;
- worker leader lock and readiness reporting PostgreSQL plus realtime `ok/degraded`;
- desktop/web sync writes operation batches and refreshes from ticket-authenticated SSE; worker
  compacts old operation rows;
- team Docker profile with PostgreSQL and Redis and fail-closed configuration;
- service auth, sharing scopes, memberships, audit log and security tests.

Not ready for a production team deployment:

1. The setup wizard’s Collaboration option now opens the Server sync flow, and the admin dashboard
   covers accounts, boards, security and sessions. Team onboarding still needs a guided service
   connection and role walkthrough before it is production-polished.
2. OIDC is not implemented; the current SSO path is a trusted-proxy header mode. A real OIDC
   discovery/callback flow is still required for normal deployments.
3. External penetration testing and production-scale load tests are outstanding.
4. [verified 2026-11-12] Two-instance PostgreSQL 18 + Redis validation passed for ticket-authenticated
   SSE, global presence, operation propagation/replay, cross-instance lock conflict and readiness.
   The desktop/web client now diffs local saves into granular card operations and applies remote SSE
   operations live, with hard per-card locks, remote caret/selection presence and a synthetic
   6-client/360-op load check. CRDT/OT text merging and production-scale load testing remain pending.
5. Asset storage is local to the service instance; shared/object storage and asset migration are not
   production-ready.
6. Object/backup encryption and a least-privilege PostgreSQL role script are implemented; encrypted
   database volumes, multi-instance backup rehearsal and realtime protocol work remain release gates.
7. `service/test/*` PostgreSQL and Redis tests are CI-gated as well. In the 2026-11-11 verification
   pass both ran locally against a disposable PostgreSQL 17 container and Redis (77 pass, 0 skipped).

Conclusion: the collaboration backend is a serious beta foundation, but it must not be advertised as
production-ready until items 1–7 are closed.

## Install/uninstall posture

- Desktop: install via `.deb`, AppImage or portable archive; uninstall via the package manager or by
  deleting the portable files. Local app data is intentionally retained unless removed manually.
- Web host: run from a checkout with `npm run web`; no installer/uninstaller, data lives in the
  platform app-data directory.
- Team stack: `scripts/setup-team.sh` installs, `scripts/uninstall-team.sh` stops (retaining
  volumes) or purges the team database, assets and `.env.team` after explicit confirmation.
- A server-wide HTTP/UI database-drop endpoint does not exist by design. Account deletion has a
  grace period; project deletion is scoped; full service deletion is an operator action through
  PostgreSQL or the explicit uninstaller.

## Latest verification — 2026-11-12

- Full local service suite: **94 pass, 0 fail, 7 skipped** (the skips are the PostgreSQL/Redis
  suites when `TEST_DATABASE_URL`/`TEST_REDIS_URL` are absent).
- Main UI suite: **288/288**; web mode **10/10**; web live refresh **4/4**; web auth **44/44**;
  share viewer **8/8**; shares UI and account UI pass; passkeys **7/7**; sync engine passes.
- Static modules **42/42**, theme copies pass, i18n **190/190 keys in 10 languages**, dependency
  audit for root and service: **0 vulnerabilities**.
- Full team Docker stack was run on PostgreSQL 17 + Redis 7 on alternate ports: migrations
  `[1,2,3,4]`, `profile=team`, `/readyz` returned `{"status":"ready","realtime":"ok"}`, Redis
  responded `PONG`, PostgreSQL contained the bootstrapped account/project. The stack was cleaned
  after the check.
- Linux `dist/linux` artifacts were rebuilt on 2026-11-12 after the final web live/refresh,
  viewport and share-viewer changes, and their checksums pass. X11/Wayland launch verification is
  still pending.

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
- [x] two-instance PostgreSQL + Redis validation;
- [x] one-command team Docker stack and exhaustive local test pass (2026-11-12);
- [ ] OIDC implementation and test;
- [ ] object storage plan for service assets;
- [ ] Turso adapter, token storage and migration tests, or the option hidden;
- [ ] release signing and version freeze.

## Audit run — 2026-11-11 (verification pass)

Environment: Linux, Node 26.13.0, Playwright Chromium. Rust 1.99.1, Cargo and the Tauri system
libraries were provided through rootless Podman containers (Ubuntu 26.04); PostgreSQL 17 ran in a
disposable container and Redis 7 ran on the host. Docker is not available, so the container build and
scan used Podman and Trivy.

### Evidence

| Check | Result |
| --- | --- |
| Static modules (`scripts/check-web.cjs`) | 38/38 clean |
| Version consistency | 0.36.0 pass |
| Translation audit | 190/190 keys, 10 languages |
| Main UI suite | **268/268 pass** |
| Feature browser suites | save-conflict 11/11, save-retry 4/4, board-selection 4/4, rename 8/8, board-card-title 5/5, column-layout 9/9, column-title 7/7, tool-drop 6/6, wrap 5/5, tooltips 7/7, line-area 6/6, card-features 24/24, fonts 5/5, web-mode 10/10, auth-web 44/44, onboarding pass |
| Service-backed browser suites | passkeys (including automatic backup codes), shares-ui, share-view and the account suite pass with a disposable service |
| Service tests | **77 pass, 0 skipped** against disposable PostgreSQL 17 and local Redis; the suite covers logout CSRF and the invitation rate limit |
| PostgreSQL integration | pass (baseline parity, durable copy and storage round-trips included) |
| Web host smoke | `/status` pass, version 0.36.0 on Node 26.13.0 |
| MCP smoke suite | **15/15 pass** against a Linux debug build of the MCP binary |
| `cargo fmt --all --check` | pass |
| Rust tests | **21 library tests and 2 MCP unit tests pass**, including the legacy migration test |
| `cargo clippy --all-targets -- -D warnings` | pass |
| Service image build (Podman) | pass |
| Linux packages (0.36.0) | `.deb` 6.28 MiB, AppImage 87.07 MiB, portable `.tar.gz` 7.83 MiB rebuilt from the current binaries and checksummed; an 8-second X11/Wayland launch smoke test passed (window stayed up, no stderr) |
| Trivy image scan (CRITICAL, ignore-unfixed) | **0 findings** |
| `npm audit --omit=dev` for service | 0 vulnerabilities |

### Notes

- Resolved since the first pass: save-conflict is 11/11, board-selection is 4/4, and the passkey,
  shares and share-view suites start the service successfully. The earlier failures are no longer
  reproducible in this environment.
- `tools/test-account-ui.mjs` was rewritten in the same pass: it now covers `/account` redirecting
  to `/admin`, registration on `/register`, sign-in on `/login`, and the account section of the admin
  dashboard (sessions, API tokens, password change, sign out everywhere). It runs 14 checks and was
  added to `.github/workflows/ci.yml`.
- Rust `legacy_data_folder_is_migrated_to_the_new_identity`: the failure recorded in the first pass is
  not reproducible; the test passes in the container run.
- The MCP smoke suite ran against a Linux debug build of `khaoyu-note-mcp`. The Windows CI job remains
  the authority for the Windows binary.

### Verdict

**NO-GO for a public production deployment today.** The single-user local build is usable as a beta
and its main UI, web host, service foundation, Rust tests and container image are healthy, but the
release cannot be called production ready while platform packaging, signing/notarisation and the
external penetration and load-test gates remain open.

Minimum before a public production tag:

1. run the full web and Rust suites green in CI (locally green on 2026-11-11);
2. execute Linux and macOS packaging on native runners;
3. complete signing/notarisation and the external security review plus a production load test;
4. decide whether collaboration and Turso stay disabled (currently they do).
