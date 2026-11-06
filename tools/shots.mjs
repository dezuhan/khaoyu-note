// Refresh the board screenshots used by the README. Each context starts with an empty
// localStorage, so the welcome board is seeded fresh in the current theme.
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, "..", "shots");
const url = process.argv[2] || "http://127.0.0.1:1430/";

const browser = await chromium.launch();

async function capture(name, { theme = "light", scale = 1 } = {}) {
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
  await page.screenshot({ path: path.join(shots, name) });
  console.log(`${name} errors=${errors.length}`);
  await context.close();
}

await capture("board-light.png");
await capture("board-dark.png", { theme: "dark" });
await capture("welcome-all-tools.png", { scale: 2 });

await browser.close();
