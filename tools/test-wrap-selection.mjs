// Regression test for the Wrap in column action: it is only offered for two or more non-column
// items, and Ctrl+G does nothing when the selection contains a column.
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
const heading = page.locator('.mn-card[data-type="heading"]').first();
const column = page.locator(".mn-card-column").first();

async function clickCard(card, modifiers = []) {
  const box = await card.boundingBox();
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.mouse.click(box.x + 24, box.y + 18);
  for (const modifier of modifiers) await page.keyboard.up(modifier);
  await page.waitForTimeout(120);
}

async function openCardMenu(card) {
  const box = await card.boundingBox();
  await page.mouse.click(box.x + 24, box.y + 18, { button: "right" });
  await page.waitForTimeout(250);
  return page.locator(".mn-menu").innerText();
}

await clickCard(note);
await clickCard(column, ["Shift"]);
let menu = await openCardMenu(note);
check("a column in the selection hides Wrap in column", !menu.includes("Wrap in column"), menu.replace(/\s+/g, " ").slice(0, 100));
await page.keyboard.press("Escape");

const columnsBefore = await page.locator(".mn-card-column").count();
await clickCard(note);
await clickCard(column, ["Shift"]);
await page.keyboard.press("Control+g");
await page.waitForTimeout(300);
check(
  "Ctrl+G with a column selected does not wrap",
  (await page.locator(".mn-card-column").count()) === columnsBefore,
  `${columnsBefore} -> ${await page.locator(".mn-card-column").count()}`
);

await page.mouse.click(700, 760);
await page.waitForTimeout(150);
await clickCard(note);
await clickCard(heading, ["Shift"]);
menu = await openCardMenu(note);
check("two non-column items still offer Wrap in column", menu.includes("Wrap in column"), menu.replace(/\s+/g, " ").slice(0, 120));
await page.locator(".mn-menu-item", { hasText: "Wrap in column" }).click();
await page.waitForTimeout(500);
check(
  "wrapping two items creates a column",
  (await page.locator(".mn-card-column").count()) === columnsBefore + 1,
  `${columnsBefore} -> ${await page.locator(".mn-card-column").count()}`
);
check("no runtime errors", errors.length === 0, errors.join(" | ").slice(0, 200));

await browser.close();
const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
