# Khaoyu Note Roadmap

This roadmap covers the move from a local-first desktop app to an optional self-hosted service with
accounts, sharing and collaboration, plus an optional AI assistant that can organise boards and
research with explicit permissions.

Status: `[x]` means done and verified in this repository. `[ ]` means planned, or partial with the
remaining work named in the item. See `docs/production-readiness.md` for the current collaboration and
Turso release verdict.

Where the plan stands: Milestones 1 to 5 are implemented in `service/` and the desktop sync client
and are recorded in `CHANGELOG.md` from 0.2.0 onward. Milestone 6 is mostly done, with the external
penetration test and production-scale load testing still open. Milestone 7 is limited by external
credentials and native runners, not by missing code. Milestone 8, the AI assistant, has not been
started and needs its own consent, tool-gateway and prompt-injection design first. Milestone 11,
full localisation coverage, is planned: the current ten-language catalogue only covers the settings
surface and parts of the chrome, and the service/admin pages are English-only.

Verification note: checkboxes were reconciled with the 0.36.0 code and test evidence on 2026-11-12.
`docs/production-readiness.md` carries the current release verdict.

## Current state

- [x] Desktop app: Tauri v2, vanilla ES modules, local SQLite.
- [x] Localhost web host serves the same frontend against the same SQLite database and assets.
- [x] Local-first boards need no account, no cloud and no outbound sync; the optional self-hosted
  service adds accounts, sharing and sync.
- [x] The MCP server runs locally over stdio and shares the same database.
- [x] Boards, cards and columns are scoped to one local database.
- [~] First-run database setup shell: single-user Local SQLite works; the collaboration choice now
  hands off to Server sync. Turso remains **not production ready**. Team onboarding still needs a
  guided service connection in `docs/production-readiness.md`.

## Product goals

- [x] 1. Keep the local-first desktop experience fully usable without a server.
- [~] 2. Offer an optional self-hosted server for teams that want accounts and sharing. (`service/`
  implements this; production readiness is still pending OIDC, load tests, penetration testing and a
  guided team onboarding, see `docs/production-readiness.md`.)
- [x] 3. Support login and roles, but never make login mandatory for local boards. (Local-first guest
  mode does this; the service requires accounts only for synced projects.)
- [x] 4. Share a whole project, a single card, or a column without exposing the rest of the board.
  (Implemented in `service/`; the local-first UI exposes share controls once a board is synced.)
- [~] 5. Treat security, privacy and data ownership as first-class requirements. (Ongoing; account
  security hardening exists, but external penetration testing and production load tests remain.)
- [ ] 6. Add an optional AI assistant that can organise, research, browse and edit only with explicit user consent.
- [~] 7. Offer a first-run storage choice: local SQLite or Turso for single-user, PostgreSQL + Redis
  for collaboration. (Local SQLite, the PostgreSQL/Redis team profile and the collaboration setup
  handoff exist; the Turso adapter is not implemented.)

## Milestone 1: Self-hosted service foundation

### Architecture

- [x] A standalone server process that the operator runs with Docker Compose or a native binary.
- [x] Restricted network surface: loopback bind by default, optional reverse proxy, no direct
  database port; the service opens two loopback listeners (frontend proxy and backend API).
- [x] Relational database for accounts, projects, memberships and audit data.
- [x] Object storage for uploaded assets, addressed by opaque ids, never by user-supplied paths.
- [~] Background worker for email invitations, thumbnails, backups and cleanup jobs (scheduled backups, temp cleanup, audit pruning, email retry queue, session/OTP cleanup and expired share/invitation revocation implemented; worker status meta present; thumbnail jobs pending).
- [x] Health endpoint that does not leak version, database or configuration details.

### Deployment

- [x] Supported deployment profiles: single-user, team (PostgreSQL + Redis) and reverse proxy behind HTTPS; a least-privilege PostgreSQL role script is documented.
- [x] Configuration through environment variables or a secrets file, never committed to the repo.
- [x] Startup fails closed when required secrets are missing or weak.
- [x] Database migrations run explicitly and are reversible where practical.
- [x] Backup and restore procedures documented before public release.
- [x] Upgrade path preserves all user data and invalidates sessions predictably.

### Local-first boundary

- [x] The desktop app remains authoritative for local boards.
- [x] Server sync is opt-in per project and shown with an explicit sync state.
- [x] Offline edits queue locally, sync later and surface conflicts instead of silently overwriting.
- [x] A deleted local database never deletes server data without an explicit confirmation.

## Milestone 2: Accounts and login

### Account model

- [x] Email and password registration. Verification was disabled in 0.29.0: registration returns an
  immediately usable verified account and `/auth/verify-email` returns 410 `verification_disabled`.
