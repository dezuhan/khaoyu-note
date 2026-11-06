// DOM rendering for cards, sketches and connections.

import * as bridge from "./bridge.js";
import { icon } from "./icons.js";
import {
  AUTO_HEIGHT_TYPES,
  AUDIO_CARD_H,
  CARD_ASPECTS,
  cardHeightFor,
  columnChildren,
  columnSummary,
  getCard,
  layoutColumns,
  MIN_CARD_H,
  SWATCHES,
} from "./model.js";
import { markDirty, state } from "./store.js";
import { formatCommentTime } from "./time.js";
import { paintBoardPreview } from "./preview.js";

let viewportEl = null;
let worldEl = null;
let cardsEl = null;
let connEl = null;
let svgNs = "http://www.w3.org/2000/svg";
let sketchRepaintTimer = 0;
let lastPaintZoom = 1;
const boardPreviewCache = new Map();

export function initRender(refs) {
  viewportEl = refs.viewport;
  worldEl = refs.world;
  cardsEl = refs.cards;
  connEl = refs.connections;
  cardsEl.addEventListener(
    "scroll",
    (event) => {
      const table = event.target.closest?.(".mn-table");
      if (!table) return;
      const cardEl = table.closest(".mn-card-table");
      if (!cardEl) return;
      const columns = cardEl.querySelector(".mn-sheet-cols");
      const rows = cardEl.querySelector(".mn-sheet-rows");
      if (columns) columns.style.transform = `translateX(${-table.scrollLeft}px)`;
      if (rows) rows.style.transform = `translateY(${-table.scrollTop}px)`;
    },
    true
  );
}

export function cardElement(id) {
  return cardsEl ? cardsEl.querySelector(`.mn-card[data-id="${id}"]`) : null;
}

export function worldPointFromEvent(event) {
  const rect = viewportEl.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left - state.view.x) / state.view.zoom,
    y: (event.clientY - rect.top - state.view.y) / state.view.zoom,
  };
}

export function sheetColumnName(index) {
  let name = "";
  let value = index;
  do {
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return name;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Allowlist sanitizer for the rich text stored by the document editor.
const ALLOWED_TAGS = new Set([
  "P", "DIV", "BR", "B", "STRONG", "I", "EM", "U", "S", "STRIKE",
  "UL", "OL", "LI", "H1", "H2", "H3", "BLOCKQUOTE", "PRE", "CODE", "A", "SPAN", "HR",
]);

export function sanitizeHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = html || "";
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE) {
        child.remove();
        continue;
      }
      if (!ALLOWED_TAGS.has(child.tagName)) {
        const text = document.createTextNode(child.textContent || "");
        child.replaceWith(text);
        continue;
      }
      for (const attribute of [...child.attributes]) {
        if (child.tagName === "A" && attribute.name === "href") {
          const value = attribute.value || "";
          if (!/^https?:\/\//i.test(value)) child.removeAttribute("href");
        } else {
          child.removeAttribute(attribute.name);
        }
      }
      walk(child);
    }
  };
  walk(template.content);
  return template.innerHTML;
}

function imgSrc(value) {
  if (!value) return "";
  if (value.startsWith("data:") || /^https?:/i.test(value) || value.startsWith("blob:")) return value;
  return bridge.convertFileSrc(value);
}

// ------------------------------------------------------------------ content

function fieldInput(field, value, placeholder, cls = "") {
  return `<input class="mn-field-input ${cls}" data-field="${field}" value="${escapeHtml(
    value
  )}" placeholder="${escapeHtml(placeholder)}" spellcheck="false" />`;
}

