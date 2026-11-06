# Khaoyu Note Roadmap

This roadmap covers the planned move from a local-first desktop app to an optional self-hosted
service with accounts, sharing and collaboration, plus an optional AI assistant that can organise
boards and research with explicit permissions. It is a planning document only: none of the server,
login, sharing or AI assistant code described here exists yet.

Status: `[x]` means done and verified in this repository. `[ ]` means planned, or partial with the
remaining work named in the item.

## Current state

- [x] Desktop app: Tauri v2, vanilla ES modules, local SQLite.
- [x] Localhost web host serves the same frontend against the same SQLite database and assets.
- [x] No account, no cloud, no outbound sync.
- [x] The MCP server runs locally over stdio and shares the same database.
- [x] Boards, cards and columns are scoped to one local database.

## Product goals

- [x] 1. Keep the local-first desktop experience fully usable without a server.
- [ ] 2. Offer an optional self-hosted server for teams that want accounts and sharing.
- [ ] 3. Support login and roles, but never make login mandatory for local boards.
- [ ] 4. Share a whole project, a single card, or a column without exposing the rest of the board.
- [ ] 5. Treat security, privacy and data ownership as first-class requirements.
- [ ] 6. Add an optional AI assistant that can organise, research, browse and edit only with explicit user consent.

## Milestone 1: Self-hosted service foundation

### Architecture

- [x] A standalone server process that the operator runs with Docker Compose or a native binary.
- [x] Restricted network surface: one HTTP(S) port, optional reverse proxy, no direct database port.
- [x] Relational database for accounts, projects, memberships and audit data.
- [x] Object storage for uploaded assets, addressed by opaque ids, never by user-supplied paths.
- [ ] Background worker for email invitations, thumbnails, backups and cleanup jobs (partial: scheduled backups, temp cleanup and audit pruning implemented; email and thumbnail jobs pending).
- [x] Health endpoint that does not leak version, database or configuration details.

### Deployment

- [ ] Supported deployment profiles: single-user, small team, reverse proxy behind HTTPS (partial: single-user and proxy deployment documented; team profiles wait for accounts in Milestone 2).
- [x] Configuration through environment variables or a secrets file, never committed to the repo.
- [x] Startup fails closed when required secrets are missing or weak.
- [x] Database migrations run explicitly and are reversible where practical.
- [x] Backup and restore procedures documented before public release.
- [ ] Upgrade path preserves all user data and invalidates sessions predictably (partial: schema and backups preserve data; session revocation lands with Milestone 2).

### Local-first boundary

- [x] The desktop app remains authoritative for local boards.
- [ ] Server sync is opt-in per project and shown with an explicit sync state.
- [ ] Offline edits queue locally, sync later and surface conflicts instead of silently overwriting.
- [ ] A deleted local database never deletes server data without an explicit confirmation.

## Milestone 2: Accounts and login

### Account model

- [ ] Email and password registration with email verification.
- [ ] Unique, case-normalised email addresses; display name separate from email.
- [ ] Account deletion request with a grace period, export before deletion.
- [ ] Optional second factor: TOTP first, passkeys later.
- [ ] Optional SSO for self-hosted enterprise deployments, behind an operator flag.

### Authentication

- [ ] Passwords hashed with Argon2id and per-user salts; parameters tuned and versioned.
- [ ] Short-lived access tokens plus rotating refresh tokens stored as hashes server-side.
- [ ] Refresh token reuse detection revokes the whole session family.
- [ ] Session list with device label, creation time, last seen time and a revoke action.
- [ ] Logout everywhere action.
- [ ] Login throttling per account and per IP, with progressive delays and alerting.
- [ ] Generic login errors that do not reveal whether an email exists.
- [ ] Password reset tokens single use, short lived, hashed at rest and bound to the account.
- [ ] Optional email one-time codes as an alternative login method.

### CSRF and browser security

- [ ] Session cookies use `Secure`, `HttpOnly` and `SameSite=Lax` or stricter.
- [ ] State-changing requests require CSRF tokens or a strict origin check.
- [ ] Content Security Policy on every server-rendered response.
- [ ] No secrets, tokens or personal data in URLs or logs.
- [ ] Third-party iframe embeds isolated and documented, since media cards load external content.

### Authorisation

- [ ] Server-side authorisation on every request; the client never decides access.
- [ ] Role and permission checks at the resource boundary, not only in the UI.
- [ ] Object-level checks for board, card, column, asset and share link ids.
- [ ] Deny-by-default policy for unknown routes and unknown resource types.
- [ ] MCP and API integrations use scoped tokens, not the user's password.

## Milestone 3: Sharing model

### Share scopes

- [ ] **Project share**: a whole project, including nested boards according to policy.
- [ ] **Item share**: one card, with enough context to render it, but not sibling cards.
- [ ] **Column share**: a column and its current children, with an explicit notice that later
  additions may or may not be included depending on the permission chosen.
- [ ] Per-scope permissions: view, comment, edit, manage.
- [ ] Optional expiry date, optional download permission, optional password protection.

### Share links

- [ ] Share links use high-entropy random tokens, stored hashed, never logged in full.
- [ ] Links are revocable and can be rotated; rotation invalidates the old token immediately.
- [ ] Expiry enforced server-side; expired links return a neutral not-found page.
- [ ] Optional passphrase verification with rate limiting and no hint about content.
- [ ] Link previews do not expose board titles, card text or asset contents.
- [ ] Every access is attributable to a share link and an IP hash for audit purposes.

