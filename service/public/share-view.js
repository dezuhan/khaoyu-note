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

function renderCard(card) {
  const article = document.createElement("article");
  article.className = "card";
  appendText(article, "h3", card.type || "card");
  if (card.title) appendText(article, "strong", card.title);
  if (card.text) appendText(article, "p", card.text);
  if (card.description) appendText(article, "p", card.description);
  if (card.caption) appendText(article, "p", card.caption, "muted");
  if (Array.isArray(card.items)) {
    const list = document.createElement("ul");
    for (const item of card.items) {
      const text = typeof item === "string" ? item : item.text || "";
      const checked = typeof item === "object" && item.checked ? "☑ " : "☐ ";
      appendText(list, "li", checked + text);
    }
    article.append(list);
  }
  if (Array.isArray(card.cells)) {
    const table = document.createElement("table");
    for (const row of card.cells) {
      const tr = table.insertRow();
      for (const cell of row) tr.insertCell().textContent = String(cell ?? "");
    }
    article.append(table);
  }
  if (card.url) {
    const href = safeUrl(card.url);
    if (href) {
      const link = appendText(article, "a", href);
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer nofollow";
    } else {
      appendText(article, "p", card.url, "muted");
    }
  }
  if (Array.isArray(card.messages)) {
    for (const message of card.messages) {
      appendText(article, "p", `${message.author || "Guest"}: ${message.text || ""}`, "muted");
    }
  }
  renderComments(card, article);
  return article;
}

function renderDoc(doc) {
  const cards = [...(doc?.cards || [])].sort((a, b) => Number(a.z || 0) - Number(b.z || 0));
  for (const card of cards) contentEl.append(renderCard(card));
  if (!cards.length) appendText(contentEl, "p", "This shared view is empty.", "muted");
}

function render(data) {
  document.getElementById("permission").textContent = data.permission || "view";
  contentEl.textContent = "";
  if (data.scope === "item") {
    document.getElementById("title").textContent = "Shared card";
    contentEl.append(renderCard(data.card));
  } else if (data.scope === "column") {
    document.getElementById("title").textContent = "Shared column";
    if (data.notice) appendText(contentEl, "p", data.notice, "muted");
    for (const card of data.cards || []) contentEl.append(renderCard(card));
  } else {
    document.getElementById("title").textContent = data.project?.name || "Shared project";
    renderDoc(data.doc);
    for (const nested of data.nestedProjects || []) {
      appendText(contentEl, "h2", nested.name || "Nested board");
      renderDoc(nested.doc);
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
  unlockEl.hidden = true;
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
