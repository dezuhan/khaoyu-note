// Full page document editor with a formatting toolbar and export.

import { icon } from "./icons.js";
import { getCard } from "./model.js";
import { sanitizeHtml } from "./render.js";
import { markDirty, state } from "./store.js";

let overlayEl = null;
let cleanup = null;

const TOOL_BUTTONS = [
  { cmd: "style", label: "Text style", icon: "heading" },
  { cmd: "insert", label: "Insert", icon: "plus" },
  { type: "sep" },
  { cmd: "bold", label: "Bold", text: "B" },
  { cmd: "italic", label: "Italic", text: "I", italic: true },
  { cmd: "strikeThrough", label: "Strikethrough", text: "S", strike: true },
  { cmd: "underline", label: "Underline", text: "U", underline: true },
  { type: "sep" },
  { cmd: "insertUnorderedList", label: "Bullet list", icon: "listBullet" },
  { cmd: "insertOrderedList", label: "Numbered list", icon: "listOrdered" },
  { cmd: "outdent", label: "Outdent", icon: "outdent" },
  { cmd: "indent", label: "Indent", icon: "indent" },
  { type: "sep" },
  { cmd: "justifyLeft", label: "Align left", icon: "alignLeft" },
  { cmd: "justifyCenter", label: "Align center", icon: "alignCenter" },
  { cmd: "justifyRight", label: "Align right", icon: "alignRight" },
  { type: "sep" },
  { cmd: "code", label: "Code block", text: "</>" },
  { cmd: "link", label: "Link", icon: "link" },
  { cmd: "comment", label: "Comment", icon: "comment" },
];

export function openDocumentEditor(cardId) {
  const card = getCard(state.board, cardId);
  if (!card || card.type !== "document") return;
  closeDocumentEditor();

  const overlay = document.createElement("div");
  overlay.className = "mn-doc-overlay";
  overlay.innerHTML = `
    <div class="mn-doc-sheet">
      <header class="mn-doc-top">
        <span class="mn-doc-heading">Document</span>
        <div class="mn-doc-top-actions">
          <button type="button" class="mn-doc-export" data-role="export">Export</button>
          <button type="button" class="mn-doc-close" data-role="close" title="Close">${icon("close", 14)}</button>
        </div>
      </header>
      <div class="mn-doc-body">
        <div class="mn-doc-tools" data-role="tools"></div>
        <div class="mn-doc-page-wrap">
          <div class="mn-doc-page" contenteditable="true" spellcheck="false" data-placeholder="Start typing..."></div>
        </div>
      </div>
    </div>`;
  document.body.append(overlay);
  overlayEl = overlay;

  const pageEl = overlay.querySelector(".mn-doc-page");
  pageEl.innerHTML = sanitizeHtml(card.html || escapeToHtml(card.text || ""));
  const tools = overlay.querySelector('[data-role="tools"]');

  for (const entry of TOOL_BUTTONS) {
    if (entry.type === "sep") {
      const sep = document.createElement("span");
      sep.className = "mn-doc-tool-sep";
      tools.append(sep);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mn-doc-tool";
    button.title = entry.label;
    if (entry.icon) button.innerHTML = icon(entry.icon, 15);
    else button.textContent = entry.text;
    if (entry.italic) button.style.fontStyle = "italic";
    if (entry.strike) button.style.textDecoration = "line-through";
    if (entry.underline) button.style.textDecoration = "underline";
    if (entry.cmd === "justifyLeft") button.style.textAlign = "left";
    if (entry.cmd === "justifyCenter") button.style.textAlign = "center";
    if (entry.cmd === "justifyRight") button.style.textAlign = "right";
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => runCommand(entry.cmd, overlay, pageEl, button));
    tools.append(button);
  }

  const commit = () => {
    const html = sanitizeHtml(pageEl.innerHTML).trim();
    card.html = html;
    card.text = pageEl.innerText || "";
    markDirty("board");
  };

  let timer = 0;
  const onInput = () => {
    clearTimeout(timer);
    timer = window.setTimeout(commit, 500);
  };
  pageEl.addEventListener("input", onInput);

  overlay.querySelector('[data-role="close"]').addEventListener("click", () => {
    commit();
    closeDocumentEditor();
  });
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) {
      commit();
      closeDocumentEditor();
    }
  });
  overlay.querySelector('[data-role="export"]').addEventListener("click", (event) => {
    event.stopPropagation();
    openExportMenu(overlay, pageEl);
  });

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      commit();
      closeDocumentEditor();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      commit();
    }
  };
  window.addEventListener("keydown", onKeyDown, true);

  cleanup = () => {
    clearTimeout(timer);
    window.removeEventListener("keydown", onKeyDown, true);
  };
  pageEl.focus();
}

export function closeDocumentEditor() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  if (overlayEl) {
    overlayEl.remove();
    overlayEl = null;
  }
}

export function documentEditorOpen() {
  return Boolean(overlayEl);
}