- [x] Unique, case-normalised email addresses; display name separate from email.
- [x] Account deletion request with a grace period, export before deletion.
- [x] Optional second factor: TOTP first, passkeys later (TOTP and WebAuthn passkeys are implemented, with QR setup and passkey readiness in the account security page).
- [x] Optional SSO for self-hosted enterprise deployments, behind an operator flag (trusted-proxy header SSO with HMAC; OIDC discovery is not included).

### Authentication

- [x] Passwords hashed with Argon2id and per-user salts; parameters tuned and versioned.
- [x] Short-lived access tokens plus rotating refresh tokens stored as hashes server-side.
- [x] Refresh token reuse detection revokes the whole session family.
- [x] Session list with device label, creation time, last seen time and a revoke action.
- [x] Logout everywhere action.
- [x] Login throttling per account and per IP, with progressive delays and alerting.
- [x] Generic login errors that do not reveal whether an email exists.
- [x] Password reset tokens single use, short lived, hashed at rest and bound to the account.
- [x] Optional email one-time codes as an alternative login method.

### CSRF and browser security

- [x] Session cookies use `Secure`, `HttpOnly` and `SameSite=Lax` or stricter.
- [x] State-changing requests require CSRF tokens or a strict origin check.
- [x] Content Security Policy on every server-rendered response.
- [x] No secrets, tokens or personal data in URLs or logs.
- [x] Third-party iframe embeds isolated and documented, since media cards load external content.

### Authorisation

- [x] Server-side authorisation on every request; the client never decides access.
- [x] Role and permission checks at the resource boundary, not only in the UI.
- [x] Object-level checks for board, card, column, asset and share link ids.
- [x] Deny-by-default policy for unknown routes and unknown resource types.
- [x] MCP and API integrations use scoped tokens, not the user's password.

## Milestone 3: Sharing model

### Share scopes

- [x] **Project share**: a whole project, including nested boards according to policy.
- [x] **Item share**: one card, with enough context to render it, but not sibling cards.
- [x] **Column share**: a column and its current children, with an explicit notice that later
  additions may or may not be included depending on the permission chosen.
- [x] Per-scope permissions: view, comment, edit, manage.
- [x] Optional expiry date, optional download permission, optional password protection.

### Share links

- [x] Share links use high-entropy random tokens, stored hashed, never logged in full.
- [x] Links are revocable and can be rotated; rotation invalidates the old token immediately.
- [x] Expiry enforced server-side; expired links return a neutral not-found page.
- [x] Optional passphrase verification with rate limiting and no hint about content.
- [x] Link previews do not expose board titles, card text or asset contents.
- [x] Every access is attributable to a share link and an IP hash for audit purposes.

### Members and invitations

- [x] Project membership with roles: owner, editor, commenter, viewer.
- [x] Invitations are single-use, expiring, email-bound and revocable.
- [x] Ownership transfer and owner removal safeguards, so a project cannot become orphaned.
- [x] Members can be removed immediately; their session loses access on the next request.
- [x] Sharing a column or item never grants access to unrelated sibling content.

### Public sharing

- [x] Public sharing is off by default and requires an explicit warning.
- [x] Public links show only the selected scope.
- [x] Search engines excluded with `noindex` and no sitemap exposure.
- [~] Optional watermark and download restrictions for shared assets (view watermark and per-link download cap implemented and audited; file-level watermarking and signed download URLs remain pending).
- [x] Abuse reporting and a kill switch for operators.

## Security architecture requirements

### Data protection

- [x] TLS everywhere; HTTP redirects to HTTPS or refuses to serve.
- [ ] Encryption at rest for the database volume and object storage where the platform supports it.
- [ ] Application-level encryption for highly sensitive fields if the deployment requires it.
- [~] Asset access checked through an authenticated proxy; signed short-lived URLs are not
  implemented (see `service/README.md`).
- [x] No asset directory listing and no predictable asset filenames.
- [x] Database and storage backups encrypted, with documented retention and deletion.

### Input and output safety

- [~] Server-side validation for every request body, parameter and upload (implemented across the
  service routes; per-endpoint completeness is tracked in `docs/security-audit.md`).
- [x] Upload filename sanitisation, MIME sniffing, size limits and malware scanning hooks.
- [x] Markdown and rich text sanitised on the server before rendering. Shared `html`/`markdown` fields pass an allowlist sanitizer before leaving the API.
- [~] Stored XSS prevention through context-aware escaping and a strict CSP (CSP is enforced on every
  server-rendered response; a dedicated XSS test pass is still open).
- [x] Parameterised database queries only.
- [~] Explicit allowlists for redirects and remote embed hosts (remote video embeds use exact YouTube/Vimeo host checks; there is no user-controlled redirect endpoint yet).
- [x] Rate limits and payload limits on all public endpoints.

