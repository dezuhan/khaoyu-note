# Changelog

All notable changes to Khaoyu Note are recorded here. The format follows Keep a Changelog and the
project uses Semantic Versioning.

## [Unreleased]

- Local storage keys moved from the `mn.` namespace to `ky.` (boards, settings, theme, servers,
  workspace cache, sync queue, templates, views, assets and update cache). A one-time migration
  copies legacy `mn.*` values to `ky.*` and removes the old keys, so existing browser data survives.
- Server-backed boards now keep a durable local mirror and a per-operation sync queue in IndexedDB
  (localStorage fallback). Every save is captured as granular operations before the network push, so
  offline edits survive a reload, retry with exponential backoff and report pending, syncing, blocked
  or failed states. A `seq_conflict` replays the remote operations and resends the local patches; a
  whole-document replacement that races a remote change now surfaces as a conflict instead of
  overwriting it. The last remote workspace board reopens from the mirror after a reload, including
  offline, and the workspace popover keeps the last known board list.
- Fixed remote workspace boards that stopped autosaving after the first save: the remote save path
  kept its in-flight flag set, so every later save was deferred indefinitely and stayed "Saving".
- A `seq_conflict` rebase now adopts the merged document into the open editor, so the next save cannot
  emit inverse operations (deleting cards another client added or reverting its edits). Removed card
  fields are sent as explicit null tombstones, a queued operation for a document that the server
  rejects fails visibly with a **Discard queued changes** action, and `sync_required` replays pending
  edits instead of dropping them. Queue ids fall back to a local generator because
  `crypto.randomUUID` is unavailable on the documented plain-HTTP LAN web host.
- The generated theme copies were re-synced from `shared/theme` after the `ky.theme` storage-key
  migration, which fixes the `theme:check` CI drift.
- Sync queues are now stored per board **and per tab**, so two browser tabs cannot overwrite each
  other's pending operations; a queue left by a closed tab is drained by the next flush. Overlapping
  `(cardId, field)` edits discovered during a rebase are reported as field conflicts while the local
  value wins (last writer per field, server sequence as timestamp), with **Use server values** and
  **Dismiss** actions in the Sync dialog.
- Connection edits travel as a `connections.set` operation instead of replacing the whole board
  document, so a connection change can no longer overwrite unrelated remote cards. Bulk operations
  (`doc.replace`, `connections.set`) may be up to 4 MB; card operations stay at 256 KB.
- Operations now carry a causal clock. The service stores it on `project_ops` and on a new
  `project_field_versions` table (SQLite migration 020, PostgreSQL migration 008) and reports a
  `fieldConflicts` entry when a field write is concurrent with the stored write, so conflicts are
  detected even when the operation log has been pruned. Disjoint text edits on the same field are
  three-way merged on rebase and on the live SSE path, which captures unsaved local edits before
  adopting a remote document; rebase and live-merge are serialized per board.
- The sync model documents the causal clocks, the three-way text merge and the remaining
  character-level CRDT prerequisites in `docs/sync-model.md`.
- Opening a board id that no longer exists (a board card for a deleted/missing board, a stale
  notification target or an old URL) no longer creates a phantom "Untitled board" in the local
  workspace list. The app shows a toast and falls back to another local board (or the welcome board).
- Local boards in the workspace chooser can be removed with the hover × action and a confirmation.
- Rows and columns now expose edge resize handles (top, bottom, left, right plus the bottom-right
  corner), so a row can be resized vertically as well as horizontally. Dragging the bottom edge adds
  extra height while the automatic height still follows the content; clicking a column raises it to
  the front so its handles stay reachable.
- The top bar shows up to three avatars of other people currently viewing a synced board, with a +N
  badge for the rest. Presence comes from the existing project SSE roster, excludes the current
  account, dedupes multiple tabs per account and uses a deterministic avatar colour.
- The colour picker no longer shows the "Drag the square or the hue bar, or type a HEX value." hint.
- The workspace switcher remembers the last opened workspace per server and loads its board list as
  soon as the popover opens. On a fresh profile the seeded default workspace is not selected
  automatically while another workspace exists. A workspace detail now offers **New board**, which
  creates the board inside that workspace (the service accepts `workspaceId` on project creation for
  workspace owners and admins).
