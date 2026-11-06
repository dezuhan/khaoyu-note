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

Passwords use Argon2id with 64 MiB memory, 3 iterations and a 16-byte per-user salt. Access tokens live
15 minutes. Refresh tokens live 7 days, rotate on every use and are stored as SHA-256 hashes. Reusing
an old refresh token revokes the whole session family. Login failures are generic and limited per
email and per IP.

Cookies are `HttpOnly`, `SameSite=Lax` and `Secure` when the public URL is HTTPS. Write requests made
with cookie authentication must send the CSRF token in `X-CSRF-Token`; the same value is in the
non-HttpOnly `khaoyu_csrf` cookie. Bearer access tokens skip the CSRF check.

Scoped API tokens use the `khn_` prefix and the `projects:read` or `projects:write` scopes. They are
stored as hashes, returned only once, and can be revoked from the account token endpoints. API
tokens cannot manage sessions, TOTP or account deletion; those require a user session.

Email verification and password reset tokens are single use, short lived and stored as hashes. The
development mailer writes messages to the outbox instead of sending SMTP; treat that directory as
sensitive and add an SMTP adapter before production use.

## Migrations

```powershell
node src/cli.mjs status
node src/cli.mjs migrate
node src/cli.mjs rollback --steps 1
```

Migration files live in `src/migrations` as paired `*.up.sql` and `*.down.sql`. Every migration is
applied in a transaction and recorded in `schema_migrations`.

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
5. Start the service and check `/readyz`.

Database migrations preserve existing account, project, membership and audit rows. Session
invalidation is completed with the login work in Milestone 2; the `sessions` table is present now so
the upgrade path can revoke sessions without a destructive migration.

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
```

The service suite covers fail-closed configuration, reversible migrations, opaque object storage
with deduplication, audit IP hashing, backup/restore round-trip, worker cleanup and the health
endpoints. The auth suite covers verification, generic login errors and throttling, CSRF, project
authorization, refresh rotation and reuse, session revocation, password reset, TOTP, account
deletion grace and purge, and scoped API tokens.

## Milestone boundaries

Implemented from Milestone 1: standalone process, one HTTP port, relational schema, opaque object
storage, worker, minimal health endpoint, environment configuration, fail-closed startup, reversible
migrations, backup/restore and upgrade documentation.

Implemented from Milestone 2: email and password registration with verification, case-normalized
email, display name, Argon2id, short-lived access tokens, rotating refresh tokens with reuse
detection, session list and revocation, logout everywhere, login throttling, generic login errors,
hashed single-use reset tokens, TOTP, account export, deletion grace and purge, cookie and CSRF
hardening, project role checks and scoped API tokens.

Still pending: SMTP delivery, passkeys, SSO, email one-time codes, team membership management, a
browser login UI and desktop client sync. The Milestone 1 sync boundary remains open: desktop opt-in,
explicit sync state, offline queue with conflict handling, and protection against a local database
delete removing server data.
