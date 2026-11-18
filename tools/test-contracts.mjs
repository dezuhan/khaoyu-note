// Phase 0 contract gate: validates the app-facing sync API against contracts/, checks the protocol
// version header, and keeps the integration suites from importing service internals.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startService } from "./service-runner.mjs";
import { validateSchema } from "./lib/schema-check.mjs";
import { generateTotp } from "./totp.mjs";

const root = path.resolve(import.meta.dirname, "..");
const contracts = {
  openapi: JSON.parse(fs.readFileSync(path.join(root, "contracts/openapi.json"), "utf8")),
  errors: JSON.parse(fs.readFileSync(path.join(root, "contracts/errors.json"), "utf8")),
  ops: JSON.parse(fs.readFileSync(path.join(root, "contracts/events/ops.schema.json"), "utf8")),
  snapshot: JSON.parse(fs.readFileSync(path.join(root, "contracts/events/snapshot.schema.json"), "utf8")),
  presence: JSON.parse(fs.readFileSync(path.join(root, "contracts/events/presence.schema.json"), "utf8")),
};
const schemas = contracts.openapi.components.schemas;
const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  ::  " + detail : ""}`);
  if (ok) results.push(name);
}
function validate(name, value, schema, rootSchema = contracts.openapi) {
  const errors = validateSchema(value, schema, rootSchema);
  check(name, errors.length === 0, errors.slice(0, 3).join(" | "));
}
function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(root, "contracts/fixtures", name), "utf8"));
}

// Static checks first: they run without a server.
const requiredPaths = [
  "/api/v1/auth/sync-token",
  "/api/v1/projects",
  "/api/v1/projects/{projectId}",
  "/api/v1/projects/{projectId}/ops",
  "/api/v1/projects/{projectId}/realtime-ticket",
  "/api/v1/projects/{projectId}/presence",
  "/api/v1/projects/{projectId}/locks",
  "/api/v1/projects/{projectId}/events",
];
check(
  "OpenAPI covers the app sync endpoints",
  requiredPaths.every((entry) => contracts.openapi.paths[entry]),
  requiredPaths.filter((entry) => !contracts.openapi.paths[entry]).join(", ")
);
const syncSource = fs.readFileSync(path.join(root, "app/web/js/sync.js"), "utf8");
for (const fragment of ["/api/v1/auth/sync-token", "/ops", "/realtime-ticket", "/events", "/presence", "/locks", "/api/v1/projects"]) {
  check(`sync.js still calls ${fragment}`, syncSource.includes(fragment));
}
check(
  "sync client sends the protocol header",
  syncSource.includes('"x-khaoyu-protocol": "1"'),
  "x-khaoyu-protocol"
);

validate("fixture: sync token", fixture("auth-sync-token.json"), schemas.SyncTokenResponse);
validate("fixture: project response", fixture("project-response.json"), schemas.ProjectResponse);
validate("fixture: ops request", fixture("ops-request.json"), schemas.OpsRequest);
validate("fixture: ops response", fixture("ops-response.json"), schemas.OpsResponse);
validate("fixture: ops event", fixture("event-ops.json"), contracts.ops);
validate("fixture: snapshot event", fixture("event-snapshot.json"), contracts.snapshot);
validate("fixture: presence event", fixture("event-presence.json"), contracts.presence);

// RFC 6238 reference vector (SHA-1, 6 digits, 30 second step, T=59s) keeps the standalone helper honest.
const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
check("standalone TOTP matches the RFC 6238 vector", generateTotp(rfcSecret, 59_000) === "287082", generateTotp(rfcSecret, 59_000));

// Live checks against the Node service.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "khaoyu-contracts-"));
const env = {
  ...process.env,
  KHAOYU_SERVICE_DATA_DIR: dataDir,
  KHAOYU_SERVICE_SECRET: crypto.randomBytes(32).toString("hex"),
  KHAOYU_SERVICE_HOST: "127.0.0.1",
  KHAOYU_SERVICE_COOKIE_SECURE: "false",
};
const migrate = spawnSync(process.execPath, ["service/src/cli.mjs", "migrate"], { cwd: root, env, encoding: "utf8" });
assert.equal(migrate.status, 0, migrate.stderr);
const server = startService({ cwd: root, env, stdio: "ignore" });
let base = "";

