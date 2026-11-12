// End-to-end cross-window live refresh for the localhost web host. Two pages share one session but
// have independent tabs; an edit in one must reach the other through the web host SSE stream without
// a manual reload. A direct SQLite write also simulates the desktop process writing the shared DB.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "khaoyu-web-live-"));
const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const chosen = probe.address().port;
    probe.close(() => resolve(chosen));
  });
});
const url = `http://127.0.0.1:${port}`;
const results = [];
function check(name, condition, detail = "") {
  results.push(Boolean(condition));
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? `  ::  ${detail}` : ""}`);
}
const server = spawn(process.execPath, [path.join(root, "server.mjs")], {
  cwd: root,
  env: { ...process.env, KHAOYU_NOTE_DB_DIR: dataDir, KHAOYU_WEB_PORT: String(port), KHAOYU_WEB_HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (chunk) => (serverLog += chunk.toString()));
server.stderr.on("data", (chunk) => (serverLog += chunk.toString()));
async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { const response = await fetch(`${url}/status`); if (response.ok) return response.json(); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`web server did not start:\n${serverLog}`);
}
let browser;
try {
  const status = await waitForServer();
  browser = await chromium.launch();
  const context = await browser.newContext();
  const pageA = await context.newPage();
  await pageA.goto(url, { waitUntil: "load" });
  await pageA.waitForSelector('[data-role="account-gate"], .mn-web-badge', { timeout: 15000 });
  if ((await pageA.locator('[data-role="account-gate"]').count()) > 0) {
    await pageA.fill('[data-role="setup-form"] input[name="username"]', "owner");
    await pageA.fill('[data-role="setup-form"] input[name="email"]', "owner@localhost");
    await pageA.fill('[data-role="setup-form"] input[name="firstName"]', "Owner");
    await pageA.fill('[data-role="setup-form"] input[name="password"]', "correct horse battery staple");
    await pageA.fill('[data-role="setup-form"] input[name="confirmPassword"]', "correct horse battery staple");
    await pageA.click('[data-role="create-admin"]');
  }
  await pageA.waitForSelector(".mn-web-badge", { timeout: 20000 });
  const pageB = await context.newPage();
  await pageB.goto(url, { waitUntil: "load" });
  await pageB.waitForSelector(".mn-web-badge", { timeout: 20000 });
  await pageA.waitForFunction(async () => Boolean((await import("/js/store.js")).state.board), null, { timeout: 10000 });
  await pageB.waitForFunction(async () => Boolean((await import("/js/store.js")).state.board), null, { timeout: 10000 });
  await pageB.evaluate(() => { window.__liveMarker = "still-here"; });
  await pageA.evaluate(() => { window.__liveMarker = "still-here"; });
  await pageA.waitForTimeout(800);

  await pageA.evaluate(async () => {
    const store = await import("/js/store.js");
    store.state.board.title = "Live from A";
    store.markDirty("board");
    await store.saveNow();
  });
  await pageB.waitForFunction(async () => (await import("/js/store.js")).state.board?.title === "Live from A", null, { timeout: 6000 });
  check("page B receives A's edit without reload", (await pageB.evaluate(() => window.__liveMarker)) === "still-here");

  await pageB.evaluate(async () => {
    const store = await import("/js/store.js");
    store.state.board.title = "Live from B";
    store.markDirty("board");
    await store.saveNow();
  });
  await pageA.waitForFunction(async () => (await import("/js/store.js")).state.board?.title === "Live from B", null, { timeout: 6000 });
  check("page A receives B's edit without reload", (await pageA.evaluate(() => window.__liveMarker)) === "still-here");

  // Autosave path: no explicit saveNow; the 2s idle save must broadcast on its own.
  await pageA.evaluate(async () => {
    const store = await import("/js/store.js");
    store.state.board.title = "Autosaved from A";
    store.markDirty("board");
  });
  await pageB.waitForFunction(async () => (await import("/js/store.js")).state.board?.title === "Autosaved from A", null, { timeout: 7000 });
  check("autosave broadcasts without an explicit save", (await pageB.evaluate(() => window.__liveMarker)) === "still-here");

  // Simulate the desktop process writing the same SQLite database.
  const activeBoard = await pageA.evaluate(async () => (await import("/js/store.js")).state.board.id);
  const db = new DatabaseSync(status.database);
  db.prepare("UPDATE boards SET title = ?, updated_at = ? WHERE id = ?").run("Live from desktop", Date.now(), activeBoard);
  db.close();
  await pageB.waitForFunction(async () => (await import("/js/store.js")).state.board?.title === "Live from desktop", null, { timeout: 6000 });
  check("a direct SQLite/desktop write reaches a web page without reload", (await pageB.evaluate(() => window.__liveMarker)) === "still-here");
} catch (error) {
  console.error("FAIL", error.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
process.exit(results.every(Boolean) ? 0 : 1);
