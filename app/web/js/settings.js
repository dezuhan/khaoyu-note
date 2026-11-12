// Settings dialog in the Photon preferences style, plus persisted app preferences.

import * as bridge from "./bridge.js";
import {
  authState,
  changePassword,
  loadHistory,
  logout,
  logoutAll,
  subscribeAuth,
  updateProfile,
} from "./auth.js";
import { AUTO_BACKUP_OPTIONS, formatLastBackup, lastBackupAt, markBackupTaken } from "./auto-backup.js";
import { icon } from "./icons.js";
import { LANGUAGES, getLanguage, setLanguage, t } from "./i18n.js";
import { toolDisabledReason } from "./limits.js";
import { exportCurrentBoard, history, notify, setTheme, state, prepareForReset } from "./store.js";
import { checkConnection, describeConnection, loadSyncConfig, saveSyncConfig, signOut } from "./sync.js";
import { currentVersion, initCurrentVersion, releaseSummary } from "./update.js";
import { openSyncDialog } from "./sync-ui.js";
import {
  canDeleteTemplate,
  createTemplateFromSelection,
  deleteTemplate,
  listTemplates,
  restoreBuiltInTemplates,
} from "./templates.js";

export const DEFAULT_TOOL_ORDER = [
  "note",
  "link",
  "todo",
  "line",
  "board",
  "column",
  "section",
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
  autoBackupDays: 0,
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
  { id: "server", label: "Server" },
  { id: "backup", label: "Backup" },
  { divider: true },
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "tools", label: "Tools" },
  { id: "templates", label: "Board templates" },
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
  ["section", "Section"],
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
let systemGraphics = null;
let storageStats = null;
let overlay = null;
let activePage = "server";
let accountTab = "information";
let query = "";
let searchTimer = 0;
let saveTimer = 0;
let statusText = "";

function errorText(error, fallback) {
  return error?.message || (typeof error === "string" ? error : "") || fallback;
}

