// Low-volume load and abuse smoke check. Do not run against production.
// node tools/load-service.mjs --base http://127.0.0.1:8080
function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const base = argument("--base", "http://127.0.0.1:8080").replace(/\/+$/, "");
const requests = Number(argument("--requests", "60"));
const concurrency = Number(argument("--concurrency", "6"));
const email = argument("--login-email", null);
const password = argument("--login-password", null);

async function timed(pathname, options) {
  const started = performance.now();
  const response = await fetch(base + pathname, options);
  await response.arrayBuffer();
  return { status: response.status, ms: performance.now() - started };
}

async function pool(count, worker) {
  const results = [];
  let next = 0;
  async function run() {
    while (next < count) {
      const index = next++;
      results[index] = await worker(index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, run));
  return results;
}

const health = await pool(requests, () => timed("/healthz"));
const healthBad = health.filter((entry) => entry.status !== 200);
const healthMs = health.map((entry) => entry.ms).sort((a, b) => a - b);
console.log(
  `health: ${requests - healthBad.length}/${requests} ok, p50 ${healthMs[Math.floor(healthMs.length * 0.5)].toFixed(0)}ms, p95 ${healthMs[Math.floor(healthMs.length * 0.95)].toFixed(0)}ms`
);

const shares = await pool(requests, () =>
  timed("/api/v1/share/not-a-real-token/access", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
);
const shareBad = shares.filter((entry) => entry.status !== 404);
console.log(`invalid share tokens: ${requests - shareBad.length}/${requests} returned neutral 404`);

const huge = await timed("/api/v1/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "load@example.com", password: "x".repeat(2 * 1024 * 1024) }),
});
console.log(`oversized login body: ${huge.status} (expected 413 or 401)`);

let login = null;
if (email && password) {
  const attempts = await pool(10, () =>
    timed("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    })
  );
  login = attempts.map((entry) => entry.status);
  console.log(`login attempts: ${login.join(", ")}`);
}

const serverErrors = [...health, ...shares].filter((entry) => entry.status >= 500);
const failed =
  healthBad.length > 0 ||
  shareBad.length > 0 ||
  serverErrors.length > 0 ||
  ![401, 413, 429].includes(huge.status) ||
  (login && login.some((status) => status >= 500));
console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