### Secrets and operations

- [x] Secrets supplied by the environment or a secret manager, never baked into images.
- [x] Separate database credentials per service and least-privilege database roles: `service/deploy/postgres-least-privilege.sql` creates a data-only application role; SQLite deployments use the OS file permissions/volume.
- [x] No secret material in client bundles, crash reports or analytics.
- [x] Structured audit logs for login, permission changes, share changes and destructive actions.
- [x] Audit retention and export policy defined per deployment (retention and admin export are implemented; see `docs/data-residency.md`).
- [x] Dependency scanning, container scanning and a documented patch cadence.
- [x] Security headers: HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.
- [x] Admin endpoints separated, authenticated, rate limited and audited.
- [x] A documented incident response path: rotate secrets, revoke sessions, revoke links.

### Privacy

- [x] Data minimisation: collect only account email, display name and operational logs.
- [x] No third-party analytics by default on self-hosted deployments.
- [x] Export and delete account data on request where legally applicable.
- [x] IP addresses hashed in audit logs where full addresses are not required.
- [x] Clear data residency and backup location documentation for operators.

## Milestone 4: Collaboration and sync

- [x] Realtime collaboration only after authentication, authorisation and audit are complete.
- [x] Per-project rooms with membership checks on connect and on every message.
- [x] Presence is opt-in and does not reveal board contents to non-members.
- [x] Conflict handling for offline edits with a visible resolution flow.
- [x] Revision history for shared projects, with restore limited to editors and above.
- [x] Comments and notifications respect scope: a column share cannot leak board-wide activity.

### Architecture migration: Redis + PostgreSQL for live collaboration

Migrate the self-hosted collaboration layer to a scalable real-time architecture using PostgreSQL and Redis, while preserving SQLite for single-user, zero-account offline use.

Status: the service implements most of this block. Realtime transport is SSE plus HTTP operation
batches; WebSocket remains deferred by design (`docs/backend-postgres-redis.md`). The per-item notes
record what exists and what is still partial.

- [~] **Dual database strategy** (SQLite and PostgreSQL adapters, the async storage facade and paired
  reversible migrations are implemented; `migrate-to-postgres` moves durable rows):
  - Keep SQLite as the default, zero-dependency storage engine for the single-user desktop app and no-account mode.
  - Migrate self-hosted collaborative deployments to PostgreSQL for ACID guarantees, relational integrity, and high-concurrency multi-user transactions.
  - Unified repository interface in the service layer to isolate SQLite vs PostgreSQL differences.
  - Reversible schema migration tooling compatible with both SQLite (local) and PostgreSQL (self-hosted).
- [~] **Redis for real-time pub/sub and state** (cross-instance SSE fanout, global presence with
  cursor/selection state, single-use SSE tickets, hard per-card edit locks and worker leader lock are
  implemented; Redis-backed rate limiting and session caching are pending):
  - Redis Pub/Sub backend for broadcasting realtime events across server processes and worker nodes.
  - Ephemeral presence tracking (online users, live cursor positions, and active card selection highlights).
  - Distributed lock management for board/column operations and real-time conflict avoidance.
  - Redis-backed rate limiting and session caching for collaborative endpoints.
- [~] **Live collaboration protocol** (idempotent operation batches, per-project operation log, SSE
  tickets, hard per-card edit locks, granular client operation writes, live remote op application,
  cursor/selection presence and snapshot fallback are implemented; same-field CRDT/OT text merging
  and offline merge are pending):
  - Operational sync protocol for low-latency broadcast of card movements, edits, and column reordering.
  - Heartbeat-driven presence rooms with graceful disconnect handling and state reconciliation.
  - Offline sync merge: replay offline queue from local SQLite into the PostgreSQL project upon reconnection.
- [x] **Deployment and operations**:
  - Updated Docker Compose stack including khaoyu-note-service, PostgreSQL, and Redis.
  - Automated backup and restore tooling (pg_dump coordinated with asset storage).
  - Health checks cover PostgreSQL and report `realtime: ok/degraded` from the Redis coordination
    layer; Redis connectivity is also required at team-mode startup.

## Milestone 5: Notifications and activity (server side)

- [x] Server notifications for invitations, role changes, comments on shared scopes and mention events.
- [x] Email notifications opt-in with unsubscribe links and rate limiting.
- [x] In-app notifications scoped to the resources the user can currently access.
- [x] Deleting or revoking a share removes its pending notifications.
- [x] Notification read state stored per user, never shared between accounts.

## Milestone 6: Quality and security validation

