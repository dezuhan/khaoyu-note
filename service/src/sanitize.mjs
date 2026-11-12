// Server-side allowlist sanitizer for rich text stored in shared board documents. The browser also
// sanitizes before rendering, but public JSON must never carry executable markup to API consumers.
const ALLOWED_TAGS = new Set([
  "P", "DIV", "BR", "B", "STRONG", "I", "EM", "U", "S", "STRIKE",
  "UL", "OL", "LI", "H1", "H2", "H3", "BLOCKQUOTE", "PRE", "CODE", "A", "SPAN", "HR",
]);
const VOID_TAGS = new Set(["BR", "HR"]);
const SAFE_URL = /^(?:https?:\/\/|mailto:)/i;

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function safeHref(attributes) {
  const match = attributes.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  const value = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
  if (!value || !SAFE_URL.test(value)) return null;
  if (/[\u0000-\u001f]/.test(value)) return null;
  return value;
}

function escapeText(value) {
  return String(value).replace(/</g, "&lt;");
}

export function sanitizeRichHtml(input) {
  if (input === null || input === undefined) return "";
  const source = String(input).replace(/<!--[\s\S]*?-->/g, "");
  let output = "";
  let last = 0;
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
  for (const match of source.matchAll(tag)) {
    output += escapeText(source.slice(last, match.index));
    last = match.index + match[0].length;
    const closing = match[1] === "/";
    const name = match[2].toUpperCase();
    if (!ALLOWED_TAGS.has(name)) continue;
    if (VOID_TAGS.has(name)) {
      if (!closing) output += `<${name.toLowerCase()}>`;
      continue;
    }
    if (closing) {
      output += `</${name.toLowerCase()}>`;
      continue;
    }
    if (name === "A") {
      const href = safeHref(match[3]);
      output += href
        ? `<a href="${escapeAttribute(href)}" rel="noopener noreferrer nofollow">`
        : "<a rel=\"noopener noreferrer nofollow\">";
      continue;
    }
    output += `<${name.toLowerCase()}>`;
  }
  output += escapeText(source.slice(last));
  return output;
}

export function sanitizeRichFields(card) {
  if (!card || typeof card !== "object") return card;
  const copy = { ...card };
  for (const key of ["html", "markdown"]) {
    if (typeof copy[key] === "string" && copy[key]) copy[key] = sanitizeRichHtml(copy[key]);
  }
  return copy;
}
