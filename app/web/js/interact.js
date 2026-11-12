// Pointer, keyboard and inline editing interactions on the board.

import {
  addCard,
  deleteCards,
  downloadCardAsset,
  attachImage,
  attachAudio,
  maybeAutoLinkHeader,
  openLink,
  openBoardCard,
} from "./actions.js";
import * as bridge from "./bridge.js";
import { openColorPicker } from "./color-picker.js";
import { colorNameForHex } from "./color-names.js";
import { isTemporarilyDisabledType } from "./limits.js";
import { confirmAction, toast } from "./ui.js";
import { clearDropPreview, previewDrop } from "./drop-preview.js";
import {
  CARD_ASPECTS,
  cardHeightFor,
  columnChildren,
  getCard,
  layoutColumns,
  MIN_SIZES,
  uid,
} from "./model.js";
import {
  cardElement,
  connectionGeometry,
  refreshCard,
  preserveMediaForNextRender,
  refreshColorPreview,
  render,
  renderConnections,
  renderView,
  sanitizeHtml,
  setEditable,
  syncCardHeight,
  worldPointFromEvent,
  zIndexFor,
} from "./render.js";
import {
  checkpoint,
  markDirty,
  notify,
  saveNow,
  setSelection,
  state,
  toggleSelection,
} from "./store.js";

const COLUMN_HEADER = 64;
const COLUMN_PADDING = 14;
const COLUMN_GAP = 10;
// While a card is moving it must sit above every column, including nested kanban lanes.
const DRAG_Z_INDEX = 1_900_000_000;
const KANBAN_COL_WIDTH = 168;
const KANBAN_GAP = 8;

function snap(value) {
  const grid = Math.max(1, Number(state.board?.grid) || 24);
  return Math.round(value / grid) * grid;
}

function kanbanWidth(columnCount) {
  return Math.max(360, 20 + columnCount * KANBAN_COL_WIDTH + Math.max(0, columnCount - 1) * KANBAN_GAP);
}

let viewportEl = null;
let cardsEl = null;
let gesture = null;
let spaceHeld = false;
let dragUI = null;
let dragEndedAt = 0;

const isTypingTarget = (target) =>
  target &&
  (target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT");

export function initInteractions(refs) {
  viewportEl = refs.viewport;
  cardsEl = refs.cards;

  viewportEl.addEventListener("pointerdown", onPointerDown);
  viewportEl.addEventListener("mousedown", onViewportMouseDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  viewportEl.addEventListener("wheel", onWheel, { passive: false });
  viewportEl.addEventListener("dblclick", onViewportDblClick);
  cardsEl.addEventListener("dblclick", onCardDblClick);
  cardsEl.addEventListener("input", onInput);
  cardsEl.addEventListener("change", onChange);
  cardsEl.addEventListener("click", onClick);
  cardsEl.addEventListener("focusout", onFocusOut);
  cardsEl.addEventListener("keydown", onCardKeyDown);
  cardsEl.addEventListener("load", onImageLoad, true);
  for (const eventName of ["timeupdate", "durationchange", "play", "pause", "ended", "volumechange"]) {
    cardsEl.addEventListener(eventName, onAudioMediaEvent, true);
  }
  window.addEventListener("message", onMediaFrameMessage);

  document.addEventListener("selectionchange", onBoardSelectionChange);
  window.addEventListener("keydown", onWindowKeyDown);
  window.addEventListener("keyup", onWindowKeyUp);
  window.addEventListener("blur", () => {
    spaceHeld = false;
    viewportEl.classList.remove("is-space");
    saveNow();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) saveNow();
  });

  document.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".mn-table-tools")) return;
    document.querySelectorAll(".mn-table-menu:not([hidden])").forEach((menu) => {
      menu.hidden = true;
    });
  });
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    document.querySelectorAll(".mn-table-menu:not([hidden])").forEach((menu) => {
      menu.hidden = true;
    });
  });

  window.addEventListener("mn:focus-field", (event) => {
    const { cardId, selector } = event.detail || {};
    const card = getCard(state.board, cardId);
    if (!card) return;
    const el = cardElement(cardId);
    const target = el && el.querySelector(selector);
    if (!target) return;
    if (target.isContentEditable || target.matches("[contenteditable]")) {
      beginTextEdit(card, target);
    } else {
      target.focus();
      if (target.select) target.select();
    }
  });
}

function worldOf(event) {
  return worldPointFromEvent(event);
}

// A click on a native scrollbar must reach the scroll container, otherwise the card drag handler
// calls preventDefault and the thumb cannot move.
function pointerOnScrollbar(event) {
  let el = event.target;
  while (el && el !== cardsEl) {
    if (el.nodeType === 1) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const borderX =
        (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
      const borderY =
        (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
      const barY = el.offsetHeight - el.clientHeight - borderY;
      const barX = el.offsetWidth - el.clientWidth - borderX;
      const scrollY = /(auto|scroll)/.test(style.overflowY) && barY > 0;
      const scrollX = /(auto|scroll)/.test(style.overflowX) && barX > 0;
      if (scrollY && event.clientX >= rect.right - barX) return true;
      if (scrollX && event.clientY >= rect.bottom - barY) return true;
    }
    el = el.parentElement;
  }
  return false;
}

function cardOfTarget(target) {
  const el = target.closest(".mn-card");
  if (!el) return null;
  return getCard(state.board, el.dataset.id);
}

// ------------------------------------------------------------------ pointer

function onBoardSelectionChange() {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed) return;
  const anchor = selection.anchorNode;
  const element = anchor?.nodeType === 1 ? anchor : anchor?.parentElement;
  if (!element?.closest?.(".mn-viewport")) return;
  if (element.closest("input, textarea, select, .is-editing")) return;
  selection.removeAllRanges();
}

function onViewportMouseDown(event) {
  if (event.button !== 0) return;
  const target = event.target;
  if (!target?.closest) return;
  if (target.closest("input, textarea, select, button, a, [role='button']")) return;
  // While a note/document is actively being edited, native text selection must keep working.
  const editable = target.closest('[contenteditable="true"]');
  if (editable && state.editing?.el === editable) return;
  const card = target.closest(".mn-card");
  if (!card && target !== viewportEl) return;
  // Do not preventDefault here: card drags also start from these elements. The CSS rule above
  // keeps the text unselectable until the card enters editing mode; this only clears stale ranges.
  const selection = window.getSelection?.();
  if (selection && !selection.isCollapsed) selection.removeAllRanges();
  // WebKitGTK can keep a text selection inside an unfocused input after a board drag. Collapse
  // those ranges as well while the field is not being edited.
  for (const field of viewportEl.querySelectorAll("input, textarea")) {
    if (field === state.editing?.el) continue;
    try {
      field.setSelectionRange(field.value.length, field.value.length);
    } catch {
      /* input type without selection support */
    }
  }
}

function onPointerDown(event) {
  if (!state.board) return;
  if (event.target.closest(".mn-zoom")) return;
  if (pointerOnScrollbar(event)) return;
  // Overlay scrollbars (WebView2) do not take layout space, so reserve the edge strip for them
  // instead of starting a card drag on the thumb.
  if (event.target.matches(".mn-kanban-cols")) {
    const rect = event.target.getBoundingClientRect();
    if (event.clientY >= rect.bottom - 16) return;
  }
  if (event.target.matches(".mn-kanban-items")) {
    const rect = event.target.getBoundingClientRect();
    if (event.clientX >= rect.right - 16 || event.clientY >= rect.bottom - 16) return;
  }
  const sheet = event.target.closest?.(".mn-table");
  if (sheet) {
    const rect = sheet.getBoundingClientRect();
    // Overlay scrollbars take no layout space, so reserve the right and bottom edge for the thumb.
    if (event.clientX >= rect.right - 14 || event.clientY >= rect.bottom - 14) return;
  }
  const kanbanRow = event.target.closest("[data-kanban-item-row]");
  if (kanbanRow) {
    if (event.button === 0 && !event.target.closest("input, button")) {
      event.preventDefault();
      beginKanbanItemDrag(event, kanbanRow);
    }
    return;
  }

  if (event.button === 0 && event.target.closest(".mn-connection-hit, .mn-line-handle")) {
    if (onConnectionPointerDown(event)) return;
  }
  if (state.connectionSelection) {
    state.connectionSelection = null;
    renderConnections();
  }

  if (event.button === 0 && state.tool === "line") {
    event.preventDefault();
    beginLineDrag(event);
    return;
  }

  if (event.button === 0 && state.tool === "draw") {
    const mode = state.drawMode || "pen";
    const blocked = event.target.closest(
      "input, textarea, button, a, [contenteditable=true], [role=button]"
    );
    if (!blocked && (mode === "pen" || mode === "eraser")) {
      event.preventDefault();
      beginDrawGesture(event, mode);
      return;
    }
  }

  const cardEl = event.target.closest(".mn-card");
  const card = cardEl ? getCard(state.board, cardEl.dataset.id) : null;

  if (event.button === 1 || (event.button === 0 && spaceHeld)) {
    event.preventDefault();
    beginPan(event);
    return;
  }

  if (card) {
    const isResize =
      !card.parentId &&
      card.type !== "drawing" &&
      Boolean(event.target.closest('[data-role="resize"]'));
    const interactive = event.target.closest(
      'input, textarea, button, a, [contenteditable="true"], [role="button"], .mn-column-title'
    );

    if (!isResize && !interactive) {
      if (event.shiftKey) toggleSelection(card.id);
      else if (!state.selection.has(card.id)) setSelection([card.id]);
    } else if (!isResize && !state.selection.has(card.id)) {
      setSelection([card.id]);
    }

    if (card.locked) {
      event.preventDefault();
      return;
    }
    if (
      card.type === "section" &&
      card.positionLocked &&
      (isResize || !interactive)
    ) {
      event.preventDefault();
      return;
    }
    if (event.target.closest("[data-sheet-add-column]")) {
      event.preventDefault();
      beginSheetAdd(card, "column", event);
      return;
    }
    if (event.target.closest("[data-sheet-add-row]")) {
      event.preventDefault();
      beginSheetAdd(card, "row", event);
      return;
    }
    const columnGrip = event.target.closest("[data-col-resize]");
    if (columnGrip) {
      event.preventDefault();
      beginColumnResize(card, Number(columnGrip.dataset.colResize), event);
      return;
    }
    const todoGrip = event.target.closest("[data-todo-grip]");
    if (todoGrip) {
      event.preventDefault();
      beginTodoItemDrag(card, todoGrip.dataset.todoGrip, event, todoGrip.closest(".mn-todo-item"));
      return;
    }
    if (isResize) {
      event.preventDefault();
      beginResize(card, event);
      return;
    }
    if (interactive) return;
    event.preventDefault();
    beginDrag(card, event);
    return;
  }

  if (event.button === 0) {
    if (!event.shiftKey && !event.metaKey) setSelection([]);
    beginMarquee(event);
  }
}

