// Bridge to the Rust backend. Falls back to localStorage so the UI can be
// previewed in a plain browser without Tauri.

const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
const web = typeof window !== "undefined" ? window.__KHAOYU_WEB__ : null;

export const hasTauri = Boolean(tauri);
export const hasWeb = Boolean(web);
export const webInfo = web || null;

function invoke(cmd, args) {
  if (!tauri) return Promise.reject(new Error("Tauri API not available"));
  return tauri.core.invoke(cmd, args);
}

export async function captureWindow() {
  if (!hasTauri) return null;
  return invoke("capture_window");
}

export function convertFileSrc(path) {
  if (hasTauri && path) {
    try {
      return tauri.core.convertFileSrc(path);
    } catch {
      return path;
    }
  }
  if (path && String(path).startsWith("mn.asset.")) {
    const raw = localStorage.getItem(path);
    if (raw) {
      const extension = String(path).split(".").pop()?.toLowerCase();
      const types = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        svg: "image/svg+xml",
        mp3: "audio/mpeg",
        wav: "audio/wav",
        m4a: "audio/mp4",
        aac: "audio/aac",
        ogg: "audio/ogg",
        oga: "audio/ogg",
        opus: "audio/ogg",
        flac: "audio/flac",
        mp4: "video/mp4",
        webm: "video/webm",
      };
      return `data:${types[extension] || "application/octet-stream"};base64,${raw}`;
    }
  }
  return path;
}

// ------------------------------------------------------------------ boards

