// Settings dialog in the Photon preferences style, plus persisted app preferences.

import * as bridge from "./bridge.js";
import { icon } from "./icons.js";
import { toolDisabledReason } from "./limits.js";
import { exportCurrentBoard, history, notify, setTheme, state } from "./store.js";
import { checkConnection, describeConnection, loadSyncConfig, signOut } from "./sync.js";
import { currentVersion, initCurrentVersion, releaseSummary } from "./update.js";
import { openSyncDialog } from "./sync-ui.js";

export const DEFAULT_TOOL_ORDER = [
  "note",
  "link",
  "todo",
  "line",
  "board",
  "column",
  "comment",
  "table",
  "sketch",
  "color",
  "document",
  "audio",
  "map",
  "video",
  "heading",
  "image",
  "upload",
  "draw",
];

export const DEFAULT_SETTINGS = {
  imageInterpolation: "bicubic",
  autoUpdateOpenDocuments: true,
  exportClipboard: false,
  gpuAcceleration: true,
  reduceMotion: false,
  gridSize: 24,
  showGrid: true,
  hiddenTools: [],
  toolOrder: [...DEFAULT_TOOL_ORDER],
  headingFont: "Georgia",
  bodyFont: "Plus Jakarta Sans",
  codeFont: "Space Mono",
};

const FONT_STACKS = {
  "Plus Jakarta Sans": '"Plus Jakarta Sans", Inter, "Segoe UI", system-ui, sans-serif',
  "DM Sans": '"DM Sans", Inter, "Segoe UI", system-ui, sans-serif',
  "Space Mono": '"Space Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  "Playfair Display": '"Playfair Display", Georgia, "Times New Roman", serif',
  Georgia: 'Georgia, "Times New Roman", serif',
};

const FONT_CHOICES = [
  ["Plus Jakarta Sans", "Plus Jakarta Sans"],
  ["DM Sans", "DM Sans"],
  ["Playfair Display", "Playfair Display"],
  ["Space Mono", "Space Mono"],
];

const HEADING_FONT_CHOICES = [["Georgia", "Georgia (system serif)"], ...FONT_CHOICES];

const NAV = [
  { id: "account", label: "Account" },
  { id: "backup", label: "Backup" },
  { divider: true },
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "tools", label: "Tools" },
  { id: "performance", label: "Performance" },
  { divider: true },
  { id: "mcp", label: "MCP" },
  { id: "about", label: "About" },
];

const TOOL_LABELS = [
  ["note", "Note"],
  ["link", "Link"],
  ["todo", "To-do"],
  ["line", "Line"],
  ["board", "Board"],
  ["column", "Column"],
  ["kanban", "Kanban"],
  ["comment", "Comment"],
  ["table", "Table"],
  ["sketch", "Sketch"],
  ["color", "Color"],
  ["document", "Document"],
  ["audio", "Audio"],
  ["map", "Map"],
  ["video", "Video"],
  ["heading", "Heading"],
  ["image", "Add image"],
  ["upload", "Upload"],
  ["draw", "Draw"],
];

let settings = { ...DEFAULT_SETTINGS };
let overlay = null;
let activePage = "account";
let query = "";
let searchTimer = 0;
let saveTimer = 0;
let statusText = "";

