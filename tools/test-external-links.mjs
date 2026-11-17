// Browser checks for custom URL schemes in link cards and the external-scheme allowlist.
// node tools/test-external-links.mjs http://127.0.0.1:1430/
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    try {
      localStorage.clear();
    } catch {
      /* storage may be unavailable */
    }
    localStorage.setItem("ky.theme", "light");
    // The browser preview cannot call the OS handler, so capture the URL the bridge would open.
    window.__openedLinks = [];
    window.open = (target) => {
      window.__openedLinks.push(String(target));
      return {};
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector("#app", { state: "visible", timeout: 20000 });
  await page.waitForTimeout(1000);

  const helpers = await page.evaluate(async () => {
    const module = await import("/js/external-links.js");
    return {
      custom: module.normalizeLinkUrl("khaoyunote://open?board=welcome"),
      bare: module.normalizeLinkUrl("example.com"),
      domain: module.linkDisplayDomain("khaoyunote://open?board=welcome"),
      blocked: module.classifyLink("javascript:alert(1)").blocked,
    };
  });
  check(
    "custom scheme URLs are not rewritten to https",
    helpers.custom === "khaoyunote://open?board=welcome",
    helpers.custom
  );
  check("a bare host still gets https", helpers.bare === "https://example.com", helpers.bare);
  check("custom scheme cards label the scheme", helpers.domain === "khaoyunote", helpers.domain);
  check("javascript: is classified as blocked", helpers.blocked === true);

  if ((await page.locator(".mn-card").count()) === 0) {
    await page.waitForTimeout(1000);
  }
  const cardId = await page.evaluate(async () => {
    const actions = await import("/js/actions.js");
    const card = actions.addCard("link", 220, 220, { url: "" });
    return card?.id || "";
  });
  check("a link card can be created for the test", Boolean(cardId));
  if (cardId) {
    const input = page.locator(`.mn-card[data-id="${cardId}"] input[data-field="url"]`).first();
    await input.fill("khaoyunote://open?board=welcome");
    await input.press("Tab");
    await page.waitForTimeout(300);
    const stored = await page.evaluate(async (id) => {
      const { state } = await import("/js/store.js");
      return state.board?.cards?.find((card) => card.id === id)?.url || "";
    }, cardId);
    check(
      "a custom scheme is stored unchanged after editing",
      stored === "khaoyunote://open?board=welcome",
      stored
    );
  }

  const allowedOpen = await page.evaluate(async () => {
    localStorage.setItem("ky.externalSchemes", JSON.stringify(["khaoyunote"]));
    window.__openedLinks.length = 0;
    const { openLink } = await import("/js/actions.js");
    openLink("khaoyunote://open?board=welcome");
    await new Promise((resolve) => setTimeout(resolve, 600));
    return window.__openedLinks.slice();
  });
  check(
    "an allowlisted custom scheme opens through the bridge unchanged",
    allowedOpen.at(-1) === "khaoyunote://open?board=welcome",
    JSON.stringify(allowedOpen)
  );

  const blockedOpen = await page.evaluate(async () => {
    window.__openedLinks.length = 0;
    const { openLink } = await import("/js/actions.js");
    openLink("javascript:alert(1)");
    await new Promise((resolve) => setTimeout(resolve, 400));
    return window.__openedLinks.slice();
  });
  check("javascript: links are never opened", blockedOpen.length === 0);

  const prompt = await page.evaluate(async () => {
    localStorage.setItem("ky.externalSchemes", "[]");
    window.__openedLinks.length = 0;
    const { openLink } = await import("/js/actions.js");
    openLink("khaoyunote://open?board=welcome");
    await new Promise((resolve) => setTimeout(resolve, 500));
    return {
      title: document.querySelector(".mn-modal-title")?.textContent || "",
      opened: window.__openedLinks.length,
    };
  });
  check(
    "a new scheme asks for confirmation before opening",
    prompt.title.includes("khaoyunote") && prompt.opened === 0,
    JSON.stringify(prompt)
  );

  const confirmButton = page.locator(".mn-modal-foot button", { hasText: "Open link" });
  if (await confirmButton.count()) {
    await confirmButton.first().click();
    await page.waitForTimeout(600);
  }
  const confirmed = await page.evaluate(() => ({
    opened: window.__openedLinks.slice(),
    extras: localStorage.getItem("ky.externalSchemes") || "",
  }));
  check(
    "confirming opens the link and remembers the scheme",
    confirmed.opened.at(-1) === "khaoyunote://open?board=welcome" &&
      confirmed.extras.includes("khaoyunote"),
    JSON.stringify(confirmed)
  );

  await page.click("#settings-btn");
  await page.waitForSelector(".mn-prefs-nav");
  await page.locator(".mn-prefs-nav-item", { hasText: "Tools" }).click();
  await page.waitForSelector('[data-role="external-schemes"]');
  const settingsText = await page.locator('[data-role="external-schemes"]').innerText();
  check(
    "Settings > Tools lists the external scheme allowlist",
    settingsText.includes("External URL schemes") && settingsText.includes("khaoyunote:"),
    settingsText.replace(/\s+/g, " ").slice(0, 160)
  );

  await page.fill(".mn-external-scheme-input", "vscode");
  await page.locator('[data-role="external-schemes"] .mn-btn-primary').click();
  await page.waitForTimeout(400);
  const added = await page.evaluate(() => ({
    extras: localStorage.getItem("ky.externalSchemes") || "",
    text: document.querySelector('[data-role="external-schemes"]')?.innerText || "",
  }));
  check(
    "adding a scheme from Settings persists and lists it",
    added.extras.includes("vscode") && added.text.includes("vscode:"),
    added.text.replace(/\s+/g, " ").slice(0, 160)
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
