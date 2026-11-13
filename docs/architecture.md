# Architecture

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Shell | Tauri v2 (Rust) | small binary, native WebView2, first-class Rust commands, cross-platform |
| Storage | SQLite via `rusqlite` (bundled) | single local database, transactions, queryable geometry; JSON boards from the first version migrate automatically |
| Frontend | vanilla ES modules | no build step: the webview loads the source directly, so dev iteration and Playwright tests need no bundler |
| Theme | shared source + generated copies | `shared/theme/` owns tokens, fonts, icons, logo and `theme.js`; `tools/sync-theme.mjs` writes the app/service copies and CI verifies them |
| Board rendering | DOM + CSS transforms | text editing, selection, accessibility and pixel fidelity for free |
| Drawing | Canvas2D per sketch card | strokes are simple polylines; Canvas2D needs no GPU setup |
| Design system | `shared/theme/` with generated app/service copies | one token language, font, icon and theme runtime source; `tools/sync-theme.mjs` writes the copies |

WebGPU is deliberately not used. The board is a few hundred DOM nodes; the bottleneck in this kind of
app is text editing and layout, not pixels. A GPU renderer would mean losing native text editing and
IME support for no measurable gain. If a board ever exceeds DOM performance limits, the prepared path
is a Canvas2D/WebGL layer for cards outside the viewport, not a rewrite.

## Module map (app/web/js)

| Module | Responsibility |
| --- | --- |
| `main.js` | boot: theme, renderer, interactions, UI, subscriptions, board load |
| `bridge.js` | Tauri `invoke` wrappers, asset URL conversion, localStorage fallback for browser preview |
| `model.js` | pure data: card factories, board document, column layout, welcome board |
| `store.js` | state, subscriptions, undo history, save scheduling, board lifecycle |
| `actions.js` | user-level operations: add, delete, duplicate, clipboard, upload, export, free-spot placement |
| `render.js` | DOM construction per card type, geometry, selection, connections, canvas painting |
| `interact.js` | pointer, wheel and keyboard interactions; inline editing; sketch drawing |
| `ui.js` | tool rail, top bar (including the disabled language button), breadcrumbs, zoom bar, modals, menus, toasts, shortcuts, context menu |
| `home.js` | dormant Home gallery code; multi-project Home is disabled in the single-file UI |
| `file-drop.js` | native OS drag and drop: extension routing to image, audio, video or file cards, asset storage through `store_asset_from_path`, drag overlay |
| `templates.js` | header template library: Blank, Welcome, Project plan, Kanban, Meeting notes and Moodboard starters, applied in place with undo |
| `document-editor.js` | full page document editor: formatting toolbar with anchored insert/style menus, rich text, export |
| `drawing-editor.js` | full page drawing editor: pen/pencil/highlighter with colour and size options, eraser, undo |
| `comments-panel.js` | top bar comments popup: collects threads across the board tree, navigates to cards |
| `notifications.js` | top bar notification center: ingests comment activity, unread badge, read/unread/remove/delete-all actions, persists through app settings |
| `context-toolbar.js` | floating bottom toolbar: markdown formatting for note/heading text, Move/Pen/Eraser for drawing |
| `settings.js` | preferences dialog: General, Appearance, Tools, Board templates, Performance, Backup and the Account, MCP and About pages |
| `i18n.js` | ten-language settings localization, persisted in `mn.language`; board content is never translated |
| `sync.js` / `sync-ui.js` | opt-in per-board sync client, plus its dialog and status pill |
| `share.js` / `share-ui.js` | service sharing API client and the board or card share panel |
| `command-palette.js` | Ctrl+K command palette with recently used commands |
| `color-picker.js` / `color-names.js` | HSV colour picker and the named-colour lookup |
| `image-crop.js` | crop overlay for image cards and link header images |
| `preview.js` | mini board painter used by home cards and board cards |
| `limits.js` | upload size cap, blocked-extension policy, and the temporarily disabled tool list |
| `setup.js` | first-run storage setup after reset: single user, local SQLite, Turso and collaboration choices |
| `documentation.js` | offline Help > Documentation content |
| `time.js` | absolute comment timestamps |
| `icons.js` | inline SVG icon set |

Dependency direction is one way: `model` <- `store` <- `actions` <- `render` / `interact` / `ui` <-
`main`. `render` and `interact` cooperate through delegated DOM events and the store's event bus, so
there is no direct import cycle between them.

## Event flow

`store.notify(kind)` drives rendering. Kinds:

- `board`: structure or content changed, full card rebuild
- `geometry`: positions and sizes only, patch styles
- `selection`: toggle selection classes only
- `view`: viewport transform and grid background only
- `save`: save indicator only
- `history`: undo/redo button state
- `theme`, `tool`, `boards`: chrome updates

Text input handlers mutate the card object and call `markDirty("save")` so typing never triggers a
rebuild (which would destroy the caret). Structural changes call `markDirty("board")`.

## Coordinate system

The board is an infinite world plane. Scaling uses the CSS `zoom` property (not a transform scale)
because Chromium re-lays out and re-rasterises text at the zoomed size, so cards stay sharp up to the
maximum 400 percent zoom. The world element gets `zoom: view.zoom` and
`transform: translate(view.x / zoom, view.y / zoom)`; the divide is required because CSS zoom also
scales the translate. The screen formula stays `screen = pan + world * zoom`, so pointer maths is
`world = (screen - view.pan) / zoom` and wheel zoom keeps the world point under the cursor fixed.

The dotted grid is a CSS radial-gradient on the viewport with `background-size = grid * zoom` and
`background-position = view.pan`, which keeps dots aligned with world coordinates at every zoom.
Card heights measured for layout are divided by the zoom because `getBoundingClientRect` reports the
zoomed size, and sketch canvases are repainted (DPR aware) after a zoom settles so strokes stay
sharp too. The viewport uses `overflow: clip` (not `hidden`) so a programmatic `scrollIntoView` or a
stray wheel event cannot silently scroll the canvas origin away from `view.pan`.

## Card model

```json
{
  "id": "note_abc123",
  "type": "note",
  "x": 180, "y": 220, "w": 380, "h": 140,
  "z": 7, "parentId": null, "order": 0,
  "text": "Hello"
}
```

