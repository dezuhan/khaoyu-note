// Node checks for the presence badge summary. Run with: node tools/test-presence.mjs
import assert from "node:assert/strict";
import { colorFor, MAX_PRESENCE_AVATARS, summarizePresence } from "../app/web/js/presence.js";

assert.equal(MAX_PRESENCE_AVATARS, 3);

const empty = summarizePresence([], "");
assert.deepEqual(empty, { people: [], visible: [], total: 0, hidden: 0 });

const users = [
  { accountId: "u1", account: "a", name: "Alice", connectionId: "c1" },
  { accountId: "u1", name: "Alice", connectionId: "c2" },
  { accountId: "u2", name: " bob ", connectionId: "c3" },
  { accountId: "u3", name: "", connectionId: "c4" },
  { accountId: "u4", name: "Dan", connectionId: "c5" },
];
const summary = summarizePresence(users, "");
assert.equal(summary.total, 4, "duplicate connections count once");
assert.equal(summary.visible.length, 3);
assert.equal(summary.hidden, 1);
assert.deepEqual(summary.visible.map((person) => person.name), ["Alice", "bob", "Dan"]);
assert.equal(summary.visible.every((person) => person.accountId), true);

const withoutSelf = summarizePresence(users, "u2");
assert.equal(withoutSelf.total, 3);
assert.equal(withoutSelf.hidden, 0);
assert.equal(withoutSelf.visible.some((person) => person.accountId === "u2"), false);

const capped = summarizePresence([], "", 0);
assert.equal(capped.visible.length, 0);

const colorA = colorFor("account-a");
const colorB = colorFor("account-b");
assert.match(colorA, /^hsl\(\d+ 72% 52%\)$/);
assert.equal(colorA, colorFor("account-a"));
assert.notEqual(colorA, colorB);

console.log("PASS  presence roster dedupes accounts, hides the current user and caps at three avatars");
