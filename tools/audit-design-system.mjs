import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1:1430/", { waitUntil: "load" });
await page.waitForTimeout(1200);
const audit = await page.evaluate(() => {
  const elements = [...document.querySelectorAll("button, input, textarea, select, [contenteditable='true']")];
  const classes = new Map();
  for (const element of elements) {
    for (const name of element.classList) {
      if (!name.startsWith("mn-") && !name.startsWith("ky-")) continue;
      if (!classes.has(name)) classes.set(name, { count: 0, tags: new Set() });
      const entry = classes.get(name);
      entry.count += 1;
      entry.tags.add(element.tagName.toLowerCase());
    }
  }
  const rules = [];
  for (const sheet of document.styleSheets) {
    let list;
    try {
      list = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of list) {
      if (rule.selectorText) rules.push(rule.selectorText);
    }
  }
  const stateFor = (name) => ({
    hover: rules.some((selector) => selector.includes(`.${name}:hover`)),
    focus: rules.some(
      (selector) => selector.includes(`.${name}:focus`) || selector.includes(`.${name}:focus-visible`)
    ),
    active: rules.some((selector) => selector.includes(`.${name}:active`)),
    disabled: rules.some((selector) => selector.includes(`.${name}:disabled`)),
  });
  return [...classes.entries()]
    .filter(([, entry]) => entry.count > 0)
    .map(([name, entry]) => ({
      name,
      count: entry.count,
      tags: [...entry.tags].join(","),
      ...stateFor(name),
    }))
    .sort((a, b) => b.count - a.count);
});
console.log(JSON.stringify(audit, null, 2));
await browser.close();
