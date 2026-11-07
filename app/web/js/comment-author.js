// Format comment authors from the local profile when one is available. Accounts are optional.

import { authState } from "./auth.js";

export function displayNameFor(user) {
  if (!user) return "You";
  const composed = `${user.firstName || ""} ${user.lastName || ""}`.trim();
  return user.displayName || composed || user.username || "You";
}

export function initialsFor(name) {
  const value = String(name || "You").trim();
  return value ? value.charAt(0).toUpperCase() : "?";
}

export function currentCommentAuthor() {
  const user = authState().user;
  const name = displayNameFor(user);
  return {
    name,
    initials: initialsFor(name),
    avatarUrl: user?.avatarUrl || "",
    avatarColor: user?.avatarColor || "",
  };
}

export function commentAuthor(message) {
  const user = authState().user;
  const isCurrent = Boolean(user) && (!message?.authorId || message.authorId === user.id);
  if (isCurrent) return currentCommentAuthor();
  const name = message?.authorName || message?.author || "You";
  return {
    name,
    initials: initialsFor(name),
    avatarUrl: message?.avatarUrl || "",
    avatarColor: message?.avatarColor || "",
  };
}
