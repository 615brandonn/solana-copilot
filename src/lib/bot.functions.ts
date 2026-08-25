import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { BotConfig } from "./bot-config";
import { BotConfigSchema, FundingKeySchema } from "./bot.schemas";
import { isSolanaPublicKey } from "./base58";
import {
  buildCustodyDashboardData,
  buildCustodyJourneyDetail,
  custodyWindowSince,
  type CustodyDashboardData,
  type CustodyCoverageReasonRow,
  type CustodyJourneyDetailData,
  type CustodyJourneyEventRow,
  type CustodyJourneyRow,
  type CustodyJourneyWalletRow,
  type CustodyWorkerHeartbeatRow,
  type CustodyWalletProfileRow,
} from "./custody";
import type {
  ConvictionBacktestResult,
  ConvictionBacktestSettings,
  ConvictionDashboardData,
  ConvictionEventRow,
  ConvictionRankRow,
  ConvictionTierRow,
  ConvictionTokenDetailData,
  ConvictionTokenStateRow,
  ConvictionTransitionRow,
  SerializableJson,
} from "./conviction-lab";
import {
  historicalMarketDataIsCausal,
  historicalValuationIsCausal,
  runConvictionHistoricalBacktest,
  type ConvictionHistoricalObservation,
} from "./conviction-backtest";
import {
  adminClient,
  configToRow,
  currentUserId,
  rowToConfig,
  saveFundingKeyRecord,
} from "./bot.server";
import {
  buildRevivalDashboard,
  revivalCampaignSummary,
  type RevivalCampaignDetail,
  type RevivalDashboardSummary,
  type RevivalDetailRow,
  type RevivalDashboardData,
} from "./revival";

export const getBotConfig = createServerFn({ method: "GET" }).handler(async () => {
  const db = adminClient();
  const { data, error } = await (db as any)
    .from("bot_config")
    .select("*")
    .eq("user_id", currentUserId())
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;
  return rowToConfig(data);
});

export const saveBotConfig = createServerFn({ method: "POST" })
  .validator((data) => BotConfigSchema.parse(data))
  .handler(async ({ data }) => {
    const db = adminClient();
    const row = configToRow(data as BotConfig);
    try {
      const { error } = await db.from("bot_config").upsert(row as any, { onConflict: "user_id" });
      if (error) {
        console.error("[saveBotConfig] Supabase error", error);
        throw new Error(`Supabase: ${error.message} (${error.code ?? "no code"})`);
      }
      return { ok: true };
    } catch (e: any) {
      console.error("[saveBotConfig] exception", e);
      throw new Error(e.message ?? "Unknown save error");
    }
  });

export const saveFundingKey = createServerFn({ method: "POST" })
  .validator((data) => FundingKeySchema.parse(data))
  .handler(async ({ data }) => {
    return saveFundingKeyRecord(data.privateKey);
  });

export const getFundingKeyStatus = createServerFn({ method: "GET" }).handler(async () => {
  const db = adminClient();
  const userId = currentUserId();
  const { data, error } = await (db as any)
    .from("funding_keys")
    .select("wallet_pubkey")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data) {
    return {
      saved: true,
      walletPubkey: data.wallet_pubkey ?? null,
      identityMismatch: false,
    };
  }

  const { data: otherRows, error: otherError } = await (db as any)
    .from("funding_keys")
    .select("user_id")
    .neq("user_id", userId)
    .limit(1);
  if (otherError) throw new Error(otherError.message);
  return {
    saved: false,
    walletPubkey: null,
    identityMismatch: (otherRows?.length ?? 0) > 0,
  };
});

export const getWorkerStatus = createServerFn({ method: "GET" }).handler(async () => {
  const db = adminClient();
  const userId = currentUserId();
  const { data, error } = await (db as any)
    .from("worker_heartbeat")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    const { data: otherRows, error: otherError } = await (db as any)
      .from("worker_heartbeat")
      .select("user_id,updated_at")
      .neq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1);
    if (otherError) throw new Error(otherError.message);
    return {
      online: false,
      updatedAt: null,
      geyserConnected: false,
      lastGeyserMessageAt: null,
      decodedEventCount: 0,
      rpcLastPollAt: null,
      rpcLastSuccessAt: null,
      rpcBacklogWalletCount: 0,
      monitoringDegraded: false,
      followerBalanceLastCheckedAt: null,
      followerBalanceCandidateCount: 0,
      followerBalanceMismatchCount: 0,
      followerBalanceReconciliationDegraded: false,
      followerBalanceLastError: null,
      fundingKeyReady: null,
      fundingKeyCheckedAt: null,
      fundingWalletPubkey: null,
      lastError: null,
      identityMismatch: (otherRows?.length ?? 0) > 0,
    };
  }
  const updatedAtMs = new Date(data.updated_at).getTime();
  const online = Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs < 45_000;
  return {
    online,
    updatedAt: data.updated_at,
    geyserConnected: data.geyser_connected,
    lastGeyserMessageAt: data.last_geyser_message_at ?? null,
    decodedEventCount: Number(data.decoded_event_count),
    rpcLastPollAt: data.rpc_last_poll_at ?? null,
    rpcLastSuccessAt: data.rpc_last_success_at ?? null,
    rpcBacklogWalletCount: Math.max(0, Number(data.rpc_backlog_wallet_count ?? 0)),
    monitoringDegraded: data.monitoring_degraded === true,
    followerBalanceLastCheckedAt: data.follower_balance_last_checked_at ?? null,
    followerBalanceCandidateCount: Math.max(0, Number(data.follower_balance_candidate_count ?? 0)),
    followerBalanceMismatchCount: Math.max(0, Number(data.follower_balance_mismatch_count ?? 0)),
    followerBalanceReconciliationDegraded:
      typeof data.follower_balance_reconciliation_degraded === "boolean"
        ? data.follower_balance_reconciliation_degraded
        : true,
    followerBalanceLastError: data.follower_balance_last_error ?? null,
    fundingKeyReady: typeof data.funding_key_ready === "boolean" ? data.funding_key_ready : null,
    fundingKeyCheckedAt: data.funding_key_checked_at ?? null,
    fundingWalletPubkey: data.funding_wallet_pubkey ?? null,
    lastError: data.last_error ?? null,
    identityMismatch: false,
  };
});

function revivalReadError(error: { code?: string; message?: string }): never {
  if (
    error.code === "42P01" ||
    error.code === "42703" ||
    error.code === "PGRST204" ||
    error.code === "PGRST205"
  ) {
    throw new Error(
      "Revival storage is missing or outdated. Run supabase/revival-campaign-migration.sql; trading is unaffected.",
    );
  }
  throw new Error("Revival data is temporarily unavailable; trading is unaffected.");
}

