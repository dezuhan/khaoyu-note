import assert from "node:assert/strict";
import test from "node:test";
import { OpError, applyOperation, validateOperations } from "../src/collab-ops.mjs";

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