function contentFor(card) {
  switch (card.type) {
    case "note":
      return `<div class="mn-note-text" data-field="text" data-placeholder="Note" contenteditable="false">${
        card.html ? sanitizeHtml(card.html) : escapeHtml(card.text).replace(/\n/g, "<br>")
      }</div>`;

    case "heading":
      return `<div class="mn-heading-text" data-field="text" data-placeholder="Heading" contenteditable="false">${
        card.html ? sanitizeHtml(card.html) : escapeHtml(card.text)
      }</div>`;

    case "link": {
      if (!card.url) {
        return `<div class="mn-link-empty">
          <span class="mn-link-icon">${icon("link", 18)}</span>
          ${fieldInput("url", "", "Link URL")}
        </div>`;
      }
      const domain = domainOf(card.url);
      const title = (card.title || domain || "").trim();
      const showDomain = domain && title.toLowerCase() !== domain.toLowerCase();
      const header = card.headerImage
        ? `<div class="mn-link-header"><img src="${escapeHtml(
            bridge.convertFileSrc(card.headerImage)
          )}" alt="" /></div>`
        : "";
      return `<div class="mn-link${header ? " has-header" : ""}">${header}
        <div class="mn-link-row">
          <span class="mn-link-icon">${icon("link", 18)}</span>
          <div class="mn-link-body">
            ${fieldInput("title", title, "Link title", "mn-link-title")}
            ${
              showDomain
                ? `<div class="mn-link-domain" data-action="open-link" title="Open link">${escapeHtml(domain)}</div>`
                : ""
            }
          </div>
          <button class="mn-icon-btn mn-link-open" data-action="open-link" title="Open in browser">${icon(
            "arrow",
            14
          )}</button>
        </div>
      </div>`;
    }

    case "todo": {
      const items = (card.items || [])
        .map(
          (item) => `<li class="mn-todo-item ${item.done ? "is-done" : ""}" data-item="${item.id}">
            <input type="checkbox" class="mn-check" data-item-check="${item.id}" ${
            item.done ? "checked" : ""
          } />
            <span class="mn-todo-text" data-item-text="${item.id}" contenteditable="false">${escapeHtml(
            item.text
          )}</span>
            <button class="mn-icon-btn mn-item-remove" data-item-remove="${item.id}" title="Remove">${icon(
            "close",
            12
          )}</button>
            <button class="mn-icon-btn mn-todo-grip" data-todo-grip="${item.id}" title="Drag to reorder">${icon(
              "menu",
              12
            )}</button>
          </li>`
        )
        .join("");
      return `<div class="mn-todo">
        ${fieldInput("title", card.title, "To-do", "mn-todo-title")}
        <ul class="mn-todo-items">${items}</ul>
        <button class="mn-ghost-btn" data-action="add-todo">${icon("plus", 12)} Add item</button>
      </div>`;
    }

    case "document": {
      const words = (card.text || "").trim() ? (card.text || "").trim().split(/\s+/).length : 0;
      const body = card.html
        ? sanitizeHtml(card.html)
        : escapeHtml(card.text || "").replace(/\n/g, "<br>");
      return `<div class="mn-doc">
        <div class="mn-doc-head">
          <span class="mn-doc-icon">${icon("document", 16)}</span>
          ${fieldInput("title", card.title, "Document", "mn-doc-title")}
        </div>
        <div class="mn-doc-text mn-rich" data-role="doc-preview">${body}</div>
        <div class="mn-doc-count" data-role="wordcount">${words} word${words === 1 ? "" : "s"}</div>
      </div>`;
    }

    case "comment": {
      const messages = (card.messages || [])
        .map(
          (message) => `<div class="mn-msg${message.done ? " is-done" : ""}" data-msg="${message.id}">
            <input type="checkbox" class="mn-check mn-msg-check" data-msg-check="${message.id}" ${
            message.done ? "checked" : ""
          } title="Mark comment done" />
            <span class="mn-avatar">${escapeHtml(initials(message.author || "You"))}</span>
            <div class="mn-msg-body"><span class="mn-msg-meta"><span class="mn-msg-author">${escapeHtml(
              message.author || "You"
            )}</span><span class="mn-msg-time">${escapeHtml(
              formatCommentTime(message.ts)
            )}</span></span><span class="mn-msg-text">${escapeHtml(message.text)}</span></div>
            <button type="button" class="mn-msg-menu" data-action="comment-menu" data-msg="${
              message.id
            }" title="Comment actions">${icon("more", 13)}</button>
          </div>`
        )
        .join("");
      return `<div class="mn-comment">
        <div class="mn-comment-rows">${messages || `<div class="mn-comment-empty">No comments yet</div>`}</div>
        <div class="mn-comment-row">
          <span class="mn-avatar mn-avatar-me">${escapeHtml(initials("You"))}</span>
          <input class="mn-field-input mn-comment-input" data-field="comment-draft" placeholder="Comment" />
          <button class="mn-primary-btn" data-action="send-comment">Send</button>
        </div>
      </div>`;
    }

    case "table": {
      const rows = card.cells || [];
      const body = rows
        .map(
          (row, r) => `<tr>${row
            .map(
              (cell, c) =>
                `<td class="${r === 0 ? "mn-th" : ""}" data-cell="${r}:${c}" contenteditable="false">${escapeHtml(
                  cell
                )}</td>`
            )
            .join("")}</tr>`
        )
        .join("");
      const columnCount = Math.max(1, rows[0]?.length || 0);
      const fallbackWidth = Math.max(60, (card.w - 4) / columnCount);
      const colWidths =
        Array.isArray(card.colWidths) && card.colWidths.length === columnCount
          ? card.colWidths.map((width) => Math.max(40, Number(width) || fallbackWidth))
          : Array.from({ length: columnCount }, () => fallbackWidth);
      const gridTemplate = colWidths.map((width) => `${Math.round(width)}px`).join(" ");
      const totalWidth = colWidths.reduce((sum, width) => sum + Math.round(width), 0);
      const colgroup = `<colgroup>${colWidths
        .map((width) => `<col style="width:${Math.round(width)}px" />`)
        .join("")}</colgroup>`;
      const sheetCols = Array.from(
        { length: columnCount },
        (_, index) =>
          `<span>${sheetColumnName(index)}<span class="mn-sheet-col-grip" data-col-resize="${index}" title="Drag to resize column ${sheetColumnName(
            index
          )}"></span></span>`
      ).join("");
      const sheetRows = Array.from(
        { length: rows.length },
        (_, index) => `<span>${index + 1}</span>`
      ).join("");
      return `<div class="mn-table">
        <table style="width:${totalWidth}px">${colgroup}<tbody>${body}</tbody></table>
      </div>
      <div class="mn-sheet-headers" aria-hidden="true">
        <div class="mn-sheet-cols-clip">
          <div class="mn-sheet-cols" style="width:${totalWidth}px; grid-template-columns:${gridTemplate}">${sheetCols}</div>
        </div>
        <div class="mn-sheet-rows-clip">
          <div class="mn-sheet-rows">${sheetRows}</div>
        </div>
      </div>
      <span class="mn-sheet-add-column" data-sheet-add-column="1" title="Drag right to add columns"></span>
      <span class="mn-sheet-add-row" data-sheet-add-row="1" title="Drag down to add rows"></span>
      <div class="mn-table-tools">
        <button class="mn-table-add" type="button" data-action="table-add-toggle" aria-label="Add row or column" title="Add row or column">${icon(
          "plus",
          14
        )}</button>
        <div class="mn-table-menu" data-role="table-menu" hidden>
          <button type="button" data-action="table-add-row">${icon("plus", 12)}<span>Add row</span></button>
          <button type="button" data-action="table-add-column">${icon("plus", 12)}<span>Add column</span></button>
        </div>
      </div>
    `;
    }

    case "color": {
      const rgb = hexToRgb(card.color) || { r: 0, g: 0, b: 0 };
      const cmyk = rgbToCmyk(rgb);
      const hexValue = card.color.toUpperCase();
      const rgbValue = `${rgb.r}, ${rgb.g}, ${rgb.b}`;
      const cmykValue = `${cmyk.c}%, ${cmyk.m}%, ${cmyk.y}%, ${cmyk.k}%`;
      const codeRow = (label, value, title) => `<div class="mn-color-code-row">
          <span class="mn-color-code-label">${label}</span>
          <span class="mn-color-code-value">${escapeHtml(value)}</span>
          <button type="button" class="mn-color-copy" data-action="copy-color" data-copy="${escapeHtml(
            value
          )}" title="Copy ${title}" aria-label="Copy ${title}">${icon("copy", 12)}</button>
        </div>`;
      return `<div class="mn-color">
        <button class="mn-color-swatch" data-action="pick-color" style="background:${escapeHtml(
          card.color
        )}" title="Change colour"></button>
        <div class="mn-color-meta">
          <div class="mn-color-codes">
            ${codeRow("HEX", hexValue, "HEX")}
            ${codeRow("RGB", rgbValue, "RGB")}
            ${codeRow("CMYK", cmykValue, "CMYK")}
          </div>
          <input class="mn-field-input mn-color-name" data-field="name" value="${escapeHtml(
            card.name
          )}" spellcheck="false" />
        </div>
      </div>`;
    }

    case "drawing":
      return `<svg class="mn-drawing" viewBox="0 0 ${card.w} ${card.h}" preserveAspectRatio="none" aria-hidden="true"><path d="${drawingPath(
        card
      )}" fill="none" stroke="currentColor" stroke-width="${Number(card.strokeWidth) || 3}" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;

    case "sketch":
      return `<div class="mn-sketch">
        <canvas data-role="sketch-canvas"></canvas>
        <div class="mn-sketch-hint" data-role="sketch-hint">${icon("sketch", 20)}<span>Double click to start drawing</span></div>
      </div>`;

    case "image": {
      if (!card.src) {
        return `<div class="mn-image-empty" data-action="add-image">
          ${icon("image", 22)}<span>Add image</span>
        </div>`;
      }
      return `<div class="mn-image">
        <img src="${escapeHtml(imgSrc(card.src))}" alt="" draggable="false" />
        <input class="mn-field-input mn-image-caption" data-field="caption" value="${escapeHtml(
          card.caption
        )}" placeholder="Caption" />
      </div>`;
    }

    case "audio": {
      if (card.url && !card.__editEmbed) {
        return `<div class="mn-audio">
          <span class="mn-audio-glyph">${icon("audio", 18)}</span>
          <button type="button" class="mn-audio-control mn-audio-play" data-action="audio-toggle" title="Play or pause">
            <span class="mn-audio-play-icon">${icon("play", 14)}</span>
            <span class="mn-audio-pause-icon">${icon("pause", 14)}</span>
          </button>
          <span class="mn-audio-time">0:00 / 0:00</span>
          <input type="range" class="mn-audio-seek" data-audio-seek min="0" max="1000" value="0" aria-label="Seek audio" />
          <button type="button" class="mn-audio-control mn-audio-mute" data-action="audio-mute" title="Mute or unmute">
            <span class="mn-audio-volume-icon">${icon("volume", 14)}</span>
            <span class="mn-audio-muted-icon">${icon("volumeOff", 14)}</span>
          </button>
          <button type="button" class="mn-embed-edit mn-audio-edit" data-action="edit-embed" title="Change audio link">${icon(
            "edit",
            12
          )}</button>
          <audio preload="metadata" src="${escapeHtml(imgSrc(card.url))}"></audio>
        </div>`;
      }
      return `<div class="mn-placeholder mn-audio-empty mn-embed-empty">${icon("audio", 22)}<span>Upload an audio file or paste a link</span><input class="mn-field-input" data-field="url" value="${escapeHtml(
        card.url || ""
      )}" placeholder="https://audio..." /><button class="mn-primary-soft" data-action="upload-audio">Upload</button></div>`;
    }

    case "video": {
      if (card.url && !card.__editEmbed) {
        const embed = embedUrl(card.url);
        const media = embed
          ? `<iframe src="${escapeHtml(embed)}" allowfullscreen allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe>`
          : `<video controls src="${escapeHtml(imgSrc(card.url))}"></video>`;
        return `<div class="mn-video">${media}<button type="button" class="mn-embed-edit" data-action="edit-embed" title="Change video link">${icon(
          "edit",
          12
        )}</button></div>`;
      }
      return `<div class="mn-placeholder mn-embed-empty">${icon("video", 22)}<span>Paste a link from YouTube or Vimeo</span><input class="mn-field-input" data-field="url" value="${escapeHtml(
        card.url || ""
      )}" placeholder="https://" /><button type="button" class="mn-primary-soft" data-action="submit-embed">Submit</button></div>`;
    }

    case "map": {
      const embed = card.query ? mapEmbedUrl(card.query) : null;
      if (embed && !card.__editEmbed) {
        return `<div class="mn-map"><iframe src="${escapeHtml(
          embed
        )}" loading="lazy" allowfullscreen referrerpolicy="no-referrer-when-downgrade"></iframe><button type="button" class="mn-embed-edit" data-action="edit-embed" title="Change map location">${icon(
          "edit",
          12
        )}</button></div>`;
      }
      return `<div class="mn-placeholder mn-embed-empty">${icon("map", 22)}<span>Paste a link from Google Maps</span><input class="mn-field-input" data-field="query" value="${escapeHtml(
        card.query || ""
      )}" placeholder="https://maps.google.com/..." /><button type="button" class="mn-primary-soft" data-action="submit-embed">Load map</button></div>`;
    }

    case "file":
      return `<div class="mn-file" data-action="open-file" role="button" tabindex="0" title="Open with the default app">${icon(
        "file",
        18
      )}<div class="mn-file-body"><span class="mn-file-name">${escapeHtml(
        card.name || "File"
      )}</span></div><button type="button" class="mn-file-download" data-action="download-file" title="Download asset" aria-label="Download asset">${icon(
        "download",
        15
      )}</button></div>`;

    case "board": {
      const linked = card.boardId
        ? state.boards.find((entry) => entry.id === card.boardId)
        : null;
      return `<div class="mn-board-card" data-action="open-board" title="Open board">
        <div class="mn-board-preview" data-role="board-preview"></div>
        <div class="mn-board-meta">
          <span class="mn-board-meta-icon">${icon("board", 14)}</span>
          <span class="mn-board-card-title">${escapeHtml(linked?.title || card.title || "Board")}</span>
          <span class="mn-board-count" data-role="board-count"></span>
        </div>
      </div>`;
    }

    case "column": {
      const summary = columnSummary(state.board, card);
      const collapsed = Boolean(card.collapsed);
      return `<div class="mn-column-head">
        <span class="mn-column-title" data-field="title" data-placeholder="Column">${escapeHtml(
          card.title || "Column"
        )}</span>
        <span class="mn-column-summary">${summary}</span>
        <button class="mn-column-toggle" type="button" data-action="toggle-column" title="${
          collapsed ? "Expand column" : "Collapse column"
        }" aria-expanded="${collapsed ? "false" : "true"}">${icon(collapsed ? "expand" : "minus", 12)}</button>
      </div>`;
    }

    case "kanban": {
      const columns = (card.columns || [])
        .map(
          (column) => `<div class="mn-kanban-col" data-kanban-column="${column.id}">
            <div class="mn-kanban-col-head">
              <input class="mn-kanban-col-title" data-kanban-col-title="${column.id}" value="${escapeHtml(
            column.title || ""
          )}" spellcheck="false" />
              <button class="mn-kanban-col-remove" type="button" data-action="kanban-remove-column" data-kanban-col="${
                column.id
              }" title="Delete column">${icon("close", 10)}</button>
            </div>
            <div class="mn-kanban-items">
              ${(column.items || [])
                .map(
                  (item) => `<div class="mn-kanban-item" data-kanban-item-row="${item.id}" data-kanban-col-id="${
                    column.id
                  }">
                    <span class="mn-kanban-grip" data-kanban-grip="${item.id}" data-kanban-item-row="${
                    item.id
                  }" data-kanban-col-id="${column.id}" title="Drag card">${icon("grip", 11)}</span>
                    <input class="mn-kanban-item-input" draggable="false" data-kanban-item="${item.id}" data-kanban-col-id="${
                    column.id
                  }" value="${escapeHtml(item.text || "")}" placeholder="Card" spellcheck="false" />
                    <button class="mn-kanban-item-remove" type="button" data-action="kanban-remove-item" data-kanban-col="${
                      column.id
                    }" data-kanban-item="${item.id}" title="Delete card">${icon("close", 10)}</button>
                  </div>`
                )
                .join("")}
              <button class="mn-kanban-add-item" type="button" data-action="kanban-add-item" data-kanban-col="${
                column.id
              }">${icon("plus", 11)} Add card</button>
            </div>
          </div>`
        )
        .join("");
      return `<div class="mn-kanban">
        <div class="mn-kanban-head">
          <input class="mn-kanban-title" data-field="title" value="${escapeHtml(card.title || "Kanban")}" spellcheck="false" />
          <button class="mn-kanban-add-col" type="button" data-action="kanban-add-column">${icon(
            "plus",
            12
          )} Add column</button>
        </div>
        <div class="mn-kanban-cols">${
          columns || `<div class="mn-kanban-empty">No columns yet.</div>`
        }</div>
      </div>`;
    }

    default:
      return `<div class="mn-placeholder">${escapeHtml(card.type)}</div>`;
  }
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function mapEmbedUrl(query) {
  const text = String(query || "").trim();
  if (!text) return null;
  let location = text;
  const coords = text.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (coords) {
    location = `${coords[1]},${coords[2]}`;
  } else {
    try {
      const url = new URL(text);
      location = url.searchParams.get("q") || url.searchParams.get("ll") || text;
    } catch {
      /* treat as a place name */
    }
  }
  return `https://maps.google.com/maps?q=${encodeURIComponent(location)}&z=14&output=embed`;
}

