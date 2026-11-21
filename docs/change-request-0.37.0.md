# Change request: 0.36.5 performance work and 0.37.0 local-first cleanup

- **CR id:** CR-2026-11-21-01
- **Status:** implemented and released
- **Scope:** Khaoyu Note desktop app, local web host, MCP server, repository tooling and documentation
- **Versions:** 0.36.5 and 0.37.0
- **Requested by:** maintainer
- **Date:** 2026-11-21

## 1. Summary

This change request covers one session of work in two releases. 0.36.5 made the board faster on
Windows and on every platform while keeping every feature, and fixed a flicker in the zoom settle.
0.37.0 removed the optional self-hosted collaboration service completely, together with the client
code that only existed to talk to it, and left a local-first product: the desktop app, the local web
host and the MCP server. It also optimised the release build.

Nothing in the board feature set was removed in 0.36.5, and nothing in the local-first feature set was
removed in 0.37.0: cards, columns, templates, comments, notifications, backup, local accounts and the
MCP tools work exactly as before.

## 2. Changes

### 2.1 Performance (0.36.5)

| Area | Change |
| --- | --- |
| Zoom gesture | Pan/zoom runs on a composited transform during the gesture and settles to the exact CSS zoom; the swap is hidden by a 110 ms `document.startViewTransition()` crossfade, removing the flash on zoom in/out. |
| Wheel input | Wheel events are coalesced per animation frame instead of running a render per event. |
| View persistence | Viewport writes are debounced (250 ms) and the view repaint uses a memo signature. |
| Drag and drop | Card drags move a composited transform instead of recalculating layout; the drop runs a geometry-only pass. |
| Reduced effects | Reduced effects is the default and keeps the dotted grid, card text and tools; it turns off backdrop blur on the board chrome, heavy shadows and long animations. Modal overlays and the command palette keep their glass. |
| Diagnostics | Frame-cost overlay on `Ctrl+Alt+Shift+P` (or `?perf=1`) reports fps, percentiles, long tasks, board size and GPU mode. |

Measured on the previous build: zoom 250 → 485 frames per 3 s (18 cards) and 62 → 422 (500 cards);
p90 frame cost 35 → 7 ms and 264 → 7 ms; drop 35 → 14 ms (500 cards) and 340 → 76 ms (19k nodes); drag
layout time −60%; zoom-settle frame difference 22.1 → 11.4 with two anomalous frames per run → zero.

### 2.2 Fix: modal glass with reduced effects

Reduced effects initially removed every backdrop filter, which broke the Settings overlay's glass. The
fix keeps blur on modal overlays (Settings, sync, share, onboarding) and the command palette, while the
chrome that sits over the board (toasts, menus, comment popovers) still drops it.

### 2.3 Documentation conventions

- `CHANGELOG.md` states the compact release-note shape: a short summary, then bullets for the main
  user-visible outcomes grouped under `Added`, `Changed`, `Fixes` or `Performance`; `[Unreleased]` is
  the working log.
- `CONTRIBUTING.md` gains a `## Release notes` section (draft notes are a summary paragraph, three to
  six highlight bullets and the Downloads/Notes blocks, never a commit list) and a `## Language`
  section: repository artifacts are English, code identifiers are English, and the only non-English
  text is the translation data of the multi-language feature (`app/web/js/i18n.js`). `AGENTS.md`
  repeats the same rule for agents.

### 2.4 Removed: self-hosted service product (0.37.0)

| Removed | Detail |
| --- | --- |
| `service/` | Node 24 server, PostgreSQL/Redis storage, account and admin pages, Docker images, deploy scripts, service test suite |
| `contracts/` | Sync API OpenAPI document, JSON event schemas and fixtures |
| CI | The `Self-hosted service foundation` job and the service-only steps of the web job |
| Tools | Service runner, load service, security check, TOTP helper, sync/presence/share/account/passkey/workspace suites, collaboration load check |
| Docs | Eleven service-only documents plus the service sections of the architecture, roadmap, project status, blockers, release checklist, README and landing page |
| Config | `package.json` service scripts, the service dependabot entry, `.gitignore` service rules, service version/theme checks |