function beginPan(event) {
  gesture = {
    type: "pan",
    startX: event.clientX,
    startY: event.clientY,
    viewX: state.view.x,
    viewY: state.view.y,
  };
  viewportEl.classList.add("is-panning");
}

function beginDrag(card, event) {
  const start = worldOf(event);
  const ids = state.selection.has(card.id) ? [...state.selection] : [card.id];
  checkpoint();
  const origins = new Map();
  for (const id of ids) {
    const target = getCard(state.board, id);
    if (target) origins.set(id, { x: target.x, y: target.y, w: target.w, h: target.h });
  }
  gesture = {
    type: "drag",
    id: card.id,
    ids,
    start,
    startClientX: event.clientX,
    startClientY: event.clientY,
    origins,
    moved: false,
    wasChild: card.parentId,
    dropTarget: null,
    lastWorld: start,
  };
  for (const id of ids) {
    const el = cardElement(id);
    if (!el) continue;
    const target = getCard(state.board, id);
    el.classList.add("is-dragging");
    // A Section is a background wrapper even while selected or moved.
    el.style.zIndex = String(
      target?.type === "section" ? zIndexFor(target) : DRAG_Z_INDEX
    );
  }
  if (!card.parentId && card.type !== "section") {
    const top = Math.max(...state.board.cards.map((item) => item.z || 1)) + 1;
    card.z = top;
    const el = cardElement(card.id);
    if (el) el.style.zIndex = String(top * 1000);
    // Raising a column must also raise its children, otherwise the column background covers them.
    if (card.type === "column") syncColumnStack(card);
  }
}

function beginResize(card, event) {
  checkpoint();
  const handle = event.target.closest('[data-role="resize"]')?.dataset.handle || "se";
  gesture = {
    type: "resize",
    id: card.id,
    handle,
    start: worldOf(event),
    startX: card.x,
    startY: card.y,
    startW: card.w,
    startH: card.h,
    minW: (MIN_SIZES[card.type] || [120, 60])[0],
    minH: (MIN_SIZES[card.type] || [120, 60])[1],
    colWidths:
      card.type === "table" && Array.isArray(card.colWidths)
        ? [...card.colWidths]
        : null,
  };
  viewportEl.classList.add("is-resizing");
}

function beginColumnResize(card, index, event) {
  const count = Math.max(1, card.cells?.[0]?.length || 0);
  const fallback = Math.max(60, (card.w - 4) / count);
  const widths =
    Array.isArray(card.colWidths) && card.colWidths.length === count
      ? [...card.colWidths]
      : Array.from({ length: count }, () => fallback);
  card.colWidths = widths;
  checkpoint();
  gesture = {
    type: "col-resize",
    id: card.id,
    index,
    startX: event.clientX,
    widths,
  };
  viewportEl.classList.add("is-resizing");
}

function beginMarquee(event) {
  const rect = viewportEl.getBoundingClientRect();
  const el = document.createElement("div");
  el.className = "mn-marquee";
  viewportEl.append(el);
  gesture = {
    type: "marquee",
    el,
    startX: event.clientX - rect.left,
    startY: event.clientY - rect.top,
    rect,
    additive: event.shiftKey,
    base: new Set(state.selection),
  };
}

function onPointerMove(event) {
  if (!gesture) return;
  switch (gesture.type) {
    case "draw": {
      const point = worldOf(event);
      const last = gesture.points[gesture.points.length - 1];
      if (Math.hypot(point.x - last.x, point.y - last.y) < 0.8) return;
      gesture.points.push(point);
      gesture.path.setAttribute("d", drawPathData(gesture.points));
      break;
    }
    case "erase": {
      eraseDrawingAt(event);
      break;
    }
    case "pan": {
      state.view.x = gesture.viewX + (event.clientX - gesture.startX);
      state.view.y = gesture.viewY + (event.clientY - gesture.startY);
      notify("view");
      renderView();
      break;
    }
    case "drag": {
      const screenDist = Math.hypot(
        event.clientX - gesture.startClientX,
        event.clientY - gesture.startClientY
      );
      if (!gesture.moved && screenDist < 3) return;
      gesture.moved = true;
      const world = worldOf(event);
      gesture.lastWorld = world;
      const dx = world.x - gesture.start.x;
      const dy = world.y - gesture.start.y;
      gesture.lastDx = dx;
      gesture.lastDy = dy;
      for (const id of gesture.ids) {
        const card = getCard(state.board, id);
        const origin = gesture.origins.get(id);
        if (!card || !origin) continue;
        card.x = origin.x + dx;
        card.y = origin.y + dy;
        if (!card.parentId && state.board?.snapToGrid) {
          card.x = snap(card.x);
          card.y = snap(card.y);
        }
        applyCardGeometry(card);
      }
      syncColumnChildren();
      updateDragIndicators(world);
      renderConnections();
      break;
    }
    case "line": {
      const world = worldOf(event);
      if (Math.hypot(world.x - gesture.start.x, world.y - gesture.start.y) > 4) {
        gesture.moved = true;
      }
      const snap = nearestCardSnap(world);
      gesture.draft.to = snap ? snap.cardId : null;
      gesture.draft.toPoint = snap ? null : { x: world.x, y: world.y };
      gesture.draft.curve = null;
      renderConnections();
      break;
    }
    case "line-end": {
      const world = worldOf(event);
      const snap = nearestCardSnap(world);
      const connection = gesture.connection;
      if (gesture.end === "from") {
        if (snap) {
          connection.from = snap.cardId;
          delete connection.fromPoint;
        } else {
          connection.from = null;
          connection.fromPoint = { x: world.x, y: world.y };
        }
      } else if (snap) {
        connection.to = snap.cardId;
        delete connection.toPoint;
      } else {
        connection.to = null;
        connection.toPoint = { x: world.x, y: world.y };
      }
      renderConnections();
      break;
    }
    case "line-mid": {
      const world = worldOf(event);
      const geometry = connectionGeometry(gesture.connection);
      gesture.connection.curve = {
        x: 2 * world.x - (geometry.start.x + geometry.end.x) / 2,
        y: 2 * world.y - (geometry.start.y + geometry.end.y) / 2,
      };
      renderConnections();
      break;
    }
    case "kanban-item": {
      const distance = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
      if (!gesture.moved && distance < 4) return;
      gesture.moved = true;
      gesture.ghost.style.left = `${event.clientX + 12}px`;
      gesture.ghost.style.top = `${event.clientY + 12}px`;
      updateKanbanDropTarget(event);
      break;
    }
    case "todo-item": {
      if (!gesture.moved && Math.abs(event.clientY - gesture.startY) < 4) return;
      gesture.moved = true;
      gesture.ghost.style.left = `${event.clientX + 12}px`;
      gesture.ghost.style.top = `${event.clientY + 12}px`;
      updateTodoDropTarget(event);
      break;
    }
    case "col-resize": {
      const card = getCard(state.board, gesture.id);
      if (!card) return;
      const dx = (event.clientX - gesture.startX) / (state.view.zoom || 1);
      const widths = [...gesture.widths];
      widths[gesture.index] = Math.max(40, widths[gesture.index] + dx);
      card.colWidths = widths;
      card.w = widths.reduce((sum, width) => sum + width, 0) + 4;
      applyCardGeometry(card);
      refreshCard(card.id);
      layoutColumns(state.board);
      break;
    }
    case "sheet-add": {
      const card = getCard(state.board, gesture.id);
      if (!card) return;
      const zoom = state.view.zoom || 1;
      if (gesture.kind === "column") {
        const dx = (event.clientX - gesture.startX) / zoom;
        if (gesture.added === 0 && dx < -20) {
          gesture.removeCount = Math.max(1, Math.floor(-dx / 80));
          break;
        }
        gesture.removeCount = 0;
        const wanted = Math.max(0, Math.floor(dx / 80));
        while (gesture.added < wanted) {
          const rows = card.cells || [["", "", ""]];
          const columns = Math.max(1, ...rows.map((row) => row.length));
          card.cells = rows.map((row) => [
            ...row,
            ...new Array(Math.max(0, columns - row.length)).fill(""),
            "",
          ]);
          if (Array.isArray(card.colWidths)) card.colWidths.push(80);
          card.w += 80;
          gesture.added += 1;
        }
        applyCardGeometry(card);
        refreshCard(card.id);
      } else {
        const dy = (event.clientY - gesture.startY) / zoom;
        if (gesture.added === 0 && dy < -14) {
          gesture.removeCount = Math.max(1, Math.floor(-dy / 28));
          break;
        }
        gesture.removeCount = 0;
        const wanted = Math.max(0, Math.floor(dy / 28));
        while (gesture.added < wanted) {
          const rows = card.cells || [["", "", ""]];
          const columns = Math.max(1, ...rows.map((row) => row.length));
          rows.push(new Array(columns).fill(""));
          card.cells = rows;
          gesture.added += 1;
        }
        refreshCard(card.id);
        syncCardHeight(card);
      }
      break;
    }
    case "resize": {
      const card = getCard(state.board, gesture.id);
      if (!card) return;
      const world = worldOf(event);
      const dx = world.x - gesture.start.x;
      const dy = world.y - gesture.start.y;
      const handle = gesture.handle || "se";
      let x = gesture.startX;
      let y = gesture.startY;
      let width = gesture.startW;
      let height = gesture.startH;
      if (handle.includes("e")) width = gesture.startW + dx;
      if (handle.includes("s")) height = gesture.startH + dy;
      if (handle.includes("w")) {
        width = gesture.startW - dx;
        x = gesture.startX + dx;
      }
      if (handle.includes("n")) {
        height = gesture.startH - dy;
        y = gesture.startY + dy;
      }
      if (width < gesture.minW) {
        if (handle.includes("w")) x = gesture.startX + gesture.startW - gesture.minW;
        width = gesture.minW;
      }
      if (height < gesture.minH) {
        if (handle.includes("n")) y = gesture.startY + gesture.startH - gesture.minH;
        height = gesture.minH;
      }
      if (state.board?.snapToGrid) {
        x = snap(x);
        y = snap(y);
        width = Math.max(gesture.minW, snap(width));
        height = Math.max(gesture.minH, snap(height));
      }
      if (card.type === "column" || card.type === "section") {
        card.x = x;
        card.y = y;
        card.w = Math.max(gesture.minW, width);
        card.h = Math.max(gesture.minH, height);
        if (card.type === "column") layoutColumns(state.board);
      } else {
        card.w = Math.max(gesture.minW, width);
        if (card.aspect || card.type === "image" || card.type === "sketch" || card.type === "video" || card.type === "map" || card.type === "color") {
          card.h = cardHeightFor(card);
        }
        if (
          card.type === "table" &&
          Array.isArray(gesture.colWidths) &&
          gesture.colWidths.length &&
          gesture.startW > 4
        ) {
          const ratio = Math.max(0.2, (card.w - 4) / (gesture.startW - 4));
          card.colWidths = gesture.colWidths.map((width) => Math.max(40, width * ratio));
        }
      }
      render("geometry");
      break;
    }
    case "marquee": {
      const x = Math.min(gesture.startX, event.clientX - gesture.rect.left);
      const y = Math.min(gesture.startY, event.clientY - gesture.rect.top);
      const w = Math.abs(event.clientX - gesture.rect.left - gesture.startX);
      const h = Math.abs(event.clientY - gesture.rect.top - gesture.startY);
      Object.assign(gesture.el.style, {
        left: `${x}px`,
        top: `${y}px`,
        width: `${w}px`,
        height: `${h}px`,
      });
      const a = screenToWorld(gesture.rect, x, y);
      const b = screenToWorld(gesture.rect, x + w, y + h);
      const hit = state.board.cards
        .filter((card) => !isTemporarilyDisabledType(card.type))
        .filter(
          (card) =>
            card.x < b.x && card.x + card.w > a.x && card.y < b.y && card.y + card.h > a.y
        )
        .map((card) => card.id);
      setSelection([...new Set([...hit, ...(gesture.additive ? gesture.base : [])])]);
      break;
    }
    default:
      break;
  }
}

