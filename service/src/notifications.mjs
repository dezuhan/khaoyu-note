import crypto from "node:crypto";

export function createNotification(db, { accountId, kind, title, body, resourceType, resourceId }) {
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO notifications (id, account_id, kind, title, body, resource_type, resource_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, accountId, kind, title, body || null, resourceType, resourceId, Date.now());
  return id;
}

export function notifyProjectMembers(db, projectId, { except, kind, title, body, resourceType = "project", resourceId = projectId }) {
  const members = db
    .prepare("SELECT account_id FROM project_members WHERE project_id = ?")
    .all(projectId);
  for (const member of members) {
    if (member.account_id === except) continue;
    createNotification(db, {
      accountId: member.account_id,
      kind,
      title,
      body,
      resourceType,
      resourceId,
    });
  }
}

export function notifyProjectOwners(db, projectId, { except, kind, title, body, resourceType = "project", resourceId = projectId }) {
  const owners = db
    .prepare("SELECT account_id FROM project_members WHERE project_id = ? AND role = 'owner'")
    .all(projectId);
  for (const owner of owners) {
    if (owner.account_id === except) continue;
    createNotification(db, {
      accountId: owner.account_id,
      kind,
      title,
      body,
      resourceType,
      resourceId,
    });
  }
}

export function removeResourceNotifications(db, resourceType, resourceId) {
  return db
    .prepare("DELETE FROM notifications WHERE resource_type = ? AND resource_id = ?")
    .run(resourceType, resourceId).changes;
}

export function listNotifications(db, { accountId, limit = 100 }) {
  return db
    .prepare(
      `SELECT n.id, n.kind, n.title, n.body, n.resource_type, n.resource_id, n.created_at, n.read_at
       FROM notifications n
       WHERE n.account_id = ?
         AND (
           n.resource_type = 'account'
           OR (n.resource_type = 'project' AND EXISTS (
             SELECT 1 FROM project_members m WHERE m.project_id = n.resource_id AND m.account_id = n.account_id
           ))
           OR (n.resource_type = 'share_link' AND EXISTS (
             SELECT 1 FROM share_links s
             JOIN project_members m ON m.project_id = s.project_id
             WHERE s.id = n.resource_id AND m.account_id = n.account_id
           ))
         )
       ORDER BY n.created_at DESC LIMIT ?`
    )
    .all(accountId, limit);
}
