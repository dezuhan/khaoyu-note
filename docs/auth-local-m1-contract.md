# Local account M1 contract

This is the shared contract for milestone M1 (local account foundation). Rust, the web host and the
frontend must match it exactly so the desktop app and the web host stay compatible.

## Scope of M1

- Local accounts in the app SQLite database, schema version 2.
- First-run admin setup, mandatory login on desktop and web, logout, profile update, password change,
  logout all, basic account and board activity history.
- Avatar button and account center in the app chrome.
- Service accounts, roles enforcement and the Admin Panel are later milestones and are not part of
  this contract.

## Schema version 2

New tables, created in both Rust (`app/src-tauri/src/lib.rs`) and `server.mjs`:

```sql
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT UNIQUE COLLATE NOCASE,
    first_name TEXT,
    last_name TEXT,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    member_role TEXT NOT NULL DEFAULT 'editor' CHECK (member_role IN ('editor', 'commenter', 'viewer')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    avatar_color TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_hash TEXT,
    host TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS activity_log (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT,
    actor_source TEXT,
    actor_name TEXT,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_actor ON activity_log(actor_user_id, created_at);
CREATE INDEX IF NOT EXISTS activity_created ON activity_log(created_at);
```

Columns added to existing tables:

```sql
ALTER TABLE boards ADD COLUMN created_by TEXT;
ALTER TABLE boards ADD COLUMN updated_by TEXT;
ALTER TABLE cards ADD COLUMN created_by TEXT;
ALTER TABLE cards ADD COLUMN updated_by TEXT;
```

- Author columns hold a JSON snapshot: `{"source":"local","id":"...","name":"..."}`.
- Migration from schema 1 to 2 is idempotent: create tables, add missing columns after checking
  `PRAGMA table_info`, then set `meta.schema_version = 2`.
- Restore accepts schema 1 backups and migrates them to 2.
- Backup includes `users` and `activity_log`. It must NOT include `sessions`.
- The old meta key `require_local_login` is ignored. Accounts are mandatory on both hosts.

## Password hash

Format: `pbkdf2-sha256$600000$<salt_base64url>$<hash_base64url>`

- Salt: 16 random bytes.
- Derived key: 32 bytes.
- PBKDF2-HMAC-SHA256, 600000 iterations.
- Base64 URL safe without padding for both salt and hash.
- Rust uses `ring` (`PBKDF2_HMAC_SHA256`, `ring::pbkdf2::derive` and `verify`).
- Node uses `crypto.pbkdf2Sync(password, salt, 600000, 32, "sha256")`.
- Verification must be constant time.

## Session

- Token: 32 random bytes, base64url without padding. Returned to the app once at login.
- At rest: `sessions.token_hash` is the lowercase hex SHA-256 of the token.
- Desktop lifetime: 30 days. Web host lifetime: 30 days.
- `sessions.host` is `desktop` or `web`.
- Desktop always persists the token in `<app_data>/session.json`, so a restart stays signed in until
  logout.
- Web host uses cookies:
  - `khaoyu_local_session`: HttpOnly, SameSite=Strict, Path=/, Secure when the request is HTTPS.
  - `khaoyu_local_csrf`: readable by JS, SameSite=Strict.
- Authenticated mutating web requests must send `x-khaoyu-csrf` equal to the cookie value.
  Login, setup and logout are exempt.

## Public user object

Camel case, never includes the password hash or token:

```json
{
  "id": "u_...",
  "username": "dezuhan",
  "email": "owner@localhost",
  "firstName": "Dezuhan",
  "lastName": "",
  "displayName": "Dezuhan",
  "role": "admin",
  "memberRole": "editor",
  "status": "active",
  "avatarColor": "#B262C0",
  "createdAt": 1760000000000,
  "updatedAt": 1760000000000,
  "lastLoginAt": 1760000000000
}
```

`displayName` is `first + " " + last` trimmed, falling back to `username`.

## Commands and endpoints

Desktop Rust commands, mirrored by web host endpoints:

| Rust command | Web endpoint | Body | Result |
| --- | --- | --- | --- |
| `auth_status` | `GET /api/auth/status` | none | `{ userCount, requireLogin, guestAllowed, user, csrfToken }` |
| `auth_setup_admin` | `POST /api/auth/setup` | `{ username, email, firstName, lastName, password, claimBoards }` | `{ user, expiresAt }` |
| `auth_login` | `POST /api/auth/login` | `{ identifier, password, remember }` | `{ user, expiresAt }` |
| `auth_logout` | `POST /api/auth/logout` | none | `null` |
| `auth_logout_all` | `POST /api/auth/logout-all` | none | `null` |
| `auth_me` | `GET /api/auth/me` | none | `user` or `null` |
| `auth_update_profile` | `PATCH /api/auth/profile` | `{ firstName, lastName, email, avatarColor }` | `user` |
| `auth_change_password` | `POST /api/auth/password` | `{ currentPassword, newPassword }` | `null` |
| `auth_history` | `GET /api/auth/history?limit=20&offset=0` | none | `{ entries, hasMore }` |

