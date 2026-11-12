import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrate, MIGRATIONS_DIR, openDatabase } from "../src/db.mjs";
import { ObjectStore } from "../src/objects.mjs";

const KEY = "object-encryption-test-key-0123456789";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "khaoyu-objects-"));
  const db = openDatabase(path.join(dir, "test.db"));
  migrate(db, { directory: MIGRATIONS_DIR });
  return { dir, db, objectsDir: path.join(dir, "objects") };
}

test("encrypted objects are unreadable at rest and decrypt through the store", async () => {
  const { db, objectsDir, dir } = fixture();
  const store = new ObjectStore(db, objectsDir, KEY);
  const plaintext = Buffer.from("secret board asset");
  const stored = await store.store(plaintext, "text/plain");
  const atRest = fs.readFileSync(path.join(objectsDir, stored.storage_key));
  assert.notDeepEqual(atRest, plaintext);
  assert.equal(atRest.subarray(0, 6).toString(), "KHOBJ1");
  const loaded = await store.get(stored.id);
  assert.deepEqual(loaded.body, plaintext);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("encrypted objects refuse to decrypt without the key or with the wrong key", async () => {
  const { db, objectsDir, dir } = fixture();
  const writer = new ObjectStore(db, objectsDir, KEY);
  const stored = await writer.store(Buffer.from("secret"), "text/plain");
  const noKey = new ObjectStore(db, objectsDir);
  await assert.rejects(() => noKey.get(stored.id), /KHAOYU_SERVICE_OBJECT_KEY/);
  const wrongKey = new ObjectStore(db, objectsDir, "different-object-key-0123456789abcd");
  await assert.rejects(() => wrongKey.get(stored.id), /unable to authenticate|corrupt/i);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("plaintext objects stay readable after encryption is enabled", async () => {
  const { db, objectsDir, dir } = fixture();
  const plaintextWriter = new ObjectStore(db, objectsDir);
  const stored = await plaintextWriter.store(Buffer.from("legacy object"), "text/plain");
  const keyed = new ObjectStore(db, objectsDir, KEY);
  const loaded = await keyed.get(stored.id);
  assert.deepEqual(loaded.body, Buffer.from("legacy object"));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
