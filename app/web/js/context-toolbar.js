// Contextual bottom toolbar: formatting for text cards, pen/eraser/move for the Draw tool.

import { icon } from "./icons.js";
import { notify, state, subscribe } from "./store.js";

let bar = null;
let renderTimer = 0;

const FORMAT_BUTTONS = [
  { cmd: "bold", label: "B", title: "Bold" },
  { cmd: "italic", label: "I", title: "Italic" },
  { cmd: "underline", label: "U", title: "Underline" },
  { cmd: "strikeThrough", label: "S", title: "Strikethrough" },
  { cmd: "formatBlock", value: "pre", iconName: "code", title: "Code block" },
  { cmd: "insertUnorderedList", iconName: "listBullet", title: "Bullet list" },
  { cmd: "insertOrderedList", iconName: "listOrdered", title: "Numbered list" },
];

const DRAW_MODES = [
  { mode: "move", iconName: "pointer", title: "Move" },
  { mode: "pen", iconName: "draw", title: "Pen" },
  { mode: "eraser", iconName: "eraser", title: "Eraser" },
];

export function initContextToolbar() {
  bar = document.createElement("div");
  bar.className = "mn-context-bar";
  bar.hidden = true;
  document.body.append(bar);
  bar.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("input, textarea")) event.preventDefault();
  });
  bar.addEventListener("click", onClick);
  subscribe(renderBar);
  document.addEventListener("focusin", (event) => {
    if (event.target.closest?.(".mn-note-text, .mn-heading-text")) renderBar();
  });
  document.addEventListener("focusout", () => scheduleRender());
  document.addEventListener("selectionchange", () => scheduleRender());
  renderBar();
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = window.setTimeout(renderBar, 120);
}

function editableTarget() {
  const focused = document.activeElement?.closest?.(".mn-note-text, .mn-heading-text");
  if (focused) return focused;
  return document.querySelector(
    ".mn-card.is-selected .mn-note-text, .mn-card.is-selected .mn-heading-text"
  );
}

function renderBar() {
  if (!bar) return;
  const drawingSelected = document.querySelector('.mn-card.is-selected[data-type="drawing"]');
  if (state.tool === "draw" || drawingSelected) {
    bar.hidden = false;
    bar.innerHTML = `<span class="mn-context-group">${DRAW_MODES.map(
      (entry) =>
        `<button type="button" class="mn-context-btn${
          (state.drawMode || "pen") === entry.mode ? " is-active" : ""
        }" data-draw-mode="${entry.mode}" title="${entry.title}" aria-label="${entry.title}">${icon(
          entry.iconName,
          17
        )}</button>`
    ).join("")}</span>`;
    return;
  }
  const target = editableTarget();
  if (!target) {
    bar.hidden = true;
    bar.innerHTML = "";
    return;
  }
  bar.hidden = false;
  bar.innerHTML = `<span class="mn-context-group">${FORMAT_BUTTONS.map((entry) => {
    const content = entry.iconName ? icon(entry.iconName, 16) : entry.label;
    return `<button type="button" class="mn-context-btn mn-context-format" data-format="${entry.cmd}"${
      entry.value ? ` data-value="${entry.value}"` : ""
    } title="${entry.title}" aria-label="${entry.title}">${content}</button>`;
  }).join("")}</span>`;
}

function onClick(event) {
  const drawButton = event.target.closest("[data-draw-mode]");
  if (drawButton) {
    if (state.tool !== "draw") {
      state.tool = "draw";
      state.drawMode = drawButton.dataset.drawMode === "move" ? "move" : drawButton.dataset.drawMode;
      notify("tool");
    } else {
      state.drawMode = drawButton.dataset.drawMode;
      notify("tool");
    }
    renderBar();
    return;
  }
  const formatButton = event.target.closest("[data-format]");
  if (!formatButton) return;
  const target = editableTarget();
  if (!target) return;
  target.focus();
  document.execCommand(formatButton.dataset.format, false, formatButton.dataset.value || null);
  notify("save");
  scheduleRender();
}