function embedUrl(url) {
  try {
    const u = new URL(url);
    if (/youtube\.com$|youtu\.be$/.test(u.hostname)) {
      if (u.hostname === "youtu.be") {
        const id = u.pathname.slice(1).split("/")[0];
        return id ? `https://www.youtube.com/embed/${id}` : null;
      }
      if (u.pathname.startsWith("/shorts/")) {
        const id = u.pathname.split("/")[2];
        return id ? `https://www.youtube.com/embed/${id}` : null;
      }
      const id = u.searchParams.get("v");
      return id ? `https://www.youtube.com/embed/${id}` : null;
    }
    if (/vimeo\.com$/.test(u.hostname)) {
      const id = u.pathname.split("/").filter(Boolean)[0];
      return id ? `https://player.vimeo.com/video/${id}` : null;
    }
  } catch {
    /* not a url */
  }
  return null;
}

function initials(name) {
  return name
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase())
    .join("")
    .slice(0, 2);
}

// ------------------------------------------------------------------ build

export function zIndexFor(card) {
  // Integer z-index only: CSS ignores fractional values, which used to hide column children.
  if (card.parentId) {
    const column = getCard(state.board, card.parentId);
    if (column) return (column.z || 1) * 1000 + 1 + Math.min(999, card.order || 0);
  }
  return (card.z || 1) * 1000;
}

