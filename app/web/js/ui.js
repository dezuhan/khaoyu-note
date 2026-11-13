// Chrome UI: tool rail, top bar, modals, menus, toasts and shortcuts.

import { createDocumentation } from "./documentation.js";
import { initAccountUI } from "./account-ui.js";
import { openImageCrop } from "./image-crop.js";
import { isTemporarilyDisabledType, toolDisabledReason } from "./limits.js";
import { openSharePanel } from "./share-ui.js";
import * as bridge from "./bridge.js";
import { closeDocumentEditor, documentEditorOpen, openDocumentEditor } from "./document-editor.js";
import { closeDrawingEditor, drawingEditorOpen, openDrawingEditor } from "./drawing-editor.js";
import { homeVisible, initHome, showHome } from "./home.js";
import {
  addCard,
  addCardAt,
  addCardAtCenter,
  attachAudio,
  attachImage,
  attachFile,
  attachLinkHeader,
  removeLinkHeader,
  applyLinkHeaderCrop,
  applyImageCrop,
  maybeAutoLinkHeader,
  assetPathForCard,
  bringToFront,
  canWrapInColumn,
  canWrapInKanban,
  canWrapInSection,
  canReleaseContainer,
  clearClipboard,
  convertColumnToBoard,
  convertNoteToDocument,
  copySelected,
  createNestedBoardCard,
  cutSelected,
  hasClipboard,
  deleteSelected,
  deleteTrashEntry,
  downloadCardAsset,
  duplicateSelected,
  emptyTrashEntries,
  openBoardCard,
  pauseMedia,
  pasteCards,
  playMedia,
  restoreTrashEntry,
  releaseContainer,
  selectAllCards,
  sendToBack,
  setBoardTitle,
  setCardsLocked,
  setColumnDirection,
  setSectionPositionLocked,
  toggleMediaRepeat,
  wrapInColumn,
  wrapInKanban,
  wrapInSection,
} from "./actions.js";
import { closeSettingsPage, getSettings, openSettingsPage, saveToolOrder } from "./settings.js";
import { LANGUAGES, getLanguage, setLanguage, t, translateActionText } from "./i18n.js";
import { initComments } from "./comments-panel.js";
import { initCommandPalette, openCommandPalette } from "./command-palette.js";
import { initContextToolbar } from "./context-toolbar.js";
import { initFileDrop } from "./file-drop.js";
import { initNotifications } from "./notifications.js";
import { createTemplateFromSelection, openTemplateLibrary } from "./templates.js";
import { icon } from "./icons.js";
import { openWorkspacePopover } from "./workspace-mode.js";
import { CARD_ASPECTS, columnChildren, createCard, getCard, layoutColumns, TYPE_LABELS } from "./model.js";
import { cardElement, renderView } from "./render.js";
import { clearDropPreview, previewDrop } from "./drop-preview.js";
import {
  canRedo,
  canUndo,
  checkpoint,
  createBoard,
  exportCurrentBoard,
  markDirty,
  notify,
  openBoard,
  redo,
  refreshBoards,
  removeBoard,
  resolveSaveConflict,
  saveNow,
  setSelection,
  setTheme,
  state,
  subscribe,
  undo,
} from "./store.js";

const TOOLS = [
  { key: "note", type: "note", label: "Note", focus: '[data-field="text"]', shortcut: "N" },
  { key: "link", type: "link", label: "Link", focus: '[data-field="url"]', shortcut: "L" },
  { key: "todo", type: "todo", label: "To-do", focus: '[data-field="title"]', shortcut: "T" },
  { key: "line", label: "Line", shortcut: "A" },
  { key: "board", label: "Board", shortcut: "G" },
  { key: "column", type: "column", label: "Column", shortcut: "C" },
  { key: "section", type: "section", label: "Section", focus: '[data-field="title"]', shortcut: "E" },
  { key: "comment", type: "comment", label: "Comment", focus: '[data-field="comment-draft"]', shortcut: "M" },
  { key: "table", type: "table", label: "Table", shortcut: "X" },
  { key: "sketch", type: "sketch", label: "Sketch", shortcut: "S" },
  { key: "color", type: "color", label: "Color", shortcut: "O" },
  { key: "document", type: "document", label: "Document", focus: '[data-field="title"]', shortcut: "D" },
  { key: "audio", type: "audio", label: "Audio", shortcut: "U" },
  { key: "map", type: "map", label: "Map", shortcut: "P" },
  { key: "video", type: "video", label: "Video", shortcut: "V" },
  { key: "heading", type: "heading", label: "Heading", focus: '[data-field="text"]', shortcut: "H" },
  { key: "image", label: "Image", shortcut: "I" },
  { key: "upload", label: "Upload", shortcut: "W" },
  { key: "draw", label: "Draw", shortcut: "R" },
];

function toolLabel(tool) {
  return t(`tool.${tool.key}`, tool.label);
}

let refs = {};
let toastTimer = 0;
let tooltipEl = null;

function showToolTooltip(button, tool) {
  if (!tooltipEl) {
    tooltipEl = document.createElement("div");
    tooltipEl.className = "mn-tool-tip";
    document.body.append(tooltipEl);
  }
  tooltipEl.innerHTML = `<span>${toolLabel(tool)}</span>${
    tool.shortcut ? `<span class="mn-tool-tip-key">${tool.shortcut}</span>` : ""
  }`;
  const rect = button.getBoundingClientRect();
  tooltipEl.style.left = `${Math.round(rect.right + 10)}px`;
  tooltipEl.style.top = `${Math.round(rect.top + rect.height / 2)}px`;
  tooltipEl.classList.add("is-visible");
}

function hideToolTooltip() {
  tooltipEl?.classList.remove("is-visible");
}

// Native title tooltips look different in every webview. Replace them with one design-system tip
// while the pointer or keyboard focus is on an element that carries a title.
let designTip = null;
let designTipTarget = null;

function ensureDesignTip() {
  if (designTip) return designTip;
  designTip = document.createElement("div");
  designTip.className = "mn-design-tip";
  designTip.hidden = true;
  document.body.append(designTip);
  return designTip;
}

function hideDesignTip() {
  if (designTip) designTip.hidden = true;
}

