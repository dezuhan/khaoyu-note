// Focused regression test for the save-conflict dialog. It simulates the event the store emits
// when the backend rejects a stale write, then exercises both resolution paths.
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
page.on("console", (message) => {
  if (message.type() === "error") errors.push("console: " + message.text());
});

await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(1200);

const before = await page.evaluate(() => {
  const id = localStorage.getItem("mn.lastBoard");
  const doc = JSON.parse(localStorage.getItem("mn.board." + id));
  return {
    id,
    title: doc.title,
    boards: JSON.parse(localStorage.getItem("mn.boards") || "[]").length,
    doc: JSON.stringify(doc),
  };
});
check("a board is open before the conflict", Boolean(before.id && before.title), before.title);

await page.evaluate((detail) => {
  window.dispatchEvent(new CustomEvent("mn:save-conflict", { detail }));
}, { boardId: before.id, title: before.title, doc: before.doc });

await page.waitForSelector(".mn-modal-title");
const modalTitle = await page.locator(".mn-modal-title").innerText();
check("conflict dialog explains the situation", modalTitle === "Board changed outside this window", modalTitle);

await page.getByRole("button", { name: "Keep my version as a copy" }).click();
await page.waitForFunction(
  () => document.getElementById("save-state")?.textContent === "Saved",
  null,
  { timeout: 5000 }
).catch(() => {});
await page.waitForTimeout(100);
const afterCopy = await page.evaluate(() => {
  const id = localStorage.getItem("mn.lastBoard");
  return {
    id,
    title: JSON.parse(localStorage.getItem("mn.board." + id)).title,
    boards: JSON.parse(localStorage.getItem("mn.boards") || "[]").length,
    current: document.querySelector(".mn-crumb.is-current")?.textContent || "",
    saveState: document.getElementById("save-state")?.textContent || "",
  };
});
check("keeping a copy creates one new board", afterCopy.boards === before.boards + 1, `${before.boards} -> ${afterCopy.boards}`);
check("the copy becomes the open board", afterCopy.id !== before.id && afterCopy.title.includes("(copy)"), afterCopy.title);
check("the breadcrumb follows the copy", afterCopy.current.includes("(copy)"), afterCopy.current);
check("the copy is saved", afterCopy.saveState === "Saved", afterCopy.saveState);
const toast = (await page.locator("#toast").innerText()).trim();
check("the user is told about the copy", toast.includes("saved as a copy"), toast);

await page.evaluate((detail) => {
  window.dispatchEvent(new CustomEvent("mn:save-conflict", { detail }));
}, { boardId: before.id, title: before.title, doc: before.doc });
await page.waitForSelector(".mn-modal-title");
await page.getByRole("button", { name: "Load newer version" }).click();
await page.waitForTimeout(900);
const afterRemote = await page.evaluate(() => ({
  id: localStorage.getItem("mn.lastBoard"),
  current: document.querySelector(".mn-crumb.is-current")?.textContent || "",
  modal: Boolean(document.querySelector(".mn-modal-title")),
}));
check("loading the newer version reopens the original board", afterRemote.id === before.id, afterRemote.id);
check("the original title is back", afterRemote.current.includes(before.title), afterRemote.current);
check("the conflict dialog closes", !afterRemote.modal);

check("no runtime errors", errors.length === 0, errors.join(" | ").slice(0, 200));

await browser.close();
const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
