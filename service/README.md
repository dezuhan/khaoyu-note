# Khaoyu Note service

This is the self-hosted service foundation plus the core account and login model: one standalone
HTTP process, a relational SQLite database for accounts, sessions, projects, memberships, snapshots
and audit rows, opaque object storage, a maintenance worker, explicit reversible migrations, and
backup/restore. Sharing, desktop login UI and client sync are not implemented yet.

## Requirements

- Node 24 or newer with the built-in `node:sqlite` module, or
- Docker with Compose for the container deployment.

## Native quick start

```powershell
cd service
Copy-Item .env.example .env
# Edit .env and replace KHAOYU_SERVICE_SECRET with: openssl rand -hex 32
$env:KHAOYU_SERVICE_SECRET = "paste-the-generated-secret"
$env:KHAOYU_SERVICE_PUBLIC_URL = "http://127.0.0.1:8080"
$env:KHAOYU_SERVICE_COOKIE_SECURE = "false"
$env:KHAOYU_BOOTSTRAP_PASSWORD = "use-a-unique-password-of-12-plus"
node src/cli.mjs migrate
node src/cli.mjs bootstrap
node src/server.mjs
```

`bootstrap` creates a verified owner account and project. Registration through
`POST /api/v1/auth/register` is the normal path for additional accounts. Verification and reset
messages are written to `<data>/outbox/*.json` with mode `0600`; the SMTP adapter is not implemented.

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

The published port binds to `127.0.0.1:8080` only. Put Caddy, Nginx or another TLS proxy in front of
it before exposing it to a network. The container runs as the `node` user, with a read-only root
filesystem, no Linux capabilities and a writable named volume for `/data`.

Migrations are explicit. The server checks the schema version at startup and refuses to start while
a migration is pending.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `KHAOYU_SERVICE_PROFILE` | `single-user` | `single-user` or `team`. Team membership APIs are still limited. |
| `KHAOYU_SERVICE_HOST` | `127.0.0.1` | Bind address. Compose sets `0.0.0.0` inside the container. |
| `KHAOYU_SERVICE_PORT` | `8080` | Single HTTP port. |
| `KHAOYU_SERVICE_DATA_DIR` | `.khaoyu-service-data` | Database, objects, temp files, outbox and backups. |
| `KHAOYU_SERVICE_SECRET` | required | At least 32 characters and not a placeholder. |
| `KHAOYU_SERVICE_PUBLIC_URL` | `http://host:port` | Public HTTPS origin behind a proxy. |
| `KHAOYU_SERVICE_COOKIE_SECURE` | based on public URL | Force Secure cookies. Use `false` only on local HTTP. |
| `KHAOYU_SERVICE_TRUST_PROXY` | `false` | Read the client IP from the first `X-Forwarded-For` value. |
| `KHAOYU_SERVICE_PUBLIC_SHARING` | `true` | Operator kill switch for all public share links. |
| `KHAOYU_SERVICE_CORS_ORIGINS` | Tauri origins | Comma-separated origins allowed to call bearer-token APIs from the desktop client. |
| `KHAOYU_SERVICE_ADMIN_TOKEN` | empty | Optional operator token for admin audit, abuse and stats endpoints. |
| `KHAOYU_SERVICE_BACKUP_PASSPHRASE` | empty | Encrypt backups with scrypt-derived AES-256-GCM. Required to restore them. |
| `KHAOYU_SERVICE_ALERT_WEBHOOK` | empty | Optional HTTP(S) endpoint for login-block security alerts. |
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
| `POST` | `/api/v1/auth/register` | Create an account and queue a verification token. |
| `POST` | `/api/v1/auth/verify-email` | Consume the verification token. |
| `POST` | `/api/v1/auth/login` | Password login, optional TOTP, sets session cookies. |
| `POST` | `/api/v1/auth/otp/request` | Queue a one-time login code by email. |
| `POST` | `/api/v1/auth/otp/login` | Login with a one-time code; TOTP still applies. |
| `POST` | `/api/v1/auth/refresh` | Rotate the refresh token and issue a new access token. |
| `POST` | `/api/v1/auth/logout` | Revoke the current session and clear cookies. |
| `POST` | `/api/v1/auth/logout-all` | Revoke every session for the account. |
| `GET` | `/api/v1/auth/sessions` | List sessions with device, timestamps and current flag. |
| `DELETE` | `/api/v1/auth/sessions/:id` | Revoke one session. |
| `POST` | `/api/v1/auth/password-reset/request` | Queue a single-use reset token. |
| `POST` | `/api/v1/auth/password-reset/confirm` | Set a new password and revoke sessions. |
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
| `PUT` | `/api/v1/projects/:id/snapshot` | Update a snapshot as owner or editor, with revision check. |
| `GET` | `/api/v1/account/email-preferences` | Read the email notification preference. |
| `PATCH` | `/api/v1/account/email-preferences` | Opt in or out of notification email. |
| `GET` | `/api/v1/email/unsubscribe` | One-click unsubscribe using a signed token. |
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
non-HttpOnly `khaoyu_csrf` cookie. Bearer access tokens skip the CSRF check.

Scoped API tokens use the `khn_` prefix and the `projects:read` or `projects:write` scopes. They are
stored as hashes, returned only once, and can be revoked from the account token endpoints. API
tokens cannot manage sessions, TOTP or account deletion; those require a user session.