## [0.36.0] - 2026-11-12

### Added

- Automatic backups now use a distinct folder prefix and keep only the newest seven copies; older
  automatic folders are pruned after a successful backup. Manual backups and the folders imported
  through the Backup pane are never removed automatically.
- The Backup pane describes the retention rule in all ten UI languages.
- The self-hosted service admin keeps the left navigation rail and adds a top menu bar in the app's
  chrome style with the same logo asset, SVG icon set and fonts: Dashboard and Help menus, command
  search with Ctrl+K, host badge, theme toggle and a circular account button next to it that opens
  the Account menu (Admin dashboard, Account settings, Help, Logout). Sharing stays inside the
  dashboard; `/shares` redirects to `/admin#sharing`.
- The main editor tool rail is now a floating inset panel: fixed at 12 px from the left, top and
  bottom edges, rounded and shadowed above the canvas. The canvas runs beneath it (no reserved
  gutter), and the rail cannot be dragged.
- The web app and every service page declare SVG and PNG favicons rendered from the shared brand
  mark, so browser tabs and touch shortcuts show the Khaoyu icon.
- Share links can carry an optional view watermark and a per-link download cap. The viewer overlays a
  low-opacity project label when watermarking is enabled; asset downloads increment an atomic counter
  and return `download_limit_reached` after the cap. Downloaded files themselves are not modified.
- Shared rich text is sanitised on the server with an allowlist (`html`/`markdown` fields), so public
  JSON cannot carry scripts, event handlers or unsafe URLs even when API clients render it.
- Remote video embeds accept only the exact YouTube and Vimeo hostnames; typosquatted hosts such as
  `evilyoutube.com` no longer render an iframe.
- Uploaded objects can be encrypted at rest with `KHAOYU_SERVICE_OBJECT_KEY` (AES-256-GCM); existing
  plaintext objects stay readable. The worker now revokes expired invitations and share links and
  records `last_worker_at`/`last_worker_summary`, and `service/deploy/postgres-least-privilege.sql`
  documents a data-only PostgreSQL role.
- Admins can create member accounts manually from the Accounts pane (email, display name,
  temporary password and member/admin role), with the signup password policy, duplicate-email
  protection and `admin.user_created` audit entries. Only admin-authenticated sessions can use it.
- Admins can rename and delete teams from the dashboard. Deleting a team soft-deletes it and its
  child boards, disables public sharing and revokes its share links and invitations. Admins can also
  add an existing account to a team by email with an editor, commenter or viewer role, change that
  role and remove the member; the owner row is immutable. Every action writes an `admin.*` audit row
  and all endpoints require the admin role and CSRF token.
- Project sync gained an operation log: `POST /projects/:id/ops` applies idempotent operation batches
  with per-project sequence numbers, `GET /projects/:id/ops?after=` replays or asks for a resync, and
  worker retention keeps the log bounded.
- The desktop/web sync client now pushes `doc.replace` operations with `baseSeq`, tracks `lastSeq`,
  opens the ticket-authenticated SSE stream and refreshes a clean board when a remote operation or
  snapshot arrives. The setup wizard enables the Collaboration path and hands off to Server sync.
- The worker compacts operation rows beyond `KHAOYU_SERVICE_COMPACT_OPS` and continues to prune by
  retention age.
- The realtime backend now issues single-use SSE tickets, aggregates presence globally through Redis,
  provides advisory edit locks with TTL/heartbeat, runs maintenance behind a Redis worker leader lock,
  and reports `realtime: ok/degraded` from `/readyz`. Migration 015 / PostgreSQL 003 adds
  `project_ops` and sequence columns.
- `shared/theme/` is now the single source for the token stylesheet, fonts, SVG icon set, brand mark
  and theme runtime. `npm run theme:sync` generates the app and service copies, and CI runs
  `npm run theme:check` to fail on drift.
- The palette token layer was renamed from `--ph-*` to `--ky-palette-*`, so colour uses one `--ky-*`
  namespace in the app and the service. Service pages share the `khaoyu.theme` key and migrate the
  old admin/auth keys; the app keeps `mn.theme`.
