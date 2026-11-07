# Changelog

All notable changes to Khaoyu Note are recorded here. The format follows Keep a Changelog and the
project uses Semantic Versioning.

## [Unreleased]

### Added

- Native desktop build matrix for Windows, Ubuntu and macOS that uploads unsigned bundles and
  checksums.
- `tools/checksums.mjs` and `npm run dist:checksums`.
- Explicit remaining-work and external-blocker document.

## [0.24.0] - 2026-11-07

### Added

- Settings redesign: Account first with a divider, then General, Appearance, Tools, Performance,
  divider, MCP and About. Language is merged into General and Canvas into Appearance.
- Tools pane as a two-column icon grid with visibility toggles.
- Account pane with server status and links to the service account, passkey and sharing pages.
- Shared service design token stylesheet for `/account`, `/passkeys`, `/shares` and `/s/:token`.
- Glass blurred backdrops for dialogs, settings, sync, share and onboarding overlays.
- Design system documentation and a service token regression check.

## [0.23.2] - 2026-11-07

### Added

- Remove header image action in the link card context menu when a header image already exists.
- Regression checks for the header image menu and removal.

## [0.23.1] - 2026-11-07

### Fixed

- Link header image preview now renders in plain browser preview mode by converting the stored
  localStorage asset into a data URL instead of an invalid relative path.
- Added a UI regression check for the visible header image preview.

## [0.23.0] - 2026-11-07

### Added

- Header-above-menubar chrome with a right-corner Share control for per-board access.
- Per-board sharing panel: default not shared, view-only access, optional comment/edit, password,
  expiry, download permission, create/copy/revoke links.
- Right-click Share link action for a card or column.
- First-run setup with Continue locally, Create account or Connect server.
- Sync API tokens can manage share links for editable projects.
- Updated in-app Documentation for the new board access flow.

## [0.22.0] - 2026-11-07

### Added

- Help > Documentation page with an offline guide for cards, shortcuts, sync, accounts, passkeys,
  sharing, self-hosting, privacy and troubleshooting.
- Documentation checks in the UI suite.

## [0.21.0] - 2026-11-07

### Added

- Public read-only share viewer at `/s/:token` with passphrase entry, project/item/column rendering,
  nested-board sections, scope isolation and neutral errors.
- `noindex`, self-only CSP and token redaction for share viewer requests.
- Playwright share viewer suite in CI.

## [0.20.0] - 2026-11-07

### Added

- Durable `email_jobs` queue for failed SMTP sends, flushed by the worker with exponential backoff,
  a 10 attempt cap and last-error recording.
- Queued mailer wrapper keeps verification and invitation requests successful during a short SMTP
  outage.
- Queue retry and backoff tests plus migration 012.

## [0.19.0] - 2026-11-07

### Added

- Browser sharing page at `/shares` with project/item/column links, permission, expiry, passphrase,
  download permission, token reveal and revocation.
- Explicit acknowledgement is required before enabling public sharing, both in the page and the API.
- Playwright browser sharing suite and CI step.

## [0.18.0] - 2026-11-07

### Added

- Project parent links and nested board inclusion in project shares under a same-owner, no-extra-members
  policy, with exclusion counts and a documented depth and count limit.
- Desktop sync creates a nested server project when its parent board is already synced.

## [0.17.0] - 2026-11-07

### Added

- Browser account page at `/account` for registration, verification, login, password reset, sessions,
  logout everywhere and scoped API token management.
- Account sessions response now includes the signed-in account identity.
- Playwright account flow test and CI step.

## [0.16.0] - 2026-11-07

### Added

- WebAuthn passkey registration, login, listing and removal with the `@simplewebauthn/server` library.
- Single-use five minute challenges bound to the account email, counter updates, passkey audit
  events and a last-credential guard for passwordless accounts.
- `/passkeys` browser page and an end-to-end virtual-authenticator test.

## [0.15.0] - 2026-11-07

### Added

- Optional `requireHttps` mode that rejects plain HTTP with 426 unless a trusted proxy reports HTTPS,
  and fails startup if the public URL is not HTTPS.
- Image signature validation for PNG, JPEG, GIF and WebP assets, SVG rejection and an optional
  external upload scanner hook with a ten second timeout.

## [0.14.0] - 2026-11-07

### Added

- Opt-in presence per account, with an account endpoint and presence counts that exclude opted-out
  connections.
- `@email` mentions in share comments notify current project members through in-app notifications and
  the opt-in email path.

## [0.13.0] - 2026-11-07

### Added

- Optional trusted-proxy SSO behind an operator flag, with an HMAC-signed proxy email, optional
  verified account auto-creation and `auth.login_sso` audit.
- SSO configuration validation: trust proxy is required and the signing secret must be at least 32
  characters.

## [0.12.0] - 2026-11-07

### Added

- Encrypted backups with scrypt-derived AES-256-GCM keys, per-file checksums, passphrase validation
  before restore and plaintext-free manifests.
- Optional login-block alert webhook with structured event payload, hashed IP and a three second
  timeout.

### Changed

- Backup format 2 stores object checksums and restores both encrypted and legacy backups.

## [0.11.0] - 2026-11-07

### Added

- Operator admin endpoints for audit export, abuse report review and service statistics, protected by
  a separate bearer token and per-IP rate limit.
- Dependency audit, Trivy image scanning and Dependabot configuration in CI.
- Low-volume load and abuse smoke harness for health, invalid share tokens, oversized bodies and
  optional login checks.
- Threat model, security disclosure policy, incident response runbook, release checklist and data
  residency documentation.

## [0.10.0] - 2026-11-07