function escapeToHtml(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function runCommand(cmd, overlay, pageEl, anchorButton) {
  pageEl.focus();
  if (cmd === "style") {
    openMenu(overlay, [
      { label: "Paragraph", run: () => formatBlock(pageEl, "p") },
      { label: "Heading 1", run: () => formatBlock(pageEl, "h1") },
      { label: "Heading 2", run: () => formatBlock(pageEl, "h2") },
      { label: "Heading 3", run: () => formatBlock(pageEl, "h3") },
      { label: "Quote", run: () => formatBlock(pageEl, "blockquote") },
      { label: "Code block", run: () => formatBlock(pageEl, "pre") },
    ], anchorButton);
    return;
  }
  if (cmd === "insert") {
    openMenu(overlay, [
      { label: "Divider", run: () => document.execCommand("insertHorizontalRule") },
      { label: "Link", run: () => insertLink(overlay, pageEl) },
      { label: "Checkbox line", run: () => document.execCommand("insertText", false, "☐ ") },
      { label: "Heading 1", run: () => formatBlock(pageEl, "h1") },
    ], anchorButton);
    return;
  }
  if (cmd === "code") {
    formatBlock(pageEl, "pre");
    return;
  }
  if (cmd === "link") {
    insertLink(overlay, pageEl);
    return;
  }
  if (cmd === "comment") {
    return;
  }
  document.execCommand(cmd, false);
}

function formatBlock(pageEl, tag) {
  pageEl.focus();
  document.execCommand("formatBlock", false, tag);
}

function insertLink(overlay, pageEl) {
  const wrap = document.createElement("div");
  wrap.className = "mn-doc-link-pop";
  wrap.innerHTML = `<input class="ky-input" placeholder="https://" /><button type="button" class="mn-btn mn-btn-primary">Add</button>`;
  const sheet = overlay.querySelector(".mn-doc-sheet");
  sheet.append(wrap);
  const input = wrap.querySelector("input");
  input.focus();
  const apply = () => {
    const url = (input.value || "").trim();
    wrap.remove();
    pageEl.focus();
    if (!url) return;
    const href = /^https?:\/\//i.test(url) ? url : "https://" + url;
    document.execCommand("createLink", false, href);
  };
  wrap.querySelector("button").addEventListener("click", apply);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      apply();
    }
    if (event.key === "Escape") wrap.remove();
  });
}

function openMenu(overlay, items, anchorButton) {
  overlay.querySelectorAll(".mn-doc-menu").forEach((el) => el.remove());
  const menu = document.createElement("div");
  menu.className = "mn-menu mn-doc-menu";
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mn-menu-item";
    button.textContent = item.label;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      menu.remove();
      item.run();
    });
    menu.append(button);
  }
  overlay.append(menu);
  const rect = menu.getBoundingClientRect();
  const anchor = anchorButton?.getBoundingClientRect();
  let left = anchor ? anchor.right + 8 : 52;
  let top = anchor ? anchor.top : Math.min(180, window.innerHeight - rect.height - 20);
  if (left + rect.width > window.innerWidth - 12) {
    left = anchor ? anchor.left - rect.width - 8 : window.innerWidth - rect.width - 12;
  }
  left = Math.max(12, left);
  top = Math.min(Math.max(12, top), window.innerHeight - rect.height - 12);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  const close = (event) => {
    if (!menu.contains(event.target)) {
      menu.remove();
      document.removeEventListener("pointerdown", close, true);
    }
  };
  document.addEventListener("pointerdown", close, true);
}

function openExportMenu(overlay, pageEl) {
  const options = [
    { label: "Markdown", kind: "md" },
    { label: "HTML", kind: "html" },
    { label: "Plain text", kind: "txt" },
  ];
  openMenu(
    overlay,
    options.map((option) => ({
      label: option.label,
      run: () => exportDocument(pageEl, option.kind),
    })),
    overlay.querySelector('[data-role="export"]')
  );
}

function exportDocument(pageEl, kind) {
  const html = pageEl.innerHTML;
  const text = pageEl.innerText;
  const payload =
    kind === "html" ? html : kind === "md" ? htmlToMarkdown(html) : text;
  const mime =
    kind === "html" ? "text/html" : kind === "md" ? "text/markdown" : "text/plain";
  const blob = new Blob([payload], { type: mime + ";charset=utf-8" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `document.${kind === "txt" ? "txt" : kind}`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(anchor.href), 2000);
}

function htmlToMarkdown(html) {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  return convert(holder).replace(/\n{3,}/g, "\n\n").trim();
}

function convert(node) {
  let out = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent.replace(/\s+/g, " ");
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName;
    const inner = convert(child);
    switch (tag) {
      case "H1":
        out += `\n# ${inner.trim()}\n\n`;
        break;
      case "H2":
        out += `\n## ${inner.trim()}\n\n`;
        break;
      case "H3":
        out += `\n### ${inner.trim()}\n\n`;
        break;
      case "P":
      case "DIV":
        out += `${inner.trim()}\n\n`;
        break;
      case "BR":
        out += "\n";
        break;
      case "STRONG":
      case "B":
        out += `**${inner.trim()}**`;
        break;
      case "EM":
      case "I":
        out += `*${inner.trim()}*`;
        break;
      case "S":
      case "STRIKE":
        out += `~~${inner.trim()}~~`;
        break;
      case "CODE":
        out += `\`${inner.trim()}\``;
        break;
      case "PRE":
        out += `\n\`\`\`\n${child.innerText}\n\`\`\`\n\n`;
        break;
      case "BLOCKQUOTE":
        out += inner
          .trim()
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n") + "\n\n";
        break;
      case "UL":
        out += convertList(child, false);
        break;
      case "OL":
        out += convertList(child, true);
        break;
      case "A":
        out += `[${inner.trim()}](${child.getAttribute("href") || ""})`;
        break;
      case "HR":
        out += "\n---\n\n";
        break;
      default:
        out += inner;
    }
  }
  return out;
}

function convertList(list, ordered) {
  let out = "\n";
  let index = 1;
  for (const item of list.children) {
    const text = convert(item).trim().replace(/\n+/g, " ");
    out += ordered ? `${index}. ${text}\n` : `- ${text}\n`;
    index += 1;
  }
  return out + "\n";
}