export const getRevivalDashboard = createServerFn({ method: "GET" }).handler(
  async (): Promise<RevivalDashboardData> => {
    const db = adminClient();
    const userId = currentUserId();
    const [
      campaigns,
      heartbeat,
      totalCount,
      activeCount,
      entryReadyCount,
      ignitionCount,
      distributionCount,
      closedCount,
      invalidatedCount,
      coverageGapCount,
    ] = await Promise.all([
      db
        .from("revival_campaigns")
        .select("*")
        .eq("user_id", userId)
        .order("last_available_at", { ascending: false })
        .limit(250),
      db.from("revival_worker_heartbeat").select("*").eq("user_id", userId).maybeSingle(),
      db
        .from("revival_campaigns")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId),
      db
        .from("revival_campaigns")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .is("closed_at", null),
      db
        .from("revival_campaigns")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .is("closed_at", null)
        .eq("state", "ENTRY_READY"),
      db
        .from("revival_campaigns")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .is("closed_at", null)
        .eq("state", "RETAIL_IGNITION"),
      db
        .from("revival_campaigns")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .is("closed_at", null)
        .eq("state", "DISTRIBUTION_RISK"),
      db
        .from("revival_campaigns")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("state", "CLOSED"),
      db
        .from("revival_campaigns")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("state", "INVALIDATED"),
      db
        .from("revival_campaigns")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .is("closed_at", null)
        .or("coverage_status.neq.COMPLETE,state.eq.COVERAGE_GAP"),
    ]);
    for (const result of [
      campaigns,
      heartbeat,
      totalCount,
      activeCount,
      entryReadyCount,
      ignitionCount,
      distributionCount,
      closedCount,
      invalidatedCount,
      coverageGapCount,
    ]) {
      if (result.error) revivalReadError(result.error);
    }
    const summary: RevivalDashboardSummary = {
      active: activeCount.count ?? 0,
      entryReady: entryReadyCount.count ?? 0,
      ignition: ignitionCount.count ?? 0,
      distributionRisk: distributionCount.count ?? 0,
      closed: closedCount.count ?? 0,
      invalidated: invalidatedCount.count ?? 0,
      coverageGaps: coverageGapCount.count ?? 0,
    };
    return buildRevivalDashboard(
      (campaigns.data ?? []) as Array<Record<string, unknown>>,
      (heartbeat.data as Record<string, unknown> | null) ?? null,
      Date.now(),
      summary,
      totalCount.count ?? 0,
    );
  },
);

const RevivalCampaignDetailInputSchema = z.object({
  campaignId: z.string().uuid(),
});

export const getRevivalCampaignDetail = createServerFn({ method: "POST" })
  .validator((data) => RevivalCampaignDetailInputSchema.parse(data))
  .handler(async ({ data }): Promise<RevivalCampaignDetail> => {
    const db = adminClient();
    const userId = currentUserId();
    const campaignResult = await db
      .from("revival_campaigns")
      .select("*")
      .eq("user_id", userId)
      .eq("id", data.campaignId)
      .maybeSingle();
    if (campaignResult.error) revivalReadError(campaignResult.error);
    if (!campaignResult.data) throw new Error("Revival campaign was not found.");
    const campaignRow = campaignResult.data as Record<string, unknown>;
    const [events, transitions, snapshots, actions, outcome] = await Promise.all([
      db
        .from("revival_events")
        .select("*")
        .eq("user_id", userId)
        .eq("campaign_id", data.campaignId)
        .order("available_at", { ascending: true })
        .order("event_at", { ascending: true })
        .limit(5_000),
      db
        .from("revival_transitions")
        .select("*")
        .eq("user_id", userId)
        .eq("campaign_id", data.campaignId)
        .order("to_state_version", { ascending: true }),
      db
        .from("revival_market_snapshots")
        .select("*")
        .eq("user_id", userId)
        .eq("campaign_id", data.campaignId)
        .order("available_at", { ascending: true })
        .limit(5_000),
      db
        .from("revival_shadow_actions")
        .select("*")
        .eq("user_id", userId)
        .eq("campaign_id", data.campaignId)
        .order("decision_at", { ascending: true }),
      db
        .from("revival_outcomes")
        .select("*")
        .eq("user_id", userId)
        .eq("campaign_id", data.campaignId)
        .maybeSingle(),
    ]);
    const failed = [events, transitions, snapshots, actions, outcome].find(
      (result) => result.error,
    );
    if (failed?.error) revivalReadError(failed.error);
    return {
      campaign: revivalCampaignSummary(campaignRow),
      events: (events.data ?? []) as unknown as RevivalDetailRow[],
      transitions: (transitions.data ?? []) as unknown as RevivalDetailRow[],
      marketSnapshots: (snapshots.data ?? []) as unknown as RevivalDetailRow[],
      shadowActions: (actions.data ?? []) as unknown as RevivalDetailRow[],
      outcome: (outcome.data as unknown as RevivalDetailRow | null) ?? null,
    };
  });

export const getTrades = createServerFn({ method: "GET" }).handler(async () => {
  const db = adminClient();
  const { data, error } = await db
    .from("trades")
    .select("*")
    .eq("user_id", currentUserId())
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) throw new Error(error.message);
  return data ?? [];
});

export const getPositions = createServerFn({ method: "GET" }).handler(async () => {
  const db = adminClient();
  const { data, error } = await db
    .from("positions")
    .select("*")
    .eq("user_id", currentUserId())
    .is("closed_at", null)
    .order("opened_at", { ascending: false });

  if (error) throw new Error(error.message);
  return data ?? [];
});

export const getWalletHoldings = createServerFn({ method: "GET" }).handler(async () => {
  const db = adminClient();
  const { data, error } = await (db as any)
    .from("worker_heartbeat")
    .select("wallet_holdings")
    .eq("user_id", currentUserId())
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Array.isArray(data?.wallet_holdings) ? data.wallet_holdings : [];
});

export const getFollowers = createServerFn({ method: "GET" }).handler(async () => {
  const db = adminClient();
  const { data: positionsRaw, error: posErr } = await db
    .from("positions")
    .select("id, token_mint")
    .eq("user_id", currentUserId())
    .is("closed_at", null);
  if (posErr) throw new Error(posErr.message);
  const positions = (positionsRaw ?? []) as Array<{ id: string; token_mint: string }>;
  const posIds = positions.map((p) => p.id);
  const mintByPos = new Map(positions.map((p) => [p.id, p.token_mint]));
  type ManagedFollower = {
    wallet: string;
    position_id: string;
    initial_amount: number | string;
    current_amount: number | string;
    hop_depth: number | null;
    trigger_eligible: boolean;
    unexplained_outflow_amount: number | string;
    last_updated: string;
  };
  type ObservedFollower = {
    token_mint: string;
    wallet: string;
    amount: number | string;
    last_updated: string;
    source_target_count: number | string;
  };
  let fws: ManagedFollower[] = [];
  if (posIds.length > 0) {
    const { data: fwsRaw, error: fwErr } = await (db as any)
      .from("follower_wallets")
      .select(
        "wallet, position_id, initial_amount, current_amount, hop_depth, trigger_eligible, unexplained_outflow_amount, last_updated",
      )
      .in("position_id", posIds)
      .is("released_at", null)
      .order("last_updated", { ascending: false });
    if (fwErr) throw new Error(fwErr.message);
    fws = (fwsRaw ?? []) as ManagedFollower[];
  }

  const managed = fws.map((f) => {
    const initial = Number(f.initial_amount) || 0;
    const current = Number(f.current_amount) || 0;
    const heldPct = initial > 0 ? Math.max(0, Math.min(100, (current / initial) * 100)) : 0;
    return {
      wallet: f.wallet,
      position_id: f.position_id,
      token_mint: mintByPos.get(f.position_id) ?? "",
      current_amount: current,
      held_pct: heldPct,
      hop_depth: Math.max(1, Math.min(5, Number(f.hop_depth ?? 1))),
      last_updated: f.last_updated,
      observed_only: !f.trigger_eligible,
      unresolved_outflow_amount: Math.max(0, Number(f.unexplained_outflow_amount ?? 0)),
      source_target_count: null,
    };
  });

  const { data: heartbeat, error: observedError } = await (db as any)
    .from("worker_heartbeat")
    .select("observed_follower_holdings")
    .eq("user_id", currentUserId())
    .maybeSingle();
  if (observedError) throw new Error(observedError.message);
  const managedKeys = new Set(managed.map((f) => `${f.token_mint}:${f.wallet}`));
  const observedRows: ObservedFollower[] = Array.isArray(heartbeat?.observed_follower_holdings)
    ? (heartbeat.observed_follower_holdings as ObservedFollower[])
    : [];
  const observed = observedRows
    .filter((row) => !managedKeys.has(`${row.token_mint}:${row.wallet}`))
    .map((row) => ({
      wallet: row.wallet,
      position_id: null,
      token_mint: row.token_mint,
      current_amount: Math.max(0, Number(row.amount ?? 0)),
      held_pct: null,
      hop_depth: 1,
      last_updated: row.last_updated,
      observed_only: true,
      unresolved_outflow_amount: 0,
      source_target_count: Math.max(1, Number(row.source_target_count ?? 1)),
    }));

  return [...managed, ...observed];
});

