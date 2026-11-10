# Khaoyu Note 0.35.0

Local-first visual notes, boards and templates — now with ten UI languages, section wrapping,
simplified kanban containers, portable database export and Linux/Windows/macOS packaging.

## Highlights

- **10 UI languages**: English, Português (Brasil), Bahasa Indonesia, Español, Français, Deutsch,
  日本語, 한국어, 简体中文 and Русский. Menus, command palette, settings and backup UI follow the
  language immediately; board content is never translated.
- **Sections and selections**: wrap two or more cards into a Section, create board templates from a
  selection, and manage built-in/custom templates in Settings.
- **Simpler kanban model**: wrap columns into a row/kanban, release kanban/row/column wrappers, and
  keep drag/drop previews above the board. The old standalone Kanban tool is removed.
- **Consistent manual color picker**: HSV square, hue bar, HEX input and a visible hint are available
  on web and desktop; the screen eyedropper appears only where the platform supports it.
- **Database tools**: export a database ZIP from desktop or the web host, restore on desktop with a
  native folder picker, and inspect Database/Assets/Total project size in Settings > About.
- **Safer backups**: desktop backups fall back to the app data directory when Documents is not
  writable; `KHAOYU_NOTE_BACKUP_DIR` is supported.
- **Linux fixes**: WebKitGTK transform zoom keeps text and cards aligned at low zoom, stray board text
  selection is cleared, and page zoom no longer diverges from Windows.

## Setup and collaboration status

- The first-run wizard currently offers **Local SQLite/offline only**.
- **Collaboration** is disabled until the admin dashboard and role model are implemented.
- **Turso** is disabled until the libSQL adapter, token storage and asset migration exist.
- The web host supports database export; import remains desktop-only because the web host needs a
  maintenance/restart flow.

## Packages

Release builds can produce:

- Windows: NSIS `.exe`, `.msi`, portable `.exe`
- Linux: `.deb`, `.rpm`, `.AppImage`, `.flatpak`, portable `.tar.gz`
- macOS: universal `.app` and `.dmg`

The GitHub release workflow builds Linux `deb`, `rpm`, `AppImage`, Flatpak, Windows installers and
macOS bundles when a `v*` tag is pushed or the workflow is run manually.

## Known limitations

- Collaboration and Turso are intentionally disabled in this release.
- AppImage bundling is built in CI; local AppImage testing may show a GStreamer `appsink` warning.
- Web database import is disabled; use desktop restore for now.
- Production collaboration still needs OIDC, penetration/load testing, PostgreSQL/Redis validation,
  object storage and signing/notarisation.

**Full changelog:** [CHANGELOG.md](../CHANGELOG.md)