- [x] Threat model reviewed before the first server release.
- [x] Automated tests for authentication, authorisation, share scopes and session revocation.
- [x] Integration tests for cross-account access attempts, IDOR and link expiry.
- [x] Load and abuse tests for login, public shares and uploads (low-volume smoke harness; production-scale load testing is still an operator task).
- [ ] External penetration test before advertising self-hosted production use.
- [x] Security disclosure policy and contact address published.
- [x] Release checklist includes backup restore test and secret rotation test.

## Explicit non-goals for the first server release

- [ ] End-to-end encrypted collaboration.
- [ ] Anonymous public editing.
- [ ] Plugin execution on the server.
- [ ] Multi-tenant SaaS billing.
- [ ] Real-time presence across unrelated projects.

## Decision log

These entries are adopted decisions, not open work items; they are listed without checkboxes so the
`[x]`/`[ ]` legend keeps meaning "verified" versus "planned".

- Keep local-first as the default and server sync as an option.
- Keep local SQLite as the default single-user store; Turso is opt-in and never required.
- Keep collaboration on PostgreSQL + Redis; do not offer Turso in collaboration mode.
- Maintain SQLite as the zero-dependency, zero-account default for single-user offline boards.
- Migrate self-hosted live collaboration to PostgreSQL and Redis for concurrency and pub/sub.
- Prefer self-hosted single-tenant deployments before any hosted offer.
- Share by scope (project, item, column) rather than by cloning boards.
- Server-side authorisation is the source of truth; UI state is never trusted.
- Security review gates the public self-hosted release.

## Milestone 7: Packaging and platform distribution

Packaging starts only after the stable release criteria are met. Detailed build and signing instructions live in `docs/packaging.md`. Build artifacts must be produced on native
runners in CI, not by cross-compiling from a single Windows machine.

### Release gates

- [ ] No open P0 or P1 defects.
- [x] Local-only mode passes the full UI and MCP suites (268 UI checks, 15 MCP checks; verified
  2026-11-11).
- [ ] Backup and restore verified on each platform (Windows verified; Linux and macOS pending).
- [ ] Version and changelog frozen for the release.
- [ ] Signing keys and release secrets available before the first public build.

### Target matrix

- [x] Windows: NSIS, MSI and portable `.exe` artifacts build and are published in `dist/` (unsigned).
- [ ] Windows: code signing, WebView2 install prompt, per-user install and uninstall cleanup.
- [~] Linux: AppImage, `.deb` and portable `.tar.gz` built locally; Flatpak manifest and CI job
  exist but the Flatpak bundle is not verified yet (rpm comes from CI).
- [ ] macOS: universal `.dmg` with Developer ID signing and notarisation.
- [ ] Android: APK/AAB, exploratory.
- [ ] iOS: TestFlight build, exploratory.

### Windows

- [x] Keep NSIS as the default installer, with MSI for managed deployments.
- [x] Ship a portable `.exe` build where the database lives beside the user profile.
- [ ] Verify WebView2 availability and show a clear install prompt when missing.
- [ ] Code-sign the executable and installers; document SmartScreen behavior.

### Linux

- [ ] Build AppImage on the oldest supported Ubuntu runner for glibc compatibility.
- [ ] Build Flatpak against a pinned runtime; declare filesystem and network permissions explicitly.
- [ ] Provide a `.desktop` entry, icons and MIME association for supported files.
- [ ] Test on Wayland and X11, including file drop and open-with-default-app behaviour.

### macOS

- [ ] Produce a universal binary with both Apple Silicon and Intel slices.
- [ ] Sign with a Developer ID certificate and notarise the DMG.
- [ ] Test app sandbox implications for assets, file drops and opening local files.
- [ ] Validate keyboard shortcuts and menu-bar expectations on macOS.

### Android and iOS

These are conditional on product fit and are not part of the first stable release.

- [ ] Mobile needs a different interaction layer: touch targets, bottom sheets instead of hover toolbars,
  no OS drag and drop, no stdio MCP server.
- [ ] SQLite and asset storage must move into platform app-data directories.
- [ ] File import goes through platform document pickers.
- [ ] Android: validate Tauri mobile support for the current plugins; build an APK/AAB and test on a tablet.
- [ ] iOS: requires a Mac runner, Apple Developer account, provisioning profiles and App Store review.
- [ ] Decide whether the mobile app is a viewer, a companion or a full editor before committing.

### CI and release automation

- [ ] GitHub Actions or equivalent matrix: Windows, Ubuntu, macOS (partial: Windows Rust and Ubuntu web jobs exist; macOS is missing).
- [ ] Each job builds on its native runner and uploads signed artifacts.
- [ ] Mobile jobs are separate and opt-in, never blocking desktop releases.
- [ ] Cache Rust and Node dependencies per platform.
- [ ] Generate checksums and a signed release manifest for every artifact.
- [ ] Keep a stable channel and a beta channel; publish notes and minimum OS versions.
- [ ] Do not publish an artifact if signing, notarisation or smoke tests fail.

