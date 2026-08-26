import type { SupabaseClient } from "@supabase/supabase-js";

const CLAIM_TABLE = "supply_accumulation_scale_claims";
const MAX_UNRESOLVED_CLAIMS = 1_000;

export const SUPPLY_SCALE_UNRESOLVED_STATUSES = [
  "claimed",
  "submitted",
  "landed",
  "uncertain",
] as const;

export type SupplyScaleClaimStatus =
  | (typeof SUPPLY_SCALE_UNRESOLVED_STATUSES)[number]
  | "persisted"
  | "failed_pre_submit";

export type SupplyScalePlan = {
  ok: boolean;
  eligible: boolean;
  reason: string;
  userId: string | null;
  tokenMint: string | null;
  positionId: string | null;
  sourceEventKey: string | null;
  claimId: string | null;
  tierNumber: number | null;
  thresholdPct: number | null;
  buyUsd: number | null;
  configFingerprint: string | null;
  sourceTxSig: string | null;
  sourceWallet: string | null;
  sourceSlot: string | null;
  tokenDecimals: number | null;
  netSupplyPct: number | null;
  marketCapUsd: number | null;
  minMarketCapUsd: number | null;
  maxMarketCapUsd: number | null;
};

export type SupplyScaleClaim = {
  id: string;
  userId: string;
  tokenMint: string;
  positionId: string;
  tierNumber: number;
  status: SupplyScaleClaimStatus;
  sourceEventKey: string;
  sourceTxSig: string;
  sourceWallet: string;
  sourceSlot: string;
  tokenDecimals: number;
  thresholdPct: number;
  plannedBuyUsd: number;
  amountLamports: string;
  configFingerprint: string;
  botTxSig: string | null;
  lastValidBlockHeight: string | null;
  receivedAmountRaw: string | null;
  tradeId: string | null;
  errorCode: string | null;
  submissionStartedAt: string | null;
  landedAt: string | null;
  persistedAt: string | null;
  appliedAt: string | null;
  postApplyRepairedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SupplyScaleClaimResult = {
  claimed: boolean;
  replay: boolean;
  reason: string;
  claim: SupplyScaleClaim | null;
};

export type SupplyScaleApplyResult = {
  applied: boolean;
  replay: boolean;
  reason: string;
  claimId: string | null;
  positionId: string | null;
  tierNumber: number | null;
  tradeId: string | null;
  amountTokens: string | null;
  amountRemaining: string | null;
  entryPriceUsd: string | null;
};

export type SupplyScalePreparedAttempt = {
  botTxSig: string;
  lastValidBlockHeight: string;
  submissionStartedAt: string;
};

export type SupplyScaleFailure =
  | {
      status: "failed_pre_submit";
      expectedStatus: "claimed";
      errorCode: string;
      attempt?: never;
    }
  | {
      status: "failed_pre_submit";
      expectedStatus: "submitted" | "uncertain";
      errorCode: string;
      attempt: SupplyScalePreparedAttempt;
    }
  | {
      status: "uncertain";
      expectedStatus: "submitted" | "landed";
      errorCode: string;
      attempt: SupplyScalePreparedAttempt;
    };

type StoreClient = Pick<SupabaseClient, "rpc" | "from">;
type DatabaseError = { message?: string; code?: string };

const claimFields = [
  "id",
  "user_id",
  "token_mint",
  "position_id",
  "tier_number",
  "status",
  "source_event_key",
  "source_tx_sig",
  "source_wallet",
  // PostgREST otherwise serializes bigint/numeric as JSON numbers. Cast every
  // exact integer to text before supabase-js/JSON.parse can lose precision.
  "source_slot::text",
  "token_decimals",
  "threshold_pct",
  "planned_buy_usd",
  "amount_lamports::text",
  "config_fingerprint",
  "bot_tx_sig",
  "last_valid_block_height::text",
  "received_amount_raw::text",
  "trade_id",
  "error_code",
  "submission_started_at",
  "landed_at",
  "persisted_at",
  "applied_at",
  "post_apply_repaired_at",
  "created_at",
  "updated_at",
].join(",");

export class SupplyScaleStoreError extends Error {
  readonly code: string | undefined;
  readonly safePreSubmitBlock: boolean;

  constructor(label: string, error: DatabaseError) {
    const code = typeof error.code === "string" ? error.code : undefined;
    super(`${label}: ${typeof error.message === "string" ? error.message : "database error"}`);
    this.name = "SupplyScaleStoreError";
    this.code = code;
    this.safePreSubmitBlock = code === "55000" || code === "23514";
  }
}

export function isSupplyScalePreSubmitGuardError(error: unknown): boolean {
  return error instanceof SupplyScaleStoreError && error.safePreSubmitBlock;
}

function objectRow(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned a malformed payload`);
  }
  return value as Record<string, unknown>;
}

function requiredBoolean(row: Record<string, unknown>, key: string, label: string): boolean {
  if (typeof row[key] !== "boolean") throw new Error(`${label} contains malformed ${key}`);
  return row[key];
}

function requiredString(row: Record<string, unknown>, key: string, label: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} contains malformed ${key}`);
  }
  return value;
}

