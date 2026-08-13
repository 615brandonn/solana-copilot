import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConvictionEvent } from "./conviction-engine.js";
import {
  convictionEventDbRow,
  convictionEventFromDbRow,
  convictionRankDbRow,
  convictionStateDbRow,
} from "./conviction-persistence.js";
import type {
  ConvictionRuntimeStore,
  ConvictionRuntimeTransition,
  ConvictionTierClaimInput,
  ConvictionTierClaimResult,
  ConvictionTierLifecycleUpdate,
  StoredConvictionTier,
} from "./conviction-runtime.js";
import { safeDiagnostic } from "./diagnostics.js";

type LooseClient = SupabaseClient;

function storedTier(row: Record<string, unknown>): StoredConvictionTier {
  return {
    id: String(row.id ?? ""),
    tokenMint: String(row.token_mint ?? ""),
    tierId: `tier_${Math.max(1, Number(row.tier_number ?? 1))}`,
    status: String(row.status ?? "skipped") as StoredConvictionTier["status"],
    tradingMode: row.trading_mode === "live" ? "live" : "shadow",
    amountUsd: Math.max(0, Number(row.buy_usd ?? 0)),
    commitmentUsd: Math.max(0, Number(row.commitment_threshold_usd ?? 0)),
    sourceEventKey: String(row.source_event_key ?? "") || undefined,
    botTxSig: String(row.bot_tx_sig ?? "") || undefined,
    reference: String(row.bot_tx_sig ?? row.id ?? "") || undefined,
    plannedPositionId: String(row.planned_position_id ?? "") || undefined,
    positionId: String(row.position_id ?? "") || undefined,
    tierNumber: Math.max(1, Number(row.tier_number ?? 1)),
    executedAtMs: (() => {
      const value = row.claimed_at ?? row.created_at;
      const timestamp = typeof value === "string" ? new Date(value).getTime() : Number.NaN;
      return Number.isFinite(timestamp) ? timestamp : undefined;
    })(),
  };
}

const tierFields =
  "id,token_mint,tier_number,status,trading_mode,buy_usd,commitment_threshold_usd,source_event_key,bot_tx_sig,planned_position_id,position_id,claimed_at,created_at";

function allowedTierPriorStatuses(
  status: StoredConvictionTier["status"],
): StoredConvictionTier["status"][] {
  switch (status) {
    case "submitted":
      return ["claimed", "submitted"];
    case "landed":
      return ["submitted", "landed"];
    case "persisted":
      return ["landed", "persisted"];
    case "failed_pre_submit":
      return ["claimed", "submitted", "failed_pre_submit"];
    case "uncertain":
      return ["submitted", "landed", "uncertain"];
    default:
      return [status];
  }
}

function transitionRow(userId: string, row: ConvictionRuntimeTransition) {
  const transition = row.transition;
  const breakout = row.breakout;
  return {
    user_id: userId,
    transition_key: row.eventKey,
    token_mint: row.mint,
    event_type: row.eventType,
    previous_state: transition?.previousState ?? null,
    new_state: transition?.newState ?? null,
    previous_score: transition?.previousScore ?? breakout?.previousScore ?? null,
    new_score: transition?.newScore ?? breakout?.newScore ?? row.score ?? null,
    net_cluster_investment_usd: breakout?.netClusterInvestmentUsd ?? null,
    capital_velocity_usd_per_minute: breakout?.capitalVelocityUsdPerMinute ?? null,
    wallet_convergence_count:
      breakout?.walletConvergence === undefined ? null : Math.min(3, breakout.walletConvergence),
    market_cap_usd: breakout?.marketCapUsd ?? null,
    liquidity_usd: breakout?.liquidityUsd ?? null,
    reasons: row.reasons,
    metadata: row.metadata ?? {},
    occurred_at: new Date(row.timestampMs).toISOString(),
  };
}