function screenToWorld(viewportRect, clientX, clientY) {
  return {
    x: (clientX - state.view.x) / state.view.zoom,
    y: (clientY - state.view.y) / state.view.zoom,
  };
}

function applyCardGeometry(card) {
  const el = cardElement(card.id);
  if (!el) return;
  el.style.left = `${card.x}px`;
  el.style.top = `${card.y}px`;
  el.style.width = `${card.w}px`;
  if (card.type === "column") el.style.height = `${card.h}px`;
  el.style.zIndex = String(zIndexFor(card));
}

function syncColumnStack(column) {
  if (!column || column.type !== "column") return;
  for (const child of columnChildren(state.board, column.id)) {
    const el = cardElement(child.id);
    if (el) el.style.zIndex = String(zIndexFor(child));
    if (child.type === "column") syncColumnStack(child);
  }
}

function syncColumnChildren() {
  if (!state.board) return;
  layoutColumns(state.board);
  // While dragging, column children must be able to leave the column horizontally; after the layout
  // snaps them back, restore the dragged cards to their pointer-following position.
  if (gesture && gesture.type === "drag" && gesture.moved) {
    for (const id of gesture.ids) {
      const card = getCard(state.board, id);
      const origin = gesture.origins.get(id);
      if (!card || !origin || !card.parentId) continue;
      card.x = origin.x + (gesture.lastDx || 0);
      card.y = origin.y + (gesture.lastDy || 0);
    }
  }
  for (const card of state.board.cards) {
    if (card.parentId) applyCardGeometry(card);
  }
  // Keep the card being dragged inside a column above its siblings while it moves.
  if (gesture && gesture.type === "drag") {
    for (const id of gesture.ids) {
      const card = getCard(state.board, id);
      if (!card || !card.parentId) continue;
      const column = getCard(state.board, card.parentId);
      const el = cardElement(id);
      if (column && el) el.style.zIndex = String(DRAG_Z_INDEX);
    }
  }
}

function onPointerUp(event) {
  if (!gesture) return;
  if (gesture.type === "kanban-item") {
    const current = gesture;
    gesture = null;
    finishKanbanItemDrag(current);
    return;
  }
  if (gesture.type === "todo-item") {
    const current = gesture;
    gesture = null;
    finishTodoItemDrag(current);
    return;
  }
  const current = gesture;
  gesture = null;
  viewportEl.classList.remove("is-panning", "is-resizing");

  if (current.type === "draw") {
    finishFreehand(current);
    return;
  }
  if (current.type === "erase") return;
  if (current.type === "marquee") {
    current.el.remove();
    return;
  }
  if (current.type === "pan") return;
  if (current.type === "drag") {
    clearDragIndicators();
    for (const id of current.ids) {
      const el = cardElement(id);
      if (el) el.classList.remove("is-dragging");
    }
    if (!current.moved) {
      // A click selects without moving. Restore the computed stacking so a Section cannot stay
      // above the board after being clicked.
      for (const id of current.ids) {
        const card = getCard(state.board, id);
        const el = cardElement(id);
        if (card && el) {
          el.style.zIndex = String(zIndexFor(card));
          syncColumnStack(card);
        }
      }
      return;
    }
    dragEndedAt = Date.now();
    finishDrag(current);
    return;
  }
  if (current.type === "line") {
    const draft = current.draft;
    const connections = state.board.connections || [];
    const index = connections.indexOf(draft);
    if (index >= 0) connections.splice(index, 1);
    const sameCard = draft.from && draft.to && draft.from === draft.to;
    const hasStart = Boolean(draft.from || draft.fromPoint);
    const hasEnd = Boolean(draft.to || draft.toPoint);
    if (current.moved && !sameCard && hasStart && hasEnd) {
      checkpoint();
      const final = {
        id: uid("conn"),
        from: draft.from,
        to: draft.to,
        curve: null,
      };
      if (draft.fromPoint) final.fromPoint = draft.fromPoint;
      if (draft.toPoint) final.toPoint = draft.toPoint;
      connections.push(final);
      state.connectionSelection = final.id;
      state.tool = "select";
      notify("tool");
      markDirty("board");
    } else {
      renderConnections();
    }
    return;
  }
  if (current.type === "line-end" || current.type === "line-mid") {
    markDirty("board");
    renderConnections();
    return;
  }
  if (current.type === "sheet-add") {
    const card = getCard(state.board, current.id);
    if (card && current.added === 0 && current.removeCount > 0) {
      if (current.kind === "column") removeSheetColumns(card, current.removeCount);
      else removeSheetRows(card, current.removeCount);
      return;
    }
    markDirty("board");
    return;
  }
  if (current.type === "col-resize") {
    preserveMediaForNextRender();
    markDirty("board");
    return;
  }
  if (current.type === "resize") {
    layoutColumns(state.board);
    preserveMediaForNextRender();
    markDirty("board");
  }
}

