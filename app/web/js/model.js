// Pure data model: board documents, card factories, layout helpers.

import { colorNameForHex } from "./color-names.js";

export const uid = (prefix = "c") =>
  `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-3)}`;

export const CARD_SIZES = {
  note: [260, 70],
  heading: [300, 70],
  link: [260, 70],
  todo: [260, 70],
  document: [260, 70],
  comment: [280, 70],
  table: [340, 70],
  color: [260, 224],
  sketch: [260, 190],
  image: [260, 210],
  audio: [300, 70],
  video: [300, 70],
  map: [300, 70],
  file: [260, 70],
  board: [260, 70],
  column: [280, 220],
  kanban: [560, 500],
};

// Cards that cannot be resized vertically: they grow with their content and never below this height.
// The value matches the reference link card height.
export const MIN_CARD_H = 70;
export const AUDIO_CARD_H = 44;

export const AUTO_HEIGHT_TYPES = new Set([
  "note",
  "heading",
  "link",
  "todo",
  "document",
  "comment",
  "table",
  "audio",
  "video",
  "map",
  "file",
  "board",
]);

// Width driven types keep a fixed aspect ratio; only the width is user resizable.
export const CARD_ASPECTS = {
  image: 260 / 210,
  sketch: 260 / 190,
  color: 260 / 224,
};

export function cardHeightFor(card) {
  if (card.type === "column") return card.h;
  const aspect = card.aspect || CARD_ASPECTS[card.type];
  if (aspect) {
    const imageCaption = card.type === "image" ? 24 : 0;
    return Math.max(MIN_CARD_H, Math.round(card.w / aspect + imageCaption));
  }
  return Math.max(MIN_CARD_H, card.h || MIN_CARD_H);
}

export const MIN_SIZES = {
  note: [140, 60],
  heading: [140, 44],
  link: [160, 56],
  todo: [180, 90],
  document: [160, 72],
  comment: [200, 88],
  table: [220, 110],
  color: [160, 170],
  sketch: [140, 110],
  image: [120, 100],
  audio: [200, 76],
  video: [180, 120],
  map: [180, 120],
  file: [180, 66],
  board: [180, 90],
  column: [220, 120],
  kanban: [320, 500],
  drawing: [160, 100],
};

// Named swatches used by the Color card.
export const SWATCHES = [
  { name: "Amethyst", color: "#B262C0" },
  { name: "Indigo", color: "#5B6BC0" },
  { name: "Denim", color: "#5B8FBF" },
  { name: "Teal", color: "#4AA3A3" },
  { name: "Sage", color: "#7FA37A" },
  { name: "Sand", color: "#C9B18C" },
  { name: "Amber", color: "#D6A445" },
  { name: "Coral", color: "#D9705F" },
  { name: "Rose", color: "#C25F7F" },
  { name: "Slate", color: "#6D7480" },
];

export function defaultContent(type) {
  switch (type) {
    case "note":
      return { text: "" };
    case "heading":
      return { text: "Heading" };
    case "link":
      return { url: "", title: "", description: "" };
    case "todo":
      return { title: "", items: [] };
    case "document":
      return { title: "Document", text: "" };
    case "comment":
      return { messages: [] };
    case "table":
      return {
        cells: [
          ["", "", ""],
          ["", "", ""],
          ["", "", ""],
        ],
      };
    case "color":
      return { color: SWATCHES[0].color, name: colorNameForHex(SWATCHES[0].color) };
    case "sketch":
      return { strokes: [] };
    case "drawing":
      return { points: [], strokeWidth: 3 };
    case "image":
      return { src: "", caption: "" };
    case "audio":
      return { url: "", name: "" };
    case "video":
      return { url: "" };
    case "map":
      return { query: "" };
    case "file":
      return { name: "", path: "" };
    case "board":
      return { boardId: "", title: "Board" };
    case "column":
      return { title: "Column" };
    case "kanban":
      return {
        title: "Kanban",
        columns: [
          { id: uid("k"), title: "Backlog", items: [] },
          { id: uid("k"), title: "In progress", items: [] },
          { id: uid("k"), title: "Done", items: [] },
        ],
      };
    default:
      return {};
  }
}

