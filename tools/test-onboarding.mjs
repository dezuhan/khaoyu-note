// Local-first onboarding check: no account gate should appear.
// node tools/test-onboarding.mjs http://127.0.0.1:1430/
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:1430/";
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  ::  " + detail : ""}`);
  if (!ok) failed += 1;
}

try {
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(1600);
  check("no account gate is shown", (await page.locator('[data-role="account-gate"]').count()) === 0);
  check(
    "the board is available without an account",
    (await page.locator(".mn-viewport").isVisible()) &&
      (await page.locator("#account-btn").isVisible())
  );
  check(
    "Settings remains available without an account",
    await page.locator("#settings-btn").isVisible()
  );
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