function finishDrag(current) {
  clearDropPreview();
  const before = captureRects();
  const dragged = new Set(current.ids);
  const target = current.dropTarget;

  if (target && target.columnId) {
    const column = getCard(state.board, target.columnId);
    if (column) {
      const children = columnChildren(state.board, column.id).filter(
        (card) => !dragged.has(card.id)
      );
      const rowOfColumns =
        column.direction === "row" &&
        (Boolean(column.kanban) || (children.length > 0 && children.every((card) => card.type === "column")));
      const moving = state.board.cards.filter(
        (card) =>
          dragged.has(card.id) &&
          card.type !== "section" &&
          (column.direction === "row"
            ? rowOfColumns
              ? card.type === "column"
              : card.type !== "column"
            : card.type !== "column")
      );
      if (moving.length) {
        const rest = columnChildren(state.board, column.id).filter(
          (card) => !dragged.has(card.id)
        );
        const next = [...rest];
        const index = Math.max(0, Math.min(next.length, target.index));
        next.splice(index, 0, ...moving);
        next.forEach((child, order) => {
          child.parentId = column.id;
          child.order = order;
        });
      }
    }
  } else {
    for (const id of dragged) {
      const card = getCard(state.board, id);
      if (!card || card.type === "column") continue;
      if (!card.parentId) continue;
      const parent = getCard(state.board, card.parentId);
      if (!parent) {
        card.parentId = null;
        continue;
      }
      const center = { x: card.x + card.w / 2, y: card.y + card.h / 2 };
      const insideX = center.x >= parent.x - 24 && center.x <= parent.x + parent.w + 24;
      const insideY = center.y >= parent.y - 24 && center.y <= parent.y + parent.h + 24;
      // Leaving the column vertically must release the child as well as leaving it horizontally;
      // the old X-only check snapped a card back into the column when it was dropped above/below.
      if (!insideX || !insideY) {
        card.parentId = null;
        card.order = 0;
      }
    }
  }

  // A column card was dragged with its children: keep every child parented.
  for (const column of state.board.cards.filter((item) => item.type === "column")) {
    if (dragged.has(column.id)) {
      for (const child of columnChildren(state.board, column.id)) {
        child.parentId = column.id;
      }
    }
  }

  layoutColumns(state.board);
  preserveMediaForNextRender();
  markDirty("board");
  animateSettle(before);
}

function captureRects() {
  const rects = new Map();
  for (const card of state.board.cards) {
    const el = cardElement(card.id);
    if (el) rects.set(card.id, el.getBoundingClientRect());
  }
  return rects;
}

function animateSettle(before) {
  const zoom = state.view.zoom || 1;
  requestAnimationFrame(() => {
    for (const [id, rect] of before) {
      const el = cardElement(id);
      if (!el) continue;
      const after = el.getBoundingClientRect();
      // Card transforms live inside the zoomed world, so convert the screen delta to world units.
      const dx = (rect.left - after.left) / zoom;
      const dy = (rect.top - after.top) / zoom;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      el.getBoundingClientRect();
      requestAnimationFrame(() => {
        el.style.transition = "transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1)";
        el.style.transform = "";
        window.setTimeout(() => {
          el.style.transition = "";
          el.style.transform = "";
        }, 240);
      });
    }
  });
}

// ------------------------------------------------------------------ drag UI

function ensureDragUI() {
  if (dragUI) return dragUI;
  const layer = document.createElement("div");
  layer.className = "mn-drag-ui";
  const origin = document.createElement("div");
  origin.className = "mn-origin-ghost";
  origin.hidden = true;
  const ghost = document.createElement("div");
  ghost.className = "mn-drop-ghost";
  ghost.hidden = true;
  const line = document.createElement("div");
  line.className = "mn-drop-line";
  line.hidden = true;
  layer.append(origin, ghost, line);
  cardsEl.append(layer);
  dragUI = { layer, origin, ghost, line };
  return dragUI;
}

function clearDragIndicators() {
  clearDropPreview();
  if (gesture) gesture.dropTarget = null;
  if (!dragUI) return;
  dragUI.layer.remove();
  dragUI = null;
  document.querySelectorAll(".mn-card.is-drop-target").forEach((el) =>
    el.classList.remove("is-drop-target")
  );
}

function updateDragIndicators(point) {
  if (!state.board) return;
  const dragged = new Set(gesture.ids);
  const cards = state.board.cards.filter((card) => dragged.has(card.id));
  if (!cards.length) {
    if (dragUI) {
      dragUI.line.hidden = true;
      dragUI.ghost.hidden = true;
    }
    if (gesture) gesture.dropTarget = null;
    return;
  }
  const ui = ensureDragUI();
  const column = findColumnAt(
    point,
    dragged,
    cards.some((card) => card.type === "column")
  );
  if (!column) {
    ui.line.hidden = true;
    ui.ghost.hidden = true;
    ui.origin.hidden = !gesture.wasChild;
    if (gesture.wasChild) paintOriginGhost(ui, cards[0]);
    gesture.dropTarget = null;
    clearDropPreview();
    document.querySelectorAll(".mn-card.is-drop-target").forEach((el) =>
      el.classList.remove("is-drop-target")
    );
    return;
  }
  document.querySelectorAll(".mn-card.is-drop-target").forEach((el) => {
    if (el.dataset.id !== column.id) el.classList.remove("is-drop-target");
  });
  const columnEl = cardElement(column.id);
  if (columnEl) columnEl.classList.add("is-drop-target");

  if (column.direction === "row") {
    const children = columnChildren(state.board, column.id).filter(
      (card) => !dragged.has(card.id)
    );
    const rowOfColumns =
      Boolean(column.kanban) || (children.length > 0 && children.every((card) => card.type === "column"));
    const moving = cards.filter((card) =>
      rowOfColumns ? card.type === "column" : card.type !== "column"
    );
    if (!moving.length) {
      ui.line.hidden = true;
      ui.ghost.hidden = true;
      gesture.dropTarget = null;
      clearDropPreview();
      return;
    }
    const innerX = column.x + COLUMN_PADDING;
    const innerY = column.y + COLUMN_HEADER;
    const innerH = Math.max(80, column.h - COLUMN_HEADER - COLUMN_PADDING);
    let slotX = innerX;
    let index = 0;
    for (const child of children) {
      if (point.x > child.x + child.w / 2) {
        slotX += child.w + COLUMN_GAP;
        index += 1;
      } else {
        break;
      }
    }
    const ghostW = Math.max(
      120,
      moving.reduce((sum, card) => sum + (Number(card.w) || 120), 0) +
        COLUMN_GAP * Math.max(0, moving.length - 1)
    );
    ui.line.classList.add("is-vertical");
    ui.line.hidden = false;
    ui.ghost.hidden = false;
    ui.origin.hidden = !gesture.wasChild;
    if (gesture.wasChild) paintOriginGhost(ui, moving[0]);
    Object.assign(ui.line.style, {
      left: `${slotX - 1}px`,
      top: `${innerY}px`,
      width: "3px",
      height: `${innerH}px`,
    });
    Object.assign(ui.ghost.style, {
      left: `${slotX}px`,
      top: `${innerY}px`,
      width: `${ghostW}px`,
      height: `${innerH}px`,
    });
    gesture.dropTarget = { columnId: column.id, index };
    previewDrop(column, point, {
      width: ghostW,
      height: Math.max(56, ...moving.map((card) => Number(card.h) || 56)),
      label: "Drop",
      excludeIds: dragged,
    });
    return;
  }
  if (cards.every((card) => card.type === "column")) {
    ui.line.hidden = true;
    ui.ghost.hidden = true;
    gesture.dropTarget = null;
    clearDropPreview();
    return;
  }
  ui.line.classList.remove("is-vertical");

  const children = columnChildren(state.board, column.id).filter(
    (card) => !dragged.has(card.id)
  );
  const innerX = column.x + COLUMN_PADDING;
  const innerW = column.w - COLUMN_PADDING * 2;
  let slotY = column.y + COLUMN_HEADER;
  let index = 0;
  for (const child of children) {
    if (point.y > child.y + child.h / 2) {
      slotY += child.h + COLUMN_GAP;
      index += 1;
    } else {
      break;
    }
  }
  // Existing cards keep their measured height when previewed inside a column, so the reservation
  // matches the card that will actually be dropped instead of a fitted media aspect estimate.
  const ghostHeight =
    cards.reduce((total, card) => total + Math.max(56, Number(card.h) || 56), 0) +
    Math.max(0, cards.length - 1) * COLUMN_GAP;
  Object.assign(ui.line.style, {
    left: `${innerX}px`,
    top: `${slotY - 6}px`,
    width: `${innerW}px`,
    height: "3px",
  });
  Object.assign(ui.ghost.style, {
    left: `${innerX}px`,
    top: `${slotY}px`,
    width: `${innerW}px`,
    height: `${ghostHeight}px`,
  });
  ui.line.hidden = false;
  ui.ghost.hidden = false;
  ui.origin.hidden = !gesture.wasChild;
  if (gesture.wasChild) paintOriginGhost(ui, cards[0]);
  gesture.dropTarget = { columnId: column.id, index };
  previewDrop(column, point, {
    width: innerW,
    height: ghostHeight,
    label: "Drop",
    excludeIds: dragged,
  });
}

function paintOriginGhost(ui, card) {
  const origin = gesture.origins.get(card.id);
  if (!origin) {
    ui.origin.hidden = true;
    return;
  }
  const column = card.parentId ? getCard(state.board, card.parentId) : null;
  Object.assign(ui.origin.style, {
    left: `${origin.x}px`,
    top: `${origin.y}px`,
    width: `${origin.w}px`,
    height: `${origin.h}px`,
    zIndex: String(((column && column.z) || 1) * 1000 + 1),
  });
  ui.origin.hidden = false;
}

function columnDepth(column) {
  let depth = 0;
  let parent = column.parentId ? getCard(state.board, column.parentId) : null;
  while (parent) {
    depth += 1;
    parent = parent.parentId ? getCard(state.board, parent.parentId) : null;
  }
  return depth;
}

function rowOfColumns(column) {
  if (!column || column.type !== "column" || column.direction !== "row") return false;
  if (column.kanban) return true;
  const children = columnChildren(state.board, column.id);
  return children.length > 0 && children.every((card) => card.type === "column");
}