### Compatibility checklist per release

- [ ] Install, first launch, create a board, upload an image, drop a file, export and reopen.
- [x] Verify database location, migrations and backup restore (verified on Windows).
- [ ] Verify downloads, external links and default-app opening.
- [ ] Verify update path from the previous stable version.
- [ ] Verify uninstall leaves or removes user data according to the documented policy.

## Milestone 8: AI chatbot and research tools

An optional chatbot inside Khaoyu Note that can organise boards, edit cards, research the web, find
images and call skills or tools. It must stay opt-in, scoped to the current context, and usable only
with visible user consent. The chatbot never gets silent write access to the database.

### Assistant surface and permissions

- [ ] Chat panel beside the canvas with the current board, selection and project as visible context.
- [ ] Conversation history per board or project, with clear new-chat and delete actions.
- [ ] Reference cards, boards and columns from the chat with a picker.
- [ ] Context picker for the current card, the selection, the open board, a project, or no board data.
- [ ] Read-only mode by default; editing, browsing and downloads are separate permissions.
- [ ] Every write shows a plan or diff before it runs, with Apply, Cancel and Undo.
- [ ] Per-tool permission prompts, including a remember-this-session option.
- [ ] Assistant actions go through the existing action layer and save guard, never direct SQL writes.
- [ ] Assistant respects lock position, trash, archived boards and share permissions.
- [ ] Stop, retry and edit-plan controls while a request is running.
- [ ] Clear indication of which model, provider and tools are active for each request.

### Board organisation and editing

- [ ] Group selected cards into a column or a new nested board.
- [ ] Create, rename, move, duplicate and convert cards from a natural-language command.
- [ ] Turn notes into documents, tables or checklists with a preview.
- [ ] Summarise a board or a selection into a note, document or comment.
- [ ] Suggest cleanup for duplicates, empty cards, orphan columns and inconsistent titles.
- [ ] Batch rename, retag and normalise titles with a review table.
- [ ] Build a board outline from a prompt, then let the user adjust it before creation.
- [ ] Apply wrap, lock and unlock rules correctly during generated operations.
- [ ] Keep one undo step per assistant action so the user can reverse a whole change.

### Research and browser access

- [ ] Web search tool with result titles, URLs and citations in the response.
- [ ] Open a result, extract readable text and save it as a note or link card with its source.
- [ ] Browser automation with a visible browser session and per-action approval.
- [ ] Domain allowlist and blocklist, with private and local addresses denied by default.
- [ ] No access to passwords, cookies, browser profiles or logged-in accounts.
- [ ] Rate limits, page size limits and timeouts for browsing and extraction.
- [ ] Treat page content as untrusted data; never execute tools because a page tells the assistant to.
- [ ] Save research findings as cards with source URL, retrieval time and short excerpt.
- [ ] Optionally compare sources and flag conflicting claims before saving a summary.

### Image and asset search

- [ ] Search image providers or browser results from a prompt, with a preview grid before import.
- [ ] Show image source, author, license and attribution before saving.
- [ ] Block imports whose license cannot be verified unless the user explicitly accepts.
- [ ] Download the chosen image, store it as an asset and create an image card with caption and alt text.
- [ ] Use the existing 100 MB upload limit, filename sanitisation and MIME checks.
- [ ] Never hotlink protected images when a local stored copy is required.
- [ ] Record attribution on the card so it survives sharing and export.

### Skills and tools

- [ ] Tool registry with JSON schemas, descriptions, permissions and cost hints.
- [ ] Built-in skills for board organisation, research, image sourcing and document editing.
- [ ] Reuse local MCP tools through the same gateway instead of a second tool path.
- [ ] Enable, disable and pin tools per project or per session.
- [ ] Skills declare required permissions and a maximum scope before they run.
- [ ] Sandboxed execution for optional skills; no arbitrary code execution by default.
- [ ] Tool calls and results are written to an audit log with timing, scope and outcome.
- [ ] A skill cannot read a resource outside the context the user approved.

### Models, privacy and cost

- [ ] Local model support first, with remote providers as an explicit opt-in.
- [ ] Provider adapter for OpenAI-compatible, Anthropic-compatible and local OpenAI-style endpoints.
- [ ] API keys stored in the OS keychain or a secret store, never in board data or logs.
- [ ] Scoped context only; never upload the whole database by default.
- [ ] Redact secrets, tokens and private file paths before sending context.
- [ ] Token, request and cost limits with a per-session budget.
- [ ] Prompt injection defences with explicit separation between instructions, board data and web content.
- [ ] Offline queue and clear failure messages when the provider or network is unavailable.
- [ ] User can delete assistant history and audit entries from the app.

### Architecture and operations

