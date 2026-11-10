// Automatic local backups while the app is running. The desktop app has no background process when
// it is closed, so a missed interval is caught up on the next launch.

import * as bridge from "./bridge.js";

const LAST_AT_KEY = "auto_backup_last_at";
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const AUTO_BACKUP_OPTIONS = [
  [0, "Off"],
  [1, "Every day"],
  [3, "Every 3 days"],
  [7, "Every 7 days"],
  [14, "Every 14 days"],
  [30, "Every month"],
];

import { getLanguage, t } from "./i18n.js";

let lastAt = 0;
let loaded = false;
let running = false;
let checkTimer = 0;
let settingsTimer = 0;
let errorNotifiedAt = 0;

export function intervalMs(days) {
  const value = Number(days);
  return Number.isFinite(value) && value > 0 ? value * DAY_MS : 0;
}

export function isBackupDue(intervalDays, lastBackupAt, now = Date.now()) {
  const interval = intervalMs(intervalDays);
  if (!interval) return false;
  const last = Number(lastBackupAt) || 0;
  if (!last) return true;
  return now - last >= interval;
}

function storage() {
  return globalThis.localStorage;
}

function intervalDays() {
  try {
    const raw = storage()?.getItem("mn.settings");
    const parsed = raw ? JSON.parse(raw) : null;
    return Number(parsed?.autoBackupDays) || 0;
  } catch {
    return 0;
  }
}

function toast(message) {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent("mn:toast", { detail: { message } }));
}

async function loadLastAt() {
  if (loaded) return lastAt;
  loaded = true;
  try {
    lastAt = Number(await bridge.getSetting(LAST_AT_KEY)) || 0;
  } catch {
    lastAt = 0;
  }
  return lastAt;
}

async function saveLastAt(value) {
  lastAt = value;
  try {
    await bridge.setSetting(LAST_AT_KEY, String(value));
  } catch {
    /* keep the in-memory value for this session */
  }
}

export function lastBackupAt() {
  return lastAt;
}

export function formatLastBackup(value, locale) {
  const stamp = Number(value) || 0;
  if (!stamp) return t("backup.noneYet");
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return t("backup.noneYet");
  return date.toLocaleString(locale || getLanguage());
}

// A manual backup also resets the schedule so automatic backups do not duplicate it.
export async function markBackupTaken(value = Date.now()) {
  loaded = true;
  await saveLastAt(value);
}

export async function maybeAutoBackup({ force = false, now = Date.now() } = {}) {
  if (!bridge.hasTauri && !bridge.hasWeb) return { status: "unsupported" };
  if (running) return { status: "running" };
  await loadLastAt();
  const days = intervalDays();
  if (!days) return { status: "off" };
  if (!force && !isBackupDue(days, lastAt, now)) return { status: "not-due" };
  running = true;
  try {
    const path = await bridge.backupData();
    await saveLastAt(now);
    toast("Automatic backup created");
    return { status: "created", path };
  } catch (error) {
    const message = error?.message || "Automatic backup failed";
    // Do not repeat the same warning on every check; once per six hours is enough.
    if (Date.now() - errorNotifiedAt > 6 * 60 * 60 * 1000) {
      errorNotifiedAt = Date.now();
      toast(`Automatic backup failed: ${message}`);
    }
    return { status: "error", message };
  } finally {
    running = false;
  }
}

export function initAutoBackup() {
  if (checkTimer || typeof window === "undefined") return;
  void loadLastAt();
  window.addEventListener("mn:settings-changed", () => {
    clearTimeout(settingsTimer);
    settingsTimer = window.setTimeout(() => void maybeAutoBackup(), 1200);
  });
  // Catch up shortly after boot, then check while the app stays open.
  window.setTimeout(() => void maybeAutoBackup(), 12000);
  checkTimer = window.setInterval(() => void maybeAutoBackup(), CHECK_INTERVAL_MS);
}