export const getStrategyInsights = createServerFn({ method: "GET" }).handler(async () => {
  const db = adminClient();
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const { data, error } = await (db as any).rpc("strategy_insights", {
    p_user_id: currentUserId(),
    p_since: since,
  });
  if (error) throw new Error(error.message);
  return (
    data ?? {
      since,
      generated_at: new Date().toISOString(),
      total_observations: 0,
      target_buys: 0,
      target_sells: 0,
      target_transfers: 0,
      follower_sells: 0,
      unique_mints: 0,
      copied_buys: 0,
      filtered_buys: 0,
      failed_actions: 0,
      median_buy_reaction_ms: null,
      median_buy_execution_ms: null,
      median_sell_reaction_ms: null,
      median_sell_execution_ms: null,
      learning_confidence_pct: 0,
      top_filter_reasons: [],
      median_target_buy_usd: null,
      median_entry_market_cap_usd: null,
      median_entry_liquidity_usd: null,
      average_transfer_recipients: null,
      most_active_hour_utc: null,
      recent: [],
    }
  );
});

const CustodyDashboardInputSchema = z
  .object({
    window: z.enum(["24h", "7d", "30d", "all"]),
    limit: z.number().int().min(5).max(100).default(30),
  })
  .strict();
const CustodyJourneyDetailInputSchema = z.object({ journeyId: z.string().uuid() }).strict();
const CustodyWalletManualTypeSchema = z.enum([
  "unknown",
  "exchange",
  "cold_storage_candidate",
  "hot_wallet_candidate",
  "routing_wallet",
  "custody",
  "bridge",
  "vault",
  "other",
]);
const CustodyWalletLabelInputSchema = z
  .object({
    wallet: z.string().trim().refine(isSolanaPublicKey, "Invalid Solana wallet address"),
    label: z.string().trim().min(1, "Wallet label is required").max(80),
    type: CustodyWalletManualTypeSchema,
  })
  .strict();
const CUSTODY_JOURNEY_READ_CAP = 100;
const CUSTODY_WALLET_READ_CAP = 5_000;
const CUSTODY_EVENT_READ_CAP = 5_000;
const CUSTODY_PROFILE_READ_CAP = 5_000;
const CUSTODY_COVERAGE_REASON_READ_CAP = 10_000;

async function readCustodyCoverageReasons(
  db: ReturnType<typeof adminClient>,
  userId: string,
  journeyIds: string[],
): Promise<{ rows: CustodyCoverageReasonRow[]; complete: boolean }> {
  if (journeyIds.length === 0) return { rows: [], complete: true };
  const [eventReasons, inboxReasons] = await Promise.all([
    db
      .from("custody_journey_events")
      .select("journey_id,result_reason", { count: "exact" })
      .eq("user_id", userId)
      .in("journey_id", journeyIds)
      .not("result_reason", "is", null)
      .limit(CUSTODY_COVERAGE_REASON_READ_CAP),
    db
      .from("custody_pending_events")
      .select("journey_id,status,last_error_code", { count: "exact" })
      .eq("user_id", userId)
      .in("journey_id", journeyIds)
      .in("status", ["pending", "expired", "terminal"])
      .limit(CUSTODY_COVERAGE_REASON_READ_CAP),
  ]);
  if (eventReasons.error) custodyReadError(eventReasons.error);
  if (inboxReasons.error) custodyReadError(inboxReasons.error);
  const eventRows = (eventReasons.data ?? []).flatMap((row) =>
    typeof row.journey_id === "string"
      ? [{ journeyId: row.journey_id, reason: row.result_reason ?? null }]
      : [],
  );
  const inboxRows = (inboxReasons.data ?? []).flatMap((row) =>
    typeof row.journey_id === "string"
      ? [
          {
            journeyId: row.journey_id,
            // Status is material evidence too: an unresolved pending row is
            // partial coverage even when its last error is only "upstream".
            reason: `${String(row.status ?? "unknown")}_${String(row.last_error_code ?? "unknown")}`,
          },
        ]
      : [],
  );
  const rows = [...eventRows, ...inboxRows];
  const available =
    Number(eventReasons.count ?? eventRows.length) + Number(inboxReasons.count ?? inboxRows.length);
  return { rows, complete: rows.length >= available };
}

function custodyReadError(error: unknown): never {
  const errorRecord = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const code = typeof errorRecord.code === "string" ? errorRecord.code : "";
  if (code === "42P01" || code === "PGRST205") {
    throw new Error(
      "Custody Journey storage is not installed yet. Apply the Custody Journey migration first.",
    );
  }
  throw new Error("Custody Journey data is temporarily unavailable. Trading is unaffected.");
}

/**
 * Read-only observation data. Every table read is scoped to the current user,
 * and this function has no dependency on entry or exit configuration.
 */