function findColumnAt(point, excludeIds = new Set(), preferRowForColumnDrag = false) {
  const columns = state.board.cards
    .filter(
      (card) =>
        card.type === "column" &&
        !excludeIds.has(card.id) &&
        point.x >= card.x &&
        point.x <= card.x + card.w &&
        point.y >= card.y &&
        point.y <= card.y + card.h
    )
    // A child column inside a kanban sits on top of its row parent. Prefer the deepest matching
    // column so a card can be dropped into the lane, not rejected by the parent row.
    .sort((a, b) => columnDepth(b) - columnDepth(a) || (b.z || 1) - (a.z || 1));
  const deepest = columns[0] || null;
  if (!preferRowForColumnDrag || !deepest) return deepest;
  // A dragged column belongs to the row, not to a sibling lane. Walk up to the kanban row so the
  // horizontal insertion preview can show its new lane position.
  let candidate = deepest;
  while (candidate) {
    if (rowOfColumns(candidate)) return candidate;
    candidate = candidate.parentId ? getCard(state.board, candidate.parentId) : null;
  }
  return deepest;
}

function nearestCardSnap(world) {
  // Tight enough to keep a free endpoint in empty space next to a card.
  const threshold = 14;
  let best = null;
  for (const card of state.board.cards) {
    if (card.type === "column" && card.collapsed) continue;
    if (card.parentId) {
      const parent = getCard(state.board, card.parentId);
      if (parent?.collapsed) continue;
    }
    const right = card.x + card.w;
    const bottom = card.y + card.h;
    const inside =
      world.x >= card.x && world.x <= right && world.y >= card.y && world.y <= bottom;
    let px = Math.min(Math.max(world.x, card.x), right);
    let py = Math.min(Math.max(world.y, card.y), bottom);
    let distance = 0;
    if (inside) {
      const dl = world.x - card.x;
      const dr = right - world.x;
      const dt = world.y - card.y;
      const db = bottom - world.y;
      const min = Math.min(dl, dr, dt, db);
      if (min === dl) px = card.x;
      else if (min === dr) px = right;
      else if (min === dt) py = card.y;
      else py = bottom;
    } else {
      distance = Math.hypot(world.x - px, world.y - py);
      if (distance > threshold) continue;
    }
    if (!best || distance < best.distance) {
      best = { cardId: card.id, point: { x: px, y: py }, distance };
    }
  }
  return best;
}

function drawPathData(points) {
  return points
    .map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");
}

function eraseDrawingAt(event) {
  const target = document.elementFromPoint(event.clientX, event.clientY);
  const cardEl = target?.closest?.(".mn-card-drawing");
  if (!cardEl) return;
  const card = getCard(state.board, cardEl.dataset.id);
  if (card) deleteCards([card.id]);
}

function beginDrawGesture(event, mode) {
  if (mode === "eraser") {
    gesture = { type: "erase" };
    eraseDrawingAt(event);
    return;
  }
  const point = worldOf(event);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "mn-draw-preview");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "3");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  cardsEl.append(svg);
  gesture = { type: "draw", points: [point], path, svg };
}

function finishFreehand(current) {
  current.svg.remove();
  if (current.points.length < 2) return;
  const strokeWidth = 3;
  const pad = strokeWidth / 2 + 2;
  const xs = current.points.map((point) => point.x);
  const ys = current.points.map((point) => point.y);
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const width = Math.max(6, Math.max(...xs) - Math.min(...xs) + pad * 2);
  const height = Math.max(6, Math.max(...ys) - Math.min(...ys) + pad * 2);
  const points = current.points.map((point) => ({
    x: Number((point.x - minX).toFixed(2)),
    y: Number((point.y - minY).toFixed(2)),
  }));
  addCard("drawing", minX, minY, {
    w: Math.round(width),
    h: Math.round(height),
    aspect: width / height,
    points,
    strokeWidth,
  });
}

function beginLineDrag(event) {
  const world = worldOf(event);
  const snap = nearestCardSnap(world);
  const draft = {
    id: `draft-${Date.now()}`,
    draft: true,
    from: snap ? snap.cardId : null,
    fromPoint: snap ? null : { x: world.x, y: world.y },
    to: null,
    toPoint: snap ? { x: world.x, y: world.y } : null,
    curve: null,
  };
  state.board.connections = state.board.connections || [];
  state.board.connections.push(draft);
  state.connectionSelection = null;
  gesture = { type: "line", draft, start: world, moved: false };
  renderConnections();
}

function onConnectionPointerDown(event) {
  const handle = event.target.closest(".mn-line-handle");
  const hit = event.target.closest(".mn-connection-hit");
  const target = handle || hit;
  if (!target) return false;
  const connection = (state.board.connections || []).find(
    (entry) => entry.id === target.dataset.connection
  );
  if (!connection) return false;
  event.preventDefault();
  event.stopPropagation();
  state.connectionSelection = connection.id;
  if (handle?.dataset.lineEnd) {
    checkpoint();
    gesture = { type: "line-end", connection, end: handle.dataset.lineEnd };
  } else if (handle?.dataset.lineMid) {
    checkpoint();
    gesture = { type: "line-mid", connection };
  }
  renderConnections();
  return true;
}

// ------------------------------------------------------------------ wheel

function onWheel(event) {
  if (!state.board) return;
  const table = event.target.closest?.(".mn-table");
  if (
    table &&
    (table.scrollHeight > table.clientHeight || table.scrollWidth > table.clientWidth)
  ) {
    return;
  }
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) {
    const rect = viewportEl.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const worldX = (px - state.view.x) / state.view.zoom;
    const worldY = (py - state.view.y) / state.view.zoom;
    const factor = Math.exp(-event.deltaY * 0.0022);
    const zoom = Math.min(4, Math.max(0.15, state.view.zoom * factor));
    state.view.zoom = zoom;
    state.view.x = px - worldX * zoom;
    state.view.y = py - worldY * zoom;
    notify("view");
    renderView();
    return;
  }
  state.view.x -= event.deltaX;
  state.view.y -= event.deltaY;
  notify("view");
  renderView();
}

// ------------------------------------------------------------------ dblclick

function onViewportDblClick(event) {
  if (!state.board) return;
  if (event.target.closest(".mn-zoom")) return;
  if (event.target.closest(".mn-card")) return;
  const point = worldOf(event);
  window.dispatchEvent(new CustomEvent("mn:create-note-at", { detail: point }));
}

function onCardDblClick(event) {
  const cardEl = event.target.closest(".mn-card");
  if (!cardEl || !state.board) return;
  const card = getCard(state.board, cardEl.dataset.id);
  if (!card || card.locked) return;

  if (card.type === "document") {
    window.dispatchEvent(new CustomEvent("mn:open-document", { detail: { cardId: card.id } }));
    return;
  }
  if (card.type === "sketch") {
    window.dispatchEvent(new CustomEvent("mn:open-drawing", { detail: { cardId: card.id } }));
    return;
  }
  if (card.type === "image") {
    window.dispatchEvent(new CustomEvent("mn:pick-image", { detail: { cardId: card.id } }));
    return;
  }
  if (card.type === "color") {
    window.dispatchEvent(new CustomEvent("mn:pick-color", { detail: { cardId: card.id } }));
    return;
  }

  const itemText = event.target.closest("[data-item-text]");
  if (itemText) {
    beginTextEdit(card, itemText);
    return;
  }
  const cell = event.target.closest("[data-cell]");
  if (cell) {
    setEditable(cell, true);
    cell.focus();
    return;
  }
  const field = event.target.closest("[data-field]");
  if (field) {
    if (field.tagName === "INPUT") {
      field.focus();
      field.select?.();
    } else {
      beginTextEdit(card, field);
    }
    return;
  }
  const firstEditable = cardEl.querySelector('[data-field="text"], [data-field="title"]');
  if (firstEditable) {
    if (firstEditable.tagName === "INPUT") firstEditable.focus();
    else beginTextEdit(card, firstEditable);
  }
}

function beginTextEdit(card, el) {
  if (state.editing && state.editing.el === el) return;
  setEditable(el, true);
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  state.editing = { id: card.id, el };
}

function clearKanbanPointerTargets() {
  gesture?.line?.remove();
  if (gesture) gesture.line = null;
  viewportEl
    .querySelectorAll(".mn-kanban-col.is-kanban-target")
    .forEach((el) => el.classList.remove("is-kanban-target"));
}

function beginKanbanItemDrag(event, row) {
  const cardEl = row.closest(".mn-card-kanban");
  if (!cardEl) return;
  const card = getCard(state.board, cardEl.dataset.id);
  const column = card?.columns?.find((entry) => entry.id === row.dataset.kanbanColId);
  const item = column?.items?.find((entry) => entry.id === row.dataset.kanbanItemRow);
  if (!card || !column || !item) return;
  const ghost = document.createElement("div");
  ghost.className = "mn-kanban-drag-ghost";
  ghost.textContent = item.text || "Card";
  ghost.style.left = `${event.clientX + 12}px`;
  ghost.style.top = `${event.clientY + 12}px`;
  document.body.append(ghost);
  row.classList.add("is-dragging-kanban");
  viewportEl.classList.add("is-kanban-dragging");
  gesture = {
    type: "kanban-item",
    card,
    column,
    item,
    row,
    ghost,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
    target: null,
    line: null,
  };
}