Types: `note`, `heading`, `link`, `todo`, `document`, `comment`, `table`, `color`, `sketch`,
`drawing`, `image`, `audio`, `video`, `map`, `file`, `board`, `column`. A column is a
container whose children point at it through `parentId`; that link is cleared when a card is dragged
out of a column. Link cards open through the Rust `open_external` command, which validates http(s)
and launches the system default browser instead of a WebView2 child window.

Kanban is no longer a card type or a tool. Select at least two top-level columns and use the
right-click action **Wrap into kanban**; the selected columns become children of a column with
`direction: "row"` and `kanban: true`. The row container lays its column children horizontally and
each child lays its own cards vertically. This keeps one container model for columns, rows and
kanban-like layouts. Legacy `kanban` cards are migrated on open into a row column with one child
column per former lane and one note per former item. The MCP `create_card` tool no longer accepts
`type: "kanban"`.

Freehand drawing is a normal card type (`drawing`) whose data is a normalized array of points and a fixed 3 px stroke width, rendered as an SVG path. The Draw tool captures pointer points into a preview SVG, then creates the card with a bounding box and `aspect` so it can be selected, moved and deleted like any other card, but never reshaped; Eraser hit-tests drawing cards and sends them to the board Trash. A fixed bottom `context-toolbar.js` shows Markdown-style commands (bold, italic, underline, strike, code block, bullet and numbered lists) while a note or heading is selected or edited, and switches to Move/Pen/Eraser while the Draw tool or a drawing card is active.

To-do items carry a burger handle beside the remove button; pointer drag reorders the items inside the card, showing a floating label and an accent drop line, and commits through `checkpoint()`/`markDirty("board")`.

Card deletion keeps a per-board `trash` array. `moveCardsToTrash` groups a column with its children, stores deep copies of those cards and any connections touching them, removes the cards/connections from the live board, and checkpoints; `restoreTrashEntry` re-adds the group (detaching a child only if its column was permanently removed) and `emptyTrashEntries` clears the list. The Trash tool deletes the current selection when there is one, otherwise it opens a modal listing every deleted group with Restore and Delete plus an Empty trash confirmation. The array is stored in a `trash` TEXT column on `boards`; `write_doc` preserves it when a stale document omits the field.

Auto height: `measureHeights` re-measures every card whose height is content driven (note, heading, link, todo, document, comment, table, board, audio, video, map, file) and `applyGeometry` leaves their CSS height unset so the DOM content decides it. Aspect-ratio types (image, sketch, color) use `CARD_ASPECTS` (or an image crop ratio), so widening them scales their height; column heights are computed by `layoutColumn`. All non-section cards expose a horizontal-only corner grip; vertical drag does not change their height. Mutations that change content without a full board re-render (adding or removing a todo item, sending a comment, editing a field) call `syncCardHeight`/`syncAutoHeight`, which also re-lays out a containing column so a growing child never overlaps the next card.

While a table card is selected or focused, `render.js` overlays a spreadsheet header: a grid of A/B/C column letters above the grid (with AA, AB, ... after Z) and one number per row on the left, both generated from the current row and column counts and rebuilt on every add-row/add-column render. The labels are non-interactive and sit outside the card, so they never change the table layout. A right-edge handle (`data-sheet-add-column`) adds one empty column for every 80 px dragged to the right and removes columns when dragged left, while a bottom handle (`data-sheet-add-row`) adds one empty row for every 28 px dragged down and removes rows when dragged up. Removal checks the affected cells, and when any contain text `confirmAction` opens a modal before the mutation; all paths use `checkpoint()`/`markDirty("board")`. The corner resize grip resizes the sheet width and scales existing column widths proportionally. The divider between each pair of header labels is itself the drag target (`data-col-resize`), centred on the header border with a transparent 9 px hit area and an accent line on hover (its pointer events are enabled only while the sheet is selected or focused): dragging it updates one entry in `card.colWidths`, keeps the other columns at their stored pixel widths, and grows or shrinks `card.w` to the new sum. The `<colgroup>` and the header grid use the same pixel widths, so columns stay aligned.

Table cards keep a `cells` matrix of strings. The add control sits just outside the top-left corner
(`left: -30px`, `top: -28px`, clearing both header strips) and opens a menu with Add row and Add
column (`table-add-row` appends an empty row with the current column count, `table-add-column` appends
an empty cell to every row and widens the card by 80 px). The table card uses `overflow: visible` and
lifts its z-index on hover so the external buttons and menu are never clipped or hidden by
neighbours. Both actions go through `checkpoint()` and `markDirty("board")`, so they are undoable and
`measureHeights` resizes the card to the new row count. The menu closes on outside pointerdown or
Escape.

Board document:

```json
{
  "id": "b_xyz", "title": "Home", "updatedAt": 1793936443102,
  "grid": 24, "showGrid": true, "theme": "light",
  "view": { "x": 40, "y": -40, "zoom": 0.9 },
  "cards": [], "connections": [{ "id": "conn_1", "from": "a", "to": "b" }]
}
```

## Columns

A column is a card of type `column`. Cards whose `parentId` equals the column id are laid out by
`layoutColumn` in `model.js`: padding 14, gap 10, header 64. The layout writes child `x`, `y` and
`w`, then derives the column height from the children (header + child heights + gaps + padding); no
`extraHeight` empty space is kept. A vertical column's width drives the child width, and resized
aspect-ratio children (image, sketch, color) recompute their height. A row (`direction: "row"`)
derives its width from its children; dragging its corner grip scales every child width by the same
factor, so a row of kanban columns or a row of cards grows and shrinks together, and its height is
always the tallest child plus the header. Children are still independent cards in the same DOM layer,
painted above the column through the z-index scale. Their `.mn-resize` grip is hidden and
`onPointerDown` ignores the resize role for any card with a `parentId`, because the column owns their
width.

Columns also store a `collapsed` flag. When set, `layoutColumn` skips child positioning and clamps the
height to 96 px, and `applyGeometry` hides every child whose parent is collapsed. The small header
toggle (minus to collapse, unfold icon to expand) runs `checkpoint()` and `markDirty("board")`, so the
state is undoable and persisted; the header still shows the card/document summary while collapsed. With two or more cards selected, the context menu (and Ctrl+G) calls `wrapInColumn`: it creates a new column around the selection bounding box, assigns `parentId`/`order` in top-to-bottom order and lets the normal column layout take over.