### 2.5 Removed: collaboration client (0.37.0)

`sync.js`, `sync-store.js`, `sync-ui.js`, `share.js`, `share-ui.js`, `workspace-mode.js`,
`presence.js`, `remote-cursors.js`, `remote-temp.js`, `live-board.js` and `features.js`
(`BACKEND_ENABLED`) were deleted with their wiring: boot paths, the share/sync/presence top-bar
controls, the Settings Server pane, the remote board persistence in the store, the OIDC and share
helpers in the bridge, the workspace-mode stylesheet, the service sections of the offline Help and the
self-hosted roadmap card on the landing page.

Kept on purpose: local accounts (`auth.js`, `account-ui.js`, the Rust `auth_*` commands, the local
account tables and `server.mjs` `/api/auth/*`) protect this installation on this device; they are not
a service feature.

### 2.6 Release build

`app/src-tauri/Cargo.toml` gained `[profile.release]` with `lto = "thin"`, `codegen-units = 1` and
`strip = "symbols"`, applied to both `khaoyu-note` and `khaoyu-note-mcp`.

### 2.7 Post-release cleanup

The local web host's dead `/api/share-info` route was removed and its URL list renamed to reachable
URLs; the shared theme lost the service comments and the unused legacy theme keys; the project status
and architecture documents lost their remaining `/api/share-info` and "Self-hosted service" entries.

## 3. Impact

- **Users:** no board data or workflow changed. 0.37.0 removes collaboration features that the local
  release never exposed.
- **Data:** the SQLite schema is unchanged and no migration runs; older databases still open. Local
  account tables remain for the on-device account.
- **Build:** installers and both binaries are smaller; CI build time grows because of LTO.
- **CI:** the service job is gone; web and Rust jobs keep the same coverage for the supported product.

## 4. Verification

| Check | Result |
| --- | --- |
| `scripts/check-web.cjs` | 51 modules clean (0.36.5) and 40 modules clean (0.37.0) |
| `tools/sync-theme.mjs --check` | 14 theme sources in sync |
| `tools/test-theme-module.test.mjs` | 8/8 |
| `tools/i18n-audit.mjs` | 190 keys in 10 languages |
| `tools/test-version.mjs` | PASS 0.36.5 and PASS 0.37.0 |
| `tools/test-onboarding.mjs` | 3/3 |
| `tools/test-web-mode.mjs` | 10/10 |
| `tools/test-ui.mjs` | 287/287 after the removal |
| CI | PRs #32, #34, #35, #36 and #42 green (Rust checks and MCP suite, Web checks and Playwright) |
| Release 0.36.5 | build success, 10 assets, checksums match, MCP reports 0.36.5 |
| Release 0.37.0 | build success, 10 assets, checksums match, MCP reports 0.37.0 (`tools/test-mcp.mjs` 20/20) |

## 5. Risk and rollback

- Risk of the removal is limited to the hidden collaboration surface; the UI suite covers the new
  chrome and the local-first paths.
- Rollback: revert the removal commits (`fa1d91c`, `dd83c20`) to restore the client modules and the
  server tree; no database migration is involved.
- The 0.37.0 tag and release stay available for download after a revert.

## 6. Out of scope and follow-ups

- Unused Rust commands for service OIDC (`start_oidc_listener`, `poll_oidc_login`) can be removed once
  a compiled build verifies the change.
- Unused CSS blocks and i18n keys for the removed share/sync controls are harmless and can be pruned
  in a later cleanup.
- Historical release notes and changelog entries keep their service references on purpose.

## 7. Record

| Version | PRs | Tag | Release |
| --- | --- | --- | --- |
| 0.36.5 | #31, #32, #33, #34 | `v0.36.5` | published 2026-11-20 |
| 0.37.0 | #35, #36, #42 | `v0.37.0` | published 2026-11-20 |