function showDesignTip(target, text) {
  const tip = ensureDesignTip();
  tip.textContent = text;
  tip.hidden = false;
  const rect = target.getBoundingClientRect();
  const gap = 8;
  let left = rect.left + rect.width / 2 - tip.offsetWidth / 2;
  let top = rect.top - tip.offsetHeight - gap;
  if (top < 8) top = rect.bottom + gap;
  left = Math.max(8, Math.min(left, window.innerWidth - tip.offsetWidth - 8));
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

function restoreDesignTitle(target) {
  if (!target?.dataset?.mnTitle) return;
  target.setAttribute("title", target.dataset.mnTitle);
  delete target.dataset.mnTitle;
}

function initDesignTooltips() {
  document.addEventListener("pointerover", (event) => {
    if (event.pointerType === "touch") return;
    const target = event.target.closest?.("[title], [data-mn-title]");
    if (!target || target.closest(".mn-tool")) return;
    const text = target.getAttribute("title") || target.dataset.mnTitle;
    if (!text) return;
    if (!target.dataset.mnTitle) target.dataset.mnTitle = text;
    target.removeAttribute("title");
    if (target === designTipTarget) return;
    designTipTarget = target;
    showDesignTip(target, text);
  });
  document.addEventListener("pointerout", (event) => {
    const target = designTipTarget;
    if (!target) return;
    if (event.relatedTarget && target.contains(event.relatedTarget)) return;
    restoreDesignTitle(target);
    designTipTarget = null;
    hideDesignTip();
  });
  document.addEventListener("focusin", (event) => {
    const target = event.target.closest?.("[title], [data-mn-title]");
    if (!target || target.closest(".mn-tool")) return;
    const text = target.getAttribute("title") || target.dataset.mnTitle;
    if (!text) return;
    if (!target.dataset.mnTitle) target.dataset.mnTitle = text;
    target.removeAttribute("title");
    designTipTarget = target;
    showDesignTip(target, text);
  });
  document.addEventListener("focusout", (event) => {
    const target = event.target;
    if (!target?.dataset?.mnTitle) return;
    restoreDesignTitle(target);
    if (designTipTarget === target) designTipTarget = null;
    hideDesignTip();
  });
  document.addEventListener("pointerdown", hideDesignTip, true);
  window.addEventListener("scroll", hideDesignTip, true);
  window.addEventListener("resize", hideDesignTip);
}

export function initUI(elements) {
  refs = elements;
  buildToolRail();
  wireTopbar();
  wireZoom();
  wireGlobalEvents();
  initDesignTooltips();
  if (refs.homePage) initHome(refs.homePage);
  if (refs.commentCount) initComments(refs.commentCount);
  if (refs.notificationBtn) initNotifications(refs.notificationBtn);
  if (refs.accountBtn) {
    initAccountUI({ ...refs, openModal, closeModal, confirmAction });
  }
  initContextToolbar();
  initCommandPalette(() => buildCommands().filter((command) => !command.disabled));
  wireMenuBar();
  applyPerformanceMode(localStorage.getItem("ky.performance") === "1");
  window.addEventListener("mn:language-changed", () => {
    buildToolRail();
    buildMenuBar();
    refreshTopbarLanguage();
  });
  subscribe(onStoreEvent);
  updateAll();
}

// ------------------------------------------------------------------ tool rail

function orderedTools() {
  const settings = getSettings();
  const byKey = new Map(TOOLS.map((tool) => [tool.key, tool]));
  const order = Array.isArray(settings.toolOrder) && settings.toolOrder.length
    ? settings.toolOrder
    : TOOLS.map((tool) => tool.key);
  const keys = [
    ...order.filter((key) => byKey.has(key)),
    ...TOOLS.map((tool) => tool.key).filter((key) => !order.includes(key)),
  ];
  return keys.map((key) => byKey.get(key));
}

let draggingToolKey = null;
let toolPointerDrag = null;
let suppressToolClickUntil = 0;

function moveTool(sourceKey, targetKey) {
  const keys = orderedTools().map((tool) => tool.key);
  const from = keys.indexOf(sourceKey);
  const to = keys.indexOf(targetKey);
  const next = keys.filter((key) => key !== sourceKey);
  let index = next.indexOf(targetKey);
  if (index < 0) index = next.length;
  else if (from >= 0 && from < to) index += 1;
  next.splice(index, 0, sourceKey);
  saveToolOrder(next);
}

let toolDragGhost = null;
let toolDropPreviewEl = null;

function clearToolDragPreview() {
  if (toolDragGhost) {
    toolDragGhost.remove();
    toolDragGhost = null;
  }
  if (toolDropPreviewEl) {
    toolDropPreviewEl.remove();
    toolDropPreviewEl = null;
  }
}

function columnAtPoint(clientX, clientY) {
  if (!state.board) return null;
  const viewport = document.getElementById("viewport");
  if (!viewport) return null;
  const rect = viewport.getBoundingClientRect();
  const point = {
    x: (clientX - rect.left - state.view.x) / state.view.zoom,
    y: (clientY - rect.top - state.view.y) / state.view.zoom,
  };
  const depth = (column) => {
    let value = 0;
    let parent = column.parentId ? getCard(state.board, column.parentId) : null;
    while (parent) {
      value += 1;
      parent = parent.parentId ? getCard(state.board, parent.parentId) : null;
    }
    return value;
  };
  const columns = state.board.cards
    .filter(
      (card) =>
        card.type === "column" &&
        point.x >= card.x &&
        point.x <= card.x + card.w &&
        point.y >= card.y &&
        point.y <= card.y + card.h
    )
    .sort((a, b) => depth(b) - depth(a) || (b.z || 1) - (a.z || 1));
  return columns[0] || null;
}

function columnDropChildren(column) {
  return columnChildren(state.board, column.id).filter(
    (card) => !isTemporarilyDisabledType(card.type)
  );
}

function columnDropIndex(column, point) {
  const children = columnDropChildren(column);
  if (column.direction === "row") {
    let index = 0;
    for (const child of children) {
      if (point.x > child.x + child.w / 2) index += 1;
      else break;
    }
    return index;
  }
  let index = 0;
  for (const child of children) {
    if (point.y > child.y + child.h / 2) index += 1;
    else break;
  }
  return index;
}

function columnDropSlot(column, point, height, width = null) {
  const children = columnDropChildren(column);
  const index = columnDropIndex(column, point);
  const gap = 10;
  const innerW = column.w - 28;
  if (column.direction === "row") {
    let x = column.x + 14;
    for (let i = 0; i < index; i += 1) x += children[i].w + gap;
    const slotWidth = Math.max(120, Number(width) || children[index]?.w || 160);
    return { x, y: column.y + 64, w: slotWidth, h: height, index };
  }
  let y = column.y + 64;
  for (let i = 0; i < index; i += 1) y += children[i].h + gap;
  return { x: column.x + 14, y, w: innerW, h: height, index };
}

function insertToolCard(column, card, index) {
  const rest = columnChildren(state.board, column.id).filter(
    (child) => child.id !== card.id && !isTemporarilyDisabledType(child.type)
  );
  const ordered = [...rest];
  ordered.splice(Math.max(0, Math.min(index, ordered.length)), 0, card);
  ordered.forEach((child, order) => {
    child.parentId = column.id;
    child.order = order;
  });
  layoutColumns(state.board);
  markDirty("board");
}

function toolPreviewRect(probe, event) {
  const probeHeight =
    probe.type === "table"
      ? Math.max(80, probe.h, (probe.cells?.length || 0) * 28 + 4)
      : probe.h;
  const viewport = document.getElementById("viewport");
  const rect = viewport.getBoundingClientRect();
  const point = {
    x: (event.clientX - rect.left - state.view.x) / state.view.zoom,
    y: (event.clientY - rect.top - state.view.y) / state.view.zoom,
  };
  const column = columnAtPoint(event.clientX, event.clientY);
  if (column) {
    const aspect = probe.aspect || CARD_ASPECTS[probe.type];
    const slot = columnDropSlot(column, point, probeHeight, probe.w);
    return {
      x: slot.x,
      y: slot.y,
      w: slot.w,
      h: aspect ? Math.max(70, Math.round(slot.w / aspect)) : probeHeight,
    };
  }
  return { x: point.x - probe.w / 2, y: point.y - probeHeight / 2, w: probe.w, h: probeHeight };
}

function showToolDragPreview(key, event) {
  const tool = TOOLS.find((entry) => entry.key === key);
  if (!tool || !state.board) return;
  if (!toolDragGhost) {
    toolDragGhost = document.createElement("div");
    toolDragGhost.className = "mn-tool-drag-ghost";
    document.body.append(toolDragGhost);
  }
  toolDragGhost.innerHTML = `${icon(key, 14)}<span>${toolLabel(tool)}</span>`;
  toolDragGhost.style.left = `${event.clientX + 16}px`;
  toolDragGhost.style.top = `${event.clientY + 16}px`;

  const type = tool.type || (key === "image" ? "image" : null);
  if (!type) {
    if (toolDropPreviewEl) toolDropPreviewEl.hidden = true;
    return;
  }
  const probe = createCard(type, 0, 0);
  const rect = toolPreviewRect(probe, event);
  const cardsLayer = document.getElementById("cards");
  if (!toolDropPreviewEl) {
    toolDropPreviewEl = document.createElement("div");
    toolDropPreviewEl.className = "mn-tool-drop-preview";
    cardsLayer.append(toolDropPreviewEl);
  }
  Object.assign(toolDropPreviewEl.style, {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.w}px`,
    height: `${rect.h}px`,
  });
  toolDropPreviewEl.hidden = false;
}

function createToolFromDrop(key, clientX, clientY, columnId = null) {
  const tool = TOOLS.find((entry) => entry.key === key);
  if (!tool || !state.board) return;
  const disabled = toolDisabledReason(key);
  if (disabled) {
    toast(disabled);
    return;
  }
  const viewport = document.getElementById("viewport");
  const rect = viewport.getBoundingClientRect();
  const point = {
    x: (clientX - rect.left - state.view.x) / state.view.zoom,
    y: (clientY - rect.top - state.view.y) / state.view.zoom,
  };
  const parent = columnId ? getCard(state.board, columnId) : null;
  let parentColumn = parent && parent.type === "column" ? parent : null;

  // A kanban row contains lanes, not cards. If the pointer is over the row padding or header,
  // place the tool in the nearest lane instead of making the card a direct child of the row.
  const isKanbanRow = (column) => {
    if (!column || column.type !== "column" || column.direction !== "row") return false;
    if (column.kanban) return true;
    const children = columnChildren(state.board, column.id);
    return children.length > 0 && children.every((child) => child.type === "column");
  };
  if (parentColumn && isKanbanRow(parentColumn)) {
    const lanes = columnChildren(state.board, parentColumn.id).filter(
      (child) => child.type === "column"
    );
    if (lanes.length) {
      const distanceTo = (lane) => {
        const dx =
          point.x < lane.x ? lane.x - point.x : point.x > lane.x + lane.w ? point.x - (lane.x + lane.w) : 0;
        const dy =
          point.y < lane.y ? lane.y - point.y : point.y > lane.y + lane.h ? point.y - (lane.y + lane.h) : 0;
        return dx * dx + dy * dy;
      };
      parentColumn = lanes.reduce(
        (best, lane) => (distanceTo(lane) < distanceTo(best) ? lane : best),
        lanes[0]
      );
    } else {
      toast("This kanban has no columns yet. Add a column first, then drop the tool into it.");
      return;
    }
  }
  if (parentColumn) parentColumn.collapsed = false;
  const dropIndex = parentColumn ? columnDropIndex(parentColumn, point) : 0;
  const parentFields = parentColumn ? { parentId: parentColumn.id, order: dropIndex } : {};

  if (key === "line") {
    toast("Line tool: drag from one card or canvas point to another. Endpoints snap to cards.");
    return;
  }
  if (key === "draw") {
    toast("Board drawing is not available yet.");
    return;
  }
  if (key === "upload") {
    toast("Drop a file onto the canvas to upload it.");
    return;
  }
  if (key === "board") {
    createNestedBoardCard({ x: point.x - 130, y: point.y - 60 })
      .then((card) => {
        if (!card || !parentColumn) return;
        insertToolCard(parentColumn, card, dropIndex);
      })
      .catch((error) => toast("Could not create board: " + error));
    return;
  }

  const type = key === "image" ? "image" : tool.type;
  if (!type) return;
  if (parentColumn && type === "column") {
    toast("Columns cannot be placed inside another column.");
    return;
  }
  if (parentColumn && type === "section") {
    toast("Sections stay on the board surface, not inside a column.");
    return;
  }
  const extra = { ...parentFields };
  const probe = createCard(type, 0, 0, extra);
  const card = addCard(
    type,
    parentColumn ? parentColumn.x + 14 : point.x - probe.w / 2,
    parentColumn ? parentColumn.y + 64 : point.y - probe.h / 2,
    extra
  );
  if (!card) return;
  if (parentColumn) insertToolCard(parentColumn, card, dropIndex);
  if (key === "image") {
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("mn:pick-image", { detail: { cardId: card.id } }));
    }, 60);
  } else if (key === "document") {
    window.setTimeout(() => openDocumentEditor(card.id), 60);
  } else if (tool.focus) {
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("mn:focus-field", { detail: { cardId: card.id, selector: tool.focus } })
      );
    }, 40);
  }
}

function previewToolColumnDrop(tool, column, event) {
  if (!column) return false;
  if (["line", "draw", "upload"].includes(tool.key)) return false;
  const type = tool.key === "image" ? "image" : tool.key === "board" ? "board" : tool.type;
  if (!type || type === "column" || type === "section") return false;
  const children = columnChildren(state.board, column.id);
  const rowOfColumns =
    column.direction === "row" &&
    (Boolean(column.kanban) || (children.length > 0 && children.every((child) => child.type === "column")));
  if (rowOfColumns) return false;
  const viewport = document.getElementById("viewport");
  const rect = viewport.getBoundingClientRect();
  const point = {
    x: (event.clientX - rect.left - state.view.x) / state.view.zoom,
    y: (event.clientY - rect.top - state.view.y) / state.view.zoom,
  };
  const probe = createCard(type, 0, 0);
  const aspect = probe.aspect || CARD_ASPECTS[type];
  const innerW = Math.max(120, column.w - 28);
  const width = column.direction === "row" ? Math.max(120, probe.w) : innerW;
  const height =
    column.direction === "row"
      ? Math.max(56, column.h - 64 - 14)
      : aspect
        ? Math.max(70, Math.round(innerW / aspect))
        : type === "table"
          ? 80
          : probe.h;
  previewDrop(column, point, {
    width,
    height,
    label: toolLabel(tool),
    excludeIds: [],
  });
  return true;
}

function buildToolRail() {
  refs.toolrail.innerHTML = "";
  const hidden = new Set(getSettings().hiddenTools || []);
  draggingToolKey = null;
  for (const tool of orderedTools()) {
    if (hidden.has(tool.key) || toolDisabledReason(tool.key)) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mn-tool";
    button.dataset.tool = tool.key;
    button.setAttribute("aria-label", toolLabel(tool));
    button.innerHTML = `<span class="mn-tool-icon">${icon(tool.key === "image" ? "image" : tool.key, 19)}</span><span class="mn-tool-label">${toolLabel(tool)}</span>`;
    button.addEventListener("click", (event) => {
      if (Date.now() < suppressToolClickUntil) {
        event.preventDefault();
        return;
      }
      hideToolTooltip();
      runTool(tool);
    });
    button.addEventListener("pointerenter", () => showToolTooltip(button, tool));
    button.addEventListener("pointerleave", hideToolTooltip);
    button.addEventListener("focus", () => showToolTooltip(button, tool));
    button.addEventListener("blur", hideToolTooltip);
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !state.board) return;
      toolPointerDrag = {
        tool,
        button,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        targetTool: null,
        targetViewport: false,
        targetColumnId: null,
      };
      const onMove = (moveEvent) => {
        const current = toolPointerDrag;
        if (!current) return;
        const distance = Math.hypot(moveEvent.clientX - current.startX, moveEvent.clientY - current.startY);
        if (!current.moved && distance < 5) return;
        current.moved = true;
        hideToolTooltip();
        button.classList.add("is-dragging-tool");
        const hoverEl = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
        const hoverTool = hoverEl?.closest?.(".mn-tool");
        const hoverColumn = columnAtPoint(moveEvent.clientX, moveEvent.clientY);
        const viewport = document.getElementById("viewport");
        current.targetTool =
          hoverTool && hoverTool !== button ? hoverTool.dataset.tool : null;
        current.targetColumnId = hoverColumn ? hoverColumn.id : null;
        current.targetViewport =
          !current.targetTool && (Boolean(viewport?.contains(hoverEl)) || Boolean(hoverColumn));
        refs.toolrail
          .querySelectorAll(".mn-tool")
          .forEach((el) => el.classList.toggle("is-drop-target", el === hoverTool && el !== button));
        document.querySelectorAll(".mn-card").forEach((el) => {
          el.classList.toggle("is-drop-target", el.dataset.id === current.targetColumnId);
        });
        const previewingColumn = Boolean(
          hoverColumn && !current.targetTool && previewToolColumnDrop(current.tool, hoverColumn, moveEvent)
        );
        if (previewingColumn) {
          clearToolDragPreview();
        } else {
          clearDropPreview();
          if (current.targetViewport) {
            showToolDragPreview(current.tool.key, moveEvent);
          } else if (toolDropPreviewEl) {
            toolDropPreviewEl.hidden = true;
          }
          if (current.moved && !current.targetTool && !current.targetViewport) {
            showToolDragPreview(current.tool.key, moveEvent);
            if (toolDropPreviewEl) toolDropPreviewEl.hidden = true;
          }
        }
      };
      const onUp = (upEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        const current = toolPointerDrag;
        toolPointerDrag = null;
        if (!current || !current.moved) return;
        suppressToolClickUntil = Date.now() + 400;
        button.classList.remove("is-dragging-tool");
        refs.toolrail
          .querySelectorAll(".mn-tool")
          .forEach((el) => el.classList.remove("is-drop-target"));
        document.querySelectorAll(".mn-card.is-drop-target").forEach((el) =>
          el.classList.remove("is-drop-target")
        );
        clearToolDragPreview();
        clearDropPreview();
        if (current.targetTool && current.targetTool !== current.tool.key) {
          moveTool(current.tool.key, current.targetTool);
        } else if (current.targetColumnId) {
          createToolFromDrop(
            current.tool.key,
            upEvent.clientX,
            upEvent.clientY,
            current.targetColumnId
          );
        } else if (current.targetViewport) {
          createToolFromDrop(current.tool.key, upEvent.clientX, upEvent.clientY);
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });

    refs.toolrail.append(button);
  }
  const spacer = document.createElement("div");
  spacer.className = "mn-rail-spacer";
  const trash = document.createElement("button");
  trash.type = "button";
  trash.className = "mn-tool mn-trash";
  trash.setAttribute("aria-label", "Delete selected");
  trash.innerHTML = `<span class="mn-tool-icon">${icon("trash", 18)}</span><span class="mn-tool-label">${t(
    "topbar.trash"
  )}</span>`;
  trash.addEventListener("click", () => {
    hideToolTooltip();
    if (state.selection.size || state.connectionSelection) deleteSelected();
    else openTrashPanel();
  });
  trash.addEventListener("pointerenter", () => showToolTooltip(trash, { label: "Trash / Delete selected", shortcut: "Del" }));
  trash.addEventListener("pointerleave", hideToolTooltip);
  trash.addEventListener("focus", () => showToolTooltip(trash, { label: "Delete selected", shortcut: "Del" }));
  trash.addEventListener("blur", hideToolTooltip);
  refs.toolrail.append(spacer, trash);
}

function runTool(tool) {
  if (!state.board) return;
  const disabled = toolDisabledReason(tool.key);
  if (disabled) {
    toast(disabled);
    return;
  }
  if (tool.key === "line") {
    state.tool = state.tool === "line" ? "select" : "line";
    state.lineFrom = null;
    notify("tool");
    return;
  }
  if (tool.key === "draw") {
    if (state.tool === "draw") {
      state.tool = "select";
      state.drawMode = null;
    } else {
      state.tool = "draw";
      state.drawMode = "pen";
    }
    notify("tool");
    return;
  }
  if (state.tool === "draw") {
    state.tool = "select";
    state.drawMode = null;
    notify("tool");
  }
  if (tool.key === "image") {
    pickFile("image/*", async (file) => {
      const card = addCardAtCenter("image");
      if (card) await attachImage(card.id, file);
    });
    return;
  }
  if (tool.key === "upload") {
    pickFile("*/*", async (file) => {
      if (file.type.startsWith("image/")) {
        const card = addCardAtCenter("image");
        if (card) await attachImage(card.id, file);
      } else if (file.type.startsWith("audio/")) {
        if (isTemporarilyDisabledType("audio")) {
          const card = addCardAtCenter("file");
          if (card) await attachFile(card.id, file);
        } else {
          const card = addCardAtCenter("audio");
          if (card) await attachAudio(card.id, file);
        }
      } else if (file.type.startsWith("video/")) {
        if (isTemporarilyDisabledType("video")) {
          const card = addCardAtCenter("file");
          if (card) await attachFile(card.id, file);
        } else {
          const card = addCardAtCenter("video");
          if (card) {
            const base64 = await bridge.readFileAsBase64(file);
            const path = await bridge.storeAsset(file.name, base64);
            card.url = path;
            notify("board");
          }
        }
      } else {
        const card = addCardAtCenter("file");
        if (card) await attachFile(card.id, file);
      }
    });
    return;
  }
  if (tool.key === "board") {
    const at = viewportCenterCheck();
    createNestedBoardCard(at).catch((error) => toast("Could not create board: " + error));
    return;
  }
  const card = addCardAtCenter(tool.type);
  if (card && tool.type === "document") {
    setTimeout(() => openDocumentEditor(card.id), 40);
    return;
  }
  if (card && tool.focus) {
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("mn:focus-field", { detail: { cardId: card.id, selector: tool.focus } })
      );
    }, 30);
  }
}

const TOOL_ICONS = {
  note: "note",
  link: "link",
  todo: "todo",
  line: "line",
  board: "board",
  column: "column",
  comment: "comment",
  table: "table",
  sketch: "sketch",
  color: "color",
  document: "document",
  audio: "audio",
  map: "map",
  video: "video",
  heading: "heading",
  image: "image",
  upload: "upload",
  draw: "draw",
};

let performanceMode = false;

function applyPerformanceMode(enabled) {
  performanceMode = enabled;
  document.documentElement.dataset.performance = enabled ? "true" : "false";
  localStorage.setItem("ky.performance", enabled ? "1" : "0");
}

export function setPerformanceMode(enabled) {
  applyPerformanceMode(Boolean(enabled));
}

function togglePerformanceMode() {
  applyPerformanceMode(!performanceMode);
  toast(performanceMode ? "Performance mode enabled" : "Performance mode disabled");
}

function toggleSnapToGrid() {
  if (!state.board) return;
  checkpoint();
  state.board.snapToGrid = state.board.snapToGrid !== true;
  markDirty("board");
  toast(state.board.snapToGrid ? "Snap to grid enabled" : "Snap to grid disabled");
}

function setBoardBackground(color) {
  if (!state.board) return;
  checkpoint();
  state.board.view = state.board.view || {};
  state.board.view.background = color || "";
  notify("view");
  markDirty("save");
}

async function exportBoardToFile() {
  try {
    const target = await exportCurrentBoard();
    toast(target ? `Exported to ${target}` : "Board exported");
  } catch {
    toast("Could not export this board");
  }
}

function importBoardFile() {
  pickFile("application/json,.json", async (file) => {
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || !Array.isArray(parsed.cards)) throw new Error("invalid board");
      const confirmed = await confirmAction({
        title: "Import board?",
        message: "The imported board will replace the current board content. Undo can restore it.",
        confirmLabel: "Import",
      });
      if (!confirmed) return;
      checkpoint();
      state.board.cards = parsed.cards;
      state.board.connections = Array.isArray(parsed.connections) ? parsed.connections : [];
      state.board.trash = [];
      if (parsed.title) {
        state.board.title = parsed.title;
        const meta = state.boards.find((board) => board.id === state.board.id);
        if (meta) meta.title = parsed.title;
      }
      state.board.view = parsed.view || state.board.view;
      state.selection = new Set();
      state.connectionSelection = null;
      markDirty("board");
      notify("view");
      notify("boards");
      toast("Board imported");
    } catch {
      toast("Could not import this board file");
    }
  });
}

async function backupNow() {
  if (!bridge.hasTauri) {
    toast("Backups are available in the desktop app");
    return;
  }
  toast("Creating backup...");
  try {
    const target = await bridge.backupData();
    toast(`Backup saved to ${target}`);
  } catch {
    toast("Could not create a backup");
  }
}

async function checkDatabaseIntegrity() {
  if (!bridge.hasTauri) {
    toast("Integrity checks are available in the desktop app");
    return;
  }
  try {
    const result = await bridge.dbIntegrity();
    toast(result === "ok" ? "Database integrity: OK" : `Database check: ${result}`);
  } catch {
    toast("Could not check database integrity");
  }
}

async function restoreFromBackup() {
  if (!bridge.hasTauri) {
    toast("Restore is available in the desktop app");
    return;
  }
  const path = window.prompt("Path to the Khaoyu Note backup folder:", "");
  if (!path) return;
  const confirmed = await confirmAction({
    title: "Restore backup?",
    message: "The current database and assets will be replaced by this backup, then the app restarts.",
    confirmLabel: "Restore",
  });
  if (!confirmed) return;
  try {
    await bridge.stageRestore(path.trim());
    toast("Restoring backup. The app will restart.");
    window.setTimeout(() => bridge.restartApp(), 500);
  } catch {
    toast("That folder is not a valid Khaoyu Note backup");
  }
}

function buildCommands() {
  const commands = [];
  for (const tool of TOOLS) {
    if (toolDisabledReason(tool.key)) continue;
    const label =
      tool.key === "upload"
        ? "Upload file"
        : tool.key === "draw"
          ? "Draw freehand"
          : `${t("menu.new")} ${toolLabel(tool)}`;
    commands.push({
      id: `tool.${tool.key}`,
      label,
      group: "Tools",
      icon: TOOL_ICONS[tool.key] || "plus",
      shortcut: tool.shortcut,
      keywords: toolLabel(tool),
      run: () => runTool(tool),
    });
  }
  commands.push(
    { id: "file.templates", label: t("menu.templates"), group: "File", icon: "grid", run: openTemplateLibrary },
    { id: "file.export", label: t("menu.export"), group: "File", icon: "download", run: exportBoardToFile },
    { id: "file.import", label: t("menu.import"), group: "File", icon: "upload", run: importBoardFile },
    { id: "file.backup", label: t("menu.backup"), group: "File", icon: "database", run: backupNow },
    { id: "file.integrity", label: t("menu.integrity"), group: "File", icon: "shield", run: checkDatabaseIntegrity },
    { id: "file.restore", label: t("menu.restore"), group: "File", icon: "database", run: restoreFromBackup },
    ...state.boards
      .filter((board) => board.id !== state.board?.id)
      .slice(0, 5)
      .map((board) => ({
        id: `file.recent.${board.id}`,
        label: `${t("menu.openRecent")}: ${board.title}`,
        group: "File",
        icon: "board",
        run: () => openBoard(board.id),
      })),
    { id: "file.settings", label: t("menu.settings"), group: "File", icon: "settings", run: () => openSettingsPage() },
    { id: "edit.undo", label: t("menu.undo"), group: "Edit", icon: "undo", shortcut: "Ctrl+Z", run: undo },
    { id: "edit.redo", label: t("menu.redo"), group: "Edit", icon: "redo", shortcut: "Ctrl+Shift+Z", run: redo },
    { id: "edit.select-all", label: t("menu.selectAll"), group: "Edit", icon: "check", shortcut: "Ctrl+A", run: () => selectAllCards() },
    { id: "edit.duplicate", label: t("menu.duplicate"), group: "Edit", icon: "copy", shortcut: "Ctrl+D", run: () => duplicateSelected() },
    {
      id: "edit.clear-clipboard",
      label: t("menu.clearClipboard"),
      group: "Edit",
      icon: "trash",
      shortcut: "",
      run: () => {
        if (clearClipboard()) toast("Clipboard cleared");
      },
    },
    { id: "edit.delete", label: t("menu.delete"), group: "Edit", icon: "trash", shortcut: "Del", run: () => deleteSelected() },
    { id: "view.zoom-in", label: t("menu.zoomIn"), group: "View", icon: "zoom", shortcut: "Ctrl+=", run: () => zoomBy(1.2) },
    { id: "view.zoom-out", label: t("menu.zoomOut"), group: "View", icon: "zoom", shortcut: "Ctrl+-", run: () => zoomBy(1 / 1.2) },
    { id: "view.zoom-reset", label: t("menu.resetZoom"), group: "View", icon: "zoom", shortcut: "Ctrl+0", run: () => zoomBy(1 / state.view.zoom) },
    { id: "view.theme", label: t("menu.toggleTheme"), group: "View", icon: "sun", run: () => setTheme(state.theme === "light" || state.theme === "softLight" ? "dark" : "light") },
    {
      id: "view.performance",
      label: `${t("menu.performance")}: ${performanceMode ? t("menu.on") : t("menu.off")}`,
      group: "View",
      icon: "settings",
      run: togglePerformanceMode,
    },
    {
      id: "view.snap",
      label: `${t("menu.snap")}: ${state.board?.snapToGrid ? t("menu.on") : t("menu.off")}`,
      group: "View",
      icon: "grid",
      run: toggleSnapToGrid,
    },
    { id: "view.bg.default", label: `${t("menu.bgDefault")}`, group: "View", icon: "sun", run: () => setBoardBackground("") },
    { id: "view.bg.paper", label: `${t("menu.bgPaper")}`, group: "View", icon: "sun", run: () => setBoardBackground("#f6f1e8") },
    { id: "view.bg.mist", label: `${t("menu.bgMist")}`, group: "View", icon: "sun", run: () => setBoardBackground("#eaf0f3") },
    { id: "view.bg.sage", label: `${t("menu.bgSage")}`, group: "View", icon: "sun", run: () => setBoardBackground("#e9efe5") },
    { id: "help.palette", label: t("menu.palette"), group: "Help", icon: "search", shortcut: "Ctrl+K", run: () => openCommandPalette() },
    { id: "help.shortcuts", label: t("menu.shortcuts"), group: "Help", icon: "help", shortcut: "?", run: () => openHelpModal() },
    { id: "help.updates", label: t("menu.updates"), group: "Help", icon: "download", run: () => window.dispatchEvent(new CustomEvent("mn:check-updates")) },
    { id: "help.documentation", label: t("menu.documentation"), group: "Help", icon: "help", shortcut: "", disabled: true, run: () => openDocumentation() },
  );
  return commands;
}

function buildMenuBar() {
  const bar = refs.menubar;
  if (!bar) return;
  const left = bar.querySelector(".mn-menubar-left") || bar;
  const logo = left.querySelector(".mn-logo");
  left.innerHTML = "";
  if (logo) left.append(logo);
  for (const [groupKey, labelKey] of [
    ["File", "menu.file"],
    ["Edit", "menu.edit"],
    ["Tools", "menu.tools"],
    ["View", "menu.view"],
    ["Help", "menu.help"],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mn-menubar-btn";
    button.textContent = t(labelKey);
    button.addEventListener("click", () => {
      const rect = button.getBoundingClientRect();
      const items = buildCommands()
        .filter((command) => command.group === groupKey)
        .map((command) => ({
          text: command.label,
          kbd: command.shortcut,
          disabled: command.disabled,
          onClick: command.run,
        }));
      openMenu(rect.left, rect.bottom + 4, items);
    });
    left.append(button);
  }
  if (bridge.webInfo) {
    const badge = document.createElement("a");
    badge.className = "mn-web-badge";
    badge.href = "/status";
    badge.target = "_blank";
    badge.rel = "noreferrer";
    badge.textContent = `${bridge.webInfo.host}:${bridge.webInfo.port}`;
    badge.title = `Web mode: ${bridge.webInfo.url}`;
    left.append(badge);
  }
}

function wireMenuBar() {
  buildMenuBar();
  const search = refs.commandSearchBtn;
  if (search) {
    search.innerHTML = `${icon("search", 13)}<span>${t(
      "topbar.search"
    )}</span><kbd>Ctrl K</kbd>`;
    search.addEventListener("click", () => openCommandPalette());
  }
}

function viewportCenterCheck() {
  const viewport = document.getElementById("viewport");
  const rect = viewport.getBoundingClientRect();
  return {
    x: (rect.width / 2 - state.view.x) / state.view.zoom - 130,
    y: (rect.height / 2 - state.view.y) / state.view.zoom - 60,
  };
}

// ------------------------------------------------------------------ topbar

let languagePopover = null;

function closeLanguagePopover() {
  if (!languagePopover) return;
  languagePopover.remove();
  languagePopover = null;
  document.removeEventListener("pointerdown", onLanguageOutside, true);
  document.removeEventListener("keydown", onLanguageKey, true);
  window.removeEventListener("resize", closeLanguagePopover);
  window.removeEventListener("scroll", onLanguageScroll, true);
}

const onLanguageOutside = (event) => {
  if (languagePopover && !languagePopover.contains(event.target) && event.target !== refs.languageBtn) {
    closeLanguagePopover();
  }
};

const onLanguageKey = (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeLanguagePopover();
  }
};

const onLanguageScroll = (event) => {
  // Scrolling the language list itself must not dismiss the picker. Only a canvas/page scroll
  // should close an anchored popover.
  if (languagePopover && event.target instanceof Node && languagePopover.contains(event.target)) {
    return;
  }
  closeLanguagePopover();
};

function openLanguagePopover(button) {
  closeLanguagePopover();
  const popover = document.createElement("div");
  popover.className = "ky-select-popup mn-language-popover";
  const rect = button.getBoundingClientRect();
  popover.style.top = `${Math.round(rect.bottom + 6)}px`;
  popover.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`;
  popover.style.left = "auto";
  for (const language of LANGUAGES) {
    const option = document.createElement("button");
    option.type = "button";
    option.className =
      "ky-select-item" + (getLanguage() === language.id ? " is-selected" : "");
    option.setAttribute("role", "menuitemradio");
    option.setAttribute("aria-checked", String(getLanguage() === language.id));
    option.textContent = language.native;
    option.addEventListener("click", () => {
      setLanguage(language.id);
      closeLanguagePopover();
    });
    popover.append(option);
  }
  document.body.append(popover);
  languagePopover = popover;
  document.addEventListener("pointerdown", onLanguageOutside, true);
  document.addEventListener("keydown", onLanguageKey, true);
  window.addEventListener("resize", closeLanguagePopover);
  window.addEventListener("scroll", onLanguageScroll, true);
}

function refreshTopbarLanguage() {
  if (refs.shareButton) {
    const label = refs.shareButton.querySelector(".mn-access-label");
    if (label) label.textContent = t("topbar.share");
  }
  if (refs.templateBtn) {
    const label = refs.templateBtn.querySelector("span:not(.mn-tool-icon)");
    if (label) label.textContent = "Workspace";
  }
  if (refs.commandSearchBtn) {
    const label = refs.commandSearchBtn.querySelector("span");
    if (label) label.textContent = t("topbar.search");
  }
  const trashLabel = refs.toolrail?.querySelector(".mn-trash .mn-tool-label");
  if (trashLabel) trashLabel.textContent = t("topbar.trash");
  if (refs.languageBtn) {
    refs.languageBtn.title = t("general.language");
    refs.languageBtn.setAttribute("aria-label", t("general.language"));
  }
}

function wireTopbar() {
  const el = refs;
  el.undoBtn.innerHTML = icon("undo", 16);
  el.redoBtn.innerHTML = icon("redo", 16);
  el.helpBtn.innerHTML = icon("help", 16);
  el.settingsBtn.innerHTML = icon("settings", 16);
  if (el.shareButton) {
    el.shareButton.innerHTML = `${icon("share", 14)}<span class="mn-access-label">${t(
      "topbar.share"
    )}</span>`;
  }
  el.themeBtn.innerHTML = icon("sun", 16);
  if (el.languageBtn) el.languageBtn.innerHTML = icon("globe", 16);
  el.commentCount.innerHTML = `${icon("comment", 14)}<span>0</span>`;
  if (el.templateBtn) {
    el.templateBtn.innerHTML = `${icon("grid", 14)}<span>Workspace</span>`;
    el.templateBtn.title = "Workspace and servers";
    el.templateBtn.addEventListener("click", () => openWorkspacePopover(el.templateBtn));
  }
  el.homeBtn.addEventListener("click", () => openTemplateLibrary());
  el.undoBtn.addEventListener("click", undo);
  el.redoBtn.addEventListener("click", redo);
  el.helpBtn.addEventListener("click", openHelpModal);
  el.settingsBtn.addEventListener("click", () => openSettingsPage());
  el.themeBtn.addEventListener("click", () => {
    const next = state.theme === "light" || state.theme === "softLight" ? "dark" : "light";
    setTheme(next);
  });
  if (el.languageBtn) {
    const refreshLanguageButton = () => {
      el.languageBtn.disabled = false;
      el.languageBtn.removeAttribute("aria-disabled");
      el.languageBtn.title = t("general.language");
      el.languageBtn.setAttribute("aria-label", t("general.language"));
    };
    refreshLanguageButton();
    el.languageBtn.addEventListener("click", () => {
      if (languagePopover) {
        closeLanguagePopover();
        return;
      }
      openLanguagePopover(el.languageBtn);
    });
  }
  refreshTopbarLanguage();
}

function wireZoom() {
  refs.zoomBar.addEventListener("click", (event) => {
    const button = event.target.closest("[data-zoom]");
    if (!button) return;
    const action = button.dataset.zoom;
    if (action === "in") zoomBy(1.2);
    else if (action === "out") zoomBy(1 / 1.2);
    else {
      state.view.zoom = 1;
      notify("view");
      renderView();
    }
  });
}

function zoomBy(factor) {
  if (!state.board) return;
  const viewport = document.getElementById("viewport");
  const rect = viewport.getBoundingClientRect();
  const px = rect.width / 2;
  const py = rect.height / 2;
  const worldX = (px - state.view.x) / state.view.zoom;
  const worldY = (py - state.view.y) / state.view.zoom;
  const zoom = Math.min(4, Math.max(0.15, state.view.zoom * factor));
  state.view.zoom = zoom;
  state.view.x = px - worldX * zoom;
  state.view.y = py - worldY * zoom;
  notify("view");
  renderView();
}

// ------------------------------------------------------------------ store events

function onStoreEvent(kind) {
  switch (kind) {
    case "save":
      updateSaveState();
      break;
    case "view":
      updateZoomLabel();
      break;
    case "history":
      refs.undoBtn.disabled = !canUndo();
      refs.redoBtn.disabled = !canRedo();
      break;
    case "tool":
      updateToolState();
      break;
    case "board":
    case "theme":
      updateAll();
      break;
    case "boards":
      updateTitle();
      break;
    default:
      break;
  }
}

function updateAll() {
  updateSaveState();
  updateZoomLabel();
  updateTitle();
  updateToolState();
  refs.undoBtn.disabled = !canUndo();
  refs.redoBtn.disabled = !canRedo();
  const themeName = state.theme === "dark" || state.theme === "softDark" ? "sun" : "moon";
  refs.themeBtn.innerHTML = icon(themeName, 16);
  document.getElementById("app").hidden = homeVisible();
}

function updateSaveState() {
  const label = refs.saveState;
  const map = {
    saved: "Saved",
    saving: "Saving...",
    unsaved: "Unsaved",
    error: "Save failed",
    conflict: "Conflict",
  };
  label.textContent = map[state.saveState] || "";
  label.classList.toggle("is-error", state.saveState === "error" || state.saveState === "conflict");
}

function updateZoomLabel() {
  refs.zoomLabel.textContent = `${Math.round(state.view.zoom * 100)}%`;
}

function updateTitle() {
  renderBreadcrumb();
}

function boardPath() {
  if (!state.board) return [];
  const path = [];
  let current = state.boards.find((board) => board.id === state.board.id);
  if (!current) {
    return [{ id: state.board.id, title: state.board.title || "Board" }];
  }
  const guard = new Set();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    path.unshift(current);
    const parentId = current.parentId;
    current = parentId ? state.boards.find((board) => board.id === parentId) : null;
  }
  return path;
}

function renderBreadcrumb() {
  const container = refs.breadcrumb;
  if (!container) return;
  if (!state.board) {
    container.innerHTML = "";
    return;
  }
  const path = boardPath();
  container.innerHTML = "";
  path.forEach((board, index) => {
    const sep = document.createElement("span");
    sep.className = "mn-crumb-sep";
    sep.textContent = "/";
    container.append(sep);

    const crumb = document.createElement("button");
    crumb.type = "button";
    crumb.className = "mn-crumb" + (index === path.length - 1 ? " is-current" : "");
    crumb.dataset.id = board.id;
    crumb.textContent = board.title || "Untitled";
    if (index !== path.length - 1) {
      let navigating = false;
      const navigate = async () => {
        if (navigating) return;
        navigating = true;
        await openBoard(board.id);
        navigating = false;
      };
      // Navigate on mousedown so a pending inline edit (whose blur rebuilds the breadcrumb) cannot
      // swallow the click before it reaches the crumb button.
      crumb.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        navigate();
      });
      crumb.addEventListener("click", navigate);
    } else {
      crumb.title = "Double click to rename";
      crumb.addEventListener("dblclick", () => startRenameBoard(crumb));
    }
    container.append(crumb);
  });
  document.title = `${state.board.title || "Board"} - Khaoyu Note`;
}

