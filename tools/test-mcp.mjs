// Smoke test for the MCP server: spawns khaoyu-note-mcp against a temporary database
// and exercises the tools over newline-delimited JSON-RPC on stdio.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binaryName = process.platform === "win32" ? "khaoyu-note-mcp.exe" : "khaoyu-note-mcp";
const candidates = [
  process.argv[2],
  path.join(root, "app", "src-tauri", "target", "debug", binaryName),
  path.join(root, "app", "src-tauri", "target", "release", binaryName),
  path.join(root, "dist", binaryName),
]
  .filter(Boolean)
  .map((entry) => path.resolve(entry));
const exe = candidates.find((entry) => fs.existsSync(entry));
if (!exe) {
  console.error("Could not find the MCP binary. Pass it as the first argument or build it first.");
  console.error("Looked in:\n" + candidates.join("\n"));
  process.exit(1);
}
console.log("using " + exe);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mn-mcp-"));

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? "  ::  " + String(detail).slice(0, 120) : ""}`);
}

const proc = spawn(exe, [], {
  env: { ...process.env, KHAOYU_NOTE_DB_DIR: dataDir },
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
const pending = new Map();
let seq = 0;
const stderr = [];
proc.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

proc.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    } catch (error) {
      console.log("unparsed line", line);
    }
  }
});

function request(method, params = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function tool(name, args = {}) {
  const response = await request("tools/call", { name, arguments: args });
  const result = response.result;
  if (!result || !Array.isArray(result.content)) {
    throw new Error("malformed tool response: " + JSON.stringify(response));
  }
  const text = result.content[0]?.text ?? "";
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}

try {
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-smoke-test", version: "1.0.0" },
  });
  check("initialize returns server info", init.result?.serverInfo?.name === "khaoyu-note", JSON.stringify(init.result?.serverInfo));
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await request("tools/list", {});
  const names = (list.result?.tools || []).map((entry) => entry.name);
  check("tools/list exposes the board tools", ["create_board", "create_card", "get_board", "search", "list_comments"].every((name) => names.includes(name)), names.join(", "));

  const board = await tool("create_board", { title: "MCP test project" });
  check("create_board returns an id", typeof board.board_id === "string" && board.board_id.startsWith("b_"), board.board_id);

  const note = await tool("create_card", {
    board_id: board.board_id,
    type: "note",
    x: 120,
    y: 140,
    text: "Hello from MCP",
  });
  check("create_card returns a note", note.card?.type === "note", note.card?.id);

  const boardView = await tool("get_board", { board_id: board.board_id });
  check("get_board shows the new card", boardView.cards?.length === 1 && boardView.cards[0].summary.includes("Hello from MCP"));

  const updated = await tool("update_card", {
    board_id: board.board_id,
    card_id: note.card.id,
    fields: { text: "Updated by MCP" },
  });
  check("update_card merges fields", updated.card?.text === "Updated by MCP");

  const commentCard = await tool("create_card", { board_id: board.board_id, type: "comment", x: 400, y: 140 });
  await tool("add_comment", { board_id: board.board_id, card_id: commentCard.card.id, text: "Looks good", author: "MCP" });
  const comments = await tool("list_comments", { board_id: board.board_id });
  check("list_comments returns the message", comments.comments?.length === 1 && comments.comments[0].text === "Looks good", JSON.stringify(comments.comments?.[0]));

  const search = await tool("search", { query: "Updated" });
  check("search finds card text", (search.results || []).some((result) => result.cardId === note.card.id), JSON.stringify(search.results?.[0]));

  const unicodeNote = await tool("create_card", {
    board_id: board.board_id,
    type: "note",
    text: "Résumé project 日本語",
  });
  const unicodeSearch = await tool("search", { query: "résumé" });
  const unicodeHit = (unicodeSearch.results || []).find((result) => result.cardId === unicodeNote.card.id);
  check(
    "search keeps unicode snippets readable",
    Boolean(unicodeHit) &&
      unicodeHit.snippet.toLowerCase().includes("résumé") &&
      !unicodeHit.snippet.includes("â"),
    unicodeHit?.snippet
  );

  const forced = await tool("create_card", {
    board_id: board.board_id,
    type: "note",
    text: "Fields must not replace the id or type",
    fields: { id: "forced_id", type: "injected" },
  });
  check(
    "create_card ignores id and type overrides",
    forced.card?.id !== "forced_id" && forced.card?.type === "note",
    `${forced.card?.id} / ${forced.card?.type}`
  );

  const nested = await tool("create_board", { title: "Nested board", parent_id: board.board_id });
  const boards = await tool("list_boards", {});
  const nestedRow = boards.boards.find((row) => row.id === nested.board_id);
  check("nested board keeps its parent", nestedRow?.parentId === board.board_id && nestedRow?.nestedBoards === 0, JSON.stringify(nestedRow));

  const todo = await tool("create_card", {
    board_id: board.board_id,
    type: "todo",
    items: ["One", "Two"],
  });
  check("create_card maps todo items", todo.card?.items?.length === 2 && todo.card.items[0].text === "One");

  const kanban = await tool("create_card", {
    board_id: board.board_id,
    type: "kanban",
  });
  check(
    "create_card supports kanban columns",
    kanban.card?.columns?.length === 3 && kanban.card.columns[0].title === "Backlog"
  );

  const connected = await tool("connect_cards", {
    board_id: board.board_id,
    from_card_id: note.card.id,
    to_card_id: commentCard.card.id,
  });
  check("connect_cards adds a connection", Boolean(connected.connection?.id));

  await tool("delete_board", { board_id: board.board_id });
  const afterDelete = await tool("list_boards", {});
  check("delete_board removes the board tree", !afterDelete.boards.some((row) => row.id === board.board_id || row.id === nested.board_id));

  const failed = await request("tools/call", { name: "get_board", arguments: { board_id: board.board_id } });
  check("missing board reports a tool error", failed.result?.isError === true);
} catch (error) {
  check("no unexpected errors", false, error.message);
} finally {
  proc.kill();
}

const failedChecks = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failedChecks.length}/${results.length} checks passed`);
if (stderr.length) console.log("server stderr:", stderr.join("").slice(0, 500));
process.exit(failedChecks.length ? 1 : 0);

