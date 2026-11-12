// Command palette: searchable command list with recently used commands.

import { icon } from "./icons.js";

let getCommands = () => [];
let overlay = null;
let input = null;
let list = null;
let activeIndex = 0;
let visible = [];

const RECENTS_KEY = "ky.commandRecents";
const MAX_RECENTS = 6;

export function initCommandPalette(provider) {
  getCommands = provider;
  window.addEventListener("keydown", (event) => {
    const isShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";
    if (!isShortcut) return;
    event.preventDefault();
    if (overlay) closePalette();
    else openCommandPalette();
  });
}

export function openCommandPalette(initialQuery = "") {
  if (overlay) return;
  overlay = document.createElement("div");
  overlay.className = "mn-palette-backdrop";
  overlay.innerHTML = `<div class="mn-palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <div class="mn-palette-search">
        <span class="mn-palette-search-icon">${icon("search", 15)}</span>
        <input class="mn-palette-input" placeholder="Search commands and tools" spellcheck="false" />
        <kbd>Esc</kbd>
      </div>
      <div class="mn-palette-list"></div>
      <footer class="mn-palette-foot">↑↓ to navigate · ↵ to run · esc to close</footer>
    </div>`;
  document.body.append(overlay);
  input = overlay.querySelector(".mn-palette-input");
  list = overlay.querySelector(".mn-palette-list");
  input.value = initialQuery;
  input.addEventListener("input", () => {
    activeIndex = 0;
    render();
  });
  input.addEventListener("keydown", onKeyDown);
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) closePalette();
  });
  document.addEventListener("keydown", onPaletteKey, true);
  render();
  input.focus();
  input.select();
}

export function closePalette() {
  if (!overlay) return;
  overlay.remove();
  overlay = null;
  input = null;
  list = null;
  visible = [];
  document.removeEventListener("keydown", onPaletteKey, true);
}

function onPaletteKey(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closePalette();
  }
}

function recents() {
  try {
    const value = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function remember(id) {
  const next = [id, ...recents().filter((entry) => entry !== id)].slice(0, MAX_RECENTS);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
}

function render() {
  if (!list) return;
  const query = input.value.trim().toLowerCase();
  const commands = getCommands();
  const byId = new Map(commands.map((command) => [command.id, command]));
  const recentCommands = query
    ? []
    : recents()
        .map((id) => byId.get(id))
        .filter(Boolean);
  const filtered = commands.filter((command) => {
    if (!query) return true;
    const haystack = `${command.label} ${command.group} ${command.keywords || ""}`.toLowerCase();
    return haystack.includes(query);
  });
  visible = [];
  list.innerHTML = "";
  if (recentCommands.length) {
    renderGroup("Recently used", recentCommands);
  }
  const groups = new Map();
  for (const command of filtered) {
    if (!groups.has(command.group)) groups.set(command.group, []);
    groups.get(command.group).push(command);
  }
  for (const [group, entries] of groups) {
    renderGroup(group, entries);
  }
  if (!visible.length) {
    list.innerHTML = `<div class="mn-palette-empty">No commands match.</div>`;
  }
  highlight();
}

function renderGroup(name, entries) {
  const heading = document.createElement("div");
  heading.className = "mn-palette-group";
  heading.textContent = name;
  list.append(heading);
  for (const command of entries) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mn-palette-item";
    button.dataset.command = command.id;
    button.innerHTML = `<span class="mn-palette-item-name">${icon(
      command.icon || "arrow",
      14
    )}<span>${command.label}</span></span>${
      command.shortcut ? `<span class="mn-palette-kbd">${command.shortcut}</span>` : ""
    }`;
    button.addEventListener("pointerenter", () => {
      activeIndex = visible.indexOf(command);
      highlight();
    });
    button.addEventListener("click", () => runCommand(command));
    list.append(button);
    visible.push(command);
  }
}

function onKeyDown(event) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    activeIndex = Math.min(visible.length - 1, activeIndex + 1);
    highlight();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    activeIndex = Math.max(0, activeIndex - 1);
    highlight();
  } else if (event.key === "Enter") {
    event.preventDefault();
    const command = visible[activeIndex];
    if (command) runCommand(command);
  }
}

function highlight() {
  const buttons = [...list.querySelectorAll(".mn-palette-item")];
  buttons.forEach((button, index) => button.classList.toggle("is-active", index === activeIndex));
  buttons[activeIndex]?.scrollIntoView({ block: "nearest" });
}

function runCommand(command) {
  remember(command.id);
  closePalette();
  try {
    const result = command.run?.();
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {
    /* command errors stay in the app toast path */
  }
}
