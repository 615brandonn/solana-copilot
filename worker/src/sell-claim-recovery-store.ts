import type { SupabaseClient } from "@supabase/supabase-js";

const TABLE = "sell_signal_claims";
const MAX_UNRESOLVED = 1_000;
const RAW = /^[0-9]+$/;

export type SellClaimStatus =
  | "claimed"
  | "submitted"
  | "uncertain"
  | "landed"
  | "failed_pre_submit";

export type SellRecoveryClaim = {
  id: string;
  userId: string;
  positionId: string;
  status: SellClaimStatus;
  botTxSig: string | null;
  recoveryVersion: number | null;
  tokenDecimals: number | null;
  executedSellAmountRaw: string | null;
  preparedWalletBalanceRaw: string | null;
  positionAmountBeforeRaw: string | null;
  recentBlockhash: string | null;
  lastValidBlockHeight: string | null;
  receiptPreAmountRaw: string | null;
  receiptPostAmountRaw: string | null;
  tradeId: string | null;
  submissionStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PreparedSellAttempt = {
  txSig: string;
  recentBlockhash: string;
  lastValidBlockHeight?: number;
  executedSellAmountRaw: string;
  preparedWalletBalanceRaw: string;
  positionAmountBeforeRaw: string;
  tokenDecimals: number;
};

export type ExactSellReceipt = {
  amountRaw: string;
  preAmountRaw: string;
  postAmountRaw: string;
  decimals: number;
};

export type SellApplyResult = {
  applied: boolean;
  replay: boolean;
  reason: string;
  closed: boolean | null;
  amountRemaining: string | null;
  tradeId: string | null;
};

type StoreClient = Pick<SupabaseClient, "rpc" | "from">;

const claimFields = [
  "id",
  "user_id",
  "position_id",
  "status",
  "bot_tx_sig",
  "recovery_version",
  "token_decimals",
  "executed_sell_amount_raw::text",
  "prepared_wallet_balance_raw::text",
  "position_amount_before_raw::text",
  "recent_blockhash",
  "last_valid_block_height::text",
  "receipt_pre_amount_raw::text",
  "receipt_post_amount_raw::text",
  "trade_id",
  "submission_started_at",
  "created_at",
  "updated_at",
].join(",");

function row(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned a malformed payload`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is malformed`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, label);
}

function exactRaw(value: string | bigint, label: string, allowZero = false): string {
  const exact = typeof value === "bigint" ? value.toString() : String(value).trim();
  if (!RAW.test(exact) || exact.length > 78 || (!allowZero && BigInt(exact) <= 0n)) {
    throw new Error(`${label} must be an exact ${allowZero ? "unsigned" : "positive"} raw integer`);
  }
  return BigInt(exact).toString();
}

function decimals(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 18) {
    throw new Error(`${label} is outside 0..18`);
  }
  return parsed;
}

