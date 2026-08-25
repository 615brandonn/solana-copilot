import type { SupabaseClient } from "@supabase/supabase-js";
import type { SwapEvent } from "./geyser.js";

export type SupplyAccumulationState = {
  ok: boolean;
  reason: string;
  userId: string;
  tokenMint: string;
  modeEnabled: boolean;
  windowSeconds: number;
  asOf: string;
  windowStartedAt: string;
  totalSupplyRaw: string | null;
  decimals: number | null;
  grossBuyRaw: string;
  grossSellRaw: string;
  netAcquiredRaw: string;
  netSupplyBps: number;
  netSupplyPct: number;
  buyCount: number;
  sellCount: number;
  rootWallets: string[];
  lastEventKey: string | null;
  lastEventAt: string | null;
  lastEventSlot: string | null;
  latestMarketCapUsd: number | null;
  valuationSlot: string | null;
  marketDataReliable: boolean;
  pumpFunVerified: boolean;
  classificationReliable: boolean;
  payloadConflict: boolean;
  dataReliable: boolean;
  directSettlementSeen: boolean;
  thresholdPct: number;
  thresholdReached: boolean;
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
  aboveMarketCapFloor: boolean;
  underMarketCap: boolean;
  withinMarketCapRange: boolean;
  entryReady: boolean;
};

export type RecordSupplyAccumulationResult = {
  applied: boolean;
  duplicate: boolean;
  payloadMismatch: boolean;
  reason: string;
  eventId: string | null;
  state: SupplyAccumulationState;
};

export type SupplyAccumulationEvidence = {
  amountRaw: string;
  totalSupplyRaw: string;
  marketCapUsd?: number;
  valuationSlot: number;
  marketDataReliable: boolean;
  pumpFunVerified: boolean;
  classificationReliable: boolean;
};

export type VerifiedSupplySell = {
  targetWallet: string;
  tokenMint: string;
  txSig: string;
  slot: number;
  eventAtMs: number;
  amountRaw: string;
  decimals: number;
  tokenBalanceBeforeRaw: string;
  tokenBalanceAfterRaw: string;
  soldAmountRaw: string;
};

function canonicalRaw(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`${label} must be an exact unsigned integer string`);
  }
  const parsed = BigInt(value);
  if (parsed <= 0n) throw new Error(`${label} must be positive`);
  return parsed.toString();
}

function requiredBoolean(row: Record<string, unknown>, key: string): boolean {
  if (typeof row[key] !== "boolean") throw new Error(`supply RPC response missing ${key}`);
  return row[key];
}

function requiredNumber(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key]);
  if (!Number.isFinite(value)) throw new Error(`supply RPC response missing ${key}`);
  return value;
}

function requiredString(row: Record<string, unknown>, key: string): string {
  if (typeof row[key] !== "string") throw new Error(`supply RPC response missing ${key}`);
  return row[key];
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("supply RPC response contains an invalid number");
  return parsed;
}

