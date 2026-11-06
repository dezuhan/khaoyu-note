# Architecture

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Shell | Tauri v2 (Rust) | small binary, native WebView2, first-class Rust commands, cross-platform |
| Storage | SQLite via `rusqlite` (bundled) | single local database, transactions, queryable geometry; JSON boards from the first version migrate automatically |
| Frontend | vanilla ES modules | no build step: the webview loads the source directly, so dev iteration and Playwright tests need no bundler |
| Board rendering | DOM + CSS transforms | text editing, selection, accessibility and pixel fidelity for free |
| Drawing | Canvas2D per sketch card | strokes are simple polylines; Canvas2D needs no GPU setup |
| Design system | vendored token stylesheet (`ky.css`, `ky.js`) | user requirement: shared token language and component contract |

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
| `drawing` cards | vector freehand strokes stored as point arrays inside normal cards; selectable, movable and deletable, never reshaped |
| ROADMAP.md | planned self-hosted service, login, sharing scopes and security architecture; planning only |
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
`image`, `audio`, `video`, `map`, `file`, `board`, `column`, `kanban`. A column is a container whose
children point at it through `parentId`; that link is cleared when a card is dragged out of a column.
Link cards open through the Rust `open_external` command, which validates http(s) and launches the
system default browser instead of a WebView2 child window.

New Kanban cards are created with `fullWidth: true` and a width of the visible canvas minus 96 px, and their columns use `flex: 1 1 168px` so they spread across the full card instead of leaving an empty strip. Adding a column only grows the card when the content minimum exceeds its current width. Kanban cards keep a `columns` array, each with an `id`, a `title` and an `items` array of `{id, text}`. The card has no fixed aspect: its width is recomputed on every add/remove column (`20 + n * 168 + gaps`) and its minimum height is 500 px, also when the card is a child of a column (the column then grows around it). Every mutation (add/remove column, add/remove card, edit title) runs through `checkpoint()`/`markDirty("save")`. Kanban items use a pointer drag (not HTML5 drag): grabbing the grip creates a floating ghost, `elementFromPoint` resolves the target column, the vertical midpoint of the remaining rows computes the insertion index, and a drop line previews the position. Dropping reorders inside the same column, moves between columns, or moves to a column of another kanban card; the mutation checkpoints and re-renders. The MCP `create_card` tool accepts `type: "kanban"` and seeds Backlog/In progress/Done columns.

Freehand drawing is a normal card type (`drawing`) whose data is a normalized array of points and a fixed 3 px stroke width, rendered as an SVG path. The Draw tool captures pointer points into a preview SVG, then creates the card with a bounding box and `aspect` so it can be selected, moved and deleted like any other card, but never reshaped; Eraser hit-tests drawing cards and sends them to the board Trash. A fixed bottom `context-toolbar.js` shows Markdown-style commands (bold, italic, underline, strike, code block, bullet and numbered lists) while a note or heading is selected or edited, and switches to Move/Pen/Eraser while the Draw tool or a drawing card is active.

To-do items carry a burger handle beside the remove button; pointer drag reorders the items inside the card, showing a floating label and an accent drop line, and commits through `checkpoint()`/`markDirty("board")`.

Card deletion keeps a per-board `trash` array. `moveCardsToTrash` groups a column with its children, stores deep copies of those cards and any connections touching them, removes the cards/connections from the live board, and checkpoints; `restoreTrashEntry` re-adds the group (detaching a child only if its column was permanently removed) and `emptyTrashEntries` clears the list. The Trash tool deletes the current selection when there is one, otherwise it opens a modal listing every deleted group with Restore and Delete plus an Empty trash confirmation. The array is stored in a `trash` TEXT column on `boards`; `write_doc` preserves it when a stale document omits the field.

