import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ASSENTOR_DIR } from "../persistence/paths.js";

const ALGO = "aes-256-gcm";

export async function getOrCreateMasterKey(
  projectPath: string,
): Promise<Buffer> {
  const root = path.join(path.resolve(projectPath), ASSENTOR_DIR);
  await fs.mkdir(root, { recursive: true });
  const keyPath = path.join(root, ".master.key");
  try {
    const existing = await fs.readFile(keyPath);
    if (existing.length >= 32) {
      return existing.subarray(0, 32);
    }
  } catch {
    // create
  }
  const key = randomBytes(32);
  await fs.writeFile(keyPath, key, { mode: 0o600 });
  return key;
}

export function encryptSecret(masterKey: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, masterKey, iv);
  const enc = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSecret(masterKey: Buffer, payload: string): string {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv(ALGO, masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}

export function maskSecret(secret: string): string {
  if (secret.length <= 8) {
    return "****";
  }
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

/** Derive a key from passphrase (optional future use). */
export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32);
}
