# Security and architecture audit

Snapshot date: 2026-11-07. Scope: Milestones 1 to 3 in `service/`, the desktop local-first boundary,
and the new share links.

## Summary

The service foundation and account core are usable for a single-tenant self-hosted deployment behind
TLS. Authentication, session rotation, CSRF, share-token isolation and project authorization are
covered by 23 automated service checks. The largest remaining risks are the absent desktop sync
client, the file-based mail outbox instead of SMTP, and missing asset upload and download
authorization.

## Fixed during the audit

- Share tokens were written to request logs. Paths under `/api/v1/share/<token>/access` are now
  redacted before logging.
- Project shares included the trash and local filesystem asset paths. Shared payloads now omit the
  trash and null local paths, including `file:` and absolute paths.
- Disabling public sharing did not revoke existing links. It now revokes every link for the project.
- Editors could create invitations. Invitation creation and revocation are now owner-only.
- Share access, password attempts, expiry, rotation and revocation now have regression tests.
- Account deletion export now includes accessible project snapshots.
- Project assets now have authenticated upload and member-only download, and shares enforce the
  download flag with per-link audit.
- SMTP delivery is implemented with an outbox fallback, opt-in notification email, signed unsubscribe
  links and a notification email rate limit.
- Backups can be encrypted with scrypt and AES-256-GCM; login blocks can post a structured alert to
  an operator webhook.

## Findings

### High

| Finding | Status |
| --- | --- |
| Desktop sync, explicit sync state and offline queue are not implemented. | Closed. Opt-in sync, explicit state, conflicts, offline queue and no-delete behavior are implemented; mobile and multi-device conflict UX remain limited. |
| Share-token write permissions are stored but no write endpoint enforces them. | Closed. Comment and edit writes now enforce the permission rank and scope. |
| Email delivery without SMTP falls back to the filesystem outbox. | Accepted for small deployments. The outbox is mode `0600`; SMTP is configured by environment when required. |
| There is no TLS in the service itself. Operators must terminate TLS in Caddy, Nginx or another proxy. | Open by design. The Compose port binds loopback only. |

### Medium

- The desktop sync API token is stored in webview local storage, not the operating system keychain.
  A compromised webview or XSS could read it. Use a scoped, expiring token and revoke it after use.
- Bearer-token CORS is limited to configured desktop origins. Any origin added to
  `KHAOYU_SERVICE_CORS_ORIGINS` can call the API if it obtains a token; keep the list minimal.
- Asset MIME sniffing and an optional scanner hook are implemented; watermarking and signed
  short-lived URLs are not.
- Backup encryption is optional. When no passphrase is configured, backups remain plaintext in the
  backup directory and depend on host and volume controls.
- Registration, reset requests and invitations have no dedicated rate limit.
- Logout is state-changing but does not require the CSRF header. It clears cookies and is bounded to
  the caller's session.
- The upgrade path can revoke sessions with `invalidate-sessions`, but it is an operator step rather
  than an automatic migration action.
- Project shares expose the current snapshot only. Nested board content is not included by policy.
- Share passphrase attempts use the same fixed window as login and return a neutral 404. Login blocks
  can post to an operator webhook; sharing blocks have no separate paging integration.
- Audit rows are pruned by retention and can be exported through the admin API; there is no
  tamper-evident chain or signed export.

### Low

- SQLite is a single-node store. It fits a small self-hosted team but does not scale horizontally.
- Dependency scanning is in CI, but there is no automated runtime SBOM or external review.
- The local desktop app still uses a whole-document save model. The service project snapshot uses a
  revision check, but there is no delta sync.
- External media iframes are sandboxed, but the desktop app and service deploy separately, so their
  CSP and proxy policies must remain aligned.
- The incident response runbook exists but has not been exercised in a live drill.

## Controls present

- Argon2id password hashing, hashed access/refresh tokens, rotating refresh tokens and family-wide
  reuse revocation.
- `Secure`, `HttpOnly`, `SameSite=Lax` cookies, double-submit CSRF and strict origin checks.
- Server-side project membership and role checks, deny-by-default routes, scoped API tokens.
- Hashed share tokens, expiry, revocation, rotation, passphrase rate limiting and `noindex`.
- HMAC-hashed audit IPs, structured JSON logs, secret redaction and redacted share paths.
- Environment-only secrets, fail-closed startup, explicit reversible migrations, non-root container,
  read-only root filesystem, dropped capabilities and loopback-only Compose port.
- Backup integrity verification, safety copy on restore and worker retention.
- Separate operator admin token, per-IP admin rate limit, audited export and abuse review.
- Optional SSO only behind trust-proxy, HMAC-signed email headers and a fail-closed secret.
- Presence is opt-in, excludes opted-out connections from counts and never sends board contents.
- Mention notifications resolve only current project members and never expose comments to outsiders.
- Threat model, security policy, incident runbook, release checklist and data residency docs.

## Recommended next work

1. Add MIME sniffing, malware scanning, signed short-lived asset URLs and watermarking.
2. Complete desktop sync with opt-in per project, explicit state, offline queue and conflict flow.
3. Add signup/reset/invite rate limits (the sharing kill switch and notification email rate limit are
   now in place).
4. Add encrypted offsite backups and a documented restore drill.
5. Add dependency and container scanning to CI, then an external penetration test before production.
