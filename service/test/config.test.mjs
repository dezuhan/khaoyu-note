import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";

const SECRET = "Kx9-vQ2m-Rt7-pL4s-Wb8-nC3d-Hf6-jZ1a";

test("backend storage configuration parses PostgreSQL and Redis URLs", () => {
  const config = loadConfig({
    KHAOYU_SERVICE_SECRET: SECRET,
    KHAOYU_SERVICE_DATABASE_URL: "postgres://khaoyu:secret@127.0.0.1:5432/khaoyu",
    KHAOYU_SERVICE_DATABASE_SSL: "true",
    KHAOYU_SERVICE_DATABASE_POOL_MAX: "12",
    KHAOYU_SERVICE_REDIS_URL: "rediss://:secret@127.0.0.1:6379/0",
    KHAOYU_SERVICE_REDIS_PREFIX: "khaoyu:team",
    KHAOYU_SERVICE_INSTANCE_ID: "instance-a",
    KHAOYU_SERVICE_REALTIME_TICKET_TTL_MS: "90000",
    KHAOYU_SERVICE_EDIT_LOCK_TTL_MS: "20000",
    KHAOYU_SERVICE_OP_RETENTION_DAYS: "14",
    KHAOYU_SERVICE_COMPACT_OPS: "250",
    KHAOYU_SERVICE_COMPACT_MS: "45000",
  });
  assert.equal(config.databaseUrl, "postgres://khaoyu:secret@127.0.0.1:5432/khaoyu");
  assert.equal(config.databaseSsl, true);
  assert.equal(config.databasePoolMax, 12);
  assert.equal(config.redisUrl, "rediss://:secret@127.0.0.1:6379/0");
  assert.equal(config.redisPrefix, "khaoyu:team");
  assert.equal(config.instanceId, "instance-a");
  assert.equal(config.realtimeTicketTtlMs, 90000);
  assert.equal(config.editLockTtlMs, 20000);
  assert.equal(config.opRetentionDays, 14);
  assert.equal(config.compactOps, 250);
  assert.equal(config.compactMs, 45000);
});

test("backend storage configuration has safe defaults", () => {
  const config = loadConfig({ KHAOYU_SERVICE_SECRET: SECRET });
  assert.equal(config.databaseUrl, "");
  assert.equal(config.redisUrl, "");
  assert.equal(config.databaseSsl, false);
  assert.equal(config.databasePoolMax, 10);
  assert.equal(config.redisPrefix, "khaoyu");
  assert.equal(config.realtimeTicketTtlMs, 60000);
  assert.equal(config.editLockTtlMs, 15000);
  assert.equal(config.opRetentionDays, 7);
  assert.equal(config.compactOps, 100);
  assert.equal(config.compactMs, 30000);
  assert.match(config.instanceId, /:/);
});

test("invalid backend storage configuration fails closed", () => {
  assert.throws(
    () =>
      loadConfig({
        KHAOYU_SERVICE_SECRET: SECRET,
        KHAOYU_SERVICE_DATABASE_URL: "mysql://127.0.0.1/khaoyu",
      }),
    /postgres:\/\//
  );
  assert.throws(
    () =>
      loadConfig({
        KHAOYU_SERVICE_SECRET: SECRET,
        KHAOYU_SERVICE_REDIS_URL: "http://127.0.0.1:6379",
      }),
    /redis:\/\//
  );
  assert.throws(
    () =>
      loadConfig({
        KHAOYU_SERVICE_SECRET: SECRET,
        KHAOYU_SERVICE_REDIS_PREFIX: "not allowed",
      }),
    /REDIS_PREFIX/
  );
  assert.throws(
    () =>
      loadConfig({
        KHAOYU_SERVICE_SECRET: SECRET,
        KHAOYU_SERVICE_DATABASE_POOL_MAX: "0",
      }),
    /DATABASE_POOL_MAX/
  );
  assert.throws(
    () =>
      loadConfig({
        KHAOYU_SERVICE_SECRET: SECRET,
        KHAOYU_SERVICE_REALTIME_TICKET_TTL_MS: "10",
      }),
    /REALTIME_TICKET_TTL_MS/
  );
});

test("team profile is accepted by the shared configuration", () => {
  const config = loadConfig({
    KHAOYU_SERVICE_SECRET: SECRET,
    KHAOYU_SERVICE_PROFILE: "team",
    KHAOYU_SERVICE_DATABASE_URL: "postgres://khaoyu:secret@127.0.0.1:5432/khaoyu",
    KHAOYU_SERVICE_REDIS_URL: "redis://127.0.0.1:6379",
  });
  assert.equal(config.profile, "team");
  assert.equal(config.databaseUrl, "postgres://khaoyu:secret@127.0.0.1:5432/khaoyu");
  assert.equal(config.redisUrl, "redis://127.0.0.1:6379");
});

test("OIDC providers are parsed only when fully configured", () => {
  const config = loadConfig({
    KHAOYU_SERVICE_SECRET: SECRET,
    KHAOYU_SERVICE_GOOGLE_CLIENT_ID: "google-client",
    KHAOYU_SERVICE_GOOGLE_CLIENT_SECRET: "google-secret",
    KHAOYU_SERVICE_GOOGLE_AUTO_CREATE: "true",
    KHAOYU_SERVICE_GOOGLE_ALLOWED_DOMAINS: "example.com, Example.org",
    KHAOYU_SERVICE_GITHUB_CLIENT_ID: "github-client",
    KHAOYU_SERVICE_GITHUB_CLIENT_SECRET: "github-secret",
  });
  assert.equal(config.oidcProviders.length, 2);
  const google = config.oidcProviders.find((provider) => provider.id === "google");
  assert.equal(google.kind, "oidc");
  assert.equal(google.autoCreate, true);
  assert.deepEqual(google.allowedDomains, ["example.com", "example.org"]);
  assert.match(google.redirectUrl, /\/api\/v1\/auth\/oidc\/google\/callback$/);
  const github = config.oidcProviders.find((provider) => provider.id === "github");
  assert.equal(github.kind, "github");
  assert.equal(github.autoCreate, false);
});

test("half-configured OIDC providers fail closed", () => {
  assert.throws(
    () =>
      loadConfig({
        KHAOYU_SERVICE_SECRET: SECRET,
        KHAOYU_SERVICE_GOOGLE_CLIENT_ID: "google-client",
      }),
    /GOOGLE_CLIENT_SECRET/
  );
  assert.throws(
    () =>
      loadConfig({
        KHAOYU_SERVICE_SECRET: SECRET,
        KHAOYU_SERVICE_GITHUB_CLIENT_ID: "github-client",
        KHAOYU_SERVICE_GITHUB_CLIENT_SECRET: "github-secret",
        KHAOYU_SERVICE_GITHUB_REDIRECT_URL: "javascript:alert(1)",
      }),
    /redirect URL must be http/
  );
});