function nullableString(value: unknown, key: string, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} contains malformed ${key}`);
  }
  return value;
}

function requiredNumber(row: Record<string, unknown>, key: string, label: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} contains malformed ${key}`);
  }
  return value;
}

function nullableNumber(value: unknown, key: string, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} contains malformed ${key}`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  key: string,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} contains malformed ${key}`);
  }
  return Number(value);
}

function nullableBoundedInteger(
  value: unknown,
  key: string,
  label: string,
  minimum: number,
  maximum: number,
): number | null {
  if (value === null || value === undefined) return null;
  return boundedInteger(value, key, label, minimum, maximum);
}

function exactPositiveInteger(value: unknown, key: string, label: string): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${label} contains malformed ${key}`);
    }
    return String(value);
  }
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error(`${label} contains malformed ${key}`);
  }
  const parsed = BigInt(value);
  if (parsed <= 0n) throw new Error(`${label} contains malformed ${key}`);
  return parsed.toString();
}

function exactPositiveIntegerString(value: unknown, key: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} contains malformed ${key}`);
  return exactPositiveInteger(value, key, label);
}

function nullableExactPositiveInteger(value: unknown, key: string, label: string): string | null {
  if (value === null || value === undefined) return null;
  return exactPositiveInteger(value, key, label);
}

function exactNonNegativeDecimal(value: unknown, key: string, label: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
    throw new Error(`${label} contains malformed ${key}`);
  }
  return value;
}

function exactDecimalIsPositive(value: string): boolean {
  return /[1-9]/.test(value);
}

function nullableExactDecimal(value: unknown, key: string, label: string): string | null {
  if (value === null || value === undefined) return null;
  return exactNonNegativeDecimal(value, key, label);
}

function timestamp(value: unknown, key: string, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} contains malformed ${key}`);
  }
  // Preserve the database text exactly. Reformatting would truncate PostgreSQL
  // microseconds and break exact CAS predicates during recovery.
  return value;
}

function nullableTimestamp(value: unknown, key: string, label: string): string | null {
  if (value === null || value === undefined) return null;
  return timestamp(value, key, label);
}

function sameTimestampInstant(left: string, right: string): boolean {
  // PostgreSQL commonly renders UTC as `+00:00` while Date#toISOString uses
  // `Z`. Preserve DB text for later CAS filters, but accept equivalent wire
  // formatting when verifying the row just written by this statement.
  const subMilliseconds = (value: string) => {
    const fraction = /\.(\d+)(?:z|[+-]\d{2}(?::?\d{2})?)$/i.exec(value)?.[1] ?? "";
    return fraction.padEnd(9, "0").slice(3, 9);
  };
  return Date.parse(left) === Date.parse(right) && subMilliseconds(left) === subMilliseconds(right);
}

function fingerprint(value: unknown, key: string, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${label} contains malformed ${key}`);
  }
  return value;
}

function nullableFingerprint(value: unknown, key: string, label: string): string | null {
  if (value === null || value === undefined) return null;
  return fingerprint(value, key, label);
}

function claimStatus(value: unknown, label: string): SupplyScaleClaimStatus {
  if (
    value !== "claimed" &&
    value !== "submitted" &&
    value !== "landed" &&
    value !== "persisted" &&
    value !== "failed_pre_submit" &&
    value !== "uncertain"
  ) {
    throw new Error(`${label} contains an ambiguous status`);
  }
  return value;
}

function assertClaimLifecycle(claim: SupplyScaleClaim, label: string): void {
  const prepared =
    claim.botTxSig !== null &&
    claim.lastValidBlockHeight !== null &&
    claim.submissionStartedAt !== null;
  const anyPrepared =
    claim.botTxSig !== null ||
    claim.lastValidBlockHeight !== null ||
    claim.submissionStartedAt !== null;
  const hasReceipt = claim.receivedAmountRaw !== null && claim.landedAt !== null;
  const anyReceipt = claim.receivedAmountRaw !== null || claim.landedAt !== null;
  const anyPersistence =
    claim.tradeId !== null || claim.persistedAt !== null || claim.appliedAt !== null;
  if (claim.status === "claimed" && (anyPrepared || anyReceipt || anyPersistence)) {
    throw new Error(`${label} contains an impossible claimed lifecycle`);
  }
  if (claim.status === "submitted" && (!prepared || anyReceipt || anyPersistence)) {
    throw new Error(`${label} contains an impossible submitted lifecycle`);
  }
  if (claim.status === "landed" && (!prepared || !hasReceipt || anyPersistence)) {
    throw new Error(`${label} contains an impossible landed lifecycle`);
  }
  if (
    claim.status === "persisted" &&
    (!prepared || !hasReceipt || !claim.tradeId || !claim.appliedAt || !claim.persistedAt)
  ) {
    throw new Error(`${label} contains an impossible persisted lifecycle`);
  }
  if (claim.status === "failed_pre_submit" && (anyPrepared || anyReceipt || anyPersistence)) {
    throw new Error(`${label} contains an impossible failed_pre_submit lifecycle`);
  }
  if (
    claim.status === "uncertain" &&
    (!prepared || (anyReceipt && !hasReceipt) || anyPersistence)
  ) {
    throw new Error(`${label} contains an unsigned uncertain lifecycle`);
  }
  if (claim.status !== "persisted" && claim.postApplyRepairedAt !== null) {
    throw new Error(`${label} contains a repair marker before atomic application`);
  }
}

