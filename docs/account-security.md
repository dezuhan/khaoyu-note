# Account security readiness (self-hosted)

This is the operator checklist and the current implementation status for service accounts.

## Implemented

- **Password hashing**: Argon2id, 64 MiB, 3 iterations, 16-byte random salt.
- **Sessions**: 15-minute access tokens, 7-day rotating refresh tokens stored as hashes; refresh
  reuse revokes the session family. Sessions can be revoked individually or everywhere.
- **Cookies**: `HttpOnly` access/refresh cookies, `SameSite=Lax`, `Secure` when the public URL is
  HTTPS; mutations with cookie auth require the double-submit CSRF token.
- **Login throttling**: failed password, OTP, recovery and sync-token attempts are recorded in the
  database per email and per IP with progressive `Retry-After`; successful login clears only the
  email counter.
- **Sensitive account endpoints**: password change (5/15 min), TOTP setup/enable/disable and passkey
  registration (10/15 min), recovery-code generation (10/15 min), export (10/hour) and account
  deletion/cancel (5/hour) have bounded per-account + IP limits. Password-reset confirmation is
  limited per IP.
- **Second factors**: optional TOTP (QR setup, single-use confirmation, password + code to disable);
  WebAuthn passkeys with per-device credentials; ten hashed, single-use recovery codes that are
  invalidated on regeneration and can sign in with the account email.
- **Recovery**: password reset tokens are single use, short lived and stored as hashes; account
  deletion has a grace period and can be cancelled.
- **Audit**: login, TOTP, passkey, recovery-code, session, password and account changes are audited.
- **Headers**: authentication pages use a self-only CSP, frame denial, nosniff, no-referrer and a
  restrictive permissions policy.
- **Account isolation**: cookie sessions and API tokens are scoped; account management mutations
  require a session, not a project bearer token.

## Current operator settings

The development service currently runs with `KHAOYU_SERVICE_PASSKEYS_ENABLED=false`; password,
TOTP and backup-code sign-in remain available. Re-enable passkeys with
`KHAOYU_SERVICE_PASSKEYS_ENABLED=true` after confirming HTTPS and `KHAOYU_SERVICE_RP_ID`.

## Residual risks / deployment requirements

- **Per-process limiter maps.** The login/recovery attempt table is durable and shared, but the
  fixed-window limiters for registration, account mutations and passkey registration are in memory.
  A multi-instance team deployment should add a global rate limit at the reverse proxy or a shared
  Redis limiter. A single-instance self-hosted deployment is bounded by these maps.
- **TOTP secrets are stored at rest in the account row.** Protect the database volume with disk or
  backup encryption; the service currently encrypts object blobs, not every column.
- **HTTPS is required for passkeys and strongly recommended for all auth.** Set
  `KHAOYU_SERVICE_PUBLIC_URL=https://...`, `KHAOYU_SERVICE_COOKIE_SECURE=true`, and put the service
  behind a TLS proxy. Do not expose the backend port directly.
- **Proxy headers must be configured deliberately.** Set `KHAOYU_SERVICE_TRUST_PROXY=true` only when
  a trusted proxy supplies `X-Forwarded-For` and `X-Forwarded-Proto`; otherwise rate limits use the
  proxy IP or the wrong client IP.
- **Admin scope.** Admin sessions can create accounts and change roles. Keep admin accounts limited,
  use TOTP or a passkey, and never expose `/admin` without TLS.
- **No hardware security module.** TOTP secrets and the service signing secret rely on host and
  database protection; rotate `KHAOYU_SERVICE_SECRET` during a planned session reset.
- **Audit retention.** Audit rows are pruned by the worker retention setting; ship them to external
  append-only storage if regulations require it.

## Recommended self-hosted checklist

- [ ] Public URL uses HTTPS and cookies are Secure.
- [ ] Reverse proxy limits auth endpoints and exposes only the frontend listener.
- [ ] Admin has TOTP enabled and backup codes stored offline.
- [ ] Passkeys enabled only after HTTPS/RP ID validation.
- [ ] Database and backup volumes encrypted; backups tested.
- [ ] `KHAOYU_SERVICE_SECRET` rotated and kept out of shell history/images.
- [ ] Trusted-proxy and CORS origins reviewed.
- [ ] Sessions and unused API tokens revoked periodically.
- [ ] Audit/mail outbox directories have restrictive permissions.

## Registration approval

The service registration policy defaults to **Private**. New accounts are created with a null
`approved_at`, cannot authenticate, and appear as Pending in the admin Accounts pane. An admin
approves or revokes access from that pane or with `PATCH /api/v1/admin/users/:id` and
`{"approved":true|false}`. Rejecting a pending account also sets it to `disabled`; approving it again
sets it back to `active`. The first account is always an approved admin; existing accounts are
approved by migration. **Public** mode marks new accounts approved immediately, and public share
viewers offer a Create an account link. The policy is stored in `service_meta.registration_mode`
and changed through `GET/PATCH /api/v1/admin/settings`.

Google OIDC and GitHub OAuth sign-in are implemented behind operator flags (`KHAOYU_SERVICE_GOOGLE_*`, `KHAOYU_SERVICE_GITHUB_*`). They use a signed state cookie, PKCE S256 (Google), JWKS id_token verification (Google) and verified-email linking. The trusted-proxy HMAC header SSO remains available separately.
