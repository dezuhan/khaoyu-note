// Regression test for choosing which board opens at boot and after a delete: never a trashed
// board, and a nested board only when it was the last one actually open.
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
await page.waitForTimeout(1000);

const ids = await page.evaluate(() => {
  const base = Date.now() + 60000;
  const make = (id, title, extra = {}) => ({
    id,
    title,
    parentId: null,
    createdAt: base,
    updatedAt: base,
    view: { x: 0, y: 0, zoom: 1 },
    grid: 24,
    showGrid: true,
    cards: [],
    connections: [],
    trash: [],
    ...extra,
  });
  const active = make("b_selection_active", "Active Project", { updatedAt: base });
  const trashed = make("b_selection_trashed", "Trashed Project", {
    updatedAt: base + 20000,
    trashedAt: base + 20000,
  });
  const nested = make("b_selection_nested", "Nested Board", {
    parentId: active.id,
    updatedAt: base + 30000,
  });
  for (const doc of [active, trashed, nested]) {
    localStorage.setItem("mn.board." + doc.id, JSON.stringify(doc));
  }
  localStorage.setItem("mn.boards", JSON.stringify([nested.id, trashed.id, active.id]));
  localStorage.setItem("mn.lastBoard", trashed.id);
  return { active: active.id, trashed: trashed.id, nested: nested.id };
});

await page.reload({ waitUntil: "load" });
await page.waitForTimeout(1000);
let current = await page.evaluate(() => ({
  id: localStorage.getItem("mn.lastBoard"),
  crumb: document.querySelector(".mn-crumb.is-current")?.textContent?.trim() || "",
}));
check("a trashed last board is not reopened", current.id === ids.active, current.crumb);

await page.evaluate(() => localStorage.removeItem("mn.lastBoard"));
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(1000);
current = await page.evaluate(() => ({
  id: localStorage.getItem("mn.lastBoard"),
  crumb: document.querySelector(".mn-crumb.is-current")?.textContent?.trim() || "",
}));
check("without a remembered board the root project wins over a nested one", current.id === ids.active, current.crumb);

await page.evaluate((id) => localStorage.setItem("mn.lastBoard", id), ids.nested);
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(1000);
current = await page.evaluate(() => ({
  id: localStorage.getItem("mn.lastBoard"),
  crumb: document.querySelector(".mn-crumb.is-current")?.textContent?.trim() || "",
}));
check("a remembered nested board still reopens", current.id === ids.nested, current.crumb);

check("no runtime errors", errors.length === 0, errors.join(" | ").slice(0, 200));

await browser.close();
const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
