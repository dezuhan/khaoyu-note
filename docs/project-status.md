# Khaoyu Note project status

Snapshot date: 2026-11-07. Version: 0.30.0.

## Technology

| Area | Choice |
| --- | --- |
| Desktop shell | Tauri 2.12.5 with a programmatic WebviewWindow |
| Native host | Rust 1.99.1, MSVC 2022, WebView2 156 |
| Frontend | Vanilla JavaScript ES modules, no framework and no bundler |
| Styling | Vendored Khaoyu design-system CSS plus the app stylesheet |
| Storage | SQLite through rusqlite 0.40.2 and bundled libsqlite3-sys 0.38.2, WAL mode |
| Native bridge | Tauri IPC commands for boards, assets, file open/download, settings and MCP path |
| Self-hosted service | Node 24, built-in `node:sqlite`, one HTTP port, Docker Compose, reversible migrations |
| Agent integration | `khaoyu-note-mcp`, a local stdio JSON-RPC 2.0 server with 14 tools |
| File assets | Local assets directory with an `assets` table for original filenames |
| Tests | Playwright UI suite, MCP smoke suite, service foundation tests and authentication tests |
| Packaging | Windows NSIS and MSI locally; GitHub Actions matrix prepared for Linux and macOS |
| Platform | Windows verified. Linux, macOS, Flatpak, Android and iOS are not verified yet |

## Source and artifact sizes

| Item | Size |
| --- | --- |
| Frontend source (`app/web`) | 0.74 MB |
| Rust source (`app/src-tauri/src`) | 0.06 MB |
| JavaScript source | 10,600 lines |
| Rust source | 1,900 lines |
| UI test script | 1,850 lines |
| MCP test script | 137 lines |
| App source excluding build caches and node_modules | about 1.1 MB |
| Repository including docs, screenshots, dist and dev test dependencies | about 24 MB |
| Local Rust build cache (`app/src-tauri/target`) | not part of the shipped app |

## Delivery artifacts

| Artifact | Size |
| --- | --- |
| Windows NSIS installer | 3.10 MiB |
| Windows MSI installer | 5.21 MiB |
| Portable `KhaoyuNote.exe` | 10.79 MiB |
| `khaoyu-note-mcp.exe` | 2.38 MiB |
| Full `dist` folder | about 21 MB |

## Database and user data

Measured from the current local database:

| Metric | Value |
| --- | --- |
| Database file | 143,360 bytes, about 140 KB |
| Page size | 4,096 bytes |
| Page count | 35 pages |
| Free pages | 15 pages, about 60 KB of fragmentation |
| WAL file | about 157 KB |
| Shared memory file | 32 KB |
| Boards | 4 |
| Cards | 31 |
| Connections | 0 |
| Asset rows | 28 |
| Meta rows | 5 |
| Assets folder | 26.43 MB across 29 files |

The database itself is small. Uploaded assets dominate user data. Free pages should be reclaimed with `VACUUM` before a backup or release snapshot.

## Stable staging readiness

Verdict: **ready for internal alpha staging, not public stable**.

| Area | Status | Notes |
| --- | --- | --- |
| Core editing | Strong | Every card type, columns, tables, kanban, drawing, media, comments and undo are covered by the UI suite |
| Automated tests | Good | 199/199 UI and 14/14 MCP checks pass at this snapshot |
| Data integrity | Medium | SQLite works, but schema migrations are not versioned or covered by dedicated tests |
| Backup and restore | Weak | No backup or restore UI, no scheduled backup, no restore verification |
| Packaging | Medium | Windows verified; Linux and macOS CI exists but has not run; Flatpak and mobile not ready |
| Signing | Not ready | Windows binaries are unsigned; macOS signing and notarisation are only prepared in CI secrets |
| Auto-update | Not ready | No signed updater channel or rollback path |
| Performance | Unknown | No large-board benchmark or memory profile |
| Accessibility | Unknown | No screen-reader or full keyboard navigation audit |
| Localisation | Not available | Interface is English only, language menu is a disabled placeholder |