- Geometry is now a shared token scale (`--ky-space-*`, `--ky-text-*`, `--ky-radius-*`), and
  `shared/theme/components.css` supplies the `.ky-card`, `.ky-section` and `.ky-table` used by the
  service pages. Every padding, margin, gap, font size and radius in `admin.css`, `auth.css` and
  `ui.css` uses those tokens; `test:theme-css` fails if literal px values return.

### Fixed

- Board cards are focusable groups: selecting a card inside a column now shows the accent selection
  ring (it was hidden by the child hairline), and keyboard focus shows a 2 px accent outline.
- The Share dialog is reorganized into clear Board link, Create a share link and Active links
  sections: the board URL and copy action share one row, the form fields align in two columns, and
  Create/Copy actions sit together without the previous empty vertical gaps.
- Passkey registration now issues ten one-time **backup codes** (both in the admin Security page and
  on `/passkeys`). Codes are hashed at rest, shown once, invalidated on regeneration, and can be used
  with an email on the login page as a passwordless fallback. Migration 016 adds `recovery_codes`.
- The Activity table scrolls inside its rounded section card with a sticky header, so the card outline
  and Load more control remain visible while browsing a long audit trail.
- Deployment-readiness pass: PostgreSQL tests now reset the schema between suites so the full
  PostgreSQL/Redis service suite passes in one run; stale CI expectations for the enabled Share/Sync
  controls, Account Management, preview reservation and activity layout were updated.
- Hard per-card edit locks are acquired while an editable field has focus; the server rejects a second
  editor's card operations with `423 card_locked`. SSE connections emit a `ready` id, clients publish
  debounced cursor/selection state, and remote carets/selections render with the editor name.
- Added a synthetic concurrent operation load check (`npm run test:collab-load`): six clients,
  360 operations, consistent log/card counts, p95 8 ms locally. Production-scale load testing remains
  a release gate.
- Added `service/scripts/uninstall-team.sh` with a safe stop mode (volumes retained) and an explicit
  `--purge` mode for deleting the team database, assets and environment; documented desktop/web
  uninstall and the intentional absence of a server-wide HTTP database drop.
- Secured the web host full-reset endpoint behind an authenticated admin session and CSRF token;
  the destructive action remains explicit and local-only in scope.
- Added a dedicated team Docker stack (`service/docker-compose.team.yml`), a one-command
  `service/scripts/setup-team.sh` installer that generates secrets and bootstraps the owner, and a
  team `.env.team.example`. PostgreSQL and Redis stay internal; migrations run on service startup and
  Cloudflare Tunnel is an optional compose profile.
- The localhost web host now has a session-authenticated SSE stream (`/api/events`) with a
  1.2-second SQLite change watcher. Edits in one browser/phone/tunnel window reach other open web
  windows without a reload; web autosave runs after two seconds idle, and the desktop app polls the
  shared database. This is separate from service collaboration and does not require WebSocket.
- Board viewport position and zoom are now stored per device instead of being written into the board
  row. Opening a board from a phone/tunnel can no longer conflict with a desktop window merely
  because one side panned or zoomed; content conflicts still use the explicit conflict dialog.
- Added `scripts/reinstall-team.sh` for a fast uninstall + install cycle: the default keeps
  PostgreSQL/service data and `.env.team`, while `--purge` performs a destructive fresh reinstall.
- Desktop/web "Reset app data" now prepares the store before wiping: autosave timers and the
  beforeunload save are suppressed, in-memory boards are detached, and a failed reset reloads the
  existing data instead of leaving a blank session. This prevents a pending save from writing the old
  board back after the database was cleared.
- The installer normalizes bare domains to `https://` and validates both public URLs before
  starting Compose, preventing a service restart loop from a URL without a scheme.
- The team installer now accepts separate backend/admin and public-view/share domains, and writes
  them to `KHAOYU_SERVICE_PUBLIC_URL` and `KHAOYU_SERVICE_SHARE_PUBLIC_URL` so generated share links
  use the public-view origin.
- Pending accounts now use an Awaiting approval badge with primary Approve and outlined Reject
  actions. Both actions open a confirmation dialog; rejection disables the account and approval can
  re-enable it later.
