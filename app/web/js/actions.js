// High-level board actions shared by the UI and the interaction layer.

import * as bridge from "./bridge.js";
import { isBlockedUpload, isTemporarilyDisabledType, MAX_UPLOAD_BYTES, reportUploadProblem } from "./limits.js";
import { refreshCard } from "./render.js";
import { createCard, columnChildren, getCard, layoutColumns, maxZ, newBoardDoc, uid } from "./model.js";
import {
  checkpoint,
  markDirty,
  openBoard,
  refreshBoards,
  saveNow,
  setSelection,
  state,
} from "./store.js";

export function viewportCenterWorld() {
  const viewport = document.getElementById("viewport");
  const rect = viewport.getBoundingClientRect();
  return {
    x: (rect.width / 2 - state.view.x) / state.view.zoom,
    y: (rect.height / 2 - state.view.y) / state.view.zoom,
  };
}

export function addCard(type, x, y, extra = {}) {
  if (!state.board) return null;
  checkpoint();
  const card = createCard(type, x, y, extra);
  card.z = maxZ(state.board) + 1;
  state.board.cards.push(card);
  setSelection([card.id]);
  markDirty("board");
  return card;
}

function overlapsExisting(x, y, w, h) {
  const pad = 18;
  return state.board.cards.some(
    (card) =>
      x < card.x + card.w + pad &&
      x + w + pad > card.x &&
      y < card.y + card.h + pad &&
      y + h + pad > card.y
  );
}

function visibleWorldRect() {
  const viewport = document.getElementById("viewport");
  const rect = viewport.getBoundingClientRect();
  const zoom = state.view.zoom || 1;
  return {
    x: -state.view.x / zoom,
    y: -state.view.y / zoom,
    w: rect.width / zoom,
    h: rect.height / zoom,
  };
}

function insideView(x, y, w, h) {
  const view = visibleWorldRect();
  const margin = 10;
  return (
    x >= view.x + margin &&
    y >= view.y + margin &&
    x + w <= view.x + view.w - margin &&
    y + h <= view.y + view.h - margin
  );
}

// Find a spot near the viewport centre that is visible and does not stack on an existing card.
export function freeSpot(w, h) {
  const center = viewportCenterWorld();
  const start = { x: center.x - w / 2, y: center.y - h / 2 };
  if (!overlapsExisting(start.x, start.y, w, h) && insideView(start.x, start.y, w, h)) return start;
  const stepX = 320;
  const stepY = 230;
  const offsets = [];
  for (let ring = 1; ring <= 6; ring += 1) {
    for (const [dx, dy] of [
      [ring, 0],
      [0, ring],
      [-ring, 0],
      [0, -ring],
      [ring, ring],
      [-ring, ring],
      [ring, -ring],
      [-ring, -ring],
    ]) {
      offsets.push([dx, dy]);
    }
  }
  for (const [dx, dy] of offsets) {
    const x = start.x + dx * stepX;
    const y = start.y + dy * stepY;
    if (overlapsExisting(x, y, w, h) || !insideView(x, y, w, h)) continue;
    return { x, y };
  }
  return start;
}

export function addCardAtCenter(type, extra = {}) {
  const probe = createCard(type, 0, 0, extra);
  const spot = freeSpot(probe.w, probe.h);
  return addCard(type, spot.x, spot.y, extra);
}

export function addCardAt(type, worldPoint, extra = {}) {
  return addCard(type, worldPoint.x - 40, worldPoint.y - 30, extra);
}

export function canWrapInColumn(ids = []) {
  if (!state.board || !Array.isArray(ids) || ids.length < 2) return false;
  return ids.every((id) => {
    const card = getCard(state.board, id);
    return card && card.type !== "column" && card.type !== "section" && !card.locked;
  });
}

// Wrap the selected cards in a new column, keeping their top-to-bottom order.
export function wrapInColumn(ids) {
  if (!state.board || !canWrapInColumn(ids)) return null;  const cards = ids.map((id) => getCard(state.board, id)).filter(Boolean);
  checkpoint();
  const minX = Math.min(...cards.map((card) => card.x));
  const minY = Math.min(...cards.map((card) => card.y));
  const maxX = Math.max(...cards.map((card) => card.x + card.w));
  const column = createCard("column", minX, minY, { title: "Column" });
  column.w = Math.max(260, Math.round(maxX - minX) + 28);
  column.z = maxZ(state.board) + 1;
  state.board.cards.push(column);
  cards.sort((a, b) => a.y - b.y || a.x - b.x);
  cards.forEach((card, index) => {
    card.parentId = column.id;
    card.order = index;
  });
  layoutColumns(state.board);
  setSelection([column.id]);
  markDirty("board");
  return column;
}

