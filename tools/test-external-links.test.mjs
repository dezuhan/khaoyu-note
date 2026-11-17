// Unit tests for link-card URL classification. Run with:
//   node --test tools/test-external-links.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  BLOCKED_SCHEMES,
  DEFAULT_ALLOWED_SCHEMES,
  classifyLink,
  isBlockedScheme,
  isValidScheme,
  linkDisplayDomain,
  normalizeLinkUrl,
  schemeOf,
} from "../app/web/js/external-links.js";

test("schemes are detected and host:port pairs are not mistaken for schemes", () => {
  assert.equal(schemeOf("khaoyunote://open?board=welcome"), "khaoyunote");
  assert.equal(schemeOf("KHAOYUNOTE://open"), "khaoyunote");
  assert.equal(schemeOf("mailto:someone@example.com"), "mailto");
  assert.equal(schemeOf("file:///home/user/notes.html"), "file");
  assert.equal(schemeOf("https://example.com/page"), "https");
  assert.equal(schemeOf("example.com"), "");
  assert.equal(schemeOf("example.com:8080/path"), "");
  assert.equal(schemeOf("localhost:3000"), "");
  assert.equal(schemeOf(""), "");
});

test("link normalisation keeps every explicit scheme intact", () => {
  const customLink = "khaoyunote://open?board=welcome";
  assert.equal(normalizeLinkUrl(customLink), customLink);
  assert.equal(normalizeLinkUrl("https://example.com"), "https://example.com");
  assert.equal(normalizeLinkUrl("mailto:someone@example.com"), "mailto:someone@example.com");
  assert.equal(normalizeLinkUrl("example.com"), "https://example.com");
  assert.equal(normalizeLinkUrl("  127.0.0.1:1430/status  "), "https://127.0.0.1:1430/status");
  // Cards written by older builds may carry an https:// prefix in front of the real scheme.
  assert.equal(
    normalizeLinkUrl("https://khaoyunote://open?board=welcome"),
    "khaoyunote://open?board=welcome"
  );
  assert.equal(
    normalizeLinkUrl("http://khaoyunote://open?board=welcome"),
    "khaoyunote://open?board=welcome"
  );
  assert.equal(normalizeLinkUrl("https://example.com:8080/path"), "https://example.com:8080/path");
  assert.equal(normalizeLinkUrl(""), "");
});

test("classification marks web, custom and blocked links", () => {
  const web = classifyLink("example.com");
  assert.equal(web.url, "https://example.com");
  assert.equal(web.scheme, "https");
  assert.equal(web.web, true);
  assert.equal(web.blocked, false);

  const custom = classifyLink("khaoyunote://open?board=welcome");
  assert.equal(custom.scheme, "khaoyunote");
  assert.equal(custom.web, false);
  assert.equal(custom.blocked, false);

  const blocked = classifyLink("JavaScript:alert(1)");
  assert.equal(blocked.scheme, "javascript");
  assert.equal(blocked.blocked, true);
});

test("link cards label custom schemes by scheme instead of a fake hostname", () => {
  assert.equal(linkDisplayDomain("khaoyunote://open?board=welcome"), "khaoyunote");
  assert.equal(linkDisplayDomain("https://www.example.com/page"), "example.com");
  assert.equal(linkDisplayDomain("example.com"), "example.com");
});

test("scheme validation and the default allowlist are stable", () => {
  assert.ok(isValidScheme("khaoyunote"));
  assert.ok(isValidScheme("ms-word"));
  assert.ok(isValidScheme("vscode"));
  assert.ok(!isValidScheme(""));
  assert.ok(!isValidScheme("bad scheme"));
  assert.ok(!isValidScheme(":khaoyunote"));
  for (const scheme of BLOCKED_SCHEMES) assert.ok(isBlockedScheme(scheme), scheme);
  assert.ok(!isBlockedScheme("khaoyunote"));
  assert.deepEqual(DEFAULT_ALLOWED_SCHEMES, ["http", "https", "mailto"]);
});
