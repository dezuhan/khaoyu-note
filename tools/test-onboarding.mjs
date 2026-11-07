// First-run account gate check against the local web host.
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
  check("first run requires the local admin account", await page.locator(".mn-onboard-panel").isVisible());
  check(
    "the gate asks for the account fields",
    (await page.locator('[data-role="setup-form"] input[name="username"]').count()) === 1 &&
      (await page.locator('[data-role="setup-form"] input[name="email"]').count()) === 1 &&
      (await page.locator('[data-role="setup-form"] input[name="password"]').count()) === 1
  );
  check(
    "the gate has no guest escape",
    (await page.locator('[data-role="continue-local"]').count()) === 0
  );
  check(
    "the create admin action is available",
    (await page.locator('[data-role="create-admin"]').count()) === 1
  );
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
