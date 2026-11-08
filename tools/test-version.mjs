// Verify that every user-facing version field points at the same release.
import assert from "node:assert/strict";
import fs from "node:fs";

function jsonVersion(file) {
  return JSON.parse(fs.readFileSync(file, "utf8")).version;
}

const rootPkg = jsonVersion("package.json");
const appPkg = jsonVersion("app/package.json");
const servicePkg = jsonVersion("service/package.json");
const tauri = JSON.parse(fs.readFileSync("app/src-tauri/tauri.conf.json", "utf8")).version;
const cargo = fs
  .readFileSync("app/src-tauri/Cargo.toml", "utf8")
  .match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
const cargoLock = fs
  .readFileSync("app/src-tauri/Cargo.lock", "utf8")
  .match(/name = "khaoyu-note"\r?\nversion = "([^"]+)"/)?.[1];
const appLock = JSON.parse(fs.readFileSync("app/package-lock.json", "utf8")).version;
const rootLock = JSON.parse(fs.readFileSync("package-lock.json", "utf8")).version;
const serviceLock = JSON.parse(fs.readFileSync("service/package-lock.json", "utf8")).version;
const docker = fs
  .readFileSync("service/docker-compose.yml", "utf8")
  .match(/image: khaoyu-note-service:([0-9]+\.[0-9]+\.[0-9]+)/)?.[1];
const readme = fs.readFileSync("README.md", "utf8");
const landing = fs.readFileSync("index.html", "utf8");

const versions = {
  "package.json": rootPkg,
  "package-lock.json": rootLock,
  "app/package.json": appPkg,
  "app/package-lock.json": appLock,
  "service/package.json": servicePkg,
  "service/package-lock.json": serviceLock,
  "tauri.conf.json": tauri,
  "Cargo.toml": cargo,
  "Cargo.lock": cargoLock,
  "docker-compose.yml": docker,
};

const expected = rootPkg;
for (const [file, version] of Object.entries(versions)) {
  assert.equal(version, expected, `${file} has ${version}, expected ${expected}`);
}
assert.match(readme, new RegExp(`Khaoyu Note_${expected}_x64-setup\\.exe`));
assert.match(readme, new RegExp(`Khaoyu Note_${expected}_x64_en-US\\.msi`));
assert.match(landing, new RegExp(`Khaoyu Note ${expected} · local-first`));
console.log(`PASS  every version field reports ${expected}`);
