import { PublicKey, type Connection } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

export type OpenPositionBalance = {
  id: string;
  token_mint: string;
};

/**
 * Requires the same position to be absent from two successful wallet snapshots
 * before allowing it to be closed. A positive balance or a failed snapshot
 * must not be treated as proof that a position is flat.
 */
export class ZeroBalanceConfirmationTracker {
  private misses = new Map<string, number>();

  observe(positions: OpenPositionBalance[], positiveMints: ReadonlySet<string>): string[] {
    const openIds = new Set(positions.map((position) => position.id));
    for (const id of this.misses.keys()) {
      if (!openIds.has(id)) this.misses.delete(id);
    }

    const confirmed: string[] = [];
    for (const position of positions) {
      if (positiveMints.has(position.token_mint)) {
        this.misses.delete(position.id);
        continue;
      }
      const count = (this.misses.get(position.id) ?? 0) + 1;
      this.misses.set(position.id, count);
      if (count >= 2) confirmed.push(position.id);
    }
    return confirmed;
  }
}

export async function positiveTokenMints(
  connection: Connection,
  ownerAddress: string,
): Promise<Set<string>> {
  const owner = new PublicKey(ownerAddress);
  const positive = new Set<string>();
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const accounts = await connection.getParsedTokenAccountsByOwner(owner, { programId }, "confirmed");
    for (const account of accounts.value) {
      const info = account.account.data.parsed.info as {
        mint: string;
        tokenAmount: { uiAmountString?: string };
      };
      if (Number(info.tokenAmount.uiAmountString ?? 0) > 0) positive.add(info.mint);
    }
  }
  return positive;
}
