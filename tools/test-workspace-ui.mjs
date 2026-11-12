// Browser check for the workspace switcher: it auto-loads the last (or first non-default) workspace
// and can create a board inside that workspace.
// node tools/test-workspace-ui.mjs http://127.0.0.1:1430/
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
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
    const activeWorkspace = document.querySelector(".mn-workspace-popover-board.is-active");
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
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(failures === 0 ? "ALL WORKSPACE CHECKS PASSED" : `${failures} WORKSPACE CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}
