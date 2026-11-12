// MCP (Model Context Protocol) stdio server for Khaoyu Note.
//
// It shares the same SQLite database as the desktop app, so an agent can read and edit boards while
// the app is open (SQLite WAL allows concurrent readers/writers). Run it from any MCP client:
//
//   khaoyu-note-mcp.exe
//
// The database directory defaults to %APPDATA%\com.dezuhan.khaoyunote and can be overridden with
// the KHAOYU_NOTE_DB_DIR environment variable (used by the tests, and useful for portable setups).
//
// Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout; logs go to stderr only.

use khaoyu_note_lib::{
    delete_board_tree, list_board_meta, migrate_legacy_data_dir, open_db_at, read_doc, write_doc,
    write_doc_checked, DB_FILE,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const CARD_TYPES: [&str; 16] = [
    "note", "heading", "link", "todo", "document", "comment", "table", "color", "sketch", "image",
    "audio", "video", "map", "file", "board", "column",
];

fn main() {
    let root = data_root();
    if std::env::var("KHAOYU_NOTE_DB_DIR").is_err() {
        if let Err(error) = migrate_legacy_data_dir(&root) {
            eprintln!("khaoyu-note-mcp: cannot migrate the data folder: {error}");
            std::process::exit(1);
        }
    }
    let conn = match open_db_at(&root) {
        Ok(conn) => conn,
        Err(error) => {
            eprintln!(
                "khaoyu-note-mcp: cannot open database at {}: {error}",
                root.display()
            );
            std::process::exit(1);
        }
    };
    eprintln!("khaoyu-note-mcp: serving {}", root.join(DB_FILE).display());

    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let message: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                let response = json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": { "code": -32700, "message": format!("parse error: {error}") }
                });
                let _ = writeln!(stdout, "{response}");
                let _ = stdout.flush();
                continue;
            }
        };
        let id = message.get("id").cloned();
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if id.is_none() {
            // Notification (for example notifications/initialized): no response.
            continue;
        }
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        let response = match handle(&conn, &method, &params) {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(error) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32603, "message": error }
            }),
        };
        if writeln!(stdout, "{response}").is_err() {
            break;
        }
        let _ = stdout.flush();
    }
}

fn handle(conn: &Connection, method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "initialize" => Ok(initialize_result(params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_definitions() })),
        "tools/call" => call_tool(conn, params),
        "resources/list" => Ok(json!({ "resources": [] })),
        "prompts/list" => Ok(json!({ "prompts": [] })),
        "logging/setLevel" => Ok(json!({})),
        "shutdown" => Ok(json!({})),
        other => Err(format!("method not found: {other}")),
    }
}

fn initialize_result(params: &Value) -> Value {
    let requested = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or("");
    let supported = ["2024-11-05", "2025-03-26", "2025-06-18"];
    let version = if supported.contains(&requested) {
        requested
    } else {
        "2024-11-05"
    };
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "khaoyu-note", "version": env!("CARGO_PKG_VERSION") },
        "instructions": "Local-first Khaoyu Note boards in SQLite. Read tools: list_boards, get_board, get_board_json, get_card, search, list_comments. Write tools: create_board, update_board, delete_board, create_card, update_card, delete_card, add_comment, connect_cards. Boards form a tree through parentId; nested boards stay inside their project."
    })
}

fn call_tool(conn: &Connection, params: &Value) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or("missing tool name")?;
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    match dispatch(conn, name, &args) {
        Ok(value) => Ok(json!({
            "content": [{ "type": "text", "text": serde_json::to_string_pretty(&value).unwrap_or_default() }]
        })),
        Err(error) => Ok(json!({
            "content": [{ "type": "text", "text": error }],
            "isError": true
        })),
    }
}

fn dispatch(conn: &Connection, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "list_boards" => tool_list_boards(conn),
        "get_board" => tool_get_board(conn, args),
        "get_board_json" => tool_get_board_json(conn, args),
        "get_card" => tool_get_card(conn, args),
        "create_board" => tool_create_board(conn, args),
        "update_board" => tool_update_board(conn, args),
        "delete_board" => tool_delete_board(conn, args),
        "create_card" => tool_create_card(conn, args),
        "update_card" => tool_update_card(conn, args),
        "delete_card" => tool_delete_card(conn, args),
        "add_comment" => tool_add_comment(conn, args),
        "connect_cards" => tool_connect_cards(conn, args),
        "search" => tool_search(conn, args),
        "list_comments" => tool_list_comments(conn, args),
        other => Err(format!("unknown tool: {other}")),
    }
}