export function parseSupplyAccumulationState(value: unknown): SupplyAccumulationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("supply state RPC returned a malformed payload");
  }
  const row = value as Record<string, unknown>;
  const rootWallets = row.rootWallets;
  if (!Array.isArray(rootWallets) || rootWallets.some((wallet) => typeof wallet !== "string")) {
    throw new Error("supply state RPC returned malformed rootWallets");
  }
  const totalSupplyRaw = nullableString(row.totalSupplyRaw);
  for (const [key, raw] of [
    ["grossBuyRaw", row.grossBuyRaw],
    ["grossSellRaw", row.grossSellRaw],
    ["netAcquiredRaw", row.netAcquiredRaw],
  ] as const) {
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
      throw new Error(`supply state RPC returned malformed ${key}`);
    }
  }
  if (totalSupplyRaw !== null && !/^\d+$/.test(totalSupplyRaw)) {
    throw new Error("supply state RPC returned malformed totalSupplyRaw");
  }
  const decimals = nullableNumber(row.decimals);
  if (decimals !== null && (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)) {
    throw new Error("supply state RPC returned malformed decimals");
  }
  return {
    ok: requiredBoolean(row, "ok"),
    reason: requiredString(row, "reason"),
    userId: requiredString(row, "userId"),
    tokenMint: requiredString(row, "tokenMint"),
    modeEnabled: requiredBoolean(row, "modeEnabled"),
    windowSeconds: requiredNumber(row, "windowSeconds"),
    asOf: requiredString(row, "asOf"),
    windowStartedAt: requiredString(row, "windowStartedAt"),
    totalSupplyRaw,
    decimals,
    grossBuyRaw: row.grossBuyRaw as string,
    grossSellRaw: row.grossSellRaw as string,
    netAcquiredRaw: row.netAcquiredRaw as string,
    netSupplyBps: requiredNumber(row, "netSupplyBps"),
    netSupplyPct: requiredNumber(row, "netSupplyPct"),
    buyCount: requiredNumber(row, "buyCount"),
    sellCount: requiredNumber(row, "sellCount"),
    rootWallets: rootWallets as string[],
    lastEventKey: nullableString(row.lastEventKey),
    lastEventAt: nullableString(row.lastEventAt),
    lastEventSlot: nullableString(row.lastEventSlot),
    latestMarketCapUsd: nullableNumber(row.latestMarketCapUsd),
    valuationSlot: nullableString(row.valuationSlot),
    marketDataReliable: requiredBoolean(row, "marketDataReliable"),
    pumpFunVerified: requiredBoolean(row, "pumpFunVerified"),
    classificationReliable: requiredBoolean(row, "classificationReliable"),
    payloadConflict: requiredBoolean(row, "payloadConflict"),
    dataReliable: requiredBoolean(row, "dataReliable"),
    directSettlementSeen: requiredBoolean(row, "directSettlementSeen"),
    thresholdPct: requiredNumber(row, "thresholdPct"),
    thresholdReached: requiredBoolean(row, "thresholdReached"),
    minMarketCapUsd: requiredNumber(row, "minMarketCapUsd"),
    maxMarketCapUsd: requiredNumber(row, "maxMarketCapUsd"),
    aboveMarketCapFloor: requiredBoolean(row, "aboveMarketCapFloor"),
    underMarketCap: requiredBoolean(row, "underMarketCap"),
    withinMarketCapRange: requiredBoolean(row, "withinMarketCapRange"),
    entryReady: requiredBoolean(row, "entryReady"),
  };
}

export function supplyEventKey(event: SwapEvent): string {
  const transaction = event.txSig || `slot-${event.slot}`;
  return ["supply", event.side, transaction, event.wallet, event.tokenMint].join(":");
}

export class SupplyAccumulationStore {
  constructor(
    private readonly client: Pick<SupabaseClient, "rpc" | "from">,
    private readonly userId: string,
  ) {}

