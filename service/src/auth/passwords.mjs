import crypto from "node:crypto";
import { argon2id, argon2Verify } from "hash-wasm";

const PARAMS = {
  parallelism: 1,
  iterations: 3,
  memorySize: 65536,
  hashLength: 32,
  outputType: "encoded",
};

export async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 200) {
    throw new Error("password must be between 12 and 200 characters");
  }
  return argon2id({
    password,
    salt: crypto.randomBytes(16),
    ...PARAMS,
  });
}

export async function verifyPassword(password, hash) {
  if (!password || !hash) return false;
  try {
    return await argon2Verify({ password, hash });
  } catch {
    return false;
  }
}
