import assert from "node:assert/strict";
import test from "node:test";
import {
  OpError,
  applyOperation,
  clocksConcurrent,
  mergeClocks,
  normalizeClock,
  validateOperations,
} from "../src/collab-ops.mjs";

test("operations apply to a board document", () => {
  const doc = { id: "p1", title: "Board", cards: [], connections: [], trash: [] };
  applyOperation(doc, { type: "card.add", payload: { card: { id: "n1", type: "note", text: "one" } } });
  applyOperation(doc, { type: "card.update", payload: { id: "n1", patch: { text: "two", id: "nope", __proto__: { x: 1 } } } });
  applyOperation(doc, { type: "card.move", payload: { id: "n1", x: 12, y: 34, order: 2, parentId: null } });
  applyOperation(doc, { type: "doc.title", payload: { title: "Renamed" } });
  assert.equal(doc.title, "Renamed");
  assert.equal(doc.cards.length, 1);
  assert.equal(doc.cards[0].text, "two");
  assert.equal(doc.cards[0].id, "n1");
  assert.equal(doc.cards[0].x, 12);
  assert.equal(doc.cards[0].parentId, null);
});

test("card delete removes descendants and their connections", () => {
  const doc = {
    id: "p1",
    title: "Board",
    cards: [
      { id: "c1", type: "column" },
      { id: "n1", type: "note", parentId: "c1" },
      { id: "n2", type: "note" },
    ],
    connections: [
      { id: "x", from: "c1", to: "n2" },
      { id: "y", from: "n1", to: "n2" },
      { id: "z", from: "n1", to: "n1" },
    ],
    trash: [],
  };
  applyOperation(doc, { type: "card.delete", payload: { id: "c1" } });
  assert.deepEqual(doc.cards.map((card) => card.id), ["n2"]);
  assert.deepEqual(doc.connections.map((connection) => connection.id), []);
});

test("connections can be replaced without sending the whole document", () => {
  const doc = {
    id: "p1",
    title: "Board",
    cards: [{ id: "a", type: "note" }, { id: "b", type: "note" }],
    connections: [{ id: "old", from: "a", to: "b" }],
    trash: [],
  };
  applyOperation(doc, {
    type: "connections.set",
    payload: { connections: [{ id: "new", from: "b", to: "a" }] },
  });
  assert.deepEqual(doc.connections.map((connection) => connection.id), ["new"]);
  assert.equal(doc.cards.length, 2);
  assert.throws(
    () => applyOperation(doc, { type: "connections.set", payload: { connections: "nope" } }),
    /must be an array/
  );
  assert.doesNotThrow(() =>
    validateOperations([{ opId: "c1", type: "connections.set", payload: { connections: [] } }])
  );
});

test("client clocks detect concurrent writes and merge causally", () => {
  assert.deepEqual(normalizeClock({ a: 3, b: -1, c: "x", d: 2.9 }), { a: 3, d: 2 });
  assert.deepEqual(normalizeClock("nope"), {});
  assert.deepEqual(mergeClocks({ a: 2 }, { a: 1, b: 4 }), { a: 2, b: 4 });
  assert.equal(clocksConcurrent({ a: 2 }, { a: 1 }), false);
  assert.equal(clocksConcurrent({ a: 2, b: 1 }, { a: 1 }), false);
  assert.equal(clocksConcurrent({ a: 2 }, { a: 1, b: 1 }), true);
  assert.equal(clocksConcurrent({ a: 2 }, { b: 1 }), true);
  assert.equal(clocksConcurrent({ a: 2, c: 1 }, { b: 1, c: 1 }), true);
  assert.doesNotThrow(() =>
    validateOperations([{ opId: "clock-1", type: "doc.title", payload: { title: "x" }, clock: { tab: 1 } }])
  );
  assert.throws(
    () => validateOperations([{ opId: "clock-2", type: "doc.title", payload: { title: "x" }, clock: "bad" }]),
    /clock/
  );
});

test("bulk operations may be larger than a card patch", () => {
  const largeTitle = "x".repeat(300 * 1024);
  assert.doesNotThrow(() =>
    validateOperations([
      { opId: "bulk-1", type: "connections.set", payload: { connections: [] } },
    ])
  );
  assert.doesNotThrow(() =>
    validateOperations([
      { opId: "bulk-2", type: "doc.replace", payload: { doc: { title: largeTitle, cards: [] } } },
    ])
  );
  assert.throws(
    () =>
      validateOperations([
        { opId: "bulk-3", type: "card.update", payload: { id: "n1", patch: { text: largeTitle } } },
      ]),
    /too large/
  );
  const oversized = "x".repeat(4 * 1024 * 1024 + 16);
  assert.throws(
    () =>
      validateOperations([
        { opId: "bulk-4", type: "doc.replace", payload: { doc: { title: oversized, cards: [] } } },
      ]),
    /too large/
  );
});

test("invalid operations are rejected before applying", () => {
  assert.throws(() => validateOperations([]), OpError);
  assert.throws(
    () => validateOperations([{ opId: "a", type: "unknown", payload: {} }]),
    /unsupported operation type/
  );
  assert.throws(
    () => validateOperations([
      { opId: "a", type: "doc.title", payload: { title: "x" } },
      { opId: "a", type: "doc.title", payload: { title: "y" } },
    ]),
    /duplicate opId/
  );
  assert.throws(
    () => applyOperation({ cards: [] }, { type: "card.delete", payload: { id: "missing" } }),
    /not found/
  );
});
