import crypto from "node:crypto";

export function hashIp(ip, secret) {
  if (!ip) return null;
  return crypto.createHmac("sha256", secret).update(String(ip)).digest("hex");
}

export async function writeAudit(
  db,
  { actorAccountId = null, action, resourceType, resourceId = null, ip = null, metadata = null, secret }
) {
  if (!action || !resourceType) throw new Error("audit action and resource type are required");
  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO audit_log
     (id, actor_account_id, action, resource_type, resource_id, ip_hash, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      actorAccountId,
      action,
      resourceType,
      resourceId,
      hashIp(ip, secret),
      metadata ? JSON.stringify(metadata) : null,
      Date.now(),
    ]
  );
  return id;
}
