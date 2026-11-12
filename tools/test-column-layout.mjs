// Regression test for a column that holds a board card: entering the nested board and coming back
// must not leave stale child slots until the column is dragged.
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:1430/";
const results = [];
const errors = [];

function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? "  ::  " + detail : ""}`);
}

const now = Date.now();
const parent = {
  id: "b_parent",
  title: "Parent",
  parentId: null,
  createdAt: now,
  updatedAt: now,
  view: { x: 0, y: 0, zoom: 1 },
  grid: 24,
  showGrid: true,
  cards: [
    {
      id: "col1",
      type: "column",
      x: 120,
      y: 120,
      w: 320,
      h: 280,
      z: 1,
      parentId: null,
      order: 0,
      title: "Column",
      collapsed: false,
    },
    {
      id: "note1",
      type: "note",
      x: 134,
      y: 184,
      w: 292,
      h: 80,
      z: 2,
      parentId: "col1",
      order: 0,
      text: "Note",
    },
    {
      id: "board1",
      type: "board",
      x: 134,
      y: 274,
      w: 292,
      h: 140,
      z: 3,
      parentId: "col1",
      order: 1,
      boardId: "b_child",
      title: "New board",
    },
  ],
  connections: [],
  trash: [],
};
const child = {
  id: "b_child",
  title: "Child",
  parentId: "b_parent",
  createdAt: now,
  updatedAt: now,
  view: { x: 0, y: 0, zoom: 1 },
  grid: 24,
  showGrid: true,
  cards: [
    {
      id: "child_note",
      type: "note",
      x: 80,
      y: 80,
      w: 240,
      h: 80,
      z: 1,
      parentId: null,
      order: 0,
      text: "Inside the child board",
    },
  ],
  connections: [],
  trash: [],
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(({ parent, child }) => {
  if (localStorage.getItem("ky.boards")) return;
  localStorage.setItem("ky.board.b_parent", JSON.stringify(parent));
  localStorage.setItem("ky.board.b_child", JSON.stringify(child));
  localStorage.setItem("ky.boards", JSON.stringify(["b_parent", "b_child"]));
  localStorage.setItem("ky.lastBoard", "b_parent");
}, { parent, child });
const page = await context.newPage();
page.on("pageerror", (error) => errors.push("pageerror: " + error.message));

await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(1600);

const geometry = () =>
  page.evaluate(() => {
    const column = document.querySelector(".mn-card-column").getBoundingClientRect();
    const note = document.querySelector('.mn-card.is-child[data-type="note"]').getBoundingClientRect();
    const board = document.querySelector('.mn-card.is-child[data-type="board"]').getBoundingClientRect();
    return {
      columnBottom: column.bottom,
      noteBottom: note.bottom,
      boardTop: board.top,
      boardBottom: board.bottom,
    };
  });

const initial = await geometry();
check("initial children stack without overlap", initial.boardTop >= initial.noteBottom);
check("initial gap is the column gap", Math.abs(initial.boardTop - initial.noteBottom - 10) <= 2);

await page.evaluate(() => document.querySelector('.mn-card.is-child[data-type="board"] .mn-board-card').click());
await page.waitForTimeout(900);
check("the nested board opens", (await page.locator(".mn-crumb.is-current").innerText()).trim() === "Child");

await page.locator(".mn-crumb").first().click();
await page.waitForTimeout(1600);
const back = await geometry();
check("children stay stacked after returning", back.boardTop >= back.noteBottom);
check(
  "the gap stays correct after returning",
  Math.abs(back.boardTop - back.noteBottom - 10) <= 2,
  `${Math.round(back.boardTop - back.noteBottom)} px`
);
check("the column still contains both children", back.columnBottom >= back.boardBottom - 1);

await page.locator(".mn-column-toggle").first().click();
await page.waitForTimeout(400);
const collapsed = await page.evaluate(() => {
  const column = document.querySelector(".mn-card-column");
  const card = column.getBoundingClientRect();
  const title = column.querySelector(".mn-column-title").getBoundingClientRect();
  const summary = column.querySelector(".mn-column-summary").getBoundingClientRect();
  const head = getComputedStyle(column.querySelector(".mn-column-head"));
  return {
    collapsed: column.classList.contains("is-collapsed"),
    top: title.top - card.top,
    bottom: card.bottom - summary.bottom,
    paddingTop: head.paddingTop,
    paddingBottom: head.paddingBottom,
  };
});
check("clicking the toggle collapses the column", collapsed.collapsed);
check(
  "a collapsed column has symmetric top and bottom spacing",
  Math.abs(collapsed.top - collapsed.bottom) <= 1 &&
    collapsed.paddingTop === collapsed.paddingBottom,
  JSON.stringify(collapsed)
);
check("no runtime errors", errors.length === 0, errors.join(" | ").slice(0, 200));

await browser.close();
const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