export const getCustodyDashboard = createServerFn({ method: "POST" })
  .validator((data) => CustodyDashboardInputSchema.parse(data))
  .handler(async ({ data }): Promise<CustodyDashboardData> => {
    const db = adminClient();
    const userId = currentUserId();
    const since = custodyWindowSince(data.window);
    let journeyQuery = db
      .from("custody_journeys")
      .select("*", { count: "exact" })
      .eq("user_id", userId);
    if (since) journeyQuery = journeyQuery.gte("last_activity_at", since);
    const [
      journeysResult,
      heartbeatResult,
      pendingEventsResult,
      waitingEventsResult,
      dormantEventsResult,
      expiredEventsResult,
      terminalEventsResult,
    ] = await Promise.all([
      journeyQuery
        .order("last_activity_at", { ascending: false })
        .order("id", { ascending: true })
        .limit(CUSTODY_JOURNEY_READ_CAP),
      db.from("custody_worker_heartbeat").select("*").eq("user_id", userId).maybeSingle(),
      db
        .from("custody_pending_events")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("status", "pending")
        .in("queue_state", ["ready", "transient_retry"]),
      db
        .from("custody_pending_events")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("status", "pending")
        .eq("queue_state", "waiting_dependency"),
      db
        .from("custody_pending_events")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("status", "pending")
        .eq("queue_state", "dormant_scope"),
      db
        .from("custody_pending_events")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("status", "expired")
        .not("journey_id", "is", null),
      db
        .from("custody_pending_events")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("status", "terminal")
        .not("journey_id", "is", null),
    ]);
    if (journeysResult.error) custodyReadError(journeysResult.error);
    if (heartbeatResult.error) custodyReadError(heartbeatResult.error);
    const inboxFailure = [
      pendingEventsResult,
      waitingEventsResult,
      dormantEventsResult,
      expiredEventsResult,
      terminalEventsResult,
    ].find((result) => result.error);
    if (inboxFailure?.error) custodyReadError(inboxFailure.error);

    const journeys = (journeysResult.data ?? []) as CustodyJourneyRow[];
    const heartbeat = heartbeatResult.data as CustodyWorkerHeartbeatRow | null;
    const pendingEvents = {
      pending: Number(pendingEventsResult.count ?? 0),
      waiting: Number(waitingEventsResult.count ?? 0),
      dormant: Number(dormantEventsResult.count ?? 0),
      expired: Number(expiredEventsResult.count ?? 0),
      terminal: Number(terminalEventsResult.count ?? 0),
    };
    const journeyIds = journeys.map((journey) => journey.id);
    if (journeyIds.length === 0) {
      return buildCustodyDashboardData({
        window: data.window,
        journeys: [],
        wallets: [],
        events: [],
        profiles: [],
        heartbeat,
        pendingEvents,
        limit: data.limit,
        available: {
          journeyRowsAvailable: Number(journeysResult.count ?? 0),
          walletRowsAvailable: 0,
          eventRowsAvailable: 0,
        },
      });
    }

    let eventQuery = db
      .from("custody_journey_events")
      .select("*", { count: "exact" })
      .eq("user_id", userId)
      .in("journey_id", journeyIds);
    if (since) eventQuery = eventQuery.gte("event_at", since);
    const [walletsResult, eventsResult, profilesResult, coverageReasons] = await Promise.all([
      db
        .from("custody_journey_wallets")
        .select("*", { count: "exact" })
        .eq("user_id", userId)
        .in("journey_id", journeyIds)
        .order("last_activity_at", { ascending: false })
        .limit(CUSTODY_WALLET_READ_CAP),
      eventQuery
        .order("event_at", { ascending: false })
        .order("event_key", { ascending: true })
        .limit(CUSTODY_EVENT_READ_CAP),
      db
        .from("custody_wallet_profiles")
        .select("*")
        .eq("user_id", userId)
        .order("last_seen_at", { ascending: false })
        .limit(CUSTODY_PROFILE_READ_CAP),
      readCustodyCoverageReasons(db, userId, journeyIds),
    ]);
    const failed = [walletsResult, eventsResult, profilesResult].find((result) => result.error);
    if (failed?.error) custodyReadError(failed.error);

    return buildCustodyDashboardData({
      window: data.window,
      journeys,
      wallets: (walletsResult.data ?? []) as CustodyJourneyWalletRow[],
      events: (eventsResult.data ?? []) as CustodyJourneyEventRow[],
      profiles: (profilesResult.data ?? []) as CustodyWalletProfileRow[],
      heartbeat,
      pendingEvents,
      coverageReasons: coverageReasons.rows,
      coverageReasonsComplete: coverageReasons.complete,
      limit: data.limit,
      available: {
        journeyRowsAvailable: Number(journeysResult.count ?? journeys.length),
        walletRowsAvailable: Number(walletsResult.count ?? walletsResult.data?.length ?? 0),
        eventRowsAvailable: Number(eventsResult.count ?? eventsResult.data?.length ?? 0),
      },
    });
  });

/** Detail rows are loaded only when the dashboard opens a journey. */
export const getCustodyJourney = createServerFn({ method: "POST" })
  .validator((data) => CustodyJourneyDetailInputSchema.parse(data))
  .handler(async ({ data }): Promise<CustodyJourneyDetailData> => {
    const db = adminClient();
    const userId = currentUserId();
    const journeyResult = await db
      .from("custody_journeys")
      .select("*")
      .eq("user_id", userId)
      .eq("id", data.journeyId)
      .maybeSingle();
    if (journeyResult.error) custodyReadError(journeyResult.error);
    if (!journeyResult.data) throw new Error("Custody journey was not found.");

    const [walletsResult, eventsResult, profilesResult, coverageReasons] = await Promise.all([
      db
        .from("custody_journey_wallets")
        .select("*", { count: "exact" })
        .eq("user_id", userId)
        .eq("journey_id", data.journeyId)
        .order("hop_depth", { ascending: true })
        .order("first_seen_at", { ascending: true })
        .limit(CUSTODY_WALLET_READ_CAP),
      db
        .from("custody_journey_events")
        .select("*", { count: "exact" })
        .eq("user_id", userId)
        .eq("journey_id", data.journeyId)
        .order("event_at", { ascending: true })
        .order("event_key", { ascending: true })
        .limit(CUSTODY_EVENT_READ_CAP),
      db
        .from("custody_wallet_profiles")
        .select("*")
        .eq("user_id", userId)
        .order("last_seen_at", { ascending: false })
        .limit(CUSTODY_PROFILE_READ_CAP),
      readCustodyCoverageReasons(db, userId, [data.journeyId]),
    ]);
    const failed = [walletsResult, eventsResult, profilesResult].find((result) => result.error);
    if (failed?.error) custodyReadError(failed.error);

    return buildCustodyJourneyDetail({
      journey: journeyResult.data as CustodyJourneyRow,
      wallets: (walletsResult.data ?? []) as CustodyJourneyWalletRow[],
      events: (eventsResult.data ?? []) as CustodyJourneyEventRow[],
      profiles: (profilesResult.data ?? []) as CustodyWalletProfileRow[],
      coverageReasons: coverageReasons.rows,
      coverageReasonsComplete: coverageReasons.complete,
      availableWalletCount: Number(walletsResult.count ?? walletsResult.data?.length ?? 0),
      availableEventCount: Number(eventsResult.count ?? eventsResult.data?.length ?? 0),
    });
  });

/**
 * Saves an explicit user annotation. A manual label is display metadata only:
 * it does not change inferred evidence, watching, journey accounting, or trades.
 */
