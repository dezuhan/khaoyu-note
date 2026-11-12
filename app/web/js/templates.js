// Template library: replace the single current board with a starter layout.

import { captureSelectionForTemplate } from "./actions.js";
import { icon } from "./icons.js";
import { t } from "./i18n.js";
import { createCard, layoutColumns, newBoardDoc, uid, visibleCards, welcomeBoard } from "./model.js";
import { checkpoint, markDirty, notify, state } from "./store.js";

const PROTECTED_TEMPLATE_IDS = new Set(["blank"]);
const CUSTOM_TEMPLATES_KEY = "ky.templates.custom";
const DELETED_TEMPLATES_KEY = "ky.templates.deleted";

let overlay = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readStoredArray(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function readCustomTemplates() {
  return readStoredArray(CUSTOM_TEMPLATES_KEY).filter(
    (template) => template && template.id && Array.isArray(template.cards)
  );
}

function readDeletedTemplates() {
  return readStoredArray(DELETED_TEMPLATES_KEY).filter((id) => typeof id === "string");
}

function writeCustomTemplates(templates) {
  localStorage.setItem(CUSTOM_TEMPLATES_KEY, JSON.stringify(templates));
}

function writeDeletedTemplates(ids) {
  localStorage.setItem(DELETED_TEMPLATES_KEY, JSON.stringify([...new Set(ids)]));
}

export function isBuiltInTemplate(id) {
  return TEMPLATES.some((template) => template.id === id);
}

function instantiateTemplate(template) {
  const idMap = new Map();
  const cards = (template.cards || []).map((card) => {
    const clone = JSON.parse(JSON.stringify(card));
    const oldId = clone.id;
    clone.id = uid(clone.type || "card");
    idMap.set(oldId, clone.id);
    return clone;
  });
  for (const card of cards) {
    card.parentId = card.parentId ? idMap.get(card.parentId) || null : null;
  }
  const connections = (template.connections || [])
    .map((connection) => ({
      ...JSON.parse(JSON.stringify(connection)),
      id: uid("conn"),
      from: idMap.get(connection.from) || null,
      to: idMap.get(connection.to) || null,
    }))
    .filter((connection) => connection.from && connection.to);
  return { title: template.name, cards, connections };
}

export function listTemplates() {
  const deleted = new Set(readDeletedTemplates());
  const builtIns = TEMPLATES.filter((template) => !deleted.has(template.id));
  const custom = readCustomTemplates().map((template) => ({
    ...template,
    custom: true,
    icon: template.icon || "note",
    build: () => instantiateTemplate(template),
  }));
  return [...builtIns, ...custom];
}

export function canDeleteTemplate(id) {
  return !PROTECTED_TEMPLATE_IDS.has(id);
}

export function deleteTemplate(id) {
  if (!id || !canDeleteTemplate(id)) return false;
  if (isBuiltInTemplate(id)) {
    const deleted = readDeletedTemplates();
    if (!deleted.includes(id)) writeDeletedTemplates([...deleted, id]);
    return true;
  }
  const custom = readCustomTemplates();
  const next = custom.filter((template) => template.id !== id);
  if (next.length === custom.length) return false;
  writeCustomTemplates(next);
  return true;
}

export function restoreBuiltInTemplates() {
  writeDeletedTemplates([]);
}

function todoItems(items) {
  return items.map((text, index) => ({
    id: uid("i"),
    text,
    done: false,
    order: index,
  }));
}

function starter(title, buildCards) {
  return () => {
    const doc = newBoardDoc(title);
    let z = 0;
    const add = (type, x, y, extra = {}) => {
      const card = createCard(type, x, y, extra);
      card.z = ++z;
      doc.cards.push(card);
      return card;
    };
    buildCards(add);
    doc.title = title;
    return doc;
  };
}

export const TEMPLATES = [
  {
    id: "blank",
    name: "Blank board",
    description: "Start with an empty canvas.",
    icon: "board",
    build: () => ({ title: "Untitled board", cards: [], connections: [] }),
  },
  {
    id: "welcome",
    name: "Welcome board",
    description: "A tour with every card type and a nested example.",
    icon: "note",
    build: () => {
      const doc = welcomeBoard();
      return { title: "Welcome board", cards: doc.cards, connections: doc.connections || [] };
    },
  },
  {
    id: "project",
    name: "Project plan",
    description: "Goal, checklist and a simple work table.",
    icon: "todo",
    build: starter("Project plan", (add) => {
      add("heading", 120, 100, { text: "Project plan" });
      add("note", 120, 210, {
        text: "Write the goal, the people involved and the definition of done here.",
      });
      add("todo", 120, 360, {
        title: "Milestones",
        items: todoItems(["Kickoff", "First draft", "Review", "Launch"]),
      });
      add("table", 460, 210, {
        cells: [
          ["Task", "Owner", "Status"],
          ["Research", "You", "Doing"],
          ["Draft", "You", "Todo"],
          ["Review", "Team", "Todo"],
        ],
      });
    }),
  },
  {
    id: "kanban",
    name: "Kanban board",
    description: "A row of Backlog, In progress and Done columns.",
    icon: "column",
    build: starter("Kanban board", (add) => {
      add("heading", 120, 80, { text: "Kanban board" });
      const kanban = add("column", 120, 200, { title: "Kanban", direction: "row", kanban: true });
      kanban.w = 980;
      kanban.h = 520;
      ["Backlog", "In progress", "Done"].forEach((title, index) => {
        const column = add("column", 134, 264, { title });
        column.parentId = kanban.id;
        column.order = index;
        column.w = 300;
      });
    }),
  },
  {
    id: "meeting",
    name: "Meeting notes",
    description: "Agenda, notes and action items.",
    icon: "document",
    build: starter("Meeting notes", (add) => {
      add("heading", 120, 100, { text: "Meeting notes" });
      add("note", 120, 200, { text: "Date, attendees and agenda." });
      add("document", 120, 340, {
        title: "Notes",
        text: "- Context\n- Decisions\n- Open questions",
      });
      add("todo", 460, 200, {
        title: "Action items",
        items: todoItems(["Follow up", "Send recap"]),
      });
    }),
  },
  {
    id: "moodboard",
    name: "Moodboard",
    description: "Colour, sketch and reference space.",
    icon: "color",
    build: starter("Moodboard", (add) => {
      add("heading", 120, 90, { text: "Moodboard" });
      add("color", 120, 200, { color: "#B262C0" });
      add("sketch", 430, 200);
      add("note", 730, 200, { text: "Collect references and keep the visual direction here." });
    }),
  },
];

function promptTemplateName(defaultValue) {
  return new Promise((resolve) => {
    const layer = document.createElement("div");
    layer.className = "mn-overlay";
    layer.innerHTML = `<div class="mn-modal mn-template-name-modal">
        <header class="mn-modal-head">
          <h2 class="mn-modal-title">${t("templates.createTitle")}</h2>
        </header>
        <div class="mn-modal-body">
          <p class="mn-confirm-text">Save the current selection as a reusable board template.</p>
          <label class="mn-template-name-label" for="mn-template-name">${t("templates.name")}</label>
          <input id="mn-template-name" class="mn-field-input" maxlength="80" value="${escapeHtml(
            defaultValue
          )}" />
        </div>
        <footer class="mn-modal-foot">
          <button type="button" class="mn-btn" data-template-cancel>${t("templates.cancel")}</button>
          <button type="button" class="mn-btn mn-btn-primary" data-template-save>${t("templates.save")}</button>
        </footer>
      </div>`;
    document.body.append(layer);
    const input = layer.querySelector("#mn-template-name");
    const save = layer.querySelector("[data-template-save]");
    const finish = (value) => {
      layer.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(null);
      } else if (event.key === "Enter") {
        event.preventDefault();
        const name = input.value.trim();
        if (name) finish(name);
      }
    };
    layer.querySelector("[data-template-cancel]").addEventListener("click", () => finish(null));
    save.addEventListener("click", () => {
      const name = input.value.trim();
      if (name) finish(name);
    });
    layer.addEventListener("pointerdown", (event) => {
      if (event.target === layer) finish(null);
    });
    document.addEventListener("keydown", onKey, true);
    input.focus();
    input.select();
  });
}