// ------------------------------------------------------------------ tools

fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "list_boards",
            "description": "List every board as a tree: id, title, parentId, updatedAt, card count, archivedAt and trashedAt. Root boards (parentId null) are the projects shown on the home screen.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "get_board",
            "description": "Read one board with card geometry, type and a short summary per card, plus connections.",
            "inputSchema": {
                "type": "object",
                "properties": { "board_id": { "type": "string" } },
                "required": ["board_id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "get_board_json",
            "description": "Return the raw board document JSON. Use it for backups or to inspect every card field.",
            "inputSchema": {
                "type": "object",
                "properties": { "board_id": { "type": "string" } },
                "required": ["board_id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "get_card",
            "description": "Return one card with all of its fields.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "board_id": { "type": "string" },
                    "card_id": { "type": "string" }
                },
                "required": ["board_id", "card_id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "create_board",
            "description": "Create a board. Omit parent_id for a new root project; pass parent_id to create a nested board inside a project.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "parent_id": { "type": "string" }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "update_board",
            "description": "Rename a board, change its grid settings, or archive/trash/restore it (archived/trashed set the timestamp; false clears it).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "board_id": { "type": "string" },
                    "title": { "type": "string" },
                    "grid": { "type": "integer" },
                    "show_grid": { "type": "boolean" },
                    "archived": { "type": "boolean" },
                    "trashed": { "type": "boolean" }
                },
                "required": ["board_id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "delete_board",
            "description": "Delete a board and every nested board inside it.",
            "inputSchema": {
                "type": "object",
                "properties": { "board_id": { "type": "string" } },
                "required": ["board_id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "create_card",
            "description": "Create a card on a board. Common fields can be passed directly (text, title, url, color, caption, query, target_board_id, items, messages) and any extra card fields via the fields object.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "board_id": { "type": "string" },
                    "type": { "type": "string", "enum": CARD_TYPES },
                    "x": { "type": "number" },
                    "y": { "type": "number" },
                    "width": { "type": "number" },
                    "height": { "type": "number" },
                    "parent_id": { "type": "string" },
                    "text": { "type": "string" },
                    "title": { "type": "string" },
                    "url": { "type": "string" },
                    "caption": { "type": "string" },
                    "color": { "type": "string" },
                    "query": { "type": "string" },
                    "target_board_id": { "type": "string" },
                    "items": { "type": "array", "items": { "type": "string" } },
                    "messages": { "type": "array", "items": { "type": "string" } },
                    "fields": { "type": "object" }
                },
                "required": ["board_id", "type"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "update_card",
            "description": "Merge fields into an existing card (for example text, title, x, y, w, h, color, items, messages, checked state).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "board_id": { "type": "string" },
                    "card_id": { "type": "string" },
                    "fields": { "type": "object" }
                },
                "required": ["board_id", "card_id", "fields"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "delete_card",
            "description": "Delete a card. If it is a column its children are removed too.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "board_id": { "type": "string" },
                    "card_id": { "type": "string" }
                },
                "required": ["board_id", "card_id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "add_comment",
            "description": "Append a message to a comment card.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "board_id": { "type": "string" },
                    "card_id": { "type": "string" },
                    "text": { "type": "string" },
                    "author": { "type": "string" }
                },
                "required": ["board_id", "card_id", "text"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "connect_cards",
            "description": "Draw a connection line between two cards on the same board.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "board_id": { "type": "string" },
                    "from_card_id": { "type": "string" },
                    "to_card_id": { "type": "string" }
                },
                "required": ["board_id", "from_card_id", "to_card_id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "search",
            "description": "Search board titles and card text. Returns matching boards and cards with a snippet.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "board_id": { "type": "string" },
                    "limit": { "type": "integer" }
                },
                "required": ["query"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "list_comments",
            "description": "List comments from a board and optionally from its nested boards.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "board_id": { "type": "string" },
                    "include_nested": { "type": "boolean" }
                },
                "required": ["board_id"],
                "additionalProperties": false
            }
        }),
    ]
}

