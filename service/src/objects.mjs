import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ENCRYPTION_MAGIC = Buffer.from("KHOBJ1", "utf8");
const ENCRYPTION_ALGORITHM = "aes-256-gcm";

function objectKey(value) {
  return value ? crypto.createHash("sha256").update(String(value)).digest() : null;
}

function encryptObject(buffer, key) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, nonce);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([ENCRYPTION_MAGIC, nonce, cipher.getAuthTag(), encrypted]);
}

function decryptObject(buffer, key) {
  if (buffer.length < ENCRYPTION_MAGIC.length + 28) {
    throw new Error("encrypted object is truncated");
  }
  const nonce = buffer.subarray(ENCRYPTION_MAGIC.length, ENCRYPTION_MAGIC.length + 12);
  const tag = buffer.subarray(ENCRYPTION_MAGIC.length + 12, ENCRYPTION_MAGIC.length + 28);
  const data = buffer.subarray(ENCRYPTION_MAGIC.length + 28);
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function isEncryptedObject(buffer) {
  return buffer.length >= ENCRYPTION_MAGIC.length && buffer.subarray(0, ENCRYPTION_MAGIC.length).equals(ENCRYPTION_MAGIC);
}

export class ObjectStore {
  constructor(db, objectsDir, encryptionKey = "") {
    this.db = db;
    this.objectsDir = path.resolve(objectsDir);
    this.key = objectKey(encryptionKey);
    fs.mkdirSync(this.objectsDir, { recursive: true });
  }

  async store(buffer, contentType = "application/octet-stream") {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error("object body is empty");
    }
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) {
      throw new Error("invalid content type");
    }
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    const existing = await this.db.get(
      "SELECT id, sha256, bytes, content_type, storage_key FROM objects WHERE sha256 = ?",
      [sha256]
    );
    if (existing) return { ...existing, deduplicated: true };

    const id = crypto.randomUUID();
    const storageKey = `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
    const target = this.resolveKey(storageKey);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = path.join(path.dirname(target), `.tmp-${id}`);
    fs.writeFileSync(temp, this.key ? encryptObject(buffer, this.key) : buffer, { mode: 0o600 });
    fs.renameSync(temp, target);
    await this.db.run(
      "INSERT INTO objects (id, sha256, bytes, content_type, storage_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, sha256, buffer.length, contentType, storageKey, Date.now()]
    );
    return { id, sha256, bytes: buffer.length, content_type: contentType, storage_key: storageKey, deduplicated: false };
  }

  async get(id) {
    const row = await this.db.get(
      "SELECT id, sha256, bytes, content_type, storage_key FROM objects WHERE id = ?",
      [id]
    );
    if (!row) return null;
    let body = fs.readFileSync(this.resolveKey(row.storage_key));
    if (isEncryptedObject(body)) {
      if (!this.key) throw new Error("object is encrypted but KHAOYU_SERVICE_OBJECT_KEY is not set");
      body = decryptObject(body, this.key);
    }
    return { ...row, body };
  }

  resolveKey(storageKey) {
    const resolved = path.resolve(this.objectsDir, storageKey);
    if (!resolved.startsWith(this.objectsDir + path.sep)) {
      throw new Error("invalid object storage key");
    }
    return resolved;
  }

  async remove(id) {
    const row = await this.db.get("SELECT storage_key FROM objects WHERE id = ?", [id]);
    if (!row) return false;
    await this.db.run("DELETE FROM objects WHERE id = ?", [id]);
    fs.rmSync(this.resolveKey(row.storage_key), { force: true });
    return true;
  }
}
