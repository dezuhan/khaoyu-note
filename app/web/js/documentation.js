// Offline documentation shown from Help > Documentation. The content is split into sections and the
// shell renders a Settings-like left navigation with the section body on the right.

export const DOCUMENTATION_SECTIONS = [
  {
    id: "start",
    label: "Getting started",
    html: `
      <p class="mn-docs-lead">Khaoyu Note is a local-first board app. Boards stay on this device unless
      you explicitly enable server sync for a board.</p>
      <ul>
        <li>On first run create the local admin account, then sign in on later launches. An account is
        required so board and account activity is attributed.</li>
        <li>Double-click empty canvas to create a note. Pick a tool from the left rail, then click the canvas to place a card.</li>
        <li>Drag cards to move them. Shift-click or drag a marquee to select several cards.</li>
        <li>Duplicating or copying a column also copies the cards inside it, with parent links remapped.</li>
        <li>Use the toolbar above a selected card to style text, change color or convert a note to a document.</li>
        <li>Files are saved automatically five seconds after the last change. Ctrl + K opens the command palette.</li>
      </ul>
    `,
  },
  {
    id: "boards",
    label: "Boards and cards",
    html: `
      <h3>Cards and tools</h3>
      <p><strong>Temporarily disabled:</strong> Map, Video and Audio cards are hidden from boards,
      columns, previews and templates while the feature is off. The data stays in the document, so the
      cards return when the feature is re-enabled. They are still listed in Settings &gt; Tools with a
      disabled status. This is different from hiding a tool in Settings, which only removes the rail
      button and leaves the feature available. Upload local media with the Upload tool; while audio or
      video is disabled, those files become file cards.</p>
      <table>
        <tr><th>Tool</th><th>Behavior</th></tr>
        <tr><td>Note</td><td>Markdown-style text, bold, italic, lists and links.</td></tr>
        <tr><td>Document</td><td>Rich text with headings, lists and code blocks, opened full page.</td></tr>
        <tr><td>Heading</td><td>Editorial serif heading card.</td></tr>
        <tr><td>To-do</td><td>Checklist with reorder by dragging the burger handle.</td></tr>
        <tr><td>Comment</td><td>Threaded comments with per-message done state and delete.</td></tr>
        <tr><td>Table</td><td>Editable cells, resizable columns, Add row and Add column.</td></tr>
        <tr><td>Column</td><td>Groups cards; drag cards in and out, collapse and expand.</td></tr>
        <tr><td>Section</td><td>Pastel background surface with a small title. Always below cards, not a column, with a bottom swatch and position-lock toolbar.</td></tr>
        <tr><td>Board</td><td>Nested board card with a mini preview, opened in place.</td></tr>
        <tr><td>Kanban</td><td>Columns and cards with pointer drag between columns.</td></tr>
        <tr><td>Color</td><td>HSV picker with HEX, RGB, CMYK and an automatic color name.</td></tr>
        <tr><td>Sketch / Draw</td><td>Canvas sketch card, plus a full page drawing editor.</td></tr>
        <tr><td>Image / Upload</td><td>Local image or file asset. Upload also accepts local audio and video files.</td></tr>
        <tr><td>Link</td><td>URL card with a fetched hero image and an open button.</td></tr>
        <tr><td>Line</td><td>Connects two cards, with draggable endpoints and a midpoint curve.</td></tr>
      </table>
      <h3>Editing</h3>
      <ul>
        <li>Right-click a card for Share link, Lock position, Download asset, Cut, Copy, Paste, Duplicate and Delete.</li>
        <li>Convert a note to a document, or a column to a nested board, from the same menu.</li>
        <li>Deleting sends cards to the per-board Trash, where they can be restored or emptied.</li>
        <li>Undo and redo use whole-board snapshots, so a whole drag is one undo step.</li>
      </ul>
    `,
  },
  {
    id: "media",
    label: "Images and media",
    html: `
      <h3>Uploading files</h3>
      <p>The Upload tool is the single entry point for local media. An image becomes an image card, an
      audio file an audio card, a video file a video card, and any other file a file card. While the
      audio or video card type is temporarily disabled, those files are stored as file cards so the
      asset stays visible. Uploads are
      capped at 100 MB and executable or script extensions are blocked. Dropping files from the
      operating system uses the same path in the desktop app.</p>
      <h3>Hero images and cropping</h3>
      <p>Link cards fetch a hero image from the page metadata. YouTube links resolve to their thumbnail
      directly, so a consent page cannot block it. Links without a hero image show a soft dotted globe
      fallback at the board dot spacing. Right-click a header image to add, change, crop or remove it;
      the crop dialog fits the whole image first and Fit to image resets the frame.</p>
      <h3>Playback</h3>
      <p>Existing audio and video cards keep working. Right-click for Play, Pause and a Repeat checkbox,
      and video embeds show pause, mute, seek, skip and volume controls. Moving or resizing a card keeps
      an active player alive instead of restarting it. Map, Video and Audio tools are temporarily
      disabled, so new local media goes through Upload.</p>
    `,
  },
  {
    id: "access",
    label: "Access and sharing",
    html: `
      <p class="mn-docs-lead">This build is local-first. Share and Sync are disabled; boards stay in
      the local SQLite database on this computer.</p>
      <h3>Disabled controls</h3>
      <ul>
        <li>The Share and Sync buttons are hidden from the header.</li>
        <li>There are no public links, share tokens, passkeys, invitations or account permissions.</li>
        <li>No login, signup, password reset or account page is required or available.</li>
        <li>Right-click Share link is disabled.</li>
      </ul>
      <h3>Local board URLs</h3>
      <p>The browser edition still keeps a local board URL such as
      <code>http://127.0.0.1:1430/?board=&lt;id&gt;</code>. It opens the board on the same machine;
      network sharing and the self-hosted service are not part of this build.</p>
    `,
  },
  {
    id: "sync",
    label: "Server sync",
    dividerBefore: true,
    html: `
      <p class="mn-docs-lead">Sync is disabled in this local-first build. The desktop app, local web
      host and SQLite database work entirely offline.</p>
      <h3>What is off</h3>
      <ul>
        <li>The Sync button is hidden and the sync dialog is not reachable from the UI.</li>
        <li>No server URL, account email, password or API token is requested.</li>
        <li>Settings &gt; Server shows only local runtime details.</li>
        <li>No background sync queue runs and no data leaves this computer.</li>
      </ul>
      <h3>Data</h3>
      <p>Boards, cards, assets, settings and comments stay in the local database and asset folder.
      Backups remain available from Settings &gt; Backup.</p>
    `,
  },
  {
    id: "accounts",
    label: "Accounts and passkeys",
    html: `
      <p class="mn-docs-lead">Accounts, passkeys, login, signup and password reset are disabled in
      this local-first build. No account is needed to use the app.</p>
      <h3>What is off</h3>
      <ul>
        <li>No first-run admin setup and no login gate.</li>
        <li>The topbar account avatar is hidden and Settings has no Account page.</li>
        <li>There is no account information, password, history or delete-account UI.</li>
        <li>Comments use the local identity <strong>You</strong> without a profile picture.</li>
        <li>Passkeys, invitations, member roles, API tokens and the admin panel are not exposed.</li>
      </ul>
      <h3>Existing data</h3>
      <p>Account tables may still exist in an older local database, but this build does not read them
      for sign-in or display. Boards and settings continue to work without an account.</p>
      <h3>Future work</h3>
      <p>The optional account and service code remains in the repository for a later milestone. It is
      not part of the current local-first release.</p>
    `,
  },
  {
    id: "service",
    label: "Self-hosted service",
    html: `
      <p class="mn-docs-lead">The self-hosted service is not part of this local-first build. The
      desktop app, local web host and local database work without it. The notes below are reference
      for a future service deployment.</p>
      <h3>Run it locally</h3>
      <pre class="mn-docs-code">cd service
Copy-Item .env.example .env
# set KHAOYU_SERVICE_SECRET, KHAOYU_SERVICE_PUBLIC_URL and KHAOYU_SERVICE_COOKIE_SECURE=false
node src/cli.mjs migrate
node src/cli.mjs bootstrap
node src/server.mjs</pre>
      <p>Docker Compose runs the same process as non-root with a read-only root filesystem and a
      writable <code>/data</code> volume. Health checks are <code>GET /healthz</code> and
      <code>GET /readyz</code>; both return status only.</p>
      <h3>Configuration</h3>
      <table>
        <tr><th>Variable</th><th>Purpose</th></tr>
        <tr><td><code>KHAOYU_SERVICE_SECRET</code></td><td>Required. Signs IP hashes, OTPs and unsubscribe links. Startup fails on weak or placeholder values.</td></tr>
        <tr><td><code>KHAOYU_SERVICE_PUBLIC_URL</code></td><td>Base URL, WebAuthn origin and same-origin checks.</td></tr>
        <tr><td><code>KHAOYU_SERVICE_DATA_DIR</code></td><td>Database, objects, temp files, backups and the mail outbox.</td></tr>
        <tr><td><code>KHAOYU_SERVICE_COOKIE_SECURE</code></td><td>Adds Secure cookies and HSTS. Set false only for plain-HTTP local use.</td></tr>
        <tr><td><code>KHAOYU_SERVICE_CORS_ORIGINS</code></td><td>Origins allowed to call bearer APIs. Defaults include the Tauri client and the local web host on port 1430.</td></tr>
        <tr><td><code>KHAOYU_SERVICE_PUBLIC_SHARING</code></td><td>Global public-sharing kill switch.</td></tr>
        <tr><td><code>KHAOYU_SERVICE_ADMIN_TOKEN</code></td><td>Enables operator admin endpoints; unset means they do not exist.</td></tr>
        <tr><td><code>KHAOYU_SERVICE_BACKUP_PASSPHRASE</code></td><td>Encrypts backups with scrypt and AES-256-GCM.</td></tr>
      </table>
      <h3>Data and safety</h3>
      <ul>
        <li>Backups use a consistent SQLite snapshot, are verified, and keep a safety copy on restore.</li>
        <li>Audit rows are pruned by retention; login attempts and share passphrase attempts are rate limited.</li>
        <li>Terminate TLS at a reverse proxy and set <code>KHAOYU_SERVICE_REQUIRE_HTTPS=true</code> for production.</li>
        <li>Operators must document their own backup location, encryption and deletion practice.</li>
      </ul>
    `,
  },
  {
    id: "mcp",
    label: "MCP server",
    html: `
      <p class="mn-docs-lead">A second binary, <code>khaoyu-note-mcp.exe</code>, exposes the boards to AI
      agents over the Model Context Protocol on stdio. It opens the same SQLite database as the app in
      WAL mode, so both can run at once, and it never talks to the network.</p>
      <h3>Tools</h3>
      <p>14 tools are available:</p>
      <ul>
        <li>Read: <code>list_boards</code>, <code>get_board</code>, <code>get_board_json</code>,
        <code>get_card</code>, <code>search</code>, <code>list_comments</code>.</li>
        <li>Write: <code>create_board</code>, <code>update_board</code>, <code>delete_board</code>,
        <code>create_card</code>, <code>update_card</code>, <code>delete_card</code>,
        <code>add_comment</code>, <code>connect_cards</code>.</li>
      </ul>
      <p>Writes load the board document, mutate it, and save through the same stale-write guard as the
      app. Tool failures come back as tool errors with <code>isError</code>, never as protocol errors.
      Logs go to stderr so stdout stays a clean JSON-RPC stream.</p>
      <h3>Build and install</h3>
      <pre class="mn-docs-code">cd app\\src-tauri
$env:CARGO_TARGET_DIR='C:\\temp\\mn-target'
cmd /c "call ""C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Auxiliary\\Build\\vcvars64.bat"" && cargo build --release --bin khaoyu-note-mcp"</pre>
      <p>The binary lands in the Cargo target folder and is copied to <code>dist/</code>. The
      installers currently ship only the app executable, so copy <code>khaoyu-note-mcp.exe</code>
      beside the app or to a stable folder such as
      <code>%LOCALAPPDATA%\\Khaoyu Note\\</code>.</p>
      <h3>Register a client</h3>
      <pre class="mn-docs-code">{
  "mcpServers": {
    "khaoyu-note": {
      "command": "C:/path/to/khaoyu-note-mcp.exe"
    }
  }
}</pre>
      <p>Settings &gt; MCP shows the resolved binary path, the transport, the database folder and the 14
      tools, with a copyable client configuration. The repository also ships a configuration-only
      DeepSeek Harness bundle in <code>dsh-bundle-note-studio-mcp/</code>.</p>
      <h3>Database folder</h3>
      <p>The default is <code>%APPDATA%\\com.dezuhan.khaoyunote</code>. Set
      <code>KHAOYU_NOTE_DB_DIR</code> to point the server at another folder for portable setups or
      isolated test runs.</p>
    `,
  },
  {
    id: "api",
    label: "HTTP API",
    html: `
      <p class="mn-docs-lead">This HTTP API belongs to the optional self-hosted service, which is not
      used by the local-first app and is disabled from its UI. It is documented here for future work.</p>
      <h3>Authentication</h3>
      <ul>
        <li><code>Authorization: Bearer khn_...</code> with the <code>projects:read</code> and
        <code>projects:write</code> scopes for project and share APIs.</li>
        <li>Cookie sessions with <code>X-CSRF-Token</code> for state-changing browser requests.</li>
        <li><code>POST /api/v1/auth/sync-token</code> exchanges email and password for a scoped token.</li>
        <li>Only origins in <code>KHAOYU_SERVICE_CORS_ORIGINS</code> may call bearer APIs, and
        credentials are never allowed from those origins.</li>
      </ul>
      <h3>Endpoints</h3>
      <table>
        <tr><th>Group</th><th>Endpoints</th></tr>
        <tr><td>Health</td><td><code>GET /healthz</code>, <code>GET /readyz</code></td></tr>
        <tr><td>Auth</td><td><code>POST /api/v1/auth/register</code>, <code>login</code>, <code>refresh</code>, <code>logout</code>, <code>logout-all</code>, <code>sync-token</code>, <code>password-reset/request</code>, <code>password-reset/confirm</code>, <code>otp/request</code>, <code>otp/login</code>, <code>totp/setup</code>, <code>totp/enable</code>, <code>totp/disable</code>, passkey register and login</td></tr>
        <tr><td>Account</td><td><code>GET /api/v1/auth/sessions</code>, <code>GET|POST /api/v1/account/tokens</code>, <code>DELETE /api/v1/account/tokens/:id</code>, <code>GET /api/v1/account/export</code>, <code>POST /api/v1/account/delete</code></td></tr>
        <tr><td>Projects</td><td><code>GET|POST /api/v1/projects</code>, <code>GET /api/v1/projects/:id</code>, <code>PUT /api/v1/projects/:id/snapshot</code>, <code>GET /api/v1/projects/:id/versions</code>, <code>POST .../versions/:revision/restore</code>, <code>GET .../events</code> (SSE)</td></tr>
        <tr><td>Assets</td><td><code>GET|POST /api/v1/projects/:id/assets</code>, <code>GET .../assets/:assetId</code></td></tr>
        <tr><td>Sharing</td><td><code>GET|POST /api/v1/projects/:id/shares</code>, <code>DELETE /api/v1/shares/:id</code>, <code>POST /api/v1/shares/:id/rotate</code>, <code>POST /api/v1/projects/:id/public-sharing</code>, <code>POST /api/v1/share/:token/access</code></td></tr>
        <tr><td>Admin</td><td><code>GET /api/v1/admin/audit</code>, <code>abuse-reports</code>, <code>stats</code>, with the operator token</td></tr>
      </table>
      <h3>Example: sign in and push a snapshot</h3>
      <pre class="mn-docs-code">const base = "http://127.0.0.1:8080";
const signed = await fetch(base + "/api/v1/auth/sync-token", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "owner@example.com", password: "..." })
}).then((response) =&gt; response.json());

const headers = { authorization: "Bearer " + signed.token, "content-type": "application/json" };
const project = await fetch(base + "/api/v1/projects", {
  method: "POST", headers, body: JSON.stringify({ title: "Imported board" })
}).then((response) =&gt; response.json());

await fetch(base + "/api/v1/projects/" + project.id + "/snapshot", {
  method: "PUT", headers,
  body: JSON.stringify({ doc: JSON.stringify(boardDocument), revision: 1 })
});</pre>
      <h3>Limits</h3>
      <ul>
        <li>Snapshot documents: 8 MB. Other JSON bodies: 64 KB.</li>
        <li>Asset uploads: 100 MB, with magic-byte checks for images.</li>
        <li>Health endpoints are unauthenticated and expose no version, path or configuration.</li>
      </ul>
    `,
  },
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    dividerBefore: true,
    html: `
      <table>
        <tr><th>Action</th><th>Shortcut</th></tr>
        <tr><td>Pan</td><td>Space + drag, middle drag or wheel</td></tr>
        <tr><td>Zoom</td><td>Ctrl + wheel or Ctrl + / -</td></tr>
        <tr><td>Zoom to 100%</td><td>Ctrl + 0</td></tr>
        <tr><td>Undo / redo</td><td>Ctrl + Z / Ctrl + Shift + Z</td></tr>
        <tr><td>Select all</td><td>Ctrl + A</td></tr>
        <tr><td>Duplicate</td><td>Ctrl + D</td></tr>
        <tr><td>Copy / cut / paste</td><td>Ctrl + C / Ctrl + X / Ctrl + V</td></tr>
        <tr><td>Wrap selection in a column</td><td>Ctrl + G</td></tr>
        <tr><td>Delete</td><td>Delete or Backspace</td></tr>
        <tr><td>Command palette</td><td>Ctrl + K</td></tr>
        <tr><td>Shortcuts list</td><td>?</td></tr>
        <tr><td>New note / link / to-do / heading / board / column / kanban / comment / table / sketch / color / document</td><td>N, L, T, H, G, C, K, M, X, S, O, D</td></tr>
        <tr><td>Line / Draw tool</td><td>A / R</td></tr>
        <tr><td>Image / Upload</td><td>I / W</td></tr>
      </table>
    `,
  },
  {
    id: "settings",
    label: "Settings and backup",
    html: `
      <h3>Panes</h3>
      <p>Settings opens with Server and Backup at the top, then a divider, General,
      Appearance, Tools and Performance, then another divider, MCP and About. Language is part of
      General and Canvas is part of Appearance. Tools is a two-column icon grid; Map, Video and Audio
      show a disabled status. There is no Account page in this local-first build.</p>
      <h3>Server</h3>
      <ul>
        <li>Server shows only the local runtime: mode, version, database folder and, on the web host,
        host and port.</li>
        <li>Account, passkeys, sharing, sign-in and sync actions are removed; Share and Sync are
        disabled in the topbar.</li>
      </ul>
      <h3>Backup</h3>
      <ul>
        <li>Back up now writes a consistent SQLite snapshot plus assets to
        <code>Documents/Khaoyu Note Backups</code>.</li>
        <li>Automatic backup can run every day, every 3, 7 or 14 days, or every month (30 days). The
        schedule runs while the app is open, and a missed interval is caught up on the next launch.</li>
        <li>A manual backup or Export ZIP resets the automatic schedule so the backup is not
        duplicated.</li>
        <li>Export ZIP writes the same folder as one archive next to it.</li>
        <li>Open folder opens the latest backup location.</li>
        <li>The restore command validates a backup and stages it for the next launch. There is no
        Restore control in the pane yet.</li>
        <li>Old backup folders are not deleted automatically; remove them from the folder when you no
        longer need them.</li>
        <li>Integrity check runs <code>PRAGMA integrity_check</code> from Settings &gt; About and the
        command palette.</li>
      </ul>
      <h3>Performance</h3>
      <p>GPU acceleration is stored in SQLite and applied when the window is created, so changing it
      offers a restart. The Performance pane also reports the live WebGL renderer and CPU details so the
      setting is not a blind switch.</p>
    `,
  },
  {
    id: "updates",
    label: "Updates",
    html: `
      <p class="mn-docs-lead">The app checks the latest GitHub release of
      <code>dezuhan/khaoyu-note</code>. It never downloads or runs an installer.</p>
      <h3>When it checks</h3>
      <ul>
        <li>Once at startup, then every hour while the app stays open.</li>
        <li>Manually from Help &gt; Check for updates or Settings &gt; About.</li>
      </ul>
      <h3>What it shows</h3>
      <p>When a newer version is published, a dialog shows the release tag, published date and the
      release notes. Open release page opens the GitHub release in the browser, where the installer can
      be downloaded. A dismissed version is not shown again automatically, but Settings &gt; About keeps
      the last status.</p>
      <h3>Limits and privacy</h3>
      <ul>
        <li>Only the GitHub API is called; no board data is sent.</li>
        <li>The request reveals the user IP to GitHub and counts against GitHub's unauthenticated rate
        limit of 60 requests per hour per IP. One check per hour stays well below it.</li>
        <li>When no release is published or the network is unavailable, About reports the status and
        the app keeps working.</li>
        <li>Updates are notification only: there is no silent download, no auto-install and no signed
        update channel yet.</li>
      </ul>
    `,
  },
  {
    id: "privacy",
    label: "Privacy and safety",
    html: `
      <ul>
        <li>Local boards do not require an account and never leave this device unless you enable sync.</li>
        <li>Public sharing is off by default and each link is limited to its scope.</li>
        <li>Search engines are excluded with noindex and share tokens are redacted from logs.</li>
        <li>Audit rows store an HMAC of the IP address, never the raw address.</li>
        <li>Deleting a local board never deletes server data.</li>
        <li>MCP over stdio has no authentication, so any local process that can start it can read and
        write the database. Keep the binary in a folder only you can run.</li>
      </ul>
    `,
  },
  {
    id: "troubleshooting",
    label: "Troubleshooting",
    html: `
      <ul>
        <li>If a save conflict appears, choose Load newer version or Keep my version as a copy. Never
        overwrite silently.</li>
        <li>If sync says the server is unreachable, check the URL and that the service is running.
        Then check Settings &gt; Account: Server, Account and Status show the exact failure.</li>
        <li>If sync says the password is rejected, confirm the email. When an account uses TOTP,
        sign in on the account page and create a token for scripted use instead.</li>
        <li>If the browser build cannot reach the service, add the page origin to
        <code>KHAOYU_SERVICE_CORS_ORIGINS</code>. The local web host on port 1430 is included by
        default.</li>
        <li>If a passkey cannot be created, use localhost or HTTPS and a browser with WebAuthn.</li>
        <li>If the desktop build cannot reach <code>http://localhost</code>, rebuild the app so the
        current CSP applies.</li>
      </ul>
      <h3>Checks</h3>
      <pre class="mn-docs-code">node --experimental-vm-modules scripts/check-web.cjs
node tools/test-sync.mjs
node service/test/service.test.mjs
node service/test/auth.test.mjs
node tools/test-ui.mjs http://127.0.0.1:1430/</pre>
      <p class="mn-docs-foot">Full operator documentation is in the repository: README.md,
      service/README.md, docs/architecture.md, docs/security-audit.md, docs/packaging.md and
      docs/blockers.md.</p>
    `,
  },
];