Email verification and password reset tokens are single use, short lived and stored as hashes. The
development mailer writes messages to the outbox instead of sending SMTP; treat that directory as
sensitive and add an SMTP adapter before production use.

Desktop sync uses a scoped API token with `projects:read` and `projects:write`. The service allows
bearer-token CORS preflight only from `KHAOYU_SERVICE_CORS_ORIGINS`; cookies and credentials are
never allowed from those origins. Add the local web host origin manually if the browser build should
sync directly.

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
restores and share reports. Listing filters every notification through current resource access, so a
removed member stops seeing project notifications immediately even though the rows remain. Read state
is per account; only the owner can mark a notification read. Revoking a share link, or disabling
project sharing, deletes its pending notifications. Read notifications older than 90 days are pruned.

Notification email is opt-in per account. When SMTP is configured, messages are delivered through
`nodemailer`; otherwise they remain in the mode `0600` outbox. Each message has a signed one-click
unsubscribe link, and at most one notification email is sent per account per five minutes. Invitation,
verification and reset mail remain transactional and are not governed by the notification preference.

## Revision history and events

Every accepted snapshot update stores a `project_versions` row. Members can list the latest 100
revisions, and editors or owners can restore one by creating a new revision, so history is never
rewritten. The worker prunes versions beyond the latest 100 per project.

`GET /api/v1/projects/:id/events` is an authenticated server-sent events room. It checks project
membership before opening the stream, emits a `presence` event with connection and distinct account
counts, and emits `snapshot` events with the new revision and restoring revision when applicable. A
25 second heartbeat keeps proxies from closing idle streams. Only project rooms receive events, so a
member of one project does not see activity in another.

## Project assets

Assets are uploaded as raw bytes with `x-file-name` and a content type, limited to 100 MB. The bytes
are content-addressed and deduplicated in the object store; the project asset row keeps an opaque id,
display name, content type and size. Executable and script extensions are rejected. List and download
require project membership, while upload requires the editor role and the `projects:write` scope.

A share can download an asset only when `downloadAllowed` is true, the link is valid and its
passphrase matches. Project shares can download any project asset; item and column shares only when
the asset id appears in the scoped payload. Downloads are audited per share link. MIME sniffing,
malware scanning, watermarking and signed short-lived asset URLs are still pending.

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

Caddy:

```caddyfile
notes.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

Nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name notes.example.com;
  client_max_body_size 100m;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

Set `KHAOYU_SERVICE_PUBLIC_URL` to the public HTTPS origin after the proxy is active.

## Tests

```powershell
node --test test/service.test.mjs test/auth.test.mjs

# against a running instance with a verified account
node ../tools/check-service-security.mjs --base http://127.0.0.1:8080 --credentials ../target/service-dev-credentials.json
```

The service suite covers fail-closed configuration, reversible migrations, opaque object storage
with deduplication, audit IP hashing, backup/restore round-trip, worker cleanup and the health
endpoints. The auth suite covers verification, generic login errors and throttling, CSRF, project
authorization, refresh rotation and reuse, session revocation, password reset, TOTP, account
deletion grace and purge, scoped API tokens, email one-time codes, project/item/column share
isolation, passphrase and expiry enforcement, abuse reports, invitation acceptance, ownership
transfer, asset authorization, share download permission, share comments and edits, revision restore,
authenticated SSE rooms, scoped notifications, SMTP delivery, email preferences and CORS preflight.

## Milestone boundaries

Implemented from Milestone 1: standalone process, one HTTP port, relational schema, opaque object
storage, worker, minimal health endpoint, environment configuration, fail-closed startup, reversible
migrations, backup/restore and upgrade documentation.

Implemented from Milestone 2: email and password registration with verification, case-normalized
email, display name, Argon2id, short-lived access tokens, rotating refresh tokens with reuse
detection, session list and revocation, logout everywhere, login throttling, generic login errors,
hashed single-use reset tokens, TOTP, account export, deletion grace and purge, cookie and CSRF
hardening, project role checks and scoped API tokens. Email one-time login codes are also
implemented.

Implemented from Milestone 3: project, item and column share scopes; hashed revocable and rotating
links; expiry; optional passphrase with rate limiting; neutral 404 responses; noindex headers; audit
per access; project roles; email-bound invitations; member removal; ownership transfer safeguards;
public sharing off by default; scoped payload isolation; a global operator kill switch; abuse
reports; and authenticated project asset upload/download with share download enforcement.

Implemented from Milestone 4: authenticated per-project SSE rooms, presence counts, revision history,
editor-only restore and audit. Offline queues, cursor and lock awareness, scoped comments and
notifications remain pending.

Implemented from Milestone 5: scoped in-app notifications for invitations, role changes, revision
restores and share reports; per-account read state; cleanup when a share is revoked; SMTP delivery
with outbox fallback; opt-in notification email with signed unsubscribe links and a five minute rate
limit.

Still pending: a manage-specific share surface, watermarking, MIME sniffing and malware scanning,
signed short-lived asset URLs, nested-board policy for project shares, passkeys, SSO, team membership
UI, a browser login UI and desktop client sync. The Milestone 1 sync boundary remains
open: desktop opt-in, explicit sync state, offline queue with conflict handling, and protection
against a local database delete removing server data.
