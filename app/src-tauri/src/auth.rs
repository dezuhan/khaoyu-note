// Local accounts for the desktop app: password hashing, sessions, users and activity rows.
//
// Password hashes use PBKDF2-HMAC-SHA256 through `ring`, which is already in the dependency tree.
// The format is shared with the local web host so both hosts can verify the same database.

use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use ring::pbkdf2;
use ring::rand::{SecureRandom, SystemRandom};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};

pub const PBKDF2_ITERATIONS: u32 = 600_000;
pub const DESKTOP_SESSION_DAYS: i64 = 30;

const BASE64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicUser {
    pub id: String,
    pub username: String,
    pub email: String,
    pub first_name: String,
    pub last_name: String,
    pub display_name: String,
    pub role: String,
    pub member_role: String,
    pub status: String,
    pub avatar_color: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_login_at: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct SessionUser {
    pub session_id: String,
    pub user: PublicUser,
}

pub struct SessionInfo {
    pub session_id: String,
    pub token: String,
    pub expires_at: i64,
}

pub struct NewUser<'a> {
    pub username: &'a str,
    pub email: &'a str,
    pub first_name: &'a str,
    pub last_name: &'a str,
    pub password: &'a str,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

fn encode_base64url(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for byte in bytes {
        buffer = (buffer << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            out.push(char::from(BASE64URL[((buffer >> bits) & 0x3f) as usize]));
        }
    }
    if bits > 0 {
        out.push(char::from(
            BASE64URL[((buffer << (6 - bits)) & 0x3f) as usize],
        ));
    }
    out
}

fn decode_base64url(text: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for byte in text.bytes() {
        if byte == b'=' {
            continue;
        }
        let value = match byte {
            b'A'..=b'Z' => u32::from(byte - b'A'),
            b'a'..=b'z' => u32::from(byte - b'a') + 26,
            b'0'..=b'9' => u32::from(byte - b'0') + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return Err("invalid password hash".into()),
        };
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1u32 << bits) - 1;
        }
    }
    Ok(out)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn hash_password(password: &str) -> Result<String, String> {
    let mut salt = [0u8; 16];
    SystemRandom::new()
        .fill(&mut salt)
        .map_err(|_| "could not generate a password salt".to_string())?;
    let mut derived = [0u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        std::num::NonZeroU32::new(PBKDF2_ITERATIONS).ok_or("invalid iteration count")?,
        &salt,
        password.as_bytes(),
        &mut derived,
    );
    Ok(format!(
        "pbkdf2-sha256${PBKDF2_ITERATIONS}${}${}",
        encode_base64url(&salt),
        encode_base64url(&derived)
    ))
}

pub fn verify_password(password: &str, encoded: &str) -> bool {
    let mut parts = encoded.split('$');
    let Some(scheme) = parts.next() else {
        return false;
    };
    let Some(iterations) = parts.next() else {
        return false;
    };
    let Some(salt) = parts.next() else {
        return false;
    };
    let Some(expected) = parts.next() else {
        return false;
    };
    if scheme != "pbkdf2-sha256" || parts.next().is_some() {
        return false;
    }
    let Ok(iterations) = iterations.parse::<u32>() else {
        return false;
    };
    let Some(iterations) = std::num::NonZeroU32::new(iterations) else {
        return false;
    };
    let Ok(salt) = decode_base64url(salt) else {
        return false;
    };
    let Ok(expected) = decode_base64url(expected) else {
        return false;
    };
    pbkdf2::verify(
        pbkdf2::PBKDF2_HMAC_SHA256,
        iterations,
        &salt,
        password.as_bytes(),
        &expected,
    )
    .is_ok()
}

/// A valid hash used when the account does not exist, so the unknown user path costs the same.
pub fn dummy_password_hash() -> &'static str {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| {
        hash_password("khaoyu-note-dummy-password").unwrap_or_else(|_| {
            "pbkdf2-sha256$600000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                .to_string()
        })
    })
}