function applyGeometry(el, card) {
  el.style.left = `${card.x}px`;
  el.style.top = `${card.y}px`;
  el.style.width = `${card.w}px`;
  if (card.parentId) {
    const parent = getCard(state.board, card.parentId);
    el.style.display = parent?.collapsed ? "none" : "";
  }
  if (card.type === "column") {
    el.style.height = `${card.h}px`;
  } else if (CARD_ASPECTS[card.type] || card.aspect) {
    card.h = cardHeightFor(card);
    el.style.height = `${card.h}px`;
  } else {
    el.style.height = "";
  }
  el.style.zIndex = String(zIndexFor(card));
}

function drawingPath(card) {
  const points = card.points || [];
  if (!points.length) return "";
  return points
    .map((point, index) => `${index ? "L" : "M"}${Number(point.x).toFixed(2)} ${Number(point.y).toFixed(2)}`)
    .join(" ");
}

function hexToRgb(hex) {
  const value = String(hex || "").replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function rgbToCmyk({ r, g, b }) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const k = 1 - Math.max(red, green, blue);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 };
  return {
    c: Math.round(((1 - red - k) / (1 - k)) * 100),
    m: Math.round(((1 - green - k) / (1 - k)) * 100),
    y: Math.round(((1 - blue - k) / (1 - k)) * 100),
    k: Math.round(k * 100),
  };
}

