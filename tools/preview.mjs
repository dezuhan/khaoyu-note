import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] || "http://127.0.0.1:1430/";
const out = process.argv[3] || path.join(here, "..", "shots", "playwright.png");
const width = Number(process.env.MN_W || 1440);
const height = Number(process.env.MN_H || 900);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
const logs = [];
page.on("console", (message) => logs.push(`[${message.type()}] ${message.text()}`));
page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message}`));

try {
  await page.goto(url, { waitUntil: "load", timeout: 20000 });
} catch (error) {
  logs.push(`[goto] ${error.message}`);
}
await page.waitForTimeout(1500);

const state = await page.evaluate(() => {
  const board = window.localStorage.getItem("mn.lastBoard");
  return {
    boot: document.getElementById("boot")?.textContent?.slice(0, 300) || null,
    cards: document.querySelectorAll(".mn-card").length,
    tools: document.querySelectorAll(".mn-tool").length,
    title: document.title,
    hasApp: !!document.getElementById("app"),
    appHidden: document.getElementById("app")?.hidden,
    board: board,
  };
});
console.log(JSON.stringify(state, null, 2));
console.log(logs.length ? logs.join("\n") : "no console output");
await page.screenshot({ path: out });
console.log("SHOT " + out);
await browser.close();