pub fn random_token(bytes: usize) -> Result<String, String> {
    let mut buffer = vec![0u8; bytes];
    SystemRandom::new()
        .fill(&mut buffer)
        .map_err(|_| "could not generate a session token".to_string())?;
    Ok(encode_base64url(&buffer))
}

pub fn hash_token(token: &str) -> String {
    hex(ring::digest::digest(&ring::digest::SHA256, token.as_bytes()).as_ref())
}

pub fn display_name(first_name: &str, last_name: &str, username: &str) -> String {
    let joined = format!("{} {}", first_name.trim(), last_name.trim());
    let trimmed = joined.trim();
    if trimmed.is_empty() {
        username.to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn validate_username(username: &str) -> Result<(), String> {
    let valid = (3..=32).contains(&username.len())
        && username
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-');
    if valid {
        Ok(())
    } else {
        Err(
            "Username must be 3 to 32 characters using letters, numbers, dots, underscores or hyphens"
                .into(),
        )
    }
}

pub fn validate_email(email: &str) -> Result<(), String> {
    let trimmed = email.trim();
    let Some((local, domain)) = trimmed.split_once('@') else {
        return Err("Enter a valid email address".into());
    };
    if local.is_empty()
        || domain.is_empty()
        || trimmed.chars().any(char::is_whitespace)
        || trimmed.len() > 254
    {
        return Err("Enter a valid email address".into());
    }
    Ok(())
}

pub fn validate_password(password: &str) -> Result<(), String> {
    if password.chars().count() < 12 {
        return Err("Password must be at least 12 characters".into());
    }
    if password.len() > 200 {
        return Err("Password is too long".into());
    }
    Ok(())
}

fn user_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PublicUser> {
    Ok(PublicUser {
        id: row.get(0)?,
        username: row.get(1)?,
        email: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        first_name: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        last_name: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        display_name: row.get(5)?,
        role: row.get(6)?,
        member_role: row.get(7)?,
        status: row.get(8)?,
        avatar_color: row.get::<_, Option<String>>(9)?.unwrap_or_default(),
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        last_login_at: row.get(12)?,
    })
}

const USER_COLUMNS: &str = "id, username, email, first_name, last_name, display_name, role, member_role, status, avatar_color, created_at, updated_at, last_login_at";

pub fn count_users(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
        .map_err(|error| error.to_string())
}

pub fn find_user(conn: &Connection, id: &str) -> Result<Option<PublicUser>, String> {
    conn.query_row(
        &format!("SELECT {USER_COLUMNS} FROM users WHERE id = ?1"),
        params![id],
        user_from_row,
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub fn find_user_by_identifier(
    conn: &Connection,
    identifier: &str,
) -> Result<Option<PublicUser>, String> {
    let value = identifier.trim().to_lowercase();
    if value.is_empty() {
        return Ok(None);
    }
    conn.query_row(
        &format!("SELECT {USER_COLUMNS} FROM users WHERE username = ?1 OR email = ?1 LIMIT 1"),
        params![value],
        user_from_row,
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub fn password_hash_for(conn: &Connection, id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT password_hash FROM users WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub fn insert_user(conn: &Connection, new: &NewUser<'_>, role: &str) -> Result<PublicUser, String> {
    validate_username(new.username)?;
    validate_email(new.email)?;
    validate_password(new.password)?;
    let first_name = new.first_name.trim();
    if first_name.is_empty() || first_name.chars().count() > 80 {
        return Err("First name is required".into());
    }
    if new.last_name.trim().chars().count() > 80 {
        return Err("Last name is too long".into());
    }
    let now = now_ms();
    let id = format!("u_{}", uuid::Uuid::new_v4());
    let password_hash = hash_password(new.password)?;
    let display = display_name(new.first_name, new.last_name, new.username);
    conn.execute(
        "INSERT INTO users (id, username, email, first_name, last_name, display_name, password_hash,
             role, member_role, status, avatar_color, created_at, updated_at, last_login_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'editor', 'active', NULL, ?9, ?9, NULL)",
        params![
            id,
            new.username.to_lowercase(),
            new.email.trim().to_lowercase(),
            new.first_name.trim(),
            new.last_name.trim(),
            display,
            password_hash,
            role,
            now
        ],
    )
    .map_err(|error| {
        let text = error.to_string();
        if text.contains("users.username") {
            "That username is already taken".to_string()
        } else if text.contains("users.email") {
            "That email is already registered".to_string()
        } else {
            text
        }
    })?;
    find_user(conn, &id)?.ok_or_else(|| "could not read the new account".to_string())
}

pub fn create_first_admin(conn: &Connection, new: &NewUser<'_>) -> Result<PublicUser, String> {
    if count_users(conn)? > 0 {
        return Err("This database already has an account".into());
    }
    insert_user(conn, new, "admin")
}

pub fn create_session(
    conn: &Connection,
    user_id: &str,
    host: &str,
    lifetime_days: i64,
) -> Result<SessionInfo, String> {
    let token = random_token(32)?;
    let token_hash = hash_token(&token);
    let session_id = format!("s_{}", uuid::Uuid::new_v4());
    let now = now_ms();
    let expires_at = now + lifetime_days * 86_400_000;
    conn.execute(
        "INSERT INTO sessions (id, user_id, token_hash, csrf_hash, host, created_at, last_seen_at, expires_at, revoked_at)
         VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?5, ?6, NULL)",
        params![session_id, user_id, token_hash, host, now, expires_at],
    )
    .map_err(|error| error.to_string())?;
    Ok(SessionInfo {
        session_id,
        token,
        expires_at,
    })
}

pub fn validate_session(conn: &Connection, token: &str) -> Result<Option<SessionUser>, String> {
    if token.trim().is_empty() {
        return Ok(None);
    }
    let token_hash = hash_token(token);
    let row = conn
        .query_row(
            "SELECT s.id, u.id, u.username, u.email, u.first_name, u.last_name, u.display_name,
                    u.role, u.member_role, u.status, u.avatar_color, u.created_at, u.updated_at,
                    u.last_login_at
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ?1 AND s.revoked_at IS NULL AND s.expires_at > ?2
               AND u.status = 'active'",
            params![token_hash, now_ms()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    PublicUser {
                        id: row.get(1)?,
                        username: row.get(2)?,
                        email: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                        first_name: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                        last_name: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                        display_name: row.get(6)?,
                        role: row.get(7)?,
                        member_role: row.get(8)?,
                        status: row.get(9)?,
                        avatar_color: row.get::<_, Option<String>>(10)?.unwrap_or_default(),
                        created_at: row.get(11)?,
                        updated_at: row.get(12)?,
                        last_login_at: row.get(13)?,
                    },
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((session_id, user)) = row else {
        return Ok(None);
    };
    conn.execute(
        "UPDATE sessions SET last_seen_at = ?1 WHERE id = ?2",
        params![now_ms(), session_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(Some(SessionUser { session_id, user }))
}

pub fn revoke_session(conn: &Connection, session_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE sessions SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
        params![now_ms(), session_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn revoke_all_sessions(
    conn: &Connection,
    user_id: &str,
    except_session_id: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE sessions SET revoked_at = ?1
         WHERE user_id = ?2 AND revoked_at IS NULL AND (?3 IS NULL OR id <> ?3)",
        params![now_ms(), user_id, except_session_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn mark_login(conn: &Connection, user_id: &str) -> Result<(), String> {
    let now = now_ms();
    conn.execute(
        "UPDATE users SET last_login_at = ?1, updated_at = ?1 WHERE id = ?2",
        params![now, user_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn author_value(user: &PublicUser) -> Value {
    json!({ "source": "local", "id": user.id, "name": user.display_name })
}

pub fn log_activity(
    conn: &Connection,
    actor: Option<&PublicUser>,
    action: &str,
    resource_type: Option<&str>,
    resource_id: Option<&str>,
    metadata: Value,
) -> Result<(), String> {
    let (actor_id, actor_name, source) = match actor {
        Some(user) => (
            Some(user.id.as_str()),
            Some(user.display_name.as_str()),
            "local",
        ),
        None => (None, None, "guest"),
    };
    let id = format!("a_{}", uuid::Uuid::new_v4());
    conn.execute(
        "INSERT INTO activity_log (id, actor_user_id, actor_source, actor_name, action,
             resource_type, resource_id, metadata, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            actor_id,
            source,
            actor_name,
            action,
            resource_type,
            resource_id,
            metadata.to_string(),
            now_ms()
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn log_activity_throttled(
    conn: &Connection,
    actor: &PublicUser,
    action: &str,
    resource_type: &str,
    resource_id: &str,
    metadata: Value,
    window_ms: i64,
) -> Result<(), String> {
    if window_ms > 0 {
        let last: Option<i64> = conn
            .query_row(
                "SELECT created_at FROM activity_log
                 WHERE actor_user_id = ?1 AND action = ?2 AND resource_id = ?3
                 ORDER BY created_at DESC LIMIT 1",
                params![actor.id, action, resource_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(last) = last {
            if now_ms() - last < window_ms {
                return Ok(());
            }
        }
    }
    log_activity(
        conn,
        Some(actor),
        action,
        Some(resource_type),
        Some(resource_id),
        metadata,
    )
}

pub fn claim_unattributed(conn: &Connection, user: &PublicUser) -> Result<(), String> {
    let author = author_value(user).to_string();
    for statement in [
        "UPDATE boards SET created_by = ?1 WHERE created_by IS NULL",
        "UPDATE boards SET updated_by = ?1 WHERE updated_by IS NULL",
        "UPDATE cards SET created_by = ?1 WHERE created_by IS NULL",
        "UPDATE cards SET updated_by = ?1 WHERE updated_by IS NULL",
    ] {
        conn.execute(statement, params![author])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[allow(dead_code)]
pub fn set_require_login(conn: &Connection, required: bool) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('require_local_login', ?1)",
        params![if required { "true" } else { "false" }],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[allow(dead_code)]
pub fn require_login(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT value FROM meta WHERE key = 'require_local_login'",
        [],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .map(|value| value == "true")
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pbkdf2_hashes_round_trip() {
        let hash = hash_password("correct horse battery staple").expect("hash");
        let parts: Vec<&str> = hash.split('$').collect();
        assert_eq!(parts.len(), 4);
        assert_eq!(parts[0], "pbkdf2-sha256");
        assert_eq!(parts[1], "600000");
        assert!(verify_password("correct horse battery staple", &hash));
        assert!(!verify_password("wrong password", &hash));
        assert!(!verify_password("correct horse battery staple", "broken"));
    }

    #[test]
    fn verifies_a_hash_made_by_the_web_host() {
        // Generated by the Node web host with PBKDF2-HMAC-SHA256, 600000 iterations, salt
        // "0123456789abcdef" and the password "interop-password".
        let hash = "pbkdf2-sha256$600000$MDEyMzQ1Njc4OWFiY2RlZg$C3SHdj4m2TmZIdRosL4vXhfHjj099N7MNnazuPbhSSo";
        assert!(verify_password("interop-password", hash));
        assert!(!verify_password("wrong-password", hash));
    }

    #[test]
    fn tokens_are_url_safe_and_hashed() {
        let token = random_token(32).expect("token");
        assert!(!token.contains(['+', '/', '=']));
        let hash = hash_token(&token);
        assert_eq!(hash.len(), 64);
        assert_ne!(hash, token);
    }
}
