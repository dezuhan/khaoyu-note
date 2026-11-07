import crypto from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";

function parseTransports(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function storeChallenge(db, { email, accountId, kind, challenge }) {
  db.prepare("DELETE FROM passkey_challenges WHERE email = ? AND kind = ?").run(email, kind);
  db.prepare(
    "INSERT INTO passkey_challenges (id, challenge, email, account_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(crypto.randomUUID(), challenge, email, accountId || null, kind, Date.now(), Date.now() + 5 * 60_000);
}

function consumeChallenge(db, { email, kind }) {
  const row = db
    .prepare(
      "SELECT * FROM passkey_challenges WHERE email = ? AND kind = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(email, kind, Date.now());
  if (!row) return null;
  db.prepare("DELETE FROM passkey_challenges WHERE id = ?").run(row.id);
  return row;
}

export async function registrationOptions(db, config, account) {
  const credentials = db
    .prepare("SELECT id, transports FROM passkey_credentials WHERE account_id = ?")
    .all(account.id);
  const options = await generateRegistrationOptions({
    rpName: "Khaoyu Note",
    rpID: config.rpId,
    userID: Buffer.from(account.id),
    userName: account.email,
    userDisplayName: account.display_name,
    attestationType: "none",
    excludeCredentials: credentials.map((credential) => ({
      id: credential.id,
      transports: parseTransports(credential.transports),
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });
  storeChallenge(db, {
    email: account.email,
    accountId: account.id,
    kind: "register",
    challenge: options.challenge,
  });
  return options;
}

export async function verifyRegistration(db, config, account, response, name) {
  const challenge = consumeChallenge(db, { email: account.email, kind: "register" });
  if (!challenge) throw new Error("registration challenge expired");
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: config.publicUrl,
    expectedRPID: config.rpId,
    requireUserVerification: false,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("registration verification failed");
  }
  const info = verification.registrationInfo;
  const credential = info.credential;
  db.prepare(
    `INSERT INTO passkey_credentials
     (id, account_id, public_key, counter, transports, device_type, backed_up, name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    credential.id,
    account.id,
    isoBase64URL.fromBuffer(credential.publicKey),
    Number(credential.counter) || 0,
    JSON.stringify(credential.transports || []),
    info.credentialDeviceType || "singleDevice",
    info.credentialBackedUp ? 1 : 0,
    String(name || "Passkey").slice(0, 80),
    Date.now()
  );
  return credential.id;
}

export async function authenticationOptions(db, config, email) {
  const account = db
    .prepare("SELECT * FROM accounts WHERE email = ? AND deleted_at IS NULL")
    .get(email);
  const credentials = account
    ? db
        .prepare("SELECT id, transports FROM passkey_credentials WHERE account_id = ?")
        .all(account.id)
    : [];
  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    allowCredentials: credentials.map((credential) => ({
      id: credential.id,
      transports: parseTransports(credential.transports),
    })),
    userVerification: "preferred",
  });
  storeChallenge(db, {
    email,
    accountId: account?.id || null,
    kind: "login",
    challenge: options.challenge,
  });
  return options;
}

export async function verifyAuthentication(db, config, email, response) {
  const account = db
    .prepare("SELECT * FROM accounts WHERE email = ? AND deleted_at IS NULL")
    .get(email);
  if (!account || typeof response?.id !== "string") throw new Error("passkey authentication failed");
  const stored = db
    .prepare("SELECT * FROM passkey_credentials WHERE id = ? AND account_id = ?")
    .get(response.id, account.id);
  if (!stored) throw new Error("passkey authentication failed");
  const challenge = consumeChallenge(db, { email, kind: "login" });
  if (!challenge) throw new Error("login challenge expired");
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: config.publicUrl,
    expectedRPID: config.rpId,
    credential: {
      id: stored.id,
      publicKey: isoBase64URL.toBuffer(stored.public_key),
      counter: Number(stored.counter),
      transports: parseTransports(stored.transports),
    },
    requireUserVerification: false,
  });
  if (!verification.verified) throw new Error("passkey authentication failed");
  db.prepare("UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE id = ?").run(
    Number(verification.authenticationInfo.newCounter),
    Date.now(),
    stored.id
  );
  return account;
}

export function listPasskeys(db, accountId) {
  return db
    .prepare(
      "SELECT id, name, device_type, backed_up, created_at, last_used_at FROM passkey_credentials WHERE account_id = ? ORDER BY created_at"
    )
    .all(accountId)
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      deviceType: entry.device_type,
      backedUp: Boolean(entry.backed_up),
      createdAt: entry.created_at,
      lastUsedAt: entry.last_used_at,
    }));
}

export function deletePasskey(db, accountId, id) {
  const account = db.prepare("SELECT password_hash FROM accounts WHERE id = ?").get(accountId);
  const count = Number(
    db.prepare("SELECT COUNT(*) AS count FROM passkey_credentials WHERE account_id = ?").get(accountId)
      .count
  );
  if (count <= 1 && !account?.password_hash) {
    throw new Error("add a password or another passkey before removing the last passkey");
  }
  return db
    .prepare("DELETE FROM passkey_credentials WHERE id = ? AND account_id = ?")
    .run(id, accountId).changes;
}
