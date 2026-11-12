# Khaoyu Note service

This is the self-hosted service foundation plus the core account and login model: one standalone
HTTP process, a relational SQLite database for accounts, sessions, projects, memberships, snapshots
and audit rows, opaque object storage, a maintenance worker, explicit reversible migrations, and
backup/restore. Sharing, accounts, desktop sync and encrypted backups are documented below. Browser
pages are included for account login, passkeys, share links and the admin dashboard.

## Requirements

- Node 24 or newer with the built-in `node:sqlite` module, or
- Docker with Compose for the container deployment.

## Native quick start

```powershell
cd service
Copy-Item .env.example .env
# Edit .env and replace KHAOYU_SERVICE_SECRET with: openssl rand -hex 32
$env:KHAOYU_SERVICE_SECRET = "paste-the-generated-secret"
$env:KHAOYU_SERVICE_COOKIE_SECURE = "false"
$env:KHAOYU_BOOTSTRAP_PASSWORD = "use-a-unique-password-of-12-plus"
node src/cli.mjs migrate
node src/cli.mjs bootstrap
node src/server.mjs
```

The server prints a frontend URL and a backend URL, then keeps both listeners running. The admin
dashboard is at `<frontend URL>/admin`. To keep it running after the terminal closes:

```powershell
npm run start:background
npm run stop
```

`start:background` detaches the process, writes logs under `<data>/logs`, and prints both URLs. The
same ports are written to `<data>/runtime.json`.

`bootstrap` creates a verified owner account and project. Registration through
`POST /api/v1/auth/register` creates an immediately usable verified account; email verification is
disabled and its form is hidden. Password reset and invitation mail use SMTP when
`KHAOYU_SERVICE_SMTP_*` is configured and fall back to `<data>/outbox/*.json` (mode `0600`) otherwise.

## Ports

The service always opens two listeners on different free ports in the 5-digit range 20000 to 59999:

- **Frontend** serves `/login`, `/register`, `/reset`, `/account` (redirects to `/admin`),
  `/passkeys`, `/s/:token`, `/admin` and the static assets. `/shares` redirects to
  `/admin#sharing`, because sharing is rendered inside the admin dashboard.
- **Backend** serves `/api/v1/*`, `/healthz` and `/readyz`; it refuses page requests.

The browser only uses the frontend origin. The frontend proxies `/api`, `/healthz` and `/readyz` to
the backend, so cookies, CSRF and the public URL all stay on one origin. Both ports are random unless
`KHAOYU_SERVICE_FRONTEND_PORT` and `KHAOYU_SERVICE_BACKEND_PORT` are set. The chosen ports are printed
at startup and written to `<data>/runtime.json`. If no public URL is configured, `config.publicUrl`
becomes the frontend URL.

## Admin dashboard

Open `<frontend URL>/admin`, for example `http://127.0.0.1:29194/admin`. The page uses the normal
service session and requires an account
with the global `admin` role. The first account created by `bootstrap`, or the first account registered
on a fresh database, becomes an admin; migration 13 also promotes the oldest existing account.

The dashboard keeps the left rail (Overview, Accounts, Teams, Activity, Sharing) and adds a top menu
bar above the content pane: Dashboard, an Account menu (Admin dashboard, Account settings, Help,
Logout), a command search with Ctrl+K, the host badge and the light/dark toggle.

- Overview shows account, team, share-link and audit counts plus recent activity and signups.
- Account settings (opened from the Account menu or profile button) holds the signed-in password
  form, session revocation, scoped API tokens and sign out.
- Accounts lists profile pictures or initials, name, email, global role, active or disabled status,
  team count, last activity and last update. Admins can change another account's role or status; an
  account cannot demote or disable itself, and the last active admin cannot be removed.
- Teams lists projects with their owner, member count, revision and last update. Create team adds a
  project with a fresh snapshot and the signed-in admin as owner. Members expands the member list.
- Activity reads every audit row with actor, action, resource and time, filterable by text and action
  prefix, with Load more pagination.
- Sharing lists accessible projects, enables or disables public sharing with an acknowledgement and
  creates project/item/column links with permission, expiry, passphrase and download controls.

Disabled accounts cannot sign in with a password, email OTP or SSO, cannot rotate a refresh token and
cannot use scoped API tokens. Admin mutations use the normal CSRF cookie and `x-csrf-token` header and
write `admin.*` audit rows. The optional `KHAOYU_SERVICE_ADMIN_TOKEN` still exists for scripted access
to `/api/v1/admin/audit`, `/api/v1/admin/abuse-reports` and `/api/v1/admin/stats`; it is not used by the
dashboard.

## Docker Compose

