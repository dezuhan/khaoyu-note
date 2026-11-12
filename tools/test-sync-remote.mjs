// Manual integration check for the durable remote sync queue (not part of CI).
// Service (SQLite) + preview frontend + Playwright, with a simulated offline period and reload.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "khaoyu-sync-remote-"));
const secret = crypto.randomBytes(32).toString("hex");
const email = `sync-${crypto.randomUUID()}@example.com`;
const password = "sync-password-123";
const env = {
  ...process.env,
  KHAOYU_SERVICE_SECRET: secret,
  KHAOYU_SERVICE_DATA_DIR: dataDir,
  KHAOYU_SERVICE_HOST: "localhost",
  KHAOYU_SERVICE_COOKIE_SECURE: "false",
  KHAOYU_SERVICE_RP_ID: "localhost",
};
const previewUrl = process.argv[2] || "http://127.0.0.1:1430/";

spawnSync(process.execPath, ["service/src/cli.mjs", "migrate"], { cwd: root, env, stdio: "ignore" });
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

async function remoteDoc(base, token, projectId) {
  const response = await fetch(`${base}/api/v1/projects/${projectId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  return JSON.parse(body.snapshot?.doc || "{}");
}

try {
  const runtime = await waitForRuntime();
  const base = runtime.frontendUrl;
  await waitForReady(base);
  const registered = await fetch(`${base}/api/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, displayName: "Sync Test" }),
  });
  check("service account registered", registered.status === 202, `status ${registered.status}`);
  const login = await fetch(`${base}/api/v1/auth/sync-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const { token } = await login.json();
  check("sync token issued", Boolean(token));
  const created = await fetch(`${base}/api/v1/projects`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ title: "Remote sync board" }),
  });
  const project = await created.json();
  const projectId = project.id;
  const seedDoc = {
    id: projectId,
    title: "Remote sync board",
    cards: [{ id: "remote-note", type: "note", x: 40, y: 40, w: 260, h: 90, z: 1, text: "from server" }],
    connections: [],
    trash: [],
  };
  await fetch(`${base}/api/v1/projects/${projectId}/snapshot`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ revision: project.revision, doc: JSON.stringify(seedDoc) }),
  });
  const config = { url: base, email, token };
  const servers = [{ url: base, token, email, name: new URL(base).host }];

  browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addInitScript(
    ({ config, servers }) => {
      localStorage.setItem("ky.sync.config", JSON.stringify(config));
      localStorage.setItem("ky.servers", JSON.stringify(servers));
    },
    { config, servers }
  );
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(previewUrl, { waitUntil: "load" });
  await page.waitForSelector("#boot", { state: "detached", timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(300);

  const opened = await page.evaluate(async ({ base, token, projectId, seedDoc }) => {
    const store = await import("/js/store.js");
    const sync = await import("/js/sync.js");
    await store.openRemoteBoard(seedDoc, {
      projectId,
      revision: 1,
      lastSeq: 0,
      lastSyncedAt: Date.now(),
    });
    sync.saveSyncConfig({ url: base, email: "sync@example.com", token });
    await sync.attachRemoteBoard(store.state.board, {
      projectId,
      revision: 1,
      lastSeq: 0,
      baseDoc: seedDoc,
      serverUrl: base,
    });
    localStorage.setItem("ky.lastBoard", projectId);
    return store.state.board?.id === projectId;
  }, { base, token, projectId, seedDoc });
  check("remote board opened from the server", opened);

  // Online edit: the capture runs on save and the operation reaches the service.
  await page.evaluate(async () => {
    const store = await import("/js/store.js");
    store.state.board.cards[0].text = "online edit";
    store.markDirty("board");
  });
  let onlineDoc = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    onlineDoc = await remoteDoc(base, token, projectId).catch(() => null);
    if (onlineDoc?.cards?.[0]?.text === "online edit") break;
    await page.waitForTimeout(150);
  }
  check("online edit syncs to the service", onlineDoc?.cards?.[0]?.text === "online edit", onlineDoc?.cards?.[0]?.text);

  // Offline edit: the operation is persisted locally even though the push fails.
  await page.route("**/api/v1/**", (route) => route.abort());
  await page.evaluate(async () => {
    const store = await import("/js/store.js");
    store.state.board.cards[0].text = "offline edit";
    store.markDirty("board");
  });
  await page.waitForTimeout(700);
  const offlineState = await page.evaluate(async ({ projectId }) => {
    const sync = await import("/js/sync.js");
    const record = await sync.readCachedBoard(projectId);
    return {
      pending: record?.pendingOps?.length || 0,
      text: record?.doc?.cards?.[0]?.text || "",
      status: sync.syncStatusFor((await import("/js/store.js")).state.board).status,
    };
  }, { projectId });
  check("offline edit is persisted in the durable queue", offlineState.pending >= 1, JSON.stringify(offlineState));
  check("status reports pending while offline", offlineState.status === "pending", offlineState.status);

  // Reload while offline: the board must reopen from the cache with the local edit.
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("#boot", { state: "detached", timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(600);
  const afterReload = await page.evaluate(async ({ projectId }) => {
    const store = await import("/js/store.js");
    return {
      boardId: store.state.board?.id || "",
      text: store.state.board?.cards?.[0]?.text || "",
      remote: store.state.remote,
      expected: projectId,
    };
  }, { projectId });
  check(
    "offline reload reopens the cached remote board with the local edit",
    afterReload.boardId === projectId && afterReload.text === "offline edit",
    JSON.stringify(afterReload)
  );

  // Another offline edit, then reconnect: the queue flushes in order.
  await page.evaluate(async () => {
    const store = await import("/js/store.js");
    store.state.board.cards[0].text = "offline edit 2";
    store.markDirty("board");
  });
  await page.waitForTimeout(600);
  await page.unroute("**/api/v1/**");
  const flushed = await page.evaluate(async () => {
    const sync = await import("/js/sync.js");
    return sync.flushQueue();
  });
  check("queue flushes after reconnect", flushed.flushed >= 1, JSON.stringify(flushed));
  let finalDoc = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    finalDoc = await remoteDoc(base, token, projectId).catch(() => null);
    if (finalDoc?.cards?.[0]?.text === "offline edit 2") break;
    await page.waitForTimeout(150);
  }
  check("queued offline edits reach the service", finalDoc?.cards?.[0]?.text === "offline edit 2", finalDoc?.cards?.[0]?.text);
  const finalStatus = await page.evaluate(async () => {
    const sync = await import("/js/sync.js");
    const store = await import("/js/store.js");
    return sync.syncStatusFor(store.state.board).status;
  });
  check("status returns to synced", finalStatus === "synced", finalStatus);

  // Concurrent same-field edit: the local value wins, but the overlap is reported as a field
  // conflict with the server value available to apply. The browser is taken offline explicitly and
  // the capture is awaited, so no autosave timer can race the phase.
  await context.setOffline(true);
  const conflictPending = await page.evaluate(async () => {
    const store = await import("/js/store.js");
    const sync = await import("/js/sync.js");
    store.state.board.cards[0].text = "conflict local";
    const captured = await sync.captureBoardChanges(store.state.board);
    return { pending: captured.pending };
  });
  check("the local edit is queued offline", conflictPending.pending === 1, JSON.stringify(conflictPending));
  const remoteProject = await (
    await fetch(`${base}/api/v1/projects/${projectId}`, { headers: { authorization: `Bearer ${token}` } })
  ).json();
  const directOp = await fetch(`${base}/api/v1/projects/${projectId}/ops`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      baseSeq: Number(remoteProject.project.lastSeq),
      ops: [
        {
          opId: `remote-${Date.now()}`,
          type: "card.update",
          payload: { id: "remote-note", patch: { text: "conflict remote" } },
        },
      ],
    }),
  });
  check("a second client edits the same field", directOp.ok, `status ${directOp.status}`);
  await context.setOffline(false);
  await page.evaluate(async () => {
    const sync = await import("/js/sync.js");
    await sync.flushQueue();
  });
  let conflictState = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    conflictState = await page.evaluate(async ({ projectId }) => {
      const sync = await import("/js/sync.js");
      const store = await import("/js/store.js");
      const record = await sync.readCachedBoard(projectId);
      return {
        conflicts: record?.fieldConflicts || [],
        boardText: store.state.board?.cards?.[0]?.text || "",
        message: sync.syncStatusFor(store.state.board).message,
      };
    }, { projectId });
    if (conflictState.conflicts.length) break;
    await page.waitForTimeout(150);
  }
  check(
    "the overlapping field edit is recorded as a conflict",
    conflictState?.conflicts?.length === 1 &&
      conflictState.conflicts[0].field === "text" &&
      conflictState.conflicts[0].remoteValue === "conflict remote",
    JSON.stringify(conflictState?.conflicts)
  );
  check("the local value won the field", conflictState?.boardText === "conflict local", conflictState?.boardText);
  check("the status mentions the field conflict", /field conflict/.test(conflictState?.message || ""), conflictState?.message);
  const appliedServer = await page.evaluate(async () => {
    const sync = await import("/js/sync.js");
    const store = await import("/js/store.js");
    const result = await sync.applyServerFieldValues(store.state.board);
    return { applied: result.applied, text: store.state.board?.cards?.[0]?.text || "" };
  });
  check(
    "the server value can be applied to the editor",
    appliedServer.applied === 1 && appliedServer.text === "conflict remote",
    JSON.stringify(appliedServer)
  );

  // Concurrent edits in different regions of the same text field merge instead of one replacing the
  // other.
  await context.setOffline(true);
  const mergePending = await page.evaluate(async () => {
    const store = await import("/js/store.js");
    const sync = await import("/js/sync.js");
    store.state.board.cards[0].text = "LOCAL conflict remote";
    const captured = await sync.captureBoardChanges(store.state.board);
    return { pending: captured.pending };
  });
  check("the second local edit is queued offline", mergePending.pending === 1, JSON.stringify(mergePending));
  const mergeProject = await (
    await fetch(`${base}/api/v1/projects/${projectId}`, { headers: { authorization: `Bearer ${token}` } })
  ).json();
  const mergeDirect = await fetch(`${base}/api/v1/projects/${projectId}/ops`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      baseSeq: Number(mergeProject.project.lastSeq),
      ops: [
        {
          opId: `merge-remote-${Date.now()}`,
          type: "card.update",
          payload: { id: "remote-note", patch: { text: "conflict remote REMOTE" } },
        },
      ],
    }),
  });
  check("a second client edits another region of the field", mergeDirect.ok, `status ${mergeDirect.status}`);
  await context.setOffline(false);
  await page.evaluate(async () => {
    const sync = await import("/js/sync.js");
    await sync.flushQueue();
  });
  let mergedTextState = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    mergedTextState = await page.evaluate(async ({ projectId }) => {
      const sync = await import("/js/sync.js");
      const store = await import("/js/store.js");
      const record = await sync.readCachedBoard(projectId);
      return { text: store.state.board?.cards?.[0]?.text || "", conflicts: record?.fieldConflicts || [] };
    }, { projectId });
    if (mergedTextState.text === "LOCAL conflict remote REMOTE") break;
    await page.waitForTimeout(150);
  }
  const mergedRemote = await remoteDoc(base, token, projectId);
  check(
    "disjoint text edits merge on both sides",
    mergedTextState?.text === "LOCAL conflict remote REMOTE" &&
      mergedRemote?.cards?.[0]?.text === "LOCAL conflict remote REMOTE" &&
      mergedTextState.conflicts.length === 0,
    JSON.stringify({ local: mergedTextState, remote: mergedRemote?.cards?.[0]?.text })
  );

  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (error) {
  console.error("FAIL  integration harness", error?.stack || error);
  failures += 1;
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(failures === 0 ? "ALL REMOTE SYNC CHECKS PASSED" : `${failures} REMOTE SYNC CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}