- Workspace invitations and member management are now available through APIs and the main
  frontend workspace popover: invite by email, list members, change member roles, and accept or
  decline pending invitations. Board-level grants remain the existing project member overrides.
- Added first-class workspace schema: `workspaces`, `workspace_members`,
  `workspace_invitations`, `workspace_access_policies`, and `projects.workspace_id`. A fresh service
  seeds a default team workspace with viewer as the member default board role; existing projects and
  approved accounts are backfilled. Workspace APIs list/create workspaces and list boards with
  effective roles, and the main frontend workspace popover now shows server → workspace → board.
- Autosave is now near-realtime: web/localStorage boards persist on an 80 ms throttle while typing,
  remote boards save at 120 ms with a 30 ms temporary-buffer write and a 60 ms service push. Desktop
  SQLite saves use a 250 ms idle window. The autosave UI test now asserts the fast behavior.
- Remote workspace editing now writes a durable temporary copy to `ky.remoteTemp.<boardId>` before
  the network push. Switching boards/workspaces flushes that copy, starts the service push in the
  background, and recovers pending edits when the board is opened again. Page hide/visibility changes
  persist the temporary copy for recovery.
- Remote workspace boards now autosave on a 400 ms throttle while typing and push their operation
  diff to the service within about 120 ms after the local save, so owner/editor changes appear on the
  team database without an explicit Save. A stale timer id from the previous local board could block
  the remote save loop; board switches now reset it.
- Remote workspace boards now open in the real main board editor for owner/editor roles instead of
  the read-only preview. Remote boards use a non-persisted in-memory mode so their operation diff is
  pushed to the service rather than mirrored into the local SQLite card table; viewer accounts still
  get the read-only preview. The template button opens the workspace popover after normal app boot.
- Create workspace now matches the Affine flow inside the app toolbar: “Name your workspace”,
  workspace description, workspace name, and a workspace type selector for Local storage or any
  connected server. Local workspaces create a local board; server workspaces use the workspace API.
- Workspace switching now opens as an Affine-style popover from the existing template/workspace
  button instead of a full-screen page or a separate menubar button. The server-add flow uses the
  design-system modal (no native browser prompt), floating menus sit above the tool rail, and admin
  workspace links have no underline.
- The main board frontend now owns workspace switching and public board viewing. It adds a Workspace
  menu with Local/Add Server, remote board lists, read-only share rendering via
  `/?share=<token>&server=<origin>`, and a `?workspace=1` entry point. The service `/workspace` and
  `/s` routes redirect to the configured main app; the backend keeps login/admin/share management.
- The service root and login return to the admin dashboard (`/admin`). `/workspace` remains available
  as a direct service-side fallback; the main frontend keeps its own workspace popover. Public share
  links continue to use the main frontend.
- Added a team workspace model and `/workspace` web prototype: approved accounts automatically get
  viewer access to every server board (migration 18/6), with an admin able to promote per-board roles.
  The page lists local/remote servers, supports Add Server links, and opens read-only board previews.
- Added a Private/Public registration-access control to the admin dashboard, defaulting to Private.
  Private registrations are pending and cannot sign in until an admin approves them; Public
  registrations are active immediately and public share viewers show a Create an account link.
  Existing accounts and the bootstrap owner are auto-approved by migration 17/5.
- The public share viewer now renders the shared board as a scaled, read-only canvas preview with
  spatial card positions and themed card styles instead of a raw type label list; column shares show
  their scoped children and nested boards show their own previews.
- Live collaboration is now wired end to end: local board saves push granular card/title operations
  through the server-sequenced operation log, SSE ops events are replayed and applied to the other
  clients, and presence reflects connected accounts. Two browser clients merge distinct card edits
  live over SSE/Redis. Same-field concurrent text edits are last-writer-wins; character-level
  CRDT/OT and cursor presence remain future work.
- Sensitive account endpoints now have bounded rate limits: password change, TOTP setup/enable/
  disable, passkey registration, backup-code generation, export and account deletion. Added a
  self-hosted account-security readiness checklist documenting the remaining per-process limiter
  caveat, TLS/proxy requirements and TOTP-at-rest consideration.
