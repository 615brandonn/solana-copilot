import { PublicKey, type Connection } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

export type OpenPositionBalance = {
  id: string;
  token_mint: string;
};

export type WalletTokenHolding = {
  token_mint: string;
  amount: number;
  decimals: number;
};

export type ObservedFollowerTransferGroup = {
  tokenMint: string;
  wallet: string;
  sourceTargets: string[];
};

export function groupObservedFollowerTransfers(
  transfers: Array<{ token_mint: string; to_wallet: string | null; from_wallet: string | null }>,
  targetWallets: ReadonlySet<string>,
): ObservedFollowerTransferGroup[] {
  const groups = new Map<string, { tokenMint: string; wallet: string; sources: Set<string> }>();
  for (const transfer of transfers) {
    const wallet = transfer.to_wallet ?? "";
    const tokenMint = transfer.token_mint ?? "";
    if (!wallet || !tokenMint || targetWallets.has(wallet)) continue;
    const key = `${tokenMint}:${wallet}`;
    const row = groups.get(key) ?? { tokenMint, wallet, sources: new Set<string>() };
    if (transfer.from_wallet && targetWallets.has(transfer.from_wallet)) {
      row.sources.add(transfer.from_wallet);
    }
    groups.set(key, row);
  }
  return Array.from(groups.values(), (row) => ({
    tokenMint: row.tokenMint,
    wallet: row.wallet,
    sourceTargets: Array.from(row.sources),
  }));
}

export function aggregateWalletTokenHoldings(
  rows: Array<{ mint: string; amount: number; decimals: number }>,
): WalletTokenHolding[] {
  const holdings = new Map<string, WalletTokenHolding>();
  for (const row of rows) {
    if (!row.mint || !Number.isFinite(row.amount) || row.amount <= 0) continue;
    const prior = holdings.get(row.mint);
    holdings.set(row.mint, {
      token_mint: row.mint,
      amount: (prior?.amount ?? 0) + row.amount,
      decimals: row.decimals,
    });
  }
  return Array.from(holdings.values());
}

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
  return new Set(
    (await walletTokenHoldings(connection, ownerAddress)).map((row) => row.token_mint),
  );
}

export async function walletTokenHoldings(
  connection: Connection,
  ownerAddress: string,
): Promise<WalletTokenHolding[]> {
  const owner = new PublicKey(ownerAddress);
  const rows: Array<{ mint: string; amount: number; decimals: number }> = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const accounts = await connection.getParsedTokenAccountsByOwner(
      owner,
      { programId },
      "confirmed",
    );
    for (const account of accounts.value) {
      const info = account.account.data.parsed.info as {
        mint: string;
        tokenAmount: { decimals?: number; uiAmountString?: string };
      };
      const amount = Number(info.tokenAmount.uiAmountString ?? 0);
      rows.push({
        mint: info.mint,
        amount,
        decimals: Number(info.tokenAmount.decimals ?? 0),
      });
    }
  }
  return aggregateWalletTokenHoldings(rows);
}
