// Minimal base58 utilities for Solana public keys.
// No external dependencies; safe for both browser and server bundles.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALPHABET_MAP: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) ALPHABET_MAP[ALPHABET[i]] = i;

export function decodeBase58(input: string): Uint8Array {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("Empty base58 string");
  }
  const bytes: number[] = [0];
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    const value = ALPHABET_MAP[c];
    if (value === undefined) {
      throw new Error(`Invalid base58 character "${c}"`);
    }
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Leading zeros
  for (let i = 0; i < input.length && input[i] === "1"; i++) {
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

export function isSolanaPublicKey(value: string): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length < 32 || v.length > 44) return false;
  try {
    return decodeBase58(v).length === 32;
  } catch {
    return false;
  }
}