- Passkeys can be temporarily switched off with `KHAOYU_SERVICE_PASSKEYS_ENABLED=false`. The login
  link, account Security card, passkey page actions and public feature lookup all respect the switch;
  password, TOTP and backup-code sign-in remain available.
- The `/admin` dashboard is now role-aware: members can use Account Management (Profile, Security,
  Login sessions) inside the same shell while all service admin navigation is hidden, and admin APIs
  stay protected. Added `/api/v1/account/profile` for member self-profile reads/updates; `/account`
  redirects to `/admin#profile`.
- Login now lands by role: admins go to `/admin`, members go to `/account`. A signed-in member can no
  longer bounce between `/login` and `/admin`; direct admin access redirects members to their security
  page.
- Settings now sits above the floating tool rail (z-index) so the rail is dimmed/blurred behind the
  dialog instead of floating above it. The Settings > Server passkey action card is hidden when the
  service feature endpoint reports passkeys disabled, or when no service is connected.
- The admin dashboard now owns the viewport: the service sidebar and menubar stay fixed while the active
  page scrolls inside the content pane. Account security pages use the same fixed-viewport model, so
  long pages no longer scroll the whole document.
- The admin dashboard now has an **Account Management** group under the service sections:
  **Profile** (display name, names, avatar colour/picture), **Security** (password, authenticator QR
  setup/disable, passkey registration/removal, API tokens) and **Login sessions** (device, created,
  last seen, revoke and sign-out-all). This replaces the separate /account settings flow for admins.
- The admin **Teams** area is now **Boards**, matching what it always listed: projects with an owner,
  member count, revision and update time. The API accepts `/api/v1/admin/boards` (the old
  `/admin/teams` paths remain as aliases). Accounts rows gain a Details panel with account metadata,
  2FA/passkey state, boards and active sessions.
- Admin writes made through the frontend listener no longer fail with `admin access required` when
  `KHAOYU_SERVICE_PUBLIC_URL` points at a proxy: the proxy forwards the original host and the
  same-origin check accepts it. This fixes deleting boards from the dashboard on the frontend port.
- The Settings dialog now sizes itself below the top toolbar (`min(760px, 100vh - 96px)`), keeps its
  content scroller bounded, and resets the content scroll position when switching pages so the first
  section is never clipped.
- The account security page now exposes authenticator (TOTP) setup with an inline QR code, enable
  and disable flows, and passkey readiness/instructions. `/account` is served directly again instead
  of redirecting to `/admin`, and the dashboard Account section links to it.
- Share links can use a public origin: `KHAOYU_SERVICE_SHARE_PUBLIC_URL` controls the absolute URL
  returned by the service, and **Settings > Server > Public share links** stores a client-side
  public origin for share links and browser board links. See `docs/public-sharing.md` for port
  forwarding, reverse-proxy and tunnel setups.


- Dragging a tool from the rail into a column or row inserts it at the pointer position, including
  before the first child; the drop preview line shows the target slot instead of always appending.
- Rows now follow the width of their cards instead of stretching every card to fill the row. Columns
  keep auto height and rows auto width after drops, with a short width/height transition so the
  reflow is visible without delaying resize drags.
- Rows default to the width of their cards. Manually resizing a row switches it to the previous
  stretch mode so the cards follow the row width; the context menu action "Fit container to items"
  restores the content-driven auto width. Auto-height columns keep their manual extra height.

- While a card or rail tool hovers a column or row, the target container now reserves the insertion
  slot live: a dashed drop placeholder appears, the column grows or the row widens, and cards after
  the slot shift before the pointer is released. Leaving the container restores the original layout.
- Existing cards dragged from outside a column/row now preview with their measured height and width,
  and dropping a child outside both axes releases it from the container instead of snapping back.



- Light/dark mode is now a global appearance preference. Opening or switching boards no longer
  applies a legacy theme stored in the board document or dirties the board, so the chosen theme
  stays the same everywhere and after a reload.
- The Teams pane uses a responsive full-width layout and a compact creation form, and the password
  fields keep the 24 px control height instead of stretching to the form row.
