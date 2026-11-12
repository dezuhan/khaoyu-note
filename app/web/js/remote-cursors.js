// Draw remote editing carets and a narrow selection overlay without mutating editable DOM.

function fieldFor(cardId, fieldName) {
  const card = document.querySelector(`.mn-card[data-id="${CSS.escape(cardId)}"]`);
  if (!card) return null;
  const field =
    (fieldName && card.querySelector(`[data-field="${CSS.escape(fieldName)}"]`)) ||
    card.querySelector('[contenteditable="true"], textarea, input');
  return field ? { card, field } : null;
}

function textOffsetRange(field, offset) {
  const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, Number(offset) || 0);
  let node = walker.nextNode();
  while (node) {
    if (remaining <= node.data.length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.setEnd(node, remaining);
      return range;
    }
    remaining -= node.data.length;
    node = walker.nextNode();
  }
  const range = document.createRange();
  range.selectNodeContents(field);
  range.collapse(false);
  return range;
}

function colorFor(accountId) {
  let hash = 0;
  for (const char of String(accountId || "")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue} 72% 52%)`;
}

export function renderRemoteCursors(users = [], ownConnectionId = null) {
  document.querySelectorAll(".mn-remote-caret, .mn-remote-selection").forEach((node) => node.remove());
  for (const user of users) {
    const cursor = user.cursor;
    if (!cursor || !cursor.cardId || user.connectionId === ownConnectionId) continue;
    const target = fieldFor(cursor.cardId, cursor.field);
    if (!target) continue;
    const range = textOffsetRange(target.field, cursor.offset);
    const rects = [...range.getClientRects()];
    const caretRect = rects.at(-1);
    const cardRect = target.card.getBoundingClientRect();
    if (!caretRect) continue;
    const caret = document.createElement("span");
    caret.className = "mn-remote-caret";
    caret.style.setProperty("--remote-color", colorFor(user.accountId));
    caret.style.left = `${caretRect.left - cardRect.left}px`;
    caret.style.top = `${caretRect.top - cardRect.top}px`;
    caret.style.height = `${Math.max(16, caretRect.height)}px`;
    const label = document.createElement("span");
    label.textContent = user.name || "Guest";
    caret.append(label);
    target.card.append(caret);
    if (cursor.length > 0) {
      const selection = document.createRange();
      selection.setStart(range.startContainer, range.startOffset);
      const endRange = textOffsetRange(target.field, cursor.offset + cursor.length);
      selection.setEnd(endRange.startContainer, endRange.startOffset);
      for (const rect of selection.getClientRects()) {
        const mark = document.createElement("span");
        mark.className = "mn-remote-selection";
        mark.style.setProperty("--remote-color", colorFor(user.accountId));
        mark.style.left = `${rect.left - cardRect.left}px`;
        mark.style.top = `${rect.top - cardRect.top}px`;
        mark.style.width = `${rect.width}px`;
        mark.style.height = `${rect.height}px`;
        target.card.append(mark);
      }
    }
  }
}

export function clearRemoteCursors() {
  document.querySelectorAll(".mn-remote-caret, .mn-remote-selection").forEach((node) => node.remove());
}