export function refreshColorPreview(card) {
  if (!card || card.type !== "color") return;
  const el = cardElement(card.id);
  if (!el) return;
  const rgb = hexToRgb(card.color) || { r: 0, g: 0, b: 0 };
  const cmyk = rgbToCmyk(rgb);
  const values = [
    card.color.toUpperCase(),
    `${rgb.r}, ${rgb.g}, ${rgb.b}`,
    `${cmyk.c}%, ${cmyk.m}%, ${cmyk.y}%, ${cmyk.k}%`,
  ];
  el.querySelectorAll(".mn-color-code-value").forEach((node, index) => {
    if (values[index]) node.textContent = values[index];
  });
  el.querySelectorAll(".mn-color-copy").forEach((button, index) => {
    if (!values[index]) return;
    button.dataset.copy = values[index];
    button.title = `Copy ${["HEX", "RGB", "CMYK"][index]}`;
  });
  const swatch = el.querySelector(".mn-color-swatch");
  if (swatch) swatch.style.background = card.color;
  const name = el.querySelector(".mn-color-name");
  if (name) name.value = card.name || "";
}

function measureHeights() {
  const zoom = state.view.zoom || 1;
  for (const card of state.board.cards) {
    if (card.type === "column") continue;
    if (CARD_ASPECTS[card.type] || card.aspect) {
      card.h = cardHeightFor(card);
      continue;
    }
    const el = cardElement(card.id);
    if (!el) continue;
    // offsetHeight/getBoundingClientRect reflect the CSS zoom, so normalise back to world pixels.
    const height = el.getBoundingClientRect().height / zoom;
    if (height > 0) {
      const minimum = card.type === "audio" ? AUDIO_CARD_H : MIN_CARD_H;
      card.h = Math.max(minimum, Math.round(height));
    }
  }
}