The Color card opens `color-picker.js`, a compact HSV picker with no title: a saturation/value square with a marker, a vertical hue slider, a hex field, and OK/Cancel. There are no OK or Cancel buttons: every drag and every valid hex entry applies immediately, updating the swatch, HEX/RGB/CMYK rows and the auto name in place. The picker is positioned to the left of the card (falling back to the right only when there is no room); closing it by clicking the backdrop or pressing Escape keeps the live choice, the first change records a checkpoint, and `markDirty("save")` persists the result. `color-names.js` carries the Coolors color library entries; `colorNameForHex` returns the exact name when present and otherwise the closest entry by redmean RGB distance, and every color change writes that name into the card title field. Below the swatch, HEX, RGB and CMYK render as three stacked rows; each row reveals a copy button on hover and writes only the code value to the clipboard.

Embedded media: video cards turn YouTube (watch, youtu.be, shorts) and Vimeo links into iframes and fall back to a native `<video>` for direct media URLs; map cards parse a Google Maps `@lat,lng` link or `q` parameter (or accept a place name) and render a Google Maps embed iframe; audio cards play an uploaded asset or a pasted remote URL with a native `<audio>` control. Empty states use compact padding and a full-width soft primary action (Submit for video and map, Upload for audio); the Submit action reloads the embed from the current field value. Video, audio and map cards all start at 300 px wide; video and map are content-driven heights (they are no longer in `CARD_ASPECTS`), so their empty states measure the same 135 px content box and stay identical. A loaded video iframe uses a 16:9 aspect ratio and a loaded map iframe uses a fixed 170 px height. Uploaded images set `card.aspect` from the natural image ratio and `cardHeightFor` adds the 24 px caption strip, so the image is contained without cropping. Audio uses a fully custom player (`.mn-audio`) over a hidden `<audio>` element: play/pause, current and total time, a themed range seek bar, mute and edit buttons all call the media element directly, while `timeupdate`, `durationchange`, `play`, `pause`, `ended` and `volumechange` update the icons, time label and seek progress. `.mn-card-audio` drops the global 70 px card minimum so the 44 px player fills the card without a bottom gap. `layoutColumn` also exempts audio children from its 56 px minimum, so an audio card keeps its 44 px height and the column gap after it stays equal to the normal 10 px spacing. Loaded video and map iframes use `pointer-events: none`, so a pointer down anywhere on the preview reaches the card and starts the normal drag gesture; direct video and audio controls remain interactive. Video, map and audio previews keep an edit button that reopens the URL field. The webview window enables native Tauri drag and drop. `file-drop.js` listens for `tauri://drag-enter/over/leave/drop`, shows a dashed drop overlay, converts the physical drop position back into world coordinates, and routes each absolute path by extension: common images become image cards, audio and video use their media cards, raw formats fall back to file cards, and every other document (PDF, office, archive) becomes a file card. `store_asset_from_path` reads the dropped file, sanitises and stores it under the assets directory with an `assets` row, so opening and Download work exactly like picked uploads.

Map, Video and Audio are temporarily disabled as tools. Their cards still render and embed exactly as described above, but the tool rail, command palette, single-key shortcuts and the drag-to-canvas path refuse to create new ones, and Settings > Tools lists them with a disabled status. `limits.js` owns that policy in `TEMPORARILY_DISABLED_TOOLS` and `toolDisabledReason`. Local media is uploaded through the Upload tool, which routes an image, audio or video file to its card and any other file to a file card. Link cards fetch a hero image from Open Graph metadata; YouTube links resolve to `https://img.youtube.com/vi/<id>/{maxresdefault,hqdefault}.jpg` directly, so a watch page that answers with a consent screen cannot block the hero.

File cards render an inset hover row and a direct download button that appears on hover; both that button and the `Download asset` context-menu item call the same `downloadCardAsset` path. Clicking the card itself calls the Rust `open_path` command, which validates that the file exists and launches it with the system default application. Any uploaded asset card exposes a context-menu Download action backed by `download_asset`: it only accepts files inside the app assets directory, restores the original filename from the `assets` table, copies to the system Downloads folder, and appends " (n)" when a file with that name already exists. Internet is required only for the external embeds.

Connections are pure annotation: each entry stores optional `from`/`to` card ids plus optional free `fromPoint`/`toPoint` world points and an optional quadratic `curve` control point. `renderConnections` draws one SVG path per pair in a 200000 px layer offset by -100000 with a matching `viewBox`, so paths use world coordinates directly. With the Line tool, dragging from a card, column, board card or empty canvas point to another point creates a line; endpoints snap to the nearest card edge within 26 world px and otherwise stay as free canvas points. Only the selected line renders endpoint handles (drag to reattach or detach) and a midpoint handle (drag to bend the path); unselected lines show just the arrow. Without a curve the path is a straight line. Lines are selectable and deletable, and never change card geometry, grouping or layout.

Z-index is `card.z * 1000` for top-level cards and `column.z * 1000 + 1 + order` for children. The
1000 multiplier leaves room for child ordering while keeping CSS integer z-index values, which CSS
ignores only if fractional.

## Persistence

Storage is SQLite (`%APPDATA%\com.dezuhan.khaoyunote\khaoyu-note.db`, WAL mode) through `rusqlite`
with the `bundled` feature. On first launch, data from the pre-rename app folder is copied, integrity
checked and moved into the current folder. The document shape is unchanged on the frontend; the Rust
layer splits a board document into rows and reassembles it, so the API stays `load_board -> JSON
string` and `save_board <- JSON string`.

Schema (`meta` holds the schema version):

| Table | Columns |
| --- | --- |
| `boards` | `id`, `title`, `parent_id`, `created_at`, `updated_at`, `view` (JSON), `grid`, `show_grid`, `theme`, `archived_at`, `trashed_at`, `trash` (JSON) |
| `cards` | `id`, `board_id` (FK cascade), `type`, `parent_id`, `x`, `y`, `w`, `h`, `z`, `ord`, `data` (full card JSON) |
| `connections` | `id`, `board_id` (FK cascade), `from_id`, `to_id`, `data` |
| `assets` | `id`, `name`, `path`, `created_at` |

Cards keep their full JSON payload in `data` while geometry is duplicated in real columns, so a board
round trips without loss and geometry stays queryable. Saving a board runs in one transaction:
upsert the board row, delete and reinsert its cards and connections, commit.

Rust commands in `app/src-tauri/src/lib.rs`:

