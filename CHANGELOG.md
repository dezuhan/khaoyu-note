# Changelog

All notable changes to Khaoyu Note are recorded here. The format follows Keep a Changelog and the
project uses Semantic Versioning.

## [Unreleased]

### Added

- The project is licensed under the PolyForm Noncommercial License 1.0.0: source-available for
  personal, educational and research use, with no commercial use without written permission. This is
  not OSI open source because commercial use is restricted.
- Local-first deploy mode: login, signup, reset-password, account page and Settings > Account are
  disabled. Boards and settings open without an account, the account avatar and Account settings page
  are hidden, desktop guest writes are accepted, and the web host no longer requires a session for the
  command bridge, assets or downloads. Comment cards use the local "You" identity with no profile
  picture while account features are disabled.
- Separate service auth pages at `/login`, `/register` and `/reset`, using the reference centred card
  layout with `ky.css` tokens and light/dark mode. Password reset requires the current password and
  never sends an email token. Login lands on `/admin`; `/account` redirects there, and the dashboard
  Account section now owns password changes, sessions, API tokens and sign out.
- Settings > Account now has a Delete Account tab. After re-entering the current password and typing
  DELETE ALL, it deletes every local board, card, connection, asset, account, session, setting and
  activity row, vacuums the database, clears the saved desktop session or web cookies, and reloads into
  first-run setup for a new user. GitHub and the self-hosted service are not touched.
- The self-hosted service now starts two listeners automatically: a frontend port for pages and a
  backend port for the API. Both use free 5-digit ports in 20000-59999, are guaranteed distinct,
  can be pinned with `KHAOYU_SERVICE_FRONTEND_PORT` and `KHAOYU_SERVICE_BACKEND_PORT`, and are written
  to `<data>/runtime.json`. The frontend proxies `/api` to the backend so cookies, CSRF and the public
  URL stay on one origin. `npm run start:background` detaches the service with logs and `npm run stop`
  stops it. Docker Compose pins the pair to 18080 and 18081.
- Self-hosted service admin dashboard at `/admin`: left rail and content pane with Overview,
  Accounts, Teams and Activity, light and dark themes, profile pictures or initials, user role and
  active/disabled status, team creation and members, and the full audit activity feed. The first
  service account becomes admin, migration 13 adds the profile and role columns, and disabled
  accounts are blocked from password, OTP, SSO, refresh and API-token authentication.
- Full board URLs in the browser edition. The web host binds to `0.0.0.0` by default, reports its
  LAN and optional public URLs, keeps `?board=<id>` in the address bar, and the Share panel copies a
  full board link. Devices on the same network can open it while the host runs and sign in with an
  account on that host. `KHAOYU_WEB_PUBLIC_URL` adds a reverse-proxy or DDNS origin, and
  `KHAOYU_WEB_HOST=127.0.0.1` keeps the host local-only.
- Settings > Account is now a profile page with profile picture upload and removal, first and last
  name, email and a Change Password section, plus Save and Cancel. Settings navigation adds Server
  between Account and Backup for local runtime details and the self-hosted service connection.
  Profile pictures are cropped to 256 px data URLs. The local schema moves to version 3 with
  `users.avatar_url`.
- Native desktop build matrix for Windows, Ubuntu and macOS that uploads unsigned bundles and
  checksums.
- `tools/checksums.mjs` and `npm run dist:checksums`.
- Explicit remaining-work and external-blocker document.

## [0.33.0] - 2026-11-07

### Added

- Settings > Backup is its own pane with Back up now, Export ZIP and Open folder. It is listed in the
  settings navigation between Account and General.
- `export_backup_zip` writes the backup folder into one archive, in the desktop app and in the
  localhost web host.
- Video cards gain a seek bar, a current and total time label, back 5 and forward 5 buttons, and a
  volume slider that slides out above the mute button.
- Context menus can render a native checkbox row on the right; the media Repeat action uses it.
- Help > Documentation is now a tabbed guide with a Settings-like left navigation and a scrolling
  section pane, including new MCP and HTTP API sections, environment tables, endpoint lists and code
  examples. Arrow keys move between sections.
- The app checks the latest GitHub release of `dezuhan/khaoyu-note` at startup and then once per hour,
  and from Help > Check for updates or Settings > About. It compares versions, shows the release notes
  and offers to open the release page. It never downloads or runs an installer. The About pane now
  reports the real app version instead of a hardcoded value.
