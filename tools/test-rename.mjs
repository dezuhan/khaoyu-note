// Regression test for renaming a project from the breadcrumb: explicit Save/Cancel,
// Enter to save, Escape to cancel, and persistence of the new title.
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

const storedTitle = () =>
  page.evaluate(() => {
    const id = localStorage.getItem("ky.lastBoard");
    return JSON.parse(localStorage.getItem("ky.board." + id)).title;
  });

await page.locator(".mn-crumb.is-current").dblclick();
await page.waitForSelector(".mn-crumb-edit-input");
check("double click opens the rename input", (await page.locator(".mn-crumb-edit-input").count()) === 1);
check(
  "an explicit Save button is available",
  (await page.getByRole("button", { name: "Save" }).count()) === 1
);
check(
  "a Cancel button is available",
  (await page.getByRole("button", { name: "Cancel" }).count()) === 1
);

await page.locator(".mn-crumb-edit-input").fill("Client Board");
await page.getByRole("button", { name: "Save" }).click();
await page.waitForTimeout(800);
check(
  "Save updates the breadcrumb",
  (await page.locator(".mn-crumb.is-current").innerText()).trim() === "Client Board"
);
check("Save persists the new title", (await storedTitle()) === "Client Board", await storedTitle());

await page.locator(".mn-crumb.is-current").dblclick();
await page.waitForSelector(".mn-crumb-edit-input");
await page.locator(".mn-crumb-edit-input").fill("Enter Board");
await page.keyboard.press("Enter");
await page.waitForTimeout(500);
check("Enter saves the new title", (await storedTitle()) === "Enter Board", await storedTitle());

await page.locator(".mn-crumb.is-current").dblclick();
await page.waitForSelector(".mn-crumb-edit-input");
await page.locator(".mn-crumb-edit-input").fill("Discarded");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
check(
  "Escape keeps the previous title",
  (await page.locator(".mn-crumb.is-current").innerText()).trim() === "Enter Board",
  await page.locator(".mn-crumb.is-current").innerText()
);
check("no runtime errors", errors.length === 0, errors.join(" | ").slice(0, 200));

await browser.close();
const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
