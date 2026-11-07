import crypto from "node:crypto";

export const UNSUBSCRIBE_TOKEN_TTL_MS = 30 * 86_400_000;

function unsubscribeSignature(accountId, issuedAt, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(`unsubscribe:${accountId}:${issuedAt}`)
    .digest("hex");
}

export function unsubscribeToken(accountId, secret, issuedAt = Date.now()) {
  return `${accountId}.${issuedAt}.${unsubscribeSignature(accountId, issuedAt, secret)}`;
}

export function verifyUnsubscribeToken(token, secret, ttlMs = UNSUBSCRIBE_TOKEN_TTL_MS) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [accountId, issuedAtText, signature] = parts;
  const issuedAt = Number(issuedAtText);
  if (!accountId || !Number.isSafeInteger(issuedAt) || issuedAt <= 0) return null;
  const expected = unsubscribeSignature(accountId, issuedAt, secret);
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const now = Date.now();
  if (issuedAt > now + 300_000 || now - issuedAt > ttlMs) return null;
  return accountId;
}

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
  const recipients = [];
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
    recipients.push(member.account_id);
  }
  return recipients;
}

export function notifyProjectOwners(db, projectId, { except, kind, title, body, resourceType = "project", resourceId = projectId }) {
  const owners = db
    .prepare("SELECT account_id FROM project_members WHERE project_id = ? AND role = 'owner'")
    .all(projectId);
  const recipients = [];
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
    recipients.push(owner.account_id);
  }
  return recipients;
}

export function removeResourceNotifications(db, resourceType, resourceId) {
  return db
    .prepare("DELETE FROM notifications WHERE resource_type = ? AND resource_id = ?")
    .run(resourceType, resourceId).changes;
}

export async function emailNotification(db, config, mailer, logger, accountId, { kind, title, body }) {
  const account = db
    .prepare("SELECT email FROM accounts WHERE id = ? AND deleted_at IS NULL")
    .get(accountId);
  const preference = db
    .prepare("SELECT * FROM email_preferences WHERE account_id = ?")
    .get(accountId);
  if (!account || !preference?.notifications) return false;
  if (preference.last_notified_at && Date.now() - Number(preference.last_notified_at) < 5 * 60_000) {
    return false;
  }
  const link = `${config.publicUrl}/api/v1/email/unsubscribe?token=${encodeURIComponent(
    unsubscribeToken(accountId, config.secret)
  )}`;
  try {
    await mailer.send({
      to: account.email,
      kind: "notification",
      subject: title,
      text: `${body || title}\n\nUnsubscribe from email notifications: ${link}`,
    });
  } catch (error) {
    logger?.error("mail.notification_failed", { message: error.message });
    return false;
  }
  db.prepare("UPDATE email_preferences SET last_notified_at = ?, updated_at = ? WHERE account_id = ?").run(
    Date.now(),
    Date.now(),
    accountId
  );
  return true;
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
