// End-to-end public share viewer check.
// node tools/test-share-view.mjs
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "khaoyu-share-view-"));
const port = 18094;
const base = `http://localhost:${port}`;
const secret = crypto.randomBytes(32).toString("hex");
const email = `share-view-${crypto.randomUUID()}@example.com`;
const password = "share-view-password-123";
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

async function api(pathname, { method = "GET", body, jar } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (jar && Object.keys(jar).length) headers.cookie = Object.entries(jar).map(([key, value]) => `${key}=${value}`).join("; ");
  if (jar?.khaoyu_csrf) headers["x-csrf-token"] = jar.khaoyu_csrf;
  const response = await fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (jar) {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0];
      const index = pair.indexOf("=");
      jar[pair.slice(0, index)] = pair.slice(index + 1);
    }
  }
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

try {
  await waitForReady();
  await api("/api/v1/auth/register", { method: "POST", body: { email, password, displayName: "Share Viewer" } });
  const verifyToken = latestMail("verify").text.match(/token: (\S+)/)[1];
  await api("/api/v1/auth/verify-email", { method: "POST", body: { token: verifyToken } });
  const jar = {};
  await api("/api/v1/auth/login", { method: "POST", body: { email, password }, jar });
  const project = await api("/api/v1/projects", { method: "POST", body: { title: "Viewer board" }, jar });
  await api(`/api/v1/projects/${project.body.id}/snapshot`, {
    method: "PUT",
    jar,
    body: {
      revision: 1,
      doc: JSON.stringify({
        id: project.body.id,
        title: "Viewer board",
        cards: [
          { id: "view-note", type: "note", x: 0, y: 0, w: 200, h: 70, z: 1, text: "Visible shared note" },
          { id: "view-column", type: "column", x: 300, y: 0, w: 200, h: 300, z: 2, title: "Shared column" },
          { id: "view-child", type: "note", x: 310, y: 70, w: 180, h: 70, z: 3, parentId: "view-column", text: "Column child" },
        ],
        connections: [],
        trash: [],
      }),
    },
  });
  await api(`/api/v1/projects/${project.body.id}/public-sharing`, {
    method: "POST",
    jar,
    body: { enabled: true, acknowledge: true },
  });
  const protectedShare = await api(`/api/v1/projects/${project.body.id}/shares`, {
    method: "POST",
    jar,
    body: { scope: "project", permission: "view", password: "share-view-passphrase" },
  });
  const columnShare = await api(`/api/v1/projects/${project.body.id}/shares`, {
    method: "POST",
    jar,
    body: { scope: "column", targetId: "view-column", permission: "view" },
  });

  browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.log("PAGEERROR", error.message));
  await page.goto(`${base}/s/${protectedShare.body.token}`, { waitUntil: "load" });
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("invalid"));
  check("protected link shows a neutral lock message", true);
  await page.fill("#passphrase", "share-view-passphrase");
  await page.click("#open");
  await page.waitForFunction(() => document.getElementById("title").textContent.includes("Viewer board"));
  check("correct passphrase renders the project", true);
  check("shared note is visible", (await page.locator("#content").innerText()).includes("Visible shared note"));
  check("shared column child is visible", (await page.locator("#content").innerText()).includes("Column child"));

  const columnPage = await browser.newPage();
  await columnPage.goto(`${base}/s/${columnShare.body.token}`, { waitUntil: "load" });
  await columnPage.waitForFunction(() => document.getElementById("title").textContent.includes("Shared column"));
  check("column share renders only its scope", (await columnPage.locator("#content").innerText()).includes("Column child"));
  check("column share does not leak siblings", !(await columnPage.locator("#content").innerText()).includes("Visible shared note"));

  const invalid = await browser.newPage();
  await invalid.goto(`${base}/s/not-a-real-token`, { waitUntil: "load" });
  await invalid.waitForFunction(() => document.getElementById("status").textContent.includes("invalid"));
  check("invalid token shows a neutral message", true);

  const headers = await fetch(`${base}/s/${protectedShare.body.token}`);
  check("share page is noindex", headers.headers.get("x-robots-tag") === "noindex, nofollow");
} catch (error) {
  console.error("FAIL", error.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
