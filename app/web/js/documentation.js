// Offline documentation shown from Help > Documentation. The content is split into sections and the
// shell renders a Settings-like left navigation with the section body on the right.

export const DOCUMENTATION_SECTIONS = [
  {
    id: "start",
    label: "Getting started",
    html: `
      <p class="mn-docs-lead">Khaoyu Note is a local-first board app. Boards stay on this device: there is no server, account or
      sync layer, and no request leaves the machine.</p>
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
        <tr><td>Column</td><td>Groups cards; drag cards in and out, collapse and expand. Convert to row lays the children out horizontally; Convert to column restores the stack.</td></tr>
        <tr><td>Section</td><td>Pastel background surface with a small title. Always below cards, not a column, resizable from every edge and corner, with a bottom swatch and position-lock toolbar.</td></tr>
        <tr><td>Board</td><td>Nested board card with a mini preview, opened in place.</td></tr>
        <tr><td>Kanban</td><td>Select two or more columns, then right-click Wrap into kanban. The kanban is a row container of columns; there is no separate kanban card or tool.</td></tr>
        <tr><td>Color</td><td>HSV picker with HEX, RGB, CMYK and an automatic color name.</td></tr>
        <tr><td>Sketch / Draw</td><td>Canvas sketch card, plus a full page drawing editor.</td></tr>
        <tr><td>Image / Upload</td><td>Local image or file asset. Upload also accepts local audio and video files.</td></tr>
        <tr><td>Link</td><td>URL card with a fetched hero image and an open button.</td></tr>
        <tr><td>Line</td><td>Connects two cards, with draggable endpoints and a midpoint curve.</td></tr>
      </table>
      <h3>Editing</h3>
      <ul>
        <li>Right-click a card for Lock position, Download asset, Cut, Copy, Paste, Duplicate and Delete.</li>
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
    id: "accounts",
    label: "Accounts and passkeys",
    html: `
      <p class="mn-docs-lead">Accounts are local to this device. The topbar avatar opens the local
      account menu; no server, invitation, passkey or admin panel exists.</p>
      <h3>Local account</h3>
      <ul>
        <li>The account protects this installation. It is created and managed on this computer.</li>
        <li>Profile, password, activity history and session controls live in the avatar menu.</li>
        <li>Comments use the local identity <strong>You</strong> without a profile picture.</li>
        <li>There are no invitations, member roles, API tokens, passkeys or admin dashboard.</li>
      </ul>
      <h3>No server account</h3>
      <p>Boards and settings work without an account, and there is no remote account to sign in to.
      Older databases may still contain unused account tables; the app does not use them for sync,
      sharing or a remote identity.</p>
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
        <tr><td>Snap to grid</td><td>View &gt; Snap to grid</td></tr>
        <tr><td>Delete</td><td>Delete or Backspace</td></tr>
        <tr><td>Command palette</td><td>Ctrl + K</td></tr>
        <tr><td>Shortcuts list</td><td>?</td></tr>
        <tr><td>New note / link / to-do / heading / board / column / comment / table / sketch / color / document</td><td>N, L, T, H, G, C, M, X, S, O, D</td></tr>
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
      <p>Settings opens on General, then Backup, Appearance, Tools and Board templates, a divider,
      Performance, then a second divider, MCP and About. Language is part of General and Canvas is
      part of Appearance. Tools is a two-column icon grid; Map, Video and Audio show a disabled
      status.</p>
      <h3>Local runtime</h3>
      <ul>
        <li>About shows the local runtime: mode, version, storage and, on the web host, host and
        port.</li>
        <li>There is no Account or Server page: the app has no server connection to configure.</li>
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
      <p>Reduced effects is on by default: it turns off backdrop blur, the heavy card shadows and the
      long animations, and keeps the dotted grid, card text and every tool unchanged. Turn it off under
      Settings &gt; Performance if you prefer the full shadow and blur treatment.</p>
      <p>For a stutter that only shows on one machine, press <code>Ctrl+Alt+Shift+P</code> to show a
      frame-cost overlay (or open the app with <code>?perf=1</code>). It reports delivered frames per
      second, the frame-time median/p90/max, frames slower than 25 and 50 ms, long tasks, board size and
      the GPU renderer. Click the overlay to copy that report.</p>
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
        <li>Local boards do not require an account and never leave this device.</li>
        <li>Public sharing is off by default and each link is limited to its scope.</li>
        <li>Search engines are excluded with noindex and the app makes no outbound request for board data.</li>\n        <li>MCP over stdio has no authentication, so any local process that can start it can read and
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
        <li>If the desktop build cannot reach <code>http://localhost</code>, rebuild the app so the
        current CSP applies.</li>
        <li>If the browser build shows the wrong database, check the <code>KHAOYU_NOTE_DB_DIR</code>
        folder and the database path reported by /status.</li>
      </ul>
      <h3>Checks</h3>
      <pre class="mn-docs-code">node --experimental-vm-modules scripts/check-web.cjs
node tools/test-ui.mjs http://127.0.0.1:1430/
node tools/test-web-mode.mjs</pre>
      <p class="mn-docs-foot">Full documentation is in the repository: README.md,
      docs/architecture.md, docs/packaging.md and docs/blockers.md.</p>
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