export async function initSettings() {
  try {
    const raw = await bridge.getSetting("ui_settings");
    if (raw) {
      const parsed = JSON.parse(raw);
      settings = { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  applyGlobalSettings();
  void initCurrentVersion();
  return settings;
}

export function getSettings() {
  return settings;
}

export function saveToolOrder(order) {
  settings.toolOrder = [...order];
  persist();
}

function persist() {
  localStorage.setItem("mn.settings", JSON.stringify(settings));
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    bridge.setSetting("ui_settings", JSON.stringify(settings)).catch(() => {});
  }, 250);
  window.dispatchEvent(new CustomEvent("mn:settings-changed", { detail: settings }));
}

export function applyGlobalSettings() {
  document.documentElement.dataset.imageRendering =
    settings.imageInterpolation === "nearest" ? "nearest" : "auto";
  document.documentElement.dataset.reduceMotion = settings.reduceMotion ? "true" : "false";
  const fallback = FONT_STACKS[DEFAULT_SETTINGS.bodyFont];
  document.documentElement.style.setProperty(
    "--mn-font-heading",
    FONT_STACKS[settings.headingFont] || FONT_STACKS[DEFAULT_SETTINGS.headingFont]
  );
  document.documentElement.style.setProperty(
    "--mn-font-body",
    FONT_STACKS[settings.bodyFont] || fallback
  );
  document.documentElement.style.setProperty(
    "--mn-font-code",
    FONT_STACKS[settings.codeFont] || FONT_STACKS[DEFAULT_SETTINGS.codeFont]
  );
}

export function closeSettingsPage() {
  if (!overlay) return;
  overlay.remove();
  overlay = null;
}

export function openSettingsPage() {
  if (overlay) return;
  overlay = document.createElement("div");
  overlay.className = "mn-prefs-overlay";
  overlay.innerHTML = `
    <div class="mn-prefs-dialog" role="dialog" aria-label="Settings">
      <div class="mn-prefs-shell">
        <header class="mn-prefs-head">
          <span class="mn-prefs-title">Settings</span>
          <button type="button" class="mn-prefs-close" data-role="close" title="Close">${icon("close", 14)}</button>
        </header>
        <div class="mn-prefs-search">
          <span class="mn-prefs-search-icon">${icon("search", 13)}</span>
          <input class="mn-prefs-search-input" data-role="search" placeholder="Search settings" spellcheck="false" />
        </div>
        <div class="mn-prefs-body">
          <nav class="mn-prefs-nav" data-role="nav"></nav>
          <div class="mn-prefs-pane">
            <div class="mn-prefs-content" data-role="content"></div>
            <div class="mn-prefs-resetbar">
              <button type="button" class="mn-btn" data-role="reset">Reset</button>
              <span class="mn-prefs-status" data-role="status"></span>
            </div>
          </div>
        </div>
        <footer class="mn-prefs-foot">
          <button type="button" class="mn-btn" data-role="done">Done</button>
        </footer>
      </div>
    </div>`;
  document.body.append(overlay);

  overlay.querySelector('[data-role="close"]').addEventListener("click", closeSettingsPage);
  overlay.querySelector('[data-role="done"]').addEventListener("click", closeSettingsPage);
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) closeSettingsPage();
  });
  overlay.querySelector('[data-role="search"]').addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      query = event.target.value.trim().toLowerCase();
      renderNav();
      renderContent();
    }, 120);
  });
  overlay.querySelector('[data-role="reset"]').addEventListener("click", () => {
    const page = pages().find((entry) => !entry.divider && entry.id === activePage);
    if (!page) return;
    for (const row of page.rows()) {
      if (!row.key) continue;
      settings[row.key] = DEFAULT_SETTINGS[row.key];
    }
    if (activePage === "tools") {
      settings.hiddenTools = [];
      settings.toolOrder = [...DEFAULT_TOOL_ORDER];
    }
    if (activePage === "appearance") {
      settings.gridSize = 24;
      settings.showGrid = true;
      if (state.board) {
        state.board.grid = 24;
        state.board.showGrid = true;
        notify("board");
      }
      applyGlobalSettings();
    }
    if (activePage === "performance") {
      settings.gpuAcceleration = true;
      bridge.setSetting("gpu_acceleration", "true").catch(() => {});
    }
    persist();
    renderContent();
    setStatus("Page reset to defaults");
  });
  window.addEventListener("keydown", onKeyDown, true);

  renderNav();
  renderContent();
}

function onKeyDown(event) {
  if (!overlay) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeSettingsPage();
  }
}

function setStatus(text) {
  statusText = text;
  const el = overlay?.querySelector('[data-role="status"]');
  if (el) el.textContent = text;
}

// ------------------------------------------------------------------ pages

let gpuProbe = null;