// Wrap the current selection in a Section sized to its bounding box. A Section is a visual wrapper,
// not a parent: the selected cards keep their coordinates and stay above it.
// Remove a column/row/kanban container while keeping its direct children on the board. The
// children keep their current coordinates, size and own contents; only the wrapper disappears.
export function canReleaseContainer(cardId) {
  const card = state.board ? getCard(state.board, cardId) : null;
  return Boolean(card && card.type === "column" && !card.locked);
}

export function releaseContainer(cardId) {
  if (!canReleaseContainer(cardId)) return 0;
  const container = getCard(state.board, cardId);
  const children = columnChildren(state.board, container.id).filter(
    (card) => !isTemporarilyDisabledType(card.type)
  );
  checkpoint();
  let z = maxZ(state.board);
  for (const child of children) {
    child.parentId = null;
    child.order = 0;
    child.z = ++z;
  }
  state.board.cards = state.board.cards.filter((card) => card.id !== container.id);
  state.board.connections = (state.board.connections || []).filter(
    (connection) => connection.from !== container.id && connection.to !== container.id
  );
  setSelection(children.map((child) => child.id));
  markDirty("board");
  return children.length;
}

export function canWrapInSection(ids = []) {
  if (!state.board || !Array.isArray(ids) || !ids.length) return false;
  return ids.every((id) => {
    const card = getCard(state.board, id);
    return card && card.type !== "section";
  });
}

export function wrapInSection(ids) {
  if (!canWrapInSection(ids)) return null;
  checkpoint();
  const cards = ids.map((id) => getCard(state.board, id)).filter(Boolean);
  const minX = Math.min(...cards.map((card) => card.x));
  const minY = Math.min(...cards.map((card) => card.y));
  const maxX = Math.max(...cards.map((card) => card.x + card.w));
  const maxY = Math.max(...cards.map((card) => card.y + card.h));
  const padding = 20;
  const header = 44;
  const section = createCard("section", minX - padding, minY - header, {
    title: "Section",
  });
  section.w = Math.max(220, Math.round(maxX - minX) + padding * 2);
  section.h = Math.max(120, Math.round(maxY - minY) + header + padding);
  section.z = Math.max(1, Math.min(...cards.map((card) => card.z || 1)) - 1);
  state.board.cards.push(section);
  setSelection([section.id]);
  markDirty("board");
  return section;
}

// A kanban is a row of columns. The former kanban card type is gone; the user selects at least
// two top-level columns and wraps them into a row container.
function selectedColumns(ids = []) {
  return ids
    .map((id) => getCard(state.board, id))
    .filter((card) => card && card.type === "column");
}

export function canWrapInKanban(ids = []) {
  if (!state.board || !Array.isArray(ids) || ids.length < 2) return false;
  return ids.every((id) => {
    const card = getCard(state.board, id);
    return (
      card &&
      card.type === "column" &&
      !card.locked &&
      card.direction !== "row"
    );
  });
}

export function wrapInKanban(ids) {
  if (!canWrapInKanban(ids)) return null;
  checkpoint();
  const columns = ids
    .map((id) => getCard(state.board, id))
    .filter(Boolean)
    .sort((a, b) => a.x - b.x || a.y - b.y);
  const minX = Math.min(...columns.map((column) => column.x));
  const minY = Math.min(...columns.map((column) => column.y));
  const maxX = Math.max(...columns.map((column) => column.x + column.w));
  const maxY = Math.max(...columns.map((column) => column.y + column.h));
  const kanban = createCard("column", minX, minY, {
    title: "Kanban",
    direction: "row",
    kanban: true,
  });
  kanban.w = Math.max(360, Math.round(maxX - minX) + 28);
  kanban.h = Math.max(220, Math.round(maxY - minY) + 28);
  kanban.z = maxZ(state.board) + 1;
  state.board.cards.push(kanban);
  columns.forEach((column, index) => {
    column.parentId = kanban.id;
    column.order = index;
  });
  layoutColumns(state.board);
  setSelection([kanban.id]);
  markDirty("board");
  return kanban;
}

