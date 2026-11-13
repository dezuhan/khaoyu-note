import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { createLogger } from "../src/logger.mjs";
import { openDatabase, migrate, MIGRATIONS_DIR } from "../src/db.mjs";
import { createFileMailer } from "../src/auth/mailer.mjs";
import { createService } from "../src/app.mjs";

const SECRET = "Kx9-vQ2m-Rt7-pL4s-Wb8-nC3d-Hf6-jZ1a";
const PASSWORD = "correct-horse-9";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "khaoyu-oidc-"));
}

function configFor(dataDir) {
  return {
    profile: "single-user",
    host: "127.0.0.1",
    port: 0,
    publicUrl: "http://127.0.0.1",
    dataDir,
    secret: SECRET,
    databasePath: path.join(dataDir, "khaoyu-service.db"),
    objectsDir: path.join(dataDir, "objects"),
    tempDir: path.join(dataDir, "tmp"),
    backupsDir: path.join(dataDir, "backups"),
    outboxDir: path.join(dataDir, "outbox"),
    cookieSecure: false,
    publicSharingEnabled: true,
    corsOrigins: ["tauri://localhost"],
    adminToken: "Admin-5f3c9a7e2b8d4c1f6a0e9d3b7c2f8a4e",
    ssoEnabled: false,
    ssoSecret: "",
    ssoHeader: "x-auth-request-email",
    ssoNameHeader: "x-auth-request-name",
    ssoAutoCreate: false,
    passkeysEnabled: false,
    rpId: "localhost",
    publicSharingEnabled: true,
    accessTtlMinutes: 15,
    refreshTtlDays: 7,
    deletionGraceDays: 30,
    loginWindowMinutes: 15,
    loginMaxAttempts: 5,
    backupIntervalHours: 24,
    backupRetention: 2,
    auditRetentionDays: 90,
    tempMaxAgeHours: 1,
    realtimeTicketTtlMs: 60_000,
    editLockTtlMs: 15_000,
    opRetentionDays: 7,
    compactOps: 100,
    compactMs: 30_000,
    oidcProviders: [],
  };
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function signToken(privateKey, claims) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" }));
  const body = base64url(JSON.stringify(claims));
  const signature = crypto
    .sign("sha256", Buffer.from(`${header}.${body}`), privateKey)
    .toString("base64url");
  return `${header}.${body}.${signature}`;
}

async function mockProvider() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
  const state = {
    nonce: "",
    email: "oidc-user@example.com",
    emailVerified: true,
    name: "OIDC User",
    tokenCalls: 0,
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/.well-known/openid-configuration") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          issuer: state.issuer,
          authorization_endpoint: `${state.issuer}/authorize`,
          token_endpoint: `${state.issuer}/token`,
          jwks_uri: `${state.issuer}/jwks`,
        })
      );
      return;
    }
    if (url.pathname === "/token") {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const params = new URLSearchParams(body);
        state.tokenCalls += 1;
        if (params.get("code") !== "good-code") {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        const idToken = signToken(privateKey, {
          iss: state.issuer,
          aud: "test-client",
          sub: "oidc-subject-1",
          email: state.email,
          email_verified: state.emailVerified,
          name: state.name,
          nonce: state.nonce,
          iat: now,
          exp: now + 300,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ access_token: "at", id_token: idToken, token_type: "Bearer" }));
      });
      return;
    }
    if (url.pathname === "/jwks") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (url.pathname === "/login/oauth/access_token") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: "gh-token", token_type: "bearer" }));
      return;
    }
    if (url.pathname === "/user") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 4242, login: "octocat", name: "Octo Cat" }));
      return;
    }
    if (url.pathname === "/user/emails") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ email: state.email, primary: true, verified: state.emailVerified }]));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  state.issuer = base;
  return { base, state, server };
}