function probeGpu() {
  if (gpuProbe) return gpuProbe;
  const result = {
    available: false,
    renderer: "Not available (WebGL disabled)",
    vendor: "n/a",
    version: "n/a",
  };
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (gl) {
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      result.available = true;
      result.renderer = String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      result.vendor = String(debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR));
      result.version = String(gl.getParameter(gl.VERSION));
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    /* keep the fallback values */
  }
  gpuProbe = result;
  return result;
}

function probeCpu() {
  const cores = navigator.hardwareConcurrency;
  const memory = navigator.deviceMemory;
  const platform =
    (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "Unknown platform";
  return {
    cores: cores ? `${cores} logical cores` : "Not reported",
    memory: memory ? `${memory} GB` : "Not reported",
    platform,
  };
}

function webviewLabel() {
  const ua = navigator.userAgent;
  const edge = ua.match(/Edg\/([\d.]+)/);
  if (edge) return `WebView2 (Chromium ${edge[1]})`;
  const chrome = ua.match(/Chrome\/([\d.]+)/);
  if (chrome) return `Chromium ${chrome[1]} (browser preview)`;
  return "Unknown webview";
}

function pages() {
  return [
    {
      id: "account",
      title: "Account",
      divider: false,
      rows: () => [
        { type: "note", text: "Optional self-hosted service account, passkeys, API tokens and sharing." },
      ],
    },
    {
      id: "backup",
      title: "Backup",
      rows: () => [
        { type: "note", text: "Back up or export the local database, assets and settings." },
      ],
    },
    { divider: true },
    {
      id: "general",
      title: "General",
      rows: () => [
        {
          type: "select",
          label: "Display language",
          value: "en",
          options: [
            ["en", "English"],
            ["id", "Indonesian"],
            ["es", "Spanish"],
            ["ja", "Japanese"],
            ["zh", "Chinese (Simplified)"],
          ],
          disabled: true,
          disabledReason: "More languages are coming soon",
          onChange: () => {},
        },
        note("Khaoyu Note is English only for now. More languages are coming soon."),
        toggle("Auto-Update Open Documents", "autoUpdateOpenDocuments"),
        toggle("Export Clipboard", "exportClipboard"),
        {
          type: "select",
          label: "Image Interpolation",
          value: settings.imageInterpolation,
          options: [
            ["bicubic", "Bicubic Automatic"],
            ["nearest", "Nearest Neighbour"],
          ],
          onChange: (value) => {
            setValue("imageInterpolation", value);
            applyGlobalSettings();
          },
        },
        {
          type: "action",
          label: "Board as JSON",
          buttonLabel: "Export",
          run: () => exportBoard(),
        },
      ],
    },
    {
      id: "appearance",
      title: "Appearance",
      rows: () => [
        {
          type: "select",
          label: "Theme",
          value: state.theme,
          options: [
            ["light", "Light"],
            ["softLight", "Soft light"],
            ["softDark", "Soft dark"],
            ["dark", "Dark"],
          ],
          onChange: (value) => setTheme(value),
        },
        {
          type: "select",
          label: "Heading font",
          key: "headingFont",
          value: settings.headingFont || DEFAULT_SETTINGS.headingFont,
          options: HEADING_FONT_CHOICES,
          onChange: (value) => {
            setValue("headingFont", value);
            applyGlobalSettings();
          },
        },
        {
          type: "select",
          label: "Body font",
          key: "bodyFont",
          value: settings.bodyFont || DEFAULT_SETTINGS.bodyFont,
          options: FONT_CHOICES,
          onChange: (value) => {
            setValue("bodyFont", value);
            applyGlobalSettings();
          },
        },
        {
          type: "select",
          label: "Code font",
          key: "codeFont",
          value: settings.codeFont || DEFAULT_SETTINGS.codeFont,
          options: FONT_CHOICES,
          onChange: (value) => {
            setValue("codeFont", value);
            applyGlobalSettings();
          },
        },
        toggle("Reduce motion", "reduceMotion", () => applyGlobalSettings()),
        note("Canvas"),
        {
          type: "select",
          label: "Grid size",
          value: String(state.board?.grid || settings.gridSize || 24),
          options: [
            ["16", "16 px"],
            ["24", "24 px"],
            ["32", "32 px"],
            ["40", "40 px"],
          ],
          onChange: (value) => {
            settings.gridSize = Number(value);
            if (state.board) {
              state.board.grid = Number(value);
              notify("board");
            }
            setValue("gridSize", Number(value), false);
          },
        },
        {
          type: "toggle",
          label: "Show grid",
          checked: state.board ? state.board.showGrid !== false : true,
          onChange: (checked) => {
            if (state.board) {
              state.board.showGrid = checked;
              notify("board");
            }
            setValue("showGrid", checked, false);
          },
        },
        {
          type: "action",
          label: "Zoom",
          buttonLabel: "Reset to 100%",
          run: () => {
            state.view.zoom = 1;
            notify("view");
          },
        },
      ],
    },
    {
      id: "tools",
      title: "Tools",
      rows: () =>
        TOOL_LABELS.map(([key, label]) => ({
          type: "toggle",
          label,
          checked: !settings.hiddenTools.includes(key),
          onChange: () => {},
        })),
    },
    {
      id: "performance",
      title: "Performance",
      rows: () => {
        const gpu = probeGpu();
        const cpu = probeCpu();
        const gpuOn = settings.gpuAcceleration !== false;
        return [
          {
            type: "toggle",
            label: "GPU acceleration",
            checked: gpuOn,
            onChange: (checked) => {
              settings.gpuAcceleration = checked;
              bridge.setSetting("gpu_acceleration", String(checked)).catch(() => {});
              persist();
              renderContent();
            },
          },
          info("Current mode", gpuOn ? "GPU (hardware accelerated)" : "CPU (software rendering)"),
          info("GPU", gpu.renderer),
          info("GPU vendor", gpu.vendor),
          info("Graphics API", gpu.version),
          info("CPU", cpu.cores),
          info("Memory", cpu.memory),
          info("Platform", cpu.platform),
          info("WebView", webviewLabel()),
          note(
            "GPU acceleration is applied by the Rust host when the window is created; the CPU fallback uses Chromium software rendering. Restart the app after changing it."
          ),
          {
            type: "action",
            label: "Apply GPU change",
            buttonLabel: "Restart app",
            run: () => bridge.restartApp(),
          },
        ];
      },
    },
    { divider: true },
    {
      id: "mcp",
      title: "MCP",
      rows: () => [
        info(
          "Server binary",
          bridge.hasWeb
            ? "Desktop app only (stdio binary)"
            : cachedMcpPath ||
                (bridge.hasTauri
                  ? "Detecting..."
                  : "khaoyu-note-mcp.exe (not available in browser preview)")
        ),
        info("Transport", "stdio, JSON-RPC 2.0"),
        info("Database", awaitPath()),
        info("Tools", "14 board tools (list_boards, get_board, create_card, ...)"),
        note(
          "Register this server in any MCP client. The app and the server share the same SQLite database, so agent edits appear in Khaoyu Note immediately."
        ),
        info("Client", "Generic MCP client (JSON)"),
        { type: "code", text: mcpConfig() },
        {
          type: "action",
          label: "Client config",
          buttonLabel: "Copy JSON",
          run: () => copyMcpConfig(),
        },
      ],
    },
    {
      id: "about",
      title: "About",
      rows: () => [
        info("Version", currentVersion() || bridge.webInfo?.version || "unknown"),
        info("Update status", releaseSummary()),
        {
          type: "action",
          label: "Updates",
          buttonLabel: "Check for updates",
          run: () => window.dispatchEvent(new CustomEvent("mn:check-updates")),
        },
        info(
          "Storage",
          bridge.hasWeb
            ? "SQLite via local web server"
            : bridge.hasTauri
              ? "SQLite database (offline)"
              : "localStorage (browser preview)"
        ),
        ...(bridge.webInfo
          ? [
              info("Mode", "Web (localhost)"),
              info("Host", bridge.webInfo.host),
              info("Port", String(bridge.webInfo.port)),
              info("URL", bridge.webInfo.url),
            ]
          : []),
        info("Data folder", awaitPath()),
        info("Projects", String(state.boards.filter((board) => !board.parentId).length)),
        info("Nested boards", String(state.boards.filter((board) => board.parentId).length)),
        note("Local-first visual boards. Accounts and server sync are optional."),
      ],
    },
  ];
}
function info(label, value) {
  return { type: "info", label, value };
}

function note(text) {
  return { type: "note", text };
}

function toggle(label, key, after) {
  return {
    type: "toggle",
    label,
    checked: settings[key] !== false,
    onChange: (checked) => {
      setValue(key, checked);
      if (after) after();
    },
  };
}

function setValue(key, value, rerender = true) {
  settings[key] = value;
  persist();
  if (rerender) renderContent();
}

let cachedPath = "";
let cachedMcpPath = "";
function awaitPath() {
  return cachedPath || "Loading...";
}

function mcpConfig() {
  return JSON.stringify(
    {
      mcpServers: {
        "khaoyu-note": {
          command: cachedMcpPath || "khaoyu-note-mcp.exe",
        },
      },
    },
    null,
    2
  );
}

async function copyText(text, success) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus(success);
  } catch {
    setStatus("Could not copy to clipboard");
  }
}

