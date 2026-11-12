// End-to-end account UI check against the current service pages:
// /account is the member security/account page; registration lives on /register, sign-in on /login, and the
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
  await page.addInitScript(() => localStorage.setItem("khaoyu.auth.theme", "dark"));
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // /account is the member security page and remains directly reachable.
  const accountPage = await page.request.get(`${base}/account`, { maxRedirects: 0 });
  check(
    "account URL serves the account security page",
    accountPage.status() === 200 && (await accountPage.text()).includes("Two-factor authentication"),
    `${accountPage.status()}`
  );
  await page.goto(`${base}/admin`, { waitUntil: "load" });
  await page.waitForURL(/\/login$/, { timeout: 15000 });
  check("signed-out admin redirects straight to the login page", true);

  // Registration creates an immediately usable verified account and sends the user to /login.
  await page.goto(`${base}/register`, { waitUntil: "load" });
  const design = await page.evaluate(() => ({
    css: Boolean(document.querySelector('link[href="/ky.css"]')),
    token: getComputedStyle(document.body).getPropertyValue("--ky-bg").trim(),
  }));
  check("auth pages use the shared design tokens", design.css && design.token.length > 0, JSON.stringify(design));
  check(
    "auth pages declare the shared favicons",
    (await page.locator('link[rel="icon"][href="/khaoyu-note.svg"]').count()) === 1 &&
      (await page.locator('link[rel="icon"][href="/favicon-32.png"]').count()) === 1 &&
      (await page.locator('link[rel="apple-touch-icon"][href="/favicon-180.png"]').count()) === 1
  );
  check(
    "auth pages use the main app logo asset",
    (await page.locator('.auth-brand img[src="/khaoyu-note.svg"]').count()) === 1
  );
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
  const themeState = await page.evaluate(() => ({
    applied: document.documentElement.dataset.kyTheme,
    stored: localStorage.getItem("khaoyu.theme"),
    legacy: localStorage.getItem("khaoyu.auth.theme"),
  }));
  check(
    "service pages share and migrate the theme preference",
    themeState.applied === "dark" && themeState.stored === "dark",
    JSON.stringify(themeState)
  );
  check(
    "admin menubar omits the redundant Dashboard and Help buttons",
    (await page.locator("#admin-menu-dashboard, #admin-menu-help").count()) === 0
  );
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

  // Admin-only manual account creation from the Accounts pane.
  await page.click('.admin-nav-item[data-page="accounts"]');
  await page.waitForSelector('[data-role="account-create"]');
  const manualEmail = `manual-${crypto.randomUUID()}@example.com`;
  await page.fill('[data-role="account-create"] input[name="email"]', manualEmail);
  await page.fill('[data-role="account-create"] input[name="displayName"]', "Manual Member");
  await page.fill('[data-role="account-create"] input[name="password"]', "manual-password-123");
  await page.selectOption('[data-role="account-create"] select[name="role"]', "member");
  await page.click('[data-role="account-create"] button[type="submit"]');
  await page.waitForFunction(
    (email) => document.getElementById("admin-pane")?.textContent.includes(email),
    manualEmail
  );
  check("admin can add a member account manually", true);

  // Full team CRUD from the admin UI: create, rename, add/update/remove a member, then delete.
  const teammateEmail = `teammate-${crypto.randomUUID()}@example.com`;
  const teammate = await fetch(`${base}/api/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: teammateEmail, password: "teammate-password-123", displayName: "Teammate" }),
  });
  check("teammate account registered", teammate.status === 202, String(teammate.status));
  await page.click('.admin-nav-item[data-page="teams"]');
  await page.waitForSelector('[data-role="team-create"]');
  await page.fill('[data-role="team-create"] input[name="name"]', "CRUD team");
  await page.click('[data-role="team-create"] button[type="submit"]');
  await page.locator(".admin-team h3", { hasText: "CRUD team" }).waitFor();
  check("team can be created from the dashboard", true);

  const renameButton = page.locator(".admin-team", { hasText: "CRUD team" }).locator('button[data-role="rename"]');
  await renameButton.click();
  const renameForm = page.locator(".admin-team", { hasText: "CRUD team" }).locator("form.admin-team-rename");
  await renameForm.locator('input[name="name"]').fill("CRUD team renamed");
  await renameForm.locator('button[type="submit"]').click();
  await page.locator(".admin-team h3", { hasText: "CRUD team renamed" }).waitFor();
  check("team can be renamed from the dashboard", true);

  const teamCard = page.locator(".admin-team", { hasText: "CRUD team renamed" });
  await teamCard.locator('button[data-role="members"]').click();
  await teamCard.locator('[data-role="member-add"] input[name="email"]').fill(teammateEmail);
  await teamCard.locator('[data-role="member-add"] select[name="role"]').selectOption("editor");
  await teamCard.locator('[data-role="member-add"] button[type="submit"]').click();
  await teamCard.locator("tbody tr", { hasText: teammateEmail }).waitFor();
  check("admin can add a team member manually", true);
  check(
    "team member count updates after adding a member",
    (await teamCard.locator('[data-role="team-member-count"]').innerText()).startsWith("2")
  );

  const memberRow = teamCard.locator("tbody tr", { hasText: teammateEmail });
  await memberRow.locator('select[data-role="member-role"]').selectOption("viewer");
  await page.waitForFunction(() =>
    document.querySelector('[data-role="member-status"]')?.textContent.includes("updated")
  );
  const memberStatus = teamCard.locator('[data-role="member-status"]');
  check("admin can change a member role", (await memberStatus.innerText()).includes("updated"));

  const removeButton = memberRow.locator('button[data-role="member-remove"]');
  await removeButton.click();
  await removeButton.click();
  await teamCard.locator("tbody tr", { hasText: teammateEmail }).waitFor({ state: "detached" });
  check("admin can remove a team member", true);
  check(
    "team member count updates after removing a member",
    (await teamCard.locator('[data-role="team-member-count"]').innerText()).startsWith("1")
  );

  const deleteButton = teamCard.locator('button[data-role="delete"]');
  await deleteButton.click();
  await deleteButton.click();
  await page.locator(".admin-team h3", { hasText: "CRUD team renamed" }).waitFor({ state: "detached" });
  check("team can be deleted from the dashboard", true);

  // The account page inside the dashboard owns sessions, tokens and password changes. It is opened
  // from the profile button: the Account entry is temporarily out of the menu bar.
  check(
    "account settings is temporarily out of the menu",
    (await page.locator('.admin-nav-item[data-page="account"]').count()) === 0
  );
  await page.click("#admin-identity");
  await page.waitForSelector("#admin-account-menu:not([hidden])");
  const menuGap = await page.evaluate(() => {
    const bar = document.querySelector(".admin-menubar").getBoundingClientRect();
    const menu = document.querySelector("#admin-account-menu").getBoundingClientRect();
    return Math.round(menu.top - bar.bottom);
  });
  check("account menu floats clear of the menubar", menuGap >= 8, `${menuGap}px`);
  await page.click('#admin-account-menu [data-action="account"]');
  await page.waitForFunction(() => document.getElementById("admin-pane").textContent.includes("Sessions"));
  check("account page lists the current session", (await page.locator(".admin-table tbody tr").count()) >= 1);
  const passwordBox = await page.locator('[data-role="password-form"] input').first().boundingBox();
  check("password inputs stay compact", passwordBox !== null && passwordBox.height <= 30, String(passwordBox?.height));
  const passwordRects = await page.locator('[data-role="password-form"] input').evaluateAll((inputs) =>
    inputs.map((input) => {
      const rect = input.getBoundingClientRect();
      return { x: rect.x, width: rect.width };
    })
  );
  check(
    "password fields stay inside their grid columns",
    passwordRects.every((rect, index) => index === 0 || rect.x >= passwordRects[index - 1].x + passwordRects[index - 1].width)
  );
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