export const saveCustodyWalletLabel = createServerFn({ method: "POST" })
  .validator((data) => CustodyWalletLabelInputSchema.parse(data))
  .handler(async ({ data }) => {
    const db = adminClient();
    const userId = currentUserId();
    const existing = await db
      .from("custody_wallet_profiles")
      .select("wallet")
      .eq("user_id", userId)
      .eq("wallet", data.wallet)
      .maybeSingle();
    if (existing.error) custodyReadError(existing.error);

    if (existing.data) {
      const updated = await db
        .from("custody_wallet_profiles")
        .update({
          manual_type: data.type,
          manual_label: data.label,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId)
        .eq("wallet", data.wallet)
        .select("wallet")
        .maybeSingle();
      if (updated.error) custodyReadError(updated.error);
      if (!updated.data) throw new Error("The wallet label could not be saved.");
    } else {
      const observedAt = new Date().toISOString();
      const inserted = await db.from("custody_wallet_profiles").insert({
        user_id: userId,
        wallet: data.wallet,
        inferred_type: "unknown",
        inferred_label: null,
        inference_confidence: 0,
        inference_source: "manual_only",
        manual_type: data.type,
        manual_label: data.label,
        first_seen_at: observedAt,
        last_seen_at: observedAt,
      });
      if (inserted.error) custodyReadError(inserted.error);
    }
    return { ok: true as const };
  });

const ConvictionWindowSchema = z.union([z.literal(5), z.literal(30), z.literal(60)]);
const ConvictionDashboardInputSchema = z.object({ windowMinutes: ConvictionWindowSchema });
const ConvictionTokenDetailInputSchema = z.object({
  tokenMint: z
    .string()
    .trim()
    .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Invalid Solana token mint"),
});

type UnknownRow = Record<string, unknown>;

function convictionNumber(value: unknown, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function convictionNullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function convictionText(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function convictionNullableText(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function convictionStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function convictionJson(value: unknown): SerializableJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(convictionJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        convictionJson(item),
      ]),
    );
  }
  return null;
}

function convictionObject(value: unknown): { [key: string]: SerializableJson } {
  const normalized = convictionJson(value);
  return normalized && typeof normalized === "object" && !Array.isArray(normalized)
    ? normalized
    : {};
}

function convictionNumberObject(value: unknown): Record<string, number> {
  return Object.fromEntries(
    Object.entries(convictionObject(value))
      .map(([key, amount]) => [key, Number(amount)] as const)
      .filter((entry) => Number.isFinite(entry[1])),
  );
}

function mapConvictionState(row: UnknownRow): ConvictionTokenStateRow {
  const state = convictionText(row.conviction_state, "TESTING");
  const direction = convictionText(row.rank_direction, "new");
  return {
    token_mint: convictionText(row.token_mint),
    symbol: convictionNullableText(row.symbol),
    first_seen_at: convictionText(row.first_seen_at),
    last_activity_at: convictionText(row.last_activity_at),
    gross_cluster_buys_usd: convictionNumber(row.gross_cluster_buys_usd),
    gross_cluster_sells_usd: convictionNumber(row.gross_cluster_sells_usd),
    net_cluster_investment_usd: convictionNumber(row.net_cluster_investment_usd),
    wallet_net_usd: convictionNumberObject(row.wallet_net_usd),
    buy_count: convictionNumber(row.buy_count),
    sell_count: convictionNumber(row.sell_count),
    largest_buy_usd: convictionNumber(row.largest_buy_usd),
    last_buy_usd: convictionNumber(row.last_buy_usd),
    average_buy_usd: convictionNumber(row.average_buy_usd),
    median_buy_usd: convictionNumber(row.median_buy_usd),
    wallets_that_bought: convictionStringArray(row.wallets_that_bought),
    wallets_currently_accumulating: convictionStringArray(row.wallets_currently_accumulating),
    market_cap_usd: convictionNullableNumber(row.market_cap_usd),
    market_cap_at_first_cluster_buy_usd: convictionNullableNumber(
      row.market_cap_at_first_cluster_buy_usd,
    ),
    liquidity_usd: convictionNullableNumber(row.liquidity_usd),
    our_current_position_usd: convictionNumber(row.our_current_position_usd),
    net_flow_1m_usd: convictionNumber(row.net_flow_1m_usd),
    net_flow_5m_usd: convictionNumber(row.net_flow_5m_usd),
    net_flow_30m_usd: convictionNumber(row.net_flow_30m_usd),
    net_flow_60m_usd: convictionNumber(row.net_flow_60m_usd),
    capital_velocity_usd_per_min: convictionNumber(
      row.capital_velocity_usd_per_minute ?? row.capital_velocity_usd_per_min,
    ),
    capital_acceleration_ratio: convictionNumber(row.capital_acceleration_ratio),
    buy_size_acceleration_ratio: convictionNumber(row.buy_size_acceleration_ratio),
    wallet_convergence_count: convictionNumber(row.wallet_convergence_count),
    conviction_score: convictionNumber(row.conviction_score),
    conviction_state: ([
      "TESTING",
      "WATCHING",
      "ACCUMULATING",
      "BETTING",
      "HIGH_CONVICTION",
      "DISTRIBUTING",
    ].includes(state)
      ? state
      : "TESTING") as ConvictionTokenStateRow["conviction_state"],
    score_reasons: convictionStringArray(row.score_reasons),
    current_rank: convictionNullableNumber(row.current_rank),
    previous_rank: convictionNullableNumber(row.previous_rank),
    rank_direction: (["up", "down", "flat", "new", "unranked"].includes(direction)
      ? direction
      : "new") as ConvictionTokenStateRow["rank_direction"],
    time_in_top_10_seconds: convictionNumber(row.time_in_top_10_seconds),
    time_in_top_3_seconds: convictionNumber(row.time_in_top_3_seconds),
    time_at_rank_one_seconds: convictionNumber(row.time_at_rank_one_seconds),
    rapid_follow_status: convictionText(row.rapid_follow_status, "inactive"),
    data_reliable: row.data_reliable === true,
    last_ranked_at: convictionNullableText(row.last_ranked_at),
    updated_at: convictionText(row.updated_at),
    rolling_metrics: convictionObject(row.rolling_metrics),
  };
}

function mapConvictionRank(row: UnknownRow): ConvictionRankRow {
  const window = convictionNumber(row.window_minutes, 30);
  return {
    token_mint: convictionText(row.token_mint),
    window_minutes: (window === 5 || window === 60
      ? window
      : 30) as ConvictionRankRow["window_minutes"],
    rank: convictionNumber(row.rank),
    previous_rank: convictionNullableNumber(row.previous_rank),
    conviction_score: convictionNumber(row.conviction_score),
    net_flow_usd: convictionNumber(row.net_flow_usd),
    capital_velocity_usd_per_min: convictionNumber(
      row.capital_velocity_usd_per_minute ?? row.capital_velocity_usd_per_min,
    ),
    recorded_at: convictionText(row.ranking_at ?? row.recorded_at ?? row.ranked_at),
  };
}