async function copyMcpConfig() {
  await copyText(mcpConfig(), "MCP JSON config copied to clipboard");
}

async function loadPath() {
  try {
    cachedPath = await bridge.appDataDir();
  } catch {
    cachedPath = "unavailable";
  }
  try {
    cachedMcpPath = await bridge.mcpServerPath();
  } catch {
    cachedMcpPath = "";
  }
  if (overlay) renderContent();
}

// ------------------------------------------------------------------ render

function renderNav() {
  const nav = overlay.querySelector('[data-role="nav"]');
  if (!nav) return;
  nav.innerHTML = "";
  for (const page of pages()) {
    if (page.divider) {
      if (!query) {
        const separator = document.createElement("div");
        separator.className = "mn-prefs-nav-sep";
        nav.append(separator);
      }
      continue;
    }
    if (query && !pageMatches(page)) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mn-prefs-nav-item" + (page.id === activePage ? " is-active" : "");
    button.textContent = page.title;
    button.addEventListener("click", () => {
      activePage = page.id;
      renderNav();
      renderContent();
    });
    nav.append(button);
  }
}

function pageMatches(page) {
  if (page.divider) return false;
  if (page.title.toLowerCase().includes(query)) return true;
  return page.rows().some((row) => rowMatches(row));
}

function rowMatches(row) {
  if (row.type === "note") return (row.text || "").toLowerCase().includes(query);
  return (row.label || "").toLowerCase().includes(query);
}

