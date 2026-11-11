# Data residency and retention

## Local desktop

- Boards, assets and settings stay under the operating system app data directory unless the user
  enables server sync for a board. `KHAOYU_NOTE_DB_DIR` overrides that folder for portable or
  isolated runs.
- Local backups are written next to the app data or to the operator-selected path;
  `KHAOYU_NOTE_BACKUP_DIR` overrides the backup folder.

## Self-hosted service

In the default `single-user` profile the service keeps its state under the data directory below.
The `team` profile additionally requires PostgreSQL and Redis:

- Database: `KHAOYU_SERVICE_DATA_DIR/khaoyu-service.db` for the single-user profile; in the team
  profile PostgreSQL is the system of record and the operator chooses its host, jurisdiction and
  backups through `KHAOYU_SERVICE_DATABASE_URL`.
- Assets: `KHAOYU_SERVICE_DATA_DIR/objects`.
- Temporary files: `KHAOYU_SERVICE_DATA_DIR/tmp`.
- Backups: `KHAOYU_SERVICE_DATA_DIR/backups`.
- Mail fallback outbox: `KHAOYU_SERVICE_DATA_DIR/outbox`, mode `0600`.
- Redis holds only ephemeral coordination state (events, presence, locks, rate limits) and is not a
  system of record; losing Redis must never lose board data.

The operator chooses the server and therefore the jurisdiction and backup location. The project does
not upload telemetry, analytics or usage data to a third party.

## Retention

| Data | Retention |
| --- | --- |
| Audit log | 90 days by default, configurable with `KHAOYU_SERVICE_AUDIT_RETENTION_DAYS`. |
| Read notifications | 90 days after being read. |
| Expired OTP rows | 1 day after expiry or use. |
| Share attempts | 30 days. |
| Access and refresh tokens | Revoked or expired rows pruned after 1 day. |
| Project versions | Latest 100 per project. |
| Backups | 7 by default, configurable with `KHAOYU_SERVICE_BACKUP_RETENTION`. |
| Account deletion | Requested grace period, default 30 days, then purge. |

Operators must document their own backup location, encryption choice, legal basis and deletion
practice. Encrypted offsite backups are not built in yet and must be provided by the platform or
operator.

## Deletion

Deleting a local board never deletes server data. Deleting a server account after the grace period
purges account, membership, session, notification and owned project data; an export is produced before
purge when the request is accepted.