function startRenameBoard(crumb) {
  if (!state.board) return;
  const original = state.board.title || "Board";
  const editor = document.createElement("span");
  editor.className = "mn-crumb-edit";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "mn-crumb-edit-input";
  input.value = original;
  input.spellcheck = false;
  input.setAttribute("aria-label", "Project name");

  const save = document.createElement("button");
  save.type = "button";
  save.className = "mn-crumb-edit-btn is-primary";
  save.textContent = "Save";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "mn-crumb-edit-btn";
  cancel.textContent = "Cancel";

  const finish = (commit) => {
    const name = input.value.trim();
    if (commit && !name) {
      input.focus();
      return;
    }
    document.removeEventListener("pointerdown", onOutside, true);
    if (commit) {
      setBoardTitle(name);
    } else {
      renderBreadcrumb();
    }
  };
  const onOutside = (event) => {
    if (!editor.contains(event.target)) finish(false);
  };

  save.addEventListener("click", () => finish(true));
  cancel.addEventListener("click", () => finish(false));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  });

  editor.append(input, save, cancel);
  crumb.replaceWith(editor);
  document.addEventListener("pointerdown", onOutside, true);
  input.focus();
  input.select();
}

function updateToolState() {
  for (const button of refs.toolrail.querySelectorAll(".mn-tool")) {
    const key = button.dataset.tool;
    button.classList.toggle("is-selected-tool", state.tool === "line" && key === "line");
  }
  document.getElementById("viewport").classList.toggle(
    "is-line-tool",
    state.tool === "line"
  );
}

