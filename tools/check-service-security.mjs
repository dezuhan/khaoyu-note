// Live security smoke check against a running Khaoyu Note service.
// Requires a verified account and no TOTP:
//   node tools/check-service-security.mjs --base http://127.0.0.1:8080 \
//     --credentials target/service-dev-credentials.json
import fs from "node:fs";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

let credentials = {};
const credentialsFile = argument("--credentials");
if (credentialsFile) {
  const raw = fs.readFileSync(credentialsFile, "utf8").replace(/^\uFEFF/, "");
  credentials = JSON.parse(raw);
}
const base = (argument("--base", credentials.url || "http://127.0.0.1:8080")).replace(/\/+$/, "");
const email = argument("--email", process.env.KHAOYU_SERVICE_EMAIL || credentials.email);
const password = argument("--password", process.env.KHAOYU_SERVICE_PASSWORD || credentials.password);
if (!email || !password) {
  console.error("Provide --credentials, or --email and --password.");
  process.exit(2);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  ::  " + detail : ""}`);
}

function absorb(jar, response) {
  for (const cookie of response.headers.getSetCookie?.() || []) {
    const pair = cookie.split(";")[0];
    const index = pair.indexOf("=");
    if (index > 0) jar[pair.slice(0, index)] = pair.slice(index + 1);
  }
}

async function call(pathname, { method = "GET", body, jar, csrf = true, origin } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (jar && Object.keys(jar).length) {
    headers.cookie = Object.entries(jar)
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }
  if (csrf && jar?.khaoyu_csrf) headers["x-csrf-token"] = jar.khaoyu_csrf;
  if (origin) headers.origin = origin;
  const response = await fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (jar) absorb(jar, response);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, response };
}

async function login() {
  const jar = {};
  const result = await call("/api/v1/auth/login", {
    method: "POST",
    body: { email, password },
    jar,
  });
  if (result.status !== 200) throw new Error(`login failed: ${result.status} ${JSON.stringify(result.body)}`);
  return jar;
}

const health = await call("/healthz");
check("health endpoint is alive", health.status === 200 && health.body.status === "ok");
const ready = await call("/readyz");
check("readiness checks the database", ready.status === 200 && ready.body.status === "ready");

const unknown = await call("/api/v1/auth/login", {
  method: "POST",
  body: { email: `missing-${Date.now()}@example.com`, password: "wrong-password-123" },
});
const wrong = await call("/api/v1/auth/login", {
  method: "POST",
  body: { email, password: "wrong-password-123" },
});
check(
  "unknown email and wrong password return the same generic error",
  unknown.status === 401 && wrong.status === 401 && unknown.body.error === wrong.body.error,
  `${unknown.body.error} / ${wrong.body.error}`
);

const jar = await login();
check("valid credentials issue session cookies", Boolean(jar.khaoyu_access && jar.khaoyu_refresh && jar.khaoyu_csrf));
const projects = await call("/api/v1/projects", { jar });
check("session cookie authorizes project listing", projects.status === 200);

const noCsrf = await call("/api/v1/projects", {
  method: "POST",
  body: { title: "csrf probe" },
  jar,
  csrf: false,
});
check("cookie write without CSRF is rejected", noCsrf.status === 403 && noCsrf.body.code === "csrf_failed");
const badOrigin = await call("/api/v1/projects", {
  method: "POST",
  body: { title: "origin probe" },
  jar,
  origin: "https://evil.example",
});
check("cross-origin cookie write is rejected", badOrigin.status === 403 && badOrigin.body.code === "origin_denied");

const projectId = projects.body.projects[0]?.id;
if (projectId) {
  const enabled = await call(`/api/v1/projects/${projectId}/public-sharing`, {
    method: "POST",
    jar,
    body: { enabled: true, acknowledge: true },
  });
  check("owner can enable public sharing", enabled.status === 204);
  const share = await call(`/api/v1/projects/${projectId}/shares`, {
    method: "POST",
    jar,
    body: {
      scope: "project",
      permission: "view",
      password: "share-password-123",
    },
  });
  check("password-protected share link is created", share.status === 201 && share.body.token.startsWith("khn_share_"));
  const noPassword = await call(`/api/v1/share/${share.body.token}/access`, {
    method: "POST",
    body: {},
  });
  const wrongPassword = await call(`/api/v1/share/${share.body.token}/access`, {
    method: "POST",
    body: { password: "wrong-password-123" },
  });
  const goodPassword = await call(`/api/v1/share/${share.body.token}/access`, {
    method: "POST",
    body: { password: "share-password-123" },
  });
  check(
    "share passphrase is required and wrong values are indistinguishable",
    noPassword.status === 404 && wrongPassword.status === 404 && goodPassword.status === 200
  );
  const rotated = await call(`/api/v1/projects/${projectId}/shares/${share.body.id}/rotate`, {
    method: "POST",
    jar,
  });
  const oldToken = await call(`/api/v1/share/${share.body.token}/access`, {
    method: "POST",
    body: { password: "share-password-123" },
  });
  check(
    "rotating a share invalidates the old token",
    rotated.status === 200 && oldToken.status === 404
  );
  const revoked = await call(`/api/v1/projects/${projectId}/shares/${share.body.id}`, {
    method: "DELETE",
    jar,
  });
  const afterRevoke = await call(`/api/v1/share/${rotated.body.token}/access`, {
    method: "POST",
    body: { password: "share-password-123" },
  });
  check("revoking a share blocks future access", revoked.status === 204 && afterRevoke.status === 404);
  await call(`/api/v1/projects/${projectId}/public-sharing`, {
    method: "POST",
    jar,
    body: { enabled: false },
  });
}

const sessions = await call("/api/v1/auth/sessions", { jar });
check("session list is available", sessions.status === 200 && sessions.body.sessions.length >= 1);
check("session list marks the current session", sessions.body.sessions.some((entry) => entry.current));

const refreshJar = await login();
const oldRefresh = refreshJar.khaoyu_refresh;
const refreshed = await call("/api/v1/auth/refresh", { method: "POST", jar: refreshJar });
check("refresh rotates the token", refreshed.status === 200 && refreshJar.khaoyu_refresh !== oldRefresh);
const replay = await call("/api/v1/auth/refresh", {
  method: "POST",
  jar: { khaoyu_refresh: oldRefresh },
});
check("refresh reuse is detected", replay.status === 401 && replay.body.code === "refresh_reuse");
const family = await call("/api/v1/auth/refresh", {
  method: "POST",
  jar: { khaoyu_refresh: refreshJar.khaoyu_refresh },
});
check("reuse revokes the whole session family", family.status === 401);

const revokeJar = await login();
const revokeSessions = await call("/api/v1/auth/sessions", { jar: revokeJar });
const current = revokeSessions.body.sessions.find((entry) => entry.current);
const revoked = await call(`/api/v1/auth/sessions/${current.id}`, { method: "DELETE", jar: revokeJar });
const afterRevoke = await call("/api/v1/projects", { jar: revokeJar });
check("revoked session loses access on the next request", revoked.status === 204 && afterRevoke.status === 401);

await call("/api/v1/auth/logout", { method: "POST", jar });
check("logout clears the session", (await call("/api/v1/projects", { jar })).status === 401);

const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} live security checks passed`);
process.exit(failed ? 1 : 0);