Auto height: `measureHeights` re-measures every card whose height is content driven (note, heading, link, todo, document, comment, table, board, audio, file) and `applyGeometry` leaves their CSS height unset so the DOM content decides it. Fixed-height types (image, video, sketch, map, color, column, kanban) use `CARD_ASPECTS` or their stored height instead. Mutations that change content without a full board re-render (adding or removing a todo item, sending a comment, editing a field) call `syncCardHeight`/`syncAutoHeight`, which also re-lays out a containing column so a growing child never overlaps the next card.

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
`layoutColumn` in `model.js`: padding 14, gap 10, header 64. When a column is clicked or dragged, its z-index is raised to the front; the same gesture also re-applies each child z-index so the column background never covers its children. The layout writes child `x`, `y` and
`w`, then grows the column height to fit. Children are still independent cards in the same DOM layer,
painted above the column through the z-index scale. Their `.mn-resize` grip is hidden and `onPointerDown` ignores the resize role for any card with a `parentId`, because the column owns their width.

Columns also store a `collapsed` flag. When set, `layoutColumn` skips child positioning and clamps the
height to 96 px, and `applyGeometry` hides every child whose parent is collapsed. The small header
toggle (minus to collapse, unfold icon to expand) runs `checkpoint()` and `markDirty("board")`, so the
state is undoable and persisted; the header still shows the card/document summary while collapsed. With two or more cards selected, the context menu (and Ctrl+G) calls `wrapInColumn`: it creates a new column around the selection bounding box, assigns `parentId`/`order` in top-to-bottom order and lets the normal column layout take over.

The Color card opens `color-picker.js`, a compact HSV picker with no title: a saturation/value square with a marker, a vertical hue slider, a hex field, and OK/Cancel. There are no OK or Cancel buttons: every drag and every valid hex entry applies immediately, updating the swatch, HEX/RGB/CMYK rows and the auto name in place. The picker is positioned to the left of the card (falling back to the right only when there is no room); closing it by clicking the backdrop or pressing Escape keeps the live choice, the first change records a checkpoint, and `markDirty("save")` persists the result. `color-names.js` carries the Coolors color library entries; `colorNameForHex` returns the exact name when present and otherwise the closest entry by redmean RGB distance, and every color change writes that name into the card title field. Below the swatch, HEX, RGB and CMYK render as three stacked rows; each row reveals a copy button on hover and writes only the code value to the clipboard.

Embedded media: video cards turn YouTube (watch, youtu.be, shorts) and Vimeo links into iframes and fall back to a native `<video>` for direct media URLs; map cards parse a Google Maps `@lat,lng` link or `q` parameter (or accept a place name) and render a Google Maps embed iframe; audio cards play an uploaded asset or a pasted remote URL with a native `<audio>` control. Empty states use compact padding and a full-width soft primary action (Submit for video and map, Upload for audio); the Submit action reloads the embed from the current field value. Video, audio and map cards all start at 300 px wide; video and map are content-driven heights (they are no longer in `CARD_ASPECTS`), so their empty states measure the same 135 px content box and stay identical. A loaded video iframe uses a 16:9 aspect ratio and a loaded map iframe uses a fixed 170 px height. Uploaded images set `card.aspect` from the natural image ratio and `cardHeightFor` adds the 24 px caption strip, so the image is contained without cropping. Audio uses a fully custom player (`.mn-audio`) over a hidden `<audio>` element: play/pause, current and total time, a themed range seek bar, mute and edit buttons all call the media element directly, while `timeupdate`, `durationchange`, `play`, `pause`, `ended` and `volumechange` update the icons, time label and seek progress. `.mn-card-audio` drops the global 70 px card minimum so the 44 px player fills the card without a bottom gap. `layoutColumn` also exempts audio children from its 56 px minimum, so an audio card keeps its 44 px height and the column gap after it stays equal to the normal 10 px spacing. Loaded video and map iframes use `pointer-events: none`, so a pointer down anywhere on the preview reaches the card and starts the normal drag gesture; direct video and audio controls remain interactive. Video, map and audio previews keep an edit button that reopens the URL field. The webview window enables native Tauri drag and drop. `file-drop.js` listens for `tauri://drag-enter/over/leave/drop`, shows a dashed drop overlay, converts the physical drop position back into world coordinates, and routes each absolute path by extension: common images become image cards, audio and video use their media cards, raw formats fall back to file cards, and every other document (PDF, office, archive) becomes a file card. `store_asset_from_path` reads the dropped file, sanitises and stores it under the assets directory with an `assets` row, so opening and Download work exactly like picked uploads.

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