| Command | Effect |
| --- | --- |
| `list_boards` | select boards ordered by `updated_at`, returns `{id, title, parentId, updatedAt}` |
| `load_board(id)` | assemble the document from `boards` + `cards` + `connections` |
| `save_board(id, data, baseUpdatedAt)` | parse JSON, validate the id and the unchanged `updatedAt`, write all rows in one transaction |
| `delete_board(id)` | delete the board and its descendant boards, cards and connections |
| `store_asset(name, base64)` | decode, write under `assets/`, record the asset row |
| `export_board(data)` | write a timestamped JSON export into `Documents/Khaoyu Note` |
| `app_data_dir` | report the data folder to the settings modal |

`open_path` only accepts files inside the assets directory, the same rule `download_asset` already
enforced. Both `open_path` and `open_external` call ShellExecuteW on Windows (or `xdg-open` / `open`
elsewhere), never `cmd /C start`, so an `&` in a link or file name cannot inject a second command.

On first launch after upgrading from the JSON version, `migrate_legacy` imports every
`boards/*.json` file into the database and renames the folder to `boards-json-backup-<timestamp>`.
The migration is guarded by `meta.schema_version`.

The frontend autosaves on a short throttle: 80 ms on the web host, 250 ms in the desktop app and
120 ms for remote workspace boards, so typing is persisted without a five second wait. It flushes
immediately when switching boards, when the window loses focus, when the tab becomes hidden and on
`beforeunload`. Remote boards additionally capture each diff into a durable per-operation queue
(`app/web/js/sync-store.js`, IndexedDB) before the push, which is what makes offline edits and a
reload safe.
`saveNow` clears the dirty flag before writing, so the indicator can still report changes that arrive
mid-save; in that case a follow-up save is scheduled instead of being dropped. The asset protocol is
enabled for `$APPDATA/**` and `$APPLOCALDATA/**` so images can be displayed by path without turning
the webview into a general file reader.

Saves send the `updatedAt` value they loaded as `baseUpdatedAt`. `write_doc_checked` compares it with
the stored row and refuses a stale write, so the app, a second window and the MCP server cannot
silently overwrite each other. On a conflict the UI offers "Load newer version" (reload from disk) or
"Keep my version as a copy" (save the local document as a new board), and the local version is never
discarded without that choice. Failed saves keep their dirty flag and retry with capped backoff, and
the SQLite connection uses a 5 second busy timeout because the MCP binary shares the database.

A staged restore is validated before it is applied: the backup must contain the expected tables, pass
`PRAGMA integrity_check` and not use a newer schema. `apply_pending_restore` copies the backup to a
staging file, copies the current database and assets to `backups/pre-restore-<timestamp>`, and only
then swaps the files. If anything fails, the current data stays in place, the marker is parked as
`restore-failed-<timestamp>.txt`, and the app still starts instead of entering a boot loop.

All new timestamps are milliseconds. On open, `normalize_timestamps` multiplies any legacy
second-sized `created_at`, `updated_at`, `archived_at`, `trashed_at` or asset timestamp by 1000, so old
rows sort together with new ones. The legacy JSON importer keeps the `boards/` folder and skips the
completion marker when any file fails, so a broken file is retried on the next launch instead of being
hidden inside a rename. Backup, export and pre-restore names use `unique_path`, which appends `-1`,
`-2` and so on rather than colliding within the same millisecond.

At boot the app reopens `mn.lastBoard` only when that board still exists and is neither trashed nor
archived. Otherwise it picks the first root project that is not trashed, preferring an unarchived one;
a nested board is opened only when it was the remembered last board. Deleting the open board uses the
same rule, so a trashed or nested board is never chosen just because it is newest.

## Settings and GPU acceleration

Preferences are stored in the `meta` table (`ui_settings` as one JSON object, plus
`gpu_acceleration` as its own key). The dialog borrows the Photon preferences structure (dark header,
search field, category rail, scrolling content pane, Reset and Done) but keeps only what this app
actually uses: Account (profile picture, first and last name, email, password, Save and Cancel), Server
(local runtime details plus service connection, passkeys and sharing pages), Backup (back up now,
export ZIP, open folder), General (language, autosave, clipboard export, image interpolation,
board export), Appearance (theme, reduce motion, Heading/Body/Code font, grid size, grid visibility,
zoom reset), Tools (show or hide rail tools), Performance (GPU acceleration), MCP (server path,
transport, database, copyable client config) and About (version, storage, data folder, board counts).
The cosmetic options from the reference window (integrations, scratch disks, plug-ins, units,
history log) were dropped.

Hiding a tool in Settings only removes its rail button: the card type stays available and existing
cards keep rendering. That is separate from `TEMPORARILY_DISABLED_TOOLS` in `limits.js`, which
switches a feature off. A temporarily disabled card type is filtered by `visibleCards` and does not
render, lay out inside a column, appear in a board preview, accept a marquee selection, or seed a
template. The cards stay in the board document so re-enabling the feature restores them, and Upload
routes local audio or video to a file card while those types are disabled.

GPU acceleration is applied at window creation, not from JavaScript. `run()` reads
`gpu_acceleration` from SQLite before building the window and, when it is false, passes
`additional_browser_args("--disable-gpu --disable-gpu-compositing")` to `WebviewWindowBuilder`. The
window is therefore created programmatically instead of from `tauri.conf.json`. The settings dialog
writes both the JSON preference and the dedicated key, then offers "Restart app" through a
`restart_app` command. Verified by inspecting the spawned `msedgewebview2.exe` command line, which
contains both flags while the toggle is off.

The window is built with `drag_and_drop(true)`, so files dragged from Explorer become OS drops handled
by `file-drop.js`. Internal drags (tool rail and board cards) use pointer events instead
of HTML5 drag: a `pointerdown` arms the drag, movement past a threshold creates a floating ghost and
drop preview, `elementFromPoint` resolves the target, and `pointerup` creates the card or reorders the
tools. Internal drags therefore never depend on HTML5 `dragstart` firing from a button.

The Performance pane also reports what is actually running, so the toggle is not a blind switch:
`probeGpu()` creates a throwaway WebGL2 context and reads `WEBGL_debug_renderer_info`
(`UNMASKED_RENDERER_WEBGL`, `UNMASKED_VENDOR_WEBGL`, `VERSION`), `probeCpu()` reads
`navigator.hardwareConcurrency`, `navigator.deviceMemory` and the platform, and the user agent
supplies the WebView2/Chromium version. The pane shows "Current mode" from the stored preference
(GPU hardware or CPU software rendering), so a pending restart is visible: the preference already
says CPU while the live WebGL string still reports the hardware renderer until the restart. Long
renderer strings are ellipsised with a `title` tooltip.