// Build the tabbed documentation shell: sections on the left, the selected section on the right.
export function createDocumentation() {
  const shell = document.createElement("div");
  shell.className = "mn-docs-shell";

  const nav = document.createElement("nav");
  nav.className = "mn-docs-nav";
  nav.setAttribute("aria-label", "Documentation sections");

  const pane = document.createElement("div");
  pane.className = "mn-docs-pane";

  const content = document.createElement("div");
  content.className = "mn-docs";
  pane.append(content);
  shell.append(nav, pane);

  const buttons = new Map();
  let activeId = DOCUMENTATION_SECTIONS[0].id;

  const render = (id, focusButton = false) => {
    const section =
      DOCUMENTATION_SECTIONS.find((entry) => entry.id === id) || DOCUMENTATION_SECTIONS[0];
    activeId = section.id;
    content.innerHTML = section.html;
    pane.scrollTop = 0;
    for (const [key, button] of buttons) {
      const active = key === activeId;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    if (focusButton) buttons.get(activeId)?.focus();
  };

  for (const section of DOCUMENTATION_SECTIONS) {
    if (section.dividerBefore) {
      const divider = document.createElement("div");
      divider.className = "mn-docs-nav-sep";
      nav.append(divider);
    }
    const item = document.createElement("button");
    item.type = "button";
    item.className = "mn-docs-nav-item";
    item.textContent = section.label;
    item.dataset.doc = section.id;
    item.addEventListener("click", () => render(section.id));
    nav.append(item);
    buttons.set(section.id, item);
  }

  nav.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const ids = DOCUMENTATION_SECTIONS.map((entry) => entry.id);
    const index = ids.indexOf(activeId);
    let next = index;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = ids.length - 1;
    else if (event.key === "ArrowDown") next = (index + 1) % ids.length;
    else next = (index - 1 + ids.length) % ids.length;
    render(ids[next], true);
  });

  render(activeId);
  return shell;
}
