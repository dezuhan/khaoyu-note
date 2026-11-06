// Regression test for a failed save: the board must stay dirty, report the failure and retry
// automatically until the write succeeds.
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
await page.waitForTimeout(1200);

const boardId = await page.evaluate(() => localStorage.getItem("mn.lastBoard"));

// Fail exactly the next board write, then let the automatic retry succeed.
await page.evaluate(() => {
  const original = Storage.prototype.setItem;
  window.__mnFailNextBoardWrite = true;
  Storage.prototype.setItem = function (key, value) {
    if (window.__mnFailNextBoardWrite && String(key).startsWith("mn.board.")) {
      window.__mnFailNextBoardWrite = false;
      throw new DOMException("disk full", "QuotaExceededError");
    }
    return original.call(this, key, value);
  };
});

const note = page.locator('.mn-card[data-type="note"]').first();
await note.locator('[data-field="text"]').dblclick();
await page.keyboard.type(" retrytoken");
await page.mouse.click(700, 760);
await page.waitForTimeout(150);
await page.evaluate(() => {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, bubbles: true })
  );
});
await page.waitForTimeout(250);

const failedLabel = (await page.locator("#save-state").innerText()).trim();
check("a failed save is reported", failedLabel === "Save failed", failedLabel);

await page.waitForTimeout(2200);
const savedLabel = (await page.locator("#save-state").innerText()).trim();
check("the automatic retry saves without another edit", savedLabel === "Saved", savedLabel);

const persisted = await page.evaluate((id) => {
  const raw = localStorage.getItem("mn.board." + id);
  if (!raw) return false;
  return raw.includes("retrytoken");
}, boardId);
check("the retried snapshot reached storage", persisted);

check("no uncaught page errors", errors.length === 0, errors.join(" | ").slice(0, 200));

await browser.close();
const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
