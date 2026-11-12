// Local storage moved from the historical "mn." namespace to "ky.".
// Copy legacy values once, preferring any value already stored under the new key.
const LEGACY_PREFIX = "mn.";
const KEY_PREFIX = "ky.";

export function migrateStorageKeys(storage = globalThis.localStorage) {
  if (!storage) return 0;
  let migrated = 0;
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (!key || !key.startsWith(LEGACY_PREFIX)) continue;
    const target = KEY_PREFIX + key.slice(LEGACY_PREFIX.length);
    if (storage.getItem(target) === null) storage.setItem(target, storage.getItem(key));
    storage.removeItem(key);
    migrated += 1;
  }
  return migrated;
}

migrateStorageKeys();