function mapConvictionEvent(row: UnknownRow): ConvictionEventRow {
  const side = convictionText(row.side);
  return {
    event_key: convictionText(row.event_key),
    tx_sig: convictionText(row.tx_sig),
    event_at: convictionText(row.event_at),
    actor_wallet: convictionText(row.wallet ?? row.actor_wallet),
    token_mint: convictionText(row.token_mint),
    classification: convictionText(row.classification, "UNKNOWN"),
    side:
      side === "buy" || side === "sell"
        ? side
        : row.classification === "DEX_BUY"
          ? "buy"
          : row.classification === "DEX_SELL"
            ? "sell"
            : null,
    amount_tokens: convictionNumber(row.amount_tokens),
    amount_usd: convictionNullableNumber(row.amount_usd),
    market_cap_usd: convictionNullableNumber(row.market_cap_usd),
    liquidity_usd: convictionNullableNumber(row.liquidity_usd),
    data_reliable: row.classification_reliable === true || row.data_reliable === true,
    metadata: convictionObject(row.metadata),
  };
}

function mapConvictionTransition(row: UnknownRow): ConvictionTransitionRow {
  const states = new Set([
    "TESTING",
    "WATCHING",
    "ACCUMULATING",
    "BETTING",
    "HIGH_CONVICTION",
    "DISTRIBUTING",
  ]);
  const previousState = convictionNullableText(row.previous_state);
  const newState = convictionNullableText(row.new_state);
  return {
    token_mint: convictionText(row.token_mint),
    event_type: convictionText(row.event_type ?? row.transition_type),
    previous_state: (previousState && states.has(previousState)
      ? previousState
      : null) as ConvictionTransitionRow["previous_state"],
    new_state: (newState && states.has(newState)
      ? newState
      : null) as ConvictionTransitionRow["new_state"],
    previous_score: convictionNullableNumber(row.previous_score),
    new_score: convictionNullableNumber(row.new_score),
    reasons: convictionStringArray(row.reasons),
    occurred_at: convictionText(row.occurred_at ?? row.created_at),
    metadata: convictionObject(row.metadata),
  };
}

function mapConvictionTier(row: UnknownRow): ConvictionTierRow {
  return {
    token_mint: convictionText(row.token_mint),
    tier_number: convictionNumber(row.tier_number),
    status: convictionText(row.status),
    trading_mode: row.trading_mode === "live" ? "live" : "shadow",
    amount_usd: convictionNumber(row.buy_usd ?? row.amount_usd),
    commitment_usd: convictionNumber(row.commitment_threshold_usd ?? row.commitment_usd),
    source_event_key: convictionNullableText(row.source_event_key),
    bot_tx_sig: convictionNullableText(row.bot_tx_sig),
    executed_at: convictionNullableText(
      row.persisted_at ?? row.landed_at ?? row.submission_started_at ?? row.claimed_at,
    ),
    updated_at: convictionText(row.updated_at),
    metadata: convictionObject(row.metadata),
  };
}

function throwConvictionReadError(error: unknown): never {
  const record = convictionObject(error);
  const code = convictionText(record.code);
  if (code === "42P01" || code === "PGRST205") {
    throw new Error(
      "Conviction storage is not installed yet. Apply the Conviction migration first.",
    );
  }
  throw new Error("Conviction data is temporarily unavailable. Trading is unaffected.");
}

export const getConvictionDashboard = createServerFn({ method: "POST" })
  .validator((data) => ConvictionDashboardInputSchema.parse(data))
  .handler(async ({ data }): Promise<ConvictionDashboardData> => {
    const db = adminClient();
    const userId = currentUserId();
    // The 15-second leaderboard poll needs only the authoritative current
    // state. Rank history, transitions, and tiers are loaded on demand in the
    // token detail dialog instead of re-reading thousands of historical rows.
    const states = await db
      .from("conviction_token_state")
      .select("*")
      .eq("user_id", userId)
      .gte("last_activity_at", new Date(Date.now() - 65 * 60_000).toISOString())
      .order("last_activity_at", { ascending: false })
      .limit(1_000);
    if (states.error) throwConvictionReadError(states.error);

    return {
      windowMinutes: data.windowMinutes,
      generatedAt: new Date().toISOString(),
      states: ((states.data ?? []) as UnknownRow[]).map(mapConvictionState),
    };
  });

export const getConvictionTokenDetail = createServerFn({ method: "POST" })
  .validator((data) => ConvictionTokenDetailInputSchema.parse(data))
  .handler(async ({ data }): Promise<ConvictionTokenDetailData> => {
    const db = adminClient();
    const userId = currentUserId();
    const [state, events, ranks, transitions, tiers] = await Promise.all([
      db
        .from("conviction_token_state")
        .select("*")
        .eq("user_id", userId)
        .eq("token_mint", data.tokenMint)
        .maybeSingle(),
      db
        .from("conviction_events")
        .select("*")
        .eq("user_id", userId)
        .eq("token_mint", data.tokenMint)
        .order("event_at", { ascending: false })
        .limit(150),
      db
        .from("conviction_rank_history")
        .select("*")
        .eq("user_id", userId)
        .eq("token_mint", data.tokenMint)
        .order("ranking_at", { ascending: false })
        .limit(300),
      db
        .from("conviction_transitions")
        .select("*")
        .eq("user_id", userId)
        .eq("token_mint", data.tokenMint)
        .order("occurred_at", { ascending: false })
        .limit(100),
      db
        .from("conviction_tiers")
        .select("*")
        .eq("user_id", userId)
        .eq("token_mint", data.tokenMint)
        .order("tier_number", { ascending: true })
        .limit(20),
    ]);
    const failed = [state, events, ranks, transitions, tiers].find((result) => result.error);
    if (failed?.error) throwConvictionReadError(failed.error);

    const buys = ((events.data ?? []) as UnknownRow[])
      .map(mapConvictionEvent)
      .filter((event) => event.classification === "DEX_BUY" || event.side === "buy")
      .reverse();
    return {
      state: state.data ? mapConvictionState(state.data as UnknownRow) : null,
      buys,
      ranks: ((ranks.data ?? []) as UnknownRow[]).map(mapConvictionRank),
      transitions: ((transitions.data ?? []) as UnknownRow[]).map(mapConvictionTransition),
      tiers: ((tiers.data ?? []) as UnknownRow[]).map(mapConvictionTier),
    };
  });

