# Khaoyu Note service foundation

This is the Milestone 1 self-hosted foundation: one standalone HTTP process, a relational SQLite
database for accounts, projects, memberships, snapshots and audit rows, opaque object storage, a
maintenance worker, explicit reversible migrations, and backup/restore. It deliberately has no
login, sharing or client sync endpoints yet. Those belong to Milestones 2 to 4.

## Requirements

- Node 24 or newer with the built-in `node:sqlite` module, or
- Docker with Compose for the container deployment.

## Native quick start

```powershell
cd service
Copy-Item .env.example .env
# Edit .env and replace KHAOYU_SERVICE_SECRET with: openssl rand -hex 32
$env:KHAOYU_SERVICE_SECRET = "paste-the-generated-secret"
node src/cli.mjs migrate
node src/cli.mjs bootstrap
node src/server.mjs
```

Open `http://127.0.0.1:8080/healthz`. The bootstrap command creates the first account and project
without a password; account login is added in Milestone 2.

## Docker Compose

```powershell
cd service
Copy-Item .env.example .env
# Edit .env, especially KHAOYU_SERVICE_SECRET and KHAOYU_SERVICE_PUBLIC_URL
docker compose build
docker compose run --rm khaoyu-note-service node src/cli.mjs migrate
docker compose run --rm khaoyu-note-service node src/cli.mjs bootstrap
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
| `KHAOYU_SERVICE_PROFILE` | `single-user` | `single-user` or `team`. Team accounts are completed in Milestone 2. |
| `KHAOYU_SERVICE_HOST` | `127.0.0.1` | Bind address. Compose sets `0.0.0.0` inside the container. |
| `KHAOYU_SERVICE_PORT` | `8080` | Single HTTP port. |
| `KHAOYU_SERVICE_DATA_DIR` | `.khaoyu-service-data` | Database, objects, temp files and backups. |
| `KHAOYU_SERVICE_SECRET` | required | At least 32 characters and not a placeholder. |
| `KHAOYU_SERVICE_PUBLIC_URL` | `http://host:port` | Public HTTPS origin behind a proxy. |
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
node --test test/service.test.mjs
```

The suite covers fail-closed configuration, reversible migrations, opaque object storage with
deduplication, audit IP hashing, backup/restore round-trip, worker cleanup and the health endpoints.

## Milestone 1 boundary

Implemented: standalone process, one HTTP port, relational schema, opaque object storage, worker,
minimal health endpoint, environment configuration, fail-closed startup, reversible migrations,
backup/restore and upgrade documentation.

Still pending: desktop project sync opt-in, explicit sync state in the app, an offline queue with
conflict resolution, and the guarantee that deleting a local database never deletes server data.
Those require the account and permission model from Milestone 2 before they can be implemented
safely.
