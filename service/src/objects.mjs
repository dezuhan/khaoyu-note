import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class ObjectStore {
  constructor(db, objectsDir) {
    this.db = db;
    this.objectsDir = path.resolve(objectsDir);
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
    fs.writeFileSync(temp, buffer, { mode: 0o600 });
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
    const body = fs.readFileSync(this.resolveKey(row.storage_key));
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