function boardTrash() {
  if (!state.board) return [];
  if (!Array.isArray(state.board.trash)) state.board.trash = [];
  return state.board.trash;
}

export function moveCardsToTrash(ids) {
  if (!state.board || !ids.length) return 0;
  checkpoint();
  const remove = new Set(ids);
  for (const card of state.board.cards) {
    if (card.type === "column" && remove.has(card.id)) {
      for (const child of state.board.cards) {
        if (child.parentId === card.id) remove.add(child.id);
      }
    }
  }
  const handled = new Set();
  const entries = [];
  for (const card of state.board.cards) {
    if (!remove.has(card.id) || handled.has(card.id)) continue;
    const group =
      card.type === "column"
        ? [card, ...state.board.cards.filter((child) => child.parentId === card.id)]
        : [card];
    group.forEach((item) => handled.add(item.id));
    const groupIds = new Set(group.map((item) => item.id));
    const connections = (state.board.connections || []).filter(
      (connection) => groupIds.has(connection.from) || groupIds.has(connection.to)
    );
    entries.push({
      id: uid("trash"),
      deletedAt: Date.now(),
      cards: JSON.parse(JSON.stringify(group)),
      connections: JSON.parse(JSON.stringify(connections)),
    });
  }
  if (!entries.length) return 0;
  boardTrash().unshift(...entries);
  state.board.cards = state.board.cards.filter((card) => !remove.has(card.id));
  state.board.connections = (state.board.connections || []).filter(
    (connection) => !remove.has(connection.from) && !remove.has(connection.to)
  );
  state.selection = new Set();
  state.connectionSelection = null;
  markDirty("board");
  return entries.length;
}

export function restoreTrashEntry(entryId) {
  if (!state.board) return false;
  const entries = boardTrash();
  const entry = entries.find((item) => item.id === entryId);
  if (!entry) return false;
  checkpoint();
  const existing = new Set(state.board.cards.map((card) => card.id));
  const restored = (entry.cards || []).filter((card) => !existing.has(card.id));
  const restoredIds = new Set(restored.map((card) => card.id));
  for (const card of restored) {
    if (card.parentId && !restoredIds.has(card.parentId) && !existing.has(card.parentId)) {
      card.parentId = null;
    }
    state.board.cards.push(card);
  }
  const allIds = new Set(state.board.cards.map((card) => card.id));
  const connections = (entry.connections || []).filter(
    (connection) => allIds.has(connection.from) && allIds.has(connection.to)
  );
  state.board.connections = [...(state.board.connections || []), ...connections];
  state.board.trash = entries.filter((item) => item.id !== entryId);
  layoutColumns(state.board);
  markDirty("board");
  return true;
}

export function deleteTrashEntry(entryId) {
  if (!state.board) return false;
  const entries = boardTrash();
  if (!entries.some((item) => item.id === entryId)) return false;
  checkpoint();
  state.board.trash = entries.filter((item) => item.id !== entryId);
  markDirty("board");
  return true;
}

export function emptyTrashEntries() {
  if (!state.board) return 0;
  const entries = boardTrash();
  if (!entries.length) return 0;
  checkpoint();
  const count = entries.length;
  state.board.trash = [];
  markDirty("board");
  return count;
}

export function deleteCards(ids, { trash = true } = {}) {
  if (!state.board || !ids.length) return;
  if (trash) {
    moveCardsToTrash(ids);
    return;
  }
  checkpoint();
  const remove = new Set(ids);
  for (const card of state.board.cards) {
    if (card.type === "column" && remove.has(card.id)) {
      for (const child of state.board.cards) {
        if (child.parentId === card.id) remove.add(child.id);
      }
    }
  }
  state.board.cards = state.board.cards.filter((card) => !remove.has(card.id));
  state.board.connections = (state.board.connections || []).filter(
    (connection) => !remove.has(connection.from) && !remove.has(connection.to)
  );
  state.selection = new Set();
  markDirty("board");
}

export function deleteSelected() {
  if (state.connectionSelection) {
    const id = state.connectionSelection;
    checkpoint();
    state.board.connections = (state.board.connections || []).filter(
      (connection) => connection.id !== id
    );
    state.connectionSelection = null;
    markDirty("board");
    return;
  }
  deleteCards([...state.selection]);
}