function applyAllGeometry() {
  for (const card of state.board.cards) {
    const el = cardElement(card.id);
    if (el) applyGeometry(el, card);
  }
}

export function buildCard(card) {
  const el = document.createElement("div");
  el.className = `mn-card mn-card-${card.type}${card.parentId ? " is-child" : ""}${
    card.type === "column" && card.collapsed ? " is-collapsed" : ""
  }${card.locked ? " is-locked" : ""}`;
  el.dataset.id = card.id;
  el.dataset.type = card.type;
  applyGeometry(el, card);
  el.innerHTML =
    contentFor(card) +
    (card.locked
      ? `<span class="mn-lock-badge" title="Position locked">${icon("lock", 12)}</span>`
      : "") +
    `<div class="mn-resize" data-role="resize" title="Resize"></div>`;
  if (card.type === "sketch") paintSketch(el, card);
  return el;
}

export function refreshCard(id, focus) {
  const card = getCard(state.board, id);
  const old = cardElement(id);
  if (!card || !old) return;
  const el = buildCard(card);
  if (state.selection.has(id)) el.classList.add("is-selected");
  old.replaceWith(el);
  renderConnections();
  if (focus) {
    const target = el.querySelector(focus);
    if (target) {
      if (target.isContentEditable) setEditable(target, true);
      target.focus();
    }
  }
}

export function setEditable(el, editable) {
  if (!el) return;
  el.contentEditable = editable ? "true" : "false";
  if (editable) {
    el.classList.add("is-editing");
  } else {
    el.classList.remove("is-editing");
  }
}

// ------------------------------------------------------------------ paint

export function render(kind = "board") {
  if (!state.board) return;
  if (kind === "board" || !cardsEl.children.length) {
    rebuildCards();
  }
  measureHeights();
  layoutColumns(state.board);
  applyAllGeometry();
  renderSelection();
  renderConnections();
  if (kind === "view" || kind === "board") renderView();
  for (const card of state.board.cards) {
    if (card.type === "sketch") paintSketch(cardElement(card.id), card);
  }
  hydrateBoardCards();
  // Board-card previews and webfonts can settle after the first measure. Run one more geometry
  // pass on the next frame so column children never keep a stale slot until the user drags them.
  requestAnimationFrame(() => {
    if (!state.board || !cardsEl.children.length) return;
    measureHeights();
    layoutColumns(state.board);
    applyAllGeometry();
    renderConnections();
  });
}

