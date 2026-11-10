import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openPostgresStorage } from "./postgres.mjs";
import { dataMigrationTables } from "./migrate-data.mjs";

const FORMAT = 3;
const ALGORITHM = "aes-256-gcm";
const CHUNK_SIZE = 500;

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
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

function encryptionFor(passphrase) {
  if (!passphrase) return { encryption: null, key: null };
  const encryption = { algorithm: ALGORITHM, salt: crypto.randomBytes(16).toString("base64") };
  return {
    encryption,
    key: keyFromPassphrase(passphrase, Buffer.from(encryption.salt, "base64")),
  };
}


export async function createPostgresBackup(db, config) {
  fs.mkdirSync(config.backupsDir, { recursive: true });
  const directory = path.join(
    config.backupsDir,
    `${timestamp()}-${crypto.randomUUID().slice(0, 8)}`
  );
  fs.mkdirSync(directory, { recursive: true });

  const tables = {};
  const counts = {};
  for (const table of dataMigrationTables.copy) {
    const rows = await db.all(`SELECT * FROM ${quoteIdent(table)}`);
    tables[table] = rows;
    counts[table] = rows.length;
  }
  const payload = Buffer.from(
    JSON.stringify({ format: FORMAT, dialect: "postgres", createdAt: Date.now(), tables }),
    "utf8"
  );
  const { encryption, key } = encryptionFor(config.backupPassphrase || null);
  const databaseFile = path.join(directory, "database.json");
  fs.writeFileSync(databaseFile, key ? encryptBuffer(payload, key) : payload, { mode: 0o600 });

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
    dialect: "postgres",
    createdAt: Date.now(),
    encryption,
    database: {
      file: "database.json",
      bytes: payload.length,
      sha256: sha256Buffer(payload),
      tables: counts,
    },
    objects,
  };
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { directory, manifest };
}

export async function restorePostgresBackup({
  backupDirectory,
  databaseUrl,
  databaseSsl = false,
  databasePoolMax = 10,
  objectsDir,
  force = false,
  passphrase = null,
} = {}) {
  const backup = path.resolve(backupDirectory);
  const manifestPath = path.join(backup, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error("backup manifest is missing");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.format !== FORMAT || manifest.dialect !== "postgres") {
    throw new Error("unsupported PostgreSQL backup format");
  }
  const encrypted = Boolean(manifest.encryption);
  if (encrypted && !passphrase) throw new Error("backup passphrase is required");
  const key = encrypted
    ? keyFromPassphrase(passphrase, Buffer.from(manifest.encryption.salt, "base64"))
    : null;
  let payload;
  try {
    payload = JSON.parse(readAndVerify(backup, manifest, manifest.database.file, key).toString("utf8"));
  } catch (error) {
    if (encrypted) throw new Error("backup passphrase is invalid or the backup is corrupted");
    throw error;
  }
  if (payload.format !== FORMAT || payload.dialect !== "postgres") {
    throw new Error("unsupported PostgreSQL backup payload");
  }

  const db = await openPostgresStorage({ databaseUrl, databaseSsl, databasePoolMax });
  try {
    const baseline = await db.get("SELECT version FROM schema_migrations WHERE version = 1");
    if (!baseline) {
      throw new Error("target database has no PostgreSQL baseline; run migrate-postgres first");
    }
    const copyTables = dataMigrationTables.copy;
    if (!force) {
      for (const table of copyTables) {
        const row = await db.get(`SELECT COUNT(*) AS count FROM ${quoteIdent(table)}`);
        if (Number(row?.count || 0) > 0) {
          throw new Error(`target table ${table} is not empty; pass --force to replace it`);
        }
      }
    } else {
      await db.exec(`TRUNCATE TABLE ${copyTables.map(quoteIdent).join(", ")} CASCADE`);
    }

    const report = { tables: {} };
    for (const table of copyTables) {
      const rows = payload.tables?.[table] || [];
      const columns = rows.length ? Object.keys(rows[0]) : [];
      if (rows.length && columns.length) {
        const placeholders = columns.map(() => "?").join(", ");
        const insertSql = `INSERT INTO ${quoteIdent(table)} (${columns
          .map(quoteIdent)
          .join(", ")}) VALUES (${placeholders})`;
        for (let offset = 0; offset < rows.length; offset += CHUNK_SIZE) {
          const chunk = rows.slice(offset, offset + CHUNK_SIZE);
          await db.transaction(async (tx) => {
            for (const row of chunk) {
              await tx.run(
                insertSql,
                columns.map((column) =>
                  table === "projects" && column === "parent_project_id"
                    ? null
                    : row[column] ?? null
                )
              );
            }
          });
        }
        if (table === "projects") {
          const parents = rows.filter(
            (row) => row.parent_project_id !== null && row.parent_project_id !== undefined
          );
          if (parents.length) {
            await db.transaction(async (tx) => {
              for (const row of parents) {
                await tx.run("UPDATE projects SET parent_project_id = ? WHERE id = ?", [
                  row.parent_project_id,
                  row.id,
                ]);
              }
            });
          }
        }
      }
      const target = await db.get(`SELECT COUNT(*) AS count FROM ${quoteIdent(table)}`);
      if (Number(target?.count || 0) !== rows.length) {
        throw new Error(
          `row count mismatch for ${table}: backup ${rows.length}, target ${Number(target?.count || 0)}`
        );
      }
      report.tables[table] = rows.length;
    }

    if (objectsDir) {
      const targetRoot = path.resolve(objectsDir);
      fs.mkdirSync(targetRoot, { recursive: true });
      for (const object of manifest.objects || []) {
        const buffer = readAndVerify(backup, manifest, path.join("objects", object.file), key);
        const destination = path.resolve(targetRoot, object.file);
        if (!destination.startsWith(`${targetRoot}${path.sep}`)) {
          throw new Error(`invalid object path in backup: ${object.file}`);
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, buffer, { mode: 0o600 });
      }
      report.objects = (manifest.objects || []).length;
    }
    return report;
  } finally {
    await db.close().catch(() => {});
  }
}
