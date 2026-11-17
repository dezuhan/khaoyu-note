# Deep links (`khaoyunote://`)

Status: implemented on `feature/deep-link` (Rust parser, single-instance forwarding, webview bridge,
unit and browser tests). Cross-platform artifact verification is still pending. This is the reverse
direction of the link-card work in 0.36.1: link cards now hand custom schemes to the OS; this feature
makes Khaoyu Note itself the registered handler for `khaoyunote://` so a link can open the app and a
board.

## Goal and success criteria

- Installed builds register the `khaoyunote` scheme on Linux, Windows and macOS.
- Opening `khaoyunote://open?board=<boardId>` starts the app when it is closed, or focuses the running
  window, and opens that local board.
- Unknown actions, unknown boards and malformed URLs are ignored with a visible message; nothing is
  imported, downloaded or executed.
- Local-first behaviour is unchanged: the app still works with no handler and no service.

## URL contract (v1)

```
khaoyunote://open?board=<boardId>
```

- Exactly one action, `open`, and one parameter, `board`. Extra parameters are rejected.
- `boardId` is validated against the local database: it must exist, must not be trashed or archived.
  Deleted/unknown ids show a toast, never an error page.
- `share=`/`server=` parameters are deliberately rejected in v1: a deep link must not be able to
  activate a remote sync/share session, because a link can come from an untrusted page.
- No `https` app links and no mobile schemes in v1.
- Cap the raw URL length at 2 KB and fail closed on malformed percent-encoding.

## Architecture

1. **Dependencies** (`app/src-tauri/Cargo.toml`):
   - `tauri-plugin-deep-link = "2"`
   - `tauri-plugin-single-instance = { version = "2", features = ["deep-link"] }`
   - Bump `rust-version` from 1.77 to 1.90 (deep-link plugin MSRV).
2. **Builder** (`app/src-tauri/src/lib.rs`, `run()`): register `tauri_plugin_single_instance::init(...)`
   first, then `tauri_plugin_deep_link::init()`, then the existing dialog plugin. The single-instance
   callback focuses the `main` window and forwards the new process arguments; the deep-link plugin
   delivers macOS open-url events. Both paths call one helper:
   - `parse_deep_link(url) -> Result<String, DeepLinkError>` returns the board id only.
   - `queue_deep_link(app, result)` stores the latest result in managed state and emits `mn:deep-link`
     to the main window (payload `{ boardId }` or `{ error }`).
3. **Startup command**: add `take_pending_deep_link()` Tauri command so the frontend can collect a link
   that arrived before the webview finished booting (`get_current` only covers process arguments; a
   pending slot covers events racing the boot).
4. **Frontend** (`app/web/js/deep-links.js`, new):
   - No-op when `window.__TAURI__` is absent (web host/browser previews).
   - `initDeepLinks()` subscribes to the `mn:deep-link` event, calls `take_pending_deep_link()`, and
     queues the target until the first board list has loaded.
   - On a valid id: close any open settings/share overlay, `openBoard(id)`, update the `?board=` URL
     with `history.replaceState`, and select the board in the workspace list.
   - Invalid targets show the existing `mn:toast`.
   - Wired from `main.js` after `refreshBoards()` in `boot()`.
5. **Config** (`app/src-tauri/tauri.conf.json`):

   ```json
   "plugins": {
     "deep-link": {
       "desktop": { "schemes": ["khaoyunote"] }
     }
   }
   ```

   Rust-only event handling means no JS plugin package and no new capability permission unless the
   core event permission needs extending; verify `core:default` covers `event.listen` and add
   `core:event:default` only if the smoke test fails.
6. **Development builds**: under `#[cfg(debug_assertions)]`, run the plugin's `register_all` when
   `KHAOYU_DEV_DEEP_LINK=1` is set, so `cargo tauri dev` can be triggered with
   `xdg-open 'khaoyunote://open?board=…'` without writing OS configuration on every dev launch.
   Release builds check `is_registered` at startup and call `register` once on Linux/Windows when the
   scheme is missing (covers AppImage/portable installs with no post-install hook); macOS uses the
   static `CFBundleURLTypes` entry from the plugin configuration.

## Per-platform registration

