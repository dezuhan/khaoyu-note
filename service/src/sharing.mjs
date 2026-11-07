import crypto from "node:crypto";
import { hashIp, writeAudit } from "./audit.mjs";
import { hashToken, randomToken } from "./auth/tokens.mjs";

const ROLE_RANK = { viewer: 1, commenter: 2, editor: 3, owner: 4 };

export function hasRole(role, minimum) {
  return Boolean(role) && ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export function projectRole(db, projectId, accountId) {
  return db
    .prepare("SELECT role FROM project_members WHERE project_id = ? AND account_id = ?")
    .get(projectId, accountId)?.role;
}

export function projectSnapshot(db, projectId) {
  const project = db
    .prepare("SELECT id, name, revision, public_sharing_enabled, owner_account_id FROM projects WHERE id = ? AND deleted_at IS NULL")
    .get(projectId);
  if (!project) return null;
  const snapshot = db
    .prepare("SELECT revision, doc FROM project_snapshots WHERE project_id = ?")
    .get(projectId);
  let doc = { cards: [], connections: [], trash: [] };
  if (snapshot?.doc) {
    try {
      doc = JSON.parse(snapshot.doc);
    } catch {
      doc = { cards: [], connections: [], trash: [] };
    }
  }
  return { project, snapshot, doc };
}

function descendants(doc, parentId) {
  const included = new Set();
  const queue = [parentId];
  while (queue.length) {
    const current = queue.shift();
    for (const card of doc.cards || []) {
      if (card.parentId === current && !included.has(card.id)) {
        included.add(card.id);
        queue.push(card.id);
      }
    }
  }
  return included;
}

function stripLocalAssetPaths(card) {
  const copy = { ...card };
  for (const key of ["src", "path", "url", "poster"]) {
    if (typeof copy[key] === "string" && /^(?:[a-zA-Z]:[\\/]|file:|\/)/.test(copy[key])) {
      copy[key] = null;
      copy.assetUnavailable = true;
    }
  }
  return copy;
}

function sanitizedCards(cards) {
  return (cards || []).map(stripLocalAssetPaths);
}

function sanitizedDoc(doc) {
  return {
    id: doc.id,
    title: doc.title,
    cards: sanitizedCards(doc.cards),
    connections: doc.connections || [],
  };
}

function nestedProjectDocs(db, project, depth = 0, seen = new Set()) {
  if (depth >= 5) return { nested: [], excluded: 0 };
  const children = db
    .prepare(
      "SELECT id, name, revision, owner_account_id FROM projects WHERE parent_project_id = ? AND deleted_at IS NULL ORDER BY created_at"
    )
    .all(project.id);
  const nested = [];
  let excluded = 0;
  for (const child of children) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    const members = db
      .prepare("SELECT COUNT(*) AS count, SUM(CASE WHEN account_id != ? THEN 1 ELSE 0 END) AS others FROM project_members WHERE project_id = ?")
      .get(project.owner_account_id, child.id);
    const eligible =
      child.owner_account_id === project.owner_account_id &&
      Number(members.count) === 1 &&
      Number(members.others) === 0;
    if (!eligible) {
      excluded += 1;
      continue;
    }
    const snapshot = db
      .prepare("SELECT doc FROM project_snapshots WHERE project_id = ?")
      .get(child.id);
    let doc;
    try {
      doc = JSON.parse(snapshot?.doc || "{}");
    } catch {
      continue;
    }
    const deeper = nestedProjectDocs(db, child, depth + 1, seen);
    nested.push({
      id: child.id,
      name: child.name,
      revision: child.revision,
      doc: sanitizedDoc(doc),
      nestedProjects: deeper.nested,
    });
    excluded += deeper.excluded;
    if (nested.length >= 20) break;
  }
  return { nested, excluded };
}

export function sharedPayload(db, share) {
  const snapshot = projectSnapshot(db, share.project_id);
  if (!snapshot) return null;
  const { project, doc } = snapshot;
  if (share.scope === "project") {
    const nested = nestedProjectDocs(db, project);
    return {
      scope: "project",
      permission: share.permission,
      project: { id: project.id, name: project.name, revision: project.revision },
      doc: sanitizedDoc(doc),
      nestedProjects: nested.nested,
      excludedNestedProjects: nested.excluded,
      nestedPolicy:
        "Nested boards are included only when they have the same owner and no additional members.",
    };
  }
  if (share.scope === "item") {
    const card = (doc.cards || []).find((entry) => entry.id === share.target_id);
    if (!card) return null;
    return { scope: "item", permission: share.permission, card: stripLocalAssetPaths(card) };
  }
  const column = (doc.cards || []).find((entry) => entry.id === share.target_id && entry.type === "column");
  if (!column) return null;
  const childIds = descendants(doc, column.id);
  const cards = (doc.cards || []).filter((entry) => entry.id === column.id || childIds.has(entry.id));
  const ids = new Set(cards.map((entry) => entry.id));
  const connections = (doc.connections || []).filter(
    (connection) => ids.has(connection.from) && ids.has(connection.to)
  );
  return {
    scope: "column",
    permission: share.permission,
    cards: sanitizedCards(cards),
    connections,
    notice: "Later additions may not be included in this shared snapshot.",
  };
}

