// Browser check for the workspace switcher: it auto-loads the last (or first non-default) workspace
// and can create a board inside that workspace.
// node tools/test-workspace-ui.mjs http://127.0.0.1:1430/
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const previewUrl = process.argv[2] || "http://127.0.0.1:1430/";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "khaoyu-workspace-ui-"));
const secret = crypto.randomBytes(32).toString("hex");
const email = `workspace-${crypto.randomUUID()}@example.com`;
const password = "workspace-password-123";
const env = {
  ...process.env,
  KHAOYU_SERVICE_SECRET: secret,
  KHAOYU_SERVICE_DATA_DIR: dataDir,
  KHAOYU_SERVICE_HOST: "localhost",
  KHAOYU_SERVICE_COOKIE_SECURE: "false",
  KHAOYU_SERVICE_RP_ID: "localhost",
};
const server = spawn(process.execPath, ["service/src/server.mjs"], { cwd: root, env, stdio: "ignore" });
let browser;
let mockAuthServer = null;
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  ::  " + detail : ""}`);
  if (!ok) failures += 1;
}

async function waitForRuntime() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataDir, "runtime.json"), "utf8"));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error("service did not write runtime.json");
}

async function waitForReady(base) {
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

spawnSync(process.execPath, ["service/src/cli.mjs", "migrate"], { cwd: root, env, stdio: "ignore" });

try {
  const base = (await waitForRuntime()).frontendUrl;
  await waitForReady(base);
  const registered = await fetch(`${base}/api/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, displayName: "Workspace Test" }),
  });
  check("account registered", registered.status === 202, `status ${registered.status}`);
  const login = await fetch(`${base}/api/v1/auth/sync-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const { token } = await login.json();
  check("sync token issued", Boolean(token));
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const workspaceResponse = await fetch(`${base}/api/v1/workspaces`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Client workspace" }),
  });
  const workspace = await workspaceResponse.json();
  check("non-default workspace created", workspaceResponse.status === 201, JSON.stringify(workspace));
  const boardResponse = await fetch(`${base}/api/v1/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Workspace board", workspaceId: workspace.id }),
  });
  const board = await boardResponse.json();
  check("board created inside the workspace", boardResponse.status === 201 && board.workspaceId === workspace.id, JSON.stringify(board));

  browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addInitScript(
    ({ config, servers }) => {
      localStorage.setItem("ky.sync.config", JSON.stringify(config));
      localStorage.setItem("ky.servers", JSON.stringify(servers));
    },
    {
      config: { url: base, email, token },
      servers: [{ url: base, token, email, name: new URL(base).host }],
    }
  );
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(previewUrl, { waitUntil: "load" });
  await page.waitForSelector("#boot", { state: "detached", timeout: 20000 }).catch(() => {});
  await page.click("#template-btn");
  await page.waitForSelector(".mn-workspace-popover");
  await page.waitForSelector('[data-role="workspace-detail"] [data-project]', { timeout: 10000 }).catch(() => {});

  const state = await page.evaluate(({ workspaceId, boardId }) => {
    const activeWorkspace = document.querySelector(
      ".mn-workspace-popover-board[data-workspace].is-active"
    );
    const detail = document.querySelector('[data-role="workspace-detail"]');
    return {
      activeWorkspace: activeWorkspace?.dataset.workspace || "",
      workspaceButtons: [...document.querySelectorAll("[data-workspace]")].map((button) => button.dataset.workspace),
      boards: [...(detail?.querySelectorAll("[data-project]") || [])].map((button) => button.dataset.project),
      expectedWorkspace: workspaceId,
      expectedBoard: boardId,
    };
  }, { workspaceId: workspace.id, boardId: board.id });
  check(
    "the non-default workspace is selected automatically",
    state.activeWorkspace === workspace.id,
    JSON.stringify(state.workspaceButtons)
  );
  check(
    "its board list loads without a click",
    state.boards.includes(board.id),
    JSON.stringify(state.boards)
  );
  const teamWorkspaceActive = state.activeWorkspace === "workspace_default";
  check("the seeded default workspace is not auto-selected", teamWorkspaceActive === false);

  const activeLocalBoard = await page.evaluate(async () => {
    const { state } = await import("/js/store.js");
    return {
      openBoardId: state.board?.id || "",
      markedBoardId: document.querySelector("[data-local-board].is-active")?.dataset.localBoard || "",
    };
  });
  check(
    "the currently open local board is highlighted in the workspace popover",
    activeLocalBoard.openBoardId && activeLocalBoard.openBoardId === activeLocalBoard.markedBoardId,
    JSON.stringify(activeLocalBoard)
  );
  const activeBeforeHover = await page.evaluate(() => {
    const button = document.querySelector("[data-local-board].is-active");
    return button ? getComputedStyle(button).backgroundColor : "";
  });
  await page.hover("[data-local-board].is-active");
  const activeAfterHover = await page.evaluate(() => {
    const button = document.querySelector("[data-local-board].is-active");
    return button ? getComputedStyle(button).backgroundColor : "";
  });
  check(
    "hovering the active board makes its highlight darker",
    activeBeforeHover && activeAfterHover && activeBeforeHover !== activeAfterHover,
    `${activeBeforeHover} -> ${activeAfterHover}`
  );

  check(
    "Local storage offers New Board",
    await page.locator('[data-local-new-board]').isVisible()
  );
  check(
    "the only local board has no delete button",
    (await page.locator("[data-local-remove]").count()) === 0
  );

  // Members opens the server-backed member list.
  await page.click('[data-role="workspace-members"]');
  await page.waitForSelector(".mn-modal");
  await page.waitForSelector(".mn-workspace-member", { timeout: 10000 });
  const memberText = await page.locator(".mn-modal").innerText();
  check("Members lists the workspace members", memberText.includes(email), memberText.replace(/\s+/g, " ").slice(0, 160));
  const sharingToggle = page.locator('[data-role="workspace-sharing"]');
  check("Members exposes the workspace sharing policy", await sharingToggle.isChecked());
  await sharingToggle.uncheck();
  await page.waitForTimeout(600);
  const blockedShare = await fetch(
    `${base}/api/v1/projects/${board.id}/public-sharing`,
    { method: "POST", headers, body: JSON.stringify({ enabled: true, acknowledge: true }) }
  );
  check(
    "workspace admin can disable board sharing",
    blockedShare.status === 403 && (await blockedShare.json()).code === "workspace_sharing_disabled",
    `status ${blockedShare.status}`
  );
  await sharingToggle.check();
  await page.waitForTimeout(400);
  await page.click(".mn-modal .mn-modal-close");
  await page.waitForSelector(".mn-modal", { state: "detached" });
  await page.waitForSelector(".mn-workspace-popover");

  // Register a second account with a username and invite it by username.
  const invitedEmail = `invite-${crypto.randomUUID()}@example.com`;
  const invitedUsername = `invitee-${crypto.randomUUID().slice(0, 8)}`;
  const invited = await fetch(`${base}/api/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: invitedEmail,
      username: invitedUsername,
      password: "workspace-password-456",
      displayName: "Invited User",
    }),
  });
  check("invitee account registered with a username", invited.status === 202, `status ${invited.status}`);
  await page.click('[data-role="workspace-invite"]');
  await page.waitForSelector(".mn-modal");
  await page.fill('.mn-modal input[name="email"]', invitedUsername);
  await page.click('.mn-modal button[type="submit"]');
  await page.waitForFunction(
    () => document.querySelector('.mn-modal [data-role="error"]')?.textContent.includes("Invitation sent."),
    null,
    { timeout: 10000 }
  );
  const invitations = await (await fetch(`${base}/api/v1/workspaces/${workspace.id}/invitations`, { headers })).json();
  check(
    "Invite by username creates a pending invitation",
    (invitations.invitations || []).some((entry) => entry.normalized_email === invitedEmail),
    invitedEmail
  );
  await page.click(".mn-modal .mn-modal-close");
  await page.waitForSelector(".mn-modal", { state: "detached" });
  await page.waitForSelector(".mn-workspace-popover");

  // Add Server first asks for the endpoint, probes its auth features, then shows the login options.
  mockAuthServer = http.createServer((request, response) => {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    if (request.url === "/api/v1/auth/features") {
      response.writeHead(200, { "content-type": "application/json", ...cors });
      response.end(
        JSON.stringify({
          passkeysEnabled: false,
          registrationMode: "public",
          oidcProviders: [
            { id: "google", name: "Google" },
            { id: "github", name: "GitHub" },
          ],
        })
      );
      return;
    }
    if (request.url === "/api/v1/auth/sync-token/begin") {
      response.writeHead(200, { "content-type": "application/json", ...cors });
      response.end(JSON.stringify({ totpRequired: true, challenge: "test-challenge" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json", ...cors });
    response.end("{}");
  });
  await new Promise((resolve) => mockAuthServer.listen(0, "127.0.0.1", resolve));
  const mockBase = `http://127.0.0.1:${mockAuthServer.address().port}`;
  await page.click('[data-add-server]');
  await page.waitForSelector(".mn-modal");
  const addServerStep1 = await page.evaluate(() => ({
    urlFields: document.querySelectorAll('form input[name="url"]').length,
    emailFields: document.querySelectorAll('form input[name="email"]').length,
    passwordFields: document.querySelectorAll('form input[name="password"]').length,
  }));
  check(
    "Add Server starts with the server URL only",
    addServerStep1.urlFields === 1 && addServerStep1.emailFields === 0 && addServerStep1.passwordFields === 0,
    JSON.stringify(addServerStep1)
  );
  await page.fill('form input[name="url"]', mockBase);
  await page.click('form button[type="submit"]');
  await page.waitForSelector(".mn-workspace-oidc", { timeout: 10000 });
  const addServerStep2 = await page.evaluate(() => ({
    emailFields: document.querySelectorAll('form input[name="email"]').length,
    passwordFields: document.querySelectorAll('form input[name="password"]').length,
    signInButton: Boolean(document.querySelector("form .mn-workspace-signin")),
    orVisible: Boolean(document.querySelector(".mn-workspace-or")),
    rowLayout: document.querySelector(".mn-workspace-oidc")?.classList.contains("is-row") || false,
    providers: [...document.querySelectorAll("[data-oidc-provider]")].map((button) => button.textContent.trim()),
  }));
  check(
    "Add Server then shows email, password, sign in and the OIDC options",
    addServerStep2.emailFields === 1 &&
      addServerStep2.passwordFields === 1 &&
      addServerStep2.signInButton &&
      addServerStep2.orVisible &&
      addServerStep2.rowLayout &&
      addServerStep2.providers.length === 2,
    JSON.stringify(addServerStep2)
  );
  await page.fill('.mn-modal input[name="email"]', "member@example.com");
  await page.fill('.mn-modal input[name="password"]', "password-123");
  await page.click('.mn-modal button[type="submit"]');
  await page.waitForSelector('[data-role="switch"]', { timeout: 10000 });
  const challengeTitle = await page.locator(".mn-modal").innerText();
  check(
    "Add Server asks for the 2FA code when the account has it enabled",
    challengeTitle.includes("Two-factor authentication") &&
      challengeTitle.includes("Use a backup code instead"),
    challengeTitle.replace(/\s+/g, " ").slice(0, 180)
  );
  await page.click('[data-role="switch"]');
  await page.waitForTimeout(200);
  const backupTitle = await page.locator(".mn-modal").innerText();
  check(
    "Add Server offers the backup-code page",
    backupTitle.includes("Use a backup code") &&
      backupTitle.includes("Sign in with backup code") &&
      backupTitle.includes("Use an authenticator code instead"),
    backupTitle.replace(/\s+/g, " ").slice(0, 180)
  );
  await page.click(".mn-modal [data-role=cancel]");
  await page.waitForSelector(".mn-modal", { state: "detached" });
  await page.click("#template-btn");
  await page.waitForSelector(".mn-workspace-popover");

  // Opening a stale/missing board id must not create a phantom "Untitled board" in the local list.
  const phantomGuard = await page.evaluate(async () => {
    const store = await import("/js/store.js");
    const bridge = await import("/js/bridge.js");
    await store.openBoard("missing-board-id", { flush: false });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const boards = await bridge.listBoards();
    return {
      boardId: store.state.board?.id || "",
      hasMissing: boards.some((board) => board.id === "missing-board-id"),
    };
  });
  check(
    "opening a missing board does not add an Untitled board",
    phantomGuard.boardId !== "missing-board-id" && phantomGuard.hasMissing === false,
    JSON.stringify(phantomGuard)
  );

  // New board action creates a board in the selected workspace and opens it.
  await page.click('[data-role="workspace-new-board"]');
  await page.fill('form input[name="title"]', "Created from UI");
  await page.click('form button[type="submit"]');
  await page.waitForTimeout(1200);
  const openedTitle = await page.evaluate(async () => {
    const store = await import("/js/store.js");
    return store.state.board?.title || "";
  });
  check("New board opens inside the workspace", openedTitle === "Created from UI", openedTitle);
  const remoteBoards = await (
    await fetch(`${base}/api/v1/workspaces/${workspace.id}/boards`, { headers })
  ).json();
  check(
    "the new board belongs to the selected workspace",
    (remoteBoards.projects || []).some((project) => project.name === "Created from UI"),
    ((remoteBoards.projects || []).map((project) => project.name)).join(",")
  );
  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (error) {
  console.error("FAIL  workspace harness", error?.stack || error);
  failures += 1;
} finally {
  await browser?.close().catch(() => {});
  mockAuthServer?.close();
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(failures === 0 ? "ALL WORKSPACE CHECKS PASSED" : `${failures} WORKSPACE CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}
