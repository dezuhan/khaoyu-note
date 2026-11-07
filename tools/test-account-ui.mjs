// End-to-end account UI check.
// node tools/test-account-ui.mjs
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "khaoyu-account-"));
const port = 18091;
const base = `http://localhost:${port}`;
const secret = crypto.randomBytes(32).toString("hex");
const email = `account-${crypto.randomUUID()}@example.com`;
const password = "account-password-123";
const newPassword = "account-password-456";
const env = {
  ...process.env,
  KHAOYU_SERVICE_SECRET: secret,
  KHAOYU_SERVICE_DATA_DIR: dataDir,
  KHAOYU_SERVICE_PUBLIC_URL: base,
  KHAOYU_SERVICE_HOST: "127.0.0.1",
  KHAOYU_SERVICE_PORT: String(port),
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

function latestMail(kind) {
  return fs
    .readdirSync(path.join(dataDir, "outbox"))
    .map((file) => JSON.parse(fs.readFileSync(path.join(dataDir, "outbox", file), "utf8")))
    .filter((message) => message.kind === kind)
    .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))[0];
}

try {
  await waitForReady();
  browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.log("PAGEERROR", error.message));
  await page.goto(`${base}/account`, { waitUntil: "load" });

  await page.click("#tab-register");
  await page.fill("#register-email", email);
  await page.fill("#register-name", "Account Test");
  await page.fill("#register-password", password);
  await page.click("#register");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("Account created"));
  check("registration from the browser", true);

  const verifyToken = latestMail("verify").text.match(/token: (\S+)/)[1];
  await page.fill("#verify-token", verifyToken);
  await page.click("#verify");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("Email verified"));
  check("email verification from the browser", true);

  await page.fill("#login-email", email);
  await page.fill("#login-password", password);
  await page.click("#login");
  await page.waitForFunction(() => !document.getElementById("account-section").hidden);
  check("password login shows the signed-in account", (await page.locator("#account-email").innerText()).includes(email));
  check("session list contains the current session", (await page.locator("#sessions li").count()) === 1);

  await page.fill("#token-name", "Desktop sync");
  await page.click("#token-create");
  await page.waitForFunction(() => document.getElementById("token-result").textContent.includes("khn_"));
  check("API token can be created from the browser", (await page.locator("#token-result").innerText()).includes("khn_"));
  check("API token appears in the list", (await page.locator("#tokens li").count()) === 1);
  await page.locator("#tokens li button").click();
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("revoked"));
  await page.waitForFunction(() => document.querySelectorAll("#tokens li").length === 0);
  check("API token can be revoked", (await page.locator("#tokens li").count()) === 0);

  await page.click("#logout-all");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("every device"));
  check("logout everywhere clears the account view", await page.locator("#account-section").isHidden());

  await page.fill("#login-email", email);
  await page.fill("#login-password", password);
  await page.click("#login");
  await page.waitForFunction(() => !document.getElementById("account-section").hidden);

  await page.fill("#reset-email", email);
  await page.click("#reset-request");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("reset token"));
  const resetToken = latestMail("reset").text.match(/token: (\S+)/)[1];
  await page.fill("#reset-token", resetToken);
  await page.fill("#reset-password", newPassword);
  await page.click("#reset-confirm");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("Password changed"));
  check("password reset from the browser", true);

  await page.fill("#login-email", email);
  await page.fill("#login-password", newPassword);
  await page.click("#login");
  await page.waitForFunction(() => !document.getElementById("account-section").hidden);
  check("login with the reset password", (await page.locator("#account-email").innerText()).includes(email));
} catch (error) {
  console.error("FAIL", error.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