export function parseSupplyScalePlan(value: unknown): SupplyScalePlan {
  const label = "supply scale plan RPC";
  const row = objectRow(value, label);
  const plan: SupplyScalePlan = {
    ok: requiredBoolean(row, "ok", label),
    eligible: requiredBoolean(row, "eligible", label),
    reason: requiredString(row, "reason", label),
    userId: nullableString(row.userId, "userId", label),
    tokenMint: nullableString(row.tokenMint, "tokenMint", label),
    positionId: nullableString(row.positionId, "positionId", label),
    sourceEventKey: nullableString(row.sourceEventKey, "sourceEventKey", label),
    claimId: nullableString(row.claimId, "claimId", label),
    tierNumber: nullableBoundedInteger(row.tierNumber, "tierNumber", label, 2, 4),
    thresholdPct: nullableNumber(row.thresholdPct, "thresholdPct", label),
    buyUsd: nullableNumber(row.buyUsd, "buyUsd", label),
    configFingerprint: nullableFingerprint(row.configFingerprint, "configFingerprint", label),
    sourceTxSig: nullableString(row.sourceTxSig, "sourceTxSig", label),
    sourceWallet: nullableString(row.sourceWallet, "sourceWallet", label),
    sourceSlot:
      row.sourceSlot === null || row.sourceSlot === undefined
        ? null
        : exactPositiveIntegerString(row.sourceSlot, "sourceSlot", label),
    tokenDecimals: nullableBoundedInteger(row.tokenDecimals, "tokenDecimals", label, 0, 18),
    netSupplyPct: nullableNumber(row.netSupplyPct, "netSupplyPct", label),
    marketCapUsd: nullableNumber(row.marketCapUsd, "marketCapUsd", label),
    minMarketCapUsd: nullableNumber(row.minMarketCapUsd, "minMarketCapUsd", label),
    maxMarketCapUsd: nullableNumber(row.maxMarketCapUsd, "maxMarketCapUsd", label),
  };
  if (!plan.ok && plan.eligible) throw new Error(`${label} cannot be eligible when ok is false`);
  if (plan.eligible) {
    for (const [key, field] of [
      ["userId", plan.userId],
      ["tokenMint", plan.tokenMint],
      ["positionId", plan.positionId],
      ["sourceEventKey", plan.sourceEventKey],
      ["tierNumber", plan.tierNumber],
      ["thresholdPct", plan.thresholdPct],
      ["buyUsd", plan.buyUsd],
      ["configFingerprint", plan.configFingerprint],
      ["sourceTxSig", plan.sourceTxSig],
      ["sourceWallet", plan.sourceWallet],
      ["sourceSlot", plan.sourceSlot],
      ["tokenDecimals", plan.tokenDecimals],
      ["netSupplyPct", plan.netSupplyPct],
      ["marketCapUsd", plan.marketCapUsd],
      ["minMarketCapUsd", plan.minMarketCapUsd],
      ["maxMarketCapUsd", plan.maxMarketCapUsd],
    ] as const) {
      if (field === null) throw new Error(`${label} eligible result is missing ${key}`);
    }
  }
  if (plan.thresholdPct !== null && (plan.thresholdPct < 10 || plan.thresholdPct > 20)) {
    throw new Error(`${label} contains malformed thresholdPct`);
  }
  if (plan.buyUsd !== null && plan.buyUsd <= 0) {
    throw new Error(`${label} contains malformed buyUsd`);
  }
  if (plan.netSupplyPct !== null && (plan.netSupplyPct < 0 || plan.netSupplyPct > 100)) {
    throw new Error(`${label} contains malformed netSupplyPct`);
  }
  if (
    (plan.marketCapUsd !== null && plan.marketCapUsd < 0) ||
    (plan.minMarketCapUsd !== null && plan.minMarketCapUsd < 0) ||
    (plan.maxMarketCapUsd !== null &&
      (plan.maxMarketCapUsd <= 0 || plan.maxMarketCapUsd > 20_000)) ||
    (plan.minMarketCapUsd !== null &&
      plan.maxMarketCapUsd !== null &&
      plan.minMarketCapUsd >= plan.maxMarketCapUsd)
  ) {
    throw new Error(`${label} contains malformed market-cap bounds`);
  }
  return plan;
}

