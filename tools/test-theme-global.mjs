// Light/dark mode is a global appearance preference. This regression test seeds boards with legacy
// per-board themes, then checks that opening or switching boards never overrides the global theme,
// that the choice survives a reload, and that changing the theme does not dirty the board document.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "khaoyu-theme-"));
const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const chosen = probe.address().port;
    probe.close(() => resolve(chosen));
  });
});
const url = `http://127.0.0.1:${port}`;
let failed = 0;

function check(name, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? "  ::  " + detail : ""}`);
  if (!condition) failed += 1;
}

const server = spawn(process.execPath, [path.join(root, "server.mjs")], {
  cwd: root,
  env: { ...process.env, KHAOYU_NOTE_DB_DIR: dataDir, KHAOYU_WEB_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (chunk) => (serverLog += chunk.toString()));
server.stderr.on("data", (chunk) => (serverLog += chunk.toString()));

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${url}/status`);
      if (response.ok) return response.json();
    } catch {
      /* not ready */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("web server did not start:\n" + serverLog);
}

async function invoke(cmd, args) {
  const response = await fetch(`${url}/api/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd, args }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error || "invoke failed");
  return payload.result;
}

function boardDoc(id, title, theme) {
  const now = Date.now();
  const doc = {
    id,
    title,
    parentId: null,
    createdAt: now,
    updatedAt: now,
    grid: 24,
    showGrid: true,
    snapToGrid: false,
    view: { x: 0, y: 0, zoom: 1 },
    cards: [],
    connections: [],
    trash: [],
  };
  if (theme) doc.theme = theme;
  return doc;
}

let browser;
try {
  await waitForServer();
  await invoke("save_board", { id: "b_darklegacy", data: JSON.stringify(boardDoc("b_darklegacy", "Legacy dark", "dark")), baseUpdatedAt: null });
  await invoke("save_board", { id: "b_lightlegacy", data: JSON.stringify(boardDoc("b_lightlegacy", "Legacy light", "light")), baseUpdatedAt: null });
  await invoke("save_board", { id: "b_plain", data: JSON.stringify(boardDoc("b_plain", "No theme")), baseUpdatedAt: null });

  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${url}/`, { waitUntil: "load" });
  await page.evaluate(() => localStorage.setItem("mn.theme", "light"));

  const theme = () => page.evaluate(() => document.documentElement.dataset.kyTheme);
  const saveState = () => page.locator("#save-state").innerText();
  async function openBoard(id, title) {
    await page.goto(`${url}/?board=${id}`, { waitUntil: "load" });
    await page.waitForFunction(
      (expected) => document.querySelector(".mn-crumb.is-current")?.textContent.includes(expected),
      title
    );
    await page.waitForSelector("#theme-btn");
  }

  // A legacy dark board must not flip the global light preference when it is opened.
  await openBoard("b_darklegacy", "Legacy dark");
  check("global light theme survives opening a board saved with a dark theme", (await theme()) === "light", await theme());

  // Toggling the theme updates the global preference and leaves the document clean.
  await page.click("#theme-btn");
  await page.waitForTimeout(300);
  check("theme button switches to dark", (await theme()) === "dark", await theme());
  check("theme choice is stored globally", (await page.evaluate(() => localStorage.getItem("mn.theme"))) === "dark");
  check("changing the theme does not dirty the board", (await saveState()) === "Saved", await saveState());

  // Switching to a board whose document still says light keeps the global dark preference.
  await openBoard("b_lightlegacy", "Legacy light");
  check("global dark theme survives opening a board saved with a light theme", (await theme()) === "dark", await theme());

  // A reload keeps the global theme as well.
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("#theme-btn");
  check("theme survives a reload", (await theme()) === "dark", await theme());

  // A board created without a theme must not gain one when the theme is toggled.
  await openBoard("b_plain", "No theme");
  await page.click("#theme-btn");
  await page.waitForTimeout(300);
  await page.goto(`${url}/?board=b_plain`, { waitUntil: "load" });
  await page.waitForSelector("#theme-btn");
  const stored = JSON.parse(await invoke("load_board", { id: "b_plain" }));
  check("theme is not written into the board document", !stored.theme, String(stored.theme));
  check("theme stays light after the second toggle", (await theme()) === "light", await theme());

  if (failed) {
    console.log(`\n${failed} check(s) failed`);
    console.log(serverLog);
    process.exitCode = 1;
  } else {
    console.log("\nPASS  theme is global across boards and reloads");
  }
} catch (error) {
  console.error("FAIL", error.message);
  console.log(serverLog);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
