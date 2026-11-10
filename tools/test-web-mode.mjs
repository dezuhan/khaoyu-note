// End-to-end test for the localhost web host: it must create its SQLite database, serve /status,
// paint the menu-bar badge, persist an edit across reload, and show host/port in Settings > About.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "khaoyu-web-"));
const port = 1432;
const url = `http://127.0.0.1:${port}`;
const results = [];
const errors = [];

function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? "  ::  " + detail : ""}`);
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
  for (let attempt = 0; attempt < 60; attempt += 1) {
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

let browser;
try {
  const status = await waitForServer();
  check("status endpoint reports web mode", status.mode === "web", status.mode);
  check("status reports host and port", status.host === "127.0.0.1" && status.port === port);
  check("status points at the SQLite database", String(status.database).endsWith("khaoyu-note.db"), status.database);

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().includes("Permissions policy violation: compute-pressure")
    ) {
      errors.push("console: " + message.text());
    }
  });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector('[data-role="account-gate"], .mn-web-badge', { timeout: 15000 });
  // A fresh database requires the local admin account before the app opens.
  if ((await page.locator('[data-role="account-gate"]').count()) > 0) {
    await page.fill('[data-role="setup-form"] input[name="username"]', "owner");
    await page.fill('[data-role="setup-form"] input[name="email"]', "owner@localhost");
    await page.fill('[data-role="setup-form"] input[name="firstName"]', "Owner");
    await page.fill('[data-role="setup-form"] input[name="password"]', "correct horse battery staple");
    await page.fill(
      '[data-role="setup-form"] input[name="confirmPassword"]',
      "correct horse battery staple"
    );
    await page.click('[data-role="create-admin"]');
  }
  await page.waitForSelector(".mn-web-badge", { timeout: 20000 });
  await page.waitForTimeout(300);

  check("the app boots against the web backend", await page.locator("#app").isVisible());
  check(
    "the menu bar shows the host and port badge",
    (await page.locator(".mn-web-badge").innerText()).includes(`127.0.0.1:${port}`),
    await page.locator(".mn-web-badge").innerText()
  );

  const chooserPromise = page.waitForEvent("filechooser");
  await page.locator('.mn-tool[data-tool="image"]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
      "base64"
    ),
  });
  await page.waitForTimeout(800);
  const imageLoaded = await page
    .locator('.mn-card-image img[src*="/api/asset"]')
    .first()
    .evaluate((img) => img.complete && img.naturalWidth > 0)
    .catch(() => false);
  check("an uploaded image is stored and served by the web host", imageLoaded);

  const linkCard = page.locator('.mn-card[data-type="link"]').first();
  const linkBox = await linkCard.boundingBox();
  await page.mouse.click(linkBox.x + linkBox.width / 2, linkBox.y + 20, { button: "right" });
  await page.waitForTimeout(250);
  const headerChooserPromise = page.waitForEvent("filechooser");
  await page.locator(".mn-menu-item", { hasText: "Add header image" }).click();
  const headerChooser = await headerChooserPromise;
  await headerChooser.setFiles({
    name: "header.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect width="400" height="100" fill="#c7d2fe"/></svg>'
    ),
  });
  await page.waitForTimeout(1000);
  const header = await linkCard.evaluate((el) => {
    const image = el.querySelector(".mn-link-header img");
    return {
      has: Boolean(image),
      width: image?.naturalWidth || 0,
      height: image?.naturalHeight || 0,
      cardHeight: el.getBoundingClientRect().height,
    };
  });
  check(
    "a link header image keeps its file ratio and grows the card",
    header.has && header.width === 400 && header.height === 100 && header.cardHeight > 90,
    JSON.stringify(header)
  );

  const before = await page.locator(".mn-card").count();
  await page.locator('.mn-tool[data-tool="note"]').click();
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, bubbles: true })
    );
  });
  await page.waitForTimeout(700);
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("#app", { state: "visible", timeout: 20000 });
  await page.waitForTimeout(500);
  const after = await page.locator(".mn-card").count();
  check("an edit survives a reload through SQLite", after === before + 1, `${before} -> ${after}`);

  await page.locator("#settings-btn").click();
  await page.waitForTimeout(400);
  await page.locator(".mn-prefs-nav button", { hasText: "About" }).first().click();
  await page.waitForTimeout(300);
  const about = await page.locator(".mn-prefs-content").innerText();
  check("Settings > About shows the web mode", about.includes("Web (localhost)") && about.includes(String(port)), about.replace(/\s+/g, " ").slice(0, 120));
  check("no runtime errors", errors.length === 0, errors.join(" | ").slice(0, 200));
} finally {
  if (browser) await browser.close();
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows may hold the WAL briefly */
  }
}

const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
