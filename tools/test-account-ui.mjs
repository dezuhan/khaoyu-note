// End-to-end account UI check against the current service pages:
// /account redirects to /admin; registration lives on /register, sign-in on /login, and the
// account section (sessions, API tokens, password, sign-out) is a page inside the admin dashboard.
// node tools/test-account-ui.mjs
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "khaoyu-account-"));
let base = "";
const secret = crypto.randomBytes(32).toString("hex");
const email = `account-${crypto.randomUUID()}@example.com`;
const password = "account-password-123";
const newPassword = "account-password-456";
const env = {
  ...process.env,
  KHAOYU_SERVICE_SECRET: secret,
  KHAOYU_SERVICE_DATA_DIR: dataDir,
  KHAOYU_SERVICE_HOST: "localhost",
  KHAOYU_SERVICE_COOKIE_SECURE: "false",
  KHAOYU_SERVICE_RP_ID: "localhost",
};

spawnSync(process.execPath, ["service/src/cli.mjs", "migrate"], { cwd: root, env, stdio: "ignore" });
const server = spawn(process.execPath, ["service/src/server.mjs"], { cwd: root, env, stdio: "ignore" });
let browser;

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  ::  " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

async function waitForRuntime() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataDir, "runtime.json"), "utf8"));
    } catch {
      /* the service writes runtime.json after both listeners are ready */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("service did not write runtime.json");
}

async function waitForReady() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${base}/readyz`)).ok) return;
    } catch {
      /* starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("service did not start");
}

try {
  base = (await waitForRuntime()).frontendUrl;
  await waitForReady();
  browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // /account is now a redirect to the admin dashboard.
  await page.goto(`${base}/account`, { waitUntil: "load" });
  check("account URL redirects to the admin dashboard", page.url().endsWith("/admin"), page.url());
  await page.goto(`${base}/admin`, { waitUntil: "load" });
  const signin = page.locator("#admin-signin");
  check(
    "signed-out admin offers a primary button, not an underlined link",
    (await signin.count()) === 1 &&
      (await signin.evaluate((el) => el.tagName)) === "BUTTON" &&
      (await signin.evaluate((el) => getComputedStyle(el).textDecorationLine)) === "none"
  );

  // Registration creates an immediately usable verified account and sends the user to /login.
  await page.goto(`${base}/register`, { waitUntil: "load" });
  const design = await page.evaluate(() => ({
    css: Boolean(document.querySelector('link[href="/ky.css"]')),
    token: getComputedStyle(document.body).getPropertyValue("--ky-bg").trim(),
  }));
  check("auth pages use the shared design tokens", design.css && design.token.length > 0, JSON.stringify(design));
  check(
    "email verification UI is hidden",
    (await page.locator("#verify-token").count()) === 0 &&
      !(await page.locator("body").innerText()).includes("Verify email")
  );
  await page.fill("#name", "Account Test");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.fill("#confirm", password);
  await page.click("#register-submit");
  await page.waitForURL(/\/login\?registered=1/, { timeout: 15000 });
  check("registration from the browser", true);

  // Sign-in redirects to /admin and the first account is the admin identity.
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click("#login-submit");
  await page.waitForURL(/\/admin$/, { timeout: 15000 });
  await page.waitForSelector("#admin-identity:not([hidden])", { timeout: 15000 });
  check("password login shows the signed-in account", (await page.locator("#admin-email").innerText()).includes(email));
  check(
    "admin chrome reuses the main UI logo, SVG icons and fonts",
    (await page.locator(".admin-logo img[src=\"/khaoyu-note.svg\"]").count()) === 1 &&
      (await page.locator("#admin-theme svg").count()) === 1 &&
      (await page.locator(".admin-nav-item[data-page=\"overview\"] .admin-nav-icon svg").count()) === 1 &&
      (await page.locator("#admin-identity.admin-account-trigger .admin-avatar").count()) === 1 &&
      (await page.evaluate(async () => {
        await document.fonts.ready;
        return document.fonts.check('12px "Plus Jakarta Sans"');
      }))
  );

  // The account page inside the dashboard owns sessions, tokens and password changes. It is opened
  // from the profile button: the Account entry is temporarily out of the menu bar.
  check(
    "account settings is temporarily out of the menu",
    (await page.locator('.admin-nav-item[data-page="account"]').count()) === 0
  );
  await page.click("#admin-identity");
  await page.click('#admin-account-menu [data-action="account"]');
  await page.waitForFunction(() => document.getElementById("admin-pane").textContent.includes("Sessions"));
  check("account page lists the current session", (await page.locator(".admin-table tbody tr").count()) >= 1);
  const passwordBox = await page.locator('[data-role="password-form"] input').first().boundingBox();
  check("password inputs stay compact", passwordBox !== null && passwordBox.height <= 30, String(passwordBox?.height));
  check(
    "account page uses the shared design tokens",
    (await page.locator('link[href="/ky.css"]').count()) === 1 &&
      (await page.locator(".ky-button").count()) >= 1
  );

  await page.fill('[data-role="token-form"] input[name="name"]', "Desktop sync");
  await page.click('[data-role="token-form"] button[type="submit"]');
  await page.waitForFunction(
    () => document.querySelector('[data-role="token-result"]').textContent.includes("khn_"),
    { timeout: 15000 }
  );
  check("API token can be created from the browser", true);
  check("API token appears in the list", (await page.locator('[data-role="revoke-token"]').count()) === 1);

  await page.click('[data-role="revoke-token"]');
  await page.waitForFunction(() => document.getElementById("admin-pane").textContent.includes("No API tokens"), {
    timeout: 15000,
  });
  check("API token can be revoked", (await page.locator('[data-role="revoke-token"]').count()) === 0);

  await page.fill('[data-role="password-form"] input[name="currentPassword"]', password);
  await page.fill('[data-role="password-form"] input[name="newPassword"]', newPassword);
  await page.fill('[data-role="password-form"] input[name="confirmPassword"]', newPassword);
  await page.click('[data-role="password-form"] button[type="submit"]');
  await page.waitForFunction(
    () => document.querySelector('[data-role="password-status"]').textContent.includes("Password updated"),
    { timeout: 15000 }
  );
  check("password change from the browser", true);

  await page.click('[data-role="logout-all"]');
  await page.waitForURL(/\/login\?signedout=1/, { timeout: 15000 });
  check("sign out everywhere returns to the login page", true);

  await page.fill("#email", email);
  await page.fill("#password", newPassword);
  await page.click("#login-submit");
  await page.waitForURL(/\/admin$/, { timeout: 15000 });
  check("login with the new password", (await page.locator("#admin-email").innerText()).includes(email));

  check("no unexpected page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (error) {
  console.error("FAIL", error.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