function renderContent() {
  const content = overlay.querySelector('[data-role="content"]');
  if (!content) return;
  content.innerHTML = "";

  if (query) {
    const matches = [];
    for (const page of pages()) {
      if (page.divider) continue;
      for (const row of page.rows()) {
        if (rowMatches(row) || page.title.toLowerCase().includes(query)) matches.push({ page, row });
      }
    }
    content.append(heading(`Search results (${matches.length})`));
    if (!matches.length) {
      content.append(noteEl(`No settings match "${query}".`));
    } else {
      for (const match of matches) {
        const label = document.createElement("div");
        label.className = "mn-prefs-group-label";
        label.textContent = match.page.title;
        content.append(label);
        content.append(buildRow(match.row));
      }
    }
    return;
  }

  const page = pages().find((entry) => !entry.divider && entry.id === activePage);
  if (activePage === "account") {
    renderAccountPage(content);
  } else if (activePage === "backup") {
    renderBackupPage(content);
  } else if (activePage === "tools") {
    content.append(heading("Tools"));
    const note = document.createElement("p");
    note.className = "mn-prefs-note";
    note.textContent =
      "Map, Video and Audio are temporarily disabled. Upload local images, audio, video and other files with the Upload tool. Link cards fetch a hero image, and YouTube links use their thumbnail directly.";
    content.append(note);
    renderToolsGrid(content);
  } else if (page) {
    content.append(heading(page.title));
    for (const row of page.rows()) content.append(buildRow(row));
  }

  const status = document.createElement("div");
  status.className = "mn-prefs-inline-status";
  status.dataset.role = "inline-status";
  content.append(status);

  if (settings.gpuAcceleration === false) {
    const hint = document.createElement("div");
    hint.className = "mn-prefs-hint";
    hint.textContent = "GPU acceleration is off. Restart the app to apply software rendering.";
    content.append(hint);
  }

  const statusEl = overlay.querySelector('[data-role="status"]');
  if (statusEl) statusEl.textContent = statusText;
}

