// Browser checks for `khaoyunote://open?board=<id>` deep-link handling. The Rust side validates the
// URL and forwards only a board id (or an error); the web layer is exercised by dispatching the same
// DOM event the Tauri bridge delivers.
// node tools/test-deep-links.mjs http://127.0.0.1:1430/
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:1430/";
const results = [];
let browser;

function check(name, ok, detail = "") {
  results.push(Boolean(ok));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  ::  " + detail : ""}`);
}

try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector("#app", { state: "visible", timeout: 20000 });
  await page.waitForTimeout(800);

  const setup = await page.evaluate(async () => {
    const store = await import("/js/store.js");
    const before = store.state.board?.id || "";
    const created = await store.createBoard("Deep link board");
    await store.openBoard(before);
    return { before, target: created.id };
  });
  check("a second local board exists for the test", Boolean(setup.target) && setup.target !== setup.before);

  await page.evaluate((target) => {
    window.dispatchEvent(new CustomEvent("mn:deep-link", { detail: { boardId: target } }));
  }, setup.target);
  await page
    .waitForFunction(
      (target) => new URLSearchParams(location.search).get("board") === target,
      setup.target,
      { timeout: 10000 }
    )
    .catch(() => {});
  const opened = await page.evaluate(async () => {
    const store = await import("/js/store.js");
    return { board: store.state.board?.id || "", query: new URLSearchParams(location.search).get("board") };
  });
  check(
    "a deep link opens the linked board",
    opened.board === setup.target,
    JSON.stringify(opened)
  );
  check(
    "the board query string follows the deep link",
    opened.query === setup.target,
    String(opened.query)
  );

  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("mn:deep-link", { detail: { boardId: "b_missing_deep_link" } }));
  });
  await page.waitForTimeout(700);
  const missing = await page.evaluate(async () => {
    const store = await import("/js/store.js");
    const toast = document.getElementById("toast");
    return {
      board: store.state.board?.id || "",
      message: toast?.textContent || "",
      visible: Boolean(toast && !toast.hidden),
    };
  });
  check(
    "an unknown board shows a toast and keeps the current board",
    missing.board === setup.target &&
      missing.visible &&
      missing.message.includes("not in the local database"),
    JSON.stringify(missing)
  );

  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("mn:deep-link", { detail: { error: "This Khaoyu Note link uses an unknown action." } })
    );
  });
  await page.waitForTimeout(500);
  const invalid = await page.evaluate(() => {
    const toast = document.getElementById("toast");
    return { message: toast?.textContent || "", visible: Boolean(toast && !toast.hidden) };
  });
  check(
    "an invalid deep link surfaces the error message",
    invalid.visible && invalid.message.includes("unknown action"),
    JSON.stringify(invalid)
  );

  check("no runtime errors", errors.length === 0, errors.join(" | ").slice(0, 200));
} catch (error) {
  console.error("FAIL", error.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) process.exitCode = 1;
