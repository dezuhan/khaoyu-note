import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const FORMAT = 1;

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function integrityCheck(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db.prepare("PRAGMA integrity_check").get();
    return row?.integrity_check === "ok";
  } finally {
    db.close();
  }
}

export function createBackup(db, config) {
  fs.mkdirSync(config.backupsDir, { recursive: true });
  const directory = path.join(config.backupsDir, `${timestamp()}-${crypto.randomUUID().slice(0, 8)}`);
  fs.mkdirSync(directory, { recursive: true });
  const databaseFile = path.join(directory, "database.db");
  const quoted = databaseFile.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${quoted}'`);
  if (!integrityCheck(databaseFile)) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw new Error("backup database failed the integrity check");
  }
  if (fs.existsSync(config.objectsDir)) {
    fs.cpSync(config.objectsDir, path.join(directory, "objects"), { recursive: true });
  }
  const manifest = {
    format: FORMAT,
    createdAt: Date.now(),
    database: {
      file: "database.db",
      bytes: fs.statSync(databaseFile).size,
      sha256: sha256File(databaseFile),
    },
  };
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { directory, manifest };
}

export function pruneBackups(config, retention = config.backupRetention) {
  if (!fs.existsSync(config.backupsDir)) return [];
  const backups = fs
    .readdirSync(config.backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(config.backupsDir, entry.name))
    .filter((directory) => fs.existsSync(path.join(directory, "manifest.json")))
    .sort()
    .reverse();
  const removed = [];
  for (const directory of backups.slice(retention)) {
    fs.rmSync(directory, { recursive: true, force: true });
    removed.push(directory);
  }
  return removed;
}

export function restoreBackup({ backupDirectory, dataDir, force = false }) {
  const backup = path.resolve(backupDirectory);
  const manifestPath = path.join(backup, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error("backup manifest is missing");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.format !== FORMAT) throw new Error("unsupported backup format");
  const sourceDatabase = path.join(backup, manifest.database.file);
  if (!fs.existsSync(sourceDatabase)) throw new Error("backup database is missing");
  if (sha256File(sourceDatabase) !== manifest.database.sha256) {
    throw new Error("backup database checksum does not match the manifest");
  }
  if (!integrityCheck(sourceDatabase)) throw new Error("backup database failed the integrity check");

  const targetDatabase = path.join(dataDir, "khaoyu-service.db");
  const targetObjects = path.join(dataDir, "objects");
  if (!force && (fs.existsSync(targetDatabase) || fs.existsSync(targetObjects))) {
    throw new Error("target data exists; pass force to replace it");
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const safety = path.join(dataDir, `restore-previous-${timestamp()}`);
  fs.mkdirSync(safety, { recursive: true });
  const moved = [];
  try {
    if (fs.existsSync(targetDatabase)) {
      fs.renameSync(targetDatabase, path.join(safety, "database.db"));
      moved.push("database");
    }
    if (fs.existsSync(targetObjects)) {
      fs.renameSync(targetObjects, path.join(safety, "objects"));
      moved.push("objects");
    }
    fs.copyFileSync(sourceDatabase, targetDatabase);
    if (fs.existsSync(path.join(backup, "objects"))) {
      fs.cpSync(path.join(backup, "objects"), targetObjects, { recursive: true });
    }
    if (!integrityCheck(targetDatabase)) throw new Error("restored database failed the integrity check");
    return { safety, manifest };
  } catch (error) {
    fs.rmSync(targetDatabase, { force: true });
    fs.rmSync(targetObjects, { recursive: true, force: true });
    if (moved.includes("database")) {
      fs.renameSync(path.join(safety, "database.db"), targetDatabase);
    }
    if (moved.includes("objects")) {
      fs.renameSync(path.join(safety, "objects"), targetObjects);
    }
    throw error;
  }
}