function serviceBase() {
  const config = loadSyncConfig();
  return (config.url || "http://127.0.0.1:8080").replace(/\/+$/, "");
}

function serviceButton(label, path) {
  return {
    label,
    onClick: () => bridge.openExternal(serviceBase() + path),
  };
}

function renderAccountPage(content) {
  content.append(heading("Account"));
  const config = loadSyncConfig();
  const intro = document.createElement("p");
  intro.className = "mn-prefs-note";
  intro.textContent =
    "Accounts are optional. Local boards never require login. Connect the self-hosted service for passkeys, sharing and sync.";
  content.append(intro);

  const status = document.createElement("div");
  status.className = "mn-account-status";
  const server = document.createElement("div");
  server.className = "mn-account-server";
  server.textContent = config.url ? `Server: ${config.url}` : "Server: not connected";
  const token = document.createElement("div");
  token.className = "mn-account-server";
  token.textContent = config.token
    ? `Account: ${config.email || "signed in"}`
    : "Account: not signed in";
  const connection = document.createElement("div");
  connection.className = "mn-account-server mn-account-connection";
  connection.dataset.role = "account-connection";
  connection.dataset.status = "checking";
  connection.textContent = "Status: checking...";
  status.append(server, token, connection);
  content.append(status);
  void refreshAccountConnection(connection);

  const grid = document.createElement("div");
  grid.className = "mn-account-grid";
  const actions = [
    ["Open account", "Create or sign in, reset password, manage sessions and API tokens.", "/account"],
    ["Passkeys", "Register or use a WebAuthn passkey.", "/passkeys"],
    ["Sharing", "Create and revoke public board or card links.", "/shares"],
  ];
  for (const [title, description, path] of actions) {
    const card = document.createElement("div");
    card.className = "mn-account-card";
    const headingEl = document.createElement("strong");
    headingEl.textContent = title;
    const text = document.createElement("p");
    text.className = "mn-prefs-note";
    text.textContent = description;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mn-btn";
    button.textContent = "Open";
    button.addEventListener("click", () => bridge.openExternal(serviceBase() + path));
    card.append(headingEl, text, button);
    grid.append(card);
  }
  content.append(grid);

  const connect = document.createElement("button");
  connect.type = "button";
  connect.className = "mn-btn mn-btn-primary";
  connect.textContent = config.token ? "Account or change server" : "Sign in or change server";
  connect.addEventListener("click", () => {
    closeSettingsPage();
    openSyncDialog();
  });
  content.append(connect);

  const recheck = document.createElement("button");
  recheck.type = "button";
  recheck.className = "mn-btn mn-btn-quiet";
  recheck.textContent = "Check connection";
  recheck.addEventListener("click", async () => {
    const line = content.querySelector('[data-role="account-connection"]');
    if (!line) return;
    const result = await refreshAccountConnection(line);
    setStatus(result ? describeConnection(result) : "Connection not configured");
  });
  content.append(recheck);

  if (config.token) {
    const out = document.createElement("button");
    out.type = "button";
    out.className = "mn-btn mn-btn-quiet";
    out.textContent = "Sign out";
    out.addEventListener("click", () => {
      signOut();
      closeSettingsPage();
      openSettingsPage();
      setStatus("Signed out of the sync server");
    });
    content.append(out);
  }

  const docs = document.createElement("button");
  docs.type = "button";
  docs.className = "mn-btn mn-btn-quiet";
  docs.textContent = "Open documentation";
  docs.addEventListener("click", () => {
    closeSettingsPage();
    window.dispatchEvent(new CustomEvent("mn:open-docs"));
  });
  content.append(docs);
}