The frontend also mirrors the settings JSON into `localStorage` so modules that cannot wait for an
async invoke (the autosave decision in `store.js`) can read it synchronously.

The tool rail order and visibility are settings too (`toolOrder`, `hiddenTools`). Rail buttons are
HTML5 draggable: `dragstart` stores the tool key, `dragover` highlights the insertion target, and
`drop` calls `saveToolOrder`, which persists and rebuilds the rail through the settings-changed
event. The hover target is a fixed 44 px square so the whole icon plus label lights up as one tile. Each button also opens an instant custom tooltip (no native title delay) anchored to its right: the label plus a key-cap shortcut chip slide in from the left, and the same single keys activate the tools when the canvas is focused and no inline editor is open.

The same drag can also leave the rail and land on the canvas. The viewport accepts
`application/x-mn-tool` drops (`effectAllowed: copyMove`), shows a floating tool label plus a dashed
preview of the card size at the pointer, and creates the card at that world point. Board, document,
image and line tools get their own behaviour (nested board at the point, editor opened, file picker,
toast for line). This keeps rail reordering and canvas creation on one drag gesture: dropping on a
rail button reorders, dropping on the canvas creates.

## Update check

`app/web/js/update.js` compares the installed version with the latest published GitHub release of
`dezuhan/khaoyu-note`. It exposes the pure helpers `normalizeVersion`, `compareVersions` (semver with
prerelease ordering), `parseRelease` and `evaluateRelease`, so the version logic is testable without a
network. `update-ui.js` runs the check at startup and then every hour, shows the release notes in a
modal, and listens for the `mn:check-updates` event raised by Help > Check for updates and Settings >
About. A release that the user already dismissed is not shown again automatically; the dismissed
version lives in `mn.update.dismissed` and the last result in `mn.update.cache`.

The host side is a Rust `check_update` command and the same command in `server.mjs`, so the desktop app
and the local web host behave the same. Both call
`GET https://api.github.com/repos/dezuhan/khaoyu-note/releases/latest` with a Khaoyu user agent, an 8
second timeout, a 1 MB response cap and the GitHub JSON media type. A 404 means no release has been
published yet, 403 and 429 report the GitHub rate limit, and any other status is an error. The current
version comes from a separate `app_version` command (the Cargo package version on desktop, the root
`package.json` version on the web host). The check never downloads an installer: it only opens the
release page with the existing external-link command.

## Automatic backups

Settings > Backup stores `autoBackupDays` in the `ui_settings` JSON. Off is `0`; the offered intervals
are 1, 3, 7, 14 and 30 days, where 30 is labelled as one month. `app/web/js/auto-backup.js` keeps the
last backup timestamp in the `meta` table under `auto_backup_last_at`, so the desktop app and the local
web host share one schedule even when both are open. It checks shortly after boot and every 15 minutes
while the app stays open; when the interval has elapsed it calls the existing `backup_data` command (a
`VACUUM INTO` snapshot plus an assets copy) and records the new time.

A missed interval is caught up on the next launch because the desktop process does not run while the
window is closed. A manual backup or Export ZIP resets the timestamp so an automatic backup does not
duplicate it. A failed backup keeps the previous timestamp, so it is retried on the next check. Old
backup folders are not pruned yet; the Backup pane says so and retention is listed in
`docs/blockers.md`.

## Local accounts

Milestone M1 adds local accounts to the app database, schema version 3. The new tables are `users`,
`sessions` and `activity_log`; `boards` and `cards` gain `created_by` and `updated_by` columns that
hold `{"source":"local","id":"...","name":"..."}` snapshots. Existing databases are migrated with
idempotent `ALTER TABLE` checks, and `server.mjs` applies the same migration so both hosts stay
compatible.

`app/src-tauri/src/auth.rs` owns password hashing (`pbkdf2-sha256`, 600000 iterations, versioned
format), random tokens, session validation, activity rows and the admin bootstrap. Tauri commands
`auth_status`, `auth_setup_admin`, `auth_login`, `auth_logout`, `auth_logout_all`, `auth_me`,
`auth_update_profile`, `auth_change_password`, `auth_history`, `auth_restore_session` and
`auth_log_activity` back the UI. The desktop host keeps the session token in `session.json` under the
app data folder only when Stay signed in is ticked. The web host exposes the same operations as
`/api/auth/*`, with HttpOnly `khaoyu_local_session` and `khaoyu_local_csrf` cookies, a CSRF header for
authenticated mutations, a 30 day session and login rate limiting. The web host accepts
`owner@localhost` as an email because the account is local.

`save_board` resolves an optional signed-in account, rejects viewers and commenters when a session is
present, and writes author snapshots through `write_doc_checked_with_author`. This local-first deploy
does not require an account: guest writes are accepted by the desktop and the web host command bridge,
and attribution is recorded only for an existing session. Backups copy
the database and assets but delete `sessions` from the snapshot with `secure_delete` before returning.

The frontend keeps auth state in `auth.js`, but the first-run setup/login gate is disabled. The avatar
button and Settings > Account are hidden; board and settings work without an account. The optional
account code remains for a future milestone, including Delete Account, but is not reachable from the
current UI. `bridge.js` calls Tauri commands on the desktop and the HTTP
endpoints on the web host.

## Web host

`server.mjs` serves the same `app/web` frontend on `http://127.0.0.1:1430` and opens the same
`khaoyu-note.db` and `assets/` folder as the desktop app. It runs on Node 24 or newer because it uses
the built-in `node:sqlite` module instead of a second database engine. Since the backup archive uses
`fflate`, a checkout needs `npm install` once before `npm run web`.

The host binds to `0.0.0.0` by default so devices on the same network can reach it, while the local
URL stays `http://127.0.0.1:<port>`. It collects the non-internal IPv4 addresses for the share list and
accepts `KHAOYU_WEB_PUBLIC_URL` for a public or DDNS origin. The address bar keeps a full board URL
(`/?board=<id>`), so copying it from the header or from the Share panel opens the same board after
sign-in. `GET /api/share-info` returns the share URLs and board path to the authenticated frontend.

