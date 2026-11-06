// Regression test for the horizontal scrollbar of a kanban card inside a column: pointer events on
// the scroll container must not be captured by the card drag handler.
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
      y: 100,
      w: 340,
      h: 700,
      z: 1,
      parentId: null,
      order: 0,
      title: "Column",
      collapsed: false,
    },
    {
      id: "kanban1",
      type: "kanban",
      x: 134,
      y: 164,
      w: 312,
      h: 560,
      z: 2,
      parentId: "col1",
      order: 0,
      title: "Kanban",
      columns: [
        { id: "k1", title: "Backlog", items: [] },
        { id: "k2", title: "In progress", items: [] },
        { id: "k3", title: "Done", items: [] },
      ],
    },
  ],
  connections: [],
  trash: [],
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(({ parent }) => {
  if (localStorage.getItem("mn.boards")) return;
  localStorage.setItem("mn.board.b_parent", JSON.stringify(parent));
  localStorage.setItem("mn.boards", JSON.stringify(["b_parent"]));
  localStorage.setItem("mn.lastBoard", "b_parent");
}, { parent });
const page = await context.newPage();
page.on("pageerror", (error) => errors.push("pageerror: " + error.message));

await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(1600);

const metrics = await page.evaluate(() => {
  const cols = document.querySelector(".mn-kanban-cols");
  const card = document.querySelector('.mn-card[data-type="kanban"]');
  const rect = cols.getBoundingClientRect();
  const pointer = new PointerEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + 20,
    clientY: rect.bottom - 4,
    button: 0,
  });
  const dispatched = cols.dispatchEvent(pointer);
  const cardRect = card.getBoundingClientRect();
  return {
    overflow: cols.scrollWidth > cols.clientWidth,
    defaultPrevented: pointer.defaultPrevented,
    dispatched,
    left: rect.left,
    bottom: rect.bottom,
    cardX: cardRect.x,
    cardY: cardRect.y,
  };
});
check("the kanban overflows horizontally inside the column", metrics.overflow);
check("pointerdown on the scroll area is not cancelled", !metrics.defaultPrevented);
check("the scroll container keeps receiving the event", metrics.dispatched);

await page.mouse.move(metrics.left + 20, metrics.bottom - 4);
await page.mouse.down();
await page.mouse.move(metrics.left + 100, metrics.bottom - 4, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
const after = await page.evaluate(() => {
  const card = document.querySelector('.mn-card[data-type="kanban"]');
  const rect = card.getBoundingClientRect();
  return { x: rect.x, y: rect.y };
});
check(
  "dragging on the scrollbar does not move the kanban card",
  Math.abs(after.x - metrics.cardX) <= 1 && Math.abs(after.y - metrics.cardY) <= 1
);
check("no runtime errors", errors.length === 0, errors.join(" | ").slice(0, 200));

await browser.close();
const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