export function createCard(type, x, y, extra = {}) {
  const [w, h] = CARD_SIZES[type] || [240, MIN_CARD_H];
  const aspect = CARD_ASPECTS[type];
  const minimum = type === "audio" ? AUDIO_CARD_H : MIN_CARD_H;
  const height = aspect ? Math.round(w / aspect) : minimum;
  return {
    id: uid(type),
    type,
    x: Math.round(x),
    y: Math.round(y),
    w,
    h: height,
    z: 1,
    parentId: null,
    order: 0,
    ...defaultContent(type),
    ...extra,
  };
}

export function newBoardDoc(title = "Untitled board", parentId = null) {
  return {
    id: uid("b"),
    title,
    parentId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    grid: 24,
    showGrid: true,
    view: { x: 0, y: 0, zoom: 1 },
    cards: [],
    connections: [],
    trash: [],
  };
}

export function maxZ(board) {
  return board.cards.reduce((max, card) => Math.max(max, card.z || 1), 0);
}

export function getCard(board, id) {
  return board.cards.find((card) => card.id === id) || null;
}

export function columnChildren(board, columnId) {
  return board.cards
    .filter((card) => card.parentId === columnId)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

export function columnSummary(board, column) {
  const children = columnChildren(board, column.id);
  if (!children.length) return "0 cards";
  const docs = children.filter((card) => card.type === "document").length;
  const rest = children.length - docs;
  const cardsWord = `${rest} card${rest === 1 ? "" : "s"}`;
  const docWord = docs ? `${docs} document${docs === 1 ? "" : "s"}` : "";
  return docWord ? `${cardsWord}, ${docWord}` : cardsWord;
}

// Position column children and grow the column to fit them.
export function layoutColumn(board, column) {
  const padding = 14;
  const gap = 10;
  const header = 64;
  if (column.collapsed) {
    column.h = Math.max(column.minHeight || 96, 96);
    return;
  }
  const children = columnChildren(board, column.id);
  let y = column.y + header;
  for (const child of children) {
    child.x = column.x + padding;
    child.y = y;
    child.w = column.w - padding * 2;
    const minimum = child.type === "audio" ? AUDIO_CARD_H : 56;
    if (child.h < minimum) child.h = minimum;
    y += child.h + gap;
  }
  column.h = Math.max(column.minHeight || 160, y - column.y - gap + padding);
}

export function layoutColumns(board) {
  if (!board) return;
  const columns = board.cards.filter((card) => card.type === "column");
  for (const column of columns) layoutColumn(board, column);
}

export const TYPE_LABELS = {
  note: "Note",
  heading: "Heading",
  link: "Link",
  todo: "To-do",
  document: "Document",
  comment: "Comment",
  table: "Table",
  color: "Color",
  sketch: "Sketch",
  image: "Image",
  audio: "Audio",
  video: "Video",
  map: "Map",
  file: "File",
  board: "Board",
  column: "Column",
  kanban: "Kanban",
  drawing: "Drawing",
};

export function welcomeBoard() {
  const board = newBoardDoc("Home");
  const add = (card) => {
    card.z = board.cards.length + 1;
    board.cards.push(card);
    return card;
  };

  const heading = add(createCard("heading", 180, 120, { text: "Welcome to your board" }));
  heading.w = 380;

  const note = add(
    createCard("note", 180, 220, {
      text:
        "Double-click a card to edit it.\nDrag cards to move them, drag the corner to resize.\nEverything is stored locally on this machine.",
    })
  );
  note.w = 380;
  note.h = 140;

  add(
    createCard("todo", 180, 390, {
      title: "Try it out",
      items: [
        { id: uid("i"), text: "Add a card from the left rail", done: false },
        { id: uid("i"), text: "Drag this card somewhere", done: false },
        { id: uid("i"), text: "Press Ctrl+Z to undo", done: false },
      ],
    })
  );

  add(createCard("link", 180, 590, { url: "https://example.com", title: "Example link" }));

  add(createCard("color", 620, 120, { color: "#B262C0", name: colorNameForHex("#B262C0") }));

  const comment = add(createCard("comment", 620, 380, {
    messages: [
      { id: uid("m"), author: "You", text: "Comments live on cards like this.", done: false },
      { id: uid("m"), author: "You", text: "Tick the checkbox when a comment is done.", done: true },
    ],
  }));
  comment.h = 140;

  const column = add(createCard("column", 920, 120, { title: "Column" }));
  column.h = 220;

  const childNote = add(
    createCard("note", 934, 184, { text: "Cards can live inside a column. Drag one in or out.", parentId: column.id, order: 0 })
  );
  childNote.h = 90;

  const childTodo = add(
    createCard("todo", 934, 284, { title: "", items: [{ id: uid("i"), text: "A column item", done: false }], parentId: column.id, order: 1 })
  );
  childTodo.h = 90;

  add(
    createCard("document", 620, 560, {
      title: "Document",
      text: "Longer form writing lives in a document card. The word count is shown at the bottom.",
    })
  );

  add(
    createCard("table", 620, 760, {
      cells: [
        ["Task", "Owner", "Status"],
        ["Storyboard", "You", "Doing"],
        ["Moodboard", "You", "Done"],
      ],
    })
  );

  add(createCard("sketch", 920, 560, { strokes: [] }));

  const showcaseHeading = add(
    createCard("heading", 180, 960, { text: "Every card type" })
  );
  showcaseHeading.w = 380;

  const showcaseNote = add(
    createCard("note", 180, 1040, {
      text:
        "All the tools from the left rail are represented on this board.\nScroll down and right to try the media cards, the kanban board and the nested board.",
    })
  );
  showcaseNote.w = 380;
  showcaseNote.h = 120;

  const sampleSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="520" height="420" viewBox="0 0 520 420"><rect width="520" height="420" fill="#f4f1ea"/><rect x="52" y="52" width="416" height="316" rx="28" fill="#b262c0"/><circle cx="176" cy="196" r="54" fill="#f4f1ea"/><rect x="258" y="168" width="152" height="18" rx="9" fill="#f4f1ea"/><rect x="258" y="204" width="112" height="18" rx="9" fill="#f4f1ea"/><rect x="52" y="388" width="60" height="8" rx="4" fill="#17171a"/></svg>';
  add(
    createCard("image", 620, 960, {
      src: `data:image/svg+xml,${encodeURIComponent(sampleSvg)}`,
      caption: "Image card",
    })
  );

  add(createCard("video", 920, 960, { url: "" }));
  add(createCard("audio", 1260, 960, { url: "", name: "" }));
  add(createCard("map", 1580, 960, { query: "" }));
  add(createCard("file", 1900, 960, { name: "Brand-assets.zip", path: "" }));
  add(createCard("board", 2200, 960, { title: "Examples board" }));

  add(
    createCard("kanban", 620, 1260, {
      title: "Kanban",
      columns: [
        { id: uid("k"), title: "Backlog", items: [
          { id: uid("i"), text: "Collect references" },
          { id: uid("i"), text: "Write outline" },
        ] },
        { id: uid("k"), title: "In progress", items: [{ id: uid("i"), text: "Design cover" }] },
        { id: uid("k"), title: "Done", items: [{ id: uid("i"), text: "Set up the board" }] },
      ],
    })
  );

  const welcomeSketch = add(
    createCard("sketch", 1300, 1260, {
      strokes: [
        {
          tool: "pen",
          color: "#17171a",
          w: 0.008,
          points: [
            { x: 0.18, y: 0.58 },
            { x: 0.3, y: 0.3 },
            { x: 0.44, y: 0.5 },
            { x: 0.58, y: 0.28 },
            { x: 0.72, y: 0.52 },
            { x: 0.84, y: 0.36 },
          ],
        },
        {
          tool: "highlighter",
          color: "#b262c0",
          w: 0.03,
          a: 0.35,
          points: [
            { x: 0.2, y: 0.74 },
            { x: 0.8, y: 0.74 },
          ],
        },
      ],
    })
  );
  welcomeSketch.w = 260;

  board.connections.push({ id: uid("conn"), from: heading.id, to: note.id });
  board.connections.push({ id: uid("conn"), from: showcaseHeading.id, to: showcaseNote.id });

  layoutColumns(board);
  board.view = { x: 40, y: -40, zoom: 0.9 };
  return board;
}
