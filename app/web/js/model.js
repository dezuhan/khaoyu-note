// Pure data model: board documents, card factories, layout helpers.

import { colorNameForHex } from "./color-names.js";
import { isTemporarilyDisabledType } from "./limits.js";

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
  section: [620, 420],
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
  if (card.type === "image" && card.imageCrop) {
    const crop = card.imageCrop;
    const ratio = (crop.w / crop.h) * (crop.ratio || 1);
    if (Number.isFinite(ratio) && ratio > 0) {
      return Math.max(MIN_CARD_H, Math.round(card.w / ratio) + 24);
    }
  }
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
  section: [260, 160],
  drawing: [160, 100],
};

// Pastel section backgrounds. Section cards are visual wrappers: they sit below every other card
// and never become a parent, unlike a column.
export const SECTION_COLORS = [
  { name: "Rose", color: "#F8D7DA" },
  { name: "Peach", color: "#FCE4D6" },
  { name: "Butter", color: "#FFF2CC" },
  { name: "Mint", color: "#D9EAD3" },
  { name: "Sky", color: "#DDEBF7" },
  { name: "Lavender", color: "#E4DFEC" },
  { name: "Sand", color: "#F4E7D3" },
  { name: "Mist", color: "#E7E6E6" },
];

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
    case "section":
      return { title: "Section", sectionColor: SECTION_COLORS[0].color };
    default:
      return {};
  }
}