- Temporarily disabled card types (Map, Video and Audio) are now hidden from boards, columns,
  previews, marquee selection and templates instead of only losing their tool. The cards stay in the
  document and return when the feature is re-enabled. Uploading local audio or video while those types
  are disabled stores a file card so the asset stays visible. Hiding a tool in Settings still only
  removes the rail button.
- Local accounts (milestone M1). A fresh database creates the local admin, with username, email,
  first and last name and a PBKDF2-SHA256 password. Sign in is now mandatory on both the desktop and
  the browser edition so board and account activity is attributed. The desktop keeps the session on
  the device and the web host keeps a 30 day cookie. The topbar shows an avatar after Share, and the
  avatar opens Settings > Account with tabs for Admin Dashboard, Account Information, Account Settings
  and History Activity plus Log Out. Boards and cards store creator and last editor snapshots, History
  records account and board actions, and backups leave live sessions out. Role enforcement and the
  Admin Panel follow in M2 and M3.
- Automatic backups. Settings > Backup offers Off, every day, every 3, 7 or 14 days, and every month
  (30 days). The app checks the schedule while it runs and catches up on the next launch when an
  interval was missed. A manual backup or Export ZIP resets the schedule so it is not duplicated.
- Server sync signs in with the account email and password instead of an API token. The service
  exchanges the credentials for a scoped project token, revokes the previous sync token on each
  sign-in, and the client stores it without showing it. The sync dialog, the first-run screen and the
  Account pane share the flow, and they link to the server account page to create an account.

### Changed

- Map, Video and Audio are temporarily disabled as tools: they are hidden from the tool rail, the
  drag-to-canvas path, the keyboard shortcuts and the command palette, and they stay listed in
  Settings > Tools with a "Disabled (temporarily)" status. Their cards still render and play, so
  existing boards are unchanged.
- Local media now goes through the Upload tool, which already turns an image, audio or video file
  into its card and any other file into a file card.
- Link previews resolve YouTube links to their thumbnail directly instead of scraping the watch page,
  which often answers with a consent page. Poster images for other pages still come from Open Graph
  metadata.
- The backup archive is written uncompressed (STORE). The payload is a SQLite snapshot plus images,
  audio and video that are already compressed, so it keeps the export free of an extra dependency.

### Fixed

- Server sync accepts a local service address. `127.0.0.1:8080`, `localhost:8080` and
  `http://localhost:8080` are normalized instead of requiring a domain, remote hosts default to
  `https`, and the desktop CSP allows loopback `connect-src`.
- A real board can sync again. The snapshot route used the 64 KB JSON body limit, so any board above
  that size failed with 413; snapshots now accept up to 8 MB and over-limit bodies are drained so the
  client receives the 413 instead of a connection reset.
- The service CORS defaults include the local web host origins, so the browser build can sync to a
  local service without editing configuration.
- The sync dialog reports the real connection state. `Check connection and connect` runs `/readyz`
  and an authenticated project listing before connecting, and the Account pane shows the same result
  under Server, API token and Status.
- Health and readiness responses now send CORS headers for allowed origins, so the connection check
  works from the desktop webview and the local web host instead of reporting a false "unreachable".
  When `/readyz` cannot be read, the client falls back to the authenticated project call to decide.

## [0.32.0] - 2026-11-07

### Fixed

- Moving or resizing a card no longer rebuilds active audio, video or map elements. The rebuild keeps
  those DOM nodes alive, so YouTube, Vimeo, audio and map playback does not reload or restart.
- Added pause, mute and volume controls over playing video embeds.
- Added a volume slider to the custom audio player.
- UI checks for media controls, volume and iframe identity across a drag.

## [0.31.0] - 2026-11-07

### Added

- Settings > Account now has a Backup section with Back up now, the created backup path and Open
  folder.
- Backups use the existing desktop and web host `backup_data` command and are written to
  Documents/Khaoyu Note Backups.
- UI check for the backup controls.

## [0.30.1] - 2026-11-07

### Changed

- The default link hero now uses the board dot pattern: 24px spacing, 1px soft stroke and a centered
  globe, instead of the denser 8px muted dots.
- Added a UI check for the fallback dot spacing.