function parseClaimFields(row: Record<string, unknown>, camelCase: boolean): SupplyScaleClaim {
  const label = camelCase ? "supply scale claim RPC" : "supply scale claim row";
  const key = (camel: string, snake: string) => (camelCase ? camel : snake);
  const claim: SupplyScaleClaim = {
    id: requiredString(row, "id", label),
    userId: requiredString(row, key("userId", "user_id"), label),
    tokenMint: requiredString(row, key("tokenMint", "token_mint"), label),
    positionId: requiredString(row, key("positionId", "position_id"), label),
    tierNumber: boundedInteger(row[key("tierNumber", "tier_number")], "tierNumber", label, 2, 4),
    status: claimStatus(row.status, label),
    sourceEventKey: requiredString(row, key("sourceEventKey", "source_event_key"), label),
    sourceTxSig: requiredString(row, key("sourceTxSig", "source_tx_sig"), label),
    sourceWallet: requiredString(row, key("sourceWallet", "source_wallet"), label),
    sourceSlot: exactPositiveIntegerString(
      row[key("sourceSlot", "source_slot")],
      "sourceSlot",
      label,
    ),
    tokenDecimals: boundedInteger(
      row[key("tokenDecimals", "token_decimals")],
      "tokenDecimals",
      label,
      0,
      18,
    ),
    thresholdPct: requiredNumber(row, key("thresholdPct", "threshold_pct"), label),
    plannedBuyUsd: requiredNumber(row, key("plannedBuyUsd", "planned_buy_usd"), label),
    amountLamports: exactPositiveIntegerString(
      row[key("amountLamports", "amount_lamports")],
      "amountLamports",
      label,
    ),
    configFingerprint: fingerprint(
      row[key("configFingerprint", "config_fingerprint")],
      "configFingerprint",
      label,
    ),
    botTxSig: nullableString(row[key("botTxSig", "bot_tx_sig")], "botTxSig", label),
    lastValidBlockHeight:
      row[key("lastValidBlockHeight", "last_valid_block_height")] === null ||
      row[key("lastValidBlockHeight", "last_valid_block_height")] === undefined
        ? null
        : exactPositiveIntegerString(
            row[key("lastValidBlockHeight", "last_valid_block_height")],
            "lastValidBlockHeight",
            label,
          ),
    receivedAmountRaw:
      row[key("receivedAmountRaw", "received_amount_raw")] === null ||
      row[key("receivedAmountRaw", "received_amount_raw")] === undefined
        ? null
        : exactPositiveIntegerString(
            row[key("receivedAmountRaw", "received_amount_raw")],
            "receivedAmountRaw",
            label,
          ),
    tradeId: nullableString(row[key("tradeId", "trade_id")], "tradeId", label),
    errorCode: nullableString(row[key("errorCode", "error_code")], "errorCode", label),
    submissionStartedAt: nullableTimestamp(
      row[key("submissionStartedAt", "submission_started_at")],
      "submissionStartedAt",
      label,
    ),
    landedAt: nullableTimestamp(row[key("landedAt", "landed_at")], "landedAt", label),
    persistedAt: nullableTimestamp(row[key("persistedAt", "persisted_at")], "persistedAt", label),
    appliedAt: nullableTimestamp(row[key("appliedAt", "applied_at")], "appliedAt", label),
    postApplyRepairedAt: nullableTimestamp(
      row[key("postApplyRepairedAt", "post_apply_repaired_at")],
      "postApplyRepairedAt",
      label,
    ),
    createdAt: timestamp(row[key("createdAt", "created_at")], "createdAt", label),
    updatedAt: timestamp(row[key("updatedAt", "updated_at")], "updatedAt", label),
  };
  if (claim.thresholdPct < 10 || claim.thresholdPct > 20) {
    throw new Error(`${label} contains malformed thresholdPct`);
  }
  if (claim.plannedBuyUsd <= 0 || claim.plannedBuyUsd > 1_000_000) {
    throw new Error(`${label} contains malformed plannedBuyUsd`);
  }
  assertClaimLifecycle(claim, label);
  return claim;
}

export function parseSupplyScaleClaim(value: unknown): SupplyScaleClaim {
  return parseClaimFields(objectRow(value, "supply scale claim RPC"), true);
}