The host injects a small runtime into `index.html`: `window.__KHAOYU_WEB__` carries the mode, host,
bind address, port, share URLs, database path and version, while `window.__TAURI__` is a shim whose
`core.invoke` forwards commands to `POST /api/invoke` and whose `core.convertFileSrc` maps asset paths
to `/api/asset?path=...`. The existing frontend therefore runs unchanged, with the same save guard,
conflict handling and asset flow.

Routes: `/api/events` (session-authenticated SSE for cross-tab board refresh), `/` and the static
frontend, `/api/invoke` for the whitelisted board, settings and asset
commands, `/api/asset` and `/api/download` for validated files under `assets/`, `/api/share-info` for
full board URLs, and `/status` for host, port, database, uptime, version and Node version. The command
bridge, assets and downloads require a signed-in session. Set `KHAOYU_WEB_HOST=127.0.0.1` to keep the
host local-only.

The browser cannot receive absolute OS drop paths or start the stdio MCP binary. Both remain
desktop-only; the browser uses the file picker for uploads.

## Self-hosted service foundation

`service/` is a standalone Node 24 process for the Milestone 1 self-hosted foundation. It loads
configuration from `KHAOYU_SERVICE_*` environment variables, refuses to start when the secret is
missing, short, repetitive or a placeholder, and fails when a migration is pending.

The service is moving to a team backend with PostgreSQL as the system of record and Redis for
cross-instance realtime coordination. The storage adapter, configuration and Compose services are in
progress; the decision record and rollout phases are in
[backend-postgres-redis.md](backend-postgres-redis.md). The desktop app and local web host stay on
SQLite.

The SQLite schema covers accounts, sessions, projects, project memberships, project snapshots, audit
rows and content-addressed objects. Migrations live in `service/src/migrations` as paired up and down
SQL files and are recorded in `schema_migrations`; the server never migrates automatically. Accounts
carry a global `role` (`admin` or `member`), `status` (`active` or `disabled`), optional names and an
avatar. Migration 13 promotes the oldest account to admin; a fresh database makes the first registered
account or bootstrap account admin.

The service now starts two listeners instead of one. A frontend listener serves the browser pages and
proxies `/api`, `/healthz` and `/readyz` to a backend listener; the backend only answers API and health
requests. Both ports are chosen from the free 5-digit range 20000 to 59999, are guaranteed distinct,
can be fixed with `KHAOYU_SERVICE_FRONTEND_PORT` and `KHAOYU_SERVICE_BACKEND_PORT`, and are written to
`<data>/runtime.json`. The frontend proxy keeps cookies, CSRF and the public URL on one browser origin.
`npm run start:background` launches the pair detached with logs under `<data>/logs`; `npm run stop`
uses the runtime PID.

The service serves browser pages at `/login`, `/register`, `/reset`, `/passkeys`, `/s/:token` and
`/admin`; `/shares` redirects to `/admin#sharing` because sharing is a section of the dashboard. Login, signup and reset are separate centred auth cards using `ky.css` and
`auth.css`; reset uses the current password and has no email-token step. `/account` redirects to
`/admin`, where the Account section handles password changes, sessions, API tokens and sign out. The
admin page uses the normal account session, requires the global admin role and calls
`/api/v1/admin/dashboard`, `/users`, `/teams` and `/activity`; every mutation goes through the same
CSRF check and writes `admin.*` audit rows. The page keeps the left navigation rail and adds a top
menu bar (Dashboard/Help, command search, theme toggle and a circular account menu) above the content
pane, reuses the main app logo, SVG icon set and fonts, uses `ky.css` tokens for light and dark
themes, and shows profile pictures or initials, role and status. The
operator `KHAOYU_SERVICE_ADMIN_TOKEN` remains only for scripted access to the legacy JSON admin
endpoints.

Object storage writes `sha256` content under opaque two-level paths and deduplicates by hash. Audit
rows store an HMAC of the IP address, never the raw address. The worker prunes old temp files and
audit rows, creates a consistent `VACUUM INTO` backup on its interval and enforces backup retention.
Restore verifies the manifest checksum and database integrity, keeps a `restore-previous-*` copy and
rolls back if the replacement fails.

`GET /healthz` and `GET /readyz` return only a status and no version, database path or configuration.
The service listens on one port and binds to loopback by default. Docker Compose runs it as
non-root, with a read-only root filesystem, no capabilities and a writable `/data` volume. Client
sync, login and sharing are intentionally absent until Milestones 2 to 4.

## Authentication and sessions

`service/src/auth` implements the Milestone 2 account core. Passwords use Argon2id with a per-user
salt. Email addresses are normalized to lowercase and unique. Registration queues a verification
token; login is refused until the account is verified. Tokens for verification and reset are random,
single use, short lived and stored as SHA-256 hashes.

Login creates a session family with a 15 minute access token and a 7 day rotating refresh token.
Every refresh marks the old token used and writes a replacement. Replaying an already used or
revoked refresh token revokes the whole family. Session rows carry device, IP hash and user agent;
access and refresh tokens are hashed at rest. Cookie authentication requires the double-submit CSRF
header for writes, while bearer access tokens skip that check. Login failures are counted per email
and IP with a fixed window, a progressive `Retry-After` and a structured warning event.

TOTP uses a base32 secret, SHA-1 HMAC, six digits and a 30 second period with one step of clock
skew. Scoped API tokens use the `khn_` prefix, are stored hashed, grant `projects:read` or
`projects:write`, and cannot manage sessions or account settings. Account deletion is scheduled with
a grace period, can be cancelled, exports account, project metadata and accessible snapshots first, and
is purged by the worker when due. Verification and reset mail is written to a mode `0600` outbox because an SMTP
adapter is still pending.

## Sharing and membership

`service/src/sharing.mjs` implements Milestone 3. A project keeps `public_sharing_enabled` off by
default. Share links are scoped to a project, one item, or one column and store only a SHA-256 token
hash; the raw token is returned once. Links support expiry, optional Argon2id passphrases,
revocation, rotation and per-link/IP attempt limits. Public access returns a neutral 404 for
invalid, expired, revoked, rotated or wrong-passphrase tokens, sets `X-Robots-Tag: noindex`, audits
the link id and IP hash, strips local asset paths and omits the trash. Item shares contain one card and
no project title; column shares contain the column and its current children with a notice about later
additions.