async function hydrateBoardCards() {
  if (!state.board) return;
  let painted = false;
  let titleChanged = false;
  for (const card of state.board.cards) {
    if (card.type !== "board" || !card.boardId) continue;
    const el = cardElement(card.id);
    const slot = el?.querySelector('[data-role="board-preview"]');
    if (!slot) continue;
    const meta = state.boards.find((entry) => entry.id === card.boardId);
    const stamp = `${card.boardId}:${meta?.updatedAt ?? 0}`;
    if (slot.dataset.preview === stamp) continue;
    let doc = null;
    const cached = boardPreviewCache.get(card.boardId);
    if (cached && cached.stamp === stamp) doc = cached.doc;
    if (!doc) {
      try {
        const raw = await bridge.loadBoard(card.boardId);
        if (raw) doc = JSON.parse(raw);
      } catch {
        doc = null;
      }
      if (doc) boardPreviewCache.set(card.boardId, { stamp, doc });
    }
    if (!slot.isConnected) continue;
    slot.dataset.preview = stamp;
    paintBoardPreview(slot, doc, { maxScale: 0.12 });
    const titleEl = el.querySelector(".mn-board-card-title");
    const linkedTitle = meta?.title || doc?.title;
    if (titleEl && linkedTitle) titleEl.textContent = linkedTitle;
    if (linkedTitle && card.title !== linkedTitle) {
      card.title = linkedTitle;
      titleChanged = true;
    }
    painted = true;
    const count = el.querySelector('[data-role="board-count"]');
    if (count) {
      const total = doc?.cards?.length || 0;
      count.textContent = total ? `${total} card${total === 1 ? "" : "s"}` : "Empty";
    }
  }
  if (painted && state.board) {
    measureHeights();
    layoutColumns(state.board);
    applyAllGeometry();
    renderConnections();
  }
  if (titleChanged) markDirty("save");
}

// Re-measure one card after its content changed (inline text editing) and grow it in place.
export function syncCardHeight(card) {
  if (!state.board || !card || card.type === "column") return;
  const el = cardElement(card.id);
  if (!el) return;
  if (CARD_ASPECTS[card.type] || card.aspect) {
    card.h = cardHeightFor(card);
  } else {
    const height = el.getBoundingClientRect().height / (state.view.zoom || 1);
    if (height > 0) {
      const minimum = card.type === "audio" ? AUDIO_CARD_H : MIN_CARD_H;
      card.h = Math.max(minimum, Math.round(height));
    }
  }
  applyGeometry(el, card);
  if (card.parentId) {
    layoutColumns(state.board);
    applyAllGeometry();
    renderConnections();
  }
}

function rebuildCards() {
  cardsEl.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (const card of state.board.cards) fragment.append(buildCard(card));
  cardsEl.append(fragment);
  for (const card of state.board.cards) {
    if (!card.headerImage) continue;
    const image = cardElement(card.id)?.querySelector(".mn-link-header img");
    if (!image) continue;
    const resize = () => {
      syncCardHeight(card);
      markDirty("save");
    };
    if (image.complete) resize();
    else image.addEventListener("load", resize, { once: true });
  }
}

export function renderView() {
  if (!worldEl) return;
  // Scale with the CSS `zoom` property instead of a transform: Chromium re-lays out text at the
  // zoomed size, so cards and text stay sharp at high zoom instead of being raster-scaled.
  const zoom = state.view.zoom;
  const panX = state.view.x / zoom;
  const panY = state.view.y / zoom;
  worldEl.style.zoom = String(zoom);
  worldEl.style.transform = `translate(${panX}px, ${panY}px)`;
  if (Math.abs(zoom - lastPaintZoom) > 0.001) {
    lastPaintZoom = zoom;
    clearTimeout(sketchRepaintTimer);
    sketchRepaintTimer = window.setTimeout(() => {
      for (const card of state.board?.cards || []) {
        if (card.type === "sketch") paintSketch(cardElement(card.id), card);
      }
    }, 140);
  }
  if (viewportEl) {
    viewportEl.style.backgroundColor = state.board?.view?.background || "";
    const showGrid = !state.board || state.board.showGrid !== false;
    viewportEl.style.backgroundImage = showGrid ? "" : "none";
    if (showGrid) {
      const grid = (state.board && state.board.grid) || 24;
      const size = grid * zoom;
      viewportEl.style.backgroundSize = `${size}px ${size}px`;
      viewportEl.style.backgroundPosition = `${state.view.x}px ${state.view.y}px`;
    }
  }
}

export function renderSelection() {
  if (!cardsEl) return;
  for (const el of cardsEl.children) {
    el.classList.toggle("is-selected", state.selection.has(el.dataset.id));
  }
  document.documentElement.classList.toggle("has-selection", state.selection.size > 0);
}

function cardCenter(card) {
  return { x: card.x + card.w / 2, y: card.y + card.h / 2 };
}

function edgePoint(card, toward) {
  const center = cardCenter(card);
  let dx = toward.x - center.x;
  let dy = toward.y - center.y;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) dx = 1;
  const halfW = Math.max(0.001, card.w / 2);
  const halfH = Math.max(0.001, card.h / 2);
  const scaleX = Math.abs(dx) > 0.001 ? halfW / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const scaleY = Math.abs(dy) > 0.001 ? halfH / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const scale = Math.min(scaleX, scaleY);
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

