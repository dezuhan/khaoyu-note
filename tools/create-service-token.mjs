// Create a scoped API token for desktop sync.
// node tools/create-service-token.mjs --base http://127.0.0.1:8080 --email you@example.com
// The password is read from KHAOYU_SERVICE_PASSWORD or prompted on stdin.
import readline from "node:readline/promises";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const base = argument("--base", "http://127.0.0.1:8080").replace(/\/+$/, "");
const email = argument("--email", process.env.KHAOYU_SERVICE_EMAIL);
const name = argument("--name", "Desktop sync");
let password = process.env.KHAOYU_SERVICE_PASSWORD;
if (!email) {
  console.error("Provide --email.");
  process.exit(2);
}
if (!password) {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  password = await prompt.question("Service password: ");
  prompt.close();
}

const jar = {};
function absorb(response) {
  for (const cookie of response.headers.getSetCookie?.() || []) {
    const pair = cookie.split(";")[0];
    const index = pair.indexOf("=");
    if (index > 0) jar[pair.slice(0, index)] = pair.slice(index + 1);
  }
}
function cookieHeader() {
  return Object.entries(jar)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}
async function call(pathname, { method = "GET", body } = {}) {
  const response = await fetch(base + pathname, {
    method,
    headers: {
      ...(Object.keys(jar).length ? { cookie: cookieHeader() } : {}),
      ...(jar.khaoyu_csrf ? { "x-csrf-token": jar.khaoyu_csrf } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  absorb(response);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

const login = await call("/api/v1/auth/login", {
  method: "POST",
  body: { email, password },
});
if (login.status !== 200) {
  console.error(`Login failed: ${login.status} ${login.body?.error || ""}`);
  process.exit(1);
}
const created = await call("/api/v1/account/tokens", {
  method: "POST",
  body: {
    name,
    scopes: ["projects:read", "projects:write"],
    expiresInDays: 365,
  },
});
if (created.status !== 201) {
  console.error(`Token creation failed: ${created.status} ${created.body?.error || ""}`);
  process.exit(1);
}
console.log(JSON.stringify({ token: created.body.token, id: created.body.id, base }, null, 2));
