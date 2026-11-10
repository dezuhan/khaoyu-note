import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createPostgresBackup } from "./storage/backup-postgres.mjs";

const FORMAT = 2;
const ALGORITHM = "aes-256-gcm";

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
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

function keyFromPassphrase(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
}

function encryptBuffer(buffer, key) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, nonce);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
}

function decryptBuffer(buffer, key) {
  if (buffer.length < 28) throw new Error("encrypted backup file is truncated");
  const nonce = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const data = buffer.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function listFiles(root) {
  const files = [];
  function visit(directory, prefix) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) visit(path.join(directory, entry.name), relative);
      else if (entry.isFile()) files.push(relative);
    }
  }
  if (fs.existsSync(root)) visit(root, "");
  return files;
}

function fileEntry(directory, file) {
  const buffer = fs.readFileSync(path.join(directory, file));
  return {
    file,
    bytes: buffer.length,
    sha256: sha256Buffer(buffer),
  };
}

export async function createBackup(db, config) {
  if (db.dialect === "postgres") return createPostgresBackup(db, config);
  fs.mkdirSync(config.backupsDir, { recursive: true });
  const directory = path.join(config.backupsDir, `${timestamp()}-${crypto.randomUUID().slice(0, 8)}`);
  fs.mkdirSync(directory, { recursive: true });
  const databaseFile = path.join(directory, "database.db");
  const quoted = databaseFile.replace(/'/g, "''");
  await db.exec(`VACUUM INTO '${quoted}'`);
  if (!integrityCheck(databaseFile)) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw new Error("backup database failed the integrity check");
  }

  const passphrase = config.backupPassphrase || null;
  const encryption = passphrase
    ? { algorithm: ALGORITHM, salt: crypto.randomBytes(16).toString("base64") }
    : null;
  const key = passphrase ? keyFromPassphrase(passphrase, Buffer.from(encryption.salt, "base64")) : null;

  const databaseBytes = fs.readFileSync(databaseFile);
  const databaseManifest = {
    file: "database.db",
    bytes: databaseBytes.length,
    sha256: sha256Buffer(databaseBytes),
  };
  if (key) fs.writeFileSync(databaseFile, encryptBuffer(databaseBytes, key), { mode: 0o600 });

  const objectsSource = path.join(config.objectsDir);
  const objectsTarget = path.join(directory, "objects");
  const objects = [];
  if (fs.existsSync(objectsSource)) fs.cpSync(objectsSource, objectsTarget, { recursive: true });
  for (const relative of listFiles(objectsTarget)) {
    const file = path.join(objectsTarget, relative);
    const buffer = fs.readFileSync(file);
    objects.push({ file: relative, bytes: buffer.length, sha256: sha256Buffer(buffer) });
    if (key) fs.writeFileSync(file, encryptBuffer(buffer, key), { mode: 0o600 });
  }

  const manifest = {
    format: FORMAT,
    createdAt: Date.now(),
    encryption,
    database: databaseManifest,
    objects,
  };
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { directory, manifest };
}

function readAndVerify(backup, manifest, file, key) {
  const source = path.join(backup, file);
  if (!fs.existsSync(source)) throw new Error(`backup file is missing: ${file}`);
  let buffer = fs.readFileSync(source);
  if (key) buffer = decryptBuffer(buffer, key);
  const expected =
    file === manifest.database.file
      ? manifest.database
      : manifest.objects.find((entry) => entry.file === file.replace(/^objects[\\/]/, ""));
  if (!expected || sha256Buffer(buffer) !== expected.sha256) {
    throw new Error(`backup checksum does not match: ${file}`);
  }
  return buffer;
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

export function restoreBackup({ backupDirectory, dataDir, force = false, passphrase = null }) {
  const backup = path.resolve(backupDirectory);
  const manifestPath = path.join(backup, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error("backup manifest is missing");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (![1, FORMAT].includes(manifest.format)) throw new Error("unsupported backup format");
  const encrypted = manifest.format === FORMAT && manifest.encryption;
  if (encrypted && !passphrase) throw new Error("backup passphrase is required");
  const key = encrypted
    ? keyFromPassphrase(passphrase, Buffer.from(manifest.encryption.salt, "base64"))
    : null;

  const sourceDatabase = path.join(backup, manifest.database.file);
  if (!fs.existsSync(sourceDatabase)) throw new Error("backup database is missing");
  let databaseBytes;
  try {
    databaseBytes = readAndVerify(backup, manifest, manifest.database.file, key);
  } catch (error) {
    if (encrypted) throw new Error("backup passphrase is invalid or the backup is corrupted");
    throw error;
  }

  const targetDatabase = path.join(dataDir, "khaoyu-service.db");
  const targetObjects = path.join(dataDir, "objects");
  if (!force && (fs.existsSync(targetDatabase) || fs.existsSync(targetObjects))) {
    throw new Error("target data exists; pass force to replace it");
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const stagedDatabase = path.join(dataDir, `.restore-${crypto.randomUUID()}.db`);
  fs.writeFileSync(stagedDatabase, databaseBytes, { mode: 0o600 });
  if (!integrityCheck(stagedDatabase)) {
    fs.rmSync(stagedDatabase, { force: true });
    throw new Error("backup database failed the integrity check");
  }

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
    fs.renameSync(stagedDatabase, targetDatabase);
    for (const object of manifest.objects || []) {
      const destination = path.join(targetObjects, object.file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const buffer = readAndVerify(backup, manifest, path.join("objects", object.file), key);
      fs.writeFileSync(destination, buffer, { mode: 0o600 });
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
  } finally {
    fs.rmSync(stagedDatabase, { force: true });
  }
}