// ------------------------------------------------------------------ globals

function wireGlobalEvents() {
  window.addEventListener("keydown", onShortcut);
  initFileDrop();

  window.addEventListener("mn:create-note-at", (event) => {
    const point = event.detail;
    const card = addCardAt("note", point);
    if (card) {
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("mn:focus-field", {
            detail: { cardId: card.id, selector: '[data-field="text"]' },
          })
        );
      }, 30);
    }
  });

  window.addEventListener("mn:pick-image", (event) => {
    const cardId = event.detail.cardId;
    pickFile("image/*", (file) => attachImage(cardId, file));
  });

  window.addEventListener("mn:open-document", (event) => {
    openDocumentEditor(event.detail.cardId);
  });

  window.addEventListener("mn:open-drawing", (event) => {
    openDrawingEditor(event.detail.cardId);
  });

  window.addEventListener("mn:settings-changed", () => {
    buildToolRail();
  });

  window.addEventListener("mn:save-conflict", (event) => {
    const current = document.querySelector(".mn-modal-title");
    if (current && current.textContent === "Board changed outside this window") return;
    openModal({
      title: "Board changed outside this window",
      body:
        '<p class="mn-confirm-text">Another process saved this board while you had unsaved edits. ' +
        "Load the newer version and discard your edits, or keep your version as a separate copy.</p>",
      footer: [
        {
          label: "Load newer version",
          onClick: () => {
            closeModal();
            resolveSaveConflict("remote", event.detail);
          },
        },
        {
          label: "Keep my version as a copy",
          primary: true,
          onClick: () => {
            closeModal();
            resolveSaveConflict("copy", event.detail);
          },
        },
      ],
    });
  });

  window.addEventListener("mn:create-welcome", async () => {
    closeSettingsPage();
    await createBoard("Home", { withWelcome: true });
    await refreshBoards();
  });

  window.addEventListener("mn:pick-audio", (event) => {
    const cardId = event.detail.cardId;
    pickFile("audio/*", (file) => attachAudio(cardId, file));
  });

  document.addEventListener("paste", onPaste);
  const viewport = document.getElementById("viewport");
  viewport.addEventListener("dragover", onViewportDragOver);
  viewport.addEventListener("dragleave", onViewportDragLeave);
  viewport.addEventListener("drop", onDrop);
  window.addEventListener("beforeunload", () => {
    saveNow();
  });
}