fn tool_list_boards(conn: &Connection) -> Result<Value, String> {
    let metas = list_board_meta(conn)?;
    let nested_count = |id: &str| {
        metas
            .iter()
            .filter(|m| m.parent_id.as_deref() == Some(id))
            .count()
    };
    let cards: Vec<Value> = metas
        .iter()
        .map(|meta| {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM cards WHERE board_id = ?1",
                    rusqlite::params![meta.id],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            json!({
                "id": meta.id,
                "title": meta.title,
                "parentId": meta.parent_id,
                "updatedAt": meta.updated_at,
                "archivedAt": meta.archived_at,
                "trashedAt": meta.trashed_at,
                "cards": count,
                "nestedBoards": nested_count(&meta.id),
            })
        })
        .collect();
    Ok(json!({ "boards": cards }))
}

fn tool_get_board(conn: &Connection, args: &Value) -> Result<Value, String> {
    let board_id = required_str(args, "board_id")?;
    let doc = load_doc(conn, board_id)?;
    let cards: Vec<Value> = doc
        .get("cards")
        .and_then(Value::as_array)
        .map(|cards| {
            cards
                .iter()
                .map(|card| {
                    json!({
                        "id": card.get("id"),
                        "type": card.get("type"),
                        "x": card.get("x"),
                        "y": card.get("y"),
                        "w": card.get("w"),
                        "h": card.get("h"),
                        "parentId": card.get("parentId"),
                        "z": card.get("z"),
                        "summary": card_summary(card),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({
        "id": doc.get("id"),
        "title": doc.get("title"),
        "parentId": doc.get("parentId"),
        "updatedAt": doc.get("updatedAt"),
        "grid": doc.get("grid"),
        "showGrid": doc.get("showGrid"),
        "archivedAt": doc.get("archivedAt"),
        "trashedAt": doc.get("trashedAt"),
        "view": doc.get("view"),
        "cards": cards,
        "connections": doc.get("connections").cloned().unwrap_or_else(|| json!([])),
    }))
}

fn tool_get_board_json(conn: &Connection, args: &Value) -> Result<Value, String> {
    let board_id = required_str(args, "board_id")?;
    load_doc(conn, board_id)
}

fn tool_get_card(conn: &Connection, args: &Value) -> Result<Value, String> {
    let board_id = required_str(args, "board_id")?;
    let card_id = required_str(args, "card_id")?;
    let doc = load_doc(conn, board_id)?;
    find_card(&doc, card_id)
        .cloned()
        .ok_or_else(|| format!("card not found: {card_id}"))
}

fn tool_create_board(conn: &Connection, args: &Value) -> Result<Value, String> {
    let title = optional_str(args, "title").unwrap_or_else(|| "Untitled project".to_string());
    let parent = optional_str(args, "parent_id");
    if let Some(parent_id) = parent.as_deref() {
        let _parent_doc = load_doc(conn, parent_id)?;
    }
    let doc = json!({
        "id": board_id(),
        "title": title,
        "parentId": parent,
        "createdAt": now_ms(),
        "updatedAt": now_ms(),
        "view": { "x": 0, "y": 0, "zoom": 1 },
        "grid": 24,
        "showGrid": true,
        "cards": [],
        "connections": [],
    });
    write_doc(conn, &doc)?;
    let id = doc.get("id").cloned().unwrap_or_default();
    Ok(json!({
        "board_id": id,
        "title": doc.get("title"),
        "parentId": doc.get("parentId"),
    }))
}

fn tool_update_board(conn: &Connection, args: &Value) -> Result<Value, String> {
    let board_id = required_str(args, "board_id")?;
    let mut doc = load_doc(conn, board_id)?;
    let base_updated_at = doc.get("updatedAt").and_then(Value::as_i64);
    {
        let object = doc
            .as_object_mut()
            .ok_or("board document is not an object")?;
        if let Some(title) = args.get("title").and_then(Value::as_str) {
            object.insert("title".into(), json!(title));
        }
        if let Some(grid) = args.get("grid").and_then(Value::as_i64) {
            object.insert("grid".into(), json!(grid));
        }
        if let Some(show) = args.get("show_grid").and_then(Value::as_bool) {
            object.insert("showGrid".into(), json!(show));
        }
        if let Some(archived) = args.get("archived").and_then(Value::as_bool) {
            object.insert(
                "archivedAt".into(),
                if archived {
                    json!(now_ms())
                } else {
                    Value::Null
                },
            );
        }
        if let Some(trashed) = args.get("trashed").and_then(Value::as_bool) {
            object.insert(
                "trashedAt".into(),
                if trashed {
                    json!(now_ms())
                } else {
                    Value::Null
                },
            );
        }
        object.insert("updatedAt".into(), json!(now_ms()));
    }
    write_doc_checked(conn, &doc, base_updated_at)?;
    Ok(json!({ "board_id": board_id, "updated": true }))
}

fn tool_delete_board(conn: &Connection, args: &Value) -> Result<Value, String> {
    let board_id = required_str(args, "board_id")?;
    delete_board_tree(conn, board_id)?;
    Ok(json!({ "board_id": board_id, "deleted": true }))
}

fn tool_create_card(conn: &Connection, args: &Value) -> Result<Value, String> {
    let board_id = required_str(args, "board_id")?;
    let card_type = required_str(args, "type")?;
    if !CARD_TYPES.contains(&card_type) {
        return Err(format!("unsupported card type: {card_type}"));
    }
    let mut doc = load_doc(conn, board_id)?;
    let mut card = new_card(&doc, card_type, args)?;
    if let Some(fields) = args.get("fields").and_then(Value::as_object) {
        for (key, value) in fields {
            if key == "id" || key == "type" {
                continue;
            }
            card[key] = value.clone();
        }
    }
    let cards = doc
        .get_mut("cards")
        .and_then(Value::as_array_mut)
        .ok_or("board has no cards array")?;
    cards.push(card.clone());
    save_doc(conn, &mut doc)?;
    Ok(json!({ "board_id": board_id, "card": card }))
}

fn tool_update_card(conn: &Connection, args: &Value) -> Result<Value, String> {
    let board_id = required_str(args, "board_id")?;
    let card_id = required_str(args, "card_id")?;
    let fields = args
        .get("fields")
        .and_then(Value::as_object)
        .ok_or("fields object required")?;
    let mut doc = load_doc(conn, board_id)?;
    let card =
        find_card_mut(&mut doc, card_id).ok_or_else(|| format!("card not found: {card_id}"))?;
    for (key, value) in fields {
        if key == "id" || key == "type" {
            continue;
        }
        card[key] = value.clone();
    }
    let updated = card.clone();
    save_doc(conn, &mut doc)?;
    Ok(json!({ "board_id": board_id, "card": updated }))
}

fn tool_delete_card(conn: &Connection, args: &Value) -> Result<Value, String> {
    let board_id = required_str(args, "board_id")?;
    let card_id = required_str(args, "card_id")?;
    let mut doc = load_doc(conn, board_id)?;
    let mut remove: HashSet<String> = HashSet::new();
    remove.insert(card_id.to_string());
    {
        let cards = doc
            .get_mut("cards")
            .and_then(Value::as_array_mut)
            .ok_or("board has no cards array")?;
        loop {
            let mut added = false;
            for card in cards.iter() {
                let id = card.get("id").and_then(Value::as_str).unwrap_or("");
                let parent = card.get("parentId").and_then(Value::as_str).unwrap_or("");
                if !id.is_empty() && remove.contains(parent) && !remove.contains(id) {
                    remove.insert(id.to_string());
                    added = true;
                }
            }
            if !added {
                break;
            }
        }
        let before = cards.len();
        cards.retain(|card| {
            let id = card.get("id").and_then(Value::as_str).unwrap_or("");
            !remove.contains(id)
        });
        if cards.len() == before {
            return Err(format!("card not found: {card_id}"));
        }
    }
    if let Some(connections) = doc.get_mut("connections").and_then(Value::as_array_mut) {
        connections.retain(|connection| {
            let from = connection.get("from").and_then(Value::as_str).unwrap_or("");
            let to = connection.get("to").and_then(Value::as_str).unwrap_or("");
            !remove.contains(from) && !remove.contains(to)
        });
    }
    save_doc(conn, &mut doc)?;
    Ok(json!({ "board_id": board_id, "card_id": card_id, "deleted": true }))
}

fn tool_add_comment(conn: &Connection, args: &Value) -> Result<Value, String> {
    let board_id = required_str(args, "board_id")?;
    let card_id = required_str(args, "card_id")?;
    let text = required_str(args, "text")?;
    let author = optional_str(args, "author").unwrap_or_else(|| "You".to_string());
    let mut doc = load_doc(conn, board_id)?;
    let card =
        find_card_mut(&mut doc, card_id).ok_or_else(|| format!("card not found: {card_id}"))?;
    if card.get("type").and_then(Value::as_str) != Some("comment") {
        return Err("add_comment only works on comment cards".into());
    }
    let message = json!({
        "id": format!("m_{}", uuid::Uuid::new_v4().simple()),
        "author": author,
        "text": text,
        "done": false,
        "ts": now_ms(),
    });
    if !card.get("messages").map(Value::is_array).unwrap_or(false) {
        card["messages"] = json!([]);
    }
    if let Some(messages) = card.get_mut("messages").and_then(Value::as_array_mut) {
        messages.push(message.clone());
    }
    save_doc(conn, &mut doc)?;
    Ok(json!({ "board_id": board_id, "card_id": card_id, "message": message }))
}

fn tool_connect_cards(conn: &Connection, args: &Value) -> Result<Value, String> {
    let board_id = required_str(args, "board_id")?;
    let from = required_str(args, "from_card_id")?;
    let to = required_str(args, "to_card_id")?;
    let mut doc = load_doc(conn, board_id)?;
    if find_card(&doc, from).is_none() || find_card(&doc, to).is_none() {
        return Err("both cards must exist on the board".into());
    }
    let connection = json!({
        "id": format!("conn_{}", uuid::Uuid::new_v4().simple()),
        "from": from,
        "to": to,
    });
    if !doc.get("connections").map(Value::is_array).unwrap_or(false) {
        doc["connections"] = json!([]);
    }
    if let Some(connections) = doc.get_mut("connections").and_then(Value::as_array_mut) {
        connections.push(connection.clone());
    }
    save_doc(conn, &mut doc)?;
    Ok(json!({ "board_id": board_id, "connection": connection }))
}

fn tool_search(conn: &Connection, args: &Value) -> Result<Value, String> {
    let query = required_str(args, "query")?.to_lowercase();
    let board_filter = optional_str(args, "board_id");
    let limit = args
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(20)
        .clamp(1, 100) as usize;
    let metas = list_board_meta(conn)?;
    let mut results: Vec<Value> = Vec::new();
    for meta in &metas {
        if let Some(board_id) = board_filter.as_deref() {
            if meta.id != board_id {
                continue;
            }
        }
        if results.len() >= limit {
            break;
        }
        let doc = match load_doc(conn, &meta.id) {
            Ok(doc) => doc,
            Err(_) => continue,
        };
        if meta.title.to_lowercase().contains(&query) {
            results.push(json!({
                "kind": "board",
                "boardId": meta.id,
                "boardTitle": meta.title,
                "snippet": meta.title,
            }));
        }
        if let Some(cards) = doc.get("cards").and_then(Value::as_array) {
            for card in cards {
                if results.len() >= limit {
                    break;
                }
                for text in card_texts(card) {
                    if text.to_lowercase().contains(&query) {
                        results.push(json!({
                            "kind": "card",
                            "boardId": meta.id,
                            "boardTitle": meta.title,
                            "cardId": card.get("id"),
                            "type": card.get("type"),
                            "snippet": snippet(&text, &query),
                        }));
                        break;
                    }
                }
            }
        }
    }
    Ok(json!({ "query": query, "results": results }))
}

fn tool_list_comments(conn: &Connection, args: &Value) -> Result<Value, String> {
    let board_id = required_str(args, "board_id")?;
    let include_nested = args
        .get("include_nested")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let metas = list_board_meta(conn)?;
    let mut board_ids = vec![board_id.to_string()];
    if include_nested {
        let mut index = 0;
        while index < board_ids.len() {
            let current = board_ids[index].clone();
            for meta in &metas {
                if meta.parent_id.as_deref() == Some(current.as_str())
                    && !board_ids.contains(&meta.id)
                {
                    board_ids.push(meta.id.clone());
                }
            }
            index += 1;
        }
    }
    let mut comments: Vec<Value> = Vec::new();
    for id in &board_ids {
        let meta = metas.iter().find(|meta| &meta.id == id);
        let doc = match load_doc(conn, id) {
            Ok(doc) => doc,
            Err(_) => continue,
        };
        if let Some(cards) = doc.get("cards").and_then(Value::as_array) {
            for card in cards {
                if card.get("type").and_then(Value::as_str) != Some("comment") {
                    continue;
                }
                if let Some(messages) = card.get("messages").and_then(Value::as_array) {
                    for message in messages {
                        comments.push(json!({
                            "boardId": id,
                            "boardTitle": meta.map(|meta| meta.title.clone()).unwrap_or_default(),
                            "cardId": card.get("id"),
                            "author": message.get("author").cloned().unwrap_or_else(|| json!("You")),
                            "text": message.get("text"),
                            "ts": message.get("ts"),
                        }));
                    }
                }
            }
        }
    }
    comments.sort_by_key(|comment| -(comment.get("ts").and_then(Value::as_i64).unwrap_or(0)));
    Ok(json!({ "boardId": board_id, "comments": comments }))
}

// ------------------------------------------------------------------ helpers

fn data_root() -> PathBuf {
    if let Ok(dir) = std::env::var("KHAOYU_NOTE_DB_DIR") {
        return PathBuf::from(dir);
    }
    // Match the platform app-data directory Tauri uses for the desktop app, so the MCP server opens
    // the same database on every OS (the previous Windows-only APPDATA lookup fell back to
    // ./com.dezuhan.khaoyunote on Linux and macOS).
    if cfg!(target_os = "windows") {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("com.dezuhan.khaoyunote");
        }
    }
    if cfg!(target_os = "macos") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join("Library/Application Support/com.dezuhan.khaoyunote");
        }
    }
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("com.dezuhan.khaoyunote");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".local/share/com.dezuhan.khaoyunote");
    }
    PathBuf::from(".").join("com.dezuhan.khaoyunote")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn board_id() -> String {
    format!("b_{}", uuid::Uuid::new_v4().simple())
}

fn required_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing required string parameter: {key}"))
}