```powershell
cd service
Copy-Item .env.example .env
# Edit .env, especially KHAOYU_SERVICE_SECRET and KHAOYU_SERVICE_PUBLIC_URL
docker compose build
docker compose run --rm khaoyu-note-service node src/cli.mjs migrate
docker compose run --rm -e KHAOYU_BOOTSTRAP_PASSWORD='use-a-unique-password-of-12-plus' khaoyu-note-service node src/cli.mjs bootstrap
docker compose up -d
```

The Compose file fixes the frontend at `127.0.0.1:18080` and the backend at `127.0.0.1:18081`,
both 5-digit ports. Put Caddy, Nginx or another TLS proxy in front of the frontend only before
exposing it to a network. The container runs as the `node` user, with a read-only root
filesystem, no Linux capabilities and a writable named volume for `/data`.

Migrations are explicit. The server checks the schema version at startup and refuses to start while
a migration is pending.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `KHAOYU_SERVICE_PROFILE` | `single-user` | `single-user` or `team`. Team mode requires PostgreSQL and Redis. |
| `KHAOYU_SERVICE_HOST` | `127.0.0.1` | Bind address. Compose sets `0.0.0.0` inside the container. |
| `KHAOYU_SERVICE_DATABASE_URL` | empty | PostgreSQL connection string for team mode. |
| `KHAOYU_SERVICE_DATABASE_SSL` | `false` | Require TLS for the PostgreSQL connection. |
| `KHAOYU_SERVICE_DATABASE_POOL_MAX` | `10` | PostgreSQL connection pool size. |
| `KHAOYU_SERVICE_REDIS_URL` | empty | Redis connection string for team mode. |
| `KHAOYU_SERVICE_REDIS_PREFIX` | `khaoyu` | Namespace for Redis keys. |
| `KHAOYU_SERVICE_INSTANCE_ID` | hostname plus PID | Instance identity used by the worker leader lock. |
| `KHAOYU_SERVICE_REALTIME_TICKET_TTL_MS` | `60000` | Lifetime of a single-use SSE ticket. |
| `KHAOYU_SERVICE_EDIT_LOCK_TTL_MS` | `15000` | Advisory edit lock lifetime. |
| `KHAOYU_SERVICE_OP_RETENTION_DAYS` | `7` | Operation log retention before clients must resync. |
| `KHAOYU_SERVICE_COMPACT_OPS` | `100` | Operations between snapshot compactions. |
| `KHAOYU_SERVICE_COMPACT_MS` | `30000` | Maximum interval between snapshot compactions. |
| `KHAOYU_SERVICE_FRONTEND_PORT` | random 5-digit | Frontend listener port (pages and API proxy). |
| `KHAOYU_SERVICE_BACKEND_PORT` | random 5-digit | Backend listener port (API and health only). |
| `KHAOYU_SERVICE_DATA_DIR` | `.khaoyu-service-data` | Database, objects, temp files, outbox, backups, logs and `runtime.json`. |
| `KHAOYU_SERVICE_SECRET` | required | At least 32 characters and not a placeholder. |
| `KHAOYU_SERVICE_PUBLIC_URL` | frontend URL | Public HTTPS origin behind a proxy. |
| `KHAOYU_SERVICE_COOKIE_SECURE` | based on public URL | Force Secure cookies. Use `false` only on local HTTP. |
| `KHAOYU_SERVICE_TRUST_PROXY` | `false` | Read the client IP from the first `X-Forwarded-For` value. |
| `KHAOYU_SERVICE_PUBLIC_SHARING` | `true` | Operator kill switch for all public share links. |
| `KHAOYU_SERVICE_CORS_ORIGINS` | Tauri origins plus `http://127.0.0.1:1430` and `http://localhost:1430` | Comma-separated origins allowed to call bearer-token APIs from the desktop client and the local web host. |
| `KHAOYU_SERVICE_ADMIN_TOKEN` | empty | Optional operator token for admin audit, abuse and stats endpoints. |
| `KHAOYU_SERVICE_BACKUP_PASSPHRASE` | empty | Encrypt backups with scrypt-derived AES-256-GCM. Required to restore them. |
| `KHAOYU_SERVICE_ALERT_WEBHOOK` | empty | Optional HTTP(S) endpoint for login-block security alerts. |
| `KHAOYU_SERVICE_SSO_ENABLED` | `false` | Enable trusted-proxy header SSO. |
| `KHAOYU_SERVICE_SSO_SECRET` | empty | HMAC key the reverse proxy uses to sign the SSO email. |
| `KHAOYU_SERVICE_SSO_HEADER` | `x-auth-request-email` | Header containing the authenticated email. |
| `KHAOYU_SERVICE_SSO_NAME_HEADER` | `x-auth-request-name` | Optional display-name header. |
| `KHAOYU_SERVICE_SSO_AUTO_CREATE` | `false` | Create a verified account for an unknown SSO email. |
| `KHAOYU_SERVICE_REQUIRE_HTTPS` | `false` | Reject plain HTTP unless a trusted proxy reports `x-forwarded-proto: https`. Requires an HTTPS public URL. |
| `KHAOYU_SERVICE_UPLOAD_SCAN_COMMAND` | empty | Optional scanner executable receiving the temporary upload path; non-zero exit rejects the asset. |
| `KHAOYU_SERVICE_PASSKEYS_ENABLED` | `true` | Enable WebAuthn passkey registration and login. |
| `KHAOYU_SERVICE_RP_ID` | public hostname | WebAuthn relying-party id; must match the browser origin host. |
| `KHAOYU_SERVICE_SMTP_HOST` | empty | SMTP host; when empty, messages are written to the outbox. |
| `KHAOYU_SERVICE_SMTP_PORT` | `587` | SMTP port. |
| `KHAOYU_SERVICE_SMTP_SECURE` | `false` | Use implicit TLS for SMTP. |
| `KHAOYU_SERVICE_SMTP_USER` | empty | SMTP username, paired with the password. |
| `KHAOYU_SERVICE_SMTP_PASSWORD` | empty | SMTP password. |
| `KHAOYU_SERVICE_SMTP_FROM` | empty | Required sender address when SMTP is enabled. |
| `KHAOYU_SERVICE_ACCESS_TTL_MINUTES` | `15` | Access token lifetime. |
| `KHAOYU_SERVICE_REFRESH_TTL_DAYS` | `7` | Refresh token and session lifetime. |
| `KHAOYU_SERVICE_DELETION_GRACE_DAYS` | `30` | Days before a requested account deletion is purged. |
| `KHAOYU_SERVICE_LOGIN_WINDOW_MINUTES` | `15` | Failed-login rate limit window. |
| `KHAOYU_SERVICE_LOGIN_MAX_ATTEMPTS` | `5` | Failures before a temporary 429. |
| `KHAOYU_SERVICE_BACKUP_INTERVAL_HOURS` | `24` | Automatic backup interval. |
| `KHAOYU_SERVICE_BACKUP_RETENTION` | `7` | Number of backups kept. |
| `KHAOYU_SERVICE_AUDIT_RETENTION_DAYS` | `90` | Audit retention before pruning. |
| `KHAOYU_SERVICE_TEMP_MAX_AGE_HOURS` | `24` | Temp upload cleanup age. |

