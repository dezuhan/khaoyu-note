// Synthetic concurrent operation-load check. This is not a production benchmark; it verifies the
// service can serialize concurrent editors without corrupting the operation log.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "khaoyu-load-"));
const secret = crypto.randomBytes(32).toString("hex");
const env = { ...process.env, KHAOYU_SERVICE_SECRET: secret, KHAOYU_SERVICE_DATA_DIR: dataDir, KHAOYU_SERVICE_HOST: "127.0.0.1", KHAOYU_SERVICE_COOKIE_SECURE: "false" };
spawnSync(process.execPath, ["service/src/cli.mjs", "migrate"], { cwd: root, env, stdio: "ignore" });
const server = spawn(process.execPath, ["service/src/server.mjs"], { cwd: root, env, stdio: "ignore" });
let base = "";
let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ::  ${detail}` : ""}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitReady() {
  for (let i = 0; i < 80; i += 1) {
    try { const response = await fetch(`${base}/readyz`); if (response.ok) return; } catch {}
    await sleep(200);
  }
  throw new Error("service did not start");
}
async function request(pathname, { method = "GET", body, jar = {}, token } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (jar.khaoyu_csrf) headers["x-csrf-token"] = jar.khaoyu_csrf;
  if (Object.keys(jar).length) headers.cookie = Object.entries(jar).map(([key, value]) => `${key}=${value}`).join("; ");
  const response = await fetch(base + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const cookie of response.headers.getSetCookie?.() || []) {
    const pair = cookie.split(";")[0], index = pair.indexOf("=");
    if (index > 0) jar[pair.slice(0, index)] = pair.slice(index + 1);
  }
  const text = await response.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: response.status, body: parsed };
}
async function syncToken(email, password) {
  const result = await request("/api/v1/auth/sync-token", { method: "POST", body: { email, password } });
  if (result.status !== 201) throw new Error(`sync token ${result.status}`);
  return result.body.token;
}

try {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const runtime = JSON.parse(fs.readFileSync(path.join(dataDir, "runtime.json"), "utf8"));
      base = runtime.frontendUrl;
      await waitReady();
      break;
    } catch { await sleep(200); }
  }
  const password = "load-password-123";
  const ownerEmail = `load-owner-${crypto.randomUUID()}@example.com`;
  const ownerJar = {};
  await request("/api/v1/auth/register", { method: "POST", body: { email: ownerEmail, password, displayName: "Load Owner" } });
  await request("/api/v1/auth/login", { method: "POST", body: { email: ownerEmail, password }, jar: ownerJar });
  const project = await request("/api/v1/projects", { method: "POST", jar: ownerJar, body: { title: "Load board" } });
  const projectId = project.body.id;
  const clients = ["client-0"];
  const tokens = [await syncToken(ownerEmail, password)];
  for (let index = 1; index < 6; index += 1) {
    const email = `load-${index}-${crypto.randomUUID()}@example.com`;
    await request("/api/v1/auth/register", { method: "POST", body: { email, password, displayName: `Load ${index}` } });
    await request(`/api/v1/admin/boards/${projectId}/members`, { method: "POST", jar: ownerJar, body: { email, role: "editor" } });
    tokens.push(await syncToken(email, password));
    clients.push(`client-${index}`);
  }

  const batches = 20;
  const opsPerBatch = 3;
  const latencies = [];
  let conflicts = 0;
  let applied = 0;
  const started = Date.now();
  await Promise.all(tokens.map(async (token, clientIndex) => {
    let baseSeq = 0;
    for (let batch = 0; batch < batches; batch += 1) {
      const ops = Array.from({ length: opsPerBatch }, (_, opIndex) => ({
        opId: `load-${clientIndex}-${batch}-${opIndex}-${crypto.randomUUID()}`,
        type: "card.add",
        payload: { card: { id: `load-${clientIndex}-${batch}-${opIndex}-${crypto.randomUUID()}`, type: "note", x: 0, y: 0, w: 180, h: 70, z: 1, text: `load ${clientIndex}/${batch}/${opIndex}` } },
      }));
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const startedAt = Date.now();
        const result = await request(`/api/v1/projects/${projectId}/ops`, { method: "POST", token, body: { baseSeq, ops } });
        latencies.push(Date.now() - startedAt);
        if (result.status === 200) {
          baseSeq = result.body.lastSeq;
          applied += ops.length;
          break;
        }
        if (result.status === 409 && result.body?.code === "seq_conflict") {
          conflicts += 1;
          const latest = await request(`/api/v1/projects/${projectId}`, { token });
          baseSeq = Number(latest.body.project.lastSeq || 0);
          await sleep(2 + Math.random() * 12);
          continue;
        }
        throw new Error(`load op failed ${result.status} ${JSON.stringify(result.body)}`);
      }
    }
  }));
  const durationMs = Date.now() - started;
  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))];
  const state = await request(`/api/v1/projects/${projectId}`, { token: tokens[0] });
  const cards = JSON.parse(state.body.snapshot.doc).cards.length;
  check("concurrent operation batches all committed", applied === batches * opsPerBatch * tokens.length, `${applied} ops`);
  check("server operation log has no corruption", cards === applied && Number(state.body.project.lastSeq) === applied, `${cards} cards, seq ${state.body.project.lastSeq}`);
  console.log(`PASS  load ${applied} ops across ${tokens.length} clients in ${durationMs}ms; ${Math.round((applied / durationMs) * 1000)} ops/s; p95 ${p95}ms; conflicts ${conflicts}`);
} finally {
  server.kill("SIGTERM");
  await sleep(300);
  fs.rmSync(dataDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