Notes:

- `identifier` is a username or email, compared case-insensitively.
- Desktop `auth_login` also accepts `remember` and writes the session file when true.
- `auth_status.requireLogin` is always true and `guestAllowed` is always false. The fields stay in the
  payload for compatibility.
- All web-host `/api/invoke`, `/api/asset` and `/api/download` requests require a session. The auth
  endpoints and the static app shell stay public so the login screen can load.
- Board writes and board mutations log `board.created`, `board.updated` (throttled per board and user),
  `board.renamed`, `board.archived`, `board.unarchived`, `board.trashed`, `board.restored` and
  `board.deleted` to `activity_log`.
- `auth_setup_admin` is allowed only when `COUNT(users) = 0`; it creates the first account with
  `role = 'admin'`, logs `auth.setup`, and optionally sets `created_by`/`updated_by` on boards and
  cards that have no author yet when `claimBoards` is true.
- Login updates `last_login_at`, logs `auth.login`, and rejects disabled or missing accounts with the
  same generic message: `Invalid username or password`.
- Logout revokes the current session. Logout all revokes every session of the user.
- Password change verifies the current password, updates the hash, revokes other sessions, keeps the
  current one, and logs `auth.password_changed`.
- History returns newest first, 20 default, max 100; `hasMore` is true when more rows exist.
- Activity actions used in M1: `auth.setup`, `auth.login`, `auth.logout`, `auth.logout_all`,
  `auth.password_changed`, `auth.profile_updated`.

Errors are plain messages. The web host returns `{ "error": "message" }`; Rust commands return
`Err(String)`.

## Validation

- Username: 3 to 32 characters, `[A-Za-z0-9._-]`, stored lowercase, unique case-insensitively.
- Email: required for setup, basic `local@domain` shape, stored lowercase, unique case-insensitively.
- Password: 12 to 200 characters.
- First name: required, max 80. Last name: optional, max 80.
- `avatarColor`: optional `#RRGGBB`.
- Duplicate username or email: message starts with `That username is already taken` or
  `That email is already registered`.

## Rate limit and CSRF (web host)

- Setup and login: 5 failures per 15 minutes per identifier plus IP, then 429.
- Failed login does not reveal whether the account exists.
- Mutating requests with a session require the CSRF header.
- All web responses stay same-origin; no permissive CORS.

## Frontend contract

- `app/web/js/bridge.js` adds `authStatus`, `authSetupAdmin`, `authLogin`, `authLogout`,
  `authLogoutAll`, `authMe`, `authUpdateProfile`, `authChangePassword`, `authHistory`. They call the
  Tauri command when `hasTauri`, otherwise the web endpoint with `credentials: "include"` and the
  CSRF header from the readable cookie.
- `app/web/js/auth.js` holds the session state, exposes `initAuth`, `authState`, `subscribeAuth`,
  `setupAdmin`, `login`, `logout`, `logoutAll`, `updateProfile`, `changePassword`, `loadHistory`,
  `refreshAuth`, and permission helpers `isAdmin`, `canEdit`, `canComment`.
- First run: if `auth_status.userCount === 0` and no user, show the setup overlay. It only offers
  creating the local admin. The server option belongs to M4 and can stay as a disabled note.
- If no user exists, the app waits at the setup or login overlay before reading any board or setting.
  There is no guest path and the gate has no Escape or outside-click dismissal.
- After login, `boot()` continues loading settings and boards, so a persisted session opens the app
  directly.
- Avatar: 30 px round button in the topbar right side, after Share. Initials from the first letter of
  the first name or username, soft background derived from a deterministic hash into the theme
  palette, readable text.
- Account center: a Documentation-style modal with a left menu (Admin Dashboard for admins, Account
  Information, Account Settings, History Activity, Log Out) and a content pane. It opens from the
  avatar, closes with Escape, and uses the existing modal layer. `settings.js` Account pane dispatches
  `mn:open-account` instead of importing `account-ui.js`, avoiding a cycle.
- Logout reloads the app so the login gate returns and no board data stays visible. Guest attribution
  no longer exists; every row is written by the signed-in account.

## Write ownership for M1

- Rust and this contract: Lead.
- `server.mjs` and `tools/test-auth-web.mjs`: web-auth teammate.
- Frontend files and `tools/test-ui.mjs`: account-ui teammate.
