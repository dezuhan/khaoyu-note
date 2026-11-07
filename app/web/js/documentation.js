// Offline documentation content shown from Help > Documentation.

export const DOCUMENTATION_HTML = `
<div class="mn-docs">
  <p class="mn-docs-lead">Khaoyu Note is a local-first board app. Boards stay on this device unless you
  explicitly enable server sync for a board.</p>

  <h3>Getting started</h3>
  <ul>
    <li>On first run choose Continue locally, Create account on your server, or Connect server with an API token.</li>
    <li>Double-click empty canvas to create a note.</li>
    <li>Pick a tool from the left rail, then click the canvas to place a card.</li>
    <li>Drag cards to move them. Shift-click or drag a marquee to select several cards.</li>
    <li>Duplicating or copying a column also copies the cards inside it, with parent links remapped.</li>
    <li>Use the toolbar above a selected card to style text, change color or convert a note to a document.</li>
    <li>Files are saved automatically after five seconds of inactivity.</li>
  </ul>

  <h3>Board access and sharing</h3>
  <p>The menu bar sits above the file header. The Share control in the header right corner opens the
  per-board access panel. Each board is not shared by default. Enable it with the warning, choose
  View only (default), Can comment or Can edit, and optionally add a password and expiry. Revoke links
  from the same panel. Right-click any card and choose Share link to share that item or column.</p>

  <h3>Board sharing links</h3>
  <ul>
    <li>Every board has individual access, default not shared and view only.</li>
    <li>Share a whole board from the header or one item or column from the context menu.</li>
    <li>Optional password protection is supported for shared links.</li>
    <li>Recipients open the read-only viewer at <code>/s/:token</code>.</li>
  </ul>

  <h3>Cards and tools</h3>
  <table>
    <tr><th>Tool</th><th>Behavior</th></tr>
    <tr><td>Note</td><td>Markdown-style text, bold, italic, lists and links.</td></tr>
    <tr><td>Document</td><td>Rich text with headings, lists and code blocks.</td></tr>
    <tr><td>Column</td><td>Groups cards. Drop a card into a column to make it a child.</td></tr>
    <tr><td>Board</td><td>Nested board card. Opens a separate local board.</td></tr>
    <tr><td>Comment</td><td>Threaded comments with checkboxes and replies.</td></tr>
    <tr><td>Table</td><td>Editable cells, rows and columns.</td></tr>
    <tr><td>Image / Upload</td><td>Local image or file asset stored with the board. Right-click an image and choose Crop image for a free crop.</td></tr>
    <tr><td>Link</td><td>URL card. A hero image is fetched automatically from the page metadata when available. Links without a hero image show a soft dotted globe fallback at the same 24px spacing as the board dots. Right-click for Add, Change, Crop or Remove header image.</td></tr>
    <tr><td>Audio</td><td>Upload MP3, WAV, M4A, AAC, OGG, Opus or FLAC, or paste a link. The edit action shows a clip-only upload button and Submit. Right-click for Play, Pause and a Repeat checkbox. A volume slider sits beside the mute button.</td></tr>
    <tr><td>Video</td><td>YouTube, Vimeo or a local video file. A centered circular play button starts the embed with autoplay. Playing embeds expose pause, mute and volume controls. Right-click for Play, Pause and a Repeat checkbox.</td></tr>
    <tr><td>Map</td><td>Google Maps link or place query.</td></tr>
    <tr><td>Line</td><td>Connect two cards. Select the line to add a midpoint curve.</td></tr>
  </table>

  <h3>Cropping images</h3>
  <p>Link cards fetch a hero image from the page metadata automatically. If the page has no hero image,
  a dotted globe fallback is shown. Right-click a header image and choose Crop header image, or
  right-click an image card and choose Crop image. The crop editor fits the whole image inside the
  dialog, then you can drag the frame to move it and drag any edge or corner for a free ratio. Fit to
  image resets the frame to the full image ratio. Apply crop stores the region with the card.</p>

  <h3>Media playback</h3>
  <p>Playing audio or video can be controlled from the right-click menu: Play, Pause and a Repeat
  checkbox. Video embeds also show pause, mute and volume controls over the player. Moving or resizing
  a card keeps an active YouTube, Vimeo, audio or map player alive instead of restarting it.</p>

  <h3>Keyboard shortcuts</h3>
  <table>
    <tr><td>Pan</td><td>Space + drag, middle drag or wheel</td></tr>
    <tr><td>Zoom</td><td>Ctrl + wheel or Ctrl + / -</td></tr>
    <tr><td>Undo / redo</td><td>Ctrl + Z / Ctrl + Shift + Z</td></tr>
    <tr><td>Select all</td><td>Ctrl + A</td></tr>
    <tr><td>Delete</td><td>Delete or Backspace</td></tr>
    <tr><td>Command palette</td><td>Ctrl + K</td></tr>
    <tr><td>Shortcuts list</td><td>?</td></tr>
  </table>

  <h3>Settings</h3>
  <p>Settings opens with Account at the top, then a divider, General, Appearance, Tools and
  Performance, then another divider, MCP and About. Language is part of General and Canvas is part of
  Appearance. Tools uses a two-column icon grid where clicking a card shows or hides that tool.
  Account links the service account, passkey and sharing pages and can open the server connection
  dialog. Account also has a Backup section: Back up now writes the local database, assets and
  settings to Documents/Khaoyu Note Backups, and Open folder opens the latest backup.</p>
  <p>The desktop app and the service pages share the same design tokens. Dialogs and popups with a
  translucent backdrop also blur the content behind them.</p>

  <h3>Server sync</h3>
  <p>Sync is opt-in per board. Open the Sync control in the topbar, enter the service URL and a scoped
  API token, then choose Enable for this board. The local board remains authoritative. Conflicts show
  a choice between keeping the local version or adopting the server version. Unsent changes wait in a
  local offline queue. Disabling sync never deletes server data.</p>
  <p>Create a token at <code>/account</code> in the service or run
  <code>node tools/create-service-token.mjs</code>.</p>

  <h3>Accounts, passkeys and sharing</h3>
  <ul>
    <li><code>/account</code>: register and sign in immediately, reset password, manage sessions and API tokens. Email verification is disabled and hidden.</li>
    <li><code>/passkeys</code>: register or use a WebAuthn passkey on a localhost or HTTPS deployment.</li>
    <li><code>/shares</code>: enable public sharing after an explicit warning, create project, card or
    column links, choose permission, expiry, passphrase and asset download permission.</li>
    <li><code>/s/:token</code>: read-only viewer used by people who receive a share link.</li>
  </ul>

  <h3>Self-hosted service</h3>
  <p>The service is optional. It stores accounts, project snapshots, assets, share links and audit
  records in SQLite under the configured data directory. Configure a strong
  <code>KHAOYU_SERVICE_SECRET</code>, terminate TLS at a reverse proxy, and set
  <code>KHAOYU_SERVICE_REQUIRE_HTTPS=true</code> for production. Backups can be encrypted with
  <code>KHAOYU_SERVICE_BACKUP_PASSPHRASE</code>. The operator admin API is disabled unless
  <code>KHAOYU_SERVICE_ADMIN_TOKEN</code> is set.</p>

  <h3>Privacy and safety</h3>
  <ul>
    <li>Local boards do not require an account.</li>
    <li>Public sharing is off by default and each link is limited to its scope.</li>
    <li>Search engines are excluded with noindex and share tokens are redacted from logs.</li>
    <li>Deleting a local board never deletes server data.</li>
    <li>Never forward a share link to someone who should not have access. A link is a bearer secret.</li>
  </ul>

  <h3>Testing interfaces</h3>
  <ul>
    <li><code>http://127.0.0.1:8080/account</code> for account flows.</li>
    <li><code>http://127.0.0.1:8080/passkeys</code> for WebAuthn.</li>
    <li><code>http://127.0.0.1:8080/shares</code> for share management.</li>
    <li><code>http://127.0.0.1:1430</code> for the local web build.</li>
  </ul>

  <h3>Troubleshooting</h3>
  <ul>
    <li>If a save conflict appears, choose the copy or reload option; never overwrite silently.</li>
    <li>If sync fails, check the service URL, token scopes and CORS origin.</li>
    <li>If a passkey cannot be created, use localhost or HTTPS and a browser with WebAuthn.</li>
    <li>Run <code>npm run test:service</code>, <code>npm run test:sync</code> and the browser suites to
    verify the current build.</li>
  </ul>

  <p class="mn-docs-foot">Full operator documentation is in the repository: service/README.md,
  docs/architecture.md, docs/security-audit.md, docs/packaging.md and docs/blockers.md.</p>
</div>
`;