- [ ] Assistant service separate from the renderer, with a streaming transport to the chat panel.
- [ ] Tool gateway for local actions, MCP tools, browser tools and image tools.
- [ ] Isolated browser worker with its own profile and no access to the user's browser data.
- [ ] Deterministic plan objects so the UI can render and test a preview without running tools.
- [ ] Cancellation propagates to browser and network calls.
- [ ] Structured audit log for requests, tool calls, approvals and rejected actions.
- [ ] Feature flags to ship read-only assistant, editing assistant and browser research separately.

### Delivery phases

- [ ] M8.1 read-only assistant for summarising a board and answering questions.
- [ ] M8.2 board organisation and editing with plan preview and undo.
- [ ] M8.3 web search and page extraction with citations.
- [ ] M8.4 image search with license metadata and image card import.
- [ ] M8.5 skill and tool registry with permission prompts.
- [ ] M8.6 local model support and offline fallback.

### Quality gates

- [ ] Unit tests for tool schemas, permission checks and plan generation.
- [ ] Integration tests for organise, edit and undo through the existing action layer.
- [ ] Browser tests for domain blocking, visible sessions and cancellation.
- [ ] Prompt injection tests using hostile page content and hostile board text.
- [ ] Test that lock position, trash and share scopes cannot be bypassed.
- [ ] Test that secrets never appear in prompts, logs or audit entries.
- [ ] Cost and rate limit tests with a mocked provider.
- [ ] An evaluation set of board organisation tasks with expected previews and undo results.
- [ ] Manual review before enabling write or browser permissions by default.

### Non-goals for the first AI release

- [ ] Autonomous background browsing without a visible session and user approval.
- [ ] Silent edits or autonomous deletion of user content.
- [ ] Bypassing lock position, permissions or share scopes.
- [ ] Executing arbitrary downloaded code or installing unvetted plugins.
- [ ] Scraping paywalled, private or logged-in content.
- [ ] Sending the entire project database to a remote provider by default.
- [ ] Storing provider keys in cards, board JSON, logs or crash reports.


## Milestone 9: First-run database setup and Turso

Goal: the first time the service or web host starts, the user chooses the storage model before any
board or setting is read. Single-user mode offers a second choice between a local SQLite file and a
Turso (libSQL) database. Collaboration keeps PostgreSQL + Redis.

### Setup flow

- [~] Step 1 UI exists; the Collaboration option does not connect to the service yet.
  - Single user: one database, no Redis and no account required.
  - Collaboration: PostgreSQL + Redis, accounts and sharing; this is the existing team profile.
- [~] Step 2 UI exists; Local SQLite is the only selectable option. Connect to Turso is disabled
  with a Coming soon badge pending Milestone 9 implementation.
  - Local SQLite: the current filesystem database under the app data folder.
  - Turso: libSQL URL (`libsql://...`), auth token, optional embedded replica path, Test connection
    and Continue.
- [x] Back/Next between steps; Local SQLite persists the choice. Turso connection/schema checks are
  not implemented.
- [ ] First-run setup is idempotent and never silently replaces an existing database.
- [~] Settings > Backup exposes database export; desktop import uses the backup restore path. Web
  import and storage-mode change are not implemented.

### Storage and migration

- [ ] Add a `libsql` adapter beside the SQLite and PostgreSQL adapters with the same
  `get`/`all`/`run`/`exec`/`transaction` contract and the same schema migrations.
- [ ] Use `@libsql/client` in the Node web host/service. The desktop app needs the libSQL Rust crate
  or a documented bridge; routes and repositories must not depend on raw SQLite behaviour.
- [ ] Keep local SQLite as the default. Turso is opt-in and single-user only in this milestone.
- [ ] Provide explicit migration/export between local SQLite and Turso with a backup, row-count and
  snapshot-hash verification, and no automatic cutover.
- [ ] Run migrations explicitly and refuse startup while migrations are pending.
- [ ] Optional embedded replica and sync interval; document offline reads/writes, latency and
  conflict behaviour.
- [ ] Backup and restore cover Turso: export to a local encrypted file, verify checksums, restore into
  a fresh database.
- [ ] Changing storage mode requires an explicit migration or a new empty database; it never edits the
  old database in place.

### Security and operations

- [ ] Store the Turso token in the OS keychain on desktop and in encrypted server configuration on the
  web host; never in URLs, logs, board JSON or crash reports.
- [ ] Require TLS, validate the database URL, reject credentials in the URL and redact tokens in logs.
- [ ] Show a data-residency and network notice before connecting; no Turso request without explicit
  consent.
- [ ] Connection failures are neutral and never fall back to a different database silently.
- [ ] Timeout and rate-limit connection tests; no retry storm.
- [ ] Document backup location, retention and deletion for Turso data.

