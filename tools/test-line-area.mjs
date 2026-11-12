// Regression test for the line tool: a free endpoint stays free 20 px from a card, snaps within
// the reduced threshold, and the connection hit area is no longer oversized.
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

const hitWidth = await page
  .locator(".mn-connection-hit")
  .first()
  .evaluate((el) => parseFloat(getComputedStyle(el).strokeWidth));
check("the connection hit area is tightened", hitWidth <= 10, String(hitWidth));

const empty = await page.evaluate(() => {
  const viewport = document.getElementById("viewport").getBoundingClientRect();
  for (let y = viewport.top + 80; y < viewport.bottom - 40; y += 20) {
    for (let x = viewport.left + 90; x < viewport.right - 40; x += 20) {
      if (!document.elementFromPoint(x, y)?.closest(".mn-card")) return { x, y };
    }
  }
  return null;
});
check("an empty start point is available", Boolean(empty), JSON.stringify(empty));

const target = page.locator(".mn-card-heading").first();
const targetBox = await target.boundingBox();
const targetX = await target.evaluate((el) => parseFloat(el.style.left));
const midY = targetBox.y + targetBox.height / 2;

async function drawLine(endX, start) {
  await page.locator('.mn-tool[data-tool="line"]').click();
  await page.waitForTimeout(150);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(endX, midY, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  const d = await page.locator(".mn-connection").last().getAttribute("d");
  const match = d.match(/M\s*([\d.-]+)\s+([\d.-]+)\s+L\s*([\d.-]+)\s+([\d.-]+)/);
  return match ? { x: Number(match[3]), y: Number(match[4]) } : null;
}

const freeEnd = await drawLine(targetBox.x - 20, empty);
check(
  "an endpoint 20 px away stays free",
  freeEnd && freeEnd.x < targetX - 5,
  JSON.stringify({ endX: freeEnd?.x, cardX: targetX })
);

const secondStart = await page.evaluate(() => {
  const viewport = document.getElementById("viewport").getBoundingClientRect();
  for (let y = viewport.top + 80; y < viewport.bottom - 40; y += 20) {
    for (let x = viewport.left + 90; x < viewport.right - 40; x += 20) {
      const el = document.elementFromPoint(x, y);
      if (!el?.closest(".mn-card, .mn-connection-hit, .mn-line-handle")) return { x, y };
    }
  }
  return null;
});
check("a second empty start point is available", Boolean(secondStart), JSON.stringify(secondStart));

const snappedEnd = await drawLine(targetBox.x - 5, secondStart);
check(
  "an endpoint 5 px away snaps to the card edge",
  snappedEnd && Math.abs(snappedEnd.x - targetX) < 1.5,
  JSON.stringify({ endX: snappedEnd?.x, cardX: targetX })
);
check("no runtime errors", errors.length === 0, errors.join(" | ").slice(0, 200));

await browser.close();
const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