function selectionGraph(ids) {
  const selected = new Set(ids);
  const hasSelectedAncestor = (card) => {
    let parentId = card.parentId;
    while (parentId) {
      if (selected.has(parentId)) return true;
      parentId = getCard(state.board, parentId)?.parentId;
    }
    return false;
  };
  const roots = ids.filter((id) => {
    const card = getCard(state.board, id);
    return card && !hasSelectedAncestor(card);
  });
  const included = new Set(roots);
  const addChildren = (columnId) => {
    for (const child of columnChildren(state.board, columnId)) {
      if (included.has(child.id)) continue;
      included.add(child.id);
      if (child.type === "column") addChildren(child.id);
    }
  };
  for (const id of roots) {
    const card = getCard(state.board, id);
    if (card?.type === "column") addChildren(id);
  }
  return {
    roots,
    cards: state.board.cards
      .filter((card) => included.has(card.id))
      .map((card) => JSON.parse(JSON.stringify(card))),
  };
}

// Capture the current selection as a reusable template payload. The graph keeps column
// descendants and connections whose two endpoints are both selected.
export function captureSelectionForTemplate(ids = []) {
  if (!state.board || !ids.length) return null;
  const graph = selectionGraph(ids);
  if (!graph.cards.length) return null;
  const roots = new Set(graph.roots);
  for (const card of graph.cards) {
    if (roots.has(card.id)) card.parentId = null;
  }
  const included = new Set(graph.cards.map((card) => card.id));
  const connections = (state.board.connections || [])
    .filter((connection) => included.has(connection.from) && included.has(connection.to))
    .map((connection) => JSON.parse(JSON.stringify(connection)));
  return { cards: graph.cards, connections };
}

function graphBounds(graph) {
  const roots = graph.roots
    .map((id) => graph.cards.find((card) => card.id === id))
    .filter(Boolean);
  if (!roots.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return {
    minX: Math.min(...roots.map((card) => card.x)),
    minY: Math.min(...roots.map((card) => card.y)),
    maxX: Math.max(...roots.map((card) => card.x + card.w)),
    maxY: Math.max(...roots.map((card) => card.y + card.h)),
  };
}

function besideOffset(graph, gap = 32) {
  const bounds = graphBounds(graph);
  return {
    x: Math.max(gap, Math.round(bounds.maxX - bounds.minX) + gap),
    y: 0,
  };
}

function cloneGraph(graph, offset) {
  const idMap = new Map();
  const copies = graph.cards.map((card) => {
    const clone = JSON.parse(JSON.stringify(card));
    clone.id = uid(clone.type);
    idMap.set(card.id, clone.id);
    return clone;
  });
  const roots = new Set(graph.roots.map((id) => idMap.get(id)));
  let z = maxZ(state.board);
  for (const copy of copies) {
    const isRoot = roots.has(copy.id);
    copy.parentId = isRoot ? null : idMap.get(copy.parentId) || null;
    if (isRoot) {
      copy.x += offset.x;
      copy.y += offset.y;
    }
    copy.z = ++z;
    state.board.cards.push(copy);
  }
  layoutColumns(state.board);
  return [...roots];
}

export function duplicateCards(ids) {
  if (!state.board || !ids.length) return 0;
  checkpoint();
  const graph = selectionGraph(ids);
  const copies = cloneGraph(graph, besideOffset(graph));
  if (copies.length) setSelection(copies);
  markDirty("board");
  return copies.length;
}

export function duplicateSelected() {
  duplicateCards([...state.selection]);
}

export function selectAllCards() {
  if (!state.board) return;
  setSelection(
    state.board.cards
      .filter((card) => !isTemporarilyDisabledType(card.type))
      .map((card) => card.id)
  );
}

export function bringToFront(card, ids = [card.id]) {
  if (!state.board) return;
  checkpoint();
  let z = maxZ(state.board);
  for (const id of ids) {
    const target = getCard(state.board, id);
    if (target && target.type !== "section") target.z = ++z;
  }
  markDirty("board");
}

export function sendToBack(card, ids = [card.id]) {
  if (!state.board) return;
  checkpoint();
  const min = Math.min(...state.board.cards.map((item) => item.z || 1));
  let z = min - 1;
  for (const id of ids) {
    const target = getCard(state.board, id);
    if (target && target.type !== "section") target.z = z--;
  }
  markDirty("board");
}

export function setTool(tool) {
  state.tool = tool;
  state.lineFrom = null;
  markDirty("save");
}

export function updateCard(id, patch, kind = "board") {
  const card = getCard(state.board, id);
  if (!card) return;
  Object.assign(card, patch);
  markDirty(kind);
}

export function openLink(url) {
  if (!url) return;
  let target = url;
  if (!/^https?:\/\//i.test(target)) target = "https://" + target;
  bridge.openExternal(target).catch(() => {
    window.open(target, "_blank");
  });
  return null;
}

function uploadAllowed(file) {
  if (!file) return false;
  if (isBlockedUpload(file.name || "")) {
    reportUploadProblem("This file type is not allowed.");
    return false;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    reportUploadProblem("File is larger than the 100 MB limit.");
    return false;
  }
  return true;
}

async function optimizedImage(file) {
  if (!file.type.startsWith("image/") || file.type === "image/gif" || file.type === "image/svg+xml") {
    return file;
  }
  if (file.size < 1.5 * 1024 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, ".webp"), { type: "image/webp" });
  } catch {
    return file;
  }
}