export async function createTemplateFromSelection(ids = [...state.selection]) {
  if (!state.board || !ids.length) {
    window.dispatchEvent(
      new CustomEvent("mn:toast", { detail: { message: "Select one or more cards first." } })
    );
    return null;
  }
  const snapshot = captureSelectionForTemplate(ids);
  if (!snapshot?.cards.length) return null;
  const name = await promptTemplateName("My template");
  if (!name) return null;
  const template = {
    id: uid("tpl"),
    name,
    description: `${snapshot.cards.length} card${snapshot.cards.length === 1 ? "" : "s"} from ${
      state.board.title || "this board"
    }`,
    icon: "note",
    custom: true,
    cards: snapshot.cards,
    connections: snapshot.connections,
    createdAt: Date.now(),
  };
  try {
    const custom = readCustomTemplates();
    writeCustomTemplates([template, ...custom]);
  } catch {
    window.dispatchEvent(
      new CustomEvent("mn:toast", { detail: { message: "Could not save the template." } })
    );
    return null;
  }
  window.dispatchEvent(
    new CustomEvent("mn:toast", { detail: { message: `Template "${name}" saved.` } })
  );
  return template;
}

export function openTemplateLibrary() {
  if (overlay) return;
  overlay = document.createElement("div");
  overlay.className = "mn-overlay";
  overlay.innerHTML = `<div class="mn-template-modal">
      <header class="mn-template-head">
        <div>
          <h2>${t("templates.library")}</h2>
          <p>${t("templates.libraryDesc")}</p>
        </div>
        <div class="mn-template-actions">
          <button type="button" class="mn-icon-btn mn-template-edit" title="Manage templates">${icon(
            "settings",
            14
          )}</button>
          <button type="button" class="mn-icon-btn mn-template-close" title="Close">${icon(
            "close",
            14
          )}</button>
        </div>
      </header>
      <div class="mn-template-grid"></div>
    </div>`;
  document.body.append(overlay);
  const grid = overlay.querySelector(".mn-template-grid");
  const templates = listTemplates();
  if (!templates.length) {
    grid.innerHTML = `<p class="mn-template-empty">${t("templates.empty")}</p>`;
  }
  for (const template of templates) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "mn-template-card";
    card.innerHTML = `<span class="mn-template-preview">${icon(template.icon || "note", 24)}</span>
      <span class="mn-template-copy"><span class="mn-template-name">${escapeHtml(
        template.name
      )}${template.custom ? `<span class="mn-template-badge">${t("templates.custom")}</span>` : ""}</span>
      <span class="mn-template-desc">${escapeHtml(template.description || "")}</span></span>`;
    card.addEventListener("click", () => applyTemplate(template));
    grid.append(card);
  }
  overlay.querySelector(".mn-template-close").addEventListener("click", closeTemplates);
  overlay.querySelector(".mn-template-edit").addEventListener("click", async () => {
    closeTemplates();
    const { openSettingsPage } = await import("./settings.js");
    openSettingsPage("templates");
  });
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) closeTemplates();
  });
  window.addEventListener("keydown", onTemplatesKey, true);
}