The frontend autosaves 5 seconds after the last mutation (idle debounce), and flushes immediately when
switching boards, when the window loses focus, when the tab becomes hidden, and on `beforeunload`.
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
actually uses: General (autosave, clipboard export, image interpolation, board export),
Appearance (theme, reduce motion plus Heading/Body/Code font), Canvas (grid size, grid visibility,
zoom reset), Tools (show or hide rail tools), Performance (GPU acceleration), About (version, storage,
data folder, board counts) and MCP (server path, transport, database, copyable client config). The
cosmetic options from the reference window (account, integrations, scratch disks, plug-ins, units,
history log) were dropped.

GPU acceleration is applied at window creation, not from JavaScript. `run()` reads
`gpu_acceleration` from SQLite before building the window and, when it is false, passes
`additional_browser_args("--disable-gpu --disable-gpu-compositing")` to `WebviewWindowBuilder`. The
window is therefore created programmatically instead of from `tauri.conf.json`. The settings dialog
writes both the JSON preference and the dedicated key, then offers "Restart app" through a
`restart_app` command. Verified by inspecting the spawned `msedgewebview2.exe` command line, which
contains both flags while the toggle is off.

The window is built with `drag_and_drop(true)`, so files dragged from Explorer become OS drops handled
by `file-drop.js`. Internal drags (tool rail, kanban cards and board cards) use pointer events instead
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

## Web host

`server.mjs` serves the same `app/web` frontend on `http://127.0.0.1:1430` and opens the same
`khaoyu-note.db` and `assets/` folder as the desktop app. It needs only Node 24 or newer because it
uses the built-in `node:sqlite` module, not a second database engine.

The host injects a small runtime into `index.html`: `window.__KHAOYU_WEB__` carries the mode, host,
port, database path and version, while `window.__TAURI__` is a shim whose `core.invoke` forwards
commands to `POST /api/invoke` and whose `core.convertFileSrc` maps asset paths to
`/api/asset?path=...`. The existing frontend therefore runs unchanged, with the same save guard,
conflict handling and asset flow.

Routes: `/` and the static frontend, `/api/invoke` for the whitelisted board, settings and asset
commands, `/api/asset` and `/api/download` for validated files under `assets/`, and `/status` for
host, port, database, uptime, version and Node version. The host binds to loopback by default; set
`KHAOYU_WEB_HOST` only when the network exposure is intentional.

The browser cannot receive absolute OS drop paths or start the stdio MCP binary. Both remain
desktop-only; the browser uses the file picker for uploads.

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
  `tools/test-column-title.mjs`, `tools/test-kanban-scroll.mjs`, `tools/test-tool-drop-column.mjs`,
  `tools/test-wrap-selection.mjs`, `tools/test-tooltips.mjs`, `tools/test-line-area.mjs`,
  `tools/test-card-features.mjs`, `tools/test-web-mode.mjs` and `tools/test-fonts.mjs` cover
  conflict resolution, failed-save retry, the boot board choice, the breadcrumb rename editor, the
  parent board card title, column layout after a nested board, the inline column title, kanban
  scrolling inside a column, dropping a tool straight into a column, the wrap-in-column guard, the
  code-block icon and design-system tooltips, the line snap distance and hit area, lock position,
  card conversions and sheet scrolling in a column, the localhost SQLite host and the variable-font
  weight ranges.
- `tools/test-mcp.mjs` exercises the stdio server against a temporary database.
- `tools/shots.mjs` and `scripts/screenshot.ps1` produce the screenshots used in the README.
- `tools/serve.mjs` serves `app/web` on port 1430 for browser preview and Playwright runs when the
  Tauri dev server is not running.


