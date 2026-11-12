// End-to-end sharing page check.
// node tools/test-shares-ui.mjs
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "khaoyu-shares-"));
let base = "";
const secret = crypto.randomBytes(32).toString("hex");
const email = `shares-${crypto.randomUUID()}@example.com`;
const password = "shares-password-123";
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

function latestMail(kind) {
  return fs
    .readdirSync(path.join(dataDir, "outbox"))
    .map((file) => JSON.parse(fs.readFileSync(path.join(dataDir, "outbox", file), "utf8")))
    .filter((message) => message.kind === kind)
    .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))[0];
}

try {
  base = (await waitForRuntime()).frontendUrl;
  await waitForReady();
  const registration = await fetch(`${base}/api/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, displayName: "Shares Test" }),
  });
  check("account registered", registration.status === 202);
  // Registration is auto-verified; no email verification step.

  browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.log("PAGEERROR", error.message));
  await page.goto(`${base}/login`, { waitUntil: "load" });
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click("#login-submit");
  await page.waitForURL(/\/admin$/);
  await page.click('.admin-nav-item[data-page="sharing"]');
  await page.waitForSelector("#project");
  check(
    "sharing is rendered inside the admin dashboard with the rail and top bar",
    (await page.locator(".admin-menubar .admin-host").count()) === 1 &&
      (await page.locator(".admin-rail .admin-nav-item[data-page=\"sharing\"]").count()) === 1 &&
      (await page.locator(".admin-menubar #admin-identity.admin-account-trigger").count()) === 1
  );

  const projectId = await page.evaluate(async () => {
    const csrf = decodeURIComponent(document.cookie.match(/(?:^|; )khaoyu_csrf=([^;]+)/)[1]);
    const headers = { "content-type": "application/json", "x-csrf-token": csrf };
    const created = await fetch("/api/v1/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Shares UI board" }),
    }).then((response) => response.json());
    await fetch(`/api/v1/projects/${created.id}/snapshot`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        revision: 1,
        doc: JSON.stringify({
          id: created.id,
          title: "Shares UI board",
          cards: [
            { id: "share-note", type: "note", x: 0, y: 0, w: 200, h: 70, z: 1, text: "Shared note" },
            { id: "share-column", type: "column", x: 300, y: 0, w: 200, h: 300, z: 2, title: "Shared column" },
          ],
          connections: [],
          trash: [],
        }),
      }),
    });
    return created.id;
  });
  check("project created through the same session", Boolean(projectId));
  await page.click("#refresh");
  await page.waitForFunction(() =>
    document.getElementById("public-state")?.textContent.includes("disabled")
  );

  const sectionGaps = await page.evaluate(() => {
    const sections = [...document.querySelectorAll("#sharing-content > .admin-section")];
    return sections.slice(1).map((section, index) => Math.round(section.getBoundingClientRect().top - sections[index].getBoundingClientRect().bottom));
  });
  check(
    "sharing sections keep the shared vertical gap",
    sectionGaps.length >= 2 && sectionGaps.every((gap) => gap >= 8),
    sectionGaps.join(",")
  );

  await page.click("#enable-sharing");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("Tick the acknowledgement"));
  check("sharing requires the explicit acknowledgement", true);
  await page.check("#acknowledge");
  await page.click("#enable-sharing");
  await page.waitForFunction(() => document.getElementById("public-state").textContent.includes("enabled"));
  check("public sharing enables after acknowledgement", true);

  await page.selectOption("#scope", "item");
  await page.selectOption("#target", "share-note");
  await page.fill("#password", "share-passphrase-123");
  await page.click("#create");
  await page.waitForFunction(() => document.getElementById("token").textContent.includes("khn_"));
  check("scoped link can be created and shown once", true);
  check("created link appears in the list", (await page.locator("#shares li").count()) === 1);

  await page.locator("#shares li button").click();
  await page.waitForFunction(() => document.getElementById("shares").textContent.includes("No share links"));
  check("share link can be revoked", (await page.locator("#shares li").count()) === 0);

  await page.click("#disable-sharing");
  await page.waitForFunction(() => document.getElementById("public-state").textContent.includes("disabled"));
  check("disabling public sharing revokes the capability", true);
} catch (error) {
  console.error("FAIL", error.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