function kanbanTargetAt(event) {
  if (!gesture || gesture.type !== "kanban-item") return null;
  const columnEl = document
    .elementFromPoint(event.clientX, event.clientY)
    ?.closest(".mn-kanban-col");
  if (!columnEl) return null;
  const cardEl = columnEl.closest(".mn-card-kanban");
  if (!cardEl) return null;
  const card = getCard(state.board, cardEl.dataset.id);
  const column = card?.columns?.find((entry) => entry.id === columnEl.dataset.kanbanColumn);
  if (!card || !column) return null;
  const container = columnEl.querySelector(".mn-kanban-items");
  const rows = [...(container?.querySelectorAll(".mn-kanban-item") || [])].filter(
    (row) => row !== gesture.row
  );
  let index = rows.length;
  for (let i = 0; i < rows.length; i += 1) {
    const rect = rows[i].getBoundingClientRect();
    if (event.clientY < rect.top + rect.height / 2) {
      index = i;
      break;
    }
  }
  return { card, column, columnEl, index };
}

function updateKanbanDropTarget(event) {
  clearKanbanPointerTargets();
  const target = kanbanTargetAt(event);
  gesture.target = target;
  if (!target) return;
  target.columnEl.classList.add("is-kanban-target");
  const container = target.columnEl.querySelector(".mn-kanban-items");
  if (!container) return;
  const rows = [...container.querySelectorAll(".mn-kanban-item")].filter(
    (row) => row !== gesture.row
  );
  const line = document.createElement("div");
  line.className = "mn-kanban-drop-line";
  if (target.index >= rows.length) container.append(line);
  else container.insertBefore(line, rows[target.index]);
  gesture.line = line;
}

function finishKanbanItemDrag(current) {
  current.ghost.remove();
  current.row.classList.remove("is-dragging-kanban");
  viewportEl.classList.remove("is-kanban-dragging");
  current.line?.remove();
  viewportEl
    .querySelectorAll(".mn-kanban-col.is-kanban-target")
    .forEach((el) => el.classList.remove("is-kanban-target"));
  if (!current.moved || !current.target) return;
  const target = current.target;
  checkpoint();
  const source = current.column;
  const fromIndex = source.items.indexOf(current.item);
  if (fromIndex < 0) return;
  source.items.splice(fromIndex, 1);
  target.column.items.splice(Math.min(target.index, target.column.items.length), 0, current.item);
  markDirty("board");
}

function beginSheetAdd(card, kind, event) {
  const rows = card.cells || [[""]];
  checkpoint();
  gesture = {
    type: "sheet-add",
    id: card.id,
    kind,
    startX: event.clientX,
    startY: event.clientY,
    added: 0,
    removeCount: 0,
    startColumns: Math.max(1, ...rows.map((row) => row.length)),
    startRows: rows.length,
  };
  viewportEl.classList.add("is-resizing");
}

function removeSheetColumns(card, count) {
  const columns = Math.max(1, ...(card.cells || [[""]]).map((row) => row.length));
  const remove = Math.min(count, columns - 1);
  if (remove <= 0) return;
  const start = columns - remove;
  const hasData = (card.cells || []).some((row) =>
    row.slice(start).some((cell) => String(cell || "").trim())
  );
  const apply = () => {
    checkpoint();
    card.cells = (card.cells || []).map((row) => row.slice(0, columns - remove));
    if (Array.isArray(card.colWidths)) {
      card.colWidths = card.colWidths.slice(0, columns - remove);
      card.w = card.colWidths.reduce((sum, width) => sum + width, 0) + 4;
    } else {
      card.w = Math.max(260, card.w - remove * 80);
    }
    markDirty("board");
  };
  if (!hasData) {
    apply();
    return;
  }
  confirmAction({
    title: "Delete column?",
    message: `${remove} ending column${remove === 1 ? " contains" : "s contain"} data. Delete ${remove === 1 ? "it" : "them"}?`,
    confirmLabel: "Delete",
  }).then((confirmed) => {
    if (confirmed) apply();
  });
}

function removeSheetRows(card, count) {
  const rows = card.cells || [];
  const remove = Math.min(count, rows.length - 1);
  if (remove <= 0) return;
  const start = rows.length - remove;
  const hasData = rows
    .slice(start)
    .some((row) => row.some((cell) => String(cell || "").trim()));
  const apply = () => {
    checkpoint();
    card.cells = rows.slice(0, rows.length - remove);
    markDirty("board");
  };
  if (!hasData) {
    apply();
    return;
  }
  confirmAction({
    title: "Delete rows?",
    message: `${remove} ending row${remove === 1 ? " contains" : "s contain"} data. Delete ${remove === 1 ? "it" : "them"}?`,
    confirmLabel: "Delete",
  }).then((confirmed) => {
    if (confirmed) apply();
  });
}

function beginTodoItemDrag(card, itemId, event, row) {
  if (!card || card.type !== "todo" || !row) return;
  const item = (card.items || []).find((entry) => entry.id === itemId);
  if (!item) return;
  const ghost = document.createElement("div");
  ghost.className = "mn-todo-drag-ghost";
  ghost.textContent = item.text || "To-do item";
  ghost.style.left = `${event.clientX + 12}px`;
  ghost.style.top = `${event.clientY + 12}px`;
  document.body.append(ghost);
  row.classList.add("is-dragging-todo");
  gesture = {
    type: "todo-item",
    card,
    item,
    row,
    ghost,
    startY: event.clientY,
    moved: false,
    targetIndex: null,
    line: null,
  };
}

function updateTodoDropTarget(event) {
  if (!gesture?.line && !gesture) return;
  gesture.line?.remove();
  gesture.line = null;
  const list = gesture.row.closest(".mn-todo-items");
  if (!list) return;
  const rows = [...list.querySelectorAll(".mn-todo-item")].filter(
    (row) => row !== gesture.row
  );
  let index = rows.length;
  for (let i = 0; i < rows.length; i += 1) {
    const rect = rows[i].getBoundingClientRect();
    if (event.clientY < rect.top + rect.height / 2) {
      index = i;
      break;
    }
  }
  gesture.targetIndex = index;
  const line = document.createElement("div");
  line.className = "mn-todo-drop-line";
  if (index >= rows.length) list.append(line);
  else list.insertBefore(line, rows[index]);
  gesture.line = line;
}

function finishTodoItemDrag(current) {
  current.ghost.remove();
  current.row.classList.remove("is-dragging-todo");
  current.line?.remove();
  if (!current.moved || current.targetIndex === null) return;
  const items = current.card.items || [];
  const fromIndex = items.indexOf(current.item);
  if (fromIndex < 0) return;
  checkpoint();
  items.splice(fromIndex, 1);
  items.splice(Math.min(current.targetIndex, items.length), 0, current.item);
  markDirty("board");
}

function syncAutoHeight(card) {
  if (!card || card.type === "column" || card.type === "kanban") return;
  if (CARD_ASPECTS[card.type] || card.aspect) return;
  syncCardHeight(card);
}

function formatAudioTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function postVideoFrame(card, func, args = []) {
  const frame = cardElement(card.id)?.querySelector("iframe");
  if (!frame?.contentWindow) return false;
  if (/vimeo\.com/i.test(card.url || "")) {
    const method =
      func === "pauseVideo"
        ? "pause"
        : func === "playVideo"
          ? "play"
          : func === "seekTo"
            ? "setCurrentTime"
            : "setVolume";
    frame.contentWindow.postMessage(
      JSON.stringify({
        method,
        value:
          method === "setVolume"
            ? func === "mute"
              ? 0
              : func === "unMute"
                ? 1
                : args[0]
            : method === "setCurrentTime"
              ? args[0]
              : undefined,
      }),
      "*"
    );
  } else {
    frame.contentWindow.postMessage(
      JSON.stringify({ event: "command", func, args }),
      "*"
    );
  }
  return true;
}

function formatMediaTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function updateVideoControls(card) {
  const wrap = cardElement(card.id)?.querySelector(".mn-video");
  if (!wrap) return;
  const duration = Number(card.__mediaDuration) || 0;
  const time = Math.max(0, Math.min(Number(card.__mediaTime) || 0, duration || Infinity));
  const seek = wrap.querySelector("[data-video-seek]");
  if (seek && document.activeElement !== seek) {
    seek.value = String(duration ? Math.round((time / duration) * 1000) : 0);
    seek.style.setProperty("--video-progress", `${duration ? Math.min(100, (time / duration) * 100) : 0}%`);
  }
  const label = wrap.querySelector("[data-video-time]");
  if (label) label.textContent = `${formatMediaTime(time)} / ${formatMediaTime(duration)}`;
  wrap.classList.toggle("is-playing", Boolean(card.__mediaPlaying));
}

function onMediaFrameMessage(event) {
  if (!state.board) return;
  for (const card of state.board.cards) {
    if (card.type !== "video") continue;
    const frame = cardElement(card.id)?.querySelector("iframe");
    if (!frame || frame.contentWindow !== event.source) continue;
    let data = event.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        continue;
      }
    }
    if (data?.event !== "infoDelivery" || !data.info) continue;
    if (Number.isFinite(data.info.currentTime)) card.__mediaTime = data.info.currentTime;
    if (Number.isFinite(data.info.duration)) card.__mediaDuration = data.info.duration;
    if (data.info.playerState === 1) card.__mediaPlaying = true;
    if (data.info.playerState === 2) card.__mediaPlaying = false;
    updateVideoControls(card);
  }
}