const ConvictionBacktestSettingsSchema = z
  .object({
    sinceDays: z.number().int().min(1).max(365),
    rapidFollowEnabled: z.boolean(),
    leaderboardWindowMinutes: ConvictionWindowSchema,
    scoreThreshold: z.number().min(0).max(100),
    topN: z.number().int().min(1).max(10),
    minNetCommitmentUsd: z.number().min(0).max(100_000_000),
    minRecentNetInflowUsd: z.number().min(0).max(100_000_000),
    minCapitalVelocityUsdPerMinute: z.number().min(0).max(100_000_000),
    minCapitalAccelerationRatio: z.number().min(0).max(100),
    minConvergedWallets: z.number().int().min(1).max(3),
    twoWalletWindowSeconds: z.number().int().min(1).max(86_400),
    threeWalletWindowSeconds: z.number().int().min(1).max(86_400),
    minIndividualBuyUsd: z.number().min(0).max(100_000_000),
    marketCapFilterEnabled: z.boolean(),
    marketCapMinUsd: z.number().min(0).max(100_000_000_000),
    marketCapMaxUsd: z.number().min(0).max(100_000_000_000),
    liquidityFilterEnabled: z.boolean(),
    liquidityMinUsd: z.number().min(0).max(100_000_000_000),
    liquidityMaxUsd: z.number().min(0).max(100_000_000_000),
    tokenAgeFilterEnabled: z.boolean(),
    tokenAgeMinMinutes: z.number().min(0).max(10_000_000),
    tokenAgeMaxMinutes: z.number().min(0).max(10_000_000),
    maxPositionPerTokenUsd: z.number().positive().max(10_000_000),
    dataFreshnessSeconds: z.number().int().min(1).max(86_400),
    rankLossGraceSeconds: z.number().int().min(0).max(86_400),
    lifecycleNewMinutes: z.number().int().min(1).max(10_000_000),
    lifecycleRevivalInactivityMinutes: z.number().int().min(1).max(10_000_000),
    distributionSellRatio: z.number().min(0).max(1),
    distributionMinSellsUsd: z.number().min(0).max(100_000_000),
    distributionWalletCount: z.number().int().min(1).max(3),
    tier1BuyUsd: z.number().positive().max(10_000_000),
    tier1MinCommitmentUsd: z.number().positive().max(100_000_000),
    tier2BuyUsd: z.number().positive().max(10_000_000),
    tier2MinCommitmentUsd: z.number().positive().max(100_000_000),
    tier3BuyUsd: z.number().positive().max(10_000_000),
    tier3MinCommitmentUsd: z.number().positive().max(100_000_000),
    tier4BuyUsd: z.number().positive().max(10_000_000),
    tier4MinCommitmentUsd: z.number().positive().max(100_000_000),
    weightNetCommitment: z.number().min(0).max(100),
    weightVelocity: z.number().min(0).max(100),
    weightAcceleration: z.number().min(0).max(100),
    weightConvergence: z.number().min(0).max(100),
    weightPersistence: z.number().min(0).max(100),
  })
  .refine(
    (settings) =>
      settings.weightNetCommitment +
        settings.weightVelocity +
        settings.weightAcceleration +
        settings.weightConvergence +
        settings.weightPersistence >
      0,
    { message: "At least one Conviction score weight must be positive" },
  )
  .refine((settings) => settings.marketCapMaxUsd >= settings.marketCapMinUsd, {
    message: "Market-cap maximum must be at least the minimum",
  })
  .refine((settings) => settings.liquidityMaxUsd >= settings.liquidityMinUsd, {
    message: "Liquidity maximum must be at least the minimum",
  })
  .refine((settings) => settings.tokenAgeMaxMinutes >= settings.tokenAgeMinMinutes, {
    message: "Token-age maximum must be at least the minimum",
  })
  .refine(
    (settings) =>
      settings.tier1MinCommitmentUsd <= settings.tier2MinCommitmentUsd &&
      settings.tier2MinCommitmentUsd <= settings.tier3MinCommitmentUsd &&
      settings.tier3MinCommitmentUsd <= settings.tier4MinCommitmentUsd,
    { message: "Rapid Follow commitment thresholds must be in ascending order" },
  )
  .refine(
    (settings) =>
      settings.tier1BuyUsd + settings.tier2BuyUsd + settings.tier3BuyUsd + settings.tier4BuyUsd <=
      settings.maxPositionPerTokenUsd,
    { message: "Rapid Follow tier buys cannot exceed the per-token exposure cap" },
  );

