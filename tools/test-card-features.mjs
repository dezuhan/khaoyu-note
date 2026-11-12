// Regression test for lock position, card conversions, and sheet overflow inside a column.
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:1430/";
const results = [];
const allErrors = [];

function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? "  ::  " + detail : ""}`);
}

const browser = await chromium.launch();

async function freshPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
  allErrors.push(errors);
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(1600);
  return { context, page, errors };
}

// ---------------------------------------------------------------- lock position
{
  const { context, page, errors } = await freshPage();
  const note = page.locator('.mn-card[data-type="note"]:not(.is-child)').first();
  let box = await note.boundingBox();
  await page.mouse.click(box.x + 40, box.y + 18, { button: "right" });
  await page.waitForTimeout(250);
  check("the context menu offers Lock position", (await page.locator(".mn-menu").innerText()).includes("Lock position"));
  await page.locator(".mn-menu-item", { hasText: "Lock position" }).click();
  await page.waitForTimeout(400);
  check("locking adds the locked state and badge", (await page.locator(".mn-card.is-locked .mn-lock-badge").count()) === 1);
  check(
    "a locked card hides its resize handle",
    (await page.locator(".mn-card.is-locked .mn-resize").evaluate((el) => getComputedStyle(el).display)) === "none"
  );
  await page.locator(".mn-card.is-locked .mn-note-text").dblclick({ force: true });
  await page.waitForTimeout(250);
  check(
    "a locked note cannot enter text editing",
    (await page.locator(".mn-card.is-locked .mn-note-text").getAttribute("contenteditable")) === "false"
  );

  const before = await page.locator(".mn-card.is-locked").first().boundingBox();
  await page.mouse.move(before.x + 40, before.y + 18);
  await page.mouse.down();
  await page.mouse.move(before.x + 180, before.y + 130, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await page.locator(".mn-card.is-locked").first().boundingBox();
  check("a locked card cannot be dragged", Math.abs(after.x - before.x) < 1 && Math.abs(after.y - before.y) < 1, `${Math.round(after.x - before.x)},${Math.round(after.y - before.y)}`);

  await page.mouse.click(after.x + 40, after.y + 18, { button: "right" });
  await page.waitForTimeout(250);
  check("a locked card can still be selected to unlock", (await page.locator(".mn-menu").innerText()).includes("Unlock position"));
  await page.locator(".mn-menu-item", { hasText: "Unlock position" }).click();
  await page.waitForTimeout(300);
  check("unlocking removes the lock state", (await page.locator(".mn-card.is-locked").count()) === 0);

  const unlocked = await page.locator('.mn-card[data-type="note"]:not(.is-child)').first().boundingBox();
  const noteText = page.locator('.mn-card[data-type="note"]:not(.is-child)').first().locator(".mn-note-text");
  await noteText.dblclick();
  await page.keyboard.press("Control+a");
  await page.waitForTimeout(200);
  await page.locator('.mn-context-btn[data-format="bold"]').click();
  await page.locator('.mn-context-btn[data-format="underline"]').click();
  await page.waitForTimeout(200);
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.waitForTimeout(500);
  check(
    "note formatting survives leaving edit mode",
    (await noteText.locator("b, strong").count()) > 0 && (await noteText.locator("u").count()) > 0
  );

  await page.mouse.click(unlocked.x + 40, unlocked.y + 18, { button: "right" });
  await page.waitForTimeout(250);
  await page.locator(".mn-menu-item", { hasText: "Convert to document" }).click();
  await page.waitForTimeout(600);
  const documentCard = page.locator('.mn-card[data-type="document"]').first();
  check("a note becomes a document card", (await documentCard.count()) === 1);
  check("the document keeps the note text", (await documentCard.locator(".mn-doc-text").innerText()).includes("Double-click"));
  check(
    "the converted document renders rich text, not escaped HTML",
    (await documentCard.locator(".mn-doc-text b, .mn-doc-text u").count()) > 0 &&
      !(await documentCard.locator(".mn-doc-text").innerText()).includes("<p>")
  );
  check("no runtime errors in the lock case", errors.length === 0, errors.join(" | ").slice(0, 200));
  await context.close();
}

// ---------------------------------------------------------------- column to board
{
  const { context, page, errors } = await freshPage();
  const column = page.locator(".mn-card-column").first();
  const box = await column.boundingBox();
  const boardsBefore = await page.locator('.mn-card[data-type="board"]').count();
  await page.mouse.click(box.x + 120, box.y + 14, { button: "right" });
  await page.waitForTimeout(250);
  check("the context menu offers Convert to board", (await page.locator(".mn-menu").innerText()).includes("Convert to board"));
  await page.locator(".mn-menu-item", { hasText: "Convert to board" }).click();
  await page.waitForTimeout(1000);
  check("the column is replaced by a board card", (await page.locator(".mn-card-column").count()) === 0 && (await page.locator('.mn-card[data-type="board"]').count()) === boardsBefore + 1);
  const boards = page.locator('.mn-card[data-type="board"]');
  await page.evaluate(() => {
    const cards = document.querySelectorAll('.mn-card[data-type="board"]');
    cards[cards.length - 1].querySelector(".mn-board-card").click();
  });
  await page.waitForTimeout(1100);
  check("the converted board contains the column items", (await page.locator(".mn-card").count()) === 2);
  check("no runtime errors in the column case", errors.length === 0, errors.join(" | ").slice(0, 200));
  await context.close();
}

// ---------------------------------------------------------------- sheet in a column
{
  const { context, page, errors } = await freshPage();
  const tool = page.locator('.mn-tool[data-tool="table"]');
  const column = page.locator(".mn-card-column").first();
  const toolBox = await tool.boundingBox();
  const columnBox = await column.boundingBox();
  await page.mouse.move(toolBox.x + toolBox.width / 2, toolBox.y + toolBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(columnBox.x + columnBox.width / 2, columnBox.y + columnBox.height / 2, { steps: 14 });
  await page.waitForTimeout(200);
  const previewBox = await page
    .locator(".mn-drop-reservation, .mn-tool-drop-preview")
    .first()
    .boundingBox();
  await page.mouse.up();
  await page.waitForTimeout(800);

  const tableCard = page.locator(".mn-card-table").last();
  const tableBox = await tableCard.boundingBox();
  check(
    "the drop preview matches the sheet size inside the column",
    previewBox && Math.abs(previewBox.width - tableBox.width) < 2 && Math.abs(previewBox.height - tableBox.height) < 20,
    JSON.stringify({ preview: previewBox, card: tableBox })
  );
  await tableCard.click({ position: { x: 50, y: 26 } });
  await page.waitForTimeout(200);
  for (let index = 0; index < 4; index += 1) {
    await tableCard.locator(".mn-table-add").click();
    await tableCard.locator('.mn-table-menu button[data-action="table-add-column"]').click();
    await page.waitForTimeout(220);
  }
  const metrics = await tableCard.evaluate((el) => {
    const table = el.querySelector(".mn-table");
    const columns = el.querySelector(".mn-sheet-cols");
    const clip = el.querySelector(".mn-sheet-cols-clip");
    return {
      cardWidth: el.getBoundingClientRect().width,
      scrollWidth: table.scrollWidth,
      clientWidth: table.clientWidth,
      columnsWidth: columns.getBoundingClientRect().width,
      clipWidth: clip.getBoundingClientRect().width,
      overflowX: getComputedStyle(table).overflowX,
      clipOverflow: getComputedStyle(clip).overflow,
    };
  });
  check("the sheet overflows horizontally inside the column", metrics.scrollWidth > metrics.clientWidth, JSON.stringify(metrics));
  check(
    "the column header strip is clipped to the card",
    metrics.columnsWidth > metrics.clipWidth && metrics.clipOverflow === "hidden"
  );

  const scrollPointer = await tableCard.evaluate((el) => {
    const table = el.querySelector(".mn-table");
    const rect = table.getBoundingClientRect();
    const card = el.getBoundingClientRect();
    const pointer = new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      clientX: rect.right - 20,
      clientY: rect.bottom - 4,
      button: 0,
    });
    const dispatched = table.dispatchEvent(pointer);
    return {
      prevented: pointer.defaultPrevented,
      dispatched,
      left: rect.right - 20,
      bottom: rect.bottom - 4,
      cardX: card.x,
      cardY: card.y,
    };
  });
  check("pointerdown on the sheet scrollbar is not cancelled", !scrollPointer.prevented && scrollPointer.dispatched);

  await page.mouse.move(scrollPointer.left, scrollPointer.bottom);
  await page.mouse.down();
  await page.mouse.move(scrollPointer.left - 60, scrollPointer.bottom, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const afterScrollDrag = await tableCard.boundingBox();
  check(
    "dragging the sheet scrollbar does not move the card",
    Math.abs(afterScrollDrag.x - scrollPointer.cardX) < 2 && Math.abs(afterScrollDrag.y - scrollPointer.cardY) < 2
  );

  await tableCard.locator(".mn-table").evaluate((el) => {
    el.scrollLeft = 0;
  });
  await tableCard.locator(".mn-table").hover();
  await page.mouse.wheel(120, 0);
  await page.waitForTimeout(250);
  check(
    "the mouse wheel can scroll the sheet horizontally",
    (await tableCard.locator(".mn-table").evaluate((el) => el.scrollLeft)) > 0
  );

  await tableCard.locator(".mn-table").evaluate((el) => {
    el.scrollLeft = 150;
  });
  await page.waitForTimeout(200);
  const shifted = await tableCard.evaluate((el) => ({
    left: el.querySelector(".mn-table").scrollLeft,
    transform: el.querySelector(".mn-sheet-cols").style.transform,
  }));
  check("the header follows the sheet scroll", shifted.left > 0 && shifted.transform === `translateX(${-shifted.left}px)`, JSON.stringify(shifted));
  check("no runtime errors in the sheet case", errors.length === 0, errors.join(" | ").slice(0, 200));
  await context.close();
}

await browser.close();
const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
