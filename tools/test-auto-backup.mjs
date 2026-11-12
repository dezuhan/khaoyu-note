// Node checks for the automatic backup schedule. Run with: node tools/test-auto-backup.mjs
import assert from "node:assert/strict";

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
}

const DAY = 24 * 60 * 60 * 1000;
const settings = new Map();
const calls = [];
let backupFails = false;
let backups = 0;

globalThis.localStorage = new MemoryStorage();
globalThis.window = {
  addEventListener() {},
  dispatchEvent() {},
  setTimeout,
  setInterval,
  __TAURI__: {
    core: {
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === "get_setting") return settings.get(args.key) ?? null;
        if (command === "set_setting") {
          settings.set(args.key, args.value);
          return null;
        }
        if (command === "backup_data" || command === "auto_backup_data") {
          if (backupFails) throw new Error("disk is full");
          backups += 1;
          return "C:/backup-" + backups;
        }
        throw new Error("unexpected command " + command);
      },
    },
  },
};

const auto = await import("../app/web/js/auto-backup.js");

assert.equal(auto.intervalMs(0), 0);
assert.equal(auto.intervalMs(1), DAY);
assert.equal(auto.intervalMs(30), 30 * DAY);
assert.equal(auto.isBackupDue(0, 0, 1000), false);
assert.equal(auto.isBackupDue(1, 0, 1000), true);
assert.equal(auto.isBackupDue(1, 1000, 1000 + DAY - 1), false);
assert.equal(auto.isBackupDue(1, 1000, 1000 + DAY), true);
assert.equal(auto.isBackupDue(3, 1000, 1000 + 2 * DAY), false);
assert.equal(auto.isBackupDue(30, 1000, 1000 + 29 * DAY), false);
assert.equal(auto.isBackupDue(30, 1000, 1000 + 30 * DAY), true);

// Off by default.
let result = await auto.maybeAutoBackup({ now: 5000 });
assert.equal(result.status, "off");
assert.equal(backups, 0);

// A one-day interval is due immediately when no backup was recorded yet.
localStorage.setItem("ky.settings", JSON.stringify({ autoBackupDays: 1 }));
result = await auto.maybeAutoBackup({ now: 1000 });
assert.equal(result.status, "created");
assert.equal(backups, 1);
assert.ok(calls.some((call) => call.command === "auto_backup_data"), "automatic backups use the retention-aware command");
assert.equal(auto.lastBackupAt(), 1000);

// Not due again before the interval elapses.
result = await auto.maybeAutoBackup({ now: 1000 + DAY - 1 });
assert.equal(result.status, "not-due");
assert.equal(backups, 1);

// Due once the interval has passed.
result = await auto.maybeAutoBackup({ now: 1000 + DAY });
assert.equal(result.status, "created");
assert.equal(backups, 2);
assert.equal(auto.lastBackupAt(), 1000 + DAY);

// Every month uses 30 days.
localStorage.setItem("ky.settings", JSON.stringify({ autoBackupDays: 30 }));
await auto.markBackupTaken(2000);
result = await auto.maybeAutoBackup({ now: 2000 + 29 * DAY });
assert.equal(result.status, "not-due");
result = await auto.maybeAutoBackup({ now: 2000 + 30 * DAY });
assert.equal(result.status, "created");

// A manual backup resets the schedule.
await auto.markBackupTaken(9000);
result = await auto.maybeAutoBackup({ now: 9000 + 1000 });
assert.equal(result.status, "not-due");

// A failed backup keeps the previous timestamp so it is retried later.
const before = auto.lastBackupAt();
backupFails = true;
result = await auto.maybeAutoBackup({ now: before + 31 * DAY });
assert.equal(result.status, "error");
assert.equal(auto.lastBackupAt(), before);
backupFails = false;

// The timestamp is persisted through the host settings store.
assert.ok(calls.some((call) => call.command === "set_setting" && call.args.key === "auto_backup_last_at"));
assert.match(auto.formatLastBackup(0), /No automatic backup yet/);
assert.match(auto.formatLastBackup(before), /\d/);

console.log("PASS  auto backup intervals, due checks, manual reset and failed backup retry");
console.log(`${backups} backups, ${calls.length} host calls`);