Startup fails closed when the secret is missing, shorter than 32 characters, too repetitive or still
looks like a placeholder.

## Team backend

The multi-user team profile uses PostgreSQL as the system of record and Redis for cross-instance SSE
fanout. PostgreSQL storage, backup/restore, CLI commands and the Redis bus are in place. Presence is
currently per-instance; global presence, SSE tickets, edit locks and the operation log are still
being implemented. The remaining phases are recorded in
[docs/backend-postgres-redis.md](../docs/backend-postgres-redis.md).

- `single-user` keeps SQLite and needs no PostgreSQL or Redis.
- `team` requires `KHAOYU_SERVICE_DATABASE_URL` and `KHAOYU_SERVICE_REDIS_URL`; `openStorage` fails
  closed if either is missing.
- Docker Compose exposes opt-in `postgres` and `redis` services:
  `docker compose --profile team up -d postgres redis`.
- PostgreSQL baseline and data migration commands:

```powershell
node src/cli.mjs migrate-postgres --database-url postgres://khaoyu:password@127.0.0.1:5432/khaoyu
node src/cli.mjs status-postgres --database-url postgres://khaoyu:password@127.0.0.1:5432/khaoyu
node src/cli.mjs rollback-postgres --steps 1 --database-url postgres://khaoyu:password@127.0.0.1:5432/khaoyu
node src/cli.mjs migrate-to-postgres --sqlite /data/khaoyu-service.db --database-url postgres://khaoyu:password@127.0.0.1:5432/khaoyu --dry-run
node src/cli.mjs bootstrap-postgres --database-url postgres://khaoyu:password@127.0.0.1:5432/khaoyu
node src/cli.mjs backup-postgres --database-url postgres://khaoyu:password@127.0.0.1:5432/khaoyu
node src/cli.mjs restore-postgres <backup-directory> --force --database-url postgres://khaoyu:password@127.0.0.1:5432/khaoyu
node src/cli.mjs invalidate-sessions-postgres --database-url postgres://khaoyu:password@127.0.0.1:5432/khaoyu
```

- `migrate-to-postgres` copies durable rows only; sessions and short-lived tokens are skipped so the
  cutover forces a fresh sign-in. The target must be a fresh migrated database, and the object store
  directory is copied separately.