export function createSupabaseConvictionStore(
  client: LooseClient,
  userId: string,
): ConvictionRuntimeStore {
  return {
    async loadEvents(): Promise<ConvictionEvent[]> {
      const output: ConvictionEvent[] = [];
      const pageSize = 1_000;
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await client
          .from("conviction_events")
          .select(
            "event_key,event_at,wallet,token_mint,classification,classification_reliable,amount_tokens,amount_usd,from_wallet,to_wallet,market_cap_usd,liquidity_usd,metadata",
          )
          .eq("user_id", userId)
          .order("event_at", { ascending: true })
          .order("event_key", { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (error) throw new Error(`conviction event hydration failed: ${safeDiagnostic(error)}`);
        for (const row of data ?? []) {
          const event = convictionEventFromDbRow(row);
          if (event) output.push(event);
        }
        if ((data?.length ?? 0) < pageSize) return output;
      }
    },

    async loadTiers(): Promise<StoredConvictionTier[]> {
      const output: StoredConvictionTier[] = [];
      const pageSize = 1_000;
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await client
          .from("conviction_tiers")
          .select(tierFields)
          .eq("user_id", userId)
          .order("created_at", { ascending: true })
          .order("tier_number", { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (error) throw new Error(`conviction tier hydration failed: ${safeDiagnostic(error)}`);
        output.push(...(data ?? []).map((row: Record<string, unknown>) => storedTier(row)));
        if ((data?.length ?? 0) < pageSize) return output;
      }
    },

    async insertEvent(event: ConvictionEvent) {
      const metadata = event.metadata ?? {};
      const row = convictionEventDbRow({
        userId,
        event,
        txSig: typeof metadata.txSig === "string" ? metadata.txSig : event.eventId,
        slot: Number(metadata.slot),
        source:
          metadata.source === "geyser" || metadata.source === "rpc" ? metadata.source : "unknown",
      });
      const { error } = await client.from("conviction_events").insert(row);
      if (!error) return "inserted" as const;
      if (error.code === "23505") {
        // Geyser may first produce a conservative UNKNOWN observation and RPC
        // later recover verified swap attribution for the same transaction.
        // Upgrade that exact durable event in place; never let an early weak
        // decode permanently suppress richer evidence after restart.
        if (
          event.classificationReliable === true &&
          (event.type === "DEX_BUY" || event.type === "DEX_SELL")
        ) {
          const { data: upgraded, error: upgradeError } = await client
            .from("conviction_events")
            .update(row)
            .eq("user_id", userId)
            .eq("event_key", event.eventId)
            .eq("classification_reliable", false)
            .select("event_key")
            .maybeSingle();
          if (upgradeError) {
            throw new Error(
              `conviction event evidence upgrade failed: ${safeDiagnostic(upgradeError)}`,
            );
          }
          return upgraded ? ("upgraded" as const) : ("duplicate" as const);
        }
        return "duplicate" as const;
      }
      throw new Error(`conviction event persistence failed: ${safeDiagnostic(error)}`);
    },

    async saveState(snapshot): Promise<void> {
      const { error } = await client
        .from("conviction_token_state")
        .upsert(convictionStateDbRow(userId, snapshot), { onConflict: "user_id,token_mint" });
      if (error) throw new Error(`conviction state persistence failed: ${safeDiagnostic(error)}`);
    },

    async saveRanks(rows, rankingAtMs): Promise<void> {
      if (rows.length === 0) return;
      const payload = rows.map((row) => convictionRankDbRow(userId, row, rankingAtMs));
      const { error } = await client.from("conviction_rank_history").upsert(payload, {
        onConflict: "user_id,token_mint,window_minutes,ranking_at",
      });
      if (error) throw new Error(`conviction ranking persistence failed: ${safeDiagnostic(error)}`);
    },

    async saveTransitions(rows): Promise<void> {
      if (rows.length === 0) return;
      const { error } = await client.from("conviction_transitions").upsert(
        rows.map((row) => transitionRow(userId, row)),
        { onConflict: "user_id,transition_key", ignoreDuplicates: true },
      );
      if (error)
        throw new Error(`conviction transition persistence failed: ${safeDiagnostic(error)}`);
    },

    async claimTier(input: ConvictionTierClaimInput): Promise<ConvictionTierClaimResult> {
      const plannedPositionId = input.status === "claimed" ? randomUUID() : null;
      const payload = {
        user_id: userId,
        token_mint: input.tokenMint,
        tier_number: input.tierNumber,
        trading_mode: input.tradingMode,
        status: input.status,
        planned_position_id: plannedPositionId,
        source_event_key: input.sourceEventKey,
        commitment_threshold_usd: input.commitmentUsd,
        buy_usd: input.amountUsd,
        score: input.score,
        reason: input.reason,
        claimed_at: input.status === "claimed" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
        metadata: { tierId: input.tierId },
      };
      const { data, error } = await client
        .from("conviction_tiers")
        .insert(payload)
        .select(tierFields)
        .maybeSingle();
      if (!error && data) return { claimed: true, row: storedTier(data) };
      if (error?.code !== "23505") {
        throw new Error(`conviction tier claim failed: ${safeDiagnostic(error ?? "missing row")}`);
      }
      const { data: existing, error: existingError } = await client
        .from("conviction_tiers")
        .select(tierFields)
        .eq("user_id", userId)
        .eq("token_mint", input.tokenMint)
        .eq("tier_number", input.tierNumber)
        .eq("trading_mode", input.tradingMode)
        .maybeSingle();
      if (existingError) {
        throw new Error(`conviction tier recovery failed: ${safeDiagnostic(existingError)}`);
      }
      let recovered = existing;
      if (!recovered) {
        // Compatibility for an early draft that installed an unscoped
        // (user,mint,tier) unique constraint. A fresh LIVE signal may safely
        // promote only a paper SHADOW row; live history is never demoted or
        // overwritten by shadow evaluation.
        const { data: legacy, error: legacyError } = await client
          .from("conviction_tiers")
          .select(tierFields)
          .eq("user_id", userId)
          .eq("token_mint", input.tokenMint)
          .eq("tier_number", input.tierNumber)
          .maybeSingle();
        if (legacyError || !legacy) {
          throw new Error(
            `conviction tier recovery failed: ${safeDiagnostic(legacyError ?? "missing row")}`,
          );
        }
        if (
          input.status === "claimed" &&
          input.tradingMode === "live" &&
          legacy.trading_mode === "shadow" &&
          legacy.status === "shadowed"
        ) {
          const { data: promoted, error: promotionError } = await client
            .from("conviction_tiers")
            .update({
              ...payload,
              trading_mode: "live",
              status: "claimed",
              error_code: null,
              bot_tx_sig: null,
              position_id: null,
              received_tokens: null,
              submission_started_at: null,
              landed_at: null,
              persisted_at: null,
            })
            .eq("id", legacy.id)
            .eq("trading_mode", "shadow")
            .eq("status", "shadowed")
            .select(tierFields)
            .maybeSingle();
          if (promotionError || !promoted) {
            throw new Error(
              `conviction legacy shadow promotion failed: ${safeDiagnostic(promotionError ?? "claim changed")}`,
            );
          }
          return { claimed: true, row: storedTier(promoted) };
        }
        recovered = legacy;
      }
      if (recovered.status === "failed_pre_submit" && input.status === "claimed") {
        const { data: reclaimed, error: reclaimError } = await client
          .from("conviction_tiers")
          .update({
            status: "claimed",
            planned_position_id: plannedPositionId,
            buy_usd: input.amountUsd,
            commitment_threshold_usd: input.commitmentUsd,
            score: input.score,
            source_event_key: input.sourceEventKey,
            reason: input.reason,
            error_code: null,
            bot_tx_sig: null,
            position_id: null,
            received_tokens: null,
            claimed_at: new Date().toISOString(),
            submission_started_at: null,
            landed_at: null,
            persisted_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", recovered.id)
          .eq("status", "failed_pre_submit")
          .select(tierFields)
          .maybeSingle();
        if (reclaimError || !reclaimed) {
          throw new Error(
            `conviction tier reclaim failed: ${safeDiagnostic(reclaimError ?? "claim changed")}`,
          );
        }
        return { claimed: true, row: storedTier(reclaimed) };
      }
      return { claimed: false, row: storedTier(recovered) };
    },

    async updateTier(
      id: string,
      update: ConvictionTierLifecycleUpdate,
    ): Promise<StoredConvictionTier> {
      const now = new Date().toISOString();
      const payload: Record<string, unknown> = {
        status: update.status,
        updated_at: now,
      };
      if (update.botTxSig !== undefined) payload.bot_tx_sig = update.botTxSig;
      if (update.positionId !== undefined) payload.position_id = update.positionId;
      if (update.receivedTokens !== undefined) {
        payload.received_tokens =
          update.receivedTokens === null ? null : Math.max(0, Number(update.receivedTokens));
      }
      if (update.errorCode !== undefined) payload.error_code = update.errorCode;
      if (update.status === "submitted") payload.submission_started_at = now;
      if (update.status === "landed") payload.landed_at = now;
      if (update.status === "persisted") payload.persisted_at = now;
      if (update.status === "failed_pre_submit") {
        payload.bot_tx_sig = null;
        payload.position_id = null;
        payload.received_tokens = null;
        payload.submission_started_at = null;
        payload.landed_at = null;
        payload.persisted_at = null;
      }
      const { data, error } = await client
        .from("conviction_tiers")
        .update(payload)
        .eq("user_id", userId)
        .eq("id", id)
        .in("status", allowedTierPriorStatuses(update.status))
        .select(tierFields)
        .maybeSingle();
      if (error || !data) {
        throw new Error(
          `conviction tier lifecycle update failed: ${safeDiagnostic(error ?? "missing row")}`,
        );
      }
      return storedTier(data);
    },
  };
}