export function createInvitation(db, { projectId, email, role, invitedBy, expiresAt }) {
  const token = randomToken(32);
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO project_invitations (id, project_id, email, role, token_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, projectId, email.toLowerCase(), role, hashToken(token), invitedBy, Date.now(), expiresAt);
  return { id, token };
}

export function acceptInvitation(db, { token, account }) {
  const row = db
    .prepare(
      `SELECT * FROM project_invitations
       WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`
    )
    .get(hashToken(token), Date.now());
  if (!row) return null;
  if (String(row.email).toLowerCase() !== String(account.email).toLowerCase()) return null;
  const existing = db
    .prepare("SELECT role FROM project_members WHERE project_id = ? AND account_id = ?")
    .get(row.project_id, account.id);
  if (existing) return { alreadyMember: true, projectId: row.project_id, role: existing.role };
  db.prepare(
    "INSERT INTO project_members (project_id, account_id, role, created_at) VALUES (?, ?, ?, ?)"
  ).run(row.project_id, account.id, row.role, Date.now());
  db.prepare("UPDATE project_invitations SET accepted_at = ? WHERE id = ?").run(Date.now(), row.id);
  return { projectId: row.project_id, role: row.role, invitationId: row.id };
}

const SHARE_RANK = { view: 1, comment: 2, edit: 3, manage: 4 };

export function shareAllows(permission, minimum) {
  return Boolean(permission) && SHARE_RANK[permission] >= SHARE_RANK[minimum];
}

export function cardInShareScope(doc, share, cardId) {
  if (share.scope === "project") {
    return (doc.cards || []).some((card) => card.id === cardId);
  }
  if (share.scope === "item") return cardId === share.target_id;
  if (share.scope === "column") {
    if (cardId === share.target_id) return true;
    return descendants(doc, share.target_id).has(cardId);
  }
  return false;
}

export function createShareLink(db, { projectId, scope, targetId, permission, passwordHash, expiresAt, downloadAllowed, createdBy }) {
  const token = `khn_share_${randomToken(32)}`;
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO share_links
     (id, project_id, scope, target_id, permission, token_hash, password_hash, download_allowed, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    projectId,
    scope,
    targetId,
    permission,
    hashToken(token),
    passwordHash || null,
    downloadAllowed ? 1 : 0,
    createdBy,
    Date.now(),
    expiresAt || null
  );
  return { id, token };
}

export function findShare(db, token) {
  return db
    .prepare("SELECT * FROM share_links WHERE token_hash = ?")
    .get(hashToken(token));
}

export function shareBlocked(db, { shareId, ip, config }) {
  const since = Date.now() - config.loginWindowMinutes * 60_000;
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count FROM share_attempts WHERE share_id = ? AND ip_hash = ? AND success = 0 AND created_at >= ?"
    )
    .get(shareId, hashIp(ip, config.secret) || "unknown", since);
  const count = Number(row.count);
  return count >= config.loginMaxAttempts;
}

export function recordShareAttempt(db, { shareId, ip, success, config }) {
  db.prepare(
    "INSERT INTO share_attempts (share_id, ip_hash, success, created_at) VALUES (?, ?, ?, ?)"
  ).run(shareId, hashIp(ip, config.secret) || "unknown", success ? 1 : 0, Date.now());
}

export function revokeShare(db, projectId, shareId, actorId, config) {
  const result = db
    .prepare("UPDATE share_links SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL")
    .run(Date.now(), shareId, projectId);
  if (!result.changes) return false;
  writeAudit(db, {
    actorAccountId: actorId,
    action: "share.revoked",
    resourceType: "share_link",
    resourceId: shareId,
    secret: config.secret,
  });
  return true;
}

export function rotateShare(db, projectId, shareId, actorId) {
  const token = `khn_share_${randomToken(32)}`;
  const result = db
    .prepare("UPDATE share_links SET token_hash = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL")
    .run(hashToken(token), shareId, projectId);
  if (!result.changes) return null;
  void actorId;
  return token;
}
