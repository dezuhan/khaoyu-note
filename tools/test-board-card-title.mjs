// Regression test: renaming a nested board must update the board card that links to it.
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
await page.waitForTimeout(1600);

const parentId = await page.evaluate(() => localStorage.getItem("ky.lastBoard"));
await page.evaluate(() => document.querySelector('.mn-card[data-type="board"] .mn-board-card').click());
await page.waitForTimeout(900);
check("the nested board opens", (await page.locator(".mn-crumb").count()) >= 2);

await page.locator(".mn-crumb.is-current").dblclick();
await page.waitForSelector(".mn-crumb-edit-input");
await page.locator(".mn-crumb-edit-input").fill("Nested Renamed");
await page.getByRole("button", { name: "Save" }).click();
await page.waitForTimeout(800);
await page.locator(".mn-crumb").first().click();
await page.waitForTimeout(1300);

check(
  "the board card shows the renamed child title",
  (await page.locator(".mn-board-card-title").first().innerText()).trim() === "Nested Renamed",
  await page.locator(".mn-board-card-title").first().innerText()
);

await page.evaluate(() => {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, bubbles: true })
  );
});
await page.waitForTimeout(700);
const stored = await page.evaluate((id) => {
  const doc = JSON.parse(localStorage.getItem("ky.board." + id));
  return doc.cards.find((card) => card.type === "board")?.title;
}, parentId);
check("the parent card title is persisted", stored === "Nested Renamed", stored);

await page.reload({ waitUntil: "load" });
await page.waitForTimeout(1500);
check(
  "the title survives a reload",
  (await page.locator(".mn-board-card-title").first().innerText()).trim() === "Nested Renamed"
);
check("no runtime errors", errors.length === 0, errors.join(" | ").slice(0, 200));

await browser.close();
const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