export async function attachImage(cardId, file) {
  const card = getCard(state.board, cardId);
  if (!card || !uploadAllowed(file)) return;
  try {
    const upload = await optimizedImage(file);
    const base64 = await bridge.readFileAsBase64(upload);
    const path = await bridge.storeAsset(upload.name || "image.png", base64);
    card.src = path;
    card.caption = card.caption || "";
    markDirty("board");
  } catch {
    reportUploadProblem("Could not store this image.");
  }
}

export function setCardsLocked(ids, locked) {
  if (!state.board) return;
  const cards = ids.map((id) => getCard(state.board, id)).filter(Boolean);
  if (!cards.length) return;
  checkpoint();
  for (const card of cards) card.locked = Boolean(locked);
  document.activeElement?.blur?.();
  markDirty("board");
}

export function setSectionPositionLocked(cardId, locked) {
  if (!state.board) return;
  const card = getCard(state.board, cardId);
  if (!card || card.type !== "section") return;
  checkpoint();
  card.positionLocked = Boolean(locked);
  markDirty("board");
}

export function fitColumnToContent(cardId) {
  if (!state.board) return false;
  const card = getCard(state.board, cardId);
  if (!card || card.type !== "column") return false;
  checkpoint();
  delete card.fitChildren;
  delete card.extraWidth;
  delete card.extraHeight;
  layoutColumns(state.board);
  markDirty("board");
  return true;
}

export function setColumnDirection(cardId, direction) {
  if (!state.board) return;
  const card = getCard(state.board, cardId);
  if (!card || card.type !== "column") return;
  checkpoint();
  delete card.fitChildren;
  delete card.extraWidth;
  delete card.extraHeight;
  card.direction = direction === "row" ? "row" : "column";
  if (card.direction === "row") {
    const count = columnChildren(state.board, card.id).length;
    card.w = Math.max(card.w, 28 + count * 220 + Math.max(0, count - 1) * 10);
  } else {
    delete card.kanban;
  }
  layoutColumns(state.board);
  markDirty("board");
}