### Added

- Opt-in per-board desktop sync with explicit status, scoped API token configuration and a sync
  dialog.
- Push, pull, visible conflict choices and local-only disable. Deleting a local board never deletes
  server data.
- Offline sync queue with automatic retry when the client comes online.
- Scoped API token helper and bearer-token CORS preflight limited to configured desktop origins.

### Fixed

- The local web host reports the package version instead of a hardcoded `0.1.0`.

## [0.9.0] - 2026-11-07

### Added

- SMTP delivery through `nodemailer` with an outbox fallback and environment configuration.
- Per-account email notification opt-in, signed one-click unsubscribe links and a five minute
  notification email rate limit.
- Notification email for invitations, role changes, revision restores, share reports, share comments
  and share edits.

## [0.8.0] - 2026-11-07

### Added

- Share comment permission with scoped comments stored on the shared card, never sibling cards.
- Share edit permission with a field allowlist, optional revision conflict check and passphrase
  support.
- Share writes create project revisions, emit SSE snapshot events, audit the link and notify owners.

## [0.7.0] - 2026-11-07

### Added

- Scoped in-app notifications for invitation acceptance, role changes, revision restores and share
  reports.
- Per-account notification read state, unread counts, mark-one-read and mark-all-read endpoints.
- Notification listing filtered through current project access, cleanup on share revocation and
  project sharing disablement, and 90 day pruning for read notifications.

## [0.6.0] - 2026-11-07

### Added

- Project revision history; every accepted snapshot is stored and members can list the latest 100.
- Editor-only revision restore that creates a new revision instead of rewriting history.
- Authenticated per-project SSE rooms with presence counts, snapshot events and heartbeats.
- Audit entries for revision restores and worker pruning of old revisions.

## [0.5.0] - 2026-11-07

### Added

- Authenticated project asset upload, listing and member-only download over the service.
- Content-addressed asset deduplication, opaque project asset ids, filename sanitisation, blocked
  executable extensions and a 100 MB limit.
- Share download enforcement: `downloadAllowed` is required, scope is checked and every share asset
  download is audited.

## [0.4.0] - 2026-11-07

### Added

- Email one-time login codes with a 10 minute lifetime, five attempt limit and TOTP compatibility.
- Global public-sharing kill switch through `KHAOYU_SERVICE_PUBLIC_SHARING`.
- Abuse reports for share links, stored with a hashed reporter IP.
- `invalidate-sessions` operator command for safe authentication upgrades.
- Worker cleanup for expired one-time codes and old share attempts.

## [0.3.0] - 2026-11-07

### Added

- Project, item and column share links with hashed tokens, permission metadata, expiry, optional
  passphrases, rotation, revocation, rate limiting and noindex responses.
- Project member roles, email-bound invitations, member removal and ownership transfer safeguards.
- Public sharing opt-in per project; disabling it revokes existing links.
- Share access audit entries with IP hashing, payload isolation, trash removal and local asset path
  stripping.

### Fixed

- Share tokens are redacted from request logs.
- Shared project snapshots no longer expose the trash or local filesystem asset paths.

## [0.2.0] - 2026-11-07

### Added

- Self-hosted service foundation with explicit migrations, opaque object storage, backup/restore,
  audit hashing, a maintenance worker and Docker Compose deployment.
- Account core with Argon2id, email verification, rotating refresh tokens and reuse detection,
  session management, password reset, TOTP, account deletion grace, project role checks and scoped
  API tokens.
- Service health endpoints and a file-based verification and reset mail outbox.
- Media iframes are sandboxed with a restrictive referrer policy.

### Fixed

- Account export now includes accessible project snapshots before deletion.
- Login throttling now uses progressive retry delays with a structured warning event.

## [0.1.0] - 2026-11-07

### Added

- Local-first Tauri v2 canvas with note, heading, link, to-do, comment, document, table, color,
  sketch, image, audio, video, map, file, board, column and kanban cards.
- Card connections with endpoint snapping, draggable endpoints and curve handles.
- Nested boards with breadcrumbs, board thumbnails and a template library.
- Column containers with collapse, wrap-in-column and convert-to-board actions.
- Sheet cards with column and row headers, resizing, add row or column, clipped headers and
  scrollbars that work inside columns.
- Rich text persistence for notes and headings, plus document conversion that keeps formatting.
- Lock position, link header images, card conversions and context toolbar formatting.
- Command palette, tool rail, settings, notifications and comments.
- Local SQLite persistence with a whole-document save guard, conflict handling, retry on failure,
  backup, integrity check and staged restore.
- Local stdio MCP server with board, card, comment and connection tools.
- Localhost web host on the same SQLite database and assets, with `/status`, a host badge and
  Settings > About details.
- Windows NSIS, MSI and portable executable builds.
- Browser, database and MCP regression suites covering 213 UI checks, 24 card feature checks,
  10 web host checks, 16 MCP checks and 10 Rust library tests.

### Changed

- Renamed the application and identifiers from the earlier Milanote clone name to Khaoyu Note.
- Menu bar uses a fixed three-column layout with the logo, centered search and action icons.
- Tooltips use the design-system popup surface instead of native browser tooltips.
- Line snapping and connection hit areas are tighter.

### Fixed

- Stale saves now surface a conflict instead of overwriting newer data.
- Failed saves keep the dirty state and retry with backoff.
- Renaming a nested board updates its parent board card.
- Column titles are editable and column layout survives returning from a nested board.
- Kanban and sheet scrollbars can be dragged without starting a card drag.
- Rich text no longer reverts to plain text after leaving edit mode.
- Board card titles follow the saved child board title.