export function parseSupplyScaleClaimRow(value: unknown): SupplyScaleClaim {
  return parseClaimFields(objectRow(value, "supply scale claim row"), false);
}

export function parseSupplyScaleClaimResult(value: unknown): SupplyScaleClaimResult {
  const label = "claim supply scale buy RPC";
  const row = objectRow(value, label);
  const result: SupplyScaleClaimResult = {
    claimed: requiredBoolean(row, "claimed", label),
    replay: requiredBoolean(row, "replay", label),
    reason: requiredString(row, "reason", label),
    claim: row.claim === null || row.claim === undefined ? null : parseSupplyScaleClaim(row.claim),
  };
  if ((result.claimed || result.replay) && !result.claim) {
    throw new Error(`${label} omitted the owned claim`);
  }
  if (result.claimed && result.replay) {
    throw new Error(`${label} contains conflicting ownership outcomes`);
  }
  if (result.claimed && result.claim?.status !== "claimed") {
    throw new Error(`${label} returned a newly owned claim outside claimed status`);
  }
  return result;
}

export function parseSupplyScaleApplyResult(value: unknown): SupplyScaleApplyResult {
  const label = "apply supply scale buy RPC";
  const row = objectRow(value, label);
  const result: SupplyScaleApplyResult = {
    applied: requiredBoolean(row, "applied", label),
    replay: requiredBoolean(row, "replay", label),
    reason: requiredString(row, "reason", label),
    claimId: nullableString(row.claimId, "claimId", label),
    positionId: nullableString(row.positionId, "positionId", label),
    tierNumber: nullableBoundedInteger(row.tierNumber, "tierNumber", label, 2, 4),
    tradeId: nullableString(row.tradeId, "tradeId", label),
    amountTokens: nullableExactDecimal(row.amountTokens, "amountTokens", label),
    amountRemaining: nullableExactDecimal(row.amountRemaining, "amountRemaining", label),
    entryPriceUsd: nullableExactDecimal(row.entryPriceUsd, "entryPriceUsd", label),
  };
  if (result.applied && result.replay) {
    throw new Error(`${label} contains conflicting apply outcomes`);
  }
  if (result.applied || result.replay) {
    if (
      !result.tradeId ||
      !result.claimId ||
      !result.positionId ||
      result.tierNumber === null ||
      result.amountTokens === null ||
      result.amountRemaining === null ||
      result.entryPriceUsd === null ||
      !exactDecimalIsPositive(result.amountTokens) ||
      !exactDecimalIsPositive(result.entryPriceUsd) ||
      (result.applied && !exactDecimalIsPositive(result.amountRemaining))
    ) {
      throw new Error(`${label} omitted persisted accounting evidence`);
    }
  }
  return result;
}

function storeError(label: string, error: DatabaseError | null | undefined): never {
  throw new SupplyScaleStoreError(label, error ?? { message: "missing database row" });
}

function preparedAttempt(
  botTxSig: string,
  lastValidBlockHeight: string | bigint,
  submissionStartedAt: string,
): SupplyScalePreparedAttempt {
  const label = "supply scale prepared attempt";
  return {
    botTxSig: requiredString({ botTxSig }, "botTxSig", label),
    lastValidBlockHeight: exactPositiveInteger(
      typeof lastValidBlockHeight === "bigint"
        ? lastValidBlockHeight.toString()
        : lastValidBlockHeight,
      "lastValidBlockHeight",
      label,
    ),
    submissionStartedAt: timestamp(submissionStartedAt, "submissionStartedAt", label),
  };
}

function assertClaimContext(
  claim: SupplyScaleClaim,
  expected: {
    userId: string;
    tokenMint?: string;
    positionId?: string;
    sourceEventKey?: string;
    amountLamports?: string;
  },
): void {
  if (
    claim.userId !== expected.userId ||
    (expected.tokenMint !== undefined && claim.tokenMint !== expected.tokenMint) ||
    (expected.positionId !== undefined && claim.positionId !== expected.positionId) ||
    (expected.sourceEventKey !== undefined && claim.sourceEventKey !== expected.sourceEventKey) ||
    (expected.amountLamports !== undefined && claim.amountLamports !== expected.amountLamports)
  ) {
    throw new Error("supply scale claim response did not match the exact request");
  }
}

export class SupplyAccumulationScaleStore {
  constructor(
    private readonly client: StoreClient,
    private readonly userId: string,
  ) {}

  async getPlan(
    tokenMint: string,
    positionId: string,
    sourceEventKey: string,
    claimId: string | null = null,
  ): Promise<SupplyScalePlan> {
    const response = await this.client.rpc("get_supply_accumulation_scale_plan", {
      p_user_id: this.userId,
      p_token_mint: tokenMint,
      p_position_id: positionId,
      p_source_event_key: sourceEventKey,
      p_claim_id: claimId,
    });
    if (response.error) storeError("load supply scale plan failed", response.error);
    const plan = parseSupplyScalePlan(response.data);
    if (
      plan.userId !== this.userId ||
      plan.tokenMint !== tokenMint ||
      plan.positionId !== positionId ||
      plan.sourceEventKey !== sourceEventKey ||
      plan.claimId !== claimId
    ) {
      throw new Error("supply scale plan response did not match the exact request");
    }
    return plan;
  }

