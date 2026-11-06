// Full page drawing editor for sketch cards.

import { icon } from "./icons.js";
import { getCard } from "./model.js";
import { markDirty, state } from "./store.js";

const TOOLS = [
  { key: "pen", label: "Pen", icon: "draw", width: 0.007, sizes: [0.004, 0.007, 0.012] },
  { key: "eraser", label: "Eraser", icon: "close", width: 0.02 },
  { key: "pencil", label: "Pencil", icon: "sketch", width: 0.004, sizes: [0.0025, 0.004, 0.008] },
  { key: "highlighter", label: "Highlighter", icon: "color", width: 0.022, sizes: [0.014, 0.022, 0.034], alpha: 0.35 },
];

// null means "theme colour": ink for pen/pencil, accent for highlighter.
const PALETTE = [null, "#26262b", "#8a8a90", "#d64545", "#e08b2d", "#e6c34a", "#4c9a63", "#4a7fd4", "#9a5bd4"];

let overlayEl = null;
let cleanup = null;

export function openDrawingEditor(cardId) {
  const card = getCard(state.board, cardId);
  if (!card || card.type !== "sketch") return;
  closeDrawingEditor();

  let strokes = JSON.parse(JSON.stringify(card.strokes || []));
  const past = [];
  const future = [];
  let tool = "pen";
  let drawing = null;
  let eraser = null;
  const toolSettings = {};
  for (const entry of TOOLS) {
    if (entry.sizes) toolSettings[entry.key] = { color: null, size: entry.width };
  }

  const overlay = document.createElement("div");
  overlay.className = "mn-draw-overlay";
  overlay.innerHTML = `
    <div class="mn-draw-sheet">
      <div class="mn-draw-stage"><canvas class="mn-draw-canvas"></canvas></div>
      <div class="mn-draw-toolbar">
        <div class="mn-draw-tools" data-role="tools"></div>
        <div class="mn-draw-options" data-role="options"></div>
        <div class="mn-draw-actions">
          <button type="button" class="mn-icon-btn" data-role="undo" title="Undo">${icon("undo", 15)}</button>
          <button type="button" class="mn-icon-btn" data-role="redo" title="Redo">${icon("redo", 15)}</button>
          <button type="button" class="mn-btn mn-btn-quiet" data-role="cancel">Cancel</button>
          <button type="button" class="mn-btn mn-btn-primary" data-role="save">Save</button>
        </div>
      </div>
    </div>`;
  document.body.append(overlay);
  overlayEl = overlay;

  const canvas = overlay.querySelector(".mn-draw-canvas");
  const stage = overlay.querySelector(".mn-draw-stage");
  const toolsEl = overlay.querySelector('[data-role="tools"]');
  const optionsEl = overlay.querySelector('[data-role="options"]');
  const ctx = canvas.getContext("2d");

  const themeColor = () =>
    getComputedStyle(document.documentElement).getPropertyValue("--ky-text").trim() || "#111";
  const accentColor = () =>
    getComputedStyle(document.documentElement).getPropertyValue("--ky-accent").trim() || "#e6b800";

  function resizeCanvas() {
    const rect = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint();
  }

  function strokeWidth(stroke, widthPx) {
    return Math.max(1, (stroke.w || 0.007) * widthPx);
  }

  function paint() {
    const width = canvas.width / (window.devicePixelRatio || 1);
    const height = canvas.height / (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, width, height);
    const ink = themeColor();
    const accent = accentColor();
    const all = drawing ? [...strokes, drawing] : strokes;
    for (const stroke of all) {
      if (!stroke || !stroke.points || stroke.points.length === 0) continue;
      const highlight = stroke.tool === "highlighter";
      ctx.strokeStyle = stroke.color || (highlight ? accent : ink);
      ctx.globalAlpha = typeof stroke.a === "number" ? stroke.a : highlight ? 0.35 : 1;
      ctx.lineWidth = strokeWidth(stroke, width);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      stroke.points.forEach((point, index) => {
        const x = point.x * width;
        const y = point.y * height;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (eraser && eraser.length) {
      ctx.strokeStyle = "rgba(128,128,128,.45)";
      ctx.lineWidth = 12;
      ctx.lineCap = "round";
      ctx.beginPath();
      eraser.forEach((point, index) => {
        const x = point.x * width;
        const y = point.y * height;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }

  function snapshot() {
    past.push(JSON.stringify(strokes));
    if (past.length > 80) past.shift();
    future.length = 0;
  }

  function undo() {
    if (!past.length) return;
    future.push(JSON.stringify(strokes));
    strokes = JSON.parse(past.pop());
    paint();
  }

  function redo() {
    if (!future.length) return;
    past.push(JSON.stringify(strokes));
    strokes = JSON.parse(future.pop());
    paint();
  }

  function pointOf(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / Math.max(1, rect.width),
      y: (event.clientY - rect.top) / Math.max(1, rect.height),
    };
  }

  function buildTools() {
    toolsEl.innerHTML = "";
    for (const entry of TOOLS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mn-draw-tool" + (entry.key === tool ? " is-active" : "");
      button.title = entry.label;
      button.innerHTML = icon(entry.icon, 15);
      button.addEventListener("click", () => {
        tool = entry.key;
        toolsEl.querySelectorAll(".mn-draw-tool").forEach((el) => el.classList.remove("is-active"));
        button.classList.add("is-active");
        buildOptions();
      });
      toolsEl.append(button);
    }
    buildOptions();
  }

  function buildOptions() {
    const entry = TOOLS.find((item) => item.key === tool);
    optionsEl.innerHTML = "";
    if (!entry?.sizes) {
      optionsEl.hidden = true;
      return;
    }
    optionsEl.hidden = false;
    const config = toolSettings[tool];
    for (const color of PALETTE) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "mn-draw-swatch" + (config.color === color ? " is-active" : "");
      swatch.title = color || "Theme colour";
      if (!color) swatch.classList.add("is-auto");
      else swatch.style.background = color;
      swatch.addEventListener("click", () => {
        config.color = color;
        buildOptions();
      });
      optionsEl.append(swatch);
    }
    const sizes = document.createElement("div");
    sizes.className = "mn-draw-sizes";
    entry.sizes.forEach((size, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mn-draw-size" + (config.size === size ? " is-active" : "");
      button.title = ["Small", "Medium", "Large"][index];
      const dot = document.createElement("span");
      dot.style.width = `${4 + index * 3}px`;
      dot.style.height = `${4 + index * 3}px`;
      button.append(dot);
      button.addEventListener("click", () => {
        config.size = size;
        buildOptions();
      });
      sizes.append(button);
    });
    optionsEl.append(sizes);
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    const point = pointOf(event);
    if (tool === "eraser") {
      eraser = [point];
      paint();
      return;
    }
    const entry = TOOLS.find((item) => item.key === tool) || TOOLS[0];
    const config = toolSettings[tool] || { color: null, size: entry.width };
    drawing = {
      tool,
      w: config.size,
      color: config.color,
      a: entry.alpha ?? 1,
      points: [point],
    };
    paint();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!drawing && !eraser) return;
    const point = pointOf(event);
    if (eraser) {
      eraser.push(point);
    } else {
      drawing.points.push(point);
    }
    paint();
  });

  canvas.addEventListener("pointerup", () => {
    if (eraser) {
      snapshot();
      const threshold = 0.02;
      strokes = strokes.filter((stroke) => !strokeHits(stroke, eraser, threshold));
      eraser = null;
      paint();
      return;
    }
    if (!drawing) return;
    snapshot();
    if (drawing.points.length > 1) strokes.push(drawing);
    drawing = null;
    paint();
  });

  function strokeHits(stroke, path, threshold) {
    for (const point of path) {
      for (const strokePoint of stroke.points) {
        const dx = point.x - strokePoint.x;
        const dy = point.y - strokePoint.y;
        if (Math.hypot(dx, dy) < threshold) return true;
      }
    }
    return false;
  }

  overlay.querySelector('[data-role="undo"]').addEventListener("click", undo);
  overlay.querySelector('[data-role="redo"]').addEventListener("click", redo);
  overlay.querySelector('[data-role="cancel"]').addEventListener("click", () => closeDrawingEditor());
  overlay.querySelector('[data-role="save"]').addEventListener("click", () => {
    card.strokes = strokes;
    markDirty("board");
    closeDrawingEditor();
  });
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) {
      card.strokes = strokes;
      markDirty("board");
      closeDrawingEditor();
    }
  });

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDrawingEditor();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    }
  };
  window.addEventListener("keydown", onKeyDown, true);

  buildTools();
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  cleanup = () => {
    window.removeEventListener("resize", resizeCanvas);
    window.removeEventListener("keydown", onKeyDown, true);
  };
}

export function closeDrawingEditor() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  if (overlayEl) {
    overlayEl.remove();
    overlayEl = null;
  }
}

export function drawingEditorOpen() {
  return Boolean(overlayEl);
}