- `backup-postgres` writes a logical JSON snapshot plus the object files; `restore-postgres` fills a
  migrated empty database and restores the object files. Passwords and backup encryption are handled
  the same way as the SQLite backup. `restore-postgres` requires `--force` when the target already has
  rows.
- The default CLI commands follow `KHAOYU_SERVICE_DATABASE_URL`: `migrate`, `status`, `rollback`,
  `backup`, `restore`, `bootstrap` and `invalidate-sessions` work for both dialects. The
  `*-postgres` variants accept an explicit `--database-url` without changing the environment.

`/admin#sharing` is the browser sharing section inside the admin dashboard: it lists accessible
projects, requires an acknowledgement before enabling public sharing, creates project/item/column
links, shows a new token once and revokes links. The public-sharing API enforces the same acknowledgement with
`{"enabled":true,"acknowledge":true}`; omitting it returns 400 `acknowledgement_required`. Disabling
public sharing revokes every link for that project.

`/s/:token` is the public read-only viewer for a share link. It asks for the passphrase when one is
required, renders only the shared scope, shows nested projects allowed by policy, and returns a
neutral message for invalid, expired, revoked or wrong-passphrase links. The page is `noindex`, has a
self-only CSP, and tokens are redacted from request logs.

All service pages load `/ky.css`, the framework design system used by the desktop app, followed by
`/ui.css` for auth-panel layout. They use the real `.ky-scope`, `.ky-panel`, `.ky-title`,
`.ky-label`, `.ky-input` and `.ky-button` components, so controls and typography match the app. The
CSP allows `style-src 'self' 'unsafe-inline'` for the stylesheets. See `docs/design-system.md`.

## Operator admin

Set `KHAOYU_SERVICE_ADMIN_TOKEN` to enable `/api/v1/admin/*`. These endpoints require
`Authorization: Bearer <token>`, are limited to 60 requests per minute per IP and return 404 when no
admin token is configured. Audit export records its own `admin.audit_exported` event; abuse review
returns the reported share, project, scope, reason and hashed reporter IP. Keep the token in the
operator secret store and rotate it with the incident runbook.

## Health

- `GET /healthz` returns `{"status":"ok"}`.
- `GET /readyz` checks the database and returns `{"status":"ready"}` or `{"status":"not_ready"}`.

Neither endpoint returns a version, database path, configuration or error details.

