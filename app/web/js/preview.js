// Shared mini preview painter used by the home gallery and nested board cards.

import { isTemporarilyDisabledType } from "./limits.js";

export const PREVIEW_TYPE_COLORS = {
  note: "var(--ky-palette-black-7, #ffffff)",
  heading: "var(--ky-palette-black-7, #ffffff)",
  link: "var(--ky-palette-black-7, #ffffff)",
  todo: "var(--ky-palette-black-7, #ffffff)",
  document: "var(--ky-palette-black-7, #ffffff)",
  comment: "var(--ky-palette-black-7, #ffffff)",
  table: "var(--ky-palette-black-7, #ffffff)",
  sketch: "var(--ky-palette-black-6, #fdfdfd)",
  image: "var(--ky-control-active, rgba(0,0,0,.1))",
  video: "var(--ky-control-active, rgba(0,0,0,.1))",
  map: "var(--ky-control-active, rgba(0,0,0,.1))",
  audio: "var(--ky-control, rgba(0,0,0,.05))",
  file: "var(--ky-control, rgba(0,0,0,.05))",
  board: "var(--ky-control, rgba(0,0,0,.05))",
  column: "var(--ky-palette-black-6, #fdfdfd)",
};

export function paintBoardPreview(container, doc, { emptyLabel = "Empty board", maxScale = 0.16 } = {}) {
  if (!container) return;
  container.innerHTML = "";
  const cards = ((doc && doc.cards) || []).filter(
    (card) => !isTemporarilyDisabledType(card.type)
  );
  container.classList.toggle("is-empty", cards.length === 0);
  if (!cards.length) {
    const empty = document.createElement("span");
    empty.className = "mn-project-preview-empty";
    empty.textContent = emptyLabel;
    container.append(empty);
    return;
  }
  const pad = 16;
  const box = container.getBoundingClientRect();
  const width = box.width || 220;
  const height = box.height || 120;
  const minX = Math.min(...cards.map((card) => card.x));
  const minY = Math.min(...cards.map((card) => card.y));
  const maxX = Math.max(...cards.map((card) => card.x + card.w));
  const maxY = Math.max(...cards.map((card) => card.y + card.h));
  const scale = Math.min(
    (width - pad * 2) / Math.max(1, maxX - minX),
    (height - pad * 2) / Math.max(1, maxY - minY),
    maxScale
  );
  for (const card of cards) {
    const shape = document.createElement("span");
    shape.className = "mn-project-shape";
    shape.style.left = `${pad + (card.x - minX) * scale}px`;
    shape.style.top = `${pad + (card.y - minY) * scale}px`;
    shape.style.width = `${Math.max(2, card.w * scale)}px`;
    shape.style.height = `${Math.max(2, card.h * scale)}px`;
    if (card.type === "color" && card.color) {
      shape.style.background = card.color;
    } else {
      shape.style.background = PREVIEW_TYPE_COLORS[card.type] || "var(--ky-palette-black-7, #ffffff)";
      shape.style.boxShadow = "inset 0 0 0 1px var(--ky-stroke)";
    }
    if (card.type === "column") shape.style.opacity = "0.55";
    container.append(shape);
  }
}
