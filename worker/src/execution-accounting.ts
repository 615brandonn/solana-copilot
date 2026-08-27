/**
 * Return only the positive balance change attributable to one landed buy.
 * The wallet's pre-existing/manual holdings are deliberately excluded.
 */
export function attributablePositiveBalanceDelta(
  preBalanceUi: number,
  postBalanceUi: number,
): number | undefined {
  if (
    !Number.isFinite(preBalanceUi) ||
    !Number.isFinite(postBalanceUi) ||
    preBalanceUi < 0 ||
    postBalanceUi < 0
  ) {
    return undefined;
  }
  const delta = postBalanceUi - preBalanceUi;
  return Number.isFinite(delta) && delta > 0 ? delta : undefined;
}

type TokenBalanceLike = {
  mint: string;
  owner?: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
  };
};

type TransactionTokenBalancesLike = {
  meta?: {
    preTokenBalances?: readonly TokenBalanceLike[] | null;
    postTokenBalances?: readonly TokenBalanceLike[] | null;
  } | null;
};

export type ConfirmedTokenDebit = {
  amountRaw: string;
  amountUi: number;
  decimals: number;
  preAmountRaw: string;
  postAmountRaw: string;
};

function ownerMintBalanceSums(
  tx: TransactionTokenBalancesLike | undefined,
  owner: string,
  mint: string,
): { preRaw: bigint; postRaw: bigint; decimals: number } | undefined {
  const preBalances = tx?.meta?.preTokenBalances ?? [];
  const postBalances = tx?.meta?.postTokenBalances ?? [];
  const rows = [...preBalances, ...postBalances].filter(
    (balance) => balance.owner === owner && balance.mint === mint,
  );
  if (rows.length === 0) return undefined;
  const decimals = rows[0]?.uiTokenAmount.decimals;
  if (
    !Number.isInteger(decimals) ||
    decimals === undefined ||
    decimals < 0 ||
    decimals > 18 ||
    rows.some((row) => row.uiTokenAmount.decimals !== decimals)
  ) {
    return undefined;
  }
  try {
    const sumRaw = (balances: readonly TokenBalanceLike[]) =>
      balances
        .filter((balance) => balance.owner === owner && balance.mint === mint)
        .reduce((sum, balance) => {
          const raw = balance.uiTokenAmount.amount;
          if (!/^\d+$/.test(raw)) throw new Error("token balance raw amount is malformed");
          return sum + BigInt(raw);
        }, 0n);
    return { preRaw: sumRaw(preBalances), postRaw: sumRaw(postBalances), decimals };
  } catch {
    return undefined;
  }
}

/**
 * Derive the exact positive token receipt belonging to one owner and mint.
 * The raw decimal string is authoritative; the UI number exists only because
 * the legacy positions ledger currently stores numeric token amounts.
 */
export function confirmedTokenReceiptFromTx(
  tx: TransactionTokenBalancesLike | undefined,
  owner: string,
  mint: string,
): { amountRaw: string; amountUi: number; decimals: number } | undefined {
  const balances = ownerMintBalanceSums(tx, owner, mint);
  if (!balances) return undefined;
  try {
    const deltaRaw = balances.postRaw - balances.preRaw;
    if (deltaRaw <= 0n) return undefined;
    const amountUi = Number(deltaRaw) / 10 ** balances.decimals;
    if (!Number.isFinite(amountUi) || amountUi <= 0) return undefined;
    return { amountRaw: deltaRaw.toString(), amountUi, decimals: balances.decimals };
  } catch {
    return undefined;
  }
}

/**
 * Derive the exact token debit made by one landed sell. The transaction's raw
 * owner/mint pre/post balances are the only evidence accepted: a later wallet
 * snapshot can include unrelated transfers and must never repair a sell.
 */
export function confirmedTokenDebitFromTx(
  tx: TransactionTokenBalancesLike | undefined,
  owner: string,
  mint: string,
): ConfirmedTokenDebit | undefined {
  const balances = ownerMintBalanceSums(tx, owner, mint);
  if (!balances) return undefined;
  const deltaRaw = balances.preRaw - balances.postRaw;
  if (deltaRaw <= 0n) return undefined;
  const amountUi = Number(deltaRaw) / 10 ** balances.decimals;
  if (!Number.isFinite(amountUi) || amountUi <= 0) return undefined;
  return {
    amountRaw: deltaRaw.toString(),
    amountUi,
    decimals: balances.decimals,
    preAmountRaw: balances.preRaw.toString(),
    postAmountRaw: balances.postRaw.toString(),
  };
}