export function createCard(type, x, y, extra = {}) {
  const [w, h] = CARD_SIZES[type] || [240, MIN_CARD_H];
  const aspect = CARD_ASPECTS[type];
  const minimum = type === "audio" ? AUDIO_CARD_H : MIN_CARD_H;
  const height = type === "section" ? h : aspect ? Math.round(w / aspect) : minimum;
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
    snapToGrid: false,
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

// Cards that the app currently shows. Temporarily disabled card types stay in the document so no
// data is lost, but they are not rendered and do not reserve space until the feature returns.
export function visibleCards(board) {
  return (board?.cards || []).filter((card) => !isTemporarilyDisabledType(card.type));
}

export function columnChildren(board, columnId) {
  return board.cards
    .filter((card) => card.parentId === columnId)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

export function columnSummary(board, column) {
  const children = columnChildren(board, column.id).filter(
    (card) => !isTemporarilyDisabledType(card.type)
  );
  if (!children.length) return column.direction === "row" ? "0 columns" : "0 cards";
  if (column.direction === "row" && children.every((card) => card.type === "column")) {
    return `${children.length} column${children.length === 1 ? "" : "s"}`;
  }
  const docs = children.filter((card) => card.type === "document").length;
  const rest = children.length - docs;
  const cardsWord = `${rest} card${rest === 1 ? "" : "s"}`;
  const docWord = docs ? `${docs} document${docs === 1 ? "" : "s"}` : "";
  return docWord ? `${cardsWord}, ${docWord}` : cardsWord;
}

// Position column children and grow the column to fit them. A row is the same container with its
// children laid out horizontally, so a column can be converted back and forth without losing cards.
function columnContentChildren(board, column) {
  return columnChildren(board, column.id).filter(
    (card) => !isTemporarilyDisabledType(card.type)
  );
}

// Natural content width/height, used by the fit action and tests. Containers are always laid out at
// this size; legacy `extraWidth`/`extraHeight` values are ignored.
export function columnContentWidth(board, column) {
  const children = columnContentChildren(board, column);
  if (!children.length) return 0;
  return 28 + children.reduce((sum, child) => sum + (Number(child.w) || 120), 0) + 10 * (children.length - 1);
}

export function columnContentHeight(board, column) {
  const children = columnContentChildren(board, column);
  if (!children.length) return Math.max(column.minHeight || 160, 160);
  if (column.direction === "row") {
    return Math.max(column.minHeight || 160, 64 + Math.max(...children.map((child) => Number(child.h) || 56)) + 14);
  }
  return Math.max(
    column.minHeight || 160,
    64 + children.reduce((sum, child) => sum + (Number(child.h) || 56), 0) + 10 * (children.length - 1) + 14
  );
}

// Containers always take the size their children need. A vertical column lets its width drive the
// child width; a row derives its width from the scaled child widths. `extraWidth`/`extraHeight`/
// `fitChildren` from older boards are intentionally ignored so no empty stretch space survives.
export function layoutColumn(board, column) {
  const padding = 14;
  const gap = 10;
  const header = 64;
  if (column.collapsed) {
    column.h = Math.max(column.minHeight || 96, 96);
    return;
  }
  const children = columnChildren(board, column.id).filter(
    (card) => !isTemporarilyDisabledType(card.type)
  );
  if (!children.length) {
    column.h = Math.max(column.minHeight || 160, 160);
    return;
  }
  if (column.direction === "row") {
    let x = column.x + padding;
    let maxH = 0;
    for (const child of children) {
      child.x = x;
      child.y = column.y + header;
      child.w = Math.max(120, Number(child.w) || 120);
      if (child.type === "column") {
        layoutColumn(board, child);
      } else {
        if (CARD_ASPECTS[child.type] || child.aspect) child.h = cardHeightFor(child);
        const minimum = child.type === "audio" ? AUDIO_CARD_H : 56;
        if (child.h < minimum) child.h = minimum;
      }
      x += child.w + gap;
      maxH = Math.max(maxH, child.h);
    }
    column.w = Math.max(160, padding * 2 + children.reduce((sum, child) => sum + child.w, 0) + gap * (children.length - 1));
    column.h = header + maxH + padding;
    return;
  }
  let y = column.y + header;
  for (const child of children) {
    child.x = column.x + padding;
    child.y = y;
    child.w = Math.max(120, column.w - padding * 2);
    if (child.type === "column") {
      layoutColumn(board, child);
    } else {
      if (CARD_ASPECTS[child.type] || child.aspect) child.h = cardHeightFor(child);
      const minimum = child.type === "audio" ? AUDIO_CARD_H : 56;
      if (child.h < minimum) child.h = minimum;
    }
    y += child.h + gap;
  }
  column.h = y - column.y - gap + padding;
}

export function layoutColumns(board) {
  if (!board) return;
  const columns = board.cards.filter((card) => card.type === "column");
  const ids = new Set(columns.map((column) => column.id));
  for (const column of columns) {
    if (!column.parentId || !ids.has(column.parentId)) layoutColumn(board, column);
  }
}

// Migrate the removed kanban card type into a row of columns, one column per former lane. Each
// former item becomes a note card inside that column so no text is lost.
export function migrateLegacyKanban(board) {
  if (!board?.cards?.some((card) => card.type === "kanban")) return false;
  const cards = [];
  for (const card of board.cards) {
    if (card.type !== "kanban") {
      cards.push(card);
      continue;
    }
    const parent = createCard("column", card.x, card.y, {
      title: card.title || "Kanban",
      direction: "row",
      kanban: true,
    });
    parent.id = card.id;
    parent.w = card.w || 760;
    parent.h = card.h || 360;
    parent.z = card.z || 1;
    parent.parentId = card.parentId || null;
    parent.order = card.order || 0;
    cards.push(parent);
    const lanes = Array.isArray(card.columns) ? card.columns : [];
    lanes.forEach((lane, laneIndex) => {
      const column = createCard("column", parent.x, parent.y, {
        title: lane.title || "Column",
      });
      column.parentId = parent.id;
      column.order = laneIndex;
      column.w = Math.max(180, Math.round((parent.w - 28 - 10 * Math.max(0, lanes.length - 1)) / Math.max(1, lanes.length)));
      cards.push(column);
      (lane.items || []).forEach((item, itemIndex) => {
        const note = createCard("note", column.x, column.y, {
          text: item.text || "",
        });
        note.parentId = column.id;
        note.order = itemIndex;
        note.w = Math.max(120, column.w - 24);
        cards.push(note);
      });
    });
  }
  board.cards = cards;
  layoutColumns(board);
  return true;
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
  section: "Section",
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
    createCard("heading", 180, 960, { text: "Enabled card types" })
  );
  showcaseHeading.w = 380;

  const showcaseNote = add(
    createCard("note", 180, 1040, {
      text:
        "All the enabled tools from the left rail are represented on this board.\nScroll down and right to try the nested board.",
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

  add(createCard("file", 920, 960, { name: "Brand-assets.zip", path: "" }));
  add(createCard("board", 1260, 960, { title: "Examples board" }));

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

  board.cards = visibleCards(board);
  const visibleIds = new Set(board.cards.map((card) => card.id));
  board.connections = board.connections.filter(
    (connection) =>
      (!connection.from || visibleIds.has(connection.from)) &&
      (!connection.to || visibleIds.has(connection.to))
  );

  layoutColumns(board);
  board.view = { x: 40, y: -40, zoom: 0.9 };
  return board;
}