fn optional_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(|value| value.to_string())
}

fn load_doc(conn: &Connection, board_id: &str) -> Result<Value, String> {
    match read_doc(conn, board_id)? {
        Some(raw) => {
            serde_json::from_str(&raw).map_err(|error| format!("invalid board JSON: {error}"))
        }
        None => Err(format!("board not found: {board_id}")),
    }
}

fn save_doc(conn: &Connection, doc: &mut Value) -> Result<(), String> {
    let base_updated_at = doc.get("updatedAt").and_then(Value::as_i64);
    if let Some(object) = doc.as_object_mut() {
        object.insert("updatedAt".into(), json!(now_ms()));
    }
    write_doc_checked(conn, &*doc, base_updated_at).map(|_| ())
}

fn find_card<'a>(doc: &'a Value, card_id: &str) -> Option<&'a Value> {
    doc.get("cards")
        .and_then(Value::as_array)
        .and_then(|cards| {
            cards
                .iter()
                .find(|card| card.get("id").and_then(Value::as_str) == Some(card_id))
        })
}

fn find_card_mut<'a>(doc: &'a mut Value, card_id: &str) -> Option<&'a mut Value> {
    doc.get_mut("cards")
        .and_then(Value::as_array_mut)
        .and_then(|cards| {
            cards
                .iter_mut()
                .find(|card| card.get("id").and_then(Value::as_str) == Some(card_id))
        })
}