## Authentication API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/auth/register` | Create an immediately usable account (no email verification). |
| `POST` | `/api/v1/auth/verify-email` | Disabled; returns 410 `verification_disabled`. |
| `POST` | `/api/v1/auth/login` | Password login, optional TOTP, sets session cookies. |
| `POST` | `/api/v1/auth/sync-token` | Exchange email and password for a scoped project token for desktop sync; each sign-in revokes the previous app-sync token. |
| `POST` | `/api/v1/auth/otp/request` | Queue a one-time login code by email. |
| `POST` | `/api/v1/auth/otp/login` | Login with a one-time code; TOTP still applies. |
| `POST` | `/api/v1/auth/passkeys/register/options` | Start passkey registration for the signed-in account. |
| `POST` | `/api/v1/auth/passkeys/register/verify` | Verify and store a passkey credential. |
| `POST` | `/api/v1/auth/passkeys/login/options` | Start passkey login for an email. |
| `POST` | `/api/v1/auth/passkeys/login/verify` | Verify a passkey assertion and create a session. |
| `GET` | `/api/v1/auth/passkeys` | List the signed-in account's passkeys. |
| `DELETE` | `/api/v1/auth/passkeys/:id` | Remove a passkey, guarding the last credential. |
| `POST` | `/api/v1/auth/refresh` | Rotate the refresh token and issue a new access token. |
| `POST` | `/api/v1/auth/logout` | Revoke the current session and clear cookies. |
| `POST` | `/api/v1/auth/logout-all` | Revoke every session for the account. |
| `GET` | `/api/v1/auth/sessions` | List sessions with device, timestamps and current flag. |
| `DELETE` | `/api/v1/auth/sessions/:id` | Revoke one session. |
| `POST` | `/api/v1/auth/password-reset/request` | Legacy operator endpoint that queues a single-use reset token. The browser uses current-password reset instead. |
| `POST` | `/api/v1/auth/password-reset/confirm` | Legacy operator endpoint that consumes a reset token. |
| `POST` | `/api/v1/auth/reset-password` | Reset with email plus current password; no email token and every session is revoked. |
| `POST` | `/api/v1/auth/totp/setup` | Create a TOTP secret and `otpauth` URI. |
| `POST` | `/api/v1/auth/totp/enable` | Confirm a TOTP code and enable it. |
| `POST` | `/api/v1/auth/totp/disable` | Disable TOTP with password and code. |
| `GET` | `/api/v1/account/export` | Export the account, accessible projects and their snapshots. |
| `GET` | `/api/v1/account/tokens` | List scoped API tokens. |
| `POST` | `/api/v1/account/tokens` | Create a scoped API token; the raw token is returned once. |
| `DELETE` | `/api/v1/account/tokens/:id` | Revoke an API token. |
| `POST` | `/api/v1/account/delete` | Schedule deletion after the grace period. |
| `POST` | `/api/v1/account/delete/cancel` | Cancel a scheduled deletion. |
| `GET` | `/api/v1/projects` | List projects the account can access. |
| `POST` | `/api/v1/projects` | Create a project owned by the account. |
| `GET` | `/api/v1/projects/:id` | Read a project when the account is a member. |
| `PUT` | `/api/v1/projects/:id/snapshot` | Update a snapshot as owner or editor, with revision check. The document may be up to 8 MB. |
| `GET` | `/api/v1/account/presence` | Read presence opt-in state. |
| `PATCH` | `/api/v1/account/presence` | Opt in or out of project presence. |
| `GET` | `/api/v1/account/email-preferences` | Read the email notification preference. |
| `PATCH` | `/api/v1/account/email-preferences` | Opt in or out of notification email. |
| `GET` | `/api/v1/email/unsubscribe` | Confirmation page for the signed unsubscribe link. |
| `POST` | `/api/v1/email/unsubscribe` | Apply the unsubscribe; the signed link expires after 30 days. |
| `GET` | `/api/v1/projects/:id/members` | List project members. |
| `GET` | `/api/v1/projects/:id/assets` | List project asset metadata. |
| `POST` | `/api/v1/projects/:id/assets` | Upload an asset as raw bytes; editor role. |
| `GET` | `/api/v1/projects/:id/assets/:assetId` | Download an asset as a project member. |
| `GET` | `/api/v1/projects/:id/versions` | List recent project revisions. |
| `POST` | `/api/v1/projects/:id/versions/:revision/restore` | Restore a revision as editor or owner. |
| `GET` | `/api/v1/projects/:id/events` | SSE room for snapshot and presence events. |
| `GET` | `/api/v1/admin/audit` | Operator audit export, latest 500. |
| `GET` | `/api/v1/admin/abuse-reports` | Operator abuse report review. |
| `GET` | `/api/v1/admin/stats` | Operator counts for accounts, projects, shares, reports and audit. |
| `GET` | `/api/v1/notifications` | List scoped notifications and the unread count. |
| `PATCH` | `/api/v1/notifications/:id/read` | Mark one owned notification as read. |
| `POST` | `/api/v1/notifications/read-all` | Mark all owned notifications as read. |
| `PATCH` | `/api/v1/projects/:id/members/:accountId` | Change a member role; owner only. |
| `DELETE` | `/api/v1/projects/:id/members/:accountId` | Remove a member; owner only. |
| `POST` | `/api/v1/projects/:id/transfer` | Transfer ownership to an existing member; owner only. |
| `GET` | `/api/v1/projects/:id/invitations` | List invitations; editor or owner. |
| `POST` | `/api/v1/projects/:id/invitations` | Invite an email; owner only. |
| `DELETE` | `/api/v1/projects/:id/invitations/:id` | Revoke an invitation; owner only. |
| `POST` | `/api/v1/invitations/accept` | Accept an email-bound invitation. |
| `POST` | `/api/v1/projects/:id/public-sharing` | Enable or disable public sharing; owner only. |
| `GET` | `/api/v1/projects/:id/shares` | List share metadata; editor or owner. |
| `POST` | `/api/v1/projects/:id/shares` | Create a project, item or column share link. |
| `DELETE` | `/api/v1/projects/:id/shares/:shareId` | Revoke a share link. |
| `POST` | `/api/v1/projects/:id/shares/:shareId/rotate` | Rotate the share token. |
| `POST` | `/api/v1/share/:token/access` | Public scoped access, optional passphrase. |
| `POST` | `/api/v1/share/:token/comments` | Add a scoped comment with the comment permission. |
| `PATCH` | `/api/v1/share/:token/cards/:cardId` | Edit allowed card fields with the edit permission. |
| `POST` | `/api/v1/share/:token/assets/:assetId` | Download a shared asset when download is allowed. |
| `POST` | `/api/v1/share/:token/report` | Report an abusive or unwanted shared link. |

Passwords use Argon2id with 64 MiB memory, 3 iterations and a 16-byte per-user salt. Access tokens live
15 minutes. Refresh tokens live 7 days, rotate on every use and are stored as SHA-256 hashes. Reusing
an old refresh token revokes the whole session family. Login failures are generic and limited per
email and per IP with a progressive `Retry-After`; each block emits a structured warning event.
Optional email one-time codes are single use, valid for 10 minutes, limited to five attempts and
still require TOTP when it is enabled.