function providerFor(base, kind, id, overrides = {}) {
  if (kind === "oidc") {
    return {
      id,
      kind: "oidc",
      name: "Mock OIDC",
      enabled: true,
      clientId: "test-client",
      clientSecret: "test-secret",
      redirectUrl: "",
      issuer: base,
      authorizationEndpoint: `${base}/authorize`,
      tokenEndpoint: `${base}/token`,
      jwksUri: `${base}/jwks`,
      scopes: ["openid", "email", "profile"],
      autoCreate: true,
      allowedDomains: [],
      ...overrides,
    };
  }
  return {
    id,
    kind: "github",
    name: "GitHub",
    enabled: true,
    clientId: "gh-client",
    clientSecret: "gh-secret",
    redirectUrl: "",
    authorizationEndpoint: `${base}/login/oauth/authorize`,
    tokenEndpoint: `${base}/login/oauth/access_token`,
    userApi: base,
    scopes: ["read:user", "user:email"],
    autoCreate: true,
    allowedDomains: [],
    ...overrides,
  };
}

async function start({ registrationMode = "public", provider } = {}) {
  const dataDir = tempDir();
  const config = configFor(dataDir);
  config.oidcProviders = [provider];
  const db = openDatabase(config.databasePath);
  migrate(db, { directory: MIGRATIONS_DIR });
  db.prepare("INSERT OR REPLACE INTO service_meta (key, value) VALUES ('registration_mode', ?)").run(
    registrationMode
  );
  db.prepare("INSERT OR REPLACE INTO service_meta (key, value) VALUES ('workspace_mode', 'private')").run();
  const logger = createLogger({ write() {} });
  const mailer = createFileMailer(config, logger);
  const server = createService({ config, db, logger, mailer });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.publicUrl = base;
  provider.redirectUrl = `${base}/api/v1/auth/oidc/${provider.id}/callback`;
  return {
    base,
    db,
    config,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function cookieValue(response, name) {
  const cookies = response.headers.getSetCookie?.() || [];
  const found = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  return found ? found.split(";")[0] : "";
}

function statePayload(cookie) {
  const value = decodeURIComponent(cookie.split("=")[1]);
  return JSON.parse(Buffer.from(value.split(".")[0], "base64url").toString("utf8"));
}

async function begin(base, providerId, query = "") {
  const start = await fetch(`${base}/api/v1/auth/oidc/${providerId}/start${query}`, {
    redirect: "manual",
  });
  assert.equal(start.status, 302);
  const location = new URL(start.headers.get("location"));
  const cookie = cookieValue(start, "khaoyu_oidc_state");
  assert.ok(cookie, "state cookie is set");
  return {
    state: location.searchParams.get("state"),
    nonce: statePayload(cookie).nonce,
    cookie,
    location,
  };
}

async function callback(base, providerId, { state, cookie, code = "good-code" }) {
  return fetch(
    `${base}/api/v1/auth/oidc/${providerId}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(
      state
    )}`,
    { redirect: "manual", headers: { cookie } }
  );
}

function sessionCookie(response) {
  return (response.headers.getSetCookie?.() || [])
    .filter((cookie) => /^(khaoyu_access|khaoyu_refresh|khaoyu_csrf)=/.test(cookie))
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

test("the features endpoint advertises configured providers", async (t) => {
  const mock = await mockProvider();
  const app = await start({ provider: providerFor(mock.base, "oidc", "mock-oidc") });
  t.after(async () => {
    await app.close();
    mock.server.close();
  });
  const response = await fetch(`${app.base}/api/v1/auth/features`);
  const features = await response.json();
  assert.deepEqual(features.oidcProviders, [{ id: "mock-oidc", name: "Mock OIDC" }]);
  const login = await fetch(`${app.base}/login`);
  assert.match(await login.text(), /oidc-providers/);
});

test("Google-style OIDC signs in, creates an account and rejects open redirects", async (t) => {
  const mock = await mockProvider();
  const app = await start({ provider: providerFor(mock.base, "oidc", "google") });
  t.after(async () => {
    await app.close();
    mock.server.close();
  });
  const flow = await begin(app.base, "google", "?redirect=//evil.example");
  mock.state.nonce = flow.nonce;
  const done = await callback(app.base, "google", { state: flow.state, cookie: flow.cookie });
  assert.equal(done.status, 302);
  assert.equal(done.headers.get("location"), "/admin");
  const jar = sessionCookie(done);
  assert.match(jar, /khaoyu_access=/);
  const sessions = await fetch(`${app.base}/api/v1/auth/sessions`, { headers: { cookie: jar } });
  const session = await sessions.json();
  assert.equal(session.account.email, "oidc-user@example.com");
  const identity = app.db
    .prepare("SELECT * FROM oauth_identities WHERE provider = 'google'")
    .get();
  assert.equal(identity.subject, "oidc-subject-1");
  assert.equal(identity.email, "oidc-user@example.com");
  const account = app.db
    .prepare("SELECT * FROM accounts WHERE email = ?")
    .get("oidc-user@example.com");
  assert.equal(account.password_hash, null);
  assert.equal(account.role, "admin");
});

test("an existing local account is linked by verified email", async (t) => {
  const mock = await mockProvider();
  const app = await start({ provider: providerFor(mock.base, "oidc", "google") });
  t.after(async () => {
    await app.close();
    mock.server.close();
  });
  const registered = await fetch(`${app.base}/api/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "oidc-user@example.com", password: PASSWORD, displayName: "Local" }),
  });
  assert.equal(registered.status, 202);
  const account = app.db
    .prepare("SELECT * FROM accounts WHERE email = ?")
    .get("oidc-user@example.com");
  const flow = await begin(app.base, "google");
  mock.state.nonce = flow.nonce;
  const done = await callback(app.base, "google", { state: flow.state, cookie: flow.cookie });
  assert.equal(done.headers.get("location"), "/admin");
  const linked = app.db
    .prepare("SELECT * FROM oauth_identities WHERE provider = 'google'")
    .get();
  assert.equal(linked.account_id, account.id);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM accounts").get().count, 1);
});

test("state validation blocks a forged callback", async (t) => {
  const mock = await mockProvider();
  const app = await start({ provider: providerFor(mock.base, "oidc", "google") });
  t.after(async () => {
    await app.close();
    mock.server.close();
  });
  const flow = await begin(app.base, "google");
  mock.state.nonce = flow.nonce;
  const forged = await callback(app.base, "google", { state: "not-the-state", cookie: flow.cookie });
  assert.equal(forged.status, 302);
  assert.match(forged.headers.get("location"), /\/login\?error=invalid_state/);
  const missing = await fetch(
    `${app.base}/api/v1/auth/oidc/google/callback?code=good-code&state=${flow.state}`,
    { redirect: "manual" }
  );
  assert.match(missing.headers.get("location"), /\/login\?error=invalid_state/);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM accounts").get().count, 0);
});

test("unverified provider emails and disallowed domains are rejected", async (t) => {
  const mock = await mockProvider();
  const app = await start({
    provider: providerFor(mock.base, "oidc", "google", { allowedDomains: ["example.com"] }),
  });
  t.after(async () => {
    await app.close();
    mock.server.close();
  });
  const flow = await begin(app.base, "google");
  mock.state.nonce = flow.nonce;
  mock.state.emailVerified = false;
  const unverified = await callback(app.base, "google", { state: flow.state, cookie: flow.cookie });
  assert.match(unverified.headers.get("location"), /error=email_unverified/);

  mock.state.emailVerified = true;
  mock.state.email = "person@other.test";
  const second = await begin(app.base, "google");
  mock.state.nonce = second.nonce;
  const blocked = await callback(app.base, "google", { state: second.state, cookie: second.cookie });
  assert.match(blocked.headers.get("location"), /error=domain_not_allowed/);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM accounts").get().count, 0);
});

test("private registration mode creates a pending account without a session", async (t) => {
  const mock = await mockProvider();
  const app = await start({
    registrationMode: "private",
    provider: providerFor(mock.base, "oidc", "google"),
  });
  t.after(async () => {
    await app.close();
    mock.server.close();
  });
  const first = await fetch(`${app.base}/api/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "first@example.com", password: PASSWORD, displayName: "First" }),
  });
  assert.equal(first.status, 202);
  const flow = await begin(app.base, "google");
  mock.state.nonce = flow.nonce;
  const done = await callback(app.base, "google", { state: flow.state, cookie: flow.cookie });
  assert.match(done.headers.get("location"), /error=account_pending/);
  assert.equal(sessionCookie(done), "");
  const account = app.db
    .prepare("SELECT * FROM accounts WHERE email = ?")
    .get("oidc-user@example.com");
  assert.ok(account);
  assert.equal(account.approved_at, null);
});

