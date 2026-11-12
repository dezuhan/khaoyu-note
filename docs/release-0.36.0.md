# Khaoyu Note 0.36.0

A focused release for backup hygiene and service hardening on top of the 0.35.0 local-first build.

## Highlights

- **Automatic backup retention**: automatic backups use their own folder prefix and the desktop keeps
  the newest seven copies. Older automatic folders are pruned after a successful backup; manual
  backups and imported backups are never removed automatically. The Backup pane explains the rule in
  all ten UI languages.
- **Security hardening**: cookie-session logout now requires the CSRF header, and invitation creation
  is rate limited to 20 requests per 15-minute window per owner and IP.
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