function documentText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function convertNoteToDocument(id) {
  const card = getCard(state.board, id);
  if (!card || card.type !== "note" || card.locked) return false;
  const text = String(card.text || "").trim();
  const title = (text.split(/\n/).find((line) => line.trim()) || "Document").trim().slice(0, 80);
  checkpoint();
  const html = card.html
    ? card.html
    : text
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${documentText(paragraph).replace(/\n/g, "<br>")}</p>`)
        .join("");
  card.type = "document";
  card.title = title || "Document";
  card.text = text;
  card.html = html;
  markDirty("board");
  return true;
}

export async function convertColumnToBoard(id) {
  const column = getCard(state.board, id);
  if (!column || column.type !== "column" || column.locked) return false;
  const children = state.board.cards
    .filter((card) => card.parentId === column.id)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  const title = String(column.title || "Board").trim() || "Board";
  const doc = newBoardDoc(title, state.board.id);
  const idMap = new Map();
  doc.cards = children.map((child, index) => {
    const copy = JSON.parse(JSON.stringify(child));
    const nextId = uid(copy.type);
    idMap.set(child.id, nextId);
    copy.id = nextId;
    copy.parentId = null;
    copy.order = 0;
    copy.x = 36;
    copy.y = 56 + index * 96;
    copy.z = index + 1;
    return copy;
  });
  const childIds = new Set(children.map((child) => child.id));
  doc.connections = (state.board.connections || [])
    .filter((connection) => childIds.has(connection.from) && childIds.has(connection.to))
    .map((connection) => ({
      ...JSON.parse(JSON.stringify(connection)),
      from: idMap.get(connection.from),
      to: idMap.get(connection.to),
    }));
  try {
    await bridge.saveBoard(doc.id, JSON.stringify(doc), null);
  } catch {
    window.dispatchEvent(
      new CustomEvent("mn:toast", { detail: { message: "Could not create the board." } })
    );
    return false;
  }

  checkpoint();
  const removed = new Set([column.id, ...children.map((child) => child.id)]);
  state.board.cards = state.board.cards.filter((card) => !removed.has(card.id));
  state.board.connections = (state.board.connections || []).filter(
    (connection) => !removed.has(connection.from) && !removed.has(connection.to)
  );
  const boardCard = createCard("board", column.x, column.y, { boardId: doc.id, title: doc.title });
  boardCard.w = Math.max(260, column.w);
  boardCard.h = 70;
  boardCard.z = column.z || maxZ(state.board) + 1;
  state.board.cards.push(boardCard);
  setSelection([boardCard.id]);
  await refreshBoards();
  markDirty("board");
  return true;
}

export async function attachLinkHeader(cardId, file) {
  const card = getCard(state.board, cardId);
  if (!card || card.type !== "link" || card.locked || !uploadAllowed(file)) return;
  try {
    const upload = await optimizedImage(file);
    const base64 = await bridge.readFileAsBase64(upload);
    card.headerImage = await bridge.storeAsset(upload.name || "header.png", base64);
    markDirty("board");
  } catch {
    reportUploadProblem("Could not store this image.");
  }
}

export function removeLinkHeader(cardId) {
  const card = getCard(state.board, cardId);
  if (!card || card.type !== "link" || card.locked || !card.headerImage) return;
  delete card.headerImage;
  delete card.headerImageCrop;
  markDirty("board");
}

const autoHeaderFetches = new Set();

export async function maybeAutoLinkHeader(cardId) {
  const card = getCard(state.board, cardId);
  if (!card || card.type !== "link" || card.headerImage || !card.url) return;
  if (autoHeaderFetches.has(cardId)) return;
  if (!/^https?:\/\//i.test(card.url)) return;
  autoHeaderFetches.add(cardId);
  try {
    const preview = await bridge.fetchLinkPreview(card.url);
    if (!preview?.data) return;
    if (card.headerImage) return;
    const name = preview.name || "link-hero.png";
    card.headerImage = await bridge.storeAsset(name, preview.data);
    card.headerImageAuto = true;
    markDirty("board");
  } catch {
    /* no hero image available */
  } finally {
    autoHeaderFetches.delete(cardId);
  }
}

export async function applyLinkHeaderCrop(cardId, crop) {
  const card = getCard(state.board, cardId);
  if (!card || card.type !== "link" || !card.headerImage) return;
  card.headerImageCrop = crop;
  markDirty("board");
}

export function applyImageCrop(cardId, crop) {
  const card = getCard(state.board, cardId);
  if (!card || card.type !== "image" || !card.src) return;
  card.imageCrop = crop;
  const ratio = (crop.w / crop.h) * (crop.ratio || 1);
  card.h = Math.max(120, Math.round(card.w / ratio) + 24);
  markDirty("board");
}

function mediaNode(cardId) {
  return document.querySelector(`.mn-card[data-id="${CSS.escape(cardId)}"]`);
}

function mediaFrameCommand(card, func) {
  const frame = mediaNode(card.id)?.querySelector("iframe");
  if (!frame?.contentWindow) return false;
  if (/vimeo\.com/i.test(card.url || "")) {
    frame.contentWindow.postMessage(JSON.stringify({ method: func === "pauseVideo" ? "pause" : "play" }), "*");
  } else {
    frame.contentWindow.postMessage(
      JSON.stringify({ event: "command", func, args: [] }),
      "*"
    );
  }
  return true;
}

export function playMedia(cardId) {
  const card = getCard(state.board, cardId);
  if (!card || !["audio", "video"].includes(card.type) || !card.url) return;
  const node = mediaNode(cardId);
  const element = node?.querySelector("audio,video");
  if (element) {
    element.play().catch(() => {
      window.dispatchEvent(
        new CustomEvent("mn:toast", { detail: { message: "This media cannot be played." } })
      );
    });
    node.classList.add("is-started", "is-playing");
    return;
  }
  if (card.type === "video" && !card.__mediaStarted) {
    card.__mediaStarted = true;
    card.__mediaPlaying = true;
    refreshCard(card.id);
    return;
  }
  if (mediaFrameCommand(card, "playVideo")) {
    card.__mediaPlaying = true;
    node?.querySelector(".mn-video")?.classList.add("is-playing");
  }
}

export function pauseMedia(cardId) {
  const card = getCard(state.board, cardId);
  if (!card || !["audio", "video"].includes(card.type)) return;
  const node = mediaNode(cardId);
  const element = node?.querySelector("audio,video");
  if (element) {
    element.pause();
    node?.classList.remove("is-playing");
  } else {
    mediaFrameCommand(card, "pauseVideo");
    node?.querySelector(".mn-video")?.classList.remove("is-playing");
  }
  card.__mediaPlaying = false;
}

export function toggleMediaRepeat(cardId) {
  const card = getCard(state.board, cardId);
  if (!card || !["audio", "video"].includes(card.type)) return;
  card.repeat = !card.repeat;
  const element = mediaNode(cardId)?.querySelector("audio,video");
  if (element) element.loop = Boolean(card.repeat);
  if (card.type === "video" && card.__mediaStarted && mediaNode(cardId)?.querySelector("iframe")) {
    refreshCard(card.id);
  }
  markDirty("save");
}

export async function attachAudio(cardId, file) {
  const card = getCard(state.board, cardId);
  if (!card || !uploadAllowed(file)) return;
  try {
    const base64 = await bridge.readFileAsBase64(file);
    const path = await bridge.storeAsset(file.name || "audio", base64);
    card.url = path;
    card.name = file.name;
    markDirty("board");
  } catch {
    reportUploadProblem("Could not store this audio file.");
  }
}

export async function attachFile(cardId, file) {
  const card = getCard(state.board, cardId);
  if (!card || !uploadAllowed(file)) return;
  try {
    const base64 = await bridge.readFileAsBase64(file);
    const path = await bridge.storeAsset(file.name || "file", base64);
    card.name = file.name;
    card.path = path;
    markDirty("board");
  } catch {
    reportUploadProblem("Could not store this file.");
  }
}

export function assetPathForCard(card) {
  const candidate =
    card.type === "file"
      ? card.path
      : card.type === "image"
        ? card.src
        : card.type === "audio" || card.type === "video"
          ? card.url
          : "";
  if (!candidate || /^(https?:|data:|blob:)/i.test(candidate)) return "";
  return candidate;
}

export async function downloadCardAsset(card) {
  const path = assetPathForCard(card);
  if (!path) return null;
  return bridge.downloadAsset(path);
}

export async function createNestedBoardCard(at) {
  const doc = newBoardDoc("New board", state.board ? state.board.id : null);
  await bridge.saveBoard(doc.id, JSON.stringify(doc), null);
  const card = addCard("board", at.x, at.y, { boardId: doc.id, title: doc.title });
  await refreshBoards();
  return card;
}

export function openBoardCard(card) {
  if (card && card.boardId) openBoard(card.boardId);
}

export function setBoardTitle(title) {
  if (!state.board) return;
  state.board.title = title;
  const meta = state.boards.find((board) => board.id === state.board.id);
  if (meta) meta.title = title;
  markDirty("board");
  // Goes through the normal save path so it shares the in-flight guard and the base timestamp.
  saveNow();
}

export function editCard(cardId) {
  const card = getCard(state.board, cardId);
  if (!card) return;
  window.dispatchEvent(new CustomEvent("mn:edit-card", { detail: { cardId } }));
}

// ------------------------------------------------------------------ clipboard

let cardClipboard = null;

export function hasClipboard() {
  return Boolean(cardClipboard?.cards.length);
}

export function clearClipboard() {
  const had = hasClipboard();
  cardClipboard = null;
  return had;
}

export function copySelected() {
  if (!state.board || !state.selection.size) return 0;
  cardClipboard = selectionGraph([...state.selection]);
  return cardClipboard.cards.length;
}

export function cutSelected() {
  const count = copySelected();
  if (count) deleteCards([...state.selection], { trash: false });
  return count;
}

export function pasteCards() {
  if (!state.board || !hasClipboard()) return 0;
  checkpoint();
  const graph = cardClipboard;
  const ids = cloneGraph(graph, besideOffset(graph));
  cardClipboard = null;
  setSelection(ids);
  markDirty("board");
  return ids.length;
}
