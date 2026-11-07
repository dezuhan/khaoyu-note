use base64::Engine;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Manager, State};

struct AppDb(Mutex<Connection>);

const MAX_ASSET_BYTES: u64 = 100 * 1024 * 1024;
const CURRENT_SCHEMA_VERSION: i64 = 1;
pub const DB_FILE: &str = "khaoyu-note.db";
// Only used to find and migrate data written by releases before the rename. These values must keep
// matching the identifiers those releases actually wrote, or the migration becomes a no-op and an
// upgraded install starts on an empty database.
const LEGACY_APP_IDENTIFIER: &str = "com.dezuhan.milanoteclone";
const LEGACY_DB_FILE: &str = "milanote.db";
const BLOCKED_ASSET_EXTENSIONS: &[&str] = &[
    "exe", "msi", "bat", "cmd", "ps1", "scr", "com", "dll", "jar", "vbs", "js", "lnk",
];

fn validate_asset_name(name: &str) -> Result<(), String> {
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if BLOCKED_ASSET_EXTENSIONS.contains(&extension.as_str()) {
        return Err("This file type is not allowed".into());
    }
    Ok(())
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let target = destination.join(entry.file_name());
        if path.is_dir() {
            copy_dir_recursive(&path, &target)?;
        } else if path.is_file() {
            fs::copy(&path, &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// CRC-32 (IEEE 802.3) for the ZIP container. The backup export writes an uncompressed (STORE)
/// archive on purpose: the payload is a SQLite snapshot plus media assets that are already
/// compressed, so deflate would add a dependency and save almost nothing.
fn crc32(bytes: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (index, slot) in table.iter_mut().enumerate() {
        let mut value = index as u32;
        for _ in 0..8 {
            value = if value & 1 == 1 {
                0xEDB8_8320 ^ (value >> 1)
            } else {
                value >> 1
            };
        }
        *slot = value;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for byte in bytes {
        crc = table[((crc ^ *byte as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    !crc
}

fn push_u16(buffer: &mut Vec<u8>, value: u16) {
    buffer.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(buffer: &mut Vec<u8>, value: u32) {
    buffer.extend_from_slice(&value.to_le_bytes());
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (if month <= 2 { year + 1 } else { year }, month as u32, day as u32)
}

/// DOS date and time fields used by the ZIP local and central headers.
fn dos_datetime(time: SystemTime) -> (u16, u16) {
    let seconds = time
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0);
    let days = seconds.div_euclid(86_400);
    let remaining = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let year = year.clamp(1980, 2107);
    let date = (((year - 1980) as u16) << 9) | ((month as u16) << 5) | day as u16;
    let clock = (((remaining / 3_600) as u16) << 11)
        | (((remaining % 3_600) / 60) as u16) << 5
        | ((remaining % 60) / 2) as u16;
    (clock, date)
}

fn collect_zip_entries(
    root: &Path,
    directory: &Path,
    entries: &mut Vec<(String, PathBuf)>,
) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_zip_entries(root, &path, entries)?;
        } else if path.is_file() {
            let relative = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            entries.push((relative, path));
        }
    }
    Ok(())
}

/// Write every file under `source` into an uncompressed ZIP archive at `zip_path`.
fn write_zip_directory(source: &Path, zip_path: &Path) -> Result<(), String> {
    let mut entries = Vec::new();
    collect_zip_entries(source, source, &mut entries)?;
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    if entries.len() > u16::MAX as usize {
        return Err("the backup has too many files for a ZIP archive".into());
    }
    let (dos_time, dos_date) = dos_datetime(SystemTime::now());
    let file = fs::File::create(zip_path).map_err(|e| e.to_string())?;
    let mut writer = std::io::BufWriter::new(file);
    let mut central: Vec<u8> = Vec::new();
    let mut offset: u64 = 0;
    for (name, path) in &entries {
        if name.len() > u16::MAX as usize {
            return Err(format!("{name} is too long for a ZIP archive"));
        }
        let data = fs::read(path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
        if data.len() > u32::MAX as usize {
            return Err(format!("{name} is too large for a ZIP archive"));
        }
        let crc = crc32(&data);
        let mut header = Vec::with_capacity(30 + name.len());
        push_u32(&mut header, 0x0403_4b50);
        push_u16(&mut header, 20);
        push_u16(&mut header, 0x0800);
        push_u16(&mut header, 0);
        push_u16(&mut header, dos_time);
        push_u16(&mut header, dos_date);
        push_u32(&mut header, crc);
        push_u32(&mut header, data.len() as u32);
        push_u32(&mut header, data.len() as u32);
        push_u16(&mut header, name.len() as u16);
        push_u16(&mut header, 0);
        header.extend_from_slice(name.as_bytes());
        std::io::Write::write_all(&mut writer, &header).map_err(|e| e.to_string())?;
        std::io::Write::write_all(&mut writer, &data).map_err(|e| e.to_string())?;

        push_u32(&mut central, 0x0201_4b50);
        push_u16(&mut central, 20);
        push_u16(&mut central, 20);
        push_u16(&mut central, 0x0800);
        push_u16(&mut central, 0);
        push_u16(&mut central, dos_time);
        push_u16(&mut central, dos_date);
        push_u32(&mut central, crc);
        push_u32(&mut central, data.len() as u32);
        push_u32(&mut central, data.len() as u32);
        push_u16(&mut central, name.len() as u16);
        push_u16(&mut central, 0);
        push_u16(&mut central, 0);
        push_u16(&mut central, 0);
        push_u16(&mut central, 0);
        push_u32(&mut central, 0);
        push_u32(&mut central, offset as u32);
        central.extend_from_slice(name.as_bytes());

        offset += (header.len() + data.len()) as u64;
    }
    if offset > u32::MAX as u64 {
        return Err("the backup is larger than a ZIP archive can address".into());
    }
    let central_offset = offset;
    std::io::Write::write_all(&mut writer, &central).map_err(|e| e.to_string())?;
    let mut end = Vec::with_capacity(22);
    push_u32(&mut end, 0x0605_4b50);
    push_u16(&mut end, 0);
    push_u16(&mut end, 0);
    push_u16(&mut end, entries.len() as u16);
    push_u16(&mut end, entries.len() as u16);
    push_u32(&mut end, central.len() as u32);
    push_u32(&mut end, central_offset as u32);
    push_u16(&mut end, 0);
    std::io::Write::write_all(&mut writer, &end).map_err(|e| e.to_string())?;
    std::io::Write::flush(&mut writer).map_err(|e| e.to_string())?;
    Ok(())
}

/// Pick a path that does not exist yet, so two backups or exports in the same millisecond cannot
/// overwrite or fail each other.
fn unique_path(directory: &Path, stem: &str, extension: Option<&str>) -> PathBuf {
    let mut counter = 0;
    loop {
        let suffix = if counter == 0 {
            String::new()
        } else {
            format!("-{counter}")
        };
        let name = match extension {
            Some(extension) => format!("{stem}{suffix}.{extension}"),
            None => format!("{stem}{suffix}"),
        };
        let candidate = directory.join(name);
        if !candidate.exists() {
            return candidate;
        }
        counter += 1;
    }
}

fn schema_version(conn: &Connection) -> Result<i64, String> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(value.and_then(|entry| entry.parse().ok()).unwrap_or(0))
}

fn check_schema_version(conn: &Connection) -> Result<(), String> {
    let version = schema_version(conn)?;
    if version > CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "Database schema {version} is newer than this app supports ({CURRENT_SCHEMA_VERSION})"
        ));
    }
    if version < CURRENT_SCHEMA_VERSION {
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?1)",
            params![CURRENT_SCHEMA_VERSION.to_string()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn backup_db_path(source: &Path) -> Result<PathBuf, String> {
    let current = source.join(DB_FILE);
    if current.is_file() {
        return Ok(current);
    }
    // Backups made before the rename used the old database filename.
    let legacy = source.join(LEGACY_DB_FILE);
    if legacy.is_file() {
        return Ok(legacy);
    }
    Err("Restore backup has no database file".into())
}

fn validate_backup_database(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err("Restore backup has no database file".into());
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("cannot open backup database: {e}"))?;
    let tables: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('boards', 'cards', 'meta')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if tables < 3 {
        return Err("That folder is not a Khaoyu Note backup".into());
    }
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if !integrity.eq_ignore_ascii_case("ok") {
        return Err(format!("Backup failed the integrity check: {integrity}"));
    }
    let version: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(version) = version.and_then(|value| value.parse::<i64>().ok()) {
        if version > CURRENT_SCHEMA_VERSION {
            return Err(format!(
                "Backup schema {version} is newer than this app supports ({CURRENT_SCHEMA_VERSION})"
            ));
        }
    }
    Ok(())
}

/// Replace the live database and assets with a validated backup. The current data is copied to
/// `backups/pre-restore-<timestamp>` first, and every new file is prepared and checked before the
/// swap, so a failed restore leaves the existing data in place.
fn restore_from(root: &Path, source: &Path) -> Result<(), String> {
    let source = fs::canonicalize(source).map_err(|e| format!("backup folder not found: {e}"))?;
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    if source == root {
        return Err("the backup folder is the live data folder".into());
    }
    let source_db = backup_db_path(&source)?;
    validate_backup_database(&source_db)?;

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let temp_db = root.join("khaoyu-note.restore.db");
    let temp_assets = root.join("assets.restore");
    let _ = fs::remove_file(&temp_db);
    let _ = fs::remove_dir_all(&temp_assets);

    fs::copy(&source_db, &temp_db)
        .map_err(|e| format!("could not stage the backup database: {e}"))?;
    validate_backup_database(&temp_db)?;
    fs::create_dir_all(&temp_assets).map_err(|e| e.to_string())?;
    if source.join("assets").is_dir() {
        copy_dir_recursive(&source.join("assets"), &temp_assets)?;
    }

    let backup = unique_path(&root.join("backups"), &format!("pre-restore-{stamp}"), None);
    fs::create_dir_all(&backup).map_err(|e| e.to_string())?;
    let current_db = root.join(DB_FILE);
    let current_assets = root.join("assets");
    let backup_db = backup.join(DB_FILE);
    let had_current_db = current_db.is_file();
    if had_current_db {
        let conn = Connection::open(&current_db).map_err(|e| e.to_string())?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        conn.execute(
            "VACUUM INTO ?1",
            params![backup_db.to_string_lossy().to_string()],
        )
        .map_err(|e| format!("could not back up the current database: {e}"))?;
    }
    if current_assets.is_dir() {
        copy_dir_recursive(&current_assets, &backup.join("assets"))?;
    }

    let _ = fs::remove_file(root.join(format!("{DB_FILE}-wal")));
    let _ = fs::remove_file(root.join(format!("{DB_FILE}-shm")));

    if had_current_db {
        fs::remove_file(&current_db).map_err(|e| e.to_string())?;
    }
    let install_db = fs::rename(&temp_db, &current_db).or_else(|_| {
        fs::copy(&temp_db, &current_db)
            .map(|_| ())
            .and_then(|_| fs::remove_file(&temp_db))
    });
    if let Err(error) = install_db {
        if had_current_db {
            let _ = fs::copy(&backup_db, &current_db);
        }
        return Err(format!("could not install the restored database: {error}"));
    }

    if current_assets.is_dir() {
        if let Err(error) = fs::remove_dir_all(&current_assets) {
            if had_current_db {
                let _ = fs::copy(&backup_db, &current_db);
            }
            return Err(format!("could not replace the current assets: {error}"));
        }
    }
    if let Err(error) = fs::rename(&temp_assets, &current_assets) {
        if backup.join("assets").is_dir() {
            let _ = copy_dir_recursive(&backup.join("assets"), &current_assets);
        }
        return Err(format!("could not install the restored assets: {error}"));
    }
    Ok(())
}

fn apply_pending_restore(root: &Path) -> Result<(), String> {
    let marker = root.join("restore-pending.txt");
    if !marker.is_file() {
        return Ok(());
    }
    let source = PathBuf::from(
        fs::read_to_string(&marker)
            .map_err(|e| e.to_string())?
            .trim(),
    );
    match restore_from(root, &source) {
        Ok(()) => {
            let _ = fs::remove_file(&marker);
            Ok(())
        }
        Err(error) => {
            // Never leave the app in a startup loop: keep the current data, park the marker with
            // the reason so the failure is inspectable, and let the app open normally.
            let failed = root.join(format!("restore-failed-{}.txt", now_ms()));
            let _ = fs::write(
                &failed,
                format!("Backup: {}\nError: {error}\n", source.display()),
            );
            let _ = fs::remove_file(&marker);
            eprintln!("khaoyu-note: restore failed: {error}");
            Ok(())
        }
    }
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    parent_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    view TEXT NOT NULL,
    grid INTEGER NOT NULL,
    show_grid INTEGER NOT NULL,
    theme TEXT,
    archived_at INTEGER,
    trashed_at INTEGER,
    trash TEXT
);
CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    parent_id TEXT,
    x REAL NOT NULL,
    y REAL NOT NULL,
    w REAL NOT NULL,
    h REAL NOT NULL,
    z REAL NOT NULL,
    ord REAL NOT NULL,
    data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_board ON cards(board_id);
CREATE INDEX IF NOT EXISTS cards_parent ON cards(parent_id);
CREATE INDEX IF NOT EXISTS boards_parent ON boards(parent_id);
CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    data TEXT
);
CREATE INDEX IF NOT EXISTS connections_board ON connections(board_id);
CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
"#;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn root_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn assets_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = root_dir(app)?.join("assets");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Resolve a path and prove it stays inside the asset directory. Both the download and the
/// open-file command use this, so a crafted or imported board cannot launch arbitrary files.
fn canonical_asset_path(assets: &Path, source: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(source).map_err(|e| e.to_string())?;
    if !canonical.starts_with(assets) {
        return Err("not an app asset".into());
    }
    Ok(canonical)
}

/// Open a file or URL with the system default handler. Windows goes through ShellExecuteW,
/// never `cmd /C start`, because cmd re-parses `&` in user-supplied links as a new command.
fn shell_open(target: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let operation: Vec<u16> = std::ffi::OsStr::new("open")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let file: Vec<u16> = std::ffi::OsStr::new(target)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if result as isize <= 32 {
            return Err(format!(
                "could not open target (ShellExecuteW returned {})",
                result as isize
            ));
        }
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(target)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = target;
        Err("opening files is not supported on this platform".into())
    }
}

pub fn str_field<'a>(doc: &'a Value, key: &str) -> Option<&'a str> {
    doc.get(key).and_then(Value::as_str)
}

