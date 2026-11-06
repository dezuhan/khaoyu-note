// Verify that the single variable-font files still serve distinct weights and that the removed
// duplicate downloads are never requested.
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:1430/";
const results = [];

function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? "  ::  " + detail : ""}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(1200);

const metrics = await page.evaluate(async () => {
  await document.fonts.ready;
  for (const [family, weights] of [
    ["Plus Jakarta Sans", [400, 700]],
    ["DM Sans", [400, 600]],
    ["Playfair Display", [400, 600]],
  ]) {
    for (const weight of weights) {
      await document.fonts.load(`${weight} 64px "${family}"`);
    }
  }
  const measure = (family, weight) => {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    context.font = `${weight} 64px "${family}"`;
    return context.measureText("Variable weight 123").width;
  };
  const resources = performance
    .getEntriesByType("resource")
    .map((entry) => entry.name.split("/").pop())
    .filter((name) => name.endsWith(".woff2"));
  return {
    jakarta: [measure("Plus Jakarta Sans", 400), measure("Plus Jakarta Sans", 700)],
    dm: [measure("DM Sans", 400), measure("DM Sans", 600)],
    playfair: [measure("Playfair Display", 400), measure("Playfair Display", 600)],
    resources,
  };
});

check(
  "Plus Jakarta Sans renders distinct 400 and 700 weights",
  Math.abs(metrics.jakarta[1] - metrics.jakarta[0]) > 0.5,
  `${metrics.jakarta[0].toFixed(1)} vs ${metrics.jakarta[1].toFixed(1)}`
);
check(
  "DM Sans renders distinct 400 and 600 weights",
  Math.abs(metrics.dm[1] - metrics.dm[0]) > 0.5,
  `${metrics.dm[0].toFixed(1)} vs ${metrics.dm[1].toFixed(1)}`
);
check(
  "Playfair Display renders distinct 400 and 600 weights",
  Math.abs(metrics.playfair[1] - metrics.playfair[0]) > 0.5,
  `${metrics.playfair[0].toFixed(1)} vs ${metrics.playfair[1].toFixed(1)}`
);
const duplicates = metrics.resources.filter((name) => /-(500|600|700)\.woff2$/.test(name));
check("no duplicate per-weight font files are requested", duplicates.length === 0, duplicates.join(", "));
check(
  "only the five unique font files are fetched",
  new Set(metrics.resources).size <= 5,
  [...new Set(metrics.resources)].join(", ")
);

await browser.close();
const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