  async claimBuy(
    tokenMint: string,
    positionId: string,
    sourceEventKey: string,
    amountLamports: string | bigint,
  ): Promise<SupplyScaleClaimResult> {
    const exactLamports = exactPositiveInteger(
      typeof amountLamports === "bigint" ? amountLamports.toString() : amountLamports,
      "amountLamports",
      "claim supply scale buy",
    );
    const response = await this.client.rpc("claim_supply_accumulation_scale_buy", {
      p_user_id: this.userId,
      p_token_mint: tokenMint,
      p_position_id: positionId,
      p_source_event_key: sourceEventKey,
      p_amount_lamports: exactLamports,
    });
    if (response.error) storeError("claim supply scale buy failed", response.error);
    const result = parseSupplyScaleClaimResult(response.data);
    if (result.claim) {
      assertClaimContext(result.claim, {
        userId: this.userId,
        tokenMint,
        positionId,
        sourceEventKey,
        amountLamports: exactLamports,
      });
    }
    return result;
  }

  /**
   * The sole onPrepared ownership boundary. It never creates a durable unsigned
   * `submitted` state: status, signature, block height, and start time advance
   * in the same exact claimed-row CAS.
   */
  async beginSubmission(
    claimId: string,
    botTxSig: string,
    lastValidBlockHeight: string | bigint,
    submissionStartedAt: string,
  ): Promise<SupplyScaleClaim> {
    const attempt = preparedAttempt(botTxSig, lastValidBlockHeight, submissionStartedAt);
    const { data, error } = await this.client
      .from(CLAIM_TABLE)
      .update({
        status: "submitted",
        bot_tx_sig: attempt.botTxSig,
        last_valid_block_height: attempt.lastValidBlockHeight,
        submission_started_at: attempt.submissionStartedAt,
        error_code: null,
        updated_at: attempt.submissionStartedAt,
      })
      .eq("id", claimId)
      .eq("user_id", this.userId)
      .eq("status", "claimed")
      .is("bot_tx_sig", null)
      .is("submission_started_at", null)
      .select(claimFields)
      .maybeSingle();
    if (error || !data) storeError("begin supply scale submission failed", error);
    const claim = parseSupplyScaleClaimRow(data);
    assertClaimContext(claim, { userId: this.userId });
    if (
      claim.id !== claimId ||
      claim.status !== "submitted" ||
      claim.botTxSig !== attempt.botTxSig ||
      claim.lastValidBlockHeight !== attempt.lastValidBlockHeight ||
      !claim.submissionStartedAt ||
      !sameTimestampInstant(claim.submissionStartedAt, attempt.submissionStartedAt)
    ) {
      throw new Error("supply scale submission CAS returned a different attempt");
    }
    return claim;
  }

  /** Exact, read-only idempotence check for the attempt written by beginSubmission. */
  async persistPrepared(
    claimId: string,
    botTxSig: string,
    lastValidBlockHeight: string | bigint,
    submissionStartedAt: string,
  ): Promise<SupplyScaleClaim> {
    const attempt = preparedAttempt(botTxSig, lastValidBlockHeight, submissionStartedAt);
    const { data, error } = await this.client
      .from(CLAIM_TABLE)
      .select(claimFields)
      .eq("id", claimId)
      .eq("user_id", this.userId)
      .eq("status", "submitted")
      .eq("bot_tx_sig", attempt.botTxSig)
      .eq("last_valid_block_height", attempt.lastValidBlockHeight)
      .eq("submission_started_at", attempt.submissionStartedAt)
      .maybeSingle();
    if (error || !data) storeError("verify prepared supply scale attempt failed", error);
    const claim = parseSupplyScaleClaimRow(data);
    assertClaimContext(claim, { userId: this.userId });
    return claim;
  }