Project invitations are email-bound, single use, expiring and revocable; only an owner can create or
revoke one. Accepting an invitation adds the account with the invited role. Members are listed with
roles, roles can be changed by the owner, the owner cannot be removed directly, and ownership
transfer swaps both roles in one transaction. Share-token write permissions, asset download
watermarking and a global sharing kill switch remain pending.

Share links enforce view, comment, edit and manage by rank. Comment writes append `shareComments` to
a card inside the link scope, never to a sibling card, and edits are limited to a field allowlist
with an optional revision check. Each write creates a revision, emits a snapshot event, audits the
link and notifies owners.

## Operator admin

When `KHAOYU_SERVICE_ADMIN_TOKEN` is set, `/api/v1/admin/audit`, `/admin/abuse-reports` and
`/admin/stats` use a separate bearer token, a 60 requests per minute per-IP limit and audited export.
The admin token is independent from user sessions and API tokens. Unset means the routes do not
exist.

## Desktop sync

`app/web/js/sync.js` keeps the local board authoritative until the user enables sync for that board.
The sync control stores a service URL and a signed-in account, creates a server project on first
enable, pushes snapshots with the server revision and pulls when the server is ahead. Signing in uses
`POST /api/v1/auth/sync-token` with the account email and password; the service returns a scoped
project token that the client stores and never shows, revoking the previous sync token on each
sign-in. Both local and remote
changes produce an explicit conflict with Use server and Keep local choices. Failed pushes enter a
local queue and retry when online. Deleting or disabling a local board never deletes server data;
there is no server project delete call in the sync client.

`normalizeServerUrl` accepts a bare host or `host:port`, so a local service can be entered with its
printed frontend port, for example `127.0.0.1:29194` or `localhost:29194`. Loopback and private
addresses get an `http` scheme; any other
host defaults to `https`, and credentials in the URL are rejected. `checkServerReachable` calls
`/readyz` before credentials are sent, then `signIn` exchanges the email and password for the token,
and `checkConnection` uses an authenticated `GET /api/v1/projects` to prove the account and the
database round trip. The sync dialog, the first-run screen and the Account pane all render that state
(connected, unreachable, database not ready, sign in rejected, missing project access).
The desktop CSP allows `http://localhost:*` and `http://127.0.0.1:*` in `connect-src` for this path,
and the service snapshot route accepts documents up to 8 MB so real boards fit, while the smaller
account endpoints keep the 64 KB JSON body limit.

`service/src/http.mjs` and the API router accept bearer-token CORS preflight only from
`KHAOYU_SERVICE_CORS_ORIGINS`, with no credentials. The default list contains the Tauri origins and
the local web host (`http://127.0.0.1:1430`, `http://localhost:1430`), so both the desktop app and the
browser build can sync to a local service. The desktop token is stored in webview local
storage, which is documented as a residual risk in the security audit.

## Email delivery

`service/src/auth/mailer.mjs` selects SMTP when `KHAOYU_SERVICE_SMTP_HOST` is set and otherwise writes
mode `0600` JSON files to the outbox. SMTP uses `nodemailer`, optional username and password and
implicit TLS. Notification email is opt-in per account, includes a signed unsubscribe link, and is
rate limited to one per account per five minutes. Verification, reset and invitation mail remain
transactional.

## Notifications

`service/src/notifications.mjs` stores per-account notifications with a resource type and id.
Creation happens on invitation acceptance, role changes, revision restores and share reports.
Listing joins current project membership, so access changes hide old notifications immediately.
Share revocation and disabling project sharing remove their pending notifications. Read state is
filtered by account id on every update. Email delivery and unsubscribe preferences are not
implemented yet.

## Revision history and realtime events

Every accepted project snapshot writes a row to `project_versions`. Members can list the latest 100
revisions; editors and owners can restore one, which creates a new revision instead of rewriting
history. The worker trims older versions per project.

`service/src/events.mjs` keeps in-memory per-project rooms. `GET /api/v1/projects/:id/events` checks
membership before opening an SSE stream, emits presence counts and snapshot events, and sends a
heartbeat. Events are published only to the matching project room; server shutdown closes streams
before the listener. Offline queues and cursor or lock awareness are not implemented yet.

## MCP server

`app/src-tauri/src/bin/khaoyu-note-mcp.rs` is a second binary in the same crate. It links the same
`khaoyu_note_lib` storage layer used by the Tauri commands (`open_db_at`, `read_doc`, `write_doc`,
`list_board_meta`, `delete_board_tree`) and opens the same `khaoyu-note.db`, so an agent edits exactly
the data the app shows. WAL mode lets the app stay open while the server reads and writes.

Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout (MCP stdio transport). It implements
`initialize` (protocol version negotiation, tools capability, server info), `ping`, `tools/list`,
`tools/call`, plus empty `resources/list` and `prompts/list` responses for clients that ask. Tool
execution failures are returned as a normal result with `isError: true`, per the MCP convention; only
protocol failures use JSON-RPC errors. Logs go to stderr, never stdout.

Tools: `list_boards`, `get_board`, `get_board_json`, `get_card`, `search`, `list_comments`,
`create_board`, `update_board`, `delete_board`, `create_card`, `update_card`, `delete_card`,
`add_comment`, `connect_cards`. Writes load the board document, mutate it, and call
`write_doc_checked` in the same transaction the app uses, so the schema, validation and stale-write
guard stay in one place.

A configuration-only DSH bundle (`dsh-bundle-note-studio-mcp/`, package `@local/note-studio-mcp`) registers the server through `@deepseek-ai/dsh-mcp-client` with `serverName: khaoyu-note`, `transport: stdio` and `failOnStartupError: true`; the binary it points to is published under `%LOCALAPPDATA%\Khaoyu Note` so `cargo clean` cannot break the connection. The app Settings > MCP pane exposes the generic `mcpServers` JSON snippet with a Copy JSON button.

The database directory defaults to `%APPDATA%\com.dezuhan.khaoyunote` and can be overridden with
`KHAOYU_NOTE_DB_DIR` (used by `tools/test-mcp.mjs`, which spawns the binary against a temporary
folder).

## Board pages

