// Live drop preview: while a card or rail tool hovers a column/row, reserve its slot by shifting the
// existing children and growing the container before the actual drop. This is DOM-only; the board
// state is committed by the normal drop path after pointerup.
import { columnChildren } from "./model.js";
import { cardElement } from "./render.js";
import { state } from "./store.js";

let preview = null;
let sequence = 0;

function number(value, fallback = 0) {
  const parsed = Number.parseFloat(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function childrenFor(column, excludeIds) {
  const excluded = new Set(excludeIds || []);
  return columnChildren(state.board, column.id).filter(
    (child) => !excluded.has(child.id)
  );
}

function insertionIndex(column, point, children) {
  const key = column.direction === "row" ? "x" : "y";
  let index = 0;
  for (const child of children) {
    const position = key === "x" ? child.x : child.y;
    const size = key === "x" ? child.w : child.h;
    if (point[key] > position + size / 2) index += 1;
    else break;
  }
  return index;
}

function clearPreview() {
  if (!preview) return;
  for (const entry of preview.shifted) {
    entry.el.style.left = entry.left;
    entry.el.style.top = entry.top;
  }
  if (preview.columnEl) {
    preview.columnEl.style.width = preview.columnWidth;
    preview.columnEl.style.height = preview.columnHeight;
    preview.columnEl.classList.remove("is-drop-preview-shifting");
  }
  preview.placeholder?.remove();
  preview = null;
}

export function clearDropPreview() {
  clearPreview();
}

/**
 * Reserve a slot in a column (vertical) or row (horizontal) at `point`.
 * Returns the insertion index so callers can reuse it when committing the drop.
 */
export function previewDrop(column, point, { width = 160, height = 70, label = "Drop", excludeIds = [] } = {}) {
  if (!state.board || !column) {
    clearPreview();
    return 0;
  }
  const children = childrenFor(column, excludeIds);
  const index = insertionIndex(column, point, children);
  const row = column.direction === "row";
  const gap = 10;
  const padding = 14;
  const header = 64;
  const columnEl = cardElement(column.id);
  if (!columnEl) {
    clearPreview();
    return index;
  }

  // Keep a stable preview while the pointer stays in the same slot; only rebuild when it changes.
  const key = `${column.id}:${index}:${row ? width : height}:${label}`;
  if (preview?.key === key) return index;
  clearPreview();

  const placeholder = document.createElement("div");
  placeholder.className = "mn-drop-reservation";
  placeholder.dataset.column = column.id;
  placeholder.dataset.index = String(index);
  placeholder.style.position = "absolute";
  placeholder.style.zIndex = "500000";
  placeholder.style.pointerEvents = "none";
  const inner = document.createElement("span");
  inner.textContent = label;
  placeholder.append(inner);

  const shifted = [];
  const entries = [];
  if (row) {
    const innerH = Math.max(56, column.h - header - padding);
    let x = column.x + padding;
    for (let i = 0; i < index; i += 1) x += children[i].w + gap;
    const reserve = Math.max(80, Number(width) || 160);
    Object.assign(placeholder.style, {
      left: `${x}px`,
      top: `${column.y + header}px`,
      width: `${reserve}px`,
      height: `${innerH}px`,
    });
    for (let i = index; i < children.length; i += 1) {
      const child = children[i];
      const el = cardElement(child.id);
      if (!el) continue;
      shifted.push({ el, left: el.style.left, top: el.style.top });
      entries.push({ el, property: "left", value: number(el.style.left, child.x) + reserve + gap });
    }
    const nextWidth = number(columnEl.style.width, column.w) + reserve + gap;
    preview = {
      key,
      columnEl,
      columnWidth: columnEl.style.width,
      columnHeight: columnEl.style.height,
      shifted,
      placeholder,
    };
    columnEl.style.width = `${nextWidth}px`;
    columnEl.classList.add("is-drop-preview-shifting");
    for (const entry of entries) entry.el.style[entry.property] = `${entry.value}px`;
  } else {
    const innerW = Math.max(120, column.w - padding * 2);
    let y = column.y + header;
    for (let i = 0; i < index; i += 1) y += children[i].h + gap;
    const reserve = Math.max(56, Number(height) || 70);
    Object.assign(placeholder.style, {
      left: `${column.x + padding}px`,
      top: `${y}px`,
      width: `${innerW}px`,
      height: `${reserve}px`,
    });
    for (let i = index; i < children.length; i += 1) {
      const child = children[i];
      const el = cardElement(child.id);
      if (!el) continue;
      shifted.push({ el, left: el.style.left, top: el.style.top });
      entries.push({ el, property: "top", value: number(el.style.top, child.y) + reserve + gap });
    }
    const nextHeight = number(columnEl.style.height, column.h) + reserve + gap;
    preview = {
      key,
      columnEl,
      columnWidth: columnEl.style.width,
      columnHeight: columnEl.style.height,
      shifted,
      placeholder,
    };
    columnEl.style.height = `${nextHeight}px`;
    columnEl.classList.add("is-drop-preview-shifting");
    for (const entry of entries) entry.el.style[entry.property] = `${entry.value}px`;
  }
  columnEl.classList.add("is-drop-preview-shifting");
  placeholder.style.transition = "opacity 120ms ease";
  sequence += 1;
  placeholder.dataset.sequence = String(sequence);
  document.getElementById("cards")?.append(placeholder);
  return index;
}

export function dropPreviewIndex() {
  return preview ? Number(preview.placeholder?.dataset.index || 0) : null;
}