Recommended staging gate before calling this a release candidate:

1. Fix all P0 and P1 defects.
2. Add CSP and upload limits.
3. Add a backup and restore flow with a restore test.
4. Add schema versioning and migration tests.
5. Sign Windows artifacts and run Linux and macOS CI at least once.
6. Run a 500-card board performance test and a crash-free 24-hour session.
7. Freeze a version and publish checksums.

## Current security level

Overall: **moderate for a single-user local app, low for multi-user or self-hosted use**.

### Existing protections

- No account, no cloud and no remote API by default.
- SQLite database and assets stay on the local machine.
- Asset protocol scope is limited to the app data directories.
- Downloads are restricted to files inside the app assets directory.
- Stored asset filenames are sanitised.
- External links open in the system browser.
- Tauri IPC exposes a narrow set of commands.
- Native file drops copy files into the app asset store instead of opening them in place.

### Gaps

- Windows binaries are not code-signed.
- Database and assets are not encrypted at rest.
- No auto-update signature verification.
- Dropped and uploaded files are read fully into memory before the 100 MB check, so a very large drop still spikes memory.
- MCP over stdio has no authentication. Any local process that can start it could reach the database.
- External video and map embeds are remote content.
- No audit trail, crash reporting or tamper detection.
- No threat model or penetration test for a future server.

Recommended security work before staging: set a CSP, cap upload size, validate MIME and extension, sign installers, add a signed updater, document the local threat model, and add a database backup with integrity check. The full self-hosted security plan is in `ROADMAP.md` and must be implemented before any account or sharing feature ships.

## Feature suggestions

Near term:

- Command palette and global search across cards.
- Backup and restore UI, plus export/import of a board package.
- Version history browser with restore.
- Image compression and thumbnail generation to reduce the 26 MB asset footprint.
- Better file list, recent files and board background options.
- Large-board performance mode and virtualised rendering.
- Accessibility pass for keyboard navigation, focus order and screen readers.

Later:

- Tags and smart filters.
- Shared board sections from the roadmap.
- Optional encrypted local vault.
- Mobile companion viewer before a full mobile editor.
- Template packs and user-created templates.

## Short recommendation

Use this build as an internal alpha. Do not call it stable staging until CSP, upload limits, backup and restore, signing and migration tests are complete. The product surface is already broad; the next milestone should focus on reliability, data safety and release engineering rather than more card types.

## Execution update, second batch

Implemented after the first status snapshot:

- Command palette with Ctrl+K search, Recently used, grouped Tools/File/Edit/View/Help results, arrow-key navigation and shortcut labels.
- Application menu bar: File, Edit, Tools, View, Help, plus a Search commands button.
- Board background presets, performance mode, JSON board export/import, and recent-board commands in File.
- Tauri content security policy enabled; the app boots with no CSP console errors.
- 100 MB upload and native-drop limit, executable/script extension block list, and Rust-side filename validation.
- Consistent backup through `VACUUM INTO` plus an assets copy under Documents/Khaoyu Note Backups.
- Integrity check through `PRAGMA integrity_check`, restore staging with restart, and schema-version checks on every open.
- Picked images larger than 1.5 MB are downscaled to at most 2000 px and encoded as WebP when that reduces size.
- 500-card render benchmark added as `tools/test-performance.mjs`; current browser measurement is about 28 ms for 500 cards and 1,720 DOM nodes.

Verification at this update:

- UI suite: 207/207.
- MCP smoke suite: 14/14.
- Real app CSP: no console or page errors after boot.
- Real app backup returned a backup path, and `PRAGMA integrity_check` returned `ok`.

Still blocked by the environment or missing credentials:

- Windows code signing requires a real code-signing certificate.
- macOS packaging and notarisation require a macOS runner and Apple credentials.
- Auto-updater signing requires a separate update key and hosting.
- Linux and macOS CI workflows are prepared but cannot run from this Windows machine.
- Mobile companion viewer is not started.
- Tags, version-history browser, image thumbnails and crash-report UI remain open.