fn card_size(card_type: &str) -> (f64, f64) {
    match card_type {
        "note" => (260.0, 70.0),
        "heading" => (300.0, 70.0),
        "link" => (260.0, 70.0),
        "todo" => (260.0, 70.0),
        "document" => (260.0, 70.0),
        "comment" => (280.0, 70.0),
        "table" => (340.0, 70.0),
        "color" => (260.0, 224.0),
        "sketch" => (260.0, 190.0),
        "image" => (260.0, 210.0),
        "audio" => (280.0, 70.0),
        "video" => (300.0, 190.0),
        "map" => (280.0, 170.0),
        "file" => (260.0, 70.0),
        "board" => (260.0, 70.0),
        "column" => (280.0, 220.0),
        _ => (260.0, 70.0),
    }
}

fn card_defaults(card_type: &str) -> Value {
    match card_type {
        "note" => json!({ "text": "" }),
        "heading" => json!({ "text": "Heading" }),
        "link" => json!({ "url": "", "title": "" }),
        "todo" => json!({ "title": "", "items": [] }),
        "document" => json!({ "title": "Document", "text": "" }),
        "comment" => json!({ "messages": [] }),
        "table" => json!({ "cells": [["", "", ""], ["", "", ""], ["", "", ""]] }),
        "color" => json!({ "color": "#B262C0", "name": "Amethyst" }),
        "sketch" => json!({ "strokes": [] }),
        "image" => json!({ "src": "", "caption": "" }),
        "audio" => json!({ "url": "", "name": "" }),
        "video" => json!({ "url": "" }),
        "map" => json!({ "query": "" }),
        "file" => json!({ "name": "", "path": "" }),
        "board" => json!({ "boardId": "", "title": "Board" }),
        "column" => json!({ "title": "Column" }),
        _ => json!({}),
    }
}

