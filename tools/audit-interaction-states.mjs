import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1:1430/", { waitUntil: "load" });
await page.waitForTimeout(1200);
const result = {};

const menubar = page.locator(".mn-menubar-btn").first();
result.menuDefault = await menubar.evaluate((el) => getComputedStyle(el).backgroundColor);
await menubar.hover();
result.menuHover = await menubar.evaluate((el) => getComputedStyle(el).backgroundColor);
await page.mouse.move(700, 500);
await page.keyboard.press("Tab");
result.focusTarget = await page.evaluate(() => document.activeElement?.className);
result.focusStyle = await page.evaluate(() => {
  const el = document.activeElement;
  const style = getComputedStyle(el);
  return { outlineWidth: style.outlineWidth, outlineColor: style.outlineColor, boxShadow: style.boxShadow };
});

await page.click('.mn-tool[data-tool="note"]');
await page.waitForTimeout(350);
const field = page.locator(".mn-field-input").first();
await field.click();
result.inputFocus = await field.evaluate((el) => {
  const style = getComputedStyle(el);
  return { boxShadow: style.boxShadow, outlineWidth: style.outlineWidth };
});
result.disabledOpacity = await page.locator("#undo-btn").evaluate((el) => getComputedStyle(el).opacity);

const primary = page.locator(".mn-btn-primary").first();
if (await primary.count()) {
  result.primaryDefault = await primary.evaluate((el) => getComputedStyle(el).backgroundColor);
  await primary.hover();
  result.primaryHover = await primary.evaluate((el) => getComputedStyle(el).backgroundColor);
}
console.log(JSON.stringify(result, null, 2));
await browser.close();
