// End-to-end passkey check using Chrome's virtual authenticator.
// Requires Playwright's Chromium: node tools/test-passkeys.mjs
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "khaoyu-passkeys-"));
let base = "";
const secret = crypto.randomBytes(32).toString("hex");
const password = "passkey-password-123";
const email = `passkey-${crypto.randomUUID()}@example.com`;
const env = {
  ...process.env,
  KHAOYU_SERVICE_SECRET: secret,
  KHAOYU_SERVICE_DATA_DIR: dataDir,
  KHAOYU_SERVICE_HOST: "localhost",
  KHAOYU_SERVICE_COOKIE_SECURE: "false",
  KHAOYU_SERVICE_PASSKEYS_ENABLED: "true",
  KHAOYU_SERVICE_RP_ID: "localhost",
};

spawnSync(process.execPath, ["service/src/cli.mjs", "migrate"], { cwd: root, env, stdio: "ignore" });
const server = spawn(process.execPath, ["service/src/server.mjs"], {
  cwd: root,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (chunk) => (serverLog += chunk.toString()));
server.stderr.on("data", (chunk) => (serverLog += chunk.toString()));
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
      const response = await fetch(`${base}/readyz`);
      if (response.ok) return;
    } catch {
      /* starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("service did not start\n" + serverLog);
}

async function api(pathname, { method = "GET", body, jar = {} } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (Object.keys(jar).length) headers.cookie = Object.entries(jar).map(([key, value]) => `${key}=${value}`).join("; ");
  if (jar.khaoyu_csrf) headers["x-csrf-token"] = jar.khaoyu_csrf;
  const response = await fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0];
    const index = pair.indexOf("=");
    jar[pair.slice(0, index)] = pair.slice(index + 1);
  }
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

try {
  base = (await waitForRuntime()).frontendUrl;
  await waitForReady();
  const register = await api("/api/v1/auth/register", {
    method: "POST",
    body: { email, password, displayName: "Passkey Test" },
  });
  check("account registration accepted", register.status === 202, String(register.status));

  browser = await chromium.launch();
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  page.on("pageerror", (error) => console.log("PAGEERROR", error.message));

  await page.goto(`${base}/passkeys`, { waitUntil: "load" });
  await page.fill("#login-email", email);
  await page.fill("#login-password", password);
  await page.click("#login");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("Signed in"));
  check("password login establishes a session", true);

  await page.click("#passkey-register");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("Passkey registered"), null, {
    timeout: 15000,
  });
  check("virtual authenticator registers a passkey", true);
  await page.waitForFunction(() => document.getElementById("passkey-list").textContent.includes("This device"));
  check("passkey appears in the account list", true);

  await page.waitForSelector("#backup-codes:not([hidden])", { timeout: 15000 });
  const autoBackupCodes = await page.locator("#backup-codes").innerText();
  check(
    "backup codes are issued after the passkey",
    autoBackupCodes.split("\n").filter(Boolean).length === 10,
    autoBackupCodes
  );

  await page.click("#logout");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("Signed out"));
  await page.fill("#passkey-email", email);
  await page.click("#passkey-login");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("Signed in with a passkey"), null, {
    timeout: 15000,
  });
  check("passkey login creates a session", true);

  const session = await page.evaluate(async () => {
    const response = await fetch("/api/v1/auth/passkeys", { credentials: "same-origin" });
    return { status: response.status, body: await response.json() };
  });
  check("passkey list requires and uses the new session", session.status === 200 && session.body.passkeys.length === 1);
} catch (error) {
  console.error("FAIL", error.message);
  if (serverLog) console.error("service log:\n" + serverLog);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