fn new_card(doc: &Value, card_type: &str, args: &Value) -> Result<Value, String> {
    let (default_w, default_h) = card_size(card_type);
    let cards = doc.get("cards").and_then(Value::as_array);
    let count = cards.map(|cards| cards.len()).unwrap_or(0);
    let offset = (count % 8) as f64 * 24.0;
    let x = args
        .get("x")
        .and_then(Value::as_f64)
        .unwrap_or(80.0 + offset);
    let y = args
        .get("y")
        .and_then(Value::as_f64)
        .unwrap_or(120.0 + offset);
    let w = args
        .get("width")
        .and_then(Value::as_f64)
        .unwrap_or(default_w);
    let h = args
        .get("height")
        .and_then(Value::as_f64)
        .unwrap_or(default_h);
    let parent = optional_str(args, "parent_id");
    let order = parent
        .as_deref()
        .map(|parent_id| {
            cards
                .map(|cards| {
                    cards
                        .iter()
                        .filter(|card| {
                            card.get("parentId").and_then(Value::as_str) == Some(parent_id)
                        })
                        .count()
                })
                .unwrap_or(0)
        })
        .unwrap_or(0);
    let max_z = cards
        .map(|cards| {
            cards
                .iter()
                .filter_map(|card| card.get("z").and_then(Value::as_f64))
                .fold(0.0, f64::max)
        })
        .unwrap_or(0.0);
    let card_id = format!("{}_{}", card_type, uuid::Uuid::new_v4().simple());

    let mut card = json!({
        "id": card_id,
        "type": card_type,
        "x": x,
        "y": y,
        "w": w,
        "h": h,
        "z": max_z + 1.0,
        "parentId": parent,
        "order": order,
    });
    if let Some(object) = card.as_object_mut() {
        if let Some(defaults) = card_defaults(card_type).as_object() {
            for (key, value) in defaults {
                object.insert(key.clone(), value.clone());
            }
        }
        for key in ["text", "title", "url", "caption", "color", "query"] {
            if let Some(value) = args.get(key).and_then(Value::as_str) {
                if key == "title"
                    && card_type != "link"
                    && card_type != "todo"
                    && card_type != "document"
                    && card_type != "board"
                    && card_type != "column"
                {
                    continue;
                }
                object.insert(key.into(), json!(value));
            }
        }
        if let Some(target) = args.get("target_board_id").and_then(Value::as_str) {
            object.insert("boardId".into(), json!(target));
        }
        if let Some(items) = args.get("items").and_then(Value::as_array) {
            let items: Vec<Value> = items
                .iter()
                .filter_map(Value::as_str)
                .map(|text| {
                    json!({
                        "id": format!("i_{}", uuid::Uuid::new_v4().simple()),
                        "text": text,
                        "done": false,
                    })
                })
                .collect();
            object.insert("items".into(), json!(items));
        }
        if let Some(messages) = args.get("messages").and_then(Value::as_array) {
            let messages: Vec<Value> = messages
                .iter()
                .filter_map(Value::as_str)
                .map(|text| {
                    json!({
                        "id": format!("m_{}", uuid::Uuid::new_v4().simple()),
                        "author": "MCP",
                        "text": text,
                        "done": false,
                        "ts": now_ms(),
                    })
                })
                .collect();
            object.insert("messages".into(), json!(messages));
        }
    }
    Ok(card)
}