function historicalTokenCreatedAtMs(metadata: unknown): number | null {
  const record = convictionObject(metadata);
  for (const key of ["token_created_at_ms", "tokenCreatedAtMs", "created_at_ms"]) {
    const parsed = convictionNumber(record[key], Number.NaN);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  for (const key of ["token_created_at", "tokenCreatedAt", "created_at"]) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function explicitHistoricalObservedAtMs(
  metadata: UnknownRow,
  camelKey: string,
  snakeKey: string,
): number | null {
  const value = convictionNullableNumber(metadata[camelKey] ?? metadata[snakeKey]);
  return value !== null && value > 0 ? value : null;
}

const HISTORICAL_BUY_VALUATION_SOURCES = new Set(["stablecoin", "input-token-quote", "sol"]);

/**
 * Strategy observations predate the dedicated Conviction event table, so they
 * do not all carry one uniform `classification_reliable` column. Accept only
 * rows with enough persisted evidence to reproduce the worker's conservative
 * swap classification; absence of proof is not treated as proof.
 */
type HistoricalSwapEvidence = "accepted" | "unverified" | "delayed-valuation";

function productionEquivalentHistoricalSwapEvidence(row: UnknownRow): HistoricalSwapEvidence {
  const eventKey = convictionText(row.event_key);
  const eventAt = convictionText(row.event_at);
  const detectedAt = convictionText(row.detected_at);
  const side = convictionText(row.side);
  const source = convictionText(row.source);
  const txSig = convictionText(row.tx_sig);
  const actorWallet = convictionText(row.actor_wallet);
  const tokenMint = convictionText(row.token_mint);
  const amountUsd = convictionNullableNumber(row.amount_usd);
  if (
    !eventKey ||
    !Number.isFinite(new Date(eventAt).getTime()) ||
    !Number.isFinite(new Date(detectedAt).getTime()) ||
    !actorWallet ||
    !tokenMint ||
    (side !== "buy" && side !== "sell") ||
    (source !== "geyser" && source !== "rpc") ||
    !txSig ||
    amountUsd === null ||
    amountUsd <= 0
  ) {
    return "unverified";
  }

  const metadata = convictionObject(row.metadata);
  const classificationReliable =
    metadata.classificationReliable === true || metadata.classification_reliable === true;
  const verifiedSwap = metadata.verifiedSwap === true;
  const valuationSource = convictionText(metadata.valuationSource);
  let classificationVerified = false;
  if (side === "buy") {
    // A valuation and a later bot decision cannot turn an unverified decode
    // into a production Conviction buy. Require both swap evidence and the
    // same historical valuation sources accepted by the worker.
    classificationVerified =
      (classificationReliable || verifiedSwap) &&
      HISTORICAL_BUY_VALUATION_SOURCES.has(valuationSource);
  } else {
    classificationVerified =
      classificationReliable ||
      (verifiedSwap &&
        (metadata.sellAttributionVerified === true || metadata.sell_attribution_verified === true));
    if (!classificationVerified) {
      const decision = convictionText(row.bot_decision);
      const reason = convictionText(row.bot_reason).toLowerCase();
      if (decision && reason && !/ambiguous|unverified|rejected.*recipient/.test(reason)) {
        // These reasons are emitted only after the direct-target-sell handler's
        // verified swap + verified sell-attribution gate. Mode-off observations
        // are deliberately excluded because they are recorded before that gate.
        classificationVerified =
          reason.includes("verified target sale") ||
          reason.includes("verified linked target sell") ||
          reason.includes("historical target sale recovered") ||
          reason.includes("target sell predates or has no open linked position");
      }
    }
  }
  if (!classificationVerified) return "unverified";

  const valuationProceedsMint = convictionNullableText(
    metadata.proceedsMint ?? metadata.proceeds_mint,
  );
  const valuationObservedAtMs = explicitHistoricalObservedAtMs(
    metadata,
    "valuationObservedAtMs",
    "valuation_observed_at_ms",
  );
  return historicalValuationIsCausal({
    eventAt,
    detectedAt,
    valuationSource,
    valuationProceedsMint,
    valuationObservedAtMs,
  })
    ? "accepted"
    : "delayed-valuation";
}

const BACKTEST_ROW_CAP = 25_000;
const BACKTEST_PAGE_SIZE = 1_000;

export const runConvictionBacktest = createServerFn({ method: "POST" })
  .validator((data) => ConvictionBacktestSettingsSchema.parse(data))
  .handler(async ({ data }): Promise<ConvictionBacktestResult> => {
    const settings = data as ConvictionBacktestSettings;
    const db = adminClient();
    const userId = currentUserId();
    const { data: configRow, error: configError } = await db
      .from("bot_config")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (configError)
      throw new Error("Could not load the authoritative target-wallet configuration.");
    if (!configRow) throw new Error("The authoritative bot configuration row is missing.");
    const botConfig = rowToConfig(configRow);
    const clusterWallets = Array.from(
      new Set(
        [botConfig.targetWallet, ...botConfig.additionalTargetWallets]
          .map((wallet) => wallet.trim())
          .filter(Boolean),
      ),
    );
    if (clusterWallets.length === 0)
      throw new Error("No target wallets are configured for this backtest.");

    const requestedSince = new Date(Date.now() - settings.sinceDays * 86_400_000).toISOString();
    const rows: UnknownRow[] = [];
    for (let offset = 0; offset < BACKTEST_ROW_CAP; offset += BACKTEST_PAGE_SIZE) {
      const pageSize = Math.min(BACKTEST_PAGE_SIZE, BACKTEST_ROW_CAP - offset);
      const { data: page, error } = await db
        .from("strategy_observations")
        .select(
          "event_key,tx_sig,source,event_at,detected_at,side,actor_wallet,token_mint,amount_usd,amount_tokens,market_cap_usd,liquidity_usd,bot_decision,bot_reason,metadata",
        )
        .eq("user_id", userId)
        .eq("relationship", "target")
        .eq("event_kind", "swap")
        .in("side", ["buy", "sell"])
        .in("actor_wallet", clusterWallets)
        .gte("event_at", requestedSince)
        .order("event_at", { ascending: true })
        .order("event_key", { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) {
        const errorRecord = convictionObject(error);
        if (["42P01", "PGRST205"].includes(convictionText(errorRecord.code))) {
          throw new Error("Strategy Lab history is not installed yet. Apply its migration first.");
        }
        throw new Error("Historical Strategy Lab data is temporarily unavailable.");
      }
      const pageRows = (page ?? []) as UnknownRow[];
      rows.push(...pageRows);
      if (pageRows.length < pageSize) break;
    }

    const observationsWithUsd = rows.filter((row) => {
      const amount = convictionNullableNumber(row.amount_usd);
      return amount !== null && amount > 0;
    });
    const evidenceRows = observationsWithUsd.map((row) => ({
      row,
      evidence: productionEquivalentHistoricalSwapEvidence(row),
    }));
    const productionEquivalentRows = evidenceRows
      .filter(({ evidence }) => evidence === "accepted")
      .map(({ row }) => row);
    const replayRows: ConvictionHistoricalObservation[] = productionEquivalentRows.flatMap(
      (row) => {
        const side = convictionText(row.side);
        const eventAt = convictionText(row.event_at);
        const detectedAt = convictionText(row.detected_at);
        const timestampMs = new Date(eventAt).getTime();
        const actorWallet = convictionText(row.actor_wallet);
        const tokenMint = convictionText(row.token_mint);
        const amountUsd = convictionNullableNumber(row.amount_usd);
        const metadata = convictionObject(row.metadata);
        const valuationObservedAtMs = explicitHistoricalObservedAtMs(
          metadata,
          "valuationObservedAtMs",
          "valuation_observed_at_ms",
        );
        const marketDataObservedAtMs = explicitHistoricalObservedAtMs(
          metadata,
          "marketDataObservedAtMs",
          "market_data_observed_at_ms",
        );
        const marketDataCausal = historicalMarketDataIsCausal({
          eventAt,
          marketDataObservedAtMs,
        });
        if (
          (side !== "buy" && side !== "sell") ||
          !Number.isFinite(timestampMs) ||
          !actorWallet ||
          !tokenMint ||
          amountUsd === null ||
          amountUsd <= 0
        ) {
          return [];
        }
        return [
          {
            eventKey: convictionText(row.event_key),
            eventAt,
            detectedAt,
            side,
            actorWallet,
            tokenMint,
            amountUsd,
            amountTokens: convictionNumber(row.amount_tokens),
            marketCapUsd: marketDataCausal ? convictionNullableNumber(row.market_cap_usd) : null,
            liquidityUsd: marketDataCausal ? convictionNullableNumber(row.liquidity_usd) : null,
            tokenCreatedAtMs: historicalTokenCreatedAtMs(metadata),
            valuationSource: convictionText(metadata.valuationSource),
            valuationProceedsMint: convictionNullableText(
              metadata.proceedsMint ?? metadata.proceeds_mint,
            ),
            valuationObservedAtMs,
            marketDataObservedAtMs,
            classificationReliable: true,
          },
        ];
      },
    );

    return runConvictionHistoricalBacktest(replayRows, settings, clusterWallets, {
      requestedSince,
      observationsLoaded: rows.length,
      observationsWithUsd: observationsWithUsd.length,
      observationsProductionEquivalent: replayRows.length,
      observationsExcludedUnverified: evidenceRows.filter(
        ({ evidence }) => evidence === "unverified",
      ).length,
      observationsExcludedUnvalued: rows.length - observationsWithUsd.length,
      observationsExcludedDelayedValuation: evidenceRows.filter(
        ({ evidence }) => evidence === "delayed-valuation",
      ).length,
      observationsWithMarketCap: replayRows.filter((row) => row.marketCapUsd !== null).length,
      observationsWithLiquidity: replayRows.filter((row) => row.liquidityUsd !== null).length,
      marketCapSnapshotsExcludedForTiming: productionEquivalentRows.filter((row) => {
        if (convictionNullableNumber(row.market_cap_usd) === null) return false;
        const metadata = convictionObject(row.metadata);
        return !historicalMarketDataIsCausal({
          eventAt: convictionText(row.event_at),
          marketDataObservedAtMs: explicitHistoricalObservedAtMs(
            metadata,
            "marketDataObservedAtMs",
            "market_data_observed_at_ms",
          ),
        });
      }).length,
      liquiditySnapshotsExcludedForTiming: productionEquivalentRows.filter((row) => {
        if (convictionNullableNumber(row.liquidity_usd) === null) return false;
        const metadata = convictionObject(row.metadata);
        return !historicalMarketDataIsCausal({
          eventAt: convictionText(row.event_at),
          marketDataObservedAtMs: explicitHistoricalObservedAtMs(
            metadata,
            "marketDataObservedAtMs",
            "market_data_observed_at_ms",
          ),
        });
      }).length,
      capped: rows.length >= BACKTEST_ROW_CAP,
      cap: BACKTEST_ROW_CAP,
    });
  });