function onShortcut(event) {
  if (documentEditorOpen() || drawingEditorOpen()) return;
  const typing =
    event.target &&
    (event.target.isContentEditable ||
      event.target.tagName === "INPUT" ||
      event.target.tagName === "TEXTAREA");
  const mod = event.ctrlKey || event.metaKey;

  if (event.key === "Escape") {
    closeTransient();
    if (typing) return;
    if (state.tool === "line") {
      state.tool = "select";
      state.lineFrom = null;
      notify("tool");
      return;
    }
    if (state.selection.size) {
      setSelection([]);
      return;
    }
    return;
  }

  if (typing) return;

  if (mod && event.key.toLowerCase() === "g" && canWrapInColumn([...state.selection])) {
    event.preventDefault();
    wrapInColumn([...state.selection]);
    return;
  }

  if (!mod && !event.altKey && !event.shiftKey && state.board) {
    if (refs.menuLayer && refs.menuLayer.classList.contains("is-open")) return;
    const tool = TOOLS.find((entry) => entry.shortcut === event.key.toUpperCase());
    if (tool) {
      event.preventDefault();
      runTool(tool);
      return;
    }
  }

  if (mod && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (mod && event.key.toLowerCase() === "y") {
    event.preventDefault();
    redo();
    return;
  }
  if (mod && event.key.toLowerCase() === "d") {
    event.preventDefault();
    duplicateSelected();
    return;
  }
  if (mod && !event.altKey && event.key.toLowerCase() === "c") {
    const count = copySelected();
    if (count) {
      event.preventDefault();
      toast(`${count} card${count === 1 ? "" : "s"} copied`);
    }
    return;
  }
  if (mod && !event.altKey && event.key.toLowerCase() === "x") {
    const count = cutSelected();
    if (count) {
      event.preventDefault();
      toast(`${count} card${count === 1 ? "" : "s"} cut`);
    }
    return;
  }
  if (mod && !event.altKey && event.key.toLowerCase() === "v") {
    const count = pasteCards();
    if (count) {
      event.preventDefault();
      toast(`${count} card${count === 1 ? "" : "s"} pasted`);
    }
    return;
  }
  if (mod && event.altKey) {
    const key = event.key.toLowerCase();
    if (key === "n") {
      event.preventDefault();
      addCardAtCenter("note");
      return;
    }
    if (key === "g") {
      event.preventDefault();
      addCardAtCenter("column");
      return;
    }
    if (key === "i") {
      event.preventDefault();
      pickFile("image/*", async (file) => {
        const card = addCardAtCenter("image");
        if (card) await attachImage(card.id, file);
      });
      return;
    }
    if (key === "b") {
      event.preventDefault();
      createNestedBoardCard(viewportCenterCheck()).catch((error) => toast("Could not create board: " + error));
      return;
    }
  }
  if (mod && event.key.toLowerCase() === "a") {
    event.preventDefault();
    selectAllCards();
    return;
  }
  if (mod && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveNow().then(() => toast("Board saved"));
    return;
  }
  if (mod && event.key === "0") {
    event.preventDefault();
    state.view.zoom = 1;
    notify("view");
    renderView();
    return;
  }
  if (mod && (event.key === "=" || event.key === "+")) {
    event.preventDefault();
    zoomBy(1.2);
    return;
  }
  if (mod && event.key === "-") {
    event.preventDefault();
    zoomBy(1 / 1.2);
    return;
  }
  if (event.key === "Delete" || event.key === "Backspace") {
    if (state.selection.size || state.connectionSelection) {
      event.preventDefault();
      deleteSelected();
    }
    return;
  }
  if (event.key === "Enter" && state.selection.size === 1) {
    const [id] = state.selection;
    const card = getCard(state.board, id);
    const el = cardElement(id);
    if (card && el) {
      const target = el.querySelector('[data-field="text"], [data-field="title"]');
      if (target && target.isContentEditable) {
        window.dispatchEvent(
          new CustomEvent("mn:focus-field", {
            detail: { cardId: id, selector: '[data-field="text"], [data-field="title"]' },
          })
        );
      }
    }
    return;
  }
  if ((event.key === "?" || event.key === "F1") && !mod) {
    event.preventDefault();
    openHelpModal();
  }
}

function closeTransient() {
  closeMenu();
  closeModal();
}

// ------------------------------------------------------------------ clipboard

async function onPaste(event) {
  if (!state.board) return;
  const target = event.target;
  if (target && (target.isContentEditable || target.tagName === "INPUT")) return;
  if (hasClipboard()) {
    event.preventDefault();
    const count = pasteCards();
    if (count) toast(`${count} card${count === 1 ? "" : "s"} pasted`);
    return;
  }
  const items = event.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (!file) continue;
      event.preventDefault();
      const card = addCardAtCenter("image");
      if (card) await attachImage(card.id, file);
      return;
    }
  }
  const text = event.clipboardData?.getData("text")?.trim();
  if (text && /^https?:\/\//i.test(text)) {
    event.preventDefault();
    const card = addCardAtCenter("link", { url: text });
    if (card) {
      try {
        card.title = new URL(text).hostname.replace(/^www\./, "");
      } catch {
        /* ignore */
      }
      notify("board");
      void maybeAutoLinkHeader(card.id);
    }
  }
}

function onViewportDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  if (draggingToolKey) showToolDragPreview(draggingToolKey, event);
}

function onViewportDragLeave(event) {
  const viewport = document.getElementById("viewport");
  if (!viewport.contains(event.relatedTarget)) clearToolDragPreview();
}

async function onDrop(event) {
  event.preventDefault();
  if (!state.board) return;
  const viewport = document.getElementById("viewport");
  const toolKey = event.dataTransfer?.getData("application/x-mn-tool") || draggingToolKey;
  if (toolKey) {
    clearToolDragPreview();
    draggingToolKey = null;
    const column = columnAtPoint(event.clientX, event.clientY);
    createToolFromDrop(toolKey, event.clientX, event.clientY, column?.id || null);
    return;
  }
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length) return;
  const point = {
    x: (event.clientX - viewport.getBoundingClientRect().left - state.view.x) / state.view.zoom,
    y: (event.clientY - viewport.getBoundingClientRect().top - state.view.y) / state.view.zoom,
  };
  for (const file of files) {
    if (file.type.startsWith("image/")) {
      const card = addCardAt("image", point);
      if (card) await attachImage(card.id, file);
    } else if (file.type.startsWith("audio/")) {
      if (isTemporarilyDisabledType("audio")) {
        const card = addCardAt("file", point);
        if (card) await attachFile(card.id, file);
      } else {
        const card = addCardAt("audio", point);
        if (card) await attachAudio(card.id, file);
      }
    } else {
      const card = addCardAt("file", point);
      if (card) await attachFile(card.id, file);
    }
  }
}