function closeTemplates() {
  if (!overlay) return;
  overlay.remove();
  overlay = null;
  window.removeEventListener("keydown", onTemplatesKey, true);
}

function onTemplatesKey(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeTemplates();
  }
}

function confirmTemplateOverwrite(template) {
  return new Promise((resolve) => {
    const count = state.board?.cards.length || 0;
    const layer = document.createElement("div");
    layer.className = "mn-overlay mn-template-confirm-overlay";
    layer.innerHTML = `<div class="mn-modal mn-template-confirm">
        <header class="mn-modal-head">
          <h2 class="mn-modal-title">Overwrite this board?</h2>
        </header>
        <div class="mn-modal-body">
          <p class="mn-confirm-text">This board already has ${count} card${
            count === 1 ? "" : "s"
          }. Applying <strong>${template.name}</strong> will replace all current content. Undo can restore it.</p>
        </div>
        <footer class="mn-modal-foot">
          <button type="button" class="mn-btn" data-confirm="cancel">Cancel</button>
          <button type="button" class="mn-btn mn-btn-danger" data-confirm="apply">Overwrite</button>
        </footer>
      </div>`;
    document.body.append(layer);
    const finish = (value) => {
      layer.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    };
    layer.querySelector('[data-confirm="cancel"]').addEventListener("click", () => finish(false));
    layer.querySelector('[data-confirm="apply"]').addEventListener("click", () => finish(true));
    layer.addEventListener("pointerdown", (event) => {
      if (event.target === layer) finish(false);
    });
    document.addEventListener("keydown", onKey, true);
    layer.querySelector('[data-confirm="apply"]').focus();
  });
}

async function applyTemplate(template) {
  if (!state.board) return;
  if (state.board.cards.length && !(await confirmTemplateOverwrite(template))) return;
  checkpoint();
  const built = template.build();
  // A starter must never seed a card type that is temporarily disabled.
  built.cards = visibleCards({ cards: built.cards });
  const templateCardIds = new Set(built.cards.map((card) => card.id));
  built.connections = (built.connections || []).filter(
    (connection) =>
      (!connection.from || templateCardIds.has(connection.from)) &&
      (!connection.to || templateCardIds.has(connection.to))
  );
  state.board.cards = built.cards;
  layoutColumns(state.board);
  state.board.connections = built.connections || [];
  state.board.trash = [];
  state.board.title = built.title || template.name;
  const meta = state.boards.find((board) => board.id === state.board.id);
  if (meta) meta.title = state.board.title;
  state.board.view = { x: 0, y: 0, zoom: 1 };
  state.selection = new Set();
  state.connectionSelection = null;
  closeTemplates();
  markDirty("board");
  notify("view");
  notify("boards");
  window.dispatchEvent(
    new CustomEvent("mn:toast", {
      detail: { message: `${template.name} applied. Undo to restore the previous board.` },
    })
  );
}
