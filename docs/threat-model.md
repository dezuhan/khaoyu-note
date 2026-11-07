# Threat model

Snapshot date: 2026-11-07. Scope: self-hosted service, desktop sync, sharing, accounts and local web
host.

## Assets

- Account credentials, TOTP secrets, recovery tokens and session cookies.
- Project snapshots, cards, comments and uploaded assets.
- Share tokens, passphrases, invitation tokens and API tokens.
- Audit records, abuse reports and email addresses.
- Service secrets: session signing, IP hashing, admin token and SMTP credentials.

## Actors and trust boundaries

- Anonymous internet user: can reach login, registration, reset, public share and report endpoints.
- Authenticated member: can reach project-scoped endpoints according to role.
- Share visitor: holds a bearer link or passphrase and reaches only the shared scope.
- Operator: holds environment secrets and the admin token.
- Desktop client: holds a scoped API token in webview storage.
- Reverse proxy: terminates TLS and forwards client IPs only when explicitly trusted.

## Threats and controls

| Threat | Control | Residual |
| --- | --- | --- |
| Credential stuffing | Argon2id, generic errors, progressive IP and email throttle, optional TOTP and OTP. | No external alert routing or CAPTCHA. |
| Session theft | Short access tokens, rotating refresh tokens, reuse detection, HttpOnly cookies, CSRF. | Webview token storage for sync is not OS-keychain backed. |
| IDOR and scope leaks | Membership checks on every route, share scope filter, item/column isolation. | Board APIs beyond project snapshot remain limited. |
| Share link leakage | High entropy tokens, hash at rest, expiry, revocation, rotation, passphrase, noindex, neutral 404. | Links are bearer secrets once copied. |
| XSS in shared content | Client escaping and sanitizer, JSON-only service responses, strict headers. | Server does not render rich text, so server-side sanitising is not applicable yet. |
| CSRF and cross-origin writes | Same-origin checks, double-submit CSRF, CORS only for configured bearer origins without credentials. | Logout remains a cookie mutation without a CSRF header. |
| Malicious upload | Size limit, filename sanitisation, extension blocklist, image magic-byte sniffing, optional scanner hook, authenticated access. | No watermark or signed short-lived URL; non-image types are not sniffed. |
| Abuse and spam | Public sharing kill switch, per-link reports, share password throttle, admin review. | No automated classification or global user suspension. |
| Denial of service | Body limits, login throttle, share throttle, admin endpoint limit. | No dedicated load balancer or global rate limiter. |
| Local web host abuse | Loopback bind by default; network exposure requires changing `KHAOYU_WEB_HOST` on purpose. | No authentication, origin check or rate limit on `POST /api/invoke`: any local process that can reach the port can read and rewrite boards. |
| Supply chain | `npm audit`, Dependabot and Trivy image scanning in CI. | No reproducible binary signing or third-party review. |
| Operator mistakes | Fail-closed config, migrations, backup/restore, release checklist. | No automated restore drill. |
| Insider access | Least-privilege project roles, audit log, admin token separation. | SQLite file access is operator-level. |
| SSO header spoofing | HMAC-signed proxy email, trust-proxy requirement, proxy must strip client headers. | Custom reverse-proxy signing is operator responsibility; OIDC is not built in. |

## Assumptions

- TLS terminates at a trusted reverse proxy.
- The host and database volume are trusted and access-controlled.
- The operator keeps `KHAOYU_SERVICE_SECRET`, `KHAOYU_SERVICE_ADMIN_TOKEN` and SMTP credentials out
  of source control.
- Public sharing is disabled until an owner explicitly enables it.
- External penetration testing and formal review are required before advertising production use.

## Open risks

1. No external penetration test or code-signing pipeline.
2. Asset watermarking and signed download URLs are not implemented; image sniffing and an optional
   scanner hook are.
3. No global rate limiter, alert routing or incident paging.
4. Mobile and macOS/iOS packaging is not built or signed.
5. The local web host has no authentication or origin check and is safe only while bound to loopback.