function formatBytes(value) {
  if (!Number.isFinite(Number(value))) return "Calculating...";
  const bytes = Math.max(0, Number(value));
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function loadStorageStats() {
  try {
    storageStats = await bridge.storageStats();
    if (overlay && (activePage === "about" || activePage === "server")) renderContent();
  } catch {
    storageStats = null;
  }
}

async function loadSystemGraphics() {
  if (!bridge.hasTauri) return;
  try {
    systemGraphics = await bridge.graphicsInfo();
    if (overlay && activePage === "performance") renderContent();
  } catch {
    systemGraphics = null;
  }
}

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
  void loadSystemGraphics();
  void loadStorageStats();
  subscribeAuth(() => {
    if (overlay && activePage === "account" && !query) renderContent();
  });
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

export function openSettingsPage(page = null) {
  if (overlay) {
    if (page && pages().some((entry) => !entry.divider && entry.id === page)) {
      activePage = page;
      renderNav();
      renderContent();
    }
    return;
  }
  if (page && pages().some((entry) => !entry.divider && entry.id === page)) {
    activePage = page;
  }
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
  if (/Linux/.test(ua)) return "WebKitGTK 4.1 (Linux)";
  if (/Mac OS X/.test(ua)) return "WKWebView (macOS)";
  if (/Windows/.test(ua)) return "WebView2 (Windows)";
  return "Unknown webview";
}

function pages() {
  return [
    {
      id: "server",
      title: t("nav.server"),
      divider: false,
      rows: () => [
        {
          type: "note",
          text: "Local runtime details and the optional self-hosted service connection.",
        },
      ],
    },
    {
      id: "backup",
      title: t("nav.backup"),
      rows: () => [
        { type: "note", text: "Back up or export the local database, assets and settings." },
      ],
    },
    { divider: true },
    {
      id: "general",
      title: t("nav.general"),
      rows: () => [
        {
          type: "select",
          label: t("general.language"),
          value: getLanguage(),
          options: LANGUAGES.map((language) => [language.id, language.native]),
          onChange: (value) => {
            setLanguage(value);
            if (overlay) {
              renderNav();
              renderContent();
            }
          },
        },
        note(t("general.languageNote")),
        toggle(t("general.autoUpdate"), "autoUpdateOpenDocuments"),
        toggle(t("general.exportClipboard"), "exportClipboard"),
        {
          type: "select",
          label: t("general.imageInterpolation"),
          value: settings.imageInterpolation,
          options: [
            ["bicubic", t("general.bicubic")],
            ["nearest", t("general.nearest")],
          ],
          onChange: (value) => {
            setValue("imageInterpolation", value);
            applyGlobalSettings();
          },
        },
        {
          type: "action",
          label: t("general.boardJson"),
          buttonLabel: t("general.export"),
          run: () => exportBoard(),
        },
      ],
    },
    {
      id: "appearance",
      title: t("nav.appearance"),
      rows: () => [
        {
          type: "select",
          label: t("appearance.theme"),
          value: state.theme,
          options: [
            ["light", t("appearance.light")],
            ["softLight", t("appearance.softLight")],
            ["softDark", t("appearance.softDark")],
            ["dark", t("appearance.dark")],
          ],
          onChange: (value) => setTheme(value),
        },
        {
          type: "select",
          label: t("appearance.headingFont"),
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
          label: t("appearance.bodyFont"),
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
          label: t("appearance.codeFont"),
          key: "codeFont",
          value: settings.codeFont || DEFAULT_SETTINGS.codeFont,
          options: FONT_CHOICES,
          onChange: (value) => {
            setValue("codeFont", value);
            applyGlobalSettings();
          },
        },
        toggle(t("appearance.reduceMotion"), "reduceMotion", () => applyGlobalSettings()),
        note(t("appearance.canvas")),
        {
          type: "select",
          label: t("appearance.gridSize"),
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
          label: t("appearance.showGrid"),
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
          label: t("appearance.zoom"),
          buttonLabel: t("appearance.resetZoom"),
          run: () => {
            state.view.zoom = 1;
            notify("view");
          },
        },
      ],
    },
    {
      id: "tools",
      title: t("nav.tools"),
      rows: () =>
        TOOL_LABELS.map(([key, label]) => ({
          type: "toggle",
          label: t(`tool.${key}`, label),
          checked: !settings.hiddenTools.includes(key),
          onChange: () => {},
        })),
    },
    {
      id: "templates",
      title: t("nav.templates"),
      rows: () => [
        note("Create templates from a board selection, then manage the library here."),
      ],
    },
    {
      id: "performance",
      title: t("nav.performance"),
      rows: () => {
        const gpu = probeGpu();
        const cpu = probeCpu();
        const gpuOn = settings.gpuAcceleration !== false;
        const isLinux = /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
        return [
          {
            type: "toggle",
            label: t("performance.gpu"),
            checked: gpuOn,
            onChange: (checked) => {
              settings.gpuAcceleration = checked;
              bridge.setSetting("gpu_acceleration", String(checked)).catch(() => {});
              persist();
              renderContent();
            },
          },
          info(
            t("performance.currentMode"),
            gpuOn
              ? isLinux && !gpu.available
                ? "GPU requested via WebKitGTK"
                : "GPU (hardware accelerated)"
              : "CPU (software rendering)"
          ),
          {
            type: "toggle",
            label: t("performance.reducedEffects"),
            checked: document.documentElement.dataset.performance === "true",
            onChange: async (checked) => {
              const ui = await import("./ui.js");
              ui.setPerformanceMode(checked);
            },
          },
          ...(systemGraphics?.gpus?.length
            ? systemGraphics.gpus.map((name, index) =>
                info(index ? `GPU ${index + 1}` : "System GPU", name)
              )
            : []),
          info(
            "GPU (WebGL)",
            isLinux && !gpu.available ? "Hidden by WebKitGTK" : gpu.renderer
          ),
          info("GPU vendor (WebGL)", gpu.vendor),
          info("Graphics API", gpu.version),
          info("CPU", cpu.cores),
          info("Memory", cpu.memory),
          info("Platform", cpu.platform),
          info("WebView", webviewLabel()),
          note(
            "GPU acceleration is applied by the Rust host when the window is created; the CPU fallback uses Chromium software rendering. Restart the app after changing it."
          ),
          ...(systemGraphics?.gpus?.length
            ? [
                note(
                  "System GPU names are read from the operating system. The WebGL renderer string is sanitized by the webview and is only a hint, which is why it can show a generic or older model."
                ),
              ]
            : []),
          ...(isLinux
            ? [
                note(
                  "Linux runs through WebKitGTK. This build now applies WebKit's hardware-acceleration policy from this toggle. WebGL renderer strings are masked, so the probe is only a hint. If it still feels slow, launch with KHAOYU_DEBUG_GRAPHICS=1 to log the policy and environment, or KHAOYU_FORCE_GPU=1 to clear inherited software-rendering variables. For NVIDIA + Wayland, __NV_DISABLE_EXPLICIT_SYNC=1 is applied automatically; WEBKIT_DISABLE_DMABUF_RENDERER=1 is the fallback when the window flickers."
                ),
              ]
            : []),
          {
            type: "action",
            label: t("performance.apply"),
            buttonLabel: t("performance.restart"),
            run: () => bridge.restartApp(),
          },
        ];
      },
    },
    { divider: true },
    {
      id: "mcp",
      title: t("nav.mcp"),
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
      title: t("nav.about"),
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
        info(
          t("stats.database"),
          formatBytes(
            storageStats
              ? Number(storageStats.databaseBytes || 0) + Number(storageStats.walBytes || 0)
              : null
          )
        ),
        info(t("stats.assets"), formatBytes(storageStats?.assetsBytes)),
        info(t("stats.total"), formatBytes(storageStats?.totalBytes)),
        info("Projects", String(state.boards.filter((board) => !board.parentId).length)),
        info("Nested boards", String(state.boards.filter((board) => board.parentId).length)),
        note("Local-first visual boards. Accounts and server sync are optional."),
        {
          type: "action",
          label: t("about.feedback"),
          buttonLabel: t("about.open"),
          run: () => bridge.openExternal("https://github.com/dezuhan/khaoyu-note/issues/new"),
        },
        {
          type: "action",
          label: "Reset everything",
          buttonLabel: "Reset app data",
          run: async () => {
            const { confirmAction } = await import("./ui.js");
            const confirmed = await confirmAction({
              title: "Reset Khaoyu Note?",
              message:
                "This permanently deletes every board, card, connection, uploaded file, account, setting and activity entry in this database. The app will start again like a fresh installation. This cannot be undone.",
              confirmLabel: "Reset everything",
            });
            if (!confirmed) return;
            prepareForReset();
            try {
              await bridge.resetAllData();
              for (const key of Object.keys(localStorage)) {
                if (key.startsWith("mn.")) localStorage.removeItem(key);
              }
              sessionStorage.clear();
              localStorage.setItem("mn.setupRequired", "1");
              window.location.reload();
            } catch (error) {
              setStatus(error?.message || "Could not reset the app data.");
              // The in-memory state was cleared; reload to restore it from the database.
              setTimeout(() => window.location.reload(), 1500);
            }
          },
        },
        note(
          "Reset everything wipes the local database and preferences. GitHub releases and the separate self-hosted service are not affected."
        ),
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
  content.scrollTop = 0;
  const titleEl = overlay.querySelector(".mn-prefs-title");
  if (titleEl) titleEl.textContent = t("common.settings");
  const searchEl = overlay.querySelector('[data-role="search"]');
  if (searchEl) searchEl.placeholder = t("common.search");
  const resetEl = overlay.querySelector('[data-role="reset"]');
  if (resetEl) resetEl.textContent = t("common.reset");
  const doneEl = overlay.querySelector('[data-role="done"]');
  if (doneEl) doneEl.textContent = t("common.done");

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
  if (activePage === "server") {
    renderServerPage(content);
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
  } else if (activePage === "templates") {
    content.append(heading("Board templates"));
    renderTemplatesPage(content);
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

function renderServerRuntime(content) {
  const box = document.createElement("div");
  box.className = "mn-account-status mn-server-runtime";
  const title = document.createElement("div");
  title.className = "mn-account-server";
  title.textContent = "This computer";
  box.append(title);
  const mode = bridge.webInfo
    ? "Web host"
    : bridge.hasTauri
      ? "Desktop app"
      : "Browser preview";
  const rows = [
    ["Mode", mode],
    ["Version", currentVersion() || "unknown"],
    ["Database", awaitPath()],
  ];
  if (bridge.webInfo) {
    rows.push(["Host", `${bridge.webInfo.host}:${bridge.webInfo.port}`]);
    rows.push(["URL", bridge.webInfo.url]);
    if (Array.isArray(bridge.webInfo.urls) && bridge.webInfo.urls.length) {
      rows.push(["Share URLs", bridge.webInfo.urls.join(", ")]);
    }
  }
  for (const [label, value] of rows) {
    const line = document.createElement("div");
    line.className = "mn-account-server";
    line.textContent = `${label}: ${value}`;
    box.append(line);
  }
  content.append(box);
}

function resizeAvatarImage(file) {
  return new Promise((resolve, reject) => {
    if (!file || !String(file.type || "").startsWith("image/")) {
      reject(new Error("Choose a PNG, JPEG or GIF image."));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      reject(new Error("The image must be under 10 MB."));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the image."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("Could not load the image."));
      image.onload = () => {
        const size = 256;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        const scale = Math.max(size / image.width, size / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.86));
      };
      image.src = String(reader.result || "");
    };
    reader.readAsDataURL(file);
  });
}

const ACCOUNT_HISTORY_LABELS = {
  "auth.setup": "Admin account created",
  "auth.login": "Signed in",
  "auth.logout": "Signed out",
  "auth.logout_all": "Signed out of every session",
  "auth.password_changed": "Password changed",
  "auth.profile_updated": "Profile updated",
  "board.created": "Created board",
  "board.updated": "Updated board",
  "board.renamed": "Renamed board",
  "board.archived": "Archived board",
  "board.unarchived": "Unarchived board",
  "board.trashed": "Moved board to trash",
  "board.restored": "Restored board",
  "board.deleted": "Deleted board",
};

function accountDisplayName(user) {
  if (!user) return "Account";
  return user.displayName || `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.username;
}

function accountInitials(user) {
  const source = String(user?.firstName || user?.username || "").trim();
  return source ? source.charAt(0).toUpperCase() : "?";
}

function accountRoleLabel(user) {
  if (!user) return "Guest";
  if (user.role === "admin") return "Admin";
  return `Member (${user.memberRole || "editor"})`;
}

function accountStamp(value) {
  if (!value) return "Unknown";
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function accountHistoryLabel(action) {
  return ACCOUNT_HISTORY_LABELS[action] || String(action || "Account activity").replace(/[._]/g, " ");
}

function accountInformationTab(pane) {
  const user = authState().user;
  if (!user) return;
  const head = document.createElement("div");
  head.className = "mn-account-info-head";
  const avatar = document.createElement("span");
  avatar.className = "mn-profile-avatar";
  if (user.avatarUrl) {
    avatar.classList.add("has-image");
    avatar.style.backgroundImage = `url("${user.avatarUrl}")`;
  } else {
    avatar.textContent = accountInitials(user);
  }
  const copy = document.createElement("div");
  copy.className = "mn-account-identity-copy";
  const name = document.createElement("strong");
  name.textContent = accountDisplayName(user);
  const handle = document.createElement("span");
  handle.textContent = `@${user.username} · ${accountRoleLabel(user)}`;
  copy.append(name, handle);
  head.append(avatar, copy);
  pane.append(head);

  const rows = [
    ["Username", `@${user.username}`],
    ["Email", user.email || "Not set"],
    ["Role", accountRoleLabel(user)],
    ["Status", user.status === "disabled" ? "Disabled" : "Active"],
    ["Account type", "Local account"],
    ["Member since", accountStamp(user.createdAt)],
    ["Last login", accountStamp(user.lastLoginAt)],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    row.className = "mn-account-row";
    const left = document.createElement("span");
    left.textContent = label;
    const right = document.createElement("span");
    right.className = "mn-account-value";
    right.textContent = value;
    row.append(left, right);
    pane.append(row);
  }
}

function accountHistoryTab(pane) {
  const note = document.createElement("p");
  note.className = "mn-prefs-note";
  note.textContent = "Account and board actions recorded on this computer.";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "mn-btn mn-btn-quiet";
  refresh.textContent = "Refresh";
  const box = document.createElement("div");
  box.className = "mn-account-history";
  box.textContent = "Loading history...";
  const fill = async () => {
    try {
      const data = await loadHistory(50, 0);
      const entries = Array.isArray(data?.entries) ? data.entries : [];
      box.innerHTML = "";
      if (!entries.length) {
        box.textContent = "No account activity yet.";
        return;
      }
      for (const entry of entries) {
        const row = document.createElement("div");
        row.className = "mn-account-history-row";
        const action = document.createElement("span");
        action.className = "mn-account-history-action";
        action.textContent = accountHistoryLabel(entry.action);
        const time = document.createElement("span");
        time.className = "mn-account-history-time";
        time.textContent = accountStamp(entry.createdAt);
        row.append(action, time);
        box.append(row);
      }
    } catch {
      box.textContent = "History is unavailable.";
    }
  };
  refresh.addEventListener("click", () => {
    box.textContent = "Loading history...";
    void fill();
  });
  pane.append(note, refresh, box);
  void fill();
}

function accountAdminTab(pane) {
  const user = authState().user;
  if (!user) return;
  const grid = document.createElement("div");
  grid.className = "mn-admin-grid";
  const card = (label, value, role = "") => {
    const item = document.createElement("div");
    item.className = "mn-admin-card";
    const title = document.createElement("span");
    title.textContent = label;
    const body = document.createElement("strong");
    body.textContent = value;
    if (role) body.dataset.role = role;
    item.append(title, body);
    return item;
  };
  grid.append(
    card("Accounts", `${authState().userCount} ${authState().userCount === 1 ? "account" : "accounts"}`),
    card("Your role", accountRoleLabel(user)),
    card("App version", "Loading...", "admin-version")
  );
  void bridge
    .appVersion()
    .then((version) => {
      const target = pane.querySelector('[data-role="admin-version"]');
      if (target) target.textContent = version || "unknown";
    })
    .catch(() => {});
  const actions = document.createElement("div");
  actions.className = "mn-account-actions";
  const backup = document.createElement("button");
  backup.type = "button";
  backup.className = "mn-btn";
  backup.textContent = t("backup.now");
  const integrity = document.createElement("button");
  integrity.type = "button";
  integrity.className = "mn-btn";
  integrity.textContent = "Check database";
  const status = document.createElement("p");
  status.className = "mn-profile-status";
  status.setAttribute("role", "status");
  backup.addEventListener("click", async () => {
    status.textContent = t("backup.creating");
    try {
      const path = await bridge.backupData();
      status.textContent = `Backup created: ${path}`;
    } catch (error) {
      status.textContent = error?.message || "Backup failed";
    }
  });
  integrity.addEventListener("click", async () => {
    status.textContent = "Checking database...";
    try {
      status.textContent = `Integrity: ${await bridge.dbIntegrity()}`;
    } catch (error) {
      status.textContent = error?.message || "Integrity check failed";
    }
  });
  actions.append(backup, integrity);
  const note = document.createElement("p");
  note.className = "mn-prefs-note";
  note.textContent = "User management, role changes and the full audit view arrive in M3.";
  pane.append(grid, actions, status, note);
}

function accountDeleteTab(pane) {
  const user = authState().user;
  if (!user) return;
  const box = document.createElement("div");
  box.className = "mn-account-danger";

  const title = document.createElement("h3");
  title.textContent = "Delete account and reset data";
  const warning = document.createElement("p");
  warning.className = "mn-prefs-note";
  warning.textContent =
    "This permanently deletes every local board, card, connection, asset, account, session, setting and activity entry in the database on this computer. The app then returns to first-run setup for a new user. This cannot be undone.";

  const list = document.createElement("ul");
  list.className = "mn-account-danger-list";
  for (const item of [
    "All boards, cards and connections",
    "All uploaded images and files",
    "All local accounts and sessions",
    "All settings, history and activity",
  ]) {
    const entry = document.createElement("li");
    entry.textContent = item;
    list.append(entry);
  }

  const note = document.createElement("p");
  note.className = "mn-prefs-note";
  note.textContent =
    "GitHub releases and the separate self-hosted service are not affected; this only resets the local database.";

  const form = document.createElement("form");
  form.className = "mn-account-danger-form";
  const passwordLabel = document.createElement("label");
  passwordLabel.textContent = "Current password";
  const password = document.createElement("input");
  password.className = "ky-input";
  password.type = "password";
  password.name = "password";
  password.autocomplete = "current-password";
  password.placeholder = "Current account password";
  passwordLabel.append(password);

  const confirmLabel = document.createElement("label");
  confirmLabel.textContent = "Type DELETE ALL to confirm";
  const confirmation = document.createElement("input");
  confirmation.className = "ky-input";
  confirmation.type = "text";
  confirmation.name = "confirmation";
  confirmation.autocomplete = "off";
  confirmation.spellcheck = false;
  confirmation.placeholder = "DELETE ALL";
  confirmLabel.append(confirmation);

  const status = document.createElement("p");
  status.className = "mn-profile-status";
  status.setAttribute("role", "status");

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "mn-btn mn-btn-danger";
  submit.textContent = "Delete account and reset";

  form.append(passwordLabel, confirmLabel, status, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!password.value) {
      status.textContent = "Enter your current password.";
      return;
    }
    if (confirmation.value.trim() !== "DELETE ALL") {
      status.textContent = "Type DELETE ALL exactly as shown.";
      return;
    }
    submit.disabled = true;
    password.disabled = true;
    confirmation.disabled = true;
    status.textContent = "Deleting the local database...";
    prepareForReset();
    try {
      await bridge.authResetDatabase({
        password: password.value,
        confirmation: "DELETE ALL",
      });
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("mn.")) localStorage.removeItem(key);
      }
      sessionStorage.clear();
      status.textContent = "Done. Starting fresh...";
      window.location.reload();
    } catch (error) {
      status.textContent = error?.message || "Could not reset the database.";
      submit.disabled = false;
      password.disabled = false;
      confirmation.disabled = false;
      setTimeout(() => window.location.reload(), 1500);
    }
  });

  box.append(title, warning, list, note, form);
  pane.append(box);
}

async function performAccountLogout(all = false) {
  try {
    if (all) await logoutAll();
    else await logout();
  } catch (error) {
    window.dispatchEvent(
      new CustomEvent("mn:toast", {
        detail: { message: error?.message || "Could not log out" },
      })
    );
    return;
  }
  window.location.reload();
}

function renderAccountPage(content) {
  content.append(heading("Account"));
  const user = authState().user;
  if (!user) {
    renderSignedOutAccount(content);
    return;
  }

  const tabs = [];
  if (user.role === "admin") tabs.push(["admin", "Admin Dashboard"]);
  tabs.push(
    ["information", "Account Information"],
    ["settings", "Account Settings"],
    ["history", "History Activity"],
    ["delete", "Delete Account"]
  );
  if (!tabs.some(([id]) => id === accountTab)) accountTab = "information";

  const tabbar = renderAccountTabs(tabs);
  content.append(tabbar);

  const pane = document.createElement("div");
  pane.className = "mn-account-tab-pane";
  if (accountTab === "admin" && user.role === "admin") accountAdminTab(pane);
  else if (accountTab === "settings") renderAccountSettingsTab(pane);
  else if (accountTab === "history") accountHistoryTab(pane);
  else if (accountTab === "delete") accountDeleteTab(pane);
  else accountInformationTab(pane);
  content.append(pane);

  const footer = document.createElement("div");
  footer.className = "mn-account-tab-foot";
  const out = document.createElement("button");
  out.type = "button";
  out.className = "mn-btn mn-btn-danger-outline";
  out.textContent = "Log Out";
  out.addEventListener("click", () => void performAccountLogout(false));
  footer.append(out);
  content.append(footer);
}

function renderAccountTabs(tabs) {
  const tabbar = document.createElement("div");
  tabbar.className = "mn-account-tabs";
  tabbar.setAttribute("role", "tablist");
  for (const [id, label] of tabs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `mn-account-tab${id === accountTab ? " is-active" : ""}${
      id === "delete" ? " is-danger" : ""
    }`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(id === accountTab));
    button.textContent = label;
    button.addEventListener("click", () => {
      accountTab = id;
      renderContent();
    });
    tabbar.append(button);
  }
  return tabbar;
}

function renderSignedOutAccount(content) {
  const tabs = [
    ["information", "Account Information"],
    ["settings", "Account Settings"],
    ["history", "History Activity"],
  ];
  if (!tabs.some(([id]) => id === accountTab)) accountTab = "information";
  content.append(renderAccountTabs(tabs));

  const pane = document.createElement("div");
  pane.className = "mn-account-tab-pane";
  const box = document.createElement("div");
  box.className = "mn-account-guest";
  const title = document.createElement("h3");
  title.textContent =
    accountTab === "history"
      ? "Sign in to see activity"
      : accountTab === "settings"
        ? "Sign in to edit your account"
        : "You are not signed in";
  const note = document.createElement("p");
  note.className = "mn-prefs-note";
  note.textContent =
    "Account Information, Account Settings and History Activity are available after sign in on this computer.";
  const signIn = document.createElement("button");
  signIn.type = "button";
  signIn.className = "mn-btn mn-btn-primary";
  signIn.textContent = "Sign In";
  signIn.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("mn:open-login"));
  });
  box.append(title, note, signIn);
  if (!bridge.hasTauri && !bridge.hasWeb) {
    const preview = document.createElement("p");
    preview.className = "mn-prefs-note";
    preview.textContent =
      "This browser preview has no account backend. Run the desktop app or the web host to sign in.";
    box.append(preview);
  }
  pane.append(box);
  content.append(pane);
}

function renderAccountSettingsTab(container) {
  const user = authState().user;
  if (!user) return;

  let avatarUrl = user.avatarUrl || "";
  const page = document.createElement("div");
  page.className = "mn-profile";

  const status = document.createElement("p");
  status.className = "mn-profile-status";
  status.setAttribute("role", "status");
  const setStatus = (message, isError = false) => {
    statusText = message || "";
    status.textContent = statusText;
    status.classList.toggle("is-error", Boolean(isError));
  };

  // ---------------------------------------------------------------- picture
  const picture = document.createElement("section");
  picture.className = "mn-profile-section mn-profile-picture";
  const preview = document.createElement("span");
  preview.className = "mn-profile-avatar";
  const paintAvatar = () => {
    preview.classList.toggle("has-image", Boolean(avatarUrl));
    preview.style.backgroundImage = avatarUrl ? `url("${avatarUrl}")` : "";
    preview.textContent = avatarUrl
      ? ""
      : String(user.firstName || user.username || "?").trim().charAt(0).toUpperCase();
  };
  paintAvatar();
  const pictureCopy = document.createElement("div");
  pictureCopy.className = "mn-profile-picture-copy";
  const pictureTitle = document.createElement("h3");
  pictureTitle.textContent = "Profile Picture";
  const pictureHint = document.createElement("p");
  pictureHint.className = "mn-prefs-note";
  pictureHint.textContent = "We support PNG, JPEG and GIF images under 10 MB. They are cropped to 256 px.";
  const uploadInput = document.createElement("input");
  uploadInput.type = "file";
  uploadInput.accept = "image/png,image/jpeg,image/gif";
  uploadInput.hidden = true;
  const upload = document.createElement("button");
  upload.type = "button";
  upload.className = "mn-btn mn-btn-primary";
  upload.innerHTML = `${icon("upload", 14)}<span>Upload Image</span>`;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "mn-btn";
  remove.textContent = "Remove";
  const pictureActions = document.createElement("div");
  pictureActions.className = "mn-account-actions";
  pictureActions.append(upload, remove);
  upload.addEventListener("click", () => uploadInput.click());
  uploadInput.addEventListener("change", async () => {
    const file = uploadInput.files && uploadInput.files[0];
    uploadInput.value = "";
    if (!file) return;
    upload.disabled = true;
    try {
      avatarUrl = await resizeAvatarImage(file);
      paintAvatar();
      setStatus("Image ready. Choose Save to apply it.");
    } catch (error) {
      setStatus(error?.message || "Could not use that image.", true);
    } finally {
      upload.disabled = false;
    }
  });
  remove.addEventListener("click", () => {
    avatarUrl = "";
    paintAvatar();
    setStatus("Image removed. Choose Save to apply it.");
  });
  pictureCopy.append(pictureTitle, pictureActions, pictureHint);
  picture.append(preview, pictureCopy);

  // ---------------------------------------------------------------- details
  const details = document.createElement("section");
  details.className = "mn-profile-section";
  const names = document.createElement("div");
  names.className = "mn-profile-grid";
  const makeField = (label, name, value, type = "text", autocomplete = "") => {
    const field = document.createElement("label");
    field.className = "mn-profile-field";
    const text = document.createElement("span");
    text.textContent = label;
    const input = document.createElement("input");
    input.className = "ky-input";
    input.name = name;
    input.type = type;
    input.value = value;
    if (autocomplete) input.autocomplete = autocomplete;
    field.append(text, input);
    return field;
  };
  names.append(
    makeField("First Name", "firstName", user.firstName, "text", "given-name"),
    makeField("Last Name", "lastName", user.lastName, "text", "family-name")
  );
  const emailField = makeField("Email", "email", user.email, "email", "email");
  const emailHint = document.createElement("p");
  emailHint.className = "mn-prefs-note";
  emailHint.textContent = "Used to log in to your account.";
  details.append(names, emailField, emailHint);

  // ---------------------------------------------------------------- password
  const security = document.createElement("section");
  security.className = "mn-profile-section mn-profile-security";
  const securityCopy = document.createElement("div");
  const securityTitle = document.createElement("h3");
  securityTitle.textContent = "Password";
  const securityNote = document.createElement("p");
  securityNote.className = "mn-prefs-note";
  securityNote.textContent = "Log in with your password instead of a temporary code.";
  securityCopy.append(securityTitle, securityNote);
  const change = document.createElement("button");
  change.type = "button";
  change.className = "mn-btn";
  change.textContent = "Change Password";
  const passwordForm = document.createElement("form");
  passwordForm.className = "mn-profile-password";
  passwordForm.hidden = true;
  const currentPassword = document.createElement("input");
  currentPassword.className = "ky-input";
  currentPassword.type = "password";
  currentPassword.name = "currentPassword";
  currentPassword.placeholder = "Current password";
  currentPassword.autocomplete = "current-password";
  const newPassword = document.createElement("input");
  newPassword.className = "ky-input";
  newPassword.type = "password";
  newPassword.name = "newPassword";
  newPassword.placeholder = "New password (12 or more characters)";
  newPassword.autocomplete = "new-password";
  const confirmPassword = document.createElement("input");
  confirmPassword.className = "ky-input";
  confirmPassword.type = "password";
  confirmPassword.name = "confirmPassword";
  confirmPassword.placeholder = "Confirm new password";
  confirmPassword.autocomplete = "new-password";
  const passwordStatus = document.createElement("p");
  passwordStatus.className = "mn-profile-status";
  passwordStatus.setAttribute("role", "status");
  const passwordActions = document.createElement("div");
  passwordActions.className = "mn-account-actions";
  const updatePassword = document.createElement("button");
  updatePassword.type = "submit";
  updatePassword.className = "mn-btn mn-btn-primary";
  updatePassword.textContent = "Update password";
  const cancelPassword = document.createElement("button");
  cancelPassword.type = "button";
  cancelPassword.className = "mn-btn mn-btn-quiet";
  cancelPassword.textContent = "Cancel";
  passwordActions.append(updatePassword, cancelPassword);
  passwordForm.append(currentPassword, newPassword, confirmPassword, passwordStatus, passwordActions);
  change.addEventListener("click", () => {
    passwordForm.hidden = !passwordForm.hidden;
    if (!passwordForm.hidden) currentPassword.focus();
  });
  cancelPassword.addEventListener("click", () => {
    passwordForm.hidden = true;
    passwordForm.reset();
    passwordStatus.textContent = "";
  });
  passwordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!currentPassword.value) {
      passwordStatus.textContent = "Enter your current password.";
      return;
    }
    if (newPassword.value.length < 12) {
      passwordStatus.textContent = "Use at least 12 characters for the new password.";
      return;
    }
    if (newPassword.value !== confirmPassword.value) {
      passwordStatus.textContent = "The new passwords do not match.";
      return;
    }
    updatePassword.disabled = true;
    passwordStatus.textContent = "Changing password...";
    try {
      await changePassword({
        currentPassword: currentPassword.value,
        newPassword: newPassword.value,
      });
      passwordForm.reset();
      passwordForm.hidden = true;
      passwordStatus.textContent = "";
      notify("Password changed");
    } catch (error) {
      passwordStatus.textContent = error?.message || "Could not change the password.";
    } finally {
      updatePassword.disabled = false;
    }
  });
  security.append(securityCopy, change, passwordForm);

  // ---------------------------------------------------------------- footer
  const footer = document.createElement("div");
  footer.className = "mn-profile-foot";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "mn-btn";
  cancel.textContent = "Cancel";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "mn-btn mn-btn-primary";
  save.textContent = "Save";
  footer.append(cancel, save);
  cancel.addEventListener("click", () => {
    const current = authState().user;
    if (!current) return;
    names.querySelector('input[name="firstName"]').value = current.firstName;
    names.querySelector('input[name="lastName"]').value = current.lastName;
    emailField.querySelector('input[name="email"]').value = current.email;
    avatarUrl = current.avatarUrl || "";
    paintAvatar();
    passwordForm.hidden = true;
    passwordForm.reset();
    setStatus("Changes discarded.");
  });
  save.addEventListener("click", async () => {
    const firstName = names.querySelector('input[name="firstName"]').value.trim();
    const lastName = names.querySelector('input[name="lastName"]').value.trim();
    const email = emailField.querySelector('input[name="email"]').value.trim();
    if (!firstName) {
      setStatus("Enter your first name.", true);
      return;
    }
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
      setStatus("Enter a valid email address.", true);
      return;
    }
    save.disabled = true;
    setStatus("Saving...");
    try {
      await updateProfile({ firstName, lastName, email, avatarUrl });
      notify("Profile saved");
    } catch (error) {
      setStatus(error?.message || "Could not save the profile.", true);
    } finally {
      save.disabled = false;
    }
  });

  page.append(picture, details, security, footer, status);
  container.append(page);
}

function renderPublicShareSetting(content, config) {
  const box = document.createElement("div");
  box.className = "mn-account-status mn-public-share";
  const title = document.createElement("div");
  title.className = "mn-account-server";
  title.textContent = "Public share links";
  const note = document.createElement("p");
  note.className = "mn-prefs-note";
  note.textContent =
    "Optional public origin used in share links and board links (for example a domain, tunnel, or public IP). The host still needs port forwarding, a tunnel or a reverse proxy so the address reaches this service; HTTPS is recommended.";
  const row = document.createElement("div");
  row.className = "mn-share-copy-row";
  const input = document.createElement("input");
  input.className = "ky-input";
  input.type = "url";
  input.placeholder = "https://notes.example.com or http://203.0.113.10:8080";
  input.value = config.publicShareUrl || "";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "mn-btn";
  save.textContent = "Save public URL";
  const savePublicUrl = () => {
    const current = loadSyncConfig();
    try {
      const saved = saveSyncConfig({
        url: current.url,
        email: current.email,
        token: current.token,
        publicShareUrl: input.value.trim(),
      });
      input.value = saved.publicShareUrl;
      setStatus(
        saved.publicShareUrl
          ? `Share links will use ${saved.publicShareUrl}`
          : "Share links will use the sync server URL"
      );
    } catch (error) {
      setStatus(error.message || "Enter a valid public URL");
    }
  };
  save.addEventListener("click", savePublicUrl);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      savePublicUrl();
    }
  });
  row.append(input, save);
  box.append(title, note, row);
  content.append(box);
}

function renderServerPage(content) {
  content.append(heading("Server"));
  const config = loadSyncConfig();
  const intro = document.createElement("p");
  intro.className = "mn-prefs-note";
  intro.textContent =
    "Connection details for this computer and the optional self-hosted service.";
  content.append(intro);
  renderServerRuntime(content);
  renderPublicShareSetting(content, config);
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
  const addActionCard = (title, description, path, role = "") => {
    const card = document.createElement("div");
    card.className = "mn-account-card";
    if (role) card.dataset.action = role;
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
    return card;
  };
  grid.append(
    addActionCard(
      "Open account",
      "Create or sign in, reset password, manage sessions and API tokens.",
      "/admin"
    )
  );
  const shareCard = addActionCard(
    "Sharing",
    "Create and revoke public board or card links.",
    "/shares"
  );
  grid.append(shareCard);
  content.append(grid);

  // Passkeys can be switched off by the service operator; hide the entry instead of opening a 404.
  // Without a connected service the account/passkey actions are not usable, so keep them hidden.
  void (async () => {
    if (!config.url || !config.token) return;
    try {
      const response = await fetch(`${serviceBase()}/api/v1/auth/features`, {
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) return;
      const features = await response.json();
      if (!features.passkeysEnabled) return;
      grid.insertBefore(
        addActionCard("Passkeys", "Register or use a WebAuthn passkey.", "/passkeys", "passkeys"),
        shareCard
      );
    } catch {
      /* feature endpoint unreachable: keep passkeys hidden */
    }
  })();

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

function renderTemplatesPage(content) {
  const intro = document.createElement("p");
  intro.className = "mn-prefs-note";
  intro.textContent = t("templates.intro");
  content.append(intro);

  const actions = document.createElement("div");
  actions.className = "mn-template-settings-actions";
  const create = document.createElement("button");
  create.type = "button";
  create.className = "mn-btn mn-btn-primary";
  create.textContent = t("templates.create");
  create.addEventListener("click", async () => {
    const created = await createTemplateFromSelection([...state.selection]);
    if (created) {
      setStatus(`Template "${created.name}" saved.`);
      renderContent();
    }
  });
  const restore = document.createElement("button");
  restore.type = "button";
  restore.className = "mn-btn";
  restore.textContent = t("templates.restore");
  restore.addEventListener("click", () => {
    restoreBuiltInTemplates();
    setStatus("Built-in templates restored.");
    renderContent();
  });
  actions.append(create, restore);
  content.append(actions);

  const grid = document.createElement("div");
  grid.className = "mn-template-settings-grid";
  const templates = listTemplates();
  if (!templates.length) {
    const empty = document.createElement("p");
    empty.className = "mn-template-settings-empty";
    empty.textContent = t("templates.empty");
    grid.append(empty);
  }
  for (const template of templates) {
    const card = document.createElement("article");
    card.className = "mn-template-settings-card";
    card.innerHTML = `<span class="mn-template-settings-icon">${icon(
      template.icon || "note",
      20
    )}</span>
      <span class="mn-template-settings-copy">
        <strong>${escape(template.name)}</strong>
        <span>${escape(template.description || "")}</span>
      </span>
      <span class="mn-template-settings-kind">${template.custom ? t("templates.custom") : t("templates.builtin")}</span>
      <button type="button" class="mn-btn mn-btn-quiet mn-template-settings-delete">${t("templates.delete")}</button>`;
    const deleteButton = card.querySelector(".mn-template-settings-delete");
    if (!canDeleteTemplate(template.id)) {
      deleteButton.disabled = true;
      deleteButton.title = "Blank board is the required fallback template and cannot be deleted";
    }
    deleteButton.addEventListener("click", async () => {
      if (!canDeleteTemplate(template.id)) return;
      const { confirmAction } = await import("./ui.js");
      const confirmed = await confirmAction({
        title: t("templateDelete.title", "Delete template?"),
        message: t(
          "templateDelete.message",
          'Delete "{name}"? This cannot be undone.'
        ).replace("{name}", escape(template.name)),
        confirmLabel: t("templates.delete", "Delete"),
      });
      if (!confirmed) return;
      deleteTemplate(template.id);
      setStatus(`Template "${template.name}" deleted.`);
      renderContent();
    });
    grid.append(card);
  }
  content.append(grid);
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
  content.append(heading(t("nav.backup")));
  renderBackupSection(content);
}

function renderBackupSection(content) {
  const section = document.createElement("div");
  section.className = "mn-account-backup";
  const note = document.createElement("p");
  note.className = "mn-prefs-note";
  note.textContent = t("backup.intro");
  const status = document.createElement("p");
  status.className = "mn-account-backup-status";
  status.textContent = t("backup.none");
  const autoRow = buildRow({
    type: "select",
    label: t("backup.auto"),
    value: String(settings.autoBackupDays ?? 0),
    options: AUTO_BACKUP_OPTIONS.map(([value, label]) => [
      String(value),
      t(`backup.${({ 0: "off", 1: "everyDay", 3: "every3", 7: "every7", 14: "every14", 30: "monthly" })[value] || "off"}`, label),
    ]),
    onChange: (value) => setValue("autoBackupDays", Number(value)),
  });
  const lastLine = document.createElement("p");
  lastLine.className = "mn-account-backup-status";
  lastLine.textContent = `${t("backup.last")}: ${formatLastBackup(lastBackupAt())}`;
  let lastPath = "";
  const row = document.createElement("div");
  row.className = "mn-account-backup-actions";
  const backup = document.createElement("button");
  backup.type = "button";
  backup.className = "mn-btn mn-btn-primary";
  backup.textContent = t("backup.now");
  const open = document.createElement("button");
  open.type = "button";
  open.className = "mn-btn mn-btn-quiet";
  open.textContent = t("backup.openFolder");
  open.disabled = true;
  const exportZip = document.createElement("button");
  exportZip.type = "button";
  exportZip.className = "mn-btn";
  exportZip.textContent = t("backup.exportZip");
  backup.addEventListener("click", async () => {
    backup.disabled = true;
    status.textContent = t("backup.creating");
    try {
      lastPath = await bridge.backupData();
      await markBackupTaken();
      lastLine.textContent = `${t("backup.last")}: ${formatLastBackup(lastBackupAt())}`;
      status.textContent = `${t("backup.created")}: ${lastPath}`;
      open.disabled = bridge.hasWeb;
      window.dispatchEvent(new CustomEvent("mn:toast", { detail: { message: t("backup.created") } }));
    } catch (error) {
      status.textContent = errorText(error, t("backup.failed"));
    } finally {
      backup.disabled = false;
    }
  });
  open.addEventListener("click", () => {
    if (!lastPath || bridge.hasWeb) return;
    bridge.openFolder(lastPath).catch((error) => {
      status.textContent = errorText(error, "Could not open the backup folder");
    });
  });
  exportZip.addEventListener("click", async () => {
    exportZip.disabled = true;
    status.textContent = t("backup.exporting");
    try {
      lastPath = await bridge.exportBackupZip();
      await markBackupTaken();
      lastLine.textContent = `${t("backup.last")}: ${formatLastBackup(lastBackupAt())}`;
      status.textContent = `${t("backup.zipCreated")}: ${lastPath}`;
      open.disabled = bridge.hasWeb;
      window.dispatchEvent(new CustomEvent("mn:toast", { detail: { message: t("backup.exported") } }));
    } catch (error) {
      status.textContent = errorText(error, t("backup.zipFailed"));
    } finally {
      exportZip.disabled = false;
    }
  });
  row.append(backup, exportZip, open);
  const retention = document.createElement("p");
  retention.className = "mn-prefs-note";
  retention.textContent = t("backup.retention");
  section.append(note, autoRow, lastLine, status, row, retention);

  const databaseTitle = document.createElement("p");
  databaseTitle.className = "mn-prefs-group-label";
  databaseTitle.textContent = t("backup.database", "Database and migration");
  const databaseRow = document.createElement("div");
  databaseRow.className = "mn-account-backup-actions";
  const exportDatabaseButton = document.createElement("button");
  exportDatabaseButton.type = "button";
  exportDatabaseButton.className = "mn-btn";
  exportDatabaseButton.textContent = t("backup.exportDatabase", "Export database");
  exportDatabaseButton.addEventListener("click", async () => {
    exportDatabaseButton.disabled = true;
    try {
      const result = await bridge.exportDatabase();
      status.textContent =
        result === "download"
          ? t("backup.exportStarted", "Database export started.")
          : `${t("backup.exportPath", "Database exported to")}: ${result}`;
    } catch (error) {
      status.textContent = errorText(error, t("backup.failed"));
    } finally {
      exportDatabaseButton.disabled = false;
    }
  });

  const importDatabaseButton = document.createElement("button");
  importDatabaseButton.type = "button";
  importDatabaseButton.className = "mn-btn";
  importDatabaseButton.textContent = t("backup.importDatabase", "Import database");
  if (bridge.hasWeb || !bridge.hasTauri) {
    importDatabaseButton.disabled = true;
    importDatabaseButton.title = t("backup.importDesktop", "Import is available in the desktop app");
  } else {
    importDatabaseButton.addEventListener("click", async () => {
      let backupPath = null;
      try {
        backupPath = await bridge.pickBackupFolder();
      } catch (error) {
        status.textContent = errorText(error, "Could not open the folder picker");
        return;
      }
      if (!backupPath) return;
      const { confirmAction } = await import("./ui.js");
      const confirmed = await confirmAction({
        title: "Import database?",
        message:
          "The current database and assets will be replaced by this backup, then the app restarts.",
        confirmLabel: "Import",
      });
      if (!confirmed) return;
      try {
        await bridge.importDatabase(backupPath.trim());
        status.textContent = "Import queued. The app will restart.";
        window.setTimeout(() => bridge.restartApp(), 500);
      } catch (error) {
        status.textContent = error.message || "Database import failed";
      }
    });
  }

  const tursoButton = document.createElement("button");
  tursoButton.type = "button";
  tursoButton.className = "mn-btn mn-btn-quiet";
  tursoButton.textContent = t("backup.migrateTurso", "Migrate to Turso");
  tursoButton.disabled = true;
  tursoButton.title = t("backup.tursoNotReady", "Turso migration is not ready");
  databaseRow.append(exportDatabaseButton, importDatabaseButton, tursoButton);
  const databaseNote = document.createElement("p");
  databaseNote.className = "mn-prefs-note";
  databaseNote.textContent = t("backup.tursoNotReady", "Turso migration is not ready");
  section.append(databaseTitle, databaseRow, databaseNote);
  content.append(section);
}

function renderToolsGrid(content) {
  content.querySelector(".mn-tools-grid")?.remove();
  const grid = document.createElement("div");
  grid.className = "mn-tools-grid";
  for (const [key, label] of TOOL_LABELS) {
    const translatedLabel = t(`tool.${key}`, label);
    const disabledReason = toolDisabledReason(key);
    const visible = !settings.hiddenTools.includes(key);
    const card = document.createElement("button");
    card.type = "button";
    card.className =
      "mn-tool-card" + (disabledReason ? " is-disabled" : visible ? " is-visible" : "");
    card.dataset.tool = key;
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
    labelEl.textContent = translatedLabel;
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
      setStatus(`${translatedLabel} ${visible ? "hidden" : "shown"}`);
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