test("GitHub OAuth uses the verified primary email and links an identity", async (t) => {
  const mock = await mockProvider();
  mock.state.email = "octo@example.com";
  const app = await start({ provider: providerFor(mock.base, "github", "github") });
  t.after(async () => {
    await app.close();
    mock.server.close();
  });
  const flow = await begin(app.base, "github");
  mock.state.nonce = flow.nonce;
  const done = await callback(app.base, "github", { state: flow.state, cookie: flow.cookie });
  assert.equal(done.headers.get("location"), "/admin");
  const jar = sessionCookie(done);
  const sessions = await fetch(`${app.base}/api/v1/auth/sessions`, { headers: { cookie: jar } });
  assert.equal((await sessions.json()).account.email, "octo@example.com");
  const identity = app.db
    .prepare("SELECT * FROM oauth_identities WHERE provider = 'github'")
    .get();
  assert.equal(identity.subject, "4242");
  assert.equal(identity.email, "octo@example.com");
});

test("auto-create disabled rejects unknown provider accounts", async (t) => {
  const mock = await mockProvider();
  const app = await start({
    provider: providerFor(mock.base, "oidc", "google", { autoCreate: false }),
  });
  t.after(async () => {
    await app.close();
    mock.server.close();
  });
  const flow = await begin(app.base, "google");
  mock.state.nonce = flow.nonce;
  const done = await callback(app.base, "google", { state: flow.state, cookie: flow.cookie });
  assert.match(done.headers.get("location"), /error=account_missing/);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM accounts").get().count, 0);
});

