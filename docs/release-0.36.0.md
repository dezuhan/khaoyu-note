# Khaoyu Note 0.36.0

A focused release for backup hygiene and service hardening on top of the 0.35.0 local-first build.

## Highlights

- **Automatic backup retention**: automatic backups use their own folder prefix and the desktop keeps
  the newest seven copies. Older automatic folders are pruned after a successful backup; manual
  backups and imported backups are never removed automatically. The Backup pane explains the rule in
  all ten UI languages.
- **Security hardening**: cookie-session logout now requires the CSRF header, and invitation creation
  is rate limited to 20 requests per 15-minute window per owner and IP.
- **Global light/dark theme**: the theme is now an app-wide preference. Boards no longer store or
  apply their own theme, so switching boards or reloading keeps the chosen mode.
- **Collaboration client**: sync now writes `doc.replace` operations with sequence tracking and
  refreshes clean boards from the ticket-authenticated SSE stream; the setup wizard enables the
  Collaboration path and opens Server sync.
- **Sharing hardening**: optional share-view watermark and per-link download caps, server-side rich
  HTML sanitisation, exact remote-embed host allowlists, optional AES-256-GCM object encryption and
  a data-only PostgreSQL deployment script.
- **Passkey backup codes**: creating a passkey issues ten one-time recovery codes, and the login page
  accepts a backup code with the account email when the passkey device is unavailable.
- **Activity card**: the audit table scrolls inside its rounded, outlined section with a sticky header,
  keeping the card frame and Load more button visible.
- **Passkey kill switch**: `KHAOYU_SERVICE_PASSKEYS_ENABLED=false` hides passkey UI and disables the
  passkey endpoints while leaving password, TOTP and backup-code login available.
- **Per-device viewport**: board pan/zoom is stored locally per device, avoiding false save
  conflicts when the same board is open through a phone/tunnel and the desktop at once.
- **Share board preview**: `/s/:token` now shows a scaled spatial read-only board instead of a raw
  card-type list.
- **Live collaboration hardening**: hard per-card edit locks, remote cursor/selection presence and a
  synthetic six-client concurrent operation load check.
- **Member account dashboard**: members enter `/admin` with only Account Management visible; admin
  navigation is hidden and admin APIs remain protected. Profile editing uses the new self endpoint.
- **Role-aware login**: admins land on the dashboard and members land on account security, with no
  redirect loop between `/login` and `/admin`.
- **Settings layering and passkey visibility**: the dialog now covers/blurs the floating tool rail,
  and the passkey action is hidden while the service operator switch is off.
- **Fixed service chrome**: the admin sidebar remains visible while page content scrolls internally;
  account security pages keep the document fixed to the viewport too.
- **Account Management dashboard**: Profile, Security (password, 2FA, passkeys and API tokens) and
  Login sessions now live as individual pages in the admin dashboard sidebar.
- **Admin boards and account detail**: the former Teams page is correctly named Boards, account rows
  open a detail panel, and admin writes work when the dashboard is opened on the frontend port behind
  a configured public URL.
- **Settings layout**: the Settings dialog stays inside the window below the toolbar and always opens
  its page content at the top.
- **Account security**: authenticator-app 2FA setup with a local QR code, enable/disable controls,
  TOTP status, and a passkey readiness/how-to section on `/account`.
- **Public share links**: the Share dialog follows a configurable public origin, either from
  `KHAOYU_SERVICE_SHARE_PUBLIC_URL` or the app's Public share links setting, so links can use a
  public IP, domain or tunnel instead of localhost.
- **Resizable auto-layout**: rows start auto-width from their cards; resizing a row switches its
  cards to fill the row (the old stretch behavior), and "Fit container to items" returns to auto.
- **Live drop preview**: hovering a column or row with a card or rail tool reserves the exact slot,
  grows the container and shifts the following cards before the drop; leaving restores the layout.
- **Auto-sized columns and rows**: rows follow their card widths instead of stretching cards; after a
  drop the column height or row width reflows with a short transition.
- **Pointer-accurate tool drops**: dropping a rail tool into a column or row inserts it at the hovered
  slot (not always at the end), and the preview line follows that slot.
- **Shared component geometry**: spacing, type sizes and radii moved into the `--ky-space-*`,
  `--ky-text-*` and `--ky-radius-*` scale, with `.ky-card`, `.ky-section` and `.ky-table` shared by
  the service pages. `npm run test:theme-css` keeps literal px values out of service spacing.
- **Shared theme source**: `shared/theme/` now owns the token stylesheet, fonts, icons, brand mark
  and theme runtime. `npm run theme:sync` generates the app/service copies and CI runs
  `npm run theme:check`; palette tokens use the `--ky-palette-*` namespace.
- **Manual member accounts**: admins can create an account from Accounts with email, display name,
  temporary password and member/admin role.
- **Team administration**: admins can rename and delete teams, add accounts to a team by email,
  change their roles and remove them. Deleting a team cascades to child boards and revokes sharing.
- **Service dashboard refresh**: unauthenticated visits redirect straight to `/login`, and the login,
  registration and reset pages reuse the main app logo, fonts and theme icons. The admin page keeps
  the left rail and adds a top menu bar in the app's chrome style with the same logo, SVG icon set and fonts, Dashboard/Help menus, command search
  (Ctrl+K), host badge, light/dark toggle and a circular account button that opens the Account menu
  (Admin dashboard, Account settings, Help, Logout). Sharing is a section of the same dashboard
  (`/shares` redirects to `/admin#sharing`), the Teams pane fills the page, and the password fields
  keep the compact control height.
- **Documentation and verification**: the README, roadmap checkboxes and release docs now match the
  verified 0.36.0 state. The service suite runs against PostgreSQL and Redis, Rust tests and Clippy
  pass, the service image builds and its CRITICAL Trivy scan is clean.

## Setup and collaboration status

Unchanged from 0.35.0:

- The first-run wizard offers **Local SQLite/offline only**.
- **Collaboration** stays disabled until the admin dashboard and role model are available to the
  desktop UI.
- **Turso** stays disabled until the libSQL adapter, token storage and asset migration exist.
- The web host can export a database ZIP; import remains desktop-only.

## Packages

Release builds can produce:

- Windows: NSIS `.exe`, `.msi`, portable `.exe`
- Linux: `.deb`, `.rpm`, `.AppImage`, `.flatpak`, portable `.tar.gz`
- macOS: universal `.app` and `.dmg`

## Known limitations

- Collaboration and Turso remain intentionally disabled in this release.
- Production collaboration still needs OIDC, penetration/load testing, two-instance PostgreSQL/Redis
  validation, object storage and signing/notarisation.
- Desktop installers are unsigned in this build; Windows code signing and macOS notarisation remain
  release gates.
- Automatic updates are not implemented; the update check only opens the release page.

**Full changelog:** [CHANGELOG.md](../CHANGELOG.md)