function pickFile(accept, onPick) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.style.display = "none";
  document.body.append(input);
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    input.remove();
    if (file) onPick(file);
  });
  input.click();
}

// ------------------------------------------------------------------ menus

export function openMenu(x, y, items) {
  closeMenu();
  const layer = refs.menuLayer;
  layer.innerHTML = "";
  layer.classList.add("is-open");
  const menu = document.createElement("div");
  menu.className = "mn-menu";
  for (const item of items) {
    if (item.type === "sep") {
      const sep = document.createElement("div");
      sep.className = "mn-menu-sep";
      menu.append(sep);
      continue;
    }
    if (item.type === "label") {
      const label = document.createElement("div");
      label.className = "mn-menu-label";
      label.textContent = translateActionText(item.text);
      menu.append(label);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "mn-menu-item" + (item.danger ? " is-danger" : "") + (item.disabled ? " is-disabled" : "");
    button.disabled = Boolean(item.disabled);
    button.innerHTML = `<span>${translateActionText(item.text)}</span>${
      item.checked !== undefined
        ? `<span class="mn-menu-check"><input type="checkbox" tabindex="-1" ${
            item.checked ? "checked" : ""
          } /></span>`
        : ""
    }${item.kbd ? `<span class="mn-menu-kbd">${item.kbd}</span>` : ""}`;
    button.addEventListener("click", () => {
      if (item.disabled) return;
      closeMenu();
      item.onClick?.();
    });
    menu.append(button);
  }
  layer.append(menu);
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  layer.onpointerdown = (event) => {
    if (!menu.contains(event.target)) closeMenu();
  };
}

export function closeMenu() {
  if (!refs.menuLayer) return;
  refs.menuLayer.classList.remove("is-open");
  refs.menuLayer.innerHTML = "";
  refs.menuLayer.onpointerdown = null;
}

// ------------------------------------------------------------------ modals

let modalCloser = null;

function openTrashPanel() {
  if (!state.board) return;
  const entries = Array.isArray(state.board.trash) ? state.board.trash : [];
  if (!entries.length) {
    closeModal();
    toast("Trash is empty.");
    return;
  }
  const body = document.createElement("div");
  body.className = "mn-trash-list";
  for (const entry of entries) {
    const first = entry.cards?.[0];
    if (!first) continue;
    const text = String(first.text || first.title || first.name || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 46);
    const label = `${TYPE_LABELS[first.type] || first.type}${text ? `: ${text}` : ""}${
      entry.cards.length > 1 ? ` +${entry.cards.length - 1}` : ""
    }`;
    const row = document.createElement("div");
    row.className = "mn-trash-row";
    row.innerHTML = `<span class="mn-trash-label">${icon("trash", 13)}<span>${escapeHtml(label)}</span></span>
      <span class="mn-trash-actions">
        <button type="button" class="mn-btn mn-btn-quiet" data-trash="restore">Restore</button>
        <button type="button" class="mn-btn mn-btn-quiet" data-trash="delete">Delete</button>
      </span>`;
    row.querySelector('[data-trash="restore"]').addEventListener("click", () => {
      restoreTrashEntry(entry.id);
      openTrashPanel();
    });
    row.querySelector('[data-trash="delete"]').addEventListener("click", () => {
      deleteTrashEntry(entry.id);
      openTrashPanel();
    });
    body.append(row);
  }
  openModal({
    title: "Trash",
    body,
    footer: [
      {
        label: "Empty trash",
        onClick: () => {
          closeModal();
          confirmAction({
            title: "Empty trash?",
            message: "All deleted cards in this board will be removed permanently.",
            confirmLabel: "Empty trash",
          }).then((confirmed) => {
            if (!confirmed) return;
            const count = emptyTrashEntries();
            toast(`${count} trash item${count === 1 ? "" : "s"} removed`);
          });
        },
      },
    ],
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function confirmAction({ title = "Confirm", message = "", confirmLabel = "Delete" } = {}) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: `<p class="mn-confirm-text">${message}</p>`,
      footer: [
        {
          label: "Cancel",
          onClick: () => {
            closeModal();
            resolve(false);
          },
        },
        {
          label: confirmLabel,
          primary: true,
          onClick: () => {
            closeModal();
            resolve(true);
          },
        },
      ],
    });
  });
}

export function openModal({ title, body, footer, width }) {
  closeModal();
  const layer = document.getElementById("modal-layer");
  const overlay = document.createElement("div");
  overlay.className = "mn-overlay";
  const modal = document.createElement("div");
  modal.className = "mn-modal";
  if (width) modal.style.width = width;
  modal.innerHTML = `<header class="mn-modal-head">
      <h2 class="mn-modal-title">${title}</h2>
      <button type="button" class="mn-icon-btn mn-modal-close" title="Close">${icon("close", 14)}</button>
    </header>
    <div class="mn-modal-body"></div>
    <footer class="mn-modal-foot"></footer>`;
  const bodyEl = modal.querySelector(".mn-modal-body");
  const footerEl = modal.querySelector(".mn-modal-foot");
  if (typeof body === "string") bodyEl.innerHTML = body;
  else if (body) bodyEl.append(body);
  for (const action of footer || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mn-btn" + (action.primary ? " mn-btn-primary" : "");
    button.textContent = action.label;
    button.addEventListener("click", () => {
      if (action.onClick) action.onClick();
      else closeModal();
    });
    footerEl.append(button);
  }
  overlay.append(modal);
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) closeModal();
  });
  modal.querySelector(".mn-modal-close").addEventListener("click", closeModal);
  layer.append(overlay);
  if (window.KySelect) window.KySelect.enhanceAll(modal);
  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
    }
  };
  document.addEventListener("keydown", onKeyDown, true);
  modalCloser = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKeyDown, true);
  };
  return { bodyEl, footerEl, modal };
}

export function closeModal() {
  if (modalCloser) {
    modalCloser();
    modalCloser = null;
  }
}

// ------------------------------------------------------------------ help

function openDocumentation() {
  openModal({
    title: "Documentation",
    body: createDocumentation(),
    footer: [{ label: "Close" }],
    width: "min(980px, calc(100vw - 48px))",
  });
}

