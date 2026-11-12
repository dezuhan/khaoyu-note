import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeRichFields, sanitizeRichHtml } from "../src/sanitize.mjs";

test("allows the document editor markup subset", () => {
  const html = '<p>Hello <strong>world</strong><br><a href="https://example.com">link</a></p>';
  assert.equal(
    sanitizeRichHtml(html),
    '<p>Hello <strong>world</strong><br><a href="https://example.com" rel="noopener noreferrer nofollow">link</a></p>'
  );
});

test("strips scripts, event handlers and unsafe urls", () => {
  const html = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(2)">',
    '<a href="javascript:alert(3)" onclick="alert(4)">bad</a>',
    '<a href="data:text/html,<script>alert(5)</script>">data</a>',
    '<p onclick="alert(6)">safe</p>',
    '<!-- comment -->',
  ].join("");
  const clean = sanitizeRichHtml(html);
  assert.doesNotMatch(clean, /script|onerror|onclick|javascript:|data:text/i);
  assert.match(clean, /<a rel="noopener noreferrer nofollow">bad<\/a>/);
  assert.match(clean, /<p>safe<\/p>/);
});

test("escapes stray markup characters in text", () => {
  assert.equal(sanitizeRichHtml("a < b"), "a &lt; b");
  assert.equal(sanitizeRichHtml('<p>a &lt; b</p>'), "<p>a &lt; b</p>");
});

test("sanitizes only rich fields on a card copy", () => {
  const card = {
    id: "card-1",
    type: "document",
    html: '<p onclick="x">body</p><script>x</script>',
    markdown: "<b>bold</b>",
    text: "<keep>",
  };
  const clean = sanitizeRichFields(card);
  assert.equal(clean.text, "<keep>");
  assert.equal(clean.html, "<p>body</p>x");
  assert.equal(clean.markdown, "<b>bold</b>");
  assert.notEqual(clean, card);
});