| Platform | Mechanism | Verification |
|---|---|---|
| Linux `.deb`/`.rpm` | Tauri bundler must add `MimeType=x-scheme-handler/khaoyunote;` to the `.desktop` entry. If the bundler does not, ship a `bundle.linux.desktopTemplate` with the MimeType and run `update-desktop-database` in the package. | `grep MimeType /usr/share/applications/*khaoyu*.desktop`, `xdg-mime query default x-scheme-handler/khaoyunote`, then `xdg-open 'khaoyunote://open?board=…'` |
| Linux AppImage | Portable bundles have no installer; the release build calls `register` on first run when `is_registered` is false, writing a handler for the AppImage executable. A “Register/unregister link handler” Settings action is a follow-up. | `xdg-mime query default x-scheme-handler/khaoyunote` after the first launch |
| Flatpak | Desktop entry from the manifest must declare the MimeType; single-instance DBus needs `--talk-name`/`--own-name` for `org.com_dezuhan_khaoyunote.SingleInstance` in `packaging/flatpak/com.dezuhan.khaoyunote.yml`. | `flatpak run com.dezuhan.khaoyunote 'khaoyunote://…'` and `flatpak permission-show`/`gio mime` |
| Windows MSI/NSIS | Plugin config must produce the `HKCU\Software\Classes\khaoyunote` handler; if the bundler does not, add an NSIS hook that writes `shell\open\command = "<install dir>\Khaoyu Note.exe" "%1"` and removes it on uninstall. | `reg query HKCU\Software\Classes\khaoyunote`, `start khaoyunote://open?board=…` |
| macOS `.dmg` | Plugin config must emit `CFBundleURLTypes` in `Info.plist`; static registration only, no runtime write. Signing/notarisation gate applies. | `plutil -p "Khaoyu Note.app/Contents/Info.plist"` shows the scheme; `open 'khaoyunote://…'` |

The final registration mechanism per installer is confirmed while implementing; the plan requires the
verification command above to pass on a built artifact, not just `cargo tauri dev`.

## Security rules

- Fixed scheme `khaoyunote` (case-insensitive); everything else is ignored.
- Only `open` + `board`; no commands, file paths, URLs, import or delete actions.
- Board ids are looked up in the local database; no path traversal, no SQL built from the URL.
- Reject non-local servers and share tokens in v1 (phishing chain: web page → deep link → remote session).
- Never trust the raw argv beyond parsing; the single-instance payload is a URL string, not a shell command.
- Focus the window only; no auto-navigation away from unsaved local edits beyond opening another board
  (the existing `openBoard` flush behaviour applies).

## Edge cases and failure modes

- App closed: OS starts the process with the URL; boot collects it via `take_pending_deep_link`.
- App running: second instance exits, first focuses the window and handles the link.
- Link arrives during boot / before board list: queued and processed after `refreshBoards()`.
- Several links in quick succession: the latest valid board wins; earlier ones are dropped.
- Board missing, trashed, archived or nested under a deleted parent: toast, stay on the current board.
- Settings, share dialog or a card editor open: close transient UI, then open the board.
- Web host/browser tab: `initDeepLinks()` is a no-op (the browser is not the handler).
- Manual/legacy handler entries (for example `khaoyunote-handler.desktop` used during the 0.36.1
  test) can shadow the installer entry; document unregistering them.
- Flatpak/snap sandbox: single-instance DBus must be declared in the manifest or two instances start.

## Tests

- **Rust unit tests** for `parse_deep_link`: valid board, uppercase scheme, missing/extra params,
  `share=`/`server=` rejection, unknown action, over-long URL, bad percent-encoding, non-matching scheme.
- **Frontend browser test** (`tools/test-deep-links.mjs`): load the preview, dispatch `mn:deep-link`
  with a valid board id and assert the board opens and the URL updates; dispatch an unknown id and
  assert a toast and no board change. Add it to `.github/workflows/ci.yml`.
- **Linux manual gate** on a built `.deb`/AppImage host: `xdg-mime` shows the handler, `xdg-open`
  opens/focuses the app, board opens, second link reuses the running instance.
- **Windows/macOS manual gate** on release artifacts using the verification commands in the table.
- Existing suites stay green: `node --test tools/test-external-links.test.mjs`, `test-ui`, service tests.

## Docs and release notes

- Link from `docs/architecture.md` to this file; mention the reverse direction of link-card schemes.
- `CHANGELOG.md` `[Unreleased]`: “Deep links: `khaoyunote://open?board=` opens the app and a local board”.
- `ROADMAP.md` P3 item updated to `[~]` while implementing, `[x]` after both desktop platforms are verified.
- Packaging docs list which artifacts register the handler (deb/rpm/MSI/NSIS/dmg, not portable AppImage).

## Implemented pieces

- `app/src-tauri/src/lib.rs`: `parse_deep_link`, `deep_link_argument`, `deliver_deep_link`,
  `take_pending_deep_link`, single-instance forwarding, `get_current` startup pickup, `on_open_url`
  listener and the release-time registration check.
- `app/web/js/deep-links.js`: DOM/Tauri event listener, board validation and navigation, wired from
  `main.js` after the first board load.
- `app/src-tauri/tauri.conf.json`: `plugins.deep-link.desktop.schemes = ["khaoyunote"]`.
- Tests: Rust unit tests in `lib.rs` (`deep_links_only_accept_a_local_board_id`) and
  `tools/test-deep-links.mjs` (CI web job).

## Out of scope (v1)

- `khaoyunote://open?share=` and remote workspace links.
- Mobile app links.
- A Settings toggle to register/unregister the scheme (follow-up for portable AppImage).
- Replacing the existing single-instance behaviour on desktop if any is added later.
