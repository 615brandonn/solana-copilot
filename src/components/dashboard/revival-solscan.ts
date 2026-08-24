const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function solscanTokenUrl(tokenMint: string): string | null {
  if (tokenMint.length < 32 || tokenMint.length > 44 || tokenMint.trim() !== tokenMint) {
    return null;
  }

  let value = 0n;
  for (const character of tokenMint) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit === -1) return null;
    value = value * 58n + BigInt(digit);
  }

  let decodedBytes = 0;
  for (let remainder = value; remainder > 0n; remainder >>= 8n) decodedBytes += 1;

  let leadingZeroBytes = 0;
  while (tokenMint[leadingZeroBytes] === "1") leadingZeroBytes += 1;
  if (leadingZeroBytes + decodedBytes !== 32) return null;

  return `https://solscan.io/token/${encodeURIComponent(tokenMint)}`;
}