- The admin top bar no longer repeats Dashboard and Help buttons; the logo, command palette and
  Account menu cover both actions. The Account dropdown opens with a clear gap below the bar.
- The Sharing pane stacks Public sharing, Create a link and Existing links with the same 14 px gap as
  the rest of the admin dashboard; inline margin styles were replaced with geometry tokens.
- The signed-out admin card renders "Sign in to the service" as a real primary button with the app
  theme tokens (no underlined link) at a comfortable 32 px control height, so the label never looks
  clipped.
- The Account password fields use border-box sizing, so the three inputs keep their own grid columns
  instead of overlapping into one long control.
- Visiting the admin dashboard without a session now redirects straight to `/login` instead of showing
  an inline sign-in card. The service login, registration and reset pages reuse the main app logo,
  Plus Jakarta Sans / Space Mono fonts and the shared sun/moon theme icon.

### Security

- Logout over a cookie session now requires the double-submit CSRF header, so a cross-site form
  cannot sign the user out.
- Invitation creation is rate limited to 20 requests per 15-minute window per owner and IP.

## [0.35.0] - 2026-11-10

### Added

- First-run setup now disables **Collaboration** and **Connect to Turso** with Coming soon badges.
  Only Local SQLite/offline can be selected until the admin dashboard (Roadmap Milestone 10) and the
  libSQL adapter/migration flow (Milestone 9) are implemented.
- Display languages: English, Português (Brasil), Bahasa Indonesia, Español, Français, Deutsch,
  日本語, 한국어, 简体中文 and Русский. The language is persisted in `mn.language`, applied to the
  document, and the Settings navigation, General, Appearance, Board templates and Performance
  labels update immediately. The topbar language globe opens a select-style popover with all ten
  languages using the design-system `ky-select-popup`/`ky-select-item` styling (glass surface,
  rounded card, popup shadow and selected-row tint). Scrolling the language list no longer dismisses
  the picker, so all ten languages are reachable with the wheel. The toolbar tool names, topbar
  Template/Share/Search/Trash labels, Settings > Tools cards and the whole Settings > Backup page
  (including automatic-backup options and last-backup dates) follow the selected language. Board
  content is never translated. The menu bar (File/Edit/Tools/View/Help), every command in those
  menus, the command palette, and card context-menu actions are translated too. A source-level
  translation audit (`npm run i18n:audit`, also in CI) verifies all 190 wired keys in all ten
  languages; missing keys fail the check. Changing language now rebuilds the menu bar immediately,
  and Help > Documentation is disabled temporarily while the documentation localization pass runs.
- Settings > About has a **Reset app data** action. After confirmation it wipes every board, card,
  connection, uploaded file, account, setting and activity row, clears the remembered session and
  reloads into the first-run storage setup screen (single user or collaboration). The web host
  exposes it through `POST /api/reset`; the desktop app uses the `reset_app` command.
- The first-run storage screen after a reset offers Single user -> Local SQLite or Connect to Turso,
  and a Collaboration explanation. The choices are side-by-side radio cards; select one, then use
  Back/Next to continue. Turso and collaboration are marked as not available in this local build
  yet; Local SQLite continues into a fresh welcome board.
- Two or more selected cards can be wrapped in a Section sized to the selection bounds. Sections stay
  below the selected cards and are not parents.
- Deleting a board template now asks for confirmation, names the template, and warns that the action
  cannot be undone.
- Blank board is a protected built-in template: its Delete button is disabled and `deleteTemplate("blank")`
  is rejected even when called directly, so the template library always has a safe empty fallback.
- The column context menu has **Release kanban**, **Release row** and **Release column**. Releasing
  removes only the wrapper and leaves its direct children on the board at their current position,
  size and contents.
- **Wrap into kanban** now accepts columns that currently live inside another row/kanban and lifts
  them into the new container, so duplicated lanes from a template can be regrouped.
- Right-clicking two or more selected columns now offers **Wrap into kanban**. The result is a row
  column whose children are the selected columns, so one container model covers columns, rows and
  kanban-like boards. A Kanban starter template builds the same structure.
