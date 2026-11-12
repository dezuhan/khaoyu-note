const token = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
const statusEl = document.getElementById("status");
const contentEl = document.getElementById("content");
const unlockEl = document.getElementById("unlock");

function setStatus(message) {
  statusEl.textContent = message;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function appendText(parent, tag, text, className = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

function renderComments(card, parent) {
  const comments = Array.isArray(card.shareComments) ? card.shareComments : [];
  if (!comments.length) return;
  const box = document.createElement("div");
  box.className = "comments";
  for (const comment of comments) {
    appendText(box, "div", `${comment.author || "Guest"}: ${comment.text}`);
  }
  parent.append(box);
}

function cardText(card) {
  return String(card.text || card.description || card.caption || "");
}

function appendCardContent(article, card) {
  if (card.type === "heading") {
    appendText(article, "h2", card.text || card.title || "Heading", "share-heading");
    return;
  }
  if (card.type === "note" || card.type === "document") {
    if (card.title) appendText(article, "strong", card.title);
    appendText(article, "p", cardText(card));
  } else if (card.type === "todo") {
    if (card.title) appendText(article, "strong", card.title);
    if (Array.isArray(card.items)) {
      const list = document.createElement("ul");
      for (const item of card.items) {
        const text = typeof item === "string" ? item : item.text || "";
        const checked = (typeof item === "object" && (item.done || item.checked)) ? "☑ " : "☐ ";
        appendText(list, "li", checked + text);
      }
      article.append(list);
    }
  } else if (card.type === "table") {
    if (Array.isArray(card.cells)) {
      const table = document.createElement("table");
      for (const row of card.cells) {
        const tr = table.insertRow();
        for (const cell of row) tr.insertCell().textContent = String(cell ?? "");
      }
      article.append(table);
    }
  } else if (card.type === "link") {
    appendText(article, "strong", card.title || card.url || "Link");
    const href = safeUrl(card.url);
    if (href) {
      const link = appendText(article, "a", href);
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer nofollow";
    }
  } else if (card.type === "board") {
    appendText(article, "strong", card.title || "Board");
    appendText(article, "span", "Nested board", "share-card-meta");
  } else if (card.type === "color") {
    appendText(article, "strong", card.title || card.color || "Colour");
  } else if (card.type === "sketch" || card.type === "drawing") {
    appendText(article, "strong", card.title || "Sketch");
    appendText(article, "span", "Drawing preview unavailable", "share-card-meta");
  } else if (card.url) {
    appendText(article, "strong", card.title || "Media");
    const href = safeUrl(card.url);
    if (href) {
      const link = appendText(article, "a", href);
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer nofollow";
    }
  } else {
    appendText(article, "strong", card.title || card.type || "Card");
    if (cardText(card)) appendText(article, "p", cardText(card));
  }
  if (Array.isArray(card.messages)) {
    for (const message of card.messages) {
      appendText(article, "p", `${message.author || "Guest"}: ${message.text || ""}`, "muted");
    }
  }
  renderComments(card, article);
}

function renderCard(card) {
  const article = document.createElement("article");
  article.className = `card share-card share-card-${String(card.type || "card").replace(/[^a-z0-9_-]/gi, "")}`;
  if (card.type === "color" && /^#[0-9a-f]{6}$/i.test(String(card.color || ""))) {
    article.style.setProperty("--share-card-color", card.color);
  }
  appendCardContent(article, card);
  return article;
}

function renderBoard(cards) {
  const canvas = document.createElement("div");
  canvas.className = "share-board";
  if (!cards.length) {
    appendText(canvas, "p", "This shared view is empty.", "muted");
    return canvas;
  }
  const minX = Math.min(...cards.map((card) => Number(card.x) || 0));
  const minY = Math.min(...cards.map((card) => Number(card.y) || 0));
  const maxX = Math.max(...cards.map((card) => (Number(card.x) || 0) + (Number(card.w) || 220)));
  const maxY = Math.max(...cards.map((card) => (Number(card.y) || 0) + (Number(card.h) || 90)));
  const padding = 32;
  const width = Math.max(620, maxX - minX + padding * 2);
  const height = Math.max(420, maxY - minY + padding * 2);
  const viewport = document.createElement("div");
  viewport.className = "share-board-viewport";
  const inner = document.createElement("div");
  inner.className = "share-board-canvas";
  inner.style.width = `${width}px`;
  inner.style.height = `${height}px`;
  const available = Math.min(1080, Math.max(320, window.innerWidth - 100));
  const scale = Math.min(1, available / width);
  inner.style.transform = `scale(${scale})`;
  viewport.style.height = `${Math.round(height * scale)}px`;
  const ordered = [...cards].sort((a, b) => Number(a.z || 0) - Number(b.z || 0));
  for (const card of ordered) {
    const element = renderCard(card);
    element.style.left = `${(Number(card.x) || 0) - minX + padding}px`;
    element.style.top = `${(Number(card.y) || 0) - minY + padding}px`;
    element.style.width = `${Math.max(80, Number(card.w) || 220)}px`;
    element.style.height = `${Math.max(40, Number(card.h) || 90)}px`;
    element.style.zIndex = String(Number(card.z) || 1);
    inner.append(element);
  }
  viewport.append(inner);
  canvas.append(viewport);
  return canvas;
}

function renderCollection(cards) {
  const fragment = document.createDocumentFragment();
  fragment.append(renderBoard(cards));
  return fragment;
}

function render(data) {
  document.getElementById("permission").textContent = data.permission || "view";
  contentEl.textContent = "";
  if (data.scope === "item") {
    document.getElementById("title").textContent = "Shared card";
    contentEl.append(renderCollection([data.card]));
  } else if (data.scope === "column") {
    document.getElementById("title").textContent = "Shared column";
    if (data.notice) appendText(contentEl, "p", data.notice, "muted");
    contentEl.append(renderCollection(data.cards || []));
  } else {
    document.getElementById("title").textContent = data.project?.name || "Shared project";
    contentEl.append(renderCollection(data.doc?.cards || []));
    for (const nested of data.nestedProjects || []) {
      appendText(contentEl, "h2", nested.name || "Nested board");
      contentEl.append(renderCollection(nested.doc?.cards || []));
    }
    if (data.excludedNestedProjects) {
      appendText(
        contentEl,
        "p",
        `${data.excludedNestedProjects} nested board(s) are not included by the sharing policy.`,
        "muted"
      );
    }
  }
  if (data.expiresAt) {
    appendText(contentEl, "p", `This link expires ${new Date(data.expiresAt).toLocaleString()}.`, "muted");
  }
  appendText(contentEl, "p", "Shared read-only view. Do not forward this link to people who should not have access.", "muted");
  if (data.scope !== "item") void showRegistrationLink();
  if (data.watermark) {
    const watermark = document.createElement("div");
    watermark.className = "share-watermark";
    watermark.setAttribute("aria-hidden", "true");
    const label = data.project?.name || "Khaoyu Note · shared link";
    for (let index = 0; index < 8; index += 1) {
      const span = document.createElement("span");
      span.textContent = label;
      watermark.append(span);
    }
    document.body.append(watermark);
  }
  unlockEl.hidden = true;
}

async function showRegistrationLink() {
  try {
    const response = await fetch("/api/v1/auth/features", { credentials: "same-origin" });
    if (!response.ok) return;
    const features = await response.json();
    if (features.registrationMode !== "public") return;
    const line = document.createElement("p");
    line.className = "muted";
    line.append("New here? ");
    const link = document.createElement("a");
    link.href = "/register";
    link.textContent = "Create an account";
    line.append(link);
    contentEl.append(line);
  } catch {
    /* the register link is optional */
  }
}

async function openShare() {
  const passphrase = document.getElementById("passphrase").value;
  setStatus("Opening...");
  let response;
  try {
    response = await fetch(`/api/v1/share/${encodeURIComponent(token)}/access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(passphrase ? { password: passphrase } : {}),
    });
  } catch {
    setStatus("Network error. Try again.");
    return;
  }
  if (response.status === 429) {
    setStatus("Too many attempts. Wait a few minutes and try again.");
    return;
  }
  if (!response.ok) {
    setStatus("Link is invalid, expired, revoked, or the passphrase is incorrect.");
    return;
  }
  const data = await response.json();
  setStatus("");
  render(data);
}

document.getElementById("open").addEventListener("click", openShare);
document.getElementById("passphrase").addEventListener("keydown", (event) => {
  if (event.key === "Enter") openShare();
});
openShare();