### Tests and acceptance

- [ ] Wizard tests: mode choice, back/forward, validation, failed connection, retry and existing
  database guard.
- [ ] libSQL adapter parity: CRUD, transactions, unique errors, migrations and rollback.
- [ ] Migration test: local SQLite -> Turso -> local with row counts and snapshot hashes.
- [ ] Security tests: token absent from logs and URLs, TLS required, neutral errors.
- [ ] CI uses a disposable libSQL/Turso-compatible target or a fake adapter; no real cloud token in
  CI.
- [ ] `npm run test:service` stays green on SQLite; PostgreSQL and libSQL tests remain CI-gated.

### Out of scope

- Turso for collaboration mode; team mode stays PostgreSQL + Redis.
- Automatic migration of an existing database without explicit confirmation.
- Multi-tenant database-per-team provisioning.

## Milestone 10: Admin dashboard and roles

Status: **desktop UI is roadmap only**. The service already ships the `/admin` dashboard and role
model; the desktop Settings > Administration page and the first-run collaboration enablement remain
the roadmap work.

Goal: the first user created in a database is the mandatory administrator and the only role with full
access. The admin surface lives inside Settings rather than as a separate application.

- [ ] First registered user is created as the only `admin`; the role cannot be chosen during setup and
  cannot be removed from the last remaining admin.
- [ ] Roles: `admin` (full access), `editor`, `commenter`, `viewer`. Only `admin` can access user
  management, storage settings and destructive database actions.
- [ ] Settings > Administration page, visible only to an admin:
  - user list with display name, email, role, status and last activity;
  - create user manually (service dashboard), disable and re-enable users; invite/delete user flows remain planned;
  - role changes with an explicit confirmation and audit entry;
  - active session list and "revoke all sessions" per user;
  - guard against deleting, disabling or demoting the last admin.
- [ ] Every admin action is written to the audit log with actor, target, before/after role and timestamp.
- [ ] Admin dashboard uses the same authentication, CSRF and session rules as the rest of the service;
  no admin token in the frontend bundle.
- [ ] Single-user local/offline mode has no user-management UI; it remains account-free.
- [ ] Tests: first-user admin invariant, last-admin guard, forbidden role escalation, session revocation,
  audit coverage and disabled collaboration setup.
- [ ] Documentation: operator bootstrap, recovery when the only admin is unavailable, and data export
  before deleting a user.

### Out of scope for this milestone

- SSO/OIDC group-to-role mapping.
- Multi-tenant billing.
- Per-project custom roles.

## Milestone 11: Full localisation coverage

Status: **planned**. The ten-language catalogue currently covers the settings surface, toolbar names,
the menu bar, the command palette, context-menu actions and the Backup page (190 audited keys across
ten languages). Most other app copy and every service page — including `/admin` — is still written
in English inline. This milestone expands localisation from a settings-only layer to every
user-facing string, title, body, dialog and admin surface, and keeps that coverage enforced as new
features arrive.

Goal: every string a user can read in the app, the local web host, the service pages and the admin
dashboard exists in the ten supported languages (English, Português (Brasil), Bahasa Indonesia,
Español, Français, Deutsch, 日本語, 한국어, 简体中文, Русский) through one shared catalogue, with English
as the explicit fallback. Board content, card text and user-authored titles stay untranslated by
design.

### Coverage: app interface and body

- [ ] Move every user-facing string in `app/web` out of inline English into the shared catalogue:
  menu bar and grouped menus, command palette commands and groups, tool rail names, tooltips and
  shortcut labels, top-bar controls (sync, share, account, presence, theme, language), context menus,
  banners, badges and empty states.
- [ ] Cover every dialog and pane title, section heading, label, placeholder, helper paragraph, status
  message, toast, confirmation and validation/error text: Settings (all panes), Templates, Share,
  Sync, Workspace/server popover, Create workspace, Add server, New board, Backup/restore, Update,
  Onboarding/setup, Documentation, Comments, Notifications, MCP and About.
- [ ] Cover the full-page editors: Document editor toolbar/menus/export, Drawing editor
  (pen/pencil/highlighter/undo/size/colour labels), colour picker and screen eyedropper copy,
  image crop, table and sheet controls, kanban/column actions, trash/archive flows and keyboard help.
- [ ] Translate titles everywhere they appear: page and pane titles, dialog titles, window/document
  title suffix, breadcrumb labels for system views (Home, Archive, Trash, Settings), section headings
  and menu group names. User-authored board, card and project titles are never translated.
- [ ] Translate body copy: help paragraphs, onboarding explanations, empty-state sentences, security
  and data-residency notices, backup/restore descriptions, sync/conflict explanations, share-link
  descriptions, error recovery guidance and the offline Help > Documentation content.
