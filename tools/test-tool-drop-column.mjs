// Regression test for dragging a tool from the rail directly into a column.
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

const before = await page.evaluate(() => {
  const id = localStorage.getItem("mn.lastBoard");
  const doc = JSON.parse(localStorage.getItem("mn.board." + id));
  const column = doc.cards.find((card) => card.type === "column");
  return {
    id,
    columnId: column.id,
    children: doc.cards.filter((card) => card.parentId === column.id).length,
    noteIds: doc.cards.filter((card) => card.parentId === column.id && card.type === "note").map((card) => card.id),
    total: doc.cards.length,
  };
});

const tool = page.locator('.mn-tool[data-tool="note"]');
const column = page.locator(".mn-card-column").first();
const toolBox = await tool.boundingBox();
const columnBox = await column.boundingBox();

await page.mouse.move(toolBox.x + toolBox.width / 2, toolBox.y + toolBox.height / 2);
await page.mouse.down();
await page.mouse.move(columnBox.x + columnBox.width / 2, columnBox.y + columnBox.height / 2, {
  steps: 16,
});
await page.waitForTimeout(150);
const highlighted = await column.evaluate((el) => el.classList.contains("is-drop-target"));
check("the column highlights while dragging a tool over it", highlighted);
await page.mouse.up();
await page.waitForTimeout(700);
const domChildren = await page.locator(".mn-card.is-child").count();
check("the tool appears inside the column immediately", domChildren === before.children + 1, `${before.children} -> ${domChildren}`);

await page.evaluate(() => {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, bubbles: true })
  );
});
await page.waitForTimeout(600);
const after = await page.evaluate(({ boardId, noteIds }) => {
  const doc = JSON.parse(localStorage.getItem("mn.board." + boardId));
  const column = doc.cards.find((card) => card.type === "column");
  const children = doc.cards.filter((card) => card.parentId === column.id);
  return {
    children: children.length,
    total: doc.cards.length,
    newNote: children.find((card) => card.type === "note" && !noteIds.includes(card.id)),
  };
}, { boardId: before.id, noteIds: before.noteIds });

check("the tool is added as a column child", after.children === before.children + 1, `${before.children} -> ${after.children}`);
check("the card count increases by one", after.total === before.total + 1, `${before.total} -> ${after.total}`);
check(
  "the new child is a note with the column as parent",
  after.newNote?.parentId === before.columnId,
  `${after.newNote?.type} / ${after.newNote?.parentId}`
);
check("no runtime errors", errors.length === 0, errors.join(" | ").slice(0, 200));

await browser.close();
const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
