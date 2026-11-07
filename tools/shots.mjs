// Refresh the board screenshots used by the README. Each context starts with an empty
// localStorage, so the welcome board is seeded fresh in the current theme.
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, "..", "shots");
const url = process.argv[2] || "http://127.0.0.1:1430/";

const browser = await chromium.launch();

async function capture(name, { theme = "light", scale = 1, settingsPage = "" } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: scale,
  });
  await context.addInitScript((value) => localStorage.setItem("mn.theme", value), theme);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(6200);
  if (settingsPage) {
    await page.click("#settings-btn");
    await page.waitForTimeout(400);
    await page.locator(".mn-prefs-nav-item", { hasText: settingsPage }).click();
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: path.join(shots, name) });
  console.log(`${name} errors=${errors.length}`);
  await context.close();
}

await capture("board-light.png");
await capture("board-dark.png", { theme: "dark" });
await capture("welcome-all-tools.png", { scale: 2 });
await capture("settings-general.png", { settingsPage: "General" });
await capture("settings-performance.png", { settingsPage: "Performance" });

async function captureEditor(name, type) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => localStorage.setItem("mn.theme", "light"));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(6200);
  await page.locator(`.mn-card[data-type="${type}"]`).first().dblclick();
  await page.waitForTimeout(700);
  if (name === "drawing-editor.png") {
    const canvas = page.locator(".mn-draw-canvas");
    const box = await canvas.boundingBox();
    if (box) {
      const x = box.x + box.width * 0.28;
      const y = box.y + box.height * 0.34;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 120, y + 70, { steps: 8 });
      await page.mouse.move(x + 250, y + 20, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(200);
    }
  }
  await page.screenshot({ path: path.join(shots, name) });
  console.log(`${name} errors=${errors.length}`);
  await context.close();
}

await captureEditor("doc-editor.png", "document");
await captureEditor("drawing-editor.png", "sketch");

await browser.close();