- [ ] Accessibility and metadata strings: `aria-label`, `title` tooltips, `alt` text, screen-reader
  hints and focus announcements.
- [ ] Keep all user content and technical identifiers out of translation: board/card JSON, comments,
  file and asset names, URLs, command ids, CSS/HTML attributes and service error codes.

### Languages, formats and infrastructure

- [ ] Keep all ten languages complete for every new key; add a per-key translation status so missing
  entries fail CI instead of silently falling back.
- [ ] Use `Intl` for dates, times, relative times, numbers, file sizes and currency-like values instead
  of hardcoded formats; use `Intl.PluralRules` for plural forms and `Intl.ListFormat` where lists are
  joined.
- [ ] Allow translations to change string length without breaking the chrome: buttons, menu items,
  badges, dialog titles and the top bar must handle long German/Russian/Japanese strings without
  clipping or overlapping.
- [ ] Language switching is global and immediate: app chrome, settings, dialogs and editors update
  without a reload; the choice persists per origin and, for service accounts, per account.
- [ ] Prepare RTL layout (logical CSS properties, icon mirroring) so a future Arabic/Hebrew language
  can be added without a CSS rewrite; verify CJK and Cyrillic rendering in the bundled fonts.

### Coverage: service pages, admin dashboard and email

- [ ] Localise every service browser page with the same catalogue and a language selector:
  `/login`, `/register`, `/reset`, `/passkeys`, `/account` (redirect target), `/admin` and
  `/s/:token` share viewer.
- [ ] Admin dashboard in full: Overview totals, Accounts (list, detail panel, create member, role,
  status, sessions, API tokens), Boards (rename/delete/members), Activity/audit filters, Sharing
  (links, invitations, watermark, download caps, acknowledgement), account menu, command palette,
  Help menu, empty states, confirmations and error toasts.
- [ ] Service-side messages: validation errors, neutral 404/410/429 responses, password/TOTP/passkey
  guidance, sharing and invitation copy, abuse-report pages and operator-facing admin text.
- [ ] Transactional email and notifications (verification disabled, reset fallback, invitations,
  mention and share notifications, unsubscribe page) use the recipient's language, with a safe
  fallback when none is known.
- [ ] Locale resolution order is explicit: account preference, then browser `Accept-Language`, then the
  operator default; the UI never switches language silently after sign-in.
- [ ] Admin can review or set the operator default language and see which languages are enabled.

### Tests, gates and operations

- [ ] Extend `npm run i18n:audit` from the current 190 keys to the whole catalogue and to the service
  pages: every key exists in every language, and no user-facing inline string remains in `app/web` or
  the service public pages (automated extraction/scan with an explicit allowlist for user content and
  technical strings).
- [ ] Pseudo-localisation run (accented, elongated strings) in CI to catch clipped or untranslated UI.
- [ ] Playwright language smoke suite: switch language, open menus/dialogs/settings/editors/share/
  sync/workspace, then sign in on the service and check login, account, admin, sharing and share
  viewer in at least three layouts (short, long, CJK).
- [ ] Service locale tests for emails and error responses; admin dashboard text assertions.
- [ ] Release checklist includes translation review for new keys and a completeness percentage per
  language; docs list how to add or update a language.
- [ ] No machine-translated copy ships without a reviewer; each language has a named maintainer.

### Delivery phases

1. **Inventory and extraction**: string inventory across app and service, catalogue format, audit
   extraction and inline-string scan; no visible change yet.
2. **App chrome, dialogs and body**: menu bar, top bar, tool rail, context menus, settings, templates,
   share/sync/workspace, editors, help and empty/error/toast copy across all ten languages.
3. **Service and admin**: auth pages, account/passkey pages, admin dashboard sections, share viewer,
   email/notifications, language selector and persistence.
4. **Formats, RTL, tests and docs**: Intl formats, pluralisation, long-string layout pass, pseudo-locale
   and Playwright suites, translation review and release documentation.

### Acceptance

- [ ] Zero hardcoded user-facing strings in `app/web` and the service public pages outside the
  board-content and technical allowlists.
- [ ] The audit reports 100 percent coverage for all ten languages, with English as the only fallback.
- [ ] A language switch updates the whole interface, including the admin dashboard, without a reload.
- [ ] No text clipping in short menus, dialogs, top bar or admin tables in any supported language.
- [ ] All per-language Playwright and service tests pass in CI; release notes state the current
  completeness per language.

### Out of scope

- Translating board content, card text, user-authored titles, comments, chat or AI output.
- Per-board language or mixing several languages inside one board.
- Automatic machine translation in production and adding languages beyond the ten until each has a
  reviewer and a maintained catalogue.
- Localising operator-only logs, CLI output and on-disk formats.