## [0.30.0] - 2026-11-07

### Added

- Video cards show a centered circular play button over the thumbnail. The embed, with autoplay,
  is loaded only after the click.
- Audio and video context menus expose Play, Pause and a Repeat checkbox.
- Play is disabled while playing, Pause is disabled while paused, and Repeat toggles loop.
- YouTube embeds use `enablejsapi` for play/pause messages and `loop` plus `playlist` for repeat.
- UI checks for the video overlay, autoplay embed, playback menu states and repeat toggle.

## [0.29.2] - 2026-11-07

### Fixed

- Audio assets no longer fall back to an image MIME type in browser preview, which prevented playback.
- Web host and preview now map MP3, WAV, M4A, AAC, OGG, Opus and FLAC to their audio MIME types.
- Play failures surface a toast instead of failing silently.
- Added a UI check that uploads a real WAV and verifies playback progress.

## [0.29.1] - 2026-11-07

### Fixed

- The crop dialog now fits the whole image inside the dialog using its available width and height,
  instead of sizing against the whole viewport and clipping the overview.
- The crop stage no longer shrinks inside the flex body, so the crop frame and image stay aligned.
- Refits on window resize and removes the resize listener when the dialog closes.
- Audio edit actions now share the same height, so the clip upload button and Submit align.

## [0.29.0] - 2026-11-07

### Changed

- Email verification is disabled. Registration creates an immediately usable, already-verified
  account and login no longer blocks on verification.
- `POST /api/v1/auth/verify-email` returns 410 `verification_disabled`.
- The Verify email section and its client code are removed from `/account`; registration copy now
  says sign-in is immediate.
- Browser suites register and sign in directly without reading an outbox verification token.

## [0.28.2] - 2026-11-07

### Fixed

- A malformed request target such as `//` no longer throws `ERR_INVALID_URL` and terminates the
  service; it now returns 400 `bad_request`, and the service stays ready.
- Added a raw-socket regression test that verifies the 400 response and a healthy `/readyz` afterward.

## [0.28.1] - 2026-11-07

### Fixed

- Service account, passkey, sharing and share viewer pages now load the real framework stylesheet
  `ky.css` and use `.ky-scope`, `.ky-panel`, `.ky-title`, `.ky-label`, `.ky-input` and `.ky-button`
  components instead of a hand-written token approximation.
- Page-specific layout moved to a small `ui.css` layer; service pages now match the app surfaces,
  typography, control heights and button hierarchy.
- Dynamic account and sharing row buttons use the framework button classes.
- Account browser check now asserts the `ky.css` link and framework surface colors.

## [0.28.0] - 2026-11-07

### Fixed

- Duplicate now works for column cards instead of silently skipping them.
- Duplicating a column copies its child cards and remaps parent IDs.
- Copy, cut and paste treat a column as a subtree, so pasted columns keep their child cards.
- Repeated paste offsets the whole subtree and selects the copied column roots.
- Added UI checks for duplicating and copy-pasting a column with children.

## [0.27.0] - 2026-11-07

### Added

- Link cards fetch an Open Graph or Twitter hero image automatically when the URL is committed.
- Desktop fetch runs through a Rust command with scheme and private-host guards, a 2 MB HTML cap and
  a 5 MB image cap; the local web host implements the same preview with its bridge.
- Links without a hero image show a dotted globe fallback header.
- Automatic card height fitting for the fallback header.
- UI checks for the fallback hero and default header restoration.

## [0.26.0] - 2026-11-07

### Fixed

- Audio edit mode now shows a clip-only upload button without text and a Submit button.
- Uploading a replacement audio file while editing updates the input source instead of leaving the
  old selection in place; Submit closes editing and renders the new player.
- Added UI checks for the audio edit controls, replacement upload and submit.

## [0.25.1] - 2026-11-07

### Changed

- Swapped the chrome order: the application menu bar is on top and the Template / Home file header
  sits below it, with the existing heights unchanged.

## [0.25.0] - 2026-11-07

### Added

- Free-form crop editor for link header images and image cards.
- Crop rectangle can move and resize on any edge or corner without a fixed ratio.
- Fit to image resets the crop to the full image ratio.
- Crops persist on the card and render through a clipped image frame.
- UI checks for header and image card crop entry, dialog, free resize and reset.

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
