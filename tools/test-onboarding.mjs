// First-run onboarding check against the local web host.
// node tools/test-onboarding.mjs http://127.0.0.1:1430/
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:1430/";
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
let failed = 0;
function check(name, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed += 1;
}

try {
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(1200);
  check("first run shows the account or server setup", await page.locator(".mn-onboard-panel").isVisible());
  check(
    "setup offers create account, connect server and local-only choices",
    (await page.locator(".mn-onboard-actions").innerText()).includes("Create account") &&
      (await page.locator(".mn-onboard-actions").innerText()).includes("Connect server") &&
      (await page.locator(".mn-onboard-actions").innerText()).includes("Continue locally")
  );
  await page.click('[data-role="local"]');
  check("continue locally dismisses setup", (await page.locator(".mn-onboard-panel").count()) === 0);
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(900);
  check("setup does not reappear on the next run", (await page.locator(".mn-onboard-panel").count()) === 0);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
