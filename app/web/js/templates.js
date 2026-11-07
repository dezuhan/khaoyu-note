// Template library: replace the single current board with a starter layout.

import { icon } from "./icons.js";
import { createCard, newBoardDoc, uid, visibleCards, welcomeBoard } from "./model.js";
import { checkpoint, markDirty, notify, state } from "./store.js";

let overlay = null;

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
    description: "A full-width Backlog, In progress and Done flow.",
    icon: "kanban",
    build: starter("Kanban board", (add) => {
      add("heading", 120, 80, { text: "Kanban board" });
      const kanban = add("kanban", 120, 200);
      kanban.w = 980;
      kanban.h = 520;
      kanban.columns = [
        { id: uid("col"), title: "Backlog", items: [] },
        { id: uid("col"), title: "In progress", items: [] },
        { id: uid("col"), title: "Done", items: [] },
      ];
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

export function openTemplateLibrary() {
  if (overlay) return;
  overlay = document.createElement("div");
  overlay.className = "mn-overlay";
  overlay.innerHTML = `<div class="mn-template-modal">
      <header class="mn-template-head">
        <div>
          <h2>Template library</h2>
          <p>Apply a starter layout to this file. Undo restores the previous board.</p>
        </div>
        <button type="button" class="mn-icon-btn mn-template-close" title="Close">${icon("close", 14)}</button>
      </header>
      <div class="mn-template-grid"></div>
    </div>`;
  document.body.append(overlay);
  const grid = overlay.querySelector(".mn-template-grid");
  for (const template of TEMPLATES) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "mn-template-card";
    card.innerHTML = `<span class="mn-template-preview">${icon(template.icon, 24)}</span>
      <span class="mn-template-copy"><span class="mn-template-name">${template.name}</span>
      <span class="mn-template-desc">${template.description}</span></span>`;
    card.addEventListener("click", () => applyTemplate(template));
    grid.append(card);
  }
  overlay.querySelector(".mn-template-close").addEventListener("click", closeTemplates);
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