export async function listBoards() {
  if (hasTauri) return invoke("list_boards");
  const index = JSON.parse(localStorage.getItem("mn.boards") || "[]");
  const out = [];
  for (const id of index) {
    const raw = localStorage.getItem("mn.board." + id);
    if (!raw) continue;
    try {
      const doc = JSON.parse(raw);
      out.push({
        id,
        title: doc.title || "Untitled",
        parentId: doc.parentId || null,
        updatedAt: doc.updatedAt || 0,
        archivedAt: doc.archivedAt || null,
        trashedAt: doc.trashedAt || null,
      });
    } catch {
      /* ignore */
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export async function loadBoard(id) {
  if (hasTauri) return invoke("load_board", { id });
  return localStorage.getItem("mn.board." + id);
}

export async function saveBoard(id, data, baseUpdatedAt = null) {
  if (hasTauri) return invoke("save_board", { id, data, baseUpdatedAt });
  localStorage.setItem("mn.board." + id, data);
  const index = JSON.parse(localStorage.getItem("mn.boards") || "[]");
  if (!index.includes(id)) {
    index.push(id);
    localStorage.setItem("mn.boards", JSON.stringify(index));
  }
  return Date.now();
}

export async function deleteBoard(id) {
  if (hasTauri) return invoke("delete_board", { id });
  localStorage.removeItem("mn.board." + id);
  const index = JSON.parse(localStorage.getItem("mn.boards") || "[]");
  localStorage.setItem("mn.boards", JSON.stringify(index.filter((x) => x !== id)));
}

export async function renameBoard(id, title) {
  if (hasTauri) return invoke("rename_board", { id, title });
  const raw = localStorage.getItem("mn.board." + id);
  if (!raw) return null;
  const doc = JSON.parse(raw);
  doc.title = title;
  doc.updatedAt = Date.now();
  return saveBoard(id, JSON.stringify(doc));
}

export async function archiveBoard(id, archived) {
  if (hasTauri) return invoke("archive_board", { id, archived });
  const raw = localStorage.getItem("mn.board." + id);
  if (!raw) return null;
  const doc = JSON.parse(raw);
  if (archived) doc.archivedAt = Date.now();
  else delete doc.archivedAt;
  return saveBoard(id, JSON.stringify(doc));
}

export async function trashBoard(id, trashed) {
  if (hasTauri) return invoke("trash_board", { id, trashed });
  const raw = localStorage.getItem("mn.board." + id);
  if (!raw) return null;
  const doc = JSON.parse(raw);
  if (trashed) doc.trashedAt = Date.now();
  else delete doc.trashedAt;
  return saveBoard(id, JSON.stringify(doc));
}

export async function storeAsset(name, bytesBase64) {
  if (hasTauri) return invoke("store_asset", { name, data: bytesBase64 });
  const key = "mn.asset." + Date.now() + "-" + name;
  localStorage.setItem(key, bytesBase64);
  return key;
}

export async function storeAssetFromPath(path) {
  if (hasTauri) return invoke("store_asset_from_path", { path });
  return null;
}

export async function fetchLinkPreview(url) {
  if (!hasTauri) return null;
  try {
    return await invoke("fetch_link_preview", { url });
  } catch {
    return null;
  }
}

export async function appDataDir() {
  if (hasTauri) return invoke("app_data_dir");
  return "localStorage (browser preview)";
}

export async function mcpServerPath() {
  if (hasTauri) return invoke("mcp_server_path");
  return "";
}

export async function appVersion() {
  if (hasTauri) return invoke("app_version");
  return webInfo?.version || "";
}

export async function checkUpdate() {
  if (hasTauri) return invoke("check_update");
  throw new Error("Checking for updates needs the desktop app or the local web host");
}

export async function openExternal(url) {
  if (hasTauri) return invoke("open_external", { url });
  window.open(url, "_blank");
  return null;
}

export async function openPath(path) {
  if (hasTauri) return invoke("open_path", { path });
  if (path) window.open("file://" + path, "_blank");
  return null;
}

export async function downloadAsset(path) {
  if (hasTauri) return invoke("download_asset", { path });
  throw new Error("Downloads are only available in the desktop app");
}

export async function getSetting(key) {
  if (hasTauri) return invoke("get_setting", { key });
  return localStorage.getItem("mn.setting." + key);
}

export async function setSetting(key, value) {
  if (hasTauri) return invoke("set_setting", { key, value });
  localStorage.setItem("mn.setting." + key, value);
  return null;
}

export async function restartApp() {
  if (hasTauri) return invoke("restart_app");
  window.location.reload();
  return null;
}

export async function backupData() {
  if (hasTauri) return invoke("backup_data");
  throw new Error("Backups are only available in the desktop app");
}

export async function exportBackupZip() {
  if (hasTauri) return invoke("export_backup_zip");
  throw new Error("ZIP export is only available in the desktop app");
}

export async function dbIntegrity() {
  if (hasTauri) return invoke("db_integrity");
  throw new Error("Integrity checks are only available in the desktop app");
}

export async function stageRestore(backupPath) {
  if (hasTauri) return invoke("stage_restore", { backupPath });
  throw new Error("Restore is only available in the desktop app");
}

export async function exportBoard(data) {
  if (hasTauri) return invoke("export_board", { data });
  const blob = new Blob([data], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "board.json";
  a.click();
  URL.revokeObjectURL(a.href);
  return "download";
}

export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ------------------------------------------------------------------ accounts

const AUTH_CSRF_COOKIE = "khaoyu_local_csrf";

function readCookie(name) {
  if (typeof document === "undefined") return "";
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = document.cookie.match(new RegExp("(?:^|; )" + escaped + "=([^;]*)"));
  return match ? decodeURIComponent(match[1]) : "";
}

async function fetchAuth(path, { method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const csrf = readCookie(AUTH_CSRF_COOKIE);
  if (csrf) headers["x-khaoyu-csrf"] = csrf;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "include",
      signal: controller.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(
      error?.name === "AbortError"
        ? "The account request timed out"
        : "The account service is not reachable"
    );
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new Error(data?.error || `The account request failed (${response.status})`);
  }
  return data;
}

function accountsUnavailable() {
  return Promise.reject(new Error("Accounts need the desktop app or the local web host"));
}

export async function authStatus() {
  if (hasWeb) return { ...(await fetchAuth("/api/auth/status")), available: true };
  if (hasTauri) return { ...(await invoke("auth_status")), available: true };
  return {
    userCount: 0,
    requireLogin: true,
    guestAllowed: false,
    user: null,
    csrfToken: null,
    available: false,
  };
}

// Desktop restores the session.json token once at boot. The web host restores from its cookie.
export async function authRestoreSession() {
  if (hasWeb) return null;
  if (hasTauri) return invoke("auth_restore_session");
  return null;
}

export async function authSetupAdmin(input) {
  const body = {
    username: input.username,
    email: input.email,
    firstName: input.firstName,
    lastName: input.lastName ?? "",
    password: input.password,
    claimBoards: Boolean(input.claimBoards),
    remember: Boolean(input.remember),
  };
  if (hasWeb) return fetchAuth("/api/auth/setup", { method: "POST", body });
  if (hasTauri) return invoke("auth_setup_admin", body);
  return accountsUnavailable();
}

export async function authLogin(input) {
  const body = {
    identifier: input.identifier,
    password: input.password,
    remember: Boolean(input.remember),
  };
  if (hasWeb) return fetchAuth("/api/auth/login", { method: "POST", body });
  if (hasTauri) return invoke("auth_login", body);
  return accountsUnavailable();
}

export async function authLogout() {
  if (hasWeb) return fetchAuth("/api/auth/logout", { method: "POST" });
  if (hasTauri) return invoke("auth_logout");
  return accountsUnavailable();
}

export async function authLogoutAll() {
  if (hasWeb) return fetchAuth("/api/auth/logout-all", { method: "POST" });
  if (hasTauri) return invoke("auth_logout_all");
  return accountsUnavailable();
}

export async function authMe() {
  if (hasWeb) return fetchAuth("/api/auth/me");
  if (hasTauri) return invoke("auth_me");
  return null;
}

export async function authUpdateProfile(input) {
  const body = {
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    avatarColor: input.avatarColor,
    avatarUrl: input.avatarUrl,
  };
  if (hasWeb) return fetchAuth("/api/auth/profile", { method: "PATCH", body });
  if (hasTauri) return invoke("auth_update_profile", body);
  return accountsUnavailable();
}

export async function authChangePassword(input) {
  const body = { currentPassword: input.currentPassword, newPassword: input.newPassword };
  if (hasWeb) return fetchAuth("/api/auth/password", { method: "POST", body });
  if (hasTauri) return invoke("auth_change_password", body);
  return accountsUnavailable();
}

export async function authHistory({ limit = 20, offset = 0 } = {}) {
  if (hasWeb) {
    return fetchAuth(`/api/auth/history?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`);
  }
  if (hasTauri) return invoke("auth_history", { limit, offset });
  return { entries: [], hasMore: false };
}

export async function authResetDatabase(input) {
  if (hasWeb) return fetchAuth("/api/auth/reset", { method: "POST", body: input });
  if (hasTauri) return invoke("auth_reset_database", input);
  return accountsUnavailable();
}

// Full URLs this host can be reached on. Only the browser edition has share URLs.
export async function shareInfo() {
  if (!hasWeb) return null;
  try {
    const response = await fetch("/api/share-info", { credentials: "include" });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
