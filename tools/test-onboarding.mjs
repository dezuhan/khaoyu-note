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
  await page.waitForTimeout(1400);
  check("first run shows the local admin setup", await page.locator(".mn-onboard-panel").isVisible());
  check(
    "setup offers create admin and continue locally",
    (await page.locator(".mn-onboard-actions").innerText()).includes("Create admin") &&
      (await page.locator(".mn-onboard-actions").innerText()).includes("Continue locally")
  );
  check(
    "setup asks for the local account fields",
    (await page.locator(".mn-auth-panel input").count()) >= 6
  );
  await page.click('[data-role="continue-local"]');
  check("continue locally dismisses the gate", (await page.locator(".mn-onboard-panel").count()) === 0);
  check("the avatar stays available as a guest", (await page.locator("#account-btn").count()) === 1);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
