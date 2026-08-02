import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "./env.js";

// AES-256-GCM. Ciphertext layout: [12-byte IV | 16-byte tag | ciphertext] base64.
// VPS saves use the Supabase service-key hash. Dashboard saves use that same
// key unless KEY_ENCRYPTION_KEY is configured, in which case they are prefixed
// with `key:` and must be decrypted with the explicit key.
function legacyKey(): Buffer | null {
  const raw = env.KEY_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const buf = Buffer.from(raw, "base64");
  return buf.length === 32 ? buf : null;
}

function serviceKey(): Buffer {
  return createHash("sha256").update(env.BOT_SUPABASE_SERVICE_ROLE_KEY).digest();
}

function decryptWith(stored: string, aesKey: Buffer): string {
  const buf = Buffer.from(stored, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", aesKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function encryptPrivateKey(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", serviceKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `svc:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
}

export function decryptPrivateKey(stored: string): string {
  if (stored.startsWith("key:")) {
    const key = legacyKey();
    if (!key) {
      throw new Error(
        "Funding key requires KEY_ENCRYPTION_KEY. Configure the same key on the worker or re-save the Phantom private key.",
      );
    }
    try {
      return decryptWith(stored.slice(4), key);
    } catch {
      throw new Error(
        "Funding key cannot be decrypted with KEY_ENCRYPTION_KEY. Confirm the dashboard and worker use the same key, then re-save it.",
      );
    }
  }
  if (stored.startsWith("svc:")) {
    try {
      return decryptWith(stored.slice(4), serviceKey());
    } catch {
      throw new Error(
        "Funding key cannot be decrypted. Re-save the Phantom private key in the dashboard, then restart the worker.",
      );
    }
  }
  try {
    return decryptWith(stored, serviceKey());
  } catch {
    const legacy = legacyKey();
    if (legacy) {
      try {
        return decryptWith(stored, legacy);
      } catch {
        // Fall through to the clear action message below.
      }
    }
    throw new Error(
      "Funding key cannot be decrypted. On the VPS run: bun run save-key, paste the Phantom private key, then run bun run doctor again.",
    );
  }
}