Cookies are `HttpOnly`, `SameSite=Lax` and `Secure` when the public URL is HTTPS. Write requests made
with cookie authentication must send the CSRF token in `X-CSRF-Token`; the same value is in the
non-HttpOnly `khaoyu_csrf` cookie. Bearer access tokens skip the CSRF check. Cookie-session logout
also requires that header, so a cross-site form cannot sign the user out. Registration, password-reset
request, OTP request, passkey login, share report and invitation creation have bounded per-IP or
per-owner rate limits with a 15-minute window.

Scoped API tokens use the `khn_` prefix and the `projects:read` or `projects:write` scopes. They are
stored as hashes, returned only once, and can be revoked from the account token endpoints. API
tokens cannot manage sessions, TOTP or account deletion; those require a user session.

Email verification is disabled. Password reset tokens are single use, short lived and stored as
hashes. SMTP delivery is implemented through `nodemailer`; without SMTP configuration, mail is
written to the mode `0600` outbox, failed sends are retried from `email_jobs`, and the outbox remains
sensitive operator data.

Desktop sync signs in with the account email and password. `POST /api/v1/auth/sync-token` returns a
scoped project token, revoking the previous `app-sync` token on each sign-in, and the client stores it
without showing it. The token grants `projects:read` and `projects:write`. The same token can
manage share links for projects the account can edit, so the desktop header Share panel and the
right-click Share link action do not need a browser session. When a synced local board has a parent
board that is already synced, the new server project is created with `parentProjectId`, so nested
shares can include it under the policy above. The service allows bearer-token CORS preflight only from
`KHAOYU_SERVICE_CORS_ORIGINS`; cookies and credentials are never allowed from those origins. The
default list already includes the local web host on its default port, so a browser build can sync
directly; add the origin when the web host runs on another port.

## Browser account pages

The service now has separate auth pages: `/login`, `/register` and `/reset` use a centred reference
layout built on `ky.css` and `auth.css`. `/login` handles password and optional TOTP sign-in plus a
passkey link. `/register` creates an account immediately; the first account becomes the admin.
`/reset` asks for email, current password and a new password, then revokes every session. It never sends
an email reset token because this service has no email confirmation flow.

`/account` redirects to `/admin`; the dashboard has an Account section for password changes, sessions,
API tokens and sign out. `/passkeys` handles passkey login and registration. All pages use the same
cookie and CSRF rules as the API and are served with a strict self-only CSP.

## Passkeys

`/passkeys` is a small browser page for password login, passkey registration, passkey login and
listing the account's credentials. WebAuthn requires a secure context: use HTTPS or localhost.
`KHAOYU_SERVICE_RP_ID` must match the browser origin host and defaults to the public URL hostname.

Challenges are random, single use, bound to the email and expire after five minutes; the worker
removes stale rows. Registration stores the credential id, COSE public key, counter, transports,
device type and backup state. Login verifies the assertion, updates the counter and creates the same
session cookies as password login. The last passkey cannot be removed when the account has no
password, so an account cannot be locked out accidentally. Passkey sessions and failures are audited.

## Trusted-proxy SSO

SSO is disabled by default. When enabled, `POST /api/v1/auth/sso/login` trusts the configured email
header only if the reverse proxy also sends
`x-khaoyu-sso-signature: HMAC-SHA256(secret, lowercase-email)`. The proxy must strip any client
supplied copies of both headers, and the service must not be reachable around the proxy. SSO requires
`KHAOYU_SERVICE_TRUST_PROXY=true` and a 32 character `KHAOYU_SERVICE_SSO_SECRET`; missing or weak
values fail startup.

An existing account is matched by email. With auto-create disabled an unknown email is rejected;
with auto-create enabled a verified account is created without a local password. SSO sessions are
audited as `auth.login_sso` and TOTP is not required because the external IdP is the second factor.
This is forward-auth integration, not OIDC discovery.

## Sharing and membership

Public sharing is disabled per project until the owner enables it. Share links are bearer tokens
with high entropy, stored only as hashes, returned once at creation, and revocable or rotatable.
Expired, revoked, rotated and wrong-passphrase links all return a neutral 404. Passphrase attempts
are rate limited per link and IP. Share responses carry `X-Robots-Tag: noindex, nofollow`.

Scopes:

- `project`: current project snapshot.
- `item`: one card only, without sibling cards or the project title.
- `column`: a column and its current children, with a notice about later additions.

Shared payloads omit the trash, strip local filesystem asset paths, and never include tokens or
member data. Project roles are owner, editor, commenter and viewer. Invitations are email-bound,
single use, expiring and revocable; accepting one adds the account as a member. Ownership transfer
keeps an owner role on both sides during the swap, and the owner cannot be removed directly.