Boards form a tree. A nested board card stores `boardId`, and the child document stores `parentId`.
The single-file header replaces the old Home link with a Template button; clicking it or the menu-bar logo opens the template library and the current file path continues in the breadcrumb. Multi-project Home is not reachable from the interface, and `templates.js` applies a starter by replacing the active board cards, connections and title in place after a checkpoint. If the board already contains cards, a confirmation dialog reports the card count and requires Overwrite before anything changes; Cancel keeps the board and leaves the library open. `home.js` remains in the tree but is dormant. The breadcrumb walks `parentId` through the board list, so a board can be reached from
any ancestor. Board cards render a mini preview of their child board: `preview.js` normalises the
child card coordinates into a dotted thumbnail, and `render.js` hydrates it asynchronously (cached per
board `updatedAt`) with a card count in the footer.

The home gallery uses the same painter for project cards and lists only root boards
(`parentId == null`); nested boards stay inside their project and are reached through board cards and
the breadcrumb. The `boards` table carries `archived_at` and `trashed_at` columns (added by an
idempotent `ALTER TABLE` migration for existing databases); `list_boards` returns them in each board
meta, so the gallery splits roots into Projects, Archive and Trash without loading every document.
The Back to board button calls `backToBoard`: it only shows the canvas when `state.board` still exists in the refreshed board list and is not trashed; otherwise it opens the first remaining root project, and when no projects remain it stays on Home with a toast. This prevents a deleted board from being rendered again from stale DOM. Renaming from the project menu calls `rename_board`, which updates only the title and `updated_at` (the app mirrors the new title into the open document). Home keeps a `selectedProjects` set: a checkbox on each card or Ctrl/Cmd/Shift click toggles selection, the bulk bar runs archive/unarchive, move to trash, restore or delete permanently, and Trash adds a Delete all action that empties every trashed root after a confirmation dialog. Archiving or trashing calls the dedicated `archive_board`/`trash_board` commands, which update only
those columns; `write_doc` round-trips the flags when a document contains them and preserves the
stored values when a stale document omits them. Permanent deletion still goes through the Rust
`delete_board` command, which walks the tree. Right-clicking a project (or a card / the canvas) emits
`mn:open-menu`; `ui.js` renders the Khaoyu grouped menu with shortcut labels, separators and disabled
styles. The canvas menu now creates every card type at the click point through `createToolFromDrop`:
New note, link, to-do, line, heading, board, column, comment, table, image and file, followed by Select
all and the zoom actions. The project menu offers Open, Archive/Unarchive, Move to trash, Restore and
Delete forever.

## Comments aggregation

Comment activity feeds the notification center in `notifications.js`: `comments-panel.js` collects each message with a stable message key and calls `ingestComments`, which appends a new unread notification only once per key and persists the list through the `ui_notifications` app setting. The top-bar bell shows the unread count; the panel supports per-item mark read or unread, remove, Mark all as read and Delete all, and clicking a notification opens its board and selects the comment card. Removed entries stay in storage as tombstones so the same comment is not recreated as a new notification.

Every comment message carries a `ts` value and renders `HH:MM, DD/MM/YYYY` beside the author through `time.js`; the same absolute timestamp replaces the relative label in the comments popup. Comment messages also carry an optional `done` flag and the card renders a small checkbox plus a three-dot menu per message; toggling done only mutes the text (no line-through), while the menu runs a `checkpoint()` delete. The comment badge in the top bar is a tree-wide count. `comments-panel.js` walks the board tree from
the current board (children located through `parentId` in the board list), reads the current board
from live state and the others from storage, and flattens every comment card message into one list
ordered by timestamp. Opening the popup re-collects the list; clicking an item opens its board,
selects the comment card and centres the viewport on it. The list refreshes on `board`, `boards` and
`save` events with a short debounce, so a comment sent seconds earlier is included before autosave has
even flushed.

## Nested radius rule

Rounded containers that contain rounded children follow one rule: the inner radius is the outer
radius minus the inset/padding, clamped at zero. Two examples used in the app:

- settings dialog: outer 16 px, inset 6 px, inner shell 10 px (`calc(16px - 6px)`)
- column: outer radius 7 px, inner padding 14 px, so the formula clamps to 0; child cards use a 4 px floor so their inner sheet corners stay soft instead of sharp

The rule is written directly in CSS (`calc(...)` and `max(0px, ...)`) next to each component so the
values cannot drift apart. Menu items and comment rows follow the same idea with their own popup
radius and padding.

## Undo

Undo is snapshot-based: before a structural gesture the store pushes `JSON.stringify(board)` onto a
stack capped at 120 entries. Drags take the snapshot at pointer-down, so a whole drag is one undo
step. This is simpler than a transaction-id scheme and is accurate for a single-user local app.

## Testing

- `scripts/check-web.cjs` parses every module with `vm.SourceTextModule` (run it with
  `node --experimental-vm-modules`) and verifies that every relative import resolves and every named
  import exists.
- `tools/test-ui.mjs` drives the running dev server with Playwright (Chromium). It exercises boot,
  card creation, editing, drag, horizontal-only resize, undo/redo, to-do, comments, tables, drag
  drop feedback, column drop, document editor, drawing editor, nested board breadcrumbs, the disabled
  Home state, zoom, settings with the custom select, theme switching, context menu and persistence.
- `tools/test-save-conflict.mjs`, `tools/test-save-retry.mjs`, `tools/test-board-selection.mjs`,
  `tools/test-rename.mjs`, `tools/test-board-card-title.mjs`, `tools/test-column-layout.mjs`,
  `tools/test-column-title.mjs`, `tools/test-tool-drop-column.mjs`,
  `tools/test-wrap-selection.mjs`, `tools/test-tooltips.mjs`, `tools/test-line-area.mjs`,
  `tools/test-card-features.mjs`, `tools/test-web-mode.mjs` and `tools/test-fonts.mjs` cover
  conflict resolution, failed-save retry, the boot board choice, the breadcrumb rename editor, the
  parent board card title, column layout after a nested board, the inline column title, dropping a tool straight into a column, the wrap-in-column guard, the
  code-block icon and design-system tooltips, the line snap distance and hit area, lock position,
  card conversions and sheet scrolling in a column, the localhost SQLite host and the variable-font
  weight ranges.
- `tools/test-mcp.mjs` exercises the stdio server against a temporary database.
- `tools/shots.mjs` and `scripts/screenshot.ps1` produce the screenshots used in the README.
- `tools/serve.mjs` serves `app/web` on port 1430 for browser preview and Playwright runs when the
  Tauri dev server is not running.