async function refreshAccountConnection(element) {
  const config = loadSyncConfig();
  if (!config.url || !config.token) {
    element.dataset.status = "unconfigured";
    element.textContent = "Status: not configured";
    return null;
  }
  element.dataset.status = "checking";
  element.textContent = "Status: checking...";
  const result = await checkConnection();
  if (!element.isConnected) return result;
  element.dataset.status = result.state;
  element.textContent = `Status: ${describeConnection(result)}`;
  return result;
}

function renderBackupPage(content) {
  content.append(heading("Backup"));
  renderBackupSection(content);
}

function renderBackupSection(content) {
  const section = document.createElement("div");
  section.className = "mn-account-backup";
  const note = document.createElement("p");
  note.className = "mn-prefs-note";
  note.textContent =
    "Back up the local SQLite database, assets and settings. Backups are written to Documents/Khaoyu Note Backups in the desktop and web host.";
  const status = document.createElement("p");
  status.className = "mn-account-backup-status";
  status.textContent = "No backup created in this session.";
  let lastPath = "";
  const row = document.createElement("div");
  row.className = "mn-account-backup-actions";
  const backup = document.createElement("button");
  backup.type = "button";
  backup.className = "mn-btn mn-btn-primary";
  backup.textContent = "Back up now";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "mn-btn mn-btn-quiet";
  open.textContent = "Open folder";
  open.disabled = true;
  const exportZip = document.createElement("button");
  exportZip.type = "button";
  exportZip.className = "mn-btn";
  exportZip.textContent = "Export ZIP";
  backup.addEventListener("click", async () => {
    backup.disabled = true;
    status.textContent = "Creating backup...";
    try {
      lastPath = await bridge.backupData();
      status.textContent = `Backup created: ${lastPath}`;
      open.disabled = false;
      window.dispatchEvent(new CustomEvent("mn:toast", { detail: { message: "Backup created" } }));
    } catch (error) {
      status.textContent = error.message || "Backup failed";
    } finally {
      backup.disabled = false;
    }
  });
  open.addEventListener("click", () => {
    if (lastPath) bridge.openPath(lastPath).catch(() => {});
  });
  exportZip.addEventListener("click", async () => {
    exportZip.disabled = true;
    status.textContent = "Exporting ZIP...";
    try {
      lastPath = await bridge.exportBackupZip();
      status.textContent = `ZIP created: ${lastPath}`;
      open.disabled = false;
      window.dispatchEvent(new CustomEvent("mn:toast", { detail: { message: "Backup ZIP exported" } }));
    } catch (error) {
      status.textContent = error.message || "ZIP export failed";
    } finally {
      exportZip.disabled = false;
    }
  });
  row.append(backup, exportZip, open);
  section.append(note, status, row);
  content.append(section);
}