function nullableInteger(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${label} is malformed`);
  return parsed;
}

function key(source: Record<string, unknown>, camel: string, snake: string): unknown {
  return source[camel] ?? source[snake];
}

export function parseSellRecoveryClaim(value: unknown): SellRecoveryClaim {
  const source = row(value, "sell recovery claim");
  const status = requiredString(key(source, "status", "status"), "claim status") as SellClaimStatus;
  if (!["claimed", "submitted", "uncertain", "landed", "failed_pre_submit"].includes(status)) {
    throw new Error("sell recovery claim has an unknown status");
  }
  const createdAt = requiredString(key(source, "createdAt", "created_at"), "claim createdAt");
  const updatedAt = requiredString(key(source, "updatedAt", "updated_at"), "claim updatedAt");
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) {
    throw new Error("sell recovery claim has an invalid timestamp");
  }
  const rawOrNull = (camel: string, snake: string, allowZero = false) => {
    const value = key(source, camel, snake);
    return value === null || value === undefined
      ? null
      : exactRaw(String(value), `claim ${camel}`, allowZero);
  };
  return {
    id: requiredString(key(source, "id", "id"), "claim id"),
    userId: requiredString(key(source, "userId", "user_id"), "claim userId"),
    positionId: requiredString(key(source, "positionId", "position_id"), "claim positionId"),
    status,
    botTxSig: nullableString(key(source, "botTxSig", "bot_tx_sig"), "claim botTxSig"),
    recoveryVersion: nullableInteger(
      key(source, "recoveryVersion", "recovery_version"),
      "claim recoveryVersion",
    ),
    tokenDecimals:
      key(source, "tokenDecimals", "token_decimals") == null
        ? null
        : decimals(key(source, "tokenDecimals", "token_decimals"), "claim tokenDecimals"),
    executedSellAmountRaw: rawOrNull("executedSellAmountRaw", "executed_sell_amount_raw"),
    preparedWalletBalanceRaw: rawOrNull("preparedWalletBalanceRaw", "prepared_wallet_balance_raw"),
    positionAmountBeforeRaw: rawOrNull("positionAmountBeforeRaw", "position_amount_before_raw"),
    recentBlockhash: nullableString(
      key(source, "recentBlockhash", "recent_blockhash"),
      "claim recentBlockhash",
    ),
    lastValidBlockHeight: rawOrNull("lastValidBlockHeight", "last_valid_block_height"),
    receiptPreAmountRaw: rawOrNull("receiptPreAmountRaw", "receipt_pre_amount_raw"),
    receiptPostAmountRaw: rawOrNull("receiptPostAmountRaw", "receipt_post_amount_raw", true),
    tradeId: nullableString(key(source, "tradeId", "trade_id"), "claim tradeId"),
    submissionStartedAt: nullableString(
      key(source, "submissionStartedAt", "submission_started_at"),
      "claim submissionStartedAt",
    ),
    createdAt,
    updatedAt,
  };
}

export function parseSellApplyResult(value: unknown): SellApplyResult {
  const source = row(value, "sell apply result");
  if (typeof source.applied !== "boolean" || typeof source.replay !== "boolean") {
    throw new Error("sell apply result has malformed lifecycle flags");
  }
  return {
    applied: source.applied,
    replay: source.replay,
    reason: requiredString(source.reason, "sell apply reason"),
    closed: source.closed === null || source.closed === undefined ? null : Boolean(source.closed),
    amountRemaining:
      source.amountRemaining === null || source.amountRemaining === undefined
        ? null
        : String(source.amountRemaining),
    tradeId:
      source.tradeId === null || source.tradeId === undefined ? null : String(source.tradeId),
  };
}

export class SellClaimRecoveryStore {
  constructor(
    private readonly client: StoreClient,
    private readonly userId: string,
  ) {
    requiredString(userId, "sell recovery userId");
  }

  async prepare(claimId: string, attempt: PreparedSellAttempt): Promise<void> {
    const txSig = requiredString(attempt.txSig, "prepared sell signature");
    const blockhash = requiredString(attempt.recentBlockhash, "prepared sell blockhash");
    const soldRaw = exactRaw(attempt.executedSellAmountRaw, "prepared sell amount");
    const walletRaw = exactRaw(attempt.preparedWalletBalanceRaw, "prepared wallet balance");
    const positionRaw = exactRaw(attempt.positionAmountBeforeRaw, "prepared position balance");
    const tokenDecimals = decimals(attempt.tokenDecimals, "prepared sell decimals");
    const lastHeight =
      attempt.lastValidBlockHeight === undefined
        ? null
        : Number(exactRaw(BigInt(attempt.lastValidBlockHeight), "prepared last valid height"));
    if (BigInt(soldRaw) > BigInt(walletRaw))
      throw new Error("prepared sell exceeds wallet balance");
    if (BigInt(soldRaw) > BigInt(positionRaw)) {
      throw new Error("prepared sell exceeds position balance");
    }
    const response = await this.client.rpc("prepare_sell_claim_attempt_v1", {
      p_user_id: this.userId,
      p_claim_id: requiredString(claimId, "prepared sell claimId"),
      p_bot_tx_sig: txSig,
      p_recent_blockhash: blockhash,
      p_last_valid_block_height: lastHeight,
      p_executed_sell_amount_raw: soldRaw,
      p_prepared_wallet_balance_raw: walletRaw,
      p_position_amount_before_raw: positionRaw,
      p_token_decimals: tokenDecimals,
    });
    if (response.error) throw new Error(`prepare sell claim failed: ${response.error.message}`);
    const result = row(response.data, "prepare sell claim");
    if (result.prepared !== true || result.reason !== "attempt_prepared") {
      throw new Error(`prepare sell claim rejected: ${String(result.reason ?? "unknown")}`);
    }
  }

  async authorize(claimId: string, txSig: string): Promise<boolean> {
    const { data, error } = await this.client
      .from(TABLE)
      .select("id")
      .eq("id", requiredString(claimId, "authorized sell claimId"))
      .eq("user_id", this.userId)
      .eq("status", "submitted")
      .eq("recovery_version", 1)
      .eq("bot_tx_sig", requiredString(txSig, "authorized sell signature"))
      .maybeSingle();
    if (error) throw new Error(`authorize sell claim failed: ${error.message}`);
    return Boolean(data);
  }

  async apply(
    claimId: string,
    txSig: string,
    receipt: ExactSellReceipt,
    route: "jito" | "rpc" | null,
    latencyMs: number | null,
    exitPriceUsd: number | null,
  ): Promise<SellApplyResult> {
    const soldRaw = exactRaw(receipt.amountRaw, "sell receipt amount");
    const preRaw = exactRaw(receipt.preAmountRaw, "sell receipt pre balance");
    const postRaw = exactRaw(receipt.postAmountRaw, "sell receipt post balance", true);
    if (BigInt(preRaw) - BigInt(postRaw) !== BigInt(soldRaw)) {
      throw new Error("sell receipt pre/post delta does not match its amount");
    }
    const response = await this.client.rpc("apply_landed_sell_claim_v1", {
      p_user_id: this.userId,
      p_claim_id: requiredString(claimId, "sell apply claimId"),
      p_bot_tx_sig: requiredString(txSig, "sell apply signature"),
      p_sold_amount_raw: soldRaw,
      p_receipt_pre_amount_raw: preRaw,
      p_receipt_post_amount_raw: postRaw,
      p_token_decimals: decimals(receipt.decimals, "sell receipt decimals"),
      p_route: route,
      p_latency_ms: latencyMs,
      p_exit_price_usd: exitPriceUsd,
    });
    if (response.error) throw new Error(`apply sell claim failed: ${response.error.message}`);
    const result = parseSellApplyResult(response.data);
    if (!result.applied && !result.replay) {
      throw new Error(`apply sell claim rejected: ${result.reason}`);
    }
    if (result.amountRemaining === null || result.tradeId === null || result.closed === null) {
      throw new Error("apply sell claim returned incomplete persistence evidence");
    }
    return result;
  }

  async loadUnresolved(): Promise<SellRecoveryClaim[]> {
    const response = await this.client
      .from(TABLE)
      .select(claimFields)
      .eq("user_id", this.userId)
      .in("status", ["claimed", "submitted", "uncertain"])
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(MAX_UNRESOLVED + 1);
    if (response.error)
      throw new Error(`load unresolved sell claims failed: ${response.error.message}`);
    if (!Array.isArray(response.data)) throw new Error("unresolved sell claims are malformed");
    if (response.data.length > MAX_UNRESOLVED) {
      throw new Error("unresolved sell claims exceed the safe recovery bound");
    }
    return response.data.map((value) => {
      const claim = parseSellRecoveryClaim(value);
      if (claim.userId !== this.userId) throw new Error("sell recovery claim user mismatch");
      return claim;
    });
  }

  async markFailure(claim: SellRecoveryClaim, errorCode: string): Promise<boolean> {
    const payload: Record<string, unknown> = {
      status: "failed_pre_submit",
      error_code: requiredString(errorCode, "sell recovery failure code"),
      updated_at: new Date().toISOString(),
    };
    let query = this.client
      .from(TABLE)
      .update(payload)
      .eq("id", claim.id)
      .eq("user_id", this.userId)
      .eq("status", claim.status);
    query = claim.botTxSig
      ? query.eq("bot_tx_sig", claim.botTxSig)
      : query.is("bot_tx_sig", null).is("recovery_version", null);
    const { data, error } = await query.select("id").maybeSingle();
    if (error) throw new Error(`mark sell failure failed: ${error.message}`);
    return Boolean(data);
  }

  async markPreSubmitFailure(
    claimId: string,
    txSig: string | null,
    errorCode: string,
  ): Promise<boolean> {
    const payload = {
      status: "failed_pre_submit",
      error_code: requiredString(errorCode, "sell pre-submit failure code"),
      recovery_version: null,
      bot_tx_sig: null,
      token_decimals: null,
      executed_sell_amount_raw: null,
      prepared_wallet_balance_raw: null,
      position_amount_before_raw: null,
      recent_blockhash: null,
      last_valid_block_height: null,
      receipt_pre_amount_raw: null,
      receipt_post_amount_raw: null,
      trade_id: null,
      execution_route: null,
      execution_latency_ms: null,
      submission_started_at: null,
      landed_at: null,
      persisted_at: null,
      updated_at: new Date().toISOString(),
    };
    let query = this.client
      .from(TABLE)
      .update(payload)
      .eq("id", requiredString(claimId, "sell pre-submit claimId"))
      .eq("user_id", this.userId);
    query = txSig
      ? query
          .eq("status", "submitted")
          .eq("recovery_version", 1)
          .eq("bot_tx_sig", requiredString(txSig, "sell pre-submit signature"))
      : query.eq("status", "claimed").is("recovery_version", null).is("bot_tx_sig", null);
    const { data, error } = await query.select("id").maybeSingle();
    if (error) throw new Error(`mark sell pre-submit failure failed: ${error.message}`);
    return Boolean(data);
  }

  async markUncertain(claimId: string, txSig: string, errorCode: string): Promise<boolean> {
    const { data, error } = await this.client
      .from(TABLE)
      .update({
        status: "uncertain",
        error_code: requiredString(errorCode, "sell uncertainty code"),
        updated_at: new Date().toISOString(),
      })
      .eq("id", claimId)
      .eq("user_id", this.userId)
      .eq("status", "submitted")
      .eq("recovery_version", 1)
      .eq("bot_tx_sig", txSig)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(`mark sell uncertain failed: ${error.message}`);
    return Boolean(data);
  }
}