- The Edit menu, card context menu and command palette can clear the internal card clipboard.
- Board templates can be created from any selection with **Create template from selection**. Custom
  templates are stored separately from the board and appear in the template library with a Custom
  badge.
- The Color card now uses one manual HSV picker on web and desktop. The square, hue bar and HEX
  field are always available; the screen-eyedropper button only appears when the browser exposes
  EyeDropper (or desktop capture is supported), with a visible hint otherwise. The inconsistent
  zenity/kdialog fallback was removed.
- Desktop **Import database** now opens the native folder picker via `tauri-plugin-dialog`
  (Windows Explorer, macOS Finder, Linux portal/GTK/KDE file chooser), instead of a text prompt.
- **Open folder** now calls a dedicated `open_folder` command that validates the backup path and uses
  the OS file manager: Explorer, Finder or `xdg-open` (Nautilus/Dolphin/other default).
- Desktop backups now fall back to `<app data>/backups` when `Documents/Khaoyu Note Backups` is not
  writable, and honor `KHAOYU_NOTE_BACKUP_DIR`. This fixes Backup now / Export ZIP / Export database
  failures in sandboxed or read-only Documents directories.
- Settings > Backup has a **Database and migration** section: **Export database** streams a ZIP
  snapshot on the web host and writes one in the desktop app; desktop **Import database** restores a
  folder-shaped backup and restarts. The **Migrate to Turso** action is visibly gated because the
  libSQL adapter, token storage and asset migration are not implemented.
- `docs/production-readiness.md` audits collaboration (PostgreSQL + Redis) and Turso readiness and
  records the release gates. Turso is explicitly **not ready** for a production migration.
- Settings > About reports **Database size**, **Assets size** and **Total project size**. The web
  host reads them from `GET /api/storage/stats`; the desktop app uses a Tauri `storage_stats`
  command. Database size includes the WAL/SHM files, and total size includes assets.
- Settings > About has a translated **Feedback / Report Bug** action that opens
  `https://github.com/dezuhan/khaoyu-note/issues/new` in the browser/desktop shell.
- Settings has a **Board templates** page rendered as a two-column card grid with icons, names,
  descriptions, Custom/Built-in labels and Delete buttons, plus Create from selection and Restore
  built-in actions. The template library has an edit action next to Close that opens this page.

### Changed

- Settings > Performance reads physical GPU names from the operating system (Linux `lspci`,
  Windows `Win32_VideoController`, macOS `system_profiler`) instead of trusting the sanitized WebGL
  renderer string. The WebGL row is labelled separately as a hint.
- Linux desktop builds now apply WebKitGTK's hardware-acceleration policy from the GPU setting
  (`Always` / `Never`) instead of relying on Chromium-only browser arguments. NVIDIA + Wayland
  automatically gets `__NV_DISABLE_EXPLICIT_SYNC=1`; opt-in overrides (`KHAOYU_FORCE_GPU`,
  `KHAOYU_WEBKIT_DMABUF`, `KHAOYU_WEBKIT_COMPOSITING`, `KHAOYU_DEBUG_GRAPHICS`) cover driver
  workarounds without forcing every Linux user onto software rendering.
- Settings > Performance has a **Reduced effects** toggle, and performance mode now disables
  backdrop blur in addition to shadows, the grid and animations.
- Section pastel colors now resolve against all four themes: light stays pastel, soft light is
  softened toward its surface, and soft dark/dark keep a visible hue while staying dark (48% section
  color in dark, 58% in soft dark). Neutral colors such as Mist use a stronger tint (72% dark,
  78% soft dark) and switch to dark ink so they still read as mist instead of blending into the
  dark surface. Section ink, title chips, borders and the color-picker swatches follow the theme.
- Copy and cut are one-shot: the next paste consumes the internal clipboard and clears it. A browser
  paste of an image or URL is handled only when the internal clipboard is empty, so a screenshot no
  longer competes with a copied card. Shortcut copy/cut/paste no longer also trigger the browser's
  native paste handler.
- Duplicate and paste place the copy to the right of the source group instead of on top of it.
- Row columns preview drag-and-drop horizontally with a vertical insertion line and a slot ghost;
  normal cards drop into row children and columns drop into kanban rows.