async function waitReady() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${base}/readyz`);
      if (response.ok) return;
    } catch {
      /* starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("service did not become ready");
}

async function call(pathname, { method = "GET", token = "", body, headers = {} } = {}) {
  const response = await fetch(base + pathname, {
    method,
    headers: {
      accept: "application/json",
      "x-khaoyu-protocol": "1",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { status: response.status, headers: response.headers, data };
}

try {
  const runtime = await (async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        return JSON.parse(fs.readFileSync(path.join(dataDir, "runtime.json"), "utf8"));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error("service did not write runtime.json");
  })();
  base = runtime.backendUrl;
  await waitReady();
  check("service starts with the contract test harness", Boolean(base));

  const email = `contract-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "contract-password-123";
  const registered = await call("/api/v1/auth/register", {
    method: "POST",
    body: { email, password, displayName: "Contract" },
  });
  check("first account registers", registered.status === 202, String(registered.status));

  const tokenResponse = await call("/api/v1/auth/sync-token", { method: "POST", body: { email, password } });
  check("sync token is issued", tokenResponse.status === 201, String(tokenResponse.status));
  check(
    "responses advertise the protocol version",
    tokenResponse.headers.get("x-khaoyu-protocol") === "1",
    tokenResponse.headers.get("x-khaoyu-protocol") || "missing"
  );
  validate("live: sync token response", tokenResponse.data, schemas.SyncTokenResponse);
  const token = tokenResponse.data.token;

  const rejectedProtocol = await call("/api/v1/projects", {
    token,
    headers: { "x-khaoyu-protocol": "2" },
  });
  check(
    "an unknown protocol major is rejected",
    rejectedProtocol.status === 426 && rejectedProtocol.data?.code === "protocol_unsupported",
    `${rejectedProtocol.status} ${rejectedProtocol.data?.code}`
  );

  const list = await call("/api/v1/projects", { token });
  check("projects list responds", list.status === 200, String(list.status));
  validate("live: project list", list.data, schemas.ProjectListResponse);

  const created = await call("/api/v1/projects", { method: "POST", token, body: { title: "Contract board" } });
  check("project create responds", created.status === 201, String(created.status));
  const projectId = created.data?.id || created.data?.project?.id;
  check("project create returns an id", typeof projectId === "string" && projectId.length > 0, String(projectId));

  const project = await call(`/api/v1/projects/${encodeURIComponent(projectId)}`, { token });
  check("project snapshot responds", project.status === 200, String(project.status));
  validate("live: project response", project.data, schemas.ProjectResponse);

  const opsRequest = fixture("ops-request.json");
  const ops = await call(`/api/v1/projects/${encodeURIComponent(projectId)}/ops`, {
    method: "POST",
    token,
    body: { baseSeq: 0, ops: opsRequest.ops.map((op, index) => ({ ...op, opId: `contract-op-${index}-${crypto.randomUUID().slice(0, 6)}` })) },
  });
  check("ops batch responds", ops.status === 200, String(ops.status));
  validate("live: ops response", ops.data, schemas.OpsResponse);

  const opList = await call(`/api/v1/projects/${encodeURIComponent(projectId)}/ops?after=0`, { token });
  check("ops catch-up responds", opList.status === 200, String(opList.status));
  validate("live: ops list", opList.data, schemas.OpsListResponse);

  const stale = await call(`/api/v1/projects/${encodeURIComponent(projectId)}/ops`, {
    method: "POST",
    token,
    body: { baseSeq: 0, ops: opsRequest.ops.map((op) => ({ ...op, opId: `contract-stale-${crypto.randomUUID().slice(0, 6)}` })) },
  });
  check(
    "a stale baseSeq returns the documented conflict code",
    stale.status === 409 && stale.data?.code === "seq_conflict",
    `${stale.status} ${stale.data?.code}`
  );

  const ticket = await call(`/api/v1/projects/${encodeURIComponent(projectId)}/realtime-ticket`, { method: "POST", token });
  check("realtime ticket responds", ticket.status === 201, String(ticket.status));
  validate("live: realtime ticket", ticket.data, schemas.RealtimeTicket);

  const lockBody = { key: "card:contract-card" };
  const lock = await call(`/api/v1/projects/${encodeURIComponent(projectId)}/locks`, {
    method: "POST",
    token,
    body: lockBody,
  });
  check("lock acquire responds", lock.status === 201, String(lock.status));
  validate("live: lock response", lock.data, schemas.LockResponse);
  const release = await call(`/api/v1/projects/${encodeURIComponent(projectId)}/locks`, {
    method: "DELETE",
    token,
    body: { ...lockBody, token: lock.data?.token || "" },
  });
  check(
    "lock release responds",
    release.status === 200 && release.data?.released === true,
    `${release.status} ${JSON.stringify(release.data)}`
  );
  validate("live: lock release", release.data, schemas.LockReleaseResponse);

  // SSE: connect with the single-use ticket and validate the first event envelope.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const stream = await fetch(
      `${base}/api/v1/projects/${encodeURIComponent(projectId)}/events?ticket=${encodeURIComponent(ticket.data.token)}`,
      { headers: { accept: "text/event-stream" }, signal: controller.signal }
    );
    check("SSE stream opens", stream.status === 200, String(stream.status));
    const reader = stream.body.getReader();
    let buffer = "";
    let eventName = "";
    let eventData = null;
    while (!eventData) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        const lines = block.split("\n");
        eventName = lines.find((line) => line.startsWith("event: "))?.slice(7) || "";
        const dataLine = lines.find((line) => line.startsWith("data: "));
        if (eventName && dataLine) eventData = JSON.parse(dataLine.slice(6));
      }
    }
    check("SSE delivers a presence event", eventName === "presence", eventName || "none");
    if (eventData) validate("live: presence event", eventData, contracts.presence);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
} finally {
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 150));
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${results.length} checks passed, ${failures} failed`);
if (failures) process.exitCode = 1;
