# Changelog

All notable changes to Khaoyu Note are recorded here. The format follows Keep a Changelog and the
project uses Semantic Versioning.

## [0.1.0] - 2026-11-07

### Added

- Local-first Tauri v2 canvas with note, heading, link, to-do, comment, document, table, color,
  sketch, image, audio, video, map, file, board, column and kanban cards.
- Card connections with endpoint snapping, draggable endpoints and curve handles.
- Nested boards with breadcrumbs, board thumbnails and a template library.
- Column containers with collapse, wrap-in-column and convert-to-board actions.
- Sheet cards with column and row headers, resizing, add row or column, clipped headers and
  scrollbars that work inside columns.
- Rich text persistence for notes and headings, plus document conversion that keeps formatting.
- Lock position, link header images, card conversions and context toolbar formatting.
- Command palette, tool rail, settings, notifications and comments.
- Local SQLite persistence with a whole-document save guard, conflict handling, retry on failure,
  backup, integrity check and staged restore.
- Local stdio MCP server with board, card, comment and connection tools.
- Localhost web host on the same SQLite database and assets, with `/status`, a host badge and
  Settings > About details.
- Windows NSIS, MSI and portable executable builds.
- Browser, database and MCP regression suites covering 213 UI checks, 24 card feature checks,
  10 web host checks, 16 MCP checks and 10 Rust library tests.

### Changed

- Renamed the application and identifiers from the earlier Milanote clone name to Khaoyu Note.
- Menu bar uses a fixed three-column layout with the logo, centered search and action icons.
- Tooltips use the design-system popup surface instead of native browser tooltips.
- Line snapping and connection hit areas are tighter.

### Fixed

- Stale saves now surface a conflict instead of overwriting newer data.
- Failed saves keep the dirty state and retry with backoff.
- Renaming a nested board updates its parent board card.
- Column titles are editable and column layout survives returning from a nested board.
- Kanban and sheet scrollbars can be dragged without starting a card drag.
- Rich text no longer reverts to plain text after leaving edit mode.
- Board card titles follow the saved child board title.