pub fn num_field(doc: &Value, key: &str) -> Option<f64> {
    doc.get(key).and_then(Value::as_f64)
}

/// Persist a whole board document. Cards and connections are stored as rows, each card keeping its
/// full JSON payload in `data` while the geometry is duplicated in columns for querying.
pub fn write_doc(conn: &Connection, doc: &Value) -> Result<(), String> {
    write_doc_checked(conn, doc, None).map(|_| ())
}

/// Persist a board only when the stored `updated_at` still matches the value the caller loaded.
/// A mismatch means another writer (the app, another process or the MCP server) saved in between,
/// so refusing the write is safer than silently overwriting their changes.
pub fn write_doc_checked(
    conn: &Connection,
    doc: &Value,
    expected_updated_at: Option<i64>,
) -> Result<i64, String> {
    let id = str_field(doc, "id").ok_or("board id missing")?.to_string();
    let title = str_field(doc, "title")
        .unwrap_or("Untitled board")
        .to_string();
    let parent_id = str_field(doc, "parentId").map(|s| s.to_string());
    let created_at = doc
        .get("createdAt")
        .and_then(Value::as_i64)
        .unwrap_or_else(now_ms);
    let updated_at = doc
        .get("updatedAt")
        .and_then(Value::as_i64)
        .unwrap_or_else(now_ms);
    let view = doc
        .get("view")
        .map(|v| v.to_string())
        .unwrap_or_else(|| "{\"x\":0,\"y\":0,\"zoom\":1}".to_string());
    let grid = doc.get("grid").and_then(Value::as_i64).unwrap_or(24);
    let show_grid = doc.get("showGrid").and_then(Value::as_bool).unwrap_or(true) as i64;
    let theme = str_field(doc, "theme").map(|s| s.to_string());
    let archived_at = doc.get("archivedAt").and_then(Value::as_i64);
    let trashed_at = doc.get("trashedAt").and_then(Value::as_i64);
    let has_archived_at = doc.get("archivedAt").is_some();
    let has_trashed_at = doc.get("trashedAt").is_some();
    let trash = doc.get("trash").map(|value| value.to_string());
    let has_trash = doc.get("trash").is_some();

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    if let Some(expected) = expected_updated_at {
        let current: Option<i64> = tx
            .query_row(
                "SELECT updated_at FROM boards WHERE id = ?1",
                params![&id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match current {
            Some(value) if value == expected => {}
            Some(_) => {
                return Err(
                    "conflict: the board was changed by another writer, reload it and try again"
                        .into(),
                )
            }
            None => return Err("conflict: the board no longer exists".into()),
        }
    }

    tx.execute(
        "INSERT INTO boards (id, title, parent_id, created_at, updated_at, view, grid, show_grid, theme, archived_at, trashed_at, trash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             parent_id = excluded.parent_id,
             updated_at = excluded.updated_at,
             view = excluded.view,
             grid = excluded.grid,
             show_grid = excluded.show_grid,
             theme = excluded.theme,
             archived_at = CASE WHEN ?13 THEN excluded.archived_at ELSE boards.archived_at END,
             trashed_at = CASE WHEN ?14 THEN excluded.trashed_at ELSE boards.trashed_at END,
             trash = CASE WHEN ?15 THEN excluded.trash ELSE boards.trash END",
        params![
            id,
            title,
            parent_id,
            created_at,
            updated_at,
            view,
            grid,
            show_grid,
            theme,
            archived_at,
            trashed_at,
            trash,
            has_archived_at,
            has_trashed_at,
            has_trash
        ],
    )
    .map_err(|e| e.to_string())?;

    tx.execute("DELETE FROM cards WHERE board_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    if let Some(cards) = doc.get("cards").and_then(Value::as_array) {
        for card in cards {
            let card_id = str_field(card, "id").unwrap_or_default().to_string();
            let card_type = str_field(card, "type").unwrap_or("note").to_string();
            let parent = str_field(card, "parentId").map(|s| s.to_string());
            let x = num_field(card, "x").unwrap_or(0.0);
            let y = num_field(card, "y").unwrap_or(0.0);
            let w = num_field(card, "w").unwrap_or(240.0);
            let h = num_field(card, "h").unwrap_or(70.0);
            let z = num_field(card, "z").unwrap_or(1.0);
            let ord = num_field(card, "order").unwrap_or(0.0);
            tx.execute(
                "INSERT INTO cards (id, board_id, type, parent_id, x, y, w, h, z, ord, data)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    card_id,
                    id,
                    card_type,
                    parent,
                    x,
                    y,
                    w,
                    h,
                    z,
                    ord,
                    card.to_string()
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    tx.execute("DELETE FROM connections WHERE board_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    if let Some(connections) = doc.get("connections").and_then(Value::as_array) {
        for connection in connections {
            let conn_id = str_field(connection, "id").unwrap_or_default().to_string();
            let from_id = str_field(connection, "from")
                .unwrap_or_default()
                .to_string();
            let to_id = str_field(connection, "to").unwrap_or_default().to_string();
            tx.execute(
                "INSERT INTO connections (id, board_id, from_id, to_id, data) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![conn_id, id, from_id, to_id, connection.to_string()],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(updated_at)
}

pub fn read_doc(conn: &Connection, id: &str) -> Result<Option<String>, String> {
    let row = conn
        .query_row(
            "SELECT title, parent_id, created_at, updated_at, view, grid, show_grid, theme, archived_at, trashed_at, trash
             FROM boards WHERE id = ?1",
            params![id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, Option<i64>>(8)?,
                    r.get::<_, Option<i64>>(9)?,
                    r.get::<_, Option<String>>(10)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((
        title,
        parent_id,
        created_at,
        updated_at,
        view,
        grid,
        show_grid,
        theme,
        archived_at,
        trashed_at,
        trash,
    )) = row
    else {
        return Ok(None);
    };

    let mut card_stmt = conn
        .prepare("SELECT data FROM cards WHERE board_id = ?1 ORDER BY z ASC, ord ASC")
        .map_err(|e| e.to_string())?;
    let mut cards: Vec<Value> = Vec::new();
    for entry in card_stmt
        .query_map(params![id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
    {
        match entry {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(card) => cards.push(card),
                Err(error) => {
                    eprintln!("khaoyu-note: skipping a corrupt card in board {id}: {error}")
                }
            },
            Err(error) => eprintln!("khaoyu-note: could not read a card in board {id}: {error}"),
        }
    }

    let mut conn_stmt = conn
        .prepare("SELECT data FROM connections WHERE board_id = ?1")
        .map_err(|e| e.to_string())?;
    let mut connections: Vec<Value> = Vec::new();
    for entry in conn_stmt
        .query_map(params![id], |r| r.get::<_, Option<String>>(0))
        .map_err(|e| e.to_string())?
    {
        let Ok(Some(text)) = entry else { continue };
        match serde_json::from_str::<Value>(&text) {
            Ok(connection) => connections.push(connection),
            Err(error) => {
                eprintln!("khaoyu-note: skipping a corrupt connection in board {id}: {error}")
            }
        }
    }

    let view_value = serde_json::from_str::<Value>(&view)
        .unwrap_or_else(|_| json!({ "x": 0, "y": 0, "zoom": 1 }));

    let mut doc = json!({
        "id": id,
        "title": title,
        "parentId": parent_id,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "view": view_value,
        "grid": grid,
        "showGrid": show_grid != 0,
        "theme": theme,
        "cards": cards,
        "connections": connections,
        "trash": serde_json::from_str::<Value>(trash.as_deref().unwrap_or("[]")).unwrap_or(json!([])),
    });
    if let Some(value) = archived_at {
        doc["archivedAt"] = json!(value);
    }
    if let Some(value) = trashed_at {
        doc["trashedAt"] = json!(value);
    }
    serde_json::to_string(&doc)
        .map(Some)
        .map_err(|e| e.to_string())
}

fn migrate_legacy(conn: &Connection, root: &Path) -> Result<(), String> {
    let imported: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'legacy_json_imported'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if imported.is_some() {
        return Ok(());
    }

    // Import any legacy JSON board folders: the original `boards/` and any backup folder created by
    // an earlier upgrade attempt. write_doc owns its transaction, so this loop must stay outside one.
    let mut folders: Vec<PathBuf> = Vec::new();
    let legacy = root.join("boards");
    if legacy.is_dir() {
        folders.push(legacy.clone());
    }
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if path.is_dir() && name.starts_with("boards-json-backup-") {
                folders.push(path);
            }
        }
    }

    let mut imported_count = 0usize;
    let mut failed_count = 0usize;
    for folder in folders {
        let Ok(entries) = fs::read_dir(&folder) else {
            continue;
        };
        // Count failures per folder: one broken file in an older backup folder must not stop the
        // primary boards folder from being archived.
        let mut folder_failed = 0usize;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let text = match fs::read_to_string(&path) {
                Ok(text) => text,
                Err(error) => {
                    failed_count += 1;
                    folder_failed += 1;
                    eprintln!("khaoyu-note: cannot read {}: {error}", path.display());
                    continue;
                }
            };
            let doc = match serde_json::from_str::<Value>(&text) {
                Ok(doc) => doc,
                Err(error) => {
                    failed_count += 1;
                    folder_failed += 1;
                    eprintln!(
                        "khaoyu-note: invalid legacy board {}: {error}",
                        path.display()
                    );
                    continue;
                }
            };
            match write_doc(conn, &doc) {
                Ok(()) => imported_count += 1,
                Err(error) => {
                    failed_count += 1;
                    folder_failed += 1;
                    eprintln!("khaoyu-note: cannot import {}: {error}", path.display());
                }
            }
        }
        if folder == legacy && folder_failed == 0 {
            let backup = unique_path(root, &format!("boards-json-backup-{}", now_ms()), None);
            let _ = fs::rename(&legacy, backup);
        }
    }

    if failed_count > 0 {
        // Keep the folder and retry next launch. Successful boards are already upserted, so a
        // retry is idempotent, and no legacy file is hidden in a backup folder while it is broken.
        eprintln!(
            "khaoyu-note: legacy import incomplete ({failed_count} file(s) failed); keeping {}",
            legacy.display()
        );
        return Ok(());
    }

    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('legacy_json_imported', ?1)",
        params![imported_count.to_string()],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1')",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn ensure_board_flag_columns(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(boards)")
        .map_err(|e| e.to_string())?;
    let columns: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok())
        .collect();
    if !columns.iter().any(|name| name == "archived_at") {
        conn.execute("ALTER TABLE boards ADD COLUMN archived_at INTEGER", [])
            .map_err(|e| e.to_string())?;
    }
    if !columns.iter().any(|name| name == "trashed_at") {
        conn.execute("ALTER TABLE boards ADD COLUMN trashed_at INTEGER", [])
            .map_err(|e| e.to_string())?;
    }
    if !columns.iter().any(|name| name == "trash") {
        conn.execute("ALTER TABLE boards ADD COLUMN trash TEXT", [])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Older builds wrote seconds while the frontend writes milliseconds. Normalise any second-sized
/// value once on open so ordering, preview caches and relative times all agree.
fn normalize_timestamps(conn: &Connection) -> Result<(), String> {
    for (table, column) in [
        ("boards", "created_at"),
        ("boards", "updated_at"),
        ("boards", "archived_at"),
        ("boards", "trashed_at"),
        ("assets", "created_at"),
    ] {
        conn.execute(
            &format!(
                "UPDATE {table} SET {column} = {column} * 1000
                 WHERE {column} IS NOT NULL AND {column} > 0 AND {column} < 100000000000"
            ),
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Move data written under the pre-rename app identifier to the current one. The copy is validated
/// before the old directory is removed, so a failed migration never destroys the only database.
pub fn migrate_legacy_data_dir(new_root: &Path) -> Result<(), String> {
    if new_root.join(DB_FILE).is_file() {
        return Ok(());
    }
    let parent = new_root
        .parent()
        .ok_or("cannot resolve the parent of the data folder")?;
    let legacy = parent.join(LEGACY_APP_IDENTIFIER);
    if legacy == new_root || !legacy.join(LEGACY_DB_FILE).is_file() {
        return Ok(());
    }

    fs::create_dir_all(new_root).map_err(|e| e.to_string())?;
    for suffix in ["", "-wal", "-shm"] {
        let source = legacy.join(format!("{LEGACY_DB_FILE}{suffix}"));
        if source.is_file() {
            fs::copy(&source, new_root.join(format!("{DB_FILE}{suffix}")))
                .map_err(|e| format!("could not migrate the database: {e}"))?;
        }
    }
    if legacy.join("assets").is_dir() {
        copy_dir_recursive(&legacy.join("assets"), &new_root.join("assets"))
            .map_err(|e| format!("could not migrate assets: {e}"))?;
    }

    let migrated_db = new_root.join(DB_FILE);
    let integrity: String = {
        let conn = Connection::open(&migrated_db).map_err(|e| e.to_string())?;
        conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(|e| e.to_string())?
    };
    if !integrity.eq_ignore_ascii_case("ok") {
        for suffix in ["", "-wal", "-shm"] {
            let _ = fs::remove_file(new_root.join(format!("{DB_FILE}{suffix}")));
        }
        return Err(format!(
            "migrated database failed the integrity check: {integrity}"
        ));
    }

    if let Err(error) = fs::remove_dir_all(&legacy) {
        eprintln!(
            "khaoyu-note: migrated the data folder but could not remove {}: {error}",
            legacy.display()
        );
    }
    Ok(())
}

/// Open (or create) the SQLite database in a given data directory. Shared by the Tauri app and the
/// standalone MCP server binary.
pub fn open_db_at(root: &Path) -> Result<Connection, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let conn = Connection::open(root.join(DB_FILE)).map_err(|e| e.to_string())?;
    // The desktop app and the MCP server share one database. Wait for a competing writer
    // instead of failing the very first save with SQLITE_BUSY.
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
        .map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    ensure_board_flag_columns(&conn)?;
    migrate_legacy(&conn, root)?;
    normalize_timestamps(&conn)?;
    check_schema_version(&conn)?;
    Ok(conn)
}

fn open_db(app: &tauri::AppHandle) -> Result<Connection, String> {
    open_db_at(&root_dir(app)?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardMeta {
    pub id: String,
    pub title: String,
    pub parent_id: Option<String>,
    pub updated_at: i64,
    pub archived_at: Option<i64>,
    pub trashed_at: Option<i64>,
}

pub fn list_board_meta(conn: &Connection) -> Result<Vec<BoardMeta>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, parent_id, updated_at, archived_at, trashed_at
             FROM boards ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(BoardMeta {
                id: r.get(0)?,
                title: r.get(1)?,
                parent_id: r.get(2)?,
                updated_at: r.get(3)?,
                archived_at: r.get(4)?,
                trashed_at: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_boards(db: State<'_, AppDb>) -> Result<Vec<BoardMeta>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    list_board_meta(&conn)
}

#[tauri::command]
fn load_board(db: State<'_, AppDb>, id: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    read_doc(&conn, &id)
}

#[tauri::command]
fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err("file not found".into());
    }
    let assets = fs::canonicalize(assets_dir(&app)?).map_err(|e| e.to_string())?;
    let canonical = canonical_asset_path(&assets, &source)?;
    shell_open(&canonical.to_string_lossy())
}

#[tauri::command]
fn download_asset(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err("asset not found".into());
    }
    let assets = fs::canonicalize(assets_dir(&app)?).map_err(|e| e.to_string())?;
    let canonical = canonical_asset_path(&assets, &source)?;
    let mut name = source
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "asset".to_string());
    if let Ok(conn) = app.state::<AppDb>().0.lock() {
        if let Ok(stored) = conn.query_row(
            "SELECT name FROM assets WHERE path = ?1 ORDER BY created_at DESC LIMIT 1",
            params![path],
            |row| row.get::<_, String>(0),
        ) {
            name = stored;
        }
    }
    let name = Path::new(&name)
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "asset".to_string());
    let directory = app.path().download_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let source_name = Path::new(&name);
    let stem = source_name
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "asset".to_string());
    let extension = source_name
        .extension()
        .map(|value| value.to_string_lossy().to_string());
    let mut destination = directory.join(&name);
    let mut counter = 1;
    while destination.exists() {
        let file_name = match extension.as_deref() {
            Some(ext) if !ext.is_empty() => format!("{} ({}).{}", stem, counter, ext),
            _ => format!("{} ({})", stem, counter),
        };
        destination = directory.join(file_name);
        counter += 1;
    }
    fs::copy(&canonical, &destination).map_err(|e| e.to_string())?;
    Ok(destination.to_string_lossy().to_string())
}

#[tauri::command]
fn rename_board(db: State<'_, AppDb>, id: String, title: String) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("title cannot be empty".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE boards SET title = ?1, updated_at = ?2 WHERE id = ?3",
        params![title, now_ms(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn archive_board(db: State<'_, AppDb>, id: String, archived: bool) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE boards SET archived_at = ?1 WHERE id = ?2",
        params![if archived { Some(now_ms()) } else { None }, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn trash_board(db: State<'_, AppDb>, id: String, trashed: bool) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE boards SET trashed_at = ?1 WHERE id = ?2",
        params![if trashed { Some(now_ms()) } else { None }, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn save_board(
    db: State<'_, AppDb>,
    id: String,
    data: String,
    base_updated_at: Option<i64>,
) -> Result<i64, String> {
    let doc: Value = serde_json::from_str(&data).map_err(|e| format!("invalid board json: {e}"))?;
    if str_field(&doc, "id") != Some(id.as_str()) {
        return Err("board id mismatch".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    write_doc_checked(&conn, &doc, base_updated_at)
}

pub fn delete_board_tree(conn: &Connection, id: &str) -> Result<(), String> {
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    collect_descendants(conn, id, &mut ids, &mut seen)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for board_id in ids {
        tx.execute("DELETE FROM cards WHERE board_id = ?1", params![board_id])
            .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM connections WHERE board_id = ?1",
            params![board_id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM boards WHERE id = ?1", params![board_id])
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_board(db: State<'_, AppDb>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    delete_board_tree(&conn, &id)
}

fn collect_descendants(
    conn: &Connection,
    id: &str,
    out: &mut Vec<String>,
    seen: &mut HashSet<String>,
) -> Result<(), String> {
    if !seen.insert(id.to_string()) {
        return Ok(());
    }
    out.push(id.to_string());
    let mut stmt = conn
        .prepare("SELECT id FROM boards WHERE parent_id = ?1")
        .map_err(|e| e.to_string())?;
    let children: Vec<String> = stmt
        .query_map(params![id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok())
        .collect();
    for child in children {
        collect_descendants(conn, &child, out, seen)?;
    }
    Ok(())
}

fn write_asset(app: &tauri::AppHandle, name: &str, bytes: &[u8]) -> Result<String, String> {
    validate_asset_name(name)?;
    if bytes.len() as u64 > MAX_ASSET_BYTES {
        return Err("Asset is larger than the 100 MB limit".into());
    }
    let dir = assets_dir(app)?;
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let file_name = format!("{}-{}", uuid::Uuid::new_v4(), safe);
    let path = dir.join(&file_name);
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    if let Ok(conn) = app.state::<AppDb>().0.lock() {
        let _ = conn.execute(
            "INSERT INTO assets (id, name, path, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![
                uuid::Uuid::new_v4().to_string(),
                name,
                path.to_string_lossy().to_string(),
                now_ms()
            ],
        );
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn store_asset(app: tauri::AppHandle, name: String, data: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| e.to_string())?;
    write_asset(&app, &name, &bytes)
}

#[tauri::command]
fn store_asset_from_path(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let source = std::path::PathBuf::from(&path);
    if !source.is_file() {
        return Err("Dropped item is not a file".into());
    }
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("file")
        .to_string();
    let metadata = fs::metadata(&source).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_ASSET_BYTES {
        return Err("Dropped file is larger than the 100 MB limit".into());
    }
    let bytes = fs::read(&source).map_err(|e| e.to_string())?;
    write_asset(&app, &name, &bytes)
}

#[tauri::command]
fn backup_data(app: tauri::AppHandle) -> Result<String, String> {
    let root = root_dir(&app)?;
    let base = app
        .path()
        .document_dir()
        .map_err(|e| e.to_string())?
        .join("Khaoyu Note Backups");
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let target = unique_path(&base, &format!("khaoyu-note-{}", now_ms()), None);
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    let db_target = target.join(DB_FILE);
    {
        let db = app.state::<AppDb>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "VACUUM INTO ?1",
            params![db_target.to_string_lossy().to_string()],
        )
        .map_err(|e| e.to_string())?;
    }
    let assets = root.join("assets");
    if assets.is_dir() {
        copy_dir_recursive(&assets, &target.join("assets"))?;
    }
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn export_backup_zip(app: tauri::AppHandle) -> Result<String, String> {
    let source = backup_data(app)?;
    let source_path = PathBuf::from(&source);
    let zip_path = source_path.with_extension("zip");
    if let Err(error) = write_zip_directory(&source_path, &zip_path) {
        let _ = fs::remove_file(&zip_path);
        return Err(error);
    }
    Ok(zip_path.to_string_lossy().to_string())
}

#[tauri::command]
fn db_integrity(db: State<'_, AppDb>) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn stage_restore(app: tauri::AppHandle, backup_path: String) -> Result<(), String> {
    let source =
        fs::canonicalize(&backup_path).map_err(|_| "That folder is not a Khaoyu Note backup")?;
    validate_backup_database(&backup_db_path(&source)?)?;
    let marker = root_dir(&app)?.join("restore-pending.txt");
    fs::write(marker, source.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn export_board(app: tauri::AppHandle, data: String) -> Result<String, String> {
    let docs = app
        .path()
        .document_dir()
        .map_err(|e| e.to_string())?
        .join("Khaoyu Note");
    fs::create_dir_all(&docs).map_err(|e| e.to_string())?;
    let file = unique_path(&docs, &format!("board-{}", now_ms()), Some("json"));
    fs::write(&file, data).map_err(|e| e.to_string())?;
    Ok(file.to_string_lossy().to_string())
}

#[tauri::command]
fn get_setting(db: State<'_, AppDb>, key: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| {
        r.get(0)
    })
    .optional()
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_setting(db: State<'_, AppDb>, key: String, value: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

#[derive(serde::Serialize)]
struct LinkPreviewPayload {
    data: String,
    name: String,
    mime: String,
}

fn blocked_preview_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".local") || host.is_empty() {
        return true;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(ip) => {
                ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified()
            }
            std::net::IpAddr::V6(ip) => ip.is_loopback() || ip.is_unspecified(),
        };
    }
    false
}

fn meta_image_url(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    for key in ["og:image:url", "og:image", "twitter:image"] {
        let mut from = 0;
        while let Some(pos) = lower[from..].find(key) {
            let start = from + pos + key.len();
            let end = (start + 400).min(lower.len());
            let window = &lower[start..end];
            if let Some(content) = window.find("content") {
                let after = &html[start + content..end];
                if let Some(eq) = after.find('=') {
                    let rest = after[eq + 1..].trim_start();
                    let quote = rest.chars().next()?;
                    if quote == '"' || quote == '\'' {
                        if let Some(close) = rest[1..].find(quote) {
                            let value = rest[1..1 + close].trim();
                            if !value.is_empty() {
                                return Some(
                                    value
                                        .replace("&amp;", "&")
                                        .replace("&#39;", "'")
                                        .replace("&quot;", "\""),
                                );
                            }
                        }
                    }
                }
            }
            from = start;
        }
    }
    None
}

const PREVIEW_USER_AGENT: &str = concat!("KhaoyuNote/", env!("CARGO_PKG_VERSION"), " link preview");

/// Extract a video id from a YouTube URL. The watch page often answers a scraper with a consent or
/// bot page instead of Open Graph tags, so the thumbnail is resolved from the id directly.
fn youtube_video_id(url: &reqwest::Url) -> Option<String> {
    let host = url.host_str()?.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(host.as_str()).to_string();
    let first_segment = |prefix: &str| {
        url.path()
            .strip_prefix(prefix)
            .map(|rest| rest.split('/').next().unwrap_or("").to_string())
            .filter(|value| !value.is_empty())
    };
    match host.as_str() {
        "youtu.be" => first_segment("/"),
        "youtube.com" | "m.youtube.com" | "music.youtube.com" | "youtube-nocookie.com" => url
            .query_pairs()
            .find(|(key, _)| key == "v")
            .map(|(_, value)| value.to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| first_segment("/shorts/"))
            .or_else(|| first_segment("/embed/"))
            .or_else(|| first_segment("/live/")),
        _ => None,
    }
}

fn video_thumbnail_urls(url: &reqwest::Url) -> Vec<reqwest::Url> {
    let Some(id) = youtube_video_id(url) else {
        return Vec::new();
    };
    ["maxresdefault", "hqdefault"]
        .iter()
        .filter_map(|name| {
            reqwest::Url::parse(&format!("https://img.youtube.com/vi/{id}/{name}.jpg")).ok()
        })
        .collect()
}

async fn fetch_preview_image(
    client: &reqwest::Client,
    image_url: reqwest::Url,
) -> Option<LinkPreviewPayload> {
    if image_url
        .host_str()
        .map(blocked_preview_host)
        .unwrap_or(true)
    {
        return None;
    }
    let image_response = client
        .get(image_url)
        .header(reqwest::header::USER_AGENT, PREVIEW_USER_AGENT)
        .send()
        .await
        .ok()?;
    if !image_response.status().is_success() {
        return None;
    }
    let content_type = image_response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/png")
        .split(';')
        .next()
        .unwrap_or("image/png")
        .to_string();
    if !content_type.starts_with("image/") {
        return None;
    }
    let image_bytes = image_response.bytes().await.ok()?;
    if image_bytes.is_empty() || image_bytes.len() > 5_000_000 {
        return None;
    }
    let extension = match content_type.as_str() {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "png",
    };
    let name = format!("link-hero.{extension}");
    Some(LinkPreviewPayload {
        data: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &image_bytes),
        name,
        mime: content_type,
    })
}

#[tauri::command]
async fn fetch_link_preview(url: String) -> Result<Option<LinkPreviewPayload>, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "invalid link")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http and https links can be previewed".into());
    }
    if parsed.host_str().map(blocked_preview_host).unwrap_or(true) {
        return Err("that host cannot be previewed".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())?;
    // YouTube links resolve straight to their thumbnail, without fetching the watch page.
    for candidate in video_thumbnail_urls(&parsed) {
        if let Some(payload) = fetch_preview_image(&client, candidate).await {
            return Ok(Some(payload));
        }
    }
    let response = client
        .get(parsed)
        .header(reqwest::header::USER_AGENT, PREVIEW_USER_AGENT)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let final_url = response.url().clone();
    if final_url
        .host_str()
        .map(blocked_preview_host)
        .unwrap_or(true)
    {
        return Ok(None);
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > 2_000_000 {
        return Ok(None);
    }
    let html = String::from_utf8_lossy(&bytes);
    let Some(image_path) = meta_image_url(&html) else {
        return Ok(None);
    };
    let Ok(image_url) = final_url.join(&image_path) else {
        return Ok(None);
    };
    Ok(fetch_preview_image(&client, image_url).await)
}

#[tauri::command]
fn app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = root_dir(&app)?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn mcp_server_path(app: tauri::AppHandle) -> Result<String, String> {
    let binary = format!("khaoyu-note-mcp{}", std::env::consts::EXE_SUFFIX);
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(&binary));
        }
    }
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join(&binary));
    }
    for candidate in candidates {
        if candidate.is_file() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }
    Ok(String::new())
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Check the latest published GitHub release. The request never downloads an installer; the client
/// only compares versions and shows the release notes.
#[tauri::command]
async fn check_update() -> Result<Value, String> {
    const UPDATE_REPO: &str = "dezuhan/khaoyu-note";
    const USER_AGENT: &str = concat!("KhaoyuNote/", env!("CARGO_PKG_VERSION"));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(format!(
            "https://api.github.com/repos/{UPDATE_REPO}/releases/latest"
        ))
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(json!({
            "currentVersion": env!("CARGO_PKG_VERSION"),
            "release": None::<Value>,
        }));
    }
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("GitHub rate limit reached, try again later".into());
    }
    if !status.is_success() {
        return Err(format!("GitHub answered {status}"));
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > 1_000_000 {
        return Err("the release description is too large".into());
    }
    let release: Value =
        serde_json::from_slice(&bytes).map_err(|_| "GitHub returned an unexpected response")?;
    Ok(json!({
        "currentVersion": env!("CARGO_PKG_VERSION"),
        "release": release,
    }))
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let lower = url.to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("only http and https links can be opened".into());
    }
    shell_open(&url)
}

fn gpu_enabled(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT value FROM meta WHERE key = 'gpu_acceleration'",
        [],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .map(|value| value != "false")
    .unwrap_or(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let new_root = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?;
            migrate_legacy_data_dir(&new_root)?;
            let root = root_dir(app.handle())?;
            if let Err(error) = apply_pending_restore(&root) {
                eprintln!("khaoyu-note: could not process a pending restore: {error}");
            }
            let conn = open_db(app.handle()).expect("failed to open the local SQLite database");
            let gpu = gpu_enabled(&conn);
            app.manage(AppDb(Mutex::new(conn)));

            let mut builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Khaoyu Note")
            .inner_size(1440.0, 900.0)
            .min_inner_size(900.0, 600.0)
            // Native file drops are forwarded to the web layer; internal card drags use pointer events.
            .drag_and_drop(true)
            .center();
            if !gpu {
                builder =
                    builder.additional_browser_args("--disable-gpu --disable-gpu-compositing");
            }
            builder.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_boards,
            load_board,
            save_board,
            rename_board,
            archive_board,
            trash_board,
            delete_board,
            store_asset,
            store_asset_from_path,
            backup_data,
            export_backup_zip,
            db_integrity,
            stage_restore,
            export_board,
            app_data_dir,
            mcp_server_path,
            app_version,
            check_update,
            open_external,
            fetch_link_preview,
            open_path,
            download_asset,
            get_setting,
            set_setting,
            restart_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-data")
            .join(format!("{label}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&root).expect("test root");
        root
    }

    fn sample_doc(id: &str, title: &str, updated_at: i64) -> Value {
        json!({
            "id": id,
            "title": title,
            "createdAt": 1,
            "updatedAt": updated_at,
            "view": { "x": 0, "y": 0, "zoom": 1 },
            "grid": 24,
            "showGrid": true,
            "cards": [],
            "connections": [],
            "trash": [],
        })
    }

    #[test]
    fn schema_version_and_integrity_are_idempotent() {
        let root = test_root("schema");
        {
            let conn = open_db_at(&root).expect("first open");
            assert_eq!(
                schema_version(&conn).expect("schema version"),
                CURRENT_SCHEMA_VERSION
            );
            let integrity: String = conn
                .query_row("PRAGMA integrity_check", [], |row| row.get(0))
                .expect("integrity check");
            assert_eq!(integrity, "ok");
        }
        {
            let conn = open_db_at(&root).expect("second open");
            assert_eq!(
                schema_version(&conn).expect("schema version"),
                CURRENT_SCHEMA_VERSION
            );
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn backup_zip_is_a_valid_store_archive() {
        assert_eq!(crc32(b""), 0);
        assert_eq!(crc32(b"hello"), 0x3610_A686);

        let root = test_root("zip-export");
        let source = root.join("khaoyu-note-1");
        fs::create_dir_all(source.join("assets")).expect("backup folders");
        fs::write(source.join(DB_FILE), b"database").expect("backup database");
        fs::write(source.join("assets").join("catatan.txt"), b"hello").expect("backup asset");

        let zip_path = source.with_extension("zip");
        write_zip_directory(&source, &zip_path).expect("write zip");
        let archive = fs::read(&zip_path).expect("read zip");

        assert_eq!(&archive[0..4], b"PK\x03\x04", "local file header signature");
        let end = archive.len() - 22;
        assert_eq!(&archive[end..end + 4], b"PK\x05\x06", "end of central directory");
        assert_eq!(u16::from_le_bytes([archive[end + 10], archive[end + 11]]), 2);
        let text = String::from_utf8_lossy(&archive);
        assert!(text.contains(DB_FILE), "archive keeps the database name");
        assert!(
            text.contains("assets/catatan.txt"),
            "archive uses forward slashes for nested assets"
        );
        assert!(
            archive.windows(4).any(|window| window == [0x86, 0xA6, 0x10, 0x36]),
            "archive stores the CRC of the asset bytes"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn youtube_links_resolve_to_a_thumbnail_url() {
        let watch =
            reqwest::Url::parse("https://www.youtube.com/watch?v=dQw4w9WgXcQ").expect("watch url");
        assert_eq!(youtube_video_id(&watch).as_deref(), Some("dQw4w9WgXcQ"));
        let thumbnails = video_thumbnail_urls(&watch);
        assert_eq!(thumbnails.len(), 2);
        assert!(thumbnails[0]
            .as_str()
            .contains("/vi/dQw4w9WgXcQ/maxresdefault.jpg"));

        let short = reqwest::Url::parse("https://youtu.be/dQw4w9WgXcQ?t=10").expect("short url");
        assert_eq!(youtube_video_id(&short).as_deref(), Some("dQw4w9WgXcQ"));

        let shorts = reqwest::Url::parse("https://youtube.com/shorts/abc123").expect("shorts url");
        assert_eq!(youtube_video_id(&shorts).as_deref(), Some("abc123"));

        let other = reqwest::Url::parse("https://example.com/watch?v=1").expect("other url");
        assert!(youtube_video_id(&other).is_none());
        assert!(video_thumbnail_urls(&other).is_empty());
    }

    #[test]
    fn stale_writes_are_rejected_until_the_base_is_refreshed() {
        let root = test_root("write-guard");
        let conn = open_db_at(&root).expect("open db");
        let original = sample_doc("b_guard", "First", 1000);
        write_doc(&conn, &original).expect("initial write");

        let mut external = original.clone();
        external["title"] = json!("External");
        external["updatedAt"] = json!(2000);
        write_doc(&conn, &external).expect("external write");

        let mut local = original.clone();
        local["title"] = json!("Local");
        local["updatedAt"] = json!(3000);
        let error = write_doc_checked(&conn, &local, Some(1000)).expect_err("stale write");
        assert!(error.starts_with("conflict:"), "unexpected error: {error}");

        let saved = write_doc_checked(&conn, &local, Some(2000)).expect("write on current base");
        assert_eq!(saved, 3000);
        let loaded: Value = serde_json::from_str(
            &read_doc(&conn, "b_guard")
                .expect("read")
                .expect("board exists"),
        )
        .expect("valid json");
        assert_eq!(loaded["title"], "Local");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pending_restore_replaces_data_and_keeps_a_pre_restore_backup() {
        let live = test_root("restore-live");
        {
            let conn = open_db_at(&live).expect("live db");
            write_doc(&conn, &sample_doc("b_old", "Old", 1000)).expect("old board");
        }

        let source_live = test_root("restore-source-live");
        {
            let conn = open_db_at(&source_live).expect("source db");
            write_doc(&conn, &sample_doc("b_new", "New", 2000)).expect("new board");
        }
        let source = test_root("restore-source");
        {
            let conn = Connection::open(source_live.join(DB_FILE)).expect("open source");
            conn.execute(
                "VACUUM INTO ?1",
                params![source.join(DB_FILE).to_string_lossy().to_string()],
            )
            .expect("snapshot");
        }
        fs::write(
            live.join("restore-pending.txt"),
            source.to_string_lossy().as_bytes(),
        )
        .expect("marker");

        apply_pending_restore(&live).expect("restore");

        assert!(!live.join("restore-pending.txt").exists());
        assert!(fs::read_dir(live.join("backups"))
            .expect("backups folder")
            .next()
            .is_some());
        let conn = open_db_at(&live).expect("reopen");
        assert!(read_doc(&conn, "b_old").expect("read old").is_none());
        assert!(read_doc(&conn, "b_new").expect("read new").is_some());
        let _ = fs::remove_dir_all(live);
        let _ = fs::remove_dir_all(source);
        let _ = fs::remove_dir_all(source_live);
    }

    #[test]
    fn failed_restore_keeps_the_current_database_and_does_not_block_startup() {
        let live = test_root("restore-bad-live");
        {
            let conn = open_db_at(&live).expect("live db");
            write_doc(&conn, &sample_doc("b_keep", "Keep", 1000)).expect("board");
        }
        let empty_backup = test_root("restore-bad-source");
        fs::write(
            live.join("restore-pending.txt"),
            empty_backup.to_string_lossy().as_bytes(),
        )
        .expect("marker");

        apply_pending_restore(&live).expect("restore must not fail startup");

        assert!(!live.join("restore-pending.txt").exists());
        let failed: Vec<_> = fs::read_dir(&live)
            .expect("live dir")
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("restore-failed-")
            })
            .collect();
        assert!(!failed.is_empty(), "failure reason should be recorded");
        let conn = open_db_at(&live).expect("reopen");
        assert!(read_doc(&conn, "b_keep").expect("read").is_some());
        let _ = fs::remove_dir_all(live);
        let _ = fs::remove_dir_all(empty_backup);
    }

    #[test]
    fn asset_scope_rejects_paths_outside_the_assets_folder() {
        let assets = test_root("asset-scope");
        let inside = assets.join("ok.txt");
        fs::write(&inside, b"ok").expect("inside file");
        let outside_root = test_root("asset-outside");
        let outside = outside_root.join("no.txt");
        fs::write(&outside, b"no").expect("outside file");
        let canonical_assets = fs::canonicalize(&assets).expect("canonical assets");

        assert!(canonical_asset_path(&canonical_assets, &inside).is_ok());
        assert!(canonical_asset_path(&canonical_assets, &outside).is_err());
        let _ = fs::remove_dir_all(assets);
        let _ = fs::remove_dir_all(outside_root);
    }

    #[test]
    fn legacy_data_folder_is_migrated_to_the_new_identity() {
        let parent = test_root("legacy-dir");
        let legacy = parent.join(LEGACY_APP_IDENTIFIER);
        fs::create_dir_all(legacy.join("assets")).expect("legacy folders");
        {
            let conn = Connection::open(legacy.join(LEGACY_DB_FILE)).expect("legacy db");
            conn.execute_batch(SCHEMA).expect("legacy schema");
            write_doc(&conn, &sample_doc("b_migrated", "Migrated", 1_700_000_000))
                .expect("legacy board");
        }
        fs::write(legacy.join("assets").join("note.txt"), b"asset").expect("legacy asset");

        let new_root = parent.join("com.dezuhan.khaoyunote");
        migrate_legacy_data_dir(&new_root).expect("migration");

        assert!(new_root.join(DB_FILE).is_file());
        assert!(new_root.join("assets").join("note.txt").is_file());
        assert!(
            !legacy.exists(),
            "legacy folder should be removed after a clean migration"
        );
        let conn = open_db_at(&new_root).expect("open migrated");
        assert!(read_doc(&conn, "b_migrated").expect("read").is_some());
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn deleting_a_cyclic_board_tree_terminates() {
        let root = test_root("board-cycle");
        let conn = open_db_at(&root).expect("open db");
        let mut first = sample_doc("b_cycle_a", "A", 1_700_000_000_000);
        first["parentId"] = json!("b_cycle_b");
        let mut second = sample_doc("b_cycle_b", "B", 1_700_000_000_000);
        second["parentId"] = json!("b_cycle_a");
        write_doc(&conn, &first).expect("first");
        write_doc(&conn, &second).expect("second");

        delete_board_tree(&conn, "b_cycle_a").expect("delete cyclic tree");
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM boards", [], |row| row.get(0))
            .expect("count");
        assert_eq!(remaining, 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn second_sized_timestamps_are_normalized_on_open() {
        let root = test_root("timestamp-normalize");
        {
            let conn = open_db_at(&root).expect("open db");
            write_doc(&conn, &sample_doc("b_seconds", "Seconds", 1_700_000_000)).expect("write");
        }
        let conn = open_db_at(&root).expect("reopen");
        let doc: Value = serde_json::from_str(
            &read_doc(&conn, "b_seconds")
                .expect("read")
                .expect("board exists"),
        )
        .expect("valid json");
        assert_eq!(doc["updatedAt"], 1_700_000_000_000i64);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unique_paths_do_not_overwrite_each_other() {
        let root = test_root("unique-path");
        let first = unique_path(&root, "board-1", Some("json"));
        fs::write(&first, b"{}").expect("first file");
        let second = unique_path(&root, "board-1", Some("json"));
        assert_ne!(first, second);
        assert_eq!(
            second.file_name().and_then(|name| name.to_str()),
            Some("board-1-1.json")
        );
        let directory_first = unique_path(&root, "backup", None);
        fs::create_dir_all(&directory_first).expect("first directory");
        let directory_second = unique_path(&root, "backup", None);
        assert_eq!(
            directory_second.file_name().and_then(|name| name.to_str()),
            Some("backup-1")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn partial_legacy_import_keeps_the_folder_and_retries() {
        let root = test_root("legacy-partial");
        let boards = root.join("boards");
        fs::create_dir_all(&boards).expect("legacy folder");
        fs::write(
            boards.join("good.json"),
            serde_json::to_string(&sample_doc("b_legacy", "Legacy", 1_700_000_000)).expect("json"),
        )
        .expect("good file");
        fs::write(boards.join("broken.json"), b"{ not json").expect("broken file");

        {
            let conn = open_db_at(&root).expect("first open");
            assert!(read_doc(&conn, "b_legacy").expect("read").is_some());
            let flagged: Option<String> = conn
                .query_row(
                    "SELECT value FROM meta WHERE key = 'legacy_json_imported'",
                    [],
                    |row| row.get(0),
                )
                .optional()
                .expect("meta query");
            assert!(
                flagged.is_none(),
                "partial import must not be marked complete"
            );
        }
        assert!(
            boards.is_dir(),
            "broken legacy folder must be kept for a retry"
        );

        fs::remove_file(boards.join("broken.json")).expect("remove broken file");
        {
            let conn = open_db_at(&root).expect("second open");
            let flagged: Option<String> = conn
                .query_row(
                    "SELECT value FROM meta WHERE key = 'legacy_json_imported'",
                    [],
                    |row| row.get(0),
                )
                .optional()
                .expect("meta query");
            assert!(
                flagged.is_some(),
                "clean retry should mark the import complete"
            );
        }
        assert!(
            !boards.exists(),
            "clean folder should be renamed to a backup"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn newer_schema_versions_are_rejected() {
        let root = test_root("schema-newer");
        {
            let conn = open_db_at(&root).expect("open db");
            conn.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?1)",
                params![(CURRENT_SCHEMA_VERSION + 1).to_string()],
            )
            .expect("bump schema version");
        }
        let error = open_db_at(&root).expect_err("newer schema must be rejected");
        assert!(
            error.contains("newer than this app supports"),
            "unexpected error: {error}"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_broken_older_backup_folder_does_not_block_the_primary_archive() {
        let root = test_root("legacy-older-backup");
        let boards = root.join("boards");
        let older = root.join("boards-json-backup-1");
        fs::create_dir_all(&boards).expect("primary folder");
        fs::create_dir_all(&older).expect("older backup folder");
        fs::write(
            boards.join("good.json"),
            serde_json::to_string(&sample_doc("b_primary", "Primary", 1_700_000_000)).expect("json"),
        )
        .expect("good file");
        fs::write(older.join("broken.json"), b"{ not json").expect("broken file");

        let conn = open_db_at(&root).expect("open db");
        assert!(read_doc(&conn, "b_primary").expect("read").is_some());
        assert!(
            !boards.exists(),
            "the clean primary folder must still be archived"
        );
        let _ = fs::remove_dir_all(root);
    }
}
