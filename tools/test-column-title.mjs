// Regression test for editing a column title in place: double click, type, Enter, and persistence.
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:1430/";
const results = [];
const errors = [];

function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? "  ::  " + detail : ""}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (error) => errors.push("pageerror: " + error.message));

await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(1500);

const title = page.locator(".mn-column-title").first();
await title.dblclick();
await page.waitForTimeout(150);
check("double click enters title edit mode", (await title.getAttribute("contenteditable")) === "true");
check("the title shows its editing style", (await title.getAttribute("class")).includes("is-editing"));

await page.keyboard.press("Control+a");
await page.keyboard.type("Ideas");
await page.keyboard.press("Enter");
await page.waitForTimeout(250);
check("Enter keeps the new title", (await title.innerText()).trim() === "Ideas", await title.innerText());

await page.evaluate(() => {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, bubbles: true })
  );
});
await page.waitForTimeout(600);
const stored = await page.evaluate(() => {
  const id = localStorage.getItem("ky.lastBoard");
  return JSON.parse(localStorage.getItem("ky.board." + id)).cards.find((card) => card.type === "column").title;
});
check("the column title is persisted", stored === "Ideas", stored);
check("the board reports saved", (await page.locator("#save-state").innerText()).trim() === "Saved");

await page.reload({ waitUntil: "load" });
await page.waitForTimeout(1400);
check("the title survives a reload", (await page.locator(".mn-column-title").first().innerText()).trim() === "Ideas");
check("no runtime errors", errors.length === 0, errors.join(" | ").slice(0, 200));

await browser.close();
const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
