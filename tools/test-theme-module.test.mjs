import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_THEME,
  SERVICE_LEGACY_KEYS,
  SKINS,
  applyTheme,
  initTheme,
  isTheme,
  readStoredTheme,
  setTheme,
  storeTheme,
  systemTheme,
  toggleTheme,
} from "../shared/theme/theme.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    value: (key) => values.get(key) ?? null,
  };
}

test("exposes the four bundled skins and the service legacy keys", () => {
  assert.deepEqual(SKINS, ["light", "softLight", "softDark", "dark"]);
  assert.deepEqual(SERVICE_LEGACY_KEYS, ["khaoyu.admin.theme", "khaoyu.auth.theme"]);
  assert.equal(isTheme("softDark"), true);
  assert.equal(isTheme("neon"), false);
});

test("reads the active key before legacy keys and migrates on set", () => {
  const storage = memoryStorage({ "khaoyu.theme": "softDark", "khaoyu.auth.theme": "dark" });
  assert.equal(readStoredTheme({ key: "khaoyu.theme", legacyKeys: ["khaoyu.auth.theme"], storage }), "softDark");
  const legacy = memoryStorage({ "khaoyu.auth.theme": "dark" });
  assert.equal(readStoredTheme({ key: "khaoyu.theme", legacyKeys: ["khaoyu.auth.theme"], storage: legacy }), "dark");
  setTheme("softLight", { key: "khaoyu.theme", storage: legacy });
  assert.equal(legacy.value("khaoyu.theme"), "softLight");
});

test("falls back to the system preference or the requested default", () => {
  const storage = memoryStorage({ "khaoyu.theme": "invalid" });
  assert.equal(readStoredTheme({ key: "khaoyu.theme", fallback: "light", storage }), "light");
  assert.equal(
    readStoredTheme({ key: "khaoyu.theme", fallback: "system", storage }),
    systemTheme()
  );
  const dark = () => ({ matches: false });
  const light = () => ({ matches: true });
  assert.equal(systemTheme(dark), "dark");
  assert.equal(systemTheme(light), "light");
  assert.equal(systemTheme(undefined), DEFAULT_THEME);
});

test("applies a valid skin to the document root and rejects unknown values", () => {
  const root = { dataset: {} };
  assert.equal(applyTheme("softDark", { root }), "softDark");
  assert.equal(root.dataset.kyTheme, "softDark");
  assert.equal(applyTheme("neon", { root }), "light");
  assert.equal(root.dataset.kyTheme, "light");
});

test("setTheme applies, persists and reports the next skin", () => {
  const storage = memoryStorage();
  const root = { dataset: {} };
  const seen = [];
  const applied = setTheme("dark", { key: "khaoyu.theme", storage, root, onChange: (theme) => seen.push(theme) });
  assert.equal(applied, "dark");
  assert.equal(root.dataset.kyTheme, "dark");
  assert.equal(storage.value("khaoyu.theme"), "dark");
  assert.deepEqual(seen, ["dark"]);
});

test("initTheme reads storage and applies it", () => {
  const storage = memoryStorage({ "ky.theme": "softLight" });
  const root = { dataset: {} };
  assert.equal(initTheme({ key: "ky.theme", fallback: "light", storage, root }), "softLight");
  assert.equal(root.dataset.kyTheme, "softLight");
});

test("toggleTheme moves between light and dark skins", () => {
  assert.equal(toggleTheme("dark"), "light");
  assert.equal(toggleTheme("softDark"), "light");
  assert.equal(toggleTheme("light"), "dark");
  assert.equal(toggleTheme("softLight"), "dark");
});

test("storage failures do not break applying a theme", () => {
  const storage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  const root = { dataset: {} };
  assert.equal(readStoredTheme({ storage, fallback: "softLight" }), "softLight");
  assert.equal(setTheme("dark", { storage, root }), "dark");
  assert.equal(root.dataset.kyTheme, "dark");
  assert.doesNotThrow(() => storeTheme("dark", { storage }));
});