fn card_summary(card: &Value) -> String {
    let card_type = card.get("type").and_then(Value::as_str).unwrap_or("");
    let text_of = |key: &str| card.get(key).and_then(Value::as_str).unwrap_or("");
    match card_type {
        "note" | "heading" | "document" => truncate(text_of("text"), 140),
        "link" => format!("{} {}", text_of("title"), text_of("url"))
            .trim()
            .to_string(),
        "todo" => {
            let items = card.get("items").and_then(Value::as_array);
            let total = items.map(|items| items.len()).unwrap_or(0);
            let done = items
                .map(|items| {
                    items
                        .iter()
                        .filter(|item| item.get("done").and_then(Value::as_bool).unwrap_or(false))
                        .count()
                })
                .unwrap_or(0);
            let first = items
                .and_then(|items| items.first())
                .and_then(|item| item.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("");
            format!(
                "{} ({done}/{total} done){}{}",
                text_of("title"),
                if first.is_empty() { "" } else { ": " },
                truncate(first, 80)
            )
        }
        "comment" => {
            let count = card
                .get("messages")
                .and_then(Value::as_array)
                .map(|m| m.len())
                .unwrap_or(0);
            let last = card
                .get("messages")
                .and_then(Value::as_array)
                .and_then(|messages| messages.last())
                .and_then(|message| message.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("");
            format!(
                "{count} message(s){}",
                if last.is_empty() {
                    String::new()
                } else {
                    format!(": {}", truncate(last, 100))
                }
            )
        }
        "table" => {
            let rows = card
                .get("cells")
                .and_then(Value::as_array)
                .map(|r| r.len())
                .unwrap_or(0);
            let cols = card
                .get("cells")
                .and_then(Value::as_array)
                .and_then(|rows| rows.first())
                .and_then(Value::as_array)
                .map(|cols| cols.len())
                .unwrap_or(0);
            format!("{rows}x{cols} table")
        }
        "color" => format!("{} {}", text_of("color"), text_of("name"))
            .trim()
            .to_string(),
        "sketch" => format!(
            "{} stroke(s)",
            card.get("strokes")
                .and_then(Value::as_array)
                .map(|s| s.len())
                .unwrap_or(0)
        ),
        "image" => format!("{} {}", text_of("caption"), text_of("src"))
            .trim()
            .to_string(),
        "board" => format!("board {} ({})", text_of("title"), text_of("boardId"))
            .trim()
            .to_string(),
        "column" => format!("column {}", text_of("title")).trim().to_string(),
        "file" => format!("file {}", text_of("name")).trim().to_string(),
        _ => format!("{} {}", card_type, text_of("title"))
            .trim()
            .to_string(),
    }
}

fn card_texts(card: &Value) -> Vec<String> {
    let mut texts: Vec<String> = Vec::new();
    for key in ["text", "title", "url", "caption", "name", "query"] {
        if let Some(value) = card.get(key).and_then(Value::as_str) {
            if !value.is_empty() {
                texts.push(value.to_string());
            }
        }
    }
    if let Some(items) = card.get("items").and_then(Value::as_array) {
        for item in items {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                texts.push(text.to_string());
            }
        }
    }
    if let Some(messages) = card.get("messages").and_then(Value::as_array) {
        for message in messages {
            if let Some(text) = message.get("text").and_then(Value::as_str) {
                texts.push(text.to_string());
            }
        }
    }
    if let Some(cells) = card.get("cells").and_then(Value::as_array) {
        for row in cells {
            if let Some(row) = row.as_array() {
                for cell in row {
                    if let Some(text) = cell.as_str() {
                        if !text.is_empty() {
                            texts.push(text.to_string());
                        }
                    }
                }
            }
        }
    }
    texts
}

fn truncate(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        text.to_string()
    } else {
        format!("{}\u{2026}", chars[..max].iter().collect::<String>())
    }
}

fn snippet(text: &str, query: &str) -> String {
    let lower = text.to_lowercase();
    if let Some(index) = lower.find(query) {
        let chars: Vec<char> = text.chars().collect();
        let before = lower[..index].chars().count();
        let start = before.saturating_sub(40);
        let end = (before + query.chars().count() + 60).min(chars.len());
        let slice: String = chars[start..end].iter().collect();
        format!("\u{2026}{slice}\u{2026}")
    } else {
        truncate(text, 120)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippets_keep_unicode_and_never_emit_mojibake() {
        let text = "Important note: résumé project and 日本語テキスト";
        let result = snippet(text, "résumé");
        assert!(
            result.contains("résumé"),
            "snippet lost the match: {result}"
        );
        assert!(!result.contains('â'), "snippet contains mojibake: {result}");
        assert!(result.starts_with('\u{2026}') && result.ends_with('\u{2026}'));
    }

    #[test]
    fn truncate_counts_characters_not_bytes() {
        let result = truncate("日本語テキスト", 3);
        assert!(result.starts_with("日本語"));
        assert!(result.ends_with('\u{2026}'));
    }
}