  async markLanded(
    claimId: string,
    attemptInput: SupplyScalePreparedAttempt,
    receivedAmountRaw: string | bigint,
    tokenDecimals: number,
    landedAt = new Date().toISOString(),
  ): Promise<SupplyScaleClaim> {
    const attempt = preparedAttempt(
      attemptInput.botTxSig,
      attemptInput.lastValidBlockHeight,
      attemptInput.submissionStartedAt,
    );
    const exactReceivedRaw = exactPositiveInteger(
      typeof receivedAmountRaw === "bigint" ? receivedAmountRaw.toString() : receivedAmountRaw,
      "receivedAmountRaw",
      "landed supply scale buy",
    );
    const decimals = boundedInteger(
      tokenDecimals,
      "tokenDecimals",
      "landed supply scale buy",
      0,
      18,
    );
    const exactLandedAt = timestamp(landedAt, "landedAt", "landed supply scale buy");
    const { data, error } = await this.client
      .from(CLAIM_TABLE)
      .update({
        status: "landed",
        received_amount_raw: exactReceivedRaw,
        landed_at: exactLandedAt,
        error_code: null,
        updated_at: exactLandedAt,
      })
      .eq("id", claimId)
      .eq("user_id", this.userId)
      .in("status", ["submitted", "uncertain"])
      .eq("bot_tx_sig", attempt.botTxSig)
      .eq("last_valid_block_height", attempt.lastValidBlockHeight)
      .eq("submission_started_at", attempt.submissionStartedAt)
      .eq("token_decimals", decimals)
      // Finalized chain evidence may resolve an unsigned-receipt `submitted`
      // attempt or a signed `uncertain` attempt. Never overwrite a different
      // raw receipt if an earlier recovery pass already recorded one.
      .or(`received_amount_raw.is.null,received_amount_raw.eq.${exactReceivedRaw}`)
      .select(claimFields)
      .maybeSingle();
    if (error || !data) storeError("mark supply scale buy landed failed", error);
    const claim = parseSupplyScaleClaimRow(data);
    assertClaimContext(claim, { userId: this.userId });
    if (
      claim.id !== claimId ||
      claim.status !== "landed" ||
      claim.botTxSig !== attempt.botTxSig ||
      claim.receivedAmountRaw !== exactReceivedRaw ||
      !claim.landedAt ||
      !sameTimestampInstant(claim.landedAt, exactLandedAt)
    ) {
      throw new Error("landed supply scale CAS returned different receipt evidence");
    }
    return claim;
  }

  async markFailure(
    claimId: string,
    failure: SupplyScaleFailure,
    failedAt = new Date().toISOString(),
  ): Promise<SupplyScaleClaim> {
    const exactFailedAt = timestamp(failedAt, "failedAt", "supply scale failure");
    const errorCode = requiredString(
      { errorCode: failure.errorCode },
      "errorCode",
      "supply scale failure",
    );
    const payload: Record<string, unknown> = {
      status: failure.status,
      error_code: errorCode,
      updated_at: exactFailedAt,
    };
    if (failure.status === "failed_pre_submit") {
      Object.assign(payload, {
        bot_tx_sig: null,
        last_valid_block_height: null,
        received_amount_raw: null,
        trade_id: null,
        submission_started_at: null,
        landed_at: null,
        persisted_at: null,
        applied_at: null,
      });
    }

    let query = this.client
      .from(CLAIM_TABLE)
      .update(payload)
      .eq("id", claimId)
      .eq("user_id", this.userId)
      .eq("status", failure.expectedStatus);
    if (failure.expectedStatus === "claimed") {
      query = query.is("bot_tx_sig", null).is("submission_started_at", null);
    } else {
      const attempt = preparedAttempt(
        failure.attempt.botTxSig,
        failure.attempt.lastValidBlockHeight,
        failure.attempt.submissionStartedAt,
      );
      query = query
        .eq("bot_tx_sig", attempt.botTxSig)
        .eq("last_valid_block_height", attempt.lastValidBlockHeight)
        .eq("submission_started_at", attempt.submissionStartedAt);
    }
    const { data, error } = await query.select(claimFields).maybeSingle();
    if (error || !data) storeError("mark supply scale failure failed", error);
    const claim = parseSupplyScaleClaimRow(data);
    assertClaimContext(claim, { userId: this.userId });
    if (claim.id !== claimId || claim.status !== failure.status) {
      throw new Error("supply scale failure CAS returned a different lifecycle");
    }
    return claim;
  }

  async applyBuy(
    claimId: string,
    botTxSig: string,
    receivedAmountRaw: string | bigint,
    tokenDecimals: number,
    route: "jito" | "rpc",
    latencyMs: number | null = null,
  ): Promise<SupplyScaleApplyResult> {
    const exactSig = requiredString({ botTxSig }, "botTxSig", "apply supply scale buy");
    const exactRaw = exactPositiveInteger(
      typeof receivedAmountRaw === "bigint" ? receivedAmountRaw.toString() : receivedAmountRaw,
      "receivedAmountRaw",
      "apply supply scale buy",
    );
    const decimals = boundedInteger(
      tokenDecimals,
      "tokenDecimals",
      "apply supply scale buy",
      0,
      18,
    );
    if (route !== "jito" && route !== "rpc")
      throw new Error("apply supply scale buy has invalid route");
    if (latencyMs !== null && (!Number.isSafeInteger(latencyMs) || latencyMs < 0)) {
      throw new Error("apply supply scale buy has invalid latencyMs");
    }
    const response = await this.client.rpc("apply_supply_accumulation_scale_buy", {
      p_user_id: this.userId,
      p_claim_id: claimId,
      p_bot_tx_sig: exactSig,
      p_received_amount_raw: exactRaw,
      p_token_decimals: decimals,
      p_route: route,
      p_latency_ms: latencyMs,
    });
    if (response.error) storeError("apply supply scale buy failed", response.error);
    const result = parseSupplyScaleApplyResult(response.data);
    if (result.claimId !== null && result.claimId !== claimId) {
      throw new Error("apply supply scale buy response did not match the exact claim");
    }
    return result;
  }

