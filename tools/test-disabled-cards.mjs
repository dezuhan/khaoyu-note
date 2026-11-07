// Node checks for temporarily disabled card types. Run with: node tools/test-disabled-cards.mjs
import assert from "node:assert/strict";

const model = await import("../app/web/js/model.js");
const limits = await import("../app/web/js/limits.js");

assert.equal(limits.isTemporarilyDisabledType("audio"), true);
assert.equal(limits.isTemporarilyDisabledType("video"), true);
assert.equal(limits.isTemporarilyDisabledType("map"), true);
assert.equal(limits.isTemporarilyDisabledType("note"), false);

// The welcome template must not seed a disabled card type or a dangling connection.
const welcome = model.welcomeBoard();
const welcomeTypes = new Set(welcome.cards.map((card) => card.type));
for (const type of ["audio", "video", "map"]) {
  assert.equal(welcomeTypes.has(type), false, `welcome board must not contain ${type}`);
}
const welcomeIds = new Set(welcome.cards.map((card) => card.id));
for (const connection of welcome.connections) {
  assert.ok(!connection.from || welcomeIds.has(connection.from));
  assert.ok(!connection.to || welcomeIds.has(connection.to));
}
assert.equal(model.visibleCards(welcome).length, welcome.cards.length);

// A hidden card is excluded from the visible list.
const board = {
  cards: [
    { id: "n1", type: "note" },
    { id: "a1", type: "audio" },
    { id: "v1", type: "video" },
    { id: "m1", type: "map" },
  ],
};
assert.deepEqual(
  model.visibleCards(board).map((card) => card.id),
  ["n1"]
);

// A hidden column child must not reserve layout space.
const makeColumn = () => ({
  id: "col",
  type: "column",
  x: 0,
  y: 0,
  w: 300,
  h: 0,
  minHeight: 160,
  collapsed: false,
});
const makeNote = () => ({
  id: "child-note",
  type: "note",
  parentId: "col",
  order: 0,
  x: 0,
  y: 0,
  w: 0,
  h: 70,
});
const makeHidden = () => ({
  id: "child-audio",
  type: "audio",
  parentId: "col",
  order: 1,
  x: 0,
  y: 0,
  w: 0,
  h: 44,
});

const withHiddenColumn = makeColumn();
const withHiddenNote = makeNote();
const withHiddenAudio = makeHidden();
const withHidden = { cards: [withHiddenColumn, withHiddenNote, withHiddenAudio] };
model.layoutColumn(withHidden, withHiddenColumn);
assert.equal(withHiddenNote.y, withHiddenColumn.y + 64);
assert.equal(withHiddenAudio.y, 0, "a hidden child must not be positioned");

const visibleOnlyColumn = makeColumn();
const visibleOnlyNote = makeNote();
const visibleOnly = { cards: [visibleOnlyColumn, visibleOnlyNote] };
model.layoutColumn(visibleOnly, visibleOnlyColumn);
assert.equal(withHiddenColumn.h, visibleOnlyColumn.h, "hidden children must not grow the column");
assert.equal(
  model.columnSummary(withHidden, withHiddenColumn),
  model.columnSummary(visibleOnly, visibleOnlyColumn)
);

console.log("PASS  disabled card types stay out of templates, boards, columns and previews");