export function connectionGeometry(connection) {
  const fromCard = connection.from ? getCard(state.board, connection.from) : null;
  const toCard = connection.to ? getCard(state.board, connection.to) : null;
  const fromFree = connection.fromPoint;
  const toFree = connection.toPoint;
  let start;
  let end;
  if (fromCard && toCard) {
    const startToward = connection.curve || cardCenter(toCard);
    const endToward = connection.curve || cardCenter(fromCard);
    start = edgePoint(fromCard, startToward);
    end = edgePoint(toCard, endToward);
  } else if (fromCard && toFree) {
    start = edgePoint(fromCard, connection.curve || toFree);
    end = toFree;
  } else if (toCard && fromFree) {
    start = fromFree;
    end = edgePoint(toCard, connection.curve || fromFree);
  } else {
    start = fromFree || { x: 0, y: 0 };
    end = toFree || { x: 0, y: 0 };
  }
  const control = connection.curve || null;
  const mid = control
    ? { x: (start.x + 2 * control.x + end.x) / 4, y: (start.y + 2 * control.y + end.y) / 4 }
    : { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  return { start, end, control, mid };
}

export function renderConnections() {
  if (!connEl || !state.board) return;
  connEl.innerHTML = "";
  connEl.setAttribute("viewBox", "-100000 -100000 200000 200000");
  connEl.setAttribute("preserveAspectRatio", "none");
  const defs = document.createElementNS(svgNs, "defs");
  defs.innerHTML = `<marker id="mn-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="currentColor"/></marker>`;
  connEl.append(defs);
  const connections = state.board.connections || [];
  const hitPaths = [];
  const lines = [];
  const handles = [];
  for (const connection of connections) {
    const geometry = connectionGeometry(connection);
    const { start, end, control } = geometry;
    const d = control
      ? `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`
      : `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
    const selected = state.connectionSelection === connection.id;
    if (!connection.draft) {
      const hit = document.createElementNS(svgNs, "path");
      hit.setAttribute("d", d);
      hit.setAttribute("class", "mn-connection-hit");
      hit.setAttribute("data-connection", connection.id);
      hitPaths.push(hit);
    }
    const path = document.createElementNS(svgNs, "path");
    path.setAttribute("d", d);
    path.setAttribute("class", `mn-connection${selected ? " is-selected" : ""}${connection.draft ? " is-draft" : ""}`);
    path.setAttribute("marker-end", "url(#mn-arrow)");
    lines.push(path);
    if (!connection.draft && selected) {
      for (const [endName, point] of [
        ["from", start],
        ["to", end],
      ]) {
        const handle = document.createElementNS(svgNs, "circle");
        handle.setAttribute("cx", point.x);
        handle.setAttribute("cy", point.y);
        handle.setAttribute("r", 4.2);
        handle.setAttribute("class", "mn-line-handle");
        handle.setAttribute("data-connection", connection.id);
        handle.setAttribute("data-line-end", endName);
        handles.push(handle);
      }
      const mid = document.createElementNS(svgNs, "circle");
      mid.setAttribute("cx", geometry.mid.x);
      mid.setAttribute("cy", geometry.mid.y);
      mid.setAttribute("r", 4.2);
      mid.setAttribute("class", "mn-line-handle mn-line-mid");
      mid.setAttribute("data-connection", connection.id);
      mid.setAttribute("data-line-mid", "1");
      handles.push(mid);
    }
  }
  connEl.append(...hitPaths, ...lines, ...handles);
}

// Sketch strokes are stored in normalized coordinates; width scales with the card so a wide card
// keeps the original stroke weight ratio.
export function paintSketch(el, card) {
  if (!el || !card) return;
  const canvas = el.querySelector('[data-role="sketch-canvas"]');
  if (!canvas) return;
  const rect = el.getBoundingClientRect();
  const zoom = state.view.zoom || 1;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round((rect.width / zoom) * dpr));
  const height = Math.max(1, Math.round((rect.height / zoom) * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cssWidth = width / dpr;
  const cssHeight = height / dpr;
  const ink =
    getComputedStyle(el).getPropertyValue("--ky-text").trim() || "#111";
  const accent =
    getComputedStyle(el).getPropertyValue("--ky-accent").trim() || "#e6b800";
  for (const stroke of card.strokes || []) {
    const isHighlight = stroke.tool === "highlighter";
    ctx.strokeStyle = stroke.color || (isHighlight ? accent : ink);
    ctx.globalAlpha = typeof stroke.a === "number" ? stroke.a : isHighlight ? 0.35 : 1;
    ctx.lineWidth = Math.max(1, (stroke.w || 0.01) * cssWidth);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    stroke.points.forEach((point, index) => {
      const x = point.x * cssWidth;
      const y = point.y * cssHeight;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const hint = el.querySelector('[data-role="sketch-hint"]');
  if (hint) hint.hidden = (card.strokes || []).length > 0;
}

export const SWATCH_LIST = SWATCHES;