function updateVideoUI(wrap, video = null) {
  if (!wrap) return;
  const playing = video ? !video.paused && !video.ended : wrap.classList.contains("is-playing");
  wrap.classList.toggle("is-playing", playing);
  wrap.classList.toggle("is-muted", video ? video.muted || video.volume === 0 : wrap.classList.contains("is-muted"));
  const volume = wrap.querySelector("[data-video-volume]");
  if (volume && video) {
    volume.value = String(Math.round((video.muted ? 0 : video.volume) * 1000));
  }
  if (video) {
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const seek = wrap.querySelector("[data-video-seek]");
    if (seek && document.activeElement !== seek) {
      seek.value = String(duration ? Math.round((video.currentTime / duration) * 1000) : 0);
      seek.style.setProperty("--video-progress", `${duration ? Math.min(100, (video.currentTime / duration) * 100) : 0}%`);
    }
    const label = wrap.querySelector("[data-video-time]");
    if (label) label.textContent = `${formatMediaTime(video.currentTime)} / ${formatMediaTime(duration)}`;
  }
}

function updateAudioUI(audio) {
  const wrap = audio.closest(".mn-audio");
  if (!wrap) return;
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
  const current = Math.max(0, Math.min(audio.currentTime || 0, duration || 0));
  wrap.classList.toggle("is-playing", !audio.paused && !audio.ended);
  wrap.classList.toggle("is-muted", audio.muted || audio.volume === 0);
  const time = wrap.querySelector(".mn-audio-time");
  if (time) time.textContent = `${formatAudioTime(current)} / ${formatAudioTime(duration)}`;
  const seek = wrap.querySelector("[data-audio-seek]");
  if (!seek) return;
  if (document.activeElement !== seek) {
    seek.value = String(duration ? Math.round((current / duration) * 1000) : 0);
  }
  seek.style.setProperty("--audio-progress", `${duration ? Math.min(100, (current / duration) * 100) : 0}%`);
  const volume = wrap.querySelector("[data-audio-volume]");
  if (volume && document.activeElement !== volume) {
    volume.value = String(Math.round((audio.muted ? 0 : audio.volume) * 1000));
  }
}

function onAudioMediaEvent(event) {
  if (event.target instanceof HTMLAudioElement) updateAudioUI(event.target);
  if (event.target instanceof HTMLVideoElement) {
    updateVideoUI(event.target.closest(".mn-video"), event.target);
  }
}

function onImageLoad(event) {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !state.board) return;
  const card = cardOfTarget(image);
  if (!card || card.type !== "image") return;
  if (!image.naturalWidth || !image.naturalHeight) return;
  const aspect = image.naturalWidth / image.naturalHeight;
  if (Math.abs((card.aspect || 0) - aspect) < 0.001) return;
  card.aspect = aspect;
  card.h = cardHeightFor(card);
  markDirty("geometry");
}

// ------------------------------------------------------------------ inputs

function onInput(event) {
  const target = event.target;
  const card = cardOfTarget(target);
  if (!card || !state.board) return;

  if (target.matches("[data-audio-seek]")) {
    const audio = cardElement(card.id)?.querySelector("audio");
    if (audio) {
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      audio.currentTime = (Number(target.value) / 1000) * duration;
      updateAudioUI(audio);
    }
    return;
  }
  if (target.matches("[data-audio-volume]")) {
    const audio = cardElement(card.id)?.querySelector("audio");
    if (audio) {
      audio.volume = Number(target.value) / 1000;
      audio.muted = false;
      updateAudioUI(audio);
    }
    return;
  }
  if (target.matches("[data-video-seek]")) {
    const wrap = cardElement(card.id)?.querySelector(".mn-video");
    const video = wrap?.querySelector("video");
    const duration = video
      ? Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : 0
      : Number(card.__mediaDuration) || 0;
    const time = (Number(target.value) / 1000) * duration;
    if (video) {
      video.currentTime = time;
      card.__mediaTime = time;
    } else if (wrap) {
      card.__mediaTime = time;
      postVideoFrame(card, "seekTo", [time, true]);
    }
    updateVideoControls(card);
    return;
  }
  if (target.matches("[data-video-volume]")) {
    const wrap = cardElement(card.id)?.querySelector(".mn-video");
    const video = wrap?.querySelector("video");
    const volume = Number(target.value) / 1000;
    if (video) {
      video.volume = volume;
      video.muted = false;
    } else if (wrap) {
      postVideoFrame(card, "setVolume", [
        /vimeo\.com/i.test(card.url || "") ? volume : Math.round(volume * 100),
      ]);
    }
    if (wrap) {
      wrap.classList.toggle("is-muted", volume === 0);
      card.__mediaVolume = volume;
      card.__mediaMuted = volume === 0;
    }
    return;
  }

  if (target.matches("[data-cell]")) {
    const [r, c] = target.dataset.cell.split(":").map(Number);
    card.cells[r][c] = target.innerText;
    markDirty("save");
    return;
  }
  if (target.matches("[data-item-text]")) {
    const item = (card.items || []).find((entry) => entry.id === target.dataset.itemText);
    if (item) item.text = target.innerText;
    markDirty("save");
    return;
  }
  if (target.matches("[data-kanban-col-title]")) {
    const column = (card.columns || []).find((entry) => entry.id === target.dataset.kanbanColTitle);
    if (column) column.title = target.value;
    markDirty("save");
    return;
  }
  if (target.matches("[data-kanban-item]")) {
    const column = (card.columns || []).find((entry) => entry.id === target.dataset.kanbanColId);
    const item = column && (column.items || []).find((entry) => entry.id === target.dataset.kanbanItem);
    if (item) item.text = target.value;
    markDirty("save");
    return;
  }
  const field = target.closest("[data-field]");
  if (field) {
    const name = field.dataset.field;
    if (name === "comment-draft") return;
    card[name] = field.innerText !== undefined && field.tagName !== "INPUT" ? field.innerText : field.value;
    markDirty("save");
    if (card.type === "document" && name === "text") updateWordCount(target, card.text);
    if ((card.type === "note" || card.type === "heading") && name === "text") {
      card.html = sanitizeHtml(field.innerHTML);
      syncCardHeight(card);
    }
    return;
  }
}

function updateWordCount(target, text) {
  const doc = target.closest(".mn-doc");
  const counter = doc && doc.querySelector('[data-role="wordcount"]');
  if (!counter) return;
  const words = text && text.trim() ? text.trim().split(/\s+/).length : 0;
  counter.textContent = `${words} word${words === 1 ? "" : "s"}`;
}

function onChange(event) {
  const target = event.target;
  const card = cardOfTarget(target);
  if (!card) return;
  if (target.matches("[data-item-check]")) {
    const item = (card.items || []).find((entry) => entry.id === target.dataset.itemCheck);
    if (item) {
      item.done = target.checked;
      const row = target.closest(".mn-todo-item");
      if (row) row.classList.toggle("is-done", item.done);
      markDirty("save");
    }
    return;
  }
  if (target.matches("[data-msg-check]")) {
    const message = (card.messages || []).find((entry) => entry.id === target.dataset.msgCheck);
    if (message) {
      message.done = target.checked;
      const row = target.closest(".mn-msg");
      if (row) row.classList.toggle("is-done", message.done);
      markDirty("save");
    }
    return;
  }
  const field = target.closest("[data-field]");
  if (field) {
    card[field.dataset.field] = target.value;
    if (card.type === "link" && field.dataset.field === "url") {
      normalizeLink(card);
      maybeAutoLinkHeader(card.id);
    }
    if (
      ["video", "map"].includes(card.type) &&
      ["url", "query"].includes(field.dataset.field)
    ) {
      delete card.__editEmbed;
      markDirty("save");
      return;
    }
    if (card.type === "audio" && field.dataset.field === "url") {
      delete card.__editEmbed;
      markDirty("save");
      refreshCard(card.id);
      syncAutoHeight(card);
      return;
    }
    markDirty("save");
    syncAutoHeight(card);
  }
}

function normalizeLink(card) {
  if (!card.url) return;
  let url = card.url.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  card.url = url;
  if (!card.title) {
    try {
      card.title = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      /* keep empty */
    }
  }
}

// ------------------------------------------------------------------ clicks