## Design system audit and chrome update

- Menu bar moved to the top chrome row and now holds the logo, menu groups, centered Search commands control and the icon actions in a fixed three-column grid; the header below it keeps the template button, breadcrumb and save state.
- Global focus-visible follows Khaoyu: accent outline for buttons, links, summaries and role buttons; input glow for inputs, textareas, selects and contenteditable.
- Added active states to the shared button classes and compact controls.
- UI suite increased to 211/211.
- Full audit matrix and remaining accessibility gaps are in docs/design-system-audit.md.

## Hardening update after the audit

- Saves keep their dirty flag on failure, retry with capped backoff, and use a 5 second SQLite busy timeout.
- Writes send a base `updatedAt`; a stale write is rejected and the UI offers "load newer version" or "keep my version as a copy".
- Restore validates the backup, writes a pre-restore copy, swaps through staging files, and never blocks startup on failure.
- `open_path` is limited to the asset folder; file and URL opening uses ShellExecuteW instead of `cmd /C start`.
- Legacy second-sized timestamps are normalised to milliseconds on open.
- Backup, export and pre-restore names are collision-free within the same millisecond.
- A failed legacy JSON import keeps the folder and retries on the next launch.
- MCP search snippets preserve Unicode, `create_card` cannot override id/type through `fields`, and deleting a card removes its full descendant subtree.
- Verification: 253/253 UI, 11/11 conflict, 4/4 save retry, 4/4 board selection, 8/8 rename, 5/5 board card title, 9/9 column layout, 7/7 column title, 5/5 kanban scroll, 6/6 tool drop, 5/5 wrap selection, 7/7 tooltips, 6/6 line area, 24/24 card features, 10/10 localhost web, 5/5 font weights, 16/16 MCP, 42/42 service foundation, auth, SSO, passkeys, sharing, nested shares, assets, collaboration, notifications, email, admin, backup, transport hardening, email queue and malformed-request handling, sync engine checks, 8/8 passkey browser checks, 8/8 browser sharing checks, 8/8 share viewer checks, 4/4 first-run checks, 11/11 browser account checks, 10 Rust library tests and 2 MCP unit tests.
- A localhost web host (`server.mjs`) now serves the same frontend against the same SQLite database and assets, with `/status`, a menu-bar host badge and Settings > About details.
- A self-hosted service foundation (`service/`) now provides fail-closed configuration, explicit reversible migrations, account/project/membership/audit/object tables, content-addressed object storage, a maintenance worker, health endpoints, backup/restore and Docker Compose deployment.
- The service account core now adds Argon2id registration, email verification, rotating refresh tokens with reuse detection, session revocation, password reset, TOTP, account deletion grace, CSRF/cookie hardening, project role checks and scoped API tokens.
- The service sharing core adds project/item/column share scopes, hashed revocable and rotating links, expiry, optional passphrases with rate limiting, noindex responses, per-access audit, email-bound invitations, member removal and ownership transfer.
- The service now also provides email one-time login codes, a global public-sharing kill switch, share abuse reports and an explicit session invalidation command for upgrades.
- Project assets can be uploaded, listed and downloaded with membership checks; share downloads require the download flag and are audited.
- Shared projects keep revision history with editor restore and authenticated per-project SSE rooms for snapshot and presence events.
- In-app notifications are scoped to current resource access, store read state per account and are removed when a share is revoked.
- Share links with comment or edit permission can add scoped comments and edit allowed card fields, with passphrase, revision, audit and owner notification.
- Service mail now supports SMTP with an outbox fallback, opt-in notification email, signed unsubscribe links and a five minute notification email rate limit.
- Desktop boards support opt-in server sync with explicit status, revision conflict choices, an offline queue, scoped API tokens and a local-only disable that never deletes server data.
- Operator admin endpoints expose audit export, abuse reports and service counts behind a separate rate-limited token.
- Threat model, disclosure policy, incident response, release checklist and data residency docs are in the repository.
- Backups can be encrypted with a scrypt-derived AES-256-GCM key, and login blocks can post a structured alert to an operator webhook.
- Optional trusted-proxy SSO signs the proxy email with HMAC, can auto-create verified accounts and audits SSO sessions.
- Presence is opt-in per account, and share comments mention project members by email with scoped notifications.
- Optional HTTPS enforcement rejects plain requests behind a trusted proxy, and uploads validate image signatures with optional scanner hooks.
- WebAuthn passkeys can be registered and used to sign in from the service `/passkeys` page, with single-use challenges and last-credential protection.
- The `/account` page covers registration, verification, reset, sessions, logout everywhere and scoped API token creation for desktop sync.
- Project shares include eligible same-owner nested boards with a documented exclusion policy, and desktop sync links nested boards when the parent is already synced.
- The `/shares` page requires an explicit public-sharing acknowledgement, creates scoped links, shows tokens once and revokes links.
- Failed SMTP sends are queued in `email_jobs` and retried by the worker with exponential backoff.
- Shared links open a read-only `/s/:token` viewer with passphrase handling, scope isolation, neutral errors and noindex.
- Help > Documentation opens an offline in-app guide with cards, shortcuts, sync, accounts, sharing and troubleshooting.
- The menu bar sits above the file header, with a right-corner Share control, per-board access, default view-only links, optional passwords and a right-click Share link action.
- First-run setup offers local-only use, account creation on a service, or connecting a custom server with an API token.
- Settings navigation is Account, divider, General, Appearance, Tools, Performance, divider, MCP, About. Language and Canvas are merged, Tools is a two-column icon grid, and Account links the service pages.
- The desktop app and service account, passkey, sharing and share viewer pages use the same framework stylesheet (`ky.css`); the service adds only an auth-panel layout layer.
- Account browser checks now include the shared service design tokens.
- Link header images and image cards support free crop with a Fit to image reset, applied from the context menu; the crop dialog fits the whole image on screen before editing.
- Audio editing uses a clip-only upload button and Submit; uploading again while editing replaces the source before submit.
- Audio playback supports MP3, WAV, M4A, AAC, OGG, Opus and FLAC MIME types in the web host and preview fallback, with a visible error toast for unsupported files.
- Video embeds render a centered circular play button and load the autoplay embed only on click. Audio and video context menus expose Play, Pause and a Repeat checkbox with disabled states tied to playback.
- Link cards fetch an Open Graph hero image automatically in the desktop and web host, with SSRF host guards, a size cap and a dotted globe fallback when no image is available.
- Duplicate, copy, cut and paste include a column subtree, remap parent IDs and select only the copied roots.
- Malformed request targets such as `//` return a 400 response instead of throwing and terminating the service.
- Registration creates a verified account immediately; email verification is disabled, its endpoint returns 410 and its form is hidden from `/account`.
- External video and map iframes now run in a sandbox with a strict referrer policy.
- The Milestones 1 to 3 audit is recorded in `docs/security-audit.md`; the largest open risks are desktop sync, SMTP delivery, service asset authorization and a global sharing kill switch.
- Sharing, SMTP delivery, SSO, passkeys, scoped API tokens, a browser login UI and desktop sync remain pending.
- Deleting a board tree now runs in one transaction and terminates on a parent cycle.
- Corrupt card or connection JSON is reported on stderr instead of disappearing silently, and `boards.parent_id` has an index.
- Cards support a persisted position lock: they stay selectable for unlocking but block drag, resize, inline editing and sheet or column handles.
- Context actions convert a note into a document with its text and a column into a nested board card with its items, plus Add header image for link cards at the image's natural ratio.
- Sheets inside columns scroll inside the card, with the column-letter strip clipped and synchronized to horizontal scroll and row numbers to vertical scroll; the drop preview follows the fitted width and content height.
- Sheet scrollbars accept pointer drags and the mouse wheel without starting a card drag.
- Rich text applied to a note or heading from the contextual toolbar now persists through `card.html` and is rendered after focus leaves; converting a formatted note to a document keeps the rich preview instead of escaped HTML.