function openHelpModal() {
  const rows = [
    ["Pan", "Space + drag, middle drag, wheel"],
    ["Zoom", "Ctrl + wheel, Ctrl +/-"],
    ["Zoom to 100%", "Ctrl + 0"],
    ["Edit text", "Double click a card"],
    ["New note", "Double click empty canvas"],
    ["Select all", "Ctrl + A"],
    ["Multi select", "Shift + click or drag"],
    ["Duplicate", "Ctrl + D"],
    ["Undo / Redo", "Ctrl + Z / Ctrl + Shift + Z"],
    ["Delete", "Delete / Backspace"],
    ["Connect cards", "Line tool, drag from one card to another"],
    ["Save", "Ctrl + S (auto-saves too)"],
  ];
  const table = `<div class="mn-kbd-table">${rows
    .map(([name, keys]) => `<span>${name}</span><span>${keys}</span>`)
    .join("")}</div>`;
  openModal({
    title: "Keyboard shortcuts",
    body: table,
    footer: [{ label: "Close", primary: true }],
  });
}

// ------------------------------------------------------------------ misc

export function toast(message) {
  const el = refs.toast;
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2600);
}

function escapeText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function relativeTime(date) {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

// ------------------------------------------------------------------ context menu

export function initContextMenu() {
  const viewport = document.getElementById("viewport");
  window.addEventListener("mn:open-docs", openDocumentation);
  window.addEventListener("mn:toast", (event) => {
  if (event.detail?.message) toast(event.detail.message);
});

window.addEventListener("mn:open-menu", (event) => {
    const detail = event.detail || {};
    if (!Array.isArray(detail.items)) return;
    openMenu(detail.x || 0, detail.y || 0, detail.items);
  });
  viewport.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const cardEl = event.target.closest(".mn-card");
    if (cardEl) {
      const card = getCard(state.board, cardEl.dataset.id);
      if (!card) return;
      if (!state.selection.has(card.id)) setSelection([card.id]);
      const ids = [...state.selection];
      const isBoard = card.type === "board";
      const isSection = card.type === "section";
      const items = [{ type: "label", text: TYPE_LABELS[card.type] || card.type }];
      if ((card.type === "audio" || card.type === "video") && card.url) {
        const mediaEl = cardElement(card.id)?.querySelector("audio,video");
        const playing = mediaEl
          ? !mediaEl.paused && !mediaEl.ended
          : Boolean(card.__mediaPlaying);
        items.push({
          text: "Play",
          disabled: playing,
          onClick: () => playMedia(card.id),
        });
        items.push({
          text: "Pause",
          disabled: !playing,
          onClick: () => pauseMedia(card.id),
        });
        items.push({
          text: "Repeat",
          checked: Boolean(card.repeat),
          onClick: () => toggleMediaRepeat(card.id),
        });
        items.push({ type: "sep" });
      }
      items.push({ text: "Share link", onClick: () => openSharePanel(card), disabled: true });
      items.push({ type: "sep" });
      if (isBoard) {
        items.push({ text: "Open board", kbd: "Enter", onClick: () => openBoardCard(card) });
        items.push({ type: "sep" });
      }
      if (!card.locked && card.type === "note") {
        items.push({ text: "Convert to document", onClick: () => convertNoteToDocument(card.id) });
        items.push({ type: "sep" });
      }
      if (!card.locked && card.type === "column") {
        items.push({ text: "Convert to board", onClick: () => convertColumnToBoard(card.id) });
        items.push({
          text: card.direction === "row" ? "Convert to column" : "Convert to row",
          onClick: () => setColumnDirection(card.id, card.direction === "row" ? "column" : "row"),
        });
        if (card.fitChildren || card.extraWidth || card.extraHeight) {
          items.push({ text: "Fit container to items", onClick: () => fitColumnToContent(card.id) });
        }
        if (canReleaseContainer(card.id)) {
          items.push({
            text: card.kanban
              ? "Release kanban"
              : card.direction === "row"
                ? "Release row"
                : "Release column",
            onClick: () => releaseContainer(card.id),
          });
        }
        items.push({ type: "sep" });
      }
      if (!card.locked && card.type === "link") {
        items.push({
          text: card.headerImage ? "Change header image" : "Add header image",
          onClick: () => pickFile("image/*", (file) => attachLinkHeader(card.id, file)),
        });
        if (card.headerImage) {
          items.push({
            text: "Crop header image",
            onClick: () =>
              openImageCrop({
                src: bridge.convertFileSrc(card.headerImage),
                crop: card.headerImageCrop,
                onApply: (crop) => applyLinkHeaderCrop(card.id, crop),
              }),
          });
          items.push({
            text: "Remove header image",
            onClick: () => removeLinkHeader(card.id),
          });
        }
        items.push({ type: "sep" });
      }
      if (!card.locked && card.type === "image" && card.src) {
        items.push({
          text: "Crop image",
          onClick: () =>
            openImageCrop({
              src: bridge.convertFileSrc(card.src),
              crop: card.imageCrop,
              onApply: (crop) => applyImageCrop(card.id, crop),
            }),
        });
        items.push({ type: "sep" });
      }
      const assetPath = assetPathForCard(card);
      if (assetPath) {
        items.push({
          text: "Download asset",
          onClick: async () => {
            try {
              const destination = await downloadCardAsset(card);
              toast(destination ? `Downloaded ${destination.split(/[\\/]/).pop()}` : "Nothing to download");
            } catch {
              toast("Could not download this asset");
            }
          },
        });
        items.push({ type: "sep" });
      }
      items.push(
        { text: "Cut", kbd: "Ctrl+X", onClick: () => cutSelected() },
        { text: "Copy", kbd: "Ctrl+C", onClick: () => copySelected() },
        { text: "Paste", kbd: "Ctrl+V", onClick: () => pasteCards() },
        { text: "Duplicate", kbd: "Ctrl+D", onClick: () => duplicateSelected() },
        {
          text: "Create template from selection",
          onClick: () => createTemplateFromSelection(ids),
        },
        {
          text: "Clear clipboard",
          disabled: !hasClipboard(),
          onClick: () => {
            if (clearClipboard()) toast("Clipboard cleared");
          },
        },
        { type: "sep" }
      );
      if (!isSection) {
        items.push(
          { text: "Bring to front", onClick: () => bringToFront(card, ids) },
          { text: "Send to back", onClick: () => sendToBack(card, ids) }
        );
      }
      items.push(
        isSection
          ? {
              text: card.positionLocked ? "Unlock position" : "Lock position",
              onClick: () => setSectionPositionLocked(card.id, !card.positionLocked),
            }
          : {
              text: card.locked ? "Unlock position" : "Lock position",
              onClick: () => setCardsLocked(ids, !card.locked),
            },
        { type: "sep" }
      );
      if (canWrapInColumn(ids)) {
        items.push({ text: "Wrap in column", kbd: "Ctrl+G", onClick: () => wrapInColumn(ids) });
        items.push({ type: "sep" });
      }
      if (canWrapInSection(ids)) {
        items.push({ text: "Wrap into section", onClick: () => wrapInSection(ids) });
      }
      const selectedColumnCards = ids
        .map((id) => getCard(state.board, id))
        .filter((selected) => selected?.type === "column");
      if (selectedColumnCards.length) {
        items.push({
          text: "Wrap into kanban",
          disabled: !canWrapInKanban(ids),
          onClick: () => wrapInKanban(ids),
        });
      }
      if (
        canWrapInSection(ids) ||
        ids.some((id) => getCard(state.board, id)?.type === "column")
      ) {
        items.push({ type: "sep" });
      }
      items.push(
        { text: "Delete", danger: true, kbd: "Del", onClick: () => deleteSelected() }
      );
      openMenu(event.clientX, event.clientY, items);
      return;
    }
    const newItems = [
      ["note", "New note", "N"],
      ["link", "New link", "L"],
      ["todo", "New to-do", "T"],
      ["line", "New line", "A"],
      ["heading", "New heading", "H"],
      ["board", "New board", "G"],
      ["column", "New column", "C"],
      ["comment", "New comment", "M"],
      ["table", "New table", "X"],
      ["image", "New image", "I"],
      ["upload", "New file", "W"],
    ].map(([key, label, kbd]) => ({
      text: label,
      kbd,
      onClick: () => {
        if (key === "line") {
          state.tool = "line";
          state.lineFrom = null;
          notify("tool");
          return;
        }
        createToolFromDrop(key, event.clientX, event.clientY);
      },
    }));
    openMenu(event.clientX, event.clientY, [
      { type: "label", text: "Canvas" },
      { text: "Undo", kbd: "Ctrl+Z", disabled: !canUndo(), onClick: () => undo() },
      { text: "Redo", kbd: "Ctrl+Shift+Z", disabled: !canRedo(), onClick: () => redo() },
      { type: "sep" },
      ...newItems,
      { type: "sep" },
      { text: "Select all", kbd: "Ctrl+A", onClick: () => selectAllCards() },
      { text: "Zoom in", kbd: "Ctrl+=", onClick: () => zoomBy(1.2) },
      { text: "Zoom out", kbd: "Ctrl+-", onClick: () => zoomBy(1 / 1.2) },
      {
        text: "Reset zoom",
        kbd: "Ctrl+0",
        onClick: () => {
          state.view.zoom = 1;
          renderView();
          notify("view");
        },
      },
    ]);
  });
}