  async record(
    event: SwapEvent,
    evidence: SupplyAccumulationEvidence,
  ): Promise<RecordSupplyAccumulationResult> {
    const amountRaw = canonicalRaw(evidence.amountRaw, "supply event amount");
    const totalSupplyRaw = canonicalRaw(evidence.totalSupplyRaw, "token total supply");
    const response = await this.client.rpc("record_supply_accumulation_event", {
      p_user_id: this.userId,
      p_event_key: supplyEventKey(event),
      p_tx_sig: event.txSig,
      p_slot: event.slot,
      p_event_at: new Date(event.blockTimeMs ?? event.timestampMs).toISOString(),
      p_target_wallet: event.wallet,
      p_token_mint: event.tokenMint,
      p_side: event.side,
      p_amount_raw: amountRaw,
      p_total_supply_raw: totalSupplyRaw,
      p_decimals: event.decimals,
      p_market_cap_usd: evidence.marketCapUsd ?? null,
      p_valuation_slot: evidence.valuationSlot,
      p_market_data_reliable: evidence.marketDataReliable,
      p_is_pump_fun: evidence.pumpFunVerified,
      p_classification_reliable: evidence.classificationReliable,
      p_metadata: {
        source: event.source ?? "unknown",
        delivery: event.delivery ?? "live",
        grossForwarded: event.grossAmountRaw !== undefined,
        ...(event.side === "sell"
          ? {
              tokenBalanceBeforeRaw: event.sellAttribution?.tokenBalanceBeforeRaw,
              tokenBalanceAfterRaw: event.sellAttribution?.tokenBalanceAfterRaw,
              soldAmountRaw: event.sellAttribution?.soldAmountRaw,
              amountRaw: event.sellAttribution?.soldAmountRaw ?? event.amountRaw,
            }
          : {}),
      },
    });
    if (response.error) {
      throw new Error(`record supply accumulation event failed: ${response.error.message}`);
    }
    const value = response.data;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("record supply accumulation RPC returned a malformed payload");
    }
    const row = value as Record<string, unknown>;
    return {
      applied: requiredBoolean(row, "applied"),
      duplicate: requiredBoolean(row, "duplicate"),
      payloadMismatch: requiredBoolean(row, "payloadMismatch"),
      reason: requiredString(row, "reason"),
      eventId: nullableString(row.eventId),
      state: parseSupplyAccumulationState(row.state),
    };
  }

  async state(tokenMint: string): Promise<SupplyAccumulationState> {
    const response = await this.client.rpc("get_supply_accumulation_state", {
      p_user_id: this.userId,
      p_token_mint: tokenMint,
      p_as_of: new Date().toISOString(),
    });
    if (response.error) {
      throw new Error(`load supply accumulation state failed: ${response.error.message}`);
    }
    return parseSupplyAccumulationState(response.data);
  }

  async custodyDistributionGate(
    tokenMint: string,
    windowStartedAt: string,
    trigger: { txSig: string; slot: number; targetWallet: string },
  ): Promise<{ safe: boolean; reason: string }> {
    const response = await this.client.rpc("check_supply_accumulation_custody_gate", {
      p_user_id: this.userId,
      p_token_mint: tokenMint,
      p_window_started_at: windowStartedAt,
      p_trigger_tx_sig: trigger.txSig,
      p_trigger_slot: trigger.slot,
      p_target_wallet: trigger.targetWallet,
    });
    if (response.error) {
      throw new Error(`load custody distribution gate failed: ${response.error.message}`);
    }
    if (!response.data || typeof response.data !== "object" || Array.isArray(response.data)) {
      throw new Error("custody distribution gate returned a malformed payload");
    }
    const row = response.data as Record<string, unknown>;
    if (typeof row.safe !== "boolean" || typeof row.reason !== "string") {
      throw new Error("custody distribution gate returned a malformed payload");
    }
    return { safe: row.safe, reason: row.reason };
  }

  async verifiedSellsAfter(tokenMint: string, sourceSlot: number): Promise<VerifiedSupplySell[]> {
    const response = await this.client
      .from("supply_accumulation_events")
      .select("target_wallet,token_mint,tx_sig,slot,event_at,decimals,metadata")
      .eq("user_id", this.userId)
      .eq("token_mint", tokenMint)
      .eq("side", "sell")
      .eq("quarantined", false)
      .eq("is_pump_fun", true)
      .eq("classification_reliable", true)
      .gte("slot", sourceSlot)
      .order("slot", { ascending: true })
      .order("event_at", { ascending: true })
      .limit(1_001);
    if (response.error) {
      throw new Error(`load durable in-flight supply sell failed: ${response.error.message}`);
    }
    if (!Array.isArray(response.data)) {
      throw new Error("durable in-flight supply sell query returned a malformed payload");
    }
    if (response.data.length > 1_000) {
      throw new Error("durable in-flight supply sell evidence exceeds the safe recovery bound");
    }
    return response.data.map((value) => {
      const row = value as Record<string, unknown>;
      const metadata =
        row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : null;
      const targetWallet = nullableString(row.target_wallet);
      const mint = nullableString(row.token_mint);
      const txSig = nullableString(row.tx_sig);
      const amountRaw = nullableString(metadata?.amountRaw);
      const tokenBalanceBeforeRaw = nullableString(metadata?.tokenBalanceBeforeRaw);
      const tokenBalanceAfterRaw = nullableString(metadata?.tokenBalanceAfterRaw);
      const soldAmountRaw = nullableString(metadata?.soldAmountRaw);
      const slot = Number(row.slot);
      const decimals = Number(row.decimals);
      const eventAtMs = Date.parse(String(row.event_at ?? ""));
      if (
        !targetWallet ||
        !mint ||
        !txSig ||
        !amountRaw ||
        !tokenBalanceBeforeRaw ||
        !tokenBalanceAfterRaw ||
        !soldAmountRaw ||
        ![amountRaw, tokenBalanceBeforeRaw, tokenBalanceAfterRaw, soldAmountRaw].every((raw) =>
          /^\d+$/.test(raw),
        ) ||
        !Number.isSafeInteger(slot) ||
        slot < sourceSlot ||
        !Number.isInteger(decimals) ||
        decimals < 0 ||
        decimals > 18 ||
        !Number.isFinite(eventAtMs)
      ) {
        throw new Error("durable in-flight supply sell evidence is malformed");
      }
      return {
        targetWallet,
        tokenMint: mint,
        txSig,
        slot,
        eventAtMs,
        amountRaw: BigInt(amountRaw).toString(),
        decimals,
        tokenBalanceBeforeRaw: BigInt(tokenBalanceBeforeRaw).toString(),
        tokenBalanceAfterRaw: BigInt(tokenBalanceAfterRaw).toString(),
        soldAmountRaw: BigInt(soldAmountRaw).toString(),
      };
    });
  }
}