### Members and invitations

- [ ] Project membership with roles: owner, editor, commenter, viewer.
- [ ] Invitations are single-use, expiring, email-bound and revocable.
- [ ] Ownership transfer and owner removal safeguards, so a project cannot become orphaned.
- [ ] Members can be removed immediately; their session loses access on the next request.
- [ ] Sharing a column or item never grants access to unrelated sibling content.

### Public sharing

- [ ] Public sharing is off by default and requires an explicit warning.
- [ ] Public links show only the selected scope.
- [ ] Search engines excluded with `noindex` and no sitemap exposure.
- [ ] Optional watermark and download restrictions for shared assets.
- [ ] Abuse reporting and a kill switch for operators.

## Security architecture requirements

### Data protection

- [ ] TLS everywhere; HTTP redirects to HTTPS or refuses to serve.
- [ ] Encryption at rest for the database volume and object storage where the platform supports it.
- [ ] Application-level encryption for highly sensitive fields if the deployment requires it.
- [ ] Asset access checked through signed, short-lived URLs or an authenticated proxy.
- [ ] No asset directory listing and no predictable asset filenames.
- [ ] Database and storage backups encrypted, with documented retention and deletion.

### Input and output safety

- [ ] Server-side validation for every request body, parameter and upload.
- [ ] Upload filename sanitisation, MIME sniffing, size limits and malware scanning hooks.
- [ ] Markdown and rich text sanitised on the server before rendering.
- [ ] Stored XSS prevention through context-aware escaping and a strict CSP.
- [ ] Parameterised database queries only.
- [ ] Explicit allowlists for redirects and remote embed hosts.
- [ ] Rate limits and payload limits on all public endpoints.

### Secrets and operations

- [ ] Secrets supplied by the environment or a secret manager, never baked into images.
- [ ] Separate database credentials per service and least-privilege database roles.
- [ ] No secret material in client bundles, crash reports or analytics.
- [ ] Structured audit logs for login, permission changes, share changes and destructive actions.
- [ ] Audit retention and export policy defined per deployment.
- [ ] Dependency scanning, container scanning and a documented patch cadence.
- [ ] Security headers: HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.
- [ ] Admin endpoints separated, authenticated, rate limited and audited.
- [ ] A documented incident response path: rotate secrets, revoke sessions, revoke links.

### Privacy

- [ ] Data minimisation: collect only account email, display name and operational logs.
- [ ] No third-party analytics by default on self-hosted deployments.
- [ ] Export and delete account data on request where legally applicable.
- [ ] IP addresses hashed in audit logs where full addresses are not required.
- [ ] Clear data residency and backup location documentation for operators.

## Milestone 4: Collaboration and sync

- [ ] Realtime collaboration only after authentication, authorisation and audit are complete.
- [ ] Per-project rooms with membership checks on connect and on every message.
- [ ] Presence is opt-in and does not reveal board contents to non-members.
- [ ] Conflict handling for offline edits with a visible resolution flow.
- [ ] Revision history for shared projects, with restore limited to editors and above.
- [ ] Comments and notifications respect scope: a column share cannot leak board-wide activity.

## Milestone 5: Notifications and activity (server side)

- [ ] Server notifications for invitations, role changes, comments on shared scopes and mention events.
- [ ] Email notifications opt-in with unsubscribe links and rate limiting.
- [ ] In-app notifications scoped to the resources the user can currently access.
- [ ] Deleting or revoking a share removes its pending notifications.
- [ ] Notification read state stored per user, never shared between accounts.

## Milestone 6: Quality and security validation

- [ ] Threat model reviewed before the first server release.
- [ ] Automated tests for authentication, authorisation, share scopes and session revocation.
- [ ] Integration tests for cross-account access attempts, IDOR and link expiry.
- [ ] Load and abuse tests for login, public shares and uploads.
- [ ] External penetration test before advertising self-hosted production use.
- [ ] Security disclosure policy and contact address published.
- [ ] Release checklist includes backup restore test and secret rotation test.

## Explicit non-goals for the first server release

- [ ] End-to-end encrypted collaboration.
- [ ] Anonymous public editing.
- [ ] Plugin execution on the server.
- [ ] Multi-tenant SaaS billing.
- [ ] Real-time presence across unrelated projects.

## Decision log

- [ ] Keep local-first as the default and server sync as an option.
- [ ] Prefer self-hosted single-tenant deployments before any hosted offer.
- [ ] Share by scope (project, item, column) rather than by cloning boards.
- [ ] Server-side authorisation is the source of truth; UI state is never trusted.
- [ ] Security review gates the public self-hosted release.

## Milestone 7: Packaging and platform distribution

Packaging starts only after the stable release criteria are met. Detailed build and signing instructions live in `docs/packaging.md`. Build artifacts must be produced on native
runners in CI, not by cross-compiling from a single Windows machine.

### Release gates

- [ ] No open P0 or P1 defects.
- [x] Local-only mode passes the full UI and MCP suites (213 UI checks, 16 MCP checks).
- [ ] Backup and restore verified on each platform (Windows verified; Linux and macOS pending).
- [ ] Version and changelog frozen for the release.
- [ ] Signing keys and release secrets available before the first public build.

### Target matrix

- [x] Windows: NSIS, MSI and portable `.exe` artifacts build and are published in `dist/` (unsigned).
- [ ] Windows: code signing, WebView2 install prompt, per-user install and uninstall cleanup.
- [ ] Linux: AppImage and Flatpak.
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
