// Regression test for the formatting toolbar: the code block button has an icon and every title
// tooltip is rendered by the design-system tip instead of the native browser tooltip.
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

const note = page.locator('.mn-card[data-type="note"]:not(.is-child)').first();
await note.locator('[data-field="text"]').dblclick();
await page.waitForTimeout(450);

const codeButton = page.locator('.mn-context-btn[data-format="formatBlock"]');
check("the code block button exists", (await codeButton.count()) === 1);
check("the code block button has a vector icon", (await codeButton.locator("svg").count()) === 1);

const bold = page.locator('.mn-context-btn[data-format="bold"]');
await bold.hover();
await page.waitForTimeout(250);
const tip = page.locator(".mn-design-tip");
check("hover shows a design-system tooltip", (await tip.innerText()).trim() === "Bold", await tip.innerText());
check("the native title is suppressed while the tip is visible", (await bold.getAttribute("title")) === null);
const style = await tip.evaluate((el) => {
  const computed = getComputedStyle(el);
  return { position: computed.position, radius: computed.borderRadius, shadow: computed.boxShadow };
});
check(
  "the tooltip uses the popup surface and radius",
  style.position === "fixed" && style.radius !== "0px" && style.shadow !== "none",
  JSON.stringify(style)
);

await page.locator("#settings-btn").hover();
await page.waitForTimeout(250);
check("icon buttons use the same tooltip", (await tip.innerText()).trim() === "Settings", await tip.innerText());
check("no runtime errors", errors.length === 0, errors.join(" | ").slice(0, 200));

await browser.close();
const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