test("OIDC discovery resolves the authorization, token and JWKS endpoints", async (t) => {
  const mock = await mockProvider();
  const provider = providerFor(mock.base, "oidc", "google", {
    authorizationEndpoint: undefined,
    tokenEndpoint: undefined,
    jwksUri: undefined,
    discoveryUrl: `${mock.base}/.well-known/openid-configuration`,
    allowHttp: true,
  });
  const app = await start({ provider });
  t.after(async () => {
    await app.close();
    mock.server.close();
  });
  const flow = await begin(app.base, "google");
  assert.equal(flow.location.pathname, "/authorize");
  assert.equal(flow.location.searchParams.get("client_id"), "test-client");
  assert.equal(flow.location.searchParams.get("code_challenge_method"), "S256");
  mock.state.nonce = flow.nonce;
  const done = await callback(app.base, "google", { state: flow.state, cookie: flow.cookie });
  assert.equal(done.headers.get("location"), "/admin");
  assert.match(sessionCookie(done), /khaoyu_access=/);
});

test("register intent creates an account even when auto-create is disabled", async (t) => {
  const mock = await mockProvider();
  const app = await start({
    registrationMode: "private",
    provider: providerFor(mock.base, "github", "github", { autoCreate: false }),
  });
  t.after(async () => {
    await app.close();
    mock.server.close();
  });
  const first = await fetch(`${app.base}/api/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "first@example.com", password: PASSWORD, displayName: "First" }),
  });
  assert.equal(first.status, 202);
  const flow = await begin(app.base, "github", "?mode=register");
  mock.state.email = "new-github@example.com";
  mock.state.nonce = flow.nonce;
  const done = await callback(app.base, "github", { state: flow.state, cookie: flow.cookie });
  assert.equal(done.headers.get("location"), "/login?pending=1");
  assert.equal(sessionCookie(done), "");
  const account = app.db
    .prepare("SELECT * FROM accounts WHERE email = ?")
    .get("new-github@example.com");
  assert.ok(account);
  assert.equal(account.approved_at, null);
  assert.equal(
    app.db.prepare("SELECT COUNT(*) AS count FROM oauth_identities WHERE provider = 'github'").get()
      .count,
    1
  );
});
