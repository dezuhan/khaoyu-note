// Presence badge helpers for the top bar: who else is in this workspace right now.
// The service emits the presence roster over the sync SSE stream; this module only decides what to
// show. Three avatars fit next to the sync state; the rest collapse into a +N badge.

export const MAX_PRESENCE_AVATARS = 3;

export function colorFor(accountId) {
  // FNV-1a keeps sequential ids (and UUIDs) spread around the hue wheel.
  let hash = 2166136261;
  for (const char of String(accountId || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const hue = (hash >>> 0) % 360;
  return `hsl(${hue} 72% 52%)`;
}

// One entry per account, never the current account, capped to `limit` avatars. The returned `hidden`
// is the number of people that did not fit and is rendered as "+N".
export function summarizePresence(users = [], ownAccountId = "", limit = MAX_PRESENCE_AVATARS) {
  const seen = new Set();
  const people = [];
  for (const user of Array.isArray(users) ? users : []) {
    const accountId = String(user?.accountId || "");
    if (!accountId || seen.has(accountId)) continue;
    seen.add(accountId);
    if (ownAccountId && accountId === ownAccountId) continue;
    people.push({ accountId, name: String(user?.name || "").trim() });
  }
  people.sort((first, second) =>
    (first.name || "Guest").localeCompare(second.name || "Guest", undefined, { sensitivity: "base" })
  );
  const visible = people.slice(0, Math.max(0, limit));
  return {
    people,
    visible,
    total: people.length,
    hidden: Math.max(0, people.length - visible.length),
  };
}

export function renderPresenceBadges(container, users = [], ownAccountId = "") {
  if (!container) return summarizePresence([], ownAccountId);
  const summary = summarizePresence(users, ownAccountId);
  container.replaceChildren();
  if (!summary.total) {
    container.hidden = true;
    container.removeAttribute("title");
    return summary;
  }
  container.hidden = false;
  for (const person of summary.visible) {
    const badge = document.createElement("span");
    badge.className = "mn-presence-avatar";
    badge.textContent = (person.name || "Guest").charAt(0).toUpperCase() || "?";
    badge.style.setProperty("--presence-color", colorFor(person.accountId));
    badge.title = person.name || "Guest";
    badge.setAttribute("aria-label", person.name || "Guest");
    container.append(badge);
  }
  if (summary.hidden > 0) {
    const more = document.createElement("span");
    more.className = "mn-presence-more";
    more.textContent = `+${summary.hidden}`;
    more.title = `${summary.hidden} more ${
      summary.hidden === 1 ? "person" : "people"
    } in this workspace`;
    container.append(more);
  }
  container.title = `${summary.total} other ${summary.total === 1 ? "person" : "people"} in this workspace`;
  return summary;
}
