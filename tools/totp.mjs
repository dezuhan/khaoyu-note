// Standalone RFC 6238 TOTP helper for browser tests. It duplicates the small algorithm on purpose:
// integration tests must not import service internals (see plan Phase 0). RFC 6238 vectors are
// asserted in tools/test-contracts.mjs.
import crypto from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(value) {
  const clean = String(value || "").replace(/=+$/g, "").toUpperCase();
  let bits = 0;
  let buffer = 0;
  const bytes = [];
  for (const character of clean) {
    const index = ALPHABET.indexOf(character);
    if (index < 0) throw new Error("invalid base32 secret");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotp(secret, timeMs = Date.now(), digits = 6, stepSeconds = 30) {
  const counter = Math.floor(timeMs / 1000 / stepSeconds);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(value % 10 ** digits).padStart(digits, "0");
}