  async markPostApplyRepaired(
    claimId: string,
    botTxSig: string,
    repairedAt = new Date().toISOString(),
  ): Promise<SupplyScaleClaim> {
    const exactSig = requiredString({ botTxSig }, "botTxSig", "repair supply scale claim");
    const exactRepairedAt = timestamp(repairedAt, "repairedAt", "repair supply scale claim");
    const update = await this.client
      .from(CLAIM_TABLE)
      .update({
        post_apply_repaired_at: exactRepairedAt,
        updated_at: exactRepairedAt,
      })
      .eq("id", claimId)
      .eq("user_id", this.userId)
      .eq("status", "persisted")
      .eq("bot_tx_sig", exactSig)
      .not("applied_at", "is", null)
      .is("post_apply_repaired_at", null)
      .select(claimFields)
      .maybeSingle();

    let data = update.data;
    if (update.error || !data) {
      // A lost HTTP response may follow a committed update. Read back the
      // exact persisted claim before deciding that repair ownership was lost.
      const readback = await this.client
        .from(CLAIM_TABLE)
        .select(claimFields)
        .eq("id", claimId)
        .eq("user_id", this.userId)
        .eq("status", "persisted")
        .eq("bot_tx_sig", exactSig)
        .not("applied_at", "is", null)
        .not("post_apply_repaired_at", "is", null)
        .maybeSingle();
      if (readback.error || !readback.data) {
        storeError("mark supply scale post-apply repair failed", update.error ?? readback.error);
      }
      data = readback.data;
    }

    const claim = parseSupplyScaleClaimRow(data);
    assertClaimContext(claim, { userId: this.userId });
    if (
      claim.id !== claimId ||
      claim.status !== "persisted" ||
      claim.botTxSig !== exactSig ||
      claim.postApplyRepairedAt === null
    ) {
      throw new Error("supply scale post-apply repair CAS returned a different claim");
    }
    return claim;
  }

  async loadPendingPostApplyRepairs(): Promise<SupplyScaleClaim[]> {
    const response = await this.client
      .from(CLAIM_TABLE)
      .select(claimFields)
      .eq("user_id", this.userId)
      .eq("status", "persisted")
      .is("post_apply_repaired_at", null)
      .order("applied_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(MAX_UNRESOLVED_CLAIMS + 1);
    if (response.error) storeError("load pending supply scale repairs failed", response.error);
    if (!Array.isArray(response.data)) {
      throw new Error("pending supply scale repair query returned a malformed payload");
    }
    if (response.data.length > MAX_UNRESOLVED_CLAIMS) {
      throw new Error("pending supply scale repairs exceed the safe recovery bound");
    }
    return response.data.map((row) => {
      const claim = parseSupplyScaleClaimRow(row);
      assertClaimContext(claim, { userId: this.userId });
      if (claim.status !== "persisted" || claim.postApplyRepairedAt !== null) {
        throw new Error("pending supply scale repair query returned a completed claim");
      }
      return claim;
    });
  }

  async loadUnresolvedClaims(): Promise<SupplyScaleClaim[]> {
    const response = await this.client
      .from(CLAIM_TABLE)
      .select(claimFields)
      .eq("user_id", this.userId)
      .in("status", [...SUPPLY_SCALE_UNRESOLVED_STATUSES])
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(MAX_UNRESOLVED_CLAIMS + 1);
    if (response.error) storeError("load unresolved supply scale claims failed", response.error);
    if (!Array.isArray(response.data)) {
      throw new Error("unresolved supply scale claim query returned a malformed payload");
    }
    if (response.data.length > MAX_UNRESOLVED_CLAIMS) {
      throw new Error("unresolved supply scale claims exceed the safe recovery bound");
    }
    return response.data.map((row) => {
      const claim = parseSupplyScaleClaimRow(row);
      assertClaimContext(claim, { userId: this.userId });
      if (!SUPPLY_SCALE_UNRESOLVED_STATUSES.includes(claim.status as never)) {
        throw new Error("unresolved supply scale query returned a terminal claim");
      }
      return claim;
    });
  }
}