Stored share permissions are enforced by rank: view, comment, edit, manage. A comment share can add
comments only to cards inside its project, item or column scope; comments are stored on the scoped
card as `shareComments` and never create sibling cards. An edit share can update `text`, `title`,
`caption`, `description`, `url` and `checked` only, with an optional revision check. Writes require
the passphrase when set, are rate limited, create a new project revision, emit an SSE snapshot and
notify project owners. Manage currently has the same write surface as edit.

`KHAOYU_SERVICE_PUBLIC_SHARING=false` is the operator kill switch: share creation returns 409 and all
public access returns 404. Anyone holding a link can file an abuse report at
`/api/v1/share/:token/report`; reports are stored with a hashed reporter IP and remain available to
the operator in the database.

## Notifications

In-app notifications are stored per account for invitation acceptance, role changes, revision
restores, share reports, share comments and `@email` mentions in share comments. Listing filters every
notification through current resource access, so a removed member stops seeing project notifications
immediately even though the rows remain. Read state is per account; only the owner can mark a
notification read. Revoking a share link, or disabling project sharing, deletes its pending
notifications. Read notifications older than 90 days are pruned.

Notification email is opt-in per account. When SMTP is configured, messages are delivered through
`nodemailer`; otherwise they remain in the mode `0600` outbox. Each message has a signed one-click
unsubscribe link, and at most one notification email is sent per account per five minutes. Invitation
and reset mail remain transactional and are not governed by the notification preference.

Project shares include eligible nested boards as `nestedProjects`. A nested project is included only
when it has the same owner and no members beyond that owner, recursively up to five levels and at most
20 nested projects. Children with additional members are omitted and counted in
`excludedNestedProjects`; the payload states this policy. A project share still omits the trash and
local asset paths. Item and column shares never include nested boards.

## Revision history and events

Every accepted snapshot update stores a `project_versions` row. Members can list the latest 100
revisions, and editors or owners can restore one by creating a new revision, so history is never
rewritten. The worker prunes versions beyond the latest 100 per project.

`GET /api/v1/projects/:id/events` is an authenticated server-sent events room. It checks project
membership before opening the stream, emits a `presence` event with connection and distinct account
counts, and emits `snapshot` events with the new revision and restoring revision when applicable. A
25 second heartbeat keeps proxies from closing idle streams. Only project rooms receive events, so a
member of one project does not see activity in another. Presence is opt-in per account: an opted-out
connection still receives snapshot events but is excluded from both presence counts.

## Project assets

Assets are uploaded as raw bytes with `x-file-name` and a content type, limited to 100 MB. The bytes
are content-addressed and deduplicated in the object store; the project asset row keeps an opaque id,
display name, content type and size. Executable and script extensions are rejected. Image uploads are
sniffed against PNG, JPEG, GIF and WebP signatures, mismatches are rejected and SVG is not accepted as
an asset. If `KHAOYU_SERVICE_UPLOAD_SCAN_COMMAND` is set, the temporary file is passed to that scanner
with a ten second timeout and a non-zero exit rejects the upload. List and download require project
membership, while upload requires the editor role and the `projects:write` scope.

A share can download an asset only when `downloadAllowed` is true, the link is valid and its
passphrase matches. Project shares can download any project asset; item and column shares only when a
card inside the share scope references the asset in a known field (`src`, `path`, `url`, `poster` or
an explicit asset or object id). Downloads are audited per share link. Image uploads are validated
against their magic bytes and uploads pass an optional scanner hook; watermarking and signed
short-lived asset URLs are still pending.

## Migrations

```powershell
node src/cli.mjs status
node src/cli.mjs migrate
node src/cli.mjs rollback --steps 1
```

Migration files live in `src/migrations` as paired `*.up.sql` and `*.down.sql`. Every migration is
applied in a transaction and recorded in `schema_migrations`.

Set `KHAOYU_SERVICE_BACKUP_PASSPHRASE` to encrypt new backups. The database and every object file are
encrypted with AES-256-GCM using a scrypt-derived key; the manifest keeps plaintext checksums and the
salt, never the passphrase. Restore requires the same passphrase and rejects a wrong key before
touching current data. Without a passphrase backups remain in the local backup directory and the
operator must protect that directory.

`KHAOYU_SERVICE_ALERT_WEBHOOK` receives a JSON POST on a login block with the event name, method,
attempt count, retry delay and hashed IP. It is best-effort with a three second timeout and never
blocks the login response.

If SMTP is configured and a send fails, the message is stored in `email_jobs` instead of failing the
request. The worker retries due jobs with exponential backoff (one to 30 minutes, up to 10 attempts)
and records the last error; the admin stats and logs expose the retry warnings. This keeps
verification and invitation mail recoverable through a short SMTP outage. Thumbnail generation is
still pending.