- Legacy `kanban` cards are migrated on open into a row column with one child column per former lane
  and one note per former item.

### Removed

- The Kanban toolbar tool, card type, renderer, gesture handling, template card and MCP
  `create_card` type are removed.

### Fixed

- Linux WebKitGTK now zooms the board with a transform so card boxes and text scale together at
  low zoom levels; Chromium/Windows keeps CSS zoom for sharp text reflow.
- Board/card text is no longer selectable in normal mode, preventing WebKitGTK from selecting every
  card while dragging near a border. A `selectionchange` guard clears any stray board selection;
  the active `.is-editing` field opts back into native text selection, and inputs/textarea remain
  selectable.
- Linux desktop page scaling no longer diverges from Windows. Tauri's Linux page-zoom hotkey
  polyfill is disabled and the WebView zoom is reset to 100% at launch, leaving board zoom in the
  app layer.
- Row drop feedback no longer uses the vertical-stack line and offset ghost.
- Cloned columns re-layout their children after duplicate or paste.
- The reset confirmation modal now sits above the Settings dialog instead of behind it.
- The column context menu shows **Wrap into kanban** with a disabled state unless exactly two or
  more plain top-level columns are selected. Rows, nested columns and selections containing any
  non-column keep the action disabled.
- Cards inside a column now stay inside that column's 1000-wide z band. A child stays above its own
  column but can no longer cover a sibling column with a higher z, and nested kanban items remain
  visible above their child columns.
- Dropping a card inside a kanban now targets the deepest child column under the pointer instead of
  its parent row, so the drop preview and insertion work in every lane.
- A dragged card, including a card dragged out of a column, now sits above every board card and
  kanban lane for the whole gesture instead of disappearing behind the kanban.
- The drop insertion line and ghost sit above the dragged card, so the preview is visible even over
  a kanban or a large column.
- Dragging a column inside a kanban now targets the row container, so the vertical insertion line
  and lane ghost appear and the column can be reordered between lanes.
- Dropping a card tool onto a kanban targets the nearest lane instead of adding the card as a direct
  child of the row. A row can therefore never become a fake column from a toolbar drop.
- Clicking a Section no longer leaves it raised above the board. Sections keep their background
  z-index on click, selection and drag.
- Clicking a kanban or a row now also refreshes the z-index of every descendant column/card, so the
  lane contents stay visible immediately instead of waiting for a pointer move to repaint them.
- Wrap into kanban checks only the current column state: a column that was a row or kanban in the
  past is eligible again after it is converted back to a normal column; only a current row is
  rejected.

## [0.34.0] - 2026-11-08

### Added

- Section surface cards: a pastel background with a small editable title, always below regular cards,
  freely resizable from all four edges and corners, excluded from columns and layer controls. Selecting
  a Section opens a bottom toolbar with pastel swatches and a position-only lock that stops movement
  while title and color edits stay available.
- View > Snap to grid aligns dragged cards and Section resize edges to the board grid.
- Section height no longer grows after a page reload; it is excluded from automatic content-height measurement.
- Clicking a Section no longer raises it above regular cards, and its title pill now sizes to the title text.
- Columns can convert to rows and back. Row mode lays the children out horizontally and shares the
  column width between them; Convert to column restores the vertical stack.
- Color cards can pick a color directly from the screen with the eyedropper button beside the hex
  field. The EyeDropper API is tried first in both the browser and the desktop webview; if the host
  rejects it, the desktop falls back to an in-app magnifier over a client-area capture.
- The project is licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`).
  Commercial use and distribution are allowed, but modified versions and network services must keep
  their complete source available under the AGPL with attribution. The Khaoyu Note name, logo and app
  icon are protected separately by the trademark policy.
- Local-first deploy mode: login, signup, reset-password, account page and Settings > Account are
  disabled. Boards and settings open without an account, the account avatar and Account settings page
  are hidden, desktop guest writes are accepted, and the web host no longer requires a session for the
  command bridge, assets or downloads. The Share and Sync controls are hidden, Settings > Server shows
  local runtime only, and the in-app documentation marks accounts, sharing and sync as disabled. Comment
  cards use the local "You" identity with no profile picture.
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