function onClick(event) {
  // A click that follows a drag must not trigger card actions (for example opening a board card).
  if (Date.now() - dragEndedAt < 250) return;
  const actionEl = event.target.closest("[data-action]");
  const card = cardOfTarget(event.target);
  if (!card) return;
  if (event.target.closest("[data-item-remove]")) {
    const id = event.target.closest("[data-item-remove]").dataset.itemRemove;
    card.items = (card.items || []).filter((item) => item.id !== id);
    markDirty("save");
    refreshCard(card.id);
    syncAutoHeight(card);
    return;
  }
  if (!actionEl) return;
  const action = actionEl.dataset.action;
  switch (action) {
    case "add-todo": {
      const item = { id: uid("i"), text: "", done: false };
      card.items = card.items || [];
      card.items.push(item);
      markDirty("save");
      refreshCard(card.id);
      syncAutoHeight(card);
      const target = cardElement(card.id)?.querySelector(`[data-item-text="${item.id}"]`);
      if (target) {
        setEditable(target, true);
        target.focus();
      }
      break;
    }
    case "send-comment": {
      const cardEl = cardElement(card.id);
      const input = cardEl?.querySelector('[data-field="comment-draft"]');
      const text = (input?.value || "").trim();
      if (!text) {
        input?.focus();
        break;
      }
      card.messages = card.messages || [];
      card.messages.push({ id: uid("m"), author: "You", text, ts: Date.now() });
      markDirty("save");
      refreshCard(card.id);
      syncAutoHeight(card);
      cardElement(card.id)?.querySelector('[data-field="comment-draft"]')?.focus();
      break;
    }
    case "kanban-add-column": {
      checkpoint();
      card.columns = card.columns || [];
      const titles = ["Backlog", "In progress", "Done"];
      card.columns.push({
        id: uid("k"),
        title: titles[card.columns.length] || `Column ${card.columns.length + 1}`,
        items: [],
      });
      card.w = card.fullWidth ? Math.max(card.w, kanbanWidth(card.columns.length)) : kanbanWidth(card.columns.length);
      markDirty("board");
      break;
    }
    case "kanban-remove-column": {
      const columnId = actionEl.dataset.kanbanCol;
      checkpoint();
      card.columns = (card.columns || []).filter((column) => column.id !== columnId);
      card.w = card.fullWidth ? Math.max(card.w, kanbanWidth(card.columns.length)) : kanbanWidth(card.columns.length);
      markDirty("board");
      break;
    }
    case "kanban-add-item": {
      const columnId = actionEl.dataset.kanbanCol;
      const column = (card.columns || []).find((entry) => entry.id === columnId);
      if (!column) break;
      checkpoint();
      const item = { id: uid("ki"), text: "" };
      column.items = column.items || [];
      column.items.push(item);
      markDirty("board");
      window.setTimeout(() => {
        cardElement(card.id)?.querySelector(`[data-kanban-item="${item.id}"]`)?.focus();
      }, 40);
      break;
    }
    case "kanban-remove-item": {
      const columnId = actionEl.dataset.kanbanCol;
      const itemId = actionEl.dataset.kanbanItem;
      checkpoint();
      const column = (card.columns || []).find((entry) => entry.id === columnId);
      if (column) column.items = (column.items || []).filter((item) => item.id !== itemId);
      markDirty("board");
      break;
    }
    case "toggle-column": {
      checkpoint();
      card.collapsed = !card.collapsed;
      if (card.collapsed) card.h = Math.max(96, card.minHeight || 96);
      markDirty("board");
      break;
    }
    case "comment-menu": {
      const messageId = actionEl.dataset.msg;
      const rect = actionEl.getBoundingClientRect();
      window.dispatchEvent(
        new CustomEvent("mn:open-menu", {
          detail: {
            x: rect.left,
            y: rect.bottom + 4,
            items: [
              {
                text: "Delete comment",
                danger: true,
                onClick: () => {
                  checkpoint();
                  card.messages = (card.messages || []).filter((message) => message.id !== messageId);
                  markDirty("board");
                },
              },
            ],
          },
        })
      );
      break;
    }
    case "table-add-toggle": {
      const cardEl = cardElement(card.id);
      const menu = cardEl?.querySelector(".mn-table-menu");
      if (menu) menu.hidden = !menu.hidden;
      break;
    }
    case "table-add-row": {
      checkpoint();
      const rows = card.cells || [["", "", ""]];
      const columns = Math.max(1, ...rows.map((row) => row.length));
      card.cells = rows;
      card.cells.push(new Array(columns).fill(""));
      markDirty("board");
      break;
    }
    case "table-add-column": {
      checkpoint();
      card.cells = (card.cells || [["", "", ""]]).map((row) => [...row, ""]);
      card.w = Math.max(260, card.w + 80);
      if (Array.isArray(card.colWidths)) card.colWidths.push(80);
      markDirty("board");
      break;
    }
    case "open-link":
      openLink(card.url);
      break;
    case "open-board":
      openBoardCard(card);
      break;
    case "pick-color": {
      const original = /^#[0-9a-f]{6}$/i.test(card.color) ? card.color.toUpperCase() : "#B262C0";
      let changed = false;
      openColorPicker({
        color: original,
        anchor: cardElement(card.id) || actionEl,
        onChange: (hex) => {
          if (!changed) {
            checkpoint();
            changed = true;
          }
          card.color = hex;
          card.name = colorNameForHex(hex);
          refreshColorPreview(card);
          markDirty("save");
        },
      });
      break;
    }
    case "copy-color": {
      const value = actionEl.dataset.copy || "";
      navigator.clipboard
        .writeText(value)
        .then(() => toast(`${value} copied`))
        .catch(() => toast("Could not copy the color code"));
      break;
    }
    case "add-image":
      window.dispatchEvent(new CustomEvent("mn:pick-image", { detail: { cardId: card.id } }));
      break;
    case "upload-audio":
      window.dispatchEvent(new CustomEvent("mn:pick-audio", { detail: { cardId: card.id } }));
      break;
    case "start-video": {
      card.__mediaStarted = true;
      card.__mediaPlaying = true;
      const wrap = cardElement(card.id);
      const video = wrap?.querySelector("video");
      if (video) {
        wrap.classList.add("is-started");
        video.play().catch(() => toast("This video cannot be played."));
      } else {
        refreshCard(card.id);
      }
      break;
    }
    case "video-back5":
    case "video-forward5": {
      const delta = action === "video-back5" ? -5 : 5;
      const wrap = cardElement(card.id)?.querySelector(".mn-video");
      const video = wrap?.querySelector("video");
      if (video) {
        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
        video.currentTime = Math.max(
          0,
          Math.min(duration || video.currentTime + delta, video.currentTime + delta)
        );
        card.__mediaTime = video.currentTime;
      } else if (wrap) {
        const duration = Number(card.__mediaDuration) || 0;
        const next = Math.max(0, Math.min(duration || Infinity, (Number(card.__mediaTime) || 0) + delta));
        card.__mediaTime = next;
        postVideoFrame(card, "seekTo", [next, true]);
      }
      updateVideoControls(card);
      break;
    }
    case "video-toggle": {
      const wrap = cardElement(card.id)?.querySelector(".mn-video");
      const video = wrap?.querySelector("video");
      if (video) {
        if (video.paused) video.play().catch(() => {});
        else video.pause();
        card.__mediaPlaying = !video.paused;
      } else if (wrap) {
        postVideoFrame(card, card.__mediaPlaying ? "pauseVideo" : "playVideo");
        card.__mediaPlaying = !card.__mediaPlaying;
      }
      updateVideoUI(wrap, video);
      break;
    }
    case "video-mute": {
      const wrap = cardElement(card.id)?.querySelector(".mn-video");
      const video = wrap?.querySelector("video");
      if (video) {
        video.muted = !video.muted;
        card.__mediaMuted = video.muted;
        updateVideoUI(wrap, video);
      } else if (wrap) {
        card.__mediaMuted = !card.__mediaMuted;
        postVideoFrame(card, card.__mediaMuted ? "mute" : "unMute");
        wrap.classList.toggle("is-muted", card.__mediaMuted);
      }
      break;
    }
    case "audio-toggle": {
      const audio = cardElement(card.id)?.querySelector("audio");
      if (!audio) break;
      if (audio.paused) {
        audio.play().catch(() => toast("This audio file cannot be played. Try MP3, WAV, M4A or OGG."));
      } else {
        audio.pause();
      }
      break;
    }
    case "audio-mute": {
      const audio = cardElement(card.id)?.querySelector("audio");
      if (!audio) break;
      audio.muted = !audio.muted;
      updateAudioUI(audio);
      break;
    }
    case "edit-embed":
      card.__editEmbed = true;
      refreshCard(card.id);
      cardElement(card.id)?.querySelector("[data-field]")?.focus();
      break;
    case "submit-embed": {
      const input = cardElement(card.id)?.querySelector("input[data-field]");
      const value = (input?.value || "").trim();
      const field = card.type === "map" ? "query" : "url";
      if (value) card[field] = value;
      delete card.__editEmbed;
      if (card.type === "video") {
        card.h = Math.max(card.h || 0, Math.round(card.w * (9 / 16)));
      }
      if (card.type === "map") {
        card.h = Math.max(card.h || 0, 190);
      }
      markDirty("board");
      refreshCard(card.id);
      syncAutoHeight(card);
      break;
    }
    case "open-file":
      if (card.path) bridge.openPath(card.path).catch(() => {});
      break;
    case "download-file":
      downloadCardAsset(card)
        .then((destination) =>
          toast(destination ? `Downloaded ${destination.split(/[\\/]/).pop()}` : "Nothing to download")
        )
        .catch(() => toast("Could not download this asset"));
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------ keyboard

function onCardKeyDown(event) {
  const target = event.target;
  if (event.key === "Escape") {
    target.blur();
    event.stopPropagation();
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    if (
      target.matches(
        "input.mn-link-title, input.mn-todo-title, input.mn-doc-title, input.mn-color-name, input.mn-image-caption, .mn-column-title[contenteditable='true']"
      )
    ) {
      target.blur();
      event.preventDefault();
    }
  }
}

function onFocusOut(event) {
  const target = event.target;
  if (target.isContentEditable) {
    setEditable(target, false);
    if (state.editing && state.editing.el === target) state.editing = null;
    const card = cardOfTarget(target);
    if (card) {
      if (card.type === "note" || card.type === "heading") {
        if (target.matches('[data-field="text"]')) {
          card.text = target.innerText || "";
          card.html = sanitizeHtml(target.innerHTML);
        }
        markDirty("board");
        return;
      }
    }
    markDirty("save");
  }
  if (target.matches("input.mn-link-url, input[data-field='url']")) {
    const card = cardOfTarget(target);
    if (card && card.type === "link") {
      normalizeLink(card);
      markDirty("board");
    }
  }
}

function onWindowKeyDown(event) {
  if (event.code === "Space" && !isTypingTarget(document.activeElement)) {
    if (!spaceHeld) {
      spaceHeld = true;
      viewportEl?.classList.add("is-space");
    }
    event.preventDefault();
  }
}

function onWindowKeyUp(event) {
  if (event.code === "Space") {
    spaceHeld = false;
    viewportEl?.classList.remove("is-space");
  }
}