function renderToolsGrid(content) {
  content.querySelector(".mn-tools-grid")?.remove();
  const grid = document.createElement("div");
  grid.className = "mn-tools-grid";
  for (const [key, label] of TOOL_LABELS) {
    const disabledReason = toolDisabledReason(key);
    const visible = !settings.hiddenTools.includes(key);
    const card = document.createElement("button");
    card.type = "button";
    card.className =
      "mn-tool-card" + (disabledReason ? " is-disabled" : visible ? " is-visible" : "");
    card.setAttribute("aria-pressed", String(visible));
    if (disabledReason) {
      card.disabled = true;
      card.setAttribute("aria-disabled", "true");
      card.title = disabledReason;
    }
    const iconEl = document.createElement("span");
    iconEl.className = "mn-tool-card-icon";
    iconEl.innerHTML = icon(key, 18);
    const labelEl = document.createElement("span");
    labelEl.className = "mn-tool-card-label";
    labelEl.textContent = label;
    const stateEl = document.createElement("span");
    stateEl.className = "mn-tool-card-state";
    stateEl.textContent = disabledReason
      ? "Disabled (temporarily)"
      : visible
        ? "On"
        : "Hidden";
    card.append(iconEl, labelEl, stateEl);
    card.addEventListener("click", () => {
      if (disabledReason) return;
      settings.hiddenTools = visible
        ? [...settings.hiddenTools, key]
        : settings.hiddenTools.filter((entry) => entry !== key);
      persist();
      renderToolsGrid(content);
      setStatus(`${label} ${visible ? "hidden" : "shown"}`);
    });
    grid.append(card);
  }
  content.append(grid);
}

function heading(text) {
  const el = document.createElement("h2");
  el.className = "mn-prefs-heading";
  el.textContent = text;
  return el;
}

function noteEl(text) {
  const el = document.createElement("p");
  el.className = "mn-prefs-note";
  el.textContent = text;
  return el;
}

function buildRow(row) {
  const el = document.createElement("div");
  el.className = "mn-prefs-row";

  if (row.type === "note") {
    el.append(noteEl(row.text));
    return el;
  }
  if (row.type === "code") {
    const code = document.createElement("pre");
    code.className = "mn-prefs-code";
    code.textContent = row.text;
    el.append(code);
    return el;
  }
  if (row.type === "info") {
    el.innerHTML = `<span class="mn-prefs-label">${escape(row.label)}</span><span class="mn-prefs-value" title="${escape(
      row.value || ""
    )}">${escape(row.value || "")}</span>`;
    return el;
  }
  if (row.type === "action") {
    el.innerHTML = `<span class="mn-prefs-label">${escape(row.label)}</span>`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mn-btn mn-btn-quiet";
    button.textContent = row.buttonLabel;
    button.disabled = Boolean(row.disabled);
    if (row.disabled) button.title = row.disabledReason || "Coming soon";
    button.addEventListener("click", () => row.run());
    el.append(button);
    return el;
  }
  if (row.type === "toggle") {
    const check = document.createElement("label");
    check.className = "mn-prefs-check";
    check.innerHTML = `<input type="checkbox" ${row.checked ? "checked" : ""} /><span class="mn-prefs-check-box"></span><span>${escape(
      row.label
    )}</span>`;
    check.querySelector("input").addEventListener("change", (event) => row.onChange(event.target.checked));
    el.append(check);
    return el;
  }
  if (row.type === "select") {
    el.innerHTML = `<span class="mn-prefs-label">${escape(row.label)}</span>`;
    const wrap = document.createElement("span");
    wrap.className = "ky-select mn-prefs-select";
    const select = document.createElement("select");
    select.className = "ky-input";
    for (const [value, label] of row.options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      if (String(value) === String(row.value)) option.selected = true;
      select.append(option);
    }
    const chevron = document.createElement("span");
    chevron.className = "ky-chevron";
    chevron.setAttribute("aria-hidden", "true");
    wrap.append(select, chevron);
    select.disabled = Boolean(row.disabled);
    if (row.disabled) wrap.title = row.disabledReason || "Coming soon";
    select.addEventListener("change", () => row.onChange(select.value));
    el.append(wrap);
    window.KySelect?.enhanceAll(el);
    return el;
  }
  return el;
}

async function exportBoard() {
  try {
    const path = await exportCurrentBoard();
    if (settings.exportClipboard) {
      try {
        await navigator.clipboard.writeText(JSON.stringify(state.board));
      } catch {
        /* clipboard unavailable */
      }
    }
    setStatus(path ? `Exported to ${path}` : "Board exported");
  } catch (error) {
    setStatus("Export failed: " + error);
  }
}

function escape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Kick the async path + app data folder lazily.
loadPath();
window.addEventListener("mn:settings-changed", () => applyGlobalSettings());