## Backup and restore

```powershell
node src/cli.mjs backup
node src/cli.mjs restore <backup-directory> --force
```

Backups contain a consistent `VACUUM INTO` database snapshot, the object store and a manifest with
the database checksum. Restore verifies the checksum and `PRAGMA integrity_check` before replacing
data, creates a `restore-previous-*` copy first, and rolls back to it if the copy fails. Stop the
service before restoring.

To keep an offsite copy of a Docker backup:

```powershell
docker compose cp khaoyu-note-service:/data/backups/<directory> ./backups/
```

## Upgrade

1. Stop the service.
2. Create a backup.
3. Pull or unpack the new version.
4. Run `migrate`.
5. Run `invalidate-sessions` when the release changes authentication or session behavior.
6. Start the service and check `/readyz`.

Database migrations preserve existing account, project, membership and audit rows. Run
`node src/cli.mjs invalidate-sessions` when an upgrade changes authentication or session behavior;
it revokes every session and token without touching project data.

## Reverse proxy

Terminate TLS at the proxy and set `KHAOYU_SERVICE_REQUIRE_HTTPS=true` and
`KHAOYU_SERVICE_TRUST_PROXY=true`. The service then rejects plain HTTP with 426 unless the proxy
reports `x-forwarded-proto: https`; the public URL must be HTTPS at startup. Caddy:

```caddyfile
notes.example.com {
  reverse_proxy 127.0.0.1:18080
}
```

Nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name notes.example.com;
  client_max_body_size 100m;

  location / {
    proxy_pass http://127.0.0.1:18080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

Set `KHAOYU_SERVICE_PUBLIC_URL` to the public HTTPS origin after the proxy is active.

## Tests

```powershell
node --test --test-concurrency=1 test/service.test.mjs test/auth.test.mjs test/admin.test.mjs test/storage.test.mjs test/storage-migrations.test.mjs test/postgres-runtime.test.mjs test/redis-bus.test.mjs test/config.test.mjs

# against a running instance with a verified account; use the frontend port from startup
node ../tools/check-service-security.mjs --base http://127.0.0.1:18080 --credentials ../target/service-dev-credentials.json
```

The service suite covers fail-closed configuration, reversible migrations, opaque object storage
with deduplication, audit IP hashing, backup/restore round-trip, encrypted backup restore, worker
cleanup and the health endpoints. The auth suite covers verification, generic login errors and throttling, CSRF, project
authorization, refresh rotation and reuse, session revocation, password reset, TOTP, account
deletion grace and purge, scoped API tokens, email one-time codes, project/item/column share
isolation, passphrase and expiry enforcement, abuse reports, invitation acceptance, ownership
transfer, asset authorization, share download permission, share comments and edits, revision restore,
authenticated SSE rooms, scoped notifications, SMTP delivery, email preferences, CORS preflight,
encrypted backups, alert webhooks, trusted-proxy SSO, presence opt-in, comment mentions, HTTPS
enforcement, upload signature scanning, WebAuthn passkeys and browser account pages.

## Milestone boundaries

Implemented from Milestone 1: standalone process, one HTTP port, relational schema, opaque object
storage, worker, minimal health endpoint, environment configuration, fail-closed startup, reversible
migrations, backup/restore and upgrade documentation.

Implemented from Milestone 2: email and password registration with verification, case-normalized
email, display name, Argon2id, short-lived access tokens, rotating refresh tokens with reuse
detection, session list and revocation, logout everywhere, login throttling with alert webhook,
generic login errors, hashed single-use reset tokens, TOTP, email one-time codes, account export,
deletion grace and purge, cookie and CSRF hardening, project role checks, scoped API tokens,
trusted-proxy SSO and WebAuthn passkeys.

Implemented from Milestone 3: project, item and column share scopes; hashed revocable and rotating
links; expiry; optional passphrase with rate limiting; neutral 404 responses; noindex headers; audit
per access; project roles; email-bound invitations; member removal; ownership transfer safeguards;
public sharing off by default; scoped payload isolation; a global operator kill switch; abuse
reports; and authenticated project asset upload/download with share download enforcement.

Implemented from Milestone 4: authenticated per-project SSE rooms, opt-in presence counts, revision
history, editor-only restore, audit, scoped comments and the desktop offline sync queue with visible
conflict choices. Cursor and lock awareness remain pending.

Implemented from Milestone 5: scoped in-app notifications for invitations, role changes, revision
restores, share reports, comments and mentions; per-account read state; cleanup when a share is
revoked; SMTP delivery with outbox fallback; opt-in notification email with signed unsubscribe links
and a five minute rate limit.

Still pending: a manage-specific share surface, watermarking, signed short-lived asset URLs and a
team membership management UI. Nested-board policy for project shares and the browser account pages
are implemented.
